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
import { getTask, transitionWithin } from '../engine/tasks.ts';
import { TERMINAL_STATUSES, isTerminal } from '../domain/task.ts';
import { notifyAfterFor } from '../scheduler/windows.ts';
import { escalationPolicyFor } from '../governance/structure.ts';
import { approveCandidate, rejectCandidate } from '../memory/store.ts';
import type { Tier } from '../domain/tier.ts';
import type { OwnerMfa, VerifiedFactor, WebAuthnAssertion } from '../owner/mfa.ts';

/** F10.4. The owner is one person and may be asleep, travelling or ill. */
export const DEFAULT_APPROVAL_TTL_HOURS = 72;

export type InboxKind = 'approval' | 'escalation' | 'incident' | 'sop_candidate' | 'budget_alert';
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
      const { rows } = await tx.query<{ id: string; action_fingerprint: string | null }>(
        `SELECT id, action_fingerprint FROM inbox_items
          WHERE task_id = $1 AND kind = 'approval' AND status = 'open'
            AND capability_name IS NOT DISTINCT FROM $2
          ORDER BY created_at LIMIT 1`,
        [input.taskId, input.capabilityName],
      );
      const open = rows[0] ?? null;
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
        input.companyId, input.taskId ?? null, input.actionSummary, input.actionSummary,
        input.rationale, input.tier, input.estimatedCostCents ?? 0,
        input.consequenceIfDenied, input.capabilityName,
        JSON.stringify(input.payload ?? {}), ttl, notifyAfter,
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
 * Marks an approval as spent, once the action it approved has executed.
 *
 * After the execution rather than before it, so an action that failed can be
 * retried on the same approval; and once, so the same approval cannot carry
 * the same irreversible action a second time.
 */
export async function consumeApproval(
  companyId: string,
  itemId: string,
  context: { taskId: string; capability: string },
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE inbox_items SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
      [itemId],
    );
    if (rowCount !== 1) return;
    await appendEvent(tx, {
      companyId,
      taskId: context.taskId,
      type: 'approval.used',
      actor: 'broker',
      payload: { inboxItemId: itemId, capability: context.capability },
    });
  });
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
        handledBy
          ? `${input.detail}\n\n${handledBy.roleSlug} was asked first and has had ` +
            `${handledBy.afterMinutes} minutes.`
          : input.detail,
        input.tier ?? null, notifyAfter,
        // The recorded grace period is the one that was actually granted, so
        // an item whose division names nobody does not read as though four
        // hours were given to someone.
        JSON.stringify(
          handledBy
            ? {
                divisionId: input.divisionId,
                escalationRole: handledBy.roleSlug,
                afterMinutes: handledBy.afterMinutes,
              }
            : input.divisionId
              ? { divisionId: input.divisionId, escalationRole: null }
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
        ...(handledBy
          ? { escalationRole: handledBy.roleSlug, afterMinutes: handledBy.afterMinutes }
          : {}),
      },
    });
    return id;
  });
}

/**
 * An escalation about a schedule rather than a task (F9.1).
 *
 * The answer acts on the schedule: deny turns it off, approve leaves it
 * running. Carried in the payload, and `decide` reads it, so the owner's
 * answer is the action rather than a note they then have to go and carry out.
 */
export async function raiseScheduleEscalation(input: {
  companyId: string;
  scheduleId: string;
  title: string;
  detail: string;
}): Promise<string> {
  const itemId = await raiseEscalation({
    companyId: input.companyId,
    title: input.title,
    detail: input.detail,
  });
  await withTenant(input.companyId, (tx) => tx.query(
    `UPDATE inbox_items SET payload = payload || jsonb_build_object('scheduleId', $2::text)
      WHERE id = $1`,
    [itemId, input.scheduleId],
  ));
  return itemId;
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
      id: string; kind: InboxKind; status: InboxStatus;
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
      created_at: Date; decided_at: Date | null;
    }>(
      `SELECT id, kind, title, action_summary, tier, status, decision, owner_note,
              decided_via, closed_reason, task_id, created_at, decided_at
         FROM inbox_items
        WHERE status <> 'open'
          AND ($1::text IS NULL
               OR title ILIKE $1 ESCAPE '\\'
               OR action_summary ILIKE $1 ESCAPE '\\'
               OR rationale ILIKE $1 ESCAPE '\\'
               OR coalesce(owner_note, '') ILIKE $1 ESCAPE '\\')
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [pattern, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
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
      next: rows.length > limit && last ? writeCursor(last.created_at, last.id) : null,
    };
  });
}

function writeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** A cursor is the owner's own input on the way back, so it is read, not trusted. */
function readCursor(raw: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || !Number.isFinite(Date.parse(createdAt))
    || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new PalugadaError('contract.violation', 'that page marker is not one this history issued', {});
  }
  return { createdAt, id };
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
  const tier = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ tier: number | null }>(
      "SELECT tier FROM inbox_items WHERE id = $1 AND status = 'open'",
      [itemId],
    );
    return rows[0]?.tier ?? null;
  });

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

  // One transaction for the decision and the task it releases. As two, a
  // crash between them recorded the owner's answer and left the task in
  // `waiting_approval` for ever -- with nothing open in the inbox to say so,
  // because the item was already decided. Buzz ships this exact defect (an
  // approval committed, then the run resumed from a detached task), and so
  // did this.
  await withTenant(companyId, async (tx) => {
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
        WHERE id = $1 AND status = 'open'
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
      },
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
    status: InboxStatus; decision: string | null; closed_reason: string | null;
  }>(
    'SELECT status, decision, closed_reason FROM inbox_items WHERE id = $1',
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
    : row.status === 'expired' ? 'it expired unanswered'
    : `it was withdrawn (${row.closed_reason})`;
  return new PalugadaError('inbox.not_open', `inbox item ${itemId} is closed: ${why}`, {
    inboxItemId: itemId,
    status: row.status,
    decision: row.decision,
    closedReason: row.closed_reason,
  });
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
    if (!row) throw await notOpen(tx, itemId);

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
    // One release per account rather than per task, and every account any of
    // them touches locked first, in id order -- the order `budget_spend` and
    // `budget_settle` lock in. Releasing chain by chain would hold the company
    // account from the first while waiting for the second division's, which a
    // worker recording usage against that division may already hold while it
    // waits for the company's: a deadlock PostgreSQL would settle by aborting
    // one side, and the side it aborts can be this one.
    const released = new Map<string, bigint>();
    for (const row of rows) {
      if (!row.budget_account_id || BigInt(row.released) === 0n) continue;
      released.set(row.budget_account_id,
        (released.get(row.budget_account_id) ?? 0n) + BigInt(row.released));
    }
    if (released.size > 0) {
      await tx.query(
        `SELECT app.budget_lock_chain(ARRAY(
           SELECT DISTINCT unnest(app.budget_chain(account)) FROM unnest($1::uuid[]) AS account))`,
        [[...released.keys()]],
      );
      for (const [account, tokens] of released) {
        await tx.query('SELECT app.budget_release($1, $2)', [account, tokens.toString()]);
      }
    }
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
