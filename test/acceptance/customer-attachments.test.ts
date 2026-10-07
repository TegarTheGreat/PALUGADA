/**
 * What a customer attaches to a mail reaches the company (the audit of 6
 * October, P1.4 part 5; STATUS 2.171).
 *
 * A purchase order or a price list that arrived by email was thrown away with
 * the words "which cannot be read here". It is now kept in the company's files
 * under a path this platform makes, linked to its message, shown to the owner
 * in the thread, and offered to the role that answers by `chat.read`, with what
 * a document says -- so that role needs no `files.read` over everything else.
 *
 * Every byte of it is from a stranger, which is most of what these hold it to:
 * the sender chooses no part of a path, the bytes and not the name decide what
 * a file is, nothing is run, and what cannot be kept is said and never stops
 * the message starting its work.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { transition } from '../../src/engine/tasks.ts';
import { chatCapabilities } from '../../src/capabilities/chat.ts';
import { fileTextReader } from '../../src/capabilities/files.ts';
import { pollMailboxes } from '../../src/chats/mail.ts';
import { readMail } from '../../src/chats/mime.ts';
import { displayName, keepReceivedFile, sniffReceived } from '../../src/chats/attachments.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { Browsers } from '../../src/browser/browsers.ts';
import { sealedCookies } from '../../src/browser/cookies.ts';
import { chromium } from '../helpers/browser.ts';
import { docxOf, pdfOf, xlsxOf, zipOf } from '../helpers/documents.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { certificate, imapServer, smtpServer } from '../helpers/mail-servers.ts';

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

const cert = certificate();
const EXECUTABLE = chromium();
const READER = fileURLToPath(new URL('../../console/dist/reader', import.meta.url));
const ACCOUNT = { user: 'halo@tokokopi.example', password: 'app-password-1234' };
const SKIP_MAIL = cert ? false : 'no openssl to make a certificate with';
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

interface Part { name?: string; type: string; data: Buffer | string; disposition?: string; cid?: string; headers?: string }

/** A letter from Sari with a text and the parts given, each as base64. */
function letter(id: string, parts: Part[], options: { text?: string; from?: string } = {}): string {
  const lines = [
    `From: ${options.from ?? 'Sari Kusuma <sari@pelanggan.example>'}`,
    'To: halo@tokokopi.example',
    'Subject: Pesanan kantor',
    `Message-ID: <${id}@pelanggan.example>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bx"',
    '',
    '--bx',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.text ?? 'Halo, ini pesanan kami. Mohon dikonfirmasi.',
  ];
  for (const part of parts) {
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data);
    lines.push('--bx', `Content-Type: ${part.type}${part.name ? `; name="${part.name}"` : ''}`);
    if (part.headers) lines.push(part.headers);
    else lines.push(`Content-Disposition: ${part.disposition ?? 'attachment'}${part.name ? `; filename="${part.name}"` : ''}`);
    if (part.cid) lines.push(`Content-ID: <${part.cid}>`);
    lines.push('Content-Transfer-Encoding: base64', '', (data.toString('base64').match(/.{1,76}/g) ?? ['']).join('\n'));
  }
  lines.push('--bx--', '');
  return crlf(lines.join('\n'));
}

const ORDER = pdfOf([['Purchase order PO-2026-117', 'Kopi susu gula aren: 40 cups at Rp 15.000', 'Deliver to Jl. Merdeka 5 on Monday']]);

async function world(options: { files?: boolean; browser?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'palugada-attachments-'));
  roots.push(root);
  const fixture = await createCompany('customer-attachments');
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  const browser = options.browser === false || !EXECUTABLE ? null : new Browsers({
    executable: EXECUTABLE, sandbox: false, reader: READER, cookies: sealedCookies({ master: () => null }),
  });
  if (browser) opened.push(browser);
  const api = await consoleWithSettings({ baseEnv: { PALUGADA_MAIL_CA: cert!.certPath }, files: { root } });
  const reader = options.files === false ? undefined : fileTextReader({ root }, browser ?? undefined);
  const registry = new CapabilityRegistry();
  for (const capability of chatCapabilities({ secrets: api.secrets, mail: { ca: cert!.cert } }, reader)) registry.register(capability);
  await registry.sync();
  const owner = await api.signIn();
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels`, owner, {
    kind: 'email', address: ACCOUNT.user, imapHost: '127.0.0.1', imapPort: imap.port, smtpHost: '127.0.0.1', smtpPort: smtp.port,
    password: ACCOUNT.password, roleId: fixture.roleId, goalId: fixture.goalId,
    instruction: 'Balas email pelanggan Toko Kopi Senja: pesanan, harga, pengantaran.', proof: { totp: api.code() },
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  let minutes = 0;
  const poll = () => {
    minutes += 2;
    return pollMailboxes({
      secrets: api.secrets, ca: cert!.cert, now: new Date(Date.now() + minutes * 60_000),
      ...(options.files === false ? {} : { filesRoot: root }),
    });
  };
  const messages = () => withTenant(fixture.companyId, (tx) => tx.query<{
    id: string; body: string; files: Array<{ kind: string; name: string | null; path: string | null; bytes: number; note: string | null; why: string | null }>;
    task_id: string | null;
  }>("SELECT id, body, files, task_id FROM chat_messages WHERE direction = 'in' ORDER BY created_at, id")).then((result) => result.rows);
  const task = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; input: { event: string } }>(
    "SELECT id, input FROM tasks WHERE created_by = 'webhook' ORDER BY created_at DESC LIMIT 1"))).rows[0]!;
  const broker = new CapabilityBroker(registry);
  const read = async (taskId: string) => {
    await transition(fixture.companyId, taskId, 'running');
    return (await broker.invoke({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: `read-${taskId}`,
    }, 'chat.read', {})).output as {
      messages: Array<{ from: string; text: string; files?: Array<{ kind: string; name: string | null; path: string | null; bytes: number; note?: string; text?: string; textNote?: string }> }>;
    };
  };
  return { root, fixture, imap, smtp, api, owner, poll, messages, task, read, registry, broker, mine: join(root, fixture.companyId) };
}

