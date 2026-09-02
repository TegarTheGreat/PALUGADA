/**
 * Order-independent JSON serialisation.
 *
 * Two structurally identical objects built in a different key order serialise
 * differently under JSON.stringify, which breaks anything that compares or
 * hashes them. Both places that care are affected in ways that matter:
 * a step's input hash would differ between runs and defeat replay, and a
 * governance diff would report a field as changed when only its key order
 * moved -- which is what a jsonb round-trip does, since PostgreSQL stores
 * object keys in its own order.
 *
 * An audit log that invents changes is worse than no audit log, because it is
 * believed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
}
