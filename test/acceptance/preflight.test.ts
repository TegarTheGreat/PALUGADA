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
import { CAPABILITY_OUTAGE_WAITS_MS, Engine, OUTAGE_PARK_WAITS_MS } from '../../src/engine/engine.ts';
import { OUTAGE_PARK_CEILING_MS } from '../../src/engine/recovered.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { CachedSecretManager, rotateCredential } from '../../src/secrets/rotation.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import type { ArchiveLine } from '../../src/audit/export.ts';
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

test('a task whose capability fails preflight does not start, and waits for it rather than halting (F8.12)', async () => {
  const fixture = await createCompany('preflight-halt');
  const { capability, probes } = probedCapability({ healthy: false });
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);

  const ran: string[] = [];
  const task = await newTask(fixture);
  const engine = engineFor(registry, ran);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  // Not started, as F8.12 says, and not halted either: a credential is put
  // right by the owner, and the work it stopped was each to be run again by
  // hand once it was.
  assert.equal(outcome.status, 'waiting_window', outcome.reason);
  assert.equal(outcome.reason, 'capability.unhealthy');
  assert.ok(Math.abs(outcome.waitUntil!.getTime() - Date.now() - OUTAGE_PARK_WAITS_MS[0]!) < 2_000,
    'on the long waits at once: a refused credential is not asked again within the minute');
  assert.deepEqual(ran, [], 'no tokens are spent assembling context for work that cannot succeed');
  assert.equal(probes.count, 1);
  const { workOf } = await import('../../src/owner/views.ts');
  assert.equal((await workOf(fixture.companyId, { taskId: task.id })).items[0]!.waiting?.reason, 'service');

  // An incident, not a retry. A broken credential does not get better by being
  // asked again, and retrying is what turned a five-minute fix into half a day.
  const open = await inbox.listOpen(fixture.companyId);
  const incidents = open.filter((item) => item.kind === 'incident');
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /Read a domain's records failed preflight/);
  assert.match(incidents[0]!.rationale, /API token was rejected/);
  assert.match(incidents[0]!.rationale,
    /Work that needs it waits rather than starts, and carries on by itself once the check passes; this card then closes itself/);

  // Looking again inside the reading's quarter hour asks the vendor nothing:
  // a refused login is not tried more often than before.
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  assert.equal(probes.count, 1);
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident').length, 1);
});

/**
 * H2 (the audit of 30 September, open on 2 October). Any 429, 5xx or dropped
 * connection made a capability unhealthy for fifteen minutes, and every task
 * that needed it in that window was halted -- terminal, each one to be run
 * again by hand. A vendor's bad moment is not a revoked key: the task waits
 * for it, looking again. And one that stays down is still the vendor's,
 * only longer: each task that had waited half an hour raised a card of its
 * own and halted, so an afternoon's outage was a card and a "Run again" for
 * every piece of work in flight. It is one card now, for the service, and
 * the work goes on by itself when the service answers.
 */
