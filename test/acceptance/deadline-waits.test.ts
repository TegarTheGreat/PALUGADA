/**
 * A deadline is for the work, not for the waiting (the audit of 6 October, S1).
 *
 * The audit of 3 October gave an approved task back the time the owner took
 * (P0-1). Three other waits were still held against the work, and each halted
 * it `deadline_passed` for having been patient:
 *
 * - **A closed window.** A delegated child has an hour. One whose outward action
 *   fell outside the company's office hours was parked until they reopened --
 *   a weekend is sixty-five hours -- and halted by the sweep long before.
 *   Office hours were said to defer, never refuse.
 * - **A child that waits for the owner.** A coordinator awaiting a specialist
 *   who waits for the owner's yes was halted at its own deadline, and the
 *   owner's later yes ran the action with nothing left to use the answer.
 * - **Going on after a budget stop.** The owner raised the ceiling and pressed
 *   Continue, and the next sweep halted the task for the time it had been stopped.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, createSubTask, getTask, transition } from '../../src/engine/tasks.ts';
import { haltPastDeadlines } from '../../src/engine/checkout.ts';
import { continueHalted } from '../../src/engine/owner-control.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { sleep } from '../../src/timers.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const HOUR = 3_600_000;
let made = 0;

function task(fixture: Fixture, deadlineAt: Date | null) {
  made += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `work ${made}` }, createdBy: 'owner',
    reserveTokens: 1_000, ...(deadlineAt ? { deadlineAt } : {}),
  });
}

const read = (fixture: Fixture, id: string) => withTenant(fixture.companyId, async (tx) => (await getTask(tx, id))!);

test('a task parked for a closed window is given the wait back, and is not halted while it waits', async () => {
  const fixture = await createCompany('deadline-window');
  const deadline = new Date(Date.now() + HOUR);
  const parked = await task(fixture, deadline);
  const impatient = await task(fixture, deadline);
  await transition(fixture.companyId, parked.id, 'running');
  await transition(fixture.companyId, impatient.id, 'running');

  // Office hours reopen in sixty-five hours: a weekend.
  const reopens = new Date(Date.now() + 65 * HOUR);
  await transition(fixture.companyId, parked.id, 'waiting_window', { waitUntil: reopens, waitReason: 'window' });
  // A parent waiting on a child is another thing, and is handled where it asks.
  await transition(fixture.companyId, impatient.id, 'waiting_window', { waitUntil: new Date(Date.now() + 2 * 60_000), waitReason: 'child' });

  const moved = (await read(fixture, parked.id)).deadlineAt!.getTime() - deadline.getTime();
  assert.ok(Math.abs(moved - 65 * HOUR) < 5_000, `given back what it will wait (${moved} ms)`);
  assert.equal((await read(fixture, impatient.id)).deadlineAt!.getTime(), deadline.getTime(), 'a child wait gives nothing back here');

  // A moment after its original deadline, and long after: only the one that was not parked for a window is past it.
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(deadline.getTime() + 1_000)), [impatient.id]);
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(reopens.getTime() + 30 * 60_000)), [], 'and the window\'s own hour is still its own');
  assert.equal((await read(fixture, parked.id)).status, 'waiting_window');
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(reopens.getTime() + HOUR + 1_000)), [parked.id], 'a task that did not finish in its hour is still halted');
});

test('a coordinator awaiting a child that waits for the owner is not halted before the child is', async () => {
  const fixture = await createCompany('deadline-parent');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'task.await');
  const broker = new CapabilityBroker(registry);
  const ask = (parentId: string, childId: string, key: string) => broker.invoke({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: parentId, idempotencyKey: key,
  }, 'task.await', { childId });

  // The coordinator has a few minutes; its specialist an hour, and is waiting for the owner's yes.
  const parent = await task(fixture, new Date(Date.now() + 3 * 60_000));
  await transition(fixture.companyId, parent.id, 'running');
  const childDeadline = new Date(Date.now() + HOUR);
  const child = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal: 'a part of the work' }, reserveTokens: 500, deadlineAt: childDeadline,
  });
  await transition(fixture.companyId, child.id, 'running');
  await transition(fixture.companyId, child.id, 'waiting_approval');

  await assert.rejects(ask(parent.id, child.id, 'await-1'), /still working on it/);
  const covered = (await read(fixture, parent.id)).deadlineAt!.getTime();
  assert.ok(covered >= childDeadline.getTime(), `the coordinator's deadline reaches its child's (${covered - childDeadline.getTime()} ms past it)`);

  // Hours on: the child's deadline is long past and the owner has not answered, so the child is not halted (it is
  // waiting for a person), and the coordinator -- whose own deadline has all but come -- is carried on by each look
  // it takes, so it is not halted for the owner's silence either.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE tasks SET deadline_at = CASE WHEN id = $1 THEN now() + interval '1 second' ELSE now() - interval '1 hour' END WHERE id IN ($1, $2)",
    [parent.id, child.id]));
  await assert.rejects(ask(parent.id, child.id, 'await-2'), /still working on it/);
  assert.ok((await read(fixture, parent.id)).deadlineAt!.getTime() >= Date.now() + 4 * 60_000, 'carried a few looks on');
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(Date.now() + 3 * 60_000)), [], 'neither is halted while the owner has not answered');
  assert.equal((await read(fixture, parent.id)).status, 'running');
  assert.equal((await read(fixture, child.id)).status, 'waiting_approval');

  // A task with no deadline is left with none.
  const free = await task(fixture, null);
  await transition(fixture.companyId, free.id, 'running');
  const freeChild = await createSubTask(free.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal: 'a part' }, reserveTokens: 500, deadlineAt: childDeadline,
  });
  await transition(fixture.companyId, freeChild.id, 'running');
  await assert.rejects(ask(free.id, freeChild.id, 'await-3'), /still working on it/);
  assert.equal((await read(fixture, free.id)).deadlineAt, null);
});

test('a task the owner goes on with after a budget stop is given back the time it was stopped', async () => {
  const fixture = await createCompany('deadline-continue');
  const deadline = new Date(Date.now() + HOUR);
  const stopped = await task(fixture, deadline);
  await transition(fixture.companyId, stopped.id, 'running');
  await transition(fixture.companyId, stopped.id, 'halted', { haltReason: 'budget_exhausted', detail: 'no tokens' });
  await sleep(1_500);

  await continueHalted(fixture.companyId, stopped.id);
  const after = await read(fixture, stopped.id);
  assert.equal(after.status, 'pending');
  const moved = after.deadlineAt!.getTime() - deadline.getTime();
  assert.ok(moved >= 1_400 && moved < 8_000, `the time it was stopped is not held against it (${moved} ms)`);
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(deadline.getTime() + 1_000)), [], 'so the next sweep leaves it alone');
});
