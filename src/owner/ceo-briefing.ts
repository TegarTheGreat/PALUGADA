/**
 * A CEO that speaks first when its owner comes back.
 *
 * The owner gave the company work, went away, and came back to a chat exactly
 * as they left it. What finished, what stopped and what waits for them was
 * something to go and ask about, one question at a time -- which is what an
 * ordinary chatbot is. So when the owner opens the conversation after being
 * away and something has happened since the last word in it, the CEO says
 * what, once.
 *
 * **What it says is the platform's own arithmetic**, not a model's account:
 * how many things finished, why work stopped, how many wait for the owner, and
 * the owner's own words for the work they gave. It costs nothing, it cannot
 * be wrong about a number, and it is the same in every language the platform
 * speaks. Nothing an agent or a stranger wrote is in it. It is kept as the
 * CEO's own message, and the model reads its history back as its own words; an
 * agent's summary there would be where a stranger's instruction got in, which
 * is why a task's result is one question away rather than quoted here, and why
 * only the owner's own tasks are named, never a webhook's or a schedule's.
 */
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { ceoSaysIn } from './ceo-language.ts';
import { haltSaid } from './halt-said.ts';
import { say } from './say.ts';

/** Someone who spoke in the last half hour has not been away. */
const AWAY_MS = 30 * 60_000;
/** How many finished pieces of work are named; the rest are counted. */
const NAMED = 3;
/** How many reasons for stopping are told; the commonest first. */
const REASONS = 3;
/** The owner's own words for the work, as long as a line should be. */
const GOAL_CHARS = 120;
/** A stop the owner made is not news to them. */
const THEIR_OWN_STOPS = ['owner_stop', 'owner_cancel'];

interface News {
  finished: string[];
  stopped: Array<{ reason: string | null; count: number }>;
  waiting: number;
  fresh: number;
}

async function newsSince(companyId: string, since: string): Promise<News> {
  return withTenant(companyId, async (tx) => {
    // Root tasks only: what the owner gave, and what the company set going
    // itself. A step an agent handed on is part of one of these, not news.
    const finished = await tx.query<{ goal: string | null }>(
      `SELECT t.input->>'goal' AS goal FROM tasks t
        WHERE t.company_id = $1 AND t.parent_task_id IS NULL AND t.created_by = 'owner'
          AND t.status = 'completed' AND t.finished_at > $2::timestamptz
        ORDER BY t.finished_at`,
      [companyId, since]);
    const stopped = await tx.query<{ reason: string | null; count: string }>(
      `SELECT t.halt_reason AS reason, count(*)::text AS count FROM tasks t
        WHERE t.company_id = $1 AND t.parent_task_id IS NULL AND t.status IN ('failed', 'halted')
          AND t.finished_at > $2::timestamptz AND (t.halt_reason IS NULL OR NOT (t.halt_reason = ANY($3)))
        GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT $4`,
      [companyId, since, THEIR_OWN_STOPS, REASONS]);
    const waiting = await tx.query<{ open: string; fresh: string }>(
      `SELECT count(*)::text AS open, count(*) FILTER (WHERE created_at > $2::timestamptz)::text AS fresh
         FROM inbox_items
        WHERE company_id = $1 AND status = 'open' AND (snoozed_until IS NULL OR snoozed_until <= now())`,
      [companyId, since]);
    return {
      finished: finished.rows.map((row) => (row.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, GOAL_CHARS)),
      stopped: stopped.rows.map((row) => ({ reason: row.reason, count: Number(row.count) })),
      waiting: Number(waiting.rows[0]!.open),
      fresh: Number(waiting.rows[0]!.fresh),
    };
  });
}

/** What the CEO says, in `language`: a heading and one line for each thing that happened. */
export function briefingSaid(language: string, news: News): string {
  const lines = [say(language, 'Since we last spoke:')];
  for (const goal of news.finished.slice(0, NAMED)) {
    lines.push(`- ${say(language, 'Done: {goal}', { goal: goal || say(language, 'a task') })}`);
  }
  if (news.finished.length > NAMED) {
    lines.push(`- ${say(language, 'More finished: {count}', { count: String(news.finished.length - NAMED) })}`);
  }
  for (const stop of news.stopped) {
    lines.push(`- ${say(language, 'Stopped ({count}): {reason}', { count: String(stop.count), reason: haltSaid(language, stop.reason) })}`);
  }
  if (news.waiting > 0) lines.push(`- ${say(language, 'Waiting for you: {count}', { count: String(news.waiting) })}`);
  return lines.join('\n');
}

/**
 * Says what happened while the owner was away, if anything did and they were.
 * True when the CEO spoke.
 *
 * A company with no conversation yet is not briefed -- a new company's CEO
 * opens it, in first-hour.ts -- and nobody is who has no CEO. The message is
 * written only if no word has been said in the conversation since the time it
 * was measured from, so two tabs opening at once make one briefing between
 * them.
 */
export async function ceoBriefsOwner(companyId: string, options: { now?: Date } = {}): Promise<boolean> {
  const now = options.now ?? new Date();
  const last = (await withControlPlane((tx) => tx.query<{ at: string; away: boolean }>(
    `SELECT at::text AS at, at <= $2::timestamptz - make_interval(secs => $3) AS away
       FROM assistant_messages WHERE company_id = $1 ORDER BY at DESC LIMIT 1`,
    [companyId, now, AWAY_MS / 1000]))).rows[0];
  if (!last?.away) return false;
  const hasCeo = (await withControlPlane((tx) => tx.query(
    "SELECT 1 FROM roles WHERE company_id = $1 AND title = 'CEO'", [companyId]))).rowCount === 1;
  if (!hasCeo) return false;

  const news = await newsSince(companyId, last.at);
  if (news.finished.length === 0 && news.stopped.length === 0 && news.fresh === 0) return false;

  const body = briefingSaid(await ceoSaysIn(companyId), news);
  const written = await withControlPlane((tx) => tx.query(
    `INSERT INTO assistant_messages (role, channel, body, company_id)
     SELECT 'assistant', 'console', $2, $1
      WHERE NOT EXISTS (SELECT 1 FROM assistant_messages WHERE company_id = $1 AND at > $3::timestamptz)`,
    [companyId, body, last.at]));
  return written.rowCount === 1;
}
