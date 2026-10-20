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
 * model is answered by it after its own last wait (`model.answered`, which
 * the engine writes because only it knows which of a role's models an
 * attempt was on), and nothing has been refused since: a call another
 * runtime made with credentials of its own, or a task getting through on a
 * different model, would close the card while the work behind it still could
 * not get through, the work would fail again and the card would come back --
 * a second urgent push for nothing. A capability's card closes when its check
 * passes again (`checkCapability`, which calls `callBackWithin` and
 * `withdrawOnceWithin`). A saved key starts the deployment again, so a
 * worker's first look calls back the work waiting for a key
 * (`callBackKeyWaits`) and leaves the card: a key saved is not yet a key
 * that works. A card for a model, a key or a vendor that nothing waits on
 * any more closes too.
 *
 * And raised again. Work on the long waits raises its cause's card at every
 * look when none is open (engine.ts), not only as its short waits run out:
 * a card closed because the cause seemed to pass, with the cause back, would
 * otherwise leave the work still parked waiting for up to a day with nobody
 * told -- the silent retry F13.6 and F8.12 forbid. The owner who answers a
 * card while the work still waits is told again at its next look, as 2.140
 * did for the key.
 *
 * A card that holds work which stopped while it was open (`holdEndedOn` in
 * inbox.ts: a day's waiting spent) is not withdrawn. That work is reported on
 * it and nowhere else (ended.ts counts it as told), and closing it because the
 * cause passed would leave the stopped work unsaid.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { lockOnceWithin, withdrawOnceWithin } from '../inbox/inbox.ts';

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

/** An open card about a cause, as `closeRecovered` reads it. */
interface CauseCard {
  id: string;
  once: string;
  created_at: Date;
}

/**
 * Each open card about a model, a refused key or a vendor's outage whose
 * cause is seen to have passed, or that no work waits on any more: the work
 * still waiting on it is called back and the card is withdrawn. Returns how
 * many tasks were called back.
 */
export async function closeRecovered(companyId: string): Promise<number> {
  const cards = await withTenant(companyId, (tx) => tx.query<CauseCard>(
    `SELECT id, payload->>'once' AS once, created_at FROM inbox_items
      WHERE kind = 'incident' AND status = 'open'
        AND (payload->>'once' LIKE 'model\\_down:%' OR payload->>'once' LIKE 'service\\_down:%' OR payload->>'once' = $1)
      ORDER BY created_at`,
    [ONCE.key],
  ));
  let called = 0;
  for (const card of cards.rows) {
    called += card.once.startsWith('service_down:') ? await closeUnwaited(companyId, card) : await recover(companyId, card);
  }
  return called;
}

async function recover(companyId: string, card: CauseCard): Promise<number> {
  const key = card.once === ONCE.key;
  const model = key ? null : card.once.slice(ONCE.model('').length);
  return withTenant(companyId, async (tx) => {
    // The lock raising this card takes, held from the reading to the
    // withdrawal: work refused in the meantime either raised against the
    // card before this reads, and its wait is read here, or finds the card
    // withdrawn and raises its own. Without it, a task refused in that
    // moment found the card open, raised nothing, and the card closed under
    // it. Two workers reading the same card take turns on it too.
    await lockOnceWithin(tx, companyId, card.once);
    const { rows: open } = await tx.query("SELECT 1 FROM inbox_items WHERE id = $1 AND status = 'open'", [card.id]);
    if (open.length === 0) return 0;
    // What waits on it: each task whose last wait for a model, of either
    // kind, was for this cause -- the key, or this model. A task last waiting
    // for something else waits on that. A wait is at most a day and a little
    // more (the ceiling), so two days of waits is every one that can still
    // be parked.
    //
    // When each got through after its wait. For a model, the engine's word
    // that the model answered it (`model.answered`): only the engine knows
    // which of a role's models an attempt was on, and getting through on the
    // first is no answer from the last one tried, which the wait is for. For
    // the key, any call it made or its finishing: a key is refused before
    // any model answers.
    //
    // The cause has passed when the last that got through did so after the
    // card was raised and after every refusal, by any work: a task refused
    // after another got through is the provider still failing, and closing
    // on the first would leave the second waiting with no card. And whether
    // any work still waits on it, not ended and not through: with none, the
    // card speaks for nothing -- the owner cancelled what waited, or it ended
    // some other way -- and would say for good that work is waiting.
    const { rows } = await tx.query<{ answered: Date | null; refused: Date | null; waiting: boolean }>(
      `WITH last AS (
         SELECT DISTINCT ON (w.task_id) w.task_id, w.occurred_at, w.payload
           FROM events w
          WHERE w.type = 'task.model_waited' AND w.occurred_at > now() - interval '2 days'
          ORDER BY w.task_id, w.occurred_at DESC),
       mine AS (
         SELECT task_id, occurred_at FROM last
          WHERE coalesce(payload->>'keyRefused', 'false') = $1 AND ($2::text IS NULL OR payload->>'model' = $2)),
       seen AS (
         SELECT mine.task_id,
                CASE WHEN $2::text IS NULL THEN least(
                  (SELECT min(l.occurred_at) FROM llm_traces l
                    WHERE l.task_id = mine.task_id AND l.kind = 'call' AND l.occurred_at > mine.occurred_at),
                  (SELECT t.finished_at FROM tasks t
                    WHERE t.id = mine.task_id AND t.status = 'completed' AND t.finished_at > mine.occurred_at))
                ELSE (SELECT min(a.occurred_at) FROM events a
                       WHERE a.task_id = mine.task_id AND a.type = 'model.answered' AND a.payload->>'model' = $2
                         AND a.occurred_at > mine.occurred_at) END AS at
           FROM mine)
       SELECT (SELECT max(at) FROM seen WHERE at > $3::timestamptz) AS answered,
              (SELECT max(w.occurred_at) FROM events w
                WHERE w.type = 'task.model_waited' AND w.occurred_at > now() - interval '2 days'
                  AND coalesce(w.payload->>'keyRefused', 'false') = $1
                  AND ($2::text IS NULL OR w.payload->>'model' = $2)) AS refused,
              EXISTS (SELECT 1 FROM seen JOIN tasks t ON t.id = seen.task_id
                       WHERE seen.at IS NULL AND t.status NOT IN ('completed', 'failed', 'halted', 'cancelled')) AS waiting`,
      [key ? 'true' : 'false', model, card.created_at],
    );
    const { answered = null, refused = null, waiting = false } = rows[0] ?? {};
    if (answered && (!refused || answered > refused)) {
      const because = key ? 'key_works' : 'model_answered';
      // The work first, then its card: every writer takes a task before the
      // inbox items about it.
      const called = await callBackWithin(tx, companyId, {
        reason: key ? 'model_key' : 'model', ...(model === null ? {} : { model }), before: answered, because,
      });
      await withdrawOnceWithin(tx, companyId, [card.once], because);
      return called;
    }
    if (!waiting) await withdrawOnceWithin(tx, companyId, [card.once], 'nothing_waits');
    return 0;
  });
}

/**
 * A vendor's card that no work waits on any more -- the owner cancelled what
 * waited, or it ended some other way -- is withdrawn: it says the work that
 * needs the service is waiting, and only a check finding the service well
 * would otherwise close it, which needs something to ask for the service
 * again. Not the card for a check that failed for good (`ONCE.capability`):
 * that is about the credential, which F8.12 has the owner put right whether
 * or not work waits on it -- the sweep at a start raises it with none -- and
 * it closes when a check passes. Nothing is called back: a vendor's coming
 * back is seen by a check (`checkCapability`), not here.
 */
async function closeUnwaited(companyId: string, card: CauseCard): Promise<number> {
  const [, divisionId, ...rest] = card.once.split(':');
  const capability = rest.join(':');
  await withTenant(companyId, async (tx) => {
    // As for a model's card: whoever raises it takes this lock, and the
    // engine raises it after the wait is written, so work refused in the
    // meantime is either read here or raises its own.
    await lockOnceWithin(tx, companyId, card.once);
    const { rows } = await tx.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM tasks t
          CROSS JOIN LATERAL (
            SELECT w.payload FROM events w
             WHERE w.task_id = t.id AND w.type = 'task.capability_waited' AND w.occurred_at > now() - interval '2 days'
             ORDER BY w.occurred_at DESC LIMIT 1) w
          WHERE t.division_id::text = $1 AND t.status NOT IN ('completed', 'failed', 'halted', 'cancelled')
            AND coalesce(w.payload->'capabilities', '[]'::jsonb) ? $2) AS waiting`,
      [divisionId, capability],
    );
    if (!rows[0]?.waiting) await withdrawOnceWithin(tx, companyId, [card.once], 'nothing_waits');
  });
  return 0;
}
