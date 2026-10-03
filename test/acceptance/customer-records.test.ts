/**
 * The company's own customer records (STATUS 2.138; the owner's decision of
 * 3 October: "support first, then the business records").
 *
 * `crm.read` and `crm.note` were catalogued from the start and bound to
 * nothing: the responder and the marketer were told to keep the customer
 * record and had none, so what a customer was told lived in a run's output
 * and was gone with it. Now the platform keeps one, and gives way to a CRM
 * the owner connects:
 *
 *   - a customer who writes on a channel is a contact, found again by their
 *     address or their number when the owner already keeps them;
 *   - a run reads what the company knows of the customer it is answering,
 *     notes what it told them, and records their details and a deal;
 *   - the owner keeps the same records on Customers.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { transition } from '../../src/engine/tasks.ts';
import { channelAt, openChannel, receiveMessage, type ChatKind, type InboundMessage } from '../../src/chats/chats.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../../src/templates/standard.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const refused = (code: string, said?: RegExp) => (error: unknown) =>
  isPalugadaError(error, code as never) && (!said || said.test((error as Error).message));

let sealed = 0;
/** A channel as connecting one leaves it, without a transport to reach. */
async function channel(fixture: Fixture, kind: ChatKind, account: string) {
  sealed += 1;
  const ref = `db://chat-${sealed.toString(16).padStart(16, '0')}`;
  const opened = await openChannel(fixture.companyId, {
    kind, account, roleId: fixture.roleId, goalId: fixture.goalId, divisionId: fixture.divisionId, projectId: fixture.projectId,
    instruction: 'Jawab pertanyaan pelanggan Kafe Senja.', maxPerHour: 60, tokenRef: ref,
    webhookHash: kind === 'email' ? '' : 'a'.repeat(64),
    ...(kind === 'whatsapp' ? { accountId: '1234567890', secretRef: ref } : {}),
    ...(kind === 'email' ? { mail: { imapHost: 'imap.kafesenja.example', imapPort: 993, smtpHost: 'smtp.kafesenja.example', smtpPort: 587, username: account } } : {}),
  });
  // A mailbox has no address to post to: it is read, and its channel is
  // built as the reading builds it.
  if (kind === 'email') {
    return {
      id: opened.id, companyId: fixture.companyId, kind, account, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, goalId: fixture.goalId, instruction: 'Jawab pertanyaan pelanggan Kafe Senja.', maxPerHour: 60,
      webhookHash: '', accountId: null, secretRef: null, answersAlone: false,
    };
  }
  return (await channelAt(opened.publicId))!;
}

let said = 100;
function from(customer: string, name: string | null, handle: string | null, text: string): InboundMessage {
  said += 1;
  return { chat: customer, id: String(said), customerName: name, customerHandle: handle, text, attachment: null };
}

const contactOfChat = async (fixture: Fixture, chatId: string) => (await withTenant(fixture.companyId, (tx) => tx.query<{ contact_id: string | null }>(
  'SELECT contact_id FROM chats WHERE id = $1', [chatId]))).rows[0]?.contact_id ?? null;

const contacts = (fixture: Fixture) => withTenant(fixture.companyId, async (tx) => (await tx.query<{
  id: string; name: string; email: string | null; phone: string | null; created_by: string;
}>('SELECT id, name, email, phone, created_by FROM contacts ORDER BY created_at')).rows);

test('a customer who writes becomes a contact, and writing again finds the same one', async () => {
  const fixture = await createCompany('records-chat');
  const bot = await channel(fixture, 'telegram', 'kafesenja_bot');
  const first = await receiveMessage(bot, from('4242', 'Sari Wulandari', 'sari_w', 'Halo, masih buka?'));
  const contactId = await contactOfChat(fixture, first.chatId);
  assert.ok(contactId, 'the conversation has its customer');
  assert.deepEqual((await contacts(fixture)).map((one) => [one.name, one.created_by]), [['Sari Wulandari', 'chat']]);

  // The run is told whose conversation it is.
  const { rows: [task] } = await withTenant(fixture.companyId, (tx) => tx.query<{ input: { chat: { contact?: string } } }>(
    'SELECT input FROM tasks WHERE id = $1', [first.taskId]));
  assert.equal(task!.input.chat.contact, contactId);

  await transition(fixture.companyId, first.taskId!, 'running');
  const again = await receiveMessage(bot, from('4242', 'Sari W.', 'sari_w', 'Saya mau pesan.'));
  assert.equal(again.chatId, first.chatId);
  assert.equal(await contactOfChat(fixture, again.chatId), contactId);
  const kept = await contacts(fixture);
  assert.equal(kept.length, 1, 'one customer, one contact');
  assert.equal(kept[0]!.name, 'Sari Wulandari', 'a name the customer changes later does not rename the record');

  // Another customer, another contact; one with no name is named by their handle.
  const other = await receiveMessage(bot, from('5151', null, 'anon_77', 'Menu?'));
  assert.notEqual(await contactOfChat(fixture, other.chatId), contactId);
  assert.ok((await contacts(fixture)).some((one) => one.name === 'anon_77'));
});