type World = Awaited<ReturnType<typeof world>>;
const finish = async (w: World) => { await w.api.close(); await w.imap.close(); await w.smtp.close(); };

/* ------------------------------------------------------------ the whole way --- */

test('a mailed purchase order is kept, linked to its message, shown to the owner, and read by the role that answers -- as data from outside', { skip: SKIP_MAIL || (EXECUTABLE ? false : 'no Chromium') }, async () => {
  assert.ok(existsSync(join(READER, 'pdf.min.mjs')), 'the console is built first (npm run console:build), with its PDF reader');
  const w = await world();
  try {
    w.imap.deliver(letter('po-1', [{ name: 'PO Oktober (final).pdf', type: 'application/pdf', data: ORDER }]));
    const got = await w.poll();
    assert.deepEqual([got.received, got.failed], [1, 0]);

    const [message] = await w.messages();
    assert.equal(message!.files.length, 1);
    const [file] = message!.files;
    assert.match(file!.path!, /^received\/mail\/\d{4}-\d{2}\/[0-9a-f]{8}-1\.pdf$/, 'a path this platform made, whatever the sender called it');
    assert.equal(file!.path!.split('/').at(-1)!.slice(0, 8), message!.id.slice(0, 8));
    assert.deepEqual([file!.kind, file!.bytes, file!.note, file!.name], ['pdf', ORDER.length, null, 'PO-Oktober-(final).pdf']);
    assert.deepEqual(await readFile(join(w.mine, file!.path!)), ORDER, 'the bytes the customer sent, as they sent them');

    // The run is told where it is, by a path the platform made, and not the name the sender gave.
    const task = await w.task();
    assert.match(task.input.event, new RegExp(`\\[sent a PDF, kept as ${file!.path!.replace(/[.]/g, '\\.')}: chat.read shows what it says\\]`));
    assert.doesNotMatch(task.input.event, /Oktober|final/);

    // chat.read offers the path and what the document says, and is a read of outside content.
    assert.equal(declarationFor('chat.read')?.readsOutside, true);
    const seen = await w.read(task.id);
    const sent = seen.messages.find((one) => one.from === 'customer')!.files![0]!;
    assert.deepEqual([sent.kind, sent.path, sent.bytes], ['pdf', file!.path, ORDER.length]);
    assert.match(sent.text!, /Purchase order PO-2026-117/);
    assert.match(sent.text!, /40 cups at Rp 15\.000/);
    assert.equal(sent.textNote, undefined);

    // The owner sees it in the thread, and takes it out.
    const chats = (await w.api.call('GET', `/api/companies/${w.fixture.companyId}/chats`, w.owner)).body.chats;
    const thread = (await w.api.call('GET', `/api/companies/${w.fixture.companyId}/chats/${chats[0].id}`, w.owner)).body.messages;
    assert.deepEqual(thread[0].files.map((one: { path: string; name: string }) => [one.path, one.name]), [[file!.path, 'PO-Oktober-(final).pdf']]);
    const taken = await w.api.call('GET', `/api/companies/${w.fixture.companyId}/files/download?path=${encodeURIComponent(file!.path!)}`, w.owner);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.deepEqual(Buffer.from(taken.body.data, 'base64'), ORDER);

    // And what was done is on the record by kind and size, never by the sender's name.
    const { rows: events } = await withTenant(w.fixture.companyId, (tx) => tx.query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM events WHERE type LIKE 'chat.attachment_%'"));
    assert.deepEqual(events.map((event) => [event.type, event.payload.kind, event.payload.bytes]), [['chat.attachment_kept', 'pdf', ORDER.length]]);
    assert.doesNotMatch(JSON.stringify(events), /Oktober/);
  } finally {
    await finish(w);
  }
});

test('a letter polled again, or delivered twice, keeps each file once', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    w.imap.deliver(letter('po-2', [{ name: 'a.pdf', type: 'application/pdf', data: ORDER }]));
    assert.equal((await w.poll()).received, 1);
    assert.equal((await w.poll()).received, 0, 'nothing new is nothing new');
    // The same Message-ID in a new UID is the same message, as for any mail.
    w.imap.deliver(letter('po-2', [{ name: 'a.pdf', type: 'application/pdf', data: ORDER }]));
    assert.equal((await w.poll()).received, 0);
    assert.equal((await w.messages()).length, 1);
    assert.equal((await readdir(join(w.mine, 'received', 'mail', (await w.messages())[0]!.files[0]!.path!.split('/')[2]!))).length, 1);
    const { rows } = await withTenant(w.fixture.companyId, (tx) => tx.query("SELECT 1 FROM events WHERE type = 'chat.attachment_kept'"));
    assert.equal(rows.length, 1, 'said once');
  } finally {
    await finish(w);
  }
});

