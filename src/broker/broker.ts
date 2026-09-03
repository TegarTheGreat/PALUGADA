/**
 * Capability broker (PRD F8.1, F8.3, F8.6, F8.8, F3.3, F9.2, section 6.2 step 4).
 *
 * Every external action passes through here; an agent holds no connection of
 * its own. The order of the gates is deliberate and each one is placed where
 * it is for a reason:
 *
 *   1. Platform stop and company freeze, because a halted platform should not
 *      even consult its configuration.
 *   2. Kill switch, grant and rate limit -- all before anything reaches an
 *      adapter, because F2.4 requires a refusal to produce no downstream call.
 *      A refusal issued after the request has left is not a refusal.
 *   3. Policy (F3.3). It runs after the tier is known, because a condition may
 *      reference the tier, and before execution because its whole purpose is
 *      to stop things.
 *   4. The external window (F9.2), which defers rather than refuses: outside
 *      permitted hours the task waits, since the action is allowed, just not
 *      now.
 *   5. Owner approval for tier 3 or for a policy that demands it. Principle 10
 *      admits no exception and no trusted-agent mode.
 *
 * Policy and tier are independent gates and the stricter always wins: a policy
 * cannot lower a tier 3 action below owner approval, and a tier 0 read can
 * still be denied by policy.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError, type ErrorCode } from '../errors.ts';
import {
  effectiveTier,
  requiresOwnerApproval,
  requiresVerification,
  type Tier,
} from '../domain/tier.ts';
import { isCompanyFrozen, isStopAllRequested } from '../engine/control.ts';
import { evaluate, type PolicyDecision } from '../policy/engine.ts';
import type { ActionFacts } from '../policy/condition.ts';
import { capabilityWindow, isWithin, localTimeIn, nextOpening } from '../scheduler/windows.ts';
import * as inbox from '../inbox/inbox.ts';
import { redactor } from '../secrets/manager.ts';
import { fingerprintAction, isApproved, openReview } from '../review/review.ts';
import { chargeEstimate, estimateFor, refundEstimate, settleActual } from './cost.ts';
import type { CapabilityRegistry } from './registry.ts';

export interface InvokeContext {
  companyId: string;
  projectId: string;
  divisionId: string;
  taskId: string;
  /** The proposing role. Needed so a reviewer is never the proposer (F7.3). */
  roleId: string;
  idempotencyKey: string;
  signal?: AbortSignal | undefined;
}

export interface InvokeResult<O> {
  output: O;
  tier: Tier;
  verified: boolean;
  policy: PolicyDecision;
  /** What was charged before the call and what it turned out to cost (F8.5). */
  cost: { estimatedCents: number; actualCents: number | null; drifted: boolean };
}

type DenialCode = Extract<
  ErrorCode,
  'capability.disabled' | 'capability.not_granted' | 'capability.rate_limited' | 'policy.denied'
>;

type Verdict =
  | {
      allowed: true;
      tier: Tier;
      policy: PolicyDecision;
      facts: ActionFacts;
      window: { closed: true; reopensAt: Date | null } | { closed: false };
    }
  | { allowed: false; reason: DenialCode; message: string; policy?: PolicyDecision };

export class CapabilityBroker {
  readonly #registry: CapabilityRegistry;

  constructor(registry: CapabilityRegistry) {
    this.#registry = registry;
  }

