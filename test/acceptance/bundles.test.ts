/**
 * PRD v2 F16, F2.6, F1.5, F12.10 -- bundles, and moving a company between
 * instances.
 *
 * A bundle is the unit in which a working configuration travels. The claims
 * worth testing are the ones about trust: what an unsigned package is allowed
 * to do, whether an installed package is still the one that was published, and
 * whether a bundle can put text in front of every agent without anybody having
 * read it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import {
  BUILT_IN_BUNDLES,
  CONTENT_OPS,
  QA_REVIEW,
  WEB_OPS,
} from '../../src/bundles/builtin.ts';
import {
  bundleHook,
  canonicalise,
  hashBundle,
  installBundle,
  publishBundle,
  verifyBundleSignature,
  verifyInstall,
  type Bundle,
  type SignedBundle,
} from '../../src/bundles/bundle.ts';
import { HookPipeline } from '../../src/engine/hooks.ts';
import { exportCompany } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { skillSummariesFor } from '../../src/skills/skills.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/**
 * The archive as the stream `importCompany` reads.
 *
 * `collectExport` groups by section for convenience; the import wants the
 * lines in the order the export wrote them, because that order is what puts a
 * parent division before its child.
 */
async function archiveLines(companyId: string) {
  const lines: Array<{ section: string; row: Record<string, unknown> }> = [];
  await exportCompany(companyId, (line) => {
    lines.push(line);
  });
  return lines;
}

function publisher() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function signBundle(bundle: Bundle, keys: ReturnType<typeof publisher>): SignedBundle {
  return {
    ...bundle,
    signedBy: 'palugada-platform',
    publisherKey: keys.publicKey,
    signature: sign(null, Buffer.from(hashBundle(bundle)), keys.privateKey).toString('base64'),
  };
}

/* ------------------------------------------------------ hashing, signing --- */

/**
 * The hash must not depend on how the object was built.
 *
 * A hash that changed with key order would change when a serialiser did, and a
 * hash nobody can reproduce is a hash nobody checks.
 */
test('the hash is over a canonical form, not over key order (F16.2)', () => {
  assert.equal(
    canonicalise({ b: 1, a: [2, { d: 4, c: 3 }] }),
    canonicalise({ a: [2, { c: 3, d: 4 }], b: 1 }),
  );

  const reordered: Bundle = {
    version: CONTENT_OPS.version,
    slug: CONTENT_OPS.slug,
    description: CONTENT_OPS.description,
    name: CONTENT_OPS.name,
    body: CONTENT_OPS.body,
  };
  assert.equal(hashBundle(reordered), hashBundle(CONTENT_OPS));
});

test('a signature verifies, and a tampered body does not (F16.2)', () => {
  const keys = publisher();
  const signed = signBundle(CONTENT_OPS, keys);
  assert.equal(verifyBundleSignature(signed), true);

  const tampered: SignedBundle = {
    ...signed,
    body: {
      ...signed.body,
      grants: [...signed.body.grants, { division: 'content', capability: 'email.send' }],
    },
  };
  assert.equal(verifyBundleSignature(tampered), false);
});

/**
 * An invalid signature is refused outright, where none is merely quarantined.
 *
 * An invalid signature is worse than no signature: it is a false claim of
 * provenance, and storing it would let the quarantine check pass on a document
 * nobody signed.
 */
test('a bundle whose signature does not verify is refused (F16.2)', async () => {
  const keys = publisher();
  const impostor = publisher();
  const signed = signBundle(CONTENT_OPS, keys);

  await assert.rejects(
    () => publishBundle({ ...signed, publisherKey: impostor.publicKey }),
    (error: unknown) => isPalugadaError(error, 'bundle.bad_signature'),
  );
});

/* ------------------------------------------------------------- installing --- */

