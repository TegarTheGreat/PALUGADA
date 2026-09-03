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
