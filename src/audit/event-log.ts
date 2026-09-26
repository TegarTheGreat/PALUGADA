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
): Promise<Array<{ type: string; actor: string; payload: Record<string, unknown>; occurredAt: Date }>> {
  const { rows } = await tx.query<{
    type: string; actor: string; payload: Record<string, unknown>; occurred_at: Date;
  }>(
    `SELECT type, actor, payload, occurred_at FROM events
      WHERE task_id = $1 ORDER BY occurred_at, id`,
    [taskId],
  );
  // When, because the console draws these as a timeline and a timeline
  // without times is a list.
  return rows.map((row) => ({
    type: row.type, actor: row.actor, payload: row.payload, occurredAt: row.occurred_at,
  }));
}
