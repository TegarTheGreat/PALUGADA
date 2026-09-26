/**
 * What the owner's console reads to draw a company (PRD v2 F10.1, F10.2).
 *
 * The console used to ask for things it had no way to know: "Division id",
 * "Role id", "Goal id", typed in by hand, because nothing would tell it which
 * divisions a company had. A person who runs a company from an inbox should
 * be picking from the company's own shape, not pasting UUIDs out of a
 * database. These are the read models behind those pages: the company's
 * structure, its work, what happened lately, its accounts, schedules and
 * devices.
 *
 * Each one runs as the tenant, so row security decides what exists, and each
 * returns plain data shaped for a screen -- names beside ids, counts already
 * counted -- so the page holds no queries and no rules.
 */
import { metricsIn, type MetricView } from '../domain/metrics.ts';
import { withTenant } from '../db/tenant.ts';
import { redactor } from '../secrets/manager.ts';
import { fingerprint } from '../gateway/gateway.ts';
import { TERMINAL_STATUSES, type TaskStatus } from '../domain/task.ts';
import { LOW_CONFIDENCE } from '../context/builder.ts';

/* -------------------------------------------------------------- structure --- */

export interface StructureView {
  projects: Array<{ id: string; slug: string; name: string }>;
  goals: Array<{
    id: string;
    parentId: string | null;
    kind: string;
    slug: string;
    statement: string;
    status: string;
    /**
     * How far the work under this goal has got: tasks hanging from it or from
     * any goal under it, finished and in all. A goal's progress is what its
     * key results' work adds up to, so the counts roll up the ladder.
     */
    tasksDone: number;
    tasksTotal: number;
    /** What the goal is measured by, with the latest value and progress (0053). */
    metrics: MetricView[];
  }>;
  divisions: Array<{
    id: string;
    parentId: string | null;
    slug: string;
    name: string;
    depth: number;
    maxConcurrency: number;
    escalationRole: string | null;
    escalateAfterMinutes: number | null;
    /** Tasks that are not finished, in this division. */
    openTasks: number;
    grants: Array<{ capability: string; tier: number | null }>;
  }>;
  roles: Array<{
    id: string;
    divisionId: string;
    slug: string;
    model: string;
    runtime: string | null;
    tools: string[];
    heartbeatMinutes: number | null;
    dormantUntil: Date | null;
    frozenAt: Date | null;
    frozenReason: string | null;
    openTasks: number;
    doneLastWeek: number;
    /** The role's charter: who it is and how it works, first in every run's context (F3.1). */
    charter: string;
    /** What finished looks like for this role, testable (F2.8). */
    doneCriteria: string[];
  }>;
}

