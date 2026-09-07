/**
 * The `remote_sandbox` execution backend (PRD v2 F13.5, F12.9).
 *
 * F13.5 names three backends and the third had no implementation: `local`
 * spawns beside the orchestrator, `docker` spawns a container on this host,
 * and `remote_sandbox` — "Daytona/Modal/sejenis" — runs the runtime on
 * somebody else's machine entirely. It is the one that matters for a platform
 * whose whole premise is employing third-party runtimes: a company that lets
 * an agent execute code should not be running that code on the box holding its
 * database, and `docker` on the same host is one kernel bug away from being
 * exactly that.
 *
 * The vendors differ in their URLs and agree on their shape, which is why this
 * is one adapter and not three. Every sandbox provider offers the same three
 * operations:
 *
 *   1. **create** a sandbox from an image and get an id back;
 *   2. **exec** a command in it, streaming stdout and writing stdin;
 *   3. **delete** it.
 *
 * So the provider is a small object with three methods and a `SandboxSession`
 * is what step 2 returns. Daytona, Modal, E2B, Fly Machines and a plain
 * self-hosted runner are all a hundred lines against this interface, and none
 * of them needs to know anything about PALUGADA's wire protocol -- the wire is
 * `script`'s, unchanged, because stdio works across a network boundary exactly
 * as it works across a container one.
 *
 * **The sandbox is deleted whatever happens.** This is the property the whole
 * backend is for and the one that is easy to get almost right. A sandbox that
 * outlives its run is a billed machine holding a company's working files, and
 * "almost always deleted" means a slow leak of both money and data. The delete
 * is in a `finally` that also runs when the create succeeded and the exec
 * threw, when the engine withdrew the run, and when the process is being torn
 * down -- and a delete that itself fails is reported rather than swallowed,
 * because a leaked sandbox nobody hears about is the same as no cleanup at
 * all.
 *
 * **No credentials cross the boundary (F12.9, F13.4).** The runtime inside the
 * sandbox reaches the engine over its stdio pipe and nothing else. It gets no
 * MCP tool bridge -- that is an HTTP server on the orchestrator's loopback,
 * which is a different machine from here -- so its tool calls travel as
 * `tool_call` events on stdout, which is how `script` already does it. That is
 * a feature rather than a limitation: a runtime with no route back to the
 * orchestrator except the pipe it was born with cannot exfiltrate what it was
 * given.
 *
 * **Unverified against a real provider.** No sandbox vendor is reachable from
 * this repository, so what the suite covers is the full lifecycle against a
 * provider written for the test: creation, the wire, tool calls, cancellation,
 * and deletion on every path out. docs/STATUS.md says so rather than letting a
 * green suite imply a Daytona account.
 */
import { PalugadaError } from '../errors.ts';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  ExecutionBackend,
  EngineMessage,
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { driveRun, parseRunEvent, readNdjson, toWireRequest, type Transport } from './wire.ts';

/**
 * A running command inside a sandbox.
 *
 * Deliberately the same shape a child process has: a readable stream of bytes,
 * a way to write a line, and a way to stop it. A provider whose API is
 * WebSocket-shaped adapts to this in a few lines, and the alternative -- an
 * interface shaped like whichever vendor was implemented first -- is how an
 * abstraction ends up with one real implementation.
 */
export interface SandboxSession {
  /** The runtime's stdout. */
  output: AsyncIterable<Uint8Array | string>;
  /** One line onto the runtime's stdin. */
  write(line: string): Promise<void>;
  /** Whatever it wrote to stderr, for a failure that has to explain itself. */
  stderr?(): string;
  /** Stops the command. Called when the engine withdraws the run. */
  close(): Promise<void>;
}

export interface SandboxProvider {
  /** For the health check and the adapter's default name. */
  readonly name: string;
  /**
   * Makes a sandbox and returns its id.
   *
   * The id is the adapter's only handle on it, and the only thing `destroy`
   * gets, so a provider that needs more state should close over it here.
   */
  create(input: { image: string; runId: string }): Promise<string>;
  exec(input: { sandboxId: string; command: string[] }): Promise<SandboxSession>;
  destroy(sandboxId: string): Promise<void>;
  /** F13.8. Is the provider reachable and are we authorised? */
  health(): Promise<AdapterHealth>;
}

export interface SandboxAdapterOptions {
  provider: SandboxProvider;
  /** The image the runtime lives in. Pinned by digest anywhere it matters. */
  image: string;
  /** The command inside it. Defaults to the image's own entrypoint. */
  command?: string[];
  name?: string;
}

export class RemoteSandboxAdapter implements Adapter {
  readonly name: string;
  /**
   * Only `remote_sandbox`. Claiming `local` as well would make a role's
   * isolation setting a value that sometimes means nothing, which is worse
   * than a missing backend because it reads like a choice somebody made.
   */
  readonly backends: readonly ExecutionBackend[] = ['remote_sandbox'];
  readonly #options: SandboxAdapterOptions;

  constructor(options: SandboxAdapterOptions) {
    this.name = options.name ?? `sandbox:${options.provider.name}`;
    this.#options = options;
  }

