/**
 * What an action was expected to cost, and what it actually cost (PRD F8.5,
 * section 8.8's "cek budget" for tier 2).
 *
 * Three things happen here, in this order, and the order is the design.
 *
 * **The estimate is charged before the call.** A ceiling can only change the
 * outcome while the money is still unspent, so the budget is checked and
 * debited first; a refusal produces no downstream call, which is the same rule
 * F2.4 states for grants. If the call then fails, the estimate is refunded --
 * an action that did not happen must not leave a charge behind.
 *
 * **The actual is settled after the call, unconditionally.** The provider has
 * already billed by then and a ceiling cannot un-bill it. Refusing the
 * adjustment would leave the account claiming an amount the company does not
 * owe, so an overrun becomes a visible overspend and F11.4's alert turns it
 * into the owner's problem.
 *
 * **Drift is reported, not corrected.** F8.5 asks for an event when the two
 * differ by more than half. The event is the point: a capability whose
 * estimate is consistently wrong is a capability whose budget checks are
 * decorative, and nobody discovers that from a total that always adds up.
 *
 * A capability that reports no actual cost produces no drift event, and that
 * absence is deliberate rather than a silent zero. "This call cost nothing"
 * and "nobody measured this call" are different facts, and treating the second
 * as the first would report a 100% drift on every unmeasured capability and
 * bury the real ones.
 */
import { appendEvent } from '../audit/event-log.ts';
import * as budget from '../engine/budget.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

/** F8.5: more than half the estimate. */
export const DRIFT_THRESHOLD = 0.5;

export interface CostContext {
  companyId: string;
  projectId: string;
  taskId: string;
}

export interface DriftReport {
  estimatedCents: number;
  actualCents: number;
  /** Null when there was no estimate to divide by. */
  ratio: number | null;
  drifted: boolean;
}

/**
 * The estimate for one call.
 *
 * `describe()` wins over the registry's flat figure because it is per-call: a
 * capability that sends one email and one that sends ten thousand share a
 * name, and only the input knows which this is.
 */
export function estimateFor(
  capability: { estimatedCostCents?: number; describe?: (input: never) => { moneyCents?: number } },
  input: unknown,
): number {
  const described = capability.describe?.(input as never);
  const cents = described?.moneyCents ?? capability.estimatedCostCents ?? 0;
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

/** The budget account the task draws on. Sub-tasks share their parent's (F5.4). */
async function budgetAccountFor(tx: TenantClient, taskId: string): Promise<string> {
  const { rows } = await tx.query<{ budget_account_id: string }>(
    'SELECT budget_account_id FROM tasks WHERE id = $1',
    [taskId],
  );
  const accountId = rows[0]?.budget_account_id;
  if (!accountId) throw new Error(`task ${taskId} has no budget account`);
  return accountId;
}

/**
 * Charges the estimate, or refuses the action.
 *
 * Returns the account it charged so the caller can settle or refund against
 * the same one; reading it again later could find a different account if the
 * task were re-parented, and paying one account back for a charge made to
 * another is how ledgers stop balancing.
 */
export async function chargeEstimate(
  ctx: CostContext,
  capabilityName: string,
  estimatedCents: number,
): Promise<{ accountId: string } | null> {
  if (estimatedCents <= 0) return null;

  const { accountId, funded } = await withTenant(ctx.companyId, async (tx) => {
    const id = await budgetAccountFor(tx, ctx.taskId);
    return { accountId: id, funded: await budget.spend(tx, id, { tokens: 0, moneyCents: estimatedCents }) };
  });

  if (!funded) {
    // Recorded in its own transaction: the throw below would otherwise roll
    // the event back with it and leave a refused action with no trace.
    await withTenant(ctx.companyId, async (tx) => {
      await appendEvent(tx, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        type: 'budget.refused',
        actor: 'broker',
        payload: { capability: capabilityName, estimatedCents, budgetAccountId: accountId },
      });
    });
    throw new PalugadaError(
      'budget.exceeded',
      `capability ${capabilityName} would cost ${estimatedCents} cents and the budget will not cover it`,
      { name: capabilityName, estimatedCents, budgetAccountId: accountId },
    );
  }

  return { accountId };
}

/** Returns an unused charge when the action it was for did not happen. */
export async function refundEstimate(
  ctx: CostContext,
  accountId: string,
  estimatedCents: number,
): Promise<void> {
  if (estimatedCents <= 0) return;
  await withTenant(ctx.companyId, async (tx) => {
    await tx.query('SELECT app.budget_settle($1, $2)', [accountId, -estimatedCents]);
  });
}

/**
 * Settles the difference and reports drift (F8.5).
 *
 * Called with the actual cost the capability measured, which may be null when
 * it measured nothing. Everything here is a no-op in that case, on purpose.
 */
export async function settleActual(
  ctx: CostContext,
  accountId: string | null,
  capabilityName: string,
  estimatedCents: number,
  actualCents: number | null,
): Promise<DriftReport | null> {
  const actual = actualCents === null ? null : Math.max(0, Math.round(actualCents));
  const delta = actual === null ? 0 : actual - estimatedCents;

  const ratio = actual === null || estimatedCents === 0 ? null : Math.abs(delta) / estimatedCents;
  const drifted = actual === null ? false : ratio === null ? actual > 0 : ratio > DRIFT_THRESHOLD;

  await withTenant(ctx.companyId, async (tx) => {
    if (delta !== 0) {
      // An account is only absent when the estimate was zero and nothing was
      // charged, so the settlement has to find the account for itself.
      const target = accountId ?? (await budgetAccountFor(tx, ctx.taskId));
      await tx.query('SELECT app.budget_settle($1, $2)', [target, delta]);
    }

    // Emitted for every call that ran, measured or not, because this is the
    // row F11.3 adds up. `actualCents: null` says the capability measured
    // nothing, so the report can fall back to the estimate and say that it
    // did rather than presenting a guess as a measurement.
    await appendEvent(tx, {
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      type: 'tool.cost',
      actor: 'broker',
      payload: { capability: capabilityName, estimatedCents, actualCents: actual },
    });

    if (drifted) {
      await appendEvent(tx, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        type: 'cost.drift',
        actor: 'broker',
        payload: {
          capability: capabilityName,
          estimatedCents,
          actualCents: actual ?? 0,
          ratio,
          // Named rather than inferred from the numbers, because the two cases
          // need different fixes: an unestimated cost is a missing describe(),
          // a mis-estimated one is a wrong constant.
          reason: estimatedCents === 0 ? 'unestimated' : 'estimate_off_by_more_than_half',
        },
      });
    }
  });

  return actual === null ? null : { estimatedCents, actualCents: actual, ratio, drifted };
}
