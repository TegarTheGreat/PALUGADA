/**
 * WhatsApp as a customer channel (0112): the company's WhatsApp Business
 * number, through Meta's Cloud API.
 *
 * In Indonesia a shop's customers are on WhatsApp. The owner's own WhatsApp
 * (`owner/whatsapp.ts`) is the same API with a different job, and shares only
 * its check of a number with this. What stands between a delivery and the
 * company's work:
 *
 *   1. **Meta's signature.** Every delivery is signed with the Meta app's
 *      secret (`X-Hub-Signature-256`), an HMAC over the bytes that arrived,
 *      checked in constant time before anything in them is read.
 *   2. **This channel's number.** One Meta app may carry several numbers and
 *      sends all of them to one address; a delivery for another is not this
 *      channel's, and is acknowledged without being read.
 *   3. **A customer's message.** Statuses of what was sent, reactions and
 *      what WhatsApp itself says are not messages to answer.
 *
 * And what is WhatsApp's alone: a business may reply only within 24 hours of
 * the customer's last message (after that, only with a template Meta
 * approved). `chat.send` refuses a reply past that before anything is sent,
 * since WhatsApp accepts the call and reports the failure later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import { redactor } from '../secrets/manager.ts';
import { GRAPH_API } from '../owner/whatsapp.ts';
import type { InboundMessage } from './chats.ts';

/** The header Meta signs a delivery in. */
export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';

/** How long after the customer last wrote a business may still reply without a template. */
export const WHATSAPP_REPLY_WINDOW_HOURS = 24;

export interface GraphApi {
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * What arrives that is not text, by WhatsApp's type, in the words Telegram's
 * transport uses, so the console and the run say each the same way whichever
 * channel it came on.
 */
const ATTACHMENTS: Record<string, string> = {
  image: 'photo', video: 'video', document: 'document', audio: 'voice', sticker: 'sticker',
  location: 'location', contacts: 'contact',
};

/** The most of one message kept; WhatsApp's own limit is 4096 characters. */
const TEXT_MAX = 4_096;

/** Whether Meta signed these bytes with the app's secret. */
export function signedByMeta(appSecret: string, raw: Buffer, header: string | null): boolean {
  const given = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '');
  if (!given) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const presented = Buffer.from(given[1]!, 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The customers' messages in a delivery, to the number `accountId` names, in the order they came. */
export function customerMessages(delivery: unknown, accountId: string): InboundMessage[] {
  const found: InboundMessage[] = [];
  for (const entry of list((delivery as { entry?: unknown } | null)?.entry)) {
    for (const change of list((entry as { changes?: unknown }).changes)) {
      const { field, value } = change as { field?: unknown; value?: Record<string, unknown> };
      if (field !== 'messages' || !value) continue;
      if (String((value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id ?? '') !== accountId) continue;
      const names = new Map<string, string>();
      for (const contact of list(value.contacts)) {
        const { wa_id: wa, profile } = contact as { wa_id?: unknown; profile?: { name?: unknown } };
        if (typeof wa === 'string' && typeof profile?.name === 'string' && profile.name.trim()) names.set(wa, profile.name.trim());
      }
      for (const one of list(value.messages)) {
        const message = one as Record<string, unknown>;
        const from = message.from;
        const id = message.id;
        if (typeof from !== 'string' || !/^\d{5,20}$/.test(from) || typeof id !== 'string' || !id) continue;
        const type = String(message.type ?? '');
        const part = (message[type] ?? {}) as Record<string, unknown>;
        let text = '';
        let attachment: string | null = null;
        if (type === 'text') text = String(part.body ?? '');
        else if (type === 'button') text = String(part.text ?? '');
        else if (type === 'interactive') {
          const chosen = (part.button_reply ?? part.list_reply) as { title?: unknown } | undefined;
          text = String(chosen?.title ?? '');
        } else if (type in ATTACHMENTS) {
          text = typeof part.caption === 'string' ? part.caption : '';
          attachment = ATTACHMENTS[type]!;
        } else {
          // A reaction, a status of WhatsApp's own, a message type this
          // platform does not know: nothing a customer asked.
          continue;
        }
        if (!text && !attachment) continue;
        found.push({
          chat: from,
          id: id.slice(0, 200),
          customerName: names.get(from)?.slice(0, 200) ?? null,
          customerHandle: from,
          text: text.slice(0, TEXT_MAX),
          attachment,
        });
      }
    }
  }
  return found;
}

/**
 * Sends a reply from the company's number, as plain text with no link
 * preview: a preview fetches the link from Meta's servers, which is a request
 * the customer did not ask for. Returns the id WhatsApp gave it.
 */
export async function sendFromNumber(token: string, accountId: string, to: string, text: string, api: GraphApi = {}): Promise<string> {
  redactor.register(token);
  const base = (api.apiBase ?? GRAPH_API).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await (api.fetch ?? globalThis.fetch)(`${base}/${encodeURIComponent(accountId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: false },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (failure) {
    throw new PalugadaError('capability.unreachable', `WhatsApp could not be reached: ${(failure as Error).message}`, { transport: 'whatsapp' });
  }
  const answer = (await response.json().catch(() => null)) as
    | { messages?: Array<{ id?: unknown }>; error?: { message?: string; code?: number } }
    | null;
  if (!response.ok || answer?.error) {
    const code = answer?.error?.code;
    const said = redactor.redact(`WhatsApp refused the reply: ${answer?.error?.message ?? `HTTP ${response.status}`}${code === undefined ? '' : ` (code ${code})`}`);
    if (response.status === 401 || code === 190) {
      throw new PalugadaError('credential.unavailable', `${said}; the owner connects the number again with a new token`, { transport: 'whatsapp' });
    }
    if (response.status === 429 || response.status >= 500 || code === 130429 || code === 131016) {
      throw new PalugadaError('capability.unreachable', said, { transport: 'whatsapp' });
    }
    throw new PalugadaError('contract.violation', said, { transport: 'whatsapp' });
  }
  const id = answer?.messages?.[0]?.id;
  if (typeof id !== 'string' || !id) {
    throw new PalugadaError('capability.unreachable', 'WhatsApp answered without the id of the message it sent', { transport: 'whatsapp' });
  }
  return id;
}
