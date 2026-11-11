/**
 * People's notices: who is told of what, when, and through which link (F19.13,
 * F10.5; STATUS section 2.213).
 *
 * A person who linked a phone is told what is theirs, and nothing else:
 *
 *   - a direct message, a mention (`@room` counted by the database for those
 *     who hear the room), and a reply in a thread they follow;
 *   - of agent work, only a run's question put to them, an approval they may
 *     decide, and work they asked for that ended. A card an agent's work draws
 *     in a room is the platform's, and tells nobody anything here;
 *   - a people's meeting they were asked to, ten minutes before it starts,
 *     once the rooms' sweep has reminded it (STATUS section 2.215).
 *
 * Never of their own words. One notice per room in ten minutes, the rest
 * counted on it. At most their daily number a day, then only how many more,
 * said with the next day's first. Held through their quiet hours, and the
 * owner's through the owner's window. The owner hears people only when they
 * turned it on, and a notice is never an inbox item, so the owner's day is
 * what the inbox counts (G3).
 *
 * `planNotices` runs under the delivery reader, which sees ids and positions
 * and no word: who may see the room is asked for each person as it plans
 * (`app.may_see`). `dispatchPeopleNotices` reads each notice's subject again
 * as the person told, just before sending, so a room they were taken out of,
 * a message deleted, or one they have read since is never sent; and it reads
 * the words only there, only for a link whose share is `content`. The ledger
 * copies the owner's (`notify.ts`): claimed, then sent, then settled; three
 * tries, thirty seconds apart and doubling; a send whose outcome was never
 * learned is never made again.
 *
 * Both run in the worker's notify stage, never inline in a request: a route
 * the assistant may call runs inside its dispatch, where the people's helpers
 * refuse (STATUS section 2.203).
 */
import { withControlPlane, withDelivery, withPeople, type Person, type TenantClient } from '../db/tenant.ts';
import { TEAM_SQL } from '../inbox/inbox.ts';
import { relayPeopleNotice, type PeopleNotice, type Said } from '../relay/people.ts';
import { notifyAfterFor } from '../scheduler/windows.ts';
import { redactor } from '../secrets/manager.ts';
import { REMIND_MINUTES } from '../workspace/cards.ts';
import { directoryOf, type Directory } from '../workspace/views.ts';
import { haltSaid } from './halt-said.ts';
import { askerOf, RETRY_BASE_MS, type OwnerChannel } from './notify.ts';
import {
  approvalSaid, meetingSoonSaid, moreYesterdaySaid, questionSaid, roomNoticeSaid, somethingNewSaid, whoSaid, workSaid,
} from './people-said.ts';

/** How long one room's notices are one notice. */
export const WINDOW_MINUTES = 10;
/** How many times a notice is tried before it is left. */
export const NOTICE_ATTEMPTS = 3;
/** The longest excerpt a link at `content` is sent. */
export const EXCERPT_CHARS = 140;
/** How long a notice is kept, as bookkeeping. */
export const NOTICE_DAYS = 30;
/** How far back work's notices look: a question, an approval or work done older than this is not news. */
const LOOKBACK_DAYS = 7;
/** How much of a company's feed one pass plans. */
const FEED_BATCH = 500;
/** How many notices one pass sends. */
const SEND_BATCH = 100;

const ROOM_REASONS = ['direct', 'mention', 'reply'] as const;
type RoomReason = (typeof ROOM_REASONS)[number];
type Reason = RoomReason | 'question' | 'approval' | 'work_done' | 'meeting';

/** Where a notice opens in the console: a room and a thread, an item, or a task. */
export interface NoticeTarget {
  companyId: string;
  roomId?: string | null;
  threadOf?: string | null;
  itemId?: string | null;
  taskId?: string | null;
}

export type NoticeLinkFor = (target: NoticeTarget) => string | null;

/**
 * A notice's link, made from the deployment's link to a task: the same
 * public address, opened on a room and a thread, an item or a task instead
 * (`?company=&room=&thread=`, which the console reads). None when the
 * deployment has no public address.
 */
export function noticeLinks(taskLink: ((task: { companyId: string; taskId: string }) => string | null) | undefined): NoticeLinkFor | undefined {
  if (!taskLink) return undefined;
  return (target) => {
    const made = taskLink({ companyId: target.companyId, taskId: target.taskId ?? '' });
    if (made === null) return null;
    const link = new URL(made);
    link.search = '';
    link.searchParams.set('company', target.companyId);
    if (target.roomId) link.searchParams.set('room', target.roomId);
    if (target.threadOf) link.searchParams.set('thread', target.threadOf);
    if (target.itemId) link.searchParams.set('item', target.itemId);
    if (target.taskId) link.searchParams.set('task', target.taskId);
    return link.toString();
  };
}

/** A person's own settings, as notices read them (0149): the defaults where they set none. */
interface Prefs {
  language: string | null;
  timezone: string;
  quietStart: number | null;
  quietEnd: number | null;
  perDay: number;
  hears: boolean;
}

interface Audience {
  /** Each person who may be told, the channels they may be told through, and since when. */
  people: Map<string, { channels: Array<{ channel: string; since: Date | null }>; prefs: Prefs }>;
  /** The seats that decide the team's cards now. */
  approvers: Set<string>;
  /** The deployment's language, for a person who chose none. */
  language: string;
}

/** The chats among the owner's channels that take the owner's people's notices. */
function chatsOf(chats: readonly OwnerChannel[] | undefined): OwnerChannel[] {
  return (chats ?? []).filter((channel) => typeof channel.deliverPeopleNotice === 'function');
}

/**
 * Who of a company may be told anything, read on the control plane where
 * links, seats and settings are kept: everyone with a phone linked through a
 * paired relay that hears about the company, and the owner's chats; the
 * owner only when they turned people's notices on.
 */
