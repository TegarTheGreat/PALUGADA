/**
 * Every view a role appears in carries its name (the analysis of 3 October,
 * §2.3 items 7 and 10).
 *
 * The owner gives each role a name and a title -- "Sari, Head of Data" --
 * and the console still showed "analyst": the work list, a task, the
 * schedules, the triggers, the frozen roles, the standing approvals and the
 * trace were handed only the role's short name, the platform's code for it.
 * Each now carries the name beside the code, and the console shows the name
 * (documents/console-role-names.test.ts). The money page listed every
 * company by its short name too.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { upsertSchedule } from '../../src/scheduler/scheduler.ts';
import { createTrigger } from '../../src/scheduler/triggers.ts';
import { createHandoffRule } from '../../src/engine/handoff-rules.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { addRole, createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('the work, schedules, triggers, handoffs, reviews, standing approvals, frozen roles and trace name the role', async () => {
  const fixture = await createCompany('role-names');
  const { companyId } = fixture;
  await withControlPlane((tx) => tx.query(
    "UPDATE roles SET display_name = 'Sari' WHERE id = $1", [fixture.roleId]));
  const { rows: [names] } = await withControlPlane((tx) => tx.query<{ role: string; company: string }>(
    'SELECT r.slug AS role, c.name AS company FROM roles r JOIN companies c ON c.id = r.company_id WHERE r.id = $1', [fixture.roleId]));

  const task = await createRootTask({
    companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Count last week\'s orders' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(companyId, task.id, 'running');
  await withTenant(companyId, (tx) => tx.query(
    `INSERT INTO agent_runs (company_id, task_id, role_id, attempt, status, finished_at)
     VALUES ($1, $2, $3, 0, 'succeeded', now())`, [companyId, task.id, fixture.roleId]));
  await upsertSchedule({
    companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'monday-numbers', cronExpression: '0 8 * * 1', timezone: 'Asia/Jakarta', input: { goal: 'The week\'s numbers.' },
  });
  await createTrigger(companyId, { slug: 'new-orders', roleId: fixture.roleId, goalId: fixture.goalId, instruction: 'Log each order.' });
  const item = await inbox.raiseIncident({ companyId, title: 'A test incident', detail: 'Nothing happened.' });
  const reviewer = await addRole(fixture, 'reviewer');
  await withControlPlane((tx) => tx.query("UPDATE roles SET display_name = 'Raka' WHERE id = $1", [reviewer]));
  await createHandoffRule(companyId, { fromRoleId: fixture.roleId, toRoleId: reviewer, brief: 'Check the count.' });
  const review = await createRootTask({
    companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: reviewer,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Review the count' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  await withTenant(companyId, (tx) => tx.query(
    `INSERT INTO review_requests (company_id, project_id, proposer_task_id, proposer_role_id, reviewer_role_id,
                                  review_task_id, capability_name, action_fingerprint, proposal, criteria)
     VALUES ($1, $2, $3, $4, $5, $6, 'email.send', 'fingerprint', '{}', 'Is it right?')`,
    [companyId, fixture.projectId, task.id, fixture.roleId, reviewer, review.id]));
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO standing_approvals (company_id, role_id, capability_name, granted_by_item, expires_at)
       VALUES ($1, $2, 'email.send', $3, now() + interval '1 day')`, [companyId, fixture.roleId, item]);
    await tx.query("UPDATE roles SET frozen_at = now(), frozen_reason = 'Repeatedly denied' WHERE id = $1", [fixture.roleId]);
  });

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const get = async (path: string) => {
      const answer = await api.call('GET', path, token);
      assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
      return answer.body;
    };

    const work = await get(`/api/companies/${companyId}/work`);
    const listed = (work.items as Array<{ id: string; roleSlug: string; roleName: string | null }>).find((one) => one.id === task.id)!;
    assert.deepEqual([listed.roleSlug, listed.roleName], [names!.role, 'Sari'], 'the work list');

    const schedules = (await get(`/api/companies/${companyId}/schedules`)).schedules as Array<{ roleName: string | null }>;
    assert.deepEqual(schedules.map((one) => one.roleName), ['Sari'], 'the schedules');

    const triggers = (await get(`/api/companies/${companyId}/triggers`)).triggers as Array<{ roleName: string | null }>;
    assert.deepEqual(triggers.map((one) => one.roleName), ['Sari'], 'the triggers');

    const standing = (await get(`/api/companies/${companyId}/standing-approvals`)).standing as Array<{ roleName: string | null }>;
    assert.deepEqual(standing.map((one) => one.roleName), ['Sari'], 'the standing approvals');

    const frozen = (await get(`/api/control?companyId=${companyId}`)).frozenRoles as Array<{ displayName: string | null }>;
    assert.deepEqual(frozen.map((one) => one.displayName), ['Sari'], 'the frozen roles');

    const trace = await get(`/api/companies/${companyId}/tasks/${task.id}/trace`);
    assert.deepEqual((trace.runs as Array<{ roleName: string | null }>).map((one) => one.roleName), ['Sari'], 'the trace');

    const handoffs = (await get(`/api/companies/${companyId}/handoffs`)).handoffs as Array<{ fromRoleName: string | null; toRoleName: string | null }>;
    assert.deepEqual(handoffs.map((one) => [one.fromRoleName, one.toRoleName]), [['Sari', 'Raka']], 'the handoffs');

    const reviews = (await get(`/api/companies/${companyId}/reviews`)).reviews as Array<{ reviewerRoleName: string | null }>;
    assert.deepEqual(reviews.map((one) => one.reviewerRoleName), ['Raka'], 'the reviews waiting');

    const cost = (await get('/api/control/cost')).companies as Array<{ companyId: string; name: string }>;
    assert.equal(cost.find((one) => one.companyId === companyId)!.name, names!.company, 'a company by its name');
  } finally {
    await api.close();
  }
});
