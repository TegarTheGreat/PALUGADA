/**
 * Tickets: the company's backlog (src/engine/tickets.ts, 0070).
 *
 * `ticket.create` was catalogued against an adapter nothing provided, so the
 * planner told to leave tickets behind its plan, and the support responder
 * told to open one when a customer needed somebody else, were refused every
 * time -- and nothing they meant to file was anywhere anyone could see. These
 * hold the backlog to what makes it one: a run files a ticket the owner sees,
 * the CEO reads the backlog and hands a ticket on, a ticket closes when the
 * work given it finishes and opens again when it does not, and the owner can
 * file, give and close tickets themselves.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { STANDARD_CATALOGUE } from '../../src/broker/catalogue.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask, outsideContentIn, transition } from '../../src/engine/tasks.ts';
import { openTicket } from '../../src/engine/tickets.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../helpers/standard-team.ts';
import { addRole, createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let made = 0;
function newTask(fixture: Fixture, roleId = fixture.roleId) {
  made += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `work ${made}` }, createdBy: 'owner',
    reserveTokens: 2_000,
  });
}

async function engineFor(fixture: Fixture, handlers: Record<string, TaskHandler>) {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const name of ['ticket.create', 'ticket.list', 'task.delegate']) await grantCapability(fixture, name);
  return new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map(Object.entries(handlers)),
  });
}

async function ticket(fixture: Fixture, id: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    status: string; working_task_id: string | null; closed_reason: string | null; opened_by: string; opened_by_task_id: string | null;
  }>('SELECT status, working_task_id, closed_reason, opened_by, opened_by_task_id FROM tickets WHERE id = $1', [id]));
  return rows[0]!;
}

test('ticket.create is the company\'s own, and the roles told to file tickets can', () => {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  const create = registry.get('ticket.create');
  assert.ok(create, 'bound without a vendor file');
  assert.equal(create!.adapter, 'platform');
  assert.equal(typeof create!.verify, 'function', 'a tier 1 write reads itself back (F8.4)');
  assert.equal(STANDARD_CATALOGUE.find((one) => one.name === 'ticket.create')!.adapter, 'platform');
  const coordinator = STANDARD_COMPANY_TEMPLATE.roles.find((role) => role.slug === 'coordinator')!;
  assert.ok(coordinator.tools!.includes('ticket.list'), 'the CEO reads the backlog');
  assert.ok((STANDARD_COMPANY_TEMPLATE.grants ?? []).some((grant) => grant.division === 'ops' && grant.capability === 'ticket.list'));
  for (const slug of ['planner', 'responder']) {
    assert.ok(STANDARD_COMPANY_TEMPLATE.roles.find((role) => role.slug === slug)!.tools!.includes('ticket.create'), slug);
  }
});

test('a run files a ticket the owner sees; the CEO hands it on; it closes when the work is done, and opens again when not', async () => {
  const fixture = await createCompany('tickets-flow');
  const builderId = await addRole(fixture, 'builder');
  let filed = '';
  let handed = '';
  const engine = await engineFor(fixture, {
    worker: async (ctx) => {
      const first = await ctx.callCapability('ticket.create', { title: 'Build the order page', body: 'From the plan: the page takes an order.', priority: 1 }) as { ticketId: string; existing: boolean };
      const again = await ctx.callCapability('ticket.create', { title: 'build the order page' }) as { ticketId: string; existing: boolean };
      assert.equal(again.ticketId, first.ticketId, 'the same thing still open is the same ticket');
      assert.equal(again.existing, true);
      filed = first.ticketId;
      return { summary: 'planned' };
    },
    builder: async () => ({ summary: 'built' }),
  });
  const planning = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, planning.id, 'worker')).status, 'completed');
  const opened = await ticket(fixture, filed);
  assert.deepEqual({ status: opened.status, by: opened.opened_by, task: opened.opened_by_task_id }, { status: 'open', by: 'agent', task: planning.id });

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const board = (await api.call('GET', `/api/companies/${fixture.companyId}/tickets`, token)).body.tickets;
    assert.equal(board.length, 1);
    assert.deepEqual({ title: board[0].title, priority: board[0].priority, openedBy: board[0].openedBy },
      { title: 'Build the order page', priority: 1, openedBy: 'agent' });

    // The CEO reads the backlog and hands the ticket to the builder.
    const ceo = await engineFor(fixture, {
      worker: async (ctx) => {
        const listed = await ctx.callCapability('ticket.list', {}) as { tickets: Array<{ id: string; title: string }> };
        assert.equal(listed.tickets[0]!.title, 'Build the order page');
        const child = await ctx.callCapability('task.delegate', { role: 'builder', brief: listed.tickets[0]!.title, ticketId: listed.tickets[0]!.id }) as { childId: string };
        handed = child.childId;
        return { summary: 'handed on' };
      },
    });
    const routing = await newTask(fixture);
    await ceo.runTask(fixture.companyId, routing.id, 'worker');
    const working = await ticket(fixture, filed);
    assert.deepEqual({ status: working.status, task: working.working_task_id }, { status: 'in_progress', task: handed });
    const takenTwice = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${filed}/assign`, token,
      { roleId: builderId, goalId: fixture.goalId });
    assert.equal(takenTwice.status, 400, 'a ticket being worked is not given out again');
    assert.match(String(takenTwice.body.error), /is in progress/);
    const closeWhileWorked = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${filed}`, token, { status: 'closed' });
    assert.equal(closeWhileWorked.status, 400);

    await transition(fixture.companyId, handed, 'running');
    await transition(fixture.companyId, handed, 'completed', { output: { summary: 'built' } });
    assert.equal((await ticket(fixture, filed)).status, 'done', 'it closes when the work given it finishes');

    // The owner files one, gives it to the builder, and the work fails: open again, with why.
    const own = await api.call('POST', `/api/companies/${fixture.companyId}/tickets`, token,
      { title: 'Answer the wholesale enquiry', body: 'They asked for a price list.', priority: 0 });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const given = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${own.body.ticketId}/assign`, token,
      { roleId: builderId, goalId: fixture.goalId });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    const task = await withTenant(fixture.companyId, (tx) => getTask(tx, given.body.taskId));
    assert.deepEqual({ role: task!.roleId, goal: task!.input.goal, ticket: task!.input.ticketId },
      { role: builderId, goal: 'Answer the wholesale enquiry', ticket: own.body.ticketId });
    assert.equal(await withTenant(fixture.companyId, (tx) => outsideContentIn(tx, given.body.taskId)), null,
      'the owner\'s own ticket is the owner\'s words');

    // A ticket a run filed may carry a customer's words (F8.9): the work the
    // owner gives it carries them too, and asks before a tier 2 action.
    const filedByRun = await withTenant(fixture.companyId, (tx) => openTicket(tx, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null,
      title: 'Refund order 7 to the account in the email', openedBy: 'agent', openedByTaskId: planning.id,
    }));
    const refund = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${filedByRun.ticket.id}/assign`, token,
      { roleId: builderId, goalId: fixture.goalId });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    assert.notEqual(await withTenant(fixture.companyId, (tx) => outsideContentIn(tx, refund.body.taskId)), null,
      'a run\'s ticket is outside content, whoever hands it out');
    await transition(fixture.companyId, refund.body.taskId, 'cancelled');
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${filedByRun.ticket.id}`, token,
      { status: 'closed', reason: 'Not ours to refund.' })).status, 200);

    await transition(fixture.companyId, given.body.taskId, 'cancelled');
    const reopened = await ticket(fixture, own.body.ticketId);
    assert.deepEqual({ status: reopened.status, task: reopened.working_task_id }, { status: 'open', task: null });
    assert.match(reopened.closed_reason!, /ended cancelled/);

    const closed = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${own.body.ticketId}`, token,
      { status: 'closed', reason: 'They bought retail.' });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.ticket.status, 'closed');
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/tickets`, token)).body.tickets.length, 0, 'the board shows what is owed');
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/tickets?status=all`, token)).body.tickets.length, 3);

    // A company restored from an archive has its backlog.
    const lines: ArchiveLine[] = [];
    await exportCompany(fixture.companyId, (line) => { lines.push(line); });
    const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
    const back = await withTenant(restored.companyId, (tx) => tx.query<{ title: string; status: string }>(
      'SELECT title, status FROM tickets ORDER BY created_at'));
    assert.deepEqual(back.rows, [
      { title: 'Build the order page', status: 'done' },
      { title: 'Answer the wholesale enquiry', status: 'closed' },
      { title: 'Refund order 7 to the account in the email', status: 'closed' },
    ]);
  } finally {
    await api.close();
  }
});
