/**
 * PRD F10 and F1.4 -- the owner's controls.
 *
 * The inbox is the only human interface, so the properties worth testing are
 * the ones that protect the owner's attention and make silence safe:
 * expiry cancels rather than executes (F10.4), stop-all is immediate (F5.8),
 * and a frozen company takes no external action (F1.4).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { freezeCompany, isStopAllRequested, clearStopAll } from '../../src/engine/control.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function newTask(fixture: Fixture, goal = 'work') {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { goal },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
}

function tier3Capability() {
  const calls = { executions: 0 };
  const capability: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.nameservers',
    adapter: 'test:dns',
    defaultTier: 3,
    async execute() {
      calls.executions += 1;
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  return { capability, calls };
}

test('an unanswered approval expires into a cancellation, never an execution', async () => {
  const fixture = await createCompany('expiry');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');

  await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'dns.nameservers',
    tier: 3,
    actionSummary: 'Point the nameservers at the new host',
    rationale: 'Migration task asked for it.',
    consequenceIfDenied: 'The migration halts and the old host keeps serving.',
    ttlHours: 0, // already overdue
  });

  const waiting = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(waiting!.status, 'waiting_approval');

  const expired = await inbox.expireOverdue(fixture.companyId);
  assert.equal(expired, 1);

  const after = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(after!.status, 'cancelled',
    'silence must cancel the work, because an owner who never looked has not consented');
  assert.equal(after!.haltReason, 'approval_expired');
});

test('approving resumes the task and denying cancels it', async () => {
  const fixture = await createCompany('decisions');

  const approved = await newTask(fixture, 'approve-me');
  await transition(fixture.companyId, approved.id, 'running');
  const approvalId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: approved.id, capabilityName: 'dns.nameservers',
    tier: 3, actionSummary: 'Do the thing', rationale: 'because',
    consequenceIfDenied: 'nothing happens',
  });
  await inbox.decide(fixture.companyId, approvalId, 'approve', 'go ahead');
  const resumed = await withTenant(fixture.companyId, (tx) => getTask(tx, approved.id));
  assert.equal(resumed!.status, 'running');

  const denied = await newTask(fixture, 'deny-me');
  await transition(fixture.companyId, denied.id, 'running');
  const denialId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: denied.id, capabilityName: 'dns.nameservers',
    tier: 3, actionSummary: 'Do the other thing', rationale: 'because',
    consequenceIfDenied: 'nothing happens',
  });
  await inbox.decide(fixture.companyId, denialId, 'deny', 'no');
  const stopped = await withTenant(fixture.companyId, (tx) => getTask(tx, denied.id));
  assert.equal(stopped!.status, 'cancelled');

  // Every decision is recorded as an event (F10.8).
  const decisions = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { decision: string } }>(
      "SELECT payload FROM events WHERE type = 'owner.decided' ORDER BY occurred_at",
    );
    return rows.map((r) => r.payload.decision);
  });
  assert.deepEqual(decisions, ['approve', 'deny']);
});

test('asking for clarification leaves the item open without a new task', async () => {
  const fixture = await createCompany('ask');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'dns.nameservers',
    tier: 3, actionSummary: 'Do the thing', rationale: 'because',
    consequenceIfDenied: 'nothing happens',
  });

  await inbox.decide(fixture.companyId, itemId, 'ask', 'why this host?');

  const open = await inbox.listOpen(fixture.companyId);
  assert.equal(open.length, 1, 'F10.3: the question is answered inside the same item');

  const taskCount = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM tasks');
    return Number(rows[0]!.count);
  });
  assert.equal(taskCount, 1, 'asking must not spawn a second task');
});

test('stop-all cancels every running task across companies', async () => {
  const a = await createCompany('stop-a');
  const b = await createCompany('stop-b');
  const taskA = await newTask(a);
  const taskB = await newTask(b);
  await transition(a.companyId, taskA.id, 'running');

  const started = Date.now();
  const cancelled = await inbox.stopEverything();
  const elapsed = Date.now() - started;

  assert.equal(cancelled, 2);
  assert.ok(elapsed < 5_000, `stop-all must complete within 5s, took ${elapsed}ms`);
  assert.equal(await isStopAllRequested(), true);

  for (const [fixture, task] of [[a, taskA], [b, taskB]] as const) {
    const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
    assert.equal(stored!.status, 'cancelled');
    assert.equal(stored!.haltReason, 'owner_stop');
  }
});

test('no external action runs while the platform is stopped', async () => {
  const fixture = await createCompany('stopped');
  const { capability, calls } = tier3Capability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, capability.name);

  const task = await newTask(fixture);
  await inbox.stopEverything();

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability(capability.name, { zone: 'example.com' });
      return {};
    }]]),
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(calls.executions, 0);
  await clearStopAll();
});

test('a frozen company takes no external action', async () => {
  const fixture = await createCompany('frozen');
  const { capability, calls } = tier3Capability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, capability.name);

  const task = await newTask(fixture);
  await freezeCompany(fixture.companyId);

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability(capability.name, { zone: 'example.com' });
      return {};
    }]]),
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(calls.executions, 0);
});

test('an approval item carries everything needed to decide', async () => {
  // F10.2. If answering requires opening a log, the inbox has failed at the
  // one job it has.
  const fixture = await createCompany('decidable');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'dns.nameservers',
    tier: 3,
    actionSummary: 'Repoint nameservers for example.com to ns1.newhost.net',
    rationale: 'Task "migrate hosting" reached its cutover step.',
    consequenceIfDenied: 'The migration halts; the current host keeps serving traffic.',
    estimatedCostCents: 0,
  });

  const [item] = await inbox.listOpen(fixture.companyId);
  assert.ok(item);
  assert.equal(item.kind, 'approval');
  assert.equal(item.tier, 3);
  assert.match(item.actionSummary, /nameservers/);
  assert.match(item.rationale, /migrate hosting/);
  assert.match(item.consequenceIfDenied, /keeps serving/);
  assert.ok(item.expiresAt instanceof Date, 'an approval must have an expiry');
  assert.equal(item.taskId, task.id, 'the item links back to the task chain');
});
