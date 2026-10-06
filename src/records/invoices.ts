/**
 * The company's invoices, kept in its books (0122, STATUS 2.154).
 *
 * `invoice.issue` was catalogued and bound to an accounting service nobody had
 * connected, so the bookkeeper was told to issue invoices and had nowhere to
 * issue them. These are the invoices the platform keeps beside the books of
 * 0119 until the owner connects an accounting service (`src/capabilities/
 * books.ts` binds the names as a fallback):
 *
 *   - **numbered without gaps**, INV-0001 on: the number is taken in the
 *     transaction that writes the invoice, so a refused invoice uses none;
 *   - **written with its entry** -- what the customer owes on the receivable
 *     side, the sale and the tax owed on the other -- so the books and the
 *     invoice cannot disagree about what was invoiced;
 *   - **never rewritten**: it is paid by entries of its own, in part or in
 *     full, and voided by the reversal of the entry that issued it -- which
 *     is how an invoice is known to be void, and only while nothing was paid
 *     on it;
 *   - **owed is read from the entries**, not kept: a payment whose entry was
 *     reversed in the books no longer counts, and the invoice is open again
 *     for what it was.
 *
 * Money is whole cents and a quantity is thousandths, so no figure is a
 * float; a tax is rounded half up, once, on the subtotal.
 */
