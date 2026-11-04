/**
 * The tickets the company owes are the CEO's to hand on, without being asked
 * (the audit of 3 October, section 3.1).
 *
 * A role files a ticket when something needs doing that is not its job now,
 * and the tickets module says the CEO's run hands it on with `task.delegate`.
 * Nothing ever started that run: filing a ticket woke nobody, so a backlog sat
 * open until the owner opened a chat and asked for it -- the owner being the
 * dispatcher, which is the job the CEO is for.
 *
 * Now, when tickets are owed, one triage task is made for the CEO, which reads
 * them with `ticket.list` and gives each to the role whose job it is. What
 * keeps it from becoming a meter running on nothing:
 *
 *  - **Nothing owed, nothing made.** The check is two queries; no task, no
 *    model call, no tokens (F9.10: dormant is the normal state).
 *  - **One at a time, and one every ten minutes**, so a role that files a
 *    ticket a minute is looked at in batches and not each time.
 *  - **Each ticket once until it changes.** A ticket the CEO could not hand on
 *    stays open for the owner to see and is not offered again every ten
 *    minutes; it is offered again when somebody changes it.
 *  - **A ticket from outside carries what it may hold.** A ticket filed by
 *    work that had read something from outside (F8.9, 0134) makes the triage
 *    task begin as outside content, as it makes the task the owner gives it
 *    to from the board, so what the CEO delegates carries it too and an
 *    action that would ask the owner still asks. The owner's own tickets,
 *    and those clean work filed, do not: triaged or given out by hand, the
 *    same ticket makes the same work. The brief names the tickets' ids, and
 *    `ticket.list` given them reads only those, so the rest of the board --
 *    a hire proposed from outside, a ticket worked after a customer wrote --
 *    does not taint a pass that has nothing to do with it. A listing that
 *    returns any ticket from outside is tainted as a whole.
 *  - **Not while the company winds down**, which starts nothing new.
 *
 * The key is made from the tickets and when they last changed, so two workers
 * that decide at once make one task between them.
 */
import { createHash } from 'node:crypto';
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError, isPalugadaError } from '../errors.ts';
import { TERMINAL_STATUSES } from '../domain/task.ts';
import { assignTask } from '../scheduler/wake.ts';
import { createRootTask } from './tasks.ts';
import { startTicket } from './tickets.ts';

/** The statuses work does not come back from, as SQL. */
const TERMINAL = `(${TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})`;

/** The least time between one triage and the next for a company. */
export const TRIAGE_EVERY_MS = 10 * 60_000;
/** The most tickets one triage names; the rest are next time. */
const MOST_TICKETS = 10;
/** A title is a line: the details are read with `ticket.list`. */
const TITLE_SHOWN = 160;

interface Owed {
  id: string;
  project_id: string;
  title: string;
  priority: number;
  /** Filed by work that had read something from outside (0134). */
  outside: boolean;
  updated_at: Date;
}

