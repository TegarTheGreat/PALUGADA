/**
 * A role asks to be woken later about its own work (the audit of 3 October,
 * section 3.3; P0-7).
 *
 * Action executed, deliverable verified, outcome observed and goal achieved are
 * four different facts, and only the first was ever recorded: an invoice sent, a
 * campaign launched, a deploy shipped, and nothing was time-keyed to look at
 * what it did. `task.follow_up` makes a sub-task now that cannot be claimed
 * until it is time -- the claim already held a pending task until its
 * `wait_until`, which nothing set -- so it carries the parent's goal, budget and
 * taint and meets the same limits as any task, and is bounded: not sooner than
 * an hour, not later than ninety days, a handful open per goal, and cancelled
 * when its goal closes.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { claimTask, haltPastDeadlines } from '../../src/engine/checkout.ts';
import { createRootTask, getTask, outsideContentIn, transition } from '../../src/engine/tasks.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { applyGoalChange } from '../../src/domain/goals.ts';
import { workOf } from '../../src/owner/views.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const HOUR = 3_600_000;

async function runner(name: string) {
  const fixture = await createCompany(name);
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'task.follow_up');
  const parent = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'send the invoice' }, createdBy: 'owner', reserveTokens: 10_000,
  });
  await transition(fixture.companyId, parent.id, 'running');
  const broker = new CapabilityBroker(registry);
  let key = 0;
  const followUp = (input: Record<string, unknown>, from = parent.id) => broker.invoke<unknown, { taskId: string; wakesAt: string; role: string }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: from, idempotencyKey: `follow-${key += 1}`,
  }, 'task.follow_up', input);
  return { fixture, parent, followUp };
}

test('a follow-up is a task that cannot be claimed until its time, with its own window and the parent\'s goal', async () => {
  const { fixture, parent, followUp } = await runner('follow-up-basic');
  const before = Date.now();
  const made = (await followUp({ role: 'worker', brief: 'Check whether invoice 41 was paid; if not, remind the customer.', afterHours: 48 })).output;
  assert.equal(made.role, 'worker');
  // The parent finishes: the follow-up is what is left, and it outlives the work that asked for it.
  await transition(fixture.companyId, parent.id, 'completed', { output: { summary: 'Sent the invoice.' } });
  const wake = Date.parse(made.wakesAt);
  assert.ok(Math.abs(wake - (before + 48 * HOUR)) < 5_000, 'two days from now');

  const child = await withTenant(fixture.companyId, (tx) => tx.query<{
    status: string; wait_until: Date; deadline_at: Date; goal_id: string; parent_task_id: string; hop_depth: number; input: { goal: string }; created_by: string;
  }>('SELECT status, wait_until, deadline_at, goal_id, parent_task_id, hop_depth, input, created_by FROM tasks WHERE id = $1', [made.taskId]));
  const row = child.rows[0]!;
  assert.equal(row.status, 'pending');
  assert.equal(row.parent_task_id, parent.id);
  assert.equal(row.goal_id, fixture.goalId, 'the parent\'s goal');
  assert.equal(row.hop_depth, 1);
  assert.equal(row.created_by, 'agent_run');
  assert.match(row.input.goal, /invoice 41/);
  assert.equal(row.wait_until.getTime(), wake);
  assert.equal(row.deadline_at.getTime(), wake + 2 * HOUR, 'a window of two hours from when it wakes, not from when it was made');

  // Not before its time; at its time, claimed.
  assert.equal(await claimTask(fixture.companyId, { holder: 'w', now: new Date(before + HOUR) }), null);
  assert.equal(await claimTask(fixture.companyId, { holder: 'w', now: new Date(wake - 60_000) }), null);
  // And the deadline sweep does not halt it while it waits.
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(wake + HOUR)), [], 'inside its window');
  const claimed = await claimTask(fixture.companyId, { holder: 'w', now: new Date(wake + 60_000) });
  assert.equal(claimed?.taskId, made.taskId);
});

test('a follow-up that was not claimed within its window is halted, like any task past its deadline', async () => {
  const { fixture, followUp } = await runner('follow-up-late');
  const made = (await followUp({ role: 'worker', brief: 'Look at the launch numbers.', afterHours: 3, windowMinutes: 30 })).output;
  const wake = Date.parse(made.wakesAt);
  assert.deepEqual(await haltPastDeadlines(fixture.companyId, new Date(wake + 31 * 60_000)), [made.taskId]);
});

test('it carries what the parent had read from outside, and the same follow-up asked twice is one', async () => {
  const { fixture, parent, followUp } = await runner('follow-up-taint');
  await withTenant(fixture.companyId, (tx) => appendEvent(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, taskId: parent.id, type: 'content.read_outside', actor: 'system', payload: { capability: 'mailbox.read' },
  }));
  const first = (await followUp({ role: 'worker', brief: 'See whether the customer answered.', afterHours: 24 })).output;
  const outside = await withTenant(fixture.companyId, (tx) => outsideContentIn(tx, first.taskId));
  assert.notEqual(outside, null, 'an injected instruction cannot be laundered into clean, later work');
  const again = (await followUp({ role: 'worker', brief: 'See whether the customer answered.', afterHours: 24 })).output;
  assert.equal(again.taskId, first.taskId, 'a replayed request is the task it made');
});

test('it is not sooner than an hour, not later than ninety days, a handful open per goal, and it names a role that exists', async () => {
  const { followUp } = await runner('follow-up-bounds');
  const refused = (input: Record<string, unknown>, why: RegExp) => assert.rejects(followUp(input), (error: unknown) => why.test((error as Error).message));
  await refused({ role: 'worker', brief: 'Soon.', afterHours: 0 }, /afterHours/);
  await refused({ role: 'worker', brief: 'Later.', afterHours: 2161 }, /afterHours/);
  await refused({ role: 'worker', brief: '', afterHours: 5 }, /brief/);
  await refused({ role: 'nobody-here', brief: 'Who?', afterHours: 5 }, /nobody-here/);
  await refused({ role: 'worker', brief: 'Wide.', afterHours: 5, windowMinutes: 5 }, /windowMinutes/);

  for (let n = 1; n <= 5; n += 1) await followUp({ role: 'worker', brief: `Look again, time ${n}.`, afterHours: 5 + n });
  await refused({ role: 'worker', brief: 'One more than a goal may have open.', afterHours: 30 }, /at most 5 follow-ups are open for a goal/);
  // The same request again is the task it made, not a sixth.
  const replay = await followUp({ role: 'worker', brief: 'Look again, time 3.', afterHours: 8 });
  assert.ok(replay.output.taskId);
});

test('closing the goal cancels the follow-ups waiting under it, and releases what they held', async () => {
  const { fixture, parent, followUp } = await runner('follow-up-goal-closes');
  const made = (await followUp({ role: 'worker', brief: 'Check the campaign.', afterHours: 72 })).output;
  await transition(fixture.companyId, parent.id, 'completed', { output: { summary: 'Launched.' } });
  const held = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ tokens_reserved: string }>(
    'SELECT tokens_reserved FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId]))).rows[0]!.tokens_reserved;
  const before = Number(await held());
  await applyGoalChange({ companyId: fixture.companyId, goalId: fixture.goalId, status: 'met' });
  assert.ok(Number(await held()) < before, 'what the waiting task held is released');
  const after = await withTenant(fixture.companyId, (tx) => getTask(tx, made.taskId));
  assert.equal(after!.status, 'cancelled', 'nobody is woken about a goal that is done');
  assert.equal(await claimTask(fixture.companyId, { holder: 'w', now: new Date(Date.now() + 100 * HOUR) }), null);
});

test('the Work page says it will come back, and when, rather than that it is queued', async () => {
  const { fixture, followUp } = await runner('follow-up-work');
  const made = (await followUp({ role: 'worker', brief: 'Check the deploy.', afterHours: 12 })).output;
  const item = (await workOf(fixture.companyId, { taskId: made.taskId })).items[0]!;
  assert.equal(item.waiting?.reason, 'follow_up');
  assert.equal(new Date(item.waiting!.until!).getTime(), Date.parse(made.wakesAt));
});
