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
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
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
  role_slug: string;
  role_id: string;
  output: Record<string, unknown> | null;
}

/**
 * Runs the handoffs owed by tasks that have completed.
 *
 * Driven by state rather than by a live subscription, so a worker that was
 * down while a task completed still performs the handoff when it comes back --
 * the same reason schedules live in the database.
 */
export async function processHandoffs(
  companyId: string,
  rules: HandoffRule[],
  options: { reserveTokens?: number } = {},
): Promise<HandoffResult[]> {
  if (rules.length === 0) return [];

  const byFromRole = new Map<string, HandoffRule[]>();
  for (const rule of rules) {
    const existing = byFromRole.get(rule.fromRoleSlug) ?? [];
    existing.push(rule);
    byFromRole.set(rule.fromRoleSlug, existing);
  }

  const completed = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<CompletedTask>(
      `SELECT t.id, t.project_id, t.division_id, r.slug AS role_slug, r.id AS role_id, t.output
         FROM tasks t
         JOIN roles r ON r.id = t.role_id
        WHERE t.status = 'completed'
          AND r.slug = ANY($1::text[])
        ORDER BY t.finished_at`,
      [[...byFromRole.keys()]],
    );
    return rows;
  });

  const results: HandoffResult[] = [];

  for (const task of completed) {
    for (const rule of byFromRole.get(task.role_slug) ?? []) {
      const input = rule.mapInput(task.output ?? {});
      if (input === null) continue;

      const successorRoleId = await withTenant(companyId, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM roles WHERE slug = $1',
          [rule.toRoleSlug],
        );
        return rows[0]?.id ?? null;
      });
      if (!successorRoleId) continue;

      // Already handed off. Checked rather than assumed, because this function
      // is expected to run repeatedly over the same completed tasks and a
      // second successor per completion would be a silent fan-out.
      const alreadyDone = await withTenant(companyId, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM tasks WHERE parent_task_id = $1 AND role_id = $2 LIMIT 1',
          [task.id, successorRoleId],
        );
        return rows.length > 0;
      });
      if (alreadyDone) continue;

      let successor: TaskRow;
      try {
        successor = await createSubTask(task.id, {
          companyId,
          projectId: task.project_id,
          divisionId: task.division_id,
          roleId: successorRoleId,
          input,
          createdBy: 'event',
          reserveTokens: options.reserveTokens ?? 1000,
        });
      } catch (error) {
        // Depth, fan-out, cycle and budget refusals are ordinary outcomes
        // here, not crashes: they are the tree being bounded as designed.
        await withTenant(companyId, async (tx) => {
          await appendEvent(tx, {
            companyId,
            projectId: task.project_id,
            taskId: task.id,
            type: 'handoff.refused',
            actor: 'system',
            payload: { toRole: rule.toRoleSlug, reason: (error as Error).message },
          });
        });
        continue;
      }

      await withTenant(companyId, async (tx) => {
        await appendEvent(tx, {
          companyId,
          projectId: task.project_id,
          taskId: task.id,
          type: 'handoff.created',
          actor: 'system',
          payload: { toRole: rule.toRoleSlug, toTaskId: successor.id },
        });
      });

      results.push({ fromTaskId: task.id, toTaskId: successor.id, toRoleSlug: rule.toRoleSlug });
    }
  }

  return results;
}
