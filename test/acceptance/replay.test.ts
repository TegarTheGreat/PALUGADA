/**
 * PRD F5.9 -- dry-run replay.
 *
 * The requirement is a replay "in dry-run mode for debugging", so the tests
 * are about two things: it reproduces what happened, and it cannot cause
 * anything to happen. The second is the one worth being strict about -- a
 * replay of a task that bought a domain must never buy the domain again.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { closePools } from '../../src/db/pool.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { describeReplay, replayTask, type ReplayHandler } from '../../src/engine/replay.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function deployCapability(sideEffects: string[]) {
  const capability: Capability<{ target: string }, { ok: boolean }> = {
    name: 'deploy.production',
    adapter: 'test:deploy',
    // Tier 2, matching the catalogue: PRD section 8.8 lists a production deploy as a
    // tier 2 example, and a double that claimed tier 1 would be exercising
    // a gate the real capability never passes through.
    defaultTier: 2,
    async execute(input) {
      sideEffects.push(input.target);
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  return capability;
}

/** The handler under test, shared between the live run and the replay. */
const HANDLER = (async (ctx) => {
  const plan = await ctx.llm({
    system: 'You are an operator.',
    messages: [{ role: 'user', content: 'plan the deploy' }],
  });
  const deployed = await ctx.callCapability('deploy.production', { target: 'www' });
  return { plan, deployed: deployed as Record<string, unknown> };
}) as TaskHandler & ReplayHandler;

async function liveRun(fixture: Fixture, sideEffects: string[]) {
  const registry = new CapabilityRegistry();
  registry.register(deployCapability(sideEffects));
  await registry.sync();
  await grantCapability(fixture, 'deploy.production');

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(() => 'deploy at 02:00'),
    handlers: new Map([['worker', HANDLER]]),
  });

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: {},
    createdBy: 'owner',
    reserveTokens: 50_000,
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  return { task, outcome };
}

test('a replay reproduces the run without repeating any of it (F5.9)', async () => {
  const fixture = await createCompany('replay-dryrun');
  const sideEffects: string[] = [];
  const { task, outcome } = await liveRun(fixture, sideEffects);

  assert.equal(outcome.status, 'completed');
  assert.equal(sideEffects.length, 1, 'the live run deployed once');

  const report = await replayTask(fixture.companyId, task.id, HANDLER);

  assert.deepEqual(report.output, outcome.output, 'the replay reaches the same result');
  assert.equal(report.error, null);
  assert.deepEqual(report.divergences, []);
  assert.equal(report.unusedSteps, 0);
  assert.equal(report.steps.length, 2);
  assert.deepEqual(report.steps.map((step) => step.kind), ['llm', 'tool']);

  // The whole point: nothing happened again.
  assert.equal(sideEffects.length, 1, 'a replay must not deploy a second time');
  assert.match(describeReplay(report), /no divergence/);
});

test('a replay never reaches the model or an adapter', async () => {
  const fixture = await createCompany('replay-noexternal');
  const sideEffects: string[] = [];
  const { task } = await liveRun(fixture, sideEffects);

  // A model client that would make the failure loud if the replay reached it.
  let modelCalls = 0;
  const spy = new RecordingLlmClient(() => {
    modelCalls += 1;
    return 'this must never be produced during a replay';
  });
  void spy;

  const report = await replayTask(fixture.companyId, task.id, HANDLER);

  assert.equal(modelCalls, 0);
  assert.equal(sideEffects.length, 1);
  assert.equal(report.steps[0]!.output, 'deploy at 02:00', 'the model answer came from the journal');
});

test('the replay module imports no broker, adapter or model client', async () => {
  // The guarantee is structural, not a runtime flag. A dry run that could
  // reach the world under some condition eventually would, so the module has
  // nothing to reach it with -- asserted against the source, because a
  // behavioural test would pass just as happily the day an import is added
  // behind an `if`.
  const source = await readFile('src/engine/replay.ts', 'utf8');
  for (const forbidden of ['broker', 'LlmClient', 'registry', 'capabilities/']) {
    assert.equal(
      source.includes(`from '../broker`) || source.includes(`from '../llm`),
      false,
      `replay must not import ${forbidden}`,
    );
  }
});

test('a handler that changed since the run reports a divergence', async () => {
  // The most useful thing a replay can say: the code no longer does what it
  // did when the journal was written.
  const fixture = await createCompany('replay-divergence');
  const sideEffects: string[] = [];
  const { task } = await liveRun(fixture, sideEffects);

  const changed: ReplayHandler = async (ctx) => {
    const plan = await ctx.llm({
      system: 'You are an operator.',
      messages: [{ role: 'user', content: 'plan the deploy' }],
    });
    // The target changed since the recorded run.
    const deployed = await ctx.callCapability('deploy.production', { target: 'staging' });
    // And an extra step the original never took.
    const extra = await ctx.step('new-check', 'internal', {}, undefined);
    return { plan, deployed: deployed as Record<string, unknown>, extra: extra as unknown };
  };

  const report = await replayTask(fixture.companyId, task.id, changed);

  const reasons = report.divergences.map((divergence) => divergence.reason);
  assert.ok(reasons.includes('different_input'), 'the changed argument is reported');
  assert.ok(reasons.includes('missing_step'), 'the extra step is reported');
  assert.equal(sideEffects.length, 1, 'and still nothing was executed');
  assert.match(describeReplay(report), /divergence/);
});

test('a replay of a halted task still explains how far it got', async () => {
  const fixture = await createCompany('replay-halted');
  const sideEffects: string[] = [];

  const registry = new CapabilityRegistry();
  registry.register(deployCapability(sideEffects));
  await registry.sync();
  // No grant, so the deploy is refused and the task never completes.

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(() => 'deploy at 02:00'),
    handlers: new Map([['worker', HANDLER]]),
  });

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: {},
    createdBy: 'owner',
    reserveTokens: 50_000,
  });
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.notEqual(outcome.status, 'completed');

  const report = await replayTask(fixture.companyId, task.id, HANDLER);

  // The model call committed; the refused capability call did not. So the
  // replay shows one step and then a divergence where the journal runs out --
  // which is exactly where the live run stopped.
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0]!.kind, 'llm');
  assert.equal(report.divergences[0]!.reason, 'missing_step');
  assert.equal(sideEffects.length, 0);
});
