/**
 * A person's phone, linked through a relay (F19.19, F19.20; STATUS section
 * 2.208).
 *
 * Nothing is sent on anyone's behalf until they link a device themselves:
 * consent is each person's (UU PDP). The person asks the console for a code,
 * eight base32 characters good for ten minutes, kept hashed per relay, and
 * enters it in the relay's app; the relay claims it, with a device key when
 * the app makes one. From then the relay knows the person by a pseudonym, the
 * person's acts need the device's signature when a key was given, and the
 * owner's link needs one before anything it sends but its own end counts.
 * A link ends by the relay, by the person, by the owner, or with the seat or
 * the relay; its offers end with it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { linkedSaid } from '../owner/relay-said.ts';
import { qrMatrix } from '../owner/qr.ts';
import { companyRef, envelopeBody, envelopeId, recipientId, SHARE_LEVELS, type Share } from './envelope.ts';
import { enqueue } from './outbox.ts';
import { covers, relayRow, type RelayRow } from './relays.ts';

/** How long a link code may be claimed. */
export const LINK_CODE_MINUTES = 10;

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A link code as kept: its hash under the relay it was offered through, so a code is good at one relay only. */
export function codeHash(relayId: string, code: string): string {
  return createHash('sha256').update(`${relayId}:${code}`, 'utf8').digest('hex');
}

/** Who is linking: the owner, or a seat of its company. */
export interface Linker {
  principal: string;
  companyId: string | null;
}

/** Refuses a relay the person cannot link through: not paired, or not hearing about their company. */
export async function assertLinkable(linker: Linker, relayId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    const relay = await relayRow(tx, relayId);
    if (!relay || relay.status !== 'paired' || (linker.companyId !== null && !covers(relay, linker.companyId))) {
      throw new PalugadaError('relay.not_paired', 'that relay is not paired to tell you about your company', { relayId });
    }
  });
}

/**
 * A code for a person to link a phone through a relay with. The relay must
 * be paired and hear about the person's company; the owner's link is the
 * caller's to guard with a fresh factor.
 */
