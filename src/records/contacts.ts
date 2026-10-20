/**
 * The company's own records of the people it deals with (0118, STATUS 2.138).
 *
 * `crm.read` and `crm.note` were catalogued from the start and bound to
 * nothing: the responder and the marketer were told to keep the customer
 * record, and there was none to keep, so what a customer was told lived in a
 * run's output and went with it. These are the records the platform keeps
 * until the owner connects a CRM of their own (`src/capabilities/crm.ts`
 * binds the names as a fallback):
 *
 *   - **a contact**: a name, an organisation, an address and a number; made
 *     by the owner, by a run, or by a customer's first message on a channel,
 *     which finds the contact the owner already keeps by its address or its
 *     number;
 *   - **notes**, kept as written: the application role adds and never
 *     rewrites one;
 *   - **deals**: what the company hopes to sell someone, how far it got, and
 *     what it is worth.
 *
 * A contact's fields are partly a stranger's words -- the name a customer
 * gave Telegram -- so what reads them back reads outside content (F8.9).
 */
import { appendEvent } from '../audit/event-log.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { ChatKind } from '../chats/chats.ts';

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Who wrote a record. */
export type RecordedBy = 'owner' | 'agent';

export interface ContactFields {
  name?: string;
  organisation?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface DealInput {
  /** The deal to change; without it, a new one. */
  id?: string;
  title?: string;
  stage?: DealStage;
  value?: { amountCents: number; currency: string } | null;
  /** When it is expected to close, as YYYY-MM-DD. */
  expectedOn?: string | null;
}

const NAME_MAX = 200;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,30}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The fewest digits a stored number is matched on: fewer would find strangers. */
const PHONE_MATCH_DIGITS = 8;
/** The notes a run is shown of a contact, newest first. */
export const NOTES_SHOWN = 10;

/** Who the owner's timeline says did it. */
function actorOf(by: RecordedBy | 'chat'): string {
  return by === 'owner' ? 'owner' : by === 'agent' ? 'agent_run' : 'system';
}

function violation(message: string, field: string): PalugadaError {
  return new PalugadaError('contract.violation', message, { field });
}

/** Text or null, trimmed: an empty string means "none". */
function optionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw violation(`${field} is text or null`, field);
  return value.trim() || null;
}

/**
 * Each field given, held to its shape before the database is asked, with an
 * error that says what is accepted. A field not given is left as it is.
 */
export function contactFields(input: Record<string, unknown>): ContactFields {
  const fields: ContactFields = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > NAME_MAX) throw violation(`a contact's name is 1 to ${NAME_MAX} characters`, 'name');
    fields.name = name;
  }
  if (input.organisation !== undefined) {
    const organisation = optionalText(input.organisation, 'organisation');
    if (organisation && organisation.length > NAME_MAX) throw violation(`an organisation is at most ${NAME_MAX} characters`, 'organisation');
    fields.organisation = organisation;
  }
  if (input.email !== undefined) {
    const email = optionalText(input.email, 'email');
    if (email && (email.length > 254 || !EMAIL.test(email))) {
      throw violation(`an email address is name@domain, such as ayu@hotel.example; got ${JSON.stringify(email.slice(0, 80))}`, 'email');
    }
    fields.email = email;
  }
  if (input.phone !== undefined) {
    const phone = optionalText(input.phone, 'phone');
    if (phone && !PHONE.test(phone)) {
      throw violation(`a phone number is digits, with + and the country code when it has one, such as +62 812 3456 7890; got ${JSON.stringify(phone.slice(0, 40))}`, 'phone');
    }
    fields.phone = phone;
  }
  return fields;
}

/** A deal held to its shape. */
export function dealInput(input: Record<string, unknown>): DealInput {
  const deal: DealInput = {};
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !ID.test(input.id)) throw violation('a deal is named by its id', 'deal.id');
    deal.id = input.id;
  }
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > NAME_MAX) throw violation(`a deal's title is 1 to ${NAME_MAX} characters`, 'deal.title');
    deal.title = title;
  }
  if (input.stage !== undefined) {
    if (!(DEAL_STAGES as readonly unknown[]).includes(input.stage)) {
      throw violation(`a deal's stage is ${DEAL_STAGES.join(', ')}; got ${JSON.stringify(input.stage)}`, 'deal.stage');
    }
    deal.stage = input.stage as DealStage;
  }
  if (input.value !== undefined) {
    if (input.value === null) {
      deal.value = null;
    } else {
      const value = input.value as { amountCents?: unknown; currency?: unknown };
      if (typeof value !== 'object' || !Number.isSafeInteger(value.amountCents) || (value.amountCents as number) < 0
          || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) {
        throw violation('a deal\'s value is { amountCents, currency }: whole cents and a three-letter currency such as IDR', 'deal.value');
      }
      deal.value = { amountCents: value.amountCents as number, currency: value.currency };
    }
  }
  if (input.expectedOn !== undefined) {
    if (input.expectedOn === null) {
      deal.expectedOn = null;
    } else if (typeof input.expectedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedOn)
        || Number.isNaN(Date.parse(`${input.expectedOn}T00:00:00Z`))
        || new Date(`${input.expectedOn}T00:00:00Z`).toISOString().slice(0, 10) !== input.expectedOn) {
      throw violation('when a deal is expected to close is a date, YYYY-MM-DD', 'deal.expectedOn');
    } else {
      deal.expectedOn = input.expectedOn;
    }
  }
  return deal;
}

