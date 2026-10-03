/**
 * Goal ancestry (PRD v2 F2.7, F3.10).
 *
 * Every task carries the chain that explains it: mission → objective → key
 * result. The chain is the answer to "why is this happening", and F10.2 wants
 * that answer inside the approval item rather than a query away, because an
 * owner deciding on a phone at 07:00 will not go and look for it.
 *
 * Two things are worth stating.
 *
 * **The three levels are one table.** They are the same shape and differ only
 * in what they may hang from, which a trigger enforces. Three tables would
 * have meant three copies of the same constraint and a join to walk two links.
 *
 * **Agents read goals and never write them (F3.10).** The application role
 * holds SELECT and nothing else, so changing strategy is structurally the
 * owner's rather than a rule an agent is asked to follow. An agent that
 * believes the strategy is wrong proposes a change through the inbox, which is
 * the same shape as every other thing it may want and may not do.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import * as inbox from '../inbox/inbox.ts';
import { goalChangeCard, ownerReadingWithin } from '../owner/platform-cards.ts';
import { PalugadaError } from '../errors.ts';
import { noteTalkDrift } from './language.ts';

export type GoalKind = 'mission' | 'objective' | 'key_result';
export const GOAL_STATUSES = ['active', 'met', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
  id: string;
  parentGoalId: string | null;
  kind: GoalKind;
  slug: string;
  statement: string;
  status: GoalStatus;
}

interface RawGoal {
  id: string;
  parent_goal_id: string | null;
  kind: GoalKind;
  slug: string;
  statement: string;
  status: GoalStatus;
}

const toGoal = (row: RawGoal): Goal => ({
  id: row.id,
  parentGoalId: row.parent_goal_id,
  kind: row.kind,
  slug: row.slug,
  statement: row.statement,
  status: row.status,
});

const SELECT_GOAL =
  'SELECT id, parent_goal_id, kind, slug, statement, status FROM goals';

export async function createGoal(input: {
  companyId: string;
  kind: GoalKind;
  slug: string;
  statement: string;
  parentGoalId?: string | null;
}): Promise<Goal> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<RawGoal>(
      `INSERT INTO goals (company_id, parent_goal_id, kind, slug, statement)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, parent_goal_id, kind, slug, statement, status`,
      [input.companyId, input.parentGoalId ?? null, input.kind, input.slug, input.statement],
    );
    const goal = toGoal(rows[0]!);
    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'goal.created',
      actor: 'owner',
      payload: { goalId: goal.id, kind: goal.kind, slug: goal.slug },
    });
    return goal;
  });
}

export async function readGoal(tx: TenantClient, goalId: string): Promise<Goal | null> {
  const { rows } = await tx.query<RawGoal>(`${SELECT_GOAL} WHERE id = $1`, [goalId]);
  return rows[0] ? toGoal(rows[0]) : null;
}

/**
 * The chain from the mission down to this goal.
 *
 * Ordered top-down, because that is the order it is read in: the mission gives
 * the sentence its subject and the key result gives it its measure. Walked
 * with a recursive query rather than in a loop so a run assembling its context
 * pays one round trip instead of three.
 */
