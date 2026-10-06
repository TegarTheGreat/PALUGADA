/**
 * The owner's controls over one task: cancel it, do it again, tell it
 * something.
 *
 * The brakes that existed were for everything at once -- stop the platform,
 * freeze a company, cancel every task -- so one runaway task in one company
 * meant stopping six divisions that were working, and a task halted by
 * something that had since passed could not be tried again at all. Paperclip
 * gives its board cancel and retry per issue and Buzz lets a person stop or
 * steer one turn; these are the same controls under this platform's rules.
 *
 * Each tightens or redirects and none loosens: cancelling stops work, doing a
 * task again spends from the same budget under the same grants, and an
 * instruction is read by the run and changes nothing the broker decides. So
 * each takes the owner's session and not the second factor, like every other
 * control that tightens (see `/api/control/stop-all`).
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { TERMINAL_STATUSES, isTerminal, type TaskStatus } from '../domain/task.ts';
import { PalugadaError } from '../errors.ts';
import { assignTask } from '../scheduler/wake.ts';
import { DEFAULT_TASK_RESERVE_TOKENS, getTask, outsideContentIn } from './tasks.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';
import { enqueueWake } from '../scheduler/wake.ts';
import { remember, supersede } from '../memory/store.ts';

/** The longest instruction or note, the same bound as a question from the owner. */
export const INSTRUCTION_MAX = 2_000;

/**
 * How many instructions one task takes. A task steered ten times is one the
 * owner is doing by hand, and every instruction is read on every run: past
 * this, cancel and do it again with one note.
 */
export const INSTRUCTIONS_PER_TASK = 10;

/**
 * Releases what a set of cancelled tasks had reserved.
 *
 * One release per account rather than per task, and every account any of them
 * touches locked first, in id order -- the order `budget_spend` and
 * `budget_settle` lock in. Releasing chain by chain would hold the company
 * account from the first while waiting for the second division's, which a
 * worker recording usage against that division may already hold while it
 * waits for the company's: a deadlock PostgreSQL would settle by aborting one
 * side, and the side it aborts can be this one.
 */
export async function releaseReservations(
  tx: TenantClient,
  rows: Array<{ budget_account_id: string | null; released: string | number }>,
): Promise<void> {
  const released = new Map<string, bigint>();
  for (const row of rows) {
    if (!row.budget_account_id || BigInt(row.released) === 0n) continue;
    released.set(row.budget_account_id, (released.get(row.budget_account_id) ?? 0n) + BigInt(row.released));
  }
  if (released.size === 0) return;
  await tx.query(
    `SELECT app.budget_lock_chain(ARRAY(
       SELECT DISTINCT unnest(app.budget_chain(account)) FROM unnest($1::uuid[]) AS account))`,
    [[...released.keys()]],
  );
  for (const [account, tokens] of released) {
    await tx.query('SELECT app.budget_release($1, $2)', [account, tokens.toString()]);
  }
}

/** The task, in this company, or a refusal that names what was wrong. */
async function taskHere(companyId: string, taskId: string) {
  const task = await withTenant(companyId, (tx) => getTask(tx, taskId));
  if (!task) {
    throw new PalugadaError('contract.violation', 'no such task in this company', { taskId });
  }
  return task;
}

/**
 * Cancels a task and every task under it that has not ended, and returns how
 * many that was.
 *
 * The sub-tasks too, because a child exists to serve its parent and one left
 * running would spend money on an answer nobody will read. Nothing else: a
 * task this one did not start is not this one.
 *
 * The lease is cleared with the status, which is how a worker already running
 * the task finds out -- its next renewal finds the lease gone and it aborts
 * the runtime, the same path the stop button uses. Approvals the task was
 * waiting on are withdrawn by the trigger every terminal move fires (0036).
 */