/** The contact, or a refusal naming it: in this company, whatever else it is. */
async function existing(tx: TenantClient, companyId: string, contactId: string): Promise<{ archived: boolean }> {
  const { rows } = ID.test(contactId)
    ? await tx.query<{ archived_at: Date | null }>('SELECT archived_at FROM contacts WHERE id = $1 AND company_id = $2', [contactId, companyId])
    : { rows: [] };
  if (!rows[0]) throw violation(`no contact ${contactId} in this company`, 'contact');
  return { archived: rows[0].archived_at !== null };
}

export async function addContact(tx: TenantClient, companyId: string, fields: ContactFields, by: RecordedBy | 'chat', taskId: string | null = null): Promise<string> {
  if (!fields.name) throw violation('a new contact needs a name', 'name');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO contacts (company_id, name, organisation, email, phone, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, fields.name, fields.organisation ?? null, fields.email ?? null, fields.phone ?? null, by]);
  const contactId = rows[0]!.id;
  await appendEvent(tx, {
    companyId, ...(taskId ? { taskId } : {}), type: 'contact.added', actor: actorOf(by), payload: { contactId, by },
  });
  return contactId;
}

/** Changes what is given; the event keeps what each field was, so a change can be undone by hand. */
export async function changeContact(tx: TenantClient, companyId: string, contactId: string, fields: ContactFields, by: RecordedBy, taskId: string | null = null): Promise<void> {
  await existing(tx, companyId, contactId);
  const names = (Object.keys(fields) as Array<keyof ContactFields>);
  if (names.length === 0) return;
  const { rows: [before] } = await tx.query<Record<string, string | null>>(
    `SELECT ${names.join(', ')} FROM contacts WHERE id = $1`, [contactId]);
  await tx.query(
    `UPDATE contacts SET ${names.map((name, n) => `${name} = $${n + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [contactId, ...names.map((name) => fields[name] ?? null)]);
  await appendEvent(tx, {
    companyId, ...(taskId ? { taskId } : {}), type: 'contact.changed', actor: actorOf(by),
    payload: { contactId, by, before: before ?? {} },
  });
}

export async function archiveContact(tx: TenantClient, companyId: string, contactId: string, archived: boolean): Promise<void> {
  await existing(tx, companyId, contactId);
  await tx.query(
    'UPDATE contacts SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1',
    [contactId, archived]);
  await appendEvent(tx, { companyId, type: archived ? 'contact.archived' : 'contact.restored', actor: 'owner', payload: { contactId } });
}

export async function noteContact(tx: TenantClient, companyId: string, contactId: string, body: string, by: RecordedBy, taskId: string | null = null): Promise<string> {
  await existing(tx, companyId, contactId);
  const text = body.trim();
  if (!text || text.length > 4000) throw violation('a note is 1 to 4000 characters', 'body');
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO contact_notes (company_id, contact_id, body, written_by, task_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [companyId, contactId, text, by, taskId]);
  await tx.query('UPDATE contacts SET updated_at = now() WHERE id = $1', [contactId]);
  await appendEvent(tx, {
    companyId, ...(taskId ? { taskId } : {}), type: 'contact.noted', actor: actorOf(by),
    payload: { contactId, noteId: rows[0]!.id, by },
  });
  return rows[0]!.id;
}

/** Opens a deal with a contact, or changes one of theirs. Won or lost, it is closed; moved back, open again. */
export async function recordDeal(tx: TenantClient, companyId: string, contactId: string, deal: DealInput, by: RecordedBy, taskId: string | null = null): Promise<string> {
  await existing(tx, companyId, contactId);
  const valueCents = deal.value === undefined ? undefined : deal.value?.amountCents ?? null;
  const currency = deal.value === undefined ? undefined : deal.value?.currency ?? null;
  let dealId: string;
  if (deal.id) {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE deals
          SET title = coalesce($3, title),
              stage = coalesce($4, stage),
              value_cents = CASE WHEN $5 THEN $6::bigint ELSE value_cents END,
              currency = CASE WHEN $5 THEN $7 ELSE currency END,
              expected_on = CASE WHEN $8 THEN $9::date ELSE expected_on END,
              closed_at = CASE WHEN coalesce($4, stage) IN ('won', 'lost') THEN coalesce(closed_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND contact_id = $2 RETURNING id`,
      [deal.id, contactId, deal.title ?? null, deal.stage ?? null, valueCents !== undefined, valueCents ?? null, currency ?? null,
        deal.expectedOn !== undefined, deal.expectedOn ?? null]);
    if (!rows[0]) throw violation(`no deal ${deal.id} with this contact`, 'deal.id');
    dealId = rows[0].id;
  } else {
    if (!deal.title) throw violation('a new deal needs a title', 'deal.title');
    const stage = deal.stage ?? 'lead';
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO deals (company_id, contact_id, title, stage, value_cents, currency, expected_on, created_by, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $4 IN ('won', 'lost') THEN now() END) RETURNING id`,
      [companyId, contactId, deal.title, stage, valueCents ?? null, currency ?? null, deal.expectedOn ?? null, by]);
    dealId = rows[0]!.id;
  }
  await tx.query('UPDATE contacts SET updated_at = now() WHERE id = $1', [contactId]);
  await appendEvent(tx, {
    companyId, ...(taskId ? { taskId } : {}), type: deal.id ? 'deal.changed' : 'deal.opened', actor: actorOf(by),
    payload: { dealId, contactId, by, ...(deal.stage ? { stage: deal.stage } : {}) },
  });
  return dealId;
}

/**
 * The contact a customer's first message on a channel is from: the one the
 * owner already keeps with that address or that number, or a new one named
 * as the customer named themselves. A Telegram customer is known by nothing
 * the owner would have written down, so each Telegram conversation starts
 * its own. On whichever client the caller holds -- a delivery is written on
 * the control plane -- with the company named in every statement.
 */
export async function contactForMessage(tx: TenantClient, input: {
  companyId: string; kind: ChatKind; handle: string | null; name: string | null;
}): Promise<string> {
  const handle = input.handle?.trim() || null;
  const email = input.kind === 'email' && handle && EMAIL.test(handle) && handle.length <= 254 ? handle : null;
  const digits = input.kind === 'whatsapp' && handle ? handle.replace(/\D/g, '') : '';
  if (email) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM contacts WHERE company_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`, [input.companyId, email]);
    if (rows[0]) return rows[0].id;
  }
  if (digits.length >= PHONE_MATCH_DIGITS) {
    // A number the owner wrote with its country code is the same number only
    // when every digit is. One written for its own country -- 0812 3456
    // 7890 -- is matched without its leading zero on the end of the number
    // the customer wrote from, and only when what is left over is a country
    // code: one to three digits.
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM (
         SELECT id, updated_at,
                btrim(phone) ~ '^(\\+|00)' AS international,
                regexp_replace(regexp_replace(btrim(phone), '^00', ''), '\\D', '', 'g') AS digits,
                ltrim(regexp_replace(phone, '\\D', '', 'g'), '0') AS kept
           FROM contacts WHERE company_id = $1 AND phone IS NOT NULL AND archived_at IS NULL) numbers
        WHERE (international AND digits = $2)
           OR (NOT international AND length(kept) >= $3 AND length($2) - length(kept) BETWEEN 1 AND 3 AND right($2, length(kept)) = kept)
        ORDER BY updated_at DESC LIMIT 1`, [input.companyId, digits, PHONE_MATCH_DIGITS]);
    if (rows[0]) return rows[0].id;
  }
  const phone = digits.length >= 6 && digits.length <= 20 ? `+${digits}` : null;
  const said = (input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  const name = said || email || phone || handle?.slice(0, NAME_MAX) || `${input.kind} customer`;
  return addContact(tx, input.companyId, { name, email, phone }, 'chat');
}

