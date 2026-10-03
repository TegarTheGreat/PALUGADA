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
import { randomUUID } from 'node:crypto';
import { withTenant, withControlPlane, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { createRootTask, getTask, transitionWithin } from '../engine/tasks.ts';
import { reopenForQuestionWithin } from '../engine/journal.ts';
import { releaseReservations } from '../engine/owner-control.ts';
import { TERMINAL_STATUSES, isTerminal } from '../domain/task.ts';
import { notifyAfterFor } from '../scheduler/windows.ts';
import { enqueueWake } from '../scheduler/wake.ts';
import { escalationPolicyFor } from '../governance/structure.ts';
import { ancestryForTask, applyGoalChangeWithin, type GoalChange } from '../domain/goals.ts';
import { approveCandidate, rejectCandidate } from '../memory/store.ts';
import { setStageWithin, stageOf, type Stage } from '../domain/stage.ts';
import { deploymentLanguages, noteTalkDrift } from '../domain/language.ts';
import { budgetHaltWords } from '../owner/budget-halt.ts';
import { ACCOUNT_NAME } from '../engine/budget.ts';

/** What a stage proposal's item carries (`stage.propose`). */
interface StageChange {
  from: Stage | null;
  to: Stage;
}
import type { Tier } from '../domain/tier.ts';
import type { OwnerMfa, VerifiedFactor, WebAuthnAssertion } from '../owner/mfa.ts';

/** F10.4. The owner is one person and may be asleep, travelling or ill. */
export const DEFAULT_APPROVAL_TTL_HOURS = 72;

/** Every kind `inbox_kind_known` admits (0021), so a row read back is one of these. */
export type InboxKind =
  | 'approval' | 'escalation' | 'incident' | 'sop_candidate' | 'budget_alert'
  | 'skill_candidate' | 'fact_candidate';
export type Decision = 'approve' | 'deny' | 'ask';
/**
 * `withdrawn` is an approval whose task ended some other way (migration 0036):
 * there is nothing left to consent to, so it stops asking.
 */
export type InboxStatus = 'open' | 'decided' | 'expired' | 'withdrawn';

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
  /** The card's heading; the summary's first words when absent. */
  title?: string;
  actionSummary: string;
  rationale: string;
  consequenceIfDenied: string;
  estimatedCostCents?: number;
  payload?: Record<string, unknown>;
  ttlHours?: number;
  /**
   * Which action this approval is for: `fingerprintAction(capability, input)`.
   *
   * What makes an answer usable. The broker proceeds only on an approval for
   * this task *and this exact action*, so approving one payment does not
   * approve a different amount proposed after it.
   */
  actionFingerprint?: string;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  status: InboxStatus;
  title: string;
  actionSummary: string;
  rationale: string;
  tier: number | null;
  estimatedCostCents: number;
  consequenceIfDenied: string;
  taskId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  /** The capability an approval is for; null for anything that is not one. */
  capabilityName: string | null;
  /** Who is asking: the role and division of the task behind the item. */
  roleSlug: string | null;
  /** The name the owner gave that role, which is what the owner calls it (§2.3 item 7). */
  roleName: string | null;
  divisionName: string | null;
  /** A question a run put to the owner with `owner.ask`, which the owner answers rather than approves. */
  question: string | null;
  /** The answers the run offered to choose from, when it offered some. */
  options: string[] | null;
  /**
   * What an approval's action was called with, redacted as the payload keeps
   * it: the card lists it, so the owner approves the arguments and not only
   * the capability's name. Null for anything that is not an action.
   */
  input: unknown;
  /**
   * F2.7, F10.2: why this work exists, mission first. An owner deciding on a
   * phone at seven in the morning reads it on the item rather than following
   * a link to find it.
   */
  goalChain: Array<{ kind: string; statement: string }>;
  /** When an item the owner put off comes back (0060); null when it is not put off. */
  snoozedUntil: Date | null;
  /**
   * Whether the owner may approve this and allow the same for a while
   * (0083): an approval a policy asked for, at tier 2 or below, by a role.
   */
  allowFor: boolean;
  /**
   * What the owner asked on this card and what the run answered, oldest
   * first; a question still waiting for its answer is last, with none (N6).
   */
  asked: Exchange[];
}

/** A question the owner asked on an approval card, and what the run answered; null until it has (N6). */
export interface Exchange {
  question: string;
  answer: string | null;
}

/**
 * What a run said after the owner asked about a card: the lines of its
 * transcript since the question, which is its answer. Null when it said
 * nothing and simply asked for the action again.
 */
async function answerSince(tx: TenantClient, taskId: string, itemId: string): Promise<string | null> {
  const { rows } = await tx.query<{ body: string }>(
    `SELECT n.body FROM run_notes n
      WHERE n.task_id = $1
        AND n.said_at > (SELECT max(e.occurred_at) FROM events e
                          WHERE e.task_id = $1 AND e.type = 'owner.asked' AND e.payload->>'inboxItemId' = $2)
      ORDER BY n.said_at, n.seq`,
    [taskId, itemId],
  );
  const said = rows.map((row) => row.body).join('\n').trim();
  return said ? said.slice(0, 2_000) : null;
}

export async function requestApproval(input: ApprovalInput): Promise<string> {
  const ttl = input.ttlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
  // F9.3: a tier 3 approval may wake the owner; anything gentler waits for
  // their window. The item is created either way -- only the moment they are
  // told about it moves.
  const notifyAfter = await notifyAfterFor('approval', { tier: input.tier });

  // One transaction for the item and the task it parks. As two, a crash
  // between them left an approval open against a task still `running`, and
  // an owner quick enough to answer it moved a task that was not waiting --
  // which the state machine refused, *after* the decision had been recorded.
  return withTenant(input.companyId, async (tx) => {
    // What the owner asked about this action, and what the run answered (N6).
    let asked: Exchange[] = [];
    // The task first, as every writer here takes it: task, then its items.
    if (input.taskId) {
      await tx.query('SELECT 1 FROM tasks WHERE id = $1 FOR NO KEY UPDATE', [input.taskId]);

      // An approval already open for this task and capability is *this*
      // approval. The broker re-reaches this point every time the task runs
      // again -- after an owner question under F10.3, after a restart -- and a
      // second item would ask the owner the same thing twice and let them
      // answer it differently.
      //
      // Unless the action changed. After a question the agent may come back
      // with a different amount or a different recipient, and an item still
      // describing the first proposal would have the owner approve something
      // other than what would run. That item is withdrawn as superseded and
      // the new proposal is asked about in its place.
      const { rows } = await tx.query<{
        id: string; action_fingerprint: string | null; decision: string | null; owner_note: string | null;
        payload: { asked?: Exchange[] };
      }>(
        `SELECT id, action_fingerprint, decision, owner_note, payload FROM inbox_items
          WHERE task_id = $1 AND kind = 'approval' AND status = 'open'
            AND capability_name IS NOT DISTINCT FROM $2
          ORDER BY created_at LIMIT 1`,
        [input.taskId, input.capabilityName],
      );
      const open = rows[0] ?? null;
      // The owner asked about this card, and the run has come back to the
      // action (N6): what it said since the question is its answer, kept on
      // the card with the question, and the card waits for the owner's
      // decision again -- on this card, or on the one that supersedes it.
      asked = [...(open?.payload.asked ?? [])];
      if (open?.decision === 'ask') {
        asked.push({ question: open.owner_note ?? '', answer: await answerSince(tx, input.taskId, open.id) });
        await appendEvent(tx, {
          companyId: input.companyId, taskId: input.taskId, type: 'approval.answered', actor: 'broker',
          payload: { inboxItemId: open.id, answered: asked.at(-1)!.answer !== null },
        });
      }
      const superseded = open !== null && input.actionFingerprint !== undefined
        && open.action_fingerprint !== null && open.action_fingerprint !== input.actionFingerprint;
      if (open && superseded) {
        await tx.query(
          `UPDATE inbox_items SET status = 'withdrawn', closed_reason = 'superseded'
            WHERE id = $1`,
          [open.id],
        );
        await appendEvent(tx, {
          companyId: input.companyId,
          taskId: input.taskId,
          type: 'approval.superseded',
          actor: 'broker',
          payload: { inboxItemId: open.id, capability: input.capabilityName },
        });
      }
      const existing = open && !superseded ? open.id : null;
      if (existing && open?.decision === 'ask') {
        await tx.query(
          `UPDATE inbox_items SET decision = NULL, decided_at = NULL, decided_via = NULL,
                  payload = payload || jsonb_build_object('asked', $2::jsonb)
            WHERE id = $1`,
          [existing, JSON.stringify(asked)],
        );
      }
      if (existing) {
        // Only if the task is actually somewhere it can wait from. A task
        // already parked on this item needs no second transition, and one that
        // has since been cancelled must not be dragged back.
        const current = await getTask(tx, input.taskId);
        if (current?.status === 'running') {
          await transitionWithin(tx, input.companyId, input.taskId, 'waiting_approval');
        }
        return existing;
      }
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items (
         company_id, task_id, kind, title, action_summary, rationale, tier,
         estimated_cost_cents, consequence_if_denied, capability_name, payload,
         expires_at, notify_after, action_fingerprint)
       VALUES ($1,$2,'approval',$3,$4,$5,$6,$7,$8,$9,$10,
               now() + make_interval(hours => $11), $12, $13)
       RETURNING id`,
      [
        input.companyId, input.taskId ?? null, input.title ?? input.actionSummary, input.actionSummary,
        input.rationale, input.tier, input.estimatedCostCents ?? 0,
        input.consequenceIfDenied, input.capabilityName,
        JSON.stringify({ ...(input.payload ?? {}), ...(asked.length > 0 ? { asked } : {}) }), ttl, notifyAfter,
        input.actionFingerprint ?? null,
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
    if (input.taskId) {
      await transitionWithin(tx, input.companyId, input.taskId, 'waiting_approval');
    }
    return id;
  });
}

/**
 * The owner's yes to this exact action on this task, not yet used, if any.
 *
 * What the broker asks before raising an approval. Without it an approved
 * action never ran: the resumed task reached the gate again, found no open
 * item, and asked again (migration 0041).
 */
export async function findGrantedApproval(
  tx: TenantClient,
  taskId: string,
  capabilityName: string,
  actionFingerprint: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM inbox_items
      WHERE task_id = $1 AND capability_name = $2 AND action_fingerprint = $3
        AND kind = 'approval' AND status = 'decided' AND decision = 'approve'
        AND consumed_at IS NULL
      ORDER BY decided_at
      LIMIT 1`,
    [taskId, capabilityName, actionFingerprint],
  );
  return rows[0]?.id ?? null;
}

/**
 * Spends an approval, immediately before the action it approved.
 *
 * Before, not after. It used to be spent once the vendor had answered, and a
 * worker that died between the two left the approval unspent and the step
 * unfinished: the next worker resumed the step, found the yes still there,
 * and did the irreversible thing a second time. Spent first, a death in
 * between leaves the step to be asked about again (`spentBy`), and the owner
 * is told it may already have happened.
 *
 * False when another attempt spent it first, which is the same as there being
 * no approval: one yes carries one attempt.
 */
export async function spendApproval(
  companyId: string,
  itemId: string,
  context: { taskId: string; capability: string; idempotencyKey: string },
): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE inbox_items
          SET consumed_at = now(), payload = payload || jsonb_build_object('spentBy', $2::text)
        WHERE id = $1 AND consumed_at IS NULL`,
      [itemId, context.idempotencyKey],
    );
    if (rowCount !== 1) return false;
    await appendEvent(tx, {
      companyId,
      taskId: context.taskId,
      type: 'approval.used',
      actor: 'broker',
      payload: { inboxItemId: itemId, capability: context.capability },
    });
    return true;
  });
}

/**
 * Gives a spent approval back, when the action it was spent on failed.
 *
 * A vendor that refused before doing anything should not cost the owner a
 * second decision to retry. What a failure cannot say is whether the vendor
 * acted before failing; that is what the step's idempotency key is for, and
 * it travels with the retry.
 */
export async function returnApproval(
  companyId: string,
  itemId: string,
  context: { taskId: string; capability: string; reason: string },
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE inbox_items SET consumed_at = NULL, payload = payload - 'spentBy'
        WHERE id = $1 AND consumed_at IS NOT NULL`,
      [itemId],
    );
    if (rowCount !== 1) return;
    await appendEvent(tx, {
      companyId,
      taskId: context.taskId,
      type: 'approval.returned',
      actor: 'broker',
      payload: { inboxItemId: itemId, capability: context.capability, reason: context.reason.slice(0, 500) },
    });
  });
}

