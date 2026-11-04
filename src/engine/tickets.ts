/**
 * Tickets: work that is owed and not yet given to anyone (0070).
 *
 * A role files one when something needs doing that is not its job now -- the
 * planner's plan leaves the build behind it, the support responder's customer
 * needs somebody else's answer -- and the owner files one for anything they
 * want done eventually. A ticket becomes work when a task is given it: the
 * CEO's run hands it on with `task.delegate`, or the owner gives it to a
 * role from the console. It closes itself when that task finishes, and opens
 * again, with the reason, when the task ends any other way -- so a ticket is
 * never left marked as being worked by something that has stopped.
 *
 * A ticket also says whether the work that filed it had read something from
 * outside the company (F8.9, 0134): its words are then a stranger's as much
 * as the run's, and work made from it carries them. Said once, when it is
 * filed, and never changed: nothing here, and nothing the application role
 * may write, rewrites a ticket's words or its provenance afterwards.
 *
 * Some tickets are not work to hand out (F18.4, F18.5, 0139). An `issue` is
 * a problem to solve: it is done only with its root cause and the decision
 * taken, and the decision is carried out by to-dos -- work tickets that name
 * the issue they solve, each with one seat and a date a week out, which the
 * seat is handed straight away rather than through the CEO's triage. The
 * platform files an issue itself when work fails with a cause worth finding
 * (src/engine/postmortem.ts), once for the same source while it is open.
 */
