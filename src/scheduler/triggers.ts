/**
 * Work that starts from outside: inbound triggers (0054, 0056).
 *
 * Only the clock started work, so a company that had to answer a customer --
 * a payment arrived, a form was filled in, a support message was relayed --
 * polled for it on a schedule, paying a run per poll and answering hours
 * late. Paperclip and Buzz both take a webhook, and this is that, under this
 * platform's rules:
 *
 *   - **The owner opens the door.** A trigger names the role it wakes, the goal
 *     the work serves and what to do with each event, and only the owner makes
 *     one; the application role reads triggers and cannot write them.
 *   - **A caller proves who it is**, one of two ways. A token, sent as
 *     `Authorization: Bearer`, shown once and stored as its SHA-256 so the
 *     database cannot hand it out. Or the sender's own signature -- GitHub's,
 *     Stripe's, Slack's, or Standard Webhooks' -- an HMAC over the body exactly
 *     as it arrived, with a secret the deployment's secret store holds (0056).
 *     Either is compared in constant time, and a wrong one is a security event.
 *   - **A signature is fresh or it is refused.** The schemes that sign a time
 *     are held to five minutes either way, so a delivery captured off the wire
 *     cannot be sent again tomorrow.
 *   - **One delivery, one task.** A retried delivery returns the task the first
 *     one started. What counts as "the same delivery" is only what the caller
 *     proved: the sender's delivery id when the token or the signature covers
 *     it, and the body's hash when it does not -- because an id header outside
 *     the signature is one anybody replaying the body can change.
 *   - **A limit per hour**, because a sender in a loop is the cheapest way to
 *     spend a company's budget on nothing.
 *   - **The event is data.** JSON, a form or plain text, it reaches the run in
 *     the untrusted envelope, and the task is marked as begun from outside,
 *     which the broker holds to F8.9: no tier 2 or higher action without the
 *     owner.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { assertGoalOpen } from '../domain/goals.ts';
import { createRootTask } from '../engine/tasks.ts';
import type { SecretManager } from '../secrets/manager.ts';
import { enqueueWake } from './wake.ts';

/** How a delivery proves where it came from (0056). */
export const TRIGGER_SCHEMES = ['bearer', 'github', 'stripe', 'slack', 'standard'] as const;
export type TriggerScheme = (typeof TRIGGER_SCHEMES)[number];

export interface TriggerDefinition {
  slug: string;
  roleId: string;
  goalId: string;
  /** What to do with each event, as the task's brief. */
  instruction: string;
  /** Defaults to the company's first project. */
  projectId?: string;
  maxPerHour?: number;
  /** Defaults to `bearer`, a token the platform makes. */
  scheme?: TriggerScheme;
  /** Where a signed scheme's secret lives (`env://…`, `file://…`); only for a signed scheme. */
  secretRef?: string;
}

export interface TriggerView {
  id: string;
  slug: string;
  publicId: string;
  roleId: string;
  roleSlug: string;
  goalId: string;
  instruction: string;
  maxPerHour: number;
  enabled: boolean;
  scheme: TriggerScheme;
  /** A signed trigger's secret reference: where the secret is, never what it is. */
  secretRef: string | null;
  /** Whether a caller can get in at all: a token made, or a secret named. */
  hasToken: boolean;
  deliveriesLastHour: number;
  lastDeliveryAt: Date | null;
  createdAt: Date;
}

/** The headers of a delivery, as node gives them: lower-case names. */
export type HookHeaders = Record<string, string | string[] | undefined>;

export interface HookDelivery {
  /** The body exactly as it arrived. A signature is over these bytes, not over what they parse to. */
  raw: Buffer;
  headers: HookHeaders;
}

export type HookAnswer =
  | { taskId: string; duplicate: boolean }
  /** Slack checking the URL before it sends anything: answered, and no work started. */
  | { challenge: string }
  /** GitHub saying hello when the hook is made: acknowledged, and no work started. */
  | { ping: true };

/** The most of an event a run is given; past it, the text is cut and says so. */
const EVENT_MAX_CHARS = 20_000;

