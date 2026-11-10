/**
 * The rooms, as people use them (F19.1, F19.3, F19.4, F19.5, F19.6, F19.7,
 * F19.10; STATUS section 2.206).
 *
 * A company's workspace is its rooms: one company room everyone is in, a room
 * per division, topic rooms open or private, and direct messages between two
 * to eight people. The owner and the staff the owner seated talk there, in
 * their own names only, and see only the rooms they may see. Every case is
 * pressed through the owner API as the console presses it, so the routes, the
 * staff lists and the database's own rules are all in the way of a mistake.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withPeople, withTenant } from '../../src/db/tenant.ts';
import { metricsText } from '../../src/reporting/metrics.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
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

/** A company, its console, and the owner signed in to it. */
async function workspace(slug: string): Promise<{ fixture: Fixture; api: Console; owner: PersonIn }> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings();
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner };
}

/** A topic room, open or private, made by `by` with `members`. */
async function topic(by: PersonIn, name: string, isPrivate: boolean, members: string[] = []): Promise<string> {
  return String(ok(await by.makeRoom({ name, private: isPrivate, members }), `making ${name}`).room.id);
}

type Listed = { id: string; kind: string; divisionId: string | null; joined: boolean };

test('a company has one company room and one room per division, made the first time anyone looks, and a division made later shows what needs people', async () => {
  const { fixture, api, owner } = await workspace('rooms-made');
  try {
    // A company made after the rooms' migration has none until someone looks.
    const before = await withControlPlane((tx) => tx.query('SELECT 1 FROM rooms WHERE company_id = $1', [fixture.companyId]));
    assert.equal(before.rowCount, 0);

    const first = ok(await owner.rooms()).rooms as Listed[];
    assert.deepEqual(first.map((room) => [room.kind, room.joined]), [['company', true]], 'the company room, joined; a division room is browsed');
    const browsed = ok(await owner.rooms(true)).rooms as Listed[];
    assert.deepEqual(browsed.map((room) => room.kind).sort(), ['company', 'division']);
    assert.equal(browsed.find((room) => room.kind === 'division')!.divisionId, fixture.divisionId);

    const sales = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
      "INSERT INTO divisions (company_id, slug, name) VALUES ($1, 'sales', 'Sales') RETURNING id", [fixture.companyId])).rows[0]!.id);
    const again = ok(await owner.rooms(true)).rooms as Listed[];
    assert.deepEqual(again.map((room) => room.kind).sort(), ['company', 'division', 'division'], 'one more room, for the new division, and no second of any');
    const salesRoom = again.find((room) => room.divisionId === sales)!;
    assert.equal(ok(await owner.room(salesRoom.id)).room.showsWork, 'needs_people');
    assert.equal(ok(await owner.room(await companyRoomOf(owner))).room.showsWork, 'asked_here');
    const counted = await withControlPlane((tx) => tx.query<{ kind: string; n: number }>(
      'SELECT kind, count(*)::int AS n FROM rooms WHERE company_id = $1 GROUP BY kind ORDER BY kind', [fixture.companyId]));
    assert.deepEqual(counted.rows, [{ kind: 'company', n: 1 }, { kind: 'division', n: 2 }]);

    // The deployment's metrics count the people and the words, never what was said.
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    await said(budi, await companyRoomOf(budi), 'Morning, all.');
    const metrics = await metricsText({ worker: {
      counts: { places: 0, busy: 0, runs: new Map(), stageFailures: new Map(), loopFailures: { tick: 0, place: 0 } }, lastTickAt: null,
    } });
    assert.match(metrics, /palugada_people\{kind="member"\} 1/);
    assert.match(metrics, /palugada_people\{kind="owner"\} 1/);
    // How many messages are kept now, which a purge or an erasure lowers: a gauge, not a counter.
    assert.match(metrics, /# TYPE palugada_room_messages gauge/);
    assert.match(metrics, new RegExp(`palugada_room_messages\\{company="${fixture.slug}"\\} 1`));
    assert.doesNotMatch(metrics, /Morning/);
  } finally {
    await api.close();
  }
});

