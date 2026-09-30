/**
 * The process groups runs start, where the next worker on the machine can
 * find them (0095).
 *
 * `process-tree.ts` ends a run's group when the run ends, and every group a
 * worker holds from an exit hook as the worker exits. A worker killed with
 * SIGKILL, or by the out-of-memory killer, does neither: the kernel gives it
 * no turn to run in. Where nothing else takes its processes down with it --
 * `npm start` on a bare machine, rather than a service manager that kills
 * the whole control group or a container whose init takes every process with
 * it -- the agent CLI went on working, and spending the owner's key, with
 * nothing left that knew it was there. Found by reading Paperclip, which
 * keeps a run's pid, group and start time and kills a lost run's group after
 * a restart.
 *
 * So each group is written down as it starts, and a worker looks, as it
 * starts and once a minute after, for the groups on its own machine that
 * nobody is going to end. A group is left behind when
 *
 *   - **its worker's process is gone**: the worker's pid no longer has the
 *     start time written beside it. Asked of `/proc` rather than of the
 *     heartbeats, because a worker restarted at once finds its
 *     predecessor's last beat still fresh, and an id fixed with
 *     `PALUGADA_WORKER_ID` is the same id after a restart;
 *   - **its worker has stopped beating**: its tasks are already being given
 *     to other workers (`silentHolders`), and a CLI still working on one is
 *     working for nobody; or
 *   - **its run is no longer running**: taken back as an orphan, or ended
 *     with its group somehow still there.
 *
 * **A pid is not a process.** The kernel gives a freed pid to the next
 * process that asks, and on a machine whose pids stop at 32768 that is soon.
 * A group is signalled only while its leader's pid still has the start time
 * written down; a pid that now has another start time belongs to a process
 * that is not ours, and the row is closed without a signal. A group whose
 * leader has exited is not signalled either, although its other members may
 * be ours: the kernel keeps a pid out of use while it names a live group,
 * but once that group has emptied, the same number can name a new group
 * whose own leader has exited, and nothing left in `/proc` tells the two
 * apart. The CLI -- the process that spends -- is the leader.
 *
 * **Only this machine's.** Replicas share the database and not their pids,
 * so a row is this worker's to act on only when it was written under the
 * same boot and pid namespace (`hostIdentity`). Another machine's leftovers
 * wait for a worker there.
 */
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import {
  endGroup, hostIdentity, startTicksOf, type TerminateOptions, type TreeLedger, type TreeOutcome,
} from '../runtime/process-tree.ts';

/**
 * The ledger one run's groups are written in, or undefined where there is no
 * `/proc` to name a process by: a row the sweep could never check is a row
 * it could never act on.
 */
