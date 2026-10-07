/**
 * Money that runs out is handled by the company, not by its owner (the
 * owner's report of 7 October: "sometimes the budget suddenly runs out, which
 * is very annoying, and I have to start the agents again one by one ... a
 * 24/7 company should handle that itself").
 *
 * Section 6.3 said a task its budget stopped "is never resumed
 * automatically", and the owner's way back was to raise a ceiling (with a
 * code), lift the pause (with another), and then go on with each account's
 * work (with a press). What the owner decided is the ceiling; the rest is
 * the consequence of it. So now, when the owner's own ceiling has room again
 * -- a new month, a raised ceiling, a lifted pause -- the work it stopped goes
 * on by itself, and only then: never past a ceiling, never without room for a
 * run to make progress, and never in a loop.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { resumeBudgetStopped, MIN_ROOM_TOKENS, MIN_ROOM_CENTS, MAX_RESUMES_A_DAY } from '../../src/engine/self-heal.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { clearSpendPause } from '../../src/governance/spend-guard.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A runtime whose every run reports a model call of `tokens`, then finishes. */
function spender(tokens: number) {
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'spender',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run(_request, services) {
      await services.reportUsage({ model: 'test-model', inputTokens: tokens, outputTokens: 0, costCents: 0 });
      return { output: { summary: 'spent', done: [{ criterion: 'the run returns an output matching its schema', met: true, evidence: 'this output' }] } };
    },
  });
  return adapters;
}

async function engineFor(tokens: number): Promise<Engine> {
  const registry = new CapabilityRegistry();
  await registry.sync();
  return new Engine({ broker: new CapabilityBroker(registry), adapters: spender(tokens), workerId: 'self-heal-worker' });
}

let sequence = 0;
async function stoppedTask(fixture: Fixture, goal = 'Plan the week') {
  sequence += 1;
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'spender', backend = 'local' WHERE id = $1", [fixture.roleId]));
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `${goal} (${sequence})` }, createdBy: 'owner', reserveTokens: 1_000,
  });
  const outcome = await (await engineFor(900_000)).runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['halted', 'budget_exhausted']);
  return task;
}

/** What a halt for want of tokens leaves: an account spent to its ceiling. */
const exhaust = (fixture: Fixture) => withControlPlane((tx) => tx.query(
  'UPDATE budget_accounts SET tokens_spent = tokens_max WHERE id = $1', [fixture.budgetAccountId]));
const statusOf = async (fixture: Fixture, taskId: string) => (await withTenant(fixture.companyId, (tx) => getTask(tx, taskId)))!.status;
const room = (fixture: Fixture, tokensMax: number, moneyMaxCents = 100_000) => withControlPlane((tx) => tx.query(
  'UPDATE budget_accounts SET tokens_max = $2, money_max_cents = $3 WHERE id = $1', [fixture.budgetAccountId, tokensMax, moneyMaxCents]));

test('work its budget stopped goes on by itself once its account has room, and says so', async () => {
  const fixture = await createCompany('heal-room', { tokensMax: 100_000 });
  const task = await stoppedTask(fixture);
  await exhaust(fixture);

  // The ceiling is still where it was: nothing moves, nothing is asked.
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 0, waiting: 1 });
  assert.equal(await statusOf(fixture, task.id), 'halted');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert').length, 1, 'the card stays for the owner');

  // The owner raises the ceiling -- the one thing that was theirs to do.
  await room(fixture, 5_000_000);
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 1, waiting: 0 });
  const after = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.deepEqual([after.status, after.haltReason], ['pending', null]);

  // Said as it happened: by the platform, and why.
  const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { by?: string } }>(
    "SELECT actor, payload FROM events WHERE task_id = $1 AND type = 'task.continued'", [task.id]));
  assert.deepEqual(events.map((event) => [event.actor, event.payload.by]), [['system', 'budget_room']]);
  // And the card that said it had stopped is withdrawn, with the right reason.
  const { rows: cards } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    "SELECT status, closed_reason FROM inbox_items WHERE task_id = $1 AND kind = 'budget_alert'", [task.id]));
  assert.deepEqual(cards, [{ status: 'withdrawn', closed_reason: 'budget_room' }]);

  // It finishes as the owner's own continuing would have it.
  const done = await (await engineFor(10)).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(done.status, 'completed', done.reason);
});

