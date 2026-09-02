/**
 * Task creation and lifecycle (PRD F5.4, F5.5, F5.6, F6.5, F6.6).
 *
 * Sub-task admission is the single place where a delegation tree can be
 * bounded, so every guard lives here: depth, fan-out, cycles and budget. They
 * share one code path because they answer the same question -- may this task
 * exist at all -- and splitting them across phases would mean rewriting the
 * path later. F6.5 and F6.6 therefore land alongside the Phase 0 guards rather
 * than in Phase 1.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { assertTransition, type HaltReason, type TaskStatus } from '../domain/task.ts';
import { hashInput } from './hash.ts';
import * as budget from './budget.ts';

/** F6.5: one task may spawn at most this many children unless overridden. */
export const DEFAULT_FAN_OUT_MAX = 5;

/** Admission reserve per task, so a sibling cannot be admitted without room. */
export const DEFAULT_TASK_RESERVE_TOKENS = 1_000;

export interface TaskRow {
  id: string;
  companyId: string;
  projectId: string;
  divisionId: string;
  roleId: string;
  parentTaskId: string | null;
  budgetAccountId: string;
  status: TaskStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  hopDepth: number;
  hopMax: number;
  deadlineAt: Date | null;
  idempotencyKey: string;
  attempt: number;
  attemptMax: number;
  tokensReserved: number;
  haltReason: string | null;
}

const SELECT_TASK = `
  SELECT id, company_id, project_id, division_id, role_id, parent_task_id,
         budget_account_id, status, input, output, hop_depth, hop_max,
         deadline_at, idempotency_key, attempt, attempt_max, tokens_reserved,
         halt_reason
    FROM tasks`;

interface RawTask {
  id: string; company_id: string; project_id: string; division_id: string;
  role_id: string; parent_task_id: string | null; budget_account_id: string;
  status: TaskStatus; input: Record<string, unknown>; output: Record<string, unknown> | null;
  hop_depth: number; hop_max: number; deadline_at: Date | null; idempotency_key: string;
  attempt: number; attempt_max: number; tokens_reserved: string; halt_reason: string | null;
}

function toTask(row: RawTask): TaskRow {
  return {
    id: row.id, companyId: row.company_id, projectId: row.project_id,
    divisionId: row.division_id, roleId: row.role_id, parentTaskId: row.parent_task_id,
    budgetAccountId: row.budget_account_id, status: row.status, input: row.input,
    output: row.output, hopDepth: row.hop_depth, hopMax: row.hop_max,
    deadlineAt: row.deadline_at, idempotencyKey: row.idempotency_key,
    attempt: row.attempt, attemptMax: row.attempt_max,
    tokensReserved: Number(row.tokens_reserved), haltReason: row.halt_reason,
  };
}

export async function getTask(tx: TenantClient, taskId: string): Promise<TaskRow | null> {
  const { rows } = await tx.query<RawTask>(`${SELECT_TASK} WHERE id = $1`, [taskId]);
  return rows[0] ? toTask(rows[0]) : null;
}

export interface CreateTaskInput {
  companyId: string;
  projectId: string;
  divisionId: string;
  roleId: string;
  input: Record<string, unknown>;
  budgetAccountId: string;
  createdBy: 'scheduler' | 'event' | 'agent_run' | 'owner';
  deadlineAt?: Date | undefined;
  hopMax?: number | undefined;
  attemptMax?: number | undefined;
  reserveTokens?: number | undefined;
  /**
   * Overrides the derived key. A scheduled run supplies one built from the
   * schedule and the occurrence it fires for, which is what makes a restart
   * between claiming an occurrence and creating its task produce the same task
   * rather than a second one.
   */
  idempotencyKey?: string | undefined;
}

/**
 * Creates a root task and reserves its allowance.
 *
 * The reservation is taken before the task exists in a runnable state, so an
 * account that cannot fund the task never produces a task that will halt on
 * its first step.
 */
