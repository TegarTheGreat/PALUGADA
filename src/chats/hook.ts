/**
 * Where a transport posts what customers write (`/api/chat-hooks/:publicId`).
 *
 * Open, because a transport has no session; what stands in for one is the
 * channel's secret, checked before the body is read for anything. The
 * address of a closed channel is not there at all: telling a caller "closed"
 * would tell them the address was once good.
 */
import { PalugadaError } from '../errors.ts';
import type { HookHeaders } from '../scheduler/triggers.ts';
import { channelAt, receiveMessage, recordRefusal, secretMatches, type Received } from './chats.ts';
import { customerMessage, TELEGRAM_SECRET_HEADER } from './telegram.ts';

export type ChatHookAnswer = Received | { outcome: 'ignored'; reason: string };

function header(headers: HookHeaders, name: string): string | null {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : null;
}

export async function receiveChatHook(publicId: string, delivery: { raw: Buffer; headers: HookHeaders }): Promise<ChatHookAnswer> {
  const channel = await channelAt(publicId);
  if (!channel) throw new PalugadaError('hook.unknown', 'no such hook', {});
  if (!secretMatches(channel, header(delivery.headers, TELEGRAM_SECRET_HEADER))) {
    await recordRefusal(channel, header(delivery.headers, TELEGRAM_SECRET_HEADER) ? 'wrong secret' : 'no secret');
    throw new PalugadaError('hook.refused', 'that delivery is not from Telegram', {});
  }
  let update: unknown;
  try {
    update = JSON.parse(delivery.raw.toString('utf8'));
  } catch {
    // From Telegram, by its secret, and not JSON: nothing a retry would mend.
    return { outcome: 'ignored', reason: 'not JSON' };
  }
  const message = customerMessage(update);
  if ('ignored' in message) return { outcome: 'ignored', reason: message.ignored };
  return receiveMessage(channel, message);
}
