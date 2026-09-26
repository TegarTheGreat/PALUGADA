/**
 * The company runs between the owner's decisions (F2.1, F2.5, F6.4).
 *
 * The structure was right and it stood still. A new company waited for the
 * owner to pick a role for every piece of work, because no role in the
 * standard company could hand anything on -- the coordinator's charter said
 * "hand it off" and it held no way to. And a division's escalation role was
 * named in the message the owner read, "ops-lead was asked first and has had
 * 45 minutes", and was never asked: the grace period was a delay with nobody
 * in it. These hold the company to what it tells the owner it does.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { setEscalationPolicy } from '../../src/governance/structure.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { handEscalations } from '../../src/inbox/inbox.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { createCompanyFromTemplate } from '../../src/templates/company.ts';
import { installStandardTemplate, STANDARD_TEMPLATE_SLUG } from '../../src/templates/standard.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { addRole, createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const itemOf = async (companyId: string, id: string) => (await withTenant(companyId, (tx) => tx.query<{
  rationale: string; notify_after: Date; payload: Record<string, unknown>;
}>('SELECT rationale, notify_after, payload FROM inbox_items WHERE id = $1', [id]))).rows[0]!;

test('an escalation is handed to the role its division names, once, and the owner reads what it did', async () => {
  const fixture = await createCompany('escalation-handed');
  const leadId = await addRole(fixture, 'ops-lead');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'ops-lead', afterMinutes: 30 });
  const stuck = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'renew the domain' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  const itemId = await inbox.raiseEscalation({
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: stuck.id,
    title: 'The registrar will not answer', detail: 'Three attempts, all timed out.',
  });

  assert.equal(await handEscalations(fixture.companyId), 1);
  assert.equal(await handEscalations(fixture.companyId), 0, 'handed once, however often the worker looks');

  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    id: string; input: { goal: string; context: string }; goal_id: string; project_id: string; division_id: string; created_by: string;
  }>('SELECT id, input, goal_id, project_id, division_id, created_by FROM tasks WHERE role_id = $1', [leadId]));
  assert.equal(rows.length, 1);
  const handed = rows[0]!;
  assert.match(handed.input.goal, /The registrar will not answer/);
  assert.match(handed.input.context, /Three attempts, all timed out/);
  assert.match(handed.input.context, /30 minutes/, 'the role is told how long it has before the owner is');
  assert.deepEqual([handed.goal_id, handed.project_id, handed.division_id], [fixture.goalId, fixture.projectId, fixture.divisionId],
    'it serves the goal the stuck work served');
  assert.equal((await itemOf(fixture.companyId, itemId)).payload.handedTaskId, handed.id);

  // The lead finishes: what it did is on the item the owner will read.
  await transition(fixture.companyId, handed.id, 'running');
  await transition(fixture.companyId, handed.id, 'completed', {
    output: { summary: 'Called the registrar; the renewal goes through tomorrow.' },
  });
  await handEscalations(fixture.companyId);
  await handEscalations(fixture.companyId);
  const item = await itemOf(fixture.companyId, itemId);
  const notes = item.rationale.match(/ops-lead: /g) ?? [];
  assert.equal(notes.length, 1, item.rationale);
  assert.match(item.rationale, /ops-lead: Called the registrar; the renewal goes through tomorrow\./);
  assert.equal(item.payload.handledOutcome, 'completed');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, stuck.id)))!.status, 'pending',
    'the stuck task is the owner\'s to decide about, not the lead\'s to close');
});

test('an escalation role that is not in the company sends the escalation to the owner at once', async () => {
  const fixture = await createCompany('escalation-nobody');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'nobody-here', afterMinutes: 240 });
  const itemId = await inbox.raiseEscalation({
    companyId: fixture.companyId, divisionId: fixture.divisionId,
    title: 'Nobody can take this', detail: 'The named role does not exist.',
  });
  assert.ok((await itemOf(fixture.companyId, itemId)).notify_after.getTime() > Date.now() + 200 * 60_000);

  assert.equal(await handEscalations(fixture.companyId), 0);
  const item = await itemOf(fixture.companyId, itemId);
  assert.ok(item.notify_after.getTime() <= Date.now(), 'four hours for nobody is not a grace period');
  assert.match(item.rationale, /nobody-here is not a role in this company, so this came to you at once/);
  assert.doesNotMatch(item.rationale, /was asked first/, 'the owner is not told somebody was asked who was not');
});

test('the standard company hands work on: the coordinator routes, the planner hands the build over, divisions escalate to the coordinator', async () => {
  const registry = await registerStandardCatalogue();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await installStandardTemplate();
  const company = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG, companySlug: 'runs-itself', name: 'Runs Itself', timezone: 'Asia/Jakarta',
  });

  const roles = await withTenant(company.companyId, (tx) => tx.query<{ slug: string; tools: string[]; system_prompt: string }>(
    'SELECT slug, tools, system_prompt FROM roles'));
  const bySlug = new Map(roles.rows.map((row) => [row.slug, row]));
  for (const slug of ['coordinator', 'planner']) {
    const role = bySlug.get(slug)!;
    assert.ok(role.tools.includes('task.delegate') && role.tools.includes('task.await'), `${slug} can hand work on`);
    assert.ok(role.tools.length <= 12, `${slug} holds ${role.tools.length} tools (F2.4)`);
    assert.match(role.system_prompt, /task\.delegate/, `${slug} is told how, not only that it should`);
  }

  // F2.1: every division but the coordinator's own asks the coordinator first.
  const divisions = await withTenant(company.companyId, (tx) => tx.query<{ slug: string; escalation_role_slug: string | null; escalate_after_minutes: number | null }>(
    'SELECT slug, escalation_role_slug, escalate_after_minutes FROM divisions ORDER BY slug'));
  for (const division of divisions.rows) {
    if (division.slug === 'ops') assert.equal(division.escalation_role_slug, null, 'the coordinator\'s own division goes to the owner');
    else assert.deepEqual([division.slug, division.escalation_role_slug, division.escalate_after_minutes], [division.slug, 'coordinator', 60]);
  }

  // Through the broker, as a run would: the grant and the tool are both there.
  const broker = new CapabilityBroker(registry);
  const root = await createRootTask({
    companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds.ops!,
    roleId: company.roleIds.coordinator!, goalId: company.goalIds.deliver!,
    input: { goal: 'Tell our customers the 1 kg bags are back' }, createdBy: 'owner', reserveTokens: 2_000,
  });
  await transition(company.companyId, root.id, 'running');
  const { output: delegated } = await broker.invoke<unknown, { childId: string }>({
    companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds.ops!,
    roleId: company.roleIds.coordinator!, taskId: root.id, idempotencyKey: 'route-1',
  }, 'task.delegate', { role: 'marketer', brief: 'Draft and send the restock note to the customer list.' });
  const child = (await withTenant(company.companyId, (tx) => getTask(tx, delegated.childId)))!;
  assert.deepEqual([child.roleId, child.divisionId, child.parentTaskId], [company.roleIds.marketer, company.divisionIds.growth, root.id]);
});

test('escalations already handled do not crowd out a new one', async () => {
  // The worker looks at a page of open escalations at a time. One that was
  // handed and answered stays open -- it is the owner's to decide -- so if a
  // pass kept reading those, fifty of them would hide every new one behind
  // them, and the newest problem would never reach anybody.
  const fixture = await createCompany('escalation-crowd');
  const leadId = await addRole(fixture, 'ops-lead');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'ops-lead', afterMinutes: 30 });
  for (let n = 0; n < 51; n += 1) {
    await inbox.raiseEscalation({ companyId: fixture.companyId, divisionId: fixture.divisionId, title: `Old problem ${n}`, detail: 'x' });
  }
  while (await handEscalations(fixture.companyId) > 0) { /* a page at a time */ }
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    'SELECT id FROM tasks WHERE role_id = $1 ORDER BY created_at', [leadId]));
  assert.equal(rows.length, 51);
  const finish = async (id: string) => {
    await transition(fixture.companyId, id, 'running');
    await transition(fixture.companyId, id, 'completed', { output: { summary: 'looked' } });
  };
  const noted = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM inbox_items WHERE payload ? 'handledOutcome'"))).rows[0]!.n;

  // The newest is answered while fifty older ones are still being worked on:
  // its answer reaches the owner anyway.
  await finish(rows[50]!.id);
  await handEscalations(fixture.companyId);
  assert.equal(await noted(), 1);

  // All of them answered: every one is noted, a page at a time.
  for (const task of rows.slice(0, 50)) await finish(task.id);
  await handEscalations(fixture.companyId);
  await handEscalations(fixture.companyId);
  assert.equal(await noted(), 51);

  await inbox.raiseEscalation({ companyId: fixture.companyId, divisionId: fixture.divisionId, title: 'A new problem', detail: 'y' });
  assert.equal(await handEscalations(fixture.companyId), 1, 'the new one is handed');

  // And answered, its answer is not hidden behind the fifty-one already noted.
  const { rows: newest } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    'SELECT id FROM tasks WHERE role_id = $1 ORDER BY created_at DESC LIMIT 1', [leadId]));
  await finish(newest[0]!.id);
  await handEscalations(fixture.companyId);
  assert.equal(await noted(), 52);
});
