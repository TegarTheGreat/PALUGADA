/**
 * The owner's second factor (PRD v2 F12.5, F10.10).
 *
 * F12.5 is a P0 that was graded "needs an application PALUGADA does not have",
 * and half of that was true. The *client* is an application: an authenticator
 * app holds the TOTP secret, a phone holds a passkey behind a fingerprint.
 * Verifying what those clients produce is arithmetic, and arithmetic belongs
 * in the control plane rather than in whatever calls it. Until this existed,
 * `decide` took an `assurance: 'mfa'` string that nothing checked, so F10.10's
 * "tier 3 only through the app with MFA" reduced to "tier 3 for anyone who
 * says mfa".
 *
 * Two factors, because F12.5 names two things:
 *
 * **TOTP (RFC 6238).** A shared secret and a clock. Verified against the
 * current step and one on either side, because a phone's clock drifts and an
 * owner who has to retype a code they read correctly stops using the feature.
 * The step that produced an accepted code is remembered, so the same code
 * cannot be used twice -- a code is valid for thirty seconds, and thirty
 * seconds is long enough for one to be read over a shoulder, forwarded, or
 * replayed from a log.
 *
 * **WebAuthn (mobile biometrics).** The phone holds a private key behind a
 * fingerprint or a face and signs a challenge with it; what arrives here is a
 * signature that can only have come from that device. Four things are checked
 * and each is load-bearing:
 *
 *   - the signature, over `authenticatorData || SHA-256(clientDataJSON)`,
 *     against the enrolled public key;
 *   - the challenge inside `clientDataJSON`, against one this process issued
 *     and has not seen used -- without this the whole ceremony is a replay of
 *     a signature captured once;
 *   - the RP id hash and the `type` field, so an assertion collected by
 *     another site cannot be presented here;
 *   - the **user-verified** flag, because "mobile biometrik" is precisely the
 *     difference between a key that was touched and a key that was *unlocked
 *     by a person*. A key present but not verified is a phone in someone
 *     else's hand.
 *
 * What this cannot do is decide that the human at the far end is the owner
 * rather than someone holding the owner's phone. Nothing can, and the honest
 * boundary is worth stating: what a second factor buys is that approving a
 * tier 3 action requires *possession of an enrolled device*, and that every
 * attempt -- successful or not -- is on a record an auditor reads.
 */
import { createHmac, createPublicKey, createVerify, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { PalugadaError, type ErrorCode } from '../errors.ts';
import { withControlPlane } from '../db/tenant.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';

export type FactorKind = 'totp' | 'webauthn';

export interface OwnerAuthenticator {
  id: string;
  kind: FactorKind;
  label: string;
  secretRef: string | null;
  publicKey: string | null;
  credentialId: string | null;
  lastStep: number | null;
  signCount: number;
  revokedAt: Date | null;
}

/** The TOTP parameters. RFC 6238's defaults, and the ones every app assumes. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * How far either side of now a code is accepted.
 *
 * One step. Two would double the window an intercepted code stays usable in,
 * and zero would refuse a phone whose clock is a few seconds out -- which is
 * most phones, and is the failure that makes owners turn the feature off.
 */
export const TOTP_DRIFT_STEPS = 1;

/* ------------------------------------------------------------------ TOTP --- */

/**
 * RFC 4648 base32, which is the alphabet every authenticator app speaks.
 *
 * Written out rather than pulled in: it is twenty lines, and a dependency that
 * decodes the owner's second-factor secret is a dependency with a very short
 * path to the thing it is protecting.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new PalugadaError('mfa.secret_malformed', 'the TOTP secret is not base32', {});
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * One TOTP code, for a step.
 *
 * `step` rather than a timestamp because every caller here already has one,
 * and because passing a time to a function that immediately divides it by
 * thirty invites the drift window to be computed twice in two ways.
 */
export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  // Written as two 32-bit halves: `writeBigUInt64BE` would need the step as a
  // BigInt everywhere else too, for a value that will not exceed 2^53 until
  // long after this platform is gone.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function stepFor(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Compares two codes without leaking how much of one matched.
 *
 * A six-digit code has a million possibilities, which is few enough that a
 * timing oracle telling an attacker "the first three digits are right" turns
 * an infeasible search into a trivial one.
 */
function codesMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ challenges --- */

/**
 * A WebAuthn challenge, issued here and usable once.
 *
 * Held in this process rather than in the database on purpose: a challenge is
 * valid for a couple of minutes and is meaningless afterwards, and a table of
 * them would be a table that needs sweeping. What matters is that the value is
 * unpredictable, that it is removed when used, and that a signature over a
 * challenge nobody issued is refused -- which is the whole defence against
 * replaying an assertion captured once.
 */
export class ChallengeStore {
  readonly #issued = new Map<string, number>();
  readonly #ttlMs: number;

  constructor(ttlMs = 120_000) {
    this.#ttlMs = ttlMs;
  }

  issue(now: number = Date.now()): string {
    this.#sweep(now);
    const challenge = randomBytes(32).toString('base64url');
    this.#issued.set(challenge, now + this.#ttlMs);
    return challenge;
  }

  /** True once per challenge, and only inside its window. */
  redeem(challenge: string, now: number = Date.now()): boolean {
    const expires = this.#issued.get(challenge);
    if (expires === undefined) return false;
    this.#issued.delete(challenge);
    return expires > now;
  }

  #sweep(now: number): void {
    for (const [challenge, expires] of this.#issued) {
      if (expires <= now) this.#issued.delete(challenge);
    }
  }
}

