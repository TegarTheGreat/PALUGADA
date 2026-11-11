/**
 * The reference relay for PALUGADA's relay protocol v1 (docs/relay-protocol.md;
 * PRD F19.19, F19.20; STATUS sections 2.208 and 2.216).
 *
 *   npm run relay:reference -- serve --deployment-fingerprint <24 characters> [--port 8790] [--host 127.0.0.1]
 *                                    [--local-port 8791] [--public-url https://relay.example] [--state relay-state.json]
 *                                    [--name "My relay"] [--print-content]
 *   npm run relay:reference -- link <code>              the code PALUGADA showed under Link a phone
 *   npm run relay:reference -- press <token> [answer]   a button from a notice this relay printed
 *   npm run relay:reference -- reply <token> <text>      words back into the room a notice named
 *   npm run relay:reference -- read <token>              that notice read, on every device
 *   npm run relay:reference -- mute <token> [hours]      its room quiet for so long (8 unless said)
 *   npm run relay:reference -- rotate-key                a new key for this relay, announced to the deployment
 *
 * The supported way to put PALUGADA's notices on a phone until a hosted relay
 * exists: it verifies every envelope against the deployment's pinned key,
 * drops what a retraction names and anything older than a fortnight, and
 * forwards each notice's `text` and `link` to ntfy (`RELAY_NTFY_URL`, one
 * topic per recipient, with `Authorization: Bearer $RELAY_NTFY_TOKEN` when
 * set). ntfy.sh topics are public to anyone who guesses their name: use a
 * self-hosted or token-protected ntfy for any share above `signal`.
 *
 * It does not trust on first use. It pairs only with the deployment whose
 * fingerprint its operator gives it, and once paired it takes no other
 * pairing until its state file is deleted by hand, except the same
 * deployment and pairing again under a new fingerprint its operator gave it.
 * It is pulled from, so it works where the deployment cannot be reached. It
 * keeps what it must across restarts -- its keys, the pairing, its inbox and
 * cursor, the tokens it was sent (as hashes), the envelopes it has seen --
 * in its state file, written whole each time. It keeps one device key per
 * linked phone and signs every act with it, as a phone's own app would:
 * those device keys live here, in the state file, so a link made through
 * this relay is only as safe as that file. It prints what it was told only
 * as far as `signal` unless `--print-content` is given, since whatever keeps
 * its output keeps what it prints. The acts it signs are taken only on a
 * listener of their own, on this machine's loopback.
 *
 * Written apart from `src/relay/`, with its own canonical JSON and checks and
 * no dependency beyond Node, so that it is a second implementation of the
 * protocol document rather than a copy of the first.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

const TOLERANCE_SECONDS = 300;
/** How long anything a deployment told is kept, from the envelope's `at` (docs/relay-protocol.md, section 10). */
const KEPT_DAYS = 14;
const DAY_MS = 86_400_000;
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PRIORITY: Record<string, string> = { interrupt: '5', normal: '3', quiet: '2' };
/** What of an envelope says only where it went: everything else is content, which a retraction or its fortnight drops. */
const ADDRESS = new Set(['v', 'id', 'type', 'at', 'deployment', 'relay', 'to']);

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
const grouped = (fingerprint: string) => fingerprint.replace(/(.{4})(?!$)/g, '$1 ');
const privateFrom = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
const publicFrom = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const rawOf = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url');
const newSeed = () => Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }).d!, 'base64url');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `v1a,<base64>` over `<id>.<timestamp>.<payload>`, one for each seed, space-separated. */
function signed(seeds: readonly Buffer[], id: string, timestamp: string, payload: string): string {
  return seeds.map((seed) => `v1a,${sign(null, Buffer.from(`${id}.${timestamp}.${payload}`, 'utf8'), privateFrom(seed)).toString('base64')}`).join(' ');
}

