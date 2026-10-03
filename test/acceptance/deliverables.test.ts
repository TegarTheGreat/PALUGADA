/**
 * What a task produced, as the owner reads it.
 *
 * Paperclip and Buzz both put a finished piece of work in front of the person
 * who asked for it. Here a task's result was written to `tasks.output` and a
 * draft to the company's files, and neither reached the owner: the work view
 * had no output, and nothing read a draft back. The owner could approve an
 * action and could not see the blog post it was for. These hold the other
 * half: the one-line result on the work list, and the task's whole output and
 * every draft it wrote, redacted, on the task itself -- and only in its own
 * company.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { redactor } from '../../src/secrets/manager.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
import { taskDetailOf, workOf } from '../../src/owner/views.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;

async function task(fixture: Fixture, goal: string) {
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

async function journal(fixture: Fixture, taskId: string, index: number, name: string, status: string, output: unknown) {
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
     VALUES ($1, $2, $3, $4, 'tool', $5, 'h', $6, $7, CASE WHEN $5 = 'committed' THEN now() END)`,
    [taskId, index, fixture.companyId, name, status, `k${index}`, JSON.stringify(output)],
  ));
}

test('a finished task says what it produced, on the list and in full', async () => {
  const fixture = await createCompany('deliver');
  const run = await task(fixture, 'write the launch post');
  redactor.register('sk-live-deliverables-0001');

  await journal(fixture, run.id, 0, 'capability:dns.read', 'committed', { records: ['1.2.3.4'] });
  await journal(fixture, run.id, 1, 'capability:doc.draft', 'committed', {
    path: 'drafts/launch-post-ab12.md', text: '# We launched\n\nKey sk-live-deliverables-0001 is not for you.', words: 9, model: 'm',
  });
  await journal(fixture, run.id, 2, 'capability:email.draft', 'committed', {
    path: 'drafts/email-cd34.eml', to: 'press@example.com', subject: 'We launched', body: 'Hello press.', model: 'm',
  });
  await journal(fixture, run.id, 4, 'capability:doc.draft', 'committed', {
    path: 'drafts/plain-ef56.md', text: 'No heading in this one.', words: 5, model: 'm',
  });
  // A draft that did not commit is not a deliverable: nothing says it exists.
  await journal(fixture, run.id, 3, 'capability:doc.draft', 'failed', { path: 'drafts/x.md', text: 'lost', words: 1, model: 'm' });
  await transition(fixture.companyId, run.id, 'running');
  await transition(fixture.companyId, run.id, 'completed', {
    output: { summary: 'Wrote the launch post and a note to the press.', words: 9, log: 'used sk-live-deliverables-0001' },
  });

  const done = await workOf(fixture.companyId, { group: 'done' });
  assert.equal(done.items[0]!.result, 'Wrote the launch post and a note to the press.');
  // Unfinished work has no result to show yet.
  await task(fixture, 'still going');
  const active = await workOf(fixture.companyId, { group: 'active' });
  assert.equal(active.items[0]!.result, null);

  const detail = await taskDetailOf(fixture.companyId, run.id);
  assert.ok(detail);
  assert.equal((detail.output as { summary: string }).summary, 'Wrote the launch post and a note to the press.');
  assert.doesNotMatch(JSON.stringify(detail.output), /sk-live-deliverables-0001/, 'the output is redacted too');
  // A document is called by its first heading, an email by its subject, and
  // a document with no heading by its file.
  assert.deepEqual(detail.deliverables.map((one) => [one.capability, one.title]), [
    ['doc.draft', 'We launched'],
    ['email.draft', 'We launched'],
    ['doc.draft', 'drafts/plain-ef56.md'],
  ]);
  assert.equal(detail.deliverables[0]!.path, 'drafts/launch-post-ab12.md');
  assert.equal(detail.deliverables[0]!.words, 9);
  assert.equal(detail.deliverables[1]!.to, 'press@example.com');
  assert.equal(detail.deliverables[1]!.text, 'Hello press.');
  // Redacted like everything else that leaves this process (F12.4).
  assert.doesNotMatch(detail.deliverables[0]!.text, /sk-live-deliverables-0001/);
  assert.match(detail.deliverables[0]!.text, /We launched/);
});

test("a task's output is read only in its own company", async () => {
  const fixture = await createCompany('deliver-own');
  const other = await createCompany('deliver-other');
  const run = await task(fixture, 'private work');
  assert.equal(await taskDetailOf(other.companyId, run.id), null);
  assert.equal(await taskDetailOf(fixture.companyId, '00000000-0000-0000-0000-000000000000'), null);
});

test('a result is read from the fields that describe one, and never left empty', async () => {
  const fixture = await createCompany('deliver-shape');
  const shaped = async (output: unknown) => {
    const run = await task(fixture, 'shape');
    await transition(fixture.companyId, run.id, 'running');
    await transition(fixture.companyId, run.id, 'completed', { output: output as Record<string, unknown> });
    const done = await workOf(fixture.companyId, { group: 'done', limit: 200 });
    return done.items.find((item) => item.id === run.id)!.result;
  };
  // An answer is preferred to whatever came first -- and "first" is
  // PostgreSQL's order, which stores a jsonb object's shorter keys first, so
  // each of these puts a shorter key ahead of the one that describes it.
  assert.equal(await shaped({ note: 'checked twice', answer: 'Supplier B is cheaper.' }), 'Supplier B is cheaper.');
  assert.equal(await shaped({ ok: 'yes', result: 'Renewed the domain.' }), 'Renewed the domain.');
  assert.match((await shaped({ total: 3 }))!, /"total":3/);
});

test('a task shows the work it handed on and what each piece came to, and a piece shows who handed it on (N2)', async () => {
  // The live run of 2 October: the marketer's seven-day plan sat on a sub-task
  // of the CEO's, and the CEO's task -- the one the owner opened, because it
  // was the one they had asked -- said "nothing yet" and pointed nowhere.
  const fixture = await createCompany('handed-on');
  const writerId = await addRole(fixture, 'writer');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET display_name = 'Laras', title = 'CMO' WHERE id = $1", [writerId]));
  const parent = await task(fixture, 'make the Instagram plan');
  await transition(fixture.companyId, parent.id, 'running');
  const hand = (goal: string) => createSubTask(parent.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: writerId, input: { goal }, createdBy: 'agent_run',
  });
  const plan = await hand('Write the seven-day plan');
  await transition(fixture.companyId, plan.id, 'running');
  await transition(fixture.companyId, plan.id, 'completed', {
    output: { summary: 'The seven-day plan, one post a day.', plan: 'Day 1: the iced palm-sugar coffee.' },
  });
  const captions = await hand('Write the captions');

  const detail = (await taskDetailOf(fixture.companyId, parent.id))!;
  assert.deepEqual(detail.handedOn, [
    { id: plan.id, role: 'writer', roleName: 'Laras', status: 'completed', result: 'The seven-day plan, one post a day.' },
    { id: captions.id, role: 'writer', roleName: 'Laras', status: 'pending', result: null },
  ]);
  assert.equal(detail.handedBy, null, 'the owner gave this one');

  const piece = (await taskDetailOf(fixture.companyId, plan.id))!;
  const parentSlug = (await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>(
    'SELECT slug FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!.slug;
  assert.deepEqual(piece.handedBy, { id: parent.id, role: parentSlug, roleName: null });
  assert.deepEqual(piece.handedOn, []);
});
