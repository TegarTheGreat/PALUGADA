/**
 * The message channel (PRD v2 F10.9, F10.10).
 *
 * F10.9 makes a chat — Telegram, WhatsApp, Signal — a *notification and action*
 * surface for three things: an escalation, a skill candidate, and a review at
 * tier 2 or below. F10.10 then carves tier 3 out of it entirely: the chat shows
 * a link, and the approval happens in the app. `channelDelivery` already
 * decides which of the two an item gets; this is the surface that obeys it.
 *
 * Telegram rather than the other two because its Bot API is the one an owner
 * can be running in five minutes with no business verification, no vendor
 * review and no per-message cost — and because inline keyboards are exactly
 * what "balasan lewat tombol inline" asks for. WhatsApp and Signal are the
 * same shape behind a different HTTP call: `MessageChannel` is what they would
 * implement, and the rules are here rather than in it.
 *
 * **Inbound is where a chat channel gets dangerous, so read this part.** A
 * button press arrives as an HTTP request from the internet, and three things
 * stand between it and a decision on the owner's behalf:
 *
 *   1. **The webhook secret.** Telegram sends a header the bot chose; a
 *      request without it is not from Telegram. Compared in constant time,
 *      because it is a shared secret and a length-and-prefix oracle is enough
 *      to find one.
 *   2. **The chat id.** A bot is reachable by anyone who learns its name, so
 *      "it came from Telegram" is not "it came from the owner". Only the
 *      configured chat may press anything, and a press from anywhere else is
 *      recorded as a security event rather than quietly dropped — somebody
 *      finding the bot is worth knowing about.
 *   3. **The tier.** `decide` refuses tier 3 over `chat` regardless, so even a
 *      forged press cannot approve an irreversible action. That check is not
 *      here on purpose: it belongs where every channel meets it.
 *
 * The three are in that order because each is cheaper than the next and
 * because the last is the one that must not be reachable by getting the first
 * two right.
 */
import { timingSafeEqual } from 'node:crypto';
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { redactor } from '../secrets/manager.ts';
import { PalugadaError } from '../errors.ts';
import * as inbox from '../inbox/inbox.ts';
import type { DeliveryResult, NotifiableItem, OwnerChannel } from './notify.ts';

export interface TelegramOptions {
  /** The bot token, already resolved from the secret manager. */
  token: string;
  /** The owner's chat. The only chat that may press anything. */
  chatId: string;
  /** The header value Telegram is configured to send back. */
  webhookSecret?: string;
  /** Deep link into the owner's app, for the items a chat may not act on. */
  appUrl?: (item: NotifiableItem) => string | null;
  apiBase?: string;
  timeoutMs?: number;
  name?: string;
  fetch?: typeof globalThis.fetch;
}

/** What a callback button carries. Parsed back on the way in. */
export interface ButtonAction {
  itemId: string;
  decision: inbox.Decision;
}

export const CALLBACK_PREFIX = 'palugada';

export function encodeAction(action: ButtonAction): string {
  return `${CALLBACK_PREFIX}:${action.itemId}:${action.decision}`;
}

/**
 * Reads a button press, or refuses to.
 *
 * Returns null rather than throwing for anything unrecognised: a chat receives
 * presses from old messages, other bots' formats and people experimenting, and
 * none of those is an error worth an exception. What *is* an error — a
 * well-formed press from the wrong chat — is handled by the caller, which has
 * the context to record it.
 */
export function decodeAction(data: string): ButtonAction | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null;
  const [, itemId, decision] = parts;
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'ask') return null;
  if (!/^[0-9a-f-]{36}$/.test(itemId!)) return null;
  return { itemId: itemId!, decision };
}

/** The slice of a Telegram update this cares about. */
export interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id: number | string }; message_id?: number };
    from?: { id: number | string; username?: string };
  };
}

