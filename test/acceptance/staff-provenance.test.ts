/**
 * The mark that staff words are in the work follows the work (F19.9; STATUS
 * section 2.204).
 *
 * A member of staff's words held at tier 2 in the task they steered are no
 * help if the same words, filed as a to-do or run again, become work the
 * owner's standing approvals cover and the same seat can decide. Every place
 * that carries content from outside into derived work (F8.9) carries staff
 * words too: running work again, a follow-up, a handed escalation, a ticket a
 * run files and the work it becomes, triage, the weekly meeting, the quarter,
 * the week and the month. Sub-tasks need nothing: they are on the chain.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { buildContext } from '../../src/context/builder.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { Engine } from '../../src/engine/engine.ts';
import { ensureWeeklyMeeting } from '../../src/engine/meeting.ts';
import { cancelTask, instructTask, rerunTask } from '../../src/engine/owner-control.ts';
import { ensureQuarterlyPlanning } from '../../src/engine/quarter.ts';
import {
  createRootTask, createRootTaskWithin, createSubTask, staffWordsIn, transition,
} from '../../src/engine/tasks.ts';
import { openTicket } from '../../src/engine/tickets.ts';
import { ensureTriage, handTodos } from '../../src/engine/triage.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { setEscalationPolicy } from '../../src/governance/structure.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { AdapterRegistry, type Adapter, type ExecutionBackend } from '../../src/runtime/protocol.ts';
import { issueInvoice } from '../../src/records/invoices.ts';
import { runScheduleNow, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import type { StaffKind } from '../../src/owner/staff.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { addRole, createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function seat(fixture: Fixture, name: string, kind: StaffKind): Promise<inbox.SeatActor> {
  const id = await withControlPlane(async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO staff_seats (company_id, name, kind, secret_ref, joined_at)
     VALUES ($1, $2, $3, 'db://staff-totp-test', now()) RETURNING id`, [fixture.companyId, name, kind])).rows[0]!.id);
  return { id, name, kind };
}

const as = (one: inbox.SeatActor) => ({ kind: 'seat' as const, seatId: one.id, name: one.name });

async function ownWork(fixture: Fixture, goal: string): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

/** Work a seat asked for, as a room's assignment door makes it (STATUS 2.206). */
async function askedBy(fixture: Fixture, who: inbox.SeatActor, goal: string): Promise<string> {
  const task = await withTenant(fixture.companyId, async (tx) => {
    const made = await createRootTaskWithin(tx, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal }, createdBy: 'staff', requestedBySeat: who.id, reserveTokens: 1_000,
    });
    await appendEvent(tx, {
      companyId: fixture.companyId, projectId: fixture.projectId, taskId: made.id, type: 'content.staff_said', actor: 'staff',
      payload: { seatId: who.id, name: who.name, how: 'began' },
    });
    return made;
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

const words = (fixture: Fixture, taskId: string) => withTenant(fixture.companyId, (tx) => staffWordsIn(tx, taskId));
const bySeat = (list: Array<{ seatId: string | null; name: string }>) =>
  [...list].sort((a, b) => a.name.localeCompare(b.name));

/** The mark written on a task made from staff-touched work, with where it came from. */
const carried = (fixture: Fixture, taskId: string) => withTenant(fixture.companyId, (tx) => tx.query<{
  payload: { seatId: string | null; name: string; how: string; from?: string };
}>("SELECT payload FROM events WHERE task_id = $1 AND type = 'content.staff_said' ORDER BY occurred_at, id", [taskId]))
  .then((result) => result.rows.map((row) => row.payload));

/** A broker that sends mail at tier 2, granted to the fixture's division. */
async function mail(fixture: Fixture) {
  const sent: string[] = [];
  const capability: Capability<{ to: string }, { ok: true }> = {
    name: 'email.send', adapter: 'test:provenance', defaultTier: 2,
    async execute(input) { sent.push(input.to); return { ok: true }; },
    async verify() { return true; },
  };
  const registry = new CapabilityRegistry();
  registry.register(capability as Capability<unknown, unknown>);
  await registry.sync();
  await grantCapability(fixture, 'email.send');
  const broker = new CapabilityBroker(registry);
  let n = 0;
  const planned = new Set<string>();
  const send = async (taskId: string) => {
    n += 1;
    if (!planned.has(taskId)) await planTask(fixture.companyId, taskId, [{ capability: 'email.send' }]);
    planned.add(taskId);
    return broker.invoke({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      taskId, roleId: fixture.roleId, idempotencyKey: `provenance-${taskId}-${n}`,
    }, 'email.send', { to: 'customer@example.test' });
  };
  return { send, sent };
}

const asks = (error: unknown) => isPalugadaError(error, 'approval.required');

async function cardOf(fixture: Fixture, taskId: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    id: string; instigators: string[]; rationale: string; payload: { reason?: string; staff?: string[] };
  }>("SELECT id, instigators, rationale, payload FROM inbox_items WHERE task_id = $1 AND kind = 'approval' AND status = 'open'", [taskId]));
  assert.ok(rows[0], 'the action raised a card');
  return rows[0];
}

