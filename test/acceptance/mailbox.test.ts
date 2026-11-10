/**
 * A division's own mailbox as its capabilities (the tools research,
 * recommendation 1; src/capabilities/mailbox.ts): `mailbox.read` and
 * `email.send` over IMAP and SMTP, with the mailbox any small business
 * already has -- Gmail, a hosting provider's, its own server.
 *
 * These hold it to the platform's rules for a key and for an action: the
 * mailbox is the division's `mailbox` key, given in a form, checked with its
 * servers before it is sealed and never shown again; reading is tier 0 and
 * leaves the owner's mail as it was, unread where it was unread, and what it
 * read is from outside (F8.9); so the letter that answers it, at tier 2, is
 * the owner's to say yes to, and what leaves is what the card said. And to
 * the platform's rule for a name: a service the owner bound for `email.send`
 * is the one used, not this.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { bindVendorSettings, checkVendorEntry, registerVendorCapabilities } from '../../src/capabilities/vendors.ts';
import { Browsers } from '../../src/browser/browsers.ts';
import { sealedCookies } from '../../src/browser/cookies.ts';
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
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const INVOICE = crlf(`From: Pemasok Susu <tagihan@susu.example>
To: sales@tokokopi.example
Subject: =?UTF-8?B?${b64('Faktur pemasok — Oktober')}?=
Date: Wed, 01 Oct 2026 08:00:00 +0700
Message-ID: <faktur-10@susu.example>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="m1"

--m1
Content-Type: text/plain; charset=utf-8

Tagihan susu bulan Oktober: Rp 4.200.000, jatuh tempo 15 Oktober.
--m1
Content-Type: application/pdf; name="faktur.pdf"
Content-Disposition: attachment; filename="faktur.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--m1--
`);
const ORDER = crlf(`From: Budi <budi@kantor.example>
To: sales@tokokopi.example
Subject: =?UTF-8?Q?Pesanan_rutin_Caf=C3=A9_kantor?=
Date: Thu, 02 Oct 2026 10:00:00 +0700
Message-ID: <order-7@kantor.example>

Halo, minggu ini kami pesan 30 gelas lagi seperti biasa.
`);
const READ_ALREADY = crlf(`From: Sari <sari@pelanggan.example>
To: sales@tokokopi.example
Subject: Terima kasih
Date: Thu, 02 Oct 2026 12:00:00 +0700
Message-ID: <thanks@pelanggan.example>

Kopinya enak sekali.
`);
const NEWEST = crlf(`From: Rina <rina@kantor.example>
To: sales@tokokopi.example
Subject: Jadwal antar
Date: Fri, 03 Oct 2026 09:00:00 +0700
Message-ID: <jadwal@kantor.example>

Bisa antar jam 9 besok?
`);

/** The division's mailbox, as the console sends it. */
function mailboxKey(imap: Imap, smtp: Smtp, password = ACCOUNT.password): string {
  return JSON.stringify({
    address: ACCOUNT.user, password, imapHost: '127.0.0.1', imapPort: imap.port, smtpHost: '127.0.0.1', smtpPort: smtp.port,
  });
}

async function servers() {
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  return { imap, smtp, close: async () => { await imap.close(); await smtp.close(); } };
}

