/**
 * Staff seats beside the one owner (the analysis of 3 October, §9 P2 item
 * 18; 0110): a viewer, and an approver for tier 2 and below.
 *
 * PALUGADA has one owner, and nothing here makes a second: a seat cannot
 * loosen a control, change a setting, see a key, manage a device or decide
 * anything at tier 3. It is kept apart from the owner's factors altogether.
 * A seat's authenticator is not one of the owner's, so the owner's second
 * factor and the tier 3 gate -- which read only the owner's -- never accept
 * a staff member's code; its sessions are not the owner's, so a request is
 * either the owner's or a seat's, and a seat's is refused every route not
 * listed for it (`staff-policy.ts`).
 *
 * A seat is one company's. The owner makes it with their device and is given
 * an invite for the person: 160 random bits, kept only as their SHA-256,
 * good for a week and spent by joining. Like the owner's own claim
 * (claim.ts), each opening of the invite is shown a secret of its own,
 * derived from the master key, the seat and a random value the page is given
 * with it, and kept nowhere until the person confirms a code from it: the
 * invite alone gives no secret.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';
import { deleteSecret, putSecret, type MasterKey } from '../settings/store.ts';
import { TOTP_DRIFT_STEPS, decodeBase32, encodeBase32, stepFor, totpCode, totpUri } from './mfa.ts';
import { qrMatrix } from './qr.ts';

export type StaffKind = 'viewer' | 'approver';

export interface StaffSeat {
  id: string;
  companyId: string;
  name: string;
  kind: StaffKind;
}

export interface StaffSession {
  token: string;
  seat: StaffSeat;
  expiresAt: Date;
}

/** A week: long enough for the link to reach the person and the person to reach a phone. */
export const STAFF_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** As long as the owner's (session.ts). */
export const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const OFFER = /^[A-Za-z0-9_-]{22}$/;

function hashOf(text: string): string {
  return createHash('sha256').update(text.trim().toUpperCase()).digest('hex');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function codesMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What the owner may call a seat, and which kind it is, checked before anything is written. */
export function seatRequest(body: Record<string, unknown>): { name: string; kind: StaffKind } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    throw new PalugadaError('contract.violation', 'a seat is named for the person, in 1 to 80 characters', { field: 'name' });
  }
  if (body.kind !== 'viewer' && body.kind !== 'approver') {
    throw new PalugadaError('contract.violation',
      'a seat is a viewer, who reads, or an approver, who also decides at tier 2 and below', { field: 'kind' });
  }
  return { name, kind: body.kind };
}

export class StaffSeats {
  readonly #master: () => MasterKey | null;
  readonly #secrets: () => SecretManager | null;
  readonly #now: () => Date;

  constructor(options: { master: () => MasterKey | null; secrets: () => SecretManager | null; now?: () => Date }) {
    this.#master = options.master;
    this.#secrets = options.secrets;
    this.#now = options.now ?? (() => new Date());
  }

