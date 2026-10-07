/**
 * An invoice as a PDF (the audit of 6 October, P1.4 part 4; STATUS 2.170).
 *
 * The owner could read an invoice on the Books page and copy it as text, and a
 * customer is sent a document. The invoice is now drawn from the books by the
 * Chromium the deployment already runs for its roles' browsers: offline, with
 * scripts off, in a context made for the one page and thrown away. What is
 * drawn is the invoice as issued, so the page is a function of an immutable
 * row; it is kept once under the invoice's number, where `email.send` can
 * attach it by path and the owner can take it from the Files tab.
 *
 * Every value on the page was typed by someone, often a person outside the
 * company, which is the point of most of these tests.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { setCompanyLanguages } from '../../src/domain/language.ts';
import { filesRead } from '../../src/capabilities/files.ts';
import { invoiceHtml } from '../../src/records/invoice-document.ts';
import { invoiceWith, issueInvoice, voidInvoice } from '../../src/records/invoices.ts';
import { Browsers } from '../../src/browser/browsers.ts';
import { sealedCookies } from '../../src/browser/cookies.ts';
import { chromium } from '../helpers/browser.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);

const opened: Browsers[] = [];
const roots: string[] = [];
after(async () => {
  for (const one of opened) await one.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await closePools();
  await closeSetup();
});

const EXECUTABLE = chromium();
const READER = fileURLToPath(new URL('../../console/dist/reader', import.meta.url));
const SKIP = EXECUTABLE ? false : 'no Chromium';

const JOB = {
  customerName: 'Toko Kopi Senja', customerEmail: 'bu.sari@kopisenja.example', currency: 'IDR', taxRatePercent: 11,
  note: 'Transfer to the account on the last page.\nThank you.',
  lines: [
    { description: 'Desain kemasan', quantity: 2.5, unitCents: 1_000_000 },
    { description: 'Hosting Oktober', quantity: 1, unitCents: 150_050 },
  ],
};

async function owned(options: { browser?: boolean; files?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'palugada-invoice-pdf-'));
  roots.push(root);
  const fixture = await createCompany('invoice-pdf');
  const browser = options.browser === false ? null : new Browsers({
    executable: EXECUTABLE!, sandbox: false, reader: READER, cookies: sealedCookies({ master: () => null }),
  });
  if (browser) opened.push(browser);
  const api = await consoleWithSettings({
    ...(options.files === false ? {} : { files: { root } }),
    ...(browser ? { browsers: browser } : {}),
  });
  const owner = await api.signIn();
  const base = `/api/companies/${fixture.companyId}`;
  const issue = (input: Record<string, unknown> = JOB) =>
    withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, input, 'owner'));
  const print = (id: string) => api.call('POST', `${base}/invoices/${id}/pdf`, owner, {});
  return { root, fixture, browser, api, owner, base, issue, print, mine: join(root, fixture.companyId) };
}

/** The text of a kept PDF, read as a role would read it: in the same browser, as a document. */
async function textOf(root: string, companyId: string, path: string, browser: Browsers): Promise<string> {
  const read = await filesRead({ root }, browser).execute({ path }, { companyId } as never);
  return read.text;
}

