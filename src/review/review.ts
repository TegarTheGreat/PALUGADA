/**
 * Adversarial review and decision records (PRD F7).
 *
 * A review gates one specific action. The proposal is fingerprinted from the
 * capability and its input, and an approval is a grant for exactly that
 * fingerprint -- not a mood the task is now in. A proposer that comes back with
 * a different amount, a different recipient or a different record has not been
 * approved for it, and the broker will ask again.
 *
 * The loop is deliberately short. F7.2 allows two revisions and then hands the
 * matter to the owner, because a reviewer and a proposer that cannot converge
 * in three exchanges are not going to converge in thirty, and every extra round
 * spends real money to rediscover that.
 *
 * F7.6: there are no scheduled reviews. Nothing in this module runs on a
 * timer; a review exists because a policy demanded one or the owner asked.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { hashInput } from '../engine/hash.ts';
import { createSubTask, getTask, transition } from '../engine/tasks.ts';
import { remember } from '../memory/store.ts';
import * as inbox from '../inbox/inbox.ts';
import { PalugadaError } from '../errors.ts';

/** F7.2. Round 1 is the first review; two revisions take it to round 3. */
export const MAX_REVISIONS = 2;

export type ReviewDecision = 'approve' | 'revise' | 'reject';
export type ReviewStatus = 'pending' | 'approved' | 'revise' | 'rejected' | 'escalated';

export interface ReviewRequest {
  id: string;
  round: number;
  status: ReviewStatus;
  criteria: string;
  proposal: Record<string, unknown>;
  reviewTaskId: string | null;
  decision: ReviewDecision | null;
  reason: string | null;
}

/**
 * Identifies the exact action under review.
 *
 * The capability name and the canonical input, so a changed argument is a
 * different action needing its own review.
 */
export function fingerprintAction(capabilityName: string, input: unknown): string {
  return hashInput({ capability: capabilityName, input });
}

interface RawReview {
  id: string;
  round: number;
  status: ReviewStatus;
  criteria: string;
  proposal: Record<string, unknown>;
  review_task_id: string | null;
  decision: ReviewDecision | null;
  reason: string | null;
}

function toReview(row: RawReview): ReviewRequest {
  return {
    id: row.id,
    round: row.round,
    status: row.status,
    criteria: row.criteria,
    proposal: row.proposal,
    reviewTaskId: row.review_task_id,
    decision: row.decision,
    reason: row.reason,
  };
}

const SELECT_REVIEW = `
  SELECT id, round, status, criteria, proposal, review_task_id, decision, reason
    FROM review_requests`;

/**
 * Whether this exact action already carries an approval (F7.1).
 *
 * Consulted by the broker before executing. Scoped to the proposing task as
 * well as the fingerprint, so one task's approved action does not authorise
 * another task to perform it.
 */
