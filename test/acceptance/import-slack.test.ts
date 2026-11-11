/**
 * A Slack workspace's history brought in (F19.23; STATUS section 2.214).
 *
 * The owner uploads a Slack export in parts, kept until it is read in the
 * company's people folder, where no agent capability reaches. The worker
 * reads it: each channel becomes a topic room (a private one stays private,
 * with the owner and the seats its old people are linked to), each thread a
 * thread one level deep, each reaction a reaction, each person an author of
 * the old workspace who can be linked to a seat later, and each file its
 * name. Direct messages are counted and left out. It is written in importing
 * mode, so nothing is new to anyone, and a second import of the same export
 * adds nothing. A ZIP that unpacks past what PALUGADA reads is refused.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withPeople } from '../../src/db/tenant.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { codeCompute } from '../../src/capabilities/compute.ts';
import { filesList, filesRead, readCompanyFile } from '../../src/capabilities/files.ts';
import { imageDescribe, VISION_PROVIDERS } from '../../src/capabilities/vision.ts';
import { Engine } from '../../src/engine/engine.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { closeCompany, eraseDueCompanies } from '../../src/governance/closing.ts';
import { planNotices } from '../../src/owner/member-notify.ts';
import { peopleFilesFolder } from '../../src/owner/route.ts';
import { runRetention } from '../../src/retention/retention.ts';
import { Worker } from '../../src/worker.ts';
import { readImports } from '../../src/workspace/import-slack.ts';
import { openZip } from '../../src/workspace/zip.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { companyRoomOf, ok, personIn, refusedWith, seated, type Console, type PersonIn } from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

// ---------------------------------------------------------------------------
// A ZIP, written here as a Slack export is: deflated entries, and the ZIP64
// end records once there are more than 65,535 of them, as a large export has.

interface Entry {
  name: string;
  data: Buffer | string;
  /** Kept as it is rather than deflated. */
  stored?: boolean;
  /** Its compressed bytes damaged, as a part cut short in transit leaves one. */
  broken?: boolean;
}

