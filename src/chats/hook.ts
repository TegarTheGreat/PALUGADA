/**
 * Where a transport posts what customers write (`/api/chat-hooks/:publicId`).
 *
 * Open, because a transport has no session; what stands in for one is the
 * channel's own proof -- Telegram's secret header, Meta's signature -- checked
 * before the body is read for anything. The address of a closed channel is
 * not there at all: telling a caller "closed" would tell them the address was
 * once good.
 */
import { PalugadaError } from '../errors.ts';
import type { HookHeaders } from '../scheduler/triggers.ts';
import type { SecretManager } from '../secrets/manager.ts';
import { channelAt, receiveMessage, recordRefusal, secretMatches, type OpenChannel, type Received } from './chats.ts';
import { customerMessage, TELEGRAM_SECRET_HEADER } from './telegram.ts';
import { customerMessages, signedByMeta, WHATSAPP_SIGNATURE_HEADER } from './whatsapp.ts';

export type ChatHookAnswer =
  | Received
  | { outcome: 'ignored'; reason: string }
  /** WhatsApp: a delivery may carry several messages, or none for this number. */
  | { outcome: 'received'; messages: Received[] };

function header(headers: HookHeaders, name: string): string | null {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : null;
}

function parsed(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function receiveChatHook(
  publicId: string,
  delivery: { raw: Buffer; headers: HookHeaders },
  secrets?: SecretManager,
): Promise<ChatHookAnswer> {
  const channel = await channelAt(publicId);
  if (!channel) throw new PalugadaError('hook.unknown', 'no such hook', {});
  if (channel.kind === 'whatsapp') return receiveWhatsApp(channel, delivery, secrets);

  if (!secretMatches(channel, header(delivery.headers, TELEGRAM_SECRET_HEADER))) {
    await recordRefusal(channel, header(delivery.headers, TELEGRAM_SECRET_HEADER) ? 'wrong secret' : 'no secret');
    throw new PalugadaError('hook.refused', 'that delivery is not from Telegram', {});
  }
  const update = parsed(delivery.raw);
  // From Telegram, by its secret, and not JSON: nothing a retry would mend.
  if (update === undefined) return { outcome: 'ignored', reason: 'not JSON' };
  const message = customerMessage(update);
  if ('ignored' in message) return { outcome: 'ignored', reason: message.ignored };
  return receiveMessage(channel, message);
}

async function receiveWhatsApp(
  channel: OpenChannel,
  delivery: { raw: Buffer; headers: HookHeaders },
  secrets: SecretManager | undefined,
): Promise<ChatHookAnswer> {
  let appSecret: string;
  try {
    if (!secrets || !channel.secretRef) throw new Error('this deployment has no secret store');
    appSecret = await secrets.resolve(channel.secretRef);
  } catch {
    // The deployment's fault, not Meta's: 503, so Meta -- which sends a
    // delivery again for days -- delivers it once the secret opens again.
    throw new PalugadaError('hook.unavailable', 'this channel cannot check deliveries right now; retry later', {});
  }
  const signature = header(delivery.headers, WHATSAPP_SIGNATURE_HEADER);
  if (!signedByMeta(appSecret, delivery.raw, signature)) {
    await recordRefusal(channel, signature ? 'wrong signature' : 'no signature');
    throw new PalugadaError('hook.refused', 'that delivery is not signed by Meta', {});
  }
  const body = parsed(delivery.raw);
  if (body === undefined) return { outcome: 'ignored', reason: 'not JSON' };
  const messages: Received[] = [];
  // One at a time, in the order they came: the second message of a
  // conversation joins the work the first one started.
  for (const message of customerMessages(body, channel.accountId ?? '')) messages.push(await receiveMessage(channel, message));
  return { outcome: 'received', messages };
}

/**
 * Meta's check when the owner saves the webhook in the app: the challenge
 * back, for this channel's verify token only. A challenge is a number; one
 * that is not is not echoed.
 */
export async function verifyChatHook(publicId: string, query: URLSearchParams): Promise<string> {
  const channel = await channelAt(publicId);
  if (!channel || channel.kind !== 'whatsapp') throw new PalugadaError('hook.unknown', 'no such hook', {});
  const challenge = query.get('hub.challenge') ?? '';
  if (query.get('hub.mode') !== 'subscribe' || !/^[\w-]{1,128}$/.test(challenge)
      || !secretMatches(channel, query.get('hub.verify_token'))) {
    throw new PalugadaError('hook.refused', 'that is not this channel\'s verify token', {});
  }
  return challenge;
}
