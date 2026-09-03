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
import { withTenant } from '../../src/db/tenant.ts';
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
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { scrubExpiredPrompts } from '../../src/retention/retention.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
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

function engineWith(adapter: Adapter): Engine {
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  return new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    adapters,
    workerId: 'runtime-worker',
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

test('a runtime is lent four things and no more', async () => {
  // A runtime that needed a fifth would be asking for something the platform
  // is not supposed to hand over -- a database connection most of all.
  const fixture = await createCompany('runtime-services');
  await useRuntime(fixture, 'spy');
  const { adapter, seen } = spyAdapter();
  const task = await newTask(fixture);
  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.deepEqual(
    Object.keys(seen.services!).sort(),
    ['awaitChild', 'callTool', 'reportUsage', 'signal', 'step'],
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

test('a runtime that cannot say what a call cost gets an estimate, marked (F13.7)', async () => {
  // Reporting a guess as a measurement is how a cost dashboard stops being
  // worth reading.
  const fixture = await createCompany('runtime-cost-estimated');
  await useRuntime(fixture, 'spy');
  const task = await newTask(fixture);

  const { adapter } = spyAdapter({
    run: async (_request, services) => {
      await services.reportUsage({
        model: 'unknown/model',
        inputTokens: 50,
        outputTokens: 10,
        costCents: null,
      });
      return { done: true };
    },
  });

  await engineWith(adapter).runTask(fixture.companyId, task.id, 'worker');

  const marked = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'cost.estimated'",
    );
    return Number(rows[0]!.count);
  });
  assert.equal(marked, 1);
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

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE llm_traces SET occurred_at = now() - interval '200 days'");
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
