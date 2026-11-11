/**
 * The relays the owner pairs, and what each may hear and do (F19.19, F19.20;
 * STATUS section 2.208).
 *
 * The owner gives a relay's address; PALUGADA reads its well-known document,
 * pins its key and shows its fingerprint, and keeps it pending. The owner then
 * types at least the first sixteen characters of the fingerprint the relay's
 * operator shows them, names the companies it may hear about (every company,
 * later ones too, is a choice of its own), and proves a factor given now.
 * PALUGADA sends a signed pairing request, and the relay must answer with an
 * accept signed by the key the owner compared, naming that request and this
 * deployment, so an accept cannot be carried over from another pairing.
 *
 * What a relay is told and may do starts at the least: `signal`, no presses,
 * no replies. Widening any of it takes the owner's device again; narrowing
 * takes the session and voids, at once, whatever it no longer allows.
 * Revoking is immediate: its envelopes are refused, its offers void, its
 * outbox dropped, its links ended.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { pingSaid } from '../owner/relay-said.ts';
import { deploymentLanguages } from '../domain/language.ts';
import type { MasterKey } from '../settings/store.ts';
import { companyRef, envelopeBody, envelopeHeaders, envelopeId, narrowedEnvelope, SHARE_LEVELS, type Share } from './envelope.ts';
import { signingKeys, type DeploymentIdentity } from './identity.ts';
import { tokenHash } from './offers.ts';
import { enqueue } from './outbox.ts';
import { fingerprint, freshTimestamp, verifyV1a } from './signature.ts';

/** How long PALUGADA waits for a relay to answer the owner: its document, or its accept. */
const RELAY_ANSWER_MS = 5_000;
/** The most of a relay's document, or of its accept, that is read: either is a few hundred bytes. */
const RELAY_ANSWER_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RelayRow {
  id: string;
  name: string;
  url: string;
  envelopes_url: string;
  inbox_url: string | null;
  public_key: Buffer;
  fingerprint: string;
  status: 'pending' | 'paired' | 'revoked';
  mode: 'push' | 'pull';
  share: Share;
  companies: string[];
  all_companies: boolean;
  may_press: boolean;
  may_post: boolean;
  salt: Buffer;
  pair_request_id: string | null;
  inbound_cursor: string | null;
  /** Until when nothing is sent: a date, or `Infinity` for a relay that forgot this deployment and must be paired again. */
  paused_until: Date | number | null;
  last_ok_at: Date | null;
  last_error: string | null;
  created_at: Date;
  paired_at: Date | null;
  /** Each company's own ceiling under the relay's share, by company id (STATUS section 2.216). */
  company_shares: Record<string, Share>;
  /** The relay's own key it rotated away from, accepted beside the new one until `previous_until`. */
  previous_key: Buffer | null;
  previous_until: Date | null;
}

/**
 * One relay's row, or null; locked for the transaction when asked.
 *
 * The lock is the relay's order: every transaction that changes its offers,
 * its links or its outbox takes the relay's row first, before any of those
 * rows. A press, a retraction, a link claimed or ended, a change of settings
 * and a revocation therefore wait for each other at one row rather than
 * each holding what the other needs next, which PostgreSQL ends by aborting
 * one of them.
 */
