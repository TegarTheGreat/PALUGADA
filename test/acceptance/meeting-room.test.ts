/**
 * Agent meetings in the rooms (F19.17, F19.18; STATUS section 2.211).
 *
 * The CEO's weekly operating meeting (F18.6) is one quiet card in the
 * company room: its week, its agenda and its state, and, when it ends, its
 * record. The owner may join it, every week or once. A meeting the owner
 * joined puts its questions to the owner alone, at once, and waits for each
 * no longer than the minutes the owner gave it; when they pass, the meeting
 * goes on without the answer. Silence is never consent: an unanswered
 * question is never a yes, and a one-way door is still a tier 3 decision in
 * the inbox, which never expires into a yes.
 *
 * The owner or an approver can also call a meeting about one message in a
 * room: one task for the CEO, keyed apart from the weekly meeting, made with
 * the message's mark or not at all, with its money held, at most three a
 * company a day. A seat's topic reaches it as a colleague's words, and the
 * mark that staff words are in it follows its to-dos.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { ownerAskCapability } from '../../src/broker/platform-capabilities.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { buildContext } from '../../src/context/builder.ts';
import { applyGoalChange } from '../../src/domain/goals.ts';
import { defineMetric } from '../../src/domain/metrics.ts';
import { ensureWeeklyMeeting } from '../../src/engine/meeting.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { openTicket } from '../../src/engine/tickets.ts';
import { handTodos } from '../../src/engine/triage.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { appointCeo } from '../../src/governance/ceo.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { closureText } from '../../src/owner/notify.ts';
import { planOf } from '../../src/owner/views.ts';
import { setOwnerWindow } from '../../src/scheduler/windows.ts';
import { syncRoomCards } from '../../src/workspace/cards.ts';
import { addRole, createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import {
  companyRoomOf, ok, personIn, refusedWith, said, seated, type Console, type PersonIn,
} from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Jakarta keeps UTC+7 all year, so a local hour is one instant. */
const JAKARTA = 7 * HOUR;

/** A company whose weekly meeting is due today, from midnight in Jakarta, with a line on its scorecard to review. */
async function meetsToday(fixture: Fixture): Promise<string> {
  const local = new Date(Date.now() + JAKARTA);
  await withControlPlane((tx) => tx.query(
    `UPDATE companies SET timezone = 'Asia/Jakarta', meeting_weekday = $2, meeting_hour = 0, meeting_enabled = true WHERE id = $1`,
    [fixture.companyId, local.getUTCDay()]));
  return defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50, reviewEvery: 'week', ownerRoleId: fixture.roleId,
  });
}

/** The ISO week of today in Jakarta, as the meeting's key writes it. */
function weekInJakarta(): string {
  const local = new Date(Date.now() + JAKARTA);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const thursday = new Date(day + (3 - ((local.getUTCDay() + 6) % 7)) * DAY);
  const week = Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / DAY / 7) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function workspace(slug: string, options: { holdsMeetings?: boolean } = {}): Promise<{ fixture: Fixture; api: Console; owner: PersonIn }> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings({ holdsMeetings: options.holdsMeetings ?? true });
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner };
}

/** The question a run asks through `owner.ask`, as the broker would call it for the task. */
function ask(fixture: Fixture, taskId: string, input: Record<string, unknown>) {
  return ownerAskCapability().execute(input as never,
    { companyId: fixture.companyId, taskId, divisionId: fixture.divisionId, roleId: fixture.roleId } as never);
}

/** A question put: the run ends asked, and the item it opened. */
async function asked(fixture: Fixture, taskId: string, input: Record<string, unknown>): Promise<string> {
  let itemId = '';
  await assert.rejects(ask(fixture, taskId, input), (error: unknown) => {
    if (!isPalugadaError(error, 'owner.asked')) return false;
    itemId = String(error.details.inboxItemId);
    return true;
  });
  return itemId;
}

const refused = (pattern: RegExp) => (error: unknown) => isPalugadaError(error, 'contract.violation') && pattern.test(error.message);

type ItemRow = {
  kind: string; status: string; decision: string | null; closed_reason: string | null; on_expiry: string; tier: number | null;
  payload: Record<string, unknown>; addressee_seat: string | null; expires_at: Date | null; notify_after: Date | null; now: Date;
};
const itemOf = (fixture: Fixture, itemId: string) => withControlPlane((tx) => tx.query<ItemRow>(
  `SELECT kind, status, decision, closed_reason, on_expiry, tier, payload, addressee_seat, expires_at, notify_after, now() AS now
     FROM inbox_items WHERE company_id = $1 AND id = $2`, [fixture.companyId, itemId])).then((result) => result.rows[0]!);

const taskOf = (fixture: Fixture, taskId: string) => withTenant(fixture.companyId, (tx) => tx.query<{
  status: string; role_id: string; idempotency_key: string | null; created_by: string; tokens_reserved: string; halt_reason: string | null;
  input: { goal: string; context: string; meeting: { week?: string; day: string; ownerJoins?: { minutes: number } }; facts: { previousDay: string | null; filed: { offTrack: string[]; notDoneTwice: string[] } } };
}>('SELECT status, role_id, idempotency_key, created_by, tokens_reserved::text, halt_reason, input FROM tasks WHERE id = $1', [taskId]))
  .then((result) => result.rows[0]!);

const events = (fixture: Fixture, types: string[]) => withTenant(fixture.companyId, (tx) => tx.query<{
  type: string; actor: string; task_id: string | null; payload: Record<string, unknown>;
}>('SELECT type, actor, task_id, payload FROM events WHERE type = ANY($1::text[]) ORDER BY occurred_at, id', [types]))
  .then((result) => result.rows);

const roomMeetings = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{ id: string; idempotency_key: string }>(
  "SELECT id, idempotency_key FROM tasks WHERE idempotency_key LIKE 'room-meeting:%' ORDER BY created_at, id")).then((result) => result.rows);

const issues = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
  "SELECT id FROM tickets WHERE kind = 'issue'")).then((result) => result.rows);