export interface ContactSummary {
  id: string;
  name: string;
  organisation: string | null;
  email: string | null;
  phone: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  openDeals: number;
  chats: number;
}

/** What a search looks for in: the name, the organisation, the address, and the number's digits. */
function matching(query: string): { sql: string; values: string[] } {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return { sql: 'true', values: [] };
  const like = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return {
    sql: words.map((_, n) => `(lower(c.name) LIKE $${n + 1} OR lower(coalesce(c.organisation, '')) LIKE $${n + 1}
      OR lower(coalesce(c.email, '')) LIKE $${n + 1} OR regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') LIKE $${n + 1})`).join(' AND '),
    values: words.map(like),
  };
}

const SUMMARY = `SELECT c.id, c.name, c.organisation, c.email, c.phone, c.created_by, c.created_at, c.updated_at, c.archived_at,
         (SELECT count(*)::int FROM deals d WHERE d.contact_id = c.id AND d.closed_at IS NULL) AS open_deals,
         (SELECT count(*)::int FROM chats h WHERE h.contact_id = c.id) AS chats
    FROM contacts c`;

interface SummaryRow {
  id: string; name: string; organisation: string | null; email: string | null; phone: string | null; created_by: string;
  created_at: Date; updated_at: Date; archived_at: Date | null; open_deals: number; chats: number;
}