/**
 * How far a signed time may be from this clock, either way.
 *
 * Five minutes is what Stripe, Slack and Standard Webhooks each recommend:
 * wide enough for a sender's clock and a queue, narrow enough that a captured
 * delivery is useless by the time anyone could do anything with it.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Where a bearer caller puts its delivery id.
 *
 * Not `X-Request-Id`, which the first version read: a proxy in front of the
 * console stamps a new one on every request, so a sender's retry arrived as a
 * new delivery and started the same work twice.
 */
const DELIVERY_ID_HEADERS = ['x-delivery-id', 'idempotency-key', 'x-github-delivery'];

const SCHEME_NAMES: Record<TriggerScheme, string> = {
  bearer: 'a bearer token',
  github: "GitHub's signature (X-Hub-Signature-256)",
  stripe: "Stripe's signature (Stripe-Signature)",
  slack: "Slack's signature (X-Slack-Signature)",
  standard: 'a Standard Webhooks signature (webhook-signature)',
};

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function schemeOf(value: unknown): TriggerScheme {
  if (value === undefined) return 'bearer';
  if (typeof value === 'string' && (TRIGGER_SCHEMES as readonly string[]).includes(value)) {
    return value as TriggerScheme;
  }
  throw new PalugadaError(
    'contract.violation',
    `a trigger's scheme is one of ${TRIGGER_SCHEMES.join(', ')}`,
    { field: 'scheme' },
  );
}

/**
 * A signed scheme's secret reference, checked by reading it.
 *
 * Read now rather than at the first delivery, so an owner who named a variable
 * that is not set is told while they are looking at the form, not by a sender
 * that has been failing quietly for a day.
 */
async function checkedSecretRef(
  scheme: TriggerScheme, secretRef: string | undefined, secrets: SecretManager | undefined,
): Promise<string | null> {
  if (scheme === 'bearer') {
    if (secretRef !== undefined && secretRef !== '') {
      throw new PalugadaError(
        'contract.violation',
        'a bearer trigger takes no secret: the platform makes its token',
        { field: 'secretRef' },
      );
    }
    return null;
  }
  const reference = String(secretRef ?? '').trim();
  if (!/^[a-z0-9-]+:\/\/.+/.test(reference)) {
    throw new PalugadaError(
      'contract.violation',
      `${SCHEME_NAMES[scheme]} is checked with a secret; name where it is kept, such as env://PALUGADA_SECRET_HOOK`,
      { field: 'secretRef' },
    );
  }
  if (!secrets) {
    throw new PalugadaError(
      'contract.violation',
      'this deployment has no secret store to read a signing secret from',
      { field: 'secretRef' },
    );
  }
  try {
    await secrets.resolve(reference);
  } catch (failure) {
    throw new PalugadaError(
      'contract.violation',
      `the signing secret could not be read: ${(failure as Error).message}`,
      { field: 'secretRef' },
    );
  }
  return reference;
}

/**
 * The owner opens a door.
 *
 * For a bearer trigger, returns the token, which is never shown again. For a
 * signed one there is no token to return: the secret is the sender's, and it
 * is already where the reference says.
 */
export async function createTrigger(
  companyId: string,
  input: TriggerDefinition,
  secrets?: SecretManager,
): Promise<{ id: string; publicId: string; token: string | null }> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug ?? '')) {
    throw new PalugadaError(
      'contract.violation',
      'a trigger slug is lowercase letters, digits and hyphens, starting with a letter or digit',
      { field: 'slug' },
    );
  }
  const instruction = String(input.instruction ?? '').trim();
  if (!instruction) {
    throw new PalugadaError('contract.violation', 'say what the role should do with each event', { field: 'instruction' });
  }
  const maxPerHour = input.maxPerHour ?? 30;
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 3_600) {
    throw new PalugadaError('contract.violation', 'maxPerHour is a whole number from 1 to 3600', { field: 'maxPerHour' });
  }
  const scheme = schemeOf(input.scheme);
  const secretRef = await checkedSecretRef(scheme, input.secretRef, secrets);
  const minted = scheme === 'bearer' ? newToken() : null;
  return withControlPlane(async (tx) => {
    const role = await tx.query<{ division_id: string }>(
      'SELECT division_id FROM roles WHERE id = $1 AND company_id = $2', [input.roleId, companyId]);
    if (!role.rows[0]) {
      throw new PalugadaError('contract.violation', 'no such role in this company', { field: 'roleId' });
    }
    const goal = await tx.query('SELECT 1 FROM goals WHERE id = $1 AND company_id = $2', [input.goalId, companyId]);
    if (goal.rowCount !== 1) {
      throw new PalugadaError('contract.violation', 'no such goal in this company', { field: 'goalId' });
    }
    // A door opened onto a closed goal would only let work be refused.
    await assertGoalOpen(tx, input.goalId);
    const project = input.projectId ?? (await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE company_id = $1 ORDER BY created_at LIMIT 1', [companyId])).rows[0]?.id;
    if (!project) {
      throw new PalugadaError('contract.violation', 'the company has no project to put the work in', { field: 'projectId' });
    }
    const { rows } = await tx.query<{ id: string; public_id: string }>(
      `INSERT INTO triggers (company_id, slug, token_hash, project_id, division_id, role_id, goal_id, instruction,
                             max_per_hour, scheme, secret_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, public_id`,
      [companyId, input.slug, minted?.hash ?? '', project, role.rows[0].division_id, input.roleId, input.goalId,
        instruction, maxPerHour, scheme, secretRef],
    );
    await appendEvent(tx, {
      companyId,
      type: 'trigger.created',
      actor: 'owner',
      payload: { triggerId: rows[0]!.id, slug: input.slug, roleId: input.roleId, maxPerHour, scheme },
    });
    return { id: rows[0]!.id, publicId: rows[0]!.public_id, token: minted?.token ?? null };
  });
}