async function setting(fixture: Fixture) {
  const registry = new CapabilityRegistry();
  for (const capability of mailboxCapabilities({ ca: cert!.cert })) registry.register(capability);
  await registry.sync();
  let broker: CapabilityBroker | null = null;
  const api = await consoleWithSettings({ registry, credentialFor: (companyId, divisionId) => broker!.credentialFor(companyId, divisionId) });
  broker = new CapabilityBroker(registry, undefined, new CachedSecretManager(new DivisionSecrets(api.secrets)));
  await grantCapability(fixture, 'mailbox.read');
  await grantCapability(fixture, 'email.send');
  const token = await api.signIn();
  const path = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`;
  return { registry, api, broker, token, path };
}

async function runningTask(fixture: Fixture): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Balas email pelanggan' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

test('a division\'s mailbox is a key given in a form, checked with its servers before it is sealed, and asked for by what uses it', { skip: SKIP }, async () => {
  const fixture = await createCompany('mailbox-key');
  const mail = await servers();
  const { registry, api, broker, token, path } = await setting(fixture);
  try {
    // Asked for by both capabilities, with what each needs of it, and as a form.
    const before = await api.call('GET', path, token);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(before.body.needs, [{
      alias: 'mailbox', capabilities: ['email.send', 'mailbox.read'], scopes: ['mail:send', 'mail:read'], form: 'mailbox',
    }]);

    // Not a mailbox: said before the device is asked for.
    const pasted = await api.call('POST', path, token, { alias: 'mailbox', value: 'just-a-password-1234' });
    assert.equal(pasted.status, 400, JSON.stringify(pasted.body));
    assert.match(pasted.body.error, /a mailbox is given in its form/);
    const hostless = await api.call('POST', path, token, { alias: 'mailbox', value: JSON.stringify({ address: ACCOUNT.user, password: 'x'.repeat(10), imapHost: 'imaps://x', smtpHost: 'smtp.x' }) });
    assert.equal(hostless.status, 400);
    assert.match(hostless.body.error, /imapHost is the server's name/);

    // A password the servers refuse: nothing is sealed.
    const wrong = await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp, 'not-the-password'), proof: { totp: api.code() } });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    assert.match(wrong.body.error, /the mailbox did not accept that address and password/);
    const { rows: none } = await withControlPlane((tx) => tx.query("SELECT 1 FROM deployment_secrets WHERE name LIKE 'credential-%'"));
    assert.equal(none.length, 0, 'nothing is sealed for a mailbox that would not open');

    const saved = await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const listed = await api.call('GET', path, token);
    assert.deepEqual(listed.body.needs, []);
    const [held] = listed.body.credentials as Array<{ alias: string; scopes: string[]; form?: string }>;
    assert.deepEqual([held!.alias, held!.scopes, held!.form], ['mailbox', ['mail:send', 'mail:read'], 'mailbox']);
    assert.ok(!JSON.stringify(listed.body).includes(ACCOUNT.password), 'the password never comes back');

    // Sealed as the servers took it, in one shape whatever the form sent.
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM credentials WHERE division_id = $1 AND alias = 'mailbox'", [fixture.divisionId]));
    assert.deepEqual(JSON.parse(await api.secrets.resolve(row!.secret_ref)), {
      mailbox: 1, address: ACCOUNT.user, password: ACCOUNT.password, username: ACCOUNT.user,
      imapHost: '127.0.0.1', imapPort: mail.imap.port, smtpHost: '127.0.0.1', smtpPort: mail.smtp.port,
    });

    // Checked before work that may need it (F8.12): a mailbox that opens
    // passes; one whose password the provider stopped taking does not, and
    // will not pass on its own; a division given none is not held up by it.
    const reading = registry.get('mailbox.read')!;
    const sending = registry.get('email.send')!;
    const at = { companyId: fixture.companyId, divisionId: fixture.divisionId, credential: broker.credentialFor(fixture.companyId, fixture.divisionId) };
    assert.deepEqual(await reading.preflight!(at), { ok: true });
    assert.deepEqual(await sending.preflight!(at), { ok: true });
    mail.imap.refuse = true;
    const stopped = await reading.preflight!(at);
    assert.equal(stopped.ok, false);
    assert.match(String(stopped.detail), /did not accept that address and password/);
    assert.equal(stopped.transient, undefined);
    mail.imap.refuse = false;
    const other = await createCompany('mailbox-none');
    assert.deepEqual(await reading.preflight!({ companyId: other.companyId, divisionId: other.divisionId, credential: broker.credentialFor(other.companyId, other.divisionId) }),
      { ok: true, detail: 'no mailbox has been given to this division yet' });
  } finally {
    await api.close();
    await mail.close();
  }
});

test('mailbox.read lists the newest mail, finds and reads a message, and leaves it unread for the owner', { skip: SKIP }, async () => {
  const fixture = await createCompany('mailbox-read');
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture);
  try {
    mail.imap.deliver(INVOICE, { arrived: new Date('2026-10-01T01:00:00Z') });
    mail.imap.deliver(ORDER, { arrived: new Date('2026-10-02T03:00:00Z') });
    mail.imap.deliver(READ_ALREADY, { seen: true, arrived: new Date('2026-10-02T05:00:00Z') });
    mail.imap.deliver(NEWEST, { arrived: new Date('2026-10-03T02:00:00Z') });
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    const taskId = await runningTask(fixture);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    type Listing = { folder: string; messages: Array<{ uid: number; from: string; subject: string; date: string | null; unread: boolean; snippet: string; attachments: string[] }>; more: number };
    const read = async (key: string, input: Record<string, unknown>) => (await broker.invoke(at(key), 'mailbox.read', input)).output as Listing;

    // The newest first, each as a line a person scans.
    const all = await read('all', {});
    assert.equal(all.folder, 'INBOX');
    assert.deepEqual(all.messages.map((one) => [one.from, one.subject, one.unread]), [
      ['Rina <rina@kantor.example>', 'Jadwal antar', true],
      ['Sari <sari@pelanggan.example>', 'Terima kasih', false],
      ['Budi <budi@kantor.example>', 'Pesanan rutin Café kantor', true],
      ['Pemasok Susu <tagihan@susu.example>', 'Faktur pemasok — Oktober', true],
    ]);
    assert.equal(all.more, 0);
    const invoice = all.messages[3]!;
    assert.equal(invoice.date, '2026-10-01T01:00:00.000Z');
    assert.match(invoice.snippet, /^Tagihan susu bulan Oktober: Rp 4\.200\.000/);
    assert.deepEqual(invoice.attachments, ['document']);

    // At most what was asked for, saying how many more there are.
    const two = await read('two', { limit: 2 });
    assert.deepEqual([two.messages.map((one) => one.subject), two.more], [['Jadwal antar', 'Terima kasih'], 2]);
    // Found by who sent it, by its subject -- in any language -- since a day, and unread.
    assert.deepEqual((await read('from', { from: 'kantor.example' })).messages.map((one) => one.subject), ['Jadwal antar', 'Pesanan rutin Café kantor']);
    assert.deepEqual((await read('subject', { subject: 'café' })).messages.map((one) => one.subject), ['Pesanan rutin Café kantor']);
    assert.deepEqual((await read('since', { since: '2026-10-02' })).messages.map((one) => one.subject), ['Jadwal antar', 'Terima kasih', 'Pesanan rutin Café kantor']);
    assert.deepEqual((await read('unread', { unread: true, from: 'kantor' })).messages.map((one) => one.subject), ['Jadwal antar', 'Pesanan rutin Café kantor']);

    // One message, whole.
    const one = (await broker.invoke(at('one'), 'mailbox.read', { uid: invoice.uid })).output as {
      uid: number; from: string; subject: string; date: string; text: string; messageId: string; attachments: string[]; unread: boolean;
    };
    assert.deepEqual([one.uid, one.from, one.subject, one.messageId, one.unread], [invoice.uid, 'Pemasok Susu <tagihan@susu.example>', 'Faktur pemasok — Oktober', '<faktur-10@susu.example>', true]);
    assert.equal(one.text, 'Tagihan susu bulan Oktober: Rp 4.200.000, jatuh tempo 15 Oktober.');
    await assert.rejects(broker.invoke(at('gone'), 'mailbox.read', { uid: 999 }), (error: unknown) => isPalugadaError(error, 'contract.violation') && /no message 999/.test((error as Error).message));

    // Read without being marked read, in a mailbox opened read-only.
    assert.deepEqual(mail.imap.messages.map((message) => message.flags.has('\\Seen')), [false, false, true, false]);
    assert.ok(mail.imap.commands.some((command) => command.startsWith('EXAMINE')));
    assert.ok(!mail.imap.commands.some((command) => /^(SELECT|STORE|UID STORE|EXPUNGE|COPY|MOVE)/.test(command)), mail.imap.commands.join('\n'));

    // What it read is from outside, and the work is marked so (F8.9).
    const { rows: tainted } = await withTenant(fixture.companyId, (tx) => tx.query(
      "SELECT 1 FROM events WHERE type = 'content.read_outside' AND task_id = $1", [taskId]));
    assert.ok(tainted.length > 0);

    // A word to look for is one line: a line break would end the search
    // and start whatever came after it as a command of its own.
    const before = mail.imap.commands.length;
    await assert.rejects(broker.invoke(at('inject'), 'mailbox.read', { from: 'x"\r\nP99 EXPUNGE' }), refused('contract.violation'));
    await assert.rejects(broker.invoke(at('inject-folder'), 'mailbox.read', { folder: 'INBOX"\r\nP98 DELETE INBOX' }), refused('contract.violation'));
    assert.equal(mail.imap.commands.length, before, 'refused before the mailbox was asked anything');

    // A folder the server does not have is said in its words.
    await assert.rejects(broker.invoke(at('folder'), 'mailbox.read', { folder: 'Arsip' }),
      (error: unknown) => isPalugadaError(error, 'contract.violation') && /Unknown Mailbox/.test((error as Error).message));
  } finally {
    await api.close();
    await mail.close();
  }
});

test('a letter answering the mailbox leaves from it only after the owner says yes, and what leaves is what the card said', { skip: SKIP }, async () => {
  const fixture = await createCompany('mailbox-send');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const mail = await servers();
  const { api, broker, token, path } = await setting(fixture);
  try {
    assert.equal((await api.call('POST', path, token, { alias: 'mailbox', value: mailboxKey(mail.imap, mail.smtp), proof: { totp: api.code() } })).status, 200);
    mail.imap.deliver(ORDER);
    const taskId = await runningTask(fixture);
    // One letter that reaches two people is a batch of two (F8.13), and the plan says so.
    await planTask(fixture.companyId, taskId, [{ capability: 'mailbox.read' }, { capability: 'email.send', batchSize: 2 }]);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    // Budi's order, read: the work now carries what a stranger wrote.
    const listed = (await broker.invoke(at('read'), 'mailbox.read', { from: 'budi' })).output as { messages: Array<{ uid: number }> };
    const order = (await broker.invoke(at('order'), 'mailbox.read', { uid: listed.messages[0]!.uid })).output as { messageId: string };
    assert.equal(order.messageId, '<order-7@kantor.example>');
    const offer = {
      to: ['budi@kantor.example'], cc: ['rina@kantor.example'], subject: 'Penawaran kopi — paket kantor',
      text: 'Halo Pak Budi,\n\nUntuk 30 gelas per minggu kami beri harga Rp 15.000 per gelas.\n\nSalam,\nToko Kopi Senja',
      inReplyTo: '<order-7@kantor.example>',
    };

    // Refused for what it is before any card: a header that would carry
    // another, an address that is not one, more recipients than a letter has.
    await assert.rejects(broker.invoke(at('inject'), 'email.send', { ...offer, subject: 'Halo\r\nBcc: semua@example.com' }), refused('contract.violation'));
    await assert.rejects(broker.invoke(at('address'), 'email.send', { ...offer, to: ['Budi <budi@kantor.example>, x@y.example'] }), refused('contract.violation'));
    await assert.rejects(broker.invoke(at('many'), 'email.send', { ...offer, to: Array.from({ length: 11 }, (_x, n) => `p${n}@kantor.example`) }), refused('contract.violation'));
    const { rows: early } = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM inbox_items WHERE kind = 'approval'"));
    assert.equal(early.length, 0);

    // Tier 2 in work that read from outside: the owner is asked, with who it
    // goes to and what it is about.
    await assert.rejects(broker.invoke(at('send'), 'email.send', offer), refused('approval.required'));
    assert.equal(mail.smtp.sent.length, 0);
    const { rows: [card] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; action_summary: string }>(
      "SELECT id, action_summary FROM inbox_items WHERE task_id = $1 AND kind = 'approval' AND decision IS NULL", [taskId]));
    assert.equal(card!.action_summary, 'email.send: budi@kantor.example, cc rina@kantor.example — Penawaran kopi — paket kantor');
    await inbox.decide(fixture.companyId, card!.id, 'approve', '', { channel: 'app' });

    const sent = await broker.invoke(at('send-yes'), 'email.send', offer);
    assert.equal(sent.verified, true);
    const output = sent.output as { messageId: string; to: string[]; cc: string[]; subject: string; queued: string };
    assert.deepEqual([output.to, output.cc, output.subject], [offer.to, offer.cc, offer.subject]);
    assert.match(output.queued, /^250 /);
    assert.equal(mail.smtp.sent.length, 1);
    const [letter] = mail.smtp.sent;
    assert.deepEqual([letter!.from, letter!.to, letter!.user], [ACCOUNT.user, ['budi@kantor.example', 'rina@kantor.example'], ACCOUNT.user]);
    const headers = letter!.data.split('\r\n\r\n')[0]!;
    assert.match(headers, /^From: "Toko Kopi Senja" <sales@tokokopi\.example>$/m, 'from the mailbox, named for the company');
    assert.match(headers, /^To: budi@kantor\.example$/m);
    assert.match(headers, /^Cc: rina@kantor\.example$/m);
    assert.match(headers, /^In-Reply-To: <order-7@kantor\.example>$/m);
    assert.match(headers, new RegExp(`^Message-ID: ${output.messageId.replace(/[.]/g, '\\.')}$`, 'm'));
    const subject = /^Subject: (.*)$/m.exec(headers)![1]!;
    assert.equal(subject.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_whole, text: string) => Buffer.from(text, 'base64').toString('utf8')), offer.subject);
    const body = Buffer.from(letter!.data.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.equal(body, `${offer.text.replace(/\n/g, '\r\n')}\r\n`);
    assert.ok(!headers.includes('Bcc'), 'nobody the card did not name');
  } finally {
    await api.close();
    await mail.close();
  }
});

test('a service bound for the same name is used instead: the platform\'s mailbox and browser give way to it', async () => {
  const resend = {
    name: 'email.send', adapter: 'resend', tier: 2, method: 'POST', url: 'https://api.resend.com/emails',
    headers: { authorization: 'Bearer {credential}', 'idempotency-key': '{idempotencyKey}' }, body: { to: '{input.to}' },
    input: { type: 'object', required: ['to'], properties: { to: { type: 'string' } } },
    result: 'body.id', credentialAlias: 'email',
    verify: { url: 'https://api.resend.com/emails/{result}', headers: { authorization: 'Bearer {credential}' }, matches: { status: 200, path: 'body.id', equalsPath: 'result' } },
  };
  const reader = {
    name: 'web.extract', adapter: 'reader', tier: 0, method: 'POST', url: 'https://reader.example/extract',
    readOnly: true, headers: { 'idempotency-key': '{idempotencyKey}' }, body: { url: '{input.url}' }, input: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } }, result: 'body',
  };
  const browsers = new Browsers({ executable: '/nowhere/chromium', cookies: sealedCookies({ master: () => null }) });
  const fresh = () => {
    const registry = new CapabilityRegistry();
    for (const capability of platformCapabilities({ browser: browsers })) registry.register(capability);
    return registry;
  };
  try {
    const registry = fresh();
    assert.deepEqual(['mailbox.read', 'email.send', 'web.extract'].map((name) => registry.get(name)?.adapter), ['platform:mail', 'platform:mail', 'extract:browser']);

    // A vendor file, a service connected in the console, and the console's check before it saves one.
    const dir = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
    await writeFile(join(dir, 'vendors.json'), JSON.stringify({ capabilities: [resend, reader] }));
    assert.deepEqual(await registerVendorCapabilities(registry, join(dir, 'vendors.json')), ['email.send', 'web.extract']);
    assert.deepEqual(['mailbox.read', 'email.send', 'web.extract'].map((name) => registry.get(name)?.adapter), ['platform:mail', 'resend', 'reader']);

    const fromConsole = fresh();
    assert.equal(checkVendorEntry(resend, fromConsole, []).name, 'email.send');
    const notes: string[] = [];
    assert.deepEqual(bindVendorSettings(fromConsole, JSON.stringify({ capabilities: [resend] }), notes), ['email.send']);
    assert.deepEqual(notes, []);
    assert.equal(fromConsole.get('email.send')?.adapter, 'resend');
    // What the platform binds for itself is still its own.
    assert.throws(() => checkVendorEntry({ ...reader, name: 'web.fetch' }, fresh(), []), /bound already/);
  } finally {
    await browsers.close();
  }
});