test('the page is the invoice as issued: every value escaped, nothing that runs, and nothing that reorders text', () => {
  const html = invoiceHtml({
    id: 'i', number: 'INV-0001', contactId: null, customerName: '<script>alert(1)</script>"&\'\u202eevil', customerEmail: null,
    issueDate: '2026-10-06', dueDate: '2026-10-20', currency: 'IDR', subtotalCents: 100, taxRateBps: 0, taxCents: 0, totalCents: 100,
    paidCents: 100, outstandingCents: 0, status: 'paid', overdue: false, note: '<img src=http://127.0.0.1:9/x onerror=alert(1)>\u2066hidden\u2069',
    entryId: 'e', writtenBy: 'owner', outside: false, createdAt: new Date(),
    lines: [{ description: '</td><script src=//evil/x.js></script>', quantity: 1, unitCents: 100, amountCents: 100 }], payments: [],
  }, 'Kopi <b>Senja</b>', 'en');
  assert.doesNotMatch(html, /<script|<img|<b>|onerror=\w*alert\(1\)>/i, 'what was typed is text, never markup');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&amp;&#39;evil/);
  assert.doesNotMatch(html, /[\u202a-\u202e\u2066-\u2069]/, 'the characters that reorder or hide text are dropped');
  assert.match(html, /default-src 'none'/, 'a policy that lets the page load nothing');
  assert.doesNotMatch(html, /<(script|img|iframe|link|object|embed|svg|base|form)\b/i, 'no tag that runs or fetches is in the page, whatever was typed');
  assert.doesNotMatch(html.slice(html.indexOf('<style>'), html.indexOf('</style>')), /url\(|@import/, 'and its own style asks for nothing');
  assert.doesNotMatch(html, /paid|dibayar/i, 'it prints the invoice as issued, with no mark of what the books say now');
});

test('the page is written in Indonesian for a company that works in it, and in English for every other', () => {
  const invoice = {
    id: 'i', number: 'INV-0002', contactId: null, customerName: 'Pak Budi', customerEmail: null, issueDate: '2026-10-06', dueDate: '2026-10-20',
    currency: 'IDR', subtotalCents: 2_650_050, taxRateBps: 1100, taxCents: 291_506, totalCents: 2_941_556, paidCents: 0, outstandingCents: 2_941_556,
    status: 'open' as const, overdue: false, note: null, entryId: 'e', writtenBy: 'owner' as const, outside: false, createdAt: new Date(),
    lines: [{ description: 'Desain', quantity: 2.5, unitCents: 1_060_020, amountCents: 2_650_050 }], payments: [],
  };
  const id = invoiceHtml(invoice, 'Kopi Senja', 'id');
  assert.match(id, /Ditagihkan kepada/);
  assert.match(id, /29\.415,56/, 'the total as an Indonesian writes it');
  assert.match(id, /Pajak 11%/);
  assert.match(id, /6 Oktober 2026/);
  const en = invoiceHtml(invoice, 'Kopi Senja', 'de');
  assert.match(en, /Bill to/, 'a language it has no words for is English, not a guess');
  assert.match(en, /29,415\.56/);
  assert.match(en, /October 6, 2026/);
  assert.equal(invoiceHtml(invoice, 'Kopi Senja', 'id'), id, 'the same invoice draws the same page');
  // A currency the runtime does not know is written as it is, beside the figure.
  assert.match(invoiceHtml({ ...invoice, currency: 'ZZZ9' }, 'Kopi Senja', 'en'), /29,415\.56 ZZZ9/);
});

test('the owner prints an invoice: it is drawn, kept under its number, says what the invoice says, and is one file however often it is asked for', { skip: SKIP }, async () => {
  assert.ok(existsSync(join(READER, 'pdf.min.mjs')), 'the console is built first (npm run console:build), with its PDF reader');
  const { api, fixture, root, browser, issue, print, mine } = await owned();
  try {
    const invoice = await issue();
    const first = await print(invoice.invoiceId);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.path, 'invoices/inv-0001.pdf');
    const again = await print(invoice.invoiceId);
    assert.deepEqual(again.body, first.body, 'asked again, it answers the page that is there');
    // Two at once draw one page too.
    const second = await issue();
    const [one, two] = await Promise.all([print(second.invoiceId), print(second.invoiceId)]);
    assert.equal(one.body.path, 'invoices/inv-0002.pdf');
    assert.equal(two.body.path, 'invoices/inv-0002.pdf');
    assert.deepEqual((await readdir(join(mine, 'invoices'))).sort(), ['inv-0001.pdf', 'inv-0002.pdf']);

    const text = await textOf(root, fixture.companyId, first.body.path, browser!);
    for (const said of ['INV-0001', 'Toko Kopi Senja', 'bu.sari@kopisenja.example', 'Desain kemasan', 'Hosting Oktober', 'Transfer to the account', 'Thank you']) {
      assert.ok(text.includes(said), `the page says ${said}: ${text}`);
    }
    assert.match(text, /29,415\.56/, 'the total, in the currency of the invoice');
    assert.match(text, /2,914\.06|2,915\.06/, 'and the tax');
    assert.match(text, /October 20, 2026|October \d+, 2026/, 'the dates are dates');

    // And it is the file the owner takes from the Files tab and a role attaches by path.
    const taken = await api.call('GET', `/api/companies/${fixture.companyId}/files/download?path=${encodeURIComponent(first.body.path)}`, (await api.signIn()));
    assert.equal(taken.status, 200);
    assert.equal(Buffer.from(taken.body.data, 'base64').subarray(0, 5).toString(), '%PDF-');
    assert.equal(taken.body.mime, 'application/pdf');
  } finally {
    await api.close();
  }
});

