/**
 * Atomic checkout, leases, lanes and orphan recovery (PRD v2 F5.11–F5.14).
 *
 * One statement claims a task. Selecting it, checking it can still be funded,
 * checking its lane is free and writing the lease all happen inside a single
 * `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, which is what
 * makes F5.11's guarantee structural rather than hopeful: two workers cannot
 * both hold a task because the row is locked between the select and the write,
 * and `SKIP LOCKED` means the loser takes the next task instead of waiting for
 * a row it is not going to get.
 *
 * Four things this is built around.
 *
 * **`checked_out` is a real state, not bookkeeping.** It is the difference
 * between "nobody has this" and "a worker claimed it and has not started yet".
 * A crash in that gap looks identical to a task nobody picked up unless the
 * two are distinguishable, and they need different recovery.
 *
 * **A lease expires rather than being released.** A worker that dies releases
 * nothing, so the only reclamation that works is one the dead worker is not
 * involved in. The lease is therefore a deadline the database holds, and
 * reclaiming is a sweep rather than a callback.
 *
 * **Reclaiming keeps the journal.** F5.12 is explicit: the task returns to
 * `pending` with its working memory intact. The committed steps are what makes
 * the retry cheap, and throwing them away would turn a lost worker into lost
 * work, which is G1's whole subject.
 *
 * **A lane is opt-in.** Most tasks touch nothing shared and serialising them
 * would cost throughput for nothing. A lane key is the exception you declare
 * for a repository, a domain or an account -- somewhere two concurrent tasks
 * would interleave into a state neither intended.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { transition, transitionWithin } from './tasks.ts';
import { isPalugadaError } from '../errors.ts';
import { raiseIncidentWithin } from '../inbox/inbox.ts';

/** F5.12. Long enough for a slow run, short enough that a crash is not a day. */
export const DEFAULT_LEASE_MS = 15 * 60_000;

/** F5.14. Two missed lease-lengths is a worker that is not coming back. */
export const ORPHAN_MULTIPLE = 2;

/** How often a worker says it is alive (0079). */
export const HEARTBEAT_EVERY_MS = 15_000;

/**
 * How long a worker may be quiet before its tasks are returned: four missed
 * beats. Short beside a lease, long beside a garbage-collection pause or a
 * slow statement, and measured on the database's clock at both ends, so two
 * machines that disagree about the time cannot make a live worker look dead.
 */
export const SILENT_AFTER_SECONDS = 60;

export interface Claim {
  taskId: string;
  leaseExpiresAt: Date;
}

export interface ClaimOptions {
  /** Who is holding it. A worker identity, opaque to the database. */
  holder: string;
  /** Claim this task specifically, rather than whatever is next in line. */
  taskId?: string | undefined;
  /** Only consider work for this role (F9.8: a wake names one role). */
  roleId?: string | undefined;
  leaseMs?: number | undefined;
  now?: Date | undefined;
}

/**
 * The claim, as one statement.
 *
 * The funding check is on tokens rather than money on purpose. Tokens are what
 * admission reserves and what a run consumes, so "can this still be paid for"
 * is a question about tokens; money is guarded where it is actually spent, by
 * `budget_spend` and by the period pause, and duplicating that here would mean
 * two answers to the same question that can disagree.
 *
 * It counts what is already in flight, which is what makes F5.11's acceptance
 * criterion hold: five claimable tasks against an account with room for three
 * produce three checkouts, because the fourth claim sees three reservations
 * already held and no headroom left for its own. A check that looked only at
 * the account's spend would pass all five, and the shortfall would surface
 * mid-run as a halt on a task that should never have started.
 */