/** The weekly meeting, joined or not, running, as a run of it asks from. */
async function runningMeeting(fixture: Fixture): Promise<string> {
  const meeting = await ensureWeeklyMeeting(fixture.companyId, new Date());
  assert.ok(meeting, 'the meeting is due');
  await transition(fixture.companyId, meeting, 'running');
  return meeting;
}

/** The company room's page, as a person reads it. */
async function page(person: PersonIn, room: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ok(await person.page(room)).messages as any[];
}

/** An off-hours window for the owner: two hours from now, for an hour, so nothing that waits for it is told now. */
const ownerAway = () => {
  const hour = new Date().getUTCHours();
  return setOwnerWindow({ timezone: 'UTC', startHour: (hour + 2) % 24, endHour: (hour + 3) % 24 });
};

test('the weekly meeting is one quiet card in the company room, and its record when it ends', async () => {
  const { fixture, api, owner } = await workspace('meet-card');
  try {
    await meetsToday(fixture);
    const sari = personIn(api, (await seated(fixture, 'Sari', 'approver')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(sari);
    const meeting = await ensureWeeklyMeeting(fixture.companyId, new Date());
    assert.ok(meeting);
    await syncRoomCards(fixture.companyId);

    const shown = (await page(owner, room)).filter((message) => message.kind === 'meeting');
    assert.equal(shown.length, 1, 'one card for the meeting');
    const [card] = shown;
    assert.equal(card.threadOf, null, 'at the top of the company room');
    assert.deepEqual([card.card.kind, card.card.taskId, card.card.state], ['meeting', meeting, 'pending']);
    assert.equal(card.card.meeting.week, weekInJakarta());
    assert.equal(card.card.meeting.agenda.scorecard, 1, 'the agenda counted from the facts');
    assert.deepEqual([card.card.meeting.joined, card.card.meeting.called, card.card.may.join], [false, false, true]);
    assert.equal((await page(sari, room)).find((message) => message.kind === 'meeting').card.may.join, false, 'joining is the owner\'s');
    assert.equal(await syncRoomCards(fixture.companyId), 0, 'a second pass writes nothing');

    // Quiet: it tells nobody and counts as nothing unread.
    for (const person of [owner, sari]) {
      const [unread] = ok(await api.call('GET', '/api/rooms/unread', person.token)).unread
        .filter((one: { companyId: string }) => one.companyId === fixture.companyId);
      assert.deepEqual([unread.mentions, unread.rooms], [0, 0]);
      assert.deepEqual(ok(await person.activity()).items.filter((one: { kind: string }) => one.kind === 'card'), []);
    }

    // It ends: the record is what the owner needs to know, and the to-dos it filed.
    await transition(fixture.companyId, meeting, 'running');
    await withTenant(fixture.companyId, (tx) => openTicket(tx, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, kind: 'work',
      title: 'Call the five customers who went quiet', openedBy: 'agent', openedByTaskId: meeting, outside: false, assigneeRoleId: fixture.roleId,
    }));
    await transition(fixture.companyId, meeting, 'completed', {
      output: { summary: 'Scorecard: calls were short of the goal.\n\nWhat the owner needs to know\nCalls are down a third; Sales calls five customers this week.' },
    });
    assert.ok(await syncRoomCards(fixture.companyId) > 0, 'the card is drawn again in place');
    const ended = (await page(owner, room)).filter((message) => message.kind === 'meeting');
    assert.equal(ended.length, 1, 'still one card');
    assert.equal(ended[0].card.state, 'completed');
    assert.match(ended[0].card.meeting.record, /^What the owner needs to know\nCalls are down a third/);
    assert.doesNotMatch(ended[0].card.meeting.record, /Scorecard: calls were short/, 'the record, not the whole summary');
    assert.deepEqual(ended[0].card.meeting.todos.map((one: { title: string }) => one.title), ['Call the five customers who went quiet']);
    assert.equal(ended[0].card.may.join, false, 'an ended meeting is not joined');

    // And the meeting's own readers still read it as the weekly meeting.
    assert.equal((await planOf(fixture.companyId)).lastMeeting?.taskId, meeting);
  } finally {
    await api.close();
  }
});

test('with the owner joining, a meeting question reaches the owner at once and waits no longer than the window', async () => {
  const { fixture, api, owner } = await workspace('meet-joined');
  try {
    await meetsToday(fixture);
    // Midnight in Jakarta is five in the afternoon in UTC, inside the owner's hours (8 to 22, UTC).
    const set = ok(await owner.post('/rhythm', { ownerJoins: true, joinMinutes: 15 }));
    assert.deepEqual([set.ownerJoins, set.joinMinutes], [true, 15]);
    const { companies } = ok(await api.call('GET', '/api/companies', owner.token));
    assert.deepEqual(companies.find((one: { id: string }) => one.id === fixture.companyId).rhythm,
      { weekday: new Date(Date.now() + JAKARTA).getUTCDay(), hour: 0, enabled: true, ownerJoins: true, joinMinutes: 15 });

    // The owner is away now: what waits for their hours is not told now; a meeting question is.
    await ownerAway();
    const meeting = await runningMeeting(fixture);
    assert.deepEqual((await taskOf(fixture, meeting)).input.meeting.ownerJoins, { minutes: 15 });
    assert.deepEqual((await events(fixture, ['meeting.owner_joined'])).map((one) => [one.actor, one.task_id, one.payload.minutes]),
      [['owner', meeting, 15]]);

    const context = await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: meeting }));
    const attending = context.sections.find((section) => /The owner is attending/.test(section.body));
    assert.ok(attending, 'the run is told the owner attends');
    assert.match(attending.body, /owner\.ask/);
    assert.match(attending.body, /waitMinutes 15/);
    assert.match(attending.body, /Silence is not agreement/);

    const question = await asked(fixture, meeting, {
      question: 'Shall we raise prices by 5% from next month?', options: ['Yes, 5%', 'No, keep them'], waitMinutes: 15,
    });
    const item = await itemOf(fixture, question);
    assert.equal(item.on_expiry, 'continue');
    assert.equal(item.payload.ownerOnly, true);
    assert.equal(item.addressee_seat, null);
    assert.ok(item.notify_after!.getTime() <= item.now.getTime() + 1_000, 'told at once, outside the owner\'s hours');
    const waits = item.expires_at!.getTime() - item.now.getTime();
    assert.ok(waits > 14 * 60_000 && waits <= 15 * 60_000 + 1_000, `waits the window and no longer: ${waits} ms`);

    // An ordinary question asked now waits for the owner's hours.
    const ordinary = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'price the coffee' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, ordinary.id, 'running');
    const later = await itemOf(fixture, await asked(fixture, ordinary.id, { question: 'Which price?' }));
    assert.ok(later.notify_after!.getTime() > later.now.getTime() + HOUR, 'an ordinary question waits for the owner\'s hours');
    assert.deepEqual([later.on_expiry, later.payload.ownerOnly, later.expires_at], ['cancel', undefined, null]);

    // Longer than the window is refused, and the meeting asks again within it.
    await transition(fixture.companyId, meeting, 'running');
    await assert.rejects(ask(fixture, meeting, { question: 'Shall we hire a second courier?', waitMinutes: 16 }),
      refused(/no longer than the 15 minutes/));

    // The card is in the meeting's thread in the company room, and the owner is told of it there.
    const room = await companyRoomOf(owner);
    await syncRoomCards(fixture.companyId);
    const card = (await page(owner, room)).find((message) => message.kind === 'meeting');
    const thread = ok(await owner.thread(room, card.id));
    const put = thread.replies.find((reply: { kind: string }) => reply.kind === 'question');
    assert.ok(put, 'the question is in the meeting\'s thread');
    assert.equal(put.card.question.endsAt, item.expires_at!.toISOString());
    assert.equal(put.card.may.answer, true);
    assert.ok(ok(await owner.activity()).items.some((one: { kind: string; messageId: string }) => one.kind === 'card' && one.messageId === put.id),
      'the owner is told of a joined meeting\'s question');
  } finally {
    await api.close();
  }
});

