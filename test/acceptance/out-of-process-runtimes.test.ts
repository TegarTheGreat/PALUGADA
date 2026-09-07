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
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { AdapterRegistry, type RunEvent } from '../../src/runtime/protocol.ts';
import { ScriptAdapter } from '../../src/runtime/script.ts';
import { HttpAdapter } from '../../src/runtime/http.ts';
import { ClaudeCodeAdapter } from '../../src/runtime/claude-code.ts';
import { ContainerAdapter } from '../../src/runtime/container.ts';
import { CliAdapter, runtimeSpecsFrom } from '../../src/runtime/cli.ts';
import { KNOWN_CLI_NAMES, knownCli, knownClis } from '../../src/runtime/known-clis.ts';
import {
  RemoteSandboxAdapter,
  type SandboxProvider,
} from '../../src/runtime/sandbox-adapter.ts';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startToolBridge } from '../../src/runtime/tool-bridge.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const RUNTIME = new URL('../fixtures/runtimes/echo-runtime.mjs', import.meta.url).pathname;

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
  options: { attemptMax?: number } = {},
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
  assert.deepEqual(outcome.output, { ok: true });
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
    assert.deepEqual(seen.keys, ['PATH']);
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
      return { output: { model: request.modelRouting.primary } };
    },
  };

  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(attempts, ['test-model', 'test-model-b']);
  assert.deepEqual(outcome.output, { model: 'test-model-b' });
  assert.ok((await eventTypes(fixture.companyId, task.id)).includes('model.fell_back'));
});

/**
 * A role that can act irreversibly does not get a silent substitution.
 *
 * Tier 2 is where an action changes something outside the company and cannot
 * be undone. Running one on a model the owner did not choose, and did not
 * calibrate the role for, is exactly what the PRD's word *silently* forbids.
 */
test('a role holding a tier 2 tool halts instead of falling back (F13.6)', async () => {
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
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'halted');
  assert.deepEqual(attempts, ['test-model'], 'the fallback model was never tried');

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
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /was not moved/);
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
          : [{ type: 'done', output: { turns: turns.length } }];
      return new Response(JSON.stringify({ events }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
  });

  const task = await newTask(fixture, {});
  const outcome = await engineWith(broker, adapter).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(outcome.output, { turns: 2 });
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
    const list = await rpc(bridge, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (list as { result: { tools: Array<{ name: string }> } }).result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['dns.read']);

    const ok = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dns.read', arguments: { zone: 'example.com' } },
    });
    assert.equal((ok as { result: { isError: boolean } }).result.isError, false);
    assert.deepEqual(calls, [{ name: 'dns.read', input: { zone: 'example.com' } }]);

    // A tool outside the role's list is refused here, before the broker is
    // troubled with it -- and refused as an answer the runtime can read.
    const refused = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'dns.write', arguments: {} },
    });
    assert.equal((refused as { result: { isError: boolean } }).result.isError, true);
    assert.equal(calls.length, 1);
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
    { url: 'http://127.0.0.1:1/mcp', token: 'secret-token' },
  );

  const disallowed = argv[argv.indexOf('--disallowedTools') + 1]!.split(',');
  for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(disallowed.includes(tool), `${tool} must be disallowed`);
  }

  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'mcp__palugada__dns.read');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-x');

  const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!) as {
    mcpServers: { palugada: { url: string; headers: Record<string, string> } };
  };
  assert.equal(config.mcpServers.palugada.url, 'http://127.0.0.1:1/mcp');
  assert.equal(config.mcpServers.palugada.headers.Authorization, 'Bearer secret-token');
});

/* ---------------------------------------------------------------- cli --- */

const AGENT_CLI = new URL('../fixtures/runtimes/fake-agent-cli.mjs', import.meta.url).pathname;

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
      args: [AGENT_CLI, '--model', '{model}', '--mcp-config', '{mcpConfig}', '--call', 'dns.read'],
    },
  ]);

  const outcome = await engineWith(broker, new CliAdapter(spec!)).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  const output = outcome.output as { tool: { isError: boolean; text: string }; model: string };
  assert.equal(output.tool.isError, false, 'the capability was resolved by the broker');
  assert.deepEqual(JSON.parse(output.tool.text), { records: ['a.example.com'] });
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
    assert.deepEqual((outcome.output as { env: string[] }).env, ['HERMES_HOME', 'PATH']);
  } finally {
    delete process.env.PALUGADA_TEST_SENTINEL;
  }
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
    mcpConfig: '{"a":"b"}',
    mcpConfigFile: '',
    mcpUrl: 'http://127.0.0.1:1/mcp',
    mcpToken: 't',
    allowedTools: 'mcp__palugada__dns.read',
    prompt: 'p',
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
  assert.deepEqual(outcome.output, { ok: true });
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

    const argv = adapter.argv({
      model: 'a-model',
      maxTurns: '40',
      mcpConfig: '{"mcpServers":{}}',
      mcpConfigFile: '/tmp/mcp.json',
      mcpUrl: 'http://127.0.0.1:1/mcp',
      mcpToken: 'tok',
      allowedTools: 'mcp__palugada__dns.read',
      prompt: 'do the thing',
    });

    // No placeholder is left unsubstituted: one that was would reach the CLI
    // as the literal string `{model}`, and a CLI that accepted it would run
    // against a model nobody chose.
    assert.equal(argv.some((arg) => /\{[a-zA-Z]+\}/.test(arg)), false, spec.name);
    assert.ok(
      argv.some((arg) => arg.includes('/tmp/mcp.json') || arg.includes('mcpServers')),
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
    command: process.execPath,
    args: [AGENT_CLI, '--dialect', 'text', '--mcp-config-file', '{mcpConfigFile}', '--call', 'dns.read'],
  });

  const outcome = await engineWith(broker, new CliAdapter(spec)).runTask(
    fixture.companyId,
    task.id,
    'worker',
  );

  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.equal((outcome.output as { tool: { isError: boolean } }).tool.isError, false);
});
