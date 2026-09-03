/**
 * The monthly ceiling and the spending circuit breaker (PRD v2 F1.7, F1.8,
 * F1.9).
 *
 * Two instruments, and neither substitutes for the other. F1.9 says so
 * directly: the periodic ceiling and the per-task one are separate and both
 * must hold. A single runaway task is caught by its budget account; a hundred
 * well-behaved tasks that together cost more than the company can afford are
 * caught only here. The breaker is a third thing again -- it watches the
 * *rate*, so a role that starts burning ten times its usual cost is stopped in
 * minutes rather than when the month's money runs out.
 *
 * **Spend is derived, never counted twice.** The figure comes from the model
 * traces and the `tool.cost` events that already record every cent. A second
 * counter kept alongside them is a second thing that can be wrong, and the one
 * that is wrong is always the one being enforced.
 *
 * **The period is a calendar month in UTC.** The same convention the daily
 * alerts already use. A monthly boundary that follows each company's own zone
 * would be marginally kinder to read and would mean two different answers to
 * "when does the window start", which is worse than a boundary a few hours off.
 *
 * **The breaker needs a floor as well as a ratio.** Three times almost nothing
 * is still almost nothing. This is the same reasoning the alert module applies
 * to failure rates: a rate computed from too small a sample is not a rate, and
 * a breaker that trips on one teaches the owner to ignore breakers.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import * as inbox from '../inbox/inbox.ts';
import { thresholdsFor } from '../reporting/alerts.ts';

const HOUR_MS = 3_600_000;
const BASELINE_DAYS = 7;
const BASELINE_HOURS = BASELINE_DAYS * 24;

export interface SpendLimit {
  moneyMaxCents: number;
  pausedAt: Date | null;
  pauseReason: string | null;
  overrideUntil: Date | null;
}

export interface PeriodSpend {
  periodStart: Date;
  periodEnd: Date;
  cents: number;
  limitCents: number;
  /** 0 to 1, or above 1 when the ceiling has been passed. */
  fraction: number;
}

/**
 * Every cent a company spent in a window.
 *
 * Model calls and capability calls are summed together because the ceiling is
 * about money leaving the company, and the owner does not care which of the
 * two spent it. `tool.cost` falls back to the charged estimate when the
 * capability measured nothing, which is the same rule the cost report uses.
 */
const SPEND_IN_WINDOW = `
  SELECT (
    coalesce((SELECT sum(tr.cost_cents) FROM llm_traces tr
               WHERE tr.occurred_at >= $1 AND tr.occurred_at < $2), 0)
    + coalesce((SELECT sum(coalesce(
          nullif(e.payload->>'actualCents', '')::bigint,
          nullif(e.payload->>'estimatedCents', '')::bigint,
          0))
        FROM events e
       WHERE e.type = 'tool.cost'
         AND e.occurred_at >= $1 AND e.occurred_at < $2), 0)
  )::text AS cents`;

async function spendBetween(tx: TenantClient, from: Date, to: Date): Promise<number> {
  const { rows } = await tx.query<{ cents: string }>(SPEND_IN_WINDOW, [from, to]);
  return Number(rows[0]?.cents ?? 0);
}

export function periodBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** A company's own row wins; the platform row is the fallback. */
export async function limitFor(companyId: string): Promise<SpendLimit> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      money_max_cents: string;
      paused_at: Date | null;
      pause_reason: string | null;
      override_until: Date | null;
    }>(
      `SELECT money_max_cents, paused_at, pause_reason, override_until
         FROM spend_limits
        WHERE company_id = $1 OR company_id IS NULL
        ORDER BY company_id NULLS LAST LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    return {
      // No row at all is a misconfiguration, and the fail-closed reading of a
      // missing ceiling is zero rather than infinity.
      moneyMaxCents: row ? Number(row.money_max_cents) : 0,
      pausedAt: row?.paused_at ?? null,
      pauseReason: row?.pause_reason ?? null,
      overrideUntil: row?.override_until ?? null,
    };
  });
}

export async function setSpendLimit(
  companyId: string | null,
  moneyMaxCents: number,
): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO spend_limits (company_id, money_max_cents) VALUES ($1, $2)
       ON CONFLICT (company_id) DO UPDATE SET money_max_cents = EXCLUDED.money_max_cents`,
      [companyId, moneyMaxCents],
    );
  });
}