test('the company room holds every person and cannot be left', async () => {
  const { fixture, api, owner } = await workspace('rooms-company');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'viewer')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    assert.equal(await companyRoomOf(budi), room, 'one company room for everyone');
    const members = ok(await owner.room(room)).room.members as Array<{ principal: string; name: string | null }>;
    assert.equal(members.length, 2);
    assert.ok(members.some((member) => member.principal === 'owner' && member.name === null));
    assert.ok(members.some((member) => member.name === 'Budi'));
    refusedWith(await budi.leave(room), 409, 'room.company_room_stays');
    refusedWith(await owner.leave(room), 409, 'room.company_room_stays');
    assert.equal(ok(await owner.room(room)).room.members.length, 2);
  } finally {
    await api.close();
  }
});

test('opening a direct conversation with the same people twice opens the same one', async () => {
  const { fixture, api, owner } = await workspace('rooms-direct-once');
  try {
    const seat = await seated(fixture, 'Budi', 'member');
    const budi = personIn(api, seat.token, fixture.companyId);
    const opened = ok(await owner.direct([seat.principal]));
    assert.equal(opened.room.kind, 'direct');
    assert.equal(opened.room.private, true);
    assert.equal(ok(await owner.direct([seat.principal])).room.id, opened.room.id);
    assert.equal(ok(await budi.direct(['owner'])).room.id, opened.room.id, 'from either side');
    assert.equal(ok(await budi.direct(['owner', seat.principal, 'owner'])).room.id, opened.room.id, 'the caller and repeats are the same set');
    const people = ok(await budi.room(opened.room.id)).room.people as Array<{ principal: string }>;
    assert.deepEqual(people.map((one) => one.principal).sort(), ['owner', seat.principal].sort());
  } finally {
    await api.close();
  }
});

test('adding someone to a direct conversation opens a new one, and the first stays between its people', async () => {
  const { fixture, api, owner } = await workspace('rooms-direct-add');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const pair = String(ok(await owner.direct([budi.principal])).room.id);
    await said(owner, pair, 'Just between us.');
    refusedWith(await owner.members(pair, { add: [sari.principal] }), 409, 'room.direct_fixed');
    refusedWith(await owner.leave(pair), 409, 'room.direct_fixed');
    const three = String(ok(await owner.direct([budi.principal, sari.principal])).room.id);
    assert.notEqual(three, pair);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    assert.deepEqual(ok(await sariIn.page(three)).messages, [], 'a new conversation with no history');
    refusedWith(await sariIn.page(pair), 404, 'room.not_visible');
    refusedWith(await sariIn.room(pair), 404, 'room.not_visible');
    assert.equal(ok(await owner.room(pair)).room.members.length, 2);
  } finally {
    await api.close();
  }
});

test('a direct message is for two to eight people of the company', async () => {
  const { fixture, api, owner } = await workspace('rooms-direct-size');
  const other = await createCompany('rooms-direct-other');
  try {
    refusedWith(await owner.direct([]), 400, 'room.too_many_people', 'nobody but me');
    refusedWith(await owner.direct(['owner']), 400, 'room.too_many_people', 'myself');
    const seats = [];
    for (let n = 1; n <= 8; n += 1) seats.push(await seated(fixture, `Person ${n}`, 'viewer'));
    const seven = ok(await owner.direct(seats.slice(0, 7).map((seat) => seat.principal)));
    assert.equal(seven.room.people.length, 8);
    refusedWith(await owner.direct(seats.map((seat) => seat.principal)), 400, 'room.too_many_people', 'nine people');
    const stranger = await seated(other, 'Stranger', 'approver');
    refusedWith(await owner.direct([stranger.principal]), 400, 'contract.violation', 'a seat of another company');
    refusedWith(await owner.direct(['role:ceo']), 400, 'contract.violation', 'a role');
  } finally {
    await api.close();
  }
});

