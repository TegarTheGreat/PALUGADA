/**
 * What an operator and an owner can rely on when things go wrong (F5.12,
 * F5.14, F10.10, section 12).
 *
 * The reliability audit read the deployment as an operator would at 3am, and
 * found a worker whose failures went nowhere, a pool that took the process
 * down when Postgres restarted, an answer honoured after its deadline, an
 * approval that could carry an irreversible action twice across a crash, and
 * a task that could crash its worker for ever. These hold each of them.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { appPool, closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { reclaimExpiredLeases, reclaimOrphans, MAX_RECLAIMS } from '../../src/engine/checkout.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { Engine } from '../../src/engine/engine.ts';
import { Worker, type TickReport } from '../../src/worker.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerMfa, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { OtlpExporter, otlpFrom } from '../../src/reporting/otlp.ts';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let enrolments = 0;
async function approveWithFactor(fixture: Fixture, itemId: string): Promise<void> {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  enrolments += 1;
  const secretRef = `vault://owner/operability-${enrolments}`;
  secrets.set(secretRef, secret);
  const mfa = new OwnerMfa({ secrets });
  await mfa.enrolTotp({ label: 'owner phone', secretRef });
  await inbox.decide(fixture.companyId, itemId, 'approve', 'go ahead', {
    channel: 'app', proof: { totp: totpCode(decodeBase32(secret), stepFor(new Date())) }, mfa,
  });
}

async function newTask(fixture: Fixture) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'move the nameservers' }, createdBy: 'owner', reserveTokens: 10_000,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.nameservers' }]);
  return task;
}

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let waited = 0; waited < 5_000; waited += 20) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/* ------------------------------------------------------------ approvals --- */

test('an answer that arrives after the deadline is refused, and the work is cancelled as silence would have it', async () => {
  // The deadline is enforced by a sweep once a tick. Between the deadline and
  // the sweep the item still read `open`, and an approval given then was
  // honoured: the owner's silence had already said no, and a late yes
  // overturned it without anybody having been asked again.
  const fixture = await createCompany('late-answer');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'dns.nameservers', tier: 3,
    actionSummary: 'Point the nameservers at the new host', rationale: 'The migration asked for it.',
    consequenceIfDenied: 'The old host keeps serving.', ttlHours: 0,
  });

  await assert.rejects(approveWithFactor(fixture, itemId), (error: unknown) =>
    isPalugadaError(error, 'inbox.not_open') && /expired unanswered/.test((error as Error).message));
  const after = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.haltReason, 'approval_expired');
  const item = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; decision: string | null }>(
    'SELECT status, decision FROM inbox_items WHERE id = $1', [itemId]));
  assert.deepEqual(item.rows[0], { status: 'expired', decision: null }, 'no decision is recorded against it');
});

test('an approval is spent before the action, so a worker that dies mid-action asks again rather than repeating it', async () => {
  // It used to be spent after the vendor answered. A worker that died in
  // between left the approval unspent and the step unfinished; the next
  // worker resumed the step, found the yes still there, and did the
  // irreversible thing a second time.
  const fixture = await createCompany('approval-crash');
  const calls = { executions: 0 };
  const registry = new CapabilityRegistry();
  registry.register<{ zone: string }, { ok: boolean }>({
    name: 'dns.nameservers', adapter: 'test:registrar', defaultTier: 3,
    async execute() {
      calls.executions += 1;
      // The registrar acts, and this worker never hears back.
      if (calls.executions === 1) await new Promise(() => {});
      return { ok: true };
    },
    async verify() { return true; },
  });
  await registry.sync();
  await grantCapability(fixture, 'dns.nameservers');
  const broker = new CapabilityBroker(registry);
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const ctx = {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: task.id, idempotencyKey: 'the-nameserver-step',
  };

  await assert.rejects(broker.invoke(ctx, 'dns.nameservers', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'approval.required'));
  const [asked] = await inbox.listOpen(fixture.companyId);
  await approveWithFactor(fixture, asked!.id);
  await transition(fixture.companyId, task.id, 'running').catch(() => undefined);

  void broker.invoke(ctx, 'dns.nameservers', { zone: 'example.com' });
  await until(() => calls.executions === 1, 'the registrar to be called');

  // Another worker resumes the same step.
  await assert.rejects(broker.invoke(ctx, 'dns.nameservers', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'approval.required'));
  assert.equal(calls.executions, 1, 'one yes carried one attempt, and that attempt may have acted');
  const [again] = await inbox.listOpen(fixture.companyId);
  assert.ok(again, 'the owner is asked again');
  assert.match(again.rationale, /may already have happened/);
});

