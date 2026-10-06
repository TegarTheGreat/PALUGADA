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
 *  - **A ticket an agent filed carries what it may hold.** The triage task
 *    begins as outside content (F8.9), as a ticket the owner hands out does,
 *    so what the CEO delegates carries it too and an action that would ask
 *    the owner still asks.
 *  - **Not while the company winds down**, which starts nothing new.
 *
 * The key is made from the tickets and when they last changed, so two workers
 * that decide at once make one task between them.
 */
import { createHash } from 'node:crypto';
import { withTenant } from '../db/tenant.ts';
import { isPalugadaError } from '../errors.ts';
import { createRootTask } from './tasks.ts';

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
  opened_by: 'owner' | 'agent';
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
      `SELECT k.id, k.project_id, k.title, k.priority, k.opened_by, k.updated_at
         FROM tickets k
        WHERE k.status = 'open' AND k.working_task_id IS NULL
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
          'These tickets are owed and not yet given to anyone. Read them with ticket.list, then hand each on with '
          + 'task.delegate (naming the ticket) or leave it open and say why. Do not do their work yourself.\n\n'
          + owed.map((one) => `- (priority ${one.priority}) ${one.title.slice(0, TITLE_SHOWN)}`).join('\n'),
        ticketIds: owed.map((one) => one.id),
      },
      ...(owed.some((one) => one.opened_by === 'agent')
        ? { carriesOutside: { capability: 'the tickets it was given', ticketIds: owed.filter((one) => one.opened_by === 'agent').map((one) => one.id) } }
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
