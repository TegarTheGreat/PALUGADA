/**
 * The rooms (F19.1, F19.3 to F19.8, F19.10): listing and making them, their
 * members and each person's place in them, their messages and threads, the
 * doors a message becomes work through, and a person's own attention.
 *
 * A route module of the people's workspace (`../route.ts`): the rooms' server
 * writes its routes here, and the live stream (served by the hub in
 * `../../workspace/hub.ts`), a room's files and people's meetings (the last
 * two routes) add theirs. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`, and people's meetings' block beside it.
 *
 * Who a request is comes from its session alone (`principalOf`): a body that
 * names an author is refused rather than read, so nobody writes in another's
 * name by trying. And every read here is closed to the assistant, by prefix
 * (`UNREADABLE_UNDER`) and by the people's helpers, which refuse inside its
 * dispatch.
 */
import { PalugadaError } from '../../errors.ts';
import { giveAsWork, stopWork, tellTheWork } from '../../workspace/doors.ts';
import {
  deleteMessage, editMessage, follow, historyOf, messageIdOf, messagePage, pin, postMessage, react, threadView,
} from '../../workspace/messages.ts';
import { changePeopleMeeting, setPeopleMeeting } from '../../workspace/people-meetings.ts';
import { principalOf } from '../../workspace/principal.ts';
import { activityOf, markRead, readEverything, unreadAcross } from '../../workspace/reads.ts';
import {
  archiveRoom, changeMembers, changeRoom, joinRoom, leaveRoom, listRooms, makeTopicRoom, openDirectRoom, peopleOf,
  placeSettings, roomIdOf, roomOf,
} from '../../workspace/rooms.ts';
import type { Viewer } from '../../workspace/views.ts';
import type { Route, RouteContext, RouteKit } from '../route.ts';

/** Fields that would say who is writing. The session says it; a body that tries is refused, naming the field. */
const CLAIMS = ['author', 'as', 'by', 'principal', 'via'];

function refuseClaims(body: Record<string, unknown>): void {
  for (const field of CLAIMS) {
    if (field in body) {
      throw new PalugadaError('contract.violation',
        `${field} is not something a request says: who writes is the person signed in, and where from is where they are`, { field });
    }
  }
}

/** Who is asking, in the company the path names: from the session, never the body. */
export function viewerOf(context: RouteContext): Viewer {
  return {
    companyId: String(context.params.companyId ?? '').toLowerCase(),
    person: principalOf(context.session, context.staff),
    kind: context.staff ? context.staff.seat.kind : 'owner',
    seatId: context.staff?.seat.id ?? null,
  };
}

/** A POST of this module: the body's claims refused, then the handler, as the person. */
function posted(handle: (viewer: Viewer, context: RouteContext) => Promise<unknown>): Route['handle'] {
  return async (context) => {
    refuseClaims(context.body);
    return handle(viewerOf(context), context);
  };
}

/**
 * The largest post: a message's words and its five files, 24 MB together,
 * which travel in base64, four bytes for every three (STATUS 2.212).
 */
const POST_MAX_BYTES = 33 * 1024 * 1024;

