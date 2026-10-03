/**
 * Work stopped by its budget reaches the owner (PRD section 6.3, F5.4).
 *
 * Section 6.3: a task whose budget runs out halts and goes to the inbox, and
 * is never resumed automatically. On the live run of 2 October two tasks of
 * the CEO's halted "budget_exhausted" and nothing reached the owner: no item,
 * no incident, only a red bar on a page they had to think of opening. And
 * the owner who then raised the ceiling could not go on with the work, only
 * start it again from nothing.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { continueHalted } from '../../src/engine/owner-control.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import type { LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
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
      return { output: { summary: 'spent' } };
    },
  });
  return adapters;
}

async function engineFor(tokens: number): Promise<Engine> {
  const registry = new CapabilityRegistry();
  await registry.sync();
  return new Engine({ broker: new CapabilityBroker(registry), adapters: spender(tokens), workerId: 'budget-worker' });
}

async function poorTask(fixture: Fixture, goal: string) {
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'spender', backend = 'local' WHERE id = $1", [fixture.roleId]));
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  });
}

test('a task its budget cannot pay for halts and puts an item in front of the owner, in their language (section 6.3)', async () => {
  const fixture = await createCompany('budget-halt', { tokensMax: 5_000 });
  await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id'"));
  await withControlPlane((tx) => tx.query("UPDATE budget_accounts SET label = 'growth' WHERE id = $1", [fixture.budgetAccountId]));
  const task = await poorTask(fixture, 'Buat rencana konten Instagram tujuh hari');

  const outcome = await (await engineFor(9_000)).runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['halted', 'budget_exhausted']);

  const open = await inbox.listOpen(fixture.companyId);
  assert.equal(open.length, 1, 'the halt is in the inbox');
  const item = open[0]!;
  assert.equal(item.kind, 'budget_alert');
  assert.equal(item.taskId, task.id, 'and leads to the task that stopped');
  assert.equal(item.title, 'Pekerjaan berhenti: token akun growth habis');
  assert.match(item.rationale, /Buat rencana konten Instagram tujuh hari/, 'it names the work');
  assert.match(item.rationale, /growth/);
  assert.match(item.rationale, /Naikkan plafonnya di Keuangan/, 'and says what to do');

  // Once per task: a task that halted is not raised again by the next look.
  const again = await (await engineFor(9_000)).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(again.status, 'halted');
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);
});

test('a month\'s money running out does not raise a second item beside the monthly one', async () => {
  // spend.paused halts as budget_exhausted too; it has its own item, the one
  // the spend guard raises when the month's ceiling is reached.
  const fixture = await createCompany('budget-paused');
  const task = await poorTask(fixture, 'Write the restock note');
  await withControlPlane((tx) => tx.query(
    `INSERT INTO spend_limits (company_id, paused_at, pause_reason) VALUES ($1, now(), 'test')
     ON CONFLICT (company_id) DO UPDATE SET paused_at = now(), pause_reason = 'test'`, [fixture.companyId]));
  const outcome = await (await engineFor(10)).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted');
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.taskId === task.id).length, 0);
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'halted');
});

test('the owner goes on with a task its budget stopped, from where it stopped, once the ceiling is raised (section 6.3)', async () => {
  const fixture = await createCompany('budget-continue', { tokensMax: 5_000 });
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'drafter', backend = 'local' WHERE id = $1", [fixture.roleId]));
  // A run that drafts -- one journalled step, counted each time it really
  // runs -- and then makes a model call bigger than the account.
  let drafted = 0;
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'drafter',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run(_request, services) {
      const draft = await services.step('draft', 'tool', { day: 1 }, async () => {
        drafted += 1;
        return { text: 'Day 1: the iced palm-sugar coffee.' };
      });
      await services.reportUsage({ model: 'test-model', inputTokens: 9_000, outputTokens: 0, costCents: 0 });
      return {
        output: {
          summary: draft.text,
          done: [{ criterion: 'the run returns an output matching its schema', met: true, evidence: 'this output' }],
        },
      };
    },
  });
  const registry = new CapabilityRegistry();
  await registry.sync();
  const engine = new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'continue-worker' });
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Plan the week of posts' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).reason, 'budget_exhausted');
  assert.equal(drafted, 1);

  // Nothing to fund it with: refused, and the task and its card stay as they were.
  await withControlPlane((tx) => tx.query('UPDATE budget_accounts SET tokens_spent = tokens_max WHERE id = $1', [fixture.budgetAccountId]));
  await assert.rejects(continueHalted(fixture.companyId, task.id),
    (error: unknown) => isPalugadaError(error, 'budget.reservation_refused') && /Raise the ceiling under Money/.test((error as Error).message));
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'halted');
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);

  // Raised, it goes on: the same task, pending again, holding a reservation.
  await withControlPlane((tx) => tx.query('UPDATE budget_accounts SET tokens_max = 50_000 WHERE id = $1', [fixture.budgetAccountId]));
  await continueHalted(fixture.companyId, task.id);
  const continued = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.deepEqual([continued.status, continued.haltReason, continued.tokensReserved], ['pending', null, 1_000]);
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 0, 'the card that said it stopped is answered');
  const { rows: closed } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    "SELECT status, closed_reason FROM inbox_items WHERE task_id = $1 AND kind = 'budget_alert'", [task.id]));
  assert.deepEqual(closed, [{ status: 'withdrawn', closed_reason: 'task_continued' }]);

  // And it finishes from where it stopped: the draft is the journal's, not made again.
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal(drafted, 1, 'what it already did was not done again');
  const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string }>(
    "SELECT type FROM events WHERE task_id = $1 AND type IN ('task.halted', 'task.continued', 'task.completed') ORDER BY occurred_at, id",
    [task.id]));
  assert.deepEqual(events.map((event) => event.type), ['task.halted', 'task.continued', 'task.completed'], 'its history says both');

  // Once: a second press finds it no longer halted.
  await assert.rejects(continueHalted(fixture.companyId, task.id), (error: unknown) => isPalugadaError(error, 'task.not_continuable'));
});

test('only a budget halt is continued; anything else is done again', async () => {
  const fixture = await createCompany('budget-not-continuable');
  const task = await poorTask(fixture, 'Renew the domain');
  await transition(fixture.companyId, task.id, 'halted', { haltReason: 'deadline_passed' });
  await assert.rejects(continueHalted(fixture.companyId, task.id),
    (error: unknown) => isPalugadaError(error, 'task.not_continuable') && /deadline_passed/.test((error as Error).message));
  const live = await poorTask(fixture, 'Write the note');
  await assert.rejects(continueHalted(fixture.companyId, live.id), (error: unknown) => isPalugadaError(error, 'task.not_continuable'));
});

/** A model that answers with nothing but thinking, and records what it was asked. */
class ThinkingModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    return { content: [], stopReason: 'max_tokens', inputTokens: 12_000, outputTokens: request.maxTokens ?? 0, costCents: 1, model: 'thinker-1' };
  }
  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

