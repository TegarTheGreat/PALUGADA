/**
 * PRD v2 F13.2, F13.4, F13.6 -- the runtimes that are not this process.
 *
 * The in-process runtime is the easy case: it is trusted because it is us.
 * These tests are about the other kind. A spawned script and a webhook are
 * third parties, and the claims that matter are the ones about what they
 * cannot do -- reach a credential, act outside their grant, replay an action,
 * or quietly get their work done by a model nobody chose.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { AdapterRegistry, type RunEvent } from '../../src/runtime/protocol.ts';
import { parseRunEvent } from '../../src/runtime/wire.ts';
import { ScriptAdapter } from '../../src/runtime/script.ts';
import { HttpAdapter } from '../../src/runtime/http.ts';
import { ClaudeCodeAdapter } from '../../src/runtime/claude-code.ts';
import { ContainerAdapter } from '../../src/runtime/container.ts';
import { CliAdapter, runtimeSpecsFrom } from '../../src/runtime/cli.ts';
import { KNOWN_CLI_NAMES, knownCli, knownClis } from '../../src/runtime/known-clis.ts';
import {
  HttpSandboxProvider,
  RemoteSandboxAdapter,
  type SandboxProvider,
} from '../../src/runtime/sandbox-adapter.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, readFile, mkdtemp, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { DeploymentSecretManager, putSecret } from '../../src/settings/store.ts';
import { tmpdir } from 'node:os';
import { startToolBridge } from '../../src/runtime/tool-bridge.ts';
import { Engine, MODEL_OUTAGE_WAITS_MS } from '../../src/engine/engine.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { buildContext } from '../../src/context/builder.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { handed } from '../helpers/env.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const RUNTIME = new URL('../fixtures/runtimes/echo-runtime.mjs', import.meta.url).pathname;

/**
 * How a finished run reports on the fixture role's one done criterion, as a
 * run a model writes must (engine/done.ts). The echo runtime reads its
 * contract and writes `ECHOED`; the runtimes written in this file say it
 * outright.
 */
const CRITERION = 'the run returns an output matching its schema';
const DONE = [{ criterion: CRITERION, met: true, evidence: 'the runtime returned its output' }];
const ECHOED = [{ criterion: CRITERION, met: true, evidence: 'the echo runtime did what it was asked' }];

function scriptAdapter() {
  return new ScriptAdapter({ command: process.execPath, args: [RUNTIME] });
}

/** A tier 0 read the runtime is allowed, and a tier 2 write it is not. */
function capabilities() {
  const read: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async execute() {
      return { records: ['a.example.com'] };
    },
  };
  const write: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.write',
    adapter: 'test:dns',
    defaultTier: 2,
    async execute() {
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  return { read, write };
}

async function brokerFor(fixture: Fixture, grants: string[]) {
  const { read, write } = capabilities();
  const registry = new CapabilityRegistry();
  registry.register(read);
  registry.register(write);
  await registry.sync();
  for (const name of grants) await grantCapability(fixture, name);
  return new CapabilityBroker(registry);
}

async function configureRole(
  fixture: Fixture,
  options: { runtime: string; tools?: string[]; fallback?: string[] },
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `UPDATE roles
          SET runtime = $2,
              backend = 'local',
              tools = $3::text[],
              model_fallback = $4::text[]
        WHERE id = $1`,
      [fixture.roleId, options.runtime, options.tools ?? [], options.fallback ?? []],
    );
  });
}

let sequence = 0;
async function newTask(
  fixture: Fixture,
  input: Record<string, unknown>,
  options: { attemptMax?: number; deadlineAt?: Date } = {},
) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { ...input, run: sequence },
    createdBy: 'owner',
    reserveTokens: 20_000,
    ...(options.attemptMax === undefined ? {} : { attemptMax: options.attemptMax }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });
}

function engineWith(broker: CapabilityBroker, ...adapters: Parameters<AdapterRegistry['register']>) {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return new Engine({ broker, adapters: registry, workerId: 'oop-worker' });
}

async function eventTypes(companyId: string, taskId: string): Promise<string[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      'SELECT type FROM events WHERE task_id = $1 ORDER BY occurred_at',
      [taskId],
    );
    return rows.map((row) => row.type);
  });
}

/* -------------------------------------------------------------- script --- */

test('a spawned runtime runs a task and its output becomes the task output (F13.2)', async () => {
  const fixture = await createCompany('script-basic');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const task = await newTask(fixture, { script: 'done' });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(outcome.output, { ok: true, done: ECHOED });
});

/**
 * F13.4, the version that would actually happen.
 *
 * A child process inherits its parent's environment unless somebody stops it,
 * and this parent's environment holds `DATABASE_URL`. Nothing would fail if it
 * leaked -- the run would simply have been handed the keys -- which is why the
 * test asks the runtime what it can see rather than checking that the run
 * worked.
 */
test('a spawned runtime does not inherit the orchestrator environment (F13.4, F8.7)', async () => {
  // Planted rather than assumed: the connection string reaches this process
  // through `PALUGADA_ADMIN_URL` when it is set and through a default when it
  // is not, and a test that only passes on the second is not testing anything.
  process.env.PALUGADA_TEST_SENTINEL = 'a value the runtime must not see';
  process.env.PALUGADA_ADMIN_URL ??= 'postgres://palugada_admin:dev_admin@127.0.0.1:5432/palugada';

  try {
    const fixture = await createCompany('script-env');
    const broker = await brokerFor(fixture, []);
    await configureRole(fixture, { runtime: 'script' });
    const task = await newTask(fixture, { script: 'leak_env' });

    const outcome = await engineWith(broker, scriptAdapter()).runTask(
      fixture.companyId,
      task.id,
      'worker',
    );

    assert.equal(outcome.status, 'completed', outcome.reason);
    const seen = outcome.output as { sawAdminUrl: boolean; sawSentinel: boolean; keys: string[] };
    assert.equal(seen.sawAdminUrl, false, 'the runtime must not hold a database credential');
    assert.equal(seen.sawSentinel, false);
    // Allow-list rather than deny-list: a new secret in the parent environment
    // should fail this test on the day it is added, not on the day it leaks.
    assert.deepEqual(handed(seen.keys), ['PATH']);
  } finally {
    delete process.env.PALUGADA_TEST_SENTINEL;
  }
});

test("a runtime's tool call is resolved by the broker and answered (F13.4)", async () => {
  const fixture = await createCompany('script-tool');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'script', tools: ['dns.read'] });
  const task = await newTask(fixture, { script: 'call_tool' });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(outcome.output, {
    answer: {
      type: 'tool_result',
      id: 'call-1',
      output: { records: ['a.example.com'] },
    },
    done: ECHOED,
  });
  assert.ok((await eventTypes(fixture.companyId, task.id)).includes('tool.called'));
});

/**
 * A denial is an answer.
 *
 * The runtime asked for a capability its division does not hold. F2.4 requires
 * the refusal to produce no downstream call; this test also requires the
 * runtime to be *told*, because a runtime that receives a dead connection
 * instead of a reason will guess, and guessing is how a refused action gets
 * attempted a second way.
 */
test('a refused tool call comes back to the runtime as a refusal (F2.4)', async () => {
  const fixture = await createCompany('script-refused');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'script', tools: ['dns.read'] });
  const task = await newTask(fixture, { script: 'call_forbidden' });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  const answer = (outcome.output as { answer: Record<string, unknown> }).answer;
  assert.equal(answer.type, 'tool_error');
  assert.equal(answer.code, 'capability.not_granted');
});

test('a runtime that reports usage is charged for it (F13.7)', async () => {
  const fixture = await createCompany('script-usage');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const task = await newTask(fixture, { script: 'usage' });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );
  assert.equal(outcome.status, 'completed', outcome.reason);

  const traces = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ model: string; input_tokens: number; prompt: unknown }>(
      'SELECT model, input_tokens, prompt FROM llm_traces WHERE task_id = $1',
      [task.id],
    );
    return rows;
  });
  assert.equal(traces.length, 1);
  assert.equal(traces[0]!.input_tokens, 100);
  // F11.1 asks for the trace, not the transcript. A third-party runtime that
  // does not hand over its prompt still owes an accurate account of the cost,
  // and absent is recorded as absent rather than as empty.
  assert.equal(traces[0]!.prompt, null);
});

/**
 * Silence is not success.
 *
 * A runtime that dies mid-thought has produced nothing. Reading the end of its
 * stream as completion would mark a task complete on the strength of a crash.
 */
test('a runtime that stops without saying done has failed', async () => {
  const fixture = await createCompany('script-silent');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const task = await newTask(fixture, { script: 'silent' });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.notEqual(outcome.status, 'completed');
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.notEqual(stored!.status, 'completed');
});

test('a runtime that does not speak the protocol fails with what it did say', async () => {
  const fixture = await createCompany('script-garbage');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  // One attempt, so the outcome carries the failure rather than the word
  // `retryable`. What is under test is the message, and a retry would hide it.
  const task = await newTask(fixture, { script: 'unreadable' }, { attemptMax: 1 });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /unreadable output/);
});

/* ---------------------------------------------------------------- F13.6 --- */

/**
 * A provider that is down is a fact about the world, not about the work.
 *
 * The role's tools are all tier 0, so the engine may retry on the next model.
 * The substitution is recorded, because "which model did this" has to stay
 * answerable afterwards.
 */
test('a provider failure falls back to the next model for a tier 0-1 role (F13.6)', async () => {
  const fixture = await createCompany('fallback-allowed');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, {
    runtime: 'script',
    tools: ['dns.read'],
    fallback: ['test-model-b'],
  });

  // The fixture fails on the first model and succeeds on the second, so the
  // output names the model that actually did the work.
  const attempts: string[] = [];
  const adapter = {
    name: 'script',
    backends: ['local'] as const,
    async health() {
      return { ok: true };
    },
    async run(request: { modelRouting: { primary: string } }) {
      attempts.push(request.modelRouting.primary);
      if (attempts.length === 1) {
        const { ProviderFailure } = await import('../../src/runtime/wire.ts');
        throw new ProviderFailure(request.modelRouting.primary, 'provider returned 503');
      }
      return { output: { model: request.modelRouting.primary, done: DONE } };
    },
  };

  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(attempts, ['test-model', 'test-model-b']);
  assert.deepEqual(outcome.output, { model: 'test-model-b', done: DONE });
  assert.ok((await eventTypes(fixture.companyId, task.id)).includes('model.fell_back'));
});

/**
 * A runtime's final total is the bill for its own run.
 *
 * Counted across fallback attempts, the second model's total replaced what
 * the first model's calls had been charged as well as its own -- and the
 * first model's calls, which the provider billed before it failed, came off
 * the ledger.
 */
test('a fallback run\'s own total settles its own run, not the one that failed (F13.6, F13.7)', async () => {
  const fixture = await createCompany('fallback-total');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'script', tools: ['dns.read'], fallback: ['test-model-b'] });

  let attempt = 0;
  const { ProviderFailure } = await import('../../src/runtime/wire.ts');
  const adapter = {
    name: 'script',
    backends: ['local'] as const,
    async health() {
      return { ok: true };
    },
    async run(
      request: { modelRouting: { primary: string } },
      services: { reportUsage: (usage: Record<string, unknown>) => Promise<void> },
    ) {
      attempt += 1;
      const model = request.modelRouting.primary;
      if (attempt === 1) {
        await services.reportUsage({ model, inputTokens: 10, outputTokens: 10, costCents: 5 });
        throw new ProviderFailure(model, 'provider returned 503');
      }
      await services.reportUsage({ model, inputTokens: 10, outputTokens: 10, costCents: 3 });
      await services.reportUsage({ model, inputTokens: 0, outputTokens: 0, costCents: 10, runTotal: true });
      return { output: { done: DONE } };
    },
  };

  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter as never).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal(await spentBy(fixture), 15, 'the failed run\'s 5, and the fallback\'s bill of 10');
});

/**
 * A model that did not answer halted every task in flight -- a provider's
 * blip, a local model restarting -- with an incident apiece for the owner to
 * resume by hand, though a minute later the same call was answered (a chaos
 * run on 2026-09-29, with the model's port closed for a moment). The task
 * now waits and tries the same model again, longer each time, spending no
 * attempt; only a model that stays down halts it.
 */
test('a model that is down for a moment parks the task, and the same model finishes it (F13.6)', async () => {
  const fixture = await createCompany('model-outage-wait');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'script', tools: ['dns.read'] });
  const { ProviderFailure } = await import('../../src/runtime/wire.ts');
  const attempts: string[] = [];
  const adapter = {
    name: 'script',
    backends: ['local'] as const,
    async health() {
      return { ok: true };
    },
    async run(request: { modelRouting: { primary: string } }) {
      attempts.push(request.modelRouting.primary);
      if (attempts.length <= 2) {
        throw new ProviderFailure(request.modelRouting.primary, 'the model API could not be reached 3 times: fetch failed (ECONNREFUSED)');
      }
      return { output: { done: DONE } };
    },
  };
  const engine = engineWith(broker, adapter);
  const task = await newTask(fixture, {});

  const before = Date.now();
  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.status, 'waiting_window', first.reason);
  assert.equal(first.reason, 'model.unavailable');
  const wait = first.waitUntil!.getTime() - before;
  assert.ok(Math.abs(wait - MODEL_OUTAGE_WAITS_MS[0]!) < 2_000, `waited ${wait}ms`);
  const second = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(second.status, 'waiting_window', second.reason);
  assert.ok(second.waitUntil!.getTime() - Date.now() > MODEL_OUTAGE_WAITS_MS[0]!, 'longer the second time');

  const third = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(third.status, 'completed', third.reason);
  assert.deepEqual(attempts, ['test-model', 'test-model', 'test-model']);
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.attempt, 0, 'waiting for the model is not failing');
  const incidents = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM inbox_items WHERE task_id = $1 AND kind = 'incident'", [task.id]));
  assert.equal(incidents.rows.length, 0, 'nothing for the owner to do about a moment');
  assert.equal((await eventTypes(fixture.companyId, task.id)).filter((type) => type === 'task.model_waited').length, 2);
});

