/**
 * A relay a test controls, for the relay protocol (F19.19, F19.20; STATUS
 * section 2.208): its well-known document, its envelopes endpoint and its
 * inbox for pull mode, each on loopback HTTP, with what it answers left to the
 * test. The reference relay (`scripts/relay-reference.ts`) is the honest one;
 * this one can be slow, fail, forget the deployment, or answer a pairing for
 * another one, which is what the refusals are tested against.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { jcs } from '../../src/relay/canonical.ts';
import { fingerprint, rawPublicKey, signV1a } from '../../src/relay/signature.ts';

/** One envelope as it reached the relay: the headers, the bytes, and the bytes read. */
export interface Received {
  id: string;
  timestamp: string;
  signature: string;
  key: string;
  version: string;
  contentType: string;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  envelope: any;
}

/** An envelope the relay signed for the deployment, as a pull answers it or a push posts it. */
export interface Signed {
  id: string;
  timestamp: string;
  signature: string;
  body: string;
}

export interface FakeRelayOptions {
  /** The envelopes and inbox addresses name another host than the relay's own. */
  otherHost?: boolean;
  /** No inbox: a relay that can only be pushed from. */
  noInbox?: boolean;
  /** What the envelopes endpoint answers each envelope; 200 with nothing unless the test says. */
  answer?: (received: Received, index: number) => { status: number; body?: unknown; delayMs?: number } | undefined;
  /** What the relay accepts a pairing with, in place of the honest accept: to forge one. */
  accept?: (request: Received) => Record<string, unknown>;
  /** Signs the accept with this key instead of the relay's own. */
  acceptKey?: KeyObject;
}

export interface FakeRelay {
  url: string;
  /** The relay's public key, raw, and its fingerprint as the operator would show it. */
  publicKey: Buffer;
  fingerprint: string;
  /** Every envelope it was sent, pairing requests included. */
  received: Received[];
  /** What the deployment pulls next, and every pull it made with the headers it signed. */
  inbox: Signed[];
  pulls: Array<{ path: string; id: string; timestamp: string; signature: string }>;
  /** Signs an inbound envelope's body with the relay's key, as a push or a pull carries it. */
  sign: (body: Record<string, unknown>, options?: { id?: string; at?: Date; key?: KeyObject }) => Signed;
  /** Posts a signed envelope to the deployment's inbound route for this relay (push mode). */
  push: (apiUrl: string, relayId: string, signed: Signed, options?: { headers?: Record<string, string> }) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

const SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 key a test can sign with, as a device or a relay makes one. */
export function deviceKey(): { privateKey: KeyObject; publicKey: Buffer } {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: rawPublicKey(pair.publicKey) };
}

/** The same, from a seed, so a vector can name it. */
export function keyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([SEED_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** What a device signs for an act: the protocol's device form (docs/relay-protocol.md). */
export function deviceSignature(key: KeyObject, fields: Record<string, unknown>): string {
  const message = Buffer.from(`palugada-device/v1\n${jcs(fields)}`, 'utf8');
  return sign(null, message, key).toString('base64url');
}

/** The hex SHA-256 of a text, as the device form names an answer's or a reply's words. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function fakeRelay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = rawPublicKey(pair.publicKey);
  const received: Received[] = [];
  const inbox: Signed[] = [];
  const pulls: FakeRelay['pulls'] = [];
  let base = '';

  const signed = (body: Record<string, unknown>, given: { id?: string; at?: Date; key?: KeyObject } = {}): Signed => {
    const text = jcs(body);
    const id = given.id ?? `in_${randomUUID()}`;
    const timestamp = String(Math.floor((given.at ?? new Date()).getTime() / 1000));
    return { id, timestamp, signature: signV1a([given.key ?? pair.privateKey], id, timestamp, text), body: text };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', base);
        const header = (name: string) => String(req.headers[name] ?? '');
        if (req.method === 'GET' && url.pathname === '/.well-known/palugada-relay') {
          const elsewhere = options.otherHost ? 'https://elsewhere.example' : base;
          json(res, 200, {
            v: 1, relay: 'Test relay', key: publicKey.toString('base64url'), versions: [1],
            envelopes: `${elsewhere}/v1/envelopes`,
            ...(options.noInbox ? {} : { inbox: `${elsewhere}/v1/inbox` }),
            modes: options.noInbox ? ['push'] : ['push', 'pull'],
            features: ['press', 'reply', 'read', 'device-keys'],
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v1/inbox') {
          pulls.push({ path: `${url.pathname}${url.search}`, id: header('webhook-id'), timestamp: header('webhook-timestamp'), signature: header('webhook-signature') });
          const after = Number(url.searchParams.get('after') ?? '0') || 0;
          const answer = inbox.slice(after);
          json(res, 200, { envelopes: answer, cursor: String(after + answer.length) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/envelopes') {
          const body = Buffer.concat(chunks).toString('utf8');
          let envelope: unknown = null;
          try {
            envelope = JSON.parse(body);
          } catch {
            // Kept as bytes; the test reads what arrived.
          }
          const one: Received = {
            id: header('webhook-id'), timestamp: header('webhook-timestamp'), signature: header('webhook-signature'),
            key: header('palugada-key'), version: header('palugada-relay-version'), contentType: header('content-type'),
            body, envelope,
          };
          received.push(one);
          if ((envelope as { type?: string } | null)?.type === 'pair_request') {
            const request = envelope as { id: string; deployment: string; relay: string };
            const accept = options.accept?.(one)
              ?? { pair_accept: { request: request.id, deployment: request.deployment, relay: request.relay, at: new Date().toISOString() } };
            const answer = signed(accept, { key: options.acceptKey ?? pair.privateKey });
            res.writeHead(200, {
              'content-type': 'application/json',
              'webhook-id': answer.id, 'webhook-timestamp': answer.timestamp, 'webhook-signature': answer.signature,
            });
            res.end(answer.body);
            return;
          }
          const decided = options.answer?.(one, received.length - 1);
          if (decided?.delayMs) await new Promise((resolve) => setTimeout(resolve, decided.delayMs));
          json(res, decided?.status ?? 200, decided?.body ?? { ok: true });
          return;
        }
        json(res, 404, { error: 'not here' });
      })().catch(() => {
        if (!res.headersSent) json(res, 500, { error: 'the fake relay failed' });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake relay has no port');
  base = `http://127.0.0.1:${address.port}`;

  return {
    url: base,
    publicKey,
    fingerprint: fingerprint(publicKey),
    received,
    inbox,
    pulls,
    sign: signed,
    push: async (apiUrl, relayId, one, given = {}) => {
      const response = await fetch(`${apiUrl}/api/relay/v1/relays/${relayId}/inbound`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': one.id, 'webhook-timestamp': one.timestamp, 'webhook-signature': one.signature,
          ...given.headers,
        },
        body: one.body,
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: kept as the text it was.
      }
      return { status: response.status, body };
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
