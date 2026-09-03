/**
 * Company templates (PRD F1.1, F16.3, goal G7).
 *
 * A new company is data, not a deployment: divisions, roles, SOPs, capability
 * grants and a budget come from a stored template. That is what G7 asks for --
 * adding a company, a division or a capability must not require changing core
 * code.
 *
 * The whole creation runs in one transaction. A template that fails halfway
 * would leave a company with two of its three divisions and no budget, which
 * is worse than no company at all: it looks operable, and the missing pieces
 * only surface when an agent needs them.
 *
 * It runs on the control plane because a tenant cannot create itself, and
 * because the rows have to be written before there is a tenant context to
 * write them under.
 */
import { withControlPlane, type TenantClient } from '../db/tenant.ts';

export interface TemplateDivision {
  slug: string;
  name: string;
  parent?: string;
  maxConcurrency?: number;
}

export interface TemplateRole {
  slug: string;
  division: string;
  systemPrompt: string;
  model: string;
  tools?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  maxTokensPerRun?: number;
}

export interface TemplateGrant {
  division: string;
  capability: string;
  tierOverride?: number;
  rateLimitPerHour?: number;
}

export interface CompanyTemplate {
  projects?: Array<{ slug: string; name: string }>;
  divisions: TemplateDivision[];
  roles: TemplateRole[];
  sops?: Array<{ division: string; body: string }>;
  grants?: TemplateGrant[];
  budget?: { tokensMax: number; moneyMaxCents?: number };
}

export interface CreatedCompany {
  companyId: string;
  projectIds: Record<string, string>;
  divisionIds: Record<string, string>;
  roleIds: Record<string, string>;
  budgetAccountId: string;
}

