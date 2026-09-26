/**
 * Whether a model answers, and calls a tool when it is offered one.
 *
 * One request, which proves the key, the address and the model's name at
 * once, and whether the model can do a role's work at all: a model that does
 * not call tools can only answer in words. Asked by `npm run setup` and by
 * the console before a model is saved, so a wrong key is found by the person
 * typing it rather than by the first task.
 */
import { DEFAULT_MODEL_URLS, modelClientFrom } from './models.ts';
import { DEFAULT_PRICE_TABLE } from '../engine/pricing.ts';
import type { SecretManager } from '../secrets/manager.ts';

export interface ModelCheck {
  /** Why it did not answer; null when it did. */
  problem: string | null;
  /** It answered but did not call the tool it was offered. */
  warning: string | null;
}

export async function checkModel(env: NodeJS.ProcessEnv, secrets: SecretManager): Promise<ModelCheck> {
  try {
    const client = await modelClientFrom(env, secrets, DEFAULT_PRICE_TABLE);
    if (!client) return { problem: 'no model is configured', warning: null };
    const turn = await client.turn({
      model: 'standard',
      system: 'You are checking a connection. Call the ping tool once, with no arguments.',
      messages: [{ role: 'user', content: 'Call ping.' }],
      tools: [{ name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } }],
      maxTokens: 256,
    }, AbortSignal.timeout(90_000));
    return turn.content.some((block) => block.type === 'tool_use')
      ? { problem: null, warning: null }
      : {
        problem: null,
        warning: 'It answered, but did not call the tool it was offered. A role on it can only answer in words, '
          + 'not act: choose a model that supports tool calling (function calling).',
      };
  } catch (failure) {
    return { problem: (failure as Error).message, warning: null };
  }
}

/** The model names an API serves, for the owner to choose from rather than type. */
export interface ModelList {
  models: string[];
  /** Why they could not be listed; the owner can still type a name. */
  problem: string | null;
}

const LIST_TIMEOUT_MS = 20_000;
/** A router lists hundreds; past this many, the owner types the name. */
const LIST_LIMIT = 2_000;

/**
 * Asks the API which models it serves: `GET /models` on an OpenAI-compatible
 * API, `GET /v1/models` on Anthropic's. Both answer `{data: [{id}]}`. Only
 * the provider, the address and the key are needed, so it can be asked
 * before any tier is named.
 */
export async function listModels(env: NodeJS.ProcessEnv, secrets: SecretManager): Promise<ModelList> {
  const provider = env.PALUGADA_MODEL_PROVIDER === 'openai' ? 'openai' : 'anthropic';
  const base = (env.PALUGADA_MODEL_URL ?? DEFAULT_MODEL_URLS[provider]).replace(/\/+$/, '');
  let key: string | null = null;
  try {
    key = env.PALUGADA_MODEL_KEY_REF ? await secrets.resolve(env.PALUGADA_MODEL_KEY_REF) : null;
  } catch (failure) {
    return { models: [], problem: (failure as Error).message };
  }
  const url = provider === 'anthropic' ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> = provider === 'anthropic'
    ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key ? { authorization: `Bearer ${key}` } : {};
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      return {
        models: [],
        problem: response.status === 401 || response.status === 403
          ? `${url} refused the key (${response.status})`
          : `${url} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      };
    }
    const answer = await response.json() as { data?: unknown; models?: unknown };
    // `data` is the OpenAI and Anthropic shape; `models` is Ollama's own.
    const rows = Array.isArray(answer.data) ? answer.data : Array.isArray(answer.models) ? answer.models : null;
    if (!rows) return { models: [], problem: `${url} did not answer with a list of models` };
    const names = rows
      .map((row) => (row && typeof row === 'object' ? (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name : null))
      .filter((name): name is string => typeof name === 'string' && name !== '');
    return { models: [...new Set(names)].sort().slice(0, LIST_LIMIT), problem: null };
  } catch (failure) {
    return { models: [], problem: `${url} could not be reached: ${(failure as Error).message}` };
  }
}
