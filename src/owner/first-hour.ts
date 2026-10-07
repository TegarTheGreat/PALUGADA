/**
 * The owner's first hour with a new company (the analysis of 3 October, §9
 * P1 item 10).
 *
 * A company started from the console opened on an Overview of zeros: no
 * conversation, no first piece of work, nothing that said what to do next,
 * and a CEO that could not speak until spoken to. Now the CEO opens the
 * conversation with the three things it needs to know, and interviews before
 * it proposes while the first hour lasts (assistant.ts); the Overview lists
 * four steps, each ticked off by what the owner has actually done -- not by
 * a button that says so -- until all are done or the owner closes the list
 * (0109).
 */
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { say } from './say.ts';

export type FirstHourStep = 'talk' | 'budget' | 'work' | 'result';

export interface FirstHour {
  /** Whether the Overview shows the list: not every step done, and not closed. */
  open: boolean;
  steps: Array<{ step: FirstHourStep; done: boolean }>;
}

/**
 * What the CEO says first to the owner of a company it has just been made CEO
 * of. When the owner already said what the company is for -- the console asks
 * when it starts one -- the CEO says it back and does not ask what the company
 * sells: it asks for the two things it cannot know, and offers to suggest the
 * first piece of work and the team it would take.
 */
export function firstHourOpener(language: string | null, facts: { ceo: string; company: string; mission?: string | null }): string {
  const { mission, ...rest } = facts;
  if (mission) {
    return say(language,
      'I am {ceo}, and I run {company} for you. I know what it is for: “{mission}” Two things before we start: how much may it spend in a month? And what should its first piece of work be -- or shall I suggest one, and the team it would take?',
      { ...rest, mission });
  }
  return say(language,
    'I am {ceo}, and I run {company} for you. Three things before we start: what does {company} sell, and to whom? How much may it spend in a month? And what should its first piece of work be -- or shall I suggest one?',
    rest);
}

/**
 * What the CEO is told while the first hour lasts. Written for the model:
 * an interview it keeps short, then the fewest cards that turn the answers
 * into a company that is working on something real.
 */
export function firstHourBrief(companyId: string): string {
  const base = `/api/companies/${companyId}`;
  return [
    'This company is new: this is its first hour with its owner. You opened the conversation by asking what it sells and to whom, how much it may spend in a month, and what its first piece of work should be -- or, when the owner had already said what the company is for (it is the mission above), only the last two.',
    'Get those answers with as few questions as you can -- never more than three in all, one short message at a time, and none the owner has already answered.',
    `Then propose them together, as cards: the mission reworded in the owner's words (POST ${base}/goals/:goalId, with the mission's id from the structure), the monthly ceiling (POST ${base}/spend/limit), and one first piece of work (POST ${base}/assign) that gives the owner something real to read within the hour -- a draft, a list, a short plan -- never research with nothing to show.`,
    'When the owner already has a first piece of work in mind, propose that one rather than your own.',
  ].join(' ');
}

/** The four steps and whether each is done, from what the owner has done in this company. */
export async function firstHourOf(companyId: string): Promise<FirstHour> {
  const { rows } = await withControlPlane((tx) => tx.query<{
    closed: boolean; talk: boolean; budget: boolean; work: boolean; result: boolean;
  }>(
    `SELECT c.first_hour_closed_at IS NOT NULL AS closed,
            EXISTS (SELECT 1 FROM assistant_messages m WHERE m.company_id = c.id AND m.role = 'owner') AS talk,
            EXISTS (SELECT 1 FROM spend_limits l WHERE l.company_id = c.id AND l.set_at IS NOT NULL) AS budget,
            EXISTS (SELECT 1 FROM tasks t WHERE t.company_id = c.id AND t.created_by = 'owner') AS work,
            EXISTS (SELECT 1 FROM tasks t
                     WHERE t.company_id = c.id AND t.created_by = 'owner' AND t.status = 'completed') AS result
       FROM companies c WHERE c.id = $1`,
    [companyId]));
  const row = rows[0];
  if (!row) throw new PalugadaError('contract.violation', 'no such company', { companyId });
  const steps = (['talk', 'budget', 'work', 'result'] as const).map((step) => ({ step, done: row[step] }));
  return { open: !row.closed && steps.some((one) => !one.done), steps };
}

/** The owner closes the list. The steps are not ticked off by it, and the CEO stops interviewing. */
export async function closeFirstHour(companyId: string): Promise<void> {
  await withControlPlane((tx) => tx.query(
    'UPDATE companies SET first_hour_closed_at = coalesce(first_hour_closed_at, now()) WHERE id = $1', [companyId]));
}
