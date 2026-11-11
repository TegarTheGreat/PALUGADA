/**
 * What the rooms' routes answer with, drawn from rows (F19.1, F19.5, F19.10,
 * F19.16; STATUS section 2.206): who a person is in a room, a message as the
 * console draws it, and a card drawn from the work it is about.
 *
 * A card holds no words of its own (0150): what it says is read here, when it
 * is shown, from the task and the inbox item it points at, and redacted on
 * the way out as every surface is (F12.4). What a person may press is said
 * beside each, computed for whoever reads it, so the console never offers a
 * button the server would refuse -- and the server still refuses it.
 */
import { withControlPlane, type Person, type TenantClient } from '../db/tenant.ts';
import { TERMINAL_STATUSES, type TaskStatus } from '../domain/task.ts';
import { tasksKeptFromSeat } from '../inbox/inbox.ts';
import type { StaffKind } from '../owner/staff.ts';
import { deliverablesWithin, summarise } from '../owner/views.ts';
import { redactor } from '../secrets/manager.ts';
import type { CardView, FileView, MessageView, PersonRef } from './contract.ts';

/** Who is reading, in which company: the person, and what the owner made them. */
export interface Viewer {
  companyId: string;
  person: Person;
  /** The owner, or the seat's kind as its session read it from the seat. */
  kind: 'owner' | StaffKind;
  /** The seat's id; null for the owner. */
  seatId: string | null;
  /**
   * The relay the person's words came through, when they did not come from
   * the console: the relay's inbound code says so, and the database records
   * the message as that relay's (0150).
   */
  relayId?: string;
}

/** Whether the viewer may ask for work, and steer or stop what they asked for (F19.8). */
export function mayAsk(viewer: Viewer): boolean {
  return viewer.kind !== 'viewer';
}

/** Whether the viewer may decide at tier 2 and below, and notify a whole room. */
export function mayDecide(viewer: Viewer): boolean {
  return viewer.kind === 'owner' || viewer.kind === 'approver';
}

/** One of the company's people as the control plane knows them. */
export interface Someone {
  principal: string;
  name: string | null;
  handle: string | null;
  picture: string | null;
  kind: 'owner' | StaffKind;
  /** Joined and not revoked: who may be added to a room, mentioned, or listed. */
  live: boolean;
}

/**
 * The company's people, read once a request from the control plane, where
 * a seat's row is kept (0110): every room table names a person by principal
 * alone, and draws their handle and picture from here. A revoked seat is
 * kept, so what it said still has a name to be drawn with.
 */
export class Directory {
  readonly companyId: string;
  readonly #people: Map<string, Someone>;
  /** Authors an import brought, by the seat each was linked to (STATUS 2.214). */
  readonly #linked: Map<string, string>;

  constructor(companyId: string, people: Map<string, Someone>, linked: Map<string, string> = new Map()) {
    this.companyId = companyId;
    this.#people = people;
    this.#linked = linked;
  }