/** Whether any `v1a` signature in the header verifies with any of the keys. */
function verified(header: string, keys: readonly string[], id: string, timestamp: string, payload: string): boolean {
  // More signatures than any sender needs verifies nothing (section 4), so
  // nobody can make this relay check signatures without end.
  const parts = header.split(' ');
  if (parts.length > 4) return false;
  const content = Buffer.from(`${id}.${timestamp}.${payload}`, 'utf8');
  return parts.some((part) => part.startsWith('v1a,') && keys.some((key) => {
    try {
      return verify(null, content, publicFrom(Buffer.from(key, 'base64url')), Buffer.from(part.slice(4), 'base64'));
    } catch {
      return false;
    }
  }));
}

/* ------------------------------------------------------------------ state --- */

interface InboxEntry {
  /** Its place in the inbox: a cursor names the last one the deployment is done with. */
  seq: number;
  id: string;
  body: string;
  /** Signed by this relay's key now and the one it rotates away from, both: its rotation. */
  both?: boolean;
}

interface State {
  /** This relay's own key, as its seed; and the one it rotated away from, until its week ends. */
  seed: string;
  previous: { seed: string; until: string } | null;
  /** The deployment it is paired with, and the keys it accepts from it; null until paired. */
  paired: { deployment: string; relay: string; keys: Array<{ key: string; until: string | null }> } | null;
  /** Device keys: by the claim that is making one, and by the recipient the deployment confirmed, with the claim that made it. */
  claims: Record<string, string>;
  devices: Record<string, { seed: string; claim: string | null }>;
  /** Acts waiting for the deployment to pull them, kept until a later cursor is named. */
  inbox: { next: number; entries: InboxEntry[] };
  /** The tokens it was sent, by their SHA-256, with whom they were for and until when: never the tokens themselves. */
  offered: Record<string, { recipient: string; until: string }>;
  /** Envelope ids taken, and pull ids answered, with when: a resend is answered as a repeat. */
  seen: Record<string, string>;
  pulls: Record<string, string>;
  /** Companies the deployment erased, by the reference it sent: nothing more of them is shown. */
  forgotten: string[];
}

function emptyState(): State {
  return {
    seed: newSeed().toString('hex'), previous: null, paired: null, claims: {}, devices: {},
    inbox: { next: 1, entries: [] }, offered: {}, seen: {}, pulls: {}, forgotten: [],
  };
}

/** A state file as it was read, made whole: one written by an earlier version of this relay lacks what it did not keep. */
function loadedState(text: string): State {
  const read = JSON.parse(text) as Partial<State> & { devices?: Record<string, unknown> };
  const devices: State['devices'] = {};
  for (const [recipient, device] of Object.entries(read.devices ?? {})) {
    devices[recipient] = typeof device === 'string' ? { seed: device, claim: null } : device as { seed: string; claim: string | null };
  }
  return { ...emptyState(), ...read, devices, seed: String(read.seed) };
}

export interface ReferenceRelayOptions {
  port?: number;
  host?: string;
  /** The loopback port its acts are taken on: 0 for any; the command line's `--local-port`, its port and one unless given. */
  localPort?: number;
  /** The deployment's fingerprint, as its owner reads it under This deployment, Relays: the only deployment this relay pairs with. */
  deploymentFingerprint: string;
  /** Where this relay is reached; `http://<host>:<port>` unless given. */
  publicUrl?: string;
  name?: string;
  /** Kept across starts when given: its keys, the pairing, its inbox, the devices, the tokens and the envelopes it saw. */
  stateFile?: string;
  ntfy?: { url: string; token?: string };
  /** Prints what notices say, their words and links, and not only that something came. */
  printContent?: boolean;
  /** Where it prints; stdout unless given. */
  log?: (line: string) => void;
  /** Prints nothing: for a test. */
  quiet?: boolean;
  /** The clock, in milliseconds: for a test that moves it. */
  now?: () => number;
}

