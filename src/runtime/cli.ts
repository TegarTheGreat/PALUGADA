/**
 * A headless agent CLI as configuration rather than as code (PRD v2 F13.3).
 *
 * F13.3 names four runtimes -- `hermes`, `openclaw`, `codex`, `gemini-cli` --
 * and then names the reason: *so that community adapters can be used*. Writing
 * four hand-rolled adapters would satisfy the list and miss the reason, and it
 * would do it in the worst possible way, because none of the four is installed
 * here. Their flags would have been guessed, the tests would have asserted the
 * guesses, and the suite would have gone green over four programs that had
 * never been run. docs/STATUS.md has refused that trade everywhere else and it
 * is refused here too.
 *
 * What the four actually have in common is everything that is hard. Each is a
 * process that takes a prompt, is told where to find an MCP server, writes a
 * stream to stdout and exits. The hard parts -- keeping the parent's
 * environment away from the child, standing up a per-run tool bridge, holding
 * the redactor between the runtime and the wire, translating a stream into
 * §7.5's vocabulary, bounding stderr, killing the process when the engine
 * withdraws -- are identical, and they are what an adapter gets wrong. What
 * differs between them is a command name, an argument list and which of two
 * output dialects they speak.
 *
 * So that is the split. The hard part is here, written once and tested. The
 * part that differs is a `CliRuntimeSpec`, which an operator who actually has
 * the binary supplies as configuration -- and being configuration, it can be
 * corrected when a CLI changes its flags without a release of this platform.
 * `runtimeSpecsFrom` reads them from a deployment's settings, so employing a
 * runtime nobody here has heard of is a JSON object rather than a pull
 * request. That is the whole of "community adapters can be used".
 *
 * Two refusals are built in, because both failures are silent:
 *
 *   - **A spec that never places the tool bridge is refused.** An agent CLI
 *     spawned without one runs, talks to a model, has no tools, and produces a
 *     confident answer about work it could not do. Nothing errors. It is the
 *     same defect class as a role granted no capabilities, and it is refused
 *     at construction where the configuration can still be fixed.
 *   - **The execution backend is not a spec field at all.** A process spawned
 *     here runs where this process runs, so this adapter claims `local` and
 *     nothing else. Letting a spec claim `docker` would make a role's
 *     isolation setting a value with no effect -- worse than a missing
 *     feature, because it reads like a choice somebody made.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  ExecutionBackend,
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { driveRun, toWireRequest, type Transport } from './wire.ts';
import { startToolBridge, type ToolBridge } from './tool-bridge.ts';
import { asOutput, translateStreamJsonLine, type StreamJsonLine } from './claude-code.ts';

/**
 * How the CLI talks back.
 *
 * `stream-json` is the Anthropic-style newline-delimited envelope Claude Code
 * emits and several agent CLIs have copied. `text` is everything else: the
 * process prints its answer and exits, and the exit code is the verdict.
 *
 * Deliberately not offered: the platform's own `RunEvent` NDJSON. A runtime
 * that speaks that already has an adapter -- `script` -- and a second way to
 * reach it would only be a second thing to keep in step.
 */
export type CliDialect = 'stream-json' | 'text';

/**
 * The placeholders a spec's `args` may contain.
 *
 * Substituted inside each argv element rather than only replacing whole
 * elements, because CLIs differ on whether a flag and its value are one
 * argument or two. Substitution is into an argv array that is passed to
 * `spawn` without a shell, so a value containing spaces, quotes or a semicolon
 * stays one argument and reaches the child exactly as written.
 */
