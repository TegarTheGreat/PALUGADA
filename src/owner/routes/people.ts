/**
 * A person's own profile -- handle, picture, language, quiet hours -- and the
 * owner's seating and naming of people (F19.2, F19.8, F19.21, F19.22; STATUS
 * 2.209).
 *
 * A route module of the people's workspace (`../route.ts`). `#buildRoutes`
 * in `../api.ts` serves these beside the owner API's own, and what a staff
 * seat may reach of them is this area's block in `../staff-policy.ts`: any
 * person reads and sets their own profile; seating several people, renaming
 * one and changing what one may do are the owner's.
 *
 * Who a request is comes from its session (`principalOf`), never from its
 * body, and the profile routes refuse inside the assistant's dispatch as the
 * rest of the workspace does: a person's quiet hours are not a model's to read.
 */
import { PalugadaError } from '../../errors.ts';
import { principalOf } from '../../workspace/principal.ts';
import { changeSettings, settingsChange, settingsOf } from '../profile.ts';
import type { Route, RouteContext, RouteKit } from '../route.ts';
import {
  SEAT_LADDER, STAFF_BATCH_MOST, asksPerDayOf, handleOf, kindOf, nameShape, pictureOf, seatRequest, type StaffKind,
} from '../staff.ts';

/**
 * Fields that would say who is writing. A person is who their session says;
 * a body that claims otherwise is a mistake or an attempt, and is refused
 * rather than ignored, so neither goes unnoticed.
 */
const WHO_WRITES = ['author', 'as', 'by', 'principal', 'via'] as const;

function refuseWhoWrites(body: Record<string, unknown>): void {
  const claimed = WHO_WRITES.find((field) => body[field] !== undefined);
  if (claimed) {
    throw new PalugadaError('contract.violation', `who is writing is read from the session, never from ${claimed}`, { field: claimed });
  }
}

/** A seat named in a path, in the spelling its streams are filed under. */
function seatIdOf(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new PalugadaError('contract.violation', `a seat is named by its id, a uuid, not ${JSON.stringify(value)}`, { seatId: value });
  }
  return value.toLowerCase();
}

/**
 * A person's profile as they read it: the name the owner gave them, the
 * handle and picture they chose, and their settings. The owner has no name,
 * handle or picture of their own (they are drawn as the owner), and is the
 * only one shown whether people reach them outside the inbox.
 */
async function profileOf(kit: RouteKit, context: RouteContext): Promise<Record<string, unknown>> {
  const person = principalOf(context.session, context.staff);
  const { ownerHearsPeople, ...settings } = await settingsOf(person.principal);
  if (context.staff) {
    const { seat } = context.staff;
    return { principal: person.principal, name: seat.name, kind: seat.kind, ...await kit.staff.chosen(seat.id), ...settings };
  }
  return { principal: person.principal, name: null, handle: null, picture: null, ...settings, ownerHearsPeople };
}

