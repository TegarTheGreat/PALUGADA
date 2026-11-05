/**
 * PRD F11.3, F11.4, F9.4, F10.6, F18.12 -- cost, alerts, digest, retro and
 * the monthly money review.
 *
 * These are the instruments the owner steers by, so the properties that matter
 * are about trust rather than arithmetic: figures must not cross tenants, an
 * estimate must not be presented as a measurement, and an alert must not fire
 * so often that the inbox stops being read.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { costBreakdown, costTimeline, platformCost } from '../../src/reporting/cost.ts';
import { evaluateAlerts, setThresholds, thresholdsFor } from '../../src/reporting/alerts.ts';
import { buildDailyDigest, buildWeeklyRetro } from '../../src/reporting/digest.ts';
import { renderDailyDigest } from '../../src/owner/digest-said.ts';
import { traceFromInboxItem } from '../../src/reporting/trace.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createRootTask, outsideContentIn, transition } from '../../src/engine/tasks.ts';
import { ENDED_AFTER_MS, reportEndedBadly } from '../../src/engine/ended.ts';
import { evaluateSpendLimit, setSpendLimit } from '../../src/governance/spend-guard.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { addAccount, entryInput, postEntry } from '../../src/records/books.ts';
import { issueInvoice, payInvoice } from '../../src/records/invoices.ts';
import { buildMonthFacts, type MonthFacts } from '../../src/reporting/month.ts';
import { runDueSchedules, runScheduleNow, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup, runMigrationAgain } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** Seeds a finished task with a model trace attached, as a real run would leave. */
async function seedRun(
  fixture: Fixture,
  options: { status: 'completed' | 'failed' | 'halted'; costCents: number; haltReason?: string },
  index: number,
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO tasks (company_id, project_id, division_id, role_id, budget_account_id,
                          input, idempotency_key, input_hash, created_by, status,
                          halt_reason, finished_at)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,'h','owner',$7,$8, now())
       RETURNING id`,
      [
        fixture.companyId, fixture.projectId, fixture.divisionId, fixture.roleId,
        fixture.budgetAccountId, `run-${index}`, options.status, options.haltReason ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response,
                               input_tokens, output_tokens, cost_cents)
       VALUES ($1,$2,$3,'test-model','{}'::jsonb,'{}'::jsonb,100,50,$4)`,
      [`trace-${fixture.slug}-${index}`, fixture.companyId, rows[0]!.id, options.costCents],
    );
  });
}

test('cost breaks down by every dimension F11.3 names', async () => {
  const fixture = await createCompany('cost-dimensions');
  await seedRun(fixture, { status: 'completed', costCents: 120 }, 1);
  await seedRun(fixture, { status: 'completed', costCents: 80 }, 2);

  const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };

  for (const dimension of ['project', 'division', 'role'] as const) {
    const rows = await costBreakdown(fixture.companyId, dimension, window);
    assert.equal(rows.length, 1, `${dimension} should aggregate to one row here`);
    assert.equal(rows[0]!.costCents, 200);
    assert.equal(rows[0]!.tokens, 300);
    assert.equal(rows[0]!.calls, 2);
    assert.equal(rows[0]!.estimated, false, 'model spend is measured, not estimated');
  }

  const daily = await costTimeline(fixture.companyId, 'day', window);
  assert.equal(daily.length, 1);
  assert.equal(daily[0]!.costCents, 200);

  const monthly = await costTimeline(fixture.companyId, 'month', window);
  assert.equal(monthly.length, 1);
  assert.match(monthly[0]!.period, /^\d{4}-\d{2}$/);
});

