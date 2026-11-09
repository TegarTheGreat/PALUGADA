/**
 * What waits for a person in the rooms, and what they have read (F19.10;
 * STATUS section 2.206).
 *
 * Unread is what others wrote in a room after the reader's own mark, never
 * a card and never the reader's own words; a mention is counted apart, and a
 * muted room hides its unread but not its mentions. Replies raise attention
 * only for the thread's followers who can still see it, and a person's
 * Activity lists what is addressed to them: mentions, replies, questions put
 * to them, the team's cards they may decide, and the work they asked for that
 * ended. A read mark is the person's own, only moves forward, and never
 * passes the company's clock.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { syncRoomCards } from '../../src/workspace/cards.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
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

async function workspace(slug: string): Promise<{ fixture: Fixture; api: Console; owner: PersonIn }> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings();
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner };
}

type Listed = { id: string; kind: string; unread: number; mentions: number; lastPosition: number };

async function listed(person: PersonIn, roomId: string): Promise<Listed> {
  const found = (ok(await person.rooms()).rooms as Listed[]).find((room) => room.id === roomId);
  assert.ok(found, `room ${roomId} is in the list`);
  return found;
}

/** The position of the newest message in a room's page, as the console marks read up to it. */
async function newest(person: PersonIn, roomId: string): Promise<number> {
  const page = ok(await person.page(roomId)).messages as Array<{ position: number }>;
  return Math.max(...page.map((message) => message.position));
}

/** A platform notice in the room, as the doors write one: a card the reader is never counted for. */
async function notice(fixture: Fixture, roomId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, fixture.companyId);
    await tx.query(
      `INSERT INTO room_messages (company_id, room_id, kind, author, via, notice_code, position)
       VALUES ($1, $2, 'notice', 'platform', 'platform', 'recorded', 0)`, [fixture.companyId, roomId]);
  });
}

test("unread counts what others wrote after the reader's mark, and cards and the reader's own words do not", async () => {
  const { fixture, api, owner } = await workspace('reads-unread');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budi);
    const first = await said(budi, room, 'The van is late.');
    await said(budi, room, 'It is here now.');
    await said(owner, room, 'Thanks.');
    await notice(fixture, room);
    await said(budi, room, { body: 'Only in the thread.', threadOf: first });
    const gone = await said(budi, room, 'Wrong room.');
    ok(await budi.on(room, gone, 'delete'));
    assert.equal((await listed(owner, room)).unread, 2, "two of Budi's at the top; not the owner's, the card, the reply or the removed");
    assert.equal((await listed(budi, room)).unread, 1, "the owner's one for Budi");
    await said(budi, room, { body: 'Shared back to the room.', threadOf: first, alsoInRoom: true });
    assert.equal((await listed(owner, room)).unread, 3);

    ok(await owner.read(room, { position: await newest(owner, room) }));
    assert.equal((await listed(owner, room)).unread, 0);
    const across = ok(await api.call('GET', '/api/rooms/unread', owner.token)).unread as Array<Record<string, unknown>>;
    assert.deepEqual(across.map((one) => [one.companyId, one.rooms, one.direct, one.mentions]), [[fixture.companyId, 0, 0, 0]]);
    assert.equal(typeof across[0]!.openCount, 'number', "the owner's open items beside them");
    const seatAcross = ok(await api.call('GET', '/api/rooms/unread', budi.token)).unread as Array<Record<string, unknown>>;
    assert.deepEqual(seatAcross.map((one) => [one.rooms, one.openCount]), [[1, null]], "a seat's own, and no count of the owner's");
  } finally {
    await api.close();
  }
});

test('a mention is counted apart, and survives mute', async () => {
  const { fixture, api, owner } = await workspace('reads-mention');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budi);
    ok(await owner.settings(room, { mutedUntil: new Date(Date.now() + 3_600_000).toISOString() }));
    await said(budi, room, 'Just saying.');
    await said(budi, room, { body: '@owner can you sign this?', mentions: ['owner'] });
    const seen = await listed(owner, room);
    assert.deepEqual([seen.unread, seen.mentions], [0, 1]);
    const across = ok(await api.call('GET', '/api/rooms/unread', owner.token)).unread[0];
    assert.deepEqual([across.mentions, across.rooms], [1, 0]);
    const direct = String(ok(await budi.direct(['owner'])).room.id);
    await said(budi, direct, 'A word in private.');
    assert.equal(ok(await api.call('GET', '/api/rooms/unread', owner.token)).unread[0].direct, 1, 'a direct message is what the badge counts');
  } finally {
    await api.close();
  }
});

