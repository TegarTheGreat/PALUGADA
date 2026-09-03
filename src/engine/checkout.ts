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
import { withTenant, type TenantClient } from '../db/tenant.ts';

/** F5.12. Long enough for a slow run, short enough that a crash is not a day. */
export const DEFAULT_LEASE_MS = 15 * 60_000;

/** F5.14. Two missed lease-lengths is a worker that is not coming back. */
export const ORPHAN_MULTIPLE = 2;

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
    SELECT t.id
      FROM tasks t
     WHERE t.status = 'pending'
       AND ($2::uuid IS NULL OR t.id = $2)
       AND ($5::uuid IS NULL OR t.role_id = $5)
       AND (t.wait_until IS NULL OR t.wait_until <= $3)
       AND (t.deadline_at IS NULL OR t.deadline_at > $3)
       AND (t.lane_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM tasks busy
              WHERE busy.lane_key = t.lane_key
                AND busy.id <> t.id
                AND busy.status IN ('checked_out', 'running')))
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
  UPDATE tasks
     SET status = 'checked_out', lease_holder = $1, lease_expires_at = $4
   WHERE id IN (SELECT id FROM candidate)
  RETURNING id, lease_expires_at`;

export async function claimTask(
  companyId: string,
  options: ClaimOptions,
): Promise<Claim | null> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS));

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

    const { rows } = await tx.query<{ id: string; lease_expires_at: Date }>(CLAIM_SQL, [
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
      payload: { holder: options.holder, leaseExpiresAt: row.lease_expires_at.toISOString() },
    });
    return { taskId: row.id, leaseExpiresAt: row.lease_expires_at };
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
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS));

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
    }>(
      `WITH expired AS (
         SELECT id, lease_holder, status
           FROM tasks
          WHERE lease_expires_at IS NOT NULL
            AND lease_expires_at <= $1
            AND status IN ('checked_out', 'running')
          FOR UPDATE
       ), reclaimed AS (
         UPDATE tasks
            SET status = 'pending', lease_holder = NULL, lease_expires_at = NULL
          WHERE id IN (SELECT id FROM expired)
       )
       SELECT id, lease_holder, status AS previous_status FROM expired`,
      [now],
    );

    for (const row of rows) {
      await appendEvent(tx, {
        companyId,
        taskId: row.id,
        type: 'task.lease_expired',
        actor: 'system',
        payload: { holder: row.lease_holder, reclaimedFrom: row.previous_status },
      });
    }

    return rows.map((row) => ({
      taskId: row.id,
      previousHolder: row.lease_holder,
      previousStatus: row.previous_status,
    }));
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
      `UPDATE agent_runs
          SET status = 'orphaned', finished_at = $1
        WHERE status = 'running'
          AND coalesce(last_heartbeat_at, started_at) < $2
        RETURNING id, task_id, tokens_used`,
      [now, staleBefore],
    );

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
    }

    return rows.map((row) => ({
      agentRunId: row.id,
      taskId: row.task_id,
      tokensUsed: Number(row.tokens_used),
    }));
  });
}
