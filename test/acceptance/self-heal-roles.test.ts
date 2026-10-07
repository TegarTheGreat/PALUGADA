/**
 * A role stopped for spending too fast is stopped for a while, not for ever,
 * and the work that was waiting for it waits (the owner's report of 7
 * October: "I have to start the agents again one by one ... a 24/7 company
 * should handle that itself").
 *
 * F1.8 stops a role whose spending is three times its week's average. What
 * the owner decided is that spending should not run away; a role that has
 * cooled off has nothing left to answer for, and unfreezing it by hand, one
 * role at a time, is the same press every time. So a freeze the breaker made
 * lifts when the rate that caused it is no longer in the last hour -- and a
 * role the breaker has stopped three times in a day is left for the owner,
 * because that is a role whose usual is wrong, not a burst.
 *
 * What the owner (or F3.7's denials) froze is never lifted by a clock: the
 * condition behind it does not go away by waiting.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { PalugadaError } from '../../src/errors.ts';
import { evaluateCircuitBreakers, thawCooledRoles } from '../../src/governance/spend-guard.ts';
import { frozenRoles, pauseRole, unfreezeRole } from '../../src/governance/role-freeze.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const MINUTE = 60_000;
const HOUR = 3_600_000;

let sequence = 0;
async function newTask(fixture: Fixture) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `heal-${sequence}` }, createdBy: 'owner', reserveTokens: 5_000,
  });
}

async function seedTrace(fixture: Fixture, taskId: string, cents: number, at: Date): Promise<void> {
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response,
                             input_tokens, output_tokens, cost_cents, occurred_at)
     VALUES ($1, $2, $3, 'test-model', '{}'::jsonb, '{}'::jsonb, 10, 5, $4, $5)`,
    [randomUUID(), fixture.companyId, taskId, cents, at]));
}

/** A steady ten cents an hour for a week before `now`: what "usual" means for this role. */
async function usual(fixture: Fixture, now: Date): Promise<string> {
  const task = await newTask(fixture);
  for (let hoursAgo = 2; hoursAgo <= 167; hoursAgo += 1) {
    await seedTrace(fixture, task.id, 10, new Date(now.getTime() - hoursAgo * HOUR));
  }
  return task.id;
}