import type { TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { learn, MEMORY_BODY_MAX } from '../memory/store.ts';

export const TICKET_STATUSES = ['open', 'in_progress', 'done', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * What a ticket is: `work` to be handed to a role, a `hire` -- a role the
 * company lacks and the work it would take over, which is the owner's to
 * decide (F2.9, 0132) -- or an `issue`: a problem the company solves, with a
 * root cause and a decision, and never hands out as work (F18.4, 0139).
 */
export const TICKET_KINDS = ['work', 'hire', 'issue'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/**
 * Which list an issue is on: `now`, the weekly list, or `long_term`, the one
 * read at quarterly planning.
 */
export const ISSUE_HORIZONS = ['now', 'long_term'] as const;
export type IssueHorizon = (typeof ISSUE_HORIZONS)[number];

/**
 * A to-do is due a week after it is made unless its filer says otherwise:
 * the action a weekly meeting can mark done or not done the next time it
 * meets.
 */
export const TODO_DAYS = 7;

export interface Ticket {
  id: string;
  projectId: string;
  kind: TicketKind;
  divisionId: string | null;
  title: string;
  body: string;
  status: TicketStatus;
  priority: number;
  /** `platform`: filed by PALUGADA itself, as a postmortem is (0139). */
  openedBy: 'owner' | 'agent' | 'platform';
  openedByTaskId: string | null;
  /**
   * Filed by work that had read something from outside the company, or of
   * unknown provenance (filed before 0134, or restored from an archive
   * written before it). The owner's own ticket never is.
   */
  outside: boolean;
  workingTaskId: string | null;
  /** Why it was closed; on a solved issue, the decision taken. */
  closedReason: string | null;
  /** What an issue is about, when it is about a goal or a number. */
  goalId: string | null;
  metricId: string | null;
  horizon: IssueHorizon;
  /** On a solved issue: why it happened. */
  rootCause: string | null;
  /** The card the platform filed an issue from. */
  fromInboxItemId: string | null;
  /** On a to-do: the issue whose decision it carries out. */
  solvesTicketId: string | null;
  /** On a to-do: its one seat, handed it straight away (src/engine/triage.ts, `handTodos`). */
  assigneeRoleId: string | null;
  /** On a to-do: the day it is due, as YYYY-MM-DD in the company's zone. */
  dueOn: string | null;
  /** What filed an issue the platform files, by which the same one still open is found again. */
  sourceKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

interface RawTicket {
  id: string; project_id: string; kind: TicketKind; division_id: string | null; title: string; body: string; status: TicketStatus;
  priority: number; opened_by: Ticket['openedBy']; opened_by_task_id: string | null; outside: boolean; working_task_id: string | null;
  closed_reason: string | null; goal_id: string | null; metric_id: string | null; horizon: IssueHorizon; root_cause: string | null;
  from_inbox_item_id: string | null; solves_ticket_id: string | null; assignee_role_id: string | null; due_on: string | null;
  source_key: string | null; created_at: Date; updated_at: Date; closed_at: Date | null;
}

// A date as text: `pg` reads a date column into a Date at local midnight,
// which is another day in any zone west of the server's.
const COLUMNS = `id, project_id, kind, division_id, title, body, status, priority, opened_by, opened_by_task_id, outside,
                 working_task_id, closed_reason, goal_id, metric_id, horizon, root_cause, from_inbox_item_id, solves_ticket_id,
                 assignee_role_id, due_on::text AS due_on, source_key, created_at, updated_at, closed_at`;

const toTicket = (row: RawTicket): Ticket => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  divisionId: row.division_id,
  title: row.title,
  body: row.body,
  status: row.status,
  priority: row.priority,
  openedBy: row.opened_by,
  openedByTaskId: row.opened_by_task_id,
  outside: row.outside,
  workingTaskId: row.working_task_id,
  closedReason: row.closed_reason,
  goalId: row.goal_id,
  metricId: row.metric_id,
  horizon: row.horizon,
  rootCause: row.root_cause,
  fromInboxItemId: row.from_inbox_item_id,
  solvesTicketId: row.solves_ticket_id,
  assigneeRoleId: row.assignee_role_id,
  dueOn: row.due_on,
  sourceKey: row.source_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at,
});

export const TITLE_MAX = 200;
export const BODY_MAX = 8_000;
/** A root cause and a decision are a paragraph each, not a report. */
export const ROOT_CAUSE_MAX = 2_000;
export const DECISION_MAX = 2_000;

export async function readTicket(tx: TenantClient, ticketId: string): Promise<Ticket | null> {
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) return null;
  const { rows } = await tx.query<RawTicket>(`SELECT ${COLUMNS} FROM tickets WHERE id = $1`, [ticketId]);
  return rows[0] ? toTicket(rows[0]) : null;
}

/**
 * Refuses an issue where work is handed out: an issue is solved, by filing
 * the to-dos that carry out its decision, and not given to a role to do.
 * Asked before the task is made, wherever one is -- the board's /assign,
 * the CEO's `task.delegate` -- and again where the ticket is started.
 */
export function assertHandedOutAsWork(ticket: Ticket): void {
  if (ticket.kind !== 'issue') return;
  throw new PalugadaError('contract.violation',
    `ticket "${ticket.title}" is an issue: an issue is solved, not handed out as work. Find its root cause, decide, `
      + 'and file the to-dos that carry the decision out with ticket.create, naming the issue in solves',
    { field: 'ticketId', kind: 'issue' });
}

/** What a ticket says about itself beyond its words, as `openTicket` and `fileIssue` take it. */
interface TicketFacts {
  companyId: string;
  projectId: string;
  divisionId: string | null;
  title: string;
  body?: string;
  priority?: number;
  /** `work` unless said: a `hire` proposes a role the company lacks, an `issue` is a problem to solve. */
  kind?: TicketKind;
  /** An issue's list; `now` unless said. */
  horizon?: IssueHorizon;
  goalId?: string | null;
  metricId?: string | null;
  fromInboxItemId?: string | null;
  /** A to-do: the issue it solves. Its due date is a week out unless `dueOn` says. */
  solvesTicketId?: string | null;
  assigneeRoleId?: string | null;
  /** YYYY-MM-DD. */
  dueOn?: string | null;
  openedBy: Ticket['openedBy'];
  openedByTaskId?: string | null;
  /**
   * Whether the filer's work had read something from outside (F8.9). Asked of
   * every caller rather than defaulted: a writer that forgot would file a
   * stranger's words as clean.
   */
  outside: boolean;
}

/** The words and the shape, checked before anything is read or written. */
function checked(input: TicketFacts): { title: string; body: string; kind: TicketKind; priority: number; horizon: IssueHorizon } {
  const title = input.title.trim();
  const body = (input.body ?? '').trim();
  if (!title) throw new PalugadaError('contract.violation', 'a ticket needs a title', { field: 'title' });
  if (title.length > TITLE_MAX) {
    throw new PalugadaError('contract.violation', `a ticket's title is at most ${TITLE_MAX} characters`, { field: 'title' });
  }
  if (body.length > BODY_MAX) {
    throw new PalugadaError('contract.violation', `a ticket's body is at most ${BODY_MAX} characters`, { field: 'body' });
  }
  const kind = input.kind ?? 'work';
  if (!(TICKET_KINDS as readonly string[]).includes(kind)) {
    throw new PalugadaError('contract.violation', `a ticket's kind is ${TICKET_KINDS.join(', ')}`, { field: 'kind' });
  }
  const priority = input.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new PalugadaError('contract.violation', 'priority is 0 (first) to 3 (last)', { field: 'priority' });
  }
  if (input.horizon !== undefined && kind !== 'issue') {
    throw new PalugadaError('contract.violation', 'only an issue is on a list (now or long_term); work and hires have none', { field: 'horizon' });
  }
  const horizon = input.horizon ?? 'now';
  if (!(ISSUE_HORIZONS as readonly string[]).includes(horizon)) {
    throw new PalugadaError('contract.violation', "an issue's horizon is now or long_term", { field: 'horizon' });
  }
  if (kind !== 'work' && input.solvesTicketId) {
    throw new PalugadaError('contract.violation', 'only work solves an issue: file the to-do as work, naming the issue in solves', { field: 'solves' });
  }
  if (kind !== 'work' && (input.assigneeRoleId || input.dueOn)) {
    throw new PalugadaError('contract.violation', 'only work has a seat and a due date; an issue is solved and a hire is the owner\'s', { field: 'assignee' });
  }
  if (input.dueOn && !isDay(input.dueOn)) {
    throw new PalugadaError('contract.violation', `a due date is a day written YYYY-MM-DD; "${input.dueOn}" is not one`, { field: 'due' });
  }
  return { title, body, kind, priority, horizon };
}

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** Today in the company's own zone, `days` on: the day a to-do falls due. */
async function companyDayFromNow(tx: TenantClient, companyId: string, days: number): Promise<string> {
  const { rows } = await tx.query<{ day: string }>(
    'SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS day FROM companies WHERE id = $1', [companyId, days]);
  if (!rows[0]) throw new PalugadaError('contract.violation', `no company ${companyId}`, { field: 'companyId' });
  return rows[0].day;
}