import { appendEvent } from '../audit/event-log.ts';
import { wrapUntrusted } from '../context/builder.ts';
import type { TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { accountsOf, isDay, postEntry, reverseEntry, type Account, type EntryInput } from './books.ts';

const LINES_MOST = 40;
/** What `journal_lines_sane` allows a line: no invoice, and no payment, is for more. */
const SANE = 100_000_000_000_000n;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMBER = /^INV-\d{4,9}$/;
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEFAULT_TERMS_DAYS = 14;
const TERMS_DAYS_MOST = 365;

function violation(message: string, field: string): PalugadaError {
  return new PalugadaError('contract.violation', message, { field });
}

const today = () => new Date().toISOString().slice(0, 10);

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export type InvoiceStatus = 'open' | 'partial' | 'paid' | 'void';

export interface InvoiceLine { description: string; quantity: number; unitCents: number; amountCents: number }

export interface Invoice {
  id: string;
  number: string;
  contactId: string | null;
  customerName: string;
  customerEmail: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
  status: InvoiceStatus;
  /** Open or part paid, and past its due day. */
  overdue: boolean;
  note: string | null;
  entryId: string;
  writtenBy: 'owner' | 'agent';
  outside: boolean;
  createdAt: Date;
}

export interface InvoicePayment { id: string; paidOn: string; amountCents: number; entryId: string; reversed: boolean; writtenBy: 'owner' | 'agent' }

export interface InvoiceDetail extends Invoice { lines: InvoiceLine[]; payments: InvoicePayment[] }

/* ----------------------------------------------------------------- input --- */

interface ParsedInvoice {
  contactId: string | null;
  customerName: string;
  customerEmail: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  taxRateBps: number;
  lines: Array<{ description: string; quantityMilli: bigint; unitCents: number; amountCents: bigint }>;
  subtotal: bigint;
  tax: bigint;
  total: bigint;
  note: string | null;
}

/** Half up, in whole cents: (a × b) / 1000, or / 10000, without a float. */
const roundedDiv = (numerator: bigint, divisor: bigint): bigint => (numerator + divisor / 2n) / divisor;

/**
 * An invoice held to its shape before the database is asked, with what is
 * accepted when it is not. The customer's record is looked up here, so a
 * contact from another company is "no such contact", as it is.
 */
async function parseInvoice(tx: TenantClient, companyId: string, raw: Record<string, unknown>): Promise<ParsedInvoice> {
  if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) {
    throw violation('an invoice\'s currency is three letters, such as IDR', 'currency');
  }
  const issueDate = raw.issueDate === undefined ? today() : raw.issueDate;
  if (!isDay(issueDate)) throw violation('issueDate is a day, YYYY-MM-DD', 'issueDate');
  let dueDate: string;
  if (raw.dueDate !== undefined) {
    if (!isDay(raw.dueDate)) throw violation('dueDate is a day, YYYY-MM-DD', 'dueDate');
    dueDate = raw.dueDate;
  } else {
    const terms = raw.dueInDays === undefined ? DEFAULT_TERMS_DAYS : raw.dueInDays;
    if (!Number.isInteger(terms) || (terms as number) < 0 || (terms as number) > TERMS_DAYS_MOST) {
      throw violation(`dueInDays is a whole number of days, 0 to ${TERMS_DAYS_MOST}; ${DEFAULT_TERMS_DAYS} when not given`, 'dueInDays');
    }
    dueDate = addDays(issueDate, terms as number);
  }
  if (dueDate < issueDate) throw violation('an invoice is not due before it is issued', 'dueDate');

  let taxRateBps = 0;
  if (raw.taxRatePercent !== undefined && raw.taxRatePercent !== null) {
    const percent = raw.taxRatePercent;
    const bps = typeof percent === 'number' ? Math.round(percent * 100) : NaN;
    if (!Number.isFinite(bps) || bps < 0 || bps > 10_000 || Math.abs((percent as number) * 100 - bps) > 1e-6) {
      throw violation('taxRatePercent is 0 to 100, with at most two decimals', 'taxRatePercent');
    }
    taxRateBps = bps;
  }

  const rawLines = raw.lines;
  if (!Array.isArray(rawLines) || rawLines.length < 1) throw violation('an invoice has at least one line: what was sold, how many, and at what price', 'lines');
  if (rawLines.length > LINES_MOST) throw violation(`an invoice has at most ${LINES_MOST} lines`, 'lines');
  let subtotal = 0n;
  const lines = rawLines.map((one) => {
    const line = (one ?? {}) as Record<string, unknown>;
    const description = typeof line.description === 'string' ? line.description.trim() : '';
    if (!description || description.length > 500) throw violation('a line\'s description says what was sold, in 1 to 500 characters', 'lines');
    const quantity = line.quantity;
    const milli = typeof quantity === 'number' ? Math.round(quantity * 1000) : NaN;
    if (!Number.isFinite(milli) || milli <= 0 || milli > 1_000_000_000_000 || Math.abs((quantity as number) * 1000 - milli) > 1e-6) {
      throw violation('a line\'s quantity is a number above zero, with at most three decimals', 'lines');
    }
    const unit = line.unitCents;
    if (!Number.isSafeInteger(unit) || (unit as number) < 0) throw violation('a line\'s unitCents is a whole number of cents, zero or more', 'lines');
    const amountCents = roundedDiv(BigInt(milli) * BigInt(unit as number), 1000n);
    if (amountCents > SANE) throw violation('an amount that large is not an invoice: too large', 'lines');
    subtotal += amountCents;
    return { description, quantityMilli: BigInt(milli), unitCents: unit as number, amountCents };
  });
  if (subtotal === 0n) throw violation('nothing to invoice: the lines come to zero', 'lines');
  const tax = roundedDiv(subtotal * BigInt(taxRateBps), 10_000n);
  const total = subtotal + tax;
  if (total > SANE) throw violation('an amount that large is not an invoice: too large', 'lines');

  let contactId: string | null = null;
  let customerName = '';
  let customerEmail: string | null = null;
  if (raw.contactId !== undefined && raw.contactId !== null && raw.contactId !== '') {
    if (typeof raw.contactId !== 'string' || !ID.test(raw.contactId)) throw violation('contactId is the id of a contact', 'contactId');
    const { rows } = await tx.query<{ id: string; name: string; email: string | null }>(
      'SELECT id, name, email FROM contacts WHERE id = $1 AND company_id = $2', [raw.contactId, companyId]);
    if (!rows[0]) throw violation(`no such contact in these books: ${raw.contactId}`, 'contactId');
    contactId = rows[0].id;
    customerName = rows[0].name;
    customerEmail = rows[0].email;
  } else {
    customerName = typeof raw.customerName === 'string' ? raw.customerName.trim() : '';
    if (!customerName || customerName.length > 200) {
      throw violation('an invoice needs a customer: customerName, 1 to 200 characters, or a contactId from the contacts', 'customerName');
    }
    if (raw.customerEmail !== undefined && raw.customerEmail !== null && raw.customerEmail !== '') {
      if (typeof raw.customerEmail !== 'string' || raw.customerEmail.length > 254 || !ADDRESS.test(raw.customerEmail)) {
        throw violation('customerEmail is an address, such as name@example.com', 'customerEmail');
      }
      customerEmail = raw.customerEmail;
    }
  }

  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
  if (note !== null && note.length > 2000) throw violation('an invoice\'s note is at most 2000 characters', 'note');
  return { contactId, customerName, customerEmail, currency: raw.currency, issueDate, dueDate, taxRateBps, lines, subtotal, tax, total, note };
}

