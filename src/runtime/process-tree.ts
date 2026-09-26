/**
 * A runtime is a process tree, not a process (PRD v2 F13.2, F13.8, F5.8).
 *
 * The adapters that spawn an agent CLI used to hold only the child they
 * started, and ended a run with `child.kill('SIGTERM')` -- and only if that
 * child was still alive. Three things were wrong with that, and each one is a
 * process left running on the owner's machine with the owner's API key:
 *
 *   1. **The tree.** An agent CLI is a parent: it starts shells, test runners,
 *      dev servers, language servers, MCP servers of its own. A signal to the
 *      CLI reaches none of them, and a CLI that exits cleanly on SIGTERM
 *      orphans every one it started. So the child is put in a process group of
 *      its own (`detached: true` on POSIX) and the whole group is signalled.
 *   2. **The leader already gone.** "Only if the child is still alive" meant a
 *      CLI that finished and left a background server running was never
 *      cleaned up at all -- the one case where cleanup matters most, because
 *      nothing else will ever notice. The group is signalled whether or not
 *      its leader is still there.
 *   3. **SIGTERM is a request.** A process that ignores it, or takes a minute
 *      to honour it, kept running. The group gets a grace period, then
 *      SIGKILL, then a check that it is actually empty -- and a group that is
 *      still there after that is *reported*, not assumed gone.
 *
 * The shape is taken from auto-company's supervisor
 * (`scripts/core/process-supervisor-linux.py`), which does this for one agent
 * loop and fails closed when it cannot confirm the tree is empty. It uses
 * `PR_SET_CHILD_SUBREAPER` to also catch a grandchild that calls `setsid()`
 * and leaves the group; that needs native code this runtime does not have, so
 * a process that deliberately daemonises itself out of its group is the one
 * case this does not reach. That is stated rather than implied.
 *
 * On Windows `detached` means "a new console", not a process group, so there
 * the old single-process behaviour is kept and the limitation is the same one
 * it always had.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Process groups are a POSIX idea. */
const GROUPS = process.platform !== 'win32';

/**
 * Every group this process started and has not seen empty.
 *
 * Killed on the way out: the orchestrator exiting -- a deploy, a crash that
 * still runs exit handlers, Ctrl-C in a terminal -- must not leave agents
 * running with nobody to account for them. A detached group no longer receives
 * the terminal's SIGINT, so without this Ctrl-C would have left them running
 * where before it did not.
 */
const live = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const pgid of live) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Gone already, or not ours to signal. Nothing more can be done from
        // an exit handler, which cannot wait.
      }
    }
  });
}

/**
 * `spawn`, with the child made the leader of a new process group.
 *
 * The group id is the child's pid. Nothing else about the spawn changes -- the
 * caller's stdio, environment and working directory are passed through -- so
 * an adapter switching to this changes what can be *killed*, not what runs.
 */
export function spawnTree(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: GROUPS });
  if (GROUPS && child.pid !== undefined) {
    installExitHook();
    live.add(child.pid);
  }
  return child;
}

export type TreeOutcome =
  /** The spawn itself failed; there was never a process. */
  | 'never_started'
  /** Nothing in the group was running by the time it was asked. */
  | 'already_gone'
  /** SIGTERM was enough. */
  | 'terminated'
  /** SIGTERM was not, and SIGKILL was. */
  | 'killed'
  /**
   * Still there after SIGKILL: a process stuck in the kernel, or one that has
   * changed its user and can no longer be signalled. Reported so the adapter
   * can refuse new work rather than pile runs on top of it.
   */
  | 'survived';

export interface TerminateOptions {
  /** How long SIGTERM is given before SIGKILL. */
  graceMs?: number;
  /** How long SIGKILL is given before the group is declared a survivor. */
  killWaitMs?: number;
}

export const DEFAULT_GRACE_MS = 3_000;
export const DEFAULT_KILL_WAIT_MS = 2_000;

/**
 * Ends the whole tree, and says whether it managed to.
 *
 * Idempotent: an adapter calls it on cancellation and again when the run
 * closes, and the second call finds the group gone and returns at once.
 */