export class TelegramChannel implements OwnerChannel {
  readonly name: string;
  readonly #options: TelegramOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: TelegramOptions) {
    this.name = options.name ?? 'chat:telegram';
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    // The token is in every URL this module builds, so an error quoting a URL
    // is an error quoting the token.
    redactor.register(options.token);
    if (options.webhookSecret) redactor.register(options.webhookSecret);
  }

  /**
   * A chat carries everything the owner may be shown.
   *
   * Not the same question as whether they may *act* on it: F10.9's three kinds
   * get buttons and everything else gets a link, and `channelDelivery` has
   * already made that call by the time an item reaches here. An item it
   * answered `none` for never arrives, so there is nothing left to filter.
   */
  carries(): boolean {
    return true;
  }

  /**
   * The message, and the buttons if there are any.
   *
   * Separated from `deliver` so the shape can be asserted without a network:
   * "does a tier 3 approval arrive with an approve button" is the single most
   * important thing about this module, and it should not need an HTTP server
   * to answer.
   */
  render(item: NotifiableItem): { text: string; reply_markup?: unknown } {
    const lines = [
      `*${escapeMarkdown(item.title)}*`,
      '',
      escapeMarkdown(item.actionSummary),
    ];
    if (item.consequenceIfDenied) {
      lines.push('', `_If denied:_ ${escapeMarkdown(item.consequenceIfDenied)}`);
    }

    if (item.delivery === 'link_only') {
      // F10.10. The chat says what happened and where to go; it does not offer
      // a way to say yes. A tier 3 approval with no link is still correct —
      // the owner opens the app — so a deployment without one is not broken.
      lines.push('', escapeMarkdown('This one is decided in the app.'));
      return {
        text: lines.join('\n'),
        ...(item.url
          ? { reply_markup: { inline_keyboard: [[{ text: 'Open in PALUGADA', url: item.url }]] } }
          : {}),
      };
    }

    return {
      text: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: encodeAction({ itemId: item.id, decision: 'approve' }) },
          { text: 'Deny', callback_data: encodeAction({ itemId: item.id, decision: 'deny' }) },
          { text: 'Ask', callback_data: encodeAction({ itemId: item.id, decision: 'ask' }) },
        ]],
      },
    };
  }

  async deliver(item: NotifiableItem): Promise<DeliveryResult> {
    const withLink = item.url ? item : { ...item, url: this.#options.appUrl?.(item) ?? null };
    const sent = await this.#call<{ message_id?: number }>('sendMessage', {
      chat_id: this.#options.chatId,
      parse_mode: 'MarkdownV2',
      ...this.render(withLink),
    });
    return sent.message_id ? { ref: String(sent.message_id) } : {};
  }

  /**
   * F10.6's digest, as a plain message with nothing to press.
   *
   * No buttons, deliberately. F10.9 names three kinds a chat is an action
   * surface for and a digest is not one of them -- it is a summary of a day
   * that has already happened, so there is nothing here to decide.
   */
  async deliverDigest(digest: { day: string; text: string }): Promise<void> {
    await this.#call('sendMessage', {
      chat_id: this.#options.chatId,
      parse_mode: 'MarkdownV2',
      text: escapeMarkdown(digest.text),
    });
  }

  /**
   * Checks the header Telegram was told to send.
   *
   * Constant time, because it is a shared secret and an attacker who can learn
   * "the first four bytes were right" can learn the rest one byte at a time.
   */
  authenticWebhook(secretHeader: string | undefined): boolean {
    const expected = this.#options.webhookSecret;
    // A channel configured without a secret cannot tell Telegram from anyone
    // else, and saying so is better than pretending: the caller can refuse.
    if (!expected) return false;
    const a = Buffer.from(secretHeader ?? '');
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Turns a button press into the owner's decision.
   *
   * `decide` is called with `channel: 'chat'` and no second factor, which is
   * what makes F10.10 hold: a tier 3 item is refused there whatever this
   * function does, and a press that somehow reached one gets the refusal
   * rather than a special case here. That is on purpose — a second
   * implementation of "not over chat" is a second thing that can be wrong.
   */
  async onCallback(
    companyId: string,
    update: TelegramUpdate,
    options: { secretHeader?: string } = {},
  ): Promise<{ handled: boolean; reason?: string }> {
    if (!this.authenticWebhook(options.secretHeader)) {
      return { handled: false, reason: 'webhook_secret' };
    }

    const query = update.callback_query;
    if (!query?.data) return { handled: false, reason: 'not_a_button' };

    const action = decodeAction(query.data);
    if (!action) return { handled: false, reason: 'not_a_button' };

    // The bot is reachable by anyone who learns its name, so "Telegram sent
    // it" is not "the owner sent it". A well-formed press from another chat is
    // somebody who found the bot, which is worth a security event rather than
    // a silent drop.
    const from = String(query.message?.chat?.id ?? query.from?.id ?? '');
    if (from !== String(this.#options.chatId)) {
      await withTenant(companyId, async (tx) => {
        await appendEvent(tx, {
          companyId,
          type: 'security.chat_stranger_refused',
          actor: 'system',
          payload: {
            inboxItemId: action.itemId,
            decision: action.decision,
            chatId: from,
            username: query.from?.username ?? null,
          },
        });
      });
      await this.#answer(query.id, 'This bot only answers to its owner.');
      return { handled: false, reason: 'wrong_chat' };
    }

    try {
      await inbox.decide(companyId, action.itemId, action.decision, 'via chat', {
        channel: 'chat',
      });
      await this.#answer(query.id, `Recorded: ${action.decision}.`);
      return { handled: true };
    } catch (error) {
      const refusal =
        error instanceof PalugadaError && error.code === 'approval.channel_forbidden'
          ? 'That one has to be approved in the app.'
          : 'That could not be recorded.';
      await this.#answer(query.id, refusal);
      return {
        handled: false,
        reason: error instanceof PalugadaError ? error.code : 'failed',
      };
    }
  }

  /** Clears the spinner on the pressed button. Failure here is cosmetic. */
  async #answer(callbackQueryId: string, text: string): Promise<void> {
    await this.#call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    }).catch(() => undefined);
  }

  async #call<T>(method: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 10_000);
    const base = this.#options.apiBase ?? 'https://api.telegram.org';
    try {
      const response = await this.#fetch(`${base}/bot${this.#options.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const answer = (await response.json().catch(() => null)) as
        | { ok?: boolean; description?: string; result?: T }
        | null;
      if (!response.ok || !answer?.ok) {
        // Telegram puts the reason in `description` and returns 200 for some
        // of them, so the status alone is not the answer.
        throw new Error(
          `telegram ${method} failed: ${answer?.description ?? `HTTP ${response.status}`}`,
        );
      }
      return answer.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Escapes MarkdownV2, which is stricter than anyone expects.
 *
 * Telegram rejects the whole message when an unescaped reserved character
 * appears anywhere in it, and an item's title is whatever an agent wrote. So
 * an escalation whose title happens to contain a hyphen would not have failed
 * to render -- it would have failed to *send*, and the owner would never have
 * learned there was an escalation.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (char) => `\\${char}`);
}
