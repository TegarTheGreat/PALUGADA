/**
 * The collections duty: customers who owe are reminded, and a person is told
 * about the ones a letter did not reach (the owner's request of 7 October:
 * white-collar work handled, and automatically).
 *
 * Two halves, as the other things the platform starts for itself have
 * (`engine/triage.ts`, `engine/outcomes.ts`):
 *
 *  - **The look** (`ensureCollections`), run by the worker for each company, at
 *    most every half hour. It reads the books and the letters sent
 *    (`whatIsNext`, src/records/collections.ts), and does two things. For the
 *    invoices whose next reminder is due it makes one task for the role that
 *    holds `invoice.remind`. For the invoices a letter is no longer the answer
 *    to -- unpaid after the last one, overdue for months and never reminded, or
 *    with nowhere to send a letter -- it puts one card to the owner, once for
 *    each, and says so in words and not in codes.
 *  - **The work** (`collectionsDuty`), which is that task: no model, one call of
 *    `invoice.remind` for each invoice named, under the role's grants and the
 *    broker's rules. The capability decides again, from the books at that
 *    moment, whether each reminder is still due: an invoice paid between the
 *    look and the work is not written to.
 *
 * What it will not do is start anything it has no one to give to. With no role
 * that holds the capability it does not guess a role into having it -- giving a
 * role a tool is the owner's (F2.9) -- it tells the owner, once, that nobody is
 * set to remind customers and where to switch that on.
 */
import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '../db/tenant.ts';
import { languagesFor } from '../domain/language.ts';
import { isPalugadaError, type PalugadaError } from '../errors.ts';
import * as inbox from '../inbox/inbox.ts';
import { invoiceUnpaidCard, nobodyRemindsCard, ownerReadingWithin, remindedSaid, reminderMailboxAsked, reminderPlanSaid } from '../owner/platform-cards.ts';
import { ADDRESS } from '../capabilities/mailbox.ts';
import type { RemindResult } from '../capabilities/collections.ts';
import { createRootTask } from '../engine/tasks.ts';
import { noteEscalated, policyOf, whatIsNext } from '../records/collections.ts';
import { listInvoices } from '../records/invoices.ts';
import type { TaskHandler } from '../runtime/in-process.ts';

/** The least time between one look at a company's invoices and the next. */
export const COLLECTIONS_EVERY_MS = 30 * 60_000;
/** The most invoices one task names; the rest are the next look's. */
const MOST_INVOICES = 25;
/** The key of the card that says nobody can remind, so there is one while it is open. */
const NOBODY = 'collections_nobody';

const lastLook = new Map<string, number>();

export interface CollectionsLook {
  /** The task made (or already there) for the invoices whose reminder is due. */
  task: string | null;
  /** How many invoices it names. */
  due: number;
  /** Cards put to the owner about invoices a letter no longer answers. */
  escalated: number;
  /** The owner was told that nobody is set to remind customers. */
  nobody: boolean;
}

const NOTHING: CollectionsLook = { task: null, due: 0, escalated: 0, nobody: false };

interface Candidate { id: string; number: string; step: number }
interface ForAPerson { id: string; number: string; customer: string; cents: number; currency: string; dueDate: string; why: 'unpaid_after_last' | 'stale' | 'no_email' }

