/**
 * A plan of new goals, proposed in one card and approved line by line (F18.7).
 *
 * The owner approves every goal (F3.10): the application role reads `goals`
 * and `goal_metrics` and writes neither. `goal.propose` could ask for one
 * goal to change, and nothing could ask for new ones, so a CEO that had
 * planned a quarter -- this year's goals, the priorities under them, each with
 * a seat, a period and a finish line -- could only write the plan in prose for
 * the owner to type in again, goal by goal. A plan is the same proposal made
 * whole: one tier 3 card, one line per new goal, each approved or refused on
 * its own, and the owner's yes is the goals, made with their measures in the
 * transaction that records the answer.
 *
 * What a line must be is checked when it is proposed, by its number, with the
 * rules the database holds again when the yes writes it (0136): a run is told
 * what to fix while it still has the facts in front of it, rather than the
 * owner being shown a card that cannot be approved.
 *
 * A learning goal (after Ries's validated learning and Deming's PDSA) is a
 * test whose prediction is written before the work: a line committed to
 * learning carries a measure, and its target, set in the same proposal, is
 * the prediction the grade is read against.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import * as inbox from '../inbox/inbox.ts';
import { ownerReadingWithin, planCard, roleCalledWithin, type PlanLineSaid, type PlanWarningSaid } from '../owner/platform-cards.ts';
import { PalugadaError } from '../errors.ts';
import { noteTalkDrift } from './language.ts';
import { METRIC_UNITS, defineMetricWithin, directionDisagreement, metricsIn, type MetricUnit } from './metrics.ts';
import type { ChannelSlug } from './channels.ts';
import {
  GOAL_REASON_MAX, GOAL_STATEMENT_MAX, createGoalWithin, goalWarnings, goalsIn, periodOf, planFrom,
  type Goal, type GoalCommitment, type GoalKind, type GoalStatus, type GoalWarning,
} from './goals.ts';

/**
 * The most lines one plan holds. A quarter's plan is at most seven company
 * priorities and five of this year's goals by the soft limits (goals.ts), and
 * a seat's priorities under them; twenty leaves room for the year's goals and
 * the quarter's together without letting a card run to pages on a phone.
 */
export const PLAN_LINES_MAX = 20;

/** The longest measure name a line may carry: a scorecard line is read at a glance. */
const MEASURE_NAME_MAX = 200;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A new goal, as a run proposes it: everything named by its slug, as a run is shown them. */
export interface PlanLineInput {
  slug?: unknown;
  statement?: unknown;
  kind?: unknown;
  /** The goal it hangs from: an active goal's slug, or an earlier line's. */
  parent?: unknown;
  startsOn?: unknown;
  dueOn?: unknown;
  /** The owning seat, by the role's slug. */
  seat?: unknown;
  commitment?: unknown;
  doneWhen?: unknown;
  channel?: unknown;
  measure?: {
    slug?: unknown; name?: unknown; unit?: unknown; direction?: unknown; baseline?: unknown; target?: unknown;
    /** The measure it is watched with: one with no pair, or an earlier line's, by its slug. */
    pair?: unknown;
  } | null;
}

/** One line as the card carries it, resolved to ids: what approving it writes. */
export interface PlannedGoal {
  line: number;
  slug: string;
  statement: string;
  kind: Exclude<GoalKind, 'mission'>;
  parent: { goalId: string } | { line: number };
  startsOn: string | null;
  dueOn: string | null;
  ownerRoleId: string | null;
  commitment: GoalCommitment | null;
  doneWhen: string | null;
  channel: ChannelSlug | null;
  measure: {
    slug: string; name: string; unit: MetricUnit; direction: 'up' | 'down'; baseline: number; target: number;
    pair: { metricId: string } | { line: number } | null;
  } | null;
  /** Whether it would pass a soft limit, for the console's choice beside it; the card says which. */
  warned: boolean;
}

/** What a plan's card carries (`payload.goalPlan`), and what the owner's yes applies. */
export interface GoalPlanProposal {
  lines: PlannedGoal[];
  /**
   * The goals that exist and lines hang from, as they stood: everything the
   * owner can set on one, so a yes is refused once any of it no longer does.
   */
  parents: ParentAsProposed[];
}

