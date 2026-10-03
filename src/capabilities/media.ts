/**
 * `image.generate` and `speech.synthesize`: a picture or a voice, made by the
 * provider the owner chooses in the console, and kept in the company's files.
 *
 * Hermes offers both from a dozen providers; PALUGADA had neither. What comes
 * back is a file, not text, so each capability writes it where drafts go --
 * under the company's own directory in `PALUGADA_FILES_ROOT`, in `generated/`
 * -- and answers with its path. That makes each a tier 1 write like a draft:
 * cheap, undone by deleting the file, and read back after it is written
 * (F8.4). The provider's price for one call is reserved before it runs.
 *
 * Only providers that answer on the same connection are here, each with the
 * request its own documentation describes (checked in September 2026). A
 * provider that queues and must be polled, or that returns a picture only as
 * an address that expires, is either asked in its synchronous mode or left
 * out. Edge TTS is not here: it is not an API but a browser's endpoint used
 * without permission.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';
import { companyRoot } from './files.ts';
import { slug } from './draft.ts';
import type { ToolKeyUse } from './search.ts';

interface MediaProviderBase {
  id: string;
  name: string;
  about?: string;
  key: ToolKeyUse;
  keyUrl?: string;
  urlExample?: string;
  /** The model, or the voice, used when the owner names none. */
  defaultModel?: string;
  defaultVoice?: string;
  reserveCents: number;
  /** What a refusal's body says, in words the owner can act on; null to say it as it came. */
  explain?(body: string): string | null;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Made {
  bytes: Buffer;
  mime: string;
}

export type ImageShape = 'square' | 'landscape' | 'portrait';

/** What a provider that makes its picture later is given to wait for it. */
export interface Waiting {
  /** The server the owner gave, for a provider of their own. */
  base: string | null;
  /** Waits between two looks; ends early, failing, when the run is stopped. */
  pause(): Promise<void>;
  /** When to stop looking. */
  deadline: number;
}

export interface ImageProvider extends MediaProviderBase {
  request(prompt: string, shape: ImageShape, key: string | null, model: string, base: string | null): Call;
  /**
   * The picture, from the answer: base64 in it, an address fetched at once
   * before it expires, or -- for a server that makes it later -- looked for
   * until it is there.
   */
  image(answer: unknown, download: (url: string) => Promise<Made>, waiting: Waiting): Promise<Made>;
}

export interface SpeechProvider extends MediaProviderBase {
  request(text: string, voice: string, key: string | null, model: string, base: string | null): Call;
  /** `binary` when the body is the audio itself; otherwise the audio from the JSON answer. */
  audio: 'binary' | ((answer: unknown) => Made);
}

const json = { 'content-type': 'application/json' };
const bearer = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

function at(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) current = current && typeof current === 'object' ? (current as Record<string | number, unknown>)[part] : undefined;
  return current;
}

