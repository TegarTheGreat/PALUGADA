/**
 * The rooms of a company and who is in them (F19.1, F19.3, F19.10; STATUS
 * section 2.206).
 *
 * Every company has one company room that everyone is in, and one room for
 * each division, made by the platform the first time anyone looks. People
 * make topic rooms, open or private, and direct conversations of two to eight
 * people, whose people are fixed when they are opened. Who sees which room is
 * the database's rule (0150): every query here runs as the person asking,
 * through `withPeople`, so a room this code forgets to filter is still one
 * the person cannot read.
 */
import { randomUUID } from 'node:crypto';
import { withControlPlane, withPeople, withRoomPlatform, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { linkedPeople } from '../relay/people.ts';
import type { Person as PersonView, Room, RoomListItem } from './contract.ts';
import { assertPeopleOf, isPerson } from './principal.ts';
import { directoryOf, mayDecide, type Directory, type Viewer } from './views.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A room and the reader's own membership and place in it. */
export interface RoomRecord {
  id: string;
  kind: 'company' | 'division' | 'topic' | 'direct';
  division_id: string | null;
  name: string | null;
  about: string | null;
  private: boolean;
  direct_key: string | null;
  shows_work: 'asked_here' | 'needs_people' | 'all';
  created_by: string;
  archived_at: Date | null;
  member: boolean;
  role: 'member' | 'admin' | null;
}

/** A room's id from a path: an id, or a room nobody can see. */
export function roomIdOf(value: string | undefined): string {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new PalugadaError('room.not_visible', 'that room is not one you can see', { roomId: value ?? null });
  return id;
}

/**
 * Takes the company's room clock before anything else is read, as every
 * room write does first (0150, `lock_room_clock`): a statement on a room
 * table that changes no row still fires its clock-first trigger. A press
 * that reads, then writes, holds the clock from its first read, so two
 * presses of the same thing read one after the other and never both write.
 */
export async function takeClock(tx: TenantClient): Promise<void> {
  await tx.query('UPDATE room_places SET notify = notify WHERE false');
}

/** A room the person can see, with their membership; refused as not visible otherwise. */
export async function visibleRoom(tx: TenantClient, viewer: Viewer, roomId: string): Promise<RoomRecord> {
  const { rows } = await tx.query<RoomRecord>(
    `SELECT r.id, r.kind, r.division_id, r.name, r.about, r.private, r.direct_key, r.shows_work, r.created_by, r.archived_at,
            m.principal IS NOT NULL AND m.left_at IS NULL AS member, CASE WHEN m.left_at IS NULL THEN m.role END AS role
       FROM rooms r
       LEFT JOIN room_members m ON m.company_id = r.company_id AND m.room_id = r.id AND m.principal = $2
      WHERE r.id = $1`,
    [roomId, viewer.person.principal]);
  const room = rows[0];
  if (!room) throw new PalugadaError('room.not_visible', 'that room is not one you can see', { roomId });
  return room;
}

/**
 * Everyone is in the company room. A person is put in it the first time
 * they look, and nobody leaves it; their place starts at the clock, so a
 * newcomer has no backlog.
 */
export async function ensureCompanyMember(tx: TenantClient, viewer: Viewer, room: RoomRecord): Promise<void> {
  if (room.kind !== 'company' || room.member) return;
  await tx.query(
    `INSERT INTO room_members (company_id, room_id, principal, name, added_by)
     VALUES ($1, $2, $3, $4, $3) ON CONFLICT DO NOTHING`,
    [viewer.companyId, room.id, viewer.person.principal, viewer.person.name]);
  room.member = true;
  room.role = 'member';
}

/** The person must be in the room, to post in it or keep a place in it. */
export function assertMember(room: RoomRecord): void {
  if (!room.member) throw new PalugadaError('room.not_member', 'join the room first', { roomId: room.id });
}

/** A company that is there: a made-up id makes no rooms. */
export async function assertCompany(companyId: string): Promise<void> {
  if (!UUID.test(companyId)) throw new PalugadaError('contract.violation', 'that is not a company id', {});
  const found = await withControlPlane((tx) => tx.query('SELECT 1 FROM companies WHERE id = $1', [companyId]));
  if (found.rowCount !== 1) throw new PalugadaError('contract.violation', 'no such company', {});
}

/**
 * The rooms every company has: its company room, and one for each of its
 * divisions, which shows what needs a person (0150). Made by the platform the
 * first time anyone looks, and again for a division made since. Nothing is
 * written when nothing is missing, so the look every request makes takes no
 * lock on the company's rooms.
 */
export async function ensureCompanyRooms(companyId: string): Promise<void> {
  await withRoomPlatform(companyId, async (tx) => {
    const { rows } = await tx.query<{ company: boolean; divisions: number }>(
      `SELECT EXISTS (SELECT 1 FROM rooms WHERE company_id = $1 AND kind = 'company') AS company,
              (SELECT count(*)::int FROM divisions d
                WHERE d.company_id = $1
                  AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = $1 AND r.kind = 'division' AND r.division_id = d.id)) AS divisions`,
      [companyId]);
    if (rows[0]!.company && rows[0]!.divisions === 0) return;
    await tx.query(
      `INSERT INTO rooms (id, company_id, kind, created_by, shows_work) VALUES ($2, $1, 'company', 'platform', 'asked_here')
       ON CONFLICT (company_id) WHERE kind = 'company' DO NOTHING`,
      [companyId, randomUUID()]);
    await tx.query(
      `INSERT INTO rooms (company_id, kind, division_id, created_by, shows_work)
       SELECT $1, 'division', d.id, 'platform', 'needs_people' FROM divisions d
        WHERE d.company_id = $1
        ORDER BY d.created_at, d.id
       ON CONFLICT (company_id, division_id) WHERE kind = 'division' DO NOTHING`,
      [companyId]);
  });
}

/** The columns a room in the rail is drawn from, over `rooms r` with the reader's member and place rows. */
const LISTED = `r.id, r.kind, r.division_id, r.private, r.direct_key, r.archived_at IS NOT NULL AS archived,
  CASE r.kind WHEN 'company' THEN (SELECT c.name FROM companies c WHERE c.id = r.company_id)
              WHEN 'division' THEN (SELECT d.name FROM divisions d WHERE d.id = r.division_id)
              ELSE r.name END AS name,
  m.principal IS NOT NULL AND m.left_at IS NULL AS joined,
  coalesce(p.notify, 'mentions') AS notify, p.muted_until,
  coalesce((SELECT max(x.position) FROM room_messages x WHERE x.company_id = r.company_id AND x.room_id = r.id), 0) AS last_position,
  CASE WHEN m.principal IS NULL OR m.left_at IS NOT NULL OR p.principal IS NULL
            OR (p.muted_until IS NOT NULL AND p.muted_until > now()) THEN 0
       ELSE (SELECT count(*)::int FROM room_messages x
              WHERE x.company_id = r.company_id AND x.room_id = r.id AND x.kind = 'text' AND x.position > p.read_position
                AND x.author <> $1 AND x.deleted_at IS NULL AND (x.thread_of IS NULL OR x.also_in_room)) END AS unread,
  (SELECT count(*)::int FROM room_mentions n JOIN room_messages x ON x.company_id = n.company_id AND x.id = n.message_id
    WHERE n.principal = $1 AND n.seen_at IS NULL AND x.room_id = r.id) AS mentions`;

const JOINED = `LEFT JOIN room_members m ON m.company_id = r.company_id AND m.room_id = r.id AND m.principal = $1
  LEFT JOIN room_places p ON p.company_id = r.company_id AND p.room_id = r.id AND p.principal = $1`;

interface ListedRow {
  id: string; kind: RoomListItem['kind']; division_id: string | null; private: boolean; direct_key: string | null;
  archived: boolean; name: string | null; joined: boolean; notify: RoomListItem['notify']; muted_until: Date | null;
  last_position: string; unread: number; mentions: number;
}

function listItem(row: ListedRow, directory: Directory): RoomListItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.kind === 'direct' ? null : row.name,
    divisionId: row.division_id,
    private: row.private,
    people: row.kind === 'direct' && row.direct_key ? row.direct_key.split(',').map((principal) => directory.refOf(principal)) : null,
    unread: Math.min(row.unread, 99),
    mentions: row.mentions,
    notify: row.notify,
    mutedUntil: row.muted_until ? row.muted_until.toISOString() : null,
    lastPosition: Number(row.last_position),
    joined: row.joined,
    archived: row.archived,
  };
}

