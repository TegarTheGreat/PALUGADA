/**
 * PRD v2 F13 and NG6 -- the runtime adapter protocol.
 *
 * NG6 is the change in v2 that reaches furthest: PALUGADA orchestrates and
 * does not execute. These tests hold the line in both directions -- that the
 * engine no longer calls a model to do a task, and that a runtime is given
 * everything it needs and nothing it must not have.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  AdapterRegistry,
  type Adapter,
  type AdapterHealth,
  type ExecutionBackend,
  type RunRequest,
  type RunServices,
} from '../../src/runtime/protocol.ts';
import { Engine } from '../../src/engine/engine.ts';
import { snapshot as budget_snapshot } from '../../src/engine/budget.ts';
import {
  CONSERVATIVE_FALLBACK, DEFAULT_PRICE_TABLE, costOf, parsePriceTable, type PriceTable,
} from '../../src/engine/pricing.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { instructTask } from '../../src/engine/owner-control.ts';
import { setCompanyLanguages } from '../../src/domain/language.ts';
import { renderPrompt, toWireRequest } from '../../src/runtime/wire.ts';
import { scrubExpiredPrompts } from '../../src/retention/retention.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { createCompany, grantCapability, setRoleSchemas, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A runtime the test controls completely, so it can inspect what it was given. */
function spyAdapter(options: {
  name?: string;
  health?: AdapterHealth | (() => Promise<AdapterHealth>);
  run?: (request: RunRequest, services: RunServices) => Promise<Record<string, unknown>>;
} = {}) {
  const seen: { request?: RunRequest; services?: RunServices } = {};
  const adapter: Adapter = {
    name: options.name ?? 'spy',
    backends: ['local'] as readonly ExecutionBackend[],
    async health() {
      if (typeof options.health === 'function') return options.health();
      return options.health ?? { ok: true };
    },
    async run(request, services) {
      seen.request = request;
      seen.services = services;
      const output = options.run ? await options.run(request, services) : { done: true };
      return { output };
    },
  };
  return { adapter, seen };
}

async function useRuntime(fixture: Fixture, runtime: string): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query('UPDATE roles SET runtime = $2 WHERE id = $1', [fixture.roleId, runtime]);
  });
}

let sequence = 0;
async function newTask(fixture: Fixture) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `runtime-${sequence}` },
    createdBy: 'owner',
    reserveTokens: 20_000,
  });
}

function engineWith(adapter: Adapter, prices?: PriceTable): Engine {
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  return new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    adapters,
    workerId: 'runtime-worker',
    ...(prices ? { prices } : {}),
  });
}

test('the engine does not call a model to do a task (NG6)', async () => {
  // Asserted against the source rather than behaviourally, for the same reason
  // the replay module is: a behavioural test would pass just as happily the
  // day a model client reappears behind a condition.
  const source = await readFile('src/engine/engine.ts', 'utf8');
  assert.equal(
    /\.complete\(/.test(source),
    false,
    'the engine holds a model client only to hand it to the in-process runtime',
  );
  assert.match(source, /adapter\.run\(/, 'work goes through a runtime');
});

test('a role names its runtime, and an unknown one halts loudly (F13.1)', async () => {
  // Falling back to whatever happens to be registered would run a role on a
  // runtime nobody chose for it, which is how a role calibrated for one model
  // quietly ends up on another.
  const fixture = await createCompany('runtime-unknown');
  await useRuntime(fixture, 'hermes');
  const task = await newTask(fixture);

  const { adapter } = spyAdapter({ name: 'in-process' });
  const outcome = await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'halted');
  assert.match(outcome.reason ?? '', /names runtime hermes, which is not registered/);
  assert.match(outcome.reason ?? '', /registered: in-process/);
});

test('an unhealthy runtime receives no work, and the task goes back (F13.8)', async () => {
  // Back on the queue rather than halted: an unreachable runtime is usually a
  // moment rather than a defect, and halting would turn a restart into an
  // inbox item.
  const fixture = await createCompany('runtime-unhealthy');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);

  let ran = false;
  const { adapter } = spyAdapter({
    health: { ok: false, detail: 'container not answering' },
    run: async () => {
      ran = true;
      return {};
    },
  });

  const outcome = await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'runtime_unavailable');
  assert.match(outcome.reason ?? '', /container not answering/);
  assert.equal(ran, false);

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'pending', 'and it is claimable again');
});

