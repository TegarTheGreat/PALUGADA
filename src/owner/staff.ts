/**
 * Staff seats beside the one owner (the analysis of 3 October, §9 P2 item
 * 18; 0110): a viewer, a member, and an approver for tier 2 and below. The
 * kinds are a ladder (F19.8, 0149): a viewer reads and talks, a member also
 * asks for work and answers what is put to it, an approver also decides.
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
 *
 * A person in the company's rooms is known by the name the owner gave them,
 * with the handle and picture they chose beside it (F19.2, F19.21, F19.22;
 * STATUS 2.209). So a name is the owner's to give, and is refused when it
 * looks like a colleague's, or like the owner, PALUGADA, the CEO, the system
 * or a role, written in look-alike letters too; and a seat signs in with its
 * handle and its code, which resolves one secret rather than trying every
 * seat's, and is locked after repeated wrong codes from wherever they come.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { roomsOnControlPlane, withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';
import { deleteSecret, putSecret, type MasterKey } from '../settings/store.ts';
import { CONFUSABLES } from './confusables.ts';
import { TOTP_DRIFT_STEPS, decodeBase32, encodeBase32, stepFor, totpCode, totpUri } from './mfa.ts';
import { qrMatrix } from './qr.ts';

export type StaffKind = 'viewer' | 'member' | 'approver';

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
/** The most people one proof seats: a team moving in, not a directory imported. */
export const STAFF_BATCH_MOST = 30;

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
  return { name: nameShape(body.name), kind: kindOf(body.kind) };
}

/** A seat's kind from a request, or the refusal that says what each is. */
export function kindOf(value: unknown): StaffKind {
  if (value !== 'viewer' && value !== 'member' && value !== 'approver') {
    throw new PalugadaError('contract.violation',
      'a seat is a viewer, who reads; a member, who also asks for work and answers what is put to it; '
        + 'or an approver, who also decides at tier 2 and below', { field: 'kind' });
  }
  return value;
}

/** How many times a day a seat may ask for work, from a request: 0 to 200, as 0149 bounds it. */
export function asksPerDayOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 200) {
    throw new PalugadaError('contract.violation', 'a seat asks for work 0 to 200 times a day', { field: 'asksPerDay' });
  }
  return value;
}

/** Where each kind stands: a change upwards lets a person do more, and takes the owner's code. */
export const SEAT_LADDER: Readonly<Record<StaffKind, number>> = { viewer: 0, member: 1, approver: 2 };

/**
 * Characters that turn the text around them backwards: an embedding, an
 * override or an isolate. A name holding one is drawn in an order other than
 * the one it is written in, so a room can show "Siti" where something else is
 * stored, to everyone in it; refused outright (F19.21).
 */
const DIRECTION_OVERRIDES = /[‪-‮⁦-⁩]/;

/** A name as the owner gives it: trimmed, 1 to 80 characters, read in the order it is written. */
export function nameShape(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 80) {
    throw new PalugadaError('contract.violation', 'a seat is named for the person, in 1 to 80 characters', { field: 'name' });
  }
  if (DIRECTION_OVERRIDES.test(name) || /\p{Cc}/u.test(name)) {
    throw new PalugadaError('contract.violation',
      'a name is written as it reads: it may not hold a line break, a control character, or a character that turns the text around it',
      { field: 'name' });
  }
  if (skeleton(name) === '') {
    throw new PalugadaError('contract.violation', 'a name has letters or digits in it, not only spaces, marks and symbols', { field: 'name' });
  }
  return name;
}

/**
 * Digits read as the letters they stand in for: "0wner", "5iti". Unicode
 * lists 0 and 1 as look-alikes; 3 and 5 are written for e and s on purpose,
 * and a name is not a password.
 */
const DIGITS_AS_LETTERS: Readonly<Record<string, string>> = { '0': 'o', '1': 'l', '3': 'e', '5': 's' };

