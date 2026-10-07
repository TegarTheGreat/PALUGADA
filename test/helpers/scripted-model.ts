/**
 * A model the test writes the lines of, which records what it was asked.
 *
 * The loop's own tests (model-runtime.test.ts) hold their own copy; this is
 * the one for the tests written after it. A line is a reply, or a function of
 * the request that makes one -- which is how a test makes a model answer the
 * contract it was given, or throw what a provider throws.
 */
import type { LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';

export type Line = Pick<LlmTurn, 'content' | 'stopReason'>;
export type ModelLine = Line | ((request: LlmTurnRequest) => Line);

export interface ModelOptions {
  /** What each turn costs, in cents; a fraction is a provider that bills one. */
  costCents?: number;
}

export class ScriptedModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  readonly #script: Array<(request: LlmTurnRequest) => Line>;
  readonly #costCents: number;

  constructor(script: ModelLine[], options: ModelOptions = {}) {
    this.#script = script.map((line) => (typeof line === 'function' ? line : () => line));
    this.#costCents = options.costCents ?? 1;
  }

  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    // A copy: the loop goes on appending to the same conversation.
    this.requests.push(structuredClone(request));
    const line = this.#script[this.requests.length - 1];
    if (!line) throw new Error(`the script has no line ${this.requests.length}`);
    return { ...line(request), inputTokens: 1_000, outputTokens: 100, costCents: this.#costCents, model: 'scripted-1' };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

export const say = (text: string): Line => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
export const use = (id: string, name: string, input: unknown): Line =>
  ({ content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id, name, input }], stopReason: 'tool_use' });

/**
 * A model that answers by looking at what it was asked, for the tests whose
 * subject is what the loop does when the answer depends on the request: a
 * window it cannot read past, a summary it is asked to write. Records every
 * request, as `ScriptedModel` does.
 */
export class RespondingModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  readonly #answer: (request: LlmTurnRequest, asked: number) => Line;

  constructor(answer: (request: LlmTurnRequest, asked: number) => Line) {
    this.#answer = answer;
  }

  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    return { ...this.#answer(request, this.requests.length), inputTokens: 1_000, outputTokens: 100, costCents: 1, model: 'scripted-1' };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}
