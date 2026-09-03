/**
 * Dormancy, the wake queue and coalescing (PRD v2 F9.7–F9.10).
 *
 * Principle 13: dormant is the normal state. A role wakes because of a
 * schedule, an event or an assignment, and never because it is "waiting" --
 * waiting is what costs money for nothing. G8 puts a number on it: zero tokens
 * when there is no task.
 *
 * That number is F9.10 and it is the reason this module exists rather than a
 * loop that polls. **A wake is a reason to look, not a reason to run.** The
 * queue says a role is worth checking; if the check finds no claimable task,
 * the wake is consumed and nothing starts. v2 section 2.3 traces real surprise
 * bills to the opposite arrangement -- an eager heartbeat waking an agent with
 * nothing to do and vague instructions about what to do with nothing.
 *
 * **Coalescing keeps the absorbed entry (F9.9).** Four events arriving in a
 * minute produce one run, and the other three are marked as folded into it
 * rather than deleted. "The queue asked four times and we looked once" is a
 * fact about the system's rhythm that the owner may need, and a delete would
 * erase it.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { claimTask } from '../engine/checkout.ts';
import { createRootTask, type CreateTaskInput, type TaskRow } from '../engine/tasks.ts';

/** F9.9. Entries for one role inside this window become a single run. */
export const COALESCE_WINDOW_MS = 60_000;

export type WakeReason = 'heartbeat' | 'schedule' | 'event' | 'assignment';

export interface WakeEntry {
  id: string;
  roleId: string;
  reason: WakeReason;
  detail: string;
  priority: number;
  wakeAt: Date;
}

export interface EnqueueWake {
  companyId: string;
  roleId: string;
  reason: WakeReason;
  detail?: string;
  priority?: number;
  wakeAt?: Date;
}

export interface EnqueuedWake {
  /** The entry that will actually be looked at. */
  id: string;
  /** True when this call was folded into an entry that already existed. */
  coalesced: boolean;
}

/**
 * Puts a role on the queue, folding it into an open entry when one is close by.
 *
 * An assignment is deliberately exempt from folding. F9.8 says a direct
 * assignment overtakes the schedule, and folding one into a heartbeat that is
 * not due for another three hours would do the opposite of that.
 */
export async function enqueueWake(input: EnqueueWake): Promise<EnqueuedWake> {
  const wakeAt = input.wakeAt ?? new Date();

  return withTenant(input.companyId, async (tx) => {
    if (input.reason !== 'assignment') {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM wake_queue
          WHERE role_id = $1
            AND consumed_at IS NULL
            AND coalesced_into IS NULL
            AND abs(extract(epoch FROM (wake_at - $2::timestamptz))) * 1000 <= $3
          ORDER BY wake_at
          LIMIT 1`,
        [input.roleId, wakeAt, COALESCE_WINDOW_MS],
      );

      const existing = rows[0]?.id;
      if (existing) {
        const { rows: folded } = await tx.query<{ id: string }>(
          `INSERT INTO wake_queue
             (company_id, role_id, reason, detail, priority, wake_at, coalesced_into)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            input.companyId,
            input.roleId,
            input.reason,
            input.detail ?? '',
            input.priority ?? 2,
            wakeAt,
            existing,
          ],
        );
        await appendEvent(tx, {
          companyId: input.companyId,
          type: 'wake.coalesced',
          actor: 'system',
          payload: {
            roleId: input.roleId,
            reason: input.reason,
            into: existing,
            entry: folded[0]!.id,
          },
        });
        return { id: existing, coalesced: true };
      }
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO wake_queue (company_id, role_id, reason, detail, priority, wake_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        input.companyId,
        input.roleId,
        input.reason,
        input.detail ?? '',
        // An assignment is the owner asking directly, so it outranks a
        // schedule that happens to be due at the same moment.
        input.priority ?? (input.reason === 'assignment' ? 0 : 2),
        wakeAt,
      ],
    );
    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'wake.queued',
      actor: input.reason === 'assignment' ? 'owner' : 'system',
      payload: { roleId: input.roleId, reason: input.reason, wakeAt: wakeAt.toISOString() },
    });
    return { id: rows[0]!.id, coalesced: false };
  });
}

/** Entries that are due and have not been folded into another. */
export async function dueWakes(companyId: string, now = new Date()): Promise<WakeEntry[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      role_id: string;
      reason: WakeReason;
      detail: string;
      priority: number;
      wake_at: Date;
    }>(
      `SELECT id, role_id, reason, detail, priority, wake_at
         FROM wake_queue
        WHERE consumed_at IS NULL AND coalesced_into IS NULL AND wake_at <= $1
        ORDER BY priority, wake_at`,
      [now],
    );
    return rows.map((row) => ({
      id: row.id,
      roleId: row.role_id,
      reason: row.reason,
      detail: row.detail,
      priority: row.priority,
      wakeAt: row.wake_at,
    }));
  });
}