const CLAIM_SQL = `
  WITH candidate AS (
    SELECT t.id, t.status AS was
      FROM tasks t
     -- F9.6. A task parked for cheap hours is claimable the moment they
     -- arrive, and the wait_until test below is what says whether they have.
     --
     -- It used to read status = 'pending' alone, and nothing else in the
     -- platform ever moved a task out of waiting_window: the engine parked it,
     -- the claim could not see it, and there it stayed. Every batchable task --
     -- which is most non-urgent work -- was deferred to a window it would
     -- never be woken for. The index this query wants,
     -- tasks_waiting_window_ready, had been created for the drain and never
     -- used by anything.
     --
     -- Widened here rather than drained by a second query on purpose: this one
     -- already holds the lane check, the budget check, the priority order and
     -- FOR UPDATE SKIP LOCKED. A separate path would have been a second,
     -- weaker claim, and the weaker one is the one that eventually runs two
     -- workers on one task.
     -- A parked task with no wake-up time is *not* claimable. The engine
     -- parks one that way when the window it is waiting for never opens
     -- (engine.ts, window.closed with no reopensAt), and without this it
     -- would be claimed, run, re-parked and claimed again -- a hot loop paying
     -- for a full agent run each time round, with madeProgress suppressing
     -- the sleep because runs kept happening. A pending task with no
     -- wait_until is the ordinary case and stays claimable.
     --
     -- And a running task nobody holds: one the owner has just approved,
     -- answered or had reviewed. A parked task gives up its lease (engine.ts),
     -- and the owner's decision moves it to running without a worker, so a
     -- claim that did not look here left every approved task running for
     -- good -- the action never happened, and the task went on counting
     -- against its division and its budget.
     WHERE (t.status = 'pending'
            OR (t.status = 'waiting_window' AND t.wait_until IS NOT NULL)
            OR (t.status = 'running' AND t.lease_holder IS NULL))
       AND ($2::uuid IS NULL OR t.id = $2)
       AND ($5::uuid IS NULL OR t.role_id = $5)
       AND (t.wait_until IS NULL OR t.wait_until <= $3)
       AND (t.deadline_at IS NULL OR t.deadline_at > $3)
       AND (t.lane_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM tasks busy
              WHERE busy.lane_key = t.lane_key
                AND busy.id <> t.id
                AND busy.status IN ('checked_out', 'running')))
       -- F5.7: no more of a division's tasks at once than its limit. The
       -- limit was stored, shown and changed by the owner, and read by no
       -- claim, so a division set to one ran as many as there were workers.
       -- Exact under the company's claim lock above, like the lane.
       --
       -- Except a child its own running parent is driving: that is the
       -- parent's run going on, in the place the parent already holds, and a
       -- division full with the parent would otherwise leave the parent
       -- waiting on a child nothing could start until its deadline.
       AND ((SELECT count(*) FROM tasks busy
              WHERE busy.division_id = t.division_id
                AND busy.id <> t.id
                AND busy.status IN ('checked_out', 'running'))
            < (SELECT d.max_concurrency FROM divisions d WHERE d.id = t.division_id)
            OR ($2::uuid IS NOT NULL AND EXISTS (
              SELECT 1 FROM tasks parent
               WHERE parent.id = t.parent_task_id
                 AND parent.lease_holder = $1
                 AND parent.status IN ('checked_out', 'running'))))
       AND (SELECT b.tokens_max - b.tokens_spent
              FROM budget_accounts b WHERE b.id = t.budget_account_id)
           >= t.tokens_reserved
              + coalesce((SELECT sum(busy.tokens_reserved) FROM tasks busy
                           WHERE busy.budget_account_id = t.budget_account_id
                             AND busy.id <> t.id
                             AND busy.status IN ('checked_out', 'running')), 0)
     -- F5.10: priority first, then age. Age is the tie-break rather than the
     -- whole order, so a queue full of P2 work still drains oldest-first and a
     -- P0 incident does not wait behind it.
     ORDER BY t.priority, t.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  -- A resumed task stays running: its journal is intact and the run picks
  -- up after the step that parked it.
  UPDATE tasks
     SET status = CASE WHEN tasks.status = 'running' THEN 'running' ELSE 'checked_out' END,
         lease_holder = $1, lease_expires_at = $4
    FROM candidate
   WHERE tasks.id = candidate.id
  RETURNING tasks.id, tasks.lease_expires_at, candidate.was`;

