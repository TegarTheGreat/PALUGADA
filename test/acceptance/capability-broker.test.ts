/**
 * PRD F2.4, F8.1, F8.3, F8.4, F8.6, F8.8 -- the capability broker.
 *
 * Acceptance criteria exercised here:
 *   F2.4  a role in a division without the grant is refused with
 *         capability.not_granted, and no call reaches the adapter.
 *   F8.4  registering a tier >= 1 capability without verify() is refused;
 *         once present, a read-back mismatch halts the task and raises an
 *         incident.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { killCapability } from '../../src/engine/control.ts';
import { rerunTask } from '../../src/engine/owner-control.ts';
import { isPalugadaError } from '../../src/errors.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, grantCapability, type Fixture, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface DnsInput { record: string; value: string }

/**
 * Stands in for an MCP-backed DNS adapter. `executions` is the evidence for
 * F2.4: a refusal must leave it at zero, because refusing after the request
 * has already left the process is not a refusal.
 */
function dnsCapability(options: { corruptWrite?: boolean } = {}) {
  const zone = new Map<string, string>();
  const calls = { executions: 0, verifications: 0 };

  const capability: Capability<DnsInput, { ok: boolean }> = {
    name: 'dns.update',
    adapter: 'test:dns',
    defaultTier: 1,
    estimatedCostCents: 0,
    async execute(input) {
      calls.executions += 1;
      // A provider that reports success while writing something else is
      // exactly the failure mode F8.4 exists to catch.
      zone.set(input.record, options.corruptWrite ? `${input.value}-corrupted` : input.value);
      return { ok: true };
    },
    async verify(input) {
      calls.verifications += 1;
      return zone.get(input.record) === input.value;
    },
  };

  return { capability, calls, zone };
}

async function newTask(fixture: Fixture) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: 'dns' },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
}

function engineFor(registry: CapabilityRegistry, handler: TaskHandler) {
  return new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', handler]]),
  });
}

test('a tier 1 capability without verify() is refused at registration', async () => {
  const registry = new CapabilityRegistry();
  assert.throws(
    () => registry.register({
      name: 'dns.update',
      adapter: 'test:dns',
      defaultTier: 1,
      execute: async () => ({ ok: true }),
    }),
    (error: unknown) => isPalugadaError(error, 'capability.verify_missing'),
    'a write capability must declare a read-back before it can be registered',
  );

  // Read-only capabilities need no read-back.
  assert.doesNotThrow(() => registry.register({
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    execute: async () => ({ records: [] }),
  }));
});

test('a division without the grant is refused before the adapter is touched', async () => {
  const fixture = await createCompany('growth');
  const { capability, calls } = dnsCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  // Deliberately no grantCapability() call: this division may not touch DNS.

  const task = await newTask(fixture);
  const engine = engineFor(registry, async (ctx) => {
    await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
    return {};
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'failed');
  assert.equal(calls.executions, 0, 'the refusal must produce no downstream call at all');

  const denials = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { reason: string } }>(
      "SELECT payload FROM events WHERE type = 'policy.denied'",
    );
    return rows;
  });
  assert.equal(denials.length, 1);
  assert.equal(denials[0]!.payload.reason, 'capability.not_granted');
});

test('a granted capability executes and is verified by read-back', async () => {
  const fixture = await createCompany('ops-dns');
  const { capability, calls, zone } = dnsCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.update');

  const task = await newTask(fixture);
  const engine = engineFor(registry, async (ctx) => {
    const result = await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
    return { result: result as Record<string, unknown> };
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed');
  assert.equal(calls.executions, 1);
  assert.equal(calls.verifications, 1, 'a write must always be read back');
  assert.equal(zone.get('www'), '1.2.3.4');

  const types = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      'SELECT type FROM events WHERE task_id = $1 ORDER BY occurred_at',
      [task.id],
    );
    return rows.map((r) => r.type);
  });
  assert.ok(types.includes('tool.called'));
  assert.ok(types.includes('tool.verified'));
});

test('a read-back mismatch halts the task and raises an incident', async () => {
  const fixture = await createCompany('dns-drift');
  const { capability, calls } = dnsCapability({ corruptWrite: true });
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.update');

  const task = await newTask(fixture);
  const engine = engineFor(registry, async (ctx) => {
    await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
    return {};
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'halted');
  assert.equal(outcome.reason, 'verification_failed');
  assert.equal(calls.verifications, 1);

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'halted');
  assert.equal(stored!.haltReason, 'verification_failed');

  // The owner learns about it; the task does not quietly retry a write whose
  // effect nobody has confirmed.
  const open = await inbox.listOpen(fixture.companyId);
  const incidents = open.filter((item) => item.kind === 'incident');
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /verification/i);

  // The card says to look before running it again; running it again is the
  // owner's answer, and the card closes with it.
  await rerunTask(fixture.companyId, task.id, 'The record was checked by hand.');
  const { rows: closed } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [incidents[0]!.id]));
  assert.deepEqual(closed[0], { status: 'withdrawn', closed_reason: 'task_rerun' });
});