test('a health check that throws has failed', async () => {
  const registry = new AdapterRegistry();
  registry.register(
    spyAdapter({
      name: 'flaky',
      health: async () => {
        throw new Error('socket closed');
      },
    }).adapter,
  );

  const health = await registry.health();
  assert.equal(health.flaky!.ok, false);
  assert.match(health.flaky!.detail ?? '', /health check threw: socket closed/);
});

test('a runtime is given tools as names and schemas, never credentials (F13.4)', async () => {
  const fixture = await createCompany('runtime-tools');
  const capability: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    execute: async () => ({ ok: true }),
  };
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET runtime = 'spy', tools = ARRAY['dns.read'] WHERE id = $1", [
      fixture.roleId,
    ]);
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const { adapter, seen } = spyAdapter();
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    adapters,
    workerId: 'runtime-worker',
  });

  const task = await newTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.deepEqual(seen.request!.allowedTools.map((tool) => tool.name), ['dns.read']);
  assert.equal(seen.request!.allowedTools[0]!.tier, 0);
  assert.ok('inputSchema' in seen.request!.allowedTools[0]!);

  const serialised = JSON.stringify(seen.request);
  assert.equal(serialised.includes('vault://'), false, 'no secret reference reaches the runtime');
  assert.equal(serialised.includes('secret_ref'), false);
});

/**
 * A tool the role holds and nothing is bound to is not handed to the run,
 * and the run is told so in words (the competitive analysis of 2026-09-28,
 * L5). The marketer was offered `crm.note` on a deployment with no CRM, and
 * learned it was unusable only by calling it; its criteria could then be
 * neither met nor judged. Told, a run can do the part it can and say what
 * is left for when the tool is connected -- which the template's criteria
 * now ask of it.
 */
test('a tool nothing is bound to is not offered, and the run is told it is not connected (L5)', async () => {
  const fixture = await createCompany('runtime-unbound');
  const registry = new CapabilityRegistry();
  registry.register({
    name: 'dns.read', adapter: 'test:dns', defaultTier: 0, execute: async () => ({ ok: true }),
  } as Capability<{ zone: string }, { ok: boolean }>);
  await registry.sync();
  await registry.recordUnbound([declarationFor('crm.note')!, declarationFor('email.send')!]);
  for (const name of ['dns.read', 'crm.note', 'email.send']) await grantCapability(fixture, name);
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'spy', tools = ARRAY['dns.read','crm.note','email.send'] WHERE id = $1", [fixture.roleId]));

  const { adapter, seen } = spyAdapter();
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const engine = new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'runtime-worker' });
  const task = await newTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.deepEqual(seen.request!.allowedTools.map((tool) => tool.name), ['dns.read'], 'only what can be called is offered');
  assert.match(seen.request!.contextPack.charter,
    /Not connected in this deployment: crm\.note, email\.send\. Nothing is bound to them yet/);
  // Kept with the run, like everything else it was told.
  const { rows: [run] } = await withTenant(fixture.companyId, (tx) => tx.query<{ briefing: { contextPack: { charter: string } } }>(
    'SELECT briefing FROM agent_runs WHERE task_id = $1', [task.id]));
  assert.match(JSON.stringify(run!.briefing), /Not connected in this deployment: crm\.note, email\.send/);

  // A role whose tools are all bound is told nothing of the kind.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET tools = ARRAY['dns.read'] WHERE id = $1", [fixture.roleId]));
  const second = await newTask(fixture);
  await engine.runTask(fixture.companyId, second.id, 'worker');
  assert.ok(!seen.request!.contextPack.charter.includes('Not connected'));
});

test('a runtime is lent what it needs and no more', async () => {
  // A runtime that needed more would be asking for something the platform
  // is not supposed to hand over -- a database connection most of all.
  // `narrate` (0055) is the one added since, and it is the narrowest thing
  // here: it appends a bounded, redacted line to this run's own transcript,
  // and cannot read anything back. `processes` (0095) is the adapter's rather
  // than the runtime's: the adapter writes down the process group it spawns,
  // so a worker killed outright leaves a record, and it reaches neither a
  // process on the other side of a pipe nor an in-process handler, whose
  // context is built without it. `tokensLeft` (STATUS 2.70) answers one
  // number -- what this run may still be charged -- so a model call the
  // budget cannot pay for is not made; it reads nothing else.
  const fixture = await createCompany('runtime-services');
  await useRuntime(fixture, 'spy');
  const { adapter, seen } = spyAdapter();
  const task = await newTask(fixture);
  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.deepEqual(
    Object.keys(seen.services!).sort(),
    process.platform === 'linux'
      ? ['awaitChild', 'callTool', 'narrate', 'processes', 'reportUsage', 'signal', 'step', 'tokensLeft']
      : ['awaitChild', 'callTool', 'narrate', 'reportUsage', 'signal', 'step', 'tokensLeft'],
  );
});

