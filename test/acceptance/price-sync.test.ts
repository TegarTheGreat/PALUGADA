/**
 * Prices that stay current (the owner's report of 7 October: "the prices do
 * not match the official ones").
 *
 * The platform keeps no price list of its own, on purpose: prices change
 * several times a year and a list compiled into a release is wrong by the next
 * one, silently. The answer it gave was models.dev's current prices, offered
 * to the owner to look at and save with their device -- which in practice
 * nobody did, so every call was charged at the top-of-market fallback, and a
 * price once typed was never updated. The owner's complaint is that the
 * money does not match the bill, and that they should not have to keep it so.
 *
 * Now the catalogue is read by the platform itself, daily, for the models the
 * deployment runs on, and kept as a layer under what the owner and the
 * operator say: their word wins, the catalogue's is next, and a model nobody
 * priced is still charged high. What came from where is visible.
 *
 * No database: the catalogue is a local mirror, and what the platform keeps is
 * a value in memory here (a setting in the deployment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { costOf, parsePriceTable, CONSERVATIVE_FALLBACK, DEFAULT_PRICE_TABLE } from '../../src/engine/pricing.ts';
import { PriceBook, type Catalogue } from '../../src/engine/price-book.ts';
import { syncPrices, syncIfStale, MAX_AGE_MS, RETRY_AFTER_MS } from '../../src/engine/price-sync.ts';
import { clearCatalogueCache } from '../../src/engine/models-dev.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

const SONNET = { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } };
const DEEPSEEK = { cost: { input: 0.27, output: 1.1, cache_read: 0.07 } };

/** A models.dev of the test's own, whose contents the test changes. */
async function mirror(initial: Record<string, unknown>) {
  let body = initial;
  let up = true;
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (!up) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api.json`,
    hits,
    set(next: Record<string, unknown>) { body = next; clearCatalogueCache(); },
    down() { up = false; clearCatalogueCache(); },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const full = (): Record<string, unknown> => ({
  anthropic: { name: 'Anthropic', models: { 'claude-sonnet-4-5': SONNET } },
  deepseek: { name: 'DeepSeek', api: 'https://api.deepseek.com', models: { 'deepseek-chat': DEEPSEEK } },
  freebies: { name: 'Freebies', models: { 'free-model': { cost: { input: 0, output: 0 } } } },
});

/** What the platform keeps between syncs, here in memory. */
function store(initial: Catalogue | null = null) {
  let kept = initial;
  return { read: async () => kept, write: async (next: Catalogue) => { kept = next; }, get kept() { return kept; } };
}

const where = { url: null, provider: null };

test('the catalogue is read for the models in use, with cache rates, in cents per million tokens', async () => {
  const api = await mirror(full());
  try {
    clearCatalogueCache();
    const kept = store();
    const catalogue = await syncPrices({ models: ['claude-sonnet-4-5', 'deepseek-chat'], where, source: api.url, ...kept });
    assert.deepEqual(catalogue.models['claude-sonnet-4-5'], { input: 300, output: 1_500, cacheRead: 30, cacheWrite: 375, provider: 'Anthropic' });
    assert.deepEqual(catalogue.models['deepseek-chat'], { input: 27, output: 110, cacheRead: 7, provider: 'DeepSeek' });
    assert.equal(catalogue.source, api.url);
    assert.ok(Date.now() - Date.parse(catalogue.syncedAt!) < 5_000);
    assert.deepEqual(kept.kept, catalogue, 'and kept');
    assert.equal(catalogue.problem, null);
  } finally {
    await api.close();
  }
});

test('a model the catalogue does not list, or lists as free, is left unpriced rather than priced at nothing', async () => {
  const api = await mirror(full());
  try {
    clearCatalogueCache();
    const catalogue = await syncPrices({ models: ['claude-sonnet-4-5', 'my-private-model', 'free-model'], where, source: api.url, ...store() });
    assert.deepEqual(Object.keys(catalogue.models), ['claude-sonnet-4-5']);
    assert.deepEqual(catalogue.unpriced, ['free-model', 'my-private-model'], 'said, so the owner sees which models are charged at the highest rate');
  } finally {
    await api.close();
  }
});

test('a price that moves is kept with what it was, and a model no longer in use is let go', async () => {
  const api = await mirror(full());
  try {
    clearCatalogueCache();
    const kept = store();
    await syncPrices({ models: ['claude-sonnet-4-5', 'deepseek-chat'], where, source: api.url, ...kept, now: new Date('2026-10-01T00:00:00Z') });
    assert.deepEqual(kept.kept!.changes.map((change) => [change.model, change.from]), [['claude-sonnet-4-5', null], ['deepseek-chat', null]]);

    api.set({ ...full(), anthropic: { name: 'Anthropic', models: { 'claude-sonnet-4-5': { cost: { input: 2.5, output: 12, cache_read: 0.25, cache_write: 3 } } } } });
    const next = await syncPrices({ models: ['claude-sonnet-4-5'], where, source: api.url, ...kept, now: new Date('2026-10-02T00:00:00Z') });
    assert.deepEqual(Object.keys(next.models), ['claude-sonnet-4-5'], 'the one no role runs on is not kept');
    const moved = next.changes.find((change) => change.from !== null)!;
    assert.deepEqual(moved, { model: 'claude-sonnet-4-5', from: { input: 300, output: 1_500 }, to: { input: 250, output: 1_200 }, at: '2026-10-02T00:00:00.000Z' });
  } finally {
    await api.close();
  }
});

test('a catalogue that cannot be read leaves the prices as they were, and says so', async () => {
  const api = await mirror(full());
  try {
    clearCatalogueCache();
    const kept = store();
    await syncPrices({ models: ['claude-sonnet-4-5'], where, source: api.url, ...kept, now: new Date('2026-10-01T00:00:00Z') });
    api.down();
    const later = await syncPrices({ models: ['claude-sonnet-4-5'], where, source: api.url, ...kept, now: new Date('2026-10-02T00:00:00Z') });
    assert.equal(later.models['claude-sonnet-4-5']!.input, 300, 'the price it had');
    assert.equal(later.syncedAt, '2026-10-01T00:00:00.000Z', 'which is as old as it was');
    assert.match(later.problem ?? '', /503|could not be read/);
    assert.equal(later.triedAt, '2026-10-02T00:00:00.000Z');

    // And a first sync that fails keeps nothing, and throws nothing.
    const bare = store();
    const none = await syncPrices({ models: ['claude-sonnet-4-5'], where, source: api.url, ...bare });
    assert.deepEqual(none.models, {});
    assert.ok(none.problem);
  } finally {
    await api.close();
  }
});

test('it is read when it is a day old, tried again an hour after a failure, and not otherwise', async () => {
  const api = await mirror(full());
  try {
    clearCatalogueCache();
    const kept = store();
    const base = { models: ['claude-sonnet-4-5'], where, source: api.url, ...kept };
    const t0 = new Date('2026-10-01T00:00:00Z');
    assert.equal((await syncIfStale({ ...base, now: t0 })).ran, true, 'never read: read');
    assert.equal((await syncIfStale({ ...base, now: new Date(t0.getTime() + MAX_AGE_MS - 1_000) })).ran, false, 'a day has not passed');
    const t2 = new Date(t0.getTime() + MAX_AGE_MS + 1_000);
    assert.equal((await syncIfStale({ ...base, now: t2 })).ran, true, 'a day has');

    api.down();
    const t1 = new Date(t2.getTime() + MAX_AGE_MS + 1_000);
    assert.equal((await syncIfStale({ ...base, now: t1 })).ran, true, 'stale, so tried -- and failed');
    assert.equal((await syncIfStale({ ...base, now: new Date(t1.getTime() + RETRY_AFTER_MS - 1_000) })).ran, false, 'not again at once');
    assert.equal((await syncIfStale({ ...base, now: new Date(t1.getTime() + RETRY_AFTER_MS + 1_000) })).ran, true, 'an hour after, again');
  } finally {
    await api.close();
  }
});

test('a model the last reading knew nothing of is a reason to read now, however fresh it is', async () => {
  const api = await mirror(full());
  try {
    clearCatalogueCache();
    const kept = store();
    const t0 = new Date('2026-10-01T00:00:00Z');
    const base = { where, source: api.url, ...kept };
    assert.equal((await syncIfStale({ ...base, models: ['claude-sonnet-4-5'], now: t0 })).ran, true);
    assert.equal((await syncIfStale({ ...base, models: ['claude-sonnet-4-5'], now: new Date(t0.getTime() + 60_000) })).ran, false);
    // The owner chose another model.
    const again = await syncIfStale({ ...base, models: ['claude-sonnet-4-5', 'deepseek-chat'], now: new Date(t0.getTime() + 120_000) });
    assert.equal(again.ran, true);
    assert.ok(again.catalogue!.models['deepseek-chat']);
    // One the catalogue does not list is known by now to be unpriced, and is not read for again.
    await syncIfStale({ ...base, models: ['claude-sonnet-4-5', 'deepseek-chat', 'my-private-model'], now: new Date(t0.getTime() + 180_000) });
    assert.equal((await syncIfStale({ ...base, models: ['claude-sonnet-4-5', 'deepseek-chat', 'my-private-model'], now: new Date(t0.getTime() + 240_000) })).ran, false);
  } finally {
    await api.close();
  }
});

test('what the owner and the operator say wins; the catalogue is next; a model nobody priced is still charged high', async () => {
  const file = parsePriceTable({ models: { 'claude-sonnet-*': { input: 400, output: 2_000 } } });
  const owner = JSON.stringify({ models: { 'deepseek-chat': { input: 50, output: 90 } } });
  const catalogue: Catalogue = {
    source: 'models.dev', syncedAt: '2026-10-01T00:00:00.000Z', problem: null, changes: [], unpriced: [],
    models: {
      'claude-sonnet-4-5': { input: 300, output: 1_500, cacheRead: 30, cacheWrite: 375, provider: 'Anthropic' },
      'deepseek-chat': { input: 27, output: 110, cacheRead: 7, provider: 'DeepSeek' },
      'gpt-5.4': { input: 250, output: 1_500, cacheRead: 25, provider: 'OpenAI' },
    },
  };
  const book = new PriceBook(file, { owner: async () => owner, catalogue: async () => catalogue });
  await book.refresh();

  // The operator's wildcard beats the catalogue's exact id: their word, however specific the other is.
  assert.equal(book.describe('claude-sonnet-4-5').layer, 'file');
  assert.equal(book.describe('claude-sonnet-4-5').rate.inputCentsPerMTok, 400);
  // The owner's, over the catalogue's.
  assert.equal(book.describe('deepseek-chat').layer, 'console');
  assert.equal(book.describe('deepseek-chat').rate.outputCentsPerMTok, 90);
  // Nobody said, the catalogue did, with who and when.
  const described = book.describe('gpt-5.4');
  assert.equal(described.layer, 'catalogue');
  assert.equal(described.provider, 'OpenAI');
  assert.equal(described.syncedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(described.rate.cacheReadCentsPerMTok, 25);
  // And nobody at all.
  const unknown = book.describe('a-model-nobody-listed');
  assert.equal(unknown.layer, 'fallback');
  assert.deepEqual(unknown.rate, CONSERVATIVE_FALLBACK);

  // The book is a price list: what prices a call prices it by the layers.
  near(costOf(book, 'gpt-5.4', { input: 1_000, output: 100, cacheRead: 9_000 }).cents, (1_000 * 250 + 100 * 1_500 + 9_000 * 25) / 1_000_000);
});

test('the book is the table the engine and the clients hold: what a refresh learns, they price by at once, with no restart', async () => {
  let owner: string | undefined;
  let catalogue: Catalogue | null = null;
  const book = new PriceBook(DEFAULT_PRICE_TABLE, { owner: async () => owner, catalogue: async () => catalogue });
  const held = book;
  assert.equal(costOf(held, 'm-1', { input: 1_000_000, output: 0 }).basis, 'fallback');

  catalogue = { source: 'models.dev', syncedAt: '2026-10-01T00:00:00.000Z', problem: null, changes: [], unpriced: [], models: { 'm-1': { input: 100, output: 200, provider: 'P' } } };
  await book.refresh();
  assert.deepEqual(costOf(held, 'm-1', { input: 1_000_000, output: 0 }), { cents: 100, basis: 'm-1' });

  owner = JSON.stringify({ models: { 'm-1': { input: 10, output: 20 } } });
  await book.refresh();
  assert.equal(costOf(held, 'm-1', { input: 1_000_000, output: 0 }).cents, 10);

  // A reader that fails leaves what was known: a database that blinks is not a reason to price at the fallback.
  const failing = new PriceBook(DEFAULT_PRICE_TABLE, { catalogue: async () => catalogue });
  await failing.refresh();
  assert.equal(failing.describe('m-1').layer, 'catalogue');
  const broken = new PriceBook(DEFAULT_PRICE_TABLE, { catalogue: async () => { throw new Error('the database is away'); } });
  await broken.refresh();
  assert.equal(broken.describe('m-1').layer, 'fallback', 'there was nothing to keep');
  let blink = false;
  const blinking = new PriceBook(DEFAULT_PRICE_TABLE, { catalogue: async () => { if (blink) throw new Error('away'); return catalogue; } });
  await blinking.refresh();
  blink = true;
  await blinking.refresh();
  assert.equal(blinking.describe('m-1').layer, 'catalogue', 'and the last good reading is kept');
});