/** A parent as the plan was written against it: its words, status, period, seat, commitment, finish line and channel. */
interface ParentAsProposed {
  goalId: string;
  slug: string;
  kind: GoalKind;
  parentGoalId: string | null;
  statement: string;
  status: GoalStatus;
  startsOn: string | null;
  dueOn: string | null;
  ownerRoleId: string | null;
  commitment: GoalCommitment | null;
  doneWhen: string | null;
  channel: ChannelSlug | null;
}

const asProposed = (goal: Omit<ParentAsProposed, 'goalId'> & { id: string }): ParentAsProposed => ({
  goalId: goal.id, slug: goal.slug, kind: goal.kind, parentGoalId: goal.parentGoalId, statement: goal.statement, status: goal.status,
  startsOn: goal.startsOn, dueOn: goal.dueOn, ownerRoleId: goal.ownerRoleId, commitment: goal.commitment, doneWhen: goal.doneWhen,
  channel: goal.channel,
});

const KIND_SAID: Record<GoalKind, string> = { mission: 'mission', objective: 'objective', key_result: 'key result' };
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * Proposes a plan of new goals to the owner: one card, and nothing made.
 * Answered with the soft limits each line would pass, so the run can say so
 * or think again; they are warnings, and refuse nothing.
 */
export async function proposeGoalPlan(input: {
  companyId: string;
  taskId?: string | undefined;
  plan: unknown;
  rationale: string;
}): Promise<{ proposed: boolean; inboxItemId: string; note?: string; warnings: Array<{ line: number } & GoalWarning> }> {
  const lines = Array.isArray(input.plan) ? input.plan as PlanLineInput[] : null;
  if (!lines || lines.length === 0 || lines.length > PLAN_LINES_MAX) {
    throw new PalugadaError('contract.violation',
      `a plan has 1 to ${PLAN_LINES_MAX} new goals; this one has ${lines ? lines.length : 'none: plan is a list'}`, { field: 'plan' });
  }
  const rationale = String(input.rationale ?? '').trim();
  if (!rationale || rationale.length > GOAL_REASON_MAX) {
    throw new PalugadaError('contract.violation',
      `a plan says why, in at most ${GOAL_REASON_MAX} characters: the evidence and where it came from`, { field: 'why' });
  }

  return withTenant(input.companyId, async (tx) => {
    // One plan waits for the owner at a time: two could each be approved
    // against goals the other had just made, and their limits counted apart.
    // The lock makes that true when two runs propose at once: the second
    // waits for the first to commit, and then reads its card.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`goal-plan:${input.companyId}`]);
    const { rows: open } = await tx.query<{ id: string }>(
      `SELECT id FROM inbox_items WHERE status = 'open' AND kind = 'escalation' AND payload ? 'goalPlan'
        ORDER BY created_at LIMIT 1`);
    if (open[0]) {
      return {
        proposed: false, inboxItemId: open[0].id, warnings: [],
        note: 'A plan of new goals is already waiting for the owner; nothing more was proposed. It can be proposed again once that one is decided.',
      };
    }

    const goals = await goalsIn(tx, input.companyId);
    const { rows: roles } = await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM roles ORDER BY created_at, slug');
    // Every measure, retired ones too: a retired measure keeps its slug
    // (0053), so a line cannot take it, though it is never a pair.
    const measures = await metricsIn(tx);
    const planned: PlannedGoal[] = [];
    for (const [index, line] of lines.entries()) planned.push(plannedFrom(line, index + 1, { goals, roles, measures }, planned));
    checkAcross(planned, measures);

    // The soft limits, as though every line were approved: the owner reads
    // what the plan would make, and refuses lines knowing what each adds.
    const id = (line: number) => `line:${line}`;
    const hypothetical: Goal[] = [
      ...goals,
      ...planned.map((line): Goal => ({
        id: id(line.line), parentGoalId: 'goalId' in line.parent ? line.parent.goalId : id(line.parent.line),
        kind: line.kind, slug: line.slug, statement: line.statement, status: 'active',
        startsOn: line.startsOn, dueOn: line.dueOn, period: periodOf(line.startsOn, line.dueOn),
        ownerRoleId: line.ownerRoleId, ownerRole: null, commitment: line.commitment, doneWhen: line.doneWhen, channel: line.channel,
      })),
    ];
    const found = goalWarnings(hypothetical);
    const warningsOf = (line: PlannedGoal): GoalWarning[] => [
      ...(found.get('goalId' in line.parent ? line.parent.goalId : id(line.parent.line)) ?? []).filter((one) => one.kind === 'objective_key_results'),
      ...found.get(id(line.line)) ?? [],
    ];
    for (const line of planned) line.warned = warningsOf(line).length > 0;

    const parents = [...new Set(planned.flatMap((line) => ('goalId' in line.parent ? [line.parent.goalId] : [])))]
      .map((goalId) => goals.find((goal) => goal.id === goalId)!)
      .map(asProposed);
    const proposal: GoalPlanProposal = { lines: planned, parents };

    const said: PlanLineSaid[] = [];
    for (const line of planned) {
      const warnings: PlanWarningSaid[] = [];
      for (const warning of warningsOf(line)) {
        warnings.push(warning.kind === 'seat_priorities'
          ? { kind: warning.kind, count: warning.count, limit: warning.limit, seat: await roleCalledWithin(tx, { id: warning.roleId }) }
          : { kind: warning.kind, count: warning.count, limit: warning.limit });
      }
      const pair = line.measure?.pair ?? null;
      said.push({
        line: line.line,
        kind: line.kind,
        statement: line.statement,
        under: 'goalId' in line.parent
          ? { statement: goals.find((goal) => goal.id === (line.parent as { goalId: string }).goalId)!.statement }
          : { statement: planned[line.parent.line - 1]!.statement, line: line.parent.line },
        period: line.startsOn && line.dueOn ? { startsOn: line.startsOn, dueOn: line.dueOn } : null,
        commitment: line.commitment,
        seat: line.ownerRoleId ? await roleCalledWithin(tx, { id: line.ownerRoleId }) : null,
        doneWhen: line.doneWhen,
        measure: line.measure ? {
          name: line.measure.name, baseline: line.measure.baseline, target: line.measure.target,
          pairedWith: pair === null ? null
            : 'metricId' in pair ? measures.find((metric) => metric.id === pair.metricId)!.name
              : planned[pair.line - 1]!.measure!.name,
        } : null,
        warnings,
      });
    }
    const card = planCard(await ownerReadingWithin(tx), { reason: rationale, lines: said });
    // An escalation, not an approval, for the reason a goal change is one
    // (proposeGoalChange): a plan gates no work, and the task that wrote it
    // carries on whatever the owner answers. Tier 3, because the ladder is
    // structural (section 8.8), so the yes takes the owner's device.
    const inboxItemId = await inbox.raiseEscalationWithin(tx, {
      companyId: input.companyId,
      tier: 3,
      title: card.title,
      detail: card.detail,
      payload: { goalPlan: proposal, ...(input.taskId ? { proposedByTask: input.taskId } : {}) },
      consequenceIfDenied: card.consequence,
    });
    // The goals' words and the reason are the run's, to the owner, so they
    // are held to the company's language as a goal change's are.
    await noteTalkDrift(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      where: 'goal_proposal',
      text: [...planned.flatMap((line) => [line.statement, line.doneWhen ?? '']), rationale].filter(Boolean).join('\n'),
    });
    return {
      proposed: true,
      inboxItemId,
      warnings: planned.flatMap((line) => warningsOf(line).map((warning) => ({ line: line.line, ...warning }))),
    };
  });
}

