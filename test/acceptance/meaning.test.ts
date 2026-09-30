/**
 * The company's documents, found by what they mean (F4.2).
 *
 * A role asking about the refund policy found nothing in a document titled
 * "Returns and money back": the search matched words, and pgvector sat
 * installed and unused. With a provider chosen under Tools, every passage is
 * given a vector in the background and a search ranks by words and meaning
 * together; without one, it is by words, as before.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { addDocument, searchDocuments } from '../../src/knowledge/documents.ts';
import { embedBacklog, queryMeaning, useMeaning } from '../../src/knowledge/meaning.ts';
import { embedProvider, type EmbedBinding } from '../../src/capabilities/embed.ts';
import { Engine } from '../../src/engine/engine.ts';
import { Worker } from '../../src/worker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(async () => {
  await resetData();
  useMeaning(null);
});
after(async () => {
  useMeaning(null);
  await closePools();
  await closeSetup();
});

/**
 * An embeddings server whose vectors are three ideas: money coming back,
 * coffee being roasted, and anything else. Written the way OpenAI's answers.
 */
async function fakeEmbeddings(): Promise<{ url: string; asked: Array<{ model: string; input: string[]; authorization: string | undefined }>; close: () => Promise<void> }> {
  const asked: Array<{ model: string; input: string[]; authorization: string | undefined }> = [];
  const idea = (text: string): number[] => {
    const lower = text.toLowerCase();
    if (/refund|money back|send .* back|returns?\b/.test(lower)) return [1, 0.05, 0];
    if (/roast|beans|coffee/.test(lower)) return [0, 1, 0.05];
    return [0.05, 0, 1];
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; input: string[] };
      asked.push({ model: body.model, input: body.input, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list', model: body.model,
        data: body.input.map((text, index) => ({ object: 'embedding', index, embedding: idea(text) })).reverse(),
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/v1`, asked, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A search as a role's makes it: the question's meaning first, then the passages. */
async function search(companyId: string, divisionId: string, query: string) {
  const meaning = await queryMeaning(query);
  return withTenant(companyId, (tx) => searchDocuments(tx, { divisionId, query, limit: 3, ...(meaning ? { meaning } : {}) }));
}

const binding = (url: string, model: string | null = null): EmbedBinding => ({
  provider: embedProvider('openai-compatible')!, url, model, key: async () => 'embed-key-0123456789',
});

async function documents(companyId: string) {
  await addDocument(companyId, {
    title: 'Returns and money back', divisionId: null,
    body: 'A customer may send a bag back within fourteen days of delivery. We pay them back in full once it arrives.',
  });
  await addDocument(companyId, {
    title: 'Roasting schedule', divisionId: null,
    body: 'We roast the beans every Tuesday and Friday, and ship the morning after.',
  });
}

test('with a provider, a question finds the passage that means it, though they share no word', async () => {
  const fixture = await createCompany('meaning-search');
  const server = await fakeEmbeddings();
  try {
    await documents(fixture.companyId);
    assert.deepEqual(await search(fixture.companyId, fixture.divisionId, 'refund policy'), [],
      'by words alone, nothing: neither document says refund or policy');

    const meaning = binding(server.url);
    const done = await embedBacklog(fixture.companyId, meaning);
    assert.equal(done, 2, 'each passage given its vector');
    assert.equal(server.asked[0]!.authorization, 'Bearer embed-key-0123456789');
    assert.equal(server.asked[0]!.model, 'bge-m3', 'the provider\'s default model when none is chosen');
    assert.equal(await embedBacklog(fixture.companyId, meaning), 0, 'and not again');

    useMeaning(meaning);
    const found = await search(fixture.companyId, fixture.divisionId, 'refund policy');
    assert.equal(found[0]?.title, 'Returns and money back');
    assert.ok(!found.some((one) => one.title === 'Roasting schedule'), 'a passage is not found for being the only other one');

    // Words still count: a query that names the words finds them.
    const roast = await search(fixture.companyId, fixture.divisionId, 'Tuesday');
    assert.equal(roast[0]?.title, 'Roasting schedule');
  } finally {
    await server.close();
  }
});

test('a passage embedded with one model is embedded again when the owner chooses another, and never compared across them', async () => {
  const fixture = await createCompany('meaning-model');
  const server = await fakeEmbeddings();
  try {
    await documents(fixture.companyId);
    assert.equal(await embedBacklog(fixture.companyId, binding(server.url, 'first-model')), 2);
    const second = binding(server.url, 'second-model');
    useMeaning(second);
    // Not yet embedded with the second model: found by words only, not by the first model's vectors.
    assert.deepEqual(await search(fixture.companyId, fixture.divisionId, 'refund policy'), []);
    assert.equal(await embedBacklog(fixture.companyId, second), 2);
    const found = await search(fixture.companyId, fixture.divisionId, 'refund policy');
    assert.equal(found[0]?.title, 'Returns and money back');
  } finally {
    await server.close();
  }
});

test('the worker gives new passages their vectors as it ticks', async () => {
  const fixture = await createCompany('meaning-worker');
  const server = await fakeEmbeddings();
  try {
    await documents(fixture.companyId);
    const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-meaning' });
    const worker = new Worker({ engine, companyId: fixture.companyId, meaning: binding(server.url) });
    const report = await worker.tick();
    assert.equal(report.embedded, 2);
    const left = await withTenant(fixture.companyId, (tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_passages WHERE embedding IS NULL'));
    assert.equal(left.rows[0]!.n, 0);
  } finally {
    await server.close();
  }
});

test('the owner chooses Meaning under Tools: tried with a sentence, saved with a factor, and bound at the next start', async () => {
  const { consoleWithSettings } = await import('../helpers/owner-console.ts');
  const { toolBindingsFrom } = await import('../../src/capabilities/tools.ts');
  const { withSettings } = await import('../../src/settings/overlay.ts');
  const { readSettings } = await import('../../src/settings/store.ts');
  const server = await fakeEmbeddings();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = (await api.call('GET', '/api/control/tools', token)).body;
    assert.deepEqual(listed.providers.embed.map((one: { id: string }) => one.id),
      ['openai', 'gemini', 'mistral', 'voyage', 'jina', 'ollama', 'openai-compatible']);
    assert.equal(listed.kinds.embed.provider, null);

    const tried = await api.call('POST', '/api/control/tools/embed/test', token,
      { provider: 'ollama', url: server.url, model: 'nomic-embed-text', text: 'What is our refund policy?' });
    assert.deepEqual(tried.body, { problem: null, dimensions: 3 });
    assert.deepEqual(server.asked.at(-1)!.input, ['What is our refund policy?']);
    assert.equal(server.asked.at(-1)!.authorization, undefined, 'Ollama is sent no key');

    assert.equal((await api.call('POST', '/api/control/tools/embed', token, { provider: 'ollama', url: server.url, model: 'nomic-embed-text' })).status, 403);
    const saved = await api.call('POST', '/api/control/tools/embed', token,
      { provider: 'ollama', url: server.url, model: 'nomic-embed-text', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const bound = toolBindingsFrom(withSettings({}, await readSettings()), async () => '');
    assert.equal(bound.embed?.provider.id, 'ollama');
    assert.equal(bound.embed?.model, 'nomic-embed-text');
    assert.equal(bound.embed?.url, server.url);
  } finally {
    await api.close();
    await server.close();
  }
});

test('a provider on the owner\'s own server without its address is named, not bound', async () => {
  const { toolBindingsFrom } = await import('../../src/capabilities/tools.ts');
  const bound = toolBindingsFrom({ PALUGADA_EMBED_PROVIDER: 'ollama' }, async () => '');
  assert.equal(bound.embed, undefined);
  assert.ok(bound.notes.some((note) => /document meaning is unbound: Ollama is your own server, and PALUGADA_EMBED_URL gives no address/.test(note)), bound.notes.join('\n'));
});
