/**
 * A letter that carries files (the audit of 6 October, P1.4: "a company that
 * cannot attach its own quotation to an email cannot sell"; src/chats/smtp.ts,
 * src/capabilities/mailbox.ts).
 *
 * `email.send` names files in the company's files, and the owner is asked
 * with every one of them named. What leaves is those files' bytes, under
 * names made plain, in a message a mail client opens; and only what the
 * company made or was given can leave -- never another company's file, never
 * a file a link leads to outside the company's directory, never what a
 * stranger sent in. A letter with no files is the letter it always was.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { CachedSecretManager } from '../../src/secrets/rotation.ts';
import { DivisionSecrets } from '../../src/secrets/manager.ts';
import { mailboxCapabilities } from '../../src/capabilities/mailbox.ts';
import { composeMail } from '../../src/chats/smtp.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { certificate, imapServer, smtpServer, type Imap, type Smtp } from '../helpers/mail-servers.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const cert = certificate();
const SKIP = cert ? false : 'no openssl to make a certificate with';
const ACCOUNT = { user: 'sales@tokokopi.example', password: 'app-password-5678' };
const refused = (code: string) => (error: unknown) => isPalugadaError(error, code as never);
const refusedWith = (code: string, said: RegExp) => (error: unknown) => isPalugadaError(error, code as never) && said.test((error as Error).message);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

const ORDER = crlf(`From: Budi <budi@kantor.example>
To: sales@tokokopi.example
Subject: Pesanan rutin
Date: Thu, 02 Oct 2026 10:00:00 +0700
Message-ID: <order-7@kantor.example>

Halo, minggu ini kami pesan 30 gelas lagi seperti biasa. Tolong kirim penawarannya.
`);

function mailboxKey(imap: Imap, smtp: Smtp): string {
  return JSON.stringify({
    address: ACCOUNT.user, password: ACCOUNT.password, imapHost: '127.0.0.1', imapPort: imap.port, smtpHost: '127.0.0.1', smtpPort: smtp.port,
  });
}

async function servers() {
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  return { imap, smtp, close: async () => { await imap.close(); await smtp.close(); } };
}

/** The deployment's folder of company files, and the mailbox capabilities that find files in it (or, given none, in nothing). */
async function setting(fixture: Fixture, filesRoot: string | null) {
  const registry = new CapabilityRegistry();
  for (const capability of mailboxCapabilities({ ca: cert!.cert, ...(filesRoot ? { filesRoot } : {}) })) registry.register(capability);
  await registry.sync();
  let broker: CapabilityBroker | null = null;
  const api = await consoleWithSettings({ registry, credentialFor: (companyId, divisionId) => broker!.credentialFor(companyId, divisionId) });
  broker = new CapabilityBroker(registry, undefined, new CachedSecretManager(new DivisionSecrets(api.secrets)));
  await grantCapability(fixture, 'mailbox.read');
  await grantCapability(fixture, 'email.send');
  const token = await api.signIn();
  const path = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`;
  return { api, broker, token, path };
}

async function runningTask(fixture: Fixture): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Kirim penawaran' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

/** A file in one company's files, made as a role or the owner would have made it. */
async function put(root: string, companyId: string, path: string, bytes: Buffer | string): Promise<void> {
  const at = join(root, companyId, path);
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, bytes);
}

interface Part { headers: string; body: Buffer }
/** A message as a mail client reads it: its headers, and each part of a multipart body with its bytes decoded. */
function opened(data: string): { headers: string; parts: Part[] } {
  const [headers = '', ...rest] = data.split('\r\n\r\n');
  const boundary = /boundary="([^"]+)"/.exec(headers)?.[1];
  assert.ok(boundary, `a multipart message names its boundary:\n${headers}`);
  const chunks = rest.join('\r\n\r\n').split(`--${boundary}`);
  assert.equal(chunks[0], '', 'nothing before the first boundary');
  assert.equal(chunks.at(-1), '--\r\n', 'the last boundary closes the message, and nothing follows it');
  const parts = chunks.slice(1, -1).map((chunk) => {
    assert.ok(chunk.startsWith('\r\n') && chunk.endsWith('\r\n'), 'a part begins and ends on a line');
    const [head = '', ...body] = chunk.slice(2, -2).split('\r\n\r\n');
    assert.match(head, /^Content-Type: /);
    return { headers: head, body: Buffer.from(body.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64') };
  });
  return { headers, parts };
}

const offerBytes = Buffer.from('# Penawaran\n\nKopi susu — Rp 15.000 per gelas.\nBerlaku sampai 31 Oktober.\n', 'utf8');
const logoBytes = Buffer.from(Array.from({ length: 3_000 }, (_x, i) => (i * 37 + 11) % 256));
const priceBytes = Buffer.from(Array.from({ length: 700 }, (_x, i) => (i * 13 + 5) % 256));
const recapBytes = Buffer.from('menu,gelas\nkopi susu,30\n', 'utf8');

test('a letter carries the files the company made: the owner is asked with each of them named, and what leaves is those bytes under those names', { skip: SKIP }, async () => {
  const fixture = await createCompany('mail-files');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const root = await mkdtemp(join(tmpdir(), 'palugada-mail-files-'));
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture, root);
  try {
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    await put(root, fixture.companyId, 'drafts/offer.md', offerBytes);
    await put(root, fixture.companyId, 'generated/logo.png', logoBytes);
    await put(root, fixture.companyId, 'uploads/Penawaran Café.pdf', priceBytes);
    await put(root, fixture.companyId, 'computed/2026-10-06-ab12cd34/rekap.csv', recapBytes);
    mail.imap.deliver(ORDER);
    const taskId = await runningTask(fixture);
    await planTask(fixture.companyId, taskId, [{ capability: 'mailbox.read' }, { capability: 'email.send', batchSize: 1 }]);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    // The order is read, so the work now carries what a stranger wrote and the letter asks the owner first.
    const listed = (await broker.invoke(at('read'), 'mailbox.read', { from: 'budi' })).output as { messages: Array<{ uid: number }> };
    await broker.invoke(at('order'), 'mailbox.read', { uid: listed.messages[0]!.uid });
    const letter = {
      to: ['budi@kantor.example'], subject: 'Penawaran kopi', inReplyTo: '<order-7@kantor.example>',
      text: 'Halo Pak Budi,\n\nTerlampir penawaran kami.\n\nSalam,\nToko Kopi Senja',
      attachments: ['drafts/offer.md', 'generated/logo.png', 'uploads/Penawaran Café.pdf', 'computed/2026-10-06-ab12cd34/rekap.csv'],
    };

    await assert.rejects(broker.invoke(at('send'), 'email.send', letter), refused('approval.required'));
    assert.equal(mail.smtp.sent.length, 0);
    const { rows: [card] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; action_summary: string }>(
      "SELECT id, action_summary FROM inbox_items WHERE task_id = $1 AND kind = 'approval' AND decision IS NULL", [taskId]));
    assert.equal(card!.action_summary,
      'email.send: budi@kantor.example \u{1F4CE} drafts/offer.md, generated/logo.png, uploads/Penawaran Café.pdf, computed/2026-10-06-ab12cd34/rekap.csv — Penawaran kopi',
      'every file is named on the card, before the subject so a long one cannot push them off it');
    await inbox.decide(fixture.companyId, card!.id, 'approve', '', { channel: 'app' });

    // The yes was for these files: one more, or one fewer, is another question
    // (each question puts the task to waiting, and the worker puts it back to running when it resumes it).
    await assert.rejects(broker.invoke(at('more'), 'email.send', { ...letter, attachments: [...letter.attachments, 'drafts/extra.md'] }), refused('approval.required'));
    await transition(fixture.companyId, taskId, 'running');
    await assert.rejects(broker.invoke(at('fewer'), 'email.send', { ...letter, attachments: letter.attachments.slice(1) }), refused('approval.required'));
    await transition(fixture.companyId, taskId, 'running');
    assert.equal(mail.smtp.sent.length, 0);

    const sent = await broker.invoke(at('send-yes'), 'email.send', letter);
    assert.equal(sent.verified, true);
    const output = sent.output as { queued: string; attachments: Array<{ path: string; bytes: number; sha256: string }> };
    assert.match(output.queued, /^250 /);
    assert.deepEqual(output.attachments, [
      { path: 'drafts/offer.md', bytes: offerBytes.length, sha256: sha(offerBytes) },
      { path: 'generated/logo.png', bytes: logoBytes.length, sha256: sha(logoBytes) },
      { path: 'uploads/Penawaran Café.pdf', bytes: priceBytes.length, sha256: sha(priceBytes) },
      { path: 'computed/2026-10-06-ab12cd34/rekap.csv', bytes: recapBytes.length, sha256: sha(recapBytes) },
    ], 'what left, as it was at the moment it left, for the journal');

    assert.equal(mail.smtp.sent.length, 1);
    const [delivered] = mail.smtp.sent;
    const message = opened(delivered!.data);
    assert.match(message.headers, /^Content-Type: multipart\/mixed; boundary="=_palugada_[0-9a-f]{24}"$/m);
    assert.match(message.headers, /^In-Reply-To: <order-7@kantor\.example>$/m);
    assert.match(message.headers, /^From: "Toko Kopi Senja" <sales@tokokopi\.example>$/m);
    assert.ok(delivered!.data.split('\r\n').every((line) => line.length <= 998), 'no line is longer than a mail server must take');

    // The letter first, as the letter it is; then each file whole.
    assert.equal(message.parts.length, 5);
    assert.match(message.parts[0]!.headers, /^Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64$/);
    assert.equal(message.parts[0]!.body.toString('utf8'), `${letter.text.replace(/\n/g, '\r\n')}\r\n`);
    const files = message.parts.slice(1);
    assert.deepEqual(files.map((part) => part.body.equals(Buffer.alloc(0))), [false, false, false, false]);
    assert.ok(files[0]!.body.equals(offerBytes) && files[1]!.body.equals(logoBytes) && files[2]!.body.equals(priceBytes) && files[3]!.body.equals(recapBytes));
    assert.match(files[0]!.headers, /^Content-Type: text\/markdown; name="offer\.md"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="offer\.md"; filename\*=UTF-8''offer\.md$/);
    assert.match(files[1]!.headers, /^Content-Type: image\/png; name="logo\.png"/);
    // A name with a letter beyond ASCII is given twice, as clients expect: a plain one and the real one.
    assert.match(files[2]!.headers, /^Content-Type: application\/pdf; name="Penawaran-Caf_\.pdf"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="Penawaran-Caf_\.pdf"; filename\*=UTF-8''Penawaran-Caf%C3%A9\.pdf$/);
    assert.match(files[3]!.headers, /^Content-Type: text\/csv; name="rekap\.csv"/);
  } finally {
    await api.close();
    await mail.close();
  }
});

test('a letter with no files is the letter it always was, however the files are given', () => {
  const base = { from: 'sales@tokokopi.example', fromName: 'Toko Kopi Senja', to: ['budi@kantor.example'], subject: 'Halo', text: 'Terima kasih.', messageId: '<fixed@tokokopi.example>', now: new Date('2026-10-06T03:00:00Z') };
  const plain = composeMail(base);
  assert.deepEqual(composeMail({ ...base, attachments: [] }).raw, plain.raw);
  const text = plain.raw.toString('utf8');
  assert.doesNotMatch(text, /multipart|boundary/);
  assert.match(text, /^Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/m);

  // The same letter with a file is the same bytes every time it is made, so a call made again after a crash is one message.
  const one = { name: 'offer.md', mime: 'text/markdown', bytes: offerBytes };
  assert.deepEqual(composeMail({ ...base, attachments: [one] }).raw, composeMail({ ...base, attachments: [one] }).raw);
  assert.notDeepEqual(composeMail({ ...base, attachments: [one] }).raw, plain.raw);

  // A name that would end the header it is in, or the line it is on, never reaches one.
  for (const name of ['a"b.txt', 'a\\b.txt', 'a\r\nBcc: x@y.example', 'a\nb.txt', 'a\0b.txt', '']) {
    assert.throws(() => composeMail({ ...base, attachments: [{ ...one, name }] }), refused('contract.violation'), JSON.stringify(name));
  }
  // A file is never a message of its own, so it is never sent as one.
  const eml = composeMail({ ...base, attachments: [{ name: 'forwarded.eml', mime: 'message/rfc822', bytes: Buffer.from('Subject: x\r\n\r\ny') }] }).raw.toString('utf8');
  assert.match(eml, /Content-Type: application\/octet-stream; name="forwarded\.eml"/);
  assert.doesNotMatch(eml, /message\/rfc822/);
});

test('what may not leave does not: another company\'s file, a link out of the company\'s files, what a stranger sent, a folder, a file named twice, more than a letter takes', { skip: SKIP }, async () => {
  const fixture = await createCompany('mail-files-refused');
  const other = await createCompany('mail-files-other');
  const root = await mkdtemp(join(tmpdir(), 'palugada-mail-files-'));
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture, root);
  try {
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    const mine = fixture.companyId;
    // Saving the key asked the server whether it takes it: what is counted is what comes after.
    const asked = mail.smtp.commands.length;
    await put(root, mine, 'drafts/offer.md', offerBytes);
    await put(root, mine, 'drafts/other.md', offerBytes);
    await put(root, mine, 'received/budi/ktp.pdf', priceBytes);
    await put(root, other.companyId, 'drafts/secret.md', 'the other company\'s offer');
    await writeFile(join(root, 'outside.txt'), 'inside the deployment, in nobody\'s files');
    await symlink(join(root, 'outside.txt'), join(root, mine, 'drafts', 'to-outside.md'));
    await symlink(join(root, other.companyId, 'drafts', 'secret.md'), join(root, mine, 'drafts', 'to-other.md'));
    await symlink(join(root, mine, 'received', 'budi', 'ktp.pdf'), join(root, mine, 'drafts', 'to-received.pdf'));
    await put(root, mine, 'notes.txt', 'at the top of the company\'s files, in no folder a letter takes from');
    await put(root, mine, 'big/one.bin', Buffer.alloc(6 * 1_048_576, 7));
    await put(root, mine, 'uploads/six-a.bin', Buffer.alloc(6 * 1_048_576, 1));
    await put(root, mine, 'uploads/six-b.bin', Buffer.alloc(6 * 1_048_576, 2));

    const taskId = await runningTask(fixture);
    await planTask(fixture.companyId, taskId, [{ capability: 'email.send', batchSize: 1 }]);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    const letter = { to: ['budi@kantor.example'], subject: 'Penawaran', text: 'Terlampir.' };
    const attempt = (key: string, attachments: unknown) => broker.invoke(at(key), 'email.send', { ...letter, attachments } as never);

    const no = (key: string, attachments: unknown, said: RegExp) => assert.rejects(attempt(key, attachments), refusedWith('contract.violation', said), key);
    await no('other', [`../${other.companyId}/drafts/secret.md`], /outside the company's files/);
    await no('absolute', ['/etc/hostname'], /outside the company's files|no file/);
    await no('link-out', ['drafts/to-outside.md'], /outside the company's files/);
    await no('link-other', ['drafts/to-other.md'], /outside the company's files/);
    await no('link-received', ['drafts/to-received.pdf'], /not a file a letter may carry/);
    await no('received', ['received/budi/ktp.pdf'], /not a file a letter may carry/);
    await no('received-case', ['RECEIVED/budi/ktp.pdf'], /not a file a letter may carry|no file/);
    await put(root, mine, 'generated', 'a file in the company\'s files named like a folder a letter takes from');
    await no('top', ['notes.txt'], /not a file a letter may carry/);
    await no('named-like', ['generated'], /not a file a letter may carry/);
    await no('big-folder', ['big/one.bin'], /not a file a letter may carry/);
    await no('folder', ['drafts'], /is a folder/);
    await no('missing', ['drafts/nothing.md'], /there is no file drafts\/nothing\.md/);
    await no('twice', ['drafts/offer.md', './drafts/offer.md'], /named twice/);
    await no('twice-link', ['drafts/offer.md', 'drafts/../drafts/offer.md'], /named twice/);
    await no('together', ['uploads/six-a.bin', 'uploads/six-b.bin'], /at most 10 MB together/);
    await no('not-paths', [42], /does not accept/);
    await no('control', ['drafts/offer.md\r\nBcc: x@y.example'], /attachments holds paths/);
    await no('empty-path', [' '], /attachments holds paths/);
    await no('six', Array.from({ length: 6 }, (_x, i) => `drafts/f${i}.md`), /does not accept/);
    await no('string', 'drafts/offer.md', /does not accept/);

    // Nothing was said to the mail server for any of them, not even who the letter was from.
    assert.deepEqual(mail.smtp.commands.slice(asked), []);
    assert.equal(mail.smtp.sent.length, 0);

    // And what was allowed all along still goes, alone and the same letter without the refused ones.
    const ok = await attempt('ok', ['drafts/offer.md', 'drafts/other.md']);
    assert.equal(ok.verified, true);
    const message = opened(mail.smtp.sent[0]!.data);
    // Two files of one name arrive under two names: nothing is replaced in the reader's folder.
    assert.deepEqual(message.parts.slice(1).map((part) => /filename="([^"]+)"/.exec(part.headers)![1]), ['offer.md', 'other.md']);
  } finally {
    await api.close();
    await mail.close();
  }
});

test('a name a person typed arrives as one plain name, and two files of one name do not replace each other', { skip: SKIP }, async () => {
  const fixture = await createCompany('mail-files-names');
  const root = await mkdtemp(join(tmpdir(), 'palugada-mail-files-'));
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture, root);
  try {
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    const mine = fixture.companyId;
    const long = `${'é'.repeat(60)}.txt`;
    await put(root, mine, 'drafts/say "hi" <now>.md', offerBytes);
    await put(root, mine, 'drafts/offer.md', offerBytes);
    await put(root, mine, 'uploads/offer.md', recapBytes);
    await put(root, mine, 'generated/offer.md', logoBytes);
    await put(root, mine, `uploads/${long}`, recapBytes);
    const taskId = await runningTask(fixture);
    await planTask(fixture.companyId, taskId, [{ capability: 'email.send', batchSize: 1 }]);
    const at = { companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId };
    await broker.invoke({ ...at, idempotencyKey: 'names' }, 'email.send', {
      to: ['budi@kantor.example'], subject: 'Nama', text: 'Terlampir.',
      attachments: ['drafts/say "hi" <now>.md', 'drafts/offer.md', 'uploads/offer.md', 'generated/offer.md', `uploads/${long}`],
    });
    const message = opened(mail.smtp.sent[0]!.data);
    const names = message.parts.slice(1).map((part) => /filename="([^"]+)"/.exec(part.headers)![1]);
    assert.deepEqual(names, ['say-hi-now.md', 'offer.md', 'offer-2.md', 'offer-3.md', `${'_'.repeat(60)}.txt`]);
    assert.ok(message.parts[2]!.body.equals(offerBytes) && message.parts[3]!.body.equals(recapBytes) && message.parts[4]!.body.equals(logoBytes), 'each name is its own file\'s');
    assert.match(message.parts[5]!.headers, new RegExp(`filename\\*=UTF-8''(%C3%A9){60}\\.txt`), 'the real name is kept for a client that reads it');
    assert.ok(mail.smtp.sent[0]!.data.split('\r\n').every((line) => line.length <= 998), 'a long name still fits a line');
    assert.ok(!/<now>|"hi"/.test(mail.smtp.sent[0]!.data), 'nothing a person typed ends a header');
  } finally {
    await api.close();
    await mail.close();
  }
});

test('a deployment that keeps no files cannot send any, and says so; its letters without files go as before', { skip: SKIP }, async () => {
  const fixture = await createCompany('mail-no-files');
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture, null);
  try {
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    const asked = mail.smtp.commands.length;
    const taskId = await runningTask(fixture);
    await planTask(fixture.companyId, taskId, [{ capability: 'email.send', batchSize: 1 }]);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    await assert.rejects(
      broker.invoke(at('files'), 'email.send', { to: ['budi@kantor.example'], subject: 'Penawaran', text: 'Terlampir.', attachments: ['drafts/offer.md'] }),
      refusedWith('contract.violation', /this deployment keeps none \(PALUGADA_FILES_ROOT is not set\)/));
    assert.deepEqual(mail.smtp.commands.slice(asked), []);
    const plain = await broker.invoke(at('plain'), 'email.send', { to: ['budi@kantor.example'], subject: 'Halo', text: 'Terima kasih.' });
    assert.equal(plain.verified, true);
    assert.deepEqual((plain.output as { attachments: unknown[] }).attachments, []);
    assert.doesNotMatch(mail.smtp.sent[0]!.data, /multipart/);
  } finally {
    await api.close();
    await mail.close();
  }
});

test('a server that says how much it takes is not sent more: refused before it is asked to receive anything', { skip: SKIP }, async () => {
  const fixture = await createCompany('mail-size');
  const root = await mkdtemp(join(tmpdir(), 'palugada-mail-files-'));
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture, root);
  try {
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    const big = Buffer.from(Array.from({ length: 1_500_000 }, (_x, i) => (i * 31 + 3) % 251));
    await put(root, fixture.companyId, 'uploads/katalog.pdf', big);
    const taskId = await runningTask(fixture);
    await planTask(fixture.companyId, taskId, [{ capability: 'email.send', batchSize: 1 }]);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    const letter = { to: ['budi@kantor.example'], subject: 'Katalog', text: 'Terlampir katalog kami.', attachments: ['uploads/katalog.pdf'] };

    mail.smtp.size = 1_048_576;
    await assert.rejects(broker.invoke(at('too-big'), 'email.send', letter),
      refusedWith('contract.violation', /the mail server takes messages up to 1\.0 MB; this one is 2\.0 MB/));
    assert.ok(!mail.smtp.commands.some((line) => /^(MAIL|RCPT|DATA)\b/i.test(line)), mail.smtp.commands.join('\n'));
    assert.equal(mail.smtp.sent.length, 0);

    // A server that takes it, takes it whole: the message is longer than a megabyte, and arrives to the byte.
    mail.smtp.size = 5 * 1_048_576;
    const sent = await broker.invoke(at('fits'), 'email.send', letter);
    assert.equal(sent.verified, true);
    const [file] = opened(mail.smtp.sent[0]!.data).parts.slice(1);
    assert.equal(sha(file!.body), sha(big));
    assert.equal((sent.output as { attachments: Array<{ sha256: string }> }).attachments[0]!.sha256, sha(big));

    // Said by no server, nothing is assumed.
    mail.smtp.size = null;
    assert.equal((await broker.invoke(at('unsaid'), 'email.send', { ...letter, subject: 'Katalog lagi' })).verified, true);
    assert.equal(mail.smtp.sent.length, 2);
  } finally {
    await api.close();
    await mail.close();
  }
});

test('the tool says what it takes: files in the company\'s files, five at most, and what strangers sent is left out', async () => {
  const [, send] = mailboxCapabilities({});
  const schema = send!.inputSchema as { properties: Record<string, { type?: string; maxItems?: number; description?: string; items?: { type: string } }> };
  assert.equal(schema.properties.attachments!.type, 'array');
  assert.equal(schema.properties.attachments!.maxItems, 5);
  assert.deepEqual(schema.properties.attachments!.items, { type: 'string', minLength: 1, maxLength: 1000 });
  assert.match(schema.properties.attachments!.description!, /What strangers sent the company cannot be sent on/);
  assert.match(schema.properties.attachments!.description!, /10 MB together/);

  // The read-back holds the letter to its files too: a message that went with fewer than were asked for is not verified.
  const asked = { to: ['budi@kantor.example'], subject: 'Penawaran', text: 'Terlampir.', attachments: ['drafts/offer.md'] };
  const result = {
    messageId: '<x@tokokopi.example>', to: asked.to, cc: [], subject: asked.subject, queued: '250 2.0.0 OK',
    attachments: [{ path: 'drafts/offer.md', bytes: 1, sha256: 'x' }],
  };
  assert.equal(await send!.verify!(asked as never, result as never, {} as never), true);
  assert.equal(await send!.verify!(asked as never, { ...result, attachments: [] } as never, {} as never), false);
});
