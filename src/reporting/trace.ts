/**
 * From an inbox item to the model call behind it (PRD F11.2).
 *
 * F11.2 is one line -- "trace dari item inbox <= 2 klik" -- and it had been
 * written down in docs/STATUS.md as "no owner PWA, so no live run view" and
 * filed under not built. That was a misreading of the requirement in four
 * places. F11.2 does not ask for a screen; it asks that the trace behind an
 * inbox item be *reachable* from it, in at most two hops. A UI is where the
 * clicking happens, and the obligation that has to hold underneath is that the
 * path exists and is short.
 *
 * It did not. `inbox_items.task_id` and `llm_traces.task_id` had been sitting
 * one join apart since the schema was written, `trajectoriesForTask` already
 * assembled a task's runs, and nothing connected an item to either. The owner
 * looking at an approval could not get to what the model was asked, which is
 * most of what "why is this being proposed" means.
 *
 * The shape returned is the two hops, made explicit rather than flattened: the
 * item, then the runs, then each run's calls. A caller that wants the prompt
 * says so -- the same rule the archive follows, because F11.5 keeps a prompt
 * for ninety days and a trace for a year, so the smaller answer is the one to
 * hand over by default.
 *
 * `trajectoriesForTask` is composed rather than copied. It already reads the
 * runs, their steps and their goal ancestry, and a second query over the same
 * rows would be a second thing to keep correct.
 */
import { withTenant } from '../db/tenant.ts';
import { trajectoriesForTask, type Trajectory } from '../eval/trajectory.ts';

export interface TraceCall {
  id: string;
  agentRunId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number | null;
  occurredAt: string;
  /**
   * Present only when the caller asked for prompts.
   *
   * `undefined` and "the prompt was scrubbed by retention" are different
   * answers and this type keeps them apart: absent means not requested, null
   * means it is gone (F11.5).
   */
  prompt?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
}

export interface InboxTrace {
  itemId: string;
  kind: string;
  title: string;
  tier: number | null;
  /** Null for an item that is not about a task -- a budget alert, say. */
  taskId: string | null;
  /**
   * Why there is nothing to show, when there is nothing.
   *
   * An empty answer and an answer that explains itself cost the same to
   * produce, and only one of them stops somebody assuming the trace was lost.
   */
  reason?: string;
  runs: Trajectory[];
  calls: TraceCall[];
}

export async function traceFromInboxItem(
  companyId: string,
  itemId: string,
  options: { includePrompts?: boolean } = {},
): Promise<InboxTrace | null> {
  const item = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      kind: string;
      title: string;
      tier: number | null;
      task_id: string | null;
    }>(
      'SELECT id, kind, title, tier, task_id FROM inbox_items WHERE id = $1',
      [itemId],
    );
    return rows[0] ?? null;
  });

  // Null rather than an empty trace: an item that is not in this company is
  // not an item with no trace, and row-level security has already made the
  // two indistinguishable from here.
  if (!item) return null;

  const base: InboxTrace = {
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    tier: item.tier,
    taskId: item.task_id,
    runs: [],
    calls: [],
  };

  if (!item.task_id) {
    return {
      ...base,
      reason: `a ${item.kind} item is not about one task, so there is no run behind it`,
    };
  }

  const runs = await trajectoriesForTask(companyId, item.task_id);
  const calls = await callsForTask(companyId, item.task_id, options.includePrompts ?? false);

  return {
    ...base,
    runs,
    calls,
    ...(calls.length === 0
      ? { reason: 'the task exists and no model call has been recorded against it yet' }
      : {}),
  };
}

/**
 * Every model call for a task, whether or not it belongs to a run.
 *
 * Keyed on the task rather than on the runs, deliberately. A trace carries
 * both ids and `agent_run_id` is nullable -- the engine records a call made
 * outside a run, and a run reclaimed after a crash leaves calls behind it.
 * Walking the runs would drop exactly the calls somebody is looking for when
 * a task went wrong, which is when they open the item.
 */
async function callsForTask(
  companyId: string,
  taskId: string,
  includePrompts: boolean,
): Promise<TraceCall[]> {
  return withTenant(companyId, async (tx) => {
    const columns = includePrompts
      ? `id, agent_run_id, model, prompt, response, input_tokens, output_tokens,
         cost_cents, latency_ms, occurred_at`
      : `id, agent_run_id, model, input_tokens, output_tokens,
         cost_cents, latency_ms, occurred_at`;

    const { rows } = await tx.query<{
      id: string;
      agent_run_id: string | null;
      model: string;
      prompt?: Record<string, unknown> | null;
      response?: Record<string, unknown> | null;
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
      latency_ms: number | null;
      occurred_at: Date;
    }>(
      `SELECT ${columns} FROM llm_traces WHERE task_id = $1 ORDER BY occurred_at`,
      [taskId],
    );

    return rows.map((row) => ({
      id: row.id,
      agentRunId: row.agent_run_id,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costCents: row.cost_cents,
      latencyMs: row.latency_ms,
      occurredAt: row.occurred_at.toISOString(),
      ...(includePrompts ? { prompt: row.prompt ?? null, response: row.response ?? null } : {}),
    }));
  });
}