/**
 * The rooms in a person's rail: those they are in, the company room first.
 * `browse` adds the rooms they can see and have not joined.
 */
export async function listRooms(viewer: Viewer, options: { browse?: boolean } = {}): Promise<RoomListItem[]> {
  await assertCompany(viewer.companyId);
  await ensureCompanyRooms(viewer.companyId);
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const { rows: company } = await tx.query<{ id: string }>("SELECT id FROM rooms WHERE kind = 'company'");
    if (company[0]) await ensureCompanyMember(tx, viewer, await visibleRoom(tx, viewer, company[0].id));
    const { rows } = await tx.query<ListedRow>(
      `SELECT ${LISTED} FROM rooms r ${JOINED}
        WHERE $2 OR (m.principal IS NOT NULL AND m.left_at IS NULL)
        ORDER BY CASE r.kind WHEN 'company' THEN 0 WHEN 'division' THEN 1 WHEN 'topic' THEN 2 ELSE 3 END,
                 lower(coalesce(r.name, '')), r.created_at, r.id`,
      [viewer.person.principal, options.browse === true]);
    return rows.map((row) => listItem(row, directory));
  });
}

/** One room, opened: its members (and no one's read mark or mute), pins, who may change what, and who can read it. */
export async function roomOf(viewer: Viewer, roomId: string): Promise<Room> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, (tx) => roomWithin(tx, viewer, directory, roomId));
}

