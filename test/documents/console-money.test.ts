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
// language writes to the document, which a test does not have. Loaded by
// address rather than by name: the console is typed for a browser, and the
// server's type check has no document to give it.
(globalThis as { document?: unknown }).document = { documentElement: {} };
const console_ = (path: string) => new URL(`../../console/src/${path}`, import.meta.url).href;
const { money, centsFrom, typedFrom, setMoneyDisplay } = await import(console_('format.ts')) as {
  money: (cents: number) => string;
  centsFrom: (typed: string | number) => number;
  typedFrom: (cents: number) => number;
  setMoneyDisplay: (display: { currency: string; rate: number } | null) => void;
};
const { setLanguage } = await import(console_('i18n.ts')) as { setLanguage: (language: string) => void };

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

/**
 * The owner may read money in their own currency at a rate they set (§9 P1
 * item 13): every amount is shown in it, and what they type is read in it.
 * PALUGADA keeps counting in US cents.
 */
test("amounts are shown and typed in the owner's currency when they chose one", async () => {
  setLanguage('id');
  setMoneyDisplay({ currency: 'IDR', rate: 16_500 });
  assert.match(money(75), /^Rp\s?12\.375$/u, '0.75 dollars at 16,500 rupiah each');
  assert.equal(centsFrom('12375'), 75, 'typed in rupiah, kept in cents');
  assert.equal(typedFrom(75), 12_375);
  setMoneyDisplay(null);
  assert.equal(money(75), 'US$0,75');
  assert.equal(centsFrom('0.75'), 75);
  assert.equal(typedFrom(75), 0.75);
  setLanguage('en');

  // Every amount the owner types goes through the same conversion.
  for (const name of ['Money.tsx', 'Settings.tsx']) {
    const page = await readFile(fileURLToPath(new URL(`../../console/src/pages/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(page, /\* 100\)/, `${name} turns what was typed into cents as dollars, whatever the owner reads`);
    assert.doesNotMatch(page, /Cents \/ 100\)/, `${name} shows a ceiling to edit as dollars`);
  }
});
