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
 * thing it was, with its caption. A file is fetched with the bot's own token
 * once the message is claimed (`telegramFile`) and kept where a mailed one is
 * (attachments.ts); a sticker, a place or a contact card is said, not kept.
 */
import { PalugadaError } from '../errors.ts';
import { redactor } from '../secrets/manager.ts';
import { telegramApi, type BotApi } from '../owner/telegram.ts';
import { readReceived } from './attachments.ts';
import type { InboundMedia, InboundMessage } from './chats.ts';

/** The header Telegram sends the webhook's secret in. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** What arrives that is not text, by the field Telegram puts it in. */
const ATTACHMENTS = ['photo', 'voice', 'audio', 'video', 'video_note', 'document', 'sticker', 'animation', 'location', 'contact'] as const;

/**
 * What arrives as a file, by the field Telegram puts it in: the word it is
 * said with, and what it is when Telegram does not say (a photo is always a
 * JPEG; a voice note, Ogg). The kind kept is read from the bytes, not this.
 */
const FILES: Record<string, { kind: string; mime: string }> = {
  photo: { kind: 'photo', mime: 'image/jpeg' },
  document: { kind: 'document', mime: 'application/octet-stream' },
  voice: { kind: 'voice', mime: 'audio/ogg' },
  audio: { kind: 'voice', mime: 'audio/mpeg' },
  video: { kind: 'video', mime: 'video/mp4' },
  video_note: { kind: 'video', mime: 'video/mp4' },
  animation: { kind: 'video', mime: 'video/mp4' },
};

/** Fetches one of a message's files by Telegram's id for it. */
export type FetchTelegramFile = (fileId: string) => Promise<Buffer>;

/** The most of one message kept; Telegram's own limit is 4096 characters. */
const TEXT_MAX = 4_096;

interface TelegramUser { id?: unknown; is_bot?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown }

/**
 * A customer's message, or why the update is not one. Its file, when it
 * carries one, is fetched by `fetchFile` when the platform keeps it, and not
 * before: a message that is a duplicate, or past the hour's limit, fetches
 * nothing.
 */
export function customerMessage(update: unknown, fetchFile?: FetchTelegramFile): InboundMessage | { ignored: string } {
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
  const media = fileOf(message, fetchFile);
  return {
    chat: String(chat.id),
    id: String(message.message_id),
    customerName: name ? name.slice(0, 200) : null,
    customerHandle: typeof from.username === 'string' && from.username ? from.username.slice(0, 64) : null,
    text: text.slice(0, TEXT_MAX),
    attachment,
    ...(media ? { media: [media] } : {}),
  };
}

/** The file a message carries, if any: Telegram sends one a message, and an album as several messages. */
function fileOf(message: Record<string, unknown>, fetchFile: FetchTelegramFile | undefined): InboundMedia | null {
  const field = Object.keys(FILES).find((key) => message[key] !== undefined);
  if (!field) return null;
  // A photo arrives in several sizes, smallest first: the largest is the photo.
  const raw = field === 'photo'
    ? [...(Array.isArray(message.photo) ? message.photo as Array<Record<string, unknown>> : [])]
      .sort((a, b) => Number(a.file_size ?? 0) - Number(b.file_size ?? 0)).at(-1)
    : message[field] as Record<string, unknown> | undefined;
  const fileId = typeof raw?.file_id === 'string' ? raw.file_id : null;
  if (!raw || !fileId) return null;
  const { kind, mime } = FILES[field]!;
  return {
    kind,
    name: typeof raw.file_name === 'string' ? raw.file_name : null,
    mime: typeof raw.mime_type === 'string' ? raw.mime_type : mime,
    size: typeof raw.file_size === 'number' ? raw.file_size : null,
    get: fetchFile ? () => fetchFile(fileId) : null,
  };
}

/**
 * Fetches a file a customer sent the bot: Telegram is asked where it is, and
 * it is read from there to at most the size a received file may be. The
 * token is in both addresses, so it is given to the redactor first: an error
 * quoting an address would quote it.
 */
export async function telegramFile(token: string, fileId: string, api: BotApi = {}): Promise<Buffer> {
  redactor.register(token);
  const file = await telegramApi<{ file_path?: unknown }>(token, 'getFile', { file_id: fileId }, api);
  const path = typeof file.file_path === 'string' ? file.file_path : '';
  // Telegram gives no path for a file over the 20 MB it hands a bot.
  if (!path || !/^[\w./-]+$/.test(path) || path.includes('..')) throw new Error('Telegram did not say where the file is');
  let response: Response;
  try {
    response = await (api.fetch ?? globalThis.fetch)(`${api.apiBase ?? 'https://api.telegram.org'}/file/bot${token}/${path}`, {
      signal: AbortSignal.timeout(60_000),
    });
  } catch (failure) {
    throw new Error(`Telegram could not be reached: ${(failure as Error).message}`);
  }
  if (!response.ok) throw new Error(`Telegram did not hand it over (HTTP ${response.status})`);
  return readReceived(response);
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