/** The id of the triage task made, or null when none was owed or one is already going. */
export async function ensureTriage(companyId: string, now = new Date()): Promise<string | null> {
  const found = await withTenant(companyId, async (tx) => {
    const { rows: ceo } = await tx.query<{ id: string; division_id: string }>(
      "SELECT id, division_id FROM roles WHERE title = 'CEO' ORDER BY created_at LIMIT 1");
    if (!ceo[0]) return null;
    const { rows: stage } = await tx.query<{ stage: string | null }>('SELECT stage FROM companies WHERE id = $1', [companyId]);
    if (stage[0]?.stage === 'wind_down') return null;

    // One going, or one made within the last ten minutes.
    const { rows: recent } = await tx.query(
      `SELECT 1 FROM tasks
        WHERE idempotency_key LIKE 'triage:%'
          AND (status NOT IN ('completed', 'failed', 'halted', 'cancelled')
               OR created_at > $1::timestamptz - make_interval(secs => $2))
        LIMIT 1`,
      [now, TRIAGE_EVERY_MS / 1000]);
    if (recent.length > 0) return null;

    const { rows: owed } = await tx.query<Owed>(
      `SELECT k.id, k.project_id, k.title, k.priority, k.outside, k.updated_at
         FROM tickets k
        WHERE k.status = 'open' AND k.working_task_id IS NULL
          -- A hire is the owner's to decide (0132), and an issue is solved,
          -- not handed out (0139): neither is work to hand on.
          AND k.kind = 'work'
          -- A to-do with a seat is that seat's, handed it by \`handTodos\`; it
          -- is the CEO's only once that work has ended without finishing it.
          AND (k.assignee_role_id IS NULL OR EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.idempotency_key = 'todo:' || k.id::text AND t.status IN ${TERMINAL}))
          AND NOT EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.idempotency_key LIKE 'triage:%'
                   AND t.created_at >= k.updated_at
                   AND t.input->'ticketIds' ? k.id::text)
        ORDER BY k.priority, k.created_at
        LIMIT ${MOST_TICKETS}`);
    if (owed.length === 0) return null;

    // The goal the work serves: the company's own purpose, as an escalation's is.
    const { rows: goal } = await tx.query<{ id: string }>(
      `SELECT id FROM goals WHERE status = 'active'
        ORDER BY CASE kind WHEN 'mission' THEN 0 ELSE 1 END, created_at LIMIT 1`);
    if (!goal[0]) return null;
    return { ceo: ceo[0], goalId: goal[0].id, owed };
  });
  if (!found) return null;

  const { ceo, goalId, owed } = found;
  const fromOutside = owed.filter((one) => one.outside).map((one) => one.id);
  const fingerprint = createHash('sha256')
    .update(owed.map((one) => `${one.id}@${one.updated_at.toISOString()}`).join('|'))
    .digest('hex')
    .slice(0, 24);
  try {
    const task = await createRootTask({
      companyId, projectId: owed[0]!.project_id, divisionId: ceo.division_id, roleId: ceo.id, goalId,
      createdBy: 'event', idempotencyKey: `triage:${fingerprint}`,
      input: {
        goal: 'Work the ticket backlog: give each open ticket to the role whose job it is, or close it with a reason.',
        context:
          'These tickets are owed and not yet given to anyone. Read them with ticket.list, giving it these ids '
          + `(ids: ${JSON.stringify(owed.map((one) => one.id))}), then hand each on with task.delegate (naming the `
          + 'ticket) or leave it open and say why. Do not do their work yourself.\n\n'
          + owed.map((one) => `- (priority ${one.priority}) ${one.title.slice(0, TITLE_SHOWN)}`).join('\n'),
        ticketIds: owed.map((one) => one.id),
      },
      // The titles above are in the brief from its first step: a ticket from
      // outside makes it outside content then, recorded with the task.
      ...(fromOutside.length > 0
        ? { carriesOutside: { capability: 'the tickets it was given', ticketIds: fromOutside } }
        : {}),
    });
    return task.id;
  } catch (error) {
    // A frozen CEO, a paused month, a goal just closed: each is a reason
    // nothing starts now, and the next look finds it again.
    if (isPalugadaError(error)) return null;
    throw error;
  }
}

/** The most to-dos one pass hands out; the rest are next tick. */
const MOST_TODOS = 10;

interface Todo {
  id: string;
  project_id: string;
  title: string;
  body: string;
  priority: number;
  outside: boolean;
  due_on: string | null;
  role_id: string;
  division_id: string;
  goal_id: string;
  issue_title: string | null;
  decision: string | null;
}

/**
 * Hands each to-do that names its seat to that seat (F18.5): the CEO filed
 * it with one owner, so it goes to that owner straight away, by
 * \`assignTask\`, and not round through the CEO's triage to be handed again.
 *
 * Once. The task is keyed \`todo:<ticket>\`, so a to-do whose work ended
 * without finishing it -- reopened by \`settleTicketsOf\`, saying why -- is
 * not handed to the same seat again and again; it is then the CEO's, through
 * triage, or the owner's, from the board. A to-do whose task was made and
 * whose ticket was not yet marked taken (a worker stopped in between) is
 * found again and marked. A seat that cannot take work now -- frozen, its
 * money spent -- is said so on the record, and asked again ten minutes on.
 */