async function roomWithin(tx: TenantClient, viewer: Viewer, directory: Directory, roomId: string): Promise<Room> {
  const room = await visibleRoom(tx, viewer, roomId);
  await ensureCompanyMember(tx, viewer, room);
  const { rows } = await tx.query<ListedRow>(`SELECT ${LISTED} FROM rooms r ${JOINED} WHERE r.id = $2`, [viewer.person.principal, roomId]);
  const { rows: members } = await tx.query<{ principal: string; name: string | null; role: 'member' | 'admin'; joined_at: Date }>(
    `SELECT principal, name, role, joined_at FROM room_members
      WHERE room_id = $1 AND left_at IS NULL ORDER BY principal <> 'owner', joined_at, principal`, [roomId]);
  const { rows: pins } = await tx.query<{ message_id: string }>(
    'SELECT message_id FROM room_pins WHERE room_id = $1 ORDER BY pinned_at, message_id', [roomId]);
  const isOwner = viewer.kind === 'owner';
  const runs = isOwner || room.created_by === viewer.person.principal || room.role === 'admin';
  return {
    ...listItem(rows[0]!, directory),
    about: room.about,
    showsWork: room.shows_work,
    createdBy: room.created_by,
    members: members.map((member) => ({
      ...directory.refOf(member.principal, directory.get(member.principal) ? undefined : member.name),
      role: member.role,
      joinedAt: member.joined_at.toISOString(),
    })),
    pins: pins.map((pin) => pin.message_id),
    disclosure: room.kind === 'direct' ? 'direct' : room.private ? 'private' : 'open',
    may: {
      rename: room.kind === 'topic' && room.archived_at === null && runs,
      archive: room.kind === 'topic' && room.archived_at === null && (isOwner || room.created_by === viewer.person.principal),
      addPeople: (room.kind === 'topic' && room.private && room.archived_at === null && (room.member || isOwner)) || room.kind === 'direct',
      showsWork: room.kind !== 'direct' && mayDecide(viewer),
      mentionRoom: mayDecide(viewer),
    },
  };
}

