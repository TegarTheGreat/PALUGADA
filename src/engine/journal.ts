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
import { PalugadaError } from '../errors.ts';
import { callKey, hashInput, idempotencyKey } from './hash.ts';

export type StepKind = 'llm' | 'tool' | 'internal';

export interface StepContext {
  companyId: string;
  taskId: string;
}

export interface StepRecord {
  name: string;
  inputHash: string;
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
    name: string;
    input_hash: string;
    status: 'started' | 'committed' | 'failed';
    output: unknown;
    idempotency_key: string;
    attempt: number;
  }>(
    `SELECT name, input_hash, status, output, idempotency_key, attempt
       FROM task_steps WHERE task_id = $1 AND step_index = $2`,
    [taskId, stepIndex],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    inputHash: row.input_hash,
    status: row.status,
    output: row.output,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
  };
}

/** The most of a step's input the journal keeps, in characters of JSON. */
export const STEP_INPUT_LIMIT = 8_000;

/**
 * What of a step's input the journal keeps for the owner to read (0073): a
 * tool's or an internal step's, bounded; not a model call's, whose input is
 * its prompt and is kept by llm_traces under its own retention.
 */
function keptInput(kind: StepKind, input: unknown): unknown {
  if (kind === 'llm') return null;
  const text = JSON.stringify(input ?? null) ?? 'null';
  if (text.length <= STEP_INPUT_LIMIT) return input ?? null;
  return { cut: true, characters: text.length, start: text.slice(0, STEP_INPUT_LIMIT) };
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
  const kept = keptInput(options.kind, options.input);
  // A tool call is keyed by what it does, so a write tried again is the
  // same write to the vendor; every other step by its place in the run.
  const key = options.kind === 'tool' ? callKey(ctx.taskId, inputHash) : idempotencyKey(ctx.taskId, options.stepIndex, inputHash);

  const claim = await withTenant(ctx.companyId, async (tx) => {
    const step = await findStep(tx, ctx.taskId, options.stepIndex);
    if (step?.status === 'committed') return { committed: step };

    // Claim the step. ON CONFLICT covers a retry after a crash that left the
    // row in 'started' or 'failed': the attempt counter advances so the trace
    // shows the step was re-entered rather than silently repeated, and the
    // row takes this call's identity, because what was recorded there never
    // committed and this is the call that will. A row another run committed
    // in the meantime is not overwritten -- the update matches nothing, and
    // the committed row is read back instead.
    const { rows } = await tx.query<{ attempt: number }>(
      `INSERT INTO task_steps
         (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, input)
       VALUES ($1, $2, $3, $4, $5, 'started', $6, $7, $8::jsonb)
       ON CONFLICT (task_id, step_index) DO UPDATE
         SET status = 'started', attempt = task_steps.attempt + 1, started_at = now(),
             name = EXCLUDED.name, kind = EXCLUDED.kind,
             input_hash = EXCLUDED.input_hash, idempotency_key = EXCLUDED.idempotency_key,
             input = EXCLUDED.input, error = NULL
         WHERE task_steps.status <> 'committed'
       RETURNING attempt`,
      [ctx.taskId, options.stepIndex, ctx.companyId, options.name, options.kind, inputHash, key,
        kept === null ? null : JSON.stringify(kept)],
    );
    if (rows[0]) return { attempt: rows[0].attempt };
    return { committed: (await findStep(tx, ctx.taskId, options.stepIndex))! };
  });

  if ('committed' in claim) {
    const recorded = claim.committed;
    // Replay is by position, so the position has to hold the same call. A
    // handler that branched differently this time, or a journal written by a
    // different sequence of calls, would otherwise hand this call another
    // call's answer -- an email step given a model's reply, and the email
    // never sent.
    if (recorded.name !== options.name || recorded.inputHash !== inputHash) {
      throw new PalugadaError(
        'journal.divergence',
        `step ${options.stepIndex} is recorded as ${recorded.name}, and this run asked for `
          + `${options.name}${recorded.name === options.name ? ' with a different input' : ''}`,
        { taskId: ctx.taskId, stepIndex: options.stepIndex, recorded: recorded.name, requested: options.name },
      );
    }
    return { value: recorded.output as T, replayed: true };
  }
  const attempt = claim.attempt;

  let value: T;
  try {
    value = await execute(key);
  } catch (error) {
    await markFailed(ctx, options.stepIndex, attempt, (error as Error).message);
    throw error;
  }

  if (options.beforeCommit) {
    try {
      await options.beforeCommit();
    } catch (error) {
      await markFailed(ctx, options.stepIndex, attempt, `commit refused: ${(error as Error).message}`);
      throw error;
    }
  }

  // Only this claim of the step is committed. Another run that re-claimed
  // it -- which the lease exists to prevent -- owns the row now, and this
  // one's result is refused rather than written over it.
  const committed = await withTenant(ctx.companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE task_steps
          SET status = 'committed', output = $3, committed_at = now()
        WHERE task_id = $1 AND step_index = $2 AND attempt = $4 AND status = 'started'`,
      [ctx.taskId, options.stepIndex, JSON.stringify(value ?? null), attempt],
    );
    return rowCount === 1;
  });
  if (!committed) {
    throw new PalugadaError(
      'task.lease_lost',
      `step ${options.stepIndex} was claimed again by another run before this one committed it`,
      { taskId: ctx.taskId, stepIndex: options.stepIndex },
    );
  }

  return { value, replayed: false };
}

/** Records this claim of a step as failed, and nobody else's. */
async function markFailed(
  ctx: StepContext,
  stepIndex: number,
  attempt: number,
  message: string,
): Promise<void> {
  await withTenant(ctx.companyId, async (tx) => {
    await tx.query(
      `UPDATE task_steps SET status = 'failed', error = $4
        WHERE task_id = $1 AND step_index = $2 AND attempt = $3 AND status = 'started'`,
      [ctx.taskId, stepIndex, attempt, message],
    );
  });
}

/**
 * The model turns that wrote an answer the engine then rejected -- one that
 * broke its role's schema, or did not meet its done criteria -- reopened, so
 * the next attempt asks the model again instead of replaying the same answer.
 *
 * Replay is by position, and a model turn's journal input is only its
 * number, so a retry used to be handed its own rejected answer back and fail
 * the same way until the attempts ran out. Only the turns after the last
 * thing the run did in the world are reopened: a tool step stays committed,
 * so what was sent, written or paid for is never done twice, and the turns
 * before it replay as they were.
 */
export async function reopenFinalTurns(companyId: string, taskId: string, reason: string): Promise<number> {
  return withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE task_steps SET status = 'failed', error = $2
        WHERE task_id = $1 AND status = 'committed'
          AND step_index > coalesce((SELECT max(step_index) FROM task_steps WHERE task_id = $1 AND kind <> 'llm'), -1)`,
      [taskId, `the answer was rejected: ${reason}`.slice(0, 2_000)],
    );
    return rowCount ?? 0;
  });
}

