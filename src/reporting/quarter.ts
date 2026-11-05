/**
 * What quarterly planning is handed (F18.9): the quarter's facts, read from
 * the company's rows as the planning starts.
 *
 * The steps are the ones the OKR cycle in *Measure What Matters* by John
 * Doerr and the quarterly planning in *Traction* by Gino Wickman share, less
 * what is only for people in a room (STATUS 2.189): look back at the quarter
 * by its grades and numbers, look at the year and the vision it serves, and
 * clean the long-term issues list. So the facts are:
 *
 *  - the company's numbers for the quarter (`gradeReportOf`): priorities done
 *    against Wickman's 80%, the committed pass rate, the aspirational
 *    average against the 0.6 to 0.7 both OKR sources expect, and the to-do
 *    completion rate, counted as the weekly meeting counts it;
 *  - every grade written so far this fiscal year, with a learning goal's
 *    prediction beside what happened;
 *  - the quarter's priorities, the candidates to keep, kill or combine;
 *  - this year's goals;
 *  - the long-term issues list, by priority and then age;
 *  - the weekly scorecard's thirteen weeks, as a trend per line;
 *  - the vision, as the owner wrote it in the company's charter, section by
 *    section;
 *  - the core processes not changed in ninety days (`coreProcessesOf`).
 *
 * Built from rows, never from a model, as the week's and the meeting's facts
 * are, and bounded: each list stops at a length and says how many it left
 * out, and each line of text is cut. An issue's title written by work that
 * had read something from outside is wrapped as data (F8.9) and marked, so
 * the planning carries that provenance from its first step. Goals, measures
 * and the charter are the owner's words (F3.10); a core process is named by
 * its slug and its seat, never its text.
 */
import type { TenantClient } from '../db/tenant.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { scorecardOf } from '../domain/metrics.ts';
import { gradeReportOf, type GoalGrade, type GradeReport } from '../domain/grades.ts';
import type { FiscalQuarter } from '../domain/fiscal.ts';
import type { GoalCommitment, GoalKind, GoalStatus } from '../domain/goals.ts';
import { coreProcessesOf } from '../skills/core.ts';

/** The most of each the facts carry; past it, they say how many were left out. */
const GRADES_MAX = 30;
const PRIORITIES_MAX = 20;
const YEAR_GOALS_MAX = 10;
const ISSUES_MAX = 25;
const LINES_MAX = 20;
const SECTIONS_MAX = 12;
const PROCESSES_MAX = 12;
const TITLE_MAX = 200;
const STATEMENT_MAX = 300;
const SECTION_MAX = 800;

export interface QuarterGrade {
  goal: string;
  statement: string;
  kind: GoalKind;
  commitment: GoalCommitment | null;
  startsOn: string;
  dueOn: string;
  score: number;
  basis: GoalGrade['basis'];
  passed: boolean | null;
  predicted: number | null;
  actual: number | null;
  note: GoalGrade['note'];
}

export interface QuarterPriority {
  goal: string;
  statement: string;
  /** The owning seat, by its slug, as a run names roles. */
  seat: string | null;
  commitment: GoalCommitment | null;
  status: GoalStatus;
  startsOn: string;
  dueOn: string;
  /** Its grade, when its period has already ended and been graded. */
  score: number | null;
}

export interface QuarterFacts {
  /** The fiscal quarter planned from, `<year>-Q<n>`, and its days. */
  quarter: string;
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
  /** Today, in the company's time zone. */
  day: string;
  /** The fiscal year's last quarter, which plans the next year too. */
  annual: boolean;
  numbers: GradeReport['numbers'];
  /** The grades written so far this fiscal year, latest first. */
  grades: { items: QuarterGrade[]; leftOut: number };
  /** This quarter's priorities, whatever became of them. */
  priorities: { items: QuarterPriority[]; leftOut: number };
  /** This fiscal year's goals: objectives with a year's period in it. */
  yearGoals: { items: Array<{ goal: string; statement: string; status: GoalStatus; commitment: GoalCommitment | null; startsOn: string; dueOn: string }>; leftOut: number };
  /** The long-term issues list, open, by priority and then age. */
  longTermIssues: { items: Array<{ ticket: string; title: string; priority: number; ageDays: number; outside?: true }>; leftOut: number };
  /** Each line of the weekly scorecard over its thirteen weeks. */
  scorecard: {
    lines: Array<{
      metric: string; name: string; seat: string | null; target: number; direction: 'up' | 'down';
      onTrack: number; offTrack: number; claimed: number; notReported: number;
      /** The first and last numbers of the thirteen weeks, verified or claimed. */
      first: number | null; last: number | null;
    }>;
    leftOut: number;
  };
  /** The company's charter, the vision the owner wrote, by its headings; null with none. */
  vision: { version: number; sections: Array<{ heading: string; text: string }>; leftOut: number } | null;
  /** Core processes not changed in a quarter, with how far each is followed. */
  coreProcesses: { stale: Array<{ skill: string; seat: string; ageDays: number; followedShare: number | null }>; leftOut: number };
}

