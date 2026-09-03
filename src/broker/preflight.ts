/**
 * Capability preflight (PRD v2 F8.12).
 *
 * v2 section 2.3 records a secret that was misconfigured and failed silently
 * for half a day. Every call failed, every failure looked transient, and the
 * retries hid it. Preflight is the check that would have said so in the first
 * minute, and F8.12 asks for it at three moments: at boot, after a secret
 * rotation, and before a task that needs the capability.
 *
 * Four decisions.
 *
 * **A failure is an incident, not a retry.** That is F8.12's own wording and
 * it is the whole point: a broken credential does not get better by being
 * asked again, and a system that retries it turns a five-minute fix into an
 * afternoon of silence.
 *
 * **The task does not start.** Starting it would spend tokens assembling
 * context for work that cannot succeed, and would leave a half-finished task
 * for somebody to interpret later.
 *
 * **Health is per division**, because the thing being checked is usually a
 * credential and credentials are division-scoped (F12.2). The same capability
 * is healthy for the division whose token is valid and unhealthy for the one
 * whose token expired.
 *
 * **A fresh result is reused.** Probing an external service before every task
 * would make preflight itself the load. Anything inside the window stands;
 * anything older is checked again.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import * as inbox from '../inbox/inbox.ts';
import type { CapabilityRegistry } from './registry.ts';

/** How long a passing check stands before it is taken again. */
export const PREFLIGHT_TTL_MS = 15 * 60_000;

export interface PreflightContext {
  companyId: string;
  divisionId: string;
}

export interface PreflightResult {
  ok: boolean;
  /** Optional, because a capability that simply works has nothing to add. */
  detail?: string | undefined;
}

export interface HealthRow {
  capabilityName: string;
  status: 'healthy' | 'unhealthy';
  detail: string;
  checkedAt: Date;
}

async function readHealth(
  tx: TenantClient,
  divisionId: string,
  capabilityName: string,
): Promise<HealthRow | null> {
  const { rows } = await tx.query<{
    capability_name: string;
    status: 'healthy' | 'unhealthy';
    detail: string;
    checked_at: Date;
  }>(
    `SELECT capability_name, status, detail, checked_at FROM capability_health
      WHERE division_id = $1 AND capability_name = $2`,
    [divisionId, capabilityName],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    capabilityName: row.capability_name,
    status: row.status,
    detail: row.detail,
    checkedAt: row.checked_at,
  };
}

export async function healthFor(
  companyId: string,
  divisionId: string,
): Promise<HealthRow[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      capability_name: string;
      status: 'healthy' | 'unhealthy';
      detail: string;
      checked_at: Date;
    }>(
      `SELECT capability_name, status, detail, checked_at FROM capability_health
        WHERE division_id = $1 ORDER BY capability_name`,
      [divisionId],
    );
    return rows.map((row) => ({
      capabilityName: row.capability_name,
      status: row.status,
      detail: row.detail,
      checkedAt: row.checked_at,
    }));
  });
}

/**
 * Runs one capability's preflight and records the result.
 *
 * A capability with no `preflight()` is healthy by definition rather than
 * unknown: it declared that it has nothing to check, which is true of every
 * pure computation and of anything that needs no credential. Treating silence
 * as a failure would make the gate refuse most of the catalogue.
 */