/**
 * Whether this very step already spent an approval for this action and never
 * said how it went: the worker carrying it out stopped in the middle.
 */
export async function spentByInterruptedStep(
  tx: TenantClient,
  taskId: string,
  capabilityName: string,
  actionFingerprint: string,
  idempotencyKey: string,
): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM inbox_items
      WHERE task_id = $1 AND capability_name = $2 AND action_fingerprint = $3
        AND kind = 'approval' AND consumed_at IS NOT NULL AND payload->>'spentBy' = $4
      LIMIT 1`,
    [taskId, capabilityName, actionFingerprint, idempotencyKey],
  );
  return rows.length > 0;
}

export interface IncidentInput {
  companyId: string;
  taskId?: string | undefined;
  title: string;
  detail: string;
}

export async function raiseIncident(input: IncidentInput): Promise<string> {
  return withTenant(input.companyId, (tx) => raiseIncidentWithin(tx, input));
}

/** The same, inside a transaction that also changed what the incident is about. */
export async function raiseIncidentWithin(tx: TenantClient, input: IncidentInput): Promise<string> {
  {
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
  }
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
export interface EscalationInput {
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
  /**
   * A schedule the escalation is about, rather than a task (F9.1). The
   * answer acts on it -- deny turns it off, approve leaves it running --
   * because `decide` reads it from the payload, so the owner's answer is the
   * action rather than a note they then have to go and carry out.
   */
  scheduleId?: string | undefined;
  /** Anything else the item carries for whoever answers it, merged into its payload. */
  payload?: Record<string, unknown> | undefined;
  /** What a no does, when it is not the default of the task staying blocked. */
  consequenceIfDenied?: string | undefined;
}

export async function raiseEscalation(input: EscalationInput): Promise<string> {
  return withTenant(input.companyId, (tx) => raiseEscalationWithin(tx, input));
}

/**
 * The same, inside the caller's transaction.
 *
 * For a caller that records why it is asking -- "this task is stranded",
 * "this schedule repeats itself" -- and uses that record to ask only once.
 * The record and the question were two transactions: a crash, or a refused
 * insert, between them left the record saying the owner had been asked and
 * no item the owner could see, and the next pass read the record and did not
 * ask again. Written together, they exist together or not at all.
 */
export async function raiseEscalationWithin(tx: TenantClient, input: EscalationInput): Promise<string> {
  const windowOpens = await notifyAfterFor('escalation', { tier: input.tier ?? null });

  // F2.1. Read before the insert so the policy shapes the item rather than
  // being noticed afterwards.
  const policy = input.divisionId ? await escalationPolicyFor(tx, input.divisionId) : null;

  // The later of the two: the owner's window and the division's own grace
  // period. A division that is allowed four hours to handle something should
  // not have the owner told in one, and an owner asleep should not be told at
  // three because a division's clock ran out.
  //
  // Only when the division actually names somebody, though. `afterMinutes` has
  // a company-wide default and `roleSlug` does not, so a division that never
  // set a policy still reads back as "four hours" -- and holding the owner's
  // notification for four hours is granting a grace period to nobody. Through
  // that window no role has been asked, no one is working on it, and the item
  // simply waits. Without a named role the escalation has no home, and F2.1's
  // own default for that case is the owner, now.
  const handledBy = policy?.roleSlug ? policy : null;
  const divisionHasUntil = handledBy
    ? new Date(Date.now() + handledBy.afterMinutes * 60_000)
    : windowOpens;
  const notifyAfter = divisionHasUntil > windowOpens ? divisionHasUntil : windowOpens;

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO inbox_items
       (company_id, task_id, kind, title, action_summary, rationale,
        consequence_if_denied, tier, notify_after, payload)
     VALUES ($1,$2,'escalation',$3,$3,$4,$8,$5,$6,$7)
     RETURNING id`,
    [
      input.companyId, input.taskId ?? null, input.title,
      // The owner is told who was supposed to handle it. An escalation that
      // reaches them without saying whose it was is one they have to trace.
      handledBy
        ? `${input.detail}\n\n${handledBy.roleSlug} was asked first and has had ` +
          `${handledBy.afterMinutes} minutes.`
        : input.detail,
      input.tier ?? null, notifyAfter,
      // The recorded grace period is the one that was actually granted, so
      // an item whose division names nobody does not read as though four
      // hours were given to someone.
      JSON.stringify({
        ...(handledBy
          ? {
              divisionId: input.divisionId,
              escalationRole: handledBy.roleSlug,
              afterMinutes: handledBy.afterMinutes,
            }
          : input.divisionId
            ? { divisionId: input.divisionId, escalationRole: null }
            : {}),
        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
        ...(input.payload ?? {}),
      }),
      input.consequenceIfDenied ?? 'The task stays blocked until you decide.',
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
      ...(handledBy
        ? { escalationRole: handledBy.roleSlug, afterMinutes: handledBy.afterMinutes }
        : {}),
    },
  });
  return id;
}

/** How much of the handling role's own account the owner's item carries. */
const HANDLED_NOTE_LIMIT = 1_000;

/**
 * Hands each escalation to the role its division names (F2.1), and adds what
 * that role did to the item the owner reads.
 *
 * The item already said "ops-lead was asked first and has had 45 minutes", and
 * nothing asked ops-lead: the grace period was a delay with nobody in it. Now
 * the named role gets a task carrying the escalation, serving the goal the
 * stuck work served, and when that task ends its summary is written under the
 * escalation. The item stays the owner's. A role can do something about the
 * problem; it cannot decide it for them, and the owner is still told when the
 * grace period ends, with the role's account of what it did.
 *
 * Driven from state and keyed by the item, so a worker that was down hands the
 * escalation when it comes back and one that looks twice hands it once. A named
 * role that is not in the company, or that cannot take work, is no grace
 * period at all: the owner is told now, and told why.
 */
export async function handEscalations(companyId: string): Promise<number> {
  // Two questions, asked apart: which escalations nobody has been given yet,
  // and which handed ones have an answer. Asked as one page, the escalations
  // still being worked on filled it, and fifty of those hid every new one.
  const { rows: waiting } = await withTenant(companyId, (tx) => tx.query<{
    id: string; task_id: string | null; title: string; rationale: string; notify_after: Date;
    payload: { escalationRole: string; afterMinutes?: number };
  }>(
    `SELECT id, task_id, title, rationale, notify_after, payload FROM inbox_items
      WHERE kind = 'escalation' AND status = 'open'
        AND payload ? 'escalationRole' AND payload->>'escalationRole' IS NOT NULL
        AND NOT payload ? 'handedTaskId' AND NOT payload ? 'handoffFailed'
      ORDER BY created_at
      LIMIT 50`,
  ));
  let handed = 0;
  for (const item of waiting) {
    if (await handOver(companyId, item)) handed += 1;
  }

  const { rows: answered } = await withTenant(companyId, (tx) => tx.query<{
    id: string; payload: { escalationRole: string; handedTaskId: string };
  }>(
    `SELECT i.id, i.payload FROM inbox_items i
       JOIN tasks t ON t.id = (i.payload->>'handedTaskId')::uuid
      WHERE i.kind = 'escalation' AND i.status = 'open'
        AND NOT i.payload ? 'handledOutcome'
        AND t.status = ANY($1)
      ORDER BY i.created_at
      LIMIT 50`,
    [TERMINAL_STATUSES],
  ));
  for (const item of answered) await noteHandling(companyId, item);
  return handed;
}

