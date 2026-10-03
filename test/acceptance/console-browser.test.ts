/**
 * The company's browser in the console, drawn in a real browser at a phone's
 * width (console/src/pages/Browser.tsx): a card where a role asked to be
 * signed in opens the browser on that work's page, the page is shown as it
 * is, without running off the screen, and the owner takes it over with their
 * device and gives it back.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import type { MasterKey } from '../../src/settings/store.ts';
import { Browsers } from '../../src/browser/browsers.ts';
import { sealedCookies } from '../../src/browser/cookies.ts';
import { browserCapabilities } from '../../src/capabilities/browser.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  await closePools();
  await closeSetup();
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

test('a card asking to be signed in opens the browser on the work\'s page, which the owner takes over and gives back', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('console-browser');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Masuk dulu</title><h1>Seller Centre</h1><p>Silakan masuk.</p>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  servers.push(site);
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  let master: MasterKey | null = null;
  const browsers = new Browsers({
    executable: browser!, sandbox: false, reachable: { allowPrivateHosts: ['127.0.0.1'] }, cookies: sealedCookies({ master: () => master }),
  });
  const registry = new CapabilityRegistry();
  for (const capability of browserCapabilities(browsers)) registry.register(capability);
  await registry.sync();
  const api = await consoleWithSettings({ staticRoot: BUILT, registry, browsers });
  master = api.master;
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    await grantCapability(fixture, 'browser.read');
    await grantCapability(fixture, 'browser.handover');
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'Daftar pesanan hari ini dari seller centre' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    const broker = new CapabilityBroker(registry);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, taskId: task.id, idempotencyKey: key,
    });
    await broker.invoke(at('orders'), 'browser.read', { url: `${siteUrl}/orders` });
    await assert.rejects(broker.invoke(at('handover'), 'browser.handover', { reason: 'Masuk ke seller centre: kodenya dikirim ke HP Anda.' }),
      (error: unknown) => isPalugadaError(error, 'owner.asked'));

    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console');

    // The card, on a phone a row in the list that opens when pressed.
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/inbox'`);
    await page.waitFor(`document.body.innerText.includes('Masuk ke seller centre')`, 'the card in the list');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Skip the tour')?.click()`);
    await page.evaluate(`[...document.querySelectorAll('button, [role="button"]')].filter((one) => one.innerText.includes('Masuk ke seller centre')).at(-1).click()`);
    await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Open the browser')`, 'the card offers the browser', 20_000);
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Open the browser').click()`);
    await page.waitFor(`location.hash.startsWith('#/c/${fixture.companyId}/browser') && location.hash.includes('item=${task.id}')`, 'the browser page, on that work');

    // The work's page, as it is, named by the work.
    await page.waitFor(`document.querySelector('img[src^="data:image/jpeg"]') && document.querySelector('img[src^="data:image/jpeg"]').naturalWidth === 1280`, 'the page\'s picture', 20_000);
    const text = String(await page.evaluate('document.body.innerText'));
    assert.ok(text.includes('Daftar pesanan hari ini dari seller centre'), 'the tab is named by its work');
    const wide = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
    assert.ok(Number(wide) <= 0, `Browser is ${String(wide)} pixels wider than a phone`);
    const shown = await page.evaluate(`document.querySelector('img[src^="data:image/jpeg"]').getBoundingClientRect().width`);
    assert.ok(Number(shown) <= 390, `the picture is drawn ${String(shown)} pixels wide on a 390 pixel screen`);

    // Taken over with the device, the page can be typed into; given back, it cannot.
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Take it over').click()`);
    await page.waitFor(`document.body.innerText.includes('Confirm with your authenticator')`, 'the device asked for');
    await page.evaluate(`document.querySelector('.mantine-Modal-content input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Give it back')`, 'the browser held', 20_000);
    assert.ok(String(await page.evaluate('document.body.innerText')).includes('Open an address'));
    const { rows: held } = await withControlPlane((tx) => tx.query('SELECT 1 FROM browser_holds WHERE company_id = $1', [fixture.companyId]));
    assert.equal(held.length, 1);
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Give it back').click()`);
    await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Take it over')`, 'given back', 20_000);
    const { rows: answered } = await withControlPlane((tx) => tx.query(
      "SELECT 1 FROM inbox_items WHERE task_id = $1 AND kind = 'escalation' AND status = 'decided'", [task.id]));
    assert.equal(answered.length, 1, 'giving it back answered the role');
  } finally {
    await page.close();
    await api.close();
    await browsers.close();
  }
});