/** Text from a body: trimmed, within bounds, or refused naming the field. */
function textOf(value: unknown, field: string, max: number, options: { optional?: boolean } = {}): string | null {
  if ((value === undefined || value === null) && options.optional) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 && options.optional && typeof value === 'string') return null;
  if (text.length < 1 || text.length > max) {
    throw new PalugadaError('contract.violation', `${field} is 1 to ${max} characters`, { field });
  }
  return text;
}

/** A list of the company's people from a body: principals, each a person, at most `max`. */
function principalsOf(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((one) => typeof one === 'string')) {
    throw new PalugadaError('contract.violation', `${field} is a list of at most ${max} people`, { field });
  }
  const strangers = value.filter((one) => !isPerson(one));
  if (strangers.length > 0) {
    throw new PalugadaError('contract.violation',
      `${field} names people, the owner or a seat ('owner' or 'seat:<id>'), never ${strangers.join(', ')}`, { field });
  }
  return [...new Set(value as string[])];
}

/** People added to a room by someone else: each one of the company's, with the name the owner gave them. */
async function addPeople(tx: TenantClient, viewer: Viewer, roomId: string, principals: readonly string[]): Promise<void> {
  const others = principals.filter((principal) => principal !== viewer.person.principal);
  if (others.length === 0) return;
  // The database can check a name only against the session's own, so the
  // names written for colleagues are the ones the control plane holds.
  for (const person of await assertPeopleOf(viewer.companyId, others)) {
    const { rows } = await tx.query<{ left: boolean }>(
      'SELECT left_at IS NOT NULL AS left FROM room_members WHERE room_id = $1 AND principal = $2', [roomId, person.principal]);
    if (rows[0]?.left) {
      await tx.query('UPDATE room_members SET left_at = NULL, left_by = NULL WHERE room_id = $1 AND principal = $2', [roomId, person.principal]);
    } else if (!rows[0]) {
      await tx.query(
        'INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, $4, $5)',
        [viewer.companyId, roomId, person.principal, person.name, viewer.person.principal]);
    }
  }
}

/** A name an open topic room the person can see already has: said, so they can join it instead. */
async function assertNameFree(tx: TenantClient, name: string, roomId: string | null): Promise<void> {
  const { rows } = await tx.query(
    "SELECT 1 FROM rooms WHERE kind = 'topic' AND archived_at IS NULL AND lower(name) = lower($1) AND id IS DISTINCT FROM $2::uuid",
    [name, roomId]);
  if (rows.length > 0) {
    throw new PalugadaError('contract.violation', `a room called ${name} is already open here: join it, or choose another name`, { field: 'name' });
  }
}

/**
 * A statement that names a topic room. A live topic room's name is one in the
 * whole company (0150), private rooms' included, so a name the person was
 * not refused by `assertNameFree` can still be taken by a private room they
 * cannot see. They are told only that the name cannot be used: which room
 * holds it is not theirs to learn.
 */
async function named(tx: TenantClient, name: string, statement: () => Promise<unknown>): Promise<void> {
  await tx.query('SAVEPOINT topic_named');
  try {
    await statement();
    await tx.query('RELEASE SAVEPOINT topic_named');
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
    await tx.query('ROLLBACK TO SAVEPOINT topic_named');
    throw new PalugadaError('contract.violation', `the name ${name} cannot be used for a room: choose another name`, { field: 'name' });
  }
}

/**
 * A topic room, open or private, made by anyone. Its maker is its first
 * admin; a private room is seen by its members and the owner. The room's id
 * is made here and the row inserted without asking for it back, since the
 * database checks a returned row before its maker can see a private room
 * (0150).
 */
