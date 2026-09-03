/**
 * PRD v2 section 6.2 — the loop, and the seed a fresh installation needs.
 *
 * Everything else in the suite tests a part. This tests that the parts are
 * assembled into something that runs: a tick that reclaims, schedules, wakes,
 * claims, runs, settles and watches, in that order, and stops when the owner
 * says stop.
 *
 * The gap this closes is the one that is easiest to miss because every other
 * test passes without it. For a while every module here was exercised and
 * nothing composed them, which is the difference between a library with a good
 * test suite and a platform.
 */
import { test, before, beforeEach, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Worker, DEFAULT_IDLE_MS } from '../../src/worker.ts';
import { baseRegistry, seed } from '../../src/seed.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { enqueueWake } from '../../src/scheduler/wake.ts';
import { requestStopAll, clearStopAll, freezeCompany } from '../../src/engine/control.ts';
import { installBundle } from '../../src/bundles/bundle.ts';
import { readTemplate } from '../../src/templates/company.ts';
import type { HandoffRule } from '../../src/engine/handoff.ts';
import { isRoleFrozen } from '../../src/governance/role-freeze.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, addRole, setRoleSchemas, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await clearStopAll();
  await closePools();
  await closeSetup();
});

function workerFor(
  fixture: Fixture,
  handler: TaskHandler,
  options: {
    all?: boolean;
    id?: string;
    handlers?: Record<string, TaskHandler>;
    handoffRules?: HandoffRule[];
  } = {},
) {
  const engine = new Engine({
    broker: new CapabilityBroker(baseRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', handler], ...Object.entries(options.handlers ?? {})]),
    // Distinct per worker when a test runs more than one: a lease belongs to
    // its holder, and two workers sharing an id could renew each other's.
    workerId: options.id ?? 'tick-worker',
  });
  return new Worker({
    engine,
    ...(options.all ? {} : { companyId: fixture.companyId }),
    maxRunsPerTick: 4,
    ...(options.handoffRules ? { handoffRules: options.handoffRules } : {}),
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
    input: { run: sequence },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
}

/* ------------------------------------------------------------------ tick --- */

test('a tick claims pending work and runs it (section 6.2)', async () => {
  const fixture = await createCompany('worker-tick');
  const worker = workerFor(fixture, async () => ({ done: true }));

  const task = await newTask(fixture);
  const report = await worker.tick();

  assert.deepEqual(report.errors, [], 'no stage may fail on the ordinary path');
  assert.equal(report.ran.length, 1);
  assert.equal(report.ran[0]!.taskId, task.id);
  assert.equal(report.ran[0]!.status, 'completed');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'completed');
});

/**
 * F5.8: a stop is bounded by the polling interval, not by the queue.
 *
 * The tick does nothing else at all — it does not claim, does not run, does not
 * even look at the schedules. A worker that finished its queue before noticing
 * would make "stop everything" mean "stop eventually".
 */
test('a tick under a platform stop does nothing (F5.8)', async () => {
  const fixture = await createCompany('worker-stopped');
  let handlerRan = false;
  const worker = workerFor(fixture, async () => {
    handlerRan = true;
    return { done: true };
  });

  await newTask(fixture);
  await requestStopAll();
  try {
    const report = await worker.tick();
    assert.equal(report.stopped, true);
    assert.deepEqual(report.ran, []);
    assert.equal(handlerRan, false);
  } finally {
    await clearStopAll();
  }
});

/**
 * F1.4: a frozen company is skipped, not picked up and cancelled.
 *
 * Asserted for both shapes of worker. The pinned one is where this is easy to
 * get wrong: without the filter it would claim the task, take a lease, be
 * refused by the engine's guards, and leave the task checked out until the
 * lease expired — and a freeze that parks work for the length of a lease is
 * not a freeze.
 */
test('a frozen company is skipped rather than cancelled (F1.4)', async () => {
  for (const scope of ['all companies', 'pinned to one'] as const) {
    const fixture = await createCompany('worker-frozen');
    const worker = workerFor(fixture, async () => ({ done: true }), {
      all: scope === 'all companies',
    });

    const task = await newTask(fixture);
    await freezeCompany(fixture.companyId);

    const report = await worker.tick();
    assert.deepEqual(report.ran, [], scope);

    const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
    assert.equal(stored!.status, 'pending', `${scope}: the task waits, and keeps its lease free`);
    assert.equal(stored!.leaseHolder, null, `${scope}: nothing was claimed`);
  }
});

/**
 * A tick is bounded. Five claimable tasks and a budget of four means four run
 * and the fifth waits for the next tick — which is what keeps a stop, a
 * deadline and a lease renewal from waiting on an unbounded drain.
 */
test('a tick runs at most its budget (F5.8)', async () => {
  const fixture = await createCompany('worker-bounded');
  const worker = workerFor(fixture, async () => ({ done: true }));

  for (let index = 0; index < 5; index += 1) await newTask(fixture);

  const first = await worker.tick();
  assert.equal(first.ran.length, 4);

  const second = await worker.tick();
  assert.equal(second.ran.length, 1);
});

/** F9.8: a wake becomes a run, and a wake with nothing to do costs nothing. */
test('a tick drains the wake queue (F9.8, F9.10)', async () => {
  const fixture = await createCompany('worker-wake');
  const worker = workerFor(fixture, async () => ({ done: true }));

  await enqueueWake({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    reason: 'heartbeat',
    wakeAt: new Date(Date.now() - 1_000),
  });

  const idle = await worker.tick();
  assert.equal(idle.woken, 1);
  assert.deepEqual(idle.ran, [], 'a wake with no claimable task runs nothing');

  await newTask(fixture);
  await enqueueWake({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    reason: 'heartbeat',
    wakeAt: new Date(Date.now() - 1_000),
  });
  const busy = await worker.tick();
  assert.equal(busy.ran.length, 1);
});

/**
 * A stage that throws does not take the tick with it.
 *
 * A worker that died because one company's configuration was bad would take
 * every other company down with it, and the failure that stops a fleet should
 * be the platform's, never a tenant's.
 */
test('a failing stage is recorded and the tick continues', async () => {
  const fixture = await createCompany('worker-resilient');
  const worker = workerFor(fixture, async () => ({ done: true }));

  // A role whose runtime does not exist makes the run fail, not the tick.
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET runtime = 'nonexistent' WHERE id = $1", [fixture.roleId]);
  });
  await newTask(fixture);

  const report = await worker.tick();
  assert.deepEqual(report.errors, []);
  assert.equal(report.ran.length, 1);
  assert.equal(report.ran[0]!.status, 'halted');
});

