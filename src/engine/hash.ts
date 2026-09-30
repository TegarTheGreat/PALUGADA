/**
 * Canonical hashing for step inputs and idempotency keys.
 *
 * JSON.stringify preserves insertion order, so two structurally identical
 * inputs built in a different order would hash differently and defeat both
 * replay and idempotency. Keys are sorted before hashing to remove that.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-json.ts';

export { canonicalJson };

export function hashInput(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * F5.2: deterministic across retries and restarts, so a side effect that was
 * already applied before a crash is recognised as the same action rather than
 * repeated.
 */
export function idempotencyKey(taskId: string, stepIndex: number, inputHash: string): string {
  return createHash('sha256')
    .update(`${taskId}:${stepIndex}:${inputHash}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The key of a tool call: what it does, not where it falls in the run.
 *
 * A model that tries a write again -- its answer never came, a vendor
 * timed out after acting -- makes a step of its own, and a key made from
 * the step's place gave the second try a key of its own, so a vendor that
 * had acted on the first could not tell they were one write. Made from the
 * task and the call (the capability and its input, in `inputHash`), the
 * same write asked twice in one task is sent under one key, and the vendor
 * that deduplicates on it acts once.
 */
export function callKey(taskId: string, inputHash: string): string {
  return createHash('sha256')
    .update(`${taskId}:call:${inputHash}`)
    .digest('hex')
    .slice(0, 32);
}

