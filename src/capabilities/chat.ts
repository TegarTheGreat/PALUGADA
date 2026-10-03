/**
 * `chat.read` and `chat.send`: a run reads a customer's conversation and
 * answers it (0111, `src/chats/`).
 *
 * Both name the conversation by itself when the work began with a customer's
 * message: the run that answers Sari answers Sari, and a model that had to
 * copy a conversation's id from its input is a model that can copy the wrong
 * one. Another of the company's conversations can be named, for work handed
 * on or a follow-up the owner asked for -- never a customer who has not
 * written: a bot cannot start a conversation, and neither can this.
 *
 * `chat.send` is tier 2: nothing unsends a message a customer has read. It is
 * kept by the broker's key before it is sent, so a run done again after a
 * crash finds the reply it already sent rather than sending it twice; and it
 * is read back as the transport answered it, since a bot cannot fetch a
 * message it sent.
 */
import { PalugadaError } from '../errors.ts';
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import type { SecretManager } from '../secrets/manager.ts';
import type { BotApi } from '../owner/telegram.ts';
import { chatOfTask, chatWith } from '../chats/chats.ts';
import { sendToCustomer } from '../chats/telegram.ts';
import { sendFromNumber, WHATSAPP_REPLY_WINDOW_HOURS, type GraphApi } from '../chats/whatsapp.ts';

export interface ChatOptions {
  /** Where each channel's token is sealed (`db://chat-…`). */
  secrets: SecretManager;
  /** Where the Bot API is, for a deployment that points it elsewhere. */
  telegram?: BotApi;
  /** Where Meta's Graph API is, likewise. */
  whatsapp?: GraphApi;
}

/** The longest reply Telegram or WhatsApp takes in one message. */
const REPLY_MAX = 4_096;

const CHAT_ID = {
  type: 'string',
  pattern: '^[0-9a-f-]{36}$',
  description: 'Which conversation. Leave it out to mean the one this work began with.',
};

async function chatFor(tx: TenantClient, ctx: CapabilityContext, named: string | undefined): Promise<string> {
  const chatId = named ?? await chatOfTask(tx, ctx.taskId);
  if (!chatId) {
    throw new PalugadaError('contract.violation',
      'this work did not begin with a customer\'s message; name the conversation with chatId', { field: 'chatId' });
  }
  return chatId;
}

export interface ChatReadResult {
  chatId: string;
  channel: string;
  account: string;
  customer: string | null;
  handle: string | null;
  messages: Array<{ from: 'customer' | 'company'; text: string; attachment?: string; at: string }>;
}

export function chatRead(): Capability<{ chatId?: string; limit?: number }, ChatReadResult> {
  return {
    name: 'chat.read',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: CHAT_ID,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'The latest this many messages; 50 unless said.' },
      },
      additionalProperties: false,
    },
    adapter: 'platform',
    defaultTier: 0,
    // What a customer wrote, in their words.
    readsOutside: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      return withTenant(ctx.companyId, async (tx) => {
        const chatId = await chatFor(tx, ctx, input.chatId);
        const found = await chatWith(tx, chatId, input.limit ?? 50);
        if (!found) throw new PalugadaError('contract.violation', 'no such conversation in this company', { field: 'chatId' });
        return {
          chatId,
          channel: found.chat.kind,
          account: found.chat.account,
          customer: found.chat.customerName,
          handle: found.chat.customerHandle,
          messages: found.messages.filter((message) => message.sent).map((message) => ({
            from: message.direction === 'in' ? 'customer' as const : 'company' as const,
            text: message.body,
            ...(message.attachment ? { attachment: `${message.attachment}, which cannot be read here` } : {}),
            at: message.at.toISOString(),
          })),
        };
      });
    },
  };
}

export interface ChatSendResult {
  messageId: string;
  /** The transport's id for the reply. */
  externalId: string;
  /** False when an earlier attempt of the same step had already sent it. */
  sent: boolean;
}

