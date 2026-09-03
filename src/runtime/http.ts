/**
 * The `http` runtime (PRD v2 F13.2).
 *
 * A runtime that lives behind a URL. It is the adapter for anything the engine
 * cannot spawn -- a hosted agent, a colleague's service, a runtime written in
 * a language nobody wants to install here.
 *
 * The exchange is a turn loop rather than a stream. The engine POSTs the
 * request plus every answer it owes; the runtime replies with the events it
 * has produced since; the loop ends when one of them is `done` or `error`.
 * Streaming would be a smaller number of round trips and a much larger number
 * of ways to fail: a dropped connection mid-stream is indistinguishable from a
 * thinking runtime, whereas a turn that does not come back is a request that
 * timed out and can be retried against a stateless endpoint.
 *
 * Two things the loop refuses to do. It will not run for ever -- `maxTurns`
 * bounds it, because a runtime that answers every turn with nothing is a
 * livelock the engine would otherwise sit in until the lease expires. And it
 * will not accept a `tool_call` whose id it has already answered, because
 * replaying an id is how an at-least-once transport turns one external action
 * into several.
 */
import { PalugadaError } from '../errors.ts';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  EngineMessage,
  ExecutionBackend,
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { driveRun, parseRunEvent, toWireRequest, type Transport } from './wire.ts';

export interface HttpAdapterOptions {
  name?: string;
  /** Where a run is posted. */
  url: string;
  /** Where health is asked. Defaults to `${url}/health`. */
  healthUrl?: string;
  /** Sent on every request. The runtime's own credential, never a tenant's. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxTurns?: number;
  backends?: readonly ExecutionBackend[];
  /** Injected in tests; defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch;
}

interface TurnResponse {
  events: unknown[];
}

export class HttpAdapter implements Adapter {
  readonly name: string;
  readonly backends: readonly ExecutionBackend[];
  readonly #options: Required<Pick<HttpAdapterOptions, 'url' | 'timeoutMs' | 'maxTurns'>> &
    HttpAdapterOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpAdapterOptions) {
    this.name = options.name ?? 'http';
    // Whatever is behind the URL decides its own isolation, and the engine
    // cannot verify the claim. It is listed as `remote_sandbox` because that
    // is what "somewhere else, not ours" means in F13.5's vocabulary.
    this.backends = options.backends ?? ['remote_sandbox'];
    this.#options = { timeoutMs: 60_000, maxTurns: 200, ...options };
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async health(): Promise<AdapterHealth> {
    const url = this.#options.healthUrl ?? `${this.#options.url.replace(/\/$/, '')}/health`;
    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: this.#options.headers ?? {},
        signal: AbortSignal.timeout(Math.min(this.#options.timeoutMs, 10_000)),
      });
      return response.ok
        ? { ok: true, detail: `${url} answered ${response.status}` }
        : { ok: false, detail: `${url} answered ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `${url} is unreachable: ${(error as Error).message}` };
    }
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    const pending: EngineMessage[] = [];
    const answered = new Set<string>();

    const transport: Transport = {
      events: this.#turns(request, pending, answered, services),
      async send(message) {
        pending.push(message);
      },
      async close() {
        // Stateless by design: there is nothing on this side to release, and a
        // runtime that wants a cancellation signal gets it as the `cancel`
        // message on the next turn or not at all.
      },
    };

    return driveRun(request, services, transport);
  }

  async *#turns(
    request: RunRequest,
    pending: EngineMessage[],
    answered: Set<string>,
    services: RunServices,
  ): AsyncGenerator<RunEvent> {
    const wire = toWireRequest(request);

    for (let turn = 0; turn < this.#options.maxTurns; turn += 1) {
      // Taken rather than copied: an answer must be sent once. Leaving it in
      // the queue would resend every previous answer on every turn, which is
      // the same bug as replaying a tool call, seen from the other end.
      const answers = pending.splice(0, pending.length);

      const response = await this.#post(
        { runId: request.runId, turn, request: turn === 0 ? wire : undefined, answers },
        services.signal,
      );

      if (response.events.length === 0 && answers.length === 0) {
        throw new Error(
          `${this.name} runtime returned no events and was owed no answers on turn ${turn}`,
        );
      }

      for (const raw of response.events) {
        const event = parseRunEvent(raw);
        if (event.type === 'tool_call') {
          if (answered.has(event.id)) {
            // F8.6's idempotency, enforced at the transport rather than trusted
            // to it. A retried HTTP turn must not become a second external
            // action.
            throw new PalugadaError(
              'contract.violation',
              `${this.name} runtime replayed tool_call ${event.id}`,
              { runId: request.runId, toolCallId: event.id },
            );
          }
          answered.add(event.id);
        }
        yield event;
      }
    }

    throw new Error(
      `${this.name} runtime did not finish within ${this.#options.maxTurns} turns`,
    );
  }

  async #post(body: unknown, signal: AbortSignal): Promise<TurnResponse> {
    const response = await this.#fetch(this.#options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.#options.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs)]),
    });

    if (!response.ok) {
      throw new Error(`${this.name} runtime answered ${response.status}`);
    }

    const parsed = (await response.json()) as Partial<TurnResponse>;
    if (!Array.isArray(parsed.events)) {
      throw new Error(`${this.name} runtime answered without an events array`);
    }
    return { events: parsed.events };
  }
}
