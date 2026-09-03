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
import { recordPlan } from '../../src/engine/plan.ts';
import { createGoal } from '../../src/domain/goals.ts';

export interface Fixture {
  companyId: string;
  projectId: string;
  divisionId: string;
  roleId: string;
  budgetAccountId: string;
  slug: string;
  /** F2.7: the objective every task in these tests hangs from. */
  goalId: string;
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

  // F2.7: every root task names a goal, so the fixture has one to name. A
  // mission with one objective under it is the shortest chain that still has
  // a shape worth testing.
  const mission = await createGoal({
    companyId,
    kind: 'mission',
    slug: 'mission',
    statement: `Run ${unique} well.`,
  });
  const objective = await createGoal({
    companyId,
    kind: 'objective',
    slug: 'objective',
    statement: 'Keep the work moving without surprising the owner.',
    parentGoalId: mission.id,
  });
  const goalId = objective.id;

  return withTenant(companyId, async (tx) => {
    const { rows: p } = await tx.query<{ id: string }>(
      'INSERT INTO projects (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [companyId, 'main', 'Main'],
    );
    const { rows: d } = await tx.query<{ id: string }>(
      'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [companyId, 'ops', 'Operations'],
    );
    // F2.8: a role with no output schema and no completion criterion cannot be
    // given work, so the fixture supplies both. They are deliberately minimal
    // -- a test that cares about contracts sets its own.
    const { rows: r } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model,
                          output_schema, done_criteria)
       VALUES ($1, $2, 'worker', 'You are a worker.', 'test-model',
               '{"type":"object"}'::jsonb,
               ARRAY['the run returns an output matching its schema'])
       RETURNING id`,
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
      goalId,
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
                          input_schema, output_schema, done_criteria)
       VALUES ($1, $2, $3, 'You are a worker.', 'test-model', $4, $5,
               ARRAY['the run returns an output matching its schema'])
       RETURNING id`,
      [
        fixture.companyId,
        fixture.divisionId,
        slug,
        JSON.stringify(schemas.input ?? {}),
        JSON.stringify(schemas.output ?? { type: 'object' }),
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
    // Only what it was given. Blanking the other half would quietly strip the
    // output schema F2.8 requires, and the failure would surface three tests
    // later as an admission refusal nobody asked for.
    await tx.query(
      `UPDATE roles
          SET input_schema = coalesce($2::jsonb, input_schema),
              output_schema = coalesce($3::jsonb, output_schema)
        WHERE id = $1`,
      [
        roleId,
        schemas.input === undefined ? null : JSON.stringify(schemas.input),
        schemas.output === undefined ? null : JSON.stringify(schemas.output),
      ],
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

/**
 * Records the plan F8.11 requires before a task may take a tier 2 action.
 *
 * The intent and expected effect are filled in generically here because these
 * tests are about the gate rather than about plan authorship; a test that
 * cares what the plan says writes its own.
 */
export async function planTask(
  companyId: string,
  taskId: string,
  steps: Array<{ capability: string; batchSize?: number }>,
): Promise<void> {
  await recordPlan(
    companyId,
    taskId,
    steps.map((step) => ({
      capability: step.capability,
      intent: `use ${step.capability}`,
      expectedEffect: `${step.capability} has run`,
      ...(step.batchSize === undefined ? {} : { batchSize: step.batchSize }),
    })),
  );
}