async function audienceOf(companyId: string, chats: readonly string[]): Promise<Audience> {
  return withControlPlane(async (tx) => {
    const { rows: links } = await tx.query<{ principal: string; relay_id: string; claimed_at: Date | null }>(
      `SELECT l.principal, l.relay_id, l.claimed_at
         FROM relay_links l JOIN relays r ON r.id = l.relay_id
        WHERE l.status = 'active' AND r.status = 'paired' AND (r.all_companies OR $1 = ANY(r.companies))
          AND (l.principal = 'owner' OR (l.company_id = $1 AND EXISTS (
                SELECT 1 FROM staff_seats s WHERE 'seat:' || s.id::text = l.principal
                   AND s.company_id = $1 AND s.joined_at IS NOT NULL AND s.revoked_at IS NULL)))`,
      [companyId]);
    const { rows: [where] } = await tx.query<{ timezone: string | null; owner_timezone: string; language: string | null }>(
      `SELECT (SELECT timezone FROM companies WHERE id = $1) AS timezone, owner_timezone, console_language AS language FROM platform_control`,
      [companyId]);
    const principals = [...new Set(['owner', ...links.map((link) => link.principal)])];
    const { rows: kept } = await tx.query<{
      principal: string; language: string | null; timezone: string | null; quiet_start: number | null; quiet_end: number | null;
      notices_per_day: number; owner_hears_people: boolean;
    }>(
      `SELECT principal, language, timezone, quiet_start, quiet_end, notices_per_day, owner_hears_people
         FROM principal_prefs WHERE principal = ANY($1::text[])`, [principals]);
    const settings = new Map(kept.map((row) => [row.principal, row]));
    const { rows: approvers } = await tx.query<{ id: string }>(
      `SELECT id FROM staff_seats WHERE company_id = $1 AND kind = 'approver' AND joined_at IS NOT NULL AND revoked_at IS NULL`, [companyId]);

    const people: Audience['people'] = new Map();
    const prefsOf = (principal: string): Prefs => {
      const row = settings.get(principal);
      const owner = principal === 'owner';
      return {
        language: row?.language ?? null,
        // The owner's day is the owner window's, a seat's its company's, unless they said where they are.
        timezone: row?.timezone ?? (owner ? where!.owner_timezone : where!.timezone ?? 'UTC'),
        quietStart: row?.quiet_start ?? null,
        quietEnd: row?.quiet_end ?? null,
        // The owner's ten a day until they say otherwise (STATUS 2.209).
        perDay: row?.notices_per_day ?? (owner ? 10 : 30),
        hears: row?.owner_hears_people ?? false,
      };
    };
    const add = (principal: string, channel: string, since: Date | null) => {
      const entry = people.get(principal) ?? { channels: [], prefs: prefsOf(principal) };
      entry.channels.push({ channel, since });
      people.set(principal, entry);
    };
    for (const link of links) add(link.principal, `relay:${link.relay_id}`, link.claimed_at);
    for (const chat of chats) add('owner', chat, null);
    // F10.5: people reach the owner only when the owner turned it on.
    if (!people.get('owner')?.prefs.hears) people.delete('owner');
    return { people, approvers: new Set(approvers.map((row) => `seat:${row.id}`)), language: where!.language ?? 'en' };
  });
}

/** A moment's date, hour, minute and second in a time zone. */
function localTime(at: Date, timezone: string): { date: string; hour: number; minute: number; second: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    // A zone this runtime does not know is read as UTC rather than not at all.
    return localTime(at, 'UTC');
  }
  const part = (type: string) => parts.find((one) => one.type === type)?.value ?? '0';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')) % 24, minute: Number(part('minute')), second: Number(part('second')),
  };
}

/** When a seat's notice may go: now, or when their quiet hours end. */
function afterQuietHours(now: Date, prefs: Prefs): Date {
  if (prefs.quietStart === null || prefs.quietEnd === null || prefs.quietStart === prefs.quietEnd) return now;
  const local = localTime(now, prefs.timezone);
  const { quietStart: start, quietEnd: end } = prefs;
  const quiet = start < end ? local.hour >= start && local.hour < end : local.hour >= start || local.hour < end;
  if (!quiet) return now;
  const hours = (end - local.hour + 24) % 24;
  return new Date(now.getTime() + hours * 3_600_000 - local.minute * 60_000 - local.second * 1_000);
}

/** How much a reason weighs when one message owes a person for two: a mention survives mute, and says most. */
const WEIGHT: Record<RoomReason, number> = { mention: 3, direct: 2, reply: 1 };

/**
 * Plans what each person of a company is owed since the last pass: a notice
 * for every person, channel and room window, and for every question,
 * approval and finished work that is theirs. Answers how many notices were
 * made, beside those that only counted one more on a notice already made.
 */
