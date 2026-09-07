/**
 * A vendor capability as configuration rather than as code (PRD v2 F8, F12.8).
 *
 * Twenty of the twenty-five names the standard template grants need somebody's
 * account, and this platform does not get to choose whose: `email.send`
 * against Resend and against SES are different programs, and picking one for
 * every company that will ever run here is a product decision a control plane
 * has no standing to make.
 *
 * But "we cannot choose the vendor" is not the same as "every deployment
 * writes the same four hundred lines". What those twenty have in common is
 * everything that is hard, and it is the same list `CliAdapter` found for
 * F13.3: resolving a credential without the capability ever holding it,
 * keeping the request out of this network, carrying an idempotency key on
 * anything with a side effect, reading the state back afterwards, reporting a
 * destination a policy can match on, and turning somebody else's error body
 * into a refusal an agent can act on. What differs is a URL, a header and
 * which field of the answer matters.
 *
 * So that is the split, and it is the third time this repository has reached
 * for it. The hard part is here, written once. The part that differs is an
 * `HttpCapabilitySpec` -- a JSON-shaped object naming a method, a URL template
 * and a mapping -- which an operator supplies and can correct when a vendor
 * changes a path, without a release of this platform.
 *
 * **What is refused at construction**, because each of these fails silently:
 *
 *   - A capability at tier 1 or above with no `verify`. F8.4 requires a
 *     read-back for anything that writes, and the broker enforces it at call
 *     time -- but discovering that when an agent first tries to send an
 *     invoice is discovering it in the worst place. Refused when the spec is
 *     built instead.
 *   - A side-effecting method that places no idempotency key. F12.8 asks for
 *     one on every adapter method that has an effect, and a retry without one
 *     is how a runtime that timed out sends the same email twice.
 *   - A credential interpolated into a URL. A URL travels in logs, in
 *     redirects and in the other end's access log; a header does not. The
 *     redactor would catch the value in this platform's own trace and can do
 *     nothing about the vendor's.
 */
import { PalugadaError } from '../errors.ts';
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import type { Tier } from '../domain/tier.ts';
import { safeFetch, type ReachableOptions } from './reachable.ts';

/**
 * The placeholders a spec may use.
 *
 * `{credential}` is the resolved secret, and it is deliberately usable only in
 * a header: see the module comment. Everything else is the call's own data.
 */
export interface HttpPlaceholders {
  /** Every field of the capability's input, as `{input.name}`. */
  input: Record<string, unknown>;
  /** F12.8. The key the engine already minted for this call. */
  idempotencyKey: string;
  /** The resolved credential, if the spec named an alias. */
  credential: string;
  companyId: string;
  divisionId: string;
  taskId: string;
}

export interface VerifySpec {
  /** Default GET: a read-back that wrote something would not be one. */
  method?: string;
  /** May use `{result.*}` as well as the placeholders above. */
  url: string;
  headers?: Record<string, string>;
  /**
   * Whether what came back matches what was asked for.
   *
   * A function rather than a field comparison, because "did it work" is
   * vendor-shaped: one returns the object, another a status, another an empty
   * 204 that means yes. Given the parsed body and the status.
   */
  matches(answer: { status: number; body: unknown }, result: unknown): boolean;
}