test('the context pack carries the goal chain and the work already done (F2.7, F4.7)', async () => {
  // F4.7 is session continuity: a resumed run sees what it already did, which
  // is what makes an out-of-process runtime bearable without deterministic
  // replay.
  const fixture = await createCompany('runtime-context');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO task_steps (company_id, task_id, step_index, name, kind, status,
                               idempotency_key, input_hash, output, committed_at)
       VALUES ($1, $2, 0, 'earlier', 'llm', 'committed', 'k0', 'h0',
               '{"said":"something"}'::jsonb, now())`,
      [fixture.companyId, task.id],
    );
  });

  const { adapter, seen } = spyAdapter();
  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.deepEqual(
    seen.request!.contextPack.goalAncestry.map((goal) => goal.kind),
    ['mission', 'objective'],
  );
  assert.deepEqual(seen.request!.contextPack.workingMemory, [
    { name: 'earlier', output: { said: 'something' } },
  ]);
  assert.equal(seen.request!.modelRouting.primary, 'test-model');
  assert.equal(seen.request!.backend, 'local');
});

test('a runtime that does not replay is shown what each call was asked beside what it answered', async () => {
  // A resumed agent CLI starts again from the pack. "The invoice is paid" with
  // no word of which invoice it had asked about is half a record.
  const fixture = await createCompany('runtime-step-inputs');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO task_steps (company_id, task_id, step_index, name, kind, status,
                               idempotency_key, input_hash, input, output, committed_at)
       VALUES ($1, $2, 0, 'capability:ledger.read', 'tool', 'committed', 'k0', 'h0', $3::jsonb, '{"paid":true}'::jsonb, now()),
              ($1, $2, 1, 'capability:ledger.read', 'tool', 'committed', 'k1', 'h1', $4::jsonb, '{"paid":false}'::jsonb, now())`,
      [fixture.companyId, task.id,
        JSON.stringify({ name: 'ledger.read', input: { invoice: 41 } }),
        JSON.stringify({ name: 'ledger.read', input: { invoice: 42, note: 'n'.repeat(5_000) } })],
    );
  });

  const { adapter, seen } = spyAdapter();
  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');
  const [first, second] = seen.request!.contextPack.workingMemory;
  assert.deepEqual(first, { name: 'capability:ledger.read', input: { invoice: 41 }, output: { paid: true } });
  assert.equal(typeof second!.input, 'string', 'a long input is cut');
  assert.ok((second!.input as string).length < 700);
  assert.deepEqual(second!.output, { paid: false });
  // And it is what the runtime is told in its task.
  assert.match(renderPrompt(toWireRequest(seen.request!)), /"invoice": 41/);
});

