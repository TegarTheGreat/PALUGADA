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
 *   5. **Settle** reviews, expire overdue approvals (F7.2, F10.4) and perform
 *      the handoffs owed by tasks that completed (F6.1, F6.3). After the runs,
 *      because a run in this tick may have opened a review or completed the
 *      task a handoff follows.
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
import { processHandoffs, type HandoffRule } from './engine/handoff.ts';
import { dispatch, retryFailed, type OwnerChannel, type NotifiableItem } from './owner/notify.ts';
import {
  distillEpisodicToSemantic,
  distillSemanticToProcedural,
} from './memory/distillation.ts';
import { screenCandidate } from './skills/skills.ts';
import type { LlmClient } from './llm/client.ts';

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
  /**
   * F6.1, F6.3: what runs after what.
   *
   * Code rather than rows, because a rule carries a `mapInput` function — the
   * same arrangement as the capability registry, where the platform binds what
   * it implements and a deployment binds the rest. Omitted means no handoffs,
   * which is the honest default: inventing one would decide a company's
   * process for it.
   */
  handoffRules?: HandoffRule[];
  /**
   * F10.5, F10.9: the pipes to the owner.
   *
   * Given to the worker rather than reached for, and empty by default, because
   * a transport needs a vendor account and inventing one would be a platform
   * choosing how a person is interrupted. What is *not* optional is that
   * something calls them: a notifier nobody runs is the defect this codebase
   * has found in itself more often than any other -- machinery that works, is
   * tested in isolation, and is assembled by nobody.
   */
  ownerChannels?: OwnerChannel[];
  /**
   * F4.5's distillation and F15.3's screening, and how often to run them.
   *
   * Both need a model, and a model needs somebody's account -- so both are
   * optional and their absence is a fact about the deployment rather than a
   * default. What is *not* optional is that something calls them: memory that
   * is never distilled grows without ever becoming knowledge, and a skill
   * candidate nobody screens sits at `candidate` for ever. Both were exactly
   * that until this option existed.
   */
  learning?: {
    llm: LlmClient;
    model: string;
    /** Defaults to once an hour. Distillation reads a window of events. */
    intervalMs?: number;
  };
  /** Turns an item into a deep link into the owner's app, when there is one. */
  ownerLinkFor?: (item: NotifiableItem) => string | null;
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
  /** Successor tasks created from a completed task's output (F6.3). */
  handedOff: number;
  /** Items put in front of the owner on a channel this tick (F10.5, F10.9). */
  notified: number;
  /** Facts distilled from events, and SOP candidates raised from them (F4.5). */
  distilled: number;
  /** Skill candidates screened against their own eval cases (F15.3). */
  screened: number;
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

/**
 * An hour, for the learning stage.
 *
 * Distillation reads a window of events and costs a model call, so running it
 * every tick would be paying for the same reading over and over. An hour is
 * short enough that a fact learned this morning is available this afternoon,
 * and long enough that the bill is a bill rather than a stream.
 */
export const DEFAULT_LEARNING_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Whether a tick got anywhere, which is what decides between going straight
 * round and sleeping.
 *
 * A function rather than three lines inside the loop, because the loop is the
 * one part of this file a test cannot drive without waiting on wall-clock
 * time, and this is the decision worth checking.
 *
 * `runtime_unavailable` is the case that has to be named. F13.8 sends the task
 * back to `pending` and spends no attempt on it -- correctly, since a runtime
 * being down is a fact about the world rather than about the work -- so it
 * looks like a run happened. Counting it as progress meant the worker skipped
 * its sleep, re-claimed the same task, failed the same health check and went
 * round again at whatever rate the database could answer. With a docker daemon
 * down that is a hot loop against Postgres, not a retry.
 */
export function madeProgress(report: TickReport): boolean {
  const ran = report.ran.some((run) => run.status !== 'runtime_unavailable');
  return ran || report.reclaimed > 0 || report.scheduled > 0;
}

export class Worker {
  readonly #options: WorkerOptions;
  readonly id: string;
  /** When this worker last ran the learning stage for each company. */
  readonly #learnedAt = new Map<string, number>();

