/**
 * The room stream: what a person's console hears as the rooms change, and
 * the company's work with it, on one connection per tab (F19.11; STATUS
 * section 2.210).
 *
 * A tab used to hold one stream for the company's work and poll the rooms
 * every few seconds; a second stream for the rooms would have left a browser
 * of three tabs with nothing for its requests, since HTTP/1.1 gives an origin
 * six connections. So the room stream carries the work's frames as well, read
 * once per company by a hub in each process rather than once per tab, and
 * the rooms' changes as positions and ids, never words, each to the people
 * who may see the room it happened in. These tests open the stream as the
 * console does, with fetch and a bearer token, and read its frames.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { appPool, closePools } from '../../src/db/pool.ts';
import { withControlPlane, withPeople } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { OwnerMfa } from '../../src/owner/mfa.ts';
import { metricsText } from '../../src/reporting/metrics.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
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

/** A frame as the stream sends it: a room's change, the company's work, or one of the two signals. */
interface Frame {
  kind: string;
  position?: number;
  room?: string;
  ref?: string | null;
  mentioned?: boolean;
  id?: string;
  type?: string;
  taskId?: string | null;
  actor?: string;
  at?: string;
}

/** One stream, read as it comes: its frames, the `id:` each came with, and everything it said, as text. */
interface Heard {
  frames: Frame[];
  /** The id of each message, in order; null for a frame that carries no position. */
  ids: Array<string | null>;
  /** The newest `id:` the stream sent, frame or not: what a reconnect sends back. */
  lastId: () => string | null;
  raw: () => string;
  ended: () => boolean;
  done: Promise<void>;
  stop: () => void;
}

/** Reads a stream's messages until it ends or is stopped. */
function heard(response: Response, stop: AbortController): Heard {
  const frames: Frame[] = [];
  const ids: Array<string | null> = [];
  let last: string | null = null;
  let text = '';
  let over = false;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (finished) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const lines = message.split('\n');
        const id = lines.find((line) => line.startsWith('id: '))?.slice(4) ?? null;
        if (id !== null) last = id;
        const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (!data) continue;
        frames.push(JSON.parse(data) as Frame);
        ids.push(id);
      }
    }
    over = true;
  })();
  return { frames, ids, lastId: () => last, raw: () => text, ended: () => over, done, stop: () => stop.abort() };
}

/** Where a stream is asked for: a console's address. */
type Served = Pick<Console, 'url'>;

/** Asks for the room stream; the answer as it came, for a test that expects a refusal. */
async function asked(api: Served, token: string, companyId: string, lastEventId?: string): Promise<{ response: Response; stop: AbortController }> {
  const stop = new AbortController();
  const response = await fetch(`${api.url}/api/companies/${companyId}/room-stream`, {
    headers: { authorization: `Bearer ${token}`, ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }) },
    signal: stop.signal,
  });
  return { response, stop };
}

