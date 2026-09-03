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
import { PalugadaError } from '../errors.ts';

export type GoalKind = 'mission' | 'objective' | 'key_result';
export type GoalStatus = 'active' | 'met' | 'abandoned';

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
  return chain.map((goal) => `${goal.kind.replace('_', ' ')}: ${goal.statement}`).join(' → ');
}

/**
 * F3.10: an agent that wants the strategy changed asks rather than acts.
 *
 * The database already refuses the write, so this is not the enforcement --
 * it is the path that makes the refusal useful. Without it an agent that
 * believed a mission was wrong would simply be stuck, and being stuck is how a
 * system starts routing around itself.
 */
export async function proposeGoalChange(input: {
  companyId: string;
  taskId?: string | undefined;
  goalId: string;
  proposedStatement: string;
  rationale: string;
}): Promise<string> {
  const current = await withTenant(input.companyId, (tx) => readGoal(tx, input.goalId));
  if (!current) {
    throw new PalugadaError('contract.violation', `no goal ${input.goalId} in this company`, {
      goalId: input.goalId,
    });
  }

  // An escalation rather than an approval, and the distinction is not
  // bookkeeping. An approval gates one action and parks the task that proposed
  // it; a strategy question gates nothing -- the task carries on under the
  // strategy that exists, which is what `consequenceIfDenied` would have said
  // anyway. Parking the task would stop work over a question about a different
  // subject, and would make an agent's opinion cost the company a task.
  //
  // Tier 3 is still recorded on the item, because section 8.8 puts structural
  // change there and the owner's inbox sorts by it.
  return inbox.raiseEscalation({
    companyId: input.companyId,
    taskId: input.taskId,
    tier: 3,
    title: `Proposed change to the ${current.kind} "${current.slug}"`,
    detail:
      `Currently: ${current.statement}\nProposed: ${input.proposedStatement}\n` +
      `Reason given: ${input.rationale}\n\n` +
      'Nothing changes unless you apply it; the task continues under the current strategy.',
  });
}

/** Applies a change the owner approved. Control plane, and recorded. */
export async function applyGoalChange(input: {
  companyId: string;
  goalId: string;
  statement?: string;
  status?: GoalStatus;
}): Promise<void> {
  await withControlPlane(async (tx) => {
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
    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'goal.changed',
      actor: 'owner',
      payload: { goalId: input.goalId, statement: rows[0]!.statement, status: rows[0]!.status },
    });
  });
}
