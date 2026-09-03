/**
 * PRD F5.5, F5.6, F6.5, F6.6 -- bounding the delegation tree.
 *
 * Acceptance criterion F6.6: role A spawns role B which spawns role A with the
 * same input; the third sub-task is refused with cycle_detected.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, createSubTask, getTask } from '../../src/engine/tasks.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { assertTransition, canTransition, isTerminal } from '../../src/domain/task.ts';
import { createCompany, addRole, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function base(fixture: Fixture, goal: string) {
  return {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    input: { goal },
    reserveTokens: 1_000,
  };
}

test('delegation stops at hop_max', async () => {
  const fixture = await createCompany('hops');
  const root = await createRootTask({
    ...base(fixture, 'root'),
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    createdBy: 'owner',
    hopMax: 2,
  });

  const first = await createSubTask(root.id, { ...base(fixture, 'depth-1'), hopMax: 2 });
  assert.equal(first.hopDepth, 1);
  const second = await createSubTask(first.id, { ...base(fixture, 'depth-2'), hopMax: 2 });
  assert.equal(second.hopDepth, 2);

  await assert.rejects(
    () => createSubTask(second.id, { ...base(fixture, 'depth-3'), hopMax: 2 }),
    (error: unknown) => isPalugadaError(error, 'hop.exceeded'),
    'a delegation deeper than hop_max must be refused',
  );
});

test('a repeated role and input in the ancestor chain is refused', async () => {
  const fixture = await createCompany('cycles');
  const roleA = fixture.roleId;
  const roleB = await addRole(fixture, 'reviewer');
  const sharedInput = { goal: 'review the same thing' };

  const rootA = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: roleA,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: sharedInput,
    createdBy: 'owner',
    reserveTokens: 1_000,
    hopMax: 5,
  });

  // A -> B is fine: different role.
  const childB = await createSubTask(rootA.id, {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: roleB,
    input: sharedInput,
    reserveTokens: 1_000,
    hopMax: 5,
  });

  // B -> A with the same input closes the loop and must be refused.
  await assert.rejects(
    () => createSubTask(childB.id, {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: roleA,
      input: sharedInput,
      reserveTokens: 1_000,
      hopMax: 5,
    }),
    (error: unknown) => isPalugadaError(error, 'cycle.detected'),
    'handing identical work back to an ancestor role must be refused',
  );

  // The same role with *different* input is legitimate work, not a cycle.
  const progress = await createSubTask(childB.id, {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: roleA,
    input: { goal: 'something genuinely different' },
    reserveTokens: 1_000,
    hopMax: 5,
  });
  assert.equal(progress.hopDepth, 2);
});

test('fan-out is capped per task', async () => {
  const fixture = await createCompany('fanout');
  const root = await createRootTask({
    ...base(fixture, 'root'),
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    createdBy: 'owner',
  });

  for (let i = 0; i < 5; i += 1) {
    await createSubTask(root.id, { ...base(fixture, `child-${i}`), fanOutMax: 5 });
  }

  await assert.rejects(
    () => createSubTask(root.id, { ...base(fixture, 'child-6'), fanOutMax: 5 }),
    /fan-out limit/,
  );
});

test('a task past its deadline halts instead of continuing', async () => {
  const fixture = await createCompany('deadline');
  const task = await createRootTask({
    ...base(fixture, 'late'),
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    createdBy: 'owner',
    deadlineAt: new Date(Date.now() - 1_000),
  });

  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async () => ({ done: true })]]),
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted');
  assert.equal(outcome.reason, 'deadline.exceeded');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'halted');
  assert.equal(stored!.haltReason, 'deadline_passed');
});

test('the state machine refuses transitions the PRD does not allow', () => {
  // halted is terminal on purpose: section 6.3 says a task stopped by budget,
  // hop, deadline or verification is never resumed automatically.
  assert.ok(isTerminal('halted'));
  assert.equal(canTransition('halted', 'running'), false);
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('pending', 'completed'), false);

  assert.equal(canTransition('running', 'waiting_approval'), true);
  assert.equal(canTransition('waiting_approval', 'running'), true);
  assert.equal(canTransition('waiting_approval', 'cancelled'), true);

  assert.throws(
    () => assertTransition('halted', 'running'),
    (error: unknown) => isPalugadaError(error, 'task.invalid_transition'),
  );
});

test('a sub-division may not nest more than two levels deep', async () => {
  const fixture = await createCompany('depth');

  const subId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO divisions (company_id, parent_division_id, slug, name)
       VALUES ($1, $2, 'sub', 'Sub') RETURNING id`,
      [fixture.companyId, fixture.divisionId],
    );
    return rows[0]!.id;
  });

  // The rejected insert gets its own transaction. A failed statement aborts
  // the surrounding transaction in PostgreSQL, so sharing one with the insert
  // above would have discarded it.
  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query(
          `INSERT INTO divisions (company_id, parent_division_id, slug, name)
           VALUES ($1, $2, 'subsub', 'Sub sub')`,
          [fixture.companyId, subId],
        ),
      ),
    /divisions_depth_within_two_levels|divisions_parent_matches_depth/,
    'a third level must be refused by the database, not by convention',
  );

  // The legitimate second level is still there: the refusal above did not take
  // it down with it.
  const depths = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ depth: number }>(
      'SELECT depth FROM divisions ORDER BY depth',
    );
    return rows.map((r) => r.depth);
  });
  assert.deepEqual(depths, [0, 1]);
});

test('a role may not be configured with more than twelve tools', async () => {
  const fixture = await createCompany('tools');

  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query(
          `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, tools)
           VALUES ($1, $2, 'overloaded', 'p', 'm', $3)`,
          [fixture.companyId, fixture.divisionId, Array.from({ length: 13 }, (_, i) => `tool.${i}`)],
        ),
      ),
    /roles_at_most_twelve_tools/,
  );

  // Twelve is accepted, so the constraint is a ceiling rather than a ban.
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, tools)
       VALUES ($1, $2, 'at-the-limit', 'p', 'm', $3)`,
      [fixture.companyId, fixture.divisionId, Array.from({ length: 12 }, (_, i) => `tool.${i}`)],
    );
  });
});


/**
 * A retryable failure goes back on the queue, lease and all.
 *
 * Found by booting the platform rather than by a test: a task that failed
 * retryably stayed `running` holding a lease nobody was working, and
 * `claimTask` only claims `pending`. So the retry did not happen when the next
 * worker came round — it happened when the lease expired, half an hour later.
 * `attempt_max` of three meant three attempts spread over an hour and a half,
 * which is not what anybody reading `attempt_max` expects.
 */
test('a retryable failure returns the task to the queue, not to limbo (F5.12)', async () => {
  const fixture = await createCompany('retry-requeue');

  let attempts = 0;
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async () => {
      attempts += 1;
      throw new Error('a transient failure');
    }]]),
    workerId: 'requeue-worker',
  });

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: {},
    createdBy: 'owner',
    reserveTokens: 5_000,
    attemptMax: 3,
  });

  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.reason, 'retryable');

  const parked = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(parked!.status, 'pending', 'claimable again without waiting for a lease to expire');
  assert.equal(parked!.leaseHolder, null, 'and not appearing to belong to anybody');
  assert.equal(parked!.attempt, 1);

  // Which means the next attempt actually happens, rather than waiting out the
  // lease. Two more, and the third exhausts it.
  await engine.runTask(fixture.companyId, task.id, 'worker');
  const last = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(attempts, 3, 'three attempts, not one and a long wait');
  assert.equal(last.status, 'failed');
  const settled = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(settled!.status, 'failed');
});
