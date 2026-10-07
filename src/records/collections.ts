/**
 * Collecting what customers owe, from the books (the owner's request of 7
 * October: white-collar work handled, and automatically).
 *
 * An invoice that is past its due date is the plainest job an office has that
 * asks for no judgement: the books know who owes what and since when, and the
 * letter is the same letter. It was left to a person, because nothing woke at
 * the due date and nothing could write to a customer without a card for the
 * owner. This module is the part that needs neither:
 *
 *   - **when** -- `whatIsNext`, a pure function of the due date, today and what
 *     was already sent: three days past due, then ten, then twenty-four, never
 *     two within a week, and a person -- not a form letter -- for an invoice
 *     that is long overdue and was never reminded, or that stays unpaid after the
 *     last letter;
 *   - **what is said** -- `reminderLetter`, written from the books alone. The
 *     customer's name and the figures are the invoice's, the words are ours, in
 *     Indonesian or English (as the invoice's own page is), and what a model or
 *     a stranger typed never reaches the letter except as a name, cut to a line.
 *     That is why a reminder needs no owner's yes when work that read outside
 *     content sends it: there is nothing in the letter that content could write.
 *
 * What is kept -- the policy, each letter sent, an invoice the owner asked to
 * leave alone -- is below, and the capability that sends is
 * `src/capabilities/collections.ts`.
 */
