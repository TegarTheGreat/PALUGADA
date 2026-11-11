/**
 * Agents appear in rooms only as cards the platform draws from rows (F19.5,
 * F19.16; STATUS section 2.206).
 *
 * The card sweep, a stage of the worker, posts a card where a room should
 * show work: a question or an approval in the thread of the message the work
 * was asked from, and in a division's room what needs a person when the room
 * shows it. It reconciles from state, so an item whose event it missed still
 * gets its card, and a second pass writes nothing. A card holds no words: what
 * it says is read from the task and the item when it is shown, redacted, and
 * a tier 3 approval is never a button. A reaction is never a decision.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { redactor } from '../../src/secrets/manager.ts';
import { syncRoomCards } from '../../src/workspace/cards.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import {
  companyRoomOf, ok, personIn, refusedWith, said, seated, type Console, type PersonIn, type Seat,
} from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function workspace(slug: string): Promise<{ fixture: Fixture; api: Console; owner: PersonIn }> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings();
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner };
}

/** Work asked in the company room by `person`, running. */
async function askedHere(fixture: Fixture, person: PersonIn, goal: string): Promise<{ room: string; message: string; taskId: string }> {
  const room = await companyRoomOf(person);
  const message = await said(person, room, goal);
  const taskId = String(ok(await person.on(room, message, 'work', { target: fixture.roleId, goal, goalId: fixture.goalId })).taskId);
  await transition(fixture.companyId, taskId, 'running');
  return { room, message, taskId };
}

/** Work the owner gave the division outside any room. */
async function divisionWork(fixture: Fixture, goal: string): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

async function approvalFor(fixture: Fixture, taskId: string, tier: 2 | 3, summary: string): Promise<string> {
  await planTask(fixture.companyId, taskId, [{ capability: 'social.publish' }]);
  return inbox.requestApproval({
    companyId: fixture.companyId, taskId, capabilityName: 'social.publish', tier,
    actionSummary: summary, rationale: 'it is ready', consequenceIfDenied: 'it is not published',
  });
}

type CardRow = { id: string; room_id: string; thread_of: string | null; kind: string; body: string | null; task_id: string | null; inbox_item_id: string | null; notice_values: Record<string, unknown> | null };

const cards = (fixture: Fixture) => withControlPlane((tx) => tx.query<CardRow>(
  `SELECT id, room_id, thread_of, kind, body, task_id, inbox_item_id, notice_values FROM room_messages
    WHERE company_id = $1 AND author = 'platform' AND kind <> 'notice' ORDER BY position`, [fixture.companyId])).then((result) => result.rows);

const counts = (fixture: Fixture) => withControlPlane((tx) => tx.query<{ messages: number; feed: number; mentions: number }>(
  `SELECT (SELECT count(*)::int FROM room_messages WHERE company_id = $1) AS messages,
          (SELECT count(*)::int FROM room_feed WHERE company_id = $1) AS feed,
          (SELECT count(*)::int FROM room_mentions WHERE company_id = $1) AS mentions`, [fixture.companyId])).then((result) => result.rows[0]!);

async function divisionRoom(owner: PersonIn): Promise<string> {
  const found = (ok(await owner.rooms(true)).rooms as Array<{ id: string; kind: string }>).find((room) => room.kind === 'division');
  return found!.id;
}