export async function claimTask(
  companyId: string,
  options: ClaimOptions,
): Promise<Claim | null> {
  const now = options.now ?? new Date();
  const expiresAt = leaseUntil(now, options.leaseMs);

  return withTenant(companyId, async (tx) => {
    // Claims within a company are serialised, and this is load-bearing rather
    // than cautious. `FOR UPDATE SKIP LOCKED` locks the row being claimed; it
    // says nothing about the two predicates that look at *other* rows -- is
    // this lane busy, and is there budget left once the work already in flight
    // is counted. Under READ COMMITTED two concurrent claims cannot see each
    // other's uncommitted checkout, so without this both would pass a check
    // that only one of them should, and five tasks would be claimed against an
    // account with room for three.
    //
    // A lock per company rather than per account and lane: it is one lock
    // instead of two taken in an order that would have to be agreed, and at
    // the scale section 9 states -- ten companies, five thousand tasks a day
    // -- claims within one company do not queue behind each other for long
    // enough to measure. Finer locks are the change to make if that stops
    // being true.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companyId]);

    const { rows } = await tx.query<{ id: string; lease_expires_at: Date; was: string }>(CLAIM_SQL, [
      options.holder,
      options.taskId ?? null,
      now,
      expiresAt,
      options.roleId ?? null,
    ]);
    const row = rows[0];
    if (!row) return null;

    await appendEvent(tx, {
      companyId,
      taskId: row.id,
      type: 'task.checked_out',
      actor: 'system',
      payload: {
        holder: options.holder,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
        ...(row.was === 'running' ? { resumed: true } : {}),
      },
    });
    return { taskId: row.id, leaseExpiresAt: row.lease_expires_at };
  });
}

/**
 * When a lease taken at `now` runs out.
 *
 * From the later of the caller's clock and the wall clock. A worker tick reads
 * the time once, at its start, and hands it to every claim it makes; after
 * the tick has run eight tasks of two minutes each, a claim at "now" is a
 * claim sixteen minutes ago, and a fifteen-minute lease taken then was over
 * before the task started -- another replica reclaimed it while this one was
 * running it. The caller's clock still wins when it is ahead, which is how a
 * test asks about the future.
 */
export function leaseUntil(now: Date | undefined, leaseMs = DEFAULT_LEASE_MS): Date {
  return new Date(Math.max(now?.getTime() ?? 0, Date.now()) + leaseMs);
}

/**
 * Takes the lease on a task that is already past `pending`.
 *
 * A task this worker claimed is `checked_out` under its own lease; a task
 * resumed after an approval, a review or a window is `running` or waiting
 * under whichever lease it had when it parked, usually long expired. Either
 * way the run may start only once this worker holds it, and "holds" is
 * decided by one conditional write rather than by a read and a comparison:
 * the lease is free, already this worker's, or expired. Two workers resuming
 * the same task both reach this statement, and the row lock lets exactly one
 * of them through.
 *
 * Null when the task is somebody else's, or has ended.
 */
export async function adoptLease(
  companyId: string,
  taskId: string,
  holder: string,
  options: { leaseMs?: number } = {},
): Promise<Date | null> {
  const now = new Date();
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ lease_expires_at: Date }>(
      `UPDATE tasks SET lease_holder = $2, lease_expires_at = $3
        WHERE id = $1
          AND status IN ('checked_out', 'running', 'waiting_approval', 'waiting_review', 'waiting_window')
          AND (lease_holder IS NULL OR lease_holder = $2
               OR lease_expires_at IS NULL OR lease_expires_at <= $4)
        RETURNING lease_expires_at`,
      [taskId, holder, leaseUntil(now, options.leaseMs), now],
    );
    return rows[0]?.lease_expires_at ?? null;
  });
}

/**
 * Pushes a lease out, for a worker that is still alive and still working.
 *
 * Only the holder may renew. A renewal from anyone else would let a worker
 * that has already lost the task extend a claim it no longer has, which is the
 * one way two workers end up believing they hold the same thing.
 */
export async function renewLease(
  companyId: string,
  taskId: string,
  holder: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<Date | null> {
  const expiresAt = leaseUntil(options.now, options.leaseMs);

  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ lease_expires_at: Date }>(
      `UPDATE tasks SET lease_expires_at = $3
        WHERE id = $1 AND lease_holder = $2
          AND status IN ('checked_out', 'running')
        RETURNING lease_expires_at`,
      [taskId, holder, expiresAt],
    );
    return rows[0]?.lease_expires_at ?? null;
  });
}

