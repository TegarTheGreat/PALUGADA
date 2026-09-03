/**
 * Capability broker (PRD F8.1, F8.3, F8.6, F8.8, F3.3, F9.2, section 6.2 step 4).
 *
 * Every external action passes through here; an agent holds no connection of
 * its own. The order of the gates is deliberate and each one is placed where
 * it is for a reason:
 *
 *   1. The `pre_tool` hooks (F14): platform stop, company freeze and the spend
 *      ceiling, because a halted platform should not even consult its
 *      configuration. They live in the hook pipeline rather than inline so
 *      that a company cannot remove them and an added hook can only tighten
 *      them.
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
 *
 * Steps 2 through 5 stay inline rather than becoming hooks of their own. They
 * are one ordered read inside a single transaction where each gate consumes
 * what the one before it computed -- the grant decides the tier, the tier
 * decides the facts, the facts decide the policy -- and splitting them into
 * independent hooks would buy names at the price of that atomic read. They are
 * no less built-in for it: F14.1 asks for deterministic engine code on this
 * side of the adapter boundary, which is what they are.
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
import { evaluate, type PolicyDecision } from '../policy/engine.ts';
import type { ActionFacts } from '../policy/condition.ts';
import { capabilityWindow, isWithin, localTimeIn, nextOpening } from '../scheduler/windows.ts';
import * as inbox from '../inbox/inbox.ts';
import { redactor } from '../secrets/manager.ts';
import { fingerprintAction, isApproved, openReview } from '../review/review.ts';
import { chargeEstimate, estimateFor, refundEstimate, settleActual } from './cost.ts';
import { evaluateRoleFreeze, isRoleFrozen } from '../governance/role-freeze.ts';
import { ancestryForTask, renderAncestry } from '../domain/goals.ts';
import { checkAgainstPlan, readPlan, type TaskPlan } from '../engine/plan.ts';
import type { CapabilityRegistry } from './registry.ts';
import { HookPipeline } from '../engine/hooks.ts';

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
  | 'capability.disabled'
  | 'capability.not_granted'
  | 'capability.rate_limited'
  | 'policy.denied'
  | 'role.frozen'
  | 'plan.required'
  | 'plan.batch_mismatch'
>;

type Verdict =
  | {
      allowed: true;
      tier: Tier;
      policy: PolicyDecision;
      facts: ActionFacts;
      plan: TaskPlan | null;
      window: { closed: true; reopensAt: Date | null } | { closed: false };
    }
  | { allowed: false; reason: DenialCode; message: string; policy?: PolicyDecision };

export class CapabilityBroker {
  readonly #registry: CapabilityRegistry;
  readonly #hooks: HookPipeline;

  constructor(registry: CapabilityRegistry, hooks?: HookPipeline) {
    this.#registry = registry;
    // A broker built without one still has every built-in hook: F14.2 is not
    // an option a caller can decline by leaving an argument out.
    this.#hooks = hooks ?? new HookPipeline();
  }

  /** The hook pipeline this broker consults (F14). */
  get hooks(): HookPipeline {
    return this.#hooks;
  }

  /**
   * The registry this broker runs against.
   *
   * Exposed because F8.12's preflight happens before a task starts, which is
   * the engine's moment rather than the broker's, and the engine should not
   * have to be handed the registry separately and risk being handed a
   * different one.
   */
  get registry(): CapabilityRegistry {
    return this.#registry;
  }

  async invoke<I, O>(ctx: InvokeContext, name: string, input: I): Promise<InvokeResult<O>> {
    const capability = this.#registry.get(name);
    if (!capability) {
      throw new PalugadaError('capability.unknown', `capability ${name} is not registered`, { name });
    }

    // F14: the pre_tool point. The built-in hooks here are the conditions
    // under which nothing at all should run -- platform stop, company freeze,
    // spent budget -- and they run before the authorization transaction opens,
    // because a halted platform should not even consult its configuration.
    // Added hooks run after them and can only refuse.
    const preTool = await this.#hooks.run('pre_tool', {
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      roleId: ctx.roleId,
      divisionId: ctx.divisionId,
      capability: name,
      tier: capability.defaultTier,
      input,
    });
    if (!preTool.allowed) {
      throw new PalugadaError(preTool.code ?? 'hook.denied', preTool.reason!, {
        name,
        hook: preTool.refusedBy,
      });
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

      // F3.7: a role frozen for repeated denials stops here, beside the kill
      // switch and before the grant, because a frozen role's problem is not
      // which capability it asked for.
      if (await isRoleFrozen(tx, ctx.roleId)) {
        return {
          allowed: false,
          reason: 'role.frozen',
          message: `role ${ctx.roleId} is frozen after repeated denials and cannot act`,
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
      const described = capability.describe?.(input as never);
      const facts = await buildFacts(tx, ctx, name, tier, described, now);
      const policy = await evaluate(tx, ctx.companyId, ctx.divisionId, facts);

      if (policy.effect === 'deny') {
        return {
          allowed: false,
          reason: 'policy.denied',
          message: `policy ${policy.matched.map((m) => m.slug).join(', ')} denies ${name}`,
          policy,
        };
      }

      // F8.11, F8.13. After policy, because a call policy already denies needs
      // no plan; before the window and the approval, because an approval item
      // has to be able to show the plan the owner is being asked to endorse.
      const plan = await readPlan(tx, ctx.taskId);
      if (tier >= 2) {
        const verdict = checkAgainstPlan(plan, name, described?.batchSize);
        if (!verdict.ok) {
          return { allowed: false, reason: verdict.code, message: verdict.message, policy };
        }
      }

      const window = await capabilityWindow(tx, ctx.divisionId, name);
      const windowState =
        window && !isWithin(window, now)
          ? ({ closed: true, reopensAt: nextOpening(window, now) } as const)
          : ({ closed: false } as const);

      return { allowed: true, tier, policy, facts, plan, window: windowState };
    });

    if (!verdict.allowed) {
      await withTenant(ctx.companyId, (tx) =>
        recordDenial(tx, ctx, name, verdict.reason, verdict.policy),
      );
      // F8.13's acceptance criterion: a batch that does not match the plan is
      // an incident, not a statistic. It is the case the guard exists for, and
      // one the owner should see even though the action never happened.
      if (verdict.reason === 'plan.batch_mismatch') {
        await inbox.raiseIncident({
          companyId: ctx.companyId,
          taskId: ctx.taskId,
          title: `Batch guard stopped ${name}`,
          detail: `${verdict.message} Nothing was sent, and no adapter was called.`,
        });
      }
      // After the record, so the count includes this denial: a threshold of
      // ten freezes on the tenth attempt rather than the eleventh.
      await countTowardsRoleFreeze(ctx);
      throw new PalugadaError(verdict.reason, verdict.message, {
        name,
        divisionId: ctx.divisionId,
        ...(verdict.policy ? { policies: verdict.policy.matched.map((m) => m.slug) } : {}),
      });
    }

    const { tier, policy, plan } = verdict;

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
          proposal: {
            capability: name,
            tier,
            input: redactor.redactDeep(input) as unknown,
            // F8.11: the reviewer judges the action against what the task said
            // it would do, not only against the arguments in front of them.
            plan,
          },
          criteria,
        });

        if (review.outcome === 'rejected') {
          // A rejection is an answer, not a delay. Retrying it would be asking
          // the same reviewer the same question.
          await withTenant(ctx.companyId, (tx) =>
            recordDenial(tx, ctx, name, 'policy.denied', policy),
          );
          await countTowardsRoleFreeze(ctx);
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
      // F10.2 asks the item to say why. The plan says what will happen; the
      // goal chain says what it is ultimately for. An owner reading this on a
      // phone gets both without following a link.
      const chain = await withTenant(ctx.companyId, (tx) => ancestryForTask(tx, ctx.taskId));
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
            : ', which cannot be reversed.') +
          (chain.length > 0 ? `\n\nWhat this is for — ${renderAncestry(chain)}` : ''),
        consequenceIfDenied: 'The task halts and no external change is made.',
        estimatedCostCents: capability.estimatedCostCents ?? 0,
        // F10.2 asks an approval item to say why. The plan is most of the
        // answer, so it travels with the item rather than being a click away.
        payload: {
          input: redactor.redactDeep(input) as unknown,
          plan,
          goalAncestry: chain.map((goal) => ({ kind: goal.kind, statement: goal.statement })),
        },
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

    // F14: the post_tool point. The built-in hook here refuses an output that
    // carries a credential verbatim -- section 12.4's rule that a secret never
    // reaches a durable record cannot be enforced only on the way in, because
    // the way a token most often escapes is inside somebody else's response
    // body.
    const postTool = await this.#hooks.run('post_tool', {
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      roleId: ctx.roleId,
      divisionId: ctx.divisionId,
      capability: name,
      tier,
      input,
      output,
    });
    if (!postTool.allowed) {
      // The action already happened; what the refusal stops is the output
      // travelling any further. Loud rather than silently redacted, because a
      // capability that returns a secret is a defect in that capability.
      throw new PalugadaError(postTool.code ?? 'hook.denied', postTool.reason!, {
        name,
        hook: postTool.refusedBy,
      });
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

/**
 * Counts a denial towards F3.7 without letting the bookkeeping change what the
 * caller is told.
 *
 * The denial is the answer to the caller's question and the engine branches on
 * its code: F2.4 requires `capability.not_granted` for an ungranted tool, and
 * a failure while counting must not turn that into an unrecognised error and a
 * failed task. The failure is recorded rather than swallowed, because a freeze
 * that has quietly stopped working is a control that only appears to exist.
 */
async function countTowardsRoleFreeze(ctx: InvokeContext): Promise<void> {
  try {
    await evaluateRoleFreeze(ctx);
  } catch (error) {
    try {
      await withTenant(ctx.companyId, async (tx) => {
        await appendEvent(tx, {
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          type: 'role.freeze_check_failed',
          actor: 'broker',
          payload: { roleId: ctx.roleId, error: String((error as Error).message ?? error) },
        });
      });
    } catch {
      // The denial itself is already on the record, which is the entry that
      // matters. Failing to note that the counter failed must not, in turn,
      // take the denial's error code with it.
    }
  }
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
      // F3.7 counts denials per role, so the role has to be on the record.
      // Without it the count could only be reconstructed by joining back
      // through the task, which stops working the moment a task is purged by
      // retention while its denials are still inside the window.
      roleId: ctx.roleId,
      ...(policy ? { policies: policy.matched.map((m) => m.slug) } : {}),
    },
  });
}