/**
 * A role that can act irreversibly does not get a silent substitution.
 *
 * Tier 2 is where an action changes something outside the company and cannot
 * be undone. Running one on a model the owner did not choose, and did not
 * calibrate the role for, is exactly what the PRD's word *silently* forbids.
 * It waits for its own model, as every role does; one that stays down halts
 * it, and the owner is told once.
 */
test('a role holding a tier 2 tool waits for its own model and never falls back; one that stays down halts it (F13.6)', async () => {
  const fixture = await createCompany('fallback-refused');
  const broker = await brokerFor(fixture, ['dns.write']);
  await configureRole(fixture, {
    runtime: 'script',
    tools: ['dns.write'],
    fallback: ['test-model-b'],
  });

  const attempts: string[] = [];
  const adapter = {
    name: 'script',
    backends: ['local'] as const,
    async health() {
      return { ok: true };
    },
    async run(request: { modelRouting: { primary: string } }) {
      attempts.push(request.modelRouting.primary);
      const { ProviderFailure } = await import('../../src/runtime/wire.ts');
      throw new ProviderFailure(request.modelRouting.primary, 'provider returned 503');
    },
  };

  const task = await newTask(fixture, {});
  const engine = engineWith(broker, adapter);
  const outcomes: string[] = [];
  for (let run = 0; run <= MODEL_OUTAGE_WAITS_MS.length; run += 1) {
    outcomes.push((await engine.runTask(fixture.companyId, task.id, 'worker')).status);
  }

  assert.deepEqual(outcomes, [...MODEL_OUTAGE_WAITS_MS.map(() => 'waiting_window'), 'halted']);
  assert.deepEqual(attempts, Array(MODEL_OUTAGE_WAITS_MS.length + 1).fill('test-model'), 'the fallback model was never tried');

  const types = await eventTypes(fixture.companyId, task.id);
  assert.ok(types.includes('model.fallback_refused'));
  assert.equal(types.includes('model.fell_back'), false);

  // F13.6 asks for an incident, not a statistic.
  const incidents = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ title: string }>(
      "SELECT title FROM inbox_items WHERE task_id = $1 AND kind = 'incident'",
      [task.id],
    );
    return rows;
  });
  assert.equal(incidents.length, 1, 'told once, when the waiting was over');
  assert.match(incidents[0]!.title, /was not moved/);
  const detail = await withTenant(fixture.companyId, (tx) => tx.query<{ rationale: string }>(
    "SELECT rationale FROM inbox_items WHERE task_id = $1 AND kind = 'incident'", [task.id]));
  assert.match(detail.rows[0]!.rationale, /tried 6 times over about 16 minutes\. This role can take actions that cannot be undone/);
});

/* ------------------------------------------------------------------ http --- */

test('the http runtime finishes a turn loop and answers tool calls (F13.2)', async () => {
  const fixture = await createCompany('http-basic');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'http', tools: ['dns.read'] });

  const turns: Array<{ answers: unknown[] }> = [];
  const adapter = new HttpAdapter({
    url: 'https://runtime.invalid/run',
    fetch: (async (_url: string, init: { method?: string; body?: string }) => {
      // F13.8 asks before it hands over work, so the stub has to answer that
      // too. A stub that only knows how to run is a stub that never gets asked.
      if ((init.method ?? 'GET') === 'GET') return new Response('{}', { status: 200 });
      const body = JSON.parse(init.body!) as { turn: number; answers: unknown[] };
      turns.push({ answers: body.answers });
      const events: RunEvent[] =
        body.turn === 0
          ? [{ type: 'tool_call', id: 'a', name: 'dns.read', args: { zone: 'example.com' } }]
          : [{ type: 'done', output: { turns: turns.length, done: DONE } }];
      return new Response(JSON.stringify({ events }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
  });

  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(outcome.output, { turns: 2, done: DONE });
  // The second turn carries the answer the engine owed, and only that answer.
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]!.answers, []);
  assert.equal((turns[1]!.answers[0] as { type: string }).type, 'tool_result');
});

/**
 * An at-least-once transport must not become an at-least-once action.
 *
 * A retried HTTP turn that repeats a `tool_call` id is the ordinary way one
 * external send becomes several. The transport refuses it rather than trusting
 * the runtime to be careful.
 */
test('the http runtime may not replay a tool call id (F8.6)', async () => {
  const fixture = await createCompany('http-replay');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'http', tools: ['dns.read'] });

  let turns = 0;
  const adapter = new HttpAdapter({
    url: 'https://runtime.invalid/run',
    fetch: (async (_url: string, init: { method?: string }) => {
      if ((init.method ?? 'GET') === 'GET') return new Response('{}', { status: 200 });
      turns += 1;
      const events: RunEvent[] = [
        { type: 'tool_call', id: 'same', name: 'dns.read', args: { zone: 'example.com' } },
      ];
      return new Response(JSON.stringify({ events }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
  });

  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.notEqual(outcome.status, 'completed');
  assert.equal(turns, 2, 'the second turn is where the replay is noticed');
});

test('an unreachable http runtime fails its health check (F13.8)', async () => {
  const adapter = new HttpAdapter({
    url: 'https://runtime.invalid/run',
    fetch: (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof globalThis.fetch,
  });

  const health = await adapter.health();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? '', /unreachable/);
});

/* ----------------------------------------------------------- tool bridge --- */

/**
 * The bridge is the MCP-shaped face of the same rule (F13.4).
 *
 * Claude Code asks for a tool by calling a server, so the server it is given is
 * one this process runs, whose every tool is a name over the broker. These
 * tests drive it as a client would.
 */
test('the tool bridge exposes only the role\'s tools and routes them to the broker', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const bridge = await startToolBridge(
    [{ name: 'dns.read', inputSchema: { type: 'object' }, tier: 0 }],
    {
      async callTool(name: string, input: unknown) {
        calls.push({ name, input });
        return { records: ['a'] } as never;
      },
    } as never,
  );

  try {
    // Under a name the model's provider accepts: a dot is refused before the
    // model ever sees the tool.
    const list = await rpc(bridge, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (list as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['dns__read']);
    assert.match(tools[0]!.description, /PALUGADA capability dns\.read, tier 0/);

    const ok = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dns__read', arguments: { zone: 'example.com' } },
    });
    const answered = (ok as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    assert.equal(answered.isError, false);
    assert.deepEqual(calls, [{ name: 'dns.read', input: { zone: 'example.com' } }]);
    // What the capability returned reaches the CLI's model as data (F8.9).
    assert.match(answered.content[0]!.text, /UNTRUSTED_CONTENT[\s\S]*"records":\["a"\]/);

    // A runtime that reads the wire request calls it by its own name.
    await rpc(bridge, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dns.read', arguments: { zone: 'example.org' } },
    });
    assert.equal(calls.length, 2);

    // A tool outside the role's list is refused here, before the broker is
    // troubled with it -- and refused as an answer the runtime can read.
    const refused = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'dns.write', arguments: {} },
    });
    assert.equal((refused as { result: { isError: boolean } }).result.isError, true);
    assert.equal(calls.length, 2);

    // A client on a newer revision is answered in it.
    const hello = await rpc(bridge, {
      jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    });
    assert.equal((hello as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
  } finally {
    await bridge.close();
  }
});

test('the tool bridge refuses a caller without its token', async () => {
  const bridge = await startToolBridge([], { async callTool() {} } as never);
  try {
    const response = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);

    const wrong = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(wrong.status, 401);
  } finally {
    await bridge.close();
  }
});

async function rpc(bridge: { url: string; token: string }, message: unknown): Promise<unknown> {
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(message),
  });
  assert.equal(response.status, 200);
  return response.json();
}

/* ------------------------------------------------------------- container --- */

/**
 * F12.9's one real guarantee: `--network none`.
 *
 * `sandbox.ts` records that Node's permission model covers the filesystem,
 * child processes, workers and native addons and *not* sockets, and that real
 * network isolation needs a container below the process. This is that
 * container, and the flag is the whole reason the backend exists — so it is
 * asserted directly rather than inferred from a run that happened to work.
 */
test('the docker backend starts a container with no network at all (F12.9, F13.5)', () => {
  const adapter = new ContainerAdapter({ image: 'palugada/runtime@sha256:abc' });
  const argv = adapter.argv();

  assert.equal(argv[argv.indexOf('--network') + 1], 'none');
  assert.ok(argv.includes('--read-only'));
  assert.ok(argv.includes('--rm'));
  assert.equal(argv[argv.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(argv[argv.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.equal(argv[argv.indexOf('--user') + 1], '65534:65534', 'nothing inside runs as root');
  assert.equal(argv.at(-1), 'palugada/runtime@sha256:abc');

  // It claims only `docker`. Claiming `local` too would make a role's
  // isolation setting a value that sometimes means nothing.
  assert.deepEqual([...adapter.backends], ['docker']);
});

/**
 * The health check asks the daemon, not the CLI.
 *
 * `docker --version` answers from the binary alone and would report healthy on
 * a machine with no daemon, which is exactly the failure F13.8 exists to catch
 * before a task is handed over. The two fakes are the whole test: one exits 0
 * and prints nothing — a client with no server — and must be unhealthy; one
 * prints a version and must be healthy.
 *
 * Written against fakes rather than against whatever docker this machine has,
 * because "there is no daemon here" is a fact about a machine and not a
 * property of the code. A test that asserted it would pass in this container
 * and fail on any CI runner that ships one.
 */
test('the docker backend asks the daemon, not the CLI (F13.8)', async () => {
  const noServer = new ContainerAdapter({
    image: 'palugada/runtime:1',
    docker: new URL('../fixtures/runtimes/fake-docker-no-server.sh', import.meta.url).pathname,
  });
  const refused = await noServer.health();
  assert.equal(refused.ok, false, 'exit code 0 with no server version is not healthy');
  assert.ok((refused.detail ?? '').length > 0, 'a refusal has to say why');

  const reachable = new ContainerAdapter({
    image: 'palugada/runtime:1',
    docker: new URL('../fixtures/runtimes/fake-docker-healthy.sh', import.meta.url).pathname,
  });
  const healthy = await reachable.health();
  assert.equal(healthy.ok, true);
  assert.match(healthy.detail ?? '', /27\.0\.1/);
});

/**
 * Ending the docker client does not end its container. A runtime that ignores
 * SIGTERM -- and a process that is PID 1 in a container ignores it unless it
 * says otherwise -- outlives the client the tree keeper kills, holding its
 * memory and CPU until it chooses to stop, with `--rm` waiting on that too.
 * So each run's container has a name, the runtime is not PID 1, and the name
 * is removed whenever the run ends, however it ended.
 */
test('a run\'s container is named, not PID 1, and removed when the run ends (F13.5)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'palugada-docker-'));
  const log = join(dir, 'docker.log');
  const docker = join(dir, 'docker');
  // A docker client that keeps a log of what it was asked and plays the
  // container with the echo runtime.
  writeFileSync(docker, [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    'if [ "$1" = version ]; then echo 27.0.1; exit 0; fi',
    `if [ "$1" = run ]; then exec '${process.execPath}' '${RUNTIME}'; fi`,
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  const fixture = await createCompany('docker-remove');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'docker' });
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET backend = 'docker' WHERE id = $1", [fixture.roleId]));
  const adapter = new ContainerAdapter({ image: 'palugada/runtime:1', docker });

  for (const script of ['done', 'unreadable']) {
    writeFileSync(log, '');
    const task = await newTask(fixture, { script }, { attemptMax: 1 });
    const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, script === 'done' ? 'completed' : 'failed', outcome.reason);

    const calls = (await readFile(log, 'utf8')).trim().split('\n').filter((line) => !line.startsWith('version'));
    const run = calls.find((line) => line.startsWith('run '));
    const name = /--name (\S+)/.exec(run ?? '')?.[1];
    assert.ok(name?.startsWith('palugada-run-'), `the container has a name: ${run}`);
    assert.ok(run!.split(' ').includes('--init'), 'the runtime is not PID 1');
    assert.equal(calls.at(-1), `rm --force ${name}`, `${script}: removed by its name after the run`);
  }
});

/**
 * A worker killed outright -- SIGKILL, the out-of-memory killer, a host that
 * lost its power supply to the database but not to docker -- never reaches
 * the `finally` that removes its run's container, and the runtime inside
 * keeps its memory and its CPU. Each container carries the worker that
 * started it, so any live worker can tell a leftover from a run in flight.
 */
test('a container a dead worker left running is removed, and one of a live worker is not (F13.5)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'palugada-docker-'));
  const log = join(dir, 'docker.log');
  const docker = join(dir, 'docker');
  writeFileSync(docker, [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    'if [ "$1" = ps ]; then',
    "  printf 'palugada-run-a\\tworker-dead\\npalugada-run-b\\tworker-alive\\npalugada-run-c\\tworker-me\\n'",
    'fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  const adapter = new ContainerAdapter({ image: 'palugada/runtime:1', docker, worker: 'worker-me' });
  const argv = adapter.argv('palugada-run-x');
  assert.equal(argv[argv.indexOf('--label') + 1], 'palugada.worker=worker-me', 'each container says whose run it is');

  const registry = new AdapterRegistry();
  registry.register(adapter);
  const removed = await registry.sweep(new Set(['worker-alive']));
  assert.deepEqual(removed, ['palugada-run-a']);
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.ok(calls.some((line) => line.startsWith('ps --all --filter label=palugada.worker')), calls.join('\n'));
  assert.deepEqual(calls.filter((line) => line.startsWith('rm ')), ['rm --force palugada-run-a'],
    'a live worker\'s run and this worker\'s own are left alone');

  // A docker that is not there is nothing to sweep, not an error.
  const absent = new ContainerAdapter({ image: 'palugada/runtime:1', docker: '/nonexistent/docker', worker: 'worker-me' });
  assert.deepEqual(await absent.sweep(new Set()), []);
});

test('a missing docker binary is unhealthy rather than an exception (F13.8)', async () => {
  const adapter = new ContainerAdapter({
    image: 'palugada/runtime:1',
    docker: '/nonexistent/docker',
  });
  const health = await adapter.health();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? '', /not runnable/);
});

/* ----------------------------------------------------------- claude-code --- */

/**
 * The CLI is given none of its own tools.
 *
 * This is the whole of F13.4 for this adapter: a runtime that could write a
 * file or open a socket directly would be acting outside the broker, and every
 * guarantee downstream of the broker would be a guarantee about some of the
 * actions rather than all of them.
 */
test('the claude-code runtime disallows the CLI\'s own tools and points it at the bridge', () => {
  const adapter = new ClaudeCodeAdapter();
  const argv = adapter.argv(
    {
      runId: 'r1',
      roleSlug: 'worker',
      modelRouting: { primary: 'claude-x', fallback: [] },
      allowedTools: [{ name: 'dns.read', inputSchema: {}, tier: 0 }],
    } as never,
    '/run/palugada-claude-x/mcp.json',
  );

  const disallowed = argv[argv.indexOf('--disallowedTools') + 1]!.split(',');
  for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(disallowed.includes(tool), `${tool} must be disallowed`);
  }

  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'mcp__palugada__dns__read',
    'the name the bridge shows, which is one the provider accepts');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-x');

  // The bridge's token travels in a private file, never on the command line,
  // and only the bridge's server is loaded.
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], '/run/palugada-claude-x/mcp.json');
  assert.ok(argv.includes('--strict-mcp-config'), 'the operator\'s own MCP servers are not the role\'s tools');
  assert.ok(!argv.some((arg) => /Bearer/.test(arg)));

  // Checked against Claude Code 2.1.283: the disallowed list alone left the
  // model seventeen built-in tools, and without `--setting-sources` a hook in
  // the operator's own settings ran a shell command on every run and their
  // own CLAUDE.md was read into every prompt.
  assert.equal(argv[argv.indexOf('--tools') + 1], '', 'no built-in tool at all');
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], '', 'none of the operator\'s settings, hooks or memory');
  assert.ok(argv.includes('--no-session-persistence'));
});

