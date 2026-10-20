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
import { appendEvent } from '../../src/audit/event-log.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
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

test('a waiting task says what it waits for: the work it handed on, and the owner when something below waits on them (N9)', async () => {
  const fixture = await createCompany('waiting-why');
  const slug = (await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>(
    'SELECT slug FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!.slug;
  const hand = async (parentId: string, goal: string) => {
    const child = await createSubTask(parentId, {
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, input: { goal }, reserveTokens: 1_000,
    });
    await transition(fixture.companyId, child.id, 'running');
    return child;
  };
  const waitingOf = async (taskId: string) => (await workOf(fixture.companyId, { taskId })).items[0]!.waiting;

  // The live run: the CEO handed a plan to a planner, the planner handed a
  // part to a marketer, and the marketer asked the owner something.
  const ceo = await give(fixture, 'A week of Instagram content');
  await transition(fixture.companyId, ceo.id, 'running');
  const earlier = await hand(ceo.id, 'An earlier part, finished');
  await transition(fixture.companyId, earlier.id, 'completed', { output: { summary: 'done' } });
  const planner = await hand(ceo.id, 'Plan the week');
  const marketer = await hand(planner.id, 'Draft the posts');
  await transition(fixture.companyId, marketer.id, 'waiting_approval');
  await transition(fixture.companyId, planner.id, 'waiting_window', { waitUntil: new Date(Date.now() + 120_000), waitReason: 'child' });
  await transition(fixture.companyId, ceo.id, 'waiting_window', { waitUntil: new Date(Date.now() + 120_000), waitReason: 'child' });

  const waiting = await waitingOf(ceo.id);
  assert.equal(waiting?.reason, 'child');
  assert.ok(waiting?.until && waiting.until.getTime() > Date.now());
  assert.deepEqual(waiting?.on, { taskId: planner.id, role: slug, roleName: null }, 'the open piece, not the finished one');
  assert.deepEqual(waiting?.needsYou, { taskId: marketer.id, role: slug, roleName: null }, 'two levels down');
  assert.equal((await waitingOf(planner.id))?.needsYou?.taskId, marketer.id);

  // Answered, nothing below waits on the owner any more.
  await transition(fixture.companyId, marketer.id, 'running');
  assert.equal((await waitingOf(ceo.id))?.needsYou, null);

  // Other waits say which they are, and nothing about work below.
  const windowed = await give(fixture, 'Send the newsletter');
  await transition(fixture.companyId, windowed.id, 'running');
  await transition(fixture.companyId, windowed.id, 'waiting_window', { waitUntil: new Date(Date.now() + 3_600_000), waitReason: 'window' });
  assert.deepEqual(await waitingOf(windowed.id), { reason: 'window', until: (await waitingOf(windowed.id))!.until, on: null, needsYou: null });

  // A task that parked before the reason was kept waits for no reason given.
  const old = await give(fixture, 'An old wait');
  await transition(fixture.companyId, old.id, 'running');
  await transition(fixture.companyId, old.id, 'waiting_window', { waitUntil: new Date(Date.now() + 60_000) });
  assert.equal((await waitingOf(old.id))?.reason, null);
  await withTenant(fixture.companyId, (tx) => appendEvent(tx, {
    companyId: fixture.companyId, taskId: old.id, type: 'task.note', actor: 'system', payload: { reason: 'not a wait' },
  }));
  assert.equal((await waitingOf(old.id))?.reason, null, 'only the event that parked it is read');

  // A task that is not waiting says nothing about waiting.
  assert.equal(await waitingOf(marketer.id), null);
});
