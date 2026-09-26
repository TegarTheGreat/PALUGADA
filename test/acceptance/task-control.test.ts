/**
 * The owner's controls over one piece of work.
 *
 * Paperclip lets its board cancel a run, pause an agent and retry an issue;
 * Buzz lets a person stop a turn or steer it. Here the brakes were for the
 * whole platform or a whole company, so one runaway task meant freezing six
 * divisions that were fine, and a task halted by something passing -- a key
 * rotated, a vendor down for an hour -- could not be tried again at all.
 *
 * These hold the four controls that close that: cancel a task and what it
 * started, and nothing else; do a finished or stopped task again with a note,
 * once; tell a task something it reads on its next run; and pause a role.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createRootTask, createSubTask, getTask, transition } from '../../src/engine/tasks.ts';
import { cancelTask, instructTask, rerunTask } from '../../src/engine/owner-control.ts';
import { pauseRole } from '../../src/governance/role-freeze.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;

async function task(fixture: Fixture, goal = 'reconcile the invoices') {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `${goal} (${sequence})` },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });
}

async function reserved(fixture: Fixture): Promise<number> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ tokens_reserved: string }>(
    'SELECT tokens_reserved FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId]));
  return Number(rows[0]!.tokens_reserved);
}

async function state(fixture: Fixture, taskId: string) {
  const row = await withTenant(fixture.companyId, (tx) => getTask(tx, taskId));
  return { status: row!.status, haltReason: row!.haltReason };
}

test('cancelling a task stops it and what it started, releases its money, and nothing else', async () => {
  const fixture = await createCompany('control-cancel');
  const parent = await task(fixture);
  await transition(fixture.companyId, parent.id, 'running');
  // Held by a worker, as a running task is: clearing the lease is how that
  // worker finds out.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE tasks SET lease_holder = 'worker-1', lease_expires_at = now() + interval '5 minutes' WHERE id = $1",
    [parent.id]));
  const child = await createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, goalId: fixture.goalId, input: { goal: 'check one invoice' }, reserveTokens: 500,
  });
  const bystander = await task(fixture, 'unrelated');
  const approvalId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: parent.id, capabilityName: 'payment.send', tier: 2,
    actionSummary: 'Pay the supplier', rationale: 'The invoice matched.', consequenceIfDenied: 'Unpaid.',
  });
  const before = await reserved(fixture);

  assert.equal(await cancelTask(fixture.companyId, parent.id, 'wrong supplier'), 2);

  assert.deepEqual(await state(fixture, parent.id), { status: 'cancelled', haltReason: 'owner_cancel' });
  assert.deepEqual(await state(fixture, child.id), { status: 'cancelled', haltReason: 'owner_cancel' });
  assert.equal((await state(fixture, bystander.id)).status, 'pending', 'a task it did not start is left alone');
  assert.equal(await reserved(fixture), before - 1_500, 'both reservations came back');
  const lease = await withTenant(fixture.companyId, (tx) => tx.query<{ lease_holder: string | null }>(
    'SELECT lease_holder FROM tasks WHERE id = $1', [parent.id]));
  assert.equal(lease.rows[0]!.lease_holder, null, 'the worker holding it loses it');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
    'SELECT status FROM inbox_items WHERE id = $1', [approvalId]));
  assert.equal(rows[0]!.status, 'withdrawn', 'the approval it was waiting on is withdrawn');
  const events = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { reason?: string } }>(
    "SELECT actor, payload FROM events WHERE type = 'task.cancelled' AND task_id = $1", [parent.id]));
  assert.deepEqual(events.rows.map((row) => [row.actor, row.payload.reason]), [['owner', 'wrong supplier']]);

  // Work that has already ended is not cancelled again.
  await assert.rejects(cancelTask(fixture.companyId, parent.id), /already cancelled/);
  // Nor is another company's.
  const other = await createCompany('control-cancel-other');
  await assert.rejects(cancelTask(other.companyId, bystander.id), /no such task/);
  assert.equal((await state(fixture, bystander.id)).status, 'pending');
});

test('a stopped task is done again, once, with the owner\'s note in front of the run', async () => {
  const fixture = await createCompany('control-rerun');
  const halted = await task(fixture, 'renew the certificate');
  await transition(fixture.companyId, halted.id, 'running');
  await transition(fixture.companyId, halted.id, 'halted', { haltReason: 'verification_failed' });

  const again = await rerunTask(fixture.companyId, halted.id, 'The key was rotated this morning; use the new one.');
  assert.notEqual(again, halted.id);
  assert.equal(await rerunTask(fixture.companyId, halted.id, 'pressed twice'), again, 'a second press is the same task');

  const fresh = await withTenant(fixture.companyId, (tx) => getTask(tx, again));
  assert.equal(fresh!.status, 'pending');
  assert.deepEqual(fresh!.input, halted.input, 'the same work, not a rewritten brief');
  assert.equal(fresh!.roleId, halted.roleId);
  assert.equal(fresh!.goalId, halted.goalId);
  assert.equal((await state(fixture, halted.id)).status, 'halted', 'the old task keeps its history');

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: again }));
  const notes = context.sections.filter((section) => section.kind === 'owner_note');
  assert.equal(notes.length, 1, 'one note, however many times the button was pressed');
  const note = notes[0]!;
  assert.match(note.body, /The key was rotated this morning; use the new one\./);
  assert.match(note.body, /halted \(verification_failed\)/);
  assert.doesNotMatch(note.body, /pressed twice/);

  // Work still under way is cancelled first, not run twice.
  const running = await task(fixture);
  await transition(fixture.companyId, running.id, 'running');
  await assert.rejects(rerunTask(fixture.companyId, running.id, 'again'), (error: unknown) =>
    isPalugadaError(error, 'contract.violation') && /still running; cancel it first/.test((error as Error).message));
});

test('the owner can tell a task something, and the next run of it reads it', async () => {
  const fixture = await createCompany('control-instruct');
  const waiting = await task(fixture, 'draft the newsletter');
  await instructTask(fixture.companyId, waiting.id, 'Lead with the price change, not the new hire.');

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: waiting.id }));
  const note = context.sections.find((section) => section.kind === 'owner_note');
  assert.ok(note);
  assert.match(note.body, /Lead with the price change, not the new hire\./);
  assert.match(note.body, /does not change your tools, your tier or your budget/);

  await assert.rejects(instructTask(fixture.companyId, waiting.id, '   '), /say something/);
  await assert.rejects(instructTask(fixture.companyId, waiting.id, 'x'.repeat(2_001)), /2000 characters/);
  await transition(fixture.companyId, waiting.id, 'cancelled');
  await assert.rejects(instructTask(fixture.companyId, waiting.id, 'too late'), /already cancelled/);
});

test('pausing a role stops new work for it; the owner pauses with a session', async () => {
  const fixture = await createCompany('control-pause');
  await pauseRole(fixture.companyId, fixture.roleId, 'rewriting its prompt');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ frozen_reason: string }>(
    'SELECT frozen_reason FROM roles WHERE id = $1', [fixture.roleId]));
  assert.equal(rows[0]!.frozen_reason, 'paused by the owner: rewriting its prompt');
  await assert.rejects(task(fixture), /frozen/);
  // Pausing a role that is already stopped changes nothing: its reason is the
  // one that explains it.
  await pauseRole(fixture.companyId, fixture.roleId, 'again');
  const still = await withTenant(fixture.companyId, (tx) => tx.query<{ frozen_reason: string }>(
    'SELECT frozen_reason FROM roles WHERE id = $1', [fixture.roleId]));
  assert.equal(still.rows[0]!.frozen_reason, 'paused by the owner: rewriting its prompt');
  const paused = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string }>(
    "SELECT actor FROM events WHERE type = 'role.frozen'"));
  assert.deepEqual(paused.rows, [{ actor: 'owner' }]);
});