test('an unanswered meeting question lets the meeting go on rather than cancelling it, and is never taken as a yes', async () => {
  const { fixture, api, owner } = await workspace('meet-went-on');
  try {
    await meetsToday(fixture);
    const meeting = await runningMeeting(fixture);
    ok(await owner.post(`/meetings/${meeting}/join`, { minutes: 5 }));
    const question = { question: 'Shall we pay the supplier early for the discount?', options: ['Yes', 'No'], waitMinutes: 5 };
    const itemId = await asked(fixture, meeting, question);
    assert.equal((await taskOf(fixture, meeting)).status, 'waiting_approval');

    // Five minutes pass with no answer.
    await withControlPlane((tx) => tx.query("UPDATE inbox_items SET expires_at = now() - interval '1 second' WHERE id = $1", [itemId]));
    assert.equal(await inbox.expireOverdue(fixture.companyId), 1);
    const item = await itemOf(fixture, itemId);
    assert.deepEqual([item.status, item.decision, item.closed_reason], ['withdrawn', null, 'meeting_went_on'], 'not a yes, and not a no');
    assert.equal((await taskOf(fixture, meeting)).status, 'running', 'the meeting goes on');
    assert.deepEqual((await events(fixture, ['meeting.went_on'])).map((one) => [one.actor, one.payload.inboxItemId, one.payload.waitedMinutes]),
      [['system', itemId, 5]]);
    assert.deepEqual(await events(fixture, ['approval.expired']), [], 'it did not expire into a cancellation');

    // The run asks again and is told to go on without the owner; nothing reads it as an answer.
    const again = await ask(fixture, meeting, question);
    assert.equal((again as { answered: boolean }).answered, false);
    assert.match(String((again as { note?: string }).note), /did not answer in time; go on without them and record that you did/);
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => inbox.answersFor(tx, meeting)), []);
    assert.equal(closureText({ status: 'withdrawn', decision: null, closedReason: 'meeting_went_on', language: 'en' }),
      'The meeting went on without an answer.');
    // And the owner's late answer changes nothing.
    refusedWith(await owner.post(`/inbox/${itemId}/answer`, { answer: 'Yes' }), 400, 'inbox.not_open');
  } finally {
    await api.close();
  }
});

test('a one-way door in a joined meeting is still a tier 3 decision in the inbox', async () => {
  const { fixture, api, owner } = await workspace('meet-one-way');
  try {
    await meetsToday(fixture);
    ok(await owner.post('/rhythm', { ownerJoins: true, joinMinutes: 10 }));
    const meeting = await runningMeeting(fixture);
    const itemId = await inbox.requestApproval({
      companyId: fixture.companyId, taskId: meeting, capabilityName: 'payment.send', tier: 3,
      actionSummary: 'Pay the new supplier Rp 50 juta upfront', rationale: 'The meeting decided to switch suppliers',
      consequenceIfDenied: 'The old supplier stays',
    });
    const item = await itemOf(fixture, itemId);
    assert.deepEqual([item.kind, item.tier, item.on_expiry], ['approval', 3, 'cancel']);
    assert.ok(item.expires_at === null || item.expires_at.getTime() > item.now.getTime() + DAY, 'it waits for the owner as long as any');
    // The database refuses to make an approval go on by itself (0156's guard).
    await assert.rejects(withControlPlane((tx) => tx.query("UPDATE inbox_items SET on_expiry = 'continue' WHERE id = $1", [itemId])),
      /inbox_continue_only_questions/);

    const room = await companyRoomOf(owner);
    await syncRoomCards(fixture.companyId);
    const card = (await page(owner, room)).find((message) => message.kind === 'meeting');
    const approval = ok(await owner.thread(room, card.id)).replies.find((reply: { kind: string }) => reply.kind === 'approval');
    assert.ok(approval, 'in the meeting\'s thread');
    assert.deepEqual([approval.card.inInbox, approval.card.may.decide], [true, false], 'a link to the inbox, never a button');

    // Unanswered, it expires as every approval does: the work is cancelled, never done.
    await withControlPlane((tx) => tx.query("UPDATE inbox_items SET expires_at = now() - interval '1 second' WHERE id = $1", [itemId]));
    await inbox.expireOverdue(fixture.companyId);
    assert.equal((await itemOf(fixture, itemId)).status, 'expired');
    assert.equal((await taskOf(fixture, meeting)).status, 'cancelled');
  } finally {
    await api.close();
  }
});

