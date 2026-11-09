/**
 * Every read of the owner API is put on one list or the other for a staff
 * seat (src/owner/staff-policy.ts), so a route added tomorrow is a decision
 * somebody made rather than one nobody did.
 *
 * Nothing is reachable by a seat unless it is listed: a route on neither list
 * is refused to staff anyway. What this holds is the other half -- that the
 * lists name real routes, that no read is on both, and that every read was
 * looked at and either given to staff or kept from them with a reason.
 *
 * And what a seat may post is a ladder (F19.2): any seat talks, a member also
 * asks for work, an approver also decides. Each POST a seat may make is on
 * exactly one of those three lists, and each list is held to its shape here,
 * so a set that adds a route cannot widen what a seat does by putting it on
 * the wrong one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_ASKS, STAFF_DECIDES, STAFF_HIDDEN, STAFF_READS, STAFF_TALKS, staffMay } from '../../src/owner/staff-policy.ts';
import type { StaffSeat } from '../../src/owner/staff.ts';
import { routeSource } from '../helpers/route-sources.ts';

async function routes(): Promise<Array<{ method: string; pattern: string; open: boolean }>> {
  const source = await routeSource();
  return [...source.matchAll(/method: '(GET|POST)',\s*\n\s*pattern: '([^']+)',(\s*\n\s*open: true)?/g)]
    .map((match) => ({ method: match[1]!, pattern: match[2]!, open: Boolean(match[3]) }));
}

async function posts(): Promise<Set<string>> {
  return new Set((await routes()).filter((route) => route.method === 'POST').map((route) => route.pattern));
}

test('every read of the owner API is given to staff or kept from them, with a reason', async () => {
  const all = await routes();
  assert.ok(all.length > 150, `only ${all.length} routes were found; the scan is broken`);
  const reads = all.filter((route) => route.method === 'GET' && !route.open).map((route) => route.pattern);
  const unlisted = reads.filter((pattern) => !STAFF_READS.includes(pattern) && !(pattern in STAFF_HIDDEN));
  assert.deepEqual(unlisted, [], `reads no list names: put each on STAFF_READS or STAFF_HIDDEN (src/owner/staff-policy.ts)`);
  const both = STAFF_READS.filter((pattern) => pattern in STAFF_HIDDEN);
  assert.deepEqual(both, [], 'a read is given and kept at once');
  const gets = new Set(all.filter((route) => route.method === 'GET').map((route) => route.pattern));
  assert.deepEqual([...STAFF_READS, ...Object.keys(STAFF_HIDDEN)].filter((pattern) => !gets.has(pattern)), [], 'the lists name only real reads');
});

test('a seat is given nothing of the deployment, its devices or its keys', () => {
  const owners = STAFF_READS.filter((pattern) =>
    /^\/api\/(control\/(settings|channels|tools|mcp|vendors|agents|setup|tour|cost)|mfa|publishers|erasures|search|runtimes|assistant)/.test(pattern)
    || /credentials|export|conversation|\/staff$/.test(pattern));
  assert.deepEqual(owners, []);
});

test('every POST a seat may make is on exactly one list: talk, ask or decide; and each is a real route', async () => {
  const real = await posts();
  const lists: Record<string, readonly string[]> = { talk: STAFF_TALKS, ask: STAFF_ASKS, decide: STAFF_DECIDES };
  for (const [name, list] of Object.entries(lists)) {
    assert.equal(new Set(list).size, list.length, `the ${name} list names a route twice`);
  }
  const every = [...new Set([...STAFF_TALKS, ...STAFF_ASKS, ...STAFF_DECIDES])];
  assert.ok(every.length >= 3, `only ${every.length} actions are listed; the lists are broken`);
  const twice = every.filter((pattern) => Object.values(lists).filter((list) => list.includes(pattern)).length > 1);
  assert.deepEqual(twice, [], 'a POST on two lists: a seat would reach it at the lower of the two');
  assert.deepEqual(every.filter((pattern) => !real.has(pattern)), [], 'the lists name only real actions');
});

test('a seat talks only in rooms, about itself, and to its own phone', () => {
  const elsewhere = STAFF_TALKS.filter((pattern) =>
    !/^\/api\/(companies\/:companyId\/(rooms|direct-rooms)(\/|$)|me\/|relays\/links(\/|$))/.test(pattern));
  assert.deepEqual(elsewhere, [], 'what any seat may post is its own words, its own place in rooms, its own profile and phone');
});

/**
 * Asking for work is the one thing a member does beyond talking, and it goes
 * through the room's doors (F19.8), never the owner's: not `/assign`, which
 * files work as the owner's own, and not `/instruct`, which steers any task.
 * The room's doors arrive with the rooms' server; until they do, the list holds
 * the ones that exist, and a door added later is on it or this fails.
 */