test('a muted room counts no unread until its mute ends', async () => {
  const { fixture, api, owner } = await workspace('reads-mute');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budi);
    const muted = ok(await owner.settings(room, { mutedUntil: new Date(Date.now() + 3_600_000).toISOString(), notify: 'all' }));
    assert.equal(muted.notify, 'all');
    await said(budi, room, 'Lunch is here.');
    assert.equal((await listed(owner, room)).unread, 0);
    ok(await owner.settings(room, { mutedUntil: new Date(Date.now() - 1_000).toISOString() }));
    assert.equal((await listed(owner, room)).unread, 1, 'a mute that has ended hides nothing');
    refusedWith(await owner.settings(room, { notify: 'loud' }), 400, 'contract.violation');
    // A place is a person's own: nobody reads a colleague's mute.
    const members = ok(await budi.room(room)).room.members as Array<Record<string, unknown>>;
    assert.ok(members.every((member) => !('mutedUntil' in member) && !('readPosition' in member)));
  } finally {
    await api.close();
  }
});

test('replying follows a thread, and its replies raise attention for followers who can see it', async () => {
  const { fixture, api, owner } = await workspace('reads-follow');
  try {
    const budiSeat = await seated(fixture, 'Budi', 'member');
    const sariSeat = await seated(fixture, 'Sari', 'member');
    const budi = personIn(api, budiSeat.token, fixture.companyId);
    const sari = personIn(api, sariSeat.token, fixture.companyId);
    const room = String(ok(await owner.makeRoom({ name: 'Orders', private: true, members: [budiSeat.principal, sariSeat.principal] })).room.id);
    const root = await said(owner, room, 'Who takes the Bandung order?');
    await said(budi, room, { body: 'Me.', threadOf: root });
    assert.equal(ok(await budi.thread(room, root)).following, true, 'replying follows');
    const unread = (await listed(budi, room)).unread;
    const reply = await said(sari, room, { body: 'I can help.', threadOf: root });
    const owed = await withControlPlane((tx) => tx.query<{ principal: string; reason: string }>(
      'SELECT principal, reason FROM room_mentions WHERE message_id = $1 ORDER BY principal', [reply]));
    assert.deepEqual(owed.rows.map((row) => [row.principal, row.reason]).sort(),
      [['owner', 'reply'], [budiSeat.principal, 'reply']].sort());
    assert.equal((await listed(budi, room)).unread, unread, 'a reply makes no room unread');

    ok(await budi.post(`/rooms/${room}/threads/${root}/follow`, { on: false }));
    assert.equal(ok(await budi.thread(room, root)).following, false);
    ok(await owner.members(room, { remove: [sariSeat.principal] }));
    const later = await said(owner, room, { body: 'Done, thanks.', threadOf: root });
    const after = await withControlPlane((tx) => tx.query<{ principal: string }>(
      'SELECT principal FROM room_mentions WHERE message_id = $1', [later]));
    assert.deepEqual(after.rows, [], 'not who stopped following, nor who can no longer see it');
  } finally {
    await api.close();
  }
});

test('marking read never moves back and never passes the clock', async () => {
  const { fixture, api, owner } = await workspace('reads-mark');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budi);
    await said(budi, room, { body: '@owner first', mentions: ['owner'] });
    const at = await newest(owner, room);
    await said(budi, room, { body: '@owner second', mentions: ['owner'] });
    assert.equal(ok(await owner.read(room, { position: at })).readPosition, at);
    assert.equal((await listed(owner, room)).mentions, 1, 'the mention up to the mark is seen, the later one not');
    assert.equal(ok(await owner.read(room, { position: at - 1 })).readPosition, at, 'never back');
    refusedWith(await owner.read(room, { position: at + 1_000 }), 400, 'contract.violation', 'never past the clock');
    assert.equal(ok(await owner.page(room)).readPosition, at);
    refusedWith(await owner.read(room, { position: -1 }), 400, 'contract.violation');
    const notAnId = await owner.read(room, { position: at, threadOf: 'not-a-message' });
    refusedWith(notAnId, 400, 'contract.violation', 'a thread is named by its message');
    assert.doesNotMatch(notAnId.body.error, /uuid|syntax/, "the database's words are not the owner's");
    const sideRoom = String(ok(await budi.makeRoom({ name: 'Side', private: false })).room.id);
    assert.equal(ok(await owner.read(sideRoom, { position: at })).readPosition, 0, "a place is a member's: a room not joined keeps no mark");
    assert.equal((ok(await owner.rooms()).rooms as Listed[]).some((one) => one.id === sideRoom), false, 'and reading it joins nothing');
  } finally {
    await api.close();
  }
});

