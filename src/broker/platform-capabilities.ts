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
import { wrapUntrusted } from '../context/builder.ts';
import { recall } from '../memory/store.ts';
import { readSkill } from '../skills/skills.ts';
import { TIER } from '../domain/tier.ts';
import { recordPlan, type PlanStep } from '../engine/plan.ts';
import { recordObservation } from '../domain/metrics.ts';
import { askOwner, raiseEscalationWithin } from '../inbox/inbox.ts';
import { STAGES, assertStage, loosens, stageOf, type Stage } from '../domain/stage.ts';
import { createSubTask, getTask } from '../engine/tasks.ts';
import { listTickets, openTicket, readTicket, startTicket } from '../engine/tickets.ts';
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
  facts: Array<{ body: string; confidence: number; source: string; unverified: boolean; outside?: boolean }>;
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
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, description: 'What to look for, in a few words.' },
        limit: { type: 'integer', minimum: 1, maximum: MEMORY_SEARCH_MAX_RESULTS, description: 'How many facts to return (default 5).' },
        memoryType: { enum: ['semantic', 'procedural', 'episodic'], description: 'Facts (default), procedures, or past events.' },
      },
    },
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const limit = Math.min(Math.max(1, input.limit ?? 5), MEMORY_SEARCH_MAX_RESULTS);
      // Ranked by the words a fact shares with the query, in the database,
      // across everything the division may see. It read the eighty newest
      // and kept those containing the query as written, so an old fact could
      // not be found by any words. The scope rules stay in `recall`: a search
      // that reached past its division would make F4.6 a matter of which code
      // path was used.
      const facts = await withTenant(ctx.companyId, (tx) => recall(tx, ctx.companyId, {
        memoryType: input.memoryType ?? 'semantic',
        divisionId: ctx.divisionId,
        text: input.query,
        limit: limit + 1,
      }));

      return {
        facts: facts.slice(0, limit).map((memory) => ({
          body: memory.body,
          confidence: memory.confidence,
          source: memory.source,
          // The same warning the context pack carries. A fact fetched through a
          // tool must not arrive more certain than the same fact would have
          // been in the pack -- nor one learned from outside content arrive
          // as anything but data (0071).
          unverified: memory.confidence < 0.6 || memory.outside,
          ...(memory.outside ? { outside: true, body: wrapUntrusted(`memory:${memory.source}`, memory.body) } : {}),
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
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: { slug: { type: 'string', minLength: 1, description: 'The skill, as its summary names it.' } },
    },
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
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          description: 'Every action at tier 2 or above this task will take, before it takes any.',
          items: {
            type: 'object',
            required: ['capability', 'intent', 'expectedEffect'],
            properties: {
              capability: { type: 'string', minLength: 1, description: 'The capability the step will use.' },
              intent: { type: 'string', minLength: 1, description: 'What the step is for.' },
              expectedEffect: { type: 'string', minLength: 1, description: 'What will be true once it has run.' },
              batchSize: { type: 'integer', minimum: 1, description: 'How many items the call covers, when it is a batch.' },
            },
          },
        },
      },
    },
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
    inputSchema: {
      type: 'object',
      required: ['metric', 'value'],
      properties: {
        metric: { type: 'string', minLength: 1, description: 'The metric, as the context names it.' },
        value: { type: 'number', description: 'Where it stands now.' },
        note: { type: 'string', description: 'Where the number came from, in a sentence.' },
      },
    },
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

export interface TicketCreateInput {
  title: string;
  body?: string;
  /** 0 first to 3 last; 2 unless said. */
  priority?: number;
}

/**
 * `ticket.create`: file something that needs doing and is not this run's job
 * now (0070). In the company's own backlog, where the owner sees it and the
 * CEO can hand it on; the same title still open in the division is the same
 * ticket. Tier 1 as the catalogue has it: a ticket reaches colleagues and can
 * be closed, and the read-back is the row being there. A vendor file that
 * binds an outside tracker replaces this binding.
 */
