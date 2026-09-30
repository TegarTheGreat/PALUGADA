/**
 * Agent CLIs a worker killed outright left running (docs/STATUS.md 2.52).
 *
 * A run ends its CLI's process group, and the worker kills every group it
 * holds from an exit hook. A worker killed with SIGKILL or by the
 * out-of-memory killer does neither: on a bare machine the CLI and whatever
 * it started kept running on the owner's key, and nothing counted it. Found
 * by reading Paperclip, which keeps each run's pid, group and start time and
 * kills a lost run's group after a restart.
 *
 * Every process here is real. The groups are spawned the way a runtime
 * spawns them, written down the way a run writes them, and looked for in
 * `/proc` afterwards; the last test kills a real worker process mid-run. A
 * worker's death is otherwise played by its heartbeat or its run, never by
 * killing this process.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { spawnTree } from '../../src/runtime/process-tree.ts';
import { processLedger, sweepLeftoverProcesses } from '../../src/engine/process-ledger.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { Engine } from '../../src/engine/engine.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { CliAdapter, runtimeSpecsFrom } from '../../src/runtime/cli.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { Worker } from '../../src/worker.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const LINUX = process.platform === 'linux';
const AGENT_CLI = new URL('../fixtures/runtimes/fake-agent-cli.mjs', import.meta.url).pathname;
const DOOMED = new URL('../fixtures/doomed-worker.ts', import.meta.url).pathname;

/** Short, so a test that ends a group that ignores SIGTERM does not wait three seconds for it. */
const QUICK = { graceMs: 300, killWaitMs: 2_000 };

/**
 * What an agent CLI is to its machine: a process that works for a long time
 * and has a child of its own -- an MCP server, a dev server, a shell -- in
 * its group. It prints the child's pid and then waits.
 */
const PLAYS_AN_AGENT_CLI = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(child.pid + '\\n');
  setInterval(() => {}, 1000);
