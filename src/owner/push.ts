/**
 * The push channel (PRD v2 F10.5).
 *
 * F10.5 is one sentence — *push only for an incident and a tier 3 approval* —
 * and it is a restriction rather than a feature. Push is the one surface that
 * reaches the owner outside the window they set, so the list of things allowed
 * to use it is short and closed. Everything else waits, which `notify_after`
 * already enforces; `carries` here is the other half, and without it a budget
 * alert at 03:00 would be a ringing phone.
 *
 * The transport is an HTTPS POST to a URL the deployment configures, and that
 * is on purpose rather than for want of ambition. Every push service worth
 * using — a relay in front of FCM or APNs, ntfy, Pushover, an owner's own
 * webhook — is reached that way, and each differs only in the field names.
 * `body` maps the platform's message onto whichever, so adding a provider is a
 * function rather than a module. Binding directly to FCM instead would have
 * meant a Google service account, a token exchange, and a hard dependency on
 * one vendor for a feature whose whole content is "send four short strings".
 *
 * What is deliberately *not* sent: the rationale, the payload, the task id,
 * anything the runtime produced. A push notification is rendered by an
 * operating system on a locked screen and copied through a vendor's servers on
 * the way. It carries what an alert needs — that something happened, how bad,
 * and a link — and the substance stays behind the app where F10.10's second
 * factor is.
 */
import { redactor } from '../secrets/manager.ts';
import type { DeliveryResult, NotifiableItem, OwnerChannel } from './notify.ts';
import { isPushWorthy } from './notify.ts';

export interface PushMessage {
  title: string;
  body: string;
  url: string | null;
  /**
   * Whether to break through the phone's own quiet hours.
   *
   * An incident is an emergency by definition; a tier 3 approval is the owner
   * being asked for something irreversible, which is urgent but is not a fire.
   * The distinction exists because a platform that marks everything critical
   * has taught its owner to ignore the critical ones.
   */
  urgent: boolean;
  /**
   * The item, so a phone that receives two notifications for one incident
   * shows one. Every push service has a collapse key by some name.
   */
  tag: string;
}

export interface WebhookPushOptions {
  /** Where to POST. HTTPS in any deployment that is not a test. */
  url: string;
  /**
   * The credential, already resolved.
   *
   * A value rather than a reference because this is constructed once at boot
   * by whatever assembles the deployment, and that is the layer that holds the
   * secret manager. Registered with the redactor on the way in, so a transport
   * error quoting the Authorization header does not put it in a log.
   */
  token?: string;
  /** Header name, for the services that do not use `Authorization`. */
  tokenHeader?: string;
  /** Maps the platform's message onto the provider's field names. */
  body?: (message: PushMessage) => unknown;
  timeoutMs?: number;
  name?: string;
  fetch?: typeof globalThis.fetch;
}

export class WebhookPush implements OwnerChannel {
  readonly name: string;
  readonly #options: WebhookPushOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: WebhookPushOptions) {
    this.name = options.name ?? 'push:webhook';
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.token) redactor.register(options.token);
  }

  /**
   * F10.5, and the only place it is decided.
   *
   * Written as a predicate on the channel rather than a filter in the
   * dispatcher so that "may this wake the owner" is answerable by reading one
   * function, and so a second push transport cannot answer it differently.
   */
  carries(item: NotifiableItem): boolean {
    return isPushWorthy(item);
  }

  /**
   * What the phone shows.
   *
   * Deliberately four short strings. See the module comment: a lock screen and
   * a vendor's servers are not where a company's business goes.
   */
  message(item: NotifiableItem): PushMessage {
    const urgent = item.kind === 'incident';
    return {
      title: urgent ? `Incident: ${item.title}` : `Approval needed: ${item.title}`,
      body: urgent
        ? item.actionSummary
        : `${item.actionSummary}${item.consequenceIfDenied ? ` — if denied: ${item.consequenceIfDenied}` : ''}`,
      url: item.url,
      urgent,
      tag: item.id,
    };
  }

  async deliver(item: NotifiableItem): Promise<DeliveryResult> {
    const message = this.message(item);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 10_000);

    try {
      const response = await this.#fetch(this.#options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#options.token
            ? { [this.#options.tokenHeader ?? 'authorization']: this.#options.token }
            : {}),
        },
        body: JSON.stringify(this.#options.body?.(message) ?? defaultBody(message)),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The body is read because a push service's refusal is usually only in
        // it -- "this device token is no longer registered" arrives as a 400
        // with a sentence. Truncated, and redacted by the dispatcher before it
        // reaches a column an owner reads.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`push returned ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const receipt = (await response.json().catch(() => null)) as { id?: string } | null;
      return receipt?.id ? { ref: receipt.id } : {};
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The shape most relays take, and a reasonable default.
 *
 * Named and exported so a deployment writing its own `body` can start from it
 * rather than guess what the platform thinks it is sending.
 */
export function defaultBody(message: PushMessage): Record<string, unknown> {
  return {
    title: message.title,
    body: message.body,
    priority: message.urgent ? 'high' : 'normal',
    tag: message.tag,
    ...(message.url ? { url: message.url } : {}),
  };
}
