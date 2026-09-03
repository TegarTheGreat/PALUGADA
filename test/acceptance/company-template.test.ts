/**
 * PRD F1.1, F16.3 and the Phase 2 completion criterion.
 *
 * Section 13 ends Phase 2 with "two companies running in parallel; the
 * isolation tests green". So this file does not only check that a template
 * produces the right rows -- it runs two companies built from the same
 * template through real work at the same time and then checks that nothing
 * crossed between them.
 *
 * Two companies from one template is the sharpest test of isolation there is:
 * identical division slugs, identical role slugs, identical SOP text. Anything
 * keyed on a name rather than an id fails here and nowhere else.
 */
import { test, before, beforeEach, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  assertTemplateIsCoherent,
  createCompanyFromTemplate,
  saveTemplate,
  type CompanyTemplate,
} from '../../src/templates/company.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { buildContext } from '../../src/context/builder.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import {
  STANDARD_TEMPLATE_SLUG,
  STANDARD_COMPANY_TEMPLATE,
} from '../../src/templates/standard.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

// F2.8 asks for an output schema, not a particular one. Kept permissive so
// these tests keep exercising the template rather than a contract shape they
// never set out to test.
const WORK_OUTPUT = { type: 'object' } as const;
const DONE = ['the run returns a summary of what it did'];

const TEMPLATE: CompanyTemplate = {
  projects: [{ slug: 'main', name: 'Main' }],
  goals: [
    { slug: 'mission', kind: 'mission', statement: 'Run the company well.' },
    { slug: 'deliver', kind: 'objective', parent: 'mission', statement: 'Ship the work.' },
  ],
  divisions: [
    { slug: 'ops', name: 'Operations', maxConcurrency: 2 },
    { slug: 'ops-infra', name: 'Infrastructure', parent: 'ops' },
    { slug: 'growth', name: 'Growth' },
  ],
  roles: [
    {
      slug: 'operator', division: 'ops', systemPrompt: 'You operate.', model: 'test-model',
      outputSchema: WORK_OUTPUT, doneCriteria: DONE,
    },
    {
      slug: 'qa-reviewer', division: 'ops', systemPrompt: 'You review.', model: 'test-model',
      outputSchema: WORK_OUTPUT, doneCriteria: DONE,
    },
    {
      slug: 'marketer', division: 'growth', systemPrompt: 'You market.', model: 'test-model',
      outputSchema: WORK_OUTPUT, doneCriteria: DONE,
    },
  ],
  sops: [{ division: 'ops', body: 'SOP: verify the zone before any deploy.' }],
  grants: [{ division: 'ops', capability: 'deploy.staging', rateLimitPerHour: 10 }],
  budget: { tokensMax: 500_000, moneyMaxCents: 20_000 },
};

/** Registers deploy.staging so the template's grant has something to point at. */
async function registerDeployCapability(): Promise<CapabilityRegistry> {
  const { capability } = stagingDeploy();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  return registry;
}

