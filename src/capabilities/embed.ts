/**
 * Meaning: text as vectors, from the provider the owner chooses in the
 * console (This deployment, Tools), so the company's documents are found by
 * what they mean and not only by the words they share with a question.
 *
 * A role asking "what is our refund policy" found nothing in a document that
 * says "returns and money back": the search matched words, and pgvector sat
 * installed and unused. With a provider chosen, every passage is given a
 * vector in the background (`embedBacklog`), and a search ranks passages by
 * both, words and meaning together. Without one, search is by words, as
 * before: a deployment with no provider still has a knowledge base.
 *
 * Every provider here takes OpenAI's `/embeddings` request -- `model` and a
 * list of `input` -- and answers `data[].embedding`, as each one's reference
 * says (checked in September 2026). None was called with a live key.
 */
import { PalugadaError } from '../errors.ts';
import type { ToolKeyUse } from './search.ts';

export interface EmbedProvider {
  id: string;
  name: string;
  about?: string;
  key: ToolKeyUse;
  keyUrl?: string;
  /** Where the provider's `/embeddings` is; null for one on the owner's own server, at `urlExample`. */
  base: string | null;
  urlExample?: string;
  defaultModel: string;
}

export const EMBED_PROVIDERS: readonly EmbedProvider[] = [
  {
    id: 'openai', name: 'OpenAI', key: 'required', keyUrl: 'https://platform.openai.com/api-keys',
    base: 'https://api.openai.com/v1', defaultModel: 'text-embedding-3-small',
  },
  {
    id: 'gemini', name: 'Google Gemini', key: 'required', keyUrl: 'https://aistudio.google.com/apikey',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-embedding-001',
  },
  {
    id: 'mistral', name: 'Mistral', key: 'required', keyUrl: 'https://console.mistral.ai/api-keys',
    base: 'https://api.mistral.ai/v1', defaultModel: 'mistral-embed',
  },
  {
    id: 'voyage', name: 'Voyage AI', key: 'required', keyUrl: 'https://dashboard.voyageai.com/api-keys',
    base: 'https://api.voyageai.com/v1', defaultModel: 'voyage-3.5',
  },
  {
    id: 'jina', name: 'Jina AI', key: 'required', keyUrl: 'https://jina.ai/api-dashboard/',
    base: 'https://api.jina.ai/v1', defaultModel: 'jina-embeddings-v3',
  },
  {
    id: 'ollama', name: 'Ollama', key: 'none', base: null, urlExample: 'http://localhost:11434/v1',
    defaultModel: 'nomic-embed-text',
  },
  {
    id: 'openai-compatible', name: 'Another OpenAI-compatible server', key: 'optional', base: null,
    urlExample: 'http://localhost:8000/v1', defaultModel: 'bge-m3',
  },
];

export function embedProvider(id: string): EmbedProvider | undefined {
  return EMBED_PROVIDERS.find((one) => one.id === id);
}

export interface EmbedBinding {
  provider: EmbedProvider;
  url: string | null;
  model: string | null;
  key: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** What one call may carry: a provider's batch limit is in the hundreds, and a worker's tick should stay short. */
export const EMBED_BATCH = 64;

/** The model a binding embeds with, which is what a vector is kept against. */
export function embedModel(binding: EmbedBinding): string {
  return `${binding.provider.id}:${binding.model ?? binding.provider.defaultModel}`;
}

/**
 * One vector for each text, in the order given. A vector of another length
 * than the first, or an answer without one, is refused rather than kept: a
 * search over vectors of mixed lengths is an error, and one over wrong
 * vectors is confident nonsense.
 */
export async function embed(binding: EmbedBinding, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > EMBED_BATCH) {
    throw new PalugadaError('contract.violation', `at most ${EMBED_BATCH} texts are embedded at once`, { count: texts.length });
  }
  const base = (binding.url ?? binding.provider.base ?? '').replace(/\/+$/, '');
  const key = await binding.key();
  const timeout = AbortSignal.timeout(binding.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await (binding.fetch ?? fetch)(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'user-agent': 'PALUGADA/1.0 (+orchestrator)',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model: binding.model ?? binding.provider.defaultModel, input: texts }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (failure) {
    throw new PalugadaError('capability.unreachable', `${binding.provider.name} could not be reached: ${(failure as Error).message}`, {});
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    const refused = response.status === 401 || response.status === 403;
    throw new PalugadaError(refused ? 'credential.unavailable' : 'capability.unreachable',
      refused
        ? `${binding.provider.name} refused the key (${response.status}): set it again in the console, under This deployment, Tools`
        : `${binding.provider.name} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      { status: response.status });
  }
  const answer = (await response.json().catch(() => null)) as { data?: Array<{ embedding?: unknown; index?: unknown }> } | null;
  const data = [...(answer?.data ?? [])].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const vectors = data.map((one) => one.embedding);
  const length = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  if (vectors.length !== texts.length || length === 0
    || !vectors.every((one) => Array.isArray(one) && one.length === length && one.every((x) => typeof x === 'number' && Number.isFinite(x)))) {
    throw new PalugadaError('capability.unreachable', `${binding.provider.name} answered without a vector for each text`, {});
  }
  return vectors as number[][];
}
