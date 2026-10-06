/**
 * The books, kept by the platform (0119, STATUS 2.139): `ledger.read` and
 * `ledger.record` on `src/records/books.ts`, and with them the invoices
 * (0122, STATUS 2.154): `invoice.issue`, `ledger.read`'s invoices report, and a
 * payment recorded against an invoice through `ledger.record`'s `invoice`.
 *
 * Bound as a fallback: an accounting service the owner connects takes the
 * names over (`fallback` in src/broker/registry.ts), and the books kept
 * here stay.
 *
 * Reading is tier 0 -- checking the books before paying moves no money,
 * which is why the catalogue made it free. What it returns is the company's
 * own, except a memo written by work that had read content from outside,
 * which comes back as data and marks the work that reads it (F8.9).
 * Recording is tier 1: internal, read back, and undone by a reversing entry.
 * Issuing an invoice is tier 2, as the catalogue says: the customer has seen
 * the number, which is slow to undo.
 */
import type { Capability } from '../broker/registry.ts';
import { withTenant } from '../db/tenant.ts';
import { outsideContentIn } from '../engine/tasks.ts';
import { PalugadaError } from '../errors.ts';
import { balancesOf, entriesOf, entryInput, isDay, memoForRun, postEntry, profitOf } from '../records/books.ts';
import {
  INVOICE_FILTERS, invoiceForRun, invoiceWith, issueInvoice, listInvoices, payInvoiceByEntry,
  type Invoice, type InvoiceDetail, type InvoiceFilter, type Outstanding,
} from '../records/invoices.ts';

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const ENTRIES_MAX = 200;

export interface LedgerReadResult {
  report: 'balances' | 'entries' | 'profit' | 'invoices';
  invoices?: Array<Invoice | InvoiceDetail>;
  outstanding?: Outstanding[];
  accounts?: Array<{ code: string; name: string; kind: string; balances: Array<{ currency: string; cents: number }> }>;
  entries?: Array<{
    id: string; date: string; memo: string; currency: string; writtenBy: string; outside?: true;
    reverses: string | null; reversedBy: string | null;
    lines: Array<{ account: string; name: string; debitCents: number; creditCents: number }>;
  }>;
  profit?: Array<{ currency: string; incomeCents: number; expenseCents: number; profitCents: number }>;
  from?: string;
  to?: string;
  truncated?: boolean;
}

export function ledgerRead(): Capability<{
  report: 'balances' | 'entries' | 'profit' | 'invoices'; from?: string; to?: string; account?: string; limit?: number; status?: InvoiceFilter; invoice?: string;
}, LedgerReadResult> {
  return {
    name: 'ledger.read',
    inputSchema: {
      type: 'object',
      required: ['report'],
      properties: {
        report: {
          type: 'string', enum: ['balances', 'entries', 'profit', 'invoices'],
          description: 'balances: every account, as of `to`; entries: the latest entries, within days and on an account when given; profit: income less expenses between two days; invoices: the latest invoices with what is owed on each and in all, one in full when `invoice` names it.',
        },
        status: { type: 'string', enum: [...INVOICE_FILTERS], description: 'For invoices: only those open (owed, in part or whole), overdue, paid or void.' },
        invoice: { type: 'string', pattern: '^INV-\\d{4,9}$', description: 'For invoices: one invoice by its number, with its lines and payments.' },
        from: { ...DAY, description: 'The first day, YYYY-MM-DD.' },
        to: { ...DAY, description: 'The last day, YYYY-MM-DD; today when not given.' },
        account: { type: 'string', pattern: '^[0-9]{1,8}$', description: 'Entries on this account, by its code.' },
        limit: { type: 'integer', minimum: 1, maximum: ENTRIES_MAX, description: 'The latest this many entries; 50 unless said.' },
      },
      additionalProperties: false,
    },
    adapter: 'platform:books',
    defaultTier: 0,
    fallback: true,
    // A memo written by work that read outside content.
    readsOutside: (output) => ((output as LedgerReadResult).entries ?? []).some((entry) => entry.outside === true)
      || ((output as LedgerReadResult).invoices ?? []).some((invoice) => invoice.outside === true),
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      for (const [field, value] of [['from', input.from], ['to', input.to]] as const) {
        if (value !== undefined && !isDay(value)) {
          throw new PalugadaError('contract.violation', `${field} is a day, YYYY-MM-DD`, { field });
        }
      }
      return withTenant(ctx.companyId, async (tx) => {
        if (input.report === 'invoices') {
          if (input.invoice) {
            const found = await invoiceWith(tx, ctx.companyId, input.invoice);
            if (!found) throw new PalugadaError('contract.violation', `no invoice ${input.invoice} in these books`, { field: 'invoice' });
            return { report: 'invoices' as const, invoices: [invoiceForRun(found)] };
          }
          const found = await listInvoices(tx, ctx.companyId, { ...(input.status ? { status: input.status } : {}), limit: input.limit ?? 50 });
          return {
            report: 'invoices' as const, invoices: found.invoices.map((invoice) => invoiceForRun(invoice)),
            outstanding: found.outstanding, truncated: found.truncated,
          };
        }
        if (input.report === 'balances') {
          const accounts = await balancesOf(tx, ctx.companyId, input.to);
          return {
            report: 'balances' as const,
            accounts: accounts.filter((account) => !account.archivedAt || account.balances.some((one) => one.cents !== 0))
              .map((account) => ({ code: account.code, name: account.name, kind: account.kind, balances: account.balances })),
            ...(input.to ? { to: input.to } : {}),
          };
        }
        if (input.report === 'profit') {
          const to = input.to ?? new Date().toISOString().slice(0, 10);
          const from = input.from ?? `${to.slice(0, 7)}-01`;
          return { report: 'profit' as const, from, to, profit: await profitOf(tx, ctx.companyId, from, to) };
        }
        const found = await entriesOf(tx, ctx.companyId, {
          ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}),
          ...(input.account ? { account: input.account } : {}), limit: input.limit ?? 50,
        });
        return {
          report: 'entries' as const,
          entries: found.entries.map((entry) => ({
            id: entry.id, date: entry.date, memo: memoForRun(entry), currency: entry.currency, writtenBy: entry.writtenBy,
            ...(entry.outside ? { outside: true as const } : {}), reverses: entry.reverses, reversedBy: entry.reversedBy, lines: entry.lines,
          })),
          truncated: found.truncated,
        };
      });
    },
  };
}

