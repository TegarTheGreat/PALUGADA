/**
 * PRD F6.1-F6.4 -- typed contracts and handoff.
 *
 * Principle 4 says agents do not talk to agents. These tests check that the
 * codebase actually has no way for them to: work moves between roles only by
 * creating a task, the shape of that task is validated in both directions, and
 * the only synchronous path runs through the engine with a deadline.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { processHandoffs } from '../../src/engine/handoff.ts';
import { createCompany, addRole, setRoleSchemas, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const RESEARCH_OUTPUT = {
  type: 'object',
  required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
} as const;

const WRITE_INPUT = {
  type: 'object',
  required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
} as const;

function engineWith(handlers: Record<string, TaskHandler>) {
  return new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map(Object.entries(handlers)),
  });
}

async function rootTask(fixture: Fixture, roleId: string, input: Record<string, unknown>) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId,
    budgetAccountId: fixture.budgetAccountId,
    input,
    createdBy: 'owner',
    reserveTokens: 50_000,
  });
}

test('malformed input is refused before the run spends anything', async () => {
  const fixture = await createCompany('contract-input');
  await setRoleSchemas(fixture, fixture.roleId, { input: WRITE_INPUT });

  let handlerRan = false;
  const engine = engineWith({
    worker: async () => {
      handlerRan = true;
      return { findings: [] };
    },
  });

  const task = await rootTask(fixture, fixture.roleId, { findings: 'not an array' });
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  // Halted, not failed: retrying the same malformed input would only burn
  // attempts, so it is terminal and lands in the owner's inbox.
  assert.equal(outcome.status, 'halted');
  assert.match(outcome.reason ?? '', /does not satisfy its contract/);
  assert.equal(handlerRan, false, 'the model must not be called on input a schema could reject');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.haltReason, 'contract_violation');
});

test('malformed output is refused before the task is marked complete', async () => {
  const fixture = await createCompany('contract-output');
  await setRoleSchemas(fixture, fixture.roleId, { output: RESEARCH_OUTPUT });

  const engine = engineWith({ worker: async () => ({ findings: [42] } as never) });
  const task = await rootTask(fixture, fixture.roleId, {});
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.notEqual(outcome.status, 'completed');
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.notEqual(stored!.status, 'completed', 'a downstream task must not be able to read this');
});

test('a role with no declared contract accepts anything', async () => {
  // A deliberate escape hatch for a role still being designed, not a default
  // to leave in place.
  const fixture = await createCompany('contract-open');
  const engine = engineWith({ worker: async () => ({ anything: true }) });
  const task = await rootTask(fixture, fixture.roleId, { whatever: [1, 2, 3] });
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed');
});

test('handoff is triggered by completion, not by the finishing agent (F6.3)', async () => {
  const fixture = await createCompany('handoff');
  await setRoleSchemas(fixture, fixture.roleId, { output: RESEARCH_OUTPUT });
  const writerId = await addRole(fixture, 'writer', { input: WRITE_INPUT });

  const engine = engineWith({
    worker: async () => ({ findings: ['a', 'b'] }),
    writer: async (ctx) => ({ draft: (ctx.task.input.findings as string[]).join(' and ') }),
  });

  const research = await rootTask(fixture, fixture.roleId, {});
  assert.equal((await engine.runTask(fixture.companyId, research.id, 'worker')).status, 'completed');

  const rules = [
    {
      fromRoleSlug: 'worker',
      toRoleSlug: 'writer',
      mapInput: (output: Record<string, unknown>) => ({ findings: output.findings }),
    },
  ];

  const created = await processHandoffs(fixture.companyId, rules);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.toRoleSlug, 'writer');

  // Running the rules again must not fan out a second successor.
  const again = await processHandoffs(fixture.companyId, rules);
  assert.equal(again.length, 0, 'a completed task hands off exactly once');

  const successor = await withTenant(fixture.companyId, (tx) => getTask(tx, created[0]!.toTaskId));
  assert.equal(successor!.parentTaskId, research.id);
  assert.equal(successor!.roleId, writerId);
  assert.deepEqual(successor!.input, { findings: ['a', 'b'] });
  assert.equal(
    successor!.budgetAccountId,
    research.budgetAccountId,
    'a handoff inherits the budget rather than opening a new one',
  );

  const outcome = await engine.runTask(fixture.companyId, successor!.id, 'writer');
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.output, { draft: 'a and b' });

  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      "SELECT type FROM events WHERE type LIKE 'handoff.%'",
    );
    return rows.map((r) => r.type);
  });
  assert.deepEqual(events, ['handoff.created']);
});

test('a handoff rule may decline without a condition language', async () => {
  const fixture = await createCompany('handoff-decline');
  await addRole(fixture, 'writer');

  const engine = engineWith({ worker: async () => ({ findings: [] }) });
  const task = await rootTask(fixture, fixture.roleId, {});
  await engine.runTask(fixture.companyId, task.id, 'worker');

  const created = await processHandoffs(fixture.companyId, [
    {
      fromRoleSlug: 'worker',
      toRoleSlug: 'writer',
      mapInput: (output) => ((output.findings as string[]).length > 0 ? { findings: output.findings } : null),
    },
  ]);
  assert.equal(created.length, 0, 'nothing to write about, so nothing is started');
});

test('awaitChild requires a timeout and enforces it (F6.4)', async () => {
  const fixture = await createCompany('await-child');
  await addRole(fixture, 'slow');

  const engine = engineWith({
    worker: async (ctx) => {
      await assert.rejects(
        () => ctx.awaitChild('slow', {}, { timeoutMs: 0 }),
        /requires a positive timeoutMs/,
        'a blocking call with no deadline must not be expressible',
      );
      const result = await ctx.awaitChild('slow', { n: 1 }, { timeoutMs: 5000 });
      return { fromChild: result };
    },
    slow: async () => ({ answer: 'child result' }),
  });

  const task = await rootTask(fixture, fixture.roleId, {});
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.output, { fromChild: { answer: 'child result' } });

  const child = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; budget_account_id: string }>(
      'SELECT id, status, budget_account_id FROM tasks WHERE parent_task_id = $1',
      [task.id],
    );
    return rows[0]!;
  });
  assert.equal(child.status, 'completed');
  assert.equal(child.budget_account_id, task.budgetAccountId);
});

test('a child that overruns its timeout is halted, not left running', async () => {
  const fixture = await createCompany('await-timeout');
  await addRole(fixture, 'stuck');

  const engine = engineWith({
    worker: async (ctx) => ({ result: await ctx.awaitChild('stuck', {}, { timeoutMs: 120 }) }),
    stuck: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { never: true };
    },
  });

  const task = await rootTask(fixture, fixture.roleId, {});
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted');
  assert.equal(outcome.reason, 'deadline_passed');

  const child = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string; halt_reason: string | null }>(
      'SELECT status, halt_reason FROM tasks WHERE parent_task_id = $1',
      [task.id],
    );
    return rows[0]!;
  });
  assert.equal(child.status, 'halted');
  assert.equal(child.halt_reason, 'deadline_passed');
});

test('an abandoned run stops committing once its task has ended', async () => {
  // The timeout in awaitChild marks the child halted, but the child's handler
  // is still executing: Promise.race abandons a promise, it does not cancel
  // one. Without a guard the orphan keeps journalling steps against a task the
  // system considers finished -- spending budget, and potentially touching the
  // outside world, for a caller that gave up long ago.
  const fixture = await createCompany('abandoned-run');
  await addRole(fixture, 'slow-writer');

  let stepsAttempted = 0;
  const engine = engineWith({
    worker: async (ctx) => ({ result: await ctx.awaitChild('slow-writer', {}, { timeoutMs: 100 }) }),
    'slow-writer': async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      stepsAttempted += 1;
      await ctx.step('late-write', 'internal', { n: 1 }, async () => ({ wrote: true }));
      return { done: true };
    },
  });

  const task = await rootTask(fixture, fixture.roleId, {});
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted');

  // Let the abandoned child run past its sleep and try to commit.
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(stepsAttempted, 1, 'the orphaned handler does keep executing');

  const child = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM tasks WHERE parent_task_id = $1',
      [task.id],
    );
    return rows[0]!;
  });
  assert.equal(child.status, 'halted', 'the outcome recorded at timeout still stands');

  const committed = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM task_steps WHERE task_id = $1 AND status = 'committed'",
      [child.id],
    );
    return Number(rows[0]!.count);
  });
  assert.equal(committed, 0, 'no step may be committed against a task that has already ended');
});

test('no agent-to-agent messaging primitive exists (F6.1)', async () => {
  // F6.1 is a statement about what the codebase must NOT contain, so it is
  // checked against the source rather than against behaviour. A test that only
  // exercised the sanctioned path would pass just as happily on the day
  // somebody added a sendMessage() beside it.
  const forbidden = /\b(sendMessage|sendToAgent|agentMessage|messageAgent|postToAgent)\b/;
  const offenders: string[] = [];

  for await (const file of glob('src/**/*.ts')) {
    const source = await readFile(file, 'utf8');
    if (forbidden.test(source)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    'the only way to reach another role is to create a task with a typed contract',
  );
});