`;

interface Played {
  leader: number;
  child: number;
  process: ChildProcess;
}

/** Spawns one, as a runtime does, written in `ledger` when one is given. */
async function playAgentCli(ledger?: ReturnType<typeof processLedger>): Promise<Played> {
  const leader = spawnTree(process.execPath, ['-e', PLAYS_AN_AGENT_CLI], { stdio: ['ignore', 'pipe', 'ignore'] }, ledger);
  const line = await new Promise<string>((resolve, reject) => {
    let text = '';
    leader.stdout!.setEncoding('utf8');
    leader.stdout!.on('data', (chunk: string) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.trim());
    });
    leader.once('exit', () => reject(new Error('the stand-in CLI exited before it said anything')));
  });
  return { leader: leader.pid!, child: Number(line), process: leader };
}

/** Whether a pid is a running process: there, and not a zombie waiting to be reaped. */
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

/** Field 22 of `/proc/<pid>/stat`, read here rather than by the code under test. */
function startTimeOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

function stop(played: Played): void {
  for (const target of [-played.leader, played.child]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone, which is what cleaning up asks for.
    }
  }
}

async function until<T>(read: () => Promise<T | null | undefined> | T | null | undefined, what: string, withinMs = 10_000): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`waited ${withinMs} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A task and the run of it that is going on now, as the engine opens one. */
async function aRun(fixture: Fixture): Promise<{ taskId: string; agentRunId: string }> {
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { ask: 'work for a long time' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
  const agentRunId = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO agent_runs (company_id, task_id, role_id, attempt, status)
     VALUES ($1, $2, $3, 1, 'running') RETURNING id`,
    [fixture.companyId, task.id, fixture.roleId],
  )).rows[0]!.id);
  return { taskId: task.id, agentRunId };
}

interface Row {
  pid: number;
  pgid: number;
  started_ticks: string;
  worker_id: string;
  worker_pid: number;
  host: string;
  ended_at: Date | null;
}

async function rowsOf(agentRunId: string): Promise<Row[]> {
  return withControlPlane(async (tx) => (await tx.query<Row>(
    `SELECT pid, pgid, started_ticks, worker_id, worker_pid, host, ended_at
       FROM run_processes WHERE agent_run_id = $1 ORDER BY recorded_at`,
    [agentRunId],
  )).rows);
}

async function endings(companyId: string, taskId: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(companyId, async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'agent_run.leftover_ended' ORDER BY occurred_at",
    [taskId],
  )).rows.map((row) => row.payload));
}

test('a group whose worker stopped saying it is alive is ended, CLI and child, and its task says so', { skip: !LINUX }, async () => {
  const fixture = await createCompany('leftover-silent');
  const run = await aRun(fixture);
  const played = await playAgentCli(processLedger(fixture.companyId, run.agentRunId, 'worker-gone'));
  try {
    const [row] = await until(async () => {
      const rows = await rowsOf(run.agentRunId);
      return rows.length > 0 ? rows : null;
    }, 'the group to be written down');
    assert.equal(row!.pid, played.leader);
    assert.equal(row!.pgid, played.leader, 'the leader is the group');
    assert.equal(row!.started_ticks, startTimeOf(played.leader), 'with the start time /proc gives it');
    assert.equal(row!.worker_id, 'worker-gone');
    assert.equal(row!.worker_pid, process.pid);
    assert.equal(row!.ended_at, null);
    assert.ok(running(played.leader) && running(played.child));

    // `worker-gone` never beat: it is not among the workers alive.
    const ended = await sweepLeftoverProcesses(new Set(['worker-sweeping']), { by: 'worker-sweeping', ...QUICK });
    assert.equal(ended.length, 1, JSON.stringify(ended));
    await until(() => !running(played.leader) && !running(played.child), 'the group to be gone');

    const [closed] = await rowsOf(run.agentRunId);
    assert.notEqual(closed!.ended_at, null, 'the row is closed, so no later sweep looks at it again');
    const [event] = await endings(fixture.companyId, run.taskId);
    assert.equal(event?.agentRunId, run.agentRunId);
    assert.equal(event?.pid, played.leader);
    assert.equal(event?.workerId, 'worker-gone');
    assert.equal(event?.reason, 'worker_silent');
    assert.equal(event?.outcome, 'terminated');
    assert.equal(event?.by, 'worker-sweeping');

    assert.deepEqual(await sweepLeftoverProcesses(new Set(['worker-sweeping']), { by: 'worker-sweeping', ...QUICK }), []);
  } finally {
    stop(played);
  }
});

/**
 * A pid is a number the kernel hands to the next process that asks once it
 * is free, and on a machine whose pids go to 32768 that is soon. The start
 * time is what says the process is still the one written down; here the row
 * says another, as it would once the kernel had given the pid away.
 */
test('a pid whose start time is not the one written down is never signalled', { skip: !LINUX }, async () => {
  const fixture = await createCompany('leftover-reused');
  const run = await aRun(fixture);
  const stranger = await playAgentCli();
  try {
    const ledger = processLedger(fixture.companyId, run.agentRunId, 'worker-gone')!;
    const earlier = String(BigInt(startTimeOf(stranger.leader)) - 1n);
    await ledger.opened({ pid: stranger.leader, pgid: stranger.leader, startTicks: earlier });

    assert.deepEqual(await sweepLeftoverProcesses(new Set(), { by: 'worker-sweeping', ...QUICK }), []);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(running(stranger.leader), 'the process that has the pid now was signalled');
    assert.ok(running(stranger.child), 'and its child with it');

    const [row] = await rowsOf(run.agentRunId);
    assert.notEqual(row!.ended_at, null, 'the group written down is gone; the row is closed and not looked at again');
    assert.deepEqual(await endings(fixture.companyId, run.taskId), [], 'nothing was ended, so nothing is said to have been');
  } finally {
    stop(stranger);
  }
});

test("a live run's group is left alone, and is ended once the run is not running", { skip: !LINUX }, async () => {
  const fixture = await createCompany('leftover-live');
  const run = await aRun(fixture);
  const played = await playAgentCli(processLedger(fixture.companyId, run.agentRunId, 'worker-live'));
  try {
    await until(async () => (await rowsOf(run.agentRunId)).length > 0, 'the group to be written down');

    // Its worker beats, its process is this one, its run is running.
    const alive = new Set(['worker-live', 'worker-sweeping']);
    assert.deepEqual(await sweepLeftoverProcesses(alive, { by: 'worker-sweeping', ...QUICK }), []);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(running(played.leader) && running(played.child), 'a run in flight was signalled');
    const [open] = await rowsOf(run.agentRunId);
    assert.equal(open!.ended_at, null);

    // Taken back, as `reclaimOrphans` does with a run whose worker went quiet
    // for two leases: the task is someone else's now, and a CLI still
    // working on it is working for nobody.
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE agent_runs SET status = 'orphaned', finished_at = now() WHERE id = $1", [run.agentRunId]));
    const ended = await sweepLeftoverProcesses(alive, { by: 'worker-sweeping', ...QUICK });
    assert.equal(ended.length, 1);
    await until(() => !running(played.leader) && !running(played.child), 'the group to be gone');
    const [event] = await endings(fixture.companyId, run.taskId);
    assert.equal(event?.reason, 'run_ended');
  } finally {
    stop(played);
  }
});

/**
 * Two replicas on two machines, or in two containers on one, share the
 * database and not their pids: pid 4242 there is nothing to do with pid 4242
 * here. A row from elsewhere is not this worker's to signal, or to close.
 */
test("another machine's group is never signalled, whatever its worker's state", { skip: !LINUX }, async () => {
  const fixture = await createCompany('leftover-elsewhere');
  const run = await aRun(fixture);
  const here = await playAgentCli();
  try {
    await withControlPlane((tx) => tx.query(
      `INSERT INTO run_processes
         (company_id, agent_run_id, worker_id, host, worker_pid, worker_started, pid, pgid, started_ticks)
       VALUES ($1, $2, 'worker-gone', 'another-boot pid:[4026531836]', 1, 1, $3, $3, $4)`,
      [fixture.companyId, run.agentRunId, here.leader, startTimeOf(here.leader)],
    ));
    assert.deepEqual(await sweepLeftoverProcesses(new Set(), { by: 'worker-sweeping', ...QUICK }), []);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(running(here.leader) && running(here.child), 'a pid on another machine was signalled here');
    const [row] = await rowsOf(run.agentRunId);
    assert.equal(row!.ended_at, null, 'left for a worker on its own machine');
  } finally {
    stop(here);
  }
});

/**
 * The runtimes write their groups down through the run's services, and a
 * run that ends its own group closes its row: the sweep has only what a
 * worker could not end to look at.
 */
test('a CLI run writes its group down as it starts it, and closes it as it ends it', { skip: !LINUX }, async () => {
  const fixture = await createCompany('leftover-closed');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'codex', backend = 'local', tools = '{}' WHERE id = $1", [fixture.roleId]));
  const { taskId } = await aTask(fixture);
  const dir = await mkdtemp(join(tmpdir(), 'palugada-leftover-'));
  const [spec] = runtimeSpecsFrom([{
    name: 'codex',
    command: process.execPath,
    args: [AGENT_CLI, '--mcp-config', '{mcpConfig}', '--spawn-orphan', join(dir, 'child.pid')],
  }]);
  const adapters = new AdapterRegistry();
  adapters.register(new CliAdapter(spec!));
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), adapters, workerId: 'worker-here' });

  const outcome = await engine.runTask(fixture.companyId, taskId, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);

  const rows = await withControlPlane(async (tx) => (await tx.query<Row>(
    `SELECT p.pid, p.pgid, p.started_ticks, p.worker_id, p.worker_pid, p.host, p.ended_at
       FROM run_processes p JOIN agent_runs r ON r.id = p.agent_run_id
      WHERE r.task_id = $1`,
    [taskId],
  )).rows);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0]!.worker_id, 'worker-here');
  assert.equal(rows[0]!.pid, rows[0]!.pgid);
  assert.notEqual(rows[0]!.ended_at, null, 'the run ended its group and said so');
  const child = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
  assert.equal(running(child), false);
});

async function aTask(fixture: Fixture): Promise<{ taskId: string }> {
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { ask: 'read the zone' },
    createdBy: 'owner',
    reserveTokens: 20_000,
  });
  return { taskId: task.id };
}

/**
 * The whole thing, with nothing played: a worker process runs a task on an
 * agent CLI, is killed with SIGKILL in the middle of it, and the CLI and its
 * child are still running afterwards -- which is the defect. The next worker
 * to start on the machine ends them on its first tick, although the dead
 * worker's last heartbeat is only a moment old: the process it was is gone,
 * and `/proc` says so.
 */
test('a worker killed with SIGKILL mid-run leaves its CLI running, and the next worker ends it', { skip: !LINUX }, async () => {
  const fixture = await createCompany('leftover-killed');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'codex', backend = 'local', tools = '{}' WHERE id = $1", [fixture.roleId]));
  const { taskId } = await aTask(fixture);
  const dir = await mkdtemp(join(tmpdir(), 'palugada-doomed-'));
  const childFile = join(dir, 'child.pid');
  const leaderFile = join(dir, 'leader.pid');

  const doomed = spawn(process.execPath, [DOOMED, fixture.companyId, taskId, AGENT_CLI, childFile, leaderFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let said = '';
  doomed.stderr!.setEncoding('utf8');
  doomed.stderr!.on('data', (chunk: string) => { said = (said + chunk).slice(-4_000); });
  const exited = new Promise<void>((resolve) => doomed.once('exit', () => resolve()));

  let leader = 0;
  let child = 0;
  try {
    const pidIn = async (file: string) => Number(await readFile(file, 'utf8').catch(() => '')) || null;
    leader = await until(() => pidIn(leaderFile), `the CLI to start (${said})`, 30_000);
    child = await until(() => pidIn(childFile), 'its child to start');
    await until(async () => (await withControlPlane((tx) => tx.query(
      'SELECT 1 FROM run_processes WHERE pid = $1 AND ended_at IS NULL', [leader]))).rowCount === 1,
    'the worker to write its group down');

    doomed.kill('SIGKILL');
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(running(leader), 'the CLI died with its worker; the defect this guards against is gone some other way');
    assert.ok(running(child), 'and so did its child');

    const next = new Worker({
      engine: new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), adapters: new AdapterRegistry(), workerId: 'worker-next' }),
    });
    const report = await next.tick();
    assert.deepEqual(report.errors, []);
    assert.equal(report.leftovers, 1);
    await until(() => !running(leader) && !running(child), 'the CLI and its child to be gone');

    const [event] = await endings(fixture.companyId, taskId);
    assert.equal(event?.workerId, 'worker-doomed');
    assert.equal(event?.reason, 'worker_gone', 'its heartbeat was fresh; its process was not there');
    // The stand-in ignores SIGTERM, as a CLI in the middle of something may.
    assert.equal(event?.outcome, 'killed');
    assert.equal(event?.by, 'worker-next');
  } finally {
    doomed.kill('SIGKILL');
    for (const target of [-leader, child]) {
      try {
        if (target) process.kill(target, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }
});
