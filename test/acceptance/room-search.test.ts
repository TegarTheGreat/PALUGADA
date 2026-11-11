/**
 * Finding what was said in the rooms (F19.14; STATUS section 2.212).
 *
 * A person searches the words of the rooms they may see, and the names of the
 * files said there, in one company; the owner also searches every company at
 * once. Both run as the person, through the database's own rule of who sees
 * which room, so a private room, a direct conversation the reader is not in,
 * and another company are never found, whatever is typed. What is typed is
 * taken as it is: `%` and `_` are characters, not patterns. The general search
 * the owner's assistant may read never carries a message.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
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

async function workspace(slug: string, files = false): Promise<{ fixture: Fixture; api: Console; owner: PersonIn }> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings(files ? { files: { root: await mkdtemp(join(tmpdir(), 'palugada-search-')) } } : {});
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner };
}

type Hit = {
  roomId: string; messageId: string; threadOf: string | null; position: number; excerpt: string;
  author: { principal: string; name: string | null }; at: string; file: { id: string; name: string } | null;
};

/** What a person's search of one company finds. */
async function search(person: PersonIn, query: string): Promise<Hit[]> {
  return ok(await person.get(`/room-search?q=${encodeURIComponent(query)}`), `searching ${query}`).hits as Hit[];
}

async function topic(by: PersonIn, name: string, isPrivate: boolean, members: string[] = []): Promise<string> {
  return String(ok(await by.makeRoom({ name, private: isPrivate, members }), `making ${name}`).room.id);
}

test('a person finds messages only in rooms they may see', async () => {
  const { fixture, api, owner } = await workspace('search-visible');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const open = await companyRoomOf(owner);
    const secret = await topic(owner, 'pemasok', true, [sari.principal]);
    const said1 = await said(owner, open, 'Kopi arabika dari Gayo sudah datang.');
    const said2 = await said(owner, secret, 'Harga arabika naik minggu depan.');

    const forBudi = await search(budiIn, 'arabika');
    assert.deepEqual(forBudi.map((hit) => hit.messageId), [said1], 'the open room only: the private room is not his');
    assert.equal(forBudi[0]!.roomId, open);
    assert.equal(forBudi[0]!.author.principal, 'owner');
    assert.match(forBudi[0]!.excerpt, /arabika/);

    const forSari = await search(sariIn, 'arabika');
    assert.deepEqual(forSari.map((hit) => hit.messageId), [said2, said1], 'newest first, the private room she is in included');
    // A room named that the reader cannot see finds nothing, and says nothing of it.
    assert.deepEqual(ok(await budiIn.get(`/room-search?q=arabika&room=${secret}`)).hits, []);
    assert.deepEqual((ok(await sariIn.get(`/room-search?q=arabika&room=${secret}`)).hits as Hit[]).map((hit) => hit.messageId), [said2]);
    // By who said it.
    const fromSari = await said(sariIn, open, 'Arabika yang kemarin enak.');
    assert.deepEqual((ok(await budiIn.get(`/room-search?q=arabika&from=${encodeURIComponent(sari.principal)}`)).hits as Hit[])
      .map((hit) => hit.messageId), [fromSari]);
    // A reply names its thread, so it opens where it is read.
    const reply = await said(budiIn, open, { body: 'Arabika Gayo atau Toraja?', threadOf: said1 });
    const replyHit = (await search(budiIn, 'Toraja'))[0]!;
    assert.deepEqual([replyHit.messageId, replyHit.threadOf], [reply, said1]);

    // Two characters at least, two hundred at most.
    refusedWith(await budiIn.get('/room-search?q=a'), 400, 'contract.violation');
    refusedWith(await budiIn.get(`/room-search?q=${'a'.repeat(201)}`), 400, 'contract.violation');

    // Twenty a page, newest first, and the next page from the last position.
    for (let n = 1; n <= 23; n += 1) await said(owner, open, `catatan gudang nomor ${n}`);
    const first = ok(await owner.get('/room-search?q=catatan%20gudang'));
    assert.equal(first.hits.length, 20);
    assert.match(first.hits[0].excerpt, /nomor 23/);
    const next = ok(await owner.get(`/room-search?q=catatan%20gudang&before=${first.before}`));
    assert.deepEqual((next.hits as Hit[]).map((hit) => hit.excerpt.match(/nomor (\d+)/)![1]), ['3', '2', '1']);
    assert.equal(next.before, null, 'nothing further back');
  } finally {
    await api.close();
  }
});

