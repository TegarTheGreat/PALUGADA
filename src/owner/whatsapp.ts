/**
 * WhatsApp as the owner's channel (PRD v2 F10.9, F10.10), through Meta's
 * WhatsApp Business Cloud API.
 *
 * In Indonesia the owner's messenger is WhatsApp. Telegram (telegram.ts) came
 * first because a bot costs nothing and needs no business verification; this
 * is the same surface for an owner who has a WhatsApp Business number, and it
 * keeps every rule telegram.ts explains -- read that module's comment first.
 * What differs is WhatsApp's, and each difference is handled here:
 *
 *   - **A delivery is signed.** Meta signs each webhook body with the app
 *     secret (`X-Hub-Signature-256`), so the check is an HMAC over the bytes
 *     that arrived, in constant time, before anything in them is read.
 *   - **The owner is a phone number.** Only the configured number is heard. A
 *     press from any other is recorded as a security event against the item's
 *     company and not answered: an answer would tell whoever found the number
 *     that it acts.
 *   - **Meta sends a delivery again** when it did not see it answered in time,
 *     for days. Each inbound message id is claimed in the database before it
 *     is acted on, so a press is never decided twice, even across a restart.
 *   - **A business may not start a conversation** more than 24 hours after
 *     the owner last wrote, except with a template Meta approved. The send
 *     call is accepted and the failure arrives later, in a status delivery
 *     (error 131047); the item then goes as the template, and its buttons are
 *     sent again as soon as the owner writes back.
 *   - **A reply names only the message it answers.** An "Ask" prompt's item is
 *     kept against the prompt's message id, in the database for the same
 *     reason as the receipts.
 *
 * Tier 3 is refused by `decide` over `chat` whatever arrives here, exactly as
 * for Telegram: a forged press from the owner's own number approves nothing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { redactor } from '../secrets/manager.ts';
import { PalugadaError } from '../errors.ts';
import * as inbox from '../inbox/inbox.ts';
import { channelDelivery } from '../inbox/inbox.ts';
import { deploymentLanguages } from '../domain/language.ts';
import { say } from './say.ts';
import { decodeAction, encodeAction, type ChatConversation } from './telegram.ts';
import { closureText, notOpenText, recordedText, type DeliveryResult, type DoneNotice, type NotifiableItem, type OwnerChannel } from './notify.ts';

export interface WhatsAppOptions {
  /** The business number's id in the Cloud API (not the number itself). */
  phoneNumberId: string;
  /** A system user's access token, already resolved from the secret manager. */
  token: string;
  /** The Meta app's secret, which signs every webhook delivery. */
  appSecret: string;
  /** What Meta is told to send back when the webhook is subscribed. */
  verifyToken: string;
  /** The owner's number, digits only with the country code: 6281234567890. */
  owner: string;
  /**
   * The approved template that opens a conversation outside WhatsApp's
   * 24-hour window: a utility template with one body parameter.
   */
  template?: { name: string; language: string };
  /** Deep link into the owner's app, for the items a chat may not act on. */
  appUrl?: (item: NotifiableItem) => string | null;
  apiBase?: string;
  timeoutMs?: number;
  name?: string;
  fetch?: typeof globalThis.fetch;
}

/** A message as a webhook delivery carries it; only the fields read here. */
interface InboundMessage {
  id?: unknown;
  from?: unknown;
  type?: unknown;
  text?: { body?: unknown };
  interactive?: { button_reply?: { id?: unknown }; list_reply?: { id?: unknown } };
  /** A template's quick-reply button. */
  button?: { payload?: unknown };
  /** The message this one replies to. */
  context?: { id?: unknown };
}

interface InboundStatus {
  id?: unknown;
  status?: unknown;
  errors?: Array<{ code?: unknown; title?: unknown; message?: unknown }>;
}

export interface DeliveryOutcome {
  /** False when the delivery was not read at all: unsigned, or not JSON. */
  ok: boolean;
  reason?: string;
  /** One for each message in the delivery. */
  results: Array<{ id: string; handled: boolean; reason?: string }>;
}

/** Where Meta's Graph API is, at a version Meta supports until 2027. */
const GRAPH_API = 'https://graph.facebook.com/v23.0';

/** WhatsApp refuses a reply button's title over 20 characters, a list row's over 24, its description over 72. */
const BUTTON_TITLE_MAX = 20;
const ROW_TITLE_MAX = 24;
const ROW_DESCRIPTION_MAX = 72;

