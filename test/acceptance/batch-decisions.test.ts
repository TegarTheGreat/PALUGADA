/**
 * Batch verdicts (F10.1, F10.10).
 *
 * An owner with ten drafts waiting approved them one at a time: open, read,
 * approve, next -- ten round trips for what they had decided in one look.
 * Paperclip and Buzz both let a reviewer act on a selection. These hold what a
 * batch may do here: approve or deny several items in one go, each through the
 * same decision an item gets alone, and never the ones that must be decided
 * alone -- a tier 3 approval needs the owner's device for that one action
 * (F10.10), a question is answered in words, and an incident is looked at.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import type { Tier } from '../../src/domain/tier.ts';
import { createCompany, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function waiting(fixture: Fixture, tier: Tier, summary: string): Promise<{ taskId: string; itemId: string }> {
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: summary },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'social.publish' }]);
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'social.publish',
    tier,
    actionSummary: summary,
    rationale: 'the draft is ready',
    consequenceIfDenied: 'the post is not published',
  });
  return { taskId: task.id, itemId };
}

const statusOf = async (fixture: Fixture, taskId: string) =>
  (await withTenant(fixture.companyId, (tx) => getTask(tx, taskId)))!.status;

test('several drafts are approved in one go, each as if it were approved alone', async () => {
  const fixture = await createCompany('batch-approve');
  const drafts = [
    await waiting(fixture, 2, 'Post draft 1'),
    await waiting(fixture, 2, 'Post draft 2'),
    await waiting(fixture, 2, 'Post draft 3'),
  ];
  const left = await waiting(fixture, 2, 'Post draft 4');

  const result = await inbox.decideMany(
    fixture.companyId, drafts.map((draft) => draft.itemId), 'approve', 'all three read', { channel: 'app' },
  );
  assert.deepEqual(result.decided.sort(), drafts.map((draft) => draft.itemId).sort());
  assert.deepEqual(result.skipped, []);
  for (const draft of drafts) assert.equal(await statusOf(fixture, draft.taskId), 'running');
  assert.equal(await statusOf(fixture, left.taskId), 'waiting_approval', 'only what was chosen');

  // Each decision is on the record as its own, and says it was one of a batch.
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{
    payload: { inboxItemId: string; decision: string; note: string; batch?: string; channel: string };
  }>("SELECT payload FROM events WHERE type = 'owner.decided'"));
  assert.equal(rows.length, 3);
  const batches = new Set(rows.map((row) => row.payload.batch));
  assert.equal(batches.size, 1);
  assert.match([...batches][0] ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(rows.every((row) => row.payload.decision === 'approve' && row.payload.note === 'all three read'
    && row.payload.channel === 'app'));
  const { rows: summary } = await withTenant(fixture.companyId, (tx) => tx.query<{
    payload: { batch: string; decision: string; decided: number; skipped: number };
  }>("SELECT payload FROM events WHERE type = 'owner.decided_batch'"));
  assert.deepEqual(summary.map((row) => row.payload), [
    { batch: [...batches][0], decision: 'approve', decided: 3, skipped: 0 },
  ]);
});

test('what must be decided alone is left for the owner, and says why', async () => {
  const fixture = await createCompany('batch-alone');
  const ordinary = await waiting(fixture, 2, 'Post draft');
  const irreversible = await waiting(fixture, 3, 'Point the nameservers at the new host');
  const asked = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'price the plan' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, asked.id, 'running');
  const question = await inbox.askOwner({
    companyId: fixture.companyId, taskId: asked.id, question: 'Monthly or yearly first?',
    options: ['Monthly', 'Yearly'],
  });
  const incident = await inbox.raiseIncident({
    companyId: fixture.companyId, taskId: ordinary.taskId, title: 'The vendor answered 500 three times',
    detail: 'social.publish failed',
  });
  const closed = await waiting(fixture, 2, 'Already decided');
  await inbox.decide(fixture.companyId, closed.itemId, 'deny', 'no');

  const ids = [ordinary.itemId, irreversible.itemId, question.inboxItemId, incident, closed.itemId];
  const approved = await inbox.decideMany(fixture.companyId, ids, 'approve', '', { channel: 'app' });
  assert.deepEqual(approved.decided, [ordinary.itemId]);
  const why = Object.fromEntries(approved.skipped.map((skip) => [skip.itemId, skip.reason]));
  assert.match(why[irreversible.itemId]!, /tier 3 .* one at a time/);
  assert.match(why[question.inboxItemId]!, /answered in words/);
  assert.match(why[incident]!, /looked at one at a time/);
  assert.match(why[closed.itemId]!, /already decided/);
  assert.equal(await statusOf(fixture, irreversible.taskId), 'waiting_approval', 'no tier 3 action ran in a batch');
  assert.equal(await statusOf(fixture, asked.id), 'waiting_approval');

  // Saying no is never the dangerous direction: a batch may deny any of them.
  const denied = await inbox.decideMany(
    fixture.companyId, [irreversible.itemId, question.inboxItemId, incident], 'deny', 'not now', { channel: 'app' },
  );
  assert.equal(denied.decided.length, 3);
  assert.equal(await statusOf(fixture, irreversible.taskId), 'cancelled');
  assert.equal(await statusOf(fixture, asked.id), 'cancelled');
});

test('a batch is a list of this company\'s items, of a sane size, approving or denying', async () => {
  const fixture = await createCompany('batch-bounds');
  const other = await createCompany('batch-other');
  const mine = await waiting(fixture, 2, 'Post draft');
  const theirs = await waiting(other, 2, 'Their draft');

  const refused = (pattern: RegExp) => (error: unknown) =>
    isPalugadaError(error, 'contract.violation') && pattern.test((error as Error).message);
  await assert.rejects(inbox.decideMany(fixture.companyId, [], 'approve'), refused(/1 to 50/));
  await assert.rejects(
    inbox.decideMany(fixture.companyId, Array.from({ length: 51 }, () => mine.itemId), 'approve'),
    refused(/1 to 50/),
  );
  await assert.rejects(inbox.decideMany(fixture.companyId, [mine.itemId], 'ask' as never), refused(/approve or deny/));
  await assert.rejects(inbox.decideMany(fixture.companyId, ['not-a-uuid'], 'approve'), refused(/not an item id/));

  // Another company's item is not there at all from here.
  const result = await inbox.decideMany(fixture.companyId, [theirs.itemId, mine.itemId, mine.itemId], 'approve');
  assert.deepEqual(result.decided, [mine.itemId], 'once, however often it is listed');
  assert.deepEqual(result.skipped.map((skip) => skip.itemId), [theirs.itemId]);
  assert.match(result.skipped[0]!.reason, /does not exist/);
  assert.equal(await statusOf(other, theirs.taskId), 'waiting_approval');
});
