/**
 * Where a company's browser may go: a proxy of the platform's own that every
 * request Chromium makes passes through (F12.9).
 *
 * A browser is not one request but hundreds -- a page's pictures, scripts,
 * the requests its scripts make, redirects, frames -- and any of them can
 * name `http://169.254.169.254/` or an address on the platform's own
 * network. Checking the address a role asked for and letting Chromium fetch
 * the rest would check one request in a hundred. So each company's browser
 * is given this proxy, with no exception for loopback, and Chromium is told
 * to resolve no name itself: every request arrives here by name and is held
 * to `reachable.ts`, the same rules `web.fetch` is held to, and connected to
 * the address that was checked rather than whatever the name resolves to a
 * moment later.
 *
 * HTTPS arrives as CONNECT and goes on as a tunnel this proxy does not open
 * -- the page's encryption is between Chromium and the site -- and plain
 * HTTP as a request it forwards. A refusal is kept for a few minutes by the
 * host it named, so the browser can say why a page did not open rather than
 * show Chromium's own error.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { assertReachable, type ReachableOptions } from '../capabilities/reachable.ts';

export interface Egress {
  /** The proxy, as Chromium is told it: `http://127.0.0.1:<port>`. */
  readonly server: string;
  /** Why a request to the URL's host was refused, if one was at or after `since` and in the last few minutes. */
  refusalFor(url: string, since?: number): string | null;
  close(): Promise<void>;
}

/** Headers that are about one hop, not the request: dropped on the way through, as every proxy does. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

/** How long a refusal is remembered, and how many at most. */
const REFUSAL_MS = 5 * 60_000;
const REFUSALS_KEPT = 500;

/** A connection with nothing moving for this long is closed. */
const IDLE_MS = 120_000;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (one) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[one]!);
}

function hostOf(url: URL): string {
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

export async function startEgress(options: ReachableOptions = {}): Promise<Egress> {
  const refusals = new Map<string, { reason: string; at: number }>();
  const open = new Set<Duplex>();
  const remember = (host: string, reason: string) => {
    refusals.delete(host);
    refusals.set(host, { reason, at: Date.now() });
    if (refusals.size > REFUSALS_KEPT) refusals.delete(refusals.keys().next().value!);
  };
  const track = (socket: Duplex) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    if ('setTimeout' in socket) (socket as Socket).setTimeout(IDLE_MS, () => socket.destroy());
  };

  const forward = async (req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new Error('not an http URL');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('a proxy request names a whole http:// URL');
      return;
    }
    let address: string | null;
    try {
      address = (await assertReachable(target.toString(), options)).address;
    } catch (refusal) {
      const reason = (refusal as Error).message;
      remember(hostOf(target), reason);
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Not opened</title><p>PALUGADA did not open this page: ${escapeHtml(reason)}</p>`);
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
    }
    headers.host = target.host;
    const upstream = httpRequest({
      host: address ?? target.hostname,
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (answer) => {
      const raw: string[] = [];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.has(answer.rawHeaders[i]!.toLowerCase())) raw.push(answer.rawHeaders[i]!, answer.rawHeaders[i + 1]!);
      }
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage ?? '', raw);
      answer.pipe(res);
    });
    upstream.setTimeout(IDLE_MS, () => upstream.destroy(new Error('the site stopped answering')));
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`the site could not be reached: ${error.message}`);
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  };

  const server = createServer((req, res) => { void forward(req, res); });

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    void (async () => {
      let target: URL;
      try {
        target = new URL(`https://${req.url ?? ''}`);
      } catch {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      let address: string | null;
      try {
        address = (await assertReachable(`https://${target.host}/`, options)).address;
      } catch (refusal) {
        remember(hostOf(target), (refusal as Error).message);
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = connect({ host: address ?? target.hostname, port: Number(target.port || 443) });
      track(upstream);
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => {
        if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        client.destroy();
      });
      client.once('close', () => upstream.destroy());
    })();
  });

  // Chromium tunnels a WebSocket through CONNECT, plain or not; an upgrade
  // asked of the proxy itself is not something it sends.
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
  });
  server.on('connection', (socket: Socket) => track(socket));
  server.on('clientError', (_error, socket: Duplex) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the browser\'s proxy has no port');

  return {
    server: `http://127.0.0.1:${address.port}`,
    refusalFor(url, since = 0) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      const found = refusals.get(hostOf(parsed));
      return found && found.at >= since && Date.now() - found.at < REFUSAL_MS ? found.reason : null;
    },
    async close() {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
