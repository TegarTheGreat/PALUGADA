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
import { ownerReadingWithin, roleCalledWithin, roleSpendingFastCard, spendPausedCard, spendWarnedCard } from '../owner/platform-cards.ts';
import { thresholdsFor } from '../reporting/alerts.ts';
import { liftFreeze } from './role-freeze.ts';

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

export async function spendBetween(tx: TenantClient, from: Date, to: Date): Promise<number> {
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
      `INSERT INTO spend_limits (company_id, money_max_cents, set_at) VALUES ($1, $2, now())
       ON CONFLICT (company_id) DO UPDATE SET money_max_cents = EXCLUDED.money_max_cents, set_at = now()`,
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

/** Clears a pause outright: the owner's reset, with their device. */
export async function clearSpendPause(companyId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `UPDATE spend_limits SET paused_at = NULL, pause_reason = NULL, override_until = NULL
        WHERE company_id = $1`,
      [companyId],
    );
    await withdrawPauseCard(tx, companyId, 'spend_resumed');
  });
}

/**
 * The card that said the company is paused, withdrawn once it is not: left
 * open, it asked the owner to lift a pause that had already gone.
 */
async function withdrawPauseCard(tx: TenantClient, companyId: string, reason: 'spend_resumed' | 'period_started'): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE inbox_items SET status = 'withdrawn', closed_reason = $2
      WHERE company_id = $1 AND kind = 'budget_alert' AND status = 'open' AND task_id IS NULL
        AND (payload ? 'spendPause' OR title = $3)
      RETURNING id`,
    [companyId, reason, PAUSED_TITLE],
  );
  for (const item of rows) {
    await appendEvent(tx, {
      companyId, type: 'inbox.withdrawn', actor: 'system', payload: { inboxItemId: item.id, closedReason: reason },
    });
  }
}

/**
 * The pause card's English title, matched as well as its payload for a card
 * raised before the payload was kept -- all of which were in English.
 */
const PAUSED_TITLE = 'Monthly budget reached; the company is paused';

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
  let already = await limitFor(companyId);

  // The ceiling is a month's, and so is its pause (M6). One set in a month
  // that has ended is lifted at the first look in the new one, with its
  // override, and the card that said so withdrawn; spending already at the
  // new month's ceiling pauses again below, for this month.
  if (already.pausedAt && already.pausedAt < spend.periodStart) {
    const pausedAt = already.pausedAt;
    await withControlPlane(async (tx) => {
      await tx.query(
        `UPDATE spend_limits SET paused_at = NULL, pause_reason = NULL, override_until = NULL
          WHERE company_id = $1 AND paused_at = $2`,
        [companyId, pausedAt],
      );
      await appendEvent(tx, {
        companyId,
        type: 'budget.period_resumed',
        actor: 'system',
        payload: { pausedAt: pausedAt.toISOString(), periodStart: spend.periodStart.toISOString() },
      });
      await withdrawPauseCard(tx, companyId, 'period_started');
    });
    already = await limitFor(companyId);
  }

  // A ceiling raised past what is spent is the owner's answer to the pause,
  // and the pause was never anything but "not past the ceiling": it lifts at
  // the next look, with its override, and its card goes. It took a second
  // decision -- "let spending resume" -- that said nothing the first had not
  // (the owner's report of 7 October).
  if (already.pausedAt && spend.fraction < 1) {
    await withControlPlane(async (tx) => {
      await tx.query(
        `UPDATE spend_limits SET paused_at = NULL, pause_reason = NULL, override_until = NULL
          WHERE company_id = $1 AND paused_at = $2`,
        [companyId, already.pausedAt],
      );
      await appendEvent(tx, {
        companyId,
        type: 'budget.pause_lifted',
        actor: 'system',
        payload: { reason: 'ceiling_raised', cents: spend.cents, limitCents: spend.limitCents },
      });
      await withdrawPauseCard(tx, companyId, 'spend_resumed');
    });
    already = await limitFor(companyId);
  }

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

      const card = spendPausedCard(await withTenant(companyId, ownerReadingWithin),
        { spentCents: spend.cents, limitCents: spend.limitCents, since: spend.periodStart });
      await inbox.raiseBudgetAlert({
        companyId,
        title: card.title,
        payload: { spendPause: { periodStart: spend.periodStart.toISOString() } },
        detail: card.detail,
      });
    }
    return { state: 'paused', spend };
  }

  if (spend.fraction >= 0.8) {
    if (await claimSlot(companyId, 'spend_period_warning', spend.periodStart)) {
      const card = spendWarnedCard(await withTenant(companyId, ownerReadingWithin),
        { spentCents: spend.cents, limitCents: spend.limitCents, since: spend.periodStart });
      await inbox.raiseBudgetAlert({ companyId, title: card.title, detail: card.detail });
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

/** A role's rate, with what the breaker needs to know of its freeze. */
interface RoleLook extends RoleRate {
  frozenBy: string | null;
  frozen: boolean;
}

const ROLE_SPEND_IN_WINDOW = `
  SELECT r.id AS role_id, r.slug, r.frozen_at IS NOT NULL AS frozen, r.frozen_by,
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
    FROM roles r`;

async function roleSpend(
  tx: TenantClient,
  from: Date,
  to: Date,
): Promise<Map<string, { slug: string; cents: number; frozen: boolean; frozenBy: string | null }>> {
  const { rows } = await tx.query<{ role_id: string; slug: string; cents: string; frozen: boolean; frozen_by: string | null }>(
    ROLE_SPEND_IN_WINDOW,
    [from, to],
  );
  return new Map(rows.map((row) => [row.role_id, { slug: row.slug, cents: Number(row.cents), frozen: row.frozen, frozenBy: row.frozen_by }]));
}

/**
 * Every role's last hour against its trailing week, frozen or not: a role the
 * breaker stopped is looked at again to see whether it has cooled.
 */
async function lookAtRoles(companyId: string, now: Date): Promise<RoleLook[]> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const baselineFrom = new Date(now.getTime() - BASELINE_HOURS * HOUR_MS);
  return withTenant(companyId, async (tx) => {
    const recent = await roleSpend(tx, hourAgo, now);
    const baseline = await roleSpend(tx, baselineFrom, now);

    const out: RoleLook[] = [];
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
        frozen: current.frozen,
        frozenBy: current.frozenBy,
      });
    }
    return out;
  });
}

/** Whether a role's rate is what F1.8 stops: past the floor, and past the multiple of its week. */
function isRunaway(rate: RoleRate, thresholds: { spendRateFloorCents: number; spendRateMultiple: number }): boolean {
  if (rate.lastHourCents < thresholds.spendRateFloorCents) return false;
  return rate.multiple !== null && rate.multiple > thresholds.spendRateMultiple;
}

/**
 * How many times the breaker may stop one role in a day before it stops
 * going on by itself. A burst is a thing that happens to a role; three in a
 * day is the role's usual being wrong, and the owner's to look at.
 */
const HOLD_AFTER_TRIPS = 3;

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
 *
 * The stop is for the length of the burst. The first two times in a day the
 * platform holds the role and lets it go again when the hour has passed
 * (`thawCooledRoles`), and the owner is not asked: there is a journalled
 * event, and the role says why it is stopped. The third time is a role, not a
 * burst: the owner gets the incident F1.8 asks for, and the role stays
 * stopped until they resume it.
 */
export async function evaluateCircuitBreakers(
  companyId: string,
  now = new Date(),
): Promise<RoleRate[]> {
  const thresholds = await thresholdsFor(companyId);
  const rates = (await lookAtRoles(companyId, now)).filter((rate) => !rate.frozen);

  const tripped: RoleRate[] = [];
  for (const rate of rates) {
    if (!isRunaway(rate, thresholds)) continue;

    const reason =
      `spent ${rate.lastHourCents} cents in the last hour against a seven-day average of ` +
      `${rate.baselineHourlyCents.toFixed(1)} cents an hour, which is ` +
      `${rate.multiple!.toFixed(1)} times its usual rate`;

    const held = await withControlPlane(async (tx) => {
      const dayAgo = new Date(now.getTime() - 24 * HOUR_MS);
      const { rows: before } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events
          WHERE company_id = $1 AND type = 'budget.circuit_open'
            AND payload->>'roleId' = $2 AND occurred_at > $3`,
        [companyId, rate.roleId, dayAgo],
      );
      const trips = (before[0]?.n ?? 0) + 1;
      const holds = trips >= HOLD_AFTER_TRIPS;
      const { rowCount } = await tx.query(
        `UPDATE roles SET frozen_at = now(), frozen_reason = $2, frozen_by = $4
          WHERE id = $1 AND company_id = $3 AND frozen_at IS NULL`,
        [rate.roleId, reason, companyId, holds ? 'spend_held' : 'spend'],
      );
      if (!rowCount) return null;
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
          trips,
          held: holds,
        },
      });
      return holds;
    });
    if (held === null) continue;

    if (held) {
      const card = await withTenant(companyId, async (tx) => roleSpendingFastCard(await ownerReadingWithin(tx), {
        role: await roleCalledWithin(tx, { id: rate.roleId }), lastHourCents: rate.lastHourCents,
        usualCents: rate.baselineHourlyCents, multiple: rate.multiple!, held: true,
      }));
      await inbox.raiseIncident({ companyId, title: card.title, detail: card.detail });
    }

    tripped.push(rate);
  }

  return tripped;
}

