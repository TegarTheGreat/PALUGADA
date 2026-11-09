/**
 * The reference relay for PALUGADA's relay protocol v1 (docs/relay-protocol.md;
 * PRD F19.19, F19.20; STATUS section 2.208).
 *
 *   npm run relay:reference -- serve --deployment-fingerprint <24 characters> [--port 8790] [--host 127.0.0.1]
 *                                    [--public-url https://relay.example] [--state relay-state.json] [--name "My relay"]
 *   npm run relay:reference -- link <code>              the code PALUGADA showed under Link a phone
 *   npm run relay:reference -- press <token> [answer]   a button from a notice this relay printed
 *   npm run relay:reference -- reply <token> <text>
 *
 * The supported way to put PALUGADA's notices on a phone until a hosted relay
 * exists: it verifies every envelope against the deployment's pinned key,
 * prints it, drops what a retraction names, and forwards each notice's `text`
 * and `link` to ntfy (`RELAY_NTFY_URL`, one topic per recipient, with
 * `Authorization: Bearer $RELAY_NTFY_TOKEN` when set). ntfy.sh topics are
 * public to anyone who guesses their name: use a self-hosted or
 * token-protected ntfy for any share above `signal`.
 *
 * It does not trust on first use. It pairs only with the deployment whose
 * fingerprint its operator gives it, and once paired it takes no other
 * pairing until its state file is deleted by hand. It is pulled from, so it
 * works where the deployment cannot be reached. It keeps one device key per
 * linked phone and signs every act with it, as a phone's own app would.
 *
 * Written apart from `src/relay/`, with its own canonical JSON and checks and
 * no dependency beyond Node, so that it is a second implementation of the
 * protocol document rather than a copy of the first.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

const TOLERANCE_SECONDS = 300;
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PRIORITY: Record<string, string> = { interrupt: '5', normal: '3', quiet: '2' };

/* ------------------------------------------------------------ the protocol --- */

/** RFC 8785 canonical JSON, as the protocol document states it. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('a number that is not finite has no canonical form');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new Error(`${typeof value} is not JSON`);
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

const fingerprintOf = (raw: Buffer) => base32(createHash('sha256').update(raw).digest()).slice(0, 24);
const privateFrom = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
const publicFrom = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const rawOf = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url');
const newSeed = () => Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }).d!, 'base64url');

/** `v1a,<base64>` over `<id>.<timestamp>.<payload>`. */
function signed(seed: Buffer, id: string, timestamp: string, payload: string): string {
  return `v1a,${sign(null, Buffer.from(`${id}.${timestamp}.${payload}`, 'utf8'), privateFrom(seed)).toString('base64')}`;
}

/** Whether any `v1a` signature in the header verifies with any of the keys. */
function verified(header: string, keys: readonly string[], id: string, timestamp: string, payload: string): boolean {
  const content = Buffer.from(`${id}.${timestamp}.${payload}`, 'utf8');
  return header.split(' ').some((part) => part.startsWith('v1a,') && keys.some((key) => {
    try {
      return verify(null, content, publicFrom(Buffer.from(key, 'base64url')), Buffer.from(part.slice(4), 'base64'));
    } catch {
      return false;
    }
  }));
}

const fresh = (timestamp: string) => /^\d{1,12}$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= TOLERANCE_SECONDS;

/* ------------------------------------------------------------------ state --- */

interface State {
  /** This relay's own key, as its seed. */
  seed: string;
  /** The deployment it is paired with, and the keys it accepts from it; null until paired. */
  paired: { deployment: string; relay: string; keys: Array<{ key: string; until: string | null }> } | null;
  /** Device keys, by the claim that made them and then by the recipient the deployment confirmed. */
  claims: Record<string, string>;
  devices: Record<string, string>;
}

export interface ReferenceRelayOptions {
  port?: number;
  host?: string;
  /** The deployment's fingerprint, as its owner reads it from Settings, Relays: the only deployment this relay pairs with. */
  deploymentFingerprint: string;
  /** Where this relay is reached; `http://<host>:<port>` unless given. */
  publicUrl?: string;
  name?: string;
  /** Kept across starts when given: the relay's key, the pairing, the devices. */
  stateFile?: string;
  ntfy?: { url: string; token?: string };
  /** Prints nothing: for a test. */
  quiet?: boolean;
}

export interface ReferenceRelay {
  url: string;
  fingerprint: string;
  link(code: string, label?: string): Promise<void>;
  press(token: string, answer?: string): Promise<void>;
  reply(token: string, text: string): Promise<void>;
  /** Every envelope it took, retracted content dropped. */
  received(): Array<Record<string, any>>;
  /** How many envelopes it refused. */
  refused(): number;
  close(): Promise<void>;
}

