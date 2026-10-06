/**
 * The customer record, kept by the platform (0118, STATUS 2.138): `crm.read`,
 * `crm.note` and `crm.record` on `src/records/contacts.ts`.
 *
 * Bound as a fallback: a CRM the owner connects -- a vendor file, a service
 * in the console -- takes the names over, and these give way rather than
 * refuse it as a second binding (`fallback` in src/broker/registry.ts).
 *
 * Each works on the customer the work answers when it names none: the
 * contact of the conversation that started it. Reading is tier 0 and reads
 * outside content -- a contact's name and its notes are partly a customer's
 * own words -- so the work that reads it asks the owner before anything at
 * tier 2 (F8.9). Noting and recording are internal and tier 1, each read
 * back.
 */
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { chatOfTask } from '../chats/chats.ts';
import {
  DEAL_STAGES, NOTES_SHOWN, addContact, changeContact, contactFields, contactOfChat, contactWith, dealInput, findContacts,
  noteContact, recordDeal, type ContactChat, type ContactNote, type Deal,
} from '../records/contacts.ts';

const CONTACT_ID = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
const FOUND_MAX = 10;

export interface CrmContact {
  id: string;
  name: string;
  organisation: string | null;
  email: string | null;
  phone: string | null;
  archived: boolean;
  notes: Array<{ body: string; by: ContactNote['by']; at: string }>;
  deals: Array<{ id: string; title: string; stage: Deal['stage']; value: Deal['value']; expectedOn: string | null }>;
  conversations: Array<{ chatId: string; channel: ContactChat['kind']; lastMessageAt: string }>;
}

/** The contact the work answers: the one named, or the one of the conversation that started it. */
async function contactFor(tx: TenantClient, ctx: CapabilityContext, named: unknown): Promise<string> {
  if (typeof named === 'string') return named;
  const chatId = await chatOfTask(tx, ctx.taskId);
  const contactId = chatId ? await contactOfChat(tx, chatId) : null;
  if (!contactId) {
    throw new PalugadaError('contract.violation',
      'this work answers no conversation with a customer: name the contact by its id from crm.read, or "new" with a name', { field: 'contact' });
  }
  return contactId;
}

async function read(tx: TenantClient, contactId: string): Promise<CrmContact | null> {
  const found = await contactWith(tx, contactId, NOTES_SHOWN);
  if (!found) return null;
  const { contact } = found;
  return {
    id: contact.id, name: contact.name, organisation: contact.organisation, email: contact.email, phone: contact.phone,
    archived: contact.archivedAt !== null,
    notes: found.notes.map((note) => ({ body: note.body, by: note.by, at: note.at.toISOString() })),
    deals: found.deals.map((deal) => ({ id: deal.id, title: deal.title, stage: deal.stage, value: deal.value, expectedOn: deal.expectedOn })),
    conversations: found.chats.map((chat) => ({ chatId: chat.id, channel: chat.kind, lastMessageAt: chat.lastMessageAt.toISOString() })),
  };
}

export function crmRead(): Capability<{ contact?: string; query?: string; chatId?: string }, { contacts: CrmContact[]; truncated: boolean; note?: string }> {
  return {
    name: 'crm.read',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { ...CONTACT_ID, description: 'One contact, by its id.' },
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words in a name, an organisation, an address or a number.' },
        chatId: { ...CONTACT_ID, description: 'The customer of this conversation.' },
      },
      additionalProperties: false,
    },
    adapter: 'platform:records',
    defaultTier: 0,
    fallback: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      return withTenant(ctx.companyId, async (tx) => {
        if (input.query) {
          const found = await findContacts(tx, input.query, FOUND_MAX);
          const contacts: CrmContact[] = [];
          for (const id of found.ids) contacts.push((await read(tx, id))!);
          return { contacts, truncated: found.truncated };
        }
        const contactId = input.contact
          ?? (input.chatId ? await contactOfChat(tx, input.chatId) : null)
          ?? await (async () => {
            const chatId = await chatOfTask(tx, ctx.taskId);
            return chatId ? contactOfChat(tx, chatId) : null;
          })();
        if (!contactId) {
          return { contacts: [], truncated: false, note: 'This work answers no conversation with a customer: search with query, or name a contact.' };
        }
        const contact = await read(tx, contactId);
        if (!contact) throw new PalugadaError('contract.violation', `no contact ${contactId} in this company`, { field: 'contact' });
        return { contacts: [contact], truncated: false };
      });
    },
  };
}

