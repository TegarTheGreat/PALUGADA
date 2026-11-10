/**
 * What a message may become, by a press (F19.5, F19.6, F19.7, F19.8, F19.9;
 * STATUS section 2.206): work, through the door the owner's own assignments
 * use; an instruction to that work; and its stop. And a meeting of the
 * company's agents about it, called by the owner or an approver (F19.18;
 * STATUS section 2.211).
 *
 * Words in a room start nothing on their own: not a mention, not a reaction,
 * not what they say. Each door is a person pressing, recorded as that person,
 * in one transaction with the mark on the message, so a message is work only
 * if the work exists, and the work exists only with its money held.
 *
 * Whose words they are is said as it is. The owner's own, typed in the
 * console, are the owner's work. A seat's are staff work whoever presses, and
 * the seat that pressed is named; a seat whose words someone else pressed is
 * carried with the work as quoted. A message that came through a relay, or
 * from an import, is nobody's own words here and is carried as outside
 * content (F8.9); a seat's that came through a relay are carried as the
 * seat's as well. And the journal every seat reads never names a private or
 * a direct room: the link from the work to its message lives on the message.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withPeople, withTenant, type Person, type TenantClient } from '../db/tenant.ts';
import { adHocBriefFor, lastWeeklyDayOf, meetingDayOf, meetingSeatOf, ROOM_MEETING_KEY, startMeetingWithin } from '../engine/meeting.ts';
import { cancelTask, instructTaskWithin, type Author } from '../engine/owner-control.ts';
import { createRootTaskWithin, UNNAMED_STAFF } from '../engine/tasks.ts';
import { isPalugadaError, PalugadaError } from '../errors.ts';
import { ceoOf } from '../governance/ceo.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';
import { enqueueWake } from '../scheduler/wake.ts';
import { postNotice, type NoticeCode } from './cards.ts';
import { messageIn } from './messages.ts';
import { seatOf } from './principal.ts';
import { takeClock, visibleRoom, type RoomRecord } from './rooms.ts';
import { mayAsk, mayDecide, type Viewer } from './views.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The longest goal a press gives its work. */
export const GOAL_MAX = 2_000;
/** Instructions and meetings a seat's own words begin count as asks; its pressed work counts by its row. */
const COUNTED_HOWS = ['instructed', 'meeting'];

/** The longest topic a meeting is called about: it is told to the meeting as an instruction is. */
const TOPIC_MAX = 2_000;
/** Meetings a company may call from its rooms in a day: each is a paid run of the CEO (F19.18). */
const MEETINGS_PER_DAY = 3;

/** Fields a press never takes from a body: the division and its money are the target role's (F19.8). */
const NOT_FROM_A_BODY = ['divisionId', 'budgetAccountId', 'reserveTokens'];

/** How a refusal of the work door is said in the message's thread, so no ask is ever silent. */
function noticeFor(error: unknown): NoticeCode | null {
  if (!isPalugadaError(error)) return null;
  switch (error.code) {
    case 'spend.paused': return 'held_paused';
    case 'role.frozen': return 'refused_frozen';
    case 'role.incomplete': return 'refused_incomplete';
    case 'budget.reservation_refused': return 'refused_budget';
    case 'goal.closed': case 'goal.required': return 'refused_goal';
    case 'contract.violation': return error.details.field === 'projectId' ? 'refused_project' : null;
    default: return null;
  }
}

/** The seat behind a viewer, as an author of words to a task. */
function seatAuthor(viewer: Viewer): Author & { kind: 'seat' } {
  return { kind: 'seat', seatId: viewer.seatId!, name: viewer.person.name! };
}

/** Where a seat's words were given, as the journal may name it: a room by its id only when everyone may see it. */
function placeOf(room: RoomRecord, messageId: string): { roomId?: string; messageId?: string; room?: 'private' } {
  return room.private ? { room: 'private' } : { roomId: room.id, messageId };
}

