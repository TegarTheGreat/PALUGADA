/**
 * The first owner, without a secret in the environment (F12.5, 0094).
 *
 * Signing in takes the owner's authenticator, and the first one came only
 * from `PALUGADA_OWNER_TOTP_REF`: a base32 secret made in a terminal by
 * `npm run setup` or `npm run totp:new`, put in the environment, and added
 * to a phone. A platform that runs the image -- Coolify, Dokploy -- has no
 * terminal for either, and generates passwords, not base32; the deployment
 * came up with nobody able to sign in.
 *
 * So a deployment with no owner makes a claim each time it starts and prints
 * its link. Whoever reads that log already holds the machine, so the link
 * grants nothing they did not have. Whoever opens it first is shown a new
 * secret, adds it to their authenticator app, confirms a code, and is signed
 * in with the one authenticator the deployment now has.
 *
 *   - The code is 160 random bits, kept only as its SHA-256; a wrong one is
 *     counted against the caller's address like a wrong sign-in code.
 *   - A claim lasts a day. Replicas starting together each make one; any of
 *     them works until the deployment has an owner.
 *   - Nothing is claimed while the owner has any live authenticator, checked
 *     under a lock in the transaction that enrols one, so a claim finished
 *     after the operator enrolled a phone from the environment adds nothing.
 *   - The secret offered is derived from the master key and the claim, not
 *     kept: opening the link twice, on a laptop and then a phone, shows the
 *     same one, and the code alone -- which stays in the log -- does not
 *     give it. It is sealed like any other secret once it is enrolled.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { redactor } from '../secrets/manager.ts';
import { deleteSecret, putSecret, type MasterKey } from '../settings/store.ts';
import { decodeBase32, encodeBase32, totpUri, type OwnerMfa } from './mfa.ts';
import { qrMatrix } from './qr.ts';
import type { OwnerSession, OwnerSessions } from './session.ts';

/** A day: long enough to deploy, read the log and find the phone. */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

function hashOf(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

async function owned(tx: TenantClient): Promise<boolean> {
  const { rows } = await tx.query(
    'SELECT 1 FROM owner_authenticators WHERE revoked_at IS NULL AND company_id IS NULL LIMIT 1');
  return rows.length > 0;
}

/**
 * A claim, made as a deployment with no owner starts: its code, for the link
 * the start prints. Null when the deployment has an owner.
 */
export async function openOwnerClaim(now: Date = new Date()): Promise<string | null> {
  return withControlPlane(async (tx) => {
    if (await owned(tx)) return null;
    // Claims spent or expired are litter, swept by the next one.
    await tx.query('DELETE FROM owner_claims WHERE expires_at < $1 OR claimed_at IS NOT NULL', [now]);
    const code = encodeBase32(randomBytes(20));
    await tx.query(
      'INSERT INTO owner_claims (code_hash, expires_at, created_at) VALUES ($1, $2, $3)',
      [hashOf(code), new Date(now.getTime() + CLAIM_TTL_MS), now],
    );
    return code;
  });
}

export interface ClaimOptions {
  mfa: OwnerMfa;
  sessions: OwnerSessions;
  /** The deployment's master key, which seals the owner's secret and derives the one offered. */
  master: () => MasterKey | null;
  now?: () => Date;
}

export interface ClaimOffer {
  /** The secret, in base32, for an app that cannot scan. */
  secret: string;
  /** The `otpauth://` link the QR code holds. */
  uri: string;
  /** The QR code's modules, a row to a string of 0 and 1, for the console to draw. */
  qr: string[];
}

export class OwnerClaims {
  readonly #options: ClaimOptions;

  constructor(options: ClaimOptions) {
    this.#options = options;
  }

  /** Whether the deployment has no owner yet, so a claim link is what signs in. */
  async claimable(): Promise<boolean> {
    return !(await withControlPlane(owned));
  }

  /** The link opened: the secret to add to the authenticator app. */
  async open(code: string, label: string): Promise<ClaimOffer> {
    const claim = await this.#live(code);
    const secret = this.#secretFor(claim);
    const uri = totpUri(secret, label);
    return { secret, uri, qr: qrMatrix(uri).map((row) => row.map((on) => (on ? '1' : '0')).join('')) };
  }

  /**
   * The code the app shows: the secret is sealed and enrolled as the owner's
   * one authenticator, every claim is spent, and the owner is signed in with
   * the same code.
   */
  async confirm(code: string, totp: string): Promise<OwnerSession> {
    const claim = await this.#live(code);
    const secret = this.#secretFor(claim);
    if (!this.#options.mfa.fits(decodeBase32(secret), totp)) {
      throw new PalugadaError('mfa.code_invalid',
        'that is not the code your app shows for this deployment: scan the code on this page, then enter the six digits it shows', {});
    }
    const name = `owner-totp-${claim.id.replaceAll('-', '').slice(0, 16)}`;
    const reference = `db://${name}`;
    await putSecret(name, secret, this.#master());
    try {
      await this.#options.mfa.enrolTotp({ label: 'owner (claimed in the console)', secretRef: reference, first: true });
    } catch (failure) {
      // Sealed for nothing, unless the same claim confirmed at the same
      // moment enrolled it -- then it is that authenticator's secret.
      const { rows } = await withControlPlane((tx) => tx.query(
        'SELECT 1 FROM owner_authenticators WHERE secret_ref = $1', [reference]));
      if (rows.length === 0) await deleteSecret(name);
      throw failure;
    }
    await withControlPlane((tx) => tx.query(
      'UPDATE owner_claims SET claimed_at = $1 WHERE claimed_at IS NULL', [this.#now()]));
    return this.#options.sessions.signIn({ totp });
  }

  /** The claim behind a code, while it is good and the deployment has no owner. */
  async #live(code: string): Promise<{ id: string }> {
    const now = this.#now();
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM owner_claims
          WHERE code_hash = $1 AND claimed_at IS NULL AND expires_at > $2`,
        [hashOf(code), now],
      );
      if (!rows[0]) {
        throw new PalugadaError('mfa.claim_invalid',
          'that link is not one this deployment made, or it has expired or been used: '
            + 'a new one is printed each time PALUGADA starts, until it has an owner', {});
      }
      if (await owned(tx)) {
        throw new PalugadaError('owner.claimed', 'this deployment already has an owner: sign in with their device', {});
      }
      return rows[0];
    });
  }

  #secretFor(claim: { id: string }): string {
    const bytes = createHmac('sha256', this.#master().key).update(`palugada owner claim ${claim.id}`).digest().subarray(0, 20);
    const secret = encodeBase32(bytes);
    redactor.register(secret);
    return secret;
  }

  #master(): MasterKey {
    const master = this.#options.master();
    if (!master) {
      throw new PalugadaError('credential.unavailable',
        'this deployment has no master key to seal the owner\'s secret with: set PALUGADA_OWNER_TOTP_REF instead', {});
    }
    return master;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}
