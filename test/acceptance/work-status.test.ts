/**
 * What the Work page says about a task is true (N9, the live run of
 * 2 October).
 *
 * Three things on it were not. A halted task showed a full bar, "5/5": the
 * bar divided the steps its journal had committed -- every model turn and
 * every tool call -- by the actions its plan named, two different counts,
 * and a run that thought five times had "done" a five-step plan. A CEO whose
 * sub-task was waiting on the owner two levels down showed "Scheduled", the
 * word for every kind of wait at once. And a deletion that did not happen
 * showed "Done".
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { recordPlan } from '../../src/engine/plan.ts';
import { workOf } from '../../src/owner/views.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function give(fixture: Fixture, goal: string) {
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  });
}

/** Writes a task's journal: each step a name, a kind and how it ended. */
async function journal(fixture: Fixture, taskId: string, steps: Array<[string, 'llm' | 'tool', 'committed' | 'failed' | 'started']>) {
  await withTenant(fixture.companyId, async (tx) => {
    for (const [index, [name, kind, status]] of steps.entries()) {
      await tx.query(
        `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash,
                                 idempotency_key, output, committed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'h', $7, $8, $9)`,
        [taskId, index, fixture.companyId, name, kind, status, `k-${taskId}-${index}`,
          status === 'committed' ? '{}' : null, status === 'committed' ? new Date() : null],
      );
    }
  });
}

const progressOf = async (fixture: Fixture, taskId: string) =>
  (await workOf(fixture.companyId, { taskId })).items[0]!.progress;

test('a task\'s progress is the actions of its plan it has taken, not every step it journalled (N9)', async () => {
  const fixture = await createCompany('plan-progress');
  const task = await give(fixture, 'Answer the three oldest emails');
  await transition(fixture.companyId, task.id, 'running');
  await recordPlan(fixture.companyId, task.id, [
    { capability: 'crm.read', intent: 'read the first customer', expectedEffect: 'their history is known' },
    { capability: 'crm.read', intent: 'read the second customer', expectedEffect: 'their history is known' },
    { capability: 'email.draft', intent: 'draft the answers', expectedEffect: 'three drafts exist' },
  ]);
  // Five model turns and four tool calls: one read the plan did not name,
  // two that it did, and a draft that failed.
  await journal(fixture, task.id, [
    ['model:turn 1', 'llm', 'committed'],
    ['capability:plan.record', 'tool', 'committed'],
    ['model:turn 2', 'llm', 'committed'],
    ['capability:crm.read', 'tool', 'committed'],
    ['model:turn 3', 'llm', 'committed'],
    ['capability:crm.read', 'tool', 'committed'],
    ['model:turn 4', 'llm', 'committed'],
    ['capability:email.draft', 'tool', 'failed'],
    ['model:turn 5', 'llm', 'committed'],
  ]);

  const running = await progressOf(fixture, task.id);
  assert.equal(running.planSteps, 3);
  assert.equal(running.planDone, 2, 'the two reads it planned; not the plan itself, not the draft that failed');
  assert.equal(running.stepsDone, 8, 'what the journal committed is still counted, as steps');

  // Halted there, it says where it stopped: two of three, not "5/5".
  await transition(fixture.companyId, task.id, 'halted', { haltReason: 'budget_exhausted' });
  assert.equal((await progressOf(fixture, task.id)).planDone, 2);

  // A read the plan named once, made three times, is one action of the plan.
  const again = await give(fixture, 'Read one customer');
  await transition(fixture.companyId, again.id, 'running');
  await recordPlan(fixture.companyId, again.id, [
    { capability: 'crm.read', intent: 'read the customer', expectedEffect: 'their history is known' },
  ]);
  await journal(fixture, again.id, [
    ['capability:crm.read', 'tool', 'committed'],
    ['capability:crm.read', 'tool', 'committed'],
    ['capability:crm.read', 'tool', 'committed'],
  ]);
  assert.deepEqual([(await progressOf(fixture, again.id)).planDone, (await progressOf(fixture, again.id)).planSteps], [1, 1]);

  // No plan, nothing to count against.
  const unplanned = await give(fixture, 'Think about pricing');
  assert.deepEqual([(await progressOf(fixture, unplanned.id)).planDone, (await progressOf(fixture, unplanned.id)).planSteps], [null, null]);
});
