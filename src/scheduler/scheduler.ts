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
import { randomUUID } from 'node:crypto';
import { PalugadaError } from '../errors.ts';

// cron-parser is CommonJS while its type declarations are written in ESM
// style, so the two disagree about what a named import means: TypeScript
// accepts `{ parseExpression }`, but Node's CommonJS named-export detection
// does not find it and the import fails at runtime. Taking the default export
// and destructuring works under both.
import cronParser from 'cron-parser';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { TERMINAL_STATUSES, type TaskStatus } from '../domain/task.ts';
import { createRootTask, type TaskRow } from '../engine/tasks.ts';
import * as budget from '../engine/budget.ts';
import { appendEvent } from '../audit/event-log.ts';
import { raiseEscalationWithin } from '../inbox/inbox.ts';
import { assertTimeZone } from './windows.ts';
import { buildWeekFacts } from '../reporting/week.ts';

const { parseExpression } = cronParser;

/** A scheduled task's place in the queue when its schedule does not say (F5.10). */
const DEFAULT_SCHEDULE_PRIORITY = 2;

export interface ScheduleInput {
  companyId: string;
  /**
   * F5.10: where this schedule's tasks stand in the queue, 0 (first) to 3.
   * The column existed from 0023 and nothing wrote or read it, so every
   * scheduled task ran at the default whatever the schedule was for.
   */
  priority?: number | undefined;
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
          batchable, goal_id, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (company_id, slug) DO UPDATE
         SET cron_expression = EXCLUDED.cron_expression,
             priority        = EXCLUDED.priority,
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
        input.priority ?? DEFAULT_SCHEDULE_PRIORITY,
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
  priority: number;
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
              s.input, s.reserve_tokens, s.next_run_at, s.batchable, s.goal_id, s.priority
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
      // Inside the `try`, so a week that cannot be read is a failed
      // occurrence, recorded and tried again, like one that cannot be funded.
      task = await createScheduledTask(schedule, { createdBy: 'scheduler', idempotencyKey: key, now });
    } catch (error) {
      // A schedule whose goal the owner has closed is paused, not retried:
      // closing the goal paused it once (goals.ts), and one turned back on by
      // hand while the goal is still closed would otherwise be refused on
      // every pass for as long as nobody looked.
      if (error instanceof PalugadaError && error.code === 'goal.closed') {
        await withTenant(schedule.company_id, async (tx) => {
          await tx.query('UPDATE schedules SET enabled = false WHERE id = $1', [schedule.id]);
          await appendEvent(tx, {
            companyId: schedule.company_id,
            projectId: schedule.project_id,
            type: 'schedule.paused',
            actor: 'scheduler',
            payload: { scheduleId: schedule.id, slug: schedule.slug, reason: error.message },
          });
        });
        continue;
      }
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

/** What one run of a schedule is made from, whether the clock or the owner starts it. */
type ScheduleWork = Pick<DueSchedule,
  | 'id' | 'company_id' | 'project_id' | 'division_id' | 'role_id' | 'budget_account_id'
  | 'input' | 'reserve_tokens' | 'batchable' | 'goal_id' | 'priority'>;

/**
 * Creates the task one run of a schedule does.
 *
 * One function for the occurrence the clock fires and the run the owner asks
 * for, so the two cannot drift apart: the same division, role, project,
 * account, input, priority, batching and goal, and the task names the
 * schedule, which is what puts it in the schedule's history.
 *
 * A schedule whose input asks for the week -- the weekly business review's
 * does (bundles/builtin.ts) -- is handed it, read from the company's records
 * as the run starts (reporting/week.ts).
 */
async function createScheduledTask(
  schedule: ScheduleWork,
  run: { createdBy: 'scheduler' | 'owner'; idempotencyKey: string; now: Date },
): Promise<TaskRow> {
  const week = schedule.input.facts === 'week' ? await buildWeekFacts(schedule.company_id, run.now) : null;
  const outside = week?.finished.filter((one) => one.outside).map((one) => one.task) ?? [];
  return createRootTask({
    companyId: schedule.company_id,
    projectId: schedule.project_id,
    divisionId: schedule.division_id,
    roleId: schedule.role_id,
    budgetAccountId: schedule.budget_account_id,
    input: week ? { ...schedule.input, week } : schedule.input,
    // What finished work reported after reading outside content is in the
    // week, as data; the review carries that, as work that read it itself
    // would (F8.9).
    ...(outside.length > 0 ? { carriesOutside: { capability: 'the week it was handed', tasks: outside } } : {}),
    createdBy: run.createdBy,
    reserveTokens: Number(schedule.reserve_tokens),
    idempotencyKey: run.idempotencyKey,
    scheduleId: schedule.id,
    priority: schedule.priority,
    batchable: schedule.batchable,
    ...(schedule.goal_id ? { goalId: schedule.goal_id } : {}),
  });
}

/**
 * The newest task a schedule made that has not ended, if there is one.
 *
 * In the caller's transaction, so it reads under whatever the caller holds;
 * running a schedule now holds the schedule's lock around it. Sub-tasks are
 * not looked at: a task does not end while work it delegated is still going.
 */
async function liveTaskOf(
  tx: TenantClient,
  scheduleId: string,
): Promise<{ id: string; status: TaskStatus } | null> {
  const { rows } = await tx.query<{ id: string; status: TaskStatus }>(
    `SELECT id, status FROM tasks
      WHERE schedule_id = $1 AND status <> ALL ($2::text[])
      ORDER BY created_at DESC, id
      LIMIT 1`,
    [scheduleId, TERMINAL_STATUSES],
  );
  return rows[0] ?? null;
}

/**
 * Runs a schedule once, now, because the owner asked, and returns the task.
 *
 * The task is the one an occurrence would make, by the same function, except
 * that the owner made it. The schedule's cadence is left alone: `next_run_at`
 * and `last_run_at` are not touched, because an extra run is not an
 * occurrence -- an owner who tries the weekly review on a Thursday still gets
 * Monday's.
 *
 * A schedule that is off may be run. Trying one once before turning it on is
 * most of what this is for -- a bundle installs its schedules off -- and
 * running it does not turn it on, which stays the owner's separate decision.
 * One paused because its goal closed is refused all the same, by the goal:
 * `createRootTask` starts no work under a closed goal, whoever asks.
 *
 * Refused while a task the schedule made has not ended, naming that task, so
 * a second press -- or an owner pressing again because nothing seemed to
 * happen -- does not start the same work twice. Two presses at once are
 * serialized on the schedule by a transaction-level advisory lock, held from
 * the check until the new task has committed: the second waits for the lock,
 * then finds the first one's task live and is refused. The lock is taken on
 * the control plane, whose pool no task creation draws on, so a press waiting
 * for it never holds a connection the press it waits for needs. A lock rather
 * than `FOR UPDATE` on the schedule row, which would also hold up the clock
 * advancing the schedule and the owner editing it for as long as the week
 * takes to read; and rather than a key that hands the second press the first
 * one's task, because two racing presses would have to derive the same key
 * from what they read, and an owner who pressed twice should be told the run
 * is under way, not handed it as if theirs had started it.
 */
export async function runScheduleNow(companyId: string, scheduleId: string, now = new Date()): Promise<TaskRow> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<ScheduleWork & { slug: string; enabled: boolean; frozen: boolean }>(
      `SELECT s.id, s.company_id, s.project_id, s.division_id, s.role_id, s.budget_account_id,
              s.slug, s.enabled, s.input, s.reserve_tokens, s.batchable, s.goal_id, s.priority,
              c.frozen_at IS NOT NULL AS frozen
         FROM schedules s
         JOIN companies c ON c.id = s.company_id
        WHERE s.id = $1 AND s.company_id = $2`,
      [scheduleId, companyId],
    );
    const schedule = rows[0];
    if (!schedule) {
      throw new PalugadaError('contract.violation', 'no such schedule in this company', { scheduleId });
    }
    // F1.4: a freeze stops tasks starting. The clock passes over a frozen
    // company's schedules; the owner pressing one is told why nothing runs.
    if (schedule.frozen) {
      throw new PalugadaError(
        'company.frozen', 'this company is frozen and starts no work; unfreeze it first', { companyId },
      );
    }

    await tx.query("SELECT pg_advisory_xact_lock(hashtext('schedule-run:' || $1))", [scheduleId]);
    const live = await liveTaskOf(tx, scheduleId);
    if (live) {
      throw new PalugadaError(
        'schedule.still_running',
        `schedule ${schedule.slug} is still on task ${live.id}, which is ${live.status}; `
          + 'open that task, or run the schedule again once it has ended',
        { scheduleId, taskId: live.id, status: live.status },
      );
    }

    // A key of its own for every press. Left to derive one, the engine keys a
    // task by its role and input, which two runs of the same schedule share
    // once it is not handed the week, so the second run after the first had
    // ended was refused as a duplicate of it. The lock and the check above
    // are what make one press one task; this only has to differ.
    const task = await createScheduledTask(schedule, {
      createdBy: 'owner', idempotencyKey: `schedule:${schedule.id}:owner:${randomUUID()}`, now,
    });
    await appendEvent(tx, {
      companyId,
      projectId: schedule.project_id,
      taskId: task.id,
      type: 'schedule.run_by_owner',
      actor: 'owner',
      payload: { scheduleId: schedule.id, slug: schedule.slug, enabled: schedule.enabled },
    });
    return task;
  });
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
        WHERE schedule_id = $1 AND id <> $3
        ORDER BY created_at DESC
        LIMIT $2`,
      [schedule.id, REPETITION_RUNS, justFired],
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
