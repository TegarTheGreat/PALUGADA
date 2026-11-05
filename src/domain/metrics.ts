/**
 * What a goal is measured by, and the values recorded against it (0053).
 *
 * A key result used to be "done" when the tasks under it were. That measures
 * effort. An owner running several companies needs the other thing -- revenue
 * against a target, paying customers, conversion -- because it is the only way
 * to compare one company with another and decide where attention goes.
 *
 * The owner sets the metric: a unit, which way is better, a baseline and a
 * target, and optionally the capability whose answer is the number. Values are
 * recorded by the owner or by an agent through `metric.record`, and an agent's
 * value is **verified** only when the same task read that number from the
 * metric's source capability -- the journal shows a committed call to it whose
 * result contains the value. Otherwise it is kept, and shown, as the agent's
 * claim. It is the read-back rule (F8.4) applied to results instead of writes:
 * a number an agent typed and a number the ledger returned are different
 * kinds of fact, and everything downstream says which one it is looking at.
 *
 * A measure may also be a line on the weekly scorecard (0137, F18.2): reviewed
 * every week against a weekly goal, owned by one seat, and paired with the
 * measure that would suffer if it were pushed. `scorecardOf` reads those lines
 * as thirteen weeks in the company's time zone.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { wallClockAt } from '../scheduler/windows.ts';

export const METRIC_UNITS = ['currency', 'count', 'ratio', 'percent'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** How often a measure is reviewed: `week` puts it on the weekly scorecard (0137). */
export type ReviewEvery = 'week';

export interface MetricDefinition {
  goalId: string;
  slug: string;
  name: string;
  unit: MetricUnit;
  direction?: 'up' | 'down';
  baseline?: number;
  target: number;
  dueOn?: string | null;
  sourceCapability?: string | null;
  /** `week` for a line on the weekly scorecard, whose target is then the weekly goal. */
  reviewEvery?: ReviewEvery | null;
  /** The seat that answers for the number. */
  ownerRoleId?: string | null;
  /** The measure this one is watched with; the pair is written both ways. */
  pairedWith?: string | null;
  /** The card whose yes defined it, for the record: a plan of new goals (F18.7). */
  inboxItemId?: string;
}

export interface MetricView {
  id: string;
  goalId: string;
  slug: string;
  name: string;
  unit: MetricUnit;
  direction: 'up' | 'down';
  baseline: number;
  target: number;
  dueOn: string | null;
  sourceCapability: string | null;
  latest: { value: number; observedAt: Date; verified: boolean; recordedBy: string } | null;
  /** How far from baseline to target the latest value is, 0 to 1; null before the first value. */
  progress: number | null;
  /** The last twelve values, oldest first, for a line. */
  history: Array<{ value: number; observedAt: Date; verified: boolean }>;
  /** When the owner retired it (0069): kept for the record, no longer aimed at or recorded against. */
  retiredAt: Date | null;
  /** `week` for a line on the weekly scorecard (0137); null for a measure aimed at a target by a date. */
  reviewEvery: ReviewEvery | null;
  ownerRoleId: string | null;
  ownerRoleSlug: string | null;
  /** The id of the measure it is watched with, which names this one back. */
  pairedWith: string | null;
}

/** Baseline to target, clamped: a value past the target is done, not 140% done. */
export function progressOf(metric: { baseline: number; target: number }, value: number): number {
  const share = (value - metric.baseline) / (metric.target - metric.baseline);
  return Math.min(1, Math.max(0, share));
}

/** The owner defines a metric. On the control plane: the application role may not (0053). */
export async function defineMetric(companyId: string, input: MetricDefinition): Promise<string> {
  return withControlPlane((tx) => defineMetricWithin(tx, companyId, input));
}

/**
 * The same, inside a control-plane transaction the caller holds: the owner's
 * yes to a plan of new goals (inbox.decide, F18.7), so each goal and its
 * measure are made with the answer or not at all.
 */