/** A person's room stream, open and being read. */
async function listening(api: Served, token: string, companyId: string, lastEventId?: string): Promise<Heard> {
  const { response, stop } = await asked(api, token, companyId, lastEventId);
  if (response.status !== 200) assert.fail(`the room stream answered ${response.status}: ${await response.text()}`);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  return heard(response, stop);
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const by = Date.now() + ms;
  while (Date.now() < by) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`waited ${ms} ms for ${what}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frames about one message, by its id. */
const about = (stream: Heard, ref: string) => stream.frames.filter((frame) => frame.ref === ref);
/** Whether any frame names this room. */
const names = (stream: Heard, room: string) => stream.frames.some((frame) => frame.room === room);

/** A company, its console, and the owner signed in to it. */
async function workspace(slug: string): Promise<{ fixture: Fixture; api: Console; owner: PersonIn; token: string }> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings();
  const token = await api.signIn();
  return { fixture, api, owner: personIn(api, token, fixture.companyId), token };
}

/** A second device for a seat: another session of the same seat, with a token of its own. */
async function anotherDevice(seatId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await withControlPlane((tx) => tx.query(
    "INSERT INTO staff_sessions (token_hash, seat_id, issued_at, expires_at) VALUES ($1, $2, now(), now() + interval '8 hours')",
    [createHash('sha256').update(token).digest('hex'), seatId]));
  return token;
}

/** A metric of this process, as a scrape reads it; 0 when it has no sample yet. */
async function metric(name: string): Promise<number> {
  const text = await metricsText({ worker: {
    counts: { places: 0, busy: 0, runs: new Map(), stageFailures: new Map(), loopFailures: { tick: 0, place: 0 } }, lastTickAt: null,
  } });
  const line = text.split('\n').find((one) => one.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}

/** A topic room, open or private, made by `by` with `members`. */
async function topic(by: PersonIn, name: string, isPrivate: boolean, members: string[] = []): Promise<string> {
  return String(ok(await by.makeRoom({ name, private: isPrivate, members }), `making ${name}`).room.id);
}

test('a member hears changes only in rooms they may see', async () => {
  const { fixture, api, owner, token } = await workspace('stream-seen');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const company = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    await companyRoomOf(sariIn);
    const board = await topic(owner, 'board', true, [sari.principal]);
    const open = await topic(owner, 'kopi', false);
    ok(await budiIn.join(open), 'Budi joins the open room');

    const budiHears = await listening(api, budi.token, fixture.companyId);
    const sariHears = await listening(api, sari.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    try {
      const secret = await said(owner, board, 'The board meets on Friday.');
      const fromSari = await said(sariIn, board, 'I will bring the numbers.');
      const inOpen = await said(owner, open, 'New beans arrived.');
      const last = await said(owner, company, 'Good morning, everyone.');

      await until(() => about(budiHears, last).length > 0, 'Budi hearing the company room');
      await until(() => about(sariHears, last).length > 0 && about(ownerHears, last).length > 0, 'the others hearing it');
      assert.equal(about(budiHears, inOpen).length, 1, 'Budi hears the open room he joined');
      assert.ok(!names(budiHears, board), 'Budi hears nothing of a private room he is not in');
      assert.deepEqual(about(budiHears, secret), []);
      assert.deepEqual(about(budiHears, fromSari), []);
      assert.equal(about(sariHears, secret).length, 1, 'a member of the private room hears it');
      assert.equal(about(sariHears, fromSari).length, 1);
      assert.equal(about(ownerHears, secret).length, 1, 'the owner hears every private topic room');

      // Positions only rise, on each stream.
      for (const stream of [budiHears, sariHears, ownerHears]) {
        const positions = stream.frames.filter((frame) => frame.position !== undefined).map((frame) => frame.position!);
        assert.deepEqual(positions, [...positions].sort((one, other) => one - other), 'frames in the order they happened');
        assert.equal(new Set(positions).size, positions.length, 'each change once');
      }
    } finally {
      budiHears.stop();
      sariHears.stop();
      ownerHears.stop();
    }
  } finally {
    await api.close();
  }
});

test("a direct room's frames never reach the owner when the owner is not in it", async () => {
  const { fixture, api, owner, token } = await workspace('stream-direct');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'viewer');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const company = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    await companyRoomOf(personIn(api, sari.token, fixture.companyId));
    const direct = String(ok(await budiIn.direct([budi.principal, sari.principal]), 'opening a direct room').room.id);

    const ownerHears = await listening(api, token, fixture.companyId);
    const sariHears = await listening(api, sari.token, fixture.companyId);
    try {
      const between = await said(budiIn, direct, 'Lunch at noon?');
      const later = await said(owner, company, 'The roaster is fixed.');
      await until(() => about(ownerHears, later).length > 0, 'the owner hearing the company room');
      await until(() => about(sariHears, between).length > 0, 'Sari hearing her direct room');
      assert.ok(!names(ownerHears, direct), 'the owner heard of a direct room they are not in');
      assert.equal(about(sariHears, between)[0]!.kind, 'message');
    } finally {
      ownerHears.stop();
      sariHears.stop();
    }
  } finally {
    await api.close();
  }
});

test('nothing of another company is sent', async () => {
  const { fixture, api, owner, token } = await workspace('stream-ours');
  const other = await createCompany('stream-theirs');
  try {
    const theirs = personIn(api, token, other.companyId);
    const theirRoom = await companyRoomOf(theirs);
    const ourRoom = await companyRoomOf(owner);
    const budi = await seated(fixture, 'Budi', 'member');

    // A seat is refused another company's stream before anything is opened.
    const refused = await asked(api, budi.token, other.companyId);
    assert.equal(refused.response.status, 403);
    assert.equal(((await refused.response.json()) as { code: string }).code, 'staff.forbidden');

    const hears = await listening(api, token, fixture.companyId);
    try {
      const elsewhere = await said(theirs, theirRoom, 'Their news.');
      const here = await said(owner, ourRoom, 'Our news.');
      await until(() => about(hears, here).length > 0, 'our room');
      assert.deepEqual(about(hears, elsewhere), []);
      assert.ok(!names(hears, theirRoom), 'a frame of another company');
    } finally {
      hears.stop();
    }
  } finally {
    await api.close();
  }
});

test('a frame carries no words', async () => {
  const { fixture, api, owner } = await workspace('stream-words');
  try {
    const budi = await seated(fixture, 'Budi Santoso', 'member', { handle: 'budi' });
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    const hears = await listening(api, budi.token, fixture.companyId);
    try {
      const id = await said(owner, room, { body: 'Kalibrasi mesin espresso besok pagi, @budi.', mentions: [budi.principal] });
      ok(await owner.on(room, id, 'edit', { body: 'Kalibrasi mesin espresso lusa, @budi.' }), 'editing');
      ok(await budiIn.on(room, id, 'react', { emoji: '👍', on: true }), 'reacting');
      ok(await owner.on(room, id, 'pin', { on: true }), 'pinning');
      await until(() => about(hears, id).length >= 4, 'the message, its edit, its reaction and its pin');
      for (const frame of hears.frames) {
        assert.deepEqual(Object.keys(frame).filter((key) => !['position', 'kind', 'room', 'ref', 'mentioned'].includes(key)), [],
          `a frame said more than where and what: ${JSON.stringify(frame)}`);
      }
      assert.deepEqual(about(hears, id).map((frame) => frame.kind), ['message', 'edit', 'reaction', 'pin']);
      assert.equal(about(hears, id)[0]!.mentioned, true, 'the person named is told it is them');
      for (const word of ['Kalibrasi', 'espresso', 'Budi Santoso', '👍', 'owner']) {
        assert.ok(!hears.raw().includes(word), `the stream carried "${word}"`);
      }
    } finally {
      hears.stop();
    }
  } finally {
    await api.close();
  }
});

/** Reads /live as the console has, for the work frames the room stream must match. */
async function liveStream(api: Served, token: string, companyId: string): Promise<Heard> {
  const stop = new AbortController();
  const response = await fetch(`${api.url}/api/companies/${companyId}/live`, { headers: { authorization: `Bearer ${token}` }, signal: stop.signal });
  assert.equal(response.status, 200);
  return heard(response, stop);
}

test('the room stream carries the same work frames as /live, read once per company', async () => {
  const { fixture, api, token } = await workspace('stream-work');
  try {
    const budi = await seated(fixture, 'Budi', 'viewer');
    const live = await liveStream(api, token, fixture.companyId);
    const streams = [
      await listening(api, token, fixture.companyId),
      await listening(api, token, fixture.companyId),
      await listening(api, token, fixture.companyId),
      await listening(api, budi.token, fixture.companyId),
      await listening(api, budi.token, fixture.companyId),
    ];
    try {
      // Both start from the moment they are opened: let the hub's first read pass.
      await pause(1_200);
      const readsBefore = await metric('palugada_room_work_reads_total');
      const started = Date.now();
      const task = await createRootTask({
        companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
        budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Count the beans' }, createdBy: 'owner', reserveTokens: 1_000,
      });
      await transition(fixture.companyId, task.id, 'running');
      await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'Counted.' } });
      const work = (stream: Heard) => stream.frames.filter((frame) => frame.kind === 'work' && frame.taskId === task.id);
      await until(() => live.frames.some((frame) => frame.type === 'task.completed' && frame.taskId === task.id), '/live hearing the work');
      await until(() => streams.every((stream) => work(stream).some((frame) => frame.type === 'task.completed')), 'every room stream hearing it');
      const elapsed = (Date.now() - started) / 1_000;
      const reads = await metric('palugada_room_work_reads_total') - readsBefore;

      const fromLive = live.frames.filter((frame) => frame.taskId === task.id)
        .map(({ id, type, taskId, actor, at }) => ({ kind: 'work', id, type, taskId, actor, at }));
      for (const stream of streams) {
        assert.deepEqual(work(stream), fromLive, 'the same frames, in the same order, as /live sends');
        const ids = work(stream).map((frame) => frame.id);
        assert.equal(new Set(ids).size, ids.length, 'each event once');
      }
      assert.ok(work(streams[3]!).length > 0, 'a seat hears the work as /live tells it');
      // Five streams of one company read the journal as one: about once a second, not five times.
      assert.ok(reads <= Math.ceil(elapsed) + 2, `the journal was read ${reads} times in ${elapsed.toFixed(1)} s for five streams`);
    } finally {
      live.stop();
      for (const stream of streams) stream.stop();
    }
  } finally {
    await api.close();
  }
});

test('a stream resumed after a gap hears what it missed, in order, once', async () => {
  const { fixture, api, owner, token } = await workspace('stream-resume');
  try {
    const room = await companyRoomOf(owner);
    const first = await listening(api, token, fixture.companyId);
    const one = await said(owner, room, 'One.');
    await until(() => about(first, one).length > 0, 'the first message');
    const lastId = first.lastId();
    assert.ok(lastId, 'a frame came with an id');
    first.stop();
    await first.done;

    // What happens while nobody listens.
    const two = await said(owner, room, 'Two.');
    const three = await said(owner, room, 'Three.');
    ok(await owner.on(room, two, 'react', { emoji: '👀', on: true }), 'reacting');

    const second = await listening(api, token, fixture.companyId, lastId!);
    try {
      await until(() => about(second, two).length === 2 && about(second, three).length === 1, 'what was missed');
      const four = await said(owner, room, 'Four.');
      await until(() => about(second, four).length > 0, 'what came after');
      await pause(300);
      const positions = second.frames.filter((frame) => frame.position !== undefined).map((frame) => frame.position!);
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'in order');
      assert.equal(new Set(positions).size, positions.length, 'once each');
      assert.deepEqual(about(second, one), [], 'nothing heard before is said again');
      assert.deepEqual(second.frames.filter((frame) => frame.ref).map((frame) => [frame.ref, frame.kind]),
        [[two, 'message'], [three, 'message'], [two, 'reaction'], [four, 'message']]);
      assert.equal(second.ids.filter((_id, index) => second.frames[index]!.position !== undefined).at(-1), String(positions.at(-1)),
        "a frame's id is its position");
    } finally {
      second.stop();
    }
  } finally {
    await api.close();
  }
});

test('a stream resumed after a gap is sent only what its person may see of it', async () => {
  const { fixture, api, owner } = await workspace('stream-resume-own');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'viewer');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const company = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    await companyRoomOf(sariIn);
    const feed = async () => (await withControlPlane((tx) => tx.query<{ position: string; room_id: string; ref: string | null; kind: string; principal: string | null }>(
      'SELECT position, room_id, ref, kind, principal FROM room_feed WHERE company_id = $1 ORDER BY position', [fixture.companyId]))).rows;
    const positionOf = async (ref: string) => Number((await feed()).find((row) => row.ref === ref && row.kind === 'message')!.position);
    // Where Sari's console last heard, before anything below was written.
    const before = Math.max(...(await feed()).map((row) => Number(row.position)));

    // While her tab is away: a private room she is not in, a direct room she is not in, a colleague's read mark ...
    const board = await topic(owner, 'board', true, [budi.principal]);
    const secret = await said(owner, board, 'The board meets on Friday.');
    const direct = String(ok(await budiIn.direct([budi.principal, 'owner']), 'opening a direct room').room.id);
    const between = await said(budiIn, direct, 'Can I leave early?');
    const forAll = await said(owner, company, 'Stock count at four.');
    ok(await budiIn.read(company, { position: await positionOf(forAll) }), 'Budi reads the company room');
    // ... and what is hers: the company room, and her own read mark, from another of her devices.
    const after = await said(owner, company, 'And coffee after.');
    ok(await sariIn.read(company, { position: await positionOf(after) }), 'Sari reads the company room on her phone');
    const rows = (await feed()).filter((row) => Number(row.position) > before);
    const notHers = rows
      .filter((row) => row.room_id === board || row.room_id === direct || (row.kind === 'read' && row.principal !== sari.principal))
      .map((row) => Number(row.position));
    assert.ok(notHers.length >= 5, `the feed holds what Sari may not see: ${JSON.stringify(rows)}`);
    const hers = rows.map((row) => Number(row.position)).filter((position) => !notHers.includes(position));

    const resumed = await listening(api, sari.token, fixture.companyId, String(before));
    try {
      await until(() => resumed.frames.some((frame) => frame.kind === 'read'), 'her own read mark, replayed');
      await pause(300);
      const heardAt = resumed.frames.filter((frame) => frame.position !== undefined).map((frame) => frame.position!);
      assert.deepEqual(heardAt, hers, 'replayed: exactly what she may see, in order');
      assert.ok(!names(resumed, board), 'a private room she is not in');
      assert.ok(!names(resumed, direct), 'a direct room she is not in');
      assert.deepEqual([...about(resumed, secret), ...about(resumed, between)], []);
      assert.equal(about(resumed, forAll).length, 1, 'the company room, replayed');
      assert.equal(about(resumed, after).length, 1);
    } finally {
      resumed.stop();
    }
  } finally {
    await api.close();
  }
});

test('positions follow commit order even when an earlier transaction commits later', async () => {
  const { fixture, api, owner, token } = await workspace('stream-order');
  try {
    const room = await companyRoomOf(owner);
    const hears = await listening(api, token, fixture.companyId);
    try {
      let early = '';
      let late = '';
      let begun!: () => void;
      const ready = new Promise<void>((resolve) => { begun = resolve; });
      let go!: () => void;
      const later = new Promise<void>((resolve) => { go = resolve; });
      // A transaction that begins first and writes last.
      const slow = withPeople(fixture.companyId, { principal: 'owner', name: null }, async (tx) => {
        await tx.query('SELECT 1');
        begun();
        await later;
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, mentions, mentions_room, via, client_id, position)
           VALUES (gen_random_uuid(), $1, $2, 'text', 'owner', 'Begun first.', '{}', false, 'console', $3, 0) RETURNING id`,
          [fixture.companyId, room, `slow-${randomBytes(4).toString('hex')}`]);
        early = rows[0]!.id;
      });
      await ready;
      late = await said(owner, room, 'Begun second, committed first.');
      go();
      await slow;
      await until(() => about(hears, early).length > 0 && about(hears, late).length > 0, 'both messages');
      const [second] = about(hears, late);
      const [first] = about(hears, early);
      assert.ok(first!.position! > second!.position!, 'the transaction that committed last has the later position');
      assert.ok(hears.frames.indexOf(second!) < hears.frames.indexOf(first!), 'and is heard after');
    } finally {
      hears.stop();
    }
  } finally {
    await api.close();
  }
});

