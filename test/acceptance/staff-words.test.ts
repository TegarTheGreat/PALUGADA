/**
 * Words carry their author (F19.9; the workspace plan, set S0a).
 *
 * The owner seats staff beside them, and a seat's words are never the
 * owner's. Before anything reads that difference, it has to be recorded:
 * work a seat asks for says it was a member of staff's and which seat
 * pressed, an instruction a seat gives says who gave it, and an answer a
 * seat gives to an escalation is the seat's. And what a seat may do in the
 * inbox is held where the inbox decides, not only in the list of routes a
 * seat may reach: a viewer answers nothing, a member answers only what is
 * put to it and decides nothing, and nobody but the owner answers what the
 * owner alone is asked.
 *
 * Until the broker holds staff work at tier 2 and above and four eyes keep a
 * seat from deciding what it asked for, no staff work may be made at all:
 * the owner's standing approvals would let it through. `STAFF_WORDS_HELD`
 * says whether that hold exists, and exactly one of the first and the last
 * case below runs in any build.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { STAFF_WORDS_HELD } from '../../src/broker/broker.ts';
import { instructTask } from '../../src/engine/owner-control.ts';
import {
  createRootTask, createRootTaskWithin, createSubTask, getTask, transition, type CreateTaskInput,
} from '../../src/engine/tasks.ts';
import { isPalugadaError, type ErrorCode } from '../../src/errors.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import type { StaffKind } from '../../src/owner/staff.ts';
import { assignTask } from '../../src/scheduler/wake.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A seat of the company, joined, as the route hands it to the inbox: read from its verified session. */
async function seat(fixture: Fixture, name: string, kind: StaffKind): Promise<inbox.SeatActor> {
  const id = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO staff_seats (company_id, name, kind, secret_ref, joined_at)
       VALUES ($1, $2, $3, 'db://staff-totp-test', now()) RETURNING id`,
      [fixture.companyId, name, kind]);
    return rows[0]!.id;
  });
  return { id, name, kind };
}

function work(fixture: Fixture, goal: string): CreateTaskInput {
  return {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 100,
  };
}

async function running(fixture: Fixture, goal: string): Promise<string> {
  const task = await createRootTask(work(fixture, goal));
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

/** A run's own question, as `owner.ask` raises it; put to a seat when one is named. */
async function question(fixture: Fixture, goal: string, to?: inbox.SeatActor): Promise<{ taskId: string; itemId: string }> {
  const taskId = await running(fixture, goal);
  const asked = await inbox.askOwner({
    companyId: fixture.companyId, taskId, question: `What should ${goal} cost?`,
    ...(to ? { addressee: { seatId: to.id, name: to.name, escalateAfterHours: 24 } } : {}),
  });
  return { taskId, itemId: asked.inboxItemId };
}

/** An escalation that is not a question: answering it tells the task something and sends it back to work. */
async function escalation(fixture: Fixture, goal: string): Promise<{ taskId: string; itemId: string }> {
  const taskId = await running(fixture, goal);
  await transition(fixture.companyId, taskId, 'waiting_review');
  const itemId = await inbox.raiseEscalation({
    companyId: fixture.companyId, taskId, title: 'Review deadlocked after 2 revisions: email.send',
    detail: 'Proposer and reviewer did not converge.',
  });
  return { taskId, itemId };
}

/** An approval at tier 2, the kind an approver decides. */
async function approval(fixture: Fixture, goal: string): Promise<string> {
  const taskId = (await createRootTask(work(fixture, goal))).id;
  await planTask(fixture.companyId, taskId, [{ capability: 'social.publish' }]);
  await transition(fixture.companyId, taskId, 'running');
  return inbox.requestApproval({
    companyId: fixture.companyId, taskId, capabilityName: 'social.publish', tier: 2,
    actionSummary: goal, rationale: 'the draft is ready', consequenceIfDenied: 'the post is not published',
  });
}

const refused = (code: ErrorCode, message?: RegExp) => (error: unknown) => {
  assert.ok(isPalugadaError(error, code), `expected ${code}, got ${String(error)}`);
  if (message) assert.match(error.message, message);
  return true;
};

const item = (fixture: Fixture, itemId: string) => withTenant(fixture.companyId, (tx) => tx.query<{
  status: string; decision: string | null; decided_by_seat: string | null; owner_note: string | null;
  payload: { answers?: Array<{ from: string; answer: string }> };
}>('SELECT status, decision, decided_by_seat, owner_note, payload FROM inbox_items WHERE id = $1', [itemId]))
  .then((result) => result.rows[0]!);

/** The events of some types, oldest first, as the run and the console read them. */
const events = (fixture: Fixture, types: string[], taskId?: string) => withTenant(fixture.companyId, (tx) => tx.query<{
  type: string; actor: string; payload: Record<string, unknown>;
}>(
  `SELECT type, actor, payload FROM events
    WHERE type = ANY($1::text[]) AND ($2::uuid IS NULL OR task_id = $2::uuid) ORDER BY occurred_at, id`,
  [types, taskId ?? null])).then((result) => result.rows);

/** Either record of an instruction: the one every reader takes today, and the one that replaces it for a seat. */
const INSTRUCTED = ['owner.instructed', 'staff.instructed'];

test("work a seat asks for, and an instruction a seat gives, are recorded as that seat's",
  { skip: STAFF_WORDS_HELD ? false : 'staff work is refused until the broker holds it' }, async () => {
    const fixture = await createCompany('staff-words-recorded');
    const budi = await seat(fixture, 'Budi', 'member');

    const { task } = await assignTask({ ...work(fixture, 'Price the new catalogue'), createdBy: 'staff', requestedBySeat: budi.id });
    const own = await assignTask(work(fixture, 'Write the newsletter'));
    const rows = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; created_by: string; requested_by_seat: string | null }>(
      'SELECT id, created_by, requested_by_seat FROM tasks WHERE id = ANY($1::uuid[])', [[task.id, own.task.id]]));
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    assert.deepEqual([byId.get(task.id)!.created_by, byId.get(task.id)!.requested_by_seat], ['staff', budi.id]);
    assert.deepEqual([byId.get(own.task.id)!.created_by, byId.get(own.task.id)!.requested_by_seat], ['owner', null]);

    const created = await events(fixture, ['task.created']);
    assert.deepEqual(created.map((event) => [event.actor, event.payload.requestedBySeat ?? null]),
      [['staff', budi.id], ['owner', null]], 'the seat that pressed is on the record of the work it began');
    const woken = await events(fixture, ['wake.queued']);
    assert.deepEqual(woken.map((event) => event.actor), ['staff', 'owner'], 'and on the wake that hands it over');

    // A seat is named only on staff work: the owner's own work cannot carry one.
    await assert.rejects(createRootTask({ ...work(fixture, 'Count the stock'), requestedBySeat: budi.id }),
      refused('contract.violation', /only on work a member of staff began/));

    await instructTask(fixture.companyId, task.id, 'Lead with the bundles.', { kind: 'seat', seatId: budi.id, name: 'Budi' });
    await instructTask(fixture.companyId, task.id, 'And keep last year\'s prices beside them.', { kind: 'owner' });
    const told = await events(fixture, INSTRUCTED, task.id);
    assert.deepEqual(told.map((event) => [event.actor, event.payload.text, event.payload.staff ?? null]), [
      ['staff', 'Lead with the bundles.', { seatId: budi.id, name: 'Budi' }],
      ['owner', 'And keep last year\'s prices beside them.', null],
    ]);
  });

test("a seat's answer to an escalation is recorded under the seat's name", async () => {
  const fixture = await createCompany('staff-words-answer');
  const sari = await seat(fixture, 'Sari', 'approver');

  // An escalation that is not a question: the answer is told to the task.
  const deadlock = await escalation(fixture, 'the launch email');
  await inbox.answerEscalation(fixture.companyId, deadlock.itemId, 'Keep the price, drop the discount.', { seat: sari });
  assert.deepEqual((await item(fixture, deadlock.itemId)).payload.answers?.map((one) => [one.from, one.answer]),
    [['Sari', 'Keep the price, drop the discount.']]);
  const answered = await events(fixture, ['owner.answered'], deadlock.taskId);
  assert.deepEqual(answered.map((event) => [event.actor, event.payload.staff]), [['staff', { seatId: sari.id, name: 'Sari' }]]);
  const told = await events(fixture, INSTRUCTED, deadlock.taskId);
  assert.deepEqual(told.map((event) => [event.actor, event.payload.text, event.payload.staff]),
    [['staff', 'Keep the price, drop the discount.', { seatId: sari.id, name: 'Sari' }]],
    'what the task is told is the seat\'s, not the owner\'s');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, deadlock.taskId)))!.status, 'running');

  // A run's question put to nobody: the answer decides it, in the seat's name.
  const asked = await question(fixture, 'the bundle');
  await inbox.answerEscalation(fixture.companyId, asked.itemId, 'Rp 25.000', { seat: sari });
  const decided = await item(fixture, asked.itemId);
  assert.deepEqual([decided.status, decided.decision, decided.decided_by_seat, decided.owner_note], ['decided', 'approve', sari.id, 'Rp 25.000']);
  const record = await events(fixture, ['owner.decided'], asked.taskId);
  assert.deepEqual(record.map((event) => [event.actor, event.payload.staff]), [['staff', { seatId: sari.id, name: 'Sari' }]]);

  // The owner's own answer is still the owner's.
  const mine = await escalation(fixture, 'the invoice');
  await inbox.answerEscalation(fixture.companyId, mine.itemId, 'Send it Monday.');
  assert.deepEqual((await events(fixture, INSTRUCTED, mine.taskId)).map((event) => [event.type, event.actor, event.payload.staff ?? null]),
    [['owner.instructed', 'owner', null]]);
});

test('a member answers what is put to it and decides nothing', async () => {
  const fixture = await createCompany('staff-words-member');
  const budi = await seat(fixture, 'Budi', 'member');
  const sari = await seat(fixture, 'Sari', 'approver');

  // Its own question is answered with words, through the answer.
  const asked = await question(fixture, 'the bundle', budi);
  await assert.rejects(inbox.decide(fixture.companyId, asked.itemId, 'approve', 'Rp 25.000', { seat: budi }),
    refused('staff.forbidden', /decides nothing/));
  assert.equal((await item(fixture, asked.itemId)).status, 'open', 'a decision refused is not an answer');
  await inbox.answerEscalation(fixture.companyId, asked.itemId, 'Rp 25.000', { seat: budi });
  const answered = await item(fixture, asked.itemId);
  assert.deepEqual([answered.status, answered.decided_by_seat, answered.owner_note], ['decided', budi.id, 'Rp 25.000']);
  assert.deepEqual((await events(fixture, ['owner.decided'], asked.taskId)).map((event) => [event.actor, event.payload.staff]),
    [['staff', { seatId: budi.id, name: 'Budi' }]]);

  // An approval is an approver's, one at a time or in a batch, yes or no.
  const card = await approval(fixture, 'Post the launch photo');
  for (const decision of ['approve', 'deny'] as const) {
    await assert.rejects(inbox.decide(fixture.companyId, card, decision, '', { seat: budi }), refused('staff.forbidden', /decides nothing/));
    await assert.rejects(inbox.decideMany(fixture.companyId, [card], decision, '', { seat: budi }), refused('staff.forbidden', /decides nothing/));
  }
  assert.equal((await item(fixture, card)).status, 'open');
  assert.deepEqual(await events(fixture, ['owner.decided_batch']), [], 'a refused batch leaves no record of a batch');
  await inbox.decide(fixture.companyId, card, 'approve', '', { seat: sari });
  assert.deepEqual([(await item(fixture, card)).status, (await item(fixture, card)).decided_by_seat], ['decided', sari.id]);
});

test('a member cannot answer a question put to nobody, nor an escalation that is not a question', async () => {
  const fixture = await createCompany('staff-words-member-limits');
  const budi = await seat(fixture, 'Budi', 'member');
  const sari = await seat(fixture, 'Sari', 'approver');

  const nobodys = await question(fixture, 'the bundle');
  await assert.rejects(inbox.answerEscalation(fixture.companyId, nobodys.itemId, 'Rp 25.000', { seat: budi }),
    refused('staff.forbidden', /put to nobody is an approver's/));
  const deadlock = await escalation(fixture, 'the launch email');
  await assert.rejects(inbox.answerEscalation(fixture.companyId, deadlock.itemId, 'Drop the discount.', { seat: budi }),
    refused('staff.forbidden', /not a question is an approver's/));
  const sarisOwn = await question(fixture, 'the hamper', sari);
  await assert.rejects(inbox.answerEscalation(fixture.companyId, sarisOwn.itemId, 'Rp 90.000', { seat: budi }),
    refused('staff.forbidden', /this question is for Sari/));

  // Nothing of the refused answers was written.
  assert.equal((await item(fixture, nobodys.itemId)).status, 'open');
  assert.equal((await item(fixture, deadlock.itemId)).payload.answers, undefined);
  assert.deepEqual(await events(fixture, ['owner.answered', ...INSTRUCTED]), []);

  // Both are an approver's.
  await inbox.answerEscalation(fixture.companyId, nobodys.itemId, 'Rp 25.000', { seat: sari });
  await inbox.answerEscalation(fixture.companyId, deadlock.itemId, 'Drop the discount.', { seat: sari });
  assert.equal((await item(fixture, nobodys.itemId)).decided_by_seat, sari.id);
  assert.deepEqual((await item(fixture, deadlock.itemId)).payload.answers?.map((one) => one.from), ['Sari']);
});

test('a viewer answers nothing, and no seat answers a question the owner alone is asked', async () => {
  const fixture = await createCompany('staff-words-viewer');
  const vina = await seat(fixture, 'Vina', 'viewer');
  const sari = await seat(fixture, 'Sari', 'approver');

  const asked = await question(fixture, 'the bundle');
  const deadlock = await escalation(fixture, 'the launch email');
  const card = await approval(fixture, 'Post the launch photo');
  await assert.rejects(inbox.answerEscalation(fixture.companyId, asked.itemId, 'Rp 25.000', { seat: vina }),
    refused('staff.forbidden', /a viewer reads and answers nothing/));
  await assert.rejects(inbox.answerEscalation(fixture.companyId, deadlock.itemId, 'Drop the discount.', { seat: vina }),
    refused('staff.forbidden', /a viewer reads and answers nothing/));
  await assert.rejects(inbox.decide(fixture.companyId, card, 'deny', '', { seat: vina }), refused('staff.forbidden'));
  await assert.rejects(inbox.decideMany(fixture.companyId, [card], 'deny', '', { seat: vina }), refused('staff.forbidden'));
  assert.deepEqual([(await item(fixture, asked.itemId)).status, (await item(fixture, card)).status], ['open', 'open']);

  // A question the owner alone is asked -- a meeting waiting for them -- is
  // no seat's, not even an approver's, by answer or by decision.
  const meeting = await question(fixture, 'the quarter\'s plan');
  await withTenant(fixture.companyId, (tx) => tx.query(
    `UPDATE inbox_items SET payload = payload || '{"ownerOnly": true}'::jsonb WHERE id = $1`, [meeting.itemId]));
  await assert.rejects(inbox.answerEscalation(fixture.companyId, meeting.itemId, 'Yes.', { seat: sari }),
    refused('staff.forbidden', /the owner alone/));
  await assert.rejects(inbox.decide(fixture.companyId, meeting.itemId, 'approve', 'Yes.', { seat: sari }),
    refused('staff.forbidden', /the owner alone/));
  assert.equal((await item(fixture, meeting.itemId)).status, 'open');
  await inbox.answerEscalation(fixture.companyId, meeting.itemId, 'Yes, as planned.');
  const answered = await item(fixture, meeting.itemId);
  assert.deepEqual([answered.status, answered.decided_by_seat], ['decided', null], 'the owner answers it');
});

test('no staff work can be made before its hold exists',
  { skip: STAFF_WORDS_HELD ? 'the broker holds staff work now' : false }, async () => {
    const fixture = await createCompany('staff-words-held');
    const budi = await seat(fixture, 'Budi', 'member');
    const parent = await createRootTask(work(fixture, 'Plan the launch'));
    const reserved = async () => withTenant(fixture.companyId, (tx) => tx.query<{ tokens_reserved: string }>(
      'SELECT tokens_reserved::text FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId])).then((result) => result.rows[0]!.tokens_reserved);
    const before = await reserved();

    const asked = { ...work(fixture, 'Price the new catalogue'), createdBy: 'staff' as const, requestedBySeat: budi.id };
    const notReady = refused('staff.not_ready', /not switched on/);
    await assert.rejects(createRootTask(asked), notReady);
    await assert.rejects(assignTask(asked), notReady);
    await assert.rejects(withTenant(fixture.companyId, (tx) => createRootTaskWithin(tx, asked)), notReady);
    // The owner pressing a seat's words is staff work too, with no seat that pressed.
    await assert.rejects(createRootTask({ ...work(fixture, 'Price the new catalogue'), createdBy: 'staff' }), notReady);
    await assert.rejects(createSubTask(parent.id, { ...work(fixture, 'Draft the price list'), createdBy: 'staff' }), notReady);

    const made = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>('SELECT id FROM tasks'));
    assert.deepEqual(made.rows.map((row) => row.id), [parent.id], 'no task was made');
    assert.equal(await reserved(), before, 'and nothing was reserved for one');
    assert.deepEqual(await events(fixture, ['wake.queued']), [], 'nor any role woken');

    await assert.rejects(
      instructTask(fixture.companyId, parent.id, 'Lead with the bundles.', { kind: 'seat', seatId: budi.id, name: 'Budi' }), notReady);
    assert.deepEqual(await events(fixture, INSTRUCTED, parent.id), []);
    // The owner's own work and words are as they were.
    await instructTask(fixture.companyId, parent.id, 'Lead with the bundles.', { kind: 'owner' });
    assert.deepEqual((await events(fixture, INSTRUCTED, parent.id)).map((event) => [event.type, event.actor]), [['owner.instructed', 'owner']]);
  });
