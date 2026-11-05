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
import { transitionWithin } from '../engine/tasks.ts';
import { metricsIn } from './metrics.ts';
import { CHANNEL_SLUGS, channelSaid, isChannel, type ChannelSlug } from './channels.ts';

export type GoalKind = 'mission' | 'objective' | 'key_result';
export const GOAL_STATUSES = ['active', 'met', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * How the end of a goal's period is read (F18.1, F18.8), after the two kinds
 * of objective in *Measure What Matters* and the learning goal of *The Lean
 * Startup*: a committed goal is done in full or it is a miss, an
 * aspirational one is graded (0.6 to 0.7 is a good result), and a learning
 * one is a test whose prediction is written before the work starts.
 */
export const GOAL_COMMITMENTS = ['committed', 'aspirational', 'learning'] as const;
export type GoalCommitment = (typeof GOAL_COMMITMENTS)[number];

/**
 * What a goal's period is, from its length. There is no fiscal year in the
 * schema, so a quarter is read from the length rather than the calendar: a
 * calendar quarter is 90 to 92 days, last day included, and 0136's trigger
 * uses the same 92. A key result with a quarter's period is a quarterly
 * priority; an objective with a year's is one of this year's goals; anything
 * longer is where the company means to be in a few years.
 */
export type GoalPeriod = 'quarter' | 'year' | 'longer';
const QUARTER_DAYS = 92;
const YEAR_DAYS = 366;

/**
 * The soft limits, which warn and never refuse. The sources disagree, so one
 * value is chosen for each and the reason is said here:
 *
 * - this year's goals: EOS Worldwide's one-year plan has three to seven,
 *   "closer to three is ideal", and Google's re:Work three to five
 *   objectives; five, where the two overlap;
 * - key results under one objective: whatmatters.com says three to five; five;
 * - quarterly priorities at once: EOS says three to seven for a company; seven;
 * - priorities for one seat: EOS's glossary says three to seven for a team or
 *   a person and its weekly meeting page about three to five; five, since
 *   one seat is one role.
 */
const LIMITS = {
  year_goals: 5,
  objective_key_results: 5,
  quarter_priorities: 7,
  seat_priorities: 5,
} as const;

/** A soft limit a goal is past: shown to the owner, and nothing is refused for it. */
export type GoalWarning =
  | { kind: 'year_goals'; count: number; limit: number }
  | { kind: 'objective_key_results'; count: number; limit: number; goalId: string }
  | { kind: 'quarter_priorities'; count: number; limit: number }
  | { kind: 'seat_priorities'; count: number; limit: number; roleId: string };

const WARNING_ORDER: ReadonlyArray<GoalWarning['kind']> = ['year_goals', 'objective_key_results', 'quarter_priorities', 'seat_priorities'];

export interface Goal {
  id: string;
  parentGoalId: string | null;
  kind: GoalKind;
  slug: string;
  statement: string;
  status: GoalStatus;
  /** The period, as days (YYYY-MM-DD): both or neither, the due date its last day (0136). */
  startsOn: string | null;
  dueOn: string | null;
  /** What the period's length makes it; null without one. */
  period: GoalPeriod | null;
  /** The one seat that answers for it, and that role's slug, as a run names roles. */
  ownerRoleId: string | null;
  ownerRole: string | null;
  commitment: GoalCommitment | null;
  /** What is true once it is done, in a sentence. */
  doneWhen: string | null;
  /** The traction channel it tests (F18.11). */
  channel: ChannelSlug | null;
}

interface RawGoal {
  id: string;
  parent_goal_id: string | null;
  kind: GoalKind;
  slug: string;
  statement: string;
  status: GoalStatus;
  starts_on: string | null;
  due_on: string | null;
  owner_role_id: string | null;
  owner_role: string | null;
  commitment: GoalCommitment | null;
  done_when: string | null;
  channel: ChannelSlug | null;
}

/** Whole days from one day to another, both written YYYY-MM-DD. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function periodOf(startsOn: string | null, dueOn: string | null): GoalPeriod | null {
  if (!startsOn || !dueOn) return null;
  const days = daysBetween(startsOn, dueOn);
  return days <= QUARTER_DAYS ? 'quarter' : days <= YEAR_DAYS ? 'year' : 'longer';
}

const toGoal = (row: RawGoal): Goal => ({
  id: row.id,
  parentGoalId: row.parent_goal_id,
  kind: row.kind,
  slug: row.slug,
  statement: row.statement,
  status: row.status,
  startsOn: row.starts_on,
  dueOn: row.due_on,
  period: periodOf(row.starts_on, row.due_on),
  ownerRoleId: row.owner_role_id,
  ownerRole: row.owner_role,
  commitment: row.commitment,
  doneWhen: row.done_when,
  channel: row.channel,
});

// Days as text: the driver reads a `date` as midnight where this process
// runs, which is the day before east of UTC. The seat by its slug, read in a
// subquery so every query that filters on a goal's own columns can still
// name them bare.
const GOAL_COLUMNS = `g.id, g.parent_goal_id, g.kind, g.slug, g.statement, g.status,
  to_char(g.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(g.due_on, 'YYYY-MM-DD') AS due_on, g.owner_role_id,
  (SELECT r.slug FROM roles r WHERE r.company_id = g.company_id AND r.id = g.owner_role_id) AS owner_role,
  g.commitment, g.done_when, g.channel`;
const SELECT_GOAL = `SELECT ${GOAL_COLUMNS} FROM goals g`;

/** What the owner sets about a goal's period and seat: left out is unchanged, null is cleared. */
export interface GoalPlan {
  startsOn?: string | null | undefined;
  dueOn?: string | null | undefined;
  ownerRoleId?: string | null | undefined;
  commitment?: string | null | undefined;
  doneWhen?: string | null | undefined;
  channel?: string | null | undefined;
}
const PLAN_FIELDS = ['startsOn', 'dueOn', 'ownerRoleId', 'commitment', 'doneWhen', 'channel'] as const;
const DONE_WHEN_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The plan's fields, checked, as the database will hold them. The trigger in
 * 0136 has the rules between them (a period has both ends, a quarterly
 * priority a seat); what is checked here is each value on its own, so the
 * owner is told which field is wrong by its name rather than by a constraint's.
 */
function planFrom(plan: GoalPlan): Partial<Record<(typeof PLAN_FIELDS)[number], string | null>> {
  const out: Partial<Record<(typeof PLAN_FIELDS)[number], string | null>> = {};
  for (const field of PLAN_FIELDS) {
    const raw = plan[field];
    if (raw === undefined) continue;
    const value = raw === null ? null : String(raw).trim() || null;
    if (value !== null) {
      if (field === 'startsOn' || field === 'dueOn') {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
        if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
          throw new PalugadaError('contract.violation',
            `${field} is a day written YYYY-MM-DD, such as 2026-10-01; got ${value}`, { field });
        }
      }
      if (field === 'ownerRoleId' && !UUID.test(value)) {
        throw new PalugadaError('contract.violation',
          `ownerRoleId is the id of one of this company's roles, as its structure lists them; got ${value}`, { field });
      }
      if (field === 'commitment' && !(GOAL_COMMITMENTS as readonly string[]).includes(value)) {
        throw new PalugadaError('contract.violation',
          `commitment is one of ${GOAL_COMMITMENTS.join(', ')}; got ${value}`, { field });
      }
      if (field === 'channel' && !isChannel(value)) {
        throw new PalugadaError('contract.violation',
          `channel is one of ${CHANNEL_SLUGS.join(', ')}; got ${value}`, { field });
      }
      if (field === 'doneWhen' && value.length > DONE_WHEN_MAX) {
        throw new PalugadaError('contract.violation',
          `doneWhen is a sentence of at most ${DONE_WHEN_MAX} characters, and this is ${value.length}`, { field });
      }
    }
    out[field] = value;
  }
  return out;
}

