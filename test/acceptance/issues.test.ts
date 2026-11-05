/**
 * Issues, to-dos and postmortems (F18.4, F18.5; STATUS 2.193).
 *
 * An issue is a ticket of kind `issue`: a problem the company solves rather
 * than work it hands out. It is solved by naming its root cause and the
 * decision taken, and the decision is carried out by to-dos -- work tickets
 * that name the issue they solve, each with one seat and a date seven days
 * out. Solving keeps the lesson in the company's memory, which is the first
 * thing PALUGADA learns from a failure rather than only from a success.
 *
 * And the platform files one by itself when work fails in a way that has a
 * cause worth finding -- a task that keeps killing its worker, a write that
 * did not read back, a budget that ran out, work that ended badly -- as a
 * short postmortem, once for the same source while it is open, with no
 * customer's name in it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { reclaimExpiredLeases, MAX_RECLAIMS } from '../../src/engine/checkout.ts';
import { earlierSolves, fileIssue, openTicket, readTicket, setTicketStatus, solveIssue } from '../../src/engine/tickets.ts';
import { ensureTriage, handTodos } from '../../src/engine/triage.ts';
import { reportEndedBadly } from '../../src/engine/ended.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { addRole, createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A company whose fixture role is its CEO, which solves issues. */
async function withCeo(name: string): Promise<Fixture> {
  const fixture = await createCompany(name);
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET title = 'CEO' WHERE id = $1", [fixture.roleId]));
  return fixture;
}

async function engineFor(fixture: Fixture, handlers: Record<string, TaskHandler>) {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const name of ['ticket.create', 'ticket.list', 'task.delegate']) await grantCapability(fixture, name);
  return new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map(Object.entries(handlers)),
  });
}

let made = 0;
function newTask(fixture: Fixture, goal = `work ${made += 1}`, roleId = fixture.roleId) {
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 2_000,
  });
}

interface Row {
  id: string; kind: string; status: string; title: string; body: string; root_cause: string | null; closed_reason: string | null;
  solves_ticket_id: string | null; assignee_role_id: string | null; due_on: string | null; opened_by: string;
  opened_by_task_id: string | null; from_inbox_item_id: string | null; source_key: string | null; horizon: string;
  working_task_id: string | null; goal_id: string | null; division_id: string | null;
}

const tickets = (companyId: string) => withTenant(companyId, (tx) => tx.query<Row>(
  `SELECT id, kind, status, title, body, root_cause, closed_reason, solves_ticket_id, assignee_role_id, due_on::text, opened_by,
          opened_by_task_id, from_inbox_item_id, source_key, horizon, working_task_id, goal_id, division_id
     FROM tickets ORDER BY created_at, solves_ticket_id NULLS FIRST`)).then((result) => result.rows);

/** The company's date a week from today, as the database counts it in the company's zone. */
const weekOut = (companyId: string) => withTenant(companyId, (tx) => tx.query<{ day: string }>(
  "SELECT ((now() AT TIME ZONE timezone)::date + 7)::text AS day FROM companies WHERE id = $1", [companyId]))
  .then((result) => result.rows[0]!.day);

/** Loses the task's worker the most times a task may, so it halts for a crash loop. */
async function crashLoop(fixture: Fixture, taskId: string) {
  for (let n = 0; n < MAX_RECLAIMS; n += 1) {
    await withTenant(fixture.companyId, (tx) => tx.query(
      `UPDATE tasks SET status = 'running', lease_holder = 'dead-worker', lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`, [taskId]));
    await reclaimExpiredLeases(fixture.companyId);
  }
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, taskId)))!.haltReason, 'crash_loop');
}

