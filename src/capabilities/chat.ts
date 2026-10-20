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
import { sendFromMailbox, type MailOptions, type MailSettings } from '../chats/mail.ts';
import { composeReply, replySubject } from '../chats/smtp.ts';
import { AnswerCheck } from '../chats/answer-check.ts';
import { passagesNamed, type PassageRef } from '../knowledge/documents.ts';
import type { LlmClient } from '../llm/client.ts';
import type { Clearance } from '../broker/registry.ts';
import { isPalugadaError } from '../errors.ts';
import type { FileTextReader } from './files.ts';

export interface ChatOptions {
  /** Where each channel's token is sealed (`db://chat-…`). */
  secrets: SecretManager;
  /** Where the Bot API is, for a deployment that points it elsewhere. */
  telegram?: BotApi;
  /** Where Meta's Graph API is, likewise. */
  whatsapp?: GraphApi;
  /** For a mailbox: a certificate authority to trust besides the system's. */
  mail?: MailOptions;
  /**
   * The model that checks a reply a channel would send on its own (STATUS
   * 2.137). Without one, nothing is answered on its own.
   */
  answers?: { llm: LlmClient; model?: string };
}

/** A reply on its own names this many passages at most. */
const SOURCES_MAX = 5;
/** Answers on its own in one conversation within an hour, past which the owner is asked. */
const ALONE_PER_HOUR = 6;
/** What a reply on its own is checked against of what the customer wrote: their latest messages. */
const CUSTOMER_MESSAGES = 10;