test('a message that joins work already waiting keeps its files too', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    w.imap.deliver(letter('join-1', [], { text: 'Halo, saya mau pesan kopi.' }));
    w.imap.deliver(letter('join-2', [{ name: 'po.pdf', type: 'application/pdf', data: ORDER }], { text: 'PO-nya terlampir.' }));
    assert.equal((await w.poll()).received, 2);
    const [first, second] = await w.messages();
    assert.equal(first!.task_id, second!.task_id, 'the second joined the work the first started');
    assert.deepEqual(second!.files.map((one) => [one.kind, one.path?.startsWith('received/mail/')]), [['pdf', true]]);
    const { rows } = await withTenant(w.fixture.companyId, (tx) => tx.query("SELECT 1 FROM tasks WHERE created_by = 'webhook'"));
    assert.equal(rows.length, 1, 'one piece of work');
    assert.deepEqual(await readFile(join(w.mine, second!.files[0]!.path!)), ORDER);
  } finally {
    await finish(w);
  }
});

/* --------------------------------------------------------- what is not kept --- */

test('what cannot be kept is said, on the message and to the run, and the message still starts its work', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024, 0x20)]);
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
    w.imap.deliver(letter('bad-1', [
      { name: 'huge.pdf', type: 'application/pdf', data: big },
      { name: 'invoice.pdf', type: 'application/pdf', data: exe },
      { name: 'ok.txt', type: 'text/plain', data: 'Pesanan: 3 kopi\n', disposition: 'attachment' },
    ]));
    assert.equal((await w.poll()).received, 1);
    const [message] = await w.messages();
    assert.equal(message!.task_id !== null, true, 'the message started its work');
    assert.deepEqual(message!.files.map((one) => [one.path === null, one.why]), [[true, 'too_big'], [true, 'kind'], [false, null]]);
    assert.match(message!.files[0]!.note!, /over 10 MB/);
    assert.match(message!.files[1]!.note!, /program or a script, which is never kept/);
    const task = await w.task();
    assert.match(task.input.event, /\[sent a document, not kept: it is over 10 MB\]/, 'what was not kept is a document: its bytes were never read');
    assert.match(task.input.event, /\[sent a document, not kept: it is a program or a script, which is never kept\]/);
    assert.match(task.input.event, /\[sent a text file, kept as received\/mail\/\d{4}-\d{2}\/[0-9a-f]{8}-3\.txt/);
    const { rows: kept } = await withTenant(w.fixture.companyId, (tx) => tx.query("SELECT 1 FROM events WHERE type = 'chat.attachment_not_kept'"));
    assert.equal(kept.length, 2);
    assert.deepEqual(await readdir(join(w.mine, 'received', 'mail', message!.files[2]!.path!.split('/')[2]!)), [message!.files[2]!.path!.split('/')[3]]);
  } finally {
    await finish(w);
  }
});