function fromBase64(data: unknown, mime: string, provider: string): Made {
  if (typeof data !== 'string' || data === '') {
    throw new PalugadaError('capability.unreachable', `${provider} answered without the file it was asked for`, { provider });
  }
  return { bytes: Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64'), mime };
}

/** The last output of Gemini's Interactions API of one kind, image or audio. */
function geminiOutput(answer: unknown, type: 'image' | 'audio'): { data: unknown; mime: unknown } {
  const steps = (at(answer, ['steps']) as unknown[] | undefined) ?? [];
  let found: { data: unknown; mime: unknown } = { data: undefined, mime: undefined };
  for (const step of steps) {
    for (const part of ((at(step, ['content']) as unknown[] | undefined) ?? [])) {
      if (at(part, ['type']) === type) found = { data: at(part, ['data']), mime: at(part, ['mime_type']) };
    }
  }
  return found;
}

const SIZES: Record<ImageShape, { pixels: string; ratio: string; fal: string }> = {
  square: { pixels: '1024x1024', ratio: '1:1', fal: 'square_hd' },
  landscape: { pixels: '1536x1024', ratio: '3:2', fal: 'landscape_4_3' },
  portrait: { pixels: '1024x1536', ratio: '2:3', fal: 'portrait_4_3' },
};

export const IMAGE_PROVIDERS: readonly ImageProvider[] = [
  {
    id: 'openai', name: 'OpenAI', about: 'GPT Image', key: 'required', keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-image-2', reserveCents: 6,
    request: (prompt, shape, key, model) => ({
      url: 'https://api.openai.com/v1/images/generations', headers: { ...json, ...bearer(key) },
      body: { model, prompt, size: SIZES[shape].pixels, quality: 'low', n: 1 },
    }),
    image: async (answer) => fromBase64(at(answer, ['data', 0, 'b64_json']), 'image/png', 'OpenAI'),
  },
  {
    id: 'fal', name: 'fal', about: 'FLUX and other open models, fast and cheap', key: 'required', keyUrl: 'https://fal.ai/dashboard/keys',
    defaultModel: 'fal-ai/flux-2/klein/9b', reserveCents: 2,
    // fal.run answers on the same connection; the queue it recommends needs polling.
    request: (prompt, shape, key, model) => ({
      url: `https://fal.run/${model}`, headers: { ...json, ...(key ? { authorization: `Key ${key}` } : {}) },
      body: { prompt, image_size: SIZES[shape].fal, num_images: 1, output_format: 'png' },
    }),
    image: async (answer, download) => {
      const url = at(answer, ['images', 0, 'url']);
      if (typeof url !== 'string') throw new PalugadaError('capability.unreachable', 'fal answered without an image', {});
      return download(url);
    },
  },
  {
    id: 'openrouter', name: 'OpenRouter', about: 'Image models from several labs, one key', key: 'required', keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'google/gemini-3.1-flash-image', reserveCents: 7,
    request: (prompt, shape, key, model) => ({
      url: 'https://openrouter.ai/api/v1/images', headers: { ...json, ...bearer(key) },
      body: { model, prompt, aspect_ratio: SIZES[shape].ratio, n: 1 },
    }),
    image: async (answer) => fromBase64(at(answer, ['data', 0, 'b64_json']), String(at(answer, ['data', 0, 'media_type']) ?? 'image/png'), 'OpenRouter'),
  },
  {
    id: 'deepinfra', name: 'DeepInfra', about: 'FLUX schnell, a fraction of a cent', key: 'required', keyUrl: 'https://deepinfra.com/dash/api_keys',
    defaultModel: 'black-forest-labs/FLUX-1-schnell', reserveCents: 1,
    request: (prompt, shape, key, model) => ({
      url: 'https://api.deepinfra.com/v1/openai/images/generations', headers: { ...json, ...bearer(key) },
      body: { model, prompt, size: shape === 'square' ? '1024x1024' : shape === 'landscape' ? '1344x768' : '768x1344', n: 1 },
    }),
    image: async (answer) => fromBase64(at(answer, ['data', 0, 'b64_json']), 'image/png', 'DeepInfra'),
  },
  {
    id: 'xai', name: 'xAI Grok Imagine', key: 'required', keyUrl: 'https://console.x.ai', defaultModel: 'grok-imagine-image', reserveCents: 2,
    request: (prompt, shape, key, model) => ({
      url: 'https://api.x.ai/v1/images/generations', headers: { ...json, ...bearer(key) },
      body: { model, prompt, aspect_ratio: SIZES[shape].ratio, resolution: '1k', response_format: 'b64_json', n: 1 },
    }),
    image: async (answer) => fromBase64(at(answer, ['data', 0, 'b64_json']), String(at(answer, ['data', 0, 'mime_type']) ?? 'image/png'), 'xAI'),
  },
  {
    id: 'gemini', name: 'Google Gemini', key: 'required', keyUrl: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-3.1-flash-image', reserveCents: 7,
    request: (prompt, shape, key, model) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions', headers: { ...json, 'x-goog-api-key': key ?? '' },
      body: { model, input: prompt, response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: SIZES[shape].ratio, image_size: '1K' } },
    }),
    image: async (answer) => {
      const output = geminiOutput(answer, 'image');
      return fromBase64(output.data, String(output.mime ?? 'image/png'), 'Gemini');
    },
  },
  {
    // The owner's own GPU (the tools research, gap #10), through the routes in
    // ComfyUI's server.py: the workflow posted to /prompt, its history polled
    // until the picture is there, the picture fetched from /view. ComfyUI is
    // GPL-3.0; PALUGADA only speaks to it over HTTP. It takes no key, so it
    // belongs on a private network.
    id: 'comfyui', name: 'ComfyUI', about: 'Your own GPU, any checkpoint you have', key: 'none',
    urlExample: 'http://127.0.0.1:8188', defaultModel: 'sd_xl_base_1.0.safetensors', reserveCents: 0,
    request: (prompt, shape, _key, model, base) => ({
      url: `${(base ?? '').replace(/\/+$/, '')}/prompt`, headers: json,
      body: { prompt: comfyWorkflow(prompt, shape, model), client_id: 'palugada' },
    }),
    image: async (answer, download, waiting) => {
      const id = at(answer, ['prompt_id']);
      if (typeof id !== 'string' || !id) throw new PalugadaError('capability.unreachable', 'ComfyUI answered without the id of the picture it queued', {});
      const server = (waiting.base ?? '').replace(/\/+$/, '');
      for (;;) {
        const history = JSON.parse((await download(`${server}/history/${encodeURIComponent(id)}`)).bytes.toString('utf8')) as unknown;
        const entry = at(history, [id]);
        if (at(entry, ['status', 'status_str']) === 'error') {
          throw new PalugadaError('capability.unreachable', `ComfyUI could not make the picture: ${comfyFailure(at(entry, ['status', 'messages']))}`, {});
        }
        const outputs = at(entry, ['outputs']);
        const picture = outputs && typeof outputs === 'object'
          ? Object.values(outputs as Record<string, unknown>).flatMap((output) => {
            const images = at(output, ['images']);
            return Array.isArray(images) ? images : [];
          })[0] as { filename?: unknown; subfolder?: unknown; type?: unknown } | undefined
          : undefined;
        if (picture && typeof picture.filename === 'string') {
          const where = new URLSearchParams({ filename: picture.filename, subfolder: String(picture.subfolder ?? ''), type: String(picture.type ?? 'temp') });
          return download(`${server}/view?${where}`);
        }
        if (Date.now() > waiting.deadline) throw new PalugadaError('capability.unreachable', 'ComfyUI did not finish the picture in time; it may still be busy with another', {});
        await waiting.pause();
      }
    },
    explain: (body) => {
      // A workflow refused before it ran: most often a checkpoint this ComfyUI does not have.
      let refused: unknown;
      try {
        refused = JSON.parse(body);
      } catch {
        return null;
      }
      const nodes = at(refused, ['node_errors']);
      const details = nodes && typeof nodes === 'object'
        ? Object.values(nodes as Record<string, unknown>).flatMap((node) => {
          const errors = at(node, ['errors']);
          return Array.isArray(errors) ? errors.map((error) => String(at(error, ['details']) || at(error, ['message']) || '')).filter(Boolean) : [];
        })
        : [];
      const said = details.join('; ') || String(at(refused, ['error', 'message']) ?? '');
      if (!said) return null;
      return `ComfyUI refused the workflow: ${said}${/ckpt_name/.test(said) ? '; under Tools, set the model to a checkpoint this ComfyUI has' : ''}`;
    },
  },
];

