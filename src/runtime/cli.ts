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
import { spawnTree, TreeKeeper } from './process-tree.ts';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  ExecutionBackend,
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { driveRun, readLines, renderPrompt, toWireRequest, type Transport } from './wire.ts';
import { toolsForModel } from './tool-names.ts';
import { startToolBridge, type ToolBridge } from './tool-bridge.ts';
import { cliModelFor } from './cli-models.ts';
import { PalugadaError } from '../errors.ts';
import { resolveSecretEnv } from './credentials.ts';
import type { SecretManager } from '../secrets/manager.ts';
import { asOutput, translateStreamJsonLine, type StreamJsonLine } from './claude-code.ts';
import {
  codexEvents, geminiEvents, hermesEvents, hermesSessionCents, openCodeEvents, openClawEvents,
} from './cli-dialects.ts';

/**
 * How the CLI talks back.
 *
 * `stream-json` is the Anthropic-style newline-delimited envelope Claude Code
 * emits. `text` is everything else: the process prints its answer and exits,
 * and the exit code is the verdict. The others are the CLIs whose own formats
 * were read from their source or their output (src/runtime/cli-dialects.ts):
 * Hermes's stream-json looks like Claude Code's and is not, OpenClaw answers
 * with one JSON envelope at exit, OpenCode and Codex stream events with no
 * final result line, and Gemini CLI's result carries no answer.
 *
 * Deliberately not offered: the platform's own `RunEvent` NDJSON. A runtime
 * that speaks that already has an adapter -- `script` -- and a second way to
 * reach it would only be a second thing to keep in step.
 */
