/**
 * The `script` runtime (PRD v2 F13.2, F13.5).
 *
 * A local process. The engine spawns it, writes one JSON request on stdin,
 * reads newline-delimited `RunEvent`s from stdout, and writes answers back on
 * stdin. It is the simplest possible third-party runtime and the one every
 * other out-of-process adapter is a variation of, which is why it is worth
 * having even where nothing but a test uses it: an adapter that can be written
 * in ten lines of any language is what makes "PALUGADA employs runtimes" a
 * claim rather than a slogan.
 *
 * The environment is the part worth reading carefully. A spawned process
 * inherits its parent's environment by default, and the parent's environment is
 * where `DATABASE_URL` and every provider key live. So it does not inherit:
 * the child is given exactly what the adapter was configured to give it, and
 * `PATH` because a process that cannot find its own interpreter is not a
 * useful process. This is F8.7 applied to the one place where the leak would
 * be invisible -- nothing would fail, the run would simply have been handed
 * the keys.
 */
import { spawn } from 'node:child_process';
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

export interface ScriptAdapterOptions {
  /** The name a role puts in `roles.runtime`. */
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  /**
   * What the child is allowed to see. `PATH` is added; nothing else is
   * inherited.
   */
  env?: Record<string, string>;
  backends?: readonly ExecutionBackend[];
  /**
   * Run this to decide health (F13.8). Defaults to checking that the command
   * exists and is executable, which is the failure that actually happens.
   */
  health?: () => Promise<AdapterHealth>;
}

export class ScriptAdapter implements Adapter {
  readonly name: string;
  readonly backends: readonly ExecutionBackend[];
  readonly #options: ScriptAdapterOptions;

  constructor(options: ScriptAdapterOptions) {
    this.name = options.name ?? 'script';
    // `docker` is not claimed here. A process this adapter spawns runs wherever
    // this process runs; a role that asks for container isolation has to be
    // given an adapter that actually provides it, and pretending otherwise
    // would make F13.5 a configuration value with no effect.
    this.backends = options.backends ?? ['local'];
    this.#options = options;
  }

  async health(): Promise<AdapterHealth> {
    if (this.#options.health) return this.#options.health();
    try {
      const { access, constants } = await import('node:fs/promises');
      await access(this.#options.command, constants.X_OK);
      return { ok: true, detail: this.#options.command };
    } catch {
      // A command resolved through PATH is not a path, and cannot be checked
      // this way. Saying so is more honest than reporting a failure that only
      // means "this is not an absolute path".
      return this.#options.command.includes('/')
        ? { ok: false, detail: `${this.#options.command} is not executable` }
        : { ok: true, detail: `${this.#options.command} (resolved through PATH)` };
    }
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    const child = spawn(this.#options.command, this.#options.args ?? [], {
      ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
      // Not `process.env`. See the module comment: the parent's environment is
      // where the credentials are.
      env: { PATH: process.env.PATH ?? '', ...(this.#options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Bounded: a runtime that writes a gigabyte to stderr should not take the
      // orchestrator with it. The tail is kept because the last thing a dying
      // process says is usually why.
      stderr = (stderr + chunk).slice(-8_192);
    });

    // Errors on the pipes are expected: a runtime that exits while the engine
    // is answering a tool call closes stdin under it. Unhandled, that would be
    // an EPIPE crash of the orchestrator over a child process misbehaving.
    child.stdin.on('error', () => {});
    child.on('error', () => {});

    const transport: Transport = {
      events: this.#events(child, () => stderr),
      async send(message: EngineMessage) {
        if (child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      async close() {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      },
    };

    child.stdin.write(`${JSON.stringify(toWireRequest(request))}\n`);
    return driveRun(request, services, transport);
  }

  async *#events(
    child: ReturnType<typeof spawn>,
    stderr: () => string,
  ): AsyncGenerator<RunEvent> {
    try {
      for await (const value of readNdjson(child.stdout!)) {
        yield parseRunEvent(value);
      }
    } catch (error) {
      // A malformed line means the runtime is not speaking the protocol.
      // Whatever it wrote to stderr is almost always the explanation, so it
      // travels with the failure rather than being lost with the process.
      const detail = stderr().trim();
      throw new Error(
        `${this.name} runtime produced unreadable output: ${(error as Error).message}` +
          (detail ? `\n${detail}` : ''),
      );
    }
  }
}
