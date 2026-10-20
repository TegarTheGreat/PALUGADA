/**
 * Alerts (PRD F11.4).
 *
 * Three conditions the owner has said they want to hear about: spend above a
 * daily ceiling, a task failure rate above a threshold, and a burst of policy
 * denials.
 *
 * Every alert is raised at most once per company per kind per day. That
 * deduplication is not a nicety: a sweep running every minute against a
 * standing overspend would produce a thousand inbox items, and an owner who
 * has learned to scroll past the inbox is worse off than one with no alerts at
 * all (principle 1). And each is about its day, and closes itself once that
 * day has ended and the owner has had a whole day to see it (`closeEndedDays`).
 *
 * F11.4 names three more, and each is said where it can be acted on rather
 * than as a daily count. A failed read-back has its own incident, about its
 * task (F8.4, engine.ts); a capability that stopped being usable has its own
 * card (F8.12, preflight.ts and engine.ts), on which the work that waited a
 * day for it is listed when it stops (`holdEndedOn`), and ended.ts reports
 * such a task only when no card about the capability is open or that card
 * already lists fifty. A run whose worker stopped is put back with its journal, which asks nothing of
 * the owner, so it is a line of the daily digest (digest.ts); a task that
 * keeps losing its worker is halted with its own incident (checkout.ts). The
 * daily cards for these were a second urgent card beside the first, pushed at
 * the same moment, or an incident about work already picked up again.
 */
import { withTenant, withControlPlane } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import * as inbox from '../inbox/inbox.ts';
import { alertCard, ownerReadingWithin, type AlertFacts } from '../owner/platform-cards.ts';

export type AlertKind = 'daily_cost' | 'task_failure_rate' | 'policy_denials';

