/**
 * The relay loop (F19.19, F19.20; STATUS section 2.208).
 *
 * A loop of its own, started beside the worker as the heartbeat timer is,
 * and never a stage of the worker's tick: a relay that answers slowly, or a
 * long poll held open for twenty-five seconds, must never hold up telling the
 * owner, escalating, or running work. It runs while everything is stopped,
 * as the worker's notify stage does: delivering what is owed commits nothing
 * on any company's behalf.
 *
 * Each pass takes back sends a dead process left half done, then for each
 * paired relay -- at most four at once, within twenty seconds -- sends what
 * is due and, for a relay in pull mode, starts a long poll of its inbox
 * beside the sends rather than before them. One process pulls a relay at a
 * time, by a lease on its row. Once a day it does the deployment's relay
 * bookkeeping.
 */
import { randomUUID, type KeyObject } from 'node:crypto';
import { withControlPlane } from '../db/tenant.ts';
import type { MasterKey } from '../settings/store.ts';
import { envelopeHeaders } from './envelope.ts';
import { forgetPreviousKey, signingKeys } from './identity.ts';
import { receiveFromRelay, relayHasRoom } from './inbound.ts';
import { sendDue, takeBackStale } from './outbox.ts';
import { boundedText, settled, type RelayRow } from './relays.ts';

/** How long one pass may spend sending. */
export const PASS_BUDGET_MS = 20_000;
/** Relays served at once. */
export const RELAYS_IN_FLIGHT = 4;
/** How long the deployment's long poll asks a relay to hold the answer. */
export const PULL_WAIT_SECONDS = 25;
/** How long a lease to pull one relay lasts: the long poll and a margin. */
const PULL_LEASE_SECONDS = 40;
/** The most envelopes a relay may answer one pull with (docs/relay-protocol.md, section 9). */
const PULL_MOST = 100;
/**
 * The most bytes of one pull's answer that are read: a hundred envelopes of
 * the few hundred bytes an act is, with room to spare, and well short of what
 * a relay streaming without end could make the deployment hold.
 */
const PULL_MOST_BYTES = 8 * 1024 * 1024;
/** How long an offer spent, void or past its time is kept, so a late press is told why rather than that it is unknown. */
const SPENT_OFFER_DAYS = 4;
/** How long a receipt, a refusal, a dead letter or a delivered envelope is kept. */
export const KEPT_DAYS = 14;
/** How often a pass runs when the last one found nothing to do. */
const IDLE_MS = 2_000;
const DAY_MS = 24 * 60 * 60_000;

export interface RelayPassOptions {
  master: () => MasterKey | null;
  previousMasters?: () => readonly MasterKey[];
  now?: Date;
  fetch?: typeof fetch;
  /** The long poll's wait, in seconds; a test asks for none. */
  pullWaitSeconds?: number;
  /** Waits for the pulls this pass started, as a test does; the loop never waits. */
  awaitPulls?: boolean;
  log?: (entry: Record<string, unknown>) => void;
}

export interface RelayPassReport {
  relays: number;
  delivered: number;
  failed: number;
  dead: number;
  pulled: number;
  takenBack: number;
}

/** The pulls in flight in this process, by relay, so a pass never starts a second beside one still waiting. */
const pulling = new Map<string, Promise<number>>();

