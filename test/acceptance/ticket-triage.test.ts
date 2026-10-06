/**
 * Tickets the company owes are the CEO's to hand on, without being asked (the
 * audit of 3 October, section 3.1: "filing a ticket wakes nothing"; the owner's
 * complaint of 6 October: "masa CEO kerjanya cuma jawab doang").
 *
 * A role files a ticket when something needs doing that is not its job, and
 * the module's own comment says the CEO's run hands it on. Nothing ever
 * started that run, so tickets sat open until the owner opened a chat and
 * said so. Now one triage task for the CEO is made when tickets are owed, no
 * more than one at a time and one every ten minutes, each ticket once until it
 * changes, and nothing at all -- no task, no tokens -- when none is.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { openTicket, startTicket } from '../../src/engine/tickets.ts';
import { ensureTriage, TRIAGE_EVERY_MS } from '../../src/engine/triage.ts';
import { reportEndedBadly } from '../../src/engine/ended.ts';
import { Worker } from '../../src/worker.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A company whose CEO is its fixture role. */
async function withCeo(name: string) {
  const fixture = await createCompany(name);
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET title = 'CEO' WHERE id = $1", [fixture.roleId]));
  return { fixture, ceoId: fixture.roleId };
}

async function file(fixture: Fixture, title: string, openedBy: 'agent' | 'owner' = 'agent') {
  // A ticket an agent filed names the run that filed it.
  const filer = openedBy === 'agent'
    ? await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `noticed: ${title}` }, createdBy: 'owner', reserveTokens: 100,
    })
    : null;
  return withTenant(fixture.companyId, (tx) => openTicket(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title, openedBy,
    openedByTaskId: filer?.id ?? null,
  }));
}

const triageTasks = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{
  id: string; role_id: string; status: string; input: { goal: string; context: string; ticketIds: string[] };
}>("SELECT id, role_id, status, input FROM tasks WHERE idempotency_key LIKE 'triage:%' ORDER BY created_at")).then((result) => result.rows);

const after_ = (ms: number) => new Date(Date.now() + ms);

test('open tickets start one triage task for the CEO, once, and nothing starts when none is owed', async () => {
  const { fixture, ceoId } = await withCeo('triage-basic');
  assert.equal(await ensureTriage(fixture.companyId), null, 'nothing owed, nothing started');

  const first = (await file(fixture, 'Customer asked for a refund on order 41')).ticket;
  const second = (await file(fixture, 'Landing page copy has a typo', 'owner')).ticket;
  const taskId = await ensureTriage(fixture.companyId);
  assert.ok(taskId);
  assert.equal(await ensureTriage(fixture.companyId), null, 'one at a time');

  const [task, ...rest] = await triageTasks(fixture);
  assert.equal(rest.length, 0);
  assert.equal(task!.role_id, ceoId);
  assert.deepEqual([...task!.input.ticketIds].sort(), [first.id, second.id].sort());
  assert.match(task!.input.goal, /ticket/i);
  assert.match(task!.input.context, /Customer asked for a refund on order 41/);
  assert.match(task!.input.context, /Landing page copy has a typo/);

  // A ticket an agent filed may hold a customer's words: the run carries them.
  const outside = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM events WHERE task_id = $1 AND type = 'content.read_outside'", [task!.id]));
  assert.equal(outside.rows.length, 1);
});

test('each ticket is triaged once until it changes, and not more often than every ten minutes', async () => {
  const { fixture } = await withCeo('triage-once');
  const { ticket } = await file(fixture, 'Renew the certificate');
  const taskId = (await ensureTriage(fixture.companyId))!;
  await transition(fixture.companyId, taskId, 'running');
  await transition(fixture.companyId, taskId, 'completed', { output: { summary: 'nobody can do it yet' } });

  // Finished, and the ticket is as it was: the CEO has seen it.
  assert.equal(await ensureTriage(fixture.companyId, after_(TRIAGE_EVERY_MS + 60_000)), null);

  // A new one inside ten minutes waits; after them, it is triaged -- alone, not with the old.
  const fresh = (await file(fixture, 'Invoice 88 is unpaid')).ticket;
  assert.equal(await ensureTriage(fixture.companyId, after_(60_000)), null, 'ten minutes between triages');
  assert.ok(await ensureTriage(fixture.companyId, after_(TRIAGE_EVERY_MS + 60_000)));
  const tasks = await triageTasks(fixture);
  assert.deepEqual(tasks.at(-1)!.input.ticketIds, [fresh.id]);

  // And the old one, changed, is owed again.
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE tickets SET priority = 0, updated_at = now() + interval '1 hour' WHERE id = $1", [ticket.id]));
  const last = tasks.at(-1)!.id;
  await transition(fixture.companyId, last, 'running');
  await transition(fixture.companyId, last, 'completed', { output: { summary: 'done' } });
  assert.ok(await ensureTriage(fixture.companyId, after_(2 * TRIAGE_EVERY_MS + 2 * 3_600_000)));
});

test('a ticket being worked, and a company winding down, start no triage', async () => {
  const { fixture } = await withCeo('triage-skips');
  const { ticket } = await file(fixture, 'Already given out');
  const worker = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO tasks (company_id, project_id, division_id, role_id, budget_account_id, input, idempotency_key, input_hash, created_by, goal_id)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'k-worked','h','owner',$6) RETURNING id`,
    [fixture.companyId, fixture.projectId, fixture.divisionId, fixture.roleId, fixture.budgetAccountId, fixture.goalId])).rows[0]!.id);
  await withTenant(fixture.companyId, (tx) => startTicket(tx, fixture.companyId, ticket.id, worker));
  assert.equal(await ensureTriage(fixture.companyId), null, 'in progress: somebody has it');

  const { fixture: closing } = await withCeo('triage-winding-down');
  await file(closing, 'Anything');
  await withControlPlane((tx) => tx.query("UPDATE companies SET stage = 'wind_down' WHERE id = $1", [closing.companyId]));
  assert.equal(await ensureTriage(closing.companyId), null, 'winding down starts nothing new');
});

test('a worker\'s tick makes the triage task and finds what ended badly', async () => {
  const { fixture } = await withCeo('triage-tick');
  await file(fixture, 'Reply to the supplier');
  // A root task that halted a while ago with nothing raised for it.
  const stuck = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'ship the release' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, stuck.id, 'running');
  await transition(fixture.companyId, stuck.id, 'halted', { haltReason: 'hop_limit', detail: 'too deep' });

  const worker = new Worker({
    engine: new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), llm: new RecordingLlmClient(), handlers: new Map() }),
    companyId: fixture.companyId,
  });
  const report = await worker.tick(after_(2 * 60_000));
  assert.equal(report.triaged, 1, JSON.stringify(report.errors));
  assert.ok(report.ended >= 1, 'what ended badly was found');
  const raised = await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM inbox_items WHERE kind = 'escalation' AND task_id = $1", [stuck.id]));
  assert.equal(raised.rows.length, 1, 'the halted task has its card');
  assert.equal((await triageTasks(fixture)).length, 1);
  assert.equal(await reportEndedBadly(fixture.companyId, after_(2 * 60_000)), 0, 'and is not found twice');
});
