/**
 * The twenty, as a file an operator writes (PRD v2 §10, F8, F12.8).
 *
 * `httpCapability` reduced a vendor integration to a spec. It did not reduce
 * it to something a deployment can *supply*: the spec was a TypeScript object
 * with functions in it, so the only way to bind `email.send` was to fork this
 * repository and edit the assembly. That is the defect this codebase has found
 * in itself more often than any other -- machinery that works, is tested in
 * isolation, and is assembled by nobody -- and the README already claimed the
 * fix ("what an operator writes is a spec, not an integration") one step
 * before it was true.
 *
 * This is that step. A JSON file names the capabilities a deployment binds,
 * `PALUGADA_VENDORS` points at it, and `main.ts` loads it. No release of this
 * platform is needed when a vendor renames a path.
 *
 * **The four functions become data.** `httpCapability` takes a body builder, a
 * result mapper, a match predicate and a policy describer, and none of those
 * is expressible in JSON -- so each has a declarative form here, deliberately
 * narrow:
 *
 *   - a **body** is a JSON template, substituted value by value rather than by
 *     string, so a value containing a quote cannot produce invalid JSON;
 *   - a **result** is a path into the answer;
 *   - a **match** is a status, a path and a comparison, combined with "and";
 *   - a **describe** maps a policy's four fields to input paths.
 *
 * Narrow on purpose. The alternative to a small vocabulary is an expression
 * language, and an expression language in a configuration file is a way for an
 * operator to write a program that nobody reviews inside the one component
 * standing between an agent and an irreversible action.
 *
 * **A malformed file is a refusal at boot, naming the entry and the field.**
 * The failure this replaces is a deployment that starts, looks healthy, and
 * refuses every `email.send` at the moment an agent tries to work -- which is
 * section 2.3's silent misconfiguration written a second time.
 */
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { PalugadaError } from '../errors.ts';
import type { CapabilityRegistry } from '../broker/registry.ts';
import type { Tier } from '../domain/tier.ts';
import { httpCapability, type HttpCapabilitySpec, type HttpPlaceholders } from './http.ts';

/** A value that must be non-null to count as present. */
type Json = unknown;

export interface MatchRule {
  /** Statuses that count as success. Default: any 2xx. */
  status?: number | number[];
  /** A path that must resolve to something other than null or undefined. */
  present?: string;
  /** A path to compare. Rooted at `status`, `body`, `result` or `input`. */
  path?: string;
  equals?: Json;
  oneOf?: Json[];
  /**
   * A second path, whose value `path` must equal.
   *
   * This is the read-back F8.4 actually wants: not "the vendor returned a
   * field" but "the record now says what I set it to". Written as a path
   * rather than as a placeholder inside `equals`, so there is no question of
   * whether a value that happens to look like `{input.x}` is a template or a
   * string the operator meant literally.
   */
  equalsPath?: string;
}

export interface DescribeRules {
  /** An input path holding an amount in cents. */
  moneyCents?: string;
  /** An input path holding an address or a domain. F3.4 matches on the domain. */
  recipientDomain?: string;
  /** An input path holding a URL. */
  urlHost?: string;
  /** An input path holding a number, or an array whose length is the size. */
  batchSize?: string;
}

export interface VendorSpec {
  name: string;
  adapter: string;
  tier: Tier;
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** A JSON template. Strings may hold `{input.x}` and `{idempotencyKey}`. */
  body?: Json;
  /** A path into `{ status, body }`. Omitted answers with the parsed body. */
  result?: string;
  credentialAlias?: string;
  requiredScopes?: string[];
  verify?: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    matches: MatchRule;
  };
  describe?: DescribeRules;
  estimatedCostCents?: number;
  preflightUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateHosts?: string[];
}

export interface VendorFile {
  capabilities: VendorSpec[];
}

/* ------------------------------------------------------------- the schema --- */

/**
 * What the file may say, checked before anything is built from it.
 *
 * `additionalProperties: false` throughout, which is the point: an operator
 * who writes `credentialAlias` as `credential_alias` should be told, not
 * silently given a capability that sends no token and fails its first call
 * with a vendor's 401. A typo in a configuration file is the single most
 * likely thing to go wrong here.
 */
