/**
 * Goals that are measured (0053, src/domain/metrics.ts).
 *
 * A key result used to be "done" when its tasks were. These check the other
 * half: the owner sets what a goal is measured by and nobody else can; values
 * are recorded by the owner or by a run; a run's value counts as verified only
 * when that run read the number from the metric's source; every run under the
 * goal is told the number it serves and whether it is verified; and all of it
 * travels with the company.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { buildContext } from '../../src/context/builder.ts';
import { defineMetric, headlines, metricsIn, progressOf, recordObservation } from '../../src/domain/metrics.ts';
import { structureOf } from '../../src/owner/views.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;

async function task(fixture: Fixture) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `find out where revenue stands (${sequence})` },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });
}

async function revenue(fixture: Fixture, source: string | null = 'ledger.read') {
  return defineMetric(fixture.companyId, {
    goalId: fixture.goalId,
    slug: 'mrr',
    name: 'Monthly recurring revenue',
    unit: 'currency',
    baseline: 0,
    target: 10_000_000,
    dueOn: '2026-12-31',
    sourceCapability: source,
  });
}

test('progress runs from baseline to target, either way, and stops at the ends', () => {
  assert.equal(progressOf({ baseline: 0, target: 100 }, 25), 0.25);
  // Lower is better: churn from 10% down to 5%, now 7.5%.
  assert.equal(progressOf({ baseline: 10, target: 5 }, 7.5), 0.5);
  assert.equal(progressOf({ baseline: 0, target: 100 }, 140), 1, 'past the target is done, not 140% done');
  assert.equal(progressOf({ baseline: 0, target: 100 }, -5), 0);
});

test('only the owner sets what a goal is measured by', async () => {
  const fixture = await createCompany('metric-owner');
  const other = await createCompany('metric-other');
  await revenue(fixture);

  await assert.rejects(defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'flat', name: 'Flat', unit: 'count', baseline: 5, target: 5,
  }), (error: unknown) => isPalugadaError(error, 'contract.violation'));
  await assert.rejects(defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'odd', name: 'Odd', unit: 'vibes' as never, target: 5,
  }), (error: unknown) => isPalugadaError(error, 'contract.violation'));
  await assert.rejects(defineMetric(fixture.companyId, {
    goalId: other.goalId, slug: 'theirs', name: 'Theirs', unit: 'count', target: 5,
  }), /no such goal in this company/);

  // The application role -- every agent -- can read the target and cannot
  // move it, nor rewrite a value once recorded.
  const asAgent = (sql: string, values: unknown[] = []) =>
    withTenant(fixture.companyId, (tx) => tx.query(sql, values));
  await assert.rejects(
    asAgent(`INSERT INTO goal_metrics (company_id, goal_id, slug, name, unit, target)
             VALUES ($1, $2, 'mine', 'Mine', 'count', 1)`, [fixture.companyId, fixture.goalId]),
    /permission denied/,
  );
  await assert.rejects(asAgent('UPDATE goal_metrics SET target = 1'), /permission denied/);
  const entered = await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: 'mrr', value: 100, recordedBy: 'owner',
  }));
  assert.equal(entered.verified, true, "the owner's own figure is verified by being theirs");
  await assert.rejects(asAgent('UPDATE metric_observations SET value = 1'), /permission denied/);
  await assert.rejects(asAgent('DELETE FROM metric_observations'), /permission denied/);
  const { rows } = await asAgent('SELECT target FROM goal_metrics');
  assert.equal(Number((rows[0] as { target: string }).target), 10_000_000, 'the target is readable');
});

test("a run's number is verified only when that run read it from the source", async () => {
  const fixture = await createCompany('metric-verify');
  await revenue(fixture);
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'metric.record');
  const broker = new CapabilityBroker(registry);

  const first = await task(fixture);
  const ctx = (taskId: string, key: string) => ({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId, idempotencyKey: key,
  });

  // Nothing read from the source: the run's claim, kept and marked as one --
  // even when the same number came back from some other capability, or from
  // a call to the source that never committed.
  const journal = (taskId: string, index: number, name: string, status: string, output: unknown) =>
    withTenant(fixture.companyId, (tx) => tx.query(
      `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
       VALUES ($1, $2, $3, $4, 'tool', $5, 'h', $6, $7, CASE WHEN $5 = 'committed' THEN now() END)`,
      [taskId, index, fixture.companyId, name, status, `k${index}`, JSON.stringify(output)],
    ));
  await journal(first.id, 10, 'capability:web.fetch', 'committed', { figure: 4_200_000 });
  const claimed = await broker.invoke<{ metric: string; value: number }, { verified: boolean }>(
    ctx(first.id, 'm1'), 'metric.record', { metric: 'mrr', value: 4_200_000 },
  );
  assert.equal(claimed.output.verified, false);

  // The ledger was read in this task, as the engine journals a call, and it
  // said 4,200,000: the same number is now a measurement.
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
     VALUES ($1, 0, $2, 'capability:ledger.read', 'tool', 'committed', 'h', 'k0', $3, now())`,
    [first.id, fixture.companyId, JSON.stringify({ balances: [{ account: 'mrr', amount: 4_200_000 }] })],
  ));
  const read = await broker.invoke<{ metric: string; value: number }, { verified: boolean }>(
    ctx(first.id, 'm2'), 'metric.record', { metric: 'mrr', value: 4_200_000 },
  );
  assert.equal(read.output.verified, true);

  // A different number than the source said is not verified by the read.
  const inflated = await broker.invoke<{ metric: string; value: number }, { verified: boolean }>(
    ctx(first.id, 'm3'), 'metric.record', { metric: 'mrr', value: 9_000_000 },
  );
  assert.equal(inflated.output.verified, false);

  // Nor is another task's read, nor a read that did not commit.
  const second = await task(fixture);
  await journal(second.id, 0, 'capability:ledger.read', 'started', { balances: [{ amount: 4_200_000 }] });
  const borrowed = await broker.invoke<{ metric: string; value: number }, { verified: boolean }>(
    ctx(second.id, 'm4'), 'metric.record', { metric: 'mrr', value: 4_200_000 },
  );
  assert.equal(borrowed.output.verified, false);

  // A metric that does not exist is refused, not created.
  await assert.rejects(
    broker.invoke(ctx(second.id, 'm5'), 'metric.record', { metric: 'profit', value: 1 }),
    /no metric profit/,
  );
});

test('every run under the goal is told the number it serves, and whether it is verified', async () => {
  const fixture = await createCompany('metric-context');
  await revenue(fixture);
  const run = await task(fixture);
  await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: 'mrr', value: 2_500_000, recordedBy: 'agent', taskId: run.id,
  }));

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: run.id }));
  const measured = context.sections.find((section) => section.title === 'How this work is measured');
  assert.ok(measured, 'the run was not told what its goal is measured by');
  assert.match(measured.body, /Monthly recurring revenue \[mrr\]: from 0 to 10000000 currency by 2026-12-31/);
  assert.match(measured.body, /now 2500000 \(UNVERIFIED/);
  assert.match(measured.body, /Read it with ledger\.read and record it with metric\.record/);

  // And the owner's structure view carries the same standing, with progress.
  const structure = await structureOf(fixture.companyId);
  const goal = structure.goals.find((one) => one.id === fixture.goalId)!;
  assert.equal(goal.metrics.length, 1);
  assert.equal(goal.metrics[0]!.progress, 0.25);
  assert.equal(goal.metrics[0]!.latest?.verified, false);
});

test("the portfolio judges each company by its highest goal's measure, and none by effort", async () => {
  const measured = await createCompany('metric-headline');
  const unmeasured = await createCompany('metric-none');
  await revenue(measured);
  const { rows } = await withTenant(measured.companyId, (tx) =>
    tx.query<{ id: string }>("SELECT id FROM goals WHERE kind = 'mission'"));
  // Set after the objective's, and still the headline: the mission is what
  // the company is for.
  await defineMetric(measured.companyId, {
    goalId: rows[0]!.id, slug: 'customers', name: 'Paying customers', unit: 'count', target: 200,
  });
  const run = await task(measured);
  await withTenant(measured.companyId, async (tx) => {
    await recordObservation(tx, { companyId: measured.companyId, metric: 'customers', value: 30, recordedBy: 'owner' });
    await recordObservation(tx, { companyId: measured.companyId, metric: 'customers', value: 50, recordedBy: 'agent', taskId: run.id });
  });

  const portfolio = await withControlPlane((tx) => headlines(tx));
  assert.deepEqual(portfolio.get(measured.companyId), {
    name: 'Paying customers', unit: 'count', target: 200, value: 50, verified: false, progress: 0.25,
  });
  assert.equal(portfolio.has(unmeasured.companyId), false, 'a company with nothing measured has no headline');

  // A mission that is no longer active stops being the headline.
  await withControlPlane((tx) => tx.query("UPDATE goals SET status = 'abandoned' WHERE id = $1", [rows[0]!.id]));
  const after = await withControlPlane((tx) => headlines(tx));
  assert.equal(after.get(measured.companyId)?.name, 'Monthly recurring revenue');
  assert.equal(after.get(measured.companyId)?.value, null, 'no value recorded yet is null, not zero');
});

test('measures and readings travel with the company', async () => {
  const fixture = await createCompany('metric-export');
  await revenue(fixture);
  const run = await task(fixture);
  await withTenant(fixture.companyId, async (tx) => {
    await recordObservation(tx, { companyId: fixture.companyId, metric: 'mrr', value: 1_000_000, recordedBy: 'owner' });
    await recordObservation(tx, { companyId: fixture.companyId, metric: 'mrr', value: 1_500_000, recordedBy: 'agent', taskId: run.id });
  });

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'metric-restored' });

  const metrics = await withTenant(restored.companyId, (tx) => metricsIn(tx));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.target, 10_000_000);
  assert.deepEqual(metrics[0]!.history.map((point) => point.value), [1_000_000, 1_500_000]);
  // Re-pointed at the restored goal and task, not the source's.
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ goal_ok: boolean; task_ok: boolean }>(
    `SELECT (SELECT goal_id FROM goal_metrics) IN (SELECT id FROM goals) AS goal_ok,
            (SELECT task_id FROM metric_observations WHERE recorded_by = 'agent') IN (SELECT id FROM tasks) AS task_ok`,
  ));
  assert.deepEqual(rows[0], { goal_ok: true, task_ok: true });
});
