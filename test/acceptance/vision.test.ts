/**
 * `image.describe` (the tools research, recommendation 5;
 * src/capabilities/vision.ts): a role reads a picture in the company's files
 * -- a receipt, a screenshot, a product photo -- through the vision model the
 * owner chooses under Tools, as it reads a recording through Listening.
 *
 * Held to what the other tools are held to: each provider sent what its own
 * reference asks for, the key where it says, nothing sent until the owner
 * chose one; and to what `files.read` is held to: this company's files and
 * nothing beside them. What a picture says is from outside.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { imageDescribe, VISION_PROVIDERS } from '../../src/capabilities/vision.ts';
import { toolBindingsFrom } from '../../src/capabilities/tools.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
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

const refused = (code: string, said: RegExp) => (error: unknown) => isPalugadaError(error, code as never) && said.test((error as Error).message);

/** The smallest PNG there is: one transparent pixel. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const RECEIPT_SAID = 'Nota Toko Kopi Senja: 2 kopi susu, total Rp 30.000.';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Each provider's documented answer, and where its documentation puts the key. */
const ANSWERS: Record<string, { answer: unknown; key: (call: Seen) => string | null }> = {
  openai: { answer: { choices: [{ message: { role: 'assistant', content: RECEIPT_SAID } }] }, key: bearer },
  openrouter: { answer: { choices: [{ message: { role: 'assistant', content: RECEIPT_SAID } }] }, key: bearer },
  groq: { answer: { choices: [{ message: { role: 'assistant', content: RECEIPT_SAID } }] }, key: bearer },
  mistral: { answer: { choices: [{ message: { role: 'assistant', content: RECEIPT_SAID } }] }, key: bearer },
  gemini: { answer: { candidates: [{ content: { parts: [{ text: RECEIPT_SAID }] } }] }, key: (call) => call.headers['x-goog-api-key'] ?? null },
  anthropic: { answer: { content: [{ type: 'text', text: RECEIPT_SAID }] }, key: (call) => call.headers['x-api-key'] ?? null },
  'openai-compatible': { answer: { choices: [{ message: { role: 'assistant', content: RECEIPT_SAID } }] }, key: bearer },
};

