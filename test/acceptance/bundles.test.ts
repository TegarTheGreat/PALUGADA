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
  COMPANY_OS,
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
import { createRootTask } from '../../src/engine/tasks.ts';
import { evaluate } from '../../src/policy/engine.ts';
import {
  isTrustedPublisher,
  keyFingerprint,
  revokePublisher,
  trustPublisher,
} from '../../src/bundles/publishers.ts';
import { exportCompany } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import {
  importExternalSkill,
  liftSkillQuarantine,
  skillSummariesFor,
} from '../../src/skills/skills.ts';
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

/**
 * Somebody else's bundle: the same content under a name this code does not
 * ship. The platform's own bundles install as first-party when they are
 * unchanged (installBundle), so what a stranger's bundle meets is shown with
 * a stranger's copy.
 */
const theirs = (bundle: Bundle): Bundle => ({ ...bundle, slug: `their-${bundle.slug}` });

async function installable(fixture: Fixture, bundle: Bundle, sign?: boolean) {
  await registerStandardCatalogue();
  const keys = publisher();
  if (sign) {
    // Signing alone is not enough any more, and that is the point: the key has
    // to be one this installation was told to accept.
    await trustPublisher({
      publicKeyPem: keys.publicKey,
      label: 'the test publisher',
      ownerApproved: true,
    });
  }
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
  const installed = await installable(fixture, theirs(WEB_OPS), false);
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
  await trustPublisher({
    publicKeyPem: keys.publicKey,
    label: 'the test publisher',
    ownerApproved: true,
  });

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
  assert.deepEqual(divisions, ['content', 'ops', 'platform', 'platform-review', 'review', 'strategy', 'strategy-review', 'web']);

  // And the rules they came with are in force. Every built-in bundle declared
  // its policies and none was ever installed, so "a push waits for the
  // reviewer" and "a DNS change waits for the owner" were promises in a file.
  const { rows: policies } = await withControlPlane((tx) => tx.query<{ slug: string; effect: string; division: string | null }>(
    `SELECT p.slug, p.effect, d.slug AS division FROM policies p LEFT JOIN divisions d ON d.id = p.division_id
      WHERE p.company_id = $1 ORDER BY p.slug`, [fixture.companyId]));
  assert.deepEqual(policies.map((row) => [row.slug, row.effect, row.division]), [
    ['content-external-publish-needs-review', 'require_review', 'content'],
    ['no-paid-reach-before-launch', 'deny', null],
    ['palugada-dev-push-is-reviewed', 'require_review', 'platform'],
    ['stage-move-needs-the-critic', 'require_review', null],
    ['web-dns-always-owner', 'require_approval', 'web'],
    ['wind-down-starts-nothing', 'deny', null],
  ]);
});

/**
 * A bundle's policy is a rule, so it is data the policy engine reads -- the
 * first versions wrote it as text nothing parsed -- checked when the bundle is
 * published, and in force once it is installed. A quarantined bundle brings
 * its restrictions and none of its permissions.
 */