export async function defineMetricWithin(tx: TenantClient, companyId: string, input: MetricDefinition): Promise<string> {
  if (!(METRIC_UNITS as readonly string[]).includes(input.unit)) {
    throw new PalugadaError('contract.violation', `unit must be one of ${METRIC_UNITS.join(', ')}`, { field: 'unit' });
  }
  if (!Number.isFinite(input.target) || !Number.isFinite(input.baseline ?? 0)) {
    throw new PalugadaError('contract.violation', 'baseline and target must be numbers', { field: 'target' });
  }
  if ((input.baseline ?? 0) === input.target) {
    throw new PalugadaError('contract.violation', 'the target must differ from the baseline, or there is nothing to measure', { field: 'target' });
  }
  assertReviewEvery(input.reviewEvery);
  const goal = await tx.query('SELECT 1 FROM goals WHERE id = $1 AND company_id = $2', [input.goalId, companyId]);
  if (goal.rowCount !== 1) {
    throw new PalugadaError('contract.violation', 'no such goal in this company', { field: 'goalId' });
  }
  if (input.ownerRoleId) await assertRoleIn(tx, companyId, input.ownerRoleId);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO goal_metrics (company_id, goal_id, slug, name, unit, direction, baseline, target, due_on, source_capability,
                               review_every, owner_role_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      companyId, input.goalId, input.slug, input.name, input.unit, input.direction ?? 'up',
      input.baseline ?? 0, input.target, input.dueOn ?? null, input.sourceCapability ?? null,
      input.reviewEvery ?? null, input.ownerRoleId ?? null,
    ],
  );
  const id = rows[0]!.id;
  if (input.pairedWith) {
    // Adding a measure takes no second factor because it loosens nothing;
    // taking a partner from a pair that exists would undo that pair, which
    // only a change to the measure -- under the factor -- may do.
    const taken = await tx.query<{ slug: string; partner: string }>(
      `SELECT m.slug, p.slug AS partner FROM goal_metrics m
         JOIN goal_metrics p ON p.company_id = m.company_id AND p.id = m.paired_metric_id
        WHERE m.company_id = $1 AND m.id::text = $2`,
      [companyId, input.pairedWith]);
    const held = taken.rows[0];
    if (held) {
      throw new PalugadaError('contract.violation',
        `the measure ${held.slug} is already paired with ${held.partner}; a new measure may be paired only with one that has no pair. ` +
        `To pair ${held.slug} with this one instead, add it unpaired and then change ${held.slug}, which takes your second factor`,
        { field: 'pairedWith' });
    }
    await pair(tx, companyId, id, input.pairedWith);
  }
  await appendEvent(tx, {
    companyId,
    type: 'metric.defined',
    actor: 'owner',
    payload: {
      metricId: id, goalId: input.goalId, slug: input.slug, target: input.target,
      reviewEvery: input.reviewEvery ?? null, ownerRoleId: input.ownerRoleId ?? null, pairedWith: input.pairedWith ?? null,
      ...(input.inboxItemId ? { inboxItemId: input.inboxItemId } : {}),
    },
  });
  return id;
}

function assertReviewEvery(value: unknown): void {
  if (value !== undefined && value !== null && value !== 'week') {
    throw new PalugadaError('contract.violation',
      `reviewEvery must be week, or null for a measure aimed at a target by a date; ${JSON.stringify(value)} is neither`,
      { field: 'reviewEvery' });
  }
}

async function assertRoleIn(tx: TenantClient, companyId: string, roleId: string): Promise<void> {
  const { rowCount } = await tx.query('SELECT 1 FROM roles WHERE id::text = $1 AND company_id = $2', [roleId, companyId]);
  if (rowCount !== 1) {
    throw new PalugadaError('contract.violation', 'no such role in this company to own the measure; name one of its roles by id', { field: 'ownerRoleId' });
  }
}

/**
 * Pairs two measures, or unpairs one (`partner` null). Each names the other,
 * and whatever either was paired with before lets go, so a pair always has
 * two members (0137 checks it when the transaction ends). One statement at a
 * time: the old pairs are cleared before the new one is written, or the
 * one-partner index would see three members for a moment.
 */
