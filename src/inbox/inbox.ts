/**
 * Owner inbox (PRD F10).
 *
 * This is the only human interface in the system, so the scarce resource it
 * manages is the owner's attention, not screen space (principle 1: silent by
 * default). Two properties follow from that and are enforced here rather than
 * left to the UI:
 *
 *   - An item carries everything needed to decide (F10.2), so answering never
 *     requires opening a log.
 *   - Silence is safe. An unanswered approval expires into a cancellation,
 *     never into an execution (F10.4).
 */
import { withTenant, withControlPlane } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { transition } from '../engine/tasks.ts';
import { notifyAfterFor } from '../scheduler/windows.ts';
import type { Tier } from '../domain/tier.ts';

/** F10.4. The owner is one person and may be asleep, travelling or ill. */
export const DEFAULT_APPROVAL_TTL_HOURS = 72;

export type InboxKind = 'approval' | 'escalation' | 'incident' | 'sop_candidate' | 'budget_alert';
export type Decision = 'approve' | 'deny' | 'ask';

export interface ApprovalInput {
  companyId: string;
  taskId: string;
  capabilityName: string;
  tier: Tier;
  actionSummary: string;
  rationale: string;
  consequenceIfDenied: string;
  estimatedCostCents?: number;
  payload?: Record<string, unknown>;
  ttlHours?: number;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  status: 'open' | 'decided' | 'expired';
  title: string;
  actionSummary: string;
  rationale: string;
  tier: number | null;
  estimatedCostCents: number;
  consequenceIfDenied: string;
  taskId: string | null;
  expiresAt: Date | null;
}

export async function requestApproval(input: ApprovalInput): Promise<string> {
  const ttl = input.ttlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
  // F9.3: a tier 3 approval may wake the owner; anything gentler waits for
  // their window. The item is created either way -- only the moment they are
  // told about it moves.
  const notifyAfter = await notifyAfterFor('approval', { tier: input.tier });

  const itemId = await withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items (
         company_id, task_id, kind, title, action_summary, rationale, tier,
         estimated_cost_cents, consequence_if_denied, capability_name, payload,
         expires_at, notify_after)
       VALUES ($1,$2,'approval',$3,$4,$5,$6,$7,$8,$9,$10,
               now() + make_interval(hours => $11), $12)
       RETURNING id`,
      [
        input.companyId, input.taskId, input.actionSummary, input.actionSummary,
        input.rationale, input.tier, input.estimatedCostCents ?? 0,
        input.consequenceIfDenied, input.capabilityName,
        JSON.stringify(input.payload ?? {}), ttl, notifyAfter,
      ],
    );
    const id = rows[0]!.id;
    await appendEvent(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      type: 'approval.requested',
      actor: 'broker',
      payload: { inboxItemId: id, capability: input.capabilityName, tier: input.tier },
    });
    return id;
  });

  await transition(input.companyId, input.taskId, 'waiting_approval');
  return itemId;
}

export async function raiseIncident(input: {
  companyId: string;
  taskId?: string | undefined;
  title: string;
  detail: string;
}): Promise<string> {
  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, task_id, kind, title, action_summary, rationale,
          consequence_if_denied, notify_after)
       VALUES ($1,$2,'incident',$3,$3,$4,'', now())
       RETURNING id`,
      [input.companyId, input.taskId ?? null, input.title, input.detail],
    );
    const id = rows[0]!.id;
    await appendEvent(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      type: 'incident.raised',
      actor: 'system',
      payload: { inboxItemId: id, title: input.title },
    });
    return id;
  });
}

/**
 * Raises an escalation: something the owner must decide that is not an
 * approval for a specific action.
 *
 * Unlike an incident this waits for the owner's window (F9.3). Nothing is
 * currently on fire -- work is blocked pending a judgement -- and waking
 * someone at 03:00 for a decision that keeps until morning is exactly the
 * noise principle 1 exists to prevent.
 */
