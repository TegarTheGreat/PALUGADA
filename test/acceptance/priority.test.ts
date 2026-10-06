/**
 * An urgent task stays urgent (the audit of 6 October, S5).
 *
 * Priority has been in the claim path since F5.10 -- priority first, then age --
 * and nothing set it: `/assign` ignored the field, a ticket's priority was
 * dropped when it became a task, and a sub-task did not inherit its parent's,
 * so P0 work was P2 by the second hop and the urgent place could never
 * receive anything.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, createSubTask, getTask } from '../../src/engine/tasks.ts';
import { openTicket } from '../../src/engine/tickets.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const priorityOf = async (fixture: Fixture, id: string) => (await withTenant(fixture.companyId, (tx) => getTask(tx, id)))!.priority;

test('work the owner gives with a priority has it, and one that is out of range is refused', async () => {
  const fixture = await createCompany('priority-assign');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const give = (body: Record<string, unknown>) => api.call('POST', `/api/companies/${fixture.companyId}/assign`, owner, {
      projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, goalId: fixture.goalId, ...body,
    });
    const urgent = await give({ goal: 'The site is down', priority: 0 });
    assert.equal(urgent.status, 200, JSON.stringify(urgent.body));
    assert.equal(await priorityOf(fixture, urgent.body.taskId), 0);
    const ordinary = await give({ goal: 'Tidy the price list' });
    assert.equal(await priorityOf(fixture, ordinary.body.taskId), 2, 'unsaid, it is what almost everything is');
    const refused = await give({ goal: 'x', priority: 7 });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /priority is 0 \(first\) to 3 \(last\)/);

    // A ticket's priority is the task's when the owner gives it out.
    const filed = await withTenant(fixture.companyId, (tx) => openTicket(tx, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null, title: 'A customer cannot pay', body: '', priority: 1, openedBy: 'owner',
    }));
    const taken = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${filed.ticket.id}/assign`, owner, {
      roleId: fixture.roleId, goalId: fixture.goalId,
    });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(await priorityOf(fixture, taken.body.taskId), 1);
  } finally {
    await api.close();
  }
});

test('a sub-task is as urgent as its parent unless it is told otherwise', async () => {
  const fixture = await createCompany('priority-inherit');
  const parent = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'urgent' }, createdBy: 'owner', reserveTokens: 5_000, priority: 0,
  });
  const base = {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, reserveTokens: 500,
  };
  const inherits = await createSubTask(parent.id, { ...base, input: { goal: 'a part' } });
  assert.equal(await priorityOf(fixture, inherits.id), 0, 'the urgency is not lost at the first hop');
  const told = await createSubTask(parent.id, { ...base, input: { goal: 'a lesser part' }, priority: 3 });
  assert.equal(await priorityOf(fixture, told.id), 3, 'an explicit priority is the child\'s');
  const grand = await createSubTask(inherits.id, { ...base, input: { goal: 'a part of a part' } });
  assert.equal(await priorityOf(fixture, grand.id), 0, 'nor at the second');
});
