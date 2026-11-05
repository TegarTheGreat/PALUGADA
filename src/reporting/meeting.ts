/**
 * What the weekly operating meeting is handed (F18.6): the agenda's facts,
 * read from the company's rows as the meeting starts.
 *
 * The agenda is the one most small-company operating methods share, after
 * the weekly meeting in *Traction* by Gino Wickman and the meeting rhythm in
 * *Scaling Up* by Verne Harnish, less what is only for people in a room
 * (STATUS 2.189): the scorecard, the quarterly priorities on or off pace, the
 * week's headlines, last week's to-dos done or not, and the issues ranked.
 * The operating kit's weekly business review, when the company has one, is
 * the strategist's reading of the same week, and is passed on.
 *
 * Built from rows, never from a model, as the week's and the month's facts
 * are (week.ts, month.ts): a meeting that held a seat to a number a model had
 * summarised would be holding it to the model. Bounded, because the facts
 * travel with every step of the run: each list stops at a length and says how
 * many it left out, and each line of text is cut to one line. Words written
 * by work that had read something from outside the company -- an issue's or a
 * to-do's title, the review's summary -- are wrapped as data (F8.9) and
 * marked, so the meeting carries that provenance from its first step.
 */
import type { TenantClient } from '../db/tenant.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { outsideContentIn } from '../engine/tasks.ts';
import { progressOf, scorecardOf, type MetricUnit, type Scorecard, type WeekState } from '../domain/metrics.ts';
import type { GoalCommitment } from '../domain/goals.ts';
import type { ChannelSlug } from '../domain/channels.ts';
import { daysBetween } from '../records/collections.ts';
import { overdueInvoices } from '../records/invoices.ts';
import { todoCompletionWithin } from '../engine/tickets.ts';

const WEEK_MS = 7 * 86_400_000;
/** The most of each the facts carry; past it, they say how many were left out. */
const LINES_MAX = 20;
const PRIORITIES_MAX = 15;
const TODOS_MAX = 25;
const ISSUES_MAX = 25;
const TITLE_MAX = 200;
const STATEMENT_MAX = 200;
const SUMMARY_MAX = 600;
/**
 * An issue on the weekly list this long is flagged. Eight weeks is two
 * months of meetings that did not solve it: either it is not a problem, or
 * it is the long-term list's, and the meeting should say which.
 */
export const ISSUE_STALE_DAYS = 56;
/** A priority with no measure is on pace while work under it finished in this many days. */
const PRIORITY_WORK_DAYS = 7;

export interface MeetingLine {
  metric: string;
  name: string;
  /** The seat that answers for it, by its slug, as a run names roles. */
  seat: string | null;
  unit: MetricUnit;
  direction: 'up' | 'down';
  /** The weekly goal. */
  target: number;
  /** The measure it is watched with, by its slug. */
  pair: string | null;
  /** The last whole week, which the line is judged by, and this week so far. */
  lastWeek: { week: string; value: number | null; verified: boolean | null; state: WeekState };
  thisWeek: { week: string; value: number | null; verified: boolean | null; state: WeekState };
}

export interface MeetingPriority {
  goal: string;
  statement: string;
  seat: string | null;
  commitment: GoalCommitment | null;
  startsOn: string;
  dueOn: string;
  /** How much of the quarter is gone, 0 to 1, counting today. */
  elapsed: number;
  /** The least progress of its measures from baseline to target, 0 to 1; null without a measure or a reading. */
  progress: number | null;
  /** Work under it that finished in the last seven days. */
  finishedThisWeek: number;
  pace: 'on_pace' | 'off_pace';
  /** Why it is off pace: behind its quarter, a measure with no verified reading, or no work finished this week. */
  why: 'behind' | 'no_reading' | 'no_recent_work' | null;
}

export interface MeetingTodo {
  ticket: string;
  title: string;
  seat: string | null;
  dueOn: string | null;
  /** The issue whose decision it carries out. */
  solves: string | null;
  done: boolean;
  outside?: true;
}

export interface MeetingIssue {
  ticket: string;
  title: string;
  /** 0 first to 3 last. */
  priority: number;
  ageDays: number;
  /** On the weekly list longer than `ISSUE_STALE_DAYS`. */
  stale: boolean;
  filedBy: 'owner' | 'agent' | 'platform';
  outside?: true;
}

