/**
 * Work its budget stopped goes on by itself when there is room again (the
 * owner's report of 7 October).
 *
 * Section 6.3 said a task whose budget runs out "is never resumed
 * automatically", and the owner's way back was three decisions in a row: raise
 * a ceiling, lift the pause, go on with each account's work. What the owner
 * decides is the ceiling. Raising it, a new month beginning, a pause lifted --
 * each makes room under a limit the owner set, and the work the limit stopped
 * going on is only its consequence; asking for it again is asking the owner to
 * be the scheduler of a company that was meant to run itself.
 *
 * What stays the owner's is the ceiling, and this never moves one. It goes on
 * only with work that has room to make progress in (not a reservation's
 * worth, which stops again in a minute), never while the month is paused,
 * never for a role the owner paused, and never in a loop: a task that has gone
 * on by itself three times in a day and stopped again has told the owner
 * something, and its card stays for them.
 */
import { withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';
import { startNewPeriods } from './budget.ts';
import { continueHalted } from './owner-control.ts';
import { DEFAULT_TASK_RESERVE_TOKENS } from './tasks.ts';

/** The tokens an account must have left, beyond a reservation, for work to go on: what a run makes progress in. */
export const MIN_ROOM_TOKENS = 20 * DEFAULT_TASK_RESERVE_TOKENS;
/** The money, in cents, the same: a dollar is a run's worth on most models, now that a call costs what it cost. */
export const MIN_ROOM_CENTS = 100;
/** How many times in a day a task may go on by itself. */
export const MAX_RESUMES_A_DAY = 3;
/** The most one look takes up, so a company that ran out with hundreds waiting is not restarted in one breath. */
const MAX_PER_LOOK = 25;

interface Stopped {
  id: string;
  account: string;
  tokens_room: string;
  money_room: string;
  frozen: boolean;
  resumed: string;
}

/**
 * Goes on with the work a company's budget stopped, as far as the room under
 * its owner's ceilings goes. Returns how many went on and how many are still
 * waiting for room (or for the owner).
 */
export async function resumeBudgetStopped(companyId: string, now = new Date()): Promise<{ continued: number; waiting: number }> {
  // A passed month's counts start again first, so that the room read below is this month's.
  await startNewPeriods(companyId);
  const stopped = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<Stopped>(
      `SELECT t.id, t.budget_account_id AS account,
              (SELECT min(a.tokens_max - a.tokens_spent - a.tokens_reserved)
                 FROM budget_accounts a WHERE a.id = ANY(app.budget_chain(t.budget_account_id)))::text AS tokens_room,
              (SELECT min(a.money_max_cents - a.money_spent_cents)
                 FROM budget_accounts a WHERE a.id = ANY(app.budget_chain(t.budget_account_id)))::text AS money_room,
              r.frozen_at IS NOT NULL AS frozen,
              (SELECT count(*) FROM events e
                WHERE e.task_id = t.id AND e.type = 'task.continued' AND e.actor = 'system'
                  AND e.occurred_at > $1::timestamptz - interval '1 day')::text AS resumed
         FROM tasks t JOIN roles r ON r.id = t.role_id
        WHERE t.status = 'halted' AND t.halt_reason = 'budget_exhausted'
        ORDER BY t.finished_at NULLS FIRST, t.created_at, t.id
        LIMIT $2`,
      [now, MAX_PER_LOOK]);
    return rows;
  });
  if (stopped.length === 0) return { continued: 0, waiting: 0 };
  if (await isSpendPaused(companyId, now)) return { continued: 0, waiting: stopped.length };

  // What an account can carry, in runs: the room under every ceiling above it,
  // over what a run needs, and fewer as each one goes on.
  const carry = new Map<string, number>();
  let continued = 0;
  let waiting = 0;
  let outOfRoom = false;
  for (const task of stopped) {
    if (outOfRoom || task.frozen || Number(task.resumed) >= MAX_RESUMES_A_DAY) {
      waiting += 1;
      continue;
    }
    if (!carry.has(task.account)) {
      carry.set(task.account, Math.min(
        Math.floor(Number(task.tokens_room) / MIN_ROOM_TOKENS),
        Math.floor(Number(task.money_room) / MIN_ROOM_CENTS)));
    }
    const left = carry.get(task.account)!;
    if (left < 1) {
      waiting += 1;
      continue;
    }
    try {
      await continueHalted(companyId, task.id, 'system');
      carry.set(task.account, left - 1);
      continued += 1;
    } catch (failure) {
      if (!(failure instanceof PalugadaError)) throw failure;
      waiting += 1;
      // Nothing after it is funded either.
      if (failure.code === 'spend.paused' || failure.code === 'budget.reservation_refused') outOfRoom = true;
    }
  }
  return { continued, waiting };
}
