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
import { assertApproved, type RoleChange } from '../eval/role-eval.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { TIER } from '../domain/tier.ts';
import * as inbox from '../inbox/inbox.ts';
import { recordVersion } from './config-versions.ts';
import { PLATFORM_TOOLS, WORK_INPUT, WORK_OUTPUT } from '../templates/standard.ts';

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
  /**
   * Which runtime does the role's work (F13.1). Routing, like the model: the
   * same charter and tools, done by another agent.
   */
  runtime?: string;
}

/**
 * Which of F17.2's three a set of fields amounts to.
 *
 * The eval set scores a change by kind, and a caller supplies fields. A prompt
 * change is the charter; tools are the skills; a model is the routing. When a
 * call touches more than one, the charter is the widest and is what the owner
 * is told they are approving.
 */
function changeKindOf(fields: RoleFields): RoleChange {
  if (fields.systemPrompt !== undefined) return 'charter';
  if (fields.tools !== undefined) return 'skills';
  return 'model_routing';
}

export async function applyRoleChange(
  companyId: string,
  roleId: string,
  fields: RoleFields,
  options: { ownerApproved: boolean; summary?: string },
): Promise<number> {
  // F17.3's own guard, called rather than restated.
  //
  // This used to be an inline `throw` saying the same thing in different
  // words, so the rule had two implementations and `assertApproved` -- written
  // for exactly this -- had no caller. Two statements of one rule is how they
  // drift, and the one that matters is always the one nobody re-read.
  assertApproved(options.ownerApproved, changeKindOf(fields));

  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      slug: string;
      system_prompt: string;
      tools: string[];
      model_primary: string | null;
      model: string;
      model_fallback: string[];
      runtime: string;
    }>(
      `SELECT slug, system_prompt, tools, model_primary, model, model_fallback, runtime
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
        runtime: before.runtime,
      },
      summary: options.summary ?? `State of ${before.slug} before this change`,
    });

    await tx.query(
      `UPDATE roles
          SET system_prompt  = coalesce($2, system_prompt),
              tools          = coalesce($3::text[], tools),
              model_primary  = coalesce($4, model_primary),
              model_fallback = coalesce($5::text[], model_fallback),
              runtime        = coalesce($6, runtime)
        WHERE id = $1`,
      [
        roleId,
        fields.systemPrompt ?? null,
        fields.tools ?? null,
        fields.modelPrimary ?? null,
        fields.modelFallback ?? null,
        fields.runtime ?? null,
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

/* ------------------------------------------------------ F2.9, F2.6, F2.8 --- */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugOf(value: unknown, what: string): string {
  const slug = String(value ?? '');
  if (!SLUG.test(slug)) {
    throw new PalugadaError(
      'contract.violation',
      `a ${what} slug is lowercase letters, digits and hyphens, starting with a letter or digit`,
      { field: 'slug' },
    );
  }
  return slug;
}

export interface NewRole {
  divisionId: string;
  slug: string;
  systemPrompt: string;
  tools?: string[];
  doneCriteria: string[];
  /** The model tier the role's runtime resolves; `standard` unless said. */
  model?: string;
  maxTokensPerRun?: number;
}

/**
 * Hires a role the owner approved (F2.9: adding a role is tier 3).
 *
 * Complete enough to be given work the moment it exists (F2.8): the standard
 * input and output contracts, and the done criteria the owner wrote. It runs
 * where the company's other roles run -- a company whose roles are all Claude
 * Code hires one more Claude Code role -- because a hire on the development
 * runtime in a company that has none would halt on its first task. Its tools
 * must be capabilities the platform has, twelve at most (F2.6); tools its
 * division has no grant for are allowed, since the owner may be about to grant
 * them, and are returned so the console can say so.
 */
export async function addRole(
  companyId: string,
  role: NewRole,
  options: { ownerApproved: boolean },
): Promise<{ roleId: string; ungranted: string[] }> {
  assertOwnerApproved(options.ownerApproved, { kind: 'add_role', divisionId: role.divisionId, slug: role.slug });
  const slug = slugOf(role.slug, 'role');
  const systemPrompt = String(role.systemPrompt ?? '').trim();
  if (!systemPrompt) {
    throw new PalugadaError('contract.violation', 'say what the role is for: its system prompt is empty', { field: 'systemPrompt' });
  }
  const doneCriteria = (role.doneCriteria ?? []).map((line) => String(line).trim()).filter(Boolean);
  if (doneCriteria.length === 0) {
    throw new PalugadaError(
      'contract.violation',
      'a role needs at least one done criterion: how anyone will know its work is finished (F2.8)',
      { field: 'doneCriteria' },
    );
  }
  const tools = (role.tools ?? []).map(String);
  if (tools.length > 12) {
    throw new PalugadaError('contract.violation', 'a role has at most 12 tools (F2.6)', { field: 'tools' });
  }

  return withTenant(companyId, async (tx) => {
    const division = await tx.query('SELECT 1 FROM divisions WHERE id = $1', [role.divisionId]);
    if (division.rowCount !== 1) {
      throw new PalugadaError('contract.violation', 'no such division in this company', { field: 'divisionId' });
    }
    const taken = await tx.query('SELECT 1 FROM roles WHERE slug = $1', [slug]);
    if (taken.rowCount) {
      throw new PalugadaError('contract.violation', `there is already a role named ${slug}`, { field: 'slug' });
    }
    const { rows: known } = await tx.query<{ name: string }>(
      'SELECT name FROM capabilities WHERE name = ANY($1::text[])', [tools]);
    const unknown = tools.find((tool) => !known.some((row) => row.name === tool));
    if (unknown) {
      throw new PalugadaError('contract.violation', `there is no capability named ${unknown}`, { field: 'tools' });
    }
    const { rows: granted } = await tx.query<{ capability_name: string }>(
      'SELECT capability_name FROM capability_grants WHERE division_id = $1', [role.divisionId]);
    const ungranted = tools.filter((tool) => !granted.some((row) => row.capability_name === tool));

    // Where the company's roles run; the column's default when it has none.
    const { rows: usual } = await tx.query<{ runtime: string; backend: string }>(
      `SELECT runtime, backend FROM roles GROUP BY runtime, backend ORDER BY count(*) DESC, runtime LIMIT 1`);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, tools, input_schema, output_schema,
                          max_tokens_per_run, done_criteria, runtime, backend)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10::text[],
               coalesce($11, 'in-process'), coalesce($12, 'local'))
       RETURNING id`,
      [
        companyId, role.divisionId, slug, systemPrompt, role.model ?? 'standard', tools,
        JSON.stringify(WORK_INPUT), JSON.stringify(WORK_OUTPUT), role.maxTokensPerRun ?? 60_000, doneCriteria,
        usual[0]?.runtime ?? null, usual[0]?.backend ?? null,
      ],
    );
    const roleId = rows[0]!.id;
    await recordVersion(tx, {
      companyId,
      kind: 'role',
      subjectId: roleId,
      snapshot: { slug, systemPrompt, tools, modelPrimary: role.model ?? 'standard', modelFallback: [] },
      summary: `Hired ${slug}`,
    });
    await appendEvent(tx, {
      companyId,
      type: 'structure.changed',
      actor: 'owner',
      payload: { change: 'add_role', division: role.divisionId, slug, roleId },
    });
    return { roleId, ungranted };
  });
}