/** Text as one line, cut to a length. */
function oneLine(text: string | null, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The charter by its Markdown headings: the vision outline is headings the
 * owner fills in, in their own language, so every section is passed on
 * rather than guessing which headings are the vision's. Text before the
 * first heading is a section with no heading.
 */
function sectionsOf(body: string): Array<{ heading: string; text: string }> {
  const sections: Array<{ heading: string; text: string[] }> = [];
  for (const line of body.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) sections.push({ heading: oneLine(heading[1]!, TITLE_MAX), text: [] });
    else if (line.trim()) {
      if (sections.length === 0) sections.push({ heading: '', text: [] });
      sections.at(-1)!.text.push(line.trim());
    }
  }
  return sections.map((section) => ({ heading: section.heading, text: section.text.join('\n').slice(0, SECTION_MAX) }));
}

/** The quarter's facts, in the caller's transaction: the planning is made in the same one (engine/quarter.ts). */
export async function buildQuarterFacts(tx: TenantClient, companyId: string, planning: {
  now: Date;
  day: string;
  quarter: FiscalQuarter;
}): Promise<QuarterFacts> {
  const { now, day, quarter } = planning;
  const report = await gradeReportOf(tx, companyId, { from: quarter.startsOn, to: quarter.endsOn }, now);

  const { rows: gradeRows } = await tx.query<{
    slug: string; statement: string; kind: GoalKind; commitment: GoalCommitment | null; starts_on: string; due_on: string;
    score: string; basis: GoalGrade['basis']; predicted: string | null; actual: string | null; note: GoalGrade['note']; total: number;
  }>(
    `SELECT g.slug, g.statement, g.kind, r.commitment,
            to_char(r.period_starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.period_due_on, 'YYYY-MM-DD') AS due_on,
            r.score, r.basis, r.predicted, r.actual, r.note, count(*) OVER ()::int AS total
       FROM goal_grades r JOIN goals g ON g.company_id = r.company_id AND g.id = r.goal_id
      WHERE r.company_id = $1 AND r.period_due_on BETWEEN $2::date AND $3::date
      ORDER BY r.period_due_on DESC, g.created_at, g.id
      LIMIT $4`,
    [companyId, quarter.yearStartsOn, day, GRADES_MAX]);
  const grades = gradeRows.map((row): QuarterGrade => ({
    goal: row.slug, statement: oneLine(row.statement, STATEMENT_MAX), kind: row.kind, commitment: row.commitment,
    startsOn: row.starts_on, dueOn: row.due_on, score: Number(row.score), basis: row.basis,
    passed: row.commitment === 'committed' ? Number(row.score) >= 1 : null,
    predicted: row.predicted === null ? null : Number(row.predicted),
    actual: row.actual === null ? null : Number(row.actual),
    note: row.note,
  }));

  // A quarterly priority is a key result with a quarter's period (goals.ts);
  // this quarter's are those whose period falls in it.
  const { rows: priorityRows } = await tx.query<{
    id: string; slug: string; statement: string; seat: string | null; commitment: GoalCommitment | null; status: GoalStatus;
    starts_on: string; due_on: string; total: number;
  }>(
    `SELECT g.id, g.slug, g.statement, r.slug AS seat, g.commitment, g.status,
            to_char(g.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(g.due_on, 'YYYY-MM-DD') AS due_on,
            count(*) OVER ()::int AS total
       FROM goals g LEFT JOIN roles r ON r.company_id = g.company_id AND r.id = g.owner_role_id
      WHERE g.company_id = $1 AND g.kind = 'key_result' AND g.starts_on IS NOT NULL AND g.due_on - g.starts_on <= 92
        AND g.due_on BETWEEN $2::date AND $3::date
      ORDER BY g.due_on, g.created_at, g.id
      LIMIT $4`,
    [companyId, quarter.startsOn, quarter.endsOn, PRIORITIES_MAX]);
  const latest = new Map(report.latest.map((grade) => [grade.goalId, grade]));
  const priorities = priorityRows.map((row): QuarterPriority => {
    const grade = latest.get(row.id);
    return {
      goal: row.slug, statement: oneLine(row.statement, STATEMENT_MAX), seat: row.seat, commitment: row.commitment, status: row.status,
      startsOn: row.starts_on, dueOn: row.due_on, score: grade && grade.periodDueOn === row.due_on ? grade.score : null,
    };
  });

  // This year's goals are objectives with a year's period (goals.ts), in this fiscal year.
  const { rows: yearRows } = await tx.query<{
    slug: string; statement: string; status: GoalStatus; commitment: GoalCommitment | null; starts_on: string; due_on: string; total: number;
  }>(
    `SELECT slug, statement, status, commitment,
            to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(due_on, 'YYYY-MM-DD') AS due_on, count(*) OVER ()::int AS total
       FROM goals
      WHERE company_id = $1 AND kind = 'objective' AND status <> 'abandoned' AND starts_on IS NOT NULL
        AND due_on - starts_on > 92 AND due_on - starts_on <= 366
        AND starts_on <= $3::date AND due_on >= $2::date
      ORDER BY due_on, created_at, id
      LIMIT $4`,
    [companyId, quarter.yearStartsOn, quarter.yearEndsOn, YEAR_GOALS_MAX]);

  const { rows: issueRows } = await tx.query<{ id: string; title: string; priority: number; outside: boolean; age_days: number; total: number }>(
    `SELECT id, title, priority, outside,
            greatest(0, floor(extract(epoch FROM ($2::timestamptz - created_at)) / 86400))::int AS age_days,
            count(*) OVER ()::int AS total
       FROM tickets
      WHERE company_id = $1 AND kind = 'issue' AND status IN ('open', 'in_progress') AND horizon = 'long_term'
      ORDER BY priority, created_at, id
      LIMIT $3`,
    [companyId, now, ISSUES_MAX]);
  const longTermIssues = issueRows.map((row) => {
    const title = oneLine(row.title, TITLE_MAX);
    return {
      ticket: row.id,
      title: row.outside ? wrapUntrusted(`ticket:${row.id}`, title) : title,
      priority: row.priority,
      ageDays: row.age_days,
      ...(row.outside ? { outside: true as const } : {}),
    };
  });

  const card = await scorecardOf(tx, companyId, now);
  const lines = card.lines.slice(0, LINES_MAX).map((line) => {
    const count = (state: string) => line.weeks.filter((week) => week.state === state).length;
    const values = line.weeks.flatMap((week) => (week.value === null ? [] : [week.value]));
    return {
      metric: line.slug, name: oneLine(line.name, TITLE_MAX), seat: line.ownerRole?.slug ?? null, target: line.target, direction: line.direction,
      onTrack: count('on_track'), offTrack: count('off_track'), claimed: count('claimed'), notReported: count('not_reported'),
      first: values[0] ?? null, last: values.at(-1) ?? null,
    };
  });

  const { rows: charter } = await tx.query<{ version: number; body: string }>(
    'SELECT version, body FROM charters WHERE company_id = $1 ORDER BY version DESC LIMIT 1', [companyId]);
  const sections = charter[0] ? sectionsOf(charter[0].body) : [];

  const processes = await coreProcessesOf(tx, companyId, { now });
  const stale = processes.processes.filter((one) => one.stale);

  return {
    quarter: quarter.label,
    fiscalYear: quarter.fiscalYear,
    startsOn: quarter.startsOn,
    endsOn: quarter.endsOn,
    day,
    annual: quarter.quarter === 4,
    numbers: report.numbers,
    grades: { items: grades, leftOut: Math.max(0, (gradeRows[0]?.total ?? 0) - gradeRows.length) },
    priorities: { items: priorities, leftOut: Math.max(0, (priorityRows[0]?.total ?? 0) - priorityRows.length) },
    yearGoals: {
      items: yearRows.map((row) => ({
        goal: row.slug, statement: oneLine(row.statement, STATEMENT_MAX), status: row.status, commitment: row.commitment,
        startsOn: row.starts_on, dueOn: row.due_on,
      })),
      leftOut: Math.max(0, (yearRows[0]?.total ?? 0) - yearRows.length),
    },
    longTermIssues: { items: longTermIssues, leftOut: Math.max(0, (issueRows[0]?.total ?? 0) - issueRows.length) },
    scorecard: { lines, leftOut: Math.max(0, card.lines.length - lines.length) },
    vision: charter[0]
      ? { version: charter[0].version, sections: sections.slice(0, SECTIONS_MAX), leftOut: Math.max(0, sections.length - SECTIONS_MAX) }
      : null,
    coreProcesses: {
      stale: stale.slice(0, PROCESSES_MAX).map((one) => ({
        skill: one.slug, seat: one.ownerRole, ageDays: one.ageDays, followedShare: one.followedShare,
      })),
      leftOut: Math.max(0, stale.length - PROCESSES_MAX),
    },
  };
}