test('a person mentioned in a room they have not joined marks it seen there, without joining it', async () => {
  const { fixture, api, owner } = await workspace('reads-not-joined');
  try {
    const seat = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const budi = personIn(api, seat.token, fixture.companyId);
    await companyRoomOf(budi);
    const division = (ok(await owner.rooms(true)).rooms as Array<{ id: string; kind: string; joined: boolean }>)
      .find((one) => one.kind === 'division')!;
    if (!division.joined) ok(await owner.join(division.id));
    const root = await said(owner, division.id, { body: '@budi the stock count is off', mentions: [seat.principal] });
    const reply = ok(await owner.say(division.id, { body: '@budi start with the back room', mentions: [seat.principal], threadOf: root })).message;
    const later = await said(owner, division.id, { body: '@budi and the till', mentions: [seat.principal] });
    const badge = async () => (ok(await api.call('GET', '/api/rooms/unread', seat.token)).unread as Array<{ mentions: number }>)[0]!.mentions;
    assert.equal(await badge(), 3, 'every mention is his, though the room is not in his rail');
    assert.equal((ok(await budi.rooms()).rooms as Listed[]).some((one) => one.id === division.id), false);

    // Read in the thread, then in the room, as the console marks them.
    assert.equal(ok(await budi.read(division.id, { position: reply.position, threadOf: root })).readPosition, 0);
    assert.equal(await badge(), 1, "the thread's mentions are seen, the room's later one not");
    const laterAt = (ok(await budi.page(division.id)).messages as Array<{ id: string; position: number }>).find((one) => one.id === later)!.position;
    assert.equal(ok(await budi.read(division.id, { position: laterAt })).readPosition, 0, 'no mark is kept in a room he is not in');
    assert.equal(await badge(), 0, "the room's is seen too");
    const activity = ok(await budi.activity()).items as Array<{ kind: string; seen?: boolean }>;
    assert.deepEqual(activity.filter((one) => one.kind === 'mention').map((one) => one.seen), [true, true, true]);
    assert.equal((ok(await budi.rooms()).rooms as Listed[]).some((one) => one.id === division.id), false, 'and he has not joined it');
    void fixture;
  } finally {
    await api.close();
  }
});

/** An approval for staff work at tier 2, raised by its run: the team's card. */
async function teamApproval(fixture: Fixture, seatId: string, goal: string): Promise<{ taskId: string; itemId: string }> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal }, createdBy: 'staff', requestedBySeat: seatId, reserveTokens: 100,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'social.publish' }]);
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'social.publish', tier: 2,
    actionSummary: goal, rationale: 'the post is ready', consequenceIfDenied: 'it is not posted', instigators: [seatId],
  });
  return { taskId: task.id, itemId };
}