test('a cursor older than the kept changes is told to reload', async () => {
  const { fixture, api, owner, token } = await workspace('stream-reset');
  try {
    const room = await companyRoomOf(owner);
    await said(owner, room, 'Old.');
    const kept = await said(owner, room, 'Kept.');
    const { rows } = await withControlPlane((tx) => tx.query<{ position: string }>(
      'SELECT position FROM room_feed WHERE company_id = $1 AND ref = $2', [fixture.companyId, kept]));
    const keptAt = Number(rows[0]!.position);
    // The feed is bookkeeping, purged after a fortnight: what came before `kept` is gone.
    await withControlPlane((tx) => tx.query('DELETE FROM room_feed WHERE company_id = $1 AND position < $2', [fixture.companyId, keptAt]));

    const newest = await withControlPlane((tx) => tx.query<{ newest: string }>(
      'SELECT max(position) AS newest FROM room_feed WHERE company_id = $1', [fixture.companyId]));
    const hears = await listening(api, token, fixture.companyId, '1');
    try {
      await until(() => hears.frames.length > 0, 'the first frame');
      assert.deepEqual(hears.frames[0], { kind: 'reset' }, 'told to read the rooms again');
      // And where to resume from, so the next reconnection is not told to reset again.
      assert.equal(hears.ids[0], newest.rows[0]!.newest, 'the reset carries the newest position the owner could see');
      const after = await said(owner, room, 'After.');
      await until(() => about(hears, after).length > 0, 'what came after, live');
      assert.deepEqual(about(hears, kept), [], 'nothing replayed over a gap it cannot fill');
    } finally {
      hears.stop();
    }

    // A cursor the feed still covers is replayed, not reset.
    const fine = await listening(api, token, fixture.companyId, String(keptAt - 1));
    try {
      await until(() => about(fine, kept).length > 0, 'the kept message replayed');
      assert.ok(!fine.frames.some((frame) => frame.kind === 'reset'));
    } finally {
      fine.stop();
    }
  } finally {
    await api.close();
  }
});