export async function planNotices(
  companyId: string,
  options: { now?: Date; chats?: readonly OwnerChannel[] } = {},
): Promise<{ planned: number }> {
  const now = options.now ?? new Date();
  const audience = await audienceOf(companyId, chatsOf(options.chats).map((channel) => channel.name));
  // The owner's window, read once: the owner's notices wait for it (F9.3).
  const ownerOpens = audience.people.has('owner') ? await notifyAfterFor('notice', { now }) : now;
  const timing = (principal: string, prefs: Prefs) => {
    const after = principal === 'owner' ? ownerOpens : afterQuietHours(now, prefs);
    return { after, day: localTime(after, prefs.timezone).date };
  };
  const purge = purgeDue(companyId, now);

  let planned = await withDelivery(companyId, async (tx) => {
    let made = 0;
    // A look without the lock first: a company whose rooms are quiet since
    // the last pass takes no lock at all, and every room write goes on.
    const { rows: [peek] } = await tx.query<{ position: string; through: string }>(
      'SELECT position, notices_through AS through FROM room_clock WHERE company_id = $1', [companyId]);
    let feed: Array<{ position: string; room_id: string; ref: string; author: string; kind: string; created_at: Date }> = [];
    let through: number | null = null;
    if (peek && Number(peek.position) > Number(peek.through)) {
      // The company's clock, held from here to commit: two workers plan one
      // company one at a time, and every position up to the clock is committed.
      const { rows: [cursor] } = await tx.query<{ through: string }>('SELECT app.take_notice_cursor($1) AS through', [companyId]);
      const { rows: [clock] } = await tx.query<{ position: string }>('SELECT position FROM room_clock WHERE company_id = $1', [companyId]);
      ({ rows: feed } = await tx.query(
        `SELECT f.position, f.room_id, f.ref, f.author, r.kind, f.created_at
           FROM room_feed f JOIN rooms r ON r.company_id = f.company_id AND r.id = f.room_id
          WHERE f.kind = 'message' AND f.position > $1
          ORDER BY f.position LIMIT ${FEED_BATCH}`,
        [cursor!.through]));
      // Read to the end, the cursor is the clock, past what changed that was
      // no message; a full batch leaves the rest to the next pass.
      through = feed.length < FEED_BATCH ? Number(clock!.position) : Number(feed.at(-1)!.position);
    }

    if (audience.people.size > 0 && feed.length > 0) {
      // Only people's words tell anyone: a card is the platform's, and its
      // attention is Activity's, never a notice (agent work tells a person
      // only through the three reasons below).
      const said = feed.filter((row) => row.author !== 'platform' && /^(owner|seat:)/.test(row.author ?? ''));
      const ids = said.map((row) => row.ref);
      const { rows: attention } = ids.length === 0 ? { rows: [] } : await tx.query<{ message_id: string; principal: string; reason: 'mention' | 'reply' }>(
        `SELECT message_id, principal, reason FROM room_mentions WHERE message_id = ANY($1::uuid[]) AND reason IN ('mention', 'reply')`, [ids]);
      const directRooms = [...new Set(said.filter((row) => row.kind === 'direct').map((row) => row.room_id))];
      const { rows: members } = directRooms.length === 0 ? { rows: [] } : await tx.query<{ room_id: string; principal: string }>(
        'SELECT room_id, principal FROM room_members WHERE room_id = ANY($1::uuid[]) AND left_at IS NULL', [directRooms]);
      const rooms = [...new Set(said.map((row) => row.room_id))];
      const { rows: places } = rooms.length === 0 ? { rows: [] } : await tx.query<{ room_id: string; principal: string; notify: string; muted_until: Date | null }>(
        'SELECT room_id, principal, notify, muted_until FROM room_places WHERE room_id = ANY($1::uuid[]) AND principal = ANY($2::text[])',
        [rooms, [...audience.people.keys()]]);
      const placeOf = new Map(places.map((place) => [`${place.room_id}:${place.principal}`, place]));
      const seeing = new Map<string, boolean>();
      const maySee = async (roomId: string, principal: string) => {
        const key = `${roomId}:${principal}`;
        if (!seeing.has(key)) {
          const { rows: [seen] } = await tx.query<{ ok: boolean }>('SELECT app.may_see($1, $2, $3) AS ok', [companyId, roomId, principal]);
          seeing.set(key, seen!.ok === true);
        }
        return seeing.get(key)!;
      };

      for (const message of said) {
        const owed = new Map<string, RoomReason>();
        const owe = (principal: string, reason: RoomReason) => {
          const had = owed.get(principal);
          if (!had || WEIGHT[reason] > WEIGHT[had]) owed.set(principal, reason);
        };
        for (const one of attention.filter((row) => row.message_id === message.ref)) owe(one.principal, one.reason);
        if (message.kind === 'direct') {
          for (const member of members.filter((row) => row.room_id === message.room_id)) {
            if (placeOf.get(`${message.room_id}:${member.principal}`)?.notify !== 'none') owe(member.principal, 'direct');
          }
        }
        for (const [principal, reason] of owed) {
          // The author is never told of their own words.
          if (principal === message.author) continue;
          const person = audience.people.get(principal);
          if (!person) continue;
          const place = placeOf.get(`${message.room_id}:${principal}`);
          // A muted room is quiet, but a mention is not a room's noise.
          if (reason !== 'mention' && place?.muted_until && place.muted_until > now) continue;
          if (!(await maySee(message.room_id, principal))) continue;
          const { after, day } = timing(principal, person.prefs);
          for (const { channel, since } of person.channels) {
            if (since !== null && message.created_at < since) continue;
            made += await owe1(tx, {
              companyId, principal, channel, roomId: message.room_id, reason, messageId: message.ref,
              position: Number(message.position), after, day, now,
            });
          }
        }
      }
    }

    if (through !== null) await tx.query('SELECT app.advance_notice_cursor($1, $2)', [companyId, through]);
    return made;
  });

  // What agent work tells a seat, in a transaction of its own: its reads of
  // the inbox and the tasks need no clock, and every room write in the
  // company waits while the clock is held. Only a notice it writes takes it.
  const seats = [...audience.people.keys()].filter((principal) => principal !== 'owner');
  if (seats.length > 0) planned += await withDelivery(companyId, (tx) => planWork(tx, companyId, audience, seats, timing, now));
  // People's meetings about to start, in a transaction of their own for the same reason.
  if (audience.people.size > 0) planned += await withDelivery(companyId, (tx) => planMeetings(tx, companyId, audience, timing, now));
  if (purge) {
    await withDelivery(companyId, (tx) => tx.query(
      `DELETE FROM people_notices WHERE created_at < $1::timestamptz - make_interval(days => ${NOTICE_DAYS})`, [now]));
  }
  return { planned };
}