export interface HttpCapabilitySpec {
  name: string;
  /** The vendor, for the catalogue: `resend`, `cloudflare`, `stripe`. */
  adapter: string;
  tier: Tier;
  method: string;
  /** May use `{input.*}` and `{idempotencyKey}`. Never `{credential}`. */
  url: string;
  headers?: Record<string, string>;
  /**
   * The request body, built from the input.
   *
   * A function rather than a template, because a body is structured and a
   * template of one is a way to produce invalid JSON out of a value with a
   * quote in it.
   */
  body?: (input: Record<string, unknown>, placeholders: HttpPlaceholders) => unknown;
  /** What the capability answers with, from the vendor's reply. */
  result?: (answer: { status: number; body: unknown }) => unknown;
  /** The division's credential alias. Resolved per call, never held. */
  credentialAlias?: string;
  /** F12.6. What that credential must declare for this to be allowed. */
  requiredScopes?: readonly string[];
  /** F8.4. Required at tier 1 and above. */
  verify?: VerifySpec;
  /** F3.4. What a policy may match on. */
  describe?: (input: Record<string, unknown>) => {
    moneyCents?: number;
    recipientDomain?: string | null;
    urlHost?: string | null;
    batchSize?: number;
  };
  estimatedCostCents?: number;
  /** F8.12. A cheap call that says whether the credential still works. */
  preflightUrl?: string;
  timeoutMs?: number;
  /**
   * How much of the vendor's answer this capability will read, in bytes.
   *
   * A cap exists so one chatty vendor cannot exhaust the orchestrator, and the
   * refusal above tells an operator to raise it -- so it has to be raisable
   * here, per capability, rather than being a constant only the transport
   * knows. Left unset it is `safeFetch`'s default.
   */
  maxBytes?: number;
  reach?: ReachableOptions;
  fetch?: typeof globalThis.fetch;
}

/** Methods with an effect, which F12.8 requires an idempotency key on. */
const SIDE_EFFECTING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function httpCapability(spec: HttpCapabilitySpec): Capability<
  Record<string, unknown>,
  unknown