/** An interactive message's body, and a text message, at most. */
const BODY_MAX = 1_024;
const TEXT_MAX = 4_096;

/** A list holds ten rows; a question offers at most six choices (`decodeAction`), with room for the two answers besides. */
const ROWS_MAX = 10;

/** What the Cloud API says of a message outside the 24-hour window. */
const OUTSIDE_WINDOW = 131_047;

/** The longest question a chat reply may carry, the same bound as the app's and Telegram's. */
const QUESTION_MAX = 2_000;

/** Longer than Meta retries a delivery, which is a week. */
const KEPT_DAYS = 14;

/** What a conversation's list rows and buttons carry: whom to talk to, or which card to apply. */
const PARTNER_PRESS = /^talk:(palugada|[0-9a-f-]{36})$/;
const CARD_PRESS = /^card:([0-9a-f-]{36})$/;

type Result = { handled: boolean; reason?: string };

class GraphError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

export class WhatsAppChannel implements OwnerChannel {
  readonly name: string;
  readonly #options: WhatsAppOptions;
  readonly #fetch: typeof globalThis.fetch;
  /** The owner's words, answered one at a time in the order they came. */
  #pending: Promise<void> = Promise.resolve();
  /** When old receipts were last cleared out. */
  #cleared = 0;

  constructor(options: WhatsAppOptions) {
    this.name = options.name ?? 'chat:whatsapp';
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    // The token is a header on every call and the secrets sign everything;
    // an error that quoted one must not carry it anywhere.
    redactor.register(options.token);
    redactor.register(options.appSecret);
    redactor.register(options.verifyToken);
  }

  carries(): boolean {
    return true;
  }

  /**
   * The message, without the envelope every send adds. Separate from
   * `deliver` so that "a tier 3 approval has nothing to press" is asserted
   * without a network, as telegram.ts does.
   */
  render(item: NotifiableItem, timeZone = 'UTC'): Record<string, unknown> {
    const lines = [`*${item.title}*`, '', item.actionSummary];
    if (item.consequenceIfDenied) lines.push('', `_${say(item.language, 'If denied:')}_ ${item.consequenceIfDenied}`);
    if (item.expiresAt) lines.push('', `_${say(item.language, 'Expires:')}_ ${written(item.expiresAt, item.language, timeZone)}`);

    if (item.delivery === 'link_only') {
      // F10.10: what happened and where to go, and no way to say yes here.
      lines.push('', say(item.language, 'This one is decided in the app.'));
      if (item.url) lines.push(item.url);
      return { type: 'text', text: { body: clip(lines.join('\n'), TEXT_MAX), preview_url: false } };
    }

    const body = { text: clip(lines.join('\n'), BODY_MAX) };
    if (item.question) {
      // A run's question is answered, not approved; its choices, when it
      // offered some, are a list, since three buttons do not hold six.
      const choices = (item.options ?? []).slice(0, ROWS_MAX - 2);
      if (choices.length > 0) {
        return {
          type: 'interactive',
          interactive: {
            type: 'list',
            body,
            action: {
              button: clip(say(item.language, 'Choose'), BUTTON_TITLE_MAX),
              sections: [{
                rows: [
                  ...choices.map((option, index) => ({
                    id: encodeAction({ itemId: item.id, decision: 'approve', choice: index }),
                    title: clip(option, ROW_TITLE_MAX),
                    ...(option.length > ROW_TITLE_MAX ? { description: clip(option, ROW_DESCRIPTION_MAX) } : {}),
                  })),
                  { id: encodeAction({ itemId: item.id, decision: 'approve' }), title: clip(say(item.language, 'Answer in words'), ROW_TITLE_MAX) },
                  { id: encodeAction({ itemId: item.id, decision: 'deny' }), title: clip(say(item.language, 'Stop the task'), ROW_TITLE_MAX) },
                ],
              }],
            },
          },
        };
      }
      return buttons(body, [
        [encodeAction({ itemId: item.id, decision: 'approve' }), say(item.language, 'Answer')],
        [encodeAction({ itemId: item.id, decision: 'deny' }), say(item.language, 'Stop the task')],
      ]);
    }
    return buttons(body, [
      [encodeAction({ itemId: item.id, decision: 'approve' }), say(item.language, 'Approve')],
      [encodeAction({ itemId: item.id, decision: 'deny' }), say(item.language, 'Deny')],
      [encodeAction({ itemId: item.id, decision: 'ask' }), say(item.language, 'Ask')],
    ]);
  }

