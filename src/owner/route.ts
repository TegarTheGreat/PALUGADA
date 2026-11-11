/**
 * What a route of the owner API is, and what a route module is handed to
 * build its routes with (F19; the workspace plan).
 *
 * The owner API's own routes live in `api.ts`. The people's workspace adds
 * routes area by area -- rooms, people, the conversation's money, the relay,
 * meetings, search, imports -- each in its own module under `routes/`, so a
 * set that builds an area writes its own file rather than another hunk of one
 * eight-thousand-line file every other set is also writing. A module exports
 * one function that takes a `RouteKit` and returns its routes; `#buildRoutes`
 * spreads each beside the API's own, and the route tests read both
 * (`test/helpers/route-sources.ts`).
 *
 * `RouteKit` is what such a module may reach of the API: the second factor,
 * the sessions and seats, the deployment's options and settings, the files'
 * roots, the open streams and the live hub. It is frozen here; a set that
 * needs more widens it and `#kit()` together, and says so where it is merged.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Person } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { OwnerApiOptions } from './api.ts';
import type { OwnerSession, OwnerSessions } from './session.ts';
import type { StaffKind, StaffSeats, StaffSession } from './staff.ts';

/** What a handler is given: the request, who made it, and what it carried. */
export interface RouteContext {
  request: IncomingMessage;
  /** The owner's session; null for an open route, or a staff seat's request. */
  session: OwnerSession | null;
  /** A staff seat's session (0110), already held to what its seat may reach (staff-policy.ts). */
  staff: StaffSession | null;
  body: Record<string, unknown>;
  /** The body's bytes as they arrived, for a route that reads them itself. */
  raw: Buffer;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Handler = (context: RouteContext) => Promise<unknown>;

export interface Route {
  method: string;
  /** Path with `:name` segments. Matched segment by segment, never by regex. */
  pattern: string;
  /** Whether a session is required. Only sign-in and the challenge are not. */
  open?: boolean;
  /** The largest body this route reads. A megabyte unless the route says otherwise. */
  maxBodyBytes?: number;
  /**
   * The route reads the body's bytes itself, and they are not parsed as a JSON
   * object first. Only the inbound hook, whose senders sign bytes and send
   * forms and text as well as JSON.
   */
  raw?: boolean;
  handle: Handler;
}

/** A route's answer with a status other than 200: only the health and readiness checks need one. */
export class WithStatus {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

/**
 * An answer that goes on: server-sent events, written as they come, until
 * the owner goes, the session that opened it ends, or the API closes. `run`
 * writes each one with `send` and returns when `signal` aborts.
 */
export class EventStream {
  readonly run: (send: (data: unknown, id?: string) => void, signal: AbortSignal) => Promise<void>;

  constructor(run: EventStream['run']) {
    this.run = run;
  }
}

/** Who opened a stream: the session's token, the person behind it, the factor they signed in with, the company. */
export interface StreamOpener {
  /** The bearer token of the session; null for an open route. Kept only as its hash. */
  token: string | null;
  /** `'owner'` or `'seat:<uuid>'`; null for an open route. */
  principal: string | null;
  /** The owner's authenticator the session was signed in with; null for a seat or an open route. */
  factor: string | null;
  /** The company the stream is about, when its path names one. */
  companyId: string | null;
}

interface Held {
  readonly tokenHash: string | null;
  readonly principal: string | null;
  readonly factor: string | null;
  readonly companyId: string | null;
}

/**
 * The streams open in this process, by what can end them.
 *
 * A stream outlived the session that opened it: a browser signed out, or a
 * seat the owner ended, kept hearing the company's work until the tab closed.
 * So each stream is filed under its session's token hash and under its
 * person, and ending either ends the stream at once: sign-out by the token,
 * signing out everywhere by the owner, a seat's revocation or a change of its
 * kind by the seat, a lost authenticator by its factor. The hash is the
 * session tables' own (SHA-256 of the token, hex), so another replica can be
 * told which session ended without a token crossing the wire.
 */
export class StreamRegistry {
  readonly #held = new Map<AbortController, Held>();
  readonly #byKey = new Map<string, Set<AbortController>>();