export async function relayRow(tx: TenantClient, relayId: string, lock = false): Promise<RelayRow | null> {
  if (!UUID.test(relayId)) return null;
  const { rows } = await tx.query<RelayRow>(`SELECT * FROM relays WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [relayId]);
  return rows[0] ?? null;
}

/** Whether a relay may hear about a company: one it named, or every company. */
export function covers(relay: Pick<RelayRow, 'companies' | 'all_companies'>, companyId: string): boolean {
  return relay.all_companies || relay.companies.includes(companyId);
}

/** What the owner's page shows of a relay. */
export function relayView(row: RelayRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    fingerprint: row.fingerprint,
    status: row.status,
    mode: row.mode,
    share: row.share,
    companies: row.companies,
    allCompanies: row.all_companies,
    mayPress: row.may_press,
    mayPost: row.may_post,
    pull: row.inbox_url !== null,
    pausedUntil: row.paused_until === null ? null : row.paused_until instanceof Date ? row.paused_until.toISOString() : 'infinity',
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastError: failureView(row.last_error),
    createdAt: row.created_at.toISOString(),
    pairedAt: row.paired_at?.toISOString() ?? null,
  };
}

/**
 * Why a send to a relay last failed, as the console says it in the owner's
 * language: a reason, and the status a relay answered. The transport's own
 * words are never shown; they are English, and the owner reads a sentence.
 */
export type FailureView = { reason: 'gone' | 'timeout' | 'unreachable' } | { reason: 'status'; status: number };

function failureView(kept: string | null): FailureView | null {
  if (kept === null) return null;
  const status = /^status:(\d{3})$/.exec(kept);
  if (status) return { reason: 'status', status: Number(status[1]) };
  if (kept === 'gone' || kept === 'timeout') return { reason: kept };
  return { reason: 'unreachable' };
}

/**
 * A relay's answer, read as text no larger than `most` bytes. A relay is a
 * stranger's machine, and one that streams without end would otherwise have
 * the deployment hold all of it before anything is checked.
 */
export async function boundedText(response: Response, most: number): Promise<string> {
  const larger = new Error(`its answer is larger than ${most} bytes`);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > most) {
    await settled(response.body?.cancel());
    throw larger;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await settled(reader.cancel());
      throw larger;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Waits for what may fail without it mattering: an answer's body cancelled that was already gone. */
export async function settled(work: Promise<unknown> | undefined): Promise<void> {
  try {
    await work;
  } catch {
    // Nothing is owed on it either way.
  }
}

/** A relay's address as the owner gave it, refused unless it is https, or this machine over http. */
function relayAddress(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new PalugadaError('contract.violation', 'a relay is given by its address, such as https://relay.example', { field: 'url' });
  }
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !local) {
    throw new PalugadaError('contract.violation', 'a relay is reached over https; plain http only on this machine', { field: 'url' });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PalugadaError('contract.violation', 'a relay\'s address carries no name, password, query or fragment', { field: 'url' });
  }
  return url;
}

/** A URL a relay's document names, held to the relay's own scheme, host and port. */
function onTheRelaysHost(base: URL, value: unknown, field: string): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new PalugadaError('contract.violation', `the relay's document gives no address for ${field}`, { field });
  }
  if (url.origin !== base.origin) {
    throw new PalugadaError('relay.other_host',
      `the relay's ${field} are at ${url.origin}, not on ${base.origin}, the host the owner gave`, { field });
  }
  return url.toString();
}

/**
 * Reads a relay's well-known document and keeps the relay, pending, with its
 * key pinned. The owner pairs it next, comparing the fingerprint shown.
 */
