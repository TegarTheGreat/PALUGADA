/**
 * A goal nobody has worked on is put to the CEO, without being asked (the
 * audit of 10 October; STATUS had listed the goal-level cadence as not done
 * since the audit of 3 October, P1 items 1 and 2).
 *
 * Everything else the platform starts by itself starts from a record somebody
 * made: a schedule, a ticket, a measure that moved, an invoice that fell due.
 * A company whose owner said what it is for and walked away gave all of them
 * nothing to read, and its goal sat: a day of nothing, then a week. Now a goal
 * at the end of the company's ladder -- one with no open goal below it -- that
 * has had no work under it for `IDLE_DAYS` makes one task for the CEO, which
 * decides what comes next: work handed to the role whose job it is, a schedule
 * proposed for work owed again and again, the role the company lacks proposed
 * for hiring, or, when the goal waits on the owner or the world, nothing.
 *
 * What keeps it from becoming a meter running on nothing, as the other sweeps
 * are kept (triage.ts, outcomes.ts):
 *
 *  - **Nothing owed, nothing made.** One read; no task, no event, no model
 *    call while every goal has work under it or was looked at this week.
 *  - **A goal at most once a week** (`REVIEW_AGAIN_DAYS`), and the task under
 *    it is work too, so a goal looked at is not idle again for three days.
 *  - **One at a time for a company, one an hour,** the goal idle longest first.
 *  - **Only where a model can think about it.** The worker asks only when the
 *    deployment has one: a task no runtime can take would halt every week and
 *    be reported to the owner every week.
 *  - **The brief is the platform's words** (F8.9): the goal's statement, which
 *    is the owner's or one the owner's yes made, cut to a line, and numbers.
 *  - **Not while the company winds down,** and nothing for a CEO that is frozen.
 *
 * Two workers that decide at once make one task between them: the key is made
 * from the goal and when it was last worked on, and the unique index on it
 * does the rest.
 */
import { createHash } from 'node:crypto';
import { withTenant } from '../db/tenant.ts';
import { isPalugadaError } from '../errors.ts';
import { languageName, languagesFor } from '../domain/language.ts';
import { withoutTemplateTokens } from '../context/builder.ts';
import { wellFormed } from '../text.ts';
import { createRootTask } from './tasks.ts';

/** Days with no work under a goal before it is looked at. */
export const IDLE_DAYS = 3;
/** The least time between two looks at the same goal. */
export const REVIEW_AGAIN_DAYS = 7;
/** The least time between one look and the next for a company. */
export const REVIEW_EVERY_MS = 60 * 60_000;
/** A goal's statement is a line in the brief: the CEO's context holds the rest. */
const STATEMENT_SHOWN = 200;

interface Idle {
  id: string;
  kind: string;
  statement: string;
  idle_days: number;
  worked: boolean;
  /** When the goal's last work was made, or the goal was: what the key is made from. */
  since: string;
}

/**
 * The goal waiting longest: active, with no active goal below it, no work
 * under it or below it still to do, none made in `IDLE_DAYS` (nor the goal),
 * and no look at it in `REVIEW_AGAIN_DAYS`. $1 is the clock.
 */
const IDLE = `
  WITH RECURSIVE live AS (
    SELECT id, parent_goal_id, kind, statement, created_at FROM goals WHERE status = 'active'
  ), ends AS (
    SELECT l.* FROM live l WHERE NOT EXISTS (SELECT 1 FROM live c WHERE c.parent_goal_id = l.id)
  ), below AS (
    SELECT e.id AS goal, e.id AS under FROM ends e
    UNION ALL
    SELECT b.goal, g.id FROM below b JOIN goals g ON g.parent_goal_id = b.under
  ), judged AS (
    SELECT e.id, e.kind, e.statement, e.created_at,
           (SELECT max(t.created_at) FROM tasks t WHERE t.goal_id IN (SELECT under FROM below WHERE goal = e.id)) AS last_work,
           EXISTS (SELECT 1 FROM tasks t
                    WHERE t.goal_id IN (SELECT under FROM below WHERE goal = e.id)
                      AND t.status NOT IN ('completed', 'failed', 'halted', 'cancelled')) AS open_work,
           EXISTS (SELECT 1 FROM tasks t
                    WHERE t.goal_id = e.id AND t.idempotency_key LIKE 'review:%'
                      AND t.created_at > $1::timestamptz - make_interval(days => $3::int)) AS looked
      FROM ends e
  )
  SELECT id, kind, statement,
         floor(extract(epoch FROM ($1::timestamptz - greatest(created_at, coalesce(last_work, created_at)))) / 86400)::int AS idle_days,
         last_work IS NOT NULL AS worked,
         to_char(greatest(created_at, coalesce(last_work, created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS since
    FROM judged
   WHERE NOT open_work AND NOT looked
     AND greatest(created_at, coalesce(last_work, created_at)) < $1::timestamptz - make_interval(days => $2::int)
   ORDER BY greatest(created_at, coalesce(last_work, created_at)), id
   LIMIT 1`;