async function handOver(companyId: string, item: {
  id: string; task_id: string | null; title: string; rationale: string; notify_after: Date;
  payload: { escalationRole: string; afterMinutes?: number };
}): Promise<boolean> {
  const role = item.payload.escalationRole;
  const found = await withTenant(companyId, async (tx) => {
    const { rows: roles } = await tx.query<{ id: string; division_id: string }>(
      'SELECT id, division_id FROM roles WHERE slug = $1', [role]);
    // The goal the stuck work served, or the company's own purpose when the
    // escalation is not about a task (F2.7: every task hangs from a goal).
    const { rows: stuck } = await tx.query<{ goal_id: string | null; project_id: string }>(
      'SELECT goal_id, project_id FROM tasks WHERE id = $1', [item.task_id]);
    const { rows: goal } = await tx.query<{ id: string }>(
      `SELECT id FROM goals WHERE status = 'active'
        ORDER BY CASE kind WHEN 'mission' THEN 0 ELSE 1 END, created_at LIMIT 1`);
    const { rows: project } = await tx.query<{ id: string }>('SELECT id FROM projects ORDER BY created_at LIMIT 1');
    return {
      role: roles[0] ?? null,
      goalId: stuck[0]?.goal_id ?? goal[0]?.id ?? null,
      projectId: stuck[0]?.project_id ?? project[0]?.id ?? null,
    };
  });

  const toOwnerNow = async (why: string) => {
    const said = `\n\n${role} was asked first and has had ${item.payload.afterMinutes ?? 0} minutes.`;
    const rationale = `${item.rationale.endsWith(said) ? item.rationale.slice(0, -said.length) : item.rationale}\n\n${why}`;
    await withTenant(companyId, (tx) => tx.query(
      `UPDATE inbox_items SET rationale = $2, notify_after = least(notify_after, now()),
              payload = payload || jsonb_build_object('handoffFailed', $3::text)
        WHERE id = $1`,
      [item.id, rationale, why],
    ));
    return false;
  };

  if (!found.role) return toOwnerNow(`${role} is not a role in this company, so this came to you at once.`);
  if (!found.goalId || !found.projectId) {
    return toOwnerNow(`${role} could not be given this: the company has no active goal or project to hang it from.`);
  }

  const until = item.notify_after.toISOString();
  let taskId: string;
  try {
    const task = await createRootTask({
      companyId, projectId: found.projectId, divisionId: found.role.division_id, roleId: found.role.id,
      goalId: found.goalId, createdBy: 'event', idempotencyKey: `escalation:${item.id}`,
      input: {
        goal: `Escalated to you: ${item.title}`,
        context:
          `${item.rationale}\n\nDo what you can about it before ${until}; the owner is told then, ` +
          'with what you did. You cannot decide it for them: fix the cause, hand it to the role ' +
          'that can, or say plainly why neither is possible.',
      },
    });
    taskId = task.id;
  } catch (error) {
    // A frozen role, a paused company, a role that cannot be given work: each
    // is a reason nobody will handle it, which is a reason to tell the owner.
    return toOwnerNow(`${role} could not be given this (${(error as Error).message}), so this came to you at once.`);
  }

  await withTenant(companyId, (tx) => tx.query(
    `UPDATE inbox_items SET payload = payload || jsonb_build_object('handedTaskId', $2::text) WHERE id = $1`,
    [item.id, taskId],
  ));
  await enqueueWake({ companyId, roleId: found.role.id, reason: 'event', detail: `escalation ${item.id} handed to ${role}` });
  return true;
}

async function noteHandling(companyId: string, item: {
  id: string; payload: { escalationRole: string; handedTaskId?: string };
}): Promise<void> {
  await withTenant(companyId, async (tx) => {
    // Only finished tasks are asked about, and a finished task stays finished.
    const task = await getTask(tx, item.payload.handedTaskId!);
    if (!task) return;
    const said = typeof task.output?.summary === 'string' && task.output.summary.trim()
      ? task.output.summary.trim().slice(0, HANDLED_NOTE_LIMIT)
      : `the task ended ${task.status}${task.haltReason ? ` (${task.haltReason})` : ''} without an account of itself.`;
    // Guarded on the marker, so a second pass -- or a second worker -- adds
    // the note once.
    await tx.query(
      `UPDATE inbox_items
          SET rationale = rationale || $2,
              payload = payload || jsonb_build_object('handledOutcome', $3::text)
        WHERE id = $1 AND NOT payload ? 'handledOutcome'`,
      [item.id, `\n\n${item.payload.escalationRole}: ${said}`, task.status],
    );
  });
}

/** How many questions one task may put to the owner. */
export const QUESTIONS_PER_TASK = 3;

export type AgentQuestion =
  | { state: 'answered'; inboxItemId: string; answer: string }
  | { state: 'waiting'; inboxItemId: string }
  | { state: 'unanswered'; inboxItemId: string };

/**
 * A run asking the owner something only the owner can answer, and parking
 * until they do.
 *
 * Without it a run had two outcomes left when it needed the owner: guess,
 * which spends money on what may be the wrong thing, or fail into an
 * incident. Buzz makes a question mandatory when a person is needed, and
 * Paperclip's agents can put one to the board; this is the same, as an
 * escalation the owner answers from the inbox or a chat. The answer is the
 * note on their approve, and a deny stops the task, as it does for any
 * escalation about work in progress.
 *
 * Asked again -- a runtime resumed after the answer, replaying its own steps
 * -- the same question is answered from the item rather than asked twice.
 * One still open parks the task again. One that closed without an answer
 * says so, and the run decides with what it has. Past `QUESTIONS_PER_TASK`
 * a task is being run by the owner a question at a time, and is refused.
 */
export async function askOwner(input: {
  companyId: string;
  taskId: string;
  question: string;
  why?: string | null;
  /**
   * The answers to choose from, when there are a few: the owner presses one
   * instead of writing it. Two to six, each short and different.
   */
  options?: string[] | null;
}): Promise<AgentQuestion> {
  const question = input.question.trim();
  const options = input.options ? input.options.map((option) => String(option ?? '').trim()) : null;
  if (options && (
    options.length < 2 || options.length > 6
    || options.some((option) => !option || option.length > 80)
    || new Set(options).size !== options.length
  )) {
    throw new PalugadaError(
      'contract.violation',
      'choices are two to six different answers of at most 80 characters each',
      { field: 'options' },
    );
  }
  return withTenant(input.companyId, async (tx) => {
    // The task before the item, the order every other writer takes them in.
    const task = await tx.query<{ status: string; role: string; role_name: string | null }>(
      `SELECT t.status, r.slug AS role, r.display_name AS role_name FROM tasks t JOIN roles r ON r.id = t.role_id
        WHERE t.id = $1 FOR NO KEY UPDATE OF t`, [input.taskId]);
    if (!task.rows[0]) {
      throw new PalugadaError('contract.violation', 'no such task in this company', { taskId: input.taskId });
    }
    const { rows: asked } = await tx.query<{
      id: string; status: string; decision: string | null; owner_note: string | null; question: string;
    }>(
      `SELECT id, status, decision, owner_note, payload->>'question' AS question FROM inbox_items
        WHERE task_id = $1 AND kind = 'escalation' AND payload->>'askedBy' = 'agent'
        ORDER BY created_at`,
      [input.taskId],
    );
    const park = async () => {
      if (task.rows[0]!.status !== 'waiting_approval') {
        await transitionWithin(tx, input.companyId, input.taskId, 'waiting_approval');
      }
    };

    const same = asked.find((row) => row.question === question);
    if (same) {
      if (same.status === 'open') {
        await park();
        return { state: 'waiting', inboxItemId: same.id };
      }
      if (same.status === 'decided' && same.decision === 'approve') {
        return { state: 'answered', inboxItemId: same.id, answer: same.owner_note ?? '' };
      }
      return { state: 'unanswered', inboxItemId: same.id };
    }
    if (asked.length >= QUESTIONS_PER_TASK) {
      throw new PalugadaError(
        'contract.violation',
        `this task has asked the owner ${QUESTIONS_PER_TASK} questions; decide with what you have, ` +
          'say what you assumed, or stop',
        { taskId: input.taskId },
      );
    }

    const id = await raiseEscalationWithin(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      // By the name the owner gave the role, which is what they call it; the
      // short name is the platform's (§2.3 item 7).
      title: `${task.rows[0]!.role_name ?? task.rows[0]!.role} asks: ${question.length > 140 ? `${question.slice(0, 139)}…` : question}`,
      // The question is the title and the item's own field; the detail is
      // only what the run said depends on it, so the card does not say the
      // question twice.
      detail: input.why?.trim() || 'The run did not say more than the question.',
      consequenceIfDenied: 'The task is stopped, and nothing it was going to do happens.',
      payload: { askedBy: 'agent', question, role: task.rows[0]!.role, ...(options ? { options } : {}) },
    });
    // Everything on the card is the run's own words to the owner: the
    // question, what depends on it and the answers it offers. Checked here,
    // where the item is opened, and not when the same question is asked
    // again by the run that resumes.
    await noteTalkDrift(tx, {
      companyId: input.companyId,
      taskId: input.taskId,
      where: 'question',
      text: [question, input.why?.trim() ?? '', ...(options ?? [])].filter(Boolean).join('\n'),
    });
    await park();
    return { state: 'waiting', inboxItemId: id };
  });
}