test('a mail or a WhatsApp message finds the contact the owner already keeps', async () => {
  const fixture = await createCompany('records-match');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const made = await api.call('POST', `/api/companies/${fixture.companyId}/contacts`, owner, {
      name: 'Budi Santoso', organisation: 'Kafe Budi', email: 'Budi@KafeBudi.example', phone: '0812-3456-7890',
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const budi = String(made.body.contactId);

    const mailbox = await channel(fixture, 'email', 'halo@kafesenja.example');
    const mailed = await receiveMessage(mailbox, { ...from('<budi-1@kafebudi.example>', 'Budi', 'budi@kafebudi.example', 'Minta daftar harga grosir.'), subject: 'Harga grosir' });
    assert.equal(await contactOfChat(fixture, mailed.chatId), budi, 'found by the address, whatever its case');

    const number = await channel(fixture, 'whatsapp', '628111222333');
    const written = await receiveMessage(number, from('6281234567890', 'Budi', '6281234567890', 'Pak, sudah terima emailnya?'));
    assert.equal(await contactOfChat(fixture, written.chatId), budi, 'found by the number, with the country code or without');

    // A number that only ends the same, past any country code, is someone else.
    const far = await receiveMessage(number, from('99996281234567890', 'Orang lain', '99996281234567890', 'Halo'));
    assert.notEqual(await contactOfChat(fixture, far.chatId), budi);

    const stranger = await receiveMessage(number, from('6289999999999', 'Rina', '6289999999999', 'Halo'));
    const rina = await contactOfChat(fixture, stranger.chatId);
    assert.ok(rina && rina !== budi);
    const kept = (await contacts(fixture)).find((one) => one.id === rina)!;
    assert.deepEqual([kept.name, kept.phone, kept.created_by], ['Rina', '+6289999999999', 'chat']);

    // The owner sees both of Budi's conversations on his record.
    const detail = await api.call('GET', `/api/companies/${fixture.companyId}/contacts/${budi}`, owner);
    assert.deepEqual(detail.body.chats.map((one: { kind: string }) => one.kind).sort(), ['email', 'whatsapp']);
  } finally {
    await api.close();
  }
});

async function working(name: string) {
  const fixture = await createCompany(name);
  const registry = new CapabilityRegistry();
  for (const capability of platformCapabilities({})) registry.register(capability);
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const capability of ['crm.read', 'crm.note', 'crm.record']) await grantCapability(fixture, capability);
  const bot = await channel(fixture, 'telegram', 'kafesenja_bot');
  const received = await receiveMessage(bot, from('7070', 'Budi Santoso', 'budi_s', 'Berapa harga kopi 20 kg per bulan?'));
  await transition(fixture.companyId, received.taskId!, 'running');
  await planTask(fixture.companyId, received.taskId!, [{ capability: 'crm.record' }, { capability: 'crm.note' }]);
  const broker = new CapabilityBroker(registry);
  let key = 0;
  const call = <O>(capability: string, input: Record<string, unknown>) => broker.invoke<unknown, O>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: received.taskId!, idempotencyKey: `crm-${key += 1}`,
  }, capability, input).then((answer) => answer.output);
  const contactId = (await contactOfChat(fixture, received.chatId))!;
  return { fixture, received, call, contactId };
}

interface ReadContact {
  id: string; name: string; organisation: string | null; email: string | null; phone: string | null;
  notes: Array<{ body: string; by: string }>;
  deals: Array<{ id: string; title: string; stage: string; value: { amountCents: number; currency: string } | null; expectedOn: string | null }>;
  conversations: Array<{ chatId: string; channel: string }>;
}

