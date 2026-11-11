/**
 * What waits for a person, and what they have read (F19.10; STATUS section
 * 2.206).
 *
 * A read mark is the person's own (0150): it only moves forward, never past
 * the company's clock, and nobody else reads it. What waits is counted from
 * it -- what others wrote at the top of a room after the mark, never a card
 * and never the reader's own words -- and what is addressed to the person is
 * counted apart: a mention, a reply in a thread they follow, a card about
 * work they asked for. Activity lists those, the questions put to them, the
 * team's cards they may decide, and the work they asked for that ended.
 */
import { withControlPlane, withPeople, withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { ownerInbox, TEAM_SQL } from '../inbox/inbox.ts';
import type { ActivityItem, Unread } from './contract.ts';
import { messageIdOf } from './messages.ts';
import { ensureCompanyMember, visibleRoom } from './rooms.ts';
import type { Viewer } from './views.ts';

/**
 * A person's read mark in a room, raised to `position`. Never back, and
 * never past the clock: the database refuses a mark beyond the last change,
 * which is said here as a refusal rather than an error. The person's mentions
 * up to the mark are seen. Read in a thread, only the thread's are: the
 * room's own mark stays where the room was read to.
 *
 * A mark is a member's, but what is addressed to a person is theirs in any
 * room they can see: someone mentioned in an open room they have not joined,
 * or owed a card there, reads it and has it seen without joining the room,
 * which keeps no mark for them (0).
 */
export async function markRead(viewer: Viewer, roomId: string, input: Record<string, unknown>): Promise<{ readPosition: number }> {
  const position = input.position;
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
    throw new PalugadaError('contract.violation', 'position is the position read up to, a whole number', { field: 'position' });
  }
  const threadOf = input.threadOf === undefined || input.threadOf === null ? null : messageIdOf(String(input.threadOf));
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    await ensureCompanyMember(tx, viewer, room);
    if (room.member && threadOf === null) {
      await tx.query('SAVEPOINT read_mark');
      try {
        await tx.query(
          'UPDATE room_places SET read_position = GREATEST(read_position, $3) WHERE room_id = $1 AND principal = $2',
          [roomId, viewer.person.principal, position]);
        await tx.query('RELEASE SAVEPOINT read_mark');
      } catch (error) {
        if ((error as { code?: string }).code !== '23514') throw error;
        await tx.query('ROLLBACK TO SAVEPOINT read_mark');
        throw new PalugadaError('contract.violation', 'that position has not happened yet: mark read up to what you were shown', { field: 'position' });
      }
    }
    await tx.query(
      `UPDATE room_mentions n SET seen_at = now()
         FROM room_messages m
        WHERE m.company_id = n.company_id AND m.id = n.message_id AND m.room_id = $1 AND m.position <= $3
          AND n.principal = $2 AND n.seen_at IS NULL
          AND ($4::uuid IS NULL OR m.thread_of = $4::uuid OR m.id = $4::uuid)`,
      [roomId, viewer.person.principal, position, threadOf]);
    const { rows } = await tx.query<{ read_position: string }>(
      'SELECT read_position FROM room_places WHERE room_id = $1 AND principal = $2', [roomId, viewer.person.principal]);
    return { readPosition: Number(rows[0]?.read_position ?? 0) };
  });
}

/**
 * What waits in each company the person may see: the owner's are all of
 * them, a seat's its own. The badge is mentions and direct messages, which
 * are addressed to the person; rooms with unread are drawn bold, not
 * counted. Beside them, for the owner, the open items of their inbox as its
 * badge counts them: the team's cards still with an approver left out, and
 * those that reached the owner one entry a day (STATUS 2.204).
 */
export async function unreadAcross(viewer: Omit<Viewer, 'companyId'> & { companyId: string | null }): Promise<Unread[]> {
  const companies = viewer.kind === 'owner'
    ? (await withControlPlane((tx) => tx.query<{ id: string }>('SELECT id FROM companies ORDER BY created_at, id'))).rows.map((row) => row.id)
    : [viewer.companyId!];
  const found: Unread[] = [];
  for (const companyId of companies) {
    const counted = await withPeople(companyId, viewer.person, async (tx) => (await tx.query<{ mentions: number; direct: number; rooms: number }>(
      `WITH mine AS (
         SELECT r.id, r.kind, p.read_position
           FROM rooms r
           JOIN room_members m ON m.company_id = r.company_id AND m.room_id = r.id AND m.principal = $1 AND m.left_at IS NULL
           JOIN room_places p ON p.company_id = r.company_id AND p.room_id = r.id AND p.principal = $1
          WHERE p.muted_until IS NULL OR p.muted_until <= now()
       ), waiting AS (
         SELECT mine.id, mine.kind,
                (SELECT count(*) FROM room_messages x
                  WHERE x.company_id = $2 AND x.room_id = mine.id AND x.kind = 'text' AND x.position > mine.read_position
                    AND x.author <> $1 AND x.deleted_at IS NULL AND (x.thread_of IS NULL OR x.also_in_room)) AS n
           FROM mine
       )
       SELECT (SELECT count(*)::int FROM room_mentions WHERE principal = $1 AND seen_at IS NULL) AS mentions,
              (SELECT coalesce(sum(n), 0)::int FROM waiting WHERE kind = 'direct') AS direct,
              (SELECT count(*)::int FROM waiting WHERE kind <> 'direct' AND n > 0) AS rooms`,
      [viewer.person.principal, companyId])).rows[0]!);
    let openCount: number | null = null;
    if (viewer.kind === 'owner') {
      const inbox = await ownerInbox(companyId);
      openCount = inbox.items.length + inbox.team.filter((entry) => entry.day !== null).length;
    }
    found.push({ companyId, mentions: counted.mentions, direct: counted.direct, rooms: counted.rooms, openCount });
  }
  return found;
}

