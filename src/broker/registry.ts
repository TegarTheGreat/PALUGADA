/**
 * Capability registry (PRD F8.2, F8.4).
 *
 * A capability is a tool the broker knows how to run. Registration is where
 * F8.4 is enforced: a capability at tier 1 or above must supply a `verify`
 * read-back, and one that does not is refused at registration rather than
 * discovered to be unverifiable during an incident. That is the difference
 * between "the API returned 200" and "the record actually says what we asked
 * for", which principle 6 insists on.
 */
import { PalugadaError } from '../errors.ts';
import { isTier, requiresVerification, type Tier } from '../domain/tier.ts';
import { withControlPlane } from '../db/tenant.ts';

export interface CapabilityContext {
  companyId: string;
  divisionId: string;
  taskId: string;
  /** F5.2. Pass this to the downstream system so a replay is recognised. */
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface Capability<I = unknown, O = unknown> {
  name: string;
  adapter: string;
  defaultTier: Tier;
  estimatedCostCents?: number;
  execute(input: I, ctx: CapabilityContext): Promise<O>;
  /**
   * Reads the external state back and reports whether it matches what was
   * requested. Required for tier >= 1.
   */
  verify?(input: I, result: O, ctx: CapabilityContext): Promise<boolean>;
}

export class CapabilityRegistry {
  readonly #capabilities = new Map<string, Capability<never, never>>();

  register<I, O>(capability: Capability<I, O>): void {
    if (!isTier(capability.defaultTier)) {
      throw new PalugadaError(
        'capability.unknown',
        `capability ${capability.name} declares an unknown tier ${capability.defaultTier}`,
      );
    }
    if (requiresVerification(capability.defaultTier) && typeof capability.verify !== 'function') {
      throw new PalugadaError(
        'capability.verify_missing',
        `capability ${capability.name} is tier ${capability.defaultTier} and must define verify() (PRD F8.4)`,
        { name: capability.name, tier: capability.defaultTier },
      );
    }
    this.#capabilities.set(capability.name, capability as unknown as Capability<never, never>);
  }

  get(name: string): Capability<never, never> | undefined {
    return this.#capabilities.get(name);
  }

  names(): string[] {
    return [...this.#capabilities.keys()];
  }

  /** Mirrors registered capabilities into the platform registry table. */
  async sync(): Promise<void> {
    const rows = [...this.#capabilities.values()];
    await withControlPlane(async (tx) => {
      for (const capability of rows) {
        await tx.query(
          `INSERT INTO capabilities
             (name, adapter, default_tier, estimated_cost_cents, has_verify)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE
             SET adapter = EXCLUDED.adapter,
                 default_tier = EXCLUDED.default_tier,
                 estimated_cost_cents = EXCLUDED.estimated_cost_cents,
                 has_verify = EXCLUDED.has_verify`,
          [
            capability.name,
            capability.adapter,
            capability.defaultTier,
            capability.estimatedCostCents ?? 0,
            typeof capability.verify === 'function',
          ],
        );
      }
    });
  }
}