async function longTask(fixture: Fixture) {
  // About ten thousand tokens of brief, so a turn sends at least that much.
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `Plan the launch. ${'Every detail of the menu, the prices and the posts. '.repeat(780)}` },
    createdBy: 'owner', reserveTokens: 1_000,
  });
}

test('a turn the budget could not pay for is not asked of the model at all (B1)', async () => {
  // The provider bills a call whether or not the budget then refuses to
  // record it, so finding out after the call is finding out after paying.
  const fixture = await createCompany('budget-no-call', { tokensMax: 6_000 });
  const model = new ThinkingModel();
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'think-worker', llm: model, handlers: new Map() });
  const task = await longTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.deepEqual([outcome.status, outcome.reason], ['halted', 'budget_exhausted']);
  assert.equal(model.requests.length, 0, 'no call the budget could not pay for');
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'and the owner is told');
});

test('a turn is given no more room to write than the budget has left (B1)', async () => {
  // The live run of 30 September: each empty turn of a reasoning model was
  // asked again with twice the room, and each time the whole conversation
  // was sent again, until a division's tokens were gone in one task.
  const fixture = await createCompany('budget-room', { tokensMax: 15_000 });
  const model = new ThinkingModel();
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'think-worker', llm: model, handlers: new Map() });
  const task = await longTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.ok(model.requests.length >= 1);
  const first = model.requests[0]!.maxTokens!;
  assert.ok(first < 8_192, `the first turn may write ${first}, less than its usual 8192: the budget has less than that left after what it sends`);
  assert.ok(first >= 512, 'and still enough to say something');
});
