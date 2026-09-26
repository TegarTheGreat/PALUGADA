/**
 * Every live task has something that will move it.
 *
 * Three ways of losing that turned up in one afternoon -- a decision and its
 * task in two transactions, a window that never reopens, an approval withdrawn
 * from under a task that did not end -- and each was fixed where it happened.
 * These are about the net under all of them: a task waiting on nothing is
 * found, the owner is asked once, and their answer is the repair.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import {
  askAboutStranded, findStranded, reportStranded, STRANDED_AFTER_MS,
} from '../../src/engine/liveness.ts';
import { Worker } from '../../src/worker.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;
async function runningTask(fixture: Fixture) {
  sequence += 1;
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { n: sequence },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.nameservers' }]);
  await transition(fixture.companyId, task.id, 'running');
  return task;
}

/** Later than the grace period, so the only question left is the mover. */
function later(): Date {
  return new Date(Date.now() + STRANDED_AFTER_MS + 60_000);
}

async function openEscalations(fixture: Fixture, taskId: string): Promise<string[]> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM inbox_items WHERE task_id = $1 AND kind = 'escalation' AND status = 'open'",
      [taskId],
    );
    return rows.map((row) => row.id);
  });
}

/**
 * The shape the two-transaction decision left behind: the item decided, the
 * task still waiting for it. Written straight in, because no single call can
 * produce it any more.
 */
async function approvalDecidedUnderIt(fixture: Fixture) {
  const task = await runningTask(fixture);
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'dns.nameservers',
    tier: 2, actionSummary: 'Point the domain elsewhere', rationale: 'migration',
    consequenceIfDenied: 'the old host stays',
  });
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE inbox_items SET status = 'decided', decision = 'approve', decided_at = now() WHERE id = $1",
    [itemId],
  ));
  return task;
}

test('a task waiting for an approval that is no longer open is found and put to the owner once', async () => {
  const fixture = await createCompany('stranded-approval');
  const task = await approvalDecidedUnderIt(fixture);

  // Not within the grace period: a clock's margin, not a race's.
  assert.deepEqual(await findStranded(fixture.companyId), []);

  const found = await findStranded(fixture.companyId, later());
  assert.deepEqual(found.map((f) => [f.taskId, f.shape]), [[task.id, 'approval_missing']]);

  // Two workers sweeping the same company both find it -- given the same
  // finding here, so the race is the one that matters rather than whichever
  // order the pool happened to run them in -- and the owner is asked once.
  const [first, second] = await Promise.all([
    askAboutStranded(fixture.companyId, found[0]!),
    askAboutStranded(fixture.companyId, found[0]!),
  ]);
  assert.equal(Number(first) + Number(second), 1, 'asked once, however many workers looked');
  assert.equal(await reportStranded(fixture.companyId, later()), 0, 'and not again on the next tick');
  const [escalation] = await openEscalations(fixture, task.id);
  assert.ok(escalation, 'the owner has something to answer');

  // And the open escalation is itself the mover, so the task is no longer
  // stranded while it waits for the owner.
  assert.deepEqual(await findStranded(fixture.companyId, later()), []);

  // The answer is the repair: approve runs it again.
  await inbox.decide(fixture.companyId, escalation, 'approve');
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'running');
});

/**
 * A test in scheduling-windows asserts this task "stays parked however long
 * anyone waits", which is correct -- claiming it would be a loop -- and
 * nothing ever told the owner it was there.
 */
test('a task parked with no time to wake at is put to the owner, and deny cancels it', async () => {
  const fixture = await createCompany('stranded-window');
  const task = await runningTask(fixture);
  await transition(fixture.companyId, task.id, 'waiting_window', { waitUntil: null });

  const parkedWithTime = await runningTask(fixture);
  await transition(fixture.companyId, parkedWithTime.id, 'waiting_window', {
    waitUntil: new Date(Date.now() + 3_600_000),
  });

  const found = await findStranded(fixture.companyId, later());
  assert.deepEqual(found.map((f) => [f.taskId, f.shape]), [[task.id, 'wake_missing']],
    'a task with a wake-up time has a mover: the clock');

  await reportStranded(fixture.companyId, later());
  const [escalation] = await openEscalations(fixture, task.id);
  await inbox.decide(fixture.companyId, escalation!, 'deny');
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'cancelled');
});