  async deliver(item: NotifiableItem): Promise<DeliveryResult> {
    const withLink = item.url ? item : { ...item, url: this.#options.appUrl?.(item) ?? null };
    const message = this.render(withLink, await ownerTimeZone());
    const summary = `${withLink.title}: ${withLink.actionSummary}`;
    const kept = { companyId: item.companyId, itemId: item.id, purpose: 'item' as const, summary };
    return { ref: await this.#sendOrTemplate(message, kept) };
  }

  /** F10.6's digest: something to read, so nothing to press. */
  async deliverDigest(digest: { companyId: string; day: string; text: string }): Promise<void> {
    for (const part of pieces(digest.text, TEXT_MAX)) {
      await this.#sendOrTemplate({ type: 'text', text: { body: part } }, { purpose: 'text', summary: part });
    }
  }

  /** Work the owner gave has finished (0059): news, with where to open it. */
  async deliverNotice(notice: DoneNotice): Promise<DeliveryResult> {
    const text = clip([notice.text, ...(notice.url ? ['', notice.url] : [])].join('\n'), TEXT_MAX);
    return { ref: await this.#sendOrTemplate({ type: 'text', text: { body: text } }, { purpose: 'text', summary: notice.text }) };
  }

  /**
   * Meta's check when the webhook is subscribed: the challenge back, only
   * for the verify token this deployment chose. A challenge is a number; one
   * that is not is not echoed.
   */
  verifySubscription(query: URLSearchParams): string | null {
    const challenge = query.get('hub.challenge') ?? '';
    if (query.get('hub.mode') !== 'subscribe' || !/^[\w-]{1,128}$/.test(challenge)) return null;
    return same(query.get('hub.verify_token') ?? '', this.#options.verifyToken) ? challenge : null;
  }

  /** Whether Meta signed these bytes with the app's secret. */
  authentic(raw: Buffer, signatureHeader: string | undefined): boolean {
    const given = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader ?? '');
    if (!given) return false;
    const expected = createHmac('sha256', this.#options.appSecret).update(raw).digest();
    const presented = Buffer.from(given[1]!, 'hex');
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  /**
   * A webhook delivery, as the bytes Meta signed.
   *
   * The signature before anything is parsed, so a request that is not from
   * Meta learns nothing -- not even whether its JSON was well formed. Then,
   * for each message: claimed, so it is acted on once; the owner's, or
   * recorded and dropped; and then a press, a reply to a prompt, or words for
   * the conversation.
   */
  async onDelivery(
    raw: Buffer,
    signatureHeader: string | undefined,
    options: { conversation?: ChatConversation } = {},
  ): Promise<DeliveryOutcome> {
    if (!this.authentic(raw, signatureHeader)) return { ok: false, reason: 'signature', results: [] };
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return { ok: false, reason: 'not_json', results: [] };
    }
    const results: DeliveryOutcome['results'] = [];
    for (const entry of list((body as { entry?: unknown }).entry)) {
      for (const change of list((entry as { changes?: unknown }).changes)) {
        const { field, value } = change as { field?: unknown; value?: Record<string, unknown> };
        // Another number of the same business is another deployment's.
        if (field !== 'messages' || !value) continue;
        if (String((value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id ?? '') !== this.#options.phoneNumberId) continue;
        for (const status of list(value.statuses)) await this.#onStatus(status as InboundStatus);
        for (const message of list(value.messages)) {
          const id = typeof (message as InboundMessage).id === 'string' ? (message as { id: string }).id : '';
          results.push({ id, ...(await this.#onMessage(message as InboundMessage, id, options.conversation)) });
        }
      }
    }
    return { ok: true, results };
  }

  /** Resolves when every conversation taken in has been answered: for a test, and for a clean stop. */
  settled(): Promise<void> {
    return this.#pending;
  }

  async #onMessage(message: InboundMessage, id: string, conversation: ChatConversation | undefined): Promise<Result> {
    if (!id || id.length > 256) return { handled: false, reason: 'malformed' };
    if (!(await this.#firstTime(id))) return { handled: false, reason: 'duplicate' };
    const pressed = text(message.interactive?.button_reply?.id) ?? text(message.interactive?.list_reply?.id) ?? text(message.button?.payload);

    if (String(message.from ?? '') !== this.#options.owner) {
      // Somebody who found the number. A press on an item is recorded where
      // the item is; words from a stranger have no company to be recorded in.
      const action = pressed ? decodeAction(pressed) : null;
      const companyId = action ? await inbox.companyOfItem(action.itemId) : null;
      if (action && companyId) {
        await withTenant(companyId, (tx) => appendEvent(tx, {
          companyId,
          type: 'security.chat_stranger_refused',
          actor: 'system',
          payload: { channel: 'whatsapp', inboxItemId: action.itemId, decision: action.decision, from: String(message.from ?? '') },
        }));
      }
      return { handled: false, reason: 'not_the_owner' };
    }

    // The owner wrote, so WhatsApp's window is open: what waited for it goes
    // now, first, so an answer to it is not read before it arrives. A failure
    // to send it is not a reason to lose what the owner just did.
    await this.#release().catch(() => undefined);
    if (pressed) return this.#onPress(pressed, conversation);
    if (message.type === 'text') {
      const words = (text(message.text?.body) ?? '').trim();
      const replyTo = text(message.context?.id);
      const prompt = replyTo ? await this.#kept(replyTo) : null;
      if (prompt && (prompt.purpose === 'ask' || prompt.purpose === 'answer')) return this.#onAnswer(prompt, words);
      return this.#converse(words, id, conversation);
    }
    this.#enqueue(async () => this.#tell(say(await ownerLanguage(), 'I read text messages here.')));
    return { handled: false, reason: 'unsupported' };
  }

  async #onPress(data: string, conversation: ChatConversation | undefined): Promise<Result> {
    const partner = PARTNER_PRESS.exec(data);
    const card = CARD_PRESS.exec(data);
    if (partner || card) {
      if (!conversation) return { handled: false, reason: 'no_conversation' };
      this.#enqueue(() => (partner
        ? this.#moveTo(conversation, partner[1] === 'palugada' ? null : partner[1]!)
        : this.#apply(conversation, card![1]!)));
      return { handled: true };
    }
    // A template's own quick reply carries no action: pressing it opened the window, which was the point.
    const action = decodeAction(data);
    if (!action) return { handled: false, reason: 'not_a_button' };
    const language = await ownerLanguage();
    const companyId = await inbox.companyOfItem(action.itemId);
    if (!companyId) {
      await this.#tell(say(language, 'That item no longer exists.'));
      return { handled: false, reason: 'unknown_item' };
    }
    if (action.decision === 'ask') return this.#prompt(companyId, action.itemId, 'ask');
    if (action.choice !== undefined) return this.#choose(companyId, action.itemId, action.choice);
    if (action.decision === 'approve' && await isQuestion(companyId, action.itemId)) {
      return this.#prompt(companyId, action.itemId, 'answer');
    }
    try {
      await inbox.decide(companyId, action.itemId, action.decision, 'via chat', { channel: 'chat' });
      await this.#tell(recordedText(language, action.decision));
      return { handled: true };
    } catch (error) {
      await this.#tell(refusal(error, language));
      return { handled: false, reason: error instanceof PalugadaError ? error.code : 'failed' };
    }
  }

  /** One of a question's choices; its words are read from the item, not from the press. */
  async #choose(companyId: string, itemId: string, index: number): Promise<Result> {
    const language = await ownerLanguage();
    const { rows } = await withTenant(companyId, (tx) => tx.query<{ options: string[] | null }>(
      "SELECT payload->'options' AS options FROM inbox_items WHERE id = $1", [itemId]));
    const chosen = rows[0]?.options?.[index];
    if (!chosen) {
      await this.#tell(say(language, 'That choice is not on this question.'));
      return { handled: false, reason: 'no_such_choice' };
    }
    try {
      await inbox.decide(companyId, itemId, 'approve', chosen, { channel: 'chat' });
      await this.#tell(say(language, 'Chosen: {choice}.', { choice: chosen }));
      return { handled: true };
    } catch (error) {
      await this.#tell(refusal(error, language));
      return { handled: false, reason: error instanceof PalugadaError ? error.code : 'failed' };
    }
  }

  /** Asks the owner for the words a button cannot carry: their question, or their answer to a run's. */
  async #prompt(companyId: string, itemId: string, mode: 'ask' | 'answer'): Promise<Result> {
    const language = await ownerLanguage();
    const { rows } = await withTenant(companyId, (tx) =>
      tx.query<{ title: string; status: string; decision: string | null; closed_reason: string | null; question: string | null }>(
        "SELECT title, status, decision, closed_reason, payload->>'question' AS question FROM inbox_items WHERE id = $1", [itemId]));
    const item = rows[0];
    if (!item || item.status !== 'open') {
      await this.#tell(closureText({
        status: item?.status ?? null, decision: item?.decision ?? null, closedReason: item?.closed_reason ?? null, language,
      }));
      return { handled: false, reason: 'inbox.not_open' };
    }
    const body = mode === 'answer'
      ? say(language, 'Your answer to "{question}"? Reply to this message with your answer.', { question: item.question ?? item.title })
      : say(language, 'What do you want to ask about "{title}"? Reply to this message with your question.', { title: item.title });
    const sent = await this.#send({ type: 'text', text: { body: clip(body, TEXT_MAX) } });
    await this.#keep(sent, { companyId, itemId, purpose: mode, summary: '' });
    return { handled: true };
  }

  /** The owner's words, in reply to a prompt: the question asked, or the run's answer. */
  async #onAnswer(prompt: Kept, words: string): Promise<Result> {
    const language = await ownerLanguage();
    if (!words) return { handled: false, reason: 'empty' };
    if (words.length > QUESTION_MAX) {
      await this.#tell(say(language, 'That is too long for one question; keep it under {max} characters.', { max: String(QUESTION_MAX) }));
      return { handled: false, reason: 'too_long' };
    }
    const answering = prompt.purpose === 'answer';
    try {
      await inbox.decide(prompt.companyId!, prompt.itemId!, answering ? 'approve' : 'ask', words, { channel: 'chat' });
      await this.#tell(answering
        ? say(language, 'Answered. The task carries on with it.')
        : say(language, 'Asked. The answer will be on the item in the app.'));
      return { handled: true };
    } catch (error) {
      await this.#tell(refusal(error, language));
      return { handled: false, reason: error instanceof PalugadaError ? error.code : 'failed' };
    }
  }

  /**
   * The owner's own words, to the conversation this chat is in, answered
   * after the delivery has been: a model can take a minute, and Meta sends a
   * delivery again that is not answered in time.
   */
  async #converse(words: string, messageId: string, conversation: ChatConversation | undefined): Promise<Result> {
    if (!conversation) return { handled: false, reason: 'no_conversation' };
    if (!words) return { handled: false, reason: 'empty' };
    const command = /^\/([a-z]+)$/i.exec(words)?.[1]?.toLowerCase();
    this.#enqueue(async () => {
      const language = await ownerLanguage();
      if (command === 'ceo') return this.#choosePartner(conversation, language);
      if (command === 'palugada') return this.#moveTo(conversation, null);
      // Read, and "typing..." while the answer is made; neither matters enough to fail over.
      await this.#send({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }, false).catch(() => undefined);
      const companyId = await conversation.current();
      const { answer, cards } = await conversation.talk(companyId, words);
      const name = (await conversation.partners()).find((one) => one.companyId === companyId)?.name ?? 'PALUGADA';
      const inApp = say(language, 'in the app');
      const lines = [`*${name}*`, '', whatsappText(answer)];
      if (cards.length > 0) lines.push('', ...cards.map((card) => `• ${card.summary}${card.here ? '' : ` (${inApp})`}`));
      for (const part of pieces(lines.join('\n'), TEXT_MAX)) await this.#send({ type: 'text', text: { body: part } });
      // What the chat may apply gets a button; three at most, as WhatsApp allows.
      const here = cards.filter((card) => card.here).slice(0, 3);
      if (here.length > 0) {
        await this.#send(buttons(
          { text: clip([say(language, 'Apply one of these here:'), ...here.map((card, index) => `${index + 1}. ${card.summary}`)].join('\n'), BODY_MAX) },
          here.map((card, index) => [`card:${card.id}`, say(language, 'Apply {number}', { number: String(index + 1) })]),
        ));
      }
    });
    return { handled: true };
  }

  /** Whom the owner may talk to, as a list: PALUGADA's assistant, then each company's CEO. */
  async #choosePartner(conversation: ChatConversation, language: string): Promise<void> {
    const partners = (await conversation.partners()).slice(0, ROWS_MAX);
    await this.#send({
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: say(language, 'Choose whom to talk to.') },
        action: {
          button: clip(say(language, 'Choose'), BUTTON_TITLE_MAX),
          sections: [{
            rows: partners.map((partner) => ({ id: `talk:${partner.companyId ?? 'palugada'}`, title: clip(partner.name, ROW_TITLE_MAX) })),
          }],
        },
      },
    });
  }

  async #moveTo(conversation: ChatConversation, companyId: string | null): Promise<void> {
    const language = await ownerLanguage();
    const partner = (await conversation.partners()).find((one) => one.companyId === companyId);
    if (!partner) {
      await this.#tell(say(language, 'That item no longer exists.'));
      return;
    }
    await conversation.moveTo(companyId);
    await this.#tell(say(language, 'Now talking to {name}.', { name: partner.name }));
  }

  async #apply(conversation: ChatConversation, cardId: string): Promise<void> {
    const language = await ownerLanguage();
    try {
      const outcome = await conversation.apply(cardId);
      await this.#tell(outcome.outcome === 'applied'
        ? say(language, 'Done: {summary}', { summary: outcome.summary })
        : outcome.outcome === 'app'
          ? say(language, 'That one is applied in the app.')
          : outcome.outcome === 'unknown'
            ? say(language, 'That card no longer exists.')
            : outcome.status === 'applied'
              ? say(language, 'That card was already applied.')
              : outcome.status === 'dismissed'
                ? say(language, 'That card was dismissed.')
                : say(language, 'That card failed when it was applied.'));
    } catch (failure) {
      await this.#tell(say(language, 'That could not be done: {reason}', {
        reason: redactor.redact((failure as Error).message ?? String(failure)).slice(0, 300),
      }));
    }
  }

  /**
   * A message reported after it was sent. Only a failure matters, and only
   * one of ours: outside the window, the approved template goes in its
   * place, and its buttons wait for the owner to write back. Anything else
   * the owner is told about in the company's record, since they cannot be
   * told on WhatsApp.
   */
  async #onStatus(status: InboundStatus): Promise<void> {
    const id = text(status.id);
    if (status.status !== 'failed' || !id) return;
    const kept = await this.#kept(id);
    if (!kept || !(await this.#firstTime(`failed:${id}`))) return;
    const error = list(status.errors)[0] as { code?: unknown; title?: unknown; message?: unknown } | undefined;
    const code = Number(error?.code ?? NaN);
    if (code === OUTSIDE_WINDOW && this.#options.template && kept.summary) {
      this.#enqueue(async () => {
        const sent = await this.#template(kept.summary);
        await this.#keep(sent, { ...kept, summary: '' });
        if (kept.purpose === 'item') await this.#wait(id);
      });
      return;
    }
    if (kept.companyId) {
      await withTenant(kept.companyId, (tx) => appendEvent(tx, {
        companyId: kept.companyId!,
        type: 'owner.notification_failed',
        actor: 'system',
        payload: {
          channel: 'whatsapp',
          ...(kept.itemId ? { inboxItemId: kept.itemId } : {}),
          code: Number.isFinite(code) ? code : null,
          reason: code === OUTSIDE_WINDOW ? outsideWindow() : String(error?.message ?? error?.title ?? 'failed').slice(0, 300),
        },
      }));
    }
  }

  /**
   * Sends a message; outside the window, the template instead. The Cloud API
   * usually accepts the first and reports it failed later (`#onStatus`), and
   * sometimes refuses it at once, which is handled here the same way.
   */
  async #sendOrTemplate(message: Record<string, unknown>, kept: Kept): Promise<string> {
    try {
      const sent = await this.#send(message);
      await this.#keep(sent, kept);
      return sent;
    } catch (error) {
      if (!(error instanceof GraphError) || error.code !== OUTSIDE_WINDOW) throw error;
      if (!this.#options.template) throw new Error(outsideWindow());
      const sent = await this.#template(kept.summary);
      await this.#keep(sent, { ...kept, summary: '', waiting: kept.purpose === 'item' });
      return sent;
    }
  }

  async #template(summary: string): Promise<string> {
    const template = this.#options.template!;
    return this.#send({
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        // A parameter may not hold a line break, a tab or four spaces in a row.
        components: [{ type: 'body', parameters: [{ type: 'text', text: clip(summary.replace(/\s+/g, ' ').trim(), 1_000) }] }],
      },
    });
  }

  /** The items that went as the template, with their buttons, now the owner has written. */
  async #release(): Promise<void> {
    const waiting = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ message_id: string; company_id: string; item_id: string }>(
        `UPDATE whatsapp_sent SET waiting = false
          WHERE message_id IN (SELECT message_id FROM whatsapp_sent WHERE waiting ORDER BY created_at LIMIT 20)
          RETURNING message_id, company_id, item_id`);
      return rows;
    });
    for (const one of waiting) {
      const item = await openItem(one.company_id, one.item_id);
      if (item) await this.deliver(item);
    }
  }

  async #wait(messageId: string): Promise<void> {
    await withControlPlane((tx) => tx.query('UPDATE whatsapp_sent SET waiting = true WHERE message_id = $1', [messageId]));
  }

  async #keep(messageId: string, kept: Kept): Promise<void> {
    await withControlPlane((tx) => tx.query(
      `INSERT INTO whatsapp_sent (message_id, company_id, item_id, purpose, summary, waiting)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (message_id) DO NOTHING`,
      [messageId, kept.companyId ?? null, kept.itemId ?? null, kept.purpose, clip(kept.summary, 1_024), kept.waiting ?? false]));
  }

  async #kept(messageId: string): Promise<Kept | null> {
    const { rows } = await withControlPlane((tx) => tx.query<{ company_id: string | null; item_id: string | null; purpose: Kept['purpose']; summary: string }>(
      'SELECT company_id, item_id, purpose, summary FROM whatsapp_sent WHERE message_id = $1', [messageId]));
    const row = rows[0];
    return row ? { companyId: row.company_id, itemId: row.item_id, purpose: row.purpose, summary: row.summary } : null;
  }

  /**
   * Claims an inbound message id; false when it was claimed before. Old
   * claims, and old sent messages, are cleared at most once an hour.
   */
  async #firstTime(key: string): Promise<boolean> {
    return withControlPlane(async (tx) => {
      const { rowCount } = await tx.query(
        'INSERT INTO whatsapp_receipts (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING', [key]);
      if (Date.now() - this.#cleared > 3_600_000) {
        this.#cleared = Date.now();
        await tx.query('DELETE FROM whatsapp_receipts WHERE received_at < now() - make_interval(days => $1)', [KEPT_DAYS]);
        await tx.query('DELETE FROM whatsapp_sent WHERE created_at < now() - make_interval(days => $1)', [KEPT_DAYS]);
      }
      return rowCount === 1;
    });
  }

  #enqueue(work: () => Promise<void>): void {
    this.#pending = this.#pending.then(work).catch(async (failure: unknown) => {
      const language = await ownerLanguage().catch(() => 'en');
      await this.#tell(say(language, 'That could not be answered: {reason}', {
        reason: redactor.redact((failure as Error).message ?? String(failure)).slice(0, 300),
      }));
    });
  }

  /** A plain message to the owner, for what they did; a failure to send it loses nothing they asked for. */
  async #tell(body: string): Promise<void> {
    await this.#send({ type: 'text', text: { body: clip(body, TEXT_MAX) } }).catch(() => undefined);
  }

  /** One call to the Cloud API; the id of the message it sent. */
  async #send(message: Record<string, unknown>, toOwner = true): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 10_000);
    const base = (this.#options.apiBase ?? GRAPH_API).replace(/\/+$/, '');
    try {
      const response = await this.#fetch(`${base}/${encodeURIComponent(this.#options.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#options.token}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          ...(toOwner ? { recipient_type: 'individual', to: this.#options.owner } : {}),
          ...message,
        }),
        signal: controller.signal,
      });
      const answer = (await response.json().catch(() => null)) as
        | { messages?: Array<{ id?: string }>; success?: boolean; error?: { message?: string; code?: number } }
        | null;
      if (!response.ok || answer?.error) {
        const code = typeof answer?.error?.code === 'number' ? answer.error.code : null;
        throw new GraphError(
          redactor.redact(`whatsapp send failed: ${answer?.error?.message ?? `HTTP ${response.status}`}${code === null ? '' : ` (code ${code})`}`),
          code,
        );
      }
      return answer?.messages?.[0]?.id ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The number an id and a token reach, as Meta names it: the check before a
 * save that the owner pasted the right two, and that the token may use them.
 */