  /** The SHA-256 of a session's token, hex: what `owner_sessions` and `staff_sessions` keep. */
  static hashOf(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** A stream begun: what aborts it, filed under everything that can end it. */
  open(opener: StreamOpener): AbortController {
    const stop = new AbortController();
    const held: Held = {
      tokenHash: opener.token === null ? null : StreamRegistry.hashOf(opener.token),
      principal: opener.principal,
      factor: opener.factor,
      companyId: opener.companyId,
    };
    this.#held.set(stop, held);
    for (const key of keysOf(held)) {
      const filed = this.#byKey.get(key) ?? new Set<AbortController>();
      filed.add(stop);
      this.#byKey.set(key, filed);
    }
    return stop;
  }

  /** A stream that ended by itself, or was ended: forgotten. */
  closed(stop: AbortController): void {
    const held = this.#held.get(stop);
    if (!held) return;
    this.#held.delete(stop);
    for (const key of keysOf(held)) {
      const filed = this.#byKey.get(key);
      filed?.delete(stop);
      if (filed?.size === 0) this.#byKey.delete(key);
    }
  }

  /** Every stream one session opened: it signed out. */
  endSession(token: string): number {
    return this.endTokenHash(StreamRegistry.hashOf(token));
  }

  /** The same, by the session's hash, as another replica would be told of it. */
  endTokenHash(tokenHash: string): number {
    return this.#end(`token:${tokenHash}`);
  }

  /** Every stream of one person: `'owner'` when the owner signs out everywhere, `'seat:<uuid>'` when a seat is ended. */
  endPrincipal(principal: string): number {
    return this.#end(`person:${principal}`);
  }

  /** Every stream of the sessions one of the owner's authenticators signed in: the device was lost. */
  endFactor(authenticatorId: string): number {
    return this.#end(`factor:${authenticatorId}`);
  }

  /** Every stream: the API is closing. */
  endAll(): number {
    const all = [...this.#held.keys()];
    for (const stop of all) this.#stop(stop);
    return all.length;
  }

  /** How many streams one person holds open, in one company when it is named: what a limit on streams counts. */
  count(principal: string, companyId: string | null = null): number {
    let found = 0;
    for (const stop of this.#byKey.get(`person:${principal}`) ?? []) {
      if (companyId === null || this.#held.get(stop)?.companyId === companyId) found += 1;
    }
    return found;
  }

  /** How many streams this process holds open. */
  get size(): number {
    return this.#held.size;
  }

  /**
   * The sessions behind the streams open now, each once for each company it
   * is about, by its token's hash: what the live hub asks after every
   * twenty-five seconds, so a stream whose session ended where this process
   * was not told stops (F19.11, STATUS 2.210). A stream of an open route,
   * which no session opened, is not among them.
   */
  sessions(): Array<{ tokenHash: string; principal: string; companyId: string | null }> {
    const found = new Map<string, { tokenHash: string; principal: string; companyId: string | null }>();
    for (const held of this.#held.values()) {
      if (held.tokenHash === null || held.principal === null) continue;
      found.set(`${held.tokenHash} ${held.companyId}`, { tokenHash: held.tokenHash, principal: held.principal, companyId: held.companyId });
    }
    return [...found.values()];
  }

  #end(key: string): number {
    const filed = [...(this.#byKey.get(key) ?? [])];
    for (const stop of filed) this.#stop(stop);
    return filed.length;
  }

  #stop(stop: AbortController): void {
    // Forgotten before it is aborted, so a count taken straight after an end
    // does not include a stream still unwinding.
    this.closed(stop);
    stop.abort();
  }
}

function keysOf(held: Held): string[] {
  return [
    ...(held.tokenHash ? [`token:${held.tokenHash}`] : []),
    ...(held.principal ? [`person:${held.principal}`] : []),
    ...(held.factor ? [`factor:${held.factor}`] : []),
  ];
}

/** Who asks for a room stream, from the request's verified session (F19.11). */
export interface RoomStreamOpening {
  /** The company the path names. */
  companyId: string;
  /** The person, made by `principalOf` from the session, never from the request's words. */
  person: Person;
  /** The owner, or the seat's kind as its session was verified: a change of kind ends the stream. */
  kind: 'owner' | StaffKind;
  /** The session's bearer token, which the hub keeps only as its hash, to ask after the session every twenty-five seconds. */
  token: string;
  /** The last position the console heard (`Last-Event-ID`), or null. */
  lastEventId: string | null;
}

/** What ends streams in every process: a session, by its token's hash; a person; or the owner's device. */
export type StreamEnd = { tokenHash: string } | { principal: string } | { factor: string };

/**
 * The live hub that serves a person's room stream (F19.11; STATUS section
 * 2.210, `src/workspace/hub.ts`): the rooms' changes each person may see and
 * the company's work, on one stream per tab, read once per company.
 */
export interface PeopleHub {
  /** A person's room stream, or `stream.too_many` when they hold five in the company already. */
  stream(opening: RoomStreamOpening): Promise<EventStream>;
  /**
   * Tells every process of the deployment that these streams end; the caller
   * ends this process's own through `StreamRegistry`, as it always has.
   */
  ended(what: StreamEnd): Promise<void>;
  /** This process listening for changes and ends, which any stream begins. */
  listening(): Promise<void>;
  /** Ends every subscriber and the hub's own connection: the API is closing. */
  close(): Promise<void>;
}

/** What the deployment set from the console: the environment beneath, the settings, the key, the secrets. */
export type DeploymentSettings = NonNullable<OwnerApiOptions['deploymentSettings']>;

/** What a route module may reach of the owner API (frozen here; see the file's comment). */
export interface RouteKit {
  /**
   * The owner's second factor for `purpose`, from the request's `proof`, for
   * the company its path names. `fresh` asks for a code or a passkey now, even
   * in a session signed in with a device: letting people in, pairing a relay.
   */
  readonly requireFactor: (context: RouteContext, purpose: string, fresh?: boolean) => Promise<void>;
  readonly sessions: OwnerSessions;
  readonly staff: StaffSeats;
  /** The API's options: the registry, the assistant, the channels, and what a later set adds. */
  readonly options: Readonly<OwnerApiOptions>;
  /** The deployment's settings; refused on a deployment built without console settings. */
  readonly deploymentSettings: () => DeploymentSettings;
  /** Takes up what was just saved: starts the process again where it can, and says whether it did. */
  readonly applySettings: () => { applies: 'now' | 'next_start' };
  /** Where the companies' files are kept (`PALUGADA_FILES_ROOT`); null on a deployment that keeps none. */
  readonly filesRoot: () => string | null;
  /**
   * Where one company's room files are kept: beside its files, never under
   * them, so no agent capability and not the owner's Files page reaches one.
   * Null on a deployment that keeps no files.
   */
  readonly peopleFilesRoot: (companyId: string) => string | null;
  /** The streams open in this process, which sign-out and revocation end. */
  readonly streams: StreamRegistry;
  /** The live hub (src/workspace/hub.ts), which serves the room stream and tells other processes of ends. */
  readonly hub: PeopleHub;
}

/**
 * The folder one company's room files are kept in: `<companyId>` under the
 * deployment's people files root when it sets one, and otherwise
 * `<companyId>.people` beside the company's own folder under the files root.
 * Null on a deployment that keeps no files.
 *
 * Room files are people's words (F19.4). Every agent capability that reads
 * files, and the owner's Files page, reads a company's folder under the files
 * root (`companyRoot`, src/capabilities/files.ts), so room files are kept
 * where none of them reaches: a people files root that would put them in a
 * company's folder is refused (`peopleFilesApart`), here and when the API is
 * made. And only a company's id becomes a folder's name, never a path.
 */
export function peopleFilesFolder(files: OwnerApiOptions['files'], companyId: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(companyId)) {
    throw new PalugadaError('contract.violation', `a company is named by its id, not ${JSON.stringify(companyId)}`, { companyId });
  }
  if (!files) return null;
  peopleFilesApart(files);
  return files.peopleRoot ? join(files.peopleRoot, companyId) : join(files.root, `${companyId}.people`);
}

/**
 * Refuses a people files root that is the files root itself, or lies inside
 * a company's folder there: under either, a company's room files would be in
 * the folder its agents and the owner's Files page read. Compared as the file
 * system follows them, so a link into a company's folder is refused as the
 * folder is, and a folder named by a company's id in capitals too, which is
 * that company's on a file system that does not tell the two apart.
 */
export function peopleFilesApart(files: NonNullable<OwnerApiOptions['files']>): void {
  if (!files.peopleRoot) return;
  const root = followed(files.root);
  const people = followed(files.peopleRoot);
  const inside = relative(root, people);
  const within = inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  const first = inside.split(sep)[0] ?? '';
  if (inside === '' || (within && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first))) {
    throw new PalugadaError('config.invalid',
      `PALUGADA_PEOPLE_FILES_ROOT (${files.peopleRoot}) is ${inside === '' ? '' : 'inside a company\'s folder in '}PALUGADA_FILES_ROOT `
        + `(${files.root}), where every agent capability and the owner's Files page would read room files: `
        + 'set it to a folder outside the companies\' folders, or leave it unset to keep them beside each company\'s',
      { peopleRoot: files.peopleRoot, root: files.root });
  }
}

/** A path as the file system follows it: the real path of as much of it as exists, then the rest as written. */
function followed(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  try {
    return join(realpathSync(at), ...rest);
  } catch {
    // Unreadable on the way: compared as written, which still refuses the plain cases.
    return resolve(path);
  }
}