  /**
   * The name an imported author is drawn under: the name of the seat the
   * owner linked them to, or else the one the import kept (F19.23).
   */
  formerName(principal: string, snapshot: string | null): string {
    const seat = this.#linked.get(principal);
    return (seat ? this.#people.get(seat)?.name : null) ?? snapshot ?? principal;
  }

  /** A person as a room draws them; `snapshot` is the name a row kept, which wins for what was said under it. */
  refOf(principal: string, snapshot?: string | null): PersonRef {
    if (principal === 'owner') return { principal, name: null, handle: null, picture: null };
    if (principal.startsWith('former:')) return { principal, name: this.formerName(principal, snapshot ?? null), handle: null, picture: null };
    const known = this.#people.get(principal);
    return {
      principal,
      name: snapshot !== undefined && snapshot !== null ? snapshot : known?.name ?? null,
      handle: known?.live ? known.handle : null,
      picture: known?.picture ?? null,
    };
  }

  /** Someone of this company, or undefined. */
  get(principal: string): Someone | undefined {
    return this.#people.get(principal);
  }

  /** Everyone who may be in a room now: the owner, and the joined, unrevoked seats. */
  live(): Someone[] {
    return [...this.#people.values()].filter((someone) => someone.live);
  }
}

/** The company's people, the owner first. */
export async function directoryOf(companyId: string): Promise<Directory> {
  const { rows, linked } = await withControlPlane(async (tx) => {
    const { rows: seats } = await tx.query<{
      id: string; name: string; handle: string | null; picture: string | null; kind: StaffKind; live: boolean;
    }>(
      `SELECT id, name, handle, picture, kind, joined_at IS NOT NULL AND revoked_at IS NULL AS live
         FROM staff_seats WHERE company_id = $1 ORDER BY name, id`,
      [companyId]);
    // Who an imported author became, which the owner set by linking them (STATUS 2.214).
    const { rows: formers } = await tx.query<{ former: string; seat_id: string }>(
      'SELECT former, seat_id FROM room_former_people WHERE company_id = $1 AND seat_id IS NOT NULL', [companyId]);
    return { rows: seats, linked: new Map(formers.map((one) => [one.former, `seat:${one.seat_id}`])) };
  });
  const people = new Map<string, Someone>([['owner', { principal: 'owner', name: null, handle: null, picture: null, kind: 'owner', live: true }]]);
  for (const row of rows) {
    people.set(`seat:${row.id}`, { principal: `seat:${row.id}`, name: row.name, handle: row.handle, picture: row.picture, kind: row.kind, live: row.live });
  }
  return new Directory(companyId, people, linked);
}

/** The columns of a message the views read. */
export interface MessageRow {
  id: string;
  room_id: string;
  position: string | number;
  thread_of: string | null;
  also_in_room: boolean;
  kind: MessageView['kind'];
  author: string;
  author_name: string | null;
  body: string | null;
  notice_code: string | null;
  notice_values: Record<string, unknown> | null;
  task_id: string | null;
  inbox_item_id: string | null;
  mentions: string[];
  mentions_room: boolean;
  became: MessageView['became'];
  became_by: string | null;
  via: MessageView['via'];
  reply_count: number;
  edited_at: Date | null;
  deleted_at: Date | null;
  /** Who removed it; null on a message whose time was up (STATUS 2.212). */
  deleted_by: string | null;
  created_at: Date;
}

/** Every column `MessageRow` names, for a SELECT over `room_messages m`. */
export const MESSAGE_COLUMNS = `m.id, m.room_id, m.position, m.thread_of, m.also_in_room, m.kind, m.author, m.author_name, m.body,
  m.notice_code, m.notice_values, m.task_id, m.inbox_item_id, m.mentions, m.mentions_room, m.became, m.became_by, m.via,
  m.reply_count, m.edited_at, m.deleted_at, m.deleted_by, m.created_at`;

/** How long after it was written a message may be edited (0150's guard holds the same). */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const LIVE = (status: string) => !(TERMINAL_STATUSES as readonly string[]).includes(status);

/** What a task's output says came of it, in the order the fields are read. */
const RESULT_FIELDS = ['summary', 'result', 'answer', 'outcome', 'conclusion', 'message', 'text', 'title'];

/** A picture the console draws inline: small, and a kind of image no browser runs. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const INLINE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Whether the console may draw a room file (STATUS 2.212): a picture of a
 * kind no browser runs, two megabytes at most, whose bytes are still kept.
 * Every other file, an SVG among them, is only ever saved.
 */
export function drawnInline(mime: string, bytes: number, kept = true): boolean {
  return kept && INLINE.has(mime) && bytes <= INLINE_MAX_BYTES;
}

/**
 * Messages as the console draws them, in the order given: their authors and
 * mentions as people, their reactions, replies, files and cards, and what the
 * viewer may press on each.
 */
export async function messageViews(
  tx: TenantClient, viewer: Viewer, directory: Directory, rows: readonly MessageRow[],
): Promise<MessageView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const me = viewer.person.principal;
  const { rows: reacted } = await tx.query<{ message_id: string; emoji: string; n: number; mine: boolean }>(
    `SELECT message_id, emoji, count(*)::int AS n, bool_or(principal = $2) AS mine FROM room_reactions
      WHERE message_id = ANY($1::uuid[]) GROUP BY message_id, emoji ORDER BY message_id, min(created_at), emoji`,
    [ids, me]);
  const { rows: replied } = await tx.query<{ thread_of: string; at: Date }>(
    'SELECT thread_of, max(created_at) AS at FROM room_messages WHERE thread_of = ANY($1::uuid[]) GROUP BY thread_of', [ids]);
  const { rows: files } = await tx.query<{ id: string; message_id: string; name: string; mime: string; bytes: string; kept: boolean }>(
    `SELECT id, message_id, name, mime, bytes, path IS NOT NULL AS kept FROM room_files
      WHERE message_id = ANY($1::uuid[]) ORDER BY created_at, id`, [ids]);
  // The work a reply's thread carries, for whether it may be told to that work.
  const roots = [...new Set(rows.map((row) => row.thread_of).filter((id): id is string => id !== null))];
  const { rows: rootRows } = roots.length === 0 ? { rows: [] } : await tx.query<{
    id: string; task_id: string | null; kind: string; became: string | null; became_by: string | null;
  }>('SELECT id, task_id, kind, became, became_by FROM room_messages WHERE id = ANY($1::uuid[])', [roots]);
  const rootTask = new Map(rootRows.map((row) => [row.id, row.task_id]));
  // Who called a meeting a thread is about, which is who steers it besides
  // the owner (STATUS 2.211); the weekly meeting's card was called by nobody.
  const caller = new Map(rootRows.map((row) => [row.id,
    row.kind === 'meeting' ? 'platform' : row.became === 'meeting' ? row.became_by : undefined]));
  const taskIds = [...new Set([...rows.map((row) => row.task_id), ...rootRows.map((row) => row.task_id)]
    .filter((id): id is string => id !== null))];
  const { rows: taskRows } = taskIds.length === 0 ? { rows: [] } : await tx.query<{ id: string; status: TaskStatus; requested_by_seat: string | null }>(
    'SELECT id, status, requested_by_seat FROM tasks WHERE id = ANY($1::uuid[])', [taskIds]);
  const tasks = new Map(taskRows.map((row) => [row.id, row]));
  // Which of the page's work a seat may not read the runs of, asked once for
  // the whole page on this transaction rather than once a card.
  const reading: SeatReading | undefined = viewer.seatId === null ? undefined
    : { asked: new Set(taskIds), kept: await tasksKeptFromSeat(tx, taskIds, { id: viewer.seatId }) };
  const steers = (taskId: string | null | undefined, calledBy?: string | null): boolean => {
    const task = taskId ? tasks.get(taskId) : undefined;
    if (!task || !LIVE(task.status) || !mayAsk(viewer)) return false;
    if (viewer.kind === 'owner') return true;
    // A meeting is steered by the seat that called it, never by one that merely wrote in its room.
    return calledBy !== undefined ? calledBy === me : task.requested_by_seat === viewer.seatId;
  };

  const views: MessageView[] = [];
  for (const row of rows) {
    const text = row.kind === 'text';
    const deleted = row.deleted_at !== null;
    const mine = row.author === me;
    // A card retention left without words, because its thread outlived it, is drawn as a removed message.
    const card = deleted && row.kind !== 'text' ? null
      : row.kind === 'work' || row.kind === 'question' || row.kind === 'approval' || row.kind === 'meeting'
      ? await cardView(tx, viewer, directory, { kind: row.kind, taskId: row.task_id, itemId: row.inbox_item_id, askedBy: null }, reading)
      : text && (row.became === 'work' || row.became === 'meeting') && row.task_id
        // A meeting called about a message is drawn under it, as work given from one is.
        ? await cardView(tx, viewer, directory, { kind: row.became, taskId: row.task_id, itemId: null, askedBy: row.became_by }, reading)
        : null;
    const reply = replied.find((one) => one.thread_of === row.id);
    views.push({
      id: row.id,
      position: Number(row.position),
      roomId: row.room_id,
      threadOf: row.thread_of,
      alsoInRoom: row.also_in_room,
      kind: row.kind,
      author: row.author === 'platform' ? { principal: 'platform' }
        : row.author.startsWith('former:') ? { principal: row.author, former: true, name: directory.formerName(row.author, row.author_name) }
          : directory.refOf(row.author, row.author_name),
      body: row.body,
      notice: row.kind === 'notice' && row.notice_code ? { code: row.notice_code, values: row.notice_values ?? {} } : null,
      mentions: row.mentions.map((principal) => directory.refOf(principal)),
      mentionsRoom: row.mentions_room,
      via: row.via,
      became: row.became,
      card,
      reactions: reacted.filter((one) => one.message_id === row.id).map((one) => ({ emoji: one.emoji, count: one.n, mine: one.mine })),
      replies: row.reply_count > 0 ? { count: row.reply_count, lastAt: reply ? reply.at.toISOString() : null } : null,
      // A removed message keeps no file, and is answered with none (STATUS 2.212).
      files: deleted ? [] : files.filter((one) => one.message_id === row.id).map((one): FileView => ({
        id: one.id, name: one.name, mime: one.mime, bytes: Number(one.bytes),
        inline: drawnInline(one.mime, Number(one.bytes), one.kept),
      })),
      peopleMeeting: null,
      edited: row.edited_at !== null,
      deleted,
      // Removed by nobody: its time was up under the owner's window (STATUS 2.212).
      expired: deleted && row.deleted_by === null,
      createdAt: row.created_at.toISOString(),
      may: {
        edit: text && !deleted && mine && Date.now() - row.created_at.getTime() < EDIT_WINDOW_MS,
        delete: text && !deleted && (mine || viewer.kind === 'owner'),
        pin: !deleted,
        giveAsWork: text && !deleted && row.became === null && row.thread_of === null && mayAsk(viewer),
        tell: text && !deleted && row.became === null && row.thread_of !== null && mine && row.via === 'console'
          && steers(rootTask.get(row.thread_of), caller.get(row.thread_of)),
        stop: text && (row.became === 'work' ? steers(row.task_id) : row.became === 'meeting' && steers(row.task_id, row.became_by)),
        // A meeting is called about a message at the top of a room, by the owner or an approver (F19.18).
        callMeeting: text && !deleted && row.became === null && row.thread_of === null && mayDecide(viewer),
        fileAsIssue: text && !deleted && viewer.kind === 'owner' && row.author === 'owner' && row.via === 'console',
        history: viewer.kind === 'owner' && row.edited_at !== null && !deleted,
      },
    });
  }
  return views;
}

/** What a card is about: the work, or the inbox item, and who pressed for the work when a person did. */
export interface CardSubject {
  kind: CardView['kind'];
  taskId: string | null;
  itemId: string | null;
  /** The principal who pressed for the work, for the work under an asking message. */
  askedBy: string | null;
}

/**
 * What a seat may read of a page's work, asked once for the page: the tasks
 * asked about, and of those, the ones whose runs' words are kept from it
 * (`tasksKeptFromSeat`, STATUS 2.204).
 */
interface SeatReading {
  asked: ReadonlySet<string>;
  kept: ReadonlySet<string>;
}

/**
 * A card as it is now, for one viewer. Read from the task and the item at
 * every showing, so a card the sweep has not redrawn yet is still right, and
 * nothing the card says is stored in a room.
 *
 * Everything is read on the caller's transaction, which already holds one of
 * the application pool's connections: borrowing a second for each card would
 * leave a room read by more people at once than the pool holds waiting on
 * one another until the pool gives up.
 */
export async function cardView(
  tx: TenantClient, viewer: Viewer, directory: Directory, subject: CardSubject, reading?: SeatReading,
): Promise<CardView> {
  const { rows: items } = subject.itemId === null ? { rows: [] } : await tx.query<{
    kind: string; status: string; decision: string | null; tier: number | null; title: string; action_summary: string;
    consequence_if_denied: string; expires_at: Date | null; addressee_seat: string | null; instigators: string[];
    task_id: string | null; payload: Record<string, unknown>; closed_reason: string | null;
  }>(
    `SELECT kind, status, decision, tier, title, action_summary, consequence_if_denied, expires_at, addressee_seat,
            instigators::text[] AS instigators, task_id, payload, closed_reason
       FROM inbox_items WHERE id = $1`, [subject.itemId]);
  const item = items[0];
  const taskId = subject.taskId ?? item?.task_id ?? null;
  const { rows: found } = taskId === null ? { rows: [] } : await tx.query<{
    id: string; status: TaskStatus; halt_reason: string | null; input: unknown; output: unknown;
    requested_by_seat: string | null; role_id: string; slug: string; display_name: string | null; key: string | null;
  }>(
    `SELECT t.id, t.status, t.halt_reason, t.input, t.output, t.requested_by_seat, r.id AS role_id, r.slug, r.display_name,
            t.idempotency_key AS key
       FROM tasks t JOIN roles r ON r.id = t.role_id WHERE t.id = $1`, [taskId]);
  const task = found[0];
  // What its runs said and made, which a seat reads only where nobody else
  // was asked anything in it, nor said anything to it (STATUS 2.204).
  const kept = task === undefined || viewer.seatId === null ? false
    : reading?.asked.has(task.id) ? reading.kept.has(task.id)
      : (await tasksKeptFromSeat(tx, [task.id], { id: viewer.seatId })).has(task.id);
  const readable = task !== undefined && !kept;
  let lastLine: string | null = null;
  let result: string | null = null;
  let deliverables: CardView['deliverables'] = [];
  if (task && readable) {
    const { rows: notes } = await tx.query<{ body: string }>(
      'SELECT body FROM run_notes WHERE task_id = $1 ORDER BY said_at DESC, seq DESC LIMIT 1', [task.id]);
    lastLine = notes[0] ? redactor.redact(notes[0].body) : null;
    if (task.status === 'completed' && task.output !== null && task.output !== undefined) {
      result = redactor.redact(summarise(task.output, 400, RESULT_FIELDS));
      deliverables = (await deliverablesWithin(tx, task.id)).map((one) => ({ id: String(one.step), title: one.title }));
    }
  }
  const goal = task && task.input && typeof task.input === 'object' && typeof (task.input as { goal?: unknown }).goal === 'string'
    ? redactor.redact((task.input as { goal: string }).goal) : null;
  const open = item?.status === 'open';
  const question = item && item.kind === 'escalation' && item.payload.askedBy === 'agent';
  const hidden = Boolean(question && item.addressee_seat && viewer.seatId !== null && item.addressee_seat !== viewer.seatId);
  const meeting = subject.kind === 'meeting' && task ? await meetingOf(tx, task, readable) : null;
  const presses = task !== undefined && LIVE(task.status) && mayAsk(viewer)
    && (viewer.kind === 'owner' || (subject.kind === 'meeting'
      // A meeting is the seat's to steer when the seat called it; the weekly one is nobody's but the owner's.
      ? subject.askedBy !== null && subject.askedBy === viewer.person.principal
      : task.requested_by_seat !== null && task.requested_by_seat === viewer.seatId));
  const ownerOnly = item?.payload.ownerOnly === true;
  const tier = item?.tier ?? null;
  return {
    kind: subject.kind,
    taskId,
    itemId: subject.itemId,
    state: item ? itemState(item, item.closed_reason) : task?.status ?? 'gone',
    whyStopped: task && (task.status === 'halted' || task.status === 'failed' || task.status === 'cancelled') ? task.halt_reason : null,
    askedBy: subject.askedBy ? directory.refOf(subject.askedBy)
      : task?.requested_by_seat ? directory.refOf(`seat:${task.requested_by_seat}`) : null,
    goal,
    // The role's slug is what the console draws its picture from (console/src/images.ts).
    role: task ? { id: task.role_id, label: task.display_name ?? task.slug, picture: task.slug } : null,
    lastLine,
    result,
    deliverables,
    question: question ? {
      text: hidden ? '' : redactor.redact(String(item.payload.question ?? '')),
      options: hidden || !Array.isArray(item.payload.options) ? [] : (item.payload.options as unknown[]).map((one) => redactor.redact(String(one))),
      addressee: item.addressee_seat ? directory.refOf(`seat:${item.addressee_seat}`) : null,
      hidden,
      endsAt: item.expires_at ? item.expires_at.toISOString() : null,
    } : null,
    approval: item && item.kind === 'approval' ? {
      tier: tier ?? 0, title: redactor.redact(item.title), summary: redactor.redact(item.action_summary),
      consequence: item.consequence_if_denied ? redactor.redact(item.consequence_if_denied) : null,
    } : null,
    meeting: meeting?.view ?? null,
    may: {
      answer: Boolean(question && open && !hidden && (viewer.kind === 'owner'
        || (!ownerOnly && ((viewer.kind !== 'viewer' && item.addressee_seat === viewer.seatId)
          || (viewer.kind === 'approver' && item.addressee_seat === null))))),
      decide: Boolean(item && item.kind === 'approval' && open && (tier ?? 0) <= 2 && (viewer.kind === 'owner'
        || (viewer.kind === 'approver' && !item.instigators.includes(viewer.seatId!)))),
      stop: (subject.kind === 'work' || subject.kind === 'meeting') && presses,
      tell: (subject.kind === 'work' || subject.kind === 'meeting') && presses,
      // Joining is the owner's, on a meeting not over and not yet joined (F19.17).
      join: Boolean(meeting && viewer.kind === 'owner' && task && LIVE(task.status) && !meeting.view.joined),
    },
    inInbox: Boolean(item && item.kind === 'approval' && (tier ?? 0) >= 3),
  };
}

/** The longest record a meeting card draws: the part of its summary the owner reads. */
const RECORD_MAX = 2_000;
/** The heading the meeting's brief asks its record to end with. */
const RECORD_HEADING = 'What the owner needs to know';
/** The most to-dos a meeting card lists; the rest are under Work. */
const TODOS_SHOWN = 10;

/**
 * What a meeting card draws besides the work's state (F19.17, F19.18): the
 * week, the agenda counted from the facts the meeting was handed, whether
 * the owner attends it, and once it is over, its record -- the section of
 * its summary headed for the owner, redacted -- and the to-dos it filed. Its
 * runs' words are drawn only where the reader may read them, as a work
 * card's result is.
 */
async function meetingOf(
  tx: TenantClient, task: { id: string; status: TaskStatus; input: unknown; output: unknown; key: string | null }, readable: boolean,
): Promise<{ view: NonNullable<CardView['meeting']> }> {
  const input = (task.input ?? {}) as {
    meeting?: { week?: unknown; ownerJoins?: { minutes?: unknown } };
    facts?: {
      scorecard?: { lines?: unknown[]; linesLeftOut?: number }; priorities?: { items?: unknown[]; leftOut?: number };
      todos?: { items?: unknown[]; leftOut?: number }; issues?: { items?: unknown[]; leftOut?: number };
    };
  };
  const counted = (part: { items?: unknown[]; lines?: unknown[]; leftOut?: number; linesLeftOut?: number } | undefined): number =>
    (part?.items ?? part?.lines ?? []).length + (part?.leftOut ?? part?.linesLeftOut ?? 0);
  const facts = input.facts ?? {};
  const { rows: joined } = await tx.query<{ minutes: number }>(
    `SELECT (payload->>'minutes')::int AS minutes FROM events
      WHERE task_id = $1 AND type = 'meeting.owner_joined' ORDER BY occurred_at DESC, id DESC LIMIT 1`, [task.id]);
  const planned = typeof input.meeting?.ownerJoins?.minutes === 'number' ? input.meeting.ownerJoins.minutes : null;
  const minutes = joined[0]?.minutes ?? planned;
  let record: string | null = null;
  let todos: Array<{ id: string; title: string }> = [];
  if (readable && task.status === 'completed') {
    const summary = summarise(task.output, 20_000, RESULT_FIELDS);
    const at = summary.indexOf(RECORD_HEADING);
    record = redactor.redact((at >= 0 ? summary.slice(at) : summary).trim().slice(0, RECORD_MAX)) || null;
  }
  if (readable) {
    const { rows } = await tx.query<{ id: string; title: string }>(
      `SELECT id, title FROM tickets WHERE opened_by_task_id = $1 AND kind = 'work' ORDER BY created_at, id LIMIT ${TODOS_SHOWN}`, [task.id]);
    todos = rows.map((row) => ({ id: row.id, title: redactor.redact(row.title) }));
  }
  return {
    view: {
      week: task.key?.startsWith('meeting:') && typeof input.meeting?.week === 'string' ? input.meeting.week : null,
      agenda: {
        scorecard: counted(facts.scorecard), priorities: counted(facts.priorities), todos: counted(facts.todos), issues: counted(facts.issues),
      },
      joined: minutes !== null,
      joinMinutes: minutes,
      called: task.key?.startsWith('room-meeting:') ?? false,
      record,
      todos,
    },
  };
}

/**
 * An item's state as a card draws it: open, or how it ended. A meeting's
 * question whose minutes passed went on (`went_on`), which is neither an
 * answer nor a refusal (F19.17).
 */
export function itemState(
  item: { kind: string; status: string; decision: string | null; payload: Record<string, unknown> }, closedReason: string | null = null,
): string {
  if (item.status === 'withdrawn' && closedReason === 'meeting_went_on') return 'went_on';
  if (item.status !== 'decided') return item.status;
  if (item.decision === 'deny') return 'denied';
  if (item.decision === 'ask') return 'asked';
  return item.kind === 'approval' ? 'approved' : 'answered';
}
