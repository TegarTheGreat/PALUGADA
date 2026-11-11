/**
 * Tenant-scoped database access.
 *
 * Every agent-facing query runs through here. The scope is established with
 * set_config(..., is_local => true) inside an explicit transaction, so the
 * setting is discarded at COMMIT or ROLLBACK. That detail matters: with a
 * connection pool, a session-level SET would outlive the request and leak the
 * previous tenant's scope into whoever borrows the connection next -- a bug
 * that reads as random cross-tenant access and is very hard to reproduce.
 *
 * The company id is bound as a parameter rather than interpolated, so a value
 * reaching this function from a task payload cannot terminate the literal and
 * append SQL.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { PalugadaError } from '../errors.ts';
import { appPool, adminPool } from './pool.ts';

export interface TenantClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * How a transaction begins. `oneMoment` reads the database as it was when its
 * first statement ran, every statement of it alike, and writes nothing
 * (REPEATABLE READ, READ ONLY): what a company's archive is taken in, so a
 * row it carries never names one it does not. `pg_export_snapshot()` hands
 * that moment to a control-plane transaction (`withControlPlane`'s `moment`).
 */
export interface Beginning {
  oneMoment?: boolean;
}

const ONE_MOMENT = 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY';

export async function withTenant<T>(
  companyId: string,
  fn: (tx: TenantClient) => Promise<T>,
  beginning: Beginning = {},
): Promise<T> {
  return scoped(appPool(), companyId, null, fn, beginning.oneMoment ? ONE_MOMENT : 'BEGIN');
}

/**
 * Who reads the people's rooms in a transaction (0150). An agent's
 * transaction names none, and every room table then returns nothing and
 * refuses every write, even in its own company.
 *
 * - `people`: a person, as themselves, sees what that person may see.
 * - `delivery`: what tells people something changed -- rooms, membership,
 *   places, the feed, attention -- and never a message, a revision, a
 *   reaction or a file.
 * - `platform`: the card sweep and the rooms every company has; it writes
 *   only the platform's own rows.
 */
type PeopleReader = 'people' | 'delivery' | 'platform';

interface Reading {
  reader: PeopleReader;
  principal: string;
  principalName: string;
  via: string;
  viaRelay: string;
}

/**
 * A person in a room: the owner (`'owner'`), or a staff seat
 * (`'seat:<uuid>'`), with the name the owner gave the seat -- never a name a
 * request body sent. Made from a verified session in
 * src/workspace/principal.ts, or by the relay's inbound code for the person a
 * token names.
 */
export interface Person {
  readonly principal: string;
  /** The seat's name as the owner set it; null for the owner, who is drawn as the owner. */
  readonly name: string | null;
}

/**
 * Set while the owner's assistant (the CEO's or PALUGADA's own) dispatches a
 * route on the owner's behalf; the owner API enters it around the handler.
 * The people's helpers refuse inside it, so no person's words reach a model
 * through the assistant, even by a route somebody forgot to keep from it.
 */
export const assistantDispatch = new AsyncLocalStorage<true>();

function refuseTheAssistant(): void {
  if (assistantDispatch.getStore() !== undefined) {
    throw new PalugadaError('staff.forbidden', "the assistant does not read or write people's words", {});
  }
}

