/**
 * People's meetings (F19.26; STATUS section 2.215): people meet people.
 *
 * Anyone who may write in a room sets a meeting there from their own words
 * at the top of it: those words are its title and agenda, and its thread is
 * the notes. It has a time, a length of 5 to 480 minutes, the people asked --
 * who must be able to see the room: a private room's members, a direct
 * conversation's people, or anyone of the company for an open room -- and,
 * when someone pastes one, a call link, which is `https://` and is never
 * fetched or unfurled here. Its setter or the owner moves it, changes who is
 * asked, or cancels it. One message is a people's meeting or work, never
 * both: a meeting's thread is its notes, and agents neither see nor attend it.
 *
 * It is not work. Nothing here makes a task, reaches a run or writes an
 * event: a meeting is a row beside its message, read and written as the
 * person through `withPeople`, so the database's rule on who sees which
 * room (0150) and on who sets and changes a meeting (STATUS 2.215) holds
 * whatever a handler forgets. The people asked are reminded ten minutes
 * before it starts, by the rooms' sweep (`cards.ts`) and through people's
 * notices (`src/owner/member-notify.ts`).
 */
import { withPeople, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { holdToMinute } from './limits.ts';
import type { PeopleMeetingView } from './contract.ts';
import { messageIdOf, messageIn } from './messages.ts';
import { assertPeopleOf, isPerson } from './principal.ts';
import { assertMember, ensureCompanyMember, takeClock, visibleRoom } from './rooms.ts';
import { directoryOf, peopleMeetingsOf, type Directory, type Viewer } from './views.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How long a meeting may be, in minutes, as the table holds it (STATUS 2.215). */
const MEETING_MINUTES = { least: 5, most: 480 } as const;
/** How many people one meeting asks. */
const ATTENDEES_MOST = 50;
/** The longest call link, as the table holds it. */
const CALL_URL_MOST = 2_000;
/** How far ahead a meeting may be set: a year and a day, so next year's same day is in reach. */
const AHEAD_DAYS_MOST = 366;

/** A meeting's id from a path: an id, or a meeting of no room. */
function meetingIdOf(value: string | undefined): string {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new PalugadaError('contract.violation', 'that is not a meeting of this room', { meetingId: value ?? null });
  return id;
}

/** When a meeting starts: an ISO time in the future, within a year and a day. */
function startOf(value: unknown, now: Date): Date {
  const at = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new PalugadaError('contract.violation', 'startsAt is a time, written as ISO 8601', { field: 'startsAt' });
  }
  if (at.getTime() <= now.getTime()) {
    throw new PalugadaError('people_meeting.past', 'a meeting starts in the future', { field: 'startsAt' });
  }
  if (at.getTime() > now.getTime() + AHEAD_DAYS_MOST * 86_400_000) {
    throw new PalugadaError('contract.violation', `a meeting is set at most ${AHEAD_DAYS_MOST} days ahead`, { field: 'startsAt' });
  }
  return at;
}

/** How long a meeting is: a whole number of minutes, 5 to 480. */
function minutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MEETING_MINUTES.least || value > MEETING_MINUTES.most) {
    throw new PalugadaError('contract.violation',
      `minutes is a whole number from ${MEETING_MINUTES.least} to ${MEETING_MINUTES.most}`, { field: 'minutes' });
  }
  return value;
}

/** The people asked, as written: one to fifty people, the owner or seats, each once. */
function attendeesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ATTENDEES_MOST || !value.every((one) => typeof one === 'string')) {
    throw new PalugadaError('contract.violation', `attendees is a list of 1 to ${ATTENDEES_MOST} people`, { field: 'attendees' });
  }
  const strangers = value.filter((one) => !isPerson(one));
  if (strangers.length > 0) {
    throw new PalugadaError('contract.violation',
      `attendees names people, the owner or a seat ('owner' or 'seat:<id>'), never ${strangers.join(', ')}`, { field: 'attendees' });
  }
  return [...new Set(value as string[])];
}

/** A control character, C0 or C1: nobody pastes one in a link, and a NUL cannot even be stored. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A pasted call link, or none: `https://` and at most 2,000 characters, with
 * no space and no control character in it, kept as it was pasted. It is
 * shown as a plain link, opened in a new tab with no opener and no referrer,
 * and never fetched here.
 */
function callUrlOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value.trim() : null;
  if (text === '') return null;
  let parsed: URL | null = null;
  try {
    parsed = text === null ? null : new URL(text);
  } catch {
    parsed = null;
  }
  if (text === null || parsed === null || parsed.protocol !== 'https:' || parsed.hostname === ''
    || !/^https:\/\/\S+$/.test(text) || CONTROL.test(text) || text.length > CALL_URL_MOST) {
    throw new PalugadaError('contract.violation',
      `a call link is an https:// address of at most ${CALL_URL_MOST} characters, with no space in it`, { field: 'callUrl' });
  }
  return text;
}

/**
 * A refusal the database gave, said in the words the console explains (the
 * meetings table's named checks). Who may be asked is the database's to
 * say, and only its: everyone of the company in the company's room, a
 * division's and an open topic room; a private room's members and the
 * owner; a direct conversation's people alone -- the rule every room table
 * holds (0150), so a meeting cannot ask someone a room would not show.
 */
function refusal(error: unknown): unknown {
  const constraint = (error as { constraint?: string }).constraint;
  if (constraint === 'room_meetings_starts_ahead') {
    return new PalugadaError('people_meeting.past', 'a meeting starts in the future', { field: 'startsAt' });
  }
  if (constraint === 'room_meetings_attendees_see') {
    return new PalugadaError('people_meeting.cannot_see', 'everyone asked must be able to see the room', { field: 'attendees' });
  }
  return error;
}

/** One meeting as the reader sees it, read again after a change. */
async function shown(tx: TenantClient, viewer: Viewer, directory: Directory, messageId: string): Promise<PeopleMeetingView> {
  const meeting = (await peopleMeetingsOf(tx, viewer, directory, [messageId])).get(messageId);
  if (!meeting) throw new PalugadaError('contract.violation', 'that message carries no meeting', { messageId });
  return meeting;
}

/**
 * Sets a meeting from the person's own message at the top of a room they
 * may write in. Pressed again for the same message, it is the meeting
 * already set, as a retried post is the message already kept.
 */
