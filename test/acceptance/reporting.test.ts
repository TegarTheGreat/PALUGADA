/**
 * PRD F11.3, F11.4, F9.4, F10.6 -- cost, alerts, digest and retro.
 *
 * These are the instruments the owner steers by, so the properties that matter
 * are about trust rather than arithmetic: figures must not cross tenants, an
 * estimate must not be presented as a measurement, and an alert must not fire
 * so often that the inbox stops being read.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { costBreakdown, costTimeline, platformCost } from '../../src/reporting/cost.ts';
import { evaluateAlerts, setThresholds, thresholdsFor } from '../../src/reporting/alerts.ts';
import {
  buildDailyDigest,
  buildWeeklyRetro,
  renderDailyDigest,
} from '../../src/reporting/digest.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

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

test('a failed verification is an incident, not a statistic (F8.4, F11.4)', async () => {
  const fixture = await createCompany('alert-verify');
  await setThresholds(fixture.companyId, { dailyCostCents: 1_000_000 });

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO events (company_id, project_id, type, actor, payload)
       VALUES ($1, $2, 'tool.verify_failed', 'agent_run', '{"capability":"dns.update"}'::jsonb)`,
      [fixture.companyId, fixture.projectId],
    );
  });

  const raised = await evaluateAlerts(fixture.companyId);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.kind, 'verification_failures');

  // Raised as an incident, so it may reach the owner outside their window: the
  // world may not match what the system believes.
  const items = await inbox.listOpen(fixture.companyId);
  assert.equal(items[0]!.kind, 'incident');
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
  assert.deepEqual(digest.highlights, ['1 task(s) stopped: budget_exhausted']);

  const rendered = renderDailyDigest(digest);
  const lines = rendered.split('\n');
  assert.ok(lines.length <= 12, `the digest must fit one screen, got ${lines.length} lines`);
  assert.ok(lines.every((line) => line.length <= 100));
  assert.match(rendered, /Spend: 2\.15/);
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
  assert.deepEqual(digest.highlights, [], 'a quiet, successful day has nothing to highlight');
});

test('the weekly retro reports the learning signals (F9.4)', async () => {
  const fixture = await createCompany('retro');
  await seedRun(fixture, { status: 'completed', costCents: 100 }, 1);
  await seedRun(fixture, { status: 'halted', costCents: 20, haltReason: 'hop_limit' }, 2);

  // A candidate SOP awaiting the owner, and a recorded decision: section 11's
  // indicators that the company is learning rather than only running.
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO memories (company_id, memory_type, scope_type, scope_id, body,
                             approval_state, fact_kind, source)
       VALUES ($1, 'procedural', 'division', $2, 'A proposed SOP', 'candidate',
               'sop_candidate', 'pattern:deploy.staging')`,
      [fixture.companyId, fixture.divisionId],
    );
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
