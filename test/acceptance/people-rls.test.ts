/**
 * Rooms are for people, and the database says so (F19.1, F19.3, F19.10;
 * STATUS section 2.202).
 *
 * A company's rooms hold what its people say to each other. Agents are never
 * members, never write, and never read a word of it (NG2), and a person sees
 * only the rooms they may see. None of that is left to the code that serves
 * the rooms: a handler that forgets its WHERE, or an agent's query in its own
 * company, must still find nothing. So every case here runs as the real
 * application role, through the helpers the code will use -- `withPeople`,
 * `withDelivery`, `withRoomPlatform`, `withTenant` -- and never as a role that
 * bypasses row security.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { appPool, closePools } from '../../src/db/pool.ts';
import {
  roomsOnControlPlane, withControlPlane, withDelivery, withPeople, withRoomPlatform, withTenant,
  type Person, type TenantClient,
} from '../../src/db/tenant.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { isPalugadaError } from '../../src/errors.ts';
import type { OwnerSession } from '../../src/owner/session.ts';
import type { StaffKind, StaffSession } from '../../src/owner/staff.ts';
import { assertPeopleOf, isPerson, principalOf, seatOf } from '../../src/workspace/principal.ts';
import { migrate } from '../../scripts/migrate.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** Every table the workspace keeps, which no agent may read or write. */
const ROOM_TABLES = [
  'room_clock', 'rooms', 'room_members', 'room_places', 'room_access', 'room_messages', 'room_message_revisions',
  'room_reactions', 'room_pins', 'room_files', 'room_mentions', 'room_follows', 'room_feed',
] as const;

/** The owner, as the owner's own session makes them: what every owner request is in a room. */
const OWNER: Person = principalOf({
  token: 'owner-session', factor: { kind: 'totp' }, issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
  provedAt: new Date(),
} as unknown as OwnerSession, null);

interface Seated { id: string; person: Person; session: StaffSession }

/** A seat of the company, joined, as its verified session presents it. */
async function seat(fixture: Fixture, name: string, kind: StaffKind = 'approver'): Promise<Seated> {
  const id = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO staff_seats (company_id, name, kind, secret_ref, joined_at)
       VALUES ($1, $2, $3, 'db://staff-totp-test', now()) RETURNING id`,
      [fixture.companyId, name, kind]);
    return rows[0]!.id;
  });
  const session: StaffSession = {
    token: `seat-${id}`, seat: { id, companyId: fixture.companyId, name, kind }, expiresAt: new Date(Date.now() + 3_600_000),
  };
  return { id, session, person: principalOf(null, session) };
}

/** The company's own room and its division's, as the platform makes them. */
async function sharedRooms(fixture: Fixture): Promise<{ company: string; division: string }> {
  return withRoomPlatform(fixture.companyId, async (tx) => {
    const company = randomUUID();
    const division = randomUUID();
    await tx.query(
      "INSERT INTO rooms (id, company_id, kind, created_by, shows_work) VALUES ($1, $2, 'company', 'platform', 'asked_here')",
      [company, fixture.companyId]);
    await tx.query(
      `INSERT INTO rooms (id, company_id, kind, division_id, created_by, shows_work)
       VALUES ($1, $2, 'division', $3, 'platform', 'needs_people')`,
      [division, fixture.companyId, fixture.divisionId]);
    return { company, division };
  });
}

/** Adds people to a room, as `who`: one row each, the name from the person. */
async function addMembers(tx: TenantClient, fixture: Fixture, roomId: string, who: Person, people: Person[]): Promise<void> {
  for (const person of people) {
    await tx.query(
      'INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, $4, $5)',
      [fixture.companyId, roomId, person.principal, person.name, who.principal]);
  }
}

/**
 * A topic room `who` makes, with its members. The id is made here and the row
 * inserted without RETURNING: a private room is not the maker's to see until
 * the insert's own trigger gives them access.
 */
async function topic(fixture: Fixture, who: Person, name: string, isPrivate: boolean, others: Person[] = []): Promise<string> {
  return withPeople(fixture.companyId, who, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO rooms (id, company_id, kind, name, private, created_by) VALUES ($1, $2, 'topic', $3, $4, $5)",
      [id, fixture.companyId, name, isPrivate, who.principal]);
    await addMembers(tx, fixture, id, who, [who, ...others]);
    return id;
  });
}

/** The direct room of a set of people, opened by the first of them. */
function keyOf(people: Person[]): string {
  return people.map((person) => person.principal).sort().join(',');
}
async function direct(fixture: Fixture, opener: Person, others: Person[]): Promise<string> {
  return withPeople(fixture.companyId, opener, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO rooms (id, company_id, kind, private, direct_key, created_by) VALUES ($1, $2, 'direct', true, $3, $4)",
      [id, fixture.companyId, keyOf([opener, ...others]), opener.principal]);
    await addMembers(tx, fixture, id, opener, [opener, ...others]);
    return id;
  });
}

/** A person's message, as `who` writes it. */
async function post(
  fixture: Fixture, who: Person, roomId: string, body: string,
  more: { threadOf?: string; mentions?: string[]; mentionsRoom?: boolean } = {},
): Promise<string> {
  return withPeople(fixture.companyId, who, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, thread_of, mentions, mentions_room)
       VALUES ($1, $2, $3, 'text', $4, $5, $6, $7, $8)`,
      [id, fixture.companyId, roomId, who.principal, body, more.threadOf ?? null, more.mentions ?? [], more.mentionsRoom ?? false]);
    return id;
  });
}

