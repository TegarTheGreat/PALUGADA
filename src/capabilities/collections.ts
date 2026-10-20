/**
 * `invoice.remind`: a customer is reminded of an overdue invoice by a letter
 * the books write (the owner's request of 7 October: white-collar work
 * handled, and automatically).
 *
 * The capability takes the invoice and nothing else. Who the letter goes to,
 * what it says, in which language and whether it may go at all are the books'
 * (`src/records/collections.ts`), so a model that is persuaded to do something
 * else with it has no field to put the persuasion in. That is what lets it do
 * what `email.send` may not: go on without the owner's yes in work that read
 * content from outside. The letter has nothing in it that content wrote
 * (`clearsOutside`), and what would have to be true for it to go -- an unpaid
 * invoice the company itself issued, overdue, not held, its next step due -- is
 * read from the books and not from the call.
 *
 * Tier 2, as `email.send` is: a letter cannot be called back. It is held to the
 * same mailbox (the division's `mailbox` key, so no new credential), the same
 * rate limit and the same plan (F8.11) as any tier 2 action; it only does not
 * ask when asking would protect against nothing.
 *
 * **A letter goes at most once.** The step is taken, and committed, before a
 * word goes to the mail server (`takeStep`), under a lock on the invoice, so
 * a second caller at the same moment finds it taken and sends nothing. When
 * the server says it took the letter, the step is confirmed with the mail's
 * identity; when it refuses, the step is given back and the next try is a
 * first. A server that hangs up after the letter and before its answer, or a
 * platform that stops in between, leaves the step taken and unconfirmed: it
 * counts as sent, and the owner is told it may not have arrived
 * (`src/duties/collections.ts`) rather than the customer being written to
 * twice.
 */
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import { appendEvent } from '../audit/event-log.ts';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { languagesFor } from '../domain/language.ts';
import { PalugadaError } from '../errors.ts';
import type { MailOptions } from '../chats/mail.ts';
import {
  confirmStep, dayIn, giveStepBack, isHeld, lettersOf, lockInvoice, policyOf, reminderLetter, takeStep, whatIsNext, zoneOf,
} from '../records/collections.ts';
import { invoiceWith } from '../records/invoices.ts';
import { ADDRESS, MAILBOX_ALIAS, credentialForm, deliver, preflightFor } from './mailbox.ts';

export type RemindResult =
  | { status: 'sent'; invoice: string; step: number; of: number; to: string; messageId: string; daysOverdue: number }
  | { status: 'skipped'; invoice: string; reason: 'void' | 'paid' | 'off' | 'held' | 'no_email' | 'not_overdue' | 'not_yet' | 'too_soon' | 'after_last' | 'for_a_person' };

/**
 * Where a reminder about an invoice goes: the address it was issued to, or --
 * when it was issued with none -- its customer's as the contacts have it now.
 * An invoice keeps what it was issued with, so the address the owner adds to
 * the customer when told there is nowhere to write is read from the contact;
 * without that it was never used. Only when the invoice has none: one it was
 * issued to is not replaced by what a contact says later.
 */
export function reminderAddress(issuedTo: string | null, contactNow: string | null): string | null {
  const pattern = new RegExp(ADDRESS);
  if (issuedTo !== null && pattern.test(issuedTo)) return issuedTo;
  return contactNow !== null && pattern.test(contactNow) ? contactNow : null;
}

/**
 * Where a reminder goes, by the rule the look uses (`reminderAddress`): the
 * address the invoice was issued with when a letter can go there, else the
 * customer's as it is now. The customer was read only when the invoice had no
 * address at all, so one issued with an address no letter can go to was never
 * sent to the one the owner then gave the customer (the review of 20 October).
 */
async function addressOf(tx: TenantClient, companyId: string, invoice: { customerEmail: string | null; contactId: string | null }): Promise<string | null> {
  const issued = reminderAddress(invoice.customerEmail, null);
  if (issued !== null || invoice.contactId === null) return issued;
  const { rows } = await tx.query<{ email: string | null }>('SELECT email FROM contacts WHERE company_id = $1 AND id = $2', [companyId, invoice.contactId]);
  return reminderAddress(invoice.customerEmail, rows[0]?.email ?? null);
}

