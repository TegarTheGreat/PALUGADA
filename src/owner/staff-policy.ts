/**
 * What a staff seat may reach in the owner API (staff.ts). Nothing that is
 * not listed here: a route added tomorrow is the owner's until somebody puts
 * it on a list, and `test/documents/staff-routes.test.ts` asks that every
 * read is put on one list or the other, with a reason for leaving it off.
 *
 * Every seat reads its own company -- its work, inbox, money, team, memory
 * and history -- and nothing of another company or of the deployment. What a
 * seat may post is a ladder (F19.2): any seat talks in the rooms, about
 * itself; a member also asks for work and answers what is put to it; an
 * approver also decides, at tier 2 and below. The route checks the tier and
 * the inbox's functions check the rest, since a pattern cannot.
 *
 * The lists are data. The people's workspace adds its routes area by area,
 * and each area keeps its own block below, fenced and named by the STATUS
 * section that builds it, so building an area edits its block and no other
 * line. This file imports no route module: a list is never read before the
 * module that would fill it has loaded, and the staff-routes test reads it
 * without starting the server.
 */
import type { StaffKind, StaffSeat } from './staff.ts';

/** Reads a seat may make: its own company's pages, and what the console needs to draw them. */
const CORE_READS: readonly string[] = [
  '/api/me',
  '/api/companies',
  '/api/control/languages',
  '/api/control/money-display',
  '/api/personas',
  '/api/companies/:companyId/inbox',
  '/api/companies/:companyId/decisions',
  '/api/companies/:companyId/structure',
  '/api/companies/:companyId/scorecard',
  '/api/companies/:companyId/plan',
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
  '/api/companies/:companyId/tickets/:ticketId',
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
  '/api/companies/:companyId/chat-channels',
  '/api/companies/:companyId/chats',
  '/api/companies/:companyId/chats/:chatId',
  '/api/companies/:companyId/contacts',
  '/api/companies/:companyId/contacts/:contactId',
  '/api/companies/:companyId/books',
  '/api/companies/:companyId/invoices',
  '/api/companies/:companyId/invoices/:invoiceId',
];

/** Reads left off, and why: each is the owner's, or the deployment's. */
const CORE_HIDDEN: Readonly<Record<string, string>> = {
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
  '/api/companies/:companyId/office-hours': 'the hours the company keeps for what reaches the outside are the owner\'s',
  '/api/companies/:companyId/conversation': 'the owner\'s conversation with the CEO',
  '/api/companies/:companyId/divisions/:divisionId/credentials': 'the company\'s keys',
  '/api/companies/:companyId/bundles/:slug/verify': 'what is installed is the owner\'s',
  '/api/companies/:companyId/export': 'the whole company, to take away',
  '/api/companies/:companyId/staff': 'who is seated is the owner\'s',
  '/api/companies/:companyId/files': 'the company\'s files, including what customers sent, are the owner\'s until a seat has its own items',
  '/api/companies/:companyId/files/download': 'the company\'s files, including what customers sent, are the owner\'s until a seat has its own items',
  '/api/companies/:companyId/browser': 'the company\'s browser holds its sign-ins: the owner\'s alone',
  '/api/companies/:companyId/browser/tabs/:tabId': 'a picture of a signed-in page is the owner\'s alone',
};

/** What one area of the people's workspace gives a seat, and keeps from it. */
interface AreaPolicy {
  /** Reads any seat may make. */
  readonly reads: readonly string[];
  /** Reads kept from every seat, each with why. */
  readonly hidden: Readonly<Record<string, string>>;
  /** What any seat may post: its own words, its own place in rooms, its own profile and phone. */
  readonly talks: readonly string[];
  /** What a member or an approver may also post: asking for work, and steering or stopping what it asked for. */
  readonly asks: readonly string[];
  /** What an approver may also post: deciding, and calling an agent meeting. */
  readonly decides: readonly string[];
}