test('an approval the vendor failed on is given back, so a retry does not cost the owner a second decision', async () => {
  const fixture = await createCompany('approval-retry');
  const calls = { executions: 0 };
  const registry = new CapabilityRegistry();
  registry.register<{ zone: string }, { ok: boolean }>({
    name: 'dns.nameservers', adapter: 'test:registrar', defaultTier: 3,
    async execute() {
      calls.executions += 1;
      if (calls.executions === 1) throw new Error('registrar answered 503 before doing anything');
      return { ok: true };
    },
    async verify() { return true; },
  });
  await registry.sync();
  await grantCapability(fixture, 'dns.nameservers');
  const broker = new CapabilityBroker(registry);
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const ctx = {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: task.id, idempotencyKey: 'the-nameserver-step',
  };
  await assert.rejects(broker.invoke(ctx, 'dns.nameservers', { zone: 'example.com' }));
  const [asked] = await inbox.listOpen(fixture.companyId);
  await approveWithFactor(fixture, asked!.id);
  await transition(fixture.companyId, task.id, 'running').catch(() => undefined);

  await assert.rejects(broker.invoke(ctx, 'dns.nameservers', { zone: 'example.com' }), /503/);
  const { output } = await broker.invoke(ctx, 'dns.nameservers', { zone: 'example.com' });
  assert.deepEqual(output, { ok: true });
  assert.equal(calls.executions, 2);
  assert.deepEqual(await inbox.listOpen(fixture.companyId), []);
});

/* ------------------------------------------------------- crash loops --- */

test('a task that keeps losing its worker is halted and put in front of the owner (F5.14)', async () => {
  // A lease that runs out is a worker that died. The task goes back to the
  // queue with its journal, which is right once; a task whose work kills the
  // process went back for ever, taking the worker down each time, and nothing
  // counted.
  const fixture = await createCompany('crash-loop');
  const task = await newTask(fixture);
  const expire = async () => {
    await withTenant(fixture.companyId, (tx) => tx.query(
      `UPDATE tasks SET status = 'running', lease_holder = 'dead-worker', lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`, [task.id]));
    return reclaimExpiredLeases(fixture.companyId);
  };
  // A run that stopped reporting counts the same as a lease that ran out.
  const orphan = async () => {
    await withTenant(fixture.companyId, async (tx) => {
      await tx.query("UPDATE tasks SET status = 'running', lease_holder = NULL, lease_expires_at = NULL WHERE id = $1", [task.id]);
      await tx.query(
        `INSERT INTO agent_runs (company_id, task_id, role_id, attempt, status, started_at)
         VALUES ($1, $2, $3, (SELECT coalesce(max(attempt), 0) + 1 FROM agent_runs WHERE task_id = $2), 'running',
                 now() - interval '3 hours')`,
        [fixture.companyId, task.id, fixture.roleId]);
    });
    return reclaimOrphans(fixture.companyId);
  };
  for (let n = 1; n < MAX_RECLAIMS; n += 1) {
    await expire();
    assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'pending', `lost ${n} times`);
  }
  assert.equal((await orphan()).length, 1, 'and the last time, its run simply stopped reporting');
  const halted = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.equal(halted.status, 'halted');
  assert.equal(halted.haltReason, 'crash_loop');
  const incidents = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident');
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.rationale, new RegExp(`lost its worker ${MAX_RECLAIMS} times`));
});

/* ------------------------------------------------------- the database --- */

test('the pool survives Postgres dropping its connections, and bounds a statement', async () => {
  // pg-pool emits `error` when an idle connection is killed, and an emitter
  // with no listener throws -- so a Postgres restart took the whole process
  // down, past the worker's own sleep-and-retry.
  const pool = appPool();
  // Two connections held idle, so ending one from the other leaves the pool
  // holding a dead one -- which is what a Postgres restart does to all of them.
  await Promise.all([pool.query('SELECT pg_sleep(0.05)'), pool.query('SELECT pg_sleep(0.05)')]);
  const { rows: settings } = await pool.query<{ statement_timeout: string; idle: string }>(
    "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('idle_in_transaction_session_timeout') AS idle");
  assert.equal(settings[0]!.statement_timeout, '2min', 'a statement that runs away is stopped');
  assert.equal(settings[0]!.idle, '10min', 'a transaction left open is closed');

  const { rows: ended } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE usename = 'palugada_app' AND pid <> pg_backend_pid()) ended`);
  assert.ok(ended[0]!.n >= 1, 'an idle connection was ended under the pool');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { rows } = await pool.query<{ one: number }>('SELECT 1 AS one');
  assert.equal(rows[0]!.one, 1, 'and the next query gets a fresh connection');
});

/* ----------------------------------------------------------- the worker --- */

test('a worker says what failed, in lines a log collector can read', async () => {
  const fixture = await createCompany('worker-logs');
  const lines: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const worker = new Worker({
    engine: new Engine({
      broker: new CapabilityBroker(new CapabilityRegistry()),
      llm: new RecordingLlmClient(),
      handlers: new Map([['worker', async () => ({ done: true })]]),
      workerId: 'logging-worker',
    }),
    companyId: fixture.companyId,
    idleMs: 20,
    signal: controller.signal,
    log: (entry) => lines.push(entry),
  });
  const realTick = worker.tick.bind(worker);
  let ticks = 0;
  worker.tick = async (now?: Date): Promise<TickReport> => {
    ticks += 1;
    if (ticks === 1) throw new Error('the database went away');
    const report = await realTick(now);
    if (ticks === 2) report.errors.push({ stage: 'notify', message: 'the push relay answered 502' });
    return report;
  };
  const running = worker.start();
  await until(() => ticks > 3, 'a few ticks');
  controller.abort();
  await running;

  assert.ok(lines.some((line) => line.level === 'error' && line.event === 'tick.failed'
    && /database went away/.test(String(line.message))), JSON.stringify(lines));
  assert.ok(lines.some((line) => line.level === 'error' && line.event === 'stage.failed'
    && line.stage === 'notify' && /502/.test(String(line.message))), JSON.stringify(lines));
  assert.ok(worker.lastTickAt !== null && Date.now() - worker.lastTickAt.getTime() < 5_000,
    'and when it last finished a tick, for a readiness check');
});

/**
 * A deployment a test boots with no state directory keeps its state -- the
 * charters repository, a master key -- in its home. The suite gives it a
 * home of its own: tests wrote into the home of whoever ran them, and a
 * real deployment on the same machine shared what they left.
 */
test('a deployment a test boots keeps its state out of the home of whoever runs the suite', async () => {
  assert.ok(homedir().startsWith(tmpdir()), `the suite's home is ${homedir()}`);
  const { start } = await import('../../src/main.ts');
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 60_000 } });
  try {
    assert.ok((await stat(join(homedir(), '.palugada', 'charters'))).isDirectory());
  } finally {
    await deployment.stop();
  }
});

