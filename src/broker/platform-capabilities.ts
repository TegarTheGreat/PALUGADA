/**
 * The capabilities PALUGADA implements itself (PRD v2 F4.8, F15.7).
 *
 * Almost every capability in the catalogue is a name waiting for an adapter
 * that talks to somebody else's service. These are different: they use the
 * company's own store, and the platform is the thing that has it. They exist in
 * `src/` rather than in a test's stub file because they are not stand-ins for
 * something real -- they are the real implementations.
 *
 * Both are tier 0 and both are reads. That is not a coincidence: they are what
 * makes bounding the context pack (F4.8) and the skill summary (F15.7)
 * survivable. Leaving something out of a run's context is only reasonable when
 * the run can go and get it, and a run that could not ask would be forced to
 * work from whatever happened to fit.
 *
 * They still go through the broker, like everything else. A read of the
 * company's own memory is still an action a policy might want to rate-limit,
 * and F8.1 admits no exception for actions the platform happens to implement
 * itself.
 */
import { withTenant } from '../db/tenant.ts';
import { recall } from '../memory/store.ts';
import { readSkill } from '../skills/skills.ts';
import { TIER } from '../domain/tier.ts';
import { recordPlan, type PlanStep } from '../engine/plan.ts';
import { recordObservation } from '../domain/metrics.ts';
import { askOwner } from '../inbox/inbox.ts';
import { createSubTask, getTask } from '../engine/tasks.ts';
import { containChildResult } from '../engine/containment.ts';
import { enqueueWake } from '../scheduler/wake.ts';
import { isTerminal, type TaskStatus } from '../domain/task.ts';
import { PalugadaError } from '../errors.ts';
import type { Capability } from './registry.ts';

export interface MemorySearchInput {
  query: string;
  /** How many facts to return. Bounded below, so a search cannot be a dump. */
  limit?: number;
  /** Defaults to semantic: the kind F4.8 leaves out of the pack. */
  memoryType?: 'semantic' | 'procedural' | 'episodic';
}

export interface MemorySearchResult {
  facts: Array<{ body: string; confidence: number; source: string; unverified: boolean }>;
  /** True when the limit cut the answer short, so the caller can ask again. */
  truncated: boolean;
}

/** Above this many results a search is a dump, and a dump defeats F4.8. */
export const MEMORY_SEARCH_MAX_RESULTS = 20;

/**
 * F4.8's `memory.search`.
 *
 * Text matching rather than embedding similarity, deliberately. An embedding
 * search needs the caller to have produced a vector with the same model the
 * facts were indexed under, and a runtime that cannot do that would have no way
 * to reach memory at all. `recall` still ranks by similarity when a caller can
 * supply an embedding; this is the door for everything else.
 */
export function memorySearchCapability(): Capability<MemorySearchInput, MemorySearchResult> {
  return {
    name: 'memory.search',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const limit = Math.min(Math.max(1, input.limit ?? 5), MEMORY_SEARCH_MAX_RESULTS);
      const needle = input.query.trim().toLowerCase();

      const facts = await withTenant(ctx.companyId, async (tx) => {
        const found = await recall(tx, ctx.companyId, {
          memoryType: input.memoryType ?? 'semantic',
          divisionId: ctx.divisionId,
          // Over-fetch, then filter by text. The scope rules live in `recall`
          // and must not be reimplemented here: a search that reached past its
          // division would make F4.6 a matter of which code path was used.
          limit: MEMORY_SEARCH_MAX_RESULTS * 4,
        });
        return found.filter((memory) => memory.body.toLowerCase().includes(needle));
      });

      return {
        facts: facts.slice(0, limit).map((memory) => ({
          body: memory.body,
          confidence: memory.confidence,
          source: memory.source,
          // The same warning the context pack carries. A fact fetched through a
          // tool must not arrive more certain than the same fact would have
          // been in the pack.
          unverified: memory.confidence < 0.6,
        })),
        truncated: facts.length > limit,
      };
    },
  };
}

export interface SkillReadInput {
  slug: string;
}

