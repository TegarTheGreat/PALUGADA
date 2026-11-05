/**
 * Postmortems: a failure with a cause worth finding becomes an issue the
 * company solves (F18.4; Google SRE's blameless postmortem).
 *
 * An incident told the owner that work had stopped and asked them to run it
 * again; an escalation told the coordinator to "fix the cause" in free text.
 * Neither left anything behind once it was answered: the same crash loop in
 * the same seat next week was a new card, with nothing to say it had happened
 * before or what had been decided about it. Now the platform files an issue
 * beside the card, in the same transaction, for the failures that have a
 * cause outside the moment:
 *
 *  - a task that keeps killing its worker (`crash_loop`, src/engine/checkout.ts);
 *  - a write that did not read back as written (`verification_failed`,
 *    src/engine/engine.ts), the owner's "the write may have happened";
 *  - a budget account that ran out (src/inbox/inbox.ts, `raiseBudgetHaltWithin`);
 *  - root work that ended badly with nothing else raised for it
 *    (src/engine/ended.ts), which is every other way a task stops short.
 *
 * Deduplicated by source while the issue is open (`fileIssue`): the same
 * failure in the same seat -- or the same account out of money -- is one
 * issue seen again, not one a time. Filed by the platform, not by the owner
 * or a run, and about the task the failure was about, which the ticket links
 * rather than quotes (`postmortemIssue`), so no customer's name is put in it.
 *
 * What it does not do is solve anything: the CEO finds the cause and decides
 * at the weekly meeting, or the owner closes it. An issue starts no task and
 * spends nothing (F9.10).
 */
import type { TenantClient } from '../db/tenant.ts';
import { ownerReadingWithin, postmortemIssue, roleCalledWithin, type PostmortemHow } from '../owner/platform-cards.ts';
import { fileIssue } from './tickets.ts';

/**
 * Files the postmortem for a failure of `taskId`, or records it against the
 * one still open from the same source. Returns the issue's id, or null when
 * the task is not this company's. Every statement names the company: a
 * budget card is raised again on the control plane (`continueHalted`).
 */
export async function filePostmortemWithin(tx: TenantClient, input: {
  companyId: string;
  taskId: string;
  how: PostmortemHow;
  /** The halt reason, or null for a task that failed. */
  reason: string | null;
  /** The card the owner or the coordinator was shown for it. */
  inboxItemId: string | null;
  /** For a crash loop: how many workers it took down. */
  lost?: number;
  /** For a budget: the account that ran out, which is the source, and what it is called. */
  budget?: { accountId: string; name: string | null };
}): Promise<string | null> {
  const { rows } = await tx.query<{ project_id: string; division_id: string; role_id: string | null }>(
    'SELECT project_id, division_id, role_id FROM tasks WHERE company_id = $1 AND id = $2', [input.companyId, input.taskId]);
  const task = rows[0];
  if (!task) return null;
  const role = task.role_id ? await roleCalledWithin(tx, { id: task.role_id }) : '';
  // The same failure in the same seat, or the same account out of money.
  const sourceKey = input.budget
    ? `budget:${input.budget.accountId}`
    : `task:${input.reason ?? 'failed'}:${task.role_id ?? 'none'}`;
  const words = postmortemIssue(await ownerReadingWithin(tx), {
    how: input.how, reason: input.reason, role, about: input.budget?.name ?? role,
    ...(input.lost === undefined ? {} : { lost: input.lost }),
  });
  const filed = await fileIssue(tx, {
    companyId: input.companyId,
    projectId: task.project_id,
    divisionId: task.division_id,
    title: words.title.slice(0, 200),
    body: words.body,
    // A failure that stopped work outright comes before one that ended it short.
    priority: input.how === 'ended' ? 2 : 1,
    sourceKey,
    fromInboxItemId: input.inboxItemId,
    openedBy: 'platform',
    openedByTaskId: input.taskId,
    // The platform's own words only: the record is on the card it links.
    outside: false,
  });
  return filed.ticket.id;
}