/* -------------------------------------------------------------- WebAuthn --- */

/** The bits of `authenticatorData` this checks. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export interface WebAuthnAssertion {
  credentialId: string;
  /** Raw `authenticatorData`, base64url. */
  authenticatorData: string;
  /** Raw `clientDataJSON`, base64url. */
  clientDataJSON: string;
  /** The signature, base64url. */
  signature: string;
}

export interface ParsedAuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
}

export function parseAuthenticatorData(raw: Buffer): ParsedAuthenticatorData {
  if (raw.length < 37) {
    throw new PalugadaError(
      'mfa.assertion_malformed',
      'authenticatorData is shorter than its fixed header',
      { length: raw.length },
    );
  }
  const flags = raw[32]!;
  return {
    rpIdHash: raw.subarray(0, 32),
    userPresent: (flags & FLAG_USER_PRESENT) !== 0,
    userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
    signCount: raw.readUInt32BE(33),
  };
}

/**
 * Verifies the signature itself.
 *
 * Split out because it is the one part with no policy in it: given a key, a
 * message and a signature, either the arithmetic works or it does not. The
 * decisions -- which flags must be set, whose challenge it was, whether the
 * counter advanced -- are in `verifyAssertion`, where they can be read as
 * rules rather than found inside a crypto call.
 */
export function verifySignature(
  publicKeyPem: string,
  authenticatorData: Buffer,
  clientDataJSON: Buffer,
  signature: Buffer,
): boolean {
  const key = createPublicKey(publicKeyPem);
  const signed = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientDataJSON).digest(),
  ]);
  const algorithm = key.asymmetricKeyType === 'rsa' ? 'RSA-SHA256' : 'SHA256';
  try {
    return createVerify(algorithm).update(signed).verify(key, signature);
  } catch {
    // A malformed signature makes `verify` throw rather than return false, and
    // a malformed signature is a failed verification like any other.
    return false;
  }
}

/* --------------------------------------------------------------- the API --- */

export interface MfaOptions {
  secrets: SecretManager;
  challenges?: ChallengeStore;
  /** The relying party id a passkey was registered against. */
  rpId?: string;
  /** Where the app is served from, checked against `clientDataJSON.origin`. */
  origin?: string;
  now?: () => Date;
}

export interface VerifiedFactor {
  authenticatorId: string;
  kind: FactorKind;
  label: string;
}

/**
 * The owner's enrolled factors and the checks against them.
 *
 * A class rather than free functions because every method needs the same three
 * things -- the secret manager, the challenge store and the clock -- and
 * threading them through each call is how one of them ends up defaulted to
 * `Date.now` in a place that was supposed to be injectable.
 */
export class OwnerMfa {
  readonly #secrets: SecretManager;
  readonly #challenges: ChallengeStore;
  readonly #rpId: string;
  readonly #origin: string | null;
  readonly #now: () => Date;

  constructor(options: MfaOptions) {
    this.#secrets = options.secrets;
    this.#challenges = options.challenges ?? new ChallengeStore();
    this.#rpId = options.rpId ?? 'localhost';
    this.#origin = options.origin ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  get challenges(): ChallengeStore {
    return this.#challenges;
  }