export async function consumeWake(
  tx: TenantClient,
  wakeId: string,
  now = new Date(),
): Promise<void> {
  await tx.query('UPDATE wake_queue SET consumed_at = $2 WHERE id = $1', [wakeId, now]);
}

/** How many entries were folded into this one. */
export async function coalescedCount(companyId: string, wakeId: string): Promise<number> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM wake_queue WHERE coalesced_into = $1',
      [wakeId],
    );
    return Number(rows[0]!.count);
  });
}

/**
 * Queues the roles whose heartbeat is due, and puts them back to sleep (F9.7).
 *
 * Dormancy is advanced when the wake is queued rather than when it is
 * consumed, so a role whose queue entry is never processed still does not
 * accumulate a backlog of heartbeats. The same reasoning as the scheduler's
 * catch-up collapse: a day of downtime should not become a day of work in a
 * minute.
 */
export async function scheduleHeartbeats(
  companyId: string,
  now = new Date(),
): Promise<string[]> {
  const due = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; heartbeat_minutes: number }>(
      `SELECT id, heartbeat_minutes FROM roles
        WHERE frozen_at IS NULL
          AND (dormant_until IS NULL OR dormant_until <= $1)`,
      [now],
    );
    return rows;
  });

  const woken: string[] = [];
  for (const role of due) {
    await enqueueWake({ companyId, roleId: role.id, reason: 'heartbeat', wakeAt: now });
    await withTenant(companyId, async (tx) => {
      await tx.query(
        // Cast explicitly: an uncast parameter beside an interval makes
        // PostgreSQL read it as an interval too, and the column is a timestamp.
        `UPDATE roles
            SET dormant_until = $2::timestamptz + make_interval(mins => heartbeat_minutes)
          WHERE id = $1`,
        [role.id, now],
      );
    });
    woken.push(role.id);
  }
  return woken;
}

export interface WakeOutcome {
  wakeId: string;
  roleId: string;
  reason: WakeReason;
  /** The task that was claimed, or null when there was nothing to do. */
  taskId: string | null;
}

/**
 * Turns due wakes into claimed tasks, and does nothing when there is nothing.
 *
 * F9.10 in one function. A wake with no claimable task is consumed, recorded
 * as idle, and costs nothing -- no context is assembled, no model is called,
 * no run row is written. That is the difference between an agent that is
 * dormant and one that is merely quiet.
 */
export async function drainWakes(
  companyId: string,
  options: { holder: string; now?: Date },
): Promise<WakeOutcome[]> {
  const now = options.now ?? new Date();
  const entries = await dueWakes(companyId, now);
  const outcomes: WakeOutcome[] = [];

  for (const entry of entries) {
    const claim = await claimTask(companyId, {
      holder: options.holder,
      roleId: entry.roleId,
      now,
    });

    await withTenant(companyId, async (tx) => {
      await consumeWake(tx, entry.id, now);
      if (!claim) {
        await appendEvent(tx, {
          companyId,
          type: 'wake.idle',
          actor: 'system',
          payload: { roleId: entry.roleId, reason: entry.reason, wakeId: entry.id },
        });
      }
    });

    outcomes.push({
      wakeId: entry.id,
      roleId: entry.roleId,
      reason: entry.reason,
      taskId: claim?.taskId ?? null,
    });
  }

  return outcomes;
}

/**
 * The owner handing a role a task directly (F10.11).
 *
 * Two things beyond creating the task. The wake is queued as an assignment,
 * which is exempt from coalescing and outranks a schedule, so it is not folded
 * into a heartbeat that is not due for another three hours. And the role's
 * dormancy is cleared, because the owner asking for something now and the
 * system answering in four hours is the behaviour F9.8's "penugasan langsung
 * melewati jadwal" exists to rule out.
 */
export async function assignTask(
  input: CreateTaskInput & { detail?: string },
): Promise<{ task: TaskRow; wakeId: string }> {
  const task = await createRootTask({ ...input, createdBy: 'owner' });

  await withTenant(input.companyId, async (tx) => {
    await tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [input.roleId]);
  });

  const wake = await enqueueWake({
    companyId: input.companyId,
    roleId: input.roleId,
    reason: 'assignment',
    detail: input.detail ?? `owner assigned task ${task.id}`,
  });

  return { task, wakeId: wake.id };
}
