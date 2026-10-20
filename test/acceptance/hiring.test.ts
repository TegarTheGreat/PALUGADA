/**
 * The owner shapes the company (F2.9, F2.6, F2.8).
 *
 * A company's divisions, roles and projects came only from its template and
 * from bundles: the owner could change a role and could not hire one, could
 * not open a division, and could not start a project. Paperclip's owner hires
 * an agent from the board. These hold what hiring is here: the owner's
 * decision (F2.9 makes it tier 3), a role complete enough to be given work
 * the moment it exists (F2.8), no tool the platform does not have and never
 * more than twelve (F2.6), and a division that can read its own memory and
 * skills from its first run, as every template division can.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { history } from '../../src/governance/config-versions.ts';
import { addDivision, addProject, addRole } from '../../src/governance/structure.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const refused = (pattern: RegExp) => (error: unknown) =>
  isPalugadaError(error, 'contract.violation') && pattern.test((error as Error).message);

test('the owner hires a role that can be given work at once', async () => {
  const fixture = await createCompany('hire-role');
  await registerStandardCatalogue();
  await grantCapability(fixture, 'email.draft');
  await withControlPlane((tx) => tx.query("UPDATE roles SET runtime = 'claude-code', backend = 'docker' WHERE id = $1", [fixture.roleId]));
  const recruit = {
    divisionId: fixture.divisionId,
    slug: 'copywriter',
    systemPrompt: 'You write the words customers read: product pages and newsletters.',
    tools: ['email.draft', 'doc.draft'],
    doneCriteria: ['every claim about the product is one the product page makes'],
  };

  await assert.rejects(addRole(fixture.companyId, recruit, { ownerApproved: false }),
    (error: unknown) => isPalugadaError(error, 'approval.required'));
  const hired = await addRole(fixture.companyId, recruit, { ownerApproved: true });
  assert.deepEqual(hired.ungranted, ['doc.draft'], 'the owner is told which tools the division cannot use yet');

  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    slug: string; tools: string[]; done_criteria: string[]; runtime: string; output_schema: { required: string[] };
  }>('SELECT slug, tools, done_criteria, runtime, output_schema FROM roles WHERE id = $1', [hired.roleId]));
  assert.deepEqual(rows[0]!.tools, ['email.draft', 'doc.draft']);
  assert.equal(rows[0]!.runtime, 'claude-code', 'a hire runs where the company\'s other roles run');
  assert.deepEqual(rows[0]!.output_schema.required, ['summary']);

  // F2.8: complete enough to be given work.
  await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: hired.roleId, goalId: fixture.goalId, input: { goal: 'write the October newsletter' },
    createdBy: 'owner', budgetAccountId: fixture.budgetAccountId, reserveTokens: 1_000,
  });

  const versions = await history(fixture.companyId, 'role', hired.roleId);
  assert.equal(versions.length, 1);
  assert.match(versions[0]!.summary, /Hired/);
  const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { change: string; slug: string } }>(
    "SELECT payload FROM events WHERE type = 'structure.changed'"));
  assert.deepEqual(events.map((event) => [event.payload.change, event.payload.slug]), [['add_role', 'copywriter']]);
});

test('a hire can grant the tools its division lacks in the same approval, and never what cannot be undone', async () => {
  // The owner's complaint of 6 October ("capability tidak otomatis"): hiring a
  // role with its tools ended with "its division has no grant yet for ...; open
  // the division to grant them", one trip a tool. The owner who approves a hire
  // that names its tools has said what it may use; a grant of what can be taken
  // back is that, and a grant of what cannot is a decision of its own.
  const fixture = await createCompany('hire-grants');
  await registerStandardCatalogue();
  await grantCapability(fixture, 'email.draft', { tierOverride: 3 });
  const recruit = {
    divisionId: fixture.divisionId,
    slug: 'copywriter',
    systemPrompt: 'You write the words customers read.',
    tools: ['email.draft', 'doc.draft', 'email.send', 'funds.transfer'],
    doneCriteria: ['every claim is one the product page makes'],
  };

  const hired = await addRole(fixture.companyId, recruit, { ownerApproved: true, grantTools: true });
  assert.deepEqual(hired.granted, ['doc.draft', 'email.send'], 'what can be taken back is granted');
  assert.deepEqual(hired.ungranted, ['funds.transfer'], 'what cannot is left for a decision of its own');

  const { rows: grants } = await withTenant(fixture.companyId, (tx) => tx.query<{ capability_name: string; tier_override: number | null }>(
    'SELECT capability_name, tier_override FROM capability_grants WHERE division_id = $1 AND capability_name = ANY($2) ORDER BY capability_name',
    [fixture.divisionId, recruit.tools]));
  assert.deepEqual(grants.map((row) => [row.capability_name, row.tier_override]), [
    ['doc.draft', null], ['email.draft', 3], ['email.send', null],
  ], 'at the tier the platform gives it, and a grant already there is left as the owner made it');

  // Each grant is on the record like any other: a version to roll back and an event.
  const versions = await history(fixture.companyId, 'grant', fixture.divisionId);
  assert.deepEqual(versions.map((one) => one.summary).sort(), ['Change the grant for doc.draft', 'Change the grant for email.send']);
  const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { change: string; capability?: string } }>(
    "SELECT payload FROM events WHERE type = 'structure.changed'"));
  assert.deepEqual(events.filter((event) => event.payload.change === 'change_grant').map((event) => event.payload.capability).sort(), ['doc.draft', 'email.send']);

  // Without the word, nothing is granted: what the route did before.
  const plain = await addRole(fixture.companyId, { ...recruit, slug: 'copywriter-2', tools: ['doc.draft', 'files.read'] }, { ownerApproved: true });
  assert.deepEqual(plain.granted, []);
  assert.deepEqual(plain.ungranted, ['files.read'], 'doc.draft was granted by the first hire, so only the other is left');
});

test('the owner API grants with the hire only when asked, and says what it did', async () => {
  const fixture = await createCompany('hire-grants-api');
  await registerStandardCatalogue();
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const hire = (slug: string, grantTools?: boolean) => api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug, systemPrompt: 'You write.', doneCriteria: ['it reads well'],
      tools: ['doc.draft', 'funds.transfer'], proof: { totp: api.code() }, ...(grantTools === undefined ? {} : { grantTools }),
    });
    const plain = await hire('writer-a');
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.deepEqual([plain.body.granted, plain.body.ungranted], [[], ['doc.draft', 'funds.transfer']], 'as before when it is not asked');

    const granting = await hire('writer-b', true);
    assert.equal(granting.status, 200, JSON.stringify(granting.body));
    assert.deepEqual([granting.body.granted, granting.body.ungranted], [['doc.draft'], ['funds.transfer']]);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ capability_name: string }>(
      "SELECT capability_name FROM capability_grants WHERE capability_name IN ('doc.draft', 'funds.transfer')"));
    assert.deepEqual(rows.map((row) => row.capability_name), ['doc.draft'], 'and never the irreversible one');

    // A change to a role's tools is the same decision: the tools it now names.
    const role = granting.body.roleId as string;
    const change = (body: Record<string, unknown>) => api.call('POST', `/api/companies/${fixture.companyId}/roles/${role}`, token, { proof: { totp: api.code() }, ...body });
    const changed = await change({ tools: ['doc.draft', 'files.read'] });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.granted, undefined, 'not asked, not granted');
    const asked = await change({ tools: ['doc.draft', 'files.read', 'funds.transfer'], grantTools: true });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.deepEqual([asked.body.granted, asked.body.ungranted], [['files.read'], ['funds.transfer']]);
  } finally {
    await api.close();
  }
});

test('a hire is refused for what would make it unusable or unsafe', async () => {
  const fixture = await createCompany('hire-refused');
  const other = await createCompany('hire-other');
  await registerStandardCatalogue();
  const base = {
    divisionId: fixture.divisionId, slug: 'analyst-2', systemPrompt: 'You count things.', tools: [] as string[],
    doneCriteria: ['the answer is a number'],
  };
  const hire = (change: Partial<typeof base>) => addRole(fixture.companyId, { ...base, ...change }, { ownerApproved: true });

  await assert.rejects(hire({ slug: 'Bad Slug' }), refused(/lowercase/));
  await assert.rejects(hire({ systemPrompt: '  ' }), refused(/what the role is for/));
  await assert.rejects(hire({ doneCriteria: [] }), refused(/at least one done criterion/));
  await assert.rejects(hire({ tools: ['teleport'] }), refused(/no capability named teleport/));
  await assert.rejects(hire({ tools: Array.from({ length: 13 }, () => 'web.fetch') }), refused(/at most 12 tools/));
  await assert.rejects(hire({ divisionId: other.divisionId }), refused(/no such division in this company/));
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>('SELECT slug FROM roles'));
  await assert.rejects(hire({ slug: rows[0]!.slug }), refused(/already a role named/));
});

test('the owner opens a division that can read its own memory from its first run, and starts a project', async () => {
  const fixture = await createCompany('open-division');
  await registerStandardCatalogue();
  const sales = await addDivision(fixture.companyId, { slug: 'sales', name: 'Sales', maxConcurrency: 2 }, { ownerApproved: true });
  const inbound = await addDivision(fixture.companyId, { slug: 'inbound', name: 'Inbound', parentDivisionId: sales }, { ownerApproved: true });
  await assert.rejects(addDivision(fixture.companyId, { slug: 'x', name: 'X' }, { ownerApproved: false }),
    (error: unknown) => isPalugadaError(error, 'approval.required'));
  await assert.rejects(addDivision(fixture.companyId, { slug: 'deep', name: 'Deep', parentDivisionId: inbound }, { ownerApproved: true }),
    refused(/two levels/));
  await assert.rejects(addDivision(fixture.companyId, { slug: 'sales', name: 'Again' }, { ownerApproved: true }),
    refused(/already a division named sales/));

  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ capability_name: string }>(
    'SELECT capability_name FROM capability_grants WHERE division_id = $1 ORDER BY capability_name', [sales]));
  assert.deepEqual(rows.map((row) => row.capability_name), ['memory.search', 'metric.record', 'owner.ask', 'plan.record', 'skill.read']);

  const project = await addProject(fixture.companyId, { slug: 'wholesale', name: 'Wholesale' });
  await assert.rejects(addProject(fixture.companyId, { slug: 'wholesale', name: 'Again' }), refused(/already a project named wholesale/));
  await assert.rejects(addProject(fixture.companyId, { slug: 'Whole Sale', name: 'x' }), refused(/lowercase/));
  const { rows: projects } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; name: string }>(
    'SELECT id, name FROM projects WHERE slug = $1', ['wholesale']));
  assert.deepEqual(projects, [{ id: project, name: 'Wholesale' }]);
});