export async function handTodos(companyId: string, now = new Date()): Promise<number> {
  const owed = await withTenant(companyId, async (tx) => {
    const { rows: stage } = await tx.query<{ stage: string | null }>('SELECT stage FROM companies WHERE id = $1', [companyId]);
    if (stage[0]?.stage === 'wind_down') return [];
    const { rows } = await tx.query<Todo>(
      `SELECT k.id, k.project_id, k.title, k.body, k.priority, k.outside OR coalesce(i.outside, false) AS outside,
              k.due_on::text AS due_on, r.id AS role_id, r.division_id, i.title AS issue_title,
              CASE WHEN i.status = 'done' THEN i.closed_reason END AS decision,
              -- The goal the issue is about while it is open; else the company's own purpose, as a triage's is.
              coalesce((SELECT g.id FROM goals g WHERE g.id = k.goal_id AND g.status = 'active'),
                       (SELECT g.id FROM goals g WHERE g.status = 'active'
                         ORDER BY CASE g.kind WHEN 'mission' THEN 0 ELSE 1 END, g.created_at LIMIT 1)) AS goal_id
         FROM tickets k
         JOIN roles r ON r.id = k.assignee_role_id
         LEFT JOIN tickets i ON i.id = k.solves_ticket_id
        WHERE k.kind = 'work' AND k.status = 'open' AND k.working_task_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.idempotency_key = 'todo:' || k.id::text AND t.status IN ${TERMINAL})
          AND NOT EXISTS (SELECT 1 FROM events e
                           WHERE e.type = 'ticket.not_handed' AND e.payload->>'ticketId' = k.id::text
                             AND e.occurred_at > $1::timestamptz - make_interval(secs => $2))
        ORDER BY k.priority, k.created_at
        LIMIT ${MOST_TODOS}`,
      [now, TRIAGE_EVERY_MS / 1000]);
    return rows;
  });

  let handed = 0;
  for (const todo of owed) {
    try {
      if (!todo.goal_id) {
        throw new PalugadaError('goal.required', 'the company has no open goal for the to-do to serve (PRD F2.7)', { ticketId: todo.id });
      }
      const context = [
        todo.body,
        todo.issue_title ? `It carries out the decision on the issue "${todo.issue_title}"${todo.decision ? `: ${todo.decision}` : '.'}` : '',
        todo.due_on ? `Due ${todo.due_on}.` : '',
      ].filter(Boolean).join('\n\n');
      const { task } = await assignTask({
        companyId, projectId: todo.project_id, divisionId: todo.division_id, roleId: todo.role_id, goalId: todo.goal_id,
        createdBy: 'event', idempotencyKey: `todo:${todo.id}`, priority: todo.priority,
        input: { goal: todo.title, ...(context ? { context } : {}), ticketId: todo.id },
        // A to-do filed by work that had read something from outside, or for
        // an issue that was, carries what it may hold (F8.9), as a ticket
        // given out from the board does.
        ...(todo.outside ? { carriesOutside: { capability: 'the to-do it was given', ticketId: todo.id } } : {}),
        detail: `its to-do ${todo.id}`,
      });
      await withTenant(companyId, (tx) => startTicket(tx, companyId, todo.id, task.id));
      handed += 1;
    } catch (error) {
      // A seat frozen, a month paused, money spent: a reason nothing starts
      // now, said once on the record, and the next look in ten minutes.
      if (!isPalugadaError(error)) throw error;
      await withTenant(companyId, (tx) => appendEvent(tx, {
        companyId, projectId: todo.project_id, type: 'ticket.not_handed', actor: 'system',
        payload: { ticketId: todo.id, roleId: todo.role_id, reason: (error as Error).message.slice(0, 300) },
      }));
    }
  }
  return handed;
}
