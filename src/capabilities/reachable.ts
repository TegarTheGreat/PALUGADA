/**
 * Where a capability is allowed to send a request (PRD v2 F12.9, F8.7).
 *
 * `web.fetch` is granted to four of the standard company's divisions, and it
 * is the most dangerous-looking innocuous thing in the catalogue: an agent
 * that can name a URL and have this process fetch it is an agent with a
 * request originating *inside* the platform's network. What that reaches, by
 * default, is everything the orchestrator can reach --
 *
 *   - `http://169.254.169.254/latest/meta-data/iam/...`, the cloud metadata
 *     service, which hands out the machine's own credentials to anything that
 *     asks from the machine;
 *   - `http://127.0.0.1:<port>/mcp`, the tool bridge, whose bearer token the
 *     runtime already holds;
 *   - `postgres://` is not HTTP, but `http://127.0.0.1:5432` is enough to
 *     probe for it, and an internal admin panel on a private address is the
 *     ordinary case rather than the exotic one.
 *
 * None of that is a bug in `web.fetch`. It is what fetching a URL means, and
 * it is why the capability has to decide what "the web" is before it goes
 * anywhere. This module is that decision, kept apart from the capabilities
 * that use it so there is exactly one of it.
 *
 * **Resolved, not parsed.** The check is on the IP addresses the hostname
 * actually resolves to, not on how the hostname looks. `localhost` is easy to
 * spot; `metadata.google.internal`, a public name with an `A` record pointing
 * at `169.254.169.254`, and an attacker's own domain resolving to `127.0.0.1`
 * are not. A blocklist of names is a blocklist somebody registers around in an
 * afternoon.
 *
 * **And re-checked after every redirect.** A permitted host answering `302
 * Location: http://169.254.169.254/` is the same attack wearing one extra hop,
 * so redirects are followed by hand with the check applied to each one rather
 * than handed to `fetch` to follow on its own.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PalugadaError } from '../errors.ts';

/**
 * The ranges no capability may reach.
 *
 * Written as prefixes on the address's own bytes rather than as CIDR strings,
 * because a CIDR parser is a thing to get wrong and this list does not change.
 * IPv6 is here for the same reason IPv4 is: a host with an `AAAA` record
 * pointing at `::1` is the same attack, and a check that only looked at IPv4
 * would be one an attacker reaches past by publishing one extra record.
 */
function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;                            // 10/8, private
  if (a === 127) return true;                           // loopback
  if (a === 0) return true;                             // "this network"
  if (a === 169 && b === 254) return true;              // link-local: the metadata service
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16/12, private
  if (a === 192 && b === 168) return true;              // 192.168/16, private
  if (a === 192 && b === 0) return true;                // 192.0.0/24 and 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true;  // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true;    // carrier-grade NAT
  if (a >= 224) return true;                            // multicast and reserved
  return false;
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;       // unspecified, loopback
  if (lower.startsWith('fe80')) return true;                // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // unique local
  if (lower.startsWith('ff')) return true;                  // multicast
  // An IPv4 address wearing an IPv6 hat. `::ffff:169.254.169.254` reaches the
  // metadata service exactly as the bare form does, and a check that stopped
  // at the colon would have let it.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  // Not an address at all. Refused rather than allowed: an unparseable answer
  // is one nobody can reason about.
  return true;
}

export interface ReachableOptions {
  /**
   * Hosts a deployment has decided are fine despite being private.
   *
   * An internal wiki on `10.0.0.5` is a legitimate thing for a company to
   * read, and the platform should not make that impossible -- it should make
   * it a decision somebody wrote down. Matched against the *hostname* as
   * written, because that is what an operator can name; the address check is
   * still run for everything else.
   */
  allowPrivateHosts?: readonly string[];
  /** For a test, which cannot resolve names it does not own. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * Refuses a URL a capability may not send a request to.
 *
 * Throws rather than returning false, because every caller is about to make a
 * request and a boolean is a thing a caller can forget to look at.
 */
export async function assertReachable(
  raw: string,
  options: ReachableOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PalugadaError('capability.unreachable', `${raw} is not a URL`, { url: raw });
  }

  // Only the two web schemes. `file:`, `ftp:` and `gopher:` are all things a
  // fetch implementation somewhere has supported, and `file:///etc/passwd` is
  // the shortest path from "read a web page" to "read the host".
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PalugadaError(
      'capability.unreachable',
      `${url.protocol} is not a scheme this platform will fetch`,
      { url: raw, protocol: url.protocol },
    );
  }

  if ((options.allowPrivateHosts ?? []).includes(url.hostname)) return url;

  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await (options.resolve ?? defaultResolve)(url.hostname).catch(() => []);

  if (addresses.length === 0) {
    throw new PalugadaError(
      'capability.unreachable',
      `${url.hostname} does not resolve`,
      { url: raw },
    );
  }

  // *Every* address, not the first. A hostname with two `A` records -- one
  // public, one loopback -- is a documented way past a checker that stops at
  // the first, because which one the socket ends up using is not this code's
  // choice to make.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new PalugadaError(
        'capability.unreachable',
        `${url.hostname} resolves to ${address}, which is inside this network`,
        { url: raw, address },
      );
    }
  }

  return url;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

export interface SafeFetchOptions extends ReachableOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** How many hops. Zero means a redirect is a refusal. */
  maxRedirects?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface SafeResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  /** Every URL in the chain, so an agent can see where it was sent. */
  redirects: string[];
}

/**
 * One request, with the check applied to every hop.
 *
 * Redirects are followed by hand rather than by `fetch`, which is the whole
 * point: a permitted host answering `302 Location: http://169.254.169.254/` is
 * the same attack with one extra step, and `redirect: 'follow'` would take it
 * without asking anybody.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const redirects: string[] = [];

  let target = await assertReachable(raw, options);
  for (let hop = 0; ; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await doFetch(target.toString(), {
        method: options.method ?? 'GET',
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= maxRedirects) {
        throw new PalugadaError(
          'capability.unreachable',
          `${raw} redirected more than ${maxRedirects} times`,
          { url: raw },
        );
      }
      // Resolved against the current URL, because a `Location` may be
      // relative -- and then checked again, because that is the point.
      const next = new URL(location, target).toString();
      redirects.push(next);
      target = await assertReachable(next, options);
      continue;
    }

    // Bounded on the way in. A capability that read an unbounded response into
    // memory would be a capability an agent can use to exhaust the
    // orchestrator by naming a large file.
    const raw_body = await readBounded(response, maxBytes);
    return {
      status: response.status,
      url: target.toString(),
      headers: Object.fromEntries(response.headers),
      body: raw_body.text,
      truncated: raw_body.truncated,
      redirects,
    };
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf8');
  let text = '';
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        text += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - (size - maxBytes))));
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Cancelled rather than left draining: the point of the cap is not to keep
    // reading, and a stream nobody cancels keeps the socket open.
    await reader.cancel().catch(() => undefined);
  }
  return { text, truncated };
}
