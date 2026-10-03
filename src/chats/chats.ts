/**
 * Customers write to the company (0111; the analysis of 3 October, §9 P2
 * item 19): the conversation, whatever carries it.
 *
 * A company could answer its owner on Telegram and WhatsApp and could not
 * answer a customer anywhere. This is the part every transport shares --
 * Telegram's is `telegram.ts`, and WhatsApp and a mailbox are further kinds
 * of the same channel -- and it keeps the platform's rules for work that
 * starts from outside, as a trigger does (`scheduler/triggers.ts`):
 *
 *   - **The owner opens the channel.** A channel names the role that answers,
 *     the goal the work serves and what to do with each message; only the
 *     owner makes one, with their device, and the application role cannot.
 *   - **One message, at most one piece of work.** A message is claimed by its
 *     transport id before anything else, so a delivery sent again is the
 *     same delivery. A message written while the work the conversation
 *     already has is still waiting for a worker joins it: a customer who
 *     says hello and then asks their question in a second message is one
 *     answer to write, not two.
 *   - **A limit per hour**, because a customer in a loop -- or a script
 *     pretending to be many -- is the cheapest way to spend a company's
 *     budget on nothing. Past it a message is kept, so the owner sees it,
 *     and starts no work.
 *   - **What a customer writes is data.** It reaches the run in the untrusted
 *     envelope, and the work is begun from outside, which the broker holds
 *     to F8.9: every answer is a tier 2 action the owner says yes to.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { assertGoalOpen } from '../domain/goals.ts';
import { languageName, languagesFor } from '../domain/language.ts';
import { createRootTask } from '../engine/tasks.ts';
import { enqueueWake } from '../scheduler/wake.ts';

export const CHAT_KINDS = ['telegram', 'whatsapp', 'email'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/** A message as its transport delivered it, read into the platform's words. */
export interface InboundMessage {
  /** The transport's id for the conversation. */
  chat: string;
  /** The transport's id for the message, unique within its conversation. */
  id: string;
  /** As the customer named themselves to the transport: theirs, so data. */
  customerName: string | null;
  customerHandle: string | null;
  text: string;
  /** What arrived that is not text, by the transport's word for it. */
  attachment: string | null;
  /** A mail's subject. */
  subject?: string | null;
}

/** An open channel, as a delivery to it is checked and recorded. */
export interface OpenChannel {
  id: string;
  companyId: string;
  kind: ChatKind;
  account: string;
  projectId: string;
  divisionId: string;
  roleId: string;
  goalId: string;
  instruction: string;
  maxPerHour: number;
  /**
   * The hash of what the transport proves itself with: Telegram's secret
   * header, or WhatsApp's verify token when the webhook is subscribed.
   */
  webhookHash: string;
  /** WhatsApp: the number's id in the Cloud API, which every delivery names. */
  accountId: string | null;
  /** WhatsApp: where the Meta app's secret, which signs every delivery, is sealed. */
  secretRef: string | null;
}

export interface Received {
  outcome: 'started' | 'joined' | 'duplicate' | 'limited';
  chatId: string;
  taskId: string | null;
}

export interface ChannelView {
  id: string;
  kind: ChatKind;
  account: string;
  roleId: string;
  /** The name the owner gave the role, else its title, else its code. */
  roleName: string;
  goalId: string;
  instruction: string;
  maxPerHour: number;
  enabled: boolean;
  chats: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  /** A mailbox: when it was last read, and why the last reading failed. */
  checkedAt: Date | null;
  failure: string | null;
}

export interface ChatView {
  id: string;
  channelId: string;
  kind: ChatKind;
  account: string;
  /** Whether a reply can still be sent on it. */
  open: boolean;
  customerName: string | null;
  customerHandle: string | null;
  lastMessageAt: Date;
  lastMessage: { direction: 'in' | 'out'; body: string; attachment: string | null } | null;
  /** The customer spoke last. */
  unanswered: boolean;
}

export interface MessageView {
  id: string;
  direction: 'in' | 'out';
  body: string;
  attachment: string | null;
  /** A mail's subject. */
  subject: string | null;
  /** In: what the message did -- started work, joined it, or was held by the hour's limit. */
  outcome: 'started' | 'joined' | 'limited' | null;
  taskId: string | null;
  /** Out: whether the transport took it. A reply whose send failed stays unsent. */
  sent: boolean;
  at: Date;
}

