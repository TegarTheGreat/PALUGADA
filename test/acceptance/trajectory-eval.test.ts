/**
 * PRD v2 F17 and F11.7 -- trajectories, and the eval sets a role is judged by.
 *
 * F17's argument is that "this rewrite is an improvement" should stop being an
 * assertion and become a claim somebody can check. These tests hold the two
 * halves of that: a run can be reconstructed from what was already recorded,
 * and a change to a role is scored against runs somebody kept on purpose --
 * with an unscored role reported as unscored rather than as passing.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { exportTrajectory, trajectoriesForTask } from '../../src/eval/trajectory.ts';
import {
  MINIMUM_EVAL_CASES,
  acceptEvalCase,
  captureEvalCase,
  evalCasesFor,
  expectationFrom,
  latestScore,
  requestRoleChange,
  scoreRoleChange,
} from '../../src/eval/role-eval.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function dnsRead(): Capability<{ zone: string }, { records: string[] }> {
  return {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async execute() {
      return { records: ['a.example.com'] };
    },
  };
}

async function engineFor(fixture: Fixture, handler: TaskHandler) {
  const registry = new CapabilityRegistry();
  registry.register(dnsRead());
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET tools = ARRAY['dns.read'] WHERE id = $1", [fixture.roleId]);
  });

  return new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', handler]]),
    workerId: 'eval-worker',
  });
}

let sequence = 0;
async function newTask(fixture: Fixture, options: { attemptMax?: number } = {}) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { run: sequence },
    createdBy: 'owner',
    reserveTokens: 20_000,
    ...(options.attemptMax === undefined ? {} : { attemptMax: options.attemptMax }),
  });
}

async function agentRunIdFor(companyId: string, taskId: string): Promise<string> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM agent_runs WHERE task_id = $1 ORDER BY attempt DESC LIMIT 1',
      [taskId],
    );
    return rows[0]!.id;
  });
}

/* ----------------------------------------------------------- F17.1, F11.7 --- */

test('an agent run exports as a trajectory: context, tool calls, model calls, output (F17.1)', async () => {
  const fixture = await createCompany('trajectory-export');
  const engine = await engineFor(fixture, async (ctx) => {
    await ctx.llm({ system: 'be brief', messages: [{ role: 'user', content: 'what is in the zone' }] });
    const zone = await ctx.callCapability<{ zone: string }, { records: string[] }>('dns.read', {
      zone: 'example.com',
    });
    return { records: zone.records.length };
  });

  const task = await newTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);

  const trajectory = await exportTrajectory(
    fixture.companyId,
    await agentRunIdFor(fixture.companyId, task.id),
  );
  assert.ok(trajectory);
  assert.equal(trajectory.roleSlug, 'worker');
  assert.equal(trajectory.status, 'succeeded');
  assert.deepEqual(trajectory.output, { records: 1 });

  // The goal chain the run was working towards, which is most of "the context
  // it was given".
  assert.deepEqual(
    trajectory.goalAncestry.map((goal) => goal.kind),
    ['mission', 'objective'],
  );

  const toolCalls = trajectory.steps.filter((step) => step.kind === 'tool_call');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.detail.capability, 'dns.read');

  assert.ok(trajectory.steps.some((step) => step.kind === 'model'));
  assert.ok(trajectory.tokens.input > 0);

  // Time order, because a trajectory that is not in order is a bag of records.
  const times = trajectory.steps.map((step) => step.at);
  assert.deepEqual(times, [...times].sort());
});

/**
 * A hook refusal is part of the trajectory.
 *
 * F17.1 lists hook decisions explicitly, and it is the item that would be
 * easiest to leave out: the run did not do the thing, so there is nothing to
 * record — except that "was refused" is exactly what an eval needs to know.
 */
