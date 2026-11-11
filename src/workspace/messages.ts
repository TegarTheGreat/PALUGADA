/**
 * What people say in rooms (F19.1, F19.4, F19.6, F19.7, F19.10; STATUS
 * section 2.206): messages and threads one level deep, mentions of people,
 * reactions, pins, edits and removals.
 *
 * A message is words and nothing else. Whose they are is the session's,
 * never the body's: the database writes the author's name and where the words
 * came from from what `withPeople` set (0150). What reaches a run from here
 * is nothing at all; a message becomes work only through a door
 * (`doors.ts`), by a press.
 */
import { randomUUID } from 'node:crypto';
import { withPeople, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { MessagePage, MessageView, ThreadView } from './contract.ts';
import { attachFiles, filesToAttach, keptPaths, removeRoomFiles, stageFiles, unstage } from './files.ts';
import { retractMessages } from '../relay/people.ts';
import { isPerson } from './principal.ts';
import { assertMember, ensureCompanyMember, takeClock, visibleRoom, type RoomRecord } from './rooms.ts';
import {
  directoryOf, EDIT_WINDOW_MS, MESSAGE_COLUMNS, mayDecide, messageViews, type Directory, type MessageRow, type Viewer,
} from './views.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The longest message, as the table holds it. */
export const BODY_MAX = 8_000;
/** How many messages one person may post in a minute, in this process. */
export const MESSAGES_PER_MINUTE = 30;
/** How many messages a room may have pinned at once. */
export const PINS_PER_ROOM = 50;
/** The most a page of a room holds. */
const PAGE_MAX = 100;

/** A message's id from a path: an id, or nothing anyone can see. */
export function messageIdOf(value: string | undefined): string {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new PalugadaError('contract.violation', 'that is not a message of this room', { messageId: value ?? null });
  return id;
}

/** A message of this room, or the refusal that there is none. */
export async function messageIn(tx: TenantClient, roomId: string, messageId: string, options: { lock?: boolean } = {}): Promise<MessageRow> {
  const { rows } = await tx.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM room_messages m WHERE m.id = $1 AND m.room_id = $2${options.lock ? ' FOR UPDATE' : ''}`,
    [messageId, roomId]);
  if (!rows[0]) throw new PalugadaError('contract.violation', 'that is not a message of this room', { messageId });
  return rows[0];
}

/**
 * The minute's posts of each person in this process: a hand on a key, a
 * script in a tab, or a relay gone wrong is slowed down here before the room
 * fills. Counted in this process: a person spreading over replicas reaches
 * a few times the limit, not a flood, and no row is written to count it.
 */
const recent = new Map<string, number[]>();

function slowDown(viewer: Viewer, options: { counted?: boolean } = {}, now = Date.now()): void {
  const key = `${viewer.companyId}:${viewer.person.principal}`;
  const kept = (recent.get(key) ?? []).filter((at) => now - at < 60_000);
  if (kept.length >= MESSAGES_PER_MINUTE) {
    recent.set(key, kept);
    throw new PalugadaError('room.too_fast', `slow down: at most ${MESSAGES_PER_MINUTE} messages a minute`, { perMinute: MESSAGES_PER_MINUTE });
  }
  // Asked before a post's files are read: not yet a post, so not counted.
  if (options.counted === false) return;
  kept.push(now);
  recent.set(key, kept);
  // Forgotten once quiet, so the map holds only who wrote in the last minute.
  if (recent.size > 10_000) {
    for (const [who, times] of recent) if (now - (times.at(-1) ?? 0) >= 60_000) recent.delete(who);
  }
}

/** Who may be mentioned in a room: everyone of the company in an open room, its members (and the owner) in a private one. */
async function whoCanSee(tx: TenantClient, room: RoomRecord, directory: Directory): Promise<Set<string>> {
  if (room.kind === 'company' || room.kind === 'division' || (room.kind === 'topic' && !room.private)) {
    return new Set(directory.live().map((someone) => someone.principal));
  }
  const { rows } = await tx.query<{ principal: string }>('SELECT principal FROM room_members WHERE room_id = $1 AND left_at IS NULL', [room.id]);
  const members = new Set(rows.map((row) => row.principal));
  if (room.kind === 'topic') members.add('owner');
  return members;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a token ends: before anything that could carry a handle on. A handle
 * may hold a dot (STATUS 2.209), so `@budi.setiawan` does not end `@budi`,
 * while `@budi.` at the end of a sentence does.
 */
const TOKEN_END = '(?![\\w-]|\\.[\\w-])';

/** What is typed to mention a person: `owner`, a seat's handle, or the name of a seat with none. */
function tokenOf(someone: { principal: string; handle: string | null; name: string | null } | undefined): string | null {
  if (!someone) return null;
  return someone.principal === 'owner' ? 'owner' : someone.handle ?? someone.name ?? null;
}

/**
 * Whether the words hold the mention's token: `@owner`, a seat's `@handle`,
 * or `@Name` for a seat with none, as a word of its own, in any case. Where
 * it is written only as the start of someone else's longer token -- `@Sari`
 * inside `@Sari Wulandari` -- it names the longer one's person instead.
 * The console finds mentions the same way (`writtenMentions`, STATUS 2.218).
 */
function written(body: string, principal: string, directory: Directory): boolean {
  const token = tokenOf(principal === 'owner' ? { principal, handle: null, name: null } : directory.get(principal));
  if (!token) return false;
  const longer = directory.live().flatMap((someone) => {
    const other = tokenOf(someone);
    return someone.principal !== principal && other && other.length > token.length && other.toLowerCase().startsWith(token.toLowerCase()) ? [other] : [];
  });
  for (const found of body.matchAll(new RegExp(`(^|[^\\w@])@${escaped(token)}${TOKEN_END}`, 'giu'))) {
    const at = found.index + found[1]!.length;
    if (!longer.some((other) => new RegExp(`^@${escaped(other)}${TOKEN_END}`, 'iu').test(body.slice(at)))) return true;
  }
  return false;
}

/** The people a post or an edit asks to mention: a list of at most fifty principals, or none. */
function mentionsAsked(input: Record<string, unknown>): string[] {
  const asked = input.mentions === undefined || input.mentions === null ? [] : input.mentions;
  if (!Array.isArray(asked) || asked.length > 50 || !asked.every((one) => typeof one === 'string')) {
    throw new PalugadaError('contract.violation', 'mentions is a list of at most 50 people', { field: 'mentions' });
  }
  return asked as string[];
}

/**
 * Which of the people asked for are mentioned by these words in this room:
 * a person of the company, whose name is in the words and who can see the
 * room. The others are said back with why, so a mention that reaches nobody
 * is never silent -- the same for a post and for an edit (STATUS 2.218).
 */
async function keptMentions(
  tx: TenantClient, room: RoomRecord, directory: Directory, body: string, asked: string[],
): Promise<{ kept: string[]; dropped: Posted['mentionsDropped'] }> {
  const seeing = await whoCanSee(tx, room, directory);
  const kept: string[] = [];
  const dropped: Posted['mentionsDropped'] = [];
  for (const principal of new Set(asked)) {
    if (!isPerson(principal) || !directory.get(principal)?.live) dropped.push({ principal, why: 'not_a_person' });
    else if (!written(body, principal, directory)) dropped.push({ principal, why: 'not_written' });
    else if (!seeing.has(principal)) dropped.push({ principal, why: 'not_in_room' });
    else kept.push(principal);
  }
  return { kept, dropped };
}

export interface Posted {
  message: MessageView;
  /** Mentions the server did not keep, and why: not a person, not in the words, or not able to see the room. */
  mentionsDropped: Array<{ principal: string; why: 'not_a_person' | 'not_written' | 'not_in_room' }>;
}

/**
 * A person's words in a room, or a reply in a thread. Mentions are kept only
 * for people who can see the room and whose name is in the words; the
 * others are said back, so a mention that reached nobody is never silent.
 * `@room` is the owner's and an approver's. A retry with the same client id
 * is the message already posted.
 *
 * Up to five files may come with it (STATUS 2.212), from the console, which
 * says where this company's room files are kept (`peopleFolder`): they are
 * looked at before anything is written, and kept in the same transaction as
 * the words, so a message is kept with all its files or not at all. A
 * message of files alone may say nothing.
 */
export async function postMessage(
  viewer: Viewer, roomId: string, input: Record<string, unknown>, options: { peopleFolder?: string | null } = {},
): Promise<Posted> {
  const body = typeof input.body === 'string' ? input.body : '';
  // A person already writing too fast is told so before up to 32 MB of their files is read.
  if (input.files !== undefined && input.files !== null) slowDown(viewer, { counted: false });
  const files = filesToAttach(input.files);
  if ((body.trim().length < 1 && files.length === 0) || body.length > BODY_MAX) {
    throw new PalugadaError('contract.violation', `a message says something, in at most ${BODY_MAX} characters`, { field: 'body' });
  }
  if (files.length > 0 && options.peopleFolder === undefined) {
    throw new PalugadaError('contract.violation', 'files are attached in the console', { field: 'files' });
  }
  const clientId = typeof input.clientId === 'string' ? input.clientId : '';
  if (clientId.length < 1 || clientId.length > 64) {
    throw new PalugadaError('contract.violation', 'a message names its clientId, 1 to 64 characters, so a retry is the same message', { field: 'clientId' });
  }
  const threadOf = input.threadOf === undefined || input.threadOf === null ? null : messageIdOf(String(input.threadOf));
  const alsoInRoom = input.alsoInRoom === true;
  if (alsoInRoom && threadOf === null) {
    throw new PalugadaError('contract.violation', 'only a reply is also sent to the room', { field: 'alsoInRoom' });
  }
  const asked = mentionsAsked(input);
  const everyone = input.mentionsRoom === true;
  if (everyone && !mayDecide(viewer)) {
    throw new PalugadaError('mention.room_not_yours', 'only the owner and approvers can notify the whole room', {});
  }
  const directory = await directoryOf(viewer.companyId);
  const relay = viewer.relayId ? { relayId: viewer.relayId } : undefined;
  // The files' bytes are written before the transaction, which holds the
  // company's room clock from its first write: no room of the company waits
  // on the disk. Inside it they are only linked into the room, and their
  // staged names go once the post is done, whatever became of it.
  const folder = options.peopleFolder ?? null;
  const staged = await stageFiles(folder, files);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.archived_at) throw new PalugadaError('room.archived', 'that room is archived', { roomId });
    await ensureCompanyMember(tx, viewer, room);
    assertMember(room);
    // The clock first, so a retry racing its original reads after it.
    await takeClock(tx);
    const { rows: again } = await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM room_messages m WHERE m.author = $1 AND m.client_id = $2`, [viewer.person.principal, clientId]);
    if (again[0]) return { message: (await messageViews(tx, viewer, directory, again))[0]!, mentionsDropped: [] };
    if (threadOf !== null) {
      const { rows: roots } = await tx.query<{ room_id: string; thread_of: string | null }>(
        'SELECT room_id, thread_of FROM room_messages WHERE id = $1', [threadOf]);
      const root = roots[0];
      if (!root || root.room_id !== room.id) throw new PalugadaError('contract.violation', 'a reply is to a message of the same room', { field: 'threadOf' });
      if (root.thread_of !== null) throw new PalugadaError('contract.violation', 'a thread is one level deep: reply to the message it began with', { field: 'threadOf' });
    }
    slowDown(viewer);
    const { kept, dropped } = await keptMentions(tx, room, directory, body, asked);
    const id = randomUUID();
    // Where the words came from is the session's, as the database checks:
    // the console, or the relay whose inbound code opened this transaction.
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, thread_of, also_in_room, kind, author, body, mentions, mentions_room, via, via_relay, client_id, position)
       VALUES ($1, $2, $3, $4, $5, 'text', $6, $7, $8, $9, $10, $11, $12, 0)`,
      [id, viewer.companyId, room.id, threadOf, alsoInRoom, viewer.person.principal, body, kept, everyone,
        relay ? 'relay' : 'console', relay?.relayId ?? null, clientId]);
    await attachFiles(tx, viewer.companyId, room.id, id, staged, folder);
    const { rows } = await tx.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM room_messages m WHERE m.id = $1`, [id]);
    return { message: (await messageViews(tx, viewer, directory, rows))[0]!, mentionsDropped: dropped };
  }, relay).finally(() => unstage(folder, staged));
}

