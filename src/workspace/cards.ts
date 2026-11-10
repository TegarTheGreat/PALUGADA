/**
 * Cards: how agents appear in rooms (F19.5, F19.16; STATUS section 2.206).
 *
 * Agents are never members of a room and never write in one (NG2). What the
 * company's work needs of people is drawn into rooms by the platform, as
 * cards made from rows: a question or an approval in the thread of the
 * message the work was asked from, and in a division's room what needs a
 * person there when the room shows it. A card holds no words -- its kind,
 * what it points at, and the state it was last drawn in -- and is changed in
 * place as its work changes; what it says is read when it is shown
 * (`views.ts`).
 *
 * The sweep is a stage of the worker. It reconciles from state, not only
 * from the journal: an item that should have a card and has none gets one,
 * however its event was missed, and a pass over a company that changed
 * nothing writes nothing.
 *
 * The CEO's weekly meeting is one card in the company room (STATUS 2.211),
 * quiet: it tells nobody and counts as nothing unread. Its questions and
 * approvals go in its thread, as a piece of work's go in its asking
 * message's, and so do those of a meeting called about a message.
 */
import { randomUUID } from 'node:crypto';
import { withRoomPlatform, type TenantClient } from '../db/tenant.ts';
import { approverSeats } from '../inbox/inbox.ts';
import { ensureCompanyRooms } from './rooms.ts';
import { itemState } from './views.ts';

/** How far back an open item is matched against the cards that exist. */
const STATE_DAYS = 30;
/** How long work may wait for its role before its thread says it is queued. */
const QUEUED_AFTER_MINUTES = 10;
/** The journal is read again this far behind the cursor: a transaction that began earlier may commit after it moved. */
const CURSOR_OVERLAP_SECONDS = 30;

/** A notice the platform writes, coded: the console says it in the reader's language. */
export type NoticeCode =
  | 'held_paused' | 'refused_frozen' | 'refused_incomplete' | 'refused_budget' | 'refused_goal' | 'refused_project'
  | 'recorded' | 'queued';

/**
 * A coded notice in a room, at its top or in a thread: why an ask waits, or
 * that it was recorded. It holds no words; `values` are the few the console
 * fills its sentence with (a role's name).
 */
export async function postNotice(
  companyId: string, roomId: string, threadOf: string | null, code: NoticeCode, values: Record<string, string> = {},
): Promise<void> {
  await withRoomPlatform(companyId, async (tx) => {
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, thread_of, kind, author, via, notice_code, notice_values, position)
       VALUES ($1, $2, $3, $4, 'notice', 'platform', 'platform', $5, $6, 0)`,
      [randomUUID(), companyId, roomId, threadOf, code, JSON.stringify(values)]);
  });
}

/**
 * Attention a card owes someone, given only where they can see the room: the
 * database refuses any other (0150), and asking first keeps the sweep's
 * transaction whole. Once per person per card.
 */
async function owe(tx: TenantClient, companyId: string, roomId: string, messageId: string, principals: readonly string[]): Promise<number> {
  let owed = 0;
  for (const principal of new Set(principals)) {
    const { rows } = await tx.query<{ sees: boolean }>('SELECT app.may_see($1, $2, $3) AS sees', [companyId, roomId, principal]);
    if (!rows[0]!.sees) continue;
    const { rowCount } = await tx.query(
      `INSERT INTO room_mentions (company_id, message_id, principal, reason) VALUES ($1, $2, $3, 'card') ON CONFLICT DO NOTHING`,
      [companyId, messageId, principal]);
    owed += rowCount ?? 0;
  }
  return owed;
}

/**
 * The message a piece of work was asked from in a room: the one whose press
 * made the root of its chain -- given as work, or a meeting called about it --
 * or the weekly meeting's own card. `became_by` is who pressed, and null for
 * the weekly meeting, which nobody did.
 */
async function askingMessageOf(tx: TenantClient, taskId: string): Promise<{ id: string; room_id: string; became_by: string | null } | null> {
  const { rows } = await tx.query<{ id: string; room_id: string; became_by: string | null }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_task_id, 0 AS depth FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_task_id, up.depth + 1 FROM tasks t JOIN up ON t.id = up.parent_task_id WHERE up.depth < 64
     )
     SELECT m.id, m.room_id, m.became_by FROM up
       JOIN room_messages m ON m.task_id = up.id
        AND (m.became IN ('work', 'meeting') OR (m.kind = 'meeting' AND m.author = 'platform' AND m.thread_of IS NULL))
      ORDER BY up.depth DESC LIMIT 1`,
    [taskId]);
  return rows[0] ?? null;
}