test('a run reads what the company knows of the customer, notes what it told them, and records a deal', async () => {
  const { fixture, received, call, contactId } = await working('records-run');

  const read = await call<{ contacts: ReadContact[] }>('crm.read', {});
  assert.equal(read.contacts.length, 1, 'with nothing asked, the customer this work answers');
  assert.equal(read.contacts[0]!.id, contactId);
  assert.deepEqual(read.contacts[0]!.conversations.map((one) => [one.chatId, one.channel]), [[received.chatId, 'telegram']]);
  const { rows: marked } = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM events WHERE task_id = $1 AND type = 'content.read_outside'", [received.taskId]));
  assert.ok(marked.length > 0, 'what customers said is outside content (F8.9)');

  const recorded = await call<{ contactId: string; dealId: string }>('crm.record', {
    organisation: 'Kafe Budi', email: 'budi@kafebudi.example',
    deal: { title: 'Kopi 20 kg per bulan', stage: 'qualified', value: { amountCents: 190_000_000, currency: 'IDR' }, expectedOn: '2026-11-01' },
  });
  assert.equal(recorded.contactId, contactId, 'the customer this work answers, unless another is named');
  await call('crm.note', { body: 'Bertanya harga grosir 20 kg; dikirimi daftar harga.' });
  await call('crm.record', { deal: { id: recorded.dealId, stage: 'won' } });

  const [after] = (await call<{ contacts: ReadContact[] }>('crm.read', { contact: contactId })).contacts;
  assert.deepEqual([after!.organisation, after!.email], ['Kafe Budi', 'budi@kafebudi.example']);
  assert.deepEqual(after!.notes.map((note) => [note.body, note.by]), [['Bertanya harga grosir 20 kg; dikirimi daftar harga.', 'agent']]);
  assert.deepEqual(after!.deals.map((deal) => [deal.title, deal.stage, deal.value, deal.expectedOn]),
    [['Kopi 20 kg per bulan', 'won', { amountCents: 190_000_000, currency: 'IDR' }, '2026-11-01']]);
  const { rows: [closed] } = await withTenant(fixture.companyId, (tx) => tx.query<{ closed_at: Date | null }>(
    'SELECT closed_at FROM deals WHERE id = $1', [recorded.dealId]));
  assert.ok(closed!.closed_at, 'won is closed');

  // Found by what the run knows of them, and not by what it does not.
  assert.deepEqual((await call<{ contacts: ReadContact[] }>('crm.read', { query: 'kafe budi' })).contacts.map((one) => one.id), [contactId]);
  assert.deepEqual((await call<{ contacts: ReadContact[] }>('crm.read', { query: 'Toko Lain' })).contacts, []);

  // A run may keep someone it found, by name.
  const lead = await call<{ contactId: string }>('crm.record', { contact: 'new', name: 'Toko Roti Melati', phone: '+62 21 555 0101' });
  assert.notEqual(lead.contactId, contactId);

  // Refused for what is not a record.
  await assert.rejects(call('crm.record', { email: 'bukan-email' }), refused('contract.violation', /an email address/));
  await assert.rejects(call('crm.record', { phone: 'tanya saja' }), refused('contract.violation', /a phone number/));
  await assert.rejects(call('crm.record', { deal: { title: 'X', value: { amountCents: 100 } } }), refused('contract.violation'));
  await assert.rejects(call('crm.record', { deal: { title: 'X', stage: 'maybe' } }), refused('contract.violation'));
  await assert.rejects(call('crm.record', { contact: 'new' }), refused('contract.violation', /a new contact needs a name/));
  await assert.rejects(call('crm.note', { contact: '00000000-0000-4000-8000-000000000000', body: 'x' }),
    refused('contract.violation', /no contact 00000000-0000-4000-8000-000000000000 in this company/));
  const another = await createCompany('records-other');
  const theirs = (await withControlPlane((tx) => tx.query<{ id: string }>(
    "INSERT INTO contacts (company_id, name, created_by) VALUES ($1, 'Rahasia', 'owner') RETURNING id", [another.companyId]))).rows[0]!.id;
  await assert.rejects(call('crm.note', { contact: theirs, body: 'x' }), refused('contract.violation', /no contact/), 'another company\'s contact is not found');
});