export async function cancelTask(companyId: string, taskId: string, reason?: string | null): Promise<number> {
  const root = await taskHere(companyId, taskId);
  if (isTerminal(root.status)) {
    throw new PalugadaError('contract.violation', `task ${taskId} is already ${root.status}`, { taskId });
  }
  const why = reason?.trim() ? reason.trim().slice(0, INSTRUCTION_MAX) : null;
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; project_id: string; budget_account_id: string | null; released: string;
    }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM tasks WHERE id = $1 AND company_id = $2
         UNION ALL
         SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id AND t.company_id = $2
       ),
       doomed AS (
         SELECT t.id, t.tokens_reserved FROM tasks t JOIN tree ON tree.id = t.id
          WHERE t.status <> ALL ($3::text[])
          ORDER BY t.id
          FOR NO KEY UPDATE OF t
       )
       UPDATE tasks t
          SET status = 'cancelled', halt_reason = 'owner_cancel', finished_at = now(),
              lease_holder = NULL, lease_expires_at = NULL, tokens_reserved = 0
         FROM doomed d
        WHERE t.id = d.id
       RETURNING t.id, t.project_id, t.budget_account_id, d.tokens_reserved AS released`,
      [taskId, companyId, TERMINAL_STATUSES],
    );
    await releaseReservations(tx, rows);
    for (const row of rows) {
      await appendEvent(tx, {
        companyId,
        projectId: row.project_id,
        taskId: row.id,
        type: 'task.cancelled',
        actor: 'owner',
        payload: {
          haltReason: 'owner_cancel',
          ...(row.id === taskId ? {} : { under: taskId }),
          ...(why ? { reason: why } : {}),
        },
      });
    }
    return rows.length;
  });
}

/**
 * Does a task again, with the owner's note, and returns the new task.
 *
 * A new task rather than the old one revived: a halted task stays halted
 * (section 6.3 -- it is never resumed), so its history stays true, and the new
 * one is the same work -- role, input, goal -- with a record of why it exists.
 * The note is not written into the input, which is the role's contract and
 * may not have room for it; it is an instruction on the new task, which the
 * context puts in front of every run of it with what became of the last.
 *
 * Once per task: a second press returns the task the first one made, so a
 * double tap is not two of everything.
 */
export async function rerunTask(companyId: string, taskId: string, note?: string | null): Promise<string> {
  const previous = await taskHere(companyId, taskId);
  if (!isTerminal(previous.status)) {
    throw new PalugadaError(
      'contract.violation',
      `task ${taskId} is still ${previous.status}; cancel it first`,
      { taskId, status: previous.status },
    );
  }
  const text = (note ?? '').trim();
  if (text.length > INSTRUCTION_MAX) {
    throw new PalugadaError('contract.violation', `a note is at most ${INSTRUCTION_MAX} characters`, { field: 'note' });
  }
  const key = `rerun:${taskId}`;
  // F8.9: the new task is a root the owner made, and its chain says nothing
  // of how the first one began. Its input is the first one's -- a webhook's
  // event, a brief written after reading an email -- so what the first one
  // carried, it carries: pressing "do it again" on a send the owner refused
  // must not send it unasked.
  const carried = await withTenant(companyId, (tx) => outsideContentIn(tx, taskId));
  const carries = carried === null ? undefined
    : { capability: 'the task it reruns', from: carried, rerunOf: taskId };
  const already = await withTenant(companyId, (tx) =>
    tx.query<{ id: string }>('SELECT id FROM tasks WHERE idempotency_key = $1', [key]));
  if (already.rows[0]) return already.rows[0].id;

  const { task } = await assignTask({
    companyId,
    projectId: previous.projectId,
    divisionId: previous.divisionId,
    roleId: previous.roleId,
    goalId: previous.goalId ?? undefined,
    input: previous.input,
    createdBy: 'owner',
    idempotencyKey: key,
    carriesOutside: carries,
    priority: previous.priority,
    detail: `the owner asked for task ${taskId} again`,
  });
  await withTenant(companyId, async (tx) => {
    await appendEvent(tx, {
      companyId,
      projectId: task.projectId,
      taskId: task.id,
      type: 'owner.instructed',
      actor: 'owner',
      payload: {
        text,
        rerunOf: taskId,
        previous: { status: previous.status, haltReason: previous.haltReason },
      },
    });
    await appendEvent(tx, {
      companyId,
      projectId: previous.projectId,
      taskId,
      type: 'task.rerun',
      actor: 'owner',
      payload: { rerunTaskId: task.id },
    });
  });
  return task.id;
}

/**
 * Goes on with a task its budget stopped, from where it stopped.
 *
 * Section 6.3 says such a task is never resumed *automatically*; it goes to
 * the owner. The owner may go on with it, and until now the only way was
 * `rerunTask`: the same work as a new task from nothing. On a live run that
 * threw away a CEO's 292k tokens of routing for want of a few thousand more.
 * Going on is the same task, so its journal is its own: committed steps are
 * answered from the record (F5.1) and nothing that already happened happens
 * again, as after a crash. The history stays true -- the halt and the
 * continuation are both events on it.
 *
 * Only a budget halt. A hop limit, a deadline or a failed read-back are
 * answers about the work, not about money, and going on would meet them
 * again; those are done again or let go. Refused, with what to do, while the
 * account still cannot fund the task's reservation, while the company's month
 * is paused, and while its role is frozen. The `transition` path does not
 * reach this: `halted` has no way out in the state machine, and this is the
 * one door, opened by the owner.
 */
export async function continueHalted(companyId: string, taskId: string): Promise<void> {
  const task = await taskHere(companyId, taskId);
  const refuse = (status: string, reason: string | null) => new PalugadaError(
    'task.not_continuable',
    `task ${taskId} is ${status}${reason ? ` (${reason})` : ''}; only work its budget stopped is continued where it `
      + 'stopped, and anything else is done again',
    { taskId, status, haltReason: reason },
  );
  if (task.status !== 'halted' || task.haltReason !== 'budget_exhausted') throw refuse(task.status, task.haltReason);
  if (await isSpendPaused(companyId)) {
    throw new PalugadaError('spend.paused',
      'the company has reached its monthly spending ceiling; raise it or grant an override before going on', { companyId });
  }
  await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ status: TaskStatus; halt_reason: string | null; budget_account_id: string; frozen: boolean }>(
      `SELECT t.status, t.halt_reason, t.budget_account_id, r.frozen_at IS NOT NULL AS frozen
         FROM tasks t JOIN roles r ON r.id = t.role_id
        WHERE t.id = $1 AND t.company_id = $2
        FOR NO KEY UPDATE OF t`,
      [taskId, companyId],
    );
    const row = rows[0]!;
    // A second press, or one racing the first: the task has moved on.
    if (row.status !== 'halted' || row.halt_reason !== 'budget_exhausted') throw refuse(row.status, row.halt_reason);
    if (row.frozen) {
      throw new PalugadaError('role.frozen', 'its role is frozen; unfreeze the role before going on with its work', { taskId });
    }
    const funded = await tx.query<{ ok: boolean }>(
      'SELECT app.budget_reserve($1, $2) AS ok', [row.budget_account_id, DEFAULT_TASK_RESERVE_TOKENS]);
    if (!funded.rows[0]!.ok) {
      throw new PalugadaError('budget.reservation_refused',
        'its budget account still cannot fund it: its tokens are spent or held up to its ceiling. '
          + 'Raise the ceiling under Money first',
        { budgetAccountId: row.budget_account_id, reserveTokens: DEFAULT_TASK_RESERVE_TOKENS });
    }
    await tx.query(
      `UPDATE tasks
          SET status = 'pending', halt_reason = NULL, finished_at = NULL, wait_until = NULL,
              tokens_reserved = $2,
              -- The time it was stopped is not held against it: a delegated
              -- child's hour is for the work, and the next sweep would have
              -- halted it for the hours the owner took to raise the ceiling.
              deadline_at = deadline_at + (now() - finished_at)
        WHERE id = $1`,
      [taskId, DEFAULT_TASK_RESERVE_TOKENS],
    );
    await appendEvent(tx, {
      companyId, projectId: task.projectId, taskId, type: 'task.continued', actor: 'owner',
      payload: { reservedTokens: DEFAULT_TASK_RESERVE_TOKENS },
    });
    // The card that said it stopped has been answered by going on.
    const { rows: withdrawn } = await tx.query<{ id: string }>(
      `UPDATE inbox_items SET status = 'withdrawn', closed_reason = 'task_continued'
        WHERE task_id = $1 AND company_id = $2 AND kind = 'budget_alert' AND status = 'open'
        RETURNING id`,
      [taskId, companyId],
    );
    for (const item of withdrawn) {
      await appendEvent(tx, {
        companyId, projectId: task.projectId, taskId, type: 'inbox.withdrawn', actor: 'system',
        payload: { inboxItemId: item.id, closedReason: 'task_continued' },
      });
    }
    // A ticket the halt put back on the board, and nobody has taken since,
    // is this task's again (0070).
    const { rows: tickets } = await tx.query<{ id: string }>(
      `UPDATE tickets SET status = 'in_progress', working_task_id = $1, closed_reason = NULL, updated_at = now()
        WHERE company_id = $2 AND status = 'open' AND working_task_id IS NULL
          AND id IN (SELECT (payload->>'ticketId')::uuid FROM events
                      WHERE task_id = $1 AND company_id = $2 AND type = 'ticket.reopened')
        RETURNING id`,
      [taskId, companyId],
    );
    for (const ticket of tickets) {
      await appendEvent(tx, {
        companyId, projectId: task.projectId, taskId, type: 'ticket.started', actor: 'system', payload: { ticketId: ticket.id },
      });
    }
  });
  await enqueueWake({ companyId, roleId: task.roleId, reason: 'event', detail: `the owner continued task ${taskId}` });
}

/**
 * Goes on with every task an account's budget stopped, oldest first, for as
 * many as the account can now fund (STATUS 2.155).
 *
 * A division that runs out stops everything charged to it together, and going
 * on with each by hand -- open the task, press Continue -- was the owner's whole
 * afternoon. This is that, once: each task through `continueHalted`, which
 * keeps every rule it has (a paused company, a frozen role, the reservation
 * the account must fund). The first account with no room ends it: those not
 * reached are said to be waiting for room, and the card that names the account
 * stays for them. Nothing here raises a ceiling; that is the owner's, with a
 * code, in the route.
 */
export async function continueAllHalted(companyId: string, accountId: string): Promise<{
  continued: number;
  skipped: Array<{ taskId: string; code: string; message: string }>;
}> {
  const stopped = await withControlPlane(async (tx) => {
    const { rows: account } = await tx.query('SELECT 1 FROM budget_accounts WHERE id = $1 AND company_id = $2', [accountId, companyId]);
    if (account.length === 0) {
      throw new PalugadaError('contract.violation', 'this company has no budget account with that id', { accountId });
    }
    const { rows } = await tx.query<{ id: string }>(
      `SELECT t.id FROM tasks t
        WHERE t.company_id = $1 AND t.status = 'halted' AND t.halt_reason = 'budget_exhausted'
          AND $2::uuid = ANY(app.budget_chain(t.budget_account_id))
        ORDER BY t.finished_at NULLS FIRST, t.created_at, t.id`,
      [companyId, accountId]);
    return rows.map((row) => row.id);
  });
  let continued = 0;
  let noRoom = false;
  const skipped: Array<{ taskId: string; code: string; message: string }> = [];
  for (const taskId of stopped) {
    if (noRoom) {
      skipped.push({ taskId, code: 'budget.reservation_refused', message: 'waiting for room: the account has none left to fund it' });
      continue;
    }
    try {
      await continueHalted(companyId, taskId);
      continued += 1;
    } catch (failure) {
      if (!(failure instanceof PalugadaError)) throw failure;
      skipped.push({ taskId, code: failure.code, message: failure.message });
      // Nothing after it is funded either, whichever ceiling it was that held.
      if (failure.code === 'budget.reservation_refused' || failure.code === 'spend.paused') noRoom = true;
    }
  }
  // Going on with the task a card names answers that card; the account's card
  // is for those still stopped, so it is raised again at the first of them.
  if (skipped.length > 0) {
    const { raiseBudgetHalt } = await import('../inbox/inbox.ts');
    await raiseBudgetHalt(companyId, skipped[0]!.taskId);
  }
  return { continued, skipped };
}

/**
 * Tells a task something: "lead with the price change", "the supplier is the
 * one in Bandung". Read by the task's next run -- when it resumes from a wait,
 * or on its next attempt -- and by every run after it.
 *
 * It is an event on the task and not a message to an agent (agents do not
 * message agents, and nor does this), and it changes nothing the broker
 * decides: the grants, the tier and the budget are what they were. Work that
 * has ended is done again with a note instead.
 */
export async function instructTask(companyId: string, taskId: string, instruction: string): Promise<void> {
  const text = String(instruction ?? '').trim();
  if (!text) {
    throw new PalugadaError('contract.violation', 'say something to tell the task', { field: 'text' });
  }
  if (text.length > INSTRUCTION_MAX) {
    throw new PalugadaError('contract.violation', `an instruction is at most ${INSTRUCTION_MAX} characters`, { field: 'text' });
  }
  const task = await taskHere(companyId, taskId);
  if (isTerminal(task.status)) {
    throw new PalugadaError(
      'contract.violation',
      `task ${taskId} is already ${task.status}; do it again with a note instead`,
      { taskId },
    );
  }
  await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM events WHERE task_id = $1 AND type = 'owner.instructed'",
      [taskId],
    );
    if ((rows[0]?.n ?? 0) >= INSTRUCTIONS_PER_TASK) {
      throw new PalugadaError(
        'contract.violation',
        `this task has had ${INSTRUCTIONS_PER_TASK} instructions; cancel it and do it again with one note instead`,
        { taskId },
      );
    }
    await appendEvent(tx, {
      companyId,
      projectId: task.projectId,
      taskId,
      type: 'owner.instructed',
      actor: 'owner',
      payload: { text },
    });
  });
}

/** What the owner has told a task, oldest first, for the run that reads it. */
export async function instructionsFor(
  tx: TenantClient,
  taskId: string,
): Promise<Array<{ text: string; rerunOf: string | null; previous: { status: TaskStatus; haltReason: string | null } | null }>> {
  const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE task_id = $1 AND type = 'owner.instructed'
      ORDER BY occurred_at, id`,
    [taskId],
  );
  return rows.map(({ payload }) => ({
    text: typeof payload.text === 'string' ? payload.text : '',
    rerunOf: typeof payload.rerunOf === 'string' ? payload.rerunOf : null,
    previous: payload.previous && typeof payload.previous === 'object'
      ? payload.previous as { status: TaskStatus; haltReason: string | null }
      : null,
  }));
}