// --- rooms (STATUS 2.206; the stream 2.210) ---
const ROOM_STAFF: AreaPolicy = {
  // Every room is read through the person's own transaction, which shows
  // them only the rooms they may see (0150): a seat reaching these routes
  // reads nothing the database would not show it.
  reads: [
    '/api/rooms/unread',
    '/api/companies/:companyId/people',
    '/api/companies/:companyId/rooms',
    '/api/companies/:companyId/rooms/:roomId',
    '/api/companies/:companyId/rooms/:roomId/messages',
    '/api/companies/:companyId/rooms/:roomId/threads/:messageId',
    '/api/companies/:companyId/me/activity',
    // The room stream (STATUS 2.210): each frame goes to whoever may see its room, decided by the hub per batch.
    '/api/companies/:companyId/room-stream',
  ],
  hidden: {
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/history': 'what an edit replaced is the owner\'s record',
  },
  // Talking: a seat's own words, its own place in rooms, rooms it makes.
  talks: [
    '/api/companies/:companyId/rooms',
    '/api/companies/:companyId/direct-rooms',
    '/api/companies/:companyId/rooms/:roomId',
    '/api/companies/:companyId/rooms/:roomId/archive',
    '/api/companies/:companyId/rooms/:roomId/join',
    '/api/companies/:companyId/rooms/:roomId/leave',
    '/api/companies/:companyId/rooms/:roomId/members',
    '/api/companies/:companyId/rooms/:roomId/settings',
    '/api/companies/:companyId/rooms/:roomId/read',
    '/api/companies/:companyId/rooms/:roomId/messages',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/edit',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/delete',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/react',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/pin',
    '/api/companies/:companyId/rooms/:roomId/threads/:messageId/follow',
  ],
  // The room's three doors: asking for work, and telling or stopping what it asked for.
  asks: [
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/work',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/tell',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/stop',
  ],
  decides: [],
};

// --- the conversation's money (STATUS 2.205) ---
const TALK_STAFF: AreaPolicy = {
  reads: [],
  hidden: {
    '/api/control/assistant-allowance': 'the owner\'s conversation with PALUGADA',
  },
  talks: [],
  asks: [],
  decides: [],
};

// --- relay (STATUS 2.208) ---
// A seat links its own phone through a relay that hears about its company,
// and ends its own links: its own attention, like its profile. Pairing a
// relay, what it is told and the deployment's key are the owner's.
const RELAY_STAFF: AreaPolicy = {
  reads: ['/api/relays/links'],
  hidden: {
    '/api/control/relays': 'the deployment\'s relays are the owner\'s',
  },
  talks: ['/api/relays/links', '/api/relays/links/:linkId/end'],
  asks: [],
  decides: [],
};

// --- relay, ready for a commercial relay (STATUS 2.216) ---
// A seat opens a notice its phone was sent: the link names only a handle,
// which answers what it is about to that seat alone.
const RELAY_LINKS_STAFF: AreaPolicy = {
  reads: ['/api/relays/notices/:handle'],
  hidden: {},
  talks: [],
  asks: [],
  decides: [],
};

// --- people (STATUS 2.209) ---
// Every person reads and sets their own profile, whatever their kind: their
// handle, picture, language and quiet hours. Seating people, naming them and
// changing what they may do stay the owner's, on no list.
const PEOPLE_STAFF: AreaPolicy = {
  reads: ['/api/me/profile'],
  hidden: {},
  talks: ['/api/me/profile'],
  asks: [],
  decides: [],
};

// --- agent meetings (STATUS 2.211) ---
// Calling a meeting of the company's agents about a message spends the
// company's money on a run of its CEO, so it is an approver's, counted among
// its asks. Joining a meeting, and whether the owner attends every week, are
// the owner's: on no list.
const MEETING_STAFF: AreaPolicy = {
  reads: [],
  hidden: {},
  talks: [],
  asks: [],
  decides: ['/api/companies/:companyId/rooms/:roomId/messages/:messageId/meeting'],
};

// --- find and keep (STATUS 2.212) ---
// A seat searches its own company's rooms, reads a room's files and pins,
// each through its own transaction, which shows it only the rooms it may see
// (0150). Searching every company is the owner's. Attaching a file is the
// post route's, and how long messages are kept is the owner's retention.
const FIND_STAFF: AreaPolicy = {
  reads: [
    '/api/companies/:companyId/room-search',
    '/api/companies/:companyId/rooms/:roomId/files',
    '/api/companies/:companyId/rooms/:roomId/files/:fileId',
    '/api/companies/:companyId/rooms/:roomId/pins',
  ],
  hidden: {
    '/api/room-search': "it searches every company's rooms",
  },
  talks: [],
  asks: [],
  decides: [],
};