/**
 * One pass over a company's rooms: their cards made, redrawn and told, and
 * the cursor moved on. Returns how many rows it wrote. Run by the worker each
 * tick, after the inbox's own stages and before the owner is notified.
 */
export async function syncRoomCards(companyId: string): Promise<number> {
  // A division made since the last pass has its room before a card is put in it.
  await ensureCompanyRooms(companyId);
  // Who may decide a card: the inbox's approvers, less the seats whose words are in the work (below).
  const deciders = await approverSeats(companyId);
  return withRoomPlatform(companyId, async (tx) => {
    // The clock's row, held to commit: two workers' passes over one company
    // run one after the other, and each sees what the other wrote.
    await tx.query("SELECT app.advance_card_cursor($1, '-infinity')", [companyId]);
    const { rows: clock } = await tx.query<{ now: Date }>('SELECT now() AS now');
    const now = clock[0]!.now;
    let written = 0;

    // 0. The weekly meeting's card in the company room, made before its
    //    questions look for it: one per meeting, told to nobody. Every one
    //    not over, and one that ended within the day, so a meeting that ran
    //    between two passes still shows its record, while the meetings of
    //    weeks before this sweep existed are not posted all at once.
    const { rows: weekly } = await tx.query<{ id: string; status: string }>(
      `SELECT t.id, t.status FROM tasks t
        WHERE t.idempotency_key LIKE 'meeting:%' AND t.parent_task_id IS NULL
          AND t.created_at > $1::timestamptz - make_interval(days => ${STATE_DAYS})
          AND (t.status NOT IN ('completed', 'failed', 'halted', 'cancelled') OR t.created_at > $1::timestamptz - interval '1 day')
          AND NOT EXISTS (SELECT 1 FROM room_messages c WHERE c.kind = 'meeting' AND c.task_id = t.id)
        ORDER BY t.created_at, t.id`,
      [now]);
    if (weekly.length > 0) {
      const { rows: company } = await tx.query<{ id: string }>("SELECT id FROM rooms WHERE kind = 'company'");
      for (const meeting of weekly) {
        if (!company[0]) break;
        await tx.query(
          `INSERT INTO room_messages (id, company_id, room_id, kind, author, via, task_id, notice_values, position)
           VALUES ($1, $2, $3, 'meeting', 'platform', 'platform', $4, $5, 0)`,
          [randomUUID(), companyId, company[0].id, meeting.id, JSON.stringify({ state: meeting.status })]);
        written += 1;
      }
    }

    // 1. Every open question a run put and every open approval, from the last
    //    month, without a card yet: posted where it belongs, or nowhere.
    const { rows: items } = await tx.query<{
      id: string; kind: string; tier: number | null; task_id: string; addressee_seat: string | null; instigators: string[];
      division_id: string; owner_only: boolean;
    }>(
      `SELECT i.id, i.kind, i.tier, i.task_id, i.addressee_seat, i.instigators::text[] AS instigators, t.division_id,
              coalesce(i.payload->>'ownerOnly' = 'true', false) AS owner_only
         FROM inbox_items i JOIN tasks t ON t.id = i.task_id
        WHERE i.status = 'open' AND i.created_at > $1::timestamptz - make_interval(days => ${STATE_DAYS})
          AND (i.kind = 'approval' OR (i.kind = 'escalation' AND i.payload->>'askedBy' = 'agent'))
          AND NOT EXISTS (SELECT 1 FROM room_messages c WHERE c.inbox_item_id = i.id AND c.kind IN ('question', 'approval'))
        ORDER BY i.created_at, i.id`,
      [now]);
    for (const item of items) {
      const kind = item.kind === 'approval' ? 'approval' : 'question';
      const asking = await askingMessageOf(tx, item.task_id);
      let roomId: string | null = null;
      let threadOf: string | null = null;
      if (asking) {
        roomId = asking.room_id;
        threadOf = asking.id;
      } else {
        // Work the division was given outside a room: its room shows it only
        // when it needs a person there -- a question put to nobody, an
        // approval an approver may decide -- and a question put to a seat
        // never, since it is that seat's (their Activity says so).
        const { rows: division } = await tx.query<{ id: string }>(
          "SELECT id FROM rooms WHERE kind = 'division' AND division_id = $1 AND shows_work IN ('needs_people', 'all')",
          [item.division_id]);
        const fits = kind === 'question' ? item.addressee_seat === null : (item.tier ?? 0) <= 2;
        if (division[0] && fits) roomId = division[0].id;
      }
      if (roomId === null) continue;
      const cardId = randomUUID();
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, thread_of, kind, author, via, task_id, inbox_item_id, notice_values, position)
         VALUES ($1, $2, $3, $4, $5, 'platform', 'platform', $6, $7, $8, 0)`,
        [cardId, companyId, roomId, threadOf, kind, item.task_id, item.id, JSON.stringify({ state: 'open' })]);
      written += 1;
      const owed: string[] = [];
      // A question the owner alone is asked -- a joined meeting's -- is the
      // owner's attention alone: whoever called the meeting cannot answer it.
      if (item.owner_only) owed.push('owner');
      else if (asking?.became_by) owed.push(asking.became_by);
      if (item.addressee_seat) owed.push(`seat:${item.addressee_seat}`);
      if (kind === 'approval' && (item.tier ?? 0) <= 2) {
        owed.push(...deciders.filter((seat) => !item.instigators.includes(seat)).map((seat) => `seat:${seat}`));
      }
      written += await owe(tx, companyId, roomId, cardId, owed);
    }

    // 2. Every root task a division was given since its room was told to
    //    show all of its work (0154 keeps when), however long ago that was:
    //    reconciled from the tasks, so work whose transaction committed
    //    behind the cursor still gets its card.
    const { rows: started } = await tx.query<{ id: string; room_id: string }>(
      `SELECT t.id, r.id AS room_id FROM tasks t
         JOIN rooms r ON r.kind = 'division' AND r.division_id = t.division_id AND r.shows_work = 'all'
        WHERE t.parent_task_id IS NULL AND t.created_at > $1::timestamptz - make_interval(days => ${STATE_DAYS})
          AND t.created_at > r.shows_work_since
          AND coalesce(t.idempotency_key, '') NOT LIKE 'room:%'
          AND NOT EXISTS (SELECT 1 FROM room_messages c WHERE c.room_id = r.id AND c.kind = 'work' AND c.task_id = t.id)
        ORDER BY t.created_at, t.id`,
      [now]);
    for (const task of started) {
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, via, task_id, notice_values, position)
         VALUES ($1, $2, $3, 'work', 'platform', 'platform', $4, $5, 0)`,
        [randomUUID(), companyId, task.room_id, task.id, JSON.stringify({ state: 'pending' })]);
      written += 1;
    }

    // 3. Every card whose subject moved since it was drawn: drawn again, in
    //    place, which tells the rooms that show it (0150's update trigger).
    const { rows: cards } = await tx.query<{
      id: string; drawn: string | null; item_kind: string | null; status: string | null; decision: string | null;
      payload: Record<string, unknown> | null; task_status: string | null; closed_reason: string | null;
    }>(
      `SELECT c.id, c.notice_values->>'state' AS drawn, i.kind AS item_kind, i.status, i.decision, i.payload, t.status AS task_status,
              i.closed_reason
         FROM room_messages c
         LEFT JOIN inbox_items i ON i.id = c.inbox_item_id
         LEFT JOIN tasks t ON t.id = c.task_id
        WHERE c.author = 'platform' AND c.kind IN ('work', 'question', 'approval', 'meeting')
          AND c.created_at > $1::timestamptz - make_interval(days => ${STATE_DAYS})`,
      [now]);
    for (const card of cards) {
      const state = card.item_kind !== null
        ? itemState({ kind: card.item_kind, status: card.status!, decision: card.decision, payload: card.payload ?? {} }, card.closed_reason)
        : card.task_status ?? 'gone';
      if (state === card.drawn) continue;
      await tx.query('UPDATE room_messages SET notice_values = $2 WHERE id = $1', [card.id, JSON.stringify({ state })]);
      written += 1;
    }

    // 4. Work under a person's own message, which the platform does not
    //    write -- given as work, or a meeting called about it: when its task
    //    moved after the message was last drawn, the rooms are told to draw
    //    it again; when it ended, whoever pressed is told, once. A missed
    //    redraw is not lost: a card is read live.
    const { rows: moved } = await tx.query<{ id: string; room_id: string; became_by: string; status: string; moved_at: Date }>(
      `SELECT m.id, m.room_id, m.became_by, t.status, max(e.occurred_at) AS moved_at
         FROM room_messages m
         JOIN tasks t ON t.id = m.task_id
         JOIN events e ON e.task_id = t.id
          AND e.occurred_at > (SELECT c.cards_through - make_interval(secs => ${CURSOR_OVERLAP_SECONDS})
                                 FROM room_clock c WHERE c.company_id = $1)
        WHERE m.became IN ('work', 'meeting')
        GROUP BY m.id, m.room_id, m.became_by, t.status`,
      [companyId]);
    for (const message of moved) {
      const { rows: drawn } = await tx.query(
        "SELECT 1 FROM room_feed WHERE ref = $1 AND kind = 'card' AND created_at >= $2 LIMIT 1", [message.id, message.moved_at]);
      if (drawn.length === 0) {
        await tx.query('SELECT app.touch_room_card($1, $2, $3)', [companyId, message.room_id, message.id]);
        written += 1;
      }
      if (['completed', 'failed', 'halted', 'cancelled'].includes(message.status)) {
        written += await owe(tx, companyId, message.room_id, message.id, [message.became_by]);
      }
    }

    // 5. Work still waiting for its role after a while says so in its thread, once.
    const { rows: waiting } = await tx.query<{ id: string; room_id: string }>(
      `SELECT m.id, m.room_id FROM room_messages m JOIN tasks t ON t.id = m.task_id
        WHERE m.became IN ('work', 'meeting') AND t.status = 'pending'
          AND t.created_at < $1::timestamptz - make_interval(mins => ${QUEUED_AFTER_MINUTES})
          AND NOT EXISTS (SELECT 1 FROM room_messages n WHERE n.thread_of = m.id AND n.kind = 'notice' AND n.notice_code = 'queued')`,
      [now]);
    for (const message of waiting) {
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, thread_of, kind, author, via, notice_code, notice_values, position)
         VALUES ($1, $2, $3, $4, 'notice', 'platform', 'platform', 'queued', '{}', 0)`,
        [randomUUID(), companyId, message.room_id, message.id]);
      written += 1;
    }

    await tx.query('SELECT app.advance_card_cursor($1, $2)', [companyId, now]);
    return written;
  });
}
