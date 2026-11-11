/**
 * The rooms as people use them, on the server (F19.7, F19.10; STATUS
 * section 2.218).
 *
 * A name written in an edit tells its person as a name written in a post
 * does, with the same check that the name is in the words and that the
 * person can see the room, and a name taken out of the words takes its
 * mention back. Activity says who wrote and a few of their words, read as
 * the person reading it, and where the message is, so it opens there. And a
 * person can mark everything they were owed read at once: their own marks
 * and mentions, nobody else's.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane } from '../../src/db/tenant.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { companyRoomOf, ok, personIn, refusedWith, said, seated, type Console, type PersonIn } from '../helpers/rooms.ts';
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

type Item = {
  kind: string; roomId: string; messageId: string; threadOf: string | null; position: number; seen: boolean;
  author: { principal: string; name: string | null; handle: string | null } | null; excerpt: string | null;
};

async function activity(person: PersonIn): Promise<Item[]> {
  return ok(await person.activity(), 'reading Activity').items as Item[];
}

/** What waits for a person in their company, as the badge reads it. */
async function waiting(api: Console, person: PersonIn): Promise<{ mentions: number; direct: number; rooms: number }> {
  const unread = ok(await api.call('GET', '/api/rooms/unread', person.token), 'reading what waits').unread as Array<{ mentions: number; direct: number; rooms: number }>;
  return unread[0]!;
}

test('a name written in an edit mentions its person as a post does, and a name taken out takes the mention back', async () => {
  const { fixture, api, owner } = await workspace('edit-mentions');
  try {
    const sari = await seated(fixture, 'Sari Wulandari', 'approver', { handle: 'sari' });
    const budi = await seated(fixture, 'Budi Santoso', 'member', { handle: 'budi' });
    const her = personIn(api, sari.token, fixture.companyId);
    const him = personIn(api, budi.token, fixture.companyId);
    const roomId = await companyRoomOf(owner);
    await companyRoomOf(her);
    await companyRoomOf(him);
    const id = await said(owner, roomId, 'rapat besok jam sembilan');
    assert.deepEqual(await activity(him), [], 'nobody is named yet');

    const named = ok(await owner.on(roomId, id, 'edit', { body: '@budi rapat besok jam sembilan', mentions: [budi.principal] }), 'naming Budi in an edit');
    assert.deepEqual(named.message.mentions.map((one: { principal: string }) => one.principal), [budi.principal], 'the edit keeps the person it names');
    assert.deepEqual(named.mentionsDropped, []);
    const told = await activity(him);
    assert.deepEqual(told.map((one) => [one.kind, one.messageId, one.seen]), [['mention', id, false]], 'Budi is told, as a post would tell him');
    assert.equal((await waiting(api, him)).mentions, 1, "Budi's badge counts it");

    // The feed row of the edit names who it now tells, so their open console hears that it names them (STATUS 2.210).
    const feed = await withControlPlane(async (tx) => (await tx.query<{ kind: string; mentions: string[]; author: string | null }>(
      "SELECT kind, mentions, author FROM room_feed WHERE company_id = $1 AND ref = $2 AND kind = 'edit' ORDER BY position", [fixture.companyId, id])).rows);
    assert.deepEqual(feed.map((row) => [row.mentions, row.author]), [[[budi.principal], 'owner']], 'the edit is framed as naming Budi, by its author');

    // Budi taken out and Sari written in: his mention goes, hers comes.
    const moved = ok(await owner.on(roomId, id, 'edit', { body: '@sari rapat besok jam sembilan', mentions: [sari.principal, budi.principal] }), 'naming Sari instead');
    assert.deepEqual(moved.message.mentions.map((one: { principal: string }) => one.principal), [sari.principal]);
    assert.deepEqual(moved.mentionsDropped, [{ principal: budi.principal, why: 'not_written' }], 'a name not in the words is said back');
    assert.deepEqual(await activity(him), [], "a name taken out of the words leaves Budi's Activity");
    assert.equal((await waiting(api, him)).mentions, 0);
    assert.deepEqual((await activity(her)).map((one) => one.messageId), [id]);

    // Words unchanged, mentions unchanged: an edit that says nothing new is refused as before.
    refusedWith(await owner.on(roomId, id, 'edit', { body: '' }), 400, 'contract.violation', 'an empty edit');
  } finally {
    await api.close();
  }
});

