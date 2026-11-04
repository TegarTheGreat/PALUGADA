/**
 * The weekly scorecard (F18.2, STATUS 2.191): measures reviewed every week,
 * each with a seat that owns it, a weekly goal, thirteen weeks of history and
 * a state for this week -- on track, off track, claimed, or not reported --
 * counted in the company's time zone. A measure may be paired with the one
 * that would suffer if it were pushed, and the two are always shown together.
 *
 * The scorecard is `goal_metrics` (0137), not a table of its own: a line is a
 * measure whose `review_every` is `week`, so it hangs from a goal like every
 * other measure, and its readings are the readings `metric.record` already
 * keeps, verified by the same read-back.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { buildContext } from '../../src/context/builder.ts';
import { changeMetric, defineMetric, metricsIn, recordObservation, scorecardOf } from '../../src/domain/metrics.ts';
import { ensureOutcomes } from '../../src/engine/outcomes.ts';
import { proposeGoalChange } from '../../src/domain/goals.ts';
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
function start(fixture: Fixture) {
  made += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `count the calls (${made})` },
    createdBy: 'owner', reserveTokens: 1_000,
  });
}

async function missionOf(fixture: Fixture): Promise<string> {
  const { rows } = await withTenant(fixture.companyId, (tx) =>
    tx.query<{ id: string }>("SELECT id FROM goals WHERE kind = 'mission'"));
  return rows[0]!.id;
}

/** A reading at a stated instant, as the owner's: the clock of `recordObservation` is the database's. */
async function readingAt(fixture: Fixture, metricId: string, value: number, at: string): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `INSERT INTO metric_observations (company_id, metric_id, value, observed_at, verified, recorded_by)
     VALUES ($1, $2, $3, $4, true, 'owner')`,
    [fixture.companyId, metricId, value, at]));
}

test('readings in two weeks land in the right buckets across a DST change', async () => {
  const fixture = await createCompany('scorecard-dst');
  // New York leaves daylight saving at 02:00 on Sunday 1 November 2026.
  await withControlPlane((tx) => tx.query("UPDATE companies SET timezone = 'America/New_York' WHERE id = $1", [fixture.companyId]));
  const calls = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50,
    reviewEvery: 'week', ownerRoleId: fixture.roleId,
  });
  const refunds = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'refunds', name: 'Refunds given', unit: 'count', direction: 'down', baseline: 10, target: 2,
    reviewEvery: 'week',
  });
  // A measure aimed at a target by a date is not a line on the scorecard.
  await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'mrr', name: 'Monthly recurring revenue', unit: 'currency', target: 10_000_000,
  });
  // Nor is a weekly one the owner retired.
  const dropped = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'demos', name: 'Demos booked', unit: 'count', target: 5, reviewEvery: 'week',
  });
  await changeMetric(fixture.companyId, dropped, { retired: true });

  // Monday 26 October, 00:30 in New York, still on daylight time (UTC-4). At
  // the offset New York has on the day the scorecard is read (UTC-5), it
  // would be Sunday the 25th, a week early.
  await readingAt(fixture, calls, 40, '2026-10-26T04:30:00Z');
  // Sunday 1 November, 23:30 in New York, after the change: in UTC it is
  // already Monday the 2nd, a week late.
  await readingAt(fixture, calls, 60, '2026-11-02T04:30:00Z');
  // Monday 2 November, 00:30 in New York: this week.
  await readingAt(fixture, calls, 30, '2026-11-02T05:30:00Z');
  await readingAt(fixture, refunds, 1, '2026-10-28T15:00:00Z');

  const now = new Date('2026-11-04T15:00:00Z');
  const card = await withTenant(fixture.companyId, (tx) => scorecardOf(tx, fixture.companyId, now));
  assert.equal(card.timezone, 'America/New_York');
  assert.equal(card.weeks.length, 13);
  assert.equal(card.weeks.at(-1), '2026-11-02', 'the weeks are ISO weeks, starting on a Monday where the company is');
  assert.equal(card.weeks[0], '2026-08-10');
  assert.deepEqual(card.lines.map((line) => line.slug), ['calls', 'refunds']);

  const line = card.lines.find((one) => one.slug === 'calls')!;
  assert.equal(line.ownerRole?.id, fixture.roleId);
  assert.equal(line.target, 50, "a line's target is its weekly goal");
  const week = (day: string) => line.weeks.find((one) => one.week === day)!;
  assert.deepEqual(week('2026-10-26'), { week: '2026-10-26', value: 60, verified: true, state: 'on_track' },
    "the week's last reading counts, and Sunday night belongs to the week that is ending");
  assert.deepEqual(week('2026-11-02'), { week: '2026-11-02', value: 30, verified: true, state: 'off_track' });
  assert.equal(week('2026-10-19').state, 'not_reported');
  assert.equal(line.state, 'off_track', "the line's state is this week's");

  // Lower is better: 1 refund against a goal of at most 2 is on track, and a
  // week with nothing reported is not reported, which is not off track.
  const fewer = card.lines.find((one) => one.slug === 'refunds')!;
  assert.equal(fewer.weeks.find((one) => one.week === '2026-10-26')!.state, 'on_track');
  assert.equal(fewer.state, 'not_reported');
  assert.equal(fewer.ownerRole, null, 'a line no seat owns says so');

  // Two lines are too few to run a company by; the owner is told, not refused.
  assert.deepEqual(card.warning, { kind: 'too_few', lines: 2, fewest: 5, most: 15 });
  for (let n = 0; n < 14; n += 1) {
    await defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug: `line-${n}`, name: `Line ${n}`, unit: 'count', target: 1, reviewEvery: 'week',
    });
  }
  const crowded = await withTenant(fixture.companyId, (tx) => scorecardOf(tx, fixture.companyId, now));
  assert.deepEqual(crowded.warning, { kind: 'too_many', lines: 16, fewest: 5, most: 15 });
});

