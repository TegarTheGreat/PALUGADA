/**
 * PRD v2 F14 -- lifecycle hooks, and F3.12's insistence that a rule is code.
 *
 * Section 5 principle 12 draws the line: enforcement lives in hooks, knowledge
 * lives in skills, and a rule that must be obeyed may not live only in a
 * prompt. These tests are about the part of that claim a runtime could try to
 * falsify -- can it get past a hook, can a company remove one, can an added
 * hook widen anything, and does a refusal leave a record.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { HookPipeline, builtInHooks, type Hook } from '../../src/engine/hooks.ts';
import { redactor } from '../../src/secrets/manager.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { requestStopAll, clearStopAll } from '../../src/engine/control.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await clearStopAll();
  await closePools();
  await closeSetup();
});

/** A tier 0 read, so nothing but the hooks under test can refuse it. */
function readCapability() {
  const calls = { executions: 0 };
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async execute() {
      calls.executions += 1;
      return { records: ['a'] };
    },
  };
  return { capability, calls };
}

async function brokerWith(hooks?: HookPipeline) {
  const { capability, calls } = readCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  return { broker: new CapabilityBroker(registry, hooks), calls, registry };
}

/** Registering the capability precedes granting it: the grant is a foreign key. */
async function seed(fixture: Fixture) {
  await grantCapability(fixture, 'dns.read');
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    goalId: fixture.goalId,
    input: {},
    budgetAccountId: fixture.budgetAccountId,
    createdBy: 'owner',
  });
}

function invokeContext(fixture: Fixture, taskId: string) {
  return {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    taskId,
    roleId: fixture.roleId,
    idempotencyKey: `idem-${taskId}`,
  };
}

