/**
 * The Agent Client Protocol (the competitive analysis of 2026-09-30, item
 * 14): any agent that speaks it -- Gemini CLI with `--acp`, Claude through
 * `claude-agent-acp`, Codex through `codex-acp`, Goose, OpenCode, Cursor,
 * GitHub Copilot and some forty more in the protocol's registry -- becomes a
 * role's runtime from one configuration entry with `"dialect": "acp"`.
 *
 * Version 1, the stable one, as its schema and documentation give it
 * (`schema/v1/schema.json`, read 2026-09-30): JSON-RPC 2.0, one message a
 * line on the agent's stdin and stdout, its stderr for its logs.
 *
 * What PALUGADA is to the agent:
 *
 *   - A client with no file system and no terminal. It advertises neither,
 *     and answers "method not found" if asked anyway. What the company can
 *     do reaches the agent as the tool bridge, an MCP server over HTTP named
 *     in `session/new`, whose every call goes through the broker.
 *   - The one who says yes to a tool call. `session/request_permission` is
 *     allowed once for one of the role's own tools on the bridge and refused
 *     for anything else: a shell, an edit, a fetch the agent would make on
 *     its own. Never "always": a yes is for the call in front of it.
 *   - The one who stops it. A withdrawn run, or one past its deadline, is
 *     sent `session/cancel`, and any question asked after it is answered
 *     "cancelled"; the process is ended when the agent has stopped or its
 *     grace is over, whichever is first.
 *
 * What comes back: the agent's messages as the run's transcript, its last
 * message as the output, and what the session cost when the agent says
 * (`usage_update.cost`, in US dollars; version 1 reports no tokens).
 *
 * An agent that runs its own tools without asking is not held by the
 * permission answer: that is the agent's own containment, as it is for the
 * agent CLIs, and the threat model says so.
 */
import type { ChildProcess } from 'node:child_process';
import { readLines } from './wire.ts';
import { asOutput } from './claude-code.ts';
import { toolsForModel } from './tool-names.ts';
import { PalugadaError } from '../errors.ts';
import { VERSION } from '../version.ts';
import type { RunEvent, ToolDeclaration } from './protocol.ts';

/** The stable version, the only one spoken here. */
const ACP_PROTOCOL_VERSION = 1;

/** How long the agent has to answer before the prompt: starting, and opening a session. */
const HANDSHAKE_MS = 60_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AcpRun {
  child: ChildProcess;
  /** The runtime's name, for what the owner reads. */
  name: string;
  model: string;
  prompt: string;
  /** Where the session works: absolute, the run's own directory. */
  cwd: string;
  /** The tool bridge, when the role has tools. */
  bridge: { url: string; token: string } | null;
  tools: ToolDeclaration[];
  stderr: () => string;
  exit: () => Promise<number>;
  handshakeMs?: number;
}

export interface AcpSession {
  events: AsyncGenerator<RunEvent>;
  /**
   * Sends `session/cancel` (or, before a session is open, has it sent the
   * moment one is), and settles when the agent has answered the prompt or
   * `graceMs` has passed. Once: a second call is the first one's promise.
   */
  cancel(graceMs: number): Promise<void>;
}

class AcpFailure extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** The protocol's `auth_required`: the agent has no sign-in to work with. */
const AUTH_REQUIRED = -32000;

/**
 * The kinds of tool call that are an agent's own hands -- a shell, an edit,
 * a delete, a move -- refused whatever they are called: no tool on the
 * bridge is any of these to the agent.
 */
const OWN_KINDS: ReadonlySet<unknown> = new Set(['execute', 'edit', 'delete', 'move']);

/**
 * Whether a tool call the agent asks about is one of the role's own, on the
 * bridge. Its name or title must be exactly one of the ways an agent names
 * an MCP tool -- bare, or behind the server's name -- never merely end with
 * one: an agent titles a shell call with its command line, and
 * `rm -rf ~ #mcp__palugada__dns_read` ends like a bridge tool.
 */
function ours(call: Record<string, unknown>, shown: ReadonlySet<string>): boolean {
  if (OWN_KINDS.has(call.kind)) return false;
  const names = [call.name, call.title].filter((text): text is string => typeof text === 'string');
  return names.some((text) => [...shown].some((tool) => [
    tool, `mcp__palugada__${tool}`, `palugada__${tool}`, `mcp_palugada_${tool}`,
    `palugada/${tool}`, `palugada.${tool}`, `palugada: ${tool}`, `${tool} (palugada MCP Server)`,
  ].includes(text.trim())));
}

