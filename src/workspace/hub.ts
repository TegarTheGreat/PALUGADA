/**
 * The live hub: what a person's console hears as a company's rooms and work
 * change (F19.11; STATUS section 2.210).
 *
 * A console tab holds one stream per company, the room stream, and hears on
 * it everything that tells it to read something again: a room's change, as a
 * position and ids and never a word, and the company's work as `/live` sends
 * it. One stream rather than two because a browser gives an origin six
 * HTTP/1.1 connections, and three tabs each holding two streams would leave
 * their pages none to load with.
 *
 * **One reader per company, not per stream.** For each company someone is
 * listening to, this process opens one delivery transaction when the database
 * says the rooms changed (a NOTIFY the feed's own writer sends at commit,
 * gathered for a quarter of a second) or every five seconds, whichever comes
 * first, and reads the feed after where it last read, then the rooms, their
 * access and who listens to `@room` for that batch, one query at a time.
 * Which frame goes to whom is decided here from those rows, with the rule the
 * rooms' policy holds in SQL (0150), read fresh for every batch, so a person
 * removed from a room hears nothing more of it from the next change on. The
 * journal is read once a second per company the same way, for the work.
 *
 * **Order.** Positions come from the company's clock row, which every room
 * write locks before it writes, so a position is taken only after the one
 * before it committed: reading after a cursor never skips a row that commits
 * late. A stream that comes back with the last id it heard is sent what it
 * missed, read as its person so the database applies the same rule, and then
 * what is live, each position once; one whose id the kept feed no longer
 * reaches (the feed is bookkeeping, purged after a fortnight), or that is
 * ahead of the company's clock, is told to read everything again, and where
 * to resume from.
 *
 * **Ending.** A stream is the session's that opened it, `/live`'s as much as
 * the room stream. Signing out, a seat revoked or its kind changed, and a
 * device revoked end the streams in this process at once (`StreamRegistry`),
 * and are told to every other process of the deployment on
 * `palugada_people_end`, which this process listens to while it holds any
 * stream. Every twenty-five seconds the hub asks again whether the session
 * behind each stream of the process is live, all at once and by its token's
 * hash, for whatever no process heard of: within F19.11's thirty seconds,
 * the asking included.
 */
