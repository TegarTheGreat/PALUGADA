/**
 * Seeing: what a picture shows, from the vision model the owner chooses in
 * the console (This deployment, Tools) -- `image.describe`, the tools
 * research's fifth recommendation.
 *
 * A role reads a picture in the company's files -- a receipt a customer
 * photographed, a screenshot, a product photo, a scanned page -- as it reads
 * a recording through Listening. Every word and number in it is the useful
 * part for a business, so that is what a model is asked for when the role
 * asks nothing in particular.
 *
 * Each provider is the request its own reference describes, checked in
 * October 2026: OpenAI's chat completions with an `image_url` part, which
 * OpenRouter and Groq take as they are and Mistral takes with the address as
 * a string; Gemini's `inline_data`; Anthropic's base64 `image` block. A
 * server of the owner's own -- Ollama, llama.cpp, vLLM -- speaks OpenAI's.
 * The picture goes as a `data:` address inside the request, so no provider
 * is ever handed a link to fetch.
 */
import { withTenant } from '../db/tenant.ts';
import { carryFor, costOf, type PriceTable } from '../engine/pricing.ts';
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';
import { readCompanyFile } from './files.ts';
import type { ToolKeyUse } from './search.ts';

/** A picture: its bytes and what kind it is. */
export interface Picture {
  bytes: Buffer;
  mime: string;
}

export interface VisionProvider {
  id: string;
  name: string;
  about?: string;
  key: ToolKeyUse;
  keyUrl?: string;
  urlExample?: string;
  defaultModel: string;
  reserveCents: number;
  request(picture: Picture, question: string, key: string | null, model: string, base: string | null): { url: string; headers: Record<string, string>; body: unknown };
  /** What the model said, from its answer. */
  text(answer: unknown): unknown;
  /**
   * What the call used, from its answer, as the provider bills it; null when
   * the answer does not say, and then the call is charged what was reserved.
   */
  usage(answer: unknown): { input: number; output: number } | null;
}

/** The most a picture may be: Anthropic's limit for one, and more than a receipt needs. */
const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
/** How long an answer may be. */
const ANSWER_TOKENS = 1_500;

/** What a role reading a business's picture needs, when it asks nothing in particular. */
export const DEFAULT_QUESTION = 'Describe what this picture shows. Copy every word and number in it exactly, keeping how they are laid out '
  + '(a receipt\'s lines, a table\'s rows), and say what kind of document or scene it is.';

const json = { 'content-type': 'application/json' };
const bearer = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});
const dataUrl = (picture: Picture) => `data:${picture.mime};base64,${picture.bytes.toString('base64')}`;

function at(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) current = current && typeof current === 'object' ? (current as Record<string | number, unknown>)[part] : undefined;
  return current;
}

/** OpenAI's chat completions with a picture, which OpenRouter, Groq and a server of one's own take too. */
function chat(url: string, picture: Picture, question: string, key: string | null, model: string, imageAsString = false) {
  return {
    url,
    headers: { ...json, ...bearer(key) },
    body: {
      model,
      max_tokens: ANSWER_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: imageAsString ? dataUrl(picture) : { url: dataUrl(picture) } },
        ],
      }],
    },
  };
}
const chatText = (answer: unknown) => at(answer, ['choices', 0, 'message', 'content']);

/** Two counts of tokens, when both are there and are counts. */
function counted(input: unknown, output: unknown): { input: number; output: number } | null {
  const whole = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return whole(input) && whole(output) ? { input: input as number, output: output as number } : null;
}
/** OpenAI's `usage`, which the others that speak its chat completions answer with too. */
const chatUsage = (answer: unknown) => counted(at(answer, ['usage', 'prompt_tokens']), at(answer, ['usage', 'completion_tokens']));