test('a sixth file and a message over fifteen megabytes are each said, and the text still arrives', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    w.imap.deliver(letter('six', Array.from({ length: 6 }, (_one, n) => ({ name: `f${n + 1}.txt`, type: 'text/plain', data: `file ${n + 1}\n`, disposition: 'attachment' }))));
    w.imap.deliver(letter('over', [{ name: 'scan.pdf', type: 'application/pdf', data: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(12 * 1024 * 1024, 0x20)]) }], { text: 'Scan terlampir.', from: 'Budi <budi@pelanggan.example>' }));
    assert.equal((await w.poll()).received, 2);
    const [six, over] = await w.messages();
    assert.equal(six!.files.filter((one) => one.path).length, 5, 'a message keeps five');
    assert.deepEqual(over!.files.map((one) => [one.path, one.why]), [[null, 'too_big']]);
    assert.match(over!.files[0]!.note!, /the message is over 15 MB, or was cut short, and its files are not fetched/);
    const events = (await withTenant(w.fixture.companyId, (tx) => tx.query<{ input: { event: string } }>("SELECT input FROM tasks WHERE created_by = 'webhook'"))).rows.map((row) => row.input.event);
    assert.ok(events.some((event) => /Scan terlampir\./.test(event) && /not kept: the message is over 15 MB/.test(event)), `the text arrives, and the file is said not to be kept: ${events.join('\n---\n')}`);
    assert.ok(events.some((event) => /1 more file was sent and not kept: a message keeps at most 5/.test(event)), events.join('\n---\n'));
  } finally {
    await finish(w);
  }
});

test('a deployment with no files root says nothing was kept, and the message still starts its work', { skip: SKIP_MAIL }, async () => {
  const none = await world({ files: false, browser: false });
  try {
    assert.equal((await none.poll()).received, 0);
    none.imap.deliver(letter('nofiles', [{ name: 'a.pdf', type: 'application/pdf', data: ORDER }], { text: 'Tolong cek PO terlampir.' }));
    assert.equal((await none.poll()).received, 1);
    const [message] = await none.messages();
    assert.deepEqual(message!.files.map((one) => [one.path, one.why]), [[null, 'no_files']]);
    assert.match((await none.task()).input.event, /Tolong cek PO terlampir\.[\s\S]*\[sent a document, not kept: this deployment keeps no files, so nothing is kept\]/);
    assert.equal(existsSync(join(none.mine, 'received')), false);
  } finally {
    await finish(none);
  }
});