async function pair(tx: TenantClient, companyId: string, metricId: string, partner: string | null): Promise<void> {
  if (partner !== null) {
    if (partner === metricId) {
      throw new PalugadaError('contract.violation', 'a measure cannot be paired with itself; pair it with the one that would suffer if it were pushed', { field: 'pairedWith' });
    }
    const { rows } = await tx.query<{ id: string; slug: string; retired: boolean }>(
      `SELECT id, slug, retired_at IS NOT NULL AS retired FROM goal_metrics
        WHERE company_id = $1 AND id::text = ANY($2::text[])`,
      [companyId, [metricId, partner]]);
    if (!rows.some((row) => row.id === partner)) {
      throw new PalugadaError('contract.violation', `no measure ${partner} in this company to pair with; name one of its measures by id`, { field: 'pairedWith' });
    }
    const retired = rows.find((row) => row.retired);
    if (retired) {
      throw new PalugadaError('contract.violation', `the measure ${retired.slug} is retired; pair measures that are still measured`, { field: 'pairedWith' });
    }
  }
  const both = partner === null ? [metricId] : [metricId, partner];
  await tx.query(
    `UPDATE goal_metrics SET paired_metric_id = NULL
      WHERE company_id = $1 AND (id = ANY($2::uuid[]) OR paired_metric_id = ANY($2::uuid[]))`,
    [companyId, both]);
  if (partner === null) return;
  await tx.query('UPDATE goal_metrics SET paired_metric_id = $3 WHERE company_id = $1 AND id = $2', [companyId, metricId, partner]);
  await tx.query('UPDATE goal_metrics SET paired_metric_id = $3 WHERE company_id = $1 AND id = $2', [companyId, partner, metricId]);
}

/** What the owner may put right about a measure, and retiring it. */
export interface MetricChange {
  name?: string;
  unit?: MetricUnit;
  direction?: 'up' | 'down';
  baseline?: number;
  target?: number;
  dueOn?: string | null;
  sourceCapability?: string | null;
  retired?: boolean;
  reviewEvery?: ReviewEvery | null;
  ownerRoleId?: string | null;
  pairedWith?: string | null;
}

/**
 * The owner corrects a measure in place, or retires it (0069).
 *
 * The unit is fixed once a value is recorded against it: a history of counts
 * read as currency is a history that lies. A retired measure keeps its values
 * for the record and the export; the database refuses new ones, and it lets go
 * of its pair, whose partner would otherwise be watched with nothing.
 */
