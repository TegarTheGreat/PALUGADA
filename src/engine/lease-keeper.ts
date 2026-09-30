/**
 * Keeps one run's lease while the run is in flight (PRD v2 F5.12).
 *
 * The lease used to be renewed only when a step committed, on the argument
 * that a committed step is proof the worker is alive and a timer is one more
 * thing that can run while the work is not. Both halves are true, and the
 * conclusion was not: one step can be long -- a child task awaited for as
 * long as its own timeout, an agent CLI working for ten minutes before its
 * first tool call -- and a lease that lapsed in the middle of one handed the
 * task to another replica while this one was still running it.
 *
 * So this renews on a timer, and answers the objection by bounding the timer
 * with the work rather than with the process. It covers the run up to one
 * lease past the last sign of progress, or up to a deadline the run is known
 * to be waiting on, and no further. A handler stuck on a promise that will
 * never settle stops being covered, its lease lapses, and the task goes back
 * to the queue -- which is the thing a lease is for.
 *
 * A renewal that finds the lease gone is final: the run is aborted, and every
 * later `confirm()` refuses, so no further step starts and no finished one is
 * committed against a task that is someone else's now.
 *
 * So is a whole lease with no renewal that succeeded. Only a lost lease used
 * to count: a connection dropped or a pool exhausted was left to the next
 * tick for ever, and a renewal that never answered kept every later tick
 * waiting on it. A worker cut off from its database went on running the task
 * while the lease lapsed in the database and another worker took it, and
 * both made the same side effects. The database sets a renewed lease to run
 * out one lease after the renewal was asked for, so a whole lease since the
 * last renewal that succeeded began is a lease that may have lapsed.
 */
import { isPalugadaError, PalugadaError } from '../errors.ts';

export interface LeaseKeeperOptions {
  /** Renews the lease; throws `task.lease_lost` when it is not ours any more. */
  renew: () => Promise<void>;
  /** Called once, when the lease is found to be lost. */
  onLost: () => void;
  /**
   * Called once, when the run has gone a whole lease without progress and
   * the keeper stops covering it -- while this worker still holds the lease,
   * so the run can be stopped before the lease lapses and another worker
   * takes the task. It used to stop renewing and say nothing, and the run
   * carried on beside the next worker's.
   */
  onSilent?: () => void;
  leaseMs: number;
  /** Until when the run is covered before it has shown any progress. */
  coverUntil: number;
}

export class LeaseKeeper {
  readonly #renew: () => Promise<void>;
  readonly #onLost: () => void;
  readonly #onSilent: (() => void) | undefined;
  #silent = false;
  readonly #leaseMs: number;
  #coverUntil: number;
  #timer: NodeJS.Timeout | undefined;
  #renewing = false;
  #stopped = false;
  #lost: PalugadaError | null = null;
  /**
   * When the latest renewal that succeeded was begun. The lease was taken
   * just before the keeper was made, so it starts as the time it was made.
   */
  #renewedAt = Date.now();

  constructor(options: LeaseKeeperOptions) {
    this.#renew = options.renew;
    this.#onLost = options.onLost;
    this.#onSilent = options.onSilent;
    this.#leaseMs = options.leaseMs;
    this.#coverUntil = options.coverUntil;
  }

  /** Whether a renewal has found the lease held by someone else. */
  get lost(): boolean {
    return this.#lost !== null;
  }

  /**
   * Renews three times a lease, so one failed renewal -- a database that
   * blinked -- leaves two more chances before the lease runs out.
   */
  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => void this.#tick(), Math.max(1, Math.floor(this.#leaseMs / 3)));
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The run moved: it is covered for one more lease from now. */
  progressed(): void {
    this.cover(Date.now() + this.#leaseMs);
  }

  /** The run is waiting on something bounded by `until`, and is covered to it. */
  cover(until: number): void {
    this.#coverUntil = Math.max(this.#coverUntil, until);
  }

  /** Renews now, and throws if the lease is gone. */
  async confirm(): Promise<void> {
    // Checked here as well as on the timer, because this comes before a side
    // effect: a timer held up behind other work has not looked yet.
    this.#checkDeadline();
    if (this.#lost) throw this.#lost;
    await this.#renewOnce();
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#lost) return;
    // Before the check for a renewal in flight, because a renewal that never
    // answers is in flight for ever, and a tick that stopped there never
    // looked at the time again.
    this.#checkDeadline();
    if (this.#lost || this.#renewing) return;
    if (Date.now() > this.#coverUntil) {
      if (!this.#silent) {
        this.#silent = true;
        this.#onSilent?.();
      }
      return;
    }
    this.#renewing = true;
    try {
      await this.#renewOnce();
    } catch {
      // Anything but a lost lease -- a connection dropped, a pool exhausted --
      // is left to the next tick, because the lease still has two ticks of
      // time; the deadline above is what ends the wait if none succeeds.
    } finally {
      this.#renewing = false;
    }
  }

  /** One renewal, which moves the deadline only when it succeeds. */
  async #renewOnce(): Promise<void> {
    const begun = Date.now();
    try {
      await this.#renew();
    } catch (error) {
      if (isPalugadaError(error, 'task.lease_lost')) this.#markLost(error);
      throw error;
    }
    this.#renewedAt = Math.max(this.#renewedAt, begun);
  }

  /**
   * Gives the run up when a whole lease has passed since the last renewal
   * that succeeded began. Not once it has gone quiet: then the keeper stopped
   * renewing on purpose, and the engine is handing the task back while this
   * worker still holds it.
   */
  #checkDeadline(): void {
    if (this.#stopped || this.#lost || this.#silent) return;
    if (Date.now() - this.#renewedAt < this.#leaseMs) return;
    this.#markLost(new PalugadaError('task.lease_lost',
      `no renewal of the lease succeeded for ${lengthOf(this.#leaseMs)}, a whole lease: it may have lapsed, `
        + 'and another worker may hold the task',
      { leaseMs: this.#leaseMs }));
  }

  #markLost(error: PalugadaError): void {
    if (this.#lost || this.#stopped) return;
    this.#lost = error;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#onLost();
  }
}

function lengthOf(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} seconds`;
  return `${ms} ms`;
}