/**
 * The turns that asked for an action the owner has a question about,
 * reopened (N6), inside the transaction that records the question.
 *
 * The owner asked on an approval card and no model read it: the run went
 * back to work, replayed from the journal the turn that had asked for the
 * action -- a model's turn is journalled by its number alone -- made the same
 * call, met the same open card and waited again. The model's turns after the
 * last thing the run did in the world are asked again, with the question in
 * their context; the tool steps before them stay committed, so nothing done
 * is done twice, and the call waiting on the card was never committed.
 */
export async function reopenForQuestionWithin(tx: TenantClient, taskId: string, question: string): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE task_steps SET status = 'failed', error = $2
      WHERE task_id = $1 AND kind = 'llm' AND status = 'committed'
        AND step_index > coalesce((SELECT max(step_index) FROM task_steps
                                    WHERE task_id = $1 AND kind <> 'llm' AND status = 'committed'), -1)`,
    [taskId, `the owner asked: ${question}`.slice(0, 2_000)],
  );
  return rowCount ?? 0;
}

/** One step of a task's journal, as far as evidence that cites it needs (engine/done.ts). */
export interface JournalEntry {
  index: number;
  name: string;
  kind: StepKind;
  status: 'started' | 'committed' | 'failed';
  error: string | null;
}

/**
 * Every step of one task, in order: what a done criterion's evidence is held
 * to. Only this task's rows, so a citation can never be borne out by a step
 * another task took -- the index is the task's own, and another task's step
 * of the same number is a different call.
 */
export async function journalOf(tx: TenantClient, taskId: string): Promise<JournalEntry[]> {
  const { rows } = await tx.query<{
    step_index: number; name: string; kind: StepKind; status: JournalEntry['status']; error: string | null;
  }>(
    'SELECT step_index, name, kind, status, error FROM task_steps WHERE task_id = $1 ORDER BY step_index',
    [taskId],
  );
  return rows.map((row) => ({ index: row.step_index, name: row.name, kind: row.kind, status: row.status, error: row.error }));
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