/** Writes the row and the event that says it was filed. Every statement names the company: the platform files on the control plane too. */
async function insertTicket(
  tx: TenantClient,
  input: TicketFacts & { sourceKey?: string | null },
  shape: ReturnType<typeof checked>,
): Promise<Ticket> {
  const dueOn = input.dueOn ?? (input.solvesTicketId ? await companyDayFromNow(tx, input.companyId, TODO_DAYS) : null);
  const { rows } = await tx.query<RawTicket>(
    `INSERT INTO tickets (company_id, project_id, division_id, title, body, priority, opened_by, opened_by_task_id, kind, outside,
                          horizon, goal_id, metric_id, from_inbox_item_id, solves_ticket_id, assignee_role_id, due_on, source_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18) RETURNING ${COLUMNS}`,
    [input.companyId, input.projectId, input.divisionId, shape.title, shape.body, shape.priority, input.openedBy,
      input.openedByTaskId ?? null, shape.kind, input.outside, shape.horizon, input.goalId ?? null, input.metricId ?? null,
      input.fromInboxItemId ?? null, input.solvesTicketId ?? null, input.assigneeRoleId ?? null, dueOn, input.sourceKey ?? null]);
  const ticket = toTicket(rows[0]!);
  await appendEvent(tx, {
    companyId: input.companyId,
    projectId: input.projectId,
    ...(input.openedByTaskId ? { taskId: input.openedByTaskId } : {}),
    type: 'ticket.opened',
    actor: input.openedBy === 'owner' ? 'owner' : input.openedBy === 'platform' ? 'system' : 'agent_run',
    payload: {
      ticketId: ticket.id, title: ticket.title, priority: ticket.priority, divisionId: ticket.divisionId, kind: ticket.kind,
      ...(ticket.solvesTicketId ? { solves: ticket.solvesTicketId } : {}),
      ...(ticket.sourceKey ? { sourceKey: ticket.sourceKey } : {}),
    },
  });
  return ticket;
}

