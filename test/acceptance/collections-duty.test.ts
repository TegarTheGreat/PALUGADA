/**
 * The company collects what it is owed without being asked (the owner's
 * request of 7 October: white-collar work handled, and automatically).
 *
 * The look the worker makes at each company's invoices, the task it makes for
 * the reminders that are due -- run by the platform's own procedure, with no
 * model in it -- and the cards for what a letter will not mend. The rules of
 * when are `collections-logic.test.ts`, and the capability that writes is
 * `collections.test.ts`.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { Engine } from '../../src/engine/engine.ts';
import { Worker } from '../../src/worker.ts';
import { getTask } from '../../src/engine/tasks.ts';
import { CachedSecretManager } from '../../src/secrets/rotation.ts';
import { DivisionSecrets } from '../../src/secrets/manager.ts';
import { COLLECTIONS_EVERY_MS, ensureCollections } from '../../src/duties/collections.ts';
import { dutyFor } from '../../src/duties/duties.ts';
import { holdInvoice, setPolicy } from '../../src/records/collections.ts';
import { issueInvoice, payInvoice } from '../../src/records/invoices.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { ScriptedModel } from '../helpers/scripted-model.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
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
const ACCOUNT = { user: 'tagihan@kopisenja.example', password: 'app-password-3456' };
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function overdue(fixture: Fixture, overdueDays: number, extra: Record<string, unknown> = {}) {
  return withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, {
    customerName: 'Toko Kopi Senja', customerEmail: 'bu.sari@kopisenja.example', currency: 'IDR',
    issueDate: day(-overdueDays - 14), dueDate: day(-overdueDays),
    lines: [{ description: 'Desain kemasan', quantity: 1, unitCents: 2_500_000 }],
    ...extra,
  }, 'owner'));
}

/** A letter written some days ago, as if an earlier look had sent it. */
async function sentBefore(fixture: Fixture, invoiceId: string, step: number, daysAgo: number): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `INSERT INTO invoice_reminders (company_id, invoice_id, step, sent_on, to_address, outstanding_cents, days_overdue)
     VALUES ($1, $2, $3, $4, 'bu.sari@kopisenja.example', 2500000, 10)`, [fixture.companyId, invoiceId, step, day(-daysAgo)]));
}

/** The look's day: a moment `minutes` after the last one, so the half hour between looks has passed. */
let clock = Date.now();
const later = (minutes = COLLECTIONS_EVERY_MS / 60_000 + 1) => new Date((clock += minutes * 60_000));

