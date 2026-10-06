/**
 * Work that ends badly is not silent, and the owner is not the first to hear
 * (the audit of 3 October, section 3.1; the owner's complaint of 6 October:
 * "bentar bentar gagal, bentar bentar tidak dikerjakan ... saya sendiri harus
 * kerja dan mantau semuanya").
 *
 * Only budget, a failed read-back, a crash loop and a model that stayed down
 * raised anything when a task halted; a hop limit, a policy refusal, a
 * deadline, an exhausted retry or a run that said "not done" ended in
 * silence, for the owner to find on the Work page. A root task that ends
 * badly and has nobody told about it now raises one escalation, to the
 * coordinator its division names first (F2.1) and to the owner after its
 * grace -- once per task, once per cause under a goal while one is open, and
 * never for work the coordinator was itself handed.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
import { ENDED_AFTER_MS, reportEndedBadly } from '../../src/engine/ended.ts';
import { setEscalationPolicy } from '../../src/governance/structure.ts';
import { handEscalations } from '../../src/inbox/inbox.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const later = () => new Date(Date.now() + ENDED_AFTER_MS + 60_000);

async function root(fixture: Fixture, goal: string, key?: string) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
    ...(key ? { idempotencyKey: key } : {}),
  });
  await transition(fixture.companyId, task.id, 'running');
  return task;
}

const halt = (fixture: Fixture, id: string, haltReason: 'policy_denied' | 'hop_limit' | 'deadline_passed', detail = 'it was refused') =>
  transition(fixture.companyId, id, 'halted', { haltReason, detail });

const escalations = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{
  id: string; task_id: string | null; title: string; rationale: string; status: string; payload: Record<string, unknown>;
}>("SELECT id, task_id, title, rationale, status, payload FROM inbox_items WHERE kind = 'escalation' ORDER BY created_at")).then((result) => result.rows);

test('a root task that halts with nothing raised is reported once, to the coordinator first', async () => {
  const fixture = await createCompany('ended-reported');
  const leadId = await addRole(fixture, 'coordinator');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'coordinator', afterMinutes: 60 });
  const task = await root(fixture, 'send the invoices');
  await halt(fixture, task.id, 'policy_denied', 'finance.pay was refused by a policy');

  // Not yet: the halt's own handler may be raising its card this very moment.
  assert.equal(await reportEndedBadly(fixture.companyId), 0, 'a minute is given for the specific card to come first');
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 1);
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 0, 'once, however often the worker looks');

  const [item, ...rest] = await escalations(fixture);
  assert.equal(rest.length, 0);
  assert.equal(item!.task_id, task.id);
  assert.match(item!.title, /A task ended before it was done: send the invoices/);
  assert.match(item!.rationale, /It ended as: Refused by a policy/);
  assert.match(item!.rationale, /finance\.pay was refused by a policy/, 'what the platform said, as it said it');
  assert.equal(item!.payload.escalationRole, 'coordinator', 'the coordinator was asked first');

  // And it is handed over: the coordinator has a task carrying it.
  assert.equal(await handEscalations(fixture.companyId), 1);
  const handed = await withTenant(fixture.companyId, (tx) => tx.query<{ goal: string }>("SELECT input->>'goal' AS goal FROM tasks WHERE role_id = $1", [leadId]));
  assert.match(handed.rows[0]!.goal, /Escalated to you: A task ended before it was done/);
});

test('what already told the owner, a task under another, a cancellation, or one in its first minute is not reported', async () => {
  const fixture = await createCompany('ended-skipped');
  // The budget halt's own card.
  const told = await root(fixture, 'already told');
  await halt(fixture, told.id, 'deadline_passed');
  await inbox.raiseIncident({ companyId: fixture.companyId, taskId: told.id, title: 'It was told', detail: 'with its own card' });
  // A task under another is its parent's to hear about.
  const parent = await root(fixture, 'the parent');
  const child = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'the child' }, reserveTokens: 100,
  });
  await transition(fixture.companyId, child.id, 'running');
  await halt(fixture, child.id, 'hop_limit');
  // The owner's own stop.
  const stopped = await root(fixture, 'stopped');
  await transition(fixture.companyId, stopped.id, 'cancelled', { haltReason: 'owner_stop' });
  // Finished is not ended badly.
  const done = await root(fixture, 'done');
  await transition(fixture.companyId, done.id, 'completed', { output: { summary: 'ok' } });

  assert.equal(await reportEndedBadly(fixture.companyId, later()), 0);
  assert.equal((await escalations(fixture)).length, 0);
});

test('one cause under one goal is one card while it is open; another cause is another card', async () => {
  const fixture = await createCompany('ended-grouped');
  const first = await root(fixture, 'first');
  const second = await root(fixture, 'second');
  const third = await root(fixture, 'third');
  await halt(fixture, first.id, 'hop_limit');
  await halt(fixture, second.id, 'hop_limit');
  await halt(fixture, third.id, 'deadline_passed');

  assert.equal(await reportEndedBadly(fixture.companyId, later()), 2, 'two cards for three tasks');
  const items = await escalations(fixture);
  assert.equal(items.length, 2);
  const hop = items.find((item) => item.task_id === first.id)!;
  assert.deepEqual(hop.payload.endedTaskIds, [first.id, second.id], 'the second is on the first\'s card');
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 0, 'and is not found again');
});

test('work the coordinator was handed that ends badly goes to the owner, not back to the coordinator', async () => {
  const fixture = await createCompany('ended-loop');
  await addRole(fixture, 'coordinator');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'coordinator', afterMinutes: 60 });
  const handed = await root(fixture, 'Escalated to you: something', 'escalation:0f0f0f0f-0000-4000-8000-000000000000');
  await halt(fixture, handed.id, 'hop_limit');

  assert.equal(await reportEndedBadly(fixture.companyId, later()), 1);
  const [item] = await escalations(fixture);
  assert.equal(item!.payload.escalationRole, undefined, 'nobody above to ask: the owner hears at once');
  assert.equal(await handEscalations(fixture.companyId), 0, 'and nothing is handed back round');
});

test('what the coordinator handled and finished is closed for the owner; what it could not stays open', async () => {
  const fixture = await createCompany('ended-handled');
  const leadId = await addRole(fixture, 'coordinator');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, { roleSlug: 'coordinator', afterMinutes: 60 });
  const fixed = await root(fixture, 'send the newsletter');
  const unfixed = await root(fixture, 'renew the certificate');
  await halt(fixture, fixed.id, 'policy_denied');
  await halt(fixture, unfixed.id, 'deadline_passed');
  await reportEndedBadly(fixture.companyId, later());
  assert.equal(await handEscalations(fixture.companyId), 2);

  const tasks = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; goal: string }>(
    "SELECT id, input->>'goal' AS goal FROM tasks WHERE role_id = $1 ORDER BY created_at", [leadId]));
  const handling = (title: string) => tasks.rows.find((row) => row.goal.includes(title))!.id;
  const finish = async (id: string, status: 'completed' | 'failed', output: Record<string, unknown>) => {
    await transition(fixture.companyId, id, 'running');
    await transition(fixture.companyId, id, status, status === 'completed' ? { output } : { haltReason: 'not_done', detail: 'could not' });
  };
  await finish(handling('send the newsletter'), 'completed', { summary: 'Sent it from the other account; it went out.' });
  await finish(handling('renew the certificate'), 'failed', {});
  await handEscalations(fixture.companyId);

  const items = await escalations(fixture);
  const byTask = (id: string) => items.find((item) => item.task_id === id)!;
  assert.equal(byTask(fixed.id).status, 'withdrawn', 'handled: not the owner\'s to answer');
  assert.match(byTask(fixed.id).rationale, /Sent it from the other account/, 'with what was done, kept on the card');
  assert.equal(byTask(unfixed.id).status, 'open', 'not handled: the owner is told');
});