function lookalikes(text: string): string {
  let out = '';
  for (const char of text) out += CONFUSABLES[char] ?? char;
  return out;
}

/** Case folded, with the letters whose fold is not one lowercase letter (ß, a final ς) folded too. */
function caseFolded(text: string): string {
  return text.toUpperCase().toLowerCase();
}

/**
 * What a name or a handle looks like, for comparing two (UTS #39's skeleton,
 * for the letters in `confusables.ts`): folded by NFKC, its look-alike
 * letters mapped to what they look like, case folded, and its spaces,
 * punctuation, symbols and invisible characters removed. "Siti Rahayu",
 * "Siti-Rahayu" and "Sіti Rahayu" with a Cyrillic і are one skeleton.
 *
 * Mapped before it is folded, so a capital Greek eta at the start of a name
 * is read as the H it looks like rather than as the small eta it folds to;
 * and mapped again after, so a small letter that only looks like something
 * once folded (an m, which is an r and an n in a small font) is caught too.
 */
export function skeleton(text: string): string {
  let folded = lookalikes([...text.normalize('NFKC')].map((char) => DIGITS_AS_LETTERS[char] ?? char).join(''));
  for (let round = 0; round < 2; round += 1) folded = lookalikes(caseFolded(folded.normalize('NFKC')));
  return caseFolded(folded.normalize('NFKC')).replace(/[\p{Z}\p{P}\p{S}\p{C}]/gu, '');
}

/**
 * The skeletons a name is compared by: its own, the one of it folded first,
 * and the one with a 1 read as an i. Unicode lists a capital I as looking
 * like an l, so "SITI" and "Siti" have different skeletons, though they are
 * one name to anyone who reads them; read without case first, they are one.
 * And a 1 looks like an l, but is written for an i as often: "adm1n".
 */
function looks(text: string): string[] {
  const folded = caseFolded(text.normalize('NFKC'));
  return [...new Set([skeleton(text), skeleton(folded), skeleton(folded.replaceAll('1', 'i'))])];
}

function looksAlike(a: readonly string[], b: readonly string[]): boolean {
  return a.some((one) => b.includes(one));
}

/**
 * What no person here may be called, by name or by handle: the owner, in
 * English and Indonesian; PALUGADA; the CEO; the system and its admin; the
 * platform. And, for a handle, `room`, which every message may hold as
 * `@room`.
 */
const RESERVED_NAMES = ['owner', 'the owner', 'pemilik', 'palugada', 'ceo', 'system', 'sistem', 'admin', 'platform'];
const RESERVED_HANDLES = [...RESERVED_NAMES, 'room'];

/**
 * What a company's people may not be called, as skeletons: the words above,
 * and the title and the slug of each of its roles, so no person reads as the
 * CEO the company employs or as any agent of it.
 */
async function reservedLooks(tx: TenantClient, companyId: string, words: readonly string[]): Promise<string[]> {
  const { rows } = await tx.query<{ slug: string; title: string | null }>('SELECT slug, title FROM roles WHERE company_id = $1', [companyId]);
  return [...new Set([...words, ...rows.flatMap((row) => [row.slug, ...(row.title ? [row.title] : [])])].flatMap(looks))].filter(Boolean);
}

/** The pictures a person chooses from, as the console ships them (`console/public/avatars/people/`). */
const PICTURE = /^person-(0[1-9]|1[0-2])$/;

/** A picture from a request: one of the twelve, or null to be drawn the one given from the seat. */
export function pictureOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !PICTURE.test(value)) {
    throw new PalugadaError('contract.violation', 'a picture is one of person-01 to person-12', { field: 'picture' });
  }
  return value;
}

/**
 * A handle as a person types it, lowercased and without its @: 3 to 32
 * letters, digits, dots, dashes and underscores, starting with a letter
 * (0149's shape). Whether it can be used is asked separately, and answered
 * without saying why not.
 */