export async function changeMetric(companyId: string, metricId: string, change: MetricChange): Promise<void> {
  if (change.unit !== undefined && !(METRIC_UNITS as readonly string[]).includes(change.unit)) {
    throw new PalugadaError('contract.violation', `unit must be one of ${METRIC_UNITS.join(', ')}`, { field: 'unit' });
  }
  for (const field of ['baseline', 'target'] as const) {
    if (change[field] !== undefined && !Number.isFinite(change[field])) {
      throw new PalugadaError('contract.violation', `${field} must be a number`, { field });
    }
  }
  if (change.name !== undefined && !change.name.trim()) {
    throw new PalugadaError('contract.violation', 'a measure needs a name', { field: 'name' });
  }
  assertReviewEvery(change.reviewEvery);
  await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ unit: string; baseline: string; target: string; observed: number; retired_at: Date | null }>(
      `SELECT m.unit, m.baseline, m.target, m.retired_at,
              (SELECT count(*)::int FROM metric_observations o WHERE o.metric_id = m.id) AS observed
         FROM goal_metrics m WHERE m.id = $1 AND m.company_id = $2 FOR UPDATE`,
      [metricId, companyId]);
    const before = rows[0];
    if (!before) throw new PalugadaError('contract.violation', 'no such measure in this company', { field: 'metricId' });
    if (change.unit !== undefined && change.unit !== before.unit && before.observed > 0) {
      throw new PalugadaError('contract.violation',
        `the unit cannot change once values are recorded: ${before.observed} ${before.observed === 1 ? 'is' : 'are'}; retire this measure and define a new one`,
        { field: 'unit' });
    }
    const baseline = change.baseline ?? Number(before.baseline);
    const target = change.target ?? Number(before.target);
    if (baseline === target) {
      throw new PalugadaError('contract.violation', 'the target must differ from the baseline, or there is nothing to measure', { field: 'target' });
    }
    if (change.ownerRoleId) await assertRoleIn(tx, companyId, change.ownerRoleId);
    await tx.query(
      `UPDATE goal_metrics
          SET name = coalesce($3, name),
              unit = coalesce($4, unit),
              direction = coalesce($5, direction),
              baseline = $6,
              target = $7,
              due_on = CASE WHEN $8 THEN $9::date ELSE due_on END,
              source_capability = CASE WHEN $10 THEN $11 ELSE source_capability END,
              retired_at = CASE WHEN $12::boolean IS NULL THEN retired_at
                                WHEN $12 THEN coalesce(retired_at, now()) ELSE NULL END,
              review_every = CASE WHEN $13 THEN $14 ELSE review_every END,
              owner_role_id = CASE WHEN $15 THEN $16::uuid ELSE owner_role_id END
        WHERE id = $1 AND company_id = $2`,
      [
        metricId, companyId, change.name?.trim() ?? null, change.unit ?? null, change.direction ?? null, baseline, target,
        change.dueOn !== undefined, change.dueOn ?? null,
        change.sourceCapability !== undefined, change.sourceCapability ?? null,
        change.retired ?? null,
        change.reviewEvery !== undefined, change.reviewEvery ?? null,
        change.ownerRoleId !== undefined, change.ownerRoleId ?? null,
      ]);
    if (change.retired === true) {
      await pair(tx, companyId, metricId, null);
    } else if (change.pairedWith !== undefined) {
      await pair(tx, companyId, metricId, change.pairedWith);
    }
    await appendEvent(tx, {
      companyId,
      type: change.retired === true ? 'metric.retired' : 'metric.changed',
      actor: 'owner',
      payload: {
        metricId,
        changed: Object.keys(change),
        before: { unit: before.unit, baseline: Number(before.baseline), target: Number(before.target) },
      },
    });
  });
}

/**
 * Records a value.
 *
 * `recordedBy: 'agent'` needs the task that found it, and is verified only if
 * that task's journal holds a committed call to the metric's source capability
 * whose result contains this exact number. The owner's values are verified by
 * being the owner's.
 */
