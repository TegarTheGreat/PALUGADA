/**
 * What the owner's conversations may spend: the allowance PALUGADA's own
 * assistant is held to each month (F19.12).
 *
 * A route module of the people's workspace (`../route.ts`): the conversation's
 * money writes its routes here. `#buildRoutes` in `../api.ts` serves them
 * beside the owner API's own, and what a staff seat may reach of them is this
 * area's block in `../staff-policy.ts`.
 *
 * A company's CEO is paid for from the company's own accounts, which the
 * Money page sets; PALUGADA's assistant belongs to no company, so its
 * allowance is the deployment's, set under This deployment, Model.
 */
import type { Route, RouteKit } from '../route.ts';
import { assistantAllowance, setAssistantAllowance } from '../conversation-money.ts';

/** Every route of what the owner's conversations may spend. */
export function talkRoutes(kit: RouteKit): Route[] {
  return [
    {
      // What PALUGADA's own conversation may spend this month, and what it has.
      method: 'GET',
      pattern: '/api/control/assistant-allowance',
      handle: async () => assistantAllowance(),
    },

    {
      // The allowance, changed. Raising it loosens a control and takes the
      // owner's factor, as raising a company's ceiling does; lowering it, or
      // switching the conversation off with 0, is the session's.
      method: 'POST',
      pattern: '/api/control/assistant-allowance',
      handle: async (context) => {
        await setAssistantAllowance(context.body.monthCents, async (before, after) => {
          if (after > before) await kit.requireFactor(context, 'raise what PALUGADA\'s own conversation may spend');
        });
        return assistantAllowance();
      },
    },
  ];
}