test('what a member may ask for is a list written here', async () => {
  const askable = [
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/work',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/tell',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/stop',
    '/api/companies/:companyId/inbox/:itemId/answer',
  ];
  const real = await posts();
  assert.deepEqual([...STAFF_ASKS].sort(), askable.filter((pattern) => real.has(pattern)).sort());
  assert.ok(STAFF_ASKS.includes('/api/companies/:companyId/inbox/:itemId/answer'), 'a member answers what is put to it');
  assert.deepEqual(STAFF_ASKS.filter((pattern) => pattern.endsWith('/assign') || pattern.endsWith('/instruct')), []);
});

/**
 * Deciding is an approver's alone, and so is calling an agent meeting from a
 * room, which spends the company's money (F19.17). The meeting's route
 * arrives with the agent meetings (section 2.211); from then on it must be
 * here, and nowhere lower: on the talk list the room's shape would let any
 * viewer call one.
 */
test("an approver's decisions are the inbox's and a meeting's alone", async () => {
  const decidable = [
    '/api/companies/:companyId/inbox/:itemId/decide',
    '/api/companies/:companyId/inbox/batch',
    '/api/companies/:companyId/rooms/:roomId/messages/:messageId/meeting',
  ];
  const real = await posts();
  assert.ok(real.has(decidable[0]!) && real.has(decidable[1]!), "the inbox's decisions are routes; the scan is broken");
  assert.deepEqual([...STAFF_DECIDES].sort(), decidable.filter((pattern) => real.has(pattern)).sort());
});

/** A seat as the database hands it to `staffMay`: its kind is the row's, read when the session was verified. */
function seat(kind: string, companyId = '00000000-0000-4000-8000-000000000001'): StaffSeat {
  return { id: '00000000-0000-4000-8000-0000000000aa', companyId, name: 'Siti Rahayu', kind } as StaffSeat;
}

test("a seat's kind is a ladder: a viewer talks, a member also asks, an approver also decides", () => {
  const params = { companyId: '00000000-0000-4000-8000-000000000001' };
  const answer = '/api/companies/:companyId/inbox/:itemId/answer';
  const decide = '/api/companies/:companyId/inbox/:itemId/decide';
  const may = (kind: string, pattern: string) => staffMay(seat(kind), 'POST', pattern, params);
  for (const kind of ['viewer', 'member', 'approver']) {
    assert.equal(staffMay(seat(kind), 'POST', '/api/auth/sign-out', {}), true, `${kind} signs out`);
    for (const pattern of STAFF_TALKS) assert.equal(may(kind, pattern), true, `${kind} talks: ${pattern}`);
  }
  assert.deepEqual([may('viewer', answer), may('member', answer), may('approver', answer)], [false, true, true]);
  assert.deepEqual([may('viewer', decide), may('member', decide), may('approver', decide)], [false, false, true]);
  // Nothing of another company, whatever the kind, and nothing the lists do not name.
  assert.equal(staffMay(seat('approver', '00000000-0000-4000-8000-000000000002'), 'POST', decide, params), false);
  assert.equal(may('approver', '/api/companies/:companyId/assign'), false);
  assert.equal(staffMay(seat('approver'), 'DELETE', decide, params), false);
  assert.equal(staffMay(seat('somebody'), 'POST', answer, params), false, 'a kind the ladder does not know asks for nothing');
});
