/**
 * Structural change (PRD v2 F2.1, F2.9).
 *
 * F2.9 is one line and it is the line that makes the rest of the organisation
 * model mean anything: adding or removing a division, adding a role, or
 * changing a capability grant is a **tier 3 action**. Tier 3 means the owner
 * decides, with no exception and no trusted-agent mode (principle 10).
 *
 * The reason is that these are the changes that change what everything *else*
 * is allowed to do. A policy denies an action; a grant decides whether the
 * action was ever reachable. An agent that could widen a grant could route
 * around every policy by making the policy irrelevant, so the shape of the
 * company has to be outside what the company's agents can change.
 *
 * This module refuses rather than performs. `propose*` puts a request in the
 * owner's inbox with what would change and what it would let happen; the
 * caller that applies it must be given the owner's decision. A module that
 * both asked and applied would be one refactor away from applying without
 * asking.
 *
 * F2.1 lives here too, because a division's escalation policy is part of the
 * same shape: which role hears about a problem, and how long the division may
 * sit on one before the owner does.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { TIER } from '../domain/tier.ts';
import * as inbox from '../inbox/inbox.ts';
import { recordVersion } from './config-versions.ts';

export type StructuralChange =
  | { kind: 'add_division'; slug: string; name: string; parentDivisionId?: string | null }
  | { kind: 'remove_division'; divisionId: string }
  | { kind: 'add_role'; divisionId: string; slug: string }
  | { kind: 'change_grant'; divisionId: string; capabilityName: string; tierOverride: number | null }
  | { kind: 'revoke_grant'; divisionId: string; capabilityName: string };

/** What the owner is told this change would let happen. */
function consequenceOf(change: StructuralChange): string {
  switch (change.kind) {
    case 'add_division':
      return `A new division "${change.slug}" would exist, with its own grants, budget and ` +
        'escalation policy.';
    case 'remove_division':
      return 'The division, its roles and its grants would stop existing. Work in flight ' +
        'against it would have nowhere to run.';
    case 'add_role':
      return `A new role "${change.slug}" would be able to receive work and act through ` +
        "its division's grants.";
    case 'change_grant':
      return change.tierOverride === null
        ? `${change.capabilityName} would be judged at its catalogued tier for this division.`
        : `${change.capabilityName} would be judged at tier ${change.tierOverride} for this ` +
          'division, which is what decides whether it needs review, verification or you.';
    case 'revoke_grant':
      return `The division could no longer call ${change.capabilityName} at all. Tasks that ` +
        'need it would halt.';
  }
}

function summaryOf(change: StructuralChange): string {
  switch (change.kind) {
    case 'add_division': return `Add division ${change.slug}`;
    case 'remove_division': return `Remove division ${change.divisionId}`;
    case 'add_role': return `Add role ${change.slug}`;
    case 'change_grant': return `Change the grant for ${change.capabilityName}`;
    case 'revoke_grant': return `Revoke ${change.capabilityName}`;
  }
}

/**
 * Asks the owner for a structural change (F2.9).
 *
 * Always tier 3, and that is not a parameter. A caller that could choose the
 * tier of its own structural change would be choosing whether the rule applies
 * to it.
 */
export async function proposeStructuralChange(input: {
  companyId: string;
  change: StructuralChange;
  rationale: string;
  taskId?: string | undefined;
}): Promise<string> {
  return inbox.requestApproval({
    companyId: input.companyId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    capabilityName: `structure.${input.change.kind}`,
    tier: TIER.IRREVERSIBLE,
    actionSummary: summaryOf(input.change),
    rationale: `${input.rationale}\n\nWhat this would change: ${consequenceOf(input.change)}`,
    consequenceIfDenied: 'The company keeps the shape it has now.',
    estimatedCostCents: 0,
    payload: { change: input.change },
  });
}

/**
 * Refuses a structural change that the owner has not approved (F2.9).
 *
 * Called by whatever applies one. The boolean is deliberately not derivable
 * from anything in this module: the only thing that can establish it is a
 * decided inbox item, and reading that is the caller's job so that the caller
 * cannot forget it existed.
 */
export function assertOwnerApproved(approved: boolean, change: StructuralChange): void {
  if (!approved) {
    throw new PalugadaError(
      'approval.required',
      `${summaryOf(change)} is a structural change, which is tier 3 and the owner's (F2.9)`,
      { change: change.kind },
    );
  }
}

/**
 * Applies an approved change to a grant, and records the version (F2.9, F3.9).
 *
 * The version is written in the same transaction as the change, so a history
 * containing a change that was rolled back is impossible.
 */
export async function applyGrantChange(
  companyId: string,
  change: Extract<StructuralChange, { kind: 'change_grant' | 'revoke_grant' }>,
  options: { ownerApproved: boolean },
): Promise<void> {
  assertOwnerApproved(options.ownerApproved, change);

  await withTenant(companyId, async (tx) => {
    const before = await readGrant(tx, change.divisionId, change.capabilityName);

    if (change.kind === 'revoke_grant') {
      await tx.query(
        'DELETE FROM capability_grants WHERE division_id = $1 AND capability_name = $2',
        [change.divisionId, change.capabilityName],
      );
    } else {
      await tx.query(
        `INSERT INTO capability_grants
           (company_id, division_id, capability_name, tier_override)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (division_id, capability_name) DO UPDATE
           SET tier_override = EXCLUDED.tier_override`,
        [companyId, change.divisionId, change.capabilityName, change.tierOverride],
      );
    }

    await recordVersion(tx, {
      companyId,
      kind: 'grant',
      subjectId: change.divisionId,
      snapshot: {
        capability: change.capabilityName,
        before,
        after: change.kind === 'revoke_grant' ? null : { tierOverride: change.tierOverride },
      },
      summary: summaryOf(change),
    });

    await appendEvent(tx, {
      companyId,
      type: 'structure.changed',
      actor: 'owner',
      payload: { change: change.kind, division: change.divisionId, capability: change.capabilityName },
    });
  });
}