test('a deployment answers whether it can work, without a session', async () => {
  const { start } = await import('../../src/main.ts');
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 20 } });
  try {
    await until(() => deployment.worker.lastTickAt !== null, 'the first tick');
    const answer = await fetch(`${deployment.url}/api/health`);
    assert.equal(answer.status, 200);
    const body = await answer.json() as { ok: boolean; database: string; version: string; worker: { lastTickAt: string | null } };
    assert.equal(body.ok, true);
    assert.equal(body.database, 'ok');
    const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(body.version, version, 'which version answers, for whoever is upgrading');
    assert.ok(body.worker.lastTickAt);
  } finally {
    await deployment.stop();
  }
});

/**
 * The health page measured a stalled loop from its last finished tick, and a
 * worker that had never finished one had none to measure from: a first tick
 * that hung, or that failed every time while `SELECT 1` worked, was reported
 * able to work for as long as the process lived.
 */
test('a worker that has never finished a tick is reported unable to work once the stall window has passed', async () => {
  const { workerHealth } = await import('../../src/main.ts');
  const controller = new AbortController();
  const worker = new Worker({
    engine: new Engine({
      broker: new CapabilityBroker(new CapabilityRegistry()),
      llm: new RecordingLlmClient(),
      handlers: new Map([['worker', async () => ({ done: true })]]),
      workerId: 'never-ticked',
    }),
    idleMs: 20,
    signal: controller.signal,
    log: () => undefined,
  });
  let ticks = 0;
  worker.tick = async (): Promise<TickReport> => {
    ticks += 1;
    throw new Error('the database went away');
  };
  const running = worker.start();
  try {
    await until(() => ticks > 2, 'a few ticks, each of them failed');
    assert.equal(worker.lastTickAt, null);
    const started = worker.startedAt;
    assert.ok(started, 'when it started, to measure from');
    assert.deepEqual(workerHealth(worker, started.getTime() + 60_000), { ok: true, lastTickAt: null },
      'a minute in, it may still be on its first tick');
    assert.deepEqual(workerHealth(worker, started.getTime() + 31 * 60_000), {
      ok: false,
      lastTickAt: null,
      problem: `no tick has finished since the worker started at ${started.toISOString()}`,
    });

    // And one that ticked measures from its last tick, as before.
    const ticked = { startedAt: started, lastTickAt: new Date(started.getTime() + 10 * 60_000) };
    assert.equal(workerHealth(ticked, started.getTime() + 31 * 60_000).ok, true);
    assert.deepEqual(workerHealth(ticked, started.getTime() + 41 * 60_000), {
      ok: false,
      lastTickAt: ticked.lastTickAt.toISOString(),
      problem: `no tick has finished since ${ticked.lastTickAt.toISOString()}`,
    });
  } finally {
    controller.abort();
    await running;
  }
});

/**
 * `/api/health` is open, for a supervisor, and it answered with the
 * database driver's own words -- a host, a port, a role's name, why its
 * password was refused -- to anyone who asked. Those go to the log, which
 * the operator reads; the page says the database could not be reached.
 */
test('why the database could not be reached goes to the log, not to whoever asks', async () => {
  const { databaseHealth } = await import('../../src/main.ts');
  const logged: Array<Record<string, unknown>> = [];
  const said = await databaseHealth(async () => {
    throw new Error('password authentication failed for user "palugada_app" at 10.0.4.7:5432');
  }, (entry) => logged.push(entry));
  assert.equal(said, 'unreachable');
  assert.deepEqual(logged.map((entry) => [entry.stage, entry.message]),
    [['health', 'password authentication failed for user "palugada_app" at 10.0.4.7:5432']]);
  assert.equal(await databaseHealth(async () => ({ rows: [] }), () => assert.fail('nothing to log')), 'ok');
});

test('a process that cannot work says so to whatever asks, with a 503', async () => {
  const { OwnerApi } = await import('../../src/owner/api.ts');
  const api = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager() }),
    health: async () => ({ ok: false, database: 'connection refused' }),
  });
  const { url } = await api.listen();
  try {
    const answer = await fetch(`${url}/api/health`);
    assert.equal(answer.status, 503);
    assert.deepEqual(await answer.json(), { ok: false, database: 'connection refused' });
  } finally {
    await api.close();
  }
});

