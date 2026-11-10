/**
 * The `claude-code` runtime (PRD v2 F13.2, F13.4, §2.2).
 *
 * Headless Claude Code, run as a child process. v2 §2.2 takes three things
 * from it -- hooks as enforcement, skills as knowledge, subagents as context
 * isolation -- and this adapter is where the first of those has to be made
 * true rather than admired: the CLI is given no tools of its own. Its file,
 * shell and network tools are disallowed, and the only thing it can reach is
 * an MCP server this process is running, whose every tool goes through the
 * broker. A runtime that cannot act except through the broker is a runtime
 * whose compromise is survivable, which is the whole of F13.4.
 *
 * The translation is small because the CLI's stream-json is close to §7.5's
 * vocabulary already: assistant text is `text`, the final result is `done`,
 * and the usage block is `usage`. Tool calls do not appear in the stream at
 * all -- they go over MCP, which is the point.
 *
 * What the suite covers is the argv, the translation, and the bridge; the
 * binary itself is not installed in the test environment. It has been run
 * against the real one, at the version `checked-versions.ts` names, and a
 * version that has not been is said at start (docs/STATUS.md says which is which,
 * rather than letting a green suite imply more than it checked).
 */
import { CHECKED_VERSIONS, uncheckedVersion, versionIn } from './checked-versions.ts';
import { spawn } from 'node:child_process';
import { spawnTree, TreeKeeper } from './process-tree.ts';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  ExecutionBackend,
  ModelUsage,
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { driveRun, readLines, renderPrompt, toWireRequest, type Transport } from './wire.ts';
import { startToolBridge } from './tool-bridge.ts';
import { cliModelFor } from './cli-models.ts';
import { resolveSecretEnv } from './credentials.ts';
import type { SecretManager } from '../secrets/manager.ts';
import { toolsForModel } from './tool-names.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeCodeAdapterOptions {
  name?: string;
  /** The CLI. Resolved through PATH when it is a bare name. */
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  backends?: readonly ExecutionBackend[];
  /**
   * The provider credential the CLI needs for itself.
   *
   * This is the runtime's own key, not a tenant's, and it is the one thing the
   * child is given that the module comment's rule would otherwise forbid. It
   * is named explicitly so that reading the configuration tells you exactly
   * what the child can see.
   */
  apiKeyEnvVar?: string;
  /**
   * The same credential from a secret the deployment holds -- an API key or a
   * `claude setup-token` login the owner saved in the console
   * (`credentials.ts`). With one, the run is given a home of its own: its
   * login no longer lives in the operator's.
   */
  secretEnv?: Record<string, string>;
  secrets?: SecretManager;
  maxTurns?: number;
  /** What each tier means to Claude Code. Default its own aliases: haiku, sonnet, opus. */
  models?: Record<string, string>;
  /** The version whose containment was checked; default `checked-versions.ts`. */
  checkedVersion?: string;
  /** Another version the owner accepted in the console. */
  acceptedVersion?: string;
}

/** Claude Code's own aliases, which follow the latest model of each size. */
const CLAUDE_CODE_TIERS: Readonly<Record<string, string>> = { fast: 'haiku', standard: 'sonnet', deep: 'opus' };