/**
 * Applies an approved change to a role, and records the version (F3.9, F17.3).
 *
 * The three fields are the three that change what a role will do — its system
 * prompt, its tools, its model routing — which is why F17.2 runs the eval set
 * on exactly these and why they are the only ones this function touches. A
 * general role updater would let a rename travel the same path as a rewrite.
 *
 * The snapshot is taken *before* the change, not after: a rollback needs the
 * state to return to, and versioning the new state would mean the first
 * version anybody could roll back to is the one that broke something.
 */
export interface RoleFields {
  systemPrompt?: string;
  tools?: string[];
  modelPrimary?: string;
  modelFallback?: string[];
}

export async function applyRoleChange(
  companyId: string,
  roleId: string,
  fields: RoleFields,
  options: { ownerApproved: boolean; summary?: string },
): Promise<number> {
  if (!options.ownerApproved) {
    throw new PalugadaError(
      'approval.required',
      "changing a role's prompt, tools or model routing is the owner's (F2.9, F17.3)",
      { roleId },
    );
  }

  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      slug: string;
      system_prompt: string;
      tools: string[];
      model_primary: string | null;
      model: string;
      model_fallback: string[];
    }>(
      `SELECT slug, system_prompt, tools, model_primary, model, model_fallback
         FROM roles WHERE id = $1`,
      [roleId],
    );
    const before = rows[0];
    if (!before) throw new PalugadaError('role.incomplete', `no role ${roleId}`, { roleId });

    const version = await recordVersion(tx, {
      companyId,
      kind: 'role',
      subjectId: roleId,
      snapshot: {
        slug: before.slug,
        systemPrompt: before.system_prompt,
        tools: before.tools,
        modelPrimary: before.model_primary ?? before.model,
        modelFallback: before.model_fallback,
      },
      summary: options.summary ?? `State of ${before.slug} before this change`,
    });

    await tx.query(
      `UPDATE roles
          SET system_prompt  = coalesce($2, system_prompt),
              tools          = coalesce($3::text[], tools),
              model_primary  = coalesce($4, model_primary),
              model_fallback = coalesce($5::text[], model_fallback)
        WHERE id = $1`,
      [
        roleId,
        fields.systemPrompt ?? null,
        fields.tools ?? null,
        fields.modelPrimary ?? null,
        fields.modelFallback ?? null,
      ],
    );

    await appendEvent(tx, {
      companyId,
      type: 'role.changed',
      actor: 'owner',
      payload: { roleId, slug: before.slug, changed: Object.keys(fields), version },
    });

    return version;
  });
}

async function readGrant(
  tx: TenantClient,
  divisionId: string,
  capabilityName: string,
): Promise<{ tierOverride: number | null } | null> {
  const { rows } = await tx.query<{ tier_override: number | null }>(
    'SELECT tier_override FROM capability_grants WHERE division_id = $1 AND capability_name = $2',
    [divisionId, capabilityName],
  );
  return rows[0] ? { tierOverride: rows[0].tier_override } : null;
}

/* ------------------------------------------------------------------ F2.1 --- */

export interface EscalationPolicy {
  /** The role that hears about it first. Null means it goes straight up. */
  roleSlug: string | null;
  /** How long the division may hold it before the owner is told. */
  afterMinutes: number;
}

/**
 * A company-wide default, for a division that has never set one.
 *
 * Four hours matches F9.7's heartbeat: a division that has not looked at a
 * problem by the time its roles have woken again is a division that is not
 * going to.
 */
export const DEFAULT_ESCALATION_MINUTES = 240;

export async function escalationPolicyFor(
  tx: TenantClient,
  divisionId: string,
): Promise<EscalationPolicy> {
  const { rows } = await tx.query<{
    escalation_role_slug: string | null;
    escalate_after_minutes: number | null;
  }>(
    'SELECT escalation_role_slug, escalate_after_minutes FROM divisions WHERE id = $1',
    [divisionId],
  );
  const row = rows[0];
  return {
    roleSlug: row?.escalation_role_slug ?? null,
    afterMinutes: row?.escalate_after_minutes ?? DEFAULT_ESCALATION_MINUTES,
  };
}

/**
 * Sets a division's escalation policy (F2.1).
 *
 * Not a structural change: naming who inside the division hears about a problem
 * changes nothing about what the division may do. Widening a grant does; this
 * does not, and treating every configuration edit as tier 3 would make tier 3
 * mean "a form was submitted".
 */
export async function setEscalationPolicy(
  companyId: string,
  divisionId: string,
  policy: Partial<EscalationPolicy>,
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    await tx.query(
      `UPDATE divisions
          SET escalation_role_slug = coalesce($2, escalation_role_slug),
              escalate_after_minutes = coalesce($3, escalate_after_minutes)
        WHERE id = $1`,
      [divisionId, policy.roleSlug ?? null, policy.afterMinutes ?? null],
    );
    await appendEvent(tx, {
      companyId,
      type: 'division.escalation_set',
      actor: 'owner',
      payload: { divisionId, ...policy },
    });
  });
}