function summaryOf(row: SummaryRow): ContactSummary {
  return {
    id: row.id, name: row.name, organisation: row.organisation, email: row.email, phone: row.phone, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at, openDeals: row.open_deals, chats: row.chats,
  };
}

/** The company's contacts for the owner, the latest touched first and the archived last; with a query, those it finds. */
export async function listContacts(companyId: string, query = ''): Promise<ContactSummary[]> {
  return withTenant(companyId, async (tx) => {
    const where = matching(query);
    const { rows } = await tx.query<SummaryRow>(
      `${SUMMARY} WHERE ${where.sql} ORDER BY c.archived_at IS NOT NULL, c.updated_at DESC, c.name LIMIT 200`, where.values);
    return rows.map(summaryOf);
  });
}

export interface ContactNote { id: string; body: string; by: RecordedBy; taskId: string | null; at: Date }
export interface Deal {
  id: string; title: string; stage: DealStage; value: { amountCents: number; currency: string } | null;
  expectedOn: string | null; createdBy: RecordedBy; createdAt: Date; updatedAt: Date; closedAt: Date | null;
}
export interface ContactChat { id: string; kind: ChatKind; account: string; lastMessageAt: Date }

/** A contact whole: its notes, newest first, its deals, and its conversations. */
export async function contactWith(tx: TenantClient, contactId: string, notes = 100): Promise<{
  contact: ContactSummary; notes: ContactNote[]; deals: Deal[]; chats: ContactChat[];
} | null> {
  if (!ID.test(contactId)) return null;
  const { rows: [row] } = await tx.query<SummaryRow>(`${SUMMARY} WHERE c.id = $1`, [contactId]);
  if (!row) return null;
  const { rows: written } = await tx.query<{ id: string; body: string; written_by: RecordedBy; task_id: string | null; created_at: Date }>(
    'SELECT id, body, written_by, task_id, created_at FROM contact_notes WHERE contact_id = $1 ORDER BY created_at DESC LIMIT $2', [contactId, notes]);
  const { rows: deals } = await tx.query<{
    id: string; title: string; stage: DealStage; value_cents: string | null; currency: string | null; expected_on: string | null;
    created_by: RecordedBy; created_at: Date; updated_at: Date; closed_at: Date | null;
  }>(
    `SELECT id, title, stage, value_cents, currency, to_char(expected_on, 'YYYY-MM-DD') AS expected_on, created_by, created_at, updated_at, closed_at
       FROM deals WHERE contact_id = $1 ORDER BY closed_at IS NOT NULL, updated_at DESC`, [contactId]);
  const { rows: chats } = await tx.query<{ id: string; kind: ChatKind; account: string; last_message_at: Date }>(
    `SELECT h.id, c.kind, c.account, h.last_message_at FROM chats h JOIN chat_channels c ON c.id = h.channel_id
      WHERE h.contact_id = $1 ORDER BY h.last_message_at DESC`, [contactId]);
  return {
    contact: summaryOf(row),
    notes: written.map((note) => ({ id: note.id, body: note.body, by: note.written_by, taskId: note.task_id, at: note.created_at })),
    deals: deals.map((deal) => ({
      id: deal.id, title: deal.title, stage: deal.stage,
      value: deal.value_cents !== null && deal.currency !== null ? { amountCents: Number(deal.value_cents), currency: deal.currency } : null,
      expectedOn: deal.expected_on, createdBy: deal.created_by, createdAt: deal.created_at, updatedAt: deal.updated_at, closedAt: deal.closed_at,
    })),
    chats: chats.map((chat) => ({ id: chat.id, kind: chat.kind, account: chat.account, lastMessageAt: chat.last_message_at })),
  };
}

/** The contacts a search finds, for a run: never the archived, at most `limit`, and whether there were more. */
export async function findContacts(tx: TenantClient, query: string, limit: number): Promise<{ ids: string[]; truncated: boolean }> {
  const where = matching(query);
  const { rows } = await tx.query<{ id: string }>(
    `SELECT c.id FROM contacts c WHERE c.archived_at IS NULL AND ${where.sql} ORDER BY c.updated_at DESC LIMIT ${limit + 1}`, where.values);
  return { ids: rows.slice(0, limit).map((row) => row.id), truncated: rows.length > limit };
}

/** The contact of a conversation, if it has one. */
export async function contactOfChat(tx: TenantClient, chatId: string): Promise<string | null> {
  if (!ID.test(chatId)) return null;
  const { rows } = await tx.query<{ contact_id: string | null }>('SELECT contact_id FROM chats WHERE id = $1', [chatId]);
  return rows[0]?.contact_id ?? null;
}