/** A card the platform draws in a room: a kind and an id, never words. */
async function card(fixture: Fixture, roomId: string, kind: 'work' | 'notice', taskId: string | null = null): Promise<string> {
  return withRoomPlatform(fixture.companyId, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, kind, author, task_id, notice_code)
       VALUES ($1, $2, $3, $4, 'platform', $5, $6)`,
      [id, fixture.companyId, roomId, kind, taskId, kind === 'notice' ? 'recorded' : null]);
    return id;
  });
}

async function newTask(fixture: Fixture): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'reconcile the March invoices' },
    createdBy: 'owner', reserveTokens: 100,
  });
  return task.id;
}

/** What `who` reads of a room table with no filter at all: a handler that forgot its WHERE. */
async function ids(fixture: Fixture, who: Person, sql: string): Promise<string[]> {
  return withPeople(fixture.companyId, who, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(sql);
    return rows.map((row) => row.id).sort();
  });
}

/** The statement is refused by the database with `code`, and with `message` when given. */
async function refused(attempt: () => Promise<unknown>, code: string, message?: RegExp, why = ''): Promise<void> {
  await assert.rejects(attempt, (error: unknown) => {
    const failure = error as { code?: string; message?: string };
    assert.equal(failure.code, code, `${why}: ${failure.message}`);
    if (message) assert.match(failure.message ?? '', message, why);
    return true;
  }, why);
}

const RLS = /row-level security|row level security/;
const DENIED = /permission denied/;

test('a room table read without a reader returns nothing, even in its own company', async () => {
  const fixture = await createCompany('rooms-no-reader');
  const siti = await seat(fixture, 'Siti Rahayu');
  const rooms = await sharedRooms(fixture);
  const open = await topic(fixture, siti.person, 'launch', false);
  const words = await post(fixture, siti.person, open, 'The launch moves to Thursday.');
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, $3, '👍')",
    [fixture.companyId, words, siti.person.principal]));

  // Every table holds rows for this company...
  const held = await withControlPlane(async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of ROOM_TABLES) {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [fixture.companyId]);
      counts[table] = rows[0]!.n;
    }
    return counts;
  });
  for (const table of ['room_clock', 'rooms', 'room_members', 'room_places', 'room_messages', 'room_reactions', 'room_feed', 'room_follows']) {
    assert.ok(held[table]! > 0, `${table} holds a row to hide: ${JSON.stringify(held)}`);
  }

  // ...and the company's own agents read none of them, and write none.
  await withTenant(fixture.companyId, async (tx) => {
    for (const table of ROOM_TABLES) {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(rows[0]!.n, 0, `an agent read ${table}`);
    }
  });
  await refused(() => withTenant(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', 'owner', 'approve it')",
    [fixture.companyId, rooms.company])), '42501', RLS, 'an agent writing a message as the owner');
  await refused(() => withTenant(fixture.companyId, (tx) => tx.query(
    "INSERT INTO rooms (company_id, kind, name, created_by) VALUES ($1, 'topic', 'agents', 'platform')",
    [fixture.companyId])), '42501', RLS, 'an agent making a room');
  const changed = await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE room_messages SET body = 'changed' WHERE company_id = $1", [fixture.companyId]));
  assert.equal(changed.rowCount, 0, 'an agent changed a message');

  // A statement of an agent's that changes nothing writes nothing either,
  // not even its company's clock, and holds no lock people's writes wait on.
  const quiet = await createCompany('rooms-no-reader-quiet');
  await withTenant(quiet.companyId, async (tx) => {
    await tx.query("UPDATE rooms SET about = 'agents were here' WHERE false");
    await tx.query('DELETE FROM room_reactions WHERE false');
    await tx.query(
      "INSERT INTO room_messages (company_id, room_id, kind, author, body) SELECT company_id, id, 'text', 'owner', 'hi' FROM rooms WHERE false");
  });
  const clocks = await withControlPlane((tx) => tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM room_clock WHERE company_id = $1', [quiet.companyId]));
  assert.equal(clocks.rows[0]!.n, 0, "an agent's statement wrote its company's clock");

  // Nor does an application connection that names the control plane's
  // reader, which only the admin pool's triggers read.
  const client = await appPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_id', $1, true), set_config('app.reader', 'control', true)", [fixture.companyId]);
    const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM room_messages');
    assert.equal(rows[0]!.n, 0, 'the control reader opened a room table to the application role');
    // Nor is it told whether a room exists, by asking who may see it.
    await client.query("SELECT set_config('app.reader', '', true)");
    const { rows: told } = await client.query<{ seen: boolean }>('SELECT app.may_see($1, $2, $3) AS seen',
      [fixture.companyId, rooms.company, 'owner']);
    assert.equal(told[0]!.seen, false, 'an agent learned that a room exists');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('a person reads the open rooms, the private rooms they are in and their direct rooms, and nothing else, even by a query with no filter', async () => {
  const fixture = await createCompany('rooms-visible');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const citra = await seat(fixture, 'Citra Lestari', 'viewer');
  const shared = await sharedRooms(fixture);
  const open = await topic(fixture, siti.person, 'launch', false);
  const secret = await topic(fixture, siti.person, 'salaries', true, [budi.person]);
  const pair = await direct(fixture, siti.person, [budi.person]);
  const mine = await direct(fixture, budi.person, [citra.person]);
  const said: Record<string, string> = {};
  for (const [name, room] of Object.entries({ company: shared.company, division: shared.division, open, secret, pair, mine })) {
    said[name] = await post(fixture, name === 'mine' ? budi.person : siti.person, room, `In ${name}.`);
  }

  // Citra: the shared rooms, the open topic, and her own direct room.
  const visible = [shared.company, shared.division, open, mine].sort();
  assert.deepEqual(await ids(fixture, citra.person, 'SELECT id FROM rooms'), visible);
  assert.deepEqual(await ids(fixture, citra.person, 'SELECT id FROM room_messages'),
    [said.company, said.division, said.open, said.mine].sort() as string[]);
  assert.deepEqual(await ids(fixture, citra.person, 'SELECT DISTINCT room_id AS id FROM room_members'),
    [open, mine].sort(), 'the members of the rooms she can see, and only those');
  assert.deepEqual(await ids(fixture, citra.person, 'SELECT DISTINCT room_id AS id FROM room_feed WHERE principal IS NULL'),
    visible, 'what changed, in the rooms she can see');

  // Budi: the private room he was added to, and both his direct rooms.
  assert.deepEqual(await ids(fixture, budi.person, 'SELECT id FROM rooms'),
    [shared.company, shared.division, open, secret, pair, mine].sort());
  // Siti: not Budi and Citra's.
  assert.deepEqual(await ids(fixture, siti.person, 'SELECT id FROM rooms'),
    [shared.company, shared.division, open, secret, pair].sort());

  // Naming a room she cannot see by its id finds nothing either.
  const named = await withPeople(fixture.companyId, citra.person, (tx) => tx.query(
    'SELECT body FROM room_messages WHERE room_id = $1', [secret]));
  assert.equal(named.rowCount, 0);
  // Nor may she write into it, or join it.
  await refused(() => post(fixture, citra.person, secret, 'Let me in.'), '42501', RLS, 'writing into a private room');
  await refused(() => withPeople(fixture.companyId, citra.person, (tx) => tx.query(
    'INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, $4, $3)',
    [fixture.companyId, secret, citra.person.principal, citra.person.name])), '42501', RLS, 'joining a private room');
});

test('the owner reads every private topic room, and no direct room they are not in', async () => {
  const fixture = await createCompany('rooms-owner');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const secret = await topic(fixture, siti.person, 'salaries', true, [budi.person]);
  const pair = await direct(fixture, siti.person, [budi.person]);
  const withOwner = await direct(fixture, siti.person, [OWNER]);
  const inSecret = await post(fixture, siti.person, secret, 'Budi, your raise is approved.');
  const inPair = await post(fixture, budi.person, pair, 'Between us.');
  const toOwner = await post(fixture, siti.person, withOwner, 'A word, boss.');

  const rooms = await ids(fixture, OWNER, "SELECT id FROM rooms WHERE kind IN ('topic', 'direct')");
  assert.deepEqual(rooms, [secret, withOwner].sort());
  const messages = await ids(fixture, OWNER, 'SELECT id FROM room_messages');
  assert.deepEqual(messages, [inSecret, toOwner].sort());
  assert.ok(!messages.includes(inPair), 'the owner read a direct message they are not in');
});

test('a person of one company sees nothing of another', async () => {
  const ours = await createCompany('rooms-ours');
  const theirs = await createCompany('rooms-theirs');
  const siti = await seat(ours, 'Siti Rahayu');
  const dewi = await seat(theirs, 'Dewi Kusuma');
  const theirRooms = await sharedRooms(theirs);
  await sharedRooms(ours);
  const theirOpen = await topic(theirs, dewi.person, 'pricing', false);
  await post(theirs, dewi.person, theirOpen, 'Our prices go up in May.');
  await post(theirs, OWNER, theirRooms.company, 'Welcome, Dewi.');

  for (const who of [siti.person, OWNER]) {
    await withPeople(ours.companyId, who, async (tx) => {
      for (const table of ROOM_TABLES) {
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [theirs.companyId]);
        assert.equal(rows[0]!.n, 0, `${who.principal} read ${table} of another company`);
      }
    });
  }
  await refused(() => withPeople(ours.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', $3, 'hello')",
    [theirs.companyId, theirOpen, siti.person.principal])), '42501', undefined, 'writing into another company');
  await refused(() => withPeople(ours.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', $3, 'hello')",
    [ours.companyId, theirOpen, siti.person.principal])), '42501', RLS, 'a message of ours in their room');
});

test("a person cannot write a message in another's name, nor text as the platform, nor a message already marked as work, nor one that claims to come through a relay", async () => {
  const fixture = await createCompany('rooms-authors');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const { company } = await sharedRooms(fixture);
  const taskId = await newTask(fixture);
  const insert = (who: Person, columns: Record<string, unknown>) => withPeople(fixture.companyId, who, async (tx) => {
    const values = { id: randomUUID(), company_id: fixture.companyId, room_id: company, kind: 'text', body: 'Approve the payment.', ...columns };
    const names = Object.keys(values);
    await tx.query(`INSERT INTO room_messages (${names.join(', ')}) VALUES (${names.map((_n, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values));
  });

  await refused(() => insert(siti.person, { author: budi.person.principal }), '42501', RLS, "in Budi's name");
  await refused(() => insert(siti.person, { author: 'owner' }), '42501', RLS, "in the owner's name");
  await refused(() => insert(OWNER, { author: siti.person.principal }), '42501', RLS, "the owner in Siti's name");
  await refused(() => insert(siti.person, { author: 'platform' }), '42501', RLS, 'text as the platform');
  await refused(() => insert(siti.person, { author: 'platform', kind: 'notice', notice_code: 'recorded', body: null }),
    '42501', RLS, 'a notice as the platform');
  await refused(() => insert(siti.person, {
    author: siti.person.principal, became: 'work', became_by: siti.person.principal, became_at: new Date(), task_id: taskId,
  }), '23514', /becomes anything else only by a press/, 'a message already marked as work');
  await refused(() => insert(siti.person, { author: siti.person.principal, via: 'relay', via_relay: randomUUID() }),
    '23514', /where it came from/, 'one that claims to come through a relay');
  await refused(() => insert(siti.person, { author: siti.person.principal, via: 'import' }),
    '23514', /where it came from/, 'one that claims to be imported');
  await refused(() => insert(siti.person, { author: 'former:slack:U024BE7LH' }), '42501', RLS, "a former person's words");

  // What a relay's inbound code says for a person is the one way to be
  // through a relay, and then the message must say so.
  const relayId = randomUUID();
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', $3, 'from my phone')",
    [fixture.companyId, company, siti.person.principal]), { relayId }), '23514', /where it came from/,
  'a relayed message that says it was typed here');
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body, via, via_relay) VALUES ($1, $2, 'text', $3, 'from my phone', 'relay', $4)",
    [fixture.companyId, company, siti.person.principal, relayId]), { relayId });

  // Her own words, as herself, go in.
  await insert(siti.person, { author: siti.person.principal });
  const written = await withControlPlane((tx) => tx.query<{ author: string; via: string; via_relay: string | null }>(
    'SELECT author, via, via_relay FROM room_messages WHERE company_id = $1 ORDER BY position', [fixture.companyId]));
  assert.deepEqual(written.rows, [
    { author: siti.person.principal, via: 'relay', via_relay: relayId },
    { author: siti.person.principal, via: 'console', via_relay: null },
  ]);
});