export function processLedger(companyId: string, agentRunId: string, workerId: string): TreeLedger | undefined {
  const host = hostIdentity();
  const self = startTicksOf(process.pid);
  if (host === null || self === null) return undefined;
  return {
    async opened(tree) {
      await withTenant(companyId, (tx) => tx.query(
        `INSERT INTO run_processes
           (company_id, agent_run_id, worker_id, host, worker_pid, worker_started, pid, pgid, started_ticks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [companyId, agentRunId, workerId, host, process.pid, self, tree.pid, tree.pgid, tree.startTicks],
      ));
    },
    async ended(tree) {
      await withTenant(companyId, (tx) => tx.query(
        `UPDATE run_processes SET ended_at = now()
          WHERE agent_run_id = $1 AND host = $2 AND pgid = $3 AND started_ticks = $4 AND ended_at IS NULL`,
        [agentRunId, host, tree.pgid, tree.startTicks],
      ));
    },
  };
}

/** Why a group was found left behind, in the order they are asked. */
type LeftBehind = 'worker_gone' | 'worker_silent' | 'run_ended';

interface OpenGroup {
  id: string;
  company_id: string;
  agent_run_id: string;
  task_id: string;
  worker_id: string;
  worker_pid: number;
  /** bigint, which `pg` reads as a string: the same decimal `/proc` writes. */
  worker_started: string;
  pid: number;
  pgid: number;
  started_ticks: string;
  run_status: string;
}

export interface SweepOptions extends TerminateOptions {
  /** The worker sweeping, named on what it records. */
  by: string;
  /** A worker kept to one company sweeps only that company's groups. */
  companyId?: string;
}

/**
 * Ends the groups on this machine that their worker left behind, closes the
 * rows of those already gone, and names what it ended.
 *
 * Each group ended is recorded on its run's task, so the owner reading it
 * sees why its CLI stopped. A group that survives SIGKILL -- stuck in the
 * kernel, or no longer this user's to signal -- keeps its row open, and the
 * next sweep tries again. Where there is no `/proc`, there is nothing to
 * check a pid against, and nothing is swept.
 */
export async function sweepLeftoverProcesses(alive: ReadonlySet<string>, options: SweepOptions): Promise<string[]> {
  const host = hostIdentity();
  if (host === null) return [];
  const open = await withControlPlane(async (tx) => (await tx.query<OpenGroup>(
    `SELECT p.id, p.company_id, p.agent_run_id, r.task_id, p.worker_id, p.worker_pid, p.worker_started,
            p.pid, p.pgid, p.started_ticks, r.status AS run_status
       FROM run_processes p
       JOIN agent_runs r ON r.company_id = p.company_id AND r.id = p.agent_run_id
      WHERE p.host = $1 AND p.ended_at IS NULL AND ($2::uuid IS NULL OR p.company_id = $2)
      ORDER BY p.recorded_at`,
    [host, options.companyId ?? null],
  )).rows);

  const gone: OpenGroup[] = [];
  const ending: Array<{ group: OpenGroup; why: LeftBehind }> = [];
  for (const group of open) {
    const why = leftBehind(group, alive);
    if (why === null) continue;
    // The one proof that the pid is still the process written down.
    if (startTicksOf(group.pid) === group.started_ticks) ending.push({ group, why });
    else gone.push(group);
  }

  // Waited on together: each group has its own grace period, and one that
  // ignores SIGTERM should not hold the next one's CLI running behind it.
  const outcomes: TreeOutcome[] = await Promise.all(ending.map(({ group }) => endGroup(group.pgid, options)));

  for (const group of gone) await close(group);
  const ended: string[] = [];
  for (const [index, { group, why }] of ending.entries()) {
    const outcome = outcomes[index]!;
    if (outcome === 'survived') continue;
    // A transaction each, so that one company's refusal costs only its own
    // record: the signal has been sent either way.
    const recorded = await withControlPlane(async (tx) => {
      // Two workers on one machine may both have signalled it, and the one
      // that closes the row is the one that says so. A group that emptied
      // between the check and the signal was ended by nobody here.
      const closed = await tx.query(
        'UPDATE run_processes SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [group.id]);
      if (closed.rowCount !== 1 || outcome === 'already_gone') return false;
      await appendEvent(tx, {
        companyId: group.company_id,
        taskId: group.task_id,
        type: 'agent_run.leftover_ended',
        actor: 'system',
        payload: {
          agentRunId: group.agent_run_id,
          pid: group.pid,
          pgid: group.pgid,
          workerId: group.worker_id,
          reason: why,
          outcome,
          by: options.by,
        },
      });
      return true;
    });
    if (recorded) ended.push(`process group ${group.pgid} of run ${group.agent_run_id} (${why})`);
  }
  return ended;
}

function leftBehind(group: OpenGroup, alive: ReadonlySet<string>): LeftBehind | null {
  if (startTicksOf(group.worker_pid) !== group.worker_started) return 'worker_gone';
  if (!alive.has(group.worker_id)) return 'worker_silent';
  if (group.run_status !== 'running') return 'run_ended';
  return null;
}

async function close(group: OpenGroup): Promise<void> {
  await withControlPlane((tx) => tx.query(
    'UPDATE run_processes SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [group.id]));
}