test('work given in a room shows its state on the asking message, and a second sweep writes nothing', async () => {
  const { fixture, api, owner } = await workspace('cards-state');
  try {
    const { room, message, taskId } = await askedHere(fixture, owner, 'Send the invoices for October.');
    await syncRoomCards(fixture.companyId);
    const feed = await withControlPlane((tx) => tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM room_feed WHERE company_id = $1 AND kind = 'card' AND ref = $2", [fixture.companyId, message]));
    assert.ok(feed.rows[0]!.n >= 1, 'the asking message is drawn again when its work moves');
    assert.deepEqual(await cards(fixture), [], 'its state is on the message itself, not a card of its own');
    const before = await counts(fixture);
    await syncRoomCards(fixture.companyId);
    assert.deepEqual(await counts(fixture), before, 'a second pass writes nothing');
    const shown = ok(await owner.page(room)).messages[0];
    assert.deepEqual([shown.card.state, shown.card.may.stop, shown.card.may.tell], ['running', true, true]);
    await transition(fixture.companyId, taskId, 'completed', { output: { summary: 'Sent twelve invoices.' } });
    await syncRoomCards(fixture.companyId);
    const done = ok(await owner.page(room)).messages[0];
    assert.deepEqual([done.card.state, done.card.result, done.card.may.stop], ['completed', 'Sent twelve invoices.', false]);
  } finally {
    await api.close();
  }
});

test("a question a sub-task of the work asks shows in the work's thread", async () => {
  const { fixture, api, owner } = await workspace('cards-subtask');
  try {
    const seat = await seated(fixture, 'Budi', 'member');
    const budi = personIn(api, seat.token, fixture.companyId);
    const { room, message, taskId } = await askedHere(fixture, budi, 'Plan the summer sale.');
    const sub = await createSubTask(taskId, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      input: { goal: 'Pick the discounted items' }, reserveTokens: 50,
    });
    await transition(fixture.companyId, sub.id, 'running');
    const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: sub.id, question: 'Is 20% off too much?', options: ['Yes', 'No'] });
    await syncRoomCards(fixture.companyId);
    const [card] = await cards(fixture);
    assert.deepEqual([card!.kind, card!.room_id, card!.thread_of, card!.inbox_item_id, card!.body],
      ['question', room, message, asked.inboxItemId, null]);
    const thread = ok(await budi.thread(room, message));
    const shown = thread.replies.find((one: { id: string }) => one.id === card!.id);
    assert.deepEqual([shown.kind, shown.card.question.text, shown.card.question.options, shown.card.may.answer],
      ['question', 'Is 20% off too much?', ['Yes', 'No'], false], 'a member answers only what is put to it');
    assert.equal(ok(await owner.thread(room, message)).replies[0].card.may.answer, true);
    // The person who asked for the work is told. They follow its thread, so
    // the card reaches them as the thread's news; the card's own attention
    // goes to whoever does not follow it.
    const owed = await withControlPlane((tx) => tx.query<{ principal: string }>(
      'SELECT principal FROM room_mentions WHERE message_id = $1', [card!.id]));
    assert.deepEqual(owed.rows, [{ principal: seat.principal }], 'the person who asked for the work is told, once');
    const told = (ok(await budi.activity()).items as Array<Record<string, unknown>>).find((item) => item.messageId === card!.id);
    assert.deepEqual([told?.roomId, told?.threadOf], [room, message], "Activity names the work's thread, where the card is");
  } finally {
    await api.close();
  }
});

test('a question put to a person goes to their Activity and not into a division room', async () => {
  const { fixture, api, owner } = await workspace('cards-addressed');
  try {
    const seat = await seated(fixture, 'Budi', 'approver');
    const taskId = await divisionWork(fixture, 'Check the stock levels');
    const asked = await inbox.askOwner({
      companyId: fixture.companyId, taskId, question: 'Which shelf is short?',
      addressee: { seatId: seat.id, name: 'Budi', escalateAfterHours: 24 },
    });
    await syncRoomCards(fixture.companyId);
    assert.deepEqual(await cards(fixture), [], 'nothing in the division room');
    const items = ok(await personIn(api, seat.token, fixture.companyId).activity()).items as Array<Record<string, unknown>>;
    assert.ok(items.some((item) => item.kind === 'question' && item.itemId === asked.inboxItemId));
    void owner;
  } finally {
    await api.close();
  }
});

