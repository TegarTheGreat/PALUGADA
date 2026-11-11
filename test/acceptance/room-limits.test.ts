/**
 * What one person may do in the rooms, and how much the rooms may keep
 * (F19.4, F19.5, F19.14; STATUS section 2.217).
 *
 * Only posting a message had a rate. Every other write of the workspace --
 * making rooms, opening direct conversations, changing who is in a room,
 * reacting, pinning, editing, searching, setting meetings, importing -- had
 * none, so one seat, a viewer too, could fill colleagues' rails with rooms,
 * pin free words under their messages as "reactions" and keep a revision a
 * second; and room files had no limit but the disk. A reaction is one emoji,
 * a few of them a person on a message; each write is held to a person's
 * minute; and a company's room files to a limit the owner sets.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withPeople } from '../../src/db/tenant.ts';
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
  const api = await consoleWithSettings({ files: { root: await mkdtemp(join(tmpdir(), 'palugada-room-limits-')) } });
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner };
}

test('a reaction is one emoji, and a person puts a few on a message at most', async () => {
  const { fixture, api, owner } = await workspace('limits-reactions');
  try {
    const seat = await seated(fixture, 'Sari', 'viewer');
    const sari = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(sari);
    const asked = await said(owner, room, 'Shall we send the payment?');
    for (const word of ['approved', 'YES', '<b>', 'FIRED', 'http://x.io', '‮evorppa', '​', '👍👍', 'a']) {
      refusedWith(await sari.on(room, asked, 'react', { emoji: word, on: true }), 400, 'reaction.not_emoji', `"${word}" is no emoji`);
    }
    // An emoji with or without its emoji form is one emoji, kept in its emoji form; a family, a flag and a keycap are one each.
    for (const emoji of ['❤', '👨‍👩‍👧‍👦', '🇮🇩', '1️⃣', '👍🏽']) ok(await sari.on(room, asked, 'react', { emoji, on: true }), emoji);
    const shown = (ok(await owner.page(room)).messages as Array<{ id: string; reactions: Array<{ emoji: string }> }>)
      .find((one) => one.id === asked)!;
    assert.deepEqual(shown.reactions.map((one) => one.emoji).sort(), ['❤️', '👨‍👩‍👧‍👦', '🇮🇩', '1️⃣', '👍🏽'].sort());
    // Taking one back names it either way.
    ok(await sari.on(room, asked, 'react', { emoji: '❤', on: false }));
    for (const emoji of ['😀', '😃', '😄', '😁', '😆', '😅']) ok(await sari.on(room, asked, 'react', { emoji, on: true }), emoji);
    refusedWith(await sari.on(room, asked, 'react', { emoji: '🤣', on: true }), 409, 'reaction.too_many', 'ten from one person on one message');
    // The database holds the same rule, whoever writes.
    await assert.rejects(withPeople(fixture.companyId, { principal: seat.principal, name: 'Sari' }, (tx) => tx.query(
      `INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, $3, 'FIRED')`,
      [fixture.companyId, asked, seat.principal])), /room_reactions_one_emoji|check constraint/);
  } finally {
    await api.close();
  }
});

test("every write of the rooms is held to a person's minute, and says so", async () => {
  const { fixture, api, owner } = await workspace('limits-minute');
  try {
    const seat = await seated(fixture, 'Dewi', 'member');
    const dewi = personIn(api, seat.token, fixture.companyId);
    const others = await Promise.all(['Budi', 'Rina', 'Agus', 'Wati', 'Joko', 'Tari', 'Eko', 'Nina', 'Hadi', 'Lia', 'Yudi']
      .map((name) => seated(fixture, name, 'member')));
    const room = await companyRoomOf(owner);
    await companyRoomOf(dewi);
    const tooFast = (answer: { status: number; body: any }, what: string) => {
      refusedWith(answer, 429, 'workspace.too_fast', what);
      assert.equal(typeof answer.body.details?.perMinute, 'number');
    };

    // Rooms: five a minute; the first a private one of hers.
    const secret = String(ok(await dewi.makeRoom({ name: 'rahasia', private: true, members: ['owner'] })).room.id);
    for (let n = 2; n <= 5; n += 1) ok(await dewi.makeRoom({ name: `ruang-${n}` }), `room ${n}`);
    tooFast(await dewi.makeRoom({ name: 'ruang-6' }), 'a sixth room in a minute');

    // Direct conversations: ten a minute.
    for (let n = 0; n < 10; n += 1) ok(await dewi.direct([others[n]!.principal]), `direct ${n}`);
    tooFast(await dewi.direct([others[10]!.principal]), 'an eleventh direct conversation in a minute');

    // Reactions: thirty a minute, taking one back counted too.
    const words = await said(owner, room, 'Rapat jam tiga.');
    for (let n = 0; n < 15; n += 1) {
      ok(await dewi.on(room, words, 'react', { emoji: '👍', on: true }));
      ok(await dewi.on(room, words, 'react', { emoji: '👍', on: false }));
    }
    tooFast(await dewi.on(room, words, 'react', { emoji: '👍', on: true }), 'a thirty-first reaction in a minute');

    // Edits: twenty a minute.
    const mine = await said(dewi, room, 'Draf pertama.');
    for (let n = 1; n <= 20; n += 1) ok(await dewi.on(room, mine, 'edit', { body: `Draf ke-${n + 1}.` }), `edit ${n}`);
    tooFast(await dewi.on(room, mine, 'edit', { body: 'Draf lagi.' }), 'a twenty-first edit in a minute');

    // Pins: ten a minute.
    for (let n = 0; n < 5; n += 1) {
      ok(await dewi.on(room, mine, 'pin', { on: true }));
      ok(await dewi.on(room, mine, 'pin', { on: false }));
    }
    tooFast(await dewi.on(room, mine, 'pin', { on: true }), 'an eleventh pin in a minute');

    // Searches: thirty a minute.
    for (let n = 0; n < 30; n += 1) ok(await dewi.get('/room-search?q=draf'), `search ${n}`);
    tooFast(await dewi.get('/room-search?q=draf'), 'a thirty-first search in a minute');

    // Who is in a private room: ten changes a minute.
    for (let n = 0; n < 5; n += 1) {
      ok(await dewi.members(secret, { add: [others[n]!.principal] }));
      ok(await dewi.members(secret, { remove: [others[n]!.principal] }));
    }
    tooFast(await dewi.members(secret, { add: [others[6]!.principal] }), 'an eleventh change of who is in a room in a minute');

    // People's meetings: twenty set or changed a minute.
    const startsAt = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString();
    const top = await said(dewi, room, 'Rapat stok');
    const meeting = ok(await dewi.post(`/rooms/${room}/people-meetings`, { messageId: top, startsAt, minutes: 30, attendees: [seat.principal, 'owner'] })).meeting;
    for (let n = 1; n < 20; n += 1) {
      ok(await dewi.post(`/rooms/${room}/people-meetings/${meeting.id}`, { minutes: 30 + n }), `meeting change ${n}`);
    }
    tooFast(await dewi.post(`/rooms/${room}/people-meetings/${meeting.id}`, { minutes: 60 }), 'a twenty-first change of a meeting in a minute');

    // One person's minute is theirs: the owner is not held by Dewi's.
    ok(await owner.makeRoom({ name: 'milik-pemilik' }));
  } finally {
    await api.close();
  }
});

test("the rest of the rooms' writes are held to a person's minute too, a viewer's as well", async () => {
  // Joining and leaving each take the company's room clock and tell every
  // console, and so do a room's name, its settings, a read mark, a follow and
  // a removal: a seat that sent them without end kept every post of the
  // company waiting behind its own (STATUS 2.217).
  const { fixture, api, owner } = await workspace('limits-the-rest');
  try {
    const viewer = await seated(fixture, 'Sari', 'viewer');
    const sari = personIn(api, viewer.token, fixture.companyId);
    const member = await seated(fixture, 'Dewi', 'member');
    const dewi = personIn(api, member.token, fixture.companyId);
    const company = await companyRoomOf(owner);
    await companyRoomOf(sari);
    await companyRoomOf(dewi);
    const tooFast = (answer: { status: number; body: any }, what: string) => refusedWith(answer, 429, 'workspace.too_fast', what);
    const open = String(ok(await owner.makeRoom({ name: 'umum' })).room.id);

    // Joining and leaving: twenty a minute, each way counted.
    for (let n = 0; n < 10; n += 1) {
      ok(await sari.join(open), `join ${n}`);
      ok(await sari.leave(open), `leave ${n}`);
    }
    tooFast(await sari.join(open), 'a twenty-first join or leave in a minute');

    // How a room tells her, and following a thread: sixty a minute between them.
    const root = await said(owner, company, 'Siapa yang ikut rapat?');
    for (let n = 0; n < 30; n += 1) {
      ok(await sari.settings(company, { notify: n % 2 === 0 ? 'mentions' : 'all' }), `settings ${n}`);
      ok(await sari.post(`/rooms/${company}/threads/${root}/follow`, { on: n % 2 === 0 }), `follow ${n}`);
    }
    tooFast(await sari.settings(company, { notify: 'none' }), 'a sixty-first change of how a room tells her');
    tooFast(await sari.post(`/rooms/${company}/threads/${root}/follow`, { on: true }), 'nor a follow past them');

    // Read marks: one hundred and twenty a minute.
    const position = Number(ok(await sari.page(company)).messages.at(-1).position);
    for (let n = 0; n < 120; n += 1) ok(await sari.read(company, { position }), `read ${n}`);
    tooFast(await sari.read(company, { position }), 'a hundred and twenty-first read mark in a minute');

    // A room's name, what it is about and the work it shows, and archiving it: ten a minute.
    const hers = String(ok(await dewi.makeRoom({ name: 'gudang' })).room.id);
    for (let n = 1; n <= 9; n += 1) ok(await dewi.post(`/rooms/${hers}`, { about: `Stok ke-${n}.` }), `change ${n}`);
    ok(await dewi.post(`/rooms/${hers}/archive`), 'archiving counted as a change');
    tooFast(await dewi.post(`/rooms/${hers}`, { about: 'Lagi.' }), 'an eleventh change of a room in a minute, before the database is asked');

    // Removing her own messages: counted with her edits, twenty a minute.
    const mine: string[] = [];
    for (let n = 0; n < 21; n += 1) mine.push(await said(dewi, company, `Catatan ${n}.`));
    for (let n = 0; n < 20; n += 1) ok(await dewi.on(company, mine[n]!, 'delete'), `delete ${n}`);
    tooFast(await dewi.on(company, mine[20]!, 'delete'), 'a twenty-first removal in a minute');

    // Her profile: ten changes a minute.
    for (let n = 0; n < 10; n += 1) ok(await api.call('POST', '/api/me/profile', viewer.token, { noticesPerDay: 10 + n }), `profile ${n}`);
    tooFast(await api.call('POST', '/api/me/profile', viewer.token, { noticesPerDay: 50 }), 'an eleventh change of her profile in a minute');

    // One person's minute is theirs: the owner is not held by Sari's or Dewi's.
    ok(await owner.join(open));
    ok(await owner.read(company, { position }));
    ok(await api.call('POST', '/api/me/profile', owner.token, { noticesPerDay: 20 }));
  } finally {
    await api.close();
  }
});

test('a reaction the database kept that is no longer one can still be taken back by its own words', async () => {
  // The database's check is looser than the server's: a symbol in its text
  // form, or a star, written before the server held a reaction to one emoji,
  // stayed for good and counted towards a person's ten, since taking one back
  // asked the server to read it as an emoji first (STATUS 2.217).
  const { fixture, api, owner } = await workspace('limits-take-back');
  try {
    const seat = await seated(fixture, 'Rina', 'member');
    const rina = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(rina);
    const words = await said(owner, room, 'Siapa yang bisa lembur?');
    await withPeople(fixture.companyId, { principal: seat.principal, name: 'Rina' }, async (tx) => {
      for (const emoji of ['★', '❤', '©']) {
        await tx.query('INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, $3, $4)',
          [fixture.companyId, words, seat.principal, emoji]);
      }
    });
    for (const emoji of ['★', '❤', '©']) ok(await rina.on(room, words, 'react', { emoji, on: false }), `${emoji} taken back`);
    const { rows } = await withControlPlane((tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM room_reactions WHERE message_id = $1', [words]));
    assert.equal(rows[0]!.n, 0, 'nothing is left under the message');
    // What is no reaction at all is still refused, either way.
    refusedWith(await rina.on(room, words, 'react', { emoji: '★', on: true }), 400, 'reaction.not_emoji');
    refusedWith(await rina.on(room, words, 'react', { emoji: 'x'.repeat(65), on: false }), 400, 'reaction.not_emoji');
  } finally {
    await api.close();
  }
});

test("a company's room files are held to a limit the owner sets, and the owner reads what is kept", async () => {
  const { fixture, api, owner } = await workspace('limits-files');
  try {
    const room = await companyRoomOf(owner);
    const file = (name: string, kilobytes: number) => ({ name, data: Buffer.alloc(kilobytes * 1024, 7).toString('base64') });
    assert.deepEqual(ok(await owner.get('/room-files/limit')), { usedBytes: 0, megabytes: 10_240 }, 'ten gigabytes until the owner says otherwise');
    refusedWith(await owner.post('/room-files/limit', { megabytes: 0 }), 400, 'contract.violation');
    ok(await owner.post('/room-files/limit', { megabytes: 1 }));
    ok(await owner.say(room, { body: 'Lampiran satu.', files: [file('satu.bin', 600)] }));
    const refused = await owner.say(room, { body: 'Lampiran dua.', files: [file('dua.bin', 600)] });
    refusedWith(refused, 409, 'room.files_full', 'past the limit');
    assert.equal(refused.body.details.megabytes, 1);
    assert.deepEqual(ok(await owner.get('/room-files/limit')).usedBytes, 600 * 1024, 'the refused post kept nothing');
    ok(await owner.post('/room-files/limit', { megabytes: 2 }));
    ok(await owner.say(room, { body: 'Lampiran dua.', files: [file('dua.bin', 600)] }), 'kept once the owner raised it');
    // A seat neither reads nor sets it.
    const seat = await seated(fixture, 'Agus', 'approver');
    const agus = personIn(api, seat.token, fixture.companyId);
    refusedWith(await agus.get('/room-files/limit'), 403, 'staff.forbidden');
    refusedWith(await agus.post('/room-files/limit', { megabytes: 100 }), 403, 'staff.forbidden');
    const { rows } = await withControlPlane((tx) => tx.query<{ room_files_megabytes: number }>(
      'SELECT room_files_megabytes FROM companies WHERE id = $1', [fixture.companyId]));
    assert.equal(rows[0]!.room_files_megabytes, 2);
  } finally {
    await api.close();
  }
});

test('a retry key belongs to the room it was posted in: another room posts anew, another thread is refused by name', async () => {
  const { fixture, api, owner } = await workspace('limits-client-id');
  try {
    const seat = await seated(fixture, 'Wati', 'member');
    const wati = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(wati);
    const secret = String(ok(await owner.makeRoom({ name: 'keuangan', private: true, members: [seat.principal] })).room.id);
    const first = ok(await wati.post(`/rooms/${secret}/messages`, { body: 'Laporan rahasia.', clientId: 'phone-1' })).message;
    // The same key again in the same room is a retry: the same message.
    assert.equal(ok(await wati.post(`/rooms/${secret}/messages`, { body: 'Laporan rahasia.', clientId: 'phone-1' })).message.id, first.id);
    // In another room it is new words there, never the private room's message.
    const elsewhere = ok(await wati.post(`/rooms/${room}/messages`, { body: 'Halo semua.', clientId: 'phone-1' })).message;
    assert.notEqual(elsewhere.id, first.id);
    assert.equal(elsewhere.roomId, room);
    assert.equal(elsewhere.body, 'Halo semua.');
    // In another thread of the same room it is refused by name, never answered with the other message.
    const root = await said(owner, secret, 'Akar.');
    refusedWith(await wati.post(`/rooms/${secret}/messages`, { body: 'Balasan.', clientId: 'phone-1', threadOf: root }),
      409, 'message.client_id_used');
    // And once she has lost the room, the key is hers to use in any other room, never refused with the database's words.
    ok(await owner.members(secret, { remove: [seat.principal] }));
    const third = String(ok(await owner.makeRoom({ name: 'umum' })).room.id);
    ok(await wati.join(third));
    const again = ok(await wati.post(`/rooms/${third}/messages`, { body: 'Masih bisa.', clientId: 'phone-1' })).message;
    assert.equal(again.roomId, third);
  } finally {
    await api.close();
  }
});

test("the room files limit travels in the archive, and a word an older archive kept as a reaction is left out", async () => {
  const { exportCompany } = await import('../../src/audit/export.ts');
  const { importCompany } = await import('../../src/audit/import.ts');
  const { fixture, api, owner } = await workspace('limits-archive');
  try {
    const room = await companyRoomOf(owner);
    const words = await said(owner, room, 'Arsip ini.');
    ok(await owner.on(room, words, 'react', { emoji: '👍', on: true }));
    ok(await owner.post('/room-files/limit', { megabytes: 2048 }));
    const lines: Array<{ section: string; row: Record<string, unknown> }> = [];
    await exportCompany(fixture.companyId, (line) => { lines.push(line); });
    // An archive written before a reaction was one emoji.
    lines.push({ section: 'room_reactions', row: { message_id: words, principal: 'owner', emoji: 'FIRED', created_at: new Date().toISOString() } });
    const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
    const { rows } = await withControlPlane((tx) => tx.query<{ megabytes: number; emoji: string[] }>(
      `SELECT c.room_files_megabytes AS megabytes, ARRAY(SELECT emoji FROM room_reactions WHERE company_id = c.id) AS emoji
         FROM companies c WHERE c.id = $1`, [restored.companyId]));
    assert.deepEqual(rows[0], { megabytes: 2048, emoji: ['👍'] });
  } finally {
    await api.close();
  }
});

test('a person past their minute of messages is refused before their post is read', async () => {
  const { fixture, api } = await workspace('limits-admit');
  try {
    const seat = await seated(fixture, 'Joko', 'member');
    const joko = personIn(api, seat.token, fixture.companyId);
    const room = await companyRoomOf(joko);
    for (let n = 0; n < 30; n += 1) ok(await joko.say(room, `Pesan ${n}.`));
    // A body that is not even JSON: refused for the rate, never read far enough to be refused as malformed.
    const response = await fetch(`${api.url}/api/companies/${fixture.companyId}/rooms/${room}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${seat.token}`, 'content-type': 'application/json' }, body: 'not json at all',
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json() as { code: string }).code, 'room.too_fast');
  } finally {
    await api.close();
  }
});
