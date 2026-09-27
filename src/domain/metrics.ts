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
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

export const METRIC_UNITS = ['currency', 'count', 'ratio', 'percent'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

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
}

/** Baseline to target, clamped: a value past the target is done, not 140% done. */
export function progressOf(metric: { baseline: number; target: number }, value: number): number {
  const share = (value - metric.baseline) / (metric.target - metric.baseline);
  return Math.min(1, Math.max(0, share));
}

/** The owner defines a metric. On the control plane: the application role may not (0053). */
export async function defineMetric(companyId: string, input: MetricDefinition): Promise<string> {
  if (!(METRIC_UNITS as readonly string[]).includes(input.unit)) {
    throw new PalugadaError('contract.violation', `unit must be one of ${METRIC_UNITS.join(', ')}`, { field: 'unit' });
  }
  if (!Number.isFinite(input.target) || !Number.isFinite(input.baseline ?? 0)) {
    throw new PalugadaError('contract.violation', 'baseline and target must be numbers', { field: 'target' });
  }
  if ((input.baseline ?? 0) === input.target) {
    throw new PalugadaError('contract.violation', 'the target must differ from the baseline, or there is nothing to measure', { field: 'target' });
  }
  return withControlPlane(async (tx) => {
    const goal = await tx.query('SELECT 1 FROM goals WHERE id = $1 AND company_id = $2', [input.goalId, companyId]);
    if (goal.rowCount !== 1) {
      throw new PalugadaError('contract.violation', 'no such goal in this company', { field: 'goalId' });
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO goal_metrics (company_id, goal_id, slug, name, unit, direction, baseline, target, due_on, source_capability)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        companyId, input.goalId, input.slug, input.name, input.unit, input.direction ?? 'up',
        input.baseline ?? 0, input.target, input.dueOn ?? null, input.sourceCapability ?? null,
      ],
    );
    await appendEvent(tx, {
      companyId,
      type: 'metric.defined',
      actor: 'owner',
      payload: { metricId: rows[0]!.id, goalId: input.goalId, slug: input.slug, target: input.target },
    });
    return rows[0]!.id;
  });
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
}

/**
 * The owner corrects a measure in place, or retires it (0069).
 *
 * The unit is fixed once a value is recorded against it: a history of counts
 * read as currency is a history that lies. A retired measure keeps its values
 * for the record and the export; the database refuses new ones.
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
                                WHEN $12 THEN coalesce(retired_at, now()) ELSE NULL END
        WHERE id = $1 AND company_id = $2`,
      [
        metricId, companyId, change.name?.trim() ?? null, change.unit ?? null, change.direction ?? null, baseline, target,
        change.dueOn !== undefined, change.dueOn ?? null,
        change.sourceCapability !== undefined, change.sourceCapability ?? null,
        change.retired ?? null,
      ]);
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
    history: Array<{ value: string; observed_at: string; verified: boolean; recorded_by: string }> | null;
  }>(
    `SELECT m.id, m.goal_id, m.slug, m.name, m.unit, m.direction, m.baseline, m.target,
            to_char(m.due_on, 'YYYY-MM-DD') AS due_on, m.source_capability, m.retired_at,
            (SELECT jsonb_agg(h ORDER BY h.observed_at)
               FROM (SELECT value, observed_at, verified, recorded_by
                       FROM metric_observations o
                      WHERE o.metric_id = m.id
                      ORDER BY observed_at DESC LIMIT 12) h) AS history
       FROM goal_metrics m
      ORDER BY m.created_at`,
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
    };
  });
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
 * result's -- with where it stands.
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
      -- A retired measure is history (0069), not what a company is judged by.
      WHERE m.retired_at IS NULL
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
 */
export function renderMetrics(metrics: MetricView[]): string {
  return metrics.map((metric) => {
    const standing = metric.latest
      ? `now ${metric.latest.value} (${metric.latest.verified ? 'verified' : 'UNVERIFIED -- not read back from its source'}, ${metric.latest.observedAt.toISOString().slice(0, 10)})`
      : 'no value recorded yet';
    return `- ${metric.name} [${metric.slug}]: from ${metric.baseline} to ${metric.target} ${metric.unit}` +
      `${metric.dueOn ? ` by ${metric.dueOn}` : ''}, ${metric.direction === 'up' ? 'higher is better' : 'lower is better'}; ${standing}.` +
      (metric.sourceCapability ? ` Read it with ${metric.sourceCapability} and record it with metric.record.` : ' Record it with metric.record.');
  }).join('\n');
}
