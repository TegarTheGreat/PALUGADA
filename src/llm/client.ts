/**
 * Model access.
 *
 * An interface, a deterministic fake for the tests, and one real client
 * (`anthropic.ts`). Section 12 asks for per-role model abstraction so a
 * provider outage does not take the platform with it, which is why a role
 * names a tier rather than a model and a client resolves it: another provider
 * is another implementation of this interface, not a change to anything that
 * calls it. Every call is traced (F11.1) regardless of provider.
 */
export interface LlmRequest {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}

export interface LlmResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /**
   * The model that answered, when the client knows it. A role asks for a
   * tier (`standard`); what is billed and traced is the model that tier
   * resolved to.
   */
  model?: string;
}

export interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

/** A tool as a model is shown it: a name the provider accepts, and a schema. */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One piece of a turn: what was said, a tool asked for, or a tool's answer. */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmTurnRequest {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | LlmBlock[] }>;
  tools: LlmTool[];
  maxTokens?: number;
}

export interface LlmTurn {
  content: LlmBlock[];
  /** Why the model stopped: to use a tool, because it was done, or because it ran out of room. */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  model?: string;
}

/**
 * A client that can let a model use tools (F13.1).
 *
 * What the in-process runtime needs to run a role that has no handler of its
 * own: the model asks for a tool, the broker answers, and the model carries
 * on. The platform's drafting and distillation use only `complete`.
 */
export interface ToolUsingLlmClient extends LlmClient {
  turn(request: LlmTurnRequest, signal?: AbortSignal): Promise<LlmTurn>;
}

export function usesTools(client: LlmClient): client is ToolUsingLlmClient {
  return typeof (client as Partial<ToolUsingLlmClient>).turn === 'function';
}

/**
 * Test double that records every call.
 *
 * The call counter is what makes F5.1 checkable: after a crash and restart, a
 * resumed task must not have re-issued the calls it already completed, and
 * counting them is the only way to prove replay rather than assume it.
 */
export class RecordingLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  #responder: (request: LlmRequest, index: number) => string;

  constructor(responder: (request: LlmRequest, index: number) => string = (_r, i) => `response-${i}`) {
    this.#responder = responder;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const index = this.calls.length;
    this.calls.push(request);
    const content = this.#responder(request, index);
    return {
      content,
      inputTokens: 100,
      outputTokens: 50,
      costCents: 1,
    };
  }

  get callCount(): number {
    return this.calls.length;
  }
}
