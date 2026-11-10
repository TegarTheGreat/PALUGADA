/**
 * The company's browser (the analysis of 3 October, §9 P2 item 20: "a live
 * browser that can be taken over, for marketplace seller centres and
 * government portals"; the tools research of the same day, §6 item 2).
 *
 * `browser.read` opens and reads a page as a person sees it -- its words, and
 * the links, fields and buttons on it, each with a ref -- and `browser.act`
 * does what the owner said yes to on that page: type, choose, tick, click.
 * Behind both is one Chromium, driven over its DevTools protocol on a pipe
 * no other process can reach, with a context of its own for each company
 * whose cookies are sealed between uses; every request it makes goes
 * through the platform's own proxy, which holds it to the rules `web.fetch`
 * is held to.
 *
 * Against a real Chromium, so these skip where none is installed
 * (`PALUGADA_CHROMIUM` names one), and a site written for the test on
 * 127.0.0.1 -- which the deployment allows by name, as an operator allows an
 * internal wiki -- beside a "secret" on 127.0.0.2 that it does not.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError, type ErrorCode } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { assertDivisionReference, InMemorySecretManager } from '../../src/secrets/manager.ts';
import { DeploymentSecretManager, masterKeyFrom, type MasterKey } from '../../src/settings/store.ts';
import { Browsers, type ActResult, type PageReading } from '../../src/browser/browsers.ts';
import { browserSecretName, sealedCookies } from '../../src/browser/cookies.ts';
import { browserCapabilities } from '../../src/capabilities/browser.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { extractProvider } from '../../src/capabilities/search.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { chromium } from '../helpers/browser.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

const EXECUTABLE = chromium();
const SKIP = EXECUTABLE ? false : 'no Chromium here; PALUGADA_CHROMIUM names one';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
const opened: Browsers[] = [];
after(async () => {
  for (const one of opened) await one.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await closePools();
  await closeSetup();
});

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  servers.push(server);
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** A shop's seller centre, in Indonesian, and a secret it must never reach. */
async function sites() {
  const secretHits: string[] = [];
  const secret = await listen(createServer((req, res) => {
    secretHits.push(req.url ?? '');
    res.end('the machine\'s own credentials');
  }), '127.0.0.2');

  const posts: Array<{ path: string; body: string }> = [];
  const page = (title: string, body: string) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const site = await listen(createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://site');
    const cookies = req.headers.cookie ?? '';
    const send = (html: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };
    if (req.method === 'POST') {
      posts.push({ path: url.pathname, body: await bodyOf(req) });
      const form = new URLSearchParams(posts.at(-1)!.body);
      if (url.pathname === '/form') return send(page('Terkirim', `<p>Terima kasih, ${form.get('nama')} dari ${form.get('kota')}.</p>`));
      res.writeHead(204);
      return res.end();
    }
    switch (url.pathname) {
      case '/':
        return send(page('Toko Kopi Senja — Seller', `
          <h1>Pesanan hari ini</h1>
          <div style="display:none">RAHASIA-TERSEMBUNYI</div>
          <a href="/orders/123">Pesanan #123</a>
          <a href="/help" target="_blank">Bantuan</a>
          <img src="${secret}/leak" alt="">
          <script>fetch('${secret}/fetched').catch(() => {});</script>`));
      case '/help':
        return send(page('Bantuan', '<p>Hubungi kami di WhatsApp.</p>'));
      case '/artikel':
        // A page as most are: a menu, a header and a footer around what it says.
        return send(page('Resep Kopi Susu', `
          <header><nav><a href="/">Beranda</a> <a href="/menu">Menu</a></nav></header>
          <main><article><h1>Resep Kopi Susu</h1>${cookies ? `<p>Kuki: ${cookies}</p>` : ''}<p>Campur kopi dengan susu dan gula aren.</p>
            <aside>Baca juga: teh tarik</aside></article></main>
          <footer>Hak cipta Toko Kopi Senja</footer>
          <script>document.querySelector('article p').insertAdjacentHTML('afterend', '<p>Disajikan dingin.</p>');</script>`),
          { 'set-cookie': 'pelacak=1; Max-Age=86400; Path=/' });
      case '/masuk':
        // A sign-in: one cookie for the session, and one remembered for a day.
        return send(page('Masuk', '<p>Selamat datang, Sari.</p>'), {
          'set-cookie': ['sesi=abc123; HttpOnly; Path=/', 'ingat=ya; Max-Age=86400; Path=/'],
        });
      case '/orders/123':
        return send(cookies.includes('sesi=abc123')
          ? page('Pesanan #123', '<p>Pesanan #123 untuk Sari: 2 kopi susu.</p>')
          : page('Masuk dulu', '<p>Silakan masuk.</p>'));
      case '/inside':
        res.writeHead(302, { location: `${secret}/secret` });
        return res.end();
      case '/long':
        return send(page('Panjang', `<p>${'kopi '.repeat(10_000)}</p>${Array.from({ length: 400 }, (_, i) => `<a href="/p/${i}">Produk ${i}</a>`).join(' ')}`));
      case '/form':
        return send(page('Formulir', `
          <form method="post" action="/form">
            <label for="nama">Nama</label> <input id="nama" name="nama" value="lama">
            <label>Kota <select name="kota"><option>Jakarta</option><option>Bandung</option></select></label>
            <label><input type="checkbox" name="setuju"> Setuju</label>
            <button type="submit">Kirim</button>
          </form>
          <button id="hapus" onclick="if (confirm('Yakin hapus?')) fetch('/delete', { method: 'POST' })">Hapus</button>`));
      default:
        res.writeHead(404);
        return res.end();
    }
  }), '127.0.0.1');
  return { site, secret, secretHits, posts };
}

