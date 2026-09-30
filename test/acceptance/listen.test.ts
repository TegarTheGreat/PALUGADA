/**
 * Listening: speech to text (src/capabilities/listen.ts).
 *
 * The owner asked whether they could talk to PALUGADA. These hold each
 * provider to the request its reference describes -- where the key goes, how
 * the audio is sent, where the words are in the answer -- and the two uses:
 * the owner's voice written down for the assistant, and a role reading a
 * recording in the company's files.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { LISTEN_PROVIDERS, speechTranscribe, transcribe, type ListenProvider } from '../../src/capabilities/listen.ts';
import { toolBindingsFrom } from '../../src/capabilities/tools.ts';
import { STANDARD_CATALOGUE } from '../../src/broker/catalogue.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import { setDeploymentLanguages } from '../../src/domain/language.ts';
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

const CLIP = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d', 'hex');
const SAID = 'Selamat pagi, tolong siapkan laporan minggu ini.';

interface Heard {
  url: string;
  headers: Record<string, string>;
  /** The audio as the provider received it, and the fields sent beside it. */
  audio: Buffer | null;
  fields: Record<string, string>;
  filename: string | null;
}

/** Each provider's documented answer, and where it looks for its key. */
const ANSWERS: Record<string, { answer: unknown; key: (heard: Heard) => string | null }> = {
  openai: { answer: { text: SAID }, key: (heard) => bearerOf(heard) },
  groq: { answer: { text: SAID, x_groq: { id: 'req_1' } }, key: (heard) => bearerOf(heard) },
  deepgram: {
    answer: { metadata: {}, results: { channels: [{ alternatives: [{ transcript: SAID, confidence: 0.98 }] }] } },
    key: (heard) => heard.headers.authorization?.replace(/^Token /, '') ?? null,
  },
  elevenlabs: { answer: { language_code: 'ind', text: SAID, words: [] }, key: (heard) => heard.headers['xi-api-key'] ?? null },
  gemini: {
    answer: { steps: [{ type: 'model_output', content: [{ type: 'text', text: SAID }] }] },
    key: (heard) => heard.headers['x-goog-api-key'] ?? null,
  },
  deepinfra: { answer: { text: SAID }, key: (heard) => bearerOf(heard) },
  speaches: { answer: { text: SAID }, key: (heard) => bearerOf(heard) },
  'whisper-cpp': { answer: { text: ` ${SAID}\n` }, key: () => null },
};

function bearerOf(heard: Heard): string | null {
  return heard.headers.authorization?.startsWith('Bearer ') ? heard.headers.authorization.slice(7) : null;
}

/** A fetch that answers as the provider documents, and records what it was sent. */
function providerFetch(answer: unknown) {
  const heard: Heard[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const one: Heard = { url: String(url), headers, audio: null, fields: {}, filename: null };
    const body = init?.body;
    if (body instanceof FormData) {
      for (const [name, value] of body.entries()) {
        if (typeof value === 'string') one.fields[name] = value;
        else {
          one.audio = Buffer.from(await value.arrayBuffer());
          one.filename = value.name;
        }
      }
    } else if (body instanceof Blob) {
      one.audio = Buffer.from(await body.arrayBuffer());
    } else if (typeof body === 'string') {
      const parsed = JSON.parse(body) as { input?: Array<{ type: string; data?: string; text?: string }>; model?: string };
      const audio = parsed.input?.find((part) => part.type === 'audio');
      one.audio = audio?.data ? Buffer.from(audio.data, 'base64') : null;
      one.fields.prompt = parsed.input?.find((part) => part.type === 'text')?.text ?? '';
      one.fields.model = parsed.model ?? '';
    }
    heard.push(one);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, heard };
}

