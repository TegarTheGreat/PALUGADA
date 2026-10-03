/**
 * The owner at the company's browser (the analysis of 3 October, §9 P2 item
 * 20: "a live browser that can be taken over").
 *
 * The owner sees each piece of work's page as it is, and takes the browser
 * over -- with their device, since a signed-in browser is the company's
 * accounts -- to do what a role never does: sign in, type the code a site
 * sent to their phone, answer a puzzle. While they hold it the company's
 * work waits; when they give it back, what they signed in to is sealed for
 * that work, and a role that asked them to (`browser.handover`) resumes.
 *
 * Against a real Chromium, like `browser.test.ts`; skipped where there is none.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError, type ErrorCode } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import type { MasterKey } from '../../src/settings/store.ts';
import { Browsers, type PageReading } from '../../src/browser/browsers.ts';
import { sealedCookies } from '../../src/browser/cookies.ts';
import { browserCapabilities } from '../../src/capabilities/browser.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { chromium } from '../helpers/browser.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

const EXECUTABLE = chromium();
const SKIP = EXECUTABLE ? false : 'no Chromium here; PALUGADA_CHROMIUM names one';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
const closing: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const close of closing) await close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await closePools();
  await closeSetup();
});

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** A seller centre that wants a person to sign in, and a page with one big button. */
async function sellerCentre() {
  const posts: Array<{ path: string; body: string }> = [];
  const page = (title: string, body: string) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://site');
    const send = (html: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    if (req.method === 'POST') {
      posts.push({ path: url.pathname, body: await bodyOf(req) });
      const form = new URLSearchParams(posts.at(-1)!.body);
      if (url.pathname === '/masuk' && form.get('sandi') === 'rahasia-sari') {
        res.writeHead(302, { location: '/orders', 'set-cookie': `sesi=${encodeURIComponent(form.get('email') ?? '')}; HttpOnly; Path=/` });
        return res.end();
      }
      res.writeHead(204);
      return res.end();
    }
    switch (url.pathname) {
      case '/orders': {
        const who = /sesi=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        return send(who ? page('Pesanan', `<p>Pesanan untuk ${decodeURIComponent(who)}: 3 baru.</p>`) : page('Masuk dulu', '<p>Silakan masuk.</p>'));
      }
      case '/masuk':
        return send(page('Masuk', `<form method="post" action="/masuk">
          <input name="email" placeholder="Email" autofocus>
          <input name="sandi" type="password" placeholder="Kata sandi">
          <button>Masuk</button></form>`));
      case '/tombol':
        return send(page('Tombol', `<button style="position:absolute;left:0;top:0;width:640px;height:400px"
          onclick="fetch('/ditekan', { method: 'POST' })">Tekan</button>`));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { site: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts };
}

const refused = (code: ErrorCode) => (error: unknown) => isPalugadaError(error, code);

async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function bench(slug: string) {
  const fixture: Fixture = await createCompany(slug);
  const { site, posts } = await sellerCentre();
  let master: MasterKey | null = null;
  const browsers = new Browsers({
    executable: EXECUTABLE!, sandbox: false, reachable: { allowPrivateHosts: ['127.0.0.1'] },
    cookies: sealedCookies({ master: () => master }),
  });
  closing.push(() => browsers.close());
  const registry = new CapabilityRegistry();
  for (const capability of browserCapabilities(browsers)) registry.register(capability);
  await registry.sync();
  const api = await consoleWithSettings({ registry, browsers });
  closing.push(() => api.close());
  master = api.master;
  for (const name of ['browser.read', 'browser.act', 'browser.handover']) await grantCapability(fixture, name);
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
  return { fixture, site, posts, api, owner: await api.signIn(), broker, at, taskId: task.id, base: `/api/companies/${fixture.companyId}/browser` };
}

test('the owner watches the work\'s page, takes the browser over with their device, signs in, and gives it back; the role resumes signed in', { skip: SKIP }, async () => {
  const { fixture, site, posts, api, owner, broker, at, taskId, base } = await bench('browser-live');

  // The role finds it is not signed in, and asks the owner to.
  const before = (await broker.invoke(at('orders'), 'browser.read', { url: `${site}/orders` })).output as PageReading;
  assert.match(before.text, /Silakan masuk/);
  const ask = { reason: 'Masuk ke seller centre: kodenya dikirim ke HP Anda.' };
  await assert.rejects(broker.invoke(at('handover'), 'browser.handover', ask), refused('owner.asked'));
  const { rows: [card] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; title: string; payload: { browser?: boolean } }>(
    "SELECT id, title, payload FROM inbox_items WHERE task_id = $1 AND kind = 'escalation' AND status = 'open'", [taskId]));
  assert.ok(card, 'the owner is asked');
  assert.match(card.title, /Masuk ke seller centre/);
  assert.equal(card.payload.browser, true, 'a card that opens the browser');

  // The owner sees the work's page.
  const seen = await api.call('GET', base, owner);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.available, true);
  assert.equal(seen.body.held, null);
  assert.equal(seen.body.tabs.length, 1);
  const tab = seen.body.tabs[0];
  assert.deepEqual([tab.taskId, tab.url, tab.title, tab.work], [taskId, `${site}/orders`, 'Masuk dulu', 'Daftar pesanan hari ini dari seller centre']);
  const screen = await api.call('GET', `${base}/tabs/${tab.id}`, owner);
  assert.equal(screen.status, 200, JSON.stringify(screen.body));
  assert.match(screen.body.image, /^data:image\/jpeg;base64,/);
  const jpeg = Buffer.from(String(screen.body.image).split(',')[1]!, 'base64');
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a picture of the page');
  assert.deepEqual([screen.body.width, screen.body.height], [1280, 800]);

  // Nothing is typed into a browser nobody took over, and nobody takes it
  // over without the owner's device.
  const early = await api.call('POST', `${base}/tabs/${tab.id}/input`, owner, { kind: 'text', text: 'x' });
  assert.equal(early.status, 409, JSON.stringify(early.body));
  const bare = await api.call('POST', `${base}/take-over`, owner, {});
  assert.equal(bare.status, 403, JSON.stringify(bare.body));
  const taken = await api.call('POST', `${base}/take-over`, owner, { proof: { totp: api.code() } });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.ok(taken.body.held.since);

  // While it is held, the company's work waits rather than reading under the owner's hands.
  await assert.rejects(broker.invoke(at('while-held'), 'browser.read', { url: `${site}/orders` }),
    (error: unknown) => isPalugadaError(error, 'capability.busy') && typeof (error as { details: { notBefore?: string } }).details.notBefore === 'string');

  // The owner opens the sign-in on the work's own tab -- under the same
  // rules as any page -- and signs in as a person does.
  const inside = await api.call('POST', `${base}/open`, owner, { tabId: tab.id, url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(inside.status, 400, JSON.stringify(inside.body));
  assert.match(String(inside.body.error), /inside this network/);
  const opened = await api.call('POST', `${base}/open`, owner, { tabId: tab.id, url: `${site}/masuk` });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.url, `${site}/masuk`);
  for (const input of [
    { kind: 'text', text: 'sari@toko.id' }, { kind: 'key', key: 'Tab' }, { kind: 'text', text: 'rahasia-sari' }, { kind: 'key', key: 'Enter' },
  ]) {
    const sent = await api.call('POST', `${base}/tabs/${tab.id}/input`, owner, input);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  }
  await until('the sign-in to arrive', () => posts.some((post) => post.path === '/masuk'));
  assert.equal(posts[0]!.body, 'email=sari%40toko.id&sandi=rahasia-sari');
  await until('the orders page', async () => (await api.call('GET', base, owner)).body.tabs[0]?.title === 'Pesanan');

  // A click lands where the owner pressed on the picture.
  await api.call('POST', `${base}/open`, owner, { tabId: tab.id, url: `${site}/tombol` });
  const clicked = await api.call('POST', `${base}/tabs/${tab.id}/input`, owner, { kind: 'click', x: 100, y: 100 });
  assert.equal(clicked.status, 200, JSON.stringify(clicked.body));
  await until('the button to be pressed', () => posts.some((post) => post.path === '/ditekan'));
  const wrong = await api.call('POST', `${base}/tabs/${tab.id}/input`, owner, { kind: 'click', x: 5_000, y: 1 });
  assert.equal(wrong.status, 400, 'a point off the page');

  // Given back: the role's question is answered, and its work goes on, signed in.
  const back = await api.call('POST', `${base}/give-back`, owner, {});
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.answered, 1);
  assert.equal((await api.call('GET', base, owner)).body.held, null);
  const resumed = await broker.invoke(at('handover'), 'browser.handover', ask);
  assert.deepEqual((resumed.output as { answered: boolean }).answered, true);
  assert.match((resumed.output as { answer: string }).answer, /gave the browser back/);
  const after = (await broker.invoke(at('orders-after'), 'browser.read', { url: `${site}/orders` })).output as PageReading;
  assert.match(after.text, /Pesanan untuk sari@toko\.id: 3 baru\./);

  // What the owner typed is in no record; that they held the browser is.
  const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string; payload: unknown }>(
    "SELECT type, payload FROM events WHERE type LIKE 'browser.%' ORDER BY occurred_at, id"));
  assert.deepEqual(events.map((event) => event.type), ['browser.taken_over', 'browser.given_back']);
  const { rows: anywhere } = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM events WHERE payload::text LIKE '%rahasia-sari%' UNION ALL SELECT 1 FROM inbox_items WHERE payload::text LIKE '%rahasia-sari%'"));
  assert.equal(anywhere.length, 0, 'the password went to the site and nowhere else');
});

