/**
 * What a relay sends back (F19.20; STATUS section 2.208).
 *
 * A relay posts signed envelopes to the deployment (push), or the deployment
 * pulls them from the relay's inbox when the relay cannot reach it; both come
 * here, through the same checks in the same order:
 *
 * 1. the relay exists and is paired;
 * 2. the `v1a` signature verifies with the relay's pinned key, within five
 *    minutes of now. Nothing is written for an unknown relay or a bad
 *    signature: such an envelope is only counted, so an open route cannot be
 *    made to fill a table;
 * 3. the envelope id has not been taken before; a repeat is answered as the
 *    first was;
 * 4. the person: the link the envelope names, through a token or a
 *    pseudonym, is this relay's and active, and its company is one the relay
 *    hears about;
 * 5. the device: a link made with a device key needs the device's signature
 *    on every act, and the owner's link, without one, may only end itself;
 * 6. one closed switch on the type. A press redeems an offer made to that
 *    person for that item, once, and is checked again in full: tier 3 is
 *    refused, a seat's kind is read now, four eyes hold. It is recorded as a
 *    decision from a chat. A reply, a read mark and a mute each redeem a
 *    token a notice about a room carried to that person (STATUS section
 *    2.213), and act in that room alone, as that person: a reply is a plain
 *    message from them through the relay, only where the owner allowed
 *    replies, and never work. Nothing else -- an assignment, an
 *    instruction, a meeting, a setting, a seat, a pairing -- is a type at all.
 *
 * An answer never echoes an item's contents.
 */
import { createHash } from 'node:crypto';
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import * as inbox from '../inbox/inbox.ts';
import type { StaffKind } from '../owner/staff.ts';
import { notOpenText } from '../owner/notify.ts';
import { decidedThroughSaid, tierThreeSaid } from '../owner/people-said.ts';
import { markRead } from '../workspace/reads.ts';
import { postMessage } from '../workspace/messages.ts';
import { placeSettings } from '../workspace/rooms.ts';
import type { Viewer } from '../workspace/views.ts';
import { jcs } from './canonical.ts';
import { endLinks, claimLink } from './links.ts';
import { tokenHash } from './offers.ts';
import { countRefusal } from './outbox.ts';
import { covers, relayRow, type RelayRow } from './relays.ts';
import { fingerprint, freshTimestamp, publicKeyFrom, SIGNATURE_TOLERANCE_SECONDS, verifyV1a } from './signature.ts';
import { verify } from 'node:crypto';

/**
 * Every type a relay may send, which the protocol document describes one by
 * one. A type not here is refused (`relay.unknown_type`); within v1 one is
 * only ever added.
 */
export const INBOUND_TYPES = ['press', 'reply', 'read', 'mute', 'link_claim', 'link_end', 'ack', 'relay_key_rotated'] as const;
export type InboundType = (typeof INBOUND_TYPES)[number];

/** The largest envelope a relay may send. */
export const INBOUND_MAX_BYTES = 64 * 1024;

/** An inbound envelope as it arrived: the three signed headers and the bytes they sign. */
export interface InboundEnvelope {
  id: string;
  timestamp: string;
  signature: string;
  body: Buffer | string;
}

/** The answer: a status, and a body that never repeats an item's words. */
export interface InboundAnswer {
  status: number;
  body: Record<string, unknown>;
  /** Answered as an envelope taken before was: the relay sent it again. Not part of what the relay is answered. */
  repeat?: boolean;
  /** For a 429: how many seconds until the relay's minute has room, which the route says as `Retry-After`. */
  retryAfter?: number;
}

/**
 * How long a claim on an envelope may stay "being taken" before it is
 * thought abandoned: a replica that stopped between claiming an envelope and
 * answering it -- a deploy, a crash, an out-of-memory kill -- left it so, and
 * nothing else would settle it (STATUS section 2.216). Longer than any act
 * takes; short enough that a device's act, which lapses five minutes after
 * the person made it, can still be taken when the relay sends it again.
 */
export const ABANDONED_SECONDS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A count of requests in a sliding minute, per key, in this process: how the
 * open route is held before it reads the database, and how a relay is held
 * once its signature has verified. Bounded, so keys rotated without end
 * cannot grow it.
 */