/**
 * A new key; the old one stops working at once.
 *
 * For a bearer trigger, a new token, returned and shown once. A signed
 * trigger's secret is the sender's and is changed where it is kept, so what
 * changes here is only where the platform looks for it -- a new reference,
 * read before it is saved.
 */
export async function rotateTriggerToken(
  companyId: string,
  triggerId: string,
  options: { secretRef?: string; secrets?: SecretManager } = {},
): Promise<{ token: string | null }> {
  const current = await withControlPlane(async (tx) => (await tx.query<{ scheme: TriggerScheme }>(
    'SELECT scheme FROM triggers WHERE id = $1 AND company_id = $2', [triggerId, companyId])).rows[0]);
  if (!current) throw new PalugadaError('contract.violation', 'no such trigger in this company', { triggerId });
  const secretRef = await checkedSecretRef(current.scheme, options.secretRef, options.secrets);
  const minted = current.scheme === 'bearer' ? newToken() : null;
  await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE triggers SET token_hash = $3, secret_ref = $4 WHERE id = $1 AND company_id = $2',
      [triggerId, companyId, minted?.hash ?? '', secretRef],
    );
    if (rowCount !== 1) throw new PalugadaError('contract.violation', 'no such trigger in this company', { triggerId });
    await appendEvent(tx, { companyId, type: 'trigger.rotated', actor: 'owner', payload: { triggerId } });
  });
  return { token: minted?.token ?? null };
}

export async function setTriggerEnabled(companyId: string, triggerId: string, enabled: boolean): Promise<void> {
  await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE triggers SET enabled = $3 WHERE id = $1 AND company_id = $2', [triggerId, companyId, enabled]);
    if (rowCount !== 1) throw new PalugadaError('contract.violation', 'no such trigger in this company', { triggerId });
    await appendEvent(tx, {
      companyId, type: enabled ? 'trigger.opened' : 'trigger.closed', actor: 'owner', payload: { triggerId },
    });
  });
}

/** The company's triggers, as the owner reads them. Never the token, nor its hash. */
export async function triggersOf(companyId: string): Promise<TriggerView[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; slug: string; public_id: string; role_id: string; role_slug: string; goal_id: string;
      instruction: string; max_per_hour: number; enabled: boolean; scheme: TriggerScheme; secret_ref: string | null;
      has_token: boolean; last_hour: number; last_at: Date | null; created_at: Date;
    }>(
      `SELECT t.id, t.slug, t.public_id, t.role_id, r.slug AS role_slug, t.goal_id, t.instruction,
              t.max_per_hour, t.enabled, t.scheme, t.secret_ref,
              (t.token_hash <> '' OR t.secret_ref IS NOT NULL) AS has_token, t.created_at,
              (SELECT count(*)::int FROM trigger_deliveries d
                WHERE d.trigger_id = t.id AND d.outcome = 'started'
                  AND d.received_at > now() - interval '1 hour') AS last_hour,
              (SELECT max(d.received_at) FROM trigger_deliveries d WHERE d.trigger_id = t.id) AS last_at
         FROM triggers t JOIN roles r ON r.id = t.role_id
        ORDER BY t.created_at`,
    );
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      publicId: row.public_id,
      roleId: row.role_id,
      roleSlug: row.role_slug,
      goalId: row.goal_id,
      instruction: row.instruction,
      maxPerHour: row.max_per_hour,
      enabled: row.enabled,
      scheme: row.scheme,
      secretRef: row.secret_ref,
      hasToken: row.has_token,
      deliveriesLastHour: row.last_hour,
      lastDeliveryAt: row.last_at,
      createdAt: row.created_at,
    }));
  });
}

