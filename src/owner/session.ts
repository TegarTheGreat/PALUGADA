/**
 * How the owner proves they are the owner (PRD v2 F12.5, F10.10).
 *
 * PALUGADA has exactly one human (§5 principle 1), so this is not an identity
 * system: there are no accounts, no roles and nothing to look up. The only
 * question is whether the person at the far end holds an enrolled device, and
 * `OwnerMfa` already answers that -- against RFC 6238 arithmetic or a P-256
 * signature, not against a caller's word.
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
 * **Held in memory, deliberately.** A session outlives a request and should
 * not outlive a restart: the owner signs in again, which costs one code and
 * removes a whole class of problem -- a stolen token that survives the process
 * that issued it, a table of them to sweep, a revocation path to get wrong.
 * A deployment that wants sessions across a restart is a deployment with more
 * than one process, and that is a different design decision to make
 * deliberately rather than to inherit from a convenience.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import type { OwnerMfa, VerifiedFactor, WebAuthnAssertion } from './mfa.ts';

export interface OwnerSession {
  token: string;
  /** Which device signed in, so a sign-in is answerable months later. */
  factor: VerifiedFactor;
  issuedAt: Date;
  expiresAt: Date;
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
  readonly #live = new Map<string, OwnerSession>();

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
    proof: { totp: string } | { webauthn: WebAuthnAssertion },
  ): Promise<OwnerSession> {
    const factor =
      'totp' in proof
        ? await this.#mfa.verifyTotp(proof.totp, { purpose: 'owner.sign_in' })
        : await this.#mfa.verifyWebAuthn(proof.webauthn, { purpose: 'owner.sign_in' });

    const issuedAt = this.#now();
    const session: OwnerSession = {
      token: randomBytes(32).toString('base64url'),
      factor,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.#ttlMs),
    };
    this.#sweep(issuedAt);
    this.#live.set(session.token, session);
    return session;
  }

  /**
   * The session behind a request, or nothing.
   *
   * Compared in constant time and only after a length check, because a token
   * is a shared secret and a comparison that returns early on the first
   * differing byte is one an attacker can walk.
   */
  verify(token: string | undefined): OwnerSession | null {
    if (!token) return null;
    const now = this.#now();
    for (const [candidate, session] of this.#live) {
      const a = Buffer.from(candidate);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) continue;
      if (session.expiresAt <= now) {
        this.#live.delete(candidate);
        return null;
      }
      return session;
    }
    return null;
  }

  signOut(token: string): void {
    this.#live.delete(token);
  }

  /** Every live session, for a "sign out everywhere" the owner can reach. */
  signOutAll(): number {
    const count = this.#live.size;
    this.#live.clear();
    return count;
  }

  require(token: string | undefined): OwnerSession {
    const session = this.verify(token);
    if (!session) {
      throw new PalugadaError('owner.unauthenticated', 'sign in first (PRD F12.5)', {});
    }
    return session;
  }

  #sweep(now: Date): void {
    for (const [token, session] of this.#live) {
      if (session.expiresAt <= now) this.#live.delete(token);
    }
  }
}
