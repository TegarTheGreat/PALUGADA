/**
 * Policy engine (PRD F3.3, F3.5, F3.8) -- the enforceable half of the "soul".
 *
 * Precedence is platform > company > division, and a lower layer may only
 * tighten (F3.5). That is enforced in two independent places, which is
 * deliberate rather than redundant:
 *
 *   - When a policy is saved, a database trigger refuses a lower-scope rule
 *     that loosens one of the same name defined above it. This is the check
 *     the PRD's acceptance criterion describes.
 *   - Here, at evaluation time, the strictest matching effect wins regardless
 *     of the scope it came from. So even a policy inserted by some future code
 *     path that skipped the trigger cannot widen what a broader scope allows.
 *
 * The default with no matching policy is `allow`, because policy is a second
 * gate rather than the first: capability grants and reversibility tiers have
 * already run in the broker by this point. A policy layer that had to
 * enumerate every permitted action would be a firewall, and would make adding
 * a capability a policy migration.
 */
import type { TenantClient } from '../db/tenant.ts';
import { evaluateCondition, type ActionFacts, type Condition } from './condition.ts';

export const POLICY_EFFECTS = ['allow', 'require_review', 'require_approval', 'deny'] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** Higher is stricter. Mirrors app.policy_strictness() in the database. */
const STRICTNESS: Record<PolicyEffect, number> = {
  allow: 0,
  require_review: 1,
  require_approval: 2,
  deny: 3,
};

export function strictness(effect: PolicyEffect): number {
  return STRICTNESS[effect];
}

export function strictest(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export type PolicyScope = 'platform' | 'company' | 'division';

export interface PolicyRow {
  id: string;
  slug: string;
  scope: PolicyScope;
  effect: PolicyEffect;
  condition: Condition;
  mode: 'enforce' | 'log_only';
  /** Effect arguments, such as the reviewer role a require_review names. */
  params: Record<string, unknown>;
}

export interface PolicyMatch {
  id: string;
  slug: string;
  scope: PolicyScope;
  effect: PolicyEffect;
  mode: 'enforce' | 'log_only';
  params: Record<string, unknown>;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Enforcing policies that matched and therefore shaped the outcome. */
  matched: PolicyMatch[];
  /**
   * F3.8: policies in audit mode that matched. They are reported so a new rule
   * can be measured against live traffic, and they never change the effect.
   */
  observed: PolicyMatch[];
}

/**
 * Loads every policy that could apply to this division.
 *
 * Row-level security already confines company-scoped rows to their tenant; the
 * division predicate narrows further, and platform rows (company_id IS NULL)
 * apply everywhere.
 */
export async function loadApplicablePolicies(
  tx: TenantClient,
  companyId: string,
  divisionId: string,
): Promise<PolicyRow[]> {
  const { rows } = await tx.query<{
    id: string;
    slug: string;
    company_id: string | null;
    division_id: string | null;
    effect: PolicyEffect;
    condition: Condition;
    mode: 'enforce' | 'log_only';
    params: Record<string, unknown>;
  }>(
    `SELECT id, slug, company_id, division_id, effect, condition, mode, params
       FROM policies
      WHERE company_id IS NULL
         OR (company_id = $1 AND (division_id IS NULL OR division_id = $2))`,
    [companyId, divisionId],
  );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    scope: row.company_id === null ? 'platform' : row.division_id === null ? 'company' : 'division',
    effect: row.effect,
    condition: row.condition,
    mode: row.mode,
    params: row.params,
  }));
}

/**
 * Decides what a set of policies says about one action.
 *
 * Pure, so it can be exercised without a database and so the precedence rule
 * is readable in one place.
 */
export function decide(policies: PolicyRow[], facts: ActionFacts): PolicyDecision {
  const matched: PolicyMatch[] = [];
  const observed: PolicyMatch[] = [];
  let effect: PolicyEffect = 'allow';

  for (const policy of policies) {
    if (!evaluateCondition(policy.condition, facts)) continue;

    const match: PolicyMatch = {
      id: policy.id,
      slug: policy.slug,
      scope: policy.scope,
      effect: policy.effect,
      mode: policy.mode,
      params: policy.params,
    };

    if (policy.mode === 'log_only') {
      observed.push(match);
      continue;
    }

    matched.push(match);
    effect = strictest(effect, policy.effect);
  }

  return { effect, matched, observed };
}

export async function evaluate(
  tx: TenantClient,
  companyId: string,
  divisionId: string,
  facts: ActionFacts,
): Promise<PolicyDecision> {
  return decide(await loadApplicablePolicies(tx, companyId, divisionId), facts);
}
