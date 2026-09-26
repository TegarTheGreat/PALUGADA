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
import { withTenant } from '../db/tenant.ts';
import { fingerprint } from '../gateway/gateway.ts';
import { TERMINAL_STATUSES, type TaskStatus } from '../domain/task.ts';

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
  }>;
}

/** The company's shape: goal ladder, divisions with their grants, roles. */
export async function structureOf(companyId: string): Promise<StructureView> {
  return withTenant(companyId, async (tx) => {
    const [projects, goals, divisions, grants, roles] = await Promise.all([
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
        open_tasks: number; done_last_week: number;
      }>(
        `SELECT r.id, r.division_id, r.slug, coalesce(r.model_primary, r.model) AS model,
                r.runtime, r.tools, r.heartbeat_minutes, r.dormant_until,
                r.frozen_at, r.frozen_reason,
                (SELECT count(*)::int FROM tasks t
                  WHERE t.role_id = r.id AND NOT (t.status = ANY ($1))) AS open_tasks,
                (SELECT count(*)::int FROM tasks t
                  WHERE t.role_id = r.id AND t.status = 'completed'
                    AND t.finished_at > now() - interval '7 days') AS done_last_week
           FROM roles r
          ORDER BY r.created_at`,
        [TERMINAL_STATUSES],
      ),
    ]);

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
      parent_task_id: string | null;
    }>(
      `SELECT t.id, t.status, t.halt_reason, t.input, r.slug AS role_slug,
              d.name AS division_name, g.statement AS goal, s.slug AS schedule,
              t.priority, t.attempt, t.attempt_max, t.created_at, t.started_at,
              t.finished_at, t.parent_task_id,
              coalesce((SELECT sum(l.cost_cents) FROM llm_traces l WHERE l.task_id = t.id), 0)
                AS cost_cents
         FROM tasks t
         JOIN roles r ON r.id = t.role_id
         JOIN divisions d ON d.id = t.division_id
         LEFT JOIN goals g ON g.id = t.goal_id
         LEFT JOIN schedules s ON s.id = t.schedule_id
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
      })),
    };
  });
}

/** The fields a task's input uses to say what it is, in the order they are tried. */
const DESCRIBING_FIELDS = ['goal', 'title', 'summary', 'task', 'request', 'subject', 'check'];

/**
 * A task's input, as one line a person can read.
 *
 * The input is whatever the role's schema says, so there is no one field to
 * read. The describing ones come first; failing those, the first string in
 * it; failing that, the JSON itself, cut short. Never empty, because a row
 * with no words in it is a row nobody can tell apart from the next.
 */
export function summarise(input: unknown, max = 140): string {
  const cut = (text: string) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  if (typeof input === 'string' && input.trim()) return cut(input.trim());
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const field of DESCRIBING_FIELDS) {
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
