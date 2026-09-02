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