function bearer(call: Seen): string | null {
  const value = call.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

function providerFetch(answer: unknown) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

async function companyFiles() {
  const root = await mkdtemp(join(tmpdir(), 'palugada-vision-'));
  const companyId = randomUUID();
  const mine = join(root, companyId);
  await mkdir(join(mine, 'nota'), { recursive: true });
  return { root, mine, ctx: { companyId, signal: AbortSignal.timeout(5_000) } as never };
}

test('every vision provider is sent the picture and the question as its reference says, and read the way it answers', async () => {
  assert.deepEqual(VISION_PROVIDERS.map((one) => one.id).sort(), Object.keys(ANSWERS).sort(), 'every provider has a documented answer here');
  const { root, mine, ctx } = await companyFiles();
  await writeFile(join(mine, 'nota', 'kopi.png'), PIXEL);
  for (const provider of VISION_PROVIDERS) {
    const { answer, key } = ANSWERS[provider.id]!;
    const { fetch, seen } = providerFetch(answer);
    const typed = provider.key === 'none' ? null : 'the-key-0123';
    const url = provider.urlExample ? 'http://vision.internal:11434/v1' : null;
    const describe = imageDescribe({ provider, url, key: async () => typed, model: null, fetch, root });
    const said = await describe.execute({ path: 'nota/kopi.png', question: 'Berapa totalnya?' }, ctx);
    assert.deepEqual(said, { path: 'nota/kopi.png', provider: provider.name, text: RECEIPT_SAID }, provider.id);
    const call = seen[0]!;
    assert.equal(key(call), typed, `${provider.id} carries its key where the provider reads it`);
    const sent = JSON.stringify(call.body);
    assert.ok(sent.includes(PIXEL.toString('base64')), `${provider.id} is sent the picture`);
    assert.ok(sent.includes('image/png'), `${provider.id} is told what kind of picture`);
    assert.ok(sent.includes('Berapa totalnya?'), `${provider.id} is sent the question`);
    assert.ok(sent.includes(provider.defaultModel) || call.url.includes(provider.defaultModel), `${provider.id} is asked with its model`);
    if (provider.urlExample) assert.ok(call.url.startsWith('http://vision.internal:11434/v1/'), `${provider.id} goes to the owner's own server`);
    else assert.ok(call.url.startsWith('https://'), `${provider.id} is reached over HTTPS`);
    if (typed) assert.ok(!call.url.includes(typed), `${provider.id} does not put its key in the address`);
  }
  // Mistral takes the picture as a string where the others take an object.
  const mistral = VISION_PROVIDERS.find((one) => one.id === 'mistral')!;
  const { fetch, seen } = providerFetch(ANSWERS.mistral!.answer);
  await imageDescribe({ provider: mistral, url: null, key: async () => 'k', model: null, fetch, root }).execute({ path: 'nota/kopi.png' }, ctx);
  const parts = (seen[0]!.body.messages as Array<{ content: Array<{ type: string; image_url?: unknown }> }>)[0]!.content;
  assert.equal(typeof parts.find((part) => part.type === 'image_url')!.image_url, 'string');
});

test('image.describe reads a picture in this company\'s files and nothing beside them, and says what it cannot read', async () => {
  const { root, mine, ctx } = await companyFiles();
  const provider = VISION_PROVIDERS.find((one) => one.id === 'openai')!;
  const { fetch, seen } = providerFetch(ANSWERS.openai!.answer);
  const describe = imageDescribe({ provider, url: null, key: async () => 'k', model: 'gpt-4.1-mini', fetch, root });
  // A JPEG, a WebP and a GIF are told by their bytes, whatever they are called.
  const kinds: Array<[string, Buffer, string]> = [
    ['foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]), 'image/jpeg'],
    ['layar.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    ['gerak.dat', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/gif'],
  ];
  for (const [name, bytes, mime] of kinds) {
    await writeFile(join(mine, name), bytes);
    await describe.execute({ path: name }, ctx);
    assert.ok(JSON.stringify(seen.at(-1)!.body).includes(`data:${mime};base64,`), name);
  }
  // Asked nothing, it is asked what a role reading a business's picture needs.
  assert.match(JSON.stringify(seen.at(-1)!.body), /every word and number/);

  const other = join(root, randomUUID());
  await mkdir(other);
  await writeFile(join(other, 'rahasia.png'), PIXEL);
  await symlink(join(other, 'rahasia.png'), join(mine, 'pintas.png'));
  const before = seen.length;
  for (const path of ['pintas.png', `../${other.split('/').at(-1)}/rahasia.png`, 'nota/../../x.png']) {
    await assert.rejects(describe.execute({ path }, ctx), refused('capability.unreachable', /outside the company's files/), path);
  }
  await writeFile(join(mine, 'catatan.txt'), 'bukan gambar');
  await assert.rejects(describe.execute({ path: 'catatan.txt' }, ctx), refused('contract.violation', /catatan\.txt is not a picture: a PNG, JPEG, WebP or GIF/));
  await writeFile(join(mine, 'besar.png'), Buffer.concat([PIXEL, Buffer.alloc(6 * 1024 * 1024)]));
  await assert.rejects(describe.execute({ path: 'besar.png' }, ctx), refused('contract.violation', /besar\.png is 6 MB; image\.describe sends pictures up to 5 MB/));
  assert.equal(seen.length, before, 'nothing was sent for what was refused');
});

test('image.describe is catalogued as a read from outside, and bound only when the owner chose a provider and there are files', () => {
  const declared = declarationFor('image.describe');
  assert.ok(declared);
  assert.deepEqual([declared.tier, declared.readsOutside], [0, true]);
  const resolve = async () => 'key';
  assert.match(toolBindingsFrom({}, resolve, '/tmp').notes.join('\n'), /image\.describe is unbound: choose a provider in the console/);
  assert.match(toolBindingsFrom({ PALUGADA_VISION_PROVIDER: 'gemini' }, resolve, '/tmp').notes.join('\n'), /image\.describe is unbound: Google Gemini needs a key/);
  assert.match(toolBindingsFrom({ PALUGADA_VISION_PROVIDER: 'gemini', PALUGADA_VISION_KEY_REF: 'env://GEMINI_KEY' }, resolve).notes.join('\n'),
    /image\.describe is unbound: the pictures it reads are the company's files, and PALUGADA_FILES_ROOT is not set/);
  const bound = toolBindingsFrom({ PALUGADA_VISION_PROVIDER: 'gemini', PALUGADA_VISION_KEY_REF: 'env://GEMINI_KEY', PALUGADA_VISION_MODEL: 'gemini-3.7-flash' }, resolve, '/tmp');
  assert.equal(bound.vision?.provider.id, 'gemini');
  assert.equal(bound.vision?.model, 'gemini-3.7-flash');
  assert.deepEqual(bound.notes.filter((note) => note.startsWith('image.describe')), []);
});

test('the owner chooses a vision provider in the console, tries it on a picture, and saves it', async () => {
  // A server of the owner's own, OpenAI-compatible, as Ollama is.
  const asked: Array<Record<string, unknown>> = [];
  const own = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      asked.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Satu titik transparan.' } }] }));
    });
  });
  await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
  servers.push(own);
  const base = `http://127.0.0.1:${(own.address() as AddressInfo).port}/v1`;
  const api = await consoleWithSettings({ baseEnv: { PALUGADA_FILES_ROOT: '/tmp' } });
  try {
    const token = await api.signIn();
    const listed = await api.call('GET', '/api/control/tools', token);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.kinds.vision, { capability: 'image.describe', source: null, provider: null, url: null, model: null, keySet: false, inUse: false });
    assert.deepEqual(listed.body.providers.vision.map((one: { id: string }) => one.id).sort(), VISION_PROVIDERS.map((one) => one.id).sort());

    const tried = await api.call('POST', '/api/control/tools/vision/test', token, {
      provider: 'openai-compatible', url: base, model: 'qwen2.5vl', image: `data:image/png;base64,${PIXEL.toString('base64')}`, question: 'Apa ini?',
    });
    assert.equal(tried.status, 200, JSON.stringify(tried.body));
    assert.deepEqual(tried.body, { problem: null, text: 'Satu titik transparan.' });
    assert.equal(asked[0]!.model, 'qwen2.5vl');
    const notPicture = await api.call('POST', '/api/control/tools/vision/test', token, {
      provider: 'openai-compatible', url: base, image: `data:text/plain;base64,${Buffer.from('halo').toString('base64')}`,
    });
    assert.match(String(notPicture.body.problem ?? notPicture.body.error), /a PNG, JPEG, WebP or GIF/);

    const saved = await api.call('POST', '/api/control/tools/vision', token, { provider: 'openai-compatible', url: base, model: 'qwen2.5vl' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const env = withSettings({}, await readSettings());
    assert.deepEqual([env.PALUGADA_VISION_PROVIDER, env.PALUGADA_VISION_URL, env.PALUGADA_VISION_MODEL], ['openai-compatible', base, 'qwen2.5vl']);
    const bound = toolBindingsFrom(env, async () => '', '/tmp');
    assert.equal(bound.vision?.provider.id, 'openai-compatible');
  } finally {
    await api.close();
  }
});
