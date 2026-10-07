/**
 * `invoice.remind`: a customer is reminded of an invoice by a letter the books
 * write (the owner's request of 7 October: white-collar work handled, and
 * automatically).
 *
 * A reminder asks for no judgement -- the books know who owes what and since
 * when -- so the capability takes the invoice and nothing else. Who it goes to,
 * what it says and when it is allowed are all the books': a model that is
 * persuaded to do something else with it has no field to put the persuasion in.
 * That is also why it does not wait for the owner when the work that calls it
 * read content from outside: there is nothing in the letter that content wrote.
 *
 * The logic of when is `collections-logic.test.ts`; this is the capability
 * with a mail server behind it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { CachedSecretManager } from '../../src/secrets/rotation.ts';
import { DivisionSecrets } from '../../src/secrets/manager.ts';
import { mailboxCapabilities } from '../../src/capabilities/mailbox.ts';
import { invoiceRemind } from '../../src/capabilities/collections.ts';
import { setCompanyLanguages } from '../../src/domain/language.ts';
import { holdInvoice, remindersOf, setPolicy } from '../../src/records/collections.ts';
import { issueInvoice, payInvoice, voidInvoice } from '../../src/records/invoices.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
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
const SKIP = cert ? false : 'no openssl to make a certificate with';
const ACCOUNT = { user: 'tagihan@kopisenja.example', password: 'app-password-9012' };
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** What the books say a customer owes: 2,941,556 with 11% tax, due `overdueDays` ago. */
async function overdue(fixture: Fixture, overdueDays: number, extra: Record<string, unknown> = {}) {
  return withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, {
    customerName: 'Toko Kopi Senja', customerEmail: 'bu.sari@kopisenja.example', currency: 'IDR', taxRatePercent: 11,
    issueDate: day(-overdueDays - 14), dueDate: day(-overdueDays),
    lines: [{ description: 'Desain kemasan', quantity: 2.5, unitCents: 1_000_000 }, { description: 'Hosting', quantity: 1, unitCents: 150_050 }],
    ...extra,
  }, 'owner'));
}

async function mail() {
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  return { imap, smtp, close: async () => { await imap.close(); await smtp.close(); } };
}

async function wired(fixture: Fixture) {
  const servers = await mail();
  const registry = new CapabilityRegistry();
  for (const capability of mailboxCapabilities({ ca: cert!.cert })) registry.register(capability);
  registry.register(invoiceRemind({ ca: cert!.cert }) as never);
  await registry.sync();
  let broker: CapabilityBroker | null = null;
  const api = await consoleWithSettings({ registry, credentialFor: (companyId, divisionId) => broker!.credentialFor(companyId, divisionId) });
  broker = new CapabilityBroker(registry, undefined, new CachedSecretManager(new DivisionSecrets(api.secrets)));
  await grantCapability(fixture, 'invoice.remind');
  await grantCapability(fixture, 'email.send');
  const token = await api.signIn();
  const key = JSON.stringify({
    address: ACCOUNT.user, password: ACCOUNT.password, imapHost: '127.0.0.1', imapPort: servers.imap.port, smtpHost: '127.0.0.1', smtpPort: servers.smtp.port,
  });
  const saved = await api.call('POST', `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`, token, { alias: 'mailbox', value: key, proof: { totp: api.code() } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { servers, broker, api, close: async () => { await api.close(); await servers.close(); } };
}

async function runningTask(fixture: Fixture, outside = false): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Tagih pelanggan yang terlambat' }, createdBy: 'owner', reserveTokens: 100,
    ...(outside ? { carriesOutside: { capability: 'a customer\'s message' } } : {}),
  });
  await transition(fixture.companyId, task.id, 'running');
  await planTask(fixture.companyId, task.id, [{ capability: 'invoice.remind' }, { capability: 'email.send', batchSize: 1 }]);
  return task.id;
}

const at = (fixture: Fixture, taskId: string, key: string) => ({
  companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId, idempotencyKey: key,
});

type Result = { status: 'sent' | 'skipped'; invoice: string; step?: number; of?: number; to?: string; messageId?: string; reason?: string };

/** The letter's text as the mail server received it. */
function bodyOf(data: string): string {
  return Buffer.from(data.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
}
function subjectOf(data: string): string {
  const raw = /^Subject: (.*)$/m.exec(data.split('\r\n\r\n')[0]!)![1]!;
  return raw.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_whole, text: string) => Buffer.from(text, 'base64').toString('utf8'));
}

