/**
 * PRD section 8.8, F8.2, F8.3, F8.10, F2.3 and open question 14.1.
 *
 * The owner settled 14.1 by saying the platform is for companies of every
 * kind, which turns "what capabilities does the first company need" into "what
 * does every company need" and makes the tier calibration a platform-wide
 * decision rather than a per-tenant one. These tests hold that calibration in
 * place, and hold the one boundary the sandbox cannot enforce for itself.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import {
  STANDARD_CATALOGUE,
  declarationFor,
  catalogueNames,
} from '../../src/broker/catalogue.ts';
import { createCompanyFromTemplate, saveTemplate } from '../../src/templates/company.ts';
import {
  STANDARD_COMPANY_TEMPLATE,
  STANDARD_TEMPLATE_SLUG,
  installStandardTemplate,
} from '../../src/templates/standard.ts';
import { registerStandardCatalogue, stubCapability } from '../helpers/catalogue-stubs.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

// ---------------------------------------------------------------------------
// The calibration
// ---------------------------------------------------------------------------

test('every catalogued capability carries a tier and the reason for it', () => {
  // A tier with no stated reason is a tier that will drift the first time
  // somebody finds it inconvenient, and the drift is always downwards.
  assert.ok(STANDARD_CATALOGUE.length >= 30, 'the catalogue covers the common ground');

  for (const entry of STANDARD_CATALOGUE) {
    assert.ok([0, 1, 2, 3].includes(entry.tier), `${entry.name} has a real tier`);
    assert.ok(entry.summary.length > 10, `${entry.name} says what it does`);
    assert.ok(
      entry.calibration.length > 30,
      `${entry.name} must say why it is this tier and not the next one`,
    );
  }

  assert.equal(new Set(catalogueNames()).size, STANDARD_CATALOGUE.length, 'no duplicate names');
});

test("the PRD's own examples keep the tiers the PRD gave them", () => {
  // Section 8.8 lists these by name. Where the document decided, the document
  // decides -- so a later edit that quietly promotes or demotes one of them
  // fails here rather than in an incident.
  const fromTheDocument: Array<[string, number]> = [
    ['dns.read', 0],
    ['uptime.check', 0],
    ['files.list', 0],
    ['doc.draft', 1],
    ['deploy.staging', 1],
    ['email.send', 2],
    ['domain.purchase', 2],
    ['deploy.production', 2],
    ['invoice.pay', 2],
    ['dns.nameservers', 3],
    ['record.delete', 3],
    ['domain.transfer', 3],
    ['server.destroy', 3],
    ['document.sign', 3],
    ['funds.transfer', 3],
  ];

  for (const [name, tier] of fromTheDocument) {
    assert.equal(declarationFor(name)?.tier, tier, `${name} must stay at tier ${tier}`);
  }
});

test('a binding may tighten the catalogue and may never loosen it (F8.3)', () => {
  const registry = new CapabilityRegistry();

  assert.throws(
    () =>
      registry.register({
        name: 'email.send',
        adapter: 'somebody:mail',
        // The mistake this catches: an adapter author picking the tier that
        // makes their integration convenient rather than the one the effect
        // deserves.
        defaultTier: 1,
        execute: async () => ({ ok: true }),
        verify: async () => true,
      }),
    (error: unknown) => isPalugadaError(error, 'capability.miscalibrated'),
    'tier 1 is below the catalogued tier 2 and must be refused',
  );

  assert.doesNotThrow(
    () =>
      registry.register({
        name: 'email.send',
        adapter: 'somebody:mail',
        defaultTier: 3,
        execute: async () => ({ ok: true }),
        verify: async () => true,
      }),
    'tightening to tier 3 is a deployment choice, not a downgrade',
  );

  assert.doesNotThrow(
    () =>
      registry.register({
        name: 'a.capability.the.catalogue.does.not.name',
        adapter: 'somebody:thing',
        defaultTier: 0,
        execute: async () => ({ ok: true }),
      }),
    'a company in a particular trade registers capabilities of its own',
  );
});

test('a binding cannot disagree about executing untrusted code', () => {
  const registry = new CapabilityRegistry();

  // Understating it would let the capability sit next to a credential, which
  // is the one arrangement the sandbox cannot survive.
  assert.throws(
    () =>
      registry.register({
        name: 'code.execute',
        adapter: 'somebody:sandbox',
        defaultTier: 2,
        execute: async () => ({ ok: true }),
        verify: async () => true,
      }),
    (error: unknown) => isPalugadaError(error, 'capability.miscalibrated'),
  );

  // And overstating it on something ordinary would strand that capability in
  // a division of its own for no reason, so the check runs both ways.
  assert.throws(
    () =>
      registry.register({
        name: 'doc.draft',
        adapter: 'somebody:docs',
        defaultTier: 1,
        executesUntrustedCode: true,
        execute: async () => ({ ok: true }),
        verify: async () => true,
      }),
    (error: unknown) => isPalugadaError(error, 'capability.miscalibrated'),
  );
});

test('exactly one capability executes untrusted code, and it needs no credential', () => {
  const executing = STANDARD_CATALOGUE.filter((entry) => entry.executesUntrustedCode);
  assert.deepEqual(
    executing.map((entry) => entry.name),
    ['code.execute'],
  );
  assert.notEqual(
    executing[0]!.needsCredential,
    true,
    'a capability that runs foreign code must not be the one holding a secret',
  );
});

test('the catalogue does not write itself into the registry table', async () => {
  // A row in `capabilities` means the broker can run the thing, and the table
  // requires a read-back above tier 0. Publishing declarations would mean
  // claiming a verify() that does not exist.
  await withTenant(
    (await createCompany('catalogue-unpublished')).companyId,
    async (tx) => {
      const { rows } = await tx.query<{ count: string }>('SELECT count(*) FROM capabilities');
      assert.equal(rows[0]!.count, '0', 'importing the catalogue registers nothing');
    },
  );
});

// ---------------------------------------------------------------------------
// The sandbox boundary, enforced by the database (F8.10)
// ---------------------------------------------------------------------------

async function addDivision(fixture: Fixture, slug: string): Promise<string> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $2) RETURNING id',
      [fixture.companyId, slug],
    );
    return rows[0]!.id;
  });
}

async function grant(fixture: Fixture, divisionId: string, capability: string): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO capability_grants (company_id, division_id, capability_name)
       VALUES ($1, $2, $3)`,
      [fixture.companyId, divisionId, capability],
    );
  });
}

async function addCredential(fixture: Fixture, divisionId: string): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'api', 'vault://acme/api-token')`,
      [fixture.companyId, divisionId],
    );
  });
}

test('a division that holds a credential cannot also run untrusted code', async () => {
  const fixture = await createCompany('sandbox-credential');
  await registerStandardCatalogue();
  const lab = await addDivision(fixture, 'lab');
  await addCredential(fixture, lab);

  await assert.rejects(
    () => grant(fixture, lab, 'code.execute'),
    /holds a credential.*executes untrusted code/s,
    'the sandbox does not stop code from posting a secret somewhere',
  );
});

test('a division that runs untrusted code cannot then be given a credential', async () => {
  // The same invariant from the other side. Checking only one direction would
  // mean the order of configuration decided whether the rule applied, which is
  // the same as not having the rule.
  const fixture = await createCompany('sandbox-credential-reverse');
  await registerStandardCatalogue();
  const lab = await addDivision(fixture, 'lab');
  await grant(fixture, lab, 'code.execute');

  await assert.rejects(
    () => addCredential(fixture, lab),
    /executes untrusted code.*credential cannot be scoped to it/s,
  );
});

test('untrusted code and a tier 2 grant cannot share a division', async () => {
  // PRD section 12 names this exact risk: a tier 3 effect assembled out of
  // lesser actions. Code execution beside a tier 2 capability is that assembly
  // already done.
  const fixture = await createCompany('sandbox-tier-two');
  await registerStandardCatalogue();

  const first = await addDivision(fixture, 'lab-a');
  await grant(fixture, first, 'code.execute');
  await assert.rejects(
    () => grant(fixture, first, 'email.send'),
    /executes untrusted code.*cannot also be granted email\.send/s,
  );

  const second = await addDivision(fixture, 'lab-b');
  await grant(fixture, second, 'email.send');
  await assert.rejects(
    () => grant(fixture, second, 'code.execute'),
    /granted email\.send, at tier 2 or above.*executes untrusted code/s,
  );
});

test('reading and drafting may sit beside untrusted code', async () => {
  // The rule has to leave the capability usable. Tier 0 and tier 1 grants are
  // not the ones that turn a sandbox escape into an irreversible action.
  const fixture = await createCompany('sandbox-permitted');
  await registerStandardCatalogue();
  const lab = await addDivision(fixture, 'lab');

  await grant(fixture, lab, 'code.execute');
  await grant(fixture, lab, 'files.list');
  await grant(fixture, lab, 'doc.draft');

  const held = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ capability_name: string }>(
      'SELECT capability_name FROM capability_grants WHERE division_id = $1 ORDER BY 1',
      [lab],
    );
    return rows.map((row) => row.capability_name);
  });
  assert.deepEqual(held, ['code.execute', 'doc.draft', 'files.list']);
});

test('a tightened grant is judged by its effective tier, not the registry default', async () => {
  // A grant may tighten (F8.3), so a tier 1 capability granted at tier 2 is a
  // tier 2 grant. Reading only the registry default here would let exactly
  // that arrangement past the boundary.
  const fixture = await createCompany('sandbox-effective-tier');
  await registerStandardCatalogue();
  const lab = await addDivision(fixture, 'lab');
  await grant(fixture, lab, 'code.execute');

  await assert.rejects(
    () =>
      withTenant(fixture.companyId, async (tx) => {
        await tx.query(
          `INSERT INTO capability_grants (company_id, division_id, capability_name, tier_override)
           VALUES ($1, $2, 'doc.draft', 2)`,
          [fixture.companyId, lab],
        );
      }),
    /executes untrusted code.*cannot also be granted doc\.draft, at tier 2/s,
  );
});

// ---------------------------------------------------------------------------
// The standard company
// ---------------------------------------------------------------------------

test('the standard template builds a company of any line of business', async () => {
  await registerStandardCatalogue();
  await installStandardTemplate();

  const created = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-one',
    name: 'Standard One',
    timezone: 'Asia/Jakarta',
  });

  assert.equal(Object.keys(created.divisionIds).length, 8);
  assert.equal(Object.keys(created.roleIds).length, 8);

  await withTenant(created.companyId, async (tx) => {
    const { rows: divisions } = await tx.query<{ slug: string; depth: number }>(
      'SELECT slug, depth FROM divisions ORDER BY depth, slug',
    );
    assert.deepEqual(
      divisions.map((row) => row.slug),
      ['assurance', 'delivery', 'finance', 'growth', 'lab', 'ops', 'support', 'build'],
    );
    // F2.2: one sub-division, and nothing deeper.
    assert.deepEqual(
      divisions.filter((row) => row.depth === 1).map((row) => row.slug),
      ['build'],
    );

    const { rows: budget } = await tx.query<{ tokens_max: string; money_max_cents: string }>(
      'SELECT tokens_max, money_max_cents FROM budget_accounts',
    );
    assert.equal(budget.length, 1, 'one account, shared by the whole delegation tree (F5.4)');
    assert.equal(budget[0]!.money_max_cents, '0', 'section 14.2 is open; zero is fail-closed');

    const { rows: sops } = await tx.query<{ count: string }>(
      `SELECT count(*) FROM memories
        WHERE memory_type = 'procedural' AND approval_state = 'active' AND source = 'template'`,
    );
    assert.equal(sops[0]!.count, '8', 'every division arrives with its own SOP, already approved');
  });
});

test('the reviewer division can approve and cannot act (F7.3)', async () => {
  await registerStandardCatalogue();
  await installStandardTemplate();
  const created = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-assurance',
    name: 'Standard Assurance',
  });

  await withTenant(created.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*) FROM capability_grants WHERE division_id = $1',
      [created.divisionIds.assurance],
    );
    assert.equal(rows[0]!.count, '0', 'a reviewer that can execute is a second pair of hands');

    const { rows: reviewer } = await tx.query<{ tools: string[] }>(
      "SELECT tools FROM roles WHERE slug = 'reviewer'",
    );
    assert.deepEqual(reviewer[0]!.tools, []);
  });
});

test('the lab is alone with the sandbox, and the database keeps it that way', async () => {
  await registerStandardCatalogue();
  await installStandardTemplate();
  const created = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-lab',
    name: 'Standard Lab',
  });

  const lab = created.divisionIds.lab!;
  await withTenant(created.companyId, async (tx) => {
    const { rows } = await tx.query<{ capability_name: string }>(
      'SELECT capability_name FROM capability_grants WHERE division_id = $1',
      [lab],
    );
    assert.deepEqual(rows.map((row) => row.capability_name), ['code.execute']);
  });

  // Not merely a convention of the template: an operator adding a credential
  // to the lab later is refused too.
  await assert.rejects(
    () =>
      withTenant(created.companyId, async (tx) => {
        await tx.query(
          `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
           VALUES ($1, $2, 'api', 'vault://acme/api-token')`,
          [created.companyId, lab],
        );
      }),
    /credential cannot be scoped to it/,
  );
});

test("every role's tools are granted to its own division (F2.3, F2.4)", async () => {
  await registerStandardCatalogue();
  await installStandardTemplate();
  const created = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-tools',
    name: 'Standard Tools',
  });

  // Checked against the rows that actually landed rather than against the
  // template object, because the interesting failure is one where the template
  // is right and the insert put a role in the wrong division.
  await withTenant(created.companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string; missing: string[] }>(
      `SELECT r.slug,
              array(
                SELECT t FROM unnest(r.tools) AS t
                 WHERE NOT EXISTS (
                   SELECT 1 FROM capability_grants g
                    WHERE g.division_id = r.division_id AND g.capability_name = t)
              ) AS missing
         FROM roles r ORDER BY r.slug`,
    );
    assert.equal(rows.length, 8);
    for (const row of rows) {
      assert.deepEqual(row.missing, [], `role ${row.slug} declares tools it was not granted`);
    }
  });
});

test('a template whose role reaches past its division is refused when it is saved', async () => {
  // The failure this replaces: the template stores happily, the company builds
  // happily, and the first call fails with capability.not_granted in
  // production.
  await assert.rejects(
    () =>
      saveTemplate({
        slug: 'reaching-template',
        name: 'Reaching',
        body: {
          divisions: [
            { slug: 'growth', name: 'Growth' },
            { slug: 'build', name: 'Build' },
          ],
          grants: [{ division: 'build', capability: 'dns.update' }],
          roles: [
            {
              slug: 'marketer',
              division: 'growth',
              systemPrompt: 'p',
              model: 'standard',
              tools: ['dns.update'],
            },
          ],
        },
      }),
    /declares tool dns\.update, which is not granted to its division growth/,
  );
});

test('the standard template refuses to build before its adapters exist', async () => {
  // The message has to name what is missing. A foreign key violation naming a
  // column would leave the operator guessing which of thirty capabilities the
  // deployment forgot.
  await installStandardTemplate();

  await assert.rejects(
    () =>
      createCompanyFromTemplate({
        templateSlug: STANDARD_TEMPLATE_SLUG,
        companySlug: 'standard-unbound',
        name: 'Standard Unbound',
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /not registered/);
      assert.match(message, /email\.send/);
      assert.match(message, /Register them with the broker/);
      return true;
    },
  );
});

test('the standard template grants only capabilities the catalogue calibrates', () => {
  // A grant for something outside the catalogue would be a capability with no
  // agreed tier, which is the state the calibration exists to prevent.
  const catalogued = new Set(catalogueNames());
  for (const grant of STANDARD_COMPANY_TEMPLATE.grants ?? []) {
    assert.ok(catalogued.has(grant.capability), `${grant.capability} is not in the catalogue`);
  }
});

test('two companies from the standard template stay strangers', async () => {
  const registry = await registerStandardCatalogue();
  assert.ok(registry.names().length >= 30);
  await installStandardTemplate();

  const mine = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-mine',
    name: 'Standard Mine',
  });
  const theirs = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-theirs',
    name: 'Standard Theirs',
  });

  // The two share every slug, which is the case where a missing tenant
  // predicate is invisible: the wrong row looks exactly like the right one.
  await withTenant(mine.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM divisions');
    const visible = new Set(rows.map((row) => row.id));
    assert.equal(visible.size, 8);
    for (const id of Object.values(theirs.divisionIds)) {
      assert.equal(visible.has(id), false, "another company's division is not visible");
    }
  });
});

test('a stub bound to a catalogued name still has to match its tier', () => {
  // Guards the test helper itself: if stubCapability ever stopped copying the
  // catalogued tier, every test above would keep passing while testing a
  // company built on the wrong calibration.
  const stub = stubCapability(declarationFor('deploy.production')!);
  assert.equal(stub.defaultTier, 2);
  assert.equal(stub.name, 'deploy.production');
});