/**
 * Found by reading Buzz. A process told to stop closed its listener at once:
 * a load balancer that asked every few seconds went on sending requests into
 * a port that refused them until it next asked. Readiness now says no the
 * moment the stop begins, the console keeps answering while the balancer
 * notices, and only then does the listener close.
 */
test('a deployment being stopped says it is not ready at once, answers while a load balancer notices, then closes', async () => {
  const { start } = await import('../../src/main.ts');
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 60_000 }, drainMs: 800, log: () => undefined });
  let stopped: Promise<void> | null = null;
  try {
    const ready = await fetch(`${deployment.url}/api/ready`);
    assert.equal(ready.status, 200);
    const said = await ready.json() as { ok: boolean; stopping: boolean; database: string; version: string };
    assert.deepEqual([said.ok, said.stopping, said.database, said.version], [true, false, 'ok', version],
      'what /api/health says, and that it is not stopping');

    const began = Date.now();
    stopped = deployment.stop();
    const draining = await fetch(`${deployment.url}/api/ready`);
    assert.equal(draining.status, 503, 'not ready from the moment the stop begins');
    assert.deepEqual(await draining.json(), { ok: false, stopping: true, version });
    assert.equal(draining.headers.get('connection'), 'close', 'and a kept-alive connection is let go, to be made again elsewhere');
    const health = await fetch(`${deployment.url}/api/health`);
    assert.equal(health.status, 200, 'liveness is unchanged: the process is still working');
    assert.equal(health.headers.get('connection'), 'close');

    await stopped;
    assert.ok(Date.now() - began >= 700, `the listener stayed open for the drain, and closed after ${Date.now() - began} ms`);
    await assert.rejects(fetch(`${deployment.url}/api/ready`), 'and then it is closed');
  } finally {
    await (stopped ?? deployment.stop());
  }

  // A deployment nobody asked whether it was ready has no balancer to tell,
  // and stops without waiting for one.
  const unwatched = await start({ port: 0, env: {}, worker: { idleMs: 60_000 }, drainMs: 20_000, log: () => undefined });
  const quick = Date.now();
  await unwatched.stop();
  assert.ok(Date.now() - quick < 5_000, `stopped in ${Date.now() - quick} ms`);
});

test('a console being closed answers the requests it already has, and refuses new ones', async () => {
  const { OwnerApi } = await import('../../src/owner/api.ts');
  const held: { answer: (() => void) | null } = { answer: null };
  const api = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager() }),
    health: () => new Promise((resolve) => { held.answer = () => resolve({ ok: true }); }),
  });
  const { url } = await api.listen();
  const inFlight = fetch(`${url}/api/health`);
  await until(() => held.answer !== null, 'the request to arrive');
  const closed = api.close(5_000);
  await assert.rejects(fetch(`${url}/api/health`), 'a new connection is refused');
  held.answer!();
  const answered = await inFlight;
  assert.equal(answered.status, 200, 'the request in flight is answered rather than cut');
  assert.equal(answered.headers.get('connection'), 'close');
  await closed;
});

/**
 * Found by reading Buzz, which samples its database for health every thirty
 * seconds. Every unauthenticated `/api/health` ran `SELECT 1` on the shared
 * application pool, so a flood of probes -- a balancer, a monitor, anyone --
 * cost a pool slot each, and a database that hung held every probe, and the
 * slots with them, until the checker gave up.
 */
test('a flood of health and readiness probes costs the database one query, and a database that does not answer is said to within seconds', async () => {
  const { start } = await import('../../src/main.ts');
  const pool = appPool();
  const query = pool.query;
  let probes = 0;
  let hang = false;
  pool.query = function probeCounting(this: typeof pool, ...args: unknown[]) {
    const [asked] = args;
    const text = typeof asked === 'string' ? asked : (asked as { text?: string } | undefined)?.text;
    if (text === 'SELECT 1') {
      probes += 1;
      if (hang) return new Promise(() => {});
    }
    return (query as (...given: unknown[]) => unknown).apply(this, args);
  } as unknown as typeof pool.query;
  const lines: Array<Record<string, unknown>> = [];
  const log = (entry: Record<string, unknown>) => { lines.push(entry); };
  try {
    const deployment = await start({ port: 0, env: {}, worker: { idleMs: 60_000 }, drainMs: 0, log });
    try {
      const flood = await Promise.all(Array.from({ length: 40 }, (_, n) =>
        fetch(`${deployment.url}/api/${n % 4 === 0 ? 'ready' : 'health'}`)));
      assert.deepEqual([...new Set(flood.map((answer) => answer.status))], [200]);
      assert.equal(probes, 1, 'forty probes at once, one query');
      const again = await Promise.all(Array.from({ length: 20 }, () => fetch(`${deployment.url}/api/health`)));
      assert.deepEqual([...new Set(again.map((answer) => answer.status))], [200]);
      assert.equal(probes, 1, 'and the next twenty within the window are told the same sample');
    } finally {
      await deployment.stop();
    }

    hang = true;
    probes = 0;
    const stuck = await start({ port: 0, env: {}, worker: { idleMs: 60_000 }, drainMs: 0, log });
    try {
      const asked = Date.now();
      const answer = await fetch(`${stuck.url}/api/health`);
      assert.ok(Date.now() - asked < 4_000, `answered in ${Date.now() - asked} ms, inside the image's five-second check`);
      assert.equal(answer.status, 503);
      assert.equal(((await answer.json()) as { database: string }).database, 'unreachable');
      assert.ok(lines.some((line) => line.stage === 'health' && /did not answer within/.test(String(line.message))),
        JSON.stringify(lines));
      const more = await Promise.all(Array.from({ length: 10 }, () => fetch(`${stuck.url}/api/ready`)));
      assert.deepEqual([...new Set(more.map((reply) => reply.status))], [503]);
      assert.equal(probes, 1, 'a probe still waiting is not joined by another');
    } finally {
      await stuck.stop();
    }
  } finally {
    pool.query = query;
  }
});