test('a company that already keeps what strangers sent up to its limit keeps no more, and says so', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    // An earlier message's files, said to come to the company's whole allowance.
    w.imap.deliver(letter('first', [{ name: 'a.txt', type: 'text/plain', data: 'one\n', disposition: 'attachment' }]));
    assert.equal((await w.poll()).received, 1);
    await withControlPlane((tx) => tx.query(
      `UPDATE chat_messages SET files = jsonb_set(files, '{0,bytes}', to_jsonb($1::bigint)) WHERE direction = 'in'`, [2 * 1024 * 1024 * 1024]));
    w.imap.deliver(letter('second', [{ name: 'b.txt', type: 'text/plain', data: 'two\n', disposition: 'attachment' }], { from: 'Budi <budi@pelanggan.example>' }));
    assert.equal((await w.poll()).received, 1);
    const second = (await w.messages()).at(-1)!;
    assert.deepEqual(second.files.map((one) => [one.path, one.why]), [[null, 'room']]);
    assert.match(second.files[0]!.note!, /remove some from Files/);
    assert.match((await w.task()).input.event, /not kept: the company already keeps as much of what strangers sent as it will/);
  } finally {
    await finish(w);
  }
});

/* ------------------------------------------------------- what a stranger names --- */

test('a stranger chooses no part of a path: a hostile name leaves a path of the platform\'s own and a plain name to show', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palugada-attachments-names-'));
  roots.push(root);
  const fixture = await createCompany('attachments-names');
  const hostile = [
    '../../etc/passwd', '..\\..\\windows\\system32\\x.pdf', '‮fdp.exe', 'CON', 'nul.txt', 'a\u0000b.pdf', 'x'.repeat(300) + '.pdf',
    'café.pdf', 'café.pdf', '.env', '   ', 'a/b/c.pdf', '<script>alert(1)</script>.pdf',
  ];
  let position = 0;
  for (const name of hostile) {
    position = (position % 5) + 1;
    const made = await keepReceivedFile({
      root, companyId: fixture.companyId, channel: 'email', at: new Date('2026-10-06T10:00:00Z'), messageId: 'a1b2c3d4-0000-4000-8000-000000000000',
      position, bytes: ORDER, claimedName: name,
    });
    assert.ok('kept' in made, JSON.stringify(made));
    assert.match(made.kept.path, /^received\/mail\/2026-10\/a1b2c3d4-[1-5]\.pdf$/, `${JSON.stringify(name)} chose nothing`);
    const shown = displayName(name);
    if (shown !== null) {
      assert.doesNotMatch(shown, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/u, `${JSON.stringify(shown)} is plain`);
      assert.ok([...shown].length <= 100);
    }
  }
  assert.deepEqual((await readdir(join(root, fixture.companyId))).sort(), ['received']);
  assert.deepEqual((await readdir(join(root, fixture.companyId, 'received'))), ['mail']);
  assert.equal(displayName('‮fdp.exe'), 'fdp.exe');
  assert.equal(displayName('../../etc/passwd'), 'passwd');
  // Both spellings of one name are one name.
  assert.equal(displayName('café.pdf'), displayName('café.pdf'));
});

test('a name in a mail is read as it was written: RFC 2231, encoded words, a quoted name with a semicolon', () => {
  const files = (headers: string) => readMail(Buffer.from(crlf(`From: a@b.example
Subject: x
Content-Type: multipart/mixed; boundary="q"

--q
Content-Type: text/plain

hi
--q
Content-Type: application/pdf
${headers}
Content-Transfer-Encoding: base64

JVBERi0=
--q--
`), 'utf8'), { keep: true }).files.map((one) => one.name);
  assert.deepEqual(files("Content-Disposition: attachment; filename*=UTF-8''%E2%80%AEfdp.exe"), ['‮fdp.exe'], 'read as written; displayName is what makes it plain');
  assert.deepEqual(files('Content-Disposition: attachment; filename*0*=UTF-8\'\'Daftar%20harga; filename*1*=%20Oktober.pdf'), ['Daftar harga Oktober.pdf']);
  assert.deepEqual(files('Content-Disposition: attachment; filename="=?UTF-8?B?RGFmdGFyIGhhcmdhLnBkZg==?="'), ['Daftar harga.pdf']);
  assert.deepEqual(files('Content-Disposition: attachment; filename="a;b.pdf"'), ['a;b.pdf']);
  assert.deepEqual(files('Content-Disposition: attachment; filename="say \\"hi\\".pdf"'), ['say "hi".pdf']);
  assert.deepEqual(files('Content-Disposition: attachment'), [null], 'a part with no name has none');
});

