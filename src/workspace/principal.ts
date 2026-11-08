/**
 * Who a person is in a company's rooms (F19.2; the workspace plan, §5.1).
 *
 * A person is the owner or a staff seat the owner made, never an agent, a
 * role or a name. They are named by a principal, which is text rather than a
 * row: `'owner'`, or `'seat:<uuid>'` for a seat. There is no owner row that
 * could ever become a second owner (NG3), and a seat's id is already a bare
 * uuid wherever a record names it, so a record outlives the seat it names.
 * The database holds the same rule (`app.is_person`, 0149).
 *
 * A principal is made here from a verified session and from nothing else: a
 * body field that says who is writing is never read, so nobody writes in
 * another's name. And nothing made here reaches the assistant: inside its
 * dispatch, `principalOf` refuses, as the people's database helpers do.
 */
import { assistantDispatch, withControlPlane, type Person } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { OwnerSession } from '../owner/session.ts';
import type { StaffSession } from '../owner/staff.ts';

/** The owner, or a seat. */
export type Principal = 'owner' | `seat:${string}`;

const SEAT = /^seat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Whether `value` names a person: the owner or a seat, as `app.is_person` says it. */
export function isPerson(value: unknown): value is Principal {
  return value === 'owner' || (typeof value === 'string' && SEAT.test(value));
}

/**
 * The person a request is, from its verified session: a staff seat's with
 * the name the owner gave it, read from the seat when the session was
 * verified, or the owner's. Refused inside the assistant's dispatch, and for
 * a request that is nobody's.
 */
export function principalOf(session: OwnerSession | null, staff: StaffSession | null): Person {
  if (assistantDispatch.getStore() !== undefined) {
    throw new PalugadaError('staff.forbidden', "the assistant does not read or write people's words", {});
  }
  if (staff) {
    if (session) {
      // A request is the owner's or a seat's, never both: one that claimed to
      // be both would be a defect in how sessions are read.
      throw new PalugadaError('contract.violation', 'a request is made by the owner or by a seat, not both', {});
    }
    return { principal: `seat:${staff.seat.id}`, name: staff.seat.name };
  }
  if (session) return { principal: 'owner', name: null };
  throw new PalugadaError('owner.unauthenticated', 'sign in first: a room is read and written by a person', {});
}

/** The seat a principal names, or null for the owner; anything else is not a person. */
export function seatOf(principal: string): string | null {
  if (principal === 'owner') return null;
  const seat = SEAT.exec(principal);
  if (!seat) {
    throw new PalugadaError('contract.violation',
      `a person is the owner or a seat ('owner' or 'seat:<id>'), not ${JSON.stringify(principal)}`, { principal });
  }
  return seat[1]!;
}

/**
 * Every principal is one of the company's people: the owner, or a seat of
 * this company that has joined and is not revoked. Asked of everyone added to
 * a room or mentioned in one, on the control plane, because a seat's row is
 * the control plane's alone (0110): no tenant query, not even a trigger, can
 * read it. Refused naming each that is not.
 */
export async function assertPeopleOf(companyId: string, principals: readonly string[]): Promise<void> {
  const notPeople = principals.filter((principal) => !isPerson(principal));
  const seats = [...new Set(principals.filter(isPerson).map(seatOf).filter((seat): seat is string => seat !== null))];
  let found = new Set<string>();
  if (seats.length > 0) {
    const { rows } = await withControlPlane((tx) => tx.query<{ id: string }>(
      `SELECT id FROM staff_seats
        WHERE company_id = $1 AND id = ANY($2::uuid[]) AND joined_at IS NOT NULL AND revoked_at IS NULL`,
      [companyId, seats]));
    found = new Set(rows.map((row) => row.id));
  }
  const strangers = [
    ...notPeople,
    ...principals.filter((principal) => isPerson(principal) && principal !== 'owner' && !found.has(seatOf(principal)!)),
  ];
  if (strangers.length > 0) {
    throw new PalugadaError('contract.violation',
      `only the owner and the company's seated, joined people are its people: ${strangers.join(', ')} ${strangers.length === 1 ? 'is' : 'are'} not`,
      { notPeople: strangers });
  }
}