/**
 * Opens a division the owner approved (F2.9: adding a division is tier 3).
 *
 * Granted the platform's own tier 0 tools, as every division of the standard
 * template is: a division whose roles are told to search their memory and
 * read their skills, and are refused when they do, is one where following
 * the instructions fails. Only the ones this deployment has registered.
 */
export async function addDivision(
  companyId: string,
  division: { slug: string; name: string; parentDivisionId?: string | null; maxConcurrency?: number },
  options: { ownerApproved: boolean },
): Promise<string> {
  assertOwnerApproved(options.ownerApproved, {
    kind: 'add_division', slug: division.slug, name: division.name, parentDivisionId: division.parentDivisionId ?? null,
  });
  const slug = slugOf(division.slug, 'division');
  const name = String(division.name ?? '').trim();
  if (!name) throw new PalugadaError('contract.violation', 'a division needs a name', { field: 'name' });
  const maxConcurrency = division.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
    throw new PalugadaError('contract.violation', 'maxConcurrency is a whole number from 1 to 64', { field: 'maxConcurrency' });
  }

  return withTenant(companyId, async (tx) => {
    if ((await tx.query('SELECT 1 FROM divisions WHERE slug = $1', [slug])).rowCount) {
      throw new PalugadaError('contract.violation', `there is already a division named ${slug}`, { field: 'slug' });
    }
    let depth = 0;
    if (division.parentDivisionId) {
      const { rows: parent } = await tx.query<{ depth: number }>(
        'SELECT depth FROM divisions WHERE id = $1', [division.parentDivisionId]);
      if (!parent[0]) {
        throw new PalugadaError('contract.violation', 'no such parent division in this company', { field: 'parentDivisionId' });
      }
      if (parent[0].depth >= 1) {
        throw new PalugadaError(
          'contract.violation',
          'divisions go two levels deep at most; put this one beside its would-be parent',
          { field: 'parentDivisionId' },
        );
      }
      depth = 1;
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO divisions (company_id, parent_division_id, depth, slug, name, max_concurrency)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [companyId, division.parentDivisionId ?? null, depth, slug, name, maxConcurrency],
    );
    const divisionId = rows[0]!.id;
    await tx.query(
      `INSERT INTO capability_grants (company_id, division_id, capability_name)
       SELECT $1, $2, name FROM capabilities WHERE name = ANY($3::text[])`,
      [companyId, divisionId, [...PLATFORM_TOOLS]],
    );
    await appendEvent(tx, {
      companyId,
      type: 'structure.changed',
      actor: 'owner',
      payload: { change: 'add_division', division: divisionId, slug },
    });
    return divisionId;
  });
}