function zipOf(entries: readonly Entry[]): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    let packed = entry.stored ? data : deflateRawSync(data);
    if (entry.broken) {
      packed = Buffer.from(packed);
      packed.fill(0xff, 0, Math.min(6, packed.length));
    }
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    out.push(local, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(45, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const many = entries.length > 0xffff;
  if (many) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(entries.length), 24);
    end64.writeBigUInt64LE(BigInt(entries.length), 32);
    end64.writeBigUInt64LE(BigInt(directory.length), 40);
    end64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    out.push(directory, end64, locator);
  } else {
    out.push(directory);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(many ? 0xffff : entries.length, 8);
  end.writeUInt16LE(many ? 0xffff : entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(many ? 0xffffffff : offset, 16);
  out.push(end);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// A small Slack workspace: three people and a bot, two open channels and a
// private one, a direct conversation and a group one.

const json = (value: unknown) => JSON.stringify(value);

const USERS = [
  { id: 'U01AYU', name: 'ayu', real_name: 'Ayu Lestari', profile: { real_name: 'Ayu Lestari', display_name: 'ayu' } },
  { id: 'U02BUDI', name: 'budi', real_name: 'Budi Santoso', profile: { real_name: 'Budi Santoso', display_name: 'budi' } },
  { id: 'U03CICI', name: 'cici', real_name: 'Cici Paramida', profile: { real_name: 'Cici Paramida', display_name: 'cici' } },
];

const CHANNELS = [
  { id: 'C01GEN', name: 'general', created: 1700000000, is_general: true, members: ['U01AYU', 'U02BUDI', 'U03CICI'], purpose: { value: 'Everything, everyone' } },
  { id: 'C02DEV', name: 'dev', created: 1700000100, members: ['U01AYU', 'U02BUDI'], purpose: { value: '' }, topic: { value: 'Builds and bugs' } },
];

const BOARD = { id: 'G01BRD', name: 'board', created: 1700000200, is_private: true, members: ['U01AYU', 'U03CICI'], purpose: { value: 'Board only' } };
const OPS = { id: 'G03OPS', name: 'ops', created: 1700000300, is_private: true, members: ['U01AYU'], purpose: { value: '' } };

const GENERAL_DAY_ONE = [
  { type: 'message', subtype: 'channel_join', user: 'U03CICI', text: '<@U03CICI> has joined the channel', ts: '1709280000.000100' },
  {
    type: 'message', user: 'U01AYU', ts: '1709280060.000200', thread_ts: '1709280060.000200', reply_count: 2,
    text: 'Morning <@U02BUDI>! See <#C02DEV|dev> and <https://example.com/plan|the plan> &amp; the notes.',
    reactions: [{ name: '+1', users: ['U02BUDI', 'U03CICI'], count: 2 }, { name: 'tada', users: ['U02BUDI'], count: 1 }],
  },
  { type: 'message', user: 'U02BUDI', text: 'On it.', ts: '1709280120.000300', thread_ts: '1709280060.000200', parent_user_id: 'U01AYU' },
  { type: 'message', subtype: 'thread_broadcast', user: 'U03CICI', text: 'Done, see the thread.', ts: '1709280180.000400', thread_ts: '1709280060.000200' },
  { type: 'message', subtype: 'bot_message', bot_id: 'B01DPL', username: 'deploybot', text: 'Deployed v1.2', ts: '1709280240.000500' },
  {
    type: 'message', user: 'U01AYU', text: 'The plan, as promised.', ts: '1709280300.000600',
    files: [{ id: 'F01PLAN', name: 'plan.pdf', title: 'plan.pdf', mimetype: 'application/pdf', size: 48213,
      url_private: 'https://files.slack.com/files-pri/T01-F01PLAN/plan.pdf' }],
  },
];

/** The export as a list of entries; `more` is added at the end, `groups` replaces the private channels. */
function slackExport(options: { more?: Entry[]; groups?: unknown[]; leave?: string[] } = {}): Entry[] {
  const entries: Entry[] = [
    { name: 'users.json', data: json(USERS) },
    { name: 'channels.json', data: json(CHANNELS) },
    { name: 'groups.json', data: json(options.groups ?? [BOARD, OPS]) },
    { name: 'dms.json', data: json([{ id: 'D01AB', created: 1700000400, members: ['U01AYU', 'U02BUDI'] }]) },
    { name: 'mpims.json', data: json([{ id: 'G09MP', name: 'mpdm-ayu--budi--cici-1', created: 1700000500, members: ['U01AYU', 'U02BUDI', 'U03CICI'] }]) },
    { name: 'general/', data: '', stored: true },
    { name: 'general/2024-03-01.json', data: json(GENERAL_DAY_ONE) },
    { name: 'general/2024-03-02.json', data: json([{ type: 'message', user: 'U02BUDI', text: 'Refund every order from May.', ts: '1709366400.000100' }]) },
    { name: 'dev/2024-03-01.json', data: json([{ type: 'message', user: 'U02BUDI', text: 'Build is green.', ts: '1709280400.000100' }]) },
    {
      name: 'board/2024-03-01.json',
      data: json([{ type: 'message', user: 'U03CICI', text: 'Budget for Q2 is approved.', ts: '1709280500.000100',
        reactions: [{ name: 'white_check_mark', users: ['U01AYU'], count: 1 }] }]),
    },
    { name: 'ops/2024-03-01.json', data: json([{ type: 'message', user: 'U01AYU', text: 'Night shift starts at ten.', ts: '1709280550.000100' }]) },
    {
      name: 'D01AB/2024-03-01.json',
      data: json([
        { type: 'message', user: 'U01AYU', text: 'psst, salary talk', ts: '1709280600.000100' },
        { type: 'message', user: 'U02BUDI', text: 'later', ts: '1709280660.000100' },
      ]),
    },
    { name: 'mpdm-ayu--budi--cici-1/2024-03-01.json', data: json([{ type: 'message', user: 'U03CICI', text: 'group secret', ts: '1709280700.000100' }]) },
  ];
  return [...entries.filter((entry) => !(options.leave ?? []).includes(entry.name)), ...(options.more ?? [])];
}

// ---------------------------------------------------------------------------

interface Workspace {
  fixture: Fixture;
  api: Console;
  owner: PersonIn;
  root: string;
  folder: string;
}

async function workspace(slug: string): Promise<Workspace> {
  const fixture = await createCompany(slug);
  const root = await mkdtemp(join(tmpdir(), 'palugada-import-slack-'));
  const api = await consoleWithSettings({ files: { root } });
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner, root, folder: peopleFilesFolder({ root }, fixture.companyId)! };
}

/** Uploads an export in parts of `partBytes`, as the console does, and answers the import's id. */
async function upload(ws: Workspace, zip: Buffer, partBytes = zip.length): Promise<string> {
  const parts = Math.max(1, Math.ceil(zip.length / partBytes));
  const made = ok(await ws.owner.post('/room-imports', { source: 'slack', parts }), 'starting an import').import;
  for (let index = 0; index < parts; index += 1) {
    const part = zip.subarray(index * partBytes, (index + 1) * partBytes);
    ok(await ws.owner.post(`/room-imports/${made.id}/parts`, { index, base64: part.toString('base64') }), `part ${index}`);
  }
  return String(made.id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = any;

/** Uploads an export, lets the reading step read it, and answers the import as the owner reads it. */
async function imported(ws: Workspace, entries: readonly Entry[], partBytes?: number): Promise<Report> {
  const id = await upload(ws, zipOf(entries), partBytes);
  await readImports(ws.fixture.companyId, { filesRoot: ws.root });
  return ok(await ws.owner.get(`/room-imports/${id}`)).import;
}

type ListedRoom = { id: string; kind: string; name: string | null; private: boolean; joined: boolean; archived: boolean; unread: number; mentions: number };

/** The topic rooms a person is in, by name; with `browse`, every one they may see. */
async function roomsOf(person: PersonIn, browse = false): Promise<Map<string, ListedRoom>> {
  const { rooms } = ok(await person.rooms(browse));
  return new Map((rooms as ListedRoom[]).filter((room) => room.kind === 'topic').map((room) => [room.name!, room]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type View = any;

async function pageOf(person: PersonIn, roomId: string): Promise<View[]> {
  return ok(await person.page(roomId)).messages as View[];
}

/** How much of each room table the company has, and where its clock stands. */
async function tally(companyId: string): Promise<Record<string, number>> {
  return withControlPlane(async (tx) => {
    const counted: Record<string, number> = {};
    for (const table of ['rooms', 'room_members', 'room_messages', 'room_reactions', 'room_files', 'room_former_people', 'room_feed']) {
      counted[table] = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]!.n);
    }
    counted.clock = Number((await tx.query<{ position: string }>(
      'SELECT position FROM room_clock WHERE company_id = $1', [companyId])).rows[0]?.position ?? 0);
    return counted;
  });
}

async function gone(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

// ---------------------------------------------------------------------------

test('a Slack export becomes rooms, threads and reactions, with former people as authors', async () => {
  const ws = await workspace('slack-rooms');
  try {
    const id = await upload(ws, zipOf(slackExport()), 700);
    const waiting = ok(await ws.owner.get(`/room-imports/${id}`)).import;
    assert.equal(waiting.status, 'reading', 'every part arrived, and the reading step reads it');
    // The reading step is the worker's, as a deployment runs it.
    const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-slack' });
    const worker = new Worker({ engine, companyId: ws.fixture.companyId, erasure: { filesRoot: ws.root } });
    const tick = await worker.tick(new Date(), { runs: false });
    assert.deepEqual(tick.errors, []);
    const report = ok(await ws.owner.get(`/room-imports/${id}`)).import;
    assert.equal(report.status, 'done', JSON.stringify(report.problems));
    assert.equal(report.counts.rooms, 4);
    assert.equal(report.counts.messages, 9);
    assert.equal(report.counts.replies, 2);
    assert.equal(report.counts.reactions, 4);
    assert.equal(report.counts.files, 1);
    assert.equal(report.counts.skipped, 1, 'a join is no message anyone said');

    const rooms = await roomsOf(ws.owner);
    assert.deepEqual([...rooms.keys()].sort(), ['board', 'dev', 'general', 'ops']);
    assert.ok([...rooms.values()].every((room) => room.joined), 'the owner is in every room the import made');
    const general = rooms.get('general')!;
    assert.equal(general.private, false);
    const room = ok(await ws.owner.room(general.id)).room;
    assert.equal(room.about, 'Everything, everyone');
    assert.equal(ok(await ws.owner.room(rooms.get('dev')!.id)).room.about, 'Builds and bugs');

    const page = await pageOf(ws.owner, general.id);
    const said = page.map((one) => one.body);
    assert.deepEqual(said, [
      'Morning @Budi Santoso! See #dev and [the plan](https://example.com/plan) & the notes.',
      'Done, see the thread.',
      'Deployed v1.2',
      'The plan, as promised.',
      'Refund every order from May.',
    ], 'in the order they were said, a reply sent to the channel too, and no join');
    const root = page[0];
    assert.deepEqual(root.author, { principal: 'former:slack:U01AYU', former: true, name: 'Ayu Lestari' });
    assert.equal(root.via, 'import');
    assert.equal(root.createdAt, new Date(1709280060000).toISOString(), 'when it was said in Slack');
    assert.deepEqual(root.reactions.map((one: View) => [one.emoji, one.count, one.mine]), [['👍', 2, false], ['🎉', 1, false]]);
    assert.equal(root.replies.count, 2);
    assert.deepEqual(root.mentions, [], 'a name in the words is no mention of anyone here');
    assert.deepEqual(page[2].author, { principal: 'former:slack:B01DPL', former: true, name: 'deploybot' });
    const thread = ok(await ws.owner.thread(general.id, root.id));
    assert.deepEqual(thread.replies.map((one: View) => [one.body, one.author.name, one.threadOf]), [
      ['On it.', 'Budi Santoso', root.id],
      ['Done, see the thread.', 'Cici Paramida', root.id],
    ], 'threads one level deep');
    assert.equal(page[1].alsoInRoom, true);

    const formers = ok(await ws.owner.get('/former-people')).people as Array<{ former: string; name: string; seat: unknown; rooms: number }>;
    assert.deepEqual(formers.map((one) => [one.former, one.name, one.seat, one.rooms]), [
      ['former:slack:U01AYU', 'Ayu Lestari', null, 2],
      ['former:slack:U02BUDI', 'Budi Santoso', null, 0],
      ['former:slack:U03CICI', 'Cici Paramida', null, 1],
      ['former:slack:B01DPL', 'deploybot', null, 0],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))), 'each in the order of their names, with the private rooms they were in');
    const listed = ok(await ws.owner.get('/room-imports')).imports as Array<{ id: string; status: string }>;
    assert.deepEqual(listed.map((one) => [one.id, one.status]), [[id, 'done']]);
  } finally {
    await ws.api.close();
  }
});

test('a private channel stays private, with the owner and its linked members', async () => {
  const ws = await workspace('slack-private');
  try {
    const cici = await seated(ws.fixture, 'Cici', 'member');
    const dewi = await seated(ws.fixture, 'Dewi', 'member');
    const ciciIn = personIn(ws.api, cici.token, ws.fixture.companyId);
    const dewiIn = personIn(ws.api, dewi.token, ws.fixture.companyId);
    assert.equal((await imported(ws, slackExport())).status, 'done');
    ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U03CICI', seatId: cici.id, confirm: true }));

    // A later export brings a private channel Cici was in: she is in it from the start, and nobody else is.
    const FINANCE = { id: 'G02FIN', name: 'finance', created: 1700000600, is_private: true, members: ['U03CICI', 'U02BUDI'], purpose: { value: 'Money' } };
    const report = await imported(ws, slackExport({
      groups: [BOARD, OPS, FINANCE],
      more: [{ name: 'finance/2024-03-03.json', data: json([{ type: 'message', user: 'U02BUDI', text: 'Payroll moves to the 25th.', ts: '1709452800.000100' }]) }],
    }));
    assert.equal(report.status, 'done');
    assert.equal(report.counts.rooms, 1, 'only the room that is new');

    const owners = await roomsOf(ws.owner);
    for (const name of ['board', 'finance', 'ops']) {
      assert.equal(owners.get(name)?.private, true, `${name} stays private`);
      assert.equal(owners.get(name)?.joined, true, `the owner is in ${name}`);
    }
    const finance = owners.get('finance')!;
    const members = ok(await ws.owner.room(finance.id)).room.members as Array<{ principal: string }>;
    assert.deepEqual(members.map((one) => one.principal).sort(), ['owner', cici.principal].sort(), 'the owner and the linked seat');
    const ciciRooms = await roomsOf(ciciIn);
    assert.equal(ciciRooms.get('finance')?.joined, true);
    assert.equal(ciciRooms.get('finance')?.unread, 0, 'what is old is not new to her');
    assert.equal((await roomsOf(ciciIn, true)).has('ops'), false, 'a private room she was not in');

    const dewiRooms = await roomsOf(dewiIn, true);
    assert.deepEqual([...dewiRooms.keys()].sort(), ['dev', 'general'], 'a seat sees the open channels, and no private one');
    for (const name of ['board', 'finance', 'ops']) {
      refusedWith(await dewiIn.room(owners.get(name)!.id), 404, 'room.not_visible', name);
      refusedWith(await dewiIn.page(owners.get(name)!.id), 404, 'room.not_visible', name);
    }
    const search = ok(await dewiIn.get('/room-search?q=Payroll')).hits as unknown[];
    assert.deepEqual(search, [], 'nor finds a word of one');
  } finally {
    await ws.api.close();
  }
});

test('importing the same export twice adds nothing', async () => {
  const ws = await workspace('slack-twice');
  try {
    const zip = slackExport();
    const first = await imported(ws, zip);
    assert.equal(first.status, 'done');
    const once = await tally(ws.fixture.companyId);
    const second = await imported(ws, zip);
    assert.equal(second.status, 'done');
    assert.deepEqual([second.counts.rooms, second.counts.messages, second.counts.reactions, second.counts.files],
      [0, 0, 0, 0]);
    assert.equal(second.counts.already, first.counts.messages, 'every message is found already there');
    assert.deepEqual(await tally(ws.fixture.companyId), once, 'no row, no change and no position more');
  } finally {
    await ws.api.close();
  }
});

test('an import raises no unread, mention or Activity, and writes one change per room', async () => {
  const ws = await workspace('slack-quiet');
  try {
    await companyRoomOf(ws.owner);
    const before = await tally(ws.fixture.companyId);
    // Ayu mentions the owner's old name and @channel: words, never a mention here.
    const report = await imported(ws, slackExport({
      more: [{ name: 'general/2024-03-04.json', data: json([{ type: 'message', user: 'U01AYU', text: '<!channel> all hands at nine', ts: '1709539200.000100' }]) }],
    }));
    assert.equal(report.status, 'done');
    const unread = (ok(await ws.api.call('GET', '/api/rooms/unread', ws.owner.token)).unread as Array<{
      companyId: string; mentions: number; direct: number; rooms: number;
    }>).find((one) => one.companyId === ws.fixture.companyId)!;
    assert.deepEqual([unread.mentions, unread.direct, unread.rooms], [0, 0, 0], 'nothing imported is new to anyone');
    const activity = ok(await ws.owner.activity()).items as Array<{ kind: string }>;
    assert.deepEqual(activity.filter((item) => ['mention', 'reply', 'card'].includes(item.kind)), []);
    const rooms = await roomsOf(ws.owner);
    assert.ok([...rooms.values()].every((room) => room.unread === 0 && room.mentions === 0));
    const general = await pageOf(ws.owner, rooms.get('general')!.id);
    assert.equal(general.at(-1).body, '@channel all hands at nine');
    assert.equal(general.at(-1).mentionsRoom, false);

    const feed = await withControlPlane((tx) => tx.query<{ kind: string; room_id: string }>(
      'SELECT kind, room_id FROM room_feed WHERE company_id = $1 ORDER BY position OFFSET $2', [ws.fixture.companyId, before.room_feed]));
    assert.deepEqual(feed.rows.map((row) => row.kind), ['room', 'room', 'room', 'room'], 'one change per room, none per message');
    assert.deepEqual(new Set(feed.rows.map((row) => row.room_id)), new Set([...rooms.values()].map((room) => room.id)));
    assert.deepEqual(await planNotices(ws.fixture.companyId), { planned: 0 }, 'and nobody is told of it outside PALUGADA');
  } finally {
    await ws.api.close();
  }
});

test("a former person linked to a seat gains their seat's name and their private rooms, shown to the owner first", async () => {
  const ws = await workspace('slack-link');
  try {
    const budi = await seated(ws.fixture, 'Budi', 'member');
    const budiIn = personIn(ws.api, budi.token, ws.fixture.companyId);
    const sari = await seated(ws.fixture, 'Sari', 'member');
    assert.equal((await imported(ws, slackExport())).status, 'done');
    const owners = await roomsOf(ws.owner);
    assert.equal((await roomsOf(budiIn, true)).has('board'), false);

    // Asked first: what the seat would gain, and nothing changes yet.
    const asked = ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: budi.id }));
    assert.equal(asked.linked, false);
    assert.deepEqual(asked.rooms.map((one: { name: string }) => one.name).sort(), ['board', 'ops']);
    assert.equal((await roomsOf(budiIn, true)).has('board'), false, 'shown, not given');

    const linked = ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: budi.id, confirm: true }));
    assert.equal(linked.linked, true);
    assert.deepEqual(linked.person.seat, { id: budi.id, name: 'Budi' });
    const budis = await roomsOf(budiIn);
    assert.equal(budis.get('board')?.joined, true);
    assert.equal(budis.get('ops')?.joined, true);
    assert.equal(budis.get('board')?.unread, 0, 'old words are not new to him');
    const board = await pageOf(budiIn, owners.get('board')!.id);
    assert.equal(board[0].body, 'Budget for Q2 is approved.');
    const general = await pageOf(budiIn, owners.get('general')!.id);
    assert.deepEqual(general[0].author, { principal: 'former:slack:U01AYU', former: true, name: 'Budi' },
      "what Ayu said in Slack is drawn under the seat's name");
    const people = ok(await ws.owner.get('/former-people')).people as Array<{ former: string; seat: { id: string } | null }>;
    assert.equal(people.find((one) => one.former === 'former:slack:U01AYU')?.seat?.id, budi.id);

    // One link a person: the owner unlinks before linking them again.
    refusedWith(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: sari.id, confirm: true }),
      409, 'import.former_linked');
    refusedWith(await ws.owner.post('/former-people/link', { former: 'former:slack:U09NOBODY', seatId: sari.id }),
      400, 'contract.violation');
    // Linking and importing are the owner's.
    refusedWith(await budiIn.get('/former-people'), 403, 'staff.forbidden');
    refusedWith(await budiIn.post('/former-people/link', { former: 'former:slack:U02BUDI', seatId: budi.id, confirm: true }),
      403, 'staff.forbidden');
  } finally {
    await ws.api.close();
  }
});