  /** When each company's retention was last applied by *this* worker. */
  readonly #retainedAt = new Map<string, number>();
  /** Which company this worker starts its tick on. See `#rotate`. */
  #turn = 0;

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
      reclaimed: 0, scheduled: 0, woken: 0, ran: [], alerts: 0, retained: 0, handedOff: 0,
      notified: 0,
      distilled: 0,
      screened: 0,
      stopped: false, errors: [],
    };

    // F5.8: a halted platform runs no work, and finds out within one polling
    // interval.
    //
    // Read narrowly, because the requirement is narrow: "semua task
    // `cancelled`; aksi in-flight tidak di-commit". It is about tasks and
    // about actions with effects in the world. Telling the owner what already
    // happened is neither -- it commits nothing on a company's behalf, spends
    // no budget, and runs no agent.
    //
    // The wider reading was the one in place, and it had a cost nobody chose:
    // the owner presses stop *because* something is wrong, and the platform
    // answers by stopping telling them what is wrong. An incident raised a
    // second before the stop would have sat undelivered until the stop was
    // lifted. F10.5 already bounds what may reach them -- an incident or a
    // tier 3 approval -- and `owner_notifications` bounds it to once, so what
    // arrives during a halt is exactly the backlog of things they most need.
    const halted = await isStopAllRequested();
    if (halted) report.stopped = true;

    const companies = this.#rotate(await this.#companies());

    if (halted) {
      for (const company of companies) await this.#notify(report, company, now);
      return report;
    }

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
      // One runtime failing its health check tells every later stage in this
      // tick the same thing, so the wake stage and the claim stage share the
      // answer rather than each discovering it. Without this a wake and a
      // claim both ran the same task and both got the same refusal.
      let runtimeDown = false;

      await this.#stage(report, 'wakes', async () => {
        const drained = await drainWakes(company, { holder: this.id, now });
        report.woken += drained.length;

        // A wake that found no claimable task has already been consumed and
        // costs nothing (F9.10). One that found a task hands it over here.
        const budget = this.#options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK;
        for (const wake of drained) {
          if (report.ran.length >= budget) break;
          if (!wake.taskId) continue;
          const status = await this.#runClaimed(report, company, wake.taskId);
          if (status === 'runtime_unavailable') {
            runtimeDown = true;
            break;
          }
        }
      });

      await this.#stage(report, 'claim', async () => {
        if (runtimeDown) return;
        const budget = (this.#options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK)
          - report.ran.length;
        for (let taken = 0; taken < budget; taken += 1) {
          const claim = await claimTask(company, { holder: this.id, now });
          if (!claim) break;
          const status = await this.#runClaimed(report, company, claim.taskId);
          // F13.8 puts the task straight back on the queue, so without this the
          // loop claims the *same* task again and spends the whole tick's
          // budget failing one health check. Stopping is also right for the
          // others: a runtime that is down is down for every task that names
          // it, and the next tick is when to find out it came back.
          if (status === 'runtime_unavailable') {
            runtimeDown = true;
            break;
          }
        }
      });

      await this.#stage(report, 'settle', async () => {
        await settleCompletedReviews(company);
        await inbox.expireOverdue(company);

        // F6.3: a completed task's output is what starts its successor, and
        // the engine is what starts it -- not the finishing agent naming who
        // to call. Driven from state, so a worker that was down when the task
        // completed still performs the handoff when it comes back.
        const rules = this.#options.handoffRules ?? [];
        if (rules.length > 0) {
          report.handedOff += (await processHandoffs(company, rules)).length;
        }
      });

      await this.#stage(report, 'watch', async () => {
        await evaluateSpendLimit(company, now);
        await evaluateCircuitBreakers(company, now);
        report.alerts += (await evaluateAlerts(company, now)).length;
      });

      // F10.5, F10.9. After `watch`, because that stage is what raises the
      // incidents and budget alerts this one delivers -- notifying before
      // them would tell the owner about this tick's news on the next tick.
      await this.#notify(report, company, now);

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

      // F4.5 and F15.3, on their own clock.
      //
      // Both were implemented, tested and called by nobody: memory grew
      // without ever becoming knowledge, and a skill candidate sat at
      // `candidate` for ever because the thing that screens one ran nowhere.
      // Hourly rather than per tick, because distillation reads a window of
      // events and costs a model call -- every tick would be paying for the
      // same reading over and over.
      //
      // After retention, deliberately: a sweep that has just removed expired
      // events should not then be read as though they were still there.
      await this.#learn(report, company, now);
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

      if (madeProgress(report) && !report.stopped) continue;

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
  /** Returns the outcome so the claim loop can decide whether to keep going. */
  async #runClaimed(
    report: TickReport,
    companyId: string,
    taskId: string,
  ): Promise<RunOutcome['status'] | null> {
    const roleSlug = await withTenant(companyId, async (tx) => {
      const task = await getTask(tx, taskId);
      if (!task) return null;
      const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [
        task.roleId,
      ]);
      return rows[0]?.slug ?? null;
    });
    if (!roleSlug) return null;

    const outcome = await this.#options.engine.runTask(companyId, taskId, roleSlug);
    report.ran.push({ taskId, status: outcome.status });
    return outcome.status;
  }

  /**
   * Starts each tick on a different company.
   *
   * `maxRunsPerTick` is a bound on the whole tick, not per company -- F5.8
   * wants a stop to bite within one polling interval, and a budget that grew
   * with the number of companies would not give that. But the loop always
   * started at the same company, so one with more work than the budget spent
   * all of it every tick and the companies behind it never got a claim stage at
   * all. Not delayed: starved, for as long as the first one stays busy.
   *
   * Rotating costs nothing and makes the bound fair over time rather than
   * fair per tick. Ten companies and a budget of eight means every company is
   * reached within two ticks, which at the default interval is ten seconds.
   */
  #rotate(companies: string[]): string[] {
    if (companies.length < 2) return companies;
    const start = this.#turn % companies.length;
    this.#turn = (this.#turn + 1) % companies.length;
    return [...companies.slice(start), ...companies.slice(0, start)];
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
  /**
   * Puts what is waiting in front of the owner (F10.5, F10.9).
   *
   * A method rather than lines in the loop because it runs from two places:
   * the ordinary tick, and a halted platform. The second is the reason it is
   * worth naming -- see the stop-all comment in `tick`.
   */
  /**
   * F4.5's distillation and F15.3's screening, for one company.
   *
   * Two things a platform is supposed to do on its own and this one did not.
   * Distillation turns what happened into what is known -- episodic events
   * into semantic facts, repeated facts into a procedure worth writing down.
   * Screening runs a skill candidate against its own eval cases before anyone
   * is asked to review it, so the review queue holds things that at least work.
   *
   * Both need a model. A deployment that has not configured one gets neither,
   * and says so at boot rather than quietly never learning anything.
   *
   * Per division, because that is the scope both functions take: a fact
   * learned in ops is an ops fact, and F4.6's scoping is not something to
   * flatten here.
   */
  async #learn(report: TickReport, company: string, now: Date): Promise<void> {
    const learning = this.#options.learning;
    if (!learning) return;

    const interval = learning.intervalMs ?? DEFAULT_LEARNING_INTERVAL_MS;
    const last = this.#learnedAt.get(company);
    if (last !== undefined && now.getTime() - last < interval) return;

    await this.#stage(report, 'learn', async () => {
      const scopes = await withTenant(company, async (tx) => {
        // Every division, and the company's oldest project to attribute the
        // memory to. A project belongs to a company rather than a division, so
        // there is no per-division one to pick -- what the scope is *for* is
        // F4.6's division scoping on the memory, and that comes from the
        // division id.
        const { rows } = await tx.query<{ division_id: string; project_id: string | null }>(
          `SELECT d.id AS division_id,
                  (SELECT p.id FROM projects p ORDER BY p.created_at LIMIT 1) AS project_id
             FROM divisions d
            ORDER BY d.slug`,
        );
        return rows.filter(
          (row): row is { division_id: string; project_id: string } => row.project_id !== null,
        );
      });

      for (const scope of scopes) {
        const distilled = await distillEpisodicToSemantic({
          companyId: company,
          projectId: scope.project_id,
          divisionId: scope.division_id,
          llm: learning.llm,
          model: learning.model,
          until: now,
        });
        report.distilled += distilled.factsCreated;

        // Only when there is something new to generalise from. A procedural
        // pass over facts that did not change would raise the same SOP
        // candidate again, and the owner would decline it again.
        if (distilled.factsCreated > 0) {
          const candidates = await distillSemanticToProcedural({
            companyId: company,
            projectId: scope.project_id,
            divisionId: scope.division_id,
            llm: learning.llm,
            model: learning.model,
          });
          report.distilled += candidates.length;
        }
      }

      // F15.3. Every candidate version, screened against its own cases before
      // a person is asked about it.
      const candidates = await withTenant(company, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "SELECT id FROM skill_versions WHERE state = 'candidate' ORDER BY created_at",
        );
        return rows.map((row) => row.id);
      });
      for (const versionId of candidates) {
        await screenCandidate(company, versionId);
        report.screened += 1;
      }

      // Recorded after the work rather than before it, for the same reason as
      // retention: a pass that threw has not happened.
      this.#learnedAt.set(company, now.getTime());
    });
  }

  async #notify(report: TickReport, company: string, now: Date): Promise<void> {
    const channels = this.#options.ownerChannels ?? [];
    if (channels.length === 0) return;

    await this.#stage(report, 'notify', async () => {
      for (const channel of channels) {
        const options = {
          now,
          ...(this.#options.ownerLinkFor ? { linkFor: this.#options.ownerLinkFor } : {}),
        };
        report.notified += (await dispatch(company, channel, options)).delivered;
        // A vendor is briefly unreachable more often than it is broken, and a
        // first attempt must not repeat while a retry must. `retryFailed` is
        // the only path that re-sends, and it only re-sends rows that were
        // claimed, never completed, and last tried long enough ago -- the two
        // run back to back in one tick, so without that wait two of the three
        // attempts would be spent milliseconds apart and a relay restarting
        // would exhaust the row before it came back.
        report.notified += (await retryFailed(company, channel, options)).delivered;
      }
    });
  }

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