test('what a message carries is bounded: a signature logo does not use the five, a maze is not walked, a forwarded message is no file', () => {
  const logo = Buffer.alloc(2_000, 7);
  const parts = (n: number, extra = '') => crlf(`From: a@b.example
Subject: x
Content-Type: multipart/mixed; boundary="m"

--m
Content-Type: text/plain

hi
--m
Content-Type: image/png
Content-ID: <logo@sig>
Content-Disposition: inline
Content-Transfer-Encoding: base64

${logo.toString('base64')}
${Array.from({ length: n }, (_x, i) => `--m
Content-Type: application/pdf; name="f${i}.pdf"
Content-Disposition: attachment; filename="f${i}.pdf"
Content-Transfer-Encoding: base64

JVBERi0=`).join('\n')}
${extra}--m--
`);
  const six = readMail(Buffer.from(parts(6), 'utf8'), { keep: true });
  assert.equal(six.files.length, 5, 'five are returned');
  assert.equal(six.filesOmitted, 1, 'the sixth is counted');
  assert.deepEqual(six.files.map((one) => one.name), ['f0.pdf', 'f1.pdf', 'f2.pdf', 'f3.pdf', 'f4.pdf'], 'the logo was not one of them');
  // A forwarded message, a calendar invitation and a delivery report are not files.
  const notes = readMail(Buffer.from(parts(0, `--m
Content-Type: message/rfc822
Content-Disposition: attachment

Subject: forwarded

--m
Content-Type: text/calendar; method=REQUEST
Content-Disposition: attachment

BEGIN:VCALENDAR
--m
Content-Type: message/delivery-status

Final-Recipient: x
`), 'utf8'), { keep: true });
  assert.deepEqual(notes.files, []);
  // A maze of two hundred and more parts is read no further.
  const maze = crlf(`From: a@b.example\nSubject: x\nContent-Type: multipart/mixed; boundary="z"\n\n${Array.from({ length: 400 }, (_x, i) => `--z\nContent-Type: application/pdf\nContent-Disposition: attachment; filename="p${i}.pdf"\nContent-Transfer-Encoding: base64\n\nJVBERi0=\n`).join('')}--z--\n`);
  const walked = readMail(Buffer.from(maze, 'utf8'), { keep: true });
  assert.equal(walked.files.length, 5);
  assert.ok(walked.filesOmitted < 200, `${walked.filesOmitted}: the walk stopped`);
  // Without being asked, a message is read as it always was.
  assert.deepEqual(readMail(Buffer.from(parts(2), 'utf8')).files, []);
});

/* ---------------------------------------------------------- the bytes decide --- */