/**
 * A Claude subscription signed in from the console: the token is sealed, and
 * each run is handed it and a home of its own -- so the operator's login,
 * settings and memory are no longer where the run's login comes from.
 */
test('claude-code is handed a token saved in the console, and a home of its own instead of the operator\'s', async () => {
  const master = { id: 'test-master', key: randomBytes(32), source: 'test' };
  await putSecret('agent-claude-code', 'sk-ant-oat01-saved-in-the-console', master);
  const bin = await mkdtemp(join(tmpdir(), 'palugada-fake-claude-'));
  const seen = join(bin, 'seen.json');
  const fake = join(bin, 'claude');
  writeFileSync(fake, [
    `#!${process.execPath}`,
    // The version whose flags were checked, as the real one says it.
    "if (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code)'); process.exit(0); }",
    "const { createHash } = require('node:crypto');",
    "const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';",
    `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({`,
    '  env: Object.keys(process.env).sort(), home: process.env.HOME,',
    "  sha: createHash('sha256').update(token).digest('hex'),",
    '}));',
    "process.stdin.resume(); process.stdin.on('end', () => {",
    `  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: { ok: true, done: ${JSON.stringify(DONE)} }, usage: { input_tokens: 1, output_tokens: 1 } }));`,
    '});',
  ].join('\n'), { mode: 0o755 });

  const fixture = await createCompany('claude-token');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'claude-code' });
  const task = await newTask(fixture, { ask: 'anything' });
  const outcome = await engineWith(broker, new ClaudeCodeAdapter({
    command: fake,
    secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'db://agent-claude-code' },
    secrets: new DeploymentSecretManager(new InMemorySecretManager(), () => master),
  })).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  const record = JSON.parse(readFileSync(seen, 'utf8')) as { env: string[]; home: string; sha: string };
  assert.deepEqual(handed(record.env), ['CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'HOME', 'PATH']);
  assert.equal(record.sha, createHash('sha256').update('sk-ant-oat01-saved-in-the-console').digest('hex'));
  assert.notEqual(record.home, process.env.HOME);
  assert.match(record.home, /palugada-claude-/, 'the run\'s own directory, removed when it ends');
});

/* ------------------------------------------------- versions checked --- */

/**
 * What keeps an agent CLI to the bridge is its own flags: `--tools ''`,
 * `shell_tool = false`, a core tool list. Each was checked against one
 * version of each CLI, and a later version may read them differently -- the
 * Claude Code release that grew seventeen tools the old list did not name is
 * why the list became empty. OtoDock pins and freezes the CLIs it runs for
 * the same reason. A version nobody checked gets no work until the owner
 * installs the checked one or accepts it.
 */
test('an agent CLI at a version its containment was not checked on gets no work until the owner accepts it', async () => {
  const printing = (line: string) => ['-e', `console.log(${JSON.stringify(line)})`];
  const codex = (line: string, extra: Record<string, unknown> = {}) => new CliAdapter(knownCli('codex', {
    command: process.execPath, versionArgs: printing(line), ...extra,
  }));
  assert.equal(knownCli('codex').checkedVersion, '0.157.1');
  assert.equal((await codex('codex-cli 0.157.1').health()).ok, true);

  const newer = await codex('codex-cli 0.170.0').health();
  assert.equal(newer.ok, false);
  assert.match(newer.detail ?? '',
    /0\.170\.0 is not 0\.157\.1, the version whose containment PALUGADA checked; install 0\.157\.1 from Agent CLIs, or accept 0\.170\.0 there/);
  assert.equal((await codex('codex-cli 0.170.0', { acceptedVersion: '0.170.0' }).health()).ok, true,
    'the owner accepted this one');
  assert.equal((await codex('codex-cli 0.171.0', { acceptedVersion: '0.170.0' }).health()).ok, false,
    'and only that one');

  // A CLI described by the operator names no checked version, and is not held to one.
  const { checkedVersion: _checked, ...written } = knownCli('codex');
  assert.equal((await new CliAdapter({ ...written, name: 'my-cli',
    command: process.execPath, versionArgs: printing('9.9.9') }).health()).ok, true);

  // Claude Code the same way, through its own adapter.
  const dir = await mkdtemp(join(tmpdir(), 'palugada-version-'));
  const claude = (version: string) => {
    const path = join(dir, `claude-${version}`);
    writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
    return path;
  };
  assert.equal((await new ClaudeCodeAdapter({ command: claude('2.1.283') }).health()).ok, true);
  const drifted = await new ClaudeCodeAdapter({ command: claude('2.1.285') }).health();
  assert.equal(drifted.ok, false);
  assert.match(drifted.detail ?? '', /2\.1\.285 is not 2\.1\.283/);
  assert.equal((await new ClaudeCodeAdapter({ command: claude('2.1.285'), acceptedVersion: '2.1.285' }).health()).ok, true);
});

test('no agent CLI updates itself under a run, and each is checked at the version the console installs', async () => {
  const { AGENT_CATALOGUE } = await import('../../src/settings/agents.ts');
  for (const entry of AGENT_CATALOGUE) {
    if (entry.install.kind !== 'npm') continue;
    const checked = entry.name === 'claude-code'
      ? new ClaudeCodeAdapter({}).checkedVersion
      : knownCli(entry.name as Parameters<typeof knownCli>[0]).checkedVersion;
    assert.equal(checked, entry.install.tested, `${entry.name}: the console installs the version that was checked`);
  }
  // A CLI that replaces itself between runs is running a version nobody
  // checked, so each is told not to: checked against the binaries.
  assert.match(knownCli('codex').files!['.codex/config.toml']!, /^check_for_update_on_startup = false$/m);
  const gemini = JSON.parse(knownCli('gemini-cli').files!['.gemini/settings.json']!.replace(/\{maxTurns\}/, '1')) as {
    general?: { enableAutoUpdate?: boolean; enableAutoUpdateNotification?: boolean };
  };
  assert.deepEqual(gemini.general, { enableAutoUpdate: false, enableAutoUpdateNotification: false });
  assert.equal(knownCli('opencode').env!.OPENCODE_DISABLE_AUTOUPDATE, '1');
});

/* ---------------------------------------------------------------- cli --- */

const AGENT_CLI = new URL('../fixtures/runtimes/fake-agent-cli.mjs', import.meta.url).pathname;
// The stand-in runs as `node`, so `--version` answers with Node's version,
// which is accepted as a deployment would accept one (`checked-versions.ts`).

/**
 * A spec that would leave the runtime with no tools is refused.
 *
 * The whole point of `CliAdapter` is that employing a new agent CLI is a
 * configuration entry, and a configuration entry that forgets the tool bridge
 * fails in the worst way there is: the CLI starts, talks to a model, has no
 * tools at all, and answers confidently about work it could not do. Nothing
 * throws and nothing is logged. Refused at construction, where the
 * configuration can still be fixed.
 */
test('a runtime spec that never places the tool bridge is refused (F13.3, F13.4)', () => {
  assert.throws(
    () => new CliAdapter({ name: 'forgetful', command: 'agent', args: ['-p', '{prompt}'] }),
    /places no tool bridge/,
  );

  // Any of the three ways of naming it counts: a CLI may want the whole client
  // configuration, a file holding it, or just the URL.
  for (const arg of ['{mcpConfig}', '{mcpConfigFile}', '{mcpUrl}']) {
    assert.doesNotThrow(
      () => new CliAdapter({ name: 'fine', command: 'agent', args: ['--mcp', arg] }),
    );
  }
});

/**
 * The end of F13.3 that matters: a CLI nobody wrote an adapter for does a task.
 *
 * `hermes`, `openclaw`, `codex` and `gemini-cli` are not installed here and
 * their flags are not guessed anywhere in this repository. What is claimed
 * instead is that any of them is a `CliRuntimeSpec`, and this test is that
 * claim being exercised: a command, an argument list, and a runtime that runs
 * a real task, calls a real capability through the broker, and is charged for
 * what it used -- with no code written for it.
 */
test('an agent CLI is employed from a configuration entry alone (F13.3)', async () => {
  const fixture = await createCompany('cli-configured');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'codex', tools: ['dns.read'] });
  const task = await newTask(fixture, { ask: 'read the zone' });

  // Exactly what an operator who had the binary would write, and nothing else.
  const [spec] = runtimeSpecsFrom([
    {
      name: 'codex',
      command: process.execPath,
      // The tool as the bridge shows it, and the list the CLI is held to.
      args: [AGENT_CLI, '--model', '{model}', '--mcp-config', '{mcpConfig}', '--allowed', '{allowedTools}', '--call', 'dns__read'],
    },
  ]);

  const outcome = await engineWith(broker, new CliAdapter(spec!)).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  const output = outcome.output as { tool: { isError: boolean; text: string }; model: string };
  assert.equal(output.tool.isError, false, `the capability was resolved by the broker: ${output.tool.text}`);
  // The answer, inside the envelope that says it is data (F8.9).
  const text = String(output.tool.text);
  assert.match(text, /^<<<UNTRUSTED_CONTENT>>> source="tool dns\.read"/);
  assert.deepEqual(JSON.parse(text.split('\n').at(-2)!), { records: ['a.example.com'] });
  // The role's model reached the command line through the placeholder.
  assert.equal(output.model, 'test-model');

  // F13.7: the stream reported usage and the engine charged it.
  assert.ok((await eventTypes(fixture.companyId, task.id)).includes('tool.cost'));
});

/**
 * The same, through a file.
 *
 * Several agent CLIs take a path to an MCP configuration rather than the JSON
 * itself, and that path carries the run's bearer token. The file is written
 * 0600 inside a 0700 directory and removed when the run ends -- a token left
 * on disk outlives the run it was minted for, which is the one property a
 * per-run token exists to have.
 */
test('an agent CLI given its MCP config as a file leaves no token behind (F13.3, F12.1)', async () => {
  const fixture = await createCompany('cli-config-file');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'gemini-cli', tools: ['dns.read'] });
  const task = await newTask(fixture, { ask: 'read the zone' });

  const before = await readdir(tmpdir());

  const outcome = await engineWith(
    broker,
    new CliAdapter({
      name: 'gemini-cli',
      command: process.execPath,
      args: [AGENT_CLI, '--mcp-config-file', '{mcpConfigFile}', '--call', 'dns.read'],
    }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal((outcome.output as { tool: { isError: boolean } }).tool.isError, false);

  const after = await readdir(tmpdir());
  const left = after.filter(
    (name) => name.startsWith('palugada-mcp-') && !before.includes(name),
  );
  assert.deepEqual(left, [], 'the configuration file holding the run token was removed');
});

/**
 * F13.4 and F8.7 for this adapter, asked the way it would actually fail.
 *
 * A child inherits its parent's environment unless somebody stops it, and this
 * parent's environment holds `DATABASE_URL`. Nothing would break if it leaked;
 * the run would simply have been handed the platform's keys. So the runtime is
 * asked what it can see rather than whether it worked.
 */
test('an agent CLI does not inherit the orchestrator environment (F13.3, F13.4)', async () => {
  process.env.PALUGADA_TEST_SENTINEL = 'a value the runtime must not see';

  try {
    const fixture = await createCompany('cli-env');
    const broker = await brokerFor(fixture, []);
    await configureRole(fixture, { runtime: 'hermes' });
    const task = await newTask(fixture, { ask: 'what can you see' });

    const outcome = await engineWith(
      broker,
      new CliAdapter({
        name: 'hermes',
        command: process.execPath,
        args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--dump-env'],
        env: { HERMES_HOME: '/var/lib/hermes' },
      }),
    ).runTask(fixture.companyId, task.id, 'worker');

    assert.equal(outcome.status, 'completed', outcome.reason);
    // Allow-list rather than deny-list: a new secret in the parent environment
    // should fail this test on the day it is added, not on the day it leaks.
    assert.deepEqual(handed((outcome.output as { env: string[] }).env), ['HERMES_HOME', 'PATH']);
  } finally {
    delete process.env.PALUGADA_TEST_SENTINEL;
  }
});

