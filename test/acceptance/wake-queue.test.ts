/**
 * PRD v2 F9.7–F9.10 and F10.11 -- dormancy, the wake queue, coalescing, and
 * the owner handing a role work directly.
 *
 * Principle 13 is the frame: dormant is the normal state, and G8 puts a number
 * on what that has to mean — zero tokens when there is no task. The property
 * these tests hold in place is that **a wake is a reason to look, not a reason
 * to run**. v2 section 2.3 traces real surprise bills to the opposite: an
 * eager heartbeat waking an agent with nothing to do.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  COALESCE_WINDOW_MS,
  assignTask,
  coalescedCount,
  drainWakes,
  dueWakes,
  enqueueWake,
  scheduleHeartbeats,
} from '../../src/scheduler/wake.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { unfreezeRole } from '../../src/governance/role-freeze.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

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
    input: { goal: `wake-${sequence}` },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
}

async function eventsOfType(companyId: string, type: string): Promise<number> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events WHERE type = $1',
      [type],
    );
    return Number(rows[0]!.count);
  });
}

test('a role sleeps four hours by default, and wakes when it is due (F9.7)', async () => {
  // Conservative on purpose: v2 traces surprise bills to an aggressive
  // heartbeat meeting vague instructions, so a company that needs faster
  // turnaround says so per role rather than everywhere at once.
  const fixture = await createCompany('wake-heartbeat');
  const now = new Date();

  const first = await scheduleHeartbeats(fixture.companyId, now);
  assert.deepEqual(first, [fixture.roleId], 'a role that has never been scheduled is due');

  // And then it is asleep.
  assert.deepEqual(await scheduleHeartbeats(fixture.companyId, new Date(now.getTime() + 60_000)), []);

  const dormantUntil = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ dormant_until: Date }>(
      'SELECT dormant_until FROM roles WHERE id = $1',
      [fixture.roleId],
    );
    return rows[0]!.dormant_until;
  });
  const hours = (dormantUntil.getTime() - now.getTime()) / 3_600_000;
  assert.ok(hours > 3.9 && hours < 4.1, `four hours, got ${hours}`);

  // Due again once the four hours are up.
  const later = new Date(now.getTime() + 4 * 3_600_000 + 1_000);
  assert.deepEqual(await scheduleHeartbeats(fixture.companyId, later), [fixture.roleId]);
});

test('a frozen role is not woken', async () => {
  // A frozen role admits no work, so waking it would produce a queue entry
  // whose only possible outcome is idle.
  const fixture = await createCompany('wake-frozen');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET frozen_at = now(), frozen_reason = 'test' WHERE id = $1", [
      fixture.roleId,
    ]);
  });

  assert.deepEqual(await scheduleHeartbeats(fixture.companyId), []);
  await unfreezeRole(fixture.companyId, fixture.roleId);
  assert.deepEqual(await scheduleHeartbeats(fixture.companyId), [fixture.roleId]);
});

test('four wakes in a minute become one run, and the other three are kept (F9.9)', async () => {
  // "The queue asked four times and we looked once" is a fact about the
  // system's rhythm the owner may need; a delete would erase it.
  const fixture = await createCompany('wake-coalesce');
  const now = new Date();

  const first = await enqueueWake({
    companyId: fixture.companyId, roleId: fixture.roleId, reason: 'event', wakeAt: now,
  });
  assert.equal(first.coalesced, false);

  for (let i = 1; i <= 3; i += 1) {
    const folded = await enqueueWake({
      companyId: fixture.companyId,
      roleId: fixture.roleId,
      reason: 'event',
      wakeAt: new Date(now.getTime() + i * 10_000),
    });
    assert.equal(folded.coalesced, true);
    assert.equal(folded.id, first.id, 'folded into the entry that already existed');
  }

  const due = await dueWakes(fixture.companyId, new Date(now.getTime() + 60_000));
  assert.equal(due.length, 1, 'one thing to look at');
  assert.equal(await coalescedCount(fixture.companyId, first.id), 3);
  assert.equal(await eventsOfType(fixture.companyId, 'wake.coalesced'), 3);
});

test('a wake outside the window is its own run', async () => {
  const fixture = await createCompany('wake-window');
  const now = new Date();
  const first = await enqueueWake({
    companyId: fixture.companyId, roleId: fixture.roleId, reason: 'event', wakeAt: now,
  });
  const later = await enqueueWake({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    reason: 'event',
    wakeAt: new Date(now.getTime() + COALESCE_WINDOW_MS + 5_000),
  });

  assert.equal(later.coalesced, false);
  assert.notEqual(later.id, first.id);
});

test('a wake with nothing to do costs nothing (F9.10, G8)', async () => {
  // The whole point. No context is assembled, no model is called, no run row
  // is written -- the difference between an agent that is dormant and one that
  // is merely quiet.
  const fixture = await createCompany('wake-idle');
  const llm = new RecordingLlmClient();
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm,
    workerId: 'wake-worker',
    handlers: new Map([['worker', async () => ({ done: true })]]),
  });

  await scheduleHeartbeats(fixture.companyId);
  const outcomes = await drainWakes(fixture.companyId, { holder: engine.workerId });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.taskId, null, 'there was nothing to claim');
  assert.equal(llm.callCount, 0, 'and so nothing was spent');
  assert.equal(await eventsOfType(fixture.companyId, 'wake.idle'), 1);

  const runs = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_runs',
    );
    return Number(rows[0]!.count);
  });
  assert.equal(runs, 0, 'no run row either');
});

test('a wake with work to do claims it (F9.8)', async () => {
  const fixture = await createCompany('wake-work');
  const task = await newTask(fixture);
  await scheduleHeartbeats(fixture.companyId);

  const outcomes = await drainWakes(fixture.companyId, { holder: 'wake-worker' });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.taskId, task.id);

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'checked_out');
  assert.equal(stored!.leaseHolder, 'wake-worker');
});

test('a wake claims only for the role it names', async () => {
  // Waking the marketing role must not hand it the operator's work.
  const fixture = await createCompany('wake-role-scope');
  const other = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model,
                          output_schema, done_criteria)
       VALUES ($1, $2, 'second', 'p', 'm', '{"type":"object"}'::jsonb, ARRAY['done'])
       RETURNING id`,
      [fixture.companyId, fixture.divisionId],
    );
    return rows[0]!.id;
  });

  const mine = await newTask(fixture);
  await enqueueWake({ companyId: fixture.companyId, roleId: other, reason: 'event' });

  const outcomes = await drainWakes(fixture.companyId, { holder: 'wake-worker' });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.taskId, null, "the other role's queue found no work of its own");

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, mine.id));
  assert.equal(stored!.status, 'pending', 'and nobody else took it');
});

test("an owner's assignment overtakes the schedule (F9.8, F10.11)", async () => {
  // The owner asking for something now and the system answering in four hours
  // is exactly what this rules out.
  const fixture = await createCompany('wake-assignment');
  const now = new Date();

  // Put the role to sleep first.
  await scheduleHeartbeats(fixture.companyId, now);
  await drainWakes(fixture.companyId, { holder: 'wake-worker', now });

  const { task, wakeId } = await assignTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: 'do this now' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });

  // Queried against the wall clock rather than the captured `now`: the
  // assignment was queued a few hundred milliseconds after this test started.
  const due = await dueWakes(fixture.companyId, new Date());
  assert.equal(due.length, 1);
  assert.equal(due[0]!.id, wakeId);
  assert.equal(due[0]!.reason, 'assignment');
  assert.equal(due[0]!.priority, 0, 'the owner outranks a schedule');

  const outcomes = await drainWakes(fixture.companyId, { holder: 'wake-worker' });
  assert.equal(outcomes[0]!.taskId, task.id);
});

test('an assignment is never folded into a heartbeat (F9.8)', async () => {
  // Folding one into a heartbeat that is not due for hours would do the
  // opposite of "penugasan langsung melewati jadwal".
  const fixture = await createCompany('wake-assignment-unfolded');
  const now = new Date();
  const heartbeat = await enqueueWake({
    companyId: fixture.companyId, roleId: fixture.roleId, reason: 'heartbeat', wakeAt: now,
  });

  const assignment = await enqueueWake({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    reason: 'assignment',
    wakeAt: new Date(now.getTime() + 1_000),
  });

  assert.equal(assignment.coalesced, false);
  assert.notEqual(assignment.id, heartbeat.id);

  const due = await dueWakes(fixture.companyId, new Date(now.getTime() + 10_000));
  assert.deepEqual(due.map((entry) => entry.reason), ['assignment', 'heartbeat']);
});

test('a consumed wake is not looked at twice', async () => {
  const fixture = await createCompany('wake-consumed');
  await enqueueWake({ companyId: fixture.companyId, roleId: fixture.roleId, reason: 'event' });

  assert.equal((await drainWakes(fixture.companyId, { holder: 'w' })).length, 1);
  assert.equal((await drainWakes(fixture.companyId, { holder: 'w' })).length, 0);
});

test('a wake in the future waits for it', async () => {
  const fixture = await createCompany('wake-future');
  const now = new Date();
  await enqueueWake({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    reason: 'schedule',
    wakeAt: new Date(now.getTime() + 3_600_000),
  });

  assert.deepEqual(await dueWakes(fixture.companyId, now), []);
  assert.equal((await dueWakes(fixture.companyId, new Date(now.getTime() + 3_601_000))).length, 1);
});

test("one company's queue is invisible to another", async () => {
  const mine = await createCompany('wake-mine');
  const theirs = await createCompany('wake-theirs');
  await enqueueWake({ companyId: mine.companyId, roleId: mine.roleId, reason: 'event' });

  assert.equal((await dueWakes(mine.companyId)).length, 1);
  assert.deepEqual(await dueWakes(theirs.companyId), []);
});

test('a drained wake hands the task to the engine, which runs it', async () => {
  // The queue claims, the engine runs what was claimed. Kept separate because
  // claiming is cheap and running is not, and F9.10 is the rule that only the
  // first happens when there is nothing to do.
  const fixture = await createCompany('wake-end-to-end');
  const ran: string[] = [];
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    workerId: 'wake-worker',
    handlers: new Map([['worker', async (ctx) => {
      ran.push(ctx.task.id);
      return { done: true };
    }]]),
  });

  const task = await newTask(fixture);
  await scheduleHeartbeats(fixture.companyId);
  const [outcome] = await drainWakes(fixture.companyId, { holder: engine.workerId });

  assert.equal(outcome!.taskId, task.id);
  const result = await engine.runTask(fixture.companyId, outcome!.taskId!, 'worker');
  assert.equal(result.status, 'completed');
  assert.deepEqual(ran, [task.id]);

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'completed');
});
