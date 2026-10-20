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

/** F6.7's ceiling. */
export const CHILD_SUMMARY_TOKEN_LIMIT = 500;

/** F6.7 again: the output itself is an answer, not a report. */
export const CHILD_OUTPUT_TOKEN_LIMIT = 2_000;

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ChildResult {
  /** The child's output, validated against its role's schema (F6.3); cut short where it was over the limit. */
  output: Record<string, unknown>;
  /** At most `CHILD_SUMMARY_TOKEN_LIMIT` tokens. */
  summary: string;
  /** Set when the output was cut to fit: the task that keeps it whole, and how long the whole was. */
  abbreviated: { taskId: string; characters: number } | null;
}

/**
 * Bounds what a child hands back.
 *
 * An output over the limit is handed back cut short, and every cut says so
 * where it was made: how much of the value is shown and which task keeps the
 * whole, where the owner reads it. The result is marked `abbreviated`, and
 * the summary says the same. This used to be a refusal, on the reasoning
 * that half a JSON document that still parses looks like an answer and is
 * not one. The refusal was worse in practice: on a live run the marketer
 * finished the plan the owner had asked the CEO for, the CEO was refused it,
 * its rerun could not read it either, and the owner never received the work.
 * A finished deliverable is the work, not a transcript; a cut that names
 * itself cannot be taken for the whole, and the ceiling F6.7 sets on what
 * enters the parent's context still holds.
 *
 * The *summary* is truncated, because a summary is prose and half of it is
 * still readable.
 */
export function containChildResult(
  roleSlug: string,
  output: Record<string, unknown>,
  detail: { status: string; steps: number; costCents: number; taskId: string },
): ChildResult {
  const contained = containOutput(output, detail.taskId);
  return { output: contained.output, summary: summarise(roleSlug, contained.output, detail, contained.abbreviated), abbreviated: contained.abbreviated };
}

/**
 * The most of another task's output a task may carry: the same ceiling, and
 * the same cuts that say where the whole is kept, whoever is handed it -- a
 * parent given a child's result, a follow-up given the work it follows up.
 * One policy decides what enters a run's context from a run that is not its
 * own.
 */
export function containOutput(
  output: Record<string, unknown>,
  taskId: string,
): { output: Record<string, unknown>; abbreviated: { taskId: string; characters: number } | null } {
  const serialised = JSON.stringify(output);
  if (estimateTokens(serialised) <= CHILD_OUTPUT_TOKEN_LIMIT) return { output, abbreviated: null };
  return {
    output: cutToFit(output, taskId, CHILD_OUTPUT_TOKEN_LIMIT * CHARS_PER_TOKEN),
    abbreviated: { taskId, characters: serialised.length },
  };
}

/**
 * The output with its longest strings and lists shortened until it fits.
 *
 * Each pass halves how long a string and how many items a list may keep, so
 * the short fields -- a verdict, a status, a summary line -- come through
 * whole and only the long ones are cut. What nothing can make fit is
 * replaced by its keys and where the whole is.
 */
function cutToFit(output: Record<string, unknown>, taskId: string, budget: number): Record<string, unknown> {
  const where = `The whole is kept on task ${taskId}, where the owner reads it.`;
  for (let chars = 2_000, items = 64; chars >= 40; chars = Math.floor(chars / 2), items = Math.max(4, Math.floor(items / 2))) {
    const cut = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.length <= chars ? value : `${value.slice(0, chars)} … [cut here: ${chars} of ${value.length} characters. ${where}]`;
      }
      if (Array.isArray(value)) {
        const kept = value.slice(0, items).map(cut);
        return value.length <= items ? kept : [...kept, `[cut here: ${items} of ${value.length} items. ${where}]`];
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cut(inner)]));
      }
      return value;
    };
    const shortened = cut(output) as Record<string, unknown>;
    if (JSON.stringify(shortened).length <= budget) return shortened;
  }
  return { cut: `[too large to hand back in part. ${where}]`, keys: Object.keys(output).slice(0, 50) };
}

function summarise(
  roleSlug: string,
  output: Record<string, unknown>,
  detail: { status: string; steps: number; costCents: number },
  abbreviated: { taskId: string; characters: number } | null,
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
  const cut = abbreviated
    ? ` Its output was ${abbreviated.characters} characters, over the ${CHILD_OUTPUT_TOKEN_LIMIT} tokens a sub-agent ` +
      `may hand back (F6.7), so it is cut short here; the whole is kept on task ${abbreviated.taskId}, where the ` +
      'owner reads it. Point to it rather than retyping it.'
    : '';

  const budget = CHILD_SUMMARY_TOKEN_LIMIT * CHARS_PER_TOKEN;
  const body = ` ${JSON.stringify(output)}`;
  const summary = `${head}${shape}${cut}${body}`;

  return summary.length <= budget
    ? summary
    : `${summary.slice(0, budget - 1).trimEnd()}…`;
}