/* ------------------------------------------------------------------ seed --- */

/**
 * F16.5 and F3.11: what a fresh installation needs, reachable from `src/`.
 *
 * Both were exported and tested and called by nothing, which meant a real
 * installation had no built-in bundles and never read its charters off disk.
 */
test('seeding publishes the built-in bundles and the standard template (F16.5)', async () => {
  const report = await seed();

  assert.deepEqual(
    report.bundles.map((bundle) => bundle.slug).sort(),
    ['content-ops', 'qa-review', 'web-ops'],
  );
  for (const bundle of report.bundles) {
    assert.equal(bundle.signed, false, 'unsigned unless an installation signs them');
    assert.match(bundle.hash, /^[0-9a-f]{64}$/);
  }

  assert.ok(await readTemplate(report.template), 'the standard template is saved');

  // And they are installable, which is the point of publishing them.
  const fixture = await createCompany('seeded');
  const installed = await installBundle({
    companyId: fixture.companyId,
    slug: 'qa-review',
    version: '1.0.0',
  });
  assert.equal(installed.quarantined, true, 'unsigned means quarantine (F12.10)');
  assert.deepEqual(installed.roles, ['qa-reviewer']);
});

test('seeding twice changes nothing (F16.2, F3.11)', async () => {
  const first = await seed();
  const second = await seed();

  // Identical hashes, because the bundle is the same document. A seed that
  // manufactured a new version per deploy would make "which version is
  // installed" a question about deploy timing.
  assert.deepEqual(
    first.bundles.map((bundle) => bundle.hash),
    second.bundles.map((bundle) => bundle.hash),
  );

  const rows = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bundles',
    );
    return Number(rows[0]!.count);
  });
  assert.equal(rows, 3, 'three bundles, not six');
});