export interface CliPlaceholders {
  /** `request.modelRouting.primary`. */
  model: string;
  /** `spec.maxTurns`, as a string. */
  maxTurns: string;
  /**
   * The bridge as an MCP client configuration, inline JSON.
   *
   * Carries the run's bearer token, and an argv is world-readable on the host
   * -- `/proc/<pid>/cmdline`, `ps`, a container sidecar. Prefer
   * `{mcpConfigFile}`, which is 0600 in a 0700 directory and is removed when
   * the run ends. This form stays because some CLIs take only inline JSON, and
   * the token is minted per run and expires with it; but where a CLI accepts
   * either, the file is the one to use.
   */
  mcpConfig: string;
  /** The same configuration written to a 0600 file; the value is its path. */
  mcpConfigFile: string;
  /** The bridge's loopback URL. */
  mcpUrl: string;
  /** The bearer token minted for this run and no other. Same caveat as `mcpConfig`. */
  mcpToken: string;
  /** Every allowed tool, `mcp__palugada__`-prefixed and comma-joined. */
  allowedTools: string;
  /** The prompt, for a CLI that takes it as an argument rather than on stdin. */
  prompt: string;
}

/** The parts of a headless agent CLI that are not the same for all of them. */
export interface CliRuntimeSpec {
  /** The name a role puts in `roles.runtime`. */
  name: string;
  /** The binary. Resolved through PATH when it is a bare name. */
  command: string;
  /** argv, with `{placeholder}` substituted per run. */
  args: string[];
  /** Where the prompt goes. Default `stdin`. */
  promptVia?: 'stdin' | 'arg';
  /** Default `stream-json`. */
  dialect?: CliDialect;
  /** What the child may see, beyond `PATH`. Never inherited. */
  env?: Record<string, string>;
  /**
   * The runtime's own provider credential.
   *
   * Named rather than inherited, so that reading the configuration tells you
   * exactly which of this process's environment variables reaches the child.
   * It is the runtime's key and never a tenant's: a tenant's credentials go
   * through the broker, which is the whole of F13.4.
   */
  apiKeyEnvVar?: string;
  maxTurns?: number;
  cwd?: string;
  /** How to ask the binary whether it is there (F13.8). Default `--version`. */
  versionArgs?: string[];
}

const BRIDGE_PLACEHOLDERS = ['{mcpConfig}', '{mcpConfigFile}', '{mcpUrl}'] as const;

/**
 * Reads runtime specs out of a deployment's configuration.
 *
 * Shaped to fail loudly on a malformed entry rather than to skip it: a spec
 * that silently did not load would leave a role pointing at a runtime that is
 * simply not registered, and the engine's message for that ("registered: ...")
 * would send whoever reads it looking in the wrong place.
 */
export function runtimeSpecsFrom(value: unknown): CliRuntimeSpec[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('runtime specs must be an array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`runtime spec ${index} is not an object`);
    }
    const spec = entry as Record<string, unknown>;
    if (typeof spec.name !== 'string' || spec.name === '') {
      throw new Error(`runtime spec ${index} has no name`);
    }
    if (typeof spec.command !== 'string' || spec.command === '') {
      throw new Error(`runtime spec ${spec.name} has no command`);
    }
    if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`runtime spec ${spec.name} has no args, or an arg that is not a string`);
    }
    return spec as unknown as CliRuntimeSpec;
  });
}

export class CliAdapter implements Adapter {
  readonly name: string;
  /**
   * `local` only, and not configurable. See the module comment: this adapter
   * spawns a process beside the orchestrator, so a role that asked for
   * container isolation and got this would have been given a setting that
   * changed nothing. A containerised runtime is `ContainerAdapter`'s job.
   */
  readonly backends: readonly ExecutionBackend[] = ['local'];
  readonly #spec: CliRuntimeSpec;

  constructor(spec: CliRuntimeSpec) {
    const argv = spec.args.join(' ');
    if (!BRIDGE_PLACEHOLDERS.some((placeholder) => argv.includes(placeholder))) {
      throw new Error(
        `runtime ${spec.name} places no tool bridge in its arguments: one of ` +
          `${BRIDGE_PLACEHOLDERS.join(', ')} must appear, or the CLI would run ` +
          'with no tools at all and answer as though it had them',
      );
    }
    this.name = spec.name;
    this.#spec = spec;
  }