test('a vendor down for forty minutes is one card, nothing halts, and the work goes on when it answers (H2)', async () => {
  const fixture = await createCompany('preflight-blip');
  const state = { down: true, probes: 0 };
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read', adapter: 'test:dns', defaultTier: 0,
    async preflight() {
      state.probes += 1;
      return state.down ? { ok: false, detail: 'the provider answered 503', transient: true } : { ok: true };
    },
    async execute() { return { records: [] }; },
  };
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);
  const ran: string[] = [];
  const engine = engineFor(registry, ran);
  const { workOf } = await import('../../src/owner/views.ts');
  // What a worker does once the wait is over: the task is due again, and the
  // reading is old enough to be taken again.
  const later = async (taskId: string) => withTenant(fixture.companyId, async (tx) => {
    await tx.query('UPDATE tasks SET wait_until = now() WHERE id = $1', [taskId]);
    await tx.query("UPDATE capability_health SET checked_at = checked_at - interval '2 minutes'");
  });
  const incidents = async () => (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident');

  const task = await newTask(fixture);
  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.status, 'waiting_window', first.reason);
  assert.equal((await workOf(fixture.companyId, { taskId: task.id })).items[0]!.waiting?.reason, 'service');
  assert.deepEqual(await incidents(), [], 'a moment is not an incident');
  // Its reading stands for a minute, not fifteen: the next look asks again.
  assert.equal((await healthFor(fixture.companyId, fixture.divisionId))[0]!.status, 'unhealthy');

  // Back: the next look finds it well, and the work runs.
  state.down = false;
  await later(task.id);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.deepEqual(ran, [task.id]);

  // Down for forty minutes, with three pieces of work waiting for it. Each
  // waits its short waits, and then the long ones -- and none halts.
  state.down = true;
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE capability_health SET checked_at = checked_at - interval '16 minutes'"));
  const waiting = [await newTask(fixture), await newTask(fixture), await newTask(fixture)];
  for (const one of waiting) {
    const outcomes: string[] = [];
    for (let look = 0; look <= CAPABILITY_OUTAGE_WAITS_MS.length; look += 1) {
      const outcome = await engine.runTask(fixture.companyId, one.id, 'worker');
      outcomes.push(outcome.status);
      if (look < CAPABILITY_OUTAGE_WAITS_MS.length) await later(one.id);
      else assert.ok(Math.abs(outcome.waitUntil!.getTime() - Date.now() - OUTAGE_PARK_WAITS_MS[0]!) < 2_000, 'on the long waits');
    }
    assert.deepEqual(outcomes, [...CAPABILITY_OUTAGE_WAITS_MS.map(() => 'waiting_window'), 'waiting_window']);
  }
  const card = await incidents();
  assert.equal(card.length, 1, 'one card for the service, however much work waits for it');
  assert.match(card[0]!.title, /Read a domain's records is not answering, and the work that needs it is waiting/,
    'the capability by what it does, not its code');
  assert.match(card[0]!.rationale, /carries on by itself once the service answers, and this card then closes itself/);
  assert.match(card[0]!.rationale, /answered 503/);
  const statuses = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
    'SELECT status FROM tasks WHERE id = ANY($1::uuid[])', [waiting.map((one) => one.id)]));
  assert.deepEqual(statuses.rows.map((row) => row.status), ['waiting_window', 'waiting_window', 'waiting_window']);

  // The owner cancels one of them while it waits: it is not called back.
  const { cancelTask } = await import('../../src/engine/owner-control.ts');
  await cancelTask(fixture.companyId, waiting[2]!.id);

  // The service answers. The look that finds it so closes the card and calls
  // the waiting work back at once, rather than at its next look an hour on.
  state.down = false;
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE capability_health SET checked_at = checked_at - interval '2 minutes'"));
  const fresh = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, fresh.id, 'worker')).status, 'completed');
  assert.deepEqual(await incidents(), [], 'the card closed itself');
  const closed = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    "SELECT status, closed_reason FROM inbox_items WHERE kind = 'incident'"));
  assert.deepEqual(closed.rows, [{ status: 'withdrawn', closed_reason: 'capability_healthy' }]);
  const due = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; due: boolean; called: string }>(
    `SELECT t.status, coalesce(t.wait_until <= now(), false) AS due,
            (SELECT count(*) FROM events e WHERE e.task_id = t.id AND e.type = 'task.called_back')::text AS called
       FROM tasks t WHERE t.id = ANY($1::uuid[]) ORDER BY t.created_at`, [waiting.map((one) => one.id)]));
  assert.deepEqual(due.rows.map((row) => [row.status, row.due, row.called]), [
    ['waiting_window', true, '1'], ['waiting_window', true, '1'], ['cancelled', false, '0'],
  ]);
  for (const one of waiting.slice(0, 2)) {
    assert.equal((await engine.runTask(fixture.companyId, one.id, 'worker')).status, 'completed');
  }
  const attempts = await withTenant(fixture.companyId, (tx) => tx.query<{ attempt: number }>(
    'SELECT attempt FROM tasks WHERE id = ANY($1::uuid[])', [waiting.map((one) => one.id)]));
  assert.deepEqual(attempts.rows.map((row) => row.attempt), [0, 0, 0], 'waiting for a service is not failing');
});

/**
 * F12.3's rotation is how the owner puts a credential right, and the sweep it
 * takes is what finds it right: the work that waited for it is called back,
 * and the card that asked for it closes.
 */
