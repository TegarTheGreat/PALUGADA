/**
 * Finding what was said (F19.4, F19.14): a company's room search, the owner's
 * search across companies, and a room's files.
 *
 * A route module of the people's workspace (`../route.ts`): find-and-keep
 * writes its routes here. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`.
 */
import type { Route, RouteKit } from '../route.ts';

/** Every route of searching the rooms and reading their files. */
export function findRoutes(_kit: RouteKit): Route[] {
  return [];
}
