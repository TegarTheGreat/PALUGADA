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
 * roots, and the open streams. It is frozen here; a set that needs more widens
 * it and `#kit()` together, and says so where it is merged.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { OwnerApiOptions } from './api.ts';
import type { OwnerSession, OwnerSessions } from './session.ts';
import type { StaffSeats, StaffSession } from './staff.ts';

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

/**
 * The live hub that serves a person's room stream (F19.11). The set that
 * builds it fills `RouteKit.hub` and widens this to what its routes call;
 * until then the kit holds none.
 */
export interface PeopleHub {
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
  /** The live hub, once it exists; null before. */
  hub: PeopleHub | null;
}