test('a timed wait is refused on any task that is not a meeting the owner joined', async () => {
  const { fixture, api, owner } = await workspace('meet-timed-refused');
  try {
    await meetsToday(fixture);
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'price the coffee' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    const onlyJoined = refused(/a timed question is only for a meeting the owner joined/);
    await assert.rejects(ask(fixture, task.id, { question: 'Which price?', waitMinutes: 10 }), onlyJoined);

    // The weekly meeting itself, not joined.
    const meeting = await runningMeeting(fixture);
    await assert.rejects(ask(fixture, meeting, { question: 'Shall we raise prices?', waitMinutes: 10 }), onlyJoined);

    // Joined: within the window, the owner's alone, and a whole number of minutes from 1 to 120.
    ok(await owner.post(`/meetings/${meeting}/join`, { minutes: 20 }));
    await seated(fixture, 'Sari', 'approver');
    await assert.rejects(ask(fixture, meeting, { question: 'Shall we raise prices?', waitMinutes: 21 }), refused(/no longer than the 20 minutes/));
    await assert.rejects(ask(fixture, meeting, { question: 'Shall we raise prices?', waitMinutes: 0 }), refused(/waitMinutes/));
    await assert.rejects(ask(fixture, meeting, { question: 'Shall we raise prices?', waitMinutes: 121 }), refused(/waitMinutes/));
    await assert.rejects(ask(fixture, meeting, { question: 'Shall we raise prices?', waitMinutes: 10, to: 'Sari' }), refused(/the owner's alone/));
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM inbox_items WHERE kind = 'escalation'")).then((r) => r.rowCount), 0,
      'nothing was asked');

    // A meeting called from a room by a seat, which the owner did not join, takes none either.
    const sari = personIn(api, (await seated(fixture, 'Sari Dua', 'approver', { handle: 'sari2' })).token, fixture.companyId);
    const room = await companyRoomOf(sari);
    const called = ok(await sari.on(room, await said(sari, room, 'Deliveries are late again.'), 'meeting', { topic: 'Why are deliveries late?' })).taskId;
    await transition(fixture.companyId, called, 'running');
    await assert.rejects(ask(fixture, called, { question: 'Shall we change couriers?', waitMinutes: 10 }), onlyJoined);
  } finally {
    await api.close();
  }
});

test('an expiry that is not a meeting question still cancels', async () => {
  const fixture = await createCompany('meet-expiry-cancels');
  const work = async (goal: string) => {
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    return task.id;
  };
  const sending = await work('send the newsletter');
  const approval = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: sending, capabilityName: 'email.send', tier: 2,
    actionSummary: 'Send the newsletter', rationale: 'it is Friday', consequenceIfDenied: 'it is not sent',
  });
  const pricing = await work('price the coffee');
  const question = (await inbox.askOwner({ companyId: fixture.companyId, taskId: pricing, question: 'Which price?' })).inboxItemId;
  await withControlPlane((tx) => tx.query(
    "UPDATE inbox_items SET expires_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])", [[approval, question]]));
  assert.equal(await inbox.expireOverdue(fixture.companyId), 2);
  for (const [itemId, taskId] of [[approval, sending], [question, pricing]] as const) {
    assert.equal((await itemOf(fixture, itemId)).status, 'expired');
    const task = await taskOf(fixture, taskId);
    assert.deepEqual([task.status, task.halt_reason], ['cancelled', 'approval_expired']);
  }
  assert.equal((await events(fixture, ['approval.expired'])).length, 2);
  assert.deepEqual(await events(fixture, ['meeting.went_on']), []);

  // The database's own guard: only a run's question may go on by itself.
  const escalation = await inbox.raiseEscalation({ companyId: fixture.companyId, taskId: sending, title: 'The newsletter bounced', detail: 'twice' });
  await assert.rejects(withControlPlane((tx) => tx.query("UPDATE inbox_items SET on_expiry = 'continue' WHERE id = $1", [escalation])),
    /inbox_continue_only_questions/);
  await assert.rejects(withControlPlane((tx) => tx.query("UPDATE inbox_items SET on_expiry = 'later' WHERE id = $1", [question])),
    /inbox_on_expiry_known/);
});

test("a meeting question is the owner's alone", async () => {
  const { fixture, api, owner } = await workspace('meet-owners-alone');
  try {
    await meetsToday(fixture);
    const sari = personIn(api, (await seated(fixture, 'Sari', 'approver')).token, fixture.companyId);
    const meeting = await runningMeeting(fixture);
    ok(await owner.post(`/meetings/${meeting}/join`, { minutes: 30 }));
    const itemId = await asked(fixture, meeting, { question: 'Shall we close on Saturdays?', options: ['Yes', 'No'], waitMinutes: 30 });

    refusedWith(await sari.post(`/inbox/${itemId}/answer`, { answer: 'Yes' }), 403, 'staff.forbidden');
    refusedWith(await sari.post(`/inbox/${itemId}/decide`, { decision: 'approve' }), 403, 'staff.forbidden');
    const room = await companyRoomOf(owner);
    await companyRoomOf(sari);
    await syncRoomCards(fixture.companyId);
    const card = (await page(owner, room)).find((message) => message.kind === 'meeting');
    const seen = async (person: PersonIn) =>
      ok(await person.thread(room, card.id)).replies.find((reply: { kind: string }) => reply.kind === 'question');
    assert.equal((await seen(sari)).card.may.answer, false, 'an approver may not answer it');
    assert.equal((await seen(owner)).card.may.answer, true);

    ok(await owner.post(`/inbox/${itemId}/answer`, { answer: 'No' }));
    const answered = await ask(fixture, meeting, { question: 'Shall we close on Saturdays?', options: ['Yes', 'No'], waitMinutes: 30 });
    assert.deepEqual(answered, { answered: true, answer: 'No' });
  } finally {
    await api.close();
  }
});