test('the bytes decide the kind, and the name a sender gave decides nothing', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  const word = docxOf(['Pesanan']);
  const sheet = xlsxOf([{ name: 'Harga', rows: [['Kopi', 15000]] }]);
  const kept = (bytes: Buffer, name: string | null) => {
    const found = sniffReceived(bytes, name);
    return 'kind' in found ? `${found.kind}.${found.ext}` : `refused: ${found.refused}`;
  };
  assert.equal(kept(ORDER, 'order.png'), 'pdf.pdf', 'a PDF called .png is a PDF');
  assert.equal(kept(png, 'order.pdf'), 'photo.png', 'a picture called .pdf is a picture');
  assert.equal(kept(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'), null), 'photo.webp');
  assert.equal(kept(Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1'), null), 'photo.gif');
  assert.equal(kept(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), null), 'photo.jpg');
  assert.equal(kept(word, 'po.docx'), 'word.docx');
  assert.equal(kept(sheet, 'harga.xlsx'), 'excel.xlsx');
  assert.equal(kept(Buffer.from('OggS\u0000\u0002'), 'note.opus'), 'voice.ogg');
  assert.equal(kept(Buffer.from('ID3\u0004\u0000\u0000\u0000'), 'note.mp3'), 'voice.mp3');
  assert.equal(kept(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]), 'note.m4a'), 'voice.m4a');
  assert.equal(kept(Buffer.from('tanggal,gelas\n2026-10-01,30\n'), 'pesanan.csv'), 'text.csv');
  assert.equal(kept(Buffer.from('{"a": 1}'), 'data.json'), 'text.json');
  assert.equal(kept(Buffer.from('{not json'), 'data.json'), 'text.txt', 'a name that claims more than the bytes bear is a plain text file');
  assert.equal(kept(Buffer.from('<html><script>alert(1)</script></html>'), 'order.png'), 'text.txt', 'markup is only ever kept as the text it is');
  // And what is refused, with the reason in words.
  assert.match(kept(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(80)]), 'order.pdf'), /refused: it is a program or a script/);
  assert.match(kept(Buffer.from('#!/bin/sh\nrm -rf /\n'), 'order.txt'), /refused: it is a program or a script/);
  assert.match(kept(Buffer.concat([Buffer.from('\u007fELF'), Buffer.alloc(80)]), null), /refused: it is a program or a script/);
  assert.match(kept(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png'), /refused: it is an SVG picture/);
  assert.match(kept(Buffer.from('<?xml version="1.0"?><svg onload="x()"/>'), 'logo.png'), /refused: it is an SVG picture/);
  assert.match(kept(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(80)]), 'old.doc'), /refused: it is an Office file from before 2007/);
  assert.match(kept(word, 'po.docm'), /refused: it is an Office file with macros/);
  assert.match(kept(sheet, 'harga.xlsm'), /refused: it is an Office file with macros/);
  assert.match(kept(zipOf({ 'a.txt': 'x' }), 'bundle.zip'), /refused: it is an archive/);
  assert.match(kept(zipOf({ 'a.txt': 'x' }), 'po.docx'), /refused: it says it is a Word document and is not one/);
  assert.match(kept(zipOf({ 'a.txt': 'x' }), 'harga.xlsx'), /refused: it says it is an Excel workbook and is not one/);
  assert.match(kept(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0]), 'x.gz'), /refused: it is an archive/);
  assert.match(kept(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]), 'v.mp4'), /refused: it is a video/);
  assert.match(kept(Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0x80]), 'x.bin'), /refused: it is a kind of file this platform does not keep/);
  assert.match(kept(Buffer.from('plain\u0000text'), 'x.txt'), /refused: it is a kind of file this platform does not keep/, 'a text with a NUL is not text');
  assert.match(kept(Buffer.alloc(0), 'x.pdf'), /refused: it is empty/);
  // A PDF with its header past the first kilobyte is not told as one: a reader would not find it either.
  assert.match(kept(Buffer.concat([Buffer.alloc(600 * 1024, 0x20), ORDER]), 'x.pdf'), /refused|text/, 'junk before %PDF- is not a PDF');
  assert.doesNotMatch(kept(Buffer.concat([Buffer.alloc(600 * 1024, 0x20), ORDER]), 'x.pdf'), /^pdf/);
});

test('a link where received files go does not carry the write out, and an earlier file is not replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palugada-attachments-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'palugada-attachments-outside-'));
  roots.push(root, outside);
  const fixture = await createCompany('attachments-link');
  const input = (bytes: Buffer) => ({
    root, companyId: fixture.companyId, channel: 'email', at: new Date('2026-10-06T10:00:00Z'),
    messageId: 'a1b2c3d4-0000-4000-8000-000000000000', position: 1, bytes, claimedName: 'a.pdf',
  });
  // The same message again, as a retry after a crash: the same file, written once.
  const first = await keepReceivedFile(input(ORDER));
  assert.ok('kept' in first);
  const again = await keepReceivedFile(input(ORDER));
  assert.deepEqual(again, first);
  // A different file under the same name is not let replace the first.
  const other = await keepReceivedFile(input(pdfOf([['another']])));
  assert.deepEqual(other, { note: 'a different file is already kept under the name this one would have', why: 'failed' });
  assert.deepEqual(await readFile(join(root, fixture.companyId, first.kept.path)), ORDER);
  // received/ replaced by a link to somewhere else.
  const second = await createCompany('attachments-link-2');
  await mkdir(join(root, second.companyId), { recursive: true });
  await symlink(outside, join(root, second.companyId, 'received'));
  const refused = await keepReceivedFile({ ...input(ORDER), companyId: second.companyId });
  assert.deepEqual(refused, { note: 'the company\'s files have a link where received files go, so nothing was written', why: 'failed' });
  assert.deepEqual(await readdir(outside), [], 'nothing was written outside');
  // A file that is already a link where the file goes.
  await mkdir(join(root, fixture.companyId, 'received', 'mail', '2026-11'), { recursive: true });
  await writeFile(join(outside, 'target'), 'precious');
  await symlink(join(outside, 'target'), join(root, fixture.companyId, 'received', 'mail', '2026-11', 'a1b2c3d4-1.pdf'));
  const linked = await keepReceivedFile({ ...input(ORDER), at: new Date('2026-11-02T10:00:00Z') });
  assert.ok('note' in linked, JSON.stringify(linked));
  assert.equal(await readFile(join(outside, 'target'), 'utf8'), 'precious');
  assert.equal(createHash('sha256').update('precious').digest('hex').length, 64);
});