export function handleOf(value: unknown): string {
  const handle = typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(handle)) {
    throw new PalugadaError('contract.violation',
      'a handle is 3 to 32 letters, digits, dots, dashes or underscores, starting with a letter', { field: 'handle' });
  }
  return handle;
}

/**
 * The one refusal for a handle that is reserved or taken, wherever: it never
 * says which, or by whom, so a handle tried is not a way to learn who is
 * seated in another company.
 */
function unusable(): PalugadaError {
  return new PalugadaError('handle.unusable', 'that handle cannot be used: choose another', {});
}

function nameTaken(): PalugadaError {
  return new PalugadaError('name.taken', 'someone here has a name that looks like that: choose another', { field: 'name' });
}

/** A unique index broken by a write that raced another: the refusal the check before it would have given. */
function apartOrThrow(error: unknown): never {
  const failure = error as { code?: string; constraint?: string };
  if (failure.code === '23505' && failure.constraint === 'staff_seats_name_apart') throw nameTaken();
  if (failure.code === '23505' && failure.constraint === 'staff_seats_live_handle') throw unusable();
  throw error;
}

/**
 * Wrong codes for one handle before it is locked, and how long the lock lasts:
 * a minute, doubled at each lock after, to an hour at most. Counted on the
 * seat, so every address and every replica counts towards one lock.
 */
const HANDLE_LOCK_AFTER = 5;
const HANDLE_LOCK_FIRST_MINUTES = 1;
const HANDLE_LOCK_MOST_MINUTES = 60;

/** A seat as the owner's list shows it. */
export interface SeatListed {
  id: string;
  name: string;
  kind: StaffKind;
  handle: string | null;
  picture: string | null;
  asksPerDay: number;
  joined: boolean;
  invitePending: boolean;
  /** Seated before names were kept apart, and named like another seat of the company: one is to be renamed. */
  sharesName: boolean;
  createdAt: Date;
  joinedAt: Date | null;
  lastUsedAt: Date | null;
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

  /**
   * Refuses, before the owner is asked for a code, any of these names the
   * owner may not give in this company. The seating itself asks again.
   */
  async vetNames(companyId: string, names: readonly string[], renaming: string | null = null): Promise<void> {
    await withControlPlane(async (tx) => {
      await this.#vetNames(tx, companyId, names, renaming);
    });
  }

  /** A seat for one company, with the invite the owner hands the person. */
  async create(companyId: string, request: { name: string; kind: StaffKind }): Promise<{ seatId: string; invite: string }> {
    const [made] = await this.createMany(companyId, [request]);
    return { seatId: made!.seatId, invite: made!.invite };
  }

