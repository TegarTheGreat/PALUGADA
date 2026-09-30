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
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerMfa, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
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

test('a deployment answers whether it can work, without a session', async () => {
  const { start } = await import('../../src/main.ts');
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 20 } });
  try {
    await until(() => deployment.worker.lastTickAt !== null, 'the first tick');
    const answer = await fetch(`${deployment.url}/api/health`);
    assert.equal(answer.status, 200);
    const body = await answer.json() as { ok: boolean; database: string; worker: { lastTickAt: string | null } };
    assert.equal(body.ok, true);
    assert.equal(body.database, 'ok');
    assert.ok(body.worker.lastTickAt);
  } finally {
    await deployment.stop();
  }
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

/* --------------------------------------------------------------- metrics --- */

const SCRAPE_TOKEN = 'metrics-token-for-the-operability-suite-0123456789';

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