test("a person's name on a message is the one the session gave, whatever the insert says", async () => {
  const fixture = await createCompany('rooms-names');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company } = await sharedRooms(fixture);
  const write = (who: Person, name: string) => withPeople(fixture.companyId, who, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO room_messages (id, company_id, room_id, kind, author, author_name, body) VALUES ($1, $2, $3, 'text', $4, $5, 'Hello.')",
      [id, fixture.companyId, company, who.principal, name]);
    return id;
  });
  const hers = await write(siti.person, 'The Owner');
  const owners = await write(OWNER, 'Siti Rahayu');
  const names = await withControlPlane((tx) => tx.query<{ id: string; author_name: string | null }>(
    'SELECT id, author_name FROM room_messages WHERE company_id = $1', [fixture.companyId]));
  const nameOf = new Map(names.rows.map((row) => [row.id, row.author_name]));
  assert.equal(nameOf.get(hers), 'Siti Rahayu', 'the seat is named as the owner named it');
  assert.equal(nameOf.get(owners), null, 'the owner is drawn as the owner, never by a name');

  // Her membership is named the same way, whatever the row says.
  const room = await withPeople(fixture.companyId, siti.person, async (tx) => {
    const id = randomUUID();
    await tx.query("INSERT INTO rooms (id, company_id, kind, name, created_by) VALUES ($1, $2, 'topic', 'ops', $3)",
      [id, fixture.companyId, siti.person.principal]);
    await tx.query("INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, 'Owner', $3)",
      [fixture.companyId, id, siti.person.principal]);
    return id;
  });
  const member = await withControlPlane((tx) => tx.query<{ name: string }>(
    'SELECT name FROM room_members WHERE company_id = $1 AND room_id = $2', [fixture.companyId, room]));
  assert.equal(member.rows[0]!.name, 'Siti Rahayu');

  // A room is made now and open, whatever its insert says: nobody makes one
  // already archived in someone else's name, nor dated before it was made.
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO rooms (id, company_id, kind, name, created_by, archived_at, archived_by) VALUES ($1, $2, 'topic', 'old', $3, now(), 'owner')",
    [randomUUID(), fixture.companyId, siti.person.principal])), '23514', /made open/, 'a room made archived by the owner');
  const dated = randomUUID();
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO rooms (id, company_id, kind, name, created_by, created_at) VALUES ($1, $2, 'topic', 'history', $3, '2020-01-01')",
    [dated, fixture.companyId, siti.person.principal]));
  const made = await withControlPlane((tx) => tx.query<{ age: number }>(
    'SELECT extract(epoch FROM clock_timestamp() - created_at)::float8 AS age FROM rooms WHERE id = $1', [dated]));
  assert.ok(made.rows[0]!.age < 600, `a room is dated when it was made, not ${made.rows[0]!.age} s before`);

  // Archiving is a person's act, named from their session: the platform
  // archives nothing, in nobody's name.
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "UPDATE rooms SET archived_at = now(), archived_by = 'owner' WHERE id = $1", [dated])), '23514', /archived by a person/,
  'the platform archiving a room as the owner');
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "UPDATE rooms SET archived_at = now(), archived_by = 'owner' WHERE id = $1", [dated]));
  const archived = await withControlPlane((tx) => tx.query<{ archived_by: string }>(
    'SELECT archived_by FROM rooms WHERE id = $1', [dated]));
  assert.equal(archived.rows[0]!.archived_by, siti.person.principal, 'who archived it is who asked');
});

test("only a topic room's creator, one of its admins or the owner makes someone its admin", async () => {
  const fixture = await createCompany('rooms-admins');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const citra = await seat(fixture, 'Citra Lestari', 'viewer');
  const { company } = await sharedRooms(fixture);
  const ADMINS = /admins are made by its creator, one of its admins or the owner/;
  const join = (who: Person, room: string, role: 'member' | 'admin' = 'member') => withPeople(fixture.companyId, who, (tx) => tx.query(
    'INSERT INTO room_members (company_id, room_id, principal, name, role, added_by) VALUES ($1, $2, $3, $4, $5, $3)',
    [fixture.companyId, room, who.principal, who.name, role]));
  const make = (who: Person, room: string, principal: string, role: 'member' | 'admin') => withPeople(fixture.companyId, who, (tx) => tx.query(
    'UPDATE room_members SET role = $3 WHERE room_id = $1 AND principal = $2', [room, principal, role]));
  const roles = (room: string) => withControlPlane(async (tx) => Object.fromEntries((await tx.query<{ principal: string; role: string }>(
    'SELECT principal, role FROM room_members WHERE company_id = $1 AND room_id = $2', [fixture.companyId, room])).rows
    .map((row) => [row.principal, row.role])));

  // Its creator is its admin from the start.
  const launch = await withPeople(fixture.companyId, siti.person, async (tx) => {
    const id = randomUUID();
    await tx.query("INSERT INTO rooms (id, company_id, kind, name, created_by) VALUES ($1, $2, 'topic', 'launch', $3)",
      [id, fixture.companyId, siti.person.principal]);
    await tx.query(
      "INSERT INTO room_members (company_id, room_id, principal, name, role, added_by) VALUES ($1, $2, $3, $4, 'admin', $3)",
      [fixture.companyId, id, siti.person.principal, siti.person.name]);
    return id;
  });

  // Nobody else makes themselves one, by joining or afterwards, and nobody
  // who is not one takes it from the creator.
  await refused(() => join(citra.person, launch, 'admin'), '42501', ADMINS, 'joining as an admin');
  await join(citra.person, launch);
  await join(budi.person, launch);
  await refused(() => make(citra.person, launch, siti.person.principal, 'member'), '42501', ADMINS, 'demoting its creator');
  await refused(() => make(budi.person, launch, budi.person.principal, 'admin'), '42501', ADMINS, 'promoting oneself');
  assert.deepEqual(await roles(launch),
    { [siti.person.principal]: 'admin', [budi.person.principal]: 'member', [citra.person.principal]: 'member' });

  // Its creator makes one, an admin makes another, and the owner may too.
  await make(siti.person, launch, budi.person.principal, 'admin');
  await make(budi.person, launch, citra.person.principal, 'admin');
  await make(OWNER, launch, citra.person.principal, 'member');
  assert.deepEqual(await roles(launch),
    { [siti.person.principal]: 'admin', [budi.person.principal]: 'admin', [citra.person.principal]: 'member' });

  // An admin who has left is one no longer.
  await withPeople(fixture.companyId, budi.person, (tx) => tx.query(
    'UPDATE room_members SET left_at = now() WHERE room_id = $1 AND principal = $2', [launch, budi.person.principal]));
  await refused(() => make(budi.person, launch, citra.person.principal, 'admin'), '42501', ADMINS, 'an admin who left');

  // And a room that is not a topic room has no admins at all.
  await refused(() => join(siti.person, company, 'admin'), '23514', /only a topic room has admins/, 'an admin of the company room');
});

