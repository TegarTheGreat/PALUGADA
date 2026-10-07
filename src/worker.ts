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
import {
  HEARTBEAT_EVERY_MS, beat, claimTask, giveBack, haltPastDeadlines, reclaimExpiredLeases, reclaimOrphans, releaseTask,
  liveHolders, silentHolders, stopBeating,
} from './engine/checkout.ts';
import { getTask } from './engine/tasks.ts';
import { sweepLeftoverProcesses } from './engine/process-ledger.ts';
import { withTenant } from './db/tenant.ts';
import { isStopAllRequested } from './engine/control.ts';
import { reportStranded } from './engine/liveness.ts';
import { reportEndedBadly } from './engine/ended.ts';
import { ensureTriage } from './engine/triage.ts';
import { ensureCollections } from './duties/collections.ts';
import { ensureOutcomes } from './engine/outcomes.ts';
import { runDueSchedules } from './scheduler/scheduler.ts';
import { drainWakes, scheduleHeartbeats } from './scheduler/wake.ts';
import { settleCompletedReviews } from './review/review.ts';
import { evaluateAlerts } from './reporting/alerts.ts';
import { evaluateCircuitBreakers, evaluateSpendLimit, isSpendPaused, thawCooledRoles } from './governance/spend-guard.ts';
import { startNewPeriods } from './engine/budget.ts';
import { resumeBudgetStopped } from './engine/self-heal.ts';
import * as inbox from './inbox/inbox.ts';
import { runRetention } from './retention/retention.ts';
import { embedBacklog } from './knowledge/meaning.ts';
import type { EmbedBinding } from './capabilities/embed.ts';
import { processHandoffs, type HandoffRule } from './engine/handoff.ts';
import { ownerHandoffRules } from './engine/handoff-rules.ts';
import {
  digestOwed,
  dispatch,
  dispatchDigest,
  dispatchDoneNotices,
  retryDigests,
  retryFailed,
  retractClosed,
  type OwnerChannel,
  type NotifiableItem,
} from './owner/notify.ts';
import { buildDailyDigest } from './reporting/digest.ts';
import { renderDailyDigest } from './owner/digest-said.ts';
import { deploymentLanguages } from './domain/language.ts';
import { moneyDisplay } from './domain/money-display.ts';
import {
  distillEpisodicToSemantic,
  distillSemanticToProcedural,
} from './memory/distillation.ts';
import { advanceSkillCandidates, settleSkillReviews } from './skills/skills.ts';
import type { LlmClient } from './llm/client.ts';
import { sleep } from './timers.ts';
import { eraseDueCompanies, removeWhatErasuresLeft, type ErasureDisk } from './governance/closing.ts';
import type { OtlpExporter } from './reporting/otlp.ts';
import { pollMailboxes, type MailOptions } from './chats/mail.ts';
import type { SecretManager } from './secrets/manager.ts';

