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
import { withTenant, withControlPlane, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { getTask, transition } from '../engine/tasks.ts';
import { notifyAfterFor } from '../scheduler/windows.ts';
import { escalationPolicyFor } from '../governance/structure.ts';
import { approveCandidate, rejectCandidate } from '../memory/store.ts';
import type { Tier } from '../domain/tier.ts';

/** F10.4. The owner is one person and may be asleep, travelling or ill. */
export const DEFAULT_APPROVAL_TTL_HOURS = 72;

export type InboxKind = 'approval' | 'escalation' | 'incident' | 'sop_candidate' | 'budget_alert';
export type Decision = 'approve' | 'deny' | 'ask';

export interface ApprovalInput {
  companyId: string;
  /**
   * The task waiting on this decision, when there is one.
   *
   * Absent for an approval that is not about work in flight -- a structural
   * change under F2.9, a role change under F17.3. Those have nothing to park:
   * if the owner never answers, nothing happens, which is the safe outcome
   * F10.4 asks for and is reached here by there being no task to cancel.
   */
  taskId?: string | undefined;
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
  // An approval already open for this task and capability is *this* approval.
  // The broker re-reaches this point every time the task runs again -- after an
  // owner question under F10.3, after a restart -- and a second item would ask
  // the owner the same thing twice and let them answer it differently.
  if (input.taskId) {
    const existing = await withTenant(input.companyId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM inbox_items
          WHERE task_id = $1 AND kind = 'approval' AND status = 'open'
            AND capability_name IS NOT DISTINCT FROM $2
          ORDER BY created_at LIMIT 1`,
        [input.taskId, input.capabilityName],
      );
      return rows[0]?.id ?? null;
    });
    if (existing) {
      // Only if the task is actually somewhere it can wait from. A task already
      // parked on this item needs no second transition, and one that has since
      // been cancelled must not be dragged back.
      const current = await withTenant(input.companyId, (tx) => getTask(tx, input.taskId!));
      if (current?.status === 'running') {
        await transition(input.companyId, input.taskId, 'waiting_approval');
      }
      return existing;
    }
  }

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
        input.companyId, input.taskId ?? null, input.actionSummary, input.actionSummary,
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

  if (input.taskId) await transition(input.companyId, input.taskId, 'waiting_approval');
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
  /**
   * F2.1: whose problem it is first.
   *
   * With a division, the division's own escalation policy decides who hears
   * about it and how long they have. Without one the item goes straight to the
   * owner, which is the right default: an escalation with no home is not a
   * reason to delay telling somebody.
   */
  divisionId?: string | undefined;
}): Promise<string> {
  const windowOpens = await notifyAfterFor('escalation', { tier: input.tier ?? null });

  // F2.1. Read before the insert so the policy shapes the item rather than
  // being noticed afterwards.
  const policy = input.divisionId
    ? await withTenant(input.companyId, (tx) => escalationPolicyFor(tx, input.divisionId!))
    : null;

  // The later of the two: the owner's window and the division's own grace
  // period. A division that is allowed four hours to handle something should
  // not have the owner told in one, and an owner asleep should not be told at
  // three because a division's clock ran out.
  const divisionHasUntil = policy
    ? new Date(Date.now() + policy.afterMinutes * 60_000)
    : windowOpens;
  const notifyAfter = divisionHasUntil > windowOpens ? divisionHasUntil : windowOpens;

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, task_id, kind, title, action_summary, rationale,
          consequence_if_denied, tier, notify_after, payload)
       VALUES ($1,$2,'escalation',$3,$3,$4,'The task stays blocked until you decide.',$5,$6,$7)
       RETURNING id`,
      [
        input.companyId, input.taskId ?? null, input.title,
        // The owner is told who was supposed to handle it. An escalation that
        // reaches them without saying whose it was is one they have to trace.
        policy?.roleSlug
          ? `${input.detail}\n\n${policy.roleSlug} was asked first and has had ` +
            `${policy.afterMinutes} minutes.`
          : input.detail,
        input.tier ?? null, notifyAfter,
        JSON.stringify(
          policy
            ? {
                divisionId: input.divisionId,
                escalationRole: policy.roleSlug,
                afterMinutes: policy.afterMinutes,
              }
            : {},
        ),
      ],
    );
    const id = rows[0]!.id;
    await appendEvent(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      type: 'escalation.raised',
      actor: 'system',
      payload: {
        inboxItemId: id,
        title: input.title,
        ...(policy ? { escalationRole: policy.roleSlug, afterMinutes: policy.afterMinutes } : {}),
      },
    });
    return id;
  });
}

