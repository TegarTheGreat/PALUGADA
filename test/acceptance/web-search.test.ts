/**
 * Searching the web and reading a page, through the provider the owner chose.
 *
 * A role that had to research something could fetch a page it already knew
 * and could not find one. `web.search` and `web.extract` go to a provider,
 * like the model; these hold each provider to the request its documentation
 * describes -- where the key goes above all, since a key in the wrong header
 * is a refusal and a key in the wrong place is a leak -- and to reading the
 * answer it documents. Every provider in the catalogue has an answer here, so
 * one added without being checked fails.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import {
  EXTRACT_PROVIDERS, SEARCH_PROVIDERS, webExtract, webSearch,
} from '../../src/capabilities/search.ts';
import { toolBindingsFrom } from '../../src/capabilities/tools.ts';
import { STANDARD_CATALOGUE } from '../../src/broker/catalogue.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  await closePools();
  await closeSetup();
});

/** Each search provider's documented answer, and where its key must go. */
const SEARCH_ANSWERS: Record<string, { answer: unknown; key: (call: Seen) => string | null }> = {
  brave: { answer: { web: { results: [{ title: 'T', url: 'https://a.example/', description: 'S' }] } }, key: (call) => call.headers['x-subscription-token'] ?? null },
  tavily: { answer: { results: [{ title: 'T', url: 'https://a.example/', content: 'S', score: 0.9 }] }, key: bearerOf },
  exa: { answer: { results: [{ title: 'T', url: 'https://a.example/', highlights: ['S'] }], costDollars: { total: 0.007 } }, key: (call) => call.headers['x-api-key'] ?? null },
  firecrawl: { answer: { success: true, data: { web: [{ title: 'T', url: 'https://a.example/', description: 'S', position: 1 }] } }, key: bearerOf },
  perplexity: { answer: { results: [{ title: 'T', url: 'https://a.example/', snippet: 'S', date: '2026-09-01' }] }, key: bearerOf },
  parallel: { answer: { results: [{ url: 'https://a.example/', title: 'T', excerpts: ['S'] }] }, key: (call) => call.headers['x-api-key'] ?? null },
  keenable: { answer: { results: [{ title: 'T', url: 'https://a.example/', snippet: 'S' }] }, key: (call) => call.headers['x-api-key'] ?? null },
  jina: { answer: { code: 200, data: [{ title: 'T', url: 'https://a.example/', description: 'S' }] }, key: bearerOf },
  serpapi: { answer: { organic_results: [{ title: 'T', link: 'https://a.example/', snippet: 'S' }] }, key: (call) => new URL(call.url).searchParams.get('api_key') },
  serper: { answer: { organic: [{ title: 'T', link: 'https://a.example/', snippet: 'S' }] }, key: (call) => call.headers['x-api-key'] ?? null },
  searxng: { answer: { results: [{ title: 'T', url: 'https://a.example/', content: 'S' }] }, key: () => null },
  'firecrawl-self-hosted': { answer: { data: { web: [{ title: 'T', url: 'https://a.example/', description: 'S' }] } }, key: bearerOf },
};