export function chatSend(options: ChatOptions): Capability<{ text: string; chatId?: string }, ChatSendResult> {
  return {
    name: 'chat.send',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: REPLY_MAX, description: 'The reply, as the customer will read it: plain text.' },
        chatId: CHAT_ID,
      },
      additionalProperties: false,
    },
    adapter: 'platform',
    defaultTier: 2,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const text = String(input.text ?? '').trim();
      if (!text || text.length > REPLY_MAX) {
        throw new PalugadaError('contract.violation', `a reply is 1 to ${REPLY_MAX} characters`, { field: 'text' });
      }
      const ready = await withTenant(ctx.companyId, async (tx) => {
        const chatId = await chatFor(tx, ctx, input.chatId);
        const { rows: [chat] } = await tx.query<{
          external_id: string; kind: string; account: string; enabled: boolean; token_ref: string | null;
          account_id: string | null; last_in: Date | null;
        }>(
          `SELECT h.external_id, c.kind, c.account, c.enabled, c.token_ref, c.account_id,
                  (SELECT max(m.created_at) FROM chat_messages m WHERE m.chat_id = h.id AND m.direction = 'in') AS last_in
             FROM chats h JOIN chat_channels c ON c.id = h.channel_id WHERE h.id = $1`,
          [chatId]);
        if (!chat) throw new PalugadaError('contract.violation', 'no such conversation in this company', { field: 'chatId' });
        const { rows: [before] } = await tx.query<{ id: string; external_id: string | null }>(
          "SELECT id, external_id FROM chat_messages WHERE chat_id = $1 AND direction = 'out' AND idempotency_key = $2",
          [chatId, ctx.idempotencyKey]);
        if (before?.external_id) return { done: { messageId: before.id, externalId: before.external_id, sent: false } };
        const named = chat.kind === 'whatsapp' ? `+${chat.account}` : `@${chat.account}`;
        if (!chat.enabled || !chat.token_ref) {
          throw new PalugadaError('contract.violation',
            `the channel ${named} is closed; the owner connects it again on Customers before anything is sent`,
            { field: 'chatId' });
        }
        // WhatsApp accepts a reply past its window and reports the failure
        // later, in a status, where nobody is waiting for it: refused here,
        // with the reason, before anything is sent.
        const window = WHATSAPP_REPLY_WINDOW_HOURS * 3_600_000;
        if (chat.kind === 'whatsapp' && (!chat.last_in || Date.now() - chat.last_in.getTime() > window)) {
          throw new PalugadaError('contract.violation',
            `WhatsApp takes a reply only within ${WHATSAPP_REPLY_WINDOW_HOURS} hours of the customer's last message, and this `
              + `customer last wrote ${chat.last_in ? chat.last_in.toISOString() : 'never'}; the reply waits for them to write again`,
            { field: 'chatId' });
        }
        // Kept before it is sent, under the step's key. A row with no
        // transport id is an attempt that may or may not have reached the
        // customer; Telegram cannot be asked which, so it is sent again.
        const messageId = before?.id ?? (await tx.query<{ id: string }>(
          `INSERT INTO chat_messages (company_id, chat_id, direction, body, task_id, idempotency_key)
           VALUES ($1, $2, 'out', $3, $4, $5) RETURNING id`,
          [ctx.companyId, chatId, text, ctx.taskId, ctx.idempotencyKey])).rows[0]!.id;
        return { send: { chatId, messageId, chat: chat.external_id, tokenRef: chat.token_ref, kind: chat.kind, accountId: chat.account_id } };
      });
      if ('done' in ready) return ready.done!;
      const { chatId, messageId, chat, tokenRef, kind, accountId } = ready.send;
      const token = await options.secrets.resolve(tokenRef);
      const externalId = kind === 'whatsapp'
        ? await sendFromNumber(token, accountId ?? '', chat, text, options.whatsapp ?? {})
        : await sendToCustomer(token, chat, text, options.telegram ?? {});
      await withTenant(ctx.companyId, async (tx) => {
        await tx.query('UPDATE chat_messages SET external_id = $2 WHERE id = $1', [messageId, externalId]);
        await tx.query('UPDATE chats SET last_message_at = now() WHERE id = $1', [chatId]);
      });
      return { messageId, externalId, sent: true };
    },
    async verify(input, result, ctx) {
      // A bot cannot read back what it sent; what can be checked is that the
      // record says what was asked, under the id Telegram gave it.
      return withTenant(ctx.companyId, async (tx) => {
        const { rows } = await tx.query<{ body: string; external_id: string | null }>(
          "SELECT body, external_id FROM chat_messages WHERE id = $1 AND direction = 'out'", [result.messageId]);
        return rows[0]?.external_id === result.externalId && rows[0].body === String(input.text ?? '').trim();
      });
    },
  };
}

/** Both, bound to where the channels' tokens are sealed. */
export function chatCapabilities(options: ChatOptions): Array<Capability<never, never>> {
  return [chatRead() as unknown as Capability<never, never>, chatSend(options) as unknown as Capability<never, never>];
}