function stagingDeploy() {
  const deploys: string[] = [];
  const capability: Capability<{ target: string }, { ok: boolean }> = {
    name: 'deploy.staging',
    adapter: 'test:deploy',
    defaultTier: 1,
    async execute(input, ctx) {
      deploys.push(`${ctx.companyId}:${input.target}`);
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  return { capability, deploys };
}

test('a company is built from a template without touching code (F16.3, G7)', async () => {
  await registerDeployCapability();
  await saveTemplate({ slug: 'agency', name: 'Agency', body: TEMPLATE });
  const created = await createCompanyFromTemplate({
    templateSlug: 'agency',
    companySlug: 'acme',
    name: 'Acme',
    timezone: 'Asia/Jakarta',
  });

  assert.equal(Object.keys(created.divisionIds).length, 3);
  assert.equal(Object.keys(created.roleIds).length, 3);

  const shape = await withTenant(created.companyId, async (tx) => {
    const divisions = await tx.query<{ slug: string; depth: number }>(
      'SELECT slug, depth FROM divisions ORDER BY slug',
    );
    const roles = await tx.query<{ slug: string }>('SELECT slug FROM roles ORDER BY slug');
    const grants = await tx.query<{ capability_name: string; rate_limit_per_hour: number }>(
      'SELECT capability_name, rate_limit_per_hour FROM capability_grants',
    );
    const budget = await tx.query<{ tokens_max: string }>(
      'SELECT tokens_max FROM budget_accounts',
    );
    const timezone = await tx.query<{ timezone: string }>('SELECT timezone FROM companies');
    return {
      divisions: divisions.rows,
      roles: roles.rows.map((r) => r.slug),
      grants: grants.rows,
      tokensMax: Number(budget.rows[0]!.tokens_max),
      timezone: timezone.rows[0]!.timezone,
    };
  });

  // The sub-division found its parent, so depth was derived rather than
  // guessed at insertion order.
  assert.deepEqual(
    shape.divisions,
    [
      { slug: 'growth', depth: 0 },
      { slug: 'ops', depth: 0 },
      { slug: 'ops-infra', depth: 1 },
    ],
  );
  assert.deepEqual(shape.roles, ['marketer', 'operator', 'qa-reviewer']);
  assert.equal(shape.grants[0]!.rate_limit_per_hour, 10);
  assert.equal(shape.tokensMax, 500_000);
  assert.equal(shape.timezone, 'Asia/Jakarta');

  // A template's SOPs arrive active: the owner approved them by approving the
  // template. Only SOPs the system proposed for itself need the candidate path.
  const context = await withTenant(created.companyId, (tx) =>
    buildContext(tx, {
      companyId: created.companyId,
      divisionId: created.divisionIds.ops!,
    }),
  );
  assert.equal(context.sections.filter((section) => section.kind === 'sop').length, 1);
});

test('a template granting an unregistered capability says which one', async () => {
  await saveTemplate({ slug: 'agency', name: 'Agency', body: TEMPLATE });

  await assert.rejects(
    () =>
      createCompanyFromTemplate({
        templateSlug: 'agency', companySlug: 'ungranted', name: 'Ungranted',
      }),
    /not registered: deploy\.staging/,
    'the error must name the capability, not a constraint',
  );
});

test('an incoherent template is refused before it is stored', async () => {
  // A typo in a division name is otherwise a latent failure that surfaces
  // during company creation, which is exactly when nobody wants to debug one.
  assert.throws(
    () =>
      assertTemplateIsCoherent({
        divisions: [{ slug: 'ops', name: 'Ops' }],
        roles: [{ slug: 'r', division: 'opps', systemPrompt: 'p', model: 'm' }],
      }),
    /unknown division opps/,
  );

  assert.throws(
    () =>
      assertTemplateIsCoherent({
        divisions: [{ slug: 'ops', name: 'Ops' }, { slug: 'ops', name: 'Ops again' }],
        roles: [],
      }),
    /same division slug twice/,
  );

  assert.throws(
    () =>
      assertTemplateIsCoherent({
        divisions: [{ slug: 'ops', name: 'Ops' }],
        roles: [
          {
            slug: 'overloaded',
            division: 'ops',
            systemPrompt: 'p',
            model: 'm',
            tools: Array.from({ length: 13 }, (_, i) => `tool.${i}`),
          },
        ],
      }),
    /more than 12 tools/,
  );

  await assert.rejects(
    () =>
      saveTemplate({
        slug: 'broken',
        name: 'Broken',
        body: { divisions: [{ slug: 'a', name: 'A', parent: 'ghost' }], roles: [] },
      }),
    /unknown parent ghost/,
  );
});

test('a template that fails partway leaves no half-built company', async () => {
  // A company with two of its three divisions and no budget looks operable,
  // and the missing pieces only surface when an agent needs them.
  await saveTemplate({
    slug: 'duplicate-role',
    name: 'Duplicate role',
    body: {
      divisions: [{ slug: 'ops', name: 'Ops' }],
      roles: [
        {
          slug: 'same', division: 'ops', systemPrompt: 'p', model: 'm',
          outputSchema: WORK_OUTPUT, doneCriteria: DONE,
        },
        {
          slug: 'same', division: 'ops', systemPrompt: 'p', model: 'm',
          outputSchema: WORK_OUTPUT, doneCriteria: DONE,
        },
      ],
    },
  });

  await assert.rejects(() =>
    createCompanyFromTemplate({
      templateSlug: 'duplicate-role',
      companySlug: 'halfbuilt',
      name: 'Half built',
    }),
  );

  const survivors = await withControlPlane(async (tx) => {
    const { rows } = await tx.query('SELECT slug FROM companies WHERE slug = $1', ['halfbuilt']);
    return rows;
  });
  assert.equal(survivors.length, 0, 'the whole creation rolled back');
});

test('two companies from one template run in parallel without leaking', async () => {
  // The Phase 2 completion criterion. Identical slugs on both sides, so
  // anything keyed on a name rather than an id shows up here.
  await saveTemplate({ slug: 'agency', name: 'Agency', body: TEMPLATE });

  const { capability, deploys } = stagingDeploy();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();

  const [alpha, beta] = await Promise.all([
    createCompanyFromTemplate({ templateSlug: 'agency', companySlug: 'alpha', name: 'Alpha' }),
    createCompanyFromTemplate({ templateSlug: 'agency', companySlug: 'beta', name: 'Beta' }),
  ]);

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([
      ['operator', async (ctx) => {
        await ctx.callCapability('deploy.staging', { target: String(ctx.task.input.target) });
        return { deployed: ctx.task.input.target };
      }],
    ]),
  });

  const makeTask = (created: typeof alpha, target: string) =>
    createRootTask({
      companyId: created.companyId,
      projectId: created.projectIds.main!,
      divisionId: created.divisionIds.ops!,
      roleId: created.roleIds.operator!,
      budgetAccountId: created.budgetAccountId,
      goalId: created.goalIds.deliver!,
      input: { target },
      createdBy: 'owner',
      reserveTokens: 20_000,
    });

  const [taskA, taskB] = await Promise.all([
    makeTask(alpha, 'alpha-site'),
    makeTask(beta, 'beta-site'),
  ]);

  // Genuinely concurrent, not merely sequential in a loop.
  const [outcomeA, outcomeB] = await Promise.all([
    engine.runTask(alpha.companyId, taskA.id, 'operator'),
    engine.runTask(beta.companyId, taskB.id, 'operator'),
  ]);

  assert.equal(outcomeA.status, 'completed');
  assert.equal(outcomeB.status, 'completed');
  assert.deepEqual(outcomeA.output, { deployed: 'alpha-site' });
  assert.deepEqual(outcomeB.output, { deployed: 'beta-site' });

  // Each deploy ran under its own tenant.
  assert.deepEqual(
    deploys.sort(),
    [`${alpha.companyId}:alpha-site`, `${beta.companyId}:beta-site`].sort(),
  );

  // Neither company can see the other's work, despite identical slugs.
  for (const [mine, theirs, mySlug] of [
    [alpha, beta, 'alpha-site'],
    [beta, alpha, 'beta-site'],
  ] as const) {
    const visible = await withTenant(mine.companyId, async (tx) => {
      const { rows } = await tx.query<{ input: { target: string } }>('SELECT input FROM tasks');
      return rows.map((row) => row.input.target);
    });
    assert.deepEqual(visible, [mySlug]);

    const theirTask = await withTenant(mine.companyId, (tx) =>
      getTask(tx, theirs === alpha ? taskA.id : taskB.id),
    );
    assert.equal(theirTask, null, "another tenant's task must not be readable by id");

    const events = await withTenant(mine.companyId, async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM events WHERE type = 'tool.called'",
      );
      return Number(rows[0]!.count);
    });
    assert.equal(events, 1, 'each company sees exactly its own tool call');
  }

  // And the budgets are separate accounts, so one company cannot spend the
  // other's allowance.
  assert.notEqual(alpha.budgetAccountId, beta.budgetAccountId);
});