/** The company's mailbox, the role that may remind with it, and an engine with a model that must not be asked. */
async function office(fixture: Fixture, options: { holdsTool?: boolean; mailbox?: boolean } = {}) {
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  const registry = new CapabilityRegistry();
  for (const capability of platformCapabilities({ mail: { ca: cert!.cert } })) registry.register(capability);
  registerPlatformCapabilities(registry);
  await registry.sync();
  let broker: CapabilityBroker | null = null;
  const api = await consoleWithSettings({ registry, credentialFor: (companyId, divisionId) => broker!.credentialFor(companyId, divisionId) });
  broker = new CapabilityBroker(registry, undefined, new CachedSecretManager(new DivisionSecrets(api.secrets)));
  // Granted before the mailbox is given: a key declares the scopes of what the division may use when it is sealed.
  if (options.holdsTool ?? true) {
    await grantCapability(fixture, 'invoice.remind');
    await grantCapability(fixture, 'plan.record');
    await grantCapability(fixture, 'owner.ask');
    await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET tools = ARRAY['invoice.remind', 'plan.record', 'owner.ask'] WHERE id = $1", [fixture.roleId]));
  } else {
    await grantCapability(fixture, 'email.send');
  }
  const token = await api.signIn();
  const key = JSON.stringify({ address: ACCOUNT.user, password: ACCOUNT.password, imapHost: '127.0.0.1', imapPort: imap.port, smtpHost: '127.0.0.1', smtpPort: smtp.port });
  if (options.mailbox ?? true) {
    const saved = await api.call('POST', `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`, token, { alias: 'mailbox', value: key, proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const model = new ScriptedModel([]);
  const engine = new Engine({ broker, llm: model, handlers: new Map(), workerId: 'collector' });
  return { smtp, model, engine, broker, close: async () => { await api.close(); await smtp.close(); await imap.close(); } };
}

const statusOf = async (fixture: Fixture, taskId: string) => (await withTenant(fixture.companyId, (tx) => getTask(tx, taskId)))!;
const cards = async (fixture: Fixture) => (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'escalation');

test('an overdue invoice whose reminder is due is made a task, which writes the letter with no model', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-run');
  const { smtp, model, engine, close } = await office(fixture);
  try {
    const due = await overdue(fixture, 5);
    await overdue(fixture, 1);                         // not yet: the first step is three days late
    const paid = await overdue(fixture, 6);
    await withTenant(fixture.companyId, (tx) => payInvoice(tx, fixture.companyId, paid.number, { amountCents: 2_500_000 }, 'owner'));
    const held = await overdue(fixture, 7);
    await withTenant(fixture.companyId, (tx) => holdInvoice(tx, fixture.companyId, held.invoiceId, true));
    await overdue(fixture, 8, { customerEmail: undefined }); // nowhere to send it: a person's, below

    const look = await ensureCollections(fixture.companyId, later());
    assert.equal(look.due, 1);
    assert.ok(look.task);
    const task = await statusOf(fixture, look.task!);
    assert.match(task.idempotencyKey, /^duty:collections:/);
    assert.deepEqual(task.input.invoices, [due.number]);
    assert.ok(dutyFor(task), 'the platform made it, and the runtime knows what it is for');
    assert.equal(dutyFor({ idempotencyKey: 'role:hash' }), null, 'any other task is the role\'s');

    // The same look again is the same work, not a second one.
    assert.deepEqual(await ensureCollections(fixture.companyId, later(1)), { task: null, due: 0, escalated: 0, nobody: false }, 'looked at a minute ago');

    const outcome = await engine.runTask(fixture.companyId, look.task!, 'worker');
    assert.equal(outcome.status, 'completed', outcome.reason);
    assert.equal(model.requests.length, 0, 'no model was asked anything');
    assert.equal(smtp.sent.length, 1);
    assert.deepEqual(smtp.sent[0]!.to, ['bu.sari@kopisenja.example']);
    const done = await statusOf(fixture, look.task!);
    assert.deepEqual((done.output as { reminded: string[] }).reminded, [due.number]);
    assert.match(String((done.output as { summary: string }).summary), new RegExp(`Reminded the customers of: ${due.number}`));

    // And the one with no address is put to the owner, once.
    const [card] = await cards(fixture);
    assert.match(card!.title, /^Invoice INV-0005 needs you: Toko Kopi Senja has not paid$/);
    assert.match(card!.rationale, /there is no email address to send a reminder to/);
  } finally {
    await close();
  }
});

test('an invoice paid between the look and the work is not written to', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-paid');
  const { smtp, engine, close } = await office(fixture);
  try {
    const invoice = await overdue(fixture, 5);
    const look = await ensureCollections(fixture.companyId, later());
    assert.ok(look.task);
    await withTenant(fixture.companyId, (tx) => payInvoice(tx, fixture.companyId, invoice.number, { amountCents: 2_500_000 }, 'owner'));
    const outcome = await engine.runTask(fixture.companyId, look.task!, 'worker');
    assert.equal(outcome.status, 'completed', outcome.reason);
    assert.equal(smtp.sent.length, 0);
    assert.deepEqual((await statusOf(fixture, look.task!)).output, {
      summary: 'No reminder was due.', reminded: [], left: [{ invoice: invoice.number, why: 'paid' }],
    });
  } finally {
    await close();
  }
});

test('the last letter is followed by a week, and then by the owner, once', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-last');
  const { smtp, engine, close } = await office(fixture);
  try {
    const invoice = await overdue(fixture, 30);
    await sentBefore(fixture, invoice.invoiceId, 1, 20);
    await sentBefore(fixture, invoice.invoiceId, 2, 9);

    // Thirty days late, the second letter nine days old: the last is due.
    const look = await ensureCollections(fixture.companyId, later());
    assert.equal(look.due, 1);
    assert.equal((await engine.runTask(fixture.companyId, look.task!, 'worker')).status, 'completed');
    assert.equal(smtp.sent.length, 1);
    assert.deepEqual(await cards(fixture), [], 'a letter is the answer for now');

    // A week after the last letter it is a person's. Said once, however often it is looked at.
    const week = new Date(Date.now() + 8 * 86_400_000);
    const first = await ensureCollections(fixture.companyId, week);
    assert.deepEqual([first.escalated, first.due], [1, 0]);
    const [card] = await cards(fixture);
    assert.equal(card!.title, `Invoice ${invoice.number} needs you: Toko Kopi Senja has not paid`);
    assert.match(card!.rationale, /still owes .*25,000\.00.* on invoice INV-0001, due .*, after the last reminder\. The platform has stopped writing to them/);
    const again = await ensureCollections(fixture.companyId, new Date(week.getTime() + 2 * COLLECTIONS_EVERY_MS));
    assert.equal(again.escalated, 0);
    assert.equal((await cards(fixture)).length, 1);
    assert.equal(smtp.sent.length, 1, 'and no more letters');
  } finally {
    await close();
  }
});

test('an invoice long overdue that was never reminded is the owner\'s, with no form letter', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-stale');
  const { smtp, close } = await office(fixture);
  try {
    const invoice = await overdue(fixture, 90);
    const look = await ensureCollections(fixture.companyId, later());
    assert.deepEqual([look.task, look.due, look.escalated], [null, 0, 1]);
    const [card] = await cards(fixture);
    assert.match(card!.rationale, new RegExp(`Invoice ${invoice.number} \\(.*25,000\\.00.*, Toko Kopi Senja\\) has been overdue since .*no reminder was ever sent`));
    assert.equal(smtp.sent.length, 0);
  } finally {
    await close();
  }
});