  async invoke<I, O>(ctx: InvokeContext, name: string, input: I): Promise<InvokeResult<O>> {
    const capability = this.#registry.get(name);
    if (!capability) {
      throw new PalugadaError('capability.unknown', `capability ${name} is not registered`, { name });
    }

    if (await isStopAllRequested()) {
      throw new PalugadaError('platform.stopped', 'platform stop is in effect', { name });
    }
    if (await isCompanyFrozen(ctx.companyId)) {
      throw new PalugadaError('company.frozen', 'company is frozen', { name });
    }

    const now = new Date();

    // The whole authorization decision is read in one transaction and returned
    // as a verdict rather than thrown from inside it. Throwing there would roll
    // the transaction back and take the denial record with it, leaving a
    // refused action with no trace -- the one thing an audit log must never do.
    const verdict = await withTenant(ctx.companyId, async (tx): Promise<Verdict> => {
      if (await readKillSwitch(tx, name)) {
        return {
          allowed: false,
          reason: 'capability.disabled',
          message: `capability ${name} is disabled`,
        };
      }

      const grant = await readGrant(tx, ctx.divisionId, name);
      if (!grant) {
        return {
          allowed: false,
          reason: 'capability.not_granted',
          message: `division ${ctx.divisionId} has no grant for ${name}`,
        };
      }

      if (grant.rateLimitPerHour !== null) {
        const used = await countRecentInvocations(tx, ctx.divisionId, name);
        if (used >= grant.rateLimitPerHour) {
          return {
            allowed: false,
            reason: 'capability.rate_limited',
            message: `capability ${name} exceeded ${grant.rateLimitPerHour} calls/hour for this division`,
          };
        }
      }

      const tier = effectiveTier(capability.defaultTier, grant.tierOverride);
      const facts = await buildFacts(tx, ctx, name, tier, capability.describe?.(input as never), now);
      const policy = await evaluate(tx, ctx.companyId, ctx.divisionId, facts);

      if (policy.effect === 'deny') {
        return {
          allowed: false,
          reason: 'policy.denied',
          message: `policy ${policy.matched.map((m) => m.slug).join(', ')} denies ${name}`,
          policy,
        };
      }

      const window = await capabilityWindow(tx, ctx.divisionId, name);
      const windowState =
        window && !isWithin(window, now)
          ? ({ closed: true, reopensAt: nextOpening(window, now) } as const)
          : ({ closed: false } as const);

      return { allowed: true, tier, policy, facts, window: windowState };
    });

    if (!verdict.allowed) {
      await withTenant(ctx.companyId, (tx) =>
        recordDenial(tx, ctx, name, verdict.reason, verdict.policy),
      );
      throw new PalugadaError(verdict.reason, verdict.message, {
        name,
        divisionId: ctx.divisionId,
        ...(verdict.policy ? { policies: verdict.policy.matched.map((m) => m.slug) } : {}),
      });
    }

    const { tier, policy } = verdict;

    // F9.2: outside its window the action is deferred, not refused. The engine
    // turns this into `waiting_window` with a wake-up time.
    if (verdict.window.closed) {
      await withTenant(ctx.companyId, async (tx) => {
        await appendEvent(tx, {
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          type: 'capability.window_closed',
          actor: 'broker',
          payload: { capability: name, reopensAt: verdict.window.closed ? verdict.window.reopensAt : null },
        });
      });
      throw new PalugadaError(
        'window.closed',
        `capability ${name} is outside its permitted window`,
        { name, reopensAt: verdict.window.reopensAt?.toISOString() ?? null },
      );
    }

    // F7.1: a policy that demands review gates this exact action until a
    // different role has judged it against explicit criteria.
    if (policy.effect === 'require_review') {
      const fingerprint = fingerprintAction(name, input);
      const alreadyApproved = await withTenant(ctx.companyId, (tx) =>
        isApproved(tx, ctx.taskId, fingerprint),
      );

      if (!alreadyApproved) {
        const reviewPolicy = policy.matched.find((m) => m.effect === 'require_review')!;
        const reviewerRoleSlug = String(reviewPolicy.params.reviewer_role ?? '');
        const criteria = String(
          reviewPolicy.params.criteria ??
            `Policy ${reviewPolicy.slug} requires this action to be justified before it runs.`,
        );

        const review = await openReview({
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          divisionId: ctx.divisionId,
          proposerTaskId: ctx.taskId,
          proposerRoleId: ctx.roleId,
          reviewerRoleSlug,
          capabilityName: name,
          actionFingerprint: fingerprint,
          proposal: { capability: name, tier, input: redactor.redactDeep(input) as unknown },
          criteria,
        });

        if (review.outcome === 'rejected') {
          // A rejection is an answer, not a delay. Retrying it would be asking
          // the same reviewer the same question.
          await withTenant(ctx.companyId, (tx) =>
            recordDenial(tx, ctx, name, 'policy.denied', policy),
          );
          throw new PalugadaError(
            'policy.denied',
            `review rejected ${name}`,
            { name, reviewRequestId: review.reviewRequestId },
          );
        }

        if (review.outcome !== 'already_approved') {
          throw new PalugadaError('review.required', `policy requires review before ${name}`, {
            name,
            policies: policy.matched.map((m) => m.slug),
            reviewRequestId: 'reviewRequestId' in review ? review.reviewRequestId : null,
            escalated: review.outcome === 'escalated',
          });
        }
      }
    }

    if (requiresOwnerApproval(tier) || policy.effect === 'require_approval') {
      await inbox.requestApproval({
        companyId: ctx.companyId,
        taskId: ctx.taskId,
        capabilityName: name,
        tier,
        actionSummary: `Run ${name}`,
        rationale:
          `Task ${ctx.taskId} requested ${name} at tier ${tier}` +
          (policy.effect === 'require_approval'
            ? `, and policy ${policy.matched.map((m) => m.slug).join(', ')} requires your approval.`
            : ', which cannot be reversed.'),
        consequenceIfDenied: 'The task halts and no external change is made.',
        estimatedCostCents: capability.estimatedCostCents ?? 0,
        payload: { input: redactor.redactDeep(input) as unknown },
      });
      throw new PalugadaError(
        'approval.required',
        `capability ${name} requires owner approval`,
        { name, tier },
      );
    }

    const controller = new AbortController();
    const signal = ctx.signal ?? controller.signal;
    const costContext = {
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
    };

    await withTenant(ctx.companyId, async (tx) => {
      await appendEvent(tx, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        type: 'tool.called',
        actor: 'agent_run',
        payload: {
          capability: name,
          tier,
          idempotencyKey: ctx.idempotencyKey,
          policies: policy.matched.map((m) => m.slug),
          observedPolicies: policy.observed.map((m) => m.slug),
        },
      });
    });