test('work waiting for a refused credential goes on when a rotation puts it right, and its card closes itself (F8.12, F12.3)', async () => {
  const fixture = await createCompany('preflight-rotation-heals');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read', adapter: 'test:dns', defaultTier: 0,
    async preflight(ctx) {
      const token = await ctx.credential!('dns', 'dns.read');
      return token === 'dns-token-good' ? { ok: true } : { ok: false, detail: 'the API token was rejected' };
    },
    async execute() { return { records: [] }; },
  };
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);
  const secrets = new CachedSecretManager(new InMemorySecretManager({
    'vault://acme/dns-token': 'dns-token-expired', 'vault://acme/dns-token-v2': 'dns-token-good',
  }));
  const broker = new CapabilityBroker(registry, undefined, secrets);
  const ran: string[] = [];
  const engine = new Engine({
    broker, llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => { ran.push(ctx.task.id); return { done: true }; }]]),
  });

  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident').length, 1);

  await rotateCredential({
    companyId: fixture.companyId, divisionId: fixture.divisionId, alias: 'dns',
    newSecretRef: 'vault://acme/dns-token-v2', registry,
    credential: (companyId, divisionId) => broker.credentialFor(companyId, divisionId),
  });

  const card = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    "SELECT status, closed_reason FROM inbox_items WHERE kind = 'incident'"));
  assert.deepEqual(card.rows, [{ status: 'withdrawn', closed_reason: 'capability_healthy' }]);
  const called = await withTenant(fixture.companyId, (tx) => tx.query<{ due: boolean }>(
    'SELECT wait_until <= now() AS due FROM tasks WHERE id = $1', [task.id]));
  assert.equal(called.rows[0]!.due, true, 'called back at once, not at its next look');
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.deepEqual(ran, [task.id]);
});

/**
 * A wait has an end. A task given back its waits by its deadline (2.158)
 * would otherwise wait for good: a day after its first long wait it halts,
 * named on the card already open for the cause rather than raising one of
 * its own. That card then stays: closing it when the service came back would
 * hide the work that stopped.
 */
test('work that has waited a day for a capability halts on the card open for it, and that card does not close over it', async () => {
  const fixture = await createCompany('preflight-ceiling');
  const state = { healthy: false };
  const { capability } = probedCapability(state);
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);
  const ran: string[] = [];
  const engine = engineFor(registry, ran);

  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  // What a day of waiting leaves behind: a long wait every hour since the
  // first, a day ago.
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO events (company_id, task_id, type, actor, payload, occurred_at)
     SELECT $1, $2, 'task.capability_waited', 'engine', '{"long": true, "capabilities": ["dns.read"]}',
            now() - $3 * interval '1 millisecond' + make_interval(hours => hour)
       FROM generate_series(0, 23) hour`,
    [fixture.companyId, task.id, OUTAGE_PARK_CEILING_MS + 60_000]));
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted', outcome.reason);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ halt_reason: string }>(
    'SELECT halt_reason FROM tasks WHERE id = $1', [task.id]));
  assert.equal(rows[0]!.halt_reason, 'capability_unhealthy');

  const card = await withTenant(fixture.companyId, (tx) => tx.query<{ ended: string[] }>(
    "SELECT payload->'endedTaskIds' AS ended FROM inbox_items WHERE kind = 'incident' AND status = 'open'"));
  assert.equal(card.rows.length, 1);
  assert.deepEqual(card.rows[0]!.ended, [task.id], 'the halt is on the card that says why');
  const { reportEndedBadly } = await import('../../src/engine/ended.ts');
  assert.equal(await reportEndedBadly(fixture.companyId, new Date(Date.now() + 5 * 60_000)), 0, 'no second card for the same cause');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'escalation').length, 0);

  state.healthy = true;
  await checkCapability(registry, { companyId: fixture.companyId, divisionId: fixture.divisionId }, 'dns.read', { force: true });
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident').length, 1,
    'the card names work that stopped, so it stays for the owner');
});

/**
 * F8.12 tells the owner at once when a credential fails. A card kept for the
 * work that stopped under it kept the credential's name too, so when the
 * credential failed again, the check's raise found that old card open and
 * nobody was told. Nor did the card ever close.
 */
test("a credential's card kept for its stopped work: the next failure is a card of its own, and Run again closes the old one (F8.12)", async () => {
  const fixture = await createCompany('preflight-held-passed');
  const state = { healthy: false };
  const { capability } = probedCapability(state);
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);
  const engine = engineFor(registry, []);
  const ctx = { companyId: fixture.companyId, divisionId: fixture.divisionId };
  const cards = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{
    id: string; status: string; closed_reason: string | null; ended: string[] | null;
  }>(`SELECT id, status, closed_reason, payload->'endedTaskIds' AS ended FROM inbox_items
       WHERE kind = 'incident' ORDER BY created_at`))).rows;

  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO events (company_id, task_id, type, actor, payload, occurred_at)
     SELECT $1, $2, 'task.capability_waited', 'engine', '{"long": true, "capabilities": ["dns.read"]}',
            now() - $3 * interval '1 millisecond' + make_interval(hours => hour)
       FROM generate_series(0, 23) hour`,
    [fixture.companyId, task.id, OUTAGE_PARK_CEILING_MS + 60_000]));
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'halted');
  state.healthy = true;
  await checkCapability(registry, ctx, 'dns.read', { force: true });
  assert.deepEqual((await cards()).map((card) => [card.status, card.ended]), [['open', [task.id]]], 'kept for the work that stopped');

  // The credential fails again: the owner is told, on a card of its own.
  state.healthy = false;
  await checkCapability(registry, ctx, 'dns.read', { force: true });
  const now = await cards();
  assert.equal(now.length, 2, 'a new failure is a new card');
  assert.deepEqual(now.map((card) => card.status), ['open', 'open']);

  // Running the stopped work again leaves nothing on the old card; the new one is the credential's.
  const { rerunTask } = await import('../../src/engine/owner-control.ts');
  await rerunTask(fixture.companyId, task.id, null);
  assert.deepEqual((await cards()).map((card) => [card.status, card.closed_reason]), [['withdrawn', 'task_rerun'], ['open', null]]);
});

