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
import { isRoleFrozen } from '../governance/role-freeze.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';

/** F6.5: one task may spawn at most this many children unless overridden. */
export const DEFAULT_FAN_OUT_MAX = 5;

/** Admission reserve per task, so a sibling cannot be admitted without room. */
export const DEFAULT_TASK_RESERVE_TOKENS = 1_000;

/**
 * F5.10: the priority almost everything gets.
 *
 * P2 rather than P0, and that is the whole design. A default of P0 would make
 * the field meaningless within a week -- everything is urgent when nothing has
 * to choose.
 */
export const DEFAULT_PRIORITY = 2;

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
  /** F2.7: the goal this task exists to serve. */
  goalId: string | null;
  /** F5.13: the resource this task serialises against, if any. */
  laneKey: string | null;
  leaseHolder: string | null;
  leaseExpiresAt: Date | null;
  /** F9.5: this task may wait for the company's cheap hours. */
  batchable: boolean;
  /** F5.10: P0 is an incident, P3 is whenever. P2 is almost everything. */
  priority: number;
}

const SELECT_TASK = `
  SELECT id, company_id, project_id, division_id, role_id, parent_task_id,
         budget_account_id, status, input, output, hop_depth, hop_max,
         deadline_at, idempotency_key, attempt, attempt_max, tokens_reserved,
         halt_reason, batchable, goal_id, lane_key, lease_holder, lease_expires_at,
         priority
    FROM tasks`;

interface RawTask {
  id: string; company_id: string; project_id: string; division_id: string;
  role_id: string; parent_task_id: string | null; budget_account_id: string;
  status: TaskStatus; input: Record<string, unknown>; output: Record<string, unknown> | null;
  hop_depth: number; hop_max: number; deadline_at: Date | null; idempotency_key: string;
  attempt: number; attempt_max: number; tokens_reserved: string; halt_reason: string | null;
  batchable: boolean; goal_id: string | null; lane_key: string | null;
  lease_holder: string | null; lease_expires_at: Date | null; priority: number;
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
    batchable: row.batchable,
    goalId: row.goal_id,
    laneKey: row.lane_key,
    leaseHolder: row.lease_holder,
    leaseExpiresAt: row.lease_expires_at,
    priority: row.priority,
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
  /**
   * Which account funds this task. Optional: omitted, F1.6's narrowest
   * applicable account is looked up from the role, division and project the
   * task names. A caller that passes one is overriding that, which is what
   * `createSubTask` does to satisfy F5.4.
   */
  budgetAccountId?: string;
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
  /**
   * F9.5: mark this task as non-urgent, so it waits for cheap hours.
   *
   * Opt-in. Defaulting work to "wait until tonight" would make a forgotten
   * flag the difference between a company that answers and one that does not.
   */
  batchable?: boolean | undefined;
  /**
   * F5.10: P0 is an incident, P3 is whenever.
   *
   * Defaulted to P2, which is what almost everything is -- work that should
   * happen today and does not need to jump a queue. A default of P0 would make
   * the field meaningless within a week.
   */
  priority?: number | undefined;
  /**
   * F2.7: the goal this task serves.
   *
   * Required for a root task and inherited by a sub-task. The caller creating
   * a root task is the one that knows why it is being created; by the time a
   * sub-task is spawned the answer is already on its parent, and asking again
   * would invite a different answer.
   */
  goalId?: string | undefined;
  /**
   * F5.13: the shared resource this task touches, if any.
   *
   * At most one task per lane is checked out or running at a time. Opt-in,
   * because most tasks touch nothing shared and serialising them would cost
   * throughput for nothing. Conventionally `<resource-kind>:<identifier>` --
   * `repo:acme/site`, `domain:example.test`.
   */
  laneKey?: string | undefined;
}

/**
 * Creates a root task and reserves its allowance.
 *
 * The reservation is taken before the task exists in a runnable state, so an
 * account that cannot fund the task never produces a task that will halt on
 * its first step.
 */
