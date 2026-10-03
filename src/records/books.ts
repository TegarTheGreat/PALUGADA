/**
 * The company's own books, by double entry (0119, STATUS 2.139).
 *
 * `ledger.read` was catalogued and bound to nothing, so the bookkeeper was
 * told to keep the ledger balancing against what was issued and paid, and
 * there was no ledger. These are the books the platform keeps until the
 * owner connects an accounting service (`src/capabilities/books.ts` binds
 * the names as a fallback):
 *
 *   - **a chart of accounts**, opened the first time the books are looked
 *     at: cash, what customers owe, what the company owes, taxes owed,
 *     equity, sales and expenses, each with a code accountants would
 *     recognise, and any the owner adds;
 *   - **entries** of two lines or more whose debits equal their credits, in
 *     one currency -- refused here with what is wrong, and refused by the
 *     database at commit whatever wrote them;
 *   - **never rewritten**: a mistake is undone by a reversing entry, and the
 *     two stay side by side.
 *
 * A balance is read on its natural side: an asset or an expense grows with
 * its debits, a liability, equity or income with its credits.
 */
import { appendEvent } from '../audit/event-log.ts';
import { wrapUntrusted } from '../context/builder.ts';
import type { TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

export const ACCOUNT_KINDS = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type SystemAccount = 'cash' | 'receivable' | 'payable' | 'tax' | 'equity' | 'revenue' | 'expense';

/** The chart a company's books open with. The names are the platform's; the console says them in the owner's language. */
const CHART: ReadonlyArray<{ code: string; name: string; kind: AccountKind; systemKey: SystemAccount }> = [
  { code: '1100', name: 'Cash and bank', kind: 'asset', systemKey: 'cash' },
  { code: '1200', name: 'Accounts receivable', kind: 'asset', systemKey: 'receivable' },
  { code: '2100', name: 'Accounts payable', kind: 'liability', systemKey: 'payable' },
  { code: '2200', name: 'Taxes owed', kind: 'liability', systemKey: 'tax' },
  { code: '3100', name: 'Owner\'s equity', kind: 'equity', systemKey: 'equity' },
  { code: '4100', name: 'Sales', kind: 'income', systemKey: 'revenue' },
  { code: '5100', name: 'Expenses', kind: 'expense', systemKey: 'expense' },
];

/** The most lines an entry has: a month's payroll fits, a ledger dumped in one entry does not. */
const LINES_MAX = 40;
const MEMO_MAX = 500;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Account {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  systemKey: SystemAccount | null;
  archivedAt: Date | null;
}

export interface EntryLineInput { account: string; debitCents?: number; creditCents?: number }
export interface EntryInput { date: string; memo: string; currency: string; lines: EntryLineInput[] }

function violation(message: string, field: string): PalugadaError {
  return new PalugadaError('contract.violation', message, { field });
}

/** A day as YYYY-MM-DD that the calendar has: not 30 February. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** An entry held to its shape before the database is asked, with what is accepted when it is not. */
export function entryInput(input: Record<string, unknown>): EntryInput {
  if (!isDay(input.date)) throw violation('an entry\'s date is a day, YYYY-MM-DD', 'date');
  const memo = typeof input.memo === 'string' ? input.memo.trim() : '';
  if (!memo || memo.length > MEMO_MAX) throw violation(`an entry's memo says what it is, in at most ${MEMO_MAX} characters`, 'memo');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) {
    throw violation('an entry\'s currency is three letters, such as IDR', 'currency');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > LINES_MAX) {
    throw violation(`an entry has two lines at least, and at most ${LINES_MAX}: what was debited and what was credited`, 'lines');
  }
  let debits = 0;
  let credits = 0;
  const lines = (input.lines as unknown[]).map((raw) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const account = typeof line.account === 'string' ? line.account.trim() : '';
    const debit = line.debitCents ?? 0;
    const credit = line.creditCents ?? 0;
    const whole = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    if (!account || !whole(debit) || !whole(credit) || ((debit as number) > 0) === ((credit as number) > 0)) {
      throw violation('each line is a debit or a credit, of whole cents above zero, on an account named by its code', 'lines');
    }
    debits += debit as number;
    credits += credit as number;
    return { account, ...(debit ? { debitCents: debit as number } : { creditCents: credit as number }) };
  });
  if (debits !== credits) throw violation(`an entry balances: its debits are ${debits} and its credits ${credits}`, 'lines');
  return { date: input.date, memo, currency: input.currency, lines };
}

/** Opens the books the first time they are looked at: the chart, once. */
export async function openBooks(tx: TenantClient, companyId: string): Promise<void> {
  const { rows } = await tx.query('SELECT 1 FROM ledger_accounts WHERE company_id = $1 LIMIT 1', [companyId]);
  if (rows.length > 0) return;
  for (const account of CHART) {
    await tx.query(
      `INSERT INTO ledger_accounts (company_id, code, name, kind, system_key) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`, [companyId, account.code, account.name, account.kind, account.systemKey]);
  }
}

