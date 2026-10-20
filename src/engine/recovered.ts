/**
 * Work that waits for something outside the company is called back when it
 * answers, and the one card that said so closes itself (the owner-load review
 * of October; STATUS 2.140, which did this halfway for a refused key).
 *
 * A model down for an afternoon, a vendor's outage, a credential that expired
 * overnight: each halted every task in flight, an urgent card apiece, and when
 * the cause had passed the owner pressed "Run again" on each, which started
 * the work from nothing. Now the work waits (`OUTAGE_PARK_WAITS_MS` in
 * engine.ts), the owner reads one card for the cause, named by what it is
 * about (`ONCE`), and this is what ends the wait: when the work that waited
 * is seen to get through, the rest is called back at once instead of at its
 * next look, and the card is withdrawn.
 *
 * Seen, not assumed. A model's card closes when a task that waited for that
 * model made a call after its own last wait, or finished: a call another
 * runtime made with credentials of its own would close the card while the
 * work behind it still could not get through, the work would fail again and
 * the card would come back -- a second urgent push for nothing. A capability's
 * card closes when its check passes again (`checkCapability`, which calls
 * `callBackWithin` and `withdrawOnceWithin`). A saved key starts the
 * deployment again, so a worker's first look calls back the work waiting for
 * a key (`callBackKeyWaits`) and leaves the card: a key saved is not yet a key
 * that works.
 *
 * A card that holds work which stopped while it was open (`holdEndedOn` in
 * inbox.ts: a day's waiting spent) is not withdrawn. That work is reported on
 * it and nowhere else (ended.ts counts it as told), and closing it because the
 * cause passed would leave the stopped work unsaid.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { withdrawOnceWithin } from '../inbox/inbox.ts';

/**
 * How long work waits on the long waits before it stops: a day, counted from
 * its first long wait. A deadline gives a parked task its wait back (2.158),
 * so without a ceiling of its own a wait for a model that never came back
 * would never end.
 */
export const OUTAGE_PARK_CEILING_MS = 24 * 3_600_000;

/**
 * The names the cards about a cause go by (`once` on an incident): one card
 * for the cause however much work meets it, found again by its name after a
 * restart, when work that waited on it stops, and when it is to be closed.
 */
export const ONCE = {
  model: (model: string): string => `model_down:${model}`,
  service: (divisionId: string, capability: string): string => `service_down:${divisionId}:${capability}`,
  capability: (divisionId: string, capability: string): string => `capability:${divisionId}:${capability}`,
  key: 'model_key_refused',
} as const;

/** Which waiting work to call back, and why, as its timeline says. */
export interface Waiting {
  /** What it parked for (`WaitReason` in tasks.ts). */
  reason: 'model' | 'model_key' | 'service';
  /** Only work in this division: a capability's health is the division's, because its credential is. */
  divisionId?: string;
  /** Only work whose last wait named this capability. */
  capability?: string;
  /** Only work whose last wait was for this model. */
  model?: string;
  /** Only work whose last wait was before this: what answered after it is what it waited for. */
  before?: Date;
  because: 'capability_healthy' | 'model_answered' | 'key_works' | 'started';
}

/**
 * Calls back the work waiting for what `waiting` names: its wake time is now,
 * so the next claim takes it, and its timeline says why (`task.called_back`),
 * which is also what tells the engine that its next look was not its own and
 * keeps its place on its waits.
 *
 * Only work still parked for that reason: a task the owner cancelled, or one
 * a worker has already taken, is not touched. Each park is called back once:
 * work called back and not yet looked again is left, so two workers -- or two
 * starts -- that both see the cause pass call nothing back twice. They take
 * turns under a lock for the company, so the second reads what the first
 * wrote. Rows are taken in id order and a row another writer holds is passed
 * over: it is being moved by whoever holds it.
 */
export async function callBackWithin(tx: TenantClient, companyId: string, waiting: Waiting): Promise<number> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`call-back:${companyId}`]);
  const { rows } = await tx.query<{ id: string; project_id: string }>(
    `WITH due AS (
       SELECT t.id
         FROM tasks t
        CROSS JOIN LATERAL (
          SELECT w.occurred_at, w.payload FROM events w
           WHERE w.task_id = t.id AND w.type = $3
             AND coalesce(w.payload->>'keyRefused', 'false') = $4
           ORDER BY w.occurred_at DESC LIMIT 1) w
        WHERE t.company_id = $1 AND t.status = 'waiting_window' AND t.wait_until > now()
          AND (SELECT e.payload->>'reason' FROM events e
                WHERE e.task_id = t.id AND e.type = 'task.waiting_window'
                ORDER BY e.occurred_at DESC LIMIT 1) = $2
          AND ($5::uuid IS NULL OR t.division_id = $5)
          AND ($6::text IS NULL OR coalesce(w.payload->'capabilities', '[]'::jsonb) ? $6)
          AND ($7::text IS NULL OR w.payload->>'model' = $7)
          AND ($8::timestamptz IS NULL OR w.occurred_at < $8)
          AND NOT EXISTS (
                SELECT 1 FROM events c
                 WHERE c.task_id = t.id AND c.type = 'task.called_back' AND c.occurred_at >= w.occurred_at)
        ORDER BY t.id
        FOR NO KEY UPDATE OF t SKIP LOCKED)
     UPDATE tasks t SET wait_until = now()
       FROM due
      WHERE t.id = due.id AND t.status = 'waiting_window' AND t.wait_until > now()
     RETURNING t.id, t.project_id`,
    [
      companyId,
      waiting.reason,
      waiting.reason === 'service' ? 'task.capability_waited' : 'task.model_waited',
      waiting.reason === 'model_key' ? 'true' : 'false',
      waiting.divisionId ?? null,
      waiting.capability ?? null,
      waiting.model ?? null,
      waiting.before ?? null,
    ],
  );
  for (const row of rows) {
    await appendEvent(tx, {
      companyId, projectId: row.project_id, taskId: row.id, type: 'task.called_back', actor: 'system',
      payload: { reason: waiting.reason, because: waiting.because },
    });
  }
  return rows.length;
}

