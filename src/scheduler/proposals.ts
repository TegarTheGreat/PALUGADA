/**
 * A run proposing that some work recur (`schedule.propose`, the tools
 * research's gap #12; Hermes' `cronjob_manage`, OpenClaw's `cron`).
 *
 * A role that sees the same work owed again and again -- the owner asking for
 * Monday's sales three Mondays running -- could only say so in prose, which
 * the owner then had to turn into a schedule by hand on Team. Now it proposes
 * one, and the owner's yes is the schedule (`decide` in src/inbox/inbox.ts).
 *
 * Held to what `goal.propose` is held to: proposing changes nothing, one
 * card per name, and the card is not tied to the task, so a no costs the
 * company none of the work that proposed it. And to what a schedule the
 * owner makes is held to, checked now so the owner is never handed a card
 * that cannot be approved -- and once more at the yes, since a name may have
 * been taken in between. A run may not propose anything more often than
 * hourly: a schedule spends on its own, and a minute's is the owner's to
 * make.
 */
import { PalugadaError } from '../errors.ts';
import { withTenant } from '../db/tenant.ts';
import { raiseEscalationWithin } from '../inbox/inbox.ts';
import { ownerReadingWithin, roleCalledWithin, scheduleProposalCard } from '../owner/platform-cards.ts';
import { noteTalkDrift } from '../domain/language.ts';
import { assertValidCron, nextOccurrence } from './scheduler.ts';

/** What the owner's yes makes, as the item keeps it. */
export interface ScheduleProposal {
  slug: string;
  cron: string;
  timezone: string;
  roleId: string;
  divisionId: string;
  projectId: string;
  goalId: string | null;
  instruction: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSTRUCTION_MAX = 2_000;
const REASON_MAX = 1_000;
/** The least a run may propose between two runs. */
const MINIMUM_MINUTES = 60;

/** The least time between two of the next runs, in minutes. */
function shortestGap(cron: string, timezone: string, from: Date): number {
  let shortest = Number.POSITIVE_INFINITY;
  let at = nextOccurrence(cron, timezone, from);
  for (let n = 0; n < 12; n += 1) {
    const next = nextOccurrence(cron, timezone, at);
    shortest = Math.min(shortest, (next.getTime() - at.getTime()) / 60_000);
    at = next;
  }
  return shortest;
}

export async function proposeSchedule(input: {
  companyId: string;
  /** The task proposing it: its role does the work unless another is named. */
  taskId: string;
  name: string;
  cron: string;
  timezone?: string | undefined;
  /** Another role of this company, by its slug. */
  role?: string | undefined;
  instruction: string;
  why: string;
}, now = new Date()): Promise<{ proposed: boolean; inboxItemId: string; note?: string }> {
  const name = String(input.name ?? '').trim();
  if (!NAME.test(name)) {
    throw new PalugadaError('contract.violation',
      `a schedule's name is lower-case letters, digits and dashes, at most 63, such as weekly-sales; got ${JSON.stringify(name)}`, { field: 'name' });
  }
  const instruction = String(input.instruction ?? '').trim();
  if (!instruction || instruction.length > INSTRUCTION_MAX) {
    throw new PalugadaError('contract.violation',
      `the instruction is what each run does, in at most ${INSTRUCTION_MAX} characters`, { field: 'instruction' });
  }
  const why = String(input.why ?? '').trim();
  if (!why || why.length > REASON_MAX) {
    throw new PalugadaError('contract.violation',
      `why is the evidence that this work recurs, in at most ${REASON_MAX} characters`, { field: 'why' });
  }
  const cron = String(input.cron ?? '').trim();

  return withTenant(input.companyId, async (tx) => {
    const reading = await ownerReadingWithin(tx);
    // In the owner's zone unless the run names one: "nine on Monday" means
    // the owner's nine.
    const timezone = typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : reading.timezone;
    assertValidCron(cron, timezone);
    const gap = shortestGap(cron, timezone, now);
    if (gap < MINIMUM_MINUTES) {
      throw new PalugadaError('contract.violation',
        `a schedule a run proposes runs at most once an hour; this one runs every ${Math.round(gap)} minutes`, { field: 'cron' });
    }

    const { rows: tasks } = await tx.query<{ project_id: string; goal_id: string | null; role_id: string }>(
      'SELECT project_id, goal_id, role_id FROM tasks WHERE id = $1', [input.taskId]);
    const proposer = tasks[0];
    if (!proposer) throw new PalugadaError('contract.violation', 'a schedule is proposed from a task', { taskId: input.taskId });
    const { rows: roles } = await tx.query<{ id: string; slug: string; division_id: string }>(
      input.role
        ? 'SELECT id, slug, division_id FROM roles WHERE slug = $1'
        : 'SELECT id, slug, division_id FROM roles WHERE id = $1',
      [input.role ?? proposer.role_id],
    );
    const role = roles[0];
    if (!role) {
      const { rows: known } = await tx.query<{ slug: string }>('SELECT slug FROM roles ORDER BY slug LIMIT 40');
      throw new PalugadaError('contract.violation',
        `no role ${String(input.role)} in this company; name one by its slug: ${known.map((one) => one.slug).join(', ')}`, { field: 'role' });
    }
    const { rows: taken } = await tx.query('SELECT 1 FROM schedules WHERE slug = $1', [name]);
    if (taken.length > 0) {
      throw new PalugadaError('schedule.slug_taken',
        `a schedule named ${name} already exists: propose this one under another name`, { slug: name });
    }
    const { rows: open } = await tx.query<{ id: string }>(
      `SELECT id FROM inbox_items
        WHERE status = 'open' AND kind = 'escalation' AND payload->'scheduleProposal'->>'slug' = $1`,
      [name],
    );
    if (open[0]) {
      return {
        proposed: false,
        inboxItemId: open[0].id,
        note: `A schedule named ${name} is already waiting for the owner; nothing more was proposed.`,
      };
    }

    const proposal: ScheduleProposal = {
      slug: name, cron, timezone, roleId: role.id, divisionId: role.division_id,
      projectId: proposer.project_id, goalId: proposer.goal_id, instruction,
    };
    const next: Date[] = [];
    for (let at = now; next.length < 3;) next.push(at = nextOccurrence(cron, timezone, at));
    const card = scheduleProposalCard(reading, {
      name, cron, timezone, next, reason: why, instruction,
      role: await roleCalledWithin(tx, { id: role.id }),
      proposer: await roleCalledWithin(tx, { id: proposer.role_id }),
    });
    // An escalation, not an approval, for goal.propose's reason: it gates no
    // action, so the task that proposed it carries on, whatever the answer.
    // Tier 2: the owner makes a schedule with their session, and saying yes
    // to one is the same act.
    const inboxItemId = await raiseEscalationWithin(tx, {
      companyId: input.companyId,
      tier: 2,
      title: card.title,
      detail: card.detail,
      payload: { scheduleProposal: proposal, proposedByTask: input.taskId },
      consequenceIfDenied: card.consequence,
    });
    await noteTalkDrift(tx, { companyId: input.companyId, taskId: input.taskId, where: 'schedule_proposal', text: why });
    return { proposed: true, inboxItemId };
  });
}
