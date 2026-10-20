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
 *
 * Nor with work that has nobody left to do it for (the review of 20
 * October): a task the owner already ran again, whose new task does the work,
 * and a child whose parent ended while it waited, whose answer would go
 * nowhere. Those wait for the owner's own press, or for nothing.
 */
import { adminPool } from '../db/pool.ts';
import { withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';
import { startNewPeriods } from './budget.ts';
import { GOES_ON_BY_ITSELF, continueHalted } from './owner-control.ts';
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
  /** Every account the task draws on, its own first: the room is the room of all of them. */
  chain: string[];
  /** Whether nothing but room keeps it: its role works, and it has not gone on three times today. */
  ready: boolean;
}

/**
 * Goes on with the work a company's budget stopped, as far as the room under
 * its owner's ceilings goes. Returns how many went on and how many are still
 * waiting for room (or for the owner).
 */
export async function resumeBudgetStopped(companyId: string, now = new Date()): Promise<{ continued: number; waiting: number }> {
  // A passed month's counts start again first, so that the room read below is this month's.
  await startNewPeriods(companyId);
  // One look at a time for a company. Two workers looking together would each
  // count the same room and spend it twice; the second finds the first looking
  // and leaves the room to it. Held on a connection of its own for the whole
  // look, since each task goes on in a transaction of its own.
  const lock = await adminPool().connect();
  let broken = false;
  try {
    const { rows } = await lock.query<{ mine: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS mine', [`self-heal:${companyId}`]);
    if (!rows[0]!.mine) return { continued: 0, waiting: 0 };
    try {
      return await look(companyId, now);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`self-heal:${companyId}`])
        .catch(() => { broken = true; });
    }
  } finally {
    // A lock that could not be given back goes with its connection.
    lock.release(broken);
  }
}

async function look(companyId: string, now: Date): Promise<{ continued: number; waiting: number }> {
  const { stopped, room } = await withTenant(companyId, async (tx) => {
    // Those that cannot go on by themselves -- a paused role, three goes today
    // -- are counted but sorted after the rest, so that however many there
    // are, they never stand in front of one that can.
    const { rows } = await tx.query<Stopped>(
      `SELECT t.id, app.budget_chain(t.budget_account_id)::text[] AS chain,
              (r.frozen_at IS NULL AND
               (SELECT count(*) FROM events e
                 WHERE e.task_id = t.id AND e.type = 'task.continued' AND e.actor = 'system'
                   AND e.occurred_at > $1::timestamptz - interval '1 day') < $2) AS ready
         FROM tasks t JOIN roles r ON r.id = t.role_id
        WHERE t.status = 'halted' AND t.halt_reason = 'budget_exhausted' AND ${GOES_ON_BY_ITSELF}
        ORDER BY 3 DESC, t.finished_at NULLS FIRST, t.created_at, t.id`,
      [now, MAX_RESUMES_A_DAY]);
    const accounts = [...new Set(rows.filter((row) => row.ready).flatMap((row) => row.chain))];
    const { rows: left } = await tx.query<{ id: string; tokens: string; money: string }>(
      `SELECT id, (tokens_max - tokens_spent - tokens_reserved)::text AS tokens,
              (money_max_cents - money_spent_cents)::text AS money
         FROM budget_accounts WHERE id = ANY($1::uuid[])`,
      [accounts]);
    // What each account can carry, in runs: its room over what a run needs.
    const room = new Map(left.map((row) => [row.id, Math.min(
      Math.floor(Number(row.tokens) / MIN_ROOM_TOKENS), Math.floor(Number(row.money) / MIN_ROOM_CENTS))]));
    return { stopped: rows, room };
  });
  if (stopped.length === 0) return { continued: 0, waiting: 0 };
  if (await isSpendPaused(companyId, now)) return { continued: 0, waiting: stopped.length };

  let continued = 0;
  let outOfRoom = false;
  for (const task of stopped) {
    if (outOfRoom || !task.ready || continued >= MAX_PER_LOOK) continue;
    // A run is carried by every account above it, not only its own: two
    // divisions under one company account share the company's room, and each
    // run that goes on takes its share from all of them.
    if (!task.chain.every((account) => (room.get(account) ?? 0) >= 1)) continue;
    try {
      await continueHalted(companyId, task.id, 'system');
      for (const account of task.chain) room.set(account, room.get(account)! - 1);
      continued += 1;
    } catch (failure) {
      if (!(failure instanceof PalugadaError)) throw failure;
      // Nothing after it is funded either.
      if (failure.code === 'spend.paused' || failure.code === 'budget.reservation_refused') outOfRoom = true;
    }
  }
  return { continued, waiting: stopped.length - continued };
}
