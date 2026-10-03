/**
 * Money says its currency (the analysis of 3 October, §2.3 item 3).
 *
 * Every amount PALUGADA keeps is in US cents: providers price their models
 * in dollars per million tokens, runtimes report dollars, the catalogue
 * estimates in cents. The console printed amounts with no currency at all,
 * so an Indonesian owner read "Batas 200,00" and "Terpakai 0,75" as rupiah;
 * the chart beside them wrote "0.20" the English way; and an account's
 * ceiling was typed in cents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The console's own formatting, run as the browser runs it. Choosing a
// language writes to the document, which a test does not have.
(globalThis as { document?: unknown }).document = { documentElement: {} };
const { money } = await import('../../console/src/format.ts');
const { setLanguage } = await import('../../console/src/i18n.ts');

test('an amount is written as US dollars, the way the owner\'s language writes them', () => {
  setLanguage('en');
  assert.equal(money(75), '$0.75');
  assert.equal(money(20_000), '$200.00');
  setLanguage('id');
  assert.equal(money(75), 'US$0,75', 'not 0,75, which reads as rupiah');
  assert.equal(money(123_450), 'US$1.234,50');
  setLanguage('de');
  assert.equal(money(75), '0,75 $');
  setLanguage('en');
});

test('the money page writes every amount the same way, and nothing is typed in cents', async () => {
  const page = await readFile(fileURLToPath(new URL('../../console/src/pages/Money.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(page, /toFixed\(/, 'a figure written by toFixed is English whatever the language');
  assert.doesNotMatch(page, /\(cents\)/, 'an owner types money in dollars');
});
