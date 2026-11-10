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
 *    decision from a chat. Replies, read marks and mutes are known types and
 *    refused until people's notices turn them on (STATUS section 2.213).
 *    Nothing else -- an assignment, an instruction, a meeting, a setting, a
 *    seat, a pairing -- is a type at all.
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
import { jcs } from './canonical.ts';
import { endLinks, claimLink } from './links.ts';
import { tokenHash } from './offers.ts';
import { countRefusal } from './outbox.ts';
import { covers, relayRow, type RelayRow } from './relays.ts';
import { freshTimestamp, publicKeyFrom, SIGNATURE_TOLERANCE_SECONDS, verifyV1a } from './signature.ts';
import { verify } from 'node:crypto';

/**
 * Every type a relay may send, which the protocol document describes one by
 * one. A type not here is refused (`relay.unknown_type`); within v1 one is
 * only ever added.
 */
export const INBOUND_TYPES = ['press', 'reply', 'read', 'mute', 'link_claim', 'link_end', 'ack'] as const;
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
}

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
    countRefusal('unknown_relay');
    return { status: 401, body: { ok: false, code: 'relay.unknown' } };
  }
  // 2. Its signature, then its time.
  const body = typeof envelope.body === 'string' ? Buffer.from(envelope.body, 'utf8') : envelope.body;
  const id = String(envelope.id ?? '');
  if (id.length < 1 || id.length > 128 || body.length > INBOUND_MAX_BYTES
      || !/^\d{1,12}$/.test(String(envelope.timestamp ?? ''))
      || !verifyV1a(String(envelope.signature ?? ''), [relay.public_key], id, envelope.timestamp, body)) {
    countRefusal('signature');
    return { status: 401, body: { ok: false, code: 'relay.signature' } };
  }
  if (!freshTimestamp(envelope.timestamp, now.getTime())) {
    countRefusal('stale');
    return { status: 408, body: { ok: false, code: 'relay.stale', tolerance: SIGNATURE_TOLERANCE_SECONDS } };
  }
  // 3. Once. A repeat is answered as the first was, before the relay's minute
  // counts it: a pull that stopped at the minute names its cursor again, and
  // what it took then must not take the room of what it did not.
  const earlier = await withControlPlane((tx) => receipt(tx, relay.id, id));
  if (earlier) return earlier;
  if (!PER_RELAY.admit(relay.id, now.getTime())) {
    countRefusal('throttled');
    return { status: 429, body: { ok: false, code: 'relay.throttled' } };
  }
  // Claimed before anything is done, so two deliveries of one envelope at
  // once do it once; the second is told what the first was.
  const claimed = await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO relay_receipts (relay_id, envelope_id, received_at, result) VALUES ($1, $2, $3, '{"pending":true}')
       ON CONFLICT DO NOTHING`, [relay.id, id, now]);
    return rowCount === 1 ? null : receipt(tx, relay.id, id);
  });
  if (claimed) return claimed;

  let answer: InboundAnswer;
  try {
    answer = await act(relay, body, id, now);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    countRefusal(error.code);
    await recordRefusal(relay, error, now);
    answer = { status: error.status, body: { ok: false, code: error.code, ...error.extra } };
  }
  await withControlPlane((tx) => tx.query(
    'UPDATE relay_receipts SET result = $3 WHERE relay_id = $1 AND envelope_id = $2', [relay.id, id, JSON.stringify(answer)]));
  return answer;
}

/** What an envelope taken before was answered, or that it is still being taken; null when it is new. */
async function receipt(tx: TenantClient, relayId: string, envelopeId: string): Promise<InboundAnswer | null> {
  const { rows: [row] } = await tx.query<{ result: InboundAnswer | { pending: true } }>(
    'SELECT result FROM relay_receipts WHERE relay_id = $1 AND envelope_id = $2', [relayId, envelopeId]);
  if (!row) return null;
  return 'status' in row.result ? row.result : { status: 409, body: { ok: false, code: 'relay.in_progress' } };
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
  type?: unknown;
  token?: unknown;
  answer?: unknown;
  code?: unknown;
  label?: unknown;
  device_key?: unknown;
  device_sig?: unknown;
  recipient?: unknown;
  at?: unknown;
}

/** The closed switch on the type. */
async function act(relay: RelayRow, raw: Buffer, envelopeId: string, now: Date): Promise<InboundAnswer> {
  let body: Body;
  try {
    body = JSON.parse(raw.toString('utf8')) as Body;
  } catch {
    throw new Refusal(422, 'relay.unknown_type');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string'
      || !(INBOUND_TYPES as readonly string[]).includes(body.type)) {
    throw new Refusal(422, 'relay.unknown_type');
  }
  const type = body.type as InboundType;
  switch (type) {
    case 'press':
      return press(relay, body, now);
    case 'reply':
    case 'read':
    case 'mute':
      // Known, described, and off: they write in a room as the person, which
      // only people's notices offer (STATUS section 2.213). The owner's link
      // without a device key would be refused for its own reason first.
      await refuseOwnerWithoutDevice(relay, body);
      throw new Refusal(422, 'relay.post_off');
    case 'link_claim':
      return linkClaim(relay, body, envelopeId, now);
    case 'link_end':
      return linkEnd(relay, body, now);
    case 'ack':
      return { status: 200, body: { ok: true } };
    default: {
      const never: never = type;
      throw new Refusal(422, `relay.unknown_type:${String(never)}`);
    }
  }
}

interface LinkRow {
  id: string;
  relay_id: string;
  principal: string;
  company_id: string | null;
  recipient_id: string;
  device_key: Buffer | null;
  status: string;
}

/** The device form: what a device signs for an act, so the relay alone cannot make one. */
function deviceSigned(
  link: LinkRow,
  relay: RelayRow,
  deployment: string,
  body: Body,
  type: string,
  extra: Record<string, unknown>,
): boolean {
  if (!link.device_key) return false;
  if (typeof body.device_sig !== 'string' || typeof body.at !== 'string') return false;
  const fields = { deployment, relay: relay.id, recipient: link.recipient_id, type, at: body.at, ...extra };
  const signature = Buffer.from(body.device_sig, 'base64url');
  if (signature.length !== 64) return false;
  return verify(null, Buffer.from(`palugada-device/v1\n${jcs(fields)}`, 'utf8'), publicKeyFrom(link.device_key), signature);
}

async function deploymentOf(tx: TenantClient): Promise<string> {
  const { rows: [control] } = await tx.query<{ deployment: string }>('SELECT deployment_id::text AS deployment FROM platform_control');
  return control!.deployment;
}

/** An act from the owner's link that has no device key counts for nothing; ending the link is not an act. */
async function refuseOwnerWithoutDevice(relay: RelayRow, body: Body): Promise<void> {
  if (typeof body.token !== 'string') return;
  const link = await withControlPlane(async (tx) => (await tx.query<LinkRow>(
    `SELECT l.* FROM relay_offers o JOIN relay_links l ON l.id = o.link_id WHERE o.token_hash = $1 AND o.relay_id = $2`,
    [tokenHash(body.token as string), relay.id])).rows[0] ?? null);
  if (link?.principal === 'owner' && !link.device_key) throw new Refusal(422, 'relay.owner_device');
}

/**
 * A press: one of the person's offers, redeemed once, and the decision made
 * through the inbox as a chat makes it, by the person the offer was made to.
 */
async function press(relay: RelayRow, body: Body, now: Date): Promise<InboundAnswer> {
  if (!relay.may_press) throw new Refusal(422, 'relay.press_off');
  if (typeof body.token !== 'string' || body.token.length > 200) throw new Refusal(422, 'relay.press_unknown');
  const answerText = typeof body.answer === 'string' ? body.answer : null;
  if (answerText !== null && answerText.length > 2000) throw new Refusal(422, 'relay.press_unknown');

  const redeemed = await withControlPlane(async (tx) => {
    const { rows: [offer] } = await tx.query<{
      link_id: string; company_id: string; principal: string; act: string; inbox_item_id: string | null;
      option: string | null; uses: number; max_uses: number; expires_at: Date; voided_at: Date | null;
    }>('SELECT * FROM relay_offers WHERE token_hash = $1 AND relay_id = $2 FOR UPDATE', [tokenHash(body.token as string), relay.id]);
    if (!offer) throw new Refusal(422, 'relay.press_unknown');
    const { rows: [link] } = await tx.query<LinkRow>('SELECT * FROM relay_links WHERE id = $1', [offer.link_id]);
    if (!link || link.relay_id !== relay.id || link.status !== 'active') throw new Refusal(410, 'relay.link_ended', offer.company_id);
    if (!covers(relay, offer.company_id) || (link.company_id !== null && link.company_id !== offer.company_id)) {
      throw new Refusal(422, 'relay.not_member', offer.company_id);
    }
    if (link.device_key) {
      const fields = { token: body.token, ...(answerText !== null ? { sha256: createHash('sha256').update(answerText, 'utf8').digest('hex') } : {}) };
      if (!deviceSigned(link, relay, await deploymentOf(tx), body, 'press', fields)) throw new Refusal(422, 'relay.device_sig', offer.company_id);
    } else if (link.principal === 'owner') {
      throw new Refusal(422, 'relay.owner_device', offer.company_id);
    }
    if (!['approve', 'deny', 'answer'].includes(offer.act) || !offer.inbox_item_id) throw new Refusal(422, 'relay.press_unknown', offer.company_id);
    if (offer.voided_at || offer.uses >= offer.max_uses || offer.expires_at <= now) throw new Refusal(422, 'relay.press_spent', offer.company_id);
    // Spent before the decision is tried: a press that fails for any reason
    // after this is not a token left to be tried again.
    await tx.query('UPDATE relay_offers SET uses = uses + 1 WHERE token_hash = $1', [tokenHash(body.token as string)]);
    // The other buttons for the same item to the same person go with it.
    await tx.query(
      `UPDATE relay_offers SET voided_at = $3 WHERE link_id = $1 AND inbox_item_id = $2 AND voided_at IS NULL AND token_hash <> $4`,
      [link.id, offer.inbox_item_id, now, tokenHash(body.token as string)]);
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
    const { rows: [control] } = await tx.query<{ language: string | null }>('SELECT console_language AS language FROM platform_control');
    return { offer, seat, language: control!.language };
  });

  const { offer, seat, language } = redeemed;
  const companyId = offer.company_id;
  const itemId = offer.inbox_item_id!;
  const { rows: [item] } = await withTenant(companyId, (tx) => tx.query<{ tier: number | null; kind: string }>(
    'SELECT tier, kind FROM inbox_items WHERE id = $1', [itemId]));
  if (item && (item.tier ?? 0) >= 3) throw new Refusal(422, 'relay.press_tier3', companyId);
  try {
    if (offer.act === 'answer') {
      const words = offer.option ?? answerText;
      if (!words || !words.trim()) throw new Refusal(422, 'relay.press_unknown', companyId);
      await inbox.answerEscalation(companyId, itemId, words, { channel: 'chat', seat, via: 'relay' });
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
      if (error.code === 'approval.channel_forbidden') throw new Refusal(422, 'relay.press_tier3', companyId);
      throw new Refusal(422, error.code, companyId);
    }
    throw error;
  }
  return { status: 200, body: { ok: true, result: { act: offer.act } } };
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
  const claimed = await withControlPlane((tx) => claimLink(tx, relay, { code: body.code as string, label, deviceKey, claimId: envelopeId }, now));
  if (!claimed) throw new Refusal(422, 'relay.link_unknown');
  return { status: 200, body: { ok: true, result: { recipient: claimed.recipient, companies: claimed.companies } } };
}

/** The relay, for the person, ends their link: signed by the device when the link has one. */
async function linkEnd(relay: RelayRow, body: Body, now: Date): Promise<InboundAnswer> {
  if (typeof body.recipient !== 'string') throw new Refusal(410, 'relay.link_ended');
  return withControlPlane(async (tx) => {
    const { rows: [link] } = await tx.query<LinkRow>(
      `SELECT * FROM relay_links WHERE relay_id = $1 AND recipient_id = $2 AND status = 'active' FOR UPDATE`, [relay.id, body.recipient]);
    if (!link) throw new Refusal(410, 'relay.link_ended');
    if (link.device_key && !deviceSigned(link, relay, await deploymentOf(tx), body, 'link_end', {})) {
      throw new Refusal(422, 'relay.device_sig', link.company_id);
    }
    await endLinks(tx, [link.id], now);
    return { status: 200, body: { ok: true } };
  });
}
