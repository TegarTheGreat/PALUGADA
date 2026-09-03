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
import { assertCalibrated } from './catalogue.ts';

export interface CapabilityContext {
  companyId: string;
  divisionId: string;
  taskId: string;
  /** F5.2. Pass this to the downstream system so a replay is recognised. */
  idempotencyKey: string;
  signal: AbortSignal;
  /**
   * The secret behind one of this division's credential aliases (F12.1-F12.3).
   *
   * The capability asks for the alias it needs and the broker resolves it
   * against the *calling* division, so a role cannot receive another division's
   * secret by naming their alias -- the division is part of the lookup rather
   * than a check afterwards. The value is registered with the redactor on the
   * way out, which is what makes section 12.4's "a secret never appears in a
   * log or an event" hold for a credential this capability then echoes.
   *
   * Resolved per call rather than handed over at registration: the version is
   * read every time, so F12.3's rotation takes effect on the next call instead
   * of within a cache lifetime.
   *
   * Throws `capability.not_granted` when the division holds no such alias, and
   * `credential.unavailable` when the broker was built without a secret
   * manager -- which is a deployment that never configured one, and is a
   * clearer answer than a capability failing at the provider with a blank
   * token.
   */
  credential(alias: string): Promise<string>;
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
  /**
   * Reports the destination and cost of a call so policy conditions can
   * reference them (PRD F3.4).
   *
   * The capability declares this rather than the broker inspecting the input
   * object for likely field names. Guessing would break silently the day a
   * capability renamed a field, and a policy that quietly stops matching is a
   * policy that has stopped protecting.
   */
  describe?(input: I): {
    moneyCents?: number;
    recipientDomain?: string | null;
    urlHost?: string | null;
    /**
     * How many items this call covers, when it is a batch (F8.13).
     *
     * Reported by the capability rather than guessed from the input, for the
     * same reason as the fields above: a guess breaks silently the day an
     * argument is renamed, and a batch guard that has quietly stopped guarding
     * is worse than none.
     */
    batchSize?: number;
  };
  /**
   * Reports whether the capability is usable right now (F8.12).
   *
   * Credentials, quota, connectivity -- whatever would make the first real
   * call fail for a reason no retry fixes. Optional: a capability that needs
   * nothing checked declares no preflight and is healthy by definition, which
   * is true of every pure computation.
   */
  preflight?(ctx: { companyId: string; divisionId: string }): Promise<{
    ok: boolean;
    detail?: string;
  }>;
  /**
   * Reports what the call actually cost, once it has happened (F8.5).
   *
   * Optional, and returning null is a legitimate answer: "this cost nothing"
   * and "nobody measured this" are different facts, and the broker keeps them
   * apart rather than reporting an unmeasured call as free.
   */
  actualCostCents?(input: I, result: O, ctx: CapabilityContext): Promise<number | null>;
  /**
   * Whether the capability runs code supplied at call time (F8.10).
   *
   * Declared here rather than inferred from the adapter name, because the
   * database refuses to place such a capability in a division that holds a
   * credential or a tier 2 grant, and a boundary that depends on a naming
   * convention is a boundary that ends the first time somebody renames
   * something.
   */
  executesUntrustedCode?: boolean;
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
    // Last, because the two checks above are about this capability being
    // internally coherent, while this one is about it agreeing with the
    // platform's calibration (section 8.8). A capability that fails the first
    // two is broken; one that fails this is a downgrade.
    assertCalibrated(capability);

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
             (name, adapter, default_tier, estimated_cost_cents, has_verify,
              executes_untrusted_code)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (name) DO UPDATE
             SET adapter = EXCLUDED.adapter,
                 default_tier = EXCLUDED.default_tier,
                 estimated_cost_cents = EXCLUDED.estimated_cost_cents,
                 has_verify = EXCLUDED.has_verify,
                 executes_untrusted_code = EXCLUDED.executes_untrusted_code`,
          [
            capability.name,
            capability.adapter,
            capability.defaultTier,
            capability.estimatedCostCents ?? 0,
            typeof capability.verify === 'function',
            capability.executesUntrustedCode ?? false,
          ],
        );
      }
    });
  }
}