/** Hands a task back deliberately, for a worker that is stopping cleanly. */
export async function releaseTask(
  companyId: string,
  taskId: string,
  holder: string,
): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE tasks
          SET status = 'pending', lease_holder = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_holder = $2 AND status = 'checked_out'`,
      [taskId, holder],
    );
    return rowCount === 1;
  });
}

/**
 * Drops this worker's lease without changing the task's status.
 *
 * Distinct from `releaseTask`, which gives back a claim that was taken and
 * never started and therefore insists the task is still `checked_out`. This is
 * for a task that *was* started and is going back on the queue after a
 * retryable failure: the status move is the caller's, and what is left is the
 * lease. Keyed on the holder, so a worker cannot drop a lease it does not own.
 *
 * Leaving the lease behind would not stop the retry — `claimTask` looks at the
 * status, not the holder — but it would leave a task on the queue that appears
 * to belong to somebody, which is exactly the confusion leases exist to remove.
 */
export async function clearLease(
  companyId: string,
  taskId: string,
  holder: string,
): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE tasks SET lease_holder = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_holder = $2`,
      [taskId, holder],
    );
    return rowCount === 1;
  });
}

/**
 * How many times a task may lose its worker before it stops being put back.
 *
 * A lease that runs out, or a run that stops reporting, is a worker that
 * died. Putting the task back with its journal is right the first time and
 * the second. A task whose work is what kills the worker -- a handler that
 * exhausts memory, a CLI that takes the process with it -- went back for
 * ever, taking a worker down each time, and nothing counted.
 */
export const MAX_RECLAIMS = 3;

/**
 * Halts a task that has lost its worker `MAX_RECLAIMS` times, and tells the
 * owner, in the transaction that took it back. True when it was halted.
 */
async function haltIfCrashLooping(tx: TenantClient, companyId: string, taskId: string): Promise<boolean> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events
      WHERE task_id = $1 AND type IN ('task.lease_expired', 'agent_run.orphaned')`,
    [taskId],
  );
  const lost = rows[0]?.n ?? 0;
  if (lost < MAX_RECLAIMS) return false;
  const { rows: live } = await tx.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
  if (live[0]?.status !== 'pending') return false;
  await transitionWithin(tx, companyId, taskId, 'halted', { haltReason: 'crash_loop' });
  await raiseIncidentWithin(tx, {
    companyId,
    taskId,
    title: 'A task keeps stopping the worker running it',
    detail:
      `Task ${taskId} lost its worker ${lost} times: each time the worker running it stopped ` +
      'answering before the work finished. What it had done is kept. It is halted so it cannot take ' +
      'another worker down; rerun it once the cause is found, or cancel it.',
  });
  return true;
}

/**
 * A worker's word that it is alive (0079). Written on the control plane:
 * the table is the platform's, and no agent has any business with it.
 */
export async function beat(workerId: string): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `INSERT INTO worker_heartbeats (worker_id) VALUES ($1)
     ON CONFLICT (worker_id) DO UPDATE SET beat_at = now()`,
    [workerId],
  ));
}

/**
 * Takes a worker's word back as it stops cleanly, so a worker that shut down
 * is never mistaken for one that died -- its tasks were handed back already.
 */
export async function stopBeating(workerId: string): Promise<void> {
  await withControlPlane((tx) => tx.query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [workerId]));
}

/**
 * The workers that have gone quiet, other than the one asking: it is alive,
 * whatever its last beat says -- after the database was away, its own beat
 * is as old as everyone's, and taking back its own running tasks would stop
 * work that is going on. Rows quiet for a day are cleared as they are read.
 */
export async function silentHolders(self: string): Promise<string[]> {
  return withControlPlane(async (tx) => {
    await tx.query("DELETE FROM worker_heartbeats WHERE beat_at < now() - interval '1 day'");
    const { rows } = await tx.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_heartbeats
        WHERE worker_id <> $1 AND beat_at < now() - make_interval(secs => $2)
        ORDER BY worker_id`,
      [self, SILENT_AFTER_SECONDS],
    );
    return rows.map((row) => row.worker_id);
  });
}

export interface Reclaimed {
  taskId: string;
  previousHolder: string;
  previousStatus: string;
}

/**
 * Returns tasks whose lease has run out (F5.12).
 *
 * The journal is untouched, so the next worker resumes from the last committed
 * step rather than starting again. Only `checked_out` and `running` tasks are
 * reclaimed: a task that reached a terminal state before its lease expired is
 * finished, and the stale lease on it is litter rather than a claim.
 */