test("a cursor ahead of the company's clock is told to reload, and hears what follows", async () => {
  const { fixture, api, owner, token } = await workspace('stream-ahead');
  try {
    const room = await companyRoomOf(owner);
    const before = await said(owner, room, 'Before.');
    const newest = await withControlPlane((tx) => tx.query<{ newest: string }>(
      'SELECT max(position) AS newest FROM room_feed WHERE company_id = $1', [fixture.companyId]));
    // An id from a database since restored to an earlier moment: no position the company has reached.
    const hears = await listening(api, token, fixture.companyId, '1000000');
    try {
      await until(() => hears.frames.length > 0, 'the first frame');
      assert.deepEqual(hears.frames[0], { kind: 'reset' }, 'told to read the rooms again');
      assert.equal(hears.ids[0], newest.rows[0]!.newest, 'from the newest position the owner could see');
      const after = await said(owner, room, 'After.');
      await until(() => about(hears, after).length > 0, 'what came after, live');
      assert.deepEqual(about(hears, before), []);
    } finally {
      hears.stop();
    }
  } finally {
    await api.close();
  }
});

test("a removed member stops receiving the room's frames at once", async () => {
  const { fixture, api, owner, token } = await workspace('stream-removed');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const company = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    const board = await topic(owner, 'board', true, [budi.principal]);
    const hears = await listening(api, budi.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    try {
      const before = await said(owner, board, 'Before.');
      await until(() => about(hears, before).length > 0, 'Budi hearing the private room');
      ok(await owner.members(board, { remove: [budi.principal] }), 'removing Budi');
      const after = await said(owner, board, 'After Budi left.');
      const elsewhere = await said(owner, company, 'Meanwhile.');
      await until(() => about(hears, elsewhere).length > 0 && about(ownerHears, after).length > 0, 'the frames that followed');
      assert.deepEqual(about(hears, after), [], 'a removed member heard the room');
    } finally {
      hears.stop();
      ownerHears.stop();
    }
  } finally {
    await api.close();
  }
});

test("a read mark is heard by the reader's other devices, and by nobody else", async () => {
  const { fixture, api, owner, token } = await workspace('stream-read');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    await companyRoomOf(personIn(api, sari.token, fixture.companyId));
    const phone = await anotherDevice(budi.id);
    const onPhone = await listening(api, phone, fixture.companyId);
    const sariHears = await listening(api, sari.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    try {
      const said1 = await said(owner, room, 'Please read this.');
      await until(() => about(onPhone, said1).length > 0, 'the message');
      const position = about(onPhone, said1)[0]!.position!;
      ok(await budiIn.read(room, { position }), 'Budi reads it on his laptop');
      const later = await said(owner, room, 'Thanks.');
      await until(() => about(sariHears, later).length > 0 && about(ownerHears, later).length > 0 && about(onPhone, later).length > 0, 'what followed');
      const reads = (stream: Heard) => stream.frames.filter((frame) => frame.kind === 'read');
      assert.equal(reads(onPhone).length, 1, "Budi's phone hears his laptop read the room");
      assert.equal(reads(onPhone)[0]!.room, room);
      assert.deepEqual(reads(sariHears), [], 'a colleague hears nobody else\'s read mark');
      assert.deepEqual(reads(ownerHears), [], 'nor does the owner');
    } finally {
      onPhone.stop();
      sariHears.stop();
      ownerHears.stop();
    }
  } finally {
    await api.close();
  }
});

