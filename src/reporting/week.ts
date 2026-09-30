/**
 * The week, as a cadence that asks for it is handed it (company-os's weekly
 * business review).
 *
 * The review's skill asks for every goal metric against its target and its
 * change since last week, what shipped, and whether each piece of work should
 * continue -- and its task was given one sentence. A run is shown the metrics
 * of its own goal chain (context/builder.ts), and the review's chain is the
 * mission, so every number set on an objective or a key result was out of its
 * sight, and so was the week's work. `buildWeeklyRetro` had the week and only
 * the owner's API called it. The scheduler now puts this into the task's
 * input when it fires a schedule whose input names `facts: 'week'`.
 *
 * Built from rows, never from a model: a review that reported a number a
 * model had summarised would be reporting the model. Bounded, because it
 * travels with every step of the run: each list stops at a length and says
 * how many it left out, and each line of prose is cut to one line.
 */
import { withTenant } from '../db/tenant.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { outsideContentIn } from '../engine/tasks.ts';
import { periodSpend, spendBetween } from '../governance/spend-guard.ts';
import { stageOf, type Stage } from '../domain/stage.ts';
import type { GoalKind } from '../domain/goals.ts';
import type { MetricUnit } from '../domain/metrics.ts';
import { buildWeeklyRetro, type WeeklyRetro } from './digest.ts';

const WEEK_MS = 7 * 86_400_000;
/** The most of each the brief carries; past it, it says how many it left out. */
const GOALS_MAX = 25;
const METRICS_MAX = 40;
const FINISHED_MAX = 20;
/** One line each: a statement, what a task was for, what it reported. */
const STATEMENT_MAX = 200;
const TASK_GOAL_MAX = 120;
const RESULT_MAX = 200;

export interface WeekMetric {
  slug: string;
  name: string;
  unit: MetricUnit;
  direction: 'up' | 'down';
  baseline: number;
  target: number;
  dueOn: string | null;
  /** The latest value, and whether it was read back from its source or is somebody's claim. */
  last: number | null;
  verified: boolean | null;
  observedAt: string | null;
  /** The latest value recorded a week or more ago, and how far the number has moved since. */
  weekAgo: number | null;
  change: number | null;
}

export interface WeekFacts {
  from: string;
  to: string;
  stage: Stage | null;
  retro: Omit<WeeklyRetro, 'companyId'>;
  /** Every active goal, by the slug `goal.propose` takes, with its measures. */
  goals: Array<{ slug: string; kind: GoalKind; statement: string; metrics: WeekMetric[] }>;
  goalsLeftOut: number;
  metricsLeftOut: number;
  /** Work the company was given and finished this week, newest first, one line each. */
  finished: Array<{ task: string; role: string; goal: string; result: string | null; outside?: true }>;
  finishedLeftOut: number;
  spend: { weekCents: number; monthCents: number; monthLimitCents: number };
  /** A stage move a run proposed and the owner has not answered. */
  stageProposal: { from: Stage | null; to: Stage; inboxItemId: string } | null;
}

