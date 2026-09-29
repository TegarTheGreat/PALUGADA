/**
 * How work ends when it does not end well (src/engine, src/worker.ts).
 *
 * Read against what an owner would expect of work that runs by itself: a task
 * past its deadline is stopped and says so; a parent waiting on it hears the
 * answer instead of asking again every second; a failed attempt is retried
 * knowing why it failed; a delegation refused for being too wide says so,
 * not that it went in a circle; and a run cannot spend without limit.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { Engine, RETRY_WAITS_MS } from '../../src/engine/engine.ts';
import { claimTask } from '../../src/engine/checkout.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { Worker } from '../../src/worker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { buildContext } from '../../src/context/builder.ts';
import { remember } from '../../src/memory/store.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { workOf } from '../../src/owner/views.ts';
import { narrator, transcriptOf } from '../../src/engine/transcript.ts';
import { createRootTask, createSubTask, getTask, transition } from '../../src/engine/tasks.ts';
import { addRole, createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { reportOn } from '../helpers/done.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let made = 0;
function rootTask(fixture: Fixture, extra: { deadlineAt?: Date } = {}) {
  made += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `work ${made}` }, createdBy: 'owner',
    reserveTokens: 1_000, ...extra,
  });
}

async function pastDeadline(fixture: Fixture, taskId: string) {
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE tasks SET deadline_at = now() - interval '1 minute' WHERE id = $1", [taskId]));
}

function platformRegistry() {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  return registry;
}

test('a task past its deadline that no worker may claim any more is stopped, and says why', async () => {
  const fixture = await createCompany('deadline-sweep');
  const waiting = await rootTask(fixture);
  await pastDeadline(fixture, waiting.id);
  const alive = await rootTask(fixture, { deadlineAt: new Date(Date.now() + 3_600_000) });

  const registry = platformRegistry();
  await registry.sync();
  const worker = new Worker({
    engine: new Engine({ broker: new CapabilityBroker(registry), llm: new RecordingLlmClient(), handlers: new Map() }),
    companyId: fixture.companyId,
    maxRunsPerTick: 0,
  });
  const report = await worker.tick();
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.equal(report.pastDeadline, 1);
  const stopped = await withTenant(fixture.companyId, (tx) => getTask(tx, waiting.id));
  assert.deepEqual([stopped!.status, stopped!.haltReason], ['halted', 'deadline_passed'],
    'the claim skips it, so nothing else would ever settle it');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, alive.id)))!.status, 'pending');
});

test('a parent that awaits a child past its deadline hears that it stopped, instead of asking again at once', async () => {
  const fixture = await createCompany('await-deadline');
  const registry = platformRegistry();
  await registry.sync();
  await grantCapability(fixture, 'task.await');
  const parent = await rootTask(fixture);
  await transition(fixture.companyId, parent.id, 'running');
  const child = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal: 'a part of the work' }, reserveTokens: 500,
  });
  await pastDeadline(fixture, child.id);

  const answer = await new CapabilityBroker(registry).invoke<unknown, { status: string; summary: string }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: parent.id, idempotencyKey: 'await-late-child',
  }, 'task.await', { childId: child.id });
  assert.equal(answer.output.status, 'halted', 'an answer, not a wait whose reopening is already in the past');
  assert.match(answer.output.summary, /deadline_passed/);
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, child.id)))!.status, 'halted');
});

test('a retry is told why the attempt before it failed, so it does not make the same mistake blind', async () => {
  const fixture = await createCompany('retry-learns');
  const registry = platformRegistry();
  await registry.sync();
  let attempts = 0;
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async () => {
      attempts += 1;
      throw new Error('the supplier sheet has no column called price_per_kg; it is called harga');
    }]]),
  });
  const task = await rootTask(fixture);
  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.notEqual(first.status, 'completed');
  assert.equal(attempts, 1);

  const pack = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
  const told = pack.sections.find((section) => section.title.startsWith('Earlier attempts at this task failed'));
  assert.ok(told, 'the next run is told');
  assert.match(told!.body, /This is attempt 2/);
  assert.match(told!.body, /no column called price_per_kg; it is called harga/);
  assert.match(told!.body, /<<<UNTRUSTED_CONTENT>>>/, 'an error can carry a vendor\'s words, so it is data');
});

test('work that splits itself too many ways halts saying so, not that it went in a circle', async () => {
  const fixture = await createCompany('fan-out-label');
  await addRole(fixture, 'helper');
  const registry = platformRegistry();
  await registry.sync();
  await grantCapability(fixture, 'task.delegate');
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      for (let part = 1; part <= 6; part += 1) {
        await ctx.callCapability('task.delegate', { role: 'helper', brief: `part ${part} of the price survey` });
      }
      return { summary: 'split' };
    }]]),
  });
  const task = await rootTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['halted', 'fan_out_limit']);
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.haltReason, 'fan_out_limit');
});

test('what a child cost reaches its parent, and what a vendor charged is in the owner\'s cost so far', async () => {
  const fixture = await createCompany('child-cost');
  const registry = platformRegistry();
  await registry.sync();
  await grantCapability(fixture, 'task.await');
  const parent = await rootTask(fixture);
  await transition(fixture.companyId, parent.id, 'running');
  const child = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal: 'draw the October poster' }, reserveTokens: 500,
  });
  await transition(fixture.companyId, child.id, 'running');
  await withTenant(fixture.companyId, (tx) => appendEvent(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, taskId: child.id, type: 'tool.cost', actor: 'broker',
    payload: { capability: 'image.generate', estimatedCents: 5, actualCents: 7 },
  }));
  await transition(fixture.companyId, child.id, 'completed', { output: { summary: 'drawn' } });

  const answer = await new CapabilityBroker(registry).invoke<unknown, { summary: string }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: parent.id, idempotencyKey: 'await-poster',
  }, 'task.await', { childId: child.id });
  assert.match(answer.output.summary, /completed in 0 steps, 7c\./, 'not a free child');

  const work = await workOf(fixture.companyId);
  const shown = work.items.find((one) => one.id === child.id);
  assert.equal(shown!.costCents, 7, 'the vendor\'s charge is part of what the task cost');
});

test('a run cannot write more tokens than its role allows one run', async () => {
  const fixture = await createCompany('run-ceiling');
  await withTenant(fixture.companyId, (tx) => tx.query('UPDATE roles SET max_tokens_per_run = 120 WHERE id = $1', [fixture.roleId]));
  const registry = platformRegistry();
  await registry.sync();
  const llm = new RecordingLlmClient(() => 'thinking');
  let asked = 0;
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm,
    handlers: new Map([['worker', async (ctx) => {
      // A loop that would otherwise go on until the budget ran out.
      for (let turn = 0; turn < 10; turn += 1) {
        asked += 1;
        try {
          await ctx.llm({ system: 'You think.', messages: [{ role: 'user', content: `turn ${turn}` }] });
        } catch {
          // What a careless run does with a refusal: carries on.
        }
      }
      return { summary: 'thought a lot' };
    }]]),
  });
  const task = await rootTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['halted', 'run_limit']);
  assert.equal(llm.calls.length, 3, 'stopped at the call that went over, at 50 tokens written a call');
  assert.ok(asked >= 3);
});

test('what a run says after it resumes is kept, after what it said before it waited', async () => {
  const fixture = await createCompany('narration-resume');
  const task = await rootTask(fixture);
  const run = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    'INSERT INTO agent_runs (company_id, task_id, role_id, attempt) VALUES ($1, $2, $3, 0) RETURNING id',
    [fixture.companyId, task.id, fixture.roleId])).rows[0]!.id);
  await narrator(fixture.companyId, task.id, run)('Asked the owner whether to include the Garut beans.');
  // Approved an hour later: the same attempt resumes, as the same agent run.
  await narrator(fixture.companyId, task.id, run)('The owner said yes; adding Garut to the price list.');
  const said = await transcriptOf(fixture.companyId, task.id);
  assert.deepEqual(said.map((note) => [note.seq, note.body]), [
    [1, 'Asked the owner whether to include the Garut beans.'],
    [2, 'The owner said yes; adding Garut to the price list.'],
  ]);
});

test('what a run is told about its project and its earlier failures reaches the runtime itself', async () => {
  const fixture = await createCompany('notes-reach-runtime');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE projects SET name = 'Wholesale', description = 'Sell beans by the kilo to cafes.' WHERE id = $1", [fixture.projectId]);
    await tx.query("UPDATE roles SET runtime = 'notes-seen', backend = 'local' WHERE id = $1", [fixture.roleId]);
  });
  await withTenant(fixture.companyId, (tx) => remember(tx, {
    companyId: fixture.companyId, memoryType: 'procedural', scopeType: 'division', scopeId: fixture.divisionId,
    body: 'Quote wholesale prices per kilo, never per bag.', source: 'owner',
  }));
  const seen: Array<Array<{ title: string; body: string }>> = [];
  const procedures: string[][] = [];
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'notes-seen',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run(request) {
      seen.push(request.contextPack.notes);
      procedures.push(request.contextPack.skills);
      if (seen.length === 1) throw new Error('the price sheet had no column called harga');
      return { output: { summary: 'priced' } };
    },
  });
  const registry = platformRegistry();
  await registry.sync();
  const engine = new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'notes-worker' });
  const task = await rootTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.some((note) => /project "Wholesale".*Sell beans by the kilo/.test(note.body)), 'the project, in the runtime\'s own notes');
  const again = seen[1]!.find((note) => note.title.startsWith('Earlier attempts at this task failed'));
  assert.ok(again, 'the retry, as the runtime receives it, is told why the first attempt failed');
  assert.match(again!.body, /no column called harga/);
  assert.ok(procedures[0]!.some((line) => /^How the owner wants it done\nQuote wholesale prices per kilo/.test(line)),
    'and the owner\'s way of working arrives as the owner\'s');
});

/**
 * A failed attempt went straight back on the queue, and the next tick took it
 * again. In a chaos run on 2026-09-29 a CRM answering 503 to every call spent
 * all three attempts of two tasks in six seconds, so a vendor's moment failed
 * the work for good. The next attempt now waits -- ten seconds, then four
 * times as long -- so a moment passes before the attempts do. A direct run
 * is not held back by it; the queue is.
 */