async function installable(fixture: Fixture, bundle: Bundle, sign?: boolean) {
  await registerStandardCatalogue();
  const keys = publisher();
  await publishBundle(sign ? signBundle(bundle, keys) : bundle);
  return installBundle({
    companyId: fixture.companyId,
    slug: bundle.slug,
    version: bundle.version,
  });
}

test('a signed bundle installs its roles, grants and heartbeats (F16.1, F2.6)', async () => {
  const fixture = await createCompany('bundle-install');
  const installed = await installable(fixture, WEB_OPS, true);

  assert.equal(installed.quarantined, false);
  assert.deepEqual(installed.roles, ['web-operator']);

  const role = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ tools: string[]; heartbeat_minutes: number }>(
      "SELECT tools, heartbeat_minutes FROM roles WHERE slug = 'web-operator'",
    );
    return rows[0]!;
  });
  assert.ok(role.tools.includes('dns.update'));
  assert.equal(role.heartbeat_minutes, 120);

  const grants = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ capability_name: string; rate_limit_per_hour: number | null }>(
      `SELECT capability_name, rate_limit_per_hour FROM capability_grants g
         JOIN divisions d ON d.id = g.division_id
        WHERE d.slug = 'web' ORDER BY capability_name`,
    );
    return rows;
  });
  assert.deepEqual(
    grants.map((grant) => grant.capability_name),
    ['dns.read', 'dns.update', 'memory.search', 'skill.read', 'uptime.check'],
  );
  assert.equal(grants.find((grant) => grant.capability_name === 'dns.update')!.rate_limit_per_hour, 5);
});

/**
 * F12.10: an unsigned bundle installs in quarantine, and quarantine is tier 0.
 *
 * Enforced on the grants rather than remembered as a flag: a tier 1 grant in an
 * unsigned bundle is simply not created, because a flag somebody has to check
 * is a flag somebody eventually does not.
 */
test('an unsigned bundle installs quarantined, with tier 0 grants only (F12.10)', async () => {
  const fixture = await createCompany('bundle-quarantine');
  const installed = await installable(fixture, WEB_OPS, false);
  assert.equal(installed.quarantined, true);

  const grants = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ capability_name: string; tier_override: number | null }>(
      `SELECT capability_name, tier_override FROM capability_grants g
         JOIN divisions d ON d.id = g.division_id
        WHERE d.slug = 'web' ORDER BY capability_name`,
    );
    return rows;
  });
  // The bundle asked for dns.update. It did not get it, because nothing in an
  // unsigned package may reach past a read.
  assert.equal(grants.length, 0, 'a grant with no tier override could be anything, so none is made');
});

/**
 * A bundle's skills arrive as candidates.
 *
 * F15.3 is not waived by the knowledge arriving in a package. A bundle that
 * could activate its own skills would be a way to put text in front of every
 * agent without anybody reading it.
 */
test('a bundle\'s skills arrive as candidates, not as knowledge (F16.1, F15.3)', async () => {
  const fixture = await createCompany('bundle-skills');
  const installed = await installable(fixture, QA_REVIEW, true);
  assert.deepEqual(installed.skills, ['reviewing']);

  const live = await withTenant(fixture.companyId, (tx) =>
    skillSummariesFor(tx, { companyId: fixture.companyId }),
  );
  assert.deepEqual(live, [], 'nothing is active until a reviewer and the owner have said so');

  const version = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ state: string; author: string }>(
      `SELECT v.state, v.author FROM skill_versions v
         JOIN skills s ON s.id = v.skill_id WHERE s.slug = 'reviewing'`,
    );
    return rows[0]!;
  });
  assert.equal(version.state, 'candidate');
  assert.equal(version.author, 'bundle');

  // And the eval case travels with it, so it is activatable at all (F15.4).
  const evals = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ name: string }>(
      `SELECT e.name FROM skill_evals e JOIN skills s ON s.id = e.skill_id
        WHERE s.slug = 'reviewing'`,
    );
    return rows;
  });
  assert.equal(evals.length, 1);
});