/**
 * ComfyUI's own default workflow, in the API's form: a checkpoint, the
 * prompt and its negative, an empty canvas of the shape asked for, twenty
 * steps of Euler, decoded and previewed -- previewed rather than saved, so
 * nothing piles up in the owner's output folder; the picture is kept in the
 * company's files. Sized for SDXL, which most checkpoints are.
 */
function comfyWorkflow(prompt: string, shape: ImageShape, model: string): Record<string, unknown> {
  const [width, height] = shape === 'landscape' ? [1344, 768] : shape === 'portrait' ? [768, 1344] : [1024, 1024];
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    5: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed: randomInt(0, 2 ** 32), steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'PreviewImage', inputs: { images: ['6', 0] } },
  };
}

/** What ComfyUI's history says went wrong: the exception of its execution_error, else its messages. */
function comfyFailure(messages: unknown): string {
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const said = Array.isArray(message) ? at(message[1], ['exception_message']) : undefined;
      if (typeof said === 'string' && said.trim()) return said.trim();
    }
  }
  return 'its history says the run failed';
}

export const SPEECH_PROVIDERS: readonly SpeechProvider[] = [
  {
    id: 'openai', name: 'OpenAI', about: 'Thirteen voices, in most languages', key: 'required', keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'marin', reserveCents: 2,
    request: (text, voice, key, model) => ({
      url: 'https://api.openai.com/v1/audio/speech', headers: { ...json, ...bearer(key) },
      body: { model, input: text, voice, response_format: 'mp3' },
    }),
    audio: 'binary',
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', about: 'The most natural voices', key: 'required', keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    defaultModel: 'eleven_multilingual_v2', defaultVoice: 'JBFqnCBsd6RMkjVDRZzb', reserveCents: 10,
    request: (text, voice, key, model) => ({
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      headers: { ...json, 'xi-api-key': key ?? '' },
      body: { text, model_id: model },
    }),
    audio: 'binary',
  },
  {
    id: 'xai', name: 'xAI', about: 'Grok\'s voices', key: 'required', keyUrl: 'https://console.x.ai', defaultVoice: 'eve', reserveCents: 2,
    request: (text, voice, key) => ({
      url: 'https://api.x.ai/v1/tts', headers: { ...json, ...bearer(key) },
      body: { text, voice_id: voice, output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 } },
    }),
    audio: 'binary',
  },
  {
    id: 'gemini', name: 'Google Gemini', about: 'Thirty voices; free on its free tier', key: 'required', keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash-tts', defaultVoice: 'Kore', reserveCents: 2,
    request: (text, voice, key, model) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions', headers: { ...json, 'x-goog-api-key': key ?? '' },
      body: { model, input: text, response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice }] } },
    }),
    audio: (answer) => {
      const output = geminiOutput(answer, 'audio');
      return fromBase64(output.data, String(output.mime ?? 'audio/wav'), 'Gemini');
    },
  },
  {
    id: 'deepinfra', name: 'DeepInfra', about: 'Kokoro and other open voices, cheaply', key: 'required', keyUrl: 'https://deepinfra.com/dash/api_keys',
    defaultModel: 'hexgrad/Kokoro-82M', defaultVoice: 'af_bella', reserveCents: 1,
    request: (text, voice, key, model) => ({
      url: 'https://api.deepinfra.com/v1/openai/audio/speech', headers: { ...json, ...bearer(key) },
      body: { model, input: text, voice, response_format: 'mp3' },
    }),
    audio: 'binary',
  },
  {
    id: 'piper', name: 'Piper', about: 'Your own speech server, free, in forty languages', key: 'none',
    urlExample: 'http://localhost:5000', defaultVoice: 'en_US-lessac-medium', reserveCents: 0,
    request: (text, voice, _key, _model, base) => {
      if (!base) throw new PalugadaError('config.invalid', 'Piper is your own server: give its address', { provider: 'piper' });
      return { url: `${base.replace(/\/+$/, '')}/synthesize`, headers: json, body: { text, voice, length_scale: 1 } };
    },
    audio: 'binary',
  },
];

