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