export async function periodSpend(companyId: string, now = new Date()): Promise<PeriodSpend> {
  const { start, end } = periodBounds(now);
  const limit = await limitFor(companyId);
  const cents = await withTenant(companyId, (tx) => spendBetween(tx, start, end));
  return {
    periodStart: start,
    periodEnd: end,
    cents,
    limitCents: limit.moneyMaxCents,
    fraction: limit.moneyMaxCents === 0 ? (cents > 0 ? Infinity : 0) : cents / limit.moneyMaxCents,
  };
}

/**
 * Whether new work is currently barred because the money ran out (F1.7).
 *
 * An override lifts it until its own deadline and no further. An override with
 * no end would quietly become the new ceiling, which is the failure mode a
 * ceiling exists to prevent.
 */
export async function isSpendPaused(companyId: string, now = new Date()): Promise<boolean> {
  const limit = await limitFor(companyId);
  if (!limit.pausedAt) return false;
  if (limit.overrideUntil && limit.overrideUntil > now) return false;
  return true;
}

/** F1.7: the owner's override, with a deadline it cannot outlive. */
export async function overrideSpendPause(companyId: string, until: Date): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO spend_limits (company_id, override_until) VALUES ($1, $2)
       ON CONFLICT (company_id) DO UPDATE SET override_until = EXCLUDED.override_until`,
      [companyId, until],
    );
    await appendEvent(tx, {
      companyId,
      type: 'budget.override_granted',
      actor: 'owner',
      payload: { until: until.toISOString() },
    });
  });
}

/** Clears a pause outright, for the start of a new period or an owner reset. */
export async function clearSpendPause(companyId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `UPDATE spend_limits SET paused_at = NULL, pause_reason = NULL, override_until = NULL
        WHERE company_id = $1`,
      [companyId],
    );
  });
}

/** Records that this alert has been raised for this period. False if already. */
async function claimSlot(companyId: string, kind: string, day: Date): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO alert_state (company_id, kind, day) VALUES ($1, $2, $3::date)
       ON CONFLICT (company_id, kind, day) DO NOTHING`,
      [companyId, kind, day],
    );
    return rowCount === 1;
  });
}

export type SpendOutcome =
  | { state: 'under' }
  | { state: 'warned'; spend: PeriodSpend }
  | { state: 'paused'; spend: PeriodSpend };

/**
 * F1.7: warn at 80% of the period ceiling, pause at 100%.
 *
 * The warning fires once per period rather than once per check. A sweep every
 * few minutes against a standing overspend would fill the inbox, and an owner
 * who has learned to scroll past the inbox is worse off than one with no
 * alerts -- the same reasoning the daily alerts already follow.
 */
export async function evaluateSpendLimit(
  companyId: string,
  now = new Date(),
): Promise<SpendOutcome> {
  const spend = await periodSpend(companyId, now);
  const already = await limitFor(companyId);

  if (spend.fraction >= 1) {
    if (!already.pausedAt) {
      const reason =
        `spent ${spend.cents} of ${spend.limitCents} cents in the period beginning ` +
        `${spend.periodStart.toISOString().slice(0, 10)}`;
      await withControlPlane(async (tx) => {
        await tx.query(
          `INSERT INTO spend_limits (company_id, paused_at, pause_reason)
           VALUES ($1, $2, $3)
           ON CONFLICT (company_id) DO UPDATE
             SET paused_at = EXCLUDED.paused_at, pause_reason = EXCLUDED.pause_reason`,
          [companyId, now, reason],
        );
        await appendEvent(tx, {
          companyId,
          type: 'budget.period_exhausted',
          actor: 'system',
          payload: { cents: spend.cents, limitCents: spend.limitCents },
        });
      });

      await inbox.raiseBudgetAlert({
        companyId,
        title: 'Monthly budget reached; the company is paused',
        detail:
          `${reason}. No new task will start and no external action will run until you ` +
          'raise the ceiling or grant a temporary override.',
      });
    }
    return { state: 'paused', spend };
  }

  if (spend.fraction >= 0.8) {
    if (await claimSlot(companyId, 'spend_period_warning', spend.periodStart)) {
      await inbox.raiseBudgetAlert({
        companyId,
        title: 'Monthly budget is 80% spent',
        detail:
          `${spend.cents} of ${spend.limitCents} cents used in the period beginning ` +
          `${spend.periodStart.toISOString().slice(0, 10)}. At 100% the company pauses.`,
      });
    }
    return { state: 'warned', spend };
  }

  return { state: 'under' };
}

export interface RoleRate {
  roleId: string;
  slug: string;
  lastHourCents: number;
  baselineHourlyCents: number;
  /** Null when there is no baseline to divide by. */
  multiple: number | null;
}