test('unlinking a former person takes back the private rooms the link gave', async () => {
  const ws = await workspace('slack-unlink');
  try {
    const budi = await seated(ws.fixture, 'Budi', 'member');
    const budiIn = personIn(ws.api, budi.token, ws.fixture.companyId);
    assert.equal((await imported(ws, slackExport())).status, 'done');
    const owners = await roomsOf(ws.owner);
    // Budi was added to the board by the owner before any link: that stays his.
    ok(await ws.owner.members(owners.get('board')!.id, { add: [budi.principal] }));
    const asked = ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: budi.id }));
    assert.deepEqual(asked.rooms.map((one: { name: string }) => one.name), ['ops'], 'only what he would gain');
    ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: budi.id, confirm: true }));
    assert.equal((await roomsOf(budiIn)).get('ops')?.joined, true);

    const undone = ok(await ws.owner.post('/former-people/unlink', { former: 'former:slack:U01AYU' }));
    assert.equal(undone.person.seat, null);
    assert.deepEqual(undone.rooms.map((one: { name: string }) => one.name), ['ops']);
    const budis = await roomsOf(budiIn, true);
    assert.equal(budis.has('ops'), false, 'the room the link gave is taken back');
    assert.equal(budis.get('board')?.joined, true, 'the room he was given apart from it stays');
    const left = await withControlPlane((tx) => tx.query<{ left_by: string | null }>(
      'SELECT left_by FROM room_members WHERE company_id = $1 AND room_id = $2 AND principal = $3',
      [ws.fixture.companyId, owners.get('ops')!.id, budi.principal]));
    assert.deepEqual(left.rows, [{ left_by: 'owner' }]);
    const general = await pageOf(ws.owner, owners.get('general')!.id);
    assert.equal(general[0].author.name, 'Ayu Lestari', 'drawn under the old name again');
    // Unlinked, the person may be linked again.
    ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: budi.id, confirm: true }));
  } finally {
    await ws.api.close();
  }
});

