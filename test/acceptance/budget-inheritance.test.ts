/**
 * PRD F5.4 and principle 8 -- budget is inherited, not re-granted.
 *
 * Acceptance criterion: a parent task with a 100k token budget spawns three
 * sub-tasks; the total consumed by the three plus the parent never exceeds
 * 100k, and a fourth sub-task is refused once the remainder falls below the
 * minimum.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
import * as budget from '../../src/engine/budget.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const TOKENS_MAX = 100_000;
const RESERVE_PER_TASK = 25_000;

test('sub-tasks draw on the parent account and the fourth is refused', async () => {
  const fixture = await createCompany('budget', { tokensMax: TOKENS_MAX });

  const parent = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { goal: 'parent' },
    createdBy: 'owner',
    reserveTokens: RESERVE_PER_TASK,
  });

  const children = [];
  for (let i = 0; i < 3; i += 1) {
    children.push(
      await createSubTask(parent.id, {
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        divisionId: fixture.divisionId,
        roleId: fixture.roleId,
        input: { goal: `child-${i}` },
        reserveTokens: RESERVE_PER_TASK,
      }),
    );
  }

  // Every child points at the parent's account. This is the whole of F5.4: a
  // sub-task cannot mint budget simply by existing.
  for (const child of children) {
    assert.equal(child.budgetAccountId, parent.budgetAccountId);
    assert.equal(child.hopDepth, 1);
  }

  const afterThree = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  assert.equal(afterThree.tokensReserved, 4 * RESERVE_PER_TASK,
    'the parent and its three children hold the whole ceiling in reservations');

  // The fourth sub-task finds nothing left to reserve.
  await assert.rejects(
    () => createSubTask(parent.id, {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      input: { goal: 'child-4' },
      reserveTokens: RESERVE_PER_TASK,
    }),
    (error: unknown) => isPalugadaError(error, 'budget.reservation_refused'),
    'a fourth sub-task must be refused rather than admitted to fail later',
  );
});

test('total spend across the tree never exceeds the ceiling', async () => {
  const fixture = await createCompany('budget-cap', { tokensMax: TOKENS_MAX });

  const parent = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { goal: 'spender' },
    createdBy: 'owner',
    reserveTokens: RESERVE_PER_TASK,
  });

  // Spend in 10k chunks until the account refuses. The refusal must arrive
  // before the ceiling is breached, not after.
  let accepted = 0;
  for (let i = 0; i < 20; i += 1) {
    const ok = await withTenant(fixture.companyId, (tx) =>
      budget.spend(tx, parent.budgetAccountId, { tokens: 10_000, fromReservation: 0 }),
    );
    if (!ok) break;
    accepted += 10_000;
  }

  const snapshot = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  assert.equal(accepted, TOKENS_MAX);
  assert.equal(snapshot.tokensSpent, TOKENS_MAX);
  assert.ok(snapshot.tokensSpent <= snapshot.tokensMax, 'the ceiling is a hard limit');
});

test('concurrent sub-tasks cannot overspend the shared counter', async () => {
  // F5.7 allows concurrency within a division, so the budget guard has to be
  // race-free. A read-then-write in application code would let ten callers all
  // observe "there is room" before any of them writes; the guard therefore
  // lives in the WHERE clause of a single statement.
  const fixture = await createCompany('budget-race', { tokensMax: TOKENS_MAX });

  const attempts = await Promise.all(
    Array.from({ length: 10 }, () =>
      withTenant(fixture.companyId, (tx) =>
        budget.reserve(tx, fixture.budgetAccountId, RESERVE_PER_TASK),
      ),
    ),
  );

  const granted = attempts.filter(Boolean).length;
  assert.equal(granted, TOKENS_MAX / RESERVE_PER_TASK,
    'exactly as many reservations as the ceiling affords, no matter the interleaving');

  const snapshot = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  assert.ok(snapshot.tokensReserved <= snapshot.tokensMax);
});

test('a terminal task releases the allowance it was holding', async () => {
  const fixture = await createCompany('budget-release', { tokensMax: TOKENS_MAX });

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { goal: 'short-lived' },
    createdBy: 'owner',
    reserveTokens: RESERVE_PER_TASK,
  });

  const held = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  assert.equal(held.tokensReserved, RESERVE_PER_TASK);

  await transition(fixture.companyId, task.id, 'cancelled');

  const released = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  assert.equal(released.tokensReserved, 0,
    'a task that will never run again must not keep siblings out');
});