export async function accountsOf(tx: TenantClient, companyId: string): Promise<Account[]> {
  await openBooks(tx, companyId);
  const { rows } = await tx.query<{ id: string; code: string; name: string; kind: AccountKind; system_key: SystemAccount | null; archived_at: Date | null }>(
    'SELECT id, code, name, kind, system_key, archived_at FROM ledger_accounts WHERE company_id = $1 ORDER BY code', [companyId]);
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, kind: row.kind, systemKey: row.system_key, archivedAt: row.archived_at }));
}

/** An account the owner adds: a code no other account has, a name, and what kind it is. */
export async function addAccount(tx: TenantClient, companyId: string, input: Record<string, unknown>): Promise<string> {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!/^[0-9]{1,8}$/.test(code)) throw violation('an account\'s code is up to eight digits, such as 5200', 'code');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw violation('an account\'s name is 1 to 120 characters', 'name');
  if (!(ACCOUNT_KINDS as readonly unknown[]).includes(input.kind)) {
    throw violation(`an account is an ${ACCOUNT_KINDS.join(', ')} account; got ${JSON.stringify(input.kind)}`, 'kind');
  }
  const accounts = await accountsOf(tx, companyId);
  const taken = accounts.find((account) => account.code === code);
  if (taken) throw violation(`account code ${code} is ${taken.name}'s; choose another`, 'code');
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO ledger_accounts (company_id, code, name, kind) VALUES ($1, $2, $3, $4) RETURNING id', [companyId, code, name, input.kind]);
  await appendEvent(tx, { companyId, type: 'books.account_added', actor: 'owner', payload: { accountId: rows[0]!.id, code, kind: input.kind } });
  return rows[0]!.id;
}

/** Posts an entry: two lines or more that balance, on accounts the books have. */
export async function postEntry(tx: TenantClient, companyId: string, entry: EntryInput, by: 'owner' | 'agent', options: {
  taskId?: string | null; outside?: boolean; reverses?: string;
} = {}): Promise<string> {
  const accounts = await accountsOf(tx, companyId);
  const open = new Map(accounts.filter((account) => !account.archivedAt).map((account) => [account.code, account]));
  for (const line of entry.lines) {
    if (!open.has(line.account)) {
      throw violation(`no account ${line.account}; the accounts are ${[...open.values()].map((account) => `${account.code} ${account.name}`).join(', ')}`, 'lines');
    }
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (company_id, entry_date, memo, currency, written_by, task_id, outside, reverses)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [companyId, entry.date, entry.memo, entry.currency, by, options.taskId ?? null, options.outside ?? false, options.reverses ?? null]);
  const entryId = rows[0]!.id;
  for (const line of entry.lines) {
    await tx.query(
      'INSERT INTO journal_lines (company_id, entry_id, account_id, debit_cents, credit_cents) VALUES ($1, $2, $3, $4, $5)',
      [companyId, entryId, open.get(line.account)!.id, line.debitCents ?? 0, line.creditCents ?? 0]);
  }
  const total = entry.lines.reduce((sum, line) => sum + (line.debitCents ?? 0), 0);
  await appendEvent(tx, {
    companyId, ...(options.taskId ? { taskId: options.taskId } : {}),
    type: options.reverses ? 'books.entry_reversed' : 'books.entry_posted', actor: by === 'owner' ? 'owner' : 'agent_run',
    payload: { entryId, by, currency: entry.currency, totalCents: total, ...(options.reverses ? { reverses: options.reverses } : {}) },
  });
  return entryId;
}

/** Undoes an entry with another, its lines the other way round. Once; and a reversal is not itself reversed. */
export async function reverseEntry(tx: TenantClient, companyId: string, entryId: string, by: 'owner' | 'agent', taskId: string | null = null): Promise<string> {
  const { rows: [entry] } = ID.test(entryId)
    ? await tx.query<{ id: string; entry_date: string; memo: string; currency: string; reverses: string | null; reversed_by: string | null }>(
      `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.memo, e.currency, e.reverses,
              (SELECT r.id FROM journal_entries r WHERE r.reverses = e.id) AS reversed_by
         FROM journal_entries e WHERE e.id = $1 AND e.company_id = $2`, [entryId, companyId])
    : { rows: [] };
  if (!entry) throw violation(`no entry ${entryId} in these books`, 'entry');
  if (entry.reverses) throw violation('a reversal is not reversed: post the entry again instead', 'entry');
  if (entry.reversed_by) throw violation(`entry ${entryId} was reversed already, by ${entry.reversed_by}`, 'entry');
  const { rows: lines } = await tx.query<{ code: string; debit_cents: string; credit_cents: string }>(
    `SELECT a.code, l.debit_cents, l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.debit_cents DESC`, [entryId]);
  const today = new Date().toISOString().slice(0, 10);
  return postEntry(tx, companyId, {
    date: today, memo: entry.memo, currency: entry.currency,
    lines: lines.map((line) => Number(line.debit_cents) > 0
      ? { account: line.code, creditCents: Number(line.debit_cents) }
      : { account: line.code, debitCents: Number(line.credit_cents) }),
  }, by, { taskId, reverses: entryId });
}