/**
 * F16.2's real question, asked later: is what is installed still what was
 * published?
 */
test('an edited bundle no longer matches the hash recorded at install (F16.2)', async () => {
  const fixture = await createCompany('bundle-integrity');
  await installable(fixture, QA_REVIEW, true);

  const intact = await verifyInstall(fixture.companyId, 'qa-review');
  assert.equal(intact!.intact, true);

  await withControlPlane(async (tx) => {
    await tx.query(
      `UPDATE bundles SET body = jsonb_set(body, '{description}', '"edited"')
        WHERE slug = 'qa-review'`,
    );
  });

  const tampered = await verifyInstall(fixture.companyId, 'qa-review');
  assert.equal(tampered!.intact, false);
  assert.notEqual(tampered!.currentHash, tampered!.installedHash);
});

test('a company can be assembled from several bundles (F16.3, F16.5)', async () => {
  const fixture = await createCompany('bundle-compose');
  await registerStandardCatalogue();
  const keys = publisher();

  for (const bundle of BUILT_IN_BUNDLES) {
    await publishBundle(signBundle(bundle, keys));
    await installBundle({
      companyId: fixture.companyId,
      slug: bundle.slug,
      version: bundle.version,
    });
  }

  const divisions = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM divisions ORDER BY slug');
    return rows.map((row) => row.slug);
  });
  assert.deepEqual(divisions, ['content', 'ops', 'review', 'web']);
});

/* ------------------------------------------------------------------ F14.4 --- */

test('a bundle hook can refuse and cannot permit (F14.4, F14.2)', async () => {
  const fixture = await createCompany('bundle-hook');
  const declaration = QA_REVIEW.body.hooks[0]!;
  const hook = bundleHook(declaration, { divisionId: fixture.divisionId });

  const pipeline = new HookPipeline();
  pipeline.add(hook);

  const readOnly = await pipeline.run('pre_tool', {
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    capability: 'memory.search',
    tier: 0,
  });
  assert.equal(readOnly.allowed, true);

  const write = await pipeline.run('pre_tool', {
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    capability: 'doc.draft',
    tier: 1,
  });
  assert.equal(write.allowed, false);
  assert.equal(write.refusedBy, 'review.read-only');
  assert.match(write.reason ?? '', /would be able to do the thing it just refused/);

  // A company is assembled from several bundles, so a hook scoped to one
  // division must say nothing about another. Without this, installing a
  // reviewer would stop every other division writing.
  const elsewhere = await pipeline.run('pre_tool', {
    companyId: fixture.companyId,
    divisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    capability: 'doc.draft',
    tier: 1,
  });
  assert.equal(elsewhere.allowed, true);

  // There is no shape in a bundle hook that says "permit", which is F14.2
  // holding by construction rather than by review.
  assert.equal('allow' in declaration, false);
});

/**
 * An installed bundle's hooks actually run.
 *
 * The gap this closes is the one that would be easy to miss: a bundle can
 * declare a hook, the declaration can be translated into a working hook, and
 * nothing would ever ask for it. The pipeline reads a company's installed
 * bundles, so installing `qa-review` really does stop its division writing.
 */
test('an installed bundle\'s hooks are consulted by the pipeline (F14.4)', async () => {
  const fixture = await createCompany('bundle-hook-live');
  await installable(fixture, QA_REVIEW, true);

  const reviewDivision = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM divisions WHERE slug = 'review'",
    );
    return rows[0]!.id;
  });

  const pipeline = new HookPipeline();
  const refused = await pipeline.run('pre_tool', {
    companyId: fixture.companyId,
    divisionId: reviewDivision,
    capability: 'doc.draft',
    tier: 1,
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.refusedBy, 'review.read-only');

  // The fixture's own division is untouched: the bundle constrains the division
  // it brought, not the company.
  const elsewhere = await pipeline.run('pre_tool', {
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    capability: 'doc.draft',
    tier: 1,
  });
  assert.equal(elsewhere.allowed, true);

  // A company with no bundles is unaffected, so an install is what changed it.
  const other = await createCompany('bundle-hook-none');
  const allowed = await new HookPipeline().run('pre_tool', {
    companyId: other.companyId,
    divisionId: other.divisionId,
    capability: 'doc.draft',
    tier: 1,
  });
  assert.equal(allowed.allowed, true);
});

