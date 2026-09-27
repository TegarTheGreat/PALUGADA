/**
 * An authenticator, in software: what a phone or a security key does when a
 * browser asks it to make a passkey and, later, to sign with it.
 *
 * It produces the bytes a browser hands a page -- `clientDataJSON`, an
 * `attestationObject` in CBOR holding the new key as a COSE key, and then
 * assertions signed by that key -- so the platform is tested against the
 * format itself rather than against a shape this file and the parser agreed
 * on. The CBOR is written here independently of `src/owner/passkey.ts`'s
 * reader for the same reason.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { WebAuthnAssertion } from '../../src/owner/mfa.ts';

/* -------------------------------------------------------------- writing --- */

export type Encodable = number | string | Buffer | boolean | null | Encodable[] | Map<number | string, Encodable>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

export function cbor(value: Encodable): Buffer {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

/* -------------------------------------------------------- the authenticator --- */

export type PasskeyAlgorithm = 'ES256' | 'EdDSA' | 'RS256';

function coseKey(publicKey: KeyObject, algorithm: PasskeyAlgorithm): Map<number, Encodable> {
  const jwk = publicKey.export({ format: 'jwk' });
  const bytes = (field: string | undefined) => Buffer.from(field!, 'base64url');
  if (algorithm === 'ES256') {
    return new Map<number, Encodable>([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]]);
  }
  if (algorithm === 'EdDSA') return new Map<number, Encodable>([[1, 1], [3, -8], [-1, 6], [-2, bytes(jwk.x)]]);
  return new Map<number, Encodable>([[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]]);
}

function keyPair(algorithm: PasskeyAlgorithm, rsaBits: number) {
  if (algorithm === 'ES256') return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  if (algorithm === 'EdDSA') return generateKeyPairSync('ed25519');
  return generateKeyPairSync('rsa', { modulusLength: rsaBits });
}

function counterBytes(count: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(count);
  return out;
}

export interface Registration {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}

/**
 * One device holding one passkey.
 *
 * `register` is `navigator.credentials.create`, `assert` is
 * `navigator.credentials.get`. Each takes overrides for the one thing a test
 * wants wrong, so a test of a refusal differs from a good ceremony in that
 * thing alone.
 */
export function authenticator(options: {
  rpId: string;
  origin: string;
  algorithm?: PasskeyAlgorithm;
  rsaBits?: number;
  signCount?: number;
}) {
  const algorithm = options.algorithm ?? 'ES256';
  const { publicKey, privateKey } = keyPair(algorithm, options.rsaBits ?? 2048);
  const rawId = randomBytes(32);
  const id = rawId.toString('base64url');
  let counter = options.signCount ?? 0;

  const flagsOf = (input: { userPresent?: boolean; userVerified?: boolean }) =>
    (input.userPresent === false ? 0 : 0x01) | (input.userVerified === false ? 0 : 0x04);

  return {
    id,

    register(input: {
      challenge: string;
      type?: string;
      origin?: string;
      rpId?: string;
      userPresent?: boolean;
      userVerified?: boolean;
      /** Leaves out the attested credential, as an assertion's authenticatorData does. */
      noCredential?: boolean;
      /** Keeps the credential but clears the flag that says one is there. */
      unflagged?: boolean;
      /** Replaces the COSE key, for a key the platform must not accept. */
      cose?: Map<number, Encodable>;
      /** Bytes appended after the credential, which no authenticator writes. */
      trailing?: Buffer;
      /** Replaces the whole attestation object. */
      attestationObject?: Buffer;
      /** Bytes after the attestation object's own end. */
      afterAttestation?: Buffer;
      /** The id the browser reports, when it is not the one the authenticator made. */
      reportedId?: string;
    }): Registration {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: input.type ?? 'webauthn.create',
        challenge: input.challenge,
        origin: input.origin ?? options.origin,
        crossOrigin: false,
      }), 'utf8');
      const credential = input.noCredential
        ? Buffer.alloc(0)
        : Buffer.concat([
          Buffer.alloc(16),
          (() => {
            const length = Buffer.alloc(2);
            length.writeUInt16BE(rawId.length);
            return length;
          })(),
          rawId,
          cbor(input.cose ?? coseKey(publicKey, algorithm)),
        ]);
      const authData = Buffer.concat([
        createHash('sha256').update(input.rpId ?? options.rpId).digest(),
        Buffer.from([flagsOf(input) | (input.noCredential || input.unflagged ? 0 : 0x40)]),
        counterBytes(counter),
        credential,
        input.trailing ?? Buffer.alloc(0),
      ]);
      const attestationObject = input.attestationObject ?? cbor(new Map<string, Encodable>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]));
      return {
        id: input.reportedId ?? id,
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: Buffer.concat([attestationObject, input.afterAttestation ?? Buffer.alloc(0)]).toString('base64url'),
      };
    },

    assert(input: { challenge: string; origin?: string; signCount?: number }): WebAuthnAssertion {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.get',
        challenge: input.challenge,
        origin: input.origin ?? options.origin,
      }), 'utf8');
      counter = input.signCount ?? (counter === 0 ? 0 : counter + 1);
      const authenticatorData = Buffer.concat([
        createHash('sha256').update(options.rpId).digest(),
        Buffer.from([0x05]),
        counterBytes(counter),
      ]);
      const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
      // Ed25519 signs the message itself; the other two hash it with SHA-256.
      const signature = sign(algorithm === 'EdDSA' ? null : 'sha256', signed, privateKey);
      return {
        credentialId: id,
        authenticatorData: authenticatorData.toString('base64url'),
        clientDataJSON: clientDataJSON.toString('base64url'),
        signature: signature.toString('base64url'),
      };
    },

    /** The COSE key this device would send, to be broken by a test. */
    cose(): Map<number, Encodable> {
      return coseKey(publicKey, algorithm);
    },
  };
}
