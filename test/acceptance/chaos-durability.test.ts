/**
 * PRD section 9 durability target and F5.1 -- the routine chaos test.
 *
 * Section 9 sets the target as "0 tasks lost on a worker or database failover,
 * tested by a weekly chaos test". A single hand-picked crash point does not
 * test that: it tests the one place somebody thought to look. So this sweeps
 * the kill point across every step boundary of a task and asserts the same two
 * properties every time -- the task still finishes with the identical output,
 * and no side effect happens twice.
 *
 * The second property is the one that matters in production. A task that
 * resumes but re-sends an email has not been recovered; it has been run twice.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { countCommittedSteps } from '../../src/engine/journal.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const STEP_COUNT = 8;

/**
 * A task that mixes model calls with an external write.
 *
 * The external write is what makes the test meaningful: replaying a model call
 * costs money, but replaying a write changes the world.
 */
function chaosHandler(crashAfter: number | null, sideEffects: string[]): TaskHandler {
  return async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < STEP_COUNT; i += 1) {
      if (crashAfter !== null && i === crashAfter) {
        throw new Error(`worker killed before step ${i}`);
      }
      if (i === 3) {
        await ctx.callCapability('email.send', { to: `client-${i}@example.test` });
        results.push('sent');
        continue;
      }
      results.push(
        await ctx.llm({
          system: 'You are a worker.',
          messages: [{ role: 'user', content: `step ${i}` }],
        }),
      );
    }
    void sideEffects;
    return { results };
  };
}

function buildEngine(handler: TaskHandler, sideEffects: string[]) {
  const capability: Capability<{ to: string }, { sent: boolean }> = {
    name: 'email.send',
    adapter: 'test:email',
    // Tier 2, matching the catalogue: PRD section 8.8 lists external email as a
    // tier 2 example, and a double that claimed tier 1 would be exercising
    // a gate the real capability never passes through.
    defaultTier: 2,
    async execute(input) {
      sideEffects.push(input.to);
      return { sent: true };
    },
    async verify() {
      return true;
    },
  };

  const registry = new CapabilityRegistry();
  registry.register(capability);

  const llm = new RecordingLlmClient((request) => `response-${request.messages[0]!.content}`);
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm,
    handlers: new Map([['worker', handler]]),
  });
  return { engine, registry, llm };
}

async function newTask(fixture: Fixture, key: string) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { run: key },
    createdBy: 'owner',
    reserveTokens: 200_000,
  });
}

test('a task survives a kill at every step boundary', async () => {
  const fixture = await createCompany('chaos-sweep');
  {
    const { registry } = buildEngine(chaosHandler(null, []), []);
    await registry.sync();
  }
  await grantCapability(fixture, 'email.send');

  // The reference result, from a run nothing interrupted.
  const cleanEffects: string[] = [];
  const cleanTask = await newTask(fixture, 'clean');
  const { engine: cleanEngine } = buildEngine(chaosHandler(null, cleanEffects), cleanEffects);
  const clean = await cleanEngine.runTask(fixture.companyId, cleanTask.id, 'worker');
  assert.equal(clean.status, 'completed');
  assert.equal(cleanEffects.length, 1);

  // Now kill the worker just before each step in turn.
  for (let killAt = 1; killAt < STEP_COUNT; killAt += 1) {
    const sideEffects: string[] = [];
    const task = await newTask(fixture, `kill-at-${killAt}`);

    // Each restart is a fresh engine and a fresh model client, as a restarted
    // process would be. Anything the new client is asked for is work the
    // journal failed to preserve.
    const { engine: dying, llm: dyingLlm } = buildEngine(
      chaosHandler(killAt, sideEffects),
      sideEffects,
    );
    const crashed = await dying.runTask(fixture.companyId, task.id, 'worker');
    assert.notEqual(crashed.status, 'completed', `kill at ${killAt} should not complete`);

    const committedBeforeRestart = await countCommittedSteps(fixture.companyId, task.id);
    assert.equal(
      committedBeforeRestart,
      killAt,
      `kill at ${killAt}: exactly the steps that finished should be committed`,
    );

    const { engine: resumed, llm: resumedLlm } = buildEngine(
      chaosHandler(null, sideEffects),
      sideEffects,
    );
    const outcome = await resumed.runTask(fixture.companyId, task.id, 'worker');

    assert.equal(outcome.status, 'completed', `kill at ${killAt} should resume to completion`);
    assert.deepEqual(
      outcome.output,
      clean.output,
      `kill at ${killAt}: output must match an uninterrupted run`,
    );

    // The external write happened exactly once across both runs, whether the
    // kill landed before it, on it, or after it.
    assert.equal(
      sideEffects.length,
      1,
      `kill at ${killAt}: the external write must not repeat (saw ${sideEffects.join(', ')})`,
    );

    // And the model was only asked for the steps that were never committed.
    assert.equal(
      dyingLlm.callCount + resumedLlm.callCount,
      STEP_COUNT - 1,
      `kill at ${killAt}: no model call should be paid for twice`,
    );

    assert.equal(await countCommittedSteps(fixture.companyId, task.id), STEP_COUNT);
  }
});

