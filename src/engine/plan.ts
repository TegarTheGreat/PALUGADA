/**
 * The plan a task records before it acts (PRD v2 F8.11, F8.13).
 *
 * v2 section 2.3 lists a failure worth reading twice: an outreach agent
 * contacted 23 leads when it should have contacted 3. Nothing in the system
 * knew what "3" was, so nothing could notice. A plan is that missing number,
 * written down before the first tier 2 action rather than reconstructed
 * afterwards from an apology.
 *
 * Three decisions shape it.
 *
 * **It is structured, not prose.** Each step names the capability it intends
 * to use, what it expects to be true afterwards, and -- where the call is a
 * batch -- how many items it covers. Free text would be readable and
 * uncheckable, which is exactly the state that produced the 23.
 *
 * **It is written before the action, and cannot be written after.** A plan
 * recorded once is not replaced by a second call, because a plan that can be
 * rewritten mid-task is a description rather than a commitment: an agent that
 * found itself with 23 recipients could simply record a plan for 23. Changing
 * it means the task has changed its mind, which is a new task or an
 * escalation, not an edit.
 *
 * **A tier 2 action without a plan is refused, not delayed.** The refusal
 * lands as an ordinary broker denial, so it is recorded, counted towards the
 * role's daily limit (F3.7), and visible in exactly the same place as every
 * other refusal.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

export interface PlanStep {
  /** The capability this step intends to use. */
  capability: string;
  /** What the step is for, in the task's own terms. */
  intent: string;
  /** What will be true once it has run. This is what a reviewer checks. */
  expectedEffect: string;
  /**
   * How many items the call covers, when it is a batch.
   *
   * Omitted for a call that is not a batch. Present, it is the number the
   * batch guard holds the call to.
   */
  batchSize?: number;
}

export interface TaskPlan {
  steps: PlanStep[];
  recordedAt: string;
}

function assertUsable(steps: PlanStep[]): void {
  if (steps.length === 0) {
    throw new PalugadaError('plan.invalid', 'a plan with no steps is not a plan', {});
  }
  for (const step of steps) {
    if (!step.capability.trim() || !step.intent.trim() || !step.expectedEffect.trim()) {
      throw new PalugadaError(
        'plan.invalid',
        `plan step for ${step.capability || '(unnamed)'} must name a capability, an intent ` +
          'and the effect it expects',
        { step },
      );
    }
    if (step.batchSize !== undefined && (!Number.isInteger(step.batchSize) || step.batchSize < 0)) {
      throw new PalugadaError(
        'plan.invalid',
        `plan step for ${step.capability} declares a batch size that is not a count`,
        { step },
      );
    }
  }
}

/**
 * Records the plan for a task.
 *
 * Refuses to overwrite one. See the module comment: a plan that can be
 * rewritten after the fact is not a commitment, and the failure it exists to
 * prevent is precisely an agent discovering it has 23 recipients and deciding
 * that was the plan all along.
 */
export async function recordPlan(
  companyId: string,
  taskId: string,
  steps: PlanStep[],
): Promise<TaskPlan> {
  assertUsable(steps);
  const plan: TaskPlan = { steps, recordedAt: new Date().toISOString() };

  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'UPDATE tasks SET plan = $2 WHERE id = $1 AND plan IS NULL RETURNING id',
      [taskId, JSON.stringify(plan)],
    );

    if (rows.length === 0) {
      const existing = await readPlan(tx, taskId);
      throw new PalugadaError(
        existing ? 'plan.already_recorded' : 'plan.invalid',
        existing
          ? `task ${taskId} already recorded a plan; changing it is a new task, not an edit`
          : `task ${taskId} not found, or not visible in this scope`,
        { taskId },
      );
    }

    await appendEvent(tx, {
      companyId,
      taskId,
      type: 'task.planned',
      actor: 'agent_run',
      payload: { steps: steps.length, capabilities: steps.map((step) => step.capability) },
    });

    return plan;
  });
}

export async function readPlan(tx: TenantClient, taskId: string): Promise<TaskPlan | null> {
  const { rows } = await tx.query<{ plan: TaskPlan | null }>(
    'SELECT plan FROM tasks WHERE id = $1',
    [taskId],
  );
  return rows[0]?.plan ?? null;
}

/** The step that named this capability, if the plan has one. */
export function stepFor(plan: TaskPlan, capability: string): PlanStep | undefined {
  return plan.steps.find((step) => step.capability === capability);
}

export type PlanVerdict =
  | { ok: true }
  | { ok: false; code: 'plan.required' | 'plan.batch_mismatch'; message: string };

/**
 * Checks a call against the plan (F8.11, F8.13).
 *
 * `batchSize` is what the capability itself reports for this call through
 * `describe()`, rather than the broker guessing which argument is a list. A
 * guess would break silently the day a capability renamed a field, and a guard
 * that has quietly stopped guarding is worse than none.
 *
 * A call that reports no batch size is not batch-checked. Most tier 2 actions
 * are single: demanding a count from them would push authors to write a
 * meaningless one, and a plan full of meaningless numbers protects nothing.
 */
export function checkAgainstPlan(
  plan: TaskPlan | null,
  capability: string,
  batchSize: number | undefined,
): PlanVerdict {
  if (!plan) {
    return {
      ok: false,
      code: 'plan.required',
      message:
        `capability ${capability} is tier 2 or above and this task has recorded no plan ` +
        '(PRD F8.11). Record one naming the steps and their expected effects first.',
    };
  }

  if (batchSize === undefined) return { ok: true };

  const step = stepFor(plan, capability);
  if (!step) {
    return {
      ok: false,
      code: 'plan.batch_mismatch',
      message:
        `this call covers ${batchSize} items but the plan has no step for ${capability}, ` +
        'so there is nothing to check the count against (PRD F8.13)',
    };
  }

  if (step.batchSize === undefined) {
    return {
      ok: false,
      code: 'plan.batch_mismatch',
      message:
        `this call covers ${batchSize} items but the plan's step for ${capability} declared ` +
        'no count (PRD F8.13)',
    };
  }

  if (step.batchSize !== batchSize) {
    return {
      ok: false,
      code: 'plan.batch_mismatch',
      message:
        `the plan says ${capability} covers ${step.batchSize} items and this call covers ` +
        `${batchSize} (PRD F8.13)`,
    };
  }

  return { ok: true };
}