import { AsyncResource } from 'node:async_hooks';
import pg from 'pg';
import { connectionString } from '../config.ts';
import { withControlPlane, withDelivery, withPeople, type Person, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { EventStream, StreamRegistry, type PeopleHub, type RoomStreamOpening, type StreamEnd } from '../owner/route.ts';
import type { OwnerSessions } from '../owner/session.ts';
import type { StaffSeats } from '../owner/staff.ts';
import { databaseNow, eventsAfter } from '../owner/views.ts';
import type { RoomFrame } from './contract.ts';

/**
 * Streams one person may hold open in one company: five tabs. Over HTTP/1.1
 * a browser holds six connections to an address, so a refused sixth tab,
 * which reads on its clocks instead, leaves one for every tab's requests.
 */
const STREAMS_PER_PERSON = 5;
/** Streams one process holds open at most. */
const STREAMS_PER_PROCESS = 2_000;
/** The longest a company's rooms go unread while someone listens, when no NOTIFY came. */
const POLL_MS = 5_000;
/** How long a NOTIFY waits for others, so a burst of changes is one read. */
const GATHER_MS = 250;
/**
 * How often the session behind each stream is asked again: under thirty
 * seconds, so a stream whose session ended where nobody was told ends within
 * F19.11's thirty, the asking included.
 */
const VERIFY_MS = 25_000;
/** How often the journal is read for the work's frames, as `/live` reads it. */
const WORK_MS = 1_000;
/** How far back each read of the journal looks again, for a transaction that committed late (as `/live`). */
const WORK_LOOKBACK_MS = 30_000;
/** Rows of the feed one read takes; more are read straight after. */
const BATCH = 500;
/** Rows a returning stream is sent of what it missed; further behind, it is told to read everything again. */
const REPLAY_MOST = 1_000;
/**
 * The longest a stream waits for this process to be listening, counted from
 * when the hub began to connect, before it goes on without: the five-second
 * read keeps it right meanwhile.
 */
const LISTEN_WAIT_MS = 2_000;
/**
 * How long the hub's connection may take to be made, and its LISTEN to be
 * answered, before it is given up and tried again later: a pooler that takes
 * the connection and never answers would otherwise hold it for ever.
 */
const CONNECT_MS = 10_000;

/**
 * What this process has done, for the metrics (src/reporting/metrics.ts): the
 * room streams open now, and how often the feed and the journal were read.
 */
export const HUB_COUNTS = { streams: 0, feedReads: 0, workReads: 0 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PERSON = /^(owner|seat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** One open room stream. */
interface Subscriber {
  readonly companyId: string;
  readonly person: Person;
  readonly kind: RoomStreamOpening['kind'];
  /** The session's token, kept only as its hash: what the check of its session asks after. */
  readonly tokenHash: string;
  /** The newest position this stream was sent, or was decided past. */
  through: number;
  /** Frames held while the stream is sent what it missed; null once it is live. */
  held: Array<{ frame: RoomFrame; id?: string }> | null;
  send: ((data: unknown, id?: string) => void) | null;
  /** Set once the stream has ended, so it is counted out once. */
  left: boolean;
}

/** A company someone is listening to, in this process. */
interface Company {
  readonly id: string;
  readonly subscribers: Set<Subscriber>;
  /** The feed is read after this position: the clock when the first subscriber came. */
  cursor: number;
  /** Whether a read is going on, and whether another is owed when it ends. */
  reading: boolean;
  again: boolean;
  gathering: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  /** The journal, read as `/live` reads it: from when the company was first listened to. */
  work: { looked: Date; newest: Date; sent: Map<string, number>; timer: NodeJS.Timeout | null; reading: boolean };
}

/** A row of the feed, as a batch reads it. */
interface FeedRow {
  position: string;
  room_id: string;
  kind: Extract<RoomFrame, { position: number }>['kind'];
  ref: string | null;
  principal: string | null;
  author: string | null;
  mentions: string[];
  mentions_room: boolean;
}

/** A batch: the feed's rows, and what deciding who hears each needs. */
interface Batch {
  rows: FeedRow[];
  /** Each room of the batch that still exists: its kind, and whether it is private. */
  rooms: Map<string, { kind: string; private: boolean }>;
  /** Who may see each private or direct room of the batch. */
  access: Map<string, Set<string>>;
  /** Who listens to `@room` in each room of the batch that was called. */
  listening: Map<string, Set<string>>;
}

interface HubOptions {
  sessions: OwnerSessions;
  staff: StaffSeats;
  /** The streams this process holds open, which an end told by another process ends. */
  streams: StreamRegistry;
  /**
   * The database the hub LISTENs on: a direct connection, where the
   * application's own goes through a pooler that does not keep a session's
   * LISTEN (PgBouncer in transaction mode). The application's URL when unset.
   */
  listenUrl?: string;
}

/** The live hub of one process (see the file's comment). */
export class RoomHub implements PeopleHub {
  readonly #options: HubOptions;
  readonly #companies = new Map<string, Company>();
  /**
   * Every stream of this process by company and person, counted from the
   * moment it is asked for, so streams asked for at once are each counted
   * against the others before any of them is open.
   */
  readonly #held = new Map<string, Set<Subscriber>>();
  /**
   * Where the hub's timers and connection run: the context it was made in,
   * not the request that first opened a stream, so nothing a request carried
   * is kept alive by them, or read by them.
   */
  readonly #scope = new AsyncResource('palugada-hub');
  #client: pg.Client | null = null;
  /** A connection being made, which never fails: a failure is tried again later (`#lost`). */
  #connecting: Promise<void> | null = null;
  /** When the hub began to make it: a stream waits for it at most `LISTEN_WAIT_MS` from then. */
  #connectingSince = 0;
  #retry: NodeJS.Timeout | null = null;
  #retryMs = 1_000;
  #verifying: NodeJS.Timeout | null = null;
  /** Raised by every close, so a reconnection or a timer begun before it does nothing after. */
  #generation = 0;

  constructor(options: HubOptions) {
    this.#options = options;
  }

  /**
   * A person's room stream in one company: refused when the person already
   * holds five there, or the process two thousand. `lastEventId` is the
   * position the person's console last heard, which it sends back on
   * reconnecting.
   */
  async stream(opening: RoomStreamOpening): Promise<EventStream> {
    if (!UUID.test(opening.companyId)) {
      throw new PalugadaError('contract.violation', `a company is named by its id, not ${JSON.stringify(opening.companyId)}`, { companyId: opening.companyId });
    }
    if (!PERSON.test(opening.person.principal)) {
      throw new PalugadaError('contract.violation', 'a room stream is a person\'s: the owner or a seat', { principal: opening.person.principal });
    }
    const whose = `${opening.companyId} ${opening.person.principal}`;
    const theirs = this.#held.get(whose)?.size ?? 0;
    if (theirs >= STREAMS_PER_PERSON || HUB_COUNTS.streams >= STREAMS_PER_PROCESS) {
      throw new PalugadaError('stream.too_many',
        theirs >= STREAMS_PER_PERSON
          ? `a person holds at most ${STREAMS_PER_PERSON} room streams of one company open; close a tab first`
          : 'this process holds as many streams as it can; try again in a moment',
        { most: theirs >= STREAMS_PER_PERSON ? STREAMS_PER_PERSON : STREAMS_PER_PROCESS });
    }
    const subscriber: Subscriber = {
      companyId: opening.companyId,
      person: opening.person,
      kind: opening.kind,
      tokenHash: StreamRegistry.hashOf(opening.token),
      through: 0,
      held: [],
      send: null,
      left: false,
    };
    // Counted before anything is awaited.
    const mine = this.#held.get(whose) ?? new Set<Subscriber>();
    mine.add(subscriber);
    this.#held.set(whose, mine);
    HUB_COUNTS.streams += 1;
    let company: Company | null;
    try {
      // Listening first, so an end another process tells from here on is heard.
      await this.listening();
      company = await this.#join(subscriber);
    } catch (error) {
      this.#leave(subscriber);
      throw error;
    }
    if (company) subscriber.through = company.cursor;
    const after = positionOf(opening.lastEventId);
    return new EventStream(async (send, signal) => {
      try {
        // The hub closed while this stream joined, as the API closes: the
        // stream ends at once, and the console asks for it again, of whichever
        // process answers then, rather than being refused for good.
        if (!company) return;
        subscriber.send = send;
        await this.#catchUp(subscriber, after);
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
      } finally {
        this.#leave(subscriber);
      }
    });
  }

  /**
   * Tells every process of the deployment, this one included, that the
   * streams of a session, a person or a device end: each ends its own. The
   * caller has already ended this process's.
   */
  async ended(what: StreamEnd): Promise<void> {
    const key = 'tokenHash' in what ? `token:${what.tokenHash}` : 'principal' in what ? `person:${what.principal}` : `factor:${what.factor}`;
    try {
      await withControlPlane((tx) => tx.query("SELECT pg_notify('palugada_people_end', $1)", [key]));
    } catch {
      // What ended has ended in the database already; a process not told
      // finds it when it next asks after its streams, within thirty seconds.
    }
  }

  /**
   * This process listening for the rooms' changes and for streams ended
   * elsewhere, and asking after its streams' sessions every twenty-five
   * seconds: connected once, and again after a loss while it holds any
   * stream. Every stream begins it, `/live`'s too, so a process that holds
   * only `/live` open hears an end told elsewhere as well.
   */
  async listening(): Promise<void> {
    this.#checking();
    // Listening already, or trying again on its own clock: a stream neither waits nor begins another try.
    if (this.#client || this.#retry) return;
    const connecting = this.#connecting ?? this.#begin();
    // At most two seconds from when the hub began to connect, not two seconds
    // for each stream: a database that takes the connection and never answers
    // holds up the first stream alone, and the five-second read keeps every
    // stream right meanwhile.
    const left = this.#connectingSince + LISTEN_WAIT_MS - Date.now();
    if (left <= 0) return;
    let waited: NodeJS.Timeout | undefined;
    await Promise.race([connecting, new Promise<void>((resolve) => { waited = setTimeout(resolve, left); })]);
    clearTimeout(waited);
  }

  /** Ends every subscriber's reading and the hub's connection: the API is closing. A later stream begins it again. */
  async close(): Promise<void> {
    this.#generation += 1;
    for (const company of this.#companies.values()) this.#stop(company);
    this.#companies.clear();
    if (this.#verifying) clearInterval(this.#verifying);
    this.#verifying = null;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#retryMs = 1_000;
    // A connection still being made is not waited for: the raised generation
    // ends it once it is made, or it is given up within `CONNECT_MS`. Waiting
    // would hold the API's close, and with it a restart that takes up new
    // settings, on a database that may never answer.
    const client = this.#client;
    this.#client = null;
    if (client) await endQuietly(client);
  }

  /* ----------------------------------------------------------- listening --- */

  /** A connection begun, in the hub's own context. */
  #begin(): Promise<void> {
    const generation = this.#generation;
    this.#connectingSince = Date.now();
    const connecting = this.#scope.runInAsyncScope(() => this.#connect(generation)).finally(() => { this.#connecting = null; });
    this.#connecting = connecting;
    return connecting;
  }

  /** The check of every stream's session (`#verify`): begun by the first stream, ended by a check that finds none, or by closing. */
  #checking(): void {
    if (this.#verifying) return;
    this.#scope.runInAsyncScope(() => {
      this.#verifying = setInterval(() => void this.#verify(), VERIFY_MS);
      // The streams keep the process up, not the check of them.
      this.#verifying.unref();
    });
  }

  /** Connects and LISTENs; never fails, since a failure is tried again later (`#lost`). */
  async #connect(generation: number): Promise<void> {
    const client = new pg.Client({
      connectionString: this.#options.listenUrl ?? connectionString('app'),
      // Named, so an operator reading pg_stat_activity knows what holds it.
      application_name: 'palugada-hub',
      // A database that takes the connection and never answers, a pooler that
      // hangs, is given up and tried again later rather than waited on for ever.
      connectionTimeoutMillis: CONNECT_MS,
      query_timeout: CONNECT_MS,
      // And one that goes away without a word once connected is found by the
      // operating system's probes, rather than when the next notice never comes.
      keepAlive: true,
    });
    client.on('notification', (message) => this.#heard(message.channel, message.payload ?? ''));
    client.on('error', () => this.#lost(client, generation));
    client.on('end', () => this.#lost(client, generation));
    try {
      await client.connect();
      await client.query('LISTEN palugada_people');
      await client.query('LISTEN palugada_people_end');
    } catch {
      await endQuietly(client);
      this.#lost(client, generation);
      return;
    }
    if (generation !== this.#generation) {
      await endQuietly(client);
      return;
    }
    this.#client = client;
    this.#retryMs = 1_000;
    // What changed while nobody here was listening is in the feed: read it now.
    for (const company of this.#companies.values()) this.#soon(company, 0);
  }

  /**
   * The connection went, or never came: tried again, a little later each
   * time, while this process holds any stream, `/live`'s included, since an
   * end told by another process reaches it only here. With no stream open it
   * is not tried; the next stream connects again.
   */
  #lost(client: pg.Client, generation: number): void {
    if (this.#client === client) this.#client = null;
    if (generation !== this.#generation || this.#retry) return;
    const wait = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (generation !== this.#generation || this.#client || this.#connecting) return;
      if (this.#companies.size === 0 && this.#options.streams.size === 0) return;
      void this.#begin();
    }, wait);
    // A retry alone does not keep the process up: the API's close clears it.
    this.#retry.unref();
  }

  /** A NOTIFY: a company's rooms changed, its CEO conversation did, or a session's streams end. */
  #heard(channel: string, payload: string): void {
    if (channel === 'palugada_people_end') {
      const [what, ...rest] = payload.split(':');
      const value = rest.join(':');
      if (what === 'token' && /^[0-9a-f]{64}$/.test(value)) this.#options.streams.endTokenHash(value);
      else if (what === 'person' && PERSON.test(value)) this.#options.streams.endPrincipal(value);
      else if (what === 'factor' && UUID.test(value)) this.#options.streams.endFactor(value);
      return;
    }
    const [companyId, about] = payload.split(':');
    const company = this.#companies.get(companyId ?? '');
    if (!company) return;
    if (about === 'ceo') {
      // The owner's conversation with the CEO: the owner's alone, and no word of it.
      for (const subscriber of company.subscribers) {
        if (subscriber.person.principal === 'owner') this.#give(subscriber, { kind: 'ceo' });
      }
      return;
    }
    this.#soon(company, GATHER_MS);
  }

  /* ----------------------------------------------------------- companies --- */

  /**
   * A subscriber added to its company, which is begun when it is the first:
   * where the feed is read from. Null when the hub closed meanwhile.
   */
  async #join(subscriber: Subscriber): Promise<Company | null> {
    let company = this.#companies.get(subscriber.companyId);
    if (!company) {
      const generation = this.#generation;
      // The clock as it is now, read by the delivery reader: people never read it.
      const cursor = await clockOf(subscriber.companyId);
      const looked = await databaseNow(subscriber.companyId);
      if (generation !== this.#generation) return null;
      // Another stream may have begun the company while this one read the clock.
      company = this.#companies.get(subscriber.companyId);
      if (!company) {
        company = {
          id: subscriber.companyId,
          subscribers: new Set(),
          cursor,
          reading: false,
          again: false,
          gathering: null,
          poll: null,
          work: { looked, newest: looked, sent: new Map(), timer: null, reading: false },
        };
        this.#companies.set(company.id, company);
        const begun = company;
        this.#scope.runInAsyncScope(() => {
          begun.poll = setInterval(() => this.#soon(begun, 0), POLL_MS);
          begun.work.timer = setInterval(() => void this.#readWork(begun), WORK_MS);
        });
      }
    }
    company.subscribers.add(subscriber);
    return company;
  }

  /** A stream ended: forgotten, and its company with it when nobody else listens. */
  #leave(subscriber: Subscriber): void {
    if (subscriber.left) return;
    subscriber.left = true;
    HUB_COUNTS.streams = Math.max(0, HUB_COUNTS.streams - 1);
    const whose = `${subscriber.companyId} ${subscriber.person.principal}`;
    const mine = this.#held.get(whose);
    mine?.delete(subscriber);
    if (mine?.size === 0) this.#held.delete(whose);
    const company = this.#companies.get(subscriber.companyId);
    if (company?.subscribers.delete(subscriber) && company.subscribers.size === 0) {
      this.#stop(company);
      this.#companies.delete(company.id);
    }
  }

  #stop(company: Company): void {
    if (company.poll) clearInterval(company.poll);
    if (company.gathering) clearTimeout(company.gathering);
    if (company.work.timer) clearInterval(company.work.timer);
    company.poll = null;
    company.gathering = null;
    company.work.timer = null;
  }

  /** A read of the company's feed in `ms`, unless one is already coming. */
  #soon(company: Company, ms: number): void {
    if (company.gathering || !this.#companies.has(company.id)) return;
    this.#scope.runInAsyncScope(() => {
      company.gathering = setTimeout(() => {
        company.gathering = null;
        void this.#read(company);
      }, ms);
    });
  }

  /* ------------------------------------------------------------- reading --- */

  /**
   * Reads what changed in a company's rooms since the last read, and tells
   * each subscriber what they may see of it. One read at a time per company;
   * a change heard during one is read straight after.
   */
  async #read(company: Company): Promise<void> {
    if (company.reading) {
      company.again = true;
      return;
    }
    company.reading = true;
    try {
      do {
        company.again = false;
        HUB_COUNTS.feedReads += 1;
        const batch = await withDelivery(company.id, (tx) => batchAfter(tx, company.id, company.cursor));
        if (!this.#companies.has(company.id)) return;
        this.#deliver(company, batch);
        if (batch.rows.length === BATCH) company.again = true;
      } while (company.again && this.#companies.has(company.id));
    } catch {
      // The database's moment: the next notice, or the next five-second read,
      // reads from the same cursor, so nothing is lost by waiting.
    } finally {
      company.reading = false;
    }
  }

  #deliver(company: Company, batch: Batch): void {
    for (const row of batch.rows) {
      const position = Number(row.position);
      for (const subscriber of company.subscribers) {
        if (!sees(subscriber.person.principal, row, batch)) continue;
        this.#give(subscriber, frameOf(row, subscriber.person.principal, batch.listening), String(position));
      }
      company.cursor = Math.max(company.cursor, position);
    }
  }

  /** The company's work, as `/live` reads it, once for every subscriber of the company. */
  async #readWork(company: Company): Promise<void> {
    const work = company.work;
    if (work.reading) return;
    work.reading = true;
    try {
      const from = new Date(Math.max(work.looked.getTime(), work.newest.getTime() - WORK_LOOKBACK_MS));
      HUB_COUNTS.workReads += 1;
      for (const event of await eventsAfter(company.id, from)) {
        if (work.sent.has(event.id)) continue;
        work.sent.set(event.id, event.at.getTime());
        if (event.at > work.newest) work.newest = event.at;
        const frame = { kind: 'work', id: event.id, type: event.type, taskId: event.taskId, actor: event.actor, at: event.at.toISOString() } as const;
        for (const subscriber of company.subscribers) this.#give(subscriber, frame);
      }
      for (const [id, at] of work.sent) if (at < work.newest.getTime() - 2 * WORK_LOOKBACK_MS) work.sent.delete(id);
    } catch {
      // As `/live`: the next read tries again.
    } finally {
      work.reading = false;
    }
  }

  /**
   * A stream that came back with the last position it heard is sent what it
   * missed, read as its person, then what came while that was read. One with
   * no position hears from now on, and is told the newest position it could
   * have seen, so a reconnection after a quiet spell misses nothing. One
   * whose position the kept feed no longer reaches, or the company's clock
   * has not reached, is told to read everything again, with that newest
   * position as its id, so the console's next reconnection resumes from
   * there rather than being told to reset again.
   */
  async #catchUp(subscriber: Subscriber, after: number | null): Promise<void> {
    const joined = subscriber.through;
    const { companyId, person } = subscriber;
    // What the person could have seen by the time they joined, read as them: the clock itself is never sent.
    const newest = async () => {
      const seen = await withPeople(companyId, person, (tx) => newestSeen(tx, companyId, joined));
      return seen === null ? undefined : String(seen);
    };
    try {
      if (after === null) {
        const id = await newest();
        if (id !== undefined) subscriber.send?.(undefined, id);
      } else if (after < joined) {
        const oldest = await withDelivery(companyId, (tx) => oldestKept(tx, companyId));
        const missed = oldest === null || after < oldest - 1
          ? null
          : await withPeople(companyId, person, (tx) => missedSince(tx, companyId, person.principal, after, joined));
        if (missed === null || (missed.rows.length === REPLAY_MOST && Number(missed.rows.at(-1)!.position) < joined)) {
          subscriber.send?.({ kind: 'reset' }, await newest());
        } else {
          for (const row of missed.rows) {
            subscriber.send?.(frameOf(row, person.principal, missed.listening), row.position);
          }
        }
      } else if (after > joined && after > await clockOf(companyId)) {
        // A position the company has not reached: an id kept from before the
        // database was restored to an earlier moment. Waiting for the clock to
        // pass it would leave the stream silent until then.
        subscriber.send?.({ kind: 'reset' }, await newest());
      } else {
        // Ahead of where this process has read: what it heard elsewhere is not sent again.
        subscriber.through = after;
      }
    } catch {
      // What was missed could not be read: the console reads everything again instead.
      subscriber.send?.({ kind: 'reset' });
    }
    const held = subscriber.held ?? [];
    subscriber.held = null;
    for (const one of held) this.#give(subscriber, one.frame, one.id);
  }

  /** A frame to one subscriber: held while it catches up, and never a position twice. */
  #give(subscriber: Subscriber, frame: RoomFrame, id?: string): void {
    if (subscriber.held) {
      subscriber.held.push(id === undefined ? { frame } : { frame, id });
      return;
    }
    if ('position' in frame) {
      if (frame.position <= subscriber.through) return;
      subscriber.through = frame.position;
    }
    subscriber.send?.(frame, id);
  }

  /* ----------------------------------------------------------- verifying --- */

  /**
   * The session behind every stream of this process asked again, all at once
   * and by its token's hash: `/live`'s as well as the room streams'. A
   * session ended, a device or a seat revoked, or a seat's kind changed where
   * no process here heard of it, ends the streams it opened. With no stream
   * open, the check ends; the next stream begins it.
   */
  async #verify(): Promise<void> {
    const open: Array<{ tokenHash: string; principal: string; companyId: string | null; kind: RoomStreamOpening['kind'] | null }> = [
      ...this.#options.streams.sessions().map((one) => ({ ...one, kind: null })),
      // A room stream knows the kind of seat it was opened as, which `/live` does not.
      ...[...this.#companies.values()].flatMap((company) => [...company.subscribers].map((one) => ({
        tokenHash: one.tokenHash, principal: one.person.principal, companyId: one.companyId, kind: one.kind,
      }))),
    ];
    if (open.length === 0) {
      if (this.#verifying) clearInterval(this.#verifying);
      this.#verifying = null;
      return;
    }
    const owners = [...new Set(open.filter((one) => one.principal === 'owner').map((one) => one.tokenHash))];
    const seats = [...new Set(open.filter((one) => one.principal !== 'owner').map((one) => one.tokenHash))];
    try {
      const owner = owners.length > 0 ? await this.#options.sessions.liveByHash(owners) : new Map();
      const staff = seats.length > 0 ? await this.#options.staff.liveByHash(seats) : new Map();
      for (const one of open) {
        if (one.principal === 'owner') {
          if (!owner.has(one.tokenHash)) this.#options.streams.endTokenHash(one.tokenHash);
          continue;
        }
        const session = staff.get(one.tokenHash);
        if (!session || (one.companyId !== null && session.seat.companyId !== one.companyId)) this.#options.streams.endTokenHash(one.tokenHash);
        else if (one.kind !== null && session.seat.kind !== one.kind) this.#options.streams.endPrincipal(one.principal);
      }
    } catch {
      // Asked again in twenty-five seconds.
    }
  }
}

