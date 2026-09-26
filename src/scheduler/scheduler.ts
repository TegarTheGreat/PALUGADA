/**
 * Durable scheduling (PRD F9.1).
 *
 * Schedules live in the database, not in a timer inside a process, so a
 * restart loses nothing: the next occurrence is a column, and a worker coming
 * back finds everything that fell due while it was gone.
 *
 * Firing an occurrence is two writes that must not diverge -- create the task,
 * then advance the schedule -- and a crash can land between them. The order
 * here is deliberate: the task is created first under a key derived from the
 * schedule and the occurrence, so a retry after a crash produces the same task
 * rather than a second one, and only then is the schedule moved forward. The
 * reverse order would lose an occurrence outright, which is the worse failure:
 * a duplicate is visible, a silently skipped nightly job is not.
 */
import { PalugadaError } from '../errors.ts';

// cron-parser is CommonJS while its type declarations are written in ESM
// style, so the two disagree about what a named import means: TypeScript
// accepts `{ parseExpression }`, but Node's CommonJS named-export detection
// does not find it and the import fails at runtime. Taking the default export
// and destructuring works under both.
import cronParser from 'cron-parser';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { createRootTask, type TaskRow } from '../engine/tasks.ts';
import * as budget from '../engine/budget.ts';
import { appendEvent } from '../audit/event-log.ts';
import { raiseEscalationWithin } from '../inbox/inbox.ts';
import { assertTimeZone } from './windows.ts';

const { parseExpression } = cronParser;

export interface ScheduleInput {
  companyId: string;
  projectId: string;
  divisionId: string;
  roleId: string;
  /**
   * Which account the tasks this schedule creates draw on.
   *
   * Optional: omitted, F1.6's narrowest applicable account is looked up from
   * the division and role the schedule names. `schedules.budget_account_id` is
   * NOT NULL, so the choice is made once here and then held -- which is the
   * point, since a schedule that resolved its account at every firing would
   * silently move to a different ceiling the day somebody adds one.
   */
  budgetAccountId?: string;
  slug: string;
  cronExpression: string;
  timezone?: string;
  input?: Record<string, unknown>;
  reserveTokens?: number;
  enabled?: boolean;
  /**
   * F9.5: the tasks this schedule creates may wait for cheap hours.
   *
   * A recurring job is where most non-urgent work comes from -- a nightly
   * digest has no reason to run at the most expensive minute of the day.
   */
  batchable?: boolean;
  /** F2.7: the goal every task this schedule creates will serve. */
  goalId?: string;
}

/**
 * Computes the next occurrence strictly after `after`.
 *
 * Evaluated in the schedule's own zone rather than UTC, so "every weekday at
 * 08:00" means the company's morning and keeps meaning it across daylight
 * saving changes.
 */
export function nextOccurrence(
  cronExpression: string,
  timezone: string,
  after: Date,
): Date {
  const iterator = parseExpression(cronExpression, { currentDate: after, tz: timezone });
  return iterator.next().toDate();
}

/** Validates a cron expression, so a typo fails on save rather than at 03:00. */
export function assertValidCron(cronExpression: string, timezone: string): void {
  // The zone first: cron-parser refuses an unknown one too, but as "invalid
  // cron expression ... unhandled timestamp: null", which sends the owner to
  // look at the expression they typed correctly.
  assertTimeZone(timezone);
  try {
    parseExpression(cronExpression, { tz: timezone });
  } catch (error) {
    throw new PalugadaError(
      'contract.violation',
      `invalid cron expression ${JSON.stringify(cronExpression)}: ${(error as Error).message}`,
    );
  }
}

