/**
 * How much a company's rooms keep (F19.4; STATUS section 2.217): what its
 * room files take, and the limit the owner sets on them.
 *
 * A route module of the people's workspace (`../route.ts`). `#buildRoutes`
 * in `../api.ts` serves these beside the owner API's own; both are the
 * owner's, kept from every seat in this area's block of
 * `../staff-policy.ts`. They answer a number of bytes and nothing of any
 * file or message.
 */
import { PalugadaError } from '../../errors.ts';
import { roomFilesLimit, setRoomFilesLimit } from '../../workspace/files.ts';
import type { Route, RouteContext, RouteKit } from '../route.ts';

/** The owner's alone: a seat is refused by the staff lists, and again here. */
function theOwner(context: RouteContext): void {
  if (context.staff) throw new PalugadaError('staff.forbidden', 'how much the company keeps is the owner\'s to set', {});
}

/** The routes of the room files' limit; the kit is the module form every route module takes, and these need nothing of it. */
export function limitRoutes(_kit: RouteKit): Route[] {
  return [
    {
      // What the company's room files take now, and the limit, in megabytes.
      method: 'GET',
      pattern: '/api/companies/:companyId/room-files/limit',
      handle: async (context) => {
        theOwner(context);
        return roomFilesLimit(context.params.companyId!);
      },
    },
    {
      // `{megabytes}`: a whole number from one to a terabyte's worth.
      method: 'POST',
      pattern: '/api/companies/:companyId/room-files/limit',
      handle: async (context) => {
        theOwner(context);
        return setRoomFilesLimit(context.params.companyId!, context.body.megabytes);
      },
    },
  ];
}