/**
 * A seat's asks in the last day, and when the first of them stops counting:
 * the work it pressed for, by the task's row, and the instructions and
 * meetings its words began, by their mark. Read from the work, never from
 * the rooms, so leaving a room hides nothing. Taken under a lock of the
 * seat's own, so parallel presses at its last ask make one piece of work.
 */
async function asksToday(tx: TenantClient, viewer: Viewer, limit: number): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('asks:' || $1 || ':' || $2, 0))", [viewer.companyId, viewer.seatId]);
  const { rows } = await tx.query<{ n: number; first: Date | null }>(
    `SELECT count(*)::int AS n, min(at) AS first FROM (
       SELECT created_at AS at FROM tasks WHERE requested_by_seat = $1::text::uuid AND created_at > now() - interval '24 hours'
       UNION ALL
       SELECT occurred_at FROM events
        WHERE type = 'content.staff_said' AND payload->>'seatId' = $1 AND payload->>'how' = ANY($2::text[])
          AND occurred_at > now() - interval '24 hours'
     ) asks`,
    [viewer.seatId, COUNTED_HOWS]);
  if (rows[0]!.n >= limit) {
    const opensAt = new Date((rows[0]!.first ?? new Date()).getTime() + 24 * 60 * 60 * 1000);
    throw new PalugadaError('staff.ask_limit',
      `you have asked for ${limit} pieces of work today; the next opens at ${opensAt.toISOString()}`, { limit, opensAt: opensAt.toISOString() });
  }
}

/** A seat's daily number of asks, as the owner set it (0149). */
async function asksPerDay(viewer: Viewer): Promise<number> {
  const { rows } = await withControlPlane((tx) => tx.query<{ asks_per_day: number }>(
    'SELECT asks_per_day FROM staff_seats WHERE id = $1 AND company_id = $2', [viewer.seatId, viewer.companyId]));
  return rows[0]?.asks_per_day ?? 0;
}

/** A role's name as the owner calls it, for a notice; empty when it is not known. */
async function roleCalled(companyId: string, roleId: string | null): Promise<string> {
  if (!roleId) return '';
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ name: string }>(
    'SELECT coalesce(display_name, slug) AS name FROM roles WHERE id = $1', [roleId]));
  return rows[0]?.name ?? '';
}

/**
 * "Give as work" (F19.5, F19.8): the message becomes a root task for the
 * role the press names, or the company's CEO. The division and its money are
 * the role's; a body that names either is refused. Pressed twice, it is the
 * same work. Refused -- a paused month, a frozen role, no money -- the
 * message stays words that can be given later, and its thread says why.
 */
