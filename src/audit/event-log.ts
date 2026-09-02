/**
 * Append-only event log (PRD section 7.4).
 *
 * Events are the system's memory of what happened; corrections are new events,
 * never edits. The database enforces that with a trigger, so this module has
 * no update or delete function by design.
 */
import type { TenantClient } from '../db/tenant.ts';

export interface EventInput {
  companyId: string;
  projectId?: string | undefined;
  taskId?: string | undefined;
  type: string;
  actor: string;
  payload?: Record<string, unknown>;
  traceId?: string | undefined;
}

export async function appendEvent(tx: TenantClient, event: EventInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO events (company_id, project_id, task_id, type, actor, payload, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      event.companyId,
      event.projectId ?? null,
      event.taskId ?? null,
      event.type,
      event.actor,
      JSON.stringify(event.payload ?? {}),
      event.traceId ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function readTaskEvents(
  tx: TenantClient,
  taskId: string,
): Promise<Array<{ type: string; actor: string; payload: Record<string, unknown> }>> {
  const { rows } = await tx.query<{ type: string; actor: string; payload: Record<string, unknown> }>(
    `SELECT type, actor, payload FROM events
      WHERE task_id = $1 ORDER BY occurred_at, id`,
    [taskId],
  );
  return rows;
}