/* ------------------------------------------------------------- what reads it --- */

test('a role that cannot read documents is told so in words, and a busy browser is not a failure of chat.read', { skip: SKIP_MAIL }, async () => {
  // A deployment with a files root but no browser: the file is kept, and a PDF is offered by path, with why it has no text.
  const kept = await world({ browser: false });
  try {
    assert.equal((await kept.poll()).received, 0);
    kept.imap.deliver(letter('nobrowser', [
      { name: 'po.pdf', type: 'application/pdf', data: ORDER },
      { name: 'notes.txt', type: 'text/plain', data: 'Antar sebelum jam 9.\n', disposition: 'attachment' },
    ]));
    assert.equal((await kept.poll()).received, 1);
    const seen = (await kept.read((await kept.task()).id)).messages.find((one) => one.from === 'customer')!.files!;
    assert.equal(seen[0]!.text, undefined);
    assert.match(seen[0]!.textNote!, /this deployment reads them in its browser, and has none/);
    assert.equal(seen[1]!.text, 'Antar sebelum jam 9.\n', 'text needs no browser');
  } finally {
    await finish(kept);
  }
});

test('only the newest few documents are read at once, a long one is cut and says so', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    const long = `${'Baris pesanan kopi susu gula aren. '.repeat(600)}\n`;
    w.imap.deliver(letter('docs', [1, 2, 3, 4].map((n) => ({
      name: `d${n}.txt`, type: 'text/plain', data: n === 1 ? long : `isi ${n}\n`, disposition: 'attachment',
    }))));
    assert.equal((await w.poll()).received, 1);
    const files = (await w.read((await w.task()).id)).messages.find((one) => one.from === 'customer')!.files!;
    assert.deepEqual(files.map((one) => one.text?.slice(0, 6) ?? null), ['Baris ', 'isi 2\n'.slice(0, 6), 'isi 3\n'.slice(0, 6), null]);
    assert.equal(files[0]!.text!.length, 12_000);
    assert.match(files[0]!.textNote!, /only the first 12,000 of \d+,\d+ characters are shown/);
    assert.match(files[3]!.textNote!, /only the 3 newest documents are read at once/);
    assert.ok(files.every((one) => one.path), 'every one is offered by its path');
  } finally {
    await finish(w);
  }
});

test('what a message carried is exported without its paths, so a restored company lists no file it does not have', { skip: SKIP_MAIL }, async () => {
  const w = await world({ browser: false });
  try {
    assert.equal((await w.poll()).received, 0);
    w.imap.deliver(letter('export', [{ name: 'po.pdf', type: 'application/pdf', data: ORDER }]));
    assert.equal((await w.poll()).received, 1);
    const lines: ArchiveLine[] = [];
    await exportCompany(w.fixture.companyId, (line) => { lines.push(line); });
    const row = lines.find((line) => line.section === 'chat_messages' && (line.row as { direction: string }).direction === 'in')!.row as { files: Array<Record<string, unknown>> };
    assert.deepEqual(row.files.map((one) => [one.kind, one.name, one.path, one.note, one.bytes]), [['pdf', 'po.pdf', null, 'not in the archive', ORDER.length]]);
    const imported = await importCompany(lines, { slug: 'attachments-restored' });
    const { rows } = await withTenant(imported.companyId, (tx) => tx.query<{ files: Array<{ path: string | null }> }>("SELECT files FROM chat_messages WHERE direction = 'in'"));
    assert.deepEqual(rows[0]!.files.map((one) => one.path), [null]);
  } finally {
    await finish(w);
  }
});

void planTask;
void ({} as Fixture);
