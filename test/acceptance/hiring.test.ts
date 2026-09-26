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
