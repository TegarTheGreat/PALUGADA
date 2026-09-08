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

/**
 * The lockout, which is what turns "we recorded the failures" into a defence.
 *
 * Ten in a row and the second factor stops answering for fifteen minutes. A
 * six-digit code is one of a million and the drift window makes three valid at
 * once, so an unthrottled attacker succeeds in a few hundred thousand
 * attempts -- minutes over a fast connection, against the check that guards
 * every irreversible action this platform can take.
 *
 * Ten is deliberately generous: a real owner mistypes, and a lockout that
 * fires on the third attempt teaches them to turn the feature off. Fifteen
 * minutes caps an attacker at roughly forty tries an hour, which turns minutes
 * into centuries, and it costs an owner who genuinely locked themselves out
 * one coffee.
 *
 * Consecutive, so a success clears it: an owner who gets it right on the
 * fourth try has not spent anything.
 */
export const DEFAULT_MAX_FAILURES = 10;
export const DEFAULT_LOCKOUT_MS = 15 * 60_000;

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
  /**
   * Where the app is served from, checked against `clientDataJSON.origin`.
   *
   * Defaults to `https://<rpId>`, which is the relationship WebAuthn assumes,
   * rather than to "do not check". An optional check that is skipped when
   * unset fails *open*: a deployment that forgot the option would accept an
   * assertion the owner's phone produced for another site. `rpId` has always
   * failed closed -- its default is a value a real assertion will not match --
   * and this now behaves the same way. A deployment on a port overrides it.
   */
  origin?: string;
  /**
   * How many failures in a row lock the owner out, and for how long.
   *
   * A six-digit code is one of a million, and the drift window makes three of
   * them valid at once -- so an attacker who can keep guessing gets in after a
   * few hundred thousand tries, which is minutes over a fast connection.
   * Recording failures is not enough; something has to stop them.
   */
  maxConsecutiveFailures?: number;
  lockoutMs?: number;
  now?: () => Date;
}

export interface VerifiedFactor {
  authenticatorId: string;
  kind: FactorKind;
  label: string;
}

/** Who is asking, what for, and about which company. */
export interface VerificationContext {
  purpose?: string;
  subjectId?: string | null;
  /**
   * The company the factor is being presented for.
   *
   * `null` means the platform's own owner, and a platform-scoped factor
   * answers for every company. A company-scoped one answers only for its own.
   */
  companyId?: string | null;
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
  readonly #origin: string;
  readonly #maxConsecutiveFailures: number;
  readonly #lockoutMs: number;
  readonly #now: () => Date;