/** How far back a rerun reads the attempts before it. */
const LINEAGE_MAX = 10;

/**
 * The earlier attempts at the same work, nearest first: the task this one
 * was asked for again in place of, the one that one replaced, and so on
 * (L6). What the owner said to any of them is still true of this one -- a
 * price given in an answer to the first attempt is the price for the third.
 */
export async function earlierAttempts(tx: TenantClient, taskId: string): Promise<string[]> {
  const chain: string[] = [];
  let current = taskId;
  while (chain.length < LINEAGE_MAX) {
    const { rows } = await tx.query<{ rerun_of: string | null }>(
      `SELECT payload->>'rerunOf' AS rerun_of FROM events
        WHERE task_id = $1 AND type = 'owner.instructed' AND payload ? 'rerunOf'
        ORDER BY occurred_at, id LIMIT 1`,
      [current],
    );
    const previous = rows[0]?.rerun_of;
    if (!previous || previous === taskId || chain.includes(previous)) break;
    chain.push(previous);
    current = previous;
  }
  return chain;
}

/**
 * The earlier attempts at this work that did not finish, nearest first: those
 * before it, up to the last one that did (N12).
 *
 * What they did in the world still stands, and doing the work again means
 * finishing it: a rerun is told what they wrote, is answered from their
 * record when it makes the same write, and sends a write that never answered
 * under the key it was first sent with. An attempt that finished is where
 * this stops. The owner saw that work done, and asking for it again is
 * asking for it to be done again -- the newsletter sent once more, the
 * report written afresh.
 */
