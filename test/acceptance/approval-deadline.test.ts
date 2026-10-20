/**
 * A deadline is the work's, not the owner's (the audit of 3 October, P0-1).
 *
 * `task.delegate` gives a child an hour. A child that asks for an approval
 * parks in `waiting_approval`, which the deadline sweep leaves alone; when the
 * owner said yes it went back to `running` with no lease, and the next sweep
 * -- or the claim itself -- took any running task whose deadline had passed.
 * The owner had approved, and the work was halted `deadline_passed` for the
 * hour the owner took. Time spent parked for someone else's decision is now
 * given back when the task is let go.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { claimTask, haltPastDeadlines } from '../../src/engine/checkout.ts';
import { sleep } from '../../src/timers.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function taskWithDeadline(fixture: Fixture, deadlineAt: Date, status: 'pending' | 'running') {
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `a task that is ${status}` },
    createdBy: 'owner',
    reserveTokens: 10_000,
    deadlineAt,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.nameservers' }]);
  if (status === 'running') await transition(fixture.companyId, task.id, 'running');
  return task;
}

const statusOf = async (fixture: Fixture, id: string) => (await withTenant(fixture.companyId, (tx) => getTask(tx, id)))!.status;

test('a task the owner approved is not halted by the time the owner took; one that was never waiting still is', async () => {
  const fixture = await createCompany('approval-deadline');
  const deadline = new Date(Date.now() + 60 * 60_000);
  const approved = await taskWithDeadline(fixture, deadline, 'running');
  const idle = await taskWithDeadline(fixture, deadline, 'pending');

  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: approved.id, capabilityName: 'dns.nameservers',
    tier: 2, actionSummary: 'Point the domain elsewhere', rationale: 'migration', consequenceIfDenied: 'the old host stays',
  });
  assert.equal(await statusOf(fixture, approved.id), 'waiting_approval');
  await sleep(1_500);
  await inbox.decide(fixture.companyId, itemId, 'approve');
  assert.equal(await statusOf(fixture, approved.id), 'running');

  const moved = (await withTenant(fixture.companyId, (tx) => getTask(tx, approved.id)))!.deadlineAt!.getTime() - deadline.getTime();
  assert.ok(moved >= 1_500 && moved < 6_000, `given back what it waited, not more (${moved} ms)`);

  // A moment past the deadline it was given: the owner's wait is not held against it.
  const past = new Date(deadline.getTime() + 1_000);
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, past), [idle.id], 'only the task that was never waiting is past its deadline');
  assert.equal(await statusOf(fixture, approved.id), 'running');
  const claim = await claimTask(fixture.companyId, { holder: 'worker-a', now: past });
  assert.equal(claim?.taskId, approved.id, 'and the claim takes it up, as the owner meant');
});

test('time parked for a reviewer is given back too, and a task with no deadline is left alone', async () => {
  const fixture = await createCompany('review-deadline');
  const deadline = new Date(Date.now() + 60 * 60_000);
  const reviewed = await taskWithDeadline(fixture, deadline, 'running');
  const free = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'no deadline' }, createdBy: 'owner', reserveTokens: 10_000,
  });
  await transition(fixture.companyId, free.id, 'running');
  await transition(fixture.companyId, free.id, 'waiting_review');
  await transition(fixture.companyId, reviewed.id, 'waiting_review');
  await sleep(1_200);
  await transition(fixture.companyId, reviewed.id, 'running');
  await transition(fixture.companyId, free.id, 'running');

  const after = await withTenant(fixture.companyId, async (tx) => ({ reviewed: await getTask(tx, reviewed.id), free: await getTask(tx, free.id) }));
  assert.ok(after.reviewed!.deadlineAt!.getTime() - deadline.getTime() >= 1_200, 'the review\'s time is given back');
  assert.equal(after.free!.deadlineAt, null, 'no deadline stays none');
});