/** Starts the relay. */
export async function startReferenceRelay(options: ReferenceRelayOptions): Promise<ReferenceRelay> {
  const pinned = options.deploymentFingerprint.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{24}$/.test(pinned)) {
    throw new Error('--deployment-fingerprint is the 24 characters the owner reads in PALUGADA under Settings, Relays');
  }
  const say = (line: string) => {
    if (!options.quiet) process.stdout.write(`${line}\n`);
  };
  const state: State = options.stateFile && existsSync(options.stateFile)
    ? JSON.parse(readFileSync(options.stateFile, 'utf8')) as State
    : { seed: newSeed().toString('hex'), paired: null, claims: {}, devices: {} };
  const save = () => {
    if (options.stateFile) writeFileSync(options.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  };
  save();
  const seed = Buffer.from(state.seed, 'hex');
  const publicKey = rawOf(privateFrom(seed));
  const kept: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  /** The deployment's own tokens, by the recipient they were offered to. */
  const offeredTo = new Map<string, string>();
  const inbox: Array<{ id: string; timestamp: string; signature: string; body: string }> = [];
  let refusals = 0;
  let warned = false;
  let base = options.publicUrl?.replace(/\/$/, '') ?? '';

  /** The deployment's keys this relay accepts now: the pinned one, and one rotated out until its week ends. */
  const keys = () => (state.paired?.keys ?? []).filter((one) => one.until === null || new Date(one.until) > new Date()).map((one) => one.key);

  /** An act for the deployment to pull: signed by this relay, and by the device of the link it is for. */
  const queue = (body: Record<string, unknown>) => {
    const text = canonical(body);
    const id = `in_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    inbox.push({ id, timestamp, signature: signed(seed, id, timestamp, text), body: text });
    return id;
  };
  const deviceAct = (
    type: string, token: string, body: Record<string, unknown>, signedToo: Record<string, unknown>, words: string | null,
  ) => {
    if (!state.paired) throw new Error('not paired yet');
    const recipient = offeredTo.get(token);
    if (!recipient) throw new Error('this relay was never sent that token');
    const device = state.devices[recipient];
    const at = new Date().toISOString();
    const sha256 = words === null ? undefined : createHash('sha256').update(words, 'utf8').digest('hex');
    const fields = { deployment: state.paired.deployment, relay: state.paired.relay, recipient, type, token, at, sha256, ...signedToo };
    const device_sig = device
      ? sign(null, Buffer.from(`palugada-device/v1\n${canonical(fields)}`, 'utf8'), privateFrom(Buffer.from(device, 'hex'))).toString('base64url')
      : undefined;
    queue({ v: 1, type, at, token, ...body, device_sig });
  };

  const forward = async (envelope: Record<string, any>) => {
    if (!options.ntfy || typeof envelope.text !== 'string' || !envelope.to?.recipient) return;
    if (envelope.share !== 'signal' && !options.ntfy.token && !warned) {
      warned = true;
      say('warning: this relay is told more than that something happened, and ntfy has no token: anyone who guesses a topic reads it');
    }
    await fetch(`${options.ntfy.url.replace(/\/$/, '')}/palugada-${String(envelope.to.recipient).toLowerCase()}`, {
      method: 'POST',
      headers: {
        priority: PRIORITY[envelope.urgency] ?? '3',
        ...(envelope.link ? { click: envelope.link } : {}),
        ...(options.ntfy.token ? { authorization: `Bearer ${options.ntfy.token}` } : {}),
      },
      body: envelope.text,
    }).catch((error: unknown) => say(`ntfy did not take it: ${(error as Error).message}`));
  };

  const refuse = (res: ServerResponse, status: number, why: string) => {
    refusals += 1;
    say(`refused (${status}): ${why}`);
    reply(res, status, { ok: false, error: why });
  };

  const envelopes = async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const id = header(req, 'webhook-id');
    const timestamp = header(req, 'webhook-timestamp');
    const signature = header(req, 'webhook-signature');
    let envelope: Record<string, any>;
    try {
      envelope = JSON.parse(body) as Record<string, any>;
    } catch {
      return refuse(res, 400, 'not JSON');
    }
    if (envelope.type === 'pair_request') {
      if (state.paired) return refuse(res, 409, 'already paired: delete the state file by hand to pair again');
      const key = String(envelope.key ?? '');
      if (fingerprintOf(Buffer.from(key, 'base64url')) !== pinned) return refuse(res, 403, 'not the deployment this relay was told to pair with');
      if (!verified(signature, [key], id, timestamp, body) || !fresh(timestamp)) return refuse(res, 401, 'pairing request not signed by its own key, now');
      state.paired = { deployment: String(envelope.deployment), relay: String(envelope.relay), keys: [{ key, until: null }] };
      save();
      const accept = canonical({ pair_accept: { request: envelope.id, deployment: envelope.deployment, relay: envelope.relay, at: new Date().toISOString() } });
      const answerId = `ac_${randomUUID()}`;
      const answerAt = String(Math.floor(Date.now() / 1000));
      say(`paired with deployment ${envelope.deployment}`);
      res.writeHead(200, {
        'content-type': 'application/json', 'webhook-id': answerId, 'webhook-timestamp': answerAt,
        'webhook-signature': signed(seed, answerId, answerAt, accept),
      });
      res.end(accept);
      return;
    }
    if (!state.paired) return refuse(res, 401, 'not paired');
    if (!verified(signature, keys(), id, timestamp, body)) return refuse(res, 401, 'not signed by the deployment');
    if (!fresh(timestamp)) return refuse(res, 408, 'not signed now');
    // What the deployment signed is canonical, so a relay that forwards it can prove it again.
    if (canonical(envelope) !== body) return refuse(res, 400, 'not canonical JSON');
    if (envelope.deployment !== state.paired.deployment || envelope.relay !== state.paired.relay) return refuse(res, 403, 'another deployment, or another pairing');
    if (seen.has(id)) return reply(res, 200, { ok: true, duplicate: true });
    seen.add(id);
    switch (envelope.type) {
      case 'keys_rotated':
        // Signed by the key already pinned, which stands for the week the deployment gives it.
        state.paired.keys = [{ key: String(envelope.key), until: null },
          ...(envelope.previous ? [{ key: String(envelope.previous.key), until: String(envelope.previous.until) }] : [])];
        save();
        say(`the deployment's key is now ${envelope.kid}`);
        break;
      case 'link_confirmed': {
        const device = state.claims[envelope.data?.claim];
        if (device) {
          state.devices[envelope.to.recipient] = device;
          delete state.claims[envelope.data.claim];
          save();
        }
        break;
      }
      case 'inbox_closed':
      case 'room_activity_retracted':
        // What a retraction names is dropped, not kept beside it.
        for (const one of kept) {
          if (one.id === envelope.data?.ref || (envelope.data?.refs ?? []).includes(one.id)) {
            delete one.text;
            delete one.data;
            one.offers = [];
          }
        }
        break;
      default:
        break;
    }
    for (const offer of envelope.offers ?? []) offeredTo.set(offer.token, envelope.to?.recipient);
    kept.push(envelope);
    say(`${envelope.type}${envelope.to ? ` for ${envelope.to.recipient}` : ''}: ${envelope.text ?? ''}${envelope.link ? ` (${envelope.link})` : ''}`);
    for (const offer of envelope.offers ?? []) say(`  ${offer.label}: npm run relay:reference -- press ${offer.token}`);
    await forward(envelope);
    reply(res, 200, { ok: true });
  };

  const pull = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const id = header(req, 'webhook-id');
    const timestamp = header(req, 'webhook-timestamp');
    if (!state.paired || !verified(header(req, 'webhook-signature'), keys(), id, timestamp, `GET ${url.pathname}${url.search}`) || !fresh(timestamp)) {
      return refuse(res, 401, 'an inbox is read by the paired deployment only');
    }
    const after = Number(url.searchParams.get('after') ?? '0') || 0;
    const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 25);
    const until = Date.now() + wait * 1000;
    while (inbox.length <= after && Date.now() < until && !req.destroyed) await new Promise((resolve) => setTimeout(resolve, 200));
    const answer = inbox.slice(after, after + 100);
    reply(res, 200, { envelopes: answer, cursor: String(after + answer.length) });
  };

  const local = (req: IncomingMessage, res: ServerResponse, path: string, body: string) => {
    // A person's acts, from this machine only: what a phone's app would send.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return refuse(res, 403, 'acts come from this machine');
    try {
      const given = JSON.parse(body || '{}') as Record<string, string>;
      if (path === '/local/link') {
        const device = newSeed();
        const id = queue({ v: 1, type: 'link_claim', at: new Date().toISOString(), code: given.code, label: given.label ?? 'Reference relay',
          device_key: rawOf(privateFrom(device)).toString('base64url') });
        state.claims[id] = device.toString('hex');
        save();
      } else if (path === '/local/press') {
        const answer = given.answer ?? null;
        deviceAct('press', given.token!, answer === null ? {} : { answer }, {}, answer);
      } else if (path === '/local/reply') {
        const clientId = randomUUID();
        deviceAct('reply', given.token!, { body: given.text, clientId }, { clientId }, given.text ?? '');
      } else {
        return reply(res, 404, { ok: false });
      }
      reply(res, 200, { ok: true });
    } catch (error) {
      reply(res, 400, { ok: false, error: (error as Error).message });
    }
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 65_536) chunks.push(chunk);
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://relay');
      const body = Buffer.concat(chunks).toString('utf8');
      void (async () => {
        if (size > 65_536) return refuse(res, 413, 'too large');
        if (req.method === 'GET' && url.pathname === '/.well-known/palugada-relay') {
          return reply(res, 200, {
            v: 1, relay: options.name ?? 'PALUGADA reference relay', key: publicKey.toString('base64url'), versions: [1],
            envelopes: `${base}/v1/envelopes`, inbox: `${base}/v1/inbox`, modes: ['pull'], features: ['press', 'reply', 'device-keys'],
          });
        }
        if (req.method === 'POST' && url.pathname === '/v1/envelopes') return envelopes(req, res, body);
        if (req.method === 'GET' && url.pathname === '/v1/inbox') return pull(req, res, url);
        if (req.method === 'POST' && url.pathname.startsWith('/local/')) return local(req, res, url.pathname, body);
        reply(res, 404, { ok: false });
      })().catch((error: unknown) => reply(res, 500, { ok: false, error: (error as Error).message }));
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 8790, host, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the relay has no port');
  if (!base) base = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  say(`PALUGADA reference relay at ${base}; its fingerprint is ${fingerprintOf(publicKey).replace(/(.{4})(?!$)/g, '$1 ')}`);
  if (options.ntfy && !options.ntfy.token) {
    say('warning: RELAY_NTFY_TOKEN is not set; keep the relay at the signal share, or use a self-hosted or token-protected ntfy');
  }

  const act = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', body: JSON.stringify(body) });
    const answer = await response.json() as { ok: boolean; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? `the relay answered ${response.status}`);
  };
  return {
    url: base,
    fingerprint: fingerprintOf(publicKey),
    link: (code, label) => act('/local/link', { code, ...(label ? { label } : {}) }),
    press: (token, answer) => act('/local/press', { token, ...(answer === undefined ? {} : { answer }) }),
    reply: (token, text) => act('/local/reply', { token, text }),
    received: () => kept.slice(),
    refused: () => refusals,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(' ') : value ?? '';
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* -------------------------------------------------------------------- CLI --- */

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const port = Number(flag(rest, 'port') ?? process.env.RELAY_PORT ?? 8790);
  if (command === 'serve') {
    const fingerprint = flag(rest, 'deployment-fingerprint') ?? process.env.RELAY_DEPLOYMENT_FINGERPRINT;
    if (!fingerprint) throw new Error('--deployment-fingerprint is required: the 24 characters PALUGADA shows under Settings, Relays');
    await startReferenceRelay({
      port,
      deploymentFingerprint: fingerprint,
      host: flag(rest, 'host') ?? '127.0.0.1',
      stateFile: flag(rest, 'state') ?? 'relay-state.json',
      ...(flag(rest, 'public-url') ? { publicUrl: flag(rest, 'public-url')! } : {}),
      ...(flag(rest, 'name') ? { name: flag(rest, 'name')! } : {}),
      ...(process.env.RELAY_NTFY_URL
        ? { ntfy: { url: process.env.RELAY_NTFY_URL, ...(process.env.RELAY_NTFY_TOKEN ? { token: process.env.RELAY_NTFY_TOKEN } : {}) } }
        : {}),
    });
    return;
  }
  const positional = rest.filter((one, index) => !one.startsWith('--') && !rest[index - 1]?.startsWith('--'));
  const paths: Record<string, [string, Record<string, unknown>]> = {
    link: ['/local/link', { code: positional[0] }],
    press: ['/local/press', { token: positional[0], ...(positional[1] !== undefined ? { answer: positional.slice(1).join(' ') } : {}) }],
    reply: ['/local/reply', { token: positional[0], text: positional.slice(1).join(' ') }],
  };
  const chosen = command ? paths[command] : undefined;
  if (!chosen || !positional[0]) {
    throw new Error('usage: serve --deployment-fingerprint <fingerprint> | link <code> | press <token> [answer] | reply <token> <text>');
  }
  const response = await fetch(`http://127.0.0.1:${port}${chosen[0]}`, { method: 'POST', body: JSON.stringify(chosen[1]) });
  process.stdout.write(`${await response.text()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`relay: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