export async function giveAsWork(viewer: Viewer, roomId: string, messageId: string, body: Record<string, unknown>): Promise<{ taskId: string }> {
  if (!mayAsk(viewer)) throw new PalugadaError('staff.forbidden', 'a viewer reads and talks; asking for work is a member\'s', {});
  for (const field of NOT_FROM_A_BODY) {
    if (body[field] !== undefined) {
      throw new PalugadaError('contract.violation', `${field} is the target role's, never the press's: name the role, and its division pays`, { field });
    }
  }
  const target = typeof body.target === 'string' ? body.target : '';
  if (target !== 'company' && !UUID.test(target)) {
    throw new PalugadaError('contract.violation', "target is 'company', for the CEO, or a role's id", { field: 'target' });
  }
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (goal.length < 1 || goal.length > GOAL_MAX) {
    throw new PalugadaError('contract.violation', `goal says what the work is for, in 1 to ${GOAL_MAX} characters`, { field: 'goal' });
  }
  const goalId = typeof body.goalId === 'string' && UUID.test(body.goalId) ? body.goalId : null;
  if (!goalId) throw new PalugadaError('contract.violation', 'goalId names the goal the work serves', { field: 'goalId' });
  const projectId = body.projectId === undefined || body.projectId === null || body.projectId === '' ? null : String(body.projectId);
  if (projectId !== null && !UUID.test(projectId)) throw new PalugadaError('contract.violation', 'projectId is a project of the company', { field: 'projectId' });
  const priority = body.priority === undefined || body.priority === null || body.priority === '' ? undefined : Number(body.priority);
  if (priority !== undefined && !(Number.isInteger(priority) && priority >= 0 && priority <= 3)) {
    throw new PalugadaError('contract.violation', 'priority is 0 to 3', { field: 'priority' });
  }
  const limit = viewer.seatId !== null ? await asksPerDay(viewer) : 0;
  const paused = await isSpendPaused(viewer.companyId);

  // The role the press names, once it is known: a refusal's notice names it.
  const named: { roleId: string | null } = { roleId: null };
  let made: { taskId: string; fresh: boolean };
  try {
    made = await withPeople(viewer.companyId, viewer.person, async (tx) => {
      const room = await visibleRoom(tx, viewer, roomId);
      if (viewer.seatId !== null) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('asks:' || $1 || ':' || $2, 0))", [viewer.companyId, viewer.seatId]);
      await takeClock(tx);
      const message = await messageIn(tx, roomId, messageId, { lock: true });
      if (message.became === 'work' && message.task_id) return { taskId: message.task_id, fresh: false };
      if (message.kind !== 'text' || message.deleted_at || message.became !== null) {
        throw new PalugadaError('contract.violation', 'only a person\'s words become work, once', { messageId });
      }
      // Work begins a thread of its own: its cards, its notices and what is
      // told to it are replies to it, and a thread is one level deep (0150).
      // Asked before anything that could refuse it with a notice, which
      // would have no thread to go in.
      if (message.thread_of !== null) {
        throw new PalugadaError('contract.violation',
          'a reply is not given as work: give the message its thread began with, or say it again at the top of the room', { messageId });
      }
      if (viewer.seatId !== null) await asksToday(tx, viewer, limit);

      const role = target === 'company' ? await ceoOf(tx, viewer.companyId) : null;
      const { rows: roles } = await tx.query<{ id: string; division_id: string }>(
        'SELECT id, division_id FROM roles WHERE id = $1', [role?.id ?? target]);
      if (!roles[0]) {
        throw new PalugadaError('contract.violation', target === 'company' ? 'the company has no CEO to ask yet' : 'no such role in this company', { field: 'target' });
      }
      named.roleId = roles[0].id;
      // Projects belong to the company, not to a division, so a press that
      // names none takes the company's oldest project still open; a named
      // one that is archived is refused by the door itself.
      const { rows: projects } = await tx.query<{ id: string }>(
        projectId ? 'SELECT id FROM projects WHERE id = $1'
          : 'SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at, id LIMIT 1',
        projectId ? [projectId] : []);
      if (!projects[0]) {
        throw new PalugadaError('contract.violation', projectId
          ? 'that project is not one of this company\'s'
          : 'the company has no open project to put the work in: open one under Projects, or name one', { field: 'projectId' });
      }
      if (paused) throw new PalugadaError('spend.paused', 'company has reached its monthly spending ceiling and is not taking new work', {});

      const author = message.author;
      const outside = message.via === 'relay' ? 'a message posted through a relay' : message.via === 'import' ? 'an imported message' : null;
      const authorSeat = author.startsWith('seat:') ? seatOf(author) : null;
      // The owner's work only when the owner pressed their own words, typed
      // here; a seat's words are staff work whoever pressed them, and
      // wherever they were typed: through a relay they are outside words
      // and still the seat's.
      const createdBy = viewer.seatId !== null || authorSeat !== null ? 'staff' : 'owner';
      const task = await createRootTaskWithin(tx, {
        companyId: viewer.companyId,
        projectId: projects[0].id,
        divisionId: roles[0].division_id,
        roleId: roles[0].id,
        goalId,
        input: { goal },
        createdBy,
        ...(viewer.seatId !== null ? { requestedBySeat: viewer.seatId } : {}),
        ...(outside ? { carriesOutside: { capability: outside, source: 'room' } } : {}),
        // Pressed by someone else, the words are still the seat's: carried
        // with the work, by the name they were written under, so the seat
        // decides none of what they begin (four eyes, STATUS 2.204).
        ...(authorSeat !== null && authorSeat !== viewer.seatId
          ? { carriesStaff: { from: 'room' as const, staff: [{ seatId: authorSeat, name: message.author_name ?? UNNAMED_STAFF }] } }
          : {}),
        ...(priority !== undefined ? { priority } : {}),
        idempotencyKey: `room:${messageId}`,
      });
      const by = viewer.person.principal;
      const asStaff = viewer.seatId !== null ? { staff: { seatId: viewer.seatId, name: viewer.person.name } } : {};
      await appendEvent(tx, {
        companyId: viewer.companyId, projectId: task.projectId, taskId: task.id, type: 'task.given_in_room',
        actor: viewer.seatId !== null ? 'staff' : 'owner',
        payload: { ...placeOf(room, messageId), by, author: outside ? message.via : author, ...asStaff },
      });
      if (viewer.seatId !== null) {
        await appendEvent(tx, {
          companyId: viewer.companyId, projectId: task.projectId, taskId: task.id, type: 'content.staff_said', actor: 'staff',
          payload: { seatId: viewer.seatId, name: viewer.person.name, how: 'began' },
        });
      }
      await tx.query(
        "UPDATE room_messages SET became = 'work', became_by = $2, became_at = now(), task_id = $3 WHERE id = $1",
        [messageId, by, task.id]);
      return { taskId: task.id, fresh: true };
    });
  } catch (error) {
    const code = noticeFor(error);
    if (code) await postNotice(viewer.companyId, roomId, messageId, code, { role: await roleCalled(viewer.companyId, named.roleId) });
    throw error;
  }
  const roleId = named.roleId;
  if (made.fresh && roleId) {
    // As an assignment does (`assignTask`): the role is woken now, by whoever pressed.
    await withTenant(viewer.companyId, (tx) => tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [roleId]));
    await enqueueWake({
      companyId: viewer.companyId, roleId, reason: 'assignment',
      detail: `${viewer.seatId !== null ? 'staff' : 'owner'} gave a room's message as task ${made.taskId}`,
      assignedBy: viewer.seatId !== null ? 'staff' : 'owner',
    });
  }
  return { taskId: made.taskId };
}