export async function raiseEscalation(input: {
  companyId: string;
  taskId?: string | undefined;
  title: string;
  detail: string;
  tier?: Tier | undefined;
}): Promise<string> {
  const notifyAfter = await notifyAfterFor('escalation', { tier: input.tier ?? null });

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, task_id, kind, title, action_summary, rationale,
          consequence_if_denied, tier, notify_after)
       VALUES ($1,$2,'escalation',$3,$3,$4,'The task stays blocked until you decide.',$5,$6)
       RETURNING id`,
      [input.companyId, input.taskId ?? null, input.title, input.detail,
       input.tier ?? null, notifyAfter],
    );
    const id = rows[0]!.id;
    await appendEvent(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      type: 'escalation.raised',
      actor: 'system',
      payload: { inboxItemId: id, title: input.title },
    });
    return id;
  });
}

export async function listOpen(companyId: string): Promise<InboxItem[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; kind: InboxKind; status: 'open' | 'decided' | 'expired';
      title: string; action_summary: string; rationale: string; tier: number | null;
      estimated_cost_cents: number; consequence_if_denied: string;
      task_id: string | null; expires_at: Date | null;
    }>(
      `SELECT id, kind, status, title, action_summary, rationale, tier,
              estimated_cost_cents, consequence_if_denied, task_id, expires_at
         FROM inbox_items WHERE status = 'open' ORDER BY created_at`,
    );
    return rows.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, title: r.title,
      actionSummary: r.action_summary, rationale: r.rationale, tier: r.tier,
      estimatedCostCents: r.estimated_cost_cents,
      consequenceIfDenied: r.consequence_if_denied,
      taskId: r.task_id, expiresAt: r.expires_at,
    }));
  });
}

/**
 * Records the owner's decision (F10.8) and moves the waiting task.
 *
 * An approval returns the task to `running`; a denial cancels it. `ask` leaves
 * the item open, because F10.3 lets the owner request clarification without
 * spawning a second task.
 */
export async function decide(
  companyId: string,
  itemId: string,
  decision: Decision,
  note = '',
): Promise<void> {
  const taskId = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ task_id: string | null }>(
      `UPDATE inbox_items
          SET decision = $2,
              decided_at = now(),
              owner_note = $3,
              status = CASE WHEN $2 = 'ask' THEN 'open' ELSE 'decided' END
        WHERE id = $1 AND status = 'open'
        RETURNING task_id`,
      [itemId, decision, note],
    );
    const row = rows[0];
    if (!row) throw new Error(`inbox item ${itemId} is not open`);

    await appendEvent(tx, {
      companyId,
      taskId: row.task_id ?? undefined,
      type: 'owner.decided',
      actor: 'owner',
      payload: { inboxItemId: itemId, decision, note },
    });
    return row.task_id;
  });

  if (!taskId || decision === 'ask') return;
  await transition(companyId, taskId, decision === 'approve' ? 'running' : 'cancelled');
}

/**
 * F10.4: expires overdue approvals.
 *
 * The task is cancelled rather than executed. An owner who never looked at the
 * item has not consented to it, and treating silence as consent would make the
 * inbox a liability instead of a control.
 */
export async function expireOverdue(companyId: string): Promise<number> {
  const expired = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; task_id: string | null }>(
      `UPDATE inbox_items
          SET status = 'expired'
        WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id, task_id`,
    );
    for (const row of rows) {
      await appendEvent(tx, {
        companyId,
        taskId: row.task_id ?? undefined,
        type: 'approval.expired',
        actor: 'system',
        payload: { inboxItemId: row.id },
      });
    }
    return rows;
  });

  for (const row of expired) {
    if (row.task_id) {
      await transition(companyId, row.task_id, 'cancelled', { haltReason: 'approval_expired' });
    }
  }
  return expired.length;
}

/** F10.7: cancels every task on the platform. */
export async function stopEverything(): Promise<number> {
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE platform_control SET stop_all_requested_at = now(), updated_at = now()');
  });

  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string; company_id: string; project_id: string }>(
      `UPDATE tasks SET status = 'cancelled', halt_reason = 'owner_stop', finished_at = now()
        WHERE status IN ('pending', 'running', 'waiting_approval', 'waiting_review')
        RETURNING id, company_id, project_id`,
    );
    for (const row of rows) {
      await tx.query(
        `INSERT INTO events (company_id, project_id, task_id, type, actor, payload)
         VALUES ($1, $2, $3, 'task.cancelled', 'owner', '{"haltReason":"owner_stop"}'::jsonb)`,
        [row.company_id, row.project_id, row.id],
      );
    }
    return rows.length;
  });
}