test('with nobody set to remind, the owner is told once where to switch it on, and nothing is guessed', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-nobody');
  const { smtp, close } = await office(fixture, { holdsTool: false });
  try {
    await overdue(fixture, 5);
    const look = await ensureCollections(fixture.companyId, later());
    assert.deepEqual([look.task, look.due, look.nobody], [null, 1, true]);
    const [card] = await cards(fixture);
    assert.equal(card!.title, 'Nobody is set to remind customers about overdue invoices');
    assert.match(card!.rationale, /Turn on automatic reminders under Books, Invoices/);

    // While the card is open it is not said again.
    const again = await ensureCollections(fixture.companyId, later());
    assert.equal(again.nobody, false);
    assert.equal((await cards(fixture)).length, 1);
    assert.equal(smtp.sent.length, 0);
    const { rows: role } = await withTenant(fixture.companyId, (tx) => tx.query<{ tools: string[] }>('SELECT tools FROM roles WHERE id = $1', [fixture.roleId]));
    assert.ok(!role[0]!.tools.includes('invoice.remind'), 'a role is not given a tool by the platform\'s say-so');
  } finally {
    await close();
  }
});

test('the owner\'s switch, and one company\'s books not being another\'s', { skip: SKIP }, async () => {
  const mine = await createCompany('duty-mine');
  const theirs = await createCompany('duty-theirs');
  const { close } = await office(mine);
  try {
    await overdue(mine, 5);
    await overdue(theirs, 5);
    await withTenant(mine.companyId, (tx) => setPolicy(tx, mine.companyId, { enabled: false }));
    assert.deepEqual(await ensureCollections(mine.companyId, later()), { task: null, due: 0, escalated: 0, nobody: false }, 'switched off');
    await withTenant(mine.companyId, (tx) => setPolicy(tx, mine.companyId, { enabled: true }));
    const look = await ensureCollections(mine.companyId, later());
    assert.equal(look.due, 1);
    const names = await withTenant(mine.companyId, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM tasks'));
    assert.equal(names.rows[0]!.n, 1);
    const other = await ensureCollections(theirs.companyId, later());
    assert.deepEqual([other.task, other.nobody], [null, true], 'the other company has its own books and its own nobody');
  } finally {
    await close();
  }
});

test('the worker looks at the books on its own and writes the letter in the same tick', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-worker');
  const { smtp, model, engine, close } = await office(fixture);
  try {
    const invoice = await overdue(fixture, 5);
    const worker = new Worker({ engine, companyId: fixture.companyId, maxRunsPerTick: 4 });

    // The look comes before the claim, so the task it makes is taken up at once.
    const first = await worker.tick(later());
    assert.deepEqual(first.errors, []);
    assert.equal(first.collections, 1, 'the look made the work');
    assert.equal(first.ran.filter((run) => run.status === 'completed').length, 1);
    assert.equal(smtp.sent.length, 1);
    assert.equal(model.requests.length, 0, 'no model was asked anything');
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ n: string }>('SELECT count(*)::text AS n FROM invoice_reminders WHERE invoice_id = $1', [invoice.invoiceId]));
    assert.equal(rows[0]!.n, '1');

    // And a company with nothing more due is not looked at again for half an hour, nor written to twice.
    const quiet = await worker.tick(later(5));
    assert.equal(quiet.collections, 0);
    assert.equal(smtp.sent.length, 1);
  } finally {
    await close();
  }
});

test('without a mailbox the owner is asked for it, in their language, and the task waits for it', { skip: SKIP }, async () => {
  const fixture = await createCompany('duty-mailbox');
  const { smtp, engine, close } = await office(fixture, { mailbox: false });
  try {
    await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id'"));
    await overdue(fixture, 5);
    const look = await ensureCollections(fixture.companyId, later());
    assert.ok(look.task);
    const outcome = await engine.runTask(fixture.companyId, look.task!, 'worker');
    assert.equal(outcome.status, 'waiting_approval', outcome.reason);
    assert.equal(smtp.sent.length, 0);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ title: string; payload: { key?: { alias: string } } }>(
      "SELECT title, payload FROM inbox_items WHERE task_id = $1 AND status = 'open'", [look.task!]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.payload.key?.alias, 'mailbox');
    assert.match(rows[0]!.title, /Pengingat untuk faktur yang terlambat membutuhkan kotak surat untuk mengirimnya\. Berikan kotak surat divisi ini\./);
    const { rows: slips } = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM events WHERE task_id = $1 AND type = 'language.drifted'", [look.task!]));
    assert.equal(slips.length, 0, 'the plan the procedure wrote is in the language the company works in');
  } finally {
    await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = NULL"));
    await close();
  }
});