test('a hook with no condition would refuse everything, so it is refused (F16.1)', async () => {
  await assert.rejects(
    () =>
      publishBundle({
        slug: 'broken',
        version: '1.0.0',
        name: 'Broken',
        description: '',
        body: {
          divisions: [{ slug: 'x', name: 'X' }],
          roles: [],
          grants: [],
          policies: [],
          skills: [],
          hooks: [{ name: 'refuses-all', on: 'pre_tool', reason: 'no' }],
          schedules: [],
        },
      }),
    (error: unknown) => isPalugadaError(error, 'bundle.invalid'),
  );
});

/* ------------------------------------------------------------ F16.4, F1.5 --- */

/**
 * A company moves between instances, and every identifier changes.
 *
 * A uuid is unique within an instance. Restoring one into another that already
 * holds the same company would merge the two rather than sit beside it, which
 * is the failure this test is actually about.
 */
test('a company exports and imports with every reference remapped (F16.4)', async () => {
  const fixture = await createCompany('export-source');
  await registerStandardCatalogue();
  const keys = publisher();
  await publishBundle(signBundle(CONTENT_OPS, keys));
  await installBundle({
    companyId: fixture.companyId,
    slug: CONTENT_OPS.slug,
    version: CONTENT_OPS.version,
  });

  const imported = await importCompany(
    await archiveLines(fixture.companyId),
    { slug: `${fixture.slug}-restored` },
  );

  assert.notEqual(imported.companyId, fixture.companyId);

  // The divisions came across, and their roles point at the *new* divisions.
  const restored = await withTenant(imported.companyId, async (tx) => {
    const { rows } = await tx.query<{ role: string; division: string }>(
      `SELECT r.slug AS role, d.slug AS division
         FROM roles r JOIN divisions d ON d.id = r.division_id
        ORDER BY r.slug`,
    );
    return rows;
  });
  assert.ok(restored.some((row) => row.role === 'writer' && row.division === 'content'));

  // Nothing points back at the source company. A single leaked reference would
  // be the exact failure the tenant boundary exists to prevent.
  const leaked = await withTenant(imported.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM divisions
        WHERE id IN (SELECT id FROM divisions WHERE company_id <> $1)`,
      [imported.companyId],
    );
    return Number(rows[0]!.count);
  });
  assert.equal(leaked, 0);

  // F1.5: the skills came with it, still as candidates.
  const skills = await withTenant(imported.companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string; state: string }>(
      `SELECT s.slug, v.state FROM skills s JOIN skill_versions v ON v.skill_id = s.id`,
    );
    return rows;
  });
  assert.deepEqual(skills, [{ slug: 'sourcing', state: 'candidate' }]);

  // An install points at a bundle in the platform's catalogue, which the
  // destination may not have, so it is reinstalled deliberately rather than
  // restored into a dangling reference.
  assert.ok(imported.skipped.includes('bundle_installs'));
});

test('the source company is untouched by an import (F16.4)', async () => {
  const fixture = await createCompany('export-untouched');
  const imported = await importCompany(
    await archiveLines(fixture.companyId),
    { slug: `${fixture.slug}-copy` },
  );

  const original = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM divisions',
    );
    return Number(rows[0]!.count);
  });
  const copy = await withTenant(imported.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM divisions',
    );
    return Number(rows[0]!.count);
  });
  assert.equal(original, 1);
  assert.equal(copy, 1);
});
