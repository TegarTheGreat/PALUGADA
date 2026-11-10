/**
 * A write the platform keeps itself is made once for each call, whatever
 * happens between making it and the run recording that it was made (the audit
 * of 10 October: "ledger.record can double-post across the crash gap").
 *
 * The engine journals a tool call when the broker answers. A worker that dies
 * after the capability committed its write and before that answer was kept
 * runs the same step again, with the same call key (journal.ts, `callKey`): an
 * entry posted twice is money counted twice, an invoice issued twice is a
 * customer billed twice. The platform's own writers -- the books, the
 * invoices, the customer records, the measures -- now keep their answer under
 * the call's key in the transaction that writes, and a call they have answered
 * before is answered the same way and writes nothing.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const today = () => new Date().toISOString().slice(0, 10);

async function office(fixture: Fixture) {
  const registry = new CapabilityRegistry();
  for (const capability of platformCapabilities({})) registry.register(capability);
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const capability of ['ledger.read', 'ledger.record', 'invoice.issue', 'crm.read', 'crm.note', 'crm.record']) {
    await grantCapability(fixture, capability);
  }
  const broker = new CapabilityBroker(registry);
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Kerjakan pembukuan dan catatan pelanggan' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  await planTask(fixture.companyId, task.id, [{ capability: 'ledger.record' }, { capability: 'invoice.issue' }, { capability: 'crm.record' }]);
  /** One call, under the key the engine would give it: the same key again is the same call made again. */
  const call = <O>(capability: string, input: Record<string, unknown>, key: string) => broker.invoke<unknown, O>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: task.id, idempotencyKey: key,
  }, capability, input).then((answer) => answer.output);
  return { call, taskId: task.id };
}

const count = (fixture: Fixture, sql: string, values: unknown[] = []) =>
  withTenant(fixture.companyId, async (tx) => Number((await tx.query<{ n: string }>(sql, values)).rows[0]!.n));

test('an entry made again under the same call is the entry already made, and a new call makes a new one', async () => {
  const fixture = await createCompany('once-entry');
  const { call } = await office(fixture);
  const rent = {
    date: today(), memo: 'Sewa ruko Oktober', currency: 'IDR',
    lines: [{ account: '5100', debitCents: 350_000_000 }, { account: '1100', creditCents: 350_000_000 }],
  };
  const first = await call<{ entryId: string }>('ledger.record', rent, 'call-rent');
  // The worker died before the run kept the answer: the step runs again.
  const again = await call<{ entryId: string }>('ledger.record', rent, 'call-rent');
  assert.equal(again.entryId, first.entryId, 'the same entry, not a second one');
  assert.equal(await count(fixture, "SELECT count(*) AS n FROM journal_entries WHERE memo = 'Sewa ruko Oktober'"), 1);

  // The same words under another call are another entry: two months' rent is two entries.
  const second = await call<{ entryId: string }>('ledger.record', rent, 'call-rent-again');
  assert.notEqual(second.entryId, first.entryId);
  assert.equal(await count(fixture, "SELECT count(*) AS n FROM journal_entries WHERE memo = 'Sewa ruko Oktober'"), 2);
});

test('an invoice issued again under the same call is the invoice already issued, and its payment is paid once', async () => {
  const fixture = await createCompany('once-invoice');
  const { call } = await office(fixture);
  const job = {
    customerName: 'Toko Kopi Senja', customerEmail: 'bu.sari@kopisenja.example', currency: 'IDR', taxRatePercent: 11,
    lines: [{ description: 'Desain kemasan', quantity: 1, unitCents: 2_000_000 }],
  };
  const issued = await call<{ number: string; invoiceId: string; totalCents: number }>('invoice.issue', job, 'call-issue');
  const reissued = await call<{ number: string; invoiceId: string }>('invoice.issue', job, 'call-issue');
  assert.deepEqual([reissued.number, reissued.invoiceId], [issued.number, issued.invoiceId]);
  assert.equal(await count(fixture, 'SELECT count(*) AS n FROM invoices'), 1, 'the customer is billed once');

  // A payment of the whole of it, made again: the second is the first, not an overpayment refused.
  const paid = {
    date: today(), memo: 'Transfer dari Toko Kopi Senja', currency: 'IDR', invoice: issued.number,
    lines: [{ account: '1100', debitCents: issued.totalCents }, { account: '1200', creditCents: issued.totalCents }],
  };
  const payment = await call<{ entryId: string }>('ledger.record', paid, 'call-paid');
  const repaid = await call<{ entryId: string }>('ledger.record', paid, 'call-paid');
  assert.equal(repaid.entryId, payment.entryId);
  assert.equal(await count(fixture, 'SELECT count(*) AS n FROM invoice_payments'), 1);
});

test('a customer kept, a deal opened and a note written again under the same call are each kept once', async () => {
  const fixture = await createCompany('once-crm');
  const { call } = await office(fixture);
  const keep = { contact: 'new', name: 'Bu Sari', organisation: 'Toko Kopi Senja', deal: { title: 'Kemasan 1 kg', stage: 'proposal' } };
  const kept = await call<{ contactId: string; created: boolean; dealId: string }>('crm.record', keep, 'call-keep');
  const keptAgain = await call<{ contactId: string; created: boolean; dealId: string }>('crm.record', keep, 'call-keep');
  assert.deepEqual(keptAgain, kept, 'the same answer');
  assert.equal(await count(fixture, "SELECT count(*) AS n FROM contacts WHERE name = 'Bu Sari'"), 1);
  assert.equal(await count(fixture, 'SELECT count(*) AS n FROM deals'), 1);

  const note = { contact: kept.contactId, body: 'Minta penawaran ulang untuk 200 kemasan.' };
  const written = await call<{ noteId: string }>('crm.note', note, 'call-note');
  const rewritten = await call<{ noteId: string }>('crm.note', note, 'call-note');
  assert.equal(rewritten.noteId, written.noteId);
  assert.equal(await count(fixture, 'SELECT count(*) AS n FROM contact_notes'), 1);
});

test('what a call answered is kept for its work only: the same key in another company writes there', async () => {
  const one = await createCompany('once-a');
  const two = await createCompany('once-b');
  const rent = {
    date: today(), memo: 'Sewa', currency: 'IDR',
    lines: [{ account: '5100', debitCents: 100 }, { account: '1100', creditCents: 100 }],
  };
  const a = await (await office(one)).call<{ entryId: string }>('ledger.record', rent, 'same-key');
  const b = await (await office(two)).call<{ entryId: string }>('ledger.record', rent, 'same-key');
  assert.notEqual(a.entryId, b.entryId);
  assert.equal(await count(two, "SELECT count(*) AS n FROM journal_entries WHERE memo = 'Sewa'"), 1);
});