/**
 * "Call a meeting" (F19.18): the company's CEO holds a meeting about one
 * message, as the integrator holds the weekly one, against the same facts --
 * one task, keyed apart from the weekly meeting (`room-meeting:<message>`),
 * which files no weekly issue and which no reader of the weekly meeting sees.
 * The owner's or an approver's, counted among a seat's asks, and at most
 * three a company a day, since each is a paid run. Made in one transaction
 * with the message's mark and the money it holds, or not at all; the topic is
 * what the caller told it, as theirs: the owner's word, or a seat's inside
 * its fence. The owner who calls one attends it. Refused for what the work
 * door refuses -- a paused month, a paused CEO, no money -- the message stays
 * words, and its thread says why.
 */
export async function callMeetingFromRoom(viewer: Viewer, roomId: string, messageId: string, body: Record<string, unknown>): Promise<{ taskId: string }> {
  if (!mayDecide(viewer)) {
    throw new PalugadaError('staff.forbidden', 'calling a meeting of the company\'s agents is the owner\'s or an approver\'s', {});
  }
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (topic.length < 1 || topic.length > TOPIC_MAX) {
    throw new PalugadaError('contract.violation', `topic says what the meeting is about, in 1 to ${TOPIC_MAX} characters`, { field: 'topic' });
  }
  const limit = viewer.seatId !== null ? await asksPerDay(viewer) : 0;
  const paused = await isSpendPaused(viewer.companyId);
  const named: { roleId: string | null } = { roleId: null };
  let made: { taskId: string; fresh: boolean };
  try {
    made = await withPeople(viewer.companyId, viewer.person, async (tx) => {
      const room = await visibleRoom(tx, viewer, roomId);
      if (viewer.seatId !== null) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('asks:' || $1 || ':' || $2, 0))", [viewer.companyId, viewer.seatId]);
      // The company's own count, under a lock of its own: parallel calls at
      // the day's third make one meeting.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('room-meetings:' || $1, 0))", [viewer.companyId]);
      await takeClock(tx);
      const message = await messageIn(tx, roomId, messageId, { lock: true });
      if (message.became === 'meeting' && message.task_id) return { taskId: message.task_id, fresh: false };
      if (message.kind !== 'text' || message.deleted_at || message.became !== null) {
        throw new PalugadaError('contract.violation', 'only a person\'s words, not yet given as work, are called a meeting about, once', { messageId });
      }
      // The meeting's questions and record are replies to the message, and
      // a thread is one level deep (0150).
      if (message.thread_of !== null) {
        throw new PalugadaError('contract.violation',
          'a reply is not called a meeting about: call it about the message its thread began with, or say it again at the top of the room', { messageId });
      }
      if (viewer.seatId !== null) await asksToday(tx, viewer, limit);
      const { rows: called } = await tx.query<{ n: number; first: Date | null }>(
        `SELECT count(*)::int AS n, min(created_at) AS first FROM tasks
          WHERE idempotency_key LIKE '${ROOM_MEETING_KEY}%' AND created_at > now() - interval '24 hours'`);
      if (called[0]!.n >= MEETINGS_PER_DAY) {
        const opensAt = new Date((called[0]!.first ?? new Date()).getTime() + 24 * 60 * 60 * 1000);
        throw new PalugadaError('meeting.too_many',
          `${MEETINGS_PER_DAY} meetings have been called today; the next can be called at ${opensAt.toISOString()}`,
          { limit: MEETINGS_PER_DAY, opensAt: opensAt.toISOString() });
      }
      if (paused) throw new PalugadaError('spend.paused', 'company has reached its monthly spending ceiling and is not taking new work', {});
      const seat = await meetingSeatOf(tx, viewer.companyId);
      if ('missing' in seat) {
        switch (seat.missing) {
          case 'frozen': throw new PalugadaError('role.frozen', 'the CEO is paused: resume it to hold a meeting', {});
          case 'mission': throw new PalugadaError('goal.required', 'the company has no open mission for a meeting to serve', {});
          case 'project':
            throw new PalugadaError('contract.violation', 'the company has no open project to put the meeting\'s work in: open one under Projects', { field: 'projectId' });
          default: throw new PalugadaError('contract.violation', 'the company has no CEO to hold a meeting yet', {});
        }
      }
      named.roleId = seat.roleId;

      const author = message.author;
      const outside = message.via === 'relay' ? 'a message posted through a relay' : message.via === 'import' ? 'an imported message' : null;
      const authorSeat = author.startsWith('seat:') ? seatOf(author) : null;
      const { rows: company } = await tx.query<{ minutes: number }>(
        'SELECT meeting_join_minutes AS minutes FROM companies WHERE id = $1', [viewer.companyId]);
      const now = new Date();
      const taskId = await startMeetingWithin(tx, viewer.companyId, {
        key: `${ROOM_MEETING_KEY}${messageId}`,
        ...await meetingDayOf(tx, viewer.companyId, now),
        now,
        // Read only: the weekly meeting's own count of to-dos not done is
        // the weekly meeting's, and a called meeting files none of it.
        previousDay: await lastWeeklyDayOf(tx, viewer.companyId),
        filed: { offTrack: [], notDoneTwice: [] },
        seat,
        brief: adHocBriefFor,
        // The owner who calls a meeting attends it (F19.17).
        ownerJoins: viewer.seatId === null ? { minutes: company[0]!.minutes } : null,
        // The message the meeting is about is carried as the work door
        // carries it: outside words from a relay or an import, and a seat's
        // words someone else pressed, quoted (STATUS 2.206).
        ...(outside ? { carriesOutside: { capability: outside, source: 'room' as const } } : {}),
        ...(authorSeat !== null && authorSeat !== viewer.seatId
          ? { carriesStaff: { from: 'room' as const, staff: [{ seatId: authorSeat, name: message.author_name ?? UNNAMED_STAFF }] } }
          : {}),
      });
      // The topic, as the caller's own words: a seat's is fenced and marked
      // as the meeting it began, which counts once among its asks.
      const by: Author = viewer.seatId !== null ? seatAuthor(viewer) : { kind: 'owner' };
      await instructTaskWithin(tx, viewer.companyId, taskId, topic, by, { via: 'meeting', ...placeOf(room, messageId) });
      const principal = viewer.person.principal;
      await appendEvent(tx, {
        companyId: viewer.companyId, taskId, type: 'meeting.called', actor: viewer.seatId !== null ? 'staff' : 'owner',
        payload: { ...placeOf(room, messageId), by: principal },
      });
      await tx.query(
        "UPDATE room_messages SET became = 'meeting', became_by = $2, became_at = now(), task_id = $3 WHERE id = $1",
        [messageId, principal, taskId]);
      return { taskId, fresh: true };
    });
  } catch (error) {
    const code = noticeFor(error);
    if (code) await postNotice(viewer.companyId, roomId, messageId, code, { role: await roleCalled(viewer.companyId, named.roleId) });
    throw error;
  }
  const roleId = named.roleId;
  if (made.fresh && roleId) {
    // As the work door does: the CEO is woken now, by whoever called it.
    await withTenant(viewer.companyId, (tx) => tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [roleId]));
    await enqueueWake({
      companyId: viewer.companyId, roleId, reason: 'assignment',
      detail: `${viewer.seatId !== null ? 'staff' : 'owner'} called meeting ${made.taskId} about a room's message`,
      assignedBy: viewer.seatId !== null ? 'staff' : 'owner',
    });
  }
  return { taskId: made.taskId };
}