export async function makeTopicRoom(viewer: Viewer, body: Record<string, unknown>): Promise<Room> {
  const name = textOf(body.name, 'name', 80)!;
  const about = textOf(body.about, 'about', 500, { optional: true });
  if (body.private !== undefined && typeof body.private !== 'boolean') {
    throw new PalugadaError('contract.violation', 'private is true or false', { field: 'private' });
  }
  const members = principalsOf(body.members, 'members', 50);
  const directory = await directoryOf(viewer.companyId);
  const id = randomUUID();
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await takeClock(tx);
    await assertNameFree(tx, name, null);
    await named(tx, name, () => tx.query(
      "INSERT INTO rooms (id, company_id, kind, name, about, private, created_by) VALUES ($1, $2, 'topic', $3, $4, $5, $6)",
      [id, viewer.companyId, name, about, body.private === true, viewer.person.principal]));
    await tx.query(
      "INSERT INTO room_members (company_id, room_id, principal, name, role, added_by) VALUES ($1, $2, $3, $4, 'admin', $3)",
      [viewer.companyId, id, viewer.person.principal, viewer.person.name]);
    await addPeople(tx, viewer, id, members);
    return roomWithin(tx, viewer, directory, id);
  });
}

/** Two to eight people, the person opening it among them. */
const DIRECT_MIN = 2;
const DIRECT_MAX = 8;

/**
 * The direct conversation of exactly these people and the caller: the one
 * they already have, or a new one with no history. Its people are fixed
 * (0150): adding someone opens the conversation of the new set instead, so
 * nobody reads what was said before they were in it.
 */
export async function openDirectRoom(viewer: Viewer, body: Record<string, unknown>): Promise<{ room: Room; opened: boolean }> {
  const others = principalsOf(body.principals, 'principals', 16);
  const people = [...new Set([viewer.person.principal, ...others])].sort();
  if (people.length < DIRECT_MIN || people.length > DIRECT_MAX) {
    throw new PalugadaError('room.too_many_people', `a direct message is for ${DIRECT_MIN} to ${DIRECT_MAX} people, you included; this names ${people.length}`,
      { people: people.length });
  }
  const named = await assertPeopleOf(viewer.companyId, people.filter((principal) => principal !== viewer.person.principal));
  const key = people.join(',');
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    // The clock first: two people opening the same conversation at once read
    // one after the other, and the second finds the first's.
    await takeClock(tx);
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM rooms WHERE kind = 'direct' AND direct_key = $1", [key]);
    if (rows[0]) return { room: await roomWithin(tx, viewer, directory, rows[0].id), opened: false };
    const id = randomUUID();
    await tx.query(
      "INSERT INTO rooms (id, company_id, kind, private, direct_key, created_by) VALUES ($1, $2, 'direct', true, $3, $4)",
      [id, viewer.companyId, key, viewer.person.principal]);
    await tx.query(
      'INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, $4, $3)',
      [viewer.companyId, id, viewer.person.principal, viewer.person.name]);
    for (const person of named) {
      await tx.query(
        'INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, $4, $5)',
        [viewer.companyId, id, person.principal, person.name, viewer.person.principal]);
    }
    return { room: await roomWithin(tx, viewer, directory, id), opened: true };
  });
}

const SHOWS_WORK = ['asked_here', 'needs_people', 'all'] as const;

/**
 * A room's name, what it is about, and what work it shows. A topic room's
 * name and about are its creator's, its admins' and the owner's to change;
 * which work a room shows is the owner's and an approver's, since it decides
 * what the company's work puts in front of everyone there.
 */