export interface MeetingFacts {
  /** The ISO week, `IYYY-Www`, and the day, in the company's time zone. */
  week: string;
  day: string;
  timezone: string;
  /** The day of the meeting before this one, or null for the first. */
  previousDay: string | null;
  scorecard: { lines: MeetingLine[]; linesLeftOut: number; warning: Scorecard['warning'] };
  priorities: { items: MeetingPriority[]; leftOut: number };
  /** Counts only, over the seven days before the meeting: names are the records', not the meeting's. */
  headlines: { newChats: number; dealsWon: number; dealsLost: number; overdueInvoices: number; incidents: number };
  /**
   * Every to-do due by today and not done, and every one due in the last
   * seven days whatever became of it; `due`, `done` and `completionRate` are
   * over the last seven days only. Wickman asks for 90% of a week's to-dos done.
   */
  todos: { items: MeetingTodo[]; leftOut: number; due: number; done: number; completionRate: number | null };
  /** The weekly list, open, by priority and then age. */
  issues: { items: MeetingIssue[]; leftOut: number };
  /** The operating kit's weekly business review of the last seven days, when there is one. */
  businessReview: { task: string; finishedAt: string; summary: string | null; outside?: true } | null;
  /** What the platform put on the issues list for this meeting before it was made. */
  filed: { offTrack: string[]; notDoneTwice: string[] };
}