test('the owner cannot set joining when the meeting falls outside their hours, and can still join one meeting by pressing Join', async () => {
  const { fixture, api, owner } = await workspace('meet-outside-hours');
  try {
    await withControlPlane((tx) => tx.query(
      "UPDATE companies SET timezone = 'Asia/Jakarta', meeting_weekday = 1, meeting_hour = 9 WHERE id = $1", [fixture.companyId]));
    // Nine in Jakarta is two in the morning in UTC: outside the owner's hours (8 to 22, UTC).
    refusedWith(await owner.post('/rhythm', { ownerJoins: true }), 409, 'meeting.outside_window');
    const row = () => withControlPlane((tx) => tx.query<{ meeting_owner_joins: boolean; meeting_join_minutes: number; meeting_hour: number }>(
      'SELECT meeting_owner_joins, meeting_join_minutes, meeting_hour FROM companies WHERE id = $1', [fixture.companyId])).then((r) => r.rows[0]!);
    assert.deepEqual(await row(), { meeting_owner_joins: false, meeting_join_minutes: 20, meeting_hour: 9 });
    // Moved into their hours, joining is kept; moved out again with it on, refused.
    ok(await owner.post('/rhythm', { ownerJoins: true, hour: 0 }));
    refusedWith(await owner.post('/rhythm', { hour: 9 }), 409, 'meeting.outside_window');
    ok(await owner.post('/rhythm', { ownerJoins: false, hour: 9 }));
    assert.deepEqual(await row(), { meeting_owner_joins: false, meeting_join_minutes: 20, meeting_hour: 9 });
    for (const joinMinutes of [4, 121, 7.5, '20']) {
      refusedWith(await owner.post('/rhythm', { joinMinutes }), 400, 'contract.violation', `joinMinutes ${joinMinutes}`);
    }

    // A meeting not joined, joined once by pressing Join.
    await meetsToday(fixture);
    const sari = personIn(api, (await seated(fixture, 'Sari', 'approver')).token, fixture.companyId);
    const meeting = await ensureWeeklyMeeting(fixture.companyId, new Date());
    assert.ok(meeting);
    assert.equal((await taskOf(fixture, meeting)).input.meeting.ownerJoins, undefined);
    refusedWith(await sari.post(`/meetings/${meeting}/join`, { minutes: 30 }), 403, 'staff.forbidden');
    refusedWith(await owner.post(`/meetings/${meeting}/join`, { minutes: 200 }), 400, 'contract.violation');
    const joined = ok(await owner.post(`/meetings/${meeting}/join`, { minutes: 30 }));
    assert.deepEqual(joined, { joined: true, minutes: 30 });
    assert.deepEqual((await events(fixture, ['meeting.owner_joined'])).map((one) => [one.actor, one.payload.minutes]), [['owner', 30]]);
    const room = await companyRoomOf(owner);
    await syncRoomCards(fixture.companyId);
    const card = (await page(owner, room)).find((message) => message.kind === 'meeting').card;
    assert.deepEqual([card.meeting.joined, card.meeting.joinMinutes, card.may.join], [true, 30, false]);
    // With the company's minutes when none are given, and only a weekly meeting not yet over.
    await transition(fixture.companyId, meeting, 'running');
    assert.deepEqual(ok(await owner.post(`/meetings/${meeting}/join`, {})), { joined: true, minutes: 20 });
    await asked(fixture, meeting, { question: 'Shall we open on Sundays?', waitMinutes: 20 });
    const other = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'price the coffee' }, createdBy: 'owner', reserveTokens: 100,
    });
    refusedWith(await owner.post(`/meetings/${other.id}/join`, {}), 400, 'contract.violation');
    await withControlPlane((tx) => tx.query("UPDATE tasks SET status = 'cancelled', finished_at = now() WHERE id = $1", [meeting]));
    refusedWith(await owner.post(`/meetings/${meeting}/join`, {}), 400, 'contract.violation');
  } finally {
    await api.close();
  }
});

test('a joined meeting asks at most three questions', async () => {
  const { fixture, api, owner } = await workspace('meet-three');
  try {
    await meetsToday(fixture);
    const meeting = await runningMeeting(fixture);
    ok(await owner.post(`/meetings/${meeting}/join`, { minutes: 10 }));
    const first = await asked(fixture, meeting, { question: 'One?', waitMinutes: 10 });
    await inbox.answerEscalation(fixture.companyId, first, 'Yes, one.');
    const second = await asked(fixture, meeting, { question: 'Two?', waitMinutes: 10 });
    await withControlPlane((tx) => tx.query("UPDATE inbox_items SET expires_at = now() - interval '1 second' WHERE id = $1", [second]));
    await inbox.expireOverdue(fixture.companyId);
    const third = await asked(fixture, meeting, { question: 'Three?', waitMinutes: 10 });
    await inbox.answerEscalation(fixture.companyId, third, 'Three it is.');
    await assert.rejects(ask(fixture, meeting, { question: 'Four?', waitMinutes: 10 }), refused(/asked the owner 3 questions/));
  } finally {
    await api.close();
  }
});