  async health(): Promise<AdapterHealth> {
    const args = this.#spec.versionArgs ?? ['--version'];
    return new Promise((resolve) => {
      const child = spawn(this.#spec.command, args, {
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out = (out + chunk.toString('utf8')).slice(0, 256);
      });
      child.on('error', (error) =>
        resolve({
          ok: false,
          detail: `${this.#spec.command} is not runnable: ${error.message}`,
        }),
      );
      child.on('close', (code) =>
        resolve(
          code === 0
            ? { ok: true, detail: out.trim() || this.#spec.command }
            : { ok: false, detail: `${this.#spec.command} ${args.join(' ')} exited ${code}` },
        ),
      );
    });
  }

  /**
   * The command line for a run.
   *
   * Separated from `run` so the argv an operator's spec produces can be read
   * back without spawning anything -- which is the only way a spec for a
   * binary that is not installed here can be checked at all.
   */
  argv(values: CliPlaceholders): string[] {
    return this.#spec.args.map((arg) => substitute(arg, values));
  }

  /**
   * The prompt.
   *
   * The charter first, because F3.2 says the platform charter outranks the
   * company's and a prompt that buries it has already lost that argument. The
   * rest travels as JSON: a runtime is a program, and asking it to parse prose
   * it was handed would add a failure mode for nothing.
   *
   * The same shape `claude-code` sends, deliberately. A role moved from one
   * runtime to another should be doing the same job, and a prompt that changed
   * with the adapter would make the runtime a variable in the work rather than
   * in who does it.
   */
  prompt(request: RunRequest): string {
    const wire = toWireRequest(request);
    return [
      wire.contextPack.charter,
      '',
      '# Your task',
      JSON.stringify(
        {
          task: wire.task,
          goalAncestry: wire.contextPack.goalAncestry,
          skills: wire.contextPack.skills,
          memories: wire.contextPack.memories,
          workingMemory: wire.contextPack.workingMemory,
        },
        null,
        2,
      ),
      '',
      'Act only through the tools you have been given. When you are finished,',
      'reply with a single JSON object and nothing else: that object is the',
      "task's output and is validated against the role's output schema.",
    ].join('\n');
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    const bridge = await startToolBridge(request.allowedTools, services);
    const prompt = this.prompt(request);

    // Written before the spawn and removed in `close`, whatever happens: the
    // file carries the run's bearer token, so leaving one behind would leave a
    // credential on disk for a runtime that has already exited.
    const configFile = await this.#writeMcpConfig(bridge);

    const child = spawn(
      this.#spec.command,
      this.argv({
        model: request.modelRouting.primary,
        maxTurns: String(this.#spec.maxTurns ?? 40),
        mcpConfig: mcpConfigJson(bridge),
        mcpConfigFile: configFile?.path ?? '',
        mcpUrl: bridge.url,
        mcpToken: bridge.token,
        allowedTools: request.allowedTools
          .map((tool) => `mcp__palugada__${tool.name}`)
          .join(','),
        prompt,
      }),
      {
        ...(this.#spec.cwd ? { cwd: this.#spec.cwd } : {}),
        // Not `process.env`. The parent's environment is where `DATABASE_URL`
        // and every provider key live, and a child that inherited it would
        // have been handed the platform's own credentials without anything
        // failing to say so.
        env: this.#childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      // Bounded: a runtime that writes a gigabyte to stderr should not take
      // the orchestrator with it. The tail is kept because the last thing a
      // dying process says is usually why.
      stderr = (stderr + chunk).slice(-8_192);
    });
    // A runtime that exits while the engine is still writing closes stdin
    // under it. Unhandled, that is an EPIPE crash of the orchestrator over a
    // child process misbehaving.
    child.stdin!.on('error', () => {});
    child.on('error', () => {});

    const transport: Transport = {
      events:
        (this.#spec.dialect ?? 'stream-json') === 'text'
          ? this.#textEvents(child, () => stderr)
          : this.#streamJsonEvents(child, () => stderr),
      async send() {
        // Nothing to send. Tool answers reach this runtime over MCP, and a
        // cancellation reaches it as the killed process below.
      },
      close: async () => {
        await bridge.close();
        await configFile?.remove();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      },
    };

    if (this.#spec.promptVia === 'arg') {
      child.stdin!.end();
    } else {
      child.stdin!.end(prompt);
    }
    return driveRun(request, services, transport);
  }

  #childEnv(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      ...(this.#spec.env ?? {}),
    };
    if (this.#spec.apiKeyEnvVar) {
      const value = process.env[this.#spec.apiKeyEnvVar];
      if (value) env[this.#spec.apiKeyEnvVar] = value;
    }
    return env;
  }

  /**
   * The MCP configuration as a file, for a CLI that takes a path.
   *
   * Only written when the spec asks for one. A file is created 0600 inside a
   * private directory rather than written and then chmod-ed, because between
   * those two calls the token is world-readable on a shared machine.
   */
  async #writeMcpConfig(
    bridge: ToolBridge,
  ): Promise<{ path: string; remove: () => Promise<void> } | null> {
    if (!this.#spec.args.some((arg) => arg.includes('{mcpConfigFile}'))) return null;
    const dir = await mkdtemp(join(tmpdir(), 'palugada-mcp-'));
    await chmod(dir, 0o700);
    const path = join(dir, 'mcp.json');
    await writeFile(path, mcpConfigJson(bridge), { encoding: 'utf8', mode: 0o600 });
    return {
      path,
      remove: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  async *#streamJsonEvents(child: ChildProcess, stderr: () => string): AsyncGenerator<RunEvent> {
    let buffer = '';
    for await (const chunk of child.stdout!) {
      buffer += (chunk as Buffer).toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let parsed: StreamJsonLine;
        try {
          parsed = JSON.parse(line) as StreamJsonLine;
        } catch {
          // Agent CLIs print things that are not events -- banners, progress,
          // a warning about a config file. Ignoring an unreadable line is
          // right here and wrong in the `script` adapter, where every line is
          // supposed to be an event and an unreadable one means the runtime is
          // not speaking the protocol at all.
          continue;
        }
        yield* translateStreamJsonLine(parsed, stderr, this.name);
      }
    }
  }

  /**
   * A CLI that just prints its answer.
   *
   * Nothing can be said until the process exits, because until then there is
   * no way to tell an answer from the middle of one. The exit code is the
   * verdict: non-zero is a failure carrying whatever the process said about
   * it, and zero is an answer read the same way `claude-code` reads its final
   * result -- as JSON if it is JSON, and otherwise handed to the output-schema
   * check as text so F6.2 refuses it, rather than inventing a shape that
   * would pass.
   */
  async *#textEvents(child: ChildProcess, stderr: () => string): AsyncGenerator<RunEvent> {
    let stdout = '';
    for await (const chunk of child.stdout!) {
      // Bounded for the same reason stderr is, and larger because this one is
      // the answer rather than the commentary.
      stdout = (stdout + (chunk as Buffer).toString('utf8')).slice(-1_048_576);
    }
    const code = await exitCode(child);
    if (code !== 0) {
      const detail = stderr().trim();
      yield {
        type: 'error',
        message: `${this.name} exited ${code}` + (detail ? `: ${detail}` : ''),
        // Not reported as a provider failure. A non-zero exit says the process
        // failed and nothing about why, and F13.6 lets the engine silently
        // change models on a provider failure -- a guess that would turn every
        // crash into a second billed run on a different model.
        providerFailure: false,
      };
      return;
    }
    yield { type: 'done', output: asOutput(stdout.trim()) };
  }
}

function substitute(arg: string, values: CliPlaceholders): string {
  return arg.replace(
    /\{(model|maxTurns|mcpConfig|mcpConfigFile|mcpUrl|mcpToken|allowedTools|prompt)\}/g,
    (_, key: keyof CliPlaceholders) => values[key],
  );
}

function mcpConfigJson(bridge: ToolBridge): string {
  return JSON.stringify({
    mcpServers: {
      palugada: {
        type: 'http',
        url: bridge.url,
        headers: { Authorization: `Bearer ${bridge.token}` },
      },
    },
  });
}

/** Resolves once the child is gone, whether it exited or was signalled. */
function exitCode(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    // A signalled process has no exit code. Reported as 1 rather than as null
    // so that "did it succeed" stays a single comparison.
    child.once('close', (code) => resolve(code ?? 1));
  });
}