  /** A seat for one company, with the invite the owner hands the person. */
  async create(companyId: string, request: { name: string; kind: StaffKind }): Promise<{ seatId: string; invite: string }> {
    this.#requireMaster();
    const invite = encodeBase32(randomBytes(20));
    const { rows } = await withControlPlane((tx) => tx.query<{ id: string }>(
      `INSERT INTO staff_seats (company_id, name, kind, invite_hash, invite_expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, request.name, request.kind, hashOf(invite), new Date(this.#now().getTime() + STAFF_INVITE_TTL_MS)]));
    return { seatId: rows[0]!.id, invite };
  }

  /** The company's seats, revoked ones left out. */
  async list(companyId: string): Promise<Array<{
    id: string; name: string; kind: StaffKind; joined: boolean; invitePending: boolean;
    createdAt: Date; joinedAt: Date | null; lastUsedAt: Date | null;
  }>> {
    const { rows } = await withControlPlane((tx) => tx.query<{
      id: string; name: string; kind: StaffKind; joined_at: Date | null; invite_pending: boolean;
      created_at: Date; last_used_at: Date | null;
    }>(
      `SELECT id, name, kind, joined_at, last_used_at, created_at,
              invite_hash IS NOT NULL AND invite_expires_at > $2 AS invite_pending
         FROM staff_seats WHERE company_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`,
      [companyId, this.#now()]));
    return rows.map((row) => ({
      id: row.id, name: row.name, kind: row.kind, joined: row.joined_at !== null, invitePending: row.invite_pending,
      createdAt: row.created_at, joinedAt: row.joined_at, lastUsedAt: row.last_used_at,
    }));
  }

  /** The invite opened: a secret of this opening's own, for the person's authenticator app. */
  async open(invite: string, label: string): Promise<{ offer: string; secret: string; uri: string; qr: string[]; seat: { name: string; kind: StaffKind } }> {
    const seat = await this.#invited(invite);
    const offer = randomBytes(16).toString('base64url');
    const secret = this.#secretFor(seat.id, offer);
    const uri = totpUri(secret, label);
    return {
      offer, secret, uri, qr: qrMatrix(uri).map((row) => row.map((on) => (on ? '1' : '0')).join('')),
      seat: { name: seat.name, kind: seat.kind },
    };
  }

  /** The code the person's app shows: the secret is sealed, the invite spent, and they are signed in. */
  async confirm(invite: string, offer: string, totp: string): Promise<StaffSession> {
    const seat = await this.#invited(invite);
    if (!OFFER.test(offer)) {
      throw new PalugadaError('mfa.claim_invalid',
        'this page does not say which code it showed: open the link again, scan the code it shows, then enter the six digits', {});
    }
    const secret = this.#secretFor(seat.id, offer);
    const step = this.#matching(decodeBase32(secret), totp);
    if (step === null) {
      throw new PalugadaError('mfa.code_invalid',
        'that is not the code your app shows for this seat: scan the code on this page, then enter the six digits it shows', {});
    }
    const name = `staff-totp-${seat.id.replaceAll('-', '').slice(0, 16)}`;
    await putSecret(name, secret, this.#requireMaster());
    const { rowCount } = await withControlPlane((tx) => tx.query(
      `UPDATE staff_seats SET secret_ref = $2, joined_at = $3, last_step = $4, last_used_at = $3,
              invite_hash = NULL, invite_expires_at = NULL
        WHERE id = $1 AND invite_hash IS NOT NULL AND revoked_at IS NULL`,
      [seat.id, `db://${name}`, this.#now(), step]));
    if (rowCount !== 1) {
      throw new PalugadaError('mfa.claim_invalid', 'this invite was used or withdrawn while it was open: ask the owner for a new one', {});
    }
    return this.#session(seat);
  }

  /**
   * A sign-in code that is no owner's: the seat whose app shows it, signed
   * in; null when it is no seat's either. Each code is used once.
   */
  async signIn(totp: string): Promise<StaffSession | null> {
    const secrets = this.#secrets();
    if (!secrets) return null;
    const { rows } = await withControlPlane((tx) => tx.query<{
      id: string; company_id: string; name: string; kind: StaffKind; secret_ref: string;
    }>(
      `SELECT id, company_id, name, kind, secret_ref FROM staff_seats
        WHERE joined_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at`));
    for (const row of rows) {
      let secret: Buffer;
      try {
        secret = decodeBase32(await secrets.resolve(row.secret_ref));
      } catch {
        continue;
      }
      const step = this.#matching(secret, totp);
      if (step === null) continue;
      // Claimed by the write: a second presentation of the same code, or of
      // an older one, changes no row.
      const { rowCount } = await withControlPlane((tx) => tx.query(
        `UPDATE staff_seats SET last_step = $2, last_used_at = $3
          WHERE id = $1 AND revoked_at IS NULL AND (last_step IS NULL OR last_step < $2)`,
        [row.id, step, this.#now()]));
      if (rowCount !== 1) throw new PalugadaError('mfa.replayed', 'that code has already been used', {});
      return this.#session({ id: row.id, companyId: row.company_id, name: row.name, kind: row.kind });
    }
    return null;
  }

  /** The seat behind a bearer token, while the session is open and the seat is not revoked. */
  async verify(token: string | null | undefined): Promise<StaffSession | null> {
    if (!token) return null;
    const { rows } = await withControlPlane((tx) => tx.query<{
      id: string; company_id: string; name: string; kind: StaffKind; expires_at: Date;
    }>(
      `SELECT seat.id, seat.company_id, seat.name, seat.kind, s.expires_at
         FROM staff_sessions s JOIN staff_seats seat ON seat.id = s.seat_id
        WHERE s.token_hash = $1 AND s.ended_at IS NULL AND s.expires_at > $2 AND seat.revoked_at IS NULL`,
      [tokenHash(token), this.#now()]));
    const row = rows[0];
    if (!row) return null;
    return { token, seat: { id: row.id, companyId: row.company_id, name: row.name, kind: row.kind }, expiresAt: row.expires_at };
  }

  async signOut(token: string): Promise<void> {
    await withControlPlane((tx) => tx.query(
      'UPDATE staff_sessions SET ended_at = $2 WHERE token_hash = $1 AND ended_at IS NULL', [tokenHash(token), this.#now()]));
  }

  /** The owner ends a seat: its sessions now, its invite with it, and its secret. */
  async revoke(companyId: string, seatId: string): Promise<void> {
    const revoked = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ secret_ref: string | null }>(
        `UPDATE staff_seats SET revoked_at = $3, invite_hash = NULL, invite_expires_at = NULL
          WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL RETURNING secret_ref`,
        [seatId, companyId, this.#now()]);
      if (!rows[0]) return null;
      await tx.query('UPDATE staff_sessions SET ended_at = $2 WHERE seat_id = $1 AND ended_at IS NULL', [seatId, this.#now()]);
      return rows[0];
    });
    if (!revoked) throw new PalugadaError('contract.violation', 'no such seat in this company, or it is already ended', { seatId });
    if (revoked.secret_ref?.startsWith('db://')) await deleteSecret(revoked.secret_ref.slice('db://'.length));
  }

  async #session(seat: StaffSeat): Promise<StaffSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.#now().getTime() + STAFF_SESSION_TTL_MS);
    await withControlPlane(async (tx) => {
      // Sessions long over are litter, swept by the next one.
      await tx.query("DELETE FROM staff_sessions WHERE expires_at < $1::timestamptz - interval '1 day'", [this.#now()]);
      await tx.query('INSERT INTO staff_sessions (token_hash, seat_id, issued_at, expires_at) VALUES ($1, $2, $3, $4)',
        [tokenHash(token), seat.id, this.#now(), expiresAt]);
    });
    return { token, seat, expiresAt };
  }

  /** The seat behind an invite, while it is good. */
  async #invited(invite: string): Promise<StaffSeat> {
    const { rows } = await withControlPlane((tx) => tx.query<{ id: string; company_id: string; name: string; kind: StaffKind }>(
      `SELECT id, company_id, name, kind FROM staff_seats
        WHERE invite_hash = $1 AND invite_expires_at > $2 AND revoked_at IS NULL`,
      [hashOf(invite), this.#now()]));
    if (!rows[0]) {
      throw new PalugadaError('mfa.claim_invalid',
        'that invite is not one this deployment made, or it has expired, been used or been withdrawn: ask the owner for a new one', {});
    }
    return { id: rows[0].id, companyId: rows[0].company_id, name: rows[0].name, kind: rows[0].kind };
  }

  /** The step a code is right for, within the drift every app is allowed; null when it is right for none. */
  #matching(secret: Buffer, code: string): number | null {
    const now = stepFor(this.#now());
    for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
      if (codesMatch(code, totpCode(secret, now + drift))) return now + drift;
    }
    return null;
  }

  #secretFor(seatId: string, offer: string): string {
    const bytes = createHmac('sha256', this.#requireMaster().key).update(`palugada staff invite ${seatId} ${offer}`).digest().subarray(0, 20);
    const secret = encodeBase32(bytes);
    redactor.register(secret);
    return secret;
  }

  #requireMaster(): MasterKey {
    const master = this.#master();
    if (!master) {
      throw new PalugadaError('credential.unavailable',
        'this deployment has no master key to seal a staff member\'s secret with, so it cannot seat anyone', {});
    }
    return master;
  }
}
