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
import { installStandardTemplate, STANDARD_TEMPLATE_SLUG } from '../helpers/standard-team.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { buildContext } from '../../src/context/builder.ts';
import { Engine } from '../../src/engine/engine.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
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

async function standardCompany(slug: string) {
  const registry = await registerStandardCatalogue();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await installStandardTemplate();
  const company = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG, companySlug: slug, name: slug, timezone: 'Asia/Jakarta',
  });
  const start = async (role: string, division: string, goal: string) => {
    const task = await createRootTask({
      companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds[division]!,
      roleId: company.roleIds[role]!, goalId: company.goalIds.deliver!,
      input: { goal }, createdBy: 'owner', reserveTokens: 2_000,
    });
    await transition(company.companyId, task.id, 'running');
    return task;
  };
  return { registry, company, start };
}

test('a role that hands work on is told which roles there are to hand it to (N1)', async () => {
  // The live run of 2 October: the CEO was told to "decide which role's job
  // it is" and never told which roles the company has. It guessed nineteen
  // names -- "marketing", "cmo", "barista" -- and spent its division's tokens
  // on probes asking whether each one existed.
  const { registry, company, start } = await standardCompany('who-is-here');
  const route = await start('coordinator', 'ops', 'Make a seven-day Instagram plan for the new menu');
  const context = await withTenant(company.companyId, (tx) => buildContext(tx, {
    companyId: company.companyId, divisionId: company.divisionIds.ops!, taskId: route.id,
  }));
  const team = context.sections.find((section) => section.kind === 'team');
  assert.ok(team, 'the coordinator is told who it can hand work to');
  assert.match(team.body, /^- marketer: Laras, CMO, in Growth\. You find and keep demand\.$/m);
  const listed = [...team.body.matchAll(/^- ([a-z0-9-]+):/gm)].map((match) => match[1]);
  const others = Object.keys(company.roleIds).filter((slug) => slug !== 'coordinator').sort();
  assert.deepEqual([...listed].sort(), others, 'every other role, and not the coordinator itself');
  assert.match(team.body, /task\.delegate/, 'and how to name one');
  assert.ok(context.text.indexOf('## The roles you can hand work to') > context.text.indexOf('## Your role'),
    'read as part of the role, after its charter');

  // And the runtime is handed it: a runtime gets the pack's sections by kind,
  // and a kind it is not given never reaches the model.
  const handed: Array<Array<{ title: string; body: string }>> = [];
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'team-seen',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run(request) {
      handed.push(request.contextPack.notes);
      return { output: { summary: 'routed' } };
    },
  });
  await withTenant(company.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'team-seen', backend = 'local' WHERE slug = 'coordinator'"));
  const engine = new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'team-worker' });
  const handedOn = await createRootTask({
    companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds.ops!,
    roleId: company.roleIds.coordinator!, goalId: company.goalIds.deliver!,
    input: { goal: 'Plan the launch week' }, createdBy: 'owner', reserveTokens: 2_000,
  });
  await engine.runTask(company.companyId, handedOn.id, 'worker');
  const note = handed[0]?.find((item) => item.title === 'The roles you can hand work to');
  assert.ok(note, 'the runtime is handed the roles among its notes');
  assert.match(note.body, /^- marketer: Laras, CMO, in Growth\./m);

  // A role that cannot hand work on is not handed a list it cannot use.
  const write = await start('marketer', 'growth', 'Draft the restock note');
  const marketer = await withTenant(company.companyId, (tx) => buildContext(tx, {
    companyId: company.companyId, divisionId: company.divisionIds.growth!, taskId: write.id,
  }));
  assert.equal(marketer.sections.some((section) => section.kind === 'team'), false);

  // A frozen role is listed as one, so it is not chosen blind: handed work,
  // it refuses it, which is what the list says.
  await withTenant(company.companyId, (tx) => tx.query(
    "UPDATE roles SET frozen_at = now(), frozen_reason = 'test' WHERE slug = 'bookkeeper'"));
  const again = await withTenant(company.companyId, (tx) => buildContext(tx, {
    companyId: company.companyId, divisionId: company.divisionIds.ops!, taskId: route.id,
  }));
  assert.match(again.sections.find((section) => section.kind === 'team')!.body,
    /^- bookkeeper: Dimas, CFO, in Finance\. .*\(Frozen by the owner: it takes no work until they unfreeze it, so hand this to another role or say so\.\)$/m);
  await assert.rejects(new CapabilityBroker(registry).invoke({
    companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds.ops!,
    roleId: company.roleIds.coordinator!, taskId: route.id, idempotencyKey: 'to-the-frozen',
  }, 'task.delegate', { role: 'bookkeeper', brief: 'Pay the roaster.' }), /is frozen and cannot be given work/);
});

test('a delegation takes a role by its slug, title or name, and a name that is none of them is told the roles there are (N1)', async () => {
  const { registry, company, start } = await standardCompany('by-any-name');
  const broker = new CapabilityBroker(registry);
  const root = await start('coordinator', 'ops', 'Tell our customers the 1 kg bags are back');
  const delegate = (key: string, role: string, brief: string) => broker.invoke<unknown, { childId: string; role: string }>({
    companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds.ops!,
    roleId: company.roleIds.coordinator!, taskId: root.id, idempotencyKey: key,
  }, 'task.delegate', { role, brief });
  const roleOf = async (childId: string) => (await withTenant(company.companyId, (tx) => getTask(tx, childId)))!.roleId;

  const byTitle = await delegate('title', 'cmo', 'Draft the restock note.');
  assert.equal(await roleOf(byTitle.output.childId), company.roleIds.marketer, 'a title, in any case, names its one role');
  assert.equal(byTitle.output.role, 'marketer', 'and the answer says which slug that was');
  const byName = await delegate('name', 'Laras', 'Draft the follow-up note.');
  assert.equal(await roleOf(byName.output.childId), company.roleIds.marketer, 'so does a name');

  await assert.rejects(delegate('guess', 'marketing', 'Plan the week of posts.'), (error: Error) => {
    assert.match(error.message, /^no role "marketing" in this company; did you mean marketer \(Laras, CMO\)\?/);
    assert.match(error.message, /The roles are: .*bookkeeper \(Dimas, CFO\).*responder \(Nadia, Head of Support\)/);
    assert.doesNotMatch(error.message, /coordinator/, 'a role is not offered itself');
    return true;
  });
  await assert.rejects(delegate('nothing-near', 'barista', 'Make the coffee.'), (error: Error) => {
    assert.match(error.message, /^no role "barista" in this company\. The roles are: /, 'no guess when nothing is close');
    return true;
  });

  // Two roles with one title: the title names neither, and the answer says so.
  await withTenant(company.companyId, (tx) => tx.query("UPDATE roles SET title = 'Head of Growth' WHERE slug IN ('marketer', 'analyst')"));
  await assert.rejects(delegate('ambiguous', 'head of growth', 'Plan the week.'),
    /"head of growth" is the title or name of more than one role \(analyst, marketer\); name one by its slug/);
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