/** One pass over every paired relay. */
export async function relayPass(options: RelayPassOptions): Promise<RelayPassReport> {
  const now = options.now ?? new Date();
  const report: RelayPassReport = { relays: 0, delivered: 0, failed: 0, dead: 0, pulled: 0, takenBack: 0 };
  report.takenBack = await takeBackStale(now);
  const relays = await withControlPlane(async (tx) => (await tx.query<RelayRow>(
    `SELECT * FROM relays WHERE status = 'paired' AND (paused_until IS NULL OR paused_until <= $1) ORDER BY created_at`, [now])).rows);
  report.relays = relays.length;
  if (relays.length === 0) return report;

  const { identity, keys } = await signingKeys(options.master(), options.previousMasters?.() ?? [], now);
  const signing = { keys, kid: identity.kid };
  const deadline = Date.now() + PASS_BUDGET_MS;
  const pulls: Array<Promise<number>> = [];
  const queue = [...relays];
  const serve = async (): Promise<void> => {
    for (let relay = queue.shift(); relay; relay = queue.shift()) {
      if (relay.mode === 'pull' && relay.inbox_url) {
        const pull = startPull(relay, signing, now, options);
        if (pull) pulls.push(pull);
      }
      try {
        const sent = await sendDue({ id: relay.id, envelopesUrl: relay.envelopes_url }, signing, {
          now, deadline, ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        report.delivered += sent.delivered;
        report.failed += sent.failed;
        report.dead += sent.dead;
      } catch (error) {
        options.log?.({ level: 'warn', event: 'relay.send_failed', relayId: relay.id, message: (error as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RELAYS_IN_FLIGHT, relays.length) }, serve));
  if (options.awaitPulls) {
    for (const pulled of await Promise.all(pulls)) report.pulled += pulled;
  }
  return report;
}

/**
 * Starts a long poll of one relay's inbox, unless this process or another
 * already holds it. Answers the poll, which resolves to how many envelopes
 * it took, or null when it did not start.
 */
function startPull(
  relay: RelayRow,
  signing: { keys: readonly KeyObject[]; kid: string },
  now: Date,
  options: RelayPassOptions,
): Promise<number> | null {
  // A relay whose minute is full is not asked again until it has room: what
  // it answered would only be refused, and stays at the relay meanwhile.
  if (pulling.has(relay.id) || !relayHasRoom(relay.id, now)) return null;
  const pull = (async () => {
    try {
      // The lease, so replicas never poll one relay twice; taken on the row,
      // so no connection is held through the wait.
      const leased = await withControlPlane(async (tx) => (await tx.query(
        `UPDATE relays SET pulling_until = $2::timestamptz + make_interval(secs => $3)
          WHERE id = $1 AND status = 'paired' AND (pulling_until IS NULL OR pulling_until <= $2)`,
        [relay.id, now, PULL_LEASE_SECONDS])).rowCount === 1);
      if (!leased) return 0;
      try {
        return await pullOnce(relay, signing, now, options);
      } finally {
        await withControlPlane((tx) => tx.query('UPDATE relays SET pulling_until = NULL WHERE id = $1', [relay.id]));
      }
    } catch (error) {
      // Said, and tried again at the next pass: a relay's inbox that fails
      // stops nothing else.
      options.log?.({ level: 'warn', event: 'relay.pull_failed', relayId: relay.id, message: (error as Error).message });
      return 0;
    } finally {
      pulling.delete(relay.id);
    }
  })();
  pulling.set(relay.id, pull);
  return pull;
}

/**
 * One long poll: `GET <inbox>?after=<cursor>&wait=<seconds>`, signed by the
 * deployment over the request line, answered with the envelopes since the
 * cursor. Each is taken exactly as a push is, the relay's sixty a minute
 * included. The cursor is the relay's and says nothing of a single envelope,
 * so it moves only when the deployment is done with the whole answer: when the
 * minute fills, the rest stay at the relay, and the next pull names the same
 * cursor and is answered what was taken again, as repeats. Answers how many
 * envelopes the deployment is done with, taken or refused for good.
 */
async function pullOnce(
  relay: RelayRow,
  signing: { keys: readonly KeyObject[]; kid: string },
  now: Date,
  options: RelayPassOptions,
): Promise<number> {
  const wait = options.pullWaitSeconds ?? PULL_WAIT_SECONDS;
  const url = new URL(relay.inbox_url!);
  if (relay.inbound_cursor !== null) url.searchParams.set('after', relay.inbound_cursor);
  url.searchParams.set('wait', String(wait));
  const requestLine = `GET ${url.pathname}${url.search}`;
  const id = `pull_${randomUUID()}`;
  const headers = envelopeHeaders(signing.keys, signing.kid, id, requestLine, now);
  delete headers['content-type'];
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers, signal: AbortSignal.timeout((wait + 10) * 1000), redirect: 'error',
  });
  if (!response.ok) {
    await settled(response.body?.cancel());
    throw new Error(`the relay's inbox answered ${response.status}`);
  }
  let text: string;
  try {
    text = await boundedText(response, PULL_MOST_BYTES);
  } catch (error) {
    throw new Error(`the relay's inbox answered with more than any relay may send at once (${(error as Error).message}); none of it was taken`);
  }
  const answer = JSON.parse(text) as { envelopes?: unknown; cursor?: unknown };
  const envelopes = Array.isArray(answer.envelopes) ? answer.envelopes : [];
  // More than a relay may answer: taking some and moving the cursor past all
  // of them would lose the rest, and the cursor cannot name the middle.
  if (envelopes.length > PULL_MOST) {
    throw new Error(`the relay's inbox answered ${envelopes.length} envelopes, more than ${PULL_MOST} at once; none was taken`);
  }
  let done = 0;
  for (const one of envelopes) {
    const envelope = one as { id?: unknown; timestamp?: unknown; signature?: unknown; body?: unknown };
    const taken = await receiveFromRelay(relay.id, {
      id: String(envelope.id ?? ''), timestamp: String(envelope.timestamp ?? ''),
      signature: String(envelope.signature ?? ''), body: String(envelope.body ?? ''),
    }, options.now ?? new Date());
    if (taken.status === 429) return done;
    done += 1;
  }
  if (typeof answer.cursor === 'string' && answer.cursor.length <= 200) {
    await withControlPlane((tx) => tx.query('UPDATE relays SET inbound_cursor = $2 WHERE id = $1', [relay.id, answer.cursor]));
  }
  return done;
}

/**
 * The deployment's relay bookkeeping, once a day: receipts, refusals,
 * delivered envelopes and dead letters older than fourteen days; offers spent,
 * void or expired four days ago; codes nobody claimed; and the key rotated
 * out, once its week is over. It reaches every relay at once, so it skips a
 * row another transaction holds rather than wait for it: what it skips is
 * purged the next day.
 */
export async function relayBookkeeping(now = new Date()): Promise<{ receipts: number; refusals: number; outbox: number; offers: number; codes: number }> {
  const purged = await withControlPlane(async (tx) => {
    const since = `$1::timestamptz - make_interval(days => ${KEPT_DAYS})`;
    const receipts = (await tx.query(
      `DELETE FROM relay_receipts WHERE (relay_id, envelope_id) IN (
         SELECT relay_id, envelope_id FROM relay_receipts WHERE received_at < ${since} FOR UPDATE SKIP LOCKED)`, [now])).rowCount ?? 0;
    const refusals = (await tx.query(`DELETE FROM relay_refusals WHERE at < ${since}`, [now])).rowCount ?? 0;
    const outbox = (await tx.query(
      `DELETE FROM relay_outbox WHERE id IN (
         SELECT id FROM relay_outbox WHERE status IN ('delivered', 'dead') AND created_at < ${since} FOR UPDATE SKIP LOCKED)`,
      [now])).rowCount ?? 0;
    const offers = (await tx.query(
      `DELETE FROM relay_offers WHERE token_hash IN (
         SELECT token_hash FROM relay_offers
          WHERE coalesce(voided_at, CASE WHEN uses >= max_uses OR expires_at <= $1 THEN least(expires_at, $1) END)
                < $1::timestamptz - make_interval(days => $2)
            FOR UPDATE SKIP LOCKED)`, [now, SPENT_OFFER_DAYS])).rowCount ?? 0;
    const codes = (await tx.query(
      `DELETE FROM relay_links WHERE id IN (
         SELECT id FROM relay_links WHERE status = 'offered' AND code_expires_at < $1::timestamptz - interval '1 day'
            FOR UPDATE SKIP LOCKED)`, [now])).rowCount ?? 0;
    return { receipts, refusals, outbox, offers, codes };
  });
  await forgetPreviousKey(now);
  return purged;
}

/**
 * The loop itself: a pass, then another as soon as the last one is done when
 * it did something, or after a short wait when it did not, until stopped.
 */
export class RelayLoop {
  readonly #options: RelayPassOptions;
  #running: Promise<void> | null = null;
  #stopped = false;
  #wake: (() => void) | null = null;
  #keptAt = 0;

  constructor(options: RelayPassOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#running) return;
    this.#stopped = false;
    this.#running = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    await this.#running;
    this.#running = null;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      let busy = false;
      try {
        const report = await relayPass(this.#options);
        busy = report.delivered + report.failed > 0;
        if (Date.now() - this.#keptAt >= DAY_MS) {
          await relayBookkeeping();
          this.#keptAt = Date.now();
        }
      } catch (error) {
        this.#options.log?.({ level: 'warn', event: 'relay.pass_failed', message: (error as Error).message });
      }
      if (this.#stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, busy ? 0 : IDLE_MS);
        // The loop never keeps a process alive by itself: the console does.
        timer.unref();
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }
}
