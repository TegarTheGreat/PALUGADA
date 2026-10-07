/**
 * Work its budget stopped is gone on with in one press (the owner's complaint
 * of 6 October: "bentar-bentar habis anggaran").
 *
 * Their company had 31 tasks stopped, most "out of budget" with a cost of
 * US$0.00. The standard template's token ceilings (300,000 a month for a
 * division, 2,000,000 for the company) came to about a dollar of a typical
 * model's tokens, against money ceilings of hundreds of dollars -- so tokens
 * ran out a hundred times before money did -- and everything charged to a
 * division's account stopped together, each with a card of its own, each to be
 * opened and continued by hand after the ceiling was raised under Money.
 *
 * Now: one card for an account, however many tasks it stopped; and one press
 * that raises the ceiling (with the owner's code, as raising it always asks for
 * one) and continues every task it stopped, oldest first, for as many as the
 * account can now fund.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import * as budget from '../../src/engine/budget.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../helpers/standard-team.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let work = 0;
/** A task its budget stopped, with the card that says so. */
async function stopped(fixture: Fixture, accountId = fixture.budgetAccountId): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: accountId, goalId: fixture.goalId, input: { goal: `Riset harga ${work += 1}` }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'halted', { haltReason: 'budget_exhausted', detail: 'the budget has no tokens left' });
  await inbox.raiseBudgetHalt(fixture.companyId, task.id);
  return task.id;
}

const statusOf = async (fixture: Fixture, taskId: string) =>
  (await withTenant(fixture.companyId, (tx) => getTask(tx, taskId)))!.status;

/** An account with every token spent, so nothing can be funded until it is raised. */
const spendAll = (accountId: string) => withControlPlane((tx) => tx.query(
  'UPDATE budget_accounts SET tokens_spent = tokens_max, tokens_reserved = 0 WHERE id = $1', [accountId]));

test('the standard template\'s token ceilings are not a hundred times tighter than its money', () => {
  const { tokensMax, moneyMaxCents, divisions } = STANDARD_COMPANY_TEMPLATE.budget!;
  // A model that costs $5 for a million tokens is the middle of the field. A
  // ceiling that binds before the dollars do is a ceiling on the wrong thing.
  const dollarsAt = (tokens: number) => (tokens / 1_000_000) * 5;
  assert.ok(dollarsAt(tokensMax) >= (moneyMaxCents ?? 0) / 100 / 10, `${tokensMax} tokens are ${dollarsAt(tokensMax)} dollars of a $240 ceiling`);
  for (const one of divisions ?? []) {
    assert.ok(dollarsAt(one.tokensMax) >= (one.moneyMaxCents ?? 0) / 100 / 10, `${one.division}: ${one.tokensMax} tokens against ${(one.moneyMaxCents ?? 0) / 100} dollars`);
  }
});

test('an account that stops many tasks has one card, which says how many', async () => {
  const fixture = await createCompany('budget-one-card', { tokensMax: 5_000 });
  const first = await stopped(fixture);
  await stopped(fixture);
  await stopped(fixture);
  const open = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert');
  assert.equal(open.length, 1, 'one card, not three');
  assert.equal(open[0]!.taskId, first, 'at the first task, which it names');
  assert.deepEqual(
    [open[0]!.budgetHalt?.accountId, open[0]!.budgetHalt?.stopped, open[0]!.budgetHalt?.tokensMax],
    [fixture.budgetAccountId, 3, 5_000], 'and says how many it stopped, live');

  // Another account's halt is another card.
  const other = await withTenant(fixture.companyId, (tx) => budget.createAccount(tx, {
    companyId: fixture.companyId, label: 'growth', tokensMax: 4_000, moneyMaxCents: 100,
    scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId: fixture.budgetAccountId },
  }));
  await stopped(fixture, other);
  assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert').length, 2);
});