test('a failed attempt waits before the next is claimed, longer each time', async () => {
  const fixture = await createCompany('retry-waits');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET runtime = 'flaky', backend = 'local' WHERE id = $1", [fixture.roleId]));
  let runs = 0;
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'flaky',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run() {
      runs += 1;
      if (runs <= 2) throw new Error('the CRM answered 503');
      return { output: { summary: 'noted', done: reportOn(['the run returns an output matching its schema']) } };
    },
  });
  const registry = platformRegistry();
  await registry.sync();
  const engine = new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'retry-worker' });
  const task = await rootTask(fixture);
  const waitOf = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; wait_until: Date | null }>(
    'SELECT status, wait_until FROM tasks WHERE id = $1', [task.id]))).rows[0]!;

  const started = Date.now();
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).reason, 'retryable');
  const first = await waitOf();
  assert.equal(first.status, 'waiting_window', 'parked, with the time it wakes at');
  const firstWait = first.wait_until!.getTime() - started;
  assert.ok(firstWait >= RETRY_WAITS_MS[0]! - 1_000 && firstWait <= RETRY_WAITS_MS[0]! + 2_000, `waited ${firstWait}ms`);
  assert.equal(await claimTask(fixture.companyId, { holder: 'retry-worker' }), null, 'not claimed before its time');
  const claim = await claimTask(fixture.companyId, { holder: 'retry-worker', now: new Date(started + RETRY_WAITS_MS[0]! + 2_000) });
  assert.equal(claim?.taskId, task.id);

  const again = Date.now();
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).reason, 'retryable');
  const second = (await waitOf()).wait_until!.getTime() - again;
  assert.ok(second >= RETRY_WAITS_MS[1]! - 1_000, `waited ${second}ms the second time`);
  assert.ok(RETRY_WAITS_MS[1]! > RETRY_WAITS_MS[0]!, 'longer each time');
  assert.equal(await claimTask(fixture.companyId, { holder: 'retry-worker' }), null);

  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.equal(runs, 3);
});