const PRINCIPAL = /^(owner|seat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A person's transaction in one company: they see the rooms they may see
 * and write only as themselves (F19.3). What the database records as the
 * message's author, its name and where it came from is set here, from the
 * person, and nowhere else: the room tables' triggers read these settings
 * rather than what an insert says. A relay's inbound code passes the relay
 * it came through; everything else came from the console.
 */
export async function withPeople<T>(
  companyId: string,
  person: Person,
  fn: (tx: TenantClient) => Promise<T>,
  via?: { relayId: string },
): Promise<T> {
  refuseTheAssistant();
  if (!PRINCIPAL.test(person.principal)) {
    throw new PalugadaError('contract.violation',
      `a room is read and written by a person, the owner or a seat, never by ${JSON.stringify(person.principal)}`,
      { principal: person.principal });
  }
  const isOwner = person.principal === 'owner';
  if (isOwner ? person.name !== null : !(typeof person.name === 'string' && person.name.length >= 1 && person.name.length <= 120)) {
    throw new PalugadaError('contract.violation',
      isOwner ? 'the owner is drawn as the owner, with no name of their own in a room'
        : 'a seat is named in a room by the name the owner gave it, 1 to 120 characters',
      { principal: person.principal });
  }
  if (via && !UUID.test(via.relayId)) {
    throw new PalugadaError('contract.violation', 'a message through a relay names the relay by its id', { relayId: via.relayId });
  }
  return scoped(appPool(), companyId, {
    reader: 'people',
    principal: person.principal,
    principalName: person.name ?? '',
    via: via ? 'relay' : 'console',
    viaRelay: via?.relayId ?? '',
  }, fn);
}

/**
 * What tells people that something changed: the live hub, the planner of
 * people's notices, the relay's people envelopes. It reads positions and ids,
 * never words, and writes nothing.
 */
export async function withDelivery<T>(companyId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  refuseTheAssistant();
  return scoped(appPool(), companyId, { reader: 'delivery', principal: '', principalName: '', via: '', viaRelay: '' }, fn);
}

/**
 * The platform in a company's rooms: the rooms every company has and the
 * cards drawn from its work. It sees every room table of the company and
 * writes only the platform's own rows -- a card, never a person's words.
 */
export async function withRoomPlatform<T>(companyId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  refuseTheAssistant();
  return scoped(appPool(), companyId, { reader: 'platform', principal: '', principalName: '', via: '', viaRelay: '' }, fn);
}

/**
 * Before the control plane writes a room table -- revoking a seat, a
 * retention purge, a restore -- inside a `withControlPlane` transaction. The
 * admin pool bypasses row security, but the room tables' triggers run as the
 * schema's owner, which does not: they need the company, and they read
 * `control` to allow what only the control plane does (a revoked seat's
 * leaving, a tombstone). `importing` is a restore or an import, which writes
 * no feed, notice, mention or follow per row.
 */
export async function roomsOnControlPlane(
  tx: TenantClient,
  companyId: string,
  options: { importing?: boolean } = {},
): Promise<void> {
  await tx.query(
    "SELECT set_config('app.company_id', $1, true), set_config('app.reader', 'control', true), set_config('app.importing', $2, true)",
    [companyId, options.importing ? 'on' : '']);
}

/**
 * One transaction on `pool`, scoped to a company and, for the people's
 * rooms, to a reader. Commits, or fails loudly.
 */
async function scoped<T>(
  pool: pg.Pool,
  companyId: string,
  reading: Reading | null,
  fn: (tx: TenantClient) => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  let committing = false;
  try {
    await client.query(begin);
    if (reading === null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.company_id', companyId]);
    } else {
      // Every setting the room tables read, in one statement, each local to
      // the transaction: a pooled connection carries none of them to the
      // next borrower.
      await client.query(
        `SELECT set_config('app.company_id', $1, true), set_config('app.reader', $2, true),
                set_config('app.principal', $3, true), set_config('app.principal_name', $4, true),
                set_config('app.via', $5, true), set_config('app.via_relay', $6, true)`,
        [companyId, reading.reader, reading.principal, reading.principalName, reading.via, reading.viaRelay]);
    }
    const result = await fn({ query: (text, values) => client.query(text, values) });
    committing = true;
    await commitOrFail(client);
    return result;
  } catch (error) {
    // A COMMIT that failed -- a deferred constraint refusing it, such as a
    // company left without its CEO -- has already ended the transaction; a
    // ROLLBACK after it only puts a warning in the database's log.
    if (!committing) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Commits, and refuses to pretend a discarded transaction succeeded.
 *
 * In PostgreSQL any error aborts the surrounding transaction, and a COMMIT
 * issued afterwards does not fail -- it quietly performs a ROLLBACK and
 * reports the tag `ROLLBACK`. So a caller that catches an error inside its
 * callback and carries on gets a clean return value and loses every write it
 * made, with nothing anywhere saying so. That is silent data loss, which is
 * the one outcome G1 rules out, so it is turned into a loud failure here.
 */
async function commitOrFail(client: pg.PoolClient): Promise<void> {
  const result = await client.query('COMMIT');
  if (result.command === 'ROLLBACK') {
    throw new Error(
      'transaction was aborted before COMMIT and has been rolled back; ' +
        'an error was raised inside the transaction and swallowed, so no write survived',
    );
  }
}

/** What `pg_export_snapshot()` answers: hex words joined by dashes, nothing that could end a literal. */
const MOMENT = /^[0-9A-Fa-f]{1,16}(-[0-9A-Fa-f]{1,16}){1,2}$/;

/**
 * Control-plane access, outside any tenant scope.
 *
 * Reserved for platform operations such as creating a company or reading a
 * cross-tenant digest. Passing agent-supplied input to this function defeats
 * the isolation boundary, so callers should be few and obvious.
 *
 * `moment` is a moment another transaction exported (`pg_export_snapshot()`,
 * in a `oneMoment` transaction still open): this one then reads exactly what
 * that one reads, and writes nothing.
 */
export async function withControlPlane<T>(fn: (tx: TenantClient) => Promise<T>, options: { moment?: string } = {}): Promise<T> {
  if (options.moment !== undefined && !MOMENT.test(options.moment)) {
    throw new Error(`a moment is what pg_export_snapshot() answered, not ${JSON.stringify(options.moment)}`);
  }
  const client = await adminPool().connect();
  let committing = false;
  try {
    await client.query(options.moment === undefined ? 'BEGIN' : ONE_MOMENT);
    // Before any other statement, which is the only place PostgreSQL takes it.
    if (options.moment !== undefined) await client.query(`SET TRANSACTION SNAPSHOT '${options.moment}'`);
    const result = await fn({ query: (text, values) => client.query(text, values) });
    committing = true;
    await commitOrFail(client);
    return result;
  } catch (error) {
    // As in withTenant: a failed COMMIT has already ended the transaction.
    if (!committing) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