/** The seat named is one of this company's roles: the control plane sees every company's. */
async function assertSeatHere(tx: TenantClient, companyId: string, roleId: string | null | undefined): Promise<void> {
  if (!roleId) return;
  const { rowCount } = await tx.query('SELECT 1 FROM roles WHERE company_id = $1 AND id = $2', [companyId, roleId]);
  if (rowCount !== 1) {
    throw new PalugadaError('contract.violation',
      `no role ${roleId} in this company: the owning seat is one of this company's roles, by its id`, { field: 'ownerRoleId' });
  }
}

/** Every goal of one company, oldest first. */
export async function goalsIn(tx: TenantClient, companyId: string): Promise<Goal[]> {
  const { rows } = await tx.query<RawGoal>(`${SELECT_GOAL} WHERE g.company_id = $1 ORDER BY g.created_at, g.id`, [companyId]);
  return rows.map(toGoal);
}

/**
 * The soft limits each goal is past (F18.1), by goal. Only open goals count
 * and are warned about: a met priority is not one the quarter still holds.
 * "In a quarter" and "in a year" are the goals whose periods overlap this
 * one's, since there is no fiscal calendar to cut them by.
 */
export function goalWarnings(goals: readonly Goal[]): Map<string, GoalWarning[]> {
  const open = goals.filter((goal) => goal.status === 'active');
  const overlaps = (one: Goal, other: Goal) => one.startsOn! <= other.dueOn! && other.startsOn! <= one.dueOn!;
  const priorities = open.filter((goal) => goal.kind === 'key_result' && goal.period === 'quarter');
  const yearGoals = open.filter((goal) => goal.kind === 'objective' && goal.period === 'year');
  const found = new Map<string, GoalWarning[]>();
  for (const goal of open) {
    const warnings: GoalWarning[] = [];
    if (goal.kind === 'objective' && goal.period === 'year') {
      const count = yearGoals.filter((other) => overlaps(goal, other)).length;
      if (count > LIMITS.year_goals) warnings.push({ kind: 'year_goals', count, limit: LIMITS.year_goals });
    }
    if (goal.kind === 'objective') {
      const count = open.filter((other) => other.kind === 'key_result' && other.parentGoalId === goal.id).length;
      if (count > LIMITS.objective_key_results) {
        warnings.push({ kind: 'objective_key_results', count, limit: LIMITS.objective_key_results, goalId: goal.id });
      }
    }
    if (goal.kind === 'key_result' && goal.period === 'quarter') {
      const now = priorities.filter((other) => overlaps(goal, other));
      if (now.length > LIMITS.quarter_priorities) {
        warnings.push({ kind: 'quarter_priorities', count: now.length, limit: LIMITS.quarter_priorities });
      }
      const seat = now.filter((other) => other.ownerRoleId === goal.ownerRoleId).length;
      if (goal.ownerRoleId && seat > LIMITS.seat_priorities) {
        warnings.push({ kind: 'seat_priorities', count: seat, limit: LIMITS.seat_priorities, roleId: goal.ownerRoleId });
      }
    }
    if (warnings.length > 0) found.set(goal.id, warnings);
  }
  return found;
}