/** The position a console sends back (`Last-Event-ID`), or null for none or anything else. */
function positionOf(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** Ends a connection that may already have gone: pg's end answers once the socket is closed, however it closed. */
async function endQuietly(client: pg.Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // Gone already: nothing is left to end.
  }
}

/** Whether a person hears a row: the rooms' rule (0150), from the batch's rows. */
function sees(principal: string, row: FeedRow, batch: Batch): boolean {
  const room = batch.rooms.get(row.room_id);
  // A room gone since the row was written is nobody's to hear of.
  if (!room) return false;
  // A read mark is its reader's own, to their other devices.
  if (row.kind === 'read') return row.principal === principal;
  if (room.kind === 'company' || room.kind === 'division') return true;
  if (room.kind === 'topic' && (!room.private || principal === 'owner')) return true;
  return batch.access.get(row.room_id)?.has(principal) ?? false;
}

/** What one person is sent of a row: where and what, and whether it names them; never a word. */
function frameOf(row: FeedRow, principal: string, listening: Map<string, Set<string>>): RoomFrame {
  const mentioned = row.author !== principal
    && (row.mentions.includes(principal) || (row.mentions_room && (listening.get(row.room_id)?.has(principal) ?? false)));
  return {
    position: Number(row.position), kind: row.kind, room: row.room_id, ref: row.ref,
    ...(mentioned ? { mentioned: true } : {}),
  };
}