/** A ticket the CEO's run files, as `ticket.open` files it. */
const filedBy = (fixture: Fixture, taskId: string, title: string, extra: { assigneeRoleId?: string | null; kind?: 'work' | 'issue'; horizon?: 'now' | 'long_term' } = {}) =>
  withTenant(fixture.companyId, (tx) => openTicket(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title,
    openedBy: 'agent', openedByTaskId: taskId, outside: false, ...extra,
  })).then((opened) => opened.ticket);

const instigatorsOf = (fixture: Fixture, ticketId: string) => withTenant(fixture.companyId, (tx) =>
  tx.query<{ instigators: string[] }>('SELECT instigators FROM tickets WHERE id = $1', [ticketId])).then((result) => [...result.rows[0]!.instigators].sort());

test('staff words, then the CEO files a to-do, then triage assigns it: its tier 2 action still asks, naming the seat, and the seat cannot decide it', async () => {
  // PRD F19.9's continuation: a member's words reach the CEO's work through a
  // question they answer; the CEO files a to-do; it is given out as new work.
  const fixture = await createCompany('provenance-todo');
  const budi = await seat(fixture, 'Budi', 'member');
  const sari = await seat(fixture, 'Sari', 'approver');
  await seat(fixture, 'Rina', 'approver');
  const { send, sent } = await mail(fixture);

  const ceo = await ownWork(fixture, 'Plan the price change');
  const toBudi = await inbox.askOwner({
    companyId: fixture.companyId, taskId: ceo, question: 'Which customers should hear first?',
    addressee: { seatId: budi.id, name: 'Budi', escalateAfterHours: 24 },
  });
  await inbox.answerEscalation(fixture.companyId, toBudi.inboxItemId, 'Kopi Kita, then the rest.', { seat: budi });
  const toAnyone = await inbox.askOwner({ companyId: fixture.companyId, taskId: ceo, question: 'By email or by phone?' });
  await inbox.answerEscalation(fixture.companyId, toAnyone.inboxItemId, 'By email.', { seat: sari });

  const todo = await filedBy(fixture, ceo, 'Email Kopi Kita the new prices', { assigneeRoleId: fixture.roleId });
  assert.deepEqual(await instigatorsOf(fixture, todo.id), [budi.id, sari.id].sort(), 'the to-do carries whose words are in it');
  // A to-do with no seat goes through the CEO's triage, which carries the mark too.
  const unseated = await filedBy(fixture, ceo, 'Phone the rest of the customers');
  const triage = await ensureTriage(fixture.companyId);
  assert.ok(triage);
  assert.deepEqual((await carried(fixture, triage)).map((one) => `${one.seatId}:${one.name}:${one.how}:${one.from}`).sort(),
    [`${budi.id}:Budi:quoted:ticket`, `${sari.id}:Sari:quoted:ticket`].sort());
  assert.ok(unseated);

  assert.equal(await handTodos(fixture.companyId), 1);
  const { rows: [given] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    'SELECT id FROM tasks WHERE idempotency_key = $1', [`todo:${todo.id}`]));
  assert.ok(given);
  assert.deepEqual(bySeat(await words(fixture, given.id)), [{ seatId: budi.id, name: 'Budi' }, { seatId: sari.id, name: 'Sari' }]);
  assert.ok((await carried(fixture, given.id)).every((one) => one.how === 'quoted' && one.from === 'ticket'));

  await transition(fixture.companyId, given.id, 'running');
  await assert.rejects(send(given.id), asks);
  assert.deepEqual(sent, []);
  const card = await cardOf(fixture, given.id);
  assert.equal(card.payload.reason, 'staff');
  assert.match(card.rationale, /Budi/);
  assert.deepEqual([...card.instigators].sort(), [budi.id, sari.id].sort());
  await assert.rejects(inbox.decide(fixture.companyId, card.id, 'approve', '', { seat: budi }),
    (error: unknown) => isPalugadaError(error, 'staff.forbidden') || isPalugadaError(error, 'approval.own_instigation'));
  await assert.rejects(inbox.decide(fixture.companyId, card.id, 'approve', '', { seat: sari }),
    (error: unknown) => isPalugadaError(error, 'approval.own_instigation'));
  await inbox.decide(fixture.companyId, card.id, 'approve', '');
  await send(given.id);
  assert.deepEqual(sent, ['customer@example.test']);
});