test('a division room that shows what needs people shows unaddressed questions and tier 2 approvals only', async () => {
  const { fixture, api, owner } = await workspace('cards-division');
  try {
    const seat = await seated(fixture, 'Budi', 'approver');
    const room = await divisionRoom(owner);
    const asking = await divisionWork(fixture, 'Order packaging');
    const question = await inbox.askOwner({ companyId: fixture.companyId, taskId: asking, question: 'Brown or white boxes?' });
    const two = await approvalFor(fixture, await divisionWork(fixture, 'Post the offer'), 2, 'social.publish: the offer');
    await approvalFor(fixture, await divisionWork(fixture, 'Post the apology'), 3, 'social.publish: the apology');
    const addressed = await divisionWork(fixture, 'Count the boxes');
    await inbox.askOwner({ companyId: fixture.companyId, taskId: addressed, question: 'How many?', addressee: { seatId: seat.id, name: 'Budi', escalateAfterHours: 24 } });
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'The printer is down', detail: 'it answers 503' });
    await syncRoomCards(fixture.companyId);
    const posted = await cards(fixture);
    assert.deepEqual(posted.map((card) => [card.kind, card.room_id, card.thread_of, card.inbox_item_id]).sort(), [
      ['approval', room, null, two], ['question', room, null, question.inboxItemId],
    ].sort());
    const page = ok(await owner.page(room)).messages as Array<{ kind: string; card: { approval: { tier: number } | null } }>;
    assert.equal(page.find((one) => one.kind === 'approval')!.card.approval!.tier, 2);
  } finally {
    await api.close();
  }
});

test('routine work reaches no room but a division\'s told to show all its work, which a member cannot tell it', async () => {
  const { fixture, api, owner } = await workspace('cards-routine');
  try {
    const first = await divisionWork(fixture, 'Back up the books');
    await transition(fixture.companyId, first, 'completed', { output: { summary: 'Backed up.' } });
    await syncRoomCards(fixture.companyId);
    assert.deepEqual(await cards(fixture), []);
    // Unless the owner has the division's room show all of its work.
    const room = await divisionRoom(owner);
    ok(await owner.post(`/rooms/${room}`, { showsWork: 'all' }));
    const seat = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    refusedWith(await seat.post(`/rooms/${room}`, { showsWork: 'needs_people' }), 403, 'room.not_creator');
    const second = await divisionWork(fixture, 'Back up the mail');
    await syncRoomCards(fixture.companyId);
    assert.deepEqual((await cards(fixture)).map((card) => [card.kind, card.task_id]), [['work', second]]);
  } finally {
    await api.close();
  }
});

test('a division room that shows all its work shows what was given since it was told to, however long ago that was', async () => {
  const { fixture, api, owner } = await workspace('cards-all-since');
  try {
    const room = await divisionRoom(owner);
    // The room was made weeks ago, and the division was given work since.
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query("UPDATE rooms SET created_at = now() - interval '20 days' WHERE id = $1", [room]);
    });
    const earlier = await divisionWork(fixture, 'Back up the books');
    await withControlPlane((tx) => tx.query("UPDATE tasks SET created_at = now() - interval '3 days' WHERE id = $1", [earlier]));
    await syncRoomCards(fixture.companyId);
    ok(await owner.post(`/rooms/${room}`, { showsWork: 'all' }));
    const since = await divisionWork(fixture, 'Back up the mail');
    // What the room is about has nothing to do with which work it shows.
    ok(await owner.post(`/rooms/${room}`, { about: 'Where the books are kept.' }));
    await syncRoomCards(fixture.companyId);
    assert.deepEqual((await cards(fixture)).map((card) => [card.kind, card.task_id]), [['work', since]]);

    // The room's feed is bookkeeping, purged after two weeks; when the room
    // was told to show all of its work is not, and older work stays out.
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query('DELETE FROM room_feed WHERE company_id = $1 AND room_id = $2', [fixture.companyId, room]);
    });
    const later = await divisionWork(fixture, 'Back up the photos');
    await syncRoomCards(fixture.companyId);
    await syncRoomCards(fixture.companyId);
    assert.deepEqual((await cards(fixture)).map((card) => [card.kind, card.task_id]), [['work', since], ['work', later]]);

    // Told to show only what needs people, and then all again, it starts again from then.
    ok(await owner.post(`/rooms/${room}`, { showsWork: 'needs_people' }));
    const between = await divisionWork(fixture, 'Back up the invoices');
    ok(await owner.post(`/rooms/${room}`, { showsWork: 'all' }));
    await syncRoomCards(fixture.companyId);
    assert.ok(!(await cards(fixture)).some((card) => card.task_id === between), 'work given while the room showed less stays out');
  } finally {
    await api.close();
  }
});

