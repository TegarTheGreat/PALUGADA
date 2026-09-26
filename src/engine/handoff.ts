/**
 * Handoff between roles (PRD F6.1, F6.3).
 *
 * Principle 4: agents do not talk to agents. There is no "send a message"
 * primitive anywhere in this codebase, and this module is why one is not
 * needed. A role finishes, writes its typed output to state, and the engine
 * emits `task.completed`. Whatever runs next is created from that event, by
 * the engine, according to rules the owner configured -- not by the finishing
 * agent deciding who to call.
 *
 * The distinction is not ceremony. If an agent could name its successor, the
 * call graph would live in prompts, where it cannot be inspected, bounded or
 * replayed. Here the trigger is an event in the log and the resulting task is
 * subject to the same depth, fan-out, cycle and budget checks as any other.
 *
 * The rules themselves are code rather than rows, and that is worth being
 * precise about because "the rules are visible" would otherwise read as "an
 * owner can see them in a table". A rule carries a `mapInput` function, so it
 * is supplied by whatever composes the process -- the same arrangement as the
 * capability registry, where `baseRegistry()` binds what the platform
 * implements and an operator binds the rest. `Worker` takes them as an option
 * and runs them each tick, so a deployment with rules gets handoffs from the
 * loop instead of having to write a second one.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { createSubTask, type TaskRow } from './tasks.ts';

export interface HandoffRule {
  /** Role whose completion triggers this handoff. */
  fromRoleSlug: string;
  /** Role to start next. */
  toRoleSlug: string;
  /**
   * Builds the successor's input from the predecessor's output.
   *
   * Returning null declines the handoff, which is how a rule stays conditional
   * without needing a condition language of its own.
   */
  mapInput(output: Record<string, unknown>): Record<string, unknown> | null;
}

export interface HandoffResult {
  fromTaskId: string;
  toTaskId: string;
  toRoleSlug: string;
}

interface CompletedTask {
  id: string;
  project_id: string;
  division_id: string;
  output: Record<string, unknown> | null;
  /** Set when an earlier pass refused this handoff for a reason that may lift. */
  refused_code: string | null;
  refused_reason: string | null;
}

/**
 * How far back a completion is still owed its handoffs.
 *
 * Long enough to cover a worker that was down over a long weekend, which is
 * the case "driven by state" exists for. Bounded, because a rule is code and
 * carries no date: a deployment that adds one would otherwise hand off every
 * completion in the company's history on its first tick.
 */
export const HANDOFF_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** How many completions one pass takes up per rule, so a backlog drains over ticks. */
const HANDOFF_BATCH = 100;

/**
 * Refusals that can lift without the completed task changing: a budget the
 * owner raises, a spend pause that ends, a role that is unfrozen. These are
 * retried on later passes. Anything else -- the hop limit, the fan-out bound,
 * a cycle -- is a property of the tree and is final.
 */
const MAY_LIFT = new Set([
  'budget.reservation_refused',
  'spend.paused',
  'role.frozen',
]);

/**
 * Runs the handoffs owed by tasks that have completed.
 *
 * Driven by state rather than by a live subscription, so a worker that was
 * down while a task completed still performs the handoff when it comes back --
 * the same reason schedules live in the database. What each handoff came to
 * is written to `task_handoffs` (0042), so a completion is decided once and
 * then left alone, rather than re-read with its output on every tick.
 */
export async function processHandoffs(
  companyId: string,
  rules: HandoffRule[],
  options: { reserveTokens?: number; now?: Date } = {},
): Promise<HandoffResult[]> {
  const since = new Date((options.now ?? new Date()).getTime() - HANDOFF_LOOKBACK_MS);
  const results: HandoffResult[] = [];

  for (const rule of rules) {
    const roles = await withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{ slug: string; id: string; division_id: string }>(
        'SELECT slug, id, division_id FROM roles WHERE slug = ANY($1::text[])',
        [[rule.fromRoleSlug, rule.toRoleSlug]],
      );
      return new Map(rows.map((row) => [row.slug, row]));
    });
    const fromRoleId = roles.get(rule.fromRoleSlug)?.id;
    const successor = roles.get(rule.toRoleSlug);
    if (!fromRoleId || !successor) continue;

    const owed = await withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<CompletedTask>(
        `SELECT t.id, t.project_id, t.division_id, t.output,
                h.reason_code AS refused_code, h.reason AS refused_reason
           FROM tasks t
           LEFT JOIN task_handoffs h
             ON h.from_task_id = t.id AND h.to_role_slug = $2
          WHERE t.role_id = $1
            AND t.status = 'completed'
            AND t.finished_at >= $3
            AND (h.from_task_id IS NULL
                 OR (h.outcome = 'refused' AND h.reason_code = ANY($4::text[])))
          ORDER BY t.finished_at
          LIMIT $5`,
        [fromRoleId, rule.toRoleSlug, since, [...MAY_LIFT], HANDOFF_BATCH],
      );
      return rows;
    });

    for (const task of owed) {
      const created = await handOff(companyId, rule, task, successor, options);
      if (created) results.push({ fromTaskId: task.id, toTaskId: created, toRoleSlug: rule.toRoleSlug });
    }
  }

  return results;
}