test('the database is sampled once a window however many ask, and never twice at once', async () => {
  const { databaseSample } = await import('../../src/main.ts');
  let clock = 1_000_000;
  let probes = 0;
  const quiet = () => assert.fail('nothing to log');
  const sample = databaseSample(async () => { probes += 1; }, quiet, { everyMs: 5_000, withinMs: 1_000, now: () => clock });
  assert.deepEqual([...new Set(await Promise.all(Array.from({ length: 25 }, () => sample())))], ['ok']);
  assert.equal(probes, 1);
  clock += 4_999;
  await sample();
  assert.equal(probes, 1, 'the same sample until the window is over');
  clock += 1;
  await sample();
  assert.equal(probes, 2, 'and a new one after');

  // A probe past its deadline is said to be unreachable, is not asked again
  // beside itself, and is asked again once it has finished.
  const logged: Array<Record<string, unknown>> = [];
  const held: { finish: (() => void) | null } = { finish: null };
  let slowProbes = 0;
  const slow = databaseSample(() => {
    slowProbes += 1;
    if (slowProbes > 1) return Promise.resolve();
    return new Promise<void>((resolve) => { held.finish = resolve; });
  }, (entry) => { logged.push(entry); }, { everyMs: 5_000, withinMs: 30, now: () => clock });
  assert.equal(await slow(), 'unreachable');
  assert.match(String(logged[0]?.message), /did not answer within 30 ms/);
  clock += 5_000;
  assert.equal(await slow(), 'unreachable');
  assert.equal(slowProbes, 1, 'still waiting on the first');
  held.finish!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await slow(), 'ok');
  assert.equal(slowProbes, 2);
});

/* --------------------------------------------------------------- metrics --- */

const SCRAPE_TOKEN = 'metrics-token-for-the-operability-suite-0123456789';

test('a worker clears what dead workers left running, once a minute, and never a live worker\'s', async () => {
  const fixture = await createCompany('leftovers');
  const asked: Array<string[]> = [];
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'leaves-things', backends: ['docker'],
    health: async () => ({ ok: true }),
    run: async () => { throw new Error('not run here'); },
    sweep: async (alive: ReadonlySet<string>) => { asked.push([...alive].sort()); return ['palugada-run-left']; },
  });
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()), adapters, workerId: 'worker-me',
  });
  await withControlPlane(async (tx) => {
    await tx.query("INSERT INTO worker_heartbeats (worker_id) VALUES ('worker-alive')");
    await tx.query("INSERT INTO worker_heartbeats (worker_id, beat_at) VALUES ('worker-dead', now() - interval '5 minutes')");
  });
  const worker = new Worker({ engine, companyId: fixture.companyId });
  const now = new Date();
  const first = await worker.tick(now);
  assert.equal(first.leftovers, 1);
  assert.deepEqual(asked, [['worker-alive', 'worker-me']], 'alive is what beat lately, and this worker');
  await worker.tick(new Date(now.getTime() + 10_000));
  assert.equal(asked.length, 1, 'not every tick: listing containers is a call to the daemon');
  await worker.tick(new Date(now.getTime() + 61_000));
  assert.equal(asked.length, 2);
});