test('an issue is not solved without its root cause and its decision, and only work solves one', async () => {
  const fixture = await withCeo('issues-refused');
  let issueId = '';
  const refusals: string[] = [];
  const engine = await engineFor(fixture, {
    worker: async (ctx) => {
      const filed = await ctx.callCapability('ticket.create', {
        kind: 'issue', title: 'Orders from the shop arrive twice', body: 'Two customers were charged twice this week.',
      }) as { ticketId: string };
      issueId = filed.ticketId;
      for (const attempt of [
        { title: 'Make the order sync idempotent', solves: issueId, decision: 'Key each order by its shop id.' },
        { title: 'Make the order sync idempotent', solves: issueId, rootCause: '   ', decision: 'Key each order by its shop id.' },
        { title: 'Make the order sync idempotent', solves: issueId, rootCause: 'The sync retries without a key.' },
        { kind: 'hire', title: 'Order clerk', solves: issueId },
        { kind: 'issue', title: 'Another', rootCause: 'x', decision: 'y' },
      ]) {
        try {
          await ctx.callCapability('ticket.create', attempt);
          refusals.push('accepted');
        } catch (error) {
          refusals.push((error as Error).message);
        }
      }
      return { summary: 'tried' };
    },
  });
  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.equal(refusals.length, 5);
  assert.match(refusals[0]!, /root cause/);
  assert.match(refusals[1]!, /root cause/);
  assert.match(refusals[2]!, /decision/);
  assert.match(refusals[3]!, /only work solves an issue/);
  assert.match(refusals[4]!, /solved by filing/);
  const [issue, ...rest] = await tickets(fixture.companyId);
  assert.equal(rest.length, 0, 'no to-do was filed by a refused call');
  assert.deepEqual({ kind: issue!.kind, status: issue!.status, horizon: issue!.horizon }, { kind: 'issue', status: 'open', horizon: 'now' });

  // The database says the same, whoever writes.
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE tickets SET status = 'done', closed_at = now(), closed_reason = 'fixed it' WHERE id = $1", [issueId])),
  /tickets_issue_solved/);
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO tickets (company_id, project_id, title, opened_by, kind, solves_ticket_id, outside)
     VALUES ($1, $2, 'Order clerk', 'owner', 'hire', $3, false)`, [fixture.companyId, fixture.projectId, issueId])),
  /tickets_only_work_solves/);
  // And a solved issue is not solved again by an owner closing it.
  await assert.rejects(withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId, rootCause: 'The sync retries without a key.', decision: 'Key each order.',
    todos: [], solvedBy: 'owner', outside: false,
  })), /at least one to-do/);
});

test('solving an issue closes it, opens owned to-dos due in seven days, keeps the lesson, and the seat is given each', async () => {
  const fixture = await withCeo('issues-solved');
  const builderId = await addRole(fixture, 'builder');
  let issueId = '';
  let todoId = '';
  let secondId = '';
  const engine = await engineFor(fixture, {
    worker: async (ctx) => {
      issueId = (await ctx.callCapability('ticket.create', {
        kind: 'issue', horizon: 'long_term', title: 'Orders from the shop arrive twice', body: 'Two customers were charged twice.',
      }) as { ticketId: string }).ticketId;
      const solved = await ctx.callCapability('ticket.create', {
        title: 'Make the order sync idempotent', body: 'Key each order by its shop id.', solves: issueId, assignee: 'builder',
        rootCause: 'The sync retries a timed-out call without a key, and the shop takes both.',
        decision: 'Every order write carries the shop order id as its key.',
      }) as { ticketId: string; existing: boolean; solved: boolean };
      assert.equal(solved.solved, true);
      todoId = solved.ticketId;
      // A second to-do for the same decision names the issue, and no cause.
      secondId = (await ctx.callCapability('ticket.create', {
        title: 'Refund the second charges', solves: issueId, due: '2030-01-15',
      }) as { ticketId: string }).ticketId;
      return { summary: 'solved' };
    },
    builder: async () => ({ summary: 'keyed' }),
  });
  const ceoTask = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, ceoTask.id, 'worker')).status, 'completed');

  const rows = await tickets(fixture.companyId);
  const issue = rows.find((row) => row.id === issueId)!;
  assert.deepEqual(
    { status: issue.status, root: issue.root_cause, decision: issue.closed_reason, horizon: issue.horizon },
    {
      status: 'done', root: 'The sync retries a timed-out call without a key, and the shop takes both.',
      decision: 'Every order write carries the shop order id as its key.', horizon: 'long_term',
    });
  const todo = rows.find((row) => row.id === todoId)!;
  assert.deepEqual(
    { kind: todo.kind, solves: todo.solves_ticket_id, seat: todo.assignee_role_id, due: todo.due_on, status: todo.status },
    { kind: 'work', solves: issueId, seat: builderId, due: await weekOut(fixture.companyId), status: 'open' });
  const second = rows.find((row) => row.id === secondId)!;
  assert.deepEqual({ solves: second.solves_ticket_id, due: second.due_on, seat: second.assignee_role_id },
    { solves: issueId, due: '2030-01-15', seat: null });

  // The lesson: a decision the company took, kept where the division's runs read it.
  const lessons = await withTenant(fixture.companyId, (tx) => tx.query<{
    body: string; memory_type: string; fact_kind: string; scope_type: string; scope_id: string; source_task_id: string;
  }>("SELECT body, memory_type, fact_kind, scope_type, scope_id, source_task_id FROM memories WHERE fact_kind = 'decision'"));
  assert.equal(lessons.rows.length, 1);
  assert.deepEqual(
    { type: lessons.rows[0]!.memory_type, scope: lessons.rows[0]!.scope_type, at: lessons.rows[0]!.scope_id, task: lessons.rows[0]!.source_task_id },
    { type: 'semantic', scope: 'division', at: fixture.divisionId, task: ceoTask.id });
  assert.match(lessons.rows[0]!.body, /Orders from the shop arrive twice/);
  assert.match(lessons.rows[0]!.body, /without a key/);
  assert.match(lessons.rows[0]!.body, /shop order id as its key/);

  // The seat is handed its to-do straight away, not through the CEO's triage;
  // the to-do with no seat is the CEO's to hand on, as any ticket is.
  assert.equal(await handTodos(fixture.companyId), 1);
  assert.equal(await handTodos(fixture.companyId), 0, 'once');
  const handed = (await tickets(fixture.companyId)).find((row) => row.id === todoId)!;
  assert.equal(handed.status, 'in_progress');
  const work = (await withTenant(fixture.companyId, (tx) => getTask(tx, handed.working_task_id!)))!;
  assert.equal(work.roleId, builderId);
  assert.match(JSON.stringify(work.input), /Make the order sync idempotent/);
  const wakes = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM wake_queue WHERE role_id = $1 AND reason = 'assignment'", [builderId]));
  assert.equal(wakes.rows.length, 1, 'the seat is woken for it');
  const triageId = await ensureTriage(fixture.companyId);
  assert.ok(triageId);
  const triage = (await withTenant(fixture.companyId, (tx) => getTask(tx, triageId!)))!;
  assert.deepEqual((triage.input as { ticketIds: string[] }).ticketIds, [secondId], 'only the to-do nobody holds');

  // It settles with its work, as any ticket does.
  await transition(fixture.companyId, work.id, 'running');
  await transition(fixture.companyId, work.id, 'completed', { output: { summary: 'keyed' } });
  assert.equal((await tickets(fixture.companyId)).find((row) => row.id === todoId)!.status, 'done');

  // The owner reads the issue with what solved it.
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const page = await api.call('GET', `/api/companies/${fixture.companyId}/tickets/${issueId}`, token);
    assert.equal(page.status, 200);
    assert.equal(page.body.ticket.rootCause, issue.root_cause);
    assert.equal(page.body.ticket.closedReason, issue.closed_reason);
    assert.deepEqual(page.body.todos.map((one: { id: string }) => one.id).sort(), [todoId, secondId].sort());
    assert.equal(page.body.todos.find((one: { id: string }) => one.id === todoId).assigneeRoleId, builderId);
  } finally {
    await api.close();
  }
});

test('triage ignores issues, and an issue is not given to anyone as work', async () => {
  const fixture = await withCeo('issues-not-triaged');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const filed = await api.call('POST', `/api/companies/${fixture.companyId}/tickets`, token,
      { kind: 'issue', title: 'We do not know which channel brings customers', horizon: 'long_term' });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    const [issue] = await tickets(fixture.companyId);
    assert.deepEqual({ kind: issue!.kind, horizon: issue!.horizon, by: issue!.opened_by }, { kind: 'issue', horizon: 'long_term', by: 'owner' });
    assert.equal(await ensureTriage(fixture.companyId), null, 'an issue is solved at the meeting, not handed out');

    const given = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${issue!.id}/assign`, token,
      { roleId: fixture.roleId, goalId: fixture.goalId });
    assert.equal(given.status, 400);
    assert.match(String(given.body.error), /solved/);
    const badHorizon = await api.call('POST', `/api/companies/${fixture.companyId}/tickets`, token,
      { kind: 'issue', title: 'Something', horizon: 'someday' });
    assert.equal(badHorizon.status, 400);
    assert.match(String(badHorizon.body.error), /now, long_term/);

    // Closed by the owner without a cause: dropped, not solved.
    const closed = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${issue!.id}`, token,
      { status: 'closed', reason: 'not a problem after all' });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.ticket.status, 'closed');
  } finally {
    await api.close();
  }

  // Nor handed on by the CEO.
  const other = await withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null, title: 'Support answers take a day',
    sourceKey: `test:${fixture.roleId}`, openedBy: 'owner', outside: false,
  }));
  let refused = '';
  const engine = await engineFor(fixture, {
    worker: async (ctx) => {
      try {
        await ctx.callCapability('task.delegate', { role: 'worker', brief: 'look at it', ticketId: other.ticket.id });
      } catch (error) {
        refused = (error as Error).message;
      }
      return { summary: 'tried' };
    },
  });
  const task = await newTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.match(refused, /an issue is solved/);
});

test('filing an issue from a source finds the one still open for it', async () => {
  const fixture = await withCeo('issues-source');
  const file = (title: string) => withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title,
    body: 'What happened.', sourceKey: `metric:${fixture.goalId}`, goalId: fixture.goalId, openedBy: 'platform', outside: false,
  }));
  const first = await file('Weekly signups off track');
  const again = await file('Weekly signups off track again');
  assert.equal(first.existing, false);
  assert.equal(again.existing, true);
  assert.equal(again.ticket.id, first.ticket.id);
  assert.equal(again.ticket.title, 'Weekly signups off track', 'its words stay as they were');
  assert.equal(first.ticket.goalId, fixture.goalId);
  await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: first.ticket.id, rootCause: 'The form broke on phones.',
    decision: 'Test the form on a phone before each release.', solvedBy: 'owner', outside: false,
    todos: [{ title: 'Fix the form on phones' }],
  }));
  const after = await file('Weekly signups off track');
  assert.equal(after.existing, false, 'solved, the same source files a new one');
  assert.notEqual(after.ticket.id, first.ticket.id);
  await assert.rejects(withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null, title: 'x', sourceKey: ' ',
    openedBy: 'platform', outside: false,
  })), /source key/);
});

test('a crash loop files one postmortem issue, not two, with no customer\'s name in it', async () => {
  const fixture = await withCeo('issues-crash-loop');
  const first = await newTask(fixture, 'Reply to Budi Santoso about his order 41');
  await crashLoop(fixture, first.id);
  const second = await newTask(fixture, 'Reply to Siti Rahma about her refund');
  await crashLoop(fixture, second.id);

  const rows = await tickets(fixture.companyId);
  assert.equal(rows.length, 1, 'the same failure in the same seat is one issue while it is open');
  const [issue] = rows;
  const incident = (await inbox.listOpen(fixture.companyId)).find((item) => item.kind === 'incident' && item.taskId === first.id)!;
  assert.deepEqual(
    { kind: issue!.kind, by: issue!.opened_by, task: issue!.opened_by_task_id, card: issue!.from_inbox_item_id, division: issue!.division_id },
    { kind: 'issue', by: 'platform', task: first.id, card: incident.id, division: fixture.divisionId });
  assert.equal(issue!.source_key, `task:crash_loop:${fixture.roleId}`);
  for (const heading of ['What happened', 'Impact', 'Trigger', 'Detection', 'What was done']) {
    assert.match(issue!.body, new RegExp(heading), heading);
  }
  assert.match(issue!.body, new RegExp(`${MAX_RECLAIMS}`));
  for (const name of ['Budi', 'Santoso', 'Siti', 'order 41']) assert.ok(!`${issue!.title}\n${issue!.body}`.includes(name), name);
  const recurred = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT payload FROM events WHERE type = 'issue.recurred'"));
  assert.equal(recurred.rows.length, 1, 'the second time is recorded against the first');
  assert.equal(await ensureTriage(fixture.companyId), null, 'and is not handed out as work');
});

test('work that ended badly, a failed read-back and a budget that ran out each file a postmortem', async () => {
  const fixture = await withCeo('issues-ended');
  const stuck = await newTask(fixture, 'ship the release');
  await transition(fixture.companyId, stuck.id, 'running');
  await transition(fixture.companyId, stuck.id, 'halted', { haltReason: 'hop_limit', detail: 'too deep' });
  assert.equal(await reportEndedBadly(fixture.companyId, new Date(Date.now() + 2 * 60_000)), 1);

  const spent = await newTask(fixture, 'Riset harga');
  await transition(fixture.companyId, spent.id, 'running');
  await transition(fixture.companyId, spent.id, 'halted', { haltReason: 'budget_exhausted', detail: 'the budget has no tokens left' });
  await inbox.raiseBudgetHalt(fixture.companyId, spent.id);

  // A provider that says it wrote and wrote something else (F8.4).
  const zone = new Map<string, string>();
  const registry = new CapabilityRegistry();
  registry.register({
    name: 'dns.update', adapter: 'test:dns', defaultTier: 1, estimatedCostCents: 0,
    async execute(input: { record: string; value: string }) {
      zone.set(input.record, `${input.value}-corrupted`);
      return { ok: true };
    },
    async verify(input: { record: string; value: string }) {
      return zone.get(input.record) === input.value;
    },
  } as never);
  await registry.sync();
  await grantCapability(fixture, 'dns.update');
  const writer = await newTask(fixture, 'point the shop at the new server');
  const engine = new Engine({
    broker: new CapabilityBroker(registry), llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability('dns.update', { record: 'www', value: '1.2.3.4' });
      return {};
    }]]),
  });
  assert.equal((await engine.runTask(fixture.companyId, writer.id, 'worker')).status, 'halted');

  const rows = await tickets(fixture.companyId);
  assert.deepEqual(rows.map((row) => row.source_key).sort(),
    [`budget:${fixture.budgetAccountId}`, `task:hop_limit:${fixture.roleId}`, `task:verification_failed:${fixture.roleId}`].sort());
  const unverified = rows.find((row) => row.source_key!.startsWith('task:verification_failed'))!;
  const incident = (await inbox.listOpen(fixture.companyId)).find((item) => item.kind === 'incident' && item.taskId === writer.id)!;
  assert.equal(unverified.from_inbox_item_id, incident.id);
  assert.ok(!unverified.body.includes('corrupted'), 'what the provider said is on the card, not in the issue');
  const ended = rows.find((row) => row.source_key!.startsWith('task:'))!;
  assert.equal(ended.opened_by_task_id, stuck.id);
  const card = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    "SELECT id FROM inbox_items WHERE kind = 'escalation' AND task_id = $1", [stuck.id]));
  assert.equal(ended.from_inbox_item_id, card.rows[0]!.id);
  const budget = rows.find((row) => row.source_key!.startsWith('budget:'))!;
  assert.match(budget.body, /What was done/);
  assert.ok(!budget.body.includes('Riset harga'), 'the work is named by the record it links, not in the issue');
});

test('issues and to-dos survive an export and an import, with every reference mapped', async () => {
  const fixture = await withCeo('issues-archive');
  const builderId = await addRole(fixture, 'builder');
  const looping = await newTask(fixture, 'sync the shop');
  await crashLoop(fixture, looping.id);
  const [issue] = await tickets(fixture.companyId);
  await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue!.id, rootCause: 'The shop API returns a file too big to hold.',
    decision: 'Read the export in pages.', solvedBy: 'owner', outside: false,
    todos: [{ title: 'Page the shop export', assigneeRoleId: builderId }],
  }));

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const back = await tickets(restored.companyId);
  assert.equal(back.length, 2);
  const [issueBack, todoBack] = back;
  const { rows: roles } = await withTenant(restored.companyId, (tx) => tx.query<{ id: string; slug: string }>('SELECT id, slug FROM roles'));
  const restoredBuilder = roles.find((role) => role.slug === 'builder')!.id;
  const restoredWorker = roles.find((role) => role.slug === 'worker')!.id;
  assert.deepEqual(
    { kind: issueBack!.kind, status: issueBack!.status, root: issueBack!.root_cause, decision: issueBack!.closed_reason, by: issueBack!.opened_by },
    { kind: 'issue', status: 'done', root: 'The shop API returns a file too big to hold.', decision: 'Read the export in pages.', by: 'platform' });
  assert.equal(issueBack!.source_key, `task:crash_loop:${restoredWorker}`, 'the role in its source is the restored one');
  assert.ok(issueBack!.from_inbox_item_id, 'the incident it came from came across with it');
  const card = await withTenant(restored.companyId, (tx) => tx.query(
    "SELECT 1 FROM inbox_items WHERE id = $1 AND kind = 'incident'", [issueBack!.from_inbox_item_id]));
  assert.equal(card.rows.length, 1);
  assert.deepEqual(
    { solves: todoBack!.solves_ticket_id, seat: todoBack!.assignee_role_id, due: todoBack!.due_on },
    { solves: issueBack!.id, seat: restoredBuilder, due: (await tickets(fixture.companyId))[1]!.due_on });
});

test('the application role may write a root cause and nothing else new on a ticket once it is filed', async () => {
  const may = (privilege: string) => withControlPlane((tx) => tx.query<{ ok: boolean }>(`SELECT ${privilege} AS ok`))
    .then((result) => result.rows[0]!.ok);
  assert.equal(await may("has_column_privilege('palugada_app', 'tickets', 'root_cause', 'UPDATE')"), true);
  for (const column of ['solves_ticket_id', 'assignee_role_id', 'due_on', 'source_key', 'from_inbox_item_id', 'goal_id', 'metric_id', 'horizon', 'kind']) {
    assert.equal(await may(`has_column_privilege('palugada_app', 'tickets', '${column}', 'UPDATE')`), false, column);
  }
});

test('an issue opened again keeps what was decided on the record, and shows no cause as if it were current', async () => {
  const fixture = await withCeo('issues-reopened');
  const issue = await withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title: 'Orders arrive twice',
    sourceKey: `test:reopen:${fixture.roleId}`, openedBy: 'owner', outside: false,
  }));
  await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue.ticket.id, rootCause: 'The sync retries without a key.',
    decision: 'Key every write.', solvedBy: 'owner', outside: false, todos: [{ title: 'Key the order writes' }],
  }));
  const solvedEvent = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE type = 'issue.solved'"));
  assert.deepEqual(
    { cause: solvedEvent.rows[0]!.payload.rootCause, decision: solvedEvent.rows[0]!.payload.decision },
    { cause: 'The sync retries without a key.', decision: 'Key every write.' }, 'the solve is on the record in its own words');

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    // The fix did not hold: the owner opens it again from the board.
    const reopened = await api.call('POST', `/api/companies/${fixture.companyId}/tickets/${issue.ticket.id}`, token, { status: 'open' });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    const [row] = (await tickets(fixture.companyId)).filter((one) => one.id === issue.ticket.id);
    assert.deepEqual({ status: row!.status, cause: row!.root_cause, decision: row!.closed_reason },
      { status: 'open', cause: null, decision: null }, 'an open issue states no cause as if it were current');
    const event = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'ticket.reopened'"));
    assert.deepEqual(event.rows[0]!.payload.earlier, { rootCause: 'The sync retries without a key.', decision: 'Key every write.' });

    // The issue's page shows the earlier solve as what was tried before.
    const page = await api.call('GET', `/api/companies/${fixture.companyId}/tickets/${issue.ticket.id}`, token);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.earlierSolves.map((one: { rootCause: string; decision: string }) => [one.rootCause, one.decision]),
      [['The sync retries without a key.', 'Key every write.']]);
  } catch (error) {
    await api.close();
    throw error;
  }

  // And the CEO reading it again sees the same.
  let listed: { rootCause: string | null; decision: string | null; earlierSolves: { decision: string }[] } | undefined;
  const engine = await engineFor(fixture, {
    worker: async (ctx) => {
      const read = await ctx.callCapability('ticket.list', { ids: [issue.ticket.id] }) as { tickets: typeof listed[] };
      listed = read.tickets[0];
      return { summary: 'read' };
    },
  });
  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.equal(listed!.rootCause, null);
  assert.equal(listed!.decision, null);
  assert.deepEqual(listed!.earlierSolves.map((one) => one.decision), ['Key every write.']);

  // Solved again, the page's history is the earlier solve alone, not the one it now shows.
  await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue.ticket.id, rootCause: 'Two workers pick up the same order.',
    decision: 'Lock the order while it is written.', solvedBy: 'owner', outside: false, todos: [{ title: 'Lock the order writes' }],
  }));
  try {
    const token = await api.signIn();
    const page = await api.call('GET', `/api/companies/${fixture.companyId}/tickets/${issue.ticket.id}`, token);
    assert.equal(page.body.ticket.rootCause, 'Two workers pick up the same order.');
    assert.deepEqual(page.body.earlierSolves.map((one: { decision: string }) => one.decision), ['Key every write.']);
  } finally {
    await api.close();
  }
});

test('a to-do its seat cannot take goes to the CEO, and is not asked of the seat every ten minutes for ever', async () => {
  const fixture = await withCeo('issues-seat-refuses');
  const builderId = await addRole(fixture, 'builder');
  const supportId = await addRole(fixture, 'support');
  const issue = await withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title: 'Refunds take a week',
    sourceKey: `test:seat:${fixture.roleId}`, openedBy: 'owner', outside: false,
  }));
  const { todos: [frozenTodo] } = await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue.ticket.id, rootCause: 'Nobody owns refunds.', decision: 'Support owns refunds.',
    solvedBy: 'owner', outside: false, todos: [{ title: 'Write the refund steps', assigneeRoleId: supportId }],
  }));
  const refusals = (ticketId: string) => withTenant(fixture.companyId, (tx) => tx.query<{ payload: { givenUp?: boolean } }>(
    "SELECT payload FROM events WHERE type = 'ticket.not_handed' AND payload->>'ticketId' = $1 ORDER BY occurred_at", [ticketId]))
    .then((result) => result.rows.map((one) => one.payload.givenUp === true));
  const start = Date.now();
  const passes = async (from: number, count: number) => {
    for (let pass = from; pass < from + count; pass += 1) {
      assert.equal(await handTodos(fixture.companyId, new Date(start + pass * 11 * 60_000)), 0);
    }
  };

  // A frozen seat will not take it until the owner says so: given up on at once.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET frozen_at = now(), frozen_reason = 'test' WHERE id = $1", [supportId]));
  await passes(0, 3);
  assert.deepEqual(await refusals(frozenTodo!.id), [true], 'a lasting refusal is said once, and the seat is not asked again');

  // A month's spending paused passes by itself: asked again, three times in all.
  const paused = await withTenant(fixture.companyId, (tx) => openTicket(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title: 'Add a refund button',
    solvesTicketId: issue.ticket.id, assigneeRoleId: builderId, openedBy: 'owner', outside: false,
  }));
  await withControlPlane((tx) => tx.query(
    'INSERT INTO spend_limits (company_id, paused_at) VALUES ($1, now()) ON CONFLICT (company_id) DO UPDATE SET paused_at = now()',
    [fixture.companyId]));
  await passes(3, 5);
  assert.deepEqual(await refusals(paused.ticket.id), [false, false, true]);
  assert.deepEqual(await refusals(frozenTodo!.id), [true]);

  // The CEO is given both to hand on, with why the seat did not take each.
  await withControlPlane((tx) => tx.query('UPDATE spend_limits SET paused_at = NULL WHERE company_id = $1', [fixture.companyId]));
  const triageId = await ensureTriage(fixture.companyId);
  assert.ok(triageId, 'a triage is made for them');
  const triage = (await withTenant(fixture.companyId, (tx) => getTask(tx, triageId!)))!;
  const input = triage.input as { ticketIds: string[]; context: string };
  assert.deepEqual([...input.ticketIds].sort(), [frozenTodo!.id, paused.ticket.id].sort());
  assert.match(input.context, /frozen/);
  assert.match(input.context, /spending ceiling/);
});

test('an agent that solves a company-wide issue keeps its lesson in its own division, and only the owner keeps one company-wide', async () => {
  const fixture = await withCeo('issues-lesson-scope');
  const file = (title: string) => withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null, title,
    sourceKey: `test:${title}`, openedBy: 'owner', outside: false,
  }));
  const byAgent = await file('Customers wait for answers');
  const engine = await engineFor(fixture, {
    worker: async (ctx) => {
      await ctx.callCapability('ticket.create', {
        title: 'Answer within the hour', solves: byAgent.ticket.id,
        rootCause: 'Nobody reads the inbox on weekends.', decision: 'Read the inbox every hour, every day.',
      });
      return { summary: 'solved' };
    },
  });
  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  const byOwner = await file('Prices differ between shops');
  await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: byOwner.ticket.id, rootCause: 'Each shop is priced by hand.',
    decision: 'One price list feeds every shop.', solvedBy: 'owner', outside: false, todos: [{ title: 'Make one price list' }],
  }));

  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ body: string; scope_type: string; scope_id: string | null }>(
    "SELECT body, scope_type, scope_id FROM memories WHERE fact_kind = 'decision' ORDER BY created_at"));
  const agents = rows.find((one) => one.body.includes('Customers wait for answers'))!;
  const owners = rows.find((one) => one.body.includes('Prices differ between shops'))!;
  assert.deepEqual({ scope: agents.scope_type, at: agents.scope_id }, { scope: 'division', at: fixture.divisionId },
    'an agent does not write memory every division is given');
  assert.deepEqual({ scope: owners.scope_type, at: owners.scope_id }, { scope: 'company', at: null });
});

test('a to-do that changes while it is being handed does not leave its work running for nothing', async () => {
  const fixture = await withCeo('issues-handed-race');
  const builderId = await addRole(fixture, 'builder');
  const issue = await withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title: 'The shop goes down at night',
    sourceKey: `test:race:${fixture.roleId}`, openedBy: 'owner', outside: false,
  }));
  const { todos: [todo] } = await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue.ticket.id, rootCause: 'The disk fills with logs.', decision: 'Rotate the logs.',
    solvedBy: 'owner', outside: false, todos: [{ title: 'Rotate the shop logs', assigneeRoleId: builderId }],
  }));
  // The owner closes the to-do in the moment between its task being made and its ticket being marked taken.
  const owner = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  try {
    await owner.query(`CREATE FUNCTION public.test_closes_todo() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE tickets SET status = 'closed', closed_at = now(), closed_reason = 'not needed'
         WHERE id = substr(NEW.idempotency_key, 6)::uuid;
        RETURN NEW;
      END $$`);
    await owner.query(`CREATE TRIGGER test_closes_todo AFTER INSERT ON tasks FOR EACH ROW
      WHEN (NEW.idempotency_key LIKE 'todo:%') EXECUTE FUNCTION public.test_closes_todo()`);
    assert.equal(await handTodos(fixture.companyId), 0);
  } finally {
    await owner.query('DROP TRIGGER IF EXISTS test_closes_todo ON tasks');
    await owner.query('DROP FUNCTION IF EXISTS public.test_closes_todo()');
    await owner.end();
  }
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; halt_reason: string | null }>(
    "SELECT status, halt_reason FROM tasks WHERE idempotency_key = 'todo:' || $1", [todo!.id]));
  assert.deepEqual(rows, [{ status: 'cancelled', halt_reason: 'work_taken_up' }], 'the work made for it is cancelled');
  const said = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM events WHERE type = 'ticket.not_handed'"));
  assert.equal(said.rows.length, 0, 'and the record does not say the seat could not take it');
});

/**
 * Tickets are given new ids on import, and what was said about them is in
 * the event log by the ticket's id: an issue's earlier solves (`issue.solved`)
 * and a seat's refusal of a to-do (`ticket.not_handed`). Restored with the
 * archive's ids in their payloads, none of them named a ticket here: the
 * issue's page lost what was tried before, and a to-do whose seat had given
 * up was offered to that seat again, run by run.
 */
test('an issue\'s earlier solves and a seat\'s refusal of a to-do survive an export and an import', async () => {
  const fixture = await withCeo('issues-history-archive');
  const supportId = await addRole(fixture, 'support');
  const issue = await withTenant(fixture.companyId, (tx) => fileIssue(tx, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, title: 'Refunds take a week',
    sourceKey: `test:history:${fixture.roleId}`, openedBy: 'owner', outside: false,
  }));
  await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue.ticket.id, rootCause: 'Nobody owns refunds.', decision: 'Builder owns refunds.',
    solvedBy: 'owner', outside: false, todos: [{ title: 'Write the refund steps' }],
  }));
  await withTenant(fixture.companyId, (tx) => setTicketStatus(tx, fixture.companyId, issue.ticket.id, { status: 'open' }));
  const { todos: [todo] } = await withTenant(fixture.companyId, (tx) => solveIssue(tx, {
    companyId: fixture.companyId, issueId: issue.ticket.id, rootCause: 'Refunds wait for a second approval.',
    decision: 'Support owns refunds.', solvedBy: 'owner', outside: false,
    todos: [{ title: 'Answer refunds the same day', assigneeRoleId: supportId }],
  }));
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET frozen_at = now(), frozen_reason = 'test' WHERE id = $1", [supportId]));
  assert.equal(await handTodos(fixture.companyId), 0, 'the frozen seat does not take its to-do');

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { rows: back } = await withTenant(restored.companyId, (tx) => tx.query<{ id: string; title: string }>(
    'SELECT id, title FROM tickets'));
  const issueBack = back.find((one) => one.title === 'Refunds take a week')!.id;
  const todoBack = back.find((one) => one.title === 'Answer refunds the same day')!.id;
  assert.notEqual(todoBack, todo!.id, 'the to-do has an id of its own here');

  const earlier = await withTenant(restored.companyId, async (tx) => earlierSolves(tx, [(await readTicket(tx, issueBack))!]));
  assert.deepEqual(earlier.get(issueBack)!.map((one) => one.decision), ['Builder owns refunds.'],
    'the restored issue still shows what was tried before');

  const refusals = () => withTenant(restored.companyId, (tx) => tx.query<{ payload: { givenUp?: boolean } }>(
    "SELECT payload FROM events WHERE type = 'ticket.not_handed' AND payload->>'ticketId' = $1", [todoBack]))
    .then((result) => result.rows.map((one) => one.payload.givenUp === true));
  assert.deepEqual(await refusals(), [true], 'the seat\'s refusal names the restored to-do');
  assert.equal(await handTodos(restored.companyId), 0);
  assert.deepEqual(await refusals(), [true], 'and the seat that gave up is not asked again');
});