export async function ancestryFor(tx: TenantClient, goalId: string): Promise<Goal[]> {
  const { rows } = await tx.query<RawGoal & { depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_goal_id, kind, slug, statement, status, 0 AS depth
         FROM goals WHERE id = $1
       UNION ALL
       SELECT g.id, g.parent_goal_id, g.kind, g.slug, g.statement, g.status, chain.depth + 1
         FROM goals g JOIN chain ON g.id = chain.parent_goal_id
     )
     SELECT * FROM chain ORDER BY depth DESC`,
    [goalId],
  );
  return rows.map(toGoal);
}

export async function ancestryForTask(tx: TenantClient, taskId: string): Promise<Goal[]> {
  const { rows } = await tx.query<{ goal_id: string | null }>(
    'SELECT goal_id FROM tasks WHERE id = $1',
    [taskId],
  );
  const goalId = rows[0]?.goal_id;
  return goalId ? ancestryFor(tx, goalId) : [];
}

/**
 * The chain as one readable line.
 *
 * Used in the approval item and in the run context. Kept to a sentence because
 * F10.6 holds the whole digest to one screen and an approval that needs
 * scrolling before it can be understood is an approval that gets waved through.
 */
export function renderAncestry(chain: Goal[]): string {
  if (chain.length === 0) return 'No goal is attached to this task.';
  // A closed goal says so: a run still under one winds down rather than
  // pressing on towards something the owner has stopped wanting.
  return chain.map((goal) => `${goal.kind.replace('_', ' ')}${goal.status === 'active' ? '' : ` (${goal.status})`}: ${goal.statement}`)
    .join(' → ');
}

/**
 * Refuses to start work under a goal that is closed, or under one whose
 * ancestor is: an abandoned objective's key results are abandoned with it,
 * whatever their own row says, and work under a met goal is work nobody asked
 * for. What is already running is left to finish; this is the door, not the
 * room.
 */
export async function assertGoalOpen(tx: TenantClient, goalId: string): Promise<void> {
  const chain = await ancestryFor(tx, goalId);
  const goal = chain.at(-1);
  if (!goal) throw new PalugadaError('contract.violation', `no goal ${goalId} in this company`, { goalId });
  const closed = chain.find((one) => one.status !== 'active');
  if (!closed) return;
  const called = (one: Goal) => `the ${one.kind.replace('_', ' ')} "${one.slug}"`;
  throw new PalugadaError('goal.closed', closed.id === goal.id
    ? `${called(goal)} is ${goal.status}: work is not started under a closed goal; choose an active one, or reopen it`
    : `${goal.slug} is under ${called(closed)}, which is ${closed.status}: work is not started under a closed goal; choose an active one, or reopen it`,
  { goalId, closedGoalId: closed.id, status: closed.status });
}

/** What a goal-change proposal's item carries, and what approving it applies. */
export interface GoalChange {
  goalId: string;
  /** The goal as it stood when proposed: approving is refused once it no longer does. */
  from: { statement: string; status: GoalStatus };
  to: { statement?: string; status?: GoalStatus };
}

/** The longest reason a proposal carries; the owner reads it on a phone. */
const GOAL_REASON_MAX = 4_000;
const GOAL_STATEMENT_MAX = 1_000;

/**
 * F3.10: an agent that wants the strategy changed asks rather than acts.
 *
 * The database already refuses the write, so this is not the enforcement --
 * it is the path that makes the refusal useful. Without it an agent that
 * believed a mission was wrong would simply be stuck, and being stuck is how a
 * system starts routing around itself. A run reaches it through
 * `goal.propose`, and the owner's yes to the item is the change.
 */
export async function proposeGoalChange(input: {
  companyId: string;
  taskId?: string | undefined;
  /** The goal, by its id or its slug. */
  goal: string;
  proposedStatement?: string | undefined;
  proposedStatus?: string | undefined;
  rationale: string;
}): Promise<{ proposed: boolean; inboxItemId: string; note?: string }> {
  const statement = typeof input.proposedStatement === 'string' ? input.proposedStatement.trim() : '';
  const status = input.proposedStatus;
  if (!statement && status === undefined) {
    throw new PalugadaError('contract.violation',
      'a goal change proposes a new statement, a new status, or both', { field: 'statement' });
  }
  if (statement.length > GOAL_STATEMENT_MAX) {
    throw new PalugadaError('contract.violation',
      `a goal's statement is at most ${GOAL_STATEMENT_MAX} characters`, { field: 'statement' });
  }
  if (status !== undefined && !(GOAL_STATUSES as readonly string[]).includes(status)) {
    throw new PalugadaError('contract.violation',
      `a goal's status is one of ${GOAL_STATUSES.join(', ')}; got ${String(status)}`, { field: 'status' });
  }
  const rationale = String(input.rationale ?? '').trim();
  if (!rationale || rationale.length > GOAL_REASON_MAX) {
    throw new PalugadaError('contract.violation',
      `a goal change says why, in at most ${GOAL_REASON_MAX} characters: the evidence and where it came from`,
      { field: 'why' });
  }

  return withTenant(input.companyId, async (tx) => {
    // By id or by slug: a run is shown slugs (the weekly brief), not ids. The
    // id is compared as text so a slug is never cast to a uuid.
    const { rows } = await tx.query<RawGoal>(`${SELECT_GOAL} WHERE id::text = $1 OR slug = $1`, [input.goal]);
    const current = rows[0] ? toGoal(rows[0]) : null;
    if (!current) {
      // A run is told its goals by their words, so the answer names the
      // slugs it could have used rather than leaving it to guess again.
      const { rows: known } = await tx.query<{ slug: string }>(
        "SELECT slug FROM goals WHERE status = 'active' ORDER BY created_at LIMIT 25");
      throw new PalugadaError('contract.violation',
        `no goal ${input.goal} in this company; name one by its slug: ${known.map((one) => one.slug).join(', ') || 'there are none'}`,
        { goal: input.goal });
    }
    const to = {
      ...(statement && statement !== current.statement ? { statement } : {}),
      ...(status !== undefined && status !== current.status ? { status: status as GoalStatus } : {}),
    };
    if (Object.keys(to).length === 0) {
      throw new PalugadaError('contract.violation',
        `that is what the ${current.kind} "${current.slug}" already says`, { goal: current.slug });
    }

    // One proposal about a goal at a time: two open ones would let the owner
    // approve both, and the second would change a goal the first had changed.
    const { rows: open } = await tx.query<{ id: string }>(
      `SELECT id FROM inbox_items
        WHERE status = 'open' AND kind = 'escalation' AND payload->'goalChange'->>'goalId' = $1`,
      [current.id],
    );
    if (open[0]) {
      return {
        proposed: false,
        inboxItemId: open[0].id,
        note: `A change to the ${current.kind} "${current.slug}" is already waiting for the owner; nothing more was proposed.`,
      };
    }

    // An escalation rather than an approval, and the distinction is not
    // bookkeeping. An approval gates one action and parks the task that
    // proposed it; a strategy question gates nothing -- the task carries on
    // under the strategy that exists. Not tied to the task either, as a stage
    // proposal is not: a "no" to the item cancelled a proposer still running,
    // and an agent's opinion must not cost the company its work.
    //
    // Tier 3, because section 8.8 puts structural change there: approving is
    // what changes the goal (inbox.decide), so it takes the owner's device,
    // as their own edit of the ladder does.
    const change: GoalChange = { goalId: current.id, from: { statement: current.statement, status: current.status }, to };
    const card = goalChangeCard(await ownerReadingWithin(tx), {
      kind: current.kind, statement: current.statement, status: current.status, to, reason: rationale,
    });
    const inboxItemId = await inbox.raiseEscalationWithin(tx, {
      companyId: input.companyId,
      tier: 3,
      title: card.title,
      detail: card.detail,
      payload: { goalChange: change, ...(input.taskId ? { proposedByTask: input.taskId } : {}) },
      consequenceIfDenied: card.consequence,
    });
    // The reason and the new words are the run's, to the owner. The slip is
    // the proposing task's, so its role is reminded, though the item is not
    // tied to it.
    await noteTalkDrift(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      where: 'goal_proposal',
      text: [to.statement ?? '', rationale].filter(Boolean).join('\n'),
    });
    return { proposed: true, inboxItemId };
  });
}