export async function saveTemplate(input: {
  slug: string;
  name: string;
  description?: string;
  body: CompanyTemplate;
}): Promise<void> {
  assertTemplateIsCoherent(input.body);
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO company_templates (slug, name, description, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             body = EXCLUDED.body`,
      [input.slug, input.name, input.description ?? '', JSON.stringify(input.body)],
    );
  });
}

/**
 * Checks the template refers only to things it defines.
 *
 * Validated before it is stored rather than when a company is built from it.
 * A template with a typo in a division name is a latent failure that surfaces
 * during company creation, which is exactly when nobody wants to debug one.
 */
export function assertTemplateIsCoherent(template: CompanyTemplate): void {
  const divisions = new Set(template.divisions.map((division) => division.slug));

  // Built before the roles are checked, because a role's tools have to be a
  // subset of its own division's grants (F2.3) and a grant does not reach a
  // sub-division: `readGrant` matches the division exactly.
  const granted = new Map<string, Set<string>>();
  for (const grant of template.grants ?? []) {
    let set = granted.get(grant.division);
    if (!set) {
      set = new Set();
      granted.set(grant.division, set);
    }
    set.add(grant.capability);
  }

  if (divisions.size !== template.divisions.length) {
    throw new Error('template defines the same division slug twice');
  }

  for (const division of template.divisions) {
    if (division.parent && !divisions.has(division.parent)) {
      throw new Error(`division ${division.slug} names unknown parent ${division.parent}`);
    }
    if (division.parent === division.slug) {
      throw new Error(`division ${division.slug} cannot be its own parent`);
    }
  }

  for (const role of template.roles) {
    if (!divisions.has(role.division)) {
      throw new Error(`role ${role.slug} names unknown division ${role.division}`);
    }
    if ((role.tools ?? []).length > 12) {
      // Also a database constraint (F2.4). Rejecting it here keeps a bad
      // template from being stored and rediscovered later.
      throw new Error(`role ${role.slug} declares more than 12 tools (PRD F2.4)`);
    }
    for (const tool of role.tools ?? []) {
      // F2.3: a role's tools are a subset of its division's grants. Without
      // this the template stores happily and the mistake surfaces as a
      // `capability.not_granted` in production, on the first call, which is
      // both the latest and the least convenient moment to learn about it.
      if (!granted.get(role.division)?.has(tool)) {
        throw new Error(
          `role ${role.slug} declares tool ${tool}, which is not granted to its division ` +
            `${role.division} (PRD F2.3, F2.4)`,
        );
      }
    }
  }

  for (const grant of template.grants ?? []) {
    if (!divisions.has(grant.division)) {
      throw new Error(`grant for ${grant.capability} names unknown division ${grant.division}`);
    }
  }

  for (const sop of template.sops ?? []) {
    if (!divisions.has(sop.division)) {
      throw new Error(`SOP names unknown division ${sop.division}`);
    }
  }
}

export async function readTemplate(slug: string): Promise<CompanyTemplate | null> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ body: CompanyTemplate }>(
      'SELECT body FROM company_templates WHERE slug = $1',
      [slug],
    );
    return rows[0]?.body ?? null;
  });
}

export interface CreateFromTemplateInput {
  templateSlug: string;
  companySlug: string;
  name: string;
  timezone?: string;
}

export async function createCompanyFromTemplate(
  input: CreateFromTemplateInput,
): Promise<CreatedCompany> {
  const template = await readTemplate(input.templateSlug);
  if (!template) throw new Error(`no company template named ${input.templateSlug}`);
  assertTemplateIsCoherent(template);

  return withControlPlane(async (tx) => {
    await assertCapabilitiesExist(tx, template);
    const companyId = await insertCompany(tx, input);
    const projectIds = await insertProjects(tx, companyId, template);
    const divisionIds = await insertDivisions(tx, companyId, template);
    const roleIds = await insertRoles(tx, companyId, template, divisionIds);
    await insertSops(tx, companyId, template, divisionIds);
    await insertGrants(tx, companyId, template, divisionIds);
    const budgetAccountId = await insertBudget(tx, companyId, template);

    await tx.query(
      `INSERT INTO events (company_id, project_id, type, actor, payload)
       VALUES ($1, $2, 'company.created', 'owner', $3)`,
      [
        companyId,
        Object.values(projectIds)[0] ?? null,
        JSON.stringify({
          template: input.templateSlug,
          divisions: Object.keys(divisionIds).length,
          roles: Object.keys(roleIds).length,
        }),
      ],
    );

    return { companyId, projectIds, divisionIds, roleIds, budgetAccountId };
  });
}

/**
 * Checks the capabilities a template grants are actually registered.
 *
 * The foreign key would catch this anyway, but as an opaque constraint
 * violation naming a column. Checking here turns it into a message that names
 * the missing capabilities and therefore the fix. It cannot be checked when
 * the template is saved: a template may legitimately be written before the
 * adapters it depends on are registered.
 */
async function assertCapabilitiesExist(
  tx: TenantClient,
  template: CompanyTemplate,
): Promise<void> {
  const wanted = [...new Set((template.grants ?? []).map((grant) => grant.capability))];
  if (wanted.length === 0) return;

  const { rows } = await tx.query<{ name: string }>(
    'SELECT name FROM capabilities WHERE name = ANY($1::text[])',
    [wanted],
  );
  const known = new Set(rows.map((row) => row.name));
  const missing = wanted.filter((name) => !known.has(name));

  if (missing.length > 0) {
    throw new Error(
      `template grants capabilities that are not registered: ${missing.join(', ')}. ` +
        'Register them with the broker before creating a company from this template.',
    );
  }
}

async function insertCompany(tx: TenantClient, input: CreateFromTemplateInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO companies (slug, name, timezone) VALUES ($1, $2, $3) RETURNING id',
    [input.companySlug, input.name, input.timezone ?? 'UTC'],
  );
  return rows[0]!.id;
}

async function insertProjects(
  tx: TenantClient,
  companyId: string,
  template: CompanyTemplate,
): Promise<Record<string, string>> {
  const projects = template.projects ?? [{ slug: 'main', name: 'Main' }];
  const ids: Record<string, string> = {};
  for (const project of projects) {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO projects (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [companyId, project.slug, project.name],
    );
    ids[project.slug] = rows[0]!.id;
  }
  return ids;
}

async function insertDivisions(
  tx: TenantClient,
  companyId: string,
  template: CompanyTemplate,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  // Parents first, so a sub-division always finds the row it points at. The
  // depth trigger derives depth from the parent, so ordering is the only
  // requirement.
  const ordered = [
    ...template.divisions.filter((division) => !division.parent),
    ...template.divisions.filter((division) => division.parent),
  ];
  for (const division of ordered) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO divisions (company_id, parent_division_id, slug, name, max_concurrency)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        companyId,
        division.parent ? ids[division.parent] : null,
        division.slug,
        division.name,
        division.maxConcurrency ?? 4,
      ],
    );
    ids[division.slug] = rows[0]!.id;
  }
  return ids;
}

async function insertRoles(
  tx: TenantClient,
  companyId: string,
  template: CompanyTemplate,
  divisionIds: Record<string, string>,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const role of template.roles) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, tools,
                          input_schema, output_schema, max_tokens_per_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        companyId,
        divisionIds[role.division],
        role.slug,
        role.systemPrompt,
        role.model,
        role.tools ?? [],
        JSON.stringify(role.inputSchema ?? {}),
        JSON.stringify(role.outputSchema ?? {}),
        role.maxTokensPerRun ?? 100000,
      ],
    );
    ids[role.slug] = rows[0]!.id;
  }
  return ids;
}

async function insertSops(
  tx: TenantClient,
  companyId: string,
  template: CompanyTemplate,
  divisionIds: Record<string, string>,
): Promise<void> {
  for (const sop of template.sops ?? []) {
    // A template's SOPs are active on arrival: the owner approved them by
    // approving the template. Only SOPs the system proposed for itself need
    // the candidate path (F4.5).
    await tx.query(
      `INSERT INTO memories (company_id, memory_type, scope_type, scope_id, body,
                             source, approval_state, approved_at)
       VALUES ($1, 'procedural', 'division', $2, $3, 'template', 'active', now())`,
      [companyId, divisionIds[sop.division], sop.body],
    );
  }
}

async function insertGrants(
  tx: TenantClient,
  companyId: string,
  template: CompanyTemplate,
  divisionIds: Record<string, string>,
): Promise<void> {
  for (const grant of template.grants ?? []) {
    await tx.query(
      `INSERT INTO capability_grants
         (company_id, division_id, capability_name, tier_override, rate_limit_per_hour)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        companyId,
        divisionIds[grant.division],
        grant.capability,
        grant.tierOverride ?? null,
        grant.rateLimitPerHour ?? null,
      ],
    );
  }
}

async function insertBudget(
  tx: TenantClient,
  companyId: string,
  template: CompanyTemplate,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO budget_accounts (company_id, label, tokens_max, money_max_cents)
     VALUES ($1, 'company', $2, $3) RETURNING id`,
    [companyId, template.budget?.tokensMax ?? 1_000_000, template.budget?.moneyMaxCents ?? 0],
  );
  return rows[0]!.id;
}