export interface WorkerOptions {
  engine: Engine;
  /**
   * The deployment's provider of meaning (Tools): each tick gives a batch of
   * each company's passages their vectors, so its documents are found by
   * what they mean as well as by their words.
   */
  meaning?: EmbedBinding;
  /** Restrict to one company. Omitted means every company that is not frozen. */
  companyId?: string;
  /**
   * Where the deployment keeps what a company has outside its rows -- its
   * files, its charter's folder -- so an erasure removes those too (0096).
   * Omitted, an erasure removes the rows alone, which is what a test of rows
   * wants; a deployment passes the roots it was started with.
   */
  erasure?: ErasureDisk;
  /**
   * Where finished runs go as OpenTelemetry spans, when the operator named a
   * collector (0090). Sent by a worker that is not kept to one company.
   */
  telemetry?: Pick<OtlpExporter, 'export'>;
  /** How long to wait between ticks when a tick found nothing to do. */
  idleMs?: number;
  /** How many tasks one tick may run. Bounds how long a stop takes to bite. */
  maxRunsPerTick?: number;
  /**
   * How many tasks `start()` runs at once (L3).
   *
   * One ran a task at a time and did everything else between runs, so an
   * owner's P0 task waited behind whatever long run had started first, and
   * an approval past its expiry stayed open -- its task still waiting -- for
   * as long as that run took. Above one, the loop keeps one place for P0 work
   * alone, runs the rest in the others, and does its housekeeping on its own
   * clock. A division's own limit and its budget still bound what runs. One,
   * the default here, is the loop as `tick()` runs it; the deployment sets
   * its own (`PALUGADA_WORKER_CONCURRENCY`).
   */
  concurrency?: number;
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
  /** The same for a task, for the news that work the owner gave has finished (0059). */
  ownerTaskLinkFor?: (task: { companyId: string; taskId: string }) => string | null;
  signal?: AbortSignal;
  /**
   * Called when a whole tick fails, not when a stage does.
   *
   * A stage failure is on the returned report; this is for the case where
   * there is no report — the database went away mid-tick. It exists so a
   * deployment can log or alert without this module choosing a logger.
   */
  onTickError?: (error: Error) => void;
  /**
   * Where the worker says what happened, one structured entry at a time: a
   * tick that failed, a stage that failed, a task that ran. Absent means
   * nothing is said, which is what a test wants; a deployment passes a
   * writer of JSON lines, which is what a log collector reads.
   */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Customers' mailboxes (0113): where their passwords are sealed, and a
   * certificate authority to trust besides the system's. Omitted, no
   * mailbox is read.
   */
  mail?: MailOptions & { secrets: SecretManager };
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
  /** Daily digests sent to a channel this tick (F10.6). */
  digests: number;
  /**
   * Delivered messages rewritten because their item closed (migration 0036):
   * the buttons taken off a chat message the owner already answered elsewhere.
   */
  retracted: number;
  /** Facts distilled from events, and SOP candidates raised from them (F4.5). */
  distilled: number;
  /** Skill candidates screened against their own eval cases (F15.3). */
  screened: number;
  /** Tasks halted because their deadline passed while nobody was running them (F5.6). */
  pastDeadline: number;
  /** Work its budget stopped that went on by itself, its owner's ceiling having room again (src/engine/self-heal.ts). */
  resumed: number;
  /** Roles the breaker had stopped for a burst that has passed, and that went back to work by themselves. */
  thawed: number;
  /** Live tasks found with nothing left to move them, and put to the owner. */
  stranded: number;
  /** Root tasks that ended badly with nobody told, put to the coordinator and then the owner. */
  ended: number;
  /** Triage tasks made for the CEO, for tickets the company owes (src/engine/triage.ts). */
  triaged: number;
  /** Customers' overdue invoices looked at: reminders made into a task, or a card put to the owner (src/duties/collections.ts). */
  collections: number;
  /** Outcome tasks made for the CEO, for a measure that reached its target, passed its date or went unread (src/engine/outcomes.ts). */
  outcomes: number;
  /** Escalations handed to the role their division names (F2.1). */
  escalated: number;
  /** Run containers and agent CLIs' process groups that dead workers left, ended (`Adapter.sweep`, 0095). */
  leftovers: number;
  /** Passages of the company's documents given their vectors this tick (0087). */
  embedded: number;
  /** Companies erased this tick, their grace over (0088). */
  erased: number;
  /** Spans sent to the OpenTelemetry collector this tick (0090). */
  traced: number;
  /** Customers' mail that reached the company's work this tick (0113). */
  mail: number;
  /** Set when the platform stop is in effect: the tick did nothing else. */
  stopped: boolean;
  errors: Array<{ stage: string; message: string }>;
}

export const DEFAULT_IDLE_MS = 5_000;

/** How often a worker looks for what dead workers left running. */
const SWEEP_EVERY_MS = 60_000;
export const DEFAULT_MAX_RUNS_PER_TICK = 8;

/** The priority the place kept by a concurrent worker takes: the owner's urgent work (F5.10). */
export const URGENT_PRIORITY = 0;

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
function emptyReport(): TickReport {
  return {
    reclaimed: 0, scheduled: 0, woken: 0, ran: [], alerts: 0, retained: 0, handedOff: 0,
    notified: 0,
    digests: 0,
    retracted: 0,
    distilled: 0,
    screened: 0,
    pastDeadline: 0,
    resumed: 0,
    thawed: 0,
    stranded: 0,
    ended: 0,
    triaged: 0,
    collections: 0,
    outcomes: 0,
    escalated: 0,
    leftovers: 0,
    embedded: 0,
    erased: 0,
    traced: 0,
    mail: 0,
    stopped: false, errors: [],
  };
}

