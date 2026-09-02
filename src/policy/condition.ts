/**
 * Declarative policy conditions (PRD F3.4).
 *
 * Conditions are data, not code. They arrive from the database and are
 * evaluated by this interpreter, so a policy can never execute anything: there
 * is no eval, no Function constructor and no caller-supplied regular
 * expression. Patterns are globs compiled to anchored expressions with every
 * other character escaped, which also removes the catastrophic backtracking a
 * hand-written regex in a configuration row could otherwise cause.
 *
 * F3.4 requires conditions to reference the tool, the tier, the division, an
 * amount of money, a destination (email domain or URL), the hour, and a call
 * count within a window. Those are exactly the fields below; adding another is
 * a change here rather than a new expression language.
 */

export interface ActionFacts {
  /** Capability name, for example "dns.update". */
  tool: string;
  /** Effective reversibility tier, after any grant override. */
  tier: number;
  /** Slug of the division the acting role belongs to. */
  division: string;
  /** Money this action will spend, in cents. */
  money_cents: number;
  /** Recipient domain for messaging capabilities, lower-cased. */
  recipient_domain: string | null;
  /** Host of the URL this action targets, lower-cased. */
  url_host: string | null;
  /** Local hour (0-23) in the company's timezone. */
  hour_local: number;
  /** Calls to this capability by this division in the trailing window. */
  calls_in_window: number;
}

export type FactName = keyof ActionFacts;

export type Comparison =
  | { field: FactName; op: 'eq' | 'ne'; value: string | number | null }
  | { field: FactName; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { field: FactName; op: 'in' | 'not_in'; value: Array<string | number> }
  | { field: FactName; op: 'matches'; value: string };

export type Condition =
  | Comparison
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

const FACT_NAMES: ReadonlySet<string> = new Set([
  'tool',
  'tier',
  'division',
  'money_cents',
  'recipient_domain',
  'url_host',
  'hour_local',
  'calls_in_window',
]);

/**
 * Validates a condition before it is stored.
 *
 * A malformed condition that only fails when evaluated is worse than one that
 * is rejected: it would quietly stop matching, and a policy that stops
 * matching is a policy that stops protecting.
 */
export function assertValidCondition(
  condition: unknown,
  path = '$',
): asserts condition is Condition {
  if (typeof condition !== 'object' || condition === null) {
    throw new Error(`policy condition at ${path} must be an object`);
  }
  const node = condition as Record<string, unknown>;

  if ('all' in node || 'any' in node) {
    const key = 'all' in node ? 'all' : 'any';
    const children = node[key];
    if (!Array.isArray(children) || children.length === 0) {
      throw new Error(`policy condition at ${path}.${key} must be a non-empty array`);
    }
    children.forEach((child, index) => assertValidCondition(child, `${path}.${key}[${index}]`));
    return;
  }

  if ('not' in node) {
    assertValidCondition(node.not, `${path}.not`);
    return;
  }

  const { field, op, value } = node;
  if (typeof field !== 'string' || !FACT_NAMES.has(field)) {
    throw new Error(`policy condition at ${path} references unknown field ${String(field)}`);
  }

  switch (op) {
    case 'eq':
    case 'ne':
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`policy condition at ${path} expects a string, number or null`);
      }
      return;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof value !== 'number') {
        throw new Error(`policy condition at ${path} expects a number`);
      }
      return;
    case 'in':
    case 'not_in':
      if (!Array.isArray(value)) {
        throw new Error(`policy condition at ${path} expects an array`);
      }
      return;
    case 'matches':
      if (typeof value !== 'string') {
        throw new Error(`policy condition at ${path} expects a glob string`);
      }
      return;
    default:
      throw new Error(`policy condition at ${path} uses unknown operator ${String(op)}`);
  }
}

const REGEXP_SPECIAL = /[.+?^${}()|[\]\\]/g;

/** Compiles a glob such as "dns.*" into an anchored, fully escaped expression. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split('*')
    .map((literal) => literal.replace(REGEXP_SPECIAL, (char) => `\\${char}`))
    .join('.*');
  return new RegExp(`^${pattern}$`);
}

export function evaluateCondition(condition: Condition, facts: ActionFacts): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateCondition(child, facts));
  if ('any' in condition) return condition.any.some((child) => evaluateCondition(child, facts));
  if ('not' in condition) return !evaluateCondition(condition.not, facts);

  const actual = facts[condition.field];

  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'ne':
      return actual !== condition.value;
    case 'gt':
      return typeof actual === 'number' && actual > condition.value;
    case 'gte':
      return typeof actual === 'number' && actual >= condition.value;
    case 'lt':
      return typeof actual === 'number' && actual < condition.value;
    case 'lte':
      return typeof actual === 'number' && actual <= condition.value;
    case 'in':
      return actual !== null && condition.value.includes(actual as string | number);
    case 'not_in':
      // An unknown destination is not a member of any allow-list, so
      // "recipient is not in the internal domains" holds. Treating it as a
      // match keeps the safe reading: a destination we cannot identify is
      // external until proven otherwise.
      return actual === null || !condition.value.includes(actual as string | number);
    case 'matches':
      return typeof actual === 'string' && globToRegExp(condition.value).test(actual);
  }
}