export interface SkillReadResult {
  slug: string;
  version: number | null;
  source: string | null;
}

/** F15.7's `skill.read`: the document behind a summary the pack carried. */
export function skillReadCapability(): Capability<SkillReadInput, SkillReadResult> {
  return {
    name: 'skill.read',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const skill = await readSkill(ctx.companyId, input.slug);
      // A missing skill is an answer rather than an error: a run that asked for
      // one that has been retired should be told so and carry on, not fail.
      return skill
        ? { slug: skill.slug, version: skill.version, source: skill.source }
        : { slug: input.slug, version: null, source: null };
    },
  };
}


/**
 * Registers the capabilities PALUGADA implements itself.
 *
 * Called by whatever assembles a deployment's registry, alongside the adapters
 * that bind everything else. It exists because the alternative — leaving each
 * caller to remember two names — is how `memory.search` ends up catalogued,
 * promised to every run in its context pack, and bound to nothing. The context
 * pack tells a run to use it when something did not fit (F4.8); a run that
 * followed that instruction and got `capability.unknown` would have been lied
 * to by the platform.
 */
export interface PlanRecordInput {
  steps: PlanStep[];
}

/**
 * F8.11's `plan.record`.
 *
 * The broker refuses a tier 2 action on a task with no plan, and until this
 * existed **no runtime had any way to record one**. The wire protocol between
 * the engine and a runtime carries tool calls and nothing else, and the plan
 * was written by `recordPlan` -- a function only a test fixture ever called.
 * So every real runtime -- `claude-code`, a CLI, a container -- would have hit
 * `plan.required` on its first tier 2 action and had no move that could
 * satisfy it. The requirement was enforced against agents that could not
 * comply.
 *
 * It belongs here with `memory.search` and `skill.read` for the same reason
 * they do: the platform is the thing that has the task, so the platform is
 * what implements it. Tier 0 because recording an intention changes nothing
 * outside this database -- it is the *statement* the tier 2 gate then holds
 * the run to.
 *
 * It goes through the broker like everything else, and `recordPlan` refuses a
 * second one, so a run cannot rewrite its plan after seeing how the first step
 * went. That is the whole value of F8.11: the plan is a commitment made before
 * the actions, not a description written after them.
 */
export function planRecordCapability(): Capability<PlanRecordInput, { steps: number }> {
  return {
    name: 'plan.record',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    async execute(input, ctx) {
      const plan = await recordPlan(ctx.companyId, ctx.taskId, input.steps);
      return { steps: plan.steps.length };
    },
  };
}

export interface MetricRecordInput {
  /** The metric's slug, as the context pack names it. */
  metric: string;
  value: number;
  /** Where the number came from, in a sentence. */
  note?: string;
}

/**
 * `metric.record`: an agent reports where a key result stands (0053).
 *
 * Tier 0 for the reason `plan.record` is: it changes nothing outside this
 * database. What it records is marked verified only when this same task read
 * the number from the metric's source capability -- so an agent can always say
 * what it found, and can never make its own claim look like the ledger's.
 */
export function metricRecordCapability(): Capability<MetricRecordInput, { verified: boolean }> {
  return {
    name: 'metric.record',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const recorded = await withTenant(ctx.companyId, (tx) => recordObservation(tx, {
        companyId: ctx.companyId,
        metric: String(input.metric ?? ''),
        value: Number(input.value),
        recordedBy: 'agent',
        taskId: ctx.taskId,
        note: input.note ?? null,
      }));
      return { verified: recorded.verified };
    },
  };
}

export function registerPlatformCapabilities(registry: {
  register(capability: Capability<never, never>): void;
}): void {
  registry.register(memorySearchCapability() as unknown as Capability<never, never>);
  registry.register(skillReadCapability() as unknown as Capability<never, never>);
  registry.register(planRecordCapability() as unknown as Capability<never, never>);
  registry.register(metricRecordCapability() as unknown as Capability<never, never>);
  registry.register(ownerAskCapability() as unknown as Capability<never, never>);
  registry.register(taskDelegateCapability() as unknown as Capability<never, never>);
  registry.register(taskAwaitCapability() as unknown as Capability<never, never>);
}