test('an @room frame is marked for every member who has not silenced the room', async () => {
  const { fixture, api, owner, token } = await workspace('stream-everyone');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'member');
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(personIn(api, budi.token, fixture.companyId));
    await companyRoomOf(sariIn);
    ok(await sariIn.settings(room, { notify: 'none' }), 'Sari silences the company room');
    const budiHears = await listening(api, budi.token, fixture.companyId);
    const sariHears = await listening(api, sari.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    try {
      const everyone = await said(owner, room, { body: 'Stock count at four, @room.', mentionsRoom: true });
      const plain = await said(owner, room, 'And coffee after.');
      await until(() => [budiHears, sariHears, ownerHears].every((stream) => about(stream, plain).length > 0), 'both messages');
      assert.equal(about(budiHears, everyone)[0]!.mentioned, true, 'a member who listens is told it is for them');
      assert.notEqual(about(sariHears, everyone)[0]!.mentioned, true, 'a member who silenced the room is not');
      assert.notEqual(about(ownerHears, everyone)[0]!.mentioned, true, 'nor is whoever wrote it');
      assert.notEqual(about(budiHears, plain)[0]!.mentioned, true, 'a plain message names nobody');

      // Heard again after a gap, read as each person, it says the same.
      const before = String(about(budiHears, everyone)[0]!.position! - 1);
      const budiAgain = await listening(api, budi.token, fixture.companyId, before);
      const sariAgain = await listening(api, sari.token, fixture.companyId, before);
      try {
        await until(() => about(budiAgain, plain).length > 0 && about(sariAgain, plain).length > 0, 'both replayed');
        assert.equal(about(budiAgain, everyone)[0]!.mentioned, true, 'replayed, @room is still for a member who listens');
        assert.notEqual(about(sariAgain, everyone)[0]!.mentioned, true, 'and still not for one who silenced the room');
      } finally {
        budiAgain.stop();
        sariAgain.stop();
      }
    } finally {
      budiHears.stop();
      sariHears.stop();
      ownerHears.stop();
    }
  } finally {
    await api.close();
  }
});

test("a revoked seat's stream ends within thirty seconds", { timeout: 60_000 }, async () => {
  const { fixture, api, token } = await workspace('stream-revoked');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const hears = await listening(api, budi.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    // Ended where no process heard of it: written straight into the database,
    // as a replica that went down before it could tell the others would leave it.
    await withControlPlane(async (tx) => {
      await tx.query('UPDATE staff_seats SET revoked_at = now() WHERE id = $1', [budi.id]);
      await tx.query('UPDATE staff_sessions SET ended_at = now() WHERE seat_id = $1', [budi.id]);
    });
    const from = Date.now();
    await until(() => hears.ended(), 'the stream to end', 30_000);
    assert.ok(Date.now() - from <= 30_000);
    assert.ok(!ownerHears.ended(), 'a session still live is asked again and goes on');
    ownerHears.stop();
  } finally {
    await api.close();
  }
});

/**
 * A second process of the same deployment, behind the same address: it
 * reads the same sessions and seats from the database, and enrols nothing.
 */
async function replicaOf(listenUrl?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const replica = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager(), rpId: 'palugada.local' }),
    ...(listenUrl ? { listenUrl } : {}),
  });
  const { url } = await replica.listen();
  return { url, close: () => replica.close() };
}