function sealedStore() {
  const key = randomBytes(32);
  const master: MasterKey = { id: masterKeyFrom({ PALUGADA_MASTER_KEY: key.toString('hex') })!.id, key, source: 'test' };
  return { master, secrets: new DeploymentSecretManager(new InMemorySecretManager(), () => master) };
}

function browsers(store: ReturnType<typeof sealedStore>, extra: { maxCompanies?: number } = {}): Browsers {
  const made = new Browsers({
    executable: EXECUTABLE!,
    // Chromium's sandbox needs user namespaces, which a test container
    // running as root does not give it; the deployment keeps it on.
    sandbox: false,
    reachable: { allowPrivateHosts: ['127.0.0.1'] },
    cookies: sealedCookies({ master: () => store.master }),
    ...extra,
  });
  opened.push(made);
  return made;
}

async function registryFor(made: Browsers): Promise<CapabilityRegistry> {
  const registry = new CapabilityRegistry();
  for (const capability of browserCapabilities(made)) registry.register(capability);
  await registry.sync();
  return registry;
}

async function taskFor(fixture: Fixture): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, goalId: fixture.goalId, input: { goal: 'Check today\'s orders' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

const refused = (code: ErrorCode) => (error: unknown) => isPalugadaError(error, code);
const named = (reading: PageReading, name: string) => {
  const found = reading.elements.find((element) => element.name === name);
  assert.ok(found, `"${name}" is among ${reading.elements.map((element) => element.name).join(', ')}`);
  return found!;
};

test('a role reads a page as a person sees it, and nothing it opens reaches inside the network (F12.9)', { skip: SKIP }, async () => {
  const fixture = await createCompany('browser-read');
  const { site, secret, secretHits } = await sites();
  const made = browsers(sealedStore());
  const registry = await registryFor(made);
  await grantCapability(fixture, 'browser.read');
  const broker = new CapabilityBroker(registry);
  const taskId = await taskFor(fixture);
  const at = (key: string) => ({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId, idempotencyKey: key,
  });

  const home = (await broker.invoke(at('home'), 'browser.read', { url: `${site}/` })).output as PageReading;
  assert.equal(home.title, 'Toko Kopi Senja — Seller');
  assert.equal(home.url, `${site}/`);
  assert.match(home.text, /Pesanan hari ini/);
  assert.doesNotMatch(home.text, /RAHASIA-TERSEMBUNYI/, 'what the page hides is not read');
  const order = named(home, 'Pesanan #123');
  assert.deepEqual([order.kind, order.href], ['link', `${site}/orders/123`]);
  assert.match(order.ref, /^e\d+$/);
  // A page is somebody else's words (F8.9).
  const { rows: outside } = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM events WHERE task_id = $1 AND type = 'content.read_outside'", [taskId]));
  assert.equal(outside.length, 1);

  // A link is followed in the same tab, even one that asks for a new one.
  const help = (await broker.invoke(at('help'), 'browser.read', { link: named(home, 'Bantuan').ref })).output as PageReading;
  assert.deepEqual([help.title, help.url], ['Bantuan', `${site}/help`]);
  // A ref is only good for the page it was read from.
  await assert.rejects(broker.invoke(at('stale'), 'browser.read', { link: order.ref }),
    (error: unknown) => isPalugadaError(error, 'contract.violation') && /read the page again/.test((error as Error).message));

  // The page's own requests inside the network never left the browser...
  assert.deepEqual(secretHits, [], 'the picture and the script\'s fetch were refused by the proxy');
  // ...and neither does a role that names one, or a redirect to one.
  await assert.rejects(broker.invoke(at('metadata'), 'browser.read', { url: 'http://169.254.169.254/latest/meta-data/' }),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable') && /inside this network/.test((error as Error).message));
  await assert.rejects(broker.invoke(at('secret'), 'browser.read', { url: `${secret}/secret` }), refused('capability.unreachable'));
  await assert.rejects(broker.invoke(at('file'), 'browser.read', { url: 'file:///etc/passwd' }),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable') && /file: is not a scheme/.test((error as Error).message));
  await assert.rejects(broker.invoke(at('redirect'), 'browser.read', { url: `${site}/inside` }),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable') && /127\.0\.0\.2/.test((error as Error).message));
  assert.deepEqual(secretHits, []);

  // A long page is cut where a model can read it, and says so.
  const long = (await broker.invoke(at('long'), 'browser.read', { url: `${site}/long` })).output as PageReading;
  assert.ok(long.text.length <= 12_200, `${long.text.length} characters`);
  assert.match(long.text, /cut here: \d+ more characters/);
  assert.equal(long.elements.length, 150);
  assert.equal(long.moreElements, 250);
});

test('a role acts on a page only as the owner said yes to, on the page they saw (F8.9, F8.4)', { skip: SKIP }, async () => {
  const fixture = await createCompany('browser-act');
  const { site, posts } = await sites();
  const made = browsers(sealedStore());
  const registry = await registryFor(made);
  await grantCapability(fixture, 'browser.read');
  await grantCapability(fixture, 'browser.act');
  const broker = new CapabilityBroker(registry);
  const taskId = await taskFor(fixture);
  const at = (key: string) => ({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId, idempotencyKey: key,
  });
  await planTask(fixture.companyId, taskId, [{ capability: 'browser.act' }]);

  const form = (await broker.invoke(at('form'), 'browser.read', { url: `${site}/form` })).output as PageReading;
  const nama = named(form, 'Nama');
  assert.deepEqual([nama.kind, nama.value], ['field', 'lama']);
  const kota = named(form, 'Kota');
  assert.deepEqual([kota.kind, kota.options], ['choice', ['Jakarta', 'Bandung']]);
  assert.deepEqual([named(form, 'Setuju').kind, named(form, 'Setuju').checked], ['checkbox', false]);
  const kirim = named(form, 'Kirim');
  const steps = {
    url: form.url,
    steps: [
      { do: 'type', ref: nama.ref, name: 'Nama', text: 'Sari' },
      { do: 'choose', ref: kota.ref, name: 'Kota', option: 'Bandung' },
      { do: 'tick', ref: named(form, 'Setuju').ref, name: 'Setuju' },
      { do: 'click', ref: kirim.ref, name: 'Kirim' },
    ],
  };

  // The work read a page, so whatever it does there waits for the owner,
  // who reads each step on the card: the field and what goes in it, the
  // choice, the tick and the button -- the same in every language.
  await assert.rejects(broker.invoke(at('submit'), 'browser.act', steps), refused('approval.required'));
  assert.deepEqual(posts, [], 'nothing was sent before the yes');
  const { rows: [card] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; title: string; action_summary: string }>(
    "SELECT id, title, action_summary FROM inbox_items WHERE task_id = $1 AND kind = 'approval' AND capability_name = 'browser.act'", [taskId]));
  assert.ok(card, 'the owner is asked');
  const where = `${new URL(site).host}/form`;
  assert.equal(card.action_summary, `browser.act: ${where} — Nama: "Sari"; Kota → Bandung; ☑ Setuju; ▸ Kirim`);
  assert.ok(card.title.startsWith(`browser.act: ${where} — Nama: "Sari"`), card.title);

  await inbox.decide(fixture.companyId, card.id, 'approve', '', { channel: 'app' });
  const done = await broker.invoke(at('submit'), 'browser.act', steps);
  const result = done.output as ActResult;
  assert.equal(done.verified, true, 'every step done, and the page after it read back (F8.4)');
  assert.equal(result.done, 4);
  assert.equal(result.title, 'Terkirim');
  assert.match(result.text, /Terima kasih, Sari dari Bandung\./);
  assert.deepEqual(posts, [{ path: '/form', body: 'nama=Sari&kota=Bandung&setuju=on' }], 'the field was emptied before typing');

  // Its own guards, below the broker: the steps are for the page they were
  // approved on, each element is the one the step names, and a dialog the
  // page opens is answered no unless the steps said yes.
  const [, act] = browserCapabilities(made) as unknown as [Capability, Capability<unknown, ActResult>];
  const ctx = {
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId, idempotencyKey: 'direct',
    signal: new AbortController().signal, credential: async () => { throw new Error('none'); },
  };
  // The answer to the form is another page at the same address: the refs
  // of the one the owner saw are not on it.
  await assert.rejects(act.execute(steps, ctx),
    (error: unknown) => isPalugadaError(error, 'contract.violation') && /read the page again/.test((error as Error).message));
  const again = (await broker.invoke(at('form-again'), 'browser.read', { url: `${site}/form` })).output as PageReading;
  const button = named(again, 'Kirim');
  await assert.rejects(act.execute({ url: `${site}/help`, steps: [{ do: 'click', ref: button.ref, name: 'Kirim' }] }, ctx),
    (error: unknown) => isPalugadaError(error, 'contract.violation')
      && (error as Error).message.includes(`the page is now ${site}/form, not ${site}/help`));
  await assert.rejects(act.execute({ url: again.url, steps: [{ do: 'click', ref: button.ref, name: 'Batal' }] }, ctx),
    (error: unknown) => isPalugadaError(error, 'contract.violation') && /is "Kirim", not "Batal"/.test((error as Error).message));
  await assert.rejects(act.execute({ url: again.url, steps: [{ do: 'choose', ref: named(again, 'Kota').ref, name: 'Kota', option: 'Surabaya' }] }, ctx),
    (error: unknown) => isPalugadaError(error, 'contract.violation') && /Jakarta, Bandung/.test((error as Error).message));
  assert.equal(posts.length, 1, 'a refused step sends nothing');

  const hapus = named(again, 'Hapus');
  const dismissed = await act.execute({ url: again.url, steps: [{ do: 'click', ref: hapus.ref, name: 'Hapus' }] }, ctx);
  assert.deepEqual(dismissed.dialogs, [{ kind: 'confirm', message: 'Yakin hapus?', accepted: false }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(posts.length, 1, 'the page asked, and was told no');
  const accepted = await act.execute({ url: again.url, acceptDialogs: true, steps: [{ do: 'click', ref: hapus.ref, name: 'Hapus' }] }, ctx);
  assert.deepEqual(accepted.dialogs, [{ kind: 'confirm', message: 'Yakin hapus?', accepted: true }]);
  for (let tries = 0; tries < 20 && posts.length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(posts.at(-1), { path: '/delete', body: '' });
});

test('a sign-in is the company\'s own, sealed between uses, and outlives the browser (F12.4)', { skip: SKIP }, async () => {
  const shop = await createCompany('browser-shop');
  const other = await createCompany('browser-other');
  const { site } = await sites();
  const store = sealedStore();
  const at = (fixture: Fixture) => ({ companyId: fixture.companyId, taskId: fixture.goalId });

  const first = browsers(store);
  await first.read(at(shop), { url: `${site}/masuk` });
  assert.match((await first.read(at(shop), { url: `${site}/orders/123` })).text, /Pesanan #123 untuk Sari/);
  // Another company's browser has none of it.
  assert.match((await first.read(at(other), { url: `${site}/orders/123` })).text, /Silakan masuk/);

  // Sealed under the master key, under a name no division's credential may use.
  const name = browserSecretName(shop.companyId);
  assert.match(name, /^browser-[0-9a-f]{32}$/);
  const { rows: [kept] } = await withControlPlane((tx) => tx.query<{ ciphertext: Buffer }>(
    'SELECT ciphertext FROM deployment_secrets WHERE name = $1', [name]));
  assert.ok(kept, 'the cookies are kept');
  assert.ok(!kept.ciphertext.toString('latin1').includes('abc123'));
  assert.throws(() => assertDivisionReference(`db://${name}`), refused('credential.unavailable'));

  // The browser closed -- a restart, an update -- the next one is still
  // signed in, session cookie and all.
  await first.close();
  const second = browsers(store);
  assert.match((await second.read(at(shop), { url: `${site}/orders/123` })).text, /Pesanan #123 untuk Sari/);

  // With room for one company's browser at a time, another company's work
  // closes the first's, which is signed in again when it comes back.
  const narrow = browsers(store, { maxCompanies: 1 });
  assert.match((await narrow.read(at(other), { url: `${site}/orders/123` })).text, /Silakan masuk/);
  assert.match((await narrow.read(at(shop), { url: `${site}/orders/123` })).text, /Pesanan #123 untuk Sari/);

  // A company that is closing keeps no more.
  await withControlPlane((tx) => tx.query(
    "UPDATE companies SET closing_at = now(), erase_after = now() + interval '7 days' WHERE id = $1", [other.companyId]));
  await narrow.read(at(other), { url: `${site}/masuk` });
  await narrow.close();
  const { rows: closing } = await withControlPlane((tx) => tx.query(
    'SELECT 1 FROM deployment_secrets WHERE name = $1', [browserSecretName(other.companyId)]));
  assert.equal(closing.length, 0, 'nothing is sealed for a company on its way out');
});

test('without a provider chosen, web.extract reads a page in the deployment\'s own browser, under the same rules', { skip: SKIP }, async () => {
  const shop = await createCompany('browser-extract');
  const { site, secretHits } = await sites();
  const store = sealedStore();
  const made = browsers(store);
  const extract = platformCapabilities({ browser: made }).find((one) => one.name === 'web.extract') as unknown as
    Capability<{ url: string }, { provider: string; url: string; title: string; text: string; truncated: boolean }> | undefined;
  assert.ok(extract, 'bound to the browser when no provider is chosen');
  assert.equal(extract.adapter, 'extract:browser');
  // A provider the owner chose is used instead.
  const jina = { provider: extractProvider('jina')!, url: null, key: async () => null };
  assert.equal(platformCapabilities({ browser: made, extract: jina }).find((one) => one.name === 'web.extract')!.adapter, 'extract:jina');

  const ctx = {
    companyId: shop.companyId, divisionId: shop.divisionId, taskId: shop.goalId, idempotencyKey: 'extract',
    signal: new AbortController().signal, credential: async () => { throw new Error('none'); },
  };
  // The company is signed in somewhere; a page read for it goes without that.
  await made.read({ companyId: shop.companyId, taskId: shop.goalId }, { url: `${site}/masuk` });
  const signedIn = await withControlPlane((tx) => tx.query<{ ciphertext: Buffer }>(
    'SELECT ciphertext FROM deployment_secrets WHERE name = $1', [browserSecretName(shop.companyId)]));
  assert.equal(signedIn.rows.length, 1);
  const tabsBefore = await made.tabs(shop.companyId);

  for (const time of ['first', 'second']) {
    const read = await extract.execute({ url: `${site}/artikel` }, ctx);
    assert.equal(read.provider, 'This deployment\'s browser');
    assert.deepEqual([read.url, read.title, read.truncated], [`${site}/artikel`, 'Resep Kopi Susu', false]);
    assert.match(read.text, /Campur kopi dengan susu dan gula aren\./);
    assert.match(read.text, /Disajikan dingin\./, 'what the page\'s script wrote, as a person sees it');
    for (const around of ['Beranda', 'Hak cipta', 'Baca juga']) assert.doesNotMatch(read.text, new RegExp(around), `${around} is around the page, not on it`);
    // Neither the company's sign-in nor what the page left the time before.
    assert.doesNotMatch(read.text, /Kuki/, `the ${time} reading was sent no cookie`);
  }
  await assert.rejects(extract.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable') && /inside this network/.test((error as Error).message));
  assert.deepEqual(secretHits, []);
  // Nothing the pages gave was kept for the company, and no tab of theirs is left.
  const after = await withControlPlane((tx) => tx.query<{ ciphertext: Buffer }>(
    'SELECT ciphertext FROM deployment_secrets WHERE name LIKE \'browser-%\''));
  assert.deepEqual(after.rows, signedIn.rows);
  assert.deepEqual(await made.tabs(shop.companyId), tabsBefore);
});
