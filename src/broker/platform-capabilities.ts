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
import { GOAL_STATUSES, proposeGoalChange, type GoalStatus } from '../domain/goals.ts';
import { approvedReviewOf, fingerprintAction } from '../review/review.ts';
import { createSubTask, getTask, transition } from '../engine/tasks.ts';
import { listTickets, openTicket, readTicket, startTicket } from '../engine/tickets.ts';
import { searchDocuments } from '../knowledge/documents.ts';
import { queryMeaning } from '../knowledge/meaning.ts';
import { containChildResult } from '../engine/containment.ts';
import { taskCostCents } from '../reporting/cost.ts';
import { enqueueWake } from '../scheduler/wake.ts';
import { isTerminal, type TaskStatus } from '../domain/task.ts';
import { PalugadaError, isPalugadaError } from '../errors.ts';
import { appendEvent } from '../audit/event-log.ts';
import { hashInput } from '../engine/hash.ts';
import { noteTalkDrift } from '../domain/language.ts';
import type { Capability } from './registry.ts';

export interface MemorySearchInput {
  query: string;
  /** How many facts to return. Bounded below, so a search cannot be a dump. */
  limit?: number;
  /**
   * Defaults to semantic: the kind F4.8 leaves out of the pack. Episodic is
   * what finished work in the run's own project did, one line a task (F4.6).
   */
  memoryType?: 'semantic' | 'procedural' | 'episodic';
}

export interface MemorySearchResult {
  facts: Array<{ body: string; confidence: number; source: string; unverified: boolean; outside?: boolean }>;
  /** Passages of the company's documents the query's words point at (0075). */
  documents: Array<{ title: string; heading: string | null; passage: string }>;
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
        query: { type: 'string', minLength: 1, description: 'What to look for, in a few words. Searches the company\'s facts and its documents.' },
        limit: { type: 'integer', minimum: 1, maximum: MEMORY_SEARCH_MAX_RESULTS, description: 'How many facts to return (default 5).' },
        memoryType: {
          enum: ['semantic', 'procedural', 'episodic'],
          description: 'Facts (default), procedures, or past events: what finished work in this project did and reported.',
        },
      },
    },
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    // A lesson learned from outside content (0071) comes back as the data it
    // is, and the work that found it carries that data now, as if it had
    // read the email itself (F8.9). The company's own facts do not.
    readsOutside: (output) => ((output as { facts?: Array<{ outside?: boolean }> }).facts ?? [])
      .some((fact) => fact.outside === true),
    async execute(input, ctx) {
      const limit = Math.min(Math.max(1, input.limit ?? 5), MEMORY_SEARCH_MAX_RESULTS);
      // Ranked by the words a fact shares with the query, in the database,
      // across everything the division may see. It read the eighty newest
      // and kept those containing the query as written, so an old fact could
      // not be found by any words. The scope rules stay in `recall`: a search
      // that reached past its division would make F4.6 a matter of which code
      // path was used.
      //
      // Past events are shared across a project rather than walled off per
      // division (F4.6), so an episodic search is scoped to the project of the
      // work asking -- read from its task, the one thing the broker hands every
      // capability. Without it `recall` fell back to the division's scope,
      // where no episode is ever kept, and its project branch was reached by
      // tests alone.
      const memoryType = input.memoryType ?? 'semantic';
      const facts = await withTenant(ctx.companyId, async (tx) => {
        const projectId = memoryType === 'episodic'
          ? (await tx.query<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = $1', [ctx.taskId])).rows[0]?.project_id
          : undefined;
        if (memoryType === 'episodic' && !projectId) return [];
        return recall(tx, ctx.companyId, {
          memoryType,
          divisionId: ctx.divisionId,
          projectId,
          text: input.query,
          limit: limit + 1,
        });
      });

      // And the company's documents: the passages the same words point at
      // (0075), from what this division may read. Each is data -- a
      // contract or a supplier's price list says what it says, and never
      // instructs the run that reads it.
      // And by meaning, when the deployment has a provider for it: the
      // query's vector is made before the transaction, which a network call
      // should not hold open.
      const meaning = await queryMeaning(input.query);
      const passages = await withTenant(ctx.companyId, (tx) => searchDocuments(tx, {
        divisionId: ctx.divisionId, query: input.query, limit: 3, ...(meaning ? { meaning } : {}),
      }));

      return {
        documents: passages.map((found) => ({
          title: found.title,
          heading: found.heading,
          passage: wrapUntrusted(`document:${found.title}`, found.body),
        })),
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
      const skill = await readSkill(ctx.companyId, input.slug, ctx.divisionId);
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
        // Read by the owner on the board and by whichever role takes it on.
        // A ticket already open under the same title keeps the words it had,
        // so only a new one is checked.
        if (!opened.existing) {
          await noteTalkDrift(tx, {
            companyId: ctx.companyId, taskId: ctx.taskId, where: 'ticket',
            text: `${opened.ticket.title}\n${opened.ticket.body}`,
          });
        }
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
  get?(name: string): unknown;
}): void {
  registry.register(memorySearchCapability() as unknown as Capability<never, never>);
  registry.register(skillReadCapability() as unknown as Capability<never, never>);
  registry.register(planRecordCapability() as unknown as Capability<never, never>);
  registry.register(metricRecordCapability() as unknown as Capability<never, never>);
  registry.register(ownerAskCapability(registry.get ? (name) => Boolean(registry.get!(name)) : undefined) as unknown as Capability<never, never>);
  registry.register(taskDelegateCapability() as unknown as Capability<never, never>);
  registry.register(taskAwaitCapability() as unknown as Capability<never, never>);
  registry.register(stageProposeCapability() as unknown as Capability<never, never>);
  registry.register(goalProposeCapability() as unknown as Capability<never, never>);
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
        // A policy may have had another role review this first -- company-os
        // has its critic read every one. What it said goes on the card the
        // owner answers, beside the proposer's case, not only back to the
        // proposer. Found by this exact action, as the broker's grant was.
        const review = await approvedReviewOf(tx, ctx.taskId, fingerprintAction('stage.propose', input));
        const reviewed = review ? `\n\nReviewed by ${review.reviewer.name} before you:\n${review.reason}` : '';
        const inboxItemId = await raiseEscalationWithin(tx, {
          companyId: ctx.companyId,
          title: `Move the company from ${from ?? 'no stage'} to ${to}?`,
          detail: `${evidence}${why}${reviewed}`,
          tier,
          payload: {
            stageChange: { from, to },
            proposedByTask: ctx.taskId,
            ...(review
              ? {
                  review: {
                    reviewer: review.reviewer.slug, decision: 'approve', reason: review.reason,
                    reviewRequestId: review.reviewRequestId,
                  },
                }
              : {}),
          },
          consequenceIfDenied: from
            ? `The company stays in the ${from} stage.`
            : 'The company stays without a stage.',
        });
        // The proposer's case is its own words to the owner; the reviewer's,
        // beside it, was checked when the review was recorded.
        await noteTalkDrift(tx, {
          companyId: ctx.companyId, taskId: ctx.taskId, where: 'stage_proposal', text: `${evidence}${why}`,
        });
        return { proposed: true, inboxItemId };
      });
    },
  };
}