/**
 * The card is the halt's own record, not something said after it. It was
 * raised in a transaction of its own after the halt and after the halt's
 * hooks, so a worker stopped in between -- a deploy, a crash -- left a task
 * halted for a write that may have happened and no card saying so. Nothing
 * tried again, because the task had ended; the daily count that used to
 * notice is gone; and a child task is not reported by ended.ts at all. The
 * hook stands in for the worker stopping: what it finds committed is all a
 * restart would find.
 */
test('the failed read-back card is committed with the halt, before anything after it runs (F8.4)', async () => {
  const fixture = await createCompany('dns-drift-atomic');
  const { capability } = dnsCapability({ corruptWrite: true });
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.update');

  const task = await newTask(fixture);
  const engine = engineFor(registry, async (ctx) => {
    await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
    return {};
  });
  let reached!: () => void;
  const atHalt = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  engine.hooks.add({
    name: 'test.worker_stops_here',
    on: 'on_halt',
    run: async () => {
      reached();
      await held;
      return { allow: true };
    },
  });

  const running = engine.runTask(fixture.companyId, task.id, 'worker');
  await atHalt;
  try {
    const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
    assert.deepEqual([stored!.status, stored!.haltReason], ['halted', 'verification_failed']);
    const incidents = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident');
    assert.deepEqual(incidents.map((item) => item.taskId), [task.id], 'the card is there the moment the halt is');
  } finally {
    release();
  }
  assert.equal((await running).reason, 'verification_failed');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident').length, 1,
    'and raised once');
});

/**
 * F8.4 from the run's side. A model is handed a failed tool call as a result
 * it can read, and the natural answer to "the write did not stick" is to
 * write again: a second payment, a second email. The failed read-back ends
 * the run however the run takes it, and nothing after it reaches the vendor.
 */
test('a run that shrugs off a failed read-back and writes again is stopped before the second write', async () => {
  const fixture = await createCompany('dns-retry');
  const { capability, calls } = dnsCapability({ corruptWrite: true });
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.update');

  const task = await newTask(fixture);
  let refusedAgain: unknown = null;
  const engine = engineFor(registry, async (ctx) => {
    try {
      await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
    } catch {
      // What a model does with an error it is shown: tries again.
      try {
        await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
      } catch (again) {
        refusedAgain = again;
      }
    }
    return { summary: 'updated, eventually' };
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(calls.executions, 1, 'the second write never reached the vendor');
  assert.ok(isPalugadaError(refusedAgain, 'capability.verify_failed'), 'and the run was told why');
  assert.deepEqual([outcome.status, outcome.reason], ['halted', 'verification_failed'],
    'a run that carried on and returned output is still halted, not completed');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident').length, 1);
});

test('a grant may tighten a tier but never loosen it', async () => {
  const fixture = await createCompany('tier-lock');
  const { capability } = dnsCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();

  // Tightening from tier 1 to tier 3 is allowed.
  await grantCapability(fixture, 'dns.update', { tierOverride: 3 });

  // Loosening below the registry default is refused by the database, so no
  // application bug can widen a capability's blast radius.
  await assert.rejects(
    () => grantCapability(fixture, 'dns.update', { tierOverride: 0 }),
    /cannot be loosened/,
  );
});

test('a tier 3 action stops for owner approval instead of executing', async () => {
  const fixture = await createCompany('tier3');
  const { capability, calls } = dnsCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.update', { tierOverride: 3 });

  const task = await newTask(fixture);
  // The override makes this tier 3, so F8.11 wants a plan before the action.
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.update' }]);
  const engine = engineFor(registry, async (ctx) => {
    await ctx.callCapability('dns.update', { record: 'www', value: '9.9.9.9' });
    return {};
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'waiting_approval');
  assert.equal(calls.executions, 0, 'nothing irreversible may happen before a human answers');

  const open = await inbox.listOpen(fixture.companyId);
  const approval = open.find((item) => item.kind === 'approval');
  assert.ok(approval, 'the owner must have something to decide');
  assert.equal(approval!.tier, 3);
  // F10.2: the item must be decidable on its own terms.
  assert.ok(approval!.actionSummary.length > 0);
  assert.ok(approval!.rationale.length > 0);
  // Said to the owner, not to the platform (§2.3 item 7): the rationale was
  // "Task 6f1c…-… requested dns.update at tier 3, which cannot be reversed."
  assert.equal(approval!.rationale.split('\n')[0], 'This work asked for it at tier 3, which cannot be reversed.');
  assert.ok(!approval!.rationale.includes(task.id) && !approval!.rationale.includes('dns.update'));
  assert.ok(approval!.consequenceIfDenied.length > 0);
  assert.ok(approval!.expiresAt instanceof Date);
});

test('the kill switch disables a capability across every company', async () => {
  const fixture = await createCompany('killswitch');
  const { capability, calls } = dnsCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.update');

  await killCapability('dns.update');

  const task = await newTask(fixture);
  const engine = engineFor(registry, async (ctx) => {
    await ctx.callCapability('dns.update', { record: 'www', value: '1.1.1.1' });
    return {};
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'failed');
  assert.equal(calls.executions, 0);
});
