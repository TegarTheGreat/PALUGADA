/**
 * The runtime adapter protocol (PRD v2 §7.5, F13.1, F13.4, F13.8, NG6).
 *
 * NG6 is the change in v2 that reaches furthest: **PALUGADA orchestrates and
 * does not execute.** It does not call a model to do a task; a runtime does,
 * through this protocol. What the platform keeps is everything a runtime must
 * not be trusted with — the tenant boundary, the capability broker, the
 * budget, the journal — and what it hands over is the deciding.
 *
 * Three properties the shape is built to guarantee.
 *
 * **A runtime holds no credentials (F13.4, F8.7).** `allowedTools` carries
 * names and schemas and nothing else. A tool call comes back to the engine,
 * which resolves it through the broker and hands back only the result. A
 * compromised runtime can therefore ask for things and be refused; it cannot
 * take them.
 *
 * **A runtime holds no database connection (§7.2).** Everything it needs
 * arrives in the request, and everything it produces leaves as an event. There
 * is no path from a runtime to another tenant's data because there is no path
 * from a runtime to any data.
 *
 * **The engine remains the only source of truth about a task (principle 5).**
 * The runtime says what it wants to do and what it produced. Whether the task
 * is running, halted or finished is never its answer to give.
 *
 * On durability, honestly: the in-process runtime journals each model call and
 * each tool call, so a crash resumes without repeating either. An
 * out-of-process runtime is a black box between tool calls -- F5.1 journals
 * "the adapter round-trip", so a resumed run re-enters the runtime and its
 * internal reasoning happens again. What stops that from being wasteful is
 * session continuity (F4.7): the committed steps travel in the context pack,
 * so the runtime can see what it already did. That is a weaker guarantee than
 * deterministic replay and it is the price of not being the runtime.
 */
import type { StepKind } from '../engine/journal.ts';
import type { Goal } from '../domain/goals.ts';
import type { TaskRow } from '../engine/tasks.ts';

export interface ToolDeclaration {
  name: string;
  /** JSON Schema for the arguments. Never a credential, never an endpoint. */
  inputSchema: Record<string, unknown>;
  tier: number;
}

export interface ContextPack {
  /** Platform charter first, then the company's (F3.2). */
  charter: string;
  /** Division SOPs and, once F15 lands, skills (F15.7 keeps these summaries). */
  skills: string[];
  /** Scoped semantic memory, with the low-confidence ones already marked. */
  memories: string[];
  /** F2.7: mission → objective → key result. */
  goalAncestry: Goal[];
  /**
   * F4.7: what this task already did, so a resumed run continues rather than
   * starting again.
   */
  workingMemory: Array<{ name: string; output: unknown }>;
}

export interface ModelRouting {
  /** F13.6. A role's own words; the adapter resolves them to a provider. */
  primary: string;
  fallback: string[];
}

export type ExecutionBackend = 'local' | 'docker' | 'remote_sandbox';

export interface RunRequest {
  runId: string;
  task: TaskRow;
  roleSlug: string;
  contextPack: ContextPack;
  allowedTools: ToolDeclaration[];
  modelRouting: ModelRouting;
  backend: ExecutionBackend;
  limits: {
    tokens: number;
    wallClockMs: number;
  };
}

export interface ModelUsage {
  model: string;
  /**
   * What was said, if the runtime shares it (F11.1).
   *
   * Optional because the prompt belongs to the runtime now, and a runtime that
   * declines to hand it over still owes an accurate account of what the call
   * cost. Absent is recorded as absent rather than as empty.
   */
  prompt?: unknown;
  response?: unknown;
  inputTokens: number;
  outputTokens: number;
  /** Null when the runtime does not know; the engine estimates (F13.7). */
  costCents: number | null;
  latencyMs?: number;
}

/**
 * What the engine lends a runtime for the duration of a run.
 *
 * Deliberately four things and no more. A runtime that needed a fifth would be
 * asking for something the platform is not supposed to hand over.
 */
export interface RunServices {
  /** F13.4: resolved through the broker, which holds the credentials. */
  callTool<I, O>(name: string, input: I): Promise<O>;
  /** F5.1: journals the step, so a crash resumes rather than repeats. */
  step<T>(name: string, kind: StepKind, input: unknown, fn: (key: string) => Promise<T>): Promise<T>;
  /** F6.4, F6.7: a contained sub-task with a mandatory deadline. */
  awaitChild(
    roleSlug: string,
    input: Record<string, unknown>,
    options: { timeoutMs: number; reserveTokens?: number },
  ): Promise<Record<string, unknown>>;
  /**
   * F11.1, F13.7: every model call is traced through the adapter.
   *
   * The runtime calls the model; the engine does the accounting. It throws
   * when the budget will not cover the call, which is how a runtime learns it
   * has run out -- there is no other channel, and there should not be.
   */
  reportUsage(usage: ModelUsage): Promise<void>;
  signal: AbortSignal;
}

/**
 * What a runtime says while it works (§7.5).
 *
 * The wire vocabulary for an out-of-process runtime. The in-process one has no
 * use for it -- it calls the services directly -- but everything reached over a
 * pipe or a socket speaks this, and having one vocabulary is what makes an
 * adapter for a runtime nobody has written yet a matter of translation rather
 * than of design.
 *
 * `tool_call` is the only event that asks for something back. The engine
 * resolves it through the broker and answers with a `tool_result`; the runtime
 * never sees an endpoint or a credential, only a name, arguments and an answer.
 */
export type RunEvent =
  | { type: 'tool_call'; id: string; name: string; args: unknown; idemKey?: string }
  | { type: 'text'; text: string }
  /** F13.7: the runtime's own account of what a model call cost. */
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done'; output: Record<string, unknown> }
  | { type: 'error'; message: string; retryable?: boolean; providerFailure?: boolean };

/** What the engine says back. */
export type EngineMessage =
  | { type: 'tool_result'; id: string; output: unknown }
  | { type: 'tool_error'; id: string; code: string; message: string }
  | { type: 'cancel'; reason: string };

export interface AdapterHealth {
  ok: boolean;
  detail?: string;
}

export interface AdapterResult {
  output: Record<string, unknown>;
}

/**
 * One runtime.
 *
 * `health` exists for F13.8: a runtime that fails it receives no checkout.
 * Asking after the fact would mean discovering an unreachable runtime by
 * handing it a task and watching the task fail.
 */
export interface Adapter {
  readonly name: string;
  readonly backends: readonly ExecutionBackend[];
  health(): Promise<AdapterHealth>;
  run(request: RunRequest, services: RunServices): Promise<AdapterResult>;
}

/**
 * The adapters this deployment can employ.
 *
 * A role names its runtime by string, so an unknown name has to fail loudly:
 * silently falling back to whatever is registered would run a role on a
 * runtime nobody chose for it, which is how a role calibrated for one model
 * ends up on another.
 */
export class AdapterRegistry {
  readonly #adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    this.#adapters.set(adapter.name, adapter);
  }

  get(name: string): Adapter | undefined {
    return this.#adapters.get(name);
  }

  names(): string[] {
    return [...this.#adapters.keys()];
  }

  async health(): Promise<Record<string, AdapterHealth>> {
    const out: Record<string, AdapterHealth> = {};
    for (const [name, adapter] of this.#adapters) {
      try {
        out[name] = await adapter.health();
      } catch (error) {
        // A health check that throws has failed. Reading the throw as "we do
        // not know" would let an unreachable runtime keep receiving work.
        out[name] = { ok: false, detail: `health check threw: ${(error as Error).message}` };
      }
    }
    return out;
  }
}
