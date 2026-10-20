/**
 * The owner's side of reminders (the owner's request of 7 October: white-collar
 * work handled, and automatically): one switch that decides who writes them,
 * the days and the words on how to pay, and an invoice left alone.
 *
 * Giving a role a tool is the owner's (F2.9), so nothing in the platform gives
 * `invoice.remind` to anyone but this switch -- the roles that already bill
 * customers, or the CEO when no role does.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { holdInvoice, isHeld, policyOf, remindersOf, setPolicy } from '../../src/records/collections.ts';
import { issueInvoice } from '../../src/records/invoices.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const owing = (fixture: Fixture, overdueDays = 5) => withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, {
  customerName: 'Toko Kopi Senja', customerEmail: 'bu.sari@kopisenja.example', currency: 'IDR',
  issueDate: day(-overdueDays - 14), dueDate: day(-overdueDays), lines: [{ description: 'Desain', quantity: 1, unitCents: 2_500_000 }],
}, 'owner'));

async function open() {
  // The deployment has registered what it can do, which is how the platform knows the tier of a tool it grants.
  const registry = new CapabilityRegistry();
  for (const capability of platformCapabilities({})) registry.register(capability);
  registerPlatformCapabilities(registry);
  await registry.sync();
  const api = await consoleWithSettings({ registry });
  const token = await api.signIn();
  return { api, token };
}

const toolsOf = async (fixture: Fixture, roleId: string) => (await withTenant(fixture.companyId, (tx) => tx.query<{ tools: string[] }>('SELECT tools FROM roles WHERE id = $1', [roleId]))).rows[0]!.tools;
const granted = async (fixture: Fixture) => (await withTenant(fixture.companyId, (tx) => tx.query(
  "SELECT 1 FROM capability_grants WHERE division_id = $1 AND capability_name = 'invoice.remind'", [fixture.divisionId]))).rowCount === 1;

test('switching reminders on gives the tool to the roles that bill customers, with the grant, and says who', async () => {
  const fixture = await createCompany('collect-switch');
  const biller = await addRole(fixture, 'bookkeeper');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET tools = ARRAY['invoice.issue', 'ledger.read'], display_name = 'Sari' WHERE id = $1", [biller]));
  const { api, token } = await open();
  try {
    const path = `/api/companies/${fixture.companyId}`;
    const before = await api.call('GET', `${path}/invoices`, token);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(before.body.collections, { enabled: true, stepsDays: [3, 10, 24], paymentNote: null, senders: { names: [], waiting: ['Sari'] } });

    const on = await api.call('POST', `${path}/collections`, token, { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.given, on.body.full, on.body.ungranted, on.body.senders], [['Sari'], [], [], { names: ['Sari'], waiting: [] }]);
    assert.deepEqual(await toolsOf(fixture, biller), ['invoice.issue', 'ledger.read', 'invoice.remind']);
    assert.ok(await granted(fixture), 'the division may use it');
    assert.deepEqual(await toolsOf(fixture, fixture.roleId), [], 'the CEO is not given it when a role bills customers');

    // Again: nothing more is given, and nothing breaks.
    const twice = await api.call('POST', `${path}/collections`, token, { enabled: true });
    assert.equal(twice.status, 200, JSON.stringify(twice.body));
    assert.deepEqual(twice.body.given, []);
    assert.deepEqual((await toolsOf(fixture, biller)).filter((tool) => tool === 'invoice.remind').length, 1);
    // A change of a role, like another: on the record.
    const { rows: versions } = await withTenant(fixture.companyId, (tx) => tx.query<{ summary: string }>(
      "SELECT summary FROM config_versions WHERE kind = 'role' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1", [biller]));
    assert.match(versions[0]!.summary, /switched on reminders/);
  } finally {
    await api.close();
  }
});

test('switching reminders on grants the division what reminding takes, and nothing the owner held back', async () => {
  const fixture = await createCompany('collect-narrow');
  // Two roles that bill customers and still name email.send, which the owner
  // never let this division use (or took away): a revoked grant leaves a
  // role's list as it was. One already names invoice.remind too.
  const biller = await addRole(fixture, 'sales');
  const reminder = await addRole(fixture, 'accounts');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET tools = ARRAY['invoice.issue', 'email.send', 'ledger.record'] WHERE id = $1", [biller]);
    await tx.query("UPDATE roles SET tools = ARRAY['invoice.issue', 'invoice.remind', 'email.send'] WHERE id = $1", [reminder]);
  });
  const { api, token } = await open();
  try {
    const on = await api.call('POST', `/api/companies/${fixture.companyId}/collections`, token, { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ capability_name: string }>(
      'SELECT capability_name FROM capability_grants WHERE division_id = $1 ORDER BY capability_name', [fixture.divisionId]));
    assert.deepEqual(rows.map((row) => row.capability_name), ['invoice.remind', 'owner.ask', 'plan.record'],
      'the reminder, and the plan and the question its procedure makes: not invoice.issue, email.send or ledger.record');
  } finally {
    await api.close();
  }
});

test('with no role that bills customers, a bookkeeper is hired for it, so a company of an owner and a CEO collects too', async () => {
  const fixture = await createCompany('collect-hire');
  const { api, token } = await open();
  try {
    const on = await api.call('POST', `/api/companies/${fixture.companyId}/collections`, token, { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.given, on.body.full, on.body.ungranted, on.body.senders], [['Bookkeeper'], [], [], { names: ['Bookkeeper'], waiting: [] }]);
    // The CEO has its twelve tools already and is not asked to carry a thirteenth.
    assert.deepEqual(await toolsOf(fixture, fixture.roleId), []);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ tools: string[]; division_id: string; title: string; runtime: string }>(
      "SELECT tools, division_id, title, runtime FROM roles WHERE slug = 'bookkeeper'"));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.tools, ['memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask', 'invoice.remind', 'ledger.read']);
    assert.deepEqual([rows[0]!.division_id, rows[0]!.title], [fixture.divisionId, 'Bookkeeper'], 'in the CEO\'s division');
    assert.ok(await granted(fixture));

    // Pressed again: the bookkeeper is not hired twice.
    const twice = await api.call('POST', `/api/companies/${fixture.companyId}/collections`, token, { enabled: true });
    assert.equal(twice.status, 200, JSON.stringify(twice.body));
    assert.deepEqual(twice.body.given, []);
    assert.equal((await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM roles WHERE slug LIKE 'bookkeeper%'"))).rowCount, 1);
  } finally {
    await api.close();
  }
});

test('a bookkeeper that is paused, or run by a person, is not hired twice: reminders go on and the owner is told who cannot send them', async () => {
  const { api, token } = await open();
  try {
    // Paused by the owner: it is given the tool, and sends once it works again.
    const paused = await createCompany('collect-paused');
    const sari = await addRole(paused, 'bookkeeper');
    await withControlPlane((tx) => tx.query(
      "UPDATE roles SET tools = ARRAY['ledger.read'], display_name = 'Sari', frozen_at = now(), frozen_by = 'owner' WHERE id = $1", [sari]));
    const on = await api.call('POST', `/api/companies/${paused.companyId}/collections`, token, { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.enabled, on.body.given, on.body.unavailable], [true, ['Sari'], ['Sari']]);
    assert.deepEqual(await toolsOf(paused, sari), ['ledger.read', 'invoice.remind']);
    assert.equal((await withTenant(paused.companyId, (tx) => tx.query("SELECT 1 FROM roles WHERE slug LIKE 'bookkeeper%'"))).rowCount, 1);

    // Run by a person: the platform does not take the job from them, and does not hire another under their name.
    const person = await createCompany('collect-person');
    const budi = await addRole(person, 'bookkeeper');
    await withControlPlane((tx) => tx.query("UPDATE roles SET runtime = 'person', person_name = 'Budi', display_name = 'Budi' WHERE id = $1", [budi]));
    const again = await api.call('POST', `/api/companies/${person.companyId}/collections`, token, { enabled: true });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.given, again.body.unavailable], [[], ['Budi']]);
    assert.equal((await withTenant(person.companyId, (tx) => tx.query("SELECT 1 FROM roles WHERE slug LIKE 'bookkeeper%'"))).rowCount, 1);
  } finally {
    await api.close();
  }
});

test('in a session opened with a recovery code, letting roles write to customers asks for a device, as hiring and granting do', async () => {
  const fixture = await createCompany('collect-factor');
  const { api, token } = await open();
  try {
    const made = await api.call('POST', '/api/mfa/recovery-codes', token, { proof: { totp: api.code() } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const signedIn = await fetch(`${api.url}/api/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: made.body.codes[0] }),
    });
    const recovered = String(((await signedIn.json()) as { token: string }).token);
    const path = `/api/companies/${fixture.companyId}/collections`;

    // Switching on hires and grants; the payment note is what every letter tells customers about paying.
    for (const change of [{ enabled: true }, { paymentNote: 'Transfer BCA 999 000 1111' }]) {
      const asked = await api.call('POST', path, recovered, change);
      assert.equal(asked.status, 403, JSON.stringify(change));
      assert.match(String(asked.body.error), /second factor/);
    }
    assert.equal((await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM roles WHERE slug = 'bookkeeper'"))).rowCount, 0, 'nobody was hired');
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => policyOf(tx, fixture.companyId)), { enabled: true, stepsDays: [3, 10, 24], paymentNote: null });

    // Switching off, and the days, let nobody do anything new.
    assert.equal((await api.call('POST', path, recovered, { enabled: false })).status, 200);
    assert.equal((await api.call('POST', path, recovered, { stepsDays: [5, 12] })).status, 200);
    const shown = await api.call('POST', path, recovered, { enabled: true, proof: { totp: api.code() } });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.deepEqual(shown.body.given, ['Bookkeeper']);
  } finally {
    await api.close();
  }
});

test('a role with all twelve of its tools is left as it is, and the owner is told', async () => {
  const fixture = await createCompany('collect-full');
  const biller = await addRole(fixture, 'bookkeeper');
  const twelve = ['invoice.issue', ...Array.from({ length: 11 }, (_x, n) => `tool.${n}`)];
  await withControlPlane((tx) => tx.query("UPDATE roles SET tools = $2, display_name = 'Sari' WHERE id = $1", [biller, twelve]));
  const { api, token } = await open();
  try {
    const on = await api.call('POST', `/api/companies/${fixture.companyId}/collections`, token, { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.given, on.body.full, on.body.ungranted], [[], ['Sari'], []]);
    assert.deepEqual(await toolsOf(fixture, biller), twelve);
  } finally {
    await api.close();
  }
});

test('the days and the words on how to pay are kept, and refused when they are not what they claim to be', async () => {
  const fixture = await createCompany('collect-policy');
  const { api, token } = await open();
  try {
    const path = `/api/companies/${fixture.companyId}/collections`;
    const saved = await api.call('POST', path, token, { stepsDays: [2, 9], paymentNote: '  Transfer BCA 123 456 7890\r\na.n. PT Kopi Senja  ' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.enabled, saved.body.stepsDays, saved.body.paymentNote], [true, [2, 9], 'Transfer BCA 123 456 7890\na.n. PT Kopi Senja']);
    for (const stepsDays of [[], [3, 3], [10, 3], [0, 5], [1.5], [3, 10, 24, 40, 60, 90], ['3'], 'soon']) {
      const refused = await api.call('POST', path, token, { stepsDays });
      assert.equal(refused.status, 400, JSON.stringify(stepsDays));
      assert.match(refused.body.error, /stepsDays is one to five days/);
    }
    assert.equal((await api.call('POST', path, token, { enabled: 'yes' })).status, 400);
    assert.equal((await api.call('POST', path, token, {})).status, 400);
    const cleared = await api.call('POST', path, token, { paymentNote: null, enabled: false });
    assert.deepEqual([cleared.body.enabled, cleared.body.paymentNote, cleared.body.stepsDays], [false, null, [2, 9]]);
    assert.deepEqual(cleared.body.given, [], 'switching off gives nothing');
  } finally {
    await api.close();
  }
});

test('an invoice can be left out of the reminders and put back, and the list says what was done about each', async () => {
  const mine = await createCompany('collect-hold-mine');
  const theirs = await createCompany('collect-hold-theirs');
  const invoice = await owing(mine);
  const other = await owing(theirs);
  await withControlPlane((tx) => tx.query(
    `INSERT INTO invoice_reminders (company_id, invoice_id, step, sent_on, to_address, outstanding_cents, days_overdue)
     VALUES ($1, $2, 1, $3, 'bu.sari@kopisenja.example', 2500000, 3)`, [mine.companyId, invoice.invoiceId, day(-2)]));
  const { api, token } = await open();
  try {
    const path = `/api/companies/${mine.companyId}`;
    const hold = await api.call('POST', `${path}/invoices/${invoice.invoiceId}/reminders`, token, { held: true });
    assert.equal(hold.status, 200, JSON.stringify(hold.body));
    const listed = await api.call('GET', `${path}/invoices`, token);
    assert.deepEqual(listed.body.reminding, { [invoice.invoiceId]: { sent: 1, lastOn: day(-2), held: true, told: false } });
    const release = await api.call('POST', `${path}/invoices/${invoice.invoiceId}/reminders`, token, { held: false });
    assert.equal(release.status, 200);
    assert.equal((await api.call('GET', `${path}/invoices`, token)).body.reminding[invoice.invoiceId].held, false);

    assert.equal((await api.call('POST', `${path}/invoices/${invoice.invoiceId}/reminders`, token, { held: 'maybe' })).status, 400);
    // Another company's invoice is not this company's to hold.
    const wrong = await api.call('POST', `${path}/invoices/${other.invoiceId}/reminders`, token, { held: true });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    assert.match(wrong.body.error, /no such invoice/);
    const { rows } = await withTenant(theirs.companyId, (tx) => tx.query('SELECT 1 FROM invoice_collections'));
    assert.equal(rows.length, 0);
  } finally {
    await api.close();
  }
});

test('the policy, the letters sent and the invoices left alone travel with the company, so a restored one does not write to customers from the start again', async () => {
  const fixture = await createCompany('collect-travel');
  const invoice = await owing(fixture, 12);
  const left = await owing(fixture, 12);
  await withTenant(fixture.companyId, async (tx) => {
    await setPolicy(tx, fixture.companyId, { stepsDays: [2, 9], paymentNote: 'Transfer BCA 123' });
    await holdInvoice(tx, fixture.companyId, left.invoiceId, true);
  });
  await withControlPlane((tx) => tx.query(
    `INSERT INTO invoice_reminders (company_id, invoice_id, step, sent_on, to_address, message_id, outstanding_cents, days_overdue)
     VALUES ($1, $2, 1, $3, 'bu.sari@kopisenja.example', '<abc@kopisenja.example>', 2500000, 3)`, [fixture.companyId, invoice.invoiceId, day(-9)]));

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'collect-restored' });
  const there = await withTenant(restored.companyId, async (tx) => {
    const copies = (await tx.query<{ id: string; number: string }>('SELECT id, number FROM invoices ORDER BY number')).rows;
    return {
      policy: await policyOf(tx, restored.companyId),
      letters: await remindersOf(tx, restored.companyId, copies[0]!.id),
      held: [await isHeld(tx, restored.companyId, copies[0]!.id), await isHeld(tx, restored.companyId, copies[1]!.id)],
    };
  });
  assert.deepEqual(there.policy, { enabled: true, stepsDays: [2, 9], paymentNote: 'Transfer BCA 123' });
  assert.deepEqual(there.letters.map((one) => [one.step, one.sentOn, one.to, one.outstandingCents]), [[1, day(-9), 'bu.sari@kopisenja.example', 2_500_000]]);
  assert.deepEqual(there.held, [false, true]);
});

/**
 * A day was exported as the instant the database driver makes of it, which
 * is midnight where the exporting process runs: east of UTC that is the day
 * before, and a restored company had its letters, its invoices and their
 * entries dated a day early -- and counted the next letter from that day.
 */