// --- import (STATUS 2.214) ---
// An export is the whole company's history, private channels included, and
// linking an old author decides which private rooms a seat joins: the owner's.
const IMPORT_STAFF: AreaPolicy = {
  reads: [],
  hidden: {
    '/api/companies/:companyId/room-imports': "the owner's imports of an old workspace's history",
    '/api/companies/:companyId/room-imports/:importId': "the owner's import",
    '/api/companies/:companyId/former-people': "linking the old workspace's people is the owner's",
  },
  talks: [],
  asks: [],
  decides: [],
};

// --- people's meetings (STATUS 2.215) ---
// Setting a meeting of people, and moving or cancelling it, is talk: it is a
// person's own words at the top of a room, given a time and the people asked,
// and makes no work and spends nothing, so every seat may, a viewer too. Who
// may change which meeting is the handler's and the database's to say.
const MEET_STAFF: AreaPolicy = {
  reads: [],
  hidden: {},
  talks: [
    '/api/companies/:companyId/rooms/:roomId/people-meetings',
    '/api/companies/:companyId/rooms/:roomId/people-meetings/:meetingId',
  ],
  asks: [],
  decides: [],
};

// --- what people may do, and how much is kept (STATUS 2.217) ---
// How much the company's room files may take is the owner's to read and to
// set, as how long its messages are kept is. A seat that loses its phone is
// given a new authenticator by the owner, and one locked out by wrong codes
// is let in again by the owner, both on no list.
const LIMITS_STAFF: AreaPolicy = {
  reads: [],
  hidden: {
    '/api/companies/:companyId/room-files/limit': "how much the company's room files may take is the owner's",
  },
  talks: [],
  asks: [],
  decides: [],
};

// --- end of the areas ---

const AREAS: readonly AreaPolicy[] = [
  ROOM_STAFF, TALK_STAFF, RELAY_STAFF, PEOPLE_STAFF, MEETING_STAFF, FIND_STAFF, IMPORT_STAFF, MEET_STAFF, RELAY_LINKS_STAFF,
  LIMITS_STAFF,
];

/** Reads a seat may make: its own company's pages, the console's needs, and each area's. */
export const STAFF_READS: readonly string[] = [...CORE_READS, ...AREAS.flatMap((area) => area.reads)];

/** Reads left off, and why. */
export const STAFF_HIDDEN: Readonly<Record<string, string>> = Object.assign({}, CORE_HIDDEN, ...AREAS.map((area) => area.hidden));

/** What any seat may post: its own words, its own place in rooms, its own profile and phone. */
export const STAFF_TALKS: readonly string[] = AREAS.flatMap((area) => area.talks);

/**
 * What a member or an approver may also post: ask for work, steer or stop
 * what it pressed for, and answer what is put to it. Who may answer which
 * item is the inbox's to say (`answerEscalation`), whoever calls it.
 */
export const STAFF_ASKS: readonly string[] = [
  ...AREAS.flatMap((area) => area.asks),
  '/api/companies/:companyId/inbox/:itemId/answer',
];

/** What an approver may also post: decide tier 2 and below (the route checks the tier), and call an agent meeting. */
export const STAFF_DECIDES: readonly string[] = [
  '/api/companies/:companyId/inbox/:itemId/decide',
  '/api/companies/:companyId/inbox/batch',
  ...AREAS.flatMap((area) => area.decides),
];

/**
 * Where each kind stands on the ladder. A kind the ladder does not know --
 * one a later migration adds before this does -- stands nowhere, and may
 * only talk. The record is keyed by `StaffKind`, so a kind added to the type
 * without a rank here fails the type check first.
 */
const RANK: Readonly<Record<StaffKind, number>> = { viewer: 0, member: 1, approver: 2 };

/** Whether a seat may make this request: on a list its kind reaches, and about its own company when it names one. */
export function staffMay(seat: StaffSeat, method: string, pattern: string, params: Record<string, string>): boolean {
  if (params.companyId !== undefined && params.companyId !== seat.companyId) return false;
  if (method === 'GET') return STAFF_READS.includes(pattern);
  if (method !== 'POST') return false;
  if (pattern === '/api/auth/sign-out' || STAFF_TALKS.includes(pattern)) return true;
  const rank = RANK[seat.kind] ?? -1;
  if (STAFF_ASKS.includes(pattern)) return rank >= RANK.member;
  return rank >= RANK.approver && STAFF_DECIDES.includes(pattern);
}
