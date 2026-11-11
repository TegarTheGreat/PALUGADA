/**
 * People's notices, through a relay (F19.13, F19.20; STATUS section 2.213).
 *
 * The owner's items go to a relay as the owner's channel (`channel.ts`); a
 * person's own notices -- their direct messages and mentions, a reply in a
 * thread they follow, a run's question put to them, an approval they may
 * decide, work they asked for -- are planned and composed by the people's
 * notices (`src/owner/member-notify.ts`) and written here into the outbox,
 * one envelope per notice and link, at the lower of the relay's share and
 * the person's own.
 *
 * With a notice about a room come tokens for that room alone, bound to the
 * link, the room, the thread and the position the notice named: a read mark
 * and a mute, and a reply where the owner allowed replies through the relay.
 * They are what lets a person answer from a phone without the relay ever
 * learning a room's id. With a question or an approval come the same offers
 * the owner's items carry, made only for what the seat may do now. The
 * owner's link without a device key is told and offered nothing, as for the
 * owner's items: a relay alone never writes in the owner's name.
 *
 * A message deleted, or taken by retention, is retracted: what was not sent
 * is not sent, its tokens are void, and a relay that had it is told to drop
 * it.
 */
import { randomBytes } from 'node:crypto';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { roomOfferLabel } from '../owner/people-said.ts';
import { companyOf, deploymentOf } from './channel.ts';
import { envelopeBody, envelopeId, lowerShare, shareAtLeast, type Share } from './envelope.ts';
import { mintOffers, offerExpiry, tokenHash, type Offer } from './offers.ts';
import { enqueue } from './outbox.ts';
import { covers, relayRow } from './relays.ts';

/** How long a room's tokens may be used. */
export const ROOM_OFFER_DAYS = 7;
/** How many replies one notice's token carries, and how many read marks or mutes. */
export const REPLY_USES = 20;
export const MARK_USES = 5;
/** How many removed messages one pass of the notify stage retracts; the rest wait for the next. */
const RETRACT_BATCH = 200;

/** What a share level of a notice says. */
export interface Said {
  text: string;
  data: Record<string, unknown>;
}

/** One person's notice, composed and ready to go to one relay. */
export interface PeopleNotice {
  /** The notice's own id: the envelope's is made from it, so a notice sent again is the same envelope. */
  id: string;
  companyId: string;
  principal: string;
  type: 'room_activity' | 'inbox_item' | 'work_done';
  subjects: string[];
  language: string;
  link: string | null;
  said: Record<Share, Said>;
  /**
   * A notice about words: the room, thread and position its tokens are bound
   * to, and the message it names -- none when the window's first message was
   * deleted, and the notice carries nothing of any one message.
   */
  room?: { roomId: string; threadOf: string | null; position: number; messageId: string | null };
  /** A question or an approval, and whether the seat may answer or decide it now. */
  item?: { id: string; question: boolean; options: readonly string[] | null; tier: number | null; expiresAt: Date | null; mayAct: boolean };
}

interface LinkRow {
  id: string;
  recipient_id: string;
  device_key: Buffer | null;
  share: Share | null;
}

/**
 * Writes one person's notice into a relay's outbox, with its tokens. Answers
 * the envelope's id, or null when there is nobody to send it to any more: the
 * relay revoked or no longer hearing about the company, the person's link
 * ended, or the message it is about deleted before it went.
 */