export function ticketCreateCapability(): Capability<TicketCreateInput, { ticketId: string; existing: boolean }> {
  return {
    name: 'ticket.create',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'What needs doing, in a line.' },
        body: { type: 'string', maxLength: 8000, description: 'What whoever picks it up needs to know, and what done looks like.' },
        priority: { type: 'integer', minimum: 0, maximum: 3, description: '0 first to 3 last; 2 unless it is urgent.' },
      },
    },
    adapter: 'platform',
    defaultTier: TIER.REVERSIBLE_WRITE,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      return withTenant(ctx.companyId, async (tx) => {
        const task = await getTask(tx, ctx.taskId);
        if (!task) throw new PalugadaError('contract.violation', 'no such task', { taskId: ctx.taskId });
        const opened = await openTicket(tx, {
          companyId: ctx.companyId,
          projectId: task.projectId,
          divisionId: ctx.divisionId,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          ...(input.priority === undefined ? {} : { priority: Number(input.priority) }),
          openedBy: 'agent',
          openedByTaskId: ctx.taskId,
        });
        return { ticketId: opened.ticket.id, existing: opened.existing };
      });
    },
    async verify(_input, result, ctx) {
      return withTenant(ctx.companyId, async (tx) => (await readTicket(tx, result.ticketId)) !== null);
    },
  };
}

/**
 * `ticket.list`: the company's open tickets, for the role that hands work on
 * (0070). What a ticket says was written by a run, perhaps from a customer's
 * words, so it is outside content (F8.9) like a page read from the web.
 */