test('a runtime is told where its task stands, as a note, and a follow-up whose work came to read outside content carries it', async () => {
  const fixture = await createCompany('runtime-standing');
  await useRuntime(fixture, 'spy');
  const parent = await newTask(fixture);
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO task_steps (company_id, task_id, step_index, name, kind, status,
                               idempotency_key, input_hash, output, committed_at)
       VALUES ($1, $2, 0, 'capability:doc.draft', 'tool', 'committed', 'k0', 'h0', '{"path":"drafts/a.md","text":"x"}'::jsonb, now())`,
      [fixture.companyId, parent.id]);
  });

  // A runtime that does not replay is handed where the work stands among its notes.
  const first = spyAdapter();
  await engineWith(first.adapter).runTask(fixture.companyId, parent.id, 'worker');
  const standing = first.seen.request!.contextPack.notes.find((note) => note.title === 'Where this task stands');
  assert.ok(standing, 'a note, with the rest the run is told before it starts');
  assert.match(standing!.body, /drafts\/a\.md/);

  // A follow-up of that work, made before a sibling read a customer's mail.
  const { createSubTask } = await import('../../src/engine/tasks.ts');
  const followUp = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal: 'check it again', followUpOf: parent.id }, reserveTokens: 500,
  });
  const sibling = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal: 'read the mail' }, reserveTokens: 500,
  });
  const { appendEvent } = await import('../../src/audit/event-log.ts');
  await withTenant(fixture.companyId, (tx) => appendEvent(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, taskId: sibling.id, type: 'content.read_outside', actor: 'engine',
    payload: { capability: 'mailbox.read' },
  }));

  const readOutside = () => withTenant(fixture.companyId, (tx) => tx.query<{ payload: { from?: string; parentTaskId?: string } }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'content.read_outside'", [followUp.id])).then((result) => result.rows);
  assert.deepEqual(await readOutside(), []);
  const second = spyAdapter();
  await engineWith(second.adapter).runTask(fixture.companyId, followUp.id, 'worker');
  assert.deepEqual((await readOutside()).map((row) => [row.payload.from, row.payload.parentTaskId]), [['follow_up', parent.id]],
    'what the follow-up does at tier 2 now asks the owner, as the work it read from does');
  assert.ok(second.seen.request!.contextPack.notes.some((note) => note.title === 'The work this follows up'));
});

test('what the pack was built with reaches the runtime: the language, the owner\'s word, a bounded working memory (F4.7, F4.8)', async () => {
  // The pack is built with the company's language, its stage, how the goal
  // is measured and every word the owner has said to the task. A runtime is
  // handed a request, not the pack, so whatever the request leaves out was
  // built for nobody: an owner who told a task "lead with the price" and saw
  // it ignored had been heard by the builder and by no agent.
  const fixture = await createCompany('runtime-notes');
  await useRuntime(fixture, 'spy');
  await setRoleSchemas(fixture, fixture.roleId, { output: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } });
  await setCompanyLanguages(fixture.companyId, { work: 'id', talk: 'id' });
  const task = await newTask(fixture);
  await instructTask(fixture.companyId, task.id, 'Lead with the price change, not the new hire.');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO task_steps (company_id, task_id, step_index, name, kind, status,
                               idempotency_key, input_hash, output, committed_at)
       VALUES ($1, $2, 0, 'fetched', 'tool', 'committed', 'k0', 'h0', $3::jsonb, now()),
              ($1, $2, 1, 'noted', 'llm', 'committed', 'k1', 'h1', '{"said":"something"}'::jsonb, now())`,
      [fixture.companyId, task.id, JSON.stringify({ page: 'x'.repeat(60_000) })],
    );
  });

  const { adapter, seen } = spyAdapter();
  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');
  const pack = seen.request!.contextPack;

  // The role itself: who it is, what done means, and the shape its answer
  // is held to. All three were stored, shown to the owner, and handed to no
  // run -- every role was a name, and its output schema a check the run was
  // never told it had to pass.
  assert.match(pack.charter, /Your role: worker, CEO[\s\S]*You are a worker\.[\s\S]*Done means[\s\S]*the run returns an output matching its schema/);
  assert.ok(pack.charter.indexOf('You are a worker.') > pack.charter.indexOf('Platform charter') || !pack.charter.includes('Platform charter'),
    'after the charters that outrank it');
  assert.ok(pack.notes.some((note) => note.title === 'What you return' && /"summary"/.test(note.body)), 'the output contract');
  assert.ok(pack.notes.some((note) => note.title === 'Language' && /Indonesian/.test(note.body)), 'the language rule');
  assert.ok(pack.notes.some((note) => /Lead with the price change, not the new hire\./.test(note.body)), 'the owner\'s word');

  // Every run of a task carries what it already did, so one large page would
  // ride along in full in every later run of it, and the cost of a task would
  // grow with the square of its steps.
  assert.deepEqual(pack.workingMemory.map((step) => step.name), ['fetched', 'noted']);
  assert.deepEqual(pack.workingMemory[1]!.output, { said: 'something' }, 'a small result is passed as it is');
  const large = JSON.stringify(pack.workingMemory[0]!.output);
  assert.ok(large.length < 5_000, `a 60 kB result arrived as ${large.length} characters`);
  assert.match(large, /cut short/);

  // The agent CLIs are given it in the prompt, after the charter and before
  // the task: an instruction below the work it governs is read too late.
  const prompt = renderPrompt(toWireRequest(seen.request!));
  const at = (pattern: RegExp) => prompt.search(pattern);
  assert.ok(at(/Lead with the price change/) > 0);
  assert.ok(at(/Write everything in Indonesian/) > 0);
  assert.ok(at(/Lead with the price change/) < at(/# Your task/), prompt.slice(0, 2_000));
});