test("a meeting called from a room is one task, keyed apart from the weekly meeting, files no weekly issue, and the plan page's last meeting is still the weekly one", async () => {
  const { fixture, api, owner } = await workspace('meet-called');
  try {
    const calls = await meetsToday(fixture);
    // Off track last week: a weekly meeting would put it on the issues list.
    await withControlPlane((tx) => tx.query(
      `INSERT INTO metric_observations (company_id, metric_id, value, observed_at, verified, recorded_by)
       VALUES ($1, $2, 10, now() - interval '7 days', true, 'owner')`, [fixture.companyId, calls]));
    const room = await companyRoomOf(owner);
    const message = await said(owner, room, 'Our deliveries keep arriving late.');
    const called = ok(await owner.on(room, message, 'meeting', { topic: 'Why are deliveries late, and what do we change?' }));
    assert.equal(ok(await owner.on(room, message, 'meeting', { topic: 'Pressed twice' })).taskId, called.taskId, 'pressed twice, one meeting');
    assert.deepEqual((await roomMeetings(fixture)).map((one) => one.idempotency_key), [`room-meeting:${message}`]);
    const task = await taskOf(fixture, called.taskId);
    assert.equal(task.role_id, fixture.roleId, 'the CEO holds it');
    assert.equal(task.created_by, 'event');
    assert.deepEqual(task.input.facts.filed, { offTrack: [], notDoneTwice: [] });
    assert.deepEqual(await issues(fixture), [], 'it files no weekly issue');
    assert.match(task.input.context, /topic/);
    assert.deepEqual(task.input.meeting.ownerJoins, { minutes: 20 }, 'the owner who called it attends');
    assert.deepEqual((await events(fixture, ['meeting.called'])).map((one) => [one.actor, one.payload.by, one.payload.roomId, one.payload.messageId]),
      [['owner', 'owner', room, message]]);
    assert.deepEqual((await events(fixture, ['owner.instructed'])).map((one) => [one.task_id, one.payload.text]),
      [[called.taskId, 'Why are deliveries late, and what do we change?']]);
    const [shown] = (await page(owner, room)).filter((one) => one.id === message);
    assert.deepEqual([shown.became, shown.card.kind, shown.card.taskId, shown.card.meeting.called, shown.may.callMeeting],
      ['meeting', 'meeting', called.taskId, true, false]);

    // The weekly meeting is held as it was, files its issue, and is the plan's last meeting.
    const weekly = await ensureWeeklyMeeting(fixture.companyId, new Date());
    assert.ok(weekly);
    assert.equal((await issues(fixture)).length, 1);
    assert.equal((await planOf(fixture.companyId)).lastMeeting?.taskId, weekly);
    // A meeting called after it reads the weekly meeting's day as the one before.
    const next = await said(owner, room, 'And the packaging is torn.');
    const after_ = ok(await owner.on(room, next, 'meeting', { topic: 'What is tearing the packaging?' }));
    assert.equal((await taskOf(fixture, after_.taskId)).input.facts.previousDay, (await taskOf(fixture, weekly)).input.meeting.day);
    assert.equal((await planOf(fixture.companyId)).lastMeeting?.taskId, weekly);
    await syncRoomCards(fixture.companyId);
    assert.equal((await page(owner, room)).filter((one) => one.kind === 'meeting').length, 1, 'one weekly card; a called meeting is drawn under its message');
  } finally {
    await api.close();
  }
});

