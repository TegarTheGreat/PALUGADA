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
 * **A step is written once.** The invoice is locked from reading what was sent
 * to writing what is (a second caller at the same moment waits, then finds the
 * step taken and sends nothing), and a letter that could not be sent writes
 * nothing, so the next try is a first.
 */
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import { appendEvent } from '../audit/event-log.ts';
import { withTenant } from '../db/tenant.ts';
import { languagesFor } from '../domain/language.ts';
import { PalugadaError } from '../errors.ts';
import type { MailOptions } from '../chats/mail.ts';
import {
  isHeld, lockInvoice, policyOf, recordReminder, reminderLetter, remindersOf, whatIsNext,
} from '../records/collections.ts';
import { invoiceWith } from '../records/invoices.ts';
import { ADDRESS, MAILBOX_ALIAS, credentialForm, deliver, preflightFor } from './mailbox.ts';

export type RemindResult =
  | { status: 'sent'; invoice: string; step: number; of: number; to: string; messageId: string; daysOverdue: number }
  | { status: 'skipped'; invoice: string; reason: 'void' | 'paid' | 'off' | 'held' | 'no_email' | 'not_overdue' | 'not_yet' | 'too_soon' | 'after_last' | 'for_a_person' };

const today = () => new Date().toISOString().slice(0, 10);

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
      const invoice = await withTenant(ctx.companyId, (tx) => invoiceWith(tx, ctx.companyId, String(input.invoice ?? '')));
      if (!invoice) return { cleared: false, why: 'off' };
      return { cleared: true, record: { invoice: invoice.number, to: invoice.customerEmail } };
    },

    async execute(input, ctx: CapabilityContext) {
      const reference = String(input.invoice ?? '').trim();
      // One transaction from reading what was sent to writing what is sent,
      // under a lock on the invoice: a second caller at the same moment waits,
      // then reads a list that has the first one's letter in it. A letter that
      // cannot be sent rolls the whole of it back, so the step is still free.
      return withTenant(ctx.companyId, async (tx): Promise<RemindResult> => {
        const known = await invoiceWith(tx, ctx.companyId, reference);
        if (!known) throw new PalugadaError('contract.violation', `no invoice ${reference} in these books`, { field: 'invoice' });
        await lockInvoice(tx, known.id);
        const invoice = (await invoiceWith(tx, ctx.companyId, known.id))!;
        const policy = await policyOf(tx, ctx.companyId);
        const skipped = (reason: Extract<RemindResult, { status: 'skipped' }>['reason']): RemindResult => ({ status: 'skipped', invoice: invoice.number, reason });

        if (invoice.status === 'void') return skipped('void');
        if (invoice.outstandingCents <= 0) return skipped('paid');
        if (!policy.enabled) return skipped('off');
        if (await isHeld(tx, ctx.companyId, invoice.id)) return skipped('held');
        const to = invoice.customerEmail;
        if (!to || !new RegExp(ADDRESS).test(to)) return skipped('no_email');

        const day = today();
        const sent = await remindersOf(tx, ctx.companyId, invoice.id);
        const next = whatIsNext({
          dueDate: invoice.dueDate, today: day, steps: policy.stepsDays, sent: sent.map((one) => ({ step: one.step, day: one.sentOn })),
        });
        if (next.action === 'escalate') return skipped('for_a_person');
        if (next.action === 'wait') return skipped(next.why);

        const work = (await languagesFor(tx, ctx.companyId)).work;
        const { rows: [company] } = await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [ctx.companyId]);
        const letter = reminderLetter({
          language: work, step: next.step, of: next.of, number: invoice.number, customerName: invoice.customerName,
          outstandingCents: invoice.outstandingCents, currency: invoice.currency, dueDate: invoice.dueDate,
          company: company?.name ?? '', paymentNote: policy.paymentNote,
        });
        const delivered = await deliver(options, ctx, { to: [to], cc: [], subject: letter.subject, text: letter.text, inReplyTo: null, files: [] });
        if (!/^250\b/.test(delivered.queued)) {
          throw new PalugadaError('capability.unreachable', `the mail server did not accept the reminder for ${invoice.number}: ${delivered.queued || 'no answer'}`, { invoice: invoice.number });
        }
        await recordReminder(tx, ctx.companyId, {
          invoiceId: invoice.id, step: next.step, day, to, messageId: delivered.messageId,
          outstandingCents: invoice.outstandingCents, daysOverdue: next.daysOverdue, taskId: ctx.taskId,
        });
        await appendEvent(tx, {
          companyId: ctx.companyId, taskId: ctx.taskId, type: 'invoice.reminded', actor: 'agent_run',
          payload: {
            invoiceId: invoice.id, number: invoice.number, step: next.step, of: next.of, daysOverdue: next.daysOverdue,
            outstandingCents: invoice.outstandingCents, currency: invoice.currency, to, messageId: delivered.messageId,
          },
        });
        return { status: 'sent', invoice: invoice.number, step: next.step, of: next.of, to, messageId: delivered.messageId, daysOverdue: next.daysOverdue };
      });
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