test('the days in the archive are the days in the books, wherever the export ran', async () => {
  const fixture = await createCompany('collect-days');
  const invoice = await owing(fixture, 12);
  await withControlPlane((tx) => tx.query(
    `INSERT INTO invoice_reminders (company_id, invoice_id, step, sent_on, to_address, outstanding_cents, days_overdue)
     VALUES ($1, $2, 1, $3, 'bu.sari@kopisenja.example', 2500000, 3)`, [fixture.companyId, invoice.invoiceId, day(-9)]));
  const lines: ArchiveLine[] = [];
  const was = process.env.TZ;
  process.env.TZ = 'Asia/Jakarta';
  try {
    await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
  const row = (section: string) => lines.find((line) => line.section === section)!.row as Record<string, unknown>;
  assert.equal(row('invoice_reminders').sent_on, day(-9));
  assert.deepEqual([row('invoices').issue_date, row('invoices').due_date], [day(-26), day(-12)]);
  assert.equal(row('journal_entries').entry_date, day(-26));

  const restored = await importCompany(lines, { slug: 'collect-days-restored' });
  const there = await withTenant(restored.companyId, async (tx) => {
    const copy = (await tx.query<{ id: string; issue: string; due: string }>(
      "SELECT id, to_char(issue_date, 'YYYY-MM-DD') AS issue, to_char(due_date, 'YYYY-MM-DD') AS due FROM invoices")).rows[0]!;
    return { copy, letters: await remindersOf(tx, restored.companyId, copy.id) };
  });
  assert.deepEqual([there.copy.issue, there.copy.due], [day(-26), day(-12)]);
  assert.deepEqual(there.letters.map((one) => one.sentOn), [day(-9)], 'the letter is dated the day it went');
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

/**
 * The form leaves out a field the owner left empty, and the page read the
 * absent note as the word "undefined": saved, it went at the end of every
 * letter to a customer as "How to pay: undefined". And a days field left
 * empty became [NaN], which the server refused, so the note could not be
 * saved alone either.
 */
test('saving the days with no word on how to pay saves no word, and the days cannot be left empty', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('collect-console');
  await owing(fixture);
  const registry = new CapabilityRegistry();
  for (const capability of platformCapabilities({})) registry.register(capability);
  registerPlatformCapabilities(registry);
  await registry.sync();
  const api = await consoleWithSettings({ registry, staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 1280, height: 900 }).catch(async (error: unknown) => {
    await api.close();
    throw error;
  });
  const policy = async () => (await withControlPlane((tx) => tx.query<{ steps_days: number[]; payment_note: string | null }>(
    'SELECT steps_days, payment_note FROM collections_policy WHERE company_id = $1', [fixture.companyId]))).rows[0] ?? null;
  try {
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]')`, 'the console');
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/books'`);
    await page.waitFor(`[...document.querySelectorAll('button[role="tab"]')].some((one) => one.innerText.trim() === 'Invoices')`, 'the tabs');
    await page.evaluate(`[...document.querySelectorAll('button[role="tab"]')].find((one) => one.innerText.trim() === 'Invoices').click()`);
    const days = `[...document.querySelectorAll('label')].find((one) => one.innerText.startsWith('Days after the due date'))`;
    await page.waitFor(days, 'the reminders form');
    const input = `document.getElementById(${days}.htmlFor)`;
    await page.evaluate(`${input}.focus(); ${input}.select()`);
    await page.type('3, 10');
    await page.evaluate(`${input}.closest('form').querySelector('button[type="submit"]').click()`);
    const until = Date.now() + 15_000;
    while (Date.now() < until && JSON.stringify((await policy())?.steps_days) !== '[3,10]') await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await policy(), { steps_days: [3, 10], payment_note: null }, 'the days are saved, and no word on how to pay');

    // Emptied, the days are asked for rather than sent as something the server refuses.
    await page.evaluate(`${input}.focus(); ${input}.select()`);
    await page.type(' ');
    assert.equal(await page.evaluate(`${input}.required`), true, 'the days are a field the form will not send empty');
  } finally {
    await page.close();
    await api.close();
  }
});
