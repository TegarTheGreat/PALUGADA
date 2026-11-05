/**
 * End-of-period grades (F18.8, 0144), after the scoring of objectives and key
 * results in *Measure What Matters* by John Doerr and Google's re:Work, the
 * quarterly priorities of *Traction* by Gino Wickman, done or not done, and
 * the study step of Deming's plan-do-study-act.
 *
 * The platform grades; no agent does. A goal's grade is read from its rows
 * when its period ends (src/engine/quarter.ts), on these rules:
 *
 *  - **Measured.** A goal with a measure aimed at a target is the progress of
 *    each of its live measures, from baseline to target by the last verified
 *    reading of the period (`progressOf`, so clamped to 0..1), averaged. A
 *    measure with no verified reading counts as no progress, and the grade
 *    says so (`no_reading`): a claim nobody checked is not where a goal
 *    stands. An objective with no measure of its own is graded from its key
 *    results' measures, which is how both OKR sources score an objective
 *    (`from_key_results`). A weekly line is not a target (2.191) and is left
 *    out.
 *  - **Declared.** A goal with no number is 1 if the owner marked it met by
 *    the time it is graded, and 0 if not. Only the owner marks a goal met
 *    (F3.10), so an agent cannot declare itself done.
 *  - **Marked met.** A measured goal the owner marked met by the time it is
 *    graded is 1 whatever its readings say (`marked_met`). The owner can
 *    know what a source records only later -- a sale on the last day that
 *    lands the morning after -- and a met goal graded 0 would be a "Missed"
 *    on the ladder beside it, and a postmortem, for a goal the owner closed.
 *    Only the owner's yes marks a goal met: an agent can only propose it, and
 *    its proposal is refused while a checked reading is short (goals.ts).
 *  - **Committed** is pass or fail: 1 only when the goal was reached in full,
 *    else 0. 0.8 of a committed priority is a miss, and is filed as one.
 *  - **Aspirational** keeps its score, read against the 0.6 to 0.7 both OKR
 *    sources call a good result.
 *  - **Learning** keeps, beside the score, the prediction -- its first
 *    measure's target, which a plan sets before the work starts (2.195) --
 *    and what that measure read at the end.
 *
 * Grades are information for the owner and the next plan. Nothing that pays,
 * trusts or freezes reads them: both sources warn that a grade tied to a
 * reward is sandbagged, and with agents it would invite risk taken to catch
 * up (STATUS 2.189). A test holds the list of their readers.
 */
import type { TenantClient } from '../db/tenant.ts';
import { progressOf } from './metrics.ts';
import type { GoalCommitment, GoalKind, GoalStatus } from './goals.ts';

export type GradeBasis = 'measured' | 'declared';
/** How a score was reached, where the score alone does not say. */
export type GradeNote = 'no_reading' | 'from_key_results' | 'marked_met';

export interface GoalGrade {
  goalId: string;
  periodStartsOn: string;
  periodDueOn: string;
  commitment: GoalCommitment | null;
  score: number;
  basis: GradeBasis;
  /** A learning goal's prediction and what happened; null for any other. */
  predicted: number | null;
  actual: number | null;
  note: GradeNote | null;
  /** A committed goal passed or failed; null for any other. */
  passed: boolean | null;
}

/**
 * Both OKR sources call 0.6 to 0.7 a good result for an aspirational goal,
 * and read an average near 1.0 as goals set too safe and one under 0.3 as
 * goals set out of reach. These are their heuristics, named as such
 * (STATUS 2.189), not targets.
 */
export const ASPIRATIONAL_EXPECTED: readonly [number, number] = [0.6, 0.7];
const TOO_SAFE_FROM = 0.9;
const TOO_AMBITIOUS_BELOW = 0.3;
/** Wickman asks that 80% of a quarter's priorities be done. */
export const PRIORITIES_DONE_AIM = 0.8;
/** A to-do is a week's work: one finished in seven days of being filed kept its promise. */
const TODO_DAYS = 7;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A goal at the end of its period, as the grader reads it. */
export interface GoalToGrade {
  id: string;
  kind: GoalKind;
  status: GoalStatus;
  startsOn: string;
  dueOn: string;
  commitment: GoalCommitment | null;
}

/**
 * The grade a goal earned over its period, and how far its numbers came
 * (null without any), read in the caller's transaction
 * up to `endsAt`, the end of its last day where the company is. Every
 * statement names the company, so it reads the same on the control plane,
 * where the platform writes grades, as in the tenant's own transaction.
 */