test('a page of cards read by more people at once than the database lends connections answers every one of them', async () => {
  const { fixture, api, owner } = await workspace('cards-many-readers');
  try {
    const room = await companyRoomOf(owner);
    // More readers than the application's pool holds connections (ten).
    const readers: Array<{ seat: Seat; person: PersonIn }> = [];
    for (let n = 0; n < 12; n += 1) {
      const seat = await seated(fixture, `Reader ${n}`, 'member');
      const person = personIn(api, seat.token, fixture.companyId);
      await companyRoomOf(person);
      readers.push({ seat, person });
    }
    const asked: string[] = [];
    for (const goal of ['Count the chairs.', 'Count the tables.', 'Count the lamps.']) asked.push((await askedHere(fixture, owner, goal)).taskId);
    // The first work holds a question put to the first reader: what its runs
    // said is that reader's and the owner's to read, and no other seat's.
    await inbox.askOwner({
      companyId: fixture.companyId, taskId: asked[0]!, question: 'Which room first?',
      addressee: { seatId: readers[0]!.seat.id, name: 'Reader 0', escalateAfterHours: 24 },
    });
    // Asked, the first waits; it runs on once answered, and then all three are done.
    await transition(fixture.companyId, asked[0]!, 'running');
    for (const taskId of asked) await transition(fixture.companyId, taskId, 'completed', { output: { summary: 'Counted.' } });

    const pages = await Promise.all(readers.map((reader) => reader.person.page(room)));
    assert.deepEqual(pages.map((page) => page.status), readers.map(() => 200),
      JSON.stringify(pages.find((page) => page.status !== 200)?.body ?? null));
    for (const [n, page] of pages.entries()) {
      const shown = (page.body.messages as Array<{ card: { taskId: string; result: string | null } | null }>)
        .filter((one) => one.card !== null).map((one) => [one.card!.taskId, one.card!.result]);
      assert.deepEqual(shown, asked.map((taskId, at) => [taskId, at === 0 && n !== 0 ? null : 'Counted.']), `reader ${n}`);
    }
    const owners = (ok(await owner.page(room)).messages as Array<{ card: { result: string | null } | null }>).map((one) => one.card?.result);
    assert.deepEqual(owners, ['Counted.', 'Counted.', 'Counted.'], 'the owner reads every one');
  } finally {
    await api.close();
  }
});

test('a tier 3 approval in a room is a link to the inbox, never a button', async () => {
  const { fixture, api, owner } = await workspace('cards-tier3');
  try {
    const approver = personIn(api, (await seated(fixture, 'Budi', 'approver')).token, fixture.companyId);
    const { room, message, taskId } = await askedHere(fixture, owner, 'Delete the old customer records.');
    await approvalFor(fixture, taskId, 3, 'record.delete: 400 customers');
    await syncRoomCards(fixture.companyId);
    await companyRoomOf(approver);
    for (const person of [owner, approver]) {
      const card = ok(await person.thread(room, message)).replies.find((one: { kind: string }) => one.kind === 'approval').card;
      assert.deepEqual([card.approval.tier, card.may.decide, card.inInbox], [3, false, true]);
    }
  } finally {
    await api.close();
  }
});