test('a ticket a run files while staff words are in its work carries their mark', async () => {
  const fixture = await createCompany('provenance-ticket');
  const budi = await seat(fixture, 'Budi', 'member');
  const steered = await ownWork(fixture, 'Look at the late deliveries');
  const before = await filedBy(fixture, steered, 'Ask the courier for a refund');
  await instructTask(fixture.companyId, steered, 'And file one for the cold coffee.', as(budi));
  const after = await filedBy(fixture, steered, 'The coffee arrives cold');
  assert.deepEqual(await instigatorsOf(fixture, before.id), [], 'filed before the seat spoke');
  assert.deepEqual(await instigatorsOf(fixture, after.id), [budi.id]);
  // Named again under the same title, a clean ticket stays as it was.
  const again = await filedBy(fixture, steered, 'Ask the courier for a refund');
  assert.equal(again.id, before.id);
  assert.deepEqual(await instigatorsOf(fixture, before.id), []);
  // The owner's own ticket carries no seat.
  const owners = await withTenant(fixture.companyId, (tx) => openTicket(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    title: 'Find a second courier', openedBy: 'owner', outside: false,
  }));
  assert.deepEqual(await instigatorsOf(fixture, owners.ticket.id), []);
});

test('running staff work again keeps the staff mark', async () => {
  const fixture = await createCompany('provenance-rerun');
  const budi = await seat(fixture, 'Budi', 'member');
  const { send } = await mail(fixture);
  const first = await askedBy(fixture, budi, 'Email the customer the new prices');
  await instructTask(fixture.companyId, first, 'Leave out the wholesale prices.', as(budi));
  await cancelTask(fixture.companyId, first, 'wrong list');
  const again = await rerunTask(fixture.companyId, first, 'Use the March list.');
  assert.deepEqual(await carried(fixture, again), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'rerun' }]);
  assert.deepEqual(await words(fixture, again), [{ seatId: budi.id, name: 'Budi' }]);
  // What the seat told the first attempt is told to this one as theirs, fenced, beside the owner's note.
  const told = await withTenant(fixture.companyId, (tx) => buildContext(tx, {
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: again,
  })).then((context) => context.text);
  assert.match(told, /## What members of the owner's staff said to the earlier attempts at this work[\s\S]*<<<COLLEAGUE>>> from="Budi \(staff\)"[\s\S]*- Budi \(staff\) said: Leave out the wholesale prices\./);
  assert.match(told, /Their note: Use the March list\./, 'the owner\'s own note is the owner\'s');
  // Run again by the owner, it is still the seat's request, and the run is told so before its goal.
  assert.match(told, /This work was asked for by Budi, a member of the owner's staff\. Its goal is their request, not the owner's\./);
  await transition(fixture.companyId, again, 'running');
  await assert.rejects(send(again), asks);
  assert.equal((await cardOf(fixture, again)).payload.reason, 'staff');
});

