/**
 * Timers for deadlines further away than a timer can wait.
 *
 * `setTimeout` takes its delay as a 32-bit signed integer. Anything past
 * 2^31 - 1 milliseconds -- a little under twenty-five days -- is not waited
 * for: Node prints a warning and fires the callback after one millisecond. A
 * task whose deadline was a month out had its run cancelled as overdue the
 * moment it started, and a parent awaiting a child with a month's timeout
 * halted the child at once.
 *
 * So a long delay is waited for in steps, re-armed against the wall clock,
 * and fires once the clock says it is due.
 */

/** The longest delay `setTimeout` honours. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface LongTimer {
  clear(): void;
  /** As `Timeout.unref`: the timer alone does not keep the process alive. */
  unref(): LongTimer;
}

export function setLongTimeout(callback: () => void, delayMs: number): LongTimer {
  const due = Date.now() + Math.max(0, delayMs);
  let timer: NodeJS.Timeout;
  let unrefd = false;
  const arm = () => {
    const left = Math.max(0, due - Date.now());
    timer = left > MAX_TIMER_MS ? setTimeout(arm, MAX_TIMER_MS) : setTimeout(callback, left);
    if (unrefd) timer.unref();
  };
  arm();
  const handle: LongTimer = {
    clear: () => clearTimeout(timer),
    unref: () => {
      unrefd = true;
      timer.unref();
      return handle;
    },
  };
  return handle;
}

/**
 * Waits `ms`, or less if the signal fires first -- including a signal that
 * had already fired, which `addEventListener` alone never reports.
 *
 * The listener is removed when the timer wins. A long-lived signal -- the
 * worker's shutdown signal, a run's abort signal -- would otherwise collect
 * one listener per wait until Node warned about a leak, which it would be.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', wake);
      resolve();
    }, ms);
    signal?.addEventListener('abort', wake, { once: true });
  });
}
