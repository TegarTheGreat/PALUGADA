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
import { assistantDispatch, roomsOnControlPlane, withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';
import { deleteSecret, putSecret, type MasterKey } from '../settings/store.ts';
import { CONFUSABLES } from './confusables.ts';
import { TOTP_DRIFT_STEPS, decodeBase32, encodeBase32, stepFor, totpCode, totpUri } from './mfa.ts';
import { qrMatrix } from './qr.ts';
import { endLinksOf } from '../relay/links.ts';
import { voidSeatOffers } from '../relay/people.ts';

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
const DIRECTION_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/;

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
  if (!/[\p{L}\p{N}]/u.test(skeleton(name))) {
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
 * for the letters in `confusables.ts`): taken apart by NFKD, its look-alike
 * letters mapped to what they look like, case folded, and its spaces,
 * punctuation, symbols and invisible characters removed. "Siti Rahayu",
 * "Siti-Rahayu" and "Sіti Rahayu" with a Cyrillic і are one skeleton.
 *
 * Taken apart rather than composed, as UTS #39 does it: Unicode lists a
 * Cyrillic е as an e, but not a Cyrillic ё as an ë, so a letter is mapped
 * without its mark and the mark kept beside it, and "Zoё" is "Zoë". The
 * compatibility form, so that a full-width or a mathematical letter is the
 * one it is before it is mapped.
 *
 * Mapped before it is folded, so a capital Greek eta at the start of a name
 * is read as the H it looks like rather than as the small eta it folds to;
 * and mapped again after, so a small letter that only looks like something
 * once folded (an m, which is an r and an n in a small font) is caught too.
 */
export function skeleton(text: string): string {
  let folded = lookalikes([...text.normalize('NFKD')].map((char) => DIGITS_AS_LETTERS[char] ?? char).join(''));
  for (let round = 0; round < 2; round += 1) folded = lookalikes(caseFolded(folded.normalize('NFKD')));
  return caseFolded(folded.normalize('NFKD')).normalize('NFKD').replace(/[\p{Z}\p{P}\p{S}\p{C}]/gu, '');
}

/**
 * The skeletons a name is compared by: its own, the one of it folded first,
 * and the one with a 1 read as an i. Unicode lists a capital I as looking
 * like an l, so "SITI" and "Siti" have different skeletons, though they are
 * one name to anyone who reads them; read without case first, they are one.
 * And a 1 looks like an l, but is written for an i as often: "adm1n".
 */
function looks(text: string): string[] {
  const folded = caseFolded(text.normalize('NFKD'));
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

/**
 * Which name of what the owner sent a refusal is about: the name as they
 * wrote it, and, in a list of several, its place, so the owner knows which
 * of thirty lines to change. Never the colleague's name it looks like.
 */
interface Named {
  name: string;
  index?: number;
}

function said(named: Named): string {
  return named.index === undefined ? JSON.stringify(named.name) : `${JSON.stringify(named.name)}, number ${named.index + 1} of the list,`;
}

function nameTaken(named: Named): PalugadaError {
  return new PalugadaError('name.taken', `${said(named)} looks like the name or the handle of someone here: choose another`,
    { field: 'name', ...named });
}

function nameReserved(named: Named): PalugadaError {
  return new PalugadaError('name.reserved',
    `${said(named)} reads as the owner, PALUGADA, the CEO, the system or one of the company's roles: choose another`, { field: 'name', ...named });
}

/**
 * A unique index broken by a write that raced another: the refusal the check
 * before it would have given. Every write that names or hands a seat waits
 * for the others (`PEOPLE_NAMES_LOCK`), so this is a write that took no turn.
 */
function apartOrThrow(error: unknown): never {
  const failure = error as { code?: string; constraint?: string };
  if (failure.code === '23505' && failure.constraint === 'staff_seats_name_apart') {
    throw new PalugadaError('name.taken', 'someone here has a name that looks like that: choose another', { field: 'name' });
  }
  if (failure.code === '23505' && failure.constraint === 'staff_seats_live_handle') throw unusable();
  throw error;
}

/**
 * Wrong codes for one handle in a quarter hour before it is locked, and how
 * long the lock lasts: a minute, doubled at each lock after, to an hour at
 * most. Counted for the handle as typed, held or not, in the database, so
 * every replica counts towards one lock and a handle nobody holds is locked
 * as a held one is (STATUS 2.217).
 *
 * One address counts at most `HANDLE_LOCK_EACH_ADDRESS` of them: an address
 * may send five wrong codes a quarter hour (`SignInThrottle`), and a lock
 * one address could make alone would let anyone who knows a colleague's
 * handle keep them out. A lock takes wrong codes from four addresses or more.
 */
const HANDLE_LOCK_AFTER = 10;
const HANDLE_LOCK_EACH_ADDRESS = 3;
const HANDLE_LOCK_WINDOW_MINUTES = 15;
const HANDLE_LOCK_FIRST_MINUTES = 1;
const HANDLE_LOCK_MOST_MINUTES = 60;

/** A handle's count, as the sign-in that holds its row reads it. */
interface HandleCount {
  counted: number;
  addresses: Record<string, number>;
  window_until: Date | null;
  locks: number;
  locked_until: Date | null;
}

/** An address, as a handle's count keeps it: a digest, never the address. */
function addressKey(address: string): string {
  return createHash('sha256').update(`palugada:sign-in:${address}`).digest('hex').slice(0, 32);
}

/** The refusal while a handle is locked, the same for a handle nobody holds. */
function handleLocked(until: Date): PalugadaError {
  return new PalugadaError('auth.handle_locked',
    `too many wrong codes for this handle: it can be tried again after ${until.toISOString()}`, { until: until.toISOString() });
}

/**
 * Taken by every write that names a seat or gives it a handle, for the rest
 * of its transaction. The unique index holds one reading of a name, but two
 * names look alike when any reading matches, and a handle is compared with
 * colleagues' names: "SITI" and "Siti" written at the same moment would each
 * find the other not yet there. People are named and handled a few times a
 * day, so the deployment takes them one at a time.
 */
const PEOPLE_NAMES_LOCK = "SELECT pg_advisory_xact_lock(hashtext('palugada:people-names'))";

function replayed(): PalugadaError {
  return new PalugadaError('mfa.replayed', 'that code has already been used', {});
}

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

  /**
   * The company's seats, revoked ones left out. A handle is words its person
   * chose, so the owner's assistant, which reads this list through the
   * owner's routes, is shown every seat without one (F19.2; STATUS 2.203):
   * what people write is never a model's to read.
   */
  async list(companyId: string): Promise<SeatListed[]> {
    const forTheAssistant = assistantDispatch.getStore() !== undefined;
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
        id: row.id, name: row.name, kind: row.kind, handle: forTheAssistant ? null : row.handle, picture: row.picture, asksPerDay: row.asks_per_day,
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
        // A kind changed voids what its phone was offered to answer or
        // decide, in the same transaction (STATUS section 2.213): a press is
        // read against the seat again in any case, and this is what tells the
        // phone the button is spent.
        if (change.kind !== undefined) await voidSeatOffers(tx, `seat:${seatId}`, this.#now());
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
   * it tells them before they join (F19.22). A seat given a new authenticator
   * (`newAuthenticator`) is `again`, with the handle it keeps, so the page
   * asks it for nothing it chose already.
   */
  async open(invite: string, label: string): Promise<{
    offer: string; secret: string; uri: string; qr: string[];
    seat: { id: string; name: string; kind: StaffKind; company: string; handle: string | null; again: boolean };
  }> {
    const seat = await this.#invited(invite);
    const offer = randomBytes(16).toString('base64url');
    const secret = this.#secretFor(seat.id, offer);
    const uri = totpUri(secret, label);
    const { rows } = await withControlPlane((tx) => tx.query<{ company: string; handle: string | null; again: boolean }>(
      `SELECT c.name AS company, s.handle, s.joined_at IS NOT NULL AS again
         FROM staff_seats s JOIN companies c ON c.id = s.company_id WHERE s.id = $1`, [seat.id]));
    return {
      offer, secret, uri, qr: qrMatrix(uri).map((row) => row.map((on) => (on ? '1' : '0')).join('')),
      seat: { id: seat.id, name: seat.name, kind: seat.kind, company: rows[0]?.company ?? '', handle: rows[0]?.handle ?? null, again: rows[0]?.again ?? false },
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
      ({ rowCount } = await withControlPlane(async (tx) => {
        // Asked again in the transaction that takes it, in its turn, so a
        // look-alike handle taken while the code was being read is not taken twice.
        if (chosen.handle !== undefined) await this.#vetHandle(tx, seat, chosen.handle);
        // A seat given a new authenticator keeps the day it first joined.
        return tx.query(
          `UPDATE staff_seats SET secret_ref = $2, joined_at = coalesce(joined_at, $3), last_step = $4, last_used_at = $3,
                  invite_hash = NULL, invite_expires_at = NULL, handle = coalesce($5, handle), picture = coalesce($6, picture)
            WHERE id = $1 AND invite_hash IS NOT NULL AND revoked_at IS NULL`,
          [seat.id, `db://${name}`, this.#now(), step, chosen.handle ?? null, chosen.picture ?? null]);
      }));
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
        WHERE joined_at IS NOT NULL AND revoked_at IS NULL AND handle IS NULL AND secret_ref IS NOT NULL ORDER BY created_at`));
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
   * secret is resolved, the handle's. Ten wrong codes for a handle in a
   * quarter hour lock it, at most three of them from any one address, for a
   * minute that doubles at each lock after, to an hour at most; a right code
   * clears the count. A handle nobody holds is counted and locked the same,
   * and every answer for it is the answer a held one gives (STATUS 2.217).
   *
   * The lock, the comparison and the count are one transaction that holds
   * the handle's row, so attempts at one handle are judged one at a time,
   * across replicas too. Guesses are not sent one after another: read in one
   * transaction and counted in another, thirty sent at once all read "no
   * wrong codes yet", and all thirty were compared. The secret is read
   * before the row is held, so the transaction waits on nothing while it
   * holds it. A refusal is returned from inside rather than thrown, since a
   * throw would roll back the count that says somebody tried.
   */
  async signInAs(handle: unknown, totp: string, address = ''): Promise<StaffSession> {
    const wrong = () => new PalugadaError('mfa.code_invalid', 'that code does not sign anyone in by that handle', {});
    const secrets = this.#secrets();
    let named: string;
    try {
      named = handleOf(handle);
    } catch {
      // No handle can be spelled so: nobody holds it, or ever will.
      throw wrong();
    }
    if (!secrets) throw wrong();
    const { rows } = await withControlPlane((tx) => tx.query<{ id: string; secret_ref: string }>(
      `SELECT id, secret_ref FROM staff_seats
        WHERE handle = $1 AND joined_at IS NOT NULL AND revoked_at IS NULL AND secret_ref IS NOT NULL`, [named]));
    const found = rows[0] ?? null;
    let secret: Buffer | null = null;
    if (found) {
      try {
        secret = decodeBase32(await secrets.resolve(found.secret_ref));
      } catch {
        // A secret that cannot be read is not a guess, and is not counted as one.
        throw wrong();
      }
    }
    const outcome = await withControlPlane(async (tx): Promise<{ seat: StaffSeat } | { refused: PalugadaError }> => {
      const now = this.#now();
      // The handle's row, held or not, so a handle nobody holds is judged as
      // one somebody does; then held, before anything is compared.
      await tx.query('INSERT INTO handle_sign_ins (handle, touched_at) VALUES ($1, $2) ON CONFLICT (handle) DO NOTHING', [named, now]);
      const { rows: [count] } = await tx.query<HandleCount>(
        'SELECT counted, addresses, window_until, locks, locked_until FROM handle_sign_ins WHERE handle = $1 FOR UPDATE', [named]);
      // Before the comparison, so a right code waits for the lock as a wrong one does.
      if (count!.locked_until && count!.locked_until > now) return { refused: handleLocked(count!.locked_until) };
      // The same seat, still holding this handle and this secret, once the
      // attempts before this one are on the record.
      const { rows: held } = found === null ? { rows: [] } : await tx.query<{ id: string; company_id: string; name: string; kind: StaffKind }>(
        `SELECT id, company_id, name, kind FROM staff_seats
          WHERE id = $1 AND handle = $2 AND secret_ref = $3 AND joined_at IS NOT NULL AND revoked_at IS NULL
          FOR UPDATE`,
        [found.id, named, found.secret_ref]);
      const row = held[0];
      // A handle nobody holds is compared too, with a secret nobody has, so
      // it is not answered sooner.
      const step = this.#matching(row && secret ? secret : randomBytes(20), totp);
      if (!row || step === null) {
        await this.#countWrong(tx, named, count!, address, now);
        return { refused: wrong() };
      }
      if (!await this.#claimWithin(tx, row.id, step)) return { refused: replayed() };
      await tx.query('DELETE FROM handle_sign_ins WHERE handle = $1', [named]);
      return { seat: { id: row.id, companyId: row.company_id, name: row.name, kind: row.kind } };
    });
    if ('refused' in outcome) throw outcome.refused;
    return this.#session(outcome.seat);
  }

  /**
   * One wrong code for a handle, counted unless its address has counted its
   * share of this quarter hour's, and the handle locked when the count is
   * full. Handles nobody has tried for a day are forgotten here too.
   */
  async #countWrong(tx: TenantClient, handle: string, count: HandleCount, address: string, now: Date): Promise<void> {
    const fresh = count.window_until === null || count.window_until <= now;
    let counted = fresh ? 0 : count.counted;
    const addresses = fresh ? {} : { ...count.addresses };
    const key = addressKey(address);
    const already = addresses[key] ?? 0;
    if (already < HANDLE_LOCK_EACH_ADDRESS) {
      counted += 1;
      addresses[key] = already + 1;
    }
    let windowUntil = fresh ? new Date(now.getTime() + HANDLE_LOCK_WINDOW_MINUTES * 60_000) : count.window_until;
    let locks = count.locks;
    let lockedUntil: Date | null = null;
    if (counted >= HANDLE_LOCK_AFTER) {
      locks = Math.min(locks + 1, 1000);
      const minutes = Math.min(HANDLE_LOCK_MOST_MINUTES, HANDLE_LOCK_FIRST_MINUTES * 2 ** Math.min(locks - 1, 10));
      lockedUntil = new Date(now.getTime() + minutes * 60_000);
      counted = 0;
      windowUntil = null;
      for (const one of Object.keys(addresses)) delete addresses[one];
    }
    await tx.query(
      `UPDATE handle_sign_ins SET counted = $2, addresses = $3, window_until = $4, locks = $5, locked_until = $6, touched_at = $7
        WHERE handle = $1`,
      [handle, counted, JSON.stringify(addresses), windowUntil, locks, lockedUntil, now]);
    await tx.query(
      `DELETE FROM handle_sign_ins
        WHERE touched_at < $1::timestamptz - interval '1 day' AND (locked_until IS NULL OR locked_until < $1)`, [now]);
  }

  /** The seat behind a bearer token, while the session is open and the seat is not revoked. */
  async verify(token: string | null | undefined): Promise<StaffSession | null> {
    if (!token) return null;
    return (await this.verifyMany([token])).get(token) ?? null;
  }

  /**
   * The seats behind many bearer tokens, in one read. A token whose session
   * is over, or whose seat is ended, is not in the answer.
   */
  async verifyMany(tokens: readonly string[]): Promise<Map<string, StaffSession>> {
    const byHash = new Map(tokens.map((token) => [tokenHash(token), token]));
    const found = new Map<string, StaffSession>();
    for (const [hash, live] of await this.liveByHash([...byHash.keys()])) {
      const token = byHash.get(hash)!;
      found.set(token, { token, ...live });
    }
    return found;
  }

  /**
   * The same by the tokens' hashes (SHA-256, hex, as `staff_sessions` keeps
   * them): the live hub asks this of every stream a seat holds open, every
   * twenty-five seconds, from the hashes its stream registry files them
   * under, so it keeps no token, and a seat ended or narrowed where no
   * process heard of it loses what it had open (F19.11, STATUS 2.210).
   */
  async liveByHash(hashes: readonly string[]): Promise<Map<string, Omit<StaffSession, 'token'>>> {
    const found = new Map<string, Omit<StaffSession, 'token'>>();
    if (hashes.length === 0) return found;
    const { rows } = await withControlPlane((tx) => tx.query<{
      token_hash: string; id: string; company_id: string; name: string; kind: StaffKind; expires_at: Date;
    }>(
      `SELECT s.token_hash, seat.id, seat.company_id, seat.name, seat.kind, s.expires_at
         FROM staff_sessions s JOIN staff_seats seat ON seat.id = s.seat_id
        WHERE s.token_hash = ANY($1::text[]) AND s.ended_at IS NULL AND s.expires_at > $2 AND seat.revoked_at IS NULL`,
      [[...new Set(hashes)], this.#now()]));
    for (const row of rows) {
      found.set(row.token_hash, { seat: { id: row.id, companyId: row.company_id, name: row.name, kind: row.kind }, expiresAt: row.expires_at });
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

  /**
   * The owner gives a seat a new authenticator (STATUS 2.217): a phone lost
   * or replaced left the person no way back in but ending the seat, which
   * took them out of every room, their direct conversations too, and freed
   * their handle. The same seat -- its principal, name, handle, picture,
   * rooms and direct rooms -- gets a new invite, which the person opens as
   * they first joined and which asks only for the code of a new app. What
   * the lost phone could still use ends now: the seat's sessions, its old
   * secret, its links through a relay and every offer they were sent; and
   * the lock on its handle, so the person is not kept out by whoever was
   * guessing. Whether the owner's code was asked is the route's.
   */
  async newAuthenticator(companyId: string, seatId: string): Promise<{ seatId: string; invite: string }> {
    this.#requireMaster();
    const invite = encodeBase32(randomBytes(20));
    const now = this.#now();
    const ended = await withControlPlane(async (tx) => {
      const { rows: [seat] } = await tx.query<{ handle: string | null }>(
        'SELECT handle FROM staff_seats WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL', [seatId, companyId]);
      if (!seat) return null;
      // The handle's row before the seat's, as a sign-in takes them.
      if (seat.handle !== null) await tx.query('DELETE FROM handle_sign_ins WHERE handle = $1', [seat.handle]);
      const { rows } = await tx.query<{ secret_ref: string | null }>(
        `UPDATE staff_seats s SET invite_hash = $3, invite_expires_at = $4, secret_ref = NULL, last_step = NULL
           FROM staff_seats was
          WHERE s.id = $1 AND s.company_id = $2 AND s.revoked_at IS NULL AND was.id = s.id
          RETURNING was.secret_ref`,
        [seatId, companyId, hashOf(invite), new Date(now.getTime() + STAFF_INVITE_TTL_MS)]);
      if (!rows[0]) return null;
      await tx.query('UPDATE staff_sessions SET ended_at = $2 WHERE seat_id = $1 AND ended_at IS NULL', [seatId, now]);
      await endLinksOf(tx, `seat:${seatId}`, now);
      return rows[0];
    });
    if (!ended) throw new PalugadaError('contract.violation', 'no such seat in this company, or it is ended', { seatId });
    if (ended.secret_ref?.startsWith('db://')) await deleteSecret(ended.secret_ref.slice('db://'.length));
    return { seatId, invite };
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
   * settings go, and their handle is free for whoever is seated next, and
   * so do the phones they linked through a relay. What they said stays the
   * company's.
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
      // Its phones go with it: every link through a relay ends, and every
      // offer to press it was sent is void (STATUS section 2.208).
      await endLinksOf(tx, `seat:${seatId}`, this.#now());
      return rows[0];
    });
    if (!revoked) throw new PalugadaError('contract.violation', 'no such seat in this company, or it is already ended', { seatId });
    if (revoked.secret_ref?.startsWith('db://')) await deleteSecret(revoked.secret_ref.slice('db://'.length));
  }

  /**
   * A code matched: claimed by the write, so a second presentation of the
   * same code, or of an older one, changes no row.
   */
  async #claim(seatId: string, step: number): Promise<void> {
    if (!await withControlPlane((tx) => this.#claimWithin(tx, seatId, step))) throw replayed();
  }

  /** The claim inside a transaction the caller holds; false when the step was used already. */
  async #claimWithin(tx: TenantClient, seatId: string, step: number): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE staff_seats SET last_step = $2, last_used_at = $3
        WHERE id = $1 AND revoked_at IS NULL AND (last_step IS NULL OR last_step < $2)`,
      [seatId, step, this.#now()]);
    return rowCount === 1;
  }

  /**
   * Refuses any of these names the owner may not give in this company, and
   * answers each one's skeleton to keep: a name like the owner's, PALUGADA's,
   * the CEO's, the system's or a role's is reserved; one like a live
   * colleague's name or handle (other than `except`'s, the seat being
   * renamed), or like another of the same batch, is taken, so `@rina` and a
   * Rina are one person. The refusal names the name as the owner wrote it,
   * and its place when there are several. Taken in its turn
   * (`PEOPLE_NAMES_LOCK`), so the seats it reads are all there are.
   */
  async #vetNames(tx: TenantClient, companyId: string, names: readonly string[], except: string | null): Promise<string[]> {
    await tx.query(PEOPLE_NAMES_LOCK);
    await this.#fillSkeletons(tx, companyId);
    const reserved = await reservedLooks(tx, companyId, RESERVED_NAMES);
    const { rows } = await tx.query<{ name: string; handle: string | null }>(
      'SELECT name, handle FROM staff_seats WHERE company_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [companyId, except]);
    const colleagues = rows.flatMap((row) => [looks(row.name), ...(row.handle === null ? [] : [looks(row.handle)])]);
    const batch: string[][] = [];
    for (const [index, name] of names.entries()) {
      const named: Named = names.length > 1 ? { name, index } : { name };
      const mine = looks(name);
      if (looksAlike(mine, reserved)) throw nameReserved(named);
      if (colleagues.some((other) => looksAlike(mine, other)) || batch.some((other) => looksAlike(mine, other))) throw nameTaken(named);
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
    await tx.query(PEOPLE_NAMES_LOCK);
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
    const read = () => tx.query<{ id: string; name: string; name_skeleton: string | null }>(
      'SELECT id, name, name_skeleton FROM staff_seats WHERE company_id = $1 AND revoked_at IS NULL ORDER BY created_at, id',
      [companyId]);
    let { rows } = await read();
    if (rows.every((row) => row.name_skeleton !== null)) return;
    // Filled in the turn names are given in, and read again once it is ours.
    await tx.query(PEOPLE_NAMES_LOCK);
    ({ rows } = await read());
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