export async function terminateTree(
  child: ChildProcess,
  options: TerminateOptions = {},
): Promise<TreeOutcome> {
  const pid = child.pid;
  if (pid === undefined) return 'never_started';
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;

  const alive = GROUPS ? () => groupAlive(pid) : () => child.exitCode === null && child.signalCode === null;
  const signal = GROUPS
    ? (name: NodeJS.Signals) => signalGroup(pid, name)
    : (name: NodeJS.Signals) => void child.kill(name);

  if (!alive()) {
    live.delete(pid);
    return 'already_gone';
  }
  signal('SIGTERM');
  if (await until(() => !alive(), graceMs)) {
    live.delete(pid);
    return 'terminated';
  }
  signal('SIGKILL');
  if (await until(() => !alive(), killWaitMs)) {
    live.delete(pid);
    return 'killed';
  }
  return 'survived';
}

function signalGroup(pgid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pgid, name);
  } catch {
    // ESRCH: the group emptied between the check and the signal, which is the
    // outcome being asked for. EPERM is reported by `groupAlive` instead.
  }
}

/**
 * Whether the group still has a member that is not a zombie.
 *
 * `kill(-pgid, 0)` alone answers "does any process with this group exist",
 * and a zombie is a process: one whose parent has not reaped it. The leader is
 * this process's child and libuv reaps it, but a grandchild is reparented to
 * PID 1, and in a container PID 1 is often not an init and never reaps. A
 * group of zombies would then read as alive for ever and every run would end
 * in `survived`. On Linux `/proc` says which members are zombies, so they are
 * left out; elsewhere the plain check is the best available.
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    // EPERM means the group exists and one of its members is no longer ours to
    // signal -- alive, and a reason to report rather than assume.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  return membersOf(pgid).some((member) => member.state !== 'Z');
}

interface Member {
  pid: number;
  state: string;
}

/** The processes in a group, read from `/proc`. Linux only. */
export function membersOf(pgid: number): Member[] {
  const members: Member[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [{ pid: pgid, state: '?' }];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue; // exited while being read
    }
    // `pid (comm) state ppid pgrp ...` -- and `comm` may itself contain spaces
    // and parentheses, so the fields are read after the *last* `)`.
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const state = fields[0] ?? '?';
    const group = Number(fields[2]);
    if (group === pgid) members.push({ pid: Number(entry), state });
  }
  return members;
}

async function until(done: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return done();
}

/**
 * What an adapter keeps between runs: the groups it could not end.
 *
 * Fail closed, as auto-company's loop does when it cannot confirm cleanup: a
 * runtime with a tree still running from an earlier run reports itself
 * unhealthy, and F13.8 then refuses it new work rather than starting another
 * agent beside one nobody can stop. The set is re-checked on every health
 * probe, so a survivor that eventually dies clears itself.
 */
export class TreeKeeper {
  readonly #survivors = new Set<number>();

  /**
   * Ends a run's tree and remembers it if it would not end.
   *
   * Never throws. It runs on the way out of a run, and a cleanup failure must
   * not replace the run's own result or error -- it is reported through
   * `stuck()` instead, where the next health check sees it.
   */
  async end(child: ChildProcess, options: TerminateOptions = {}): Promise<TreeOutcome> {
    const outcome = await terminateTree(child, options).catch((): TreeOutcome => 'survived');
    if (outcome === 'survived' && child.pid !== undefined) this.#survivors.add(child.pid);
    return outcome;
  }

  /** Groups from earlier runs that are still running. */
  stuck(): number[] {
    for (const pgid of [...this.#survivors]) {
      if (!groupAlive(pgid)) {
        this.#survivors.delete(pgid);
        live.delete(pgid);
      }
    }
    return [...this.#survivors];
  }

  /** The health answer when something is stuck, or null when nothing is. */
  unhealthy(): { ok: false; detail: string } | null {
    const stuck = this.stuck();
    if (stuck.length === 0) return null;
    return {
      ok: false,
      detail:
        `${stuck.length} process group(s) from earlier runs survived SIGKILL `
        + `(${stuck.join(', ')}); refusing new runs until they are gone`,
    };
  }
}