const frozenBy = async (fixture: Fixture) => (await withTenant(fixture.companyId, (tx) => tx.query<{ frozen_by: string | null }>(
  'SELECT frozen_by FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!.frozen_by;
const incidents = async (fixture: Fixture) => (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident');

test('a role the breaker stopped goes on by itself once its burst is out of the last hour, and nobody is asked', async () => {
  const fixture = await createCompany('heal-cool');
  const now = new Date();
  const task = await usual(fixture, now);
  await seedTrace(fixture, task, 100, new Date(now.getTime() - 10 * MINUTE));

  assert.equal((await evaluateCircuitBreakers(fixture.companyId, now)).length, 1);
  assert.equal(await frozenBy(fixture), 'spend');
  assert.deepEqual(await incidents(fixture), [], 'the first stop is the platform\'s to hold, not a card for the owner');

  // The burst is forty minutes old: still in the hour that tripped it.
  assert.deepEqual(await thawCooledRoles(fixture.companyId, new Date(now.getTime() + 30 * MINUTE)), []);
  assert.equal((await frozenRoles(fixture.companyId)).length, 1);

  // An hour on, it is not: the role goes back to work, and says so.
  const later = new Date(now.getTime() + 61 * MINUTE);
  assert.deepEqual(await thawCooledRoles(fixture.companyId, later), [fixture.roleId]);
  assert.deepEqual(await frozenRoles(fixture.companyId), []);
  assert.equal(await frozenBy(fixture), null);
  const { rows: said } = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { by?: string } }>(
    "SELECT actor, payload FROM events WHERE type = 'role.unfrozen'"));
  assert.deepEqual(said.map((event) => [event.actor, event.payload.by]), [['system', 'cooled']]);
  // And a second look finds nothing left to do.
  assert.deepEqual(await thawCooledRoles(fixture.companyId, later), []);
});

test('a role that is still spending fast is not let go', async () => {
  const fixture = await createCompany('heal-still');
  const now = new Date();
  const task = await usual(fixture, now);
  await seedTrace(fixture, task, 100, new Date(now.getTime() - 10 * MINUTE));
  await evaluateCircuitBreakers(fixture.companyId, now);

  // A run already in flight kept calling its model after the freeze.
  await seedTrace(fixture, task, 150, new Date(now.getTime() + 30 * MINUTE));
  assert.deepEqual(await thawCooledRoles(fixture.companyId, new Date(now.getTime() + 70 * MINUTE)), []);
  assert.equal((await frozenRoles(fixture.companyId)).length, 1);
  // Once that is also out of the last hour, it goes.
  assert.deepEqual(await thawCooledRoles(fixture.companyId, new Date(now.getTime() + 95 * MINUTE)), [fixture.roleId]);
});

test('a role stopped three times in a day is held for the owner, with a card', async () => {
  const fixture = await createCompany('heal-held');
  const start = new Date();
  const task = await usual(fixture, start);

  const burst = async (at: Date) => {
    await seedTrace(fixture, task, 100, new Date(at.getTime() - 10 * MINUTE));
    return evaluateCircuitBreakers(fixture.companyId, at);
  };
  const first = start;
  assert.equal((await burst(first)).length, 1);
  const second = new Date(first.getTime() + 61 * MINUTE);
  assert.deepEqual(await thawCooledRoles(fixture.companyId, second), [fixture.roleId]);
  assert.equal((await burst(second)).length, 1);
  assert.equal(await frozenBy(fixture), 'spend');
  const third = new Date(second.getTime() + 61 * MINUTE);
  assert.deepEqual(await thawCooledRoles(fixture.companyId, third), [fixture.roleId]);
  assert.equal((await burst(third)).length, 1);

  // The third time it is not a burst, it is the role. Held, and the owner is told.
  assert.equal(await frozenBy(fixture), 'spend_held');
  const open = await incidents(fixture);
  assert.equal(open.length, 1);
  assert.match(open[0]!.title, /paused for spending too fast/);

  // No clock lifts it. The owner's resume still does.
  assert.deepEqual(await thawCooledRoles(fixture.companyId, new Date(third.getTime() + 12 * HOUR)), []);
  assert.equal((await frozenRoles(fixture.companyId)).length, 1);
  await unfreezeRole(fixture.companyId, fixture.roleId);
  assert.deepEqual(await frozenRoles(fixture.companyId), []);
  assert.equal(await frozenBy(fixture), null);
});

test('what the owner paused, or the denials froze, no clock lifts', async () => {
  const fixture = await createCompany('heal-owner');
  await pauseRole(fixture.companyId, fixture.roleId, 'while I look at the invoices');
  assert.equal(await frozenBy(fixture), 'owner');
  assert.deepEqual(await thawCooledRoles(fixture.companyId, new Date(Date.now() + 48 * HOUR)), []);
  assert.equal((await frozenRoles(fixture.companyId)).length, 1);

  // A freeze from before frozen_by was kept is not guessed at.
  await unfreezeRole(fixture.companyId, fixture.roleId);
  await withControlPlane((tx) => tx.query(
    "UPDATE roles SET frozen_at = now(), frozen_reason = '12 denied attempts today' WHERE id = $1", [fixture.roleId]));
  assert.deepEqual(await thawCooledRoles(fixture.companyId, new Date(Date.now() + 48 * HOUR)), []);
});

test('only a freeze says who made it', async () => {
  const fixture = await createCompany('heal-constraint');
  await assert.rejects(
    withControlPlane((tx) => tx.query("UPDATE roles SET frozen_by = 'spend' WHERE id = $1", [fixture.roleId])),
    /roles_frozen_by_needs_a_freeze|violates check constraint/,
  );
  await assert.rejects(
    withControlPlane((tx) => tx.query("UPDATE roles SET frozen_at = now(), frozen_by = 'a clock' WHERE id = $1", [fixture.roleId])),
    /violates check constraint/,
  );
});

/** A runtime that only counts the runs it is given, and finishes them. */
function counting() {
  const calls = { runs: 0 };
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'counting',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run() {
      calls.runs += 1;
      return { output: { summary: 'done', done: [{ criterion: 'the run returns an output matching its schema', met: true, evidence: 'this output' }] } };
    },
  });
  return { adapters, calls };
}

async function engineFor(adapters: AdapterRegistry): Promise<Engine> {
  const registry = new CapabilityRegistry();
  await registry.sync();
  return new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'heal-roles' });
}