/**
 * The owner's answers to what this task asked, for the run that asked. Read
 * from the decided items rather than from the journal, so a runtime that
 * cannot replay its own calls is told them anyway.
 */
export async function answersFor(
  tx: TenantClient,
  taskId: string,
): Promise<Array<{ question: string; answer: string }>> {
  const { rows } = await tx.query<{ question: string; answer: string | null }>(
    `SELECT payload->>'question' AS question, owner_note AS answer FROM inbox_items
      WHERE task_id = $1 AND kind = 'escalation' AND payload->>'askedBy' = 'agent'
        AND status = 'decided' AND decision = 'approve'
      ORDER BY created_at`,
    [taskId],
  );
  return rows.map((row) => ({ question: row.question, answer: row.answer ?? '' }));
}

/**
 * Which company an item belongs to, for a caller that has only the item.
 *
 * A chat button carries the item and nothing else. Read on the control plane,
 * because the question is exactly the one tenant isolation cannot answer
 * from inside a tenant.
 */
export async function companyOfItem(itemId: string): Promise<string | null> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ company_id: string }>(
      'SELECT company_id FROM inbox_items WHERE id = $1',
      [itemId],
    );
    return rows[0]?.company_id ?? null;
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
 * Asks the owner about a skill version a reviewer has approved (F10.1,
 * F15.3), inside the transaction that records the review (skills.ts).
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
export async function proposeSkillWithin(tx: TenantClient, input: {
  companyId: string;
  skillVersionId: string;
  slug: string;
  version: number;
  author: string;
  changelog: string;
  summary: string;
  reviewerSaid: string | null;
  notifyAfter: Date;
}): Promise<string> {
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
      `Proposed by ${input.author}.\n\n${input.changelog}` +
        (input.reviewerSaid ? `\n\nThe reviewer approved it: ${input.reviewerSaid}` : '\n\nThe reviewer approved it.'),
      JSON.stringify({
        skillVersionId: input.skillVersionId,
        slug: input.slug,
        version: input.version,
        author: input.author,
      }),
      input.notifyAfter,
    ],
  );
  return rows[0]!.id;
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
  /** What the alert is about, for whatever closes it: `spendPause` for the month's pause (M6). */
  payload?: Record<string, unknown>;
}): Promise<string> {
  const notifyAfter = await notifyAfterFor('budget_alert', {});

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, kind, title, action_summary, rationale, consequence_if_denied,
          notify_after, payload)
       VALUES ($1,'budget_alert',$2,$2,$3,'',$4,$5)
       RETURNING id`,
      [input.companyId, input.title, input.detail, notifyAfter, JSON.stringify(input.payload ?? {})],
    );
    return rows[0]!.id;
  });
}

/**
 * Puts a task its budget stopped in front of the owner (PRD section 6.3:
 * halted, to the inbox, never resumed automatically).
 *
 * Nothing did: on a live run two tasks halted "budget_exhausted" and the
 * owner's only sign was a red bar on the Money page. The item names the work
 * and the account with no room left -- the one in the task's chain closest
 * to its ceiling, which is not always the task's own: a division can stop
 * for its company -- and says how to go on: raise the ceiling, then continue
 * the task (`continueHalted`). In the owner's panel language, because the
 * platform is speaking, not an agent.
 *
 * Once per task: a task halts once, but a second look at the same halt must
 * not stack a second card on the first.
 */
export async function raiseBudgetHalt(companyId: string, taskId: string): Promise<string | null> {
  const notifyAfter = await notifyAfterFor('budget_alert', {});
  const language = (await deploymentLanguages()).console;
  return withTenant(companyId, async (tx) => {
    const raised = await tx.query(
      "SELECT 1 FROM inbox_items WHERE task_id = $1 AND kind = 'budget_alert' AND status = 'open'", [taskId]);
    if (raised.rows.length > 0) return null;
    const task = await getTask(tx, taskId);
    if (!task?.budgetAccountId) return null;
    const { rows: accounts } = await tx.query<{ id: string; name: string | null; tokens_spent: string; tokens_max: string }>(
      `SELECT a.id, ${ACCOUNT_NAME} AS name, a.tokens_spent, a.tokens_max FROM budget_accounts a
        WHERE a.id = ANY(app.budget_chain($1))
        ORDER BY a.tokens_max - a.tokens_spent - a.tokens_reserved, a.id
        LIMIT 1`,
      [task.budgetAccountId],
    );
    const account = accounts[0];
    if (!account) return null;
    const words = budgetHaltWords(language, {
      account: account.name,
      work: workOf(task.input),
      spent: Number(account.tokens_spent),
      max: Number(account.tokens_max),
    });
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items
         (company_id, task_id, kind, title, action_summary, rationale, consequence_if_denied,
          notify_after, payload)
       VALUES ($1, $2, 'budget_alert', $3, $3, $4, '', $5, $6)
       RETURNING id`,
      [companyId, taskId, words.title, words.rationale, notifyAfter,
        JSON.stringify({ budgetHalt: { budgetAccountId: account.id } })],
    );
    const id = rows[0]!.id;
    await appendEvent(tx, {
      companyId, projectId: task.projectId, taskId, type: 'budget.halt_raised', actor: 'system',
      payload: { inboxItemId: id, budgetAccountId: account.id },
    });
    return id;
  });
}

/** What a task is for, as one line: its goal, or the first thing its input says. */
function workOf(input: Record<string, unknown>): string {
  const first = typeof input.goal === 'string' && input.goal.trim()
    ? input.goal
    : Object.values(input).find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? '';
  const line = first.trim().replace(/\s+/g, ' ');
  return line.length <= 140 ? line : `${line.slice(0, 139)}…`;
}

/**
 * The open items: the queue by default, or the ones the owner put off (0060).
 *
 * Put off means out of the queue and its count until then, which is the
 * whole of what snoozing is for; they are listed on their own so the owner
 * can still find and wake one.
 */
/**
 * Whether an approval may be answered for a while (0083), over `inbox_items i`
 * joined to its task `t`. The broker writes why it asked into the payload;
 * a card from before it did says nothing and is not eligible.
 */
const ALLOW_FOR_SQL = `i.kind = 'approval' AND i.tier <= 2 AND i.capability_name IS NOT NULL
  AND i.payload->>'reason' = 'policy' AND t.role_id IS NOT NULL`;

export async function listOpen(companyId: string, options: { snoozed?: boolean } = {}): Promise<InboxItem[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; kind: InboxKind; status: InboxStatus;
      title: string; action_summary: string; rationale: string; tier: number | null;
      estimated_cost_cents: number; consequence_if_denied: string;
      task_id: string | null; expires_at: Date | null; created_at: Date;
      capability_name: string | null; role_slug: string | null; role_name: string | null; division_name: string | null;
      question: string | null; options: string[] | null; snoozed_until: Date | null; input: unknown;
      allow_for: boolean; asked: Exchange[] | null; asking: string | null;
    }>(
      `SELECT i.id, i.kind, i.status, i.title, i.action_summary, i.rationale, i.tier, i.snoozed_until,
              (${ALLOW_FOR_SQL}) AS allow_for,
              i.estimated_cost_cents, i.consequence_if_denied, i.task_id, i.expires_at,
              i.created_at, i.capability_name, r.slug AS role_slug, r.display_name AS role_name, d.name AS division_name,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->>'question' END AS question,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->'options' END AS options,
              CASE WHEN i.kind = 'approval' THEN i.payload->'input' END AS input,
              i.payload->'asked' AS asked,
              CASE WHEN i.decision = 'ask' THEN coalesce(i.owner_note, '') END AS asking
         FROM inbox_items i
         LEFT JOIN tasks t ON t.id = i.task_id
         LEFT JOIN roles r ON r.id = t.role_id
         LEFT JOIN divisions d ON d.id = t.division_id
        WHERE i.status = 'open'
          AND (CASE WHEN $1 THEN i.snoozed_until > now()
                    ELSE i.snoozed_until IS NULL OR i.snoozed_until <= now() END)
        ORDER BY i.created_at`,
      [options.snoozed ?? false],
    );
    const items: InboxItem[] = [];
    for (const r of rows) {
      const chain = r.task_id ? await ancestryForTask(tx, r.task_id) : [];
      items.push({
        id: r.id, kind: r.kind, status: r.status, title: r.title,
        actionSummary: r.action_summary, rationale: r.rationale, tier: r.tier,
        estimatedCostCents: r.estimated_cost_cents,
        consequenceIfDenied: r.consequence_if_denied,
        taskId: r.task_id, expiresAt: r.expires_at, createdAt: r.created_at,
        capabilityName: r.capability_name, roleSlug: r.role_slug, roleName: r.role_name, divisionName: r.division_name,
        question: r.question,
        options: r.options,
        input: r.input ?? null,
        goalChain: chain.map((goal) => ({ kind: goal.kind, statement: goal.statement })),
        snoozedUntil: r.snoozed_until,
        allowFor: r.allow_for,
        // What the owner asked and the run answered, and a question still
        // waiting for its answer last (N6).
        asked: [...(r.asked ?? []), ...(r.asking !== null ? [{ question: r.asking, answer: null }] : [])],
      });
    }
    return items;
  });
}