export async function reclaimExpiredLeases(
  companyId: string,
  now = new Date(),
  options: {
    /**
     * Holders that have stopped saying they are alive (`silentHolders`):
     * their tasks come back now rather than when their leases run out.
     */
    silent?: readonly string[];
  } = {},
): Promise<Reclaimed[]> {
  return withTenant(companyId, async (tx) => {
    // Read the rows before the update, not after. `RETURNING` on an UPDATE
    // reports the new row, so asking it for `lease_holder` would hand back the
    // NULL this statement just wrote -- the answer to "who lost it" would be
    // "nobody", every time.
    const { rows } = await tx.query<{
      id: string;
      lease_holder: string;
      previous_status: string;
      silent: boolean;
    }>(
      `WITH expired AS (
         SELECT id, lease_holder, status, NOT (lease_expires_at <= $1) AS silent
           FROM tasks
          WHERE lease_expires_at IS NOT NULL
            AND (lease_expires_at <= $1 OR lease_holder = ANY($2::text[]))
            AND status IN ('checked_out', 'running')
          -- Locked in id order, the order the stop button and the expiry
          -- sweep lock tasks in, so two sweeps over overlapping sets wait for
          -- each other rather than deadlock.
          ORDER BY id
          FOR UPDATE
       ), reclaimed AS (
         UPDATE tasks
            SET status = 'pending', lease_holder = NULL, lease_expires_at = NULL
          WHERE id IN (SELECT id FROM expired)
       )
       SELECT id, lease_holder, status AS previous_status, silent FROM expired`,
      [now, options.silent ?? []],
    );

    for (const row of rows) {
      await appendEvent(tx, {
        companyId,
        taskId: row.id,
        type: 'task.lease_expired',
        actor: 'system',
        payload: {
          holder: row.lease_holder, reclaimedFrom: row.previous_status,
          // Which clock ran out: the lease's, or the holder's word that it was alive.
          reason: row.silent ? 'holder_silent' : 'lease_expired',
        },
      });
      await haltIfCrashLooping(tx, companyId, row.id);
    }

    return rows.map((row) => ({
      taskId: row.id,
      previousHolder: row.lease_holder,
      previousStatus: row.previous_status,
    }));
  });
}

/**
 * Halts work whose deadline has passed while nobody was running it (F5.6).
 *
 * The claim skips a task past its deadline, and the deadline was otherwise
 * checked only when a run started or took a step -- so a task that missed it
 * while queued, or parked for a window, was never claimed and never halted:
 * live for ever, holding its reservation, and a parent awaiting it asked
 * again every second. A running task with a live lease is left to its run,
 * which checks the deadline before every step.
 */
