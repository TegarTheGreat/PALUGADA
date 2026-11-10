/**
 * A weekly review does not run on a week with nothing in it (N10, the
 * analysis of 3 October).
 *
 * "Let it run itself", on by default when a company is created, adds a
 * strategist who reviews the week every Monday. On a company that had done
 * nothing yet, the review read an empty week, delegated to find something to
 * say, and spent 770 thousand tokens in three and a half minutes. A review
 * of nothing is not worth a token: when the clock fires a schedule that asks
 * for the week, and nothing happened in it but the schedule's own runs --
 * no work started or finished, no measure recorded -- the occurrence is passed
 * over, said, and the schedule goes on to its next. The owner's "Run now"
 * runs it whatever the week holds: they asked.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { changeMetric, defineMetric, recordObservation } from '../../src/domain/metrics.ts';
import { runDueSchedules, runScheduleNow, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function review(fixture: Fixture) {
  return upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'weekly-business-review', cronExpression: '45 7 * * 1', timezone: 'Asia/Jakarta',
    input: { goal: 'Weekly business review.', facts: 'week' },
  });
}

async function due(fixture: Fixture, scheduleId: string): Promise<void> {
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE schedules SET next_run_at = date_trunc('milliseconds', now() - interval '1 minute') WHERE id = $1", [scheduleId]));
}

async function runsOf(fixture: Fixture, scheduleId: string): Promise<number> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM tasks WHERE schedule_id = $1', [scheduleId]));
  return rows[0]!.n;
}

test('the clock passes over a week with nothing in it, says so, and goes on to the next (N10)', async () => {
  const fixture = await createCompany('quiet-week');
  const scheduleId = await review(fixture);
  await due(fixture, scheduleId);

  assert.deepEqual(await runDueSchedules(), [], 'nothing was made');
  assert.equal(await runsOf(fixture, scheduleId), 0);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ next_run_at: Date; payload: { slug: string } }>(
    `SELECT s.next_run_at, e.payload FROM schedules s
       JOIN events e ON e.type = 'schedule.nothing_to_review' AND e.payload->>'scheduleId' = s.id::text
      WHERE s.id = $1`, [scheduleId]));
  assert.equal(rows.length, 1, 'said once');
  assert.equal(rows[0]!.payload.slug, 'weekly-business-review');
  assert.ok(rows[0]!.next_run_at.getTime() > Date.now(), 'and on to its next Monday');

  // The schedule's own run is not something to review.
  const own = await runScheduleNow(fixture.companyId, scheduleId);
  await transition(fixture.companyId, own.id, 'running');
  await transition(fixture.companyId, own.id, 'completed', { output: { summary: 'Nothing happened this week.' } });
  await due(fixture, scheduleId);
  assert.deepEqual(await runDueSchedules(), [], 'its own last run is not news');
});

test('a week with work in it is reviewed, and the owner may run a review of an empty one (N10)', async () => {
  const fixture = await createCompany('busy-week');
  const scheduleId = await review(fixture);

  // The owner asked: it runs.
  const asked = await runScheduleNow(fixture.companyId, scheduleId);
  assert.ok(asked.id);
  await transition(fixture.companyId, asked.id, 'running');
  await transition(fixture.companyId, asked.id, 'cancelled');

  // Work was finished this week.
  const work = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Answer Budi' }, createdBy: 'owner',
    reserveTokens: 1_000,
  });
  await transition(fixture.companyId, work.id, 'running');
  await transition(fixture.companyId, work.id, 'completed', { output: { summary: 'Refund promised by Friday.' } });
  await due(fixture, scheduleId);
  const fired = await runDueSchedules();
  assert.equal(fired.length, 1, 'the week is reviewed');
  assert.equal(await runsOf(fixture, scheduleId), 2);
});

/**
 * The audit of 6 October (L1): the one evaluator the company has skipped a
 * quiet week, and a quiet week is what a stalled company looks like. A measure
 * the owner set and the company has not reached is a reason to look, whatever
 * the week held; one it has reached, or the owner retired, is not.
 */
test('a quiet week is still reviewed while the company has a measure it has not reached', async () => {
  const fixture = await createCompany('quiet-unreached');
  const scheduleId = await review(fixture);
  const metricId = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'paid-invoices', name: 'Paid invoices', unit: 'count', target: 10, dueOn: '2026-12-31',
  });

  await due(fixture, scheduleId);
  assert.equal((await runDueSchedules()).length, 1, 'nothing happened, and the number is not where it should be');
  // That review is done (a schedule does not overlap itself), and long ago.
  const ran = await withControlPlane(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM tasks WHERE schedule_id = $1', [scheduleId])).rows);
  for (const one of ran) {
    await transition(fixture.companyId, one.id, 'running');
    await transition(fixture.companyId, one.id, 'cancelled');
  }

  // Reached long ago: nothing to chase, and nothing happened this week.
  await withControlPlane(async (tx) => {
    await recordObservation(tx, { companyId: fixture.companyId, metric: 'paid-invoices', value: 12, recordedBy: 'owner' });
    await tx.query("UPDATE metric_observations SET observed_at = now() - interval '20 days' WHERE metric_id = $1", [metricId]);
    await tx.query("UPDATE tasks SET created_at = now() - interval '20 days', finished_at = now() - interval '20 days' WHERE schedule_id = $1", [scheduleId]);
  });
  await due(fixture, scheduleId);
  assert.deepEqual(await runDueSchedules(), [], 'a number that has reached its target is not chased');

  // The target is raised past the value: it is a reason again; and a retired measure is none.
  await changeMetric(fixture.companyId, metricId, { target: 20 });
  await due(fixture, scheduleId);
  assert.equal((await runDueSchedules()).length, 1);
  for (const one of (await withControlPlane(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM tasks WHERE schedule_id = $1 AND status = 'pending'", [scheduleId])).rows))) {
    await transition(fixture.companyId, one.id, 'running');
    await transition(fixture.companyId, one.id, 'cancelled');
  }
  await changeMetric(fixture.companyId, metricId, { retired: true });
  await withControlPlane((tx) => tx.query("UPDATE tasks SET created_at = now() - interval '20 days', finished_at = now() - interval '20 days' WHERE schedule_id = $1", [scheduleId]));
  await due(fixture, scheduleId);
  assert.deepEqual(await runDueSchedules(), [], 'a retired measure is not chased');
});

/**
 * "Run now" said it "reserves 1,000 tokens", and the owner read that as the
 * cost; the run spent 770 thousand. A reservation is what a run sets aside
 * to start, not what it may spend: the schedule says the most its role lets
 * one run spend, for the console to say before it runs (N10).
 */
test('a schedule says the most one run of it may spend, not only what it reserves (N10)', async () => {
  const fixture = await createCompany('run-ceiling');
  const scheduleId = await review(fixture);
  await withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE roles SET max_tokens_per_run = 120000 WHERE id = $1', [fixture.roleId]));
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = await api.call('GET', `/api/companies/${fixture.companyId}/schedules`, token);
    const schedule = (listed.body.schedules as Array<{ id: string; reserveTokens: number; runCeilingTokens: number }>)
      .find((one) => one.id === scheduleId)!;
    assert.deepEqual([schedule.reserveTokens, schedule.runCeilingTokens], [1000, 120000]);
  } finally {
    await api.close();
  }
});
