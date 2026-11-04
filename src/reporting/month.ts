/**
 * The month's money, as a cadence that asks for it is handed it (company-os's
 * monthly money review, F18.12; the budget review F9.4 names).
 *
 * The company kept books (0119), invoices (0122) and a monthly ceiling on
 * what its agents spend, and nothing ever looked at a month of them: STATUS
 * graded F9's rhythm built while its monthly budget review did not exist.
 * The scheduler now puts this into the task's input when it fires a schedule
 * whose input names `facts: 'month'`, as it does the week for the weekly
 * review (reporting/week.ts).
 *
 * The month is the last whole calendar month where the company is: a review
 * that fires on the first at ten to eight in Jakarta reviews the month that
 * ended eight hours before, and the owner's "Run now" in the middle of a
 * month reviews the last one that is over, because half a month's profit is
 * not a number anyone decides on.
 *
 * Built from rows, never from a model, for the reason the week is: a review
 * that reported a figure a model had summarised would be reporting the model.
 * What it holds:
 *
 *   - per currency, the month's sales, cost of goods, overhead and profit,
 *     and the month before's, from `profitOf`; cash at the start and end of
 *     the month, what customers and suppliers are owed, and the stock, from
 *     `balancesOf`; and the days each of those three is worth;
 *   - every invoice owed and late today, the longest late first, bounded;
 *   - what the company's agents spent in the month against the monthly
 *     ceiling, and in the month before;
 *   - each measure's value at the month's end against its start;
 *   - the seven levers of the power of one (after Verne Harnish): what
 *     one per cent on price, volume, cost of goods and overhead adds to the
 *     month's profit, and what one day fewer of receivables or stock, or one
 *     more of payables, frees in cash, each computed on the month's own
 *     books, and each marked unavailable when the books keep no account it
 *     needs rather than given a number made up from the others.
 */
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { limitFor, spendBetween } from '../governance/spend-guard.ts';
import { balancesOf, profitOf, type AccountBalance } from '../records/books.ts';
import { dayIn, daysBetween, zoneOf } from '../records/collections.ts';
import { invoiceForRun, overdueInvoices } from '../records/invoices.ts';
import type { MetricUnit } from '../domain/metrics.ts';

/** The most of each the brief carries; past it, it says how many it left out. */
const OVERDUE_MAX = 20;
const MEASURES_MAX = 40;
const CUSTOMER_MAX = 80;

/*
 * Which accounts are cash, stock and cost of goods.
 *
 * The chart the books open with (records/books.ts) names cash, receivables,
 * payables, sales and one account of expenses, and has no account for stock
 * or for the cost of the goods sold: a service company has neither. A key
 * for them would need a migration, and an owner who keeps them adds the
 * accounts; so they are read the way an accountant reads a chart, by its
 * numbering. The chart itself numbers cash and bank 1100, and a second bank
 * account the owner opens beside it is 11-something.
 */
const CASH = (account: AccountBalance) => account.kind === 'asset' && account.code.startsWith('11');
const STOCK = (account: AccountBalance) => account.kind === 'asset' && account.code.startsWith('13');
const COST_OF_GOODS = (account: AccountBalance) => account.kind === 'expense' && account.code.startsWith('50');

const LEVERS = ['price', 'volume', 'cost_of_goods', 'overhead', 'receivable_days', 'stock_days', 'payable_days'] as const;
export type LeverName = (typeof LEVERS)[number];

export interface Lever {
  lever: LeverName;
  /** What is moved, and by how much: one per cent, or one day. */
  move: '+1%' | '-1%' | '-1 day' | '+1 day';
  /** A price, volume or cost lever adds to the month's profit; a days lever frees cash once. */
  effect: 'profit' | 'cash';
  /** In the currency's cents; null when unavailable. */
  cents: number | null;
  unavailable: 'no_cost_of_goods_account' | 'no_stock_account' | null;
}