/** Every route of a person's profile, and of seating and naming people. */
export function peopleRoutes(kit: RouteKit): Route[] {
  return [
    {
      // Anyone signed in reads their own.
      method: 'GET',
      pattern: '/api/me/profile',
      handle: async (context) => profileOf(kit, context),
    },

    {
      // Anyone signed in sets their own: a seat its handle and picture, and
      // everyone their settings. Nobody sets their own name; the owner sets
      // every seat's, and has none of their own.
      method: 'POST',
      pattern: '/api/me/profile',
      handle: async (context) => {
        const { body, staff } = context;
        refuseWhoWrites(body);
        const person = principalOf(context.session, staff);
        if (body.name !== undefined) {
          if (staff) throw new PalugadaError('name.owner_sets', 'the owner sets names: ask them to change yours', { field: 'name' });
          throw new PalugadaError('contract.violation', 'the owner is drawn as the owner, with no name of their own', { field: 'name' });
        }
        if (!staff && (body.handle !== undefined || body.picture !== undefined)) {
          throw new PalugadaError('contract.violation', 'the owner has no handle or picture of their own: the owner is drawn as the owner',
            { field: body.handle !== undefined ? 'handle' : 'picture' });
        }
        if (staff && body.ownerHearsPeople !== undefined) {
          throw new PalugadaError('staff.forbidden', 'only the owner chooses whether people reach them outside the inbox', {});
        }
        const chosen: { handle?: string; picture?: string | null } = {};
        if (body.handle !== undefined) chosen.handle = handleOf(body.handle);
        if (body.picture !== undefined) chosen.picture = pictureOf(body.picture);
        // Every field is checked before anything is written.
        const change = settingsChange(body);
        if (staff && Object.keys(chosen).length > 0) await kit.staff.choose(staff.seat, chosen);
        await changeSettings(person.principal, staff ? staff.seat.companyId : null, change);
        return profileOf(kit, context);
      },
    },

    {
      // Several people seated with one proof, each given an invite of their
      // own: a team moving in (F19.22). All or none, and every name checked
      // before the owner is asked for their code.
      method: 'POST',
      pattern: '/api/companies/:companyId/staff-batch',
      handle: async (context) => {
        const { params, body } = context;
        refuseWhoWrites(body);
        if (!Array.isArray(body.people) || body.people.length < 1 || body.people.length > STAFF_BATCH_MOST) {
          throw new PalugadaError('contract.violation', `people is a list of 1 to ${STAFF_BATCH_MOST} people, each a name and a kind`,
            { field: 'people' });
        }
        // A refusal says which of the list it is about, so the owner changes one line of thirty.
        const people = (body.people as unknown[]).map((one, index) => {
          try {
            return seatRequest(one !== null && typeof one === 'object' ? one as Record<string, unknown> : {});
          } catch (error) {
            if (!(error instanceof PalugadaError)) throw error;
            throw new PalugadaError(error.code, `number ${index + 1} of the list: ${error.message}`, { ...error.details, index });
          }
        });
        await kit.staff.vetNames(params.companyId!, people.map((one) => one.name));
        await kit.requireFactor(context, `seat ${people.length} people`, true);
        return { seats: await kit.staff.createMany(params.companyId!, people) };
      },
    },

    {
      // The owner renames a seat, or changes its kind or its asks a day.
      // What lets the person do more takes the owner's code now, as seating
      // them did; what lets them do less, and a rename, takes the session.
      // A kind changed holds at once, since every request reads the seat's
      // kind afresh, and it ends the streams the seat holds open, so nothing
      // it had open goes on as the kind it was. Its console, told by the
      // end of its stream, reads who it is again and draws the controls of
      // its new kind (STATUS 2.209, 2.210).
      method: 'POST',
      pattern: '/api/companies/:companyId/staff/:seatId/change',
      handle: async (context) => {
        const { params, body } = context;
        refuseWhoWrites(body);
        const companyId = params.companyId!;
        const seatId = seatIdOf(params.seatId!);
        const change: { name?: string; kind?: StaffKind; asksPerDay?: number } = {};
        if (body.name !== undefined) change.name = nameShape(body.name);
        if (body.kind !== undefined) change.kind = kindOf(body.kind);
        if (body.asksPerDay !== undefined) change.asksPerDay = asksPerDayOf(body.asksPerDay);
        if (Object.keys(change).length === 0) {
          throw new PalugadaError('contract.violation', 'give a name, a kind, asksPerDay, or several', {});
        }
        const was = await kit.staff.seat(companyId, seatId);
        if (!was) throw new PalugadaError('contract.violation', 'no such seat in this company, or it is ended', { seatId });
        if (change.name !== undefined) await kit.staff.vetNames(companyId, [change.name], seatId);
        const widens = (change.kind !== undefined && SEAT_LADDER[change.kind] > SEAT_LADDER[was.kind])
          || (change.asksPerDay !== undefined && change.asksPerDay > was.asksPerDay);
        if (widens) await kit.requireFactor(context, `let ${was.name} do more`, true);
        const seat = await kit.staff.change(companyId, seatId, change);
        if (seat.kind !== was.kind) {
          // Here and in every other process: a console whose stream ends reads who it is again (STATUS 2.210).
          kit.streams.endPrincipal(`seat:${seat.id}`);
          await kit.hub?.ended({ principal: `seat:${seat.id}` });
        }
        return { seat };
      },
    },
  ];
}