/** What `claude -p --output-format stream-json` writes, in the parts used here. */
export interface StreamJsonLine {
  type: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
  model?: string;
  /** The run's usage by model. Claude Code's result line names its model only here. */
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly name: string;
  readonly backends: readonly ExecutionBackend[];
  readonly #options: ClaudeCodeAdapterOptions;
  readonly #trees = new TreeKeeper();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.name = options.name ?? 'claude-code';
    // `local` only: this adapter spawns the CLI wherever this process runs. It
    // claimed `docker` at one point, which would have made a role's isolation
    // setting a value with no effect -- worse than a missing feature, because
    // it reads like a choice somebody made.
    this.backends = options.backends ?? ['local'];
    this.#options = options;
  }

  get command(): string {
    return this.#options.command ?? 'claude';
  }

  /** The version its flags were checked against, which it is held to. */
  get checkedVersion(): string {
    return this.#options.checkedVersion ?? CHECKED_VERSIONS['claude-code'];
  }

  async health(): Promise<AdapterHealth> {
    const stuck = this.#trees.unhealthy();
    if (stuck) return stuck;
    return new Promise((resolve) => {
      const child = spawn(this.command, ['--version'], {
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out = (out + chunk.toString('utf8')).slice(0, 256);
      });
      child.on('error', (error) =>
        resolve({ ok: false, detail: `${this.command} is not runnable: ${error.message}` }),
      );
      child.on('close', (code) => {
        if (code !== 0) {
          resolve({ ok: false, detail: `${this.command} --version exited ${code}` });
          return;
        }
        const unchecked = uncheckedVersion(this.name, versionIn(out), this.checkedVersion, this.#options.acceptedVersion);
        resolve(unchecked ? { ok: false, detail: unchecked } : { ok: true, detail: out.trim() });
      });
    });
  }

  /**
   * The command line for a run.
   *
   * Separated from `run` so that the argv can be asserted without spawning
   * anything. The flags that matter are the negative ones: the CLI gets none
   * of its own tools, and no permission mode that would let it grant itself
   * any.
   */
  argv(request: RunRequest, mcpConfigFile: string): string[] {
    return [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', cliModelFor(this.name, request.modelRouting.primary, this.#options.models ?? CLAUDE_CODE_TIERS),
      '--max-turns', String(this.#options.maxTurns ?? 40),
      // F13.4. None of its built-in tools. Naming the ones to disallow left
      // seventeen others offered to the model -- sub-agents, scheduled tasks,
      // worktrees -- in Claude Code 2.1.283; an empty list is all of them.
      '--tools', '',
      // Kept as well, for a release that reads the list differently.
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Read,Glob,Grep',
      // The broker, and nothing else: under the names the bridge shows, which
      // are the names the model's provider accepts.
      '--allowedTools', toolsForModel(request.allowedTools).tools.map((tool) => `mcp__palugada__${tool.name}`).join(','),
      // A file, not the JSON itself: the bridge's token on the command line
      // was readable by anything on the machine that can list processes.
      '--mcp-config', mcpConfigFile,
      // Only that server. Without this the CLI also loads whatever MCP
      // servers the operator's own configuration names, and the role gains
      // tools the broker never sees.
      '--strict-mcp-config',
      // None of the operator's settings or memory. Without this, a hook in
      // their ~/.claude/settings.json ran a shell command on every run of
      // every role -- work outside the broker that no policy saw -- and their
      // ~/.claude/CLAUDE.md was read into every prompt, beside the charter.
      // Both checked against the binary: with this, neither happens.
      '--setting-sources', '',
      // A run is a task's, and the task's journal is its record; the CLI's
      // own session history would be a second copy nobody governs.
      '--no-session-persistence',
    ];
  }

  /** The prompt every agent CLI is given (`renderPrompt`). */
  prompt(request: RunRequest): string {
    return renderPrompt(toWireRequest(request));
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    // Refused before anything is started, so a refusal leaves no bridge
    // listening; `argv` below reads the same answer.
    cliModelFor(this.name, request.modelRouting.primary, this.#options.models ?? CLAUDE_CODE_TIERS);
    const credentials = await resolveSecretEnv(this.name, this.#options.secretEnv, this.#options.secrets);
    const bridge = await startToolBridge(request.allowedTools, services);
    // 0700 from mkdtemp, and the file 0600 from the start: the token is in it.
    const runDir = await mkdtemp(join(tmpdir(), 'palugada-claude-'));
    const mcpConfigFile = join(runDir, 'mcp.json');
    await writeFile(mcpConfigFile, JSON.stringify({
      mcpServers: {
        palugada: { type: 'http', url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } },
      },
    }), { mode: 0o600 });

    // Its own updater off: a CLI that replaces itself between runs is running
    // a version nobody checked (`checked-versions.ts`). Read by 2.1.285.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', DISABLE_AUTOUPDATER: '1', ...(this.#options.env ?? {}) };
    if (this.#options.apiKeyEnvVar) {
      const value = process.env[this.#options.apiKeyEnvVar];
      if (value) env[this.#options.apiKeyEnvVar] = value;
    }
    // A credential the deployment holds needs nothing of the operator's
    // home, so the run is given its own, as every other CLI is: the
    // operator's settings, hooks, memory and other logins stay out of it.
    if (Object.keys(credentials).length > 0) Object.assign(env, { HOME: runDir }, credentials);

    const child = spawnTree(this.command, this.argv(request, mcpConfigFile), {
      ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }, services.processes);

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.stdin!.on('error', () => {});
    child.on('error', () => {});

    // A withdrawn run ends its process now, not when the process next says
    // something. This CLI has no cancel message to receive, and one that has
    // gone quiet -- thinking, or hung -- would otherwise have been waited on
    // for as long as it took, holding a worker and spending the owner's key.
    const withdraw = () => void this.#trees.end(child);
    services.signal.addEventListener('abort', withdraw, { once: true });

    const trees = this.#trees;
    const transport: Transport = {
      events: this.#translate(child.stdout!, () => stderr),
      async send() {
        // Nothing to send. Tool answers reach this runtime over MCP, and a
        // cancellation reaches it as the ended process tree above.
      },
      async terminate() {
        await trees.end(child);
      },
      async close() {
        services.signal.removeEventListener('abort', withdraw);
        await bridge.close();
        await rm(runDir, { recursive: true, force: true });
        // The whole group, and whether or not the CLI itself is still there:
        // one that finished and left a server running is the case where
        // nothing else would ever clean up.
        await trees.end(child);
      },
    };

    child.stdin!.end(this.prompt(request));
    return driveRun(request, services, transport);
  }

  /** Reads the CLI's stream-json and says it in §7.5's vocabulary. */
  async *#translate(
    stdout: AsyncIterable<Buffer>,
    stderr: () => string,
  ): AsyncGenerator<RunEvent> {
    for await (const line of readLines(stdout, this.name)) {
      let parsed: StreamJsonLine;
      try {
        parsed = JSON.parse(line) as StreamJsonLine;
      } catch {
        // The CLI prints things that are not events. Ignoring an unreadable
        // line is right here and wrong in the script adapter: there, every
        // line is supposed to be an event, so an unreadable one means the
        // runtime is not speaking the protocol.
        continue;
      }

      yield* translateStreamJsonLine(parsed, stderr, this.name);
    }
  }
}

/**
 * Translates one stream-json line into §7.5's vocabulary.
 *
 * Exported because `CliAdapter` speaks the same dialect for every other
 * headless agent CLI that emits it, and a second copy of this would be a
 * second place for the two to drift apart.
 *
 * `runtime` names who is being translated so an error says which CLI ended
 * badly; it is the adapter's name, not anything the CLI told us.
 */
export function* translateStreamJsonLine(
  line: StreamJsonLine,
  stderr: () => string,
  runtime = 'claude-code',
): Generator<RunEvent> {
  if (line.type === 'assistant') {
    const usage = line.message?.usage;
    if (usage) {
      const reported: ModelUsage = {
        model: line.message?.model ?? 'unknown',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        // F13.7: the per-message stream does not carry a price, so the engine
        // estimates. The final result line does, but by then the budget check
        // that mattered has already had to happen.
        costCents: null,
      };
      yield { type: 'usage', usage: reported };
    }
    for (const part of line.message?.content ?? []) {
      if (part.type === 'text' && part.text) yield { type: 'text', text: part.text };
    }
    return;
  }

  if (line.type === 'result') {
    // The provider's bill for the whole run, which the per-message stream
    // never carried. Reported before `done` or `error`, so the engine settles
    // its estimates against it whichever way the run ended -- a run that
    // failed still cost what it cost.
    if (typeof line.total_cost_usd === 'number' && Number.isFinite(line.total_cost_usd)
      && line.total_cost_usd >= 0) {
      yield {
        type: 'usage',
        usage: {
          model: line.model ?? onlyKey(line.modelUsage) ?? 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          costCents: line.total_cost_usd * 100,
          runTotal: true,
        },
      };
    }
    if (line.subtype !== 'success' || line.is_error) {
      const detail = stderr().trim();
      yield {
        type: 'error',
        message:
          `${runtime} ended as ${line.subtype ?? 'unknown'}` + (detail ? `: ${detail}` : ''),
        // A CLI that ends in an error subtype has usually failed to reach the
        // provider, which is exactly the case F13.6 may retry on a fallback
        // model. Whether it is retried is the engine's decision, not this one.
        providerFailure: line.subtype === 'error_during_execution',
      };
      return;
    }
    yield { type: 'done', output: asOutput(line.result) };
  }
}

/** The one model a run used, when it used one. */
function onlyKey(record: Record<string, unknown> | undefined): string | null {
  const keys = Object.keys(record ?? {});
  return keys.length === 1 ? keys[0]! : null;
}

/**
 * Reads the CLI's final message as the task's output.
 *
 * The prompt asks for one JSON object. A runtime that answers with prose has
 * not followed its instructions, and the honest thing is to hand that prose to
 * the output-schema check as `{ text: ... }` and let F6.2 refuse it, rather
 * than to invent a shape that would pass.
 */
export function asOutput(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON. Falls through to the text form below.
  }
  return { text };
}
