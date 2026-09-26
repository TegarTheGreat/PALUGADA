/**
 * The model providers an owner can pick from, by name, instead of by address.
 *
 * Every entry is one of the two wire protocols the platform speaks
 * (`models.ts`): Anthropic's Messages API, or an OpenAI-compatible Chat
 * Completions API. The catalogue adds nothing to what a deployment can reach
 * -- "another OpenAI-compatible API" with an address reaches all of these --
 * it saves the owner from looking up an address and a key page, and it is the
 * one list both `npm run setup` and the console offer, so the two cannot
 * drift apart.
 *
 * An address here is the one the provider documents for its compatible API.
 * A provider that only signs requests with a cloud identity (IAM, a service
 * account) is not here: the platform sends a key, and a key is what an entry
 * promises the owner will be asked for.
 */
import type { ModelProvider } from './models.ts';

export interface ModelProviderEntry {
  /** Stable, kebab-case: kept with the owner's choice. */
  id: string;
  name: string;
  /** What it is, in a few words, beside the name. */
  about: string;
  group: 'lab' | 'router' | 'cloud' | 'local' | 'custom';
  protocol: ModelProvider;
  /** The API's address; absent when the owner types it (their own server, their own deployment). */
  url?: string;
  /** What to type when there is no fixed address. */
  urlExample?: string;
  /** Where a model on the host is found from inside a container. */
  dockerUrl?: string;
  key: 'required' | 'optional' | 'none';
  /** The provider's own page for making a key. */
  keyUrl?: string;
  /** A model it serves, shown as an example; the console lists the rest from the API. */
  example?: string;
}

export const MODEL_PROVIDERS: readonly ModelProviderEntry[] = [
  {
    id: 'anthropic', name: 'Anthropic', about: 'Claude, by tier: Haiku, Sonnet, Opus', group: 'lab',
    protocol: 'anthropic', url: 'https://api.anthropic.com', key: 'required',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai', name: 'OpenAI', about: 'GPT models, with an API key', group: 'lab',
    protocol: 'openai', url: 'https://api.openai.com/v1', key: 'required',
    keyUrl: 'https://platform.openai.com/api-keys', example: 'gpt-5-mini',
  },
  {
    id: 'google-ai-studio', name: 'Google Gemini', about: 'Gemini, through Google AI Studio', group: 'lab',
    protocol: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required',
    keyUrl: 'https://aistudio.google.com/apikey', example: 'gemini-2.5-flash',
  },
  {
    id: 'openrouter', name: 'OpenRouter', about: 'Models from every lab behind one key', group: 'router',
    protocol: 'openai', url: 'https://openrouter.ai/api/v1', key: 'required',
    keyUrl: 'https://openrouter.ai/keys', example: 'deepseek/deepseek-chat',
  },
  {
    id: 'ollama', name: 'Ollama', about: 'A model on this machine', group: 'local',
    protocol: 'openai', url: 'http://localhost:11434/v1', dockerUrl: 'http://host.docker.internal:11434/v1',
    key: 'none', example: 'qwen3:32b',
  },
  {
    id: 'custom', name: 'Another OpenAI-compatible API', about: 'Any address that speaks Chat Completions', group: 'custom',
    protocol: 'openai', urlExample: 'https://example.com/v1', key: 'optional',
  },
];

export function modelProvider(id: string): ModelProviderEntry | undefined {
  return MODEL_PROVIDERS.find((entry) => entry.id === id);
}