/** Text as one line, cut to a length. */
function oneLine(text: string | null, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function buildWeekFacts(companyId: string, to = new Date()): Promise<WeekFacts> {
  const from = new Date(to.getTime() - WEEK_MS);
  // Each in its own transaction, one after the other: the retro and the
  // month's spend are the same numbers the owner's pages show, read the way
  // those pages read them.
  const { companyId: _company, ...retro } = await buildWeeklyRetro(companyId, to);
  const month = await periodSpend(companyId, to);

  return withTenant(companyId, async (tx) => {
    const { rows: goalRows } = await tx.query<{
      id: string; slug: string; kind: GoalKind; statement: string; total: number;
    }>(
      `SELECT id, slug, kind, statement, count(*) OVER ()::int AS total
         FROM goals WHERE status = 'active'
        ORDER BY CASE kind WHEN 'mission' THEN 0 WHEN 'objective' THEN 1 ELSE 2 END, created_at
        LIMIT $1`,
      [GOALS_MAX],
    );

    // A retired measure is history (0069), and one on a closed goal is aimed
    // at nothing; neither is what the week is judged by.
    const { rows: metricRows } = await tx.query<{
      goal_id: string; slug: string; name: string; unit: MetricUnit; direction: 'up' | 'down';
      baseline: string; target: string; due_on: string | null;
      last: string | null; verified: boolean | null; observed_at: Date | null; week_ago: string | null; total: number;
    }>(
      `SELECT m.goal_id, m.slug, m.name, m.unit, m.direction, m.baseline, m.target,
              to_char(m.due_on, 'YYYY-MM-DD') AS due_on,
              last.value AS last, last.verified, last.observed_at, before.value AS week_ago,
              count(*) OVER ()::int AS total
         FROM goal_metrics m
         JOIN goals g ON g.company_id = m.company_id AND g.id = m.goal_id AND g.status = 'active'
         LEFT JOIN LATERAL (
                SELECT value, verified, observed_at FROM metric_observations o
                 WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.observed_at <= $2
                 ORDER BY observed_at DESC LIMIT 1) last ON true
         LEFT JOIN LATERAL (
                SELECT value FROM metric_observations o
                 WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.observed_at <= $1
                 ORDER BY observed_at DESC LIMIT 1) before ON true
        WHERE m.retired_at IS NULL
        ORDER BY m.created_at
        LIMIT $3`,
      [from, to, METRICS_MAX],
    );

    // The work the company was given, not the pieces it split it into: a
    // delegated child's result is in its parent's, and listing both would
    // spend the brief on the same work twice.
    const { rows: finishedRows } = await tx.query<{
      id: string; role: string; goal: string | null; summary: string | null; total: number;
    }>(
      `SELECT t.id, r.slug AS role, t.input->>'goal' AS goal,
              CASE WHEN jsonb_typeof(t.output->'summary') = 'string' THEN t.output->>'summary' END AS summary,
              count(*) OVER ()::int AS total
         FROM tasks t JOIN roles r ON r.id = t.role_id
        WHERE t.status = 'completed' AND t.parent_task_id IS NULL
          AND t.finished_at >= $1 AND t.finished_at < $2
        ORDER BY t.finished_at DESC, t.id
        LIMIT $3`,
      [from, to, FINISHED_MAX],
    );
    const finished: WeekFacts['finished'] = [];
    for (const row of finishedRows) {
      const result = oneLine(row.summary, RESULT_MAX) || null;
      // What a run reported after reading an email or a web page is data,
      // however it reaches the next run (F8.9); the caller marks the review
      // as carrying it.
      const outside = (await outsideContentIn(tx, row.id)) !== null;
      finished.push({
        task: row.id,
        role: row.role,
        goal: oneLine(row.goal, TASK_GOAL_MAX),
        result: result && outside ? wrapUntrusted(`task:${row.id}`, result) : result,
        ...(outside ? { outside: true as const } : {}),
      });
    }

    const { rows: proposals } = await tx.query<{ id: string; from: Stage | null; to: Stage }>(
      `SELECT id, payload->'stageChange'->>'from' AS from, payload->'stageChange'->>'to' AS to
         FROM inbox_items
        WHERE status = 'open' AND kind = 'escalation' AND payload ? 'stageChange'
        ORDER BY created_at DESC LIMIT 1`,
    );

    const metricsOf = (goalId: string): WeekMetric[] => metricRows
      .filter((row) => row.goal_id === goalId)
      .map((row) => {
        const last = row.last === null ? null : Number(row.last);
        const weekAgo = row.week_ago === null ? null : Number(row.week_ago);
        return {
          slug: row.slug,
          name: row.name,
          unit: row.unit,
          direction: row.direction,
          baseline: Number(row.baseline),
          target: Number(row.target),
          dueOn: row.due_on,
          last,
          verified: row.verified,
          observedAt: row.observed_at?.toISOString() ?? null,
          weekAgo,
          change: last !== null && weekAgo !== null ? last - weekAgo : null,
        };
      });

    const goals = goalRows.map((goal) => ({
      slug: goal.slug,
      kind: goal.kind,
      statement: oneLine(goal.statement, STATEMENT_MAX),
      metrics: metricsOf(goal.id),
    }));
    const shownMetrics = goals.reduce((sum, goal) => sum + goal.metrics.length, 0);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      stage: await stageOf(tx, companyId),
      retro,
      goals,
      goalsLeftOut: Math.max(0, (goalRows[0]?.total ?? 0) - goalRows.length),
      // Past the limit, or under a goal past the goals' limit: either way
      // not shown, and counted so the review can say so.
      metricsLeftOut: Math.max(0, (metricRows[0]?.total ?? 0) - shownMetrics),
      finished,
      finishedLeftOut: Math.max(0, (finishedRows[0]?.total ?? 0) - finishedRows.length),
      spend: {
        weekCents: await spendBetween(tx, from, to),
        monthCents: month.cents,
        monthLimitCents: month.limitCents,
      },
      stageProposal: proposals[0] ? { from: proposals[0].from, to: proposals[0].to, inboxItemId: proposals[0].id } : null,
    };
  });
}