test("the platform writes no text, changes no person's message, and a card holds no words", async () => {
  const fixture = await createCompany('rooms-platform');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company, division } = await sharedRooms(fixture);
  const hers = await post(fixture, siti.person, company, 'Please send the March invoices.');
  const taskId = await newTask(fixture);
  const work = await card(fixture, division, 'work', taskId);

  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', 'platform', 'Approved.')",
    [fixture.companyId, company])), '23514', undefined, 'text as the platform');
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', $3, 'Approved.')",
    [fixture.companyId, company, siti.person.principal])), '42501', RLS, "text in Siti's name");
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, body, notice_code) VALUES ($1, $2, 'notice', 'platform', 'The owner approved it.', 'recorded')",
    [fixture.companyId, company])), '23514', /cards_have_no_words/, 'a card with words');

  const touched = await withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "UPDATE room_messages SET deleted_at = now(), body = NULL WHERE id = $1", [hers]));
  assert.equal(touched.rowCount, 0, "the platform removed a person's message");
  const linked = await withRoomPlatform(fixture.companyId, (tx) => tx.query(
    'UPDATE room_messages SET task_id = $2 WHERE id = $1', [hers, taskId]));
  assert.equal(linked.rowCount, 0, "the platform pointed a person's message at work");
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "UPDATE room_messages SET body = 'Approved.' WHERE id = $1", [work])), '23514', undefined, 'words on a card');

  // What it may change is what a card points at and how it was drawn.
  await withRoomPlatform(fixture.companyId, (tx) => tx.query(
    `UPDATE room_messages SET notice_values = '{"state":"running"}' WHERE id = $1`, [work]));
  const rows = await withControlPlane((tx) => tx.query<{ id: string; body: string | null; via: string; feed: string[] }>(
    `SELECT m.id, m.body, m.via,
            ARRAY(SELECT f.kind FROM room_feed f WHERE f.company_id = m.company_id AND f.ref = m.id ORDER BY f.position) AS feed
       FROM room_messages m WHERE m.company_id = $1`, [fixture.companyId]));
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(hers)!.body, 'Please send the March invoices.');
  assert.equal(byId.get(work)!.body, null);
  assert.equal(byId.get(work)!.via, 'platform');
  assert.deepEqual(byId.get(work)!.feed, ['message', 'card'], 'a card that changes is drawn again');

  // And a card never keeps what it shows alive: retention takes an item on
  // the control plane, as it does, and the card lets go of it.
  const itemId = await withControlPlane(async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO inbox_items (company_id, kind, title, action_summary, rationale, consequence_if_denied)
     VALUES ($1, 'fact_candidate', 'Our roaster delivers on Tuesdays', 'Remember it', 'Seen in three orders.', '') RETURNING id`,
    [fixture.companyId])).rows[0]!.id);
  const approval = await withRoomPlatform(fixture.companyId, async (tx) => {
    const id = randomUUID();
    await tx.query("INSERT INTO room_messages (id, company_id, room_id, kind, author, inbox_item_id) VALUES ($1, $2, $3, 'approval', 'platform', $4)",
      [id, fixture.companyId, division, itemId]);
    return id;
  });
  await withControlPlane((tx) => tx.query('DELETE FROM inbox_items WHERE id = $1', [itemId]));
  const released = await withControlPlane((tx) => tx.query<{ inbox_item_id: string | null }>(
    'SELECT inbox_item_id FROM room_messages WHERE id = $1', [approval]));
  assert.deepEqual(released.rows, [{ inbox_item_id: null }]);

  // Two questions one task put, each a card in the same room: retention may
  // take both items while the task stays, and each card lets go of its own
  // without the two becoming the same card.
  const asked = await withControlPlane(async (tx) => {
    const made: string[] = [];
    for (const title of ['Which roaster?', 'Which day?']) {
      made.push((await tx.query<{ id: string }>(
        `INSERT INTO inbox_items (company_id, task_id, kind, title, action_summary, rationale)
         VALUES ($1, $2, 'escalation', $3, 'Answer it', 'The run cannot choose.') RETURNING id`,
        [fixture.companyId, taskId, title])).rows[0]!.id);
    }
    return made;
  });
  const questions = await withRoomPlatform(fixture.companyId, async (tx) => {
    const made: string[] = [];
    for (const itemOf of asked) {
      const id = randomUUID();
      await tx.query(
        "INSERT INTO room_messages (id, company_id, room_id, kind, author, task_id, inbox_item_id) VALUES ($1, $2, $3, 'question', 'platform', $4, $5)",
        [id, fixture.companyId, division, taskId, itemOf]);
      made.push(id);
    }
    return made;
  });
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, task_id, inbox_item_id) VALUES ($1, $2, 'question', 'platform', $3, $4)",
    [fixture.companyId, division, taskId, asked[0]])), '23505', /room_cards_once/, 'a second card for one question');
  await withControlPlane((tx) => tx.query('DELETE FROM inbox_items WHERE id = ANY($1::uuid[])', [asked]));
  const letGo = await withControlPlane((tx) => tx.query<{ inbox_item_id: string | null; task_id: string | null }>(
    'SELECT inbox_item_id, task_id FROM room_messages WHERE id = ANY($1::uuid[])', [questions]));
  assert.deepEqual(letGo.rows, [{ inbox_item_id: null, task_id: taskId }, { inbox_item_id: null, task_id: taskId }]);
  // One work card per task in a room, as before.
  await refused(() => card(fixture, division, 'work', taskId), '23505', /room_work_cards_once/, 'a second card for one piece of work');
});

test("a room file's path is its own place in its room, never a way out of it", async () => {
  const fixture = await createCompany('rooms-file-paths');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company } = await sharedRooms(fixture);
  const hers = await post(fixture, siti.person, company, 'The payroll is attached.');
  const attach = (id: string, path: string | null) => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    `INSERT INTO room_files (id, company_id, message_id, name, mime, bytes, sha256, path)
     VALUES ($1, $2, $3, 'payroll.pdf', 'application/pdf', 1024, $4, $5)`,
    [id, fixture.companyId, hers, 'a'.repeat(64), path]));

  const id = randomUUID();
  for (const path of [
    '../../other/secret.pdf',
    `rooms/${company}/../../${id}.pdf`,
    `/rooms/${company}/${id}.pdf`,
    `rooms/${company}/${randomUUID()}.pdf`,
    `rooms/${company}/${id}`,
    `rooms/${company}/${id}.pdf/../x.pdf`,
    `rooms/${company}/${id}.PDF`,
    `rooms/not-a-room/${id}.pdf`,
  ]) {
    await refused(() => attach(id, path), '23514', /room_files_path_shape/, path);
  }
  // The shape the people's files root keeps: the room, the file's own id and
  // the extension sniffed from its bytes. A file not kept has no path.
  await attach(id, `rooms/${company}/${id}.pdf`);
  await attach(randomUUID(), null);
});

test('a person changes only their own place in a room, and never moves a read mark back', async () => {
  const fixture = await createCompany('rooms-places');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const room = await topic(fixture, siti.person, 'launch', false, [budi.person]);
  for (let n = 1; n <= 3; n += 1) await post(fixture, budi.person, room, `Update ${n}.`);
  const clock = async () => (await withDelivery(fixture.companyId, (tx) => tx.query<{ position: string }>(
    'SELECT position FROM room_clock'))).rows[0]!.position;
  const place = async (who: Seated) => (await withControlPlane((tx) => tx.query<{ read_position: string; notify: string }>(
    'SELECT read_position, notify FROM room_places WHERE company_id = $1 AND room_id = $2 AND principal = $3',
    [fixture.companyId, room, who.person.principal]))).rows[0]!;

  const now = Number(await clock());
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'UPDATE room_places SET read_position = $2 WHERE room_id = $1', [room, now]));
  assert.equal(Number((await place(siti)).read_position), now);
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'UPDATE room_places SET read_position = 1 WHERE room_id = $1', [room]));
  assert.equal(Number((await place(siti)).read_position), now, 'a read mark never moves back');
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'UPDATE room_places SET read_position = $2 WHERE room_id = $1', [room, now + 100])), '23514', /past the last change/);

  // Budi's place is not hers to touch, and a place is made by joining, not by hand.
  const before = await place(budi);
  const others = await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "UPDATE room_places SET notify = 'none', read_position = $2 WHERE principal = $1", [budi.person.principal, now]));
  assert.equal(others.rowCount, 0);
  assert.deepEqual(await place(budi), before);
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'INSERT INTO room_places (company_id, room_id, principal) VALUES ($1, $2, $3)',
    [fixture.companyId, room, budi.person.principal])), '42501', DENIED);
});

test('a person cannot read when a colleague last read a room, nor whether they muted it', async () => {
  const fixture = await createCompany('rooms-receipts');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const room = await topic(fixture, siti.person, 'launch', false, [budi.person]);
  await post(fixture, siti.person, room, 'Did you see the draft?');
  await withPeople(fixture.companyId, budi.person, (tx) => tx.query(
    `UPDATE room_places SET read_position = (SELECT max(position) FROM room_messages WHERE room_id = $1),
            muted_until = now() + interval '1 day', notify = 'none'
      WHERE room_id = $1`, [room]));

  const seen = await withPeople(fixture.companyId, siti.person, async (tx) => {
    const places = await tx.query<{ principal: string }>('SELECT principal FROM room_places');
    const reads = await tx.query<{ principal: string }>("SELECT principal FROM room_feed WHERE kind = 'read'");
    return { places: places.rows.map((row) => row.principal), reads: reads.rows.map((row) => row.principal) };
  });
  assert.deepEqual(seen, { places: [siti.person.principal], reads: [] });
  const own = await withPeople(fixture.companyId, budi.person, (tx) => tx.query<{ principal: string }>(
    "SELECT principal FROM room_feed WHERE kind = 'read'"));
  assert.deepEqual(own.rows.map((row) => row.principal), [budi.person.principal], 'his own devices are told');
});

test('only its author edits a message, within a day, and the earlier words are kept for the owner', async () => {
  const fixture = await createCompany('rooms-edits');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const { company } = await sharedRooms(fixture);
  const hers = await post(fixture, siti.person, company, 'The launch is on Tuesday.');
  const edit = (who: Person, id: string, body: string) => withPeople(fixture.companyId, who, (tx) => tx.query(
    'UPDATE room_messages SET body = $2, edited_at = now() WHERE id = $1', [id, body]));

  await refused(() => edit(budi.person, hers, 'The launch is cancelled.'), '42501', /only its author edits/);
  await refused(() => edit(OWNER, hers, 'The launch is cancelled.'), '42501', /only its author edits/);
  await edit(siti.person, hers, 'The launch is on Thursday.');

  const revisions = (who: Person) => withPeople(fixture.companyId, who, (tx) => tx.query<{ body: string }>(
    'SELECT body FROM room_message_revisions WHERE message_id = $1', [hers]));
  assert.deepEqual((await revisions(OWNER)).rows.map((row) => row.body), ['The launch is on Tuesday.']);
  assert.equal((await revisions(siti.person)).rowCount, 0, 'the earlier words are the owner\'s record, not the room\'s');
  const now = await withControlPlane((tx) => tx.query<{ body: string; edited: boolean }>(
    'SELECT body, edited_at IS NOT NULL AS edited FROM room_messages WHERE id = $1', [hers]));
  assert.deepEqual(now.rows[0], { body: 'The launch is on Thursday.', edited: true });

  // A day later it stands as it is. Written through the control plane's
  // import, which keeps when a message was written.
  const old = randomUUID();
  await withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, fixture.companyId, { importing: true });
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, kind, author, author_name, body, created_at)
       VALUES ($1, $2, $3, 'text', $4, 'Siti Rahayu', 'Yesterday''s plan.', now() - interval '25 hours')`,
      [old, fixture.companyId, company, siti.person.principal]);
  });
  await refused(() => edit(siti.person, old, 'Today\'s plan.'), '23514', /within a day/);

  // A removed message is gone with its revisions, and is not edited back.
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'UPDATE room_messages SET deleted_at = now() WHERE id = $1', [hers]));
  const gone = await withControlPlane((tx) => tx.query<{ body: string | null; deleted_by: string; revisions: number }>(
    `SELECT body, deleted_by, (SELECT count(*)::int FROM room_message_revisions WHERE message_id = $1) AS revisions
       FROM room_messages WHERE id = $1`, [hers]));
  assert.deepEqual(gone.rows[0], { body: null, deleted_by: siti.person.principal, revisions: 0 });
  await refused(() => edit(siti.person, hers, 'Back again.'), '23514', /new words/);
});

