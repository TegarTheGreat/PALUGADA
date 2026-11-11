/**
 * The owner's items, through a relay (F19.19, F19.20; STATUS section 2.208).
 *
 * A relay is one more of the owner's channels, beside push and the chats, and
 * goes through the same claim-first ledger (`owner_notifications`): once per
 * item and relay, retried by `retryFailed`, retracted by `retractClosed`, a
 * digest and a finished task each once. What it does with an item is write a
 * row: the envelope, at the owner's share level, and the offers it carries,
 * go into the outbox in one transaction, and the relay loop sends them. So a
 * slow or broken relay holds up nothing the worker does.
 *
 * It carries an item only for a company the relay hears about and only when
 * the owner has linked a phone through it. Offers to press go only where a
 * chat may act at all (F10.9): tier 2 and below, never an incident; only when
 * the owner turned presses on and the share is above `signal`; and only to a
 * link made with a device key, so a relay alone can never decide in the
 * owner's name.
 */
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { isPushWorthy, closureText, type ClosedItem, type DeliveryResult, type DoneNotice, type NotifiableItem, type OwnerChannel, type RetractOutcome } from '../owner/notify.ts';
import { closedSaid, digestSaid, doneSaid, itemSaid } from '../owner/relay-said.ts';
import { redactor } from '../secrets/manager.ts';
import { companyRef, envelopeBody, envelopeId, opaqueLink, shareAtLeast, type Share, type Urgency } from './envelope.ts';
import { mintOffers, offerExpiry } from './offers.ts';
import { enqueue, type Opens } from './outbox.ts';
import { covers, pairedRelayIds, relayRow, shareFor, type RelayRow } from './relays.ts';

interface OwnersLink {
  id: string;
  recipient_id: string;
  device_key: Buffer | null;
  share: Share | null;
}

interface Prepared {
  relay: RelayRow;
  link: OwnersLink | null;
}

async function prepared(tx: TenantClient, relayId: string, lock: boolean): Promise<Prepared | null> {
  const relay = await relayRow(tx, relayId, lock);
  if (!relay || relay.status !== 'paired') return null;
  const { rows } = await tx.query<OwnersLink>(
    `SELECT id, recipient_id, device_key, share FROM relay_links WHERE relay_id = $1 AND principal = 'owner' AND status = 'active'`,
    [relayId]);
  return { relay, link: rows[0] ?? null };
}

export class RelayChannel implements OwnerChannel {
  readonly name: string;
  readonly relayId: string;
  #state: Prepared | null = null;

  constructor(relayId: string) {
    this.relayId = relayId;
    this.name = `relay:${relayId}`;
  }

  /**
   * Reads the relay and the owner's link again, before each dispatch: a relay
   * revoked, narrowed or newly linked on another replica is this channel's
   * answer from the next tick, without a restart.
   */
  async prepare(): Promise<void> {
    this.#state = await withControlPlane((tx) => prepared(tx, this.relayId, false));
  }

  carries(item: NotifiableItem): boolean {
    const state = this.#state;
    return state !== null && state.link !== null && covers(state.relay, item.companyId);
  }

