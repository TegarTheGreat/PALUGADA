/**
 * Duties: office work the platform does itself, from what the company's own
 * records say (the owner's request of 7 October: white-collar work handled,
 * and automatically).
 *
 * A role works by asking a model what to do next. Most of an office's routine
 * is not that: an invoice is past its due date, a letter is owed, and the
 * letter is the same letter. Running a model over it costs tokens, can get it
 * wrong, and needs an owner's yes for what a model wrote. A duty is the other
 * way to do the same job: a procedure the platform wrote, run under a role's
 * grants -- so the credentials, the tiers, the plan, the journal, the budget
 * and the audit all apply exactly as they do to a role -- with no model in it.
 *
 * What makes a task a duty is how it began, not what it says. The platform
 * makes the task with a key that starts `duty:`, and the in-process runtime
 * runs the duty that key names. An agent that delegates a task cannot give it
 * such a key, and one that writes `duty` in its input only writes a field.
 */
import type { TaskHandler } from '../runtime/in-process.ts';
import type { TaskRow } from '../engine/tasks.ts';
import { collectionsDuty } from './collections.ts';

/** The start of the key of every task a duty began. */
export const DUTY_KEY_PREFIX = 'duty:';

const DUTIES: ReadonlyMap<string, TaskHandler> = new Map([
  ['collections', collectionsDuty],
]);

/** The duty a task was made to do, or null for any other task. */
export function dutyFor(task: Pick<TaskRow, 'idempotencyKey'>): TaskHandler | null {
  if (!task.idempotencyKey.startsWith(DUTY_KEY_PREFIX)) return null;
  const name = task.idempotencyKey.slice(DUTY_KEY_PREFIX.length).split(':')[0] ?? '';
  return DUTIES.get(name) ?? null;
}
