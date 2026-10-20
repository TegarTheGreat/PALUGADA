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
import { cancelTask, giveFeedback, instructTask, rerunTask } from '../../src/engine/owner-control.ts';
import { MAX_RECLAIMS, reclaimExpiredLeases } from '../../src/engine/checkout.ts';
import { ENDED_AFTER_MS, reportEndedBadly } from '../../src/engine/ended.ts';
import { taskDetailOf } from '../../src/owner/views.ts';
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

/**
 * L6: the owner gave a price twice -- once as an answer to the task's
 * question, once in a note when asking for it again -- and the draft of the
 * third attempt still said "[TBD: price]". A run read what the owner said to
 * its own task only, so each rerun started from the rerun before it and
 * forgot the rest. Every attempt at the same work now reads what the owner
 * said to all of them.
 */
test('a rerun of a rerun still reads what the owner said to every attempt before it (L6)', async () => {
  const fixture = await createCompany('control-lineage');
  const first = await task(fixture, 'write the launch post');
  await transition(fixture.companyId, first.id, 'running');
  const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: first.id, question: 'What is the price per cup?' });
  assert.equal(asked.state, 'waiting');
  await inbox.decide(fixture.companyId, asked.inboxItemId!, 'approve', 'Rp95.000 for a box of twelve', { channel: 'app' });
  await transition(fixture.companyId, first.id, 'halted', { haltReason: 'verification_failed' });

  const second = await rerunTask(fixture.companyId, first.id, 'Our Instagram is @kopi.nusantara.');
  await transition(fixture.companyId, second, 'running');
  await transition(fixture.companyId, second, 'failed');
  const third = await rerunTask(fixture.companyId, second, 'Shorter this time.');

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: third }));
  const said = context.sections.filter((section) => section.kind === 'owner_note').map((section) => section.body).join('\n');
  assert.match(said, /Shorter this time\./, 'its own note');
  assert.match(said, /@kopi\.nusantara/, "the note to the attempt before it");
  assert.match(said, /What is the price per cup\?[\s\S]*Rp95\.000 for a box of twelve/, 'and the answer the first attempt was given');

  // Another task's words are not this work's.
  const unrelated = await task(fixture, 'reconcile the invoices');
  const other = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: unrelated.id }));
  assert.ok(!other.sections.some((section) => /Rp95\.000|kopi\.nusantara/.test(section.body)));
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

/** A card's state, and what the event log says closed it. */
async function closure(fixture: Fixture, itemId: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string | null }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [itemId]));
  const { rows: said } = await withTenant(fixture.companyId, (tx) => tx.query<{ closed: string }>(
    "SELECT payload->>'closedReason' AS closed FROM events WHERE type = 'inbox.withdrawn' AND payload->>'inboxItemId' = $1", [itemId]));
  return { status: rows[0]!.status, reason: rows[0]!.closed_reason, said: said.map((row) => row.closed) };
}

/**
 * "Run again" is the owner's answer to a card about a task that stopped, and
 * the card stayed open after it: the owner pressed it, then went and found the
 * card and dismissed it by hand. The cards that are about the task close when
 * it is run again. The ones that only carry its id -- a role frozen for its
 * refusals, a model key the provider refused for the whole company -- are
 * about something running it again does not change, and stay.
 */
test('running a task again closes the cards about it, and leaves those about something else', async () => {
  const fixture = await createCompany('control-rerun-cards');
  const looping = await task(fixture, 'resize the product photos');
  // A worker lost MAX_RECLAIMS times: the crash loop halts it with its card.
  for (let n = 1; n <= MAX_RECLAIMS; n += 1) {
    await withTenant(fixture.companyId, (tx) => tx.query(
      `UPDATE tasks SET status = 'running', lease_holder = 'dead-worker', lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`, [looping.id]));
    await reclaimExpiredLeases(fixture.companyId);
  }
  assert.deepEqual(await state(fixture, looping.id), { status: 'halted', haltReason: 'crash_loop' });
  const [crashLoop] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident');
  assert.ok(crashLoop);
  // Raised the way the role freeze and the refused key raise theirs: with the task on them.
  const frozen = await inbox.raiseIncident({
    companyId: fixture.companyId, taskId: looping.id, title: 'Role is frozen after repeated denials', detail: 'refused ten times',
  });
  const keyRefused = await inbox.raiseIncident({
    companyId: fixture.companyId, taskId: looping.id, title: 'The model key was refused', detail: 'for every task',
    once: 'model_key_refused',
  });

  const again = await rerunTask(fixture.companyId, looping.id, 'The photos are smaller now.');
  assert.deepEqual(await closure(fixture, crashLoop.id), { status: 'withdrawn', reason: 'task_rerun', said: ['task_rerun'] });
  assert.equal((await closure(fixture, frozen)).status, 'open', 'the role is still frozen');
  assert.equal((await closure(fixture, keyRefused)).status, 'open', 'the key is still refused');

  // A second press is the same task, and closes nothing twice.
  assert.equal(await rerunTask(fixture.companyId, looping.id, 'pressed twice'), again);
  assert.deepEqual((await closure(fixture, crashLoop.id)).said, ['task_rerun']);
});

