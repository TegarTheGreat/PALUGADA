/**
 * Dry-run replay (PRD F5.9).
 *
 * Re-runs a task's handler against its recorded journal so an operator can see
 * what it did without doing any of it again. The point is debugging: watching
 * the decisions unfold with the same inputs, after the fact.
 *
 * The single property that makes this safe is that nothing external is
 * reachable. There is no broker here, no model client and no capability
 * adapter -- not "one that is disabled", but none wired in at all. A dry run
 * that could touch the world under some flag would eventually touch it, and a
 * replay of a task that bought a domain must never buy the domain again.
 *
 * Every step is served from the journal. When the handler asks for a step the
 * original run never took, that is not an error to paper over: it is a
 * divergence, and it is the most useful thing a replay can tell you, because
 * it means the code no longer does what it did when the journal was written.
 */
import { withTenant } from '../db/tenant.ts';
import { getTask, type TaskRow } from './tasks.ts';
import { hashInput } from './hash.ts';
import type { StepKind } from './journal.ts';

export interface ReplayedStep {
  index: number;
  name: string;
  kind: StepKind;
  output: unknown;
  /** True when the handler asked for this step with a different input. */
  inputChanged: boolean;
}

export interface Divergence {
  index: number;
  /** What the handler asked for. */
  requested: { name: string; kind: StepKind };
  /** What the journal holds at that position, if anything. */
  recorded: { name: string; kind: StepKind } | null;
  reason: 'missing_step' | 'different_step' | 'different_input';
}

export interface ReplayReport {
  taskId: string;
  status: TaskRow['status'];
  /** Steps served from the journal, in the order the handler asked for them. */
  steps: ReplayedStep[];
  divergences: Divergence[];
  /** The handler's return value, or the error it ended with. */
  output: Record<string, unknown> | null;
  error: string | null;
  /** Steps in the journal the handler never asked for. */
  unusedSteps: number;
}

export interface ReplayContext {
  readonly task: TaskRow;
  step<T>(name: string, kind: StepKind, input: unknown, fn?: unknown): Promise<T>;
  callCapability<I, O>(name: string, input: I): Promise<O>;
  llm(request: { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<string>;
}

export type ReplayHandler = (ctx: ReplayContext) => Promise<Record<string, unknown>>;

interface JournalStep {
  step_index: number;
  name: string;
  kind: StepKind;
  input_hash: string;
  output: unknown;
}

/**
 * Replays a task's handler against its journal.
 *
 * `handler` is the same function the engine would run. It is given a context
 * whose methods look identical to the real one but read from the journal, so a
 * handler needs no knowledge that it is being replayed -- and therefore cannot
 * behave differently when it is.
 */
export async function replayTask(
  companyId: string,
  taskId: string,
  handler: ReplayHandler,
): Promise<ReplayReport> {
  const { task, journal } = await withTenant(companyId, async (tx) => {
    const task = await getTask(tx, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    const { rows } = await tx.query<JournalStep>(
      `SELECT step_index, name, kind, input_hash, output
         FROM task_steps
        WHERE task_id = $1 AND status = 'committed'
        ORDER BY step_index`,
      [taskId],
    );
    return { task, journal: rows };
  });

  const steps: ReplayedStep[] = [];
  const divergences: Divergence[] = [];
  let cursor = 0;

  const serve = async <T,>(name: string, kind: StepKind, input: unknown): Promise<T> => {
    const index = cursor++;
    const recorded = journal[index];

    if (!recorded) {
      divergences.push({
        index,
        requested: { name, kind },
        recorded: null,
        reason: 'missing_step',
      });
      // Undefined rather than a fabricated value: a replay that invents a
      // plausible answer is telling the operator a story.
      return undefined as T;
    }

    if (recorded.name !== name || recorded.kind !== kind) {
      divergences.push({
        index,
        requested: { name, kind },
        recorded: { name: recorded.name, kind: recorded.kind },
        reason: 'different_step',
      });
    }

    const inputChanged = hashInput(input) !== recorded.input_hash;
    if (inputChanged) {
      divergences.push({
        index,
        requested: { name, kind },
        recorded: { name: recorded.name, kind: recorded.kind },
        reason: 'different_input',
      });
    }

    steps.push({
      index,
      name: recorded.name,
      kind: recorded.kind,
      output: recorded.output,
      inputChanged,
    });
    return recorded.output as T;
  };

  const ctx: ReplayContext = {
    task,
    step: (name, kind, input) => serve(name, kind, input),
    // Deliberately identical in shape to the engine's context, and served
    // entirely from the journal. No adapter is imported into this module.
    callCapability: (name, input) => serve(`capability:${name}`, 'tool', { name, input }),
    llm: (request) => serve('llm', 'llm', request),
  };

  let output: Record<string, unknown> | null = null;
  let error: string | null = null;

  try {
    output = await handler(ctx);
  } catch (thrown) {
    error = (thrown as Error).message;
  }

  return {
    taskId,
    status: task.status,
    steps,
    divergences,
    output,
    error,
    unusedSteps: Math.max(0, journal.length - cursor),
  };
}

/** A one-line summary of whether the replay matched the recorded run. */
export function describeReplay(report: ReplayReport): string {
  if (report.divergences.length === 0 && report.unusedSteps === 0) {
    return `replayed ${report.steps.length} step(s) with no divergence`;
  }
  const parts = [`replayed ${report.steps.length} step(s)`];
  if (report.divergences.length > 0) {
    parts.push(`${report.divergences.length} divergence(s)`);
  }
  if (report.unusedSteps > 0) {
    parts.push(`${report.unusedSteps} recorded step(s) never requested`);
  }
  return parts.join(', ');
}
