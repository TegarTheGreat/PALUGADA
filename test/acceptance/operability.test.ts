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
import { withTenant } from '../../src/db/tenant.ts';
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