test('a reaction on a card is refused', async () => {
  const fixture = await createCompany('rooms-reactions');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company, division } = await sharedRooms(fixture);
  const work = await card(fixture, division, 'work', await newTask(fixture));
  const notice = await card(fixture, company, 'notice');
  const hers = await post(fixture, siti.person, company, 'Lunch is on me.');
  const react = (message: string) => withPeople(fixture.companyId, OWNER, (tx) => tx.query(
    "INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, 'owner', '👍')",
    [fixture.companyId, message]));

  await refused(() => react(work), '23514', /not a card/, 'a 👍 on a work card');
  await refused(() => react(notice), '23514', /not a card/, 'a 👍 on a notice');
  await react(hers);
  await withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'UPDATE room_messages SET deleted_at = now() WHERE id = $1', [hers]));
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, $3, '🎉')",
    [fixture.companyId, hers, siti.person.principal])), '23514', /not a card/, 'a reaction on a removed message');
  const another = await post(fixture, siti.person, company, 'And dessert.');
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, 'owner', '🎉')",
    [fixture.companyId, another])), '42501', RLS, "a reaction in the owner's name");
});

test('the delivery reader reads no message, revision, reaction or file', async () => {
  const fixture = await createCompany('rooms-delivery');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company } = await sharedRooms(fixture);
  const hers = await post(fixture, siti.person, company, 'Salaries are paid on the 25th.', { mentions: [OWNER.principal] });
  await withPeople(fixture.companyId, siti.person, async (tx) => {
    await tx.query("UPDATE room_messages SET body = 'Salaries are paid on the 26th.' WHERE id = $1", [hers]);
    await tx.query("INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, $3, '👍')",
      [fixture.companyId, hers, siti.person.principal]);
    await tx.query(
      "INSERT INTO room_files (company_id, message_id, name, mime, bytes) VALUES ($1, $2, 'payroll.pdf', 'application/pdf', 1024)",
      [fixture.companyId, hers]);
  });

  const read = await withDelivery(fixture.companyId, async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of ROOM_TABLES) {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      counts[table] = rows[0]!.n;
    }
    return counts;
  });
  for (const table of ['room_messages', 'room_message_revisions', 'room_reactions', 'room_files']) {
    assert.equal(read[table], 0, `delivery read ${table}`);
  }
  for (const table of ['room_clock', 'rooms', 'room_feed', 'room_mentions']) {
    assert.ok(read[table]! > 0, `delivery is told of ${table}: ${JSON.stringify(read)}`);
  }
  // And it writes nothing.
  await refused(() => withDelivery(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_messages (company_id, room_id, kind, author, notice_code) VALUES ($1, $2, 'notice', 'platform', 'recorded')",
    [fixture.companyId, company])), '42501', RLS);
});

test('positions follow commit order: a later position never commits before an earlier one is seen', async () => {
  const fixture = await createCompany('rooms-order');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const { company } = await sharedRooms(fixture);
  const feed = () => withDelivery(fixture.companyId, async (tx) => (await tx.query<{ position: string }>(
    'SELECT position FROM room_feed ORDER BY position')).rows.map((row) => Number(row.position)));
  const before = await feed();

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let written!: () => void;
  const wrote = new Promise<void>((resolve) => { written = resolve; });
  const first = withPeople(fixture.companyId, siti.person, async (tx) => {
    const { rows } = await tx.query<{ position: string }>(
      "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', $3, 'First.') RETURNING position",
      [fixture.companyId, company, siti.person.principal]);
    written();
    await held;
    return Number(rows[0]!.position);
  });
  await wrote;
  let secondDone = false;
  const second = withPeople(fixture.companyId, budi.person, async (tx) => {
    const { rows } = await tx.query<{ position: string }>(
      "INSERT INTO room_messages (company_id, room_id, kind, author, body) VALUES ($1, $2, 'text', $3, 'Second.') RETURNING position",
      [fixture.companyId, company, budi.person.principal]);
    return Number(rows[0]!.position);
  }).then((position) => { secondDone = true; return position; });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(secondDone, false, 'the second writer waits for the first to commit');
  assert.deepEqual(await feed(), before, 'nothing uncommitted is seen, and nothing after it');
  release();
  const [one, two] = [await first, await second];
  assert.ok(two > one, `${two} after ${one}`);
  const after = await feed();
  assert.deepEqual(after.slice(before.length), [one, two]);
  assert.deepEqual(after, after.map((_position, index) => after[0]! + index), 'positions have no gaps');
});