test('a hook refusal appears in the trajectory (F17.1)', async () => {
  const fixture = await createCompany('trajectory-hook');
  const engine = await engineFor(fixture, async (ctx) => {
    try {
      await ctx.callCapability('dns.read', { zone: 'example.com' });
    } catch {
      // The refusal is the subject of the test; the run carries on so that it
      // reaches an end and can be exported.
    }
    return { done: true };
  });

  engine.hooks.add({
    name: 'test.refuse',
    on: 'pre_tool',
    async run() {
      return { allow: false, reason: 'dns is frozen during the migration' };
    },
  });

  const task = await newTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');

  const trajectory = await exportTrajectory(
    fixture.companyId,
    await agentRunIdFor(fixture.companyId, task.id),
  );
  const hookSteps = trajectory!.steps.filter((step) => step.kind === 'hook');
  assert.equal(hookSteps.length, 1);
  assert.equal(hookSteps[0]!.name, 'hook.pre_tool');
  assert.equal(hookSteps[0]!.detail.hook, 'test.refuse');
  assert.equal(hookSteps[0]!.detail.decision, 'deny');
});

test('every attempt at a task is its own trajectory (F11.7)', async () => {
  const fixture = await createCompany('trajectory-attempts');
  let attempts = 0;
  const engine = await engineFor(fixture, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('the first attempt did not work');
    return { attempts };
  });

  const task = await newTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  await engine.runTask(fixture.companyId, task.id, 'worker');

  const trajectories = await trajectoriesForTask(fixture.companyId, task.id);
  assert.equal(trajectories.length, 2);
  assert.equal(trajectories[0]!.status, 'failed');
  assert.equal(trajectories[1]!.status, 'succeeded');
});

/* ------------------------------------------------------------------ F17.4 --- */

test('a halted run becomes a negative eval candidate on its own (F17.4)', async () => {
  const fixture = await createCompany('eval-negative');
  const engine = await engineFor(fixture, async () => {
    // A budget refusal halts, which is the terminal shape F17.4 is about.
    const { PalugadaError } = await import('../../src/errors.ts');
    throw new PalugadaError('budget.exceeded', 'the account has no tokens left', {});
  });

  const task = await newTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted');

  const cases = await evalCasesFor(fixture.companyId, fixture.roleId);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.polarity, 'negative');
  assert.match(cases[0]!.name, /budget_exhausted/);

  // A candidate, not a case. Whether the role is judged against it is still
  // somebody's decision.
  assert.equal(cases[0]!.accepted, false);
});

/* ------------------------------------------------------------ F17.2, F17.3 --- */

test('a role with fewer than five references is unscored, which is not passing (F17.2)', async () => {
  const fixture = await createCompany('eval-floor');
  const engine = await engineFor(fixture, async () => ({ ok: true }));

  for (let index = 0; index < MINIMUM_EVAL_CASES - 1; index += 1) {
    const task = await newTask(fixture);
    await engine.runTask(fixture.companyId, task.id, 'worker');
    const captured = await captureEvalCase({
      companyId: fixture.companyId,
      agentRunId: await agentRunIdFor(fixture.companyId, task.id),
      name: `reference ${index}`,
      accepted: true,
    });
    assert.equal(captured!.polarity, 'positive');
  }

  const score = await scoreRoleChange({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    change: 'model_routing',
    tools: ['dns.read'],
  });
  assert.equal(score.scored, false);
  assert.equal(score.passed, 0);
  assert.equal(score.failed, 0);
});

test('a change that removes a capability a reference run used fails its eval (F17.2)', async () => {
  const fixture = await createCompany('eval-regression');
  const engine = await engineFor(fixture, async (ctx) => {
    await ctx.callCapability('dns.read', { zone: 'example.com' });
    return { ok: true };
  });

  for (let index = 0; index < MINIMUM_EVAL_CASES; index += 1) {
    const task = await newTask(fixture);
    await engine.runTask(fixture.companyId, task.id, 'worker');
    await captureEvalCase({
      companyId: fixture.companyId,
      agentRunId: await agentRunIdFor(fixture.companyId, task.id),
      name: `reference ${index}`,
      accepted: true,
    });
  }

  const keeping = await scoreRoleChange({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    change: 'skills',
    tools: ['dns.read'],
  });
  assert.equal(keeping.scored, true);
  assert.equal(keeping.passed, MINIMUM_EVAL_CASES);
  assert.equal(keeping.failed, 0);

  const removing = await scoreRoleChange({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    change: 'skills',
    tools: [],
  });
  assert.equal(removing.failed, MINIMUM_EVAL_CASES);
  assert.match(removing.cases[0]!.detail, /removes dns\.read/);
});