test('a file in the export comes as its name, not its bytes', async () => {
  const ws = await workspace('slack-files');
  try {
    let fetched = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes('slack.com')) fetched += 1;
      return realFetch(input, init);
    }) as typeof fetch;
    let report: Report;
    try {
      report = await imported(ws, slackExport());
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(report.status, 'done');
    assert.equal(fetched, 0, "nothing is fetched from Slack's file addresses");
    const general = (await roomsOf(ws.owner)).get('general')!;
    const message = (await pageOf(ws.owner, general.id)).find((one) => one.body === 'The plan, as promised.');
    assert.deepEqual(message.files.map((one: View) => [one.name, one.mime, one.inline]), [['plan.pdf', 'application/pdf', false]]);
    refusedWith(await ws.owner.get(`/rooms/${general.id}/files/${message.files[0].id}`), 404, 'file.not_kept');
    const kept = await withControlPlane((tx) => tx.query<{ path: string | null; sha256: string | null }>(
      'SELECT path, sha256 FROM room_files WHERE company_id = $1', [ws.fixture.companyId]));
    assert.deepEqual(kept.rows, [{ path: null, sha256: null }]);
    assert.ok(await gone(join(ws.folder, 'rooms')), 'no bytes are kept for it');
  } finally {
    await ws.api.close();
  }
});