/**
 * Puts a distilled SOP in front of the owner (F4.5).
 *
 * Waits for the owner's window like any other non-urgent item: a proposed
 * procedure is never the reason to wake someone. The occurrence count travels
 * with it so the decision rests on evidence rather than on how plausible the
 * text reads.
 */
export async function proposeSop(input: {
  companyId: string;
  memoryId: string;
  title: string;
  body: string;
  occurrences: number;
}): Promise<string> {
  const notifyAfter = await notifyAfterFor('sop_candidate', {});

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, kind, title, action_summary, rationale, consequence_if_denied,
          payload, notify_after)
       VALUES ($1,'sop_candidate',$2,$2,$3,
               'Nothing changes; the pattern stays undocumented and agents keep improvising.',
               $4,$5)
       RETURNING id`,
      [
        input.companyId,
        input.title,
        `Observed in ${input.occurrences} completed tasks.\n\n${input.body}`,
        JSON.stringify({ memoryId: input.memoryId, occurrences: input.occurrences }),
        notifyAfter,
      ],
    );
    return rows[0]!.id;
  });
}

/**
 * Proposes a skill version for the owner's decision (F10.1, F15.3).
 *
 * Beside `proposeSop` rather than replacing it: an SOP candidate is a
 * paragraph a distiller noticed, a skill candidate is a versioned document
 * with an author, a changelog and a review behind it. Collapsing the two would
 * mean the owner cannot tell, from the queue, which of the two they are being
 * asked about.
 *
 * Waits for the owner's window. A proposed skill is not urgent -- nothing
 * changes until it is approved, which is the property that makes it safe to
 * let it wait.
 */
export async function proposeSkill(input: {
  companyId: string;
  skillVersionId: string;
  slug: string;
  version: number;
  author: string;
  changelog: string;
  summary: string;
}): Promise<string> {
  const notifyAfter = await notifyAfterFor('skill_candidate', {});

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, kind, title, action_summary, rationale, consequence_if_denied,
          payload, notify_after)
       VALUES ($1,'skill_candidate',$2,$3,$4,
               'Nothing changes; the current version of the skill stays in force.',
               $5,$6)
       RETURNING id`,
      [
        input.companyId,
        `Skill ${input.slug} v${input.version}`,
        input.summary,
        `Proposed by ${input.author}.\n\n${input.changelog}`,
        JSON.stringify({
          skillVersionId: input.skillVersionId,
          slug: input.slug,
          version: input.version,
          author: input.author,
        }),
        notifyAfter,
      ],
    );
    return rows[0]!.id;
  });
}

/**
 * Raises a budget or calibration alert (F11.4).
 *
 * Waits for the owner's window. Money already spent is not an emergency: it is
 * a number that will be just as true at breakfast, and treating it as urgent
 * is how the inbox stops meaning anything.
 */