test('a metrics scrape counts each company\'s live work, what waits for the owner and what it spent, and what the worker ran', async () => {
  // An operator had /api/health, which says whether the process can work,
  // and the console, which is the owner's. Nothing showed a queue growing
  // behind one role, or a company's spend climbing toward its ceiling, to
  // the graphs and alerts an operator already has.
  const { metricsText } = await import('../../src/reporting/metrics.ts');
  const fixture = await createCompany('metrics');
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async () => ({ done: true })]]),
    workerId: 'metrics-worker',
  });
  const worker = new Worker({ engine, companyId: fixture.companyId, concurrency: 3 });
  const task = (n: number) => createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { n }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await task(0);
  const ran = await worker.tick();
  assert.deepEqual(ran.ran.map((run) => run.status), ['completed']);
  await task(1);
  await task(2);
  await inbox.raiseIncident({ companyId: fixture.companyId, title: 'the CRM is down', detail: 'it answers 503' });
  await withControlPlane((tx) => tx.query(
    'UPDATE budget_accounts SET money_spent_cents = 1234 WHERE id = $1', [fixture.budgetAccountId],
  ));

  const text = await metricsText({ worker });
  const company = `company="${fixture.slug}"`;
  const has = (line: string) => assert.ok(text.split('\n').includes(line), `${line}\n---\n${text}`);
  has(`palugada_tasks{${company},status="pending"} 2`);
  assert.doesNotMatch(text, /palugada_tasks\{[^}]*status="completed"/, 'finished work is history, not load');
  has(`palugada_inbox_open{${company},kind="incident"} 1`);
  has(`palugada_budget_spent_cents{${company}} 1234`);
  has(`palugada_budget_limit_cents{${company}} 100000`);
  has('palugada_worker_runs_total{status="completed"} 1');
  has('palugada_worker_places 3');
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  has(`palugada_build_info{version="${version}"} 1`);
  has('palugada_worker_places_busy 0');
  has('palugada_platform_stopped 0');
  assert.match(text, new RegExp(`^palugada_tasks_pending_oldest_age_seconds\\{${company}\\} \\d`, 'm'));
  assert.match(text, /^process_resident_memory_bytes \d+$/m);
  assert.match(text, /^palugada_database_connections\{pool="app",state="idle"\} \d+$/m);

  // The format a scraper reads: every sample under a family it was told the
  // type of, and nothing it cannot parse.
  const typed = new Set<string>();
  for (const line of text.trimEnd().split('\n')) {
    const declared = /^# TYPE (\S+) (gauge|counter)$/.exec(line);
    if (declared) {
      typed.add(declared[1]!);
      continue;
    }
    if (line.startsWith('# HELP ')) continue;
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[a-z_]+="(?:[^"\\]|\\.)*"(?:,[a-z_]+="(?:[^"\\]|\\.)*")*\})? (-?[0-9.e+-]+|NaN)$/.exec(line);
    assert.ok(sample, `a line a scraper cannot read: ${line}`);
    assert.ok(typed.has(sample[1]!), `${sample[1]} has no TYPE line before its samples`);
  }
});

test('the metrics are served to the holder of their token and to nobody else, and are off until one is set', async () => {
  const { OwnerApi } = await import('../../src/owner/api.ts');
  const mfa = new OwnerMfa({ secrets: new InMemorySecretManager() });
  const off = new OwnerApi({ mfa });
  const on = new OwnerApi({ mfa, metrics: { token: SCRAPE_TOKEN, text: async () => 'palugada_up 1\n' } });
  const { url: offUrl } = await off.listen();
  const { url } = await on.listen();
  try {
    const refused = await fetch(`${offUrl}/api/metrics`, { headers: { authorization: `Bearer ${SCRAPE_TOKEN}` } });
    assert.equal(refused.status, 404);
    assert.match(((await refused.json()) as { error: string }).error, /metrics are off: set PALUGADA_METRICS_TOKEN/);

    assert.equal((await fetch(`${url}/api/metrics`)).status, 401);
    const wrong = await fetch(`${url}/api/metrics`, { headers: { authorization: `Bearer ${SCRAPE_TOKEN}x` } });
    assert.equal(wrong.status, 401);
    assert.doesNotMatch(await wrong.text(), /palugada_up/);

    const answer = await fetch(`${url}/api/metrics`, { headers: { authorization: `Bearer ${SCRAPE_TOKEN}` } });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    assert.equal(await answer.text(), 'palugada_up 1\n');
  } finally {
    await off.close();
    await on.close();
  }
});

test('a deployment given a metrics token serves its worker and its database to a scraper, and refuses a token short enough to guess', async () => {
  const { start } = await import('../../src/main.ts');
  await assert.rejects(
    start({ port: 0, env: { PALUGADA_METRICS_TOKEN: 'hunter2' }, worker: { idleMs: 60_000 } }),
    /PALUGADA_METRICS_TOKEN is 7 characters; it is a secret of at least 32/,
  );
  const deployment = await start({ port: 0, env: { PALUGADA_METRICS_TOKEN: SCRAPE_TOKEN }, worker: { idleMs: 20 } });
  try {
    await until(() => deployment.worker.lastTickAt !== null, 'the first tick');
    const answer = await fetch(`${deployment.url}/api/metrics`, { headers: { authorization: `Bearer ${SCRAPE_TOKEN}` } });
    assert.equal(answer.status, 200);
    const text = await answer.text();
    assert.match(text, /^palugada_workers_alive [1-9]\d*$/m, 'the worker said it is alive');
    assert.match(text, /^palugada_worker_places 4$/m, 'four places unless the operator says otherwise');
    assert.match(text, /^palugada_worker_last_tick_timestamp_seconds [1-9][0-9.]+$/m);
  } finally {
    await deployment.stop();
  }
});