/** The most of a conversation shown or read at once. */
const MESSAGES_SHOWN = 200;

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** The channel a webhook address names, while it is open. */
export async function channelAt(publicId: string): Promise<OpenChannel | null> {
  if (!/^[0-9a-f]{32}$/.test(publicId)) return null;
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; company_id: string; kind: ChatKind; account: string; project_id: string; division_id: string;
      role_id: string; goal_id: string; instruction: string; max_per_hour: number; webhook_hash: string;
      account_id: string | null; secret_ref: string | null;
    }>(
      `SELECT id, company_id, kind, account, project_id, division_id, role_id, goal_id, instruction, max_per_hour,
              webhook_hash, account_id, secret_ref
         FROM chat_channels WHERE public_id = $1 AND enabled`,
      [publicId],
    );
    const row = rows[0];
    if (!row || !row.webhook_hash) return null;
    return {
      id: row.id, companyId: row.company_id, kind: row.kind, account: row.account, projectId: row.project_id,
      divisionId: row.division_id, roleId: row.role_id, goalId: row.goal_id, instruction: row.instruction,
      maxPerHour: row.max_per_hour, webhookHash: row.webhook_hash, accountId: row.account_id, secretRef: row.secret_ref,
    };
  });
}

/** Whether a delivery carries the channel's secret, compared in constant time. */
export function secretMatches(channel: OpenChannel, offered: string | null): boolean {
  if (!offered) return false;
  return timingSafeEqual(Buffer.from(hashSecret(offered), 'hex'), Buffer.from(channel.webhookHash, 'hex'));
}

/** Records a delivery the channel refused, where the owner will see somebody tried. */
export async function recordRefusal(channel: OpenChannel, reason: string): Promise<void> {
  await withTenant(channel.companyId, (tx) => appendEvent(tx, {
    companyId: channel.companyId,
    type: 'security.chat_refused',
    actor: 'system',
    payload: { channelId: channel.id, kind: channel.kind, account: channel.account, reason },
  }));
}

/**
 * One message from a customer.
 *
 * On the control plane, because the caller is a transport -- the company is
 * known only from the channel the address named -- and everything written is
 * written with that company and no other.
 */
