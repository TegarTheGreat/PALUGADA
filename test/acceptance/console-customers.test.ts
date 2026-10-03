/**
 * Customers in the console, drawn in a real browser at a phone's width
 * (0111, console/src/pages/Customers.tsx): the conversation a customer
 * started is listed as waiting for an answer and opens whole, the channel is
 * shown with its bot, and the card asking to send a reply shows what the
 * customer wrote beside it.
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
import { transition } from '../../src/engine/tasks.ts';
import { chatCapabilities } from '../../src/capabilities/chat.ts';
import { createCompany, planTask } from '../helpers/fixtures.ts';
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
const TOKEN = '7012345678:AAcustomerBotTokenOfTokoKopiSenja';

/** A Bot API that knows one bot, and remembers where its webhook was set. */
async function botApi() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const [, method] = /^\/bot[^/]+\/(\w+)$/.exec(req.url ?? '') ?? [];
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      calls.push({ method: method!, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        result: method === 'getMe' ? { id: 7012345678, is_bot: true, first_name: 'Toko Kopi Senja', username: 'tokosenja_bot' } : true,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

test('the owner reads a customer\'s conversation, and sees it beside the reply they are asked to send', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('console-customers');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const telegram = await botApi();
  const api = await consoleWithSettings({
    staticRoot: BUILT, baseEnv: { PALUGADA_TELEGRAM_API: telegram.url, PALUGADA_APP_URL_PUBLIC: 'https://palugada.example' },
  });
  const registry = new CapabilityRegistry();
  for (const capability of chatCapabilities({ secrets: api.secrets, telegram: { apiBase: telegram.url } })) registry.register(capability);
  await registry.sync();
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    const owner = await api.signIn();
    const made = await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels`, owner, {
      kind: 'telegram', token: TOKEN, roleId: fixture.roleId, goalId: fixture.goalId,
      instruction: 'Jawab pertanyaan pelanggan.', proof: { totp: api.code() },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const hook = telegram.calls.find((call) => call.method === 'setWebhook')!.body;
    const delivered = await fetch(String(hook.url).replace('https://palugada.example', api.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': String(hook.secret_token) },
      body: JSON.stringify({
        update_id: 9001,
        message: {
          message_id: 11, date: 1_760_000_000, text: 'Halo kak, kopi susu gula aren masih ada?',
          chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false, first_name: 'Sari', last_name: 'Kusuma' },
        },
      }),
    });
    const { taskId } = await delivered.json() as { taskId: string };
    // The run answers, and the answer waits for the owner.
    await transition(fixture.companyId, taskId, 'running');
    await planTask(fixture.companyId, taskId, [{ capability: 'chat.send' }]);
    await assert.rejects(new CapabilityBroker(registry).invoke({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      taskId, idempotencyKey: 'reply',
    }, 'chat.send', { text: 'Masih ada, Kak Sari!' }), (error: unknown) => isPalugadaError(error, 'approval.required'));

    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console');

    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/customers'`);
    // In lower case, because a badge and a heading are drawn in capitals and innerText says so.
    await page.waitFor(`document.body.innerText.includes('Sari Kusuma') && document.body.innerText.toLowerCase().includes('waiting for an answer')`, 'the conversation listed');
    await page.waitFor(`document.body.innerText.includes('@tokosenja_bot') && document.body.innerText.toLowerCase().includes('open to customers')`, 'the channel');
    const wide = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
    assert.ok(Number(wide) <= 0, `Customers is ${String(wide)} pixels wider than a phone`);
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.includes('Sari Kusuma')).click()`);
    await page.waitFor(`[...document.querySelectorAll('.mantine-Drawer-content')].some((one) => one.innerText.includes('kopi susu gula aren'))`, 'the conversation opened');

    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/inbox'`);
    // On a phone the inbox is a list, and a card opens when it is pressed.
    await page.waitFor(`document.body.innerText.includes('Reply to a customer')`, 'the card in the list');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Skip the tour')?.click()`);
    await page.evaluate(`[...document.querySelectorAll('button, [role="button"]')].filter((one) => one.innerText.includes('Reply to a customer')).at(-1).click()`);
    await page.waitFor(`document.body.innerText.toLowerCase().includes('the conversation with sari kusuma, on @tokosenja_bot')`, 'the conversation on the card', 20_000);
    const card = String(await page.evaluate('document.body.innerText'));
    assert.ok(card.includes('Halo kak, kopi susu gula aren masih ada?'), 'what the customer wrote, beside the reply');
    assert.ok(card.includes('Masih ada, Kak Sari!'), 'and the reply itself');
  } finally {
    await page.close();
    await api.close();
  }
});