test('an unverified agent reading shows as claimed', async () => {
  const fixture = await createCompany('scorecard-claimed');
  const other = await createCompany('scorecard-elsewhere');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const add = (body: Record<string, unknown>) =>
      api.call('POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}/metrics`, token, body);
    const made = await add({
      slug: 'leads', name: 'Qualified leads', unit: 'count', target: 20, sourceCapability: 'crm.read',
      reviewEvery: 'week', ownerRoleId: fixture.roleId,
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));

    // What the owner may not say about a line, and what is accepted instead.
    const monthly = await add({ slug: 'x', name: 'X', unit: 'count', target: 1, reviewEvery: 'month' });
    assert.equal(monthly.status, 400);
    assert.match(String(monthly.body.error), /reviewEvery must be week, or null/);
    const theirs = await add({ slug: 'y', name: 'Y', unit: 'count', target: 1, reviewEvery: 'week', ownerRoleId: other.roleId });
    assert.equal(theirs.status, 400);
    assert.match(String(theirs.body.error), /no such role in this company/);

    // A run reports 25 leads without reading them from the CRM: more than the
    // weekly goal, and still not on track, because nobody checked it.
    const run = await start(fixture);
    await transition(fixture.companyId, run.id, 'running');
    const claimed = await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
      companyId: fixture.companyId, metric: 'leads', value: 25, recordedBy: 'agent', taskId: run.id,
    }));
    assert.equal(claimed.verified, false);

    const read = async () => (await api.call('GET', `/api/companies/${fixture.companyId}/scorecard`, token)).body;
    const card = await read();
    assert.equal(card.lines.length, 1);
    const line = card.lines[0];
    assert.equal(line.ownerRole.id, fixture.roleId);
    assert.deepEqual(line.weeks.at(-1), { week: card.weeks.at(-1), value: 25, verified: false, state: 'claimed' });
    assert.equal(line.state, 'claimed');

    // The owner's own figure is verified by being theirs, and it is the one
    // the week is judged by.
    const entered = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${line.metricId}/observations`, token, { value: 18 });
    assert.equal(entered.status, 200);
    const judged = (await read()).lines[0];
    assert.deepEqual(judged.weeks.at(-1), { week: card.weeks.at(-1), value: 18, verified: true, state: 'off_track' });

    // A later claim does not overrule a verified figure in the same week.
    await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
      companyId: fixture.companyId, metric: 'leads', value: 40, recordedBy: 'agent', taskId: run.id,
    }));
    assert.equal((await read()).lines[0].state, 'off_track');

    // Taken off the scorecard, the measure stays; it is aimed at a target again.
    const off = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${line.metricId}`, token,
      { reviewEvery: null, ownerRoleId: null, proof: { totp: api.code() } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual((await read()).lines, []);
    const [kept] = await withTenant(fixture.companyId, (tx) => metricsIn(tx));
    assert.deepEqual({ reviewEvery: kept!.reviewEvery, ownerRoleId: kept!.ownerRoleId }, { reviewEvery: null, ownerRoleId: null });

    // The application role -- every agent -- cannot put itself on the
    // scorecard, own a line, or pair one.
    await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE goal_metrics SET review_every = 'week', owner_role_id = $1", [fixture.roleId])), /permission denied/);
  } finally {
    await api.close();
  }
});

