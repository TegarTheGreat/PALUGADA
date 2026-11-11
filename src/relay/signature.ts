/**
 * Signatures in the Standard Webhooks form, and the keys behind them (F19.19;
 * STATUS section 2.208).
 *
 * Standard Webhooks signs `<id>.<timestamp>.<payload>` and sends the id, the
 * time and the signature as three headers. Its `v1` form is an HMAC with a
 * secret both sides hold; its `v1a` form is Ed25519, where the sender holds
 * the private key and the receiver only the public one. A relay and the
 * deployment each sign with their own Ed25519 key, so neither holds anything
 * that would let it speak as the other, and a database dump holds no key that
 * signs. A signature header may carry several, space-separated, which is how
 * a key is rotated without a gap.
 *
 * The verifiers live here and the trigger door (`src/scheduler/triggers.ts`)
 * uses them, so a relay's signature and an inbound webhook's are read one way.
 * Ed25519 is `node:crypto`'s own; nothing is added for it.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { PalugadaError } from '../errors.ts';

/** How far a signed time may be from now, either way: five minutes, as Standard Webhooks recommends. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The DER that wraps a raw 32-byte Ed25519 public key as SubjectPublicKeyInfo. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** The DER that wraps a 32-byte Ed25519 seed as a PKCS #8 private key. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, without padding: what a fingerprint and a pseudonym are written in. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** A raw Ed25519 public key as a key `node:crypto` verifies with; refused unless it is 32 bytes. */
export function publicKeyFrom(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new PalugadaError('contract.violation', `an Ed25519 public key is 32 bytes, not ${raw.length}`, {});
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The raw 32 bytes of an Ed25519 public key, as the protocol writes one. */
export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new PalugadaError('contract.violation', 'the key is not an Ed25519 key', {});
  }
  return Buffer.from(jwk.x, 'base64url');
}

/**
 * The key pair a 32-byte seed makes. The seed is the private key: it is what
 * the deployment seals, and what a test vector names.
 */
export function ed25519FromSeed(seed: Buffer): { privateKey: KeyObject; publicKey: Buffer } {
  if (seed.length !== 32) throw new PalugadaError('contract.violation', `an Ed25519 seed is 32 bytes, not ${seed.length}`, {});
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: rawPublicKey(createPublicKey(privateKey)) };
}

/** The seed of an Ed25519 private key, to seal. */
export function seedOf(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw new PalugadaError('contract.violation', 'the key is not an Ed25519 private key', {});
  }
  return Buffer.from(jwk.d, 'base64url');
}

/** A key's id, sent as `palugada-key`: the first sixteen hex digits of the SHA-256 of the raw key. */
export function keyId(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * What a person compares to know it is the key they meant: base32 of the
 * SHA-256 of the raw key, the first 24 characters (120 bits). The owner types
 * at least the first sixteen (80 bits) when pairing.
 */
export function fingerprint(raw: Buffer): string {
  return base32(createHash('sha256').update(raw).digest()).slice(0, 24);
}

/** What a signature covers: the id, the time and the payload, joined by dots. */
function signedContent(id: string, timestamp: string, payload: string | Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload]);
}

/** The `webhook-signature` header: one `v1a,<base64>` for each key, space-separated. */
export function signV1a(keys: readonly KeyObject[], id: string, timestamp: string, payload: string | Buffer): string {
  const content = signedContent(id, timestamp, payload);
  return keys.map((key) => `v1a,${sign(null, content, key).toString('base64')}`).join(' ');
}

/**
 * The most signatures a `webhook-signature` header may carry: one for each
 * key a sender signs with while it rotates, with room for a sender that also
 * signs in another form. A header with more verifies nothing, so a stranger
 * cannot make a receiver check signatures without end before anything else
 * holds them back (STATUS section 2.216).
 */
const MAX_SIGNATURES = 4;

/** Whether any `v1a` signature in a header verifies with any of these raw public keys. */
export function verifyV1a(header: string, keys: readonly Buffer[], id: string, timestamp: string, payload: string | Buffer): boolean {
  if (!header || keys.length === 0) return false;
  const parts = header.split(' ');
  if (parts.length > MAX_SIGNATURES) return false;
  const content = signedContent(id, timestamp, payload);
  const verifiers = keys.map((raw) => publicKeyFrom(raw));
  return parts.some((part) => {
    const comma = part.indexOf(',');
    if (comma <= 0 || part.slice(0, comma) !== 'v1a') return false;
    const signature = Buffer.from(part.slice(comma + 1), 'base64');
    if (signature.length !== 64) return false;
    return verifiers.some((key) => verify(null, content, key, signature));
  });
}

/** Whether a signed time, in whole seconds since the epoch, is within the tolerance of now. */
export function freshTimestamp(seconds: string | null | undefined, now = Date.now()): boolean {
  if (!seconds || !/^\d{1,12}$/.test(seconds)) return false;
  return Math.abs(now / 1000 - Number(seconds)) <= SIGNATURE_TOLERANCE_SECONDS;
}

/** What a Standard Webhooks delivery proved: why it is refused, or the id its proof covers. */
export type StandardVerdict = { refused: null; deliveryId: string } | { refused: 'no signature' | 'stale signature' | 'wrong signature' };

/**
 * A Standard Webhooks delivery, checked against the secret its receiver keeps:
 * `whsec_<base64>` for the `v1` HMAC, the key both sides hold, or
 * `whpk_<base64>` for `v1a`, the sender's Ed25519 public key. A signature of
 * the other form than the secret's is never taken: an HMAC keyed with a
 * public key proves nothing, since anyone may hold one.
 */
export function verifyStandardWebhook(
  delivery: { id: string | null; timestamp: string | null; signature: string | null; payload: Buffer },
  secret: string,
  now = Date.now(),
): StandardVerdict {
  const { id, timestamp, signature, payload } = delivery;
  if (!signature || !id) return { refused: 'no signature' };
  if (!freshTimestamp(timestamp, now)) return { refused: 'stale signature' };
  if (secret.startsWith('whpk_')) {
    const raw = Buffer.from(secret.slice(5), 'base64');
    if (raw.length !== 32) return { refused: 'wrong signature' };
    return verifyV1a(signature, [raw], id, timestamp!, payload) ? { refused: null, deliveryId: id } : { refused: 'wrong signature' };
  }
  // The secret is `whsec_` and the key in base64, as the senders hand it out.
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const expected = Buffer.from(createHmac('sha256', key).update(signedContent(id, timestamp!, payload)).digest('base64'));
  // "v1,<base64> v1,<base64>" -- one per secret while a secret rolls.
  const matched = signature.split(' ').some((part) => {
    const comma = part.indexOf(',');
    if (comma <= 0 || part.slice(0, comma) !== 'v1') return false;
    const offered = Buffer.from(part.slice(comma + 1));
    return offered.length === expected.length && timingSafeEqual(offered, expected);
  });
  return matched ? { refused: null, deliveryId: id } : { refused: 'wrong signature' };
}