const SOURCES = {
  type: 'array',
  maxItems: SOURCES_MAX,
  items: {
    type: 'object',
    required: ['document', 'place'],
    properties: {
      document: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
      place: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  description: 'The passages of documents marked for customers this reply answers from, as memory.search gives them '
    + '(document and place). Where the channel answers on its own, a reply that names them, says nothing they do not '
    + 'and decides nothing that is the owner\'s goes without waiting for the owner.',
};

/** Every figure in a text, its digits alone: "Rp 18.000" and "18000" are one figure, as are "08.00" and "0800". */
function figuresOf(text: string): Array<{ said: string; digits: string }> {
  return [...text.matchAll(/\d(?:[\d.,:]*\d)?/g)].map((match) => ({ said: match[0], digits: match[0].replace(/[.,:]/g, '') }));
}

/**
 * Every mail address and link in a text, a bare domain among them --
 * "bit.ly/promo" is a link a customer can follow as surely as one with
 * https:// in front.
 */
function addressesOf(text: string): string[] {
  return [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b(?:\/[^\s<>"]*)?/gi)]
    .map((match) => match[0].replace(/[.,;:!?)]+$/, ''));
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

/** One file a customer sent, as a run reads it: where it is kept, or why it is not, and what a document says. */
export interface ChatReadFile {
  kind: string;
  /** What the sender called it: theirs, so data. */
  name: string | null;
  /** Where it is kept in the company's files; null when it was not kept. */
  path: string | null;
  bytes: number;
  note?: string;
  /** What a PDF, a Word document, a workbook or a text file says, when it was read. */
  text?: string;
  textNote?: string;
}

export interface ChatReadResult {
  chatId: string;
  channel: string;
  account: string;
  customer: string | null;
  handle: string | null;
  messages: Array<{ from: 'customer' | 'company'; text: string; attachment?: string; files?: ChatReadFile[]; subject?: string; at: string }>;
}

/**
 * What of a customer's files `chat.read` reads for the run: the documents of
 * their latest messages, a few, and a few thousand characters of each. The rest
 * is offered by path. Reading is the platform's, in the sandboxed browser, so
 * the role that answers customers needs no `files.read` -- which would let it
 * read every file the company has, to answer one customer.
 */
const READ_MESSAGES = 5;
const READ_FILES = 3;
const READ_CHARS = 12_000;
const READABLE = new Set(['pdf', 'word', 'excel', 'text']);

export function chatRead(reader?: FileTextReader): Capability<{ chatId?: string; limit?: number }, ChatReadResult> {
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
    // What a customer wrote, in their words, and what they attached.
    readsOutside: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const { chatId, found } = await withTenant(ctx.companyId, async (tx) => {
        const chatId = await chatFor(tx, ctx, input.chatId);
        const found = await chatWith(tx, chatId, input.limit ?? 50);
        if (!found) throw new PalugadaError('contract.violation', 'no such conversation in this company', { field: 'chatId' });
        return { chatId, found };
      });
      // Outside the transaction: a document is converted in a browser, which takes seconds.
      const said = found.messages.filter((message) => message.sent);
      const recent = said.filter((message) => message.direction === 'in' && message.files.length > 0).slice(-READ_MESSAGES);
      const texts = new Map<string, Pick<ChatReadFile, 'text' | 'textNote'>>();
      let reading = 0;
      for (const message of [...recent].reverse()) {
        for (const file of message.files) {
          if (!file.path || !READABLE.has(file.kind)) continue;
          if (reading >= READ_FILES) {
            texts.set(file.path, { textNote: `only the ${READ_FILES} newest documents are read at once: read this one with files.read, or ask again` });
            continue;
          }
          reading += 1;
          if (!reader) {
            texts.set(file.path, { textNote: 'this deployment cannot read files' });
            continue;
          }
          try {
            const read = await reader(ctx.companyId, file.path, ctx.signal);
            texts.set(file.path, read.text.length > READ_CHARS
              ? { text: read.text.slice(0, READ_CHARS), textNote: `only the first ${READ_CHARS.toLocaleString('en-US')} of ${read.text.length.toLocaleString('en-US')} characters are shown` }
              : { text: read.text });
          } catch (failure) {
            texts.set(file.path, {
              textNote: isPalugadaError(failure, 'capability.busy') ? 'the browser that reads documents is busy: ask again in a minute' : (failure as Error).message.slice(0, 300),
            });
          }
        }
      }
      return {
        chatId,
        channel: found.chat.kind,
        account: found.chat.account,
        customer: found.chat.customerName,
        handle: found.chat.customerHandle,
        messages: said.map((message) => ({
          from: message.direction === 'in' ? 'customer' as const : 'company' as const,
          text: message.body,
          // A file that was kept is a path below; what this platform could not keep is said below too.
          ...(message.attachment && message.files.length === 0 ? { attachment: `${message.attachment}, which cannot be read here` } : {}),
          ...(message.files.length > 0 ? {
            files: message.files.map((file): ChatReadFile => ({
              kind: file.kind, name: file.name, path: file.path, bytes: file.bytes,
              ...(file.note ? { note: file.note } : {}),
              ...(file.path ? texts.get(file.path) ?? {} : {}),
            })),
          } : {}),
          ...(message.subject ? { subject: message.subject } : {}),
          at: message.at.toISOString(),
        })),
      };
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

export function chatSend(options: ChatOptions): Capability<{ text: string; chatId?: string; sources?: PassageRef[] }, ChatSendResult> {
  const check = options.answers ? new AnswerCheck(options.answers.llm, options.answers.model ? { model: options.answers.model } : {}) : null;
  return {
    name: 'chat.send',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: REPLY_MAX, description: 'The reply, as the customer will read it: plain text.' },
        chatId: CHAT_ID,
        sources: SOURCES,
      },
      additionalProperties: false,
    },
    adapter: 'platform',
    defaultTier: 2,
    describe: () => ({ moneyCents: 0 }),
    /**
     * Whether this reply may go without the owner (STATUS 2.137): where the
     * owner let the channel answer on its own, to the customer who wrote,
     * from passages of documents the owner marked for customers -- read
     * again here -- with no figure or address those passages and the
     * customer did not give, six an hour at most, and the check's yes.
     */
    async clearsOutside(input, ctx): Promise<Clearance> {
      const text = String(input.text ?? '').trim();
      const found = await withTenant(ctx.companyId, async (tx) => {
        const own = await chatOfTask(tx, ctx.taskId);
        const chatId = input.chatId ?? own;
        if (!chatId) return { why: 'off' } as const;
        const { rows: [channel] } = await tx.query<{ answers_alone: boolean }>(
          'SELECT c.answers_alone FROM chats h JOIN chat_channels c ON c.id = h.channel_id WHERE h.id = $1', [chatId]);
        if (!channel?.answers_alone) return { why: 'off' } as const;
        if (!own || chatId !== own) return { why: 'other_conversation' } as const;
        const refs = Array.isArray(input.sources) ? input.sources.slice(0, SOURCES_MAX) : [];
        const passages = refs.length > 0 ? await passagesNamed(tx, ctx.divisionId, refs) : [];
        if (passages.length === 0 || passages.length !== refs.length) return { why: 'no_sources' } as const;
        if (passages.some((passage) => !passage.forCustomers)) return { why: 'not_for_customers' } as const;
        const { rows: said } = await tx.query<{ body: string }>(
          `SELECT body FROM (SELECT body, created_at FROM chat_messages WHERE chat_id = $1 AND direction = 'in'
                              ORDER BY created_at DESC LIMIT $2) latest ORDER BY created_at`,
          [chatId, CUSTOMER_MESSAGES]);
        const { rows: [recent] } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM chat_messages
            WHERE chat_id = $1 AND direction = 'out' AND grounds IS NOT NULL AND created_at > now() - interval '1 hour'`,
          [chatId]);
        return { passages, customer: said.map((row) => row.body).join('\n'), recent: recent?.n ?? 0 };
      });
      if ('why' in found) return { cleared: false, why: found.why };

      // What the reply says that nothing it answers from said: refused here,
      // before any model is asked, whatever a model would have made of it.
      const known = `${found.passages.map((passage) => `${passage.heading ?? ''}\n${passage.body}`).join('\n')}\n${found.customer}`;
      const knownFigures = new Set(figuresOf(known).map((figure) => figure.digits));
      const stray = figuresOf(text).find((figure) => !knownFigures.has(figure.digits));
      if (stray) return { cleared: false, why: 'figures', detail: stray.said.slice(0, 40) };
      const lowered = known.toLowerCase();
      const address = addressesOf(text).find((one) => !lowered.includes(one.toLowerCase()));
      if (address) return { cleared: false, why: 'addresses', detail: address.slice(0, 120) };
      if (found.recent >= ALONE_PER_HOUR) return { cleared: false, why: 'too_many' };
      if (!check) return { cleared: false, why: 'check_failed' };

      const verdict = await check.check({
        companyId: ctx.companyId, taskId: ctx.taskId, customer: found.customer, reply: text,
        passages: found.passages.map((passage) => ({ title: passage.title, heading: passage.heading, body: passage.body })),
      });
      if (verdict.failed) return { cleared: false, why: 'check_failed' };
      if (!verdict.send) return { cleared: false, why: verdict.category };
      return {
        cleared: true,
        record: { grounds: found.passages.map((passage) => ({ document: passage.documentId, title: passage.title, place: passage.passage })) },
      };
    },
    async execute(input, ctx) {
      const text = String(input.text ?? '').trim();
      if (!text || text.length > REPLY_MAX) {
        throw new PalugadaError('contract.violation', `a reply is 1 to ${REPLY_MAX} characters`, { field: 'text' });
      }
      const ready = await withTenant(ctx.companyId, async (tx) => {
        const chatId = await chatFor(tx, ctx, input.chatId);
        const { rows: [chat] } = await tx.query<{
          external_id: string; kind: string; account: string; enabled: boolean; token_ref: string | null;
          account_id: string | null; last_in: Date | null; mail: MailSettings | null;
          last_subject: string | null; last_id: string | null;
        }>(
          `SELECT h.external_id, c.kind, c.account, c.enabled, c.token_ref, c.account_id, c.mail,
                  last.created_at AS last_in, last.subject AS last_subject, last.external_id AS last_id
             FROM chats h JOIN chat_channels c ON c.id = h.channel_id
             LEFT JOIN LATERAL (
               SELECT m.created_at, m.subject, m.external_id FROM chat_messages m
                WHERE m.chat_id = h.id AND m.direction = 'in' ORDER BY m.created_at DESC LIMIT 1
             ) last ON true
            WHERE h.id = $1`,
          [chatId]);
        if (!chat) throw new PalugadaError('contract.violation', 'no such conversation in this company', { field: 'chatId' });
        const { rows: [before] } = await tx.query<{ id: string; external_id: string | null }>(
          "SELECT id, external_id FROM chat_messages WHERE chat_id = $1 AND direction = 'out' AND idempotency_key = $2",
          [chatId, ctx.idempotencyKey]);
        if (before?.external_id) return { done: { messageId: before.id, externalId: before.external_id, sent: false } };
        const named = chat.kind === 'whatsapp' ? `+${chat.account}` : chat.kind === 'email' ? chat.account : `@${chat.account}`;
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
        // A mail is a reply in the customer's thread: "Re:" their subject.
        const subject = chat.kind === 'email' ? replySubject(chat.last_subject) : null;
        // A reply that went on its own keeps what it answered from (0117).
        const grounds = (ctx.clearance as { grounds?: unknown } | undefined)?.grounds ?? null;
        const messageId = before?.id ?? (await tx.query<{ id: string }>(
          `INSERT INTO chat_messages (company_id, chat_id, direction, body, task_id, idempotency_key, subject, grounds)
           VALUES ($1, $2, 'out', $3, $4, $5, $6, $7) RETURNING id`,
          [ctx.companyId, chatId, text, ctx.taskId, ctx.idempotencyKey, subject, grounds ? JSON.stringify(grounds) : null])).rows[0]!.id;
        return {
          send: {
            chatId, messageId, chat: chat.external_id, tokenRef: chat.token_ref, kind: chat.kind, accountId: chat.account_id,
            account: chat.account, mail: chat.mail, subject, inReplyTo: chat.last_id,
          },
        };
      });
      if ('done' in ready) return ready.done!;
      const { chatId, messageId, chat, tokenRef, kind, accountId } = ready.send;
      const token = await options.secrets.resolve(tokenRef);
      let externalId: string;
      if (kind === 'email' && ready.send.mail) {
        // The message's own Message-ID is what a customer's answer names, so
        // it is the reply's id here.
        const reply = composeReply({
          from: ready.send.account, to: chat, subject: ready.send.subject ?? 'Re:', text,
          inReplyTo: ready.send.inReplyTo?.startsWith('<') ? ready.send.inReplyTo : null,
        });
        await sendFromMailbox(ready.send.mail, token, { from: ready.send.account, to: chat, raw: reply.raw }, options.mail ?? {});
        externalId = reply.messageId;
      } else {
        externalId = kind === 'whatsapp'
          ? await sendFromNumber(token, accountId ?? '', chat, text, options.whatsapp ?? {})
          : await sendToCustomer(token, chat, text, options.telegram ?? {});
      }
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
export function chatCapabilities(options: ChatOptions, reader?: FileTextReader): Array<Capability<never, never>> {
  return [chatRead(reader) as unknown as Capability<never, never>, chatSend(options) as unknown as Capability<never, never>];
}