/** One closed item, as the owner's history shows it. */
export interface ClosedDecision {
  id: string;
  kind: InboxKind;
  title: string;
  actionSummary: string;
  tier: number | null;
  status: Exclude<InboxStatus, 'open'>;
  decision: Decision | null;
  note: string | null;
  via: DecisionChannel | null;
  closedReason: string | null;
  taskId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface HistoryPage {
  items: ClosedDecision[];
  /** Pass back as `before` for the next page; null when there is none. */
  next: string | null;
}

/**
 * What the owner decided, and what closed without them (F10.8).
 *
 * The inbox is a queue, so a decided item left the only screen the owner has,
 * and "what did I say about the Acme renewal" had no answer short of reading
 * the event log. Slack's version of this is the thread that scrolled away.
 *
 * `query` matches the words on the item and the owner's own note -- the note
 * is usually where the reason is, and the reason is what gets searched for a
 * month later. Paged by (created_at, id) rather than by offset, so a page
 * boundary does not shift while new items close: Buzz pages its threads the
 * same way (NIP-CW), for the same reason.
 */
export async function history(
  companyId: string,
  options: { query?: string | null; before?: string | null; limit?: number } = {},
): Promise<HistoryPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
  const cursor = options.before ? readCursor(options.before) : null;
  const text = options.query?.trim() ? options.query.trim().slice(0, 200) : null;
  // `%` and `_` are ILIKE's own wildcards; a search for "50%" should not
  // match everything with a 50 in it.
  const pattern = text ? `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;

  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; kind: InboxKind; title: string; action_summary: string;
      tier: number | null; status: Exclude<InboxStatus, 'open'>; decision: Decision | null;
      owner_note: string | null; decided_via: DecisionChannel | null;
      closed_reason: string | null; task_id: string | null;
      created_at: Date; decided_at: Date | null; created_micros: string;
    }>(
      // The page marker carries the row's own timestamp in whole
      // microseconds, which is what the column holds. It used to be the
      // timestamp read out through a Date, in milliseconds: every item
      // created later in the same millisecond as a page's last one compared
      // as newer than the marker, and fell between the pages.
      `SELECT id, kind, title, action_summary, tier, status, decision, owner_note,
              decided_via, closed_reason, task_id, created_at, decided_at,
              (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_micros
         FROM inbox_items
        WHERE status <> 'open'
          AND ($1::text IS NULL
               OR title ILIKE $1 ESCAPE '\\'
               OR action_summary ILIKE $1 ESCAPE '\\'
               OR rationale ILIKE $1 ESCAPE '\\'
               OR coalesce(owner_note, '') ILIKE $1 ESCAPE '\\')
          AND ($2::bigint IS NULL
               OR (created_at, id) < (timestamptz 'epoch' + $2::bigint * interval '1 microsecond',
                                      $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [pattern, cursor?.createdMicros ?? null, cursor?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        actionSummary: row.action_summary,
        tier: row.tier,
        status: row.status,
        decision: row.decision,
        note: row.owner_note,
        via: row.decided_via,
        closedReason: row.closed_reason,
        taskId: row.task_id,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
      })),
      next: rows.length > limit && last ? writeCursor(last.created_micros, last.id) : null,
    };
  });
}

/**
 * A page marker: a row's own timestamp in whole microseconds and its id. Also
 * the memory page's (owner/views.ts), which paged by a millisecond Date and
 * lost what was written in the same millisecond as a page's last row.
 */
export function writeCursor(createdMicros: string, id: string): string {
  return Buffer.from(`${createdMicros}|${id}`, 'utf8').toString('base64url');
}

/** A cursor is the owner's own input on the way back, so it is read, not trusted. */
export function readCursor(raw: string): { createdMicros: string; id: string } {
  const [createdMicros, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!createdMicros || !id || !/^\d{1,18}$/.test(createdMicros)
    || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new PalugadaError('contract.violation', 'that page marker is not one this list issued', {});
  }
  return { createdMicros, id };
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
 * It used to be *asserted* by the caller and checked by nothing, which made
 * F10.10 read "tier 3 for anyone who says mfa". It is now derived: `mfa` is
 * what `decide` writes down after `OwnerMfa` has verified a real second factor
 * against an enrolled authenticator, and a caller cannot set it. What a caller
 * supplies is the proof -- a TOTP code, or a WebAuthn assertion signed by the
 * owner's phone -- and the platform does the arithmetic.
 *
 * `session` and `none` remain, for the tiers where a second factor is not
 * required. They are the caller's word, and at those tiers the caller's word
 * is what the requirement asks for.
 */
export type OwnerAssurance = 'mfa' | 'session' | 'none';

/**
 * What the owner presents to prove a tier 3 approval (F10.10, F12.5).
 *
 * Two shapes because F12.5 names two factors: a code from an authenticator
 * app, and an assertion from a phone that unlocked a key with a fingerprint.
 * Either is verified by `OwnerMfa` against something enrolled; neither is
 * taken on trust.
 */
export type MfaProof =
  | { totp: string }
  | { webauthn: WebAuthnAssertion };

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
  switch (item.kind) {
    case 'approval':
      // F10.9 says "review Tier <= 2" and F10.10 says tier 3 shows a link.
      // The tier test belongs *inside* this case rather than above the switch:
      // F10.10 restricts approving an irreversible action, and an escalation is
      // a question, not an approval. `notifyAfterFor` scopes its own tier 3
      // branch the same way, and the first version of this function did not --
      // which made a tier 3 escalation, exactly what `proposeGoalChange`
      // raises, arrive with nothing to press.
      return (item.tier ?? 0) >= 3 ? 'link_only' : 'actionable';
    case 'escalation':
    case 'skill_candidate':
    // The v1 name for the same decision. `proposeSop` still raises it and
    // `proposeSkill` raises the v2 one, so an owner asked "should this become
    // a procedure?" gets a button from one path and not the other purely by
    // which vocabulary the caller happened to use. F10.9 names the concept,
    // not the spelling.
    case 'sop_candidate':
      return 'actionable';
    case 'incident':
    // Section 6.3: work its budget stopped goes to the owner, and an owner who
    // is not looking at the app is reached where they are. Told, with a link,
    // and nothing to press: raising a ceiling loosens a control and takes the
    // owner's device, so it is done in the app. A month's ceiling reached or
    // nearly reached is the same kind and the same news.
    case 'budget_alert':
      return 'link_only';
    default:
      return 'none';
  }
}

export interface DecideOptions {
  channel?: DecisionChannel;
  /**
   * For tiers below 3, where the platform does not demand a second factor.
   * Ignored at tier 3: there, `assurance` is what the verifier concluded.
   */
  assurance?: OwnerAssurance;
  /** The second factor itself. Required to approve a tier 3 action. */
  proof?: MfaProof;
  /**
   * Who checks it.
   *
   * Passed in rather than reached for, so that a deployment which has not
   * configured MFA cannot approve a tier 3 action by accident -- the absence
   * of a verifier is a refusal, not a bypass.
   */
  mfa?: OwnerMfa;
  /** The batch this decision was one of, written on its record (`decideMany`). */
  batch?: string;
  /**
   * Approve, and allow the same capability to the same role for this many
   * hours without asking again (0083). Only for a card a policy asked for at
   * tier 2 or below, from one to 168 hours, with the owner's second factor.
   */
  allowForHours?: number;
}

/** The longest the owner may allow a capability for without being asked: a week. */
export const STANDING_MAX_HOURS = 168;

/** A yes the owner gave for a while (0083), as the console lists it. */
export interface StandingApproval {
  id: string;
  roleId: string;
  roleSlug: string;
  /** The name the owner gave the role, shown in place of its code. */
  roleName: string | null;
  capabilityName: string;
  grantedByItem: string;
  createdAt: Date;
  expiresAt: Date;
  uses: number;
  lastUsedAt: Date | null;
}