/** A capability whose vendor the test takes down and brings back: a 503 while down. */
function vendorCapability(state: { down: boolean }, name = 'dns.read'): Capability<never, never> {
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name, adapter: 'test:dns', defaultTier: 0,
    async preflight() {
      return state.down ? { ok: false, detail: 'the provider answered 503', transient: true } : { ok: true };
    },
    async execute() { return { records: [] }; },
  };
  return capability as Capability<never, never>;
}
async function openCards(companyId: string): Promise<string[]> {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ once: string }>(
    "SELECT payload->>'once' AS once FROM inbox_items WHERE kind = 'incident' AND status = 'open' ORDER BY created_at"));
  return rows.map((row) => row.once);
}
/** Takes a task through its short waits for a vendor that stays down, to its first long one. */
async function toTheLongWaits(fixture: Fixture, engine: Engine, taskId: string): Promise<void> {
  for (let look = 0; look <= CAPABILITY_OUTAGE_WAITS_MS.length; look += 1) {
    assert.equal((await engine.runTask(fixture.companyId, taskId, 'worker')).status, 'waiting_window');
    await withTenant(fixture.companyId, async (tx) => {
      await tx.query('UPDATE tasks SET wait_until = now() WHERE id = $1', [taskId]);
      await tx.query("UPDATE capability_health SET checked_at = checked_at - interval '2 minutes'");
    });
  }
}

/**
 * A vendor that answers for a moment and drops again. The card closed on the
 * reading that found it well, and the work still parked went straight back
 * to its long waits with no card: only the move from the short waits to the
 * long ones raised one.
 */
test('a vendor that answers and drops again: the work still waiting has its card again (H2)', async () => {
  const fixture = await createCompany('preflight-flaps');
  const state = { down: true };
  const registry = await registryWith(fixture, vendorCapability(state));
  await giveRoleTools(fixture, ['dns.read']);
  const engine = engineFor(registry, []);
  const task = await newTask(fixture);
  await toTheLongWaits(fixture, engine, task.id);
  const card = `service_down:${fixture.divisionId}:dns.read`;
  assert.deepEqual(await openCards(fixture.companyId), [card]);

  state.down = false;
  await checkCapability(registry, { companyId: fixture.companyId, divisionId: fixture.divisionId }, 'dns.read', { force: true });
  assert.deepEqual(await openCards(fixture.companyId), [], 'well again, the card closed itself');

  // Down again before the task it called back looks.
  state.down = true;
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE capability_health SET checked_at = checked_at - interval '16 minutes'"));
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  assert.deepEqual(await openCards(fixture.companyId), [card], 'the work that waits has its card');
});