test('an edit and a reply racing on one root both succeed', async () => {
  const fixture = await createCompany('rooms-race');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const { company } = await sharedRooms(fixture);
  for (let round = 0; round < 5; round += 1) {
    const root = await post(fixture, siti.person, company, `Plan ${round}.`);
    // The edit locks the root and then writes the feed; the reply takes a
    // position and then counts itself on the root. Without one lock order the
    // two wait for each other.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let edited!: () => void;
    const didEdit = new Promise<void>((resolve) => { edited = resolve; });
    const edit = withPeople(fixture.companyId, siti.person, async (tx) => {
      await tx.query('UPDATE room_messages SET body = $2 WHERE id = $1', [root, `Plan ${round}, revised.`]);
      edited();
      await held;
    });
    await didEdit;
    const reply = post(fixture, budi.person, company, 'Agreed.', { threadOf: root });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await edit;
    await reply;
    const { rows } = await withControlPlane((tx) => tx.query<{ body: string; reply_count: number }>(
      'SELECT body, reply_count FROM room_messages WHERE id = $1', [root]));
    assert.deepEqual(rows[0], { body: `Plan ${round}, revised.`, reply_count: 1 });
  }
  // And left to race freely, as two people would.
  for (let round = 0; round < 10; round += 1) {
    const root = await post(fixture, siti.person, company, `Agenda ${round}.`);
    const raced = await Promise.allSettled([
      withPeople(fixture.companyId, siti.person, (tx) => tx.query('UPDATE room_messages SET body = $2 WHERE id = $1', [root, `Agenda ${round}, final.`])),
      post(fixture, budi.person, company, 'Noted.', { threadOf: root }),
      post(fixture, OWNER, company, 'Thanks.', { threadOf: root }),
    ]);
    assert.deepEqual(raced.filter((one) => one.status === 'rejected').map((one) => String((one as PromiseRejectedResult).reason)), []);
    const { rows } = await withControlPlane((tx) => tx.query<{ body: string; reply_count: number }>(
      'SELECT body, reply_count FROM room_messages WHERE id = $1', [root]));
    assert.deepEqual(rows[0], { body: `Agenda ${round}, final.`, reply_count: 2 });
  }
});

test('a seat opens a direct room and a private room in one request', async () => {
  const fixture = await createCompany('rooms-open');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const opened = await withPeople(fixture.companyId, siti.person, async (tx) => {
    const pair = randomUUID();
    const secret = randomUUID();
    await tx.query(
      "INSERT INTO rooms (id, company_id, kind, private, direct_key, created_by) VALUES ($1, $2, 'direct', true, $3, $4)",
      [pair, fixture.companyId, keyOf([siti.person, budi.person]), siti.person.principal]);
    await addMembers(tx, fixture, pair, siti.person, [siti.person, budi.person]);
    await tx.query("INSERT INTO rooms (id, company_id, kind, name, private, created_by) VALUES ($1, $2, 'topic', 'hiring', true, $3)",
      [secret, fixture.companyId, siti.person.principal]);
    await addMembers(tx, fixture, secret, siti.person, [siti.person, budi.person]);
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM rooms ORDER BY id');
    return { pair, secret, seen: rows.map((row) => row.id) };
  });
  assert.deepEqual(opened.seen, [opened.pair, opened.secret].sort());
  assert.deepEqual(await ids(fixture, budi.person, 'SELECT id FROM rooms'), [opened.pair, opened.secret].sort());

  // Why no RETURNING: the row is checked against who may see it before the
  // insert's own trigger has given its maker access.
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO rooms (company_id, kind, name, private, created_by) VALUES ($1, 'topic', 'payroll', true, $2) RETURNING id",
    [fixture.companyId, siti.person.principal])), '42501', RLS);
});

test("a direct room's people are fixed: nobody is added, and its key names its opener", async () => {
  const fixture = await createCompany('rooms-direct');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const citra = await seat(fixture, 'Citra Lestari');
  const open = (who: Person, key: string) => withPeople(fixture.companyId, who, (tx) => tx.query(
    "INSERT INTO rooms (company_id, kind, private, direct_key, created_by) VALUES ($1, 'direct', true, $2, $3)",
    [fixture.companyId, key, who.principal]));

  await refused(() => open(citra.person, keyOf([siti.person, budi.person])), '23514', /opened_by_a_member/,
    "squatting another pair's key");
  await refused(() => open(siti.person, [budi.person.principal, siti.person.principal].sort().reverse().join(',')),
    '23514', /direct_people/, 'a key out of order');
  await refused(() => open(siti.person, siti.person.principal), '23514', /direct_people/, 'a room of one');
  await refused(() => open(siti.person, `${siti.person.principal},${siti.person.principal}`), '23514', /direct_people/, 'a person twice');
  await refused(() => open(siti.person, keyOf([siti.person, budi.person]).replace(budi.person.principal, 'role:writer')),
    '23514', /direct_people/, 'an agent in a direct room');

  const pair = await direct(fixture, siti.person, [budi.person]);
  await refused(() => direct(fixture, budi.person, [siti.person]), '23505', undefined, 'the same people open the same room');
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => addMembers(tx, fixture, pair, siti.person, [citra.person])),
    '23514', /people are the ones it was opened with/, 'adding a third');
  await refused(() => withPeople(fixture.companyId, budi.person, (tx) => tx.query(
    'UPDATE room_members SET left_at = now() WHERE room_id = $1 AND principal = $2', [pair, budi.person.principal])),
  '23514', /nobody leaves/, 'leaving');

  // Revoking a seat, on the control plane, is the one way out.
  await withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, fixture.companyId);
    await tx.query("UPDATE room_members SET left_at = now(), left_by = 'platform' WHERE company_id = $1 AND room_id = $2 AND principal = $3",
      [fixture.companyId, pair, budi.person.principal]);
  });
  assert.deepEqual(await ids(fixture, budi.person, "SELECT id FROM rooms WHERE kind = 'direct'"), []);
  assert.deepEqual(await ids(fixture, siti.person, "SELECT id FROM rooms WHERE kind = 'direct'"), [pair]);

  // Its people are all of its key, from the moment it is opened: one of them
  // cannot open it alone and so keep the others from ever having it.
  await refused(() => withPeople(fixture.companyId, siti.person, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO rooms (id, company_id, kind, private, direct_key, created_by) VALUES ($1, $2, 'direct', true, $3, $4)",
      [id, fixture.companyId, keyOf([siti.person, citra.person]), siti.person.principal]);
    await addMembers(tx, fixture, id, siti.person, [siti.person]);
  }), '23514', /everyone its key names/, 'a direct room opened with only its opener in it');
  const theirs = await direct(fixture, citra.person, [siti.person]);
  assert.deepEqual(await ids(fixture, siti.person, "SELECT id FROM rooms WHERE kind = 'direct'"), [pair, theirs].sort());
});