  /**
   * Several seats at once, all or none, each with an invite of its own: a
   * team moving in is seated with one proof (F19.22), and a refused name
   * seats nobody, so the owner is never left to find who was.
   */
  async createMany(companyId: string, requests: ReadonlyArray<{ name: string; kind: StaffKind }>): Promise<Array<{
    seatId: string; name: string; kind: StaffKind; invite: string;
  }>> {
    if (requests.length < 1 || requests.length > STAFF_BATCH_MOST) {
      throw new PalugadaError('contract.violation', `seat 1 to ${STAFF_BATCH_MOST} people at once`, { field: 'people' });
    }
    this.#requireMaster();
    const expires = new Date(this.#now().getTime() + STAFF_INVITE_TTL_MS);
    try {
      return await withControlPlane(async (tx) => {
        const skeletons = await this.#vetNames(tx, companyId, requests.map((one) => one.name), null);
        const made: Array<{ seatId: string; name: string; kind: StaffKind; invite: string }> = [];
        for (const [index, request] of requests.entries()) {
          const invite = encodeBase32(randomBytes(20));
          // Dated by the clock rather than the transaction, so a batch is listed in the order the owner wrote it.
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO staff_seats (company_id, name, name_skeleton, kind, invite_hash, invite_expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp()) RETURNING id`,
            [companyId, request.name, skeletons[index], request.kind, hashOf(invite), expires]);
          made.push({ seatId: rows[0]!.id, name: request.name, kind: request.kind, invite });
        }
        return made;
      });
    } catch (error) {
      apartOrThrow(error);
    }
  }

  /** The company's seats, revoked ones left out. */
  async list(companyId: string): Promise<SeatListed[]> {
    return withControlPlane(async (tx) => {
      await this.#fillSkeletons(tx, companyId);
      const { rows } = await tx.query<{
        id: string; name: string; kind: StaffKind; handle: string | null; picture: string | null; asks_per_day: number;
        name_skeleton: string | null; joined_at: Date | null; invite_pending: boolean; created_at: Date; last_used_at: Date | null;
      }>(
        `SELECT id, name, kind, handle, picture, asks_per_day, name_skeleton, joined_at, last_used_at, created_at,
                invite_hash IS NOT NULL AND invite_expires_at > $2 AS invite_pending
           FROM staff_seats WHERE company_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`,
        [companyId, this.#now()]);
      const seen = rows.map((row) => looks(row.name));
      return rows.map((row, index) => ({
        id: row.id, name: row.name, kind: row.kind, handle: row.handle, picture: row.picture, asksPerDay: row.asks_per_day,
        joined: row.joined_at !== null, invitePending: row.invite_pending,
        sharesName: row.name_skeleton === null || seen.some((other, at) => at !== index && looksAlike(other, seen[index]!)),
        createdAt: row.created_at, joinedAt: row.joined_at, lastUsedAt: row.last_used_at,
      }));
    });
  }

  /** One live seat of the company, as the owner changes it; null when there is none. */
  async seat(companyId: string, seatId: string): Promise<{ id: string; name: string; kind: StaffKind; asksPerDay: number } | null> {
    const { rows } = await withControlPlane((tx) => tx.query<{ id: string; name: string; kind: StaffKind; asks_per_day: number }>(
      'SELECT id, name, kind, asks_per_day FROM staff_seats WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL',
      [seatId, companyId]));
    const row = rows[0];
    return row ? { id: row.id, name: row.name, kind: row.kind, asksPerDay: row.asks_per_day } : null;
  }

  /**
   * The owner renames a seat, or changes its kind or its asks a day. Whether
   * the change needed the owner's code is the route's to ask before this.
   */
  async change(companyId: string, seatId: string, change: { name?: string; kind?: StaffKind; asksPerDay?: number }): Promise<{
    id: string; name: string; kind: StaffKind; asksPerDay: number;
  }> {
    try {
      return await withControlPlane(async (tx) => {
        const [named] = change.name === undefined ? [null] : await this.#vetNames(tx, companyId, [change.name], seatId);
        const { rows } = await tx.query<{ id: string; name: string; kind: StaffKind; asks_per_day: number }>(
          `UPDATE staff_seats
              SET name = coalesce($3, name), name_skeleton = coalesce($4, name_skeleton),
                  kind = coalesce($5, kind), asks_per_day = coalesce($6, asks_per_day)
            WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
          RETURNING id, name, kind, asks_per_day`,
          [seatId, companyId, change.name ?? null, named ?? null, change.kind ?? null, change.asksPerDay ?? null]);
        const row = rows[0];
        if (!row) throw new PalugadaError('contract.violation', 'no such seat in this company, or it is ended', { seatId });
        return { id: row.id, name: row.name, kind: row.kind, asksPerDay: row.asks_per_day };
      });
    } catch (error) {
      apartOrThrow(error);
    }
  }

  /**
   * The invite opened: a secret of this opening's own, for the person's
   * authenticator app. And who they are joining as: the seat, the name the
   * owner gave it and its kind, and the company, which the page names in what
   * it tells them before they join (F19.22).
   */
  async open(invite: string, label: string): Promise<{
    offer: string; secret: string; uri: string; qr: string[]; seat: { id: string; name: string; kind: StaffKind; company: string };
  }> {
    const seat = await this.#invited(invite);
    const offer = randomBytes(16).toString('base64url');
    const secret = this.#secretFor(seat.id, offer);
    const uri = totpUri(secret, label);
    const { rows } = await withControlPlane((tx) => tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [seat.companyId]));
    return {
      offer, secret, uri, qr: qrMatrix(uri).map((row) => row.map((on) => (on ? '1' : '0')).join('')),
      seat: { id: seat.id, name: seat.name, kind: seat.kind, company: rows[0]?.name ?? '' },
    };
  }

  /**
   * The code the person's app shows: the secret is sealed, the invite spent,
   * and they are signed in. With the handle and picture they chose (F19.22),
   * the handle asked after before the code is, so a handle someone else has
   * spends nothing and the person chooses again.
   */
  async confirm(invite: string, offer: string, totp: string, chosen: { handle?: string; picture?: string | null } = {}): Promise<StaffSession> {
    const seat = await this.#invited(invite);
    if (!OFFER.test(offer)) {
      throw new PalugadaError('mfa.claim_invalid',
        'this page does not say which code it showed: open the link again, scan the code it shows, then enter the six digits', {});
    }
    if (chosen.handle !== undefined) {
      const handle = chosen.handle;
      await withControlPlane((tx) => this.#vetHandle(tx, seat, handle));
    }
    const secret = this.#secretFor(seat.id, offer);
    const step = this.#matching(decodeBase32(secret), totp);
    if (step === null) {
      throw new PalugadaError('mfa.code_invalid',
        'that is not the code your app shows for this seat: scan the code on this page, then enter the six digits it shows', {});
    }
    const name = `staff-totp-${seat.id.replaceAll('-', '').slice(0, 16)}`;
    await putSecret(name, secret, this.#requireMaster());
    let rowCount: number | null;
    try {
      ({ rowCount } = await withControlPlane((tx) => tx.query(
        `UPDATE staff_seats SET secret_ref = $2, joined_at = $3, last_step = $4, last_used_at = $3,
                invite_hash = NULL, invite_expires_at = NULL, handle = coalesce($5, handle), picture = coalesce($6, picture)
          WHERE id = $1 AND invite_hash IS NOT NULL AND revoked_at IS NULL`,
        [seat.id, `db://${name}`, this.#now(), step, chosen.handle ?? null, chosen.picture ?? null])));
    } catch (error) {
      apartOrThrow(error);
    }
    if (rowCount !== 1) {
      throw new PalugadaError('mfa.claim_invalid', 'this invite was used or withdrawn while it was open: ask the owner for a new one', {});
    }
    return this.#session(seat);
  }

  /**
   * A sign-in code that is no owner's, from a seat that has no handle yet:
   * the seat whose app shows it, signed in; null when it is no such seat's.
   * Each code is used once. A seat that has a handle is never tried here: it
   * names its handle (`signInAs`), so the owner's door, which comes after
   * this, pays only for the seats seated before handles.
   */
  async signIn(totp: string): Promise<StaffSession | null> {
    const secrets = this.#secrets();
    if (!secrets) return null;
    const { rows } = await withControlPlane((tx) => tx.query<{
      id: string; company_id: string; name: string; kind: StaffKind; secret_ref: string;
    }>(
      `SELECT id, company_id, name, kind, secret_ref FROM staff_seats
        WHERE joined_at IS NOT NULL AND revoked_at IS NULL AND handle IS NULL ORDER BY created_at`));
    for (const row of rows) {
      let secret: Buffer;
      try {
        secret = decodeBase32(await secrets.resolve(row.secret_ref));
      } catch {
        continue;
      }
      const step = this.#matching(secret, totp);
      if (step === null) continue;
      await this.#claim(row.id, step);
      return this.#session({ id: row.id, companyId: row.company_id, name: row.name, kind: row.kind });
    }
    return null;
  }

  /**
   * A seat signing in by its handle and the code its app shows (F19.22): one
   * secret is resolved, the handle's. Five wrong codes for a handle lock it,
   * whatever address they came from, for a minute that doubles at each lock
   * after, to an hour at most; a right code clears the count. A handle
   * nobody has is refused in the same words as a wrong code.
   */
  async signInAs(handle: unknown, totp: string): Promise<StaffSession> {
    const wrong = () => new PalugadaError('mfa.code_invalid', 'that code does not sign anyone in by that handle', {});
    const secrets = this.#secrets();
    let named: string;
    try {
      named = handleOf(handle);
    } catch {
      throw wrong();
    }
    if (!secrets) throw wrong();
    const now = this.#now();
    const { rows } = await withControlPlane((tx) => tx.query<{
      id: string; company_id: string; name: string; kind: StaffKind; secret_ref: string; locked_until: Date | null;
    }>(
      `SELECT id, company_id, name, kind, secret_ref, locked_until FROM staff_seats
        WHERE handle = $1 AND joined_at IS NOT NULL AND revoked_at IS NULL`,
      [named]));
    const row = rows[0];
    if (!row) throw wrong();
    if (row.locked_until && row.locked_until > now) {
      throw new PalugadaError('auth.handle_locked',
        `too many wrong codes for this handle: it can be tried again after ${row.locked_until.toISOString()}`,
        { until: row.locked_until.toISOString() });
    }
    let secret: Buffer;
    try {
      secret = decodeBase32(await secrets.resolve(row.secret_ref));
    } catch {
      // A secret that cannot be read is not a guess, and is not counted as one.
      throw wrong();
    }
    const step = this.#matching(secret, totp);
    if (step === null) {
      await withControlPlane((tx) => tx.query(
        `UPDATE staff_seats
            SET sign_in_failures = LEAST(sign_in_failures + 1, 10000),
                locked_until = CASE WHEN (sign_in_failures + 1) % $2::int = 0
                  THEN $3::timestamptz + interval '1 minute'
                    * LEAST($5::int, $4::int * power(2, LEAST(6, (sign_in_failures + 1) / $2::int - 1)))
                  ELSE locked_until END
          WHERE id = $1`,
        [row.id, HANDLE_LOCK_AFTER, now, HANDLE_LOCK_FIRST_MINUTES, HANDLE_LOCK_MOST_MINUTES]));
      throw wrong();
    }
    await this.#claim(row.id, step);
    return this.#session({ id: row.id, companyId: row.company_id, name: row.name, kind: row.kind });
  }

  /** The seat behind a bearer token, while the session is open and the seat is not revoked. */
  async verify(token: string | null | undefined): Promise<StaffSession | null> {
    if (!token) return null;
    return (await this.verifyMany([token])).get(token) ?? null;
  }

  /**
   * The seats behind many bearer tokens, in one read: the live hub asks this
   * of every stream it holds, so a seat ended or narrowed elsewhere loses
   * what it had open (F19.11). A token whose session is over, or whose seat
   * is ended, is not in the answer.
   */
  async verifyMany(tokens: readonly string[]): Promise<Map<string, StaffSession>> {
    const byHash = new Map(tokens.map((token) => [tokenHash(token), token]));
    const found = new Map<string, StaffSession>();
    if (byHash.size === 0) return found;
    const { rows } = await withControlPlane((tx) => tx.query<{
      token_hash: string; id: string; company_id: string; name: string; kind: StaffKind; expires_at: Date;
    }>(
      `SELECT s.token_hash, seat.id, seat.company_id, seat.name, seat.kind, s.expires_at
         FROM staff_sessions s JOIN staff_seats seat ON seat.id = s.seat_id
        WHERE s.token_hash = ANY($1::text[]) AND s.ended_at IS NULL AND s.expires_at > $2 AND seat.revoked_at IS NULL`,
      [[...byHash.keys()], this.#now()]));
    for (const row of rows) {
      const token = byHash.get(row.token_hash)!;
      found.set(token, { token, seat: { id: row.id, companyId: row.company_id, name: row.name, kind: row.kind }, expiresAt: row.expires_at });
    }
    return found;
  }

  /** What a seat chose for itself: its handle and its picture. */
  async chosen(seatId: string): Promise<{ handle: string | null; picture: string | null }> {
    const { rows } = await withControlPlane((tx) => tx.query<{ handle: string | null; picture: string | null }>(
      'SELECT handle, picture FROM staff_seats WHERE id = $1', [seatId]));
    return { handle: rows[0]?.handle ?? null, picture: rows[0]?.picture ?? null };
  }

  /**
   * A seat changes its own handle or picture. The handle is refused, with one
   * answer, when it is reserved, or looks like another live seat's handle
   * anywhere or a colleague's name.
   */
  async choose(seat: StaffSeat, change: { handle?: string; picture?: string | null }): Promise<void> {
    try {
      await withControlPlane(async (tx) => {
        if (change.handle !== undefined) await this.#vetHandle(tx, seat, change.handle);
        await tx.query(
          `UPDATE staff_seats SET handle = CASE WHEN $2 THEN $3 ELSE handle END, picture = CASE WHEN $4 THEN $5 ELSE picture END
            WHERE id = $1 AND revoked_at IS NULL`,
          [seat.id, change.handle !== undefined, change.handle ?? null, change.picture !== undefined, change.picture ?? null]);
      });
    } catch (error) {
      apartOrThrow(error);
    }
  }

  async signOut(token: string): Promise<void> {
    await withControlPlane((tx) => tx.query(
      'UPDATE staff_sessions SET ended_at = $2 WHERE token_hash = $1 AND ended_at IS NULL', [tokenHash(token), this.#now()]));
  }

  /**
   * The owner ends a seat: its sessions now, its invite with it, and its
   * secret. And the person goes from the company's rooms: they leave every
   * room they were in, the direct ones too, with the platform named as who
   * took them out, so nothing in a room is planned for them again and what
   * they were owed there goes with them (the room triggers). Their own
   * settings go, and their handle is free for whoever is seated next. What
   * they said stays the company's.
   */
  async revoke(companyId: string, seatId: string): Promise<void> {
    const revoked = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ secret_ref: string | null }>(
        `UPDATE staff_seats SET revoked_at = $3, invite_hash = NULL, invite_expires_at = NULL, handle = NULL
          WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL RETURNING secret_ref`,
        [seatId, companyId, this.#now()]);
      if (!rows[0]) return null;
      await tx.query('UPDATE staff_sessions SET ended_at = $2 WHERE seat_id = $1 AND ended_at IS NULL', [seatId, this.#now()]);
      // The room triggers run as the schema's owner under forced row
      // security, so the control plane names the company and itself as the
      // reader first: only that reader may take someone out of a direct room.
      await roomsOnControlPlane(tx, companyId);
      await tx.query(
        `UPDATE room_members SET left_at = $3, left_by = 'platform'
          WHERE company_id = $1 AND principal = $2 AND left_at IS NULL`,
        [companyId, `seat:${seatId}`, this.#now()]);
      await tx.query('DELETE FROM principal_prefs WHERE principal = $1', [`seat:${seatId}`]);
      return rows[0];
    });
    if (!revoked) throw new PalugadaError('contract.violation', 'no such seat in this company, or it is already ended', { seatId });
    if (revoked.secret_ref?.startsWith('db://')) await deleteSecret(revoked.secret_ref.slice('db://'.length));
  }

  /**
   * A code matched: claimed by the write, so a second presentation of the
   * same code, or of an older one, changes no row. And the handle's count of
   * wrong codes starts again.
   */
  async #claim(seatId: string, step: number): Promise<void> {
    const { rowCount } = await withControlPlane((tx) => tx.query(
      `UPDATE staff_seats SET last_step = $2, last_used_at = $3, sign_in_failures = 0, locked_until = NULL
        WHERE id = $1 AND revoked_at IS NULL AND (last_step IS NULL OR last_step < $2)`,
      [seatId, step, this.#now()]));
    if (rowCount !== 1) throw new PalugadaError('mfa.replayed', 'that code has already been used', {});
  }

  /**
   * Refuses any of these names the owner may not give in this company, and
   * answers each one's skeleton to keep: a name like the owner's, PALUGADA's,
   * the CEO's, the system's or a role's is reserved; one like a live
   * colleague's (other than `except`, the seat being renamed), or like
   * another of the same batch, is taken.
   */
  async #vetNames(tx: TenantClient, companyId: string, names: readonly string[], except: string | null): Promise<string[]> {
    await this.#fillSkeletons(tx, companyId);
    const reserved = await reservedLooks(tx, companyId, RESERVED_NAMES);
    const { rows } = await tx.query<{ name: string }>(
      'SELECT name FROM staff_seats WHERE company_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [companyId, except]);
    const colleagues = rows.map((row) => looks(row.name));
    const batch: string[][] = [];
    for (const name of names) {
      const mine = looks(name);
      if (looksAlike(mine, reserved)) {
        throw new PalugadaError('name.reserved',
          'that name reads as the owner, PALUGADA, the CEO, the system or one of the company\'s roles: choose another', { field: 'name' });
      }
      if (colleagues.some((other) => looksAlike(mine, other)) || batch.some((other) => looksAlike(mine, other))) throw nameTaken();
      batch.push(mine);
    }
    return names.map(skeleton);
  }

  /**
   * A handle a seat may take, or the one refusal (`unusable`): reserved, a
   * role's here, or looking like another live seat's handle anywhere in the
   * deployment, or like a colleague's name, so `@siti` cannot be anyone but
   * Siti in a room's mention list.
   */
  async #vetHandle(tx: TenantClient, seat: { id: string; companyId: string }, handle: string): Promise<void> {
    const mine = looks(handle);
    if (looksAlike(mine, await reservedLooks(tx, seat.companyId, RESERVED_HANDLES))) throw unusable();
    const { rows } = await tx.query<{ handle: string | null; name: string; company_id: string }>(
      `SELECT handle, name, company_id FROM staff_seats
        WHERE revoked_at IS NULL AND id <> $1 AND (handle IS NOT NULL OR company_id = $2)`,
      [seat.id, seat.companyId]);
    for (const row of rows) {
      if (row.handle !== null && looksAlike(mine, looks(row.handle))) throw unusable();
      if (row.company_id === seat.companyId && looksAlike(mine, looks(row.name))) throw unusable();
    }
  }

  /**
   * Gives each live seat of the company seated before names were kept apart
   * its skeleton, idempotently, in the order they were seated: when two share
   * one, the later keeps none, and the owner's list asks for one of them to
   * be renamed. Asked before any name of the company is compared or listed,
   * so the index holds every seat that can hold one.
   */
  async #fillSkeletons(tx: TenantClient, companyId: string): Promise<void> {
    const { rows } = await tx.query<{ id: string; name: string; name_skeleton: string | null }>(
      'SELECT id, name, name_skeleton FROM staff_seats WHERE company_id = $1 AND revoked_at IS NULL ORDER BY created_at, id',
      [companyId]);
    if (rows.every((row) => row.name_skeleton !== null)) return;
    // Those that hold a skeleton keep it; the rest are given theirs in the
    // order they were seated, unless they look like one already held.
    const held = rows.filter((row) => row.name_skeleton !== null).map((row) => ({ skeleton: row.name_skeleton!, looks: looks(row.name) }));
    for (const row of rows) {
      if (row.name_skeleton !== null) continue;
      const mine = { skeleton: skeleton(row.name), looks: looks(row.name) };
      if (held.some((other) => other.skeleton === mine.skeleton || looksAlike(other.looks, mine.looks))) continue;
      held.push(mine);
      await tx.query('UPDATE staff_seats SET name_skeleton = $2 WHERE id = $1 AND name_skeleton IS NULL', [row.id, mine.skeleton]);
    }
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