/**
 * One line, checked and resolved. Each refusal names the line by its number
 * and slug and says what is accepted, in the order a person would fix them.
 */
function plannedFrom(
  raw: PlanLineInput,
  line: number,
  known: { goals: Goal[]; roles: Array<{ id: string; slug: string }>; measures: Awaited<ReturnType<typeof metricsIn>> },
  earlier: readonly PlannedGoal[],
): PlannedGoal {
  const slug = text(raw?.slug);
  const refuse = (message: string, field: string): never => {
    throw new PalugadaError('contract.violation', `line ${line} (${slug || 'no slug'}): ${message}`, { field: `plan[${line - 1}].${field}`, line });
  };
  if (!SLUG.test(slug)) refuse(`a goal's slug is lower-case letters, digits and dashes, such as q1-cafes; got ${JSON.stringify(raw?.slug ?? null)}`, 'slug');
  if (known.goals.some((goal) => goal.slug === slug)) refuse(`a goal named ${slug} already exists; give the new one a slug of its own`, 'slug');
  const twin = earlier.find((one) => one.slug === slug);
  if (twin) refuse(`the slug ${slug} is already line ${twin.line}'s`, 'slug');
  const statement = text(raw.statement);
  if (!statement || statement.length > GOAL_STATEMENT_MAX) refuse(`statement is what the goal says, in 1 to ${GOAL_STATEMENT_MAX} characters`, 'statement');
  const kind = raw.kind;
  if (kind !== 'objective' && kind !== 'key_result') {
    refuse(`kind is objective (one of this year's goals) or key_result (a priority under one); got ${JSON.stringify(kind ?? null)}`, 'kind');
  }
  const goalKind = kind as 'objective' | 'key_result';

  // What it hangs from: an earlier line, or a goal that is still open.
  const parentSlug = text(raw.parent);
  const parentLine = earlier.find((one) => one.slug === parentSlug);
  const parentGoal = parentLine ? null : known.goals.find((goal) => goal.slug === parentSlug);
  if (!parentLine && !parentGoal) {
    const active = known.goals.filter((goal) => goal.status === 'active').map((goal) => goal.slug);
    refuse(`no goal ${parentSlug || '(none named)'} to hang from; name an active goal by its slug (${active.join(', ')}), or an earlier line of this plan`, 'parent');
  }
  if (parentGoal && parentGoal.status !== 'active') {
    refuse(`the ${KIND_SAID[parentGoal.kind]} ${parentGoal.slug} is ${parentGoal.status}: a new goal hangs from one that is still active`, 'parent');
  }
  const parentKind = parentLine ? parentLine.kind : parentGoal!.kind;
  if ((goalKind === 'objective' && parentKind !== 'mission') || (goalKind === 'key_result' && parentKind !== 'objective')) {
    refuse(`${goalKind === 'objective' ? 'an objective hangs from the mission' : 'a key result hangs from an objective'}, and ${parentSlug} is a ${KIND_SAID[parentKind]}`, 'parent');
  }

  // Each field on its own, as the owner's own goal is checked (planFrom).
  let fields: ReturnType<typeof planFrom> = {};
  try {
    fields = planFrom({
      startsOn: text(raw.startsOn) || null, dueOn: text(raw.dueOn) || null, commitment: text(raw.commitment) || null,
      doneWhen: text(raw.doneWhen) || null, channel: text(raw.channel) || null,
    });
  } catch (error) {
    refuse((error as Error).message, String((error as PalugadaError).details?.field ?? 'plan'));
  }
  const seatSlug = text(raw.seat);
  const seat = seatSlug ? known.roles.find((role) => role.slug === seatSlug) : undefined;
  if (seatSlug && !seat) {
    refuse(`no role ${seatSlug} in this company to own it; name a seat by its slug: ${known.roles.map((role) => role.slug).join(', ')}`, 'seat');
  }

  // The ladder's rules for a period, a commitment and a seat (0136).
  const startsOn = fields.startsOn ?? null;
  const dueOn = fields.dueOn ?? null;
  if ((startsOn === null) !== (dueOn === null)) refuse('a period has a start and a due date, or neither: give it both startsOn and dueOn, or neither', 'dueOn');
  if (startsOn && dueOn && dueOn <= startsOn) refuse(`a goal is due after it starts: ${dueOn} is not after ${startsOn}`, 'dueOn');
  const commitment = (fields.commitment ?? null) as GoalCommitment | null;
  if (commitment && !startsOn) refuse(`a ${commitment} goal has a period: give it startsOn and dueOn`, 'startsOn');
  const priority = goalKind === 'key_result' && periodOf(startsOn, dueOn) === 'quarter';
  if (priority && !seat) {
    refuse('a key result of a quarter or less is a quarterly priority, and has one owning seat: name the role that answers for it with seat', 'seat');
  }
  const measure = raw.measure === undefined || raw.measure === null ? null : measureFrom(raw.measure, slug, refuse, known.measures, earlier);
  if (commitment === 'learning' && !measure) {
    refuse('a learning goal is a test, and carries a measure whose target is the prediction, set now', 'measure');
  }
  const doneWhen = fields.doneWhen ?? null;
  if (priority && !doneWhen && !measure) refuse('a quarterly priority says when it is done: give it doneWhen, or a measure', 'doneWhen');

  const planned: PlannedGoal = {
    line, slug, statement, kind: goalKind,
    parent: parentLine ? { line: parentLine.line } : { goalId: parentGoal!.id },
    startsOn, dueOn, ownerRoleId: seat?.id ?? null, commitment, doneWhen,
    channel: (fields.channel ?? null) as ChannelSlug | null,
    measure, warned: false,
  };
  return planned;
}

