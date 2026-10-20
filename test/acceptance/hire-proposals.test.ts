/**
 * The CEO proposes a hire, and the owner is shown it (the audit of 10 October:
 * "a Hire: ticket is a prompt convention. No code reads or surfaces the
 * 'Hire:' prefix, so a CEO that sees a missing skill cannot hire, propose a
 * hire as a card, or turn the ticket into one").
 *
 * Adding a role is the owner's (F2.9), so the CEO cannot hire; what it can do
 * is say plainly which role is missing and for what work, and see that the
 * owner hears it. A ticket of kind `hire` is that: one card to the owner, in
 * their language, the moment it is filed and once; never triaged as work the
 * CEO hands on to nobody; and on the board as a proposal the owner turns into a
 * role with the CEO in one conversation.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { ensureTriage } from '../../src/engine/triage.ts';
import { FOUNDING_TEMPLATE } from '../../src/templates/founding.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function ceoAt(fixture: Fixture) {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'ticket.create');
  const broker = new CapabilityBroker(registry);
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Decide what the company does next' },
    createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  let key = 0;
  return (input: Record<string, unknown>) => broker.invoke<unknown, { ticketId: string; existing: boolean }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: task.id, idempotencyKey: `hire-${key += 1}`,
  }, 'ticket.create', input).then((answer) => answer.output);
}

const cards = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{ title: string; rationale: string; payload: { ticketId?: string; hire?: boolean } }>(
  "SELECT title, rationale, payload FROM inbox_items WHERE kind = 'escalation' ORDER BY created_at")).then((result) => result.rows);

test('a hire the CEO proposes is a card for the owner, in their language, once', async () => {
  const fixture = await createCompany('hire-card');
  // The owner reads the console in Indonesian: the card is written so.
  await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id'"));
  const file = await ceoAt(fixture);
  const proposed = await file({
    title: 'Bookkeeper', kind: 'hire',
    body: 'Keeps the books and sends the invoices; I spend every review recording entries that a bookkeeper would own.',
  });
  assert.equal(proposed.existing, false);
  const [card] = await cards(fixture);
  assert.deepEqual(card!.payload, {
    ticketId: proposed.ticketId, hire: true, role: 'Bookkeeper',
    why: 'Keeps the books and sends the invoices; I spend every review recording entries that a bookkeeper would own.',
  });
  assert.equal(card!.title, 'CEO Anda mengusulkan merekrut: Bookkeeper');
  assert.match(card!.rationale, /Keeps the books and sends the invoices/);

  // Proposed again while it is open: the same ticket, and no second card.
  const again = await file({ title: 'bookkeeper', kind: 'hire', body: 'Still needed.' });
  assert.deepEqual([again.ticketId, again.existing], [proposed.ticketId, true]);
  assert.equal((await cards(fixture)).length, 1);

  // An ordinary ticket raises no card: it is work the CEO hands on.
  await file({ title: 'Fix the price list typo' });
  assert.equal((await cards(fixture)).length, 1);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ title: string; kind: string }>('SELECT title, kind FROM tickets ORDER BY created_at'));
  assert.deepEqual(rows.map((row) => [row.title, row.kind]), [['Bookkeeper', 'hire'], ['Fix the price list typo', 'work']]);
});

test('a hire is the owner\'s, so it is never triaged as work the CEO hands on', async () => {
  const fixture = await createCompany('hire-not-triaged');
  const file = await ceoAt(fixture);
  await file({ title: 'Customer support', kind: 'hire', body: 'Answers customers on WhatsApp.' });
  assert.equal(await ensureTriage(fixture.companyId), null, 'only a hire is open: nothing for triage');
  await file({ title: 'Reply to the café about their order' });
  const triage = await ensureTriage(fixture.companyId);
  assert.ok(triage);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ input: { ticketIds: string[] } }>('SELECT input FROM tasks WHERE id = $1', [triage]));
  assert.equal(rows[0]!.input.ticketIds.length, 1, 'the work, and not the hire');
});

test('the board says which tickets are hires, and the CEO is told to file one so', async () => {
  const fixture = await createCompany('hire-board');
  const file = await ceoAt(fixture);
  await file({ title: 'Marketer', kind: 'hire', body: 'Writes the posts.' });
  const api = await consoleWithSettings({});
  try {
    const owner = await api.signIn();
    const listed = await api.call('GET', `/api/companies/${fixture.companyId}/tickets`, owner);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const tickets = (listed.body as { tickets: Array<{ id: string; title: string; kind: string }> }).tickets;
    assert.deepEqual(tickets.map((one) => [one.title, one.kind]), [['Marketer', 'hire']]);
    // And the inbox card carries what the console needs to hire it with the CEO.
    const inbox = await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, owner);
    const items = (inbox.body as { items: Array<{ hire?: { ticketId: string; role: string; why: string } }> }).items;
    assert.deepEqual(items.map((one) => one.hire), [{ ticketId: tickets[0]!.id, role: 'Marketer', why: 'Writes the posts.' }]);
  } finally {
    await api.close();
  }
  const ceo = FOUNDING_TEMPLATE.roles.find((role) => role.title === 'CEO')!;
  assert.match(ceo.systemPrompt, /kind "hire"/);
  assert.doesNotMatch(ceo.systemPrompt, /begins "Hire:"/);
});

test('a hire closed on the board takes its card with it', async () => {
  const fixture = await createCompany('hire-closed');
  const file = await ceoAt(fixture);
  const { ticketId } = await file({ title: 'Designer', kind: 'hire', body: 'Draws the packaging.' });
  const api = await consoleWithSettings({});
  try {
    const owner = await api.signIn();
    const closed = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${ticketId}`, owner, { status: 'closed', reason: 'Not now' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
  } finally {
    await api.close();
  }
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    "SELECT status, closed_reason FROM inbox_items WHERE kind = 'escalation'"));
  assert.deepEqual(rows, [{ status: 'withdrawn', closed_reason: 'ticket_closed' }]);
});