export async function raiseBudgetAlert(input: {
  companyId: string;
  title: string;
  detail: string;
}): Promise<string> {
  const notifyAfter = await notifyAfterFor('budget_alert', {});

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, kind, title, action_summary, rationale, consequence_if_denied,
          notify_after)
       VALUES ($1,'budget_alert',$2,$2,$3,'',$4)
       RETURNING id`,
      [input.companyId, input.title, input.detail, notifyAfter],
    );
    return rows[0]!.id;
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
/**
 * Where a decision arrived from (F10.10).
 *
 * `app` is the owner's authenticated application. `chat` is a message channel
 * — Telegram, WhatsApp, Signal — which F10.9 makes a notification surface and
 * F10.10 explicitly bars from tier 3. `api` is the owner's own tooling against
 * this process.
 */
export type DecisionChannel = 'app' | 'chat' | 'api';

/**
 * The channels that may approve a tier 3 action.
 *
 * `chat` is absent and that is the requirement, not a default: a message
 * channel is a surface where a forwarded message and a real one look alike,
 * and tier 3 is the tier that cannot be undone. F10.10 says the channel shows
 * a link and the approval happens in the app.
 *
 * The rule is enforced here even though no chat channel exists yet. A rule
 * added at the same time as the surface it constrains is a rule somebody has
 * to remember; this one is already true, so the integration that arrives later
 * cannot be the thing that forgets it.
 */
const TIER_3_CHANNELS = new Set<DecisionChannel>(['app', 'api']);

/**
 * How the owner proved who they were (F10.10, F12.5).
 *
 * F10.10 reads "approval tier 3 only through the app **with MFA**", and only
 * the second half of that sentence was enforced for a while: `channel: 'app'`
 * was enough, so an integration that named the wrong channel got a tier 3
 * approval with no second factor. The channel says which pipe the request came
 * down; this says how the person at the other end was authenticated, which is
 * what the requirement is actually about.
 *
 * It is asserted by the caller and this codebase cannot check it -- exactly
 * like `channel`, and worth saying plainly rather than dressing up. PALUGADA
 * performs no authentication: F12.5 wants MFA and mobile biometrics, and both
 * live in an application that does not exist here. What this buys is that a
 * tier 3 approval given without a second factor requires the caller to state
 * something false, and the statement is on the decision event where an auditor
 * can find it. That is the same trade as F12.6's scopes: an accident becomes a
 * lie, and the lie is recorded.
 */
export type OwnerAssurance = 'mfa' | 'session' | 'none';

/**
 * What a message channel may do with an item (F10.9, F10.10, F10.5).
 *
 * F10.9 makes Telegram, WhatsApp or Signal a notification *and action* surface
 * for three things by name: an escalation, a skill candidate, and a review at
 * tier 2 or below, answered with inline buttons. F10.10 then carves out the
 * exception: tier 3 shows a link and nothing else.
 *
 * No channel exists here and none can -- F10.9 needs a messaging account. This
 * is the rule that would govern one, written now for the reason F10.10's
 * prohibition was: a rule added alongside the integration it constrains is a
 * rule whoever writes the integration gets to decide. Written first, it is
 * already true when they arrive.
 *
 * `link_only` for an incident is a reading rather than a quotation, and worth
 * flagging as one. F10.5 makes an incident push-worthy and F10.9 does not list
 * it among the three the channel may act on, so it reaches the owner and
 * carries nothing to press. Everything else is `none`: the requirement names
 * what the surface is for, and a default of "not this one" is the direction to
 * be wrong in.
 */
export type ChannelDelivery = 'actionable' | 'link_only' | 'none';

export function channelDelivery(item: { kind: string; tier: number | null }): ChannelDelivery {
  // F10.10 first, so no later rule can hand tier 3 a button.
  if ((item.tier ?? 0) >= 3) return 'link_only';

  switch (item.kind) {
    case 'escalation':
    case 'skill_candidate':
      return 'actionable';
    case 'approval':
      // "review Tier <= 2" in F10.9's words. The tier 3 case left above.
      return 'actionable';
    case 'incident':
      return 'link_only';
    default:
      return 'none';
  }
}

export async function decide(
  companyId: string,
  itemId: string,
  decision: Decision,
  note = '',
  options: { channel?: DecisionChannel; assurance?: OwnerAssurance } = {},
): Promise<void> {
  const channel = options.channel ?? 'api';
  // Defaulted to the weakest, so a caller that says nothing cannot approve a
  // tier 3 action. The safe default is the one that refuses.
  const assurance = options.assurance ?? 'none';
  // F10.10: read the tier before the update, so a refusal changes nothing.
  const tier = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ tier: number | null }>(
      "SELECT tier FROM inbox_items WHERE id = $1 AND status = 'open'",
      [itemId],
    );
    return rows[0]?.tier ?? null;
  });

  if (
    decision === 'approve'
    && (tier ?? 0) >= 3
    && (!TIER_3_CHANNELS.has(channel) || assurance !== 'mfa')
  ) {
    await withTenant(companyId, async (tx) => {
      await appendEvent(tx, {
        companyId,
        type: 'security.tier3_channel_refused',
        actor: 'system',
        payload: { inboxItemId: itemId, channel, assurance },
      });
    });
    throw new PalugadaError(
      'approval.channel_forbidden',
      assurance === 'mfa'
        ? `a tier 3 approval cannot be given over ${channel}; it happens in the app (F10.10)`
        : 'a tier 3 approval needs a second factor; the caller asserted ' +
          `assurance "${assurance}" (PRD F10.10, F12.5)`,
      { inboxItemId: itemId, channel, assurance },
    );
  }

  const item = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      task_id: string | null;
      kind: InboxKind;
      payload: Record<string, unknown>;
    }>(
      `UPDATE inbox_items
          SET decision = $2,
              decided_at = now(),
              owner_note = $3,
              status = CASE WHEN $2 = 'ask' THEN 'open' ELSE 'decided' END
        WHERE id = $1 AND status = 'open'
        RETURNING task_id, kind, payload`,
      [itemId, decision, note],
    );
    const row = rows[0];
    if (!row) throw new Error(`inbox item ${itemId} is not open`);

    await appendEvent(tx, {
      companyId,
      taskId: row.task_id ?? undefined,
      type: 'owner.decided',
      actor: 'owner',
      payload: { inboxItemId: itemId, kind: row.kind, decision, note },
    });

    // F4.5: approving a candidate is what makes it usable. Until this moment
    // the SOP exists but reaches no agent's context.
    if (row.kind === 'sop_candidate' && decision !== 'ask') {
      const memoryId = String(row.payload.memoryId ?? '');
      if (memoryId) {
        const activated =
          decision === 'approve'
            ? await approveCandidate(tx, memoryId)
            : await rejectCandidate(tx, memoryId);
        await appendEvent(tx, {
          companyId,
          type: decision === 'approve' ? 'sop.approved' : 'sop.rejected',
          actor: 'owner',
          payload: { memoryId, applied: activated },
        });
      }
    }

    return row;
  });

  if (!item.task_id) return;

  if (decision === 'ask') {
    // F10.3: the clarification happens inside this task rather than becoming a
    // second one. The question goes onto the task's record, the task goes back
    // on the queue, and the run that picks it up reads the question in its
    // context. The approval item stays open: asking is not deciding, and the
    // owner still has to say yes.
    await withTenant(companyId, async (tx) => {
      await appendEvent(tx, {
        companyId,
        taskId: item.task_id!,
        type: 'owner.asked',
        actor: 'owner',
        payload: { inboxItemId: itemId, question: note },
      });
    });
    // Through `running`, because that is the only edge out of waiting_approval
    // and the task genuinely is running again -- with a question to answer
    // before it re-proposes whatever it was proposing.
    await transition(companyId, item.task_id, 'running');
    return;
  }

  await transition(companyId, item.task_id, decision === 'approve' ? 'running' : 'cancelled');
}

/**
 * The agent's answer to an owner question (F10.3).
 *
 * Recorded against the item the owner is looking at, so the answer appears
 * under the question rather than in an event log they would have to go and
 * find. The item stays open: an answered question is a decision that can now
 * be made, not one that has been.
 */
export async function answerOwnerQuestion(
  companyId: string,
  itemId: string,
  answer: string,
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ task_id: string | null }>(
      `UPDATE inbox_items
          SET payload = payload || jsonb_build_object(
                'answers', coalesce(payload->'answers', '[]'::jsonb) ||
                           jsonb_build_array(jsonb_build_object(
                             'question', coalesce(owner_note, ''),
                             'answer', $2::text,
                             'at', now()))),
              -- The question has been answered, so the item is undecided again
              -- and shows as waiting on the owner rather than on the agent.
              decision = NULL,
              decided_at = NULL
        WHERE id = $1 AND status = 'open'
        RETURNING task_id`,
      [itemId, answer],
    );
    const row = rows[0];
    if (!row) throw new Error(`inbox item ${itemId} is not open`);

    await appendEvent(tx, {
      companyId,
      taskId: row.task_id ?? undefined,
      type: 'owner.answered',
      actor: 'agent_run',
      payload: { inboxItemId: itemId, answer },
    });
  });
}

/** The owner's open questions on a task, for the run that has to answer them. */
export async function openQuestionsFor(
  tx: TenantClient,
  taskId: string,
): Promise<Array<{ inboxItemId: string; question: string }>> {
  const { rows } = await tx.query<{ id: string; owner_note: string | null }>(
    `SELECT id, owner_note FROM inbox_items
      WHERE task_id = $1 AND status = 'open' AND decision = 'ask'
      ORDER BY decided_at`,
    [taskId],
  );
  return rows.map((row) => ({ inboxItemId: row.id, question: row.owner_note ?? '' }));
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