/** The books' own accounts an invoice moves, found by what the platform knows them as. */
async function systemAccounts(tx: TenantClient, companyId: string): Promise<{ all: Account[]; byKey: (key: string) => Account }> {
  const all = await accountsOf(tx, companyId);
  const byKey = (key: string): Account => {
    const found = all.find((account) => account.systemKey === key && !account.archivedAt);
    if (!found) throw violation(`the books have no ${key} account to post to; add one before invoicing`, 'account');
    return found;
  };
  return { all, byKey };
}

/* ----------------------------------------------------------------- reads --- */

const ROWS = `
  SELECT i.id, i.number, i.contact_id, i.customer_name, i.customer_email,
         to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
         i.currency, i.subtotal_cents, i.tax_rate_bps, i.tax_cents, i.total_cents, i.note, i.entry_id,
         i.written_by, i.outside, i.created_at,
         coalesce((SELECT sum(p.amount_cents) FROM invoice_payments p
                    WHERE p.invoice_id = i.id AND p.company_id = i.company_id
                      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.company_id = p.company_id AND r.reverses = p.entry_id)), 0) AS paid_cents,
         EXISTS (SELECT 1 FROM journal_entries r WHERE r.company_id = i.company_id AND r.reverses = i.entry_id) AS is_void
    FROM invoices i`;

interface Row {
  id: string; number: string; contact_id: string | null; customer_name: string; customer_email: string | null;
  issue_date: string; due_date: string; currency: string; subtotal_cents: string; tax_rate_bps: number; tax_cents: string;
  total_cents: string; note: string | null; entry_id: string; written_by: 'owner' | 'agent'; outside: boolean; created_at: Date;
  paid_cents: string; is_void: boolean;
}

function invoiceOf(row: Row): Invoice {
  const total = Number(row.total_cents);
  const paid = Number(row.paid_cents);
  const outstanding = row.is_void ? 0 : Math.max(0, total - paid);
  const status: InvoiceStatus = row.is_void ? 'void' : outstanding === 0 ? 'paid' : paid > 0 ? 'partial' : 'open';
  return {
    id: row.id, number: row.number, contactId: row.contact_id, customerName: row.customer_name, customerEmail: row.customer_email,
    issueDate: row.issue_date, dueDate: row.due_date, currency: row.currency, subtotalCents: Number(row.subtotal_cents),
    taxRateBps: row.tax_rate_bps, taxCents: Number(row.tax_cents), totalCents: total, paidCents: row.is_void ? 0 : paid,
    outstandingCents: outstanding, status, overdue: outstanding > 0 && row.due_date < today(), note: row.note, entryId: row.entry_id,
    writtenBy: row.written_by, outside: row.outside, createdAt: row.created_at,
  };
}

/** An invoice by its id or its number, or null. */
async function find(tx: TenantClient, companyId: string, reference: string): Promise<Invoice | null> {
  const by = NUMBER.test(reference) ? 'i.number' : ID.test(reference) ? 'i.id' : null;
  if (by === null) return null;
  const { rows } = await tx.query<Row>(`${ROWS} WHERE i.company_id = $1 AND ${by} = $2`, [companyId, reference]);
  return rows[0] ? invoiceOf(rows[0]) : null;
}

async function mustFind(tx: TenantClient, companyId: string, reference: string): Promise<Invoice> {
  const invoice = await find(tx, companyId, reference);
  if (!invoice) throw violation(`no invoice ${reference} in these books`, 'invoice');
  return invoice;
}