> {
  const method = spec.method.toUpperCase();

  // F8.4, at construction rather than at the first invoice. The broker refuses
  // a tier 1 call with no `verify` anyway; the difference is whether an
  // operator finds out now or an agent finds out mid-task.
  if (spec.tier >= 1 && !spec.verify) {
    throw new PalugadaError(
      'capability.verify_missing',
      `${spec.name} is tier ${spec.tier} and declares no verify: a write nobody reads `
        + 'back is a write nobody knows happened (PRD F8.4)',
      { capability: spec.name },
    );
  }

  // F12.8. A retry without a key is how a runtime that timed out sends the
  // same email twice, and the vendor is the only party who can deduplicate it.
  if (SIDE_EFFECTING.has(method)) {
    const carriesKey = [spec.url, ...Object.values(spec.headers ?? {})]
      .some((part) => part.includes('{idempotencyKey}'));
    if (!carriesKey) {
      throw new PalugadaError(
        'contract.violation',
        `${spec.name} is a ${method} and places no {idempotencyKey}: a retry would be `
          + 'a second real action (PRD F12.8)',
        { capability: spec.name },
      );
    }
  }

  // A URL travels in logs, in redirects and in the other end's access log; a
  // header does not. This platform's redactor would catch the value in its own
  // trace and can do nothing about the vendor's.
  // Every URL a spec can name, not only the main one. `verify.url` and
  // `preflightUrl` are filled from the same placeholders, so a check that read
  // one of the three left two doors open -- and worse than open: `fill`
  // percent-encodes into a URL, which defeats the redactor's verbatim
  // substring match, so the secret would survive into this platform's own
  // error details and audit events as well as the vendor's access log.
  for (const [where, url] of [
    ['url', spec.url],
    ['verify.url', spec.verify?.url],
    ['preflightUrl', spec.preflightUrl],
  ] as const) {
    if (url?.includes('{credential}')) {
      throw new PalugadaError(
        'contract.violation',
        `${spec.name} puts its credential in ${where}, where it is logged by everybody `
          + 'it passes and survives redaction; put it in a header (PRD F12.1)',
        { capability: spec.name, where },
      );
    }
  }

  const capability: Capability<Record<string, unknown>, unknown> = {
    name: spec.name,
    adapter: spec.adapter,
    defaultTier: spec.tier,
    ...(spec.estimatedCostCents === undefined
      ? {}
      : { estimatedCostCents: spec.estimatedCostCents }),
    ...(spec.requiredScopes ? { requiredScopes: spec.requiredScopes } : {}),

    async execute(input, ctx) {
      const placeholders = await resolve(spec, input, ctx);
      const answer = await request(spec, {
        method,
        url: fill(spec.url, placeholders),
        headers: fillAll(spec.headers ?? {}, placeholders),
        ...(spec.body ? { body: JSON.stringify(spec.body(input, placeholders)) } : {}),
        signal: ctx.signal,
      });

      // A vendor's refusal is a fact about the action, not a fault in the
      // call, and an agent can act on it only if it survives as one. The
      // status and whatever the body said travel together, because "402" and
      // "402: card declined" are different amounts of help.
      if (answer.status >= 400) {
        throw new PalugadaError(
          'contract.violation',
          `${spec.name} was refused by ${spec.adapter}: ${answer.status}`
            + (answer.text ? ` ${answer.text.slice(0, 200)}` : ''),
          { capability: spec.name, status: answer.status },
        );
      }

      return spec.result
        ? spec.result({ status: answer.status, body: answer.body })
        : answer.body;
    },
  };

  if (spec.verify) {
    const verifySpec = spec.verify;
    capability.verify = async (input, result, ctx) => {
      const placeholders = await resolve(spec, input, ctx);
      const answer = await request(spec, {
        method: (verifySpec.method ?? 'GET').toUpperCase(),
        url: fill(verifySpec.url, { ...placeholders, result: result as Record<string, unknown> }),
        // The write's headers minus its idempotency key. Replaying that key on
        // a read tells a vendor that deduplicates by it that this *is* the
        // write, and some answer with the original response rather than the
        // current state -- which is a read-back that reads back the request.
        headers: readHeaders(verifySpec.headers ?? spec.headers ?? {}, placeholders),
        signal: ctx.signal,
      });
      // A read-back that could not be made is not a read-back that passed.
      if (answer.status >= 400) return false;
      return verifySpec.matches({ status: answer.status, body: answer.body }, result);
    };
  }

  if (spec.describe) {
    capability.describe = spec.describe;
  }

  if (spec.preflightUrl) {
    const preflightUrl = spec.preflightUrl;
    capability.preflight = async (ctx) => {
      // The credential is what F8.12 is actually for. "Expired", "revoked" and
      // "rotated to something the vendor no longer accepts" are the failures
      // no retry fixes, and a preflight that could only check that a host
      // answers would be checking the part that was never in doubt.
      if (spec.credentialAlias && !ctx.credential) {
        return {
          ok: false,
          detail:
            `${spec.name} needs the ${spec.credentialAlias} credential to preflight and the `
            + 'caller supplied no way to resolve one (PRD F8.12)',
        };
      }

      try {
        const placeholders: HttpPlaceholders = {
          input: {},
          idempotencyKey: '',
          credential: spec.credentialAlias
            ? await ctx.credential!(spec.credentialAlias, spec.name)
            : '',
          companyId: ctx.companyId,
          divisionId: ctx.divisionId,
          taskId: '',
        };
        const answer = await request(spec, {
          method: 'GET',
          url: fill(preflightUrl, placeholders),
          // The same reasoning as the read-back, and one more: a preflight has
          // no input, so a header templated on `{input.x}` would go out with
          // the placeholder still in it. A vendor that 400s on that would mark
          // a perfectly good credential unhealthy and halt every task that
          // needs it, which is the opposite of what F8.12 is for.
          headers: readHeaders(spec.headers ?? {}, placeholders),
        });
        return answer.status < 400
          ? { ok: true, detail: `${spec.adapter} answered ${answer.status}` }
          : { ok: false, detail: `${spec.adapter} answered ${answer.status}` };
      } catch (error) {
        // The failure that no retry fixes, found before a task is handed a
        // capability that cannot work.
        return { ok: false, detail: `${spec.adapter} is not usable: ${(error as Error).message}` };
      }
    };
  }

  return capability;
}

/* ------------------------------------------------------------------ parts --- */

async function resolve(
  spec: HttpCapabilitySpec,
  input: Record<string, unknown>,
  ctx: CapabilityContext,
): Promise<HttpPlaceholders> {
  // Resolved per call and never held. The broker looks it up against the
  // *calling* division, so a role cannot receive another division's secret by
  // naming their alias -- and the version is read every time, so F12.3's
  // rotation takes effect on the next call rather than within a cache lifetime.
  const credential = spec.credentialAlias ? await ctx.credential(spec.credentialAlias) : '';
  return {
    input,
    idempotencyKey: ctx.idempotencyKey,
    credential,
    companyId: ctx.companyId,
    divisionId: ctx.divisionId,
    taskId: ctx.taskId,
  };
}