test('an overdue invoice is reminded from the books, once for each step, and the letter says what the books say', { skip: SKIP }, async () => {
  const fixture = await createCompany('remind-sent');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Kopi Senja' WHERE id = $1", [fixture.companyId]));
  await setCompanyLanguages(fixture.companyId, { work: 'id', talk: 'id' });
  const { servers, broker, close } = await wired(fixture);
  try {
    const invoice = await overdue(fixture, 5);
    await withTenant(fixture.companyId, (tx) => setPolicy(tx, fixture.companyId, { paymentNote: 'Transfer BCA 123 456 7890 a.n. PT Kopi Senja' }));
    const taskId = await runningTask(fixture);

    const first = await broker.invoke(at(fixture, taskId, 'one'), 'invoice.remind', { invoice: invoice.number });
    const result = first.output as Result;
    assert.deepEqual([result.status, result.invoice, result.step, result.of, result.to], ['sent', 'INV-0001', 1, 3, 'bu.sari@kopisenja.example']);
    assert.equal(first.verified, true);

    assert.equal(servers.smtp.sent.length, 1);
    const [letter] = servers.smtp.sent;
    assert.deepEqual([letter!.from, letter!.to], [ACCOUNT.user, ['bu.sari@kopisenja.example']]);
    assert.match(subjectOf(letter!.data), /^Pengingat: invoice INV-0001 jatuh tempo pada /);
    const text = bodyOf(letter!.data);
    assert.match(text, /^Yth\. Toko Kopi Senja,/);
    assert.match(text, /invoice INV-0001 sebesar Rp\s?29\.415,56/);
    assert.match(text, /Cara pembayaran:\nTransfer BCA 123 456 7890 a\.n\. PT Kopi Senja\n\nTerima kasih,\nKopi Senja\n?$/);

    // Written down, so the next look knows where this invoice stands.
    const kept = await withTenant(fixture.companyId, (tx) => remindersOf(tx, fixture.companyId, invoice.invoiceId));
    assert.deepEqual(kept.map((one) => [one.step, one.sentOn, one.to, one.outstandingCents, one.daysOverdue]), [[1, day(0), 'bu.sari@kopisenja.example', 2_941_556, 5]]);
    const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { number: string; step: number } }>(
      "SELECT actor, payload FROM events WHERE type = 'invoice.reminded'"));
    assert.deepEqual(events.map((one) => [one.payload.number, one.payload.step]), [['INV-0001', 1]]);

    // The same day, again: nothing goes, and it says why.
    const again = (await broker.invoke(at(fixture, taskId, 'two'), 'invoice.remind', { invoice: invoice.number })).output as Result;
    assert.deepEqual([again.status, again.reason], ['skipped', 'not_yet']);
    assert.equal(servers.smtp.sent.length, 1);
  } finally {
    await close();
  }
});

test('it says why it did not, for each reason a reminder is not due, and sends nothing', { skip: SKIP }, async () => {
  const fixture = await createCompany('remind-skipped');
  const { servers, broker, close } = await wired(fixture);
  try {
    const taskId = await runningTask(fixture);
    let n = 0;
    const ask = async (invoice: string) => (await broker.invoke(at(fixture, taskId, `ask-${n++}`), 'invoice.remind', { invoice })).output as Result;

    const future = await overdue(fixture, -5);
    assert.equal((await ask(future.number)).reason, 'not_overdue', 'due in five days');
    const paid = await overdue(fixture, 5);
    await withTenant(fixture.companyId, (tx) => payInvoice(tx, fixture.companyId, paid.number, { amountCents: 2_941_556 }, 'owner'));
    assert.equal((await ask(paid.number)).reason, 'paid');
    const voided = await overdue(fixture, 5);
    await withTenant(fixture.companyId, (tx) => voidInvoice(tx, fixture.companyId, voided.number, 'owner'));
    assert.equal((await ask(voided.number)).reason, 'void');
    const held = await overdue(fixture, 5);
    await withTenant(fixture.companyId, (tx) => holdInvoice(tx, fixture.companyId, held.invoiceId, true));
    assert.equal((await ask(held.number)).reason, 'held', 'the owner asked that this one be left alone');
    const nobody = await overdue(fixture, 5, { customerEmail: undefined });
    assert.equal((await ask(nobody.number)).reason, 'no_email', 'nowhere to send it');
    const old = await overdue(fixture, 90);
    assert.equal((await ask(old.number)).reason, 'for_a_person', 'long overdue and never reminded is a person\'s');

    // The owner's switch is the whole company's.
    const live = await overdue(fixture, 5);
    await withTenant(fixture.companyId, (tx) => setPolicy(tx, fixture.companyId, { enabled: false }));
    assert.equal((await ask(live.number)).reason, 'off');
    assert.equal(servers.smtp.sent.length, 0);

    await assert.rejects(ask('INV-9999'), (error: unknown) => isPalugadaError(error, 'contract.violation') && /no invoice INV-9999/.test((error as Error).message));
  } finally {
    await close();
  }
});