test('who else may see a room is asked by delivery and the platform, never by a person', async () => {
  const fixture = await createCompany('rooms-may-see');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const citra = await seat(fixture, 'Citra Lestari');
  const secret = await topic(fixture, siti.person, 'salaries', true, [budi.person]);
  const pair = await direct(fixture, budi.person, [citra.person]);
  const ask = (tx: TenantClient, room: string, who: Person) => tx.query<{ seen: boolean }>(
    'SELECT app.may_see($1, $2, $3) AS seen', [fixture.companyId, room, who.principal]).then((result) => result.rows[0]!.seen);

  // Delivery plans what each person is told, so it asks about anyone; so may
  // the platform, which owes card attention.
  for (const reader of [withDelivery, withRoomPlatform]) {
    assert.deepEqual(await reader(fixture.companyId, async (tx) => [
      await ask(tx, secret, budi.person), await ask(tx, secret, citra.person), await ask(tx, secret, OWNER),
      await ask(tx, pair, citra.person), await ask(tx, pair, siti.person), await ask(tx, pair, OWNER),
      await ask(tx, randomUUID(), OWNER),
    ]), [true, false, true, true, false, false, false]);
  }

  // A person asks only about themselves, which tells them no more than the
  // rooms they can read.
  assert.deepEqual(await withPeople(fixture.companyId, citra.person, async (tx) => [
    await ask(tx, secret, citra.person), await ask(tx, pair, citra.person)]), [false, true]);

  // Never about anyone else: neither whether a room they cannot see exists,
  // nor who is in it, even once they have left it.
  await refused(() => withPeople(fixture.companyId, citra.person, (tx) => ask(tx, secret, budi.person)), '42501', /only about themselves/,
    'a private room asked about by someone outside it');
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => ask(tx, pair, citra.person)), '42501', /only about themselves/,
    'a direct room asked about by someone outside it');
  await withPeople(fixture.companyId, budi.person, (tx) => tx.query(
    'UPDATE room_members SET left_at = now() WHERE room_id = $1 AND principal = $2', [secret, budi.person.principal]));
  await refused(() => withPeople(fixture.companyId, budi.person, (tx) => ask(tx, secret, siti.person)), '42501', /only about themselves/,
    'a private room asked about by someone who left it');
  // And the rule the triggers ask is not the application's to call at all.
  await refused(() => withPeople(fixture.companyId, citra.person, (tx) => tx.query('SELECT app.room_visible_to($1, $2, $3)',
    [fixture.companyId, secret, budi.person.principal])), '42501', DENIED, 'the triggers\' own rule');
});

test('leaving a private room ends its follows and unseen mentions there', async () => {
  const fixture = await createCompany('rooms-leaving');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const secret = await topic(fixture, siti.person, 'hiring', true, [budi.person]);
  const open = await topic(fixture, siti.person, 'launch', false, [budi.person]);
  const root = await post(fixture, siti.person, secret, '@budi can you interview Rina?', { mentions: [budi.person.principal] });
  await post(fixture, budi.person, secret, 'Yes, Friday.', { threadOf: root });
  const elsewhere = await post(fixture, siti.person, open, '@budi the launch notes?', { mentions: [budi.person.principal] });
  const attention = () => withControlPlane(async (tx) => ({
    follows: (await tx.query<{ root_id: string }>('SELECT root_id FROM room_follows WHERE company_id = $1 AND principal = $2 ORDER BY root_id',
      [fixture.companyId, budi.person.principal])).rows.map((row) => row.root_id),
    mentions: (await tx.query<{ message_id: string }>(
      'SELECT message_id FROM room_mentions WHERE company_id = $1 AND principal = $2 AND seen_at IS NULL ORDER BY message_id',
      [fixture.companyId, budi.person.principal])).rows.map((row) => row.message_id),
  }));
  assert.deepEqual(await attention(), { follows: [root, elsewhere].sort(), mentions: [root, elsewhere].sort() });

  await withPeople(fixture.companyId, budi.person, (tx) => tx.query(
    'UPDATE room_members SET left_at = now() WHERE room_id = $1 AND principal = $2', [secret, budi.person.principal]));
  assert.deepEqual(await attention(), { follows: [elsewhere], mentions: [elsewhere] }, 'what was owed there is gone, and only there');
  assert.ok(!(await ids(fixture, budi.person, 'SELECT id FROM rooms')).includes(secret), 'and he no longer sees it');
  const left = await withControlPlane((tx) => tx.query<{ left_by: string }>(
    'SELECT left_by FROM room_members WHERE company_id = $1 AND room_id = $2 AND principal = $3',
    [fixture.companyId, secret, budi.person.principal]));
  assert.equal(left.rows[0]!.left_by, budi.person.principal);
});

test('reply attention and card attention reach only people who can see the room', async () => {
  const fixture = await createCompany('rooms-attention');
  const siti = await seat(fixture, 'Siti Rahayu');
  const budi = await seat(fixture, 'Budi Santoso');
  const citra = await seat(fixture, 'Citra Lestari');
  const secret = await topic(fixture, siti.person, 'hiring', true, [budi.person]);
  const root = await post(fixture, siti.person, secret, 'Interviews this week; Citra need not know yet.',
    { mentions: [citra.person.principal] });
  // A follow left over for someone who cannot see the room, as an import
  // could leave one: it is never a way in.
  await withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, fixture.companyId);
    await tx.query('INSERT INTO room_follows (company_id, root_id, principal) VALUES ($1, $2, $3)',
      [fixture.companyId, root, citra.person.principal]);
  });
  const reply = await post(fixture, budi.person, secret, 'Rina on Friday.', { threadOf: root });
  const owed = await withControlPlane((tx) => tx.query<{ message_id: string; principal: string; reason: string }>(
    'SELECT message_id, principal, reason FROM room_mentions WHERE company_id = $1 ORDER BY message_id, principal',
    [fixture.companyId]));
  assert.deepEqual(owed.rows, [{ message_id: reply, principal: siti.person.principal, reason: 'reply' }],
    'Siti, who follows her own thread, is told; Citra, mentioned and following but outside, is not');

  // Card attention the sweep writes is held to the same rule.
  const work = await card(fixture, secret, 'work', await newTask(fixture));
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_mentions (company_id, message_id, principal, reason) VALUES ($1, $2, $3, 'card')",
    [fixture.companyId, work, citra.person.principal])), '23514', /can see the room/);
  await withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_mentions (company_id, message_id, principal, reason) VALUES ($1, $2, $3, 'card')",
    [fixture.companyId, work, budi.person.principal]));
  await withRoomPlatform(fixture.companyId, (tx) => tx.query(
    "INSERT INTO room_mentions (company_id, message_id, principal, reason) VALUES ($1, $2, 'owner', 'card')",
    [fixture.companyId, work]));
  // And a person writes no attention for anyone, their own included.
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    "INSERT INTO room_mentions (company_id, message_id, principal, reason) VALUES ($1, $2, $3, 'mention')",
    [fixture.companyId, work, siti.person.principal])), '42501', RLS);
});

test('the card cursor moves only forward, and only through its function', async () => {
  const fixture = await createCompany('rooms-cursor');
  const other = await createCompany('rooms-cursor-other');
  const siti = await seat(fixture, 'Siti Rahayu');
  const later = new Date('2026-11-08T10:00:00Z');
  const earlier = new Date('2026-11-08T09:00:00Z');
  const cursor = async () => (await withControlPlane((tx) => tx.query<{ cards_through: Date }>(
    'SELECT cards_through FROM room_clock WHERE company_id = $1', [fixture.companyId]))).rows[0]!.cards_through;

  await withRoomPlatform(fixture.companyId, (tx) => tx.query('SELECT app.advance_card_cursor($1, $2)', [fixture.companyId, later]));
  await withRoomPlatform(fixture.companyId, (tx) => tx.query('SELECT app.advance_card_cursor($1, $2)', [fixture.companyId, earlier]));
  assert.equal((await cursor()).toISOString(), later.toISOString(), 'never back');

  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    'UPDATE room_clock SET cards_through = $1', [earlier])), '42501', DENIED, 'written directly');
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query(
    'SELECT app.advance_card_cursor($1, $2)', [other.companyId, later])), '42501', /its own company/, "another company's");
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'SELECT app.advance_card_cursor($1, $2)', [fixture.companyId, later])), '42501', /platform reader/, 'by a person');
  await refused(() => withTenant(fixture.companyId, (tx) => tx.query(
    'SELECT app.advance_card_cursor($1, $2)', [fixture.companyId, later])), '42501', /platform reader/, 'by an agent');
  await refused(() => withPeople(fixture.companyId, siti.person, (tx) => tx.query(
    'SELECT app.next_room_position($1)', [fixture.companyId])), '42501', DENIED, 'a position taken by hand');
});