export function invoiceRemind(options: MailOptions = {}): Capability<{ invoice: string }, RemindResult> {
  return {
    name: 'invoice.remind',
    adapter: 'platform:mail',
    defaultTier: 2,
    credentialAlias: MAILBOX_ALIAS,
    credentialForm: credentialForm(options),
    requiredScopes: ['mail:send'],
    fallback: true,
    inputSchema: {
      type: 'object',
      required: ['invoice'],
      properties: {
        invoice: { type: 'string', minLength: 1, maxLength: 64, description: 'The invoice to remind its customer about: its number, such as INV-0007, or its id.' },
      },
      additionalProperties: false,
      description:
        'Writes the customer a reminder that the invoice is unpaid and sends it from the division\'s mailbox. The letter is written from the books: '
        + 'you do not write it, address it or time it. It goes only when the invoice is overdue, still owed, not set aside by the owner and its '
        + 'next reminder is due (three days late, then ten, then twenty-four, a week apart at the least); otherwise nothing is sent and the answer says why.',
    },
    describe: () => ({ moneyCents: 0 }),
    summarize: (input) => `Remind the customer of ${String(input.invoice ?? 'an invoice')}`,
    preflight: preflightFor('invoice.remind', options, { imap: false, smtp: true }),

    // Everything in the letter is the books': nothing a stranger or a model
    // wrote can be in it, so work that read from outside may send it.
    async clearsOutside(input, ctx) {
      return withTenant(ctx.companyId, async (tx) => {
        const invoice = await invoiceWith(tx, ctx.companyId, String(input.invoice ?? ''));
        if (!invoice) return { cleared: false, why: 'off' };
        return { cleared: true, record: { invoice: invoice.number, to: await addressOf(tx, ctx.companyId, invoice) } };
      });
    },

    async execute(input, ctx: CapabilityContext) {
      const reference = String(input.invoice ?? '').trim();
      // What is due is decided, and the step taken, in one transaction under a
      // lock on the invoice, and committed before the letter goes: a second
      // caller waits, then finds the step taken.
      const decided = await withTenant(ctx.companyId, async (tx) => {
        const known = await invoiceWith(tx, ctx.companyId, reference);
        if (!known) throw new PalugadaError('contract.violation', `no invoice ${reference} in these books`, { field: 'invoice' });
        await lockInvoice(tx, known.id);
        const invoice = (await invoiceWith(tx, ctx.companyId, known.id))!;
        const policy = await policyOf(tx, ctx.companyId);
        const skipped = (reason: Extract<RemindResult, { status: 'skipped' }>['reason']) => ({
          result: { status: 'skipped', invoice: invoice.number, reason } as RemindResult,
        });

        if (invoice.status === 'void') return skipped('void');
        if (invoice.outstandingCents <= 0) return skipped('paid');
        if (!policy.enabled) return skipped('off');
        if (await isHeld(tx, ctx.companyId, invoice.id)) return skipped('held');
        const to = await addressOf(tx, ctx.companyId, invoice);
        if (!to) return skipped('no_email');

        // The letters the server took and those it may have: a step in flight
        // or unconfirmed is a step taken.
        const sent = (await lettersOf(tx, ctx.companyId, [invoice.id])).get(invoice.id) ?? [];
        // Today where the company is: a due date is a day on its calendar.
        const today = dayIn(await zoneOf(tx, ctx.companyId), new Date());
        const next = whatIsNext({ dueDate: invoice.dueDate, today, steps: policy.stepsDays, sent });
        if (next.action === 'escalate') return skipped('for_a_person');
        if (next.action === 'wait') return skipped(next.why);

        const work = (await languagesFor(tx, ctx.companyId)).work;
        const { rows: [company] } = await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [ctx.companyId]);
        const letter = reminderLetter({
          language: work, step: next.step, of: next.of, number: invoice.number, customerName: invoice.customerName,
          outstandingCents: invoice.outstandingCents, currency: invoice.currency, dueDate: invoice.dueDate,
          company: company?.name ?? '', paymentNote: policy.paymentNote,
        });
        const attemptId = await takeStep(tx, ctx.companyId, {
          invoiceId: invoice.id, step: next.step, to, outstandingCents: invoice.outstandingCents, daysOverdue: next.daysOverdue, taskId: ctx.taskId,
        });
        return { go: { attemptId, invoice, to, letter, step: next.step, of: next.of, daysOverdue: next.daysOverdue } };
      });
      if ('result' in decided) return decided.result;
      const { attemptId, invoice, to, letter, step, of, daysOverdue } = decided.go;

      let messageId: string;
      try {
        const delivered = await deliver(options, ctx, { to: [to], cc: [], subject: letter.subject, text: letter.text, inReplyTo: null, files: [] });
        if (!/^250\b/.test(delivered.queued)) {
          throw new PalugadaError('capability.unreachable', `the mail server did not accept the reminder for ${invoice.number}: ${delivered.queued || 'no answer'}`, { invoice: invoice.number });
        }
        messageId = delivered.messageId;
      } catch (error) {
        // Refused, or never reached: nothing went, and the step is free. A
        // server that may have taken it keeps the step taken.
        const unknown = error instanceof PalugadaError && error.details.delivery === 'unknown';
        if (!unknown) await withTenant(ctx.companyId, (tx) => giveStepBack(tx, ctx.companyId, attemptId));
        throw error;
      }

      await withTenant(ctx.companyId, async (tx) => {
        await lockInvoice(tx, invoice.id);
        await confirmStep(tx, ctx.companyId, attemptId, messageId);
        await appendEvent(tx, {
          companyId: ctx.companyId, taskId: ctx.taskId, type: 'invoice.reminded', actor: 'agent_run',
          payload: {
            invoiceId: invoice.id, number: invoice.number, step, of, daysOverdue,
            outstandingCents: invoice.outstandingCents, currency: invoice.currency, to, messageId,
          },
        });
      });
      return { status: 'sent', invoice: invoice.number, step, of, to, messageId, daysOverdue };
    },

    // The read-back: a letter said to be sent has its step written, with the mail's identity.
    async verify(_input, result, ctx) {
      if (result.status !== 'sent') return true;
      return withTenant(ctx.companyId, async (tx) => {
        const { rows } = await tx.query<{ message_id: string | null }>(
          `SELECT r.message_id FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id AND i.company_id = r.company_id
            WHERE r.company_id = $1 AND i.number = $2 AND r.step = $3`, [ctx.companyId, result.invoice, result.step]);
        return rows[0]?.message_id === result.messageId;
      });
    },
  };
}