export const VISION_PROVIDERS: readonly VisionProvider[] = [
  {
    id: 'openai', name: 'OpenAI', about: 'GPT, reads most scripts and handwriting', key: 'required', keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4.1-mini', reserveCents: 1,
    request: (picture, question, key, model) => chat('https://api.openai.com/v1/chat/completions', picture, question, key, model),
    text: chatText,
    usage: chatUsage,
  },
  {
    id: 'gemini', name: 'Google Gemini', about: 'A generous free tier', key: 'required', keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash', reserveCents: 1,
    request: (picture, question, key, model) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { ...json, 'x-goog-api-key': key ?? '' },
      body: {
        contents: [{ parts: [{ inline_data: { mime_type: picture.mime, data: picture.bytes.toString('base64') } }, { text: question }] }],
        generationConfig: { maxOutputTokens: ANSWER_TOKENS },
      },
    }),
    text: (answer) => {
      const parts = at(answer, ['candidates', 0, 'content', 'parts']);
      return Array.isArray(parts) ? parts.map((part) => (part as { text?: unknown }).text).filter((text) => typeof text === 'string').join('') : undefined;
    },
    // A thinking model's thoughts are billed as what it wrote.
    usage: (answer) => {
      const thoughts = at(answer, ['usageMetadata', 'thoughtsTokenCount']);
      const written = at(answer, ['usageMetadata', 'candidatesTokenCount']);
      return counted(at(answer, ['usageMetadata', 'promptTokenCount']),
        typeof written === 'number' ? written + (typeof thoughts === 'number' ? thoughts : 0) : written);
    },
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', about: 'Careful with documents and tables', key: 'required', keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-haiku-4-5-20251001', reserveCents: 1,
    request: (picture, question, key, model) => ({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { ...json, 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
      body: {
        model,
        max_tokens: ANSWER_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: picture.mime, data: picture.bytes.toString('base64') } },
            { type: 'text', text: question },
          ],
        }],
      },
    }),
    text: (answer) => {
      const blocks = at(answer, ['content']);
      return Array.isArray(blocks) ? blocks.filter((block) => (block as { type?: unknown }).type === 'text').map((block) => (block as { text: string }).text).join('') : undefined;
    },
    usage: (answer) => counted(at(answer, ['usage', 'input_tokens']), at(answer, ['usage', 'output_tokens'])),
  },
  {
    id: 'openrouter', name: 'OpenRouter', about: 'Vision models from several labs, one key', key: 'required', keyUrl: 'https://openrouter.ai/settings/keys',
    defaultModel: 'google/gemini-3.8-flash', reserveCents: 1,
    request: (picture, question, key, model) => chat('https://openrouter.ai/api/v1/chat/completions', picture, question, key, model),
    text: chatText,
    usage: chatUsage,
  },
  {
    id: 'groq', name: 'Groq', about: 'Llama 4, very fast and cheap', key: 'required', keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'meta-llama/llama-4-scout-17b-16e-instruct', reserveCents: 1,
    request: (picture, question, key, model) => chat('https://api.groq.com/openai/v1/chat/completions', picture, question, key, model),
    text: chatText,
    usage: chatUsage,
  },
  {
    id: 'mistral', name: 'Mistral', about: 'Mistral Small, reads documents well', key: 'required', keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-small-latest', reserveCents: 1,
    // Mistral's reference gives the picture's address as a string, not an object.
    request: (picture, question, key, model) => chat('https://api.mistral.ai/v1/chat/completions', picture, question, key, model, true),
    text: chatText,
    usage: chatUsage,
  },
  {
    id: 'openai-compatible', name: 'A vision model of your own', about: 'Ollama, llama.cpp or vLLM, OpenAI-compatible', key: 'optional',
    urlExample: 'http://localhost:11434/v1', defaultModel: 'qwen2.5vl', reserveCents: 0,
    request: (picture, question, key, model, base) => chat(`${(base ?? '').replace(/\/+$/, '')}/chat/completions`, picture, question, key, model),
    text: chatText,
    usage: chatUsage,
  },
];

export function visionProvider(id: string): VisionProvider | undefined {
  return VISION_PROVIDERS.find((one) => one.id === id);
}

export interface VisionBinding {
  provider: VisionProvider;
  url: string | null;
  model: string | null;
  key: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /**
   * The deployment's price list (the one that prices the model calls), by
   * which what a call used is charged. Without it, a call is charged what
   * was reserved for it.
   */
  prices?: PriceTable;
}