/**
 * The work a thread carries, and the seat that pressed for it: work given
 * from its message, a meeting called about it (the seat that called it), or
 * the weekly meeting's card, which no seat pressed for (STATUS 2.211).
 */
async function threadWork(tx: TenantClient, roomId: string, rootId: string): Promise<{ taskId: string; requestedBySeat: string | null; status: string }> {
  const root = await messageIn(tx, roomId, rootId);
  const meeting = root.kind === 'meeting' || root.became === 'meeting';
  if (!(root.became === 'work' || meeting) || !root.task_id) {
    throw new PalugadaError('contract.violation', 'this thread is not work: give its message as work first', { messageId: rootId });
  }
  const { rows } = await tx.query<{ requested_by_seat: string | null; status: string }>(
    'SELECT requested_by_seat, status FROM tasks WHERE id = $1', [root.task_id]);
  if (!rows[0]) throw new PalugadaError('contract.violation', 'the work this message asked for is no longer kept', { messageId: rootId });
  const caller = meeting && root.became_by?.startsWith('seat:') ? seatOf(root.became_by) : null;
  return { taskId: root.task_id, requestedBySeat: meeting ? caller : rows[0].requested_by_seat, status: rows[0].status };
}

/**
 * "Tell the work" (F19.7): a reply in a work's thread becomes an instruction
 * to it. The owner tells any work; a member or an approver only work it
 * pressed for -- writing the words the owner gave as work steers nothing. A
 * person tells only their own reply, typed in PALUGADA: nobody's words are
 * told as somebody else's, and a relay's are never an instruction. A seat's
 * is recorded as the seat's (`staff.instructed`) and counts as an ask.
 */
