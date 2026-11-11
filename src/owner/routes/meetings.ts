/**
 * Agent meetings a person reaches from the rooms: one called about a message,
 * and the owner joining the weekly one (F19.17, F19.18; STATUS 2.211).
 *
 * A route module of the people's workspace (`../route.ts`): agent meetings in
 * rooms write their routes here. `#buildRoutes` in `../api.ts` serves them
 * beside the owner API's own, and what a staff seat may reach of them is this
 * area's block in `../staff-policy.ts`: calling a meeting is an approver's,
 * and joining one is the owner's alone. Whether the owner attends every
 * weekly meeting is the rhythm's setting, in `../api.ts` beside when the
 * meeting is held.
 */
import { PalugadaError } from '../../errors.ts';
import { joinMeeting } from '../../engine/meeting.ts';
import { callMeetingFromRoom } from '../../workspace/doors.ts';
import { messageIdOf } from '../../workspace/messages.ts';
import { principalOf } from '../../workspace/principal.ts';
import { roomIdOf } from '../../workspace/rooms.ts';
import type { Viewer } from '../../workspace/views.ts';
import type { Route, RouteContext, RouteKit } from '../route.ts';

/** Fields that would say who is calling. The session says it, as in every room route; a body that tries is refused. */
const CLAIMS = ['author', 'as', 'by', 'principal', 'via'];

/** Who is asking, in the company the path names: from the session, never the body. */
function viewerOf(context: RouteContext): Viewer {
  for (const field of CLAIMS) {
    if (field in context.body) {
      throw new PalugadaError('contract.violation',
        `${field} is not something a request says: who calls a meeting is the person signed in`, { field });
    }
  }
  return {
    companyId: String(context.params.companyId ?? '').toLowerCase(),
    person: principalOf(context.session, context.staff),
    kind: context.staff ? context.staff.seat.kind : 'owner',
    seatId: context.staff?.seat.id ?? null,
  };
}

/** A task's id as a path names it, or a refusal naming what is accepted. */
function taskIdOf(raw: string | undefined): string {
  const id = String(raw ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new PalugadaError('contract.violation', 'a meeting is named by its task\'s id', { taskId: raw ?? null });
  }
  return id;
}

/** Every route of the agent meetings reached from a room. */
export function meetingRoutes(kit: RouteKit): Route[] {
  return [
    {
      // "Call a meeting" about a message: the CEO holds a meeting of the
      // company's agents about it (F19.18). The owner's or an approver's.
      method: 'POST',
      pattern: '/api/companies/:companyId/rooms/:roomId/messages/:messageId/meeting',
      handle: async (context) => {
        const viewer = viewerOf(context);
        // Without a model the meeting would be a task no runtime can take,
        // halted and reported; refused here, before anything is held.
        if (!kit.options.holdsMeetings) {
          throw new PalugadaError('meeting.no_model', 'no model is set up, so there is no one to hold the meeting', {});
        }
        return callMeetingFromRoom(viewer, roomIdOf(context.params.roomId), messageIdOf(context.params.messageId), context.body);
      },
    },
    {
      // The owner joining one meeting (F19.17): its questions wait for them,
      // this many minutes each, from its next step on. The owner's alone:
      // on no seat's list.
      method: 'POST',
      pattern: '/api/companies/:companyId/meetings/:taskId/join',
      handle: async (context) => {
        const viewer = viewerOf(context);
        const minutes = context.body.minutes;
        if (minutes !== undefined && typeof minutes !== 'number') {
          throw new PalugadaError('contract.violation', 'minutes is a whole number from 5 to 120', { field: 'minutes' });
        }
        return joinMeeting(viewer.companyId, taskIdOf(context.params.taskId), minutes);
      },
    },
  ];
}
