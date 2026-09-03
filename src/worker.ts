/**
 * The worker loop (PRD v2 section 6.2).
 *
 * Everything else in `src/` is a piece: the broker decides, the engine runs,
 * the scheduler fires, the wake queue wakes. This is the thing that puts them
 * in an order and repeats it. Without it the repository is a library and an
 * acceptance suite — every part exercised, nothing assembled — which was true
 * for longer than it should have been.
 *
 * The order of a tick is not arbitrary and each position is load-bearing:
 *
 *   1. **Reclaim** first (F5.14). A lease that expired while this process was
 *      down is holding a task nobody is running, and every later step in this
 *      tick would skip it.
 *   2. **Schedules** (F9.1), then **heartbeats** (F9.7). Both create work, so
 *      they come before the step that claims work — otherwise everything they
 *      produce waits a whole tick for no reason.
 *   3. **Drain wakes** (F9.8), which turns a wake into at most one run.
 *   4. **Claim and run** whatever is left claimable, up to `maxRunsPerTick`.
 *   5. **Settle** reviews and expire overdue approvals (F7.2, F10.4). After
 *      the runs, because a run in this tick may have opened one.
 *   6. **Watch the money and the failure rate** (F1.7–F1.9, F11.4). Last,
 *      because it reports on what just happened.
 *   7. **Retention** (section 12.3), at most once every few hours per company.
 *      Last and rarest: it deletes, and everything above may still want to read
 *      what it is about to remove.
 *
 * A tick is bounded rather than draining the queue: a worker that ran every
 * claimable task before looking at the clock again would never notice a
 * platform stop, and F5.8 says stopping must be bounded by the polling
 * interval rather than by how much work happens to be queued.
 *
 * Errors inside a tick are recorded and the tick continues. A worker that died
 * because one company's schedule had a bad cron expression would take every
 * other company down with it, and the failure that stops a fleet should be the
 * platform's, never a tenant's.
 */
import { withControlPlane } from './db/tenant.ts';
import { Engine, type RunOutcome } from './engine/engine.ts';
import { claimTask, reclaimExpiredLeases, reclaimOrphans } from './engine/checkout.ts';
import { getTask } from './engine/tasks.ts';
import { withTenant } from './db/tenant.ts';
import { isStopAllRequested } from './engine/control.ts';
import { runDueSchedules } from './scheduler/scheduler.ts';
import { drainWakes, scheduleHeartbeats } from './scheduler/wake.ts';
import { settleCompletedReviews } from './review/review.ts';
import { evaluateAlerts } from './reporting/alerts.ts';
import { evaluateCircuitBreakers, evaluateSpendLimit } from './governance/spend-guard.ts';
import * as inbox from './inbox/inbox.ts';
import { runRetention } from './retention/retention.ts';

export interface WorkerOptions {
  engine: Engine;
  /** Restrict to one company. Omitted means every company that is not frozen. */
  companyId?: string;
  /** How long to wait between ticks when a tick found nothing to do. */
  idleMs?: number;
  /** How many tasks one tick may run. Bounds how long a stop takes to bite. */
  maxRunsPerTick?: number;
  /**
   * How often a company's retention policy is applied.
   *
   * Retention is a promise about data the company no longer keeps, and a
   * promise nothing runs is not one. It is here rather than on a schedule
   * because a schedule belongs to a company and is something an owner can
   * disable, and "we stopped deleting your expired data" is not a setting.
   */
  retentionIntervalMs?: number;
  signal?: AbortSignal;
  /**
   * Called when a whole tick fails, not when a stage does.
   *
   * A stage failure is on the returned report; this is for the case where
   * there is no report — the database went away mid-tick. It exists so a
   * deployment can log or alert without this module choosing a logger.
   */
  onTickError?: (error: Error) => void;
}

export interface TickReport {
  reclaimed: number;
  scheduled: number;
  woken: number;
  ran: Array<{ taskId: string; status: RunOutcome['status'] }>;
  alerts: number;
  /** Companies whose retention policy this tick applied. */
  retained: number;
  /** Set when the platform stop is in effect: the tick did nothing else. */
  stopped: boolean;
  errors: Array<{ stage: string; message: string }>;
}

export const DEFAULT_IDLE_MS = 5_000;
export const DEFAULT_MAX_RUNS_PER_TICK = 8;

/**
 * Six hours, which is four sweeps a day.
 *
 * The windows retention enforces are measured in days, so anything under a day
 * is already prompt; four is chosen so that a worker restarted a few times a
 * day still sweeps, without a company's deletions waiting on one worker
 * staying up. The clock is in memory, so a restart costs one extra sweep --
 * three indexed deletes that delete nothing.
 */