export async function tellTheWork(viewer: Viewer, roomId: string, replyId: string): Promise<{ recorded: true; taskId: string }> {
  if (!mayAsk(viewer)) throw new PalugadaError('staff.forbidden', 'a viewer reads and talks; telling work is a member\'s', {});
  const limit = viewer.seatId !== null ? await asksPerDay(viewer) : 0;
  const told = await withPeople(viewer.companyId, viewer.person, async (tx) => {
    const room = await visibleRoom(tx, viewer, roomId);
    if (viewer.seatId !== null) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('asks:' || $1 || ':' || $2, 0))", [viewer.companyId, viewer.seatId]);
    await takeClock(tx);
    const reply = await messageIn(tx, roomId, replyId, { lock: true });
    if (reply.kind !== 'text' || reply.author !== viewer.person.principal) {
      throw new PalugadaError('message.not_yours', 'only its author tells the work their words', { messageId: replyId });
    }
    if (reply.via !== 'console') throw new PalugadaError('contract.violation', 'an instruction is typed in PALUGADA, not sent through a relay', { messageId: replyId });
    if (reply.deleted_at || reply.thread_of === null) throw new PalugadaError('contract.violation', 'a reply in the work\'s thread is told to it', { messageId: replyId });
    const work = await threadWork(tx, roomId, reply.thread_of);
    if (viewer.seatId !== null && work.requestedBySeat !== viewer.seatId) {
      throw new PalugadaError('staff.forbidden', 'you steer only work you asked for', { messageId: replyId });
    }
    if (reply.became === 'instruction') return { taskId: work.taskId, rootId: reply.thread_of, fresh: false };
    if (reply.became !== null) throw new PalugadaError('contract.violation', 'that message already became something else', { messageId: replyId });
    if (viewer.seatId !== null) await asksToday(tx, viewer, limit);
    const by: Author = viewer.seatId !== null ? seatAuthor(viewer) : { kind: 'owner' };
    await instructTaskWithin(tx, viewer.companyId, work.taskId, reply.body ?? '', by, { via: 'room', ...placeOf(room, replyId) });
    await tx.query(
      "UPDATE room_messages SET became = 'instruction', became_by = $2, became_at = now() WHERE id = $1",
      [replyId, viewer.person.principal]);
    return { taskId: work.taskId, rootId: reply.thread_of, fresh: true };
  });
  // Said where it was told: the work reads it when its next run starts.
  if (told.fresh) await postNotice(viewer.companyId, roomId, told.rootId, 'recorded');
  return { recorded: true, taskId: told.taskId };
}

