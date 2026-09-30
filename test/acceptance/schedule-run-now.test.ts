/**
 * The owner can run a schedule now (PRD F9.1, from the owner's console).
 *
 * A schedule could be created, changed, and turned on or off, and to see what
 * it did the owner waited for its next occurrence -- for a weekly review, a
 * week. Run now makes the task an occurrence would make, at once, and leaves
 * the schedule's own cadence where it was. It is refused while a task the
 * schedule made is still under way, so a double press or an impatient owner
 * does not start the same work twice, and it is refused for the reasons the
 * rest of the platform refuses new work: a frozen company, a closed goal.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { freezeCompany, unfreezeCompany } from '../../src/engine/control.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { runDueSchedules, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import type { WeekFacts } from '../../src/reporting/week.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function weekly(fixture: Fixture, extra: Partial<Parameters<typeof upsertSchedule>[0]> = {}) {
  return upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'weekly-invoices', cronExpression: '0 3 * * 1', timezone: 'Asia/Jakarta',
    input: { goal: 'Reconcile last week\'s invoices against the bank statement.' },
    reserveTokens: 2_500, priority: 1, batchable: true,
    ...extra,
  });
}

async function scheduleRow(fixture: Fixture, scheduleId: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    next_run_at: Date; last_run_at: Date | null; enabled: boolean;
  }>('SELECT next_run_at, last_run_at, enabled FROM schedules WHERE id = $1', [scheduleId]));
  return rows[0]!;
}

async function tasksOf(fixture: Fixture, scheduleId: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    id: string; status: string; created_by: string; project_id: string; division_id: string; role_id: string;
    budget_account_id: string; goal_id: string; priority: number; batchable: boolean; tokens_reserved: string;
    input: Record<string, unknown>;
  }>(
    `SELECT id, status, created_by, project_id, division_id, role_id, budget_account_id, goal_id, priority,
            batchable, tokens_reserved, input
       FROM tasks WHERE schedule_id = $1 ORDER BY created_at`,
    [scheduleId],
  ));
  return rows;
}

test('run now makes the task an occurrence would, by the owner, and leaves the schedule\'s next run where it was', async () => {
  const fixture = await createCompany('run-now');
  const scheduleId = await weekly(fixture);
  const before = await scheduleRow(fixture, scheduleId);

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    // What a run will reserve is on the list, so the console can say so before it asks.
    const listed = await api.call('GET', `/api/companies/${fixture.companyId}/schedules`, token);
    assert.equal(listed.body.schedules[0].reserveTokens, 2_500);

    const ran = await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`, token, {});
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    const taskId = String(ran.body.task.id);

    const [task, ...more] = await tasksOf(fixture, scheduleId);
    assert.equal(more.length, 0, 'one press, one task');
    assert.equal(task!.id, taskId, 'the answer is the task, for the console to link to');
    assert.deepEqual({
      status: task!.status, createdBy: task!.created_by, projectId: task!.project_id, divisionId: task!.division_id,
      roleId: task!.role_id, budgetAccountId: task!.budget_account_id, goalId: task!.goal_id, priority: task!.priority,
      batchable: task!.batchable, reserved: Number(task!.tokens_reserved), input: task!.input,
    }, {
      status: 'pending', createdBy: 'owner', projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, priority: 1,
      batchable: true, reserved: 2_500, input: { goal: 'Reconcile last week\'s invoices against the bank statement.' },
    });

    const after = await scheduleRow(fixture, scheduleId);
    assert.equal(after.next_run_at.toISOString(), before.next_run_at.toISOString(), 'the cadence is the schedule\'s own');
    assert.equal(after.last_run_at, null, 'an extra run is not an occurrence');

    const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{
      actor: string; task_id: string; payload: Record<string, unknown>;
    }>("SELECT actor, task_id, payload FROM events WHERE type = 'schedule.run_by_owner'"));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actor, 'owner');
    assert.equal(events[0]!.task_id, taskId);
    assert.equal(events[0]!.payload.scheduleId, scheduleId);
    assert.equal(events[0]!.payload.slug, 'weekly-invoices');

    // The schedule's history is the tasks that name it: the next occurrence
    // fires as it would have, beside the one the owner asked for.
    await transition(fixture.companyId, taskId, 'running');
    await transition(fixture.companyId, taskId, 'completed', { output: { summary: 'Reconciled.' } });
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [scheduleId]));
    const fired = await runDueSchedules();
    assert.deepEqual(fired.map((one) => one.scheduleId), [scheduleId]);
    assert.deepEqual((await tasksOf(fixture, scheduleId)).map((one) => one.created_by), ['owner', 'scheduler']);
  } finally {
    await api.close();
  }
});

test('a schedule that is off may be run once to try it, and stays off', async () => {
  const fixture = await createCompany('run-now-off');
  const scheduleId = await weekly(fixture, { enabled: false });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const ran = await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`, token, {});
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal((await tasksOf(fixture, scheduleId)).length, 1);
    assert.equal((await scheduleRow(fixture, scheduleId)).enabled, false, 'trying it is not turning it on');
  } finally {
    await api.close();
  }
});

test('a press while the schedule\'s task is live is refused with 409 naming it; once it has ended, a press works again', async () => {
  const fixture = await createCompany('run-now-live');
  const scheduleId = await weekly(fixture);
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`;
    const first = await api.call('POST', path, token, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const firstId = String(first.body.task.id);

    const again = await api.call('POST', path, token, {});
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.code, 'schedule.still_running');
    assert.equal(again.body.details.taskId, firstId);
    assert.match(String(again.body.error), new RegExp(`${firstId}.*pending`), 'the refusal names the task and where it is');

    // Running, it is still live.
    await transition(fixture.companyId, firstId, 'running');
    assert.equal((await api.call('POST', path, token, {})).status, 409);

    // Ended -- whichever way -- the schedule may run again.
    await transition(fixture.companyId, firstId, 'failed');
    const second = await api.call('POST', path, token, {});
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.task.id, firstId);

    // A live task the clock started counts the same as one the owner did.
    await transition(fixture.companyId, String(second.body.task.id), 'cancelled');
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [scheduleId]));
    const [fired] = await runDueSchedules();
    const refused = await api.call('POST', path, token, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.details.taskId, fired!.taskId);
    assert.equal((await tasksOf(fixture, scheduleId)).length, 3);
  } finally {
    await api.close();
  }
});

test('presses at once make one task between them', async () => {
  const fixture = await createCompany('run-now-race');
  const scheduleId = await weekly(fixture);
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`;
    const answers = await Promise.all(Array.from({ length: 6 }, () => api.call('POST', path, token, {})));
    const made = answers.filter((answer) => answer.status === 200);
    assert.equal(made.length, 1, JSON.stringify(answers.map((answer) => [answer.status, answer.body.code])));
    const taskId = String(made[0]!.body.task.id);
    for (const answer of answers.filter((one) => one.status !== 200)) {
      assert.equal(answer.status, 409, JSON.stringify(answer.body));
      assert.equal(answer.body.details.taskId, taskId, 'each refusal names the one task');
    }
    const tasks = await tasksOf(fixture, scheduleId);
    assert.deepEqual(tasks.map((task) => task.id), [taskId]);

    // And nothing was reserved for the presses that were refused.
    const { rows: [account] } = await withTenant(fixture.companyId, (tx) => tx.query<{ tokens_reserved: string }>(
      'SELECT tokens_reserved FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId]));
    assert.equal(Number(account!.tokens_reserved), 2_500);
  } finally {
    await api.close();
  }
});

test('a frozen company and a closed goal are refused as they are everywhere else, and start nothing', async () => {
  const fixture = await createCompany('run-now-refused');
  const scheduleId = await weekly(fixture);
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`;

    await freezeCompany(fixture.companyId);
    const frozen = await api.call('POST', path, token, {});
    assert.equal(frozen.body.code, 'company.frozen', JSON.stringify(frozen.body));
    assert.equal(frozen.status, 400);
    await unfreezeCompany(fixture.companyId);

    const closed = await api.call('POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`, token,
      { status: 'abandoned', proof: { totp: api.code() } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const refused = await api.call('POST', path, token, {});
    assert.equal(refused.body.code, 'goal.closed', JSON.stringify(refused.body));
    assert.equal(refused.status, 400);

    assert.equal((await tasksOf(fixture, scheduleId)).length, 0);
    const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query(
      "SELECT 1 FROM events WHERE type = 'schedule.run_by_owner'"));
    assert.equal(events.length, 0, 'a refused press leaves no record that it ran');
    const { rows: [account] } = await withTenant(fixture.companyId, (tx) => tx.query<{ tokens_reserved: string }>(
      'SELECT tokens_reserved FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId]));
    assert.equal(Number(account!.tokens_reserved), 0, 'and holds nothing');
  } finally {
    await api.close();
  }
});

test('a schedule of another company, or none, is not found, and nothing runs without a session', async () => {
  const fixture = await createCompany('run-now-mine');
  const other = await createCompany('run-now-theirs');
  const theirs = await weekly(other);
  const api = await consoleWithSettings();
  try {
    const anonymous = await fetch(`${api.url}/api/companies/${other.companyId}/schedules/${theirs}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(anonymous.status, 401);

    const token = await api.signIn();
    for (const scheduleId of [theirs, randomUUID()]) {
      const answer = await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`, token, {});
      assert.equal(answer.status, 400, JSON.stringify(answer.body));
      assert.match(String(answer.body.error), /no such schedule in this company/);
    }
    assert.equal((await tasksOf(other, theirs)).length, 0);
  } finally {
    await api.close();
  }
});

test('a schedule that asks for the week is handed it, and carries what the week read from outside', async () => {
  const fixture = await createCompany('run-now-week');
  const scheduleId = await weekly(fixture, {
    slug: 'weekly-business-review', batchable: false,
    input: { goal: 'Weekly business review.', facts: 'week' },
  });

  // Work finished this week, after reading an email.
  const replied = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Answer Budi' }, createdBy: 'owner',
    reserveTokens: 1_000,
  });
  await transition(fixture.companyId, replied.id, 'running');
  await withTenant(fixture.companyId, (tx) => appendEvent(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, taskId: replied.id, type: 'content.read_outside',
    actor: 'system', payload: { capability: 'mailbox.read' },
  }));
  await transition(fixture.companyId, replied.id, 'completed', { output: { summary: 'Refund promised by Friday.' } });

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const ran = await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`, token, {});
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    const [review] = await tasksOf(fixture, scheduleId);
    const input = review!.input as { goal: string; facts: string; week: WeekFacts };
    assert.equal(input.goal, 'Weekly business review.');
    assert.equal(input.facts, 'week');
    assert.deepEqual(input.week.finished.map((one) => [one.task, one.outside]), [[replied.id, true]]);

    const { rows: carried } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE task_id = $1 AND type = 'content.read_outside'", [review!.id]));
    assert.deepEqual(carried.map((row) => row.payload), [{ capability: 'the week it was handed', tasks: [replied.id] }]);
  } finally {
    await api.close();
  }
});