test('signing out ends the streams that session opened, in another process too', async () => {
  const { fixture, api, token } = await workspace('stream-signed-out');
  let replica: { url: string; close: () => Promise<void> } | null = null;
  try {
    replica = await replicaOf();
    const kept = await api.signIn();
    const budi = await seated(fixture, 'Budi', 'member');
    const sari = await seated(fixture, 'Sari', 'viewer');
    const there = await listening(replica, token, fixture.companyId);
    const workThere = await liveStream(replica, token, fixture.companyId);
    const keptThere = await listening(replica, kept, fixture.companyId);
    const budiThere = await listening(replica, budi.token, fixture.companyId);
    const sariThere = await listening(replica, sari.token, fixture.companyId);
    try {
      ok(await api.call('POST', '/api/auth/sign-out', token, {}), 'signing out on the first process');
      await until(() => there.ended() && workThere.ended(), 'the signed-out session\'s streams on the other process to end', 3_000);
      assert.ok(!keptThere.ended(), 'another session of the owner goes on');

      ok(await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.id}/revoke`, kept, {}), 'revoking Budi');
      await until(() => budiThere.ended(), "the revoked seat's stream on the other process to end", 3_000);

      ok(await api.call('POST', `/api/companies/${fixture.companyId}/staff/${sari.id}/change`, kept, { kind: 'member', proof: { totp: api.code() } }),
        'making Sari a member');
      await until(() => sariThere.ended(), 'the stream of a seat whose kind changed to end on the other process', 3_000);
      assert.ok(!keptThere.ended());
    } finally {
      for (const stream of [there, workThere, keptThere, budiThere, sariThere]) stream.stop();
    }
  } finally {
    await replica?.close();
    await api.close();
  }
});

test('a process that holds only /live listens again after a loss, and asks after its sessions', { timeout: 90_000 }, async () => {
  const { fixture, api, token } = await workspace('stream-live-alone');
  let replica: { url: string; close: () => Promise<void> } | null = null;
  try {
    replica = await replicaOf();
    const kept = await api.signIn();
    const expiring = await api.signIn();
    const budi = await seated(fixture, 'Budi', 'viewer');
    const work = await liveStream(replica, token, fixture.companyId);
    const keptWork = await liveStream(replica, kept, fixture.companyId);
    const expiringWork = await liveStream(replica, expiring, fixture.companyId);
    const budiWork = await liveStream(replica, budi.token, fixture.companyId);
    try {
      await hubsAre(1, 'the process that serves /live listening');
      // Its connection is gone: it listens again, though no room stream is open there.
      await appPool().query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'palugada-hub'");
      await hubsAre(1, 'the process that serves /live listening again', 10_000);
      ok(await api.call('POST', '/api/auth/sign-out', token, {}), 'signing out on the first process');
      await until(() => work.ended(), "the signed-out session's /live on the other process to end", 3_000);

      // Ended where no process heard of it: a session over, a seat revoked, written straight into the database.
      await withControlPlane(async (tx) => {
        await tx.query('UPDATE owner_sessions SET ended_at = now() WHERE token_hash = $1', [createHash('sha256').update(expiring).digest('hex')]);
        await tx.query('UPDATE staff_seats SET revoked_at = now() WHERE id = $1', [budi.id]);
      });
      const from = Date.now();
      await until(() => expiringWork.ended() && budiWork.ended(), "the /live of a session no longer live to end", 30_000);
      assert.ok(Date.now() - from <= 30_000);
      assert.ok(!keptWork.ended(), 'a session still live is asked again and goes on');
    } finally {
      for (const stream of [work, keptWork, expiringWork, budiWork]) stream.stop();
    }
  } finally {
    await replica?.close();
    await api.close();
  }
});

test('one database reader per company, however many streams', async () => {
  const { fixture, api, owner, token } = await workspace('stream-one-reader');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const room = await companyRoomOf(owner);
    await companyRoomOf(personIn(api, budi.token, fixture.companyId));
    const streams: Heard[] = [];
    for (let index = 0; index < 3; index += 1) {
      streams.push(await listening(api, token, fixture.companyId));
      streams.push(await listening(api, budi.token, fixture.companyId));
    }
    try {
      assert.equal(await metric('palugada_room_streams'), 6, 'six room streams open in this process');
      await pause(300);
      const before = await metric('palugada_room_feed_reads_total');
      const sent: string[] = [];
      for (const body of ['One.', 'Two.', 'Three.']) {
        const id = await said(owner, room, body);
        sent.push(id);
        await until(() => streams.every((stream) => about(stream, id).length > 0), `"${body}" on every stream`);
      }
      const reads = await metric('palugada_room_feed_reads_total') - before;
      // One read for each change, and perhaps one by the clock, whatever the number of streams.
      assert.ok(reads >= 1 && reads <= sent.length + 2, `the feed was read ${reads} times for ${sent.length} messages and six streams`);
    } finally {
      for (const stream of streams) stream.stop();
    }
  } finally {
    await api.close();
  }
});

test('a sixth stream for one person is refused', async () => {
  const { fixture, api, token } = await workspace('stream-six');
  try {
    const budi = await seated(fixture, 'Budi', 'member');
    const five: Heard[] = [];
    for (let index = 0; index < 5; index += 1) five.push(await listening(api, token, fixture.companyId));
    try {
      const sixth = await asked(api, token, fixture.companyId);
      refusedWith({ status: sixth.response.status, body: await sixth.response.json() }, 503, 'stream.too_many', 'a sixth tab');
      // Another person's count is their own.
      const his = await listening(api, budi.token, fixture.companyId);
      his.stop();
      // A tab closed gives its place back.
      five.shift()!.stop();
      let again: Heard | null = null;
      const by = Date.now() + 5_000;
      while (!again && Date.now() < by) {
        const tried = await asked(api, token, fixture.companyId);
        if (tried.response.status === 200) again = heard(tried.response, tried.stop);
        else {
          await tried.response.body?.cancel();
          await pause(50);
        }
      }
      assert.ok(again, 'a closed tab gave its place back');
      five.push(again);
    } finally {
      for (const stream of five) stream.stop();
    }
  } finally {
    await api.close();
  }
});

test('the owner hears their conversation with the CEO change, and a seat does not', async () => {
  const { fixture, api, token } = await workspace('stream-ceo');
  try {
    const budi = await seated(fixture, 'Budi', 'approver');
    const ownerHears = await listening(api, token, fixture.companyId);
    const budiHears = await listening(api, budi.token, fixture.companyId);
    try {
      // With no model set up, the CEO answers with the platform's sentence: the conversation still changes.
      ok(await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'How are sales?' }), 'talking to the CEO');
      await until(() => ownerHears.frames.some((frame) => frame.kind === 'ceo'), "the owner's stream hearing the conversation");
      const room = await companyRoomOf(personIn(api, token, fixture.companyId));
      const later = await said(personIn(api, token, fixture.companyId), room, 'Later.');
      await until(() => about(budiHears, later).length > 0, "the seat's stream hearing what followed");
      assert.ok(!budiHears.frames.some((frame) => frame.kind === 'ceo'), "a seat heard the owner's conversation change");
      assert.ok(!ownerHears.raw().includes('How are sales'), 'and the frame carries no words');
    } finally {
      ownerHears.stop();
      budiHears.stop();
    }
  } finally {
    await api.close();
  }
});

/** The hub's own connections to this database, by the name each gives itself. */
async function hubConnections(): Promise<number> {
  const { rows } = await withControlPlane((tx) => tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'palugada-hub'"));
  return rows[0]!.n;
}

/** Waits until this database has `n` hub connections. */
async function hubsAre(n: number, what: string, ms = 5_000): Promise<void> {
  const by = Date.now() + ms;
  let now = await hubConnections();
  while (now !== n && Date.now() < by) {
    await pause(50);
    now = await hubConnections();
  }
  assert.equal(now, n, what);
}

test('a stream goes on hearing the rooms while the hub cannot listen, and the hub listens again', async () => {
  const { fixture, api, owner, token } = await workspace('stream-relisten');
  try {
    const room = await companyRoomOf(owner);
    const hears = await listening(api, token, fixture.companyId);
    await hubsAre(1, 'the hub listening');
    // Postgres restarted, or an operator ended the session: the connection the hub listens on is gone.
    await appPool().query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'palugada-hub'");
    const meanwhile = await said(owner, room, 'While nobody listened.');
    await until(() => about(hears, meanwhile).length > 0, 'the change, read by the clock', 7_000);
    await hubsAre(1, 'the hub listening again', 10_000);
    const after = await said(owner, room, 'Listened to again.');
    const sent = Date.now();
    await until(() => about(hears, after).length > 0, 'the change, told at once', 3_000);
    assert.ok(Date.now() - sent < 3_000);
    hears.stop();
  } finally {
    await api.close();
  }
});


test('a process that cannot listen at all still tells every stream what changed, by the clock', async () => {
  const { fixture, api, owner, token } = await workspace('stream-deaf');
  // A pooler that does not keep LISTEN, or a listening address that is wrong: nothing answers there.
  let deaf: { url: string; close: () => Promise<void> } | null = null;
  try {
    deaf = await replicaOf('postgres://palugada_app:dev_app@127.0.0.1:1/nowhere');
    const room = await companyRoomOf(owner);
    const hears = await listening(deaf, token, fixture.companyId);
    const said1 = await said(owner, room, 'Heard without a notice.');
    await until(() => about(hears, said1).length > 0, 'the change, read by the clock', 7_000);
    hears.stop();
  } finally {
    await deaf?.close();
    await api.close();
  }
});

test('a listening address that takes the connection and never answers holds up neither the streams nor closing', { timeout: 60_000 }, async () => {
  // A pooler that hangs, or a proxy that swallows what it is sent: the connection is taken, and nothing comes back.
  const sockets: Socket[] = [];
  const silent = createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
  const { port } = silent.address() as AddressInfo;
  const { fixture, api, owner, token } = await workspace('stream-silent');
  let replica: { url: string; close: () => Promise<void> } | null = null;
  const streams: Heard[] = [];
  try {
    replica = await replicaOf(`postgres://palugada_app:dev_app@127.0.0.1:${port}/nowhere`);
    const room = await companyRoomOf(owner);
    const took: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const from = Date.now();
      streams.push(await listening(replica, token, fixture.companyId));
      took.push(Date.now() - from);
    }
    assert.ok(took[0]! < 3_000, `the first stream waited ${took[0]} ms for the hub`);
    assert.ok(took[1]! < 1_000 && took[2]! < 1_000, `a stream waits for the hub only as long as the first did: ${took.join(', ')} ms`);
    const said1 = await said(owner, room, 'Heard without a notice.');
    await until(() => streams.every((stream) => about(stream, said1).length > 0), 'the change, read by the clock', 7_000);
    // The connection that never answers is given up, and another is tried.
    await until(() => sockets.length >= 2, 'the hub trying again', 20_000);

    for (const stream of streams) stream.stop();
    const closing = replica.close();
    replica = null;
    const closed = await Promise.race([closing.then(() => true), pause(5_000).then(() => false)]);
    assert.ok(closed, 'closing the API waited on a connection that never answers');
  } finally {
    for (const stream of streams) stream.stop();
    // The address answers at last, by going away: whatever still waits on it is let go.
    for (const socket of sockets) socket.destroy();
    silent.close();
    await replica?.close();
    await api.close();
  }
});