/** The registry a deployment starts from binds what the platform implements. */
test('the base registry binds the platform capabilities and nothing else (F4.8)', () => {
  const registry = baseRegistry();
  assert.ok(registry.get('memory.search'), 'memory.search is what F4.8 promises every run');
  assert.ok(registry.get('skill.read'), 'skill.read is what F15.7 promises every run');
  assert.equal(
    registry.get('email.send'),
    undefined,
    'binding an external adapter is the operator\'s, not a seed\'s',
  );
});


/**
 * `start()` survives a tick that fails outright.
 *
 * A stage failure lands on the report; this is the other case — the database
 * went away mid-tick and there is no report at all. A worker that exited there
 * would be a daemon that a transient blip kills, and the exit would be
 * invisible to whoever was relying on it.
 */
test('the loop survives a failed tick and keeps going', async () => {
  const fixture = await createCompany('worker-loop');
  const engine = new Engine({
    broker: new CapabilityBroker(baseRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async () => ({ done: true })]]),
    workerId: 'loop-worker',
  });

  const errors: Error[] = [];
  const controller = new AbortController();
  const worker = new Worker({
    engine,
    companyId: fixture.companyId,
    idleMs: 20,
    signal: controller.signal,
    onTickError: (error) => errors.push(error),
  });

  // Two failures, then normal service. If the loop exited on the first, the
  // third tick would never happen and `ticks` would stop at 1.
  let ticks = 0;
  const realTick = worker.tick.bind(worker);
  worker.tick = async (now?: Date) => {
    ticks += 1;
    if (ticks <= 2) throw new Error('the database went away');
    return realTick(now);
  };

  const running = worker.start();
  // Long enough for several idle intervals, short enough not to slow the suite.
  await new Promise((resolve) => setTimeout(resolve, 250));
  controller.abort();
  await running;

  assert.ok(ticks > 2, `the loop kept going after failing twice (ticks: ${ticks})`);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!.message, /database went away/);
});

/** An aborted signal stops the loop rather than finishing one more tick. */
test('the loop stops when its signal aborts', async () => {
  const fixture = await createCompany('worker-abort');
  const engine = new Engine({
    broker: new CapabilityBroker(baseRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async () => ({ done: true })]]),
    workerId: 'abort-worker',
  });

  const controller = new AbortController();
  const worker = new Worker({
    engine,
    companyId: fixture.companyId,
    idleMs: 10_000,
    signal: controller.signal,
  });

  const started = Date.now();
  const running = worker.start();
  setTimeout(() => controller.abort(), 50);
  await running;

  // It did not wait out the ten-second idle interval, which is what makes a
  // shutdown a shutdown rather than a timeout.
  assert.ok(Date.now() - started < 5_000);
});

/**
 * Retention runs from the loop, not only when somebody calls it.
 *
 * `runRetention` was written, tested and scheduled by nothing: every retention
 * window in section 12.3 was a promise about data the platform would delete,
 * and no code path deleted it. This is the tick stage, and the second half of
 * the test is the part that matters — that it does not run on every tick, so a
 * five-second poll does not turn into three table scans a company every five
 * seconds.
 */