test('a role\'s runs are stopped at the length the owner set for them, and the task halts for the owner (#102)', async () => {
  // A run that keeps going was bounded only by the task's deadline, and most
  // tasks have none: an agent CLI working for an hour on a ten-minute job
  // spent an hour of tokens before anything looked at the clock. The owner
  // now says how long a role's runs may take.
  const { applyRoleChange } = await import('../../src/governance/structure.ts');
  const fixture = await createCompany('run-ceiling');
  await applyRoleChange(fixture.companyId, fixture.roleId, { maxRunSeconds: 1 }, { ownerApproved: true });
  const task = await newTask(fixture);
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', () => new Promise<Record<string, unknown>>(() => {})]]),
    workerId: 'ceiling-worker',
  });
  const started = Date.now();
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.ok(Date.now() - started < 5_000, 'stopped at its length, not at the lease');
  // Like a run that outgrew its token ceiling, it would outgrow its length
  // again: halted for the owner, with the reason in words, rather than
  // retried into the same wall.
  assert.equal(outcome.status, 'halted');
  assert.equal(outcome.reason, 'run_limit');
  const after = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.equal(after.haltReason, 'run_limit');
  const halted = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { detail?: string } }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'task.halted'", [task.id]));
  assert.match(halted.rows[0]?.payload.detail ?? '',
    /ran longer than the 1 second this role's runs may take, and was stopped; what it committed is kept/);

  // Changed back by the owner, and kept in the role's history like any change.
  await applyRoleChange(fixture.companyId, fixture.roleId, { maxRunSeconds: null }, { ownerApproved: true });
  const versions = await withTenant(fixture.companyId, (tx) => tx.query<{ snapshot: { maxRunSeconds?: number | null } }>(
    "SELECT snapshot FROM config_versions WHERE kind = 'role' AND subject_id = $1 ORDER BY version", [fixture.roleId]));
  assert.deepEqual(versions.rows.map((row) => row.snapshot.maxRunSeconds), [null, 1]);
});

test('a run that shows no progress for a whole lease is stopped while its worker still holds it, and the task goes back', async () => {
  // The keeper stopped renewing a silent run's lease and said nothing: the
  // run carried on, the lease lapsed, and the next worker ran the task beside
  // it. And a handler stuck on a promise that never settles held the worker,
  // and every other company's sweeps with it, for as long as the process ran.
  const fixture = await createCompany('silent-run');
  const task = await newTask(fixture);
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', () => new Promise<Record<string, unknown>>(() => {})]]),
    workerId: 'silent-worker',
    leaseMs: 300,
  });
  const started = Date.now();
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.ok(Date.now() - started < 5_000, 'the worker is free again');
  assert.equal(outcome.status, 'not_claimed');
  assert.match(outcome.reason ?? '', /showed no progress for 300 ms and was stopped before its lease ran out/);
  const after = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.equal(after.status, 'pending');
  assert.equal(after.leaseHolder, null, 'and nobody holds it, so the next worker may');
  assert.equal(after.attempt, 0, 'the work did not fail; it stopped moving');

  // Counted as a lost worker: a task that goes quiet every time is halted
  // like one that crashes every time.
  for (let n = 1; n < MAX_RECLAIMS; n += 1) await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.haltReason, 'crash_loop');
});

test('a deployment being stopped lets a run finish, then gives back the one that cannot, counted against nothing', async () => {
  // A run still going when the process was told to stop was cut off by the
  // supervisor's kill a minute later; its lease lapsed and the reclaim
  // counted towards crash_loop, so three upgrades during one long task
  // halted it.
  const { start } = await import('../../src/main.ts');
  const fixture = await createCompany('stopped-mid-run');
  const task = await newTask(fixture);
  let calls = 0;
  const deployment = await start({
    port: 0,
    env: {},
    llm: new RecordingLlmClient(),
    // The first run commits a step and then waits on nothing but its signal;
    // the second finds that step in its journal and finishes.
    handlers: new Map([['worker', async (ctx) => {
      calls += 1;
      const first = await ctx.step('look', 'tool', { n: 1 }, async () => ({ looked: calls }));
      if (calls === 1) await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      return { done: true, first };
    }]]),
    worker: { idleMs: 20 },
    stopGraceMs: 200,
    log: () => undefined,
  });
  await until(async () => calls === 1, 'the run to start');
  const stopping = Date.now();
  await deployment.stop();
  assert.ok(Date.now() - stopping < 5_000, 'stopped within its grace, not at the supervisor\'s kill');

  const after = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.equal(after.status, 'pending', 'back on the queue at once');
  assert.equal(after.leaseHolder, null);
  assert.equal(after.attempt, 0, 'nothing failed');
  const events = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ type: string }>(
    'SELECT type FROM events WHERE task_id = $1 ORDER BY occurred_at', [task.id])).rows.map((row) => row.type));
  assert.ok(events.includes('task.handed_back'), events.join(', '));
  assert.ok(!events.includes('task.lease_expired'), 'not a lost worker, so not a step towards crash_loop');

  // The next worker resumes at the step it reached, rather than repeating it.
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      calls += 1;
      const first = await ctx.step('look', 'tool', { n: 1 }, async () => ({ looked: calls }));
      return { done: true, first };
    }]]),
  });
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(outcome.output, { done: true, first: { looked: 1 } }, 'the committed step was replayed, not run again');
});

/* ---------------------------------------------------------------- traces --- */