export async function relayPeopleNotice(relayId: string, notice: PeopleNotice, now = new Date()): Promise<string | null> {
  return withControlPlane(async (tx) => {
    // The relay's row first, as every change of its offers and outbox takes it.
    const relay = await relayRow(tx, relayId, true);
    if (!relay || relay.status !== 'paired' || !covers(relay, notice.companyId)) return null;
    const { rows: [link] } = await tx.query<LinkRow>(
      `SELECT id, recipient_id, device_key, share FROM relay_links
        WHERE relay_id = $1 AND principal = $2 AND status = 'active' AND (company_id IS NULL OR company_id = $3)`,
      [relayId, notice.principal, notice.companyId]);
    if (!link) return null;
    if (notice.room?.messageId) {
      // Held against a delete on its way: a delete waits for this to commit
      // and then retracts what it wrote, or commits first and this sees it.
      // Only whether it was deleted is read here, never what it said.
      const { rows } = await tx.query(
        'SELECT 1 FROM room_messages WHERE company_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE',
        [notice.companyId, notice.room.messageId]);
      if (rows.length === 0) return null;
    }
    const deployment = await deploymentOf(tx);
    const id = envelopeId({ deployment, relay: relay.id, link: link.id, type: notice.type, subject: notice.id });
    const { rows: already } = await tx.query('SELECT 1 FROM relay_outbox WHERE id = $1', [id]);
    if (already.length > 0) return id;

    const share = lowerShare(relay.share, link.share);
    // The owner's link without a key of its own acts on nothing.
    const mayAct = notice.principal !== 'owner' || link.device_key !== null;
    let offers: Offer[] = [];
    if (notice.room && mayAct) {
      offers = await roomOffers(tx, {
        relayId: relay.id, linkId: link.id, companyId: notice.companyId, principal: notice.principal, room: notice.room,
        reply: relay.may_post && share !== 'signal', language: notice.language, now,
      });
    } else if (notice.item && mayAct && notice.item.mayAct && relay.may_press && shareAtLeast(share, 'summary') && (notice.item.tier ?? 0) <= 2) {
      offers = await mintOffers(tx, {
        relayId: relay.id, linkId: link.id, companyId: notice.companyId, principal: notice.principal,
        item: { id: notice.item.id, question: notice.item.question, options: notice.item.options },
        expiresAt: offerExpiry(now, notice.item.expiresAt), language: notice.language, share,
      });
    }
    const said = notice.said[share];
    await enqueue(tx, {
      id, relayId: relay.id, linkId: link.id, companyId: notice.companyId, type: notice.type, subjects: notice.subjects,
      body: envelopeBody({
        v: 1, id, type: notice.type, at: now.toISOString(), deployment, relay: relay.id,
        to: { recipient: link.recipient_id }, company: await companyOf(tx, relay, notice.companyId, share),
        share, urgency: 'normal', lang: notice.language, text: said.text, link: notice.link, data: said.data, offers,
      }),
    }, now);
    return id;
  });
}