/**
 * The CLI's own key, from a secret the owner saved in the console.
 *
 * `apiKeyEnvVar` passes a variable of this process's environment, which only
 * an operator with a shell can set. A key typed in the console is sealed in
 * the database instead, and a run is handed it under the name the CLI reads
 * -- and only that run, and only that one variable.
 */
test('an agent CLI is handed its own key from a secret saved in the console, and nothing else', async () => {
  const master = { id: 'test-master', key: randomBytes(32), source: 'test' };
  await putSecret('agent-hermes', 'sk-or-saved-in-the-console', master);
  process.env.OPENROUTER_API_KEY = 'a key of this process the run must not get';
  try {
    const fixture = await createCompany('cli-secret');
    const broker = await brokerFor(fixture, []);
    await configureRole(fixture, { runtime: 'hermes' });
    const task = await newTask(fixture, { ask: 'which key' });
    const outcome = await engineWith(
      broker,
      new CliAdapter({
        name: 'hermes',
        command: process.execPath,
        args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--dump-env', '--env-sha', 'OPENROUTER_API_KEY'],
        secretEnv: { OPENROUTER_API_KEY: 'db://agent-hermes' },
      }, { secrets: new DeploymentSecretManager(new InMemorySecretManager(), () => master) }),
    ).runTask(fixture.companyId, task.id, 'worker');

    assert.equal(outcome.status, 'completed', outcome.reason);
    const output = outcome.output as { env: string[]; envSha: string };
    assert.deepEqual(handed(output.env), ['OPENROUTER_API_KEY', 'PATH']);
    assert.equal(output.envSha, createHash('sha256').update('sk-or-saved-in-the-console').digest('hex'));
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('an agent CLI whose saved key cannot be opened halts the task and says where to set it', async () => {
  const fixture = await createCompany('cli-secret-missing');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'codex' });
  const task = await newTask(fixture, { ask: 'anything' });
  const master = { id: 'test-master', key: randomBytes(32), source: 'test' };
  const outcome = await engineWith(
    broker,
    new CliAdapter({
      name: 'codex',
      command: process.execPath,
      args: [AGENT_CLI, '--mcp-config', '{mcpConfig}'],
      secretEnv: { CODEX_API_KEY: 'db://agent-codex' },
    }, { secrets: new DeploymentSecretManager(new InMemorySecretManager(), () => master) }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'halted');
  assert.equal(outcome.reason, 'runtime_unavailable');
  const events = await eventTypes(fixture.companyId, task.id);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { message?: string } }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'task.halted'", [task.id]));
  assert.ok(events.includes('task.halted'), events.join(', '));
  assert.match(JSON.stringify(rows[0]?.payload), /codex has no CODEX_API_KEY: .*nothing is stored.*This deployment, Agents/);
});

/**
 * The other dialect: a CLI that prints its answer and exits.
 *
 * Not every agent CLI emits a structured stream, and one that does not is
 * still employable -- the exit code is the verdict and stdout is the answer.
 */
test('an agent CLI that only prints its answer is still employable (F13.3)', async () => {
  const fixture = await createCompany('cli-text');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'openclaw', tools: ['dns.read'] });
  const task = await newTask(fixture, { ask: 'read the zone' });

  const outcome = await engineWith(
    broker,
    new CliAdapter({
      name: 'openclaw',
      command: process.execPath,
      args: [AGENT_CLI, '--dialect', 'text', '--mcp-config', '{mcpConfig}', '--call', 'dns.read'],
      dialect: 'text',
    }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal((outcome.output as { tool: { isError: boolean } }).tool.isError, false);
});

/**
 * A CLI that fails is a failure, not a provider failure.
 *
 * F13.6 lets the engine silently move a run to a fallback model when the
 * provider failed. A non-zero exit says the process died and nothing about
 * why, so reading it as a provider failure would turn every crash into a
 * second billed run on a different model.
 */
test('an agent CLI that exits non-zero fails with what it said (F13.3, F13.6)', async () => {
  const fixture = await createCompany('cli-failure');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'codex', fallback: ['fallback-model'] });
  const task = await newTask(fixture, { ask: 'fail' }, { attemptMax: 1 });

  const outcome = await engineWith(
    broker,
    new CliAdapter({
      name: 'codex',
      command: process.execPath,
      args: [AGENT_CLI, '--dialect', 'text', '--mcp-config', '{mcpConfig}', '--exit', '3'],
      dialect: 'text',
    }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /exited 3/);
  assert.match(outcome.reason ?? '', /told to fail/, 'what it wrote to stderr travels with it');
  // No silent second run on the fallback model.
  assert.ok(!(await eventTypes(fixture.companyId, task.id)).includes('model.fallback'));
});

/**
 * A CLI that takes its prompt as an argument gets the same prompt.
 *
 * Some agent CLIs read stdin and some take the prompt on the command line, and
 * a role moved between two runtimes should be doing the same job either way --
 * a prompt that changed with the adapter would make the runtime a variable in
 * the work rather than in who does it. So both paths build it from the same
 * function, and this checks that the argument path is actually wired to it
 * rather than sending an empty string that a model would answer anyway.
 */
test('a CLI that takes its prompt as an argument is sent the same prompt (F13.3, F3.2)', async () => {
  const fixture = await createCompany('cli-prompt-arg');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'codex' });
  const task = await newTask(fixture, { ask: 'anything' });

  const onArgv = await engineWith(
    broker,
    new CliAdapter({
      name: 'codex',
      command: process.execPath,
      args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--prompt', '{prompt}'],
      promptVia: 'arg',
    }),
  ).runTask(fixture.companyId, task.id, 'worker');

  const second = await newTask(fixture, { ask: 'anything' });
  const onStdin = await engineWith(
    broker,
    new CliAdapter({
      name: 'codex',
      command: process.execPath,
      args: [AGENT_CLI, '--mcp-config', '{mcpConfig}'],
    }),
  ).runTask(fixture.companyId, second.id, 'worker');

  assert.equal(onArgv.status, 'completed', onArgv.reason);
  assert.equal(onStdin.status, 'completed', onStdin.reason);

  const viaArgv = onArgv.output as { promptLength: number };
  const viaStdin = onStdin.output as { promptLength: number };
  // The same prompt, byte for byte. Compared against the stdin path rather
  // than against a literal, because what is being tested is that the two paths
  // build it from the same function -- not what that function currently says.
  assert.ok(viaArgv.promptLength > 0, 'the prompt reached the command line');
  assert.equal(viaArgv.promptLength, viaStdin.promptLength);
});

/**
 * A malformed spec is a loud failure at load time.
 *
 * A spec that silently did not load would leave a role pointing at a runtime
 * that is simply not registered, and the engine's message for that names the
 * runtimes it *does* have -- sending whoever reads it looking in the wrong
 * place entirely.
 */
test('a malformed runtime spec says which entry and what is wrong (F13.3)', () => {
  assert.throws(() => runtimeSpecsFrom({ name: 'x' }), /must be an array/);
  assert.throws(() => runtimeSpecsFrom([{ command: 'x', args: [] }]), /spec 0 has no name/);
  assert.throws(() => runtimeSpecsFrom([{ name: 'hermes', args: [] }]), /hermes has no command/);
  assert.throws(
    () => runtimeSpecsFrom([{ name: 'hermes', command: 'h', args: [1] }]),
    /not a string/,
  );
  assert.deepEqual(runtimeSpecsFrom(null), []);
  // Hermes reads `--max-turns 0` as no limit at all (hermes_cli/config.py), so
  // a zero here would not mean "none" but "for ever".
  for (const maxTurns of [0, -1, 2.5, '40']) {
    assert.throws(
      () => runtimeSpecsFrom([{ name: 'hermes', command: 'h', args: ['{maxTurns}'], maxTurns }]),
      /hermes has maxTurns .*; a whole number of at least 1/,
    );
  }
});

/**
 * A model that would sign in as the machine is refused.
 *
 * Each CLI runs with a home of its own and only `PATH` beside it, so it finds
 * none of the operator's stored credentials -- every one OpenClaw reads is
 * under `$HOME` (read from its source for the audit of 2026-09-28). Two model
 * families are the exception: `amazon-bedrock/*` signs in with AWS's default
 * chain, which on a cloud server is the instance's own role, and
 * `claude-cli/*` asks the `claude` binary, which on a Mac reads the login
 * keychain whatever `$HOME` says. Either would run a company's work on the
 * host's identity rather than on a key the owner gave it, so the entry names
 * them and they are refused before anything starts.
 */
test('a model OpenClaw would sign in to with the machine\'s own identity is refused before anything runs (F13.4)', async () => {
  const fixture = await createCompany('cli-host-identity');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'openclaw' });
  const pidfile = join(await mkdtemp(join(tmpdir(), 'palugada-host-identity-')), 'started');
  const adapter = new CliAdapter(knownCli('openclaw', {
    command: process.execPath, acceptedVersion: process.versions.node,
    args: [AGENT_CLI, '--dialect', 'text', '--mcp-config-from', '{runDir}/openclaw.json', '--spawn-orphan', pidfile],
    dialect: 'text',
  }));
  for (const model of ['amazon-bedrock/anthropic.claude-sonnet', 'claude-cli/sonnet']) {
    await withTenant(fixture.companyId, (tx) => tx.query('UPDATE roles SET model = $2 WHERE id = $1', [fixture.roleId, model]));
    const task = await newTask(fixture, { ask: 'x' });
    const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, 'halted', `${model}: ${outcome.reason}`);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: unknown }>(
      "SELECT payload FROM events WHERE task_id = $1 AND type = 'task.halted'", [task.id]));
    assert.match(JSON.stringify(rows[0]?.payload), /sign in with this machine's own identity/);
  }
  await assert.rejects(stat(pidfile), 'nothing was started');
  assert.deepEqual(knownCli('openclaw').hostSignInModels, ['amazon-bedrock/', 'claude-cli/']);
  assert.throws(() => runtimeSpecsFrom([{ name: 'openclaw', command: 'o', args: ['{mcpConfig}'], hostSignInModels: 'claude-cli/' }]),
    /hostSignInModels .* a list of model name prefixes/);
});

/**
 * A CLI with a clock of its own is given the run's.
 *
 * OpenClaw's `--timeout` was written into its entry as 600 seconds, so a task
 * given two hours was ended by OpenClaw at ten minutes -- exit 2, "timed
 * out" -- whatever its deadline said. It is the run's wall clock now: the
 * task's deadline, or the lease when it has none. Never 0, which OpenClaw
 * reads as no limit.
 */
test('an agent CLI with a timeout of its own is given the run\'s deadline, not a number in its entry (F6.4, F13.3)', async () => {
  const fixture = await createCompany('cli-deadline');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'openclaw' });
  const adapter = new CliAdapter({
    name: 'openclaw',
    command: process.execPath,
    args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--dump-argv', '--timeout', '{wallClockSeconds}'],
  });
  const seconds = async (deadlineAt?: Date) => {
    const task = await newTask(fixture, { ask: 'take your time' }, deadlineAt ? { deadlineAt } : {});
    const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, 'completed', outcome.reason);
    const argv = (outcome.output as { argv: string[] }).argv;
    return Number(argv[argv.indexOf('--timeout') + 1]);
  };
  const twoHours = await seconds(new Date(Date.now() + 2 * 3_600_000));
  assert.ok(twoHours > 7_100 && twoHours <= 7_200, `two hours away is about 7200 seconds, not ${twoHours}`);
  assert.equal(await seconds(), 15 * 60, 'without a deadline, the lease');

  const known = knownCli('openclaw').args;
  assert.equal(known[known.indexOf('--timeout') + 1], '{wallClockSeconds}', 'and the shipped entry passes it');
});

/**
 * A placeholder is substituted into an argv element, never through a shell.
 *
 * CLIs disagree about whether a flag and its value are one argument or two, so
 * substitution is textual -- and it is textual into an array that `spawn`
 * passes without a shell, so a model name or a bridge token containing a space,
 * a quote or a semicolon stays exactly one argument.
 */
test('a placeholder becomes one argument whatever it contains (F13.3)', () => {
  const adapter = new CliAdapter({
    name: 'inline',
    command: 'agent',
    args: ['--mcp={mcpConfig}', '--model', '{model}', '--tools={allowedTools}'],
  });
  const argv = adapter.argv({
    model: 'a model; rm -rf /',
    maxTurns: '40',
    wallClockSeconds: '900',
    mcpConfig: '{"a":"b"}',
    mcpConfigFile: '',
    mcpUrl: 'http://127.0.0.1:1/mcp',
    mcpToken: 't',
    allowedTools: 'mcp__palugada__dns.read',
    prompt: 'p',
    runDir: '/tmp/run',
  });

  assert.deepEqual(argv, [
    '--mcp={"a":"b"}',
    '--model',
    'a model; rm -rf /',
    '--tools=mcp__palugada__dns.read',
  ]);
});

/* ------------------------------------------------------ remote_sandbox --- */

/**
 * A sandbox provider written for the test.
 *
 * It runs the same `echo-runtime.mjs` every other out-of-process test uses,
 * as a child process standing in for a machine somewhere else. That is the
 * honest stand-in: what differs about a real provider is latency and an HTTP
 * call, and what this exercises is everything the adapter decides — the wire,
 * the tool bridge's absence, cancellation, and above all whether the sandbox
 * is destroyed on every path out.
 */