/**
 * Ten tasks halting on one cause under one goal are one card that names them
 * all (ended.ts), so running one of them again leaves the card for the rest.
 * Its list is how a task is known to have been reported, so it keeps every
 * id: one taken off would be reported again, as if it had just ended.
 */
test('a card for several ended tasks stays until each is run again, and none is reported twice', async () => {
  const fixture = await createCompany('control-rerun-ended');
  const later = () => new Date(Date.now() + ENDED_AFTER_MS + 60_000);
  const first = await task(fixture, 'first');
  const second = await task(fixture, 'second');
  for (const one of [first, second]) {
    await transition(fixture.companyId, one.id, 'running');
    await transition(fixture.companyId, one.id, 'halted', { haltReason: 'hop_limit' });
  }
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 1);
  const [card] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'escalation');
  assert.ok(card);

  await rerunTask(fixture.companyId, first.id);
  assert.equal((await closure(fixture, card.id)).status, 'open', 'the second is still stopped');
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 0, 'and the first is not reported again');

  await rerunTask(fixture.companyId, second.id);
  assert.deepEqual(await closure(fixture, card.id), { status: 'withdrawn', reason: 'task_rerun', said: ['task_rerun'] });
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 0);
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);

  // One run again before its card was raised is not reported at all.
  const third = await task(fixture, 'third');
  await transition(fixture.companyId, third.id, 'running');
  await transition(fixture.companyId, third.id, 'halted', { haltReason: 'deadline_passed' });
  await rerunTask(fixture.companyId, third.id);
  assert.equal(await reportEndedBadly(fixture.companyId, later()), 0, 'the owner already answered it');
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

/**
 * The owner's word on finished work (Buzz lets people react to a message).
 * A verdict with a reason is what the division reads on its next run, as a
 * way to work from the owner; a second word on the same task replaces the
 * first rather than piling up beside it; and a task still running has
 * nothing to judge yet.
 */
test("the owner's word on finished work is what its division remembers next", async () => {
  const fixture = await createCompany('task-feedback');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Write the October newsletter' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  await assert.rejects(giveFeedback(fixture.companyId, task.id, { verdict: 'good' }), /still running/);
  await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'drafted it' } });

  await assert.rejects(giveFeedback(fixture.companyId, task.id, { verdict: 'needs_work' }), /say what to do differently/);
  await assert.rejects(giveFeedback(fixture.companyId, task.id, { verdict: 'meh' as never }), /good or needs_work/);
  await giveFeedback(fixture.companyId, task.id, { verdict: 'needs_work', note: 'Too long; keep it under 150 words.' });
  await giveFeedback(fixture.companyId, task.id, { verdict: 'needs_work', note: 'Under 150 words, and lead with the price.' });

  const context = await withTenant(fixture.companyId, (tx) => buildContext(tx, {
    companyId: fixture.companyId, divisionId: fixture.divisionId,
  }));
  const said = context.sections.map((section) => section.body).join('\n');
  assert.match(said, /lead with the price/);
  assert.doesNotMatch(said, /Too long; keep it under 150 words/, 'the first word was replaced, not kept beside it');
  assert.match(said, /October newsletter/);

  const detail = await taskDetailOf(fixture.companyId, task.id);
  assert.deepEqual([detail!.feedback?.verdict, detail!.feedback?.note], ['needs_work', 'Under 150 words, and lead with the price.']);

  // Praise with nothing to learn from is recorded, and teaches nothing.
  const other = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Write the November newsletter' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, other.id, 'running');
  await transition(fixture.companyId, other.id, 'completed', { output: { summary: 'drafted it' } });
  await giveFeedback(fixture.companyId, other.id, { verdict: 'good' });
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM memories WHERE source = 'owner' AND superseded_by IS NULL"));
  assert.equal(rows[0]!.n, 1);
  assert.equal((await taskDetailOf(fixture.companyId, other.id))!.feedback?.verdict, 'good');
});