const EXTRACT_ANSWERS: Record<string, { answer: unknown; key: (call: Seen) => string | null }> = {
  jina: { answer: { code: 200, data: { title: 'T', url: 'https://a.example/', content: 'Body' } }, key: bearerOf },
  firecrawl: { answer: { success: true, data: { markdown: 'Body', metadata: { title: 'T', sourceURL: 'https://a.example/' } } }, key: bearerOf },
  tavily: { answer: { results: [{ url: 'https://a.example/', raw_content: 'Body' }], failed_results: [] }, key: bearerOf },
  exa: { answer: { results: [{ url: 'https://a.example/', title: 'T', text: 'Body' }] }, key: (call) => call.headers['x-api-key'] ?? null },
  parallel: { answer: { results: [{ url: 'https://a.example/', title: 'T', full_content: 'Body' }] }, key: (call) => call.headers['x-api-key'] ?? null },
  keenable: { answer: { url: 'https://a.example/', title: 'T', content: 'Body' }, key: (call) => call.headers['x-api-key'] ?? null },
  'firecrawl-self-hosted': { answer: { success: true, data: { markdown: 'Body', metadata: { title: 'T', sourceURL: 'https://a.example/' } } }, key: bearerOf },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function bearerOf(call: Seen): string | null {
  const value = call.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

/** A fetch that answers as the provider documents, and remembers what it was sent. */
function providerFetch(answer: unknown) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      method: String(init.method),
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

// A fresh signal for every call: one made when the file loads runs out five
// seconds later, and a slow suite reached the last test after that.
const ctx = () => ({ signal: AbortSignal.timeout(5_000) }) as never;

test('every search provider is sent the query and its key where its documentation says, and read the way it answers', async () => {
  assert.deepEqual(SEARCH_PROVIDERS.map((one) => one.id).sort(), Object.keys(SEARCH_ANSWERS).sort(), 'every provider has a documented answer here');
  for (const provider of SEARCH_PROVIDERS) {
    const { answer, key } = SEARCH_ANSWERS[provider.id]!;
    const { fetch, seen } = providerFetch(answer);
    const url = provider.urlExample ? 'http://search.internal:8888' : null;
    const typed = provider.key === 'none' ? null : 'the-key-0123';
    const result = await webSearch({ provider, url, key: async () => typed, fetch }).execute({ query: 'palugada agents', count: 3 }, ctx());
    assert.deepEqual(result.results, [{ title: 'T', url: 'https://a.example/', snippet: 'S' }], provider.id);
    assert.equal(key(seen[0]!), typed, `${provider.id} carries its key where the provider reads it`);
    const sent = `${seen[0]!.url} ${JSON.stringify(seen[0]!.body ?? {})}`;
    assert.ok(sent.includes('palugada') , `${provider.id} is sent the query`);
    if (provider.urlExample) assert.ok(seen[0]!.url.startsWith('http://search.internal:8888/'), `${provider.id} goes to the owner's own server`);
    else assert.ok(seen[0]!.url.startsWith('https://'), `${provider.id} is reached over HTTPS`);
    // A key sent only where it belongs: never in the address unless the
    // provider takes it there, and never in a header meant for another.
    if (provider.id !== 'serpapi' && typed) assert.ok(!seen[0]!.url.includes(typed), `${provider.id} does not put its key in the address`);
  }
});

test('a provider with a free tier is asked without a key the way it documents, and a key when there is one', async () => {
  const tavily = SEARCH_PROVIDERS.find((one) => one.id === 'tavily')!;
  const keyless = providerFetch(SEARCH_ANSWERS.tavily!.answer);
  await webSearch({ provider: tavily, url: null, key: async () => null, fetch: keyless.fetch }).execute({ query: 'q' }, ctx());
  assert.equal(keyless.seen[0]!.headers['x-tavily-access-mode'], 'keyless');
  assert.equal(keyless.seen[0]!.headers.authorization, undefined);

  const keenable = SEARCH_PROVIDERS.find((one) => one.id === 'keenable')!;
  const publicTier = providerFetch(SEARCH_ANSWERS.keenable!.answer);
  await webSearch({ provider: keenable, url: null, key: async () => null, fetch: publicTier.fetch }).execute({ query: 'q' }, ctx());
  assert.equal(publicTier.seen[0]!.url, 'https://api.keenable.ai/v1/search/public');
  assert.equal(publicTier.seen[0]!.headers['x-keenable-title'], 'PALUGADA', 'its free tier asks which application is calling');
});

test('every page reader returns the page as text, capped, and says which page it was', async () => {
  assert.deepEqual(EXTRACT_PROVIDERS.map((one) => one.id).sort(), Object.keys(EXTRACT_ANSWERS).sort());
  for (const provider of EXTRACT_PROVIDERS) {
    const { answer, key } = EXTRACT_ANSWERS[provider.id]!;
    const { fetch, seen } = providerFetch(answer);
    const typed = provider.key === 'none' ? null : 'the-key-0123';
    const url = provider.urlExample ? 'http://reader.internal:3002/' : null;
    const page = await webExtract({ provider, url, key: async () => typed, fetch }).execute({ url: 'https://a.example/' }, ctx());
    assert.equal(page.text, 'Body', provider.id);
    assert.equal(page.url, 'https://a.example/');
    assert.equal(key(seen[0]!), typed, `${provider.id} carries its key where the provider reads it`);
    if (provider.urlExample) assert.ok(seen[0]!.url.startsWith('http://reader.internal:3002/v2/'), `${provider.id} goes to the owner's own server`);
    else assert.ok(seen[0]!.url.startsWith('https://'), `${provider.id} is reached over HTTPS`);
  }
  const jina = EXTRACT_PROVIDERS.find((one) => one.id === 'jina')!;
  const long = providerFetch({ data: { title: 'T', url: 'https://a.example/', content: 'x'.repeat(70_000) } });
  const capped = await webExtract({ provider: jina, url: null, key: async () => null, fetch: long.fetch }).execute({ url: 'https://a.example/' }, ctx());
  assert.equal(capped.text.length, 60_000);
  assert.equal(capped.truncated, true);
  const empty = providerFetch({ data: { title: 'T', url: 'https://a.example/', content: '' } });
  await assert.rejects(webExtract({ provider: jina, url: null, key: async () => null, fetch: empty.fetch }).execute({ url: 'https://a.example/' }, ctx()),
    /returned nothing readable/);
});

test('a role is held to ten results however many it asks for, and gets five when it names none', async () => {
  const brave = SEARCH_PROVIDERS.find((one) => one.id === 'brave')!;
  const many = Array.from({ length: 20 }, (_, index) => ({ title: `T${index}`, url: `https://a.example/${index}`, description: 'S' }));
  const asked = providerFetch({ web: { results: many } });
  const greedy = await webSearch({ provider: brave, url: null, key: async () => 'k', fetch: asked.fetch }).execute({ query: 'q', count: 50 }, ctx());
  assert.equal(new URL(asked.seen[0]!.url).searchParams.get('count'), '10');
  assert.equal(greedy.results.length, 10);
  const plain = await webSearch({ provider: brave, url: null, key: async () => 'k', fetch: asked.fetch }).execute({ query: 'q' }, ctx());
  assert.equal(new URL(asked.seen[1]!.url).searchParams.get('count'), '5');
  assert.equal(plain.results.length, 5);
});

test('a refused key is said as a refused key, naming where to set it again', async () => {
  const brave = SEARCH_PROVIDERS.find((one) => one.id === 'brave')!;
  const fetch = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(webSearch({ provider: brave, url: null, key: async () => 'wrong', fetch }).execute({ query: 'q' }, ctx()),
    /Brave Search refused the key \(401\): set it again in the console, under This deployment, Tools/);
});

test('what is found and read comes from outside the company, and is marked so', () => {
  for (const name of ['web.search', 'web.extract']) {
    const declared = STANDARD_CATALOGUE.find((one) => one.name === name);
    assert.equal(declared?.readsOutside, true, `${name} carries F8.9's provenance`);
    assert.equal(declared?.tier, 0);
  }
});

test('a tool with no provider, or one it cannot use, is a note at boot, not a silent absence', () => {
  const resolve = async () => 'k';
  assert.match(toolBindingsFrom({}, resolve).notes.join('\n'), /web\.search is unbound: choose a provider in the console/);
  assert.match(toolBindingsFrom({ PALUGADA_SEARCH_PROVIDER: 'duckduckgo' }, resolve).notes.join('\n'), /names duckduckgo, which is not a provider known here/);
  assert.match(toolBindingsFrom({ PALUGADA_SEARCH_PROVIDER: 'searxng' }, resolve).notes.join('\n'), /SearXNG is your own server, and PALUGADA_SEARCH_URL gives no address/);
  assert.match(toolBindingsFrom({ PALUGADA_SEARCH_PROVIDER: 'brave' }, resolve).notes.join('\n'), /Brave Search needs a key/);
  const bound = toolBindingsFrom({ PALUGADA_SEARCH_PROVIDER: 'tavily', PALUGADA_EXTRACT_PROVIDER: 'jina' }, resolve);
  assert.deepEqual(bound.notes.filter((note) => /^web\./.test(note)), [], 'pictures and speech are unbound here, and say so on their own');
  assert.equal(bound.search?.provider.id, 'tavily');
  assert.equal(bound.extract?.provider.id, 'jina');
});

test('the owner chooses a search provider and a page reader in the console, tries them, and saves them with their device', async () => {
  const search = await searxngServer();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = await api.call('GET', '/api/control/tools', token);
    assert.equal(listed.body.kinds.search.provider, null);
    assert.ok(listed.body.providers.search.some((one: { id: string }) => one.id === 'brave'));
    assert.ok(!('request' in listed.body.providers.search[0]), 'a provider is described, not handed over');

    const tried = await api.call('POST', '/api/control/tools/search/test', token, { provider: 'searxng', url: search.url, query: 'palugada' });
    assert.deepEqual(tried.body, { problem: null, results: [{ title: 'PALUGADA', url: 'https://palugada.example/', snippet: 'companies run by agents' }] });
    assert.equal(search.queries.at(-1), 'palugada');
    assert.equal((await readSettings()).tools, undefined, 'trying saves nothing');

    const keyless = await api.call('POST', '/api/control/tools/search', token, { provider: 'brave', proof: { totp: api.code() } });
    assert.equal(keyless.status, 400);
    assert.match(String(keyless.body.error), /Brave Search needs a key/);
    const unproved = await api.call('POST', '/api/control/tools/search', token, { provider: 'searxng', url: search.url });
    assert.equal(unproved.status, 403);
    const keyed = await api.call('POST', '/api/control/tools/search', token, { provider: 'brave', key: 'brave-key-0123', proof: { totp: api.code() } });
    assert.equal(keyed.status, 200, JSON.stringify(keyed.body));
    assert.equal(await api.secrets.resolve('db://tool-search'), 'brave-key-0123');
    const again = await api.call('POST', '/api/control/tools/search', token, { provider: 'brave', proof: { totp: api.code() } });
    assert.equal(again.status, 200, 'saving the same provider again keeps its key');
    const own = await api.call('POST', '/api/control/tools/search', token, { provider: 'searxng', url: search.url, proof: { totp: api.code() } });
    assert.equal(own.status, 200);
    await assert.rejects(api.secrets.resolve('db://tool-search'), /nothing is stored/, 'a provider that takes no key keeps none');
    const reader = await api.call('POST', '/api/control/tools/extract', token, { provider: 'jina', proof: { totp: api.code() } });
    assert.equal(reader.status, 200);

    // The next start binds them, and a search goes to the owner's own server.
    const env = withSettings({ PALUGADA_EXTRACT_PROVIDER: 'firecrawl' }, await readSettings());
    assert.equal(env.PALUGADA_SEARCH_PROVIDER, 'searxng');
    assert.equal(env.PALUGADA_SEARCH_URL, search.url);
    assert.equal(env.PALUGADA_EXTRACT_PROVIDER, 'jina', 'the console\'s reader in place of the environment\'s');
    const bound = toolBindingsFrom(env, (reference) => api.secrets.resolve(reference));
    assert.deepEqual(bound.notes.filter((note) => /^web\./.test(note)), []);
    const found = await webSearch(bound.search!).execute({ query: 'what runs itself' }, ctx());
    assert.equal(found.results[0]!.url, 'https://palugada.example/');
    assert.equal(search.queries.at(-1), 'what runs itself');

    const listedAfter = (await api.call('GET', '/api/control/tools', token)).body;
    assert.deepEqual(listedAfter.kinds.search, {
      capability: 'web.search', source: 'console', provider: 'searxng', url: search.url, keySet: false, inUse: false,
    });
    const cleared = await api.call('POST', '/api/control/tools/search/clear', token, { proof: { totp: api.code() } });
    assert.equal(cleared.status, 200);
    assert.equal(((await readSettings()).tools as Record<string, unknown>).search, undefined);
  } finally {
    await api.close();
  }
});

test('a deployment with a search provider chosen gives its roles web.search; one without says so', async () => {
  const search = await searxngServer();
  const { start } = await import('../../src/main.ts');
  const without = await start({ port: 0, env: {}, worker: { idleMs: 60_000 } });
  try {
    assert.ok(without.notes.some((note) => /web\.search is unbound/.test(note)));
  } finally {
    await without.stop();
  }
  const withIt = await start({ port: 0, env: { PALUGADA_SEARCH_PROVIDER: 'searxng', PALUGADA_SEARCH_URL: search.url }, worker: { idleMs: 60_000 } });
  try {
    assert.ok(!withIt.notes.some((note) => /web\.search is unbound/.test(note)), withIt.notes.join('\n'));
    assert.match(withIt.notes.find((note) => note.startsWith('bound by the platform:')) ?? '', /web\.search/);
  } finally {
    await withIt.stop();
  }
});

test('with no page reader chosen, the deployment\'s browser reads pages, and boot says which', { skip: chromium() ? false : 'no Chromium here' }, async () => {
  const { start } = await import('../../src/main.ts');
  const off = await start({ port: 0, env: { PALUGADA_BROWSER: 'off' }, worker: { idleMs: 60_000 } });
  try {
    assert.ok(off.notes.includes('web.extract is unbound: choose a provider in the console, under This deployment, Tools'), off.notes.join('\n'));
  } finally {
    await off.stop();
  }
  const own = await start({ port: 0, env: { PALUGADA_CHROMIUM: chromium()! }, worker: { idleMs: 60_000 } });
  try {
    assert.ok(!own.notes.some((note) => note.startsWith('web.extract is unbound')), own.notes.join('\n'));
    assert.ok(own.notes.includes('web.extract reads pages in this deployment\'s browser, as no provider is bound: '
      + 'choose a provider in the console, under This deployment, Tools'), own.notes.join('\n'));
    assert.match(own.notes.find((note) => note.startsWith('bound by the platform:')) ?? '', /web\.extract/);
  } finally {
    await own.stop();
  }
});

/** A SearXNG answering JSON, as `format=json` makes it. */
async function searxngServer(): Promise<{ url: string; queries: string[] }> {
  const queries: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/search' || url.searchParams.get('format') !== 'json') {
      res.writeHead(404).end();
      return;
    }
    queries.push(url.searchParams.get('q') ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'PALUGADA', url: 'https://palugada.example/', content: 'companies run by agents' }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries };
}