test('a private room is invisible to a seat outside it: by list, by id, by messages, by thread and by file', async () => {
  const { fixture, api, owner } = await workspace('rooms-private');
  try {
    const budi = await seated(fixture, 'Budi', 'approver');
    const sariSeat = await seated(fixture, 'Sari', 'approver');
    const sari = personIn(api, sariSeat.token, fixture.companyId);
    const room = await topic(owner, 'Pricing', true, [budi.principal]);
    const root = await said(owner, room, 'The new prices are in the sheet.');
    // A file on Budi's reply, as the files part will attach one: only its author attaches to a message.
    const reply = await said(personIn(api, budi.token, fixture.companyId), room, { body: 'And the sheet.', threadOf: root });
    await withPeople(fixture.companyId, { principal: budi.principal, name: 'Budi' }, async (tx) => {
      const file = randomUUID();
      await tx.query(
        `INSERT INTO room_files (id, company_id, message_id, name, mime, bytes, sha256, path)
         VALUES ($1, $2, $3, 'prices.csv', 'text/csv', 10, $4, $5)`,
        [file, fixture.companyId, reply, 'a'.repeat(64), `rooms/${room}/${file}.csv`]);
    });

    const listed = ok(await sari.rooms(true)).rooms as Listed[];
    assert.ok(!listed.some((one) => one.id === room), 'not in the list');
    refusedWith(await sari.room(room), 404, 'room.not_visible', 'by id');
    refusedWith(await sari.page(room), 404, 'room.not_visible', 'by messages');
    refusedWith(await sari.thread(room, root), 404, 'room.not_visible', 'by thread');
    refusedWith(await sari.say(room, 'Can I see this?'), 404, 'room.not_visible', 'by posting');
    refusedWith(await sari.join(room), 404, 'room.not_visible', 'by joining');
    const files = await withPeople(fixture.companyId, { principal: sariSeat.principal, name: 'Sari' }, (tx) =>
      tx.query('SELECT 1 FROM room_files'));
    assert.equal(files.rowCount, 0, 'by file');
    assert.equal(ok(await owner.page(room)).messages.length, 1, 'the owner reads it');
    assert.equal(ok(await owner.thread(room, root)).replies.length, 1);
  } finally {
    await api.close();
  }
});

test('a seat of one company reaches no room of another', async () => {
  const { fixture, api, owner } = await workspace('rooms-tenant');
  const other = await createCompany('rooms-tenant-other');
  try {
    const theirs = personIn(api, (await seated(other, 'Dewi', 'approver')).token, other.companyId);
    const room = await companyRoomOf(owner);
    await said(owner, room, 'Only for this company.');
    const reaching = personIn(api, theirs.token, fixture.companyId);
    refusedWith(await reaching.rooms(), 403, 'staff.forbidden');
    refusedWith(await reaching.page(room), 403, 'staff.forbidden');
    refusedWith(await reaching.say(room, 'Hello?'), 403, 'staff.forbidden');
    // Their own company's path, with this company's room in it.
    refusedWith(await theirs.page(room), 404, 'room.not_visible');
    refusedWith(await theirs.say(room, 'Hello?'), 404, 'room.not_visible');
    const unread = ok(await api.call('GET', '/api/rooms/unread', theirs.token)).unread as Array<{ companyId: string }>;
    assert.deepEqual(unread.map((one) => one.companyId), [other.companyId]);
  } finally {
    await api.close();
  }
});

