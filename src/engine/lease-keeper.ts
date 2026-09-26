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
 */
import { isPalugadaError, type PalugadaError } from '../errors.ts';

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
    if (this.#lost) throw this.#lost;
    try {
      await this.#renew();
    } catch (error) {
      if (isPalugadaError(error, 'task.lease_lost')) this.#markLost(error);
      throw error;
    }
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#lost || this.#renewing) return;
    if (Date.now() > this.#coverUntil) {
      if (!this.#silent) {
        this.#silent = true;
        this.#onSilent?.();
      }
      return;
    }
    this.#renewing = true;
    try {
      await this.#renew();
    } catch (error) {
      // Anything but a lost lease -- a connection dropped, a pool exhausted --
      // is left to the next tick. The lease still has two ticks of time.
      if (isPalugadaError(error, 'task.lease_lost')) this.#markLost(error);
    } finally {
      this.#renewing = false;
    }
  }

  #markLost(error: PalugadaError): void {
    if (this.#lost || this.#stopped) return;
    this.#lost = error;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#onLost();
  }
}