/** Decides one completion's handoff under one rule, and records what it came to. */
async function handOff(
  companyId: string,
  rule: HandoffRule,
  task: CompletedTask,
  successorRole: { id: string; division_id: string },
  options: { reserveTokens?: number },
): Promise<string | null> {
  const successorRoleId = successorRole.id;
  const input = rule.mapInput(task.output ?? {});
  if (input === null) {
    await record(companyId, task.id, rule.toRoleSlug, { outcome: 'declined' });
    return null;
  }

  // Handed off before the ledger existed. Checked for a task with no row
  // only, which after one pass is none of them, so it costs nothing in the
  // steady state and keeps an upgrade from starting a second successor.
  const earlier = task.refused_code === null
    ? await withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM tasks WHERE parent_task_id = $1 AND role_id = $2 LIMIT 1',
        [task.id, successorRoleId],
      );
      return rows[0]?.id ?? null;
    })
    : null;
  if (earlier) {
    await record(companyId, task.id, rule.toRoleSlug, { outcome: 'created', toTaskId: earlier });
    return null;
  }

  let successor: TaskRow;
  try {
    successor = await createSubTask(task.id, {
      companyId,
      projectId: task.project_id,
      // The successor's own division, whose grants the broker will read. It
      // was the predecessor's, which let a reviewer handed work from content
      // act with content's grants (0058 now refuses the pair).
      divisionId: successorRole.division_id,
      roleId: successorRoleId,
      input,
      createdBy: 'event',
      reserveTokens: options.reserveTokens ?? 1000,
    });
  } catch (error) {
    // Depth, fan-out, cycle and budget refusals are ordinary outcomes here,
    // not crashes: they are the tree being bounded as designed. Said once
    // per reason -- a refusal retried every tick for the same cause is not
    // news the second time.
    const code = error instanceof PalugadaError ? error.code : 'handoff.failed';
    const reason = (error as Error).message;
    await withTenant(companyId, async (tx) => {
      await upsert(tx, companyId, task.id, rule.toRoleSlug, {
        outcome: 'refused', reasonCode: code, reason,
      });
      if (task.refused_code !== code) {
        await appendEvent(tx, {
          companyId,
          projectId: task.project_id,
          taskId: task.id,
          type: 'handoff.refused',
          actor: 'system',
          payload: { toRole: rule.toRoleSlug, code, reason, final: !MAY_LIFT.has(code) },
        });
      }
    });
    return null;
  }

  await withTenant(companyId, async (tx) => {
    await upsert(tx, companyId, task.id, rule.toRoleSlug, { outcome: 'created', toTaskId: successor.id });
    await appendEvent(tx, {
      companyId,
      projectId: task.project_id,
      taskId: task.id,
      type: 'handoff.created',
      actor: 'system',
      payload: { toRole: rule.toRoleSlug, toTaskId: successor.id },
    });
  });
  return successor.id;
}

interface Decision {
  outcome: 'created' | 'declined' | 'refused';
  toTaskId?: string;
  reasonCode?: string;
  reason?: string;
}

async function record(
  companyId: string,
  fromTaskId: string,
  toRoleSlug: string,
  decision: Decision,
): Promise<void> {
  await withTenant(companyId, (tx) => upsert(tx, companyId, fromTaskId, toRoleSlug, decision));
}

async function upsert(
  tx: TenantClient,
  companyId: string,
  fromTaskId: string,
  toRoleSlug: string,
  decision: Decision,
): Promise<void> {
  await tx.query(
    `INSERT INTO task_handoffs
       (company_id, from_task_id, to_role_slug, outcome, to_task_id, reason_code, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (from_task_id, to_role_slug) DO UPDATE
       SET outcome = EXCLUDED.outcome, to_task_id = EXCLUDED.to_task_id,
           reason_code = EXCLUDED.reason_code, reason = EXCLUDED.reason,
           decided_at = now()`,
    [
      companyId, fromTaskId, toRoleSlug, decision.outcome,
      decision.toTaskId ?? null, decision.reasonCode ?? null, decision.reason ?? null,
    ],
  );
}