test('a message carries its author from the session, whatever the body claims', async () => {
  const { fixture, api, owner } = await workspace('rooms-author');
  try {
    const seat = await seated(fixture, 'Budi Santoso', 'member', { handle: 'budi' });
    const budi = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    const mine = ok(await budi.say(room, 'I wrote this.')).message;
    assert.deepEqual(mine.author, { principal: seat.principal, name: 'Budi Santoso', handle: 'budi', picture: null });
    assert.equal(mine.via, 'console');
    const theirs = ok(await owner.say(room, 'And I wrote this.')).message;
    assert.deepEqual(theirs.author, { principal: 'owner', name: null, handle: null, picture: null });
    const rows = await withControlPlane((tx) => tx.query<{ author: string; author_name: string | null }>(
      'SELECT author, author_name FROM room_messages WHERE company_id = $1 ORDER BY position', [fixture.companyId]));
    assert.deepEqual(rows.rows, [{ author: seat.principal, author_name: 'Budi Santoso' }, { author: 'owner', author_name: null }]);

    // Renamed by the owner, the seat writes under its new name; what it said keeps the one it said it under.
    await withControlPlane((tx) => tx.query("UPDATE staff_seats SET name = 'Budi S.' WHERE id = $1", [seat.id]));
    assert.equal(ok(await budi.say(room, 'Renamed.')).message.author.name, 'Budi S.');
    const page = ok(await owner.page(room)).messages as Array<{ body: string; author: { name: string | null } }>;
    assert.deepEqual(page.map((one) => [one.body, one.author.name]),
      [['I wrote this.', 'Budi Santoso'], ['And I wrote this.', null], ['Renamed.', 'Budi S.']]);
  } finally {
    await api.close();
  }
});

test('a body naming an author, as or via is refused', async () => {
  const { fixture, api, owner } = await workspace('rooms-claims');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    for (const field of ['author', 'as', 'by', 'principal', 'via']) {
      const answer = await budi.say(room, { body: 'Signed by the owner.', [field]: 'owner' });
      refusedWith(answer, 400, 'contract.violation', field);
      assert.match(answer.body.error, new RegExp(field));
    }
    refusedWith(await budi.makeRoom({ name: 'Ops', private: false, author: 'owner' }), 400, 'contract.violation', 'on a room too');
    assert.deepEqual(ok(await owner.page(room)).messages, []);
  } finally {
    await api.close();
  }
});

test('a reply stays in its thread unless it is also sent to the room, and a thread is one level deep', async () => {
  const { fixture, api, owner } = await workspace('rooms-threads');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    const root = await said(owner, room, 'Who has the supplier list?');
    const quiet = await said(budi, room, { body: 'I do.', threadOf: root });
    const loud = await said(budi, room, { body: 'Shared it in the drive.', threadOf: root, alsoInRoom: true });
    const page = ok(await owner.page(room)).messages as Array<{ id: string; replies: { count: number } | null }>;
    assert.deepEqual(page.map((one) => one.id), [root, loud], 'the room shows the root and the reply sent to it');
    assert.equal(page[0]!.replies!.count, 2);
    const thread = ok(await owner.thread(room, root));
    assert.equal(thread.root.id, root);
    assert.deepEqual(thread.replies.map((one: { id: string }) => one.id), [quiet, loud]);
    refusedWith(await owner.say(room, { body: 'Deeper?', threadOf: quiet }), 400, 'contract.violation', 'a reply to a reply');
    const elsewhere = await topic(owner, 'Elsewhere', false);
    refusedWith(await owner.say(elsewhere, { body: 'Across rooms?', threadOf: root }), 400, 'contract.violation', 'a reply in another room');
  } finally {
    await api.close();
  }
});

test('a message retried with the same client id is posted once', async () => {
  const { api, owner } = await workspace('rooms-retry');
  try {
    const room = await companyRoomOf(owner);
    const first = ok(await owner.say(room, { body: 'Once.', clientId: 'tab-1-7' })).message;
    const again = ok(await owner.say(room, { body: 'Once.', clientId: 'tab-1-7' })).message;
    assert.equal(again.id, first.id);
    assert.equal(ok(await owner.page(room)).messages.length, 1);
    refusedWith(await owner.say(room, { body: 'No id.', clientId: undefined }), 400, 'contract.violation', 'a message names its client id');
  } finally {
    await api.close();
  }
});