export async function isApproved(
  tx: TenantClient,
  proposerTaskId: string,
  actionFingerprint: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM review_requests
      WHERE proposer_task_id = $1 AND action_fingerprint = $2 AND status = 'approved'
      LIMIT 1`,
    [proposerTaskId, actionFingerprint],
  );
  return rows.length > 0;
}

export async function latestReview(
  tx: TenantClient,
  proposerTaskId: string,
  actionFingerprint: string,
): Promise<ReviewRequest | null> {
  const { rows } = await tx.query<RawReview>(
    `${SELECT_REVIEW}
      WHERE proposer_task_id = $1 AND action_fingerprint = $2
      ORDER BY round DESC LIMIT 1`,
    [proposerTaskId, actionFingerprint],
  );
  return rows[0] ? toReview(rows[0]) : null;
}

export interface OpenReviewInput {
  companyId: string;
  projectId: string;
  divisionId: string;
  proposerTaskId: string;
  proposerRoleId: string;
  reviewerRoleSlug: string;
  capabilityName: string;
  actionFingerprint: string;
  proposal: Record<string, unknown>;
  criteria: string;
  reserveTokens?: number;
}

export type OpenReviewResult =
  | { outcome: 'already_approved' }
  | { outcome: 'pending'; reviewRequestId: string; reviewTaskId: string; round: number }
  | { outcome: 'rejected'; reviewRequestId: string }
  | { outcome: 'escalated'; reviewRequestId: string };

/**
 * Opens a review, or reports that this action already has an answer.
 *
 * A `revise` verdict from the previous round advances to the next round, which
 * is how the proposer gets a second attempt without the reviewer having to
 * remember anything: the round number and the previous reason are in the row.
 */
export async function openReview(input: OpenReviewInput): Promise<OpenReviewResult> {
  const existing = await withTenant(input.companyId, (tx) =>
    latestReview(tx, input.proposerTaskId, input.actionFingerprint),
  );

  if (existing?.status === 'approved') return { outcome: 'already_approved' };
  if (existing?.status === 'rejected') return { outcome: 'rejected', reviewRequestId: existing.id };
  if (existing?.status === 'escalated') return { outcome: 'escalated', reviewRequestId: existing.id };
  if (existing?.status === 'pending') {
    return {
      outcome: 'pending',
      reviewRequestId: existing.id,
      reviewTaskId: existing.reviewTaskId!,
      round: existing.round,
    };
  }

  const round = existing ? existing.round + 1 : 1;

  // F7.2: the third round is the last. Beyond it the disagreement is the
  // owner's to settle, not something to keep paying a model to relitigate.
  if (round > MAX_REVISIONS + 1) {
    const escalatedId = await withTenant(input.companyId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE review_requests SET status = 'escalated', decided_at = now()
          WHERE proposer_task_id = $1 AND action_fingerprint = $2
          RETURNING id`,
        [input.proposerTaskId, input.actionFingerprint],
      );
      return rows[0]!.id;
    });

    await inbox.raiseEscalation({
      companyId: input.companyId,
      taskId: input.proposerTaskId,
      title: `Review deadlocked after ${MAX_REVISIONS} revisions: ${input.capabilityName}`,
      detail:
        `Proposer and reviewer did not converge on ${input.capabilityName}. ` +
        `Last reviewer note: ${existing?.reason ?? 'none recorded'}. ` +
        `Criteria: ${input.criteria}`,
    });

    return { outcome: 'escalated', reviewRequestId: escalatedId };
  }

  const reviewerRoleId = await withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM roles WHERE slug = $1', [
      input.reviewerRoleSlug,
    ]);
    return rows[0]?.id ?? null;
  });

  if (!reviewerRoleId) {
    throw new PalugadaError(
      'review.required',
      `policy names reviewer role ${input.reviewerRoleSlug}, which does not exist`,
      { reviewerRoleSlug: input.reviewerRoleSlug },
    );
  }

  if (reviewerRoleId === input.proposerRoleId) {
    // Also a database constraint. Caught here so the message names the cause
    // rather than surfacing as a constraint violation.
    throw new PalugadaError(
      'review.required',
      `role ${input.reviewerRoleSlug} cannot review its own proposal (PRD F7.3)`,
      { reviewerRoleSlug: input.reviewerRoleSlug },
    );
  }

  // F7.7: a reviewer on the same model as the proposer shares its blind spots.
  // Chosen here rather than left to the reviewer role's configuration, because
  // the property that matters is a *relation* between two roles and neither one
  // can see the other's setting.
  const routing = await chooseReviewerModel(input.companyId, input.proposerRoleId, reviewerRoleId);

  // The review runs as a separate task, so it has its own step journal and
  // therefore its own working memory. F7.3 asks for exactly that: a reviewer
  // that shares the proposer's scratch space is reviewing its own reasoning.
  const reviewTask = await createSubTask(input.proposerTaskId, {
    companyId: input.companyId,
    projectId: input.projectId,
    divisionId: input.divisionId,
    roleId: reviewerRoleId,
    input: {
      proposal: input.proposal,
      criteria: input.criteria,
      round,
      previousReason: existing?.reason ?? null,
      // The reviewer is told which model it should be answering on, and
      // whether the platform managed to find a different one at all.
      model: routing.model,
      sameModelAsProposer: routing.sameAsProposer,
    },
    createdBy: 'event',
    ...(input.reserveTokens === undefined ? {} : { reserveTokens: input.reserveTokens }),
  });

  const reviewRequestId = await withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO review_requests
         (company_id, project_id, proposer_task_id, proposer_role_id, reviewer_role_id,
          review_task_id, capability_name, action_fingerprint, proposal, criteria, round)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.companyId,
        input.projectId,
        input.proposerTaskId,
        input.proposerRoleId,
        reviewerRoleId,
        reviewTask.id,
        input.capabilityName,
        input.actionFingerprint,
        JSON.stringify(input.proposal),
        input.criteria,
        round,
      ],
    );
    const id = rows[0]!.id;

    await appendEvent(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      taskId: input.proposerTaskId,
      type: 'review.requested',
      actor: 'broker',
      payload: {
        reviewRequestId: id,
        reviewTaskId: reviewTask.id,
        capability: input.capabilityName,
        round,
      },
    });
    return id;
  });

  return { outcome: 'pending', reviewRequestId, reviewTaskId: reviewTask.id, round };
}

export interface ReviewVerdict {
  decision: ReviewDecision;
  reason: string;
}

/**
 * Records a reviewer's verdict and moves the proposing task.
 *
 * Every verdict produces a decision record (F7.4) and a `decision` fact in
 * semantic memory (F7.5), including a rejection. A company that only remembers
 * what it agreed to learns half as much as one that remembers what it turned
 * down and why.
 */