/** When this process last purged each company's notices: once an hour is enough for bookkeeping. */
const purged = new Map<string, number>();

function purgeDue(companyId: string, now: Date): boolean {
  const last = purged.get(companyId) ?? 0;
  if (now.getTime() - last < 3_600_000) return false;
  purged.set(companyId, now.getTime());
  if (purged.size > 10_000) purged.delete(purged.keys().next().value!);
  return true;
}

/**
 * One person's notice about words in a room, on one channel: one more on
 * the room's notice of the last ten minutes, or a notice of its own. Answers
 * 1 when a notice was made. A window whose notice was read or found gone
 * before it went is closed: what comes after it is told afresh. A heavier
 * reason than the window's opens a notice of its own: a mention after a
 * direct message or a reply is told as a mention, in a room muted since the
 * window opened too, rather than counted on a notice that may have gone.
 */
async function owe1(tx: TenantClient, input: {
  companyId: string; principal: string; channel: string; roomId: string; reason: RoomReason; messageId: string;
  position: number; after: Date; day: string; now: Date;
}): Promise<number> {
  // The window's newest notice, which is its heaviest: a lighter or equal
  // reason never opens one. A meeting's reminder names its room too, and is
  // no window of words.
  const { rows: [open] } = await tx.query<{ id: string; reason: RoomReason }>(
    `SELECT id, reason FROM people_notices
      WHERE principal = $1 AND channel = $2 AND room_id = $3 AND created_at > $4::timestamptz - make_interval(mins => ${WINDOW_MINUTES})
        AND reason IN ('direct', 'mention', 'reply')
        AND (settled_as IS NULL OR settled_as IN ('sent', 'capped'))
      ORDER BY created_at DESC, position DESC LIMIT 1`,
    [input.principal, input.channel, input.roomId, input.now]);
  if (open && WEIGHT[input.reason] <= WEIGHT[open.reason]) {
    await tx.query(
      'UPDATE people_notices SET count = LEAST(count + 1, 32767), position = GREATEST(position, $2) WHERE id = $1',
      [open.id, input.position]);
    return 0;
  }
  const { rowCount } = await tx.query(
    `INSERT INTO people_notices (company_id, principal, room_id, reason, subject, position, window_key, day, channel, notify_after, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (company_id, principal, channel, window_key) DO NOTHING`,
    [input.companyId, input.principal, input.roomId, input.reason, `message:${input.messageId}`, input.position,
      `room:${input.roomId}:${input.messageId}`, input.day, input.channel, input.after, input.now]);
  return rowCount ?? 0;
}

/**
 * What agent work tells a seat: a run's question put to it, an approval of
 * the team's it may decide (never one its own words are in), and work it
 * asked for that ended. Each once per channel, since the channel's link was
 * made.
 */
async function planWork(
  tx: TenantClient, companyId: string, audience: Audience, seats: string[],
  timing: (principal: string, prefs: Prefs) => { after: Date; day: string }, now: Date,
): Promise<number> {
  const subjects: Array<{ principal: string; reason: Reason; subject: string; at: Date }> = [];
  const { rows: questions } = await tx.query<{ id: string; seat: string; created_at: Date }>(
    `SELECT i.id, i.addressee_seat::text AS seat, i.created_at FROM inbox_items i
      WHERE i.status = 'open' AND i.kind = 'escalation' AND i.addressee_seat IS NOT NULL AND i.payload->>'askedBy' = 'agent'
        AND i.created_at > $1::timestamptz - make_interval(days => ${LOOKBACK_DAYS})`, [now]);
  for (const row of questions) subjects.push({ principal: `seat:${row.seat}`, reason: 'question', subject: `item:${row.id}`, at: row.created_at });
  const deciders = seats.filter((principal) => audience.approvers.has(principal));
  if (deciders.length > 0) {
    const { rows: approvals } = await tx.query<{ id: string; instigators: string[]; created_at: Date }>(
      `SELECT i.id, i.instigators::text[] AS instigators, i.created_at FROM inbox_items i
        WHERE i.status = 'open' AND i.kind = 'approval' AND ${TEAM_SQL}
          AND NOT coalesce((i.payload->>'ownerOnly')::boolean, false)
          AND i.created_at > $1::timestamptz - make_interval(days => ${LOOKBACK_DAYS})`, [now]);
    for (const row of approvals) {
      for (const principal of deciders) {
        // Four eyes: nobody is asked to decide what they asked for.
        if (row.instigators.includes(principal.slice('seat:'.length))) continue;
        subjects.push({ principal, reason: 'approval', subject: `item:${row.id}`, at: row.created_at });
      }
    }
  }
  const { rows: done } = await tx.query<{ id: string; seat: string; finished_at: Date }>(
    `SELECT t.id, t.requested_by_seat::text AS seat, t.finished_at FROM tasks t
      WHERE t.requested_by_seat IS NOT NULL AND t.parent_task_id IS NULL AND t.status IN ('completed', 'failed', 'halted')
        AND t.finished_at > $1::timestamptz - make_interval(days => ${LOOKBACK_DAYS})`, [now]);
  for (const row of done) subjects.push({ principal: `seat:${row.seat}`, reason: 'work_done', subject: `task:${row.id}`, at: row.finished_at });

  if (subjects.length === 0) return 0;
  // What is told already is left alone without a write, which would take
  // the company's clock for nothing on every pass.
  const { rows: told } = await tx.query<{ principal: string; channel: string; window_key: string }>(
    'SELECT principal, channel, window_key FROM people_notices WHERE window_key = ANY($1::text[])',
    [[...new Set(subjects.map((one) => one.subject))]]);
  const known = new Set(told.map((row) => `${row.principal}|${row.channel}|${row.window_key}`));
  let planned = 0;
  for (const one of subjects) {
    const person = audience.people.get(one.principal);
    if (!person) continue;
    const { after, day } = timing(one.principal, person.prefs);
    for (const { channel, since } of person.channels) {
      if (since !== null && one.at < since) continue;
      if (known.has(`${one.principal}|${channel}|${one.subject}`)) continue;
      const { rowCount } = await tx.query(
        `INSERT INTO people_notices (company_id, principal, reason, subject, window_key, day, channel, notify_after, created_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, principal, channel, window_key) DO NOTHING`,
        [companyId, one.principal, one.reason, one.subject, day, channel, after, now]);
      planned += rowCount ?? 0;
    }
  }
  return planned;
}