export async function upsertSchedule(input: ScheduleInput, now = new Date()): Promise<string> {
  const timezone = input.timezone ?? 'UTC';
  assertValidCron(input.cronExpression, timezone);
  const next = nextOccurrence(input.cronExpression, timezone, now);

  return withTenant(input.companyId, async (tx) => {
    const budgetAccountId = input.budgetAccountId
      ?? await budget.accountFor(tx, {
        companyId: input.companyId,
        roleId: input.roleId,
        divisionId: input.divisionId,
        projectId: input.projectId,
      });
    if (!budgetAccountId) {
      throw new PalugadaError(
        'contract.violation',
        'this company has no budget account for a schedule to draw on',
        { companyId: input.companyId },
      );
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO schedules
         (company_id, project_id, division_id, role_id, budget_account_id, slug,
          cron_expression, timezone, input, reserve_tokens, enabled, next_run_at,
          batchable, goal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (company_id, slug) DO UPDATE
         SET cron_expression = EXCLUDED.cron_expression,
             timezone        = EXCLUDED.timezone,
             input           = EXCLUDED.input,
             reserve_tokens  = EXCLUDED.reserve_tokens,
             enabled         = EXCLUDED.enabled,
             next_run_at     = EXCLUDED.next_run_at,
             batchable       = EXCLUDED.batchable,
             goal_id         = EXCLUDED.goal_id
       RETURNING id`,
      [
        input.companyId,
        input.projectId,
        input.divisionId,
        input.roleId,
        budgetAccountId,
        input.slug,
        input.cronExpression,
        timezone,
        JSON.stringify(input.input ?? {}),
        input.reserveTokens ?? 1000,
        input.enabled ?? true,
        next,
        input.batchable ?? false,
        input.goalId ?? null,
      ],
    );
    return rows[0]!.id;
  });
}

interface DueSchedule {
  id: string;
  company_id: string;
  project_id: string;
  division_id: string;
  role_id: string;
  budget_account_id: string;
  slug: string;
  cron_expression: string;
  timezone: string;
  input: Record<string, unknown>;
  reserve_tokens: string;
  batchable: boolean;
  goal_id: string | null;
  next_run_at: Date;
}

export interface FiredOccurrence {
  scheduleId: string;
  slug: string;
  companyId: string;
  taskId: string;
  occurrence: Date;
}

/**
 * Counts the occurrences between two instants, up to a cap.
 *
 * Used only to report how large a backlog was; the cap keeps a schedule that
 * has been down for a month from spending real time counting minutes.
 */
function countOccurrences(
  cronExpression: string,
  timezone: string,
  from: Date,
  to: Date,
  cap = 1000,
): number {
  const iterator = parseExpression(cronExpression, { currentDate: from, tz: timezone });
  let count = 0;
  while (count < cap) {
    const next = iterator.next().toDate();
    if (next > to) break;
    count += 1;
  }
  return count;
}

/**
 * Fires every schedule that has fallen due.
 *
 * The scan crosses tenants, so it runs on the control plane; each schedule's
 * work then happens inside its own tenant scope. A frozen company is skipped
 * rather than fired and cancelled, because F1.4 says a freeze stops tasks
 * starting, not that it manufactures cancelled ones.
 *
 * A backlog is collapsed rather than replayed. After a day of downtime an
 * hourly schedule owes twenty-four occurrences, and running all of them would
 * spend a day of budget in a minute and put twenty-four digests in the owner's
 * inbox -- the opposite of principle 1. So one catch-up run happens and the
 * schedule jumps to its next future occurrence. The occurrences that were
 * dropped are counted into the `schedule.fired` event rather than disappearing
 * quietly, because a schedule that silently skipped a night's work looks
 * exactly like one that had nothing to do.
 */
export async function runDueSchedules(now = new Date()): Promise<FiredOccurrence[]> {
  const due = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<DueSchedule>(
      `SELECT s.id, s.company_id, s.project_id, s.division_id, s.role_id,
              s.budget_account_id, s.slug, s.cron_expression, s.timezone,
              s.input, s.reserve_tokens, s.next_run_at, s.batchable, s.goal_id
         FROM schedules s
         JOIN companies c ON c.id = s.company_id
        WHERE s.enabled AND s.next_run_at <= $1 AND c.frozen_at IS NULL
        ORDER BY s.next_run_at`,
      [now],
    );
    return rows;
  });

  const fired: FiredOccurrence[] = [];

  for (const schedule of due) {
    const occurrence = schedule.next_run_at;
    const key = `schedule:${schedule.id}:${occurrence.toISOString()}`;

    let task: TaskRow;
    try {
      task = await createRootTask({
        companyId: schedule.company_id,
        projectId: schedule.project_id,
        divisionId: schedule.division_id,
        roleId: schedule.role_id,
        budgetAccountId: schedule.budget_account_id,
        input: schedule.input,
        createdBy: 'scheduler',
        reserveTokens: Number(schedule.reserve_tokens),
        idempotencyKey: key,
        batchable: schedule.batchable,
        ...(schedule.goal_id ? { goalId: schedule.goal_id } : {}),
      });
    } catch (error) {
      // A schedule that cannot be funded must not stall every schedule behind
      // it, and must not silently vanish either. Record it and move on; the
      // occurrence is retried on the next pass because the schedule was never
      // advanced.
      //
      // Recorded once per occurrence and reason, not once per pass (0038).
      // The pass runs every few seconds, and a schedule in a company whose
      // spend is paused wrote this event about seventeen thousand times a
      // day into a log retention keeps for a year. The row remembers what
      // last failed; the event is written only when that changes.
      const message = (error as Error).message;
      await withTenant(schedule.company_id, async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE schedules
              SET fire_failed_for = $2, fire_failure = $3
            WHERE id = $1
              AND (fire_failed_for IS DISTINCT FROM $2 OR fire_failure IS DISTINCT FROM $3)`,
          [schedule.id, occurrence, message],
        );
        if (rowCount !== 1) return;
        await appendEvent(tx, {
          companyId: schedule.company_id,
          projectId: schedule.project_id,
          type: 'schedule.fire_failed',
          actor: 'scheduler',
          payload: {
            scheduleId: schedule.id,
            slug: schedule.slug,
            occurrence: occurrence.toISOString(),
            error: message,
          },
        });
      });
      continue;
    }

    // Advance only after the task exists. The guard on next_run_at makes this
    // safe when two workers scan at once: the loser updates nothing and its
    // task creation was idempotent, so the occurrence fires exactly once.
    //
    // Compared at the millisecond, because `occurrence` came out of the column
    // through a JavaScript Date. A next_run_at with microseconds in it -- set
    // by hand, or by anything other than `nextOccurrence` -- never equalled
    // its own rounded copy, so the schedule never advanced and fired the same
    // occurrence on every tick.
    const advanced = await withTenant(schedule.company_id, async (tx) => {
      const next = nextOccurrence(schedule.cron_expression, schedule.timezone, now);
      const skipped = countOccurrences(
        schedule.cron_expression,
        schedule.timezone,
        occurrence,
        now,
      );
      const { rowCount } = await tx.query(
        `UPDATE schedules
            SET last_run_at = $2, next_run_at = $3,
                fire_failed_for = NULL, fire_failure = NULL
          WHERE id = $1 AND date_trunc('milliseconds', next_run_at) = $2`,
        [schedule.id, occurrence, next],
      );
      if (rowCount === 1) {
        await appendEvent(tx, {
          companyId: schedule.company_id,
          projectId: schedule.project_id,
          taskId: task.id,
          type: 'schedule.fired',
          actor: 'scheduler',
          payload: {
            scheduleId: schedule.id,
            slug: schedule.slug,
            occurrence: occurrence.toISOString(),
            nextRunAt: next.toISOString(),
            skippedOccurrences: skipped,
          },
        });
      }
      return rowCount === 1;
    });

    if (advanced) {
      // After the occurrence fired, never instead of it: whether a schedule is
      // still worth paying for is the owner's question, and a schedule that
      // stopped itself on a guess would be the platform deciding it.
      await askAboutRepetition(schedule, task.id).catch(() => undefined);
      fired.push({
        scheduleId: schedule.id,
        slug: schedule.slug,
        companyId: schedule.company_id,
        taskId: task.id,
        occurrence,
      });
    }
  }

  return fired;
}