/** Writes the cost event the broker leaves after a capability call (F8.5). */
async function seedCapabilityCost(
  fixture: Fixture,
  capability: string,
  estimatedCents: number,
  actualCents: number | null,
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO events (company_id, project_id, type, actor, payload)
       VALUES ($1, $2, 'tool.cost', 'broker', $3::jsonb)`,
      [
        fixture.companyId,
        fixture.projectId,
        JSON.stringify({ capability, estimatedCents, actualCents }),
      ],
    );
  });
}

test('a measured capability cost is reported as measured, and a fallback is not', async () => {
  // A dashboard that prints an estimate next to a measurement without saying
  // which is which teaches the owner to distrust all of it.
  //
  // This test replaces one that asserted `rows.every(...)` over a company with
  // no capability calls at all: the array was empty, `every` was vacuously
  // true, and the assertion held no matter what the reporting code did.
  const fixture = await createCompany('cost-estimates');
  await seedCapabilityCost(fixture, 'email.send', 100, 250);
  await seedCapabilityCost(fixture, 'email.send', 100, 50);
  await seedCapabilityCost(fixture, 'deploy.production', 40, null);
  await seedCapabilityCost(fixture, 'social.publish', 10, 10);
  await seedCapabilityCost(fixture, 'social.publish', 10, null);

  const rows = await costBreakdown(fixture.companyId, 'capability', {
    from: new Date(Date.now() - 86_400_000),
    to: new Date(Date.now() + 60_000),
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  const email = byKey.get('email.send')!;
  assert.equal(email.costCents, 300, 'both calls counted at what they were billed');
  assert.equal(email.calls, 2);
  assert.equal(email.estimated, false, 'every call in this row was measured');

  const deploy = byKey.get('deploy.production')!;
  assert.equal(deploy.costCents, 40, 'nothing measured it, so the charge stands as the figure');
  assert.equal(deploy.estimated, true);

  // One unmeasured call marks the whole row. Reporting 26 cents as measured
  // because most of it was would be the exact confusion the flag exists for.
  const social = byKey.get('social.publish')!;
  assert.equal(social.costCents, 20);
  assert.equal(social.estimated, true);
});

test('one company never sees another\'s cost', async () => {
  const mine = await createCompany('cost-mine');
  const theirs = await createCompany('cost-theirs');
  await seedRun(mine, { status: 'completed', costCents: 100 }, 1);
  await seedRun(theirs, { status: 'completed', costCents: 999 }, 1);

  const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };
  const rows = await costBreakdown(mine.companyId, 'division', window);
  assert.equal(rows.reduce((sum, row) => sum + row.costCents, 0), 100);

  // The platform view is the one deliberate cross-tenant read, and it returns
  // totals rather than rows.
  const platform = await platformCost(window);
  const bySlug = Object.fromEntries(platform.map((row) => [row.slug, row.costCents]));
  assert.equal(bySlug[mine.slug], 100);
  assert.equal(bySlug[theirs.slug], 999);
});

test('spend over the daily ceiling raises an alert once (F11.4)', async () => {
  const fixture = await createCompany('alert-cost');
  await setThresholds(fixture.companyId, { dailyCostCents: 150 });

  const thresholds = await thresholdsFor(fixture.companyId);
  assert.equal(thresholds.dailyCostCents, 150, 'a company override wins over the platform default');

  await seedRun(fixture, { status: 'completed', costCents: 200 }, 1);

  const first = await evaluateAlerts(fixture.companyId);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, 'daily_cost');
  assert.equal(first[0]!.observed, 200);

  // A sweep running every minute against a standing overspend must not produce
  // an inbox item every minute.
  const second = await evaluateAlerts(fixture.companyId);
  assert.equal(second.length, 0, 'the same condition alerts once per day');

  const alerts = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'budget_alert',
  );
  assert.equal(alerts.length, 1);
});

test('a failure rate needs a denominator worth dividing by', async () => {
  // Two failures out of two is a 100% failure rate and almost never worth
  // waking anyone over.
  const fixture = await createCompany('alert-smallsample');
  await setThresholds(fixture.companyId, { taskFailureRate: 0.2, dailyCostCents: 1_000_000 });

  await seedRun(fixture, { status: 'failed', costCents: 1 }, 1);
  await seedRun(fixture, { status: 'failed', costCents: 1 }, 2);

  const small = await evaluateAlerts(fixture.companyId);
  assert.equal(
    small.some((alert) => alert.kind === 'task_failure_rate'),
    false,
    'two of two is not a rate',
  );

  for (let i = 3; i <= 8; i += 1) {
    await seedRun(fixture, { status: i <= 5 ? 'failed' : 'completed', costCents: 1 }, i);
  }

  const raised = await evaluateAlerts(fixture.companyId);
  assert.equal(raised.some((alert) => alert.kind === 'task_failure_rate'), true);
});

/**
 * F8.4 and F8.12 each give the event its own card: a write that read back
 * differently halts its task and raises "External write failed verification"
 * with the task on it (engine.ts), and a capability that stops being usable
 * raises its own incident (preflight.ts), with the ended task's escalation
 * (ended.ts) behind it. The daily sweep raised a second urgent card for each,
 * pushed at the same moment, saying the same thing as a count. The card about
 * the event is the one the owner can act on, and it is the only one now.
 */
test('a failed read-back is one card, its own, and the daily sweep adds none (F8.4, F11.4)', async () => {
  const fixture = await createCompany('alert-verify');
  await setThresholds(fixture.companyId, { dailyCostCents: 1_000_000 });

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO events (company_id, project_id, type, actor, payload)
       VALUES ($1, $2, 'tool.verify_failed', 'agent_run', '{"capability":"dns.update"}'::jsonb)`,
      [fixture.companyId, fixture.projectId],
    );
  });

  assert.deepEqual(await evaluateAlerts(fixture.companyId), []);
  assert.deepEqual(await inbox.listOpen(fixture.companyId), [], 'no second card beside the one the halt raised');
});

test('a task a capability stopped is reported by its own card, not by a daily count (F8.12, F11.4)', async () => {
  const fixture = await createCompany('alert-preflight');
  await setThresholds(fixture.companyId, { dailyCostCents: 1_000_000 });

  const halted = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'post the weekly update' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, halted.id, 'halted', { haltReason: 'capability_unhealthy' });

  assert.deepEqual(await evaluateAlerts(fixture.companyId), []);
  assert.deepEqual(await inbox.listOpen(fixture.companyId), []);

  // Not silent: with no card about it, the task's own escalation is raised.
  assert.equal(await reportEndedBadly(fixture.companyId, new Date(Date.now() + ENDED_AFTER_MS + 60_000)), 1);
  const [ended] = await inbox.listOpen(fixture.companyId);
  assert.equal(ended!.taskId, halted.id);
});

/**
 * A run whose worker stopped talking has its task put back with its journal
 * (reclaimOrphans), and a task that keeps doing it is halted with its own
 * incident (haltIfCrashLooping). The daily incident in between asked nothing
 * of the owner, and as an incident it pushed through their window at any
 * hour: it is a line of the digest now.
 */
