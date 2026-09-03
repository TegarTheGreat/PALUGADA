/**
 * Trajectory export (PRD v2 F17.1, F11.7).
 *
 * A trajectory is what one agent run actually did, in one document: the
 * context it was given, every tool call and how it was decided, every hook
 * that refused something, the model calls, and what it produced.
 *
 * It is derived rather than stored. The event log, the step journal and the
 * traces are already append-only and already retained, so a second copy would
 * mean two answers to "what did this run do" and a slow argument about which
 * one is right. Export reads the records that already exist and arranges them
 * in time order.
 *
 * What that costs, said plainly: a trajectory is only as complete as retention
 * allows. F11.6 expires prompts before events, so an old run exports with its
 * decisions intact and its transcript gone. That is the right trade -- the
 * decisions are what an eval judges -- but it means a trajectory is evidence of
 * what was decided rather than a recording of what was said.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';

export interface TrajectoryStep {
  at: string;
  kind: 'tool_call' | 'tool_result' | 'hook' | 'model' | 'denial' | 'lifecycle';
  name: string;
  detail: Record<string, unknown>;
}

export interface Trajectory {
  agentRunId: string;
  taskId: string;
  roleId: string;
  roleSlug: string;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  haltReason: string | null;
  /** F17.1: the context the run was given, as far as it is still recorded. */
  goalAncestry: Array<{ kind: string; statement: string }>;
  steps: TrajectoryStep[];
  tokens: { input: number; output: number };
  costCents: number;
}

/** Event types that describe what a run decided rather than what it logged. */
const DECISION_EVENTS = new Set([
  'tool.called',
  'tool.verified',
  'tool.verify_failed',
  'policy.denied',
  'capability.window_closed',
  'task.batched',
  'model.fell_back',
  'model.fallback_refused',
  'review.opened',
  'review.decided',
  'approval.requested',
]);

function kindFor(type: string): TrajectoryStep['kind'] {
  if (type.startsWith('hook.')) return 'hook';
  if (type === 'tool.called') return 'tool_call';
  if (type.startsWith('tool.verif')) return 'tool_result';
  if (type === 'policy.denied') return 'denial';
  if (type.startsWith('model.')) return 'model';
  return 'lifecycle';
}

export async function exportTrajectory(
  companyId: string,
  agentRunId: string,
): Promise<Trajectory | null> {
  return withTenant(companyId, async (tx) => {
    const { rows: runs } = await tx.query<{
      id: string;
      task_id: string;
      role_id: string;
      role_slug: string;
      status: string;
      attempt: number;
      started_at: Date;
      finished_at: Date | null;
      input: Record<string, unknown>;
      output: Record<string, unknown> | null;
      halt_reason: string | null;
    }>(
      `SELECT r.id, r.task_id, r.role_id, ro.slug AS role_slug, r.status, r.attempt,
              r.started_at, r.finished_at, t.input, t.output, t.halt_reason
         FROM agent_runs r
         JOIN tasks t ON t.id = r.task_id
         JOIN roles ro ON ro.id = r.role_id
        WHERE r.id = $1`,
      [agentRunId],
    );
    const run = runs[0];
    if (!run) return null;

    // The window is the run's own. Two attempts against one task write to the
    // same event stream, so a trajectory that took everything for the task
    // would attribute the first attempt's mistakes to the second.
    const until = run.finished_at ?? new Date();

    const { rows: events } = await tx.query<{
      type: string;
      actor: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT type, actor, payload, occurred_at
         FROM events
        WHERE task_id = $1 AND occurred_at >= $2 AND occurred_at <= $3
        ORDER BY occurred_at`,
      [run.task_id, run.started_at, until],
    );

    const { rows: steps } = await tx.query<{
      name: string;
      kind: string;
      status: string;
      output: unknown;
      error: string | null;
      committed_at: Date | null;
      started_at: Date;
    }>(
      `SELECT name, kind, status, output, error, committed_at, started_at
         FROM task_steps
        WHERE task_id = $1 AND started_at >= $2
        ORDER BY step_index`,
      [run.task_id, run.started_at],
    );

    const { rows: traces } = await tx.query<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
      occurred_at: Date;
    }>(
      `SELECT model, input_tokens, output_tokens, cost_cents, occurred_at
         FROM llm_traces WHERE agent_run_id = $1 ORDER BY occurred_at`,
      [agentRunId],
    );

    const { rows: goals } = await tx.query<{ kind: string; statement: string }>(
      `WITH RECURSIVE chain AS (
         SELECT g.id, g.kind, g.statement, g.parent_goal_id, 0 AS depth
           FROM goals g JOIN tasks t ON t.goal_id = g.id
          WHERE t.id = $1
         UNION ALL
         SELECT p.id, p.kind, p.statement, p.parent_goal_id, chain.depth + 1
           FROM goals p JOIN chain ON chain.parent_goal_id = p.id
       )
       SELECT kind, statement FROM chain ORDER BY depth DESC`,
      [run.task_id],
    );

    const trajectory: TrajectoryStep[] = [];

    for (const event of events) {
      if (!DECISION_EVENTS.has(event.type) && !event.type.startsWith('hook.')) continue;
      trajectory.push({
        at: event.occurred_at.toISOString(),
        kind: kindFor(event.type),
        name: event.type,
        detail: { actor: event.actor, ...event.payload },
      });
    }

    for (const step of steps) {
      trajectory.push({
        at: (step.committed_at ?? step.started_at).toISOString(),
        kind: step.kind === 'llm' ? 'model' : 'tool_result',
        name: step.name,
        detail: {
          status: step.status,
          ...(step.error === null ? {} : { error: step.error }),
          ...(step.output === null || step.output === undefined ? {} : { output: step.output }),
        },
      });
    }

    for (const trace of traces) {
      trajectory.push({
        at: trace.occurred_at.toISOString(),
        kind: 'model',
        name: 'model.call',
        detail: {
          model: trace.model,
          inputTokens: trace.input_tokens,
          outputTokens: trace.output_tokens,
        },
      });
    }

    trajectory.sort((a, b) => a.at.localeCompare(b.at));

    return {
      agentRunId: run.id,
      taskId: run.task_id,
      roleId: run.role_id,
      roleSlug: run.role_slug,
      status: run.status,
      attempt: run.attempt,
      startedAt: run.started_at.toISOString(),
      finishedAt: run.finished_at?.toISOString() ?? null,
      input: run.input,
      output: run.output,
      haltReason: run.halt_reason,
      goalAncestry: goals,
      steps: trajectory,
      tokens: {
        input: traces.reduce((total, trace) => total + trace.input_tokens, 0),
        output: traces.reduce((total, trace) => total + trace.output_tokens, 0),
      },
      costCents: traces.reduce((total, trace) => total + trace.cost_cents, 0),
    };
  });
}

/** Every run for a task, oldest attempt first. */
export async function trajectoriesForTask(
  companyId: string,
  taskId: string,
): Promise<Trajectory[]> {
  const ids = await withTenant(companyId, async (tx: TenantClient) => {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM agent_runs WHERE task_id = $1 ORDER BY attempt',
      [taskId],
    );
    return rows.map((row) => row.id);
  });

  const out: Trajectory[] = [];
  for (const id of ids) {
    const trajectory = await exportTrajectory(companyId, id);
    if (trajectory) out.push(trajectory);
  }
  return out;
}