test('direct messages are counted and skipped, and the report says why', async () => {
  const ws = await workspace('slack-direct');
  try {
    const report = await imported(ws, slackExport());
    assert.equal(report.status, 'done');
    assert.deepEqual([report.counts.direct, report.counts.groups, report.counts.directMessages], [1, 1, 3]);
    assert.deepEqual(report.problems.filter((one: { code: string }) => one.code === 'direct_skipped'), [{ code: 'direct_skipped', count: 2 }]);
    const kept = await withControlPlane((tx) => tx.query(
      "SELECT 1 FROM room_messages WHERE company_id = $1 AND body IN ('psst, salary talk', 'later', 'group secret')", [ws.fixture.companyId]));
    assert.equal(kept.rows.length, 0, 'no word of a direct conversation is kept');
    const direct = await withControlPlane((tx) => tx.query(
      "SELECT 1 FROM rooms WHERE company_id = $1 AND (kind = 'direct' OR name LIKE 'mpdm%' OR name = 'D01AB')", [ws.fixture.companyId]));
    assert.equal(direct.rows.length, 0, 'and no room is made for one');
  } finally {
    await ws.api.close();
  }
});

test('an export with a broken part is reported line by line and imports the rest', async () => {
  const ws = await workspace('slack-broken');
  try {
    const entries = slackExport({
      leave: ['dev/2024-03-01.json'],
      more: [
        { name: 'dev/2024-03-01.json', data: json([{ type: 'message', user: 'U02BUDI', text: 'Build is green.', ts: '1709280400.000100' }]), broken: true },
        { name: 'general/2024-03-05.json', data: '{oops' },
        { name: 'general/2024-03-06.json', data: json([{ type: 'message', user: 'U01AYU', text: 'no time at all' }, { type: 'message', user: 'U01AYU', text: 'Still here.', ts: '1709712000.000100' }]) },
        { name: 'nowhere/2024-03-01.json', data: json([{ type: 'message', user: 'U01AYU', text: 'lost', ts: '1709280800.000100' }]) },
      ],
    });
    const report = await imported(ws, entries);
    assert.equal(report.status, 'done', 'what could be read is imported');
    const lines = (report.problems as Array<Record<string, unknown>>).filter((one) => one.code !== 'direct_skipped')
      .sort((a, b) => String(a.entry).localeCompare(String(b.entry)));
    assert.deepEqual(lines, [
      { code: 'unreadable', entry: 'dev/2024-03-01.json' },
      { code: 'not_json', entry: 'general/2024-03-05.json' },
      { code: 'message_skipped', entry: 'general/2024-03-06.json', count: 1 },
      { code: 'unknown_folder', entry: 'nowhere' },
    ]);
    const rooms = await roomsOf(ws.owner);
    const general = (await pageOf(ws.owner, rooms.get('general')!.id)).map((one) => one.body);
    assert.ok(general.includes('Refund every order from May.') && general.includes('Still here.'));
    assert.deepEqual(await pageOf(ws.owner, rooms.get('dev')!.id), [], 'the room is there, without what could not be read');
  } finally {
    await ws.api.close();
  }
});