test('an orphaned run is a line of the digest, not an incident (F11.4, F5.14, F10.6)', async () => {
  const fixture = await createCompany('alert-orphan');
  await setThresholds(fixture.companyId, { dailyCostCents: 1_000_000 });

  await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO tasks
         (company_id, project_id, division_id, role_id, budget_account_id, input,
          input_hash, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'h','orphan-1','owner')
       RETURNING id`,
      [
        fixture.companyId, fixture.projectId, fixture.divisionId, fixture.roleId,
        fixture.budgetAccountId,
      ],
    );
    await tx.query(
      `INSERT INTO agent_runs
         (company_id, task_id, role_id, attempt, status, finished_at)
       VALUES ($1, $2, $3, 1, 'orphaned', now())`,
      [fixture.companyId, rows[0]!.id, fixture.roleId],
    );
  });

  assert.deepEqual(await evaluateAlerts(fixture.companyId), []);
  assert.deepEqual(await inbox.listOpen(fixture.companyId), []);

  const digest = await buildDailyDigest(fixture.companyId);
  assert.equal(digest.orphanedRuns, 1);
  assert.match(renderDailyDigest(digest, 'en'), /^Runs picked up again after their worker stopped: 1$/m);
  assert.match(renderDailyDigest(digest, 'id'), /^Run yang dilanjutkan lagi setelah worker-nya berhenti: 1$/m);

  // A day with none says nothing about it.
  const quiet = await buildDailyDigest(fixture.companyId, new Date(Date.now() - 2 * 86_400_000));
  assert.equal(quiet.orphanedRuns, 0);
  assert.doesNotMatch(renderDailyDigest(quiet, 'en'), /worker stopped/);
});

/**
 * "Model spend today is over the ceiling" is about its day. Nothing closed it,
 * so every busy day left one more card that asked nothing and that nobody
 * could act on. It closes itself -- but not at midnight. A card carried late
 * in its day has barely reached the owner by then: on a deployment whose
 * owner is reached from 08:00 to 22:00, a breach carried at 21:55 was gone at
 * 00:00, its chat message rewritten, before the owner's next morning; an
 * owner in Jakarta, whose 08:00-22:00 is 01:00-15:00 UTC, lost at 07:00
 * whatever they had heard of the evening before. A card stays a whole day
 * after it was put in front of the owner -- carried to them, or back from
 * being put off -- because a day holds the whole of the owner's window
 * wherever their hours fall against UTC, and closes at the first look after.
 */
test("a day's card closes itself once it has been in front of the owner a whole day (F11.4)", async () => {
  const fixture = await createCompany('alert-day-ended');
  await setThresholds(fixture.companyId, { dailyCostCents: 150 });
  const start = Date.UTC(2026, 8, 1);
  const at = (hours: number) => new Date(start + hours * 3_600_000);
  const trace = (id: string, when: Date) => withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO llm_traces (id, company_id, model, prompt, response, input_tokens, output_tokens, cost_cents, occurred_at)
     VALUES ($1, $2, 'test-model', '{}'::jsonb, '{}'::jsonb, 100, 50, 300, $3)`,
    [id, fixture.companyId, when]));
  const carried = (itemId: string, when: Date) => withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE inbox_items SET notify_after = $2 WHERE id = $1', [itemId, when]));
  const card = async (itemId: string) => (await withTenant(fixture.companyId, (tx) => tx.query<{
    status: string; closed_reason: string | null; payload: { alert?: string; day?: string };
  }>('SELECT status, closed_reason, payload FROM inbox_items WHERE id = $1', [itemId]))).rows[0]!;
  const withdrawn = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { inboxItemId: string; closedReason: string } }>(
    "SELECT payload FROM events WHERE type = 'inbox.withdrawn' ORDER BY occurred_at"))).rows
    .map((row) => [row.payload.inboxItemId, row.payload.closedReason]);

  await trace('trace-first-day', at(12));
  const [first] = await evaluateAlerts(fixture.companyId, at(12));
  assert.equal(first!.kind, 'daily_cost');
  assert.deepEqual((await card(first!.inboxItemId)).payload, { alert: 'daily_cost', day: '2026-09-01' },
    'it says which day it is about');
  await carried(first!.inboxItemId, at(21 + 55 / 60));

  // Five minutes after its day ended, and the owner asleep since 22:00.
  assert.deepEqual(await evaluateAlerts(fixture.companyId, at(24 + 5 / 60)), []);
  assert.equal((await card(first!.inboxItemId)).status, 'open', 'the first look after its day leaves it');

  await trace('trace-second-day', at(36));
  const [second] = await evaluateAlerts(fixture.companyId, at(36));
  assert.deepEqual((await card(second!.inboxItemId)).payload, { alert: 'daily_cost', day: '2026-09-02' });
  await carried(second!.inboxItemId, at(36));

  // The next evening, five minutes short of a whole day since it was carried.
  await evaluateAlerts(fixture.companyId, at(45 + 50 / 60));
  assert.equal((await card(first!.inboxItemId)).status, 'open', 'kept a whole day after it was carried');

  // Put off by the owner until two in the morning: a whole day from then.
  await withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE inbox_items SET snoozed_until = $2 WHERE id = $1', [first!.inboxItemId, at(50)]));
  await evaluateAlerts(fixture.companyId, at(59));
  assert.equal((await card(first!.inboxItemId)).status, 'open', 'a card the owner put off has its day once it is back');
  assert.deepEqual(await withdrawn(), []);

  // Not put off: the first day's closes, the second day's has not had its day yet.
  await withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE inbox_items SET snoozed_until = NULL WHERE id = $1', [first!.inboxItemId]));
  await evaluateAlerts(fixture.companyId, at(59));
  const closed = await card(first!.inboxItemId);
  assert.deepEqual([closed.status, closed.closed_reason], ['withdrawn', 'day_ended']);
  assert.deepEqual(await withdrawn(), [[first!.inboxItemId, 'day_ended']]);
  assert.deepEqual((await inbox.listOpen(fixture.companyId)).map((item) => item.id), [second!.inboxItemId]);

  // A second look closes nothing twice; a whole day on, the second day's goes.
  await evaluateAlerts(fixture.companyId, at(59));
  assert.deepEqual(await withdrawn(), [[first!.inboxItemId, 'day_ended']]);
  await evaluateAlerts(fixture.companyId, at(60));
  assert.deepEqual(await withdrawn(), [[first!.inboxItemId, 'day_ended'], [second!.inboxItemId, 'day_ended']]);
});

/**
 * The cards raised before a day's card said its day (0135). The code before it
 * left the payload empty, and the close reads the day from it: a deployment
 * upgraded with a month of them open kept them all. The daily counts it raised
 * as incidents -- read-backs that failed, checks that failed, workers that
 * stopped -- are raised no more, each said where it can be acted on, and
 * nothing would ever close one left open.
 */