export async function offerLink(linker: Linker, relayId: string, share: unknown, now = new Date()): Promise<{
  linkId: string; code: string; qr: string[]; expiresAt: string;
}> {
  if (share !== undefined && share !== null && !(SHARE_LEVELS as readonly unknown[]).includes(share)) {
    throw new PalugadaError('contract.violation', `a share level is one of ${SHARE_LEVELS.join(', ')}`, { field: 'share' });
  }
  const code = Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte & 31]).join('');
  const expiresAt = new Date(now.getTime() + LINK_CODE_MINUTES * 60_000);
  const linkId = await withControlPlane(async (tx) => {
    // The relay's row first, as every change of its links takes it, and read
    // as it is now: a relay revoked a moment ago offers no code.
    const relay = await relayRow(tx, relayId, true);
    if (!relay || relay.status !== 'paired' || (linker.companyId !== null && !covers(relay, linker.companyId))) {
      throw new PalugadaError('relay.not_paired', 'that relay is not paired to tell you about your company', { relayId });
    }
    // A person has one code waiting per relay: asking again replaces it.
    await tx.query(`DELETE FROM relay_links WHERE relay_id = $1 AND principal = $2 AND status = 'offered'`, [relayId, linker.principal]);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO relay_links (relay_id, principal, company_id, share, code_hash, code_expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'offered') RETURNING id`,
      [relayId, linker.principal, linker.companyId, share ?? null, codeHash(relayId, code), expiresAt]);
    return rows[0]!.id;
  });
  // What a relay's app scans: the code, under a scheme of its own so a camera knows what it read.
  const qr = qrMatrix(`palugada-link:${code}`).map((row) => row.map((on) => (on ? '1' : '0')).join(''));
  return { linkId, code, qr, expiresAt: expiresAt.toISOString() };
}

/**
 * A code claimed through a relay: the link becomes active, and the person is
 * told, through the relay, that it stands. A code offered through another
 * relay is not this one's, and a code is good once. Answers the pseudonym the
 * relay will know the person by and the companies it may hear about, by
 * reference; null when the code is not this relay's to claim.
 */
export async function claimLink(
  tx: TenantClient,
  given: Pick<RelayRow, 'id'>,
  claim: { code: string; label: string | null; deviceKey: Buffer | null; claimId: string },
  now = new Date(),
): Promise<{ linkId: string; recipient: string; companies: string[]; companyId: string | null } | null> {
  const code = claim.code.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{8}$/.test(code)) return null;
  // The relay's row first, as every change of its links takes it, and read as
  // it is now: a relay revoked while its claim was on the way claims nothing.
  const held = await relayRow(tx, given.id, true);
  if (!held || held.status !== 'paired') return null;
  const relay = held;
  const { rows } = await tx.query<{ id: string; principal: string; company_id: string | null }>(
    `SELECT id, principal, company_id FROM relay_links
      WHERE relay_id = $1 AND code_hash = $2 AND status = 'offered' AND code_expires_at > $3
        FOR UPDATE`,
    [relay.id, codeHash(relay.id, code), now]);
  const link = rows[0];
  if (!link) return null;
  const recipient = recipientId(relay.salt, link.principal);
  // One active link per person per relay: a phone linked again replaces the old one.
  const { rows: replaced } = await tx.query<{ id: string }>(
    `UPDATE relay_links SET status = 'ended', ended_at = $3 WHERE relay_id = $1 AND principal = $2 AND status = 'active' RETURNING id`,
    [relay.id, link.principal, now]);
  if (replaced.length > 0) {
    await tx.query('UPDATE relay_offers SET voided_at = $2 WHERE link_id = ANY($1::uuid[]) AND voided_at IS NULL', [replaced.map((one) => one.id), now]);
  }
  await tx.query(
    `UPDATE relay_links SET status = 'active', recipient_id = $2, label = $3, device_key = $4, claimed_at = $5, code_hash = NULL
      WHERE id = $1`,
    [link.id, recipient, claim.label, claim.deviceKey, now]);

  const companies = await companiesHeard(tx, relay, link.company_id);
  const { rows: [control] } = await tx.query<{ deployment: string; language: string | null }>(
    'SELECT deployment_id::text AS deployment, console_language AS language FROM platform_control');
  const language = control!.language;
  const id = envelopeId({ deployment: control!.deployment, relay: relay.id, link: link.id, type: 'link_confirmed', subject: link.id });
  await enqueue(tx, {
    id, relayId: relay.id, linkId: link.id, companyId: link.company_id, type: 'link_confirmed', subjects: [`link:${link.id}`],
    body: envelopeBody({
      v: 1, id, type: 'link_confirmed', at: now.toISOString(), deployment: control!.deployment, relay: relay.id,
      to: { recipient }, lang: language ?? 'en', text: linkedSaid(language),
      data: { claim: claim.claimId, companies, device: claim.deviceKey !== null },
    }),
  }, now);
  return { linkId: link.id, recipient, companies, companyId: link.company_id };
}

/** The companies a person's link hears about, by reference: a seat's own, or every one the relay covers for the owner. */
async function companiesHeard(tx: TenantClient, relay: RelayRow, companyId: string | null): Promise<string[]> {
  if (companyId !== null) return covers(relay, companyId) ? [companyRef(relay.salt, companyId)] : [];
  const { rows } = await tx.query<{ id: string }>(
    relay.all_companies ? 'SELECT id FROM companies ORDER BY created_at' : 'SELECT id FROM companies WHERE id = ANY($1::uuid[]) ORDER BY created_at',
    relay.all_companies ? [] : [relay.companies]);
  return rows.map((row) => companyRef(relay.salt, row.id));
}

/**
 * Ends links, and voids their offers and drops what they were owed and not
 * yet sent. The caller holds the row of every relay the links are through.
 */
export async function endLinks(tx: TenantClient, linkIds: readonly string[], now = new Date()): Promise<void> {
  if (linkIds.length === 0) return;
  await tx.query(`UPDATE relay_links SET status = 'ended', ended_at = $2 WHERE id = ANY($1::uuid[]) AND status <> 'ended'`, [linkIds, now]);
  await tx.query('UPDATE relay_offers SET voided_at = $2 WHERE link_id = ANY($1::uuid[]) AND voided_at IS NULL', [linkIds, now]);
  await tx.query(`DELETE FROM relay_outbox WHERE link_id = ANY($1::uuid[]) AND status IN ('pending', 'dead')`, [linkIds]);
}

/**
 * A person ends a link of theirs; the owner may end anyone's. Refused for a
 * link that is someone else's, or none.
 */
export async function endLink(linkId: string, by: Linker): Promise<void> {
  await withControlPlane(async (tx) => {
    const { rows: [through] } = await tx.query<{ relay_id: string }>('SELECT relay_id FROM relay_links WHERE id = $1', [linkId]);
    // The relay's row before the link, as every change of its links takes it.
    if (through) await relayRow(tx, through.relay_id, true);
    const { rows } = await tx.query<{ principal: string }>(
      `SELECT principal FROM relay_links WHERE id = $1 AND status <> 'ended' FOR UPDATE`, [linkId]);
    if (!rows[0] || (by.principal !== 'owner' && rows[0].principal !== by.principal)) {
      throw new PalugadaError('contract.violation', 'there is no such link of yours', { linkId });
    }
    await endLinks(tx, [linkId]);
  });
}

/** Every link of one person ends, in the caller's transaction: a seat revoked. */
export async function endLinksOf(tx: TenantClient, principal: string, now = new Date()): Promise<number> {
  // Each relay's row before its links, in the order of their ids, as every
  // transaction that touches more than one relay takes them.
  const { rows: relays } = await tx.query<{ relay_id: string }>(
    `SELECT DISTINCT relay_id FROM relay_links WHERE principal = $1 AND status <> 'ended' ORDER BY relay_id`, [principal]);
  for (const one of relays) await relayRow(tx, one.relay_id, true);
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM relay_links WHERE principal = $1 AND status <> 'ended' FOR UPDATE`, [principal]);
  await endLinks(tx, rows.map((row) => row.id), now);
  return rows.length;
}