/** The company's clock: where a company first listened to is read from. */
async function clockOf(companyId: string): Promise<number> {
  return withDelivery(companyId, async (tx) => {
    const { rows } = await tx.query<{ position: string }>('SELECT position FROM room_clock WHERE company_id = $1', [companyId]);
    return Number(rows[0]?.position ?? 0);
  });
}

const FEED_COLUMNS = 'position, room_id, kind, ref, principal, author, mentions, mentions_room';

/** The feed after `cursor`, and the rooms, access and listeners its rows need, one query at a time. */
async function batchAfter(tx: TenantClient, companyId: string, cursor: number): Promise<Batch> {
  const { rows } = await tx.query<FeedRow>(
    `SELECT ${FEED_COLUMNS} FROM room_feed WHERE company_id = $1 AND position > $2 ORDER BY position LIMIT ${BATCH}`,
    [companyId, cursor]);
  const batch: Batch = { rows, rooms: new Map(), access: new Map(), listening: new Map() };
  if (rows.length === 0) return batch;
  const roomIds = [...new Set(rows.map((row) => row.room_id))];
  const { rows: rooms } = await tx.query<{ id: string; kind: string; private: boolean }>(
    'SELECT id, kind, private FROM rooms WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, roomIds]);
  for (const room of rooms) batch.rooms.set(room.id, { kind: room.kind, private: room.private });
  const closed = rooms.filter((room) => room.kind === 'direct' || room.private).map((room) => room.id);
  if (closed.length > 0) {
    const { rows: access } = await tx.query<{ room_id: string; principal: string }>(
      'SELECT room_id, principal FROM room_access WHERE company_id = $1 AND room_id = ANY($2::uuid[])', [companyId, closed]);
    for (const one of access) add(batch.access, one.room_id, one.principal);
  }
  const called = [...new Set(rows.filter((row) => row.mentions_room).map((row) => row.room_id))];
  if (called.length > 0) {
    for (const one of await listenersIn(tx, companyId, called)) add(batch.listening, one.room_id, one.principal);
  }
  return batch;
}

/**
 * Who hears `@room` in these rooms: their members who have not silenced them,
 * as the mention the database writes for it (0150).
 */
async function listenersIn(tx: TenantClient, companyId: string, roomIds: string[]): Promise<Array<{ room_id: string; principal: string }>> {
  const { rows } = await tx.query<{ room_id: string; principal: string }>(
    `SELECT m.room_id, m.principal
       FROM room_members m
       JOIN room_places p ON p.company_id = m.company_id AND p.room_id = m.room_id AND p.principal = m.principal
      WHERE m.company_id = $1 AND m.room_id = ANY($2::uuid[]) AND m.left_at IS NULL AND p.notify <> 'none'`,
    [companyId, roomIds]);
  return rows;
}

/** The newest position a person could have seen, at or before `through`: what a stream's first id is. */
async function newestSeen(tx: TenantClient, companyId: string, through: number): Promise<number | null> {
  const { rows } = await tx.query<{ newest: string | null }>(
    'SELECT max(position) AS newest FROM room_feed WHERE company_id = $1 AND position <= $2', [companyId, through]);
  return rows[0]?.newest === null || rows[0]?.newest === undefined ? null : Number(rows[0].newest);
}

/** The oldest position the feed still keeps, or null when it keeps none. */
async function oldestKept(tx: TenantClient, companyId: string): Promise<number | null> {
  const { rows } = await tx.query<{ oldest: string | null }>('SELECT min(position) AS oldest FROM room_feed WHERE company_id = $1', [companyId]);
  return rows[0]?.oldest === null || rows[0]?.oldest === undefined ? null : Number(rows[0].oldest);
}

/**
 * What a person missed between two positions, read as the person, so the
 * rooms' policy decides what they may hear of it as it does every read; and
 * which `@room` among it was for them.
 */
async function missedSince(
  tx: TenantClient, companyId: string, principal: string, after: number, through: number,
): Promise<{ rows: FeedRow[]; listening: Map<string, Set<string>> }> {
  const { rows } = await tx.query<FeedRow>(
    `SELECT ${FEED_COLUMNS} FROM room_feed WHERE company_id = $1 AND position > $2 AND position <= $3 ORDER BY position LIMIT ${REPLAY_MOST}`,
    [companyId, after, through]);
  const listening = new Map<string, Set<string>>();
  const called = [...new Set(rows.filter((row) => row.mentions_room).map((row) => row.room_id))];
  if (called.length > 0) {
    // The person's own place is all they can read of anyone's: enough to know whether `@room` was for them.
    for (const one of await listenersIn(tx, companyId, called)) if (one.principal === principal) add(listening, one.room_id, one.principal);
  }
  return { rows, listening };
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}