/** The notice a meeting's nth reminder is: one for each reminder and channel, and a meeting is reminded twice at most (0159). */
function meetingKey(meetingId: string, reminders: number): string {
  return `meeting:${meetingId}#${reminders}`;
}

/**
 * That a reminded meeting is still where its reminder said, as SQL on the
 * meetings' alias: within ten minutes of the reminder, not moved later since.
 */
function stillSoon(g: string): string {
  return `${g}.starts_at <= ${g}.reminded_at + make_interval(mins => ${REMIND_MINUTES})`;
}

/**
 * What a people's meeting about to start tells the people asked (F19.26,
 * STATUS section 2.215): once the rooms' sweep has reminded it, a notice for
 * each person asked who may be told and can still see the room, once for
 * each reminder and channel, since the channel's link was made. A meeting
 * moved later than its reminder said, once it was reminded twice and so is
 * reminded no more, tells nobody it starts in ten minutes. A reminder that
 * the person's quiet hours, or the owner's window, would hold until the
 * meeting has begun is not planned. Read under the delivery reader, which
 * sees who was asked and when, and never the words.
 */
async function planMeetings(
  tx: TenantClient, companyId: string, audience: Audience,
  timing: (principal: string, prefs: Prefs) => { after: Date; day: string }, now: Date,
): Promise<number> {
  const { rows: meetings } = await tx.query<{
    id: string; room_id: string; starts_at: Date; attendees: string[]; reminded_at: Date; reminders: number;
  }>(
    `SELECT g.id, g.room_id, g.starts_at, g.attendees::text[] AS attendees, g.reminded_at, g.reminders FROM room_meetings g
      WHERE g.reminded_at IS NOT NULL AND g.cancelled_at IS NULL AND g.starts_at > $1 AND ${stillSoon('g')}
      ORDER BY g.starts_at, g.id`, [now]);
  if (meetings.length === 0) return 0;
  const keyOf = (meeting: { id: string; reminders: number }) => meetingKey(meeting.id, meeting.reminders);
  // What is told already is left alone without a write, as for agent work.
  const { rows: told } = await tx.query<{ principal: string; channel: string; window_key: string }>(
    'SELECT principal, channel, window_key FROM people_notices WHERE window_key = ANY($1::text[])', [meetings.map(keyOf)]);
  const known = new Set(told.map((row) => `${row.principal}|${row.channel}|${row.window_key}`));
  let planned = 0;
  for (const meeting of meetings) {
    const key = keyOf(meeting);
    for (const principal of new Set(meeting.attendees)) {
      const person = audience.people.get(principal);
      if (!person) continue;
      const owed = person.channels.filter(({ channel, since }) =>
        (since === null || meeting.reminded_at >= since) && !known.has(`${principal}|${channel}|${key}`));
      if (owed.length === 0) continue;
      const { after, day } = timing(principal, person.prefs);
      if (after >= meeting.starts_at) continue;
      const { rows: [seen] } = await tx.query<{ ok: boolean }>('SELECT app.may_see($1, $2, $3) AS ok', [companyId, meeting.room_id, principal]);
      if (seen?.ok !== true) continue;
      for (const { channel } of owed) {
        const { rowCount } = await tx.query(
          `INSERT INTO people_notices (company_id, principal, room_id, reason, subject, window_key, day, channel, notify_after, created_at)
           VALUES ($1, $2, $3, 'meeting', $4, $5, $6, $7, $8, $9)
           ON CONFLICT (company_id, principal, channel, window_key) DO NOTHING`,
          [companyId, principal, meeting.room_id, `meeting:${meeting.id}`, key, day, channel, after, now]);
        planned += rowCount ?? 0;
      }
    }
  }
  return planned;
}

interface DueRow {
  id: string;
  principal: string;
  room_id: string | null;
  reason: Reason;
  subject: string;
  window_key: string;
  position: string | null;
  count: number;
  channel: string;
}

/** What a notice became: sent, or settled without being sent, or a send that failed. */
type Outcome = { settled: 'sent' | 'read' | 'capped' | 'gone'; day?: string } | { error: string };

/** What the person told may know of the notice's subject, read as them. */
type Subject =
  | { state: 'gone' | 'read' }
  | { state: 'ok'; type: PeopleNotice['type']; said: Record<'summary' | 'content', Said> & { signal: Said };
      target: NoticeTarget; room?: PeopleNotice['room']; item?: PeopleNotice['item']; subjects: string[]; words?: string };

/**
 * Sends what is due of a company's notices, each to the channel it was
 * planned for. Answers how many were sent, and how the others settled.
 */