/** An OpenTelemetry collector's HTTP port, as far as a test needs one. */
async function fakeCollector() {
  const received: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let failing = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      if (failing) { res.writeHead(503); res.end('busy'); return; }
      received.push({ path: req.url ?? '', headers: req.headers, body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`, received,
    fail: (on: boolean) => { failing = on; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the standard variables name the collector, and a protocol other than http/json is refused by name', () => {
  assert.equal(otlpFrom({}), null, 'nothing set, nothing sent');
  assert.deepEqual(otlpFrom({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=key%20one,Authorization=Bearer abc',
    OTEL_SERVICE_NAME: 'palugada-prod',
  }), {
    endpoint: 'http://collector:4318/v1/traces',
    headers: { 'x-honeycomb-team': 'key one', authorization: 'Bearer abc' },
    serviceName: 'palugada-prod',
  });
  assert.equal(otlpFrom({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://api.honeycomb.io/v1/traces' })!.endpoint,
    'https://api.honeycomb.io/v1/traces', 'the traces endpoint as it is given');
  assert.throws(() => otlpFrom({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }),
    (error: unknown) => isPalugadaError(error, 'config.invalid') && /grpc/.test((error as Error).message));
});

test('a deployment given a collector says where its traces go, and refuses a protocol it does not speak before it starts', async () => {
  const { start } = await import('../../src/main.ts');
  const deployment = await start({
    port: 0, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/' }, worker: { idleMs: 60_000 }, log: () => undefined,
  });
  try {
    assert.ok(deployment.notes.some((note) => note.includes('http://127.0.0.1:9/v1/traces') && /without what was said/.test(note)),
      JSON.stringify(deployment.notes));
  } finally {
    await deployment.stop();
  }
  await assert.rejects(start({ port: 0, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' } }),
    (error: unknown) => isPalugadaError(error, 'config.invalid') && /http\/protobuf/.test((error as Error).message));
});

test('each finished run goes to an OpenTelemetry collector as spans -- the run, its steps, its model calls -- and nothing that was said', async () => {
  const fixture = await createCompany('otlp');
  const registry = new CapabilityRegistry();
  registry.register<{ text: string }, { kept: number }>({
    name: 'notes.keep', adapter: 'test:notes', defaultTier: 0,
    async execute(input) { return { kept: input.text.length }; },
  });
  await registry.sync();
  await grantCapability(fixture, 'notes.keep');
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(() => 'Kopi Garut, 3 kg, Rp 450.000'),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability('notes.keep', { text: 'Budi Santoso, 0812-555-0199' });
      await ctx.llm({ system: 'You price orders.', messages: [{ role: 'user', content: 'Budi Santoso wants 3 kg' }] });
      return { summary: 'priced' };
    }]]),
  });
  const run = async (goal: string) => {
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
    });
    assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
    return task;
  };
  const collector = await fakeCollector();
  try {
    const first = await run('price the Garut order');
    const exporter = new OtlpExporter({
      endpoint: `${collector.base}/v1/traces`, headers: { 'x-honeycomb-team': 'team-key' }, serviceName: 'palugada-test',
      holder: 'worker-otlp', settleMs: 0, version: '0.1.0',
    });
    const sent = await exporter.export();
    assert.equal(collector.received.length, 1);
    const [request] = collector.received;
    assert.equal(request!.path, '/v1/traces');
    assert.equal(request!.headers['x-honeycomb-team'], 'team-key');
    assert.equal(request!.headers['content-type'], 'application/json');
    assert.doesNotMatch(request!.body, /Budi|Garut|Kopi|price/, 'names, times and counts; never what was said or asked');
    const payload = JSON.parse(request!.body) as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
          attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>; status: { code: number } }> }> }>;
    };
    const resource = payload.resourceSpans[0]!;
    assert.equal(resource.resource.attributes.find((one) => one.key === 'service.name')!.value.stringValue, 'palugada-test');
    const spans = resource.scopeSpans[0]!.spans;
    assert.equal(sent, spans.length);
    const root = spans.find((span) => span.name === 'run worker')!;
    assert.ok(root, JSON.stringify(spans.map((span) => span.name)));
    assert.equal(root.traceId, first.id.replace(/-/g, ''), 'one trace per task');
    assert.match(root.spanId, /^[0-9a-f]{16}$/);
    assert.equal(root.status.code, 1);
    const step = spans.find((span) => span.name === 'capability:notes.keep')!;
    assert.equal(step.parentSpanId, root.spanId);
    const call = spans.find((span) => span.name.startsWith('chat '))!;
    assert.equal(call.parentSpanId, root.spanId);
    assert.equal(call.kind, 3);
    const attribute = (name: string) => call.attributes.find((one) => one.key === name)!.value;
    assert.equal(attribute('gen_ai.usage.input_tokens').intValue, '100');
    assert.equal(attribute('gen_ai.usage.output_tokens').intValue, '50');

    assert.equal(await exporter.export(), 0, 'sent once');
    assert.equal(collector.received.length, 1);

    // A collector that is down: nothing is lost, it is sent when it is back.
    const second = await run('price the Bandung order');
    collector.fail(true);
    await assert.rejects(exporter.export(), /answered 503/);
    collector.fail(false);
    assert.ok(await exporter.export() > 0);
    const resent = JSON.parse(collector.received.at(-1)!.body) as typeof payload;
    assert.deepEqual([...new Set(resent.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => span.traceId))], [second.id.replace(/-/g, '')]);

    // Another replica, while this one holds the cursor, sends nothing.
    await withControlPlane((tx) => tx.query("UPDATE telemetry_cursor SET holder = 'worker-otlp', held_until = now() + interval '1 minute'"));
    const other = new OtlpExporter({ endpoint: `${collector.base}/v1/traces`, headers: {}, serviceName: 'palugada-test', holder: 'worker-other', settleMs: 0 });
    await run('price the Bogor order');
    assert.equal(await other.export(), 0);
  } finally {
    await collector.close();
  }
});

