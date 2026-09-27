/**
 * Projects, and finding work in them (0074; src/governance/structure.ts,
 * src/owner/views.ts, src/context/builder.ts).
 *
 * Read against what an owner would expect of a project: it could be started
 * and nothing else -- not renamed, described or closed -- and nothing a run
 * was given said which project its work was for. Work showed the newest
 * hundred tasks with no way to narrow them or reach the hundred-and-first,
 * and a link to a task that was not among them opened nothing.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let made = 0;
function task(fixture: Fixture, extra: { projectId?: string; roleId?: string; goal?: string } = {}) {
  made += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: extra.projectId ?? fixture.projectId, divisionId: fixture.divisionId,
    roleId: extra.roleId ?? fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: extra.goal ?? `work ${made}` }, createdBy: 'owner', reserveTokens: 500,
  });
}

test('a project is renamed, described and archived; an archived one takes no new work; the last one stays open', async () => {
  const fixture = await createCompany('project-life');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const base = `/api/companies/${fixture.companyId}/projects`;
    const started = await api.call('POST', base, token, { slug: 'wholesale', name: 'Wholesale' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const projectId = started.body.projectId;

    const changed = await api.call('POST', `${base}/${projectId}`, token,
      { name: 'Wholesale to cafes', description: 'Sell beans by the kilo to cafes in Bandung and Jakarta.' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const structure = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    const shown = structure.projects.find((one: { id: string }) => one.id === projectId);
    assert.deepEqual([shown.name, shown.description, shown.archivedAt], ['Wholesale to cafes', 'Sell beans by the kilo to cafes in Bandung and Jakarta.', null]);

    await task(fixture, { projectId });
    assert.equal(structure.projects.find((one: { id: string }) => one.id === fixture.projectId).openTasks, 0);
    const counted = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body.projects
      .find((one: { id: string }) => one.id === projectId);
    assert.equal(counted.openTasks, 1, 'what is under way in it');

    const archived = await api.call('POST', `${base}/${projectId}`, token, { archived: true });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    await assert.rejects(() => task(fixture, { projectId }), /archived/, 'closed to new work');
    const reopened = await api.call('POST', `${base}/${projectId}`, token, { archived: false });
    assert.equal(reopened.status, 200);
    await task(fixture, { projectId });

    await api.call('POST', `${base}/${projectId}`, token, { archived: true });
    const last = await api.call('POST', `${base}/${fixture.projectId}`, token, { archived: true });
    assert.equal(last.status, 400, 'a company works in at least one project');
    assert.match(String(last.body.error), /at least one open project/);
  } finally {
    await api.close();
  }
});

test('Work narrows to a project, a role or a goal, pages past its first page, and opens a task it did not list', async () => {
  const fixture = await createCompany('work-filters');
  const otherRole = await addRole(fixture, 'bookkeeper');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const side = (await api.call('POST', `/api/companies/${fixture.companyId}/projects`, token, { slug: 'side', name: 'Side' })).body.projectId;
    const mine = [];
    for (let n = 0; n < 5; n += 1) mine.push(await task(fixture));
    const theirs = await task(fixture, { projectId: side, roleId: otherRole, goal: 'reconcile September' });

    const work = `/api/companies/${fixture.companyId}/work`;
    const bySide = (await api.call('GET', `${work}?project=${side}`, token)).body;
    assert.deepEqual(bySide.items.map((one: { id: string }) => one.id), [theirs.id]);
    assert.equal(bySide.items[0].projectName, 'Side');
    const byRole = (await api.call('GET', `${work}?role=${otherRole}`, token)).body;
    assert.deepEqual(byRole.items.map((one: { id: string }) => one.id), [theirs.id]);
    const byGoal = (await api.call('GET', `${work}?goal=${fixture.goalId}&limit=100`, token)).body;
    assert.equal(byGoal.items.length, 6);

    const seen: string[] = [];
    let before: string | null = null;
    do {
      const page: { items: Array<{ id: string }>; next: string | null } =
        (await api.call('GET', `${work}?project=${fixture.projectId}&limit=2${before ? `&before=${before}` : ''}`, token)).body;
      seen.push(...page.items.map((one) => one.id));
      before = page.next;
    } while (before);
    assert.deepEqual(seen.sort(), mine.map((one) => one.id).sort(), 'every task on exactly one page');

    const one = await api.call('GET', `/api/companies/${fixture.companyId}/tasks/${mine[0]!.id}`, token);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.item.id, mine[0]!.id);
    assert.equal(one.body.item.projectName, 'Main', 'as Work lists it');
    const none = await api.call('GET', `/api/companies/${fixture.companyId}/tasks/11111111-1111-1111-1111-111111111111`, token);
    assert.equal(none.status, 400);
  } finally {
    await api.close();
  }
});

test('a run is told which project its work belongs to, and what the project is for', async () => {
  const fixture = await createCompany('project-context');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE projects SET name = 'Wholesale', description = 'Sell beans by the kilo to cafes.' WHERE id = $1", [fixture.projectId]));
  const work = await task(fixture);
  const pack = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: work.id }));
  const project = pack.sections.find((section) => section.kind === 'project');
  assert.ok(project);
  assert.match(project!.body, /Wholesale/);
  assert.match(project!.body, /Sell beans by the kilo to cafes\./);
});
