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
import type { Heard } from '../capabilities/listen.ts';
import type { ChatPartner } from './assistant.ts';
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
  /**
   * The console's public address, for a card the chat may not apply: its
   * button opens the conversation there, where the owner's device is.
   */
  consoleUrl?: string;
  /**
   * How often the "Thinking..." draft is shown again while an answer is
   * made: Telegram shows one for thirty seconds, and a CEO can take longer.
   */
  draftEveryMs?: number;
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

/** A voice note, or an audio file, as Telegram describes it. */
export interface TelegramAudio {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

/** The slice of a Telegram update this cares about. */
export interface TelegramUpdate {
  /** Telegram sends an update again when it did not hear the answer; the id says it is the same one. */
  update_id?: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id: number | string }; message_id?: number };
    from?: { id: number | string; username?: string };
  };
  /**
   * A message the owner typed or said: a reply to an "Ask" prompt answers
   * its item, and anything else is said to the conversation the chat is in.
   */
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string; type?: string };
    from?: { id: number | string; username?: string };
    reply_to_message?: { message_id?: number; text?: string; from?: { is_bot?: boolean } };
    voice?: TelegramAudio;
    audio?: TelegramAudio;
  };
  /** The owner pressed stop under the "Thinking..." draft of an answer. */
  stopped_message_generation?: {
    chat?: { id: number | string };
    message_thread_id?: number;
    draft_id?: number;
  };
}

/**
 * Whom the owner's own words go to: a company's CEO, or PALUGADA's
 * assistant (owner/assistant.ts). The owner API gives it, because it holds
 * the model, the routes a conversation reads and proposes, and the voice
 * providers; the channel holds Telegram and who may speak.
 */
export interface ChatConversation {
  /** Whether something hears speech, and whether something speaks: the providers chosen under Tools. */
  readonly hears: boolean;
  readonly speaks: boolean;
  partners(): Promise<ChatPartner[]>;
  /** The company whose CEO the chat is talking to, or null for PALUGADA's assistant. */
  current(): Promise<string | null>;
  moveTo(companyId: string | null): Promise<void>;
  /**
   * The owner said something; the answer, and the cards it put in front of
   * them -- or, when the signal stopped it first, that it was stopped.
   */
  talk(companyId: string | null, text: string, signal?: AbortSignal): Promise<{ answer: string; cards: ChatCard[]; stopped?: boolean }>;
  hear(audio: Heard): Promise<string>;
  speak(text: string): Promise<Heard>;
  /** A card pressed in the chat: applied, or why not. */
  apply(cardId: string): Promise<
    | { outcome: 'applied'; summary: string }
    | { outcome: 'closed'; status: 'applied' | 'dismissed' | 'failed' }
    | { outcome: 'app' }
    | { outcome: 'unknown' }
  >;
}

export interface ChatCard {
  id: string;
  summary: string;
  /** Whether the chat may apply it; otherwise it waits in the app. */
  here: boolean;
}

/** What a conversation's buttons carry: whom to talk to, or which card to apply. */
const CONVERSATION_PRESS = /^(talk):(palugada|[0-9a-f-]{36})$|^(card):([0-9a-f-]{36})$/;

/** Telegram takes a message of at most this many characters. */
const MESSAGE_MAX = 4_096;

/** And a rich message of at most this many. */
const RICH_MAX = 32_768;

/** Telegram shows a draft for thirty seconds; shown again before it goes. */
const DRAFT_EVERY_MS = 20_000;

/** A voice note past this is not something said to a CEO, and more than a transcription provider takes at once. */
const VOICE_MAX_BYTES = 20 * 1024 * 1024;

