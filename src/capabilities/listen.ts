/**
 * Listening: speech to text, from the provider the owner chooses in the
 * console (This deployment, Tools).
 *
 * Two uses. The owner speaks to the assistant -- a clip recorded in the
 * console, or a voice note to the Telegram bot -- and it is written down
 * before the assistant reads it. And a role transcribes a recording in the
 * company's files with `speech.transcribe`: a call, an interview, a voice
 * note a customer left.
 *
 * Each provider is the request its own reference describes (checked in
 * September 2026). Mistral's Voxtral is not here: its thirteen languages do
 * not include Indonesian. AssemblyAI answers only after an upload and a
 * poll, and Fireworks has withdrawn audio; both are left out.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';
import { companyRoot } from './files.ts';
import type { ToolKeyUse } from './search.ts';

export interface ListenProvider {
  id: string;
  name: string;
  about?: string;
  key: ToolKeyUse;
  keyUrl?: string;
  urlExample?: string;
  defaultModel?: string;
  reserveCents: number;
  request(audio: Heard, language: string | null, key: string | null, model: string, base: string | null): { url: string; headers: Record<string, string>; body: FormData | Blob | string };
  /** The words, from the answer. */
  text(answer: unknown): unknown;
}

/** A recording: its bytes and what kind of audio they are. */
export interface Heard {
  bytes: Buffer;
  mime: string;
}

const blob = (audio: Heard) => new Blob([audio.bytes], { type: audio.mime });

const bearer = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

function at(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) current = current && typeof current === 'object' ? (current as Record<string | number, unknown>)[part] : undefined;
  return current;
}

/** The file part's name, with the extension a provider reads the format from. */
function named(audio: Heard): string {
  const type = audio.mime.split(';')[0]!.trim();
  const extension = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a' }[type] ?? 'webm';
  return `speech.${extension}`;
}

/** OpenAI's transcription form, which Groq, DeepInfra and a speaches server share. */
function openAiForm(audio: Heard, model: string, language: string | null): FormData {
  const form = new FormData();
  form.append('file', blob(audio), named(audio));
  form.append('model', model);
  if (language) form.append('language', language);
  form.append('response_format', 'json');
  return form;
}

export const LISTEN_PROVIDERS: readonly ListenProvider[] = [
  {
    id: 'openai', name: 'OpenAI', about: 'GPT transcription, most languages', key: 'required', keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini-transcribe', reserveCents: 1,
    request: (audio, language, key, model) => ({
      url: 'https://api.openai.com/v1/audio/transcriptions', headers: bearer(key), body: openAiForm(audio, model, language),
    }),
    text: (answer) => at(answer, ['text']),
  },
  {
    id: 'groq', name: 'Groq', about: 'Whisper, very fast and cheap', key: 'required', keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'whisper-large-v3-turbo', reserveCents: 1,
    request: (audio, language, key, model) => ({
      url: 'https://api.groq.com/openai/v1/audio/transcriptions', headers: bearer(key), body: openAiForm(audio, model, language),
    }),
    text: (answer) => at(answer, ['text']),
  },
  {
    id: 'deepgram', name: 'Deepgram', about: 'Nova-3, built for speech', key: 'required', keyUrl: 'https://console.deepgram.com',
    defaultModel: 'nova-3', reserveCents: 1,
    request: (audio, language, key, model) => {
      const query = new URLSearchParams({ model, smart_format: 'true', ...(language ? { language } : {}) });
      return {
        url: `https://api.deepgram.com/v1/listen?${query}`,
        headers: { authorization: `Token ${key ?? ''}`, 'content-type': audio.mime },
        body: blob(audio),
      };
    },
    text: (answer) => at(answer, ['results', 'channels', 0, 'alternatives', 0, 'transcript']),
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', about: 'Scribe, ninety-nine languages', key: 'required', keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    defaultModel: 'scribe_v2', reserveCents: 1,
    request: (audio, language, key, model) => {
      const form = new FormData();
      form.append('model_id', model);
      form.append('file', blob(audio), named(audio));
      if (language) form.append('language_code', language);
      return { url: 'https://api.elevenlabs.io/v1/speech-to-text', headers: { 'xi-api-key': key ?? '' }, body: form };
    },
    text: (answer) => at(answer, ['text']),
  },
  {
    id: 'gemini', name: 'Google Gemini', about: 'Understands the audio as well as hearing it', key: 'required', keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash', reserveCents: 1,
    request: (audio, language, key, model) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key ?? '' },
      body: JSON.stringify({
        model,
        input: [
          { type: 'text', text: `Transcribe this recording word for word${language ? ` (it is in the language whose code is ${language})` : ''}. Answer with the words only.` },
          { type: 'audio', data: audio.bytes.toString('base64'), mime_type: audio.mime.split(';')[0] },
        ],
      }),
    }),
    text: (answer) => {
      let found: unknown;
      for (const step of ((at(answer, ['steps']) as unknown[] | undefined) ?? [])) {
        for (const part of ((at(step, ['content']) as unknown[] | undefined) ?? [])) {
          if (at(part, ['type']) === 'text') found = at(part, ['text']);
        }
      }
      return found;
    },
  },
  {
    id: 'deepinfra', name: 'DeepInfra', about: 'Whisper, a fraction of a cent', key: 'required', keyUrl: 'https://deepinfra.com/dash/api_keys',
    defaultModel: 'openai/whisper-large-v3-turbo', reserveCents: 1,
    request: (audio, language, key, model) => ({
      url: 'https://api.deepinfra.com/v1/audio/transcriptions', headers: bearer(key), body: openAiForm(audio, model, language),
    }),
    text: (answer) => at(answer, ['text']),
  },
  {
    id: 'speaches', name: 'speaches', about: 'Whisper on your own machine, OpenAI-compatible', key: 'optional',
    urlExample: 'http://localhost:8000', defaultModel: 'Systran/faster-whisper-small', reserveCents: 0,
    request: (audio, language, key, model, base) => ({
      url: `${(base ?? '').replace(/\/+$/, '')}/v1/audio/transcriptions`, headers: bearer(key), body: openAiForm(audio, model, language),
    }),
    text: (answer) => at(answer, ['text']),
  },
  {
    id: 'whisper-cpp', name: 'whisper.cpp', about: 'Its server, started with --convert so it takes any audio', key: 'none',
    urlExample: 'http://localhost:8080', reserveCents: 0,
    request: (audio, language, _key, _model, base) => {
      const form = new FormData();
      form.append('file', blob(audio), named(audio));
      form.append('language', language ?? 'auto');
      form.append('response_format', 'json');
      return { url: `${(base ?? '').replace(/\/+$/, '')}/inference`, headers: {}, body: form };
    },
    text: (answer) => at(answer, ['text']),
  },
];