/**
 * A vendor's card says work is waiting for it. When none is -- the owner
 * cancelled what waited -- it closes, rather than saying so until something
 * happens to need the service again.
 */
test("a vendor's card whose waiting work the owner cancelled closes itself", async () => {
  const fixture = await createCompany('preflight-nothing-waits');
  const registry = await registryWith(fixture, vendorCapability({ down: true }));
  await giveRoleTools(fixture, ['dns.read']);
  const engine = engineFor(registry, []);
  const task = await newTask(fixture);
  await toTheLongWaits(fixture, engine, task.id);
  const { closeRecovered } = await import('../../src/engine/recovered.ts');
  await closeRecovered(fixture.companyId);
  assert.equal((await openCards(fixture.companyId)).length, 1, 'open while the work waits');

  const { cancelTask } = await import('../../src/engine/owner-control.ts');
  await cancelTask(fixture.companyId, task.id);
  await closeRecovered(fixture.companyId);
  const closed = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    "SELECT status, closed_reason FROM inbox_items WHERE kind = 'incident'"));
  assert.deepEqual(closed.rows, [{ status: 'withdrawn', closed_reason: 'nothing_waits' }]);
});

/**
 * The vendor's card is raised after the task's own look, and a check made in
 * between -- another task's, or the sweep after a rotation -- may have found
 * the service well and closed what was open. Raised then, the card said for
 * good that work waited on a service that answered, and the task sat out a
 * long wait for nothing, since the check had called back only what was
 * parked when it ran.
 */