export interface AccountBalance extends Account {
  /** Per currency, on the account's natural side. */
  balances: Array<{ currency: string; cents: number }>;
}

const DEBIT_SIDE: ReadonlySet<AccountKind> = new Set(['asset', 'expense']);

/** Every account and what it holds, as of a day (today when none). */
export async function balancesOf(tx: TenantClient, companyId: string, asOf?: string): Promise<AccountBalance[]> {
  const accounts = await accountsOf(tx, companyId);
  const { rows } = await tx.query<{ account_id: string; currency: string; debits: string; credits: string }>(
    `SELECT l.account_id, e.currency, sum(l.debit_cents) AS debits, sum(l.credit_cents) AS credits
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND ($2::date IS NULL OR e.entry_date <= $2::date)
      GROUP BY l.account_id, e.currency ORDER BY e.currency`, [companyId, asOf ?? null]);
  return accounts.map((account) => ({
    ...account,
    balances: rows.filter((row) => row.account_id === account.id).map((row) => {
      const net = Number(row.debits) - Number(row.credits);
      return { currency: row.currency, cents: DEBIT_SIDE.has(account.kind) ? net : -net };
    }),
  }));
}

export interface Entry {
  id: string;
  date: string;
  memo: string;
  currency: string;
  writtenBy: 'owner' | 'agent';
  taskId: string | null;
  outside: boolean;
  reverses: string | null;
  reversedBy: string | null;
  createdAt: Date;
  lines: Array<{ account: string; name: string; debitCents: number; creditCents: number }>;
}

/** The latest entries first, within days and on an account when asked. */
export async function entriesOf(tx: TenantClient, companyId: string, options: {
  from?: string; to?: string; account?: string; limit: number;
}): Promise<{ entries: Entry[]; truncated: boolean }> {
  const { rows } = await tx.query<{
    id: string; entry_date: string; memo: string; currency: string; written_by: 'owner' | 'agent'; task_id: string | null;
    outside: boolean; reverses: string | null; reversed_by: string | null; created_at: Date;
  }>(
    `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.memo, e.currency, e.written_by, e.task_id, e.outside,
            e.reverses, (SELECT r.id FROM journal_entries r WHERE r.reverses = e.id) AS reversed_by, e.created_at
       FROM journal_entries e
      WHERE e.company_id = $1 AND ($2::date IS NULL OR e.entry_date >= $2::date) AND ($3::date IS NULL OR e.entry_date <= $3::date)
        AND ($4::text IS NULL OR EXISTS (
          SELECT 1 FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = $4))
      ORDER BY e.entry_date DESC, e.created_at DESC LIMIT $5`,
    [companyId, options.from ?? null, options.to ?? null, options.account ?? null, options.limit + 1]);
  const kept = rows.slice(0, options.limit);
  const entries: Entry[] = [];
  for (const row of kept) {
    const { rows: lines } = await tx.query<{ code: string; name: string; debit_cents: string; credit_cents: string }>(
      `SELECT a.code, a.name, l.debit_cents, l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
        WHERE l.entry_id = $1 ORDER BY l.debit_cents DESC, a.code`, [row.id]);
    entries.push({
      id: row.id, date: row.entry_date, memo: row.memo, currency: row.currency, writtenBy: row.written_by, taskId: row.task_id,
      outside: row.outside, reverses: row.reverses, reversedBy: row.reversed_by, createdAt: row.created_at,
      lines: lines.map((line) => ({ account: line.code, name: line.name, debitCents: Number(line.debit_cents), creditCents: Number(line.credit_cents) })),
    });
  }
  return { entries, truncated: rows.length > options.limit };
}

/** What came in and went out between two days, per currency: income less expenses. */
export async function profitOf(tx: TenantClient, companyId: string, from: string, to: string): Promise<Array<{
  currency: string; incomeCents: number; expenseCents: number; profitCents: number;
}>> {
  await openBooks(tx, companyId);
  const { rows } = await tx.query<{ currency: string; income: string; expense: string }>(
    `SELECT e.currency,
            sum(CASE WHEN a.kind = 'income' THEN l.credit_cents - l.debit_cents ELSE 0 END) AS income,
            sum(CASE WHEN a.kind = 'expense' THEN l.debit_cents - l.credit_cents ELSE 0 END) AS expense
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.entry_date BETWEEN $2::date AND $3::date AND a.kind IN ('income', 'expense')
      GROUP BY e.currency ORDER BY e.currency`, [companyId, from, to]);
  return rows.map((row) => ({
    currency: row.currency, incomeCents: Number(row.income), expenseCents: Number(row.expense),
    profitCents: Number(row.income) - Number(row.expense),
  }));
}

/** An entry's memo as a run reads it: written by work that read outside content, it is data. */
export function memoForRun(entry: Entry): string {
  return entry.outside ? wrapUntrusted('ledger memo', entry.memo) : entry.memo;
}
