/**
 * What a reviewer returns: the verdict `settleCompletedReviews` reads.
 *
 * A reviewer's output is shown its schema before it answers (context/builder.ts),
 * so the schema is where it learns that a verdict is `decision` and `reason`.
 * Given the ordinary work output instead, a reviewer answers with a summary, and
 * a review with no readable verdict goes to the owner as undecided -- which is
 * what every review by the standard company's reviewer and the built-in
 * bundles' reviewers did until the audit of 3 October
 * (docs/AUDIT-2026-10-03-ONE-MAN-COMPANY.md, 3.3). Kept apart from the roles
 * and from `review.ts` so both the template and the bundles can name it
 * without the one importing the other.
 */
export const VERDICT_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['decision', 'reason'],
  properties: {
    decision: {
      enum: ['approve', 'revise', 'reject'],
      description: 'approve to support it, reject to oppose it, revise when you need more before you can say',
    },
    reason: {
      type: 'string',
      minLength: 1,
      description: 'Your verdict line first, then what decided it. The owner reads it with the proposal.',
    },
  },
};