export interface ReferenceRelay {
  url: string;
  /** Where its acts are taken, on loopback only. */
  localUrl: string;
  readonly fingerprint: string;
  link(code: string, label?: string): Promise<void>;
  press(token: string, answer?: string): Promise<void>;
  reply(token: string, text: string): Promise<void>;
  read(token: string): Promise<void>;
  /** The notice's room quiet until a time, or heard again with null. */
  mute(token: string, until: string | null): Promise<void>;
  /** A new key for this relay, announced to the deployment in its inbox. Answers the new fingerprint. */
  rotateKey(): Promise<string>;
  /** Every envelope it took, content dropped where a retraction or its fortnight says. */
  received(): Array<Record<string, any>>;
  /** What the deployment answered each act it pulled, by the act's id. */
  results(): Record<string, { status: number; answer: Record<string, unknown> }>;
  /** How many envelopes it refused. */
  refused(): number;
  /** Drops content past its fortnight now, as the hourly sweep does. */
  sweep(): void;
  close(): Promise<void>;
}

/** Starts the relay. */
export async function startReferenceRelay(options: ReferenceRelayOptions): Promise<ReferenceRelay> {
  const pinned = options.deploymentFingerprint.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{24}$/.test(pinned)) {
    throw new Error('--deployment-fingerprint is the 24 characters the owner reads in PALUGADA under This deployment, Relays');
  }
  const now = options.now ?? (() => Date.now());
  const say = (line: string) => {
    if (options.quiet) return;
    if (options.log) options.log(line);
    else process.stdout.write(`${line}\n`);
  };
  const state: State = options.stateFile && existsSync(options.stateFile)
    ? loadedState(readFileSync(options.stateFile, 'utf8'))
    : emptyState();
  // Written whole to a file beside it and renamed over it, so a relay
  // stopped mid-write keeps the state it had rather than half of one.
  const save = () => {
    if (!options.stateFile) return;
    const next = `${options.stateFile}.next`;
    writeFileSync(next, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(next, options.stateFile);
  };
  save();
  const seeds = () => [Buffer.from(state.seed, 'hex'),
    ...(state.previous && new Date(state.previous.until).getTime() > now() ? [Buffer.from(state.previous.seed, 'hex')] : [])];
  const publicKey = () => rawOf(privateFrom(Buffer.from(state.seed, 'hex')));
  const kept: Array<Record<string, any>> = [];
  const results: Record<string, { status: number; answer: Record<string, unknown> }> = {};
  let refusals = 0;
  let warned = false;
  let base = options.publicUrl?.replace(/\/$/, '') ?? '';

  /** The deployment's keys this relay accepts now: the pinned one, and one rotated out until its week ends. */
  const keys = () => (state.paired?.keys ?? []).filter((one) => one.until === null || new Date(one.until).getTime() > now()).map((one) => one.key);
  const tooOld = (envelope: Record<string, any>) => !(Date.parse(String(envelope.at)) > now() - KEPT_DAYS * DAY_MS);

  /** What of an envelope it may keep once a retraction or its fortnight says so: its address alone. */
  const dropContent = (envelope: Record<string, any>) => {
    for (const key of Object.keys(envelope)) if (!ADDRESS.has(key)) delete envelope[key];
  };

  /**
   * Content past its fortnight dropped, as the protocol requires (section
   * 10), and the tokens, ids and keys past their time forgotten.
   */
  const sweep = () => {
    for (const one of kept) if (tooOld(one)) dropContent(one);
    for (const [hash, offer] of Object.entries(state.offered)) if (new Date(offer.until).getTime() <= now()) delete state.offered[hash];
    for (const [id, at] of Object.entries(state.seen)) if (new Date(at).getTime() <= now() - KEPT_DAYS * DAY_MS) delete state.seen[id];
    for (const [id, at] of Object.entries(state.pulls)) if (new Date(at).getTime() <= now() - 2 * TOLERANCE_SECONDS * 1000) delete state.pulls[id];
    if (state.previous && new Date(state.previous.until).getTime() <= now()) state.previous = null;
    save();
  };
  const hourly = setInterval(sweep, 3_600_000);
  hourly.unref();

  /** An act for the deployment to pull: kept unsigned, and signed when the deployment asks for it. */
  const queue = (body: Record<string, unknown>, both = false) => {
    const id = `in_${randomUUID()}`;
    state.inbox.entries.push({ seq: state.inbox.next, id, body: canonical(body), ...(both ? { both } : {}) });
    state.inbox.next += 1;
    save();
    return id;
  };
  const deviceAct = (
    type: string, token: string, body: Record<string, unknown>, signedToo: Record<string, unknown>, words: string | null,
  ) => {
    if (!state.paired) throw new Error('not paired yet');
    const offer = state.offered[sha256(token)];
    if (!offer) throw new Error('this relay was never sent that token, or it has expired');
    const device = state.devices[offer.recipient];
    const at = new Date(now()).toISOString();
    const hash = words === null ? undefined : sha256(words);
    const fields = { deployment: state.paired.deployment, relay: state.paired.relay, recipient: offer.recipient, type, token, at, sha256: hash, ...signedToo };
    const device_sig = device
      ? sign(null, Buffer.from(`palugada-device/v1\n${canonical(fields)}`, 'utf8'), privateFrom(Buffer.from(device.seed, 'hex'))).toString('base64url')
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

  const accept = (res: ServerResponse, envelope: Record<string, any>) => {
    const body = canonical({ pair_accept: { request: envelope.id, deployment: envelope.deployment, relay: envelope.relay, at: new Date(now()).toISOString() } });
    const answerId = `ac_${randomUUID()}`;
    const answerAt = String(Math.floor(now() / 1000));
    res.writeHead(200, {
      'content-type': 'application/json', 'webhook-id': answerId, 'webhook-timestamp': answerAt,
      'webhook-signature': signed([Buffer.from(state.seed, 'hex')], answerId, answerAt, body),
    });
    res.end(body);
  };

  const envelopes = async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const id = header(req, 'webhook-id');
    const timestamp = header(req, 'webhook-timestamp');
    const signature = header(req, 'webhook-signature');
    const fresh = /^\d{1,12}$/.test(timestamp) && Math.abs(now() / 1000 - Number(timestamp)) <= TOLERANCE_SECONDS;
    let envelope: Record<string, any>;
    try {
      envelope = JSON.parse(body) as Record<string, any>;
    } catch {
      return refuse(res, 400, 'not JSON');
    }
    if (envelope.type === 'pair_request') {
      const key = String(envelope.key ?? '');
      if (fingerprintOf(Buffer.from(key, 'base64url')) !== pinned) return refuse(res, 403, 'not the deployment this relay was told to pair with');
      if (!verified(signature, [key], id, timestamp, body) || !fresh) return refuse(res, 401, 'pairing request not signed by its own key, now');
      if (state.paired) {
        // Paired already: only the same deployment and pairing again, under
        // a key its operator pinned anew, keeping every link and device (a
        // deployment whose rotation this relay missed, section 2.3).
        if (envelope.deployment !== state.paired.deployment || envelope.relay !== state.paired.relay) {
          return refuse(res, 409, 'already paired: delete the state file by hand to pair with another deployment');
        }
        state.paired.keys = [{ key, until: null }];
        save();
        say(`paired again with deployment ${envelope.deployment}, under its new key`);
        return accept(res, envelope);
      }
      state.paired = { deployment: String(envelope.deployment), relay: String(envelope.relay), keys: [{ key, until: null }] };
      save();
      say(`paired with deployment ${envelope.deployment}`);
      return accept(res, envelope);
    }
    if (!state.paired) return refuse(res, 401, 'not paired');
    if (!verified(signature, keys(), id, timestamp, body)) return refuse(res, 401, 'not signed by the deployment');
    if (!fresh) return refuse(res, 408, 'not signed now');
    // What the deployment signed is canonical, so a relay that forwards it can prove it again.
    if (canonical(envelope) !== body) return refuse(res, 400, 'not canonical JSON');
    if (envelope.deployment !== state.paired.deployment || envelope.relay !== state.paired.relay) return refuse(res, 403, 'another deployment, or another pairing');
    if (state.seen[id]) return reply(res, 200, { ok: true, duplicate: true });
    state.seen[id] = new Date(now()).toISOString();
    switch (envelope.type) {
      case 'keys_rotated': {
        // Signed by the key pinned now -- not one rotated out, whoever may
        // still hold it -- and by the new key, which proves the deployment
        // holds it; and naming the pinned key as the one it replaces.
        const pinnedNow = state.paired.keys.find((one) => one.until === null)?.key ?? '';
        const next = String(envelope.key ?? '');
        if (envelope.previous?.key !== pinnedNow || !verified(signature, [pinnedNow], id, timestamp, body)
            || !verified(signature, [next], id, timestamp, body) || Buffer.from(next, 'base64url').length !== 32) {
          delete state.seen[id];
          return refuse(res, 401, 'a new key is taken only from the key pinned now and the new key, both');
        }
        // The old key stands for the week the deployment gives it, and never longer.
        const week = new Date(now() + 7 * DAY_MS);
        const until = new Date(String(envelope.previous.until));
        state.paired.keys = [{ key: next, until: null },
          { key: pinnedNow, until: (Number.isFinite(until.getTime()) && until < week ? until : week).toISOString() }];
        say(`the deployment's key is now ${envelope.kid}`);
        break;
      }
      case 'link_confirmed': {
        const device = state.claims[envelope.data?.claim];
        if (device) {
          state.devices[envelope.to.recipient] = { seed: device, claim: String(envelope.data.claim) };
          delete state.claims[envelope.data.claim];
          // Shown so the person can compare it with what PALUGADA shows beside their link.
          say(`linked ${envelope.to.recipient}; its device key is ${grouped(fingerprintOf(rawOf(privateFrom(Buffer.from(device, 'hex')))))}`);
        }
        break;
      }
      case 'link_ended': {
        // The device that link was made with is forgotten, and only that one:
        // the person may have linked another since.
        const device = state.devices[envelope.to?.recipient];
        if (device && (envelope.data?.claim === null || device.claim === envelope.data?.claim)) delete state.devices[envelope.to.recipient];
        break;
      }
      case 'company_forgotten': {
        const ref = String(envelope.company?.ref ?? '');
        if (!state.forgotten.includes(ref)) state.forgotten.push(ref);
        for (const one of kept) if (one.company?.ref === ref) dropContent(one);
        break;
      }
      case 'act_result':
        results[String(envelope.data?.ref)] = { status: Number(envelope.data?.status), answer: envelope.data?.answer ?? {} };
        say(`the deployment answered ${envelope.data?.ref}: ${envelope.data?.status}${envelope.data?.answer?.code ? ` ${envelope.data.answer.code}` : ''}`);
        break;
      case 'inbox_closed':
      case 'room_activity_retracted':
        // What a retraction names is dropped, not kept beside it.
        for (const one of kept) {
          if (one.id === envelope.data?.ref || (envelope.data?.refs ?? []).includes(one.id)) dropContent(one);
        }
        break;
      default:
        break;
    }
    // Content past its fortnight, or of a company erased, is neither shown nor forwarded.
    const shown = !tooOld(envelope) && !(envelope.company?.ref && state.forgotten.includes(envelope.company.ref));
    const offers: Array<{ act: string; token: string; label: string }> = shown && Array.isArray(envelope.offers) ? envelope.offers : [];
    const until = new Date(Math.min(Date.parse(String(envelope.at)) + KEPT_DAYS * DAY_MS, now() + 7 * DAY_MS)).toISOString();
    for (const offer of offers) state.offered[sha256(String(offer.token))] = { recipient: String(envelope.to?.recipient), until };
    save();
    say(`${envelope.type}${envelope.to ? ` for ${envelope.to.recipient}` : ''}${shown && options.printContent && envelope.text ? `: ${envelope.text}` : ''}${shown && options.printContent && envelope.link ? ` (${envelope.link})` : ''}`);
    for (const offer of offers) {
      // A room's notice is answered with words, a read mark or a mute; an item's with a press.
      const command = ['reply', 'read', 'mute'].includes(offer.act) ? offer.act : 'press';
      say(`  ${options.printContent ? offer.label : offer.act}: npm run relay:reference -- ${command} ${offer.token}${command === 'reply' ? ' <words>' : ''}`);
    }
    if (shown) await forward(envelope);
    else dropContent(envelope);
    kept.push(envelope);
    reply(res, 200, { ok: true });
  };

  const pull = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const id = header(req, 'webhook-id');
    const timestamp = header(req, 'webhook-timestamp');
    const fresh = /^\d{1,12}$/.test(timestamp) && Math.abs(now() / 1000 - Number(timestamp)) <= TOLERANCE_SECONDS;
    // Signed over the request line and this relay's id at the deployment, so
    // a pull another relay was sent cannot be replayed here; and answered
    // once, so one cannot be replayed here either.
    if (!state.paired || !verified(header(req, 'webhook-signature'), keys(), id, timestamp, `GET ${url.pathname}${url.search}\n${state.paired.relay}`) || !fresh) {
      return refuse(res, 401, 'an inbox is read by the paired deployment only');
    }
    if (state.pulls[id]) return refuse(res, 409, 'that pull was answered already');
    state.pulls[id] = new Date(now()).toISOString();
    // The deployment is done with everything up to the cursor it names. A
    // cursor this relay never gave -- past the last it made, or not one of
    // its own -- is answered from the oldest it holds.
    const named = Number(url.searchParams.get('after') ?? '0');
    const after = Number.isInteger(named) && named >= 0 && named < state.inbox.next ? named : 0;
    state.inbox.entries = state.inbox.entries.filter((one) => one.seq > after);
    save();
    const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 25);
    const until = Date.now() + wait * 1000;
    while (state.inbox.entries.length === 0 && Date.now() < until && !req.destroyed) await new Promise((resolve) => setTimeout(resolve, 200));
    // At most a hundred envelopes, and eight MiB in all: the rest wait for
    // the next pull. Each is signed now, as it is answered, not when it was
    // queued: an act that waited while the deployment could not be reached
    // is not refused as stale for having waited.
    const answer: Array<{ id: string; timestamp: string; signature: string; body: string }> = [];
    let size = 0;
    let cursor = after;
    const signedAt = String(Math.floor(now() / 1000));
    for (const one of state.inbox.entries.slice(0, 100)) {
      const keysNow = one.both && state.previous ? [Buffer.from(state.seed, 'hex'), Buffer.from(state.previous.seed, 'hex')] : seeds();
      const entry = { id: one.id, timestamp: signedAt, signature: signed(keysNow, one.id, signedAt, one.body), body: one.body };
      size += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
      if (size > 8 * 1024 * 1024 - 1024 && answer.length > 0) break;
      answer.push(entry);
      cursor = one.seq;
    }
    reply(res, 200, { envelopes: answer, cursor: String(cursor) });
  };

  const local = (req: IncomingMessage, res: ServerResponse, path: string, body: string) => {
    // A person's acts, from this machine only: what a phone's app would
    // send. This listener is bound to loopback alone; a proxy on this
    // machine forwarding to it is refused as well, by the headers it adds.
    if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined || req.headers['x-real-ip'] !== undefined) {
      return refuse(res, 403, 'acts come from this machine, not through a proxy');
    }
    try {
      const given = JSON.parse(body || '{}') as Record<string, string>;
      let answered: Record<string, unknown> = { ok: true };
      if (path === '/local/link') {
        const device = newSeed();
        const id = queue({ v: 1, type: 'link_claim', at: new Date(now()).toISOString(), code: given.code, label: given.label ?? 'Reference relay',
          device_key: rawOf(privateFrom(device)).toString('base64url') });
        state.claims[id] = device.toString('hex');
        save();
      } else if (path === '/local/press') {
        const answer = given.answer ?? null;
        deviceAct('press', given.token!, answer === null ? {} : { answer }, {}, answer);
      } else if (path === '/local/reply') {
        // A fresh client id for every reply: it is the person's for all time.
        const clientId = randomUUID();
        deviceAct('reply', given.token!, { body: given.text, clientId }, { clientId }, given.text ?? '');
      } else if (path === '/local/read') {
        deviceAct('read', given.token!, {}, {}, null);
      } else if (path === '/local/mute') {
        const until = given.until ?? null;
        deviceAct('mute', given.token!, { until }, { until }, null);
      } else if (path === '/local/rotate-key') {
        if (!state.paired) throw new Error('not paired yet');
        // The new key from now; the old one signs beside it for a week, and
        // the deployment is told in an envelope both sign (section 2.3).
        const old = state.seed;
        const until = new Date(now() + 7 * DAY_MS).toISOString();
        state.previous = { seed: old, until };
        state.seed = newSeed().toString('hex');
        queue({ v: 1, type: 'relay_key_rotated', at: new Date(now()).toISOString(), key: publicKey().toString('base64url'),
          previous: { key: rawOf(privateFrom(Buffer.from(old, 'hex'))).toString('base64url'), until } }, true);
        say(`this relay's key is now ${grouped(fingerprintOf(publicKey()))}`);
        answered = { ok: true, fingerprint: fingerprintOf(publicKey()) };
      } else {
        return reply(res, 404, { ok: false });
      }
      reply(res, 200, answered);
    } catch (error) {
      reply(res, 400, { ok: false, error: (error as Error).message });
    }
  };

  const bodyOf = (req: IncomingMessage, then: (body: string, size: number) => void) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 65_536) chunks.push(chunk);
    });
    req.on('end', () => then(Buffer.concat(chunks).toString('utf8'), size));
  };

  // What the deployment and the world reach: the document, envelopes, the inbox. Never a person's acts.
  const server = createServer((req, res) => bodyOf(req, (body, size) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    void (async () => {
      if (size > 65_536) return refuse(res, 413, 'too large');
      if (req.method === 'GET' && url.pathname === '/.well-known/palugada-relay') {
        return reply(res, 200, {
          v: 1, relay: options.name ?? 'PALUGADA reference relay', key: publicKey().toString('base64url'), versions: [1],
          envelopes: `${base}/v1/envelopes`, inbox: `${base}/v1/inbox`, modes: ['pull'], features: ['press', 'reply', 'read', 'mute', 'device-keys'],
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/envelopes') return envelopes(req, res, body);
      if (req.method === 'GET' && url.pathname === '/v1/inbox') return pull(req, res, url);
      reply(res, 404, { ok: false });
    })().catch((error: unknown) => reply(res, 500, { ok: false, error: (error as Error).message }));
  }));
  // A person's acts, on a listener of their own bound to loopback, so no
  // proxy in front of the public one reaches them however it is configured.
  const acts = createServer((req, res) => bodyOf(req, (body, size) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (size > 65_536) return refuse(res, 413, 'too large');
    if (req.method === 'POST' && url.pathname.startsWith('/local/')) return local(req, res, url.pathname, body);
    reply(res, 404, { ok: false });
  }));
  const listen = (one: Server, port: number, on: string) => new Promise<number>((resolve, reject) => {
    one.once('error', reject);
    one.listen(port, on, () => {
      const address = one.address();
      if (address === null || typeof address === 'string') reject(new Error('the relay has no port'));
      else resolve(address.port);
    });
  });
  const host = options.host ?? '127.0.0.1';
  const port = await listen(server, options.port ?? 8790, host);
  const localPort = await listen(acts, options.localPort ?? 0, '127.0.0.1');
  if (!base) base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  say(`PALUGADA reference relay at ${base}; its fingerprint is ${grouped(fingerprintOf(publicKey()))}; acts on 127.0.0.1:${localPort}`);
  if (options.ntfy && !options.ntfy.token) {
    say('warning: RELAY_NTFY_TOKEN is not set; keep the relay at the signal share, or use a self-hosted or token-protected ntfy');
  }

  const act = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${localPort}${path}`, { method: 'POST', body: JSON.stringify(body) });
    const answer = await response.json() as { ok: boolean; error?: string; fingerprint?: string };
    if (!answer.ok) throw new Error(answer.error ?? `the relay answered ${response.status}`);
    return answer;
  };
  return {
    url: base,
    localUrl: `http://127.0.0.1:${localPort}`,
    get fingerprint() {
      return fingerprintOf(publicKey());
    },
    link: async (code, label) => void await act('/local/link', { code, ...(label ? { label } : {}) }),
    press: async (token, answer) => void await act('/local/press', { token, ...(answer === undefined ? {} : { answer }) }),
    reply: async (token, text) => void await act('/local/reply', { token, text }),
    read: async (token) => void await act('/local/read', { token }),
    mute: async (token, until) => void await act('/local/mute', { token, until }),
    rotateKey: async () => String((await act('/local/rotate-key', {})).fingerprint),
    received: () => kept.slice(),
    results: () => ({ ...results }),
    refused: () => refusals,
    sweep,
    close: async () => {
      clearInterval(hourly);
      for (const one of [server, acts]) {
        await new Promise<void>((resolve) => {
          one.closeAllConnections();
          one.close(() => resolve());
        });
      }
    },
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
  const localPort = Number(flag(rest, 'local-port') ?? process.env.RELAY_LOCAL_PORT ?? port + 1);
  if (command === 'serve') {
    const fingerprint = flag(rest, 'deployment-fingerprint') ?? process.env.RELAY_DEPLOYMENT_FINGERPRINT;
    if (!fingerprint) throw new Error('--deployment-fingerprint is required: the 24 characters PALUGADA shows under This deployment, Relays');
    await startReferenceRelay({
      port,
      localPort,
      deploymentFingerprint: fingerprint,
      host: flag(rest, 'host') ?? '127.0.0.1',
      stateFile: flag(rest, 'state') ?? 'relay-state.json',
      printContent: rest.includes('--print-content'),
      ...(flag(rest, 'public-url') ? { publicUrl: flag(rest, 'public-url')! } : {}),
      ...(flag(rest, 'name') ? { name: flag(rest, 'name')! } : {}),
      ...(process.env.RELAY_NTFY_URL
        ? { ntfy: { url: process.env.RELAY_NTFY_URL, ...(process.env.RELAY_NTFY_TOKEN ? { token: process.env.RELAY_NTFY_TOKEN } : {}) } }
        : {}),
    });
    return;
  }
  const positional = rest.filter((one, index) => !one.startsWith('--') && !rest[index - 1]?.startsWith('--'));
  const usage = 'usage: serve --deployment-fingerprint <fingerprint> | link <code> | press <token> [answer] | reply <token> <text> | read <token> | mute <token> [hours] | rotate-key';
  // A mute's hours are read only for a mute, and only as a number of hours
  // PALUGADA takes: more than none, and at most thirty days.
  const hours = command === 'mute' ? Number(positional[1] ?? 8) : 0;
  if (command === 'mute' && !(Number.isFinite(hours) && hours > 0 && hours <= 720)) throw new Error(usage);
  const paths: Record<string, () => [string, Record<string, unknown>]> = {
    link: () => ['/local/link', { code: positional[0] }],
    press: () => ['/local/press', { token: positional[0], ...(positional[1] !== undefined ? { answer: positional.slice(1).join(' ') } : {}) }],
    reply: () => ['/local/reply', { token: positional[0], text: positional.slice(1).join(' ') }],
    read: () => ['/local/read', { token: positional[0] }],
    mute: () => ['/local/mute', { token: positional[0], until: new Date(Date.now() + hours * 3_600_000).toISOString() }],
    'rotate-key': () => ['/local/rotate-key', {}],
  };
  const chosen = command && Object.hasOwn(paths, command) ? paths[command]!() : undefined;
  if (!chosen || (command !== 'rotate-key' && !positional[0])) throw new Error(usage);
  const response = await fetch(`http://127.0.0.1:${localPort}${chosen[0]}`, { method: 'POST', body: JSON.stringify(chosen[1]) });
  process.stdout.write(`${await response.text()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`relay: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
