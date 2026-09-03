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
 * What is not verified here: this adapter has never been run against the real
 * binary in this repository, because the binary is not installed and the
 * provider is not reachable from the test environment. What the tests cover is
 * the argv, the translation, and the bridge. docs/STATUS.md says so plainly
 * rather than letting a green suite imply more than it checked.
 */
import { spawn } from 'node:child_process';
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
import { driveRun, toWireRequest, type Transport } from './wire.ts';
import { startToolBridge } from './tool-bridge.ts';

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
  maxTurns?: number;
}

/** What `claude -p --output-format stream-json` writes, in the parts used here. */
interface StreamJsonLine {
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
}

export class ClaudeCodeAdapter implements Adapter {
  readonly name: string;
  readonly backends: readonly ExecutionBackend[];
  readonly #options: ClaudeCodeAdapterOptions;

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

  async health(): Promise<AdapterHealth> {
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
      child.on('close', (code) =>
        resolve(
          code === 0
            ? { ok: true, detail: out.trim() }
            : { ok: false, detail: `${this.command} --version exited ${code}` },
        ),
      );
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
  argv(request: RunRequest, bridge: { url: string; token: string }): string[] {
    return [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', request.modelRouting.primary,
      '--max-turns', String(this.#options.maxTurns ?? 40),
      // F13.4. Everything the CLI could otherwise do to the world directly.
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Read,Glob,Grep',
      // The broker, and nothing else.
      '--allowedTools', request.allowedTools.map((tool) => `mcp__palugada__${tool.name}`).join(','),
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          palugada: {
            type: 'http',
            url: bridge.url,
            headers: { Authorization: `Bearer ${bridge.token}` },
          },
        },
      }),
    ];
  }

  /**
   * The prompt.
   *
   * The charter first, because F3.2 says the platform charter outranks the
   * company's and a prompt that buries it has already lost that argument. The
   * request itself travels as JSON: the runtime is a program, and asking it to
   * parse prose it was given would add a failure mode for nothing.
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

    const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(this.#options.env ?? {}) };
    if (this.#options.apiKeyEnvVar) {
      const value = process.env[this.#options.apiKeyEnvVar];
      if (value) env[this.#options.apiKeyEnvVar] = value;
    }

    const child = spawn(this.command, this.argv(request, bridge), {
      ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {});

    const transport: Transport = {
      events: this.#translate(child.stdout!, () => stderr),
      async send() {
        // Nothing to send. Tool answers reach this runtime over MCP, and a
        // cancellation reaches it as the killed process below.
      },
      async close() {
        await bridge.close();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      },
    };

    child.stdin.end(this.prompt(request));
    return driveRun(request, services, transport);
  }

  /** Reads the CLI's stream-json and says it in §7.5's vocabulary. */
  async *#translate(
    stdout: AsyncIterable<Buffer>,
    stderr: () => string,
  ): AsyncGenerator<RunEvent> {
    let buffer = '';
    for await (const chunk of stdout) {
      buffer += chunk.toString('utf8');
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
          // The CLI prints things that are not events. Ignoring an unreadable
          // line is right here and wrong in the script adapter: there, every
          // line is supposed to be an event, so an unreadable one means the
          // runtime is not speaking the protocol.
          continue;
        }

        yield* translateLine(parsed, stderr);
      }
    }
  }
}

function* translateLine(line: StreamJsonLine, stderr: () => string): Generator<RunEvent> {
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
    if (line.subtype !== 'success' || line.is_error) {
      const detail = stderr().trim();
      yield {
        type: 'error',
        message:
          `claude-code ended as ${line.subtype ?? 'unknown'}` + (detail ? `: ${detail}` : ''),
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

/**
 * Reads the CLI's final message as the task's output.
 *
 * The prompt asks for one JSON object. A runtime that answers with prose has
 * not followed its instructions, and the honest thing is to hand that prose to
 * the output-schema check as `{ text: ... }` and let F6.2 refuse it, rather
 * than to invent a shape that would pass.
 */
function asOutput(result: unknown): Record<string, unknown> {
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