/**
 * What one worker has done since it started, for the metrics endpoint.
 *
 * Counted in the process rather than read from the tables, so a scrape costs
 * nothing, and they start again at zero with the process -- which is what a
 * scraper expects of a counter, and why a rate over them survives a restart.
 */
export interface WorkerCounts {
  /** The places runs are made in, and how many are running one now. */
  places: number;
  busy: number;
  /** Runs finished, by how they ended. */
  runs: ReadonlyMap<string, number>;
  /** Stages of a tick that failed, by stage. */
  stageFailures: ReadonlyMap<string, number>;
  /** Passes of the housekeeping loop, and of a place, that failed outright. */
  loopFailures: { tick: number; place: number };
}

export function madeProgress(report: TickReport): boolean {
  const ran = report.ran.some((run) => run.status !== 'runtime_unavailable');
  return ran || report.reclaimed > 0 || report.scheduled > 0 || report.mail > 0 || report.resumed > 0 || report.thawed > 0 || report.collections > 0;
}

export class Worker {
  readonly #options: WorkerOptions;
  readonly id: string;
  /** When this worker last ran the learning stage for each company. */
  readonly #learnedAt = new Map<string, number>();

  /** When each company's retention was last applied by *this* worker. */
  readonly #retainedAt = new Map<string, number>();
  /** When this worker last looked for what dead workers left running. */
  #sweptAt: number | null = null;
  /** Whether this worker has removed what earlier erasures left on disk. See the erasure stage. */
  #erasuresFinished = false;
  /** Which company this worker starts its tick on. See `#rotate`. */
  #turn = 0;
  #lastTickAt: Date | null = null;
  #startedAt: Date | null = null;
  readonly #runs = new Map<string, number>();
  readonly #stageFailures = new Map<string, number>();
  readonly #loopFailures = { tick: 0, place: 0 };
  #busy = 0;

  /**
   * When this worker last finished a tick, or null before its first.
   *
   * What a readiness check reads: a process that is up and whose loop has
   * stopped going round is the failure a supervisor cannot see from outside.
   */
  get lastTickAt(): Date | null {
    return this.#lastTickAt;
  }

  /**
   * When `start()` was called, or null before it was.
   *
   * What a readiness check measures from until the first tick finishes: a
   * first tick that hangs, or fails every time, leaves `lastTickAt` null for
   * ever, and a loop that never went round once is still a loop that stopped.
   */
  get startedAt(): Date | null {
    return this.#startedAt;
  }

