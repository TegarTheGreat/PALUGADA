/**
 * The console fits a phone (the analysis of 3 October, §2.3 item 8 and §9 P1
 * item 13).
 *
 * Most owners of a small business read PALUGADA on their phone. At 390
 * pixels the work list showed 356 of its 820: what a task serves, its
 * progress and what it cost were off to the right in a box that scrolled
 * sideways, which nobody discovers on a phone; the accounts on **Money**
 * hid their money and the **Ceilings** button the same way; and on the
 * overview the status of what is running was cut to "BERJA..."; the
 * figures on the money page broke inside the number ("US$200,0" over "0").
 * Drawn in a real browser at a phone's width, nothing is wider than the
 * screen, nothing scrolls sideways, and nothing is cut or broken.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as budget from '../../src/engine/budget.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

/**
 * What does not fit: the page wider than the screen, a table wider than it, a
 * badge cut short, anything that scrolls sideways, and a figure broken
 * across lines or cut.
 */
const MISFITS = `(() => {
  const width = window.innerWidth;
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const tables = [...document.querySelectorAll('table')].filter(shown)
    .filter((table) => table.getBoundingClientRect().width > width + 1)
    .map((table) => (table.querySelector('th, td')?.textContent ?? '').trim().slice(0, 30) + ' ' + Math.round(table.getBoundingClientRect().width) + 'px');
  const badges = [...document.querySelectorAll('.mantine-Badge-label')].filter(shown)
    .filter((label) => label.scrollWidth > label.clientWidth + 1)
    .map((label) => label.textContent);
  const sideways = [...document.querySelectorAll('body *')].filter(shown)
    .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
    .map((el) => (el.textContent ?? '').trim().slice(0, 30));
  const figures = [...document.querySelectorAll('.kpi-value')].filter(shown)
    .filter((value) => /\\d/.test(value.textContent ?? ''))
    .filter((value) => value.scrollWidth > value.clientWidth + 1
      || value.getBoundingClientRect().height > 1.5 * parseFloat(getComputedStyle(value).lineHeight))
    .map((value) => value.textContent);
  return { page: document.documentElement.scrollWidth > width + 1 ? document.documentElement.scrollWidth : null, tables, badges, sideways, figures };
})()`;

test('the work, the money and the overview fit a phone, with nothing off to the side', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('phone');
  const { companyId } = fixture;
  await withControlPlane(async (tx) => {
    await tx.query("UPDATE roles SET display_name = 'Sari' WHERE id = $1", [fixture.roleId]);
    await tx.query("UPDATE companies SET name = 'Toko Kopi Senja Bandung' WHERE id = $1", [companyId]);
    // Read in rupiah (2.106), so the figures are as long as an Indonesian owner sees them.
    await tx.query("UPDATE platform_control SET console_language = 'id', tour_finished_at = now(), display_currency = 'IDR', display_rate = 16500");
    await tx.query('INSERT INTO spend_limits (company_id, money_max_cents) VALUES ($1, 20000)', [companyId]);
  });
  await withTenant(companyId, (tx) => budget.createAccount(tx, {
    companyId, label: 'Promosi Ramadan', tokensMax: 50_000, moneyMaxCents: 2_000,
    scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId: fixture.budgetAccountId },
  }));
  const goals = [
    'Tulis newsletter Oktober untuk pelanggan setia dengan promo kopi susu gula aren',
    'Periksa stok biji kopi arabika Gayo dan pesan ulang bila kurang dari lima kilogram',
    'Balas semua ulasan Google Maps minggu ini dengan sopan dan sebut nama pelanggannya',
  ];
  for (const [index, goal] of goals.entries()) {
    const task = await createRootTask({
      companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
    });
    await transition(companyId, task.id, 'running');
    if (index === 1) await transition(companyId, task.id, 'completed', { output: { summary: 'Stok cukup sampai 12 Oktober.' } });
  }

  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console');

    const misfit: Record<string, unknown> = {};
    for (const [name, shows] of [['work', 'Tulis newsletter'], ['money', 'Promosi Ramadan'], ['overview', 'Tulis newsletter']] as const) {
      await page.evaluate(`location.hash = '#/c/${companyId}/${name}'`);
      await page.waitFor(`document.body.innerText.includes(${JSON.stringify(shows)})`, `the ${name} page`);
      // A moment for the layout to settle after the data arrives.
      await new Promise((resolve) => setTimeout(resolve, 300));
      misfit[name] = await page.evaluate(MISFITS);
    }
    const fits = { page: null, tables: [], badges: [], sideways: [], figures: [] };
    assert.deepEqual(misfit, { work: fits, money: fits, overview: fits });
  } finally {
    await page.close();
    await api.close();
  }
});