export async function dispatchPeopleNotices(
  companyId: string,
  options: { now?: Date; chats?: readonly OwnerChannel[]; linkFor?: NoticeLinkFor } = {},
): Promise<{ sent: number; read: number; capped: number; gone: number; failed: number }> {
  const now = options.now ?? new Date();
  const report = { sent: 0, read: 0, capped: 0, gone: 0, failed: 0 };
  const due = await withDelivery(companyId, async (tx) => (await tx.query<DueRow>(
    `SELECT id, principal, room_id, reason, subject, window_key, position, count, channel FROM people_notices
      WHERE delivered_at IS NULL AND settled_as IS NULL AND notify_after <= $1 AND (${retryDue('$1')})
      ORDER BY created_at, id LIMIT ${SEND_BATCH}`, [now])).rows);
  if (due.length === 0) return report;

  const chats = new Map(chatsOf(options.chats).map((channel) => [channel.name, channel]));
  const audience = await audienceOf(companyId, [...chats.keys()]);
  const directory = await directoryOf(companyId);
  const names = await namesOf(companyId);

  for (const row of due) {
    // Claimed first: a crash after this loses the notice rather than sending it twice.
    const claimed = await withDelivery(companyId, async (tx) => (await tx.query(
      `UPDATE people_notices SET attempts = attempts + 1, last_attempt_at = $2, last_error = NULL
        WHERE id = $1 AND delivered_at IS NULL AND settled_as IS NULL AND (${retryDue('$2')})`, [row.id, now])).rowCount === 1);
    if (!claimed) continue;
    let outcome: Outcome;
    try {
      outcome = await deliver(companyId, row, { audience, directory, names, chats, now, linkFor: options.linkFor ?? null });
    } catch (error) {
      outcome = { error: redactor.redact(String((error as Error).message ?? error)).slice(0, 500) };
    }
    await withDelivery(companyId, (tx) => tx.query(
      `UPDATE people_notices
          SET settled_as = $2, delivered_at = CASE WHEN $2 = 'sent' THEN $3::timestamptz END,
              day = coalesce($4::date, day), last_error = $5
        WHERE id = $1`,
      'error' in outcome
        ? [row.id, null, now, null, outcome.error]
        : [row.id, outcome.settled, now, outcome.day ?? null, null]));
    if ('error' in outcome) report.failed += 1;
    else report[outcome.settled] += 1;
  }
  return report;
}

/** A notice not yet tried, or one whose last try failed and whose wait is over: 30 seconds, then a minute, then two. */
function retryDue(now: string): string {
  return `attempts = 0 OR (last_error IS NOT NULL AND attempts < ${NOTICE_ATTEMPTS}
            AND last_attempt_at <= ${now}::timestamptz - make_interval(secs => ${RETRY_BASE_MS / 1000} * power(2, attempts - 1)))`;
}

/** The company's name and its divisions', which name the shared rooms. */
async function namesOf(companyId: string): Promise<{ company: string; divisions: Map<string, string> }> {
  return withControlPlane(async (tx) => {
    const { rows: [company] } = await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]);
    const { rows: divisions } = await tx.query<{ id: string; name: string }>('SELECT id, name FROM divisions WHERE company_id = $1', [companyId]);
    return { company: company?.name ?? '', divisions: new Map(divisions.map((one) => [one.id, one.name])) };
  });
}

interface Context {
  audience: Audience;
  directory: Directory;
  names: { company: string; divisions: Map<string, string> };
  chats: Map<string, OwnerChannel>;
  now: Date;
  linkFor: NoticeLinkFor | null;
}

/** One claimed notice: checked as the person, held to their daily number, and sent. */
async function deliver(companyId: string, row: DueRow, context: Context): Promise<Outcome> {
  const person = context.audience.people.get(row.principal);
  // Not told any more: a seat ended, a link ended, the owner turned people off.
  if (!person || !person.channels.some((one) => one.channel === row.channel)) return { settled: 'gone' };
  const chat = row.channel.startsWith('relay:') ? null : context.chats.get(row.channel) ?? null;
  if (!row.channel.startsWith('relay:') && (!chat || row.principal !== 'owner')) return { settled: 'gone' };
  const seat = context.directory.get(row.principal);
  const as: Person = row.principal === 'owner' ? { principal: 'owner', name: null } : { principal: row.principal, name: seat?.name ?? '' };
  if (row.principal !== 'owner' && !seat?.live) return { settled: 'gone' };
  const language = person.prefs.language ?? context.audience.language;

  const subject = await withPeople(companyId, as, (tx) => readSubject(tx, row, as, language, context));
  if (subject.state !== 'ok') return { settled: subject.state };

  const today = localTime(context.now, person.prefs.timezone).date;
  const yesterday = localTime(new Date(context.now.getTime() - 86_400_000), person.prefs.timezone).date;
  const { rows: [counted] } = await withDelivery(companyId, (tx) => tx.query<{ today: number; capped: number }>(
    `SELECT count(*) FILTER (WHERE day = $3::date AND settled_as = 'sent')::int AS today,
            count(*) FILTER (WHERE day = $4::date AND settled_as = 'capped')::int AS capped
       FROM people_notices WHERE principal = $1 AND channel = $2 AND day IN ($3::date, $4::date)`,
    [row.principal, row.channel, today, yesterday]));
  if (counted!.today >= person.prefs.perDay) return { settled: 'capped', day: today };
  // The day's first says how many the day before went past the person's number.
  const more = counted!.today === 0 && counted!.capped > 0 ? `\n${moreYesterdaySaid(language, counted!.capped)}` : '';
  const said = Object.fromEntries((['signal', 'summary', 'content'] as const).map((share) => [
    share, { text: `${subject.said[share].text}${more}`, data: subject.said[share].data },
  ])) as Record<'signal' | 'summary' | 'content', Said>;
  const link = context.linkFor?.(subject.target) ?? null;

  if (chat) {
    // The owner's own chat: who and where, and a link, with nothing to press.
    await chat.deliverPeopleNotice!({ companyId, text: said.summary.text, url: link, language });
    return { settled: 'sent', day: today };
  }
  const sent = await relayPeopleNotice(row.channel.slice('relay:'.length), {
    id: row.id, companyId, principal: row.principal, type: subject.type, subjects: subject.subjects, language, link, said,
    ...(subject.room ? { room: subject.room } : {}), ...(subject.item ? { item: subject.item } : {}),
    ...(subject.words ? { words: subject.words } : {}),
  }, context.now);
  return sent === null ? { settled: 'gone' } : { settled: 'sent', day: today };
}