export interface Thresholds {
  dailyCostCents: number;
  taskFailureRate: number;
  policyDenialsPerDay: number;
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

/**
 * A company override wins over the platform default.
 *
 * `verification_failures_per_day` stays in the table and in the export, and
 * is no longer read: every failed read-back is an incident of its own (F8.4),
 * so there is no daily count left for it to be a threshold of.
 */
export async function thresholdsFor(companyId: string): Promise<Thresholds> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      daily_cost_cents: number;
      task_failure_rate: number;
      policy_denials_per_day: number;
      role_freeze_denials_per_day: number;
      spend_rate_multiple: number;
      spend_rate_floor_cents: number;
    }>(
      `SELECT daily_cost_cents, task_failure_rate, policy_denials_per_day,
              role_freeze_denials_per_day, spend_rate_multiple, spend_rate_floor_cents
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
          role_freeze_denials_per_day, spend_rate_multiple, spend_rate_floor_cents)
       VALUES ($1,
               coalesce($2, 10000),
               coalesce($3, 0.2),
               coalesce($4, 20),
               coalesce($5, 10),
               -- Cast explicitly: the literal 3 would make PostgreSQL infer an
               -- integer parameter, and this column is a real.
               coalesce($6::real, 3),
               coalesce($7, 100))
       ON CONFLICT (company_id) DO UPDATE
         SET daily_cost_cents = coalesce($2, alert_thresholds.daily_cost_cents),
             task_failure_rate = coalesce($3, alert_thresholds.task_failure_rate),
             policy_denials_per_day = coalesce($4, alert_thresholds.policy_denials_per_day),
             role_freeze_denials_per_day =
               coalesce($5, alert_thresholds.role_freeze_denials_per_day),
             spend_rate_multiple = coalesce($6::real, alert_thresholds.spend_rate_multiple),
             spend_rate_floor_cents =
               coalesce($7, alert_thresholds.spend_rate_floor_cents)`,
      [
        companyId,
        thresholds.dailyCostCents ?? null,
        thresholds.taskFailureRate ?? null,
        thresholds.policyDenialsPerDay ?? null,
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
}

export async function metricsForDay(companyId: string, day: Date): Promise<DayMetrics> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      cost_cents: string;
      tasks_finished: string;
      tasks_failed: string;
      policy_denials: string;
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
             AND occurred_at >= bounds.from_at AND occurred_at < bounds.to_at) AS policy_denials`,
      [day],
    );
    const row = rows[0]!;
    return {
      costCents: Number(row.cost_cents),
      tasksFinished: Number(row.tasks_finished),
      tasksFailed: Number(row.tasks_failed),
      policyDenials: Number(row.policy_denials),
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

/**
 * Closes the cards about a day that has ended once the owner has had a whole
 * day to see them, and returns `now`'s day as the cards name it.
 *
 * Each card said "today" of a day that had ended, asked nothing, and stayed:
 * a busy month left thirty. The day is the one `claimAlertSlot` counts in,
 * from the same expression, and is compared as text: both are YYYY-MM-DD.
 *
 * Not at the day's end. A card carried late in its day -- at 21:55, or at
 * 21:30 in Jakarta, which is 14:30 in UTC -- had barely reached the owner by
 * midnight, and closing it then rewrote its chat message (`retractClosed`)
 * before their next morning: they never heard of the breach. So a card is
 * kept a whole day from when it was put in front of the owner: carried to
 * them (`notify_after`, which is the window's next opening for one raised
 * after hours, F10.5), or back from being put off (`snoozed_until`, 0060).
 * The owner's window is the same hours every day, so any whole day holds all
 * of it, wherever those hours fall against UTC's midnight; a day, rather than
 * the window's next closing, because a window that never closes or never
 * opens has no closing to wait for.
 */
async function closeEndedDays(companyId: string, now: Date): Promise<string> {
  return withTenant(companyId, async (tx) => {
    const { rows: [today] } = await tx.query<{ day: string }>(
      "SELECT to_char(date_trunc('day', $1::timestamptz), 'YYYY-MM-DD') AS day", [now]);
    const { rows: closed } = await tx.query<{ id: string }>(
      `UPDATE inbox_items SET status = 'withdrawn', closed_reason = 'day_ended'
        WHERE kind = 'budget_alert' AND status = 'open' AND payload ? 'alert'
          AND payload->>'day' < $2
          -- greatest() passes over a null: a card never put off counts from
          -- when it was carried.
          AND greatest(notify_after, snoozed_until) <= $1::timestamptz - interval '1 day'
        RETURNING id`,
      [now, today!.day],
    );
    for (const item of closed) {
      await appendEvent(tx, {
        companyId, type: 'inbox.withdrawn', actor: 'system', payload: { inboxItemId: item.id, closedReason: 'day_ended' },
      });
    }
    return today!.day;
  });
}

export async function evaluateAlerts(companyId: string, now = new Date()): Promise<RaisedAlert[]> {
  const day = await closeEndedDays(companyId, now);
  const [thresholds, metrics] = await Promise.all([
    thresholdsFor(companyId),
    metricsForDay(companyId, now),
  ]);

  // The summary is the record, kept in English; `facts` is what the owner's
  // card says, in their language (platform-cards.ts).
  const breaches: Array<{ kind: AlertKind; summary: string; observed: number; threshold: number; facts: AlertFacts }> = [];

  if (metrics.costCents > thresholds.dailyCostCents) {
    breaches.push({
      kind: 'daily_cost',
      summary: `Model spend today is ${metrics.costCents} cents, over the ${thresholds.dailyCostCents} cent ceiling.`,
      observed: metrics.costCents,
      threshold: thresholds.dailyCostCents,
      facts: { kind: 'daily_cost', costCents: metrics.costCents, limitCents: thresholds.dailyCostCents },
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
        facts: { kind: 'task_failure_rate', failed: metrics.tasksFailed, finished: metrics.tasksFinished, rate, limit: thresholds.taskFailureRate },
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
      facts: { kind: 'policy_denials', count: metrics.policyDenials, limit: thresholds.policyDenialsPerDay },
    });
  }

  const raised: RaisedAlert[] = [];

  const reading = breaches.length > 0 ? await withTenant(companyId, ownerReadingWithin) : null;
  for (const breach of breaches) {
    if (!(await claimAlertSlot(companyId, breach.kind, now))) continue;
    const card = alertCard(reading!, breach.facts);

    // Each is a figure about the day, which keeps until the owner's window: a
    // number that will be just as true at breakfast. The day it is about is
    // what closes it once the day is over (`closeEndedDays`).
    const inboxItemId = await inbox.raiseBudgetAlert({
      companyId, title: card.title, detail: card.detail, payload: { alert: breach.kind, day },
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