/**
 * Starts a project. Not structural in F2.9's sense -- a project groups work
 * and grants nothing -- so it needs the owner's session and not their device.
 */
export async function addProject(companyId: string, project: { slug: string; name: string }): Promise<string> {
  const slug = slugOf(project.slug, 'project');
  const name = String(project.name ?? '').trim();
  if (!name) throw new PalugadaError('contract.violation', 'a project needs a name', { field: 'name' });
  return withTenant(companyId, async (tx) => {
    if ((await tx.query('SELECT 1 FROM projects WHERE slug = $1', [slug])).rowCount) {
      throw new PalugadaError('contract.violation', `there is already a project named ${slug}`, { field: 'slug' });
    }
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO projects (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id', [companyId, slug, name]);
    await appendEvent(tx, {
      companyId, type: 'project.created', actor: 'owner', payload: { projectId: rows[0]!.id, slug },
    });
    return rows[0]!.id;
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
  // `coalesce` cannot say "set this to null", and null is a real setting here:
  // it means an escalation goes straight to the owner rather than to a role.
  // With `coalesce($2, escalation_role_slug)` that instruction was a silent
  // no-op -- the API answered `{ ok: true }`, an event was recorded, and the
  // division kept escalating to whatever it escalated to before. So which
  // fields were *given* decides the update, rather than which are non-null.
  const setsRole = 'roleSlug' in policy;
  const setsMinutes = 'afterMinutes' in policy;
  await withTenant(companyId, async (tx) => {
    await tx.query(
      `UPDATE divisions
          SET escalation_role_slug = CASE WHEN $4 THEN $2 ELSE escalation_role_slug END,
              escalate_after_minutes =
                CASE WHEN $5 THEN $3 ELSE escalate_after_minutes END
        WHERE id = $1`,
      [divisionId, policy.roleSlug ?? null, policy.afterMinutes ?? null, setsRole, setsMinutes],
    );
    await appendEvent(tx, {
      companyId,
      type: 'division.escalation_set',
      actor: 'owner',
      payload: { divisionId, ...policy },
    });
  });
}