export async function addRelay(given: unknown, options: { fetch?: typeof fetch } = {}): Promise<ReturnType<typeof relayView>> {
  const base = relayAddress(given);
  const url = base.toString().replace(/\/$/, '');
  let document: Record<string, unknown>;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${url}/.well-known/palugada-relay`, {
      signal: AbortSignal.timeout(RELAY_ANSWER_MS), redirect: 'error', headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`it answered ${response.status}`);
    document = JSON.parse(await boundedText(response, RELAY_ANSWER_BYTES)) as Record<string, unknown>;
  } catch (error) {
    throw new PalugadaError('relay.unreachable', `the relay at ${url} did not answer with its document: ${(error as Error).message}`, { url });
  }
  if (document === null || typeof document !== 'object' || document.v !== 1) {
    throw new PalugadaError('contract.violation', 'the relay\'s document is not a PALUGADA relay\'s, version 1', { url });
  }
  const key = Buffer.from(String(document.key ?? ''), 'base64url');
  if (key.length !== 32) throw new PalugadaError('contract.violation', 'the relay\'s document gives no Ed25519 key', { url });
  const versions = Array.isArray(document.versions) ? document.versions.filter((one): one is number => Number.isInteger(one)) : [];
  if (!versions.includes(1)) throw new PalugadaError('contract.violation', 'the relay does not speak version 1', { url });
  const name = typeof document.relay === 'string' && document.relay.trim() ? document.relay.trim().slice(0, 80) : base.host;
  const envelopes = onTheRelaysHost(base, document.envelopes, 'envelopes');
  const inbox = document.inbox === undefined || document.inbox === null ? null : onTheRelaysHost(base, document.inbox, 'inbox');
  const features = Array.isArray(document.features)
    ? document.features.filter((one): one is string => typeof one === 'string').slice(0, 20).map((one) => one.slice(0, 40))
    : [];

  const row = await withControlPlane(async (tx) => {
    const { rows: live } = await tx.query('SELECT 1 FROM relays WHERE public_key = $1 AND status <> \'revoked\'', [key]);
    if (live.length > 0) {
      throw new PalugadaError('contract.violation', 'that relay is already here: pair it, or revoke it first', { url });
    }
    const { rows } = await tx.query<RelayRow>(
      `INSERT INTO relays (name, url, envelopes_url, inbox_url, public_key, fingerprint, versions, features, mode, salt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [name, url, envelopes, inbox, key, fingerprint(key), versions, features, inbox ? 'pull' : 'push', randomBytes(32)]);
    return rows[0]!;
  });
  return relayView(row);
}

/** What the owner gave to pair a relay with, checked before a factor is spent on it. */
export interface PairingTerms {
  typed: string;
  companies: string[] | 'all';
}

/**
 * Checks what the owner typed and chose, before the factor is asked for: a
 * mistake here costs a correction rather than a code. The fingerprint is
 * compared in constant time, as the gateway's device pairing compares one.
 */
export async function pairingTerms(relayId: string, body: Record<string, unknown>): Promise<PairingTerms> {
  const typed = String(body.fingerprint ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (typed.length < 16) {
    throw new PalugadaError('relay.fingerprint_short',
      'type at least the first sixteen characters of the fingerprint the relay\'s operator shows you', { typed: typed.length });
  }
  const relay = await withControlPlane((tx) => relayRow(tx, relayId));
  // A relay waiting to be paired, or one that answered that it forgot this
  // deployment, which is paired again with its settings as they were.
  if (!relay || !(relay.status === 'pending' || (relay.status === 'paired' && relay.paused_until !== null))) {
    throw new PalugadaError('contract.violation', relay ? `that relay is ${relay.status}, not waiting to be paired` : 'there is no such relay', { relayId });
  }
  const shown = Buffer.from(relay.fingerprint.slice(0, typed.length));
  const given = Buffer.from(typed.slice(0, relay.fingerprint.length));
  if (typed.length > relay.fingerprint.length || shown.length !== given.length || !timingSafeEqual(shown, given)) {
    throw new PalugadaError('relay.fingerprint', 'that is not the fingerprint of the key this relay gave', {});
  }
  return { typed, companies: await namedCompanies(body.companies, false) };
}

/**
 * The companies a relay may hear about: a list of the deployment's companies,
 * never empty, or `'all'`, every company and later ones too. Nothing is a
 * default, so a relay told about every company was meant to be.
 */
async function namedCompanies(value: unknown, allowEmpty: boolean): Promise<string[] | 'all'> {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 500
      || !value.every((one) => typeof one === 'string' && UUID.test(one))) {
    throw new PalugadaError('relay.companies',
      'name the companies this relay may hear about, by id, or choose every company, later ones too', {});
  }
  const ids = [...new Set(value as string[])];
  const { rows } = await withControlPlane((tx) => tx.query<{ id: string }>('SELECT id FROM companies WHERE id = ANY($1::uuid[])', [ids]));
  if (rows.length !== ids.length) {
    throw new PalugadaError('relay.companies', 'a company named for this relay is not one of this deployment\'s', {});
  }
  return ids;
}