test('a few tokens of room is not room: a task is not started again to stop again', async () => {
  const fixture = await createCompany('heal-thin', { tokensMax: 100_000 });
  const task = await stoppedTask(fixture);
  await exhaust(fixture);
  // Enough to reserve for one run, not enough to make progress in.
  await room(fixture, 100_000 + MIN_ROOM_TOKENS - 1);
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 0, waiting: 1 });
  assert.equal(await statusOf(fixture, task.id), 'halted');

  // Money is room of its own kind.
  await room(fixture, 5_000_000, 700);
  await withControlPlane((tx) => tx.query('UPDATE budget_accounts SET tokens_spent = 0, money_spent_cents = $2 WHERE id = $1', [fixture.budgetAccountId, 700 - MIN_ROOM_CENTS + 1]));
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 0, waiting: 1 });
  await withControlPlane((tx) => tx.query('UPDATE budget_accounts SET money_spent_cents = $2 WHERE id = $1', [fixture.budgetAccountId, 700 - MIN_ROOM_CENTS]));
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 1, waiting: 0 });
});

test('how many go on is what the room can carry, oldest first, not all at once', async () => {
  const fixture = await createCompany('heal-share', { tokensMax: 100_000 });
  const first = await stoppedTask(fixture, 'First');
  const second = await stoppedTask(fixture, 'Second');
  const third = await stoppedTask(fixture, 'Third');
  await exhaust(fixture);
  // Room for two runs' worth: the older two go on, the newest waits for more.
  await room(fixture, 100_000 + 2 * MIN_ROOM_TOKENS + 10_000);
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 2, waiting: 1 });
  assert.deepEqual([await statusOf(fixture, first.id), await statusOf(fixture, second.id), await statusOf(fixture, third.id)], ['pending', 'pending', 'halted']);
});

test('a company paused for its month goes on only when the pause is lifted, and then without being asked', async () => {
  const fixture = await createCompany('heal-paused', { tokensMax: 100_000 });
  const task = await stoppedTask(fixture);
  await exhaust(fixture);
  await room(fixture, 5_000_000);
  await withControlPlane((tx) => tx.query(
    `INSERT INTO spend_limits (company_id, paused_at, pause_reason) VALUES ($1, now(), 'test')
     ON CONFLICT (company_id) DO UPDATE SET paused_at = now(), pause_reason = 'test'`, [fixture.companyId]));
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 0, waiting: 1 });
  assert.equal(await statusOf(fixture, task.id), 'halted');
  await clearSpendPause(fixture.companyId);
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 1, waiting: 0 });
});

test('a role the owner has paused keeps its work waiting; the others go on', async () => {
  const fixture = await createCompany('heal-frozen', { tokensMax: 100_000 });
  const task = await stoppedTask(fixture);
  await exhaust(fixture);
  await room(fixture, 5_000_000);
  await withControlPlane((tx) => tx.query("UPDATE roles SET frozen_at = now(), frozen_reason = 'paused by the owner' WHERE id = $1", [fixture.roleId]));
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 0, waiting: 1 });
  assert.equal(await statusOf(fixture, task.id), 'halted');
});

test('a task that has gone on by itself three times in a day and stopped again is left for the owner', async () => {
  const fixture = await createCompany('heal-loop', { tokensMax: 100_000 });
  const task = await stoppedTask(fixture);
  await exhaust(fixture);
  await room(fixture, 5_000_000);
  await withTenant(fixture.companyId, async (tx) => {
    for (let i = 0; i < MAX_RESUMES_A_DAY; i += 1) {
      await appendEvent(tx, { companyId: fixture.companyId, taskId: task.id, type: 'task.continued', actor: 'system', payload: { by: 'budget_room' } });
    }
  });
  assert.deepEqual(await resumeBudgetStopped(fixture.companyId), { continued: 0, waiting: 1 });
  assert.equal(await statusOf(fixture, task.id), 'halted');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert').length, 1, 'and its card is the owner\'s to answer');

  // The owner's own go-on is still theirs, and not counted against it.
  const { continueHalted } = await import('../../src/engine/owner-control.ts');
  await continueHalted(fixture.companyId, task.id);
  assert.equal(await statusOf(fixture, task.id), 'pending');
});

test('another company\'s stopped work is not touched by this one\'s room', async () => {
  const mine = await createCompany('heal-mine', { tokensMax: 100_000 });
  const theirs = await createCompany('heal-theirs', { tokensMax: 100_000 });
  const stoppedMine = await stoppedTask(mine);
  const stoppedTheirs = await stoppedTask(theirs);
  await exhaust(mine);
  await exhaust(theirs);
  await room(mine, 5_000_000);
  assert.deepEqual(await resumeBudgetStopped(mine.companyId), { continued: 1, waiting: 0 });
  assert.equal(await statusOf(mine, stoppedMine.id), 'pending');
  assert.equal(await statusOf(theirs, stoppedTheirs.id), 'halted');
});