function header(headers: HookHeaders, name: string): string | null {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : null;
}

function same(offered: Buffer, expected: Buffer): boolean {
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

function hmac(key: Buffer | string, ...parts: Array<string | Buffer>): Buffer {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/** What a delivery proved: why it is refused, or the delivery id its proof covers. */
type Verdict = { refused: null; deliveryId: string | null } | { refused: string };

function fresh(seconds: string | null): boolean {
  if (!seconds || !/^\d{1,12}$/.test(seconds)) return false;
  return Math.abs(Date.now() / 1000 - Number(seconds)) <= SIGNATURE_TOLERANCE_SECONDS;
}

/**
 * Whether a delivery proves it came from the sender the trigger names.
 *
 * Each scheme exactly as its sender documents it, over the raw bytes. The
 * delivery id comes back only when the proof covers it: a bearer token covers
 * the whole request, and Standard Webhooks signs its id; GitHub, Stripe and
 * Slack sign only the body (and a time), so for them the body is the key.
 */
function verify(scheme: TriggerScheme, secret: string, delivery: HookDelivery): Verdict {
  const { headers, raw } = delivery;
  if (scheme === 'github') {
    const offered = header(headers, 'x-hub-signature-256');
    if (!offered) return { refused: 'no signature' };
    const expected = `sha256=${hmac(secret, raw).toString('hex')}`;
    return same(Buffer.from(offered), Buffer.from(expected))
      ? { refused: null, deliveryId: null }
      : { refused: 'wrong signature' };
  }
  if (scheme === 'stripe') {
    // t=1492774577,v1=5257a8…,v1=… -- more than one v1 while a secret rolls.
    const offered = header(headers, 'stripe-signature');
    if (!offered) return { refused: 'no signature' };
    const fields = offered.split(',').map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part.trim(), ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    });
    const time = fields.find(([name]) => name === 't')?.[1] ?? null;
    if (!fresh(time)) return { refused: 'stale signature' };
    const expected = Buffer.from(hmac(secret, `${time}.`, raw).toString('hex'));
    const matched = fields.some(([name, value]) => name === 'v1' && same(Buffer.from(value!), expected));
    return matched ? { refused: null, deliveryId: null } : { refused: 'wrong signature' };
  }
  if (scheme === 'slack') {
    const offered = header(headers, 'x-slack-signature');
    const time = header(headers, 'x-slack-request-timestamp');
    if (!offered) return { refused: 'no signature' };
    if (!fresh(time)) return { refused: 'stale signature' };
    const expected = `v0=${hmac(secret, `v0:${time}:`, raw).toString('hex')}`;
    return same(Buffer.from(offered), Buffer.from(expected))
      ? { refused: null, deliveryId: null }
      : { refused: 'wrong signature' };
  }
  if (scheme === 'standard') {
    // Svix sends the same three under its own prefix.
    const id = header(headers, 'webhook-id') ?? header(headers, 'svix-id');
    const time = header(headers, 'webhook-timestamp') ?? header(headers, 'svix-timestamp');
    const offered = header(headers, 'webhook-signature') ?? header(headers, 'svix-signature');
    if (!offered || !id) return { refused: 'no signature' };
    if (!fresh(time)) return { refused: 'stale signature' };
    // The secret is `whsec_` and the key in base64, as the senders hand it out.
    const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
    const expected = Buffer.from(hmac(key, `${id}.${time}.`, raw).toString('base64'));
    // "v1,<base64> v1,<base64>" -- one per secret while a secret rolls.
    const matched = offered.split(' ').some((part) => {
      const comma = part.indexOf(',');
      return comma > 0 && part.slice(0, comma) === 'v1' && same(Buffer.from(part.slice(comma + 1)), expected);
    });
    return matched ? { refused: null, deliveryId: id } : { refused: 'wrong signature' };
  }
  const authorization = header(headers, 'authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return { refused: 'no token' };
  if (!same(Buffer.from(hashToken(token), 'hex'), Buffer.from(secret, 'hex'))) return { refused: 'wrong token' };
  return {
    refused: null,
    deliveryId: DELIVERY_ID_HEADERS.map((name) => header(headers, name)).find((value) => value !== null) ?? null,
  };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * What a delivery says, from its content type.
 *
 * JSON, a form (Slack's slash commands, Twilio, most form builders) or text.
 * Anything else -- a file, an image, multipart -- is refused naming what is
 * taken, because a run cannot read bytes, and handing it a page of mojibake as
 * the customer's message would be worse than saying no.
 */
function parseEvent(raw: Buffer, contentType: string | null): unknown {
  if (raw.length === 0) return null;
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const unsupported = () => new PalugadaError(
    'hook.unsupported',
    'this hook takes JSON, a form (application/x-www-form-urlencoded) or text; '
      + `it was sent ${type || 'bytes that are not text'}`,
    { contentType: type },
  );
  let text: string;
  try {
    text = utf8.decode(raw);
  } catch {
    throw unsupported();
  }
  const json = type === 'application/json' || type.endsWith('+json');
  if (json || type === '') {
    try {
      return JSON.parse(text);
    } catch {
      // Sent without a type, text that is not JSON is text.
      if (!json) return text;
      throw new PalugadaError('contract.violation', 'the body says it is JSON and is not', { contentType: type });
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const form: Record<string, string | string[]> = {};
    for (const [name, value] of new URLSearchParams(text)) {
      const seen = form[name];
      form[name] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
    }
    return form;
  }
  if (type.startsWith('text/') || type === 'application/xml') return text;
  throw unsupported();
}

/**
 * One event arriving at a trigger's URL.
 *
 * On the control plane, because the caller is nobody -- the company is not
 * known until the URL's id is looked up -- and everything written is written
 * with the company that id belongs to and no other.
 */
export async function receiveHook(
  publicId: string,
  delivery: HookDelivery,
  secrets?: SecretManager,
): Promise<HookAnswer> {
  const unknown = () => new PalugadaError('hook.unknown', 'no such hook', {});
  if (!/^[0-9a-f]{32}$/.test(publicId)) throw unknown();

  const found = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; company_id: string; slug: string; token_hash: string; project_id: string; division_id: string;
      role_id: string; goal_id: string; instruction: string; max_per_hour: number;
      scheme: TriggerScheme; secret_ref: string | null;
    }>(
      `SELECT id, company_id, slug, token_hash, project_id, division_id, role_id, goal_id, instruction, max_per_hour,
              scheme, secret_ref
         FROM triggers WHERE public_id = $1 AND enabled`,
      [publicId],
    );
    return rows[0] ?? null;
  });
  // A closed door is not there at all: telling a caller "disabled" would tell
  // them the URL was once good. Nor is one with no key yet.
  if (!found || (found.scheme === 'bearer' ? !found.token_hash : !found.secret_ref)) throw unknown();

  let secret = found.token_hash;
  if (found.scheme !== 'bearer') {
    try {
      if (!secrets) throw new Error('this deployment has no secret store');
      secret = await secrets.resolve(found.secret_ref!);
    } catch (failure) {
      // The deployment's fault, not the sender's: 503, so a sender that
      // retries (all of them do) delivers once the secret is back, and an
      // event the owner can see says why nothing is arriving.
      await withTenant(found.company_id, (tx) => appendEvent(tx, {
        companyId: found.company_id,
        type: 'trigger.secret_unavailable',
        actor: 'system',
        payload: { triggerId: found.id, reason: (failure as Error).message },
      }));
      throw new PalugadaError('hook.unavailable', 'this hook cannot check deliveries right now; retry later', {});
    }
  }

  const verdict = verify(found.scheme, secret, delivery);
  if (verdict.refused !== null) {
    await withTenant(found.company_id, (tx) => appendEvent(tx, {
      companyId: found.company_id,
      type: 'security.hook_refused',
      actor: 'system',
      payload: { triggerId: found.id, reason: verdict.refused },
    }));
    throw new PalugadaError(
      'hook.refused',
      verdict.refused === 'stale signature'
        ? 'the signature is more than five minutes from now; a signed delivery is sent when it is made'
        : `this hook takes ${SCHEME_NAMES[found.scheme]}, and that was not it`,
      {},
    );
  }

  const body = parseEvent(delivery.raw, header(delivery.headers, 'content-type'));
  // The two senders that check a URL before using it are answered, and start
  // nothing: a task per handshake would be a task nobody asked for.
  if (found.scheme === 'slack' && isRecord(body) && body.type === 'url_verification'
      && typeof body.challenge === 'string') {
    return { challenge: body.challenge };
  }
  if (found.scheme === 'github' && header(delivery.headers, 'x-github-event') === 'ping') {
    return { ping: true };
  }

  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const key = verdict.deliveryId
    ? `id:${verdict.deliveryId.slice(0, 200)}`
    : `sha256:${createHash('sha256').update(delivery.raw).digest('hex')}`;

  const decided = await withControlPlane(async (tx) => {
    // One delivery at a time per trigger, so two arriving together cannot both
    // find room under the limit, or both miss each other's key.
    await tx.query('SELECT 1 FROM triggers WHERE id = $1 FOR UPDATE', [found.id]);
    const seen = await tx.query<{ task_id: string | null; outcome: string }>(
      'SELECT task_id, outcome FROM trigger_deliveries WHERE trigger_id = $1 AND delivery_key = $2',
      [found.id, key],
    );
    if (seen.rows[0]?.outcome === 'started' && seen.rows[0].task_id) {
      return { duplicate: seen.rows[0].task_id };
    }
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trigger_deliveries
        WHERE trigger_id = $1 AND outcome = 'started' AND received_at > now() - interval '1 hour'`,
      [found.id],
    );
    if ((rows[0]?.n ?? 0) >= found.max_per_hour) {
      await tx.query(
        `INSERT INTO trigger_deliveries (company_id, trigger_id, delivery_key, outcome)
         VALUES ($1, $2, $3, 'rate_limited') ON CONFLICT (trigger_id, delivery_key) DO NOTHING`,
        [found.company_id, found.id, key],
      );
      return { limited: true as const };
    }
    return { start: true as const };
  });
  if ('duplicate' in decided) return { taskId: decided.duplicate!, duplicate: true };
  if ('limited' in decided) {
    throw new PalugadaError(
      'hook.rate_limited',
      `this hook takes ${found.max_per_hour} events an hour and has had them; the sender should retry later`,
      { maxPerHour: found.max_per_hour },
    );
  }

  const event = text.length > EVENT_MAX_CHARS
    ? `${text.slice(0, EVENT_MAX_CHARS)}\n[cut: the event was ${text.length} characters]`
    : text;
  // The key makes the task idempotent too: a crash between creating it and
  // recording the delivery leaves a retry finding the same task.
  const task = await createRootTask({
    companyId: found.company_id,
    projectId: found.project_id,
    divisionId: found.division_id,
    roleId: found.role_id,
    goalId: found.goal_id,
    input: { goal: found.instruction, event: wrapUntrusted(`webhook:${found.slug}`, event) },
    createdBy: 'webhook',
    idempotencyKey: `hook:${found.id}:${key}`,
  });
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO trigger_deliveries (company_id, trigger_id, delivery_key, outcome, task_id)
       VALUES ($1, $2, $3, 'started', $4)
       ON CONFLICT (trigger_id, delivery_key) DO UPDATE SET outcome = 'started', task_id = EXCLUDED.task_id`,
      [found.company_id, found.id, key, task.id],
    );
    await appendEvent(tx, {
      companyId: found.company_id,
      projectId: found.project_id,
      taskId: task.id,
      type: 'trigger.fired',
      actor: 'system',
      payload: { triggerId: found.id, slug: found.slug },
    });
  });
  await withTenant(found.company_id, (tx) =>
    tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [found.role_id]));
  await enqueueWake({
    companyId: found.company_id,
    roleId: found.role_id,
    reason: 'event',
    detail: `hook ${found.slug} started task ${task.id}`,
  });
  return { taskId: task.id, duplicate: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