export function crmNote(): Capability<{ contact?: string; body: string }, { noteId: string; contactId: string }> {
  return {
    name: 'crm.note',
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        contact: { ...CONTACT_ID, description: 'The contact; left out, the customer this work answers.' },
        body: { type: 'string', minLength: 1, maxLength: 4000, description: 'What happened, as the next person to serve them needs it.' },
      },
      additionalProperties: false,
    },
    adapter: 'platform:records',
    defaultTier: 1,
    fallback: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      return withTenant(ctx.companyId, async (tx) => {
        const contactId = await contactFor(tx, ctx, input.contact);
        const noteId = await noteContact(tx, ctx.companyId, contactId, String(input.body ?? ''), 'agent', ctx.taskId);
        return { noteId, contactId };
      });
    },
    async verify(_input, result, ctx) {
      return withTenant(ctx.companyId, async (tx) => (await tx.query(
        'SELECT 1 FROM contact_notes WHERE id = $1 AND contact_id = $2', [result.noteId, result.contactId])).rows.length === 1);
    },
  };
}

interface RecordInput {
  contact?: string;
  name?: string;
  organisation?: string | null;
  email?: string | null;
  phone?: string | null;
  deal?: Record<string, unknown>;
}

export function crmRecord(): Capability<RecordInput, { contactId: string; created: boolean; dealId?: string }> {
  const nullableText = (max: number, description: string) => ({ type: ['string', 'null'], maxLength: max, description });
  return {
    name: 'crm.record',
    inputSchema: {
      type: 'object',
      properties: {
        contact: {
          type: 'string', pattern: '^([0-9a-f-]{36}|new)$',
          description: 'The contact, by its id; "new" to keep someone the company does not know yet; left out, the customer this work answers.',
        },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        organisation: nullableText(200, 'Where they work, or the business they are.'),
        email: nullableText(254, 'Their address.'),
        phone: nullableText(40, 'Their number, with + and the country code when it has one.'),
        deal: {
          type: 'object',
          description: 'A deal with them: without id, a new one; with it, that one changed.',
          properties: {
            id: CONTACT_ID,
            title: { type: 'string', minLength: 1, maxLength: 200 },
            stage: { type: 'string', enum: [...DEAL_STAGES] },
            value: {
              type: ['object', 'null'],
              required: ['amountCents', 'currency'],
              properties: {
                amountCents: { type: 'integer', minimum: 0 },
                currency: { type: 'string', pattern: '^[A-Z]{3}$' },
              },
              additionalProperties: false,
            },
            expectedOn: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    adapter: 'platform:records',
    defaultTier: 1,
    fallback: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      // Held to their shape before anything is written.
      const fields = contactFields({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.organisation !== undefined ? { organisation: input.organisation } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
      });
      const deal = input.deal ? dealInput(input.deal) : null;
      return withTenant(ctx.companyId, async (tx) => {
        let contactId: string;
        let created = false;
        if (input.contact === 'new') {
          contactId = await addContact(tx, ctx.companyId, fields, 'agent', ctx.taskId);
          created = true;
        } else {
          contactId = await contactFor(tx, ctx, input.contact);
          await changeContact(tx, ctx.companyId, contactId, fields, 'agent', ctx.taskId);
        }
        const dealId = deal ? await recordDeal(tx, ctx.companyId, contactId, deal, 'agent', ctx.taskId) : null;
        return { contactId, created, ...(dealId ? { dealId } : {}) };
      });
    },
    async verify(_input, result, ctx) {
      return withTenant(ctx.companyId, async (tx) => {
        const contact = await tx.query('SELECT 1 FROM contacts WHERE id = $1', [result.contactId]);
        const deal = result.dealId ? await tx.query('SELECT 1 FROM deals WHERE id = $1 AND contact_id = $2', [result.dealId, result.contactId]) : null;
        return contact.rows.length === 1 && (deal === null || deal.rows.length === 1);
      });
    },
  };
}

export function crmCapabilities(): Array<Capability<never, never>> {
  return [crmRead(), crmNote(), crmRecord()] as unknown as Array<Capability<never, never>>;
}
