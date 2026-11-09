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
