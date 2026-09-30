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
import { createRootTask, type TaskRow } from '../engine/tasks.ts';
import * as budget from '../engine/budget.ts';
import { appendEvent } from '../audit/event-log.ts';
import { raiseEscalationWithin } from '../inbox/inbox.ts';
import { TERMINAL_STATUSES, type TaskStatus } from '../domain/task.ts';
import { assertTimeZone, instantsShowing, wallClockAt } from './windows.ts';
import { buildWeekFacts } from '../reporting/week.ts';

const { parseExpression } = cronParser;

/** A scheduled task's place in the queue when its schedule does not say (F5.10). */
const DEFAULT_SCHEDULE_PRIORITY = 2;

/**
 * What a due occurrence does while a task this schedule made is still live.
 *
 * `skip` does not run it and moves on; `queue` waits and runs once the live
 * task has ended; `allow` runs beside it. Skip is the default because a
 * second run beside a live one is twice the spend on the same work, and the
 * live one is usually live for a reason -- still working, or waiting for the
 * owner -- that a second run would not change.
 */
export const OVERLAP_POLICIES = ['skip', 'queue', 'allow'] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

/**
 * The shortest catch-up window a schedule may have, in minutes.
 *
 * The window is for downtime, and it must not mistake an ordinary pass for
 * downtime. The pass runs every five seconds on an idle worker, but it shares
 * its tick with the rest of the housekeeping -- reclaiming leases, telling
 * the owner, distilling memory, which waits on a model -- and a worker with
 * one place runs up to eight tasks between two passes. A restart to apply a
 * setting or a new version adds its minute or two. An occurrence found
 * several minutes after it fell due is a working deployment, and a window
 * shorter than this would drop occurrences on a busy morning that nobody
 * would call missed. Fifteen minutes is above that lag and still short enough
 * for work whose value is being on time.
 */
const MIN_CATCH_UP_MINUTES = 15;

/** A year: no cron expression has a longer gap, so a longer window means nothing more. */
const MAX_CATCH_UP_MINUTES = 525_600;

/**
 * Refuses an overlap policy or catch-up window the scheduler does not know,
 * naming what it does. One check for every way a schedule is written -- the
 * owner's form, a bundle's cadence, a direct call -- so they cannot disagree;
 * the columns' CHECK constraints (0099) say the same to anything else.
 */
export function assertScheduleTiming(timing: { overlap?: unknown; catchUpMinutes?: unknown }): void {
  const { overlap, catchUpMinutes } = timing;
  if (overlap !== undefined && !(OVERLAP_POLICIES as readonly unknown[]).includes(overlap)) {
    throw new PalugadaError(
      'contract.violation',
      `overlap is ${String(overlap)}; it is one of ${OVERLAP_POLICIES.join(', ')} `
        + '(skip an occurrence while the last run is live, run it when that run ends, or run both)',
      { field: 'overlap' },
    );
  }
  if (catchUpMinutes === undefined || catchUpMinutes === null) return;
  if (typeof catchUpMinutes !== 'number' || !Number.isInteger(catchUpMinutes)) {
    throw new PalugadaError(
      'contract.violation',
      `catchUpMinutes is ${String(catchUpMinutes)}; a catch-up window is a whole number of minutes, `
        + 'or unset to always run a missed occurrence once',
      { field: 'catchUpMinutes' },
    );
  }
  if (catchUpMinutes < MIN_CATCH_UP_MINUTES) {
    throw new PalugadaError(
      'contract.violation',
      `catchUpMinutes is ${catchUpMinutes}; a catch-up window is at least ${MIN_CATCH_UP_MINUTES} minutes, `
        + 'because a working deployment can find an occurrence several minutes after it fell due and a '
        + 'shorter window would drop it. Leave it unset to always run a missed occurrence once',
      { field: 'catchUpMinutes' },
    );
  }
  if (catchUpMinutes > MAX_CATCH_UP_MINUTES) {
    throw new PalugadaError(
      'contract.violation',
      `catchUpMinutes is ${catchUpMinutes}; a catch-up window is at most ${MAX_CATCH_UP_MINUTES} minutes, a year`,
      { field: 'catchUpMinutes' },
    );
  }
}

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
  /** F9.1: what a due occurrence does while an earlier run is live; `skip` when not given. */
  overlap?: OverlapPolicy;
  /**
   * F9.1: how many minutes late an occurrence may be and still run. Unset or
   * null, one catch-up run happens however late, as it always has.
   */
  catchUpMinutes?: number | null;
}