  /**
   * Enrols a TOTP authenticator.
   *
   * The secret is generated by the caller and put in the secret manager; what
   * is stored here is the reference (F12.1). Twenty bytes because that is what
   * RFC 4226 asks for and what every authenticator app expects.
   */
  async enrolTotp(input: {
    label: string;
    secretRef: string;
    companyId?: string | null;
  }): Promise<string> {
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO owner_authenticators (company_id, kind, label, secret_ref)
         VALUES ($1, 'totp', $2, $3) RETURNING id`,
        [input.companyId ?? null, input.label, input.secretRef],
      );
      return rows[0]!.id;
    });
  }

  async enrolWebAuthn(input: {
    label: string;
    credentialId: string;
    publicKeyPem: string;
    signCount?: number;
    companyId?: string | null;
  }): Promise<string> {
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO owner_authenticators
           (company_id, kind, label, credential_id, public_key, sign_count)
         VALUES ($1, 'webauthn', $2, $3, $4, $5) RETURNING id`,
        [
          input.companyId ?? null,
          input.label,
          input.credentialId,
          input.publicKeyPem,
          input.signCount ?? 0,
        ],
      );
      return rows[0]!.id;
    });
  }

  async revoke(authenticatorId: string): Promise<void> {
    await withControlPlane(async (tx) => {
      await tx.query(
        'UPDATE owner_authenticators SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [authenticatorId],
      );
    });
  }

  async enrolled(): Promise<OwnerAuthenticator[]> {
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{
        id: string; kind: FactorKind; label: string; secret_ref: string | null;
        public_key: string | null; credential_id: string | null;
        last_step: string | null; sign_count: string; revoked_at: Date | null;
      }>(
        `SELECT id, kind, label, secret_ref, public_key, credential_id,
                last_step, sign_count, revoked_at
           FROM owner_authenticators
          WHERE revoked_at IS NULL
          ORDER BY enrolled_at`,
      );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        secretRef: row.secret_ref,
        publicKey: row.public_key,
        credentialId: row.credential_id,
        lastStep: row.last_step === null ? null : Number(row.last_step),
        signCount: Number(row.sign_count),
        revokedAt: row.revoked_at,
      }));
    });
  }

  /**
   * Checks a TOTP code.
   *
   * Returns the factor rather than a boolean so a caller can record *which*
   * device approved something. A refusal throws, because every caller of this
   * is about to do something the owner asked for and "false" is the one answer
   * that must not be possible to ignore by accident.
   */
  async verifyTotp(
    code: string,
    context: { purpose?: string; subjectId?: string | null } = {},
  ): Promise<VerifiedFactor> {
    const candidates = (await this.enrolled()).filter((factor) => factor.kind === 'totp');
    if (candidates.length === 0) {
      await this.#record(null, 'totp', false, 'mfa.not_enrolled', context);
      throw new PalugadaError(
        'mfa.not_enrolled',
        'the owner has no TOTP authenticator enrolled (PRD F12.5)',
        {},
      );
    }

    const now = stepFor(this.#now());
    for (const factor of candidates) {
      const secret = decodeBase32(await this.#secrets.resolve(factor.secretRef!));
      for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
        const step = now + drift;
        if (!codesMatch(code, totpCode(secret, step))) continue;

        // The code is right. Whether it may be *used* is a separate question:
        // a code is valid for a whole step, so one seen in transit can be
        // replayed inside that window unless the step is remembered.
        if (factor.lastStep !== null && step <= factor.lastStep) {
          await this.#record(factor.id, 'totp', false, 'mfa.replayed', context);
          throw new PalugadaError(
            'mfa.replayed',
            'that code has already been used (PRD F12.5)',
            { authenticatorId: factor.id },
          );
        }

        await this.#advance(factor.id, { lastStep: step });
        await this.#record(factor.id, 'totp', true, null, context);
        return { authenticatorId: factor.id, kind: 'totp', label: factor.label };
      }
    }

    await this.#record(null, 'totp', false, 'mfa.code_invalid', context);
    throw new PalugadaError('mfa.code_invalid', 'that code is not valid (PRD F12.5)', {});
  }

  /** A challenge for the phone to sign. Usable once and short-lived. */
  challenge(): string {
    return this.#challenges.issue(this.#now().getTime());
  }

  /**
   * Checks a WebAuthn assertion -- F12.5's "mobile biometrik".
   *
   * Every refusal below is a real attack rather than a formality, and the
   * comments say which, because a check whose reason is not written down is a
   * check somebody eventually deletes for being redundant.
   */
  async verifyWebAuthn(
    assertion: WebAuthnAssertion,
    context: { purpose?: string; subjectId?: string | null } = {},
  ): Promise<VerifiedFactor> {
    const factor = (await this.enrolled()).find(
      (candidate) =>
        candidate.kind === 'webauthn' && candidate.credentialId === assertion.credentialId,
    );
    if (!factor) {
      await this.#record(null, 'webauthn', false, 'mfa.unknown_credential', context);
      throw new PalugadaError(
        'mfa.unknown_credential',
        'that credential is not enrolled (PRD F12.5)',
        { credentialId: assertion.credentialId },
      );
    }

    const authenticatorData = Buffer.from(assertion.authenticatorData, 'base64url');
    const clientDataJSON = Buffer.from(assertion.clientDataJSON, 'base64url');
    const signature = Buffer.from(assertion.signature, 'base64url');

    const refuse = async (code: ErrorCode, message: string): Promise<never> => {
      await this.#record(factor.id, 'webauthn', false, code, context);
      throw new PalugadaError(code, `${message} (PRD F12.5)`, { authenticatorId: factor.id });
    };

    let clientData: { type?: string; challenge?: string; origin?: string };
    try {
      clientData = JSON.parse(clientDataJSON.toString('utf8')) as typeof clientData;
    } catch {
      return refuse('mfa.assertion_malformed', 'clientDataJSON is not JSON');
    }

    // The ceremony the client says it performed. An authenticator will sign a
    // registration ceremony too, and accepting one here would let a signature
    // collected while enrolling a *new* key authorise an action.
    if (clientData.type !== 'webauthn.get') {
      return refuse('mfa.wrong_ceremony', `clientData names ceremony ${clientData.type}`);
    }

    // The replay defence. Without it the entire assertion is a fixed string
    // that anyone who saw it once can send again for ever.
    if (!clientData.challenge || !this.#challenges.redeem(clientData.challenge, this.#now().getTime())) {
      return refuse('mfa.challenge_unknown', 'the assertion answers no challenge this process issued');
    }

    // Where it was collected. An origin check is what stops a signature
    // gathered by another site -- one the owner also uses this phone with --
    // from being presented here.
    if (this.#origin !== null && clientData.origin !== this.#origin) {
      return refuse('mfa.wrong_origin', `the assertion was collected at ${clientData.origin}`);
    }

    const parsed = parseAuthenticatorData(authenticatorData);

    // The same argument as the origin, made by the authenticator rather than
    // by the browser: the RP id hash is what the *device* believed it was
    // signing for, and it is not forgeable by a page.
    const expectedRpIdHash = createHash('sha256').update(this.#rpId).digest();
    if (!parsed.rpIdHash.equals(expectedRpIdHash)) {
      return refuse('mfa.wrong_relying_party', 'the assertion was signed for another relying party');
    }

    // F12.5 says *biometric*. A key that is merely present was touched; a key
    // that is user-verified was unlocked by a fingerprint, a face or a PIN.
    // The difference is a phone in someone else's hand.
    if (!parsed.userPresent || !parsed.userVerified) {
      return refuse(
        'mfa.not_user_verified',
        'the authenticator did not verify the person holding it',
      );
    }

    if (!verifySignature(factor.publicKey!, authenticatorData, clientDataJSON, signature)) {
      return refuse('mfa.signature_invalid', 'the signature does not match the enrolled key');
    }

    // An authenticator counts its own signatures. A counter that fails to
    // advance means either a replay or a cloned key, and both are the same
    // answer. Zero is the documented "this authenticator does not count",
    // which is common on platform authenticators and is not evidence of
    // anything.
    if (parsed.signCount !== 0 && parsed.signCount <= factor.signCount) {
      return refuse(
        'mfa.counter_did_not_advance',
        `the signature counter went from ${factor.signCount} to ${parsed.signCount}`,
      );
    }

    await this.#advance(factor.id, { signCount: parsed.signCount });
    await this.#record(factor.id, 'webauthn', true, null, context);
    return { authenticatorId: factor.id, kind: 'webauthn', label: factor.label };
  }

  async #advance(
    authenticatorId: string,
    state: { lastStep?: number; signCount?: number },
  ): Promise<void> {
    await withControlPlane(async (tx) => {
      await tx.query(
        `UPDATE owner_authenticators
            SET last_step = coalesce($2, last_step),
                sign_count = coalesce($3, sign_count),
                last_used_at = now()
          WHERE id = $1`,
        [authenticatorId, state.lastStep ?? null, state.signCount ?? null],
      );
    });
  }

  /**
   * Records the attempt, successful or not.
   *
   * Failures are kept because a burst of them against the owner's
   * authenticator is the shape of somebody trying, and a log that only kept
   * successes would hide exactly that.
   */
  async #record(
    authenticatorId: string | null,
    kind: FactorKind,
    succeeded: boolean,
    reason: string | null,
    context: { purpose?: string; subjectId?: string | null },
  ): Promise<void> {
    await withControlPlane(async (tx) => {
      await tx.query(
        `INSERT INTO owner_authentications
           (authenticator_id, kind, succeeded, reason, purpose, subject_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          authenticatorId,
          kind,
          succeeded,
          reason,
          context.purpose ?? null,
          context.subjectId ?? null,
        ],
      );
    });
  }
}

/**
 * A fresh TOTP secret and the URI an authenticator app scans.
 *
 * The secret is registered with the redactor on the way out: it is about to
 * appear in a QR code and a log line at the same moment, and the whole of
 * F12.4 is that the second one does not happen.
 */
export function newTotpSecret(label: string, issuer = 'PALUGADA'): {
  secret: string;
  uri: string;
} {
  const secret = encodeBase32(randomBytes(20));
  redactor.register(secret);
  const uri =
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
  return { secret, uri };
}