/** How many update ids are remembered, to know one sent again. */
const SEEN_MAX = 1_000;

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
  /** Update ids already taken in. */
  readonly #seen = new Set<number>();
  /**
   * The owner's messages and presses, answered one at a time in the order
   * they came -- a conversation read out of order is another conversation,
   * and a card pressed twice in quick succession is applied once.
   */
  #pending: Promise<void> = Promise.resolve();
  /**
   * Methods this Bot API answered it does not know. A local Bot API server
   * can be older than Telegram's own, and a rich message or a draft it does
   * not know is sent the old way rather than tried on every answer.
   */
  readonly #unknown = new Set<string>();
  /** The answer being made, which the stop button under its draft stops. */
  #generating: { draftId: number; stop: AbortController } | null = null;
  #drafts = 0;

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
    // Telegram writes the time in the owner's own zone and words ("in 3
    // hours"), which is what "how long do I have" wants.
    if (item.expiresAt) {
      lines.push('', `_${escapeMarkdown(say(item.language, 'Expires:'))}_ ${timeEntity(item.expiresAt, item.language)}`);
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
              {
                text: say(item.language, 'Stop the task'),
                callback_data: encodeAction({ itemId: item.id, decision: 'deny' }),
                style: 'danger',
              },
            ],
          ],
        },
      };
    }

    return {
      text: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [[
          // Colour says which is which before the words are read.
          { text: say(item.language, 'Approve'), callback_data: encodeAction({ itemId: item.id, decision: 'approve' }), style: 'success' },
          { text: say(item.language, 'Deny'), callback_data: encodeAction({ itemId: item.id, decision: 'deny' }), style: 'danger' },
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
    options: { secretHeader?: string; conversation?: ChatConversation } = {},
  ): Promise<{ handled: boolean; reason?: string }> {
    if (!this.authenticWebhook(options.secretHeader)) {
      return { handled: false, reason: 'webhook_secret' };
    }
    // After the secret, so that nobody but Telegram can fill the list.
    if (typeof update.update_id === 'number') {
      if (this.#seen.has(update.update_id)) return { handled: false, reason: 'duplicate' };
      this.#seen.add(update.update_id);
      if (this.#seen.size > SEEN_MAX) this.#seen.delete(this.#seen.values().next().value as number);
    }
    if (update.stopped_message_generation) return this.#onStop(update.stopped_message_generation);
    if (update.message) {
      const replied = await this.onReply(update.message);
      return replied.reason === 'not_a_reply' ? this.onMessage(update.message, options.conversation) : replied;
    }
    const query = update.callback_query;
    if (query?.data && CONVERSATION_PRESS.test(query.data)) return this.#onConversationPress(query, options.conversation);
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

  /**
   * Anything else the owner writes or says: to the conversation the chat is
   * in, answered there.
   *
   * The same two checks as a press, and one more. Only the owner is heard --
   * a stranger's message is dropped without a word back, since an answer
   * would tell whoever found the bot that it is alive. And only in the
   * owner's own chat with the bot: what the owner says in a group is said to
   * the group, not to their CEO. There is no company to record a stranger
   * against here, unlike a press on an item.
   *
   * The answer comes after the webhook has been answered. A conversation can
   * take the model a minute, and Telegram sends an update again when it is
   * not answered in time; the update id catches one sent again anyway.
   */
  async onMessage(
    message: NonNullable<TelegramUpdate['message']>,
    conversation: ChatConversation | undefined,
  ): Promise<{ handled: boolean; reason?: string }> {
    const from = String(message.from?.id ?? '');
    if (from !== String(this.#options.chatId)) return { handled: false, reason: 'wrong_chat' };
    if (String(message.chat?.id ?? '') !== from) return { handled: false, reason: 'not_private' };
    if (!conversation) return { handled: false, reason: 'no_conversation' };
    const text = (message.text ?? '').trim();
    const voice = message.voice ?? message.audio;
    if (!text && !voice) {
      this.#enqueue(async () => this.#tell(say(await ownerLanguage(), 'I read text and voice notes.')));
      return { handled: false, reason: 'empty' };
    }
    const command = /^\/([a-z]+)(?:@\w+)?$/i.exec(text)?.[1]?.toLowerCase();
    const draftId = message.message_id ?? (this.#drafts += 1);
    this.#enqueue(() => (command ? this.#command(command, conversation) : this.#converse(conversation, text, voice, draftId)));
    return { handled: true };
  }

  /**
   * The stop button under an answer's draft. Only in the owner's own chat,
   * where only the owner can press it, and only the answer being made: a
   * stop for an answer already sent has nothing left to stop.
   */
  #onStop(stopped: NonNullable<TelegramUpdate['stopped_message_generation']>): { handled: boolean; reason?: string } {
    if (String(stopped.chat?.id ?? '') !== String(this.#options.chatId)) return { handled: false, reason: 'wrong_chat' };
    const generating = this.#generating;
    if (!generating || generating.draftId !== stopped.draft_id) return { handled: false, reason: 'not_generating' };
    generating.stop.abort();
    return { handled: true };
  }

  /** Resolves when every message and press taken in has been answered: for a test, and for a clean stop. */
  settled(): Promise<void> {
    return this.#pending;
  }

  #enqueue(work: () => Promise<void>): void {
    this.#pending = this.#pending.then(work).catch(async (failure: unknown) => {
      const language = await ownerLanguage().catch(() => 'en');
      await this.#tell(say(language, 'That could not be answered: {reason}', {
        reason: redactor.redact((failure as Error).message ?? String(failure)).slice(0, 300),
      }));
    });
  }

  /** /ceo, /palugada, and anything else that starts with a slash: help. */
  async #command(command: string, conversation: ChatConversation): Promise<void> {
    const language = await ownerLanguage();
    if (command === 'palugada') {
      await conversation.moveTo(null);
      await this.#tell(say(language, 'Now talking to {name}.', { name: 'PALUGADA' }));
      return;
    }
    const partners = await conversation.partners();
    if (command === 'ceo' || command === 'talk') {
      await this.#call('sendMessage', {
        chat_id: this.#options.chatId,
        text: say(language, 'Choose whom to talk to.'),
        reply_markup: { inline_keyboard: partners.map((one) => [{ text: one.name, callback_data: `talk:${one.companyId ?? 'palugada'}` }]) },
      });
      return;
    }
    const current = await conversation.current();
    await this.#tell(say(language,
      'You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.',
      { name: (partners.find((one) => one.companyId === current) ?? partners[0])?.name ?? 'PALUGADA' }));
  }

  /**
   * What the owner said, heard if it was spoken, said to the conversation,
   * and the answer sent back.
   *
   * While it is made the chat shows a "Thinking..." draft with a stop button
   * under it; stopped, no further turn is asked of the model and nothing it
   * proposed is shown.
   */
  async #converse(conversation: ChatConversation, typed: string, voice: TelegramAudio | undefined, draftId: number): Promise<void> {
    const language = await ownerLanguage();
    const stop = new AbortController();
    this.#generating = { draftId, stop };
    const thinking = () => this.#thinking(draftId, voice ? 'record_voice' : 'typing');
    await thinking();
    const refresh = setInterval(() => void thinking(), this.#options.draftEveryMs ?? DRAFT_EVERY_MS);
    let said: Awaited<ReturnType<ChatConversation['talk']>>;
    let words = typed;
    let companyId: string | null;
    try {
      if (voice) {
        const heard = await this.#hear(conversation, voice, language);
        if (heard === null) return;
        words = heard;
      }
      companyId = await conversation.current();
      said = stop.signal.aborted ? { answer: '', cards: [], stopped: true } : await conversation.talk(companyId, words, stop.signal);
    } finally {
      clearInterval(refresh);
      this.#generating = null;
    }
    if (said.stopped) {
      await this.#tell(say(language, 'Stopped.'));
      return;
    }
    const { answer, cards } = said;
    const name = (await conversation.partners()).find((one) => one.companyId === companyId)?.name ?? 'PALUGADA';
    const heard = say(language, 'You said: "{words}"', { words });
    const inApp = say(language, 'in the app');
    // The same answer twice: as Markdown for a rich message, and as plain
    // text for a Bot API that cannot send one. What the platform writes is
    // escaped; what the model wrote is Markdown already, less any HTML.
    const plain = [name, '', ...(voice ? [heard, ''] : []), answer];
    const rich = [`**${escapeRich(name)}**`, '', ...(voice ? [heard.split('\n').map((line) => `>${escapeRich(line)}`).join('\n'), ''] : []), cleanRich(answer)];
    if (cards.length > 0) {
      plain.push('', ...cards.map((card) => `• ${card.summary}${card.here ? '' : ` (${inApp})`}`));
      rich.push('', ...cards.map((card) => `- ${escapeRich(card.summary.replace(/\s+/g, ' '))}${card.here ? '' : ` _(${escapeRich(inApp)})_`}`));
    }
    const buttons: InlineButton[][] = cards.filter((card) => card.here).map((card) => [{
      text: say(language, 'Apply: {summary}', { summary: card.summary.length > 48 ? `${card.summary.slice(0, 47)}…` : card.summary }),
      callback_data: `card:${card.id}`,
      style: 'success',
    }]);
    if (cards.some((card) => !card.here) && this.#options.consoleUrl) {
      buttons.push([{ text: say(language, 'Open in PALUGADA'), url: this.#conversationLink(companyId) }]);
    }
    await this.#sendAnswer(rich.join('\n'), plain.join('\n'), buttons);
    // Said back when it was said: a voice note is what the owner could send,
    // so a voice note is what they can take in. The words are already there,
    // so a provider that fails to speak loses the owner nothing.
    if (voice && conversation.speaks) {
      try {
        const spoken = await conversation.speak(answer);
        const playable = ['audio/ogg', 'audio/mpeg', 'audio/mp4'].includes(spoken.mime);
        await this.#call(playable ? 'sendVoice' : 'sendDocument', this.#form(playable ? 'voice' : 'document', spoken));
      } catch {
        // Nothing to do: see above.
      }
    }
  }

  /**
   * "Thinking..." with a stop button: a draft with no text, which Telegram
   * shows as its own placeholder. A Bot API without drafts gets the older
   * "typing".
   */
  async #thinking(draftId: number, action: 'typing' | 'record_voice'): Promise<void> {
    if (!this.#unknown.has('sendMessageDraft')) {
      try {
        await this.#call('sendMessageDraft', { chat_id: chatIdOf(this.#options.chatId), draft_id: draftId, text: '', can_stop: true });
        return;
      } catch (failure) {
        this.#learn('sendMessageDraft', failure);
      }
    }
    await this.#call('sendChatAction', { chat_id: this.#options.chatId, action }).catch(() => undefined);
  }

  /** An answer, as a rich message where the Bot API sends one, else as plain text. */
  async #sendAnswer(rich: string, plain: string, buttons: InlineButton[][]): Promise<void> {
    if (rich.length <= RICH_MAX && !this.#unknown.has('sendRichMessage')) {
      try {
        await this.#call('sendRichMessage', {
          chat_id: this.#options.chatId,
          rich_message: { markdown: rich },
          ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
        });
        return;
      } catch (failure) {
        // Unknown, it is remembered; refused (Markdown Telegram would not
        // take), this answer goes plain and the next is tried again.
        this.#learn('sendRichMessage', failure);
      }
    }
    await this.#send(plain, buttons);
  }

  /** Remembers a method this Bot API does not have. */
  #learn(method: string, failure: unknown): void {
    if (/\bNot Found\b|method not found|unknown method/i.test((failure as Error).message ?? '')) this.#unknown.add(method);
  }

  /** The words in a voice note, or null when the owner has been told why there are none. */
  async #hear(conversation: ChatConversation, voice: TelegramAudio, language: string): Promise<string | null> {
    if (!conversation.hears) {
      await this.#tell(say(language, 'Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.'));
      return null;
    }
    if ((voice.file_size ?? 0) > VOICE_MAX_BYTES) {
      await this.#tell(say(language, 'That recording is too long; keep a voice note under {max} MB.', { max: String(VOICE_MAX_BYTES / 1024 / 1024) }));
      return null;
    }
    const file = await this.#call<{ file_path?: string }>('getFile', { file_id: voice.file_id });
    if (!file.file_path) throw new Error('Telegram gave no file for that voice note');
    const base = this.#options.apiBase ?? 'https://api.telegram.org';
    const response = await this.#fetch(`${base}/file/bot${this.#options.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`the voice note could not be fetched from Telegram (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > VOICE_MAX_BYTES) {
      await this.#tell(say(language, 'That recording is too long; keep a voice note under {max} MB.', { max: String(VOICE_MAX_BYTES / 1024 / 1024) }));
      return null;
    }
    // A voice note is Ogg Opus whatever it says; an audio file says what it is.
    const words = (await conversation.hear({ bytes, mime: voice.mime_type?.split(';')[0]?.trim() || 'audio/ogg' })).trim();
    if (!words) {
      await this.#tell(say(language, 'I could not make out any words in that.'));
      return null;
    }
    return words;
  }

  /** A button under an answer: whom to talk to, or a card to apply. Only the owner's press counts. */
  async #onConversationPress(
    query: NonNullable<TelegramUpdate['callback_query']>,
    conversation: ChatConversation | undefined,
  ): Promise<{ handled: boolean; reason?: string }> {
    if (String(query.from?.id ?? '') !== String(this.#options.chatId)) {
      await this.#answer(query.id, say(await ownerLanguage(), 'This bot only answers to its owner.'));
      return { handled: false, reason: 'wrong_chat' };
    }
    if (!conversation) return { handled: false, reason: 'no_conversation' };
    const [, talk, partner, , card] = CONVERSATION_PRESS.exec(query.data!)!;
    this.#enqueue(async () => {
      const language = await ownerLanguage();
      try {
        if (talk) {
          const companyId = partner === 'palugada' ? null : partner!;
          await conversation.moveTo(companyId);
          const name = (await conversation.partners()).find((one) => one.companyId === companyId)?.name ?? 'PALUGADA';
          await this.#answer(query.id, say(language, 'Now talking to {name}.', { name }));
          return;
        }
        const applied = await conversation.apply(card!);
        await this.#answer(query.id,
          applied.outcome === 'applied' ? say(language, 'Done: {summary}', { summary: applied.summary })
            : applied.outcome === 'app' ? say(language, 'That one is applied in the app.')
              : applied.outcome === 'unknown' ? say(language, 'That card no longer exists.')
                : applied.status === 'applied' ? say(language, 'That card was already applied.')
                  : applied.status === 'dismissed' ? say(language, 'That card was dismissed.')
                    : say(language, 'That card failed when it was applied.'));
      } catch (failure) {
        await this.#answer(query.id, say(language, 'That could not be done: {reason}', {
          reason: redactor.redact((failure as Error).message ?? String(failure)),
        }));
      }
    });
    return { handled: true };
  }

  /** The conversation in the console, for a card the chat may not apply. */
  #conversationLink(companyId: string | null): string {
    const link = new URL(this.#options.consoleUrl!);
    if (companyId) link.searchParams.set('company', companyId);
    link.searchParams.set('talk', '1');
    return link.toString();
  }

  /**
   * A message of any length, in as many parts as Telegram needs, the buttons
   * under the last. No preview of a link in it: to make one Telegram fetches
   * the address, and an address a model wrote can carry what it read to
   * whoever owns it.
   */
  async #send(text: string, buttons: InlineButton[][]): Promise<void> {
    const parts = splitMessage(text);
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      await this.#call('sendMessage', {
        chat_id: this.#options.chatId,
        text: part,
        link_preview_options: { is_disabled: true },
        ...(last && buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
    }
  }

  /** A recording to send, as the Bot API takes a file. */
  #form(field: string, audio: Heard): FormData {
    const form = new FormData();
    form.append('chat_id', String(this.#options.chatId));
    const extension = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' }[audio.mime] ?? 'audio';
    form.append(field, new Blob([audio.bytes], { type: audio.mime }), `answer.${extension}`);
    return form;
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
      // Telegram refuses a longer one, and the press would keep spinning.
      text: text.length > 200 ? `${text.slice(0, 199)}…` : text,
    }).catch(() => undefined);
  }

  async #call<T>(method: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 10_000);
    const base = this.#options.apiBase ?? 'https://api.telegram.org';
    try {
      const form = body instanceof FormData;
      const response = await this.#fetch(`${base}/bot${this.#options.token}/${method}`, {
        method: 'POST',
        ...(form ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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

/** A button under a message, and the colour that says what it does. */
interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: 'success' | 'danger' | 'primary';
}

/** A chat's id as the Bot API's integer, where the method takes only that. */
function chatIdOf(chatId: string): number | string {
  return /^-?\d{1,15}$/.test(chatId) ? Number(chatId) : chatId;
}

/**
 * A time as Telegram's date entity: shown in the reader's own zone and
 * words, relative to now. The written time is for a client that cannot show
 * one, on UTC so it says whose clock it is.
 */
function timeEntity(at: Date, language = 'en'): string {
  let written: string;
  try {
    written = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(at);
  } catch {
    written = at.toISOString().slice(0, 16).replace('T', ' ');
  }
  return `![${escapeMarkdown(`${written} UTC`)}](tg://time?unix=${Math.floor(at.getTime() / 1000)}&format=r)`;
}

/**
 * Text the platform writes, in a rich message's Markdown: every character
 * that could start formatting, a tag or a link is escaped, and so is a line
 * that would start a heading or a list.
 */
function escapeRich(text: string): string {
  return text
    .replace(/[\\`*_~=|[\]<>#$!]/g, (char) => `\\${char}`)
    .replace(/^(\s*)([-+])/gm, '$1\\$2')
    .replace(/^(\s*\d+)(?=[.)])/gm, '$1\\');
}

/**
 * What a model wrote, as a rich message's Markdown, less what a model must
 * not put in the owner's chat.
 *
 * Rich Markdown takes HTML, and Telegram's HTML has buttons: a tag written
 * by a model that read something planted would put a button in the owner's
 * chat that approves an item, under words that say something else. Every
 * tag goes, again until none is left, since taking one out can join the
 * halves of another, and a "<" left that could open one is escaped. And a
 * picture's address is fetched by Telegram to show
 * it, which would carry whatever the model put in the address to whoever
 * owns it, so a picture becomes a link the owner can see before opening.
 */
function cleanRich(text: string): string {
  let clean = text.replace(/<(https?:\/\/[^\s<>]+)>/gi, '$1');
  for (let previous = ''; previous !== clean;) {
    previous = clean;
    clean = clean.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-z][^<>]*>/gi, '');
  }
  return clean.replace(/<(?=[a-z/!?])/gi, '\\<').replace(/!\[/g, '! [');
}

/**
 * A message cut into parts Telegram takes, at a line or a space where there
 * is one, and nothing lost: the parts put back together are the message.
 */
function splitMessage(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MESSAGE_MAX) {
    const window = rest.slice(0, MESSAGE_MAX);
    const at = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = at > MESSAGE_MAX / 2 ? at + 1 : MESSAGE_MAX;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
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

/**
 * The menu the chat's "/" button shows, in the owner's own chat and
 * language: the commands `onMessage` knows.
 */
export async function telegramCommands(token: string, chatId: string, language: string, api: BotApi = {}): Promise<void> {
  await telegramApi(token, 'setMyCommands', {
    commands: [
      { command: 'ceo', description: say(language, 'Choose whom to talk to') },
      { command: 'palugada', description: say(language, 'Talk to PALUGADA about the whole deployment') },
      { command: 'help', description: say(language, 'Who you are talking to, and how') },
    ],
    scope: { type: 'chat', chat_id: chatIdOf(chatId) },
  }, api);
}

/** The owner's language, for the answer to a button: the panel's, or English. */
async function ownerLanguage(): Promise<string> {
  return (await deploymentLanguages()).console ?? 'en';
}

/* ------------------------------------------------ connecting a bot --- */

/** Where a bot is reached, and how: the public Bot API unless a local one is named. */
export interface BotApi {
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * One call to the Bot API with a token, for connecting a bot from the console.
 * The token is registered with the redactor first: it is in the address, and
 * an error quoting the address would quote it.
 */
export async function telegramApi<T>(token: string, method: string, body: unknown, api: BotApi = {}): Promise<T> {
  redactor.register(token);
  let response: Response;
  try {
    response = await (api.fetch ?? globalThis.fetch)(`${api.apiBase ?? 'https://api.telegram.org'}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (failure) {
    throw new Error(`Telegram could not be reached: ${(failure as Error).message}`);
  }
  const answer = (await response.json().catch(() => null)) as { ok?: boolean; description?: string; error_code?: number; result?: T } | null;
  if (!response.ok || !answer?.ok) {
    const error = new Error(response.status === 401 || answer?.error_code === 401
      ? 'Telegram does not know that token: copy it again from @BotFather'
      : `Telegram refused ${method}: ${answer?.description ?? `HTTP ${response.status}`}`);
    (error as Error & { status?: number }).status = answer?.error_code ?? response.status;
    throw error;
  }
  return answer.result as T;
}

/** The bot a token belongs to: its name, and the link that opens a chat with it. */
export async function telegramBot(token: string, api: BotApi = {}): Promise<{ username: string; name: string; link: string }> {
  const me = await telegramApi<{ username?: string; first_name?: string }>(token, 'getMe', {}, api);
  const username = me.username ?? '';
  return { username, name: me.first_name ?? username, link: `https://t.me/${username}` };
}

/**
 * The private chats that have written to the bot lately, newest first: the
 * owner presses Start in their own chat with it, and their chat is found
 * rather than typed. A bot with a webhook cannot be asked for its updates, so
 * a webhook left by an earlier connection is taken off first; saving sets it
 * again.
 */
export async function telegramChats(token: string, api: BotApi = {}): Promise<Array<{ id: string; name: string; username: string | null }>> {
  type Update = { message?: { chat?: { id?: number; type?: string; first_name?: string; last_name?: string; username?: string } } };
  let updates: Update[];
  try {
    updates = await telegramApi<Update[]>(token, 'getUpdates', { allowed_updates: ['message'], timeout: 0 }, api);
  } catch (failure) {
    if ((failure as Error & { status?: number }).status !== 409) throw failure;
    await telegramApi(token, 'deleteWebhook', { drop_pending_updates: false }, api);
    updates = await telegramApi<Update[]>(token, 'getUpdates', { allowed_updates: ['message'], timeout: 0 }, api);
  }
  const seen = new Map<string, { id: string; name: string; username: string | null }>();
  for (const update of [...updates].reverse()) {
    const chat = update.message?.chat;
    if (chat?.type !== 'private' || chat.id === undefined) continue;
    const id = String(chat.id);
    if (!seen.has(id)) {
      seen.set(id, { id, name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || id, username: chat.username ?? null });
    }
  }
  return [...seen.values()];
}