/**
 * Stopping the work a message asked for: the owner's any, a member's or an
 * approver's only what it pressed for. A tightening, so it takes no factor,
 * and recorded as whoever stopped it.
 */
export async function stopWork(viewer: Viewer, roomId: string, messageId: string): Promise<{ cancelled: number }> {
  if (!mayAsk(viewer)) throw new PalugadaError('staff.forbidden', 'a viewer reads and talks; stopping work is a member\'s', {});
  const work = await withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    return threadWork(tx, roomId, messageId);
  });
  if (viewer.seatId !== null && work.requestedBySeat !== viewer.seatId) {
    throw new PalugadaError('staff.forbidden', 'you stop only work you asked for', { messageId });
  }
  return { cancelled: await cancelTask(viewer.companyId, work.taskId, null, viewer.seatId !== null ? seatAuthor(viewer) : 'owner') };
}

/**
 * The words the owner may file as an issue from a room: their own, typed in
 * the console (F19.9). A seat's, a relay's or an imported message is given
 * as work instead, which carries whose they are; filed as the owner's ticket
 * they would be recorded as the owner's own.
 */
export async function ownWordsToFile(companyId: string, person: Person, from: unknown): Promise<string> {
  const reference = (from ?? {}) as { roomId?: unknown; messageId?: unknown };
  const roomId = String(reference.roomId ?? '').toLowerCase();
  const messageId = String(reference.messageId ?? '').toLowerCase();
  if (!UUID.test(roomId) || !UUID.test(messageId)) {
    throw new PalugadaError('contract.violation', 'fromMessage names a room and a message in it', { field: 'fromMessage' });
  }
  const viewer: Viewer = { companyId, person, kind: person.principal === 'owner' ? 'owner' : 'viewer', seatId: null };
  return withPeople(companyId, person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const message = await messageIn(tx, roomId, messageId);
    if (person.principal !== 'owner' || message.author !== 'owner' || message.via !== 'console' || message.kind !== 'text' || message.deleted_at) {
      throw new PalugadaError('message.not_the_owners', "only the owner's own words typed here can be filed as an issue: give it as work instead", { messageId });
    }
    return message.body ?? '';
  });
}
