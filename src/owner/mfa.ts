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
import { createHmac, createPublicKey, createVerify, randomBytes, createHash, timingSafeEqual, verify } from 'node:crypto';
import { PalugadaError, type ErrorCode } from '../errors.ts';
import { PASSKEY_ALGORITHMS, parseAttestation } from './passkey.ts';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';

export type FactorKind = 'totp' | 'webauthn' | 'recovery';

/**
 * What a recovery code may be presented for: getting back in, and putting a
 * device in the lost one's place. Nothing that approves or loosens a rule --
 * a code is paper in a drawer, weaker than a phone behind a fingerprint.
 */
export const RECOVERY_PURPOSES: readonly string[] = [
  'owner.sign_in',
  'console.add a passkey',
  'console.revoke an authenticator',
  'console.make new recovery codes',
];

/** How many codes one set holds. */
export const RECOVERY_CODES = 10;

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
  readonly #max: number;

  /**
   * `max` bounds what is held at once. The sign-in page asks for a challenge
   * before anyone has signed in, so issuing one is open to anybody who can
   * reach the console, and an unbounded map is memory a stranger can fill at
   * the speed of their connection. Past the bound the oldest outstanding
   * challenge is dropped: an owner whose challenge was pushed out by a flood
   * asks for another, which is a retry, not an outage.
   */
  constructor(ttlMs = 120_000, max = 1_000) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  issue(now: number = Date.now()): string {
    this.#sweep(now);
    // A Map iterates in insertion order, so the first key is the oldest.
    while (this.#issued.size >= this.#max) {
      this.#issued.delete(this.#issued.keys().next().value!);
    }
    const challenge = randomBytes(32).toString('base64url');
    this.#issued.set(challenge, now + this.#ttlMs);
    return challenge;
  }

  /** How long a challenge is good for, which is how long a browser should wait for the owner. */
  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** How many challenges are outstanding. */
  get size(): number {
    return this.#issued.size;
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
  try {
    // Ed25519 signs the message itself rather than a digest of it, so it has
    // no hash to name and `createVerify` cannot check it.
    if (key.asymmetricKeyType === 'ed25519') return verify(null, signed, key, signature);
    const algorithm = key.asymmetricKeyType === 'rsa' ? 'RSA-SHA256' : 'SHA256';
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

/** `PublicKeyCredentialCreationOptions`, with every buffer as base64url. */
export interface PasskeyOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  /** COSE algorithm numbers, most preferred first. */
  algorithms: number[];
  /** Credential ids of the passkeys already enrolled. */
  exclude: string[];
  timeoutMs: number;
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

/** What one verification decided, before it is recorded and answered. */
type Attempt =
  | { factor: VerifiedFactor }
  | {
    refused: ErrorCode;
    message: string;
    details: Record<string, unknown>;
    authenticatorId: string | null;
  };

function refused(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  authenticatorId: string | null = null,
): Attempt {
  return { refused: code, message, details, authenticatorId };
}

/** Refusals made without comparing anything, which the lockout does not count. */
const NOT_A_GUESS: readonly ErrorCode[] = ['mfa.locked_out', 'mfa.not_enrolled', 'mfa.factor_unavailable'];

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
   * Whether `code` is what an app holding `secret` shows now, with the drift a
   * sign-in allows. For a secret not enrolled yet -- the one offered to the
   * first owner (src/owner/claim.ts) -- so no step is claimed here; enrolling
   * it and signing in with the same code claims it.
   */
  fits(secret: Buffer, code: string): boolean {
    const now = stepFor(this.#now());
    let fits = false;
    for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
      if (codesMatch(code, totpCode(secret, now + drift))) fits = true;
    }
    return fits;
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
    /**
     * Only while the owner has no live authenticator at all: the first
     * owner's claim (src/owner/claim.ts). Checked under a lock in the same
     * transaction as the insert, so two claims opened at once make one
     * owner, and a claim finished after the operator enrolled one from the
     * environment makes none.
     */
    first?: boolean;
  }): Promise<string> {
    return withControlPlane(async (tx) => {
      if (input.first) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('palugada.owner_first_factor'))");
        const { rows: live } = await tx.query(
          'SELECT 1 FROM owner_authenticators WHERE revoked_at IS NULL AND company_id IS NULL LIMIT 1');
        if (live.length > 0) {
          throw new PalugadaError('owner.claimed',
            'this deployment already has an owner: sign in with their device', {});
        }
      }
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

      // The check above is a read, and two replicas enrolling the owner's
      // configured factor at the same boot both pass it. The partial unique
      // index from 0040 is what actually holds, and its violation is the same
      // refusal rather than a raw database error.
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO owner_authenticators (company_id, kind, label, secret_ref)
           VALUES ($1, 'totp', $2, $3) RETURNING id`,
          [input.companyId ?? null, input.label, input.secretRef],
        );
        return rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new PalugadaError(
            'mfa.already_enrolled',
            `${input.secretRef} was enrolled by another process at the same moment`,
            { secretRef: input.secretRef },
          );
        }
        throw error;
      }
    });
  }

  /**
   * Whether a secret reference has ever backed an authenticator, and whether
   * that authenticator is still live.
   *
   * `enrolled()` lists live factors only, which is right for signing in and
   * wrong for a boot deciding whether to enrol a configured secret: a factor
   * the owner revoked -- because the phone was lost, because the secret
   * leaked -- is absent from that list, and a boot that read absence as "not
   * yet enrolled" put it straight back.
   */
  async secretRefState(secretRef: string): Promise<'unused' | 'live' | 'revoked'> {
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ live: boolean }>(
        `SELECT bool_or(revoked_at IS NULL) AS live
           FROM owner_authenticators WHERE secret_ref = $1`,
        [secretRef],
      );
      const live = rows[0]?.live;
      return live === null || live === undefined ? 'unused' : live ? 'live' : 'revoked';
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
   * Makes the owner a new set of recovery codes, and ends the old set.
   *
   * Ten codes of sixteen base32 characters: eighty random bits each, so the
   * SHA-256 kept in their place is beyond guessing from a backup, as a
   * session token's is. Returned once, to be written down; nothing can show
   * them again. The old set is revoked in the same transaction, so a sheet
   * the owner threw away stops working the moment the new one exists, and
   * the sessions it signed in end with it.
   */
  async issueRecoveryCodes(): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODES }, () =>
      encodeBase32(randomBytes(10)).toLowerCase().replace(/(.{4})(?!$)/g, '$1-'));
    await withControlPlane(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('palugada:owner-mfa'))");
      const { rows: old } = await tx.query<{ id: string }>(
        `UPDATE owner_authenticators SET revoked_at = now()
          WHERE kind = 'recovery' AND company_id IS NULL AND revoked_at IS NULL RETURNING id`);
      if (old.length > 0) {
        await tx.query('UPDATE owner_sessions SET ended_at = now() WHERE ended_at IS NULL AND authenticator_id = ANY ($1::uuid[])',
          [old.map((row) => row.id)]);
      }
      const { rows } = await tx.query<{ id: string }>(
        "INSERT INTO owner_authenticators (kind, label) VALUES ('recovery', 'Recovery codes') RETURNING id");
      for (const code of codes) {
        await tx.query('INSERT INTO owner_recovery_codes (code_hash, authenticator_id) VALUES ($1, $2)',
          [recoveryHash(code), rows[0]!.id]);
      }
    });
    return codes;
  }

  /** How many codes of the live set are left, or null when the owner has none. */
  async recoveryCodesLeft(): Promise<number | null> {
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ left: number }>(
        `SELECT count(c.code_hash) FILTER (WHERE c.used_at IS NULL)::int AS left
           FROM owner_authenticators a LEFT JOIN owner_recovery_codes c ON c.authenticator_id = a.id
          WHERE a.kind = 'recovery' AND a.company_id IS NULL AND a.revoked_at IS NULL
          GROUP BY a.id`);
      return rows[0]?.left ?? null;
    });
  }

  /**
   * Checks a recovery code, and spends it.
   *
   * Only for what `RECOVERY_PURPOSES` names; anything else is refused before
   * the code is looked at, so a code offered to approve something is not
   * spent on the refusal. Typed from paper, so case, spaces and dashes are
   * forgiven. Not counted by the lockout, like a passkey: eighty bits cannot
   * be guessed, and counting them would let anyone lock the owner out of the
   * one way back in by knocking.
   */
  async verifyRecoveryCode(code: string, context: VerificationContext = {}): Promise<VerifiedFactor> {
    if (!RECOVERY_PURPOSES.includes(context.purpose ?? '')) {
      throw new PalugadaError('approval.channel_forbidden',
        'a recovery code signs you in and adds a device; it does not approve or change anything else. '
          + 'Add a passkey with it, then use the passkey (PRD F10.10, F12.5)',
        { purpose: context.purpose ?? null });
    }
    return this.#attempt('recovery', context, async (tx) => {
      const { rows } = await tx.query<{ authenticator_id: string; used_at: Date | null }>(
        `SELECT c.authenticator_id, c.used_at
           FROM owner_recovery_codes c JOIN owner_authenticators a ON a.id = c.authenticator_id
          WHERE c.code_hash = $1 AND a.revoked_at IS NULL AND a.company_id IS NULL`,
        [recoveryHash(code)]);
      const found = rows[0];
      if (!found) return refused('mfa.code_invalid', 'that is not one of your recovery codes');
      // Spent by the write, so two presentations at once cannot both pass.
      const { rowCount } = await tx.query(
        'UPDATE owner_recovery_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL', [recoveryHash(code)]);
      if (rowCount !== 1) {
        return refused('mfa.replayed', 'that recovery code has already been used', {}, found.authenticator_id);
      }
      await tx.query('UPDATE owner_authenticators SET last_used_at = now() WHERE id = $1', [found.authenticator_id]);
      return { factor: { authenticatorId: found.authenticator_id, kind: 'recovery', label: 'Recovery codes' } };
    });
  }

  /**
   * Revokes one of the owner's own devices, and never the last.
   *
   * The owner's platform-wide factors are the only way in: without one the
   * console cannot be signed in to and no tier 3 action can ever be approved,
   * and the way back is a restart with a new secret configured. So the last
   * is refused, with the way out named. Under the verification lock, so two
   * revocations at once -- one per remaining device -- cannot both see the
   * other still standing.
   */
  async revokeOwnDevice(authenticatorId: string): Promise<void> {
    await withControlPlane(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('palugada:owner-mfa'))");
      const { rows } = await tx.query<{ id: string; kind: FactorKind }>(
        `SELECT id, kind FROM owner_authenticators
          WHERE company_id IS NULL AND revoked_at IS NULL`,
      );
      const target = rows.find((row) => row.id === authenticatorId);
      if (!target) {
        throw new PalugadaError(
          'contract.violation',
          'no live authenticator of the owner has that id',
          { authenticatorId },
        );
      }
      // Recovery codes are not a device: they approve nothing, so a phone
      // with only codes beside it is still the only authenticator.
      const devices = rows.filter((row) => row.kind !== 'recovery');
      if (target.kind !== 'recovery' && devices.length === 1) {
        throw new PalugadaError(
          'contract.violation',
          'that is the owner\'s only authenticator: enrol another before revoking it, or '
            + 'nothing could sign in or approve a tier 3 action again (PRD F12.5)',
          { authenticatorId },
        );
      }
      await tx.query('UPDATE owner_authenticators SET revoked_at = now() WHERE id = $1', [
        authenticatorId,
      ]);
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
    const factors = (await this.enrolled(context.companyId ?? null))
      .filter((factor) => factor.kind === 'totp');
    // Resolved before the attempt's lock is taken: a secret store can be a
    // network hop away, and the lock queues every other attempt behind it.
    const keyed = await Promise.all(factors.map(async (factor) => ({
      factor,
      secret: await this.#secretFor(factor),
    })));

    return this.#attempt('totp', context, async (tx) => {
      if (factors.length === 0) {
        return refused('mfa.not_enrolled', 'the owner has no TOTP authenticator enrolled');
      }
      // One authenticator whose secret the store cannot produce any more --
      // an unset variable, a file that was rotated away -- must not lock the
      // owner out of the others. A second device is enrolled for exactly the
      // day the first one is unusable.
      const usable = keyed.filter((entry): entry is { factor: OwnerAuthenticator; secret: Buffer } =>
        entry.secret !== null);
      const unreadable = keyed.filter((entry) => entry.secret === null).map((entry) => entry.factor.label);
      if (usable.length === 0) {
        return refused(
          'mfa.factor_unavailable',
          `the secret behind ${unreadable.join(', ')} cannot be read from the secret store, `
            + 'so no code can be checked',
          { authenticators: unreadable },
        );
      }

      const now = stepFor(this.#now());
      for (const { factor, secret } of usable) {
        for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
          const step = now + drift;
          if (!codesMatch(code, totpCode(secret, step))) continue;

          // The code is right. Whether it may be *used* is a separate
          // question: a code is valid for a whole step, so one seen in transit
          // can be replayed inside that window unless the step is remembered.
          //
          // Claimed by the write rather than by a read before it. The UPDATE
          // only matches while the step is still unclaimed, so a second
          // presentation of the same code changes no rows and is refused.
          if (!(await this.#claimStep(tx, factor.id, step))) {
            return refused('mfa.replayed', 'that code has already been used', { authenticatorId: factor.id }, factor.id);
          }
          return { factor: { authenticatorId: factor.id, kind: 'totp', label: factor.label } };
        }
      }

      return refused(
        'mfa.code_invalid',
        unreadable.length === 0
          ? 'that code is not valid'
          : `that code is not valid; the secret behind ${unreadable.join(', ')} could not be read, `
            + 'so codes from it were not checked',
      );
    });
  }

  /** The decoded secret behind a TOTP factor, or null when it cannot be had. */
  async #secretFor(factor: OwnerAuthenticator): Promise<Buffer | null> {
    try {
      return decodeBase32(await this.#secrets.resolve(factor.secretRef!));
    } catch {
      return null;
    }
  }

  /** A challenge for the phone to sign. Usable once and short-lived. */
  challenge(): string {
    return this.#challenges.issue(this.#now().getTime());
  }

  /**
   * Where a passkey is made and used: the relying party the authenticator
   * signs for, and the page's origin the browser reports. The console asks
   * the browser for the first, and compares the second with where it was
   * opened, so it can say why a passkey cannot work here instead of letting
   * the browser fail with a sentence nobody can act on.
   */
  get relyingParty(): { rpId: string; origin: string } {
    return { rpId: this.#rpId, origin: this.#origin };
  }

  /**
   * What the console hands `navigator.credentials.create`, as text.
   *
   * The user handle is new for every passkey rather than one per owner. A
   * browser that is asked to make a passkey for a relying party and a handle
   * it already holds one for replaces the old one -- and every deployment on
   * `localhost` is one relying party, so a fixed handle meant adding a passkey
   * to one deployment silently deleted it from another. Nothing here reads the
   * handle back: the credential id is what names a passkey.
   *
   * `exclude` is every live passkey, so the browser refuses to make a second
   * one on a device that already holds one for this console.
   */
  async passkeyOptions(): Promise<PasskeyOptions> {
    const exclude = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ credential_id: string }>(
        `SELECT credential_id FROM owner_authenticators
          WHERE kind = 'webauthn' AND revoked_at IS NULL
          ORDER BY enrolled_at`,
      );
      return rows.map((row) => row.credential_id);
    });
    return {
      challenge: this.challenge(),
      rp: { id: this.#rpId, name: 'PALUGADA' },
      user: { id: randomBytes(16).toString('base64url'), name: 'PALUGADA owner', displayName: 'PALUGADA owner' },
      algorithms: [...PASSKEY_ALGORITHMS],
      exclude,
      timeoutMs: this.#challenges.ttlMs,
    };
  }

  /**
   * Enrols the passkey a browser just made -- the registration ceremony.
   *
   * The same checks as an assertion where the same attack applies, each for
   * the reason written there: the ceremony type (a signature the owner gave to
   * approve something is not a new key), the challenge (a registration seen
   * once, in a proxy's log say, must not put a revoked key back), the origin
   * and the relying party (a passkey made for another site), and a person
   * verified on the device. What is not checked is who made the device; see
   * `parseAttestation`.
   *
   * The caller has already required a factor the owner holds. A session alone
   * is not enough to add one: a session taken from a browser would otherwise
   * leave its thief a key that outlives the session.
   */
  async enrolPasskey(input: {
    label: string;
    clientDataJSON: string;
    attestationObject: string;
    /** The credential id the browser reported, which must be the one inside. */
    id?: string;
  }): Promise<{ id: string; label: string }> {
    const label = input.label.trim();
    if (!label || label.length > 80) {
      throw new PalugadaError(
        'contract.violation',
        'a passkey needs a name of 1 to 80 characters, so the owner can tell their devices apart',
        { length: label.length },
      );
    }

    let clientData: { type?: string; challenge?: string; origin?: string };
    try {
      clientData = JSON.parse(Buffer.from(input.clientDataJSON, 'base64url').toString('utf8')) as typeof clientData;
    } catch {
      throw new PalugadaError('mfa.attestation_malformed', 'clientDataJSON is not JSON', {});
    }
    if (clientData.type !== 'webauthn.create') {
      throw new PalugadaError('mfa.wrong_ceremony', `a new passkey comes from webauthn.create; this names ${String(clientData.type)}`, {});
    }
    if (!clientData.challenge || !this.#challenges.redeem(clientData.challenge, this.#now().getTime())) {
      throw new PalugadaError('mfa.challenge_unknown', 'the new passkey answers no challenge this process issued, or one already used', {});
    }
    if (clientData.origin !== this.#origin) {
      throw new PalugadaError(
        'mfa.wrong_origin',
        `the passkey was made at ${String(clientData.origin)}, and this console is ${this.#origin} `
          + '(PALUGADA_ORIGIN, or the origin of PALUGADA_APP_URL_PUBLIC)',
        { origin: clientData.origin ?? null },
      );
    }

    const made = parseAttestation(Buffer.from(input.attestationObject, 'base64url'));
    if (!made.rpIdHash.equals(createHash('sha256').update(this.#rpId).digest())) {
      throw new PalugadaError('mfa.wrong_relying_party', `the passkey was made for another relying party than ${this.#rpId}`, {});
    }
    if (!made.userPresent || !made.userVerified) {
      throw new PalugadaError('mfa.not_user_verified', 'the authenticator did not verify the person holding it', {});
    }
    if (input.id !== undefined && input.id !== made.credentialId) {
      throw new PalugadaError(
        'mfa.attestation_malformed',
        'the credential id the browser reported is not the one the authenticator made',
        {},
      );
    }

    try {
      const id = await this.enrolWebAuthn({
        label,
        credentialId: made.credentialId,
        publicKeyPem: made.publicKeyPem,
        signCount: made.signCount,
      });
      return { id, label };
    } catch (error) {
      // The unique index on credential ids, revoked ones included: a key the
      // owner revoked is not made live again by registering it twice.
      if ((error as { code?: string }).code === '23505') {
        throw new PalugadaError('mfa.already_enrolled', 'that passkey is already enrolled, or was and has been revoked', {});
      }
      throw error;
    }
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
    const enrolled = await this.enrolled(context.companyId ?? null);
    return this.#attempt('webauthn', context, (tx) => this.#judgeAssertion(tx, enrolled, assertion));
  }

  async #judgeAssertion(
    tx: TenantClient,
    enrolled: readonly OwnerAuthenticator[],
    assertion: WebAuthnAssertion,
  ): Promise<Attempt> {
    const factor = enrolled.find(
      (candidate) =>
        candidate.kind === 'webauthn' && candidate.credentialId === assertion.credentialId,
    );
    if (!factor) {
      return refused('mfa.unknown_credential', 'that credential is not enrolled', {
        credentialId: assertion.credentialId,
      });
    }

    const authenticatorData = Buffer.from(assertion.authenticatorData, 'base64url');
    const clientDataJSON = Buffer.from(assertion.clientDataJSON, 'base64url');
    const signature = Buffer.from(assertion.signature, 'base64url');

    const refuse = (code: ErrorCode, message: string): Attempt =>
      refused(code, message, { authenticatorId: factor.id }, factor.id);

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

    // Returned as a refusal rather than thrown straight out: every attempt is
    // supposed to reach `owner_authentications`, and a stream of malformed assertions is one of
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
    //
    // And a zero from an authenticator that has counted before is not "this
    // one does not count" -- it is a counter that went backwards, which is
    // what a cloned key reports to skip this check. WebAuthn's own rule: if
    // either the stored count or the presented one is non-zero, the presented
    // one must be greater.
    const counts = parsed.signCount !== 0 || factor.signCount !== 0;
    if (counts && !(await this.#claimSignCount(tx, factor.id, parsed.signCount))) {
      return refuse(
        'mfa.counter_did_not_advance',
        `the signature counter went from ${factor.signCount} to ${parsed.signCount}`,
      );
    }
    if (!counts) await this.#touch(tx, factor.id);
    return { factor: { authenticatorId: factor.id, kind: 'webauthn', label: factor.label } };
  }

  /**
   * Runs one verification as one transaction, one at a time.
   *
   * The lockout used to be a read, a comparison and a write in three
   * transactions. An attacker does not send guesses one after another: a
   * thousand sent at once all read "no failures yet", and all of them were
   * compared. The transaction-scoped advisory lock queues them -- across
   * replicas too, since it lives in the database -- so each attempt is on the
   * record before the next one is judged. The owner makes a handful of these a
   * day; a queue costs nothing.
   *
   * Checked *before* the factor is compared rather than after. A lockout that
   * runs after the comparison is a lockout that still lets the millionth guess
   * through, and the right code is refused while locked, so an attacker cannot
   * tell a lockout from a wrong guess.
   *
   * A refusal is returned from inside rather than thrown, because a throw
   * would roll back exactly the row that says somebody tried.
   */
  async #attempt(
    kind: FactorKind,
    context: VerificationContext,
    judge: (tx: TenantClient) => Promise<Attempt>,
  ): Promise<VerifiedFactor> {
    const attempt = await withControlPlane(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('palugada:owner-mfa'))");
      // Only a code can be guessed, so only codes are locked, and only wrong
      // codes count. A passkey signs a challenge made a moment ago; counting
      // it with the codes let anybody who could reach the sign-in page lock
      // the owner out of the one factor nobody can guess.
      const failures = kind === 'totp' ? await this.#consecutiveFailures(tx, kind) : 0;
      const decided = failures >= this.#maxConsecutiveFailures
        ? refused(
          'mfa.locked_out',
          `too many failed attempts; the second factor is locked for `
            + `${Math.round(this.#lockoutMs / 60_000)} minutes`,
          { failures },
        )
        : await judge(tx);
      // Recorded either way, so the lockout itself is visible: an owner
      // asking "why will it not take my code" and an auditor asking "was
      // somebody trying" are reading the same table.
      await this.#record(tx, kind, decided, context);
      return decided;
    });
    if ('factor' in attempt) return attempt.factor;
    throw new PalugadaError(attempt.refused, `${attempt.message} (PRD F12.5)`, attempt.details);
  }

  /**
   * The failed guesses since the owner last got in, within the lockout window.
   *
   * Counted from the most recent success, so an owner who mistypes three
   * times and then gets it right has spent nothing -- and so a success is not
   * an amnesty. The first version asked whether *any* success fell inside the
   * window, which meant that once the owner had signed in, every guess an
   * attacker made for the next quarter of an hour counted as zero.
   *
   * Only guesses count. A refusal made without comparing anything -- the
   * lockout's own record, no factor enrolled, a secret the store cannot
   * produce -- tells an attacker nothing, and counting the lockout's records
   * would let anyone keep the owner locked out for as long as they kept
   * knocking.
   */
  async #consecutiveFailures(tx: TenantClient, kind: FactorKind): Promise<number> {
    const since = new Date(this.#now().getTime() - this.#lockoutMs);
    const { rows } = await tx.query<{ failures: number }>(
      `SELECT count(*)::int AS failures
         FROM owner_authentications
        WHERE occurred_at >= $1
          AND NOT succeeded
          AND kind = $3
          AND coalesce(reason, '') <> ALL ($2::text[])
          AND occurred_at > coalesce(
                (SELECT max(occurred_at) FROM owner_authentications
                  WHERE succeeded AND occurred_at >= $1),
                '-infinity')`,
      [since, NOT_A_GUESS, kind],
    );
    return rows[0]?.failures ?? 0;
  }

  /**
   * Takes the step, or reports that it was already taken.
   *
   * The condition is in the WHERE clause rather than in TypeScript because
   * that is what makes it atomic: PostgreSQL takes a row lock for the UPDATE,
   * so of two transactions presenting the same code the second re-evaluates
   * the predicate against the first one's result and matches nothing.
   */
  async #claimStep(tx: TenantClient, authenticatorId: string, step: number): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE owner_authenticators
          SET last_step = $2, last_used_at = now()
        WHERE id = $1 AND (last_step IS NULL OR last_step < $2)`,
      [authenticatorId, step],
    );
    return (rowCount ?? 0) === 1;
  }

  /** The same claim, for an authenticator's own signature counter. */
  async #claimSignCount(tx: TenantClient, authenticatorId: string, signCount: number): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE owner_authenticators
          SET sign_count = $2, last_used_at = now()
        WHERE id = $1 AND sign_count < $2`,
      [authenticatorId, signCount],
    );
    return (rowCount ?? 0) === 1;
  }

  /**
   * For an authenticator that does not count.
   *
   * There is nothing to claim, so this only records that the device was used.
   * The replay defence for these is the challenge, which `redeem` hands out
   * exactly once.
   */
  async #touch(tx: TenantClient, authenticatorId: string): Promise<void> {
    await tx.query('UPDATE owner_authenticators SET last_used_at = now() WHERE id = $1', [
      authenticatorId,
    ]);
  }

  /**
   * Records the attempt, successful or not.
   *
   * Failures are kept because a burst of them against the owner's
   * authenticator is the shape of somebody trying, and a log that only kept
   * successes would hide exactly that.
   */
  async #record(
    tx: TenantClient,
    kind: FactorKind,
    attempt: Attempt,
    context: VerificationContext,
  ): Promise<void> {
    const succeeded = 'factor' in attempt;
    // The wall clock rather than the transaction's start: attempts queue on
    // the lock, and one that began before the success ahead of it must still
    // be recorded after it, or it would not count as a failure since.
    await tx.query(
      `INSERT INTO owner_authentications
         (authenticator_id, kind, succeeded, reason, purpose, subject_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
      [
        succeeded ? attempt.factor.authenticatorId : attempt.authenticatorId,
        kind,
        succeeded,
        succeeded ? null : attempt.refused,
        context.purpose ?? null,
        context.subjectId ?? null,
      ],
    );
  }
}

/**
 * A fresh TOTP secret and the URI an authenticator app scans.
 *
 * The secret is registered with the redactor on the way out: it is about to
 * appear in a QR code and a log line at the same moment, and the whole of
 * F12.4 is that the second one does not happen.
 */
/** What is kept in a recovery code's place: the SHA-256 of the code as typed, less case, spaces and dashes. */
function recoveryHash(code: string): string {
  return createHash('sha256').update(code.toLowerCase().replace(/[\s-]/g, '')).digest('hex');
}

export function newTotpSecret(label: string, issuer = 'PALUGADA'): {
  secret: string;
  uri: string;
} {
  const secret = encodeBase32(randomBytes(20));
  redactor.register(secret);
  return { secret, uri: totpUri(secret, label, issuer) };
}

/** The `otpauth://` link an authenticator app reads, as text or as a QR code. */
export function totpUri(secret: string, label: string, issuer = 'PALUGADA'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