test('a hold the owner forgot lapses, and a role never asks for a hand-over without a reason', { skip: SKIP }, async () => {
  const { fixture, site, api, owner, broker, at, base } = await bench('browser-lapse');
  await broker.invoke(at('first'), 'browser.read', { url: `${site}/orders` });
  const taken = await api.call('POST', `${base}/take-over`, owner, { proof: { totp: api.code() } });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  await assert.rejects(broker.invoke(at('held'), 'browser.read', { url: `${site}/orders` }), refused('capability.busy'));
  // Fifteen minutes without the owner's hand on it, and the work goes on.
  await withControlPlane((tx) => tx.query(
    "UPDATE browser_holds SET touched_at = now() - interval '16 minutes' WHERE company_id = $1", [fixture.companyId]));
  const read = (await broker.invoke(at('lapsed'), 'browser.read', { url: `${site}/orders` })).output as PageReading;
  assert.match(read.text, /Silakan masuk/);
  assert.equal((await api.call('GET', base, owner)).body.held, null);
  const input = await api.call('POST', `${base}/open`, owner, { url: `${site}/masuk` });
  assert.equal(input.status, 409, 'a lapsed hold is taken over again');

  await assert.rejects(broker.invoke(at('no-reason'), 'browser.handover', { reason: ' ' }), refused('contract.violation'));
});