/**
 * Sends the relay a signed pairing request and takes its accept: a 200 whose
 * body names this request, this deployment and this relay, signed by the key
 * the owner just compared, at a time within five minutes. Anything else
 * leaves the relay pending.
 */
export async function pairRelay(
  relayId: string,
  terms: PairingTerms,
  master: MasterKey | null,
  options: { fetch?: typeof fetch; now?: Date } = {},
): Promise<ReturnType<typeof relayView>> {
  const now = options.now ?? new Date();
  const { identity, keys } = await signingKeys(master, [], now);
  const relay = (await withControlPlane((tx) => relayRow(tx, relayId)))!;
  const requestId = randomUUID();
  const request = {
    v: 1, id: requestId, type: 'pair_request', at: now.toISOString(), deployment: identity.deployment, relay: relayId,
    key: identity.publicKey.toString('base64url'), kid: identity.kid, fingerprint: identity.fingerprint, versions: [1], name: 'PALUGADA',
  };
  const body = envelopeBody(request);
  await withControlPlane((tx) => tx.query('UPDATE relays SET pair_request_id = $2 WHERE id = $1', [relayId, requestId]));

  let answer: { status: number; headers: Headers; text: string };
  try {
    const response = await (options.fetch ?? globalThis.fetch)(relay.envelopes_url, {
      method: 'POST', headers: envelopeHeaders(keys, identity.kid, requestId, body, now), body,
      signal: AbortSignal.timeout(RELAY_ANSWER_MS), redirect: 'error',
    });
    answer = { status: response.status, headers: response.headers, text: await boundedText(response, RELAY_ANSWER_BYTES) };
  } catch (error) {
    throw new PalugadaError('relay.unreachable', `the relay did not answer the pairing request: ${(error as Error).message}`, { relayId });
  }
  const refuse = (why: string) => new PalugadaError('relay.accept', `the relay did not accept this pairing: ${why}`, { relayId });
  if (answer.status !== 200) throw refuse(`it answered ${answer.status}`);
  const id = answer.headers.get('webhook-id') ?? '';
  const timestamp = answer.headers.get('webhook-timestamp') ?? '';
  if (!verifyV1a(answer.headers.get('webhook-signature') ?? '', [relay.public_key], id, timestamp, answer.text)) {
    throw refuse('its accept is not signed by the key whose fingerprint you compared');
  }
  if (!freshTimestamp(timestamp, now.getTime())) throw refuse('its accept is not signed now');
  let accept: { request?: unknown; deployment?: unknown; relay?: unknown } | undefined;
  try {
    accept = (JSON.parse(answer.text) as { pair_accept?: typeof accept }).pair_accept;
  } catch {
    accept = undefined;
  }
  if (!accept || accept.request !== requestId || accept.deployment !== identity.deployment || accept.relay !== relayId) {
    throw refuse('its accept names another pairing request or another deployment');
  }

  const row = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<RelayRow>(
      `UPDATE relays SET status = 'paired', paired_at = $2, companies = $3, all_companies = $4, last_ok_at = $2, last_error = NULL,
              paused_until = NULL, failures = 0
        WHERE id = $1 AND (status = 'pending' OR (status = 'paired' AND paused_until IS NOT NULL)) AND pair_request_id = $5 RETURNING *`,
      [relayId, now, terms.companies === 'all' ? [] : terms.companies, terms.companies === 'all', requestId]);
    if (!rows[0]) throw refuse('it was paired or revoked meanwhile');
    return rows[0];
  });
  return relayView(row);
}