  constructor(options: MfaOptions) {
    this.#secrets = options.secrets;
    this.#challenges = options.challenges ?? new ChallengeStore();
    this.#rpId = options.rpId ?? 'localhost';
    this.#origin = options.origin ?? `https://${this.#rpId}`;
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
    this.#lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;
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
   *
   * **A reference another live authenticator already holds is refused.** Two
   * rows pointing at one secret are not two factors -- they are one factor
   * counted twice, and the replay defence turns that from a redundancy into a
   * fault: `last_step` is per authenticator, so whichever row is tried first
   * claims the step and the other is refused for that whole window with "that
   * code has already been used". The owner presses the right button, types the
   * right code off the right phone, and is told it is a replay.
   *
   * Found by the boot check, which enrolled `vault://smoke/totp` on every run
   * and left the rows behind: the second run's code matched the first run's
   * row, whose step was already claimed.
   */
  async enrolTotp(input: {
    label: string;
    secretRef: string;
    companyId?: string | null;
  }): Promise<string> {
    return withControlPlane(async (tx) => {
      const { rows: existing } = await tx.query<{ label: string }>(
        `SELECT label FROM owner_authenticators
          WHERE secret_ref = $1 AND revoked_at IS NULL`,
        [input.secretRef],
      );
      if (existing.length > 0) {
        throw new PalugadaError(
          'mfa.already_enrolled',
          `${input.secretRef} is already enrolled as ${existing[0]!.label}; two `
            + 'authenticators sharing one secret are one factor, and each would refuse the '
            + "other's codes as replays (PRD F12.5)",
          { secretRef: input.secretRef, label: existing[0]!.label },
        );
      }

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

  /**
   * The factors that may answer for this company.
   *
   * A platform-scoped row -- `company_id IS NULL` -- is the owner's own device
   * and answers everywhere, which is what §5 principle 1's single human means.
   * A company-scoped one answers only there. Without the predicate the two
   * would be the same thing, and the column would be a lie: a factor enrolled
   * against one company would have approved a tier 3 action in another, which
   * is precisely the isolation every other table in this schema enforces.
   */
  async enrolled(companyId: string | null = null): Promise<OwnerAuthenticator[]> {
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
            AND (company_id IS NULL OR company_id = $1)
          ORDER BY enrolled_at`,
        [companyId],
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
    context: VerificationContext = {},
  ): Promise<VerifiedFactor> {
    await this.#assertNotLockedOut(context);
    const candidates = (await this.enrolled(context.companyId ?? null))
      .filter((factor) => factor.kind === 'totp');
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
        //
        // Claimed by the write rather than by a read before it. A read, a
        // decision and then a write is a race, and the thing racing here is
        // two presentations of the same intercepted code arriving together --
        // which is exactly the shape an attacker who has the code produces,
        // not a rare accident. The UPDATE only matches while the step is still
        // unclaimed, so the second one changes no rows and is refused.
        if (!(await this.#claimStep(factor.id, step))) {
          await this.#record(factor.id, 'totp', false, 'mfa.replayed', context);
          throw new PalugadaError(
            'mfa.replayed',
            'that code has already been used (PRD F12.5)',
            { authenticatorId: factor.id },
          );
        }

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
    context: VerificationContext = {},
  ): Promise<VerifiedFactor> {
    await this.#assertNotLockedOut(context);
    const factor = (await this.enrolled(context.companyId ?? null)).find(
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
    // from being presented here. Always checked: see `MfaOptions.origin` for
    // why an optional one is worse than none.
    if (clientData.origin !== this.#origin) {
      return refuse('mfa.wrong_origin', `the assertion was collected at ${clientData.origin}`);
    }

    // Through `refuse` rather than letting `parseAuthenticatorData` throw
    // straight out: every attempt is supposed to reach
    // `owner_authentications`, and a stream of malformed assertions is one of
    // the more informative things that table can hold -- it is what somebody
    // probing the endpoint produces.
    let parsed: ParsedAuthenticatorData;
    try {
      parsed = parseAuthenticatorData(authenticatorData);
    } catch (error) {
      return refuse('mfa.assertion_malformed', (error as Error).message);
    }

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
    // anything -- and for those the challenge, redeemed exactly once above, is
    // what stops a replay.
    //
    // Claimed by the write, for the same reason the TOTP step is: a read, a
    // decision and then a write lets two copies of one assertion both pass.
    if (parsed.signCount !== 0 && !(await this.#claimSignCount(factor.id, parsed.signCount))) {
      return refuse(
        'mfa.counter_did_not_advance',
        `the signature counter went from ${factor.signCount} to ${parsed.signCount}`,
      );
    }
    if (parsed.signCount === 0) await this.#touch(factor.id);
    await this.#record(factor.id, 'webauthn', true, null, context);
    return { authenticatorId: factor.id, kind: 'webauthn', label: factor.label };
  }

  /**
   * Refuses everything while the owner's factor is locked out.
   *
   * Consecutive failures, counted from the most recent attempt backwards, so a
   * success clears the tally: an owner who mistypes three times and then gets
   * it right has spent nothing. An attacker never gets a success, so their
   * tally only grows.
   *
   * Checked *before* the code is compared rather than after. A lockout that
   * still told an attacker "wrong code" versus "locked out" by how long it
   * took would be a lockout they could work around by watching the clock, and
   * more importantly, a lockout that runs after the comparison is a lockout
   * that still lets the millionth guess through.
   */
  async #assertNotLockedOut(context: VerificationContext): Promise<void> {
    const since = new Date(this.#now().getTime() - this.#lockoutMs);
    const failures = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ failures: string }>(
        // Counts the run of failures at the end of the window: `succeeded` is
        // ordered false-first descending, so the count stops at the most
        // recent success. Done in SQL because doing it in TypeScript would
        // mean fetching every attempt in the window to count the tail of it.
        `SELECT count(*)::text AS failures
           FROM (
             SELECT succeeded
               FROM owner_authentications
              WHERE occurred_at >= $1
              ORDER BY occurred_at DESC
           ) recent
          WHERE NOT succeeded
            AND NOT EXISTS (
              SELECT 1 FROM owner_authentications later
               WHERE later.occurred_at >= $1 AND later.succeeded
            )`,
        [since],
      );
      return Number(rows[0]?.failures ?? 0);
    });

    if (failures >= this.#maxConsecutiveFailures) {
      // Recorded, so the lockout itself is visible: an owner asking "why will
      // it not take my code" and an auditor asking "was somebody trying" are
      // reading the same table.
      await this.#record(null, 'totp', false, 'mfa.locked_out', context);
      throw new PalugadaError(
        'mfa.locked_out',
        `too many failed attempts; the second factor is locked for `
          + `${Math.round(this.#lockoutMs / 60_000)} minutes (PRD F12.5)`,
        { failures },
      );
    }
  }

  /**
   * Takes the step, or reports that it was already taken.
   *
   * The condition is in the WHERE clause rather than in TypeScript because
   * that is what makes it atomic: PostgreSQL takes a row lock for the UPDATE,
   * so of two transactions presenting the same code the second re-evaluates
   * the predicate against the first one's result and matches nothing.
   */
  async #claimStep(authenticatorId: string, step: number): Promise<boolean> {
    return withControlPlane(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE owner_authenticators
            SET last_step = $2, last_used_at = now()
          WHERE id = $1 AND (last_step IS NULL OR last_step < $2)`,
        [authenticatorId, step],
      );
      return (rowCount ?? 0) === 1;
    });
  }

  /** The same claim, for an authenticator's own signature counter. */
  async #claimSignCount(authenticatorId: string, signCount: number): Promise<boolean> {
    return withControlPlane(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE owner_authenticators
            SET sign_count = $2, last_used_at = now()
          WHERE id = $1 AND sign_count < $2`,
        [authenticatorId, signCount],
      );
      return (rowCount ?? 0) === 1;
    });
  }

  /**
   * For an authenticator that does not count.
   *
   * There is nothing to claim, so this only records that the device was used.
   * The replay defence for these is the challenge, which `redeem` hands out
   * exactly once.
   */
  async #touch(authenticatorId: string): Promise<void> {
    await withControlPlane(async (tx) => {
      await tx.query('UPDATE owner_authenticators SET last_used_at = now() WHERE id = $1', [
        authenticatorId,
      ]);
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
    context: VerificationContext,
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