export async function changeRoom(viewer: Viewer, roomId: string, body: Record<string, unknown>): Promise<Room> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.archived_at) throw new PalugadaError('room.archived', 'that room is archived', { roomId });
    const runs = viewer.kind === 'owner' || room.created_by === viewer.person.principal || room.role === 'admin';
    if (body.name !== undefined || body.about !== undefined) {
      if (room.kind === 'direct') throw new PalugadaError('room.direct_fixed', 'a direct conversation has no name to change', { roomId });
      if (!runs) throw new PalugadaError('room.not_creator', "only the room's creator, an admin or the owner can change that", { roomId });
      if (body.name !== undefined) {
        if (room.kind !== 'topic') throw new PalugadaError('contract.violation', "the company's and a division's rooms are named after them", { field: 'name' });
        const name = textOf(body.name, 'name', 80)!;
        await assertNameFree(tx, name, roomId);
        await named(tx, name, () => tx.query('UPDATE rooms SET name = $2 WHERE id = $1', [roomId, name]));
      }
      if (body.about !== undefined) {
        await tx.query('UPDATE rooms SET about = $2 WHERE id = $1', [roomId, textOf(body.about, 'about', 500, { optional: true })]);
      }
    }
    if (body.showsWork !== undefined) {
      if (!(SHOWS_WORK as readonly unknown[]).includes(body.showsWork)) {
        throw new PalugadaError('contract.violation', `showsWork is one of ${SHOWS_WORK.join(', ')}`, { field: 'showsWork' });
      }
      if (room.kind === 'direct') throw new PalugadaError('room.direct_fixed', 'a direct conversation shows no work but what is asked in it', { roomId });
      if (!mayDecide(viewer)) throw new PalugadaError('room.not_creator', 'which work a room shows is the owner\'s and an approver\'s to change', { roomId });
      await tx.query('UPDATE rooms SET shows_work = $2 WHERE id = $1', [roomId, body.showsWork]);
    }
    return roomWithin(tx, viewer, directory, roomId);
  });
}

/** A topic room closed for good: by its creator or the owner, who is recorded as who archived it (0150). */
export async function archiveRoom(viewer: Viewer, roomId: string): Promise<Room> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.kind !== 'topic') throw new PalugadaError('contract.violation', 'only a topic room is archived; the others are every company\'s', { roomId });
    if (viewer.kind !== 'owner' && room.created_by !== viewer.person.principal) {
      throw new PalugadaError('room.not_creator', "only the room's creator or the owner archives it", { roomId });
    }
    if (!room.archived_at) await tx.query('UPDATE rooms SET archived_at = now() WHERE id = $1', [roomId]);
    return roomWithin(tx, viewer, directory, roomId);
  });
}

/** Joining a room anyone may: the company's, a division's, an open topic room; the owner joins a private one too. */
export async function joinRoom(viewer: Viewer, roomId: string): Promise<Room> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.kind === 'direct') throw new PalugadaError('room.direct_fixed', 'the people of a direct conversation are fixed when it is opened', { roomId });
    if (room.archived_at) throw new PalugadaError('room.archived', 'that room is archived', { roomId });
    if (!room.member) {
      const { rows } = await tx.query('SELECT 1 FROM room_members WHERE room_id = $1 AND principal = $2', [roomId, viewer.person.principal]);
      if (rows.length > 0) {
        await tx.query('UPDATE room_members SET left_at = NULL, left_by = NULL WHERE room_id = $1 AND principal = $2', [roomId, viewer.person.principal]);
      } else {
        await tx.query(
          'INSERT INTO room_members (company_id, room_id, principal, name, added_by) VALUES ($1, $2, $3, $4, $3)',
          [viewer.companyId, roomId, viewer.person.principal, viewer.person.name]);
      }
    }
    return roomWithin(tx, viewer, directory, roomId);
  });
}

/** Leaving a room: what it owed the person goes with them (0150). Nobody leaves the company room or a direct one. */
export async function leaveRoom(viewer: Viewer, roomId: string): Promise<void> {
  await withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.kind === 'company') throw new PalugadaError('room.company_room_stays', 'everyone stays in the company room', { roomId });
    if (room.kind === 'direct') throw new PalugadaError('room.direct_fixed', 'the people of a direct conversation are fixed when it is opened', { roomId });
    if (room.member) await tx.query('UPDATE room_members SET left_at = now() WHERE room_id = $1 AND principal = $2', [roomId, viewer.person.principal]);
  });
}

/**
 * Who is in a private topic room: any member adds someone, and its creator,
 * an admin or the owner removes them, recorded as who did (0150). An open
 * room is joined, not added to; a direct one's people are fixed.
 */