export async function receiveMessage(channel: OpenChannel, message: InboundMessage): Promise<Received> {
  const decided = await withControlPlane(async (tx) => {
    // One delivery at a time per channel, so two messages arriving together
    // cannot both start work, or both find room under the limit.
    await tx.query('SELECT 1 FROM chat_channels WHERE id = $1 FOR UPDATE', [channel.id]);
    const { rows: [chat] } = await tx.query<{ id: string }>(
      `INSERT INTO chats (company_id, channel_id, external_id, customer_name, customer_handle)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id, external_id) DO UPDATE
         SET customer_name = coalesce(EXCLUDED.customer_name, chats.customer_name),
             customer_handle = coalesce(EXCLUDED.customer_handle, chats.customer_handle)
       RETURNING id`,
      [channel.companyId, channel.id, message.chat, message.customerName, message.customerHandle],
    );
    const chatId = chat!.id;
    const seen = await tx.query<{ id: string; outcome: string; task_id: string | null }>(
      "SELECT id, outcome, task_id FROM chat_messages WHERE chat_id = $1 AND direction = 'in' AND external_id = $2",
      [chatId, message.id],
    );
    const before = seen.rows[0];
    if (before) {
      // Started, but the work was not made: the crash this key is for. The
      // retry makes it, and the key makes it the same work.
      if (before.outcome === 'started' && before.task_id === null) return { start: before.id, chatId };
      return { done: { outcome: 'duplicate' as const, chatId, taskId: before.task_id } };
    }
    await tx.query('UPDATE chats SET last_message_at = now() WHERE id = $1', [chatId]);
    const record = (outcome: 'started' | 'joined' | 'limited', taskId: string | null) => tx.query<{ id: string }>(
      `INSERT INTO chat_messages (company_id, chat_id, direction, external_id, body, attachment, outcome, task_id, subject)
       VALUES ($1, $2, 'in', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [channel.companyId, chatId, message.id, message.text, message.attachment, outcome, taskId, message.subject ?? null],
    );
    // Work this conversation already has, that no worker has picked up: the
    // run will read the whole conversation when it starts, this message too.
    const waiting = await tx.query<{ task_id: string }>(
      `SELECT m.task_id FROM chat_messages m JOIN tasks t ON t.id = m.task_id
        WHERE m.chat_id = $1 AND m.direction = 'in' AND t.status = 'pending'
        ORDER BY m.created_at DESC LIMIT 1`,
      [chatId],
    );
    if (waiting.rows[0]) {
      await record('joined', waiting.rows[0].task_id);
      await appendEvent(tx, {
        companyId: channel.companyId, taskId: waiting.rows[0].task_id, type: 'chat.received', actor: 'system',
        payload: { channelId: channel.id, chatId, outcome: 'joined' },
      });
      return { done: { outcome: 'joined' as const, chatId, taskId: waiting.rows[0].task_id } };
    }
    const { rows: [hour] } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chat_messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.channel_id = $1 AND m.outcome = 'started' AND m.created_at > now() - interval '1 hour'`,
      [channel.id],
    );
    if ((hour?.n ?? 0) >= channel.maxPerHour) {
      await record('limited', null);
      await appendEvent(tx, {
        companyId: channel.companyId, type: 'chat.rate_limited', actor: 'system',
        payload: { channelId: channel.id, chatId, maxPerHour: channel.maxPerHour },
      });
      return { done: { outcome: 'limited' as const, chatId, taskId: null } };
    }
    const { rows: [made] } = await record('started', null);
    return { start: made!.id, chatId };
  });
  if ('done' in decided) return decided.done!;

  const { chatId } = decided;
  const languages = await withTenant(channel.companyId, (tx) => languagesFor(tx, channel.companyId));
  const said = (message.subject ? `Subject: ${message.subject}\n\n` : '') + message.text
    + (message.attachment ? `${message.text ? '\n' : ''}[sent a ${message.attachment}, which cannot be read here]` : '');
  const task = await createRootTask({
    companyId: channel.companyId,
    projectId: channel.projectId,
    divisionId: channel.divisionId,
    roleId: channel.roleId,
    goalId: channel.goalId,
    input: {
      goal: channel.instruction,
      chat: { id: chatId, channel: channel.kind, customer: message.customerName ?? message.customerHandle ?? null },
      event: wrapUntrusted(`${channel.kind}:${channel.account}`, said),
      reply: 'Read the whole conversation with chat.read before you answer: the customer may have written again '
        + 'since this message. Answer with chat.send, in the language the customer writes in -- '
        + `${languageName(languages.work)} when you cannot tell. The owner says yes to every answer before it is sent.`,
    },
    createdBy: 'webhook',
    // The message's own row, so a retry after a crash finds the same work.
    idempotencyKey: `chat:${decided.start}`,
  });
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE chat_messages SET task_id = $2 WHERE id = $1', [decided.start, task.id]);
    await appendEvent(tx, {
      companyId: channel.companyId, projectId: channel.projectId, taskId: task.id, type: 'chat.received', actor: 'system',
      payload: { channelId: channel.id, chatId, outcome: 'started' },
    });
  });
  await withTenant(channel.companyId, (tx) =>
    tx.query('UPDATE roles SET dormant_until = NULL WHERE id = $1', [channel.roleId]));
  await enqueueWake({
    companyId: channel.companyId,
    roleId: channel.roleId,
    reason: 'event',
    detail: `a customer wrote on ${channel.kind}; task ${task.id}`,
  });
  return { outcome: 'started', chatId, taskId: task.id };
}

/**
 * Where a channel will send its work, checked before anything is asked of
 * the transport or sealed: the role and goal are this company's, the goal is
 * open, and there is something to do with each message.
 */
