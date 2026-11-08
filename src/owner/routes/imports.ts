/**
 * Bringing a Slack workspace's history in, and linking the people it came
 * with to seats (F19.23).
 *
 * A route module of the people's workspace (`../route.ts`): the Slack import
 * writes its routes here. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`.
 */
import type { Route, RouteKit } from '../route.ts';

/** Every route of importing rooms and linking the people they came with. */
export function importRoutes(_kit: RouteKit): Route[] {
  return [];
}