/** How many identical results in a row make a schedule worth asking about. */
export const REPETITION_RUNS = 5;

/**
 * Asks the owner once when a schedule keeps producing the same result.
 *
 * auto-company calls it stalling -- "the same next action two cycles running"
 * -- and Paperclip throttles an agent whose runs leave no visible trace; both
 * are the same observation: work that repeats itself exactly is usually work
 * that has stopped being useful, and a schedule does not notice that about
 * itself. Five completed runs with byte-identical output are put to the owner
 * as an escalation: deny turns the schedule off, approve keeps it and is not
 * asked again about that same result. Once per result, recorded as
 * `schedule.repetition_noticed`, so a schedule that is fine producing the
 * same report every morning is asked once and then left alone.
 *
 * Best-effort, and after the occurrence has fired: failing to ask must never
 * be the reason a schedule did not run.
 */
async function askAboutRepetition(schedule: DueSchedule, justFired: string): Promise<void> {
  await withTenant(schedule.company_id, async (tx) => {
    // The runs before the one just created, which has not run yet.
    const { rows } = await tx.query<{ status: string; digest: string | null }>(
      `SELECT status, md5(output::text) AS digest FROM tasks
        WHERE company_id = $1 AND idempotency_key LIKE $2 AND id <> $4
        ORDER BY created_at DESC
        LIMIT $3`,
      [schedule.company_id, `schedule:${schedule.id}:%`, REPETITION_RUNS, justFired],
    );
    if (rows.length < REPETITION_RUNS) return;
    if (rows.some((row) => row.status !== 'completed' || row.digest === null)) return;
    const digest = rows[0]!.digest!;
    if (rows.some((row) => row.digest !== digest)) return;

    // Once per result, under a lock, so two workers firing the same schedule
    // ask once between them.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('repetition:' || $1))", [schedule.id]);
    const { rows: seen } = await tx.query(
      `SELECT 1 FROM events
        WHERE company_id = $1 AND type = 'schedule.repetition_noticed'
          AND payload->>'scheduleId' = $2 AND payload->>'outputDigest' = $3
        LIMIT 1`,
      [schedule.company_id, schedule.id, digest],
    );
    if (seen.length > 0) return;
    await appendEvent(tx, {
      companyId: schedule.company_id,
      projectId: schedule.project_id,
      type: 'schedule.repetition_noticed',
      actor: 'scheduler',
      payload: { scheduleId: schedule.id, slug: schedule.slug, outputDigest: digest, runs: REPETITION_RUNS },
    });
    // With the record, so "noticed" never stands without the question.
    await raiseEscalationWithin(tx, {
      companyId: schedule.company_id,
      scheduleId: schedule.id,
      title: `Schedule ${schedule.slug} keeps producing the same result`,
      detail:
        `Its last ${REPETITION_RUNS} runs all completed with identical output. That is sometimes `
        + 'exactly right -- a report that has nothing new to say -- and often a schedule that '
        + 'stopped doing anything useful while still being paid for. Deny to turn it off; '
        + 'approve to keep it running and not be asked about this result again.',
    });
  });
}