test('Activity lists mentions, followed replies, questions for you, approvals you may decide and your work done', async () => {
  const { fixture, api, owner } = await workspace('reads-activity');
  try {
    const budiSeat = await seated(fixture, 'Budi', 'approver', { handle: 'budi' });
    const sariSeat = await seated(fixture, 'Sari', 'member');
    const budi = personIn(api, budiSeat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budi);
    const mention = await said(owner, room, { body: '@budi have a look', mentions: [budiSeat.principal] });
    const root = await said(budi, room, 'Stock count tomorrow.');
    const reply = await said(owner, room, { body: 'I will be there.', threadOf: root });
    const asked = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'Count the stock' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, asked.id, 'running');
    const question = await inbox.askOwner({
      companyId: fixture.companyId, taskId: asked.id, question: 'Which warehouse first?',
      addressee: { seatId: budiSeat.id, name: 'Budi', escalateAfterHours: 24 },
    });
    const team = await teamApproval(fixture, sariSeat.id, 'Post the stock count');
    const own = await teamApproval(fixture, budiSeat.id, 'Post the launch');
    const mine = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'Tidy the shelves' }, createdBy: 'staff', requestedBySeat: budiSeat.id, reserveTokens: 100,
    });
    await transition(fixture.companyId, mine.id, 'running');
    await transition(fixture.companyId, mine.id, 'completed');

    const items = ok(await budi.activity()).items as Array<Record<string, unknown>>;
    const kinds = items.map((item) => item.kind);
    assert.ok(items.some((item) => item.kind === 'mention' && item.messageId === mention && item.roomId === room && item.seen === false));
    assert.ok(items.some((item) => item.kind === 'reply' && item.messageId === reply));
    assert.ok(items.some((item) => item.kind === 'question' && item.itemId === question.inboxItemId && item.taskId === asked.id));
    assert.ok(items.some((item) => item.kind === 'team_item' && item.itemId === team.itemId));
    assert.ok(!items.some((item) => item.itemId === own.itemId), 'not a card Budi\'s own words are in');
    assert.ok(items.some((item) => item.kind === 'work_done' && item.taskId === mine.id && item.state === 'completed'));
    const times = items.map((item) => String(item.at));
    assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
    assert.ok(kinds.length >= 5);

    // The owner's own: the questions that are theirs, none of the team's cards that are with an approver.
    const owners = ok(await owner.activity()).items as Array<Record<string, unknown>>;
    assert.ok(!owners.some((item) => item.kind === 'team_item'));
    // And the badge beside the rooms counts the owner's open items as the
    // inbox does: Sari's card is still with Budi and is not counted; Budi's
    // own, which nobody else can decide, reached the owner as one day.
    const queue = await inbox.ownerInbox(fixture.companyId);
    assert.deepEqual(queue.team.map((entry) => [entry.day === null, entry.items.map((one) => one.id)]).sort(),
      [[false, [own.itemId]], [true, [team.itemId]]]);
    const across = ok(await api.call('GET', '/api/rooms/unread', owner.token)).unread[0];
    assert.equal(across.openCount, queue.items.length + 1);
  } finally {
    await api.close();
  }
});

test('an approver who cannot see the room is told of the approval in Activity without the room', async () => {
  const { fixture, api, owner } = await workspace('reads-unseen-room');
  try {
    const budiSeat = await seated(fixture, 'Budi', 'approver');
    const sariSeat = await seated(fixture, 'Sari', 'member');
    const sari = personIn(api, sariSeat.token, fixture.companyId);
    const room = String(ok(await sari.makeRoom({ name: 'Ideas', private: true })).room.id);
    const message = await said(sari, room, 'Post the summer menu on Instagram.');
    const given = ok(await sari.on(room, message, 'work', { target: fixture.roleId, goal: 'Post the summer menu', goalId: fixture.goalId }));
    await planTask(fixture.companyId, given.taskId, [{ capability: 'social.publish' }]);
    await transition(fixture.companyId, given.taskId, 'running');
    const itemId = await inbox.requestApproval({
      companyId: fixture.companyId, taskId: given.taskId, capabilityName: 'social.publish', tier: 2,
      actionSummary: 'social.publish: the summer menu', rationale: 'the post is drafted', consequenceIfDenied: 'it is not posted',
      instigators: [sariSeat.id],
    });
    await syncRoomCards(fixture.companyId);

    const budi = personIn(api, budiSeat.token, fixture.companyId);
    const items = ok(await budi.activity()).items as Array<Record<string, unknown>>;
    const told = items.find((item) => item.itemId === itemId);
    assert.ok(told, JSON.stringify(items));
    assert.deepEqual(Object.keys(told).sort(), ['at', 'itemId', 'kind', 'taskId'], 'no room, no message');
    assert.equal(told.kind, 'team_item');
    const mentions = await withControlPlane((tx) => tx.query(
      'SELECT 1 FROM room_mentions WHERE principal = $1', [budiSeat.principal]));
    assert.equal(mentions.rowCount, 0, 'no room attention for someone who cannot see the room');
    refusedWith(await budi.room(room), 404, 'room.not_visible');
    void owner;
    void randomUUID;
  } finally {
    await api.close();
  }
});

test('a newcomer to the company room has no backlog', async () => {
  const { fixture, api, owner } = await workspace('reads-newcomer');
  try {
    const room = await companyRoomOf(owner);
    for (const words of ['Welcome.', 'Prices change on Monday.', 'Remember the stock count.']) await said(owner, room, words);
    const newcomer = personIn(api, (await seated(fixture, 'Nadia', 'viewer')).token, fixture.companyId);
    assert.equal(await companyRoomOf(newcomer), room);
    assert.equal((await listed(newcomer, room)).unread, 0);
    const page = ok(await newcomer.page(room));
    assert.equal(page.messages.length, 3, 'the history is there to read');
    assert.ok(page.readPosition >= Math.max(...page.messages.map((one: { position: number }) => one.position)));
  } finally {
    await api.close();
  }
});