export function imageProvider(id: string): ImageProvider | undefined {
  return IMAGE_PROVIDERS.find((one) => one.id === id);
}

export function speechProvider(id: string): SpeechProvider | undefined {
  return SPEECH_PROVIDERS.find((one) => one.id === id);
}

/** A provider bound for this deployment, and where the company's files are. */
export interface MediaBinding<P> {
  provider: P;
  url: string | null;
  model: string | null;
  voice: string | null;
  key: () => Promise<string | null>;
  /** PALUGADA_FILES_ROOT: each company's files are a directory under it. */
  root: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Between two looks for a picture made later; a second. */
  pollMs?: number;
}

/** A picture or a clip over this is a provider misbehaving, not a file a company needs. */
const MAX_BYTES = 25 * 1024 * 1024;

async function post(call: Call, binding: MediaBinding<MediaProviderBase>, signal: AbortSignal | undefined): Promise<Response> {
  const timeout = AbortSignal.timeout(binding.timeoutMs ?? 120_000);
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
    const body = await response.text().catch(() => '');
    const explained = binding.provider.explain?.(body) ?? null;
    if (explained) throw new PalugadaError('capability.unreachable', explained, { status: response.status });
    const detail = body.slice(0, 300);
    const refused = response.status === 401 || response.status === 403;
    throw new PalugadaError(refused ? 'credential.unavailable' : 'capability.unreachable',
      refused
        ? `${binding.provider.name} refused the key (${response.status}): set it again in the console, under This deployment, Tools`
        : `${binding.provider.name} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      { status: response.status });
  }
  return response;
}

async function bytesOf(response: Response, provider: string): Promise<Buffer> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new PalugadaError('capability.unreachable', `${provider} answered with an empty file`, {});
  if (bytes.length > MAX_BYTES) throw new PalugadaError('capability.unreachable', `${provider} answered with ${bytes.length} bytes, over the ${MAX_BYTES} kept`, {});
  return bytes;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};

/** Writes the file under the company's `generated/`, 0600, and answers with its path relative to the company's files. */
async function keep(root: string, companyId: string, name: string, made: Made): Promise<{ path: string; sha256: string }> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const base = await companyRoot(root, companyId);
  const directory = join(base, 'generated');
  await mkdir(directory, { recursive: true });
  const file = `${slug(name) || 'file'}-${randomUUID().slice(0, 8)}.${EXTENSIONS[made.mime.split(';')[0]!.trim()] ?? 'bin'}`;
  await writeFile(join(directory, file), made.bytes, { mode: 0o600 });
  return { path: join('generated', file), sha256: createHash('sha256').update(made.bytes).digest('hex') };
}

async function readBack(root: string, companyId: string, result: { path: string; sha256: string }): Promise<boolean> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const stored = await readFile(join(await companyRoot(root, companyId), result.path)).catch(() => null);
  return stored !== null && createHash('sha256').update(stored).digest('hex') === result.sha256;
}

export interface ImageInput {
  prompt: string;
  shape?: ImageShape;
  /** A few words for the file's name. */
  name?: string;
}

export interface MediaOutput {
  provider: string;
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
}

/** Makes the picture, or only fetches and returns it without keeping it -- what the console's test does. */
export async function makeImage(binding: MediaBinding<ImageProvider>, input: ImageInput, signal?: AbortSignal): Promise<Made> {
  const prompt = String(input.prompt ?? '').trim();
  if (prompt === '') throw new PalugadaError('contract.violation', 'image.generate needs a prompt', { field: 'prompt' });
  const shape: ImageShape = input.shape === 'landscape' || input.shape === 'portrait' ? input.shape : 'square';
  const model = binding.model ?? binding.provider.defaultModel ?? '';
  const response = await post(binding.provider.request(prompt.slice(0, 4_000), shape, await binding.key(), model, binding.url), binding, signal);
  const answer: unknown = await response.json();
  const pollMs = binding.pollMs ?? 1_000;
  return binding.provider.image(answer, async (url) => {
    // An address the provider made for this picture, fetched at once: it expires.
    const file = await (binding.fetch ?? fetch)(url, { signal: AbortSignal.timeout(60_000) });
    if (!file.ok) throw new PalugadaError('capability.unreachable', `${binding.provider.name}'s picture could not be fetched (${file.status})`, {});
    return { bytes: await bytesOf(file, binding.provider.name), mime: (file.headers.get('content-type') ?? 'image/png').split(';')[0]! };
  }, {
    base: binding.url,
    deadline: Date.now() + (binding.timeoutMs ?? 180_000),
    pause: () => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new PalugadaError('capability.unreachable', `${binding.provider.name}'s picture was not waited for: the run was stopped`, {}));
      const timer = setTimeout(resolve, pollMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new PalugadaError('capability.unreachable', `${binding.provider.name}'s picture was not waited for: the run was stopped`, {}));
      }, { once: true });
    }),
  });
}