test('a mention names a person who can see the room; @owner names the owner; a role cannot be mentioned; a mention in a private room of someone outside it is dropped and said', async () => {
  const { fixture, api, owner } = await workspace('rooms-mentions');
  try {
    const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const sari = await seated(fixture, 'Sari Dewi', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budiIn);

    const posted = ok(await budiIn.say(room, {
      body: '@owner and @Sari Dewi, the order is in. @ceo please confirm.',
      mentions: ['owner', sari.principal, 'role:ceo'],
    }));
    assert.deepEqual(posted.message.mentions.map((one: { principal: string }) => one.principal).sort(), ['owner', sari.principal].sort());
    assert.deepEqual(posted.mentionsDropped, [{ principal: 'role:ceo', why: 'not_a_person' }]);
    const noted = await withControlPlane((tx) => tx.query<{ principal: string; reason: string }>(
      'SELECT principal, reason FROM room_mentions WHERE message_id = $1 ORDER BY principal', [posted.message.id]));
    assert.deepEqual(noted.rows.map((row) => row.principal).sort(), ['owner', sari.principal].sort());

    // A mention whose name is not in the words is not one.
    const unwritten = ok(await budiIn.say(room, { body: 'No names here.', mentions: [sari.principal] }));
    assert.deepEqual(unwritten.mentionsDropped, [{ principal: sari.principal, why: 'not_written' }]);

    const secret = await topic(owner, 'Payroll', true, [budi.principal]);
    const inside = ok(await budiIn.say(secret, { body: '@owner @Sari Dewi the numbers', mentions: ['owner', sari.principal] }));
    assert.deepEqual(inside.message.mentions.map((one: { principal: string }) => one.principal), ['owner']);
    assert.deepEqual(inside.mentionsDropped, [{ principal: sari.principal, why: 'not_in_room' }]);
    const sariSees = await withPeople(fixture.companyId, { principal: sari.principal, name: 'Sari Dewi' }, (tx) =>
      tx.query('SELECT 1 FROM room_mentions WHERE message_id = $1', [inside.message.id]));
    assert.equal(sariSees.rowCount, 0);
  } finally {
    await api.close();
  }
});

test('@room is the owner\'s and an approver\'s, and tells every member who has not silenced the room', async () => {
  const { fixture, api, owner } = await workspace('rooms-at-room');
  try {
    const ana = await seated(fixture, 'Ana', 'approver');
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const anaIn = personIn(api, ana.token, fixture.companyId);
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    for (const person of [anaIn, budiIn, sariIn]) await companyRoomOf(person);
    ok(await sariIn.settings(room, { notify: 'none' }));

    refusedWith(await budiIn.say(room, { body: '@room lunch?', mentionsRoom: true }), 403, 'mention.room_not_yours');
    const everyone = ok(await anaIn.say(room, { body: '@room the office is closed on Friday.', mentionsRoom: true })).message;
    assert.equal(everyone.mentionsRoom, true);
    const told = await withControlPlane((tx) => tx.query<{ principal: string }>(
      'SELECT principal FROM room_mentions WHERE message_id = $1 ORDER BY principal', [everyone.id]));
    assert.deepEqual(told.rows.map((row) => row.principal).sort(), ['owner', budi.principal].sort(), 'not its author, not who silenced the room');
    assert.equal(ok(await owner.room(room)).room.may.mentionRoom, true);
    assert.equal(ok(await budiIn.room(room)).room.may.mentionRoom, false);
  } finally {
    await api.close();
  }
});

