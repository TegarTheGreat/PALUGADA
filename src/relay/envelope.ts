/**
 * What PALUGADA sends a relay: the envelope, its types and share levels, and
 * the pseudonyms a relay knows people and companies by (F19.19; STATUS
 * section 2.208; the whole of it in docs/relay-protocol.md).
 *
 * An envelope is one JSON object, written as RFC 8785 canonical JSON and
 * signed with the deployment's key in the Standard Webhooks `v1a` form. A
 * relay is a notifier, not a mirror: it is told what a person who linked a
 * phone is owed, at that person's share level, and never a room list, a
 * history, a membership or anyone else's items. A person is never named on
 * the wire: the relay sees an HMAC of who they are under a salt of its own,
 * and a company the same way, so two relays cannot join what each knows.
 */
import { createHash, createHmac, type KeyObject } from 'node:crypto';
import { somethingNewSaid } from '../owner/people-said.ts';
import { closedSaid, digestSaid, doneSaid, itemSaid } from '../owner/relay-said.ts';
import { jcs } from './canonical.ts';
import { base32, signV1a } from './signature.ts';

/**
 * Every type of envelope PALUGADA sends, which the protocol document
 * describes one by one (`test/documents/relay-protocol.test.ts`). Within v1 a
 * type is only ever added, and a relay ignores one it does not know.
 */
export const OUTBOUND_TYPES = [
  'pair_request',
  'ping',
  'link_confirmed',
  'keys_rotated',
  'inbox_item',
  'inbox_closed',
  'work_done',
  'digest',
  // A person's own notices (STATUS section 2.213): words in a room addressed
  // to them, and the words withdrawn again when they were deleted.
  'room_activity',
  'room_activity_retracted',
] as const;
export type OutboundType = (typeof OUTBOUND_TYPES)[number];

/** How much a relay is told, lowest first: that something happened; what it is about; what it says. */
export const SHARE_LEVELS = ['signal', 'summary', 'content'] as const;
export type Share = (typeof SHARE_LEVELS)[number];

/** The lower of two share levels: a person's own ceiling holds under a relay's. */
export function lowerShare(a: Share, b: Share | null): Share {
  if (b === null) return a;
  return SHARE_LEVELS.indexOf(a) <= SHARE_LEVELS.indexOf(b) ? a : b;
}

/** Whether `level` tells at least as much as `floor`. */
export function shareAtLeast(level: Share, floor: Share): boolean {
  return SHARE_LEVELS.indexOf(level) >= SHARE_LEVELS.indexOf(floor);
}

/** How loudly a relay may tell a person: ring the phone, show a notification, or nothing that sounds. */
export type Urgency = 'interrupt' | 'normal' | 'quiet';

/**
 * An envelope's id: a UUID shaped from the SHA-256 of what the envelope is
 * about. The same notice is the same id however many times it is enqueued or
 * sent, so a resend after a crash is a duplicate the relay drops.
 */
export function envelopeId(parts: {
  deployment: string; relay: string; link: string | null; type: string; subject: string; version?: number;
}): string {
  const text = [parts.deployment, parts.relay, parts.link ?? '', parts.type, parts.subject, String(parts.version ?? 1)].join('\n');
  const bytes = createHash('sha256').update(text, 'utf8').digest().subarray(0, 16);
  // RFC 9562's custom version (8) and the RFC 4122 variant, so it parses as any UUID does.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Base32 of an HMAC-SHA256 under the relay's salt, truncated: what a relay knows someone by. */
function pseudonym(salt: Buffer, value: string, length: number): string {
  return base32(createHmac('sha256', salt).update(value, 'utf8').digest()).slice(0, length);
}

/** The person a relay addresses, as it may know them: 26 characters, the same for one person on one relay. */
export function recipientId(salt: Buffer, principal: string): string {
  return pseudonym(salt, principal, 26);
}

/** A company as a relay may know it: `co_` and 16 characters. */
export function companyRef(salt: Buffer, companyId: string): string {
  return `co_${pseudonym(salt, companyId, 16)}`;
}

/** The headers an envelope goes with, signed now with every key the deployment signs with. */
export function envelopeHeaders(keys: readonly KeyObject[], kid: string, id: string, body: string, now: Date): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signV1a(keys, id, timestamp, body),
    'palugada-key': kid,
    'palugada-relay-version': '1',
  };
}