/**
 * Lets go of the roles the breaker stopped once the burst that stopped them
 * is out of the last hour.
 *
 * The test is the breaker's own, asked again: would this role trip now? A role
 * whose spending is still above the line stays stopped, and one that has
 * cooled goes back to work with the work that waited for it called back. Only
 * `spend` freezes are looked at. The owner's pause and F3.7's denials are
 * about something a clock does not change, and `spend_held` is the owner's by
 * the rule above, so none of them is ever lifted here.
 */
export async function thawCooledRoles(companyId: string, now = new Date()): Promise<string[]> {
  const thresholds = await thresholdsFor(companyId);
  const cooled = (await lookAtRoles(companyId, now))
    .filter((rate) => rate.frozen && rate.frozenBy === 'spend' && !isRunaway(rate, thresholds));
  const thawed: string[] = [];
  for (const rate of cooled) {
    const lifted = await withControlPlane(async (tx) => {
      // Looked at again inside the write: the owner may have paused the role
      // in the meantime, and that pause is theirs.
      const { rows } = await tx.query<{ frozen_by: string | null }>(
        'SELECT frozen_by FROM roles WHERE id = $1 AND company_id = $2 AND frozen_at IS NOT NULL FOR UPDATE',
        [rate.roleId, companyId],
      );
      if (rows[0]?.frozen_by !== 'spend') return false;
      await liftFreeze(tx, companyId, rate.roleId, 'cooled');
      return true;
    });
    if (lifted) thawed.push(rate.roleId);
  }
  return thawed;
}
