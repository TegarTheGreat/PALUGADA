/**
 * PRD F5.1 -- durable resume.
 *
 * Acceptance criterion: a worker is killed halfway through a ten-step task;
 * after restart steps 1-5 are not re-issued to the model (provable from the
 * trace) and the task finishes with identical output.
 *
 * The crash is simulated by throwing inside the handler after five steps have
 * committed. That is faithful to what a SIGKILL leaves behind -- five
 * committed journal rows and no sixth -- while staying deterministic.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { countCommittedSteps } from '../../src/engine/journal.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { reportOn } from '../helpers/done.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const STEP_COUNT = 10;

/** Ten model calls in a fixed order, optionally dying after `crashAfter`. */
function tenStepHandler(crashAfter: number | null): TaskHandler {
  return async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < STEP_COUNT; i += 1) {
      if (crashAfter !== null && i === crashAfter) {
        throw new Error('worker killed');
      }
      results.push(
        await ctx.llm({
          system: 'You are a worker.',
          messages: [{ role: 'user', content: `step ${i}` }],
        }),
      );
    }
    return { results };
  };
}

async function newEngine(handler: TaskHandler) {
  const registry = new CapabilityRegistry();
  // The reply is derived from the prompt rather than from a per-process call
  // counter. A counter would renumber every answer after a restart and make
  // the output differ for reasons that have nothing to do with replay.
  const llm = new RecordingLlmClient((request) => `response-${request.messages[0]!.content}`);
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    workerId: 'resume-worker',
    llm,
    handlers: new Map([['worker', handler]]),
  });
  return { engine, llm };
}

async function newTask(fixture: Fixture) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: 'ten steps' },
    createdBy: 'owner',
    reserveTokens: 100_000,
  });
}

test('a task killed at step five resumes at step six with identical output', async () => {
  const fixture = await createCompany('durable');

  // Baseline: the same handler with no crash, for the output comparison.
  const baselineTask = await newTask(fixture);
  const baseline = await newEngine(tenStepHandler(null));
  const clean = await baseline.engine.runTask(fixture.companyId, baselineTask.id, 'worker');
  assert.equal(clean.status, 'completed');
  assert.equal(baseline.llm.callCount, STEP_COUNT);

  // First run of the task under test: dies after five committed steps.
  const fixture2 = await createCompany('durable-crash');
  const task = await newTask(fixture2);
  const first = await newEngine(tenStepHandler(5));
  const crashed = await first.engine.runTask(fixture2.companyId, task.id, 'worker');

  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.reason, 'retryable', 'the attempt budget was not yet exhausted');
  assert.equal(first.llm.callCount, 5, 'exactly five model calls happened before the crash');
  assert.equal(await countCommittedSteps(fixture2.companyId, task.id), 5);

  // Restart: a brand new engine and a brand new model client, as a restarted
  // process would have. Any call this client records is a call that was NOT
  // served from the journal.
  const second = await newEngine(tenStepHandler(null));
  const resumed = await second.engine.runTask(fixture2.companyId, task.id, 'worker');

  assert.equal(resumed.status, 'completed');
  assert.equal(
    second.llm.callCount,
    STEP_COUNT - 5,
    'the resumed run must only call the model for the five steps that were never committed',
  );

  // The replayed steps must carry their original outputs, not fresh ones.
  assert.deepEqual(
    resumed.output,
    clean.output,
    'a resumed task must finish with the same output as one that never crashed',
  );
  assert.equal(await countCommittedSteps(fixture2.companyId, task.id), STEP_COUNT);
});

test('a committed side effect is not repeated when the task retries', async () => {
  const fixture = await createCompany('replay-proof');
  const task = await newTask(fixture);

  // The step below stands in for an external write. It must happen exactly
  // once even though the task runs twice, which is the property that makes a
  // retry safe for work that already touched the outside world.
  let sideEffects = 0;
  let failAfterStep = true;
  const handler: TaskHandler = async (ctx) => {
    const a = await ctx.step('effect', 'internal', { n: 1 }, async () => {
      sideEffects += 1;
      return { value: sideEffects };
    });
    if (failAfterStep) throw new Error('worker killed after the write committed');
    return { a };
  };

  const { engine } = await newEngine(handler);
  const crashed = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(crashed.status, 'failed');
  assert.equal(sideEffects, 1);

  failAfterStep = false;
  const { engine: engine2 } = await newEngine(handler);
  const again = await engine2.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(again.status, 'completed');
  assert.equal(sideEffects, 1, 'the committed step must not run a second time');
  assert.deepEqual(again.output, { a: { value: 1 } });
});

