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
