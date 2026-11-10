/**
 * Finding what was said (F19.4, F19.14; STATUS section 2.212): a company's
 * room search, the owner's search across companies, a room's files and its
 * pinned messages.
 *
 * A route module of the people's workspace (`../route.ts`): find-and-keep
 * writes its routes here. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`.
 *
 * Every one of them reads people's words, so every one runs as the person
 * asking (`withPeople`), and none is readable by the owner's assistant
 * (`UNREADABLE_UNDER`). `/api/search`, which the assistant may read, is
 * not one of them and never carries a message.
 */
import { PalugadaError } from '../../errors.ts';
import { readRoomFile } from '../../workspace/files.ts';
import { roomIdOf } from '../../workspace/rooms.ts';
import { pinnedIn, searchEveryCompany, searchRooms } from '../../workspace/search.ts';
import type { Route, RouteKit } from '../route.ts';
import { viewerOf } from './rooms.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A file's id from a path, or nothing anyone has. */
function fileIdOf(value: string | undefined): string {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new PalugadaError('contract.violation', 'that is not a file of this room', { fileId: value ?? null });
  return id;
}

/** Every route of searching the rooms and reading their files. */
export function findRoutes(kit: RouteKit): Route[] {
  return [
    {
      // A company's rooms, as the person may see them: `?q=&room=&from=&files=1&before=`.
      method: 'GET',
      pattern: '/api/companies/:companyId/room-search',
      handle: async (context) => searchRooms(viewerOf(context), context.query),
    },
    {
      // Every company's, for the owner alone: each searched as the owner, so a
      // conversation between two seats is never the owner's to find.
      method: 'GET',
      pattern: '/api/room-search',
      handle: async ({ staff, query }) => {
        if (staff) throw new PalugadaError('staff.forbidden', "searching every company's rooms is the owner's", {});
        return { found: await searchEveryCompany(query) };
      },
    },
    {
      // One file of a room: its bytes in base64 inside JSON, never a page the
      // browser could open from this origin, and `inline` only for a small picture.
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms/:roomId/files/:fileId',
      handle: async (context) => {
        const viewer = viewerOf(context);
        const roomId = roomIdOf(context.params.roomId);
        const fileId = fileIdOf(context.params.fileId);
        return readRoomFile(viewer, roomId, fileId, kit.peopleFilesRoot(viewer.companyId));
      },
    },
    {
      // What a room keeps at hand, with what each says: the room's details list them.
      method: 'GET',
      pattern: '/api/companies/:companyId/rooms/:roomId/pins',
      handle: async (context) => ({ messages: await pinnedIn(viewerOf(context), roomIdOf(context.params.roomId)) }),
    },
  ];
}