const SCHEMA = {
  type: 'object',
  required: ['capabilities'],
  additionalProperties: false,
  properties: {
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'adapter', 'tier', 'method', 'url'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          adapter: { type: 'string', minLength: 1 },
          tier: { type: 'integer', minimum: 0, maximum: 3 },
          method: { type: 'string', minLength: 1 },
          url: { type: 'string', minLength: 1 },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: {},
          result: { type: 'string', minLength: 1 },
          credentialAlias: { type: 'string', minLength: 1 },
          requiredScopes: { type: 'array', items: { type: 'string' } },
          verify: {
            type: 'object',
            required: ['url', 'matches'],
            additionalProperties: false,
            properties: {
              method: { type: 'string' },
              url: { type: 'string', minLength: 1 },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
              matches: {
                type: 'object',
                additionalProperties: false,
                // At least one clause: an empty `matches` accepts everything,
                // which is a read-back that reads nothing back.
                minProperties: 1,
                // And a clause that asserts nothing is the same failure in a
                // shape that passes the line above. A `path` with nothing to
                // compare it to reads a field and discards it; an `equals`
                // with no `path` names a value and never looks for it. Both
                // leave a tier 1 write "verified" on any 2xx, which is F8.4
                // satisfied in form and not in substance -- so each requires
                // the other.
                //
                // Written as `if`/`then` rather than `dependentRequired`,
                // which is a 2019-09 keyword this validator runs draft-07 --
                // and an unrecognised keyword under `strict: false` is not an
                // error, it is silently ignored. A guard that validates
                // nothing is the failure it was written to prevent.
                allOf: [
                  {
                    if: { required: ['path'] },
                    then: { anyOf: [
                      { required: ['equals'] },
                      { required: ['oneOf'] },
                      { required: ['equalsPath'] },
                    ] },
                  },
                  {
                    if: { anyOf: [
                      { required: ['equals'] },
                      { required: ['oneOf'] },
                      { required: ['equalsPath'] },
                    ] },
                    then: { required: ['path'] },
                  },
                ],
                properties: {
                  status: {
                    anyOf: [
                      { type: 'integer' },
                      { type: 'array', items: { type: 'integer' }, minItems: 1 },
                    ],
                  },
                  present: { type: 'string', minLength: 1 },
                  path: { type: 'string', minLength: 1 },
                  equals: {},
                  oneOf: { type: 'array' },
                  equalsPath: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          describe: {
            type: 'object',
            additionalProperties: false,
            properties: {
              moneyCents: { type: 'string', minLength: 1 },
              recipientDomain: { type: 'string', minLength: 1 },
              urlHost: { type: 'string', minLength: 1 },
              batchSize: { type: 'string', minLength: 1 },
            },
          },
          estimatedCostCents: { type: 'integer', minimum: 0 },
          preflightUrl: { type: 'string', minLength: 1 },
          timeoutMs: { type: 'integer', minimum: 1 },
          maxBytes: { type: 'integer', minimum: 1 },
          allowPrivateHosts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SCHEMA);

/* -------------------------------------------------------------- the pieces --- */

/**
 * Reads a dotted path out of the answer or the input.
 *
 * Own properties only, and never through a prototype: a path of
 * `constructor.prototype` in a configuration file should read nothing rather
 * than reach the object graph behind the value.
 */
function at(root: unknown, path: string): unknown {
  let value: unknown = root;
  for (const segment of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/**
 * Fills a JSON template, value by value rather than by string.
 *
 * A string that is *exactly* one placeholder becomes the value it names, with
 * its type: `"{input.count}"` is the number 3, not `"3"`, because a vendor
 * that declared an integer field will reject a string and the operator would
 * have no way to say which they meant. A string with anything else around it
 * is interpolated as text.
 */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*)\}/;

function fillTemplate(template: unknown, values: HttpPlaceholders): unknown {
  if (typeof template === 'string') {
    const whole = new RegExp(`^${PLACEHOLDER.source}$`).exec(template);
    if (whole) return placeholder(whole[1]!, values);
    return template.replace(new RegExp(PLACEHOLDER.source, 'g'), (literal, name: string) => {
      const found = placeholder(name, values);
      // A placeholder nothing fills is left as written. `undefined` would
      // become the four letters "undefined" and be sent, and a vendor that
      // 400s on a literal `{input.missing}` is telling the operator the truth.
      return found === undefined ? literal : String(found);
    });
  }
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values));
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>)
        .map(([key, value]) => [key, fillTemplate(value, values)]),
    );
  }
  return template;
}

function placeholder(name: string, values: HttpPlaceholders): unknown {
  if (name === 'idempotencyKey') return values.idempotencyKey;
  if (name === 'companyId') return values.companyId;
  if (name === 'divisionId') return values.divisionId;
  if (name === 'taskId') return values.taskId;
  // Deliberately not `{credential}`. A body is not a header, and a credential
  // in one is a credential in the vendor's request log.
  //
  // Nested, because an input is a document and `{input.customer.email}` is the
  // ordinary way to name a field in one. Reading only the first segment left
  // that placeholder in the body as literal text, which a vendor stores and
  // sends to somebody.
  const dot = name.indexOf('.');
  if (dot > 0 && name.slice(0, dot) === 'input') return at(values.input, name.slice(dot + 1));
  return undefined;
}