/** What a change of a relay's settings would set. */
export interface RelayChanges {
  share?: Share;
  companies?: string[];
  allCompanies?: boolean;
  mayPress?: boolean;
  mayPost?: boolean;
  mode?: 'push' | 'pull';
}

/**
 * What a change asks for, and whether it widens what the relay is told or
 * may do: a higher share, a company it did not hear about, every company,
 * presses or replies turned on. Read before the factor is asked for, which
 * only a widening needs.
 */
export async function planRelaySettings(relayId: string, body: Record<string, unknown>): Promise<{ loosens: boolean; changes: RelayChanges }> {
  const relay = await withControlPlane((tx) => relayRow(tx, relayId));
  if (!relay || relay.status === 'revoked') throw new PalugadaError('contract.violation', 'there is no such relay', { relayId });
  const changes: RelayChanges = {};
  if (body.share !== undefined) {
    if (!(SHARE_LEVELS as readonly unknown[]).includes(body.share)) {
      throw new PalugadaError('contract.violation', `a share level is one of ${SHARE_LEVELS.join(', ')}`, { field: 'share' });
    }
    changes.share = body.share as Share;
  }
  if (body.companies !== undefined) {
    const named = await namedCompanies(body.companies, body.allCompanies === true);
    if (named === 'all') changes.allCompanies = true;
    else changes.companies = named;
  }
  for (const field of ['allCompanies', 'mayPress', 'mayPost'] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw new PalugadaError('contract.violation', `${field} is true or false`, { field });
    changes[field] = body[field];
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'push' && body.mode !== 'pull') throw new PalugadaError('contract.violation', 'a relay is pushed to us, or pulled from', { field: 'mode' });
    if (body.mode === 'pull' && !relay.inbox_url) throw new PalugadaError('contract.violation', 'this relay has no inbox to pull from', { field: 'mode' });
    changes.mode = body.mode;
  }
  const all = changes.allCompanies ?? relay.all_companies;
  const companies = changes.companies ?? relay.companies;
  if (relay.status === 'paired' && !all && companies.length === 0) {
    throw new PalugadaError('relay.companies', 'a paired relay hears about at least one company, or every company', {});
  }
  const loosens = (changes.share !== undefined && SHARE_LEVELS.indexOf(changes.share) > SHARE_LEVELS.indexOf(relay.share))
    || (changes.allCompanies === true && !relay.all_companies)
    || (!relay.all_companies && !all && companies.some((one) => !relay.companies.includes(one)))
    || (changes.mayPress === true && !relay.may_press)
    || (changes.mayPost === true && !relay.may_post);
  return { loosens, changes };
}

/**
 * Sets a relay's settings, and voids what they no longer allow: offers to
 * press once presses are off or the share falls to `signal`, offers to reply
 * once replies are off, and in a company the relay no longer hears about,
 * every offer and every envelope not yet sent. An envelope not yet sent is
 * made again at the new share, without the offers now void, rather than sent
 * at the old one or dropped: the owner was told through this relay as far as
 * the ledger knows, and a notice owed while the relay was down or behind is
 * still owed at the share the owner chose now.
 */