/** One message as the console draws it, read again after a change. */
async function shown(tx: TenantClient, viewer: Viewer, directory: Directory, messageId: string): Promise<MessageView> {
  const { rows } = await tx.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM room_messages m WHERE m.id = $1`, [messageId]);
  return (await messageViews(tx, viewer, directory, rows))[0]!;
}

/**
 * New words for one's own message, within a day; what they replace is kept
 * for the owner (0150). The people the new words name are mentioned as a
 * post mentions them (STATUS 2.218): only those asked for whose name is in
 * the words and who can see the room, the others said back with why. Someone
 * no longer named is no longer mentioned, and someone newly named is told
 * (0161). `mentions` left out keeps whom the message named, as long as their
 * names are still in the words.
 */
export async function editMessage(viewer: Viewer, roomId: string, messageId: string, input: Record<string, unknown>): Promise<Posted> {
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.trim().length < 1 || body.length > BODY_MAX) {
    throw new PalugadaError('contract.violation', `a message says something, in at most ${BODY_MAX} characters`, { field: 'body' });
  }
  const asked = input.mentions === undefined ? null : mentionsAsked(input);
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    await takeClock(tx);
    const message = await messageIn(tx, roomId, messageId, { lock: true });
    if (message.kind !== 'text' || message.author !== viewer.person.principal) {
      throw new PalugadaError('message.not_yours', 'only its author can change that message', { messageId });
    }
    if (message.deleted_at) throw new PalugadaError('contract.violation', 'that message was removed', { messageId });
    if (Date.now() - message.created_at.getTime() >= EDIT_WINDOW_MS) {
      throw new PalugadaError('message.edit_window', 'a message can be edited for a day after it is sent', { messageId });
    }
    const { kept, dropped } = await keptMentions(tx, room, directory, body, asked ?? message.mentions);
    if (message.body !== body) {
      await tx.query('UPDATE room_messages SET body = $2, mentions = $3 WHERE id = $1', [messageId, body, kept]);
    }
    return { message: await shown(tx, viewer, directory, messageId), mentionsDropped: message.body !== body ? dropped : [] };
  });
}

/**
 * A message taken back by its author, or removed by the owner: a tombstone
 * with none of its words (0150). Its files' rows let their bytes go as it
 * commits, and the bytes are removed after; a process that stops between the
 * two leaves bytes no row names, which the next sweep removes (STATUS 2.212).
 * Its words are then withdrawn from every relay a notice of it went to, and
 * never sent where one had not gone yet (STATUS section 2.213), once the
 * delete has committed. The delete stands whatever that answers: a notice of
 * removed words is never sent in any case, and the notify stage's next pass
 * makes a retraction this one could not (`retractRemoved`).
 */
export async function deleteMessage(
  viewer: Viewer, roomId: string, messageId: string, options: { peopleFolder?: string | null } = {},
): Promise<MessageView> {
  const directory = await directoryOf(viewer.companyId);
  const { view, paths } = await withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    await takeClock(tx);
    const message = await messageIn(tx, roomId, messageId, { lock: true });
    if (message.kind !== 'text' || (message.author !== viewer.person.principal && viewer.kind !== 'owner')) {
      throw new PalugadaError('message.not_yours', 'only its author, or the owner, can remove that message', { messageId });
    }
    const paths = message.deleted_at ? [] : await keptPaths(tx, [messageId]);
    if (!message.deleted_at) await tx.query('UPDATE room_messages SET deleted_at = now() WHERE id = $1', [messageId]);
    return { view: await shown(tx, viewer, directory, messageId), paths };
  });
  await removeRoomFiles(options.peopleFolder ?? null, paths);
  try {
    await retractMessages(viewer.companyId, [messageId]);
  } catch {
    // Not the delete's failure, which has committed: the person is told it
    // is gone, as it is, and the worker retracts it on its next pass.
  }
  return view;
}

/** A reaction given or taken back: a person's, on a person's words, and never a decision (0150 refuses one on a card). */
export async function react(viewer: Viewer, roomId: string, messageId: string, input: Record<string, unknown>): Promise<MessageView['reactions']> {
  const emoji = typeof input.emoji === 'string' ? input.emoji : '';
  if (emoji.length < 1 || emoji.length > 16 || /\s/.test(emoji)) {
    throw new PalugadaError('contract.violation', 'a reaction is one emoji, at most 16 characters', { field: 'emoji' });
  }
  if (typeof input.on !== 'boolean') throw new PalugadaError('contract.violation', 'on is true to react and false to take it back', { field: 'on' });
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const message = await messageIn(tx, roomId, messageId);
    if (input.on) {
      if (message.kind !== 'text' || message.deleted_at) {
        throw new PalugadaError('contract.violation', "a reaction is for a person's message, not a card or a removed one", { messageId });
      }
      await tx.query(
        `INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`, [viewer.companyId, messageId, viewer.person.principal, emoji]);
    } else {
      await tx.query('DELETE FROM room_reactions WHERE message_id = $1 AND principal = $2 AND emoji = $3',
        [messageId, viewer.person.principal, emoji]);
    }
    const { rows } = await tx.query<{ emoji: string; n: number; mine: boolean }>(
      `SELECT emoji, count(*)::int AS n, bool_or(principal = $2) AS mine FROM room_reactions
        WHERE message_id = $1 GROUP BY emoji ORDER BY min(created_at), emoji`, [messageId, viewer.person.principal]);
    return rows.map((row) => ({ emoji: row.emoji, count: row.n, mine: row.mine }));
  });
}

/** A message pinned to its room, or unpinned: at most fifty at once. */
export async function pin(viewer: Viewer, roomId: string, messageId: string, input: Record<string, unknown>): Promise<string[]> {
  if (typeof input.on !== 'boolean') throw new PalugadaError('contract.violation', 'on is true to pin and false to unpin', { field: 'on' });
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    await takeClock(tx);
    const message = await messageIn(tx, roomId, messageId);
    if (input.on) {
      if (message.deleted_at) throw new PalugadaError('contract.violation', 'that message was removed', { messageId });
      const { rows } = await tx.query<{ n: number; pinned: boolean }>(
        'SELECT count(*)::int AS n, bool_or(message_id = $2) AS pinned FROM room_pins WHERE room_id = $1', [roomId, messageId]);
      if (!rows[0]!.pinned) {
        if (rows[0]!.n >= PINS_PER_ROOM) throw new PalugadaError('room.pins_full', `a room holds ${PINS_PER_ROOM} pins: unpin one first`, { roomId });
        await tx.query('INSERT INTO room_pins (company_id, room_id, message_id, pinned_by) VALUES ($1, $2, $3, $4)',
          [viewer.companyId, roomId, messageId, viewer.person.principal]);
      }
    } else {
      await tx.query('DELETE FROM room_pins WHERE room_id = $1 AND message_id = $2', [roomId, messageId]);
    }
    const { rows } = await tx.query<{ message_id: string }>('SELECT message_id FROM room_pins WHERE room_id = $1 ORDER BY pinned_at, message_id', [roomId]);
    return rows.map((row) => row.message_id);
  });
}

/** What an edit replaced, oldest first: the owner's record, which the database shows nobody else (0150). */
export async function historyOf(viewer: Viewer, roomId: string, messageId: string): Promise<Array<{ body: string; replacedAt: string }>> {
  if (viewer.kind !== 'owner') throw new PalugadaError('staff.forbidden', "what an edit replaced is the owner's record", {});
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    await messageIn(tx, roomId, messageId);
    const { rows } = await tx.query<{ body: string; replaced_at: Date }>(
      'SELECT body, replaced_at FROM room_message_revisions WHERE message_id = $1 ORDER BY replaced_at, id', [messageId]);
    return rows.map((row) => ({ body: row.body, replacedAt: row.replaced_at.toISOString() }));
  });
}

/** Following a thread, or not: a follower is told of its replies while they can see the room. */
export async function follow(viewer: Viewer, roomId: string, rootId: string, input: Record<string, unknown>): Promise<boolean> {
  const on = input.on;
  if (typeof on !== 'boolean') throw new PalugadaError('contract.violation', 'on is true to follow and false to stop', { field: 'on' });
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const root = await messageIn(tx, roomId, rootId);
    if (root.thread_of !== null) throw new PalugadaError('contract.violation', 'a thread is followed from the message it began with', { messageId: rootId });
    await tx.query(
      `INSERT INTO room_follows (company_id, root_id, principal, following) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, root_id, principal) DO UPDATE SET following = EXCLUDED.following, updated_at = now()`,
      [viewer.companyId, rootId, viewer.person.principal, on]);
    return on;
  });
}

/** A number from a query string, or undefined. */
function positionOf(value: string | null, field: string): number | undefined {
  if (value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new PalugadaError('contract.violation', `${field} is a position`, { field });
  return number;
}

/**
 * A page of a room: the messages at its top level and the replies also sent
 * to it, oldest first, around a position or before or after one, with the
 * reader's own read mark.
 */
export async function messagePage(viewer: Viewer, roomId: string, query: URLSearchParams): Promise<MessagePage> {
  const before = positionOf(query.get('before'), 'before');
  const after = positionOf(query.get('after'), 'after');
  const around = positionOf(query.get('around'), 'around');
  const limit = Math.min(Math.max(positionOf(query.get('limit'), 'limit') ?? 50, 1), PAGE_MAX);
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    await ensureCompanyMember(tx, viewer, room);
    const shownHere = 'm.room_id = $1 AND (m.thread_of IS NULL OR m.also_in_room)';
    const page = async (where: string, order: 'ASC' | 'DESC', at: number | null, n: number) => (await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM room_messages m WHERE ${shownHere} ${where} ORDER BY m.position ${order} LIMIT ${n}`,
      at === null ? [roomId] : [roomId, at])).rows;
    let rows: MessageRow[];
    if (around !== undefined) {
      // Half before the position and the rest from it, so `limit=1` is the
      // message at the position itself: what a hidden tab's notification
      // reads, as its person, for a frame that named it (STATUS 2.210).
      const half = Math.floor(limit / 2);
      const earlier = half > 0 ? (await page('AND m.position < $2', 'DESC', around, half)).reverse() : [];
      rows = [...earlier, ...await page('AND m.position >= $2', 'ASC', around, limit - half)];
    } else if (after !== undefined) {
      rows = await page('AND m.position > $2', 'ASC', after, limit);
    } else if (before !== undefined) {
      rows = (await page('AND m.position < $2', 'DESC', before, limit)).reverse();
    } else {
      rows = (await page('', 'DESC', null, limit)).reverse();
    }
    const first = rows[0] ? Number(rows[0].position) : null;
    const last = rows.at(-1) ? Number(rows.at(-1)!.position) : null;
    const { rows: edges } = await tx.query<{ before: boolean; after: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM room_messages m WHERE ${shownHere} AND m.position < $2) AS before,
              EXISTS (SELECT 1 FROM room_messages m WHERE ${shownHere} AND m.position > $3) AS after`,
      [roomId, first ?? 0, last ?? Number.MAX_SAFE_INTEGER]);
    // A mark is a member's: someone reading a room they are not in -- an open room found, linked or searched --
    // keeps none, which is said as none rather than as the room's start, so their console opens it at its newest
    // with nothing called new (STATUS 2.218). A place left behind by someone who left the room is not theirs to read.
    const { rows: place } = room.member ? await tx.query<{ read_position: string }>(
      'SELECT read_position FROM room_places WHERE room_id = $1 AND principal = $2', [roomId, viewer.person.principal]) : { rows: [] };
    return {
      messages: await messageViews(tx, viewer, directory, rows),
      readPosition: room.member ? Number(place[0]?.read_position ?? 0) : null,
      hasBefore: first !== null && edges[0]!.before,
      hasAfter: last !== null && edges[0]!.after,
    };
  });
}

/** A thread: its first message, its replies, whether the reader follows it, and the work's last line when it is work. */
export async function threadView(viewer: Viewer, roomId: string, rootId: string): Promise<ThreadView> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const root = await messageIn(tx, roomId, rootId);
    if (root.thread_of !== null) throw new PalugadaError('contract.violation', 'a thread is read from the message it began with', { messageId: rootId });
    const { rows: replies } = await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM room_messages m WHERE m.thread_of = $1 ORDER BY m.position LIMIT 500`, [rootId]);
    const { rows: followed } = await tx.query<{ following: boolean }>(
      'SELECT following FROM room_follows WHERE root_id = $1 AND principal = $2', [rootId, viewer.person.principal]);
    const [rootView, ...replyViews] = await messageViews(tx, viewer, directory, [root, ...replies]);
    return {
      root: rootView!,
      replies: replyViews,
      following: followed[0]?.following ?? false,
      // The run's last line, as its card shows it: what a seat may not read of the work it may not read here either.
      progress: rootView!.card?.kind === 'work' ? rootView!.card.lastLine ?? null : null,
    };
  });
}