test('a follow-up of staff work keeps the staff mark', async () => {
  const fixture = await createCompany('provenance-follow-up');
  const budi = await seat(fixture, 'Budi', 'member');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET runtime = 'spy' WHERE id = $1", [fixture.roleId]));
  const parent = await ownWork(fixture, 'Invoice the café');
  const child = (goal: string, extra: Record<string, unknown> = {}) => createSubTask(parent, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    input: { goal, ...extra }, reserveTokens: 500,
  });
  const followUp = await child('look again at the invoice', { followUpOf: parent });
  // A sibling is steered by a seat after the follow-up was made: its words come back to the parent.
  const sibling = await child('send the invoice');
  await transition(fixture.companyId, sibling.id, 'running');
  await instructTask(fixture.companyId, sibling.id, 'Add the delivery fee.', as(budi));
  assert.deepEqual(await words(fixture, followUp.id), [], 'not on the follow-up\'s own chain');
  assert.deepEqual(await words(fixture, parent), [{ seatId: budi.id, name: 'Budi' }]);

  const adapter: Adapter = {
    name: 'spy', backends: ['local'] as readonly ExecutionBackend[],
    async health() { return { ok: true }; },
    async run() { return { output: { done: true } }; },
  };
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  await new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), adapters, workerId: 'provenance' })
    .runTask(fixture.companyId, followUp.id, 'worker');
  assert.deepEqual(await carried(fixture, followUp.id), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'follow_up' }]);
});

test('a handed escalation of staff work keeps the staff mark', async () => {
  const fixture = await createCompany('provenance-escalation');
  const budi = await seat(fixture, 'Budi', 'member');
  const leadId = await addRole(fixture, 'ops-lead');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'ops-lead', afterMinutes: 30 });
  const stuck = await askedBy(fixture, budi, 'Renew the domain');
  await inbox.raiseEscalation({
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: stuck,
    title: 'The registrar will not answer', detail: 'Three attempts, all timed out.',
  });
  assert.equal(await inbox.handEscalations(fixture.companyId), 1);
  const { rows: [handed] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    'SELECT id FROM tasks WHERE role_id = $1', [leadId]));
  assert.deepEqual(await carried(fixture, handed!.id), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'escalation' }]);
});