const ROLE_SPEND_IN_WINDOW = `
  SELECT r.id AS role_id, r.slug,
         (coalesce((SELECT sum(tr.cost_cents)
                      FROM llm_traces tr JOIN tasks t ON t.id = tr.task_id
                     WHERE t.role_id = r.id
                       AND tr.occurred_at >= $1 AND tr.occurred_at < $2), 0)
        + coalesce((SELECT sum(coalesce(
                       nullif(e.payload->>'actualCents', '')::bigint,
                       nullif(e.payload->>'estimatedCents', '')::bigint,
                       0))
                      FROM events e JOIN tasks t ON t.id = e.task_id
                     WHERE t.role_id = r.id AND e.type = 'tool.cost'
                       AND e.occurred_at >= $1 AND e.occurred_at < $2), 0))::text AS cents
    FROM roles r
   WHERE r.frozen_at IS NULL`;

async function roleSpend(
  tx: TenantClient,
  from: Date,
  to: Date,
): Promise<Map<string, { slug: string; cents: number }>> {
  const { rows } = await tx.query<{ role_id: string; slug: string; cents: string }>(
    ROLE_SPEND_IN_WINDOW,
    [from, to],
  );
  return new Map(rows.map((row) => [row.role_id, { slug: row.slug, cents: Number(row.cents) }]));
}

/**
 * F1.8: a role spending far faster than it usually does is stopped.
 *
 * The comparison is an hour against the trailing seven days, expressed as an
 * hourly average so the two are commensurable. A role with no history has no
 * baseline and cannot trip the ratio -- there is nothing to be three times of.
 * That gap is covered by the period ceiling rather than by inventing a number
 * for a role nobody has watched yet.
 *
 * Already-frozen roles are skipped: a frozen role cannot spend, so re-checking
 * it would only produce a second incident about a role that is already stopped.
 */
export async function evaluateCircuitBreakers(
  companyId: string,
  now = new Date(),
): Promise<RoleRate[]> {
  const thresholds = await thresholdsFor(companyId);
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const baselineFrom = new Date(now.getTime() - BASELINE_HOURS * HOUR_MS);

  const rates = await withTenant(companyId, async (tx) => {
    const recent = await roleSpend(tx, hourAgo, now);
    const baseline = await roleSpend(tx, baselineFrom, now);

    const out: RoleRate[] = [];
    for (const [roleId, current] of recent) {
      const total = baseline.get(roleId)?.cents ?? 0;
      // The last hour is inside the baseline window, and leaving it there
      // would let a spike raise its own baseline and hide itself.
      const priorCents = Math.max(0, total - current.cents);
      const baselineHourly = priorCents / (BASELINE_HOURS - 1);
      out.push({
        roleId,
        slug: current.slug,
        lastHourCents: current.cents,
        baselineHourlyCents: baselineHourly,
        multiple: baselineHourly > 0 ? current.cents / baselineHourly : null,
      });
    }
    return out;
  });

  const tripped: RoleRate[] = [];
  for (const rate of rates) {
    if (rate.lastHourCents < thresholds.spendRateFloorCents) continue;
    if (rate.multiple === null || rate.multiple <= thresholds.spendRateMultiple) continue;

    const reason =
      `spent ${rate.lastHourCents} cents in the last hour against a seven-day average of ` +
      `${rate.baselineHourlyCents.toFixed(1)} cents an hour, which is ` +
      `${rate.multiple.toFixed(1)} times its usual rate`;

    await withControlPlane(async (tx) => {
      await tx.query(
        `UPDATE roles SET frozen_at = now(), frozen_reason = $2
          WHERE id = $1 AND company_id = $3 AND frozen_at IS NULL`,
        [rate.roleId, reason, companyId],
      );
      await appendEvent(tx, {
        companyId,
        type: 'budget.circuit_open',
        actor: 'system',
        payload: {
          roleId: rate.roleId,
          role: rate.slug,
          lastHourCents: rate.lastHourCents,
          baselineHourlyCents: rate.baselineHourlyCents,
          multiple: rate.multiple,
        },
      });
    });

    await inbox.raiseIncident({
      companyId,
      title: `Role ${rate.slug} is paused for spending too fast`,
      detail:
        `${reason}. It is stopped before the monthly ceiling is reached, so there is money ` +
        'left to work with once you have found out why. Lift the pause when you have.',
    });

    tripped.push(rate);
  }

  return tripped;
}
