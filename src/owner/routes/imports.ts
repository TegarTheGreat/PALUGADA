/**
 * Bringing a Slack workspace's history in, and linking the people it came
 * with to seats (F19.23; STATUS section 2.214).
 *
 * A route module of the people's workspace (`../route.ts`): the Slack import
 * writes its routes here. `#buildRoutes` in `../api.ts` serves them beside the
 * owner API's own, and what a staff seat may reach of them is this area's
 * block in `../staff-policy.ts`: nothing. An export is the whole company's
 * history, private channels included, and who an old author becomes decides
 * which private rooms a seat joins, so every route is the owner's alone.
 *
 * The export is uploaded in parts of up to 16 MB, in order, and kept until it
 * is read in the company's people folder, which no agent capability reaches;
 * the worker reads it (`readImports`). Every route runs on the control plane,
 * and none is readable by the owner's assistant (`UNREADABLE_UNDER`); each
 * makes its person from the session too, which refuses inside the
 * assistant's dispatch whatever its address.
 */
import { PalugadaError } from '../../errors.ts';
import {
  formerPeopleOf, importOf, importsOf, linkFormer, PART_BYTES, receivePart, startImport, unlinkFormer,
} from '../../workspace/import-slack.ts';
import { holdToMinute } from '../../workspace/limits.ts';
import { principalOf } from '../../workspace/principal.ts';
import type { Route, RouteContext, RouteKit } from '../route.ts';

/**
 * The owner, from the session: a seat is kept from these routes by the staff
 * lists already, and refused here again, so a list changed by mistake gives
 * no seat the company's history.
 */
function theOwner(context: RouteContext): void {
  const person = principalOf(context.session, context.staff);
  if (person.principal !== 'owner') {
    throw new PalugadaError('staff.forbidden', "bringing a workspace's history in, and linking its people, is the owner's", {});
  }
  const claimed = ['author', 'as', 'by', 'principal', 'via'].find((field) => context.body[field] !== undefined);
  if (claimed) {
    throw new PalugadaError('contract.violation', `who is writing is read from the session, never from ${claimed}`, { field: claimed });
  }
}

/** Every route of importing rooms and linking the people they came with. */
export function importRoutes(kit: RouteKit): Route[] {
  return [
    {
      // An import begun: `{source: 'slack', parts}`.
      method: 'POST',
      pattern: '/api/companies/:companyId/room-imports',
      handle: async (context) => {
        theOwner(context);
        const companyId = context.params.companyId!;
        holdToMinute({ companyId, person: { principal: 'owner' } }, 'import');
        return { import: await startImport(companyId, kit.peopleFilesRoot(companyId), context.body) };
      },
    },
    {
      // The company's latest imports, for the report of the last one.
      method: 'GET',
      pattern: '/api/companies/:companyId/room-imports',
      handle: async (context) => {
        theOwner(context);
        return { imports: await importsOf(context.params.companyId!) };
      },
    },
    {
      // One part, in order: `{index, base64}`, 16 MB at most, which is about 22 MB of base64.
      method: 'POST',
      pattern: '/api/companies/:companyId/room-imports/:importId/parts',
      maxBodyBytes: Math.ceil(PART_BYTES / 3) * 4 + 64 * 1024,
      handle: async (context) => {
        theOwner(context);
        const companyId = context.params.companyId!;
        return { import: await receivePart(companyId, kit.peopleFilesRoot(companyId), context.params.importId, context.body) };
      },
    },
    {
      // One import: how far its parts have come, then what reading it found.
      method: 'GET',
      pattern: '/api/companies/:companyId/room-imports/:importId',
      handle: async (context) => {
        theOwner(context);
        return { import: await importOf(context.params.companyId!, context.params.importId) };
      },
    },
    {
      // The authors imports brought, and the seats they are linked to.
      method: 'GET',
      pattern: '/api/companies/:companyId/former-people',
      handle: async (context) => {
        theOwner(context);
        return { people: await formerPeopleOf(context.params.companyId!) };
      },
    },
    {
      // `{former, seatId, confirm?}`: without confirm, the private rooms the
      // seat would gain, which the owner is shown first; with it, the link.
      method: 'POST',
      pattern: '/api/companies/:companyId/former-people/link',
      handle: async (context) => {
        theOwner(context);
        holdToMinute({ companyId: context.params.companyId!, person: { principal: 'owner' } }, 'import');
        return linkFormer(context.params.companyId!, context.body);
      },
    },
    {
      // `{former}`: the link undone, and the private rooms it gave taken back.
      method: 'POST',
      pattern: '/api/companies/:companyId/former-people/unlink',
      handle: async (context) => {
        theOwner(context);
        holdToMinute({ companyId: context.params.companyId!, person: { principal: 'owner' } }, 'import');
        return unlinkFormer(context.params.companyId!, context.body);
      },
    },
  ];
}
