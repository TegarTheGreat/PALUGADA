/**
 * What a person may do from a notice (F19.20; STATUS section 2.208).
 *
 * An offer is a token sent with a notice to one person through one relay,
 * for one act on one item: approve or deny it, or answer its question. The
 * relay holds the only copy; PALUGADA keeps its SHA-256. A press redeems it
 * once, and the press is checked again in full when it arrives -- the item's
 * tier, the seat's kind now, four eyes -- so an offer is only ever a way to
 * ask, never a decision made in advance. None is ever made at tier 3, for an
 * incident, or for anything a chat may not act on (F10.9, F10.10), and none
 * outlives the item it is for.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '../db/tenant.ts';
import { offerLabel } from '../owner/relay-said.ts';
import type { Share } from './envelope.ts';

/** How long an offer may be pressed, at most; never past the item's own expiry. */
export const OFFER_HOURS = 72;

/** The SHA-256 of a token, hex: all that is kept of it. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** What a notice offers: the token the relay presses with, the act, and the words on the button. */
export interface Offer {
  token: string;
  act: 'approve' | 'deny' | 'answer';
  label: string;
}

/**
 * Makes the offers for one item sent to one person, and keeps their hashes.
 * A question is answered: with one of its choices when the share shows them,
 * or in words. Anything else is approved or denied. The caller has already
 * decided that this item, this relay and this person may be offered anything
 * at all.
 */
export async function mintOffers(tx: TenantClient, input: {
  relayId: string;
  linkId: string;
  companyId: string;
  principal: string;
  item: { id: string; question: boolean; options: readonly string[] | null };
  expiresAt: Date;
  language: string | null;
  share: Share;
}): Promise<Offer[]> {
  const wanted: Array<{ act: Offer['act']; option: string | null; label: string }> = [];
  if (input.item.question) {
    // The choices are the run's own words, and words are what `content` carries.
    if (input.share === 'content') {
      for (const option of (input.item.options ?? []).slice(0, 6)) {
        if (option.length <= 80) wanted.push({ act: 'answer', option, label: option });
      }
    }
    wanted.push({ act: 'answer', option: null, label: offerLabel(input.language, 'answer') });
  } else {
    wanted.push({ act: 'approve', option: null, label: offerLabel(input.language, 'approve') });
    wanted.push({ act: 'deny', option: null, label: offerLabel(input.language, 'deny') });
  }
  const offers: Offer[] = [];
  for (const one of wanted) {
    const token = `pt_${randomBytes(32).toString('base64url')}`;
    await tx.query(
      `INSERT INTO relay_offers (token_hash, relay_id, link_id, company_id, principal, act, inbox_item_id, option, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tokenHash(token), input.relayId, input.linkId, input.companyId, input.principal, one.act, input.item.id, one.option, input.expiresAt]);
    offers.push({ token, act: one.act, label: one.label });
  }
  return offers;
}

/** When an offer made now stops: three days on, or when the item expires, whichever is first. */
export function offerExpiry(now: Date, itemExpires: Date | null | undefined): Date {
  const latest = new Date(now.getTime() + OFFER_HOURS * 3_600_000);
  return itemExpires && itemExpires < latest ? itemExpires : latest;
}
