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
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
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
    goalId: fixture.goalId,
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
    goalId: fixture.goalId,
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
    goalId: fixture.goalId,
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

/**
 * A task's reservation is drawn down once, however many calls it makes.
 *
 * Every model call handed the whole reservation, as it stood when the run
 * began, to the charge: each took up to that much off the account's reserved
 * total while the task's own figure never moved, and the terminal release
 * took it off once more. Three calls by one task erased its sibling's
 * reservation, and admission control let in work the budget could not fund.
 */
test('a task spending past its reservation does not eat its siblings\' (F5.4)', async () => {
  const fixture = await createCompany('budget-draw-down', { tokensMax: TOKENS_MAX });
  const { Engine } = await import('../../src/engine/engine.ts');
  const { CapabilityBroker } = await import('../../src/broker/broker.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { RecordingLlmClient } = await import('../../src/llm/client.ts');

  const reserved = async () => (await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId))).tokensReserved;
  const create = (goal: string, reserveTokens: number) => createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal },
    createdBy: 'owner',
    reserveTokens,
  });

  // Every call is 150 tokens; the spender holds 200 and makes three.
  const spender = await create('three calls', 200);
  await create('the sibling', 1_000);
  let during = -1;
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      for (let call = 0; call < 3; call += 1) {
        await ctx.llm({ system: 's', messages: [{ role: 'user', content: `call ${call}` }] });
      }
      during = await reserved();
      return {};
    }]]),
  });

  const outcome = await engine.runTask(fixture.companyId, spender.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal(during, 1_000, 'the spender used up its own 200, and only its own');
  assert.equal(await reserved(), 1_000, 'and finishing gave back nothing it had not already used');
});

/**
 * A narrower account that says nothing about money is not an account that
 * may spend nothing. It got zero, and `budget_spend` refuses past the
 * ceiling, so every task drawing on a division account opened with only a
 * token ceiling halted at its first priced model call.
 */
test('a scoped account opened without a money ceiling inherits its parent\'s (F1.6)', async () => {
  const fixture = await createCompany('budget-money-inherit', { tokensMax: TOKENS_MAX });
  const money = await withTenant(fixture.companyId, async (tx) => {
    const division = await budget.createAccount(tx, {
      companyId: fixture.companyId,
      label: 'ops',
      tokensMax: 1_000,
      scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId: fixture.budgetAccountId },
    });
    const { rows } = await tx.query<{ own: string; parent: string }>(
      `SELECT child.money_max_cents::text AS own, parent.money_max_cents::text AS parent
         FROM budget_accounts child JOIN budget_accounts parent ON parent.id = child.parent_account_id
        WHERE child.id = $1`,
      [division],
    );
    return rows[0]!;
  });
  assert.equal(money.own, money.parent);
  assert.notEqual(money.own, '0', 'the fixture\'s company account can spend');
});


/**
 * Two accounts on one scope: which pays is decided, not left to the order
 * rows happen to lie in. The owner can open an account on a division that
 * already has one -- "Ramadan promotion" under Operations -- and the task was
 * charged to whichever of the two the database read first, which moves every
 * time a charge rewrites a row. The narrowest pays: the one deeper in the
 * tree, and between two as deep, the older.
 */
test('of two accounts on one scope, the deeper pays, every time (F1.6)', async () => {
  const fixture = await createCompany('budget-same-scope', { tokensMax: TOKENS_MAX });
  const open = (label: string, parentAccountId: string) => withTenant(fixture.companyId, (tx) => budget.createAccount(tx, {
    companyId: fixture.companyId, label, tokensMax: 10_000,
    scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId },
  }));
  const scope = { companyId: fixture.companyId, roleId: fixture.roleId, divisionId: fixture.divisionId, projectId: fixture.projectId };
  // Each update writes the row again somewhere else in the table, as every
  // charge does, and asks again which account pays.
  const payerAfterMoving = async (moved: string) => {
    await withControlPlane((tx) => tx.query(
      'UPDATE budget_accounts SET tokens_reserved = tokens_reserved WHERE id = $1', [moved]));
    return withTenant(fixture.companyId, (tx) => budget.accountFor(tx, scope));
  };

  // Two as deep, both under the company's: the older.
  const division = await open('ops', fixture.budgetAccountId);
  const sibling = await open('Later beside ops', fixture.budgetAccountId);
  for (const moved of [division, sibling, division]) {
    assert.equal(await payerAfterMoving(moved), division);
  }

  // One under the other: the deeper.
  const promotion = await open('Ramadan promotion', division);
  for (const moved of [promotion, division, sibling, promotion, division]) {
    assert.equal(await payerAfterMoving(moved), promotion);
  }
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Plan the Ramadan promotion' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  assert.equal(task.budgetAccountId, promotion, 'the task is charged to it');
});