/**
 * Applies a change the owner approved. Control plane, and recorded.
 *
 * Closing a goal pauses what would start work under it -- the schedules and
 * the triggers of the goal and of every goal beneath it -- in the same
 * transaction, and says how many, so an abandoned objective stops spending
 * the moment it is abandoned. Reopening one resumes nothing by itself: which
 * of them should run again is the owner's call, made where each one is.
 */
export async function applyGoalChange(input: {
  companyId: string;
  goalId: string;
  statement?: string;
  status?: GoalStatus;
}): Promise<{ paused: { schedules: number; triggers: number } }> {
  return withControlPlane((tx) => applyGoalChangeWithin(tx, input));
}

/**
 * The same, inside a control-plane transaction the caller holds: the owner's
 * yes to a proposal (inbox.decide), so the answer and the change are one fact.
 */
export async function applyGoalChangeWithin(
  tx: TenantClient,
  input: { companyId: string; goalId: string; statement?: string | undefined; status?: GoalStatus | undefined; inboxItemId?: string },
): Promise<{ paused: { schedules: number; triggers: number } }> {
  const { rows } = await tx.query<RawGoal>(
    `UPDATE goals
        SET statement = coalesce($3, statement),
            status = coalesce($4, status)
      WHERE id = $1 AND company_id = $2
      RETURNING id, parent_goal_id, kind, slug, statement, status`,
    [input.goalId, input.companyId, input.statement ?? null, input.status ?? null],
  );
  if (rows.length === 0) {
    throw new PalugadaError('contract.violation', `no goal ${input.goalId} in this company`, {
      goalId: input.goalId,
    });
  }
  const paused = { schedules: 0, triggers: 0 };
  if (rows[0]!.status !== 'active') {
    const under = `WITH RECURSIVE under AS (
                     SELECT id FROM goals WHERE id = $1 AND company_id = $2
                     UNION ALL
                     SELECT g.id FROM goals g JOIN under u ON g.parent_goal_id = u.id)`;
    const schedules = await tx.query<{ id: string; slug: string }>(
      `${under} UPDATE schedules SET enabled = false
                 WHERE company_id = $2 AND enabled AND goal_id IN (SELECT id FROM under) RETURNING id, slug`,
      [input.goalId, input.companyId]);
    const triggers = await tx.query<{ id: string; slug: string }>(
      `${under} UPDATE triggers SET enabled = false
                 WHERE company_id = $2 AND enabled AND goal_id IN (SELECT id FROM under) RETURNING id, slug`,
      [input.goalId, input.companyId]);
    paused.schedules = schedules.rows.length;
    paused.triggers = triggers.rows.length;
    if (paused.schedules + paused.triggers > 0) {
      await appendEvent(tx, {
        companyId: input.companyId,
        type: 'goal.work_paused',
        actor: 'owner',
        payload: {
          goalId: input.goalId,
          status: rows[0]!.status,
          schedules: schedules.rows.map((row) => row.slug),
          triggers: triggers.rows.map((row) => row.slug),
        },
      });
    }
  }
  await appendEvent(tx, {
    companyId: input.companyId,
    type: 'goal.changed',
    actor: 'owner',
    payload: {
      goalId: input.goalId, statement: rows[0]!.statement, status: rows[0]!.status,
      ...(input.inboxItemId ? { inboxItemId: input.inboxItemId } : {}),
    },
  });
  return { paused };
}