test('an approval decided in the inbox shows decided on its card within one tick', async () => {
  const { fixture, api, owner } = await workspace('cards-decided');
  try {
    const { room, message, taskId } = await askedHere(fixture, owner, 'Post the new menu.');
    const itemId = await approvalFor(fixture, taskId, 2, 'social.publish: the new menu');
    await syncRoomCards(fixture.companyId);
    const card = (await cards(fixture))[0]!;
    assert.equal(card.notice_values?.state, 'open');
    ok(await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`, owner.token, { decision: 'approve' }));
    await syncRoomCards(fixture.companyId);
    const after = (await cards(fixture))[0]!;
    assert.equal(after.notice_values?.state, 'approved');
    const shown = ok(await owner.thread(room, message)).replies.find((one: { id: string }) => one.id === card.id);
    assert.deepEqual([shown.card.state, shown.card.may.decide], ['approved', false]);
    const drawn = await withControlPlane((tx) => tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM room_feed WHERE company_id = $1 AND kind = 'card' AND ref = $2", [fixture.companyId, card.id]));
    assert.ok(drawn.rows[0]!.n >= 1, 'open rooms are told to draw it again');
  } finally {
    await api.close();
  }
});

test('an item whose event committed behind the cursor still gets its card', async () => {
  const { fixture, api, owner } = await workspace('cards-behind');
  try {
    await syncRoomCards(fixture.companyId);
    const taskId = await divisionWork(fixture, 'Renew the insurance');
    const itemId = await approvalFor(fixture, taskId, 2, 'payment.send: the insurance');
    // The cursor already past the item's event, as when a slow transaction commits behind it.
    await withControlPlane((tx) => tx.query(
      "UPDATE room_clock SET cards_through = now() + interval '1 hour' WHERE company_id = $1", [fixture.companyId]));
    await syncRoomCards(fixture.companyId);
    assert.deepEqual((await cards(fixture)).map((card) => card.inbox_item_id), [itemId]);
    void owner;
    void api;
  } finally {
    await api.close();
  }
});

test('a card holds no words; the result is read from the task when shown, redacted', async () => {
  const { fixture, api, owner } = await workspace('cards-no-words');
  try {
    redactor.register('sk-live-0123456789abcdef');
    const { room, message, taskId } = await askedHere(fixture, owner, 'Set up the payment link.');
    await approvalFor(fixture, taskId, 2, 'social.publish: the link');
    await syncRoomCards(fixture.companyId);
    assert.ok((await cards(fixture)).every((card) => card.body === null));
    await transition(fixture.companyId, taskId, 'running');
    // What it wrote for a person to read, committed in its journal.
    await withTenant(fixture.companyId, (tx) => tx.query(
      `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
       VALUES ($1, 1, $2, 'capability:document.write', 'tool', 'committed', 'h', 'k1', $3, now())`,
      [taskId, fixture.companyId, JSON.stringify({ path: 'drafts/link.md', text: '# Payment link sk-live-0123456789abcdef\n\nIt is ready.' })]));
    await transition(fixture.companyId, taskId, 'completed', { output: { summary: 'Made the link with key sk-live-0123456789abcdef.' } });
    const shown = ok(await owner.page(room)).messages.find((one: { id: string }) => one.id === message);
    assert.equal(shown.card.result, 'Made the link with key [redacted].');
    assert.deepEqual(shown.card.deliverables, [{ id: '1', title: 'Payment link [redacted]' }]);
    const stored = JSON.stringify((await withControlPlane((tx) => tx.query(
      'SELECT body, notice_values FROM room_messages WHERE company_id = $1', [fixture.companyId]))).rows);
    assert.ok(!stored.includes('Made the link'), 'the result lives on the task, not in the room');
  } finally {
    await api.close();
  }
});

test('no reaction is ever read as a decision', async () => {
  const { fixture, api, owner } = await workspace('cards-reaction');
  try {
    const approver = personIn(api, (await seated(fixture, 'Budi', 'approver')).token, fixture.companyId);
    const { room, message, taskId } = await askedHere(fixture, owner, 'Email every customer the new prices.');
    const itemId = await approvalFor(fixture, taskId, 2, 'email.send: every customer');
    await syncRoomCards(fixture.companyId);
    await companyRoomOf(approver);
    const card = (await cards(fixture))[0]!;
    refusedWith(await approver.on(room, card.id, 'react', { emoji: '👍', on: true }), 400, 'contract.violation');
    ok(await approver.on(room, message, 'react', { emoji: '👍', on: true }));
    ok(await owner.on(room, message, 'react', { emoji: '✅', on: true }));
    await syncRoomCards(fixture.companyId);
    const item = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>('SELECT status FROM inbox_items WHERE id = $1', [itemId]));
    assert.equal(item.rows[0]!.status, 'open');
  } finally {
    await api.close();
  }
});
