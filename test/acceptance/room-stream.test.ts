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

    const hears = await listening(api, token, fixture.companyId, '1');
    try {
      await until(() => hears.frames.length > 0, 'the first frame');
      assert.deepEqual(hears.frames[0], { kind: 'reset' }, 'told to read the rooms again');
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
    await until(() => hears.ended(), 'the stream to end', 31_000);
    assert.ok(Date.now() - from <= 31_000);
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