test('a part that inflates past its cap is refused', async () => {
  const ws = await workspace('slack-bomb');
  try {
    const before = await tally(ws.fixture.companyId);
    // Sixteen megabytes of spaces deflate to some sixteen kilobytes: far past two hundred times.
    const bomb = Buffer.concat([Buffer.from('['), Buffer.alloc(16 * 1024 * 1024, 0x20), Buffer.from(']')]);
    const report = await imported(ws, slackExport({ more: [{ name: 'general/2024-03-07.json', data: bomb }] }));
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.problems, [{ code: 'too_large', entry: 'general/2024-03-07.json' }]);
    assert.deepEqual(await tally(ws.fixture.companyId), before, 'nothing of it is written');

    // The reader's own limits, smaller, on one entry and on the export as a whole.
    const small = zipOf([
      { name: 'a.json', data: Buffer.alloc(3000, 0x61), stored: true },
      { name: 'b.json', data: json(Array.from({ length: 200 }, (_, n) => ({ n, said: `line ${n}` }))) },
      { name: 'c.json', data: json(Array.from({ length: 200 }, (_, n) => ({ n, said: `line ${n}` }))) },
    ]);
    const source = { size: small.length, read: async (at: number, length: number) => small.subarray(at, at + length) };
    const tooLarge = (error: unknown) => isPalugadaError(error, 'import.too_large');
    const one = await openZip(source, { entryBytes: 2000 });
    await assert.rejects(one.read(one.entries[0]!), tooLarge, 'a stored entry past what one entry may be');
    const all = await openZip(source, { totalBytes: 8000 });
    await all.read(all.entries[1]!);
    await all.read(all.entries[1]!);
    await assert.rejects(all.read(all.entries[2]!), tooLarge, 'past what the whole export may unpack to');
  } finally {
    await ws.api.close();
  }
});

test('an export with more than 65,535 entries is read', async () => {
  const ws = await workspace('slack-many');
  try {
    const filler: Entry[] = Array.from({ length: 70_000 }, (_, n) => ({ name: `canvases/${String(n).padStart(5, '0')}.txt`, data: 'x', stored: true }));
    // What matters comes last, past the 65,535th entry, where a reader of the short count stops.
    const entries = [...filler, ...slackExport()];
    const report = await imported(ws, entries, 4 * 1024 * 1024);
    assert.equal(report.status, 'done', JSON.stringify(report.problems));
    assert.equal(report.counts.entries, entries.length);
    assert.equal(report.counts.messages, 9);
    assert.deepEqual([...(await roomsOf(ws.owner)).keys()].sort(), ['board', 'dev', 'general', 'ops']);
  } finally {
    await ws.api.close();
  }
});