  async deliver(item: NotifiableItem): Promise<DeliveryResult> {
    const now = new Date();
    return withControlPlane(async (tx) => {
      // Read again, and locked, in the transaction that writes: what the
      // owner narrowed a moment ago is what this envelope is built under.
      const state = await prepared(tx, this.relayId, true);
      if (!state?.link || !covers(state.relay, item.companyId)) {
        throw new PalugadaError('relay.not_paired', 'the relay no longer carries this company, or the owner\'s phone is no longer linked', {});
      }
      const { relay, link } = state;
      const share = shareFor(relay, item.companyId, link.share);
      const urgent = isPushWorthy(item);
      const urgency: Urgency = urgent ? 'interrupt' : item.delivery === 'actionable' ? 'normal' : 'quiet';
      const deployment = await deploymentOf(tx);
      const id = envelopeId({ deployment, relay: relay.id, link: link.id, type: 'inbox_item', subject: item.id });
      const language = item.language ?? 'en';
      const title = redactor.redact(item.title);

      // F10.9 and F10.10: a chat acts only on what `channelDelivery` made
      // actionable, never at tier 3; a relay is a chat.
      const pressable = item.delivery === 'actionable' && (item.tier ?? 0) <= 2 && !urgent
        && relay.may_press && shareAtLeast(share, 'summary') && link.device_key !== null;
      const question = Boolean(item.question);
      const offers = pressable
        ? await mintOffers(tx, {
          relayId: relay.id, linkId: link.id, companyId: item.companyId, principal: 'owner',
          item: { id: item.id, question, options: item.options ?? null },
          expiresAt: offerExpiry(now, item.expiresAt), language, share,
        })
        : [];
      const data: Record<string, unknown> = { kind: item.kind, tier: item.tier };
      if (shareAtLeast(share, 'summary')) data.title = title;
      if (share === 'content') {
        data.summary = redactor.redact(item.actionSummary);
        if (item.consequenceIfDenied) data.ifDenied = redactor.redact(item.consequenceIfDenied);
        if (question) {
          data.question = redactor.redact(item.question!);
          // The run's choices are its words too, redacted as its question is.
          data.options = (item.options ?? []).map((option) => redactor.redact(option));
          if (item.asker) data.asker = item.asker;
        }
        if (item.expiresAt) data.expiresAt = item.expiresAt.toISOString();
      }
      const opened = opaqueLink(item.url);
      const body = envelopeBody({
        v: 1, id, type: 'inbox_item', at: now.toISOString(), deployment, relay: relay.id,
        to: { recipient: link.recipient_id },
        company: await companyOf(tx, relay, item.companyId, share),
        share, urgency, lang: language,
        text: itemSaid(language, share, { kind: item.kind, title, urgent }),
        link: opened.link,
        data,
        offers,
      });
      await enqueue(tx, {
        id, relayId: relay.id, linkId: link.id, companyId: item.companyId, type: 'inbox_item', subjects: [`item:${item.id}`], body,
        handle: opened.handle, opens: { itemId: item.id },
      }, now);
      return { ref: id };
    });
  }

  /**
   * An item closed: the relay is told, by the envelope that told it of the
   * item, and every offer for it is void, so a press that arrives later finds
   * nothing to redeem and is told why. A notice of it the relay never had --
   * the relay was down, or behind -- is not sent at all, and nor is its
   * closing: after an outage the relay is not handed the words of an item
   * already closed, nor asked to ring for an incident already resolved.
   */
  async retract(closed: ClosedItem, ref: string | null): Promise<RetractOutcome> {
    const now = new Date();
    return withControlPlane(async (tx) => {
      // The relay's row before its offers, as every change of them takes it.
      const state = await prepared(tx, this.relayId, true);
      await tx.query(
        'UPDATE relay_offers SET voided_at = $3 WHERE relay_id = $1 AND inbox_item_id = $2 AND voided_at IS NULL',
        [this.relayId, closed.id, now]);
      const { rows: unsent } = await tx.query(
        `DELETE FROM relay_outbox
          WHERE relay_id = $1 AND type = 'inbox_item' AND status IN ('pending', 'dead') AND subjects @> ARRAY[$2]::text[]
          RETURNING id`,
        [this.relayId, `item:${closed.id}`]);
      if (!state?.link || ref === null || unsent.length > 0) return 'gone';
      const { relay, link } = state;
      const share = shareFor(relay, closed.companyId, link.share);
      const deployment = await deploymentOf(tx);
      const id = envelopeId({ deployment, relay: relay.id, link: link.id, type: 'inbox_closed', subject: closed.id });
      const language = closed.language ?? 'en';
      await enqueue(tx, {
        id, relayId: relay.id, linkId: link.id, companyId: closed.companyId, type: 'inbox_closed', subjects: [`item:${closed.id}`],
        body: envelopeBody({
          v: 1, id, type: 'inbox_closed', at: now.toISOString(), deployment, relay: relay.id,
          to: { recipient: link.recipient_id }, share, urgency: 'quiet', lang: language,
          text: share === 'signal' ? closedSaid(language) : closureText(closed),
          data: { ref },
        }),
      }, now);
      return 'retracted';
    });
  }