test('naming a person alone finds everything they said that the reader may see, newest first, as from: does in Slack', async () => {
  const { fixture, api, owner } = await workspace('search-from-alone');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const open = await companyRoomOf(owner);
    await companyRoomOf(sariIn);
    const secret = await topic(owner, 'pemasok', true, [sari.principal]);
    const first = await said(sariIn, open, 'Stok susu tinggal dua.');
    const hidden = await said(sariIn, secret, 'Pemasok baru minta DP.');
    const last = await said(sariIn, open, 'Saya pesan besok.');
    await said(owner, open, 'Terima kasih.');

    const fromSari = (ok(await budiIn.get(`/room-search?q=&from=${encodeURIComponent(sari.principal)}`), 'everything Sari said').hits as Hit[]);
    assert.deepEqual(fromSari.map((hit) => hit.messageId), [last, first], 'newest first, and nothing of a room Budi cannot see');
    assert.equal(fromSari[0]!.excerpt, 'Saya pesan besok.', 'with the start of the words');
    assert.deepEqual((ok(await sariIn.get(`/room-search?from=${encodeURIComponent(sari.principal)}&room=${secret}`)).hits as Hit[])
      .map((hit) => hit.messageId), [hidden], 'narrowed to a room as well');
    // Words are still needed when nobody is named, and one letter is still too few.
    refusedWith(await budiIn.get('/room-search?q='), 400, 'contract.violation');
    refusedWith(await budiIn.get(`/room-search?q=&room=${open}`), 400, 'contract.violation');
    refusedWith(await budiIn.get(`/room-search?q=s&from=${encodeURIComponent(sari.principal)}`), 400, 'contract.violation');
    refusedWith(await api.call('GET', '/api/room-search?q=', owner.token), 400, 'contract.violation');
  } finally {
    await api.close();
  }
});

test("a seat's search never reaches a direct room it is not in, nor another company", async () => {
  const { fixture, api, owner } = await workspace('search-direct');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'approver');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const pair = String(ok(await owner.direct([sari.principal])).room.id);
    await said(owner, pair, 'Rahasia: kita buka cabang di Medan.');
    assert.deepEqual(await search(budiIn, 'Rahasia'), [], 'not his conversation');
    assert.equal((await search(personIn(api, sari.token, fixture.companyId), 'Rahasia')).length, 1);

    const other = await createCompany('search-other');
    const outsider = await seated(other, 'Tono', 'member');
    const tonoIn = personIn(api, outsider.token, other.companyId);
    await said(tonoIn, await companyRoomOf(tonoIn), 'Rahasia perusahaan lain.');
    assert.deepEqual(await search(budiIn, 'Rahasia'), [], 'another company is never searched from this one');
    refusedWith(await api.call('GET', `/api/companies/${other.companyId}/room-search?q=Rahasia`, budi.token), 403, 'staff.forbidden');
    // The owner's search across companies is the owner's.
    refusedWith(await api.call('GET', '/api/room-search?q=Rahasia', budi.token), 403, 'staff.forbidden');
  } finally {
    await api.close();
  }
});

test('the owner\'s search across companies finds messages, and no direct message they are not in', async () => {
  const { fixture, api, owner } = await workspace('search-across');
  try {
    const other = await createCompany('search-across-b');
    const ownerB = personIn(api, owner.token, other.companyId);
    const inA = await said(owner, await companyRoomOf(owner), 'Stok gula pasir menipis.');
    const inB = await said(ownerB, await companyRoomOf(ownerB), 'Gula pasir dari pemasok baru.');
    const budi = await seated(other, 'Budi', 'member');
    const sari = await seated(other, 'Sari', 'member');
    const budiIn = personIn(api, budi.token, other.companyId);
    const theirs = String(ok(await budiIn.direct([sari.principal])).room.id);
    await said(budiIn, theirs, 'Gula pasir ini untuk kita berdua saja.');

    const found = ok(await api.call('GET', `/api/room-search?q=${encodeURIComponent('gula pasir')}`, owner.token)).found as Array<{
      companyId: string; company: string; hits: Hit[];
    }>;
    const byCompany = new Map(found.map((one) => [one.companyId, one.hits.map((hit) => hit.messageId)]));
    assert.deepEqual(byCompany.get(fixture.companyId), [inA]);
    assert.deepEqual(byCompany.get(other.companyId), [inB], 'two seats\' conversation is not the owner\'s to read');
    assert.ok(found.every((one) => one.company.length > 0), 'each company is named');
    refusedWith(await api.call('GET', '/api/room-search?q=g', owner.token), 400, 'contract.violation');
  } finally {
    await api.close();
  }
});