/** An envelope's body as it is kept and signed: canonical JSON of the whole object. */
export function envelopeBody(envelope: Record<string, unknown>): string {
  return jcs(envelope);
}

/**
 * An envelope not yet sent, as it would have been made at a lower share, and
 * without the offers `keep` refuses: what the owner narrowed a relay to is
 * what it is sent from then on, including what it was owed and has not had.
 * Each type drops what the lower share does not carry and says what that
 * share says, as `channel.ts` would have made it. A type added to the
 * protocol says here what it keeps at each share, or the type check fails.
 */
export function narrowedEnvelope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  envelope: Record<string, any>,
  share: Share,
  keep: (offer: { token: string; act: string }) => boolean,
): { envelope: Record<string, unknown>; dropped: string[] } {
  const given: Share | undefined = (SHARE_LEVELS as readonly string[]).includes(envelope.share) ? envelope.share : undefined;
  const lower = given !== undefined && SHARE_LEVELS.indexOf(share) < SHARE_LEVELS.indexOf(given);
  const offers: Array<{ token: string; act: string }> = Array.isArray(envelope.offers) ? envelope.offers : [];
  // A read mark and a mute say nothing of what was said, and stand at every
  // share; every other offer is a button only above `signal`.
  const quiet = (offer: { act: string }) => envelope.type === 'room_activity' && (offer.act === 'read' || offer.act === 'mute');
  const kept = offers.filter((offer) => (!lower || share !== 'signal' || quiet(offer)) && keep(offer));
  const dropped = offers.filter((offer) => !kept.includes(offer)).map((offer) => offer.token);
  if (!lower) return { envelope: offers.length > 0 ? { ...envelope, offers: kept } : envelope, dropped };

  const language: string | null = typeof envelope.lang === 'string' ? envelope.lang : null;
  const company = envelope.company as { ref: string; name?: string } | undefined;
  const next: Record<string, unknown> = {
    ...envelope, share, ...(company ? { company: share === 'signal' ? { ref: company.ref } : company } : {}),
  };
  const type = envelope.type as OutboundType;
  switch (type) {
    case 'inbox_item': {
      const data = (envelope.data ?? {}) as { kind?: string; tier?: number | null; title?: string };
      const title = String(data.title ?? '');
      next.data = share === 'signal' ? { kind: data.kind, tier: data.tier } : { kind: data.kind, tier: data.tier, title };
      next.text = itemSaid(language, share, { kind: String(data.kind ?? ''), title, urgent: envelope.urgency === 'interrupt' });
      next.offers = kept;
      break;
    }
    case 'inbox_closed':
      // Why it closed is told above `signal`, and the same at both.
      if (share === 'signal') next.text = closedSaid(language);
      break;
    case 'digest':
      next.text = digestSaid(language, share === 'signal' ? null : company?.name ?? null);
      break;
    case 'work_done':
      next.text = share === 'signal' ? doneSaid(language) : String(envelope.text ?? '').split('\n')[0]!;
      break;
    case 'room_activity': {
      // Who and where above `signal`, the words only at `content`, and at
      // `signal` that something happened and how often.
      const data = (envelope.data ?? {}) as { reasons?: unknown; count?: unknown; room?: unknown; authors?: unknown };
      next.data = share === 'signal'
        ? { reasons: data.reasons, count: data.count }
        : { reasons: data.reasons, count: data.count, room: data.room, authors: data.authors };
      next.text = share === 'signal' ? somethingNewSaid(language) : String(envelope.text ?? '').split('\n')[0]!;
      next.offers = kept;
      break;
    }
    case 'room_activity_retracted':
      // Names envelopes, never what they said.
      return { envelope, dropped };
    case 'pair_request':
    case 'ping':
    case 'link_confirmed':
    case 'keys_rotated':
      // Nothing of a company or a person: no share to lower.
      return { envelope, dropped };
    default: {
      const never: never = type;
      throw new Error(`an envelope of type ${String(never)} has no lower share to be made at`);
    }
  }
  return { envelope: next, dropped };
}