export async function changeMembers(viewer: Viewer, roomId: string, body: Record<string, unknown>): Promise<Room> {
  const add = principalsOf(body.add, 'add', 50);
  const remove = principalsOf(body.remove, 'remove', 50);
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.kind === 'direct') {
      throw new PalugadaError('room.direct_fixed',
        'the people of a direct conversation are fixed: start a new one with everyone you want in it', { roomId });
    }
    if (room.kind !== 'topic' || !room.private) {
      throw new PalugadaError('contract.violation', 'people join an open room themselves; only a private room has people added', { roomId });
    }
    if (room.archived_at) throw new PalugadaError('room.archived', 'that room is archived', { roomId });
    if (add.length > 0) {
      if (!room.member && viewer.kind !== 'owner') throw new PalugadaError('room.not_member', 'join the room first', { roomId });
      await addPeople(tx, viewer, roomId, add);
    }
    if (remove.length > 0) {
      const runs = viewer.kind === 'owner' || room.created_by === viewer.person.principal || room.role === 'admin';
      if (!runs && remove.some((principal) => principal !== viewer.person.principal)) {
        throw new PalugadaError('room.not_creator', "only the room's creator, an admin or the owner removes someone", { roomId });
      }
      await tx.query('UPDATE room_members SET left_at = now() WHERE room_id = $1 AND principal = ANY($2::text[]) AND left_at IS NULL', [roomId, remove]);
    }
    return roomWithin(tx, viewer, directory, roomId);
  });
}

const NOTIFY = ['all', 'mentions', 'none'] as const;

/** A person's own place in a room: how loudly it tells them things, and until when it is quiet. */
export async function placeSettings(viewer: Viewer, roomId: string, body: Record<string, unknown>): Promise<{ notify: string; mutedUntil: string | null }> {
  if (body.notify !== undefined && !(NOTIFY as readonly unknown[]).includes(body.notify)) {
    throw new PalugadaError('contract.violation', `notify is one of ${NOTIFY.join(', ')}`, { field: 'notify' });
  }
  let mutedUntil: Date | null | undefined;
  if (body.mutedUntil !== undefined) {
    mutedUntil = body.mutedUntil === null ? null : new Date(String(body.mutedUntil));
    if (mutedUntil !== null && (typeof body.mutedUntil !== 'string' || Number.isNaN(mutedUntil.getTime()))) {
      throw new PalugadaError('contract.violation', 'mutedUntil is a time, or null to hear the room again', { field: 'mutedUntil' });
    }
  }
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    await ensureCompanyMember(tx, viewer, room);
    assertMember(room);
    const { rows } = await tx.query<{ notify: string; muted_until: Date | null }>(
      `UPDATE room_places SET notify = coalesce($2, notify),
              muted_until = CASE WHEN $3 THEN $4::timestamptz ELSE muted_until END
        WHERE room_id = $1 AND principal = $5
        RETURNING notify, muted_until`,
      [roomId, body.notify ?? null, mutedUntil !== undefined, mutedUntil ?? null, viewer.person.principal]);
    const place = rows[0];
    if (!place) throw new PalugadaError('room.not_member', 'join the room first', { roomId });
    return { notify: place.notify, mutedUntil: place.muted_until ? place.muted_until.toISOString() : null };
  });
}

/** The company's people, as the people list and the mention picker show them; their kind is the owner's to see. */
export async function peopleOf(viewer: Viewer): Promise<PersonView[]> {
  await assertCompany(viewer.companyId);
  const directory = await directoryOf(viewer.companyId);
  // Who is told outside PALUGADA: a phone linked through a relay that hears
  // about the company (STATUS section 2.213). The mention picker marks the rest.
  const told = await linkedPeople(viewer.companyId);
  return directory.live().map((someone) => ({
    ...directory.refOf(someone.principal),
    ...(viewer.kind === 'owner' && someone.kind !== 'owner' ? { kind: someone.kind } : {}),
    linked: told.has(someone.principal),
  }));
}