async function request(
  spec: HttpCapabilitySpec,
  call: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{ status: number; body: unknown; text: string }> {
  // Through `safeFetch`, like every other capability that makes a request. A
  // vendor URL is configuration, and configuration is a thing an operator can
  // get wrong -- pointing one at `169.254.169.254` should be refused rather
  // than obeyed because it came from a settings file instead of an agent.
  const answer = await safeFetch(call.url, {
    ...(spec.reach ?? {}),
    method: call.method,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...call.headers },
    ...(call.body === undefined ? {} : { body: call.body }),
    ...(call.signal ? { signal: call.signal } : {}),
    timeoutMs: spec.timeoutMs ?? 15_000,
    ...(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes }),
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
  });

  // A truncated answer is not an answer. `safeFetch` caps a response so an
  // agent cannot exhaust the orchestrator by naming a large file, and for a
  // page half of it is still useful -- but half of a JSON document fails to
  // parse, comes back as a string, and is returned as the capability's result.
  // `verify` then reads `{result.id}` off a string, leaves the placeholder
  // literal, and reports a successful write as unverified. Failing loudly
  // names the real problem: the vendor said more than this capability is
  // configured to read.
  if (answer.truncated) {
    throw new PalugadaError(
      'contract.violation',
      `${spec.name} was answered with more than it may read; raise the response cap or `
        + 'narrow the request',
      { capability: spec.name, status: answer.status },
    );
  }

  let body: unknown = null;
  try {
    body = answer.body ? JSON.parse(answer.body) : null;
  } catch {
    // Not JSON. Kept as text rather than treated as a failure: a 204 with an
    // empty body and a vendor that answers `OK` are both successes, and only
    // the caller's `result` knows what to do with either.
    body = answer.body;
  }
  return { status: answer.status, body, text: answer.body };
}

/**
 * Substitutes `{input.x}`, `{credential}` and the rest into one string.
 *
 * Values are URL-encoded when the target is a URL and left alone in a header,
 * which is why `fill` is told which it is building -- an email address in a
 * path segment has to be encoded, and a bearer token must not be.
 */
export function fill(
  template: string,
  values: HttpPlaceholders & { result?: Record<string, unknown> },
  encode = true,
): string {
  return template.replace(/\{([a-zA-Z]+)(?:\.([a-zA-Z0-9_]+))?\}/g, (whole, root: string, leaf?: string) => {
    const raw = pick(values, root, leaf);
    if (raw === undefined) return whole;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return encode ? encodeURIComponent(text) : text;
  });
}

/**
 * The headers for a read: no idempotency key, and nothing left unfilled.
 *
 * A read is not the write it is checking on, and sending the write's key says
 * otherwise to any vendor that deduplicates by it. A header still carrying a
 * `{...}` is a header built from data a read does not have, and a vendor is
 * entitled to refuse it -- which would report a healthy credential as broken.
 */
function readHeaders(
  headers: Record<string, string>,
  values: HttpPlaceholders,
): Record<string, string> {
  const filled = fillAll(headers, values);
  return Object.fromEntries(
    Object.entries(filled).filter(([name, value]) =>
      !name.toLowerCase().includes('idempotency') && !/\{[a-zA-Z]/.test(value)),
  );
}

function fillAll(
  headers: Record<string, string>,
  values: HttpPlaceholders,
): Record<string, string> {
  // Headers are not URL-encoded: `Bearer sk_live_...` must arrive as written,
  // and percent-encoding it would produce a credential the vendor rejects
  // while looking, in every log, exactly like the right one.
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, fill(value, values, false)]),
  );
}

function pick(
  values: HttpPlaceholders & { result?: Record<string, unknown> },
  root: string,
  leaf?: string,
): unknown {
  if (root === 'input') return leaf ? values.input[leaf] : undefined;
  if (root === 'result') return leaf ? values.result?.[leaf] : undefined;
  if (leaf) return undefined;
  return (values as unknown as Record<string, unknown>)[root];
}