test('an edit tells only the people who can see the room, and says who was not told', async () => {
  const { fixture, api, owner } = await workspace('edit-mentions-private');
  try {
    const sari = await seated(fixture, 'Sari Wulandari', 'approver', { handle: 'sari' });
    const budi = await seated(fixture, 'Budi Santoso', 'member', { handle: 'budi' });
    const him = personIn(api, budi.token, fixture.companyId);
    await companyRoomOf(him);
    const room = String(ok(await owner.makeRoom({ name: 'keuangan', private: true, members: [sari.principal] })).room.id);
    const id = await said(owner, room, 'sewa naik bulan depan');
    const answer = ok(await owner.on(room, id, 'edit', { body: 'sewa naik bulan depan @budi', mentions: [budi.principal, 'seat:nobody'] }));
    assert.deepEqual(answer.message.mentions, []);
    assert.deepEqual(answer.mentionsDropped, [
      { principal: budi.principal, why: 'not_in_room' }, { principal: 'seat:nobody', why: 'not_a_person' },
    ]);
    assert.deepEqual(await activity(him), [], 'nothing of a private room reaches someone outside it');
    refusedWith(await owner.on(room, id, 'edit', { body: 'x', mentions: 'budi' }), 400, 'contract.violation', 'mentions that are not a list');
    // Someone else's message stays theirs to change, mentions and all.
    const hers = await said(personIn(api, sari.token, fixture.companyId), room, 'ringkasan menyusul');
    refusedWith(await owner.on(room, hers, 'edit', { body: '@owner ringkasan menyusul', mentions: ['owner'] }), 403, 'message.not_yours');
  } finally {
    await api.close();
  }
});

test('Activity says who wrote and a few of their words, as the person may read them, and where the message is', async () => {
  const { fixture, api, owner } = await workspace('activity-words');
  try {
    const sari = await seated(fixture, 'Sari Wulandari', 'approver', { handle: 'sari' });
    const budi = await seated(fixture, 'Budi Santoso', 'member', { handle: 'budi' });
    const her = personIn(api, sari.token, fixture.companyId);
    const him = personIn(api, budi.token, fixture.companyId);
    const roomId = await companyRoomOf(owner);
    await companyRoomOf(her);
    await companyRoomOf(him);
    const long = `@budi tolong cek foto produk untuk Instagram, ${'dan katalognya juga '.repeat(12)}terima kasih.`;
    const asked = ok(await her.say(roomId, { body: long, mentions: [budi.principal] })).message;
    const root = await said(him, roomId, 'Stok gula aren cukup?');
    const reply = ok(await owner.say(roomId, { body: 'Cukup sampai Jumat.\n\nNanti saya pesan lagi.', threadOf: root })).message;
    const gone = ok(await her.say(roomId, { body: '@budi salah kirim', mentions: [budi.principal] })).message;
    ok(await her.on(roomId, gone.id, 'delete'));

    const items = await activity(him);
    const mention = items.find((one) => one.messageId === asked.id)!;
    assert.equal(mention.kind, 'mention');
    assert.deepEqual([mention.author?.principal, mention.author?.name, mention.author?.handle], [sari.principal, 'Sari Wulandari', 'sari'], 'who wrote it');
    assert.equal(mention.position, asked.position, 'where it is, so it opens there');
    assert.ok(mention.excerpt && mention.excerpt.length <= 140 && mention.excerpt.endsWith('…'), `a few of the words, cut short: ${mention.excerpt}`);
    assert.ok(mention.excerpt.startsWith('@budi tolong cek foto produk'), 'from the start of the words');

    const answered = items.find((one) => one.messageId === reply.id)!;
    assert.equal(answered.kind, 'reply');
    assert.deepEqual([answered.author?.principal, answered.author?.name, answered.threadOf], ['owner', null, root]);
    assert.equal(answered.excerpt, 'Cukup sampai Jumat. Nanti saya pesan lagi.', 'on one line');

    const removed = items.find((one) => one.messageId === gone.id);
    assert.ok(!removed || removed.excerpt === null, 'a removed message says no words');
  } finally {
    await api.close();
  }
});