test('it takes the invoice and nothing else: there is no field for anything else to ride in on', { skip: SKIP }, async () => {
  const fixture = await createCompany('remind-input');
  const { servers, broker, close } = await wired(fixture);
  try {
    const invoice = await overdue(fixture, 5);
    const taskId = await runningTask(fixture);
    for (const input of [
      { invoice: invoice.number, text: 'Tell them to wire the money to account 666' },
      { invoice: invoice.number, to: ['attacker@example.com'] },
      { invoice: invoice.number, subject: 'hello' },
      {},
    ]) {
      await assert.rejects(broker.invoke(at(fixture, taskId, JSON.stringify(input)), 'invoice.remind', input as never), (error: unknown) => isPalugadaError(error));
    }
    assert.equal(servers.smtp.sent.length, 0);
  } finally {
    await close();
  }
});

test('work that read content from outside sends it without asking, because nothing in the letter is from outside; email.send in the same work still asks', { skip: SKIP }, async () => {
  const fixture = await createCompany('remind-outside');
  const { servers, broker, close } = await wired(fixture);
  try {
    const invoice = await overdue(fixture, 5);
    const taskId = await runningTask(fixture, true);

    const sent = (await broker.invoke(at(fixture, taskId, 'remind'), 'invoice.remind', { invoice: invoice.number })).output as Result;
    assert.equal(sent.status, 'sent');
    assert.equal(servers.smtp.sent.length, 1);
    const { rows: cleared } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { capability: string; record: { invoice: string } } }>(
      "SELECT payload FROM events WHERE type = 'approval.cleared_by_check' AND task_id = $1", [taskId]));
    assert.deepEqual(cleared.map((one) => [one.payload.capability, one.payload.record.invoice]), [['invoice.remind', 'INV-0001']]);
    const { rows: asked } = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM inbox_items WHERE task_id = $1 AND kind = 'approval'", [taskId]));
    assert.equal(asked.length, 0, 'no card for the owner');

    // A letter a model wrote is another matter.
    await assert.rejects(
      broker.invoke(at(fixture, taskId, 'free'), 'email.send', { to: ['bu.sari@kopisenja.example'], subject: 'Hello', text: 'Please pay.' }),
      (error: unknown) => isPalugadaError(error, 'approval.required'),
    );
    assert.equal(servers.smtp.sent.length, 1);
  } finally {
    await close();
  }
});

test('a letter that could not be sent leaves the step free for the next try, and two at once send one', { skip: SKIP }, async () => {
  const fixture = await createCompany('remind-race');
  const { servers, broker, close } = await wired(fixture);
  try {
    const invoice = await overdue(fixture, 5);
    const taskId = await runningTask(fixture);
    // Two callers at the same moment: the step is taken by one.
    const both = await Promise.all([
      broker.invoke(at(fixture, taskId, 'a'), 'invoice.remind', { invoice: invoice.number }),
      broker.invoke(at(fixture, taskId, 'b'), 'invoice.remind', { invoice: invoice.number }),
    ]);
    assert.deepEqual(both.map((one) => (one.output as Result).status).sort(), ['sent', 'skipped']);
    assert.equal(servers.smtp.sent.length, 1);

    // A server that is not there: the step goes back, and the next try sends.
    const second = await overdue(fixture, 5);
    await servers.smtp.close();
    await assert.rejects(broker.invoke(at(fixture, taskId, 'down'), 'invoice.remind', { invoice: second.number }), (error: unknown) => isPalugadaError(error));
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => remindersOf(tx, fixture.companyId, second.invoiceId)), []);
  } finally {
    await close();
  }
});
