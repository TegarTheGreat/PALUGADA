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
import { wallClockAt } from '../scheduler/windows.ts';

/** Days past the due date at which each reminder goes, unless the company set its own. */
export const DEFAULT_STEPS: readonly number[] = [3, 10, 24];
/** The least time between two letters about one invoice. */
export const MIN_GAP_DAYS = 7;
/**
 * An invoice this far past the day its first reminder was due, and never
 * reminded, is not sent a form letter by a platform just switched on.
 */
export const STALE_AFTER_DAYS = 60;
/** How long the last letter has to work before a person is told it did not. */
export const ESCALATE_AFTER_DAYS = 7;

const DAY = 86_400_000;

/**
 * The company's time zone: the calendar its reminders count days on, and date
 * their letters by. A due date is a day where the company is; counted in UTC,
 * a letter went to a customer on the evening of the due day in a company
 * west of UTC, and a day late east of it. UTC for a zone this platform cannot
 * read, so a misspelt one stops nothing.
 */
export async function zoneOf(tx: TenantClient, companyId: string): Promise<string> {
  const { rows } = await tx.query<{ timezone: string }>('SELECT timezone FROM companies WHERE id = $1', [companyId]);
  const zone = rows[0]?.timezone ?? 'UTC';
  try {
    wallClockAt(zone, 0);
    return zone;
  } catch {
    return 'UTC';
  }
}

/** The day of the calendar (`YYYY-MM-DD`) it is in a time zone at an instant. */
export function dayIn(zone: string, instant: Date): string {
  return new Date(wallClockAt(zone, instant.getTime())).toISOString().slice(0, 10);
}

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
  // Counted from the first letter's day, not the due date: a company may put
  // its first letter later than sixty days (setPolicy takes up to 180), and
  // counted from the due date every invoice was stale before its first letter
  // was due.
  if (done === 0 && daysOverdue - input.steps[0]! > STALE_AFTER_DAYS) return { action: 'escalate', why: 'stale', daysOverdue, sent: 0 };

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

/** A line without the spaces and tabs at its end, walked back from the end: no pattern, so no backtracking. */
function withoutTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return line.slice(0, end);
}