/**
 * A person's own links, and the relays they may link through: paired, and
 * hearing about their company. Of a relay a person sees its name and nothing
 * else; the owner sees every link of their own, the owner's page the rest.
 */
export async function linksOf(linker: Linker, now = new Date()): Promise<{
  links: Array<{ id: string; relayId: string; relay: string; label: string | null; status: string; share: Share | null; device: boolean; createdAt: string; claimedAt: string | null }>;
  relays: Array<{ id: string; name: string }>;
}> {
  return withControlPlane(async (tx) => {
    const { rows: links } = await tx.query<{
      id: string; relay_id: string; name: string; label: string | null; status: string; share: Share | null;
      device: boolean; created_at: Date; claimed_at: Date | null;
    }>(
      `SELECT l.id, l.relay_id, r.name, l.label, l.status, l.share, l.device_key IS NOT NULL AS device, l.created_at, l.claimed_at
         FROM relay_links l JOIN relays r ON r.id = l.relay_id
        WHERE l.principal = $1 AND r.status = 'paired'
          AND (l.status = 'active' OR (l.status = 'offered' AND l.code_expires_at > $2))
        ORDER BY l.created_at`,
      [linker.principal, now]);
    const { rows: relays } = await tx.query<{ id: string; name: string; companies: string[]; all_companies: boolean }>(
      `SELECT id, name, companies, all_companies FROM relays WHERE status = 'paired' ORDER BY created_at`);
    return {
      links: links.map((row) => ({
        id: row.id, relayId: row.relay_id, relay: row.name, label: row.label, status: row.status, share: row.share,
        device: row.device, createdAt: row.created_at.toISOString(), claimedAt: row.claimed_at?.toISOString() ?? null,
      })),
      relays: relays.filter((relay) => linker.companyId === null || covers(relay, linker.companyId))
        .map((relay) => ({ id: relay.id, name: relay.name })),
    };
  });
}
