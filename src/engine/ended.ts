/**
 * Work that ends badly is not silent, and the owner is not the first to hear
 * (the audit of 3 October, section 3.1).
 *
 * Only budget, a failed read-back, a crash loop and a model that stayed down
 * raised anything when a task halted. A hop limit, a policy refusal, a
 * deadline, an exhausted retry, a cycle, a run that said "not done": each
 * ended in silence, and the owner learned of it by looking at the Work page,
 * which is what the owner of a company run by agents is meant not to do.
 *
 * A root task that ended badly -- halted or failed, with nothing above it to
 * hear of it -- and has no card about it, now raises one escalation. Through
 * `raiseEscalationWithin` with its division, which is F2.1: the coordinator
 * the division names -- the company's CEO, unless the owner named another or
 * nobody -- is asked first, has its grace before the owner is told, and the
 * owner then reads what it did. A coordinator that finishes what it was
 * handed closes the card (`noteHandling` in inbox.ts); one that says it could
 * not, or fails, leaves it for the owner.
 *
 * Four things keep it from becoming noise or a loop. It is asked once per
 * task, and once per cause under a goal while a card for that cause is open:
 * ten tasks halting on the same hop limit are one card, and one coordinator's
 * brief that names them all -- once that brief is written, the next is a card
 * of its own, so a fix never closes a task its coordinator was not told of.
 * It looks only at the last day, so a deployment that starts running this
 * does not report its history. Work the coordinator was itself handed is not
 * a failure of its own: how it ended is written on the card it was handling,
 * and no second card is raised about it. And the coordinator's own work, or
 * an errand the platform made for it, goes to the owner and not back to the
 * coordinator, which would otherwise be asked to fix its own failing.
 *
 * Driven from state, not from the halt: a worker that was down when the task
 * halted reports it when it comes back, and the grace is a minute so that the
 * card the halt raises for itself comes first and this one is not a second.
 */
import { withTenant } from '../db/tenant.ts';
import { escalationPolicyFor } from '../governance/structure.ts';
import * as inbox from '../inbox/inbox.ts';
import { endedBadlyCard, ownerReadingWithin, taskCalledWithin } from '../owner/platform-cards.ts';

/** A minute: what the halt's own handler needs to raise its card first. */
export const ENDED_AFTER_MS = 60_000;
/** The furthest back a task that ended is still reported. */
export const ENDED_WITHIN_MS = 24 * 60 * 60_000;
/** The most tasks one card names. */
const MOST_GROUPED = 50;
/**
 * Work created to handle another's failing is not handed to the same
 * coordinator again, and neither is an errand the platform made for the CEO
 * itself -- a triage, an outcome look -- which would come back to the CEO
 * that has just failed it.
 */
const HANDLED_KEYS = /^(escalation|triage|outcome):/;

interface Ended {
  taskId: string;
  divisionId: string;
  /** The role whose work it was, by the slug a division's policy names a role with. */
  roleSlug: string;
  goalId: string | null;
  haltReason: string | null;
  idempotencyKey: string;
}

/**
 * Already somebody's to hear of: a card about it, one it was handed to
 * handle, or run again already (rerunTask), which is the owner's answer given
 * before any card asked. The handling task's end -- done, not done, halted --
 * is written on the card it was handed (`noteHandling`), which stays open for
 * the owner unless it was done; a second card about the same trouble would
 * only say it again, and a CEO that said "not done" as it was told would raise
 * one every time.
 */
const ALREADY_TOLD = `(
  EXISTS (SELECT 1 FROM inbox_items i
           WHERE i.kind IN ('incident', 'escalation', 'budget_alert')
             AND (i.task_id = t.id OR i.payload->'endedTaskIds' ? t.id::text))
  OR EXISTS (SELECT 1 FROM inbox_items i
              WHERE i.kind = 'escalation' AND i.payload->>'handedTaskId' = t.id::text)
  OR EXISTS (SELECT 1 FROM tasks r WHERE r.idempotency_key = 'rerun:' || t.id::text))`;

/**
 * A card more of the same can still be put on: one nobody has been briefed
 * on yet, or one the coordinator briefed has answered or could not be given
 * (it is then the owner's, as a card that went to nobody is). In between, a
 * task put on it is in nobody's brief: the brief is frozen on the card
 * (`briefedTaskIds`, `handOver` in inbox.ts) before the coordinator's task is
 * made, and the coordinator's fix closes the card with every task on it.
 */
const OPEN_TO_MORE = `(NOT (payload ? 'briefedTaskIds' OR payload ? 'handedTaskId')
  OR payload ? 'handledOutcome' OR payload ? 'handoffFailed')`;