/** The id of the review task made, or null when no goal was owed a look, or one was made a moment ago. */
export async function ensureGoalReview(companyId: string, now = new Date()): Promise<string | null> {
  const found = await withTenant(companyId, async (tx) => {
    const { rows: ceo } = await tx.query<{ id: string; division_id: string }>(
      "SELECT id, division_id FROM roles WHERE title = 'CEO' AND frozen_at IS NULL ORDER BY created_at LIMIT 1");
    if (!ceo[0]) return null;
    const { rows: stage } = await tx.query<{ stage: string | null }>('SELECT stage FROM companies WHERE id = $1', [companyId]);
    if (stage[0]?.stage === 'wind_down') return null;

    // One look at a time, and one an hour: a company with many idle goals is
    // looked at in turn, not all at once.
    const { rows: recent } = await tx.query(
      `SELECT 1 FROM tasks
        WHERE idempotency_key LIKE 'review:%'
          AND (status NOT IN ('completed', 'failed', 'halted', 'cancelled')
               OR created_at > $1::timestamptz - make_interval(secs => $2::float8))
        LIMIT 1`,
      [now, REVIEW_EVERY_MS / 1000]);
    if (recent.length > 0) return null;

    const { rows: idle } = await tx.query<Idle>(IDLE, [now, IDLE_DAYS, REVIEW_AGAIN_DAYS]);
    if (!idle[0]) return null;
    const { rows: project } = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1');
    if (!project[0]) return null;
    const language = languageName((await languagesFor(tx, companyId)).talk);
    return { ceo: ceo[0], projectId: project[0].id, goal: idle[0], language };
  });
  if (!found) return null;

  const { ceo, projectId, goal, language } = found;
  // The goal and when it was last worked on: a second worker deciding the
  // same makes the same key, and the unique index keeps one. The look is
  // itself work under the goal, so the next look has another key.
  const key = `review:${createHash('sha256').update(`${goal.id}|${goal.since}`).digest('hex').slice(0, 24)}`;
  try {
    const task = await createRootTask({
      companyId, projectId, divisionId: ceo.division_id, roleId: ceo.id, goalId: goal.id,
      createdBy: 'event', idempotencyKey: key,
      input: { ...briefFor(goal, language), review: goal.id },
      // A look yields to work somebody asked for.
      priority: 3,
    });
    return task.id;
  } catch (error) {
    // A paused month, a goal closed a moment ago, a budget that cannot cover
    // it, the same key already made: each is a reason nothing starts now, and
    // the next look finds it again.
    if (isPalugadaError(error)) return null;
    throw error;
  }
}

/** The goal's statement as one short line that cannot open a quotation or a template. */
function oneLine(statement: string): string {
  return wellFormed(withoutTemplateTokens(statement).replace(/\s+/g, ' ').replaceAll('"', "'").trim().slice(0, STATEMENT_SHOWN).trim());
}

/** What the CEO is told: the platform's words, the goal's own statement and numbers. */
function briefFor(goal: Idle, language: string): { goal: string; context: string } {
  const statement = oneLine(goal.statement);
  const days = Math.max(goal.idle_days, IDLE_DAYS);
  const kind = goal.kind === 'mission' ? 'the company\'s mission' : goal.kind === 'key_result' ? 'a key result' : 'an objective';
  return {
    goal: `Goal "${statement}" has had no work for ${days} days: decide what the company does next toward it.`,
    context: [
      'The platform made this task from the company\'s own records; no person or agent wrote it. '
        + `Goal "${statement}" is ${kind}. ${goal.worked ? `Its last work was made ${days} days ago, and none is open.` : `It was set ${days} days ago, and nothing has been done toward it yet.`}`,
      'Decide the next useful piece of work toward it, and see that it is done: hand it to the role whose job it is '
        + 'with task.delegate, with a brief that says what done looks like, and wait for it with task.await; or do it '
        + 'yourself as far as your own tools reach. When the same work will be owed again and again, propose a schedule '
        + 'for it with schedule.propose. When the company has no role for it, file a ticket with ticket.create whose '
        + 'kind is "hire", saying which role and what work it would take over: the owner is shown it, and hires it '
        + 'with you in a word.',
      'If the goal waits on the owner, on a customer or on time, say so in one line and stop: do not invent work to '
        + `look busy. Ask the owner only what only they can decide, at most once, and write it in ${language}. `
        + 'You cannot close or change the goal; only the owner can.',
    ].join('\n\n'),
  };
}