export async function applyRelaySettings(relayId: string, changes: RelayChanges): Promise<ReturnType<typeof relayView>> {
  return withControlPlane(async (tx) => {
    const before = await relayRow(tx, relayId, true);
    if (!before || before.status === 'revoked') throw new PalugadaError('contract.violation', 'there is no such relay', { relayId });
    const all = changes.allCompanies ?? before.all_companies;
    const { rows } = await tx.query<RelayRow>(
      `UPDATE relays SET share = $2, companies = $3, all_companies = $4, may_press = $5, may_post = $6, mode = $7
        WHERE id = $1 RETURNING *`,
      [relayId, changes.share ?? before.share, all ? [] : changes.companies ?? before.companies, all,
        changes.mayPress ?? before.may_press, changes.mayPost ?? before.may_post, changes.mode ?? before.mode]);
    const after = rows[0]!;
    const acts: string[] = [];
    if (!after.may_press || after.share === 'signal') acts.push('approve', 'deny', 'answer');
    if (!after.may_post || after.share === 'signal') acts.push('reply');
    if (acts.length > 0) {
      await tx.query(
        'UPDATE relay_offers SET voided_at = now() WHERE relay_id = $1 AND voided_at IS NULL AND act = ANY($2::text[])', [relayId, acts]);
    }
    if (!after.all_companies) {
      await tx.query(
        'UPDATE relay_offers SET voided_at = now() WHERE relay_id = $1 AND voided_at IS NULL AND NOT (company_id = ANY($2::uuid[]))',
        [relayId, after.companies]);
      await tx.query(
        `DELETE FROM relay_outbox WHERE relay_id = $1 AND status IN ('pending', 'dead')
           AND company_id IS NOT NULL AND NOT (company_id = ANY($2::uuid[]))`,
        [relayId, after.companies]);
    }
    await narrowOwed(tx, relayId, after.share);
    return relayView(after);
  });
}

/**
 * Makes again, at `share`, every envelope a relay is owed and has not had
 * that tells more than `share` or carries an offer now void. A choice of a
 * run's question is a button only at `content`, where its words are told.
 */
async function narrowOwed(tx: TenantClient, relayId: string, share: Share): Promise<void> {
  const above = SHARE_LEVELS.slice(SHARE_LEVELS.indexOf(share) + 1);
  const { rows: owed } = await tx.query<{ id: string; body: string }>(
    `SELECT id, body FROM relay_outbox
      WHERE relay_id = $1 AND status IN ('pending', 'dead')
        AND ((body::jsonb->>'share') = ANY($2::text[]) OR jsonb_array_length(coalesce(body::jsonb->'offers', '[]'::jsonb)) > 0)
      ORDER BY created_at, id`,
    [relayId, above]);
  for (const row of owed) {
    const envelope = JSON.parse(row.body) as Record<string, unknown>;
    const offers = Array.isArray(envelope.offers) ? envelope.offers as Array<{ token: string }> : [];
    const { rows: standing } = await tx.query<{ token_hash: string; choice: boolean }>(
      `SELECT token_hash, option IS NOT NULL AS choice FROM relay_offers
        WHERE token_hash = ANY($1::text[]) AND voided_at IS NULL AND uses < max_uses`,
      [offers.map((offer) => tokenHash(String(offer.token)))]);
    const live = new Map(standing.map((one) => [one.token_hash, one.choice]));
    const narrowed = narrowedEnvelope(envelope, share, (offer) => {
      const choice = live.get(tokenHash(offer.token));
      return choice !== undefined && (!choice || share === 'content');
    });
    if (narrowed.dropped.length > 0) {
      await tx.query('UPDATE relay_offers SET voided_at = now() WHERE token_hash = ANY($1::text[]) AND voided_at IS NULL',
        [narrowed.dropped.map((token) => tokenHash(token))]);
    }
    const body = envelopeBody(narrowed.envelope);
    if (body !== row.body) await tx.query('UPDATE relay_outbox SET body = $2 WHERE id = $1', [row.id, body]);
  }
}

/**
 * Ends a relay at once. Whatever it signs from now is refused as from a
 * stranger; its offers are void, what it was owed and not yet sent is
 * dropped, and every link through it ends.
 */
export async function revokeRelay(relayId: string, now = new Date()): Promise<void> {
  await withControlPlane(async (tx) => {
    const relay = await relayRow(tx, relayId, true);
    if (!relay) throw new PalugadaError('contract.violation', 'there is no such relay', { relayId });
    if (relay.status === 'revoked') return;
    await tx.query(`UPDATE relays SET status = 'revoked', revoked_at = $2, pulling_until = NULL WHERE id = $1`, [relayId, now]);
    await tx.query('UPDATE relay_offers SET voided_at = $2 WHERE relay_id = $1 AND voided_at IS NULL', [relayId, now]);
    await tx.query(`DELETE FROM relay_outbox WHERE relay_id = $1 AND status IN ('pending', 'sending', 'dead')`, [relayId]);
    await tx.query(`UPDATE relay_links SET status = 'ended', ended_at = $2 WHERE relay_id = $1 AND status <> 'ended'`, [relayId, now]);
  });
}

