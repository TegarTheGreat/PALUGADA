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
 * the division names is asked first, has its grace before the owner is told,
 * and the owner then reads what it did. A coordinator that finishes what it
 * was handed closes the card (`handledSaid` in inbox.ts); one that could not
 * leaves it for the owner.
 *
 * Three things keep it from becoming noise or a loop. It is asked once per
 * task, and once per cause under a goal while a card for that cause is open:
 * ten tasks halting on the same hop limit are one card that names them all.
 * It looks only at the last day, so a deployment that starts running this
 * does not report its history. And work the coordinator was itself handed
 * goes to the owner and not back to the coordinator, which would otherwise
 * be asked to fix its own failing.
 *
 * Driven from state, not from the halt: a worker that was down when the task
 * halted reports it when it comes back, and the grace is a minute so that the
 * card the halt raises for itself comes first and this one is not a second.
 */
import { withTenant } from '../db/tenant.ts';
import * as inbox from '../inbox/inbox.ts';
import { endedBadlyCard, ownerReadingWithin, taskCalledWithin } from '../owner/platform-cards.ts';

/** A minute: what the halt's own handler needs to raise its card first. */
export const ENDED_AFTER_MS = 60_000;
/** The furthest back a task that ended is still reported. */
export const ENDED_WITHIN_MS = 24 * 60 * 60_000;
/** The most tasks one card names. */
const MOST_GROUPED = 50;
/** Work created to handle another's failing is not handed to the same coordinator again. */
const HANDLED_KEYS = /^(escalation|triage):/;

interface Ended {
  taskId: string;
  divisionId: string;
  goalId: string | null;
  haltReason: string | null;
  idempotencyKey: string;
}

async function findEnded(companyId: string, now: Date): Promise<Ended[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; division_id: string; goal_id: string | null; halt_reason: string | null; idempotency_key: string;
    }>(
      `SELECT t.id, t.division_id, t.goal_id, t.halt_reason, t.idempotency_key
         FROM tasks t
        WHERE t.status IN ('halted', 'failed')
          AND t.parent_task_id IS NULL
          AND coalesce(t.halt_reason, '') NOT IN ('owner_stop', 'owner_cancel')
          AND t.finished_at <= $1::timestamptz - make_interval(secs => $2)
          AND t.finished_at >  $1::timestamptz - make_interval(secs => $3)
          AND NOT EXISTS (
                SELECT 1 FROM inbox_items i
                 WHERE i.kind IN ('incident', 'escalation', 'budget_alert')
                   AND (i.task_id = t.id OR i.payload->'endedTaskIds' ? t.id::text))
        ORDER BY t.finished_at`,
      [now, ENDED_AFTER_MS / 1000, ENDED_WITHIN_MS / 1000],
    );
    return rows.map((row) => ({
      taskId: row.id, divisionId: row.division_id, goalId: row.goal_id, haltReason: row.halt_reason, idempotencyKey: row.idempotency_key,
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
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ended:' || $1))", [task.taskId]);
    const { rows: told } = await tx.query(
      `SELECT 1 FROM inbox_items
        WHERE kind IN ('incident', 'escalation', 'budget_alert')
          AND (task_id = $1 OR payload->'endedTaskIds' ? $1::text) LIMIT 1`,
      [task.taskId]);
    if (told.length > 0) return false;

    // The same cause under the same goal, while a card for it is open, is on that card.
    const key = `${task.goalId ?? 'none'}:${task.haltReason ?? 'failed'}`;
    const { rows: open } = await tx.query<{ id: string; ids: number }>(
      `SELECT id, jsonb_array_length(coalesce(payload->'endedTaskIds', '[]'::jsonb)) AS ids FROM inbox_items
        WHERE kind = 'escalation' AND status = 'open' AND payload->>'endedKey' = $1
        ORDER BY created_at LIMIT 1`,
      [key]);
    if (open[0]) {
      if (open[0].ids < MOST_GROUPED) {
        await tx.query(
          `UPDATE inbox_items
              SET payload = jsonb_set(payload, '{endedTaskIds}', coalesce(payload->'endedTaskIds', '[]'::jsonb) || to_jsonb($2::text))
            WHERE id = $1`,
          [open[0].id, task.taskId]);
      }
      return false;
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
      // The coordinator first -- unless this is what the coordinator was handed.
      ...(HANDLED_KEYS.test(task.idempotencyKey) ? {} : { divisionId: task.divisionId }),
      payload: { endedKey: key, endedTaskIds: [task.taskId], handledCloses: true },
    });
    return true;
  });
}
