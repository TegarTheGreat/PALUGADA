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
 */
import type { TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';

export const TICKET_STATUSES = ['open', 'in_progress', 'done', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface Ticket {
  id: string;
  projectId: string;
  divisionId: string | null;
  title: string;
  body: string;
  status: TicketStatus;
  priority: number;
  openedBy: 'owner' | 'agent';
  openedByTaskId: string | null;
  workingTaskId: string | null;
  closedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

interface RawTicket {
  id: string; project_id: string; division_id: string | null; title: string; body: string; status: TicketStatus;
  priority: number; opened_by: 'owner' | 'agent'; opened_by_task_id: string | null; working_task_id: string | null;
  closed_reason: string | null; created_at: Date; updated_at: Date; closed_at: Date | null;
}

const COLUMNS = `id, project_id, division_id, title, body, status, priority, opened_by, opened_by_task_id,
                 working_task_id, closed_reason, created_at, updated_at, closed_at`;

const toTicket = (row: RawTicket): Ticket => ({
  id: row.id,
  projectId: row.project_id,
  divisionId: row.division_id,
  title: row.title,
  body: row.body,
  status: row.status,
  priority: row.priority,
  openedBy: row.opened_by,
  openedByTaskId: row.opened_by_task_id,
  workingTaskId: row.working_task_id,
  closedReason: row.closed_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at,
});

export const TITLE_MAX = 200;
export const BODY_MAX = 8_000;

export async function readTicket(tx: TenantClient, ticketId: string): Promise<Ticket | null> {
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) return null;
  const { rows } = await tx.query<RawTicket>(`SELECT ${COLUMNS} FROM tickets WHERE id = $1`, [ticketId]);
  return rows[0] ? toTicket(rows[0]) : null;
}

/**
 * Files a ticket, or finds the one already open for the same thing.
 *
 * The same title still open in the same place is the same ticket: a run that
 * is retried, or two runs that noticed the same missing piece, would
 * otherwise fill the board with copies the owner has to close by hand.
 */
export async function openTicket(tx: TenantClient, input: {
  companyId: string;
  projectId: string;
  divisionId: string | null;
  title: string;
  body?: string;
  priority?: number;
  openedBy: 'owner' | 'agent';
  openedByTaskId?: string | null;
}): Promise<{ ticket: Ticket; existing: boolean }> {
  const title = input.title.trim();
  const body = (input.body ?? '').trim();
  if (!title) throw new PalugadaError('contract.violation', 'a ticket needs a title', { field: 'title' });
  if (title.length > TITLE_MAX) {
    throw new PalugadaError('contract.violation', `a ticket's title is at most ${TITLE_MAX} characters`, { field: 'title' });
  }
  if (body.length > BODY_MAX) {
    throw new PalugadaError('contract.violation', `a ticket's body is at most ${BODY_MAX} characters`, { field: 'body' });
  }
  const priority = input.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new PalugadaError('contract.violation', 'priority is 0 (first) to 3 (last)', { field: 'priority' });
  }
  const same = await tx.query<RawTicket>(
    `SELECT ${COLUMNS} FROM tickets
      WHERE status IN ('open', 'in_progress') AND lower(title) = lower($1) AND division_id IS NOT DISTINCT FROM $2
      LIMIT 1`,
    [title, input.divisionId]);
  if (same.rows[0]) return { ticket: toTicket(same.rows[0]), existing: true };

  const { rows } = await tx.query<RawTicket>(
    `INSERT INTO tickets (company_id, project_id, division_id, title, body, priority, opened_by, opened_by_task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [input.companyId, input.projectId, input.divisionId, title, body, priority, input.openedBy, input.openedByTaskId ?? null]);
  const ticket = toTicket(rows[0]!);
  await appendEvent(tx, {
    companyId: input.companyId,
    projectId: input.projectId,
    ...(input.openedByTaskId ? { taskId: input.openedByTaskId } : {}),
    type: 'ticket.opened',
    actor: input.openedBy === 'owner' ? 'owner' : 'agent_run',
    payload: { ticketId: ticket.id, title: ticket.title, priority: ticket.priority, divisionId: ticket.divisionId },
  });
  return { ticket, existing: false };
}

/** The board: open and in-progress first by priority and age, then the recently finished. */
export async function listTickets(tx: TenantClient, options: {
  status?: 'active' | 'all' | TicketStatus;
  divisionId?: string | null;
  limit?: number;
} = {}): Promise<Ticket[]> {
  const status = options.status ?? 'active';
  const statuses = status === 'active' ? ['open', 'in_progress'] : status === 'all' ? [...TICKET_STATUSES] : [status];
  const { rows } = await tx.query<RawTicket>(
    `SELECT ${COLUMNS} FROM tickets
      WHERE status = ANY($1::text[])
        AND ($2::uuid IS NULL OR division_id = $2)
      ORDER BY (status IN ('open', 'in_progress')) DESC, priority, created_at
      LIMIT $3`,
    [statuses, options.divisionId ?? null, Math.min(Math.max(options.limit ?? 100, 1), 500)]);
  return rows.map(toTicket);
}

/** A task is given the ticket: it is being worked, by that task. */
export async function startTicket(tx: TenantClient, companyId: string, ticketId: string, taskId: string): Promise<void> {
  const { rows } = await tx.query<{ status: TicketStatus; project_id: string }>(
    `UPDATE tickets SET status = 'in_progress', working_task_id = $2, updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING status, project_id`,
    [ticketId, taskId]);
  if (!rows[0]) {
    const current = await readTicket(tx, ticketId);
    if (!current) throw new PalugadaError('contract.violation', `no ticket ${ticketId} in this company`, { field: 'ticketId' });
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