/** The company's shape: goal ladder, divisions with their grants, roles. */
export async function structureOf(companyId: string): Promise<StructureView> {
  return withTenant(companyId, async (tx) => {
    const [projects, goals, divisions, grants, roles, goalWork] = await Promise.all([
      tx.query<{ id: string; slug: string; name: string }>(
        'SELECT id, slug, name FROM projects ORDER BY created_at',
      ),
      tx.query<{
        id: string; parent_goal_id: string | null; kind: string; slug: string;
        statement: string; status: string;
      }>(
        `SELECT id, parent_goal_id, kind, slug, statement, status
           FROM goals ORDER BY created_at`,
      ),
      tx.query<{
        id: string; parent_division_id: string | null; slug: string; name: string;
        depth: number; max_concurrency: number; escalation_role_slug: string | null;
        escalate_after_minutes: number | null; open_tasks: number;
      }>(
        `SELECT d.id, d.parent_division_id, d.slug, d.name, d.depth, d.max_concurrency,
                d.escalation_role_slug, d.escalate_after_minutes,
                (SELECT count(*)::int FROM tasks t
                  WHERE t.division_id = d.id AND NOT (t.status = ANY ($1))) AS open_tasks
           FROM divisions d
          ORDER BY d.depth, d.created_at`,
        [TERMINAL_STATUSES],
      ),
      tx.query<{ division_id: string; capability_name: string; tier_override: number | null }>(
        `SELECT division_id, capability_name, tier_override
           FROM capability_grants ORDER BY capability_name`,
      ),
      tx.query<{
        id: string; division_id: string; slug: string; model: string; runtime: string | null;
        tools: string[]; heartbeat_minutes: number | null; dormant_until: Date | null;
        frozen_at: Date | null; frozen_reason: string | null;
        open_tasks: number; done_last_week: number; system_prompt: string; done_criteria: string[] | null;
      }>(
        `SELECT r.id, r.division_id, r.slug, coalesce(r.model_primary, r.model) AS model,
                r.runtime, r.tools, r.heartbeat_minutes, r.dormant_until,
                r.frozen_at, r.frozen_reason, r.system_prompt, r.done_criteria,
                (SELECT count(*)::int FROM tasks t
                  WHERE t.role_id = r.id AND NOT (t.status = ANY ($1))) AS open_tasks,
                (SELECT count(*)::int FROM tasks t
                  WHERE t.role_id = r.id AND t.status = 'completed'
                    AND t.finished_at > now() - interval '7 days') AS done_last_week
           FROM roles r
          ORDER BY r.created_at`,
        [TERMINAL_STATUSES],
      ),
      tx.query<{ goal_id: string; done: number; total: number }>(
        `SELECT goal_id, count(*) FILTER (WHERE status = 'completed')::int AS done, count(*)::int AS total
           FROM tasks WHERE goal_id IS NOT NULL GROUP BY goal_id`,
      ),
    ]);

    const metrics = await metricsIn(tx);

    // Rolled up the ladder: a goal counts its own tasks and every goal's under it.
    const own = new Map(goalWork.rows.map((row) => [row.goal_id, row]));
    const children = new Map<string, string[]>();
    for (const goal of goals.rows) {
      if (!goal.parent_goal_id) continue;
      children.set(goal.parent_goal_id, [...(children.get(goal.parent_goal_id) ?? []), goal.id]);
    }
    const rolled = new Map<string, { done: number; total: number }>();
    const roll = (id: string, seen: Set<string>): { done: number; total: number } => {
      const cached = rolled.get(id);
      if (cached) return cached;
      const sum = { done: own.get(id)?.done ?? 0, total: own.get(id)?.total ?? 0 };
      if (!seen.has(id)) {
        seen.add(id);
        for (const child of children.get(id) ?? []) {
          const below = roll(child, seen);
          sum.done += below.done;
          sum.total += below.total;
        }
      }
      rolled.set(id, sum);
      return sum;
    };

    const grantsBy = new Map<string, Array<{ capability: string; tier: number | null }>>();
    for (const grant of grants.rows) {
      const list = grantsBy.get(grant.division_id) ?? [];
      list.push({ capability: grant.capability_name, tier: grant.tier_override });
      grantsBy.set(grant.division_id, list);
    }

    return {
      projects: projects.rows,
      goals: goals.rows.map((goal) => ({
        id: goal.id,
        parentId: goal.parent_goal_id,
        kind: goal.kind,
        slug: goal.slug,
        statement: goal.statement,
        status: goal.status,
        tasksDone: roll(goal.id, new Set()).done,
        tasksTotal: roll(goal.id, new Set()).total,
        metrics: metrics.filter((metric) => metric.goalId === goal.id),
      })),
      divisions: divisions.rows.map((division) => ({
        id: division.id,
        parentId: division.parent_division_id,
        slug: division.slug,
        name: division.name,
        depth: division.depth,
        maxConcurrency: division.max_concurrency,
        escalationRole: division.escalation_role_slug,
        escalateAfterMinutes: division.escalate_after_minutes,
        openTasks: division.open_tasks,
        grants: grantsBy.get(division.id) ?? [],
      })),
      roles: roles.rows.map((role) => ({
        id: role.id,
        divisionId: role.division_id,
        slug: role.slug,
        model: role.model,
        runtime: role.runtime,
        tools: role.tools,
        heartbeatMinutes: role.heartbeat_minutes,
        dormantUntil: role.dormant_until,
        frozenAt: role.frozen_at,
        frozenReason: role.frozen_reason,
        openTasks: role.open_tasks,
        doneLastWeek: role.done_last_week,
        charter: role.system_prompt,
        doneCriteria: role.done_criteria ?? [],
      })),
    };
  });
}

/* ------------------------------------------------------------------- work --- */

/**
 * The groups the work page filters by. A person asks "what is running", "what
 * is stuck on something", "what finished", "what went wrong" -- not for one of
 * eleven statuses by name.
 */
export const WORK_GROUPS = {
  active: ['pending', 'checked_out', 'running'],
  waiting: ['waiting_approval', 'waiting_review', 'waiting_window'],
  done: ['completed'],
  stopped: ['failed', 'halted', 'cancelled'],
} as const satisfies Record<string, readonly TaskStatus[]>;