async function waitingFor(fixture: Fixture, taskId: string) {
  const task = (await withTenant(fixture.companyId, (tx) => getTask(tx, taskId)))!;
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { reason?: string } }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'task.waiting_window' ORDER BY occurred_at DESC, id DESC LIMIT 1", [taskId]));
  return { status: task.status, reason: rows[0]?.payload.reason ?? null, attempt: task.attempt };
}

test('work whose role is stopped waits for it, spending nothing, and goes on when the role does', async () => {
  const fixture = await createCompany('heal-wait');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET runtime = 'counting', backend = 'local' WHERE id = $1", [fixture.roleId]));
  const task = await newTask(fixture);
  await pauseRole(fixture.companyId, fixture.roleId);

  const { adapters, calls } = counting();
  const engine = await engineFor(adapters);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['waiting_window', 'role.frozen']);
  assert.equal(calls.runs, 0, 'a run that cannot work is not started to find out');
  const parked = await waitingFor(fixture, task.id);
  assert.deepEqual([parked.status, parked.reason], ['waiting_window', 'role_paused']);
  assert.equal(parked.attempt, 0, 'waiting is not a failed attempt');

  // The role is resumed: the task is called back at once, not at the end of its wait.
  await unfreezeRole(fixture.companyId, fixture.roleId);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ ready: boolean }>(
    'SELECT wait_until <= now() AS ready FROM tasks WHERE id = $1', [task.id]));
  assert.equal(rows[0]!.ready, true);
  const done = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(done.status, 'completed', done.reason);
  assert.equal(calls.runs, 1);
});

test('a role stopped in the middle of a run parks the run instead of failing it', async () => {
  const fixture = await createCompany('heal-mid');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET runtime = 'midway', backend = 'local' WHERE id = $1", [fixture.roleId]));
  const task = await newTask(fixture);
  let runs = 0;
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'midway',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run() {
      runs += 1;
      if (runs === 1) {
        // What the broker says to a call made after the freeze.
        await pauseRole(fixture.companyId, fixture.roleId);
        throw new PalugadaError('role.frozen', 'role is frozen', { roleId: fixture.roleId });
      }
      return { output: { summary: 'done', done: [{ criterion: 'the run returns an output matching its schema', met: true, evidence: 'this output' }] } };
    },
  });
  const engine = await engineFor(adapters);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['waiting_window', 'role.frozen']);
  const parked = await waitingFor(fixture, task.id);
  assert.deepEqual([parked.status, parked.reason, parked.attempt], ['waiting_window', 'role_paused', 0]);

  await unfreezeRole(fixture.companyId, fixture.roleId);
  const done = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(done.status, 'completed', done.reason);
  assert.equal(runs, 2);
});

test('a role that cools off calls back the work that waited for it', async () => {
  const fixture = await createCompany('heal-callback');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET runtime = 'counting', backend = 'local' WHERE id = $1", [fixture.roleId]));
  const now = new Date();
  const burstTask = await usual(fixture, now);
  await seedTrace(fixture, burstTask, 100, new Date(now.getTime() - 10 * MINUTE));
  const task = await newTask(fixture);
  await evaluateCircuitBreakers(fixture.companyId, now);

  const { adapters } = counting();
  const engine = await engineFor(adapters);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_window');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE tasks SET wait_until = now() + interval '1 hour' WHERE id = $1", [task.id]));

  await thawCooledRoles(fixture.companyId, new Date(now.getTime() + 61 * MINUTE));
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ ready: boolean }>(
    'SELECT wait_until <= now() AS ready FROM tasks WHERE id = $1', [task.id]));
  assert.equal(rows[0]!.ready, true, 'the cooled role\'s work does not sit out the rest of its hour');
});

test("another company's roles are not thawed by this one's look", async () => {
  const mine = await createCompany('heal-mine');
  const theirs = await createCompany('heal-theirs');
  await withControlPlane((tx) => tx.query(
    "UPDATE roles SET frozen_at = now() - interval '5 hours', frozen_reason = 'x', frozen_by = 'spend' WHERE id = ANY($1::uuid[])",
    [[mine.roleId, theirs.roleId]]));
  assert.deepEqual(await thawCooledRoles(mine.companyId), [mine.roleId]);
  assert.equal((await frozenRoles(theirs.companyId)).length, 1);
});
