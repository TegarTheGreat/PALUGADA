/**
 * Slack and Discord as places the owner is told things (F10.9's sending half).
 *
 * Both take a message posted to an incoming webhook: an address the owner
 * makes in the workspace, which is all the credential there is -- anyone
 * holding it can post there -- so it is kept sealed like a key. Neither
 * carries buttons: a webhook message cannot be acted on and cannot be
 * answered, so an approval says what is waiting and links to the console,
 * which is where F10.10 wants a decision made anyway. Telegram remains the
 * channel that can decide.
 */
import { say } from './say.ts';
import { redactor } from '../secrets/manager.ts';
import type { DeliveryResult, NotifiableItem, OwnerChannel } from './notify.ts';

export type WebhookChatKind = 'slack' | 'discord';

export interface WebhookChatOptions {
  kind: WebhookChatKind;
  /** The incoming webhook's address, already resolved from the secret store. */
  url: string;
  /** Deep link into the console, for an item that has none of its own. */
  appUrl?: (item: NotifiableItem) => string | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Where each keeps its incoming webhooks, for the console to say what to paste. */
export const WEBHOOK_HOSTS: Readonly<Record<WebhookChatKind, RegExp>> = {
  slack: /^https:\/\/hooks\.slack\.com\/services\//,
  discord: /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//,
};

export class WebhookChatChannel implements OwnerChannel {
  readonly name: string;
  readonly #options: WebhookChatOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: WebhookChatOptions) {
    this.name = `chat:${options.kind}`;
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    // The address is the credential, and a transport error can quote it.
    redactor.register(options.url);
  }

  /** Everything the owner may be shown, as a chat does; the owner's hours are the dispatcher's to keep. */
  carries(): boolean {
    return true;
  }

  /** The text, in each one's own markup: Slack's `*bold*` and `<url|label>`, Discord's `**bold**`. */
  render(item: NotifiableItem): string {
    const slack = this.#options.kind === 'slack';
    const bold = (text: string) => (slack ? `*${text}*` : `**${text}**`);
    const lines = [bold(item.title), item.actionSummary];
    if (item.consequenceIfDenied) lines.push(`${say(item.language, 'If denied:')} ${item.consequenceIfDenied}`);
    const url = item.url ?? this.#options.appUrl?.(item) ?? null;
    if (url) {
      const label = say(item.language, 'Open in PALUGADA');
      lines.push(slack ? `<${url}|${label}>` : `${label}: ${url}`);
    }
    return lines.join('\n');
  }

  async deliver(item: NotifiableItem): Promise<DeliveryResult> {
    await this.send(this.render(item));
    return {};
  }

  async deliverDigest(digest: { companyId: string; day: string; text: string }): Promise<void> {
    await this.send(digest.text);
  }

  /** One message: Slack reads `text`, Discord `content`, which it caps at 2,000 characters. */
  async send(text: string): Promise<void> {
    const body = this.#options.kind === 'slack' ? { text } : { content: text.slice(0, 2_000) };
    const response = await this.#fetch(this.#options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`${this.#options.kind} refused the message (${response.status})${detail ? `: ${detail}` : ''}`);
    }
  }
}
