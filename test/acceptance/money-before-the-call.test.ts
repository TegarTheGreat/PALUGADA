/**
 * Money is looked at before a model is asked, and a call the budget refused
 * afterwards is still on the books (the audit of 10 October: "a company whose
 * token room is large but whose money is gone still has each in-flight run
 * make a call", and the call's cost never reached the account that refused it).
 *
 * Before a turn the loop asks how much room there is, and the room was counted
 * in tokens alone: a month whose money was spent and whose tokens were not let
 * every running task ask the model once more, and pay for it. And when the
 * charge after a call was refused, the trace was written and the account was
 * not, so the Money page and the next ceiling check were short by what the
 * provider billed.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import type { LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { answering } from '../helpers/done.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A model that answers at once, at a price the test sets, and counts how often it was asked. */
class PricedModel implements ToolUsingLlmClient {
  asked = 0;
  readonly cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.asked += 1;
    return {
      content: [{ type: 'text', text: `Done.\n\`\`\`json\n${answering(request.system, { address: '192.0.2.7' })}\n\`\`\`` }],
      stopReason: 'end_turn', inputTokens: 1_000, outputTokens: 100, costCents: this.cents, model: 'priced-1',
    };
  }
  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

async function task(fixture: Fixture) {
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'find the address of example.test' }, createdBy: 'owner', reserveTokens: 10_000,
  });
}

/** The account's money: what it may spend and what it has. */
async function money(fixture: Fixture, set?: { max: number; spent: number }) {
  return withControlPlane(async (tx) => {
    if (set) {
      await tx.query('UPDATE budget_accounts SET money_max_cents = $2, money_spent_cents = $3 WHERE id = $1',
        [fixture.budgetAccountId, set.max, set.spent]);
    }
    const { rows: [row] } = await tx.query<{ max: string; spent: string }>(
      'SELECT money_max_cents AS max, money_spent_cents AS spent FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId]);
    return { max: Number(row!.max), spent: Number(row!.spent) };
  });
}

test('a run whose money is spent asks the model nothing, though tokens are left', async () => {
  const fixture = await createCompany('money-gone');
  await money(fixture, { max: 500, spent: 500 });
  const model = new PricedModel(3);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'money-worker', llm: model, handlers: new Map() });

  const outcome = await engine.runTask(fixture.companyId, (await task(fixture)).id, 'worker');
  assert.equal(outcome.status, 'halted', outcome.reason);
  assert.equal(model.asked, 0, 'no call was made that nothing could pay for');
  assert.deepEqual(await money(fixture), { max: 500, spent: 500 }, 'and nothing was spent');
});

test('a call the budget refused after it was made is on the books all the same', async () => {
  const fixture = await createCompany('money-billed');
  // Two cents of room, and the call costs ten: it is made -- the room was
  // there when it was asked -- and the charge after it is refused.
  await money(fixture, { max: 500, spent: 498 });
  const model = new PricedModel(10);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'money-worker', llm: model, handlers: new Map() });

  const run = await task(fixture);
  const outcome = await engine.runTask(fixture.companyId, run.id, 'worker');
  assert.equal(outcome.status, 'halted', outcome.reason);
  assert.equal(model.asked, 1);
  // The provider billed ten cents: the account says so, above its ceiling,
  // as the trace does. A refusal stops the next call; it does not un-bill this one.
  assert.deepEqual(await money(fixture), { max: 500, spent: 508 });
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ cost_cents: number }>(
    'SELECT cost_cents FROM llm_traces WHERE task_id = $1', [run.id]));
  assert.deepEqual(rows.map((row) => row.cost_cents), [10]);
});