function matcher(rule: MatchRule) {
  return (
    answer: { status: number; body: unknown },
    result: unknown,
    input: Record<string, unknown>,
  ): boolean => {
    const scope = { status: answer.status, body: answer.body, result, input };

    if (rule.status !== undefined) {
      const allowed = Array.isArray(rule.status) ? rule.status : [rule.status];
      if (!allowed.includes(answer.status)) return false;
    } else if (answer.status < 200 || answer.status >= 300) {
      // A read-back that named no status still means "and it worked". A vendor
      // answering 502 with a body that happens to hold the right field is the
      // case this exists for.
      return false;
    }

    if (rule.present !== undefined) {
      const found = at(scope, rule.present);
      if (found === undefined || found === null) return false;
    }

    if (rule.path !== undefined) {
      const found = at(scope, rule.path);
      if (rule.oneOf !== undefined && !rule.oneOf.some((one) => deepEqual(one, found))) return false;
      if ('equals' in rule && !deepEqual(rule.equals, found)) return false;
      if (rule.equalsPath !== undefined) {
        const expected = at(scope, rule.equalsPath);
        // An expectation that resolves to nothing is a failed read-back, not a
        // vacuous pass: a rule naming an input field the call did not supply
        // would otherwise report every write as verified.
        if (expected === undefined) return false;
        if (!deepEqual(expected, found)) return false;
      }
    }

    return true;
  };
}

/** Structural, because a vendor's field may be an object and `===` would not see it. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

/**
 * F3.4's four fields, from four input paths.
 *
 * A policy matches on a recipient's domain, a URL's host, an amount and a
 * batch size, and a spec that describes none of them is a spec every
 * domain-scoped policy silently fails to match. Each field is read leniently:
 * a value of the wrong shape is reported as absent rather than as a guess,
 * because a policy that matched on a number parsed out of a string would be
 * matching on something the operator did not write.
 */
function describer(rules: DescribeRules) {
  return (input: Record<string, unknown>) => {
    const out: {
      moneyCents?: number;
      recipientDomain?: string | null;
      urlHost?: string | null;
      batchSize?: number;
    } = {};

    if (rules.moneyCents) {
      const value = at(input, rules.moneyCents);
      if (typeof value === 'number' && Number.isFinite(value)) out.moneyCents = value;
    }

    if (rules.recipientDomain) {
      out.recipientDomain = recipientDomainOf(at(input, rules.recipientDomain));
    }

    if (rules.urlHost) {
      const value = at(input, rules.urlHost);
      out.urlHost = typeof value === 'string' ? hostOf(value) : null;
    }

    if (rules.batchSize) {
      const value = at(input, rules.batchSize);
      // An array is the common shape -- `{ to: [...] }` -- and its length is
      // the batch size without the operator having to name a second field.
      if (Array.isArray(value)) out.batchSize = value.length;
      else if (typeof value === 'number' && Number.isFinite(value)) out.batchSize = value;
    }

    return out;
  };
}

/**
 * The one domain this action is aimed at, or none.
 *
 * A batch is the interesting case, because the field is usually a list. If
 * every address in it shares a domain, that is the domain; if they do not,
 * this answers `null` rather than picking one -- and `null` is the safe answer
 * in both directions a policy can be written. An escalation rule reading
 * `recipient_domain not_in [ours]` fires on `null`, and an allow rule reading
 * `recipient_domain in [ours]` does not match it, so a mixed batch is never
 * quietly waved through on the strength of its first recipient.
 */
function recipientDomainOf(value: unknown): string | null {
  if (typeof value === 'string') return domainOf(value);
  if (Array.isArray(value)) {
    const domains = new Set<string | null>(
      value.map((one) => (typeof one === 'string' ? domainOf(one) : null)),
    );
    if (domains.size !== 1) return null;
    return [...domains][0] ?? null;
  }
  return null;
}

