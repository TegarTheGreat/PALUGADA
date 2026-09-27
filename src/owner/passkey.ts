/**
 * A new passkey, read from what the browser hands back (PRD v2 F12.5).
 *
 * `navigator.credentials.create` answers with an `attestationObject`: CBOR
 * (RFC 8949) holding the authenticator's data, inside which the new public key
 * is a COSE key (RFC 9053) -- CBOR again. This file turns that into the two
 * things verifying a signature later needs, a credential id and a public key
 * in PEM, and reports the flags and counter the authenticator set. It decides
 * nothing: whose challenge it was, which site, whether a person verified --
 * those are rules, and they are in `OwnerMfa.enrolPasskey` where they can be
 * read as rules, the same split as `parseAuthenticatorData` and
 * `verifySignature` beside the assertion.
 *
 * Read here rather than by a library because the owner's sign-in would be the
 * only thing that library served, and the format is small: CTAP2 requires an
 * authenticator to encode canonically, with five kinds of item. Anything else
 * -- floats, tags, indefinite lengths -- is refused rather than skipped: an
 * authenticator does not send them, and a reader that tolerates what it did
 * not expect is how two readers come to disagree about one key.
 */
import { createPublicKey, type JsonWebKey } from 'node:crypto';
import { PalugadaError } from '../errors.ts';

/* ------------------------------------------------------------------ CBOR --- */

export type CborValue =
  | number
  | string
  | Buffer
  | boolean
  | null
  | CborValue[]
  | Map<number | string, CborValue>;

/** Deeper than any attestation nests, and shallow enough that a hostile one cannot exhaust the stack. */
const MAX_DEPTH = 8;

function malformed(message: string): PalugadaError {
  return new PalugadaError('mfa.attestation_malformed', message, {});
}

/**
 * Reads one CBOR item starting at `start`, and says where it ended.
 *
 * Where it ended matters: a COSE key is followed in `authenticatorData` by
 * extensions or by nothing, and the only way to know which bytes were the key
 * is to have read exactly the key.
 */
export function decodeCbor(bytes: Buffer, start = 0): { value: CborValue; end: number } {
  let at = start;
  const need = (count: number) => {
    if (at + count > bytes.length) throw malformed('the CBOR ends in the middle of an item');
  };
  const argument = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[at++]!;
    }
    if (info === 25) {
      need(2);
      const value = bytes.readUInt16BE(at);
      at += 2;
      return value;
    }
    if (info === 26) {
      need(4);
      const value = bytes.readUInt32BE(at);
      at += 4;
      return value;
    }
    if (info === 27) {
      need(8);
      const value = bytes.readBigUInt64BE(at);
      at += 8;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed('the CBOR holds a number no passkey needs');
      return Number(value);
    }
    throw malformed('the CBOR uses an indefinite or reserved length, which an authenticator does not');
  };
  const text = new TextDecoder('utf-8', { fatal: true });

  const read = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw malformed('the CBOR nests deeper than a passkey does');
    need(1);
    const initial = bytes[at++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw malformed(`the CBOR holds a float or simple value (${info}), which a passkey does not`);
    }
    if (major === 6) throw malformed('the CBOR holds a tag, which a passkey does not');
    const length = argument(info);
    switch (major) {
      case 0:
        return length;
      case 1:
        return -1 - length;
      case 2: {
        need(length);
        const value = Buffer.from(bytes.subarray(at, at + length));
        at += length;
        return value;
      }
      case 3: {
        need(length);
        let value: string;
        try {
          value = text.decode(bytes.subarray(at, at + length));
        } catch {
          throw malformed('the CBOR holds text that is not UTF-8');
        }
        at += length;
        return value;
      }
      case 4: {
        const items: CborValue[] = [];
        for (let index = 0; index < length; index += 1) items.push(read(depth + 1));
        return items;
      }
      default: {
        const map = new Map<number | string, CborValue>();
        for (let index = 0; index < length; index += 1) {
          const key = read(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') {
            throw malformed('the CBOR has a map key that is neither a number nor text');
          }
          // Two values for one key is two readers' worth of ambiguity: which
          // one is the public key depends on which a reader keeps.
          if (map.has(key)) throw malformed(`the CBOR repeats the map key ${String(key)}`);
          map.set(key, read(depth + 1));
        }
        return map;
      }
    }
  };

  const value = read(0);
  return { value, end: at };
}

/* ------------------------------------------------------------------ COSE --- */

/**
 * The signature algorithms a passkey may use here, in the order the console
 * offers them: ES256, which nearly every authenticator makes; EdDSA; and
 * RS256, which Windows Hello makes. COSE numbers them.
 */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;