/**
 * At a worker's start, the work waiting for a model key is called back: a
 * key is saved in the console, and saving it starts the deployment again
 * (src/settings/store.ts). The card stays until a call works.
 */
export async function callBackKeyWaits(companyId: string): Promise<number> {
  return withTenant(companyId, (tx) => callBackWithin(tx, companyId, { reason: 'model_key', because: 'started' }));
}

/**
 * Each open card about a model or a refused key whose cause is seen to have
 * passed: the work still waiting on it is called back and the card is
 * withdrawn. Returns how many tasks were called back.
 */
export async function closeRecovered(companyId: string): Promise<number> {
  const cards = await withTenant(companyId, (tx) => tx.query<{ id: string; once: string; created_at: Date }>(
    `SELECT id, payload->>'once' AS once, created_at FROM inbox_items
      WHERE kind = 'incident' AND status = 'open'
        AND (payload->>'once' LIKE 'model\\_down:%' OR payload->>'once' = $1)
      ORDER BY created_at`,
    [ONCE.key],
  ));
  let called = 0;
  for (const card of cards.rows) called += await recover(companyId, card);
  return called;
}

async function recover(companyId: string, card: { id: string; once: string; created_at: Date }): Promise<number> {
  const key = card.once === ONCE.key;
  const model = key ? null : card.once.slice(ONCE.model('').length);
  return withTenant(companyId, async (tx) => {
    // The same lock the call-back takes, held from the reading: two workers
    // that both read the card open and both saw it answered would otherwise
    // each call back what the other had not yet marked.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`call-back:${companyId}`]);
    const { rows: open } = await tx.query("SELECT 1 FROM inbox_items WHERE id = $1 AND status = 'open'", [card.id]);
    if (open.length === 0) return 0;
    // When the work that waited for it last got through: a call it made
    // after its own last wait, or its finishing, and either after the card
    // was raised. A wait is at most a day and a little more (the ceiling),
    // so two days of waits is every one that can still be parked.
    //
    // And whether any work still waits on it: a task not ended whose last
    // wait was for it and that has not got through since -- one taking its
    // look right now among them. With none, the card speaks for nothing:
    // the owner cancelled what waited, or it ended some other way, and the
    // card would say for good that work is waiting.
    const { rows } = await tx.query<{ answered: Date | null; waiting: boolean }>(
      `WITH last AS (
         SELECT DISTINCT ON (w.task_id) w.task_id, w.occurred_at
           FROM events w
          WHERE w.type = 'task.model_waited'
            AND coalesce(w.payload->>'keyRefused', 'false') = $1
            AND ($2::text IS NULL OR w.payload->>'model' = $2)
            AND w.occurred_at > now() - interval '2 days'
          ORDER BY w.task_id, w.occurred_at DESC),
       seen AS (
         SELECT last.task_id, max(through.at) AS at
           FROM last
          CROSS JOIN LATERAL (
            SELECT min(l.occurred_at) AS at FROM llm_traces l
             WHERE l.task_id = last.task_id AND l.kind = 'call' AND l.occurred_at > greatest(last.occurred_at, $3::timestamptz)
            UNION ALL
            SELECT t.finished_at FROM tasks t
             WHERE t.id = last.task_id AND t.status = 'completed' AND t.finished_at > greatest(last.occurred_at, $3::timestamptz)) through
          GROUP BY last.task_id)
       SELECT (SELECT max(at) FROM seen) AS answered,
              EXISTS (SELECT 1 FROM last JOIN tasks t ON t.id = last.task_id
                       WHERE t.status NOT IN ('completed', 'failed', 'halted', 'cancelled')
                         AND NOT EXISTS (SELECT 1 FROM seen WHERE seen.task_id = last.task_id AND seen.at IS NOT NULL)) AS waiting`,
      [key ? 'true' : 'false', model, card.created_at],
    );
    const answered = rows[0]?.answered ?? null;
    if (!answered) {
      if (!rows[0]?.waiting) await withdrawOnceWithin(tx, companyId, [card.once], 'nothing_waits');
      return 0;
    }
    const because = key ? 'key_works' : 'model_answered';
    // The work first, then its card: every writer takes a task before the
    // inbox items about it.
    const called = await callBackWithin(tx, companyId, {
      reason: key ? 'model_key' : 'model', ...(model === null ? {} : { model }), before: answered, because,
    });
    await withdrawOnceWithin(tx, companyId, [card.once], because);
    return called;
  });
}
