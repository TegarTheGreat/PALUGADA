/**
 * The people's rooms, pressed as the console presses them (STATUS 2.206).
 *
 * The owner signs in with their phone, as everywhere; a member of staff is
 * seated straight into the database with a session of their own, because
 * the join flow is `staff.test.ts`'s to hold and these files care only about
 * what a seat does once it is signed in. The session is the real one: the
 * owner API verifies it, reads the seat's kind and name from its row on
 * every request, and holds it to the staff lists, as for a seat that joined.
 */
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { withControlPlane } from '../../src/db/tenant.ts';
import type { StaffKind } from '../../src/owner/staff.ts';
import type { Fixture } from './fixtures.ts';
import { consoleWithSettings } from './owner-console.ts';

export type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** A member of staff, joined and signed in. */
export interface Seat {
  id: string;
  /** `'seat:<id>'`, as rooms name them. */
  principal: string;
  name: string;
  kind: StaffKind;
  token: string;
}

/** Seats someone in the company and signs them in. */
export async function seated(
  fixture: Fixture, name: string, kind: StaffKind, options: { handle?: string; asksPerDay?: number } = {},
): Promise<Seat> {
  const token = randomBytes(32).toString('base64url');
  const id = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO staff_seats (company_id, name, kind, secret_ref, joined_at, handle, asks_per_day)
       VALUES ($1, $2, $3, 'db://staff-totp-test', now(), $4, $5) RETURNING id`,
      [fixture.companyId, name, kind, options.handle ?? null, options.asksPerDay ?? 20]);
    await tx.query(
      "INSERT INTO staff_sessions (token_hash, seat_id, issued_at, expires_at) VALUES ($1, $2, now(), now() + interval '8 hours')",
      [createHash('sha256').update(token).digest('hex'), rows[0]!.id]);
    return rows[0]!.id;
  });
  return { id, principal: `seat:${id}`, name, kind, token };
}

/** What a request answered: 200 and its body, or the test fails saying what it was told instead. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ok(answer: { status: number; body: any }, what = 'the request'): any {
  assert.equal(answer.status, 200, `${what}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** A refusal: the status and the code. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function refusedWith(answer: { status: number; body: any }, status: number, code: string, what = 'the request'): void {
  assert.deepEqual([answer.status, answer.body?.code], [status, code], `${what}: ${JSON.stringify(answer.body)}`);
}

/** One person's console in one company: the rooms' routes, as the page calls them. */
export function personIn(api: Console, token: string, companyId: string) {
  const at = `/api/companies/${companyId}`;
  const get = (path: string) => api.call('GET', `${at}${path}`, token);
  const post = (path: string, body: Record<string, unknown> = {}) => api.call('POST', `${at}${path}`, token, body);
  let sent = 0;
  return {
    token,
    get,
    post,
    rooms: (browse = false) => get(`/rooms${browse ? '?browse=1' : ''}`),
    room: (roomId: string) => get(`/rooms/${roomId}`),
    people: () => get('/people'),
    makeRoom: (body: Record<string, unknown>) => post('/rooms', body),
    direct: (principals: string[]) => post('/direct-rooms', { principals }),
    join: (roomId: string) => post(`/rooms/${roomId}/join`),
    leave: (roomId: string) => post(`/rooms/${roomId}/leave`),
    members: (roomId: string, body: Record<string, unknown>) => post(`/rooms/${roomId}/members`, body),
    settings: (roomId: string, body: Record<string, unknown>) => post(`/rooms/${roomId}/settings`, body),
    read: (roomId: string, body: Record<string, unknown>) => post(`/rooms/${roomId}/read`, body),
    page: (roomId: string, query = '') => get(`/rooms/${roomId}/messages${query}`),
    thread: (roomId: string, messageId: string) => get(`/rooms/${roomId}/threads/${messageId}`),
    say: (roomId: string, body: Record<string, unknown> | string) => {
      sent += 1;
      return post(`/rooms/${roomId}/messages`, typeof body === 'string'
        ? { body, clientId: `c-${sent}-${randomBytes(4).toString('hex')}` }
        : { clientId: `c-${sent}-${randomBytes(4).toString('hex')}`, ...body });
    },
    on: (roomId: string, messageId: string, verb: string, body: Record<string, unknown> = {}) =>
      post(`/rooms/${roomId}/messages/${messageId}/${verb}`, body),
    activity: () => get('/me/activity'),
  };
}

export type PersonIn = ReturnType<typeof personIn>;

/** The company room, as a person's list names it. */
export async function companyRoomOf(person: PersonIn): Promise<string> {
  const { rooms } = ok(await person.rooms());
  const found = (rooms as Array<{ id: string; kind: string }>).find((room) => room.kind === 'company');
  assert.ok(found, 'every person is in the company room');
  return found.id;
}

/** Says something and answers the message's id. */
export async function said(person: PersonIn, roomId: string, body: Record<string, unknown> | string): Promise<string> {
  return String(ok(await person.say(roomId, body), 'posting').message.id);
}
