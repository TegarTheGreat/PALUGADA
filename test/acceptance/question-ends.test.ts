/**
 * A question ends with the task that asked it (the audit of 6 October, S3).
 *
 * `owner.ask` raises a card with no expiry, to unblock one task parked in
 * `waiting_approval`. 0036 withdrew an approval when its task ended some other
 * way and left every other kind, so a question whose task was cancelled, stopped
 * or finished stayed open in the inbox for ever, asking for an answer nobody
 * could use. An escalation about a task is another thing -- usually why it
 * ended -- and is left where it is.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { cancelTask } from '../../src/engine/owner-control.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let made = 0;
async function runningTask(fixture: Fixture) {
  made += 1;
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `work ${made}` }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task;
}

const itemOf = (fixture: Fixture, id: string) => withTenant(fixture.companyId, async (tx) => (await tx.query<{
  status: string; closed_reason: string | null;
}>('SELECT status, closed_reason FROM inbox_items WHERE id = $1', [id])).rows[0]!);

test('a question its task no longer needs is withdrawn, with why, and the timeline says so', async () => {
  const fixture = await createCompany('question-ends');
  const task = await runningTask(fixture);
  const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Which customers first?' });
  assert.equal((await itemOf(fixture, asked.inboxItemId)).status, 'open');

  await cancelTask(fixture.companyId, task.id, 'not needed any more');
  assert.deepEqual(await itemOf(fixture, asked.inboxItemId), { status: 'withdrawn', closed_reason: 'task_cancelled' });
  assert.equal((await inbox.listOpen(fixture.companyId)).some((one) => one.id === asked.inboxItemId), false, 'no longer in the inbox');
  const events = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ payload: { inboxItemId: string } }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'approval.withdrawn'", [task.id])).rows);
  assert.deepEqual(events.map((one) => one.payload.inboxItemId), [asked.inboxItemId]);
});

test('an escalation about a task is not a question, and stays for the owner when the task ends', async () => {
  const fixture = await createCompany('escalation-stays');
  const task = await runningTask(fixture);
  await transition(fixture.companyId, task.id, 'halted', { haltReason: 'policy_denied', detail: 'refused by a policy' });
  const raised = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO inbox_items (company_id, task_id, kind, title, action_summary, rationale, consequence_if_denied, payload)
     VALUES ($1, $2, 'escalation', 'A task ended', 'A task ended', 'why', 'nothing', '{"endedTaskIds": []}'::jsonb) RETURNING id`,
    [fixture.companyId, task.id])).rows[0]!.id);
  const second = await runningTask(fixture);
  const stillOpen = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO inbox_items (company_id, task_id, kind, title, action_summary, rationale, consequence_if_denied, payload)
     VALUES ($1, $2, 'escalation', 'Why it ended', 'Why it ended', 'why', 'nothing', '{}'::jsonb) RETURNING id`,
    [fixture.companyId, second.id])).rows[0]!.id);
  await transition(fixture.companyId, second.id, 'halted', { haltReason: 'hop_limit', detail: 'too many hops' });
  assert.equal((await itemOf(fixture, raised)).status, 'open');
  assert.equal((await itemOf(fixture, stillOpen)).status, 'open', 'what the owner needs to read is still there');
});