export type WorkGroup = keyof typeof WORK_GROUPS;

export function isWorkGroup(value: unknown): value is WorkGroup {
  return typeof value === 'string' && Object.hasOwn(WORK_GROUPS, value);
}

export interface WorkItem {
  id: string;
  status: TaskStatus;
  haltReason: string | null;
  /** What the task is for, in words: the first of its input's describing fields. */
  summary: string;
  /**
   * What it produced, in words, once it has: the first of its output's
   * describing fields. Null until there is an output.
   */
  result: string | null;
  roleSlug: string;
  divisionName: string;
  goal: string | null;
  schedule: string | null;
  priority: number;
  attempt: number;
  attemptMax: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  costCents: number;
  parentTaskId: string | null;
  /**
   * How far it has got, from its own journal: steps committed, the step it
   * is on or last took, how many actions its plan named, which worker holds
   * it and when that worker last said it was alive. What an owner asks of a
   * task that has been "running" for an hour is exactly these.
   */
  progress: {
    stepsDone: number;
    currentStep: string | null;
    currentStepStatus: string | null;
    planSteps: number | null;
    worker: string | null;
    heartbeatAt: Date | null;
    deadlineAt: Date | null;
  };
}

export interface WorkView {
  items: WorkItem[];
  /** How many tasks are in each group, whatever the filter, for the tabs. */
  counts: Record<WorkGroup, number>;
}

export async function workOf(
  companyId: string,
  options: { group?: WorkGroup; limit?: number } = {},
): Promise<WorkView> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const statuses = options.group ? [...WORK_GROUPS[options.group]] : null;
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; status: TaskStatus; halt_reason: string | null; input: unknown;
      role_slug: string; division_name: string; goal: string | null; schedule: string | null;
      priority: number; attempt: number; attempt_max: number; created_at: Date;
      started_at: Date | null; finished_at: Date | null; cost_cents: string;
      parent_task_id: string | null; output: unknown; steps_done: number; current_step: string | null;
      current_step_status: string | null; plan_steps: number | null; lease_holder: string | null;
      heartbeat_at: Date | null; deadline_at: Date | null;
    }>(
      `SELECT t.id, t.status, t.halt_reason, t.input, r.slug AS role_slug,
              d.name AS division_name, g.statement AS goal, s.slug AS schedule,
              t.priority, t.attempt, t.attempt_max, t.created_at, t.started_at,
              t.finished_at, t.parent_task_id, t.lease_holder, t.deadline_at, t.output,
              coalesce((SELECT sum(l.cost_cents) FROM llm_traces l WHERE l.task_id = t.id), 0)
                AS cost_cents,
              (SELECT count(*)::int FROM task_steps j
                WHERE j.task_id = t.id AND j.status = 'committed') AS steps_done,
              last.name AS current_step, last.status AS current_step_status,
              CASE WHEN jsonb_typeof(t.plan -> 'steps') = 'array'
                   THEN jsonb_array_length(t.plan -> 'steps') END AS plan_steps,
              (SELECT max(a.last_heartbeat_at) FROM agent_runs a WHERE a.task_id = t.id) AS heartbeat_at
         FROM tasks t
         JOIN roles r ON r.id = t.role_id
         JOIN divisions d ON d.id = t.division_id
         LEFT JOIN goals g ON g.id = t.goal_id
         LEFT JOIN schedules s ON s.id = t.schedule_id
         LEFT JOIN LATERAL (
           SELECT j.name, j.status FROM task_steps j
            WHERE j.task_id = t.id ORDER BY j.step_index DESC LIMIT 1
         ) last ON true
        WHERE $1::text[] IS NULL OR t.status = ANY ($1)
        ORDER BY t.created_at DESC
        LIMIT $2`,
      [statuses, limit],
    );
    const { rows: grouped } = await tx.query<{ status: TaskStatus; n: number }>(
      'SELECT status, count(*)::int AS n FROM tasks GROUP BY status',
    );

    const counts = { active: 0, waiting: 0, done: 0, stopped: 0 } as Record<WorkGroup, number>;
    for (const { status, n } of grouped) {
      for (const [group, members] of Object.entries(WORK_GROUPS) as Array<[WorkGroup, readonly TaskStatus[]]>) {
        if (members.includes(status)) counts[group] += n;
      }
    }

    return {
      counts,
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        haltReason: row.halt_reason,
        summary: summarise(row.input),
        result: row.output === null || row.output === undefined ? null : summarise(row.output, 200, RESULT_FIELDS),
        roleSlug: row.role_slug,
        divisionName: row.division_name,
        goal: row.goal,
        schedule: row.schedule,
        priority: row.priority,
        attempt: row.attempt,
        attemptMax: row.attempt_max,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        costCents: Number(row.cost_cents),
        parentTaskId: row.parent_task_id,
        progress: {
          stepsDone: row.steps_done,
          currentStep: row.current_step,
          currentStepStatus: row.current_step_status,
          planSteps: row.plan_steps,
          worker: row.lease_holder,
          heartbeatAt: row.heartbeat_at,
          deadlineAt: row.deadline_at,
        },
      })),
    };
  });
}