/**
 * Computes the next occurrence strictly after `after`.
 *
 * Evaluated in the schedule's own zone rather than UTC, so "every weekday at
 * 08:00" means the company's morning and keeps meaning it across daylight
 * saving changes. What it means on the nights the clock changes is Vixie
 * cron's rule:
 *
 * - A schedule with fixed hours runs once for each time the clock shows it.
 *   When the clock goes back and shows 01:30 twice, it runs at the first.
 *   When the clock goes forward past 02:30, it runs once at the instant of
 *   the jump (03:00 in New York); every time skipped in that jump is that
 *   one run, and the day's runs keep their order.
 * - A schedule whose hour field is every hour (`*`, `0-23`, or a step of one)
 *   runs by real time: every instant the clock shows one of its minutes. It runs
 *   at both 01:00s when the clock goes back, and nothing is owed for an hour
 *   the clock skipped, because none passed.
 *
 * The rule names a fixed set of instants, so the answer does not depend on
 * where the search starts: a pass that fires 01:30 EDT late, at 01:05 EST,
 * gets the next day, as one on time does, and the scheduler can go on
 * asking from `now`. cron-parser does not keep to that. Asked in the zone,
 * it gave the second 01:30 when asked from inside the repeated hour (the
 * job ran twice), gave both 01:45s at Lord Howe's half-hour change, and lost
 * the day's run at a jump when asked just after it -- and at Santiago's
 * midnight jump and Lord Howe's half-hour one, even when asked days ahead.
 * So it is asked only in UTC, where it enumerates wall-clock readings with
 * no changes at all, and the readings are placed in the zone here
 * (`instantsShowing`).
 */
export function nextOccurrence(
  cronExpression: string,
  timezone: string,
  after: Date,
): Date {
  return occurrencesAfter(cronExpression, timezone, after).next().value;
}

const DAY_MS = 86_400_000;

/**
 * Every run of a schedule after `after`, in order, by the rule above.
 *
 * The readings come in order but their instants need not: the second pass of
 * a repeated 01:30 is later than the first pass of 01:45. Each reading's
 * earliest instant (or its jump) is a floor under every later reading's, so
 * the runs found are held until the floor passes them, and then given up
 * in order, each once.
 */
function* occurrencesAfter(
  cronExpression: string,
  timezone: string,
  after: Date,
): Generator<Date, never> {
  const from = after.getTime();
  // An instant after `from` shows an earlier reading than `from` does only
  // when the clock goes back in between; a day ahead covers any change that
  // could, and a second earlier keeps a reading exactly at the start.
  const earliestReading = Math.min(
    wallClockAt(timezone, from),
    wallClockAt(timezone, from + DAY_MS) - DAY_MS,
  );
  const readings = parseExpression(cronExpression, {
    currentDate: new Date(earliestReading - 1000),
    tz: 'UTC',
  });
  const everyHour = readings.fields.hour.length === 24;

  const held: number[] = [];
  let last = from;
  for (;;) {
    const reading = readings.next().getTime();
    const { instants, jump } = instantsShowing(timezone, reading);
    const floor = instants[0] ?? jump!;
    for (const run of everyHour ? instants : [floor]) {
      if (run > last) held.push(run);
    }
    held.sort((a, b) => a - b);
    while (held.length > 0 && held[0]! <= floor) {
      const run = held.shift()!;
      if (run > last) {
        last = run;
        yield new Date(run);
      }
    }
  }
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
  assertScheduleTiming(input);
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
          batchable, goal_id, priority, overlap, catch_up_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (company_id, slug) DO UPDATE
         SET cron_expression  = EXCLUDED.cron_expression,
             priority         = EXCLUDED.priority,
             timezone         = EXCLUDED.timezone,
             input            = EXCLUDED.input,
             reserve_tokens   = EXCLUDED.reserve_tokens,
             enabled          = EXCLUDED.enabled,
             next_run_at      = EXCLUDED.next_run_at,
             batchable        = EXCLUDED.batchable,
             goal_id          = EXCLUDED.goal_id,
             overlap          = EXCLUDED.overlap,
             catch_up_minutes = EXCLUDED.catch_up_minutes,
             -- Saving moves the schedule to its next future occurrence, so
             -- nothing is due and nothing is being held for.
             held_by_task_id  = NULL
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
        input.overlap ?? 'skip',
        input.catchUpMinutes ?? null,
      ],
    );
    return rows[0]!.id;
  });
}