test('closing the owner API closes its listener', async () => {
  const { fixture, api, token } = await workspace('stream-close');
  const before = await hubConnections();
  const hears = await listening(api, token, fixture.companyId);
  let listened = before;
  const by = Date.now() + 5_000;
  while (listened === before && Date.now() < by) {
    await pause(50);
    listened = await hubConnections();
  }
  assert.equal(listened, before + 1, 'one connection listens for the hub');
  await api.close();
  await until(() => hears.ended(), 'the stream to end with the API');
  let left = listened;
  const gone = Date.now() + 5_000;
  while (left !== before && Date.now() < gone) {
    await pause(50);
    left = await hubConnections();
  }
  assert.equal(left, before, 'the listener outlived the API');
});

/**
 * The stream and the relay (STATUS 2.213): a person's phone answers through
 * the same doors the console uses, so what it does is heard on the room
 * stream as the console's own acts are -- a read mark by the reader's other
 * devices alone, a reply by everyone who may see the room.
 */
test("a read mark and a reply made through the relay are heard on the room stream, the read mark by the reader's devices alone", async () => {
  const { fakeRelay, deviceSignature, sha256Hex } = await import('../helpers/fake-relay.ts');
  const { linkThrough, pairThrough } = await import('../helpers/relay.ts');
  const { tell, toldTo } = await import('../helpers/notices.ts');
  const { fixture, api, owner, token } = await workspace('stream-relay');
  const relay = await fakeRelay();
  try {
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share: 'content', mayPost: true });
    const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const room = await companyRoomOf(owner);
    await companyRoomOf(budiIn);
    await companyRoomOf(sariIn);
    const phone = await linkThrough(api, sari.token, relay, relayId, { device: true, owner: false });
    const laptop = await anotherDevice(sari.id);
    const sariHears = await listening(api, laptop, fixture.companyId);
    const budiHears = await listening(api, budi.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    try {
      const asked = await said(budiIn, room, { body: '@sari can you check the stock?', mentions: [sari.principal] });
      await until(() => about(sariHears, asked).length > 0, 'the mention');
      await tell(fixture.companyId, api.master);
      const [notice] = toldTo(relay, phone);
      const tokens = Object.fromEntries((notice.offers ?? []).map((offer: { act: string; token: string }) => [offer.act, offer.token]));
      const { deployment } = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { deployment: string };
      /** An act as Sari's phone sends it through the relay, signed by its device. */
      const act = async (type: 'read' | 'reply', extra: { body?: string; clientId?: string } = {}) => {
        const at = new Date().toISOString();
        const fields: Record<string, unknown> = { deployment, relay: relayId, recipient: phone.recipient, type, token: tokens[type], at };
        if (type === 'reply') Object.assign(fields, { sha256: sha256Hex(extra.body ?? ''), clientId: extra.clientId });
        const answer = await relay.push(api.url, relayId, relay.sign({
          v: 1, type, at, token: tokens[type], ...extra, device_sig: deviceSignature(phone.device!.privateKey, fields),
        }));
        assert.equal(answer.status, 200, `the ${type} was refused: ${JSON.stringify(answer.body)}`);
      };

      await act('read');
      const reads = (stream: Heard) => stream.frames.filter((frame) => frame.kind === 'read');
      await until(() => reads(sariHears).length > 0, "the read mark, on Sari's laptop");
      assert.equal(reads(sariHears)[0]!.room, room);

      await act('reply', { body: 'Checked: twelve bags left.', clientId: 'phone-1' });
      const { rows: [reply] } = await withControlPlane((tx) => tx.query<{ id: string; via: string }>(
        "SELECT id, via FROM room_messages WHERE company_id = $1 AND body = 'Checked: twelve bags left.'", [fixture.companyId]));
      assert.equal(reply!.via, 'relay');
      for (const [stream, who] of [[sariHears, "Sari's laptop"], [budiHears, 'Budi'], [ownerHears, 'the owner']] as const) {
        await until(() => about(stream, reply!.id).some((frame) => frame.kind === 'message'), `the reply, heard by ${who}`);
      }
      assert.deepEqual(reads(budiHears), [], "a colleague hears nobody else's read mark");
      assert.deepEqual(reads(ownerHears), [], 'nor does the owner');
      for (const stream of [sariHears, budiHears, ownerHears]) {
        assert.ok(!stream.raw().includes('twelve bags'), 'a reply from a phone is framed without its words, as any other');
      }
    } finally {
      sariHears.stop();
      budiHears.stop();
      ownerHears.stop();
    }
  } finally {
    await api.close();
    await relay.close();
  }
});

/**
 * The stream and the agents' meetings (STATUS 2.211): a meeting is a card in
 * the company room, drawn when the meeting is made and drawn again as it
 * moves, and an open room hears both as it hears any card -- the card's
 * first drawing as a new message, each change after as a card frame -- with
 * no week, no agenda and no record in the frame.
 */
