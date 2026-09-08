/**
 * The capabilities PALUGADA implements itself (PRD v2 F4.8, F15.7).
 *
 * Almost every capability in the catalogue is a name waiting for an adapter
 * that talks to somebody else's service. These two are different: they read the
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

export function registerPlatformCapabilities(registry: {
  register(capability: Capability<never, never>): void;
}): void {
  registry.register(memorySearchCapability() as unknown as Capability<never, never>);
  registry.register(skillReadCapability() as unknown as Capability<never, never>);
  registry.register(planRecordCapability() as unknown as Capability<never, never>);
}

/** The names this module implements, for a caller that needs to know. */
export const PLATFORM_CAPABILITIES = ['memory.search', 'skill.read', 'plan.record'] as const;