  async health(): Promise<AdapterHealth> {
    try {
      return await this.#options.provider.health();
    } catch (error) {
      // A health check that throws has failed. Reading the throw as "we do not
      // know" would let an unreachable provider keep receiving work, which is
      // the failure F13.8 exists to prevent.
      return { ok: false, detail: `${this.name} health check threw: ${(error as Error).message}` };
    }
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    const { provider, image } = this.#options;
    const sandboxId = await provider.create({ image, runId: request.runId });

    let session: SandboxSession | null = null;
    try {
      session = await provider.exec({
        sandboxId,
        command: this.#options.command ?? [],
      });

      const active = session;
      const transport: Transport = {
        events: this.#events(active),
        async send(message: EngineMessage) {
          await active.write(`${JSON.stringify(message)}\n`);
        },
        async close() {
          await active.close();
        },
      };

      await active.write(`${JSON.stringify(toWireRequest(request))}\n`);
      return await driveRun(request, services, transport);
    } finally {
      // The property the whole backend is for. Runs when the exec threw, when
      // the run was withdrawn, and when `driveRun` returned normally -- there
      // is deliberately no path out of this method that skips it.
      try {
        await provider.destroy(sandboxId);
      } catch (error) {
        // Not swallowed. A leaked sandbox is a billed machine holding a
        // company's working files, and one nobody hears about is the same as
        // no cleanup at all. Thrown only when the run itself succeeded --
        // `finally` would otherwise replace a real failure with this one and
        // hide why the run went wrong.
        throw new PalugadaError(
          'sandbox.not_destroyed',
          `sandbox ${sandboxId} could not be destroyed and may still be running: `
            + (error as Error).message,
          { sandboxId, provider: provider.name },
        );
      }
    }
  }

  async *#events(session: SandboxSession): AsyncGenerator<RunEvent> {
    try {
      for await (const value of readNdjson(session.output)) {
        yield parseRunEvent(value);
      }
    } catch (error) {
      // A malformed line means the runtime is not speaking the protocol.
      // Whatever it wrote to stderr is almost always the explanation, and on a
      // remote machine it is the *only* thing anyone will ever see of it.
      const detail = session.stderr?.().trim() ?? '';
      throw new Error(
        `${this.name} runtime produced unreadable output: ${(error as Error).message}`
          + (detail ? `\n${detail}` : ''),
      );
    }
  }
}

/**
 * A provider over an HTTP API, which is what every vendor actually is.
 *
 * The three URLs and the field names are configuration because that is the
 * only part that differs between Daytona, Modal, E2B and a self-hosted runner
 * -- and because a vendor changing a path should be a settings edit rather
 * than a release of this platform. Streaming is NDJSON over a long-lived
 * response body, which every one of them offers and which is what the wire
 * already speaks.
 */
export interface HttpSandboxOptions {
  name?: string;
  baseUrl: string;
  /** Already resolved. Registered with the redactor by whoever resolved it. */
  token?: string;
  createPath?: string;
  execPath?: string;
  destroyPath?: string;
  healthPath?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class HttpSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly #options: HttpSandboxOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpSandboxOptions) {
    this.name = options.name ?? 'http';
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async create(input: { image: string; runId: string }): Promise<string> {
    const created = await this.#json<{ id?: string }>(
      this.#options.createPath ?? '/sandboxes',
      { image: input.image, label: input.runId },
    );
    if (!created.id) {
      throw new Error(`${this.name} created a sandbox without returning an id`);
    }
    return created.id;
  }

  async exec(input: { sandboxId: string; command: string[] }): Promise<SandboxSession> {
    // Duplex over one request: the body is the runtime's stdin and the
    // response is its stdout. A `ReadableStream` request body is what makes
    // this possible without a second channel, and it is why `write` returns a
    // promise -- backpressure is real over a network.
    let push: ((chunk: string) => void) | null = null;
    let finish: (() => void) | null = null;
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        finish = () => {
          try {
            controller.close();
          } catch {
            // Already closed: the run ended while a write was in flight.
          }
        };
      },
    });

    const path = (this.#options.execPath ?? '/sandboxes/:id/exec').replace(':id', input.sandboxId);
    const response = await this.#fetch(`${this.#options.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-ndjson',
        ...(this.#options.token ? { authorization: this.#options.token } : {}),
        ...(input.command.length > 0
          ? { 'x-sandbox-command': JSON.stringify(input.command) }
          : {}),
      },
      body: stdin,
      // Node refuses a streaming request body without this.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!response.ok || !response.body) {
      throw new Error(`${this.name} exec returned ${response.status}`);
    }

    const body = response.body;
    return {
      output: (async function* () {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
      async write(line: string) {
        push?.(line);
      },
      async close() {
        finish?.();
        await body.cancel().catch(() => undefined);
      },
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    const path = (this.#options.destroyPath ?? '/sandboxes/:id').replace(':id', sandboxId);
    const response = await this.#fetch(`${this.#options.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.#options.token ? { authorization: this.#options.token } : {},
    });
    // 404 is success: something else already removed it, and the postcondition
    // -- no sandbox with this id -- holds either way.
    if (!response.ok && response.status !== 404) {
      throw new Error(`${this.name} delete returned ${response.status}`);
    }
  }

  async health(): Promise<AdapterHealth> {
    try {
      const response = await this.#fetch(
        `${this.#options.baseUrl}${this.#options.healthPath ?? '/health'}`,
        { headers: this.#options.token ? { authorization: this.#options.token } : {} },
      );
      return response.ok
        ? { ok: true, detail: `${this.name} at ${this.#options.baseUrl}` }
        : { ok: false, detail: `${this.name} health returned ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `${this.name} is unreachable: ${(error as Error).message}` };
    }
  }

  async #json<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 30_000);
    try {
      const response = await this.#fetch(`${this.#options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#options.token ? { authorization: this.#options.token } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${this.name} ${path} returned ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