async function findEnded(companyId: string, now: Date): Promise<Ended[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; division_id: string; role_slug: string; goal_id: string | null; halt_reason: string | null; idempotency_key: string;
    }>(
      `SELECT t.id, t.division_id, r.slug AS role_slug, t.goal_id, t.halt_reason, t.idempotency_key
         FROM tasks t
         JOIN roles r ON r.id = t.role_id
        WHERE t.status IN ('halted', 'failed')
          -- A root task, and a follow-up (task.follow_up): it is a child by
          -- its parentage and a root by its work, since the run that made it
          -- finished long ago and nothing above it is waiting to hear. A look
          -- that fails -- unfunded, past its window -- was silent, so the one
          -- primitive made to chase an outcome could lose it unseen.
          AND (t.parent_task_id IS NULL OR t.idempotency_key LIKE 'followup:%')
          AND coalesce(t.halt_reason, '') NOT IN ('owner_stop', 'owner_cancel')
          AND t.finished_at <= $1::timestamptz - make_interval(secs => $2)
          AND t.finished_at >  $1::timestamptz - make_interval(secs => $3)
          AND NOT ${ALREADY_TOLD}
        ORDER BY t.finished_at`,
      [now, ENDED_AFTER_MS / 1000, ENDED_WITHIN_MS / 1000],
    );
    return rows.map((row) => ({
      taskId: row.id, divisionId: row.division_id, roleSlug: row.role_slug, goalId: row.goal_id,
      haltReason: row.halt_reason, idempotencyKey: row.idempotency_key,
    }));
  });
}

/** How many tasks were reported to somebody this pass; the ones put on a card already open are not counted. */
export async function reportEndedBadly(companyId: string, now = new Date()): Promise<number> {
  let raised = 0;
  for (const task of await findEnded(companyId, now)) {
    if (await askAboutEnded(companyId, task)) raised += 1;
  }
  return raised;
}

/**
 * One task, once. Under a per-task lock, so two workers that both found it
 * raise one card between them: the second finds the first's.
 */
async function askAboutEnded(companyId: string, task: Ended): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    // The lock `rerunTask` closes this card under, too: a task run again
    // while this pass looked is seen here, after the lock, and not reported.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ended:' || $1))", [task.taskId]);
    const { rows: told } = await tx.query(
      `SELECT 1 FROM tasks t WHERE t.id = $1 AND ${ALREADY_TOLD}`, [task.taskId]);
    if (told.length > 0) return false;

    // Who is asked first: the coordinator the division's policy names, unless
    // this is what a coordinator was handed, or the coordinator's own work --
    // the CEO, by default, would be asked to fix its own failing. Then the
    // owner hears at once.
    const policy = await escalationPolicyFor(tx, task.divisionId);
    const askFirst = !HANDLED_KEYS.test(task.idempotencyKey) && policy.roleSlug !== task.roleSlug;
    const askedFirst = askFirst ? policy.roleSlug ?? '' : '';

    // The same cause under the same goal, while a card for it is open, is on
    // that card -- one going to the same place. Not on a card about the
    // coordinator's own failing, which the coordinator would then be handed,
    // nor on one whose brief is written and not yet answered (`OPEN_TO_MORE`).
    const key = `${task.goalId ?? 'none'}:${task.haltReason ?? 'failed'}`;
    const { rows: open } = await tx.query<{ id: string; ids: number }>(
      `SELECT id, jsonb_array_length(coalesce(payload->'endedTaskIds', '[]'::jsonb)) AS ids FROM inbox_items
        WHERE kind = 'escalation' AND status = 'open' AND payload->>'endedKey' = $1
          AND coalesce(payload->>'escalationRole', '') = $2
          AND ${OPEN_TO_MORE}
        ORDER BY created_at LIMIT 1`,
      [key, askedFirst]);
    if (open[0]) {
      if (open[0].ids >= MOST_GROUPED) return false;
      // Asked again in the update: a hand-over may have frozen the brief, or
      // the card been closed -- by the owner, by its coordinator's fix, by its
      // tasks run again -- since the look above. The update waits for that
      // one's lock and reads the row it wrote, so a task is either in the
      // brief or on a card of its own, never on a card nobody will read.
      const { rowCount } = await tx.query(
        `UPDATE inbox_items
            SET payload = jsonb_set(payload, '{endedTaskIds}', coalesce(payload->'endedTaskIds', '[]'::jsonb) || to_jsonb($2::text))
          WHERE id = $1 AND status = 'open' AND ${OPEN_TO_MORE}`,
        [open[0].id, task.taskId]);
      if (rowCount) return false;
    }

    const { rows: said } = await tx.query<{ detail: string | null }>(
      `SELECT payload->>'detail' AS detail FROM events
        WHERE task_id = $1 AND type IN ('task.halted', 'task.failed') ORDER BY occurred_at DESC LIMIT 1`,
      [task.taskId]);
    const card = endedBadlyCard(await ownerReadingWithin(tx), {
      task: await taskCalledWithin(tx, task.taskId),
      reason: task.haltReason,
      record: said[0]?.detail?.slice(0, 300) ?? null,
    });
    await inbox.raiseEscalationWithin(tx, {
      companyId, taskId: task.taskId, title: card.title, detail: card.detail,
      // With its division, whose policy then names who is asked first.
      ...(askFirst ? { divisionId: task.divisionId } : {}),
      payload: { endedKey: key, endedTaskIds: [task.taskId], handledCloses: true },
    });
    return true;
  });
}