/**
 * Files a ticket, or finds the one already open for the same thing.
 *
 * The same title still open in the same place, of the same kind -- and, for a
 * to-do, solving the same issue -- is the same ticket: a run that is retried,
 * or two runs that noticed the same missing piece, would otherwise fill the
 * board with copies the owner has to close by hand. It is returned as it is,
 * words and provenance both: a filer that has read an email cannot put new
 * words in a clean ticket by naming it again, and clean work cannot make a
 * ticket from outside clean.
 */
export async function openTicket(tx: TenantClient, input: TicketFacts): Promise<{ ticket: Ticket; existing: boolean }> {
  const shape = checked(input);
  if (input.solvesTicketId) {
    const solved = await readTicket(tx, input.solvesTicketId);
    if (!solved || solved.kind !== 'issue') {
      throw new PalugadaError('contract.violation',
        solved ? `ticket "${solved.title}" is ${solved.kind}, not an issue; a to-do solves an issue` : `no issue ${input.solvesTicketId} in this company`,
        { field: 'solves' });
    }
    if (solved.status === 'closed') {
      throw new PalugadaError('contract.violation',
        `issue "${solved.title}" was closed without being solved; open it again before filing to-dos for it`, { field: 'solves' });
    }
  }
  const same = await tx.query<RawTicket>(
    `SELECT ${COLUMNS} FROM tickets
      WHERE status IN ('open', 'in_progress') AND lower(title) = lower($1) AND division_id IS NOT DISTINCT FROM $2
        AND kind = $3 AND solves_ticket_id IS NOT DISTINCT FROM $4::uuid
      LIMIT 1`,
    [shape.title, input.divisionId, shape.kind, input.solvesTicketId ?? null]);
  if (same.rows[0]) return { ticket: toTicket(same.rows[0]), existing: true };
  return { ticket: await insertTicket(tx, input, shape), existing: false };
}

/**
 * Files an issue for something the platform noticed, or finds the one still
 * open from the same source (F18.4: "tanpa duplikat").
 *
 * The source is a stable key the caller makes from what the issue is about --
 * `task:<halt reason>:<role>` for work that failed (src/engine/postmortem.ts),
 * a measure for a number off track, a goal for a priority that missed -- so
 * the tenth crash loop in one seat is the first issue seen again, recorded
 * against it as `issue.recurred`, and not ten issues for the CEO to merge.
 * Once that issue is solved or closed, the same source files a new one: the
 * fix did not hold, and that is worth a fresh look.
 *
 * Under a lock on the source, so two workers that notice the same thing at
 * once file one issue between them. Every statement names the company, since
 * a caller on the control plane has no row security to narrow it.
 */
export async function fileIssue(tx: TenantClient, input: Omit<TicketFacts, 'kind' | 'solvesTicketId' | 'assigneeRoleId' | 'dueOn'> & {
  sourceKey: string;
}): Promise<{ ticket: Ticket; existing: boolean }> {
  const sourceKey = input.sourceKey.trim();
  if (!sourceKey || sourceKey.length > 200) {
    throw new PalugadaError('contract.violation', 'an issue filed from a source needs a source key of 1 to 200 characters', { field: 'sourceKey' });
  }
  const facts: TicketFacts = { ...input, kind: 'issue' };
  const shape = checked(facts);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`issue-source:${input.companyId}:${sourceKey}`]);
  const { rows } = await tx.query<RawTicket>(
    `SELECT ${COLUMNS} FROM tickets
      WHERE company_id = $1 AND kind = 'issue' AND status IN ('open', 'in_progress') AND source_key = $2
      ORDER BY created_at LIMIT 1`,
    [input.companyId, sourceKey]);
  if (rows[0]) {
    const ticket = toTicket(rows[0]);
    await appendEvent(tx, {
      companyId: input.companyId, projectId: ticket.projectId,
      ...(input.openedByTaskId ? { taskId: input.openedByTaskId } : {}),
      type: 'issue.recurred', actor: 'system',
      payload: { ticketId: ticket.id, sourceKey, ...(input.fromInboxItemId ? { inboxItemId: input.fromInboxItemId } : {}) },
    });
    return { ticket, existing: true };
  }
  return { ticket: await insertTicket(tx, { ...facts, sourceKey }, shape), existing: false };
}