/** A page of Activity. */
const ACTIVITY_PAGE = 50;
/** How long a person is told that work they asked for ended. */
const WORK_DONE_DAYS = 7;

/**
 * What asks for a person's attention, newest first: mentions, replies and
 * cards in rooms they can see now (the database shows no other, and leaving
 * a room took its unseen ones, 0150); questions put to them; for an
 * approver, the team's cards they may decide, named by the item alone so an
 * approver who cannot see the room the work was asked in learns nothing of
 * it; and the work they pressed for that ended in the last week. A reply,
 * a mention in a thread and a card name the thread they are in, since that
 * is where they are read and so seen; so does a people's meeting about to
 * start, whose reminder is in its thread.
 */
export async function activityOf(viewer: Viewer): Promise<ActivityItem[]> {
  const me = viewer.person.principal;
  // A people's meeting's reminder (STATUS 2.215) is said as the meeting it is
  // to the people asked: the card's attention the sweep gave them, or a reply
  // in a thread they follow when they follow it, as its setter always does.
  // Someone who follows its thread, its notes, and was not asked has it as
  // every reply there: a reply in a thread they follow.
  const inRooms = await withPeople(viewer.companyId, viewer.person, async (tx) => (await tx.query<{
    reason: 'mention' | 'reply' | 'card' | 'meeting'; room_id: string; message_id: string; thread_of: string | null; created_at: Date; seen: boolean;
  }>(
    `SELECT CASE WHEN m.kind = 'notice' AND m.notice_code = 'meeting_soon'
                  AND (n.reason = 'card' OR EXISTS (SELECT 1 FROM room_meetings g
                        WHERE g.company_id = m.company_id AND g.message_id = m.thread_of AND $1 = ANY (g.attendees)))
                 THEN 'meeting' ELSE n.reason END AS reason,
            m.room_id, n.message_id, m.thread_of, n.created_at, n.seen_at IS NOT NULL AS seen
       FROM room_mentions n JOIN room_messages m ON m.company_id = n.company_id AND m.id = n.message_id
      WHERE n.principal = $1
      ORDER BY n.created_at DESC LIMIT ${ACTIVITY_PAGE}`, [me])).rows);
  const work = await withTenant(viewer.companyId, async (tx) => {
    const { rows: questions } = await tx.query<{ id: string; task_id: string | null; created_at: Date }>(
      `SELECT i.id, i.task_id, i.created_at FROM inbox_items i
        WHERE i.status = 'open' AND i.kind = 'escalation' AND i.payload->>'askedBy' = 'agent'
          AND ${viewer.seatId === null ? '(i.addressee_seat IS NULL OR i.escalated_at IS NOT NULL)' : 'i.addressee_seat = $1::uuid'}
        ORDER BY i.created_at DESC LIMIT ${ACTIVITY_PAGE}`,
      viewer.seatId === null ? [] : [viewer.seatId]);
    const { rows: team } = viewer.kind !== 'approver' ? { rows: [] } : await tx.query<{ id: string; task_id: string | null; created_at: Date }>(
      `SELECT i.id, i.task_id, i.created_at FROM inbox_items i
        WHERE i.status = 'open' AND i.kind = 'approval' AND ${TEAM_SQL} AND NOT ($1::uuid = ANY (i.instigators))
        ORDER BY i.created_at DESC LIMIT ${ACTIVITY_PAGE}`, [viewer.seatId]);
    const { rows: done } = await tx.query<{ id: string; status: string; finished_at: Date }>(
      viewer.seatId !== null
        ? `SELECT id, status, finished_at FROM tasks
            WHERE requested_by_seat = $1::uuid AND status IN ('completed', 'failed', 'halted', 'cancelled')
              AND finished_at > now() - make_interval(days => ${WORK_DONE_DAYS})
            ORDER BY finished_at DESC LIMIT ${ACTIVITY_PAGE}`
        : `SELECT t.id, t.status, t.finished_at FROM tasks t
            WHERE t.status IN ('completed', 'failed', 'halted', 'cancelled')
              AND t.finished_at > now() - make_interval(days => ${WORK_DONE_DAYS})
              AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task.given_in_room' AND e.payload->>'by' = 'owner')
            ORDER BY t.finished_at DESC LIMIT ${ACTIVITY_PAGE}`,
      viewer.seatId !== null ? [viewer.seatId] : []);
    return { questions, team, done };
  });
  const items: Array<ActivityItem & { sortAt: number }> = [
    ...inRooms.map((row) => ({
      kind: row.reason, roomId: row.room_id, messageId: row.message_id, threadOf: row.thread_of, at: row.created_at.toISOString(), seen: row.seen,
      sortAt: row.created_at.getTime(),
    })),
    ...work.questions.map((row) => ({ kind: 'question' as const, itemId: row.id, taskId: row.task_id, at: row.created_at.toISOString(), sortAt: row.created_at.getTime() })),
    ...work.team.map((row) => ({ kind: 'team_item' as const, itemId: row.id, taskId: row.task_id, at: row.created_at.toISOString(), sortAt: row.created_at.getTime() })),
    ...work.done.map((row) => ({ kind: 'work_done' as const, taskId: row.id, state: row.status, at: row.finished_at.toISOString(), sortAt: row.finished_at.getTime() })),
  ];
  return items.sort((a, b) => b.sortAt - a.sortAt).slice(0, ACTIVITY_PAGE).map(({ sortAt: _sortAt, ...item }) => item as ActivityItem);
}