/** What a room is called in a notice: a topic room's name, the company's or its division's; a direct one has none. */
function roomLabel(room: { kind: string; name: string | null; division_id: string | null }, names: Context['names']): string | null {
  if (room.kind === 'direct') return null;
  if (room.kind === 'company') return names.company;
  if (room.kind === 'division') return names.divisions.get(room.division_id ?? '') ?? names.company;
  return room.name;
}

/**
 * A notice's subject, read in the person's own transaction: whatever they
 * may no longer see is not there, and the words are read only here.
 */
async function readSubject(tx: TenantClient, row: DueRow, as: Person, language: string, context: Context): Promise<Subject> {
  const [kind, id] = row.subject.split(':') as ['message' | 'item' | 'task' | 'meeting', string];
  const signal: Said = { text: somethingNewSaid(language), data: {} };

  if (kind === 'message') {
    const { rows: [message] } = await tx.query<{
      room_id: string; thread_of: string | null; author: string; author_name: string | null; body: string | null; deleted: boolean;
      room_kind: string; room_name: string | null; division_id: string | null; read_position: string | null; unseen: boolean;
    }>(
      `SELECT m.room_id, m.thread_of, m.author, m.author_name, m.body, m.deleted_at IS NOT NULL AS deleted,
              r.kind AS room_kind, r.name AS room_name, r.division_id,
              (SELECT p.read_position FROM room_places p WHERE p.room_id = m.room_id AND p.principal = $2) AS read_position,
              EXISTS (SELECT 1 FROM room_mentions n JOIN room_messages x ON x.company_id = n.company_id AND x.id = n.message_id
                       WHERE n.principal = $2 AND n.seen_at IS NULL AND n.reason IN ('mention', 'reply')
                         AND x.room_id = m.room_id AND x.position <= $3) AS unseen
         FROM room_messages m JOIN rooms r ON r.company_id = m.company_id AND r.id = m.room_id
        WHERE m.id = $1`,
      [id, as.principal, row.position]);
    // Not there for them: a room they were taken out of, or never could see.
    if (!message) return { state: 'gone' };
    // A window's first message deleted: alone, there is nothing to tell; with
    // others after it, they are told as how many, and the notice names no
    // message, so nothing waits on the one that went.
    if (message.deleted && row.count === 1) return { state: 'gone' };
    const position = Number(row.position);
    const read = row.reason === 'direct' ? Number(message.read_position ?? 0) >= position : !message.unseen;
    if (read) return { state: 'read' };
    const author = context.directory.refOf(message.author, message.author_name);
    const who = whoSaid(language, author);
    const room = roomLabel({ kind: message.room_kind, name: message.room_name, division_id: message.division_id }, context.names);
    const sentence = roomNoticeSaid(language, { reason: row.reason as RoomReason, who, room, count: row.count });
    const excerpt = message.deleted || message.body === null ? null : excerptOf(message.body);
    const reasons = [row.reason];
    const summary: Said = {
      text: sentence,
      data: { reasons, count: row.count, room, authors: [{ name: author.principal === 'owner' ? null : author.name, handle: author.handle }] },
    };
    return {
      state: 'ok', type: 'room_activity', subjects: message.deleted ? [] : [row.subject],
      said: {
        signal: { text: signal.text, data: { reasons, count: row.count } },
        summary,
        content: excerpt === null ? summary : { text: `${sentence}\n${excerpt}`, data: { ...summary.data, excerpt } },
      },
      target: { companyId: context.directory.companyId, roomId: message.room_id, threadOf: message.thread_of },
      room: { roomId: message.room_id, threadOf: message.thread_of, position, messageId: message.deleted ? null : id },
    };
  }

  if (kind === 'item') {
    const { rows: [item] } = await tx.query<{
      status: string; kind: string; tier: number | null; title: string; action_summary: string; addressee_seat: string | null;
      instigators: string[]; question: string | null; options: string[] | null; asker: string | null; expires_at: Date | null;
      team: boolean; owner_only: boolean;
    }>(
      `SELECT i.status, i.kind, i.tier, i.title, i.action_summary, i.addressee_seat::text AS addressee_seat,
              i.instigators::text[] AS instigators, i.expires_at, ${TEAM_SQL} AS team,
              coalesce((i.payload->>'ownerOnly')::boolean, false) AS owner_only,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->>'question' END AS question,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->'options' END AS options,
              ${askerOf('i')} AS asker
         FROM inbox_items i WHERE i.id = $1`, [id]);
    const seatId = as.principal.slice('seat:'.length);
    if (!item || item.status !== 'open') return { state: 'gone' };
    const question = row.reason === 'question';
    if (question ? item.addressee_seat !== seatId
      : !item.team || item.owner_only || item.instigators.includes(seatId) || !context.audience.approvers.has(as.principal)) {
      return { state: 'gone' };
    }
    // An approval's room is named only to someone who can see it: the
    // database shows the card's message to nobody else.
    let place: { room_id: string; thread_of: string | null; kind: string; name: string | null; division_id: string | null } | undefined;
    if (!question) {
      ({ rows: [place] } = await tx.query(
        `SELECT m.room_id, m.thread_of, r.kind, r.name, r.division_id
           FROM room_messages m JOIN rooms r ON r.company_id = m.company_id AND r.id = m.room_id
          WHERE m.kind = 'approval' AND m.inbox_item_id = $1 ORDER BY m.position LIMIT 1`, [id]));
    }
    const room = place ? roomLabel(place, context.names) : null;
    const title = redactor.redact(item.title);
    const sentence = question ? questionSaid(language, item.asker ?? context.names.company) : approvalSaid(language, room);
    const summary: Said = { text: sentence, data: { kind: item.kind, tier: item.tier, title } };
    const content: Said = {
      text: sentence,
      data: {
        ...summary.data, summary: redactor.redact(item.action_summary),
        ...(question ? { question: redactor.redact(item.question ?? ''), options: item.options ?? [], ...(item.asker ? { asker: item.asker } : {}) } : {}),
        ...(item.expires_at ? { expiresAt: item.expires_at.toISOString() } : {}),
      },
    };
    return {
      state: 'ok', type: 'inbox_item', subjects: [row.subject],
      said: { signal: { text: signal.text, data: { kind: item.kind, tier: item.tier } }, summary, content },
      target: { companyId: context.directory.companyId, itemId: id, ...(place ? { roomId: place.room_id, threadOf: place.thread_of } : {}) },
      // A question is the addressee's to answer while it is a member or an
      // approver; an approval was checked above. A press is read again.
      item: { id, question, options: item.options, tier: item.tier, expiresAt: item.expires_at,
        mayAct: !question || ['member', 'approver'].includes(context.directory.get(as.principal)?.kind ?? '') },
    };
  }

  if (kind === 'meeting') return meetingSubject(tx, row, as, language, context, id);

  const { rows: [task] } = await tx.query<{ status: string; goal: string | null; halt_reason: string | null; seat: string | null; summary: string | null }>(
    `SELECT status, input->>'goal' AS goal, halt_reason, requested_by_seat::text AS seat, output->>'summary' AS summary
       FROM tasks WHERE id = $1`, [id]);
  if (!task || task.seat !== as.principal.slice('seat:'.length) || !['completed', 'failed', 'halted'].includes(task.status)) {
    return { state: 'gone' };
  }
  const title = redactor.redact((task.goal ?? '').slice(0, 200));
  const sentence = workSaid(language, { done: task.status === 'completed', title, why: haltSaid(language, task.halt_reason) });
  const summary: Said = { text: sentence, data: { title } };
  return {
    state: 'ok', type: 'work_done', subjects: [row.subject],
    said: {
      signal, summary,
      content: task.summary ? { text: sentence, data: { title, summary: redactor.redact(task.summary.slice(0, 500)) } } : summary,
    },
    target: { companyId: context.directory.companyId, taskId: id },
  };
}