/** What kind of picture the bytes are, by what they begin with; null for anything else. */
export function pictureKind(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

/** What the model says the picture shows, answering the question. */
export async function describePicture(binding: VisionBinding, picture: Picture, question: string, signal?: AbortSignal): Promise<string> {
  return (await lookAt(binding, picture, question, signal)).text;
}

/** What the model says, which model said it, and what the call used, as the provider says. */
async function lookAt(binding: VisionBinding, picture: Picture, question: string, signal?: AbortSignal): Promise<{
  text: string; model: string; usage: { input: number; output: number } | null;
}> {
  const model = binding.model ?? binding.provider.defaultModel;
  const call = binding.provider.request(picture, question, await binding.key(), model, binding.url);
  const timeout = AbortSignal.timeout(binding.timeoutMs ?? 60_000);
  let response: Response;
  try {
    response = await (binding.fetch ?? fetch)(call.url, {
      method: 'POST',
      headers: { 'user-agent': 'PALUGADA/1.0 (+orchestrator)', ...call.headers },
      body: JSON.stringify(call.body),
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
  const answer: unknown = await response.json();
  const said = binding.provider.text(answer);
  if (typeof said !== 'string' || !said.trim()) throw new PalugadaError('capability.unreachable', `${binding.provider.name} answered without saying anything`, {});
  return { text: said.trim(), model, usage: binding.provider.usage(answer) };
}

/**
 * `image.describe` -- what a picture in the company's files shows.
 *
 * A read (tier 0): it changes nothing. What a picture says came from
 * whoever made it, so it is outside content (F8.9), like a page or a
 * recording. The file is read as `files.read` reads one, and nothing is
 * sent for a path that leads outside the company's files or a file that is
 * not a picture.
 */
export function imageDescribe(binding: VisionBinding & { root: string }): Capability<{ path: string; question?: string }, { path: string; provider: string; text: string }> {
  // What each call used, from its execution to its settlement, by its key: the
  // broker asks what a call cost after it answered, and the answer carries
  // only what the role reads.
  const used = new Map<string, { model: string; usage: { input: number; output: number } }>();
  return {
    name: 'image.describe',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_000, description: 'The picture, under the company\'s files, as files.list names it: a PNG, JPEG, WebP or GIF.' },
        question: { type: 'string', minLength: 1, maxLength: 1_000, description: 'What to find out from it, in any language. Without one, everything it shows is described and its words copied.' },
      },
      additionalProperties: false,
    },
    adapter: `vision:${binding.provider.id}`,
    defaultTier: 0,
    readsOutside: true,
    // A model call is paid for: what is reserved before it is the provider's
    // figure. Once a `describe` that said nothing ($0) stood in front of it,
    // and every picture described was charged nothing.
    estimatedCostCents: binding.provider.reserveCents,
    async execute(input, ctx) {
      const file = await readCompanyFile(binding.root, ctx.companyId, input.path, PICTURE_MAX_BYTES, 'image.describe sends pictures up to 5 MB');
      const mime = pictureKind(file.bytes);
      if (!mime) throw new PalugadaError('contract.violation', `${file.path} is not a picture: a PNG, JPEG, WebP or GIF is`, { path: file.path });
      const question = typeof input.question === 'string' && input.question.trim() ? input.question.trim() : DEFAULT_QUESTION;
      const looked = await lookAt(binding, { bytes: file.bytes, mime }, question, ctx.signal);
      if (looked.usage) used.set(ctx.idempotencyKey, { model: looked.model, usage: looked.usage });
      return { path: file.path, provider: binding.provider.name, text: looked.text };
    },
    // What the provider says it used, at the model's price, in whole cents as
    // they fall due (`CostCarry`): the rest of a cent is the next call's.
    // Null -- the reservation stands -- with no price list or no usage said.
    async actualCostCents(_input, _output, ctx) {
      const call = used.get(ctx.idempotencyKey);
      used.delete(ctx.idempotencyKey);
      if (!call || !binding.prices) return null;
      // Carried for the account the look is settled to, the task's own, as a
      // run's calls are: one carry for the company made one division's
      // fraction another's cent.
      const { rows } = await withTenant(ctx.companyId, (tx) => tx.query<{ budget_account_id: string }>(
        'SELECT budget_account_id FROM tasks WHERE id = $1', [ctx.taskId]));
      return carryFor(rows[0]?.budget_account_id ?? ctx.companyId).charge(costOf(binding.prices, call.model, call.usage).cents);
    },
  };
}