test('a meeting card is heard when it is posted and each time it moves, and its frames carry none of its record', async () => {
  const { defineMetric } = await import('../../src/domain/metrics.ts');
  const { ensureWeeklyMeeting } = await import('../../src/engine/meeting.ts');
  const { syncRoomCards } = await import('../../src/workspace/cards.ts');
  const { fixture, api, owner, token } = await workspace('stream-meeting');
  try {
    // Due today, from midnight in Jakarta, with a line on the scorecard for its agenda.
    const local = new Date(Date.now() + 7 * 3_600_000);
    await withControlPlane((tx) => tx.query(
      `UPDATE companies SET timezone = 'Asia/Jakarta', meeting_weekday = $2, meeting_hour = 0, meeting_enabled = true WHERE id = $1`,
      [fixture.companyId, local.getUTCDay()]));
    await defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50, reviewEvery: 'week', ownerRoleId: fixture.roleId,
    });
    const sari = await seated(fixture, 'Sari', 'member');
    const room = await companyRoomOf(owner);
    await companyRoomOf(personIn(api, sari.token, fixture.companyId));
    const sariHears = await listening(api, sari.token, fixture.companyId);
    const ownerHears = await listening(api, token, fixture.companyId);
    try {
      const meeting = await ensureWeeklyMeeting(fixture.companyId, new Date());
      assert.ok(meeting, 'the meeting is due');
      assert.ok(await syncRoomCards(fixture.companyId) > 0, 'the card is drawn');
      const { rows: [card] } = await withControlPlane((tx) => tx.query<{ id: string }>(
        "SELECT id FROM room_messages WHERE company_id = $1 AND kind = 'meeting' AND task_id = $2", [fixture.companyId, meeting]));
      for (const stream of [sariHears, ownerHears]) {
        await until(() => about(stream, card!.id).some((frame) => frame.kind === 'message' && frame.room === room), 'the card, posted');
      }

      await transition(fixture.companyId, meeting!, 'running');
      await transition(fixture.companyId, meeting!, 'completed', {
        output: { summary: 'What the owner needs to know\nThe espresso machine is due for its service in March.' },
      });
      assert.ok(await syncRoomCards(fixture.companyId) > 0, 'the card is drawn again');
      for (const stream of [sariHears, ownerHears]) {
        await until(() => about(stream, card!.id).some((frame) => frame.kind === 'card'), 'the card, moved');
        for (const frame of about(stream, card!.id)) {
          assert.deepEqual(Object.keys(frame).filter((key) => !['position', 'kind', 'room', 'ref', 'mentioned'].includes(key)), [],
            `a card's frame said more than where and what: ${JSON.stringify(frame)}`);
        }
        for (const word of ['espresso', 'owner needs to know', 'Sales calls']) {
          assert.ok(!stream.raw().includes(word), `the stream carried "${word}"`);
        }
      }
    } finally {
      sariHears.stop();
      ownerHears.stop();
    }
  } finally {
    await api.close();
  }
});

/**
 * The stream and keeping (STATUS 2.212): a message's files are framed as the
 * message is, with no name, and what retention takes is framed as removed,
 * a root left without its words too, so an open room draws its page again
 * and drops them. The feed retention keeps is two weeks, and a stream that
 * comes back from before what is kept is told to read everything again.
 */
test("a message's files are framed with no name, what retention takes is framed as removed, and a stream from before the kept feed is told to reload", async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setRetention, runRetention } = await import('../../src/retention/retention.ts');
  const root = await mkdtemp(join(tmpdir(), 'palugada-stream-files-'));
  const fixture = await createCompany('stream-kept');
  const api = await consoleWithSettings({ files: { root } });
  const token = await api.signIn();
  const owner = personIn(api, token, fixture.companyId);
  try {
    const sari = await seated(fixture, 'Sari', 'member');
    const room = await companyRoomOf(owner);
    await companyRoomOf(personIn(api, sari.token, fixture.companyId));
    const hears = await listening(api, sari.token, fixture.companyId);
    try {
      const filed = String(ok(await owner.say(room, {
        body: 'The new price list.', files: [{ name: 'harga-rahasia-2027.pdf', data: Buffer.from('%PDF-1.4 harga').toString('base64') }],
      }), 'posting with a file').message.id);
      const rooted = await said(owner, room, 'Who takes the Saturday shift?');
      await until(() => about(hears, filed).length > 0 && about(hears, rooted).length > 0, 'both messages');
      assert.ok(!hears.raw().includes('harga-rahasia'), "a file's name is never framed");
      assert.ok(!hears.raw().includes('.pdf'), 'nor its kind');
      const first = about(hears, filed)[0]!.position!;
      // A reply a month younger keeps the root's thread alive, without its words.
      const { rows: [aged] } = await withControlPlane((tx) => tx.query<{ at: Date }>(
        'SELECT created_at AS at FROM room_messages WHERE id = $1', [rooted]));
      await pause(20);
      const reply = await said(personIn(api, sari.token, fixture.companyId), room, { body: 'I will.', threadOf: rooted });
      const { rows: [young] } = await withControlPlane((tx) => tx.query<{ at: Date }>(
        'SELECT created_at AS at FROM room_messages WHERE id = $1', [reply]));
      await until(() => about(hears, reply).length > 0, 'the reply');

      await setRetention(fixture.companyId, { messageDays: 30 });
      const at = new Date((aged!.at.getTime() + young!.at.getTime()) / 2 + 30 * 86_400_000);
      assert.equal((await runRetention(fixture.companyId, at, { filesRoot: root })).messagesPurged, 2);
      for (const [id, what] of [[filed, 'the message taken'], [rooted, 'the root left without its words']] as const) {
        await until(() => about(hears, id).some((frame) => frame.kind === 'delete'), `${what}, framed as removed`);
      }
      assert.deepEqual(about(hears, reply).map((frame) => frame.kind), ['message'], 'the reply that lives on is not removed');

      // The feed retention kept starts after the messages' own rows, which went with the two weeks.
      const late = await listening(api, sari.token, fixture.companyId, String(first));
      try {
        await until(() => late.frames.some((frame) => frame.kind === 'reset'), 'the stream from before the kept feed, told to reload');
      } finally {
        late.stop();
      }
    } finally {
      hears.stop();
    }
  } finally {
    await api.close();
  }
});