test('the parts are deleted when the import ends, and after seven days in any case', async () => {
  const ws = await workspace('slack-parts');
  try {
    const roots = { filesRoot: ws.root };
    const importsAt = join(ws.folder, 'imports');

    // Done: the parts go as it ends.
    const done = await upload(ws, zipOf(slackExport()), 900);
    assert.ok((await readdir(join(importsAt, done))).length > 1, 'kept in parts until read');
    await readImports(ws.fixture.companyId, roots);
    assert.ok(await gone(join(importsAt, done)));
    assert.equal(ok(await ws.owner.get(`/room-imports/${done}`)).import.partsGone, true);

    // Failed: so do they.
    const failed = await upload(ws, Buffer.from('this is not a zip, only words'));
    await readImports(ws.fixture.companyId, roots);
    const refused = ok(await ws.owner.get(`/room-imports/${failed}`)).import;
    assert.deepEqual([refused.status, refused.problems, refused.partsGone], ['failed', [{ code: 'not_a_zip' }], true]);
    assert.ok(await gone(join(importsAt, failed)));

    // Never finished: kept a week, then gone, and the import says why.
    const made = ok(await ws.owner.post('/room-imports', { source: 'slack', parts: 2 })).import;
    ok(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 0, base64: Buffer.from('half an export').toString('base64') }));
    const day = 86_400_000;
    await runRetention(ws.fixture.companyId, new Date(Date.now() + day), roots);
    assert.deepEqual(await readdir(join(importsAt, made.id)), ['part-00']);
    await runRetention(ws.fixture.companyId, new Date(Date.now() + 8 * day), roots);
    assert.ok(await gone(join(importsAt, made.id)), 'gone after seven days');
    const expired = ok(await ws.owner.get(`/room-imports/${made.id}`)).import;
    assert.deepEqual([expired.status, expired.problems, expired.partsGone], ['failed', [{ code: 'parts_expired' }], true]);
    refusedWith(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 1, base64: 'aGFsZg==' }), 409, 'import.part_missing',
      'an import whose parts went takes no more');

    // And with the company, when it is erased.
    const kept = ok(await ws.owner.post('/room-imports', { source: 'slack', parts: 2 })).import;
    ok(await ws.owner.post(`/room-imports/${kept.id}/parts`, { index: 0, base64: Buffer.from('half').toString('base64') }));
    assert.equal(await gone(join(importsAt, kept.id)), false);
    await closeCompany(ws.fixture.companyId, 7);
    await withControlPlane((tx) => tx.query(
      "UPDATE companies SET closing_at = now() - interval '8 days', erase_after = now() - interval '1 day' WHERE id = $1", [ws.fixture.companyId]));
    const pass = await eraseDueCompanies(roots);
    assert.equal(pass.erased.length, 1);
    assert.ok(await gone(ws.folder));
  } finally {
    await ws.api.close();
  }
});

test('only the owner imports, part by part, in order', async () => {
  const ws = await workspace('slack-parts-order');
  try {
    const seat = await seated(ws.fixture, 'Budi', 'approver');
    const budiIn = personIn(ws.api, seat.token, ws.fixture.companyId);
    refusedWith(await budiIn.post('/room-imports', { source: 'slack', parts: 1 }), 403, 'staff.forbidden');
    refusedWith(await ws.owner.post('/room-imports', { source: 'teams', parts: 1 }), 400, 'contract.violation');
    refusedWith(await ws.owner.post('/room-imports', { source: 'slack', parts: 65 }), 400, 'contract.violation');
    const made = ok(await ws.owner.post('/room-imports', { source: 'slack', parts: 3 })).import;
    refusedWith(await budiIn.get(`/room-imports/${made.id}`), 403, 'staff.forbidden');
    refusedWith(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 1, base64: 'YWJj' }), 409, 'import.part_missing',
      'a part before it has not arrived');
    refusedWith(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 0, base64: 'not base64!' }), 400, 'contract.violation');
    refusedWith(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 3, base64: 'YWJj' }), 400, 'contract.violation');
    const first = ok(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 0, base64: 'YWJj' })).import;
    assert.deepEqual([first.received, first.status], [1, 'receiving']);
    // A part sent again, after a connection dropped, is the same part.
    const again = ok(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 0, base64: 'YWJjZA==' })).import;
    assert.equal(again.received, 1);
    refusedWith(await ws.owner.get(`/room-imports/${'0'.repeat(8)}-0000-4000-8000-000000000000`), 400, 'contract.violation',
      'no such import in this company');
  } finally {
    await ws.api.close();
  }
});

test('no agent capability reaches an import part', async () => {
  const ws = await workspace('slack-agents');
  try {
    const made = ok(await ws.owner.post('/room-imports', { source: 'slack', parts: 2 })).import;
    const secret = Buffer.from('payroll channel export, kept for the owner');
    ok(await ws.owner.post(`/room-imports/${made.id}/parts`, { index: 0, base64: secret.toString('base64') }));
    const part = join(ws.folder, 'imports', made.id, 'part-00');
    assert.equal(await gone(part), false, 'the part is kept until the import is read');
    const reaching = [
      `../${ws.fixture.companyId}.people/imports/${made.id}/part-00`,
      part,
      `../${ws.fixture.companyId}.people/imports`,
      `../${ws.fixture.companyId}.people`,
    ];
    const ctx = { companyId: ws.fixture.companyId, signal: AbortSignal.timeout(5_000) } as never;
    const refused = (error: unknown) => isPalugadaError(error, 'capability.unreachable') || isPalugadaError(error, 'contract.violation')
      || isPalugadaError(error, 'capability.unknown');
    const reachesNothing = async (attempt: Promise<unknown>, what: string) => {
      let answer: string;
      try {
        answer = JSON.stringify(await attempt);
      } catch (error) {
        assert.ok(refused(error), `${what}: ${(error as Error).message}`);
        return;
      }
      assert.ok(!answer.includes('part-00') && !answer.includes('payroll'), `${what} reached an import part`);
    };
    await reachesNothing(filesList({ root: ws.root }).execute({ path: '.' }, ctx), 'files.list .');
    for (const path of reaching) {
      await reachesNothing(filesList({ root: ws.root }).execute({ path }, ctx), `files.list ${path}`);
      await assert.rejects(filesRead({ root: ws.root }).execute({ path }, ctx), refused, `files.read ${path}`);
      await assert.rejects(readCompanyFile(ws.root, ws.fixture.companyId, path, 1_000_000, 'test'), refused, `read for a run: ${path}`);
    }
    let looked = 0;
    const describe = imageDescribe({
      provider: VISION_PROVIDERS[0]!, url: null, key: async () => 'k', model: null, root: ws.root,
      fetch: (async () => { looked += 1; throw new Error('a part was sent'); }) as typeof fetch,
    });
    for (const path of reaching) await assert.rejects(describe.execute({ path }, ctx), refused, `image.describe ${path}`);
    assert.equal(looked, 0);
    const compute = codeCompute({ root: ws.root, image: 'palugada/compute:test', docker: '/nonexistent/docker-never-started' });
    for (const path of reaching) {
      await assert.rejects(compute.execute({ code: 'print(1)', files: [path] }, ctx), refused, `code.compute ${path}`);
    }
    const page = ok(await ws.owner.get('/files'));
    assert.ok(!JSON.stringify(page).includes('part-00') && !JSON.stringify(page).includes('.people'), "the owner's Files page shows none");
  } finally {
    await ws.api.close();
  }
});