test("a day's card or count raised before the cards said their day closes after the upgrade (F11.4, 0135)", async () => {
  const fixture = await createCompany('alert-before-0135');
  const raisedAt = new Date(Date.UTC(2026, 8, 1, 12));
  const asRaised = async (kind: string, itemId: string) => {
    await withControlPlane((tx) => tx.query(
      'UPDATE inbox_items SET created_at = $2, notify_after = $2 WHERE id = $1', [itemId, raisedAt]));
    await withTenant(fixture.companyId, (tx) => tx.query(
      `INSERT INTO events (company_id, type, actor, payload)
       VALUES ($1, 'alert.raised', 'system', jsonb_build_object('kind', $2::text, 'inboxItemId', $3::text))`,
      [fixture.companyId, kind, itemId]));
    return itemId;
  };
  const spend = await asRaised('daily_cost', await inbox.raiseBudgetAlert({
    companyId: fixture.companyId, title: 'Daily model spend over threshold', detail: 'Model spend today is 300 cents.',
  }));
  const count = await asRaised('preflight_failures', await inbox.raiseIncident({
    companyId: fixture.companyId, title: 'Tasks could not start', detail: '2 tasks could not start today.',
  }));
  // Neither is touched: an incident no alert raised, and a day's card that says its day.
  const other = await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Something broke', detail: 'x' });
  const said = await asRaised('policy_denials', await inbox.raiseBudgetAlert({
    companyId: fixture.companyId, title: 'Many actions refused', detail: '25 refused.', payload: { alert: 'policy_denials', day: '2026-09-02' },
  }));
  const card = async (itemId: string) => (await withTenant(fixture.companyId, (tx) => tx.query<{
    status: string; closed_reason: string | null; payload: Record<string, unknown>;
  }>('SELECT status, closed_reason, payload FROM inbox_items WHERE id = $1', [itemId]))).rows[0]!;

  await runMigrationAgain('0135_old_cards_name_their_period.sql');

  assert.deepEqual((await card(spend)).payload, { alert: 'daily_cost', day: '2026-09-01' }, 'it says the day it was raised on');
  assert.deepEqual((await card(said)).payload, { alert: 'policy_denials', day: '2026-09-02' });
  const closed = await card(count);
  assert.deepEqual([closed.status, closed.closed_reason], ['withdrawn', 'day_ended'], 'a daily count nothing raises any more');
  assert.equal((await card(other)).status, 'open');
  const withdrawn = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { inboxItemId: string; closedReason: string } }>(
    "SELECT payload FROM events WHERE type = 'inbox.withdrawn' ORDER BY occurred_at"))).rows
    .map((row) => [row.payload.inboxItemId, row.payload.closedReason]);
  assert.deepEqual(await withdrawn(), [[count, 'day_ended']], 'and its timeline says so');

  // Run twice, it does nothing twice.
  await runMigrationAgain('0135_old_cards_name_their_period.sql');
  assert.deepEqual(await withdrawn(), [[count, 'day_ended']]);

  // The close the new cards have reaches the old one: a whole day after it was carried.
  await evaluateAlerts(fixture.companyId, new Date(Date.UTC(2026, 8, 3)));
  assert.deepEqual([(await card(spend)).status, (await card(spend)).closed_reason], ['withdrawn', 'day_ended']);
});

/**
 * An archive written before 0135 carries the same cards in the old shape, and
 * arrives at a deployment that ran 0135 long before: restored as they were,
 * they stayed open for good. The alert that raised each is named only in the
 * archive's events, by the id the card had there, which the restore changes.
 */
test("a day's card, count or 80% warning restored from an archive written before 0135 closes as one raised here does (F11.4, F1.7, F16.4)", async () => {
  const fixture = await createCompany('alert-archive-0135');
  const raisedAt = new Date(Date.UTC(2026, 8, 1, 12));
  const asRaised = async (itemId: string, kind?: string) => {
    await withControlPlane((tx) => tx.query(
      'UPDATE inbox_items SET created_at = $2, notify_after = $2 WHERE id = $1', [itemId, raisedAt]));
    if (kind) {
      await withTenant(fixture.companyId, (tx) => tx.query(
        `INSERT INTO events (company_id, type, actor, payload)
         VALUES ($1, 'alert.raised', 'system', jsonb_build_object('kind', $2::text, 'inboxItemId', $3::text))`,
        [fixture.companyId, kind, itemId]));
    }
  };
  await asRaised(await inbox.raiseBudgetAlert({
    companyId: fixture.companyId, title: 'Daily model spend over threshold', detail: 'Model spend today is 300 cents.',
  }), 'daily_cost');
  await asRaised(await inbox.raiseIncident({
    companyId: fixture.companyId, title: 'Tasks could not start', detail: '2 tasks could not start today.',
  }), 'preflight_failures');
  await asRaised(await inbox.raiseBudgetAlert({ companyId: fixture.companyId, title: 'Monthly budget is 80% spent', detail: '$165.00 of $200.00 spent.' }));
  // Neither is touched: the pause card raised before it said its month, and an incident no alert raised.
  await asRaised(await inbox.raiseBudgetAlert({ companyId: fixture.companyId, title: 'Monthly budget reached; the company is paused', detail: 'x' }));
  await asRaised(await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Something broke', detail: 'x' }));

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  assert.ok(lines.filter((line) => line.section === 'inbox_items').every((line) => JSON.stringify(line.row.payload) === '{}'),
    'the archive carries them as the code before 0135 wrote them');
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });

  const cards = async () => Object.fromEntries((await withTenant(restored.companyId, (tx) => tx.query<{
    id: string; title: string; status: string; closed_reason: string | null; payload: Record<string, unknown>;
  }>('SELECT id, title, status, closed_reason, payload FROM inbox_items'))).rows
    .map(({ title, ...row }) => [title, row]));
  const restoredCards = await cards();
  const countId = restoredCards['Tasks could not start']!.id;
  assert.deepEqual(
    Object.fromEntries(Object.entries(restoredCards).map(([title, { id: _id, ...row }]) => [title, row])),
    {
      'Daily model spend over threshold': { status: 'open', closed_reason: null, payload: { alert: 'daily_cost', day: '2026-09-01' } },
      'Monthly budget is 80% spent': { status: 'open', closed_reason: null, payload: { spendWarning: { periodStart: '2026-09-01T00:00:00.000Z' } } },
      'Monthly budget reached; the company is paused': { status: 'open', closed_reason: null, payload: {} },
      'Something broke': { status: 'open', closed_reason: null, payload: {} },
      'Tasks could not start': { status: 'withdrawn', closed_reason: 'day_ended', payload: {} },
    },
    'each is labelled as 0135 labelled a card already here, and the daily count nothing raises any more is closed',
  );
  const withdrawn = (await withTenant(restored.companyId, (tx) => tx.query<{ payload: { inboxItemId: string; closedReason: string } }>(
    "SELECT payload FROM events WHERE type = 'inbox.withdrawn'"))).rows.map((row) => [row.payload.inboxItemId, row.payload.closedReason]);
  assert.deepEqual(withdrawn, [[countId, 'day_ended']], 'and the restored timeline says so');

  // The closes the new cards have reach the restored ones.
  await evaluateAlerts(restored.companyId, new Date(Date.UTC(2026, 8, 3)));
  await evaluateSpendLimit(restored.companyId, new Date(Date.UTC(2026, 9, 2)));
  const after = await cards();
  assert.deepEqual([after['Daily model spend over threshold']!.status, after['Daily model spend over threshold']!.closed_reason], ['withdrawn', 'day_ended']);
  assert.deepEqual([after['Monthly budget is 80% spent']!.status, after['Monthly budget is 80% spent']!.closed_reason], ['withdrawn', 'period_started']);
});

