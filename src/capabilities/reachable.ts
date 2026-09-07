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

/**
 * Expands an IPv6 address into its sixteen bytes.
 *
 * Written out because the alternative is comparing strings, and an IPv6
 * address has many spellings of the same value: `::ffff:127.0.0.1` and
 * `::ffff:7f00:1` are the same address, `fe80::1` and `fe90::1` are both
 * link-local, and `0:0:0:0:0:0:0:1` is loopback. A prefix match on the text
 * catches the spelling somebody thought of and misses the rest -- which is not
 * a hypothetical: the first version of this file matched `fe80` as a string
 * and let `fe90::1` through, and matched the dotted mapped form and let the
 * hex one through. Both reach loopback.
 */
export function ipv6Bytes(address: string): Uint8Array | null {
  let text = address.toLowerCase().split('%')[0]!;

  // A trailing dotted quad -- the `::ffff:1.2.3.4` form -- becomes two groups.
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const quad = dotted[1]!.split('.').map(Number);
    if (quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const [a, b, c, d] = quad as [number, number, number, number];
    text = text.slice(0, -dotted[1]!.length)
      + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const groups = [
    ...head,
    ...Array.from({ length: 8 - head.length - tail.length }, () => '0'),
    ...tail,
  ];

  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function isPrivateV6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  // Unparseable is refused, like everything else this cannot reason about.
  if (bytes === null) return true;

  const [b0, b1] = bytes as unknown as [number, number];

  // Unspecified and loopback: fifteen zero bytes, then 0 or 1.
  if (bytes.slice(0, 15).every((byte) => byte === 0)) return bytes[15]! <= 1;

  // fe80::/10 -- link-local, and the range is fe80 to febf rather than the
  // `fe80` a prefix match sees.
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  // fc00::/7 -- unique local.
  if ((b0 & 0xfe) === 0xfc) return true;
  // ff00::/8 -- multicast.
  if (b0 === 0xff) return true;

  // An IPv4 address wearing an IPv6 hat. `::ffff:169.254.169.254` reaches the
  // metadata service exactly as the bare form does, whichever way it is
  // spelled -- and it is spelled both ways in the wild.
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return isPrivateV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  // 64:ff9b::/96 -- NAT64, which translates to an IPv4 address that may itself
  // be private. Same argument as the mapped form.
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPrivateV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

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

/**
 * Headers that must not follow a redirect to somewhere else.
 *
 * The reachability check stops a redirect reaching *inside* this network. It
 * does nothing about a redirect to another public host, which is fine for a
 * page and is not fine for a request carrying a division's bearer token: a
 * vendor answering `302 Location: https://attacker.example/` would be handed a
 * live credential, and the capability that sent it believes -- because its own
 * comment says so -- that a header does not travel.
 *
 * Dropped on any hop that changes origin, which is what browsers and `curl`
 * do and for the same reason. Matched case-insensitively because a header name
 * is, and an attacker who can choose the spelling should not be able to choose
 * the outcome.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
]);

function stripSensitive(
  headers: Record<string, string>,
  from: URL,
  to: URL,
): Record<string, string> {
  if (from.origin === to.origin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())),
  );
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
  let headers = options.headers ?? {};
  let method = options.method ?? 'GET';
  let body = options.body;

  for (let hop = 0; ; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // The timer and the listener are released only once the *body* has been
    // read, not when the headers arrive. Clearing them at the end of the fetch
    // call was the natural place and the wrong one: a server that sends
    // headers immediately and then trickles the body forever would have had no
    // deadline at all, and `ctx.signal` -- the engine withdrawing the run --
    // would have stopped reaching it. A slow-body stall is the classic way to
    // hold a fetching process open, and it is cheaper to mount than a slow
    // handshake because the connection already looks healthy.
    try {
      const response = await doFetch(target.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: controller.signal,
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= maxRedirects) {
          throw new PalugadaError(
            'capability.unreachable',
            `${raw} redirected more than ${maxRedirects} times`,
            { url: raw },
          );
        }
        // The body of a redirect is nothing anybody wants, and leaving it
        // undrained holds the socket.
        await response.body?.cancel().catch(() => undefined);
        // Resolved against the current URL, because a `Location` may be
        // relative -- and then checked again, because that is the point.
        const next = new URL(location, target);

        // A request with a side effect does not get replayed somewhere else.
        // `307` and `308` mean "repeat exactly", and repeating a POST at a
        // host the caller never named is a second real action against a
        // stranger. `301`, `302` and `303` mean "go and GET instead", which is
        // what every client does and is what happens here.
        if (method !== 'GET' && method !== 'HEAD') {
          if (response.status === 307 || response.status === 308) {
            throw new PalugadaError(
              'capability.unreachable',
              `${raw} answered ${response.status} for a ${method}: this platform will not `
                + 'repeat a side effect at a redirected address',
              { url: raw, status: response.status },
            );
          }
          method = 'GET';
          body = undefined;
        }

        // The credential does not follow a redirect off the host it was for.
        // See `SENSITIVE_HEADERS`: this is the one thing the reachability
        // check does not cover, because the other end of a redirect can be a
        // perfectly ordinary public host that simply is not the vendor.
        headers = stripSensitive(headers, target, next);

        redirects.push(next.toString());
        target = await assertReachable(next.toString(), options);
        continue;
      }

      // Bounded on the way in. A capability that read an unbounded response
      // into memory would be a capability an agent can use to exhaust the
      // orchestrator by naming a large file.
      const answer = await readBounded(response, maxBytes);
      return {
        status: response.status,
        url: target.toString(),
        headers: Object.fromEntries(response.headers),
        body: answer.text,
        truncated: answer.truncated,
        redirects,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
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