export async function gradeGoalWithin(
  tx: TenantClient,
  companyId: string,
  goal: GoalToGrade,
  endsAt: Date,
): Promise<Omit<GoalGrade, 'passed'> & { progress: number | null }> {
  const measuresOf = async (goalIds: string[]) => (await tx.query<{
    goal_id: string; baseline: string; target: string; value: string | null;
  }>(
    `SELECT m.goal_id, m.baseline, m.target, last.value
       FROM goal_metrics m
       LEFT JOIN LATERAL (
              SELECT o.value FROM metric_observations o
               WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.verified AND o.observed_at < $3
               ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) last ON true
      WHERE m.company_id = $1 AND m.goal_id = ANY($2::uuid[]) AND m.retired_at IS NULL AND m.review_every IS NULL
      ORDER BY m.created_at, m.id`,
    [companyId, goalIds, endsAt])).rows;

  let measures = await measuresOf([goal.id]);
  let note: GradeNote | null = null;
  if (measures.length === 0 && goal.kind === 'objective') {
    const { rows: children } = await tx.query<{ id: string }>(
      "SELECT id FROM goals WHERE company_id = $1 AND parent_goal_id = $2 AND status <> 'abandoned'", [companyId, goal.id]);
    measures = children.length > 0 ? await measuresOf(children.map((child) => child.id)) : [];
    if (measures.length > 0) note = 'from_key_results';
  }

  const base = {
    goalId: goal.id, periodStartsOn: goal.startsOn, periodDueOn: goal.dueOn, commitment: goal.commitment,
    predicted: null as number | null, actual: null as number | null,
  };
  if (measures.length === 0) {
    return { ...base, score: goal.status === 'met' ? 1 : 0, basis: 'declared', note: null, progress: null };
  }
  const fromKeyResults = note === 'from_key_results';
  if (measures.some((one) => one.value === null) && note === null) note = 'no_reading';
  const progress = measures.map((one) => (one.value === null
    ? 0 : progressOf({ baseline: Number(one.baseline), target: Number(one.target) }, Number(one.value))));
  const average = progress.reduce((sum, one) => sum + one, 0) / progress.length;
  const reached = goal.commitment === 'committed' ? (progress.every((one) => one >= 1) ? 1 : 0) : round2(average);
  // The owner's met is the grade (see above); how far the numbers came stays in `progress`.
  const marked = goal.status === 'met' && reached < 1;
  const score = marked ? 1 : reached;
  if (marked) note = 'marked_met';
  // The prediction is the goal's own first measure: an objective graded from
  // its key results predicted nothing itself.
  const first = goal.commitment === 'learning' && !fromKeyResults ? measures[0] : undefined;
  return {
    ...base,
    score,
    basis: 'measured',
    note,
    // How far it came, which a committed goal's pass or fail does not say.
    progress: round2(average),
    ...(first ? { predicted: Number(first.target), actual: first.value === null ? null : Number(first.value) } : {}),
  };
}

/** The company's numbers over a window, and each goal's latest grade. */
export interface GradeReport {
  from: string;
  to: string;
  numbers: {
    /**
     * The quarterly priorities due in the window, not abandoned, and how many
     * are done: by its grade once one is graded, as the pass rate reads it,
     * and by being met before that.
     */
    priorities: { total: number; done: number; share: number | null; aim: number };
    /** The committed goals graded in the window, and how many passed. */
    committed: { graded: number; passed: number; passRate: number | null };
    /** The aspirational goals graded in the window, their average, and how it reads. */
    aspirational: {
      graded: number; average: number | null; expected: readonly [number, number];
      reading: 'too_safe' | 'too_ambitious' | 'expected' | 'between' | null;
    };
    /**
     * The to-dos filed in the window whose week is over by `asOf`, or that
     * were finished or dropped already, and how many were finished within
     * seven days. One still open inside its week is neither.
     */
    todos: { total: number; withinWeek: number; share: number | null };
  };
  /** Every goal's latest grade, whatever the window. */
  latest: GoalGrade[];
}

interface RawGrade {
  goal_id: string; period_starts_on: string; period_due_on: string; commitment: GoalCommitment | null;
  score: string; basis: GradeBasis; predicted: string | null; actual: string | null; note: GradeNote | null;
}

function toGrade(row: RawGrade): GoalGrade {
  const score = Number(row.score);
  return {
    goalId: row.goal_id,
    periodStartsOn: row.period_starts_on,
    periodDueOn: row.period_due_on,
    commitment: row.commitment,
    score,
    basis: row.basis,
    predicted: row.predicted === null ? null : Number(row.predicted),
    actual: row.actual === null ? null : Number(row.actual),
    note: row.note,
    passed: row.commitment === 'committed' ? score >= 1 : null,
  };
}

