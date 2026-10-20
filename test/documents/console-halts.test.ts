/**
 * Why a task stopped is said in the owner's language, with what they can do
 * about it (the analysis of 3 October, §2.3 item 7).
 *
 * The task's "Why it stopped" was the platform's own record of the halt --
 * "shared budget exhausted", "delegation depth 4 exceeds hop_max 3" -- in
 * English whatever the console's language, and the timeline printed it again
 * under the event. The record is kept, for whoever needs it, but the owner
 * is told first what happened in their language.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Loaded by address, as `console-money.test.ts` explains: the console is typed
// for a browser, and choosing a language writes to the document.
(globalThis as { document?: unknown }).document = { documentElement: {} };
const console_ = (path: string) => new URL(`../../console/src/${path}`, import.meta.url).href;
const { whyStopped, eventDetail } = await import(console_('format.ts')) as {
  whyStopped: (reason: string | null, detail: unknown) => { said: string | null; record: string | null };
  eventDetail: (payload: Record<string, unknown>) => string | null;
};
const { setLanguage } = await import(console_('i18n.ts')) as { setLanguage: (language: string) => void };

const source = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

test('every reason a task can stop is explained, not only named', async () => {
  const domain = await source('src/domain/task.ts');
  const union = domain.slice(domain.indexOf('export type HaltReason'), domain.indexOf(';', domain.indexOf('export type HaltReason')));
  const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
  assert.ok(reasons.length >= 15, `found only ${reasons.length} halt reasons`);
  const format = await source('console/src/format.ts');
  const table = format.slice(format.indexOf('const HALT_EXPLAINED'), format.indexOf('export function whyStopped'));
  assert.ok(table.length > 0, 'console/src/format.ts keeps HALT_EXPLAINED');
  const explained = new Set([...table.matchAll(/^ {2}([a-z_]+): N\(/gm)].map((match) => match[1]!));
  // Work its run did not do is explained by the run, in its own words (N9).
  const missing = reasons.filter((reason) => reason !== 'not_done' && !explained.has(reason));
  assert.deepEqual(missing, [], `halts the owner is told only by the platform's record: ${missing.join(', ')}`);
});

test("why it stopped is the owner's language first, and the platform's record is kept apart", () => {
  setLanguage('id');
  const budget = whyStopped('budget_exhausted', 'shared budget exhausted');
  assert.ok(budget.said, 'something is said');
  assert.doesNotMatch(budget.said!, /budget|exhausted/i, 'not the record, and not English');
  assert.equal(budget.record, 'shared budget exhausted');

  const hops = whyStopped('hop_limit', 'delegation depth 4 exceeds hop_max 3');
  assert.doesNotMatch(hops.said!, /hop_max|delegation/);
  assert.equal(hops.record, 'delegation depth 4 exceeds hop_max 3');

  // The run's own reason is already what the owner needs (N9).
  assert.deepEqual(whyStopped('not_done', 'Pemasok belum menjawab.'), { said: 'Pemasok belum menjawab.', record: null });
  setLanguage('en');
});

test('the timeline says a halt by its reason, and keeps what a service said', () => {
  setLanguage('id');
  assert.equal(eventDetail({ haltReason: 'budget_exhausted', detail: 'shared budget exhausted' }), 'Kehabisan anggaran');
  assert.equal(eventDetail({ haltReason: 'not_done', detail: 'Pemasok belum menjawab.' }), 'Pemasok belum menjawab.');
  // A vendor's own words cannot be translated, and are the next thing to fix.
  assert.equal(eventDetail({ error: 'HTTP 401 from api.example.com' }), 'HTTP 401 from api.example.com');
  assert.equal(eventDetail({ tier: 2 }), null);
  setLanguage('en');
});

test("the task drawer does not show a halt's record as its why", async () => {
  const work = await source('console/src/pages/Work.tsx');
  assert.match(work, /whyStopped\(/);
  assert.match(work, /eventDetail\(/);
  assert.doesNotMatch(work, /String\(event\.payload\.detail/, 'the timeline printed the record under the event');
});