/** A task a schedule made that has not ended. */
interface LiveScheduledTask {
  id: string;
  status: TaskStatus;
}

/**
 * The newest task this schedule made that is not terminal, or null.
 *
 * `except` leaves out the task an occurrence's own key names: a crash between
 * creating an occurrence's task and advancing the schedule leaves that task
 * live and the occurrence still due, and the occurrence must not give way to
 * itself.
 *
 * The terminal statuses are written into the statement rather than passed as
 * a parameter so that it matches `tasks_schedule_live_idx` (0099), whose
 * predicate spells the same list; were the list to change, the index would
 * stop being used and the answer would still be right.
 */
async function liveTaskOf(
  tx: TenantClient,
  scheduleId: string,
  options: { except?: string } = {},
): Promise<LiveScheduledTask | null> {
  const terminal = TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');
  const { rows } = await tx.query<LiveScheduledTask>(
    `SELECT id, status FROM tasks
      WHERE schedule_id = $1 AND status NOT IN (${terminal})
        AND idempotency_key IS DISTINCT FROM $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [scheduleId, options.except ?? null],
  );
  return rows[0] ?? null;
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
  overlap: OverlapPolicy;
  catch_up_minutes: number | null;
}

export interface FiredOccurrence {
  scheduleId: string;
  slug: string;
  companyId: string;
  taskId: string;
  occurrence: Date;
}

/**
 * Counts the occurrences after `from` up to and including `to`, up to a cap.
 *
 * Used only to report how large a backlog was; the cap keeps a schedule that
 * has been down for a month from spending real time counting minutes. The
 * runs counted are the ones `nextOccurrence` gives, by the same rule, so a
 * run the clock's change folded into another is counted once and a run at
 * a jump is not lost between the two.
 */
function countOccurrences(
  cronExpression: string,
  timezone: string,
  from: Date,
  to: Date,
  cap = 1000,
): number {
  let count = 0;
  for (const run of occurrencesAfter(cronExpression, timezone, from)) {
    if (run > to || count === cap) break;
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
 *
 * Before any of that, an occurrence may give way (`giveWay`): to its
 * schedule's catch-up window when it is too late to be worth running, and to
 * a run the schedule made earlier that is still live.
 */
export async function runDueSchedules(now = new Date()): Promise<FiredOccurrence[]> {
  const due = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<DueSchedule>(
      `SELECT s.id, s.company_id, s.project_id, s.division_id, s.role_id,
              s.budget_account_id, s.slug, s.cron_expression, s.timezone,
              s.input, s.reserve_tokens, s.next_run_at, s.batchable, s.goal_id, s.priority,
              s.overlap, s.catch_up_minutes
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

    if (await giveWay(schedule, key, now)) continue;

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
                fire_failed_for = NULL, fire_failure = NULL, held_by_task_id = NULL
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

/**
 * Whether a due occurrence is later than its schedule's catch-up window.
 *
 * Measured from the latest occurrence that has fallen due, not the oldest.
 * An hourly job with a thirty-minute window, back from three hours down at
 * ten past, has an occurrence ten minutes old: that one is still worth
 * running, and the two before it are the backlog that collapses into it. Put
 * the other way: the occurrence is too late when neither it nor any later
 * occurrence up to now falls inside the window.
 */
function pastCatchUp(schedule: DueSchedule, now: Date): boolean {
  if (schedule.catch_up_minutes === null) return false;
  const edge = new Date(now.getTime() - schedule.catch_up_minutes * 60_000);
  if (schedule.next_run_at >= edge) return false;
  return nextOccurrence(schedule.cron_expression, schedule.timezone, edge) > now;
}

/**
 * Lets a due occurrence give way instead of creating a task, and says so once.
 * True when it gave way: the caller creates nothing for it this pass.
 *
 * Too late for its catch-up window, it is dropped with every occurrence
 * behind it, and the schedule moves to its next future one
 * (`schedule.missed`). With a run this schedule made still live, `skip` drops
 * it the same way (`schedule.skipped`), and `queue` leaves the schedule where
 * it is until that run ends (`schedule.held`). The window is asked first, so
 * a queued occurrence that has waited past it is dropped too, rather than run
 * hours after it was meant for.
 *
 * Each is written once. A drop moves the schedule on under the same guard a
 * fire uses, so of two workers only one writes it, and the pass after finds
 * nothing due. A hold does not move the schedule -- every pass sees the same
 * occurrence until the run ends -- so the row remembers which run it waits
 * for, and the event is written only when that changes, as 0038 does for a
 * failure.
 */
async function giveWay(schedule: DueSchedule, key: string, now: Date): Promise<boolean> {
  const late = pastCatchUp(schedule, now);
  if (!late && schedule.overlap === 'allow') return false;

  return withTenant(schedule.company_id, async (tx) => {
    const occurrence = schedule.next_run_at;
    const live = late ? null : await liveTaskOf(tx, schedule.id, { except: key });
    if (!late && !live) return false;

    if (live && schedule.overlap === 'queue') {
      const { rowCount } = await tx.query(
        `UPDATE schedules SET held_by_task_id = $3
          WHERE id = $1 AND date_trunc('milliseconds', next_run_at) = $2
            AND held_by_task_id IS DISTINCT FROM $3`,
        [schedule.id, occurrence, live.id],
      );
      if (rowCount === 1) {
        await appendEvent(tx, {
          companyId: schedule.company_id,
          projectId: schedule.project_id,
          type: 'schedule.held',
          actor: 'scheduler',
          payload: {
            scheduleId: schedule.id,
            slug: schedule.slug,
            occurrence: occurrence.toISOString(),
            runningTaskId: live.id,
            runningStatus: live.status,
          },
        });
      }
      return true;
    }

    // Dropped: this occurrence and every one after it up to now.
    const next = nextOccurrence(schedule.cron_expression, schedule.timezone, now);
    const dropped = 1 + countOccurrences(schedule.cron_expression, schedule.timezone, occurrence, now);
    const { rowCount } = await tx.query(
      `UPDATE schedules
          SET next_run_at = $3, held_by_task_id = NULL,
              fire_failed_for = NULL, fire_failure = NULL,
              skipped_for = $2, skipped_because = $4, skipped_count = $5, skipped_task_id = $6
        WHERE id = $1 AND date_trunc('milliseconds', next_run_at) = $2`,
      [schedule.id, occurrence, next, late ? 'late' : 'overlap', dropped, live?.id ?? null],
    );
    if (rowCount === 1) {
      const said = {
        scheduleId: schedule.id,
        slug: schedule.slug,
        occurrence: occurrence.toISOString(),
        nextRunAt: next.toISOString(),
      };
      await appendEvent(tx, late
        ? {
          companyId: schedule.company_id,
          projectId: schedule.project_id,
          type: 'schedule.missed',
          actor: 'scheduler',
          payload: { ...said, droppedOccurrences: dropped, catchUpMinutes: schedule.catch_up_minutes },
        }
        : {
          companyId: schedule.company_id,
          projectId: schedule.project_id,
          type: 'schedule.skipped',
          actor: 'scheduler',
          payload: { ...said, skippedOccurrences: dropped, runningTaskId: live!.id, runningStatus: live!.status },
        });
    }
    return true;
  });
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