test('an edit within a day keeps what was said before, for the owner\'s eyes only', async () => {
  const { fixture, api, owner } = await workspace('rooms-edit');
  try {
    const seat = await seated(fixture, 'Budi', 'approver');
    const budi = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    const id = await said(budi, room, 'The meeting is at 3.');
    const edited = ok(await budi.on(room, id, 'edit', { body: 'The meeting is at 4.' })).message;
    assert.deepEqual([edited.body, edited.edited], ['The meeting is at 4.', true]);
    refusedWith(await owner.on(room, id, 'edit', { body: 'At 5.' }), 403, 'message.not_yours', 'not even the owner edits it');
    const history = ok(await owner.get(`/rooms/${room}/messages/${id}/history`)).revisions as Array<{ body: string }>;
    assert.deepEqual(history.map((one) => one.body), ['The meeting is at 3.']);
    refusedWith(await budi.get(`/rooms/${room}/messages/${id}/history`), 403, 'staff.forbidden', 'the earlier words are the owner\'s record');
    assert.equal(ok(await owner.page(room)).messages[0].may.history, true);
    assert.equal(ok(await budi.page(room)).messages[0].may.history, false);

    // A message written more than a day ago.
    const old = randomUUID();
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, author_name, body, created_at, position)
         VALUES ($1, $2, $3, 'text', $4, 'Budi', 'Yesterday''s words.', now() - interval '25 hours', 0)`,
        [old, fixture.companyId, room, seat.principal]);
    });
    refusedWith(await budi.on(room, old, 'edit', { body: 'Changed.' }), 409, 'message.edit_window');
  } finally {
    await api.close();
  }
});

test('a deleted message leaves a tombstone and none of its words', async () => {
  const { fixture, api, owner } = await workspace('rooms-delete');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const sari = personIn(api, (await seated(fixture, 'Sari', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    const id = await said(budi, room, 'My bank number is in here.');
    ok(await budi.on(room, id, 'edit', { body: 'My bank number was in here.' }));
    refusedWith(await sari.on(room, id, 'delete'), 403, 'message.not_yours');
    const gone = ok(await budi.on(room, id, 'delete')).message;
    assert.deepEqual([gone.deleted, gone.body], [true, null]);
    const row = await withControlPlane((tx) => tx.query<{ body: string | null; revisions: number }>(
      `SELECT body, (SELECT count(*)::int FROM room_message_revisions WHERE message_id = m.id) AS revisions
         FROM room_messages m WHERE id = $1`, [id]));
    assert.deepEqual(row.rows[0], { body: null, revisions: 0 }, 'neither the words nor what they replaced');
    const shown = ok(await sari.page(room)).messages[0];
    assert.deepEqual([shown.id, shown.deleted, shown.body], [id, true, null]);
    // The owner removes anyone's.
    const other = await said(sari, room, 'Something to take back.');
    assert.equal(ok(await owner.on(room, other, 'delete')).message.deleted, true);
  } finally {
    await api.close();
  }
});

test('a viewer may talk and make a room; a viewer may not ask for work', async () => {
  const { fixture, api, owner } = await workspace('rooms-viewer');
  try {
    const seat = await seated(fixture, 'Rina', 'viewer');
    const rina = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(rina);
    const id = await said(rina, room, 'Could someone price the catalogue?');
    const made = await topic(rina, 'Catalogue', false);
    assert.equal(ok(await rina.room(made)).room.createdBy, seat.principal);
    const asked = await rina.on(room, id, 'work', { target: 'company', goal: 'Price the catalogue', goalId: fixture.goalId });
    refusedWith(asked, 403, 'staff.forbidden');
    assert.equal(ok(await rina.page(room)).messages[0].may.giveAsWork, false);
    void owner;
  } finally {
    await api.close();
  }
});

test("a revoked seat's words stay under its name, its rooms close to it, and it can post no more", async () => {
  const { fixture, api, owner } = await workspace('rooms-revoked');
  try {
    const seat = await seated(fixture, 'Budi', 'member');
    const budi = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(budi);
    const secret = await topic(owner, 'Plans', true, [seat.principal]);
    await said(budi, room, 'Last day today.');
    ok(await api.call('POST', `/api/companies/${fixture.companyId}/staff/${seat.id}/revoke`, owner.token, {}));
    const page = ok(await owner.page(room)).messages as Array<{ body: string; author: { name: string } }>;
    assert.deepEqual(page.map((one) => [one.body, one.author.name]), [['Last day today.', 'Budi']]);
    assert.equal((await budi.say(room, 'Still here?')).status, 401);
    const left = await withControlPlane((tx) => tx.query<{ room_id: string; left_by: string | null }>(
      'SELECT room_id, left_by FROM room_members WHERE principal = $1 ORDER BY room_id', [seat.principal]));
    assert.ok(left.rows.length >= 2 && left.rows.every((row) => row.left_by === 'platform'), JSON.stringify(left.rows));
    const members = ok(await owner.room(secret)).room.members as Array<{ principal: string }>;
    assert.deepEqual(members.map((one) => one.principal), ['owner']);
    assert.ok(!(ok(await owner.people()).people as Array<{ principal: string }>).some((one) => one.principal === seat.principal));
  } finally {
    await api.close();
  }
});

test('a member removed from a private room is told nothing more about it, and their Activity no longer names it', async () => {
  const { fixture, api, owner } = await workspace('rooms-removed');
  try {
    const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const room = await topic(owner, 'Launch', true, [budi.principal, sari.principal]);
    await said(owner, room, { body: '@sari can you check the date?', mentions: [sari.principal] });
    const before = ok(await sariIn.activity()).items as Array<{ roomId?: string }>;
    assert.ok(before.some((item) => item.roomId === room));

    const budiIn = personIn(api, budi.token, fixture.companyId);
    refusedWith(await budiIn.members(room, { remove: [sari.principal] }), 403, 'room.not_creator', 'a member does not remove another');
    ok(await owner.members(room, { remove: [sari.principal] }));
    await said(owner, room, { body: '@sari never mind.', mentions: [sari.principal] });
    const after = ok(await sariIn.activity()).items as Array<{ roomId?: string }>;
    assert.ok(!after.some((item) => item.roomId === room), JSON.stringify(after));
    refusedWith(await sariIn.room(room), 404, 'room.not_visible');
    assert.ok(!(ok(await sariIn.rooms(true)).rooms as Listed[]).some((one) => one.id === room));
  } finally {
    await api.close();
  }
});

test('too many messages in a minute are refused, and say so', async () => {
  const { fixture, api, owner } = await workspace('rooms-rate');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(budi);
    for (let n = 1; n <= 30; n += 1) ok(await budi.say(room, `Message ${n}`), `message ${n}`);
    const refused = await budi.say(room, 'One too many');
    refusedWith(refused, 429, 'room.too_fast');
    assert.match(refused.body.error, /minute/);
    ok(await owner.say(room, 'The owner has a minute of their own.'));
  } finally {
    await api.close();
  }
});

test("a reaction is a person's, on a person's message, and can be taken back", async () => {
  const { fixture, api, owner } = await workspace('rooms-react');
  try {
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budi);
    const id = await said(owner, room, 'We hit the target.');
    assert.deepEqual(ok(await budi.on(room, id, 'react', { emoji: '🎉', on: true })).reactions, [{ emoji: '🎉', count: 1, mine: true }]);
    assert.deepEqual(ok(await owner.page(room)).messages[0].reactions, [{ emoji: '🎉', count: 1, mine: false }]);
    assert.deepEqual(ok(await budi.on(room, id, 'react', { emoji: '🎉', on: false })).reactions, []);
    refusedWith(await budi.on(room, id, 'react', { emoji: 'x'.repeat(17), on: true }), 400, 'contract.violation');

    // A card, or a notice, takes no reaction: a 👍 approves nothing.
    const notice = randomUUID();
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, via, notice_code, position)
         VALUES ($1, $2, $3, 'notice', 'platform', 'platform', 'recorded', 0)`, [notice, fixture.companyId, room]);
    });
    refusedWith(await budi.on(room, notice, 'react', { emoji: '👍', on: true }), 400, 'contract.violation');
  } finally {
    await api.close();
  }
});

