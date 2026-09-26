/**
 * Every live task has something that will move it (PRD v2 F5.12, F10.1).
 *
 * A task that is not finished is waiting for *something*: a worker (it is
 * `pending`, or its lease will expire and return it), the owner (an approval
 * or an escalation is open in the inbox), a reviewer (a review request is
 * pending), or the clock (it is parked until `wait_until`). Paperclip states
 * this as a contract -- every non-terminal task has a typed "next mover" --
 * and keeps a sweep that finds the ones that do not, because each way of
 * losing the mover is a separate bug and the sweep catches all of them,
 * including the ones not written yet (`doc/execution-semantics.md` §8-9).
 *
 * This repository had three such bugs in a single afternoon: an approval
 * decided in one transaction and its task moved in another, so a crash left
 * a task in `waiting_approval` with nothing open to answer; a task parked on
 * a window that never reopens, with `wait_until` NULL, which a test asserts
 * "stays parked however long anyone waits" and nothing ever tells the owner
 * about; and an approval withdrawn from under a task that did not end. The
 * first two are fixed at the source. This is the net under all of them.
 *
 * **It asks, it does not repair.** Each stranded shape has more than one
 * right answer -- run the task again, or cancel it -- and the wrong one is an
 * action nobody chose. So the owner gets one escalation per task and shape,
 * saying what is missing and since when, and the answer *is* the repair:
 * `decide` already moves an escalation's task to `running` on approve and to
 * `cancelled` on deny, and every one of these statuses has both edges. That is
 * Paperclip's rule too -- a stranded task is never silently reassigned -- with
 * the owner's recovery action being the inbox item itself rather than a
 * second table.
 *
 * An escalation rather than an incident, because nothing is on fire: work is
 * blocked pending a judgement, which is what F10.5 says waits for the owner's
 * window instead of ringing their phone. And an open escalation is a mover in
 * its own right, so a task that has one is not reported again.
 */
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import * as inbox from '../inbox/inbox.ts';

export type StrandedShape =
  /** In `waiting_approval` with no approval or escalation open for it. */
  | 'approval_missing'
  /** In `waiting_review` with no pending review and no open escalation. */
  | 'review_missing'
  /** In `waiting_window` with no time to wake at. */
  | 'wake_missing';

export interface StrandedTask {
  taskId: string;
  projectId: string;
  status: string;
  shape: StrandedShape;
  since: Date;
}

/**
 * How long a task must have been in its status before it counts.
 *
 * A minute: every writer that parks a task now creates its mover in the same
 * transaction, so there is no legitimate window at all -- this is margin for
 * a clock, not for a race.
 */
export const STRANDED_AFTER_MS = 60_000;

export async function findStranded(companyId: string, now = new Date()): Promise<StrandedTask[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; project_id: string; status: string; shape: StrandedShape; since: Date;
    }>(
      `WITH live AS (
         SELECT t.id, t.project_id, t.status, t.wait_until,
                coalesce((SELECT max(e.occurred_at) FROM events e
                           WHERE e.task_id = t.id AND e.type = 'task.' || t.status),
                         t.created_at) AS since
           FROM tasks t
          WHERE t.status IN ('waiting_approval', 'waiting_review', 'waiting_window')
       )
       SELECT l.id, l.project_id, l.status, l.since,
              CASE l.status
                WHEN 'waiting_approval' THEN 'approval_missing'
                WHEN 'waiting_review' THEN 'review_missing'
                ELSE 'wake_missing'
              END AS shape
         FROM live l
        WHERE l.since <= $1::timestamptz - make_interval(secs => $2)
          AND CASE l.status
                WHEN 'waiting_approval' THEN NOT EXISTS (
                  SELECT 1 FROM inbox_items i
                   WHERE i.task_id = l.id AND i.status = 'open'
                     AND i.kind IN ('approval', 'escalation'))
                WHEN 'waiting_review' THEN NOT EXISTS (
                  SELECT 1 FROM review_requests r
                   WHERE r.proposer_task_id = l.id AND r.status = 'pending')
                  AND NOT EXISTS (
                  SELECT 1 FROM inbox_items i
                   WHERE i.task_id = l.id AND i.status = 'open' AND i.kind = 'escalation')
                ELSE l.wait_until IS NULL AND NOT EXISTS (
                  SELECT 1 FROM inbox_items i
                   WHERE i.task_id = l.id AND i.status = 'open' AND i.kind = 'escalation')
              END
        ORDER BY l.since`,
      [now, STRANDED_AFTER_MS / 1000],
    );
    return rows.map((row) => ({
      taskId: row.id,
      projectId: row.project_id,
      status: row.status,
      shape: row.shape,
      since: row.since,
    }));
  });
}

const EXPLANATIONS: Record<StrandedShape, string> = {
  approval_missing:
    'It is waiting for an approval, and no approval or escalation for it is open, so nothing '
    + 'you can answer will move it.',
  review_missing:
    'It is waiting for a review, and no review is pending and no escalation is open, so no '
    + 'reviewer and no decision of yours will move it.',
  wake_missing:
    'It is parked until a window reopens, and the window never does, so it has no time to '
    + 'wake at.',
};

/**
 * Asks the owner about each stranded task, once.
 *
 * Once per task *and shape*: a task that is stranded, rescued, and stranded
 * again some other way is a second thing to know.
 */
export async function reportStranded(companyId: string, now = new Date()): Promise<number> {
  let reported = 0;
  for (const task of await findStranded(companyId, now)) {
    if (await askAboutStranded(companyId, task)) reported += 1;
  }
  return reported;
}

/**
 * Asks about one stranded task, unless somebody already has.
 *
 * The record is written under a per-task advisory lock, so two workers that
 * both found the task -- the ordinary case with more than one worker -- raise
 * one escalation between them: the second waits for the first to commit and
 * then finds its record. Returns whether this call was the one that asked.
 */
export async function askAboutStranded(companyId: string, task: StrandedTask): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('stranded:' || $1))", [task.taskId]);
    const { rows } = await tx.query(
      `SELECT 1 FROM events
        WHERE task_id = $1 AND type = 'task.stranded' AND payload->>'shape' = $2
        LIMIT 1`,
      [task.taskId, task.shape],
    );
    if (rows.length > 0) return false;
    await appendEvent(tx, {
      companyId,
      projectId: task.projectId,
      taskId: task.taskId,
      type: 'task.stranded',
      actor: 'system',
      payload: { shape: task.shape, status: task.status, since: task.since.toISOString() },
    });
    // In the same transaction as the record that says it was asked, so the
    // record cannot outlive a question that was never put.
    await inbox.raiseEscalationWithin(tx, {
      companyId,
      taskId: task.taskId,
      title: 'A task is waiting on nothing',
      detail:
        `Task ${task.taskId} has been ${task.status} since ${task.since.toISOString()}. `
        + `${EXPLANATIONS[task.shape]} Approve to run it again from where it stopped, `
        + 'or deny to cancel it.',
    });
    return true;
  });
}
