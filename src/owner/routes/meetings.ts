/**
 * Agent meetings a person reaches from the rooms: one called about a message,
 * and the owner joining the weekly one (F19.17, F19.18).
 *
 * A route module of the people's workspace (`../route.ts`): agent meetings in
 * rooms write their routes here. `#buildRoutes` in `../api.ts` serves them
 * beside the owner API's own, and what a staff seat may reach of them is this
 * area's block in `../staff-policy.ts`.
 */
import type { Route, RouteKit } from '../route.ts';

/** Every route of the agent meetings reached from a room. */
export function meetingRoutes(_kit: RouteKit): Route[] {
  return [];
}
