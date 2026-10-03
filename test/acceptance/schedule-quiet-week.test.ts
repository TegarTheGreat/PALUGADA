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
import { withTenant } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
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
