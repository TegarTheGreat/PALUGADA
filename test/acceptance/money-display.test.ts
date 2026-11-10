/**
 * The owner reads money in their own currency, at a rate they set (the
 * analysis of 3 October, §2.3 item 3 and §9 P1 item 13).
 *
 * PALUGADA counts in US dollars, because providers price in them, and 2.98
 * made every amount say so. An owner in Bandung still thinks in rupiah: "US$
 * 0,75" is a sum to convert in their head every time. They may choose a
 * currency to read amounts in and the rate to read them at; the platform
 * keeps counting in dollars, and says so.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { renderDailyDigest } from '../../src/owner/digest-said.ts';
import type { DailyDigest } from '../../src/reporting/digest.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('the owner chooses a currency and a rate to read money in, and can go back to dollars', async () => {
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const read = async () => (await api.call('GET', '/api/control/money-display', token)).body;
    const set = (body: Record<string, unknown>) => api.call('POST', '/api/control/money-display', token, body);

    assert.deepEqual(await read(), { currency: null, rate: null }, 'dollars until the owner chooses');

    const chosen = await set({ currency: 'IDR', rate: 16_500 });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.deepEqual(await read(), { currency: 'IDR', rate: 16_500 });

    const unknown = await set({ currency: 'XYZ', rate: 2 });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /XYZ/);
    for (const rate of [0, -1, 'many', Number.POSITIVE_INFINITY]) {
      assert.equal((await set({ currency: 'IDR', rate })).status, 400, `a rate of ${String(rate)}`);
    }
    assert.equal((await set({ currency: 'USD', rate: 1 })).status, 400, 'dollars are what it counts in already');
    assert.deepEqual(await read(), { currency: 'IDR', rate: 16_500 }, 'a refused change leaves the choice as it was');

    assert.equal((await set({ currency: null })).status, 200);
    assert.deepEqual(await read(), { currency: null, rate: null });
  } finally {
    await api.close();
  }
});

test("the chat's digest reads its spend in the owner's currency, and says it is converted", () => {
  const digest: DailyDigest = {
    companyId: 'c', day: '2026-10-02', moneySpentCents: 215, tasksCompleted: 1, tasksFailed: 0, tasksHalted: 0,
    openInboxItems: 0, openIncidents: 0, stopped: [],
  };
  const rupiah = renderDailyDigest(digest, 'id', { currency: 'IDR', rate: 16_500 });
  assert.match(rupiah, /Rp\s?35\.475/u, '2.15 dollars at 16,500 rupiah each');
  assert.match(rupiah, /US\$2,15/, 'and the dollars it was counted in');
  assert.match(renderDailyDigest(digest, 'id', null), /US\$2,15/);
});
