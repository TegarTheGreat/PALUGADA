/**
 * Telegram as a customer channel (0111): a bot of the company's own, made in
 * @BotFather and connected by the owner.
 *
 * The owner's own Telegram (`owner/telegram.ts`) is a different bot with a
 * different job -- buttons that decide -- and shares only the Bot API call
 * with this. Here a delivery is a customer's message, so what stands between
 * it and the company's work is:
 *
 *   1. **The secret Telegram was given** with `setWebhook`, sent back in a
 *      header with every delivery and compared in constant time against its
 *      hash. A request without it is not from Telegram.
 *   2. **A customer in their own chat with the bot.** A bot can be added to a
 *      group, where everyone's messages arrive; a group is not one customer,
 *      and another bot is not a customer at all. Both are acknowledged, so
 *      Telegram does not send them again, and start nothing.
 *
 * What is not text -- a photo, a voice note, a file -- is kept as the kind of
 * thing it was, with its caption, and the run is told it cannot read it.
 */
import { PalugadaError } from '../errors.ts';
import { telegramApi, type BotApi } from '../owner/telegram.ts';
import type { InboundMessage } from './chats.ts';

/** The header Telegram sends the webhook's secret in. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** What arrives that is not text, by the field Telegram puts it in. */
const ATTACHMENTS = ['photo', 'voice', 'audio', 'video', 'video_note', 'document', 'sticker', 'animation', 'location', 'contact'] as const;

/** The most of one message kept; Telegram's own limit is 4096 characters. */
const TEXT_MAX = 4_096;

interface TelegramUser { id?: unknown; is_bot?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown }

/** A customer's message, or why the update is not one. */
export function customerMessage(update: unknown): InboundMessage | { ignored: string } {
  if (typeof update !== 'object' || update === null) return { ignored: 'not an update' };
  const message = (update as { message?: Record<string, unknown> }).message;
  if (typeof message !== 'object' || message === null) return { ignored: 'not a new message' };
  const chat = message.chat as { id?: unknown; type?: unknown } | undefined;
  const from = message.from as TelegramUser | undefined;
  if (chat?.type !== 'private') return { ignored: 'not a private chat' };
  if (!from || from.is_bot === true) return { ignored: 'not a person' };
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return { ignored: 'no chat' };
  if (typeof message.message_id !== 'number') return { ignored: 'no message id' };
  const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
  const attachment = ATTACHMENTS.find((kind) => message[kind] !== undefined) ?? (text ? null : 'something');
  const name = [from.first_name, from.last_name].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' ');
  return {
    chat: String(chat.id),
    id: String(message.message_id),
    customerName: name ? name.slice(0, 200) : null,
    customerHandle: typeof from.username === 'string' && from.username ? from.username.slice(0, 64) : null,
    text: text.slice(0, TEXT_MAX),
    attachment,
  };
}

/**
 * Sends a reply into a customer's chat, as plain text: a reply is the run's
 * words, and Telegram's markup would read some of them as formatting.
 * Returns the id Telegram gave it.
 */
export async function sendToCustomer(token: string, chat: string, text: string, api: BotApi = {}): Promise<string> {
  let sent: { message_id?: unknown };
  try {
    sent = await telegramApi<{ message_id?: unknown }>(token, 'sendMessage', { chat_id: chat, text }, api);
  } catch (failure) {
    const status = (failure as Error & { status?: number }).status;
    const said = (failure as Error).message;
    if (status === undefined) throw new PalugadaError('capability.unreachable', said, { transport: 'telegram' });
    if (status === 401) {
      throw new PalugadaError('credential.unavailable',
        `${said}; the owner connects the channel again with the bot's new token`, { transport: 'telegram' });
    }
    if (status === 429 || status >= 500) throw new PalugadaError('capability.unreachable', said, { transport: 'telegram' });
    // 403 when the customer blocked the bot, 400 when the chat is gone: the
    // reply cannot be sent, and sending it again will not change that.
    throw new PalugadaError('contract.violation', said, { transport: 'telegram' });
  }
  if (typeof sent.message_id !== 'number') {
    throw new PalugadaError('capability.unreachable', 'Telegram answered without the id of the message it sent', { transport: 'telegram' });
  }
  return String(sent.message_id);
}