/** Every route of the rooms. */
export function roomRoutes(kit: RouteKit): Route[] {
  // Where a company's room files are kept, asked only of a request that carries or removes some.
  const folderOf = (viewer: Viewer) => kit.peopleFilesRoot(viewer.companyId);
  return [
    {
      // What waits in each company the person may see: the badge's numbers.
      method: 'GET',
      pattern: '/api/rooms/unread',
      handle: async ({ session, staff }) => ({
        unread: await unreadAcross({
          companyId: staff?.seat.companyId ?? null,
          person: principalOf(session, staff),
          kind: staff ? staff.seat.kind : 'owner',
          seatId: staff?.seat.id ?? null,
        }),
      }),
    },
    {
      // The company's people, for the mention picker and a new conversation.
      // The owner's chat is the deployment's Telegram, which carries the
      // owner's people's notices beside a phone.
      method: 'GET',
      pattern: '/api/companies/:companyId/people',
      handle: async (context) => ({ people: await peopleOf(viewerOf(context), { ownerChat: kit.options.telegram !== undefined }) }),
    },
    {
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms',
      handle: async (context) => ({ rooms: await listRooms(viewerOf(context), { browse: context.query.get('browse') === '1' }) }),
    },
    {
      // A topic room, open or private.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms',
      handle: posted(async (viewer, { body }) => ({ room: await makeTopicRoom(viewer, body) })),
    },
    {
      // The conversation of exactly these people, found or opened.
      method: 'POST',
      pattern: '/api/companies/:companyId/direct-rooms',
      handle: posted(async (viewer, { body }) => openDirectRoom(viewer, body)),
    },
    {
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms/:roomId',
      handle: async (context) => ({ room: await roomOf(viewerOf(context), roomIdOf(context.params.roomId)) }),
    },
    {
      // Its name, what it is about, and which work it shows.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId',
      handle: posted(async (viewer, { params, body }) => ({ room: await changeRoom(viewer, roomIdOf(params.roomId), body) })),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/archive',
      handle: posted(async (viewer, { params }) => ({ room: await archiveRoom(viewer, roomIdOf(params.roomId)) })),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/join',
      handle: posted(async (viewer, { params }) => ({ room: await joinRoom(viewer, roomIdOf(params.roomId)) })),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/leave',
      handle: posted(async (viewer, { params }) => {
        await leaveRoom(viewer, roomIdOf(params.roomId));
        return { left: true };
      }),
    },
    {
      // Who is in a private room: added by a member, removed by its creator, an admin or the owner.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/members',
      handle: posted(async (viewer, { params, body }) => ({ room: await changeMembers(viewer, roomIdOf(params.roomId), body) })),
    },
    {
      // The person's own place: how loudly the room tells them things, and until when it is quiet.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/settings',
      handle: posted(async (viewer, { params, body }) => placeSettings(viewer, roomIdOf(params.roomId), body)),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/read',
      handle: posted(async (viewer, { params, body }) => markRead(viewer, roomIdOf(params.roomId), body)),
    },
    {
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages',
      handle: async (context) => messagePage(viewerOf(context), roomIdOf(context.params.roomId), context.query),
    },
    {
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms/:roomId/threads/:messageId',
      handle: async (context) => threadView(viewerOf(context), roomIdOf(context.params.roomId), messageIdOf(context.params.messageId)),
    },
    {
      // Words, and up to five files as `{ name, data }` with the bytes in base64.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages',
      maxBodyBytes: POST_MAX_BYTES,
      handle: posted(async (viewer, { params, body }) => postMessage(viewer, roomIdOf(params.roomId), body, {
        peopleFolder: body.files === undefined || body.files === null ? null : folderOf(viewer),
      })),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/edit',
      // New words, and whom they name now (STATUS 2.218): the people kept, and those not, with why.
      handle: posted(async (viewer, { params, body }) => editMessage(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId), body)),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/delete',
      handle: posted(async (viewer, { params }) => ({
        message: await deleteMessage(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId), { peopleFolder: folderOf(viewer) }),
      })),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/react',
      handle: posted(async (viewer, { params, body }) => ({
        reactions: await react(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId), body),
      })),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/pin',
      handle: posted(async (viewer, { params, body }) => ({
        pins: await pin(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId), body),
      })),
    },
    {
      // What an edit replaced: the owner's record.
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/history',
      handle: async (context) => ({
        revisions: await historyOf(viewerOf(context), roomIdOf(context.params.roomId), messageIdOf(context.params.messageId)),
      }),
    },
    {
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/threads/:messageId/follow',
      handle: posted(async (viewer, { params, body }) => ({
        following: await follow(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId), body),
      })),
    },
    {
      // What asks for the person's attention, newest first.
      method: 'GET',
      pattern: '/api/companies/:companyId/me/activity',
      handle: async (context) => ({ items: await activityOf(viewerOf(context)) }),
    },
    {
      // Everything that waits for the person read at once: their own marks and mentions (STATUS 2.218).
      method: 'POST',
      pattern: '/api/companies/:companyId/me/read-all',
      handle: posted(async (viewer) => readEverything(viewer)),
    },
    {
      // "Give as work": the message becomes a task, its money held first.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/work',
      handle: posted(async (viewer, { params, body }) => giveAsWork(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId), body)),
    },
    {
      // "Tell the work": a reply in the work's thread becomes an instruction to it.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/tell',
      handle: posted(async (viewer, { params }) => tellTheWork(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId))),
    },
    {
      // The work a message asked for, stopped by whoever pressed for it, or the owner.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/stop',
      handle: posted(async (viewer, { params }) => stopWork(viewer, roomIdOf(params.roomId), messageIdOf(params.messageId))),
    },
    {
      // The person's live view of the company (F19.11, STATUS 2.210): what
      // changed in the rooms they may see, as positions and ids and never a
      // word, and the company's work as /live tells it, on one stream per tab.
      // `Last-Event-ID` is the position the console last heard.
      method: 'GET',
      pattern: '/api/companies/:companyId/room-stream',
      handle: async (context) => {
        const viewer = viewerOf(context);
        const last = context.request.headers['last-event-id'];
        return kit.hub.stream({
          companyId: viewer.companyId,
          person: viewer.person,
          kind: viewer.kind,
          token: (context.staff?.token ?? context.session?.token)!,
          lastEventId: typeof last === 'string' ? last : null,
        });
      },
    },
    {
      // A people's meeting (F19.26, STATUS 2.215): the setter's own message,
      // at the top of the room, becomes a meeting with a time, a length, the
      // people asked and a pasted call link. Not work: no task, no run, no event.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/people-meetings',
      handle: posted(async (viewer, { params, body }) => ({ meeting: await setPeopleMeeting(viewer, roomIdOf(params.roomId), body) })),
    },
    {
      // Moved, changed or cancelled, by whoever set it or the owner.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/people-meetings/:meetingId',
      handle: posted(async (viewer, { params, body }) => ({
        meeting: await changePeopleMeeting(viewer, roomIdOf(params.roomId), params.meetingId, body),
      })),
    },
  ];
}