test('the application role cannot delete a message, nor change its author, room, kind or position', async () => {
  const fixture = await createCompany('rooms-fixed');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company, division } = await sharedRooms(fixture);
  const hers = await post(fixture, siti.person, company, 'Keep this.');
  for (const who of [siti.person, OWNER]) {
    await refused(() => withPeople(fixture.companyId, who, (tx) => tx.query('DELETE FROM room_messages WHERE id = $1', [hers])),
      '42501', DENIED, `${who.principal} deleting`);
    for (const [column, value] of [['author', 'owner'], ['room_id', division], ['kind', 'notice'], ['position', 1],
      ['created_at', new Date(0)], ['via', 'relay'], ['mentions', ['owner']]] as const) {
      await refused(() => withPeople(fixture.companyId, who, (tx) => tx.query(
        `UPDATE room_messages SET ${column} = $2 WHERE id = $1`, [hers, value])), '42501', DENIED, `${who.principal} changing ${column}`);
    }
  }
  await refused(() => withRoomPlatform(fixture.companyId, (tx) => tx.query('DELETE FROM room_messages WHERE id = $1', [hers])),
    '42501', DENIED, 'the platform deleting');
  const kept = await withControlPlane((tx) => tx.query<{ body: string; author: string }>(
    'SELECT body, author FROM room_messages WHERE id = $1', [hers]));
  assert.deepEqual(kept.rows[0], { body: 'Keep this.', author: siti.person.principal });
});

test("people cannot read the company's clock", async () => {
  const fixture = await createCompany('rooms-clock');
  const siti = await seat(fixture, 'Siti Rahayu');
  const { company } = await sharedRooms(fixture);
  await post(fixture, siti.person, company, 'Good morning.');
  for (const who of [siti.person, OWNER]) {
    const seen = await withPeople(fixture.companyId, who, (tx) => tx.query('SELECT position FROM room_clock'));
    assert.equal(seen.rowCount, 0, `${who.principal} read the clock`);
  }
  const told = await withDelivery(fixture.companyId, (tx) => tx.query<{ position: string }>('SELECT position FROM room_clock'));
  assert.ok(Number(told.rows[0]!.position) > 0);
});

test('a person is made from the session alone, and only the owner and joined seats of the company are its people', async () => {
  const fixture = await createCompany('rooms-people');
  const other = await createCompany('rooms-people-other');
  const siti = await seat(fixture, 'Siti Rahayu');
  const elsewhere = await seat(other, 'Dewi Kusuma');

  assert.deepEqual(OWNER, { principal: 'owner', name: null });
  assert.deepEqual(siti.person, { principal: `seat:${siti.id}`, name: 'Siti Rahayu' });
  assert.throws(() => principalOf(null, null), (error: unknown) => isPalugadaError(error, 'owner.unauthenticated'));
  assert.equal(seatOf(siti.person.principal), siti.id);
  assert.equal(seatOf('owner'), null);
  assert.throws(() => seatOf('role:writer'), (error: unknown) => isPalugadaError(error, 'contract.violation'));
  for (const person of ['owner', `seat:${siti.id}`]) assert.equal(isPerson(person), true, person);
  for (const thing of ['platform', 'agent', `seat:${siti.id.toUpperCase()}`, 'former:slack:U1', '', null, 7]) {
    assert.equal(isPerson(thing), false, String(thing));
  }

  // What it answers is each person as the control plane knows them: the
  // name a room's rows are written with comes from the seat, not from
  // whoever adds them.
  assert.deepEqual(await assertPeopleOf(fixture.companyId, ['owner', siti.person.principal, 'owner']),
    [{ principal: 'owner', name: null }, { principal: siti.person.principal, name: 'Siti Rahayu' }]);
  const pending = await withControlPlane(async (tx) => (await tx.query<{ id: string }>(
    "INSERT INTO staff_seats (company_id, name, kind) VALUES ($1, 'Not Yet', 'viewer') RETURNING id", [fixture.companyId])).rows[0]!.id);
  const revoked = await seat(fixture, 'Gone Away');
  await withControlPlane((tx) => tx.query('UPDATE staff_seats SET revoked_at = now() WHERE id = $1', [revoked.id]));
  for (const stranger of [elsewhere.person.principal, `seat:${pending}`, revoked.person.principal, `seat:${randomUUID()}`, 'role:ceo']) {
    await assert.rejects(assertPeopleOf(fixture.companyId, ['owner', stranger]), (error: unknown) =>
      isPalugadaError(error, 'contract.violation') && (error as Error).message.includes(stranger), stranger);
  }

  // The helpers take no one else: an agent, a role or a name is not a person.
  await assert.rejects(withPeople(fixture.companyId, { principal: 'role:ceo', name: 'CEO' }, async () => undefined),
    (error: unknown) => isPalugadaError(error, 'contract.violation'));
  await assert.rejects(withPeople(fixture.companyId, { principal: siti.person.principal, name: null }, async () => undefined),
    (error: unknown) => isPalugadaError(error, 'contract.violation'), 'a seat with no name');
});

/**
 * A deployment that already has companies gets their rooms from the
 * migration: a clock, the company room and a room per division, each showing
 * the work that needs people, and nobody seated in any of them until they
 * look. Run on a database of its own, migrated to just before the rooms,
 * given companies, and migrated again.
 */
test('migrating a database that has companies gives each its clock and its rooms, and nobody in them', async () => {
  const superuserUrl = process.env.PALUGADA_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const name = `palugada_rooms_backfill_${process.pid}`;
  const inside = (url: string) => {
    const at = new URL(url);
    at.pathname = `/${name}`;
    return at.toString();
  };
  const source = new URL('../../db/migrations/', import.meta.url).pathname;
  const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
  const rooms = files.find((file) => /^\d{4}_rooms_are_for_people\.sql$/.test(file));
  assert.ok(rooms, 'the rooms migration is there');
  const before = await mkdtemp(join(tmpdir(), 'palugada-before-rooms-'));
  const all = await mkdtemp(join(tmpdir(), 'palugada-all-'));
  for (const file of files) {
    await copyFile(join(source, file), join(all, file));
    if (file < rooms) await copyFile(join(source, file), join(before, file));
  }

  const superuser = new pg.Client({ connectionString: superuserUrl });
  await superuser.connect();
  const ownerUrl = process.env.PALUGADA_OWNER_URL;
  try {
    await superuser.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await superuser.query(`CREATE DATABASE ${name} OWNER palugada_owner`);
    const extensions = new pg.Client({ connectionString: inside(superuserUrl) });
    await extensions.connect();
    for (const extension of ['pgcrypto', 'vector', 'pg_trgm']) await extensions.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    await extensions.end();

    process.env.PALUGADA_OWNER_URL = inside(connectionString('owner'));
    await migrate(before);
    const admin = new pg.Client({ connectionString: inside(connectionString('admin')) });
    await admin.connect();
    try {
      const companies: Array<{ id: string; divisions: string[] }> = [];
      for (const [slug, divisions] of [['warung', ['kitchen', 'front']], ['studio', ['design']], ['empty', []]] as const) {
        const { rows } = await admin.query<{ id: string }>('INSERT INTO companies (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
        const made: string[] = [];
        for (const division of divisions) {
          const { rows: d } = await admin.query<{ id: string }>(
            'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $2) RETURNING id', [rows[0]!.id, division]);
          made.push(d[0]!.id);
        }
        companies.push({ id: rows[0]!.id, divisions: made });
      }

      assert.deepEqual(await migrate(all), files.filter((file) => file >= rooms));

      for (const company of companies) {
        const { rows: clock } = await admin.query('SELECT 1 FROM room_clock WHERE company_id = $1', [company.id]);
        assert.equal(clock.length, 1, 'its clock');
        const { rows: made } = await admin.query<{ kind: string; division_id: string | null; shows_work: string; created_by: string }>(
          'SELECT kind, division_id, shows_work, created_by FROM rooms WHERE company_id = $1 ORDER BY kind, division_id', [company.id]);
        assert.deepEqual(made, [
          { kind: 'company', division_id: null, shows_work: 'asked_here', created_by: 'platform' },
          ...company.divisions.sort().map((division) => ({ kind: 'division', division_id: division, shows_work: 'needs_people', created_by: 'platform' })),
        ]);
      }
      const { rows: members } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM room_members');
      assert.equal(members[0]!.n, 0, 'memberships come when a person first looks');
      // And the migration left no tenant scope behind it, nor its lifted row security.
      const { rows: forced } = await admin.query<{ forced: boolean }>(
        "SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'companies'");
      assert.equal(forced[0]!.forced, true);
    } finally {
      await admin.end();
    }
  } finally {
    if (ownerUrl === undefined) delete process.env.PALUGADA_OWNER_URL;
    else process.env.PALUGADA_OWNER_URL = ownerUrl;
    await superuser.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await superuser.end();
    await rm(before, { recursive: true, force: true });
    await rm(all, { recursive: true, force: true });
  }
});