export async function recordVerdict(
  companyId: string,
  reviewRequestId: string,
  verdict: ReviewVerdict,
): Promise<{ decisionRecordId: string; proposerTaskId: string }> {
  const result = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      project_id: string;
      proposer_task_id: string;
      proposer_role_id: string;
      reviewer_role_id: string;
      division_id: string;
      capability_name: string;
      proposal: Record<string, unknown>;
      criteria: string;
      round: number;
      status: ReviewStatus;
    }>(
      `SELECT r.id, r.project_id, r.proposer_task_id, r.proposer_role_id,
              r.reviewer_role_id, r.capability_name, r.proposal, r.criteria,
              r.round, r.status, t.division_id
         FROM review_requests r
         JOIN tasks t ON t.id = r.proposer_task_id
        WHERE r.id = $1`,
      [reviewRequestId],
    );
    const review = rows[0];
    if (!review) throw new Error(`review request ${reviewRequestId} not found`);
    if (review.status !== 'pending') {
      throw new PalugadaError(
        'review.required',
        `review ${reviewRequestId} is already ${review.status}`,
        { reviewRequestId, status: review.status },
      );
    }

    const nextStatus: ReviewStatus =
      verdict.decision === 'approve' ? 'approved' : verdict.decision === 'reject' ? 'rejected' : 'revise';

    await tx.query(
      `UPDATE review_requests
          SET status = $2, decision = $3, reason = $4, decided_at = now()
        WHERE id = $1`,
      [reviewRequestId, nextStatus, verdict.decision, verdict.reason],
    );

    const eventId = await appendEvent(tx, {
      companyId,
      projectId: review.project_id,
      taskId: review.proposer_task_id,
      type: 'review.decided',
      actor: 'agent_run',
      payload: {
        reviewRequestId,
        decision: verdict.decision,
        round: review.round,
        capability: review.capability_name,
      },
    });

    // F7.4: the artefact records what was proposed, against what criteria, what
    // the critique was and who decided -- enough to reconstruct the judgement
    // without replaying the run.
    const { rows: recordRows } = await tx.query<{ id: string }>(
      `INSERT INTO decision_records
         (company_id, project_id, task_id, proposal, critique, decision, criteria,
          source_event_id, review_request_id, proposer_role_id, reviewer_role_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        companyId,
        review.project_id,
        review.proposer_task_id,
        JSON.stringify(review.proposal),
        JSON.stringify({ reason: verdict.reason, round: review.round }),
        verdict.decision,
        review.criteria,
        eventId,
        reviewRequestId,
        review.proposer_role_id,
        review.reviewer_role_id,
      ],
    );
    const decisionRecordId = recordRows[0]!.id;

    // F7.5: the decision becomes a fact the division can recall later, marked
    // as a decision rather than an observation so an agent can tell the
    // difference between "we chose this" and "this is so".
    await remember(tx, {
      companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: review.division_id,
      factKind: 'decision',
      body:
        `Review of ${review.capability_name}: ${verdict.decision}. ` +
        `Criteria: ${review.criteria}. Reviewer: ${verdict.reason}`,
      source: 'adversarial_review',
      sourceEventId: eventId,
    });

    return { decisionRecordId, proposerTaskId: review.proposer_task_id, status: nextStatus };
  });

  // The proposing task waits in `waiting_review`; the verdict releases it.
  const proposer = await withTenant(companyId, (tx) => getTask(tx, result.proposerTaskId));
  if (proposer && proposer.status === 'waiting_review') {
    if (result.status === 'rejected') {
      await transition(companyId, result.proposerTaskId, 'failed');
    } else {
      // Both `approved` and `revise` return the proposer to work. On approval
      // the broker finds the grant; on a revision it finds the reviewer's note
      // and the round advances.
      await transition(companyId, result.proposerTaskId, 'running');
    }
  }

  return { decisionRecordId: result.decisionRecordId, proposerTaskId: result.proposerTaskId };
}

/**
 * Settles reviews whose reviewer task has finished.
 *
 * State-driven rather than a callback, for the same reason handoff is: a
 * worker that was down when the reviewer finished still settles the review
 * when it comes back. It also keeps the two ends ignorant of each other -- the
 * reviewer role returns a verdict as its ordinary typed output and knows
 * nothing about review bookkeeping, and the engine knows nothing about reviews
 * at all.
 *
 * A reviewer that finished without a usable verdict is escalated rather than
 * guessed at. Treating an unreadable answer as an approval would make the
 * whole gate decorative.
 */
export async function settleCompletedReviews(companyId: string): Promise<
  Array<{ reviewRequestId: string; decision: ReviewDecision | 'unreadable' }>
> {
  const finished = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      review_task_id: string;
      output: Record<string, unknown> | null;
      task_status: string;
      capability_name: string;
      proposer_task_id: string;
    }>(
      `SELECT r.id, r.review_task_id, t.output, t.status AS task_status,
              r.capability_name, r.proposer_task_id
         FROM review_requests r
         JOIN tasks t ON t.id = r.review_task_id
        WHERE r.status = 'pending' AND t.status IN ('completed', 'failed', 'halted', 'cancelled')
        ORDER BY r.created_at`,
    );
    return rows;
  });

  const settled: Array<{ reviewRequestId: string; decision: ReviewDecision | 'unreadable' }> = [];

  for (const row of finished) {
    const verdict = readVerdict(row.output, row.task_status);

    if (!verdict) {
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE review_requests SET status = 'escalated', decided_at = now() WHERE id = $1`,
          [row.id],
        );
      });
      await inbox.raiseEscalation({
        companyId,
        taskId: row.proposer_task_id,
        title: `Review produced no usable verdict: ${row.capability_name}`,
        detail:
          `The reviewer task ended as ${row.task_status} without a readable decision. ` +
          'The proposed action is still blocked and needs your judgement.',
      });
      settled.push({ reviewRequestId: row.id, decision: 'unreadable' });
      continue;
    }

    await recordVerdict(companyId, row.id, verdict);
    settled.push({ reviewRequestId: row.id, decision: verdict.decision });
  }

  return settled;
}