/** Asks a paired relay to show it hears this deployment: a `ping`, sent by the relay loop like any envelope. */
export async function pingRelay(relayId: string, now = new Date()): Promise<{ id: string }> {
  const language = (await deploymentLanguages()).console;
  return withControlPlane(async (tx) => {
    const relay = await relayRow(tx, relayId);
    if (!relay || relay.status !== 'paired') throw new PalugadaError('relay.not_paired', 'only a paired relay can be sent a test', { relayId });
    const { rows: [control] } = await tx.query<{ deployment: string }>('SELECT deployment_id::text AS deployment FROM platform_control');
    const id = envelopeId({ deployment: control!.deployment, relay: relayId, link: null, type: 'ping', subject: now.toISOString() });
    const body = envelopeBody({
      v: 1, id, type: 'ping', at: now.toISOString(), deployment: control!.deployment, relay: relayId,
      lang: language, text: pingSaid(language),
    });
    await enqueue(tx, { id, relayId, linkId: null, companyId: null, type: 'ping', subjects: [], body }, now);
    return { id };
  });
}

/** Puts a relay's dead letters back to be sent, from the first attempt. */
export async function retryDead(relayId: string): Promise<{ retried: number }> {
  return withControlPlane(async (tx) => {
    const relay = await relayRow(tx, relayId, true);
    if (!relay || relay.status !== 'paired') throw new PalugadaError('relay.not_paired', 'only a paired relay is sent anything', { relayId });
    const { rowCount } = await tx.query(
      `UPDATE relay_outbox SET status = 'pending', attempts = 0, next_at = now(), last_error = NULL WHERE relay_id = $1 AND status = 'dead'`,
      [relayId]);
    return { retried: rowCount ?? 0 };
  });
}