/**
 * The owner adds a goal (F2.7, F18.1). Answered with the soft limits it, or
 * the objective it hangs from, is now past: a warning, never a refusal.
 */
export async function createGoal(input: {
  companyId: string;
  kind: GoalKind;
  slug: string;
  statement: string;
  parentGoalId?: string | null;
} & GoalPlan): Promise<Goal & { warnings: GoalWarning[] }> {
  const plan = planFrom(input);
  return withControlPlane(async (tx) => {
    await assertSeatHere(tx, input.companyId, plan.ownerRoleId);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO goals (company_id, parent_goal_id, kind, slug, statement,
                          starts_on, due_on, owner_role_id, commitment, done_when, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.companyId, input.parentGoalId ?? null, input.kind, input.slug, input.statement,
        plan.startsOn ?? null, plan.dueOn ?? null, plan.ownerRoleId ?? null, plan.commitment ?? null,
        plan.doneWhen ?? null, plan.channel ?? null,
      ],
    );
    const goals = await goalsIn(tx, input.companyId);
    const goal = goals.find((one) => one.id === rows[0]!.id)!;
    await appendEvent(tx, {
      companyId: input.companyId,
      type: 'goal.created',
      actor: 'owner',
      payload: {
        goalId: goal.id, kind: goal.kind, slug: goal.slug,
        ...Object.fromEntries(Object.entries(plan).filter(([, value]) => value !== null)),
      },
    });
    // Its own, and the objective's it crowded.
    const found = goalWarnings(goals);
    const warnings = [
      ...(goal.parentGoalId ? found.get(goal.parentGoalId) ?? [] : []).filter((one) => one.kind === 'objective_key_results'),
      ...found.get(goal.id) ?? [],
    ].sort((one, other) => WARNING_ORDER.indexOf(one.kind) - WARNING_ORDER.indexOf(other.kind));
    return { ...goal, warnings };
  });
}