test('a tick applies retention, and does not do it again straight away (section 12.3)', async () => {
  const fixture = await createCompany('worker-retention');

  // An event well past the longest window the policy allows.
  const ancient = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000);
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO events (company_id, type, actor, payload, occurred_at)
       VALUES ($1, 'task.created', 'system', '{}'::jsonb, $2)`,
      [fixture.companyId, ancient],
    );
  });

  const before = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events WHERE occurred_at < $1',
      [new Date(Date.now() - 401 * 24 * 60 * 60 * 1000)],
    );
    return Number(rows[0]!.count);
  });
  assert.ok(before > 0, 'there is something outside the window to delete');

  const worker = workerFor(fixture, async () => ({ done: true }));
  const first = await worker.tick();
  assert.equal(first.retained, 1);
  assert.deepEqual(first.errors, []);

  const after = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events WHERE occurred_at < $1',
      [new Date(Date.now() - 401 * 24 * 60 * 60 * 1000)],
    );
    return Number(rows[0]!.count);
  });
  assert.equal(after, 0, 'the expired event is gone');

  // And the next tick leaves it alone: the interval is hours, not one tick.
  const second = await worker.tick();
  assert.equal(second.retained, 0, 'retention is not a per-tick cost');
});

/**
 * Two workers on one company, ticking at the same time.
 *
 * `checkout-lease-lane.test.ts` races twenty workers through `claimTask`, which
 * is the sharp end and is where the guarantee lives. What it does not exercise
 * is the whole tick: reclaim, schedules, wakes, claim, run, settle and
 * retention, all of them running twice over the same rows. That is the shape a
 * real deployment has — a fleet, not a worker — and nothing here had ever run
 * it.
 *
 * The claim is narrow: every task runs exactly once, and neither worker
 * reports a stage failure. A task running twice would mean a side effect
 * happening twice, which is the whole reason leases exist. Checked by letting
 * `claimTask` claim a `running` task, which this notices and the lease/lane
 * test does not — that one races the claim itself, where nothing is running
 * yet, so the predicate that keeps a *started* task from being claimed again
 * had no test until this one.
 */
test('two workers on the same company run each task exactly once', async () => {
  const fixture = await createCompany('worker-fleet', { tokensMax: 10_000_000 });

  const ran: string[] = [];
  const handler: TaskHandler = async (ctx) => {
    ran.push(ctx.task.id);
    // Long enough that the overlap is guaranteed rather than incidental. With
    // a handler that returned immediately, one worker's tasks were already
    // `completed` before the other's claim ran, and the test passed even with
    // `claimTask` willing to claim a `running` task — which is exactly the
    // double-run this exists to rule out. The number is the point, not
    // latency-tolerance.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { done: true };
  };

  const wanted: string[] = [];
  for (let i = 0; i < 6; i += 1) wanted.push((await newTask(fixture)).id);

  const left = workerFor(fixture, handler, { id: 'fleet-a' });
  const right = workerFor(fixture, handler, { id: 'fleet-b' });

  // Two rounds, because six tasks is more than one tick's maxRunsPerTick of
  // four and the second round is where a task released by the first could be
  // picked up twice.
  for (let round = 0; round < 2; round += 1) {
    const reports = await Promise.all([left.tick(), right.tick()]);
    for (const report of reports) {
      assert.deepEqual(report.errors, [], 'a stage failed under contention');
    }
  }

  assert.deepEqual(
    [...ran].sort(),
    [...wanted].sort(),
    'every task ran, and none of them twice',
  );

  const statuses = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string; count: string }>(
      'SELECT status, count(*)::text AS count FROM tasks GROUP BY status',
    );
    return rows;
  });
  assert.deepEqual(statuses, [{ status: 'completed', count: '6' }]);
});

/**
 * A handoff happens because the loop ran, not because a test called it.
 *
 * `contracts-handoff.test.ts` proves the mechanism: a completed task's output
 * starts its successor, the engine starts it, and running the rules twice does
 * not fan out twice. What it does not prove is that anything runs the rules in
 * a live platform — `processHandoffs` took its rules as an argument and no
 * caller in `src/` passed any, so a deployment got handoffs only if it wrote
 * its own loop. One tick now does the whole thing: run the predecessor, then
 * create the successor from its output.
 */
test('one tick runs a task and then the handoff it owes (F6.1, F6.3)', async () => {
  const fixture = await createCompany('worker-handoff');
  await setRoleSchemas(fixture, fixture.roleId, {
    output: { type: 'object', required: ['findings'], properties: { findings: { type: 'array' } } },
  });
  await addRole(fixture, 'writer', {
    input: { type: 'object', required: ['findings'], properties: { findings: { type: 'array' } } },
  });

  const drafted: string[] = [];
  const worker = workerFor(fixture, async () => ({ findings: ['a', 'b'] }), {
    handlers: {
      writer: async (ctx) => {
        drafted.push((ctx.task.input.findings as string[]).join(' and '));
        return { draft: 'done' };
      },
    },
    handoffRules: [
      {
        fromRoleSlug: 'worker',
        toRoleSlug: 'writer',
        mapInput: (output) => ({ findings: output.findings }),
      },
    ],
  });

  await newTask(fixture);

  // The first tick runs the predecessor and, in its settle stage, creates the
  // successor. It does not run the successor: settle comes after claim, which
  // is the correct order for every other reason and costs a handoff one tick.
  const first = await worker.tick();
  assert.deepEqual(first.errors, []);
  assert.equal(first.handedOff, 1, 'the loop performed the handoff');
  assert.deepEqual(drafted, [], 'and did not also run it in the same pass');

  const second = await worker.tick();
  assert.deepEqual(second.errors, []);
  assert.deepEqual(drafted, ['a and b'], 'the successor ran on its predecessor\'s output');
  assert.equal(second.handedOff, 0, 'and the rule did not fire a second time');
});

/** One model call that cost something, at a chosen time. */
async function seedTrace(
  fixture: Fixture,
  taskId: string | null,
  cents: number,
  at: Date,
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response,
                               input_tokens, output_tokens, cost_cents, occurred_at)
       VALUES ($1, $2, $3, 'test-model', '{}'::jsonb, '{}'::jsonb, 10, 5, $4, $5)`,
      [randomUUID(), fixture.companyId, taskId, cents, at],
    );
  });
}