export function ticketListCapability(): Capability<{ status?: string; limit?: number }, { tickets: Array<Record<string, unknown>> }> {
  return {
    name: 'ticket.list',
    inputSchema: {
      type: 'object',
      properties: {
        status: { enum: ['active', 'open', 'in_progress', 'done', 'closed', 'all'], description: 'active (open and in progress) unless said.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    readsOutside: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const status = (input.status ?? 'active') as 'active';
      const tickets = await withTenant(ctx.companyId, (tx) => listTickets(tx, { status, limit: input.limit ?? 50 }));
      return {
        tickets: tickets.map((ticket) => ({
          id: ticket.id, title: ticket.title, body: ticket.body.slice(0, 1_000), status: ticket.status,
          priority: ticket.priority, divisionId: ticket.divisionId, openedBy: ticket.openedBy,
          workingTaskId: ticket.workingTaskId, createdAt: ticket.createdAt.toISOString(),
        })),
      };
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
  registry.register(stageProposeCapability() as unknown as Capability<never, never>);
  registry.register(ticketCreateCapability() as unknown as Capability<never, never>);
  registry.register(ticketListCapability() as unknown as Capability<never, never>);
}

export interface StageProposeInput {
  /** The stage the company should move to. */
  to: string;
  /** What shows it is time: numbers, what customers said and paid, with where each came from. */
  evidence: string;
  /** What the move should change, and what would make the owner move it back. */
  why?: string;
}

/** The longest evidence a proposal carries; past it, the run should link to a document. */
const EVIDENCE_MAX = 4_000;

/**
 * `stage.propose`: ask the owner to move the company to another stage (0057).
 *
 * auto-company's GO/NO-GO, as an item the owner answers. Approving it is what
 * moves the company, in the same transaction as the answer; a move that
 * loosens what the company may do is raised at tier 3, so it takes the
 * owner's device and never happens in a batch or over chat. The item is not
 * tied to the task that raised it: a "no" to the proposal is not a "stop" to
 * the work that made it.
 */
export function stageProposeCapability(): Capability<StageProposeInput, { proposed: boolean; inboxItemId: string; note?: string }> {
  return {
    name: 'stage.propose',
    inputSchema: {
      type: 'object',
      required: ['to', 'evidence'],
      properties: {
        to: { enum: [...STAGES], description: 'The stage the company should move to.' },
        evidence: { type: 'string', minLength: 1, maxLength: EVIDENCE_MAX, description: 'What shows it is time, with where each piece came from.' },
        why: { type: 'string', description: 'What the move should change, and what would make the owner move it back.' },
      },
    },
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const to = assertStage(input.to);
      const evidence = String(input.evidence ?? '').trim();
      if (!evidence) {
        throw new PalugadaError(
          'contract.violation',
          'a stage proposal needs its evidence: the numbers, what customers said and paid, and where each came from',
          { field: 'evidence' },
        );
      }
      if (evidence.length > EVIDENCE_MAX) {
        throw new PalugadaError(
          'contract.violation',
          `evidence is at most ${EVIDENCE_MAX} characters; put the rest in a document and name it`,
          { field: 'evidence' },
        );
      }
      return withTenant(ctx.companyId, async (tx) => {
        const from = await stageOf(tx, ctx.companyId);
        if (from === to) {
          throw new PalugadaError('contract.violation', `the company is already in the ${to} stage`, { stage: to });
        }
        // One proposal at a time: two open ones would let the owner approve
        // both, and the second would move from a stage the first had left.
        const { rows } = await tx.query<{ id: string; to: Stage }>(
          `SELECT id, payload->'stageChange'->>'to' AS to FROM inbox_items
            WHERE status = 'open' AND kind = 'escalation' AND payload ? 'stageChange'`,
        );
        const open = rows[0];
        if (open) {
          return {
            proposed: false,
            inboxItemId: open.id,
            note: `A move to ${open.to} is already waiting for the owner; nothing more was proposed.`,
          };
        }
        const tier = loosens(from, to) ? 3 : 2;
        const why = typeof input.why === 'string' && input.why.trim() ? `\n\n${input.why.trim()}` : '';
        const inboxItemId = await raiseEscalationWithin(tx, {
          companyId: ctx.companyId,
          title: `Move the company from ${from ?? 'no stage'} to ${to}?`,
          detail: `${evidence}${why}`,
          tier,
          payload: { stageChange: { from, to }, proposedByTask: ctx.taskId },
          consequenceIfDenied: from
            ? `The company stays in the ${from} stage.`
            : 'The company stays without a stage.',
        });
        return { proposed: true, inboxItemId };
      });
    },
  };
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
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, description: 'One question only the owner can answer.' },
        why: { type: 'string', description: 'What depends on the answer.' },
        options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', minLength: 1 }, description: 'Two to six answers the owner can press.' },
      },
    },
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
  /** The ticket this hands on, which is then being worked by the child and closes when it finishes (0070). */
  ticketId?: string;
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
    inputSchema: {
      type: 'object',
      required: ['role', 'brief'],
      properties: {
        role: { type: 'string', minLength: 1, description: 'The slug of the role whose job it is.' },
        brief: { type: 'string', minLength: 1, description: 'What it should do, and what done looks like.' },
        context: { type: 'string', description: 'Anything it needs to know that the brief does not say.' },
        timeoutMinutes: { type: 'integer', minimum: 1, description: 'How long it has (default 60).' },
        ticketId: { type: 'string', description: 'The ticket this hands on, from ticket.list; it closes when the work is done.' },
      },
    },
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
        const ticket = typeof input.ticketId === 'string' ? await readTicket(tx, input.ticketId) : null;
        // Worked already by a child of this very task: the delegation being replayed.
        const ours = ticket?.workingTaskId
          ? (await tx.query('SELECT 1 FROM tasks WHERE id = $1 AND parent_task_id = $2', [ticket.workingTaskId, ctx.taskId])).rowCount === 1
          : false;
        return { role: role.rows[0], parent, ticket, ours };
      });
      if (typeof input.ticketId === 'string') {
        // Checked before the child exists, so a ticket that cannot be handed
        // on does not leave work started under it.
        if (!found.ticket) throw new PalugadaError('contract.violation', `no ticket ${input.ticketId} in this company`, { field: 'ticketId' });
        if (found.ticket.status !== 'open' && !found.ours) {
          throw new PalugadaError('contract.violation',
            found.ticket.status === 'in_progress'
              ? `ticket "${found.ticket.title}" is already being worked, by task ${found.ticket.workingTaskId}`
              : `ticket "${found.ticket.title}" is ${found.ticket.status}`,
            { field: 'ticketId' });
        }
      }
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
      await withTenant(ctx.companyId, async (tx) => {
        await tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [found.role!.id]);
        // A replayed delegation finds its child already working the ticket.
        if (found.ticket && found.ticket.workingTaskId !== child.id) await startTicket(tx, ctx.companyId, found.ticket.id, child.id);
      });
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
    inputSchema: {
      type: 'object',
      required: ['childId'],
      properties: { childId: { type: 'string', minLength: 1, description: 'The id task.delegate returned.' } },
    },
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
  'stage.propose',
] as const;
