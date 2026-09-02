/**
 * Durable step journal (PRD F5.1, F5.2).
 *
 * Durability belongs to the engine, not to the agent framework (principle 5).
 * Every LLM call and every tool call is a journalled step: on restart a
 * committed step returns its recorded output instead of running again, so a
 * worker killed halfway through a ten-step task resumes at step six rather
 * than paying for the first five a second time.
 *
 * The bookkeeping deliberately spans three transactions rather than one:
 *
 *   1. claim   -- record that the step started
 *   2. execute -- the side effect, outside any transaction
 *   3. commit  -- record the output
 *
 * Holding a database transaction open across an external HTTP call would pin
 * a connection for the length of a third-party timeout. The gap between 1 and
 * 3 is exactly why F5.2 requires an idempotency key: a crash there re-runs the
 * step, and the key is what lets the downstream system recognise the repeat.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { hashInput, idempotencyKey } from './hash.ts';

export type StepKind = 'llm' | 'tool' | 'internal';

export interface StepContext {
  companyId: string;
  taskId: string;
}

export interface StepRecord {
  status: 'started' | 'committed' | 'failed';
  output: unknown;
  idempotencyKey: string;
  attempt: number;
}

export async function findStep(
  tx: TenantClient,
  taskId: string,
  stepIndex: number,
): Promise<StepRecord | null> {
  const { rows } = await tx.query<{
    status: 'started' | 'committed' | 'failed';
    output: unknown;
    idempotency_key: string;
    attempt: number;
  }>(
    `SELECT status, output, idempotency_key, attempt
       FROM task_steps WHERE task_id = $1 AND step_index = $2`,
    [taskId, stepIndex],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    output: row.output,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
  };
}

/**
 * Runs a step exactly once across restarts, or returns its recorded output.
 *
 * `execute` receives the idempotency key so a capability can pass it to the
 * downstream system.
 */
export async function runStep<T>(
  ctx: StepContext,
  options: {
    stepIndex: number;
    name: string;
    kind: StepKind;
    input: unknown;
    /**
     * Runs after the side effect and before the commit. Throwing here leaves
     * the step uncommitted, which is how F5.8 keeps an in-flight external
     * action out of the journal when the owner presses stop mid-step: the
     * action may already have reached the third party, but the task never
     * records it as a completed step and so never builds on it.
     */
    beforeCommit?: (() => Promise<void>) | undefined;
  },
  execute: (key: string) => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const inputHash = hashInput(options.input);
  const key = idempotencyKey(ctx.taskId, options.stepIndex, inputHash);

  const existing = await withTenant(ctx.companyId, async (tx) => {
    const step = await findStep(tx, ctx.taskId, options.stepIndex);
    if (step?.status === 'committed') return step;

    // Claim the step. ON CONFLICT covers a retry after a crash that left the
    // row in 'started': the attempt counter advances so the trace shows the
    // step was re-entered rather than silently repeated.
    await tx.query(
      `INSERT INTO task_steps
         (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'started', $6, $7)
       ON CONFLICT (task_id, step_index) DO UPDATE
         SET status = 'started', attempt = task_steps.attempt + 1, started_at = now()`,
      [ctx.taskId, options.stepIndex, ctx.companyId, options.name, options.kind, inputHash, key],
    );
    return null;
  });

  if (existing) {
    return { value: existing.output as T, replayed: true };
  }

  let value: T;
  try {
    value = await execute(key);
  } catch (error) {
    await withTenant(ctx.companyId, async (tx) => {
      await tx.query(
        `UPDATE task_steps SET status = 'failed', error = $3
          WHERE task_id = $1 AND step_index = $2`,
        [ctx.taskId, options.stepIndex, (error as Error).message],
      );
    });
    throw error;
  }

  if (options.beforeCommit) {
    try {
      await options.beforeCommit();
    } catch (error) {
      await withTenant(ctx.companyId, async (tx) => {
        await tx.query(
          `UPDATE task_steps SET status = 'failed', error = $3
            WHERE task_id = $1 AND step_index = $2`,
          [ctx.taskId, options.stepIndex, `commit refused: ${(error as Error).message}`],
        );
      });
      throw error;
    }
  }

  await withTenant(ctx.companyId, async (tx) => {
    await tx.query(
      `UPDATE task_steps
          SET status = 'committed', output = $3, committed_at = now()
        WHERE task_id = $1 AND step_index = $2`,
      [ctx.taskId, options.stepIndex, JSON.stringify(value ?? null)],
    );
  });

  return { value, replayed: false };
}

export async function countCommittedSteps(companyId: string, taskId: string): Promise<number> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_steps
        WHERE task_id = $1 AND status = 'committed'`,
      [taskId],
    );
    return Number(rows[0]!.count);
  });
}
