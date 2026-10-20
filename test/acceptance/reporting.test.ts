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
import { buildDailyDigest, buildWeeklyRetro } from '../../src/reporting/digest.ts';
import { renderDailyDigest } from '../../src/owner/digest-said.ts';
import { traceFromInboxItem } from '../../src/reporting/trace.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { ENDED_AFTER_MS, reportEndedBadly } from '../../src/engine/ended.ts';
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
 * "Model spend today is over the ceiling" is about today. Nothing closed it,
 * so every busy day left one more card that asked nothing and that nobody
 * could act on. It closes at the first look of a later day -- but only once
 * the owner's window has opened on it: a card raised after hours has not been
 * carried to them yet, and closing it first would hide the breach.
 */
test("yesterday's spending card closes itself, once it has had its window (F11.4)", async () => {
  const fixture = await createCompany('alert-day-ended');
  await setThresholds(fixture.companyId, { dailyCostCents: 150 });
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO llm_traces (id, company_id, model, prompt, response, input_tokens, output_tokens, cost_cents, occurred_at)
     VALUES ('trace-day-ended', $1, 'test-model', '{}'::jsonb, '{}'::jsonb, 100, 50, 300, $2)`,
    [fixture.companyId, yesterday]));

  const [raised] = await evaluateAlerts(fixture.companyId, yesterday);
  assert.equal(raised!.kind, 'daily_cost');
  const card = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{
    status: string; closed_reason: string | null; payload: { alert?: string; day?: string };
  }>('SELECT status, closed_reason, payload FROM inbox_items WHERE id = $1', [raised!.inboxItemId]))).rows[0]!;
  const { rows: [day] } = await withTenant(fixture.companyId, (tx) => tx.query<{ day: string }>(
    "SELECT to_char(date_trunc('day', $1::timestamptz), 'YYYY-MM-DD') AS day", [yesterday]));
  assert.deepEqual((await card()).payload, { alert: 'daily_cost', day: day!.day }, 'it says which day it is about');

  // Raised after hours: the window opens on it this morning.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE inbox_items SET notify_after = date_trunc('day', $2::timestamptz) + interval '9 hours' WHERE id = $1",
    [raised!.inboxItemId, now]));
  assert.deepEqual(await evaluateAlerts(fixture.companyId, now), []);
  assert.equal((await card()).status, 'open', 'kept until it has been carried to the owner');

  // Put off by the owner past today: theirs to see then.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE inbox_items SET notify_after = $2, snoozed_until = $3::timestamptz + interval '1 day' WHERE id = $1",
    [raised!.inboxItemId, yesterday, now]));
  await evaluateAlerts(fixture.companyId, now);
  assert.equal((await card()).status, 'open', 'a card the owner put off is kept for when they asked to see it');

  // Its window was yesterday: the first look today closes it.
  await withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE inbox_items SET snoozed_until = NULL WHERE id = $1', [raised!.inboxItemId]));
  await evaluateAlerts(fixture.companyId, now);
  const closed = await card();
  assert.deepEqual([closed.status, closed.closed_reason], ['withdrawn', 'day_ended']);
  const { rows: said } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { inboxItemId: string; closedReason: string } }>(
    "SELECT payload FROM events WHERE type = 'inbox.withdrawn'"));
  assert.deepEqual(said.map((row) => [row.payload.inboxItemId, row.payload.closedReason]), [[raised!.inboxItemId, 'day_ended']]);

  // Today's card is today's: a second look the same day leaves it.
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO llm_traces (id, company_id, model, prompt, response, input_tokens, output_tokens, cost_cents, occurred_at)
     VALUES ('trace-day-today', $1, 'test-model', '{}'::jsonb, '{}'::jsonb, 100, 50, 300, $2)`,
    [fixture.companyId, now]));
  const [today] = await evaluateAlerts(fixture.companyId, now);
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE inbox_items SET notify_after = $2::timestamptz - interval '1 hour' WHERE id = $1", [today!.inboxItemId, now]));
  await evaluateAlerts(fixture.companyId, now);
  assert.deepEqual((await inbox.listOpen(fixture.companyId)).map((item) => item.id), [today!.inboxItemId]);
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
