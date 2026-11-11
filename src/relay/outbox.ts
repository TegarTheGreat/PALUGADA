/**
 * What is owed to each relay, and its sending (F19.19; STATUS section 2.208).
 *
 * Whoever has something for a relay -- the owner's channel, a link confirmed,
 * a ping, a key rotated -- writes a row and returns: enqueueing is the only
 * relay work anything does on a request path or inside the worker's tick. The
 * relay loop (`loop.ts`) sends the rows, each signed at send time over the
 * canonical body kept here. A 2xx answer, or a 409 that says the relay
 * already had it, delivers the row; anything else is tried again later under
 * the same id, after 30 seconds, then a minute, two, and so on, and after
 * eight attempts the row is dead and shown to the owner with a way to try
 * again. A row a process took and never finished with is taken back after
 * ten minutes, under the same id. Order is kept per relay and link.
 */
import type { KeyObject } from 'node:crypto';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { envelopeBody, envelopeHeaders, envelopeId } from './envelope.ts';
import { tokenHash } from './offers.ts';

/** Rows claimed for one relay in one pass. */
export const CLAIM_BATCH = 50;
/** Envelopes in flight to one relay at once. */
export const SENDS_IN_FLIGHT = 4;
/** How long one send may take. */
export const SEND_TIMEOUT_MS = 5_000;
/** How long the first retry waits; each after it waits twice as long. */
export const RETRY_BASE_SECONDS = 30;
/** How many attempts before a row is dead. */
export const MAX_ATTEMPTS = 8;
/** How long a row may sit claimed before it is taken back: its process died. */
export const STALE_SENDING_MINUTES = 10;

/**
 * What this process counted, for the metrics scraper (`src/reporting/metrics.ts`):
 * deliveries by how they ended, and inbound refusals by why. In memory, like
 * the worker's counts, and back at zero with the process.
 */
export const RELAY_COUNTS = {
  deliveries: new Map<string, number>(),
  refused: new Map<string, number>(),
};

export function countDelivery(outcome: 'delivered' | 'failed' | 'dead' | 'gone'): void {
  RELAY_COUNTS.deliveries.set(outcome, (RELAY_COUNTS.deliveries.get(outcome) ?? 0) + 1);
}

export function countRefusal(reason: string): void {
  RELAY_COUNTS.refused.set(reason, (RELAY_COUNTS.refused.get(reason) ?? 0) + 1);
}

/** Where a notice opens in PALUGADA, kept beside its envelope and never in it (STATUS section 2.216). */
export interface Opens {
  roomId?: string | null | undefined;
  threadOf?: string | null | undefined;
  itemId?: string | null | undefined;
  taskId?: string | null | undefined;
}

export interface OutboxEntry {
  id: string;
  relayId: string;
  linkId: string | null;
  companyId: string | null;
  type: string;
  subjects: string[];
  body: string;
  /** What the envelope's link opens, by the handle in it: read only by the console, for the person it was for. */
  opens?: Opens;
  handle?: string | null;
}

/**
 * Owes an envelope to a relay. The id is the envelope's own, made from what it
 * is about, so owing the same thing twice writes one row. Answers whether this
 * call wrote it.
 */