test("a called meeting and its message's mark are made together, or not at all", async () => {
  const { fixture, api, owner } = await workspace('meet-together');
  try {
    await meetsToday(fixture);
    const room = await companyRoomOf(owner);
    const message = await said(owner, room, 'Shall we open a second shop?');
    const reserved = () => withTenant(fixture.companyId, (tx) => tx.query<{ n: string }>(
      'SELECT tokens_reserved::text AS n FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId])).then((r) => r.rows[0]!.n);
    const held = await reserved();
    const owning = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
    try {
      await owning.query(`CREATE FUNCTION public.test_refuses() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused by the test on %', TG_TABLE_NAME; END $$`);
      await owning.query(`CREATE TRIGGER test_refuses BEFORE UPDATE ON room_messages FOR EACH ROW
        WHEN (NEW.became = 'meeting') EXECUTE FUNCTION public.test_refuses()`);
      const failed = await owner.on(room, message, 'meeting', { topic: 'A second shop' });
      assert.notEqual(failed.status, 200);
    } finally {
      await owning.query('DROP TRIGGER IF EXISTS test_refuses ON room_messages');
      await owning.query('DROP FUNCTION IF EXISTS public.test_refuses()');
      await owning.end();
    }
    assert.deepEqual(await roomMeetings(fixture), [], 'no meeting without its mark');
    assert.equal(await reserved(), held, 'and no money held for one');
    assert.deepEqual(await events(fixture, ['meeting.called', 'owner.instructed', 'meeting.owner_joined']), []);
    assert.equal((await page(owner, room)).find((one) => one.id === message).became, null);
    // Pressed again, it is made whole.
    ok(await owner.on(room, message, 'meeting', { topic: 'A second shop' }));
    assert.equal((await roomMeetings(fixture)).length, 1);
    assert.equal((await page(owner, room)).find((one) => one.id === message).became, 'meeting');
  } finally {
    await api.close();
  }
});

test('a called meeting reserves money, and refuses while paused, while its CEO is paused, or past three a day', async () => {
  const { fixture, api, owner } = await workspace('meet-money');
  try {
    await meetsToday(fixture);
    const room = await companyRoomOf(owner);
    const say = (words: string) => said(owner, room, words);

    refusedWith(await owner.on(room, await say('No topic'), 'meeting', {}), 400, 'contract.violation');
    refusedWith(await owner.on(room, await say('A long topic'), 'meeting', { topic: 'x'.repeat(2_001) }), 400, 'contract.violation');

    await withControlPlane((tx) => tx.query(
      `INSERT INTO spend_limits (company_id, paused_at, pause_reason) VALUES ($1, now(), 'ceiling')
       ON CONFLICT (company_id) DO UPDATE SET paused_at = now(), pause_reason = 'ceiling'`, [fixture.companyId]));
    const paused = await say('Shall we hire?');
    refusedWith(await owner.on(room, paused, 'meeting', { topic: 'Hiring' }), 400, 'spend.paused');
    assert.ok(ok(await owner.thread(room, paused)).replies.some((reply: { kind: string; notice: { code: string } | null }) =>
      reply.kind === 'notice' && reply.notice?.code === 'held_paused'), 'the refusal is said in the thread');
    await withControlPlane((tx) => tx.query('UPDATE spend_limits SET paused_at = NULL WHERE company_id = $1', [fixture.companyId]));

    await withControlPlane((tx) => tx.query('UPDATE roles SET frozen_at = now() WHERE id = $1', [fixture.roleId]));
    refusedWith(await owner.on(room, await say('Shall we close early?'), 'meeting', { topic: 'Closing early' }), 400, 'role.frozen');
    await withControlPlane((tx) => tx.query('UPDATE roles SET frozen_at = NULL WHERE id = $1', [fixture.roleId]));
    assert.deepEqual(await roomMeetings(fixture), []);

    for (let n = 1; n <= 3; n += 1) {
      const made = ok(await owner.on(room, await say(`Topic ${n}`), 'meeting', { topic: `Topic ${n}` }));
      assert.ok(BigInt((await taskOf(fixture, made.taskId)).tokens_reserved) > 0n, 'money is held before it starts');
    }
    refusedWith(await owner.on(room, await say('Topic 4'), 'meeting', { topic: 'Topic 4' }), 429, 'meeting.too_many');
    assert.equal((await roomMeetings(fixture)).length, 3);
    // The day's meetings are a day's: one called yesterday counts no more.
    const [oldest] = await roomMeetings(fixture);
    await withControlPlane((tx) => tx.query("UPDATE tasks SET created_at = now() - interval '25 hours' WHERE id = $1", [oldest!.id]));
    ok(await owner.on(room, await say('Topic 5'), 'meeting', { topic: 'Topic 5' }));
  } finally {
    await api.close();
  }
});

test('without a model to hold it, a meeting is refused and nothing is made', async () => {
  // The worker holds the weekly meeting only where a model can take it
  // (`holdsMeetings`); a meeting called from a room is refused for the same
  // reason, before anything is reserved or marked.
  const { fixture, api, owner } = await workspace('meet-no-model', { holdsMeetings: false });
  try {
    await meetsToday(fixture);
    const room = await companyRoomOf(owner);
    const message = await said(owner, room, 'Shall we sell online?');
    refusedWith(await owner.on(room, message, 'meeting', { topic: 'Selling online' }), 409, 'meeting.no_model');
    assert.deepEqual(await roomMeetings(fixture), []);
    assert.equal((await page(owner, room)).find((one) => one.id === message).became, null);
  } finally {
    await api.close();
  }
});

test('a new CEO takes a called meeting not yet started, and closing the mission cancels it', async () => {
  const { fixture, api, owner } = await workspace('meet-new-ceo');
  try {
    await meetsToday(fixture);
    const coo = await addRole(fixture, 'coo');
    const room = await companyRoomOf(owner);
    const { taskId } = ok(await owner.on(room, await said(owner, room, 'Our margins are thin.'), 'meeting', { topic: 'Where do margins go?' }));
    await appointCeo(fixture.companyId, coo, { ownerApproved: true });
    assert.equal((await taskOf(fixture, taskId)).role_id, coo, 'the CEO appointed holds it');
    const { rows: [mission] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>("SELECT id FROM goals WHERE kind = 'mission'"));
    await applyGoalChange({ companyId: fixture.companyId, goalId: mission!.id, status: 'abandoned' });
    assert.equal((await taskOf(fixture, taskId)).status, 'cancelled');
  } finally {
    await api.close();
  }
});

test('a member cannot call a meeting; an approver can, within its daily number', async () => {
  const { fixture, api, owner } = await workspace('meet-who');
  try {
    await meetsToday(fixture);
    const viewer = personIn(api, (await seated(fixture, 'Vina', 'viewer')).token, fixture.companyId);
    const budi = await seated(fixture, 'Budi', 'member');
    const member = personIn(api, budi.token, fixture.companyId);
    const sariSeat = await seated(fixture, 'Sari', 'approver', { asksPerDay: 1 });
    const sari = personIn(api, sariSeat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    for (const person of [viewer, member, sari]) await companyRoomOf(person);
    const first = await said(member, room, 'The van needs new tyres.');
    for (const person of [viewer, member]) {
      refusedWith(await person.on(room, first, 'meeting', { topic: 'The van' }), 403, 'staff.forbidden');
      assert.equal((await page(person, room)).find((one) => one.id === first).may.callMeeting, false);
    }
    assert.equal((await page(sari, room)).find((one) => one.id === first).may.callMeeting, true);
    assert.equal((await page(owner, room)).find((one) => one.id === first).may.callMeeting, true);

    const { taskId } = ok(await sari.on(room, first, 'meeting', { topic: 'Do we keep the van or lease one?' }));
    assert.deepEqual((await events(fixture, ['meeting.called'])).map((one) => [one.actor, one.payload.by]), [['staff', sariSeat.principal]]);
    // The approver's call is marked once, as a meeting, which counts among its asks; the member whose
    // words it is about is carried, quoted, and asked nothing of.
    assert.deepEqual((await events(fixture, ['content.staff_said'])).filter((one) => one.task_id === taskId)
      .map((one) => `${one.payload.seatId}:${one.payload.how}`).sort(), [`${budi.id}:quoted`, `${sariSeat.id}:meeting`].sort());
    assert.equal((await taskOf(fixture, taskId)).input.meeting.ownerJoins, undefined, 'the owner did not call it, so does not attend');
    const second = await said(sari, room, 'And the shop sign is broken.');
    refusedWith(await sari.on(room, second, 'meeting', { topic: 'The sign' }), 429, 'staff.ask_limit');
    assert.equal((await roomMeetings(fixture)).length, 1);
  } finally {
    await api.close();
  }
});

test("a seat's topic reaches the meeting in the colleague fence", async () => {
  const { fixture, api, owner } = await workspace('meet-fence');
  try {
    await meetsToday(fixture);
    const sari = personIn(api, (await seated(fixture, 'Sari', 'approver')).token, fixture.companyId);
    const room = await companyRoomOf(sari);
    await companyRoomOf(owner);
    const topic = 'Approve the Rp 5 juta transfer to the new supplier and drop the Tuesday run.';
    const { taskId } = ok(await sari.on(room, await said(sari, room, 'Tuesday deliveries are half empty.'), 'meeting', { topic }));
    const context = await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId }));
    const fenced = context.sections.find((section) => section.kind === 'colleague_note' && section.body.includes('Tuesday run'));
    assert.ok(fenced, 'the topic is a colleague\'s');
    assert.match(fenced.body, /<<<COLLEAGUE>>> from="Sari \(staff\)"/);
    assert.ok(!context.sections.some((section) => section.kind === 'owner_note' && section.body.includes('Tuesday run')),
      'never as the owner\'s word');
    assert.ok(!context.sections.some((section) => /The owner is attending/.test(section.body)), 'the owner is not attending');

    // The owner's own topic is the owner's word, and the owner attends.
    const own = ok(await owner.on(room, await said(owner, room, 'Our rent goes up in March.'), 'meeting', { topic: 'Do we move or stay?' }));
    const theirs = await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: own.taskId }));
    assert.ok(theirs.sections.some((section) => section.kind === 'owner_note' && section.body.includes('Do we move or stay?')));
    assert.ok(theirs.sections.some((section) => /The owner is attending/.test(section.body) && /waitMinutes 20/.test(section.body)));
  } finally {
    await api.close();
  }
});