const GRADE_COLUMNS = `goal_id, to_char(period_starts_on, 'YYYY-MM-DD') AS period_starts_on,
                       to_char(period_due_on, 'YYYY-MM-DD') AS period_due_on, commitment, score, basis, predicted, actual, note`;

/**
 * The company-level numbers over a window of days (`from` to `to`, both
 * YYYY-MM-DD, inclusive), as they stand at `asOf`, and each goal's latest
 * grade: what quarterly planning is handed (src/reporting/quarter.ts), what
 * the goal ladder shows, and what the plan page reads. Every statement names
 * the company.
 */
export async function gradeReportOf(
  tx: TenantClient,
  companyId: string,
  window: { from: string; to: string },
  asOf: Date,
): Promise<GradeReport> {
  const { rows: inWindow } = await tx.query<RawGrade>(
    `SELECT ${GRADE_COLUMNS} FROM goal_grades
      WHERE company_id = $1 AND period_due_on BETWEEN $2::date AND $3::date`,
    [companyId, window.from, window.to]);
  const grades = inWindow.map(toGrade);
  const committed = grades.filter((one) => one.commitment === 'committed');
  const aspirational = grades.filter((one) => one.commitment === 'aspirational');
  const passed = committed.filter((one) => one.passed).length;
  const average = aspirational.length > 0
    ? round2(aspirational.reduce((sum, one) => sum + one.score, 0) / aspirational.length) : null;

  // A quarterly priority is a key result with a quarter's period (goals.ts).
  // Once its period is graded, the grade says whether it was done, so this
  // share and the committed pass rate never disagree about one priority; a
  // goal marked met after its grade keeps the grade its period earned.
  const { rows: [priorities] } = await tx.query<{ total: number; done: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE coalesce(r.score >= 1, g.status = 'met'))::int AS done
       FROM goals g
       LEFT JOIN goal_grades r ON r.company_id = g.company_id AND r.goal_id = g.id AND r.period_due_on = g.due_on
      WHERE g.company_id = $1 AND g.kind = 'key_result' AND g.status <> 'abandoned'
        AND g.starts_on IS NOT NULL AND g.due_on - g.starts_on <= 92
        AND g.due_on BETWEEN $2::date AND $3::date`,
    [companyId, window.from, window.to]);

  // A to-do is work with an issue it solves or a due date, as the board
  // counts one. A closed one was dropped, and is counted as not finished.
  // One still open inside its week has neither kept nor broken its promise,
  // and is left out, or the newest week's to-dos would always read as missed.
  const { rows: [todos] } = await tx.query<{ total: number; within: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'done' AND closed_at <= created_at + make_interval(days => $4::int))::int AS within
       FROM tickets
      WHERE company_id = $1 AND kind = 'work' AND (solves_ticket_id IS NOT NULL OR due_on IS NOT NULL)
        AND created_at >= $2::date AND created_at < $3::date + 1
        AND (closed_at IS NOT NULL OR created_at + make_interval(days => $4::int) <= $5)`,
    [companyId, window.from, window.to, TODO_DAYS, asOf]);

  const { rows: latest } = await tx.query<RawGrade>(
    `SELECT DISTINCT ON (goal_id) ${GRADE_COLUMNS} FROM goal_grades
      WHERE company_id = $1 ORDER BY goal_id, period_due_on DESC`,
    [companyId]);

  return {
    from: window.from,
    to: window.to,
    numbers: {
      priorities: {
        total: priorities!.total, done: priorities!.done,
        share: priorities!.total > 0 ? round2(priorities!.done / priorities!.total) : null, aim: PRIORITIES_DONE_AIM,
      },
      committed: { graded: committed.length, passed, passRate: committed.length > 0 ? round2(passed / committed.length) : null },
      aspirational: {
        graded: aspirational.length, average, expected: ASPIRATIONAL_EXPECTED,
        reading: average === null ? null
          : average >= TOO_SAFE_FROM ? 'too_safe'
            : average < TOO_AMBITIOUS_BELOW ? 'too_ambitious'
              : average >= ASPIRATIONAL_EXPECTED[0] && average <= ASPIRATIONAL_EXPECTED[1] ? 'expected' : 'between',
      },
      todos: { total: todos!.total, withinWeek: todos!.within, share: todos!.total > 0 ? round2(todos!.within / todos!.total) : null },
    },
    latest: latest.map(toGrade),
  };
}