export async function enqueue(tx: TenantClient, entry: OutboxEntry, now = new Date()): Promise<boolean> {
  const opens = entry.opens ?? {};
  const { rowCount } = await tx.query(
    `INSERT INTO relay_outbox (id, relay_id, link_id, company_id, type, subjects, body, next_at, created_at,
                               handle, room_id, thread_of, item_id, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [entry.id, entry.relayId, entry.linkId, entry.companyId, entry.type, entry.subjects, entry.body, now,
      entry.handle ?? null, opens.roomId ?? null, opens.threadOf ?? null, opens.itemId ?? null, opens.taskId ?? null]);
  return rowCount === 1;
}

/**
 * What an envelope the deployment pulled from a relay was answered, owed
 * back to that relay as an `act_result` naming it (STATUS section 2.216): a
 * relay that is pulled from learns what a pushing relay learns from the
 * answer to its request -- a press decided or refused and why, a reply's
 * message, an act that lapsed waiting. Its id is made from the envelope it
 * answers, so a pull answered again owes it once.
 */
export async function answerPulled(relayId: string, ref: string, answer: { status: number; body: Record<string, unknown> }, now = new Date()): Promise<void> {
  await withControlPlane(async (tx) => {
    // The relay's row first, as every change of its outbox takes it.
    await tx.query('SELECT 1 FROM relays WHERE id = $1 FOR UPDATE', [relayId]);
    const { rows: [control] } = await tx.query<{ deployment: string }>('SELECT deployment_id::text AS deployment FROM platform_control');
    const id = envelopeId({ deployment: control!.deployment, relay: relayId, link: null, type: 'act_result', subject: ref });
    await enqueue(tx, {
      id, relayId, linkId: null, companyId: null, type: 'act_result', subjects: [],
      body: envelopeBody({
        v: 1, id, type: 'act_result', at: now.toISOString(), deployment: control!.deployment, relay: relayId,
        data: { ref, status: answer.status, answer: answer.body },
      }),
    }, now);
  });
}

/** Rows a process took more than ten minutes ago and never settled: owed again, under the same id. */
export async function takeBackStale(now = new Date()): Promise<number> {
  return withControlPlane(async (tx) => {
    // Rows another transaction holds are left to the next pass: this one
    // takes rows of every relay at once, and must never wait on one of them
    // while that transaction waits on another.
    const { rowCount } = await tx.query(
      `UPDATE relay_outbox SET status = 'pending', claimed_at = NULL
        WHERE id IN (SELECT id FROM relay_outbox
                      WHERE status = 'sending' AND claimed_at < $1::timestamptz - make_interval(mins => $2)
                        FOR UPDATE SKIP LOCKED)`,
      [now, STALE_SENDING_MINUTES]);
    return rowCount ?? 0;
  });
}

interface Claimed {
  id: string;
  type: string;
  link_id: string | null;
  body: string;
  attempts: number;
  created_at: Date;
}

/** The keys envelopes are signed with now, and those a rotation is signed with while the key it replaces is kept. */
export interface Signing {
  keys: readonly KeyObject[];
  kid: string;
  rotation?: readonly KeyObject[];
}

export interface Destination {
  id: string;
  envelopesUrl: string;
}

export interface SendReport {
  delivered: number;
  failed: number;
  dead: number;
  /** The relay answered 410: it forgot this deployment, and is paused. */
  gone: boolean;
}

/**
 * A person's notice whose message was deleted or retention took it since it
 * was owed (STATUS section 2.213), or a people's meeting's reminder whose
 * title was (STATUS section 2.215). It is not taken to send, whatever brought
 * it here: owed when the delete committed and before its retraction ran, put
 * back after a send that failed, or tried again from the dead letters. The
 * notify stage's next pass drops it and voids its tokens
 * (`retractRemoved`, src/relay/people.ts); until then it waits unsent, and
 * holds back nothing behind it.
 */
const REMOVED_WORDS = `(o.type = 'room_activity' OR o.type = 'meeting_soon') AND EXISTS (
  SELECT 1 FROM unnest(o.subjects) AS s(subject)
   WHERE s.subject LIKE 'message:%'
     AND NOT EXISTS (SELECT 1 FROM room_messages m
                      WHERE m.company_id = o.company_id AND m.id = substr(s.subject, 9)::uuid AND m.deleted_at IS NULL))`;

/**
 * A person's notices about a room, owed now, that the person may no longer
 * see the room of: taken out of a private room or a direct one since the
 * notice was written (STATUS section 2.216). The same question
 * `app.room_visible_to` asks, put on the control plane, which names no
 * reader. Dropped as the loop is about to send, with their tokens, so a
 * notice owed when its person left, or put back from the dead letters days
 * later, tells them nothing more about the room.
 */
async function dropUnseen(tx: TenantClient, relayId: string, now: Date): Promise<number> {
  const { rows } = await tx.query<{ body: string }>(
    `DELETE FROM relay_outbox o USING relay_links l
      WHERE o.relay_id = $1 AND o.status = 'pending' AND o.next_at <= $2
        AND (o.type = 'room_activity' OR o.type = 'meeting_soon') AND o.room_id IS NOT NULL
        AND l.id = o.link_id
        AND NOT EXISTS (
          SELECT 1 FROM rooms r
           WHERE r.company_id = o.company_id AND r.id = o.room_id
             AND (r.kind IN ('company', 'division')
                  OR (r.kind = 'topic' AND (NOT r.private OR l.principal = 'owner'))
                  OR EXISTS (SELECT 1 FROM room_access a
                              WHERE a.company_id = o.company_id AND a.room_id = o.room_id AND a.principal = l.principal)))
      RETURNING o.body`,
    [relayId, now]);
  const tokens = rows.flatMap((row) => ((JSON.parse(row.body) as { offers?: Array<{ token: string }> }).offers ?? [])
    .map((offer) => tokenHash(String(offer.token))));
  if (tokens.length > 0) {
    await tx.query('UPDATE relay_offers SET voided_at = $2 WHERE token_hash = ANY($1::text[]) AND voided_at IS NULL', [tokens, now]);
  }
  for (let one = 0; one < rows.length; one += 1) countDelivery('gone');
  return rows.length;
}

/**
 * Sends what is due to one relay, signed now with the keys given. A row
 * whose link has an earlier row still owed and not yet due, or one being sent
 * by this process or another, waits behind it, and one link's rows go one at
 * a time, so a relay sees one person's envelopes in the order they were
 * made; up to four links are sent at once. A notice of words removed since
 * is never taken, and one about a room its person may no longer see is
 * dropped.
 */
export async function sendDue(
  relay: Destination,
  signing: Signing,
  options: { now?: Date; deadline?: number; fetch?: typeof fetch } = {},
): Promise<SendReport> {
  const now = options.now ?? new Date();
  const send = options.fetch ?? globalThis.fetch;
  const report: SendReport = { delivered: 0, failed: 0, dead: 0, gone: false };
  const claimed = await withControlPlane(async (tx) => {
    // The relay's row first, as every change of its outbox takes it. It is
    // also what keeps the order across replicas: a second claim waits here
    // until the first has committed, and its own statement then sees the
    // first one's rows as being sent and holds each link's later rows behind
    // them, where without it both would read them as still owed and due
    // (STATUS section 2.216).
    await tx.query('SELECT 1 FROM relays WHERE id = $1 FOR UPDATE', [relay.id]);
    await dropUnseen(tx, relay.id, now);
    return (await tx.query<Claimed>(
    `UPDATE relay_outbox SET status = 'sending', claimed_at = $2
      WHERE id IN (
        SELECT o.id FROM relay_outbox o
         WHERE o.relay_id = $1 AND o.status = 'pending' AND o.next_at <= $2
           AND NOT EXISTS (
             SELECT 1 FROM relay_outbox e
              WHERE e.relay_id = o.relay_id AND e.link_id IS NOT DISTINCT FROM o.link_id
                AND e.created_at < o.created_at
                AND (e.status = 'sending' OR (e.status = 'pending' AND e.next_at > $2)))
           AND NOT (${REMOVED_WORDS})
         ORDER BY o.created_at, o.id
         LIMIT $3
           FOR UPDATE SKIP LOCKED)
      RETURNING id, type, link_id, body, attempts, created_at`,
    [relay.id, now, CLAIM_BATCH])).rows;
  });
  if (claimed.length === 0) return report;

  // One queue per link, in the order the rows were made.
  const byLink = new Map<string, Claimed[]>();
  for (const row of claimed.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))) {
    const key = row.link_id ?? '';
    byLink.set(key, [...(byLink.get(key) ?? []), row]);
  }
  const queues = [...byLink.values()];
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;

  const drain = async (): Promise<void> => {
    for (let queue = queues.shift(); queue; queue = queues.shift()) {
      for (let index = 0; index < queue.length; index += 1) {
        const row = queue[index]!;
        if (report.gone || Date.now() > deadline) {
          // Out of time, or the relay forgot us: back to pending, untried.
          await release(relay.id, queue.slice(index));
          break;
        }
        const outcome = await sendOne(relay, row, signing, now, send);
        if (outcome === 'delivered') report.delivered += 1;
        else if (outcome === 'gone') {
          report.gone = true;
          await release(relay.id, queue.slice(index));
          break;
        } else {
          if (outcome === 'dead') report.dead += 1;
          else report.failed += 1;
          // The rest of this link waits behind the one that failed.
          await release(relay.id, queue.slice(index + 1));
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SENDS_IN_FLIGHT, queues.length) }, drain));
  return report;
}

async function release(relayId: string, rows: readonly Claimed[]): Promise<void> {
  if (rows.length === 0) return;
  await withControlPlane(async (tx) => {
    // The relay's row first, as every change of more than one of its rows
    // takes it: a revocation deleting these rows meanwhile is waited for,
    // not waited on.
    await tx.query('SELECT 1 FROM relays WHERE id = $1 FOR UPDATE', [relayId]);
    await tx.query(
      `UPDATE relay_outbox SET status = 'pending', claimed_at = NULL WHERE id = ANY($1::uuid[]) AND status = 'sending'`,
      [rows.map((row) => row.id)]);
  });
}

/**
 * Why a send failed, as it is kept: a status the relay answered, or that it
 * did not answer in time, or could not be reached. A code rather than the
 * transport's words, which are English and may quote what they should not;
 * the console says each in the owner's language.
 */
function failureOf(status: number, error: unknown): string {
  if (error === null) return `status:${status}`;
  const name = (error as Error).name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
}

async function sendOne(
  relay: Destination,
  row: Claimed,
  signing: Signing,
  now: Date,
  send: typeof fetch,
): Promise<'delivered' | 'failed' | 'dead' | 'gone'> {
  let status = 0;
  let failure: string | null = null;
  try {
    // Signed now, not when it was owed: the time is the send's, and a relay
    // holds an envelope to five minutes of it.
    const response = await send(relay.envelopesUrl, {
      method: 'POST',
      headers: envelopeHeaders(row.type === 'keys_rotated' && signing.rotation ? signing.rotation : signing.keys, signing.kid, row.id, row.body, now),
      body: row.body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'error',
    });
    status = response.status;
    // The answer's body is not read: what the status says is all a send learns.
    try {
      await response.body?.cancel();
    } catch {
      // A body already gone is no failure of the send.
    }
    if (!(response.ok || status === 409)) failure = failureOf(status, null);
  } catch (error) {
    failure = failureOf(0, error);
  }
  if (status === 410) {
    // Not this row's failure: the relay no longer knows the deployment. The
    // relay is paused until the owner pairs it again, and the row waits.
    await withControlPlane(async (tx) => {
      await tx.query(
        `UPDATE relays SET paused_until = 'infinity', last_error = 'gone', failures = failures + 1 WHERE id = $1`, [relay.id]);
    });
    countDelivery('gone');
    return 'gone';
  }
  // The relay's row before the envelope's, in each case, as every change of
  // a relay's rows takes it.
  if (failure === null) {
    await withControlPlane(async (tx) => {
      await tx.query('UPDATE relays SET last_ok_at = $2, failures = 0, last_error = NULL WHERE id = $1', [relay.id, now]);
      await tx.query(
        `UPDATE relay_outbox SET status = 'delivered', delivered_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [row.id, now]);
    });
    countDelivery('delivered');
    return 'delivered';
  }
  const attempts = row.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE relays SET failures = failures + 1, last_error = $2 WHERE id = $1', [relay.id, failure]);
    await tx.query(
      `UPDATE relay_outbox
          SET status = $3, attempts = $2::int, claimed_at = NULL, last_error = $4,
              next_at = $5::timestamptz + make_interval(secs => $6::int * power(2, $2::int - 1))
        WHERE id = $1`,
      [row.id, attempts, dead ? 'dead' : 'pending', failure, now, RETRY_BASE_SECONDS]);
  });
  countDelivery(dead ? 'dead' : 'failed');
  return dead ? 'dead' : 'failed';
}
