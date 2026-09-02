/**
 * Canonical hashing for step inputs and idempotency keys.
 *
 * JSON.stringify preserves insertion order, so two structurally identical
 * inputs built in a different order would hash differently and defeat both
 * replay and idempotency. Keys are sorted before hashing to remove that.
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

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