/** What the books say needs doing about overdue invoices today. */
async function read(tx: TenantClient, companyId: string, today: string): Promise<{ due: Candidate[]; person: ForAPerson[] } | null> {
  const policy = await policyOf(tx, companyId);
  if (!policy.enabled) return null;
  const { invoices } = await listInvoices(tx, companyId, { status: 'open', limit: 500 });
  if (invoices.length === 0) return { due: [], person: [] };
  const ids = invoices.map((invoice) => invoice.id);
  const { rows: sent } = await tx.query<{ invoice_id: string; step: number; sent_on: string }>(
    `SELECT invoice_id, step, to_char(sent_on, 'YYYY-MM-DD') AS sent_on FROM invoice_reminders
      WHERE company_id = $1 AND invoice_id = ANY($2::uuid[]) ORDER BY invoice_id, step`, [companyId, ids]);
  const { rows: flags } = await tx.query<{ invoice_id: string; held: boolean; told: boolean }>(
    `SELECT invoice_id, held_at IS NOT NULL AS held, escalated_at IS NOT NULL AS told FROM invoice_collections
      WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])`, [companyId, ids]);

  const due: Candidate[] = [];
  const person: ForAPerson[] = [];
  for (const invoice of invoices) {
    const flag = flags.find((one) => one.invoice_id === invoice.id);
    if (flag?.held) continue;
    const letters = sent.filter((one) => one.invoice_id === invoice.id).map((one) => ({ step: one.step, day: one.sent_on }));
    const next = whatIsNext({ dueDate: invoice.dueDate, today, steps: policy.stepsDays, sent: letters });
    const reachable = invoice.customerEmail !== null && new RegExp(ADDRESS).test(invoice.customerEmail);
    const about = { id: invoice.id, number: invoice.number, customer: invoice.customerName, cents: invoice.outstandingCents, currency: invoice.currency, dueDate: invoice.dueDate };
    if (next.action === 'remind') {
      if (reachable) due.push({ id: invoice.id, number: invoice.number, step: next.step });
      else if (!flag?.told) person.push({ ...about, why: 'no_email' });
    } else if (next.action === 'escalate' && !flag?.told) {
      person.push({ ...about, why: next.why });
    }
  }
  return { due: due.slice(0, MOST_INVOICES), person };
}

/**
 * Looks at a company's overdue invoices: makes the work for the reminders that
 * are due, and puts the ones a letter will not mend to the owner.
 */
export async function ensureCollections(companyId: string, now = new Date()): Promise<CollectionsLook> {
  const before = lastLook.get(companyId);
  if (before !== undefined && now.getTime() - before < COLLECTIONS_EVERY_MS && now.getTime() >= before) return NOTHING;
  lastLook.set(companyId, now.getTime());
  const today = now.toISOString().slice(0, 10);

  const found = await withTenant(companyId, (tx) => read(tx, companyId, today));
  if (!found) return NOTHING;

  // A card for each invoice a letter no longer answers, once, in the same
  // transaction that notes it was told: the note and the card exist together.
  let escalated = 0;
  for (const one of found.person) {
    const raised = await withTenant(companyId, async (tx) => {
      if (!(await noteEscalated(tx, companyId, one.id))) return false;
      const card = invoiceUnpaidCard(await ownerReadingWithin(tx), {
        why: one.why, number: one.number, customer: one.customer, cents: one.cents, currency: one.currency, dueDate: one.dueDate,
      });
      await inbox.raiseEscalationWithin(tx, { companyId, title: card.title, detail: card.detail, payload: { invoiceId: one.id, number: one.number, why: one.why } });
      return true;
    });
    if (raised) escalated += 1;
  }
  if (found.due.length === 0) return { ...NOTHING, escalated };

  const who = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; division_id: string }>(
      `SELECT r.id, r.division_id FROM roles r
         JOIN capability_grants g ON g.division_id = r.division_id AND g.capability_name = 'invoice.remind'
        WHERE 'invoice.remind' = ANY(r.tools) AND r.frozen_at IS NULL AND coalesce(r.runtime, '') <> 'person'
        ORDER BY r.created_at LIMIT 1`);
    const { rows: project } = await tx.query<{ id: string }>('SELECT id FROM projects ORDER BY created_at LIMIT 1');
    const { rows: goal } = await tx.query<{ id: string }>(
      "SELECT id FROM goals WHERE status = 'active' ORDER BY CASE kind WHEN 'mission' THEN 0 ELSE 1 END, created_at LIMIT 1");
    return { role: rows[0] ?? null, projectId: project[0]?.id ?? null, goalId: goal[0]?.id ?? null };
  });

  if (!who.role) {
    // Nobody can write the letters: said once while the card is open.
    const told = await withTenant(companyId, async (tx) => {
      const { rows: open } = await tx.query(
        "SELECT 1 FROM inbox_items WHERE kind = 'escalation' AND status = 'open' AND payload->>'once' = $1", [NOBODY]);
      if (open.length > 0) return false;
      const card = nobodyRemindsCard(await ownerReadingWithin(tx));
      await inbox.raiseEscalationWithin(tx, { companyId, title: card.title, detail: card.detail, payload: { once: NOBODY } });
      return true;
    });
    return { task: null, due: found.due.length, escalated, nobody: told };
  }
  if (!who.projectId || !who.goalId) return { ...NOTHING, escalated };

  // The same invoices at the same steps on the same day are the same task: two
  // workers that look at once make one between them.
  const fingerprint = createHash('sha256')
    .update(`${today}|${found.due.map((one) => `${one.id}@${one.step}`).join('|')}`).digest('hex').slice(0, 24);
  try {
    const task = await createRootTask({
      companyId, projectId: who.projectId, divisionId: who.role.division_id, roleId: who.role.id, goalId: who.goalId,
      createdBy: 'event', idempotencyKey: `duty:collections:${fingerprint}`, reserveTokens: 100,
      input: {
        goal: 'Remind the customers whose invoices are overdue.',
        context: 'Each invoice named is past its due date and its next reminder is due. Nothing here needs a model: the reminders are written from the books.',
        duty: 'collections',
        invoices: found.due.map((one) => one.number),
      },
    });
    return { task: task.id, due: found.due.length, escalated, nobody: false };
  } catch (error) {
    // A frozen role, a paused month, a goal just closed: each is a reason
    // nothing starts now, and the next look finds it again.
    if (isPalugadaError(error)) return { ...NOTHING, escalated };
    throw error;
  }
}