/**
 * F17.3: the score reaches the owner before the decision, not after it.
 *
 * And the change is not applied by this call — F2.9 makes changing what a role
 * is a structural change, which is the owner's.
 */
test('a role change asks the owner and carries its score (F17.3, F2.9)', async () => {
  const fixture = await createCompany('eval-approval');
  const engine = await engineFor(fixture, async (ctx) => {
    await ctx.callCapability('dns.read', { zone: 'example.com' });
    return { ok: true };
  });

  for (let index = 0; index < MINIMUM_EVAL_CASES; index += 1) {
    const task = await newTask(fixture);
    await engine.runTask(fixture.companyId, task.id, 'worker');
    await captureEvalCase({
      companyId: fixture.companyId,
      agentRunId: await agentRunIdFor(fixture.companyId, task.id),
      name: `reference ${index}`,
      accepted: true,
    });
  }

  const requested = await requestRoleChange({
    companyId: fixture.companyId,
    roleId: fixture.roleId,
    change: 'charter',
    tools: [],
    summary: 'Narrow the worker to reading nothing at all.',
  });

  assert.equal(requested.score.failed, MINIMUM_EVAL_CASES);

  const open = await inbox.listOpen(fixture.companyId);
  const item = open.find((entry) => entry.id === requested.inboxItemId);
  assert.ok(item);
  assert.equal(item.kind, 'approval');
  assert.equal(item.tier, 3, 'F2.9: a structural change is tier 3');
  assert.match(item.rationale, /5 failed of 5 reference trajectories/);
  assert.match(item.rationale, /removes dns\.read/);

  // F17.3 again: the score is kept, so "what did it score when I approved it"
  // stays answerable after the role changes again.
  const stored = await latestScore(fixture.companyId, fixture.roleId);
  assert.equal(stored!.triggeredBy, 'charter');
  assert.equal(stored!.failed, MINIMUM_EVAL_CASES);
});

test('an unaccepted candidate does not judge a role change', async () => {
  const fixture = await createCompany('eval-unaccepted');
  const engine = await engineFor(fixture, async (ctx) => {
    await ctx.callCapability('dns.read', { zone: 'example.com' });
    return { ok: true };
  });

  const ids: string[] = [];
  for (let index = 0; index < MINIMUM_EVAL_CASES; index += 1) {
    const task = await newTask(fixture);
    await engine.runTask(fixture.companyId, task.id, 'worker');
    const captured = await captureEvalCase({
      companyId: fixture.companyId,
      agentRunId: await agentRunIdFor(fixture.companyId, task.id),
      name: `reference ${index}`,
      accepted: false,
    });
    ids.push(captured!.id);
  }

  assert.equal(
    (await scoreRoleChange({
      companyId: fixture.companyId,
      roleId: fixture.roleId,
      change: 'skills',
      tools: [],
    })).scored,
    false,
  );

  for (const id of ids) await acceptEvalCase(fixture.companyId, id);

  assert.equal(
    (await scoreRoleChange({
      companyId: fixture.companyId,
      roleId: fixture.roleId,
      change: 'skills',
      tools: [],
    })).scored,
    true,
  );
});

test('an expectation is derived from the run rather than written by hand', () => {
  const expectation = expectationFrom({
    haltReason: null,
    status: 'succeeded',
    steps: [
      { at: '1', kind: 'tool_call', name: 'tool.called', detail: { capability: 'dns.read' } },
      { at: '2', kind: 'tool_call', name: 'tool.called', detail: { capability: 'dns.read' } },
      { at: '3', kind: 'tool_call', name: 'tool.called', detail: { capability: 'email.send' } },
      { at: '4', kind: 'model', name: 'model.call', detail: {} },
    ],
  } as never);

  assert.deepEqual(expectation.capabilities, ['dns.read', 'email.send']);
  assert.equal(expectation.failureMode, null);
});