/** A notice's tokens for its room: a read mark and a mute, and a reply when the owner allowed replies. */
async function roomOffers(tx: TenantClient, input: {
  relayId: string; linkId: string; companyId: string; principal: string;
  room: NonNullable<PeopleNotice['room']>; reply: boolean; language: string; now: Date;
}): Promise<Offer[]> {
  const acts: Array<{ act: 'reply' | 'read' | 'mute'; uses: number }> = [
    ...(input.reply ? [{ act: 'reply' as const, uses: REPLY_USES }] : []),
    { act: 'read', uses: MARK_USES },
    { act: 'mute', uses: MARK_USES },
  ];
  const expires = new Date(input.now.getTime() + ROOM_OFFER_DAYS * 86_400_000);
  const offers: Offer[] = [];
  for (const one of acts) {
    const token = `pt_${randomBytes(32).toString('base64url')}`;
    await tx.query(
      `INSERT INTO relay_offers (token_hash, relay_id, link_id, company_id, principal, act, room_id, thread_of, position, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tokenHash(token), input.relayId, input.linkId, input.companyId, input.principal, one.act,
        input.room.roomId, input.room.threadOf, input.room.position, one.uses, expires]);
    offers.push({ token, act: one.act, label: roomOfferLabel(input.language, one.act) });
  }
  return offers;
}

/**
 * Messages deleted or purged: what a relay was owed of them and has not had
 * is dropped, every token sent with them is void, and each relay that had
 * one, or was tried with one and may have read it before it refused, is told,
 * link by link, to drop what it holds (`room_activity_retracted`, which the
 * protocol says a relay MUST honour). Answers how many envelopes were
 * dropped and how many retractions were owed. Called once a delete has
 * committed, and by `retractRemoved` for what no call retracted: the
 * messages retention takes (STATUS section 2.212), and a delete whose own
 * call never ran. A notice on its way as this runs is retracted too, and is
 * never sent again if its send fails (`sendDue` takes no notice of removed
 * words).
 */
export async function retractMessages(companyId: string, messageIds: readonly string[], now = new Date()): Promise<{ dropped: number; retracted: number }> {
  if (messageIds.length === 0) return { dropped: 0, retracted: 0 };
  const subjects = messageIds.map((id) => `message:${id}`);
  return withControlPlane(async (tx) => {
    // Each relay's row before its outbox and offers, in the order of their
    // ids, as every transaction that touches more than one relay takes them.
    const { rows: relays } = await tx.query<{ relay_id: string }>(
      `SELECT DISTINCT relay_id FROM relay_outbox WHERE company_id = $1 AND subjects && $2::text[] ORDER BY relay_id`,
      [companyId, subjects]);
    for (const one of relays) await relayRow(tx, one.relay_id, true);
    const { rows } = await tx.query<{ id: string; relay_id: string; link_id: string | null; status: string; attempts: number; body: string }>(
      `SELECT id, relay_id, link_id, status, attempts, body FROM relay_outbox
        WHERE company_id = $1 AND subjects && $2::text[] AND type <> 'room_activity_retracted'
        ORDER BY created_at, id FOR UPDATE`,
      [companyId, subjects]);
    const tokens = rows.flatMap((row) => {
      const offers = (JSON.parse(row.body) as { offers?: Array<{ token: string }> }).offers ?? [];
      return offers.map((offer) => tokenHash(String(offer.token)));
    });
    if (tokens.length > 0) {
      await tx.query('UPDATE relay_offers SET voided_at = $2 WHERE token_hash = ANY($1::text[]) AND voided_at IS NULL', [tokens, now]);
    }
    const unsent = rows.filter((row) => row.status === 'pending' || row.status === 'dead');
    if (unsent.length > 0) await tx.query('DELETE FROM relay_outbox WHERE id = ANY($1::uuid[])', [unsent.map((row) => row.id)]);
    // What a relay may already hold: sent, on its way, or tried and refused
    // by a relay that may have read it before it answered.
    const held = new Map<string, { relayId: string; linkId: string; refs: string[] }>();
    for (const row of rows.filter((one) => one.status === 'delivered' || one.status === 'sending' || one.attempts > 0)) {
      if (row.link_id === null) continue;
      const key = `${row.relay_id}:${row.link_id}`;
      const entry = held.get(key) ?? { relayId: row.relay_id, linkId: row.link_id, refs: [] };
      entry.refs.push(row.id);
      held.set(key, entry);
    }
    if (held.size === 0) return { dropped: unsent.length, retracted: 0 };
    const deployment = await deploymentOf(tx);
    let retracted = 0;
    for (const entry of held.values()) {
      const { rows: [link] } = await tx.query<{ recipient_id: string | null }>('SELECT recipient_id FROM relay_links WHERE id = $1', [entry.linkId]);
      if (!link?.recipient_id) continue;
      const refs = [...entry.refs].sort();
      const id = envelopeId({ deployment, relay: entry.relayId, link: entry.linkId, type: 'room_activity_retracted', subject: refs.join(',') });
      const wrote = await enqueue(tx, {
        id, relayId: entry.relayId, linkId: entry.linkId, companyId, type: 'room_activity_retracted', subjects,
        body: envelopeBody({
          v: 1, id, type: 'room_activity_retracted', at: now.toISOString(), deployment, relay: entry.relayId,
          to: { recipient: link.recipient_id }, data: { refs },
        }),
      }, now);
      if (wrote) retracted += 1;
    }
    return { dropped: unsent.length, retracted };
  });
}

/**
 * What no call retracted: words removed with nothing told of it. A purge of
 * old messages calls nothing (STATUS section 2.212), and a delete's own call
 * runs after its transaction has committed, so a process that stops between
 * the two, or a database that refuses the second, leaves its retraction
 * unmade. The worker's notify stage looks each pass for a person's notice
 * whose message is deleted or gone and that is still owed, or that a relay
 * may hold with no retraction sent on its link, and retracts those messages
 * as a delete would. Answers what `retractMessages` did.
 */
export async function retractRemoved(companyId: string, now = new Date()): Promise<{ dropped: number; retracted: number }> {
  const { rows } = await withControlPlane((tx) => tx.query<{ id: string }>(
    `SELECT DISTINCT substr(s.subject, 9) AS id
       FROM relay_outbox o CROSS JOIN LATERAL unnest(o.subjects) AS s(subject)
      WHERE o.company_id = $1 AND o.type = 'room_activity' AND o.link_id IS NOT NULL AND s.subject LIKE 'message:%'
        AND NOT EXISTS (SELECT 1 FROM room_messages m
                         WHERE m.company_id = $1 AND m.id = substr(s.subject, 9)::uuid AND m.deleted_at IS NULL)
        AND (o.status IN ('pending', 'dead') OR NOT EXISTS (
              SELECT 1 FROM relay_outbox x
               WHERE x.link_id = o.link_id AND x.type = 'room_activity_retracted' AND x.subjects @> ARRAY[s.subject]))
      LIMIT ${RETRACT_BATCH}`,
    [companyId]));
  return retractMessages(companyId, rows.map((row) => row.id), now);
}

/**
 * A seat's kind changed: every offer it was sent to answer or decide is void
 * at once, in the caller's transaction, so an approver made a viewer presses
 * nothing it was offered before. A press is read again against the seat in
 * any case; this is what lets the phone be told the button is spent.
 */
export async function voidSeatOffers(tx: TenantClient, principal: string, now = new Date()): Promise<number> {
  const { rows: relays } = await tx.query<{ relay_id: string }>(
    `SELECT DISTINCT relay_id FROM relay_offers
      WHERE principal = $1 AND act IN ('approve', 'deny', 'answer') AND voided_at IS NULL ORDER BY relay_id`,
    [principal]);
  for (const one of relays) await relayRow(tx, one.relay_id, true);
  const { rowCount } = await tx.query(
    `UPDATE relay_offers SET voided_at = $2
      WHERE principal = $1 AND act IN ('approve', 'deny', 'answer') AND voided_at IS NULL`,
    [principal, now]);
  return rowCount ?? 0;
}

/**
 * Who of a company is told outside PALUGADA: a seat with a phone linked
 * through a paired relay that hears about the company; the owner only when
 * they chose to hear people (F10.5), and then through such a phone or a chat
 * that takes people's notices (`ownerChat`, the owner's Telegram). The
 * mention picker marks the rest, so nobody is surprised that a mention
 * reached no phone, and nobody is shown as told who will hear nothing.
 */
export async function linkedPeople(companyId: string, options: { ownerChat: boolean }): Promise<Set<string>> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ principal: string }>(
      `SELECT DISTINCT l.principal FROM relay_links l JOIN relays r ON r.id = l.relay_id
        WHERE l.status = 'active' AND r.status = 'paired' AND (r.all_companies OR $1 = ANY(r.companies))
          AND (l.company_id IS NULL OR l.company_id = $1)`,
      [companyId]);
    const told = new Set(rows.map((row) => row.principal));
    const { rows: [owner] } = await tx.query<{ hears: boolean }>(
      "SELECT owner_hears_people AS hears FROM principal_prefs WHERE principal = 'owner'");
    if (owner?.hears === true && options.ownerChat) told.add('owner');
    else if (owner?.hears !== true) told.delete('owner');
    return told;
  });
}