  get counts(): WorkerCounts {
    return {
      places: this.#places(),
      busy: this.#busy,
      runs: new Map(this.#runs),
      stageFailures: new Map(this.#stageFailures),
      loopFailures: { ...this.#loopFailures },
    };
  }

  #places(): number {
    return Math.max(1, Math.floor(this.#options.concurrency ?? 1));
  }

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
  async tick(now = new Date(), options: { runs?: boolean } = {}): Promise<TickReport> {
    const report = emptyReport();
    // A concurrent worker runs its tasks in places of their own, and this
    // pass only looks after everything else (L3).
    const runs = options.runs ?? true;

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

    // Who has stopped saying it is alive, asked once a tick: their tasks come
    // back now, not when their leases run out (0079). A failure here costs
    // only the shortcut; the leases still expire.
    let silent: string[] = [];
    await this.#stage(report, 'heartbeat', async () => { silent = await silentHolders(this.id); });

    // What dead workers left running -- a container, or an agent CLI's
    // process group on this machine (0095) -- asked at most once a minute,
    // since listing containers is a call to the daemon. The first tick asks
    // at once, which is what ends a killed predecessor's CLI on a restart.
    // Alive is what beat lately, and this worker whatever its own beat says.
    if (this.#sweptAt === null || now.getTime() - this.#sweptAt >= SWEEP_EVERY_MS) {
      await this.#stage(report, 'leftovers', async () => {
        const alive = await liveHolders();
        alive.add(this.id);
        const removed = await this.#options.engine.adapters.sweep(alive);
        const companyId = this.#options.companyId;
        removed.push(...await sweepLeftoverProcesses(alive, { by: this.id, ...(companyId ? { companyId } : {}) }));
        this.#sweptAt = now.getTime();
        report.leftovers += removed.length;
        if (removed.length > 0) this.#options.log?.({ level: 'warn', event: 'leftovers.removed', removed });
      });
    }

    // A company whose grace is over is erased (0088), by whichever worker
    // gets there first: the company's row is locked and checked again under
    // the lock. Not by a worker kept to one company, which has no business
    // with another's.
    //
    // Each company on its own (0096): one that cannot be erased is named here
    // with its reason and waits before it is tried again, and the rest are
    // erased regardless. What an erased company kept on disk is removed after
    // its rows; what could not be is named too, and the rows stay erased.
    if (this.#options.companyId === undefined) {
      const disk = this.#options.erasure ?? {};
      // Once a process, what earlier erasures left on disk: one from before
      // files were removed, one whose process stopped between its rows and
      // its files, a removal that failed. A stage of its own, so a failure
      // here never holds back the erasures that are due.
      if (!this.#erasuresFinished) {
        await this.#stage(report, 'erasure', async () => {
          const left = await removeWhatErasuresLeft(disk);
          this.#erasuresFinished = true;
          for (const one of left) this.#failed(report, 'erasure', leftBehindSaid(one));
        });
      }
      await this.#stage(report, 'erasure', async () => {
        const pass = await eraseDueCompanies(disk);
        report.erased += pass.erased.length;
        for (const one of pass.erased) {
          this.#options.log?.({ level: 'info', event: 'company.erased', companyId: one.companyId, counts: one.counts });
        }
        for (const one of pass.failed) {
          this.#failed(report, 'erasure',
            `${one.name} (${one.companyId}) could not be erased${one.attempts > 0 ? ` (attempt ${one.attempts})` : ''}: ${one.reason}`
            + (one.retryAt ? `; tried again after ${one.retryAt.toISOString()}` : ''));
        }
        for (const one of pass.leftBehind) this.#failed(report, 'erasure', leftBehindSaid(one));
      });
    }

    const telemetry = this.#options.telemetry;
    if (telemetry && this.#options.companyId === undefined) {
      await this.#stage(report, 'telemetry', async () => {
        report.traced += await telemetry.export();
      });
    }

    for (const company of companies) {
      await this.#stage(report, 'reclaim', async () => {
        report.reclaimed += (await reclaimExpiredLeases(company, now, { silent })).length;
        report.reclaimed += (await reclaimOrphans(company, { now })).length;
        // After the reclaim, which is what returns a dead worker's task to
        // the queue for this to find.
        report.pastDeadline += (await haltPastDeadlines(company, now)).length;
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

    // Customers' mail (0113): each open mailbox that is due, read about once
    // a minute by whichever worker takes it first. Before the runs, so what a
    // customer wrote is work this tick can start. A mailbox that fails says
    // why on its channel, for the owner; here, for the operator's log.
    const mail = this.#options.mail;
    if (mail) {
      await this.#stage(report, 'mailboxes', async () => {
        const read = await pollMailboxes({
          ...mail, now, ...(this.#options.companyId ? { companyId: this.#options.companyId } : {}),
        });
        report.mail += read.received;
        if (read.failed > 0) this.#options.log?.({ level: 'warn', event: 'mailboxes.failed', failed: read.failed });
      });
    }

    for (const company of companies) {
      // One runtime failing its health check tells every later stage in this
      // tick the same thing, so the wake stage and the claim stage share the
      // answer rather than each discovering it. Without this a wake and a
      // claim both ran the same task and both got the same refusal.
      let runtimeDown = false;

      // The tickets the company owes, handed to the CEO to hand on. Before the
      // claim, so the task it makes can be taken up on this tick. Two queries
      // when nothing is owed: no task, no model call, no tokens. Not behind
      // `runs`: it makes a task and runs none, and a worker with places above
      // one ticks its housekeeping with `runs` false, where it never ran.
      await this.#stage(report, 'triage', async () => {
        if (await ensureTriage(company, now)) report.triaged += 1;
      });

      // What customers owe, looked at against the books: the reminders that
      // are due made into one task for the role that sends them, and the
      // invoices a letter will not mend put to the owner. A look is cheap and
      // is made at most every half hour for a company; nothing owed, nothing
      // made.
      await this.#stage(report, 'collections', async () => {
        const look = await ensureCollections(company, now);
        if (look.task !== null || look.escalated > 0 || look.nobody) report.collections += 1;
      });

      // The measures the owner set, looked at against their numbers: one task
      // for the CEO when one reached its target, passed its date or went
      // unread. Not behind `runs`: it makes a task and runs none, and a worker
      // with places above one (the default is four, main.ts) ticks its
      // housekeeping with `runs` false.
      await this.#stage(report, 'outcomes', async () => {
        if (await ensureOutcomes(company, now)) report.outcomes += 1;
      });

      if (runs) await this.#stage(report, 'wakes', async () => {
        const budget = this.#options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK;
        const drained = await drainWakes(company, {
          holder: this.id,
          now,
          maxClaims: Math.max(0, budget - report.ran.length),
        });
        report.woken += drained.length;

        // A wake that found no claimable task has already been consumed and
        // costs nothing (F9.10). One that found a task hands it over here.
        const claimed = drained.flatMap((wake) => (wake.taskId ? [wake.taskId] : []));
        let next = 0;
        while (next < claimed.length && !runtimeDown) {
          const status = await this.#runClaimed(report, company, claimed[next]!);
          next += 1;
          if (status === 'runtime_unavailable' || status === 'not_started') runtimeDown = true;
        }
        // Claims this tick will not run -- the runtime went down under them --
        // go straight back rather than holding their lanes and budget until
        // the lease runs out.
        for (const taskId of claimed.slice(next)) {
          await releaseTask(company, taskId, this.id);
        }
      });

      if (runs) await this.#stage(report, 'claim', async () => {
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
          if (status === 'runtime_unavailable' || status === 'not_started') {
            runtimeDown = true;
            break;
          }
        }
      });

      await this.#stage(report, 'settle', async () => {
        await settleCompletedReviews(company);
        // F15.3: skill candidates screened and given to a reviewer, and the
        // reviews that finished read -- every tick, so a skill is with the
        // owner soon after its reviewer answers. No model is needed here:
        // screening is the skill's own cases, and the review is a task that
        // runs like any other.
        await settleSkillReviews(company);
        report.screened += (await advanceSkillCandidates(company)).screened;
        await inbox.expireOverdue(company);
        // After the two above, which are what normally move a waiting task:
        // anything still waiting with nothing left to move it is stranded,
        // and the owner is asked once what to do with it.
        report.stranded += await reportStranded(company, now);
        // And what ended badly with nobody told: the coordinator asked first,
        // the owner after its grace (src/engine/ended.ts).
        report.ended += await reportEndedBadly(company, now);

        // A question for a person who has not answered in a day is brought to
        // the owner; before the notify stage, which then carries it.
        await inbox.escalateQuestions(company, now);

        // F6.3: a completed task's output is what starts its successor, and
        // the engine is what starts it -- not the finishing agent naming who
        // to call. Driven from state, so a worker that was down when the task
        // completed still performs the handoff when it comes back.
        // The deployment's rules in code, and the ones the owner set (0058).
        const rules = [...(this.#options.handoffRules ?? []), ...await ownerHandoffRules(company)];
        if (rules.length > 0) {
          report.handedOff += (await processHandoffs(company, rules)).length;
        }
      });

      await this.#stage(report, 'watch', async () => {
        // A passed month's counts start again before anything reads them (0101).
        await startNewPeriods(company);
        await evaluateSpendLimit(company, now);
        // After the pause is read: a month that began, or a ceiling raised, is
        // what the work it stopped was waiting for, and goes on in the same look.
        report.resumed += (await resumeBudgetStopped(company, now)).continued;
        // Before the breaker looks: a role whose burst has passed goes back to
        // work, and a role still above the line is stopped again if it must be.
        report.thawed += (await thawCooledRoles(company, now)).length;
        await evaluateCircuitBreakers(company, now);
        report.alerts += (await evaluateAlerts(company, now)).length;
      });

      // F2.1. Before `notify`, because an escalation whose named role cannot
      // take it goes to the owner at once, and should go on this tick.
      await this.#stage(report, 'escalate', async () => {
        report.escalated += await inbox.handEscalations(company);
      });

      // F10.5, F10.9. After `watch`, because that stage is what raises the
      // incidents and budget alerts this one delivers -- notifying before
      // them would tell the owner about this tick's news on the next tick.
      await this.#notify(report, company, now);

      // One batch of passages a company a tick, so a hundred-page upload is
      // given its meaning over a minute or two rather than holding one tick
      // on a provider. A provider that is down costs only this stage: the
      // documents are still found by their words.
      const meaning = this.#options.meaning;
      if (meaning) {
        await this.#stage(report, 'meaning', async () => {
          report.embedded += await embedBacklog(company, meaning);
        });
      }

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
    this.#startedAt = new Date();
    const signal = this.#options.signal;
    const idle = this.#options.idleMs ?? DEFAULT_IDLE_MS;

    // Said on a timer of its own, not once a tick: a tick can spend minutes on
    // one run, and a worker busy with a long task is not a worker that died.
    const alive = async () => {
      try {
        await beat(this.id);
      } catch (error) {
        this.#options.log?.({ level: 'warn', event: 'heartbeat.failed', message: (error as Error).message });
      }
    };
    await alive();
    const beating = setInterval(() => void alive(), HEARTBEAT_EVERY_MS);
    beating.unref();
    const places = this.#places();
    try {
      if (places === 1) {
        await this.#loop(signal, idle, true);
      } else {
        // The housekeeping on its own clock, and the runs in their places:
        // the first kept for P0 work, so there is always room for it.
        await Promise.all([
          this.#loop(signal, idle, false),
          ...Array.from({ length: places }, (_, place) => this.#place(signal, idle, place === 0)),
        ]);
      }
    } finally {
      clearInterval(beating);
      // Stopped cleanly, its tasks were handed back already; its word is taken
      // back so it is not mistaken for a worker that died.
      await stopBeating(this.id).catch(() => undefined);
    }
  }

  async #loop(signal: AbortSignal | undefined, idle: number, runs: boolean): Promise<void> {
    while (!signal?.aborted) {
      let report: TickReport;
      try {
        report = runs ? await this.tick() : await this.tick(undefined, { runs: false });
        this.#lastTickAt = new Date();
        this.#say(report);
      } catch (error) {
        // A tick can fail outside any stage — the database went away, the
        // platform-stop read threw. Sleeping and trying again is right for a
        // daemon: a transient blip should cost one interval, not the worker.
        // A permanent failure keeps failing and stays visible in the logs
        // rather than leaving a process that exited for reasons nobody saw.
        this.#loopFailures.tick += 1;
        this.#options.onTickError?.(error as Error);
        this.#options.log?.({ level: 'error', event: 'tick.failed', message: (error as Error).message });
        await sleep(idle, signal);
        continue;
      }

      if (madeProgress(report) && !report.stopped) continue;

      await sleep(idle, signal);
    }
  }

  /**
   * One place a concurrent worker runs tasks in: claims the next task across
   * its companies, runs it, and goes straight round again; sleeps only when
   * there was nothing to claim. `urgent` keeps the place for P0 work alone.
   *
   * No wake is drained by the urgent place: a wake names a role, not a
   * priority, and taking one there would give the place to routine work.
   */
  async #place(signal: AbortSignal | undefined, idle: number, urgent: boolean): Promise<void> {
    while (!signal?.aborted) {
      let ran = false;
      try {
        if (!(await isStopAllRequested())) {
          for (const company of this.#rotate(await this.#companies())) {
            const taskId = await this.#claimOne(company, urgent);
            if (!taskId) continue;
            const report = emptyReport();
            const status = await this.#runClaimed(report, company, taskId);
            this.#say(report);
            // A runtime that is down puts its task back; trying again at once
            // would spend this place on the same refusal.
            ran = status !== null && status !== 'runtime_unavailable' && status !== 'not_started';
            break;
          }
        }
      } catch (error) {
        this.#loopFailures.place += 1;
        this.#options.log?.({ level: 'error', event: 'place.failed', message: (error as Error).message });
      }
      if (!ran) await sleep(idle, signal);
    }
  }

  /** The next task for a place, from a wake first as a tick takes it, or null. */
  async #claimOne(companyId: string, urgent: boolean): Promise<string | null> {
    if (!urgent) {
      const drained = await drainWakes(companyId, { holder: this.id, now: new Date(), maxClaims: 1 });
      const woken = drained.find((wake) => wake.taskId)?.taskId;
      if (woken) return woken;
    }
    const claim = await claimTask(companyId, {
      holder: this.id, now: new Date(), ...(urgent ? { priorityAtMost: URGENT_PRIORITY } : {}),
    });
    return claim?.taskId ?? null;
  }

  /**
   * What a tick did that somebody operating this should read.
   *
   * A stage that failed used to go into the report, and the report into
   * nothing: `start()` never looked at it, so a notifier failing on every
   * tick for a week looked, from outside, exactly like a notifier with
   * nothing to send.
   */
  #say(report: TickReport): void {
    const log = this.#options.log;
    if (!log) return;
    for (const failure of report.errors) {
      log({ level: 'error', event: 'stage.failed', stage: failure.stage, message: failure.message });
    }
    for (const run of report.ran) {
      log({
        level: run.status === 'failed' || run.status === 'halted' ? 'warn' : 'info',
        event: 'task.ran', taskId: run.taskId, status: run.status,
      });
    }
  }

  /**
   * Runs a task this worker has already claimed.
   *
   * The role slug is read here rather than carried on the claim, because a
   * claim is about the lease and the engine's contract is about the role — and
   * a claim that carried a stale slug would run the task as something it is
   * not.
   */
  /**
   * Returns the outcome so the claim loop can decide whether to keep going:
   * `not_started` when the engine could not start the task, which stops this
   * tick's claims as a runtime that is down does -- claiming again at once
   * would take the same task back into the same failure.
   */
  async #runClaimed(
    report: TickReport,
    companyId: string,
    taskId: string,
  ): Promise<RunOutcome['status'] | 'not_started' | null> {
    const roleSlug = await withTenant(companyId, async (tx) => {
      const task = await getTask(tx, taskId);
      if (!task) return null;
      const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [
        task.roleId,
      ]);
      return rows[0]?.slug ?? null;
    });
    if (!roleSlug) return null;

    this.#busy += 1;
    let outcome: RunOutcome;
    try {
      outcome = await this.#options.engine.runTask(companyId, taskId, roleSlug);
    } catch (error) {
      // What the engine threw before its run's own handling began -- the
      // database refusing a write as the contract was read or the task moved
      // (M1). Left, the task stayed checked out to this worker, which was not
      // running it, unrenewed for a whole lease with no reason anywhere. Given
      // back now, with why, and counted as a loss: a task that can never start
      // halts as a crash loop with an incident rather than taking every
      // worker's place in turn. If the database is still away, the lease is
      // the backstop it always was.
      const message = (error as Error).message;
      this.#failed(report, 'run', `task ${taskId}: ${message}`);
      await giveBack(companyId, taskId, this.id, `the worker could not start it: ${message}`).catch(() => undefined);
      return 'not_started';
    } finally {
      this.#busy -= 1;
    }
    this.#runs.set(outcome.status, (this.#runs.get(outcome.status) ?? 0) + 1);
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

    const interval = learning?.intervalMs ?? DEFAULT_LEARNING_INTERVAL_MS;
    const last = this.#learnedAt.get(company);
    if (last !== undefined && now.getTime() - last < interval) return;

    await this.#stage(report, 'learn', async () => {
      // Skill candidates are screened in the settle stage, every tick and
      // without a model. Distillation needs one, so a deployment without a
      // model reads nothing here.
      if (!learning) {
        this.#learnedAt.set(company, now.getTime());
        return;
      }
      // Learning is spending, now that it is counted (N8): a company paused
      // at its month's ceiling does not go on paying a model to distil. Not
      // marked as learned, so it reads its history once resumed; the
      // watermark has kept its place.
      if (await isSpendPaused(company, now)) return;

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
        // One division at a time and each on its own: one whose model answered
        // nonsense, or whose rows the store refused, ended the stage, so the
        // divisions after it in slug order were never reached on any tick (the
        // audit of 6 October, M7). Its failure is still said, and it is read
        // again at the next pass, for nothing of it was consumed.
        await this.#stage(report, 'learn', async () => {
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
        });
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
        // And the other end of a message's life. A chat message with Approve
        // on it is still a way to decide after the item has closed -- decided
        // in the console, expired, withdrawn when the stop button cancelled its
        // task -- so it is rewritten to say which. Here, inside the notify
        // stage, because the stop button is exactly when this matters and the
        // notify stage is the one a halt still runs.
        report.retracted += (await retractClosed(company, channel, { now })).retracted;
      }

      // F10.6, once a day, to whichever channels take one.
      //
      // Yesterday's, not today's: a digest of a day still in progress is a
      // partial count that changes if you read it twice, and the point of a
      // daily digest is that it is the account of a day that finished. The
      // delivery record is keyed on the day, so a worker restarted twice in an
      // afternoon still sends one.
      //
      // Inside the notify stage rather than beside it, because it is the same
      // failure if it throws: the owner does not hear from the platform.
      const takers = channels.filter((channel) => channel.deliverDigest);
      if (takers.length > 0) {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
        const day = yesterday.toISOString().slice(0, 10);
        // Asked *before* the digest is built. `buildDailyDigest` is several
        // aggregates over a day of events, and running it every tick to throw
        // the answer away on a uniqueness conflict is a query a minute, all
        // day, for one message.
        const owed = await digestOwed(company, takers, day);
        if (owed.length > 0) {
          const digest = await buildDailyDigest(company, yesterday);
          const sent = await dispatchDigest(company, owed, {
            day: digest.day,
            text: renderDailyDigest(digest, (await deploymentLanguages()).console, await moneyDisplay()),
          });
          report.digests += sent.delivered;
        }

        // And back to any whose transport was unreachable. `retryFailed` above
        // cannot see these: it joins `inbox_items`, and a digest has no row
        // there. Without this a relay that was restarting when the digest went
        // out lost that day for ever.
        report.digests += (await retryDigests(company, takers, { now })).delivered;
      }

      // And the news the owner is waiting for: work they gave has finished.
      report.notified += (await dispatchDoneNotices(company, channels, {
        now,
        ...(this.#options.ownerTaskLinkFor ? { linkFor: this.#options.ownerTaskLinkFor } : {}),
      })).delivered;
    });
  }

  async #stage(report: TickReport, stage: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.#failed(report, stage, (error as Error).message ?? String(error));
    }
  }

  /**
   * A failure in a stage, said on the tick and counted: what a stage throws,
   * and what one that carried on past a part of its work reports of it.
   */
  #failed(report: TickReport, stage: string, message: string): void {
    report.errors.push({ stage, message });
    this.#stageFailures.set(stage, (this.#stageFailures.get(stage) ?? 0) + 1);
    // Reported on the tick rather than written to the event log: the log is
    // tenant-scoped and a stage failure is the platform's, not a company's.
    // A caller that wants it durable has the report; inventing a company to
    // file it against would put the platform's problem in somebody's audit
    // trail.
  }
}

/** What an erased company kept on disk and could not be removed, said so the operator can remove it. */
function leftBehindSaid(one: { companyId: string; path: string; reason: string }): string {
  return `company ${one.companyId} was erased, and ${one.path} was not removed: ${one.reason}; `
    + 'the next worker to start tries again, or remove it by hand';
}

/** Convenience for a process that just wants to run until it is stopped. */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const worker = new Worker(options);
  await worker.start();
}