export async function setPeopleMeeting(viewer: Viewer, roomId: string, body: Record<string, unknown>): Promise<PeopleMeetingView> {
  const messageId = messageIdOf(typeof body.messageId === 'string' ? body.messageId : undefined);
  const now = new Date();
  const startsAt = startOf(body.startsAt, now);
  const minutes = minutesOf(body.minutes);
  const callUrl = callUrlOf(body.callUrl);
  const attendees = attendeesOf(body.attendees);
  holdToMinute(viewer, 'meeting');
  // A revoked seat, or one of another company, is nobody here to ask.
  await assertPeopleOf(viewer.companyId, attendees);
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.archived_at) throw new PalugadaError('room.archived', 'that room is archived', { roomId });
    await ensureCompanyMember(tx, viewer, room);
    assertMember(room);
    // The clock first, as every room write takes it: two presses of the same
    // message read one after the other, and the second finds the first's.
    await takeClock(tx);
    const message = await messageIn(tx, roomId, messageId, { lock: true });
    if (message.kind !== 'text' || message.author !== viewer.person.principal) {
      throw new PalugadaError('message.not_yours', 'a meeting is set from your own words', { messageId });
    }
    if (message.deleted_at) throw new PalugadaError('contract.violation', 'that message was removed', { messageId });
    if (message.thread_of !== null) {
      throw new PalugadaError('contract.violation',
        'a meeting is set from a message at the top of a room: its thread is the notes', { messageId });
    }
    // Words given as work, or a meeting of agents called about them, have
    // their thread already: the work's.
    if (message.became !== null) {
      throw new PalugadaError('contract.violation', 'that message already became work: a meeting is set from words of its own', { messageId });
    }
    const { rows: already } = await tx.query('SELECT 1 FROM room_meetings WHERE message_id = $1', [messageId]);
    if (already.length > 0) return shown(tx, viewer, directory, messageId);
    try {
      // No RETURNING: the row is read back as the reader, after the guard
      // has written who set it (STATUS 2.215).
      await tx.query(
        `INSERT INTO room_meetings (company_id, room_id, message_id, starts_at, minutes, attendees, call_url, set_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [viewer.companyId, roomId, messageId, startsAt, minutes, attendees, callUrl, viewer.person.principal]);
    } catch (error) {
      throw refusal(error);
    }
    return shown(tx, viewer, directory, messageId);
  });
}

/**
 * Moves a meeting, changes how long it is, who is asked or its link, or
 * cancels it: its setter's, or the owner's. Only what the change names
 * changes, so a meeting under way keeps its time while its link is fixed. A
 * meeting moved after its reminder is reminded again for its new time, once
 * (STATUS 2.215); a cancelled one stays cancelled, and reminds nobody.
 */
export async function changePeopleMeeting(
  viewer: Viewer, roomId: string, meetingIdText: string | undefined, body: Record<string, unknown>,
): Promise<PeopleMeetingView> {
  const meetingId = meetingIdOf(meetingIdText);
  const now = new Date();
  const cancel = body.cancel === true;
  if (body.cancel !== undefined && typeof body.cancel !== 'boolean') {
    throw new PalugadaError('contract.violation', 'cancel is true to cancel the meeting', { field: 'cancel' });
  }
  const startsAt = body.startsAt === undefined ? undefined : startOf(body.startsAt, now);
  const minutes = body.minutes === undefined ? undefined : minutesOf(body.minutes);
  const callUrl = body.callUrl === undefined ? undefined : callUrlOf(body.callUrl);
  const attendees = body.attendees === undefined ? undefined : attendeesOf(body.attendees);
  holdToMinute(viewer, 'meeting');
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (room.archived_at) throw new PalugadaError('room.archived', 'that room is archived', { roomId });
    await takeClock(tx);
    const { rows } = await tx.query<{ message_id: string; set_by: string; attendees: string[]; cancelled: boolean; removed: boolean }>(
      `SELECT g.message_id, g.set_by, g.attendees::text[] AS attendees, g.cancelled_at IS NOT NULL AS cancelled,
              m.deleted_at IS NOT NULL AS removed
         FROM room_meetings g JOIN room_messages m ON m.company_id = g.company_id AND m.id = g.message_id
        WHERE g.id = $1 AND g.room_id = $2 FOR UPDATE OF g`, [meetingId, roomId]);
    const meeting = rows[0];
    if (!meeting) throw new PalugadaError('contract.violation', 'that is not a meeting of this room', { meetingId });
    if (meeting.set_by !== viewer.person.principal && viewer.kind !== 'owner') {
      throw new PalugadaError('message.not_yours', 'a meeting is changed by whoever set it, or the owner', { meetingId });
    }
    if (meeting.cancelled) throw new PalugadaError('contract.violation', 'that meeting was cancelled', { meetingId });
    if (meeting.removed) throw new PalugadaError('contract.violation', 'the message that set that meeting was removed', { meetingId });
    // Only those asked anew must be the company's people now: whoever was
    // asked stays on the list though their seat has gone, as the database
    // asks only those added whether they can see the room (STATUS 2.215),
    // so a change made with the whole list, as the console makes it, is not
    // refused for someone nobody added.
    if (attendees !== undefined) {
      const added = attendees.filter((principal) => !meeting.attendees.includes(principal));
      if (added.length > 0) await assertPeopleOf(viewer.companyId, added);
    }
    const changes: string[] = [];
    const values: unknown[] = [meetingId];
    const set = (column: string, value: unknown) => {
      values.push(value);
      changes.push(`${column} = $${values.length}`);
    };
    if (startsAt !== undefined) set('starts_at', startsAt);
    if (minutes !== undefined) set('minutes', minutes);
    if (attendees !== undefined) set('attendees', attendees);
    if (callUrl !== undefined) set('call_url', callUrl);
    // Who cancelled it is whoever's transaction this is, as the guard writes it.
    if (cancel) set('cancelled_at', now);
    if (changes.length > 0) {
      try {
        await tx.query(`UPDATE room_meetings SET ${changes.join(', ')} WHERE id = $1`, values);
      } catch (error) {
        throw refusal(error);
      }
    }
    return shown(tx, viewer, directory, meeting.message_id);
  });
}