/** Every relay that is not revoked, with the health of its outbox and its dead letters: the owner's page. */
export async function relaysPage(): Promise<Array<ReturnType<typeof relayView> & {
  links: number;
  outbox: Record<'pending' | 'sending' | 'delivered' | 'dead', number>;
  dead: Array<{ id: string; type: string; attempts: number; lastError: FailureView | null; createdAt: string }>;
}>> {
  return withControlPlane(async (tx) => {
    const { rows: relays } = await tx.query<RelayRow>(`SELECT * FROM relays WHERE status <> 'revoked' ORDER BY created_at`);
    const page = [];
    for (const relay of relays) {
      const { rows: counts } = await tx.query<{ status: 'pending' | 'sending' | 'delivered' | 'dead'; n: number }>(
        'SELECT status, count(*)::int AS n FROM relay_outbox WHERE relay_id = $1 GROUP BY status', [relay.id]);
      const { rows: dead } = await tx.query<{ id: string; type: string; attempts: number; last_error: string | null; created_at: Date }>(
        `SELECT id, type, attempts, last_error, created_at FROM relay_outbox WHERE relay_id = $1 AND status = 'dead'
          ORDER BY created_at DESC LIMIT 20`, [relay.id]);
      const { rows: [links] } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM relay_links WHERE relay_id = $1 AND status = 'active'`, [relay.id]);
      const outbox = { pending: 0, sending: 0, delivered: 0, dead: 0 };
      for (const count of counts) outbox[count.status] = count.n;
      page.push({
        ...relayView(relay),
        links: links!.n,
        outbox,
        dead: dead.map((row) => ({ id: row.id, type: row.type, attempts: row.attempts, lastError: failureView(row.last_error), createdAt: row.created_at.toISOString() })),
      });
    }
    return page;
  });
}

/** The relays a worker hands the owner's items to: every paired relay, one channel each. */
export async function pairedRelayIds(): Promise<string[]> {
  return withControlPlane(async (tx) => (await tx.query<{ id: string }>(
    `SELECT id FROM relays WHERE status = 'paired' ORDER BY created_at`)).rows.map((row) => row.id));
}

/**
 * Tells every paired relay the deployment's key changed, in an envelope the
 * old key and the new one both sign: a relay that pinned the old key verifies
 * it, and pins the new one from it.
 */
export async function announceRotation(identity: DeploymentIdentity, now = new Date()): Promise<number> {
  return withControlPlane(async (tx) => {
    // In the order of their ids, as every transaction that touches more than
    // one relay takes them, so two of them never wait on each other.
    const { rows } = await tx.query<{ id: string }>(`SELECT id FROM relays WHERE status = 'paired' ORDER BY id`);
    for (const relay of rows) {
      const id = envelopeId({ deployment: identity.deployment, relay: relay.id, link: null, type: 'keys_rotated', subject: identity.kid });
      await enqueue(tx, {
        id, relayId: relay.id, linkId: null, companyId: null, type: 'keys_rotated', subjects: [],
        body: envelopeBody({
          v: 1, id, type: 'keys_rotated', at: now.toISOString(), deployment: identity.deployment, relay: relay.id,
          key: identity.publicKey.toString('base64url'), kid: identity.kid, fingerprint: identity.fingerprint,
          previous: identity.previous
            ? { key: identity.previous.publicKey.toString('base64url'), kid: identity.previous.kid, until: identity.previous.until.toISOString() }
            : null,
        }),
      }, now);
    }
    return rows.length;
  });
}

/**
 * A company about to be erased (STATUS section 2.216): every relay that
 * hears about it, or was ever sent anything of it, is told to forget it, in
 * an envelope that names the company only by the reference that relay knows
 * it by (`company_forgotten`). It is owed by no link and of no company, so
 * the erasure that follows, whose cascade takes every envelope of the
 * company and every link of its seats, leaves it to be sent: the relays
 * drop what they hold of the company and its people's phones, and show
 * nothing of it sent later. Its id is made from the company, so an erasure
 * tried again owes it once. Written before the erasure's own transaction, so
 * that transaction takes no relay's row while it holds the company's.
 */
export async function forgetCompanyAtRelays(companyId: string, now = new Date()): Promise<number> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT r.id FROM relays r
        WHERE r.status = 'paired'
          AND (r.all_companies OR $1 = ANY(r.companies) OR EXISTS (SELECT 1 FROM relay_outbox o WHERE o.relay_id = r.id AND o.company_id = $1))
        ORDER BY r.id`,
      [companyId]);
    if (rows.length === 0) return 0;
    const { rows: [control] } = await tx.query<{ deployment: string }>('SELECT deployment_id::text AS deployment FROM platform_control');
    let told = 0;
    // In the order of their ids, as every transaction that touches more than one relay takes them.
    for (const one of rows) {
      const relay = (await relayRow(tx, one.id, true))!;
      const id = envelopeId({ deployment: control!.deployment, relay: relay.id, link: null, type: 'company_forgotten', subject: companyId });
      const wrote = await enqueue(tx, {
        id, relayId: relay.id, linkId: null, companyId: null, type: 'company_forgotten', subjects: [],
        body: envelopeBody({
          v: 1, id, type: 'company_forgotten', at: now.toISOString(), deployment: control!.deployment, relay: relay.id,
          company: { ref: companyRef(relay.salt, companyId) }, data: {},
        }),
      }, now);
      // A company's share goes with it.
      await tx.query('UPDATE relays SET company_shares = company_shares - $2 WHERE id = $1', [relay.id, companyId]);
      if (wrote) told += 1;
    }
    return told;
  });
}