/** The task the look made: one `invoice.remind` for each invoice it names. */
export const collectionsDuty: TaskHandler = async (ctx) => {
  const named = Array.isArray(ctx.task.input.invoices)
    ? (ctx.task.input.invoices as unknown[]).filter((one): one is string => typeof one === 'string').slice(0, MOST_INVOICES)
    : [];
  const languages = await withTenant(ctx.task.companyId, (tx) => languagesFor(tx, ctx.task.companyId));
  const talk = languages.talk;
  // The plan is words the company's agents write for people, so it is in the
  // company's work language; one in another would be noted as a slip.
  await ctx.callCapability('plan.record', {
    steps: [{ capability: 'invoice.remind', ...reminderPlanSaid(languages.work) }],
  });
  const reminded: string[] = [];
  const left: Array<{ invoice: string; why: string }> = [];
  const remind = (number: string) => ctx.callCapability<{ invoice: string }, RemindResult>('invoice.remind', { invoice: number });
  for (const number of named) {
    try {
      let result: RemindResult;
      try {
        result = await remind(number);
      } catch (error) {
        // No mailbox yet: the owner is asked for it, the way any role asks for a
        // key it lacks (`owner.ask` with the key), and the task waits. Given
        // since, it is tried once more.
        if (!isPalugadaError(error, 'capability.not_granted') || (error as PalugadaError).details.alias !== 'mailbox') throw error;
        await ctx.callCapability('owner.ask', {
          question: reminderMailboxAsked(talk),
          key: 'mailbox',
        });
        result = await remind(number);
      }
      if (result.status === 'sent') reminded.push(number);
      else left.push({ invoice: number, why: result.reason });
    } catch (error) {
      // An invoice that is gone or refused is that invoice's; a mailbox that is
      // down, a card for the owner or a rate limit is the whole task's, and the
      // engine knows what to do with each.
      if (isPalugadaError(error, 'contract.violation')) left.push({ invoice: number, why: (error as Error).message });
      else throw error;
    }
  }

  const summary = remindedSaid(talk, reminded);
  return { summary, reminded, left };
};