export async function checkCapability(
  registry: CapabilityRegistry,
  ctx: PreflightContext,
  capabilityName: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<{ ok: boolean; detail: string; reused: boolean; unregistered: boolean }> {
  const now = options.now ?? new Date();
  const capability = registry.get(capabilityName);

  if (!capability) {
    // Not a health answer. Preflight asks whether a capability works; a name
    // no adapter is bound to has nothing to work or fail, and the broker
    // already refuses it at the moment of use with a message that names the
    // real problem. Calling it unhealthy here would halt every task whose role
    // mentions a tool this process happens not to carry, which is a
    // deployment question rather than a credential one.
    return {
      ok: true,
      detail: `capability ${capabilityName} is not registered in this process`,
      reused: false,
      unregistered: true,
    };
  }

  const previous = await withTenant(ctx.companyId, (tx) =>
    readHealth(tx, ctx.divisionId, capabilityName),
  );

  if (!options.force && previous) {
    const age = now.getTime() - previous.checkedAt.getTime();
    if (age < PREFLIGHT_TTL_MS) {
      return {
        ok: previous.status === 'healthy',
        detail: previous.detail,
        reused: true,
        unregistered: false,
      };
    }
  }

  let result: PreflightResult;
  if (typeof capability.preflight !== 'function') {
    result = { ok: true, detail: 'no preflight declared' };
  } else {
    try {
      result = await capability.preflight(ctx);
    } catch (error) {
      // A preflight that throws has failed. Reading a thrown error as "we do
      // not know" would let a broken capability through on the strength of
      // being broken in an unexpected way.
      result = { ok: false, detail: `preflight threw: ${(error as Error).message}` };
    }
  }

  await withTenant(ctx.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO capability_health
         (company_id, division_id, capability_name, status, detail, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (division_id, capability_name) DO UPDATE
         SET status = EXCLUDED.status,
             detail = EXCLUDED.detail,
             checked_at = EXCLUDED.checked_at`,
      [
        ctx.companyId,
        ctx.divisionId,
        capabilityName,
        result.ok ? 'healthy' : 'unhealthy',
        result.detail ?? '',
        now,
      ],
    );

    await appendEvent(tx, {
      companyId: ctx.companyId,
      type: result.ok ? 'capability.healthy' : 'capability.unhealthy',
      actor: 'broker',
      payload: {
        capability: capabilityName,
        divisionId: ctx.divisionId,
        detail: result.detail ?? '',
      },
    });
  });

  // Raised on the transition into unhealthy, not on every check. A capability
  // that stays broken for a day would otherwise file ninety-six identical
  // incidents and bury the one that says something new.
  if (!result.ok && previous?.status !== 'unhealthy') {
    await inbox.raiseIncident({
      companyId: ctx.companyId,
      title: `Capability ${capabilityName} failed preflight`,
      detail:
        `${result.detail || 'no detail given'}. No task that needs it will start until it ` +
        'passes. The usual causes are an expired or misscoped credential, an exhausted ' +
        'quota, or the provider being unreachable.',
    });
  }

  return { ok: result.ok, detail: result.detail ?? '', reused: false, unregistered: false };
}

export interface RoleReadiness {
  ready: boolean;
  /** Capabilities the role declares that are registered and not usable. */
  failures: Array<{ capability: string; detail: string }>;
  /**
   * Capabilities the role declares that no adapter is bound to.
   *
   * Reported rather than treated as a failure. See `checkCapability`: this is
   * a deployment gap, and the broker refuses such a call by name at the moment
   * it is made.
   */
  unregistered: string[];
}

/**
 * Checks everything a role declares, before its task starts.
 *
 * The role's own tools rather than its division's grants: a role may only use
 * its own tools (F2.4), so checking the division's whole grant list would
 * block a task on a capability it was never going to call.
 */
export async function preflightForRole(
  registry: CapabilityRegistry,
  ctx: PreflightContext,
  roleId: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<RoleReadiness> {
  const tools = await withTenant(ctx.companyId, async (tx) => {
    const { rows } = await tx.query<{ tools: string[] }>(
      'SELECT tools FROM roles WHERE id = $1',
      [roleId],
    );
    return rows[0]?.tools ?? [];
  });

  const failures: Array<{ capability: string; detail: string }> = [];
  const unregistered: string[] = [];
  for (const tool of tools) {
    const outcome = await checkCapability(registry, ctx, tool, options);
    if (outcome.unregistered) {
      unregistered.push(tool);
      continue;
    }
    if (!outcome.ok) failures.push({ capability: tool, detail: outcome.detail });
  }

  return { ready: failures.length === 0, failures, unregistered };
}

/**
 * Sweeps every division that holds a grant, for boot and after a rotation.
 *
 * Driven from the grants rather than from a list of divisions, because a
 * capability nobody granted has nothing to be healthy or unhealthy about, and
 * probing it would mean calling an external service on behalf of a division
 * that never asked.
 */
export async function preflightGrants(
  registry: CapabilityRegistry,
  scope: { companyId?: string; divisionId?: string } = {},
): Promise<{ checked: number; failures: number }> {
  const grants = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      company_id: string;
      division_id: string;
      capability_name: string;
    }>(
      `SELECT company_id, division_id, capability_name FROM capability_grants
        WHERE ($1::uuid IS NULL OR company_id = $1)
          AND ($2::uuid IS NULL OR division_id = $2)
        ORDER BY company_id, division_id, capability_name`,
      [scope.companyId ?? null, scope.divisionId ?? null],
    );
    return rows;
  });

  let failures = 0;
  for (const grant of grants) {
    const outcome = await checkCapability(
      registry,
      { companyId: grant.company_id, divisionId: grant.division_id },
      grant.capability_name,
      // Forced: a sweep exists to find out what is true now. Reusing a result
      // from before a rotation would report the state the rotation replaced.
      { force: true },
    );
    if (!outcome.ok && !outcome.unregistered) failures += 1;
  }

  return { checked: grants.length, failures };
}