export async function haltPastDeadlines(companyId: string, now = new Date()): Promise<string[]> {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE deadline_at IS NOT NULL AND deadline_at <= $1
        AND (status IN ('pending', 'waiting_window')
             OR (status IN ('checked_out', 'running') AND lease_holder IS NULL))
      ORDER BY deadline_at, id`,
    [now]));
  const halted: string[] = [];
  for (const row of rows) {
    try {
      await transition(companyId, row.id, 'halted', {
        haltReason: 'deadline_passed',
        detail: 'its deadline passed before any worker could finish it',
      });
      halted.push(row.id);
    } catch (error) {
      // Moved on while this ran -- claimed, finished, stopped. Its new state
      // is the answer; anything else is a real failure.
      if (!isPalugadaError(error, 'task.invalid_transition')) throw error;
    }
  }
  return halted;
}

/**
 * A worker handing back a task whose run went quiet, before its lease lapses.
 *
 * What the sweep would have done a moment later, done by the holder so no
 * second worker runs the task beside the first: back to the queue with its
 * journal, no attempt charged -- the work did not fail, it stopped moving --
 * and counted as a lost worker, so a task that goes quiet every time is
 * halted like one that crashes every time. False when the lease was no
 * longer this worker's to hand back.
 */
export async function giveBack(companyId: string, taskId: string, holder: string, why: string): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      `WITH held AS (
         SELECT id, status FROM tasks
          WHERE id = $1 AND lease_holder = $2 AND status IN ('checked_out', 'running')
          FOR UPDATE
       ), released AS (
         UPDATE tasks SET status = 'pending', lease_holder = NULL, lease_expires_at = NULL
          WHERE id IN (SELECT id FROM held)
       )
       SELECT status FROM held`,
      [taskId, holder],
    );
    if (rows.length === 0) return false;
    await appendEvent(tx, {
      companyId,
      taskId,
      type: 'task.lease_expired',
      actor: 'system',
      payload: { holder, reclaimedFrom: rows[0]!.status, quiet: why },
    });
    await haltIfCrashLooping(tx, companyId, taskId);
    return true;
  });
}

/**
 * A worker that is being stopped handing back what it was running.
 *
 * A deployment is restarted to upgrade it. A run still going when the process
 * was told to stop used to be cut off by the supervisor's kill a minute later,
 * its lease lapsed, and the reclaim counted as a lost worker: three upgrades
 * during one long task halted it as `crash_loop`. Handed back instead, it is
 * back on the queue at once, resumes at the step it reached, is charged no
 * attempt, and is not counted against it -- nothing crashed.
 */
export async function handBack(companyId: string, taskId: string, holder: string, why: string): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      `WITH held AS (
         SELECT id, status FROM tasks
          WHERE id = $1 AND lease_holder = $2 AND status IN ('checked_out', 'running')
          FOR UPDATE
       ), released AS (
         UPDATE tasks SET status = 'pending', lease_holder = NULL, lease_expires_at = NULL
          WHERE id IN (SELECT id FROM held)
       )
       SELECT status FROM held`,
      [taskId, holder],
    );
    if (rows.length === 0) return false;
    await appendEvent(tx, {
      companyId,
      taskId,
      type: 'task.handed_back',
      actor: 'system',
      payload: { holder, from: rows[0]!.status, why },
    });
    return true;
  });
}

/** A worker saying it is still there (F5.12, F5.14). */
export async function recordRunHeartbeat(
  tx: TenantClient,
  agentRunId: string,
  now = new Date(),
): Promise<void> {
  await tx.query('UPDATE agent_runs SET last_heartbeat_at = $2 WHERE id = $1', [agentRunId, now]);
}

export interface Orphan {
  agentRunId: string;
  taskId: string;
  tokensUsed: number;
}

/**
 * Finds runs that stopped reporting and gives their tasks back (F5.14).
 *
 * The cost is recorded before the task is returned, and that ordering is the
 * point: an orphaned run spent real tokens, and a retry that does not carry
 * the abandoned spend forward would let a crash loop cost the company an
 * unbounded amount while every individual attempt looked affordable.
 */
export async function reclaimOrphans(
  companyId: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<Orphan[]> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - ORPHAN_MULTIPLE * (options.leaseMs ?? DEFAULT_LEASE_MS));

  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      task_id: string;
      tokens_used: string;
    }>(
      // Not while the task's lease is live. The lease is the claim, and the
      // worker holding it is renewing it; a run whose heartbeat looks old
      // under a lease that does not is a run doing one long thing, not a dead
      // one, and taking its task back would put a second worker on it.
      `UPDATE agent_runs run
          SET status = 'orphaned', finished_at = $1
        WHERE run.status = 'running'
          AND coalesce(run.last_heartbeat_at, run.started_at) < $2
          AND NOT EXISTS (
                SELECT 1 FROM tasks task
                 WHERE task.id = run.task_id AND task.lease_expires_at > $1)
        RETURNING run.id, run.task_id, run.tokens_used`,
      [now, staleBefore],
    );
    // Tasks are locked in id order, as everywhere else that locks several.
    rows.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));

    for (const row of rows) {
      await appendEvent(tx, {
        companyId,
        taskId: row.task_id,
        type: 'agent_run.orphaned',
        actor: 'system',
        payload: { agentRunId: row.id, tokensUsed: Number(row.tokens_used) },
      });

      // Back to pending with the journal intact, like an expired lease. The
      // run is gone; the work it committed is not.
      await tx.query(
        `UPDATE tasks
            SET status = 'pending', lease_holder = NULL, lease_expires_at = NULL
          WHERE id = $1 AND status IN ('checked_out', 'running')`,
        [row.task_id],
      );
      await haltIfCrashLooping(tx, companyId, row.task_id);
    }

    return rows.map((row) => ({
      agentRunId: row.id,
      taskId: row.task_id,
      tokensUsed: Number(row.tokens_used),
    }));
  });
}