export function acpSession(run: AcpRun): AcpSession {
  let sessionId: string | null = null;
  let cancelling: Promise<void> | null = null;
  let promptSettled: Promise<unknown> | null = null;
  let answered: (() => void) | null = null;
  const sendCancel = () => {
    if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
  };
  // Filled in by the generator below, which owns the agent's stdin.
  let write: (message: JsonRpcMessage) => void = () => undefined;

  const cancel = (graceMs: number): Promise<void> => {
    cancelling ??= (async () => {
      sendCancel();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        (promptSettled ?? new Promise<void>((resolve) => { answered = resolve; })).catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
      ]);
      clearTimeout(timer);
    })();
    return cancelling;
  };

  async function* events(): AsyncGenerator<RunEvent> {
    const shown = new Set(toolsForModel(run.tools).tools.map((tool) => tool.name));
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const said: Array<{ id: string | null; text: string }> = [];
    const events: RunEvent[] = [];
    let wake = null as (() => void) | null;
    let nextId = 1;
    let costUsd: number | null = null;
    let closed: Error | null = null;

    const emit = (event: RunEvent) => {
      events.push(event);
      wake?.();
    };
    write = (message: JsonRpcMessage) => {
      if (run.child.stdin?.writable) run.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(closed);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
    const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
      const limit = run.handshakeMs ?? HANDSHAKE_MS;
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AcpFailure(`${run.name} did not answer ${what} within ${limit / 1000} seconds`)), limit);
        }),
      ]).finally(() => clearTimeout(timer));
    };

    // The agent's questions, answered at once.
    const answer = (message: JsonRpcMessage) => {
      if (message.method === 'session/request_permission') {
        const params = message.params ?? {};
        const call = (params.toolCall ?? {}) as Record<string, unknown>;
        const choices = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId?: unknown; kind?: unknown }>;
        const stopping = cancelling !== null;
        const allowed = !stopping && ours(call, shown);
        const choice = stopping ? undefined
          : choices.find((one) => one.kind === (allowed ? 'allow_once' : 'reject_once'))
            ?? (allowed ? undefined : choices.find((one) => one.kind === 'reject_always'));
        if (!allowed && !stopping) {
          emit({ type: 'text', text: `Refused ${run.name} its own tool: ${String(call.title ?? call.name ?? call.toolCallId ?? 'unnamed')}` });
        }
        write({
          id: message.id ?? null,
          result: { outcome: choice && typeof choice.optionId === 'string' ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } },
        });
        return;
      }
      write({
        id: message.id ?? null,
        error: {
          code: -32601,
          message: `PALUGADA does not offer ${String(message.method)}: it gives an agent no file system or terminal of its own; `
            + 'its tools are on the MCP server named palugada',
        },
      });
    };

    const onUpdate = (update: Record<string, unknown> | undefined) => {
      if (!update) return;
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content as { type?: unknown; text?: unknown } | undefined;
        if (content?.type !== 'text' || typeof content.text !== 'string') return;
        const id = typeof update.messageId === 'string' ? update.messageId : null;
        const last = said.at(-1);
        if (last && last.id === id) last.text += content.text;
        else said.push({ id, text: content.text });
      } else if (update.sessionUpdate === 'tool_call') {
        // A new message starts after a tool call, whether or not it says so.
        said.push({ id: `after:${String(update.toolCallId ?? said.length)}`, text: '' });
      } else if (update.sessionUpdate === 'usage_update') {
        const cost = update.cost as { amount?: unknown; currency?: unknown } | undefined;
        if (cost && cost.currency === 'USD' && typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0) {
          costUsd = cost.amount;
        }
      }
    };

    // Read until the agent's stdout closes; whatever is still waiting then fails.
    const reading = (async () => {
      try {
        for await (const line of readLines(run.child.stdout!, run.name)) {
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            // The protocol forbids anything else on stdout; a line that is not
            // a message is not one, and is left for stderr's kind of reading.
            continue;
          }
          if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
            answer(message);
          } else if (typeof message.method === 'string') {
            if (message.method === 'session/update') onUpdate(message.params?.update as Record<string, unknown> | undefined);
          } else if (typeof message.id === 'number') {
            const waiting = pending.get(message.id);
            if (!waiting) continue;
            pending.delete(message.id);
            if (message.error) {
            waiting.reject(new AcpFailure(`${run.name}: ${message.error.message ?? 'error'} (${message.error.code ?? '?'})`, message.error.code));
          }
            else waiting.resolve(message.result);
          }
        }
      } finally {
        const code = await run.exit().catch(() => null);
        const detail = run.stderr().trim().split('\n').slice(-3).join(' ').slice(0, 500);
        closed = new AcpFailure(`${run.name} exited${code === null ? '' : ` ${code}`} before it answered${detail ? `: ${detail}` : ''}`);
        for (const waiting of pending.values()) waiting.reject(closed);
        pending.clear();
        wake?.();
      }
    })();
    reading.catch(() => undefined);

    try {
      const started = await within(request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'palugada', title: 'PALUGADA', version: VERSION },
      }), 'initialize') as { protocolVersion?: unknown; agentCapabilities?: { mcpCapabilities?: { http?: unknown } } } | null;
      // What another attempt would meet again halts the task as the runtime
      // being unavailable, so the owner is told once instead of the task
      // spending its attempts on the same answer.
      const unusable = (why: string) => new PalugadaError('model.unavailable', why, { model: run.model });
      if (started?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw unusable(`${run.name} speaks ACP version ${JSON.stringify(started?.protocolVersion)}; PALUGADA speaks ${ACP_PROTOCOL_VERSION}`);
      }
      if (run.bridge && started.agentCapabilities?.mcpCapabilities?.http !== true) {
        throw unusable(`${run.name} cannot reach an MCP server over HTTP, which is how PALUGADA hands a role its tools`);
      }
      const opened = await within(request('session/new', {
        cwd: run.cwd,
        mcpServers: run.bridge
          ? [{ type: 'http', name: 'palugada', url: run.bridge.url, headers: [{ name: 'Authorization', value: `Bearer ${run.bridge.token}` }] }]
          : [],
      }), 'session/new').catch((failure: unknown) => {
        if (failure instanceof AcpFailure && failure.code === AUTH_REQUIRED) {
          throw unusable(`${run.name} needs to be signed in: give its entry the key it reads (${failure.message})`);
        }
        throw failure;
      }) as { sessionId?: unknown } | null;
      if (typeof opened?.sessionId !== 'string' || !opened.sessionId) throw new AcpFailure(`${run.name} opened no session`);
      sessionId = opened.sessionId;
      // Withdrawn while the session was opening: it is cancelled as it opens.
      if (cancelling) sendCancel();

      let finished: { stopReason?: unknown } | null = null;
      let failure: Error | null = null;
      let over = false;
      promptSettled = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: run.prompt }] }).then(
        (result) => { finished = result as { stopReason?: unknown } | null; over = true; wake?.(); },
        (error: Error) => { failure = error; over = true; wake?.(); },
      );
      void promptSettled.then(() => answered?.());
      while (!over || events.length > 0) {
        const next = events.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
      }
      if (failure) throw failure;

      const messages = said.map((one) => one.text.trim()).filter(Boolean);
      for (const text of messages) yield { type: 'text', text };
      if (costUsd !== null) {
        yield { type: 'usage', usage: { model: run.model, inputTokens: 0, outputTokens: 0, costCents: costUsd * 100, runTotal: true } };
      }
      const reason = (finished as { stopReason?: unknown } | null)?.stopReason;
      switch (reason) {
        case 'end_turn':
          yield { type: 'done', output: asOutput(messages.at(-1) ?? '') };
          return;
        case 'cancelled':
          yield { type: 'error', message: `${run.name} stopped: the run was withdrawn`, providerFailure: false };
          return;
        case 'refusal':
          yield { type: 'error', message: `${run.name} refused the task`, providerFailure: false };
          return;
        case 'max_tokens':
        case 'max_turn_requests':
          yield { type: 'error', message: `${run.name} stopped at its own limit (${reason}) before it finished`, providerFailure: false };
          return;
        default:
          yield { type: 'error', message: `${run.name} ended the turn as ${JSON.stringify(reason)}, which ACP version 1 does not name`, providerFailure: false };
      }
    } catch (failure) {
      if (failure instanceof PalugadaError) throw failure;
      yield { type: 'error', message: (failure as Error).message, providerFailure: false };
    } finally {
      // Whatever cancel is waiting on, it is over.
      answered?.();
    }
  }

  return { events: events(), cancel };
}
