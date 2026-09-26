/**
 * Which model the platform runs on, from the deployment's environment.
 *
 * Two wire formats cover almost every model a company would choose:
 * Anthropic's Messages API (`anthropic.ts`) and the OpenAI-compatible Chat
 * Completions API (`openai.ts`), which OpenAI, OpenRouter, Groq, Together,
 * DeepSeek, Mistral, Gemini's compatible endpoint and every self-hosted
 * server -- Ollama, vLLM, LM Studio, llama.cpp -- speak.
 *
 *   PALUGADA_MODEL_PROVIDER   anthropic (the default when a key is set) or openai
 *   PALUGADA_MODEL_KEY_REF    the key, as a secret reference; optional for openai
 *   PALUGADA_MODEL_URL        where the API is
 *   PALUGADA_MODEL            one model for every tier
 *   PALUGADA_MODEL_ALIASES    {"fast": ..., "standard": ..., "deep": ...}
 *
 * **A role names a tier, not a model** (F13.6), and this is where a tier
 * becomes a model. Anthropic's tiers have defaults; an OpenAI-compatible
 * endpoint serves whatever it serves, so its tiers must be named -- refused at
 * boot otherwise, because a role sent to a model the server does not have
 * fails at its first task rather than at the operator's desk.
 */
import { PalugadaError } from '../errors.ts';
import { AnthropicClient, DEFAULT_MODEL_ALIASES } from './anthropic.ts';
import { OpenAiCompatibleClient } from './openai.ts';
import type { PriceTable } from '../engine/pricing.ts';
import type { SecretManager } from '../secrets/manager.ts';
import type { ToolUsingLlmClient } from './client.ts';

/** The tiers every template role names. */
export const MODEL_TIERS = ['fast', 'standard', 'deep'] as const;

export type ModelProvider = 'anthropic' | 'openai';

const refuse = (source: string, message: string): never => {
  throw new PalugadaError('config.invalid', message, { source });
};

/**
 * Reads `PALUGADA_MODEL_ALIASES`: a JSON object from a role's word to a model,
 * laid over `base`. Refused whole when it is not one, at boot: an alias table
 * that half-applied would put a role on a model nobody chose for it.
 */
export function modelAliasesFrom(
  raw: string | undefined,
  base: Readonly<Record<string, string>> = DEFAULT_MODEL_ALIASES,
): Record<string, string> {
  const aliases: Record<string, string> = { ...base };
  if (raw === undefined || raw.trim() === '') return aliases;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (failure) {
    return refuse('PALUGADA_MODEL_ALIASES', `PALUGADA_MODEL_ALIASES is not JSON: ${(failure as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('PALUGADA_MODEL_ALIASES',
      'PALUGADA_MODEL_ALIASES must be a JSON object such as {"standard":"claude-sonnet-5"}');
  }
  for (const [alias, model] of Object.entries(parsed)) {
    if (typeof model !== 'string' || model.trim() === '') {
      refuse('PALUGADA_MODEL_ALIASES', `PALUGADA_MODEL_ALIASES names no model for "${alias}"`);
    }
    aliases[alias] = (model as string).trim();
  }
  return aliases;
}

export interface ModelSettings {
  provider: ModelProvider;
  url: string;
  aliases: Record<string, string>;
}

/** What the environment asks for, checked; null when it asks for no model. */
export function modelSettingsFrom(env: NodeJS.ProcessEnv): ModelSettings | null {
  const named = env.PALUGADA_MODEL_PROVIDER?.trim().toLowerCase();
  if (named && named !== 'anthropic' && named !== 'openai') {
    refuse('PALUGADA_MODEL_PROVIDER',
      `PALUGADA_MODEL_PROVIDER ${named} is not one this platform speaks: anthropic, or openai for any `
        + 'OpenAI-compatible API (OpenAI, OpenRouter, Ollama, vLLM, LM Studio, Groq, DeepSeek, Gemini\'s compatible endpoint)');
  }
  const provider = (named as ModelProvider | undefined) ?? (env.PALUGADA_MODEL_KEY_REF ? 'anthropic' : null);
  if (!provider) return null;
  if (provider === 'anthropic' && !env.PALUGADA_MODEL_KEY_REF) {
    refuse('PALUGADA_MODEL_KEY_REF', 'the anthropic provider needs PALUGADA_MODEL_KEY_REF');
  }

  const url = env.PALUGADA_MODEL_URL ?? (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // Refused below.
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    refuse('PALUGADA_MODEL_URL', `PALUGADA_MODEL_URL ${url} is not an http(s) URL`);
  }

  const one = env.PALUGADA_MODEL?.trim();
  const base: Record<string, string> = provider === 'anthropic' ? { ...DEFAULT_MODEL_ALIASES } : {};
  if (one) for (const tier of MODEL_TIERS) base[tier] = one;
  const aliases = modelAliasesFrom(env.PALUGADA_MODEL_ALIASES, base);
  const missing = MODEL_TIERS.filter((tier) => !aliases[tier]);
  if (missing.length > 0) {
    refuse('PALUGADA_MODEL_ALIASES',
      `${url} serves the models it serves, so say which one each tier means: set PALUGADA_MODEL to one `
        + `model for every tier, or name ${missing.join(', ')} in PALUGADA_MODEL_ALIASES`);
  }
  return { provider, url, aliases };
}

/**
 * The deployment's model client; null when the environment names none.
 *
 * The key is a secret reference (`env://PALUGADA_SECRET_...` or `file://...`),
 * like every other credential: the key itself is never an environment variable
 * a child process could inherit by accident. Resolved at boot, so a reference
 * that points at nothing stops the deployment with a message rather than
 * failing every task at 3am.
 */
export async function modelClientFrom(
  env: NodeJS.ProcessEnv,
  secrets: SecretManager,
  prices: PriceTable,
): Promise<ToolUsingLlmClient | null> {
  const settings = modelSettingsFrom(env);
  if (!settings) return null;
  const reference = env.PALUGADA_MODEL_KEY_REF;
  let apiKey: string | null = null;
  if (reference) {
    try {
      apiKey = await secrets.resolve(reference);
    } catch (failure) {
      refuse('PALUGADA_MODEL_KEY_REF', `PALUGADA_MODEL_KEY_REF ${reference} could not be read: ${(failure as Error).message}`);
    }
  }
  return settings.provider === 'anthropic'
    ? new AnthropicClient({ apiKey: apiKey!, baseUrl: settings.url, aliases: settings.aliases, prices })
    : new OpenAiCompatibleClient({ apiKey, baseUrl: settings.url, aliases: settings.aliases, prices });
}
