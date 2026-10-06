/**
 * How the owner proves they are the owner (PRD v2 F12.5, F10.10).
 *
 * PALUGADA has exactly one owner (§5 principle 1), so this is not an identity
 * system: there are no accounts, no roles and nothing to look up. The only
 * question is whether the person at the far end holds one of the owner's
 * enrolled devices, and `OwnerMfa` already answers that -- against RFC 6238
 * arithmetic or a P-256 signature, not against a caller's word. The staff
 * seats beside the owner (0110) are not sessions of this kind: they have
 * devices and sessions of their own (staff.ts), and nothing here reads them.
 *
 * So a session is exactly that answer, made durable for a while. Signing in is
 * presenting a second factor; the token that comes back says which factor it
 * was and when, and every request carries it.
 *
 * **The distinction that does the work.** A session is *not* a second factor.
 * F10.10 asks a tier 3 approval to be given "through the app **with MFA**", and
 * a token minted eight hours ago is possession of a browser tab, not of the
 * owner's phone. So `decide` still takes a fresh proof for tier 3, and the
 * session only establishes that the request came from the app at all. That is
 * why `assurance` on a session is `session` and never `mfa`: the two answer
 * different questions and collapsing them is exactly the shortcut F10.10
 * exists to forbid.
 *
 * **Held in the database, as a hash.** They were held in each process's
 * memory, on the argument that a session should not outlive the process that
 * issued it. The cost of that turned out to be the property it bought: a
 * deployment with two consoles behind one address signed the owner in to one
 * of them, and a device revoked through one process stayed signed in on every
 * other. So a session is a row (0050) that every process reads -- and what is
 * stored is the token's hash, so a backup is not a way in. A session ends when
 * it is signed out, when its time is up, or when the device that signed it in
 * is revoked, which is checked on every request rather than remembered, so it
 * holds whichever process and whichever path did the revoking.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { FactorKind, OwnerMfa, VerifiedFactor, WebAuthnAssertion } from './mfa.ts';

export interface OwnerSession {
  token: string;
  /** Which device signed in, so a sign-in is answerable months later. */
  factor: VerifiedFactor;
  issuedAt: Date;
  expiresAt: Date;
  /**
   * When the owner last showed a code or a passkey, for the window it opens
   * (0120). Null for a session signed in with a recovery code, which proves
   * less than a device and opens none.
   */
  provedAt: Date | null;
}

export interface SessionOptions {
  mfa: OwnerMfa;
  /** How long a sign-in lasts. Eight hours: a working day, not a fortnight. */
  ttlMs?: number;
  now?: () => Date;
}

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export class OwnerSessions {
  readonly #mfa: OwnerMfa;
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(options: SessionOptions) {
    this.#mfa = options.mfa;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** A challenge for a passkey sign-in. Usable once. */
  challenge(): string {
    return this.#mfa.challenge();
  }

  /**
   * Signs in, which means presenting a second factor.
   *
   * The same verification a tier 3 approval uses, including the lockout: an
   * attacker who can guess at the sign-in endpoint without limit has the same
   * six digits to find as one guessing at an approval, and there is no reason
   * the cheaper door should be the weaker one.
   */
  async signIn(
    proof: { totp: string } | { webauthn: WebAuthnAssertion } | { recovery: string },
  ): Promise<OwnerSession> {
    // A recovery code signs in like a device, and the session says so: the
    // console then asks for a new device, and a code still approves nothing.
    const factor =
      'totp' in proof
        ? await this.#mfa.verifyTotp(proof.totp, { purpose: 'owner.sign_in' })
        : 'recovery' in proof
          ? await this.#mfa.verifyRecoveryCode(proof.recovery, { purpose: 'owner.sign_in' })
          : await this.#mfa.verifyWebAuthn(proof.webauthn, { purpose: 'owner.sign_in' });

    const issuedAt = this.#now();
    const session: OwnerSession = {
      token: randomBytes(32).toString('base64url'),
      factor,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.#ttlMs),
      provedAt: 'recovery' in proof ? null : issuedAt,
    };
    await withControlPlane(async (tx) => {
      // Sessions over and done with for a day are litter, and swept by the
      // next sign-in rather than by a job of their own.
      await tx.query(
        `DELETE FROM owner_sessions
          WHERE expires_at < $1::timestamptz - interval '1 day'
             OR ended_at < $1::timestamptz - interval '1 day'`,
        [issuedAt],
      );
      await tx.query(
        `INSERT INTO owner_sessions (token_hash, authenticator_id, issued_at, expires_at, proved_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [hashToken(session.token), factor.authenticatorId, session.issuedAt, session.expiresAt, session.provedAt],
      );
    });
    return session;
  }

  /**
   * The session behind a request, or nothing.
   *
   * Looked up by the token's hash. The comparison that matters is the
   * database's equality on a digest of 32 random bytes, which leaks nothing a
   * timing attack could walk.
   */
  async verify(token: string | undefined): Promise<OwnerSession | null> {
    if (!token) return null;
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{
        issued_at: Date; expires_at: Date; proved_at: Date | null; authenticator_id: string; kind: FactorKind; label: string;
      }>(
        `SELECT s.issued_at, s.expires_at, s.proved_at, a.id AS authenticator_id, a.kind, a.label
           FROM owner_sessions s
           JOIN owner_authenticators a ON a.id = s.authenticator_id
          WHERE s.token_hash = $1
            AND s.ended_at IS NULL
            AND s.expires_at > $2
            AND a.revoked_at IS NULL`,
        [hashToken(token), this.#now()],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        token,
        factor: { authenticatorId: row.authenticator_id, kind: row.kind, label: row.label },
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        provedAt: row.proved_at,
      };
    });
  }

  /**
   * The owner has just shown a code or a passkey: the window opens from now.
   * Not for a recovery code, and never extended by what the window covers --
   * only a fresh proof moves it.
   */
  async prove(token: string): Promise<void> {
    await withControlPlane((tx) => tx.query(
      'UPDATE owner_sessions SET proved_at = $2 WHERE token_hash = $1 AND ended_at IS NULL', [hashToken(token), this.#now()]));
  }

  async signOut(token: string): Promise<void> {
    await this.#end('token_hash = $1', [hashToken(token)]);
  }

  /**
   * Every session signed in with one authenticator.
   *
   * Redundant with the check `verify` makes on every request, and kept: the
   * rows say they ended, which is what an auditor reading them needs.
   */
  async signOutFactor(authenticatorId: string): Promise<number> {
    return this.#end('authenticator_id = $1', [authenticatorId]);
  }

  /** Every live session, for a "sign out everywhere" the owner can reach. */
  async signOutAll(): Promise<number> {
    return this.#end('true', []);
  }

  async require(token: string | undefined): Promise<OwnerSession> {
    const session = await this.verify(token);
    if (!session) {
      throw new PalugadaError('owner.unauthenticated', 'sign in first (PRD F12.5)', {});
    }
    return session;
  }

  /** Ends the live sessions `where` selects; `$1` in it is the first value. */
  async #end(where: string, values: unknown[]): Promise<number> {
    return withControlPlane(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE owner_sessions SET ended_at = $${values.length + 1}
          WHERE ended_at IS NULL AND ${where}`,
        [...values, this.#now()],
      );
      return rowCount ?? 0;
    });
  }
}

/** What is stored in place of a token: its SHA-256, hex. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