export async function createRootTask(input: CreateTaskInput): Promise<TaskRow> {
  await assertSpendIsNotPaused(input.companyId);
  return withTenant(input.companyId, async (tx) => {
    // An explicit key means the caller can retry safely. Returning the
    // existing task rather than reserving again keeps a retry from quietly
    // consuming a second allowance.
    if (input.idempotencyKey) {
      const existing = await findByIdempotencyKey(tx, input.idempotencyKey);
      if (existing) return existing;
    }

    // F3.7: a frozen role admits no work. Checked before the reservation, so
    // a refused task does not tie up an allowance on the way out.
    await assertRoleIsNotFrozen(tx, input.roleId);
    await assertRoleIsComplete(tx, input.roleId);
    if (input.batchable) await assertRoleIsReadOnly(tx, input.roleId);

    // F2.7: a root task is where the "why" is known, so it is where it is
    // asked for. A task with no goal cannot explain itself to the owner later,
    // and F10.2 needs exactly that explanation.
    if (!input.goalId) {
      throw new PalugadaError(
        'goal.required',
        'a root task must name the goal it serves (PRD F2.7)',
        { roleId: input.roleId },
      );
    }

    // F1.6: the narrowest account that covers this task, unless the caller
    // named one. A task charged to the company account while its division has
    // one of its own would make that division's ceiling unenforceable, which
    // is the whole point of having it.
    const budgetAccountId = input.budgetAccountId
      ?? await budget.accountFor(tx, {
        companyId: input.companyId,
        roleId: input.roleId,
        divisionId: input.divisionId,
        projectId: input.projectId,
      });
    if (!budgetAccountId) {
      throw new PalugadaError(
        'budget.reservation_refused',
        'this company has no budget account to fund a task from',
        { companyId: input.companyId, divisionId: input.divisionId },
      );
    }

    const reserveTokens = input.reserveTokens ?? DEFAULT_TASK_RESERVE_TOKENS;
    const granted = await budget.reserve(tx, budgetAccountId, reserveTokens);
    if (!granted) {
      throw new PalugadaError(
        'budget.reservation_refused',
        'budget account cannot fund this task',
        { budgetAccountId, reserveTokens },
      );
    }

    try {
      return await insertTask(
        tx,
        { ...input, budgetAccountId },
        { parentTaskId: null, hopDepth: 0, reserveTokens },
      );
    } catch (error) {
      // Two workers raced for the same occurrence. The unique constraint on
      // (company_id, idempotency_key) settled it; this side gives its
      // reservation back and adopts the winner's task.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        await budget.release(tx, budgetAccountId, reserveTokens);
        const existing = await findByIdempotencyKey(tx, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  });
}

/**
 * Refuses admission for a role that cannot say what finished looks like (F2.8).
 *
 * v2 section 2.3 traces a real surprise bill to the absence of exactly this:
 * vague instructions plus an eager schedule, and nothing able to tell whether
 * the work was done. A role that cannot state its own completion will be asked
 * again, and again.
 *
 * Checked at admission rather than as a NOT NULL column so the failure names
 * the role and the missing half, which is what an operator needs, instead of
 * naming a column.
 */
async function assertRoleIsComplete(tx: TenantClient, roleId: string): Promise<void> {
  const { rows } = await tx.query<{ slug: string; criteria: number; has_output: boolean }>(
    `SELECT slug,
            cardinality(done_criteria) AS criteria,
            output_schema <> '{}'::jsonb AS has_output
       FROM roles WHERE id = $1`,
    [roleId],
  );
  const row = rows[0];
  if (!row) return;

  const missing: string[] = [];
  if (!row.has_output) missing.push('an output schema');
  if (row.criteria === 0) missing.push('at least one done_criteria');
  if (missing.length > 0) {
    throw new PalugadaError(
      'role.incomplete',
      `role ${row.slug} cannot be given work without ${missing.join(' and ')} (PRD F2.8)`,
      { roleId, missing },
    );
  }
}

/**
 * Refuses admission while the company's monthly ceiling is reached (F1.7).
 *
 * At admission as well as in the broker: a paused company that could still
 * start tasks would keep spending on model calls, which is most of the bill
 * the ceiling exists to cap.
 */
async function assertSpendIsNotPaused(companyId: string): Promise<void> {
  if (await isSpendPaused(companyId)) {
    throw new PalugadaError(
      'spend.paused',
      'company has reached its monthly spending ceiling and is not taking new work',
      { companyId },
    );
  }
}

/**
 * Refuses admission for a role that has been frozen (F3.7).
 *
 * A freeze that only stopped capability calls would let the role keep starting
 * tasks, burning tokens and filling the log with runs that cannot finish their
 * work. Stopping it here is what makes the freeze mean "this role does not
 * run" rather than "this role runs but achieves nothing".
 */
async function assertRoleIsNotFrozen(tx: TenantClient, roleId: string): Promise<void> {
  if (await isRoleFrozen(tx, roleId)) {
    throw new PalugadaError('role.frozen', `role ${roleId} is frozen and cannot be given work`, {
      roleId,
    });
  }
}

/**
 * Refuses to defer work that can change something (F9.5).
 *
 * F9.5 restricts batching to tier 0, and the tier is read from the registry
 * rather than taken from the request: a caller that could declare its own work
 * read-only could park a production deploy until 02:00, by which time the
 * world it was going to write to has moved.
 *
 * The role's declared tools are the right thing to check rather than its
 * division's grants. A role may only use its own tools (F2.3), so a role whose
 * twelve tools are all reads cannot write even if its division could.
 */
async function assertRoleIsReadOnly(tx: TenantClient, roleId: string): Promise<void> {
  const { rows } = await tx.query<{ writes: string[] }>(
    `SELECT coalesce(array_agg(c.name), '{}') AS writes
       FROM roles r
       JOIN capabilities c ON c.name = ANY(r.tools)
      WHERE r.id = $1 AND c.default_tier > 0`,
    [roleId],
  );
  const writes = rows[0]?.writes ?? [];
  if (writes.length > 0) {
    throw new PalugadaError(
      'batch.not_eligible',
      `role ${roleId} holds write capabilities (${writes.join(', ')}), so its work cannot ` +
        'wait for cheap hours (PRD F9.5 restricts batching to tier 0)',
      { roleId, writes },
    );
  }
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
  await assertSpendIsNotPaused(input.companyId);
  return withTenant(input.companyId, async (tx) => {
    const parent = await getTask(tx, parentTaskId);
    if (!parent) throw new Error(`parent task ${parentTaskId} not found`);

    // A frozen role takes no delegated work either, or a parent could route
    // around the freeze simply by handing the task down.
    await assertRoleIsNotFrozen(tx, input.roleId);
    await assertRoleIsComplete(tx, input.roleId);
    if (input.batchable) await assertRoleIsReadOnly(tx, input.roleId);

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

    // F2.7: inherited rather than re-supplied. The answer is already on the
    // parent, and asking again would invite a different one.
    const inherited = input.goalId ?? parent.goalId ?? undefined;

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
      {
        ...input,
        budgetAccountId: parent.budgetAccountId,
        createdBy: input.createdBy ?? 'agent_run',
        goalId: inherited,
      },
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

/**
 * `budgetAccountId` is required here even though it is optional on the input:
 * by this point the account has been resolved and reserved against, and a row
 * that reached the table with a null one would be a task nothing is paying for.
 * Stating it in the type is cheaper than a runtime check that has to be
 * remembered at each call site.
 */
async function insertTask(
  tx: TenantClient,
  input: CreateTaskInput & { budgetAccountId: string },
  meta: { parentTaskId: string | null; hopDepth: number; reserveTokens: number },
): Promise<TaskRow> {
  const inputHash = hashInput(input.input);
  const key = input.idempotencyKey ?? `${input.roleId}:${inputHash}:${meta.parentTaskId ?? 'root'}`;
  const { rows } = await tx.query<RawTask>(
    `INSERT INTO tasks (
       company_id, project_id, division_id, role_id, parent_task_id,
       budget_account_id, input, hop_depth, hop_max, deadline_at,
       idempotency_key, input_hash, created_by, attempt_max, tokens_reserved,
       batchable, goal_id, lane_key, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id, company_id, project_id, division_id, role_id, parent_task_id,
               budget_account_id, status, input, output, hop_depth, hop_max,
               deadline_at, idempotency_key, attempt, attempt_max,
               tokens_reserved, halt_reason, batchable, goal_id, lane_key,
               lease_holder, lease_expires_at, priority`,
    [
      input.companyId, input.projectId, input.divisionId, input.roleId,
      meta.parentTaskId, input.budgetAccountId, JSON.stringify(input.input),
      meta.hopDepth, input.hopMax ?? 3, input.deadlineAt ?? null, key, inputHash,
      input.createdBy, input.attemptMax ?? 3, meta.reserveTokens,
      input.batchable ?? false,
      input.goalId ?? null,
      input.laneKey ?? null,
      input.priority ?? DEFAULT_PRIORITY,
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
                                 THEN now() ELSE finished_at END,
              -- F5.12, F5.13: a task that has finished holds no lease and
              -- occupies no lane. Cleared here rather than at each call site,
              -- because a lease left on a finished task blocks its lane for
              -- fifteen minutes and nothing would ever notice.
              lease_holder = CASE WHEN $2 IN ('completed','failed','halted','cancelled')
                                  THEN NULL ELSE lease_holder END,
              lease_expires_at = CASE WHEN $2 IN ('completed','failed','halted','cancelled')
                                      THEN NULL ELSE lease_expires_at END
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