/** The fields a task's input uses to say what it is, in the order they are tried. */
const DESCRIBING_FIELDS = ['goal', 'title', 'summary', 'task', 'request', 'subject', 'check'];

/**
 * The fields an output uses to say what came of it. An answer before a
 * title: `{ confidence: 'high', answer: '...' }` is about the answer.
 */
const RESULT_FIELDS = ['summary', 'result', 'answer', 'outcome', 'conclusion', 'message', 'text', 'title'];

/**
 * A task's input, as one line a person can read.
 *
 * The input is whatever the role's schema says, so there is no one field to
 * read. The describing ones come first; failing those, the first string in
 * it; failing that, the JSON itself, cut short. Never empty, because a row
 * with no words in it is a row nobody can tell apart from the next.
 */
export function summarise(input: unknown, max = 140, fields: readonly string[] = DESCRIBING_FIELDS): string {
  const cut = (text: string) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  if (typeof input === 'string' && input.trim()) return cut(input.trim());
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string' && value.trim()) return cut(value.trim());
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim()) return cut(value.trim());
    }
  }
  const json = JSON.stringify(input ?? null);
  return cut(json === '{}' || json === 'null' ? 'No description' : json);
}

/* ------------------------------------------------------------ one task --- */

/** Something a task wrote down for a person to read: a document, an email. */
export interface Deliverable {
  step: number;
  /** The capability that wrote it, without the journal's `capability:` prefix. */
  capability: string;
  /** The email's subject, or the document's path when it has no other name. */
  title: string;
  path: string;
  text: string;
  words: number | null;
  to: string | null;
  at: Date | null;
}

export interface TaskDetail {
  id: string;
  status: TaskStatus;
  input: unknown;
  output: unknown;
  deliverables: Deliverable[];
}

/**
 * One task, with what it produced.
 *
 * The output as the task returned it, and every draft it committed -- read
 * from the journal, where the capability's result already holds the text, so
 * nothing is read from the files directory and no path from a row is ever
 * opened. A draft that did not commit is left out: the journal does not say
 * it exists. Redacted on the way out, like every other surface (F12.4): a
 * draft is whatever a model wrote, and a model can repeat a key it was shown.
 *
 * Null for a task that is not in this company, which is what row level
 * security makes of another company's id.
 */
export async function taskDetailOf(companyId: string, taskId: string): Promise<TaskDetail | null> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: TaskStatus; input: unknown; output: unknown }>(
      'SELECT id, status, input, output FROM tasks WHERE id = $1',
      [taskId],
    );
    const task = rows[0];
    if (!task) return null;
    const { rows: steps } = await tx.query<{
      step_index: number; name: string; committed_at: Date | null; output: Record<string, unknown>;
    }>(
      `SELECT step_index, name, committed_at, output FROM task_steps
        WHERE task_id = $1 AND status = 'committed' AND name LIKE 'capability:%'
          AND jsonb_typeof(output -> 'path') = 'string'
          AND (jsonb_typeof(output -> 'text') = 'string' OR jsonb_typeof(output -> 'body') = 'string')
        ORDER BY step_index`,
      [taskId],
    );
    // Field by field rather than `redactDeep` over the whole answer, which
    // would turn each `Date` into an empty object.
    const text = (value: unknown) => (typeof value === 'string' ? redactor.redact(value) : null);
    return {
      id: task.id,
      status: task.status,
      input: redactor.redactDeep(task.input),
      output: redactor.redactDeep(task.output),
      deliverables: steps.map((step) => ({
        step: step.step_index,
        capability: step.name.replace(/^capability:/, ''),
        title: text(step.output.subject) ?? text(step.output.title) ?? text(step.output.path)!,
        path: text(step.output.path)!,
        text: text(step.output.text) ?? text(step.output.body) ?? '',
        words: typeof step.output.words === 'number' ? step.output.words : null,
        to: text(step.output.to),
        at: step.committed_at,
      })),
    };
  });
}

