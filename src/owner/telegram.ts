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
 *   2. **Who pressed.** A bot is reachable by anyone who learns its name, so
 *      "it came from Telegram" is not "it came from the owner". Only the
 *      configured owner may press anything -- the person, not the chat: in a
 *      group every member presses in the same chat, and a check on the chat
 *      let all of them decide. A press from anyone else is recorded as a
 *      security event rather than quietly dropped — somebody finding the bot
 *      is worth knowing about.
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
import { closureText } from './notify.ts';
import { say } from './say.ts';
import { deploymentLanguages } from '../domain/language.ts';
import type {
  ClosedItem, DeliveryResult, DoneNotice, NotifiableItem, OwnerChannel, RetractOutcome,
} from './notify.ts';

export interface TelegramOptions {
  /** The bot token, already resolved from the secret manager. */
  token: string;
  /**
   * The owner's own chat with the bot, whose id is the owner's user id. The
   * only person who may press anything.
   */
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
  /** Which of a question's choices was pressed; its text is read from the item, never from the button. */
  choice?: number;
}

export const CALLBACK_PREFIX = 'palugada';

export function encodeAction(action: ButtonAction): string {
  // A choice is `c<n>` in the decision's place: Telegram allows sixty-four
  // bytes of callback data and a fourth part would not fit a uuid beside it.
  const decision = action.choice === undefined ? action.decision : `c${action.choice}`;
  return `${CALLBACK_PREFIX}:${action.itemId}:${decision}`;
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
  if (!/^[0-9a-f-]{36}$/.test(itemId!)) return null;
  const choice = /^c([0-5])$/.exec(decision!);
  if (choice) return { itemId: itemId!, decision: 'approve', choice: Number(choice[1]) };
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'ask') return null;
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
  /** A message the owner typed: only a reply to an "Ask" prompt means anything. */
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string };
    from?: { id: number | string; username?: string };
    reply_to_message?: { message_id?: number; text?: string; from?: { is_bot?: boolean } };
  };
}

/**
 * How an "Ask" prompt names its item, as the last line of the prompt.
 *
 * Telegram hands a reply back with the text of the message it answers, so the
 * prompt carries its own item and nothing has to remember which prompt was
 * about what. It is not an authority: the reply is still only the owner's if
 * the owner sent it, and the item is still only asked if it is open.
 */