test('the general search finds no message', async () => {
  const { api, owner } = await workspace('search-general');
  try {
    await said(owner, await companyRoomOf(owner), 'zebra-ungu-tujuh di gudang belakang');
    const general = ok(await api.call('GET', `/api/search?q=${encodeURIComponent('zebra-ungu-tujuh')}`, owner.token));
    assert.deepEqual(general.hits, [], 'what the assistant may read carries no person\'s words');
    assert.equal((await search(owner, 'zebra-ungu-tujuh')).length, 1, 'the rooms\' own search finds it');
  } finally {
    await api.close();
  }
});

test('a deleted message is not found', async () => {
  const { api, owner } = await workspace('search-deleted');
  try {
    const room = await companyRoomOf(owner);
    const gone = await said(owner, room, 'Password wifi: kopi-susu-2026');
    assert.equal((await search(owner, 'kopi-susu')).length, 1);
    ok(await owner.on(room, gone, 'delete'));
    assert.deepEqual(await search(owner, 'kopi-susu'), []);
  } finally {
    await api.close();
  }
});

test('a search for 50% is a search for fifty per cent', async () => {
  const { api, owner } = await workspace('search-literal');
  try {
    const room = await companyRoomOf(owner);
    const half = await said(owner, room, 'Diskon 50% untuk pelanggan lama.');
    await said(owner, room, 'Diskon 500 rupiah per gelas.');
    await said(owner, room, 'Kode promo A1B dan AxB.');
    const under = await said(owner, room, 'Kode promo A_B berlaku besok.');
    assert.deepEqual((await search(owner, '50%')).map((hit) => hit.messageId), [half]);
    assert.deepEqual((await search(owner, 'A_B')).map((hit) => hit.messageId), [under], 'an underscore is an underscore');
    assert.deepEqual(await search(owner, 'n 5%'), []);
  } finally {
    await api.close();
  }
});

test('a file is found by its name', async () => {
  const { api, owner } = await workspace('search-files', true);
  try {
    const room = await companyRoomOf(owner);
    const data = Buffer.from('%PDF-1.4\n% laporan\n').toString('base64');
    const carried = String(ok(await owner.say(room, { body: 'Ini laporannya.', files: [{ name: 'laporan-kuartal-tiga.pdf', data }] })).message.id);
    assert.deepEqual(await search(owner, 'kuartal'), [], 'file names are searched only when asked for');
    const hits = ok(await owner.get('/room-search?q=kuartal&files=1')).hits as Hit[];
    assert.deepEqual(hits.map((hit) => hit.messageId), [carried]);
    assert.equal(hits[0]!.file?.name, 'laporan-kuartal-tiga.pdf');
    // A message found by its words carries no file, even when it has one.
    assert.equal((ok(await owner.get('/room-search?q=laporannya&files=1')).hits as Hit[])[0]!.file, null);
  } finally {
    await api.close();
  }
});

test("a room's pinned messages are read with what they say, by those who may see the room", async () => {
  const { fixture, api, owner } = await workspace('search-pins');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const room = await topic(owner, 'jadwal', true, [sari.principal]);
    const first = await said(owner, room, 'Jadwal piket ada di sini.');
    const second = await said(sariIn, room, 'Nomor darurat: 112.');
    await said(owner, room, 'Ini tidak disematkan.');
    ok(await owner.on(room, first, 'pin', { on: true }));
    ok(await sariIn.on(room, second, 'pin', { on: true }));
    const pins = ok(await sariIn.get(`/rooms/${room}/pins`)).messages as Array<{ id: string; body: string; author: { principal: string } }>;
    assert.deepEqual(pins.map((one) => [one.id, one.body]), [[first, 'Jadwal piket ada di sini.'], [second, 'Nomor darurat: 112.']]);
    refusedWith(await budiIn.get(`/rooms/${room}/pins`), 404, 'room.not_visible');
  } finally {
    await api.close();
  }
});