export async function createRootTask(input: CreateTaskInput): Promise<TaskRow> {
  return withTenant(input.companyId, async (tx) => {
    // An explicit key means the caller can retry safely. Returning the
    // existing task rather than reserving again keeps a retry from quietly
    // consuming a second allowance.
    if (input.idempotencyKey) {
      const existing = await findByIdempotencyKey(tx, input.idempotencyKey);
      if (existing) return existing;
    }

    const reserveTokens = input.reserveTokens ?? DEFAULT_TASK_RESERVE_TOKENS;
    const granted = await budget.reserve(tx, input.budgetAccountId, reserveTokens);
    if (!granted) {
      throw new PalugadaError(
        'budget.reservation_refused',
        'budget account cannot fund this task',
        { budgetAccountId: input.budgetAccountId, reserveTokens },
      );
    }

    try {
      return await insertTask(tx, input, { parentTaskId: null, hopDepth: 0, reserveTokens });
    } catch (error) {
      // Two workers raced for the same occurrence. The unique constraint on
      // (company_id, idempotency_key) settled it; this side gives its
      // reservation back and adopts the winner's task.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        await budget.release(tx, input.budgetAccountId, reserveTokens);
        const existing = await findByIdempotencyKey(tx, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  });
}

async function findByIdempotencyKey(
  tx: TenantClient,
  idempotencyKey: string,
): Promise<TaskRow | null> {
  const { rows } = await tx.query<RawTask>(
    `${SELECT_TASK} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0] ? toTask(rows[0]) : null;
}

/**
 * Creates a sub-task under an existing parent.
 *
 * The parent's budget account is reused rather than a new one created; that is
 * the whole of F5.4. Depth, fan-out and cycle checks run before the
 * reservation so a rejected sub-task leaves no allowance held.
 */
export async function createSubTask(
  parentTaskId: string,
  input: Omit<CreateTaskInput, 'budgetAccountId' | 'createdBy'> & {
    createdBy?: CreateTaskInput['createdBy'];
    fanOutMax?: number | undefined;
  },
): Promise<TaskRow> {
  return withTenant(input.companyId, async (tx) => {
    const parent = await getTask(tx, parentTaskId);
    if (!parent) throw new Error(`parent task ${parentTaskId} not found`);

    const hopDepth = parent.hopDepth + 1;
    const hopMax = input.hopMax ?? parent.hopMax;
    if (hopDepth > hopMax) {
      throw new PalugadaError(
        'hop.exceeded',
        `delegation depth ${hopDepth} exceeds hop_max ${hopMax}`,
        { parentTaskId, hopDepth, hopMax },
      );
    }

    const fanOutMax = input.fanOutMax ?? DEFAULT_FAN_OUT_MAX;
    const { rows: childRows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tasks WHERE parent_task_id = $1',
      [parentTaskId],
    );
    const childCount = Number(childRows[0]!.count);
    if (childCount >= fanOutMax) {
      throw new PalugadaError(
        'cycle.detected',
        `fan-out limit ${fanOutMax} reached for task ${parentTaskId}`,
        { parentTaskId, childCount, fanOutMax },
      );
    }

    const inputHash = hashInput(input.input);
    await assertNoCycle(tx, parentTaskId, input.roleId, inputHash);

    const reserveTokens = input.reserveTokens ?? DEFAULT_TASK_RESERVE_TOKENS;
    const granted = await budget.reserve(tx, parent.budgetAccountId, reserveTokens);
    if (!granted) {
      throw new PalugadaError(
        'budget.reservation_refused',
        'inherited budget cannot fund another sub-task',
        { budgetAccountId: parent.budgetAccountId, reserveTokens },
      );
    }

    return insertTask(
      tx,
      { ...input, budgetAccountId: parent.budgetAccountId, createdBy: input.createdBy ?? 'agent_run' },
      { parentTaskId, hopDepth, reserveTokens },
    );
  });
}

/**
 * F6.6: refuses a sub-task whose (role, input) pair already appears among its
 * ancestors. Two agents handing the same work back and forth is the failure
 * this prevents, and it is checked against the ancestor chain rather than
 * against siblings because only the chain can actually loop.
 */
async function assertNoCycle(
  tx: TenantClient,
  parentTaskId: string,
  roleId: string,
  inputHash: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_task_id, role_id, input_hash FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_task_id, t.role_id, t.input_hash
         FROM tasks t JOIN ancestors a ON t.id = a.parent_task_id
     )
     SELECT id FROM ancestors WHERE role_id = $2 AND input_hash = $3 LIMIT 1`,
    [parentTaskId, roleId, inputHash],
  );
  if (rows.length > 0) {
    throw new PalugadaError(
      'cycle.detected',
      'an ancestor task already runs this role with this input',
      { parentTaskId, roleId, ancestorTaskId: rows[0]!.id },
    );
  }
}

async function insertTask(
  tx: TenantClient,
  input: CreateTaskInput,
  meta: { parentTaskId: string | null; hopDepth: number; reserveTokens: number },
): Promise<TaskRow> {
  const inputHash = hashInput(input.input);
  const key = input.idempotencyKey ?? `${input.roleId}:${inputHash}:${meta.parentTaskId ?? 'root'}`;
  const { rows } = await tx.query<RawTask>(
    `INSERT INTO tasks (
       company_id, project_id, division_id, role_id, parent_task_id,
       budget_account_id, input, hop_depth, hop_max, deadline_at,
       idempotency_key, input_hash, created_by, attempt_max, tokens_reserved)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, company_id, project_id, division_id, role_id, parent_task_id,
               budget_account_id, status, input, output, hop_depth, hop_max,
               deadline_at, idempotency_key, attempt, attempt_max,
               tokens_reserved, halt_reason`,
    [
      input.companyId, input.projectId, input.divisionId, input.roleId,
      meta.parentTaskId, input.budgetAccountId, JSON.stringify(input.input),
      meta.hopDepth, input.hopMax ?? 3, input.deadlineAt ?? null, key, inputHash,
      input.createdBy, input.attemptMax ?? 3, meta.reserveTokens,
    ],
  );
  const task = toTask(rows[0]!);
  await appendEvent(tx, {
    companyId: task.companyId,
    projectId: task.projectId,
    taskId: task.id,
    type: 'task.created',
    actor: input.createdBy,
    payload: { roleId: task.roleId, hopDepth: task.hopDepth, parentTaskId: meta.parentTaskId },
  });
  return task;
}

/** Moves a task to a new status, refusing transitions the PRD does not allow. */
/**
 * Tasks whose window has reopened (F9.2).
 *
 * A task parked on a closed window would otherwise sit there for ever: nothing
 * else wakes it, because nothing failed.
 */
export async function claimReadyWindowTasks(
  companyId: string,
  now = new Date(),
): Promise<TaskRow[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<RawTask>(
      `${SELECT_TASK}
        WHERE status = 'waiting_window'
          AND (wait_until IS NULL OR wait_until <= $1)
        ORDER BY created_at`,
      [now],
    );
    return rows.map(toTask);
  });
}