test('a second company can be created without a deploy (F1.1)', async () => {
  await registerDeployCapability();
  await saveTemplate({ slug: 'agency', name: 'Agency', body: TEMPLATE });
  const first = await createCompanyFromTemplate({
    templateSlug: 'agency', companySlug: 'first', name: 'First',
  });
  const second = await createCompanyFromTemplate({
    templateSlug: 'agency', companySlug: 'second', name: 'Second',
  });

  assert.notEqual(first.companyId, second.companyId);

  // Each creation is recorded on its own timeline, naming the template it came
  // from -- so "where did this company's shape come from" stays answerable.
  for (const created of [first, second]) {
    const events = await withTenant(created.companyId, async (tx) => {
      const { rows } = await tx.query<{ type: string; payload: { template: string } }>(
        "SELECT type, payload FROM events WHERE type = 'company.created'",
      );
      return rows;
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload.template, 'agency');
  }
});


/**
 * Every role can call the two tools its own context pack tells it to use.
 *
 * F4.8 caps the pack and instructs the run to use `memory.search` for whatever
 * did not fit; F15.7 puts a skill's summary in the pack and instructs it to use
 * `skill.read` for the document. A company whose roles are not granted them is
 * one where every run is told to call something it will be refused for — which
 * is what the first real boot of this platform found, and no test caught
 * because no test followed the instruction.
 */
test('every role in the standard company can read its own memory and skills (F4.8, F15.7)', async () => {
  await registerStandardCatalogue();
  // Saved from the source constant, deliberately. `createCompanyFromTemplate`
  // reads the template out of the database, so a test that relied on whatever
  // row happened to be there would be testing the last thing that wrote one —
  // and would pass against a stale copy while the source was broken. That is
  // exactly how this test first failed to catch the bug it exists for.
  await saveTemplate({
    slug: STANDARD_TEMPLATE_SLUG,
    name: 'Standard company',
    body: STANDARD_COMPANY_TEMPLATE,
  });

  const slug = `platform-tools-${randomUUID().slice(0, 8)}`;
  const created = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: slug,
    name: 'Platform tools',
  });

  const missing = await withTenant(created.companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string; division: string; missing: string[] }>(
      `SELECT r.slug, d.slug AS division,
              ARRAY(SELECT t FROM unnest(ARRAY['memory.search','skill.read']) t
                     WHERE NOT (t = ANY(r.tools))) AS missing
         FROM roles r JOIN divisions d ON d.id = r.division_id
        WHERE r.company_id = $1 ORDER BY r.slug`,
      [created.companyId],
    );
    return rows.filter((row) => row.missing.length > 0);
  });

  // Two deliberate exceptions, and they are the only two. The lab holds
  // `code.execute`, and SANDBOX_GUARANTEES records that the sandbox does not
  // isolate the network — so F8.10 already refuses that division a credential
  // or a tier 2 grant. Everything the company knows is the same category of
  // thing: `memory.search` there would be a search interface over the
  // company's knowledge, handed to supplied code. Assurance is excluded from
  // the other end: F7.3 says the reviewer approves and cannot act, and that is
  // guaranteed by its division holding no grant at all rather than by an
  // argument about which grants are harmless.
  assert.deepEqual(
    [...new Set(missing.map((row) => row.division))].sort(),
    ['assurance', 'lab'],
    'a role that cannot follow its own context pack, or an exception that can read the company',
  );

  // And the grant exists in every division, because a tool on a role that the
  // division does not hold is refused at the broker.
  const ungranted = await withTenant(created.companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string; capability: string }>(
      `SELECT d.slug, t AS capability
         FROM divisions d, unnest(ARRAY['memory.search','skill.read']) t
        WHERE d.company_id = $1
          AND NOT EXISTS (SELECT 1 FROM capability_grants g
                           WHERE g.division_id = d.id AND g.capability_name = t)
        ORDER BY d.slug, t`,
      [created.companyId],
    );
    return rows;
  });
  assert.deepEqual(
    [...new Set(ungranted.map((row) => row.slug))].sort(),
    ['assurance', 'lab'],
    'a division whose roles hold a tool it was never granted, or an exception that was granted one',
  );
});