test('a model call the runtime makes is traced and charged (F11.1)', async () => {
  const fixture = await createCompany('runtime-usage');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);

  const { adapter } = spyAdapter({
    run: async (_request, services) => {
      await services.reportUsage({
        model: 'some-provider/large',
        inputTokens: 120,
        outputTokens: 40,
        costCents: 7,
        prompt: { system: 'be brief' },
        response: { content: 'ok' },
      });
      return { done: true };
    },
  });

  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  const trace = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      model: string;
      input_tokens: number;
      cost_cents: number;
      prompt: unknown;
    }>('SELECT model, input_tokens, cost_cents, prompt FROM llm_traces');
    return rows[0]!;
  });
  assert.equal(trace.model, 'some-provider/large');
  assert.equal(trace.input_tokens, 120);
  assert.equal(trace.cost_cents, 7);
  assert.deepEqual(trace.prompt, { system: 'be brief' });
});

async function moneySpent(fixture: Fixture): Promise<number> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ spent: string }>(
      'SELECT money_spent_cents::text AS spent FROM budget_accounts WHERE id = $1',
      [fixture.budgetAccountId],
    );
    return Number(rows[0]!.spent);
  });
}

async function estimates(fixture: Fixture) {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { cents: number; basis: string } }>(
      "SELECT payload FROM events WHERE type = 'cost.estimated' ORDER BY occurred_at",
    );
    return rows.map((row) => ({ cents: row.payload.cents, basis: row.payload.basis }));
  });
}

function unpricedRuntime(usage: { model: string; inputTokens: number; outputTokens: number }) {
  return spyAdapter({
    run: async (_request, services) => {
      await services.reportUsage({ ...usage, costCents: null });
      return { done: true };
    },
  }).adapter;
}

/**
 * The mark was there and the estimate was not: `costCents ?? 0`. Every agent
 * CLI reports tokens and no price, so in production the company's money
 * ceiling never moved -- F1.7's pause at 100% was enforced against a counter
 * that stayed at zero. This test used to count the mark and nothing else,
 * which is how an estimate of nothing passed it.
 */
test('a runtime that cannot say what a call cost is charged an estimate, not nothing (F13.7, F1.7)', async () => {
  const fixture = await createCompany('runtime-cost-estimated');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);

  // 400k in and 100k out at the fallback's $15/$75: 600 + 750 cents.
  await engineWith(
    unpricedRuntime({ model: 'unknown/model', inputTokens: 400_000, outputTokens: 100_000 }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(await moneySpent(fixture), 1_350, 'the money ceiling moved');
  assert.deepEqual(await estimates(fixture), [{ cents: 1_350, basis: 'fallback' }]);
});

/**
 * The operator's own list wins over the fallback, the most specific pattern
 * wins over a broader one, and a call too small to be a cent is owed rather
 * than rounded up to one: it is charged with the calls after it, when what is
 * owed comes to a cent (cost-accuracy.test.ts holds the thousand-calls case).
 */
test('an estimate comes from the operator\'s price list when it names the model (F13.7)', async () => {
  const fixture = await createCompany('runtime-cost-priced');
  await useRuntime(fixture, 'spy');
  const prices = parsePriceTable({
    models: {
      'some-provider/*': { input: 1_000, output: 1_000 },
      'some-provider/large-*': { input: 300, output: 1_500 },
    },
  });

  const big = await newTask(fixture);
  await engineWith(
    unpricedRuntime({ model: 'some-provider/large-2', inputTokens: 200_000, outputTokens: 100_000 }),
    prices,
  ).runTask(fixture.companyId, big.id, 'worker');
  const small = await newTask(fixture);
  await engineWith(
    unpricedRuntime({ model: 'some-provider/tiny', inputTokens: 10, outputTokens: 1 }),
    prices,
  ).runTask(fixture.companyId, small.id, 'worker');

  assert.deepEqual(await estimates(fixture), [
    { cents: 210, basis: 'some-provider/large-*' },
    { cents: 0, basis: 'some-provider/*' },
  ]);
  assert.equal(await moneySpent(fixture), 210);
});

/**
 * A price file is configuration an operator writes by hand, and the failure
 * that matters is the quiet one: a fallback that failed to parse and was
 * skipped, or one set to zero, puts every unknown model back on nothing.
 */
test('a price file that would price the unknown at nothing is refused whole', () => {
  const refused = (raw: unknown) =>
    assert.throws(() => parsePriceTable(raw), (error: unknown) => isPalugadaError(error, 'config.invalid'));
  refused({ fallback: { input: 0, output: 0 } });
  refused({ fallback: { input: -1, output: 10 } });
  refused({ fallback: { input: '15', output: 75 } });
  refused({ models: { 'a*b': { input: 1, output: 1 } } });
  refused({ models: { 'x-*': { input: 1 } } });
  refused({ modles: {} });
  refused([]);
  // And the fallback is the conservative one when the file does not name it.
  assert.deepEqual(parsePriceTable({}).fallback, CONSERVATIVE_FALLBACK);
  assert.equal(costOf(DEFAULT_PRICE_TABLE, 'x', { input: 0, output: 0 }).cents, 0, 'no tokens, no charge');
});

test('a prompt the runtime never shared stays distinguishable from a scrubbed one', async () => {
  // "The runtime never told us" and "it was here and retention removed it" are
  // different answers to why a prompt is missing, and an auditor needs them
  // told apart.
  const fixture = await createCompany('runtime-no-prompt');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);

  const { adapter } = spyAdapter({
    run: async (_request, services) => {
      await services.reportUsage({
        model: 'private/model',
        inputTokens: 10,
        outputTokens: 5,
        costCents: 1,
      });
      return { done: true };
    },
  });
  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  await withControlPlane(async (tx) => {
    await tx.query(
      "UPDATE llm_traces SET occurred_at = now() - interval '200 days' WHERE company_id = $1",
      [fixture.companyId],
    );
  });
  await scrubExpiredPrompts(fixture.companyId);

  const prompt = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ prompt: unknown }>('SELECT prompt FROM llm_traces');
    return rows[0]!.prompt;
  });
  assert.equal(prompt, null, 'retention did not claim to have removed something never there');
});