export interface GoalProposeInput {
  /** The goal, by its slug or its id. */
  goal: string;
  /** What the goal should say instead. */
  statement?: string;
  /** Close it as met or abandoned, or reopen it. */
  status?: GoalStatus;
  /** The evidence, with where each piece came from. */
  why: string;
}

/**
 * `goal.propose`: ask the owner to change a goal (F3.10).
 *
 * `proposeGoalChange` was documented as the agent's path and no agent could
 * take it -- the strategist's done criterion says a goal change is "written
 * as a proposal", and it had nothing to write one with, so it could only say
 * so in prose the owner then had to carry out by hand. Tier 0 for the reason
 * `stage.propose` is: it opens one item and changes nothing. The goal changes
 * when the owner approves, with their device, and not before.
 */
export function goalProposeCapability(): Capability<GoalProposeInput, { proposed: boolean; inboxItemId: string; note?: string }> {
  return {
    name: 'goal.propose',
    inputSchema: {
      type: 'object',
      required: ['goal', 'why'],
      properties: {
        goal: { type: 'string', minLength: 1, description: 'The goal, by its slug (as the weekly brief names it) or its id.' },
        statement: { type: 'string', minLength: 1, description: 'What the goal should say instead.' },
        status: { enum: [...GOAL_STATUSES], description: 'met or abandoned to close it, active to reopen it.' },
        why: { type: 'string', minLength: 1, description: 'The evidence for the change, with where each piece came from.' },
      },
    },
    adapter: 'platform',
    defaultTier: TIER.READ_ONLY,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      return proposeGoalChange({
        companyId: ctx.companyId,
        taskId: ctx.taskId,
        goal: String(input.goal ?? ''),
        proposedStatement: input.statement,
        proposedStatus: input.status,
        rationale: input.why,
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
/**
 * Words that make a question one about setting a tool up rather than about
 * the work, in English and Indonesian (L7).
 */
const SETUP_WORDS = /\b(bind|bound|binding|connect\w*|integrat\w*|vendor|provider|set\s?up|configure|install\w*|api\s?key|credential|hubung\w*|sambung\w*|pasang|integrasi|konfigurasi)\b/i;

/** Whether a question names a capability, by its name or the service before its dot (`crm` of `crm.note`). */
function names(question: string, capability: string): boolean {
  const terms = [capability, capability.split('.')[0]!];
  return terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question));
}

/**
 * The role's tools that nothing in this deployment is bound to, and that a
 * question asks how to set up: what the platform answers itself (L7).
 */
async function setupAsked(
  ctx: { companyId: string; taskId: string },
  question: string,
  bound: (name: string) => boolean,
): Promise<string[]> {
  if (!SETUP_WORDS.test(question)) return [];
  const tools = await withTenant(ctx.companyId, async (tx) => {
    const { rows } = await tx.query<{ tools: string[] | null }>(
      'SELECT r.tools FROM tasks t JOIN roles r ON r.id = t.role_id WHERE t.id = $1', [ctx.taskId]);
    return rows[0]?.tools ?? [];
  });
  return tools.filter((name) => !bound(name) && names(question, name));
}

/**
 * `bound` says whether a capability is bound in this deployment. Given, a
 * question about setting up a tool nothing is bound to -- "which CRM vendor
 * should I bind?" -- is answered here rather than put to the owner (L7):
 * the owner connects a service on This deployment, Services, and an answer
 * typed into an inbox item connects nothing. The run is told so and carries
 * on; the owner is asked only what they can answer.
 */
export function ownerAskCapability(bound?: (name: string) => boolean): Capability<OwnerAskInput, OwnerAskResult> {
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
      const unbound = bound ? await setupAsked(ctx, question, bound) : [];
      if (unbound.length > 0) {
        await withTenant(ctx.companyId, (tx) => appendEvent(tx, {
          companyId: ctx.companyId, taskId: ctx.taskId, type: 'task.question_answered_by_platform', actor: 'system',
          payload: { question, capabilities: unbound },
        }));
        return {
          answered: true,
          answer: `${unbound.join(', ')} ${unbound.length === 1 ? 'is' : 'are'} not connected in this deployment. The owner `
            + 'connects a service on This deployment, Services, and an answer from the inbox connects nothing, so this was '
            + 'not put to them. Carry on without it: do the part of the work you can, and say in your output what is left '
            + 'for when it is connected.',
        };
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
      const childInput = { goal: brief, ...(typeof input.context === 'string' ? { context: input.context } : {}) };
      const found = await withTenant(ctx.companyId, async (tx) => {
        const parent = await getTask(tx, ctx.taskId);
        const roles = await tx.query<NamedRole>(
          'SELECT id, slug, division_id, display_name, title FROM roles ORDER BY slug');
        const role = resolveRole(roles.rows, String(input.role ?? ''), parent?.roleId ?? null);
        const ticket = typeof input.ticketId === 'string' ? await readTicket(tx, input.ticketId) : null;
        // Worked already by a child of this very task: the delegation being replayed.
        const ours = ticket?.workingTaskId
          ? (await tx.query('SELECT 1 FROM tasks WHERE id = $1 AND parent_task_id = $2', [ticket.workingTaskId, ctx.taskId])).rowCount === 1
          : false;
        // The same brief to the same role from this task, already started:
        // the child `createSubTask` will hand back rather than make again.
        const again = (await tx.query('SELECT 1 FROM tasks WHERE parent_task_id = $1 AND role_id = $2 AND input_hash = $3',
          [ctx.taskId, role.id, hashInput(childInput)])).rowCount === 1;
        return { role, parent, ticket, ours, again };
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
      if (!found.parent) throw new PalugadaError('contract.violation', 'no such task', { taskId: ctx.taskId });
      const deadlineAt = new Date(Date.now() + minutes * 60_000);
      const child = await createSubTask(ctx.taskId, {
        companyId: ctx.companyId,
        projectId: found.parent.projectId,
        divisionId: found.role.division_id,
        roleId: found.role.id,
        input: childInput,
        createdBy: 'agent_run',
        deadlineAt,
      });
      await withTenant(ctx.companyId, async (tx) => {
        await tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [found.role.id]);
        // A replayed delegation finds its child already working the ticket.
        if (found.ticket && found.ticket.workingTaskId !== child.id) await startTicket(tx, ctx.companyId, found.ticket.id, child.id);
        // The brief is this role's words to another. The context is not
        // checked: it is where material goes -- the customer's email, the
        // page that was read -- and material is in whatever language it came.
        if (!found.again) {
          await noteTalkDrift(tx, { companyId: ctx.companyId, taskId: ctx.taskId, where: 'handoff', text: brief });
        }
      });
      await enqueueWake({
        companyId: ctx.companyId,
        roleId: found.role.id,
        reason: 'event',
        detail: `task ${ctx.taskId} delegated task ${child.id}`,
      });
      return { childId: child.id, role: found.role.slug, deadlineAt: (child.deadlineAt ?? deadlineAt).toISOString() };
    },
  };
}

interface NamedRole {
  id: string;
  slug: string;
  division_id: string;
  display_name: string | null;
  title: string | null;
}

/**
 * The role a delegation names: by its slug, or by a title or name that is one
 * role's alone.
 *
 * Models name a colleague the way people do -- "the CMO", "Laras" -- and a
 * slug-only lookup refused every one of those on a live run, nineteen times
 * in a row, with an answer that said nothing about what would have been
 * accepted. A title or name shared by two roles is refused rather than
 * guessed between: handing a payment to the wrong "Head of Finance" is worse
 * than asking again. Every refusal lists the roles there are, and the
 * nearest slug when one is close, so the next call can be right.
 */
function resolveRole(roles: readonly NamedRole[], asked: string, asking: string | null): NamedRole {
  const wanted = asked.trim().toLowerCase();
  const bySlug = roles.find((role) => role.slug === wanted);
  if (bySlug) return bySlug;
  const named = roles.filter((role) =>
    [role.title, role.display_name].some((label) => label !== null && label.trim().toLowerCase() === wanted));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new PalugadaError('contract.violation',
      `"${asked}" is the title or name of more than one role (${named.map((role) => role.slug).join(', ')}); name one by its slug`,
      { field: 'role' });
  }
  const offered = roles.filter((role) => role.id !== asking);
  const describe = (role: NamedRole) => {
    const who = [role.display_name, role.title].filter(Boolean).join(', ');
    return who ? `${role.slug} (${who})` : role.slug;
  };
  const near = nearestRole(offered, wanted);
  throw new PalugadaError('contract.violation',
    `no role "${asked}" in this company${near ? `; did you mean ${describe(near)}?` : '.'} ` +
    `The roles are: ${offered.map(describe).join(', ')}. Name one by its slug.`,
    { field: 'role' });
}

/** The role whose slug, title or name is within a few edits of what was asked, or that shares its first five letters. */
function nearestRole(roles: readonly NamedRole[], wanted: string): NamedRole | null {
  let best: { role: NamedRole; distance: number } | null = null;
  for (const role of roles) {
    for (const label of [role.slug, role.title, role.display_name]) {
      if (!label) continue;
      const candidate = label.trim().toLowerCase();
      const distance = editDistance(wanted, candidate);
      const close = distance <= Math.max(2, Math.floor(wanted.length * 0.4))
        || (wanted.length >= 5 && candidate.startsWith(wanted.slice(0, 5)));
      if (close && (!best || distance < best.distance)) best = { role, distance };
    }
  }
  return best?.role ?? null;
}

/** Levenshtein distance; names are short, so the quadratic table is a few hundred cells. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

export interface TaskAwaitResult {
  status: string;
  /** The child's output, contained to what a parent may be handed (F6.7); null unless it completed. */
  output: Record<string, unknown> | null;
  summary: string;
  /** Set when the output was cut to fit: the child keeps it whole, for the owner and for anyone pointing to it. */
  abbreviated: { taskId: string; characters: number } | null;
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
          parent_task_id: string | null; deadline_at: Date | null; role: string; steps: number; held: boolean;
        }>(
          `SELECT t.status, t.output, t.halt_reason, t.parent_task_id, t.deadline_at, r.slug AS role,
                  t.lease_holder IS NOT NULL AS held,
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
        const costCents = await withTenant(ctx.companyId, (tx) => taskCostCents(tx, String(input.childId)));
        const contained = containChildResult(found.role, found.output ?? {}, {
          status: found.status, steps: found.steps, costCents, taskId: String(input.childId),
        });
        return { status: found.status, output: contained.output, summary: contained.summary, abbreviated: contained.abbreviated };
      }
      // Past its deadline and nobody running it: halted here, as the worker's
      // sweep would halt it, and answered. Parking again would reopen at a
      // deadline already behind us, and the parent would ask every second.
      if (!isTerminal(found.status) && !found.held && found.deadline_at && found.deadline_at.getTime() <= Date.now()) {
        try {
          await transition(ctx.companyId, String(input.childId), 'halted', {
            haltReason: 'deadline_passed', detail: 'its deadline passed before any worker could finish it',
          });
          found.status = 'halted';
          found.halt_reason = 'deadline_passed';
        } catch (error) {
          if (!isPalugadaError(error, 'task.invalid_transition')) throw error;
        }
      }
      if (isTerminal(found.status)) {
        return {
          status: found.status,
          output: null,
          summary: `${found.role} ${found.status}${found.halt_reason ? ` (${found.halt_reason})` : ''} without a result`,
          abbreviated: null,
        };
      }
      const next = Date.now() + AWAIT_POLL_MS;
      // The deadline only while it is ahead: one already passed belongs to a
      // run still holding the child, which halts it at its next step.
      const reopensAt = found.deadline_at && found.deadline_at.getTime() > Date.now()
        ? Math.min(next, found.deadline_at.getTime() + 1_000) : next;
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
  'stage.propose', 'goal.propose',
] as const;