test('a pair renders together', async () => {
  const fixture = await createCompany('scorecard-pair');
  const other = await createCompany('scorecard-pair-other');
  const mission = await missionOf(fixture);
  // Quantity under the objective, and the quality that would suffer if it
  // were pushed under the mission -- off the run's goal chain, and still told.
  const signups = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'signups', name: 'New sign-ups', unit: 'count', target: 100, reviewEvery: 'week',
  });
  const churn = await defineMetric(fixture.companyId, {
    goalId: mission, slug: 'churn', name: 'Sign-ups gone within a month', unit: 'percent', direction: 'down',
    baseline: 30, target: 10, reviewEvery: 'week', pairedWith: signups,
  });
  const visits = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'visits', name: 'Site visits', unit: 'count', target: 5_000, reviewEvery: 'week',
  });
  const theirs = await defineMetric(other.companyId, {
    goalId: other.goalId, slug: 'theirs', name: 'Theirs', unit: 'count', target: 1,
  });

  // A pair is mutual: naming one names the other.
  const pairs = async () => new Map((await withTenant(fixture.companyId, (tx) => metricsIn(tx)))
    .map((metric) => [metric.slug, metric.pairedWith]));
  assert.deepEqual(Object.fromEntries(await pairs()), { signups: churn, churn: signups, visits: null });

  // The run under the objective is told both, together, and to watch both.
  const run = await start(fixture);
  const told = async () => (await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: run.id })))
    .sections.find((section) => section.kind === 'goal_measure')!.body;
  const body = await told();
  assert.match(body,
    /- New sign-ups \[signups\]: reviewed every week against a weekly goal of 100 count, higher is better; no value recorded yet\.[^\n]*\n {2}Paired with Sign-ups gone within a month \[churn\] -- watch both[^\n]*\n {2}- Sign-ups gone within a month \[churn\]: reviewed every week against a weekly goal of 10 percent, lower is better/);
  assert.equal(body.match(/\[churn\]:/g)?.length, 1, 'the pair is told once, beside its partner');

  // And the scorecard puts them side by side, whatever order they were made in.
  const card = await withTenant(fixture.companyId, (tx) => scorecardOf(tx, fixture.companyId, new Date()));
  assert.deepEqual(card.lines.map((line) => [line.slug, line.pairedWith]), [
    ['signups', churn], ['churn', signups], ['visits', null],
  ]);

  // Pairing one anew lets go of its old partner, on both sides.
  await changeMetric(fixture.companyId, visits, { pairedWith: churn });
  assert.deepEqual(Object.fromEntries(await pairs()), { signups: null, churn: visits, visits: churn });

  // What a pair cannot be.
  const refused = (change: Promise<unknown>, pattern: RegExp) =>
    assert.rejects(change, (error: unknown) => isPalugadaError(error, 'contract.violation') && pattern.test((error as Error).message));
  await refused(changeMetric(fixture.companyId, visits, { pairedWith: visits }), /a measure cannot be paired with itself/);
  await refused(changeMetric(fixture.companyId, visits, { pairedWith: theirs }), /no measure .* in this company to pair with/);
  await changeMetric(fixture.companyId, signups, { retired: true });
  await refused(changeMetric(fixture.companyId, visits, { pairedWith: signups }), /signups is retired/);
  // Half a pair is refused by the database, whatever path writes it.
  await assert.rejects(withControlPlane((tx) => tx.query(
    'UPDATE goal_metrics SET paired_metric_id = NULL WHERE id = $1', [churn])), /a pair is mutual/);

  // Retiring a measure lets go of its partner, which is then unpaired again.
  await changeMetric(fixture.companyId, visits, { retired: true });
  assert.equal((await pairs()).get('churn'), null);
  assert.doesNotMatch(await told(), /Paired with/);
});

