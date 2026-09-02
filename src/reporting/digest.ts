/**
 * Daily digest and weekly retro (PRD F9.4, F10.6).
 *
 * F10.6 sets a hard constraint: the digest must fit one screen. That is a
 * design requirement, not a formatting preference. An owner who has to scroll
 * a daily summary stops reading it within a week, at which point the digest
 * has become a way of *not* informing them while appearing to.
 *
 * So the digest reports six numbers and at most a handful of lines, and
 * anything that needs a decision is an inbox item rather than a paragraph
 * here. The digest tells the owner whether to look; the inbox is where they
 * act.
 */
import { withTenant } from '../db/tenant.ts';
import { recall } from '../memory/store.ts';
import { costBreakdown } from './cost.ts';

export interface DailyDigest {
  companyId: string;
  day: string;
  moneySpentCents: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksHalted: number;
  openInboxItems: number;
  openIncidents: number;
  /** At most a few lines. Anything longer belongs in the inbox. */
  highlights: string[];
}

/** Kept small on purpose: F10.6's one-screen limit is the requirement. */
const MAX_HIGHLIGHTS = 5;

export async function buildDailyDigest(companyId: string, day = new Date()): Promise<DailyDigest> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      money_spent_cents: string;
      completed: string;
      failed: string;
      halted: string;
      open_items: string;
      open_incidents: string;
    }>(
      `WITH bounds AS (
         SELECT date_trunc('day', $1::timestamptz) AS from_at,
                date_trunc('day', $1::timestamptz) + interval '1 day' AS to_at
       )
       SELECT
         (SELECT coalesce(sum(cost_cents), 0)::text FROM llm_traces, bounds
           WHERE occurred_at >= bounds.from_at AND occurred_at < bounds.to_at)
           AS money_spent_cents,
         (SELECT count(*)::text FROM tasks, bounds
           WHERE status = 'completed'
             AND finished_at >= bounds.from_at AND finished_at < bounds.to_at) AS completed,
         (SELECT count(*)::text FROM tasks, bounds
           WHERE status = 'failed'
             AND finished_at >= bounds.from_at AND finished_at < bounds.to_at) AS failed,
         (SELECT count(*)::text FROM tasks, bounds
           WHERE status = 'halted'
             AND finished_at >= bounds.from_at AND finished_at < bounds.to_at) AS halted,
         (SELECT count(*)::text FROM inbox_items WHERE status = 'open') AS open_items,
         (SELECT count(*)::text FROM inbox_items
           WHERE status = 'open' AND kind = 'incident') AS open_incidents`,
      [day],
    );
    const row = rows[0]!;

    // Highlights are drawn from what stopped rather than from what worked:
    // a completed task needs no attention, and listing them would spend the
    // owner's screen on reassurance.
    const { rows: haltRows } = await tx.query<{ halt_reason: string; count: string }>(
      `SELECT halt_reason, count(*)::text AS count
         FROM tasks
        WHERE halt_reason IS NOT NULL
          AND finished_at >= date_trunc('day', $1::timestamptz)
          AND finished_at < date_trunc('day', $1::timestamptz) + interval '1 day'
        GROUP BY 1 ORDER BY 2 DESC LIMIT $2`,
      [day, MAX_HIGHLIGHTS],
    );

    return {
      companyId,
      day: day.toISOString().slice(0, 10),
      moneySpentCents: Number(row.money_spent_cents),
      tasksCompleted: Number(row.completed),
      tasksFailed: Number(row.failed),
      tasksHalted: Number(row.halted),
      openInboxItems: Number(row.open_items),
      openIncidents: Number(row.open_incidents),
      highlights: haltRows.map((halt) => `${halt.count} task(s) stopped: ${halt.halt_reason}`),
    };
  });
}

/** Renders the digest as the one screen F10.6 asks for. */
export function renderDailyDigest(digest: DailyDigest): string {
  const lines = [
    `Digest for ${digest.day}`,
    `Spend: ${(digest.moneySpentCents / 100).toFixed(2)}`,
    `Tasks: ${digest.tasksCompleted} done, ${digest.tasksFailed} failed, ${digest.tasksHalted} halted`,
    `Inbox: ${digest.openInboxItems} open (${digest.openIncidents} incident${digest.openIncidents === 1 ? '' : 's'})`,
    ...digest.highlights,
  ];
  return lines.join('\n');
}

export interface WeeklyRetro {
  companyId: string;
  weekEnding: string;
  tasksCompleted: number;
  tasksStopped: number;
  moneySpentCents: number;
  costliestDivisions: Array<{ label: string; costCents: number }>;
  sopCandidatesPending: number;
  decisionsRecorded: number;
}

/**
 * The weekly retro (F9.4).
 *
 * Where the digest asks "is anything wrong today", the retro asks "is this
 * company getting better" -- so it reports the learning signals section 11
 * measures: candidate SOPs waiting, decisions recorded, and where the money
 * went.
 */
export async function buildWeeklyRetro(
  companyId: string,
  weekEnding = new Date(),
): Promise<WeeklyRetro> {
  const from = new Date(weekEnding.getTime() - 7 * 86_400_000);

  const [divisions, summary] = await Promise.all([
    costBreakdown(companyId, 'division', { from, to: weekEnding }),
    withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{
        completed: string;
        stopped: string;
        money_spent_cents: string;
        decisions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM tasks
             WHERE status = 'completed' AND finished_at >= $1 AND finished_at < $2) AS completed,
           (SELECT count(*)::text FROM tasks
             WHERE status IN ('failed', 'halted')
               AND finished_at >= $1 AND finished_at < $2) AS stopped,
           (SELECT coalesce(sum(cost_cents), 0)::text FROM llm_traces
             WHERE occurred_at >= $1 AND occurred_at < $2) AS money_spent_cents,
           (SELECT count(*)::text FROM decision_records
             WHERE created_at >= $1 AND created_at < $2) AS decisions`,
        [from, weekEnding],
      );
      return rows[0]!;
    }),
  ]);

  const candidates = await withTenant(companyId, (tx) =>
    recall(tx, companyId, {
      memoryType: 'procedural',
      approvalState: 'candidate',
      limit: 100,
    }),
  );

  return {
    companyId,
    weekEnding: weekEnding.toISOString().slice(0, 10),
    tasksCompleted: Number(summary.completed),
    tasksStopped: Number(summary.stopped),
    moneySpentCents: Number(summary.money_spent_cents),
    costliestDivisions: divisions
      .slice(0, 3)
      .map((division) => ({ label: division.label, costCents: division.costCents })),
    sopCandidatesPending: candidates.length,
    decisionsRecorded: Number(summary.decisions),
  };
}