export async function transition(
  companyId: string,
  taskId: string,
  to: TaskStatus,
  options: {
    haltReason?: HaltReason;
    output?: Record<string, unknown>;
    /** When a task parked on a closed window may be picked up again (F9.2). */
    waitUntil?: Date | null;
  } = {},
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    const task = await getTask(tx, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    assertTransition(task.status, to);

    await tx.query(
      `UPDATE tasks
          SET status = $2,
              halt_reason = COALESCE($3, halt_reason),
              output = COALESCE($4::jsonb, output),
              wait_until = CASE WHEN $5::timestamptz IS NOT NULL THEN $5::timestamptz
                                WHEN $2 = 'running' THEN NULL
                                ELSE wait_until END,
              started_at = CASE WHEN $2 = 'running' AND started_at IS NULL
                                THEN now() ELSE started_at END,
              finished_at = CASE WHEN $2 IN ('completed','failed','halted','cancelled')
                                 THEN now() ELSE finished_at END
        WHERE id = $1`,
      [
        taskId,
        to,
        options.haltReason ?? null,
        options.output ? JSON.stringify(options.output) : null,
        options.waitUntil ?? null,
      ],
    );

    // A task that will never run again must not keep holding an allowance its
    // siblings could use.
    if (['completed', 'failed', 'halted', 'cancelled'].includes(to) && task.tokensReserved > 0) {
      await budget.release(tx, task.budgetAccountId, task.tokensReserved);
      await tx.query('UPDATE tasks SET tokens_reserved = 0 WHERE id = $1', [taskId]);
    }

    await appendEvent(tx, {
      companyId,
      projectId: task.projectId,
      taskId,
      type: `task.${to}`,
      actor: 'system',
      payload: options.haltReason ? { haltReason: options.haltReason } : {},
    });
  });
}