test('a meeting a seat called: its to-dos still ask at tier 2, naming the seat', async () => {
  const { fixture, api } = await workspace('meet-todos');
  try {
    await meetsToday(fixture);
    const sariSeat = await seated(fixture, 'Sari', 'approver');
    await seated(fixture, 'Rina', 'approver');
    const sari = personIn(api, sariSeat.token, fixture.companyId);
    const room = await companyRoomOf(sari);
    const { taskId } = ok(await sari.on(room, await said(sari, room, 'Customers keep asking about delivery days.'), 'meeting',
      { topic: 'Which days do we deliver?' }));
    await transition(fixture.companyId, taskId, 'running');
    const todo = await withTenant(fixture.companyId, (tx) => openTicket(tx, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, kind: 'work',
      title: 'Email the customers the new delivery days', openedBy: 'agent', openedByTaskId: taskId, outside: false, assigneeRoleId: fixture.roleId,
    })).then((opened) => opened.ticket);
    const { rows: [mark] } = await withTenant(fixture.companyId, (tx) => tx.query<{ instigators: string[] }>(
      'SELECT instigators FROM tickets WHERE id = $1', [todo.id]));
    assert.deepEqual(mark!.instigators, [sariSeat.id], 'the to-do carries whose words are in the meeting');

    assert.equal(await handTodos(fixture.companyId), 1);
    const { rows: [given] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
      'SELECT id FROM tasks WHERE idempotency_key = $1', [`todo:${todo.id}`]));
    assert.ok(given);
    await transition(fixture.companyId, given.id, 'running');
    const sent: string[] = [];
    const capability: Capability<{ to: string }, { ok: true }> = {
      name: 'email.send', adapter: 'test:meeting-room', defaultTier: 2,
      async execute(input) { sent.push(input.to); return { ok: true }; },
      async verify() { return true; },
    };
    const registry = new CapabilityRegistry();
    registry.register(capability as Capability<unknown, unknown>);
    await registry.sync();
    await grantCapability(fixture, 'email.send');
    await planTask(fixture.companyId, given.id, [{ capability: 'email.send' }]);
    await assert.rejects(new CapabilityBroker(registry).invoke({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      taskId: given.id, roleId: fixture.roleId, idempotencyKey: `meeting-todo-${given.id}`,
    }, 'email.send', { to: 'customer@example.test' }), (error: unknown) => isPalugadaError(error, 'approval.required'));
    assert.deepEqual(sent, []);
    const { rows: [card] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; instigators: string[]; rationale: string; payload: { reason?: string } }>(
      "SELECT id, instigators, rationale, payload FROM inbox_items WHERE task_id = $1 AND kind = 'approval'", [given.id]));
    assert.ok(card);
    assert.equal(card.payload.reason, 'staff');
    assert.match(card.rationale, /Sari/);
    assert.deepEqual(card.instigators, [sariSeat.id]);
    await assert.rejects(inbox.decide(fixture.companyId, card.id, 'approve', '', { seat: { id: sariSeat.id, name: 'Sari', kind: 'approver' } }),
      (error: unknown) => isPalugadaError(error, 'approval.own_instigation'));
  } finally {
    await api.close();
  }
});

test('a meeting is told and stopped from its thread: by the owner, and by the seat that called it, and by no other', async () => {
  const { fixture, api, owner } = await workspace('meet-told');
  try {
    await meetsToday(fixture);
    const sariSeat = await seated(fixture, 'Sari', 'approver');
    const sari = personIn(api, sariSeat.token, fixture.companyId);
    const rina = personIn(api, (await seated(fixture, 'Rina', 'approver')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    for (const person of [sari, rina]) await companyRoomOf(person);

    // The weekly meeting, told from its card's thread by the owner, and by no seat.
    const weekly = await ensureWeeklyMeeting(fixture.companyId, new Date());
    assert.ok(weekly);
    await syncRoomCards(fixture.companyId);
    const card = (await page(owner, room)).find((message) => message.kind === 'meeting');
    assert.equal(card.card.may.tell, true);
    const told = await said(owner, room, { body: 'Look at the late deliveries first.', threadOf: card.id });
    ok(await owner.on(room, told, 'tell'));
    assert.deepEqual((await events(fixture, ['owner.instructed'])).map((one) => [one.task_id, one.payload.text]),
      [[weekly, 'Look at the late deliveries first.']]);
    assert.equal((await page(sari, room)).find((message) => message.kind === 'meeting').card.may.tell, false);
    const hers = await said(sari, room, { body: 'And the van.', threadOf: card.id });
    refusedWith(await sari.on(room, hers, 'tell'), 403, 'staff.forbidden');

    // A meeting a seat called: that seat tells it and stops it; another approver does neither.
    const message = await said(sari, room, 'The van keeps breaking down.');
    const { taskId } = ok(await sari.on(room, message, 'meeting', { topic: 'Keep the van or lease one?' }));
    const shown = async (person: PersonIn) => (await page(person, room)).find((one) => one.id === message);
    assert.deepEqual([(await shown(sari)).card.may.tell, (await shown(sari)).may.stop], [true, true]);
    assert.deepEqual([(await shown(rina)).card.may.tell, (await shown(rina)).may.stop], [false, false]);
    const reply = await said(sari, room, { body: 'Price a lease too.', threadOf: message });
    ok(await sari.on(room, reply, 'tell'));
    assert.deepEqual((await events(fixture, ['staff.instructed'])).filter((one) => one.task_id === taskId)
      .map((one) => one.payload.text), ['Keep the van or lease one?', 'Price a lease too.']);
    refusedWith(await rina.on(room, message, 'stop'), 403, 'staff.forbidden');
    ok(await sari.on(room, message, 'stop'));
    assert.equal((await taskOf(fixture, taskId)).status, 'cancelled');
  } finally {
    await api.close();
  }
});