/** The owner's words on how to pay, cleaned: lines kept, anything that could end a header or hide text dropped. */
function cleanNote(value: string): string {
  // The spaces at the ends of lines are taken off line by line, without a
  // pattern: as one it was quadratic in a run of spaces with no newline, and
  // 200,000 of them held the server for most of a minute (the review of 20
  // October).
  return value.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(UNPRINTABLE, '')
    .split('\n').map(withoutTrailingBlanks).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Whether a note the owner sent says what the kept one says, once cleaned as
 * it would be kept: the console sends the note back with the days whether or
 * not it was touched, and one that changes nothing is not a change to ask the
 * owner's device for. A note too long to keep is never the same.
 */
export function sameNote(given: string | null, kept: string | null): boolean {
  if (given === null) return kept === null;
  if (given.length > PAYMENT_NOTE_MAX * 8) return false;
  const clean = cleanNote(given);
  return (clean === '' ? null : clean) === kept;
}

/**
 * The owner's words on how to pay, as a letter carries them. Cut only as a
 * last guard: `setPolicy` refuses a longer note rather than keep half of it.
 */
export function paymentNoteOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const clean = cleanNote(value);
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
  // Two saves at once each read the policy and write all of it back: one at a
  // time, so the second starts from what the first kept rather than undoing it.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`collections-policy:${companyId}`]);
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
    // Measured as the letter will carry it, and refused whole: cut, a note
    // kept its first part, and the end of one is where the account number is.
    // Something far longer than any note is refused before it is cleaned at all.
    if (typeof change.paymentNote === 'string' && change.paymentNote.length > PAYMENT_NOTE_MAX * 8) {
      throw wrong(`paymentNote is at most ${PAYMENT_NOTE_MAX} characters; this one is ${change.paymentNote.length}`, 'paymentNote');
    }
    const length = typeof change.paymentNote === 'string' ? cleanNote(change.paymentNote).length : 0;
    if (length > PAYMENT_NOTE_MAX) {
      throw wrong(`paymentNote is at most ${PAYMENT_NOTE_MAX} characters; this one is ${length}`, 'paymentNote');
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

/**
 * How long a letter handed to the mail server may wait for the server's answer
 * before it is taken to be one the server may or may not have sent: a send
 * takes seconds, so a quarter of an hour is not a slow server any more.
 */
export const IN_FLIGHT_MINUTES = 15;

export interface Reminder {
  step: number;
  sentOn: string;
  sentAt: Date;
  to: string;
  outstandingCents: number;
  daysOverdue: number;
  /**
   * False for a letter handed to the mail server that never said it took it.
   * It counts as sent -- its step is taken and the next is counted from it --
   * because a letter cannot be called back, and one written twice is worse
   * than one the owner is told may not have arrived.
   */
  confirmed: boolean;
}

/** The letters sent about an invoice, in order: those the server took, and those it may have. */
export async function remindersOf(tx: TenantClient, companyId: string, invoiceId: string): Promise<Reminder[]> {
  const zone = await zoneOf(tx, companyId);
  const { rows } = await tx.query<{ step: number; sent_on: string; sent_at: Date; to_address: string; outstanding_cents: string; days_overdue: number; confirmed: boolean }>(
    `SELECT step, to_char(sent_on, 'YYYY-MM-DD') AS sent_on, sent_at, to_address, outstanding_cents, days_overdue, true AS confirmed
       FROM invoice_reminders WHERE company_id = $1 AND invoice_id = $2
     UNION ALL
     SELECT step, to_char((started_at AT TIME ZONE $3)::date, 'YYYY-MM-DD'), started_at, to_address, outstanding_cents, days_overdue, false
       FROM invoice_reminder_attempts WHERE company_id = $1 AND invoice_id = $2
     ORDER BY step`, [companyId, invoiceId, zone]);
  return rows.map((row) => ({
    step: row.step, sentOn: row.sent_on, sentAt: row.sent_at, to: row.to_address,
    outstandingCents: Number(row.outstanding_cents), daysOverdue: row.days_overdue, confirmed: row.confirmed,
  }));
}

/** The letters of each of these invoices as the steps count them, by invoice: what `whatIsNext` is given. */
export async function lettersOf(tx: TenantClient, companyId: string, invoiceIds: string[]): Promise<Map<string, Array<{ step: number; day: string }>>> {
  const out = new Map<string, Array<{ step: number; day: string }>>();
  if (invoiceIds.length === 0) return out;
  const zone = await zoneOf(tx, companyId);
  const { rows } = await tx.query<{ invoice_id: string; step: number; day: string }>(
    `SELECT invoice_id, step, to_char(sent_on, 'YYYY-MM-DD') AS day FROM invoice_reminders
      WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])
     UNION ALL
     SELECT invoice_id, step, to_char((started_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') FROM invoice_reminder_attempts
      WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])
     ORDER BY invoice_id, step`, [companyId, invoiceIds, zone]);
  for (const row of rows) out.set(row.invoice_id, [...(out.get(row.invoice_id) ?? []), { step: row.step, day: row.day }]);
  return out;
}

/**
 * Takes a step before its letter goes, and commits it: from here the step is
 * this letter's, whatever happens to the letter. The caller holds the
 * invoice's lock (`lockInvoice`) from reading the letters to here.
 */
export async function takeStep(tx: TenantClient, companyId: string, input: {
  invoiceId: string; step: number; to: string; outstandingCents: number; daysOverdue: number; taskId: string | null;
}): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO invoice_reminder_attempts (company_id, invoice_id, step, to_address, outstanding_cents, days_overdue, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [companyId, input.invoiceId, input.step, input.to, input.outstandingCents, input.daysOverdue, input.taskId]);
  return rows[0]!.id;
}

/** The mail server refused the letter: nothing went, and the step is free again. */
export async function giveStepBack(tx: TenantClient, companyId: string, attemptId: string): Promise<void> {
  await tx.query('DELETE FROM invoice_reminder_attempts WHERE company_id = $1 AND id = $2', [companyId, attemptId]);
}

/**
 * The mail server took the letter: it is written as sent, on the day it was
 * handed over and with the mail's identity, and is no longer in flight. False
 * when there was no such letter in flight any more.
 */
export async function confirmStep(tx: TenantClient, companyId: string, attemptId: string, messageId: string): Promise<boolean> {
  const zone = await zoneOf(tx, companyId);
  const { rowCount } = await tx.query(
    `INSERT INTO invoice_reminders (company_id, invoice_id, step, sent_on, sent_at, to_address, message_id, outstanding_cents, days_overdue, task_id)
     SELECT company_id, invoice_id, step, (started_at AT TIME ZONE $4)::date, started_at, to_address, $3, outstanding_cents, days_overdue, task_id
       FROM invoice_reminder_attempts WHERE company_id = $1 AND id = $2`,
    [companyId, attemptId, messageId, zone]);
  await tx.query('DELETE FROM invoice_reminder_attempts WHERE company_id = $1 AND id = $2', [companyId, attemptId]);
  return (rowCount ?? 0) > 0;
}

export interface Unconfirmed {
  attemptId: string;
  invoiceId: string;
  number: string;
  customer: string;
  to: string;
  step: number;
  /** How many letters the policy has: the step's place, as the owner reads it. */
  of: number;
  day: string;
}

/** Letters handed to the mail server long enough ago that it is not going to say any more about them. */
export async function unconfirmedLetters(tx: TenantClient, companyId: string): Promise<Unconfirmed[]> {
  const policy = await policyOf(tx, companyId);
  const zone = await zoneOf(tx, companyId);
  const { rows } = await tx.query<{ id: string; invoice_id: string; number: string; customer_name: string; to_address: string; step: number; day: string }>(
    `SELECT a.id, a.invoice_id, i.number, i.customer_name, a.to_address, a.step,
            to_char((a.started_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day
       FROM invoice_reminder_attempts a JOIN invoices i ON i.company_id = a.company_id AND i.id = a.invoice_id
      WHERE a.company_id = $1 AND a.started_at < now() - make_interval(mins => $2)
      ORDER BY a.started_at`, [companyId, IN_FLIGHT_MINUTES, zone]);
  return rows.map((row) => ({
    attemptId: row.id, invoiceId: row.invoice_id, number: row.number, customer: row.customer_name, to: row.to_address,
    step: row.step, of: Math.max(policy.stepsDays.length, row.step), day: row.day,
  }));
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
  // A letter the server may have sent is one of the letters: the owner reads
  // it on the invoice as such (`remindersOf`).
  const zone = await zoneOf(tx, companyId);
  const { rows: sent } = await tx.query<{ invoice_id: string; n: number; last_on: string }>(
    `SELECT invoice_id, count(*)::int AS n, to_char(max(sent_on), 'YYYY-MM-DD') AS last_on FROM (
       SELECT invoice_id, sent_on FROM invoice_reminders WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])
       UNION ALL
       SELECT invoice_id, (started_at AT TIME ZONE $3)::date FROM invoice_reminder_attempts WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])
     ) letters GROUP BY invoice_id`, [companyId, invoiceIds, zone]);
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