export async function checkChannel(companyId: string, input: {
  roleId: unknown; goalId: unknown; instruction: unknown; maxPerHour?: unknown;
}): Promise<{ roleId: string; goalId: string; divisionId: string; projectId: string; instruction: string; maxPerHour: number }> {
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
  if (!instruction) {
    throw new PalugadaError('contract.violation', 'say what the role should do with each message a customer sends', { field: 'instruction' });
  }
  if (instruction.length > 4_000) {
    throw new PalugadaError('contract.violation', 'what to do with each message is at most 4000 characters', { field: 'instruction' });
  }
  const maxPerHour = input.maxPerHour === undefined || input.maxPerHour === null ? 60 : Number(input.maxPerHour);
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 3_600) {
    throw new PalugadaError('contract.violation', 'the hour\'s limit is a whole number of conversations from 1 to 3600', { field: 'maxPerHour' });
  }
  const roleId = typeof input.roleId === 'string' ? input.roleId : '';
  const goalId = typeof input.goalId === 'string' ? input.goalId : '';
  return withControlPlane(async (tx) => {
    const role = await tx.query<{ division_id: string }>(
      'SELECT division_id FROM roles WHERE id::text = $1 AND company_id = $2', [roleId, companyId]);
    if (!role.rows[0]) throw new PalugadaError('contract.violation', 'no such role in this company', { field: 'roleId' });
    const goal = await tx.query('SELECT 1 FROM goals WHERE id::text = $1 AND company_id = $2', [goalId, companyId]);
    if (goal.rowCount !== 1) throw new PalugadaError('contract.violation', 'no such goal in this company', { field: 'goalId' });
    // A channel opened onto a closed goal would only let work be refused.
    await assertGoalOpen(tx, goalId);
    const project = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE company_id = $1 ORDER BY created_at LIMIT 1', [companyId]);
    if (!project.rows[0]) {
      throw new PalugadaError('contract.violation', 'the company has no project to put the work in', { field: 'projectId' });
    }
    return { roleId, goalId, divisionId: role.rows[0].division_id, projectId: project.rows[0].id, instruction, maxPerHour };
  });
}

/** Refuses a bot that is open for another company: connecting it here would leave that one deaf. */
export async function assertAccountFree(companyId: string, kind: ChatKind, account: string): Promise<void> {
  const { rows } = await withControlPlane((tx) => tx.query(
    'SELECT 1 FROM chat_channels WHERE kind = $1 AND account = $2 AND enabled AND company_id <> $3',
    [kind, account, companyId]));
  if (rows.length > 0) {
    throw new PalugadaError('contract.violation',
      `@${account} already answers for another company; close it there first, or make another bot for this one`,
      { field: 'token' });
  }
}

/**
 * Opens the channel: a new one, or the company's closed one for the same
 * account, again -- with its conversations, at a new address. Returns where
 * the keys it replaces were sealed, for the caller to delete.
 */
export async function openChannel(companyId: string, input: {
  kind: ChatKind; account: string; roleId: string; goalId: string; divisionId: string; projectId: string;
  instruction: string; maxPerHour: number; tokenRef: string; webhookHash: string;
  accountId?: string | null; secretRef?: string | null;
  /** A mailbox: where it is, and where its reading starts. */
  mail?: Record<string, unknown> | null; pollState?: { uidValidity: number; lastUid: number } | null;
}): Promise<{ id: string; publicId: string; replacedRefs: string[] }> {
  return withControlPlane(async (tx) => {
    const { rows: before } = await tx.query<{ id: string; token_ref: string | null; secret_ref: string | null }>(
      'SELECT id, token_ref, secret_ref FROM chat_channels WHERE company_id = $1 AND kind = $2 AND account = $3 FOR UPDATE',
      [companyId, input.kind, input.account]);
    const values = [input.projectId, input.divisionId, input.roleId, input.goalId, input.instruction, input.maxPerHour,
      input.tokenRef, input.webhookHash, input.accountId ?? null, input.secretRef ?? null,
      input.mail ? JSON.stringify(input.mail) : null, input.pollState ? JSON.stringify(input.pollState) : null];
    let opened: { id: string; public_id: string };
    try {
      opened = before[0]
        ? (await tx.query<{ id: string; public_id: string }>(
          `UPDATE chat_channels
              SET project_id = $2, division_id = $3, role_id = $4, goal_id = $5, instruction = $6, max_per_hour = $7,
                  token_ref = $8, webhook_hash = $9, account_id = $10, secret_ref = $11, mail = $12, poll_state = $13,
                  polled_at = NULL, poll_failure = NULL, enabled = true,
                  public_id = replace(gen_random_uuid()::text, '-', '')
            WHERE id = $1 RETURNING id, public_id`,
          [before[0].id, ...values])).rows[0]!
        : (await tx.query<{ id: string; public_id: string }>(
          `INSERT INTO chat_channels (company_id, kind, account, project_id, division_id, role_id, goal_id, instruction,
                                      max_per_hour, token_ref, webhook_hash, account_id, secret_ref, mail, poll_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, public_id`,
          [companyId, input.kind, input.account, ...values])).rows[0]!;
    } catch (failure) {
      // Another company connected the same bot between the check and here.
      if ((failure as { constraint?: string }).constraint === 'chat_channels_one_open_account') {
        throw new PalugadaError('contract.violation',
          `@${input.account} already answers for another company; close it there first, or make another bot for this one`,
          { field: 'token' });
      }
      throw failure;
    }
    await appendEvent(tx, {
      companyId, type: 'chat.channel_connected', actor: 'owner',
      payload: { channelId: opened.id, kind: input.kind, account: input.account, roleId: input.roleId, reopened: Boolean(before[0]) },
    });
    const replacedRefs = [before[0]?.token_ref, before[0]?.secret_ref].filter((ref): ref is string => Boolean(ref));
    return { id: opened.id, publicId: opened.public_id, replacedRefs };
  });
}

