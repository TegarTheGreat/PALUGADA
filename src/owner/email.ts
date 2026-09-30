/**
 * Email as a place the owner is told things (F10.9's sending half; the
 * competitive analysis of 2026-09-30, item 10).
 *
 * Through a sending service's API rather than SMTP: each is one HTTPS
 * request with a key, where SMTP is a conversation, a TLS upgrade and a
 * dependency. An email carries no buttons anyone should trust -- a link in
 * one can be forwarded, previewed by a scanner, clicked by a filter -- so an
 * approval says what is waiting and links to the console, where F10.10 wants
 * a decision made anyway. Telegram and WhatsApp remain the channels that can
 * decide.
 *
 * Each provider's address, header and body are as its reference gives them,
 * and each address and header was confirmed by the 401 it answers a key
 * that is not one (September 2026). None was sent a real message from here.
 */
import { say } from './say.ts';
import { redactor } from '../secrets/manager.ts';
import type { DeliveryResult, DoneNotice, NotifiableItem, OwnerChannel } from './notify.ts';

export type EmailProviderId = 'resend' | 'postmark' | 'sendgrid';

export interface EmailProvider {
  id: EmailProviderId;
  name: string;
  keyUrl: string;
  /** Its API's origin, and the path a message is posted to. */
  origin: string;
  path: string;
}

export const EMAIL_PROVIDERS: readonly EmailProvider[] = [
  { id: 'resend', name: 'Resend', keyUrl: 'https://resend.com/api-keys', origin: 'https://api.resend.com', path: '/emails' },
  {
    id: 'postmark', name: 'Postmark', keyUrl: 'https://account.postmarkapp.com/servers',
    origin: 'https://api.postmarkapp.com', path: '/email',
  },
  {
    id: 'sendgrid', name: 'SendGrid', keyUrl: 'https://app.sendgrid.com/settings/api_keys',
    origin: 'https://api.sendgrid.com', path: '/v3/mail/send',
  },
];

export function emailProvider(id: string): EmailProvider | undefined {
  return EMAIL_PROVIDERS.find((one) => one.id === id);
}

/** An address as a person types one: something, an at, a domain with a dot. Not RFC 5322, and not meant to be. */
export function emailAddress(text: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(text) && text.length <= 254;
}

export interface EmailOptions {
  provider: EmailProviderId;
  key: string;
  /** Who it is from: an address the provider has verified for this account. */
  from: string;
  /** The owner's address. */
  to: string;
  /** Deep link into the console, for an item that has none of its own. */
  appUrl?: (item: NotifiableItem) => string | null;
  /** Another origin for the provider's API: a test's, or a proxy's (`PALUGADA_EMAIL_API`). */
  apiBase?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class EmailChannel implements OwnerChannel {
  readonly name = 'email';
  readonly #options: EmailOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: EmailOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    redactor.register(options.key);
  }

  /** Everything the owner may be shown, as a chat does; the owner's hours are the dispatcher's to keep. */
  carries(): boolean {
    return true;
  }

  /** The subject and the text of an item: what waits, what denying it costs, and where to decide it. */
  render(item: NotifiableItem): { subject: string; text: string } {
    const lines = [item.actionSummary];
    if (item.question) lines.push('', item.question);
    if (item.consequenceIfDenied) lines.push('', `${say(item.language, 'If denied:')} ${item.consequenceIfDenied}`);
    const url = item.url ?? this.#options.appUrl?.(item) ?? null;
    if (url) lines.push('', `${say(item.language, 'Open in PALUGADA')}: ${url}`);
    return { subject: item.title.slice(0, 200), text: lines.join('\n') };
  }

  async deliver(item: NotifiableItem): Promise<DeliveryResult> {
    const { subject, text } = this.render(item);
    const ref = await this.send(subject, text);
    return ref ? { ref } : {};
  }

  async deliverDigest(digest: { companyId: string; day: string; text: string }): Promise<void> {
    const first = digest.text.split('\n').find((line) => line.trim()) ?? digest.day;
    await this.send(first.replace(/[*_#`]/g, '').slice(0, 200), digest.text);
  }

  async deliverNotice(notice: DoneNotice): Promise<DeliveryResult> {
    const first = notice.text.split('\n').find((line) => line.trim()) ?? notice.text;
    const body = notice.url ? `${notice.text}\n\n${say(notice.language, 'Open in PALUGADA')}: ${notice.url}` : notice.text;
    const ref = await this.send(first.slice(0, 200), body);
    return ref ? { ref } : {};
  }

  /** One message, as the provider takes it. Answers the provider's id for it, when it gives one. */
  async send(subject: string, text: string): Promise<string | null> {
    const { provider, key, from, to } = this.#options;
    const service = emailProvider(provider)!;
    const url = `${(this.#options.apiBase ?? service.origin).replace(/\/+$/, '')}${service.path}`;
    const request = ((): { headers: Record<string, string>; body: unknown } => {
      switch (provider) {
        case 'resend':
          return {
            headers: { authorization: `Bearer ${key}` },
            body: { from, to: [to], subject, text },
          };
        case 'postmark':
          return {
            headers: { 'x-postmark-server-token': key, accept: 'application/json' },
            body: { From: from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' },
          };
        case 'sendgrid':
          return {
            headers: { authorization: `Bearer ${key}` },
            body: {
              personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject,
              content: [{ type: 'text/plain', value: text }],
            },
          };
      }
    })();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'PALUGADA/1.0 (+orchestrator)', ...request.headers },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000),
      });
    } catch (failure) {
      throw new Error(`${service.name} could not be reached: ${redactor.redact((failure as Error).message)}`);
    }
    if (!response.ok) {
      const detail = redactor.redact((await response.text().catch(() => '')).slice(0, 300));
      throw new Error(response.status === 401 || response.status === 403
        ? `${service.name} refused the key (${response.status}): set it again in the console, under This deployment, Channels`
        : `${service.name} refused the message (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    // Resend answers `id`, Postmark `MessageID`; SendGrid answers 202 with no body and its id in a header.
    const answer = (await response.json().catch(() => null)) as { id?: unknown; MessageID?: unknown } | null;
    const id = answer?.id ?? answer?.MessageID ?? response.headers.get('x-message-id');
    return typeof id === 'string' && id ? id : null;
  }
}