test('the daily digest fits one screen (F10.6)', async () => {
  const fixture = await createCompany('digest');
  await seedRun(fixture, { status: 'completed', costCents: 150 }, 1);
  await seedRun(fixture, { status: 'completed', costCents: 50 }, 2);
  await seedRun(fixture, { status: 'failed', costCents: 10 }, 3);
  await seedRun(fixture, { status: 'halted', costCents: 5, haltReason: 'budget_exhausted' }, 4);
  await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Something broke', detail: 'x' });

  const digest = await buildDailyDigest(fixture.companyId);
  assert.equal(digest.moneySpentCents, 215);
  assert.equal(digest.tasksCompleted, 2);
  assert.equal(digest.tasksFailed, 1);
  assert.equal(digest.tasksHalted, 1);
  assert.equal(digest.openIncidents, 1);
  assert.deepEqual(digest.stopped, [{ reason: 'budget_exhausted', count: 1 }]);

  const rendered = renderDailyDigest(digest, 'en');
  const lines = rendered.split('\n');
  assert.ok(lines.length <= 12, `the digest must fit one screen, got ${lines.length} lines`);
  assert.ok(lines.every((line) => line.length <= 100));
  assert.match(rendered, /Spent: \$2\.15/, 'in dollars, and saying so');
  assert.match(rendered, /Stopped \(1\): Out of budget/, 'a halt by what it means, not its code');

  // The owner's language, as everything else the platform tells them
  // (§2.3 item 7): the digest was English, with "budget_exhausted" in it.
  const indonesian = renderDailyDigest(digest, 'id');
  assert.match(indonesian, /US\$2,15/);
  assert.match(indonesian, /Kehabisan anggaran/);
  assert.doesNotMatch(indonesian, /budget_exhausted|Digest|Spent|Stopped/);
});

test('the digest reports what stopped, not what worked', async () => {
  // Screen space spent on reassurance is screen space not spent on the thing
  // that needs a decision.
  const fixture = await createCompany('digest-highlights');
  for (let i = 1; i <= 6; i += 1) {
    await seedRun(fixture, { status: 'completed', costCents: 1 }, i);
  }

  const digest = await buildDailyDigest(fixture.companyId);
  assert.equal(digest.tasksCompleted, 6);
  assert.deepEqual(digest.stopped, [], 'a quiet, successful day has nothing to highlight');
});

test('the weekly retro reports the learning signals (F9.4)', async () => {
  const fixture = await createCompany('retro');
  await seedRun(fixture, { status: 'completed', costCents: 100 }, 1);
  await seedRun(fixture, { status: 'halted', costCents: 20, haltReason: 'hop_limit' }, 2);

  // A candidate SOP awaiting the owner, and a recorded decision: section 11's
  // indicators that the company is learning rather than only running.
  const candidate = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO memories (company_id, memory_type, scope_type, scope_id, body,
                           approval_state, fact_kind, source)
     VALUES ($1, 'procedural', 'division', $2, 'A proposed SOP', 'candidate',
             'sop_candidate', 'pattern:deploy.staging') RETURNING id`,
    [fixture.companyId, fixture.divisionId])).rows[0]!.id);
  // Awaiting the owner means a card in front of them (the audit of 6 October, M9).
  await inbox.proposeSop({ companyId: fixture.companyId, memoryId: candidate, title: 'A proposed SOP', body: 'A proposed SOP', occurrences: 3 });
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO decision_records (company_id, project_id, proposal, decision, criteria)
       VALUES ($1, $2, '{}'::jsonb, 'approve', 'was it accurate')`,
      [fixture.companyId, fixture.projectId],
    );
  });

  const retro = await buildWeeklyRetro(fixture.companyId);
  assert.equal(retro.tasksCompleted, 1);
  assert.equal(retro.tasksStopped, 1);
  assert.equal(retro.moneySpentCents, 120);
  assert.equal(retro.sopCandidatesPending, 1);
  assert.equal(retro.decisionsRecorded, 1);
  assert.equal(retro.costliestDivisions.length, 1);
  assert.equal(retro.costliestDivisions[0]!.costCents, 120);
});

/**
 * F11.2: the trace behind an inbox item, reached from the item.
 *
 * This requirement had been written off. `docs/STATUS.md` recorded it in four
 * places as "no owner PWA, so no live run view" and filed it under not built —
 * and F11.2 says none of that. It says "trace dari item inbox ≤ 2 klik": the
 * trace behind an item must be *reachable* from it, in at most two hops. That
 * is a claim about the data, and it was false for a different reason than the
 * one written down: `inbox_items.task_id` and `llm_traces.task_id` had been one
 * join apart since the schema was written and nothing joined them.
 *
 * What is asserted here is the reachability, because that is the part that can
 * be observed from this side: the item id alone, one call, and the model call
 * comes back with its prompt. Nobody can count clicks from a test, and
 * pretending to would be the same over-claim in a different direction.
 */
