/**
 * Capability broker (PRD F8.1, F8.3, F8.6, F8.8, section 6.2 step 4).
 *
 * Every external action passes through here; an agent holds no connection of
 * its own. The order of the checks is deliberate. Grant and kill-switch checks
 * run before anything reaches an adapter, because F2.4 requires a refusal to
 * produce no downstream call at all -- refusing after the request has left is
 * not a refusal. Approval for tier 3 comes before budget and execution,
 * because principle 10 admits no exception and no trusted-agent mode.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { effectiveTier, requiresOwnerApproval, requiresVerification, type Tier } from '../domain/tier.ts';
import { isCompanyFrozen, isStopAllRequested } from '../engine/control.ts';
import * as inbox from '../inbox/inbox.ts';
import type { CapabilityRegistry } from './registry.ts';

export interface InvokeContext {
  companyId: string;
  projectId: string;
  divisionId: string;
  taskId: string;
  idempotencyKey: string;
  signal?: AbortSignal | undefined;
}

type Verdict =
  | { allowed: true; tier: Tier }
  | {
      allowed: false;
      reason: 'capability.disabled' | 'capability.not_granted' | 'capability.rate_limited';
      message: string;
    };

export interface InvokeResult<O> {
  output: O;
  tier: Tier;
  verified: boolean;
}

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

    // The authorization check returns a verdict rather than throwing from
    // inside the transaction. Throwing there would roll the transaction back
    // and take the denial record with it, leaving a refused action with no
    // trace -- which is the one thing an audit log must never do, and which
    // also silently breaks the repeat-offender freeze in F3.7.
    const verdict = await withTenant(ctx.companyId, async (tx): Promise<Verdict> => {
      if (await readKillSwitch(tx, name)) {
        return { allowed: false, reason: 'capability.disabled', message: `capability ${name} is disabled` };
      }

      const grant = await readGrant(tx, ctx.divisionId, name);
      if (!grant) {
        // F2.4: the refusal is decided here, before any adapter is touched.
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

      return { allowed: true, tier: effectiveTier(capability.defaultTier, grant.tierOverride) };
    });

    if (!verdict.allowed) {
      // Written in its own transaction, so the record survives the refusal.
      await withTenant(ctx.companyId, (tx) => recordDenial(tx, ctx, name, verdict.reason));
      throw new PalugadaError(verdict.reason, verdict.message, { name, divisionId: ctx.divisionId });
    }

    const { tier } = verdict;

    if (requiresOwnerApproval(tier)) {
      await inbox.requestApproval({
        companyId: ctx.companyId,
        taskId: ctx.taskId,
        capabilityName: name,
        tier,
        actionSummary: `Run ${name}`,
        rationale: `Task ${ctx.taskId} requested ${name}, which is tier ${tier} and cannot be reversed.`,
        consequenceIfDenied: 'The task halts and no external change is made.',
        estimatedCostCents: capability.estimatedCostCents ?? 0,
        payload: { input: input as unknown },
      });
      throw new PalugadaError(
        'approval.required',
        `capability ${name} is tier ${tier} and requires owner approval`,
        { name, tier },
      );
    }

    const controller = new AbortController();
    const signal = ctx.signal ?? controller.signal;

    await withTenant(ctx.companyId, async (tx) => {
      await appendEvent(tx, {
        companyId: ctx.companyId, projectId: ctx.projectId, taskId: ctx.taskId,
        type: 'tool.called', actor: 'agent_run',
        payload: { capability: name, tier, idempotencyKey: ctx.idempotencyKey },
      });
    });

    const output = (await capability.execute(input as never, {
      companyId: ctx.companyId,
      divisionId: ctx.divisionId,
      taskId: ctx.taskId,
      idempotencyKey: ctx.idempotencyKey,
      signal,
    })) as O;

    let verified = false;
    if (requiresVerification(tier)) {
      // F8.4: trust the state, not the status code.
      verified = await capability.verify!(input as never, output as never, {
        companyId: ctx.companyId,
        divisionId: ctx.divisionId,
        taskId: ctx.taskId,
        idempotencyKey: ctx.idempotencyKey,
        signal,
      });

      await withTenant(ctx.companyId, async (tx) => {
        await appendEvent(tx, {
          companyId: ctx.companyId, projectId: ctx.projectId, taskId: ctx.taskId,
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

    return { output, tier, verified };
  }
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
  const { rows } = await tx.query<{ tier_override: number | null; rate_limit_per_hour: number | null }>(
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
): Promise<void> {
  await appendEvent(tx, {
    companyId: ctx.companyId, projectId: ctx.projectId, taskId: ctx.taskId,
    type: 'policy.denied', actor: 'broker',
    payload: { capability: name, reason },
  });
}