test('a week that meets its weekly goal is the rhythm, not a milestone', async () => {
  // The outcome sweep starts a task for the CEO when a measure reaches its
  // target. A weekly goal is met, or missed, every week: the weekly review
  // reads it, and a task each time would be a task about nothing new.
  const fixture = await createCompany('scorecard-no-milestone');
  const calls = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50, reviewEvery: 'week',
  });
  await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: calls, value: 55, recordedBy: 'owner',
  }));
  assert.equal(await ensureOutcomes(fixture.companyId), null);

  // Taken off the scorecard, the same number is a target reached.
  await changeMetric(fixture.companyId, calls, { reviewEvery: null });
  assert.ok(await ensureOutcomes(fixture.companyId));

  // Nor does a week short of its weekly goal stop the goal being proposed as
  // met: what a goal is met by is its targets, and a bad week is a bad week.
  const shortWeek = await createCompany('scorecard-short-week');
  await defineMetric(shortWeek.companyId, {
    goalId: shortWeek.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50, reviewEvery: 'week',
  });
  await withTenant(shortWeek.companyId, (tx) => recordObservation(tx, {
    companyId: shortWeek.companyId, metric: 'calls', value: 20, recordedBy: 'owner',
  }));
  const proposed = await proposeGoalChange({
    companyId: shortWeek.companyId, taskId: (await start(shortWeek)).id, goal: shortWeek.goalId, proposedStatus: 'met',
    rationale: 'The objective is done; the calls were a means.',
  });
  assert.equal(proposed.proposed, true);
});

test('the scorecard travels with the company', async () => {
  const fixture = await createCompany('scorecard-export');
  const calls = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50,
    reviewEvery: 'week', ownerRoleId: fixture.roleId,
  });
  await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'complaints', name: 'Complaints', unit: 'count', direction: 'down', baseline: 5, target: 1,
    reviewEvery: 'week', pairedWith: calls,
  });

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'scorecard-restored' });

  const metrics = await withTenant(restored.companyId, (tx) => metricsIn(tx));
  const bySlug = new Map(metrics.map((metric) => [metric.slug, metric]));
  const { rows: [seat] } = await withTenant(fixture.companyId, (tx) =>
    tx.query<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [fixture.roleId]));
  const { rows } = await withTenant(restored.companyId, (tx) =>
    tx.query<{ id: string }>('SELECT id FROM roles WHERE slug = $1', [seat!.slug]));
  assert.equal(bySlug.get('calls')!.reviewEvery, 'week');
  assert.equal(bySlug.get('calls')!.ownerRoleId, rows[0]!.id, 'the seat is the restored role, not the source');
  assert.equal(bySlug.get('calls')!.pairedWith, bySlug.get('complaints')!.id);
  assert.equal(bySlug.get('complaints')!.pairedWith, bySlug.get('calls')!.id);
});