/**
 * The tick is what makes F1.8's "within five minutes" true.
 *
 * `spend-guard.test.ts` proves the breaker itself: ten times the usual rate
 * trips it, the role is frozen, an incident is raised, and the month is still
 * intact. What it calls is `evaluateCircuitBreakers` directly, so the
 * criterion's *timing* half — paused within five minutes of the spike — rested
 * on the watch stage running, and no test asserted that it did. The tick's own
 * docstring said it watched; nothing checked.
 *
 * The bound is the polling interval: `DEFAULT_IDLE_MS` is five seconds and a
 * tick that found work goes straight round, so the worst case is one tick
 * behind rather than five minutes. Asserted here as "one tick is enough",
 * which is the property that has to hold for the number in the PRD to be met
 * with room to spare.
 */
test('one tick trips the breaker on a role that spiked (F1.8, F1.7)', async () => {
  const fixture = await createCompany('worker-watch');
  const now = new Date();

  // A week of ten cents an hour, then a hundred in the last hour.
  const task = await newTask(fixture);
  for (let hoursAgo = 2; hoursAgo <= 167; hoursAgo += 1) {
    await seedTrace(fixture, task.id, 10, new Date(now.getTime() - hoursAgo * 3_600_000));
  }
  await seedTrace(fixture, task.id, 100, new Date(now.getTime() - 10 * 60_000));

  assert.equal(
    await withTenant(fixture.companyId, (tx) => isRoleFrozen(tx, fixture.roleId)),
    false,
    'nothing has looked yet',
  );

  const worker = workerFor(fixture, async () => ({ done: true }));
  const report = await worker.tick(now);
  assert.deepEqual(report.errors, []);

  assert.equal(
    await withTenant(fixture.companyId, (tx) => isRoleFrozen(tx, fixture.roleId)),
    true,
    'the loop found the spike without anybody calling the breaker',
  );

  const incidents = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'incident',
  );
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /spending too fast/);

  // And the interval that makes the criterion's five minutes generous.
  assert.ok(DEFAULT_IDLE_MS <= 60_000, `idle interval is ${DEFAULT_IDLE_MS}ms`);
});