test("a bundle's policies are checked when published and in force once installed (F16.1, F3.4)", async () => {
  const fixture = await createCompany('bundle-policies');
  const text = { ...CONTENT_OPS, slug: 'as-text', body: { ...CONTENT_OPS.body, policies: [
    { ...CONTENT_OPS.body.policies[0]!, condition: 'tool == "social.publish"' as never },
  ] } };
  await assert.rejects(publishBundle(text), (error: unknown) =>
    isPalugadaError(error, 'bundle.invalid') && /condition as data/.test((error as Error).message));
  const unnamed = { ...CONTENT_OPS, slug: 'no-reviewer', body: { ...CONTENT_OPS.body, policies: [
    { ...CONTENT_OPS.body.policies[0]!, params: { criteria: 'x' } },
  ] } };
  await assert.rejects(publishBundle(unnamed), /is a review and names no reviewer_role/);

  // The reviewer content-ops names comes from qa-review; without it, nothing
  // is installed rather than a review nobody can give.
  await registerStandardCatalogue();
  await publishBundle(CONTENT_OPS);
  await assert.rejects(installBundle({ companyId: fixture.companyId, slug: CONTENT_OPS.slug, version: CONTENT_OPS.version }),
    /reviewed by qa-reviewer, which neither this bundle nor the company has/);
  const { rows: nothing } = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM divisions WHERE slug = 'content'"));
  assert.equal(nothing.length, 0, 'a refused install leaves nothing behind');
  await installable(fixture, QA_REVIEW);
  const loose: Bundle = { ...CONTENT_OPS, slug: 'loosening', body: { ...CONTENT_OPS.body, policies: [
    ...CONTENT_OPS.body.policies,
    { slug: 'publish-freely', scope: 'company', condition: { field: 'tool', op: 'eq', value: 'social.publish' }, effect: 'allow' },
  ] } };

  // Unsigned, so quarantined: the review comes in, the permission does not.
  const installed = await installable(fixture, loose);
  assert.equal(installed.quarantined, true);
  assert.deepEqual(installed.policies, ['content-external-publish-needs-review']);
  const decision = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM divisions WHERE slug = 'content'");
    return evaluate(tx, fixture.companyId, rows[0]!.id, {
      tool: 'social.publish', tier: 2, division: 'content', money_cents: 0, recipient_domain: null,
      url_host: null, hour_local: 10, calls_in_window: 0, stage: null,
    });
  });
  assert.equal(decision.effect, 'require_review');
});

/**
 * auto-company's value is its operating frameworks -- validate before
 * building, premortems, value pricing, unit economics, a weekly review against
 * the numbers -- and a company here had none of them and nobody whose job was
 * "what should we do next". The kit brings them: a strategist that proposes
 * and never applies, the frameworks as skills that still go through review and
 * the owner (F15.3), and the weekly business review on the company's own
 * clock.
 */
test('the operating kit brings a strategist, its frameworks for review, and a weekly review on the company clock', async () => {
  const fixture = await createCompany('bundle-company-os');
  await registerStandardCatalogue();
  const keys = publisher();
  await trustPublisher({ publicKeyPem: keys.publicKey, label: 'the test publisher', ownerApproved: true });
  await withControlPlane((tx) => tx.query("UPDATE companies SET timezone = 'Asia/Jakarta' WHERE id = $1", [fixture.companyId]));

  await publishBundle(signBundle(COMPANY_OS, keys));
  const installed = await installBundle({ companyId: fixture.companyId, slug: 'company-os', version: COMPANY_OS.version });
  assert.deepEqual(installed.roles, ['strategist', 'critic']);

  const { rows: schedules } = await withTenant(fixture.companyId, (tx) => tx.query<{
    slug: string; cron_expression: string; timezone: string; enabled: boolean; goal: string; kind: string; role: string;
  }>(
    `SELECT s.slug, s.cron_expression, s.timezone, s.enabled, s.input->>'goal' AS goal, g.kind, r.slug AS role
       FROM schedules s JOIN goals g ON g.id = s.goal_id JOIN roles r ON r.id = s.role_id`,
  ));
  assert.equal(schedules.length, 1);
  assert.deepEqual(
    [schedules[0]!.slug, schedules[0]!.cron_expression, schedules[0]!.timezone, schedules[0]!.enabled, schedules[0]!.kind, schedules[0]!.role],
    ['weekly-business-review', '45 7 * * 1', 'Asia/Jakarta', true, 'mission', 'strategist'],
  );
  assert.match(schedules[0]!.goal, /Weekly business review/);

  // The frameworks arrive as candidates: somebody reviews them and the owner
  // approves before any agent reads one.
  const { rows: skills } = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string; active_version: number | null }>(
    'SELECT slug, active_version FROM skills ORDER BY slug'));
  assert.deepEqual(skills.map((skill) => skill.slug), COMPANY_OS.body.skills.map((skill) => skill.slug).sort());
  assert.ok(skills.every((skill) => skill.active_version === null), 'no skill of a bundle activates itself');

});