/**
 * A people's meeting about to start, read as the person reminded: gone when
 * they can no longer see its room or are no longer asked, when it was
 * cancelled, its words removed, moved since this reminder was planned
 * (reminded again for its new time, or to be, or moved later than a last
 * reminder said), or begun. It
 * says when and where above `signal`, and the setter's words, as its title,
 * only at `content`; it opens the meeting's thread, its notes. The relay
 * holds the title against a delete on its way, as a notice of words does.
 */
async function meetingSubject(tx: TenantClient, row: DueRow, as: Person, language: string, context: Context, id: string): Promise<Subject> {
  const { rows: [meeting] } = await tx.query<{
    room_id: string; message_id: string; starts_at: Date; minutes: number; attendees: string[]; cancelled: boolean;
    reminders: number; soon: boolean | null; body: string | null; deleted: boolean; room_kind: string; room_name: string | null;
    division_id: string | null;
  }>(
    `SELECT g.room_id, g.message_id, g.starts_at, g.minutes, g.attendees::text[] AS attendees, g.cancelled_at IS NOT NULL AS cancelled,
            g.reminders, ${stillSoon('g')} AS soon,
            m.body, m.deleted_at IS NOT NULL AS deleted, r.kind AS room_kind, r.name AS room_name, r.division_id
       FROM room_meetings g
       JOIN room_messages m ON m.company_id = g.company_id AND m.id = g.message_id
       JOIN rooms r ON r.company_id = g.company_id AND r.id = g.room_id
      WHERE g.id = $1`, [id]);
  if (!meeting || meeting.cancelled || meeting.deleted || meeting.starts_at <= context.now
    || !meeting.attendees.includes(as.principal)
    || meeting.soon !== true || row.window_key !== meetingKey(id, meeting.reminders)) {
    return { state: 'gone' };
  }
  const room = roomLabel({ kind: meeting.room_kind, name: meeting.room_name, division_id: meeting.division_id }, context.names);
  const sentence = meetingSoonSaid(language, room);
  const summary: Said = { text: sentence, data: { room, startsAt: meeting.starts_at.toISOString(), minutes: meeting.minutes } };
  const title = meeting.body === null ? null : excerptOf(meeting.body);
  return {
    state: 'ok', type: 'meeting_soon', subjects: [row.subject, `message:${meeting.message_id}`], words: meeting.message_id,
    said: {
      signal: { text: meetingSoonSaid(language, null), data: {} },
      summary,
      content: title === null ? summary : { text: `${sentence}\n${title}`, data: { ...summary.data, title } },
    },
    target: { companyId: context.directory.companyId, roomId: meeting.room_id, threadOf: meeting.message_id },
  };
}

/** The first words of a message, redacted, at most 140 characters. */
function excerptOf(body: string): string {
  const words = redactor.redact(body).replace(/\s+/g, ' ').trim();
  return words.length <= EXCERPT_CHARS ? words : `${words.slice(0, EXCERPT_CHARS - 1)}…`;
}
