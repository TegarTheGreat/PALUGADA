/**
 * PRD v2 F8.12 -- capability preflight, and F12.3's rotation trigger.
 *
 * v2 section 2.3 records a secret that was misconfigured and failed silently
 * for half a day: every call failed, every failure looked transient, and the
 * retries hid it. These tests are about the two properties that would have
 * changed that afternoon -- the failure is an incident rather than a retry,
 * and the task does not start.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import {
  PREFLIGHT_TTL_MS,
  checkCapability,
  healthFor,
  preflightForRole,
  preflightGrants,
} from '../../src/broker/preflight.ts';
import { Engine } from '../../src/engine/engine.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { rotateCredential } from '../../src/secrets/rotation.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A capability whose health the test controls, and which counts its probes. */
function probedCapability(state: { healthy: boolean; throws?: boolean }) {
  const probes = { count: 0 };
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async preflight() {
      probes.count += 1;
      if (state.throws) throw new Error('the provider hung up');
      return state.healthy
        ? { ok: true, detail: 'token valid, quota 900/1000' }
        : { ok: false, detail: 'the API token was rejected' };
    },
    async execute() {
      return { records: [] };
    },
  };
  return { capability, probes };
}

async function registryWith(
  fixture: Fixture,
  capability: Capability<never, never>,
): Promise<CapabilityRegistry> {
  const registry = new CapabilityRegistry();
  registry.register(capability as Capability<unknown, unknown>);
  await registry.sync();
  await grantCapability(fixture, capability.name);
  return registry;
}

/** Gives the fixture's role a tool, which is what preflight checks. */
async function giveRoleTools(fixture: Fixture, tools: string[]): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query('UPDATE roles SET tools = $2 WHERE id = $1', [fixture.roleId, tools]);
  });
}

let sequence = 0;
async function newTask(fixture: Fixture) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `preflight-${sequence}` },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
}

function engineFor(registry: CapabilityRegistry, ran: string[]) {
  return new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([
      ['worker', async (ctx) => {
        ran.push(ctx.task.id);
        return { done: true };
      }],
    ]),
  });
}

test('a task whose capability fails preflight does not start (F8.12)', async () => {
  const fixture = await createCompany('preflight-halt');
  const { capability, probes } = probedCapability({ healthy: false });
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);

  const ran: string[] = [];
  const task = await newTask(fixture);
  const outcome = await engineFor(registry, ran).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'halted');
  assert.match(outcome.reason ?? '', /preflight failed for dns\.read/);
  assert.deepEqual(ran, [], 'no tokens are spent assembling context for work that cannot succeed');
  assert.equal(probes.count, 1);

  // An incident, not a retry. A broken credential does not get better by being
  // asked again, and retrying is what turned a five-minute fix into half a day.
  const open = await inbox.listOpen(fixture.companyId);
  const incidents = open.filter((item) => item.kind === 'incident');
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /dns\.read failed preflight/);
  assert.match(incidents[0]!.rationale, /API token was rejected/);
  assert.match(incidents[0]!.rationale, /No task that needs it will start/);
});

test('a healthy capability lets the task run', async () => {
  const fixture = await createCompany('preflight-pass');
  const { capability } = probedCapability({ healthy: true });
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);

  const ran: string[] = [];
  const task = await newTask(fixture);
  const outcome = await engineFor(registry, ran).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(ran, [task.id]);

  const health = await healthFor(fixture.companyId, fixture.divisionId);
  assert.equal(health.length, 1);
  assert.equal(health[0]!.status, 'healthy');
  assert.match(health[0]!.detail, /quota 900\/1000/);
});

test('a capability that declares no preflight is healthy by definition', async () => {
  // Treating silence as a failure would refuse most of the catalogue: a pure
  // computation has nothing to check.
  const fixture = await createCompany('preflight-silent');
  const capability: Capability<unknown, { ok: boolean }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async execute() {
      return { ok: true };
    },
  };
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);

  const readiness = await preflightForRole(
    registry,
    { companyId: fixture.companyId, divisionId: fixture.divisionId },
    fixture.roleId,
  );
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.failures, []);
});

test('a preflight that throws has failed, not gone unknown', async () => {
  // Reading a thrown error as "we do not know" would let a broken capability
  // through on the strength of being broken in an unexpected way.
  const fixture = await createCompany('preflight-throws');
  const { capability } = probedCapability({ healthy: true, throws: true });
  const registry = await registryWith(fixture, capability as Capability<never, never>);

  const outcome = await checkCapability(
    registry,
    { companyId: fixture.companyId, divisionId: fixture.divisionId },
    'dns.read',
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /preflight threw: the provider hung up/);
});