/** Text as one line, cut to a length. */
function oneLine(text: string | null, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The day `days` after a day, both YYYY-MM-DD. */
function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The meeting's facts, in the caller's transaction: the meeting files its
 * issues and makes its task in the same one (engine/meeting.ts).
 */
export async function buildMeetingFacts(tx: TenantClient, companyId: string, meeting: {
  now: Date;
  week: string;
  day: string;
  timezone: string;
  previousDay: string | null;
  filed: MeetingFacts['filed'];
}): Promise<MeetingFacts> {
  const { now, day } = meeting;
  const from = new Date(now.getTime() - WEEK_MS);

  // The scorecard, judged by the last whole week: a week that has not ended
  // cannot have missed its goal, and a meeting early in the week would
  // otherwise read every line as not reported.
  const card = await scorecardOf(tx, companyId, now);
  const lines = card.lines.slice(0, LINES_MAX).map((line): MeetingLine => {
    const last = line.weeks.at(-2)!;
    const current = line.weeks.at(-1)!;
    return {
      metric: line.slug,
      name: oneLine(line.name, TITLE_MAX),
      seat: line.ownerRole?.slug ?? null,
      unit: line.unit,
      direction: line.direction,
      target: line.target,
      pair: line.pair?.slug ?? null,
      lastWeek: { week: last.week, value: last.value, verified: last.verified, state: last.state },
      thisWeek: { week: current.week, value: current.value, verified: current.verified, state: current.state },
    };
  });

  // The priorities on or off pace, by the rule the plan page and the
  // outcome sweep read them by too (`prioritiesOnPace`); the meeting is
  // handed them without their ids, since a run names goals by slug.
  const paced = await prioritiesOnPace(tx, companyId, { day, now });
  const priorities = paced.items.map(({ goalId: _goal, parentGoalId: _parent, seatRoleId: _seat, channel: _channel, ...item }): MeetingPriority => item);

  const { rows: [headline] } = await tx.query<{ chats: number; won: number; lost: number; incidents: number }>(
    `SELECT (SELECT count(*)::int FROM chats WHERE company_id = $1 AND created_at > $2 AND created_at <= $3) AS chats,
            (SELECT count(*)::int FROM deals WHERE company_id = $1 AND stage = 'won' AND closed_at > $2 AND closed_at <= $3) AS won,
            (SELECT count(*)::int FROM deals WHERE company_id = $1 AND stage = 'lost' AND closed_at > $2 AND closed_at <= $3) AS lost,
            (SELECT count(*)::int FROM inbox_items WHERE company_id = $1 AND kind = 'incident' AND created_at > $2 AND created_at <= $3) AS incidents`,
    [companyId, from, now]);
  const overdue = (await overdueInvoices(tx, companyId, day)).length;

  // To-dos: work with a due date, as the board counts one. A closed one was
  // dropped by its owner, and is neither done nor not done.
  const weekBefore = dayAfter(day, -7);
  const { rows: todoRows } = await tx.query<{
    id: string; title: string; status: string; due_on: string; outside: boolean; seat: string | null; solves: string | null; total: number;
  }>(
    `SELECT t.id, t.title, t.status, to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.outside, r.slug AS seat,
            t.solves_ticket_id AS solves, count(*) OVER ()::int AS total
       FROM tickets t
       LEFT JOIN roles r ON r.company_id = t.company_id AND r.id = t.assignee_role_id
      WHERE t.company_id = $1 AND t.kind = 'work' AND t.due_on IS NOT NULL AND t.due_on <= $2::date AND t.status <> 'closed'
        AND (t.status <> 'done' OR t.due_on > $3::date)
      ORDER BY t.due_on, t.created_at, t.id
      LIMIT $4`,
    [companyId, day, weekBefore, TODOS_MAX]);
  // The week's rate, by the one count the plan page reads a quarter by.
  const rate = await todoCompletionWithin(tx, companyId, { from: dayAfter(weekBefore, 1), to: day });
  const todos = todoRows.map((row): MeetingTodo => {
    const title = oneLine(row.title, TITLE_MAX);
    return {
      ticket: row.id,
      title: row.outside ? wrapUntrusted(`ticket:${row.id}`, title) : title,
      seat: row.seat,
      dueOn: row.due_on,
      solves: row.solves,
      done: row.status === 'done',
      ...(row.outside ? { outside: true as const } : {}),
    };
  });

  const { rows: issueRows } = await tx.query<{
    id: string; title: string; priority: number; outside: boolean; opened_by: MeetingIssue['filedBy']; age_days: number; total: number;
  }>(
    `SELECT id, title, priority, outside, opened_by,
            greatest(0, floor(extract(epoch FROM ($2::timestamptz - created_at)) / 86400))::int AS age_days,
            count(*) OVER ()::int AS total
       FROM tickets
      WHERE company_id = $1 AND kind = 'issue' AND status IN ('open', 'in_progress') AND horizon = 'now'
      ORDER BY priority, created_at, id
      LIMIT $3`,
    [companyId, now, ISSUES_MAX]);
  const issues = issueRows.map((row): MeetingIssue => {
    const title = oneLine(row.title, TITLE_MAX);
    return {
      ticket: row.id,
      title: row.outside ? wrapUntrusted(`ticket:${row.id}`, title) : title,
      priority: row.priority,
      ageDays: row.age_days,
      stale: row.age_days > ISSUE_STALE_DAYS,
      filedBy: row.opened_by,
      ...(row.outside ? { outside: true as const } : {}),
    };
  });

  // The weekly business review is the scheduled run that was handed the
  // week (scheduler.ts puts `week` beside `facts: 'week'` in its input).
  const { rows: reviews } = await tx.query<{ id: string; summary: string | null; finished_at: Date }>(
    `SELECT id, finished_at,
            CASE WHEN jsonb_typeof(output->'summary') = 'string' THEN output->>'summary' END AS summary
       FROM tasks
      WHERE company_id = $1 AND status = 'completed' AND parent_task_id IS NULL
        AND input->>'facts' = 'week' AND input ? 'week'
        AND finished_at > $2 AND finished_at <= $3
      ORDER BY finished_at DESC, id
      LIMIT 1`,
    [companyId, from, now]);
  let businessReview: MeetingFacts['businessReview'] = null;
  if (reviews[0]) {
    const summary = oneLine(reviews[0].summary, SUMMARY_MAX) || null;
    const outside = (await outsideContentIn(tx, reviews[0].id)) !== null;
    businessReview = {
      task: reviews[0].id,
      finishedAt: reviews[0].finished_at.toISOString(),
      summary: summary && outside ? wrapUntrusted(`task:${reviews[0].id}`, summary) : summary,
      ...(outside ? { outside: true as const } : {}),
    };
  }

  return {
    week: meeting.week,
    day,
    timezone: meeting.timezone,
    previousDay: meeting.previousDay,
    scorecard: { lines, linesLeftOut: Math.max(0, card.lines.length - lines.length), warning: card.warning },
    priorities: { items: priorities, leftOut: paced.leftOut },
    headlines: {
      newChats: headline!.chats, dealsWon: headline!.won, dealsLost: headline!.lost, overdueInvoices: overdue, incidents: headline!.incidents,
    },
    todos: {
      items: todos,
      leftOut: Math.max(0, (todoRows[0]?.total ?? 0) - todoRows.length),
      ...rate,
    },
    issues: { items: issues, leftOut: Math.max(0, (issueRows[0]?.total ?? 0) - issueRows.length) },
    businessReview,
    filed: meeting.filed,
  };
}

/** A priority on or off pace, with the ids a page links by. */
export interface PacedPriority extends MeetingPriority {
  goalId: string;
  parentGoalId: string | null;
  seatRoleId: string | null;
  /** The traction channel it tests (F18.11), or null. */
  channel: ChannelSlug | null;
}

/**
 * The quarterly priorities whose quarter `day` (the company's own day) is in,
 * each on or off pace, and how many there are in all: what the weekly meeting
 * is handed, what the plan page shows (src/owner/views.ts), and what the
 * outcome sweep reads for a committed one behind its quarter
 * (src/engine/outcomes.ts). One reading of pace for all three, so the owner is
 * never told a priority is off pace that the meeting called on pace.
 *
 * A quarter is read from a period's length, as goals.ts reads it. A measured
 * priority is on pace when every measure has come as far from its baseline as
 * the quarter has gone. Only a verified reading counts: a claim nobody checked
 * is not where the priority stands. One with no number is on pace while work
 * under it is finishing.
 *
 * At most `limit` (the meeting's fifteen unless said). `commitment` keeps
 * only priorities of that commitment and `offset` skips
 * that many, so the outcome sweep can page through every committed one rather
 * than judge only those that happen to come first.
 */
export async function prioritiesOnPace(tx: TenantClient, companyId: string, at: {
  now: Date; day: string; limit?: number; offset?: number; commitment?: GoalCommitment;
}): Promise<{
  items: PacedPriority[];
  /** Every priority that matched, past the limit and the offset too. */
  total: number;
  /** How many of them this page left out. */
  leftOut: number;
}> {
  const { now, day } = at;
  const { rows: priorityRows } = await tx.query<{
    id: string; parent_goal_id: string | null; slug: string; statement: string; seat: string | null; seat_id: string | null;
    commitment: GoalCommitment | null; channel: ChannelSlug | null; starts_on: string; due_on: string; finished: number; total: number;
  }>(
    `SELECT g.id, g.parent_goal_id, g.slug, g.statement, r.slug AS seat, r.id AS seat_id, g.commitment, g.channel,
            to_char(g.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(g.due_on, 'YYYY-MM-DD') AS due_on,
            (SELECT count(*)::int FROM tasks t
              WHERE t.company_id = g.company_id AND t.goal_id = g.id AND t.status = 'completed'
                AND t.finished_at > $3::timestamptz - make_interval(days => $4::int) AND t.finished_at <= $3) AS finished,
            count(*) OVER ()::int AS total
       FROM goals g
       LEFT JOIN roles r ON r.company_id = g.company_id AND r.id = g.owner_role_id
      WHERE g.company_id = $1 AND g.status = 'active' AND g.kind = 'key_result'
        AND g.starts_on IS NOT NULL AND g.due_on - g.starts_on <= 92
        AND g.starts_on <= $2::date AND g.due_on >= $2::date
        AND ($6::text IS NULL OR g.commitment = $6)
      ORDER BY g.due_on, g.created_at, g.id
      LIMIT $5 OFFSET $7`,
    [companyId, day, now, PRIORITY_WORK_DAYS, at.limit ?? PRIORITIES_MAX, at.commitment ?? null, at.offset ?? 0]);
  const { rows: measureRows } = await tx.query<{ goal_id: string; baseline: string; target: string; value: string | null }>(
    `SELECT m.goal_id, m.baseline, m.target, last.value
       FROM goal_metrics m
       LEFT JOIN LATERAL (
              SELECT o.value FROM metric_observations o
               WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.verified AND o.observed_at <= $3
               ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) last ON true
      WHERE m.company_id = $1 AND m.goal_id = ANY($2::uuid[]) AND m.retired_at IS NULL AND m.review_every IS NULL
      ORDER BY m.created_at, m.id`,
    [companyId, priorityRows.map((row) => row.id), now]);
  const items = priorityRows.map((row): PacedPriority => {
    const elapsed = round2(Math.min(1, Math.max(0, (daysBetween(row.starts_on, day) + 1) / (daysBetween(row.starts_on, row.due_on) + 1))));
    const measures = measureRows.filter((one) => one.goal_id === row.id);
    const base = {
      goalId: row.id, parentGoalId: row.parent_goal_id, seatRoleId: row.seat_id, channel: row.channel,
      goal: row.slug, statement: oneLine(row.statement, STATEMENT_MAX), seat: row.seat, commitment: row.commitment,
      startsOn: row.starts_on, dueOn: row.due_on, elapsed, finishedThisWeek: row.finished,
    };
    if (measures.length > 0) {
      if (measures.some((one) => one.value === null)) return { ...base, progress: null, pace: 'off_pace', why: 'no_reading' };
      const progress = round2(Math.min(...measures.map((one) =>
        progressOf({ baseline: Number(one.baseline), target: Number(one.target) }, Number(one.value)))));
      return { ...base, progress, pace: progress >= elapsed ? 'on_pace' : 'off_pace', why: progress >= elapsed ? null : 'behind' };
    }
    return { ...base, progress: null, pace: row.finished > 0 ? 'on_pace' : 'off_pace', why: row.finished > 0 ? null : 'no_recent_work' };
  });
  const total = priorityRows[0]?.total ?? 0;
  return { items, total, leftOut: Math.max(0, total - priorityRows.length) };
}