/**
 * Closes a channel. Returns its kind and where its keys were sealed, for the
 * caller to let the account go and delete them.
 */
export async function closeChannel(companyId: string, channelId: string): Promise<{
  kind: ChatKind; account: string; tokenRef: string | null; sealedRefs: string[];
}> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ kind: ChatKind; account: string; token_ref: string | null; secret_ref: string | null }>(
      'SELECT kind, account, token_ref, secret_ref FROM chat_channels WHERE id::text = $1 AND company_id = $2 FOR UPDATE',
      [channelId, companyId]);
    const channel = rows[0];
    if (!channel) throw new PalugadaError('contract.violation', 'no such channel in this company', { channelId });
    await tx.query(
      "UPDATE chat_channels SET enabled = false, token_ref = NULL, secret_ref = NULL, webhook_hash = '' WHERE id = $1", [channelId]);
    await appendEvent(tx, {
      companyId, type: 'chat.channel_closed', actor: 'owner',
      payload: { channelId, kind: channel.kind, account: channel.account },
    });
    return {
      kind: channel.kind, account: channel.account, tokenRef: channel.token_ref,
      sealedRefs: [channel.token_ref, channel.secret_ref].filter((ref): ref is string => Boolean(ref)),
    };
  });
}

/** The company's channels, as the owner reads them: never the token, nor where it is sealed. */
export async function channelsOf(companyId: string): Promise<ChannelView[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; kind: ChatKind; account: string; role_id: string; role_name: string; goal_id: string; instruction: string;
      max_per_hour: number; enabled: boolean; chats: number; last_at: Date | null; created_at: Date;
      polled_at: Date | null; poll_failure: string | null;
    }>(
      `SELECT c.id, c.kind, c.account, c.role_id, coalesce(r.display_name, r.title, r.slug) AS role_name, c.goal_id,
              c.instruction, c.max_per_hour, c.enabled, c.created_at, c.polled_at, c.poll_failure,
              (SELECT count(*)::int FROM chats h WHERE h.channel_id = c.id) AS chats,
              (SELECT max(h.last_message_at) FROM chats h WHERE h.channel_id = c.id) AS last_at
         FROM chat_channels c JOIN roles r ON r.id = c.role_id
        ORDER BY c.created_at`,
    );
    return rows.map((row) => ({
      id: row.id, kind: row.kind, account: row.account, roleId: row.role_id, roleName: row.role_name, goalId: row.goal_id,
      instruction: row.instruction, maxPerHour: row.max_per_hour, enabled: row.enabled, chats: row.chats,
      lastMessageAt: row.last_at, createdAt: row.created_at, checkedAt: row.polled_at, failure: row.poll_failure,
    }));
  });
}

/**
 * The chat a piece of work answers: the one whose message started or joined
 * it, or the work it was handed on from.
 */