test('a tool call from a runtime goes through the broker (F13.4, F8.1)', async () => {
  // The runtime asks; the broker decides. A refused call produces no
  // downstream call at all, which is what makes "the runtime is compromised" a
  // survivable sentence.
  const fixture = await createCompany('runtime-broker');
  const calls = { executions: 0 };
  const capability: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async execute() {
      calls.executions += 1;
      return { ok: true };
    },
  };
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await useRuntime(fixture, 'spy');
  // Deliberately no grant.

  const { adapter } = spyAdapter({
    run: async (_request, services) => {
      await services.callTool('dns.read', { zone: 'example.test' });
      return { done: true };
    },
  });
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    adapters,
    workerId: 'runtime-worker',
  });

  const task = await newTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.notEqual(outcome.status, 'completed');
  assert.equal(calls.executions, 0, 'the adapter was never touched');
});

test('the in-process runtime is an adapter like any other', async () => {
  // It is the platform's own development runtime, not a bypass: the engine
  // talks to it through the same protocol and knows nothing about what it does
  // inside a run.
  const fixture = await createCompany('runtime-in-process');
  const ran: string[] = [];
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    workerId: 'runtime-worker',
    handlers: new Map([['worker', async (ctx) => {
      ran.push(await ctx.llm({ system: 'hi', messages: [{ role: 'user', content: 'go' }] }));
      return { done: true };
    }]]),
  });

  assert.deepEqual(engine.adapters.names(), ['in-process']);
  assert.equal((await engine.adapters.get('in-process')!.health()).ok, true);

  const task = await newTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed');
  assert.equal(ran.length, 1);

  // And its model call was traced through the same path a third-party runtime
  // would use.
  const traces = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ model: string }>('SELECT model FROM llm_traces');
    return rows.map((row) => row.model);
  });
  assert.deepEqual(traces, ['test-model']);
});

/**
 * And the engine's half: it is the accounting authority whatever reported
 * the usage, including the in-process runtime that never crosses the wire.
 */
test('the engine refuses a negative usage report from any runtime (F13.7)', async () => {
  const fixture = await createCompany('runtime-negative-usage');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);
  // Spend already on the account, so a negative report has something to erase
  // rather than tripping the non-negative constraint on an empty one.
  await withControlPlane((tx) => tx.query(
    'UPDATE budget_accounts SET tokens_spent = 5000 WHERE id = $1', [fixture.budgetAccountId],
  ));
  const { adapter } = spyAdapter({
    run: async (_request, services) => {
      await services.reportUsage({ model: 'm', inputTokens: -1_000, outputTokens: 0, costCents: 0 });
      return { done: true };
    },
  });
  const outcome = await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');
  assert.notEqual(outcome.status, 'completed');
  const spentTokens = await withTenant(fixture.companyId, async (tx) =>
    (await budget_snapshot(tx, fixture.budgetAccountId)).tokensSpent);
  assert.equal(spentTokens, 5000, 'the spend was not erased');
});
