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
import { receiveFromRelay, relayHasRoom, takeBackAbandoned, type InboundAnswer } from './inbound.ts';
import { answerPulled, sendDue, takeBackStale } from './outbox.ts';
import { boundedText, settled, type RelayRow } from './relays.ts';

/** How long one pass may spend sending. */
export const PASS_BUDGET_MS = 20_000;
/** Relays served at once. */
export const RELAYS_IN_FLIGHT = 4;
/** How long the deployment's long poll asks a relay to hold the answer. */
export const PULL_WAIT_SECONDS = 25;
/**
 * How long a lease to pull one relay lasts past the moment it is taken or
 * renewed: the long poll's wait, its ten seconds' margin, and time to take
 * what it answered. It is renewed once the answer is in and as the answer is
 * taken, and only the process that holds it moves the cursor.
 */
const PULL_LEASE_SECONDS = PULL_WAIT_SECONDS + 40;
/** How many envelopes of one answer are taken between two renewals of the lease. */
const LEASE_EVERY = 20;
/** The most envelopes a relay may answer one pull with (docs/relay-protocol.md, section 9). */
const PULL_MOST = 100;
/**
 * The most bytes of one pull's answer that are read: a hundred envelopes of
 * the few hundred bytes an act is, with room to spare, and well short of what
 * a relay streaming without end could make the deployment hold.
 */
const PULL_MOST_BYTES = 8 * 1024 * 1024;
/**
 * How long an offer spent, void or past its time is kept, so a late press is
 * told why rather than that it is unknown: counted from when it was spent,
 * voided or expired, whichever was first. An offer spent before its spending
 * was kept (STATUS section 2.216) counts from its expiry.
 */
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
  // What a replica that stopped left half taken is given back (STATUS section 2.216).
  await takeBackAbandoned(now);
  const relays = await withControlPlane(async (tx) => (await tx.query<RelayRow>(
    `SELECT * FROM relays WHERE status = 'paired' AND (paused_until IS NULL OR paused_until <= $1) ORDER BY created_at`, [now])).rows);
  report.relays = relays.length;
  if (relays.length === 0) return report;

  const { identity, keys, rotation } = await signingKeys(options.master(), options.previousMasters?.() ?? [], now);
  const signing = { keys, kid: identity.kid, rotation };
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
      // so no connection is held through the wait. It is this process's by
      // a holder id of its own and runs from when the pull starts, on the
      // clock, not from the pass's moment: a poll that outlives it cannot
      // release a lease another replica took since, nor move the cursor
      // (STATUS section 2.216).
      const holder = randomUUID();
      const leased = await withControlPlane(async (tx) => (await tx.query(
        `UPDATE relays SET pulling_until = $2::timestamptz + make_interval(secs => $3), pulling_by = $4
          WHERE id = $1 AND status = 'paired' AND (pulling_until IS NULL OR pulling_until <= $2)`,
        [relay.id, new Date(), PULL_LEASE_SECONDS, holder])).rowCount === 1);
      if (!leased) return 0;
      try {
        return await pullOnce(relay, signing, now, options, holder);
      } finally {
        await withControlPlane((tx) => tx.query(
          'UPDATE relays SET pulling_until = NULL, pulling_by = NULL WHERE id = $1 AND pulling_by = $2', [relay.id, holder]));
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

/** Renews this process's lease on a relay's pull; answers whether it still holds it. */
async function renewLease(relayId: string, holder: string): Promise<boolean> {
  return withControlPlane(async (tx) => (await tx.query(
    `UPDATE relays SET pulling_until = $3::timestamptz + make_interval(secs => $4) WHERE id = $1 AND pulling_by = $2`,
    [relayId, holder, new Date(), PULL_LEASE_SECONDS])).rowCount === 1);
}

/**
 * Whether the deployment is done with an envelope it pulled: taken, or
 * refused for good. Not when the relay's minute is full, nor while the same
 * envelope is still being taken by another replica: the cursor then stays,
 * and the next pull names it again (STATUS section 2.216).
 */
function doneWith(answer: InboundAnswer): boolean {
  return answer.status !== 429 && !(answer.status === 409 && answer.body.code === 'relay.in_progress');
}

/**
 * One long poll: `GET <inbox>?after=<cursor>&wait=<seconds>`, signed by the
 * deployment over the request line and the relay it is for, answered with
 * the envelopes since the cursor. Each is taken exactly as a push is, the
 * relay's sixty a minute included, and what it was answered is sent back to
 * the relay as an `act_result`, as a push learns it from its answer. The
 * cursor is the relay's and says nothing of a single envelope, so it moves
 * only when the deployment is done with the whole answer: when the minute
 * fills, or an envelope is still being taken elsewhere, the rest stay at the
 * relay, and the next pull names the same cursor and is answered what was
 * taken again, as repeats. Only the process that holds the lease moves it.
 * Answers how many envelopes the deployment is done with.
 */
async function pullOnce(
  relay: RelayRow,
  signing: { keys: readonly KeyObject[]; kid: string },
  now: Date,
  options: RelayPassOptions,
  holder: string,
): Promise<number> {
  const wait = options.pullWaitSeconds ?? PULL_WAIT_SECONDS;
  const url = new URL(relay.inbox_url!);
  if (relay.inbound_cursor !== null) url.searchParams.set('after', relay.inbound_cursor);
  url.searchParams.set('wait', String(wait));
  // The relay it is for is signed too, so a pull one paired relay is sent
  // cannot be replayed at another to read its inbox (STATUS section 2.216).
  const requestLine = `GET ${url.pathname}${url.search}\n${relay.id}`;
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
  // The answer is in: taken only while this process still holds the lease.
  if (!await renewLease(relay.id, holder)) return 0;
  let done = 0;
  for (const one of envelopes) {
    if (done > 0 && done % LEASE_EVERY === 0 && !await renewLease(relay.id, holder)) return done;
    const envelope = one as { id?: unknown; timestamp?: unknown; signature?: unknown; body?: unknown };
    const id = String(envelope.id ?? '');
    const taken = await receiveFromRelay(relay.id, {
      id, timestamp: String(envelope.timestamp ?? ''), signature: String(envelope.signature ?? ''), body: String(envelope.body ?? ''),
    }, options.now ?? new Date());
    if (!doneWith(taken)) return done;
    // A relay that pulls learns what it was answered as a push does. Nothing
    // is written for an envelope its relay did not sign, as for a push.
    if (taken.status !== 401) await answerPulled(relay.id, id, taken, options.now ?? new Date());
    done += 1;
  }
  if (typeof answer.cursor === 'string' && answer.cursor.length <= 200) {
    await withControlPlane((tx) => tx.query(
      'UPDATE relays SET inbound_cursor = $2 WHERE id = $1 AND pulling_by = $3', [relay.id, answer.cursor, holder]));
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
          WHERE least(voided_at, spent_at, CASE WHEN uses >= max_uses OR expires_at <= $1 THEN expires_at END)
                < $1::timestamptz - make_interval(days => $2)
            FOR UPDATE SKIP LOCKED)`, [now, SPENT_OFFER_DAYS])).rowCount ?? 0;
    // A device's signature is refused once its moment is over anyway: kept a day, for a replay to meet.
    await tx.query(`DELETE FROM relay_device_acts WHERE at < $1::timestamptz - interval '1 day'`, [now]);
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