function readVerdict(
  output: Record<string, unknown> | null,
  taskStatus: string,
): ReviewVerdict | null {
  if (taskStatus !== 'completed' || !output) return null;
  const decision = output.decision;
  if (decision !== 'approve' && decision !== 'revise' && decision !== 'reject') return null;
  const reason = typeof output.reason === 'string' ? output.reason : '';
  return { decision, reason };
}

/** Reviews still waiting on a reviewer, for a worker to pick up. */
export async function pendingReviews(companyId: string): Promise<
  Array<{ reviewRequestId: string; reviewTaskId: string; reviewerRoleSlug: string }>
> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      review_task_id: string;
      slug: string;
    }>(
      `SELECT r.id, r.review_task_id, ro.slug
         FROM review_requests r
         JOIN roles ro ON ro.id = r.reviewer_role_id
        WHERE r.status = 'pending' AND r.review_task_id IS NOT NULL
        ORDER BY r.created_at`,
    );
    return rows.map((row) => ({
      reviewRequestId: row.id,
      reviewTaskId: row.review_task_id,
      reviewerRoleSlug: row.slug,
    }));
  });
}


/**
 * Picks a model for the reviewer that is not the proposer's (F7.7).
 *
 * Two models trained the same way, prompted the same way, tend to be wrong the
 * same way. A reviewer that shares the proposer's model is a second opinion in
 * name only, so the reviewer role's own routing is searched for anything the
 * proposer did not use.
 *
 * When there is nothing else -- a deployment with one model configured -- the
 * review still happens, on the same model, and an event says so. Refusing to
 * review at all would be worse: a same-model reviewer catches a great deal
 * that no reviewer catches nothing of. What must not happen is for the
 * weakening to be invisible, because a review everybody believes is
 * independent and is not is more dangerous than no review.
 */
export async function chooseReviewerModel(
  companyId: string,
  proposerRoleId: string,
  reviewerRoleId: string,
): Promise<{ model: string; sameAsProposer: boolean }> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      model: string;
      model_primary: string | null;
      model_fallback: string[];
    }>(
      'SELECT id, model, model_primary, model_fallback FROM roles WHERE id = ANY($1::uuid[])',
      [[proposerRoleId, reviewerRoleId]],
    );

    const proposer = rows.find((row) => row.id === proposerRoleId);
    const reviewer = rows.find((row) => row.id === reviewerRoleId);
    const proposerModel = proposer?.model_primary ?? proposer?.model ?? '';
    const reviewerPrimary = reviewer?.model_primary ?? reviewer?.model ?? '';

    if (reviewerPrimary && reviewerPrimary !== proposerModel) {
      return { model: reviewerPrimary, sameAsProposer: false };
    }

    const alternative = (reviewer?.model_fallback ?? []).find(
      (candidate) => candidate && candidate !== proposerModel,
    );
    if (alternative) return { model: alternative, sameAsProposer: false };

    await appendEvent(tx, {
      companyId,
      type: 'review.same_model',
      actor: 'system',
      payload: {
        model: reviewerPrimary,
        reason: 'no model configured for the reviewer differs from the proposer',
      },
    });
    return { model: reviewerPrimary, sameAsProposer: true };
  });
}