function fakeProvider(options: { failCreate?: boolean; failDestroy?: boolean } = {}) {
  const created: string[] = [];
  const destroyed: string[] = [];
  let sequence = 0;

  const provider: SandboxProvider = {
    name: 'fake',
    async create() {
      if (options.failCreate) throw new Error('the region is out of capacity');
      sequence += 1;
      const id = `sbx-${sequence}`;
      created.push(id);
      return id;
    },
    async exec() {
      const child = spawn(process.execPath, [RUNTIME], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.stdin!.on('error', () => {});
      return {
        output: child.stdout!,
        async write(line: string) {
          if (!child.stdin!.destroyed) child.stdin!.write(line);
        },
        stderr: () => stderr,
        async close() {
          child.stdin!.end();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        },
      };
    },
    async destroy(id: string) {
      if (options.failDestroy) throw new Error('the API returned 500');
      destroyed.push(id);
    },
    async health() {
      return { ok: true, detail: 'fake provider' };
    },
  };

  return { provider, created, destroyed };
}

test('a task runs inside a remote sandbox and its output comes back (F13.5, F12.9)', async () => {
  const fixture = await createCompany('sandbox-basic');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'sandbox:fake' });
  const task = await newTask(fixture, { script: 'done' });
  const fake = fakeProvider();

  const outcome = await engineWith(
    broker,
    new RemoteSandboxAdapter({ provider: fake.provider, image: 'palugada/runtime:1' }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(outcome.output, { ok: true, done: ECHOED });
  assert.deepEqual(fake.created, ['sbx-1']);
  assert.deepEqual(fake.destroyed, ['sbx-1']);
});

/**
 * The property the whole backend exists for.
 *
 * A sandbox that outlives its run is a billed machine holding a company's
 * working files, and "almost always destroyed" is a slow leak of both. So the
 * delete runs when the run succeeded, when it failed, and when the runtime
 * died without saying anything — all three, because they are three different
 * paths out of the same method and only one of them is the happy one.
 */
test('a sandbox is destroyed however the run ends (F13.5, F12.9)', async () => {
  const fixture = await createCompany('sandbox-cleanup');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'sandbox:fake' });
  const fake = fakeProvider();
  const adapter = new RemoteSandboxAdapter({
    provider: fake.provider,
    image: 'palugada/runtime:1',
  });

  // Three real paths out of `run`, not three spellings of the same one: a
  // completed run, a runtime that stopped without saying `done`, and one that
  // was not speaking the protocol at all. The last two throw from inside
  // `driveRun`, which is where a cleanup that lives after the call rather than
  // in a `finally` stops happening.
  const outcomes: string[] = [];
  for (const script of ['done', 'silent', 'unreadable']) {
    const task = await newTask(fixture, { script }, { attemptMax: 1 });
    const outcome = await engineWith(broker, adapter).runTask(
      fixture.companyId, task.id, 'worker',
    );
    outcomes.push(outcome.status);
  }
  assert.deepEqual(outcomes, ['completed', 'failed', 'failed'], 'two of the three really failed');

  assert.equal(fake.created.length, 3);
  assert.deepEqual(fake.destroyed, fake.created, 'every sandbox that was made was destroyed');
});

/**
 * A sandbox that could not be destroyed is reported, not swallowed.
 *
 * A leaked sandbox nobody hears about is the same as no cleanup at all: the
 * bill arrives a month later and the working files are still sitting on
 * somebody else's disk in the meantime.
 */
test('a sandbox that will not delete becomes a failure that names it (F13.5)', async () => {
  const fixture = await createCompany('sandbox-leak');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'sandbox:fake' });
  const task = await newTask(fixture, { script: 'done' }, { attemptMax: 1 });
  const fake = fakeProvider({ failDestroy: true });

  const outcome = await engineWith(
    broker,
    new RemoteSandboxAdapter({ provider: fake.provider, image: 'palugada/runtime:1' }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /sbx-1 could not be destroyed/);
});

/**
 * A failed cleanup must not become the story of a failed run.
 *
 * The obvious way to write "always destroy" is a `finally`, and a `throw`
 * inside one replaces whatever exception was already in flight. The cleanup
 * failure would then be reported as the task's cause and the real one -- the
 * runtime crashed, the output did not match the schema -- would be gone. Both
 * matter and they matter to different people: the leak is an operational
 * problem for whoever runs the platform, and the run failure is what the
 * company needs to read.
 */
test('a run that failed reports why, even when the sandbox also leaked (F13.5)', async () => {
  const fixture = await createCompany('sandbox-both-failed');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'sandbox:fake' });
  const task = await newTask(fixture, { script: 'unreadable' }, { attemptMax: 1 });
  const fake = fakeProvider({ failDestroy: true });

  const outcome = await engineWith(
    broker,
    new RemoteSandboxAdapter({ provider: fake.provider, image: 'palugada/runtime:1' }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'failed');
  assert.match(
    outcome.reason ?? '',
    /unreadable output/,
    'the run failed because the runtime was not speaking the protocol',
  );
  // And the leak travels with it rather than being dropped.
  assert.match(outcome.reason ?? '', /sbx-1 could not be destroyed/);
});

test('a provider that cannot make a sandbox fails the run rather than hanging (F13.5)', async () => {
  const fixture = await createCompany('sandbox-nocapacity');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'sandbox:fake' });
  const task = await newTask(fixture, { script: 'done' }, { attemptMax: 1 });
  const fake = fakeProvider({ failCreate: true });

  const outcome = await engineWith(
    broker,
    new RemoteSandboxAdapter({ provider: fake.provider, image: 'palugada/runtime:1' }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /out of capacity/);
  assert.deepEqual(fake.destroyed, [], 'nothing was made, so nothing is deleted');
});

/**
 * A runtime in a sandbox still reaches the broker, and only the broker.
 *
 * It gets no MCP tool bridge — that is an HTTP server on the orchestrator's
 * loopback, which is a different machine — so its tool calls travel as events
 * on the pipe it was born with. F12.9 asks for a runtime with no route to the
 * database, the secret manager or the network, and a runtime whose only
 * channel is that pipe has exactly that.
 */
test("a sandboxed runtime's tool call is resolved by the broker (F12.9, F13.4)", async () => {
  const fixture = await createCompany('sandbox-tool');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'sandbox:fake', tools: ['dns.read'] });
  const task = await newTask(fixture, { script: 'call_tool' });
  const fake = fakeProvider();

  const outcome = await engineWith(
    broker,
    new RemoteSandboxAdapter({ provider: fake.provider, image: 'palugada/runtime:1' }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(
    (outcome.output as { answer: { output: { records: string[] } } }).answer.output.records,
    ['a.example.com'],
  );
  assert.deepEqual(fake.destroyed, ['sbx-1']);
});

test('the remote sandbox backend claims only itself (F13.5)', () => {
  const adapter = new RemoteSandboxAdapter({
    provider: fakeProvider().provider,
    image: 'palugada/runtime:1',
  });
  // Claiming `local` too would make a role's isolation setting a value that
  // sometimes means nothing.
  assert.deepEqual([...adapter.backends], ['remote_sandbox']);
  assert.equal(adapter.name, 'sandbox:fake');
});

test('an unreachable sandbox provider is unhealthy rather than an exception (F13.8)', async () => {
  const adapter = new RemoteSandboxAdapter({
    image: 'palugada/runtime:1',
    provider: {
      name: 'broken',
      async create() { return 'x'; },
      async exec() { throw new Error('unused'); },
      async destroy() {},
      async health() { throw new Error('DNS is not answering'); },
    },
  });
  const health = await adapter.health();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? '', /DNS is not answering/);
});

/**
 * A provider that accepts the connection and never answers.
 *
 * That is what a half-failed vendor does -- it does not refuse, it hangs. The
 * destroy runs on the adapter's unconditional cleanup path and the health
 * check runs before every checkout, so an unbounded request there does not
 * report an unhealthy runtime: it stops the worker from running any task at
 * all, which is the failure F13.8 exists to prevent arriving through the check
 * meant to prevent it.
 */