test('the journal records the idempotency key required by F5.2', async () => {
  const fixture = await createCompany('idempotency');
  const task = await newTask(fixture);
  const { engine } = await newEngine(tenStepHandler(null));
  await engine.runTask(fixture.companyId, task.id, 'worker');

  const keys = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ idempotency_key: string; step_index: number }>(
      'SELECT idempotency_key, step_index FROM task_steps WHERE task_id = $1 ORDER BY step_index',
      [task.id],
    );
    return rows;
  });

  assert.equal(keys.length, STEP_COUNT);
  assert.equal(new Set(keys.map((k) => k.idempotency_key)).size, STEP_COUNT,
    'each step must carry a distinct key so a replay is attributable to one step');
  for (const key of keys) {
    assert.match(key.idempotency_key, /^[0-9a-f]{32}$/);
  }
});

/**
 * Replay is by position, and the position has to hold the same call.
 *
 * A committed step was handed back to whatever asked at its index, whatever
 * it asked for. A handler that took a different branch on its retry got
 * another call's answer -- a send step handed a model's reply, and the send
 * never happened -- and nothing said so.
 */
test('a retry that asks for a different step at a recorded position halts rather than replays', async () => {
  const fixture = await createCompany('journal-divergence');
  let run = 0;
  let sent = 0;
  const { engine } = await newEngine(async (ctx) => {
    run += 1;
    if (run === 1) {
      await ctx.step('lookup', 'internal', { q: 1 }, async () => ({ found: 'draft' }));
      throw new Error('worker killed');
    }
    // The retry branches differently: the same position, another step.
    await ctx.step('send', 'tool', { to: 'owner@example.test' }, async () => { sent += 1; return {}; });
    return {};
  });
  const task = await newTask(fixture);

  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'failed');
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'halted');
  assert.equal(outcome.reason, 'journal_divergence');
  assert.equal(sent, 0, 'neither sent nor handed the lookup\'s answer');
});

/**
 * F13.6's fallback starts the handler again on the next model. Its steps
 * are the same steps: the ones the first model finished replay, the rest
 * run. The step count used to carry on from where the failed run stopped, so
 * the fallback's first step was journalled at the failed run's next index,
 * and a later retry handed each step the output recorded for another.
 */
test('a model fallback replays what the first model finished and journals the rest in place', async () => {
  const fixture = await createCompany('fallback-journal');
  await withTenant(fixture.companyId, (tx) => tx.query(
    `UPDATE roles SET runtime = 'script', backend = 'local', tools = '{}', model_fallback = ARRAY['test-model-b'] WHERE id = $1`,
    [fixture.roleId],
  ));
  let looked = 0;
  const models: string[] = [];
  const { ProviderFailure } = await import('../../src/runtime/wire.ts');
  const adapter = {
    name: 'script',
    backends: ['local'] as const,
    async health() { return { ok: true }; },
    async run(
      request: { modelRouting: { primary: string } },
      services: { step: <T>(name: string, kind: 'internal', input: unknown, fn: () => Promise<T>) => Promise<T> },
    ) {
      models.push(request.modelRouting.primary);
      await services.step('look', 'internal', { q: 1 }, async () => { looked += 1; return 'seen'; });
      if (models.length === 1) throw new ProviderFailure(request.modelRouting.primary, 'provider returned 503');
      await services.step('answer', 'internal', {}, async () => 'done');
      return { output: { model: request.modelRouting.primary, done: reportOn(['the run returns an output matching its schema']) } };
    },
  };
  const { AdapterRegistry } = await import('../../src/runtime/protocol.ts');
  const adapters = new AdapterRegistry();
  adapters.register(adapter as never);
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    adapters,
  });
  const task = await newTask(fixture);

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(models, ['test-model', 'test-model-b']);
  assert.equal(looked, 1, 'the step the first model finished was replayed, not repeated');
  const journal = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ step_index: number; name: string }>(
      "SELECT step_index, name FROM task_steps WHERE task_id = $1 AND status = 'committed' ORDER BY step_index",
      [task.id],
    );
    return rows.map((row) => [row.step_index, row.name]);
  });
  assert.deepEqual(journal, [[0, 'look'], [1, 'answer']]);
});
