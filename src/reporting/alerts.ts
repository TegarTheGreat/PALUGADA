/**
 * Alerts (PRD F11.4).
 *
 * Four conditions the owner has said they want to hear about: spend above a
 * daily ceiling, a task failure rate above a threshold, a burst of policy
 * denials, and any failed state verification.
 *
 * Every alert is raised at most once per company per kind per day. That
 * deduplication is not a nicety: a sweep running every minute against a
 * standing overspend would produce a thousand inbox items, and an owner who
 * has learned to scroll past the inbox is worse off than one with no alerts at
 * all (principle 1).
 *
 * Verification failures use a threshold of one by default, because F8.4 treats
 * a write that reads back differently as an incident rather than a statistic.
 */
import { withTenant, withControlPlane } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import * as inbox from '../inbox/inbox.ts';

export type AlertKind =
  | 'daily_cost'
  | 'task_failure_rate'
  | 'policy_denials'
  | 'verification_failures'
  /** F11.4: a capability the role declares stopped being usable (F8.12). */
  | 'preflight_failures'
  /** F11.4: a run whose worker stopped talking and whose lease was reclaimed. */
  | 'orphaned_runs';

export interface Thresholds {
  dailyCostCents: number;
  taskFailureRate: number;
  policyDenialsPerDay: number;
  verificationFailuresPerDay: number;
  /**
   * F3.7: denials by a single role in one day before that role is frozen.
   *
   * Lower than `policyDenialsPerDay` on purpose. One role misbehaving should
   * be stopped before the company's total is high enough to be worth waking
   * the owner for; equal values would make the freeze and the alert always
   * arrive together, and the freeze would stop being the early signal.
   */
  roleFreezeDenialsPerDay: number;
  /** F1.8: how many times its own baseline a role may spend before it stops. */
  spendRateMultiple: number;
  /**
   * F1.8: the least an hour must cost before the ratio means anything.
   *
   * Three times almost nothing is still almost nothing, and a breaker that
   * trips on it teaches the owner to ignore breakers.
   */
  spendRateFloorCents: number;
}

/** Used when no threshold row exists, so alerting survives a missing config. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  dailyCostCents: 10_000,
  taskFailureRate: 0.2,
  policyDenialsPerDay: 20,
  verificationFailuresPerDay: 1,
  roleFreezeDenialsPerDay: 10,
  spendRateMultiple: 3,
  spendRateFloorCents: 100,
};

export interface RaisedAlert {
  kind: AlertKind;
  summary: string;
  observed: number;
  threshold: number;
  inboxItemId: string;
}

/** A company override wins over the platform default. */
export async function thresholdsFor(companyId: string): Promise<Thresholds> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      daily_cost_cents: number;
      task_failure_rate: number;
      policy_denials_per_day: number;
      verification_failures_per_day: number;
      role_freeze_denials_per_day: number;
      spend_rate_multiple: number;
      spend_rate_floor_cents: number;
    }>(
      `SELECT daily_cost_cents, task_failure_rate, policy_denials_per_day,
              verification_failures_per_day, role_freeze_denials_per_day,
              spend_rate_multiple, spend_rate_floor_cents
         FROM alert_thresholds
        WHERE company_id = $1 OR company_id IS NULL
        ORDER BY company_id NULLS LAST
        LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    if (!row) return DEFAULT_THRESHOLDS;
    return {
      dailyCostCents: row.daily_cost_cents,
      taskFailureRate: row.task_failure_rate,
      policyDenialsPerDay: row.policy_denials_per_day,
      verificationFailuresPerDay: row.verification_failures_per_day,
      roleFreezeDenialsPerDay: row.role_freeze_denials_per_day,
      spendRateMultiple: row.spend_rate_multiple,
      spendRateFloorCents: row.spend_rate_floor_cents,
    };
  });
}

export async function setThresholds(
  companyId: string | null,
  thresholds: Partial<Thresholds>,
): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO alert_thresholds
         (company_id, daily_cost_cents, task_failure_rate, policy_denials_per_day,
          verification_failures_per_day, role_freeze_denials_per_day,
          spend_rate_multiple, spend_rate_floor_cents)
       VALUES ($1,
               coalesce($2, 10000),
               coalesce($3, 0.2),
               coalesce($4, 20),
               coalesce($5, 1),
               coalesce($6, 10),
               -- Cast explicitly: the literal 3 would make PostgreSQL infer an
               -- integer parameter, and this column is a real.
               coalesce($7::real, 3),
               coalesce($8, 100))
       ON CONFLICT (company_id) DO UPDATE
         SET daily_cost_cents = coalesce($2, alert_thresholds.daily_cost_cents),
             task_failure_rate = coalesce($3, alert_thresholds.task_failure_rate),
             policy_denials_per_day = coalesce($4, alert_thresholds.policy_denials_per_day),
             verification_failures_per_day =
               coalesce($5, alert_thresholds.verification_failures_per_day),
             role_freeze_denials_per_day =
               coalesce($6, alert_thresholds.role_freeze_denials_per_day),
             spend_rate_multiple = coalesce($7::real, alert_thresholds.spend_rate_multiple),
             spend_rate_floor_cents =
               coalesce($8, alert_thresholds.spend_rate_floor_cents)`,
      [
        companyId,
        thresholds.dailyCostCents ?? null,
        thresholds.taskFailureRate ?? null,
        thresholds.policyDenialsPerDay ?? null,
        thresholds.verificationFailuresPerDay ?? null,
        thresholds.roleFreezeDenialsPerDay ?? null,
        thresholds.spendRateMultiple ?? null,
        thresholds.spendRateFloorCents ?? null,
      ],
    );
  });
}

