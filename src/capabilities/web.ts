/**
 * The capabilities that need nobody's account (PRD v2 F8, F13).
 *
 * The standard company template grants twenty-five capability names and the
 * broker binds none of them, which is the design: `email.send` against Resend
 * and against SES are different programs, and choosing one for every company
 * that will ever use this platform is not a decision a control plane gets to
 * make.
 *
 * But that argument does not apply to all twenty-five. Fetching a web page,
 * checking whether a host is up, listing files under a directory, and drafting
 * a document with the model the role already has -- none of those needs an
 * account with anybody. They were unbound for the same reason as the other
 * nineteen, which was the wrong reason, and the difference is exactly the one
 * this repository got wrong once already about MFA: *a vendor account cannot
 * be conjured, and code can be written.*
 *
 * So these are real. They are also the ones where getting it wrong is worst,
 * because they are granted to four divisions each in the standard template and
 * they run inside the platform's own network. `reachable.ts` carries that
 * argument; every capability here goes through it.
 */
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';
import { safeFetch, type ReachableOptions } from './reachable.ts';

export interface WebOptions extends ReachableOptions {
  /** How much of a page a role may be handed. Bigger is not more useful. */
  maxBytes?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface FetchInput {
  url: string;
}

export interface FetchOutput {
  status: number;
  url: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
  /** Where it was sent after a redirect, so an agent can see the hops. */
  redirects: string[];
}

/**
 * `web.fetch` -- read a public web page.
 *
 * Tier 0: it changes nothing. That makes it the capability most likely to be
 * granted without much thought, which is why the interesting part is what it
 * *cannot* reach rather than what it returns.
 *
 * The body comes back as text and is capped. A role that asked for a hundred
 * megabytes would otherwise get them into the orchestrator's memory and then
 * into a context pack, and neither is a place for them.
 */
export function webFetch(options: WebOptions = {}): Capability<FetchInput, FetchOutput> {
  return {
    name: 'web.fetch',
    adapter: 'platform:web',
    defaultTier: 0,
    async execute(input, ctx) {
      const answer = await safeFetch(String(input.url ?? ''), {
        ...options,
        signal: ctx.signal,
        maxBytes: options.maxBytes ?? 256 * 1024,
        // A real user agent, saying who this is. A capability that pretended
        // to be a browser would be one whose traffic nobody can attribute when
        // it goes wrong, and "an agent did this on behalf of a company" is
        // exactly what the other end deserves to know.
        headers: { 'user-agent': 'PALUGADA/1.0 (+orchestrator)', accept: 'text/*, */*;q=0.6' },
      });
      return {
        status: answer.status,
        url: answer.url,
        contentType: answer.headers['content-type'] ?? null,
        body: answer.body,
        truncated: answer.truncated,
        redirects: answer.redirects,
      };
    },
    describe(input) {
      // F3.4: a policy can say "not that host" only if the capability says
      // which host. Parsed defensively -- an unparseable URL is not a host,
      // and reporting a guess would let a policy match the wrong thing.
      try {
        return { urlHost: new URL(String(input.url ?? '')).hostname };
      } catch {
        return { urlHost: null };
      }
    },
  };
}

export interface UptimeInput {
  url: string;
  /** Statuses the caller considers healthy. Default: anything below 400. */
  expectStatus?: number[];
}

export interface UptimeOutput {
  up: boolean;
  status: number;
  latencyMs: number;
  url: string;
}

/**
 * `uptime.check` -- is it answering?
 *
 * Tier 0, and deliberately not a monitoring product. It answers one question
 * about one URL, which is what a role needs to decide whether to escalate; a
 * platform that grew a scheduler and a history here would be reimplementing
 * F9 badly.
 *
 * A request that fails to connect is `up: false` rather than an exception. A
 * host being down is the answer to the question, not an error in asking it,
 * and a capability that threw would make "the site is down" indistinguishable
 * from "the capability is broken" in every trace that recorded it.
 */
export function uptimeCheck(options: WebOptions = {}): Capability<UptimeInput, UptimeOutput> {
  return {
    name: 'uptime.check',
    adapter: 'platform:web',
    defaultTier: 0,
    async execute(input, ctx) {
      const url = String(input.url ?? '');
      const startedAt = Date.now();
      try {
        const answer = await safeFetch(url, {
          ...options,
          method: 'GET',
          signal: ctx.signal,
          timeoutMs: options.timeoutMs ?? 5_000,
          // A probe wants the status, not the page.
          maxBytes: 1024,
          headers: { 'user-agent': 'PALUGADA/1.0 (+uptime)' },
        });
        const expected = input.expectStatus;
        return {
          up: expected ? expected.includes(answer.status) : answer.status < 400,
          status: answer.status,
          latencyMs: Date.now() - startedAt,
          url: answer.url,
        };
      } catch (error) {
        // Except a refusal to *try*. Being told a URL is inside the network is
        // not a measurement of anything, and reporting it as "down" would hide
        // a misconfiguration behind a plausible answer.
        if (error instanceof PalugadaError && error.code === 'capability.unreachable') throw error;
        return { up: false, status: 0, latencyMs: Date.now() - startedAt, url };
      }
    },
    describe(input) {
      try {
        return { urlHost: new URL(String(input.url ?? '')).hostname };
      } catch {
        return { urlHost: null };
      }
    },
  };
}