test('a task waiting for a review nobody was asked for is found; one with an open approval is not', async () => {
  const fixture = await createCompany('stranded-review');
  const reviewless = await runningTask(fixture);
  await transition(fixture.companyId, reviewless.id, 'waiting_review');

  const healthy = await runningTask(fixture);
  await inbox.requestApproval({
    companyId: fixture.companyId, taskId: healthy.id, capabilityName: 'dns.nameservers',
    tier: 2, actionSummary: 'Point the domain elsewhere', rationale: 'migration',
    consequenceIfDenied: 'the old host stays',
  });

  // And one with its review pending: a reviewer is its mover.
  const reviewed = await runningTask(fixture);
  await transition(fixture.companyId, reviewed.id, 'waiting_review');
  await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, output_schema, done_criteria)
       VALUES ($1, $2, 'reviewer', 'You review.', 'test-model', '{"type":"object"}'::jsonb,
               ARRAY['a verdict'])
       RETURNING id`,
      [fixture.companyId, fixture.divisionId],
    );
    await tx.query(
      `INSERT INTO review_requests (company_id, project_id, proposer_task_id, proposer_role_id,
                                    reviewer_role_id, capability_name, action_fingerprint,
                                    proposal, criteria)
       VALUES ($1, $2, $3, $4, $5, 'dns.nameservers', 'fp', '{}'::jsonb, 'is it safe')`,
      [fixture.companyId, fixture.projectId, reviewed.id, fixture.roleId, rows[0]!.id],
    );
  });

  const found = await findStranded(fixture.companyId, later());
  assert.deepEqual(found.map((f) => [f.taskId, f.shape]), [[reviewless.id, 'review_missing']]);
});

/**
 * The sweep is only worth having if something runs it. Asserted through a
 * worker tick, because a function nothing calls is the defect this repository
 * keeps finding in itself.
 */
test('the worker tick runs the sweep', async () => {
  const fixture = await createCompany('stranded-tick');
  const task = await approvalDecidedUnderIt(fixture);

  const worker = new Worker({
    engine: new Engine({
      broker: new CapabilityBroker(new CapabilityRegistry()),
      llm: new RecordingLlmClient(),
      handlers: new Map(),
    }),
    companyId: fixture.companyId,
  });
  const report = await worker.tick(later());
  assert.equal(report.stranded, 1, JSON.stringify(report.errors));
  assert.equal((await openEscalations(fixture, task.id)).length, 1);
});

/**
 * The lock, held across processes. Two workers are two processes with their
 * own pools, so the race is between transactions, not promises: another
 * worker holds the task's lock and has written its record but not committed.
 * This one must wait for it and then find the record, rather than read "no
 * record yet" and ask a second time.
 */
test('a second worker waits for the first one\'s record instead of asking again', async () => {
  const fixture = await createCompany('stranded-lock');
  const task = await approvalDecidedUnderIt(fixture);
  const [found] = await findStranded(fixture.companyId, later());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const otherWorker = withTenant(fixture.companyId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('stranded:' || $1))", [task.id]);
    await tx.query(
      `INSERT INTO events (company_id, project_id, task_id, type, actor, payload)
       VALUES ($1, $2, $3, 'task.stranded', 'system', '{"shape":"approval_missing"}'::jsonb)`,
      [fixture.companyId, fixture.projectId, task.id],
    );
    held();
    await gate;
  });

  await holding;
  const asking = askAboutStranded(fixture.companyId, found!);
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await otherWorker;

  assert.equal(await asking, false, 'the other worker already asked');
  assert.deepEqual(await openEscalations(fixture, task.id), []);
});
