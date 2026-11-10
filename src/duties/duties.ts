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
 * makes the task with a key that starts `duty:`, and the engine runs the duty
 * that key names on `DutyRuntime`, whatever runtime its role names; the
 * owner's "Run again" of it is the same duty (`dutyOf`). An agent that
 * delegates a task cannot give it such a key, and one that writes `duty` in
 * its input only writes a field.
 */
import { withTenant } from '../db/tenant.ts';
import type { TaskContext, TaskHandler } from '../runtime/in-process.ts';
import type { Adapter, AdapterHealth, AdapterResult, ExecutionBackend, RunRequest, RunServices } from '../runtime/protocol.ts';
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

/**
 * The duty a task does: its own, or -- for the owner's "Run again", whose key
 * is `rerun:<the task it reruns>` (`rerunTask`) -- the duty of the task it does
 * again, followed back through reruns of reruns. Without it a rerun of a duty
 * was its role's work, and a model was handed the duty's input as a brief.
 */
export async function dutyOf(companyId: string, task: Pick<TaskRow, 'idempotencyKey'>): Promise<TaskHandler | null> {
  const own = dutyFor(task);
  if (own || !task.idempotencyKey.startsWith('rerun:')) return own;
  // The CASE, not a WHERE beside the join: it is what keeps a key that is not
  // a rerun's from ever being read as an id.
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ key: string }>(
    `WITH RECURSIVE back AS (
       SELECT $1::text AS key, 0 AS depth
       UNION ALL
       SELECT t.idempotency_key, back.depth + 1
         FROM back JOIN tasks t
           ON t.id = CASE WHEN back.key ~ '^rerun:[0-9a-f-]{36}$' THEN substr(back.key, 7)::uuid END
        WHERE back.depth < 16
     )
     SELECT key FROM back ORDER BY depth DESC LIMIT 1`, [task.idempotencyKey]));
  return rows[0] ? dutyFor({ idempotencyKey: rows[0].key }) : null;
}

/**
 * Where every duty runs, whatever runtime its role names: the engine chooses
 * it before it looks at the role's (engine.ts).
 *
 * A duty is the platform's own procedure, so the role's runtime is not the
 * one to run it. Handed to an agent CLI, a container or a person, the duty's
 * input was a brief, and whoever got it decided for itself whether and how
 * often to write to customers; and a deployment with no model key, whose
 * in-process runtime is not there, could not run it at all. It needs no
 * model, so it is always here.
 */
export class DutyRuntime implements Adapter {
  readonly name = 'duty';
  readonly backends: readonly ExecutionBackend[] = ['local'];
  readonly #duty: TaskHandler;

  constructor(duty: TaskHandler) {
    this.#duty = duty;
  }

  /** It is this process doing what the platform wrote, so it is as healthy as the process asking. */
  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: 'duty' };
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    const ctx: TaskContext = {
      task: request.task,
      signal: services.signal,
      step: services.step,
      callCapability: (name, input) => services.callTool(name, input),
      awaitChild: (roleSlug, input, options) => services.awaitChild(roleSlug, input, options),
      // Nothing a duty does is a model's: one that asked would be a role's work.
      llm: () => Promise.reject(new Error('a duty asks no model; work that needs one is a role\'s')),
    };
    return { output: await this.#duty(ctx), writtenBy: 'code' };
  }
}