export async function makeSpeech(binding: MediaBinding<SpeechProvider>, input: SpeechInput, signal?: AbortSignal): Promise<Made> {
  const text = String(input.text ?? '').trim();
  if (text === '') throw new PalugadaError('contract.violation', 'speech.synthesize needs the text to say', { field: 'text' });
  if (text.length > MAX_TEXT) throw new PalugadaError('contract.violation', `speech.synthesize says at most ${MAX_TEXT} characters at a time`, { field: 'text' });
  const voice = (typeof input.voice === 'string' && input.voice.trim()) || binding.voice || binding.provider.defaultVoice || '';
  const model = binding.model ?? binding.provider.defaultModel ?? '';
  const response = await post(binding.provider.request(text, voice, await binding.key(), model, binding.url), binding, signal);
  if (binding.provider.audio === 'binary') {
    const type = (response.headers.get('content-type') ?? 'audio/mpeg').split(';')[0]!.trim();
    // xAI answers JSON with the audio inside it when it adds timestamps.
    if (type === 'application/json') return fromBase64(at(await response.json(), ['audio']), 'audio/mpeg', binding.provider.name);
    return { bytes: await bytesOf(response, binding.provider.name), mime: type };
  }
  return binding.provider.audio(await response.json());
}

/** `image.generate` -- a picture from a prompt, kept in the company's files. */
export function imageGenerate(binding: MediaBinding<ImageProvider>): Capability<ImageInput, MediaOutput> {
  return {
    name: 'image.generate',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'What the picture shows.' },
        shape: { type: 'string', enum: ['square', 'landscape', 'portrait'], description: 'Default square.' },
        name: { type: 'string', maxLength: 80, description: 'A few words for the file\'s name.' },
      },
    },
    adapter: `image:${binding.provider.id}`,
    defaultTier: 1,
    estimatedCostCents: binding.provider.reserveCents,
    async execute(input, ctx) {
      const made = await makeImage(binding, input, ctx.signal);
      const kept = await keep(binding.root, ctx.companyId, input.name ?? input.prompt, made);
      return { provider: binding.provider.name, path: kept.path, mime: made.mime, bytes: made.bytes.length, sha256: kept.sha256 };
    },
    async verify(_input, result, ctx) {
      return readBack(binding.root, ctx.companyId, result);
    },
  };
}

export interface SpeechInput {
  text: string;
  voice?: string;
  name?: string;
}

const MAX_TEXT = 4_000;

/** `speech.synthesize` -- text said aloud, kept in the company's files as audio. */
export function speechSynthesize(binding: MediaBinding<SpeechProvider>): Capability<SpeechInput, MediaOutput> {
  return {
    name: 'speech.synthesize',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'What to say, at most 4,000 characters.' },
        voice: { type: 'string', maxLength: 80, description: 'A voice the provider knows; the one the owner chose by default.' },
        name: { type: 'string', maxLength: 80, description: 'A few words for the file\'s name.' },
      },
    },
    adapter: `speech:${binding.provider.id}`,
    defaultTier: 1,
    estimatedCostCents: binding.provider.reserveCents,
    async execute(input, ctx) {
      const made = await makeSpeech(binding, input, ctx.signal);
      const kept = await keep(binding.root, ctx.companyId, input.name ?? input.text.slice(0, 40), made);
      return { provider: binding.provider.name, path: kept.path, mime: made.mime, bytes: made.bytes.length, sha256: kept.sha256 };
    },
    async verify(_input, result, ctx) {
      return readBack(binding.root, ctx.companyId, result);
    },
  };
}