test('at most fifty pins in a room', async () => {
  const { fixture, api, owner } = await workspace('rooms-pins');
  try {
    const room = await topic(owner, 'Pins', false);
    const ids: string[] = [];
    await withPeople(fixture.companyId, { principal: 'owner', name: null }, async (tx) => {
      for (let n = 0; n < 51; n += 1) {
        const id = randomUUID();
        await tx.query(
          "INSERT INTO room_messages (id, company_id, room_id, kind, author, body, position) VALUES ($1, $2, $3, 'text', 'owner', $4, 0)",
          [id, fixture.companyId, room, `Note ${n}`]);
        ids.push(id);
      }
    });
    for (const id of ids.slice(0, 50)) ok(await owner.on(room, id, 'pin', { on: true }));
    refusedWith(await owner.on(room, ids[50]!, 'pin', { on: true }), 409, 'room.pins_full');
    assert.equal(ok(await owner.room(room)).room.pins.length, 50);
    ok(await owner.on(room, ids[0]!, 'pin', { on: false }));
    ok(await owner.on(room, ids[50]!, 'pin', { on: true }));
    assert.equal(ok(await owner.room(room)).room.pins.includes(ids[50]), true);
  } finally {
    await api.close();
  }
});

test('who removed a member and who archived a room is kept', async () => {
  const { fixture, api, owner } = await workspace('rooms-who');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const room = await topic(budiIn, 'Suppliers', true, [sari.principal]);
    ok(await budiIn.members(room, { remove: [sari.principal] }));
    const sariIn = personIn(api, sari.token, fixture.companyId);
    refusedWith(await sariIn.post(`/rooms/${room}/archive`), 404, 'room.not_visible');
    const other = await topic(budiIn, 'Old stock', false);
    await companyRoomOf(sariIn);
    ok(await sariIn.join(other));
    refusedWith(await sariIn.post(`/rooms/${other}/archive`), 403, 'room.not_creator');
    const archived = ok(await budiIn.post(`/rooms/${other}/archive`)).room;
    assert.equal(archived.archived, true);
    refusedWith(await sariIn.say(other, 'Too late?'), 409, 'room.archived');
    const rows = await withControlPlane((tx) => tx.query<{ left_by: string | null; archived_by: string | null }>(
      `SELECT (SELECT left_by FROM room_members WHERE room_id = $1 AND principal = $2) AS left_by,
              (SELECT archived_by FROM rooms WHERE id = $3) AS archived_by`, [room, sari.principal, other]));
    assert.deepEqual(rows.rows[0], { left_by: budi.principal, archived_by: budi.principal });
    void owner;
  } finally {
    await api.close();
  }
});