  /** The day's digest, when the relay hears about the company and the owner linked a phone. */
  async deliverDigest(digest: { companyId: string; day: string; text: string }): Promise<void> {
    await this.#news('digest', digest.companyId, `digest:${digest.day}`, (share, language, company) => ({
      text: share === 'signal' ? digestSaid(language, null) : share === 'summary' ? digestSaid(language, company) : redactor.redact(digest.text),
      data: { day: digest.day },
    }));
  }

  /** Work the owner gave, finished: its headline at `summary`, its account at `content`. */
  async deliverNotice(notice: DoneNotice): Promise<DeliveryResult> {
    const id = await this.#news('work_done', notice.companyId, `task:${notice.taskId}`, (share, language) => ({
      text: share === 'signal' ? doneSaid(language) : share === 'summary' ? notice.text.split('\n')[0]! : notice.text,
      link: notice.url,
      data: {},
    }), notice.language, { taskId: notice.taskId });
    return id ? { ref: id } : {};
  }

  /** News that needs nothing pressed: nothing is owed when the relay does not carry it. */
  async #news(
    type: 'digest' | 'work_done',
    companyId: string,
    subject: string,
    said: (share: Share, language: string | null, company: string) => { text: string; data: Record<string, unknown>; link?: string | null },
    given?: string,
    opens: Opens = {},
  ): Promise<string | null> {
    const now = new Date();
    return withControlPlane(async (tx) => {
      const state = await prepared(tx, this.relayId, true);
      if (!state?.link || !covers(state.relay, companyId)) return null;
      const { relay, link } = state;
      const share = shareFor(relay, companyId, link.share);
      const deployment = await deploymentOf(tx);
      const { rows: [names] } = await tx.query<{ company: string; language: string | null }>(
        'SELECT (SELECT name FROM companies WHERE id = $1) AS company, (SELECT console_language FROM platform_control) AS language',
        [companyId]);
      const language = given ?? names!.language ?? 'en';
      const told = said(share, language, names!.company);
      const id = envelopeId({ deployment, relay: relay.id, link: link.id, type, subject });
      const opened = opaqueLink(told.link);
      await enqueue(tx, {
        id, relayId: relay.id, linkId: link.id, companyId, type, subjects: [subject], handle: opened.handle, opens,
        body: envelopeBody({
          v: 1, id, type, at: now.toISOString(), deployment, relay: relay.id,
          to: { recipient: link.recipient_id }, company: await companyOf(tx, relay, companyId, share),
          share, urgency: 'quiet', lang: language, text: told.text, link: opened.link, data: told.data,
        }),
      }, now);
      return id;
    });
  }
}

/** The deployment's id, as every envelope names it. */
export async function deploymentOf(tx: TenantClient): Promise<string> {
  const { rows: [control] } = await tx.query<{ deployment: string }>('SELECT deployment_id::text AS deployment FROM platform_control');
  return control!.deployment;
}

/** A company as the relay may know it: its reference always, and its name above `signal`. */
export async function companyOf(tx: TenantClient, relay: RelayRow, companyId: string, share: Share): Promise<Record<string, string>> {
  const ref = companyRef(relay.salt, companyId);
  if (share === 'signal') return { ref };
  const { rows } = await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]);
  return { ref, name: rows[0]?.name ?? '' };
}

/** A channel for each paired relay, for the worker's list of the owner's channels. */
export async function relayChannels(): Promise<RelayChannel[]> {
  return (await pairedRelayIds()).map((id) => new RelayChannel(id));
}