test('the owner raises the ceiling and continues everything it stopped, with a code only for the raise', async () => {
  const fixture = await createCompany('budget-continue-all', { tokensMax: 5_000 });
  const tasks = [await stopped(fixture), await stopped(fixture), await stopped(fixture)];
  await spendAll(fixture.budgetAccountId);
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const owner = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/budget-accounts/${fixture.budgetAccountId}/continue`;

    // What the Work page says: the tokens that ran out, not a bare "out of budget" beside a cost of nothing.
    const stoppedWork = (await api.call('GET', `/api/companies/${fixture.companyId}/work?group=stopped`, owner)).body.items;
    assert.equal(stoppedWork.length, 3);
    assert.deepEqual(stoppedWork.map((one: { budgetStop?: { tokensSpent: number; tokensMax: number } }) => [one.budgetStop?.tokensSpent, one.budgetStop?.tokensMax]),
      [[5_000, 5_000], [5_000, 5_000], [5_000, 5_000]]);

    // Nothing to fund them with: told so, by task, and nothing moves.
    const none = await api.call('POST', path, owner, {});
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.equal(none.body.continued, 0);
    assert.equal(none.body.skipped.length, 3);
    assert.match(none.body.skipped[0].code, /budget\.reservation_refused/);
    assert.deepEqual(await Promise.all(tasks.map((id) => statusOf(fixture, id))), ['halted', 'halted', 'halted']);

    // Raising is the owner's decision with their code.
    const without = await api.call('POST', path, owner, { tokensMax: 5_000_000 });
    assert.equal(without.status, 403, 'raising a ceiling asks for the code');
    assert.deepEqual(await Promise.all(tasks.map((id) => statusOf(fixture, id))), ['halted', 'halted', 'halted']);

    const done = await api.call('POST', path, owner, { tokensMax: 5_000_000, proof: { totp: api.code() } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.continued, done.body.skipped, done.body.tokensMax], [3, [], 5_000_000]);
    assert.deepEqual(await Promise.all(tasks.map((id) => statusOf(fixture, id))), ['pending', 'pending', 'pending']);
    assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert').length, 0, 'and the card is answered by going on');

    // Said again, it has nothing more to do.
    const again = await api.call('POST', path, owner, {});
    assert.deepEqual([again.body.continued, again.body.skipped], [0, []]);
  } finally {
    await api.close();
  }
});

test('as many as the account can fund are continued, oldest first, and the rest are said to be waiting for room', async () => {
  const fixture = await createCompany('budget-room', { tokensMax: 10_000 });
  const tasks = [await stopped(fixture), await stopped(fixture), await stopped(fixture)];
  // Room for two reservations of a thousand and no more.
  await withControlPlane((tx) => tx.query(
    'UPDATE budget_accounts SET tokens_spent = tokens_max - 2_500, tokens_reserved = 0 WHERE id = $1', [fixture.budgetAccountId]));
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const owner = await api.signIn();
    const done = await api.call('POST', `/api/companies/${fixture.companyId}/budget-accounts/${fixture.budgetAccountId}/continue`, owner, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.continued, 2);
    assert.deepEqual(done.body.skipped.map((one: { taskId: string }) => one.taskId), [tasks[2]]);
    assert.deepEqual(await Promise.all(tasks.map((id) => statusOf(fixture, id))), ['pending', 'pending', 'halted']);
    assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert').length, 1, 'the card stays while one is still stopped');
  } finally {
    await api.close();
  }
});

test('only what stopped on this account is continued, and only what its budget stopped', async () => {
  const fixture = await createCompany('budget-scope', { tokensMax: 5_000 });
  const other = await withTenant(fixture.companyId, (tx) => budget.createAccount(tx, {
    companyId: fixture.companyId, label: 'support', tokensMax: 4_000, moneyMaxCents: 100,
    scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId: fixture.budgetAccountId },
  }));
  const here = await stopped(fixture, other);
  const elsewhere = await stopped(fixture, fixture.budgetAccountId);
  const failed = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: other, goalId: fixture.goalId, input: { goal: 'Bukan soal anggaran' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, failed.id, 'running');
  await transition(fixture.companyId, failed.id, 'halted', { haltReason: 'policy_denied', detail: 'x' });

  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const owner = await api.signIn();
    const done = await api.call('POST', `/api/companies/${fixture.companyId}/budget-accounts/${other}/continue`, owner, {});
    assert.equal(done.body.continued, 1, JSON.stringify(done.body));
    assert.deepEqual(
      await Promise.all([here, elsewhere, failed.id].map((id) => statusOf(fixture, id))), ['pending', 'halted', 'halted'],
      'the company account\'s own task and the one a policy stopped are left as they were');
    // An account that is not this company's is refused, by name.
    const wrong = await api.call('POST', `/api/companies/${fixture.companyId}/budget-accounts/${fixture.companyId}/continue`, owner, {});
    assert.equal(wrong.status, 400);
    assert.match(String(wrong.body.error), /no budget account/);
  } finally {
    await api.close();
  }
});

/**
 * The audit of 6 October (W6): retention blanks a finished task's model turns at
 * ninety days, and continue-all (2.155) makes going on with an old halted task
 * likelier. A journal with a blanked turn cannot be replayed -- the run read
 * `undefined` where a reply had been, and failed three times -- so the task is
 * not continued, and the owner is told to do it again.
 */
test('a task whose record retention has cleared is not continued, and says to do it again', async () => {
  const fixture = await createCompany('budget-scrubbed', { tokensMax: 5_000 });
  const old = await stopped(fixture);
  const fresh = await stopped(fixture);
  await withControlPlane((tx) => tx.query(
    `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
     VALUES ($1, 0, $2, 'model:turn', 'llm', 'committed', 'h', 'k', '{"redacted":"retention"}'::jsonb, now())`, [old, fixture.companyId]));
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const owner = await api.signIn();
    const one = await api.call('POST', `/api/companies/${fixture.companyId}/tasks/${old}/continue`, owner, {});
    assert.equal(one.status, 409, JSON.stringify(one.body));
    assert.equal(one.body.code, 'task.record_cleared', 'its own code, so the console says what it means and not what a budget halt means');
    assert.match(String(one.body.error), /retention/);
    assert.match(String(one.body.error), /do it again|run it again/i);
    assert.equal(await statusOf(fixture, old), 'halted');

    // Continue-all passes it over by name and goes on with the rest.
    const all = await api.call('POST', `/api/companies/${fixture.companyId}/budget-accounts/${fixture.budgetAccountId}/continue`, owner, {});
    assert.equal(all.body.continued, 1, JSON.stringify(all.body));
    assert.deepEqual(all.body.skipped.map((entry: { taskId: string }) => entry.taskId), [old]);
    assert.equal(await statusOf(fixture, fresh), 'pending');
  } finally {
    await api.close();
  }
});