export class MinuteThrottle {
  readonly #limit: number;
  readonly #seen = new Map<string, number[]>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Whether one more request for `key` would fit in the minute now, without counting it. */
  room(key: string, now = Date.now()): boolean {
    return (this.#seen.get(key) ?? []).filter((at) => at > now - 60_000).length < this.#limit;
  }

  /** How many whole seconds until one more request for `key` fits, as a refusal tells the sender. */
  retryAfter(key: string, now = Date.now()): number {
    const recent = (this.#seen.get(key) ?? []).filter((at) => at > now - 60_000);
    if (recent.length < this.#limit) return 0;
    return Math.max(1, Math.ceil((recent[recent.length - this.#limit]! + 60_000 - now) / 1000));
  }

  /** Whether one more request for `key` fits in the minute; counted when it does. */
  admit(key: string, now = Date.now()): boolean {
    const recent = (this.#seen.get(key) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= this.#limit) {
      this.#seen.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#seen.delete(key);
    this.#seen.set(key, recent);
    if (this.#seen.size > 10_000) this.#seen.delete(this.#seen.keys().next().value!);
    return true;
  }
}

/** One relay may send sixty envelopes a minute once its signature verifies, whichever way they come. */
const PER_RELAY = new MinuteThrottle(60);

/**
 * The keys of relays seen paired lately, by relay, read by `receiveFromRelay`
 * whenever it reads a relay's row. The open route asks it before anything
 * else, so a push a paired relay signed is not counted with the strangers'
 * (STATUS section 2.216): a stranger who fills the route's six hundred a
 * minute then locks out strangers only. It decides only which count a push
 * goes to; whether it is taken is decided against the relay's row as it is
 * now. A key not refreshed within a minute is not used.
 */
const PAIRED_KEYS = new Map<string, { keys: Buffer[]; at: number }>();
const PAIRED_KEYS_MS = 60_000;
/** Every paired relay's keys are read again at most this often, whatever is pushed meanwhile. */
const PAIRED_KEYS_READ_MS = 30_000;
let pairedKeysRead: { at: number; reading: Promise<void> | null } = { at: 0, reading: null };

/** Reads every paired relay's keys, at most once in thirty seconds for the whole process. */
async function readPairedKeys(now: number): Promise<void> {
  if (pairedKeysRead.reading) return pairedKeysRead.reading;
  if (now - pairedKeysRead.at < PAIRED_KEYS_READ_MS) return;
  const reading = (async () => {
    const { rows } = await withControlPlane((tx) => tx.query<Pick<RelayRow, 'id' | 'public_key' | 'previous_key' | 'previous_until'>>(
      `SELECT id, public_key, previous_key, previous_until FROM relays WHERE status = 'paired'`));
    for (const row of rows) PAIRED_KEYS.set(row.id, { keys: relayKeys(row, new Date(now)), at: now });
  })();
  pairedKeysRead = { at: now, reading };
  try {
    await reading;
  } finally {
    pairedKeysRead = { at: now, reading: null };
  }
}

/**
 * Whether a push was signed, now, by a relay seen paired within the minute:
 * by this process taking its envelopes, or by a read of every paired relay's
 * keys made at most twice a minute, so a relay is known even when strangers
 * keep the route full from the start.
 */
export async function signedByAPairedRelay(relayId: string, envelope: InboundEnvelope, now = Date.now()): Promise<boolean> {
  if (!UUID.test(relayId)) return false;
  let known = PAIRED_KEYS.get(relayId);
  if (!known || known.at < now - PAIRED_KEYS_MS) {
    await readPairedKeys(now);
    known = PAIRED_KEYS.get(relayId);
  }
  if (!known || known.at < now - PAIRED_KEYS_MS) return false;
  const body = typeof envelope.body === 'string' ? Buffer.from(envelope.body, 'utf8') : envelope.body;
  return /^\d{1,12}$/.test(String(envelope.timestamp ?? '')) && freshTimestamp(envelope.timestamp, now)
    && verifyV1a(String(envelope.signature ?? ''), known.keys, String(envelope.id ?? ''), envelope.timestamp, body);
}

/** The keys a relay's envelopes may be signed with now: its own, and the one it rotated away from, for its week. */
function relayKeys(relay: Pick<RelayRow, 'public_key' | 'previous_key' | 'previous_until'>, now: Date): Buffer[] {
  return relay.previous_key && relay.previous_until && relay.previous_until > now ? [relay.public_key, relay.previous_key] : [relay.public_key];
}

/**
 * Whether a relay's minute has room for one more envelope: the relay loop
 * asks before it pulls, so a relay that filled its minute is not asked again
 * for what would only be refused.
 */
export function relayHasRoom(relayId: string, now = new Date()): boolean {
  return PER_RELAY.room(relayId, now.getTime());
}

/** Why a signed envelope was refused, and what it named, for whoever records it. */
class Refusal {
  readonly status: number;
  readonly code: string;
  readonly companyId: string | null;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, companyId: string | null = null, extra: Record<string, unknown> = {}) {
    this.status = status;
    this.code = code;
    this.companyId = companyId;
    this.extra = extra;
  }
}

/**
 * Takes one envelope from a relay, pushed or pulled, through every check.
 * The relay id is the one in the push's address, or the relay being pulled.
 */
export async function receiveFromRelay(relayId: string, envelope: InboundEnvelope, now = new Date()): Promise<InboundAnswer> {
  // 1. The relay, paired. A malformed id is a stranger, and is not looked up.
  const relay = UUID.test(relayId) ? await withControlPlane((tx) => relayRow(tx, relayId)) : null;
  if (!relay || relay.status !== 'paired') {
    PAIRED_KEYS.delete(relayId);
    countRefusal('unknown_relay');
    return { status: 401, body: { ok: false, code: 'relay.unknown' } };
  }
  PAIRED_KEYS.set(relay.id, { keys: relayKeys(relay, now), at: Date.now() });
  // 2. Its signature, then its time.
  const body = typeof envelope.body === 'string' ? Buffer.from(envelope.body, 'utf8') : envelope.body;
  const id = String(envelope.id ?? '');
  if (!/^[\x21-\x7e]{1,128}$/.test(id) || body.length > INBOUND_MAX_BYTES
      || !/^\d{1,12}$/.test(String(envelope.timestamp ?? ''))
      || !verifyV1a(String(envelope.signature ?? ''), relayKeys(relay, now), id, envelope.timestamp, body)) {
    countRefusal('signature');
    return { status: 401, body: { ok: false, code: 'relay.signature' } };
  }
  if (!freshTimestamp(envelope.timestamp, now.getTime())) {
    countRefusal('stale');
    return { status: 408, body: { ok: false, code: 'relay.stale', tolerance: SIGNATURE_TOLERANCE_SECONDS, now: now.toISOString() } };
  }
  // 3. Once. A repeat is answered as the first was, before the relay's minute
  // counts it: a pull that stopped at the minute names its cursor again, and
  // what it took then must not take the room of what it did not.
  const earlier = await withControlPlane((tx) => receipt(tx, relay.id, id, now));
  if (earlier) return { ...earlier, repeat: true };
  if (!PER_RELAY.admit(relay.id, now.getTime())) {
    countRefusal('throttled');
    return { status: 429, body: { ok: false, code: 'relay.throttled' }, retryAfter: PER_RELAY.retryAfter(relay.id, now.getTime()) };
  }
  // Claimed before anything is done, so two deliveries of one envelope at
  // once do it once; the second is told what the first was, or that it is
  // still being taken. A claim abandoned by a replica that stopped is taken
  // over here, what it spent given back first.
  const claimed = await withControlPlane((tx) => claimReceipt(tx, relay.id, id, now));
  if (claimed) return { ...claimed, repeat: true };

  let answer: InboundAnswer;
  try {
    answer = await act(relay, body, { id, timestamp: String(envelope.timestamp), signature: String(envelope.signature ?? '') }, now);
  } catch (error) {
    if (!(error instanceof Refusal)) {
      // Not a refusal: something failed that the relay did not ask for. What
      // the act spent is given back and the claim goes, so the relay sending
      // the envelope again has it taken afresh rather than answered "in
      // progress" for the receipt's fortnight.
      await withControlPlane(async (tx) => {
        await relayRow(tx, relay.id, true);
        const { rows: [left] } = await tx.query<{ result: Claim }>(
          `SELECT result FROM relay_receipts WHERE relay_id = $1 AND envelope_id = $2 AND result ? 'pending' FOR UPDATE`, [relay.id, id]);
        if (left) await giveBackSpent(tx, left.result);
        await tx.query(`DELETE FROM relay_receipts WHERE relay_id = $1 AND envelope_id = $2 AND result ? 'pending'`, [relay.id, id]);
      });
      throw error;
    }
    countRefusal(error.code);
    await recordRefusal(relay, error, now);
    answer = { status: error.status, body: { ok: false, code: error.code, ...error.extra } };
  }
  await withControlPlane((tx) => tx.query(
    'UPDATE relay_receipts SET result = $3 WHERE relay_id = $1 AND envelope_id = $2', [relay.id, id, JSON.stringify(answer)]));
  return answer;
}

/**
 * A claim on an envelope still being taken: what the act spent so far, so a
 * claim abandoned by a replica that stopped gives it back before the envelope
 * is taken afresh. A press spends its token and voids the item's other
 * buttons in one transaction, and a reply, a read mark or a mute spends one
 * use of its token; each writes what it spent here in that transaction.
 */
interface Claim {
  pending: true;
  spent?: string;
  link?: string;
  item?: string | null;
  at?: string;
}

const IN_PROGRESS: InboundAnswer = { status: 409, body: { ok: false, code: 'relay.in_progress' } };

/** What an envelope taken before was answered, or that it is still being taken; null when it is new or its claim was abandoned. */
async function receipt(tx: TenantClient, relayId: string, envelopeId: string, now: Date): Promise<InboundAnswer | null> {
  const { rows: [row] } = await tx.query<{ result: InboundAnswer | Claim; received_at: Date }>(
    'SELECT result, received_at FROM relay_receipts WHERE relay_id = $1 AND envelope_id = $2', [relayId, envelopeId]);
  if (!row) return null;
  if ('status' in row.result) return row.result;
  return abandoned(row.received_at, now) ? null : IN_PROGRESS;
}

function abandoned(receivedAt: Date, now: Date): boolean {
  return receivedAt.getTime() < now.getTime() - ABANDONED_SECONDS * 1000;
}

/**
 * Claims an envelope for this process: a new receipt, pending; or one
 * another replica claimed and abandoned, taken over once what it spent is
 * given back. Answers null when this process now has it, or what the relay
 * is answered: as the envelope was answered, or that it is still being taken.
 */
async function claimReceipt(tx: TenantClient, relayId: string, envelopeId: string, now: Date): Promise<InboundAnswer | null> {
  const { rowCount } = await tx.query(
    `INSERT INTO relay_receipts (relay_id, envelope_id, received_at, result) VALUES ($1, $2, $3, '{"pending":true}')
     ON CONFLICT DO NOTHING`, [relayId, envelopeId, now]);
  if (rowCount === 1) return null;
  // Taken before. The relay's row first, as every change of its offers takes it.
  await relayRow(tx, relayId, true);
  const { rows: [row] } = await tx.query<{ result: InboundAnswer | Claim; received_at: Date }>(
    'SELECT result, received_at FROM relay_receipts WHERE relay_id = $1 AND envelope_id = $2 FOR UPDATE', [relayId, envelopeId]);
  if (!row) {
    // Purged between the two statements: new again.
    await tx.query(
      `INSERT INTO relay_receipts (relay_id, envelope_id, received_at, result) VALUES ($1, $2, $3, '{"pending":true}')`, [relayId, envelopeId, now]);
    return null;
  }
  if ('status' in row.result) return row.result;
  if (!abandoned(row.received_at, now)) return IN_PROGRESS;
  await giveBackSpent(tx, row.result);
  await tx.query(
    `UPDATE relay_receipts SET received_at = $3, result = '{"pending":true}' WHERE relay_id = $1 AND envelope_id = $2`, [relayId, envelopeId, now]);
  return null;
}

/** What an abandoned or failed act spent, given back: the token's use, and the item's other buttons it voided. The caller holds the relay's row. */
async function giveBackSpent(tx: TenantClient, claim: Claim): Promise<void> {
  if (!claim.spent) return;
  await tx.query('UPDATE relay_offers SET uses = greatest(uses - 1, 0), spent_at = NULL WHERE token_hash = $1', [claim.spent]);
  if (claim.item && claim.link && claim.at) {
    await tx.query(
      'UPDATE relay_offers SET voided_at = NULL WHERE link_id = $1 AND inbox_item_id = $2 AND voided_at = $3 AND token_hash <> $4',
      [claim.link, claim.item, claim.at, claim.spent]);
  }
}

/** Notes in an envelope's claim what its act spent, in the transaction that spent it. */
async function noteSpent(tx: TenantClient, relayId: string, envelopeId: string, claim: Omit<Claim, 'pending'>): Promise<void> {
  await tx.query(
    `UPDATE relay_receipts SET result = $3 WHERE relay_id = $1 AND envelope_id = $2 AND result ? 'pending'`,
    [relayId, envelopeId, JSON.stringify({ pending: true, ...claim })]);
}

/**
 * Claims abandoned by a replica that stopped, and never sent again: what
 * each spent is given back and the claim goes, so the person's buttons are
 * theirs again and the envelope, if the relay sends it after all, is taken
 * afresh. The relay loop runs it each pass, as it takes back stale sends.
 */
export async function takeBackAbandoned(now = new Date()): Promise<number> {
  return withControlPlane(async (tx) => {
    const { rows: relays } = await tx.query<{ relay_id: string }>(
      `SELECT DISTINCT relay_id FROM relay_receipts
        WHERE result ? 'pending' AND received_at < $1::timestamptz - make_interval(secs => $2) ORDER BY relay_id`,
      [now, ABANDONED_SECONDS]);
    let taken = 0;
    // Each relay's row before its offers, in the order of their ids, as
    // every transaction that touches more than one relay takes them.
    for (const one of relays) {
      await relayRow(tx, one.relay_id, true);
      const { rows } = await tx.query<{ envelope_id: string; result: Claim }>(
        `SELECT envelope_id, result FROM relay_receipts
          WHERE relay_id = $1 AND result ? 'pending' AND received_at < $2::timestamptz - make_interval(secs => $3)
            FOR UPDATE SKIP LOCKED`,
        [one.relay_id, now, ABANDONED_SECONDS]);
      for (const row of rows) {
        await giveBackSpent(tx, row.result);
        await tx.query('DELETE FROM relay_receipts WHERE relay_id = $1 AND envelope_id = $2', [one.relay_id, row.envelope_id]);
        taken += 1;
      }
    }
    return taken;
  });
}

/**
 * A signed refusal is kept: in the company's record when it names one, so
 * the owner sees a relay pressing at what it may not; otherwise for the
 * deployment, fourteen days.
 */
async function recordRefusal(relay: RelayRow, refusal: Refusal, now: Date): Promise<void> {
  if (refusal.companyId) {
    const companyId = refusal.companyId;
    await withTenant(companyId, (tx) => appendEvent(tx, {
      companyId, type: 'security.relay_refused', actor: 'system',
      payload: { relayId: relay.id, reason: refusal.code },
    }));
    return;
  }
  await withControlPlane((tx) => tx.query(
    'INSERT INTO relay_refusals (relay_id, reason, detail, at) VALUES ($1, $2, $3, $4)',
    [relay.id, refusal.code, JSON.stringify({ status: refusal.status }), now]));
}

interface Body {
  v?: unknown;
  type?: unknown;
  key?: unknown;
  previous?: unknown;
  token?: unknown;
  answer?: unknown;
  body?: unknown;
  clientId?: unknown;
  until?: unknown;
  code?: unknown;
  label?: unknown;
  device_key?: unknown;
  device_sig?: unknown;
  recipient?: unknown;
  at?: unknown;
}

/** The closed switch on the type. */
async function act(relay: RelayRow, raw: Buffer, signed: { id: string; timestamp: string; signature: string }, now: Date): Promise<InboundAnswer> {
  const envelopeId = signed.id;
  let body: Body;
  try {
    body = JSON.parse(raw.toString('utf8')) as Body;
  } catch {
    throw new Refusal(422, 'relay.unknown_type');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(422, 'relay.unknown_type');
  // Version 1 is the only one spoken, and a body says which it is: one that
  // names another, or none, is not read as this one (STATUS section 2.216).
  if (body.v !== 1) throw new Refusal(422, 'relay.unknown_version');
  if (typeof body.type !== 'string' || !(INBOUND_TYPES as readonly string[]).includes(body.type)) {
    throw new Refusal(422, 'relay.unknown_type');
  }
  // A character no text column keeps is refused for what it is, before
  // anything is read or spent for it: written, it would fail the write and
  // leave whatever came before half done.
  if (unkept(body)) throw new Refusal(422, 'relay.malformed');
  const type = body.type as InboundType;
  switch (type) {
    case 'press':
      return press(relay, body, envelopeId, now);
    case 'reply':
      return reply(relay, body, envelopeId, now);
    case 'read':
      return readMark(relay, body, envelopeId, now);
    case 'mute':
      return mute(relay, body, envelopeId, now);
    case 'link_claim':
      return linkClaim(relay, body, envelopeId, now);
    case 'link_end':
      return linkEnd(relay, body, envelopeId, now);
    case 'ack':
      return { status: 200, body: { ok: true } };
    case 'relay_key_rotated':
      return relayKeyRotated(relay, body, { ...signed, body: raw }, now);
    default: {
      const never: never = type;
      throw new Refusal(422, `relay.unknown_type:${String(never)}`);
    }
  }
}

/** An envelope's answer, kept in the transaction of the act it answers. */
async function settleIn(tx: TenantClient, relayId: string, envelopeId: string, answer: InboundAnswer): Promise<void> {
  await tx.query('UPDATE relay_receipts SET result = $3 WHERE relay_id = $1 AND envelope_id = $2', [relayId, envelopeId, JSON.stringify(answer)]);
}

/** Whether anything in a body, a name or a value, holds the one character PostgreSQL's text cannot: NUL. */
function unkept(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(unkept);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, one]) => key.includes('\u0000') || unkept(one));
  }
  return false;
}

interface LinkRow {
  id: string;
  relay_id: string;
  principal: string;
  company_id: string | null;
  recipient_id: string;
  device_key: Buffer | null;
  status: string;
  claimed_at: Date | null;
}

/**
 * The device form: what a device signs for an act, so the relay alone cannot
 * make one. The act's own `at` is signed, and held to the five minutes a
 * relay's signature is, so a relay cannot keep a signed act and send it
 * later; an end must be signed after the link it ends was made, so the end
 * of an earlier link made with the same key ends nothing now.
 */
function deviceSigned(
  link: LinkRow,
  relay: RelayRow,
  deployment: string,
  body: Body,
  type: string,
  extra: Record<string, unknown>,
  now: Date,
): 'ok' | 'stale' | 'bad' {
  if (!link.device_key) return 'bad';
  if (typeof body.device_sig !== 'string' || typeof body.at !== 'string') return 'bad';
  const at = Date.parse(body.at);
  if (!Number.isFinite(at)) return 'bad';
  if (type === 'link_end' && link.claimed_at !== null && at < link.claimed_at.getTime()) return 'bad';
  const fields = { deployment, relay: relay.id, recipient: link.recipient_id, type, at: body.at, ...extra };
  const signature = Buffer.from(body.device_sig, 'base64url');
  if (signature.length !== 64) return 'bad';
  if (!verify(null, Buffer.from(`palugada-device/v1\n${jcs(fields)}`, 'utf8'), publicKeyFrom(link.device_key), signature)) return 'bad';
  // Signed by the device, at a moment too far from now: told apart from a
  // forgery, so the relay can tell the person their phone's clock is wrong
  // or that the act waited too long (STATUS section 2.216).
  return Math.abs(now.getTime() - at) > SIGNATURE_TOLERANCE_SECONDS * 1000 ? 'stale' : 'ok';
}

/**
 * The device's signature on an act, checked and taken once: refused as a
 * forgery (`relay.device_sig`), as out of its moment with the deployment's
 * own time (`relay.device_stale`), or as a signature already taken under
 * another envelope (`relay.device_replayed`), so an act the device signed is
 * not done twice by a relay that sends it again under a new id. The same
 * envelope taken over after a replica stopped is no replay.
 */
async function deviceAct(
  tx: TenantClient, link: LinkRow, relay: RelayRow, body: Body, type: string, extra: Record<string, unknown>, envelopeId: string, now: Date,
  companyId: string | null,
): Promise<void> {
  const verdict = deviceSigned(link, relay, await deploymentOf(tx), body, type, extra, now);
  if (verdict === 'bad') throw new Refusal(422, 'relay.device_sig', companyId);
  if (verdict === 'stale') throw new Refusal(422, 'relay.device_stale', companyId, { now: now.toISOString(), tolerance: SIGNATURE_TOLERANCE_SECONDS });
  const hash = createHash('sha256').update(String(body.device_sig), 'utf8').digest('hex');
  await tx.query(
    `INSERT INTO relay_device_acts (relay_id, signature_hash, envelope_id, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [relay.id, hash, envelopeId, now]);
  const { rows: [taken] } = await tx.query<{ envelope_id: string }>(
    'SELECT envelope_id FROM relay_device_acts WHERE relay_id = $1 AND signature_hash = $2', [relay.id, hash]);
  if (taken && taken.envelope_id !== envelopeId) throw new Refusal(422, 'relay.device_replayed', companyId);
}

async function deploymentOf(tx: TenantClient): Promise<string> {
  const { rows: [control] } = await tx.query<{ deployment: string }>('SELECT deployment_id::text AS deployment FROM platform_control');
  return control!.deployment;
}

/**
 * A press: one of the person's offers, redeemed once, and the decision made
 * through the inbox as a chat makes it, by the person the offer was made to.
 */
async function press(relay: RelayRow, body: Body, envelopeId: string, now: Date): Promise<InboundAnswer> {
  if (!relay.may_press) throw new Refusal(422, 'relay.press_off');
  if (typeof body.token !== 'string' || body.token.length > 200) throw new Refusal(422, 'relay.press_unknown');
  const answerText = typeof body.answer === 'string' ? body.answer : null;
  // Longer than any answer is taken: the body is malformed, whatever its token.
  if (answerText !== null && answerText.length > 2000) throw new Refusal(422, 'relay.malformed');

  const hash = tokenHash(body.token as string);
  const redeemed = await withControlPlane(async (tx) => {
    // The relay's row first, as every change of its offers takes it.
    await relayRow(tx, relay.id, true);
    const { rows: [offer] } = await tx.query<{
      link_id: string; company_id: string; principal: string; act: string; inbox_item_id: string | null;
      option: string | null; uses: number; max_uses: number; expires_at: Date; voided_at: Date | null;
    }>('SELECT * FROM relay_offers WHERE token_hash = $1 AND relay_id = $2 FOR UPDATE', [hash, relay.id]);
    if (!offer) throw new Refusal(422, 'relay.press_unknown');
    const { rows: [link] } = await tx.query<LinkRow>('SELECT * FROM relay_links WHERE id = $1', [offer.link_id]);
    if (!link || link.relay_id !== relay.id || link.status !== 'active') throw new Refusal(410, 'relay.link_ended', offer.company_id);
    if (!covers(relay, offer.company_id) || (link.company_id !== null && link.company_id !== offer.company_id)) {
      throw new Refusal(422, 'relay.not_member', offer.company_id);
    }
    if (link.device_key) {
      const fields = { token: body.token, ...(answerText !== null ? { sha256: createHash('sha256').update(answerText, 'utf8').digest('hex') } : {}) };
      await deviceAct(tx, link, relay, body, 'press', fields, envelopeId, now, offer.company_id);
    } else if (link.principal === 'owner') {
      throw new Refusal(422, 'relay.owner_device', offer.company_id);
    }
    if (!['approve', 'deny', 'answer'].includes(offer.act) || !offer.inbox_item_id) throw new Refusal(422, 'relay.press_unknown', offer.company_id);
    if (offer.voided_at || offer.uses >= offer.max_uses || offer.expires_at <= now) throw new Refusal(422, 'relay.press_spent', offer.company_id);
    // An answer with no words, to a question with no choice on this button, answers nothing.
    if (offer.act === 'answer' && !(offer.option ?? answerText ?? '').trim()) throw new Refusal(422, 'relay.press_unknown', offer.company_id);
    // Spent before the decision is tried: a press the inbox refuses after
    // this is not a token left to be tried again.
    await tx.query(
      'UPDATE relay_offers SET uses = uses + 1, spent_at = CASE WHEN uses + 1 >= max_uses THEN $2::timestamptz END WHERE token_hash = $1',
      [hash, now]);
    // The other buttons for the same item to the same person go with it.
    await tx.query(
      `UPDATE relay_offers SET voided_at = $3 WHERE link_id = $1 AND inbox_item_id = $2 AND voided_at IS NULL AND token_hash <> $4`,
      [link.id, offer.inbox_item_id, now, hash]);
    // Noted in the envelope's claim, so a replica that stops before the
    // decision leaves both to be given back (STATUS section 2.216).
    await noteSpent(tx, relay.id, envelopeId, { spent: hash, link: link.id, item: offer.inbox_item_id, at: now.toISOString() });
    let seat: inbox.SeatActor | null = null;
    if (link.principal !== 'owner') {
      // The seat as it is now, not as it was when the offer was made: an
      // approver made a viewer, or revoked, presses nothing.
      const { rows: [row] } = await tx.query<{ id: string; name: string; kind: StaffKind }>(
        `SELECT id, name, kind FROM staff_seats
          WHERE id = $1 AND company_id = $2 AND joined_at IS NOT NULL AND revoked_at IS NULL`,
        [link.principal.slice('seat:'.length), offer.company_id]);
      if (!row) throw new Refusal(422, 'relay.not_member', offer.company_id);
      const may = offer.act === 'answer' ? row.kind === 'member' || row.kind === 'approver' : row.kind === 'approver';
      if (!may) throw new Refusal(422, 'relay.seat_changed', offer.company_id);
      seat = { id: row.id, name: row.name, kind: row.kind };
    }
    // The person's own language, where they chose one, for what the relay is answered.
    const { rows: [control] } = await tx.query<{ language: string | null }>(
      `SELECT coalesce((SELECT language FROM principal_prefs WHERE principal = $1), console_language) AS language FROM platform_control`,
      [link.principal]);
    return { offer, seat, language: control!.language };
  });

  const { offer, seat, language } = redeemed;
  const companyId = offer.company_id;
  const itemId = offer.inbox_item_id!;
  try {
    const { rows: [item] } = await withTenant(companyId, (tx) => tx.query<{ tier: number | null; kind: string }>(
      'SELECT tier, kind FROM inbox_items WHERE id = $1', [itemId]));
    if (item && (item.tier ?? 0) >= 3) throw new Refusal(422, 'relay.press_tier3', companyId, { text: tierThreeSaid(language, relay.name) });
    if (offer.act === 'answer') {
      await inbox.answerEscalation(companyId, itemId, (offer.option ?? answerText)!, { channel: 'chat', seat, via: 'relay' });
    } else {
      await inbox.decide(companyId, itemId, offer.act as 'approve' | 'deny', '', { channel: 'chat', seat, via: 'relay' });
    }
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (error instanceof PalugadaError) {
      if (error.code === 'inbox.not_open') {
        // Said in the person's language, and nothing of the item but how it closed.
        return { status: 409, body: { ok: false, code: 'inbox.not_open', text: notOpenText(language, error) } };
      }
      if (error.code === 'approval.channel_forbidden') throw new Refusal(422, 'relay.press_tier3', companyId, { text: tierThreeSaid(language, relay.name) });
      throw new Refusal(422, error.code, companyId);
    }
    // Nothing decided, for a reason that is no answer to the press: the
    // token, and the buttons it voided, are the person's again, given back
    // from the claim as `receiveFromRelay` forgets it.
    throw error;
  }
  return { status: 200, body: { ok: true, result: { act: offer.act }, text: decidedThroughSaid(language, relay.name) } };
}

interface RoomOfferRow {
  link_id: string;
  company_id: string;
  principal: string;
  act: string;
  room_id: string;
  thread_of: string | null;
  position: string;
  uses: number;
  max_uses: number;
  expires_at: Date;
  voided_at: Date | null;
}

/** The longest reply a phone may send. */
export const REPLY_MAX = 4_000;
/** The furthest ahead a mute from a phone may reach. */
const MUTE_MAX_DAYS = 30;

/**
 * A token a notice about a room carried, redeemed once more: this relay's,
 * for this act, its link active, signed by the person's device when the
 * link has one (and the owner's link counts for nothing without one), not
 * spent, void or past its days; and the person read again as they are now.
 * Answers the token and the person to act as, with the relay named as where
 * their words came from.
 */
async function redeemRoomOffer(
  relay: RelayRow, body: Body, act: 'reply' | 'read' | 'mute', signed: Record<string, unknown>, envelopeId: string, now: Date,
  check?: (tx: TenantClient, offer: RoomOfferRow) => Promise<void>,
): Promise<{ offer: RoomOfferRow; viewer: Viewer }> {
  if (typeof body.token !== 'string' || body.token.length > 200) throw new Refusal(422, 'relay.press_unknown');
  const token = body.token;
  const hash = tokenHash(token);
  return withControlPlane(async (tx) => {
    // The relay's row first, as every change of its offers takes it.
    await relayRow(tx, relay.id, true);
    const { rows: [offer] } = await tx.query<RoomOfferRow>(
      `SELECT link_id, company_id, principal, act, room_id, thread_of, position, uses, max_uses, expires_at, voided_at
         FROM relay_offers WHERE token_hash = $1 AND relay_id = $2 FOR UPDATE`, [hash, relay.id]);
    // A token for another act is no token for this one: a read mark's never writes.
    if (!offer || offer.act !== act || offer.room_id === null) throw new Refusal(422, 'relay.press_unknown', offer?.company_id ?? null);
    const { rows: [link] } = await tx.query<LinkRow>('SELECT * FROM relay_links WHERE id = $1', [offer.link_id]);
    if (!link || link.relay_id !== relay.id || link.status !== 'active') throw new Refusal(410, 'relay.link_ended', offer.company_id);
    if (!covers(relay, offer.company_id) || (link.company_id !== null && link.company_id !== offer.company_id)) {
      throw new Refusal(422, 'relay.not_member', offer.company_id);
    }
    if (link.device_key) {
      await deviceAct(tx, link, relay, body, act, { token, ...signed }, envelopeId, now, offer.company_id);
    } else if (link.principal === 'owner') {
      throw new Refusal(422, 'relay.owner_device', offer.company_id);
    }
    if (offer.voided_at || offer.uses >= offer.max_uses || offer.expires_at <= now) throw new Refusal(422, 'relay.press_spent', offer.company_id);
    if (check) await check(tx, offer);
    await tx.query(
      'UPDATE relay_offers SET uses = uses + 1, spent_at = CASE WHEN uses + 1 >= max_uses THEN $2::timestamptz END WHERE token_hash = $1',
      [hash, now]);
    await noteSpent(tx, relay.id, envelopeId, { spent: hash });
    // The person as they are now: a seat ended since the notice acts as nobody.
    let person: Viewer['person'] = { principal: 'owner', name: null };
    let kind: Viewer['kind'] = 'owner';
    let seatId: string | null = null;
    if (link.principal !== 'owner') {
      const { rows: [row] } = await tx.query<{ id: string; name: string; kind: StaffKind }>(
        `SELECT id, name, kind FROM staff_seats
          WHERE id = $1 AND company_id = $2 AND joined_at IS NOT NULL AND revoked_at IS NULL`,
        [link.principal.slice('seat:'.length), offer.company_id]);
      if (!row) throw new Refusal(422, 'relay.not_member', offer.company_id);
      person = { principal: link.principal, name: row.name };
      kind = row.kind;
      seatId = row.id;
    }
    return { offer, viewer: { companyId: offer.company_id, person, kind, seatId, relayId: relay.id } };
  });
}

/** What the rooms refuse, said back as the relay's refusal, in the company that refused it. */
async function asThePerson<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PalugadaError) throw new Refusal(422, error.code, companyId);
    throw error;
  }
}

/**
 * A reply from a phone: a plain message by that person, in the room and
 * thread the notice named and no other, recorded as come through this relay.
 * Only where the owner allowed replies through it. It is never work: words
 * from a relay are outside words to every door (STATUS section 2.206), and a
 * reply in a thread is not given as work at all.
 */
async function reply(relay: RelayRow, body: Body, envelopeId: string, now: Date): Promise<InboundAnswer> {
  if (!relay.may_post) throw new Refusal(422, 'relay.post_off');
  const text = body.body;
  const clientId = body.clientId;
  if (typeof text !== 'string' || text.trim().length < 1 || text.length > REPLY_MAX
      || typeof clientId !== 'string' || clientId.length < 1 || clientId.length > 64) {
    throw new Refusal(422, 'relay.malformed');
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const { offer, viewer } = await redeemRoomOffer(relay, body, 'reply', { sha256, clientId }, envelopeId, now, async (tx, offer) => {
    // A client id is the person's for all time (STATUS section 2.216): one
    // they used before is a retry only of the same words to the same room
    // and thread. Anything else is refused rather than answered with the
    // earlier message, which would tell the phone its words landed. Words
    // edited or deleted since cannot be compared, and the place is enough.
    const { rows: [used] } = await tx.query<{ room_id: string; thread_of: string | null; body: string | null; changed: boolean }>(
      `SELECT room_id, thread_of, body, (edited_at IS NOT NULL OR deleted_at IS NOT NULL) AS changed
         FROM room_messages WHERE company_id = $1 AND author = $2 AND client_id = $3`,
      [offer.company_id, offer.principal, clientId]);
    if (used && (used.room_id !== offer.room_id || used.thread_of !== offer.thread_of || (!used.changed && used.body !== text))) {
      throw new Refusal(422, 'relay.client_id_used', offer.company_id);
    }
  });
  await asThePerson(offer.company_id, () => postMessage(viewer, offer.room_id, { body: text, clientId, threadOf: offer.thread_of }));
  // Answered with the relay's own client id, never the message's: a
  // message's id is a thread's once someone answers it there, and no id of
  // PALUGADA's reaches a relay (STATUS section 2.216).
  return { status: 200, body: { ok: true, result: { clientId } } };
}

/**
 * A read mark from a phone, to where the notice was: what the person's other
 * devices read their badge from moves with it, as if they had read it here.
 */
async function readMark(relay: RelayRow, body: Body, envelopeId: string, now: Date): Promise<InboundAnswer> {
  const { offer, viewer } = await redeemRoomOffer(relay, body, 'read', {}, envelopeId, now);
  const marked = await asThePerson(offer.company_id, () => markRead(viewer, offer.room_id, { position: Number(offer.position), threadOf: offer.thread_of }));
  return { status: 200, body: { ok: true, result: { readPosition: marked.readPosition } } };
}

/** A room muted from a phone until a time within thirty days, or heard again with `null`. */
async function mute(relay: RelayRow, body: Body, envelopeId: string, now: Date): Promise<InboundAnswer> {
  const until = body.until;
  if (until !== null && (typeof until !== 'string' || !Number.isFinite(Date.parse(until))
      || Date.parse(until) > now.getTime() + MUTE_MAX_DAYS * 86_400_000)) {
    throw new Refusal(422, 'relay.malformed');
  }
  const { offer, viewer } = await redeemRoomOffer(relay, body, 'mute', { until }, envelopeId, now);
  const place = await asThePerson(offer.company_id, () => placeSettings(viewer, offer.room_id, { mutedUntil: until }));
  return { status: 200, body: { ok: true, result: { mutedUntil: place.mutedUntil } } };
}

/**
 * A link code entered in the relay's app: the link becomes active, with the
 * device's key when it gave one. A code offered through another relay, or
 * spent, or past its ten minutes, is no code here.
 */
async function linkClaim(relay: RelayRow, body: Body, envelopeId: string, now: Date): Promise<InboundAnswer> {
  if (typeof body.code !== 'string') throw new Refusal(422, 'relay.link_unknown');
  let deviceKey: Buffer | null = null;
  if (body.device_key !== undefined && body.device_key !== null) {
    deviceKey = typeof body.device_key === 'string' ? Buffer.from(body.device_key, 'base64url') : Buffer.alloc(0);
    if (deviceKey.length !== 32) throw new Refusal(422, 'relay.device_sig');
  }
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;
  // The confirmation names the claim's own envelope, so the relay knows which device it is for.
  return withControlPlane(async (tx) => {
    const claimed = await claimLink(tx, relay, { code: body.code as string, label, deviceKey, claimId: envelopeId }, now);
    if (!claimed) throw new Refusal(422, 'relay.link_unknown');
    // Settled in the transaction that made the link, so a replica that stops
    // after it leaves nothing half done (STATUS section 2.216).
    const answer: InboundAnswer = { status: 200, body: { ok: true, result: { recipient: claimed.recipient, companies: claimed.companies } } };
    await settleIn(tx, relay.id, envelopeId, answer);
    return answer;
  });
}

/** The relay, for the person, ends their link: signed by the device when the link has one. */
async function linkEnd(relay: RelayRow, body: Body, envelopeId: string, now: Date): Promise<InboundAnswer> {
  if (typeof body.recipient !== 'string') throw new Refusal(410, 'relay.link_ended');
  return withControlPlane(async (tx) => {
    // The relay's row before the link, as every change of its links takes it.
    await relayRow(tx, relay.id, true);
    const { rows: [link] } = await tx.query<LinkRow>(
      `SELECT * FROM relay_links WHERE relay_id = $1 AND recipient_id = $2 AND status = 'active' FOR UPDATE`, [relay.id, body.recipient]);
    if (!link) throw new Refusal(410, 'relay.link_ended');
    if (link.device_key) await deviceAct(tx, link, relay, body, 'link_end', {}, envelopeId, now, link.company_id);
    await endLinks(tx, [link.id], now, 'relay');
    // Settled in the transaction that ended the link, so a replica that
    // stops after it leaves nothing half done (STATUS section 2.216).
    const answer: InboundAnswer = { status: 200, body: { ok: true } };
    await settleIn(tx, relay.id, envelopeId, answer);
    return answer;
  });
}

/** How long a relay's key rotated away from is taken beside the new one, at most. */
const RELAY_PREVIOUS_KEY_DAYS = 7;

/**
 * A relay's own new key (STATUS section 2.216), as the deployment announces
 * its own: in an envelope both the key PALUGADA pinned now and the new key
 * sign, naming the pinned key as `previous`. Signed by the old key alone it
 * is refused, or whoever stole that key could announce one of their own and
 * be pinned for good; and a key that was rotated away from, still in its
 * week, cannot rotate. The old key is taken beside the new one until the
 * `until` the relay names, never more than a week on.
 */
async function relayKeyRotated(
  relay: RelayRow, body: Body, signed: { id: string; timestamp: string; signature: string; body: Buffer }, now: Date,
): Promise<InboundAnswer> {
  const next = typeof body.key === 'string' ? Buffer.from(body.key, 'base64url') : Buffer.alloc(0);
  const previous = (body.previous ?? null) as { key?: unknown; until?: unknown } | null;
  const until = typeof previous?.until === 'string' ? Date.parse(previous.until) : Number.NaN;
  if (next.length !== 32 || !Number.isFinite(until)) throw new Refusal(422, 'relay.malformed');
  if (previous?.key !== relay.public_key.toString('base64url') || next.equals(relay.public_key)
      || !verifyV1a(signed.signature, [relay.public_key], signed.id, signed.timestamp, signed.body)
      || !verifyV1a(signed.signature, [next], signed.id, signed.timestamp, signed.body)) {
    throw new Refusal(422, 'relay.key_unproven');
  }
  const keptUntil = new Date(Math.max(now.getTime(), Math.min(until, now.getTime() + RELAY_PREVIOUS_KEY_DAYS * 86_400_000)));
  return withControlPlane(async (tx) => {
    const held = await relayRow(tx, relay.id, true);
    if (!held || held.status !== 'paired' || !held.public_key.equals(relay.public_key)) throw new Refusal(422, 'relay.key_unproven');
    const { rows: taken } = await tx.query(`SELECT 1 FROM relays WHERE public_key = $1 AND status <> 'revoked' AND id <> $2`, [next, relay.id]);
    if (taken.length > 0) throw new Refusal(422, 'relay.key_unproven');
    await tx.query(
      `UPDATE relays SET previous_key = public_key, previous_until = $2, public_key = $3, fingerprint = $4 WHERE id = $1`,
      [relay.id, keptUntil, next, fingerprint(next)]);
    PAIRED_KEYS.delete(relay.id);
    const answer: InboundAnswer = { status: 200, body: { ok: true, result: { fingerprint: fingerprint(next), until: keptUntil.toISOString() } } };
    await settleIn(tx, relay.id, signed.id, answer);
    return answer;
  });
}
