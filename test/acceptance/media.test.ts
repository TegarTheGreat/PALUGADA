/**
 * A picture or a voice, made by the provider the owner chose and kept in the
 * company's files.
 *
 * Each provider is held to the request its documentation describes -- the
 * header its key goes in above all -- and to where the file is in its answer:
 * base64 in the JSON, an address to fetch at once before it expires, or the
 * body itself. What is made is written under the company's own directory and
 * read back (F8.4); a file that changed after it was written does not verify.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import {
  IMAGE_PROVIDERS, SPEECH_PROVIDERS, imageGenerate, speechSynthesize, type ImageProvider, type SpeechProvider,
} from '../../src/capabilities/media.ts';
import { toolBindingsFrom } from '../../src/capabilities/tools.ts';
import { STANDARD_CATALOGUE } from '../../src/broker/catalogue.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../../src/templates/standard.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  await closePools();
  await closeSetup();
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP3 = Buffer.from('4944330300000000', 'hex');
const b64 = (bytes: Buffer) => bytes.toString('base64');

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** Each image provider's documented answer (for fal, the address it gives), and where its key goes. */
const IMAGE_ANSWERS: Record<string, { answer: unknown; key: (call: Seen) => string | null }> = {
  openai: { answer: { data: [{ b64_json: b64(PNG) }] }, key: bearerOf },
  fal: { answer: { images: [{ url: 'https://v3.fal.media/files/abc.png', width: 1024, height: 1024, content_type: 'image/png' }] }, key: (call) => call.headers.authorization?.replace(/^Key /, '') ?? null },
  openrouter: { answer: { data: [{ b64_json: b64(PNG), media_type: 'image/png' }], usage: { cost: 0.039 } }, key: bearerOf },
  deepinfra: { answer: { data: [{ b64_json: b64(PNG) }] }, key: bearerOf },
  xai: { answer: { data: [{ b64_json: b64(PNG), mime_type: 'image/png' }] }, key: bearerOf },
  gemini: { answer: { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Here' }, { type: 'image', mime_type: 'image/png', data: b64(PNG) }] }] }, key: (call) => call.headers['x-goog-api-key'] ?? null },
  // A server of the owner's own: its own test below.
  comfyui: { answer: null, key: () => null },
};

/** Each speech provider's documented answer: the body itself, or base64 inside JSON. */
const SPEECH_ANSWERS: Record<string, { binary: boolean; answer?: unknown; key: (call: Seen) => string | null }> = {
  openai: { binary: true, key: bearerOf },
  elevenlabs: { binary: true, key: (call) => call.headers['xi-api-key'] ?? null },
  xai: { binary: true, key: bearerOf },
  gemini: { binary: false, answer: { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: b64(MP3) }] }] }, key: (call) => call.headers['x-goog-api-key'] ?? null },
  deepinfra: { binary: true, key: bearerOf },
  piper: { binary: true, key: () => null },
};