export async function unfinishedAttempts(tx: TenantClient, taskId: string): Promise<string[]> {
  const earlier = await earlierAttempts(tx, taskId);
  if (earlier.length === 0) return [];
  const { rows } = await tx.query<{ id: string; status: TaskStatus }>(
    'SELECT id, status FROM tasks WHERE id = ANY($1::uuid[])', [earlier]);
  const status = new Map(rows.map((row) => [row.id, row.status]));
  const unfinished: string[] = [];
  for (const attempt of earlier) {
    if (status.get(attempt) === 'completed') break;
    unfinished.push(attempt);
  }
  return unfinished;
}

export type Verdict = 'good' | 'needs_work';

/**
 * The owner's word on finished work.
 *
 * Buzz lets a person react to what an agent posted; here a reaction is worth
 * something only if the company learns from it. A verdict with a reason is
 * written as the owner's own way to work, for the division that did the
 * task, at full confidence -- the owner's word needs no review -- so the
 * division's next run reads it beside its procedures. A second word on the
 * same task supersedes the first rather than standing beside it: "under 150
 * words, and lead with the price" replaces "too long", and a run told both
 * would be told something the owner no longer thinks. Praise with no reason
 * is recorded and teaches nothing, because there is nothing in it to do.
 */
export async function giveFeedback(
  companyId: string,
  taskId: string,
  input: { verdict: Verdict; note?: string | null },
): Promise<void> {
  if (input.verdict !== 'good' && input.verdict !== 'needs_work') {
    throw new PalugadaError('contract.violation', 'a verdict is good or needs_work', { field: 'verdict' });
  }
  const note = String(input.note ?? '').trim();
  if (input.verdict === 'needs_work' && !note) {
    throw new PalugadaError(
      'contract.violation', 'say what to do differently; that is what the division will read', { field: 'note' },
    );
  }
  if (note.length > INSTRUCTION_MAX) {
    throw new PalugadaError('contract.violation', `a note is at most ${INSTRUCTION_MAX} characters`, { field: 'note' });
  }
  const task = await taskHere(companyId, taskId);
  if (!isTerminal(task.status)) {
    throw new PalugadaError(
      'contract.violation', `task ${taskId} is still ${task.status}; tell it something instead`, { taskId },
    );
  }
  await withTenant(companyId, async (tx) => {
    const { rows: role } = await tx.query<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [task.roleId]);
    const { rows: earlier } = await tx.query<{ memory_id: string | null }>(
      `SELECT payload->>'memoryId' AS memory_id FROM events
        WHERE task_id = $1 AND type = 'owner.feedback' ORDER BY occurred_at DESC LIMIT 1`,
      [taskId],
    );
    let memoryId: string | null = null;
    if (note) {
      const goal = typeof task.input.goal === 'string' ? task.input.goal : 'a task';
      const lesson = {
        companyId,
        memoryType: 'procedural' as const,
        scopeType: 'division' as const,
        scopeId: task.divisionId,
        body: `The owner on ${role[0]?.slug ?? 'a role'}'s work "${goal.slice(0, 200)}": `
          + `${input.verdict === 'good' ? 'this was good' : 'this needs work'}. ${note}`,
        confidence: 1,
        source: 'owner',
      };
      const previous = earlier[0]?.memory_id ?? null;
      memoryId = previous ? await supersede(tx, previous, lesson) : await remember(tx, lesson);
    }
    await appendEvent(tx, {
      companyId,
      projectId: task.projectId,
      taskId,
      type: 'owner.feedback',
      actor: 'owner',
      payload: { verdict: input.verdict, note, memoryId },
    });
  });
}