import type { TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { invoiceFormats } from './invoice-document.ts';

/** Days past the due date at which each reminder goes, unless the company set its own. */
export const DEFAULT_STEPS: readonly number[] = [3, 10, 24];
/** The least time between two letters about one invoice. */
export const MIN_GAP_DAYS = 7;
/** An invoice this far past due that was never reminded is not sent a form letter by a platform just switched on. */
export const STALE_AFTER_DAYS = 60;
/** How long the last letter has to work before a person is told it did not. */
export const ESCALATE_AFTER_DAYS = 7;

const DAY = 86_400_000;

/** Whole days from one day of the calendar to another (`YYYY-MM-DD`), by the calendar and not by any clock. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

export type Next =
  | { action: 'wait'; why: 'not_overdue' | 'not_yet' | 'too_soon' | 'after_last'; daysOverdue: number }
  | { action: 'remind'; step: number; of: number; daysOverdue: number }
  | { action: 'escalate'; why: 'stale' | 'unpaid_after_last'; daysOverdue: number; sent: number };

/**
 * What to do about one unpaid invoice today.
 *
 * `sent` is the letters already written, in order: the next is always the
 * step after the last one sent, so a step is never skipped and never repeated.
 */
export function whatIsNext(input: {
  dueDate: string; today: string; steps: readonly number[]; sent: ReadonlyArray<{ step: number; day: string }>;
}): Next {
  const daysOverdue = daysBetween(input.dueDate, input.today);
  if (daysOverdue <= 0) return { action: 'wait', why: 'not_overdue', daysOverdue };
  const done = input.sent.length;
  if (done === 0 && daysOverdue > STALE_AFTER_DAYS) return { action: 'escalate', why: 'stale', daysOverdue, sent: 0 };

  const last = input.sent[done - 1];
  const sinceLast = last ? daysBetween(last.day, input.today) : Number.POSITIVE_INFINITY;
  if (done >= input.steps.length) {
    return sinceLast >= ESCALATE_AFTER_DAYS
      ? { action: 'escalate', why: 'unpaid_after_last', daysOverdue, sent: done }
      : { action: 'wait', why: 'after_last', daysOverdue };
  }
  if (daysOverdue < input.steps[done]!) return { action: 'wait', why: 'not_yet', daysOverdue };
  if (sinceLast < MIN_GAP_DAYS) return { action: 'wait', why: 'too_soon', daysOverdue };
  return { action: 'remind', step: done + 1, of: input.steps.length, daysOverdue };
}

/* -------------------------------------------------------------- letters --- */

/** Characters that end a line early, reorder text, or hide it: none belongs in a name in a letter. */
const UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
const NAME_MAX = 100;
/** The most the owner's words on how to pay come to. */
export const PAYMENT_NOTE_MAX = 500;

/** A name or a company as it may stand in a letter: one line, printable, cut. */
function oneLine(value: string, most = NAME_MAX): string {
  const flat = value.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(UNPRINTABLE, '').replace(/ {2,}/g, ' ').trim();
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat;
}

/** The owner's words on how to pay: lines kept, anything that could end a header or hide text dropped. */
export function paymentNoteOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(UNPRINTABLE, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean === '' ? null : clean.slice(0, PAYMENT_NOTE_MAX);
}

interface Words {
  greeting: (name: string) => string;
  subject: { first: (number: string, due: string) => string; middle: (n: number, number: string) => string; last: (number: string) => string };
  first: (number: string, amount: string, due: string) => string;
  middle: (number: string, amount: string, due: string) => string;
  last: (number: string, amount: string, due: string) => string;
  paidAlready: string;
  howToPay: string;
  thanks: string;
}

const WORDS: Record<'en' | 'id', Words> = {
  en: {
    greeting: (name) => `Dear ${name},`,
    subject: {
      first: (number, due) => `Reminder: invoice ${number} was due on ${due}`,
      middle: (n, number) => `Reminder ${n}: invoice ${number} is overdue`,
      last: (number) => `Final reminder: invoice ${number} is overdue`,
    },
    first: (number, amount, due) => `This is a friendly reminder that invoice ${number} for ${amount}, due on ${due}, has not been paid yet.`,
    middle: (number, amount, due) => `We have not yet received payment for invoice ${number} for ${amount}, which was due on ${due}. Please arrange the payment this week, or reply to tell us when we can expect it.`,
    last: (number, amount, due) => `Invoice ${number} for ${amount}, due on ${due}, is still unpaid despite our earlier reminders. Please pay it now, or reply to tell us when we can expect payment so that we can settle it.`,
    paidAlready: 'If you have already paid, please ignore this message and reply with the proof of payment so we can update our records.',
    howToPay: 'How to pay:',
    thanks: 'Thank you,',
  },
  id: {
    greeting: (name) => `Yth. ${name},`,
    subject: {
      first: (number, due) => `Pengingat: invoice ${number} jatuh tempo pada ${due}`,
      middle: (n, number) => `Pengingat ${n}: invoice ${number} melewati jatuh tempo`,
      last: (number) => `Pengingat terakhir: invoice ${number} melewati jatuh tempo`,
    },
    first: (number, amount, due) => `Kami ingin mengingatkan bahwa invoice ${number} sebesar ${amount} yang jatuh tempo pada ${due} belum kami terima pembayarannya.`,
    middle: (number, amount, due) => `Kami belum menerima pembayaran invoice ${number} sebesar ${amount} yang jatuh tempo pada ${due}. Mohon segera atur pembayarannya minggu ini, atau balas email ini untuk memberi tahu kapan kami dapat menerimanya.`,
    last: (number, amount, due) => `Invoice ${number} sebesar ${amount} yang jatuh tempo pada ${due} masih belum dibayar meskipun sudah kami ingatkan sebelumnya. Mohon segera dibayar, atau balas email ini untuk memberi tahu kapan pembayaran dapat kami terima agar urusan ini dapat diselesaikan.`,
    paidAlready: 'Jika Anda sudah membayar, abaikan pesan ini dan balas email ini dengan bukti pembayaran agar catatan kami diperbarui.',
    howToPay: 'Cara pembayaran:',
    thanks: 'Terima kasih,',
  },
};

export interface LetterFacts {
  /** The company's work language; a language the letters are not written in is English, as the invoice is. */
  language: string;
  /** Which letter this is, of how many. */
  step: number;
  of: number;
  number: string;
  customerName: string;
  outstandingCents: number;
  currency: string;
  dueDate: string;
  company: string;
  paymentNote: string | null;
}

/**
 * The reminder, written from the books: the same facts always make the same
 * letter, and nothing in it is a model's.
 *
 * The first is friendly, the last says it is the last, those between count
 * themselves. A company with one step sends one friendly letter.
 */
export function reminderLetter(facts: LetterFacts): { subject: string; text: string } {
  const { language, money, day } = invoiceFormats(facts.language, facts.currency);
  const words = WORDS[language];
  const amount = money(facts.outstandingCents);
  const due = day(facts.dueDate);
  const kind = facts.step <= 1 || facts.of <= 1 ? 'first' : facts.step >= facts.of ? 'last' : 'middle';
  const subject = kind === 'first' ? words.subject.first(facts.number, due)
    : kind === 'last' ? words.subject.last(facts.number) : words.subject.middle(facts.step, facts.number);
  const body = kind === 'first' ? words.first(facts.number, amount, due)
    : kind === 'last' ? words.last(facts.number, amount, due) : words.middle(facts.number, amount, due);
  const pay = paymentNoteOf(facts.paymentNote);
  const text = [
    words.greeting(oneLine(facts.customerName) || (language === 'id' ? 'Pelanggan' : 'customer')),
    body,
    words.paidAlready,
    ...(pay ? [`${words.howToPay}\n${pay}`] : []),
    `${words.thanks}\n${oneLine(facts.company)}`,
  ].join('\n\n');
  return { subject, text };
}

/* ------------------------------------------------------------- what is kept --- */


export interface CollectionsPolicy {
  enabled: boolean;
  stepsDays: number[];
  paymentNote: string | null;
}

/** The company's policy; the platform's own when it never set one. */
export async function policyOf(tx: TenantClient, companyId: string): Promise<CollectionsPolicy> {
  const { rows } = await tx.query<{ enabled: boolean; steps_days: number[]; payment_note: string | null }>(
    'SELECT enabled, steps_days, payment_note FROM collections_policy WHERE company_id = $1', [companyId]);
  const row = rows[0];
  return row
    ? { enabled: row.enabled, stepsDays: row.steps_days, paymentNote: row.payment_note }
    : { enabled: true, stepsDays: [...DEFAULT_STEPS], paymentNote: null };
}

function wrong(message: string, field: string): PalugadaError {
  return new PalugadaError('contract.violation', message, { field });
}

/** Changes what the owner named and leaves the rest as it was. */
export async function setPolicy(
  tx: TenantClient,
  companyId: string,
  change: { enabled?: boolean; stepsDays?: unknown; paymentNote?: string | null },
): Promise<CollectionsPolicy> {
  const now = await policyOf(tx, companyId);
  let stepsDays = now.stepsDays;
  if (change.stepsDays !== undefined) {
    const list = change.stepsDays;
    const valid = Array.isArray(list) && list.length >= 1 && list.length <= 5
      && list.every((one, at) => Number.isInteger(one) && one >= 1 && one <= 180 && (at === 0 || one > (list[at - 1] as number)));
    if (!valid) throw wrong('stepsDays is one to five days past the due date, each later than the one before and at most 180, such as [3, 10, 24]', 'stepsDays');
    stepsDays = list as number[];
  }
  let paymentNote = now.paymentNote;
  if (change.paymentNote !== undefined) {
    if (change.paymentNote !== null && typeof change.paymentNote !== 'string') throw wrong('paymentNote is the owner\'s words on how to pay, or null', 'paymentNote');
    if (typeof change.paymentNote === 'string' && change.paymentNote.length > PAYMENT_NOTE_MAX * 2) {
      throw wrong(`paymentNote is at most ${PAYMENT_NOTE_MAX} characters`, 'paymentNote');
    }
    paymentNote = paymentNoteOf(change.paymentNote);
  }
  const enabled = change.enabled ?? now.enabled;
  await tx.query(
    `INSERT INTO collections_policy (company_id, enabled, steps_days, payment_note, updated_at)
     VALUES ($1, $2, $3::smallint[], $4, now())
     ON CONFLICT (company_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, steps_days = EXCLUDED.steps_days, payment_note = EXCLUDED.payment_note, updated_at = now()`,
    [companyId, enabled, stepsDays, paymentNote]);
  return { enabled, stepsDays, paymentNote };
}

export interface Reminder {
  step: number;
  sentOn: string;
  sentAt: Date;
  to: string;
  outstandingCents: number;
  daysOverdue: number;
}

/** The letters sent about an invoice, in order. */
export async function remindersOf(tx: TenantClient, companyId: string, invoiceId: string): Promise<Reminder[]> {
  const { rows } = await tx.query<{ step: number; sent_on: string; sent_at: Date; to_address: string; outstanding_cents: string; days_overdue: number }>(
    `SELECT step, to_char(sent_on, 'YYYY-MM-DD') AS sent_on, sent_at, to_address, outstanding_cents, days_overdue
       FROM invoice_reminders WHERE company_id = $1 AND invoice_id = $2 ORDER BY step`, [companyId, invoiceId]);
  return rows.map((row) => ({
    step: row.step, sentOn: row.sent_on, sentAt: row.sent_at, to: row.to_address,
    outstandingCents: Number(row.outstanding_cents), daysOverdue: row.days_overdue,
  }));
}

/**
 * Writes that a letter went. The unique key on (invoice, step) is the last
 * word on a step written twice: the caller holds a lock on the invoice
 * (`lockInvoice`) from reading what was sent to here, so it is never reached.
 */
export async function recordReminder(tx: TenantClient, companyId: string, input: {
  invoiceId: string; step: number; day: string; to: string; messageId: string; outstandingCents: number; daysOverdue: number; taskId: string | null;
}): Promise<void> {
  await tx.query(
    `INSERT INTO invoice_reminders (company_id, invoice_id, step, sent_on, to_address, message_id, outstanding_cents, days_overdue, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [companyId, input.invoiceId, input.step, input.day, input.to, input.messageId, input.outstandingCents, input.daysOverdue, input.taskId]);
}

/**
 * Holds off every other writer of this invoice's reminders until the
 * transaction ends: two callers at once read the same list of letters sent and
 * would both write the next one, so the second waits for the first to commit
 * and then reads a list that has it.
 */
export async function lockInvoice(tx: TenantClient, invoiceId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`remind:${invoiceId}`]);
}

export async function isHeld(tx: TenantClient, companyId: string, invoiceId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM invoice_collections WHERE company_id = $1 AND invoice_id = $2 AND held_at IS NOT NULL', [companyId, invoiceId]);
  return rows.length > 0;
}

/** The owner asks that an invoice be left alone, or that it be reminded again. */
export async function holdInvoice(tx: TenantClient, companyId: string, invoiceId: string, held: boolean): Promise<void> {
  const { rows } = await tx.query('SELECT 1 FROM invoices WHERE company_id = $1 AND id = $2', [companyId, invoiceId]);
  if (rows.length === 0) throw wrong(`no such invoice in these books: ${invoiceId}`, 'invoice');
  await tx.query(
    `INSERT INTO invoice_collections (company_id, invoice_id, held_at) VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (company_id, invoice_id) DO UPDATE SET held_at = CASE WHEN $3 THEN coalesce(invoice_collections.held_at, now()) ELSE NULL END`,
    [companyId, invoiceId, held]);
}

/** Records that a person was told this invoice is still unpaid; true the first time only. */
export async function noteEscalated(tx: TenantClient, companyId: string, invoiceId: string): Promise<boolean> {
  await tx.query('INSERT INTO invoice_collections (company_id, invoice_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [companyId, invoiceId]);
  const { rowCount } = await tx.query(
    'UPDATE invoice_collections SET escalated_at = now() WHERE company_id = $1 AND invoice_id = $2 AND escalated_at IS NULL', [companyId, invoiceId]);
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------ what is shown --- */

export interface InvoiceReminding {
  /** How many letters have gone. */
  sent: number;
  /** The day of the last, or null. */
  lastOn: string | null;
  /** The owner asked that the invoice be left alone. */
  held: boolean;
  /** A person was told the letters did not mend it. */
  told: boolean;
}

/** What has been done about each of these invoices, for the list the owner reads. */
export async function remindingOf(tx: TenantClient, companyId: string, invoiceIds: string[]): Promise<Record<string, InvoiceReminding>> {
  const out: Record<string, InvoiceReminding> = {};
  if (invoiceIds.length === 0) return out;
  const { rows: sent } = await tx.query<{ invoice_id: string; n: number; last_on: string }>(
    `SELECT invoice_id, count(*)::int AS n, to_char(max(sent_on), 'YYYY-MM-DD') AS last_on FROM invoice_reminders
      WHERE company_id = $1 AND invoice_id = ANY($2::uuid[]) GROUP BY invoice_id`, [companyId, invoiceIds]);
  const { rows: flags } = await tx.query<{ invoice_id: string; held: boolean; told: boolean }>(
    `SELECT invoice_id, held_at IS NOT NULL AS held, escalated_at IS NOT NULL AS told FROM invoice_collections
      WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])`, [companyId, invoiceIds]);
  for (const id of invoiceIds) {
    const one = sent.find((row) => row.invoice_id === id);
    const flag = flags.find((row) => row.invoice_id === id);
    if (!one && !flag) continue;
    out[id] = { sent: one?.n ?? 0, lastOn: one?.last_on ?? null, held: flag?.held ?? false, told: flag?.told ?? false };
  }
  return out;
}

export interface Senders {
  /** The roles that can write the letters: they hold the tool and their division the grant. */
  names: string[];
  /** The roles that issue invoices and cannot yet. */
  waiting: string[];
}

export async function sendersOf(tx: TenantClient, companyId: string): Promise<Senders> {
  const { rows } = await tx.query<{ called: string; sends: boolean; issues: boolean }>(
    `SELECT coalesce(r.display_name, r.title, r.slug) AS called,
            ('invoice.remind' = ANY(r.tools) AND EXISTS (
               SELECT 1 FROM capability_grants g WHERE g.division_id = r.division_id AND g.capability_name = 'invoice.remind')) AS sends,
            'invoice.issue' = ANY(r.tools) AS issues
       FROM roles r WHERE r.company_id = $1 AND r.frozen_at IS NULL AND coalesce(r.runtime, '') <> 'person' ORDER BY r.created_at`, [companyId]);
  return {
    names: rows.filter((row) => row.sends).map((row) => row.called),
    waiting: rows.filter((row) => !row.sends && row.issues).map((row) => row.called),
  };
}