export const CLI_DIALECTS = [
  'stream-json', 'text', 'hermes-stream-json', 'openclaw-json', 'opencode-json', 'codex-jsonl', 'gemini-stream-json',
] as const;
export type CliDialect = (typeof CLI_DIALECTS)[number];

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
   * The run's wall clock in whole seconds, never less than one: the task's
   * deadline, or the lease when it has none. For a CLI with a timeout of its
   * own, so that it stops by itself -- and says what it spent -- when the
   * run's time is up, rather than at a number written into its entry. Never
   * 0, which OpenClaw reads as no limit.
   */
  wallClockSeconds: string;
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
  /**
   * A private directory for this run alone: 0700, removed when the run ends.
   * Where a spec's `files` are written, and what a spec sets `HOME` to, so a
   * CLI never falls back to the operator's own home -- its stored
   * credentials, its plugins, its memory of other runs.
   */
  runDir: string;
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
  /**
   * What the child may see, beyond `PATH`. Never inherited. Values take the
   * same placeholders as `args`: this is where a bridge token belongs, since
   * an environment is readable only by the process and its owner and an argv
   * is readable by everyone on the host.
   */
  env?: Record<string, string>;
  /**
   * Files written into `{runDir}` before the CLI starts, 0600, by path
   * relative to it; contents take the placeholders. For a CLI that reads its
   * MCP servers from its own configuration format rather than from a flag --
   * which is most of them. A file should reference the token through the
   * CLI's own environment substitution (`${PALUGADA_MCP_TOKEN}`) rather than
   * holding it.
   */
  files?: Record<string, string>;
  /**
   * The runtime's own provider credential.
   *
   * Named rather than inherited, so that reading the configuration tells you
   * exactly which of this process's environment variables reaches the child.
   * It is the runtime's key and never a tenant's: a tenant's credentials go
   * through the broker, which is the whole of F13.4.
   */
  apiKeyEnvVar?: string;
  /**
   * The runtime's own credential, from a secret the deployment holds: the
   * variable the CLI reads, and the reference to resolve for each run --
   * `{"ANTHROPIC_API_KEY": "db://agent-claude-code"}` for a key the owner
   * saved in the console. Resolved per run, never written to a file, and
   * refused before anything starts when it cannot be opened.
   */
  secretEnv?: Record<string, string>;
  maxTurns?: number;
  /**
   * Model name prefixes the CLI would sign in to with the machine's own
   * identity rather than a key PALUGADA hands it -- a cloud instance's role,
   * a desktop keychain -- which a home of its own does not keep it from.
   * A role whose model starts with one is refused before anything starts.
   */
  hostSignInModels?: string[];
  /**
   * A second, short call that reads what the run cost, for a CLI whose
   * stream does not say: the same command and environment, these arguments,
   * `{sessionId}` the id its result line gave. Hermes's is
   * `sessions export - --session-id {sessionId}`.
   */
  costArgs?: string[];
  cwd?: string;
  /**
   * What each tier a role names means to this CLI, such as
   * `{"standard": "gpt-5"}`. A role that names a model rather than a tier is
   * passed as it is (`cli-models.ts`).
   */
  models?: Record<string, string>;
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
    // A misspelt dialect read as Claude Code's would fail every run as
    // "ended as unknown", which says nothing about the spelling.
    if (spec.dialect !== undefined && !(CLI_DIALECTS as readonly unknown[]).includes(spec.dialect)) {
      throw new Error(`runtime spec ${spec.name} names dialect ${String(spec.dialect)}; one of ${CLI_DIALECTS.join(', ')}`);
    }
    if (spec.costArgs !== undefined && (!Array.isArray(spec.costArgs) || spec.costArgs.some((arg) => typeof arg !== 'string'))) {
      throw new Error(`runtime spec ${spec.name} has costArgs that is not a list of arguments`);
    }
    if (spec.hostSignInModels !== undefined && (!Array.isArray(spec.hostSignInModels)
      || spec.hostSignInModels.some((prefix) => typeof prefix !== 'string' || prefix === ''))) {
      throw new Error(`runtime spec ${spec.name} has hostSignInModels that is not a list of model name prefixes`);
    }
    // Hermes reads `--max-turns 0` as no limit at all, so a zero written here
    // to mean "none" would mean "for ever".
    if (spec.maxTurns !== undefined && !(Number.isInteger(spec.maxTurns) && (spec.maxTurns as number) >= 1)) {
      throw new Error(`runtime spec ${spec.name} has maxTurns ${JSON.stringify(spec.maxTurns)}; a whole number of at least 1`);
    }
    if (spec.secretEnv !== undefined && (typeof spec.secretEnv !== 'object' || spec.secretEnv === null
      || Object.entries(spec.secretEnv).some(([name, reference]) => !/^[A-Z][A-Z0-9_]*$/.test(name) || typeof reference !== 'string'))) {
      throw new Error(`runtime spec ${spec.name} has a secretEnv that is not a map from a variable name to a secret reference`);
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
  readonly #secrets: SecretManager | undefined;
  readonly #trees = new TreeKeeper();

  constructor(spec: CliRuntimeSpec, options: { secrets?: SecretManager } = {}) {
    // Anywhere the CLI will read it: its arguments, its environment, or a
    // configuration file written for it. Most agent CLIs take MCP servers
    // only from a file in their own format, so arguments alone was a check
    // those CLIs could only pass by being configured wrongly.
    const placed = [
      ...spec.args, ...Object.values(spec.env ?? {}), ...Object.values(spec.files ?? {}),
    ].join('\n');
    if (!BRIDGE_PLACEHOLDERS.some((placeholder) => placed.includes(placeholder))) {
      throw new Error(
        `runtime ${spec.name} places no tool bridge: one of ` +
          `${BRIDGE_PLACEHOLDERS.join(', ')} must appear in its arguments, environment or ` +
          'files, or the CLI would run with no tools at all and answer as though it had them',
      );
    }
    for (const path of Object.keys(spec.files ?? {})) {
      const clean = normalize(path);
      if (isAbsolute(path) || clean === '..' || clean.startsWith(`..${sep}`)) {
        throw new Error(`runtime ${spec.name} names a file outside its run directory: ${path}`);
      }
    }
    this.name = spec.name;
    this.#spec = spec;
    this.#secrets = options.secrets;
  }

  async health(): Promise<AdapterHealth> {
    const stuck = this.#trees.unhealthy();
    if (stuck) return stuck;
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
   * Everything a run hands the CLI -- arguments, environment, files -- with
   * the placeholders filled in, and nothing spawned. What `argv` is for the
   * arguments, for the rest.
   */
  layout(values: CliPlaceholders): { argv: string[]; env: Record<string, string>; files: Record<string, string> } {
    return {
      argv: this.argv(values),
      env: Object.fromEntries(Object.entries(this.#spec.env ?? {}).map(([key, value]) => [key, substitute(value, values)])),
      files: Object.fromEntries(Object.entries(this.#spec.files ?? {}).map(([path, body]) => [path, substitute(body, values)])),
    };
  }

  /** The prompt every agent CLI is given (`renderPrompt`). */
  prompt(request: RunRequest): string {
    return renderPrompt(toWireRequest(request));
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    // Before anything is started: a refusal here leaves no bridge listening
    // and no directory behind.
    const model = cliModelFor(this.name, request.modelRouting.primary, this.#spec.models);
    const hostSignIn = this.#spec.hostSignInModels?.find((prefix) => model.startsWith(prefix));
    if (hostSignIn) {
      throw new PalugadaError('model.unavailable',
        `runtime ${this.name} would sign in with this machine's own identity for ${model} (${hostSignIn}*), not with a key `
          + 'the owner gave it: choose a model from a provider whose key is saved under This deployment, Agents', { model });
    }
    const credentials = await resolveSecretEnv(this.name, this.#spec.secretEnv, this.#secrets);
    const bridge = await startToolBridge(request.allowedTools, services);
    const prompt = this.prompt(request);

    // Made before the spawn and removed in `close`, whatever happens: what is
    // written here may carry the run's bearer token, so leaving it behind
    // would leave a credential on disk for a runtime that has already exited.
    // Created 0700 by mkdtemp and every file in it 0600 from the start,
    // rather than written and then chmod-ed, because between those two calls
    // the token is readable on a shared machine.
    const runDir = await mkdtemp(join(tmpdir(), 'palugada-run-'));
    await chmod(runDir, 0o700);
    const values: CliPlaceholders = {
      model,
      maxTurns: String(this.#spec.maxTurns ?? 40),
      wallClockSeconds: String(Math.max(1, Math.floor(request.limits.wallClockMs / 1000))),
      mcpConfig: mcpConfigJson(bridge),
      mcpConfigFile: join(runDir, 'mcp.json'),
      mcpUrl: bridge.url,
      mcpToken: bridge.token,
      // The names the bridge shows, which are the names a model's provider
      // accepts: a dotted one is refused before the model sees it.
      allowedTools: toolsForModel(request.allowedTools).tools
        .map((tool) => `mcp__palugada__${tool.name}`)
        .join(','),
      prompt,
      runDir,
    };
    const layout = this.layout(values);
    if (this.#uses('{mcpConfigFile}')) {
      await writeFile(values.mcpConfigFile, values.mcpConfig, { encoding: 'utf8', mode: 0o600 });
    }
    for (const [path, body] of Object.entries(layout.files)) {
      const target = join(runDir, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, body, { encoding: 'utf8', mode: 0o600 });
    }

    const place = {
      // Placeholders too: a CLI with no flag for its working directory
      // reads its project settings from wherever it runs, and the run's own
      // directory is the only place that holds nothing it was not given.
      ...(this.#spec.cwd ? { cwd: substitute(this.#spec.cwd, values) } : {}),
      // Not `process.env`. The parent's environment is where `DATABASE_URL`
      // and every provider key live, and a child that inherited it would
      // have been handed the platform's own credentials without anything
      // failing to say so.
      env: { ...this.#childEnv(layout.env), ...credentials },
    };
    const child = spawnTree(this.#spec.command, layout.argv, { ...place, stdio: ['pipe', 'pipe', 'pipe'] });

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

    // A withdrawn run ends its process now, not when the process next says
    // something: these CLIs have no cancel message to receive, and one that
    // has gone quiet would otherwise hold a worker for as long as it liked.
    const withdraw = () => void this.#trees.end(child);
    services.signal.addEventListener('abort', withdraw, { once: true });

    const transport: Transport = {
      events: this.#events(child, () => stderr, values.model, (sessionId) => this.#sessionCost(sessionId, place)),
      async send() {
        // Nothing to send. Tool answers reach this runtime over MCP, and a
        // cancellation reaches it as the killed process below.
      },
      terminate: async () => {
        await this.#trees.end(child);
      },
      close: async () => {
        services.signal.removeEventListener('abort', withdraw);
        await bridge.close();
        await rm(runDir, { recursive: true, force: true });
        // The whole group, whether or not the CLI itself is still running.
        await this.#trees.end(child);
      },
    };

    if (this.#spec.promptVia === 'arg') {
      child.stdin!.end();
    } else {
      child.stdin!.end(prompt);
    }
    return driveRun(request, services, transport);
  }

  #uses(placeholder: string): boolean {
    return [...this.#spec.args, ...Object.values(this.#spec.env ?? {}), ...Object.values(this.#spec.files ?? {})]
      .some((text) => text.includes(placeholder));
  }

  #events(
    child: ChildProcess, stderr: () => string, model: string, costOf: (sessionId: string) => Promise<number | null>,
  ): AsyncGenerator<RunEvent> {
    switch (this.#spec.dialect ?? 'stream-json') {
      case 'text': return this.#textEvents(child, stderr);
      case 'hermes-stream-json':
        return hermesEvents(readLines(child.stdout!, this.name), () => exitCode(child), stderr, this.name, model, this.#spec.costArgs ? costOf : undefined);
      case 'openclaw-json': return openClawEvents(whole(child), () => exitCode(child), stderr, this.name, model);
      case 'opencode-json': return openCodeEvents(readLines(child.stdout!, this.name), () => exitCode(child), stderr, this.name, model);
      case 'codex-jsonl': return codexEvents(readLines(child.stdout!, this.name), () => exitCode(child), stderr, this.name, model);
      case 'gemini-stream-json': return geminiEvents(readLines(child.stdout!, this.name), () => exitCode(child), stderr, this.name, model);
      default: return this.#streamJsonEvents(child, stderr);
    }
  }

  /**
   * What the CLI's own ledger says a session cost (`costArgs`), in the run's
   * directory and environment, before either is gone. Only the first line is
   * read -- Hermes puts the whole conversation after it -- and a call that
   * says nothing usable in fifteen seconds leaves the price to the engine.
   */
  async #sessionCost(sessionId: string, place: { cwd?: string; env: Record<string, string> }): Promise<number | null> {
    // It came from the CLI's own output, and it is about to be an argument.
    if (!/^[A-Za-z0-9][\w.:-]{0,127}$/.test(sessionId)) return null;
    const probe = spawnTree(this.#spec.command, this.#spec.costArgs!.map((arg) => arg.replaceAll('{sessionId}', sessionId)),
      { ...place, stdio: ['ignore', 'pipe', 'ignore'] });
    probe.on('error', () => {});
    try {
      const first = await new Promise<string | null>((resolve) => {
        let text = '';
        const timer = setTimeout(() => resolve(null), 15_000);
        probe.stdout!.setEncoding('utf8');
        probe.stdout!.on('data', (chunk: string) => {
          text += chunk;
          const end = text.indexOf('\n');
          if (end !== -1 || text.length > 4 * 1024 * 1024) {
            clearTimeout(timer);
            resolve(end === -1 ? null : text.slice(0, end));
          }
        });
        probe.stdout!.on('end', () => { clearTimeout(timer); resolve(text.trim() || null); });
      });
      const row = first ? JSON.parse(first) as unknown : null;
      return row && typeof row === 'object' && !Array.isArray(row) ? hermesSessionCents(row as Record<string, unknown>) : null;
    } catch {
      return null;
    } finally {
      await this.#trees.end(probe);
    }
  }

  #childEnv(fromSpec: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      ...fromSpec,
    };
    if (this.#spec.apiKeyEnvVar) {
      const value = process.env[this.#spec.apiKeyEnvVar];
      if (value) env[this.#spec.apiKeyEnvVar] = value;
    }
    return env;
  }

  async *#streamJsonEvents(child: ChildProcess, stderr: () => string): AsyncGenerator<RunEvent> {
    for await (const line of readLines(child.stdout!, this.name)) {
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
    /\{(model|maxTurns|wallClockSeconds|mcpConfig|mcpConfigFile|mcpUrl|mcpToken|allowedTools|prompt|runDir)\}/g,
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

/** The child's whole stdout, bounded, once it has closed it. */
async function whole(child: ChildProcess): Promise<string> {
  let stdout = '';
  for await (const chunk of child.stdout!) {
    stdout = (stdout + (chunk as Buffer).toString('utf8')).slice(-1_048_576);
  }
  return stdout;
}