test('a process-level kill does not consume a retry attempt', async () => {
  // The distinction matters more than it looks. A handler that throws has
  // failed, and consuming an attempt is right. A worker that is SIGKILLed has
  // not failed: it never reached the engine's error handling, so the task row
  // is simply left `running` with its committed steps. If that consumed an
  // attempt, a bad deploy restarting every process would burn through
  // attempt_max and fail every in-flight task -- which is precisely the "work
  // lost" G1 rules out.
  //
  // This test reproduces the state a SIGKILL actually leaves, rather than
  // approximating it with a throw.
  const fixture = await createCompany('chaos-sigkill');
  {
    const { registry } = buildEngine(chaosHandler(null, []), []);
    await registry.sync();
  }
  await grantCapability(fixture, 'email.send');

  const sideEffects: string[] = [];
  const task = await newTask(fixture, 'sigkill');

  // Partially run it, then leave the task exactly as a killed process would:
  // status `running`, some steps committed, attempt untouched.
  const { engine: partial } = buildEngine(chaosHandler(3, sideEffects), sideEffects);
  await partial.runTask(fixture.companyId, task.id, 'worker');

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `UPDATE tasks SET status = 'running', attempt = 0 WHERE id = $1`,
      [task.id],
    );
  });

  const before = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(before!.attempt, 0);
  assert.equal(await countCommittedSteps(fixture.companyId, task.id), 3);

  const { engine: resumed } = buildEngine(chaosHandler(null, sideEffects), sideEffects);
  const outcome = await resumed.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed');
  const after = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(after!.attempt, 0, 'resuming after a process kill is not a retry');
  assert.equal(sideEffects.length, 1);
});

test('repeated handler failures converge, and do consume attempts', async () => {
  // A worker that keeps dying is the realistic failure, not a single clean
  // crash: a bad deploy restarts every process every few seconds. Here the
  // crash surfaces as a thrown error, which the engine correctly counts as a
  // failed attempt -- so the task needs an attempt budget that allows for it.
  const fixture = await createCompany('chaos-repeated');
  {
    const { registry } = buildEngine(chaosHandler(null, []), []);
    await registry.sync();
  }
  await grantCapability(fixture, 'email.send');

  const sideEffects: string[] = [];
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { run: 'repeated' },
    createdBy: 'owner',
    reserveTokens: 200_000,
    attemptMax: 10,
  });
  let totalLlmCalls = 0;

  for (const killAt of [2, 4, 6]) {
    const { engine, llm } = buildEngine(chaosHandler(killAt, sideEffects), sideEffects);
    await engine.runTask(fixture.companyId, task.id, 'worker');
    totalLlmCalls += llm.callCount;
  }

  const { engine, llm } = buildEngine(chaosHandler(null, sideEffects), sideEffects);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  totalLlmCalls += llm.callCount;

  assert.equal(outcome.status, 'completed');
  assert.equal(sideEffects.length, 1, 'three crashes must not produce three emails');
  assert.equal(totalLlmCalls, STEP_COUNT - 1, 'no model call paid for twice across three crashes');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.attempt, 3, 'each thrown failure consumed exactly one attempt');
});

test('a crash between the side effect and its journal entry does not lose the task', async () => {
  // The genuinely hard case: the external system already acted, but the
  // process died before the step was committed. The idempotency key is what
  // lets the downstream system recognise the repeat, so the test asserts the
  // key is stable across the crash rather than pretending the call vanished.
  const fixture = await createCompany('chaos-gap');
  {
    const { registry } = buildEngine(chaosHandler(null, []), []);
    await registry.sync();
  }
  await grantCapability(fixture, 'email.send');

  const seenKeys: string[] = [];
  const capability: Capability<{ to: string }, { sent: boolean }> = {
    name: 'email.send',
    adapter: 'test:email',
    // Tier 2, matching the catalogue: PRD section 8.8 lists external email as a
    // tier 2 example, and a double that claimed tier 1 would be exercising
    // a gate the real capability never passes through.
    defaultTier: 2,
    async execute(_input, ctx) {
      seenKeys.push(ctx.idempotencyKey);
      // The world changed, and then the worker died before committing.
      throw new Error('worker killed after the provider accepted the request');
    },
    async verify() {
      return true;
    },
  };

  const registry = new CapabilityRegistry();
  registry.register(capability);
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([
      ['worker', async (ctx) => {
        await ctx.callCapability('email.send', { to: 'client@example.test' });
        return {};
      }],
    ]),
  });

  const task = await newTask(fixture, 'gap');
  await engine.runTask(fixture.companyId, task.id, 'worker');
  await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(seenKeys.length, 2, 'the call is retried, as it must be');
  assert.equal(
    seenKeys[0],
    seenKeys[1],
    'and carries the same idempotency key, so the provider can recognise the repeat',
  );

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.notEqual(stored!.status, 'completed');
  assert.equal(
    await countCommittedSteps(fixture.companyId, task.id),
    0,
    'an uncommitted step stays uncommitted rather than being assumed done',
  );
});