test('an inbox item reaches the model call behind it (F11.2)', async () => {
  const fixture = await createCompany('trace-reach');

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    goalId: fixture.goalId,
    input: { ask: 'send the invoice' },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });

  // An approval arises mid-run, and `requestApproval` parks the task -- which is
  // only legal from `running`. Moved here rather than worked around, because a
  // test that reached `waiting_approval` from `pending` would be exercising a
  // path the engine does not have.
  await transition(fixture.companyId, task.id, 'running');

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response,
                               input_tokens, output_tokens, cost_cents, latency_ms)
       VALUES ($1,$2,$3,'deep-model',$4,$5,900,120,42,3100)`,
      [
        `trace-reach-1`,
        fixture.companyId,
        task.id,
        JSON.stringify({ system: 'You issue invoices.', ask: 'send the invoice' }),
        JSON.stringify({ text: 'I propose sending it to acme.test' }),
      ],
    );
  });

  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    actionSummary: 'invoice.issue for 1 recipient',
    rationale: 'the plan says one invoice and this is it',
    tier: 2,
    estimatedCostCents: 42,
    consequenceIfDenied: 'the customer is not billed this month',
    capabilityName: 'invoice.issue',
  });

  // One call, from the item id, with nothing else to hand.
  const trace = await traceFromInboxItem(fixture.companyId, itemId, { includePrompts: true });
  assert.ok(trace, 'the item was found');
  assert.equal(trace.taskId, task.id);
  assert.equal(trace.tier, 2);
  assert.equal(trace.calls.length, 1);
  assert.equal(trace.calls[0]!.model, 'deep-model');
  assert.equal(trace.calls[0]!.costCents, 42);
  assert.equal(trace.calls[0]!.latencyMs, 3100);
  assert.deepEqual(trace.calls[0]!.prompt, {
    system: 'You issue invoices.',
    ask: 'send the invoice',
  });

  // And the default answer is the smaller one: F11.5 keeps a trace for a year
  // and a prompt for ninety days, so the prompt is asked for rather than given.
  const without = await traceFromInboxItem(fixture.companyId, itemId);
  assert.equal('prompt' in without!.calls[0]!, false, 'a prompt nobody asked for');
  assert.equal(without!.calls[0]!.costCents, 42, 'but the cost, which an audit needs');
});

test('an item with nothing behind it says so, rather than looking empty', async () => {
  const fixture = await createCompany('trace-no-task');
  await inbox.raiseBudgetAlert({
    companyId: fixture.companyId,
    title: 'eighty percent of the month is spent',
    detail: 'at the current rate the ceiling lands on the 24th',
  });
  const [item] = await inbox.listOpen(fixture.companyId);

  const trace = await traceFromInboxItem(fixture.companyId, item!.id);
  assert.equal(trace!.taskId, null);
  assert.deepEqual(trace!.calls, []);
  // The distinction that matters: no trace because there was never a run, not
  // no trace because retention took it or a query missed it.
  assert.match(trace!.reason ?? '', /not about one task/);
});

test('one company cannot trace another\'s inbox item (F1.3, F11.2)', async () => {
  const mine = await createCompany('trace-mine');
  const theirs = await createCompany('trace-theirs');

  await inbox.raiseIncident({
    companyId: theirs.companyId,
    title: 'their incident',
    detail: 'nothing to do with me',
  });
  const [item] = await inbox.listOpen(theirs.companyId);

  // Row-level security confines the lookup, so the answer is "no such item"
  // rather than "an item you may not read" -- which is the right answer,
  // because the second one confirms it exists.
  assert.equal(await traceFromInboxItem(mine.companyId, item!.id), null);
});

/* --------------------------------------------- the monthly money review --- */

/** Posts an entry the owner wrote: a day, a memo and its lines by account code, in IDR. */
async function post(fixture: Fixture, date: string, memo: string, lines: Array<[string, 'dr' | 'cr', number]>): Promise<void> {
  await withTenant(fixture.companyId, (tx) => postEntry(tx, fixture.companyId, entryInput({
    date, memo, currency: 'IDR',
    lines: lines.map(([account, side, cents]) => (side === 'dr' ? { account, debitCents: cents } : { account, creditCents: cents })),
  }), 'owner'));
}

/**
 * F18.12, F9.4: the month's money, read from the company's own books.
 *
 * A trading company's September: an owner's capital and a cash sale in
 * August, then stock bought on credit, two sales invoiced -- one paid into
 * a second bank account, one written by work that had read an email and
 * still owed -- goods sold out of stock, and the rent. Every figure is the
 * books' own, and each lever is what one per cent or one day is worth on
 * them. A company whose chart keeps no cost of goods or stock gets those
 * levers marked as such, not a number made up from the rest.
 */
test('the monthly money review is read from the books: profit, cash, what is late, spend and the levers (F18.12)', async () => {
  const fixture = await createCompany('money-month');
  await withControlPlane((tx) => tx.query("UPDATE companies SET timezone = 'Asia/Jakarta' WHERE id = $1", [fixture.companyId]));
  await withTenant(fixture.companyId, async (tx) => {
    await addAccount(tx, fixture.companyId, { code: '1110', name: 'Bank BCA', kind: 'asset' });
    await addAccount(tx, fixture.companyId, { code: '1300', name: 'Stock', kind: 'asset' });
    await addAccount(tx, fixture.companyId, { code: '5000', name: 'Cost of goods sold', kind: 'expense' });
  });
  await post(fixture, '2026-08-01', 'Owner capital', [['1100', 'dr', 10_000_000], ['3100', 'cr', 10_000_000]]);
  await post(fixture, '2026-08-20', 'Cash sale', [['1100', 'dr', 1_000_000], ['4100', 'cr', 1_000_000]]);
  await post(fixture, '2026-09-02', 'Stock bought on credit', [['1300', 'dr', 3_000_000], ['2100', 'cr', 3_000_000]]);
  const late = await withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, {
    customerName: 'Toko Kopi Senja', currency: 'IDR', issueDate: '2026-09-05', dueDate: '2026-09-15',
    lines: [{ description: 'Biji kopi', quantity: 1, unitCents: 5_000_000 }],
  }, 'agent', { outside: true }));
  const paid = await withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, {
    customerName: 'Warung Pak Budi', currency: 'IDR', issueDate: '2026-09-10', dueDate: '2026-09-24',
    lines: [{ description: 'Biji kopi', quantity: 1, unitCents: 5_000_000 }],
  }, 'owner'));
  await withTenant(fixture.companyId, (tx) => payInvoice(tx, fixture.companyId, paid.number,
    { amountCents: 5_000_000, date: '2026-09-20', depositTo: '1110' }, 'owner'));
  await post(fixture, '2026-09-12', 'Goods sold out of stock', [['5000', 'dr', 2_000_000], ['1300', 'cr', 2_000_000]]);
  await post(fixture, '2026-09-15', 'Rent', [['5100', 'dr', 1_500_000], ['1100', 'cr', 1_500_000]]);
  // The day after the month: not the month's.
  await post(fixture, '2026-10-01', 'Cash sale', [['1100', 'dr', 7_000_000], ['4100', 'cr', 7_000_000]]);
  await withTenant(fixture.companyId, async (tx) => {
    for (const [id, at, cents] of [['september', '2026-09-18T03:00:00Z', 2_500], ['august', '2026-08-18T03:00:00Z', 1_000]] as const) {
      await tx.query(
        `INSERT INTO llm_traces (id, company_id, model, prompt, cost_cents, occurred_at)
         VALUES ($1, $2, 'test-model', '{}'::jsonb, $3, $4)`, [`money-${id}-${fixture.slug}`, fixture.companyId, cents, at]);
    }
  });

  await setSpendLimit(fixture.companyId, 50_000);
  await readsTheBooks(fixture);

  // The first of October, ten to eight in Jakarta: September is reviewed.
  const facts = await buildMonthFacts(fixture.companyId, fixture.roleId, new Date('2026-10-01T00:50:00Z'));
  assert.deepEqual([facts.month, facts.from, facts.to, facts.days], ['2026-09', '2026-09-01', '2026-09-30', 30]);
  assert.deepEqual(facts.spend, { monthCents: 2_500, previousMonthCents: 1_000, limitCents: 50_000 });
  assert.equal(facts.books.length, 1, 'one currency');
  const idr = facts.books[0]!;
  assert.deepEqual(
    {
      currency: idr.currency, income: idr.incomeCents, costOfGoods: idr.costOfGoodsCents, overhead: idr.overheadCents,
      profit: idr.profitCents, previous: idr.previous, cash: idr.cash,
      receivable: idr.receivableCents, payable: idr.payableCents, stock: idr.stockCents, overdue: idr.overdueCents,
      days: [idr.receivableDays, idr.stockDays, idr.payableDays],
    },
    {
      currency: 'IDR', income: 10_000_000, costOfGoods: 2_000_000, overhead: 1_500_000, profit: 6_500_000,
      previous: { incomeCents: 1_000_000, expenseCents: 0, profitCents: 1_000_000 },
      // Both bank accounts are cash: 1100 and the 1110 the owner added.
      cash: { startCents: 11_000_000, endCents: 14_500_000, changeCents: 3_500_000 },
      receivable: 5_000_000, payable: 3_000_000, stock: 1_000_000, overdue: 5_000_000,
      days: [15, 15, 45],
    },
  );
  assert.deepEqual(idr.levers.map((lever) => [lever.lever, lever.effect, lever.cents, lever.unavailable]), [
    ['price', 'profit', 100_000, null],
    ['volume', 'profit', 80_000, null],
    ['cost_of_goods', 'profit', 20_000, null],
    ['overhead', 'profit', 15_000, null],
    ['receivable_days', 'cash', 333_333, null],
    ['stock_days', 'cash', 66_667, null],
    ['payable_days', 'cash', 66_667, null],
  ]);

  // Late, by sixteen days on the first of October, and in words written
  // after reading an email: data, and the review carries that.
  assert.equal(facts.overdue.invoices.length, 1);
  const owed = facts.overdue.invoices[0]!;
  assert.deepEqual([owed.number, owed.dueDate, owed.daysOverdue, owed.outstandingCents, owed.outside],
    [late.number, '2026-09-15', 16, 5_000_000, true]);
  assert.match(owed.customer, /UNTRUSTED_CONTENT[\s\S]*Toko Kopi Senja/);
  assert.equal(facts.overdue.leftOut, 0);

  // A service company's books: no account for cost of goods or stock, so the
  // levers that need them say so rather than guess.
  const service = await createCompany('money-month-service');
  await post(service, '2026-09-03', 'Consulting, paid at once', [['1100', 'dr', 2_000_000], ['4100', 'cr', 2_000_000]]);
  await post(service, '2026-09-04', 'Software', [['5100', 'dr', 500_000], ['1100', 'cr', 500_000]]);
  await readsTheBooks(service);
  const plain = (await buildMonthFacts(service.companyId, service.roleId, new Date('2026-10-01T09:00:00Z'))).books[0]!;
  assert.deepEqual([plain.costOfGoodsCents, plain.stockCents, plain.overheadCents, plain.receivableDays], [null, null, 500_000, 0]);
  assert.deepEqual(plain.levers.map((lever) => [lever.lever, lever.cents, lever.unavailable]), [
    ['price', 20_000, null],
    ['volume', null, 'no_cost_of_goods_account'],
    ['cost_of_goods', null, 'no_cost_of_goods_account'],
    ['overhead', 5_000, null],
    ['receivable_days', 66_667, null],
    ['stock_days', null, 'no_stock_account'],
    ['payable_days', null, 'no_cost_of_goods_account'],
  ]);
  assert.ok(JSON.stringify(facts).length < 16_000, 'it travels with every step of the run');
});

/** The last whole month, as a company in Jakarta (no daylight saving) counts it today. */
function lastMonthInJakarta(): { month: string; day: string } {
  const here = new Date(Date.now() + 7 * 3_600_000);
  const lastDay = new Date(Date.UTC(here.getUTCFullYear(), here.getUTCMonth(), 1) - 86_400_000).toISOString().slice(0, 10);
  return { month: lastDay.slice(0, 7), day: lastDay };
}

/**
 * The month is the company's books, and the books are read through
 * `ledger.read`: the role a review is for holds the tool, and its division
 * the grant, as the operating kit's strategist does.
 */
async function readsTheBooks(fixture: Fixture): Promise<void> {
  await registerStandardCatalogue();
  await grantCapability(fixture, 'ledger.read');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET tools = array_append(tools, 'ledger.read') WHERE id = $1", [fixture.roleId]));
}

async function moneyReview(fixture: Fixture, options: { readsTheBooks?: boolean } = {}): Promise<string> {
  if (options.readsTheBooks !== false) await readsTheBooks(fixture);
  await withControlPlane((tx) => tx.query("UPDATE companies SET timezone = 'Asia/Jakarta' WHERE id = $1", [fixture.companyId]));
  const scheduleId = await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'monthly-review', cronExpression: '50 7 1 * *', timezone: 'Asia/Jakarta',
    input: { goal: 'Monthly money review.', facts: 'month' },
  });
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE schedules SET next_run_at = date_trunc('milliseconds', now() - interval '1 minute') WHERE id = $1", [scheduleId]));
  return scheduleId;
}

/**
 * F18.12: "a month with no numbers is passed over". A company whose books
 * had nothing dated in the month and nothing owed and late has nothing for
 * a money review to read, and a review of it would spend tokens finding
 * something to say (N10). The occurrence is passed over and said; the owner's
 * "Run now" runs it all the same.
 */
test('a quiet month is passed over, and a month with money in it is reviewed with its facts (F18.12, N10)', async () => {
  const { month, day } = lastMonthInJakarta();

  const quiet = await createCompany('money-quiet');
  const quietReview = await moneyReview(quiet);
  // Long before the month: a sale, not late, all paid. Nothing of it is the month's.
  await post(quiet, '2020-01-10', 'Cash sale', [['1100', 'dr', 1_000], ['4100', 'cr', 1_000]]);
  assert.deepEqual(await runDueSchedules(), [], 'nothing was made');
  const { rows: said } = await withTenant(quiet.companyId, (tx) => tx.query<{ payload: { slug: string; month: string } }>(
    "SELECT payload FROM events WHERE type = 'schedule.quiet_month' AND payload->>'scheduleId' = $1", [quietReview]));
  assert.deepEqual(said.map((one) => [one.payload.slug, one.payload.month]), [['monthly-review', month]], 'said once, naming the month');
  const asked = await runScheduleNow(quiet.companyId, quietReview);
  assert.equal((asked.input.month as { month: string }).month, month, 'the owner asked: it runs');

  // An invoice owed and late since long before the month: money to chase.
  // Written by work that had read an email, so the review carries that (F8.9).
  const chasing = await createCompany('money-late');
  const chasingReview = await moneyReview(chasing);
  await withTenant(chasing.companyId, (tx) => issueInvoice(tx, chasing.companyId, {
    customerName: 'Toko Lama', currency: 'IDR', issueDate: '2020-01-10', dueDate: '2020-01-24',
    lines: [{ description: 'Kopi', quantity: 1, unitCents: 1_000 }],
  }, 'agent', { outside: true }));

  // A sale on the month's last day.
  const busy = await createCompany('money-busy');
  const busyReview = await moneyReview(busy);
  await post(busy, day, 'Cash sale', [['1100', 'dr', 4_000], ['4100', 'cr', 4_000]]);

  const fired = await runDueSchedules();
  assert.deepEqual(fired.map((one) => one.companyId).sort(), [chasing.companyId, busy.companyId].sort());
  const { rows } = await withTenant(busy.companyId, (tx) => tx.query<{ input: { facts: string; month: MonthFacts } }>(
    'SELECT input FROM tasks WHERE schedule_id = $1', [busyReview]));
  assert.equal(rows[0]!.input.facts, 'month');
  assert.equal(rows[0]!.input.month.month, month);
  assert.equal(rows[0]!.input.month.books[0]!.incomeCents, 4_000);
  await withTenant(busy.companyId, async (tx) => {
    assert.equal(await outsideContentIn(tx, (await tx.query<{ id: string }>('SELECT id FROM tasks WHERE schedule_id = $1', [busyReview])).rows[0]!.id), null);
  });
  await withTenant(chasing.companyId, async (tx) => {
    const { rows: [review] } = await tx.query<{ id: string; overdue: number }>(
      "SELECT id, jsonb_array_length(input->'month'->'overdue'->'invoices') AS overdue FROM tasks WHERE schedule_id = $1", [chasingReview]);
    assert.equal(review!.overdue, 1);
    assert.equal(await outsideContentIn(tx, review!.id), 'read', 'a late customer named by work that read an email is data');
  });
});

/**
 * F18.12, F8.1: the month's facts are the company's books -- cash, what is
 * owed and the names of the customers late with it -- and nothing reads the
 * books except through `ledger.read`. A schedule handed the month for a role
 * that does not hold it, because the owner took the tool or the grant away
 * after the kit installed it, or because the schedule was written by hand,
 * is refused when it fires and when the owner runs it, naming what is
 * missing, and no run is made with the books in its input.
 */
test("the month's books are handed only to a role that may read them (F18.12, F8.1)", async () => {
  const { day } = lastMonthInJakarta();
  const blind = await createCompany('money-blind');
  await registerStandardCatalogue();
  const review = await moneyReview(blind, { readsTheBooks: false });
  await post(blind, day, 'Cash sale', [['1100', 'dr', 4_000], ['4100', 'cr', 4_000]]);

  await assert.rejects(runScheduleNow(blind.companyId, review),
    /role worker does not list ledger.read among its tools, so it may not be handed the month's books/);
  assert.deepEqual(await runDueSchedules(), [], 'the clock makes no run either');
  const { rows: [failed] } = await withTenant(blind.companyId, (tx) => tx.query<{ fire_failure: string | null }>(
    'SELECT fire_failure FROM schedules WHERE id = $1', [review]));
  assert.match(failed!.fire_failure ?? '', /does not list ledger.read/, 'the occurrence failed, saying why');

  // The tool without the division's grant is not enough either: the broker
  // would refuse the call.
  await withTenant(blind.companyId, (tx) => tx.query(
    "UPDATE roles SET tools = array_append(tools, 'ledger.read') WHERE id = $1", [blind.roleId]));
  await assert.rejects(runScheduleNow(blind.companyId, review),
    /division of role worker is not granted ledger.read, so it may not be handed the month's books/);
  const { rows: made } = await withTenant(blind.companyId, (tx) => tx.query(
    'SELECT 1 FROM tasks WHERE schedule_id = $1', [review]));
  assert.equal(made.length, 0);

  await grantCapability(blind, 'ledger.read');
  const ran = await runScheduleNow(blind.companyId, review);
  assert.equal((ran.input.month as MonthFacts).books[0]!.incomeCents, 4_000);
});