export async function recordObservation(
  tx: TenantClient,
  input: {
    companyId: string;
    metric: string;
    value: number;
    recordedBy: 'owner' | 'agent';
    taskId?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; verified: boolean; metricId: string }> {
  if (!Number.isFinite(input.value)) {
    throw new PalugadaError('contract.violation', 'value must be a number', { field: 'value' });
  }
  const { rows: found } = await tx.query<{ id: string; slug: string; source_capability: string | null; retired: boolean }>(
    'SELECT id, slug, source_capability, retired_at IS NOT NULL AS retired FROM goal_metrics WHERE id::text = $1 OR slug = $1',
    [input.metric],
  );
  const metric = found[0];
  if (!metric) {
    throw new PalugadaError('contract.violation', `no metric ${input.metric} in this company`, { field: 'metric' });
  }
  if (metric.retired) {
    throw new PalugadaError('contract.violation', `the measure ${metric.slug} is retired and takes no further values`, { field: 'metric' });
  }

  let verified = input.recordedBy === 'owner';
  if (input.recordedBy === 'agent' && metric.source_capability && input.taskId) {
    // The number as the source returned it: any number anywhere in the
    // committed result of a call to the source capability, in this task.
    const { rows } = await tx.query<{ read: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM task_steps
          WHERE task_id = $1 AND status = 'committed' AND name = $2
            AND output IS NOT NULL
            AND jsonb_path_exists(output, '$.** ? (@.type() == "number" && @ == $v)', jsonb_build_object('v', $3::numeric))
       ) AS read`,
      [input.taskId, `capability:${metric.source_capability}`, input.value],
    );
    verified = rows[0]?.read ?? false;
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO metric_observations (company_id, metric_id, value, task_id, verified, recorded_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.companyId, metric.id, input.value, input.taskId ?? null, verified, input.recordedBy, input.note ?? null],
  );
  await appendEvent(tx, {
    companyId: input.companyId,
    taskId: input.taskId ?? undefined,
    type: 'metric.recorded',
    actor: input.recordedBy === 'owner' ? 'owner' : 'agent_run',
    payload: { metricId: metric.id, value: input.value, verified },
  });
  return { id: rows[0]!.id, verified, metricId: metric.id };
}

/** Every metric in the company, with its latest value, progress and recent history. */
export async function metricsIn(tx: TenantClient): Promise<MetricView[]> {
  const { rows } = await tx.query<{
    id: string; goal_id: string; slug: string; name: string; unit: MetricUnit; direction: 'up' | 'down';
    baseline: string; target: string; due_on: string | null; source_capability: string | null; retired_at: Date | null;
    review_every: ReviewEvery | null; owner_role_id: string | null; owner_role_slug: string | null; paired_metric_id: string | null;
    history: Array<{ value: string; observed_at: string; verified: boolean; recorded_by: string }> | null;
  }>(
    `SELECT m.id, m.goal_id, m.slug, m.name, m.unit, m.direction, m.baseline, m.target,
            to_char(m.due_on, 'YYYY-MM-DD') AS due_on, m.source_capability, m.retired_at,
            m.review_every, m.owner_role_id, r.slug AS owner_role_slug, m.paired_metric_id,
            (SELECT jsonb_agg(h ORDER BY h.observed_at)
               FROM (SELECT value, observed_at, verified, recorded_by
                       FROM metric_observations o
                      WHERE o.metric_id = m.id
                      ORDER BY observed_at DESC LIMIT 12) h) AS history
       FROM goal_metrics m
       LEFT JOIN roles r ON r.company_id = m.company_id AND r.id = m.owner_role_id
      ORDER BY m.created_at, m.id`,
  );
  return rows.map((row) => {
    const baseline = Number(row.baseline);
    const target = Number(row.target);
    const history = (row.history ?? []).map((point) => ({
      value: Number(point.value), observedAt: new Date(point.observed_at), verified: point.verified, recordedBy: point.recorded_by,
    }));
    const last = history.at(-1) ?? null;
    return {
      id: row.id,
      goalId: row.goal_id,
      slug: row.slug,
      name: row.name,
      unit: row.unit,
      direction: row.direction,
      baseline,
      target,
      dueOn: row.due_on,
      sourceCapability: row.source_capability,
      latest: last ? { value: last.value, observedAt: last.observedAt, verified: last.verified, recordedBy: last.recordedBy } : null,
      progress: last ? progressOf({ baseline, target }, last.value) : null,
      history: history.map(({ value, observedAt, verified }) => ({ value, observedAt, verified })),
      retiredAt: row.retired_at,
      reviewEvery: row.review_every,
      ownerRoleId: row.owner_role_id,
      ownerRoleSlug: row.owner_role_slug,
      pairedWith: row.paired_metric_id,
    };
  });
}

/** How many weeks of history a scorecard line shows: a quarter, so a trend can be told from a bad week. */
export const SCORECARD_WEEKS = 13;
/**
 * The size a weekly scorecard is read well at. Below it the numbers cannot
 * tell the owner that something is wrong before it shows in the money; above
 * it nobody reads them all every week. A warning, never a refusal.
 */
export const SCORECARD_LINES = { fewest: 5, most: 15 } as const;

/**
 * Where a week stands. `claimed` is a number an agent reported and did not
 * read from its source: shown, and judged neither way. `not_reported` is a
 * week with no reading at all, which is a different failure from a number
 * that missed.
 */
export type WeekState = 'on_track' | 'off_track' | 'claimed' | 'not_reported';

export interface ScorecardWeek {
  /** The Monday the ISO week starts on, where the company is (`YYYY-MM-DD`). */
  week: string;
  value: number | null;
  verified: boolean | null;
  state: WeekState;
}

export interface ScorecardLine {
  metricId: string;
  goalId: string;
  slug: string;
  name: string;
  unit: MetricUnit;
  direction: 'up' | 'down';
  /** The weekly goal. */
  target: number;
  sourceCapability: string | null;
  /** The seat that answers for it, as the owner named it. */
  ownerRole: { id: string; slug: string; displayName: string | null; title: string | null } | null;
  /** The measure it is watched with, which may be a target measure rather than a line. */
  pairedWith: string | null;
  pair: { id: string; slug: string; name: string } | null;
  /** Oldest first, ending with this week. */
  weeks: ScorecardWeek[];
  /** This week's state. */
  state: WeekState;
}

export interface Scorecard {
  timezone: string;
  /** The Mondays of the weeks shown, oldest first. */
  weeks: string[];
  lines: ScorecardLine[];
  warning: { kind: 'too_few' | 'too_many'; lines: number; fewest: number; most: number } | null;
}

const DAY_MS = 86_400_000;

/** The Monday of the ISO week a calendar day (`YYYY-MM-DD`) is in. */
function mondayOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const sinceMonday = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The weekly scorecard (F18.2): every live measure reviewed weekly, under a
 * goal that is still active, with thirteen ISO weeks of readings counted in
 * the company's time zone.
 *
 * Each week shows its last verified reading, judged against the weekly goal in
 * the measure's direction. A week with only an agent's unverified reading
 * shows that number as claimed, and a week with nothing is not reported: a
 * line is on track only on a number somebody can stand behind. The weeks are
 * found from each reading's wall-clock day where the company is, not from a
 * fixed offset, so a reading late on the Sunday a clock goes back stays in the
 * week that is ending.
 *
 * Pairs are put side by side, whatever order they were made in.
 */
export async function scorecardOf(tx: TenantClient, companyId: string, now: Date): Promise<Scorecard> {
  const zones = await tx.query<{ timezone: string }>('SELECT timezone FROM companies WHERE id = $1', [companyId]);
  let timezone = zones.rows[0]?.timezone ?? 'UTC';
  // A zone this platform cannot read counts in UTC rather than drawing nothing.
  try {
    wallClockAt(timezone, 0);
  } catch {
    timezone = 'UTC';
  }
  const dayOf = (instant: Date) => new Date(wallClockAt(timezone, instant.getTime())).toISOString().slice(0, 10);
  const thisWeek = mondayOf(dayOf(now));
  const weeks = Array.from({ length: SCORECARD_WEEKS }, (_, index) =>
    new Date(Date.parse(`${thisWeek}T00:00:00Z`) - (SCORECARD_WEEKS - 1 - index) * 7 * DAY_MS).toISOString().slice(0, 10));

  const { rows } = await tx.query<{
    id: string; goal_id: string; slug: string; name: string; unit: MetricUnit; direction: 'up' | 'down'; target: string;
    source_capability: string | null; owner_role_id: string | null; owner_slug: string | null;
    owner_display_name: string | null; owner_title: string | null;
    paired_metric_id: string | null; pair_slug: string | null; pair_name: string | null;
  }>(
    `SELECT m.id, m.goal_id, m.slug, m.name, m.unit, m.direction, m.target, m.source_capability,
            m.owner_role_id, r.slug AS owner_slug, r.display_name AS owner_display_name, r.title AS owner_title,
            m.paired_metric_id, p.slug AS pair_slug, p.name AS pair_name
       FROM goal_metrics m
       JOIN goals g ON g.company_id = m.company_id AND g.id = m.goal_id AND g.status = 'active'
       LEFT JOIN roles r ON r.company_id = m.company_id AND r.id = m.owner_role_id
       LEFT JOIN goal_metrics p ON p.company_id = m.company_id AND p.id = m.paired_metric_id
      WHERE m.company_id = $1 AND m.review_every = 'week' AND m.retired_at IS NULL
      ORDER BY m.created_at, m.id`,
    [companyId]);

  // A day either side of the thirteen weeks, so no offset of any zone cuts a
  // reading off; the buckets decide what is in.
  const from = new Date(Date.parse(`${weeks[0]}T00:00:00Z`) - DAY_MS);
  const readings = await tx.query<{ metric_id: string; value: string; observed_at: Date; verified: boolean }>(
    `SELECT metric_id, value, observed_at, verified FROM metric_observations
      WHERE company_id = $1 AND metric_id = ANY($2::uuid[]) AND observed_at >= $3 AND observed_at <= $4
      ORDER BY observed_at, id`,
    [companyId, rows.map((row) => row.id), from, now]);
  const byWeek = new Map<string, { verified?: number; claimed?: number }>();
  for (const reading of readings.rows) {
    const key = `${reading.metric_id} ${mondayOf(dayOf(reading.observed_at))}`;
    const week = byWeek.get(key) ?? {};
    // In time order, so the last one written into each slot is the week's last.
    if (reading.verified) week.verified = Number(reading.value);
    else week.claimed = Number(reading.value);
    byWeek.set(key, week);
  }

  const lines = rows.map((row): ScorecardLine => {
    const target = Number(row.target);
    const met = (value: number) => (row.direction === 'up' ? value >= target : value <= target);
    const shown = weeks.map((week): ScorecardWeek => {
      const found = byWeek.get(`${row.id} ${week}`);
      if (found?.verified !== undefined) {
        return { week, value: found.verified, verified: true, state: met(found.verified) ? 'on_track' : 'off_track' };
      }
      if (found?.claimed !== undefined) return { week, value: found.claimed, verified: false, state: 'claimed' };
      return { week, value: null, verified: null, state: 'not_reported' };
    });
    return {
      metricId: row.id,
      goalId: row.goal_id,
      slug: row.slug,
      name: row.name,
      unit: row.unit,
      direction: row.direction,
      target,
      sourceCapability: row.source_capability,
      ownerRole: row.owner_role_id
        ? { id: row.owner_role_id, slug: row.owner_slug!, displayName: row.owner_display_name, title: row.owner_title }
        : null,
      pairedWith: row.paired_metric_id,
      pair: row.paired_metric_id ? { id: row.paired_metric_id, slug: row.pair_slug!, name: row.pair_name! } : null,
      weeks: shown,
      state: shown.at(-1)!.state,
    };
  });

  // Each line followed by its partner, when the partner is a line too.
  const ordered: ScorecardLine[] = [];
  const placed = new Set<string>();
  for (const line of lines) {
    if (placed.has(line.metricId)) continue;
    placed.add(line.metricId);
    ordered.push(line);
    const partner = lines.find((one) => one.metricId === line.pairedWith);
    if (partner && !placed.has(partner.metricId)) {
      placed.add(partner.metricId);
      ordered.push(partner);
    }
  }

  const count = ordered.length;
  const warning = count < SCORECARD_LINES.fewest || count > SCORECARD_LINES.most
    ? { kind: count < SCORECARD_LINES.fewest ? 'too_few' as const : 'too_many' as const, lines: count, ...SCORECARD_LINES }
    : null;
  return { timezone, weeks, lines: ordered, warning };
}

/** The one number a company is judged by at a glance, for the portfolio. */
export interface Headline {
  name: string;
  unit: MetricUnit;
  target: number;
  value: number | null;
  verified: boolean | null;
  progress: number | null;
}

/**
 * Each company's headline, on the control plane: the first metric set on its
 * highest active goal -- a mission's before an objective's before a key
 * result's -- with where it stands. Only a measure aimed at a target counts.
 *
 * One human running several companies decides where attention goes by
 * comparing them, and a count of finished tasks does not compare: ten done in
 * a company that is losing money is not ahead of two done in one that is
 * growing. A company with no metric has no headline, and says so, rather than
 * being ranked on effort.
 */
export async function headlines(tx: TenantClient): Promise<Map<string, Headline>> {
  const { rows } = await tx.query<{
    company_id: string; name: string; unit: MetricUnit; baseline: string; target: string;
    value: string | null; verified: boolean | null;
  }>(
    `SELECT DISTINCT ON (m.company_id)
            m.company_id, m.name, m.unit, m.baseline, m.target, o.value, o.verified
       FROM goal_metrics m
       JOIN goals g ON g.company_id = m.company_id AND g.id = m.goal_id AND g.status = 'active'
       LEFT JOIN LATERAL (
              SELECT value, verified FROM metric_observations o
               WHERE o.company_id = m.company_id AND o.metric_id = m.id
               ORDER BY observed_at DESC LIMIT 1) o ON true
      -- A retired measure is history (0069), not what a company is judged by;
      -- and a weekly line (0137) has a weekly goal, not a target to make
      -- progress toward, so the scorecard is where it is read.
      WHERE m.retired_at IS NULL AND m.review_every IS NULL
      ORDER BY m.company_id,
               CASE g.kind WHEN 'mission' THEN 0 WHEN 'objective' THEN 1 ELSE 2 END,
               m.created_at`,
  );
  return new Map(rows.map((row) => {
    const baseline = Number(row.baseline);
    const target = Number(row.target);
    const value = row.value === null ? null : Number(row.value);
    return [row.company_id, {
      name: row.name,
      unit: row.unit,
      target,
      value,
      verified: row.verified,
      progress: value === null ? null : progressOf({ baseline, target }, value),
    }];
  }));
}

/**
 * The metrics on a task's goal chain, as a run is told them: what the work is
 * measured by, where it stands, and whether that standing is a verified
 * number or somebody's claim.
 *
 * A measure with a pair is told with its pair under it, from `pool` when the
 * pair hangs from a goal off the chain (F18.2): a run that sees only the
 * number it is pushing cannot tell that it is buying it with the other.
 */
export function renderMetrics(metrics: MetricView[], pool: MetricView[] = metrics): string {
  const told = new Set<string>();
  const lines: string[] = [];
  for (const metric of metrics) {
    if (told.has(metric.id)) continue;
    told.add(metric.id);
    lines.push(metricLine(metric));
    const partner = metric.pairedWith ? pool.find((one) => one.id === metric.pairedWith && !one.retiredAt) : undefined;
    if (partner && !told.has(partner.id)) {
      told.add(partner.id);
      lines.push(`  Paired with ${partner.name} [${partner.slug}] -- watch both: moving this one at the other's cost is not progress.`);
      lines.push(`  ${metricLine(partner)}`);
    }
  }
  return lines.join('\n');
}

function metricLine(metric: MetricView): string {
  const standing = metric.latest
    ? `now ${metric.latest.value} (${metric.latest.verified ? 'verified' : 'UNVERIFIED -- not read back from its source'}, ${metric.latest.observedAt.toISOString().slice(0, 10)})`
    : 'no value recorded yet';
  const aim = metric.reviewEvery === 'week'
    ? `reviewed every week against a weekly goal of ${metric.target} ${metric.unit}`
    : `from ${metric.baseline} to ${metric.target} ${metric.unit}${metric.dueOn ? ` by ${metric.dueOn}` : ''}`;
  return `- ${metric.name} [${metric.slug}]: ${aim}, ${metric.direction === 'up' ? 'higher is better' : 'lower is better'}; ${standing}.` +
    (metric.ownerRoleSlug ? ` The seat ${metric.ownerRoleSlug} answers for it.` : '') +
    (metric.sourceCapability ? ` Read it with ${metric.sourceCapability} and record it with metric.record.` : ' Record it with metric.record.');
}