function measureFrom(
  raw: NonNullable<PlanLineInput['measure']>,
  goalSlug: string,
  refuse: (message: string, field: string) => never,
  measures: Awaited<ReturnType<typeof metricsIn>>,
  earlier: readonly PlannedGoal[],
): NonNullable<PlannedGoal['measure']> {
  if (typeof raw !== 'object') refuse('measure is an object: name, unit, target, and optionally slug, direction, baseline and pair', 'measure');
  const slug = text(raw.slug) || goalSlug;
  if (!SLUG.test(slug)) refuse(`a measure's slug is lower-case letters, digits and dashes; got ${JSON.stringify(raw.slug)}`, 'measure.slug');
  const named = measures.find((metric) => metric.slug === slug);
  if (named?.retiredAt) refuse(`a measure named ${slug} was retired, and keeps its slug; give this one a slug of its own`, 'measure.slug');
  if (named) refuse(`a measure named ${slug} already exists; give this one a slug of its own`, 'measure.slug');
  const taken = earlier.find((one) => one.measure?.slug === slug);
  if (taken) refuse(`the measure slug ${slug} is already line ${taken.line}'s`, 'measure.slug');
  const name = text(raw.name);
  if (!name || name.length > MEASURE_NAME_MAX) refuse(`a measure's name is 1 to ${MEASURE_NAME_MAX} characters`, 'measure.name');
  if (!(METRIC_UNITS as readonly unknown[]).includes(raw.unit)) {
    refuse(`a measure's unit is one of ${METRIC_UNITS.join(', ')}; got ${JSON.stringify(raw.unit ?? null)}`, 'measure.unit');
  }
  const direction = raw.direction === undefined || raw.direction === null ? 'up' : raw.direction;
  if (direction !== 'up' && direction !== 'down') refuse(`a measure's direction is up or down; got ${JSON.stringify(direction)}`, 'measure.direction');
  // Lower is better from a baseline of 0 is never progress, so a measure
  // aimed down says where it starts.
  if (direction === 'down' && (raw.baseline === undefined || raw.baseline === null)) {
    refuse('a measure where lower is better says where it stands now: give it a baseline above its target', 'measure.baseline');
  }
  const baseline = raw.baseline === undefined || raw.baseline === null ? 0 : raw.baseline;
  if (typeof baseline !== 'number' || !Number.isFinite(baseline)) refuse('a measure\'s baseline is a number, where it stands now', 'measure.baseline');
  const target = raw.target;
  if (typeof target !== 'number' || !Number.isFinite(target)) refuse('a measure\'s target is a number, set now: for a learning goal it is the prediction', 'measure.target');
  if (target === baseline) refuse('a measure\'s target differs from its baseline, or there is nothing to measure', 'measure.target');
  const disagreement = directionDisagreement(direction, baseline, target);
  if (disagreement) refuse(disagreement, 'measure.baseline');

  // Its pair: one that has none yet, or an earlier line's -- a measure made
  // without a factor takes no partner from a pair that stands (defineMetric).
  // An earlier line's measure that is itself paired, with a measure or with
  // a line before it, is a pair that will stand by the time this line is
  // made, and the yes would be refused there, after the owner's code is spent.
  const pairSlug = text(raw.pair);
  let pair: NonNullable<PlannedGoal['measure']>['pair'] = null;
  if (pairSlug) {
    const line = earlier.find((one) => one.measure?.slug === pairSlug);
    const existing = line ? null : measures.find((metric) => metric.slug === pairSlug && !metric.retiredAt);
    if (!line && !existing) {
      refuse(`no measure ${pairSlug} to watch this one with; name a measure that is still measured by its slug, or an earlier line's`, 'measure.pair');
    }
    const slugOf = (metricId: string) => measures.find((metric) => metric.id === metricId)?.slug ?? 'another';
    const taken = line?.measure?.pair ?? null;
    const standing = existing?.pairedWith ? slugOf(existing.pairedWith)
      : taken === null ? null
        : 'metricId' in taken ? slugOf(taken.metricId) : earlier[taken.line - 1]!.measure!.slug;
    if (standing) {
      refuse(`the measure ${pairSlug} is already paired with ${standing}; a new measure is paired only with one that has no pair`, 'measure.pair');
    }
    pair = line ? { line: line.line } : { metricId: existing!.id };
  }
  return { slug, name, unit: raw.unit as MetricUnit, direction, baseline, target, pair };
}