test('a provider that never answers is a timeout, not a hung worker (F13.5, F13.8)', async () => {
  const held: Array<() => void> = [];
  const server = createServer((_req, res) => {
    // Accepted, and then nothing. The response is held so the socket stays
    // open exactly the way a black-holing vendor's does.
    held.push(() => res.end('{}'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');

  const provider = new HttpSandboxProvider({
    baseUrl: `http://127.0.0.1:${address.port}`,
    timeoutMs: 250,
  });

  try {
    const startedAt = Date.now();
    const health = await new RemoteSandboxAdapter({
      provider,
      image: 'palugada/runtime:1',
    }).health();
    assert.equal(health.ok, false, 'a provider that never answers is not healthy');
    assert.ok(Date.now() - startedAt < 5_000, 'and it says so promptly');

    // The same for the cleanup path, which is the one that would hold `run()`
    // open and with it the tick behind it.
    await assert.rejects(() => provider.destroy('sbx-1'));
  } finally {
    for (const release of held) release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/* ------------------------------------------------- the four F13.3 names --- */

/**
 * The four runtimes F13.3 lists, as specs.
 *
 * None of the four binaries is installed here and none of these command lines
 * has been run against the real thing — `src/runtime/known-clis.ts` says so
 * three times over and `docs/STATUS.md` says it again. So what is asserted is
 * not the flags, which would only prove somebody typed them twice. It is the
 * two things that are true whatever the vendor does: every one of them places
 * the tool bridge, and none of them is given tools of its own.
 */
test('each runtime F13.3 names is a spec that reaches the broker (F13.3, F13.4)', () => {
  const specs = knownClis();
  assert.deepEqual(specs.map((spec) => spec.name), [...KNOWN_CLI_NAMES]);

  for (const spec of specs) {
    // The constructor refuses a spec that would run an agent with no tools at
    // all, so this is F13.4 checked by construction rather than by reading.
    const adapter = new CliAdapter(spec);
    assert.equal(adapter.name, spec.name);

    const layout = adapter.layout({
      model: 'a-model',
      maxTurns: '40',
      wallClockSeconds: '900',
      mcpConfig: '{"mcpServers":{}}',
      mcpConfigFile: '/tmp/run/mcp.json',
      mcpUrl: 'http://127.0.0.1:1/mcp',
      mcpToken: 'tok',
      allowedTools: 'mcp__palugada__dns.read',
      prompt: 'do the thing',
      runDir: '/tmp/run',
    });

    // No placeholder is left unsubstituted anywhere the CLI reads: one that
    // was would reach it as the literal string `{model}`, and a CLI that
    // accepted it would run against a model nobody chose. (A CLI's own
    // substitution syntax -- `${VAR}`, `{env:VAR}` -- is not one of ours.)
    const everything = [...layout.argv, ...Object.values(layout.env), ...Object.values(layout.files)];
    assert.equal(everything.some((text) => /\{[a-zA-Z]+\}/.test(text)), false, spec.name);
    assert.ok(
      everything.some((text) => text.includes('/tmp/run/mcp.json') || text.includes('http://127.0.0.1:1/mcp')),
      `${spec.name} must be pointed at the bridge`,
    );
  }
});

/**
 * A wrong guess is a settings edit, not a bug report.
 *
 * These command lines are unverified, so the shape that ships has to be one
 * where correcting them costs nothing — otherwise the first operator who finds
 * a flag wrong is stuck until this repository releases.
 */
/**
 * The bridge token does not go on a command line.
 *
 * `{mcpConfig}` expands to JSON carrying `Authorization: Bearer <token>`, and
 * an argv is world-readable on the host -- `/proc/<pid>/cmdline`, `ps`, a
 * sidecar container. The token is per-run and expires with it, so the window
 * is short, but it is a credential in a place credentials do not belong.
 * `{mcpConfigFile}` is 0600 in a 0700 directory and is removed when the run
 * ends, and every shipped spec uses it.
 */
test('no shipped runtime spec puts the bridge token on a command line (F13.3, F12.1)', () => {
  for (const spec of knownClis()) {
    const argv = spec.args.join(' ');
    assert.equal(argv.includes('{mcpConfig}'), false, `${spec.name} inlines the MCP config`);
    assert.equal(argv.includes('{mcpToken}'), false, `${spec.name} inlines the bridge token`);
    // And not in a file either, where it would outlive a crash that skipped
    // the clean-up: a file names the variable, the environment holds the
    // value. (`{mcpConfigFile}` is the platform's own 0600 file, and the one
    // exception.)
    for (const [path, body] of Object.entries(spec.files ?? {})) {
      assert.equal(body.includes('{mcpToken}') || body.includes('{mcpConfig}'), false, `${spec.name} writes the token into ${path}`);
    }
  }
});

/**
 * What each CLI does by default that PALUGADA must not let it do.
 *
 * Read from their source: Hermes writes memory and skills after every turn;
 * OpenClaw's `agent exec` turns on a shell; OpenCode loads a project's own
 * configuration and plugins from wherever it runs; all of them fall back to
 * the operator's home, with its stored credentials, when `HOME` is unset.
 */
test('no shipped runtime gets a tool, a home or an approval of its own (F13.4)', () => {
  const dangerous = ['--yolo', '-z', '--auto', '--dangerously-skip-permissions'];
  for (const spec of knownClis()) {
    for (const flag of dangerous) assert.equal(spec.args.includes(flag), false, `${spec.name} passes ${flag}`);
  }

  for (const name of KNOWN_CLI_NAMES) {
    const spec = knownCli(name);
    assert.equal(spec.env?.HOME, '{runDir}', `${name} would fall back to the operator's home`);
    assert.equal(spec.env?.PALUGADA_MCP_TOKEN, '{mcpToken}', `${name} is not given the token in its environment`);
  }

  // What was offered to the model when these ran for real: the bridge, and
  // none of the CLI's own shell, file or web tools.
  const codexConfig = knownCli('codex').files!['.codex/config.toml']!;
  for (const off of ['shell_tool = false', 'unified_exec = false', 'web_search = "disabled"', 'required = true']) {
    assert.ok(codexConfig.includes(off), `codex: ${off}`);
  }
  const gemini = knownCli('gemini-cli');
  const geminiSettings = JSON.parse(gemini.files!['.gemini/settings.json']!.replace('{maxTurns}', '40')) as {
    tools: { core: string[] }; model: { maxSessionTurns: number };
  };
  assert.deepEqual(geminiSettings.tools.core, ['mcp_palugada_*']);
  assert.equal(geminiSettings.model.maxSessionTurns, 40, 'a turn limit, as a number');
  assert.equal(gemini.cwd, '{runDir}', 'Gemini reads workspace settings from wherever it runs');
  assert.ok(!gemini.args.includes('--yolo') && gemini.args.includes('--approval-mode'));

  const hermes = knownCli('hermes');
  assert.deepEqual(hermes.args.slice(hermes.args.indexOf('--toolsets'), hermes.args.indexOf('--toolsets') + 2), ['--toolsets', 'mcp-palugada']);
  const hermesConfig = hermes.files!['hermes/config.yaml']!;
  for (const off of ['memory_enabled: false', 'background_review:\n    enabled: false', 'curator:\n  enabled: false']) {
    assert.ok(hermesConfig.includes(off), `hermes keeps learning on its own: ${off}`);
  }

  const openclaw = JSON.parse(knownCli('openclaw').files!['openclaw.json']!) as { tools: { profile: string; deny: string[] } };
  assert.equal(openclaw.tools.profile, 'minimal');
  for (const group of ['group:runtime', 'group:fs', 'group:web']) assert.ok(openclaw.tools.deny.includes(group));

  const opencode = knownCli('opencode');
  const config = JSON.parse(opencode.env!.OPENCODE_CONFIG_CONTENT!.replace('{maxTurns}', '40')) as {
    permission: Record<string, string>; agent: { palugada: { steps: number } };
  };
  assert.deepEqual(config.permission, { '*': 'deny', 'palugada_*': 'allow' });
  assert.equal(config.agent.palugada.steps, 40, 'a step limit, as a number');
  assert.deepEqual(opencode.args.slice(opencode.args.indexOf('--dir'), opencode.args.indexOf('--dir') + 2), ['--dir', '{runDir}'],
    'OpenCode would load the project configuration and plugins of wherever it ran');
});

test('a spec may not write outside its run directory (F13.3)', () => {
  for (const path of ['../escape', '/etc/cron.d/x', 'a/../../b']) {
    assert.throws(() => new CliAdapter({
      name: 'bad', command: 'x', args: ['{mcpConfigFile}'], files: { [path]: 'x' },
    }), /outside its run directory/, path);
  }
  // The bridge may be placed in the environment or a file, not only in argv.
  assert.doesNotThrow(() => new CliAdapter({ name: 'env', command: 'x', args: [], env: { MCP: '{mcpUrl}' } }));
  assert.throws(() => new CliAdapter({ name: 'none', command: 'x', args: [], env: { A: 'b' } }), /places no tool bridge/);
});

test('a known runtime spec can be corrected without editing the platform (F13.3)', () => {
  const corrected = knownCli('codex', {
    command: '/opt/codex/bin/codex',
    args: ['exec', '--mcp-config', '{mcpConfigFile}', '--model', '{model}'],
  });
  assert.equal(corrected.name, 'codex', 'the name a role points at does not move');
  assert.equal(corrected.command, '/opt/codex/bin/codex');
  assert.doesNotThrow(() => new CliAdapter(corrected));
});

/**
 * And the machinery does not care which of them it is driving.
 *
 * The binary is swapped for the stand-in CLI and everything else — the spec,
 * the adapter, the bridge, the engine — is the real path. That is as close to
 * running `codex` as this repository can get, and it is the part where the
 * platform's own defects would be.
 */
test('a known spec drives a real run once the binary exists (F13.3)', async () => {
  const fixture = await createCompany('known-cli-run');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'codex', tools: ['dns.read'] });
  const task = await newTask(fixture, { ask: 'read the zone' });

  const spec = knownCli('codex', {
    command: process.execPath, acceptedVersion: process.versions.node,
    args: [AGENT_CLI, '--dialect', 'text', '--mcp-config-file', '{mcpConfigFile}', '--call', 'dns.read'],
    dialect: 'text',
  });

  const outcome = await engineWith(broker, new CliAdapter(spec)).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal((outcome.output as { tool: { isError: boolean } }).tool.isError, false);
});

/**
 * The three specs read from their CLIs' source, driven for real: the binary
 * swapped for the stand-in, and everything else -- the spec's own files and
 * environment, the run directory, the bridge, the engine -- the real path.
 * The stand-in finds the bridge the way the real CLI would, in the CLI's own
 * configuration format, with the token taken from the environment variable
 * the configuration names; and it answers in the CLI's own output format.
 */
for (const [name, from] of [
  ['hermes', ['--mcp-config-from', '{runDir}/hermes/config.yaml']],
  ['openclaw', ['--mcp-config-from', '{runDir}/openclaw.json']],
  ['opencode', ['--mcp-config-env', 'OPENCODE_CONFIG_CONTENT']],
  ['codex', ['--mcp-config-from', '{runDir}/.codex/config.toml']],
  ['gemini-cli', ['--mcp-config-from', '.gemini/settings.json']],
] as const) {
  test(`the ${name} spec drives a real run once the binary exists (F13.3)`, async () => {
    const fixture = await createCompany(`known-${name}`);
    const broker = await brokerFor(fixture, ['dns.read']);
    await configureRole(fixture, { runtime: name, tools: ['dns.read'] });
    const task = await newTask(fixture, { ask: 'read the zone' });

    const real = knownCli(name);
    const spec = knownCli(name, {
      command: process.execPath, acceptedVersion: process.versions.node,
      args: [AGENT_CLI, '--dialect', real.dialect!, ...from, '--call', 'dns.read', '--dump-env'],
    });

    // Every key a CLI might read is in this process; each run is given the
    // one its CLI actually reads, and no other. Codex's entry named
    // OPENAI_API_KEY, which `codex exec` ignores, and a run had no key.
    const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'];
    for (const key of keys) process.env[key] = `a value for ${key}`;
    let outcome: Awaited<ReturnType<Engine['runTask']>>;
    try {
      outcome = await engineWith(broker, new CliAdapter(spec)).runTask(fixture.companyId, task.id, 'worker');
    } finally {
      for (const key of keys) delete process.env[key];
    }
    assert.equal(outcome.status, 'completed', outcome.reason);
    const output = outcome.output as { tool: { isError: boolean }; home: string; env: string[] };
    const expected = { codex: ['CODEX_API_KEY'], 'gemini-cli': ['GEMINI_API_KEY'] }[name as string] ?? [];
    assert.deepEqual(output.env.filter((key) => keys.includes(key)), expected, `${name} is given the key it reads`);
    assert.equal(output.tool.isError, false, 'the tool call went through the bridge');
    // Its home was the run's own directory, which is gone now.
    assert.match(output.home, /palugada-run-/);
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(output.home), 'the run directory, with the token in reach, was not removed');
    assert.ok(!output.env.includes('DATABASE_URL') && !output.env.includes('PALUGADA_ADMIN_URL'));

    // The usage reached the ledger in the CLI's own terms.
    const traces = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ input_tokens: number; output_tokens: number }>(
      "SELECT input_tokens, output_tokens FROM llm_traces WHERE task_id = $1 AND kind = 'call'", [task.id],
    )).rows);
    assert.ok(traces.some((trace) => trace.input_tokens > 0 && trace.output_tokens > 0), `${name} usage was lost`);
  });
}

/**
 * A role names a tier; an agent CLI knows only its own model names. The
 * tier used to reach the CLI as written -- `--model standard` -- and every
 * template role put on one failed at its first run.
 */
test('a tier becomes the model each CLI knows, and one it cannot is refused by name (F13.6)', async () => {
  const fixture = await createCompany('cli-tiers');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'codex', tools: ['dns.read'] });
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET model = 'standard' WHERE id = $1", [fixture.roleId]));

  const told = knownCli('codex', {
    command: process.execPath, acceptedVersion: process.versions.node,
    args: [AGENT_CLI, '--dialect', 'codex-jsonl', '--mcp-config-from', '{runDir}/.codex/config.toml', '--model', '{model}'],
    models: { standard: 'gpt-something' },
  });
  const ran = await engineWith(broker, new CliAdapter(told)).runTask(fixture.companyId, (await newTask(fixture, { ask: 'x' })).id, 'worker');
  assert.equal(ran.status, 'completed', ran.reason);
  assert.equal((ran.output as { model: string }).model, 'gpt-something');

  const untold = knownCli('codex', {
    command: process.execPath, acceptedVersion: process.versions.node,
    args: [AGENT_CLI, '--dialect', 'codex-jsonl', '--mcp-config-from', '{runDir}/.codex/config.toml', '--model', '{model}'],
  });
  const refused = await engineWith(broker, new CliAdapter(untold)).runTask(fixture.companyId, (await newTask(fixture, { ask: 'x' })).id, 'worker');
  assert.equal(refused.status, 'halted', 'a model that will not exist next time either is not retried');
  assert.equal(refused.reason, 'runtime_unavailable');

  // Claude Code's own aliases follow the latest model of each size.
  const argv = new ClaudeCodeAdapter().argv(
    { runId: 'r', roleSlug: 'worker', modelRouting: { primary: 'deep', fallback: [] }, allowedTools: [] } as never, '/run/x/mcp.json');
  assert.equal(argv[argv.indexOf('--model') + 1], 'opus');
  const named = new ClaudeCodeAdapter().argv(
    { runId: 'r', roleSlug: 'worker', modelRouting: { primary: 'claude-x-1', fallback: [] }, allowedTools: [] } as never, '/run/x/mcp.json');
  assert.equal(named[named.indexOf('--model') + 1], 'claude-x-1', 'a model named outright is passed as it is');
});

/** What each dialect makes of the failures its CLI can print. */
test('each CLI dialect reads a failure as a failure (F13.3)', async () => {
  const { hermesEvents, openClawEvents, openCodeEvents, codexEvents, geminiEvents } = await import('../../src/runtime/cli-dialects.ts');
  async function* from(lines: string[]) { for (const line of lines) yield line; }
  const drain = async (events: AsyncGenerator<RunEvent>) => { const out: RunEvent[] = []; for await (const e of events) out.push(e); return out; };
  const exit = (code: number) => () => Promise.resolve(code);
  const quiet = () => 'stderr says why';

  // Hermes: a result with a non-zero exit is an error, after its usage; no
  // result at all is an error; banners are ignored.
  let events = await drain(hermesEvents(from(['Hermes v1.0', JSON.stringify({ type: 'result', exit_code: 1, text: '', tokens: { input: 5, output: 1 }, error: 'budget' })]), exit(1), quiet, 'hermes', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['usage', 'error']);
  assert.match((events[1] as { message: string }).message, /exit code 1 \(budget\): stderr says why/);
  events = await drain(hermesEvents(from([JSON.stringify({ type: 'text', text: 'half' })]), exit(0), quiet, 'hermes', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['text', 'error'], 'a run with no result did not finish, whatever its exit code');

  // OpenClaw: a timeout says so; output that is not its envelope is an error.
  events = await drain(openClawEvents(Promise.resolve(JSON.stringify({ status: 'timeout', usage: { input: 1, output: 1 } })), exit(2), quiet, 'openclaw', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['usage', 'error']);
  assert.match((events[1] as { message: string }).message, /timed out/);
  events = await drain(openClawEvents(Promise.resolve('Error: no such model'), exit(1), quiet, 'openclaw', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['error']);

  // OpenCode: a model with no price reports cost zero, which is unknown, not
  // free; an error event is the verdict whatever came before it.
  events = await drain(openCodeEvents(from([
    JSON.stringify({ type: 'text', part: { text: '{"a":1}' } }),
    JSON.stringify({ type: 'step_finish', part: { cost: 0, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } }),
    JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'overloaded' } } }),
  ]), exit(1), quiet, 'opencode', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['text', 'usage', 'error']);
  assert.equal((events[1] as { usage: { costCents: number | null } }).usage.costCents, null);
  assert.equal((events[2] as { providerFailure: boolean }).providerFailure, true, 'a provider error may be retried on a fallback');

  // Codex: a warning is not a failure, `turn.failed` is, and so is a run that
  // said nothing. Lines as Codex 0.157.1 printed them.
  events = await drain(codexEvents(from([
    JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"a":1}' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 22, cached_input_tokens: 6, output_tokens: 14, reasoning_output_tokens: 4 } }),
  ]), exit(0), quiet, 'codex', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['text', 'usage', 'done']);
  assert.deepEqual((events[1] as { usage: object }).usage, { model: 'm', inputTokens: 22, outputTokens: 14, costCents: null },
    'cached and reasoning tokens are parts of these, not more of them');
  events = await drain(codexEvents(from([JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } })]), exit(1), quiet, 'codex', 'm'));
  assert.match((events.at(-1) as { message: string }).message, /reported quota/);
  events = await drain(codexEvents(from([]), exit(0), quiet, 'codex', 'm'));
  assert.match((events.at(-1) as { message: string }).message, /without an answer/);

  // Gemini: the answer is what came after the last tool; an error result is
  // the verdict, with its usage first.
  events = await drain(geminiEvents(from([
    JSON.stringify({ type: 'message', role: 'assistant', content: 'checking', delta: true }),
    JSON.stringify({ type: 'tool_result', tool_id: 't', status: 'success', output: 'x' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '{"a":', delta: true }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '1}', delta: true }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 22, output_tokens: 14, models: { 'gemini-x': {} } } }),
  ]), exit(0), quiet, 'gemini-cli', 'm'));
  assert.deepEqual(events.at(-1), { type: 'done', output: { a: 1 } });
  assert.equal((events.at(-2) as { usage: { model: string } }).usage.model, 'gemini-x');
  events = await drain(geminiEvents(from([
    JSON.stringify({ type: 'result', status: 'error', error: { type: 'FatalTurnLimitedError', message: 'turn limit' }, stats: { input_tokens: 5, output_tokens: 1 } }),
  ]), exit(53), quiet, 'gemini-cli', 'm'));
  assert.deepEqual(events.map((e) => e.type), ['usage', 'error']);
  assert.match((events[1] as { message: string }).message, /ended as error \(turn limit\)/);
  events = await drain(geminiEvents(from(['Gemini CLI is not running in a trusted directory']), exit(55), quiet, 'gemini-cli', 'm'));
  assert.match((events.at(-1) as { message: string }).message, /exited 55 without a result: stderr says why/);
});