export function ledgerRecord(): Capability<Record<string, unknown>, { entryId: string }> {
  return {
    name: 'ledger.record',
    inputSchema: {
      type: 'object',
      required: ['date', 'memo', 'currency', 'lines'],
      properties: {
        date: { ...DAY, description: 'The day it happened.' },
        memo: { type: 'string', minLength: 1, maxLength: 500, description: 'What it was: "Rent for October", "Coffee beans, 10 kg".' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        invoice: {
          type: 'string', pattern: '^INV-\\d{4,9}$',
          description: 'The number of the invoice this entry is a payment of: money debited to cash or a bank account, accounts receivable credited, no more than is owed. The invoice then shows it paid, in part or in full.',
        },
        lines: {
          type: 'array', minItems: 2, maxItems: 40,
          description: 'The accounts it moves, by code from ledger.read: each line a debit or a credit, and the debits equal to the credits.',
          items: {
            type: 'object',
            required: ['account'],
            properties: {
              account: { type: 'string', pattern: '^[0-9]{1,8}$' },
              debitCents: { type: 'integer', minimum: 1 },
              creditCents: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    adapter: 'platform:books',
    defaultTier: 1,
    fallback: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const entry = entryInput(input);
      return withTenant(ctx.companyId, async (tx) => {
        const written = {
          taskId: ctx.taskId,
          // A memo a stranger's words may have shaped is read back as data.
          outside: (await outsideContentIn(tx, ctx.taskId)) !== null,
        };
        // An entry that says it pays an invoice is held to being one, and is
        // written as the invoice's payment, so the two cannot disagree.
        if (typeof input.invoice === 'string') {
          return { entryId: (await payInvoiceByEntry(tx, ctx.companyId, input.invoice, entry, 'agent', written)).entryId };
        }
        return { entryId: await postEntry(tx, ctx.companyId, entry, 'agent', written) };
      });
    },
    async verify(_input, result, ctx) {
      return withTenant(ctx.companyId, async (tx) => (await tx.query(
        'SELECT 1 FROM journal_entries WHERE id = $1', [result.entryId])).rows.length === 1);
    },
  };
}

/**
 * Issues an invoice from the books (0122). Tier 2, as the catalogue gives it:
 * the customer has seen the number, which is slow to undo, so the owner is
 * asked unless they have said yes to this once and for all. What the run writes
 * for the customer and the lines is read back as data when it had read content
 * from outside (F8.9).
 */
export function invoiceIssue(): Capability<Record<string, unknown>, { invoiceId: string; number: string; totalCents: number; entryId: string; dueDate: string }> {
  return {
    name: 'invoice.issue',
    inputSchema: {
      type: 'object',
      required: ['currency', 'lines'],
      properties: {
        customerName: { type: 'string', minLength: 1, maxLength: 200, description: 'Who is invoiced; or give contactId.' },
        customerEmail: { type: 'string', maxLength: 254 },
        contactId: { type: 'string', description: 'A contact of the company, from crm.read, to invoice instead of naming one.' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        issueDate: { ...DAY, description: 'Today when not given.' },
        dueDate: { ...DAY, description: 'Or dueInDays; fourteen days after the issue when neither is given.' },
        dueInDays: { type: 'integer', minimum: 0, maximum: 365 },
        taxRatePercent: { type: 'number', minimum: 0, maximum: 100, description: 'Added to the subtotal, rounded half up; none when not given.' },
        note: { type: 'string', maxLength: 2000 },
        lines: {
          type: 'array', minItems: 1, maxItems: 40,
          items: {
            type: 'object',
            required: ['description', 'quantity', 'unitCents'],
            properties: {
              description: { type: 'string', minLength: 1, maxLength: 500 },
              quantity: { type: 'number', exclusiveMinimum: 0, description: 'Up to three decimals.' },
              unitCents: { type: 'integer', minimum: 0, description: 'Price of one, in whole cents.' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    adapter: 'platform:books',
    defaultTier: 2,
    fallback: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      return withTenant(ctx.companyId, async (tx) => issueInvoice(tx, ctx.companyId, input, 'agent', {
        taskId: ctx.taskId,
        outside: (await outsideContentIn(tx, ctx.taskId)) !== null,
      }));
    },
    async verify(_input, result, ctx) {
      return withTenant(ctx.companyId, async (tx) => (await invoiceWith(tx, ctx.companyId, result.invoiceId))?.number === result.number);
    },
  };
}

export function bookCapabilities(): Array<Capability<never, never>> {
  return [ledgerRead(), ledgerRecord(), invoiceIssue()] as unknown as Array<Capability<never, never>>;
}
