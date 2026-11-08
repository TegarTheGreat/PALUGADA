/**
 * The rooms (F19.1, F19.3 to F19.8, F19.10): listing and making them, their
 * members and each person's place in them, their messages and threads, the
 * doors a message becomes work through, and a person's own attention.
 *
 * A route module of the people's workspace (`../route.ts`): the rooms' server
 * writes its routes here, and the live stream, a room's files and people's
 * meetings add theirs. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`.
 */
import type { Route, RouteKit } from '../route.ts';

/** Every route of the rooms. */
export function roomRoutes(_kit: RouteKit): Route[] {
  return [];
}