interface DayMetrics {
  costCents: number;
  tasksFinished: number;
  tasksFailed: number;
  policyDenials: number;
  verificationFailures: number;
  /** F11.4. */
  preflightFailures: number;
  orphanedRuns: number;
}

export async function metricsForDay(companyId: string, day: Date): Promise<DayMetrics> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      cost_cents: string;
      tasks_finished: string;
      tasks_failed: string;
      policy_denials: string;
      verification_failures: string;
      preflight_failures: string;
      orphaned_runs: string;
    }>(
      `WITH bounds AS (
         SELECT date_trunc('day', $1::timestamptz) AS from_at,
                date_trunc('day', $1::timestamptz) + interval '1 day' AS to_at
       )
       SELECT
         (SELECT coalesce(sum(cost_cents), 0)::text FROM llm_traces, bounds
           WHERE occurred_at >= bounds.from_at AND occurred_at < bounds.to_at) AS cost_cents,
         (SELECT count(*)::text FROM tasks, bounds
           WHERE finished_at >= bounds.from_at AND finished_at < bounds.to_at
             AND status IN ('completed', 'failed', 'halted')) AS tasks_finished,
         (SELECT count(*)::text FROM tasks, bounds
           WHERE finished_at >= bounds.from_at AND finished_at < bounds.to_at
             AND status IN ('failed', 'halted')) AS tasks_failed,
         (SELECT count(*)::text FROM events, bounds
           WHERE type = 'policy.denied'
             AND occurred_at >= bounds.from_at AND occurred_at < bounds.to_at) AS policy_denials,
         (SELECT count(*)::text FROM events, bounds
           WHERE type = 'tool.verify_failed'
             AND occurred_at >= bounds.from_at AND occurred_at < bounds.to_at)
           AS verification_failures,
         (SELECT count(*)::text FROM tasks, bounds
           WHERE halt_reason = 'capability_unhealthy'
             AND finished_at >= bounds.from_at AND finished_at < bounds.to_at)
           AS preflight_failures,
         (SELECT count(*)::text FROM agent_runs, bounds
           WHERE status = 'orphaned'
             AND finished_at >= bounds.from_at AND finished_at < bounds.to_at)
           AS orphaned_runs`,
      [day],
    );
    const row = rows[0]!;
    return {
      costCents: Number(row.cost_cents),
      tasksFinished: Number(row.tasks_finished),
      tasksFailed: Number(row.tasks_failed),
      policyDenials: Number(row.policy_denials),
      verificationFailures: Number(row.verification_failures),
      preflightFailures: Number(row.preflight_failures),
      orphanedRuns: Number(row.orphaned_runs),
    };
  });
}