export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class Worker {
  readonly #options: WorkerOptions;
  readonly id: string;
  /** When each company's retention was last applied by *this* worker. */
  readonly #retainedAt = new Map<string, number>();

  constructor(options: WorkerOptions) {
    this.#options = options;
    // The engine's identity, not a second one: leases are held by whoever the
    // engine says it is, and a worker with a different id could not renew its
    // own engine's leases.
    this.id = options.engine.workerId;
  }

  /**
   * One pass. Returns what it did, which is what makes the loop testable
   * without running it.
   */
  async tick(now = new Date()): Promise<TickReport> {
    const report: TickReport = {
      reclaimed: 0, scheduled: 0, woken: 0, ran: [], alerts: 0, retained: 0,
      stopped: false, errors: [],
    };

    // F5.8: a halted platform does nothing at all, and finds out within one
    // polling interval.
    if (await isStopAllRequested()) {
      report.stopped = true;
      return report;
    }

    const companies = await this.#companies();

    for (const company of companies) {
      await this.#stage(report, 'reclaim', async () => {
        report.reclaimed += (await reclaimExpiredLeases(company, now)).length;
        report.reclaimed += (await reclaimOrphans(company, { now })).length;
      });

      await this.#stage(report, 'heartbeats', async () => {
        report.scheduled += (await scheduleHeartbeats(company, now)).length;
      });
    }

    // Schedules scan across tenants on the control plane, so this is one call
    // rather than one per company.
    await this.#stage(report, 'schedules', async () => {
      report.scheduled += (await runDueSchedules(now)).length;
    });

    for (const company of companies) {
      await this.#stage(report, 'wakes', async () => {
        const drained = await drainWakes(company, { holder: this.id, now });
        report.woken += drained.length;

        // A wake that found no claimable task has already been consumed and
        // costs nothing (F9.10). One that found a task hands it over here.
        const budget = this.#options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK;
        for (const wake of drained) {
          if (report.ran.length >= budget) break;
          if (wake.taskId) await this.#runClaimed(report, company, wake.taskId);
        }
      });

      await this.#stage(report, 'claim', async () => {
        const budget = (this.#options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK)
          - report.ran.length;
        for (let taken = 0; taken < budget; taken += 1) {
          const claim = await claimTask(company, { holder: this.id, now });
          if (!claim) break;
          await this.#runClaimed(report, company, claim.taskId);
        }
      });

      await this.#stage(report, 'settle', async () => {
        await settleCompletedReviews(company);
        await inbox.expireOverdue(company);
      });

      await this.#stage(report, 'watch', async () => {
        await evaluateSpendLimit(company, now);
        await evaluateCircuitBreakers(company, now);
        report.alerts += (await evaluateAlerts(company, now)).length;
      });

      // Section 12.3. Deletes, so it goes after everything that reads.
      const interval = this.#options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
      const last = this.#retainedAt.get(company);
      if (last === undefined || now.getTime() - last >= interval) {
        await this.#stage(report, 'retention', async () => {
          await runRetention(company, now);
          // Recorded after the sweep rather than before it: a sweep that threw
          // has not happened, and marking it done would mean waiting the whole
          // interval before trying again.
          this.#retainedAt.set(company, now.getTime());
          report.retained += 1;
        });
      }
    }

    return report;
  }

  /**
   * Ticks until the signal aborts.
   *
   * Sleeps only when a tick found nothing: a tick that ran something goes
   * straight round again, because a queue with work in it should drain at the
   * speed of the work rather than at the speed of the poll.
   */
  async start(): Promise<void> {
    const signal = this.#options.signal;
    const idle = this.#options.idleMs ?? DEFAULT_IDLE_MS;

    while (!signal?.aborted) {
      let report: TickReport;
      try {
        report = await this.tick();
      } catch (error) {
        // A tick can fail outside any stage — the database went away, the
        // platform-stop read threw. Sleeping and trying again is right for a
        // daemon: a transient blip should cost one interval, not the worker.
        // A permanent failure keeps failing and stays visible in the logs
        // rather than leaving a process that exited for reasons nobody saw.
        this.#options.onTickError?.(error as Error);
        await this.#sleep(idle, signal);
        continue;
      }

      const didSomething =
        report.ran.length > 0 || report.reclaimed > 0 || report.scheduled > 0;
      if (didSomething && !report.stopped) continue;

      await this.#sleep(idle, signal);
    }
  }

  /** Waits, and stops waiting the moment the signal aborts. */
  async #sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  /**
   * Runs a task this worker has already claimed.
   *
   * The role slug is read here rather than carried on the claim, because a
   * claim is about the lease and the engine's contract is about the role — and
   * a claim that carried a stale slug would run the task as something it is
   * not.
   */
  async #runClaimed(report: TickReport, companyId: string, taskId: string): Promise<void> {
    const roleSlug = await withTenant(companyId, async (tx) => {
      const task = await getTask(tx, taskId);
      if (!task) return null;
      const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [
        task.roleId,
      ]);
      return rows[0]?.slug ?? null;
    });
    if (!roleSlug) return;

    const outcome = await this.#options.engine.runTask(companyId, taskId, roleSlug);
    report.ran.push({ taskId, status: outcome.status });
  }

  /**
   * The companies this tick will work on.
   *
   * F1.4: a frozen company is skipped rather than picked up and cancelled. A
   * freeze stops work starting; it does not manufacture cancelled tasks.
   *
   * The filter applies to an explicitly configured company too, which is the
   * part that is easy to get wrong: without it a worker pinned to one company
   * would claim a frozen company's task, take a lease, be refused by the
   * engine's guards, and leave the task checked out until the lease expired.
   * A freeze that parks work for the length of a lease is not a freeze.
   */
  async #companies(): Promise<string[]> {
    return withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM companies
          WHERE frozen_at IS NULL AND ($1::uuid IS NULL OR id = $1)
          ORDER BY created_at`,
        [this.#options.companyId ?? null],
      );
      return rows.map((row) => row.id);
    });
  }

  /**
   * Runs one stage, and lets the tick survive it failing.
   *
   * Recorded rather than swallowed: a stage that has quietly stopped working
   * is worse than one that fails loudly, and a worker whose schedule stage has
   * been throwing for a week looks exactly like a company with no schedules.
   */
  async #stage(report: TickReport, stage: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      report.errors.push({ stage, message });
      // Reported on the tick rather than written to the event log: the log is
      // tenant-scoped and a stage failure is the platform's, not a company's.
      // A caller that wants it durable has the report; inventing a company to
      // file it against would put the platform's problem in somebody's audit
      // trail.
    }
  }
}

/** Convenience for a process that just wants to run until it is stopped. */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const worker = new Worker(options);
  await worker.start();
}