export interface OwnerAskInput {
  /** One question, answerable by the owner alone. */
  question: string;
  /** What depends on the answer, so the owner can answer the right thing. */
  why?: string;
  /** Two to six answers to choose from, when there are that few: the owner presses one. */
  options?: string[];
}

export interface OwnerAskResult {
  answered: boolean;
  answer?: string;
  /** Said when there is no answer to give. */
  note?: string;
}

/** The longest question: the owner reads it on a phone. */
export const QUESTION_MAX = 1_000;

/**
 * `owner.ask`: a run asking the owner what only the owner can answer.
 *
 * Tier 0 because nothing leaves the company and nothing is spent: an item
 * opens in the owner's inbox and the task waits. The waiting is the point.
 * The call does not return a guess; it ends the run with `owner.asked`, which
 * parks the task until the owner answers, whatever runtime made the call.
 * The run after it is told the answer in its context, and the same question
 * asked again returns it -- so a runtime that replays its calls picks up
 * where it stopped.
 */
export function ownerAskCapability(): Capability<OwnerAskInput, OwnerAskResult> {
  return {
    name: 'owner.ask',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const question = String(input.question ?? '').trim();
      if (!question) {
        throw new PalugadaError('contract.violation', 'owner.ask needs a question', { field: 'question' });
      }
      if (question.length > QUESTION_MAX) {
        throw new PalugadaError('contract.violation', `a question is at most ${QUESTION_MAX} characters`, { field: 'question' });
      }
      const asked = await askOwner({
        companyId: ctx.companyId,
        taskId: ctx.taskId,
        question,
        why: typeof input.why === 'string' ? input.why : null,
        options: Array.isArray(input.options) ? input.options.map(String) : null,
      });
      if (asked.state === 'answered') return { answered: true, answer: asked.answer };
      if (asked.state === 'unanswered') {
        return {
          answered: false,
          note: 'The owner closed this question without answering it. Decide with what you have and say what you assumed.',
        };
      }
      throw new PalugadaError(
        'owner.asked',
        'the owner has been asked; this task waits for the answer and resumes with it',
        { inboxItemId: asked.inboxItemId },
      );
    },
  };
}

export interface TaskDelegateInput {
  /** The slug of the role to hand the work to. */
  role: string;
  /** What the other role should do, as its brief. */
  brief: string;
  context?: string;
  /** How long it has, in minutes. Required in effect: a default of an hour applies (F6.4). */
  timeoutMinutes?: number;
}

/** How often a parent waiting on a child looks again. */
export const AWAIT_POLL_MS = 2 * 60_000;

/**
 * `task.delegate`: hand part of the work to another role, as a sub-task.
 *
 * `awaitChild` did this for in-process handlers and nothing did it for a
 * runtime in another process, so an agent CLI -- where the real work runs --
 * could not split a job. This is the same `createSubTask`, with everything it
 * holds: the hop limit, the fan-out cap, the parent's budget chain (F5.4), and
 * a deadline, because a delegation with none is one nobody would notice had
 * stalled (F6.4). Asked again for the same role and brief -- a resumed run
 * replaying its steps -- it returns the child it already started.
 */