/** Records that this alert has been raised today. Returns false if it already was. */
async function claimAlertSlot(companyId: string, kind: AlertKind, day: Date): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO alert_state (company_id, kind, day)
       VALUES ($1, $2, date_trunc('day', $3::timestamptz))
       ON CONFLICT (company_id, kind, day) DO NOTHING`,
      [companyId, kind, day],
    );
    return rowCount === 1;
  });
}

export async function evaluateAlerts(companyId: string, now = new Date()): Promise<RaisedAlert[]> {
  const [thresholds, metrics] = await Promise.all([
    thresholdsFor(companyId),
    metricsForDay(companyId, now),
  ]);

  const breaches: Array<{ kind: AlertKind; summary: string; observed: number; threshold: number }> = [];

  if (metrics.costCents > thresholds.dailyCostCents) {
    breaches.push({
      kind: 'daily_cost',
      summary: `Model spend today is ${metrics.costCents} cents, over the ${thresholds.dailyCostCents} cent ceiling.`,
      observed: metrics.costCents,
      threshold: thresholds.dailyCostCents,
    });
  }

  // A rate needs a denominator worth dividing by. Two failed tasks out of two
  // is a 100% failure rate and almost never worth waking anyone over.
  const MIN_SAMPLE = 5;
  if (metrics.tasksFinished >= MIN_SAMPLE) {
    const rate = metrics.tasksFailed / metrics.tasksFinished;
    if (rate > thresholds.taskFailureRate) {
      breaches.push({
        kind: 'task_failure_rate',
        summary:
          `${metrics.tasksFailed} of ${metrics.tasksFinished} tasks failed or halted today ` +
          `(${Math.round(rate * 100)}%), over the ${Math.round(thresholds.taskFailureRate * 100)}% threshold.`,
        observed: rate,
        threshold: thresholds.taskFailureRate,
      });
    }
  }

  if (metrics.policyDenials > thresholds.policyDenialsPerDay) {
    breaches.push({
      kind: 'policy_denials',
      summary:
        `${metrics.policyDenials} actions were refused by policy today, over the ` +
        `threshold of ${thresholds.policyDenialsPerDay}. Either an agent is probing its limits ` +
        'or a policy is miscalibrated.',
      observed: metrics.policyDenials,
      threshold: thresholds.policyDenialsPerDay,
    });
  }

  if (metrics.verificationFailures >= thresholds.verificationFailuresPerDay) {
    breaches.push({
      kind: 'verification_failures',
      summary:
        `${metrics.verificationFailures} external writes reported success but read back ` +
        'differently. Something is changing state other than as asked.',
      observed: metrics.verificationFailures,
      threshold: thresholds.verificationFailuresPerDay,
    });
  }

  // F11.4: both of these are "the platform noticed something about itself".
  // One means a capability the role declares has stopped being usable, so
  // tasks are halting before they start; the other means a worker stopped
  // talking mid-run. Either is a single occurrence worth telling the owner
  // about, so the threshold is one rather than a rate -- a system that only
  // reports its own failures in bulk is a system that hides the first one.
  if (metrics.preflightFailures > 0) {
    breaches.push({
      kind: 'preflight_failures',
      summary:
        `${metrics.preflightFailures} task${metrics.preflightFailures === 1 ? '' : 's'} could ` +
        'not start today because a capability the role declares failed its readiness check. ' +
        'A credential has probably expired or a quota is exhausted.',
      observed: metrics.preflightFailures,
      threshold: 0,
    });
  }

  if (metrics.orphanedRuns > 0) {
    breaches.push({
      kind: 'orphaned_runs',
      summary:
        `${metrics.orphanedRuns} run${metrics.orphanedRuns === 1 ? '' : 's'} stopped reporting ` +
        'and had their leases reclaimed today. The work was picked up again; the tokens they ' +
        'had already spent were not recovered.',
      observed: metrics.orphanedRuns,
      threshold: 0,
    });
  }

  const raised: RaisedAlert[] = [];

  for (const breach of breaches) {
    if (!(await claimAlertSlot(companyId, breach.kind, now))) continue;

    // A failed verification is an incident: it means the world may not match
    // what the system believes. Everything else is a budget-shaped alert that
    // can wait for the owner's window.
    const inboxItemId =
      // F8.12 calls a preflight failure an incident, and an orphaned run means
      // a worker died mid-task -- neither keeps until the owner's window the way
      // a spending figure does.
      breach.kind === 'verification_failures'
      || breach.kind === 'preflight_failures'
      || breach.kind === 'orphaned_runs'
        ? await inbox.raiseIncident({
            companyId,
            title: alertTitle(breach.kind),
            detail: breach.summary,
          })
        : await inbox.raiseBudgetAlert({
            companyId,
            title: alertTitle(breach.kind),
            detail: breach.summary,
          });

    await withTenant(companyId, async (tx) => {
      await appendEvent(tx, {
        companyId,
        type: 'alert.raised',
        actor: 'system',
        payload: {
          kind: breach.kind,
          observed: breach.observed,
          threshold: breach.threshold,
          inboxItemId,
        },
      });
    });

    raised.push({ ...breach, inboxItemId });
  }

  return raised;
}

function alertTitle(kind: AlertKind): string {
  switch (kind) {
    case 'daily_cost':
      return 'Daily model spend over threshold';
    case 'task_failure_rate':
      return 'Task failure rate over threshold';
    case 'policy_denials':
      return 'Unusual number of policy refusals';
    case 'verification_failures':
      return 'External writes failed verification';
    case 'preflight_failures':
      return 'A capability stopped being usable';
    case 'orphaned_runs':
      return 'A worker stopped reporting mid-run';
  }
}