export async function invoiceWith(tx: TenantClient, companyId: string, reference: string): Promise<InvoiceDetail | null> {
  const invoice = await find(tx, companyId, reference);
  if (!invoice) return null;
  const { rows: lines } = await tx.query<{ description: string; quantity_milli: string; unit_cents: string; amount_cents: string }>(
    'SELECT description, quantity_milli, unit_cents, amount_cents FROM invoice_lines WHERE invoice_id = $1 ORDER BY position', [invoice.id]);
  const { rows: payments } = await tx.query<{ id: string; paid_on: string; amount_cents: string; entry_id: string; written_by: 'owner' | 'agent'; reversed: boolean }>(
    `SELECT p.id, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_cents, p.entry_id, p.written_by,
            EXISTS (SELECT 1 FROM journal_entries r WHERE r.company_id = p.company_id AND r.reverses = p.entry_id) AS reversed
       FROM invoice_payments p WHERE p.invoice_id = $1 ORDER BY p.paid_on, p.created_at`, [invoice.id]);
  return {
    ...invoice,
    lines: lines.map((line) => ({
      description: line.description, quantity: Number(line.quantity_milli) / 1000, unitCents: Number(line.unit_cents), amountCents: Number(line.amount_cents),
    })),
    payments: payments.map((one) => ({
      id: one.id, paidOn: one.paid_on, amountCents: Number(one.amount_cents), entryId: one.entry_id, reversed: one.reversed, writtenBy: one.written_by,
    })),
  };
}

export type InvoiceFilter = 'open' | 'overdue' | 'paid' | 'void';
export const INVOICE_FILTERS: readonly InvoiceFilter[] = ['open', 'overdue', 'paid', 'void'];

/** What is owed, per currency, and how much of it is late. */
export interface Outstanding { currency: string; outstandingCents: number; overdueCents: number }

/** The latest invoices first, and what is owed on all of them: not only the ones listed. */
export async function listInvoices(tx: TenantClient, companyId: string, options: {
  status?: InvoiceFilter; contactId?: string; limit?: number;
}): Promise<{ invoices: Invoice[]; outstanding: Outstanding[]; truncated: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const { rows } = await tx.query<Row>(
    `${ROWS} WHERE i.company_id = $1 AND ($2::uuid IS NULL OR i.contact_id = $2) ORDER BY i.created_at DESC, i.number DESC LIMIT 5000`,
    [companyId, options.contactId ?? null]);
  const all = rows.map(invoiceOf);
  const owed = new Map<string, Outstanding>();
  for (const invoice of all) {
    if (invoice.outstandingCents === 0) continue;
    const sum = owed.get(invoice.currency) ?? { currency: invoice.currency, outstandingCents: 0, overdueCents: 0 };
    sum.outstandingCents += invoice.outstandingCents;
    if (invoice.overdue) sum.overdueCents += invoice.outstandingCents;
    owed.set(invoice.currency, sum);
  }
  const wanted = all.filter((invoice) => {
    switch (options.status) {
      case undefined: return true;
      case 'open': return invoice.status === 'open' || invoice.status === 'partial';
      case 'overdue': return invoice.overdue;
      case 'paid': return invoice.status === 'paid';
      case 'void': return invoice.status === 'void';
    }
  });
  return {
    invoices: wanted.slice(0, limit),
    outstanding: [...owed.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    truncated: wanted.length > limit,
  };
}

/* ---------------------------------------------------------------- writes --- */

/** Issues an invoice: numbered, with the entry that puts what is owed in the books. */
export async function issueInvoice(tx: TenantClient, companyId: string, raw: Record<string, unknown>, by: 'owner' | 'agent', options: {
  taskId?: string | null; outside?: boolean;
} = {}): Promise<{ invoiceId: string; number: string; totalCents: number; entryId: string; dueDate: string }> {
  const invoice = await parseInvoice(tx, companyId, raw);
  const accounts = await systemAccounts(tx, companyId);
  const receivable = accounts.byKey('receivable');
  const sales = accounts.byKey('revenue');
  const taxOwed = invoice.tax > 0n ? accounts.byKey('tax') : null;

  // Taken here, after everything that can refuse has refused: a refused
  // invoice uses no number, and the counter's row serialises two issued at once.
  const { rows: [counter] } = await tx.query<{ last_number: number }>(
    `INSERT INTO invoice_numbers (company_id, last_number) VALUES ($1, 1)
     ON CONFLICT (company_id) DO UPDATE SET last_number = invoice_numbers.last_number + 1 RETURNING last_number`, [companyId]);
  const number = `INV-${String(counter!.last_number).padStart(4, '0')}`;

  const entry: EntryInput = {
    date: invoice.issueDate, memo: `${number} — ${invoice.customerName}`, currency: invoice.currency,
    lines: [
      { account: receivable.code, debitCents: Number(invoice.total) },
      { account: sales.code, creditCents: Number(invoice.subtotal) },
      ...(taxOwed ? [{ account: taxOwed.code, creditCents: Number(invoice.tax) }] : []),
    ],
  };
  const entryId = await postEntry(tx, companyId, entry, by, { taskId: options.taskId ?? null, outside: options.outside ?? false });
  const { rows: [made] } = await tx.query<{ id: string }>(
    `INSERT INTO invoices (company_id, number, contact_id, customer_name, customer_email, issue_date, due_date, currency,
                           subtotal_cents, tax_rate_bps, tax_cents, total_cents, note, entry_id, written_by, task_id, outside)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
    [companyId, number, invoice.contactId, invoice.customerName, invoice.customerEmail, invoice.issueDate, invoice.dueDate, invoice.currency,
      Number(invoice.subtotal), invoice.taxRateBps, Number(invoice.tax), Number(invoice.total), invoice.note, entryId, by,
      options.taskId ?? null, options.outside ?? false]);
  const invoiceId = made!.id;
  for (const [index, line] of invoice.lines.entries()) {
    await tx.query(
      `INSERT INTO invoice_lines (company_id, invoice_id, position, description, quantity_milli, unit_cents, amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, invoiceId, index + 1, line.description, line.quantityMilli.toString(), line.unitCents, Number(line.amountCents)]);
  }
  await appendEvent(tx, {
    companyId, ...(options.taskId ? { taskId: options.taskId } : {}), type: 'invoice.issued', actor: by === 'owner' ? 'owner' : 'agent_run',
    payload: { invoiceId, number, currency: invoice.currency, totalCents: Number(invoice.total), by },
  });
  return { invoiceId, number, totalCents: Number(invoice.total), entryId, dueDate: invoice.dueDate };
}