export async function chatOfTask(tx: TenantClient, taskId: string): Promise<string | null> {
  const { rows } = await tx.query<{ chat_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_task_id, 0 AS depth FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_task_id, chain.depth + 1
         FROM tasks t JOIN chain ON t.id = chain.parent_task_id
        WHERE chain.depth < 64
     )
     SELECT m.chat_id FROM chat_messages m JOIN chain ON m.task_id = chain.id
      WHERE m.direction = 'in'
      ORDER BY chain.depth, m.created_at DESC
      LIMIT 1`,
    [taskId],
  );
  return rows[0]?.chat_id ?? null;
}

const CHAT_COLUMNS = `
  h.id, h.channel_id, c.kind, c.account, c.enabled, h.customer_name, h.customer_handle, h.last_message_at,
  last.direction AS last_direction, last.body AS last_body, last.attachment AS last_attachment`;

const CHAT_FROM = `
  FROM chats h JOIN chat_channels c ON c.id = h.channel_id
  LEFT JOIN LATERAL (
    SELECT m.direction, m.body, m.attachment FROM chat_messages m
     WHERE m.chat_id = h.id ORDER BY m.created_at DESC LIMIT 1
  ) last ON true`;

interface ChatRow {
  id: string; channel_id: string; kind: ChatKind; account: string; enabled: boolean;
  customer_name: string | null; customer_handle: string | null; last_message_at: Date;
  last_direction: 'in' | 'out' | null; last_body: string | null; last_attachment: string | null;
}

function chatView(row: ChatRow): ChatView {
  return {
    id: row.id, channelId: row.channel_id, kind: row.kind, account: row.account, open: row.enabled,
    customerName: row.customer_name, customerHandle: row.customer_handle, lastMessageAt: row.last_message_at,
    lastMessage: row.last_direction
      ? { direction: row.last_direction, body: row.last_body ?? '', attachment: row.last_attachment }
      : null,
    unanswered: row.last_direction === 'in',
  };
}

/** The company's conversations, the latest first; or only the one a piece of work answers. */
export async function chatsOf(companyId: string, options: { taskId?: string } = {}): Promise<ChatView[]> {
  return withTenant(companyId, async (tx) => {
    if (options.taskId !== undefined) {
      if (!/^[0-9a-f-]{36}$/.test(options.taskId)) return [];
      const chatId = await chatOfTask(tx, options.taskId);
      if (!chatId) return [];
      const { rows } = await tx.query<ChatRow>(`SELECT ${CHAT_COLUMNS} ${CHAT_FROM} WHERE h.id = $1`, [chatId]);
      return rows.map(chatView);
    }
    const { rows } = await tx.query<ChatRow>(
      `SELECT ${CHAT_COLUMNS} ${CHAT_FROM} ORDER BY h.last_message_at DESC LIMIT 200`);
    return rows.map(chatView);
  });
}

/** One conversation and what was said in it, oldest first: the last two hundred messages. */
export async function chatWith(tx: TenantClient, chatId: string, limit = MESSAGES_SHOWN): Promise<{ chat: ChatView; messages: MessageView[] } | null> {
  if (!/^[0-9a-f-]{36}$/.test(chatId)) return null;
  const { rows } = await tx.query<ChatRow>(`SELECT ${CHAT_COLUMNS} ${CHAT_FROM} WHERE h.id = $1`, [chatId]);
  if (!rows[0]) return null;
  const { rows: messages } = await tx.query<{
    id: string; direction: 'in' | 'out'; body: string; attachment: string | null; outcome: MessageView['outcome'];
    task_id: string | null; external_id: string | null; created_at: Date; subject: string | null;
  }>(
    `SELECT * FROM (
       SELECT id, direction, body, attachment, outcome, task_id, external_id, created_at, subject
         FROM chat_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2
     ) recent ORDER BY created_at`,
    [chatId, limit],
  );
  return {
    chat: chatView(rows[0]),
    messages: messages.map((row) => ({
      id: row.id, direction: row.direction, body: row.body, attachment: row.attachment, subject: row.subject, outcome: row.outcome,
      taskId: row.task_id, sent: row.direction === 'in' || row.external_id !== null, at: row.created_at,
    })),
  };
}