function bearerOf(call: Seen): string | null {
  const value = call.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

/** A fetch that answers as the provider documents, and serves fal's picture at the address it gave. */
function providerFetch(answer: unknown, binary: Buffer | null, mime: string) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://v3.fal.media/')) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    seen.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    });
    return binary
      ? new Response(binary, { status: 200, headers: { 'content-type': mime } })
      : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const root = () => mkdtempSync(join(tmpdir(), 'palugada-files-'));

test('every image provider is asked the way it documents, and its picture is found where it puts it', async () => {
  assert.deepEqual(IMAGE_PROVIDERS.map((one) => one.id).sort(), Object.keys(IMAGE_ANSWERS).sort(), 'every provider has a documented answer here');
  for (const provider of IMAGE_PROVIDERS.filter((one) => !one.urlExample)) {
    const { answer, key } = IMAGE_ANSWERS[provider.id]!;
    const { fetch, seen } = providerFetch(answer, null, 'application/json');
    const files = root();
    const companyId = randomUUID();
    const capability = imageGenerate({ provider, url: null, model: null, voice: null, key: async () => 'the-key-0123', root: files, fetch });
    const made = await capability.execute({ prompt: 'a lighthouse at dawn', name: 'Launch banner' }, { companyId, signal: AbortSignal.timeout(5_000) } as never);
    assert.equal(key(seen[0]!), 'the-key-0123', `${provider.id} carries its key where the provider reads it`);
    assert.ok(JSON.stringify(seen[0]!.body).includes('a lighthouse at dawn'), `${provider.id} is sent the prompt`);
    assert.ok(seen[0]!.url.startsWith('https://'), provider.id);
    assert.match(made.path, /^generated\/launch-banner-[0-9a-f]{8}\.png$/, provider.id);
    assert.deepEqual(readFileSync(join(files, companyId, made.path)), PNG, `${provider.id}'s picture is what was kept`);
    assert.equal(await capability.verify!({ prompt: 'x' }, made, { companyId } as never), true);
    // A file changed after it was written is not the one that was made.
    writeFileSync(join(files, companyId, made.path), Buffer.from('something else'));
    assert.equal(await capability.verify!({ prompt: 'x' }, made, { companyId } as never), false, `${provider.id}: the read-back reads the bytes`);
  }
});

/**
 * ComfyUI, on the owner's own GPU (the tools research, gap #10): a workflow
 * posted to /prompt, the history polled until the picture is there, and the
 * picture fetched from /view -- as its server.py routes say, read in October
 * 2026. PreviewImage rather than SaveImage, so nothing piles up in the
 * owner's output folder: the picture is kept in the company's files.
 */
function comfyFetch(options: { fails?: 'validation' | 'run' } = {}) {
  const asked: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let polled = 0;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (url: string, init?: RequestInit) => {
    const address = new URL(String(url));
    asked.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (address.pathname === '/prompt') {
      if (options.fails === 'validation') {
        return reply({
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
          node_errors: { 1: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'sd_xl_base_1.0.safetensors' not in ['flux1-schnell.safetensors']", extra_info: {} }], dependent_outputs: ['7'], class_type: 'CheckpointLoaderSimple' } },
        }, 400);
      }
      return reply({ prompt_id: 'p-123', number: 1, node_errors: {} });
    }
    if (address.pathname === '/history/p-123') {
      polled += 1;
      if (polled === 1) return reply({});
      if (options.fails === 'run') {
        return reply({ 'p-123': { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } });
      }
      return reply({ 'p-123': {
        prompt: [], outputs: { 7: { images: [{ filename: 'ComfyUI_temp_abcde_00001_.png', subfolder: '', type: 'temp' }] } },
        status: { status_str: 'success', completed: true, messages: [] },
      } });
    }
    if (address.pathname === '/view') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

test('ComfyUI on the owner\'s own GPU is sent a workflow, polled until the picture is made, and the picture kept', async () => {
  const comfy = IMAGE_PROVIDERS.find((one) => one.id === 'comfyui')!;
  assert.equal(comfy.key, 'none');
  assert.equal(comfy.urlExample, 'http://127.0.0.1:8188');
  const { fetch, asked } = comfyFetch();
  const files = root();
  const companyId = randomUUID();
  const capability = imageGenerate({ provider: comfy, url: 'http://gpu.internal:8188/', model: null, voice: null, key: async () => null, root: files, fetch, pollMs: 10 });
  const made = await capability.execute({ prompt: 'mercusuar saat fajar', shape: 'landscape', name: 'Spanduk' }, { companyId, signal: AbortSignal.timeout(5_000) } as never);
  assert.deepEqual(readFileSync(join(files, companyId, made.path)), PNG);
  assert.equal(made.provider, 'ComfyUI');

  const posted = asked[0]!;
  assert.equal(posted.url, 'http://gpu.internal:8188/prompt');
  const graph = posted.body!.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const node = (type: string) => Object.values(graph).find((one) => one.class_type === type)!;
  assert.equal(node('CheckpointLoaderSimple').inputs.ckpt_name, comfy.defaultModel, 'the checkpoint is the model');
  assert.ok(Object.values(graph).some((one) => one.class_type === 'CLIPTextEncode' && one.inputs.text === 'mercusuar saat fajar'));
  assert.deepEqual([node('EmptyLatentImage').inputs.width, node('EmptyLatentImage').inputs.height], [1344, 768]);
  assert.ok(Number.isInteger(node('KSampler').inputs.seed));
  assert.ok(node('PreviewImage'), 'previewed, not saved in the owner\'s output folder');
  assert.ok(!Object.values(graph).some((one) => one.class_type === 'SaveImage'));
  // Polled until there, then the picture where the history says it is.
  assert.deepEqual(asked.slice(1).map((one) => new URL(one.url).pathname), ['/history/p-123', '/history/p-123', '/view']);
  const view = new URL(asked.at(-1)!.url).searchParams;
  assert.deepEqual([view.get('filename'), view.get('subfolder'), view.get('type')], ['ComfyUI_temp_abcde_00001_.png', '', 'temp']);

  // The owner's checkpoint, when they name one.
  const named = comfyFetch();
  await imageGenerate({ provider: comfy, url: 'http://gpu.internal:8188', model: 'flux1-schnell.safetensors', voice: null, key: async () => null, root: files, fetch: named.fetch, pollMs: 10 })
    .execute({ prompt: 'x' }, { companyId, signal: AbortSignal.timeout(5_000) } as never);
  assert.equal(Object.values(named.asked[0]!.body!.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>)
    .find((one) => one.class_type === 'CheckpointLoaderSimple')!.inputs.ckpt_name, 'flux1-schnell.safetensors');
});

test('what ComfyUI refuses or fails at is said in words the owner can act on', async () => {
  const comfy = IMAGE_PROVIDERS.find((one) => one.id === 'comfyui')!;
  const run = (fails: 'validation' | 'run') => imageGenerate({
    provider: comfy, url: 'http://gpu.internal:8188', model: null, voice: null, key: async () => null, root: root(), fetch: comfyFetch({ fails }).fetch, pollMs: 10,
  }).execute({ prompt: 'x' }, { companyId: randomUUID(), signal: AbortSignal.timeout(5_000) } as never);
  await assert.rejects(run('validation'), (error: Error) => /ComfyUI refused the workflow: ckpt_name: 'sd_xl_base_1\.0\.safetensors' not in \['flux1-schnell\.safetensors'\]; under Tools, set the model to a checkpoint this ComfyUI has/.test(error.message));
  await assert.rejects(run('run'), /ComfyUI could not make the picture: CUDA out of memory/);
});

test('every speech provider is asked the way it documents, and its audio is kept whatever shape it came back in', async () => {
  assert.deepEqual(SPEECH_PROVIDERS.map((one) => one.id).sort(), Object.keys(SPEECH_ANSWERS).sort());
  for (const provider of SPEECH_PROVIDERS) {
    const { binary, answer, key } = SPEECH_ANSWERS[provider.id]!;
    const { fetch, seen } = providerFetch(answer, binary ? MP3 : null, 'audio/mpeg');
    const files = root();
    const companyId = randomUUID();
    const typed = provider.key === 'none' ? null : 'the-key-0123';
    const capability = speechSynthesize({
      provider, url: provider.urlExample ? 'http://speech.internal:5000' : null, model: null, voice: null, key: async () => typed, root: files, fetch,
    });
    const made = await capability.execute({ text: 'Selamat pagi, laporan minggu ini siap.' }, { companyId, signal: AbortSignal.timeout(5_000) } as never);
    assert.equal(key(seen[0]!), typed, `${provider.id} carries its key where the provider reads it`);
    assert.ok(JSON.stringify(seen[0]!.body).includes('Selamat pagi'), `${provider.id} is sent the text`);
    assert.deepEqual(readFileSync(join(files, companyId, made.path)), MP3, provider.id);
    if (provider.defaultVoice) assert.ok(`${seen[0]!.url} ${JSON.stringify(seen[0]!.body)}`.includes(provider.defaultVoice), `${provider.id} speaks in its default voice`);
  }
  // xAI answers JSON, with the audio inside it, when it is asked for timestamps.
  const xai = SPEECH_PROVIDERS.find((one) => one.id === 'xai')!;
  const inJson = providerFetch({ audio: b64(MP3), alignment: [] }, null, 'application/json');
  const files = root();
  const companyId = randomUUID();
  const fromJson = await speechSynthesize({ provider: xai, url: null, model: null, voice: null, key: async () => 'k', root: files, fetch: inJson.fetch })
    .execute({ text: 'with timestamps' }, { companyId } as never);
  assert.deepEqual(readFileSync(join(files, companyId, fromJson.path)), MP3, 'the audio inside the JSON is what was kept');
  assert.equal(fromJson.mime, 'audio/mpeg');
  await assert.rejects(speechSynthesize({ provider: SPEECH_PROVIDERS[0]!, url: null, model: null, voice: null, key: async () => 'k', root: root() })
    .execute({ text: 'x'.repeat(4_001) }, { companyId: randomUUID() } as never), /at most 4000 characters/);
});

test('the voice and model the owner chose are the ones asked for, and a role may name another voice', async () => {
  const openai = SPEECH_PROVIDERS.find((one) => one.id === 'openai') as SpeechProvider;
  const { fetch, seen } = providerFetch(null, MP3, 'audio/mpeg');
  const capability = speechSynthesize({ provider: openai, url: null, model: 'tts-1-hd', voice: 'nova', key: async () => 'k', root: root(), fetch });
  await capability.execute({ text: 'one' }, { companyId: randomUUID() } as never);
  assert.equal(seen[0]!.body!.voice, 'nova');
  assert.equal(seen[0]!.body!.model, 'tts-1-hd');
  await capability.execute({ text: 'two', voice: 'onyx' }, { companyId: randomUUID() } as never);
  assert.equal(seen[1]!.body!.voice, 'onyx');
  const image = IMAGE_PROVIDERS.find((one) => one.id === 'openai') as ImageProvider;
  const pictures = providerFetch(IMAGE_ANSWERS.openai!.answer, null, 'application/json');
  await imageGenerate({ provider: image, url: null, model: 'gpt-image-2.5-flare', voice: null, key: async () => 'k', root: root(), fetch: pictures.fetch })
    .execute({ prompt: 'p', shape: 'landscape' }, { companyId: randomUUID() } as never);
  assert.equal(pictures.seen[0]!.body!.model, 'gpt-image-2.5-flare');
  assert.equal(pictures.seen[0]!.body!.size, '1536x1024');
});

test('pictures and speech are drafts in the catalogue: tier 1, read back, their price reserved', () => {
  for (const name of ['image.generate', 'speech.synthesize']) {
    assert.equal(STANDARD_CATALOGUE.find((one) => one.name === name)?.tier, 1, name);
  }
  const capability = imageGenerate({ provider: IMAGE_PROVIDERS[0]!, url: null, model: null, voice: null, key: async () => 'k', root: '/x' });
  assert.equal(capability.defaultTier, 1);
  assert.ok(capability.verify);
  assert.ok((capability.estimatedCostCents ?? 0) > 0);
  // Growth publishes, so it may make what it publishes; the owner puts the tool on a role.
  for (const name of ['image.generate', 'speech.synthesize']) {
    assert.ok((STANDARD_COMPANY_TEMPLATE.grants ?? []).some((grant) => grant.division === 'growth' && grant.capability === name), name);
  }
});

test('without the company\'s files, pictures and speech are unbound and the note says why', () => {
  const env = { PALUGADA_IMAGE_PROVIDER: 'openai', PALUGADA_IMAGE_KEY_REF: 'db://tool-image', PALUGADA_SPEECH_PROVIDER: 'piper', PALUGADA_SPEECH_URL: 'http://piper:5000' };
  const without = toolBindingsFrom(env, async () => 'k');
  assert.match(without.notes.join('\n'), /image\.generate is unbound: what it makes is kept in the company's files, and PALUGADA_FILES_ROOT is not set/);
  const bound = toolBindingsFrom({ ...env, PALUGADA_SPEECH_VOICE: 'id_ID-news_tts-medium' }, async () => 'k', '/srv/files');
  assert.equal(bound.image?.provider.id, 'openai');
  assert.equal(bound.speech?.voice, 'id_ID-news_tts-medium');
  assert.equal(bound.speech?.root, '/srv/files');
});

test('the owner chooses a voice in the console, hears it, and saves it with their device', async () => {
  const piper = await piperServer();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = (await api.call('GET', '/api/control/tools', token)).body;
    assert.ok(listed.providers.speech.some((one: { id: string }) => one.id === 'elevenlabs'));
    assert.ok(listed.providers.image.some((one: { id: string }) => one.id === 'fal'));

    const heard = await api.call('POST', '/api/control/tools/speech/test', token,
      { provider: 'piper', url: piper.url, voice: 'id_ID-news_tts-medium', text: 'Halo dari PALUGADA.' });
    assert.equal(heard.body.problem, null, JSON.stringify(heard.body));
    assert.equal(heard.body.media.mime, 'audio/wav');
    assert.equal(heard.body.media.dataUrl, `data:audio/wav;base64,${b64(MP3)}`);
    assert.deepEqual(piper.asked.at(-1), { text: 'Halo dari PALUGADA.', voice: 'id_ID-news_tts-medium', length_scale: 1 });

    const saved = await api.call('POST', '/api/control/tools/speech', token,
      { provider: 'piper', url: piper.url, voice: 'id_ID-news_tts-medium', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const image = await api.call('POST', '/api/control/tools/image', token,
      { provider: 'openai', key: 'sk-image-0123', model: 'gpt-image-2', proof: { totp: api.code() } });
    assert.equal(image.status, 200);
    const env = withSettings({}, await readSettings());
    assert.equal(env.PALUGADA_SPEECH_VOICE, 'id_ID-news_tts-medium');
    assert.equal(env.PALUGADA_IMAGE_MODEL, 'gpt-image-2');
    assert.equal(env.PALUGADA_IMAGE_KEY_REF, 'db://tool-image');
    assert.equal(await api.secrets.resolve('db://tool-image'), 'sk-image-0123');
    const after = (await api.call('GET', '/api/control/tools', token)).body;
    assert.equal(after.kinds.speech.voice, 'id_ID-news_tts-medium');
    assert.equal(after.kinds.image.model, 'gpt-image-2');
    assert.ok(!JSON.stringify(after).includes('sk-image'), 'the key never comes back');
  } finally {
    await api.close();
  }
});

/** A Piper speech server: what it was asked, answered with a WAV body. */
async function piperServer() {
  const asked: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (req.url !== '/synthesize') {
        res.writeHead(404).end();
        return;
      }
      asked.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(MP3);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}