test('the owner keeps the records on Customers, and they travel with the company', async () => {
  const fixture = await createCompany('records-owner');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const base = `/api/companies/${fixture.companyId}/contacts`;
    assert.equal((await api.call('POST', base, owner, { name: '  ' })).status, 400);
    assert.equal((await api.call('POST', base, owner, { name: 'Ayu', email: 'ayu@' })).status, 400);
    const ayu = String((await api.call('POST', base, owner, { name: 'Ayu Lestari', organisation: 'Hotel Melati' })).body.contactId);
    const dewi = String((await api.call('POST', base, owner, { name: 'Dewi', phone: '+62 811 000 111' })).body.contactId);

    assert.equal((await api.call('POST', `${base}/${ayu}`, owner, { email: 'ayu@hotelmelati.example' })).status, 200);
    const noted = await api.call('POST', `${base}/${ayu}/notes`, owner, { body: 'Prefers invoices at month end.' });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    const deal = await api.call('POST', `${base}/${ayu}/deals`, owner, { title: 'Kopi untuk 40 kamar', stage: 'proposal', value: { amountCents: 75_000_000, currency: 'IDR' } });
    assert.equal(deal.status, 200, JSON.stringify(deal.body));
    assert.equal((await api.call('POST', `${base}/${ayu}/deals`, owner, { id: deal.body.dealId, stage: 'lost' })).status, 200);

    const listed = await api.call('GET', `${base}?q=melati`, owner);
    assert.deepEqual(listed.body.contacts.map((one: { name: string; openDeals: number }) => [one.name, one.openDeals]), [['Ayu Lestari', 0]]);
    const detail = (await api.call('GET', `${base}/${ayu}`, owner)).body;
    assert.equal(detail.contact.email, 'ayu@hotelmelati.example');
    assert.deepEqual(detail.notes.map((note: { body: string; by: string }) => [note.body, note.by]), [['Prefers invoices at month end.', 'owner']]);
    assert.deepEqual(detail.deals.map((one: { stage: string }) => one.stage), ['lost']);

    // Archived, a contact leaves the list and what runs find, and comes back.
    assert.equal((await api.call('POST', `${base}/${dewi}`, owner, { archived: true })).status, 200);
    const all = (await api.call('GET', base, owner)).body.contacts;
    assert.deepEqual(all.map((one: { name: string; archivedAt: string | null }) => [one.name, one.archivedAt !== null]),
      [['Ayu Lestari', false], ['Dewi', true]]);

    // A note is kept as written: the application role adds and never rewrites.
    await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query("UPDATE contact_notes SET body = 'changed'")), /permission denied/);

    const lines: ArchiveLine[] = [];
    await exportCompany(fixture.companyId, (line) => { lines.push(line); });
    const restored = await importCompany(lines, { slug: 'records-restored' });
    const copy = (await api.call('GET', `/api/companies/${restored.companyId}/contacts`, owner)).body.contacts;
    assert.deepEqual(copy.map((one: { name: string }) => one.name), ['Ayu Lestari', 'Dewi']);
    const copied = (await api.call('GET', `/api/companies/${restored.companyId}/contacts/${copy[0].id}`, owner)).body;
    assert.deepEqual([copied.notes.length, copied.deals[0].title], [1, 'Kopi untuk 40 kamar']);
  } finally {
    await api.close();
  }
});

test('the platform keeps the records until a CRM is connected, and the responder holds them', () => {
  const built = platformCapabilities({});
  for (const name of ['crm.read', 'crm.note', 'crm.record']) {
    const capability = built.find((one) => one.name === name);
    assert.ok(capability, `${name} is bound by the platform`);
    assert.equal(capability.fallback, true, `${name} gives way to a CRM the owner connects`);
  }
  assert.deepEqual([declarationFor('crm.record')?.tier, declarationFor('crm.note')?.tier, declarationFor('crm.read')?.tier], [1, 1, 0]);
  const responder = STANDARD_COMPANY_TEMPLATE.roles.find((role) => role.slug === 'responder')!;
  assert.ok(responder.tools?.includes('crm.record'));
  assert.ok((responder.tools ?? []).length <= 12);
  const grants = (STANDARD_COMPANY_TEMPLATE.grants ?? []).filter((one) => one.capability === 'crm.record').map((one) => one.division);
  assert.deepEqual(grants.sort(), ['growth', 'support']);
});