function domainOf(value: string): string | null {
  const at_ = value.lastIndexOf('@');
  const domain = at_ >= 0 ? value.slice(at_ + 1) : value;
  return domain.length > 0 ? domain.toLowerCase() : null;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- the build --- */

/** Turns one validated entry into the spec `httpCapability` takes. */
export function specFrom(entry: VendorSpec): HttpCapabilitySpec {
  const spec: HttpCapabilitySpec = {
    name: entry.name,
    adapter: entry.adapter,
    tier: entry.tier,
    method: entry.method,
    url: entry.url,
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.body === undefined
      ? {}
      : { body: (_input, values) => fillTemplate(entry.body, values) }),
    ...(entry.result
      ? { result: (answer) => at({ status: answer.status, body: answer.body }, entry.result!) }
      : {}),
    ...(entry.credentialAlias ? { credentialAlias: entry.credentialAlias } : {}),
    ...(entry.requiredScopes ? { requiredScopes: entry.requiredScopes } : {}),
    ...(entry.verify
      ? {
        verify: {
          ...(entry.verify.method ? { method: entry.verify.method } : {}),
          url: entry.verify.url,
          ...(entry.verify.headers ? { headers: entry.verify.headers } : {}),
          matches: matcher(entry.verify.matches),
        },
      }
      : {}),
    ...(entry.describe ? { describe: describer(entry.describe) } : {}),
    ...(entry.estimatedCostCents === undefined
      ? {}
      : { estimatedCostCents: entry.estimatedCostCents }),
    ...(entry.preflightUrl ? { preflightUrl: entry.preflightUrl } : {}),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.maxBytes === undefined ? {} : { maxBytes: entry.maxBytes }),
    ...(entry.allowPrivateHosts ? { reach: { allowPrivateHosts: entry.allowPrivateHosts } } : {}),
  };
  return spec;
}

/**
 * Parses a vendor file, refusing anything it cannot build.
 *
 * Separate from reading it so a test -- and an operator's `--check` -- can
 * validate a document without a file, and so the refusal names the entry
 * rather than the byte offset.
 */
export function parseVendors(document: unknown, source = 'the vendor file'): HttpCapabilitySpec[] {
  if (!validate(document)) {
    const first = validate.errors?.[0];
    throw new PalugadaError(
      'config.invalid',
      `${source} is not a valid vendor file: ${first?.instancePath || '(root)'} `
        + `${first?.message ?? 'did not validate'}`,
      { source, errors: validate.errors ?? [] },
    );
  }

  const file = document as VendorFile;
  const seen = new Set<string>();
  return file.capabilities.map((entry) => {
    // A file naming the same capability twice would have one silently win, and
    // which one depends on the order somebody happened to write them in.
    if (seen.has(entry.name)) {
      throw new PalugadaError(
        'config.invalid',
        `${source} names ${entry.name} twice; a capability has one binding`,
        { source, name: entry.name },
      );
    }
    seen.add(entry.name);

    try {
      // `httpCapability` runs its own construction-time refusals here: a tier
      // 1 write with no read-back, a side effect with no idempotency key, a
      // credential in a URL. Wrapped so the message says which entry.
      const spec = specFrom(entry);
      httpCapability(spec);
      return spec;
    } catch (failure) {
      throw new PalugadaError(
        'config.invalid',
        `${source} cannot bind ${entry.name}: ${(failure as Error).message}`,
        { source, name: entry.name },
      );
    }
  });
}

/**
 * Reads the file, builds each capability, and registers it.
 *
 * Returns the names bound, which the boot check prints: a deployment that
 * thinks it configured `email.send` and did not should be able to see that in
 * the first ten lines of its own log rather than in an agent's refusal.
 */
export async function registerVendorCapabilities(
  registry: CapabilityRegistry,
  path: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (failure) {
    throw new PalugadaError(
      'config.invalid',
      `the vendor file ${path} could not be read: ${(failure as Error).message}`,
      { path },
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (failure) {
    throw new PalugadaError(
      'config.invalid',
      `the vendor file ${path} is not JSON: ${(failure as Error).message}`,
      { path },
    );
  }

  const specs = parseVendors(document, path);
  for (const spec of specs) {
    // A name this process already bound is not a name a file may take.
    //
    // `register` is a `Map.set`, so a file naming `memory.search` would
    // silently replace the platform's own binding with a vendor's URL -- and
    // the boot note would still say the platform bound it. Every role's
    // context pack instructs a run to call that tool, so the consequence is
    // the whole platform quietly talking to somebody else's server.
    const existing = registry.get(spec.name);
    if (existing) {
      throw new PalugadaError(
        'config.invalid',
        `${path} binds ${spec.name}, which this deployment already binds `
          + `(adapter ${existing.adapter}); a capability has one binding`,
        { path, name: spec.name, adapter: existing.adapter },
      );
    }

    try {
      // `register` runs `assertCalibrated`, so a file that binds `email.send`
      // at tier 0 is refused here against the catalogue rather than believed.
      // That is the one rule a configuration file must not be able to loosen.
      registry.register(httpCapability(spec));
    } catch (failure) {
      // Rethrown with the file and the entry in front of it, keeping the
      // original code. A boot refusal that says only "email.send is
      // catalogued at tier 2" leaves the operator to work out which of their
      // files said otherwise.
      const code = failure instanceof PalugadaError ? failure.code : 'config.invalid';
      throw new PalugadaError(
        code,
        `${path} cannot bind ${spec.name}: ${(failure as Error).message}`,
        { path, name: spec.name },
      );
    }
  }
  return specs.map((spec) => spec.name);
}
