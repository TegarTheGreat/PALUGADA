/**
 * Contained sub-agents (PRD v2 F6.7).
 *
 * A sub-agent is short-lived, holds a subset of the tools, and returns two
 * things to its parent: a schema-validated output, and a summary of at most
 * 500 tokens. What it does *not* return is its transcript.
 *
 * The reason is context economy, and the failure it prevents is specific. A
 * parent that receives everything its children said accumulates their reasoning
 * as well as their answers, so a task that delegates four times carries five
 * runs' worth of thinking into its sixth decision. Section 9 caps a run's
 * context at 40k tokens; a handful of unbounded child transcripts spends it on
 * work that is already finished.
 *
 * The cap is enforced rather than requested. An instruction to "keep it short"
 * in a prompt is exactly the kind of rule principle 12 says may not live only
 * in a prompt.
 *
 * Tokens are estimated at four characters each. That is a rough figure and it
 * is deliberately not calibrated per model: the number exists to stop a
 * transcript, not to bill for one, and a cap that needs a tokeniser is a cap
 * that stops working when the tokeniser is unavailable.
 */
import { PalugadaError } from '../errors.ts';

/** F6.7's ceiling. */
export const CHILD_SUMMARY_TOKEN_LIMIT = 500;

/** F6.7 again: the output itself is an answer, not a report. */
export const CHILD_OUTPUT_TOKEN_LIMIT = 2_000;

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ChildResult {
  /** The child's output, validated against its role's schema (F6.3). */
  output: Record<string, unknown>;
  /** At most `CHILD_SUMMARY_TOKEN_LIMIT` tokens. */
  summary: string;
}

/**
 * Bounds what a child hands back.
 *
 * A child whose output exceeds the limit is a contract violation rather than a
 * value to truncate. Truncating an output would hand the parent something that
 * looks like an answer and is not one -- half a JSON document that still parses
 * is the worst possible failure here -- whereas a refusal is visible and points
 * at the child that caused it.
 *
 * The *summary* is truncated, because a summary is prose and half of it is
 * still readable.
 */
export function containChildResult(
  roleSlug: string,
  output: Record<string, unknown>,
  detail: { status: string; steps: number; costCents: number },
): ChildResult {
  const serialised = JSON.stringify(output);
  const tokens = estimateTokens(serialised);
  if (tokens > CHILD_OUTPUT_TOKEN_LIMIT) {
    throw new PalugadaError(
      'contract.violation',
      `child ${roleSlug} returned about ${tokens} tokens, over the ${CHILD_OUTPUT_TOKEN_LIMIT} ` +
        'a sub-agent may hand back (F6.7). A sub-agent returns an answer, not a report.',
      { roleSlug, tokens },
    );
  }

  return { output, summary: summarise(roleSlug, output, detail) };
}

function summarise(
  roleSlug: string,
  output: Record<string, unknown>,
  detail: { status: string; steps: number; costCents: number },
): string {
  const head =
    `${roleSlug} ${detail.status} in ${detail.steps} step${detail.steps === 1 ? '' : 's'}` +
    (detail.costCents > 0 ? `, ${detail.costCents}c` : '') +
    '.';

  // The keys first, then as much of the values as fits. A parent that needs
  // more can read the child's own record; what it needs here is enough to
  // decide what to do next.
  const keys = Object.keys(output);
  const shape = keys.length > 0 ? ` Returned ${keys.join(', ')}.` : ' Returned nothing.';

  const budget = CHILD_SUMMARY_TOKEN_LIMIT * CHARS_PER_TOKEN;
  const body = ` ${JSON.stringify(output)}`;
  const summary = `${head}${shape}${body}`;

  return summary.length <= budget
    ? summary
    : `${summary.slice(0, budget - 1).trimEnd()}…`;
}