test('a runtime spec that names a dialect nobody speaks is refused (F13.3)', () => {
  assert.throws(() => runtimeSpecsFrom([{ name: 'x', command: 'x', args: ['{mcpConfigFile}'], dialect: 'stream_json' }]),
    /names dialect stream_json; one of stream-json, text/);
});

/* ------------------------------------------------------- the process tree --- */

/**
 * Whether a pid is still a running process. A zombie is not: it has exited
 * and is only waiting for a parent that, in a container, may never come.
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch {
    return true;
  }
}

async function pidFrom(file: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid written to ${file}`);
}

/**
 * An agent CLI is a parent. It starts shells, test runners, dev servers --
 * and one that finishes its answer and exits can leave any of them running.
 * The adapter used to signal only the CLI, and only if it was still alive, so
 * the case that most needed cleaning up was the one never cleaned up at all:
 * a finished run, with a process of its own still holding a port and the
 * owner's key.
 */
test('a process an agent CLI leaves behind does not outlive the run (F13.2)', async () => {
  const fixture = await createCompany('cli-orphan');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'codex', tools: ['dns.read'] });
  const task = await newTask(fixture, { ask: 'read the zone' });
  const dir = await mkdtemp(join(tmpdir(), 'palugada-orphan-'));
  const pidFile = join(dir, 'orphan.pid');

  const [spec] = runtimeSpecsFrom([{
    name: 'codex',
    command: process.execPath,
    args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--spawn-orphan', pidFile],
  }]);
  const outcome = await engineWith(broker, new CliAdapter(spec!)).runTask(
    fixture.companyId, task.id, 'worker',
  );
  assert.equal(outcome.status, 'completed', outcome.reason);

  const orphan = await pidFrom(pidFile);
  assert.equal(running(orphan), false, `pid ${orphan} was left running after the run ended`);
});

/**
 * F5.6 said a task past its deadline halts, and the engine checked that
 * before every step -- which does nothing against a runtime that has hung and
 * takes no steps. `limits.wallClockMs` was sent to every runtime and enforced
 * by none. This one ignores SIGTERM as well, so the escalation to SIGKILL is
 * what ends it.
 */
test('a runtime that hangs past its deadline is ended, and the task halts (F5.6, F6.4)', async () => {
  const fixture = await createCompany('cli-hang');
  const broker = await brokerFor(fixture, ['dns.read']);
  await configureRole(fixture, { runtime: 'codex', tools: ['dns.read'] });
  const task = await newTask(fixture, { ask: 'read the zone' }, { deadlineAt: new Date(Date.now() + 1_500) });
  const dir = await mkdtemp(join(tmpdir(), 'palugada-hang-'));
  const pidFile = join(dir, 'hung.pid');

  const [spec] = runtimeSpecsFrom([{
    name: 'codex',
    command: process.execPath,
    args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--hang', pidFile],
  }]);
  const started = Date.now();
  const outcome = await engineWith(broker, new CliAdapter(spec!)).runTask(
    fixture.companyId, task.id, 'worker',
  );
  const hung = await pidFrom(pidFile);

  assert.equal(outcome.status, 'halted', outcome.reason);
  assert.equal(outcome.reason, 'deadline_passed');
  assert.equal(running(hung), false, 'a runtime that ignored SIGTERM was still killed');
  assert.ok(Date.now() - started < 15_000, 'ended at its deadline, not whenever it chose');
});

/**
 * And a deadline far away is far away. `setTimeout` cannot wait past about
 * twenty-five days and fires after one millisecond instead, so a task due in
 * a month had its runtime cancelled as overdue the moment it started.
 */
test('a deadline a month away does not end the run at once (F5.6)', async () => {
  const fixture = await createCompany('script-far-deadline');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const task = await newTask(fixture, { ask: 'anything' }, {
    deadlineAt: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
  });
  // Answers after a short pause, which a timer that fired at once would beat.
  const slowAnswer = [
    'process.stdin.resume();',
    `setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'done', output: { ok: true, done: ${JSON.stringify(DONE)} } }) + '\\n'); process.exit(0); }, 300);`,
  ].join('\n');
  const adapter = new ScriptAdapter({ command: process.execPath, args: ['-e', slowAnswer] });
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
});

/**
 * Ended mid-sentence, a runtime's last words are a broken line, and the
 * script adapter reads a broken line as "not speaking the protocol" -- an
 * ordinary failure, which spends an attempt and runs the same overrun again.
 * The deadline is why it stopped, and the deadline is what the engine is told.
 */
test('a runtime ended mid-line at its deadline halts on the deadline, not on the garbage', async () => {
  const fixture = await createCompany('script-hang');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const task = await newTask(fixture, { ask: 'anything' }, { deadlineAt: new Date(Date.now() + 1_000) });

  const hangsMidLine = [
    "process.on('SIGTERM', () => {});",
    "process.stdin.resume();",
    "process.stdout.write('{\"type\":\"text\",\"text\":\"half a thou');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const adapter = new ScriptAdapter({ command: process.execPath, args: ['-e', hangsMidLine] });
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'halted', outcome.reason);
  assert.equal(outcome.reason, 'deadline_passed');
});

/**
 * A runtime's output is read a line at a time, and a line is held until it
 * ends. One that never ended -- a CLI stuck redrawing a progress bar, a model
 * pouring a file into one string, a process gone wrong -- was held whole, and
 * the worker's memory grew with it until the deadline or the machine gave
 * out first. Every reader now stops the run at a bound and says why: Claude
 * Code's stream-json, the other CLIs' lines, and a script's protocol.
 */
test('a runtime that writes without ever ending a line is stopped and says why (F13.2)', async () => {
  const fixture = await createCompany('runaway-line');
  const broker = await brokerFor(fixture, []);
  const dir = await mkdtemp(join(tmpdir(), 'palugada-flood-'));
  const floods = [
    { runtime: 'codex', dialect: undefined, file: join(dir, 'stream-json.pid') },
    { runtime: 'codex', dialect: 'codex-jsonl', file: join(dir, 'codex.pid') },
    { runtime: 'script', dialect: undefined, file: join(dir, 'script.pid') },
  ];

  for (const flood of floods) {
    await configureRole(fixture, { runtime: flood.runtime });
    // A deadline, so a reader without a bound ends here rather than hanging
    // the suite; the run must stop well before it.
    const task = await newTask(fixture, { script: 'flood', pidFile: flood.file }, {
      attemptMax: 1, deadlineAt: new Date(Date.now() + 20_000),
    });
    const adapter = flood.runtime === 'script'
      ? scriptAdapter()
      : new CliAdapter(runtimeSpecsFrom([{
        name: 'codex',
        command: process.execPath,
        args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--flood', flood.file],
        ...(flood.dialect ? { dialect: flood.dialect } : {}),
      }])[0]!);

    const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');
    const pid = await pidFrom(flood.file);

    assert.equal(outcome.status, 'failed', `${flood.dialect ?? flood.runtime}: ${outcome.reason}`);
    assert.match(outcome.reason ?? '', /without a line break/, flood.dialect ?? flood.runtime);
    assert.equal(running(pid), false, `the flooding ${flood.dialect ?? flood.runtime} process was ended`);
  }
});

/* ------------------------------------------------------------ the bill --- */

async function spentBy(fixture: Fixture): Promise<number> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ spent: string }>(
      'SELECT money_spent_cents::text AS spent FROM budget_accounts WHERE id = $1',
      [fixture.budgetAccountId],
    );
    return Number(rows[0]!.spent);
  });
}

/**
 * A usage report was cast, not read, and it is the one message that moves
 * money: `budget_spend` adds what it is given. A runtime that reported
 * minus forty dollars -- a bug, or a prompt it read telling it to -- took
 * forty dollars off its company's recorded spend, and the run completed.
 */
test('a runtime cannot report a negative cost to erase its company\'s spend (F13.7, F1.7)', async () => {
  const fixture = await createCompany('usage-negative');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  await withControlPlane((tx) => tx.query(
    'UPDATE budget_accounts SET money_spent_cents = 5000 WHERE id = $1', [fixture.budgetAccountId],
  ));
  const task = await newTask(fixture, { ask: 'anything' });

  const lies = [
    'process.stdin.resume();',
    `console.log(JSON.stringify({ type: 'usage', usage: { model: 'm', inputTokens: 10, outputTokens: 1, costCents: -4000 } }));`,
    `console.log(JSON.stringify({ type: 'done', output: {} }));`,
  ].join('\n');
  const outcome = await engineWith(
    broker, new ScriptAdapter({ command: process.execPath, args: ['-e', lies] }),
  ).runTask(fixture.companyId, task.id, 'worker');

  assert.notEqual(outcome.status, 'completed', 'a run that lied about its bill did not complete');
  assert.equal(await spentBy(fixture), 5000, 'the spend was not erased');
});

/**
 * An agent CLI prices nothing per message and states the run's bill at the
 * end. The estimates stay -- they are what let a budget stop a run while it
 * is running -- and the bill replaces them when it arrives, through the same
 * chain-wide settlement a capability's actual cost uses.
 */
test('a CLI\'s own total replaces the estimates it was charged (F13.7)', async () => {
  const fixture = await createCompany('cli-total-cost');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'codex' });
  const task = await newTask(fixture, { ask: 'anything' });

  const [spec] = runtimeSpecsFrom([{
    name: 'codex',
    command: process.execPath,
    args: [AGENT_CLI, '--model', '{model}', '--mcp-config', '{mcpConfig}', '--total-cost', '0.42'],
  }]);
  const outcome = await engineWith(broker, new CliAdapter(spec!)).runTask(
    fixture.companyId, task.id, 'worker',
  );
  assert.equal(outcome.status, 'completed', outcome.reason);

  // 120 in and 34 out at the fallback rounds up to one cent, then the bill
  // of 42 replaces it: 42, not 43.
  assert.equal(await spentBy(fixture), 42);
  const settled = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'cost.settled'",
    );
    return rows.map((row) => row.payload);
  });
  assert.deepEqual(settled, [{ model: 'test-model', chargedCents: 1, actualCents: 42, deltaCents: 41 }]);

  // And every figure that reads the trace record sees the bill, not the
  // estimate: the monthly pause, and the cost report the owner reads. They
  // used to say 1 while the accounts said 42.
  const { periodSpend } = await import('../../src/governance/spend-guard.ts');
  const { costBreakdown } = await import('../../src/reporting/cost.ts');
  assert.equal((await periodSpend(fixture.companyId)).cents, 42);
  const byRole = await costBreakdown(fixture.companyId, 'role', {
    from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000),
  });
  assert.deepEqual(byRole.map((row) => [row.costCents, row.calls]), [[42, 1]],
    'one call, costing what the provider billed');
});

/**
 * What a Hermes run cost, from Hermes' own ledger.
 *
 * Hermes prints tokens on its result line and no price, and `--usage-file`,
 * which would give one, belongs to `-z`, the mode that approves everything --
 * so every Hermes run was charged PALUGADA's deliberately high fallback rate.
 * Hermes does price the session, and keeps it: after the run,
 * `hermes sessions export` reads it back by the session id the result line
 * gave. A price Hermes marks unknown stays unknown here too -- counted as
 * free, a hard stop could never trip -- and falls back to the price list.
 */
test('a Hermes run is charged what Hermes recorded for its session; a price it does not know is not free (F13.7)', async () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ['provider-reported', { cost_status: 'actual', actual_cost_usd: 0.42, estimated_cost_usd: 0.4 }, 42],
    ['Hermes estimated', { cost_status: 'estimated', actual_cost_usd: null, estimated_cost_usd: 0.31 }, 31],
    ['in a subscription', { cost_status: 'included', actual_cost_usd: null, estimated_cost_usd: 0 }, 0],
    // 120 in and 34 out at the fallback rate rounds up to one cent.
    ['not known', { cost_status: 'unknown', actual_cost_usd: null, estimated_cost_usd: null }, 1],
  ];
  for (const [what, row, cents] of cases) {
    const fixture = await createCompany(`hermes-cost-${cents}`);
    const broker = await brokerFor(fixture, []);
    await configureRole(fixture, { runtime: 'hermes' });
    const [spec] = runtimeSpecsFrom([{
      name: 'hermes',
      command: process.execPath,
      args: [AGENT_CLI, '--dialect', 'hermes-stream-json', '--mcp-config', '{mcpConfig}', '--model', '{model}'],
      dialect: 'hermes-stream-json',
      costArgs: [AGENT_CLI, 'sessions', 'export', '-', '--session-id', '{sessionId}', '--session-row', JSON.stringify(row)],
    }]);
    const task = await newTask(fixture, { ask: 'anything' });
    const outcome = await engineWith(broker, new CliAdapter(spec!)).runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, 'completed', `${what}: ${outcome.reason}`);
    assert.equal(await spentBy(fixture), cents, what);
  }
  assert.deepEqual(knownCli('hermes').costArgs, ['sessions', 'export', '-', '--session-id', '{sessionId}']);
  assert.throws(() => runtimeSpecsFrom([{ name: 'hermes', command: 'h', args: ['{mcpConfig}'], costArgs: 'sessions' }]),
    /costArgs that is not a list of arguments/);
});

/**
 * A runtime may price a call at a fraction of a cent, and everything that
 * records money counts whole cents: the fraction reached `budget_spend` as
 * "0.4" and the run died on a bigint cast.
 */