test('a hostile name prints as plain text, and nothing it names is fetched', { skip: SKIP }, async () => {
  const { api, fixture, root, browser, issue, print } = await owned();
  const requests: string[] = [];
  const listener = createServer((request, response) => { requests.push(request.url ?? ''); response.end('x'); });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  try {
    const invoice = await issue({
      ...JOB,
      customerName: `<img src=http://127.0.0.1:${port}/name.png><script>fetch('http://127.0.0.1:${port}/script')</script>\u202egnp`,
      note: `<iframe src=http://127.0.0.1:${port}/note></iframe><link rel=stylesheet href=http://127.0.0.1:${port}/css>${'x'.repeat(1_800)}`,
      lines: [{ description: `<style>@import url(http://127.0.0.1:${port}/import)</style> line`, quantity: 1, unitCents: 100 }],
    });
    const made = await print(invoice.invoiceId);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const text = await textOf(root, fixture.companyId, made.body.path, browser!);
    assert.ok(text.includes('<img src=http://127.0.0.1:'), `it is text on the page: ${text.slice(0, 300)}`);
    assert.ok(text.includes('<script>fetch('));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(requests, [], 'the page asked for nothing');
  } finally {
    listener.close();
    await api.close();
  }
});

test('the browser draws even a page that is not to be trusted without running it or fetching for it', { skip: SKIP }, async () => {
  // The invoice page escapes what it is given; this is the wall behind that one. Raw markup that a mistake in the
  // page could let through must still run nothing and ask for nothing: scripts are off, the context is offline, and
  // the policy in the page allows nothing to load.
  const { api, fixture, root, browser } = await owned();
  const requests: string[] = [];
  const listener = createServer((request, response) => { requests.push(request.url ?? ''); response.end('x'); });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  try {
    // Once with the page's own policy, and once without it, so that the policy is not what is being relied on:
    // each wall has to hold by itself where it can be told apart from the others. (Offline cannot be: a loopback
    // address is refused by the proxy as well, so only the two are seen to hold together.)
    for (const policy of [true, false]) {
      const bytes = await browser!.print(`<!doctype html><html><head>
        ${policy ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` : ''}
        <style>body { background: url(http://127.0.0.1:${port}/css) }</style></head><body>
        <p id="p">static words</p>
        <script>document.getElementById('p').textContent = 'SCRIPT RAN'; fetch('http://127.0.0.1:${port}/fetch');</script>
        <img src="http://127.0.0.1:${port}/img" onerror="document.getElementById('p').textContent = 'HANDLER RAN'">
        <iframe src="http://127.0.0.1:${port}/frame"></iframe>
        </body></html>`);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(requests, [], `nothing was asked for (policy ${policy})`);
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(root, fixture.companyId), { recursive: true });
      await writeFile(join(root, fixture.companyId, 'drawn.pdf'), bytes);
      const text = await textOf(root, fixture.companyId, 'drawn.pdf', browser!);
      assert.ok(text.includes('static words'), text);
      assert.doesNotMatch(text, /RAN/, `and nothing in it ran (policy ${policy})`);
      await rm(join(root, fixture.companyId, 'drawn.pdf'));
    }
  } finally {
    listener.close();
    await api.close();
  }
});

test('a company that works in Indonesian is sent an Indonesian page', { skip: SKIP }, async () => {
  const { api, fixture, root, browser, issue, print } = await owned();
  try {
    await setCompanyLanguages(fixture.companyId, { work: 'id', talk: null });
    const made = await print((await issue()).invoiceId);
    const text = await textOf(root, fixture.companyId, made.body.path, browser!);
    assert.match(text, /Ditagihkan kepada/i, 'the labels are in capitals on the page: it is a style, not the text');
    assert.match(text, /29\.415,56/);
  } finally {
    await api.close();
  }
});

test('what cannot be printed says why: a voided invoice, another company\'s invoice, one that is not there', { skip: SKIP }, async () => {
  const { api, fixture, issue, print, base, owner, mine } = await owned();
  try {
    const voided = await issue();
    await withTenant(fixture.companyId, (tx) => voidInvoice(tx, fixture.companyId, voided.invoiceId, 'owner'));
    const refused = await print(voided.invoiceId);
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /INV-0001 was voided: there is no invoice to print/);

    const other = await createCompany('invoice-pdf-other');
    const strangers = await withTenant(other.companyId, (tx) => issueInvoice(tx, other.companyId, JOB, 'owner'));
    const stranger = await print(strangers.invoiceId);
    assert.equal(stranger.status, 400);
    assert.match(String(stranger.body.error), /no invoice .* in these books/);
    assert.equal((await api.call('POST', `/api/companies/${other.companyId}/invoices/${strangers.invoiceId}/pdf`, owner, {})).status, 200, 'its own owner can');

    assert.equal((await api.call('POST', `${base}/invoices/${randomId()}/pdf`, owner, {})).status, 400, 'an invoice that is not there');
    assert.equal(existsSync(join(mine, 'invoices')), false, 'and nothing was kept for any of these');
  } finally {
    await api.close();
  }
});

test('with no browser in the deployment it says so, and nothing is kept', async () => {
  const noBrowser = await owned({ browser: false });
  try {
    const made = await noBrowser.issue();
    const answer = await noBrowser.print(made.invoiceId);
    assert.equal(answer.status >= 400, true);
    assert.match(String(answer.body.error), /no browser: install Chromium on its machine, or set PALUGADA_CHROMIUM to one/);
  } finally {
    await noBrowser.api.close();
  }
});

test('with no files root it says so', { skip: SKIP }, async () => {
  const noFiles = await owned({ files: false });
  try {
    const made = await noFiles.issue();
    const answer = await noFiles.print(made.invoiceId);
    assert.equal(answer.status >= 400, true);
    assert.match(String(answer.body.error), /keeps no files: PALUGADA_FILES_ROOT is not set/);
  } finally {
    await noFiles.api.close();
  }
});

test('a link put where the folder goes does not take the page out of the company\'s files', { skip: SKIP }, async () => {
  const linked = await owned();
  try {
    const outside = await mkdtemp(join(tmpdir(), 'palugada-invoice-pdf-outside-'));
    roots.push(outside);
    const made = await linked.issue();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(linked.mine, { recursive: true });
    await symlink(outside, join(linked.mine, 'invoices'));
    const answer = await linked.print(made.invoiceId);
    assert.equal(answer.status >= 400, true, JSON.stringify(answer.body));
    assert.deepEqual(await readdir(outside), [], 'nothing was written outside');
  } finally {
    await linked.api.close();
  }
});

test('a stored invoice is read back as it was issued', async () => {
  // The page is drawn from `invoiceWith`, the same read the Books page uses: what a role issued with a strange
  // description is what prints. This pins that the read gives the page what it needs, without a browser.
  const { api, fixture, issue } = await owned({ browser: false });
  try {
    const made = await issue();
    const seen = await withTenant(fixture.companyId, (tx) => invoiceWith(tx, fixture.companyId, made.number));
    const html = invoiceHtml(seen!, 'Kopi Senja', 'en');
    for (const said of ['INV-0001', 'Toko Kopi Senja', 'Desain kemasan', 'Hosting Oktober', 'Transfer to the account']) assert.ok(html.includes(said), said);
  } finally {
    await api.close();
  }
});

function randomId(): string {
  return '00000000-0000-4000-8000-000000000000';
}
