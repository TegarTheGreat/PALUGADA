/**
 * A person's own profile -- handle, picture, language, quiet hours -- and the
 * owner's seating and naming of people (F19.2, F19.22).
 *
 * A route module of the people's workspace (`../route.ts`): the people's set
 * writes its routes here. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`.
 */
import type { Route, RouteKit } from '../route.ts';

/** Every route of a person's profile, and of seating and naming people. */
export function peopleRoutes(_kit: RouteKit): Route[] {
  return [];
}