test('a call priced at a fraction of a cent is charged a whole one (F13.7)', async () => {
  const fixture = await createCompany('fractional-cost');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const adapter = {
    name: 'script',
    backends: ['local'] as const,
    async health() {
      return { ok: true };
    },
    async run(
      request: { modelRouting: { primary: string } },
      services: { reportUsage: (usage: Record<string, unknown>) => Promise<void> },
    ) {
      await services.reportUsage({
        model: request.modelRouting.primary, inputTokens: 5, outputTokens: 5, costCents: 0.4,
      });
      return { output: { done: DONE } };
    },
  };
  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter as never).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal(await spentBy(fixture), 1);
});

/** The wire's own half of it, for every runtime that is not this process. */
test('a usage report is read, not cast', () => {
  const usage = (fields: Record<string, unknown>) => ({
    type: 'usage',
    usage: { model: 'm', inputTokens: 1, outputTokens: 1, costCents: null, ...fields },
  });
  for (const bad of [
    { costCents: -1 }, { inputTokens: -5 }, { outputTokens: 1.5 }, { inputTokens: '10' },
    { model: '' }, { costCents: Number.NaN }, { runTotal: 'yes' }, { runTotal: true },
  ]) {
    assert.throws(() => parseRunEvent(usage(bad)), Error, JSON.stringify(bad));
  }
  assert.throws(() => parseRunEvent({ type: 'usage' }));
  // Saying nothing about the price is not knowing it, and is estimated like
  // null rather than refused with the tokens it did report.
  const unpriced = parseRunEvent({ type: 'usage', usage: { model: 'm', inputTokens: 3, outputTokens: 4 } });
  assert.deepEqual(unpriced, {
    type: 'usage',
    usage: { model: 'm', inputTokens: 3, outputTokens: 4, costCents: null },
  });
  const read = parseRunEvent(usage({ costCents: 12, runTotal: true, extra: 'dropped' }));
  assert.deepEqual(read, {
    type: 'usage',
    usage: { model: 'm', inputTokens: 1, outputTokens: 1, costCents: 12, runTotal: true },
  });
});

/**
 * A runtime's call that needs the owner parks the task; the run's ending does
 * not complete it.
 *
 * The broker answers a tier 2 call by opening an approval and moving the task
 * to `waiting_approval`. For an in-process handler that answer is a throw
 * that ends the run. A runtime in another process is told it as a refused
 * tool call and carries on -- and then says `done`, and the engine used to
 * try to complete a task that was waiting for the owner.
 */
test('a runtime whose call needs the owner leaves its task waiting for the owner (F10.1, F13.4)', async () => {
  const fixture = await createCompany('script-approval');
  let executed = 0;
  const transfer: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.write',
    adapter: 'test:dns',
    // Tier 3: the owner is asked, whatever else is true.
    defaultTier: 3,
    async execute() {
      executed += 1;
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  const registry = new CapabilityRegistry();
  registry.register(transfer);
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const name of ['dns.write', 'plan.record']) await grantCapability(fixture, name);
  const broker = new CapabilityBroker(registry);
  await configureRole(fixture, { runtime: 'script', tools: ['plan.record', 'dns.write'] });
  const task = await newTask(fixture, { script: 'plan_then_write' });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(fixture.companyId, task.id, 'worker');
  const after = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
    'SELECT status FROM tasks WHERE id = $1', [task.id]));
  const items = await withTenant(fixture.companyId, (tx) => tx.query<{ kind: string; status: string }>(
    'SELECT kind, status FROM inbox_items WHERE task_id = $1', [task.id]));
  assert.deepEqual({ outcome: outcome.status, task: after.rows[0]!.status, items: items.rows }, {
    outcome: 'waiting_approval', task: 'waiting_approval', items: [{ kind: 'approval', status: 'open' }],
  }, JSON.stringify(outcome));
  assert.equal(executed, 0, 'nothing irreversible ran before the owner said so');
  const { rows: lease } = await withTenant(fixture.companyId, (tx) => tx.query<{ lease_holder: string | null }>(
    'SELECT lease_holder FROM tasks WHERE id = $1', [task.id]));
  assert.equal(lease[0]!.lease_holder, null, 'a task waiting for the owner names no worker, so any worker can resume it');
});

/**
 * `owner.ask`: a run in any runtime can put a question to the owner, and the
 * task waits for the answer rather than guessing.
 *
 * A runtime had two ways forward when only the owner knew something: guess,
 * which spends money on what may be the wrong thing, or fail into an
 * incident. Buzz makes asking mandatory when a person is needed; Paperclip's
 * agents ask the board. Here the question is an item in the owner's inbox,
 * the task parks on it, and the run after the answer is given it.
 */
test('a runtime asks the owner, waits, and carries on with the answer (owner.ask)', async () => {
  const fixture = await createCompany('script-ask');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'owner.ask');
  const broker = new CapabilityBroker(registry);
  await configureRole(fixture, { runtime: 'script', tools: ['owner.ask'] });
  const task = await newTask(fixture, { script: 'ask_owner' });
  const engine = engineWith(broker, scriptAdapter());

  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.status, 'waiting_approval', first.reason);
  const { rows: items } = await withTenant(fixture.companyId, (tx) => tx.query<{
    id: string; kind: string; status: string; title: string; payload: { askedBy: string; question: string };
    rationale: string; consequence_if_denied: string;
  }>('SELECT id, kind, status, title, payload, rationale, consequence_if_denied FROM inbox_items WHERE task_id = $1', [task.id]));
  // The card says the question once, what depends on it, and what a no does.
  assert.equal(items[0]!.rationale, 'Two match the brief.');
  assert.match(items[0]!.consequence_if_denied, /task is stopped/);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'escalation');
  assert.match(items[0]!.title, /asks: Which supplier did you mean\?/);
  assert.deepEqual([items[0]!.payload.askedBy, items[0]!.payload.question], ['agent', 'Which supplier did you mean?']);

  // The owner answers with the note on their yes.
  await inbox.decide(fixture.companyId, items[0]!.id, 'approve', 'Supplier B, the one in Bandung.', { channel: 'app' });

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
  const told = context.sections.find((section) => section.title === 'The owner answered your question');
  assert.ok(told, 'the run after the answer is not told it');
  assert.match(told.body, /The owner answered: Supplier B, the one in Bandung\./);

  const second = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(second.status, 'completed', second.reason);
  const answer = (second.output as { answer: { output?: { answered: boolean; answer: string } } }).answer;
  assert.deepEqual(answer.output, { answered: true, answer: 'Supplier B, the one in Bandung.' });
  const asked = await withTenant(fixture.companyId, (tx) => tx.query(
    "SELECT 1 FROM inbox_items WHERE task_id = $1 AND kind = 'escalation'", [task.id]));
  assert.equal(asked.rowCount, 1, 'the same question is not asked twice');
});

test('a task asks the owner three things at most, and an unanswered question is said to be one', async () => {
  const fixture = await createCompany('ask-bounds');
  const task = await newTask(fixture, { script: 'done' });
  await transition(fixture.companyId, task.id, 'running');
  const ask = (question: string) => inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question });

  const one = await ask('Which supplier?');
  assert.equal(one.state, 'waiting');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'waiting_approval');
  assert.equal((await ask('Which supplier?')).inboxItemId, one.inboxItemId, 'asked again, it is the same item');
  await ask('Which week?');
  await ask('Which price?');
  await assert.rejects(ask('Which colour?'), /asked the owner 3 questions/);

  await withControlPlane((tx) => tx.query("UPDATE inbox_items SET status = 'expired' WHERE id = $1", [one.inboxItemId]));
  assert.equal((await ask('Which supplier?')).state, 'unanswered');
});

/**
 * `task.delegate` and `task.await`: a runtime in another process splits a
 * job. `awaitChild` existed for in-process handlers only, so an agent CLI --
 * the runtimes that do real work -- could not hand anything to another role.
 * Waiting does not hold a worker: the parent parks until the child is done,
 * and the run after it reads the child's contained result.
 */
test('a runtime hands work to another role and carries on with its result', async () => {
  const fixture = await createCompany('script-delegate');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const name of ['task.delegate', 'task.await']) await grantCapability(fixture, name);
  const broker = new CapabilityBroker(registry);
  await configureRole(fixture, { runtime: 'script', tools: ['task.delegate', 'task.await'] });
  const slug = (await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>(
    'SELECT slug FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!.slug;
  const parent = await newTask(fixture, { script: 'delegate', to: slug });
  const engine = engineWith(broker, scriptAdapter());

  const first = await engine.runTask(fixture.companyId, parent.id, 'worker');
  assert.equal(first.status, 'waiting_window', first.reason);
  const { rows: parked } = await withTenant(fixture.companyId, (tx) => tx.query<{ wait_until: Date | null; lease_holder: string | null }>(
    'SELECT wait_until, lease_holder FROM tasks WHERE id = $1', [parent.id]));
  assert.ok(parked[0]!.wait_until && parked[0]!.wait_until.getTime() > Date.now(), 'the parent waits for a time, then looks again');
  assert.equal(parked[0]!.lease_holder, null, 'and holds no worker while it waits');
  const { rows: children } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; status: string; deadline_at: Date | null }>(
    'SELECT id, status, deadline_at FROM tasks WHERE parent_task_id = $1', [parent.id]));
  assert.equal(children.length, 1);
  assert.ok(children[0]!.deadline_at, 'a delegated task has a deadline (F6.4)');

  // The child runs as any task does, and the parent resumes to read it --
  // at once, not when its two-minute look comes round: a company whose
  // every hand-off cost two minutes of nothing was slow for no reason.
  const child = await engine.runTask(fixture.companyId, children[0]!.id, 'worker');
  assert.equal(child.status, 'completed', child.reason);
  const { rows: woken } = await withTenant(fixture.companyId, (tx) => tx.query<{ wait_until: Date | null }>(
    'SELECT wait_until FROM tasks WHERE id = $1', [parent.id]));
  assert.ok(woken[0]!.wait_until!.getTime() <= Date.now(), 'the parent is claimable the moment its child ends');
  const second = await engine.runTask(fixture.companyId, parent.id, 'worker');
  assert.equal(second.status, 'completed', second.reason);
  const output = second.output as { child: string; answer: { output: { status: string; output: unknown; summary: string } } };
  assert.equal(output.child, children[0]!.id, 'the replayed delegation is the same child');
  assert.equal(output.answer.output.status, 'completed');
  assert.deepEqual(output.answer.output.output, { ok: true, done: ECHOED });
  const { rows: count } = await withTenant(fixture.companyId, (tx) => tx.query(
    'SELECT 1 FROM tasks WHERE parent_task_id = $1', [parent.id]));
  assert.equal(count.length, 1, 'resuming did not delegate again');
});

test('a task waits only on work it delegated, and delegates only to a role that exists', async () => {
  const fixture = await createCompany('delegate-bounds');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  for (const name of ['task.delegate', 'task.await']) await grantCapability(fixture, name);
  const broker = new CapabilityBroker(registry);
  const one = await newTask(fixture, { script: 'done' });
  const other = await newTask(fixture, { script: 'done' });
  await transition(fixture.companyId, one.id, 'running');
  const ctx = (taskId: string, key: string) => ({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId, idempotencyKey: key,
  });
  await assert.rejects(broker.invoke(ctx(one.id, 'd1'), 'task.delegate', { role: 'nobody', brief: 'x' }), /no role nobody/);
  await assert.rejects(broker.invoke(ctx(one.id, 'd2'), 'task.await', { childId: other.id }), /not one this task delegated/);
  await assert.rejects(broker.invoke(ctx(one.id, 'd3'), 'task.delegate', { role: 'x', brief: '  ' }), /needs a brief/);
});

/**
 * What a runtime says while it works is kept for the owner to read: redacted
 * like everything else that is stored, bounded per run, and in order. The
 * wire used to throw every line away.
 */
test('what a runtime says is kept, redacted and bounded, beside the task', async () => {
  const fixture = await createCompany('script-narrate');
  const broker = await brokerFor(fixture, []);
  await configureRole(fixture, { runtime: 'script' });
  const { redactor } = await import('../../src/secrets/manager.ts');
  const { transcriptOf, NOTES_PER_RUN } = await import('../../src/engine/transcript.ts');
  redactor.register('sk-live-narration-7777');
  const lines: Array<string | string[]> = [
    'Reading the zone for example.com',
    // In parts, so the request's own redaction does not hide it: the
    // runtime says it whole, and only the transcript's redaction can catch it.
    ['Using key sk-live-', 'narration-7777 to check'],
    'x'.repeat(3_000),
    ...Array.from({ length: NOTES_PER_RUN }, (_, index) => `line ${index}`),
  ];
  const task = await newTask(fixture, { script: 'narrate', lines });

  const outcome = await engineWith(broker, scriptAdapter()).runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);

  const notes = await transcriptOf(fixture.companyId, task.id);
  assert.equal(notes[0]!.body, 'Reading the zone for example.com');
  assert.doesNotMatch(notes[1]!.body, /sk-live-narration-7777/, 'redacted before it is stored');
  assert.equal(notes[2]!.body.length <= 2_000, true, 'a long line is cut, not refused');
  assert.equal(notes.length, NOTES_PER_RUN + 1, 'bounded per run, and the bound says so');
  assert.match(notes.at(-1)!.body, /no more of this run's narration is kept/);
  assert.deepEqual(notes.map((note) => note.seq), notes.map((_, index) => index + 1));

  // Another company's task is not there to read.
  const other = await createCompany('script-narrate-other');
  assert.deepEqual(await transcriptOf(other.companyId, task.id), []);

  // And it travels with the company, pointed at the restored task.
  const { exportCompany } = await import('../../src/audit/export.ts');
  const { importCompany } = await import('../../src/audit/import.ts');
  const archive: Array<{ section: string; row: Record<string, unknown> }> = [];
  await exportCompany(fixture.companyId, (line) => { archive.push(line); });
  const restored = await importCompany(archive, { slug: 'script-narrate-restored' });
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ id: string }>('SELECT id FROM tasks'));
  const copied = await transcriptOf(restored.companyId, rows[0]!.id);
  assert.deepEqual(copied.map((note) => note.body), notes.map((note) => note.body));
});
