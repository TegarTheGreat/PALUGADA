/**
 * Every other model: the OpenAI-compatible Chat Completions API (F13.6).
 *
 * One wire format reaches most of what a company would choose: OpenAI's own
 * models, and every provider and server that speaks the same API -- OpenRouter
 * (which fronts hundreds of models from every lab), Groq, Together, DeepSeek,
 * Mistral, Google's Gemini through its OpenAI-compatible endpoint, and the
 * servers a company runs itself: Ollama, vLLM, LM Studio, llama.cpp. A key is
 * optional, because a model on the company's own machine has none.
 *
 * Tools are offered as functions and come back as `tool_calls`; their answers
 * go back as `tool` messages. The platform's own loop sees the same blocks
 * whichever client it is given, so a role behaves the same on any model --
 * which is the point of naming a tier rather than a model.
 */
import { DEFAULT_PRICE_TABLE, estimateCents, type PriceTable } from '../engine/pricing.ts';
import { defaultRetryDelay, postModel, type RetryDelay } from './transport.ts';
import type {
  LlmBlock, LlmRequest, LlmResponse, LlmTurn, LlmTurnRequest, ToolUsingLlmClient,
} from './client.ts';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 8_192;

export interface OpenAiCompatibleOptions {
  /** Null for a server that takes none, as a model on the company's own machine does. */
  apiKey: string | null;
  /** Up to and including the version segment: `https://api.openai.com/v1`, `http://localhost:11434/v1`. */
  baseUrl?: string;
  aliases: Readonly<Record<string, string>>;
  prices?: PriceTable;
  fetch?: typeof fetch;
  retryDelayMs?: RetryDelay;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: WireToolCall[]; refusal?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleClient implements ToolUsingLlmClient {
  readonly #apiKey: string | null;
  readonly #baseUrl: string;
  readonly #aliases: Readonly<Record<string, string>>;
  readonly #prices: PriceTable;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: RetryDelay;

  constructor(options: OpenAiCompatibleOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#aliases = options.aliases;
    this.#prices = options.prices ?? DEFAULT_PRICE_TABLE;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelayMs = options.retryDelayMs ?? defaultRetryDelay;
  }

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
    const messages: Array<Record<string, unknown>> = [{ role: 'system', content: request.system }];
    for (const message of request.messages) messages.push(...toWire(message));
    // OpenAI's own API refuses `max_tokens` for its reasoning models and takes
    // `max_completion_tokens` for all of them; most compatible servers know
    // only the older name. Each is sent where it is understood.
    const limit = new URL(this.#baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
    const answer = (await postModel({
      url: `${this.#baseUrl}/chat/completions`,
      headers: this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {},
      body: JSON.stringify({
        model,
        messages,
        [limit]: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(request.tools.length > 0
          ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
          }
          : {}),
      }),
      model,
      keySetting: 'PALUGADA_MODEL_KEY_REF',
      signal,
      fetch: this.#fetch,
      retryDelayMs: this.#retryDelayMs,
    })) as WireCompletion;
    return this.#read(model, answer);
  }

  #read(model: string, answer: WireCompletion): LlmTurn {
    const choice = answer.choices?.[0];
    const message = choice?.message ?? {};
    const content: LlmBlock[] = [];
    const said = message.content ?? message.refusal ?? '';
    if (said) content.push({ type: 'text', text: said });
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      if (!call.function?.name) continue;
      content.push({
        type: 'tool_use',
        // A server that gives no id still has to have its answer matched to
        // the call; the position is stable for the length of one turn.
        id: call.id ?? `call_${index}`,
        name: call.function.name,
        input: argumentsOf(call.function.arguments),
      });
    }
    const usedTools = content.some((block) => block.type === 'tool_use');
    const inputTokens = answer.usage?.prompt_tokens ?? 0;
    const outputTokens = answer.usage?.completion_tokens ?? 0;
    const billed = answer.model ?? model;
    return {
      content,
      stopReason: usedTools || choice?.finish_reason === 'tool_calls' ? 'tool_use'
        : choice?.finish_reason === 'length' ? 'max_tokens'
          : choice?.finish_reason === 'content_filter' || (message.refusal && !message.content) ? 'refusal'
            : 'end_turn',
      inputTokens,
      outputTokens,
      costCents: estimateCents(this.#prices, billed, inputTokens, outputTokens).cents,
      model: billed,
    };
  }
}

/**
 * A model's arguments, which arrive as a string of JSON. One that does not
 * parse is passed on as it came, under a name no schema accepts, so the
 * broker refuses the call and the model is told what was wrong rather than
 * the tool being called with nothing.
 */
function argumentsOf(raw: string | undefined): unknown {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { unparsedArguments: raw };
  } catch {
    return { unparsedArguments: raw };
  }
}

/** One of the loop's messages, as Chat Completions messages: tool answers are messages of their own. */
function toWire(message: LlmTurnRequest['messages'][number]): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
  if (message.role === 'assistant') {
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const calls = message.content.flatMap((block) => (block.type === 'tool_use'
      ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
      : []));
    return [{ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
  }
  const wire: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      wire.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.isError ? `Error: ${block.content}` : block.content });
    } else if (block.type === 'text') {
      wire.push({ role: 'user', content: block.text });
    }
  }
  return wire;
}
