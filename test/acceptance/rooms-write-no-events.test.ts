/**
 * Room activity is never an event (STATUS section 2.206; AGENTS.md).
 *
 * The journal of a company's work is read by every seat, through a task's
 * events and the activity feed, and by the context builder, which tells runs
 * what happened. People's words -- even a private room's name, or that one
 * exists -- must not be in it. So what people do in rooms writes no `events`
 * row: only a door that turns a message into work does, and it names no
 * private room (room-doors.test.ts).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { companyRoomOf, ok, personIn, said, seated } from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('a post, an edit, a reaction, a pin, a join, a read mark and a new room write no events row', async () => {
  const fixture = await createCompany('rooms-no-events');
  const api = await consoleWithSettings();
  try {
    const owner = personIn(api, await api.signIn(), fixture.companyId);
    const seat = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const budi = personIn(api, seat.token, fixture.companyId);
    const counted = async () => Number((await withControlPlane((tx) => tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM events WHERE company_id = $1', [fixture.companyId]))).rows[0]!.n);
    const before = await counted();

    const room = await companyRoomOf(owner);
    const message = await said(owner, room, { body: 'Morning @budi.', mentions: [seat.principal] });
    ok(await owner.on(room, message, 'edit', { body: 'Good morning @budi.' }));
    await companyRoomOf(budi);
    ok(await budi.on(room, message, 'react', { emoji: '👋', on: true }));
    ok(await owner.on(room, message, 'pin', { on: true }));
    const made = String(ok(await budi.makeRoom({ name: 'Garden', private: false })).room.id);
    ok(await owner.join(made));
    const secret = String(ok(await owner.makeRoom({ name: 'Board', private: true, members: [seat.principal] })).room.id);
    await said(budi, secret, 'Private words.');
    ok(await owner.direct([seat.principal]));
    const page = ok(await owner.page(room)).messages as Array<{ position: number }>;
    ok(await owner.read(room, { position: Math.max(...page.map((one) => one.position)) }));
    ok(await owner.settings(room, { notify: 'all' }));
    ok(await budi.post(`/rooms/${room}/threads/${message}/follow`, { on: false }));
    await said(budi, room, { body: 'Morning!', threadOf: message });
    ok(await owner.on(room, message, 'delete'));
    ok(await budi.leave(made));

    assert.equal(await counted(), before, 'people talking leaves nothing in the journal of the work');
  } finally {
    await api.close();
  }
});