export async function whatsappNumber(
  token: string,
  phoneNumberId: string,
  api: { apiBase?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<{ number: string; name: string | null }> {
  const base = (api.apiBase ?? GRAPH_API).replace(/\/+$/, '');
  const response = await (api.fetch ?? globalThis.fetch)(
    `${base}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  );
  const answer = (await response.json().catch(() => null)) as
    | { display_phone_number?: string; verified_name?: string; error?: { message?: string } }
    | null;
  if (!response.ok || !answer?.display_phone_number) {
    throw new Error(redactor.redact(`WhatsApp did not accept that number id and token: ${answer?.error?.message ?? `HTTP ${response.status}`}`));
  }
  return { number: answer.display_phone_number, name: answer.verified_name ?? null };
}

interface Kept {
  companyId?: string | null;
  itemId?: string | null;
  purpose: 'item' | 'ask' | 'answer' | 'text';
  summary: string;
  waiting?: boolean;
}

function outsideWindow(): string {
  return 'the owner has not written to this number in the last 24 hours, and WhatsApp lets a business start a '
    + 'conversation only with a template Meta approved: make a utility template with one body parameter, and set '
    + 'PALUGADA_WHATSAPP_TEMPLATE to its name and language, as name:language';
}

/** Reply buttons, three at most, each with a title WhatsApp accepts. */
function buttons(body: { text: string }, pairs: Array<[string, string]>): Record<string, unknown> {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body,
      action: { buttons: pairs.slice(0, 3).map(([id, title]) => ({ type: 'reply', reply: { id, title: clip(title, BUTTON_TITLE_MAX) } })) },
    },
  };
}

/** What the owner was told when a press or a reply could not be recorded, and why. */
function refusal(error: unknown, language: string): string {
  if (error instanceof PalugadaError && error.code === 'approval.channel_forbidden') return say(language, 'That one has to be approved in the app.');
  if (error instanceof PalugadaError && error.code === 'inbox.not_open') {
    return notOpenText(language, error);
  }
  return say(language, 'That could not be recorded.');
}

/** Whether an item is a run's question (`owner.ask`), which is answered rather than approved. */
async function isQuestion(companyId: string, itemId: string): Promise<boolean> {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ question: boolean }>(
    "SELECT payload->>'askedBy' = 'agent' AS question FROM inbox_items WHERE id = $1", [itemId]));
  return rows[0]?.question ?? false;
}

/** An item still open, as a channel is given one. */
async function openItem(companyId: string, itemId: string): Promise<NotifiableItem | null> {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{
    kind: string; tier: number | null; title: string; action_summary: string; consequence_if_denied: string | null;
    language: string | null; question: string | null; options: string[] | null; expires_at: Date | null;
  }>(
    `SELECT kind, tier, title, action_summary, consequence_if_denied, expires_at,
            (SELECT console_language FROM platform_control) AS language,
            CASE WHEN payload->>'askedBy' = 'agent' THEN payload->>'question' END AS question,
            CASE WHEN payload->>'askedBy' = 'agent' THEN payload->'options' END AS options
       FROM inbox_items WHERE id = $1 AND status = 'open'`, [itemId]));
  const row = rows[0];
  if (!row) return null;
  const delivery = channelDelivery(row);
  if (delivery === 'none') return null;
  return {
    id: itemId, companyId, kind: row.kind, tier: row.tier, title: row.title, actionSummary: row.action_summary,
    consequenceIfDenied: row.consequence_if_denied, delivery, url: null, language: row.language ?? 'en',
    question: row.question, options: row.options, expiresAt: row.expires_at,
  };
}

async function ownerLanguage(): Promise<string> {
  return (await deploymentLanguages()).console ?? 'en';
}

async function ownerTimeZone(): Promise<string> {
  const { rows } = await withControlPlane((tx) => tx.query<{ owner_timezone: string }>('SELECT owner_timezone FROM platform_control'));
  return rows[0]?.owner_timezone ?? 'UTC';
}

/** A time in the owner's zone, with the zone named: WhatsApp has no time the reader's phone converts. */
function written(at: Date, language: string | undefined, timeZone: string): string {
  try {
    return `${new Intl.DateTimeFormat(language ?? 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(at)} (${timeZone})`;
  } catch {
    return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

/**
 * What a model wrote in Markdown, as WhatsApp formats: one asterisk for bold,
 * no headings, and a link as its words and its address.
 */
function whatsappText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** A long text as messages WhatsApp takes, split between lines where it can be. */
function pieces(value: string, max: number): string[] {
  const out: string[] = [];
  let rest = value;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}