test('every listening provider is sent the recording and its key the way it documents, and read the way it answers', async () => {
  assert.deepEqual(LISTEN_PROVIDERS.map((one) => one.id).sort(), Object.keys(ANSWERS).sort(), 'every provider has a documented answer here');
  for (const provider of LISTEN_PROVIDERS) {
    const { answer, key } = ANSWERS[provider.id]!;
    const { fetch, heard } = providerFetch(answer);
    const typed = provider.key === 'none' ? null : 'the-key-0123';
    const text = await transcribe({
      provider, url: provider.urlExample ? 'http://speech.internal:8000' : null, model: null, key: async () => typed, fetch,
    }, { bytes: CLIP, mime: 'audio/webm;codecs=opus' }, 'id');
    assert.equal(text, SAID, `${provider.id}: the words, trimmed`);
    assert.equal(key(heard[0]!), provider.key === 'none' ? null : typed, `${provider.id} carries its key where the provider reads it`);
    assert.deepEqual(heard[0]!.audio, CLIP, `${provider.id} is sent the recording itself`);
    if (heard[0]!.filename !== null) assert.equal(heard[0]!.filename, 'speech.webm', `${provider.id}: a name whose extension says the format`);
    const language = heard[0]!.fields.language ?? heard[0]!.fields.language_code ?? new URL(heard[0]!.url).searchParams.get('language') ?? heard[0]!.fields.prompt;
    assert.match(String(language), /\bid\b/, `${provider.id} is told the language`);
    if (provider.defaultModel) {
      const model = heard[0]!.fields.model ?? heard[0]!.fields.model_id ?? new URL(heard[0]!.url).searchParams.get('model');
      assert.equal(model, provider.defaultModel, `${provider.id} uses its default model`);
    }
  }
});

/**
 * The panel's language can name a region -- Brazilian Portuguese is `pt-BR`
 * -- and the providers take a language: Whisper's API refuses `pt-BR` as an
 * unknown language, so a Brazilian owner's voice note was never heard.
 */
test('a language with a region is sent to every listening provider as the language alone', async () => {
  for (const provider of LISTEN_PROVIDERS) {
    const { answer } = ANSWERS[provider.id]!;
    const { fetch, heard } = providerFetch(answer);
    await transcribe({
      provider, url: provider.urlExample ? 'http://speech.internal:8000' : null, model: null, key: async () => 'the-key-0123', fetch,
    }, { bytes: CLIP, mime: 'audio/webm;codecs=opus' }, 'pt-BR');
    const language = heard[0]!.fields.language ?? heard[0]!.fields.language_code ?? new URL(heard[0]!.url).searchParams.get('language') ?? heard[0]!.fields.prompt;
    assert.match(String(language), /\bpt\b/, `${provider.id} is told the language`);
    assert.doesNotMatch(String(language), /pt-BR/, `${provider.id} is not sent the region`);
  }
});

test('a refused key and an empty answer are said as what they are', async () => {
  const openai = LISTEN_PROVIDERS.find((one) => one.id === 'openai') as ListenProvider;
  const refusing = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(transcribe({ provider: openai, url: null, model: null, key: async () => 'wrong', fetch: refusing }, { bytes: CLIP, mime: 'audio/webm' }, null),
    /OpenAI refused the key \(401\): set it again in the console, under This deployment, Tools/);
  const wordless = providerFetch({ nothing: true });
  await assert.rejects(transcribe({ provider: openai, url: null, model: null, key: async () => 'k', fetch: wordless.fetch }, { bytes: CLIP, mime: 'audio/webm' }, null),
    /answered without the words/);
  await assert.rejects(transcribe({ provider: openai, url: null, model: null, key: async () => 'k', fetch: wordless.fetch }, { bytes: Buffer.alloc(0), mime: 'audio/webm' }, null),
    /the recording is empty/);
});