test('a fresh result stands, and a forced check takes a new one', async () => {
  // Probing an external service before every task would make preflight itself
  // the load.
  const fixture = await createCompany('preflight-cache');
  const { capability, probes } = probedCapability({ healthy: true });
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  const ctx = { companyId: fixture.companyId, divisionId: fixture.divisionId };

  const first = await checkCapability(registry, ctx, 'dns.read');
  assert.equal(first.reused, false);
  const second = await checkCapability(registry, ctx, 'dns.read');
  assert.equal(second.reused, true);
  assert.equal(probes.count, 1, 'the second call reused the first answer');

  const forced = await checkCapability(registry, ctx, 'dns.read', { force: true });
  assert.equal(forced.reused, false);
  assert.equal(probes.count, 2);

  // And a result older than the window is taken again on its own.
  const later = new Date(Date.now() + PREFLIGHT_TTL_MS + 1_000);
  const stale = await checkCapability(registry, ctx, 'dns.read', { now: later });
  assert.equal(stale.reused, false);
  assert.equal(probes.count, 3);
});

test('the incident is raised on the way into unhealthy, not on every check', async () => {
  // A capability that stays broken for a day would otherwise file ninety-six
  // identical incidents and bury the one that says something new.
  const fixture = await createCompany('preflight-once');
  const state = { healthy: false };
  const { capability } = probedCapability(state);
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  const ctx = { companyId: fixture.companyId, divisionId: fixture.divisionId };

  await checkCapability(registry, ctx, 'dns.read', { force: true });
  await checkCapability(registry, ctx, 'dns.read', { force: true });
  await checkCapability(registry, ctx, 'dns.read', { force: true });

  const open = await inbox.listOpen(fixture.companyId);
  assert.equal(open.filter((item) => item.kind === 'incident').length, 1);
});

test('a capability that recovers lets its work through again', async () => {
  const fixture = await createCompany('preflight-recovers');
  const state = { healthy: false };
  const { capability } = probedCapability(state);
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);

  const ran: string[] = [];
  const engine = engineFor(registry, ran);
  const first = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, first.id, 'worker')).status, 'halted');

  state.healthy = true;
  await checkCapability(
    registry,
    { companyId: fixture.companyId, divisionId: fixture.divisionId },
    'dns.read',
    { force: true },
  );

  const second = await newTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, second.id, 'worker');
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(ran, [second.id]);
});

test('a rotation takes a new reading (F12.3)', async () => {
  // The point of rotating is that the old answer no longer describes reality,
  // so a cached "healthy" from before the rotation is worse than no answer.
  const fixture = await createCompany('preflight-rotation');
  const { capability, probes } = probedCapability({ healthy: true });
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  const ctx = { companyId: fixture.companyId, divisionId: fixture.divisionId };

  await checkCapability(registry, ctx, 'dns.read');
  assert.equal(probes.count, 1);

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  await rotateCredential({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    alias: 'dns',
    newSecretRef: 'vault://acme/dns-token-v2',
    registry,
  });

  assert.equal(probes.count, 2, 'the rotation probed again rather than trusting the cache');
});

test('a tool no adapter is bound to is a deployment gap, not ill health', async () => {
  // Preflight answers "does this capability work". A name nothing is bound to
  // has nothing to work or fail, and the broker refuses it by name at the
  // moment it is used -- which is both louder and more accurate.
  const fixture = await createCompany('preflight-unbound');
  const { capability } = probedCapability({ healthy: true });
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read', 'deploy.production']);

  const readiness = await preflightForRole(
    registry,
    { companyId: fixture.companyId, divisionId: fixture.divisionId },
    fixture.roleId,
  );
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.unregistered, ['deploy.production']);
  assert.deepEqual(readiness.failures, []);
});

test('health is per division, because the credential is', async () => {
  const fixture = await createCompany('preflight-scope');
  const { capability } = probedCapability({ healthy: false });
  const registry = await registryWith(fixture, capability as Capability<never, never>);

  const other = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO divisions (company_id, slug, name) VALUES ($1, 'growth', 'Growth') RETURNING id",
      [fixture.companyId],
    );
    return rows[0]!.id;
  });

  await checkCapability(
    registry,
    { companyId: fixture.companyId, divisionId: fixture.divisionId },
    'dns.read',
  );

  assert.equal((await healthFor(fixture.companyId, fixture.divisionId))[0]!.status, 'unhealthy');
  assert.deepEqual(
    await healthFor(fixture.companyId, other),
    [],
    "one division's broken token says nothing about another's",
  );
});

test('a sweep checks what was granted and nothing else', async () => {
  // Probing a capability nobody granted would mean calling an external service
  // on behalf of a division that never asked for it.
  const fixture = await createCompany('preflight-sweep');
  const { capability, probes } = probedCapability({ healthy: true });
  const registry = await registryWith(fixture, capability as Capability<never, never>);

  const swept = await preflightGrants(registry, { companyId: fixture.companyId });
  assert.equal(swept.checked, 1);
  assert.equal(swept.failures, 0);
  assert.equal(probes.count, 1);

  const empty = await createCompany('preflight-sweep-empty');
  const none = await preflightGrants(registry, { companyId: empty.companyId });
  assert.equal(none.checked, 0);
  assert.equal(probes.count, 1, 'a company with no grants probes nothing');
});