test('marking everything read reads every room and sees every mention, the person\'s own and nobody else\'s', async () => {
  const { fixture, api, owner } = await workspace('read-all');
  try {
    const sari = await seated(fixture, 'Sari Wulandari', 'approver', { handle: 'sari' });
    const budi = await seated(fixture, 'Budi Santoso', 'viewer', { handle: 'budi' });
    const her = personIn(api, sari.token, fixture.companyId);
    const him = personIn(api, budi.token, fixture.companyId);
    const roomId = await companyRoomOf(owner);
    await companyRoomOf(her);
    await companyRoomOf(him);
    const direct = String(ok(await owner.direct([budi.principal])).room.id);
    await said(owner, direct, 'Pak Budi, besok bisa datang pagi?');
    await said(owner, roomId, { body: '@budi @sari stok opname Jumat', mentions: [budi.principal, sari.principal] });
    // A room Budi never joined, where he is named: seen as well, and still not joined.
    const topic = String(ok(await owner.makeRoom({ name: 'gudang', private: false })).room.id);
    await said(owner, topic, { body: '@budi kunci gudang di mana?', mentions: [budi.principal] });

    const before = await waiting(api, him);
    assert.deepEqual([before.mentions, before.direct, before.rooms > 0], [2, 1, true], 'what waits for Budi');

    ok(await him.post('/me/read-all'), 'a viewer marks everything read');
    const after = await waiting(api, him);
    assert.deepEqual([after.mentions, after.direct, after.rooms], [0, 0, 0], 'nothing waits for Budi');
    assert.ok((await activity(him)).every((one) => one.seen), 'every mention is seen');
    const rooms = ok(await him.rooms()).rooms as Array<{ id: string; unread: number }>;
    assert.ok(rooms.every((one) => one.unread === 0), 'every room is read');
    assert.equal(rooms.some((one) => one.id === topic), false, 'marking read joins no room');

    const hers = await waiting(api, her);
    assert.equal(hers.mentions, 1, "Sari's mention is hers, and still waits");
  } finally {
    await api.close();
  }
});

test('before a message window is chosen, the owner can be told how many messages it would take', async () => {
  const { fixture, api, owner } = await workspace('window-count');
  try {
    const roomId = await companyRoomOf(owner);
    // Two things said four months ago, written on the control plane, which alone may date a message in the past.
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      for (const body of ['Pesan lama sekali.', 'Pesan lama juga.']) {
        await tx.query(
          `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, position, created_at)
           VALUES ($1, $2, $3, 'text', 'owner', $4, 0, now() - interval '120 days')`, [randomUUID(), fixture.companyId, roomId, body]);
      }
    });
    await said(owner, roomId, 'Pesan kemarin.');
    const gone = await said(owner, roomId, 'Sudah dihapus.');
    ok(await owner.on(roomId, gone, 'delete'));

    const asked = ok(await owner.get('/retention?messageDays=90'), 'asking what ninety days would take');
    assert.equal(asked.messagesPast, 2, 'the two said four months ago, and nothing newer or removed');
    assert.equal(asked.policy.messageDays, null, 'asking sets nothing');
    assert.equal(ok(await owner.get('/retention?messageDays=365')).messagesPast, 0);
    assert.equal(ok(await owner.get('/retention')).messagesPast, undefined, 'without a window, no count is read');
    refusedWith(await owner.get('/retention?messageDays=7'), 400, 'contract.violation', 'a window under thirty days');
  } finally {
    await api.close();
  }
});