export function taskDelegateCapability(): Capability<TaskDelegateInput, { childId: string; role: string; deadlineAt: string }> {
  return {
    name: 'task.delegate',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const brief = String(input.brief ?? '').trim();
      if (!brief) throw new PalugadaError('contract.violation', 'task.delegate needs a brief', { field: 'brief' });
      if (brief.length > 4_000) {
        throw new PalugadaError('contract.violation', 'a brief is at most 4000 characters', { field: 'brief' });
      }
      const minutes = input.timeoutMinutes ?? 60;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
        throw new PalugadaError('contract.violation', 'timeoutMinutes is a whole number from 1 to 1440', { field: 'timeoutMinutes' });
      }
      const found = await withTenant(ctx.companyId, async (tx) => {
        const role = await tx.query<{ id: string; division_id: string }>(
          'SELECT id, division_id FROM roles WHERE slug = $1', [String(input.role ?? '')]);
        const parent = await getTask(tx, ctx.taskId);
        return { role: role.rows[0], parent };
      });
      if (!found.role) {
        throw new PalugadaError('contract.violation', `no role ${input.role} in this company`, { field: 'role' });
      }
      if (!found.parent) throw new PalugadaError('contract.violation', 'no such task', { taskId: ctx.taskId });
      const deadlineAt = new Date(Date.now() + minutes * 60_000);
      const child = await createSubTask(ctx.taskId, {
        companyId: ctx.companyId,
        projectId: found.parent.projectId,
        divisionId: found.role.division_id,
        roleId: found.role.id,
        input: { goal: brief, ...(typeof input.context === 'string' ? { context: input.context } : {}) },
        createdBy: 'agent_run',
        deadlineAt,
      });
      await withTenant(ctx.companyId, (tx) =>
        tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [found.role!.id]));
      await enqueueWake({
        companyId: ctx.companyId,
        roleId: found.role.id,
        reason: 'event',
        detail: `task ${ctx.taskId} delegated task ${child.id}`,
      });
      return { childId: child.id, role: String(input.role), deadlineAt: (child.deadlineAt ?? deadlineAt).toISOString() };
    },
  };
}

export interface TaskAwaitResult {
  status: string;
  /** The child's output, contained to what a parent may be handed (F6.7); null unless it completed. */
  output: Record<string, unknown> | null;
  summary: string;
}

/**
 * `task.await`: the result of work this task delegated.
 *
 * Done, it answers with the child's output, held to the size a sub-agent may
 * hand back (F6.7). Not done, it ends the run with `task.waiting_child`: the
 * parent parks and looks again in a few minutes, or at the child's deadline if
 * that is sooner, holding no worker in between. Only a task's own children
 * can be awaited; another task's are not this one's business.
 */
export function taskAwaitCapability(): Capability<{ childId: string }, TaskAwaitResult> {
  return {
    name: 'task.await',
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const found = await withTenant(ctx.companyId, async (tx) => {
        const { rows } = await tx.query<{
          status: TaskStatus; output: Record<string, unknown> | null; halt_reason: string | null;
          parent_task_id: string | null; deadline_at: Date | null; role: string; steps: number;
        }>(
          `SELECT t.status, t.output, t.halt_reason, t.parent_task_id, t.deadline_at, r.slug AS role,
                  (SELECT count(*)::int FROM task_steps s WHERE s.task_id = t.id AND s.status = 'committed') AS steps
             FROM tasks t JOIN roles r ON r.id = t.role_id WHERE t.id = $1`,
          [String(input.childId ?? '')],
        );
        return rows[0] ?? null;
      });
      if (!found || found.parent_task_id !== ctx.taskId) {
        throw new PalugadaError(
          'contract.violation',
          `task ${input.childId} is not one this task delegated`,
          { childId: input.childId },
        );
      }
      if (found.status === 'completed') {
        const contained = containChildResult(found.role, found.output ?? {}, {
          status: found.status, steps: found.steps, costCents: 0,
        });
        return { status: found.status, output: contained.output, summary: contained.summary };
      }
      if (isTerminal(found.status)) {
        return {
          status: found.status,
          output: null,
          summary: `${found.role} ${found.status}${found.halt_reason ? ` (${found.halt_reason})` : ''} without a result`,
        };
      }
      const next = Date.now() + AWAIT_POLL_MS;
      const reopensAt = found.deadline_at ? Math.min(next, found.deadline_at.getTime() + 1_000) : next;
      throw new PalugadaError(
        'task.waiting_child',
        `${found.role} is still working on it; this task waits and looks again`,
        { childTaskId: input.childId, reopensAt: new Date(reopensAt).toISOString() },
      );
    },
  };
}

/** The names this module implements, for a caller that needs to know. */
export const PLATFORM_CAPABILITIES = [
  'memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask', 'task.delegate', 'task.await',
] as const;
