/**
 * A budget account's counts start again each month (F1.9, defect L11).
 *
 * F1.9 sets a budget per period -- monthly -- beside the per-task one. An
 * account's tokens were counted for its whole life: spent once, spent for
 * ever, so a company that ran out stopped until the owner raised the ceiling,
 * and a division that ran out in October was still out in December. On the
 * live run of 2 October one request spent 96% of a division's allowance, which
 * would never have come back.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import * as budget from '../../src/engine/budget.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** Puts an account's counts in last month, spent to its ceilings. */
async function spentLastMonth(accountId: string): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `UPDATE budget_accounts
        SET tokens_spent = tokens_max, money_max_cents = 500, money_spent_cents = 500,
            period_start = date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 month'
      WHERE id = $1`,
    [accountId]));
}

test('an account spent last month has its tokens and money again this month (F1.9, L11)', async () => {
  const fixture = await createCompany('period-renews', { tokensMax: 5_000 });
  const division = await withTenant(fixture.companyId, (tx) => budget.createAccount(tx, {
    companyId: fixture.companyId, label: 'growth', tokensMax: 3_000,
    scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId: fixture.budgetAccountId },
  }));
  await spentLastMonth(fixture.budgetAccountId);
  await spentLastMonth(division);

  // Admission counts this month: the division and the company above it both
  // start again, so the reservation goes through.
  assert.equal(await withTenant(fixture.companyId, (tx) => budget.reserve(tx, division, 1_000)), true);
  for (const account of [division, fixture.budgetAccountId]) {
    const now = await withTenant(fixture.companyId, (tx) => budget.snapshot(tx, account));
    assert.deepEqual([now.tokensSpent, now.tokensReserved, now.moneySpentCents], [0, 1_000, 0]);
  }

  // Spent to the ceiling this month, it stays spent until the next one.
  await withControlPlane((tx) => tx.query(
    'UPDATE budget_accounts SET tokens_spent = tokens_max - tokens_reserved WHERE id = $1', [division]));
  assert.equal(await withTenant(fixture.companyId, (tx) => budget.reserve(tx, division, 1)), false);
});

test('a charge counts against this month, starting it again first when it is new (F1.9, L11)', async () => {
  const fixture = await createCompany('period-spend', { tokensMax: 5_000 });
  await spentLastMonth(fixture.budgetAccountId);
  assert.equal(await withTenant(fixture.companyId, (tx) => budget.spend(tx, fixture.budgetAccountId, { tokens: 400, moneyCents: 3 })), true);
  const now = await withTenant(fixture.companyId, (tx) => budget.snapshot(tx, fixture.budgetAccountId));
  assert.deepEqual([now.tokensSpent, now.moneySpentCents], [400, 3]);
});

test('the worker starts a passed month again on its own, so the Money page reads this month (F1.9, L11)', async () => {
  // Nothing may reserve or charge on the first of the month, and the owner
  // looking at Money then should not see last month's count as this one's.
  const fixture = await createCompany('period-tick', { tokensMax: 5_000 });
  await spentLastMonth(fixture.budgetAccountId);
  assert.equal(await budget.startNewPeriods(fixture.companyId), 1);
  const now = await withTenant(fixture.companyId, (tx) => budget.snapshot(tx, fixture.budgetAccountId));
  assert.deepEqual([now.tokensSpent, now.moneySpentCents], [0, 0]);
  assert.equal(await budget.startNewPeriods(fixture.companyId), 0, 'once a month');
});
