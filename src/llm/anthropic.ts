/**
 * The model client a deployment runs on (F13.1, F13.6, F11.1).
 *
 * Until this file the repository had one `LlmClient`, the test double, and
 * `npm start` passed none: the in-process runtime was never registered, so a
 * fresh installation halted every task with `runtime_unavailable`, and
 * drafting, distillation and skill screening were all switched off. Every
 * claim that a company "runs itself" rested on the owner bringing an agent
 * CLI and wiring it up by hand.
 *
 * Anthropic's Messages API over `fetch`, with no SDK: the request is one POST
 * and the answer one JSON document, and a dependency for that would be a
 * dependency without a reason (AGENTS.md). The base URL is configurable, so a
 * deployment can point it at a gateway that speaks the same API.
 *
 * **A role names a tier, not a model.** The standard template's roles say
 * `fast`, `standard` or `deep`, and F13.6 puts resolving that on the adapter.
 * The defaults are the current models; `PALUGADA_MODEL_ALIASES` replaces any
 * of them, and a name that is not an alias is passed on as it is.
 *
 * **What it costs is priced here, from the deployment's price list.** The API
 * reports tokens and no price, so the client prices each call with the same
 * table the engine uses for agent CLIs -- including its deliberately high
 * fallback -- and says which model it actually called, so a trace records the
 * model that was billed rather than the tier that was asked for.
 */
import { DEFAULT_PRICE_TABLE, estimateCents, type PriceTable } from '../engine/pricing.ts';
import { defaultRetryDelay, postModel, type RetryDelay } from './transport.ts';
import type {
  LlmBlock, LlmRequest, LlmResponse, LlmTurn, LlmTurnRequest, ToolUsingLlmClient,
} from './client.ts';

/** The tiers the standard template's roles name, and what each means today. */
export const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  fast: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  deep: 'claude-opus-5-5',
};

const API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 8_192;

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  aliases?: Readonly<Record<string, string>>;
  prices?: PriceTable;
  fetch?: typeof fetch;
  /** Overridable so a test of the retry does not wait for real seconds. */
  retryDelayMs?: RetryDelay;
}

interface WireBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface WireMessage {
  content?: WireBlock[];
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class AnthropicClient implements ToolUsingLlmClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #aliases: Readonly<Record<string, string>>;
  readonly #prices: PriceTable;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: RetryDelay;

  constructor(options: AnthropicClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#aliases = options.aliases ?? DEFAULT_MODEL_ALIASES;
    this.#prices = options.prices ?? DEFAULT_PRICE_TABLE;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelayMs = options.retryDelayMs ?? defaultRetryDelay;
  }

  /** The model a role's word stands for. */
  resolve(model: string): string {
    return this.#aliases[model] ?? model;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const turn = await this.turn({ ...request, tools: [] }, signal);
    return {
      content: turn.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costCents: turn.costCents,
      ...(turn.model === undefined ? {} : { model: turn.model }),
    };
  }

  async turn(request: LlmTurnRequest, signal?: AbortSignal): Promise<LlmTurn> {
    const model = this.resolve(request.model);
    const body = JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      // One block, marked for the provider's prompt cache: the system prompt
      // is the charter and the pack, identical on every turn of a run, and a
      // run of twenty turns would otherwise be billed for it twenty times.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: request.messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : message.content.map(toWire),
      })),
      ...(request.tools.length > 0
        ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
        : {}),
    });

    const answer = await postModel({
      url: `${this.#baseUrl}/v1/messages`,
      headers: { 'x-api-key': this.#apiKey, 'anthropic-version': API_VERSION },
      body,
      model,
      keySetting: 'PALUGADA_MODEL_KEY_REF',
      signal,
      fetch: this.#fetch,
      retryDelayMs: this.#retryDelayMs,
    });
    return this.#read(model, answer as WireMessage);
  }

  #read(model: string, message: WireMessage): LlmTurn {
    const content: LlmBlock[] = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
      }
      // Anything else -- a kind of block this client does not ask for -- is
      // not echoed back, because the next turn would send it to the provider
      // as though this client had understood it.
    }
    const usage = message.usage ?? {};
    // Cached input is billed below the full rate; counted at the full rate
    // here, because an estimate that errs should err towards the budget.
    const inputTokens = (usage.input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0);
    const outputTokens = usage.output_tokens ?? 0;
    const billed = message.model ?? model;
    return {
      content,
      stopReason: message.stop_reason === 'tool_use' ? 'tool_use'
        : message.stop_reason === 'max_tokens' ? 'max_tokens'
          : message.stop_reason === 'refusal' ? 'refusal'
            : 'end_turn',
      inputTokens,
      outputTokens,
      costCents: estimateCents(this.#prices, billed, inputTokens, outputTokens).cents,
      model: billed,
    };
  }
}

function toWire(block: LlmBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}
