/**
 * A company's mailbox as a customer channel (0113, src/chats/mail.ts): the
 * third transport of the conversations Telegram began (0111), and the one
 * every small business already has.
 *
 * These hold it to the channel's rules -- connected with the owner's device,
 * a message starting work once, every reply the owner's -- and to what is the
 * mailbox's own: it is read over IMAP from the moment it was connected, not
 * from its history; mail no person sent (an auto-reply, a bounce, a list) is
 * not a customer; a message is read as a person reads it, its quoted history
 * left out; and a reply is sent over SMTP as a reply, in the same thread.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { chatCapabilities } from '../../src/capabilities/chat.ts';
import { pollMailboxes } from '../../src/chats/mail.ts';
import { Engine } from '../../src/engine/engine.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { Worker } from '../../src/worker.ts';
import { readMail } from '../../src/chats/mime.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { certificate, imapServer, smtpServer } from '../helpers/mail-servers.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const cert = certificate();
const ACCOUNT = { user: 'halo@tokokopi.example', password: 'app-password-1234' };
const refused = (code: string) => (error: unknown) => isPalugadaError(error, code as never);
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const SARI_ORDER = crlf(`From: =?UTF-8?B?${b64('Sari Kusuma')}?= <Sari@Pelanggan.example>
To: halo@tokokopi.example
Subject: =?UTF-8?Q?Pesan_kopi_untuk_kantor?=
Date: Fri, 03 Oct 2026 09:00:00 +0700
Message-ID: <msg-1@pelanggan.example>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Halo, saya mau pesan 20 gelas kopi susu untuk rapat jam 2. Bisa diantar ke =
Jl. Merdeka 5? Terima kasih. Caf=E9 favorit kami!
--b1
Content-Type: text/html; charset=utf-8

<p>Halo, saya mau pesan <b>20</b> gelas kopi susu.</p>
--b1--
`);

const SARI_MAP = crlf(`From: Sari Kusuma <sari@pelanggan.example>
To: halo@tokokopi.example
Subject: Re: Pesan kopi untuk kantor
Message-ID: <msg-2@pelanggan.example>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8

Oke, ini denahnya ya.

On Fri, 3 Oct 2026 at 09:05, Toko Kopi Senja <halo@tokokopi.example> wrote:
> Siap, Kak Sari!
--b2
Content-Type: image/png; name="denah.png"
Content-Disposition: attachment; filename="denah.png"
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--b2--
`);

const AUTO_REPLY = crlf(`From: Budi <budi@pelanggan.example>
To: halo@tokokopi.example
Subject: Out of office
Auto-Submitted: auto-replied
Message-ID: <auto-1@pelanggan.example>

I am away until Monday.
`);

const BOUNCE = crlf(`From: Mail Delivery Subsystem <MAILER-DAEMON@pelanggan.example>
To: halo@tokokopi.example
Subject: Delivery Status Notification (Failure)
Message-ID: <bounce-1@pelanggan.example>

Address not found.
`);

const NEWSLETTER = crlf(`From: Promo Gula <promo@gula.example>
To: halo@tokokopi.example
Subject: Diskon gula aren 20%
List-Id: <promo.gula.example>
List-Unsubscribe: <mailto:unsubscribe@gula.example>
Message-ID: <list-1@gula.example>

Diskon minggu ini.
`);

test('a message is read as a person reads it: its sender, subject, text in its charset, and not the history it quotes', () => {
  const order = readMail(Buffer.from(SARI_ORDER, 'utf8'));
  assert.deepEqual(
    { name: order.from?.name, address: order.from?.address, subject: order.subject, id: order.messageId, people: order.fromPerson },
    { name: 'Sari Kusuma', address: 'sari@pelanggan.example', subject: 'Pesan kopi untuk kantor', id: '<msg-1@pelanggan.example>', people: true },
  );
  assert.equal(order.text, 'Halo, saya mau pesan 20 gelas kopi susu untuk rapat jam 2. Bisa diantar ke Jl. Merdeka 5? Terima kasih. Café favorit kami!');
  assert.deepEqual(order.attachments, []);

  const map = readMail(Buffer.from(SARI_MAP, 'utf8'));
  assert.equal(map.text, 'Oke, ini denahnya ya.', 'what Sari quoted is not what Sari wrote');
  assert.deepEqual(map.attachments, ['photo']);

  for (const [what, raw] of [['an auto-reply', AUTO_REPLY], ['a bounce', BOUNCE], ['a list', NEWSLETTER]] as const) {
    assert.equal(readMail(Buffer.from(raw, 'utf8')).fromPerson, false, `${what} is not a customer`);
  }
  // Only HTML: read as its text.
  const html = readMail(Buffer.from(crlf(`From: a@b.example\nSubject: x\nContent-Type: text/html; charset=utf-8\n\n<div>Ada <b>meja</b> kosong?<br>Untuk 4 orang &amp; jam 7</div>\n`), 'utf8'));
  assert.equal(html.text, 'Ada meja kosong?\nUntuk 4 orang & jam 7');
});

async function connect(api: Awaited<ReturnType<typeof consoleWithSettings>>, owner: string, fixture: Fixture, ports: { imap: number; smtp: number }, extra: Record<string, unknown> = {}) {
  return api.call('POST', `/api/companies/${fixture.companyId}/chat-channels`, owner, {
    kind: 'email',
    address: ACCOUNT.user,
    imapHost: '127.0.0.1',
    imapPort: ports.imap,
    smtpHost: '127.0.0.1',
    smtpPort: ports.smtp,
    password: ACCOUNT.password,
    roleId: fixture.roleId,
    goalId: fixture.goalId,
    instruction: 'Balas email pelanggan Toko Kopi Senja: pesanan, harga, pengantaran.',
    proof: { totp: api.code() },
    ...extra,
  });
}

test('mail to the company\'s mailbox starts work, and the reply goes out in the same thread once the owner says yes', { skip: cert ? false : 'no openssl to make a certificate with' }, async () => {
  const fixture = await createCompany('chat-mail');
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  const api = await consoleWithSettings({ baseEnv: { PALUGADA_MAIL_CA: cert!.certPath } });
  const registry = new CapabilityRegistry();
  for (const capability of chatCapabilities({ secrets: api.secrets, mail: { ca: cert!.cert } })) registry.register(capability);
  await registry.sync();
  const poll = (minutes: number) => pollMailboxes({ secrets: api.secrets, ca: cert!.cert, now: new Date(Date.now() + minutes * 60_000) });
  try {
    // Mail from before the mailbox was connected is its history, not work.
    imap.deliver(crlf('From: Lama <lama@pelanggan.example>\nSubject: Lama\nMessage-ID: <old@pelanggan.example>\n\nPesanan bulan lalu.\n'));
    const owner = await api.signIn();
    const wrong = await connect(api, owner, fixture, { imap: imap.port, smtp: smtp.port }, { password: 'not-the-password' });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    assert.match(wrong.body.error, /the mailbox did not accept that address and password/);
    const { rows: none } = await withControlPlane((tx) => tx.query("SELECT 1 FROM deployment_secrets WHERE name LIKE 'chat-%'"));
    assert.equal(none.length, 0, 'nothing is sealed for a mailbox that would not open');

    const made = await connect(api, owner, fixture, { imap: imap.port, smtp: smtp.port });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual([made.body.channel.kind, made.body.channel.account, made.body.webhook], ['email', ACCOUNT.user, 'polled']);
    const { rows: [kept] } = await withControlPlane((tx) => tx.query<{ token_ref: string; mail: Record<string, unknown> }>(
      'SELECT token_ref, mail FROM chat_channels WHERE company_id = $1', [fixture.companyId]));
    assert.equal(await api.secrets.resolve(kept!.token_ref), ACCOUNT.password);
    assert.ok(!JSON.stringify(kept).includes(ACCOUNT.password), 'the password is sealed, not kept');
    assert.deepEqual(kept!.mail, { imapHost: '127.0.0.1', imapPort: imap.port, smtpHost: '127.0.0.1', smtpPort: smtp.port, username: ACCOUNT.user });

    // A customer's order, and mail no person sent.
    imap.deliver(SARI_ORDER);
    imap.deliver(AUTO_REPLY);
    imap.deliver(BOUNCE);
    imap.deliver(NEWSLETTER);
    const first = await poll(2);
    assert.deepEqual({ polled: first.polled, received: first.received, failed: first.failed }, { polled: 1, received: 1, failed: 0 });
    const { rows: tasks } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; created_by: string; input: { event: string; chat: { channel: string; customer: string } } }>(
      "SELECT id, created_by, input FROM tasks WHERE created_by = 'webhook'"));
    assert.equal(tasks.length, 1, 'one customer wrote; the old mail, the auto-reply, the bounce and the list started nothing');
    const taskId = tasks[0]!.id;
    assert.deepEqual([tasks[0]!.input.chat.channel, tasks[0]!.input.chat.customer], ['email', 'Sari Kusuma']);
    assert.match(tasks[0]!.input.event, /Subject: Pesan kopi untuk kantor/);
    assert.match(tasks[0]!.input.event, /Café favorit kami!/);
    // Polled again within the minute, the mailbox is left alone; after it, nothing new is nothing new.
    assert.equal((await poll(2)).polled, 0);
    assert.deepEqual([(await poll(4)).polled, (await poll(6)).received], [1, 0]);

    // The reply, after the owner's yes, goes from the mailbox as a reply to Sari's message.
    await transition(fixture.companyId, taskId, 'running');
    const broker = new CapabilityBroker(registry);
    const at = (key: string) => ({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
    });
    const read = (await broker.invoke(at('read'), 'chat.read', {})).output as { channel: string; handle: string; messages: Array<{ text: string; subject?: string }> };
    assert.deepEqual([read.channel, read.handle], ['email', 'sari@pelanggan.example']);
    assert.equal(read.messages[0]!.subject, 'Pesan kopi untuk kantor');
    await planTask(fixture.companyId, taskId, [{ capability: 'chat.send' }]);
    const reply = { text: 'Siap, Kak Sari! 20 kopi susu kami antar ke Jl. Merdeka 5 jam 2. Totalnya Rp 360.000.' };
    await assert.rejects(broker.invoke(at('send'), 'chat.send', reply), refused('approval.required'));
    assert.equal(smtp.sent.length, 0);
    const { rows: [card] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
      "SELECT id FROM inbox_items WHERE task_id = $1 AND kind = 'approval' AND decision IS NULL", [taskId]));
    await inbox.decide(fixture.companyId, card!.id, 'approve', '', { channel: 'app' });
    const sent = await broker.invoke(at('send-yes'), 'chat.send', reply);
    assert.equal(sent.verified, true);
    assert.equal(smtp.sent.length, 1);
    const [mail] = smtp.sent;
    assert.deepEqual([mail!.from, mail!.to, mail!.user], [ACCOUNT.user, ['sari@pelanggan.example'], ACCOUNT.user]);
    const headers = mail!.data.split('\r\n\r\n')[0]!;
    assert.match(headers, /^Subject: Re: Pesan kopi untuk kantor$/m);
    assert.match(headers, /^In-Reply-To: <msg-1@pelanggan\.example>$/m);
    assert.match(headers, /^References: <msg-1@pelanggan\.example>$/m);
    assert.match(headers, /^To: sari@pelanggan\.example$/m);
    assert.match(headers, /^Content-Type: text\/plain; charset=utf-8$/m);
    const messageId = /^Message-ID: (<[^>]+>)$/m.exec(headers)?.[1];
    assert.ok(messageId, headers);
    const body = Buffer.from(mail!.data.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.equal(body, `${reply.text}\r\n`);
    const { rows: [out] } = await withTenant(fixture.companyId, (tx) => tx.query<{ external_id: string; subject: string }>(
      "SELECT external_id, subject FROM chat_messages WHERE direction = 'out'"));
    assert.deepEqual([out!.external_id, out!.subject], [messageId, 'Re: Pesan kopi untuk kantor']);

    // Sari answers, quoting the reply, with a picture: read as what she wrote.
    imap.deliver(SARI_MAP);
    assert.equal((await poll(8)).received, 1);
    const opened = (await api.call('GET', `/api/companies/${fixture.companyId}/chats`, owner)).body.chats;
    assert.deepEqual([opened.length, opened[0].customerName, opened[0].customerHandle], [1, 'Sari Kusuma', 'sari@pelanggan.example']);
    const thread = (await api.call('GET', `/api/companies/${fixture.companyId}/chats/${opened[0].id}`, owner)).body.messages;
    assert.deepEqual(thread.map((message: { direction: string; body: string; attachment: string | null; subject: string | null }) =>
      [message.direction, message.body.slice(0, 22), message.attachment, message.subject]), [
      ['in', 'Halo, saya mau pesan 2', null, 'Pesan kopi untuk kantor'],
      ['out', 'Siap, Kak Sari! 20 kop', null, 'Re: Pesan kopi untuk kantor'],
      ['in', 'Oke, ini denahnya ya.', 'photo', 'Re: Pesan kopi untuk kantor'],
    ]);

    // The password changed at the provider: the owner sees why nothing arrives.
    imap.refuse = true;
    imap.deliver(crlf('From: Sari Kusuma <sari@pelanggan.example>\nSubject: Halo?\nMessage-ID: <msg-3@pelanggan.example>\n\nHalo?\n'));
    const failing = await poll(10);
    assert.deepEqual([failing.polled, failing.failed], [1, 1]);
    const [channel] = (await api.call('GET', `/api/companies/${fixture.companyId}/chat-channels`, owner)).body.channels;
    assert.match(channel.failure, /did not accept/);
    const { rows: noted } = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM events WHERE type = 'chat.mailbox_failed'"));
    assert.equal(noted.length, 1, 'said once, not at every poll');
    await poll(12);
    assert.equal((await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM events WHERE type = 'chat.mailbox_failed'"))).rows.length, 1);
    // Mended, the mail that waited is read, and the failure is gone.
    imap.refuse = false;
    assert.equal((await poll(14)).received, 1);
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/chat-channels`, owner)).body.channels[0].failure, null);

    // Exported and restored, the mailbox comes back closed, with where it is and without its password.
    const lines: ArchiveLine[] = [];
    await exportCompany(fixture.companyId, (line) => { lines.push(line); });
    assert.ok(!JSON.stringify(lines).includes(ACCOUNT.password));
    const restored = await importCompany(lines, { slug: 'chat-mail-restored' });
    const { rows: [copy] } = await withControlPlane((tx) => tx.query<{ enabled: boolean; mail: Record<string, unknown>; token_ref: string | null }>(
      'SELECT enabled, mail, token_ref FROM chat_channels WHERE company_id = $1', [restored.companyId]));
    assert.deepEqual([copy!.enabled, copy!.mail, copy!.token_ref], [false, kept!.mail, null]);
    const { rows: subjects } = await withTenant(restored.companyId, (tx) => tx.query<{ subject: string }>(
      'SELECT subject FROM chat_messages ORDER BY created_at'));
    assert.equal(subjects[0]!.subject, 'Pesan kopi untuk kantor');

    const closed = await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels/${channel.id}/close`, owner, {});
    assert.equal(closed.status, 200);
    await assert.rejects(api.secrets.resolve(kept!.token_ref), refused('credential.unavailable'));
    imap.deliver(crlf('From: Sari Kusuma <sari@pelanggan.example>\nSubject: Halo lagi\nMessage-ID: <msg-4@pelanggan.example>\n\nHalo lagi?\n'));
    assert.equal((await poll(16)).polled, 0, 'a closed mailbox is not read');
  } finally {
    await api.close();
    await imap.close();
    await smtp.close();
  }
});

test('a worker reads the mailboxes in its tick, and a worker kept to another company does not', { skip: cert ? false : 'no openssl to make a certificate with' }, async () => {
  const fixture = await createCompany('chat-mail-worker');
  const other = await createCompany('chat-mail-elsewhere');
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  const api = await consoleWithSettings({ baseEnv: { PALUGADA_MAIL_CA: cert!.certPath } });
  const registry = new CapabilityRegistry();
  for (const capability of chatCapabilities({ secrets: api.secrets })) registry.register(capability);
  await registry.sync();
  try {
    const owner = await api.signIn();
    assert.equal((await connect(api, owner, fixture, { imap: imap.port, smtp: smtp.port })).status, 200);
    imap.deliver(SARI_ORDER);
    const engine = new Engine({ broker: new CapabilityBroker(registry), workerId: 'worker-mail' });
    const mail = { secrets: api.secrets, ca: cert!.cert };
    const elsewhere = await new Worker({ engine, companyId: other.companyId, mail }).tick(new Date(), { runs: false });
    assert.equal(elsewhere.mail, 0, 'another company\'s worker leaves this mailbox alone');
    const report = await new Worker({ engine, mail }).tick(new Date(), { runs: false });
    assert.equal(report.mail, 1, JSON.stringify(report.errors));
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM tasks WHERE created_by = 'webhook'"));
    assert.equal(rows.length, 1);
  } finally {
    await api.close();
    await imap.close();
    await smtp.close();
  }
});