test("the platform's own kit installs as shipped, and a copy somebody changed does not", async () => {
  // The built-in bundles ship with the code and were published unsigned, so
  // every one installed quarantined: "Let it run itself" gave the strategist
  // no grants and left its weekly review off, on every stock deployment.
  // First-party is decided by content -- the stored bundle still hashes to
  // the one this code ships -- and never by the name.
  const fixture = await createCompany('bundle-company-os-first-party');
  await registerStandardCatalogue();
  await publishBundle(COMPANY_OS);
  const shipped = await installBundle({ companyId: fixture.companyId, slug: 'company-os', version: COMPANY_OS.version });
  assert.equal(shipped.quarantined, false);
  const { rows: running } = await withTenant(fixture.companyId, (tx) => tx.query<{ enabled: boolean }>(
    "SELECT enabled FROM schedules WHERE slug = 'weekly-business-review'"));
  assert.deepEqual(running, [{ enabled: true }]);
  const { rows: granted } = await withTenant(fixture.companyId, (tx) => tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM capability_grants g JOIN divisions d ON d.id = g.division_id WHERE d.slug = 'strategy'`));
  assert.ok(granted[0]!.n > 0, 'the strategist can use its tools');

  // Quarantined (F12.10), a changed copy gets tier 0 and nothing else -- and
  // a schedule of its own making would have it spend the company's money
  // every week on the strength of a document nobody vouched for.
  const other = await createCompany('bundle-company-os-unsigned');
  await withControlPlane((tx) => tx.query(
    `UPDATE bundles SET body = jsonb_set(body, '{roles,0,systemPrompt}', '"Spend freely."') WHERE slug = 'company-os'`));
  const installed = await installBundle({ companyId: other.companyId, slug: 'company-os', version: COMPANY_OS.version });
  assert.equal(installed.quarantined, true, 'a stored body that is not the one shipped is nobody\'s');
  const { rows } = await withTenant(other.companyId, (tx) => tx.query<{ enabled: boolean }>(
    "SELECT enabled FROM schedules WHERE slug = 'weekly-business-review'"));
  assert.deepEqual(rows, [{ enabled: false }]);

  // And a cadence that could never fire is refused when it is published, not
  // discovered on a Monday morning.
  const broken = {
    ...COMPANY_OS,
    slug: 'company-os-broken',
    body: { ...COMPANY_OS.body, cadences: [{ ...COMPANY_OS.body.cadences![0]!, cron: 'every monday' }] },
  };
  await assert.rejects(publishBundle(broken), /invalid cron expression/);
  const orphan = {
    ...COMPANY_OS,
    slug: 'company-os-orphan',
    body: { ...COMPANY_OS.body, cadences: [{ ...COMPANY_OS.body.cadences![0]!, roleSlug: 'nobody' }] },
  };
  await assert.rejects(publishBundle(orphan), /names role nobody/);
});

/**
 * The kit as it was before the critic: the same body without the critic and
 * what came with it -- its division, grants, hook, heartbeat and the rule
 * that names it.
 */
function kitBeforeTheCritic(): Bundle {
  const body = COMPANY_OS.body;
  const division = body.roles.find((role) => role.slug === 'critic')!.division;
  return {
    ...COMPANY_OS,
    version: '1.3.0',
    body: {
      ...body,
      divisions: body.divisions.filter((one) => one.slug !== division),
      roles: body.roles.filter((one) => one.slug !== 'critic'),
      grants: body.grants.filter((one) => one.division !== division),
      policies: body.policies.filter((one) => one.params?.reviewer_role !== 'critic'),
      hooks: body.hooks.filter((one) => one.division !== division),
      schedules: body.schedules.filter((one) => one.roleSlug !== 'critic'),
    },
  };
}

test('installing the kit over the version before it adds the critic and leaves the company as it was', async () => {
  const fixture = await createCompany('bundle-company-os-upgrade');
  const { companyId } = fixture;
  await registerStandardCatalogue();
  // Installed as written, as the shipped version was on its own deployment.
  const keys = publisher();
  await trustPublisher({ publicKeyPem: keys.publicKey, label: 'the test publisher', ownerApproved: true });
  const before = kitBeforeTheCritic();
  await publishBundle(signBundle(before, keys));
  assert.equal((await installBundle({ companyId, slug: before.slug, version: before.version })).quarantined, false);

  const snapshot = () => withTenant(companyId, async (tx) => ({
    roles: (await tx.query<{ id: string; slug: string; division: string; division_id: string }>(
      `SELECT r.id, r.slug, d.slug AS division, d.id AS division_id
         FROM roles r JOIN divisions d ON d.id = r.division_id ORDER BY r.slug`)).rows,
    schedules: (await tx.query<{ id: string; enabled: boolean }>('SELECT id, enabled FROM schedules ORDER BY slug')).rows,
    grants: (await tx.query<{ division: string; capability: string }>(
      `SELECT d.slug AS division, g.capability_name AS capability
         FROM capability_grants g JOIN divisions d ON d.id = g.division_id ORDER BY 1, 2`)).rows,
  }));
  const was = await snapshot();
  const strategist = was.roles.find((role) => role.slug === 'strategist')!;
  // Work in flight when the new version arrives.
  const inFlight = await createRootTask({
    companyId, projectId: fixture.projectId, divisionId: strategist.division_id, roleId: strategist.id,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Weekly business review' }, createdBy: 'owner', reserveTokens: 1_000,
  });

  await publishBundle(COMPANY_OS);
  const upgraded = await installBundle({ companyId, slug: 'company-os', version: COMPANY_OS.version });
  assert.equal(upgraded.quarantined, false);
  assert.ok(upgraded.policies.includes('stage-move-needs-the-critic'));

  // Everything that was there is there, as the same rows.
  const now = await snapshot();
  for (const role of was.roles) {
    assert.ok(now.roles.some((one) => one.id === role.id && one.division_id === role.division_id), role.slug);
  }
  assert.deepEqual(now.schedules, was.schedules, 'the weekly review is the same schedule, still on');
  for (const grant of was.grants) {
    assert.ok(now.grants.some((one) => one.division === grant.division && one.capability === grant.capability),
      `${grant.division} still holds ${grant.capability}`);
  }
  const task = await withTenant(companyId, (tx) => tx.query<{ status: string; role_id: string }>(
    'SELECT status, role_id FROM tasks WHERE id = $1', [inFlight.id]));
  assert.deepEqual(task.rows[0], { status: 'pending', role_id: strategist.id });

  // And the critic, in a division of its own that holds reads and nothing else.
  const added = now.roles.filter((role) => !was.roles.some((one) => one.id === role.id));
  assert.deepEqual(added.map((role) => [role.slug, role.division]), [['critic', 'strategy-review']]);
  assert.deepEqual(now.grants.filter((grant) => grant.division === 'strategy-review').map((grant) => grant.capability),
    ['ledger.read', 'memory.search', 'metrics.read', 'skill.read']);
  const refused = await new HookPipeline().run('pre_tool', {
    companyId, divisionId: added[0]!.division_id, capability: 'doc.draft', tier: 1,
  });
  assert.equal(refused.refusedBy, 'strategy-review.read-only');
  const { rows: installs } = await withTenant(companyId, (tx) => tx.query<{ version: string; quarantined: boolean }>(
    "SELECT version, quarantined FROM bundle_installs WHERE slug = 'company-os'"));
  assert.deepEqual(installs, [{ version: COMPANY_OS.version, quarantined: false }]);
});

test("each of the kit's frameworks says what its eval asks for", () => {
  // An eval that asks for a sentence the skill does not contain could never
  // pass, and a skill whose eval cannot pass can never be activated (F15.4).
  for (const skill of COMPANY_OS.body.skills) {
    for (const evalCase of skill.evals) {
      for (const phrase of evalCase.expectContains) {
        assert.ok(skill.source.includes(phrase), `${skill.slug} does not say "${phrase}"`);
      }
    }
    assert.ok(skill.source.split('\n').length <= 60, `${skill.slug} is longer than a run should read`);
  }
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

test('a grant allowing calls in flight is a whole number from 1 to 100, refused with the bundle\'s name (F5.7)', async () => {
  for (const maxInFlight of [0, 1.5, 101]) {
    await assert.rejects(
      () => publishBundle({
        slug: 'too-many-at-once',
        version: '1.0.0',
        name: 'Too many at once',
        description: '',
        body: {
          divisions: [{ slug: 'x', name: 'X' }],
          roles: [],
          grants: [{ division: 'x', capability: 'crm.read', maxInFlight }],
          policies: [],
          skills: [],
          hooks: [],
          schedules: [],
        },
      }),
      (error: unknown) => isPalugadaError(error, 'bundle.invalid')
        && /allows .* calls in flight; it is a whole number from 1 to 100/.test((error as Error).message),
      String(maxInFlight),
    );
  }
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
  await trustPublisher({
    publicKeyPem: keys.publicKey,
    label: 'the test publisher',
    ownerApproved: true,
  });
  // qa-review first: it brings the reviewer content-ops's policy names.
  for (const bundle of [QA_REVIEW, CONTENT_OPS]) {
    await publishBundle(signBundle(bundle, keys));
    await installBundle({ companyId: fixture.companyId, slug: bundle.slug, version: bundle.version });
  }

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
      `SELECT s.slug, v.state FROM skills s JOIN skill_versions v ON v.skill_id = s.id ORDER BY s.slug`,
    );
    return rows;
  });
  assert.deepEqual(skills, [{ slug: 'reviewing', state: 'candidate' }, { slug: 'sourcing', state: 'candidate' }]);

  // An install points at a bundle in the platform's catalogue, which the
  // destination may not have, so it is reinstalled deliberately rather than
  // restored into a dangling reference.
  assert.ok(imported.skipped.includes('bundle_installs'));
});

/**
 * An archive is not a chain of custody.
 *
 * A skill that somebody un-quarantined on the instance the archive came from
 * was vouched for by a person this installation has never heard of. Inheriting
 * that judgement would make handing an owner an archive a way past the one
 * gate external knowledge has.
 */
test('an imported external skill re-enters quarantine (F16.4, F15.8)', async () => {
  const source = await createCompany('archive-source-skill');

  const imported = await importExternalSkill({
    companyId: source.companyId,
    slug: 'cold-outreach',
    source: `---\nname: cold-outreach\ndescription: From a hub.\n---\n\nSend three, then stop.\n`,
    origin: 'agentskills.io/cold-outreach',
    divisionId: source.divisionId,
  });

  // Vouched for on the source instance, which is the state the archive carries.
  await liftSkillQuarantine(source.companyId, imported.skillId, { ownerApproved: true });
  const lifted = await withTenant(source.companyId, async (tx) => {
    const { rows } = await tx.query<{ quarantined: boolean }>(
      'SELECT quarantined FROM skills WHERE id = $1',
      [imported.skillId],
    );
    return rows[0]!.quarantined;
  });
  assert.equal(lifted, false, 'the archive really does carry an un-quarantined skill');

  const restored = await importCompany(
    await archiveLines(source.companyId),
    { slug: `${source.slug}-elsewhere` },
  );

  const arrived = await withTenant(restored.companyId, async (tx) => {
    const { rows } = await tx.query<{ quarantined: boolean; provenance: string; origin: string }>(
      "SELECT quarantined, provenance, origin FROM skills WHERE slug = 'cold-outreach'",
    );
    return rows[0]!;
  });
  assert.equal(arrived.quarantined, true, 'the destination makes its own judgement');
  assert.equal(arrived.provenance, 'external');
  assert.equal(arrived.origin, 'agentskills.io/cold-outreach', 'and still knows where it came from');
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


/* ------------------------------------------------- self-signing (F16.2) --- */

/**
 * A signature verified against a key that arrived with it proves nothing.
 *
 * This is the hole the trusted-publisher list closes, and it was open: the
 * verifier was handed both the signature and the key, so anyone could generate
 * a keypair, sign their own bundle, and have it install unquarantined with
 * whatever grants it asked for — including `dns.update` at tier 2. The
 * quarantine F12.10 exists to impose was one `generateKeyPair` away from being
 * skipped.
 */
test('a self-signed bundle installs quarantined, not freely (F16.2, F12.10)', async () => {
  const fixture = await createCompany('bundle-self-signed');
  await registerStandardCatalogue();

  // A publisher nobody here has ever heard of, signing correctly.
  const stranger = publisher();
  const bundle = theirs(WEB_OPS);
  const published = await publishBundle(signBundle(bundle, stranger));
  assert.equal(published.signed, true, 'the signature does verify against its own key');
  assert.equal(published.trusted, false, 'and that is not the same as being trusted');

  const installed = await installBundle({
    companyId: fixture.companyId,
    slug: bundle.slug,
    version: bundle.version,
  });
  assert.equal(installed.quarantined, true);

  const grants = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ capability_name: string }>(
      `SELECT capability_name FROM capability_grants g
         JOIN divisions d ON d.id = g.division_id WHERE d.slug = 'web'`,
    );
    return rows.map((row) => row.capability_name);
  });
  assert.deepEqual(grants, [], 'a stranger\'s bundle reaches nothing');
});

/**
 * Trusting the publisher is what lifts it — and afterwards, without
 * republishing.
 *
 * That ordering matters: an owner who decides to trust a vendor should not
 * have to go back to the vendor for a new artefact, and a publish that baked
 * the trust decision in would require exactly that.
 */
test('trusting the publisher afterwards lets the next install through (F16.2)', async () => {
  const fixture = await createCompany('bundle-trust-later');
  await registerStandardCatalogue();

  const vendor = publisher();
  await publishBundle(signBundle(theirs(QA_REVIEW), vendor));

  const before = await installBundle({
    companyId: fixture.companyId,
    slug: 'their-qa-review',
    version: QA_REVIEW.version,
  });
  assert.equal(before.quarantined, true);

  await trustPublisher({
    publicKeyPem: vendor.publicKey,
    label: 'a vendor the owner checked',
    ownerApproved: true,
  });

  const after = await installBundle({
    companyId: fixture.companyId,
    slug: 'their-qa-review',
    version: QA_REVIEW.version,
  });
  assert.equal(after.quarantined, false, 'no republish was needed');
});

test('trusting a publisher is the owner\'s decision (F16.2)', async () => {
  const stranger = publisher();
  await assert.rejects(
    () =>
      trustPublisher({
        publicKeyPem: stranger.publicKey,
        label: 'someone',
        ownerApproved: false,
      }),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );

  // And a key that cannot be read is not a publisher.
  await assert.rejects(
    () => trustPublisher({ publicKeyPem: 'not a key', label: 'x', ownerApproved: true }),
    (error: unknown) => isPalugadaError(error, 'publisher.invalid_key'),
  );
});

/**
 * Trust is keyed on the fingerprint of the key, not on the text of its PEM.
 *
 * A list somebody could bypass by adding a trailing newline would be a list in
 * name only, so the fingerprint is taken over the DER encoding: every spelling
 * of one key that Node can parse gives one fingerprint.
 *
 * A spelling Node *cannot* parse gets no fingerprint and is refused. That is
 * the safe direction and worth pinning: the alternative — falling back to
 * hashing the raw text — would make an unparseable key trustable, which is a
 * key nothing could ever verify a signature with.
 */
test('one key has one fingerprint, however it is spelled (F16.2)', async () => {
  const keys = publisher();
  const fingerprint = await trustPublisher({
    publicKeyPem: keys.publicKey,
    label: 'canonical',
    ownerApproved: true,
  });

  assert.equal(keyFingerprint(`${keys.publicKey}\n\n`), fingerprint);
  assert.equal(keyFingerprint(keys.publicKey.trim()), fingerprint);
  assert.equal(await isTrustedPublisher(`${keys.publicKey}\n`), true);

  // Unreadable is not trusted, and is not an exception either.
  assert.equal(keyFingerprint('-----BEGIN PUBLIC KEY-----\nnonsense\n'), null);
  assert.equal(await isTrustedPublisher('not a key at all'), false);
  assert.equal(await isTrustedPublisher(null), false);
});

/** Revoking stops the next install without rewriting what is already there. */
test('revoking a publisher quarantines the next install (F16.2)', async () => {
  const fixture = await createCompany('bundle-revoked');
  await registerStandardCatalogue();

  const vendor = publisher();
  const fingerprint = await trustPublisher({
    publicKeyPem: vendor.publicKey,
    label: 'a vendor',
    ownerApproved: true,
  });
  await publishBundle(signBundle(theirs(QA_REVIEW), vendor));

  const trusted = await installBundle({
    companyId: fixture.companyId,
    slug: 'their-qa-review',
    version: QA_REVIEW.version,
  });
  assert.equal(trusted.quarantined, false);

  await revokePublisher(fingerprint);

  const other = await createCompany('bundle-after-revoke');
  const afterRevoke = await installBundle({
    companyId: other.companyId,
    slug: 'their-qa-review',
    version: QA_REVIEW.version,
  });
  assert.equal(afterRevoke.quarantined, true);

  // The earlier install is left alone: rewriting it would hide the window in
  // which the key was live, which is the first thing anybody investigating a
  // compromise would want to see.
  const untouched = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ quarantined: boolean }>(
      "SELECT quarantined FROM bundle_installs WHERE slug = 'their-qa-review'",
    );
    return rows[0]!.quarantined;
  });
  assert.equal(untouched, false);
});

/**
 * An unsigned bundle's skills say where they came from.
 *
 * F12.10 already refuses an unsigned or untrusted bundle any grant above tier
 * 0, and the install is marked quarantined. Its *skills* were not: they went in
 * through `proposeSkillVersion`, which defaults `provenance = 'internal'`, so a
 * document from a publisher this installation has never heard of arrived
 * indistinguishable from one the company wrote itself.
 *
 * The candidate gate meant it reached no context yet, which is why this was
 * survivable — but once a reviewer and the owner approved it, it would be live
 * with no origin on the record and no quarantine for anybody to lift, and
 * F15.8's caveat above the procedure would never print. The one gate external
 * knowledge has would have been skipped by arriving in a package.
 */
test('an unquarantined bundle\'s skills carry their origin (F15.8, F12.10)', async () => {
  const fixture = await createCompany('bundle-skill-origin');
  await registerStandardCatalogue();

  // Published with no signature, so the install quarantines.
  const bundle = theirs(QA_REVIEW);
  await publishBundle(bundle);
  const install = await installBundle({
    companyId: fixture.companyId,
    slug: bundle.slug,
    version: bundle.version,
  });
  assert.equal(install.quarantined, true, 'an unsigned bundle installs quarantined');

  const skill = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      provenance: string; origin: string | null; quarantined: boolean; scope_type: string;
    }>(
      "SELECT provenance, origin, quarantined, scope_type FROM skills WHERE slug = 'reviewing'",
    );
    return rows[0]!;
  });

  assert.equal(skill.provenance, 'external', 'it did not come from this company');
  assert.equal(skill.origin, `bundle:${bundle.slug}@${bundle.version}`);
  // Quarantine is a division-scope flag (0026). A wider skill cannot carry it
  // and does not need to: it is still a candidate, so F15.3 stands in the way.
  assert.equal(skill.quarantined, skill.scope_type === 'division');
});