async function recordPayment(tx: TenantClient, companyId: string, invoice: Invoice, amountCents: number, paidOn: string, entryId: string, by: 'owner' | 'agent', options: {
  taskId?: string | null; outside?: boolean;
}): Promise<{ paymentId: string; outstandingCents: number }> {
  const { rows: [made] } = await tx.query<{ id: string }>(
    `INSERT INTO invoice_payments (company_id, invoice_id, paid_on, amount_cents, entry_id, written_by, task_id, outside)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [companyId, invoice.id, paidOn, amountCents, entryId, by, options.taskId ?? null, options.outside ?? false]);
  await appendEvent(tx, {
    companyId, ...(options.taskId ? { taskId: options.taskId } : {}), type: 'invoice.paid', actor: by === 'owner' ? 'owner' : 'agent_run',
    payload: { invoiceId: invoice.id, number: invoice.number, amountCents, by },
  });
  return { paymentId: made!.id, outstandingCents: invoice.outstandingCents - amountCents };
}

function mustBePayable(invoice: Invoice, amountCents: number): void {
  if (invoice.status === 'void') throw violation(`${invoice.number} is void; a void invoice is not paid`, 'invoice');
  if (amountCents > invoice.outstandingCents) {
    throw violation(`that is more than is owed: ${invoice.outstandingCents} is outstanding on ${invoice.number}`, 'amountCents');
  }
}

/** Takes a payment: money in on an account of the owner's, and the receivable it settles. */
export async function payInvoice(tx: TenantClient, companyId: string, reference: string, input: Record<string, unknown>, by: 'owner' | 'agent', options: {
  taskId?: string | null; outside?: boolean;
} = {}): Promise<{ paymentId: string; entryId: string; outstandingCents: number }> {
  const invoice = await mustFind(tx, companyId, reference);
  const amount = input.amountCents;
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) throw violation('amountCents is a whole number of cents above zero', 'amountCents');
  const paidOn = input.date === undefined ? today() : input.date;
  if (!isDay(paidOn)) throw violation('the payment\'s date is a day, YYYY-MM-DD', 'date');
  mustBePayable(invoice, amount as number);

  const accounts = await systemAccounts(tx, companyId);
  const receivable = accounts.byKey('receivable');
  let deposit = accounts.byKey('cash');
  if (input.depositTo !== undefined && input.depositTo !== null && input.depositTo !== '') {
    const named = accounts.all.find((account) => account.code === input.depositTo && !account.archivedAt);
    if (!named) throw violation(`no account ${String(input.depositTo)} to take the money in`, 'depositTo');
    if (named.kind !== 'asset' || named.id === receivable.id) throw violation(`${named.code} ${named.name} is not an asset account that holds money; the money goes into one`, 'depositTo');
    deposit = named;
  }
  const entryId = await postEntry(tx, companyId, {
    date: paidOn, memo: `Payment on ${invoice.number} — ${invoice.customerName}`, currency: invoice.currency,
    lines: [{ account: deposit.code, debitCents: amount as number }, { account: receivable.code, creditCents: amount as number }],
  }, by, { taskId: options.taskId ?? null, outside: options.outside ?? false });
  const paid = await recordPayment(tx, companyId, invoice, amount as number, paidOn, entryId, by, options);
  return { ...paid, entryId };
}

/**
 * An entry the bookkeeper wrote that says it pays an invoice (`ledger.record`'s
 * `invoice`): held to being one -- money debited to assets, the receivable
 * credited, no more than is owed, in the invoice's currency -- and then
 * written as the invoice's payment, so the two cannot disagree.
 */
export async function payInvoiceByEntry(tx: TenantClient, companyId: string, reference: string, entry: EntryInput, by: 'owner' | 'agent', options: {
  taskId?: string | null; outside?: boolean;
} = {}): Promise<{ entryId: string; paymentId: string; outstandingCents: number }> {
  const invoice = await mustFind(tx, companyId, reference);
  if (invoice.currency !== entry.currency) {
    throw violation(`invoice ${invoice.number} is in ${invoice.currency}; this entry is in ${entry.currency}`, 'currency');
  }
  const accounts = await systemAccounts(tx, companyId);
  const receivable = accounts.byKey('receivable');
  const kinds = new Map(accounts.all.map((account) => [account.code, account]));
  const credits = entry.lines.filter((line) => (line.creditCents ?? 0) > 0);
  if (credits.length === 0 || credits.some((line) => line.account !== receivable.code)) {
    throw violation(`a payment credits accounts receivable (${receivable.code}) and nothing else; the money in is debited`, 'lines');
  }
  const debits = entry.lines.filter((line) => (line.debitCents ?? 0) > 0);
  if (debits.some((line) => kinds.get(line.account)?.kind !== 'asset')) {
    throw violation('a payment debits an asset account: the cash or bank account the money came into', 'lines');
  }
  const amount = credits.reduce((sum, line) => sum + (line.creditCents ?? 0), 0);
  mustBePayable(invoice, amount);
  const entryId = await postEntry(tx, companyId, entry, by, { taskId: options.taskId ?? null, outside: options.outside ?? false });
  const paid = await recordPayment(tx, companyId, invoice, amount, entry.date, entryId, by, options);
  return { ...paid, entryId };
}

/** Voids an invoice: the entry that issued it, reversed. Only while nothing stands paid on it. */
export async function voidInvoice(tx: TenantClient, companyId: string, reference: string, by: 'owner' | 'agent', taskId: string | null = null): Promise<{ entryId: string }> {
  const invoice = await mustFind(tx, companyId, reference);
  if (invoice.status === 'void') throw violation(`${invoice.number} is already void`, 'invoice');
  if (invoice.paidCents > 0) throw violation(`${invoice.number} was paid on; reverse the payment first, in the books`, 'invoice');
  const entryId = await reverseEntry(tx, companyId, invoice.entryId, by, taskId);
  await appendEvent(tx, {
    companyId, ...(taskId ? { taskId } : {}), type: 'invoice.voided', actor: by === 'owner' ? 'owner' : 'agent_run',
    payload: { invoiceId: invoice.id, number: invoice.number, by },
  });
  return { entryId };
}

/** An invoice as a run reads it: written by work that read outside content, its words are data. */
export function invoiceForRun<T extends { outside: boolean; customerName: string; note: string | null; lines?: Array<{ description: string }> }>(invoice: T): T {
  if (!invoice.outside) return invoice;
  return {
    ...invoice,
    customerName: wrapUntrusted('invoice customer', invoice.customerName),
    note: invoice.note === null ? null : wrapUntrusted('invoice note', invoice.note),
    ...(invoice.lines ? { lines: invoice.lines.map((line) => ({ ...line, description: wrapUntrusted('invoice line', line.description) })) } : {}),
  };
}