/** One to-do a decision is carried out by. */
export interface TodoInput {
  title: string;
  body?: string;
  priority?: number;
  /** Its one seat; without one it is the CEO's to hand on, as any ticket. */
  assigneeRoleId?: string | null;
  /** YYYY-MM-DD; a week out unless said. */
  dueOn?: string | null;
  /** Where it belongs: the seat's division, or the issue's, unless said. */
  divisionId?: string | null;
}

/**
 * Solves an issue: its root cause and the decision taken are written on it,
 * it is done, the to-dos that carry the decision out are filed against it,
 * and the decision is kept as a lesson in the company's memory -- all in the
 * caller's one transaction, so an issue is never solved with no to-do behind
 * it, nor a to-do filed for a solve that did not happen.
 *
 * The lesson is the first PALUGADA keeps from a failure: `keepLessons` in
 * tasks.ts learns only from work that completed. A semantic `decision`, for
 * the issue's division (or the whole company's, for a company-level issue),
 * so every run there is told what was decided and why.
 */
export async function solveIssue(tx: TenantClient, input: {
  companyId: string;
  issueId: string;
  rootCause: string;
  decision: string;
  todos: readonly TodoInput[];
  solvedBy: 'owner' | 'agent';
  /** The run that solved it, when one did: the to-dos' filer and the lesson's teacher. */
  taskId?: string | null;
  /** Whether that run had read something from outside (F8.9): the to-dos and the lesson carry it. */
  outside: boolean;
}): Promise<{ issue: Ticket; todos: Ticket[] }> {
  const rootCause = input.rootCause.trim();
  const decision = input.decision.trim();
  if (!rootCause) {
    throw new PalugadaError('contract.violation',
      'solving an issue needs its root cause: why it happened, found by asking why of each answer and checking it against the record',
      { field: 'rootCause' });
  }
  if (!decision) {
    throw new PalugadaError('contract.violation', 'solving an issue needs the decision taken: what will be done about the root cause', { field: 'decision' });
  }
  if (rootCause.length > ROOT_CAUSE_MAX) {
    throw new PalugadaError('contract.violation', `a root cause is at most ${ROOT_CAUSE_MAX} characters`, { field: 'rootCause' });
  }
  if (decision.length > DECISION_MAX) {
    throw new PalugadaError('contract.violation', `a decision is at most ${DECISION_MAX} characters`, { field: 'decision' });
  }
  if (input.todos.length === 0) {
    throw new PalugadaError('contract.violation', 'solving an issue needs at least one to-do that carries the decision out', { field: 'todos' });
  }
  const { rows: found } = await tx.query<RawTicket>(
    `SELECT ${COLUMNS} FROM tickets WHERE company_id = $1 AND id = $2 FOR NO KEY UPDATE`, [input.companyId, input.issueId]);
  const issue = found[0] ? toTicket(found[0]) : null;
  if (!issue) throw new PalugadaError('contract.violation', `no issue ${input.issueId} in this company`, { field: 'solves' });
  if (issue.kind !== 'issue') {
    throw new PalugadaError('contract.violation', `ticket "${issue.title}" is ${issue.kind}, not an issue; only an issue is solved`, { field: 'solves' });
  }
  if (issue.status !== 'open') {
    throw new PalugadaError('contract.violation',
      issue.status === 'done'
        ? `issue "${issue.title}" is already solved; file more to-dos for it naming it in solves, without a root cause or a decision`
        : `issue "${issue.title}" was closed without being solved; open it again before solving it`,
      { field: 'solves', status: issue.status });
  }

  const todos: Ticket[] = [];
  for (const todo of input.todos) {
    let divisionId = todo.divisionId ?? null;
    if (!divisionId && todo.assigneeRoleId) {
      const { rows } = await tx.query<{ division_id: string }>(
        'SELECT division_id FROM roles WHERE company_id = $1 AND id = $2', [input.companyId, todo.assigneeRoleId]);
      if (!rows[0]) throw new PalugadaError('contract.violation', `no role ${todo.assigneeRoleId} in this company`, { field: 'assignee' });
      divisionId = rows[0].division_id;
    }
    const filed = await openTicket(tx, {
      companyId: input.companyId,
      projectId: issue.projectId,
      divisionId: divisionId ?? issue.divisionId,
      title: todo.title,
      ...(todo.body === undefined ? {} : { body: todo.body }),
      ...(todo.priority === undefined ? {} : { priority: todo.priority }),
      goalId: issue.goalId,
      solvesTicketId: issue.id,
      assigneeRoleId: todo.assigneeRoleId ?? null,
      dueOn: todo.dueOn ?? null,
      openedBy: input.solvedBy,
      openedByTaskId: input.taskId ?? null,
      outside: input.outside,
    });
    todos.push(filed.ticket);
  }

  const { rows } = await tx.query<RawTicket>(
    `UPDATE tickets
        SET status = 'done', root_cause = $3, closed_reason = $4, closed_at = now(), updated_at = now()
      WHERE company_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [input.companyId, issue.id, rootCause, decision]);
  const solved = toTicket(rows[0]!);
  await appendEvent(tx, {
    companyId: input.companyId, projectId: solved.projectId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    type: 'issue.solved', actor: input.solvedBy === 'owner' ? 'owner' : 'agent_run',
    payload: { ticketId: solved.id, todoIds: todos.map((one) => one.id) },
  });

  const lesson = `Issue: ${solved.title}\nRoot cause: ${rootCause}\nDecision: ${decision}`;
  await learn(tx, {
    companyId: input.companyId,
    memoryType: 'semantic',
    ...(solved.divisionId ? { scopeType: 'division' as const, scopeId: solved.divisionId } : { scopeType: 'company' as const }),
    body: lesson.slice(0, MEMORY_BODY_MAX),
    source: input.solvedBy,
    factKind: 'decision',
    // The issue's words may be a stranger's as much as the solver's.
    outside: input.outside || solved.outside,
    ...(input.taskId ? { sourceTaskId: input.taskId } : {}),
  });
  return { issue: solved, todos };
}

/** Checked before the query, so a malformed id is a refusal that says so rather than a statement the database rejects. */
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The board: open and in-progress first by priority and age, then the recently finished. */
export async function listTickets(tx: TenantClient, options: {
  status?: 'active' | 'all' | TicketStatus;
  divisionId?: string | null;
  /** Only these tickets: what a triage was given, and not the rest of the board. */
  ids?: readonly string[] | null;
  /** Only the to-dos that carry out this issue's decision. */
  solvesTicketId?: string | null;
  limit?: number;
} = {}): Promise<Ticket[]> {
  const status = options.status ?? 'active';
  const statuses = status === 'active' ? ['open', 'in_progress'] : status === 'all' ? [...TICKET_STATUSES] : [status];
  const ids = options.ids ?? null;
  if (ids && ids.some((id) => !TICKET_ID.test(id))) {
    throw new PalugadaError('contract.violation', 'a ticket id is a uuid, as ticket.list and the board give it', { field: 'ids' });
  }
  const solves = options.solvesTicketId ?? null;
  if (solves !== null && !TICKET_ID.test(solves)) {
    throw new PalugadaError('contract.violation', 'an issue is named by its ticket id, a uuid', { field: 'solves' });
  }
  const { rows } = await tx.query<RawTicket>(
    `SELECT ${COLUMNS} FROM tickets
      WHERE status = ANY($1::text[])
        AND ($2::uuid IS NULL OR division_id = $2)
        AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
        AND ($5::uuid IS NULL OR solves_ticket_id = $5::uuid)
      ORDER BY (status IN ('open', 'in_progress')) DESC, priority, created_at
      LIMIT $3`,
    [statuses, options.divisionId ?? null, Math.min(Math.max(options.limit ?? 100, 1), 500), ids ? [...ids] : null, solves]);
  return rows.map(toTicket);
}

/** A task is given the ticket: it is being worked, by that task. */
export async function startTicket(tx: TenantClient, companyId: string, ticketId: string, taskId: string): Promise<void> {
  const { rows } = await tx.query<{ status: TicketStatus; project_id: string }>(
    `UPDATE tickets SET status = 'in_progress', working_task_id = $2, updated_at = now()
      WHERE id = $1 AND status = 'open' AND kind <> 'issue'
      RETURNING status, project_id`,
    [ticketId, taskId]);
  if (!rows[0]) {
    const current = await readTicket(tx, ticketId);
    if (!current) throw new PalugadaError('contract.violation', `no ticket ${ticketId} in this company`, { field: 'ticketId' });
    assertHandedOutAsWork(current);
    throw new PalugadaError('contract.violation',
      current.status === 'in_progress'
        ? `ticket "${current.title}" is already being worked, by task ${current.workingTaskId}`
        : `ticket "${current.title}" is ${current.status}; reopen it before giving it to anyone`,
      { field: 'ticketId', status: current.status });
  }
  await appendEvent(tx, {
    companyId, projectId: rows[0].project_id, taskId, type: 'ticket.started', actor: 'system', payload: { ticketId },
  });
}

/** The owner closes a ticket that is not wanted any more, or opens one again. */
export async function setTicketStatus(tx: TenantClient, companyId: string, ticketId: string, change: {
  status: 'open' | 'closed';
  reason?: string | null;
  priority?: number;
}): Promise<Ticket> {
  const current = await readTicket(tx, ticketId);
  if (!current) throw new PalugadaError('contract.violation', `no ticket ${ticketId} in this company`, { field: 'ticketId' });
  if (current.status === 'in_progress' && change.status === 'closed') {
    throw new PalugadaError('contract.violation',
      `ticket "${current.title}" is being worked by task ${current.workingTaskId}; stop the task, and the ticket opens again for you to close`,
      { field: 'status' });
  }
  if (change.priority !== undefined && (!Number.isInteger(change.priority) || change.priority < 0 || change.priority > 3)) {
    throw new PalugadaError('contract.violation', 'priority is 0 (first) to 3 (last)', { field: 'priority' });
  }
  const closing = change.status === 'closed';
  const { rows } = await tx.query<RawTicket>(
    `UPDATE tickets
        SET status = CASE WHEN status = 'in_progress' THEN status ELSE $2 END,
            closed_at = CASE WHEN status = 'in_progress' THEN closed_at WHEN $3 THEN coalesce(closed_at, now()) ELSE NULL END,
            closed_reason = CASE WHEN $3 THEN $4 ELSE NULL END,
            priority = coalesce($5, priority),
            updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [ticketId, change.status, closing, change.reason?.trim() || null, change.priority ?? null]);
  const ticket = toTicket(rows[0]!);
  await appendEvent(tx, {
    companyId, projectId: ticket.projectId, type: closing ? 'ticket.closed' : 'ticket.reopened', actor: 'owner',
    payload: { ticketId, reason: ticket.closedReason },
  });
  // A hire closed on the board is answered: its card in the inbox goes with it.
  if (closing && ticket.kind === 'hire') {
    const { rows: withdrawn } = await tx.query<{ id: string }>(
      `UPDATE inbox_items SET status = 'withdrawn', closed_reason = 'ticket_closed'
        WHERE company_id = $1 AND kind = 'escalation' AND status = 'open'
          AND payload->>'hire' = 'true' AND payload->>'ticketId' = $2
        RETURNING id`, [companyId, ticketId]);
    for (const item of withdrawn) {
      await appendEvent(tx, {
        companyId, projectId: ticket.projectId, type: 'inbox.withdrawn', actor: 'system',
        payload: { inboxItemId: item.id, closedReason: 'ticket_closed' },
      });
    }
  }
  return ticket;
}

/**
 * What a task's end means for the ticket it was working (tasks.ts calls this
 * as the task settles, in the same transaction): done when it completed, open
 * again, with why, when it did not.
 */
export async function settleTicketsOf(tx: TenantClient, companyId: string, taskId: string, status: string): Promise<void> {
  const done = status === 'completed';
  const { rows } = await tx.query<{ id: string; project_id: string }>(
    `UPDATE tickets
        SET status = CASE WHEN $2 THEN 'done' ELSE 'open' END,
            working_task_id = CASE WHEN $2 THEN working_task_id ELSE NULL END,
            closed_at = CASE WHEN $2 THEN now() ELSE NULL END,
            closed_reason = CASE WHEN $2 THEN NULL ELSE $3 END,
            updated_at = now()
      WHERE working_task_id = $1 AND status = 'in_progress'
      RETURNING id, project_id`,
    [taskId, done, `its task ${taskId} ended ${status}`]);
  for (const row of rows) {
    await appendEvent(tx, {
      companyId, projectId: row.project_id, taskId, type: done ? 'ticket.done' : 'ticket.reopened', actor: 'system',
      payload: { ticketId: row.id, taskStatus: status },
    });
  }
}