/** A COSE key, as the public key in PEM that `verifySignature` takes. */
export function coseKeyToPem(key: CborValue): { publicKeyPem: string; algorithm: number } {
  if (!(key instanceof Map)) throw malformed('the credential public key is not a COSE key');
  const kty = key.get(1);
  const algorithm = key.get(3);
  const bytes = (label: number, what: string): Buffer => {
    const value = key.get(label);
    if (!Buffer.isBuffer(value)) throw malformed(`the COSE key has no ${what}`);
    return value;
  };

  let jwk: JsonWebKey;
  if (algorithm === ES256) {
    if (kty !== 2 || key.get(-1) !== 1) throw malformed('an ES256 key is not a P-256 EC2 key');
    const x = bytes(-2, 'x coordinate');
    const y = bytes(-3, 'y coordinate');
    if (x.length !== 32 || y.length !== 32) throw malformed('a P-256 coordinate is not 32 bytes');
    jwk = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
  } else if (algorithm === EDDSA) {
    if (kty !== 1 || key.get(-1) !== 6) throw malformed('an EdDSA key is not an Ed25519 OKP key');
    const x = bytes(-2, 'public key');
    if (x.length !== 32) throw malformed('an Ed25519 public key is not 32 bytes');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') };
  } else if (algorithm === RS256) {
    if (kty !== 3) throw malformed('an RS256 key is not an RSA key');
    const n = bytes(-1, 'modulus');
    const e = bytes(-2, 'exponent');
    // Below 2048 bits an RSA key is one somebody else can factor; WebAuthn
    // authenticators do not make them, so one arriving is a forgery or a toy.
    if (n.length < 256) throw new PalugadaError('mfa.algorithm_unsupported', `an RSA key of ${n.length * 8} bits is too short; 2048 is the least accepted`, {});
    jwk = { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') };
  } else {
    throw new PalugadaError(
      'mfa.algorithm_unsupported',
      `the passkey signs with COSE algorithm ${String(algorithm)}; accepted are ES256 (-7), EdDSA (-8) and RS256 (-257)`,
      { algorithm: typeof algorithm === 'number' ? algorithm : null },
    );
  }

  try {
    // Importing checks the key: a point that is not on the curve is refused
    // here, rather than accepted now and failing every signature later.
    const publicKeyPem = createPublicKey({ key: jwk, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();
    return { publicKeyPem, algorithm };
  } catch (failure) {
    throw malformed(`the credential public key is not a usable key: ${(failure as Error).message}`);
  }
}

/* ----------------------------------------------------------- attestation --- */

const FLAG_ATTESTED_CREDENTIAL = 0x40;
const FLAG_EXTENSIONS = 0x80;

export interface PasskeyRegistration {
  /** base64url, as an assertion names it later. */
  credentialId: string;
  publicKeyPem: string;
  algorithm: number;
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
}

/**
 * Reads an `attestationObject`.
 *
 * The attestation statement itself is not read. The console asks for
 * `attestation: 'none'` -- which make of authenticator the owner chose is not
 * this platform's business, and asking would put a manufacturer's certificate
 * in the owner's sign-in path -- so what is trusted is the same thing a TOTP
 * enrolment trusts: the owner, already holding a factor, said this device is
 * theirs.
 */
export function parseAttestation(attestationObject: Buffer): PasskeyRegistration {
  const { value, end } = decodeCbor(attestationObject);
  if (end !== attestationObject.length) throw malformed('the attestation has bytes after its end');
  if (!(value instanceof Map)) throw malformed('the attestation is not a CBOR map');
  const authData = value.get('authData');
  if (!Buffer.isBuffer(authData)) throw malformed('the attestation has no authData');
  if (authData.length < 37) throw malformed('authData is shorter than its fixed header');

  const flags = authData[32]!;
  if ((flags & FLAG_ATTESTED_CREDENTIAL) === 0) {
    throw malformed('authData carries no credential; it is an assertion, not a registration');
  }
  // 16 bytes of AAGUID, then the credential id's length and the id itself.
  let at = 37 + 16;
  if (authData.length < at + 2) throw malformed('authData ends before the credential id');
  const idLength = authData.readUInt16BE(at);
  at += 2;
  if (idLength === 0 || idLength > 1023 || authData.length < at + idLength) {
    throw malformed('authData has no whole credential id');
  }
  const credentialId = authData.subarray(at, at + idLength);
  at += idLength;
  const key = decodeCbor(authData, at);
  at = key.end;
  if ((flags & FLAG_EXTENSIONS) !== 0) at = decodeCbor(authData, at).end;
  if (at !== authData.length) throw malformed('authData has bytes after the credential');

  return {
    credentialId: credentialId.toString('base64url'),
    ...coseKeyToPem(key.value),
    rpIdHash: authData.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: authData.readUInt32BE(33),
  };
}
