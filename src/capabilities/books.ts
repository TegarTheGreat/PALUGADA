/**
 * The books, kept by the platform (0119, STATUS 2.139): `ledger.read` and
 * `ledger.record` on `src/records/books.ts`.
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
 */
import type { Capability } from '../broker/registry.ts';
import { withTenant } from '../db/tenant.ts';
import { outsideContentIn } from '../engine/tasks.ts';
import { PalugadaError } from '../errors.ts';
import { balancesOf, entriesOf, entryInput, isDay, memoForRun, postEntry, profitOf } from '../records/books.ts';

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const ENTRIES_MAX = 200;

export interface LedgerReadResult {
  report: 'balances' | 'entries' | 'profit';
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

export function ledgerRead(): Capability<{ report: 'balances' | 'entries' | 'profit'; from?: string; to?: string; account?: string; limit?: number }, LedgerReadResult> {
  return {
    name: 'ledger.read',
    inputSchema: {
      type: 'object',
      required: ['report'],
      properties: {
        report: {
          type: 'string', enum: ['balances', 'entries', 'profit'],
          description: 'balances: every account, as of `to`; entries: the latest entries, within days and on an account when given; profit: income less expenses between two days.',
        },
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
    readsOutside: (output) => ((output as LedgerReadResult).entries ?? []).some((entry) => entry.outside === true),
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      for (const [field, value] of [['from', input.from], ['to', input.to]] as const) {
        if (value !== undefined && !isDay(value)) {
          throw new PalugadaError('contract.violation', `${field} is a day, YYYY-MM-DD`, { field });
        }
      }
      return withTenant(ctx.companyId, async (tx) => {
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
      return withTenant(ctx.companyId, async (tx) => ({
        entryId: await postEntry(tx, ctx.companyId, entry, 'agent', {
          taskId: ctx.taskId,
          // A memo a stranger's words may have shaped is read back as data.
          outside: (await outsideContentIn(tx, ctx.taskId)) !== null,
        }),
      }));
    },
    async verify(_input, result, ctx) {
      return withTenant(ctx.companyId, async (tx) => (await tx.query(
        'SELECT 1 FROM journal_entries WHERE id = $1', [result.entryId])).rows.length === 1);
    },
  };
}

export function bookCapabilities(): Array<Capability<never, never>> {
  return [ledgerRead(), ledgerRecord()] as unknown as Array<Capability<never, never>>;
}
