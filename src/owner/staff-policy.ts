/**
 * What a staff seat may reach in the owner API (staff.ts). Nothing that is
 * not listed here: a route added tomorrow is the owner's until somebody puts
 * it on a list, and `test/documents/staff-routes.test.ts` asks that every
 * read is put on one list or the other, with a reason for leaving it off.
 *
 * Both kinds read their own company -- its work, inbox, money, team, memory
 * and history -- and nothing of another company or of the deployment. An
 * approver also decides and answers the inbox, at tier 2 and below; the
 * route checks the tier, since a pattern cannot.
 */
import type { StaffSeat } from './staff.ts';

/** Reads a seat may make: its own company's pages, and what the console needs to draw them. */
export const STAFF_READS: readonly string[] = [
  '/api/me',
  '/api/companies',
  '/api/control/languages',
  '/api/control/money-display',
  '/api/personas',
  '/api/companies/:companyId/inbox',
  '/api/companies/:companyId/decisions',
  '/api/companies/:companyId/structure',
  '/api/companies/:companyId/work',
  '/api/companies/:companyId/live',
  '/api/companies/:companyId/gallery',
  '/api/companies/:companyId/activity',
  '/api/companies/:companyId/budget-accounts',
  '/api/companies/:companyId/schedules',
  '/api/companies/:companyId/memories',
  '/api/companies/:companyId/standing-approvals',
  '/api/companies/:companyId/inbox/:itemId/trace',
  '/api/companies/:companyId/tasks/:taskId/trace',
  '/api/companies/:companyId/tasks/:taskId/runs/:runId/briefing',
  '/api/companies/:companyId/digest',
  '/api/companies/:companyId/retro',
  '/api/companies/:companyId/spend',
  '/api/companies/:companyId/cost',
  '/api/companies/:companyId/governance',
  '/api/companies/:companyId/divisions/:divisionId/health',
  '/api/companies/:companyId/tasks/:taskId/events',
  '/api/companies/:companyId/tasks/:taskId',
  '/api/companies/:companyId/tasks/:taskId/transcript',
  '/api/companies/:companyId/handoffs',
  '/api/companies/:companyId/triggers',
  '/api/companies/:companyId/tickets',
  '/api/companies/:companyId/divisions/:divisionId/roles/:roleId/budget',
  '/api/companies/:companyId/goals/:goalId',
  '/api/companies/:companyId/documents',
  '/api/companies/:companyId/documents/:documentId',
  '/api/companies/:companyId/policies',
  '/api/companies/:companyId/charter',
  '/api/companies/:companyId/config/:kind/history',
  '/api/companies/:companyId/skills',
  '/api/companies/:companyId/skills/:skillId',
  '/api/companies/:companyId/roles/:roleId/evals',
  '/api/companies/:companyId/reviews',
];

/** Reads left off, and why: each is the owner's, or the deployment's. */
export const STAFF_HIDDEN: Readonly<Record<string, string>> = {
  '/api/search': 'it searches every company',
  '/api/runtimes': 'the deployment\'s',
  '/api/control/setup': 'the deployment\'s',
  '/api/control': 'the deployment\'s brakes and settings',
  '/api/erasures': 'companies the owner closed',
  '/api/control/owner-window': 'when the owner is woken',
  '/api/control/settings': 'the deployment\'s settings',
  '/api/control/channels': 'the owner\'s own channels',
  '/api/control/tools': 'the deployment\'s',
  '/api/control/mcp': 'the deployment\'s',
  '/api/control/vendors': 'the deployment\'s',
  '/api/assistant': 'the owner\'s conversation with PALUGADA',
  '/api/control/agents': 'the deployment\'s',
  '/api/control/agents/:name/job': 'the deployment\'s',
  '/api/control/tour': 'the owner\'s',
  '/api/control/cost': 'every company\'s money',
  '/api/publishers': 'the deployment\'s',
  '/api/mfa/authenticators': 'the owner\'s devices',
  '/api/mfa/challenge': 'the owner\'s devices',
  '/api/mfa/passkeys/options': 'the owner\'s devices',
  '/api/companies/:companyId/first-hour': 'the owner\'s first hour',
  '/api/companies/:companyId/devices': 'the company\'s devices are set up by the owner',
  '/api/companies/:companyId/retention': 'how long the company keeps things is the owner\'s',
  '/api/companies/:companyId/conversation': 'the owner\'s conversation with the CEO',
  '/api/companies/:companyId/divisions/:divisionId/credentials': 'the company\'s keys',
  '/api/companies/:companyId/bundles/:slug/verify': 'what is installed is the owner\'s',
  '/api/companies/:companyId/export': 'the whole company, to take away',
  '/api/companies/:companyId/staff': 'who is seated is the owner\'s',
};

/** What an approver may also do: decide and answer the inbox (at tier 2 and below, which the route checks). */
export const STAFF_DECIDES: readonly string[] = [
  '/api/companies/:companyId/inbox/:itemId/decide',
  '/api/companies/:companyId/inbox/:itemId/answer',
  '/api/companies/:companyId/inbox/batch',
];

/** Whether a seat may make this request: on a list, and about its own company when it names one. */
export function staffMay(seat: StaffSeat, method: string, pattern: string, params: Record<string, string>): boolean {
  if (params.companyId !== undefined && params.companyId !== seat.companyId) return false;
  if (method === 'GET') return STAFF_READS.includes(pattern);
  if (method === 'POST') {
    if (pattern === '/api/auth/sign-out') return true;
    return seat.kind === 'approver' && STAFF_DECIDES.includes(pattern);
  }
  return false;
}