async function hookEvents(companyId: string, taskId: string) {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM events
        WHERE task_id = $1 AND type LIKE 'hook.%'
        ORDER BY occurred_at`,
      [taskId],
    );
    return rows;
  });
}

/**
 * F14.1: a runtime cannot get past a hook.
 *
 * The capability counts its own executions, so "refused" here means the
 * adapter was never reached -- not that its result was discarded afterwards.
 */
test('a hook refusal stops the call before the adapter is reached (F14.1)', async () => {
  const fixture = await createCompany('hook-gate');
  const hooks = new HookPipeline();
  hooks.add({
    name: 'test.refuse',
    on: 'pre_tool',
    async run() {
      return { allow: false, reason: 'this division may not read dns today' };
    },
  });

  const { broker, calls } = await brokerWith(hooks);
  const task = await seed(fixture);

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, task.id), 'dns.read', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'hook.denied'),
  );

  assert.equal(calls.executions, 0, 'the adapter must not have been called');
});

/**
 * F14.2, first half: a built-in hook is not something a company can take away.
 *
 * The guarantee is structural rather than a policy: the pipeline has no method
 * that removes a hook, so this test asserts the shape of the API as much as its
 * behaviour. If `remove` is ever added, this test is the thing that should have
 * to be deleted first.
 */
test('built-in hooks cannot be removed (F14.2)', async () => {
  const pipeline = new HookPipeline();

  assert.equal(
    'remove' in (pipeline as unknown as Record<string, unknown>),
    false,
    'the pipeline must expose no way to remove a hook',
  );

  const built = pipeline.hooksFor('pre_tool');
  for (const name of ['platform.stop', 'company.freeze', 'spend.guard']) {
    assert.ok(built.includes(name), `${name} must be a built-in pre_tool hook`);
    assert.equal(pipeline.isBuiltIn('pre_tool', name), true);
  }

  // Adding a hook of the same name shadows nothing: the built-in still runs,
  // and it runs first.
  pipeline.add({
    name: 'platform.stop',
    on: 'pre_tool',
    async run() {
      return { allow: true };
    },
  });
  const after = pipeline.hooksFor('pre_tool');
  assert.equal(after.filter((name) => name === 'platform.stop').length, 2);
  assert.equal(after[0], 'platform.stop', 'built-ins are consulted before additions');
});

/**
 * F14.2, second half: an added hook may only tighten.
 *
 * The platform stop is in effect, so the built-in refuses. An added hook that
 * says `allow` afterwards changes nothing -- and it is never even asked, because
 * the pipeline short-circuits on the first refusal.
 */
test('an added hook cannot re-permit what a built-in refused (F14.2)', async () => {
  const fixture = await createCompany('hook-tighten');
  let permissiveHookRan = false;
  const hooks = new HookPipeline();
  hooks.add({
    name: 'test.permit',
    on: 'pre_tool',
    async run() {
      permissiveHookRan = true;
      return { allow: true };
    },
  });

  const { broker, calls } = await brokerWith(hooks);
  const task = await seed(fixture);
  await requestStopAll();

  try {
    await assert.rejects(
      () => broker.invoke(invokeContext(fixture, task.id), 'dns.read', { zone: 'example.com' }),
      // The built-in keeps its own failure code: F14 must not cost the caller
      // the vocabulary the rest of the system branches on.
      (error: unknown) => isPalugadaError(error, 'platform.stopped'),
    );
  } finally {
    await clearStopAll();
  }

  assert.equal(calls.executions, 0);
  assert.equal(permissiveHookRan, false, 'nothing is consulted after a refusal');
});

/** F14.1: a hook that throws has refused. Breaking a gate is not a way past it. */
test('a hook that throws is read as a refusal (F14.1)', async () => {
  const fixture = await createCompany('hook-throws');
  const hooks = new HookPipeline();
  hooks.add({
    name: 'test.broken',
    on: 'pre_tool',
    async run(): Promise<never> {
      throw new Error('the hook could not reach its own configuration');
    },
  });

  const { broker, calls } = await brokerWith(hooks);
  const task = await seed(fixture);

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, task.id), 'dns.read', { zone: 'example.com' }),
    (error: unknown) =>
      isPalugadaError(error, 'hook.denied')
      && (error as Error).message.includes('could not reach its own configuration'),
  );
  assert.equal(calls.executions, 0);
});

/** F14.3: every refusal names the hook and says why. */
test('a refusal records an event with the decision and the reason (F14.3)', async () => {
  const fixture = await createCompany('hook-record');
  const hooks = new HookPipeline();
  hooks.add({
    name: 'test.refuse',
    on: 'pre_tool',
    async run() {
      return { allow: false, reason: 'the zone is frozen during a migration' };
    },
  });

  const { broker } = await brokerWith(hooks);
  const task = await seed(fixture);
  await assert.rejects(() =>
    broker.invoke(invokeContext(fixture, task.id), 'dns.read', { zone: 'example.com' }),
  );

  const events = await hookEvents(fixture.companyId, task.id);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event!.type, 'hook.pre_tool');
  assert.equal(event!.payload.hook, 'test.refuse');
  assert.equal(event!.payload.decision, 'deny');
  assert.equal(event!.payload.reason, 'the zone is frozen during a migration');
  assert.equal(event!.payload.capability, 'dns.read');
});

/**
 * An allow leaves no event of its own.
 *
 * Deliberate, and worth pinning: section 9 budgets a million events a month,
 * and one per hook per tool call would spend most of it recording that nothing
 * happened. The tool call's own event is the record that it ran.
 */
test('a permitted call writes no hook event', async () => {
  const fixture = await createCompany('hook-quiet');
  const { broker, calls } = await brokerWith();
  const task = await seed(fixture);
  await broker.invoke(invokeContext(fixture, task.id), 'dns.read', { zone: 'example.com' });

  assert.equal(calls.executions, 1);
  assert.deepEqual(await hookEvents(fixture.companyId, task.id), []);
});

/**
 * The built-in `post_tool` hook: a capability that returns a credential
 * verbatim is a defect, and the output stops here rather than travelling on
 * into a trace, an event payload or a model's context (section 12.4).
 */
test('the built-in post_tool hook refuses an output carrying a secret', async () => {
  const fixture = await createCompany('hook-secret');
  const token = `tok-${Math.random().toString(36).slice(2)}-abcdefgh`;
  redactor.register(token);

  const leaky: Capability<Record<string, never>, { body: string }> = {
    name: 'secret.echo',
    adapter: 'test:echo',
    defaultTier: 0,
    async execute() {
      return { body: `provider said: ${token}` };
    },
  };
  const registry = new CapabilityRegistry();
  registry.register(leaky);
  await registry.sync();
  const broker = new CapabilityBroker(registry);

  await grantCapability(fixture, 'secret.echo');
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    goalId: fixture.goalId,
    input: {},
    budgetAccountId: fixture.budgetAccountId,
    createdBy: 'owner',
  });

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, task.id), 'secret.echo', {}),
    (error: unknown) => isPalugadaError(error, 'hook.denied'),
  );

  // F14.3's record must not itself be the leak.
  const events = await hookEvents(fixture.companyId, task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.hook, 'secret.leak');
  assert.equal(
    JSON.stringify(events[0]!.payload).includes(token),
    false,
    'the refusal record must not repeat the secret it refused',
  );
});

/** The built-in set covers every point the PRD's table names. */
test('the built-in set covers the points section 8.14 names', () => {
  const pipeline = new HookPipeline(builtInHooks());
  assert.ok(pipeline.hooksFor('pre_run').length > 0);
  assert.ok(pipeline.hooksFor('pre_tool').length > 0);
  assert.ok(pipeline.hooksFor('post_tool').includes('secret.leak'));
  assert.ok(pipeline.hooksFor('post_run').includes('secret.leak'));
});

/**
 * The pipeline's own contract, tested without a broker: order, short-circuit,
 * and the list of who was consulted.
 */
test('the pipeline consults built-ins first and stops at the first refusal', async () => {
  const order: string[] = [];
  const record = (name: string, verdict: boolean): Hook => ({
    name,
    on: 'pre_run',
    async run() {
      order.push(name);
      return verdict ? { allow: true } : { allow: false, reason: `${name} says no` };
    },
  });

  const pipeline = new HookPipeline([record('built.first', true), record('built.second', false)]);
  pipeline.add(record('added.third', true));

  const fixture = await createCompany('hook-order');
  const outcome = await pipeline.run('pre_run', { companyId: fixture.companyId });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.refusedBy, 'built.second');
  assert.equal(outcome.reason, 'built.second says no');
  assert.deepEqual(order, ['built.first', 'built.second']);
  assert.deepEqual(outcome.consulted, ['built.first', 'built.second']);
});
