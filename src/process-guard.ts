/**
 * What the process does with a failure nothing handled (L2, the audit of
 * 30 September).
 *
 * Nothing listened for `unhandledRejection` or `uncaughtException`, so Node's
 * default applied to both and the process died where it stood. One promise
 * nobody awaited -- a notice to a chat, a sweep that lost the database for a
 * moment -- took the console and the worker with it: every run cut off rather
 * than handed back, each to come back only when its lease ran out, and
 * counted as a lost worker. The two are not the same failure, and are not
 * answered the same way.
 *
 * **A rejection nothing awaited is said, and the process goes on.** It is a
 * piece of work whose failure nobody was waiting to hear: the work it
 * belonged to has already moved on, and everything else the process is doing
 * is as sound as it was.
 *
 * **An exception nothing caught stops the process**, the way a signal does --
 * readiness says no, the console closes, the worker hands its runs back --
 * and it exits 1 for the supervisor to start a clean one. A throw that
 * unwound a stack this code did not expect leaves state nobody can vouch for,
 * and carrying on would be guessing. A stop that does not finish in time does
 * not keep a broken process alive.
 *
 * What is written is redacted: a failure's message can carry a credential.
 */
import { redactor } from './secrets/manager.ts';

export interface GuardOptions {
  /** Where the line goes: the process's standard error. */
  write: (line: string) => void;
  /** Stops the deployment as a signal does. */
  stop: () => Promise<void>;
  /** Ends the process. */
  exit: (code: number) => void;
  /** How long the stop may take before the process ends anyway. */
  stopWithinMs?: number;
}

/** Listens for both, and returns what takes the listeners off again. */
export function guardProcess(options: GuardOptions): () => void {
  let stopping = false;
  const rejected = (reason: unknown) => {
    options.write(`palugada: a failure nothing handled, and the process goes on: ${told(reason)}\n`);
  };
  const thrown = (error: unknown) => {
    options.write(`palugada: an exception nothing caught, so the process stops: ${told(error)}\n`);
    // A second one while stopping: the stop is what is failing.
    if (stopping) {
      options.exit(1);
      return;
    }
    stopping = true;
    const deadline = setTimeout(() => options.exit(1), options.stopWithinMs ?? 30_000);
    deadline.unref();
    options.stop().catch((failure: unknown) => {
      options.write(`palugada: stop failed: ${told(failure)}\n`);
    }).finally(() => {
      clearTimeout(deadline);
      options.exit(1);
    });
  };
  process.on('unhandledRejection', rejected);
  process.on('uncaughtException', thrown);
  return () => {
    process.off('unhandledRejection', rejected);
    process.off('uncaughtException', thrown);
  };
}

function told(reason: unknown): string {
  const text = reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
  return redactor.redact(text);
}
