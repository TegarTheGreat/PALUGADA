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
import { TERMINAL_STATUSES, assertTransition, type HaltReason, type TaskStatus } from '../domain/task.ts';
import { hashInput } from './hash.ts';
import * as budget from './budget.ts';
import { isRoleFrozen } from '../governance/role-freeze.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';
import { assertGoalOpen } from '../domain/goals.ts';
import { settleTicketsOf } from './tickets.ts';
import { learn } from '../memory/store.ts';

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

/**
 * Whether outside text is in a task's work (F8.9), and how it got there.
 *
 * `begun`: the task, or one above it, was begun by an inbound trigger.
 * `read`: the task, or one above it, read something written outside the
 * company through a capability the catalogue marks `readsOutside` -- an
 * email, a web page, a customer's record. Null when neither. Delegating does
 * not launder it: a child of such a task is the same work, carrying the same
 * text in its brief. Nor does asking: a task whose sub-task read something
 * gets what it found back, through `task.await` or the sub-task's result,
 * so a read anywhere below a task counts for it too. That is wider than
 * what it has taken back so far, and a tier 2 action it takes asks the owner
 * a little more often for it; the other way, a run hands the email to a
 * sub-task and sends on its answer unasked.
 */
export async function outsideContentIn(tx: TenantClient, taskId: string): Promise<'begun' | 'read' | null> {
  const { rows } = await tx.query<{ begun: boolean | null; read: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_task_id, created_by, 0 AS depth FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_task_id, t.created_by, chain.depth + 1
         FROM tasks t JOIN chain ON t.id = chain.parent_task_id
        WHERE chain.depth < 64
     ), below AS (
       SELECT id, 0 AS depth FROM tasks WHERE parent_task_id = $1
       UNION ALL
       SELECT t.id, below.depth + 1
         FROM tasks t JOIN below ON t.parent_task_id = below.id
        WHERE below.depth < 64
     )
     SELECT bool_or(created_by = 'webhook') AS begun,
            EXISTS (SELECT 1 FROM events e
                     WHERE e.type = 'content.read_outside'
                       AND (e.task_id IN (SELECT id FROM chain) OR e.task_id IN (SELECT id FROM below))) AS read
       FROM chain`,
    [taskId],
  );
  const row = rows[0];
  return row?.begun ? 'begun' : row?.read ? 'read' : null;
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
  /** `webhook`: begun by an inbound trigger, so from outside the company (0054, F8.9). */
  createdBy: 'scheduler' | 'event' | 'agent_run' | 'owner' | 'webhook';
  /**
   * F8.9: the task is made from words written outside the company -- a
   * rerun of tainted work, a ticket a run filed -- and carries them from its
   * first step. Recorded in the transaction that makes the task, so no
   * worker can claim it clean in between. The payload says where from.
   */
  carriesOutside?: Record<string, unknown> | undefined;
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
  /** The schedule that made this task, when one did (0049). */
  scheduleId?: string | undefined;
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
    // And the goal must still be wanted: a closed one, or one under a closed
    // one, starts nothing -- the schedule, the trigger, the handoff and the
    // owner all come through here.
    await assertGoalOpen(tx, input.goalId);
    // Nor a closed project (0074): its work is finished, whoever asks.
    const { rows: project } = await tx.query<{ name: string; archived: boolean }>(
      'SELECT name, archived_at IS NOT NULL AS archived FROM projects WHERE id = $1', [input.projectId]);
    if (project[0]?.archived) {
      throw new PalugadaError('contract.violation',
        `project "${project[0].name}" is archived and takes no new work; open it again, or give the work to another project`,
        { field: 'projectId' });
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
        'the budget account cannot fund this task: its tokens are spent or held up to its ceiling. '
          + 'Raise its ceiling under Money, or let running work finish and release what it holds',
        { budgetAccountId, reserveTokens },
      );
    }

    // Inside a savepoint, because the recovery below runs in this same
    // transaction and PostgreSQL refuses every statement after an error until
    // the transaction is rolled back. Without it the release and the lookup
    // both failed with 25P02, and the race the comment below describes -- two
    // replicas firing one schedule occurrence -- ended with the loser
    // recording a failure for a task that had been created.
    await tx.query('SAVEPOINT insert_task');
    try {
      const task = await insertTask(
        tx,
        { ...input, budgetAccountId },
        { parentTaskId: null, hopDepth: 0, reserveTokens },
      );
      await tx.query('RELEASE SAVEPOINT insert_task');
      if (input.carriesOutside) {
        await appendEvent(tx, {
          companyId: input.companyId, projectId: task.projectId, taskId: task.id,
          type: 'content.read_outside', actor: 'engine', payload: input.carriesOutside,
        });
      }
      return task;
    } catch (error) {
      // Two workers raced for the same occurrence. The unique constraint on
      // (company_id, idempotency_key) settled it; this side gives its
      // reservation back and adopts the winner's task.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        await tx.query('ROLLBACK TO SAVEPOINT insert_task');
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

    // The same child asked for again -- the parent was retried, or resumed
    // after a crash between the child finishing and the parent recording it --
    // is the child it already has. The key is derived from the role, the input
    // and the parent, so the second ask used to fail on it, and the parent
    // spent its attempts on duplicate-key errors while the child it was
    // waiting for sat completed.
    const key = input.idempotencyKey ?? taskKey(input.roleId, hashInput(input.input), parentTaskId);
    const existing = await findByIdempotencyKey(tx, key);
    if (existing && existing.parentTaskId === parentTaskId) return existing;

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
      // Its own code: it was reported as a cycle, which sent an owner looking
      // for a loop in work that had only split itself too many ways.
      throw new PalugadaError(
        'fanout.exceeded',
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

    // The lookup above is a read, and two passes creating the same child --
    // two workers handing off one completion -- can both get past it. The
    // key settles which insert wins, and the other adopts that child, inside
    // a savepoint for the same reason as `createRootTask`.
    await tx.query('SAVEPOINT insert_child');
    try {
      const child = await insertTask(
        tx,
        {
          ...input,
          budgetAccountId: parent.budgetAccountId,
          createdBy: input.createdBy ?? 'agent_run',
          goalId: inherited,
        },
        { parentTaskId, hopDepth, reserveTokens },
      );
      await tx.query('RELEASE SAVEPOINT insert_child');
      // F8.9: a parent carries a read by any of its sub-tasks, since what
      // they found comes back to it (`outsideContentIn`), but a child's own
      // chain sees only reads above it. A brief written after a sibling's
      // email came back is that email's work, so it is handed down here,
      // when the child is made from what the parent knows by then.
      if ((await outsideContentIn(tx, parentTaskId)) !== null && (await outsideContentIn(tx, child.id)) === null) {
        await appendEvent(tx, {
          companyId: input.companyId,
          projectId: child.projectId,
          taskId: child.id,
          type: 'content.read_outside',
          actor: 'engine',
          // Named as the Work page lists it: "through the task that made it".
          payload: { capability: 'the task that made it', from: 'parent', parentTaskId },
        });
      }
      return child;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        await tx.query('ROLLBACK TO SAVEPOINT insert_child');
        await budget.release(tx, parent.budgetAccountId, reserveTokens);
        const winner = await findByIdempotencyKey(tx, key);
        if (winner && winner.parentTaskId === parentTaskId) return winner;
      }
      throw error;
    }
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

/** The key a task gets when its creator does not give one. */
function taskKey(roleId: string, inputHash: string, parentTaskId: string | null): string {
  return `${roleId}:${inputHash}:${parentTaskId ?? 'root'}`;
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
  const key = input.idempotencyKey ?? taskKey(input.roleId, inputHash, meta.parentTaskId);
  const { rows } = await tx.query<RawTask>(
    `INSERT INTO tasks (
       company_id, project_id, division_id, role_id, parent_task_id,
       budget_account_id, input, hop_depth, hop_max, deadline_at,
       idempotency_key, input_hash, created_by, attempt_max, tokens_reserved,
       batchable, goal_id, lane_key, priority, schedule_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
      input.scheduleId ?? null,
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

export interface TransitionOptions {
  haltReason?: HaltReason;
  /**
   * Why, in the words of whatever refused: the code says which kind of halt,
   * and this says what to change -- the key that could not be opened, the
   * setting that names no model -- for the owner reading the task.
   */
  detail?: string;
  output?: Record<string, unknown>;
  /** When a task parked on a closed window may be picked up again (F9.2). */
  waitUntil?: Date | null;
}

/** Moves a task to a new status, refusing transitions the PRD does not allow. */
export async function transition(
  companyId: string,
  taskId: string,
  to: TaskStatus,
  options: TransitionOptions = {},
): Promise<void> {
  await withTenant(companyId, (tx) => transitionWithin(tx, companyId, taskId, to, options));
  // A child that has ended is what a parent waiting on it is waiting for, so
  // the parent is woken now rather than at its next look, two minutes on:
  // every hand-off in a company cost two minutes of nothing. A transaction of
  // its own, after the child's, so the two rows are never locked child-first
  // against the id order every other writer takes them in.
  if (TERMINAL_STATUSES.includes(to)) {
    await withTenant(companyId, (tx) => tx.query(
      `UPDATE tasks parent SET wait_until = now()
         FROM tasks child
        WHERE child.id = $1 AND parent.id = child.parent_task_id
          AND parent.status = 'waiting_window' AND parent.wait_until > now()`,
      [taskId],
    ));
  }
}

/** The goal and the summary of finished work, bounded, for its event. */
function whatWasDone(input: Record<string, unknown>, output: unknown): Record<string, string> {
  const done: Record<string, string> = {};
  if (typeof input.goal === 'string' && input.goal.trim()) done.goal = input.goal.trim().slice(0, 300);
  const summary = output && typeof output === 'object' ? (output as { summary?: unknown }).summary : undefined;
  if (typeof summary === 'string' && summary.trim()) done.summary = summary.trim().slice(0, 1_000);
  return done;
}

/** How many lessons one run may leave, and how long each may be. */
const LESSONS_PER_RUN = 5;
const LESSON_MAX = 500;

/**
 * What a run said the company should remember (its output's `learned`),
 * kept as lessons for its division: unverified until learned again or
 * confirmed by the owner, marked as outside content when the work read any,
 * and one row however many times the same lesson is learned (memory/store.ts).
 */
async function keepLessons(tx: TenantClient, companyId: string, task: TaskRow, output: unknown): Promise<void> {
  const said = output && typeof output === 'object' ? (output as { learned?: unknown }).learned : undefined;
  if (!Array.isArray(said)) return;
  const lessons = said.filter((one): one is string => typeof one === 'string' && one.trim() !== '')
    .map((one) => one.trim().slice(0, LESSON_MAX)).slice(0, LESSONS_PER_RUN);
  if (lessons.length === 0) return;
  const outside = (await outsideContentIn(tx, task.id)) !== null;
  for (const lesson of lessons) {
    await learn(tx, {
      companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: task.divisionId,
      body: lesson,
      source: 'agent',
      factKind: 'observation',
      outside,
      sourceTaskId: task.id,
    });
  }
}

/**
 * The same move, inside a transaction the caller already holds.
 *
 * For the writers whose change to something else and whose move of the task
 * are one fact: an owner's decision and the task it releases, an approval
 * request and the task it parks. As two transactions a crash between them left
 * a decision recorded against a task that never moved -- `waiting_approval`
 * for ever, with nothing left open in the inbox to say so.
 *
 * **The row is locked before it is read.** The status check and the write are
 * two statements, and without the lock a stop that committed between them was
 * silently undone: the check read `running`, the stop wrote `cancelled`, and
 * this wrote `completed` over it. With it, the second writer waits, reads what
 * the first committed, and is refused by the state machine rather than
 * overwriting it. Every writer takes the task before its inbox items, which is
 * the order the stop button's trigger takes them in too.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: the second conflicts with the key
 * share lock every foreign-key insert takes on its parent, so a transaction
 * holding the budget chain and inserting an event for this task would wait on
 * this lock while this transaction waited on the chain. The weaker lock is all
 * a status change needs -- it does not touch the key -- and it lets those
 * inserts through.
 */
export async function transitionWithin(
  tx: TenantClient,
  companyId: string,
  taskId: string,
  to: TaskStatus,
  options: TransitionOptions = {},
): Promise<void> {
  {
    await tx.query('SELECT 1 FROM tasks WHERE id = $1 FOR NO KEY UPDATE', [taskId]);
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
    // A ticket this task was working is done with it, or open again (0070).
    if (['completed', 'failed', 'halted', 'cancelled'].includes(to)) {
      await settleTicketsOf(tx, companyId, taskId, to);
    }

    // What finished work was about and what it produced, in its own event:
    // the timeline says so, and it is what the company learns from
    // (memory/distillation.ts). An event of only its type taught nothing.
    const completed = to === 'completed' ? whatWasDone(task.input, options.output) : null;
    await appendEvent(tx, {
      companyId,
      projectId: task.projectId,
      taskId,
      type: `task.${to}`,
      actor: 'system',
      payload: options.haltReason
        ? { haltReason: options.haltReason, ...(options.detail ? { detail: options.detail.slice(0, 2_000) } : {}) }
        : completed ?? {},
    });
    if (to === 'completed') await keepLessons(tx, companyId, task, options.output);
  }
}
