/**
 * A goal the owner closes stops the work under it; a measure can be put
 * right; progress counts what was meant to be done.
 *
 * Found by reading the goal ladder against what an owner would expect: an
 * abandoned objective kept its schedules firing and its triggers open, new
 * work could be started under it, and the runs under it were never told it
 * was closed -- it kept spending. A metric with a wrong target could not be
 * changed or retired, so the wrong number stayed in every run's context and
 * on the portfolio. And a cancelled task counted against a goal forever, so
 * no goal with one could reach its end.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { createGoal, ancestryForTask, renderAncestry, GOAL_STATUSES } from '../../src/domain/goals.ts';
import { METRIC_UNITS, defineMetric, headlines } from '../../src/domain/metrics.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { runDueSchedules, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import { createTrigger } from '../../src/scheduler/triggers.ts';
import { buildContext } from '../../src/context/builder.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { ASSISTANT_ACTIONS } from '../../src/owner/assistant-actions.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let made = 0;
function start(fixture: Fixture, goalId: string) {
  made += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId, input: { goal: `work ${made}` }, createdBy: 'owner', reserveTokens: 1_000,
  });
}

test('closing a goal pauses what would start work under it, refuses new work, and tells the runs already under it', async () => {
  const fixture = await createCompany('closed-goal');
  const keyResult = await createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'kr-orders', statement: 'Fifty orders a week.', parentGoalId: fixture.goalId,
  });
  const running = await start(fixture, keyResult.id);
  const scheduleId = await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    slug: 'weekly-promo', cronExpression: '* * * * *', input: { goal: 'post the weekly promotion' }, reserveTokens: 1_000,
    goalId: keyResult.id,
  });
  const trigger = await createTrigger(fixture.companyId, {
    slug: 'new-order', roleId: fixture.roleId, goalId: fixture.goalId, instruction: 'Thank the customer.',
  });

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const closed = await api.call('POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`, token,
      { status: 'abandoned', proof: { totp: api.code() } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(closed.body.paused, { schedules: 1, triggers: 1 }, 'the owner is told what stopped');

    const [schedule] = (await withTenant(fixture.companyId, (tx) =>
      tx.query<{ enabled: boolean }>('SELECT enabled FROM schedules WHERE id = $1', [scheduleId]))).rows;
    assert.equal(schedule!.enabled, false, 'a schedule under a key result of the closed objective is paused');
    const [door] = (await withControlPlane((tx) =>
      tx.query<{ enabled: boolean }>('SELECT enabled FROM triggers WHERE id = $1', [trigger.id]))).rows;
    assert.equal(door!.enabled, false);

    await assert.rejects(start(fixture, fixture.goalId), (failure: Error & { code?: string }) =>
      failure.code === 'goal.closed' && /the objective "[^"]+" is abandoned/.test(failure.message));
    await assert.rejects(start(fixture, keyResult.id), /kr-orders.*is under the objective "[^"]+", which is abandoned/,
      'nor under a goal that is still active beneath one that is closed');
    await assert.rejects(createTrigger(fixture.companyId, {
      slug: 'another-door', roleId: fixture.roleId, goalId: keyResult.id, instruction: 'Thank the customer.',
    }), /which is abandoned/, 'and no new door opens onto it');

    // The run already under it is told, and can wind down rather than press on.
    const chain = await withTenant(fixture.companyId, (tx) => ancestryForTask(tx, running.id));
    assert.match(renderAncestry(chain), /objective \(abandoned\): /);
    await transition(fixture.companyId, running.id, 'running');
    const context = await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: running.id }));
    assert.match(context.sections.map((section) => section.body).join('\n'), /objective \(abandoned\)/);

    // A schedule turned back on by hand while its goal is closed does not fire; it pauses again.
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE schedules SET enabled = true, next_run_at = now() - interval '1 minute' WHERE id = $1", [scheduleId]));
    const fired = await runDueSchedules();
    assert.equal(fired.filter((one) => one.scheduleId === scheduleId).length, 0);
    const [again] = (await withTenant(fixture.companyId, (tx) =>
      tx.query<{ enabled: boolean }>('SELECT enabled FROM schedules WHERE id = $1', [scheduleId]))).rows;
    assert.equal(again!.enabled, false);

    // Reopened, work can start again; what was paused stays paused until the owner resumes it.
    const reopened = await api.call('POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`, token,
      { status: 'active', proof: { totp: api.code() } });
    assert.equal(reopened.status, 200);
    assert.ok(await start(fixture, keyResult.id));
    const [still] = (await withTenant(fixture.companyId, (tx) =>
      tx.query<{ enabled: boolean }>('SELECT enabled FROM schedules WHERE id = $1', [scheduleId]))).rows;
    assert.equal(still!.enabled, false);
  } finally {
    await api.close();
  }
});

test('a measure can be put right or retired by the owner, and a retired one leaves the runs and the portfolio', async () => {
  const fixture = await createCompany('measure-fix');
  const metricId = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'orders', name: 'Orders a week', unit: 'count', target: 500,
  });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${metricId}/observations`, token, { value: 12 });

    const unit = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${metricId}`, token,
      { unit: 'currency', proof: { totp: api.code() } });
    assert.equal(unit.status, 400);
    assert.match(String(unit.body.error), /the unit cannot change once values are recorded: 1 is/);

    const fixed = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${metricId}`, token,
      { target: 50, name: 'Paid orders a week', dueOn: '2026-12-31', proof: { totp: api.code() } });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    const structure = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    const metric = structure.goals.find((goal: { id: string }) => goal.id === fixture.goalId).metrics[0];
    assert.deepEqual({ name: metric.name, target: metric.target, dueOn: metric.dueOn, progress: metric.progress },
      { name: 'Paid orders a week', target: 50, dueOn: '2026-12-31', progress: 12 / 50 });

    const task = await start(fixture, fixture.goalId);
    await transition(fixture.companyId, task.id, 'running');
    const told = async () => (await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id })))
      .sections.map((section) => section.body).join('\n');
    assert.match(await told(), /Paid orders a week/);
    assert.equal((await withControlPlane((tx) => headlines(tx))).get(fixture.companyId)?.name, 'Paid orders a week');

    const retired = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${metricId}`, token,
      { retired: true, proof: { totp: api.code() } });
    assert.equal(retired.status, 200);
    assert.doesNotMatch(await told(), /Paid orders a week/, 'a retired measure is not what runs aim at');
    assert.equal((await withControlPlane((tx) => headlines(tx))).get(fixture.companyId), undefined, 'nor the headline');
    const after = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    const kept = after.goals.find((goal: { id: string }) => goal.id === fixture.goalId).metrics[0];
    assert.ok(kept.retiredAt, 'its history is kept, marked retired');
    const late = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${metricId}/observations`, token, { value: 20 });
    assert.equal(late.status, 400, 'and nothing more is recorded against it');
    assert.match(String(late.body.error), /the measure orders is retired and takes no further values/);
    await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
      "INSERT INTO metric_observations (company_id, metric_id, value, recorded_by) VALUES ($1, $2, 20, 'owner')",
      [fixture.companyId, metricId])), /retired and takes no further values/, 'by any path');

    // Restored from an archive, its history comes back with it.
    const lines: ArchiveLine[] = [];
    await exportCompany(fixture.companyId, (line) => { lines.push(line); });
    const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
    const values = await withTenant(restored.companyId, (tx) =>
      tx.query<{ value: string }>('SELECT value FROM metric_observations'));
    assert.deepEqual(values.rows.map((row) => Number(row.value)), [12]);
  } finally {
    await api.close();
  }
});

test('a goal\'s progress counts the work meant to be done: a cancelled task is not left owing', async () => {
  const fixture = await createCompany('honest-progress');
  const done = await start(fixture, fixture.goalId);
  const dropped = await start(fixture, fixture.goalId);
  await transition(fixture.companyId, done.id, 'running');
  await transition(fixture.companyId, done.id, 'completed');
  await transition(fixture.companyId, dropped.id, 'cancelled');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const structure = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    const goal = structure.goals.find((one: { id: string }) => one.id === fixture.goalId);
    assert.deepEqual({ done: goal.tasksDone, total: goal.tasksTotal }, { done: 1, total: 1 });
  } finally {
    await api.close();
  }
});

test('what the assistant is told a goal or a measure takes is what the owner API accepts', () => {
  const goal = ASSISTANT_ACTIONS.find((action) => action.pattern === '/api/companies/:companyId/goals/:goalId')!;
  for (const status of GOAL_STATUSES) assert.match(goal.fields!.status!, new RegExp(`\\b${status}\\b`));
  assert.doesNotMatch(goal.fields!.status!, /achieved/);
  const metric = ASSISTANT_ACTIONS.find((action) => action.pattern === '/api/companies/:companyId/goals/:goalId/metrics')!;
  for (const unit of METRIC_UNITS) assert.match(metric.fields!.unit!, new RegExp(`\\b${unit}\\b`));
  const schedule = ASSISTANT_ACTIONS.find((action) => action.pattern === '/api/companies/:companyId/schedules')!;
  assert.doesNotMatch(`${schedule.fields!.divisionId} ${schedule.fields!.projectId}`, /optional/);
});