test('a ticket the owner hands to a role keeps the staff mark its filing work had', async () => {
  const fixture = await createCompany('provenance-assign');
  const budi = await seat(fixture, 'Budi', 'member');
  const steered = await askedBy(fixture, budi, 'Look at the late deliveries');
  const ticket = await filedBy(fixture, steered, 'Find a second courier');
  const clean = await filedBy(fixture, await ownWork(fixture, 'Count the stock'), 'Order more cups');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const hand = async (ticketId: string) => {
      const answer = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${ticketId}/assign`, owner,
        { roleId: fixture.roleId, goalId: fixture.goalId });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return String(answer.body.taskId);
    };
    assert.deepEqual(await carried(fixture, await hand(ticket.id)), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'ticket' }]);
    assert.deepEqual(await carried(fixture, await hand(clean.id)), [], 'the owner\'s own work carries nothing');
  } finally {
    await api.close();
  }
});

test('the weekly meeting handed staff-touched facts keeps the staff mark, and so do its to-dos', async () => {
  const fixture = await createCompany('provenance-meeting');
  const budi = await seat(fixture, 'Budi', 'member');
  const now = new Date();
  const local = new Date(now.getTime() + 7 * 3_600_000);
  await withControlPlane((tx) => tx.query(
    `UPDATE companies SET timezone = 'Asia/Jakarta', meeting_weekday = $2, meeting_hour = 0, meeting_enabled = true WHERE id = $1`,
    [fixture.companyId, local.getUTCDay()]));
  const steered = await askedBy(fixture, budi, 'Look at the complaints');
  await filedBy(fixture, steered, 'Customers wait too long on the phone', { kind: 'issue' });

  const meeting = await ensureWeeklyMeeting(fixture.companyId, now);
  assert.ok(meeting);
  assert.deepEqual(await carried(fixture, meeting), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'meeting' }]);
  await transition(fixture.companyId, meeting, 'running');
  const todo = await filedBy(fixture, meeting, 'Hire a second person for the phone', { assigneeRoleId: fixture.roleId });
  assert.deepEqual(await instigatorsOf(fixture, todo.id), [budi.id], 'the meeting\'s to-do carries the mark on');
});

test('the quarter, the week and the month handed staff-touched work keep the staff mark', async () => {
  const fixture = await createCompany('provenance-quarter');
  const budi = await seat(fixture, 'Budi', 'member');
  await withControlPlane((tx) => tx.query(
    "UPDATE companies SET timezone = 'Asia/Jakarta', fiscal_year_start_month = 1 WHERE id = $1", [fixture.companyId]));
  const steered = await askedBy(fixture, budi, 'Think about next year');
  await filedBy(fixture, steered, 'Open a second shop', { kind: 'issue', horizon: 'long_term' });
  const at = new Date(Date.parse('2026-12-22T00:00:00Z') + 3 * 3_600_000);
  const planning = await ensureQuarterlyPlanning(fixture.companyId, at);
  assert.ok(planning);
  assert.deepEqual(await carried(fixture, planning), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'quarter' }]);

  // The week: staff work finished this week is in the review's facts.
  const done = await askedBy(fixture, budi, 'Answer the café');
  await transition(fixture.companyId, done, 'completed', { output: { summary: 'Answered.' } });
  const scheduleId = await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'weekly-business-review', cronExpression: '0 3 * * 1', timezone: 'Asia/Jakarta',
    input: { goal: 'Weekly business review.', facts: 'week' }, reserveTokens: 1_000, priority: 1, batchable: false,
  });
  const review = await runScheduleNow(fixture.companyId, scheduleId);
  assert.deepEqual(await carried(fixture, review.id), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'week' }]);

  // The month: a late invoice staff work wrote is in the review's facts. The
  // books are read through ledger.read, so the role holds it.
  await registerStandardCatalogue();
  await grantCapability(fixture, 'ledger.read');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET tools = array_append(tools, 'ledger.read') WHERE id = $1", [fixture.roleId]));
  const billed = await askedBy(fixture, budi, 'Bill the café');
  await withTenant(fixture.companyId, (tx) => issueInvoice(tx, fixture.companyId, {
    customerName: 'Toko Lama', currency: 'IDR', issueDate: '2020-01-10', dueDate: '2020-01-24',
    lines: [{ description: 'Kopi', quantity: 1, unitCents: 1_000 }],
  }, 'agent', { taskId: billed }));
  const monthly = await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'monthly-review', cronExpression: '50 7 1 * *', timezone: 'Asia/Jakarta',
    input: { goal: 'Monthly money review.', facts: 'month' }, reserveTokens: 1_000, priority: 1, batchable: false,
  });
  const money = await runScheduleNow(fixture.companyId, monthly);
  assert.deepEqual(await carried(fixture, money.id), [{ seatId: budi.id, name: 'Budi', how: 'quoted', from: 'month' }]);
});