test('a vendor found well while a task was looking raises no card, and the task is called back (H2)', async () => {
  const fixture = await createCompany('preflight-raise-race');
  const state = { down: true };
  const registry = new CapabilityRegistry();
  registry.register(vendorCapability(state));
  // The role's other tool, checked after dns.read: what another worker's
  // check does in the moment between this task's look and its wait.
  registry.register({
    name: 'whois.read', adapter: 'test:whois', defaultTier: 0,
    async preflight(ctx) {
      state.down = false;
      await checkCapability(registry, { companyId: ctx.companyId, divisionId: ctx.divisionId }, 'dns.read', { force: true });
      return { ok: true };
    },
    async execute() { return {}; },
  } as Capability<unknown, unknown>);
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await grantCapability(fixture, 'whois.read');
  await giveRoleTools(fixture, ['dns.read', 'whois.read']);
  const ran: string[] = [];
  const engine = engineFor(registry, ran);
  const task = await newTask(fixture);
  // On the long waits already, for an outage that began an hour ago.
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO events (company_id, task_id, type, actor, payload, occurred_at)
     VALUES ($1, $2, 'task.capability_waited', 'engine', '{"long": true, "capabilities": ["dns.read"]}', now() - interval '10 minutes')`,
    [fixture.companyId, task.id]));

  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  assert.deepEqual(await openCards(fixture.companyId), [], 'no card for a service that answers');
  const called = await withTenant(fixture.companyId, (tx) => tx.query<{ due: boolean; called: string }>(
    `SELECT wait_until <= now() AS due,
            (SELECT count(*) FROM events WHERE task_id = $1 AND type = 'task.called_back')::text AS called
       FROM tasks WHERE id = $1`, [task.id]));
  assert.deepEqual(called.rows[0], { due: true, called: '1' }, 'called back at once');
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.deepEqual(ran, [task.id]);
});

/**
 * A card's name holds the division it is about, and a company restored from
 * its archive has new ids. Restored as it was, a credential's card never
 * closed itself in the restored company, and another for the same cause was
 * raised beside it.
 */
test("a capability's card restored from an archive closes itself in the restored company (F11.6)", async () => {
  const fixture = await createCompany('preflight-card-restored');
  const state = { healthy: false };
  const { capability } = probedCapability(state);
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await checkCapability(registry, { companyId: fixture.companyId, divisionId: fixture.divisionId }, 'dns.read', { force: true });
  assert.deepEqual(await openCards(fixture.companyId), [`capability:${fixture.divisionId}:dns.read`]);

  const { exportCompany } = await import('../../src/audit/export.ts');
  const { importCompany } = await import('../../src/audit/import.ts');
  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'preflight-card-restored-copy' });
  const { rows: [division] } = await withTenant(restored.companyId, (tx) => tx.query<{ id: string }>('SELECT id FROM divisions'));
  assert.deepEqual(await openCards(restored.companyId), [`capability:${division!.id}:dns.read`], 'named for the restored division');

  state.healthy = true;
  await checkCapability(registry, { companyId: restored.companyId, divisionId: division!.id }, 'dns.read', { force: true });
  assert.deepEqual(await openCards(restored.companyId), [], 'well in the restored company, its card closes');
  assert.equal((await openCards(fixture.companyId)).length, 1, 'the source keeps its own');
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

test('a capability that recovers lets its work through again, and calls back the work that waited, once', async () => {
  const fixture = await createCompany('preflight-recovers');
  const state = { healthy: false };
  const { capability } = probedCapability(state);
  const registry = await registryWith(fixture, capability as Capability<never, never>);
  await giveRoleTools(fixture, ['dns.read']);

  const ran: string[] = [];
  const engine = engineFor(registry, ran);
  const first = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, first.id, 'worker')).status, 'waiting_window');

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
  assert.equal((await engine.runTask(fixture.companyId, first.id, 'worker')).status, 'completed');
  assert.deepEqual(ran, [second.id, first.id]);
  // A second check that finds it well again calls nothing back twice.
  await checkCapability(registry, { companyId: fixture.companyId, divisionId: fixture.divisionId }, 'dns.read', { force: true });
  const called = await withTenant(fixture.companyId, (tx) => tx.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM events WHERE type = 'task.called_back'"));
  assert.equal(called.rows[0]!.count, '1');
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

/**
 * And the sweep it takes can actually resolve the credential it just rotated.
 *
 * The whole point of a credentialed capability's preflight is to use the
 * credential -- that is what "does this token still work" means. Sweeping
 * without a resolver made every such capability answer "no way to resolve
 * one", which `checkCapability` records as unhealthy, which raises an incident
 * and halts the next task that needs it. So a *successful* rotation looked
 * exactly like a broken one, and the owner would be woken to be told that the
 * thing they had just fixed was broken.
 */
test('a rotation sweep can resolve the credential it rotated (F12.3, F8.12)', async () => {
  const fixture = await createCompany('preflight-rotation-credential');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  // A capability whose preflight does what a real one does: ask for the
  // credential and report on what came back.
  const seen: string[] = [];
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async preflight(ctx) {
      if (!ctx.credential) return { ok: false, detail: 'no way to resolve a credential' };
      const token = await ctx.credential('dns', 'dns.read');
      seen.push(token);
      return { ok: true, detail: 'token valid' };
    },
    async execute() {
      return { records: [] };
    },
  };
  const registry = await registryWith(fixture, capability as Capability<never, never>);

  const secrets = new CachedSecretManager(
    new InMemorySecretManager({ 'vault://acme/dns-token': 'dns-token-8f2a41' }),
  );
  const broker = new CapabilityBroker(registry, undefined, secrets);

  // Through `rotateCredential`, because that is the caller this exists for:
  // asserting on `preflightGrants` alone would let the rotation stop passing
  // the resolver and nothing would notice.
  await rotateCredential({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    alias: 'dns',
    newSecretRef: 'vault://acme/dns-token',
    registry,
    credential: (companyId, divisionId) => broker.credentialFor(companyId, divisionId),
  });

  assert.deepEqual(seen, ['dns-token-8f2a41'], 'the preflight was handed the real value');

  const health = await healthFor(fixture.companyId, fixture.divisionId);
  assert.deepEqual(
    health.map((row) => [row.capabilityName, row.status]),
    [['dns.read', 'healthy']],
  );
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