export async function decide(
  companyId: string,
  itemId: string,
  decision: Decision,
  note = '',
  options: DecideOptions = {},
): Promise<void> {
  const channel = options.channel ?? 'api';
  // Defaulted to the weakest, so a caller that says nothing cannot approve a
  // tier 3 action. The safe default is the one that refuses.
  let assurance: OwnerAssurance = options.assurance ?? 'none';
  // F10.10: read the tier before the update, so a refusal changes nothing.
  const { tier, stageChange, goalChange, overdue, standing } = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      tier: number | null; stage_change: StageChange | null; goal_change: GoalChange | null; overdue: boolean;
      allow_for: boolean; capability_name: string | null; role_id: string | null;
    }>(
      `SELECT i.tier, i.payload->'stageChange' AS stage_change,
              CASE WHEN i.kind = 'escalation' THEN i.payload->'goalChange' END AS goal_change,
              (i.expires_at IS NOT NULL AND i.expires_at <= now()) AS overdue,
              (${ALLOW_FOR_SQL}) AS allow_for, i.capability_name, t.role_id
         FROM inbox_items i LEFT JOIN tasks t ON t.id = i.task_id
        WHERE i.id = $1 AND i.status = 'open'`,
      [itemId],
    );
    const row = rows[0];
    return {
      tier: row?.tier ?? null,
      stageChange: row?.stage_change ?? null,
      goalChange: row?.goal_change ?? null,
      overdue: row?.overdue ?? false,
      standing: row?.allow_for && row.capability_name && row.role_id
        ? { capabilityName: row.capability_name, roleId: row.role_id }
        : null,
    };
  });
  // Past its deadline, the owner's silence has already answered: the sweep
  // that says so runs once a tick, and an answer landing in between was
  // honoured -- a late yes overturning a no nobody was asked to confirm.
  // The sweep runs now instead, and the answer is refused as too late.
  if (overdue) {
    await expireOverdue(companyId);
    throw await withTenant(companyId, (tx) => notOpen(tx, itemId));
  }
  // A yes for a while (0083) is checked before any factor is spent on it:
  // a refusal here leaves the card, and the owner's code, as they were.
  const allowForHours = options.allowForHours;
  if (allowForHours !== undefined) {
    if (!Number.isInteger(allowForHours) || allowForHours < 1 || allowForHours > STANDING_MAX_HOURS) {
      throw new PalugadaError(
        'contract.violation',
        `allowForHours is ${String(allowForHours)}; it is a whole number of hours from 1 to ${STANDING_MAX_HOURS}`,
        { field: 'allowForHours' },
      );
    }
    if (decision !== 'approve') {
      throw new PalugadaError('contract.violation', 'only a yes can be given for a while', { field: 'allowForHours' });
    }
    if (!standing) {
      throw new PalugadaError(
        'contract.violation',
        'only a card a policy asked for, at tier 2 or below, can be allowed for a while; '
          + 'a tier 3 action is approved one at a time, and work that read content from outside is asked about every time (F8.9)',
        { inboxItemId: itemId },
      );
    }
    // It loosens a rule for a while, so it takes the owner's device, as a
    // policy made looser does -- whatever the tier of the card itself.
    if (!TIER_3_CHANNELS.has(channel)) {
      throw new PalugadaError('approval.channel_forbidden',
        `allowing ${standing.capabilityName} for a while happens in the app, not over ${channel}`, { inboxItemId: itemId, channel });
    }
    if (!options.mfa || !options.proof) {
      throw new PalugadaError('approval.channel_forbidden',
        `allowing ${standing.capabilityName} for a while needs a second factor; none was presented (PRD F12.5)`,
        { inboxItemId: itemId, reason: options.mfa ? 'no_proof' : 'no_verifier' });
    }
  }

  // Approving a stage proposal moves the company, which the application role
  // may not write (0047), so that one decision is made on the control plane --
  // still one transaction, so the answer and the move happen together. The
  // item was just read inside this company's scope, which is the check row
  // security would have made.
  const moving = stageChange !== null && decision === 'approve';
  // So is a yes to a goal change (`goal.propose`): the application role reads
  // goals and never writes them (F3.10), and the owner's answer is the change.
  const redirecting = goalChange !== null && decision === 'approve';
  // A standing yes is written only on the control plane (0083), in the same
  // transaction as the decision it came with.
  const granting = allowForHours !== undefined;
  const transaction = <T>(fn: (tx: TenantClient) => Promise<T>) =>
    moving || redirecting || granting ? withControlPlane(fn) : withTenant(companyId, fn);

  let factor: VerifiedFactor | null = null;
  if (decision === 'approve' && (tier ?? 0) >= 3) {
    // The pipe first, because it is the cheaper check and because a second
    // factor presented over chat is still a tier 3 approval over chat.
    const refuse = async (reason: string, message: string): Promise<never> => {
      await withTenant(companyId, async (tx) => {
        await appendEvent(tx, {
          companyId,
          type: 'security.tier3_channel_refused',
          actor: 'system',
          payload: { inboxItemId: itemId, channel, assurance, reason },
        });
      });
      throw new PalugadaError('approval.channel_forbidden', message, {
        inboxItemId: itemId, channel, assurance, reason,
      });
    };

    if (!TIER_3_CHANNELS.has(channel)) {
      await refuse(
        'channel',
        `a tier 3 approval cannot be given over ${channel}; it happens in the app (F10.10)`,
      );
    }
    // No verifier is a refusal rather than a bypass. A deployment that has not
    // set up MFA has not met F12.5, and the consequence of not meeting it
    // should be that irreversible actions wait -- not that they proceed.
    if (!options.mfa) {
      await refuse(
        'no_verifier',
        'a tier 3 approval needs a second factor and this deployment has no MFA '
          + 'verifier configured (PRD F10.10, F12.5)',
      );
    }
    if (!options.proof) {
      await refuse(
        'no_proof',
        'a tier 3 approval needs a second factor; none was presented (PRD F10.10, F12.5)',
      );
    }

    // The verification itself throws its own `mfa.*` error, which says which
    // of the eleven ways it failed. Not flattened into this one: "that code
    // has been used before" and "wrong code" are different stories, and only
    // one of them is somebody trying.
    // The company travels with the proof. A factor enrolled against one
    // company must not approve a tier 3 action in another, which is the same
    // isolation every other table in this schema enforces -- and the owner's
    // own platform-scoped device answers for all of them.
    const asking = { purpose: 'approval.tier3', subjectId: itemId, companyId };
    factor =
      'totp' in options.proof!
        ? await options.mfa!.verifyTotp(options.proof.totp, asking)
        : await options.mfa!.verifyWebAuthn(options.proof!.webauthn, asking);
    // Derived, never taken from the caller. This is the whole fix.
    assurance = 'mfa';
  }
  if (granting) {
    const asking = { purpose: 'approval.standing', subjectId: itemId, companyId };
    factor = 'totp' in options.proof!
      ? await options.mfa!.verifyTotp(options.proof.totp, asking)
      : await options.mfa!.verifyWebAuthn(options.proof!.webauthn, asking);
    assurance = 'mfa';
  }

  // One transaction for the decision and the task it releases. As two, a
  // crash between them recorded the owner's answer and left the task in
  // `waiting_approval` for ever -- with nothing open in the inbox to say so,
  // because the item was already decided. Buzz ships this exact defect (an
  // approval committed, then the run resumed from a detached task), and so
  // did this.
  await transaction(async (tx) => {
    // The task before the item, which is the order every other writer takes
    // them in -- the stop button's trigger included -- so a decision racing a
    // stop waits for it rather than deadlocking against it.
    const { rows: target } = await tx.query<{ task_id: string | null }>(
      'SELECT task_id FROM inbox_items WHERE id = $1',
      [itemId],
    );
    const lockedTaskId = target[0]?.task_id ?? null;
    if (lockedTaskId) {
      await tx.query('SELECT 1 FROM tasks WHERE id = $1 FOR NO KEY UPDATE', [lockedTaskId]);
    }

    const { rows } = await tx.query<{
      task_id: string | null;
      kind: InboxKind;
      payload: Record<string, unknown>;
    }>(
      `UPDATE inbox_items
          SET decision = $2,
              decided_at = now(),
              owner_note = $3,
              decided_via = $4,
              status = CASE WHEN $2 = 'ask' THEN 'open' ELSE 'decided' END
        WHERE id = $1 AND status = 'open' AND (expires_at IS NULL OR expires_at > now())
        RETURNING task_id, kind, payload`,
      [itemId, decision, note, channel],
    );
    const row = rows[0];
    if (!row) throw await notOpen(tx, itemId);

    await appendEvent(tx, {
      companyId,
      taskId: row.task_id ?? undefined,
      type: 'owner.decided',
      actor: 'owner',
      // F10.8, and F12.5's audit half: which device the owner used is part of
      // what was decided. An approval that names the authenticator can be
      // matched to the row in `owner_authentications` that authorised it; one
      // that only says "mfa" cannot.
      payload: {
        inboxItemId: itemId,
        kind: row.kind,
        decision,
        note,
        channel,
        assurance,
        ...(factor
          ? { authenticatorId: factor.authenticatorId, factor: factor.kind, device: factor.label }
          : {}),
        ...(options.batch ? { batch: options.batch } : {}),
        ...(granting ? { allowForHours } : {}),
      },
    });

    // 0083: the same capability, to the same role, for a while.
    if (granting) {
      const { rows: granted } = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO standing_approvals (company_id, role_id, capability_name, granted_by_item, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
         RETURNING id, expires_at`,
        [companyId, standing!.roleId, standing!.capabilityName, itemId, allowForHours],
      );
      await appendEvent(tx, {
        companyId,
        taskId: row.task_id ?? undefined,
        type: 'approval.standing_granted',
        actor: 'owner',
        payload: {
          standingApprovalId: granted[0]!.id, inboxItemId: itemId, roleId: standing!.roleId,
          capability: standing!.capabilityName, expiresAt: granted[0]!.expires_at.toISOString(),
        },
      });
    }

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

    // F15.3's second gate: the owner's yes activates the version the reviewer
    // approved, and their no turns it down with their note as the reason. It
    // used to do neither -- the decision was recorded and the skill stayed a
    // candidate, with nothing left in the inbox to say so.
    if (row.kind === 'skill_candidate' && decision !== 'ask') {
      const versionId = String(row.payload.skillVersionId ?? '');
      if (versionId) {
        // Imported here: skills.ts raises this item, so a static import each
        // way would be a cycle for no benefit.
        const skills = await import('../skills/skills.ts');
        if (decision === 'approve') await skills.activateSkillVersionWithin(tx, companyId, versionId);
        else await skills.rejectSkillVersionWithin(tx, companyId, versionId, note);
      }
    }

    // 0057: a proposal to move the company's stage is answered by moving it,
    // from where the proposal said it was and nowhere else.
    if (moving) {
      const current = await stageOf(tx, companyId);
      if (current !== stageChange!.from) {
        throw new PalugadaError(
          'contract.violation',
          `the company is no longer in the ${stageChange!.from ?? 'unset'} stage this proposed moving from; `
            + 'deny it, and ask for a new proposal',
          { inboxItemId: itemId, stage: current },
        );
      }
      await setStageWithin(tx, companyId, stageChange!.to, { inboxItemId: itemId, note });
    }

    // F3.10: a goal change a run proposed is answered by making it, to the
    // goal as it stood when proposed and to no other. One the owner has
    // edited since is refused rather than written over their own words.
    if (redirecting) {
      const { rows: now } = await tx.query<{ statement: string; status: string }>(
        'SELECT statement, status FROM goals WHERE id = $1 AND company_id = $2 FOR UPDATE',
        [goalChange!.goalId, companyId],
      );
      if (!now[0] || now[0].statement !== goalChange!.from.statement || now[0].status !== goalChange!.from.status) {
        throw new PalugadaError(
          'contract.violation',
          'the goal has changed since this was proposed; deny it, and ask for a new proposal',
          { inboxItemId: itemId, goalId: goalChange!.goalId },
        );
      }
      await applyGoalChangeWithin(tx, {
        companyId,
        goalId: goalChange!.goalId,
        statement: goalChange!.to.statement,
        status: goalChange!.to.status,
        inboxItemId: itemId,
      });
    }

    // F9.1: an escalation about a schedule is answered by acting on it. Deny
    // turns it off in the same transaction as the decision, so there is no
    // moment where the owner has said "stop" and the next occurrence fires.
    const scheduleId = typeof row.payload.scheduleId === 'string' ? row.payload.scheduleId : null;
    if (row.kind === 'escalation' && scheduleId && decision !== 'ask') {
      if (decision === 'deny') {
        await tx.query('UPDATE schedules SET enabled = false WHERE id = $1', [scheduleId]);
      }
      await appendEvent(tx, {
        companyId,
        type: decision === 'deny' ? 'schedule.disabled' : 'schedule.kept',
        actor: 'owner',
        payload: { scheduleId, inboxItemId: itemId },
      });
    }

    if (!row.task_id) return;

    if (decision === 'ask') {
      // F10.3: the clarification happens inside this task rather than
      // becoming a second one. The question goes onto the task's record, the
      // task goes back on the queue, and the run that picks it up reads the
      // question in its context. The approval item stays open: asking is not
      // deciding, and the owner still has to say yes.
      await appendEvent(tx, {
        companyId,
        taskId: row.task_id,
        type: 'owner.asked',
        actor: 'owner',
        payload: { inboxItemId: itemId, question: note },
      });
      // And the model is asked again, with the question in front of it (N6):
      // replayed, the turn that asked for the action asked for it again and
      // nobody read the question. What it says is the answer on this card
      // (`requestApproval`).
      if (row.kind === 'approval') await reopenForQuestionWithin(tx, row.task_id, note ?? '');
    }
    // Through `running` for a question too, because that is the only edge out
    // of waiting_approval and the task genuinely is running again -- with a
    // question to answer before it re-proposes whatever it was proposing.
    await settleTask(
      tx, companyId, row.task_id, itemId,
      decision === 'deny' ? 'cancelled' : 'running',
    );
  });
}

/** The furthest an item may be put off. A month is "later"; past that it is "never". */
const SNOOZE_MAX_MS = 30 * 24 * 60 * 60_000;

/**
 * Puts an open item off until a time, or brings it back with `null` (0060).
 *
 * Never past the item's own expiry: silence is a refusal (F10.4), and an
 * item that expired while it was put off is one the owner never saw before
 * it was refused for them.
 */
export async function snooze(companyId: string, itemId: string, until: Date | null): Promise<void> {
  if (until !== null) {
    if (!(until instanceof Date) || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new PalugadaError('contract.violation', 'put it off until a time in the future', { field: 'until' });
    }
    if (until.getTime() - Date.now() > SNOOZE_MAX_MS) {
      throw new PalugadaError('contract.violation', 'an item is put off for at most 30 days', { field: 'until' });
    }
  }
  await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ status: InboxStatus; expires_at: Date | null }>(
      'SELECT status, expires_at FROM inbox_items WHERE id = $1 FOR UPDATE', [itemId]);
    const item = rows[0];
    if (!item || item.status !== 'open') throw await notOpen(tx, itemId);
    if (until && item.expires_at && until >= item.expires_at) {
      throw new PalugadaError(
        'contract.violation',
        `it expires before then, at ${item.expires_at.toISOString()}, and an unanswered item is refused; `
          + 'put it off to before that, or decide it',
        { field: 'until', expiresAt: item.expires_at },
      );
    }
    await tx.query('UPDATE inbox_items SET snoozed_until = $2 WHERE id = $1', [itemId, until]);
    await appendEvent(tx, {
      companyId,
      type: until ? 'owner.snoozed' : 'owner.woke',
      actor: 'owner',
      payload: { inboxItemId: itemId, ...(until ? { until: until.toISOString() } : {}) },
    });
  });
}

/** The most items one batch decides: a screen's worth, not a queue's. */
export const BATCH_MAX = 50;

export interface BatchOutcome {
  decided: string[];
  /** What was left for the owner to decide alone, and why, in their words. */
  skipped: Array<{ itemId: string; reason: string }>;
}

/**
 * Approves or denies several items in one go.
 *
 * Each through `decide`, exactly as it would be decided alone -- its own
 * transaction, its own event, its task released or cancelled -- so a batch is
 * a convenience for the owner and never a second way of deciding. Three kinds
 * are not approved in a batch, because approving them is what the owner
 * should look at one by one: a tier 3 action, which needs their device for
 * that action and no other (F10.10); a question a run asked, which is
 * answered in words; and an incident. Denying any of them is fine: "no" is
 * never the dangerous direction.
 *
 * What was not decided comes back with the reason, rather than failing the
 * batch, so seven of ten approved is seven approved and three still waiting.
 */
export async function decideMany(
  companyId: string,
  itemIds: readonly string[],
  decision: 'approve' | 'deny',
  note = '',
  options: DecideOptions = {},
): Promise<BatchOutcome> {
  if (decision !== 'approve' && decision !== 'deny') {
    throw new PalugadaError(
      'contract.violation',
      'a batch can approve or deny; a question to the agent is asked of one item',
      { decision },
    );
  }
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > BATCH_MAX) {
    throw new PalugadaError('contract.violation', `a batch is 1 to ${BATCH_MAX} items`, {});
  }
  const bad = itemIds.find((id) => typeof id !== 'string' || !UUID.test(id));
  if (bad !== undefined) {
    throw new PalugadaError('contract.violation', `${String(bad)} is not an item id`, {});
  }
  const unique = [...new Set(itemIds)];
  const { rows } = await withTenant(companyId, (tx) => tx.query<{
    id: string; kind: InboxKind; tier: number | null; status: InboxStatus;
    decision: string | null; closed_reason: string | null; asked_by: string | null;
  }>(
    `SELECT id, kind, tier, status, decision, closed_reason, payload->>'askedBy' AS asked_by
       FROM inbox_items WHERE id = ANY($1::uuid[])`,
    [unique],
  ));
  const found = new Map(rows.map((row) => [row.id, row]));
  const batch = randomUUID();
  const outcome: BatchOutcome = { decided: [], skipped: [] };
  for (const itemId of unique) {
    const row = found.get(itemId);
    const reason = !row ? 'it does not exist in this company'
      : row.status === 'decided' ? `it was already decided (${row.decision})`
      : row.status === 'expired' ? 'it expired unanswered'
      : row.status !== 'open' ? `it was withdrawn (${row.closed_reason})`
      : decision === 'deny' ? null
      : (row.tier ?? 0) >= 3 ? 'a tier 3 approval is given one at a time, with your device (F10.10)'
      : row.asked_by === 'agent' ? 'a question is answered in words, not approved'
      : row.kind === 'incident' ? 'an incident is looked at one at a time'
      : null;
    if (reason) {
      outcome.skipped.push({ itemId, reason });
      continue;
    }
    try {
      await decide(companyId, itemId, decision, note, { ...options, batch });
      outcome.decided.push(itemId);
    } catch (error) {
      // Decided on another surface in the meantime, most likely. The rest of
      // the batch is still the owner's answer.
      if (!(error instanceof PalugadaError)) throw error;
      outcome.skipped.push({ itemId, reason: error.message });
    }
  }
  await withTenant(companyId, (tx) => appendEvent(tx, {
    companyId,
    type: 'owner.decided_batch',
    actor: 'owner',
    payload: { batch, decision, decided: outcome.decided.length, skipped: outcome.skipped.length },
  }));
  return outcome;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Moves the task the decision was about, when the decision is what it waits for.
 *
 * Three cases, and only one of them is a move:
 *
 *   - **The task is waiting** (`waiting_approval`, `waiting_review`,
 *     `waiting_window`): the answer releases it -- approve runs it, deny
 *     cancels it.
 *   - **The task is live but not waiting** (`pending`, `checked_out`,
 *     `running`): an escalation or incident about work in progress, or an
 *     approval answered after a question sent the task back to work. Approve
 *     leaves it where it is -- the decision is recorded, and moving a `pending`
 *     task to `running` would put it behind the claim, holding no lease that
 *     anything could expire. Deny still stops it: "no" about live work means
 *     stop the work.
 *   - **The task has ended**: the decision is recorded as moot. The owner has
 *     more than one surface, and a task can finish while an item about it is
 *     open; what must not happen is an error saying their decision failed.
 *
 * It used to attempt the move in every live case, and `running -> running`
 * is not an edge, so approving an item about a running task rolled the whole
 * decision back: the owner saw an error and the item could never be closed.
 */
async function settleTask(
  tx: TenantClient,
  companyId: string,
  taskId: string,
  itemId: string,
  to: 'running' | 'cancelled',
): Promise<void> {
  const task = await getTask(tx, taskId);
  if (!task || isTerminal(task.status)) {
    await appendEvent(tx, {
      companyId,
      ...(task ? { projectId: task.projectId } : {}),
      taskId,
      type: 'owner.decision_moot',
      actor: 'system',
      payload: { inboxItemId: itemId, taskStatus: task?.status ?? null, wanted: to },
    });
    return;
  }
  if (to === 'running' && !WAITING_STATUSES.has(task.status)) return;
  await transitionWithin(tx, companyId, taskId, to);
}

/** The statuses an owner's answer is what a task waits for. */
const WAITING_STATUSES: ReadonlySet<string> = new Set([
  'waiting_approval', 'waiting_review', 'waiting_window',
]);

/**
 * Why an item cannot be decided, in words the owner can act on.
 *
 * "is not open" was the whole message, and it is the answer to four different
 * questions: somebody already decided it (on another surface), it expired, its
 * task ended and it was withdrawn, or it never existed. Only the last is a
 * mistake; the other three are the owner learning that the decision is no
 * longer theirs to make, and they deserve to be told which.
 */
async function notOpen(tx: TenantClient, itemId: string): Promise<PalugadaError> {
  const { rows } = await tx.query<{
    status: InboxStatus; decision: string | null; closed_reason: string | null; overdue: boolean;
  }>(
    `SELECT status, decision, closed_reason,
            (expires_at IS NOT NULL AND expires_at <= now()) AS overdue
       FROM inbox_items WHERE id = $1`,
    [itemId],
  );
  const row = rows[0];
  if (!row) {
    return new PalugadaError('inbox.not_open', `inbox item ${itemId} does not exist`, {
      inboxItemId: itemId, status: null,
    });
  }
  const why =
    row.status === 'decided' ? `it was already decided (${row.decision})`
    : row.status === 'expired' || (row.status === 'open' && row.overdue) ? 'it expired unanswered'
    : `it was withdrawn (${row.closed_reason})`;
  return new PalugadaError('inbox.not_open', `inbox item ${itemId} is closed: ${why}`, {
    inboxItemId: itemId,
    status: row.status,
    decision: row.decision,
    closedReason: row.closed_reason,
  });
}

/**
 * The owner's answer to an escalation, given without deciding it (F10.3).
 *
 * The console offered "Answer the agent instead: sends your answer and puts
 * the task back on the queue", and this wrote the words into the item under
 * the owner's own earlier note, recorded them as an agent's, and left the
 * task where it was (the competitive analysis of 2026-09-28, L18). The
 * answer is now the owner's word to the task, read by its next run the way
 * any instruction is; a task waiting on the owner goes back to work; and
 * the item stays open, because the owner has said something, not decided.
 *
 * A run's own question (`owner.ask`) is the exception: answering it is all
 * there is to decide. Left open, the run that resumed asked it again, found
 * it open and parked, for ever (B6) -- what it reads is the decided item
 * (`askOwner`, `answersFor`). So the answer decides it, as the console and
 * the chats answer one.
 */
export async function answerEscalation(
  companyId: string,
  itemId: string,
  answer: string,
  options: { channel?: DecisionChannel } = {},
): Promise<void> {
  const text = String(answer ?? '').trim();
  if (!text) throw new PalugadaError('contract.violation', 'an answer cannot be empty', { field: 'answer' });
  const { rows: asked } = await withTenant(companyId, (tx) => tx.query<{ question: boolean }>(
    "SELECT payload->>'askedBy' = 'agent' AS question FROM inbox_items WHERE id = $1", [itemId]));
  if (asked[0]?.question) {
    await decide(companyId, itemId, 'approve', text, { channel: options.channel ?? 'api' });
    return;
  }
  await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ task_id: string | null }>(
      `UPDATE inbox_items
          SET payload = payload || jsonb_build_object(
                'answers', coalesce(payload->'answers', '[]'::jsonb) ||
                           jsonb_build_array(jsonb_build_object('from', 'owner', 'answer', $2::text, 'at', now())))
        WHERE id = $1 AND status = 'open'
        RETURNING task_id`,
      [itemId, text],
    );
    const row = rows[0];
    if (!row) throw await notOpen(tx, itemId);

    await appendEvent(tx, {
      companyId,
      taskId: row.task_id ?? undefined,
      type: 'owner.answered',
      actor: 'owner',
      payload: { inboxItemId: itemId, answer: text },
    });
    if (!row.task_id) return;
    // The same record an instruction makes, so the run reads it where it
    // reads the owner's word ("What the owner told you about this task").
    await appendEvent(tx, {
      companyId,
      taskId: row.task_id,
      type: 'owner.instructed',
      actor: 'owner',
      payload: { text, inboxItemId: itemId },
    });
    const task = await getTask(tx, row.task_id);
    if (task && WAITING_STATUSES.has(task.status)) {
      await transitionWithin(tx, companyId, row.task_id, 'running');
    }
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
  // One transaction, for the reason `decide` has one: as two, a crash between
  // expiring the item and cancelling its task left the task waiting on an
  // item that no longer asks anybody anything.
  return withTenant(companyId, async (tx) => {
    // Tasks first, in id order, which is the order the stop button takes them
    // in too: two sweeps and a stop can then only queue, never deadlock.
    await tx.query(
      `SELECT 1 FROM tasks
        WHERE id IN (SELECT task_id FROM inbox_items
                      WHERE status = 'open' AND expires_at IS NOT NULL
                        AND expires_at <= now() AND task_id IS NOT NULL)
        ORDER BY id
        FOR NO KEY UPDATE`,
    );
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
      if (!row.task_id) continue;
      // A task that already ended has nothing to cancel -- the expiry is
      // still recorded, because the owner never answered either way.
      const task = await getTask(tx, row.task_id);
      if (!task || isTerminal(task.status)) continue;
      await transitionWithin(tx, companyId, row.task_id, 'cancelled', {
        haltReason: 'approval_expired',
      });
    }
    return rows.length;
  });
}

/**
 * F10.7: cancels every task on the platform.
 *
 * "Every" is every task that is not already finished, and it is spelled that
 * way -- as the complement of the terminal statuses -- rather than as a list
 * of live ones. The list it replaced named four statuses and the state machine
 * has six live ones, so a task a worker had just claimed (`checked_out`) or
 * one parked on a closed window (`waiting_window`) survived the stop button:
 * held back only by the stop flag, and back to work the moment the owner
 * cleared it, after being told everything had been cancelled.
 *
 * One statement, because a stop that is a loop is a stop a crash can
 * interrupt half-way. And it does in bulk what `transition()` does one task at
 * a time, because this path skips `transition()`: the lease is cleared (a
 * lease left on a cancelled task holds its lane for fifteen minutes) and the
 * reservation goes back to its account (a reservation left on a cancelled task
 * is budget no task can ever use again, which after a stop is every
 * reservation there was). Open approvals for these tasks are withdrawn by the
 * trigger in 0036, which is why that rule lives in the database.
 */
export async function stopEverything(): Promise<number> {
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE platform_control SET stop_all_requested_at = now(), updated_at = now()');
  });

  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; company_id: string; project_id: string;
      budget_account_id: string | null; released: string;
    }>(
      `WITH doomed AS (
         SELECT id, tokens_reserved FROM tasks
          WHERE status <> ALL($1::text[])
          ORDER BY id
          FOR NO KEY UPDATE
       )
       UPDATE tasks t
          SET status = 'cancelled', halt_reason = 'owner_stop', finished_at = now(),
              lease_holder = NULL, lease_expires_at = NULL, tokens_reserved = 0
         FROM doomed d
        WHERE t.id = d.id
       RETURNING t.id, t.company_id, t.project_id, t.budget_account_id,
                 d.tokens_reserved AS released`,
      [TERMINAL_STATUSES],
    );
    await releaseReservations(tx, rows);
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

/** The owner's standing yeses still in force (0083), soonest to end first. */
export async function standingApprovals(companyId: string): Promise<StandingApproval[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; role_id: string; role_slug: string; role_name: string | null; capability_name: string; granted_by_item: string;
      created_at: Date; expires_at: Date; uses: number; last_used_at: Date | null;
    }>(
      `SELECT s.id, s.role_id, r.slug AS role_slug, r.display_name AS role_name, s.capability_name, s.granted_by_item,
              s.created_at, s.expires_at, s.uses, s.last_used_at
         FROM standing_approvals s JOIN roles r ON r.id = s.role_id
        WHERE s.revoked_at IS NULL AND s.expires_at > now()
        ORDER BY s.expires_at, s.id`,
    );
    return rows.map((row) => ({
      id: row.id, roleId: row.role_id, roleSlug: row.role_slug, roleName: row.role_name, capabilityName: row.capability_name,
      grantedByItem: row.granted_by_item, createdAt: row.created_at, expiresAt: row.expires_at,
      uses: row.uses, lastUsedAt: row.last_used_at,
    }));
  });
}

/**
 * Takes a standing yes back (0083). A tightening, so no factor: the next
 * action it would have covered asks the owner again. On the control plane,
 * which alone writes the table, for this company's row and no other.
 */
export async function revokeStanding(companyId: string, standingId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string; capability_name: string; role_id: string }>(
      `UPDATE standing_approvals SET revoked_at = now()
        WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
        RETURNING id, capability_name, role_id`,
      [standingId, companyId],
    );
    if (!rows[0]) {
      throw new PalugadaError('contract.violation',
        `no standing approval ${standingId} is in force for this company`, { standingApprovalId: standingId });
    }
    await appendEvent(tx, {
      companyId,
      type: 'approval.standing_revoked',
      actor: 'owner',
      payload: { standingApprovalId: standingId, capability: rows[0].capability_name, roleId: rows[0].role_id },
    });
  });
}

/**
 * A standing yes that covers this role and capability now, counted as used,
 * or null (0083). What the broker asks before raising a card a policy wants.
 */
export async function useStanding(
  tx: TenantClient,
  roleId: string,
  capabilityName: string,
): Promise<{ id: string; grantedByItem: string } | null> {
  const { rows } = await tx.query<{ id: string; granted_by_item: string }>(
    `UPDATE standing_approvals SET uses = uses + 1, last_used_at = now()
      WHERE id = (SELECT id FROM standing_approvals
                   WHERE role_id = $1 AND capability_name = $2
                     AND revoked_at IS NULL AND expires_at > now()
                   ORDER BY expires_at DESC LIMIT 1)
      RETURNING id, granted_by_item`,
    [roleId, capabilityName],
  );
  return rows[0] ? { id: rows[0].id, grantedByItem: rows[0].granted_by_item } : null;
}