test('an imported message given as work is outside words', async () => {
  const ws = await workspace('slack-work');
  try {
    assert.equal((await imported(ws, slackExport())).status, 'done');
    const general = (await roomsOf(ws.owner)).get('general')!;
    const refund = (await pageOf(ws.owner, general.id)).find((one) => one.body === 'Refund every order from May.');
    assert.equal(refund.may.giveAsWork, true, 'it may be given, by a press');
    const given = ok(await ws.owner.on(general.id, refund.id, 'work', { target: 'company', goal: 'Refund every order from May', goalId: ws.fixture.goalId }));
    const rows = await withControlPlane(async (tx) => {
      const task = await tx.query<{ created_by: string }>('SELECT created_by FROM tasks WHERE id = $1', [given.taskId]);
      const outside = await tx.query<{ capability: string }>(
        "SELECT payload->>'capability' AS capability FROM events WHERE task_id = $1 AND type = 'content.read_outside'", [given.taskId]);
      return { task: task.rows[0]!, outside: outside.rows };
    });
    assert.equal(rows.task.created_by, 'owner', 'the owner pressed');
    assert.deepEqual(rows.outside, [{ capability: 'an imported message' }], "an old workspace's words are never the owner's own");
  } finally {
    await ws.api.close();
  }
});

test("a Slack import travels with the company's archive, and importing it again there adds nothing", async () => {
  const ws = await workspace('slack-archive');
  try {
    const budi = await seated(ws.fixture, 'Budi', 'member');
    const zip = slackExport();
    assert.equal((await imported(ws, zip)).status, 'done');
    ok(await ws.owner.post('/former-people/link', { former: 'former:slack:U01AYU', seatId: budi.id, confirm: true }));
    const lines: ArchiveLine[] = [];
    await exportCompany(ws.fixture.companyId, (line) => { lines.push(line); });
    const restored = await importCompany(lines, { slug: `${ws.fixture.slug}-restored` });
    const there: Workspace = {
      ...ws,
      fixture: { ...ws.fixture, companyId: restored.companyId },
      owner: personIn(ws.api, ws.owner.token, restored.companyId),
      folder: peopleFilesFolder({ root: ws.root }, restored.companyId)!,
    };
    const reports = ok(await there.owner.get('/room-imports')).imports as Array<{ status: string; counts: { messages: number } }>;
    assert.deepEqual(reports.map((one) => [one.status, one.counts.messages]), [['done', 9]], "the import's report travels");
    const formers = ok(await there.owner.get('/former-people')).people as Array<{ former: string; name: string; seat: unknown; rooms: number }>;
    assert.deepEqual(formers.find((one) => one.former === 'former:slack:U01AYU'), {
      former: 'former:slack:U01AYU', name: 'Ayu Lestari', seat: null, linkedAt: null, rooms: 2,
    }, 'with the private rooms she was in, restored here, and no seat of the other deployment');
    const general = (await roomsOf(there.owner)).get('general')!;
    assert.equal((await pageOf(there.owner, general.id))[0].author.name, 'Ayu Lestari');

    const before = await tally(restored.companyId);
    const again = await imported(there, zip);
    assert.equal(again.status, 'done');
    assert.deepEqual([again.counts.rooms, again.counts.messages, again.counts.reactions], [0, 0, 0]);
    assert.deepEqual(await tally(restored.companyId), before, 'every room and message is known by where it came from');
  } finally {
    await ws.api.close();
  }
});

test('only an import says where a room or a message came from, and it never changes', async () => {
  const ws = await workspace('slack-external');
  try {
    const companyId = ws.fixture.companyId;
    const room = await companyRoomOf(ws.owner);
    const owner = { principal: 'owner', name: null };
    // Nobody squats a channel's id, which would keep the import from finding its room.
    await assert.rejects(withPeople(companyId, owner, (tx) => tx.query(
      `INSERT INTO rooms (id, company_id, kind, name, created_by, external_id)
       VALUES (gen_random_uuid(), $1, 'topic', 'general', 'owner', 'slack:C01GEN')`, [companyId])), /only an import/);
    await assert.rejects(withPeople(companyId, owner, (tx) => tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, external_id)
       VALUES (gen_random_uuid(), $1, $2, 'text', 'owner', 'Morning!', 'slack:1709280060.000200')`, [companyId, room])), /only an import/);
    assert.equal((await imported(ws, slackExport())).status, 'done');
    await assert.rejects(withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, companyId, { importing: true });
      await tx.query("UPDATE rooms SET external_id = 'slack:C99' WHERE company_id = $1 AND external_id = 'slack:C01GEN'", [companyId]);
    }), /never changes/);
  } finally {
    await ws.api.close();
  }
});