    const capabilityContext = {
      companyId: ctx.companyId,
      divisionId: ctx.divisionId,
      taskId: ctx.taskId,
      idempotencyKey: ctx.idempotencyKey,
      signal,
    };

    // Section 8.8 treats tier 2 as "check the budget, then policy". The check
    // has to happen while the money is still unspent, so the estimate is
    // charged here and refunded below if the call does not happen.
    const estimatedCents = estimateFor(capability, input);
    const charged = await chargeEstimate(costContext, name, estimatedCents);

    let output: O;
    try {
      output = (await capability.execute(input as never, capabilityContext)) as O;
    } catch (error) {
      // An action that did not happen must not leave a charge behind.
      if (charged) await refundEstimate(costContext, charged.accountId, estimatedCents);
      throw error;
    }

    // Settled before the read-back, because the provider billed for the call
    // regardless of whether the state it left behind is the one we asked for.
    const actualCents =
      (await capability.actualCostCents?.(input as never, output as never, capabilityContext)) ??
      null;
    const drift = await settleActual(
      costContext,
      charged?.accountId ?? null,
      name,
      estimatedCents,
      actualCents,
    );

    let verified = false;
    if (requiresVerification(tier)) {
      // F8.4: trust the state, not the status code.
      verified = await capability.verify!(input as never, output as never, capabilityContext);

      await withTenant(ctx.companyId, async (tx) => {
        await appendEvent(tx, {
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          type: verified ? 'tool.verified' : 'tool.verify_failed',
          actor: 'agent_run',
          payload: { capability: name, tier },
        });
      });

      if (!verified) {
        throw new PalugadaError(
          'capability.verify_failed',
          `read-back for ${name} did not match the requested state`,
          { name, tier },
        );
      }
    }

    return {
      output,
      tier,
      verified,
      policy,
      cost: {
        estimatedCents,
        actualCents: drift?.actualCents ?? null,
        drifted: drift?.drifted ?? false,
      },
    };
  }
}

/**
 * Assembles the facts a policy condition may reference (F3.4).
 *
 * A capability describes its own destination and cost through `describe()`
 * rather than the broker guessing at field names in an arbitrary input object.
 * Guessing would fail silently the day a capability renamed a field, and a
 * policy that stops matching is a policy that stops protecting.
 */
async function buildFacts(
  tx: TenantClient,
  ctx: InvokeContext,
  name: string,
  tier: Tier,
  described: { moneyCents?: number; recipientDomain?: string | null; urlHost?: string | null } | undefined,
  now: Date,
): Promise<ActionFacts> {
  const { rows } = await tx.query<{ timezone: string; division_slug: string }>(
    `SELECT c.timezone, d.slug AS division_slug
       FROM companies c, divisions d
      WHERE c.id = $1 AND d.id = $2`,
    [ctx.companyId, ctx.divisionId],
  );
  const row = rows[0];
  const timezone = row?.timezone ?? 'UTC';

  return {
    tool: name,
    tier,
    division: row?.division_slug ?? '',
    money_cents: described?.moneyCents ?? 0,
    recipient_domain: described?.recipientDomain?.toLowerCase() ?? null,
    url_host: described?.urlHost?.toLowerCase() ?? null,
    hour_local: localTimeIn(timezone, now).hour,
    calls_in_window: await countRecentInvocations(tx, ctx.divisionId, name),
  };
}

async function readKillSwitch(tx: TenantClient, name: string): Promise<boolean> {
  const { rows } = await tx.query<{ disabled: boolean }>(
    'SELECT disabled_at IS NOT NULL AS disabled FROM capabilities WHERE name = $1',
    [name],
  );
  return rows[0]?.disabled ?? false;
}

async function readGrant(
  tx: TenantClient,
  divisionId: string,
  name: string,
): Promise<{ tierOverride: Tier | null; rateLimitPerHour: number | null } | null> {
  const { rows } = await tx.query<{
    tier_override: number | null;
    rate_limit_per_hour: number | null;
  }>(
    `SELECT tier_override, rate_limit_per_hour FROM capability_grants
      WHERE division_id = $1 AND capability_name = $2`,
    [divisionId, name],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tierOverride: row.tier_override === null ? null : (row.tier_override as Tier),
    rateLimitPerHour: row.rate_limit_per_hour,
  };
}

async function countRecentInvocations(
  tx: TenantClient,
  divisionId: string,
  name: string,
): Promise<number> {
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events e
       JOIN tasks t ON t.id = e.task_id
      WHERE e.type = 'tool.called'
        AND t.division_id = $1
        AND e.payload->>'capability' = $2
        AND e.occurred_at > now() - interval '1 hour'`,
    [divisionId, name],
  );
  return Number(rows[0]!.count);
}

async function recordDenial(
  tx: TenantClient,
  ctx: InvokeContext,
  name: string,
  reason: string,
  policy?: PolicyDecision,
): Promise<void> {
  await appendEvent(tx, {
    companyId: ctx.companyId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    type: 'policy.denied',
    actor: 'broker',
    payload: {
      capability: name,
      reason,
      ...(policy ? { policies: policy.matched.map((m) => m.slug) } : {}),
    },
  });
}
