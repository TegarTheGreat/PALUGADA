/**
 * RFC 8785, the JSON Canonicalization Scheme (F19.19; STATUS section 2.208).
 *
 * Every envelope PALUGADA sends a relay is signed over these bytes, so a
 * relay that parses an envelope, keeps it, forwards it or writes it out again
 * with its own library can make the same bytes from what it parsed and still
 * prove the deployment sent it. That is only true when both sides agree on one
 * form for one value: keys sorted by their UTF-16 code units, no whitespace,
 * strings escaped only where JSON must, and numbers written as ECMAScript
 * writes them, which is what `JSON.stringify` does for a finite number.
 *
 * Kept apart from `src/canonical-json.ts`, which orders keys for hashing and
 * comparing inside this process and writes strings and numbers however
 * `JSON.stringify` does: that is enough for a hash this process alone makes,
 * and not a form a stranger can be held to. This one refuses what has no
 * canonical form -- a number that is not finite, text that is not well-formed
 * UTF-16, a value JSON does not have -- rather than writing it some way.
 * No dependency: the scheme is small, and its test vectors are in the tests.
 */
import { PalugadaError } from '../errors.ts';

/** A lone surrogate: half of a pair with nothing to pair with, which no UTF-8 can carry. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The canonical JSON of a value, as RFC 8785 writes it. */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw refused(`a number in canonical JSON is finite, not ${String(value)}`);
      }
      // ECMAScript's own number-to-string, which RFC 8785 adopts: -0 is 0.
      return JSON.stringify(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw refused('a string in canonical JSON is well-formed UTF-16, with no lone surrogate');
      // Escapes only `"`, `\\` and the control characters, with lower-case
      // hex, as RFC 8785 section 3.2.2.2 asks; every other character as itself.
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => {
          if (item === undefined) throw refused('an array in canonical JSON holds JSON values, not undefined');
          return jcs(item);
        }).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw refused(`canonical JSON is made of plain JSON values, not a ${(value as object).constructor?.name ?? 'object'}`);
      }
      // A field that is undefined is not there, as JSON.stringify reads it.
      const keys = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined);
      for (const key of keys) {
        if (LONE_SURROGATE.test(key)) throw refused('a key in canonical JSON is well-formed UTF-16, with no lone surrogate');
      }
      // The default sort compares UTF-16 code units, which is the order RFC 8785 names.
      keys.sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    default:
      throw refused(`canonical JSON is made of JSON values, not ${typeof value}`);
  }
}

function refused(message: string): PalugadaError {
  return new PalugadaError('contract.violation', message, {});
}