export interface MonthBooks {
  currency: string;
  incomeCents: number;
  /** Null when the books keep no account for it (an expense account coded 50..). */
  costOfGoodsCents: number | null;
  /** Every expense that is not cost of goods. */
  overheadCents: number;
  profitCents: number;
  previous: { incomeCents: number; expenseCents: number; profitCents: number };
  cash: { startCents: number; endCents: number; changeCents: number };
  receivableCents: number;
  payableCents: number;
  /** Null when the books keep no stock account (an asset account coded 13..). */
  stockCents: number | null;
  /** What is owed and late today, of the receivable. */
  overdueCents: number;
  /** Days of the month's sales still owed; null with no sales. */
  receivableDays: number | null;
  /** Days of the month's cost of goods held as stock, and owed to suppliers; null without cost of goods. */
  stockDays: number | null;
  payableDays: number | null;
  levers: Lever[];
}

export interface MonthMeasure {
  goal: string;
  slug: string;
  name: string;
  unit: MetricUnit;
  direction: 'up' | 'down';
  target: number;
  /** The latest value by the month's end, and by its start, and how far it moved. */
  last: number | null;
  verified: boolean | null;
  monthAgo: number | null;
  change: number | null;
}

export interface OverdueInvoice {
  number: string;
  customer: string;
  dueDate: string;
  daysOverdue: number;
  currency: string;
  outstandingCents: number;
  /** Written by work that had read outside content (F8.9): its customer's name is data. */
  outside?: true;
}

export interface MonthFacts {
  /** The month reviewed, YYYY-MM, its first and last day, and how many days it had. */
  month: string;
  from: string;
  to: string;
  days: number;
  /** One per currency the books used, in the month or holding a balance at its end. */
  books: MonthBooks[];
  overdue: { asOf: string; invoices: OverdueInvoice[]; leftOut: number };
  /** What the company's agents spent, in the platform's own currency, against the monthly ceiling. */
  spend: { monthCents: number; previousMonthCents: number; limitCents: number };
  measures: MonthMeasure[];
  measuresLeftOut: number;
}

/** A day of the calendar moved by whole days. */
function plusDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The last whole month before the day it is where the company is. */
function monthBefore(today: string): { month: string; from: string; to: string; days: number } {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
  return { month: first.slice(0, 7), from: first, to: last, days: daysBetween(first, last) + 1 };
}

/**
 * Whether the month a schedule's money review would read had any money in
 * it (F18.12, N10): an entry dated in it, or an invoice owed and late today,
 * which is money to chase however quiet the month was -- the weekly review
 * keeps reading a measure not reached for the same reason. Read from the
 * tables, and not through the books' own functions, because those open a
 * company's books the first time they are looked at, and a company that has
 * never kept any is the quietest month of all.
 */
