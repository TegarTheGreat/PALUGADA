/**
 * The relay (F19.19, F19.20): this deployment's identity, pairing a relay and
 * its settings, a person's linked phone, and what a paired relay posts back.
 *
 * A route module of the people's workspace (`../route.ts`): the relay's core
 * writes its routes here. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`.
 */
import type { Route, RouteKit } from '../route.ts';

/** Every route of the relay, and of a person's linked phone. */
export function relayRoutes(_kit: RouteKit): Route[] {
  return [];
}
