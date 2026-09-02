/**
 * Reversibility tiers (PRD section 8.8).
 *
 * The tier classifies the *effect* of an action, not the tool that performs
 * it. Section 12 lists "an agent reaching a tier 3 effect by combining tier 1
 * actions" as a live risk, and classifying per effect is the stated mitigation.
 */
export const TIER = {
  /** Read-only: DNS lookups, uptime checks, listing files. */
  READ_ONLY: 0,
  /** Cheap reversible write: a draft, a staging subdomain, a staging deploy. */
  REVERSIBLE_WRITE: 1,
  /** Expensive or slow to undo, or spends money: external email, a purchase. */
  COSTLY: 2,
  /** Irreversible or destructive: nameservers, deletions, transfers, signatures. */
  IRREVERSIBLE: 3,
} as const;

export type Tier = 0 | 1 | 2 | 3;

export function isTier(value: number): value is Tier {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * A grant may tighten a capability but never loosen it (F8.3), so the
 * effective tier is the stricter of the registry default and any override.
 */
export function effectiveTier(registryDefault: Tier, override: Tier | null): Tier {
  return override === null ? registryDefault : (Math.max(registryDefault, override) as Tier);
}

/**
 * Tier 3 always goes to a human (PRD principle 10, F8.3). There is no
 * trusted-agent mode and no policy that can waive this, which is why the
 * check is a function of the tier alone.
 */
export function requiresOwnerApproval(tier: Tier): boolean {
  return tier >= TIER.IRREVERSIBLE;
}

/** Write actions must be verified by read-back (F8.4). */
export function requiresVerification(tier: Tier): boolean {
  return tier >= TIER.REVERSIBLE_WRITE;
}