const ASK_REFERENCE = /(?:^|\n)(ref|answer) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The longest question a chat reply may carry, the same bound as the app's. */
const QUESTION_MAX = 2_000;

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
      lines.push('', `_${escapeMarkdown(say(item.language, 'If denied:'))}_ ${escapeMarkdown(item.consequenceIfDenied)}`);
    }

    if (item.delivery === 'link_only') {
      // F10.10. The chat says what happened and where to go; it does not offer
      // a way to say yes. A tier 3 approval with no link is still correct —
      // the owner opens the app — so a deployment without one is not broken.
      lines.push('', escapeMarkdown(say(item.language, 'This one is decided in the app.')));
      return {
        text: lines.join('\n'),
        ...(item.url
          ? { reply_markup: { inline_keyboard: [[{ text: say(item.language, 'Open in PALUGADA'), url: item.url }]] } }
          : {}),
      };
    }

    // A run's question is answered, not approved: "Answer" asks for the words
    // and records them on the yes; "Stop" is the no that cancels the task.
    if (item.question) {
      // Choices, when the run offered some, one to a row so each can be read
      // whole; the words are still there for an answer that is none of them.
      const choices = (item.options ?? []).map((option, index) => [
        { text: option, callback_data: encodeAction({ itemId: item.id, decision: 'approve', choice: index }) },
      ]);
      return {
        text: lines.join('\n'),
        reply_markup: {
          inline_keyboard: [
            ...choices,
            [
              {
                text: say(item.language, choices.length > 0 ? 'Answer in words' : 'Answer'),
                callback_data: encodeAction({ itemId: item.id, decision: 'approve' }),
              },
              { text: say(item.language, 'Stop the task'), callback_data: encodeAction({ itemId: item.id, decision: 'deny' }) },
            ],
          ],
        },
      };
    }

    return {
      text: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: say(item.language, 'Approve'), callback_data: encodeAction({ itemId: item.id, decision: 'approve' }) },
          { text: say(item.language, 'Deny'), callback_data: encodeAction({ itemId: item.id, decision: 'deny' }) },
          { text: say(item.language, 'Ask'), callback_data: encodeAction({ itemId: item.id, decision: 'ask' }) },
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
   * Work the owner gave has finished (0059): news, so nothing to press --
   * only a way to open the task, when there is an address to open it at.
   */
  async deliverNotice(notice: DoneNotice): Promise<DeliveryResult> {
    const sent = await this.#call<{ message_id?: number }>('sendMessage', {
      chat_id: this.#options.chatId,
      parse_mode: 'MarkdownV2',
      text: escapeMarkdown(notice.text),
      ...(notice.url
        ? { reply_markup: { inline_keyboard: [[{ text: say(notice.language, 'Open in PALUGADA'), url: notice.url }]] } }
        : {}),
    });
    return sent.message_id ? { ref: String(sent.message_id) } : {};
  }

  /**
   * Replaces a closed item's message with what happened to it.
   *
   * `editMessageText` without a `reply_markup` is what removes the inline
   * keyboard -- Telegram drops the buttons of an edited message unless new
   * ones are given -- so the text and the disarming are one call and cannot
   * half-succeed.
   *
   * Three of Telegram's refusals mean there is nothing to fix rather than
   * that the edit failed: the owner deleted the message, it can no longer be
   * edited, or it already says this. Treating those as failures would spend
   * the retry budget on a message that is not there.
   */
  async retract(closed: ClosedItem, ref: string | null): Promise<RetractOutcome> {
    const messageId = ref === null ? NaN : Number(ref);
    if (!Number.isSafeInteger(messageId)) return 'gone';
    try {
      await this.#call('editMessageText', {
        chat_id: this.#options.chatId,
        message_id: messageId,
        parse_mode: 'MarkdownV2',
        text: [
          `*${escapeMarkdown(closed.title)}*`,
          '',
          escapeMarkdown(closureText(closed)),
        ].join('\n'),
      });
      return 'retracted';
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (/message is not modified/i.test(message)) return 'retracted';
      if (/message to edit not found|message can't be edited/i.test(message)) return 'gone';
      throw error;
    }
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
    // it" is not "the owner sent it". A well-formed press from anyone else is
    // somebody who found the bot, which is worth a security event rather than
    // a silent drop. The presser, not the chat the button sat in: a group is
    // one chat with many people in it.
    const from = String(query.from?.id ?? '');
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
      await this.#answer(query.id, say(await ownerLanguage(), 'This bot only answers to its owner.'));
      return { handled: false, reason: 'wrong_chat' };
    }

    // "Ask" needs the question, and a button has no words in it. It used to
    // decide at once with the note "via chat", and the run was then told the
    // owner had asked it "via chat". So the press asks for the question
    // instead, with a reply box already open, and `onReply` records it.
    if (action.decision === 'ask') {
      return this.#promptForReply(companyId, action.itemId, query.id, 'ask');
    }
    // A choice is an answer whose words the item already holds: the button
    // says which, and the text is read from the item, not from the press.
    if (action.choice !== undefined) {
      return this.#choose(companyId, action.itemId, action.choice, query.id);
    }
    // The same for a run's question: "Answer" needs the answer's words.
    if (action.decision === 'approve' && await this.#isQuestion(companyId, action.itemId)) {
      return this.#promptForReply(companyId, action.itemId, query.id, 'answer');
    }

    try {
      await inbox.decide(companyId, action.itemId, action.decision, 'via chat', {
        channel: 'chat',
      });
      await this.#answer(query.id, say(await ownerLanguage(), 'Recorded: {decision}.', { decision: action.decision }));
      return { handled: true };
    } catch (error) {
      // A stale button -- one the retraction sweep has not reached yet, or one
      // it could not edit -- is the ordinary way to arrive here, and "could
      // not be recorded" would read as a fault. The owner is told what
      // actually happened to the item instead.
      const language = await ownerLanguage();
      const refusal =
        error instanceof PalugadaError && error.code === 'approval.channel_forbidden'
          ? say(language, 'That one has to be approved in the app.')
          : error instanceof PalugadaError && error.code === 'inbox.not_open'
            ? say(language, 'Already closed: {reason}.', {
              reason: String(error.message).replace(/^inbox item \S+ is closed: /, ''),
            })
            : say(language, 'That could not be recorded.');
      await this.#answer(query.id, refusal);
      return {
        handled: false,
        reason: error instanceof PalugadaError ? error.code : 'failed',
      };
    }
  }

  /**
   * An update as Telegram posts it to the webhook.
   *
   * A button carries only its item -- Telegram allows sixty-four bytes of
   * callback data, and an item and a company are seventy-two -- so the
   * company is read from the item, after the secret has been checked and
   * before anything else: a request that is not from Telegram learns nothing
   * about which items exist.
   */
  async onUpdate(
    update: TelegramUpdate,
    options: { secretHeader?: string } = {},
  ): Promise<{ handled: boolean; reason?: string }> {
    if (!this.authenticWebhook(options.secretHeader)) {
      return { handled: false, reason: 'webhook_secret' };
    }
    if (update.message) return this.onReply(update.message);
    const query = update.callback_query;
    const action = query?.data ? decodeAction(query.data) : null;
    if (!query || !action) return { handled: false, reason: 'not_a_button' };
    const companyId = await inbox.companyOfItem(action.itemId);
    if (!companyId) {
      await this.#answer(query.id, say(await ownerLanguage(), 'That item no longer exists.'));
      return { handled: false, reason: 'unknown_item' };
    }
    return this.onCallback(companyId, update, options);
  }

  /**
   * The owner's question, typed as a reply to an "Ask" prompt.
   *
   * Only a reply to one of this bot's prompts is read, and only from the
   * owner: the same two checks as a press, for the same reasons, and a reply
   * from anyone else is recorded as a press from anyone else is. The webhook
   * secret has been checked by `onUpdate`, the only way in.
   */
  async onReply(message: NonNullable<TelegramUpdate['message']>): Promise<{ handled: boolean; reason?: string }> {
    const prompt = message.reply_to_message;
    const reference = prompt?.from?.is_bot ? ASK_REFERENCE.exec(prompt.text ?? '') : null;
    if (!reference) return { handled: false, reason: 'not_a_reply' };
    const answering = reference[1] === 'answer';
    const decision: inbox.Decision = answering ? 'approve' : 'ask';
    const itemId = reference[2]!;
    const companyId = await inbox.companyOfItem(itemId);
    if (!companyId) return { handled: false, reason: 'unknown_item' };

    const from = String(message.from?.id ?? '');
    if (from !== String(this.#options.chatId)) {
      await withTenant(companyId, async (tx) => {
        await appendEvent(tx, {
          companyId,
          type: 'security.chat_stranger_refused',
          actor: 'system',
          payload: {
            inboxItemId: itemId, decision, chatId: from, username: message.from?.username ?? null,
          },
        });
      });
      return { handled: false, reason: 'wrong_chat' };
    }

    const language = await ownerLanguage();
    const question = (message.text ?? '').trim();
    if (!question) return { handled: false, reason: 'empty' };
    if (question.length > QUESTION_MAX) {
      await this.#tell(say(language, 'That is too long for one question; keep it under {max} characters.', { max: String(QUESTION_MAX) }));
      return { handled: false, reason: 'too_long' };
    }
    try {
      await inbox.decide(companyId, itemId, decision, question, { channel: 'chat' });
      await this.#tell(answering
        ? say(language, 'Answered. The task carries on with it.')
        : say(language, 'Asked. The answer will be on the item in the app.'));
      return { handled: true };
    } catch (error) {
      await this.#tell(
        error instanceof PalugadaError && error.code === 'inbox.not_open'
          ? say(language, 'Already closed: {reason}.', {
            reason: String(error.message).replace(/^inbox item \S+ is closed: /, ''),
          })
          : say(language, 'That could not be recorded.'),
      );
      return { handled: false, reason: error instanceof PalugadaError ? error.code : 'failed' };
    }
  }

  /** One of a question's choices, pressed. */
  async #choose(
    companyId: string,
    itemId: string,
    index: number,
    callbackQueryId: string,
  ): Promise<{ handled: boolean; reason?: string }> {
    const language = await ownerLanguage();
    const { rows } = await withTenant(companyId, (tx) => tx.query<{ options: string[] | null }>(
      "SELECT payload->'options' AS options FROM inbox_items WHERE id = $1", [itemId]));
    const chosen = rows[0]?.options?.[index];
    if (!chosen) {
      await this.#answer(callbackQueryId, say(language, 'That choice is not on this question.'));
      return { handled: false, reason: 'no_such_choice' };
    }
    try {
      await inbox.decide(companyId, itemId, 'approve', chosen, { channel: 'chat' });
      await this.#answer(callbackQueryId, say(language, 'Chosen: {choice}.', { choice: chosen }));
      return { handled: true };
    } catch (error) {
      await this.#answer(callbackQueryId, error instanceof PalugadaError && error.code === 'inbox.not_open'
        ? say(language, 'Already closed: {reason}.', { reason: String(error.message).replace(/^inbox item \S+ is closed: /, '') })
        : say(language, 'That could not be recorded.'));
      return { handled: false, reason: error instanceof PalugadaError ? error.code : 'failed' };
    }
  }

  /** Whether an item is a run's question (`owner.ask`), which is answered rather than approved. */
  async #isQuestion(companyId: string, itemId: string): Promise<boolean> {
    const { rows } = await withTenant(companyId, (tx) => tx.query<{ question: boolean }>(
      "SELECT payload->>'askedBy' = 'agent' AS question FROM inbox_items WHERE id = $1", [itemId]));
    return rows[0]?.question ?? false;
  }

  /**
   * Asks the owner to type something -- their question, or their answer to a
   * run's -- as a reply the bot can read back.
   */
  async #promptForReply(
    companyId: string,
    itemId: string,
    callbackQueryId: string,
    mode: 'ask' | 'answer',
  ): Promise<{ handled: boolean; reason?: string }> {
    const language = await ownerLanguage();
    const { rows } = await withTenant(companyId, (tx) =>
      tx.query<{ title: string; status: string; closed_reason: string | null; question: string | null }>(
        "SELECT title, status, closed_reason, payload->>'question' AS question FROM inbox_items WHERE id = $1", [itemId]));
    const item = rows[0];
    if (!item || item.status !== 'open') {
      await this.#answer(callbackQueryId, say(language, 'Already closed: {reason}.', {
        reason: item?.closed_reason ?? item?.status ?? say(language, 'no reason recorded'),
      }));
      return { handled: false, reason: 'inbox.not_open' };
    }
    await this.#call('sendMessage', {
      chat_id: this.#options.chatId,
      text: [
        mode === 'answer'
          ? say(language, 'Your answer to "{question}"? Reply to this message.', { question: item.question ?? item.title })
          : say(language, 'What do you want to ask about "{title}"? Reply to this message.', { title: item.title }),
        '',
        `${mode === 'answer' ? 'answer' : 'ref'} ${itemId}`,
      ].join('\n'),
      reply_markup: {
        force_reply: true,
        input_field_placeholder: say(language, mode === 'answer' ? 'Your answer' : 'Your question'),
      },
    });
    await this.#answer(callbackQueryId, say(language, mode === 'answer' ? 'Type your answer as a reply.' : 'Type your question as a reply.'));
    return { handled: true };
  }

  /** A plain message to the owner, for an answer to something they typed. */
  async #tell(text: string): Promise<void> {
    await this.#call('sendMessage', { chat_id: this.#options.chatId, text }).catch(() => undefined);
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

/** The owner's language, for the answer to a button: the panel's, or English. */
async function ownerLanguage(): Promise<string> {
  return (await deploymentLanguages()).console ?? 'en';
}