test('a role writes down a recording in the company\'s files, and only there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'palugada-listen-'));
  const companyId = randomUUID();
  mkdirSync(join(root, companyId, 'calls'), { recursive: true });
  writeFileSync(join(root, companyId, 'calls', 'customer.ogg'), CLIP);
  writeFileSync(join(root, 'elsewhere.ogg'), CLIP);
  symlinkSync(join(root, 'elsewhere.ogg'), join(root, companyId, 'calls', 'link.ogg'));
  writeFileSync(join(root, companyId, 'notes.txt'), 'not audio');
  const { fetch, heard } = providerFetch({ text: SAID });
  const groq = LISTEN_PROVIDERS.find((one) => one.id === 'groq')!;
  const capability = speechTranscribe({ provider: groq, url: null, model: null, key: async () => 'k', fetch, root });
  const ctx = { companyId, signal: AbortSignal.timeout(5_000) } as never;
  assert.deepEqual(await capability.execute({ path: 'calls/customer.ogg', language: 'id' }, ctx), { path: 'calls/customer.ogg', text: SAID });
  assert.equal(heard[0]!.filename, 'speech.ogg');
  await assert.rejects(capability.execute({ path: '../elsewhere.ogg' }, ctx), /inside the company's files/);
  await assert.rejects(capability.execute({ path: 'calls/link.ogg' }, ctx), /inside the company's files/, 'a link cannot lead out');
  await assert.rejects(capability.execute({ path: 'notes.txt' }, ctx), /a recording is/);
  await assert.rejects(capability.execute({ path: 'calls/missing.ogg' }, ctx), (error: unknown) => isPalugadaError(error, 'contract.violation') && /no recording/.test((error as Error).message));
  assert.equal(heard.length, 1, 'nothing refused was sent anywhere');

  const declared = STANDARD_CATALOGUE.find((one) => one.name === 'speech.transcribe');
  assert.equal(declared?.tier, 0, 'a read');
  assert.equal(declared?.readsOutside, true, 'what someone said is outside content (F8.9)');
  assert.equal(capability.defaultTier, 0);
});

test('the owner\'s voice needs no files: listening and speaking bind for the assistant without them, and roles are told why they cannot', () => {
  const env = {
    PALUGADA_LISTEN_PROVIDER: 'groq', PALUGADA_LISTEN_KEY_REF: 'db://tool-listen',
    PALUGADA_SPEECH_PROVIDER: 'openai', PALUGADA_SPEECH_KEY_REF: 'db://tool-speech', PALUGADA_SPEECH_VOICE: 'marin',
  };
  const without = toolBindingsFrom(env, async () => 'k');
  assert.equal(without.voice.listen?.provider.id, 'groq');
  assert.equal(without.voice.speak?.provider.id, 'openai');
  assert.equal(without.voice.speak?.voice, 'marin');
  assert.equal(without.listen, undefined);
  assert.match(without.notes.join('\n'), /speech\.transcribe is unbound for roles: .*PALUGADA_FILES_ROOT is not set; the owner can still speak/);
  const withFiles = toolBindingsFrom(env, async () => 'k', '/srv/files');
  assert.equal(withFiles.listen?.root, '/srv/files');
  assert.deepEqual(toolBindingsFrom({}, async () => 'k').voice, {});
});

test('the owner chooses what hears them, tries it with a clip, and speaks to the assistant, which answers aloud', async () => {
  const provider = await speechServer();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = (await api.call('GET', '/api/control/tools', token)).body;
    assert.ok(listed.providers.listen.some((one: { id: string }) => one.id === 'deepgram'));
    assert.deepEqual(listed.kinds.listen, { capability: 'speech.transcribe', source: null, provider: null, url: null, model: null, keySet: false, inUse: false });

    const tried = await api.call('POST', '/api/control/tools/listen/test', token,
      { provider: 'speaches', url: provider.url, model: 'Systran/faster-whisper-large-v3', audio: CLIP.toString('base64'), mime: 'audio/webm;codecs=opus', language: 'id' });
    assert.deepEqual(tried.body, { problem: null, text: SAID });
    assert.deepEqual(provider.heard.at(-1), { path: '/v1/audio/transcriptions', model: 'Systran/faster-whisper-large-v3', language: 'id', bytes: CLIP.length },
      'the model the owner typed, not the one the provider suggests');
    const noType = await api.call('POST', '/api/control/tools/listen/test', token, { provider: 'speaches', url: provider.url, audio: CLIP.toString('base64') });
    assert.match(String(noType.body.problem ?? noType.body.error), /what kind of audio/);

    const saved = await api.call('POST', '/api/control/tools/listen', token,
      { provider: 'speaches', url: provider.url, model: 'Systran/faster-whisper-small', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const env = withSettings({}, await readSettings());
    assert.equal(env.PALUGADA_LISTEN_PROVIDER, 'speaches');
    assert.equal(env.PALUGADA_LISTEN_MODEL, 'Systran/faster-whisper-small');
  } finally {
    await api.close();
  }

  // The next start: the assistant hears the owner and answers aloud.
  const bindings = toolBindingsFrom({
    PALUGADA_LISTEN_PROVIDER: 'speaches', PALUGADA_LISTEN_URL: provider.url,
    PALUGADA_SPEECH_PROVIDER: 'piper', PALUGADA_SPEECH_URL: provider.url,
  }, async () => 'k');
  const voiced = await consoleWithVoice(bindings.voice);
  try {
    const token = await voiced.signIn();
    await setDeploymentLanguages({ console: 'id' });
    assert.deepEqual((await voiced.call('GET', '/api/assistant', token)).body.voice, { listen: true, speak: true });
    const heard = await voiced.call('POST', '/api/assistant/listen', token, { audio: `data:audio/webm;base64,${CLIP.toString('base64')}`, mime: 'audio/webm' });
    assert.deepEqual(heard.body, { text: SAID });
    assert.equal(provider.heard.at(-1)!.language, 'id', 'heard in the language the owner reads the console in');
    const spoken = await voiced.call('POST', '/api/assistant/speak', token, { text: 'Laporan sudah siap.' });
    assert.equal(spoken.body.mime, 'audio/wav');
    assert.match(spoken.body.dataUrl, /^data:audio\/wav;base64,/);
    assert.equal(provider.said.at(-1), 'Laporan sudah siap.');
  } finally {
    await voiced.close();
  }
  const mute = await consoleWithVoice({});
  try {
    const token = await mute.signIn();
    const refused = await mute.call('POST', '/api/assistant/listen', token, { audio: CLIP.toString('base64'), mime: 'audio/webm' });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /choose a provider under This deployment, Tools, Listening/);
    const silent = await mute.call('POST', '/api/assistant/speak', token, { text: 'x' });
    assert.match(String(silent.body.error), /Tools, Speaking/);
  } finally {
    await mute.close();
  }
});

/** A speaches server for listening, and a Piper for speaking, on one port. */
/**
 * A saved key goes only to the address it was saved for. The tool settings
 * kept a saved key whenever the provider was the same, so a provider you run
 * yourself, tried at another address -- and a try needs no second factor --
 * was sent the key saved for the first. The model, MCP and push settings
 * already compared the address.
 */
test('a saved tool key is sent only to the address it was saved for (security)', async () => {
  const mine = await speechServer();
  const theirs = await speechServer();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const saved = await api.call('POST', '/api/control/tools/listen', token,
      { provider: 'speaches', url: mine.url, key: 'sk-speaches-saved-key', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const here = await api.call('POST', '/api/control/tools/listen/test', token,
      { provider: 'speaches', url: mine.url, audio: CLIP.toString('base64'), mime: 'audio/webm' });
    assert.deepEqual(here.body, { problem: null, text: SAID });
    assert.equal(mine.keys.at(-1), 'Bearer sk-speaches-saved-key', 'the saved key, at the address it was saved for');

    const there = await api.call('POST', '/api/control/tools/listen/test', token,
      { provider: 'speaches', url: theirs.url, audio: CLIP.toString('base64'), mime: 'audio/webm' });
    assert.equal(there.status, 200, JSON.stringify(there.body));
    assert.deepEqual(theirs.keys, [null], 'another address is sent no key it was not given');
  } finally {
    await api.close();
  }
});

async function speechServer() {
  const heard: Array<{ path: string; model: string; language: string; bytes: number }> = [];
  const said: string[] = [];
  const keys: Array<string | null> = [];
  const server = createServer((req, res) => {
    keys.push(req.headers.authorization ?? null);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/synthesize') {
        said.push((JSON.parse(body.toString()) as { text: string }).text);
        res.writeHead(200, { 'content-type': 'audio/wav' }).end(CLIP);
        return;
      }
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body }).formData();
      const file = form.get('file') as File;
      heard.push({ path: req.url!, model: String(form.get('model')), language: String(form.get('language')), bytes: file.size });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: SAID }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard, said, keys };
}

/** The console with a voice behind the assistant, as main.ts gives it one: a fresh one, so its authenticator enrols again. */
async function consoleWithVoice(voice: NonNullable<ConstructorParameters<typeof OwnerApi>[0]['assistant']>['voice']) {
  await resetData();
  return consoleWithSettings({ assistant: { llm: null, ...(voice ? { voice } : {}) } });
}