/** What only the whole plan shows: two lines watched with the same measure. */
function checkAcross(planned: PlannedGoal[], measures: Awaited<ReturnType<typeof metricsIn>>): void {
  const partners = new Map<string, number>();
  for (const line of planned) {
    const pair = line.measure?.pair;
    if (!pair) continue;
    const key = 'line' in pair ? `line:${pair.line}` : pair.metricId;
    const first = partners.get(key);
    if (first !== undefined) {
      const named = 'line' in pair ? `line ${pair.line}'s measure` : `the measure ${measures.find((metric) => metric.id === pair.metricId)!.slug}`;
      throw new PalugadaError('contract.violation',
        `line ${line.line} (${line.slug}): ${named} is already watched with line ${first}'s; a measure has one partner`,
        { field: `plan[${line.line - 1}].measure.pair`, line: line.line });
    }
    partners.set(key, line.line);
    // The earlier line's measure is paired from this one: it holds no other.
    if ('line' in pair) partners.set(`line:${line.line}`, pair.line);
  }
}

/**
 * The lines the owner approves, checked before any factor is spent on the
 * yes: numbers of this plan's lines, and every line a chosen one hangs from or
 * is watched with chosen too. Left out, it is every line.
 */
export function planLinesChosen(plan: GoalPlanProposal, lines: unknown): number[] {
  const count = plan.lines.length;
  if (lines === undefined) return plan.lines.map((line) => line.line);
  if (!Array.isArray(lines) || !lines.every((one) => Number.isInteger(one))) {
    throw new PalugadaError('contract.violation',
      `lines is a list of the plan's line numbers to approve, such as [1, 3]; got ${JSON.stringify(lines)}`, { field: 'lines' });
  }
  const outside = (lines as number[]).find((one) => one < 1 || one > count);
  if (outside !== undefined) {
    throw new PalugadaError('contract.violation', `lines are the numbers of this plan's lines, 1 to ${count}; got ${outside}`, { field: 'lines' });
  }
  const chosen = [...new Set(lines as number[])].sort((one, other) => one - other);
  if (chosen.length === 0) {
    throw new PalugadaError('contract.violation', 'lines names at least one line to approve; to refuse every line, deny the plan', { field: 'lines' });
  }
  for (const number of chosen) {
    const line = plan.lines[number - 1]!;
    if ('line' in line.parent && !chosen.includes(line.parent.line)) {
      throw new PalugadaError('contract.violation',
        `line ${number} hangs from line ${line.parent.line}, which is not approved: approve line ${line.parent.line} too, or refuse line ${number}`,
        { field: 'lines' });
    }
    const pair = line.measure?.pair;
    if (pair && 'line' in pair && !chosen.includes(pair.line)) {
      throw new PalugadaError('contract.violation',
        `line ${number}'s measure is watched with line ${pair.line}'s, which is not approved: approve line ${pair.line} too, or refuse line ${number}`,
        { field: 'lines' });
    }
  }
  return chosen;
}