export function listenProvider(id: string): ListenProvider | undefined {
  return LISTEN_PROVIDERS.find((one) => one.id === id);
}

export interface ListenBinding {
  provider: ListenProvider;
  url: string | null;
  model: string | null;
  key: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** A clip past this is not something said to an assistant, nor a file a provider takes in one request. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** The words in a recording, in the language named when there is one. */
export async function transcribe(binding: ListenBinding, audio: Heard, language: string | null, signal?: AbortSignal): Promise<string> {
  if (audio.bytes.length === 0) throw new PalugadaError('contract.violation', 'the recording is empty', { field: 'audio' });
  if (audio.bytes.length > MAX_AUDIO_BYTES) {
    throw new PalugadaError('contract.violation', `a recording is at most ${MAX_AUDIO_BYTES / 1024 / 1024} MB`, { field: 'audio' });
  }
  const model = binding.model ?? binding.provider.defaultModel ?? '';
  // The language alone, without a region: the panel's `pt-BR` is `pt` to
  // Whisper's API, which refuses a tag it does not list, and every provider
  // here hears Brazilian and European Portuguese alike.
  const spoken = language ? language.split('-')[0]!.toLowerCase() : null;
  const call = binding.provider.request(audio, spoken, await binding.key(), model, binding.url);
  const timeout = AbortSignal.timeout(binding.timeoutMs ?? 60_000);
  let response: Response;
  try {
    response = await (binding.fetch ?? fetch)(call.url, {
      method: 'POST',
      headers: { 'user-agent': 'PALUGADA/1.0 (+orchestrator)', ...call.headers },
      body: call.body,
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
  const words = binding.provider.text(await response.json());
  if (typeof words !== 'string') throw new PalugadaError('capability.unreachable', `${binding.provider.name} answered without the words`, {});
  return words.trim();
}

const AUDIO_TYPES: Record<string, string> = {
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.flac': 'audio/flac',
};

/**
 * `speech.transcribe` -- the words in a recording in the company's files.
 *
 * A read (tier 0): it changes nothing. What a recording says came from
 * whoever spoke, so it is outside content (F8.9), like a page read from the
 * web.
 */
export function speechTranscribe(binding: ListenBinding & { root: string }): Capability<{ path: string; language?: string }, { path: string; text: string }> {
  return {
    name: 'speech.transcribe',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 400, description: 'The recording, relative to the company\'s files.' },
        language: { type: 'string', pattern: '^[a-z]{2,3}$', description: 'Its language code, when known.' },
      },
    },
    adapter: `listen:${binding.provider.id}`,
    defaultTier: 0,
    readsOutside: true,
    estimatedCostCents: binding.provider.reserveCents,
    async execute(input, ctx) {
      const base = await companyRoot(binding.root, ctx.companyId);
      const missing = () => new PalugadaError('contract.violation', `there is no recording at ${input.path}`, { field: 'path' });
      // The real path, so a link inside the company's files cannot lead out of them.
      const path = await realpath(join(base, input.path)).catch(() => { throw missing(); });
      if (!path.startsWith(`${base}/`)) throw new PalugadaError('contract.violation', 'the recording must be inside the company\'s files', { field: 'path' });
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
      const mime = AUDIO_TYPES[extension];
      if (!mime) throw new PalugadaError('contract.violation', `a recording is ${Object.keys(AUDIO_TYPES).join(', ')}; got ${extension}`, { field: 'path' });
      const bytes = await readFile(path).catch(() => { throw missing(); });
      return { path: input.path, text: await transcribe(binding, { bytes, mime }, input.language ?? null, ctx.signal) };
    },
  };
}
