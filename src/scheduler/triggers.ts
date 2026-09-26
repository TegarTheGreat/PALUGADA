/**
 * Work that starts from outside: inbound triggers (0054).
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
 *   - **A token lets a caller in**, sent as `Authorization: Bearer`. It is shown
 *     once and stored as its SHA-256, so the database cannot hand it out, and
 *     compared in constant time. A wrong one is a security event.
 *   - **One delivery, one task.** The sender's delivery id, or the body's hash
 *     when it sends none, is the delivery's key; a retried delivery returns
 *     the task the first one started.
 *   - **A limit per hour**, because a sender in a loop is the cheapest way to
 *     spend a company's budget on nothing.
 *   - **The event is data.** It reaches the run in the untrusted envelope, and
 *     the task is marked as begun from outside, which the broker holds to
 *     F8.9: no tier 2 or higher action without the owner.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { createRootTask } from '../engine/tasks.ts';
import { enqueueWake } from './wake.ts';

export interface TriggerDefinition {
  slug: string;
  roleId: string;
  goalId: string;
  /** What to do with each event, as the task's brief. */
  instruction: string;
  /** Defaults to the company's first project. */
  projectId?: string;
  maxPerHour?: number;
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
  /** False for a restored trigger until the owner makes it a token. */
  hasToken: boolean;
  deliveriesLastHour: number;
  lastDeliveryAt: Date | null;
  createdAt: Date;
}

/** The most of an event a run is given; past it, the text is cut and says so. */
const EVENT_MAX_CHARS = 20_000;

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The owner opens a door. Returns the token, which is never shown again. */
export async function createTrigger(
  companyId: string,
  input: TriggerDefinition,
): Promise<{ id: string; publicId: string; token: string }> {
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
  const { token, hash } = newToken();
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
    const project = input.projectId ?? (await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE company_id = $1 ORDER BY created_at LIMIT 1', [companyId])).rows[0]?.id;
    if (!project) {
      throw new PalugadaError('contract.violation', 'the company has no project to put the work in', { field: 'projectId' });
    }
    const { rows } = await tx.query<{ id: string; public_id: string }>(
      `INSERT INTO triggers (company_id, slug, token_hash, project_id, division_id, role_id, goal_id, instruction, max_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, public_id`,
      [companyId, input.slug, hash, project, role.rows[0].division_id, input.roleId, input.goalId, instruction, maxPerHour],
    );
    await appendEvent(tx, {
      companyId,
      type: 'trigger.created',
      actor: 'owner',
      payload: { triggerId: rows[0]!.id, slug: input.slug, roleId: input.roleId, maxPerHour },
    });
    return { id: rows[0]!.id, publicId: rows[0]!.public_id, token };
  });
}

/** A new token; the old one stops working at once. Returns the new one, shown once. */
export async function rotateTriggerToken(companyId: string, triggerId: string): Promise<{ token: string }> {
  const { token, hash } = newToken();
  await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE triggers SET token_hash = $3 WHERE id = $1 AND company_id = $2', [triggerId, companyId, hash]);
    if (rowCount !== 1) throw new PalugadaError('contract.violation', 'no such trigger in this company', { triggerId });
    await appendEvent(tx, { companyId, type: 'trigger.rotated', actor: 'owner', payload: { triggerId } });
  });
  return { token };
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
      instruction: string; max_per_hour: number; enabled: boolean; has_token: boolean;
      last_hour: number; last_at: Date | null; created_at: Date;
    }>(
      `SELECT t.id, t.slug, t.public_id, t.role_id, r.slug AS role_slug, t.goal_id, t.instruction,
              t.max_per_hour, t.enabled, t.token_hash <> '' AS has_token, t.created_at,
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
      hasToken: row.has_token,
      deliveriesLastHour: row.last_hour,
      lastDeliveryAt: row.last_at,
      createdAt: row.created_at,
    }));
  });
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
  delivery: { token: string | null | undefined; body: unknown; deliveryId?: string | null },
): Promise<{ taskId: string; duplicate: boolean }> {
  const unknown = () => new PalugadaError('hook.unknown', 'no such hook', {});
  if (!/^[0-9a-f]{32}$/.test(publicId)) throw unknown();

  const found = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; company_id: string; slug: string; token_hash: string; project_id: string; division_id: string;
      role_id: string; goal_id: string; instruction: string; max_per_hour: number;
    }>(
      `SELECT id, company_id, slug, token_hash, project_id, division_id, role_id, goal_id, instruction, max_per_hour
         FROM triggers WHERE public_id = $1 AND enabled`,
      [publicId],
    );
    return rows[0] ?? null;
  });
  // A closed door is not there at all: telling a caller "disabled" would tell
  // them the URL was once good.
  if (!found || !found.token_hash) throw unknown();

  const offered = Buffer.from(hashToken(delivery.token ?? ''), 'hex');
  const expected = Buffer.from(found.token_hash, 'hex');
  if (!delivery.token || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    await withTenant(found.company_id, (tx) => appendEvent(tx, {
      companyId: found.company_id,
      type: 'security.hook_refused',
      actor: 'system',
      payload: { triggerId: found.id, reason: delivery.token ? 'wrong token' : 'no token' },
    }));
    throw new PalugadaError('hook.refused', 'this hook takes a bearer token, and that was not it', {});
  }

  const text = JSON.stringify(delivery.body ?? null, null, 2);
  const key = typeof delivery.deliveryId === 'string' && delivery.deliveryId.trim()
    ? `id:${delivery.deliveryId.trim().slice(0, 200)}`
    : `sha256:${createHash('sha256').update(text).digest('hex')}`;

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