/**
 * Makes the lines the owner approved, inside the control-plane transaction
 * that records the yes (inbox.decide): each goal with createGoal's checks and
 * record, then its measure with defineMetric's, so the deferred rule that a
 * priority says when it is done (0136) reads the two together at commit. A
 * goal a line hangs from that has changed since the proposal, or a slug taken
 * since, refuses the whole yes rather than writing over what is there now.
 */
export async function applyGoalPlanWithin(
  tx: TenantClient,
  input: { companyId: string; inboxItemId: string; plan: GoalPlanProposal; approved: readonly number[] },
): Promise<void> {
  const lines = input.plan.lines.filter((line) => input.approved.includes(line.line));
  for (const parent of input.plan.parents) {
    const under = lines.find((line) => 'goalId' in line.parent && line.parent.goalId === parent.goalId);
    if (!under) continue;
    // Days as text, as goalsIn reads them, so the two compare as written.
    const { rows } = await tx.query<Omit<ParentAsProposed, 'goalId'> & { id: string }>(
      `SELECT id, slug, kind, parent_goal_id AS "parentGoalId", statement, status,
              to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(due_on, 'YYYY-MM-DD') AS "dueOn",
              owner_role_id AS "ownerRoleId", commitment, done_when AS "doneWhen", channel
         FROM goals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [parent.goalId, input.companyId]);
    const now = rows[0] ? asProposed(rows[0]) : null;
    const was = asProposed({ ...parent, id: parent.goalId });
    if (!now || (Object.keys(was) as Array<keyof ParentAsProposed>).some((field) => now[field] !== was[field])) {
      throw new PalugadaError('contract.violation',
        `line ${under.line} hangs from the ${KIND_SAID[parent.kind]} "${parent.slug}", which has changed since this was proposed; deny it, and ask for a new proposal`,
        { inboxItemId: input.inboxItemId, goalId: parent.goalId });
    }
  }
  for (const line of lines) {
    const { rows } = await tx.query('SELECT 1 FROM goals WHERE company_id = $1 AND slug = $2', [input.companyId, line.slug]);
    if (rows.length > 0) {
      throw new PalugadaError('contract.violation',
        `a goal named ${line.slug} was made since this was proposed (line ${line.line}): deny it and ask for a new proposal, or refuse line ${line.line}`,
        { inboxItemId: input.inboxItemId, slug: line.slug });
    }
    if (line.measure) {
      const { rows: taken } = await tx.query('SELECT 1 FROM goal_metrics WHERE company_id = $1 AND slug = $2', [input.companyId, line.measure.slug]);
      if (taken.length > 0) {
        throw new PalugadaError('contract.violation',
          `a measure named ${line.measure.slug} was made since this was proposed (line ${line.line}): deny it and ask for a new proposal, or refuse line ${line.line}`,
          { inboxItemId: input.inboxItemId, slug: line.measure.slug });
      }
    }
  }

  // In line order, one statement at a time: a line hangs only from an
  // earlier one, and is paired only with an earlier one's measure.
  const goalIds = new Map<number, string>();
  const metricIds = new Map<number, string>();
  for (const line of lines) {
    const goal = await createGoalWithin(tx, {
      companyId: input.companyId, kind: line.kind, slug: line.slug, statement: line.statement,
      parentGoalId: 'goalId' in line.parent ? line.parent.goalId : goalIds.get(line.parent.line)!,
      startsOn: line.startsOn, dueOn: line.dueOn, ownerRoleId: line.ownerRoleId, commitment: line.commitment,
      doneWhen: line.doneWhen, channel: line.channel, inboxItemId: input.inboxItemId,
    });
    goalIds.set(line.line, goal.id);
    if (!line.measure) continue;
    const pair = line.measure.pair;
    const metricId = await defineMetricWithin(tx, input.companyId, {
      goalId: goal.id, slug: line.measure.slug, name: line.measure.name, unit: line.measure.unit,
      direction: line.measure.direction, baseline: line.measure.baseline, target: line.measure.target,
      // The measure is due with its goal and answered for by its seat.
      dueOn: line.dueOn, ownerRoleId: line.ownerRoleId,
      pairedWith: pair === null ? null : 'metricId' in pair ? pair.metricId : metricIds.get(pair.line)!,
      inboxItemId: input.inboxItemId,
    });
    metricIds.set(line.line, metricId);
  }
}