test("a topic room's name is its own among the open ones, and a name taken by a room one cannot see says only that it cannot be used", async () => {
  const { fixture, api, owner } = await workspace('rooms-names');
  try {
    const alpha = await topic(owner, 'Alpha', false);
    await topic(owner, 'Beta', false);
    const made = await owner.makeRoom({ name: 'beta', private: false });
    refusedWith(made, 400, 'contract.violation', 'a second open room of a name');
    assert.match(made.body.error, /join it, or choose another name/);
    const renamed = await owner.post(`/rooms/${alpha}`, { name: 'BETA' });
    refusedWith(renamed, 400, 'contract.violation', 'renamed onto an open room');
    assert.match(renamed.body.error, /choose another name/);
    assert.doesNotMatch(renamed.body.error, /duplicate key|constraint/, "the database's words are not the owner's");
    assert.equal(ok(await owner.room(alpha)).room.name, 'Alpha');

    // A private room's name is taken for everyone, and someone outside it is told no more than that.
    await topic(owner, 'Secret plans', true);
    const budi = personIn(api, (await seated(fixture, 'Budi', 'member')).token, fixture.companyId);
    const hidden = await budi.makeRoom({ name: 'secret PLANS', private: false });
    refusedWith(hidden, 400, 'contract.violation', 'a name a room Budi cannot see holds');
    assert.match(hidden.body.error, /cannot be used/);
    assert.doesNotMatch(hidden.body.error, /already open|join it/, 'nothing says a room of that name is there');
    const own = await topic(budi, 'Gamma', false);
    const onto = await budi.post(`/rooms/${own}`, { name: 'Secret Plans' });
    refusedWith(onto, 400, 'contract.violation', 'renamed onto a room Budi cannot see');
    assert.match(onto.body.error, /cannot be used/);
    assert.doesNotMatch(onto.body.error, /already open|join it|duplicate key/);
    // Archived, a name is free again.
    ok(await owner.post(`/rooms/${alpha}/archive`));
    ok(await budi.post(`/rooms/${own}`, { name: 'Alpha' }));
  } finally {
    await api.close();
  }
});
