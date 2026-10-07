/**
 * Who sends the reminders (the owner's request of 7 October: white-collar work
 * handled, and automatically).
 *
 * `invoice.remind` is a role's tool like another, and giving a role a tool is
 * the owner's (F2.9): the platform does not hand it out because an invoice is
 * late. The owner's switch for reminders is that decision, made once: it gives
 * the tool, with its division's grant, to the roles that already bill customers
 * with `invoice.issue` -- the authority to remind about an invoice is a part of
 * the authority to issue it -- and, when no role does, hires a bookkeeper for
 * the job, so that a company of one owner and a CEO collects what it is owed
 * too. (The CEO cannot carry it: it already holds the twelve tools a role may.)
 *
 * It is a change to the role like any other (a version, an event, a rollback)
 * made with the owner's session, and what cannot be given (a role already
 * holding twelve tools) is said and left.
 */
import { withTenant } from '../db/tenant.ts';
import { PLATFORM_TOOLS } from '../templates/work.ts';
import { addRole, applyRoleChange, grantRoleTools } from './structure.ts';

export interface GivenReminders {
  /** Roles that now hold the tool. */
  given: string[];
  /** Roles that could not take another tool. */
  full: string[];
  /** Roles whose division could not be granted it: the platform knows no such capability here (a deployment that never registered it). */
  ungranted: string[];
}

/** What the bookkeeper hired for the switch is told it is: the job, and where its edges are. */
const BOOKKEEPER_CHARTER =
  'You are the company\'s bookkeeper. You keep an eye on what customers owe: read the books with ledger.read to say who owes what and since when, ' +
  'always with the invoice numbers. The platform itself writes and sends the reminders for overdue invoices, from the books, on the days the owner ' +
  'set, with invoice.remind under your name; you never write a reminder yourself. You do not issue invoices or record entries unless the owner ' +
  'gives you those tools. When an invoice needs a person -- a customer who will not pay, an address that is missing -- say so plainly and leave it to ' +
  'the owner.';

export async function giveReminders(companyId: string): Promise<GivenReminders> {
  const holders = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; tools: string[]; called: string; issues: boolean; reminds: boolean; named: boolean; ceo: boolean; division_id: string;
    }>(
      `SELECT id, tools, division_id, coalesce(display_name, title, slug) AS called, 'invoice.issue' = ANY(tools) AS issues,
              'invoice.remind' = ANY(tools) AS reminds, slug = 'bookkeeper' AS named, title = 'CEO' AS ceo
         FROM roles WHERE company_id = $1 AND frozen_at IS NULL AND coalesce(runtime, '') <> 'person' ORDER BY created_at`, [companyId]);
    return rows;
  });
  // The roles that bill customers, and any that already hold the tool or are
  // the company's bookkeeper: the authority to remind is a part of the
  // authority to bill. With none of them, the job gets a role of its own --
  // the CEO already holds the most tools a role may.
  const chosen = holders.filter((role) => role.issues || role.reminds || role.named);
  const given: string[] = [];
  const full: string[] = [];
  const ungranted: string[] = [];
  for (const role of chosen) {
    if (role.tools.includes('invoice.remind')) {
      // The tool is there; its division's grant may not be.
      const granting = await grantRoleTools(companyId, role.id, { ownerApproved: true });
      if (granting.ungranted.includes('invoice.remind')) ungranted.push(role.called);
      continue;
    }
    if (role.tools.length >= 12) { full.push(role.called); continue; }
    await applyRoleChange(companyId, role.id, { tools: [...role.tools, 'invoice.remind'] }, {
      ownerApproved: true, summary: 'The owner switched on reminders for overdue invoices',
    });
    const granting = await grantRoleTools(companyId, role.id, { ownerApproved: true });
    if (granting.ungranted.includes('invoice.remind')) ungranted.push(role.called);
    given.push(role.called);
  }
  const ceo = holders.find((role) => role.ceo);
  if (chosen.length === 0 && ceo) {
    const hired = await addRole(companyId, {
      divisionId: ceo.division_id, slug: 'bookkeeper', title: 'Bookkeeper', systemPrompt: BOOKKEEPER_CHARTER,
      tools: [...PLATFORM_TOOLS, 'invoice.remind', 'ledger.read'],
      doneCriteria: ['what is owed was read from the books, with the invoice numbers'],
    }, { ownerApproved: true, grantTools: true });
    if (hired.ungranted.includes('invoice.remind')) ungranted.push('Bookkeeper');
    given.push('Bookkeeper');
  }
  return { given, full, ungranted };
}
