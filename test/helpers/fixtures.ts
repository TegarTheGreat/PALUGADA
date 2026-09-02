/**
 * Test fixtures.
 *
 * Companies are created through the control plane because that is the real
 * path: an agent cannot create its own tenant. Everything else is written
 * inside tenant scope, so the fixtures exercise the same isolation the
 * production code does instead of quietly bypassing it.
 */
import { randomUUID } from 'node:crypto';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import * as budgetModule from '../../src/engine/budget.ts';

export interface Fixture {
  companyId: string;
  projectId: string;
  divisionId: string;
  roleId: string;
  budgetAccountId: string;
  slug: string;
}

export async function createCompany(
  slug: string,
  options: { tokensMax?: number; moneyMaxCents?: number } = {},
): Promise<Fixture> {
  const unique = `${slug}-${randomUUID().slice(0, 8)}`;

  const companyId = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO companies (slug, name) VALUES ($1, $2) RETURNING id',
      [unique, unique],
    );
    return rows[0]!.id;
  });

  return withTenant(companyId, async (tx) => {
    const { rows: p } = await tx.query<{ id: string }>(
      'INSERT INTO projects (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [companyId, 'main', 'Main'],
    );
    const { rows: d } = await tx.query<{ id: string }>(
      'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [companyId, 'ops', 'Operations'],
    );
    const { rows: r } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model)
       VALUES ($1, $2, 'worker', 'You are a worker.', 'test-model') RETURNING id`,
      [companyId, d[0]!.id],
    );
    const budgetAccountId = await budgetModule.createAccount(tx, {
      companyId,
      label: 'root',
      tokensMax: options.tokensMax ?? 1_000_000,
      moneyMaxCents: options.moneyMaxCents ?? 100_000,
    });

    return {
      companyId,
      projectId: p[0]!.id,
      divisionId: d[0]!.id,
      roleId: r[0]!.id,
      budgetAccountId,
      slug: unique,
    };
  });
}

export async function addRole(
  fixture: Fixture,
  slug: string,
  schemas: { input?: Record<string, unknown>; output?: Record<string, unknown> } = {},
): Promise<string> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model,
                          input_schema, output_schema)
       VALUES ($1, $2, $3, 'You are a worker.', 'test-model', $4, $5) RETURNING id`,
      [
        fixture.companyId,
        fixture.divisionId,
        slug,
        JSON.stringify(schemas.input ?? {}),
        JSON.stringify(schemas.output ?? {}),
      ],
    );
    return rows[0]!.id;
  });
}

export async function setRoleSchemas(
  fixture: Fixture,
  roleId: string,
  schemas: { input?: Record<string, unknown>; output?: Record<string, unknown> },
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      'UPDATE roles SET input_schema = $2, output_schema = $3 WHERE id = $1',
      [roleId, JSON.stringify(schemas.input ?? {}), JSON.stringify(schemas.output ?? {})],
    );
  });
}

export async function grantCapability(
  fixture: Fixture,
  capabilityName: string,
  options: { tierOverride?: number; rateLimitPerHour?: number } = {},
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO capability_grants
         (company_id, division_id, capability_name, tier_override, rate_limit_per_hour)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (division_id, capability_name) DO UPDATE
         SET tier_override = EXCLUDED.tier_override,
             rate_limit_per_hour = EXCLUDED.rate_limit_per_hour`,
      [
        fixture.companyId,
        fixture.divisionId,
        capabilityName,
        options.tierOverride ?? null,
        options.rateLimitPerHour ?? null,
      ],
    );
  });
}