/* --------------------------------------------------------------- activity --- */

export interface ActivityItem {
  id: string;
  type: string;
  actor: string;
  occurredAt: Date;
  taskId: string | null;
  payload: Record<string, unknown>;
}

/**
 * The events that record the platform's rhythm rather than anything that
 * happened to the company: a dormant role waking to find nothing, wakes
 * folded together, an estimate before the real figure. They matter to an
 * audit and drown a feed, where eight "woke with nothing to do" push the one
 * refused payment off the screen.
 */
export const ROUTINE_EVENTS = [
  'wake.idle', 'wake.coalesced', 'wake.queued', 'cost.estimated', 'tool.cost',
] as const;

/** What happened lately, newest first: the company's event log, from the top. */
export async function activityOf(
  companyId: string,
  limit = 30,
  options: { routine?: boolean } = {},
): Promise<ActivityItem[]> {
  const bounded = Math.min(Math.max(limit, 1), 100);
  const hidden = options.routine ? [] : [...ROUTINE_EVENTS];
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; type: string; actor: string; occurred_at: Date; task_id: string | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT id, type, actor, occurred_at, task_id, payload
         FROM events
        WHERE type <> ALL ($2::text[])
        ORDER BY occurred_at DESC
        LIMIT $1`,
      [bounded, hidden],
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      actor: row.actor,
      occurredAt: row.occurred_at,
      taskId: row.task_id,
      payload: row.payload ?? {},
    }));
  });
}

/* --------------------------------------------------------------- accounts --- */

export interface AccountView {
  id: string;
  label: string;
  scopeType: string;
  scopeId: string | null;
  /** The division, project or role the account is scoped to, by name. */
  scopeName: string | null;
  parentId: string | null;
  tokensMax: number;
  tokensSpent: number;
  tokensReserved: number;
  moneyMaxCents: number;
  moneySpentCents: number;
}

export async function accountsOf(companyId: string): Promise<AccountView[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; label: string; scope_type: string; scope_id: string | null;
      scope_name: string | null; parent_account_id: string | null;
      tokens_max: string; tokens_spent: string; tokens_reserved: string;
      money_max_cents: string; money_spent_cents: string;
    }>(
      `SELECT a.id, a.label, a.scope_type, a.scope_id, a.parent_account_id,
              a.tokens_max, a.tokens_spent, a.tokens_reserved,
              a.money_max_cents, a.money_spent_cents,
              coalesce(d.name, p.name, r.slug) AS scope_name
         FROM budget_accounts a
         LEFT JOIN divisions d ON a.scope_type = 'division' AND d.id = a.scope_id
         LEFT JOIN projects p ON a.scope_type = 'project' AND p.id = a.scope_id
         LEFT JOIN roles r ON a.scope_type = 'role' AND r.id = a.scope_id
        ORDER BY a.parent_account_id NULLS FIRST, a.created_at`,
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      scopeName: row.scope_name,
      parentId: row.parent_account_id,
      tokensMax: Number(row.tokens_max),
      tokensSpent: Number(row.tokens_spent),
      tokensReserved: Number(row.tokens_reserved),
      moneyMaxCents: Number(row.money_max_cents),
      moneySpentCents: Number(row.money_spent_cents),
    }));
  });
}

/* -------------------------------------------------------------- schedules --- */

export interface ScheduleView {
  id: string;
  slug: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  roleSlug: string;
  divisionName: string;
  priority: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Why the last occurrence could not fire, while it still cannot. */
  failure: string | null;
}

export async function schedulesOf(companyId: string): Promise<ScheduleView[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; slug: string; cron_expression: string; timezone: string; enabled: boolean;
      role_slug: string; division_name: string; priority: number;
      next_run_at: Date | null; last_run_at: Date | null; fire_failure: string | null;
    }>(
      `SELECT s.id, s.slug, s.cron_expression, s.timezone, s.enabled, r.slug AS role_slug,
              d.name AS division_name, s.priority, s.next_run_at, s.last_run_at, s.fire_failure
         FROM schedules s
         JOIN roles r ON r.id = s.role_id
         JOIN divisions d ON d.id = s.division_id
        ORDER BY s.enabled DESC, s.next_run_at NULLS LAST, s.slug`,
    );
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      cron: row.cron_expression,
      timezone: row.timezone,
      enabled: row.enabled,
      roleSlug: row.role_slug,
      divisionName: row.division_name,
      priority: row.priority,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      failure: row.fire_failure,
    }));
  });
}

/* ---------------------------------------------------------------- devices --- */

export interface DeviceView {
  id: string;
  name: string;
  runtime: string;
  status: string;
  quarantined: boolean;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  /** Null when what is stored is not a key: registered before keys were checked. */
  keyFingerprint: string | null;
}

export async function devicesOf(companyId: string): Promise<DeviceView[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; name: string; runtime: string; status: string; quarantined: boolean;
      paired_at: Date | null; last_seen_at: Date | null; created_at: Date; public_key: string;
    }>(
      `SELECT id, name, runtime, status, quarantined, paired_at, last_seen_at, created_at, public_key
         FROM gateway_devices ORDER BY created_at`,
    );
    return rows.map((row) => {
      let keyFingerprint: string | null;
      try {
        keyFingerprint = fingerprint(row.public_key);
      } catch {
        keyFingerprint = null;
      }
      return {
        id: row.id,
        name: row.name,
        runtime: row.runtime,
        status: row.status,
        quarantined: row.quarantined,
        pairedAt: row.paired_at,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        keyFingerprint,
      };
    });
  });
}

/* ----------------------------------------------------------------- memory --- */

export const MEMORY_KINDS = ['working', 'episodic', 'semantic', 'procedural'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export interface MemoryView {
  id: string;
  kind: MemoryKind;
  body: string;
  scopeType: string;
  /** The project or division it is scoped to, by name; null for the company. */
  scopeName: string | null;
  confidence: number;
  /**
   * Under the confidence a run is told to treat as unverified (F4.5). Said
   * here as the context builder says it, so the page and the agent see the
   * same fact the same way.
   */
  unverified: boolean;
  source: string;
  factKind: string | null;
  approval: string;
  supersededBy: string | null;
  createdAt: Date;
}

/**
 * What the company knows (F4): facts, procedures, episodes and working notes,
 * where each applies and how sure the platform is of it. The owner reads it
 * to see what the agents will be told, and corrects it from here.
 */
export async function memoriesOf(
  companyId: string,
  options: { kind?: MemoryKind; query?: string; superseded?: boolean; limit?: number } = {},
): Promise<{ items: MemoryView[]; counts: Record<MemoryKind, number>; candidates: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; memory_type: MemoryKind; body: string; scope_type: string; scope_name: string | null;
      confidence: number; source: string; fact_kind: string | null; approval_state: string;
      superseded_by: string | null; created_at: Date;
    }>(
      `SELECT m.id, m.memory_type, m.body, m.scope_type, m.confidence, m.source, m.fact_kind,
              m.approval_state, m.superseded_by, m.created_at,
              coalesce(d.name, p.name) AS scope_name
         FROM memories m
         LEFT JOIN divisions d ON m.scope_type = 'division' AND d.id = m.scope_id
         LEFT JOIN projects p ON m.scope_type = 'project' AND p.id = m.scope_id
        WHERE ($1::text IS NULL OR m.memory_type = $1)
          AND ($2::text IS NULL OR m.body ILIKE '%' || $2 || '%')
          AND ($3 OR m.superseded_by IS NULL)
        ORDER BY m.created_at DESC
        LIMIT $4`,
      [options.kind ?? null, options.query?.trim() || null, options.superseded ?? false, limit],
    );
    const { rows: grouped } = await tx.query<{ memory_type: MemoryKind; n: number; candidates: number }>(
      `SELECT memory_type, count(*)::int AS n,
              count(*) FILTER (WHERE approval_state = 'candidate')::int AS candidates
         FROM memories WHERE superseded_by IS NULL GROUP BY memory_type`,
    );
    const counts = { working: 0, episodic: 0, semantic: 0, procedural: 0 } as Record<MemoryKind, number>;
    let candidates = 0;
    for (const row of grouped) {
      counts[row.memory_type] = row.n;
      candidates += row.candidates;
    }
    return {
      counts,
      candidates,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.memory_type,
        body: row.body,
        scopeType: row.scope_type,
        scopeName: row.scope_name,
        confidence: row.confidence,
        unverified: row.confidence < LOW_CONFIDENCE,
        source: row.source,
        factKind: row.fact_kind,
        approval: row.approval_state,
        supersededBy: row.superseded_by,
        createdAt: row.created_at,
      })),
    };
  });
}