export async function readGoal(tx: TenantClient, goalId: string): Promise<Goal | null> {
  const { rows } = await tx.query<RawGoal>(`${SELECT_GOAL} WHERE g.id = $1`, [goalId]);
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
  const { rows } = await tx.query<RawGoal>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_goal_id, 0 AS depth FROM goals WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_goal_id, chain.depth + 1
         FROM goals p JOIN chain ON p.id = chain.parent_goal_id
     )
     SELECT ${GOAL_COLUMNS} FROM chain JOIN goals g ON g.id = chain.id ORDER BY chain.depth DESC`,
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
  // pressing on towards something the owner has stopped wanting. And a goal
  // with a period says by when, how firmly, whose it is and what done is
  // (F18.1), so a run can tell whether its work is on the path to it.
  return chain.map((goal) => {
    const said = [
      goal.status === 'active' ? null : goal.status,
      goal.kind === 'key_result' && goal.period === 'quarter' ? 'quarterly priority'
        : goal.kind === 'objective' && goal.period === 'year' ? "one of this year's goals" : null,
      goal.startsOn && goal.dueOn ? `${goal.startsOn} to ${goal.dueOn}` : null,
      goal.commitment,
      goal.ownerRole ? `owned by ${goal.ownerRole}` : null,
      goal.doneWhen ? `done when: ${goal.doneWhen}` : null,
      goal.channel ? `tests the channel ${channelSaid(goal.channel)}` : null,
    ].filter((part): part is string => part !== null);
    return `${goal.kind.replace('_', ' ')}${said.length > 0 ? ` (${said.join('; ')})` : ''}: ${goal.statement}`;
  }).join(' → ');
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
    const { rows } = await tx.query<RawGoal>(`${SELECT_GOAL} WHERE g.id::text = $1 OR g.slug = $1`, [input.goal]);
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

    // Not met on an agent's say-so. A measure read back from its source, or
    // typed by the owner, that is short of its target stops the proposal here:
    // the owner's card for "met" carried only the agent's prose, and nothing
    // compared it to the goal's own number (the audit of 3 October, P0-6).
    const measures = to.status === 'met' || to.status === 'abandoned'
      ? (await metricsIn(tx)).filter((metric) => metric.goalId === current.id && !metric.retiredAt)
      : [];
    if (to.status === 'met') {
      // A line on the weekly scorecard (0137) is a weekly goal, met or missed
      // each week: a short week is shown on the card, and stops nothing.
      const short = measures.find((metric) => metric.reviewEvery === null && metric.latest?.verified === true
        && (metric.direction === 'up' ? metric.latest.value < metric.target : metric.latest.value > metric.target));
      if (short) {
        throw new PalugadaError('contract.violation',
          `the ${current.kind} "${current.slug}" cannot be proposed as met: its measure "${short.name}" reads ${short.latest!.value}, `
          + `checked at its source, short of its target ${short.target}. Record the value from its source if it has moved, `
          + 'or propose a different target with the reason', { goal: current.slug, metric: short.slug });
      }
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
      measures: measures.map((metric) => ({
        name: metric.name, target: metric.target,
        now: metric.latest ? { value: metric.latest.value, checked: metric.latest.verified } : null,
      })),
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
} & GoalPlan): Promise<{ paused: { schedules: number; triggers: number } }> {
  return withControlPlane((tx) => applyGoalChangeWithin(tx, input));
}

/**
 * The same, inside a control-plane transaction the caller holds: the owner's
 * yes to a proposal (inbox.decide), so the answer and the change are one fact.
 * A plan field left out stays as it is and one given as null is cleared.
 */
export async function applyGoalChangeWithin(
  tx: TenantClient,
  input: {
    companyId: string; goalId: string; statement?: string | undefined; status?: GoalStatus | undefined; inboxItemId?: string;
  } & GoalPlan,
): Promise<{ paused: { schedules: number; triggers: number } }> {
  const plan = planFrom(input);
  await assertSeatHere(tx, input.companyId, plan.ownerRoleId);
  const given = (field: keyof typeof plan) => field in plan;
  const { rows } = await tx.query<{ status: GoalStatus; statement: string }>(
    `UPDATE goals
        SET statement = coalesce($3, statement),
            status = coalesce($4, status),
            starts_on = CASE WHEN $5 THEN $6::date ELSE starts_on END,
            due_on = CASE WHEN $7 THEN $8::date ELSE due_on END,
            owner_role_id = CASE WHEN $9 THEN $10::uuid ELSE owner_role_id END,
            commitment = CASE WHEN $11 THEN $12 ELSE commitment END,
            done_when = CASE WHEN $13 THEN $14 ELSE done_when END,
            channel = CASE WHEN $15 THEN $16 ELSE channel END
      WHERE id = $1 AND company_id = $2
      RETURNING status, statement`,
    [
      input.goalId, input.companyId, input.statement ?? null, input.status ?? null,
      given('startsOn'), plan.startsOn ?? null, given('dueOn'), plan.dueOn ?? null,
      given('ownerRoleId'), plan.ownerRoleId ?? null, given('commitment'), plan.commitment ?? null,
      given('doneWhen'), plan.doneWhen ?? null, given('channel'), plan.channel ?? null,
    ],
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
    // Nobody is woken about a goal that is done: the follow-ups waiting under
    // it (`task.follow_up`) and the outcome and review looks and the weekly
    // meeting the platform made for the CEO (src/engine/outcomes.ts,
    // goal-review.ts, meeting.ts) are cancelled, which releases what they
    // held. Only what has not started: running work is left to finish.
    const waiting = await tx.query<{ id: string }>(
      `${under} SELECT id FROM tasks
                 WHERE company_id = $2 AND status = 'pending'
                   AND (idempotency_key LIKE 'followup:%' OR idempotency_key LIKE 'outcome:%' OR idempotency_key LIKE 'review:%'
                        OR idempotency_key LIKE 'meeting:%')
                   AND goal_id IN (SELECT id FROM under)
                 ORDER BY id`,
      [input.goalId, input.companyId]);
    for (const task of waiting.rows) {
      await transitionWithin(tx, input.companyId, task.id, 'cancelled', { haltReason: 'owner_cancel' });
    }
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
      // What the owner sent, by name, so the record says a due date moved
      // rather than only that something did.
      changed: [
        ...(input.statement !== undefined ? ['statement'] : []), ...(input.status !== undefined ? ['status'] : []),
        ...Object.keys(plan),
      ],
      ...plan,
      ...(input.inboxItemId ? { inboxItemId: input.inboxItemId } : {}),
    },
  });
  return { paused };
}