export async function monthHadMoney(companyId: string, now = new Date()): Promise<{ month: string; had: boolean }> {
  return withTenant(companyId, async (tx) => {
    const today = dayIn(await zoneOf(tx, companyId), now);
    const month = monthBefore(today);
    const { rows } = await tx.query<{ had: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM journal_entries WHERE entry_date BETWEEN $1::date AND $2::date)
           OR EXISTS (
                SELECT 1 FROM invoices i
                 WHERE i.due_date < $3::date
                   AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.company_id = i.company_id AND r.reverses = i.entry_id)
                   AND i.total_cents > coalesce((
                         SELECT sum(p.amount_cents) FROM invoice_payments p
                          WHERE p.company_id = i.company_id AND p.invoice_id = i.id
                            AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.company_id = p.company_id AND r.reverses = p.entry_id)), 0)
              ) AS had`,
      [month.from, month.to, today],
    );
    return { month: month.month, had: rows[0]!.had };
  });
}

/** What an account set holds in a currency. */
function held(balances: AccountBalance[], which: (account: AccountBalance) => boolean, currency: string): number {
  return balances.filter(which).reduce(
    (sum, account) => sum + (account.balances.find((one) => one.currency === currency)?.cents ?? 0), 0);
}

/** Days of a month's flow a balance is worth, to a tenth; null with no flow to divide by. */
function daysOf(balance: number, flow: number, days: number): number | null {
  return flow > 0 ? Math.round((balance / flow) * days * 10) / 10 : null;
}

function leversOf(input: {
  incomeCents: number; costOfGoodsCents: number | null; overheadCents: number; days: number; stockKept: boolean;
}): Lever[] {
  const { incomeCents, costOfGoodsCents, overheadCents, days, stockKept } = input;
  const percent = (cents: number) => Math.round(cents / 100);
  const daily = (cents: number) => Math.round(cents / days);
  const noCost = costOfGoodsCents === null;
  const lever = (
    name: LeverName, move: Lever['move'], effect: Lever['effect'],
    cents: () => number, unavailable: Lever['unavailable'] = null,
  ): Lever => ({ lever: name, move, effect, cents: unavailable ? null : cents(), unavailable });
  const cost = costOfGoodsCents ?? 0;
  return [
    lever('price', '+1%', 'profit', () => percent(incomeCents)),
    // One per cent more sold is one per cent more of what it earns after
    // what the goods cost: without that cost, the margin is unknown.
    lever('volume', '+1%', 'profit', () => percent(incomeCents - cost), noCost ? 'no_cost_of_goods_account' : null),
    lever('cost_of_goods', '-1%', 'profit', () => percent(cost), noCost ? 'no_cost_of_goods_account' : null),
    lever('overhead', '-1%', 'profit', () => percent(overheadCents)),
    lever('receivable_days', '-1 day', 'cash', () => daily(incomeCents)),
    lever('stock_days', '-1 day', 'cash', () => daily(cost),
      !stockKept ? 'no_stock_account' : noCost ? 'no_cost_of_goods_account' : null),
    // Suppliers are paid for goods; days of payables are counted on their cost.
    lever('payable_days', '+1 day', 'cash', () => daily(cost), noCost ? 'no_cost_of_goods_account' : null),
  ];
}

async function measuresOf(tx: TenantClient, from: string, to: string): Promise<{ measures: MonthMeasure[]; leftOut: number }> {
  // Days end where the company is, but a measure's observations are instants;
  // the day after the month's last, at midnight UTC, is within hours of it.
  const { rows } = await tx.query<{
    goal: string; slug: string; name: string; unit: MetricUnit; direction: 'up' | 'down'; target: string;
    last: string | null; verified: boolean | null; month_ago: string | null; total: number;
  }>(
    `SELECT g.slug AS goal, m.slug, m.name, m.unit, m.direction, m.target,
            last.value AS last, last.verified, before.value AS month_ago, count(*) OVER ()::int AS total
       FROM goal_metrics m
       JOIN goals g ON g.company_id = m.company_id AND g.id = m.goal_id AND g.status = 'active'
       LEFT JOIN LATERAL (
              SELECT value, verified FROM metric_observations o
               WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.observed_at < ($2::date + 1)
               ORDER BY observed_at DESC LIMIT 1) last ON true
       LEFT JOIN LATERAL (
              SELECT value FROM metric_observations o
               WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.observed_at < $1::date
               ORDER BY observed_at DESC LIMIT 1) before ON true
      WHERE m.retired_at IS NULL
      ORDER BY m.created_at
      LIMIT $3`,
    [from, to, MEASURES_MAX],
  );
  const measures = rows.map((row) => {
    const last = row.last === null ? null : Number(row.last);
    const monthAgo = row.month_ago === null ? null : Number(row.month_ago);
    return {
      goal: row.goal, slug: row.slug, name: row.name, unit: row.unit, direction: row.direction, target: Number(row.target),
      last, verified: row.verified, monthAgo, change: last !== null && monthAgo !== null ? last - monthAgo : null,
    };
  });
  return { measures, leftOut: Math.max(0, (rows[0]?.total ?? 0) - rows.length) };
}

export async function buildMonthFacts(companyId: string, now = new Date()): Promise<MonthFacts> {
  // The ceiling is read in its own transaction, as the owner's pages read it.
  const limit = await limitFor(companyId);
  return withTenant(companyId, async (tx) => {
    const today = dayIn(await zoneOf(tx, companyId), now);
    const { month, from, to, days } = monthBefore(today);
    const previous = monthBefore(from);

    const profit = await profitOf(tx, companyId, from, to);
    const before = await profitOf(tx, companyId, previous.from, previous.to);
    const atEnd = await balancesOf(tx, companyId, to);
    const atStart = await balancesOf(tx, companyId, plusDays(from, -1));
    const late = await overdueInvoices(tx, companyId, today);

    const stockKept = atEnd.some(STOCK);
    const costKept = atEnd.some(COST_OF_GOODS);
    const currencies = new Set<string>(profit.map((one) => one.currency));
    for (const account of atEnd) {
      for (const one of account.balances) if (one.cents !== 0) currencies.add(one.currency);
    }

    const books: MonthBooks[] = [...currencies].sort().map((currency) => {
      const sums = profit.find((one) => one.currency === currency);
      const incomeCents = sums?.incomeCents ?? 0;
      const expenseCents = sums?.expenseCents ?? 0;
      // A flow is what the account moved in the month: its balance at the end
      // less its balance the day before the month began.
      const costOfGoodsCents = costKept ? held(atEnd, COST_OF_GOODS, currency) - held(atStart, COST_OF_GOODS, currency) : null;
      const overheadCents = expenseCents - (costOfGoodsCents ?? 0);
      const cashStart = held(atStart, CASH, currency);
      const cashEnd = held(atEnd, CASH, currency);
      const receivableCents = held(atEnd, (account) => account.systemKey === 'receivable', currency);
      const payableCents = held(atEnd, (account) => account.systemKey === 'payable', currency);
      const stockCents = stockKept ? held(atEnd, STOCK, currency) : null;
      const prior = before.find((one) => one.currency === currency);
      return {
        currency,
        incomeCents,
        costOfGoodsCents,
        overheadCents,
        profitCents: sums?.profitCents ?? 0,
        previous: {
          incomeCents: prior?.incomeCents ?? 0, expenseCents: prior?.expenseCents ?? 0, profitCents: prior?.profitCents ?? 0,
        },
        cash: { startCents: cashStart, endCents: cashEnd, changeCents: cashEnd - cashStart },
        receivableCents,
        payableCents,
        stockCents,
        overdueCents: late.filter((one) => one.currency === currency).reduce((sum, one) => sum + one.outstandingCents, 0),
        receivableDays: daysOf(receivableCents, incomeCents, days),
        stockDays: stockCents === null || costOfGoodsCents === null ? null : daysOf(stockCents, costOfGoodsCents, days),
        payableDays: costOfGoodsCents === null ? null : daysOf(payableCents, costOfGoodsCents, days),
        levers: leversOf({ incomeCents, costOfGoodsCents, overheadCents, days, stockKept }),
      };
    });

    const invoices: OverdueInvoice[] = late.slice(0, OVERDUE_MAX).map((invoice) => {
      const said = invoiceForRun({ ...invoice, customerName: invoice.customerName.slice(0, CUSTOMER_MAX) });
      return {
        number: invoice.number,
        customer: said.customerName,
        dueDate: invoice.dueDate,
        daysOverdue: daysBetween(invoice.dueDate, today),
        currency: invoice.currency,
        outstandingCents: invoice.outstandingCents,
        ...(invoice.outside ? { outside: true as const } : {}),
      };
    });

    // The ceiling counts calendar months in UTC (governance/spend-guard.ts);
    // the spend is read over the same month, so the two compare.
    const utcMonth = (first: string) => {
      const start = new Date(`${first}T00:00:00Z`);
      return [start, new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))] as const;
    };
    const [spendFrom, spendTo] = utcMonth(from);
    const [priorFrom, priorTo] = utcMonth(previous.from);
    const { measures, leftOut } = await measuresOf(tx, from, to);

    return {
      month, from, to, days,
      books,
      overdue: { asOf: today, invoices, leftOut: Math.max(0, late.length - invoices.length) },
      spend: {
        monthCents: await spendBetween(tx, spendFrom, spendTo),
        previousMonthCents: await spendBetween(tx, priorFrom, priorTo),
        limitCents: limit.moneyMaxCents,
      },
      measures,
      measuresLeftOut: leftOut,
    };
  });
}

/** The invoices a month's facts name that were written after reading outside content. */
export function outsideInvoicesOf(facts: MonthFacts): string[] {
  return facts.overdue.invoices.filter((one) => one.outside).map((one) => one.number);
}
