/**
 * People's meetings (F19.26; STATUS section 2.215).
 *
 * Anyone who may write in a room sets a meeting there for people who can see
 * it: a time, a length, the people asked and a call link pasted in. Its title
 * and agenda are the setter's own message, and its thread is the notes. The
 * people asked are reminded ten minutes before it starts, once, through the
 * people's notices, and only while they can still see the room; a cancelled
 * meeting reminds nobody. It is not work: it reaches no run, makes no task and
 * writes no event, and the server never fetches its link.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withPeople, withTenant } from '../../src/db/tenant.ts';
import { collectExport, exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { dispatchPeopleNotices, planNotices } from '../../src/owner/member-notify.ts';
import { purgeExpiredMessages } from '../../src/retention/retention.ts';
import { syncRoomCards } from '../../src/workspace/cards.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { fakeRelay, type FakeRelay, type FakeRelayOptions } from '../helpers/fake-relay.ts';
import { linkFor, noticesOf, tell, toldTo } from '../helpers/notices.ts';
import { linkThrough, opens, pairThrough, sendOutbox, type Linked } from '../helpers/relay.ts';
import {
  companyRoomOf, ok, personIn, refusedWith, said, seated, type Console, type PersonIn,
} from '../helpers/rooms.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const MINUTE = 60_000;
/** A time this many minutes from now, as the console sends it. */
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();

/** Sets a meeting from a message, as the console's form does once the message is kept. */
const setMeeting = (person: PersonIn, roomId: string, body: Record<string, unknown>) => person.post(`/rooms/${roomId}/people-meetings`, body);
/** Changes or cancels one. */
const changeMeeting = (person: PersonIn, roomId: string, meetingId: string, body: Record<string, unknown>) =>
  person.post(`/rooms/${roomId}/people-meetings/${meetingId}`, body);

interface MeetingView {
  id: string; startsAt: string; minutes: number; callUrl: string | null; cancelled: boolean;
  attendees: Array<{ principal: string; name: string | null }>; setBy: { principal: string };
  cancelledBy: { principal: string } | null; may: { change: boolean };
}

/** The meeting a message of a room carries, as a person's page of the room draws it. */
async function meetingOn(person: PersonIn, roomId: string, messageId: string): Promise<MeetingView | null> {
  const page = ok(await person.page(roomId)).messages as Array<{ id: string; peopleMeeting: MeetingView | null }>;
  const found = page.find((one) => one.id === messageId);
  assert.ok(found, 'the message is on the page');
  return found.peopleMeeting;
}

/** The meetings' rows of a company, read on the control plane. */
async function meetingRows(companyId: string) {
  return withControlPlane(async (tx) => (await tx.query<{
    id: string; room_id: string; message_id: string; starts_at: Date; minutes: number; attendees: string[]; call_url: string | null;
    set_by: string; reminded_at: Date | null; cancelled_at: Date | null; cancelled_by: string | null;
  }>(
    `SELECT id, room_id, message_id, starts_at, minutes, attendees::text[] AS attendees, call_url, set_by, reminded_at,
            cancelled_at, cancelled_by
       FROM room_meetings WHERE company_id = $1 ORDER BY starts_at, id`, [companyId])).rows);
}

/** The reminders the rooms' sweep wrote, in the meetings' threads. */
async function remindersIn(companyId: string) {
  return withControlPlane(async (tx) => (await tx.query<{ thread_of: string; notice_values: Record<string, unknown> }>(
    `SELECT thread_of, notice_values FROM room_messages
      WHERE company_id = $1 AND kind = 'notice' AND notice_code = 'meeting_soon' ORDER BY position`, [companyId])).rows);
}

/** How much of the company's work exists: none of it a meeting may make. */
async function workCounted(companyId: string) {
  return withControlPlane(async (tx) => (await tx.query<{ tasks: number; events: number; runs: number; items: number }>(
    `SELECT (SELECT count(*) FROM tasks WHERE company_id = $1)::int AS tasks,
            (SELECT count(*) FROM events WHERE company_id = $1)::int AS events,
            (SELECT count(*) FROM agent_runs WHERE company_id = $1)::int AS runs,
            (SELECT count(*) FROM inbox_items WHERE company_id = $1)::int AS items`, [companyId])).rows[0]!);
}

interface Workspace {
  fixture: Fixture;
  api: Console;
  owner: PersonIn;
  relay: FakeRelay | null;
  relayId: string | null;
  close: () => Promise<void>;
}

/** A company and the owner's console; with a relay paired for it when asked, at the share asked, answering as asked. */
async function workspace(
  slug: string, options: { relay?: 'signal' | 'summary' | 'content'; answer?: FakeRelayOptions['answer'] } = {},
): Promise<Workspace> {
  const fixture = await createCompany(slug);
  const api = await consoleWithSettings();
  const ownerToken = await api.signIn();
  const relay = options.relay ? await fakeRelay(options.answer ? { answer: options.answer } : {}) : null;
  const relayId = relay ? await pairThrough(api, ownerToken, relay, { companies: [fixture.companyId], share: options.relay! }) : null;
  return {
    fixture, api, owner: personIn(api, ownerToken, fixture.companyId), relay, relayId,
    close: async () => {
      await api.close();
      await relay?.close();
    },
  };
}

/** A member of staff, signed in, in the company room, with a phone linked through the workspace's relay when there is one. */
async function person(w: Workspace, name: string, kind: 'viewer' | 'member' | 'approver' = 'member') {
  const seat = await seated(w.fixture, name, kind, { handle: name.toLowerCase() });
  const in_ = personIn(w.api, seat.token, w.fixture.companyId);
  await companyRoomOf(in_);
  const phone = w.relay && w.relayId
    ? await linkThrough(w.api, seat.token, w.relay, w.relayId, { device: true, owner: false })
    : null;
  return { seat, in: in_, phone };
}

/** What a relay was told about meetings, for one person. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const remindedOf = (relay: FakeRelay, linked: Linked): any[] => toldTo(relay, linked).filter((one) => one.type === 'meeting_soon');

test('a meeting is set in a room, for people who can see it, from the setter\'s own message', async () => {
  const w = await workspace('meet-set');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari', 'viewer');
    const room = await companyRoomOf(w.owner);
    const agenda = await said(budi.in, room, 'Stock check: what we count, and what we order.');
    const startsAt = inMinutes(120);

    const set = ok(await setMeeting(budi.in, room, {
      messageId: agenda, startsAt, minutes: 30, attendees: ['owner', budi.seat.principal, sari.seat.principal],
      callUrl: 'https://meet.example/stock-check',
    }), 'setting a meeting').meeting as MeetingView;
    assert.equal(set.startsAt, startsAt);
    assert.equal(set.minutes, 30);
    assert.equal(set.callUrl, 'https://meet.example/stock-check');
    assert.deepEqual(set.attendees.map((one) => one.principal), ['owner', budi.seat.principal, sari.seat.principal]);
    assert.equal(set.setBy.principal, budi.seat.principal);
    assert.deepEqual([set.cancelled, set.cancelledBy, set.may.change], [false, null, true]);

    // The message carries it, for everyone who reads the room; the setter and the owner may change it.
    const seenBySari = await meetingOn(sari.in, room, agenda);
    assert.equal(seenBySari?.id, set.id);
    assert.equal(seenBySari?.may.change, false, 'only the setter and the owner change a meeting');
    assert.equal((await meetingOn(w.owner, room, agenda))?.may.change, true);
    // Its words are the message's: the row holds none but the link.
    const [row] = await meetingRows(w.fixture.companyId);
    assert.deepEqual([row!.message_id, row!.set_by, row!.reminded_at, row!.cancelled_at], [agenda, budi.seat.principal, null, null]);

    // Pressed again, it is the same meeting.
    const again = ok(await setMeeting(budi.in, room, {
      messageId: agenda, startsAt, minutes: 30, attendees: ['owner', budi.seat.principal, sari.seat.principal],
    })).meeting as MeetingView;
    assert.equal(again.id, set.id);
    assert.equal((await meetingRows(w.fixture.companyId)).length, 1);

    // A viewer sets one too: every seat talks, and a meeting is talk.
    const sariSays = await said(sari.in, room, 'Coffee on Friday?');
    ok(await setMeeting(sari.in, room, { messageId: sariSays, startsAt: inMinutes(60 * 24), minutes: 15, attendees: [sari.seat.principal, 'owner'] }));

    // Only from one's own words, at the top of a room, in the future, for the company's people, for 5 to 480 minutes.
    const base = { startsAt: inMinutes(90), minutes: 30, attendees: ['owner'] };
    refusedWith(await setMeeting(w.owner, room, { ...base, messageId: agenda }), 403, 'message.not_yours', 'another person\'s words');
    const reply = await said(budi.in, room, { body: 'Bring the counts.', threadOf: agenda });
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: reply }), 400, 'contract.violation', 'a reply: the thread is the notes');
    const later = await said(budi.in, room, 'And the van schedule.');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, startsAt: inMinutes(-5) }), 400, 'people_meeting.past');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, startsAt: 'next tuesday' }), 400, 'contract.violation');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, minutes: 4 }), 400, 'contract.violation');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, minutes: 481 }), 400, 'contract.violation');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, attendees: [] }), 400, 'contract.violation');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, attendees: ['role:writer'] }), 400, 'contract.violation');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, attendees: ['seat:00000000-0000-4000-8000-000000000000'] }),
      400, 'contract.violation', 'a seat of no company');
    refusedWith(await setMeeting(budi.in, room, { ...base, messageId: later, by: 'owner' }), 400, 'contract.violation',
      'who sets it is the session, never the body');

    // Changing it is the setter's and the owner's; a cancelled meeting is cancelled for good.
    const moved = inMinutes(180);
    assert.equal((ok(await changeMeeting(budi.in, room, set.id, { startsAt: moved })).meeting as MeetingView).startsAt, moved);
    refusedWith(await changeMeeting(sari.in, room, set.id, { minutes: 45 }), 403, 'message.not_yours');
    assert.equal((ok(await changeMeeting(w.owner, room, set.id, { minutes: 45, callUrl: null })).meeting as MeetingView).callUrl, null);
    refusedWith(await changeMeeting(budi.in, room, set.id, { startsAt: inMinutes(-1) }), 400, 'people_meeting.past');
    const cancelled = ok(await changeMeeting(w.owner, room, set.id, { cancel: true })).meeting as MeetingView;
    assert.deepEqual([cancelled.cancelled, cancelled.cancelledBy?.principal, cancelled.may.change], [true, 'owner', false]);
    refusedWith(await changeMeeting(budi.in, room, set.id, { minutes: 60 }), 400, 'contract.violation', 'a cancelled meeting');

    // The database holds the same: a meeting is set as the session's own, from the session's own words.
    await assert.rejects(withPeople(w.fixture.companyId, { principal: sari.seat.principal, name: 'Sari' }, (tx) => tx.query(
      `INSERT INTO room_meetings (company_id, room_id, message_id, starts_at, minutes, attendees, set_by)
       VALUES ($1, $2, $3, now() + interval '1 day', 30, ARRAY['owner'], $4)`,
      [w.fixture.companyId, room, later, sari.seat.principal])), /row-level security/, 'nobody sets a meeting on another\'s words');
    const forced = await withPeople(w.fixture.companyId, { principal: budi.seat.principal, name: 'Budi' }, async (tx) => {
      await tx.query(
        `INSERT INTO room_meetings (company_id, room_id, message_id, starts_at, minutes, attendees, set_by, reminded_at)
         VALUES ($1, $2, $3, now() + interval '1 day', 30, ARRAY['owner'], $4, now())`,
        [w.fixture.companyId, room, later, budi.seat.principal]);
      return (await tx.query<{ reminded_at: Date | null }>('SELECT reminded_at FROM room_meetings WHERE message_id = $1', [later])).rows[0]!;
    });
    assert.equal(forced.reminded_at, null, 'a meeting is set unreminded, whatever its insert says');
  } finally {
    await w.close();
  }
});

test('someone outside a private room cannot be asked to its meeting', async () => {
  const w = await workspace('meet-private');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const kiki = await person(w, 'Kiki');
    const ops = String(ok(await budi.in.makeRoom({ name: 'Ops', private: true, members: [sari.seat.principal] })).room.id);
    const agenda = await said(budi.in, ops, 'Rota for next week.');
    const base = { messageId: agenda, startsAt: inMinutes(120), minutes: 30 };

    refusedWith(await setMeeting(budi.in, ops, { ...base, attendees: [budi.seat.principal, kiki.seat.principal] }),
      400, 'people_meeting.cannot_see', 'Kiki is not in the room');
    // The owner sees every private topic room, and may be asked.
    const set = ok(await setMeeting(budi.in, ops, { ...base, attendees: [budi.seat.principal, sari.seat.principal, 'owner'] })).meeting as MeetingView;
    refusedWith(await changeMeeting(budi.in, ops, set.id, { attendees: [budi.seat.principal, kiki.seat.principal] }),
      400, 'people_meeting.cannot_see', 'nor added later');
    // Kiki reads nothing of it.
    refusedWith(await kiki.in.page(ops), 404, 'room.not_visible');

    // A direct conversation's people are its own: the owner is not one of them here.
    const dm = String(ok(await budi.in.direct([sari.seat.principal])).room.id);
    const between = await said(budi.in, dm, 'Shall we talk about the rota?');
    refusedWith(await setMeeting(budi.in, dm, { messageId: between, startsAt: inMinutes(60), minutes: 15, attendees: [sari.seat.principal, 'owner'] }),
      400, 'people_meeting.cannot_see');
    ok(await setMeeting(budi.in, dm, { messageId: between, startsAt: inMinutes(60), minutes: 15, attendees: [sari.seat.principal, budi.seat.principal] }));

    // The database holds the same, whatever a handler forgets.
    await assert.rejects(withPeople(w.fixture.companyId, { principal: budi.seat.principal, name: 'Budi' }, (tx) => tx.query(
      'UPDATE room_meetings SET attendees = $2 WHERE id = $1', [set.id, [budi.seat.principal, kiki.seat.principal]])),
    /must be able to see the room/);
    assert.deepEqual((await meetingRows(w.fixture.companyId)).find((row) => row.id === set.id)!.attendees,
      [budi.seat.principal, sari.seat.principal, 'owner']);
  } finally {
    await w.close();
  }
});

test('the people asked are reminded ten minutes before, once, and only while they can see the room', async () => {
  const w = await workspace('meet-remind', { relay: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const kiki = await person(w, 'Kiki');
    const dewi = await person(w, 'Dewi');
    const eko = await person(w, 'Eko');
    const fajar = await person(w, 'Fajar');
    const ops = String(ok(await budi.in.makeRoom({
      name: 'Ops', private: true,
      members: [sari.seat.principal, kiki.seat.principal, dewi.seat.principal, eko.seat.principal, fajar.seat.principal],
    })).room.id);
    const soonWords = await said(budi.in, ops, 'Rota check before the lunch rush.');
    const laterWords = await said(budi.in, ops, 'Supplier call.');
    const soon = ok(await setMeeting(budi.in, ops, {
      messageId: soonWords, startsAt: inMinutes(8), minutes: 20,
      attendees: [budi.seat.principal, sari.seat.principal, kiki.seat.principal, dewi.seat.principal, eko.seat.principal],
      callUrl: 'https://meet.example/rota',
    })).meeting as MeetingView;
    ok(await setMeeting(budi.in, ops, { messageId: laterWords, startsAt: inMinutes(30), minutes: 20, attendees: [sari.seat.principal] }));
    // Fajar follows the meeting's thread, its notes, without being asked to it.
    await said(fajar.in, ops, { body: 'I will bring last week\'s rota.', threadOf: soonWords });
    // Kiki leaves the room before the reminder: she is told nothing of it.
    ok(await budi.in.members(ops, { remove: [kiki.seat.principal] }));
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(remindedOf(w.relay!, sari.phone!), [], 'nothing is said before the sweep reminds');

    await syncRoomCards(w.fixture.companyId);
    const reminders = await remindersIn(w.fixture.companyId);
    assert.deepEqual(reminders.map((one) => one.thread_of), [soonWords], 'the meeting ten minutes away, in its own thread; not the one half an hour away');
    assert.equal(reminders[0]!.notice_values.startsAt, soon.startsAt);
    assert.ok((await meetingRows(w.fixture.companyId)).find((row) => row.id === soon.id)!.reminded_at);

    // Dewi is taken out of the room after the reminder is planned and before it goes, and Eko is taken off the
    // people asked: neither is told anything. Kiki and Dewi stay on the list, which keeps whoever was asked.
    const now = new Date();
    await planNotices(w.fixture.companyId, { now });
    assert.deepEqual((await noticesOf(w.fixture.companyId, kiki.seat.principal)).filter((row) => row.reason === 'meeting'), [],
      'nothing is planned for someone who left the room');
    ok(await budi.in.members(ops, { remove: [dewi.seat.principal] }));
    ok(await changeMeeting(budi.in, ops, soon.id, {
      attendees: [budi.seat.principal, sari.seat.principal, kiki.seat.principal, dewi.seat.principal],
    }));
    await dispatchPeopleNotices(w.fixture.companyId, { now, linkFor });
    await sendOutbox(w.api.master, now);

    for (const [who, phone, token] of [['Budi', budi.phone!, budi.seat.token], ['Sari', sari.phone!, sari.seat.token]] as const) {
      const told = remindedOf(w.relay!, phone);
      assert.equal(told.length, 1, `${who} is reminded once`);
      assert.equal(told[0].urgency, 'normal');
      assert.equal(told[0].text.split('\n')[0], 'A meeting starts in ten minutes in Ops.');
      assert.deepEqual([told[0].data.room, told[0].data.startsAt, told[0].data.minutes], ['Ops', soon.startsAt, 20]);
      assert.equal(told[0].data.title, 'Rota check before the lunch rush.', 'at content, the setter\'s words');
      assert.deepEqual(told[0].offers ?? [], [], 'a reminder offers nothing to press');
      assert.equal((await opens(w.api, token, told[0].link)).body.threadOf, soonWords, 'it opens the meeting\'s thread, its notes');
    }
    assert.deepEqual(remindedOf(w.relay!, kiki.phone!), [], 'Kiki left the room before it was planned');
    assert.deepEqual(remindedOf(w.relay!, dewi.phone!), [], 'Dewi left before it went');
    assert.deepEqual((await noticesOf(w.fixture.companyId, dewi.seat.principal)).map((row) => [row.reason, row.settled_as]), [['meeting', 'gone']]);
    assert.deepEqual(remindedOf(w.relay!, eko.phone!), [], 'Eko was no longer asked when it went');
    assert.deepEqual((await noticesOf(w.fixture.companyId, eko.seat.principal)).map((row) => [row.reason, row.settled_as]), [['meeting', 'gone']]);
    assert.deepEqual(remindedOf(w.relay!, fajar.phone!), [], 'following the notes is not being asked');

    // Activity says it, for those asked who can see the room; the badge counts it.
    type Item = { kind: string; roomId: string; threadOf: string | null };
    const activity = ok(await sari.in.activity()).items as Item[];
    assert.deepEqual(activity.filter((item) => item.kind === 'meeting').map((item) => [item.roomId, item.threadOf]), [[ops, soonWords]]);
    assert.deepEqual((ok(await kiki.in.activity()).items as Item[]).filter((item) => item.kind === 'meeting'), []);
    // Budi, who set it, follows its thread and is asked: a meeting. Fajar follows it and is not: a reply in a
    // thread he follows, as every reply there is.
    assert.ok((ok(await budi.in.activity()).items as Item[]).some((item) => item.kind === 'meeting' && item.threadOf === soonWords));
    assert.deepEqual((ok(await fajar.in.activity()).items as Item[]).filter((item) => item.threadOf === soonWords).map((item) => item.kind),
      ['reply'], 'a follower who was not asked is not told a meeting starts');

    // Once: another sweep and another pass say nothing more.
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    assert.equal((await remindersIn(w.fixture.companyId)).length, 1);
    assert.equal(remindedOf(w.relay!, sari.phone!).length, 1);

    // Moved to another time, it is a new reminder, for the new time.
    const moved = inMinutes(9);
    ok(await changeMeeting(budi.in, ops, soon.id, { startsAt: moved }));
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(remindedOf(w.relay!, sari.phone!).map((one) => one.data.startsAt), [soon.startsAt, moved]);
  } finally {
    await w.close();
  }
});

test('a reminder still owed when the owner narrows the relay goes at the new share, without its title', async () => {
  // What the owner narrowed a relay to is what it is sent from then on,
  // including a reminder it was owed and has not had (STATUS 2.213).
  let down = true;
  const w = await workspace('meet-narrow', {
    relay: 'content', answer: (one) => (down && one.envelope?.type === 'meeting_soon' ? { status: 503 } : undefined),
  });
  try {
    const budi = await person(w, 'Budi');
    const room = await companyRoomOf(w.owner);
    const words = await said(budi.in, room, 'Pay day: the safe code is 5150.');
    ok(await setMeeting(budi.in, room, { messageId: words, startsAt: inMinutes(7), minutes: 15, attendees: [budi.seat.principal] }));
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    const [tried] = remindedOf(w.relay!, budi.phone!);
    assert.match(String(tried.data.title), /5150/, 'at content the title went, and the relay refused it');
    ok(await w.api.call('POST', `/api/control/relays/${w.relayId}/settings`, w.owner.token, { share: 'signal' }));
    down = false;
    await sendOutbox(w.api.master, new Date(Date.now() + 2 * MINUTE));
    const sent = remindedOf(w.relay!, budi.phone!).at(-1);
    assert.equal(sent.id, tried.id, 'the same envelope, made again');
    assert.equal(sent.share, 'signal');
    assert.equal(sent.text, 'A meeting starts in ten minutes.');
    assert.deepEqual(sent.data, {}, 'neither the room, nor the time, nor the title');
  } finally {
    await w.close();
  }
});

test('a cancelled meeting reminds nobody', async () => {
  const w = await workspace('meet-cancel', { relay: 'summary' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    const everyone = [budi.seat.principal, sari.seat.principal];

    // Cancelled before its reminder: the sweep passes it by.
    const first = await said(budi.in, room, 'Quick sync.');
    const early = ok(await setMeeting(budi.in, room, {
      messageId: first, startsAt: inMinutes(7), minutes: 10, attendees: everyone, callUrl: 'https://meet.example/sync?pwd=early',
    })).meeting as MeetingView;
    ok(await changeMeeting(budi.in, room, early.id, { cancel: true }));
    // Cancelled once its reminder is planned, before it goes: it never goes.
    const second = await said(budi.in, room, 'Inventory.');
    const late = ok(await setMeeting(budi.in, room, { messageId: second, startsAt: inMinutes(6), minutes: 10, attendees: everyone })).meeting as MeetingView;
    // Its words removed: nobody is reminded of a meeting nothing names.
    const third = await said(budi.in, room, 'Deliveries.');
    ok(await setMeeting(budi.in, room, {
      messageId: third, startsAt: inMinutes(5), minutes: 10, attendees: everyone, callUrl: 'https://meet.example/vans?pwd=s3cret',
    }));
    ok(await budi.in.on(room, third, 'delete'));

    await syncRoomCards(w.fixture.companyId);
    assert.deepEqual((await remindersIn(w.fixture.companyId)).map((one) => one.thread_of), [second], 'only the meeting still on is reminded');
    const now = new Date();
    await planNotices(w.fixture.companyId, { now });
    ok(await changeMeeting(w.owner, room, late.id, { cancel: true }));
    await dispatchPeopleNotices(w.fixture.companyId, { now, linkFor });
    await sendOutbox(w.api.master, now);
    await tell(w.fixture.companyId, w.api.master);

    assert.deepEqual(remindedOf(w.relay!, sari.phone!), []);
    assert.deepEqual(remindedOf(w.relay!, budi.phone!), []);
    for (const who of [budi, sari]) {
      assert.deepEqual((await noticesOf(w.fixture.companyId, who.seat.principal)).filter((row) => row.reason === 'meeting')
        .map((row) => row.settled_as), ['gone']);
    }
    const drawn = await meetingOn(sari.in, room, first);
    assert.deepEqual([drawn?.cancelled, drawn?.cancelledBy?.principal], [true, budi.seat.principal], 'drawn as cancelled, by whom');
    assert.equal(await meetingOn(sari.in, room, third), null, 'a removed message carries no meeting');
    const gone = (await meetingRows(w.fixture.companyId)).find((row) => row.message_id === third)!;
    assert.deepEqual([gone.cancelled_by, gone.call_url], [budi.seat.principal, null],
      'its meeting was cancelled with its words, by whoever removed them, and its pasted link went with them');

    // A meeting cancelled before its words were removed keeps who cancelled it, and loses its link all the same.
    ok(await w.owner.on(room, first, 'delete'));
    const earlier = (await meetingRows(w.fixture.companyId)).find((row) => row.message_id === first)!;
    assert.deepEqual([earlier.cancelled_by, earlier.call_url], [budi.seat.principal, null]);
  } finally {
    await w.close();
  }
});

test('a meeting moved again and again reminds its people twice at most', async () => {
  // Moving a meeting reminds its people again for its new time, once. Moving
  // it more gives them no third reminder, so nobody who may set a meeting --
  // a viewer too -- can spend the people asked's daily notices for them.
  const w = await workspace('meet-moves', { relay: 'content' });
  try {
    const vera = await person(w, 'Vera', 'viewer');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    const words = await said(vera.in, room, 'A quick word.');
    const set = ok(await setMeeting(vera.in, room, {
      messageId: words, startsAt: inMinutes(9), minutes: 5, attendees: [sari.seat.principal],
    })).meeting as MeetingView;
    for (const minutes of [8, 7, 6, 5]) {
      await syncRoomCards(w.fixture.companyId);
      await tell(w.fixture.companyId, w.api.master);
      ok(await changeMeeting(vera.in, room, set.id, { startsAt: inMinutes(minutes) }));
    }
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);

    assert.equal((await remindersIn(w.fixture.companyId)).length, 2, 'two reminders in its thread');
    assert.equal(remindedOf(w.relay!, sari.phone!).length, 2, 'two to her phone');
    assert.deepEqual((await noticesOf(w.fixture.companyId, sari.seat.principal)).filter((row) => row.reason === 'meeting')
      .map((row) => row.settled_as), ['sent', 'sent']);
    const items = ok(await sari.in.activity()).items as Array<{ kind: string }>;
    assert.equal(items.filter((item) => item.kind === 'meeting').length, 2, 'two in her Activity');
    // Vera set it, so she follows its thread, and is not asked: its reminders are replies in a thread she follows.
    const hers = ok(await vera.in.activity()).items as Array<{ kind: string; threadOf: string | null }>;
    assert.deepEqual(hers.filter((item) => item.threadOf === words).map((item) => item.kind), ['reply', 'reply']);
  } finally {
    await w.close();
  }
});

test('a reminder for a time the meeting moved from is never sent', async () => {
  const w = await workspace('meet-moved-from', { relay: 'summary' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    const only = [sari.seat.principal];

    // Moved after its reminder was planned, before it went: what was planned is gone.
    const count = await said(budi.in, room, 'Stock count.');
    const first = ok(await setMeeting(budi.in, room, { messageId: count, startsAt: inMinutes(9), minutes: 15, attendees: only })).meeting as MeetingView;
    await syncRoomCards(w.fixture.companyId);
    let now = new Date();
    await planNotices(w.fixture.companyId, { now });
    ok(await changeMeeting(budi.in, room, first.id, { startsAt: inMinutes(30) }));
    await dispatchPeopleNotices(w.fixture.companyId, { now, linkFor });
    // Brought nearer, reminded again, and moved an hour away before that went: an hour away is not ten minutes.
    ok(await changeMeeting(budi.in, room, first.id, { startsAt: inMinutes(8) }));
    await syncRoomCards(w.fixture.companyId);
    now = new Date();
    await planNotices(w.fixture.companyId, { now });
    ok(await changeMeeting(budi.in, room, first.id, { startsAt: inMinutes(60) }));
    await dispatchPeopleNotices(w.fixture.companyId, { now, linkFor });
    await sendOutbox(w.api.master, now);
    assert.deepEqual(remindedOf(w.relay!, sari.phone!), []);

    // Reminded twice, then moved an hour away before the notify stage reached it: it is not planned at all.
    const vans = await said(budi.in, room, 'Van schedule.');
    const second = ok(await setMeeting(budi.in, room, { messageId: vans, startsAt: inMinutes(9), minutes: 15, attendees: only })).meeting as MeetingView;
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    ok(await changeMeeting(budi.in, room, second.id, { startsAt: inMinutes(8) }));
    await syncRoomCards(w.fixture.companyId);
    ok(await changeMeeting(budi.in, room, second.id, { startsAt: inMinutes(60) }));
    await tell(w.fixture.companyId, w.api.master);
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);

    assert.equal(remindedOf(w.relay!, sari.phone!).length, 1, 'the van schedule\'s first reminder, and nothing for a time it moved from');
    assert.deepEqual((await noticesOf(w.fixture.companyId, sari.seat.principal)).filter((row) => row.reason === 'meeting')
      .map((row) => row.settled_as), ['gone', 'gone', 'sent']);
  } finally {
    await w.close();
  }
});

test('a meeting keeps whoever was asked when their seat goes, and adds only the company\'s people', async () => {
  const w = await workspace('meet-revoked');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const kiki = await person(w, 'Kiki');
    const room = await companyRoomOf(w.owner);
    const words = await said(budi.in, room, 'Planning the week.');
    const set = ok(await setMeeting(budi.in, room, {
      messageId: words, startsAt: inMinutes(120), minutes: 30, attendees: [budi.seat.principal, sari.seat.principal],
    })).meeting as MeetingView;
    for (const seat of [sari.seat, kiki.seat]) {
      ok(await w.api.call('POST', `/api/companies/${w.fixture.companyId}/staff/${seat.id}/revoke`, w.owner.token, {}), 'revoking a seat');
    }
    // Changed as the console changes one, with the whole list as it was.
    const changed = ok(await changeMeeting(budi.in, room, set.id, {
      minutes: 45, attendees: [budi.seat.principal, sari.seat.principal], callUrl: 'https://meet.example/week',
    }), 'a change that keeps whoever was asked').meeting as MeetingView;
    assert.deepEqual([changed.minutes, changed.callUrl, changed.attendees.map((one) => [one.principal, one.name])],
      [45, 'https://meet.example/week', [[budi.seat.principal, 'Budi'], [sari.seat.principal, 'Sari']]]);
    refusedWith(await changeMeeting(budi.in, room, set.id, { attendees: [budi.seat.principal, sari.seat.principal, kiki.seat.principal] }),
      400, 'contract.violation', 'a seat that has gone is not asked anew');
  } finally {
    await w.close();
  }
});

test('a meeting whose words retention took keeps no link and reminds nobody', async () => {
  const w = await workspace('meet-retention', { relay: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const room = await companyRoomOf(w.owner);
    // The owner's words of forty days ago, written on the control plane, which alone writes a message in the past.
    const words = randomUUID();
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, w.fixture.companyId);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, position, created_at)
         VALUES ($1, $2, $3, 'text', 'owner', 'The old plan, once more.', 0, now() - interval '40 days')`,
        [words, w.fixture.companyId, room]);
    });
    ok(await setMeeting(w.owner, room, {
      messageId: words, startsAt: inMinutes(7), minutes: 30, attendees: ['owner', budi.seat.principal],
      callUrl: 'https://meet.example/old?pwd=s3cret',
    }));
    // A note keeps its thread, so retention leaves the meeting's message without words rather than taking it.
    await said(budi.in, room, { body: 'Notes: bring the old numbers.', threadOf: words });
    ok(await w.owner.post('/retention', { messageDays: 30 }));
    // A meeting not yet held keeps its words (the case below); this pass is
    // taken an hour on, once the meeting has ended.
    assert.deepEqual((await purgeExpiredMessages(w.fixture.companyId, new Date(Date.now() + 60 * MINUTE))).tombstoned, [words]);
    const [row] = await meetingRows(w.fixture.companyId);
    assert.deepEqual([row!.call_url, row!.cancelled_at !== null, row!.cancelled_by], [null, true, null],
      'the pasted link went with the words, and the meeting with them, cancelled by nobody');

    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(await remindersIn(w.fixture.companyId), [], 'nothing is said in a thread whose words are gone');
    assert.deepEqual(remindedOf(w.relay!, budi.phone!), []);
    assert.deepEqual((await noticesOf(w.fixture.companyId, budi.seat.principal)).filter((one) => one.reason === 'meeting'), []);
  } finally {
    await w.close();
  }
});

test('a meeting not yet held keeps its words through retention, and is reminded', async () => {
  // Retention takes each message by its own age (STATUS 2.212), but a
  // meeting's words are the meeting: taken, or left without words, they
  // would cancel a meeting that has not happened, and tell the people asked
  // nothing. They are kept until it ends; the notes under them go by their
  // own age, as every reply does.
  const w = await workspace('meet-kept', { relay: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const room = await companyRoomOf(w.owner);
    // The owner's words of forty days ago, and a note of as long ago under
    // them, written on the control plane, which alone writes the past.
    const words = randomUUID();
    const oldNote = randomUUID();
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, w.fixture.companyId);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, position, created_at)
         VALUES ($1, $2, $3, 'text', 'owner', 'The quarter, looked back on.', 0, now() - interval '40 days')`,
        [words, w.fixture.companyId, room]);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, thread_of, kind, author, body, position, created_at)
         VALUES ($1, $2, $3, $4, 'text', 'owner', 'Bring last year too.', 0, now() - interval '40 days')`,
        [oldNote, w.fixture.companyId, room, words]);
    });
    const soon = ok(await setMeeting(w.owner, room, {
      messageId: words, startsAt: inMinutes(8), minutes: 30, attendees: ['owner', budi.seat.principal],
      callUrl: 'https://meet.example/quarter',
    })).meeting as MeetingView;
    // And one set today for forty days ahead, past the window when it is held.
    const far = await said(w.owner, room, 'Planning day, all of us.');
    const later = ok(await setMeeting(w.owner, room, {
      messageId: far, startsAt: inMinutes(40 * 24 * 60), minutes: 60, attendees: ['owner', budi.seat.principal],
    })).meeting as MeetingView;
    ok(await w.owner.post('/retention', { messageDays: 30 }));

    const taken = await purgeExpiredMessages(w.fixture.companyId);
    assert.deepEqual([taken.deleted, taken.tombstoned], [[oldNote], []], 'the old note goes, and the words of a meeting to come stay');
    const kept = await meetingOn(w.owner, room, words);
    assert.deepEqual([kept?.id, kept?.cancelled, kept?.callUrl], [soon.id, false, 'https://meet.example/quarter']);

    // Ten minutes before, its people are reminded, as of any meeting.
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual((await remindersIn(w.fixture.companyId)).map((one) => one.thread_of), [words]);
    const told = remindedOf(w.relay!, budi.phone!);
    assert.deepEqual(told.map((one) => one.data.title), ['The quarter, looked back on.']);
    const items = ok(await budi.in.activity()).items as Array<{ kind: string; threadOf: string | null }>;
    assert.ok(items.some((item) => item.kind === 'meeting' && item.threadOf === words), 'and his Activity says it');

    // Thirty-one days on, the meeting held today has ended and its words go;
    // the one set today is nine days away, and its words stay.
    const month = await purgeExpiredMessages(w.fixture.companyId, new Date(Date.now() + 31 * 24 * 60 * MINUTE));
    assert.ok(month.deleted.includes(words), 'the words of a meeting that has ended go by their age');
    assert.equal(month.deleted.includes(far) || month.tombstoned.includes(far), false);
    const ahead = (await meetingRows(w.fixture.companyId)).find((row) => row.id === later.id);
    assert.deepEqual([ahead?.message_id, ahead?.cancelled_at], [far, null], 'the meeting forty days ahead is still on');
  } finally {
    await w.close();
  }
});

test('archiving a room cancels its meetings not yet begun, as whoever archived it', async () => {
  // An archived room takes no words and no change, so a meeting left on in
  // it could be neither cancelled nor moved, while its people were still
  // reminded of it. Archiving cancels each meeting that has not begun, as
  // its archiver -- the room's creator, though someone else set it.
  const w = await workspace('meet-archive', { relay: 'summary' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const topic = ok(await budi.in.makeRoom({ name: 'launch', private: false })).room as { id: string };
    ok(await sari.in.join(topic.id));
    const everyone = [budi.seat.principal, sari.seat.principal];

    // Reminded already, its notice planned and not yet gone.
    const reminded = await said(sari.in, topic.id, 'Launch checklist.');
    const first = ok(await setMeeting(sari.in, topic.id, { messageId: reminded, startsAt: inMinutes(6), minutes: 15, attendees: everyone })).meeting as MeetingView;
    await syncRoomCards(w.fixture.companyId);
    const now = new Date();
    await planNotices(w.fixture.companyId, { now });
    // Not reminded yet.
    const coming = await said(sari.in, topic.id, 'Launch day itself.');
    const second = ok(await setMeeting(sari.in, topic.id, {
      messageId: coming, startsAt: inMinutes(9), minutes: 30, attendees: everyone, callUrl: 'https://meet.example/launch',
    })).meeting as MeetingView;
    // Under way when the room is archived: it is left to end.
    const going = await said(sari.in, topic.id, 'Standup.');
    const third = ok(await setMeeting(sari.in, topic.id, { messageId: going, startsAt: inMinutes(30), minutes: 30, attendees: everyone })).meeting as MeetingView;
    await withControlPlane((tx) => tx.query("UPDATE room_meetings SET starts_at = now() - interval '5 minutes' WHERE id = $1", [third.id]));

    ok(await budi.in.post(`/rooms/${topic.id}/archive`));
    const rows = new Map((await meetingRows(w.fixture.companyId)).map((row) => [row.id, row]));
    for (const meeting of [first, second]) {
      const row = rows.get(meeting.id)!;
      assert.deepEqual([row.cancelled_at !== null, row.cancelled_by], [true, budi.seat.principal], 'cancelled, as the room\'s archiver');
    }
    assert.equal(rows.get(second.id)!.call_url, 'https://meet.example/launch', 'its words stay, and so does its link');
    assert.equal(rows.get(third.id)!.cancelled_at, null, 'a meeting under way is not cancelled');

    // Nobody is reminded of a meeting in a room that is closed.
    await syncRoomCards(w.fixture.companyId);
    await dispatchPeopleNotices(w.fixture.companyId, { now, linkFor });
    await sendOutbox(w.api.master, now);
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual((await remindersIn(w.fixture.companyId)).map((one) => one.thread_of), [reminded], 'nothing more is said in its threads');
    for (const who of [budi, sari]) {
      assert.deepEqual(remindedOf(w.relay!, who.phone!), [], 'no phone is told');
      assert.deepEqual((await noticesOf(w.fixture.companyId, who.seat.principal)).filter((row) => row.reason === 'meeting')
        .map((row) => [row.subject, row.settled_as]), [[`meeting:${first.id}`, 'gone']]);
      const items = ok(await who.in.activity()).items as Array<{ kind: string; threadOf: string | null }>;
      assert.deepEqual(items.filter((item) => item.kind === 'meeting' && item.threadOf !== reminded), []);
    }

    // Drawn as cancelled by whoever archived the room, and offered to nobody to change.
    const drawn = await meetingOn(sari.in, topic.id, coming);
    assert.deepEqual([drawn?.cancelled, drawn?.cancelledBy?.principal, drawn?.may.change], [true, budi.seat.principal, false]);
    for (const reader of [sari.in, w.owner]) {
      assert.equal((await meetingOn(reader, topic.id, going))?.may.change, false, 'nor the one under way, in a room that takes no change');
    }
    refusedWith(await changeMeeting(sari.in, topic.id, third.id, { minutes: 45 }), 409, 'room.archived');
  } finally {
    await w.close();
  }
});

test("a meeting's reminder is no notice of words: what is said around it is counted as before", async () => {
  // One notice for a room's words in ten minutes, the rest counted on it
  // (STATUS 2.213): a reminder between two mentions neither closes the
  // first's window nor opens one of its own.
  const w = await workspace('meet-window', { relay: 'summary' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    await said(budi.in, room, { body: '@sari the counts, please.', mentions: [sari.seat.principal] });
    await tell(w.fixture.companyId, w.api.master);
    const words = await said(budi.in, room, 'Count together.');
    ok(await setMeeting(budi.in, room, { messageId: words, startsAt: inMinutes(7), minutes: 15, attendees: [sari.seat.principal] }));
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    await said(budi.in, room, { body: '@sari and the till.', mentions: [sari.seat.principal] });
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual((await noticesOf(w.fixture.companyId, sari.seat.principal)).map((row) => [row.reason, row.count]),
      [['mention', 2], ['meeting', 1]], 'the second mention is counted on the first, within its ten minutes');
  } finally {
    await w.close();
  }
});

test("a message is a people's meeting or work, never both", async () => {
  // A people's meeting is no agent's work, and its thread is its notes: a
  // message already given as work is set no meeting, and a meeting's words
  // are given as no work.
  const w = await workspace('meet-or-work');
  try {
    const room = await companyRoomOf(w.owner);
    const given = await said(w.owner, room, 'Find a cheaper courier.');
    ok(await w.owner.on(room, given, 'work', { target: 'company', goal: 'Find a cheaper courier', goalId: w.fixture.goalId }));
    refusedWith(await setMeeting(w.owner, room, { messageId: given, startsAt: inMinutes(60), minutes: 30, attendees: ['owner'] }),
      400, 'contract.violation', 'words already given as work');
    await assert.rejects(withPeople(w.fixture.companyId, { principal: 'owner', name: null }, (tx) => tx.query(
      `INSERT INTO room_meetings (company_id, room_id, message_id, starts_at, minutes, attendees, set_by)
       VALUES ($1, $2, $3, now() + interval '1 day', 30, ARRAY['owner'], 'owner')`,
      [w.fixture.companyId, room, given])), /a meeting is set from words/, 'the database refuses it too');

    const review = await said(w.owner, room, 'Courier review with the team.');
    ok(await setMeeting(w.owner, room, { messageId: review, startsAt: inMinutes(60), minutes: 30, attendees: ['owner'] }));
    const shown = (ok(await w.owner.page(room)).messages as Array<{ id: string; may: { giveAsWork: boolean; callMeeting: boolean } }>)
      .find((one) => one.id === review)!;
    assert.deepEqual([shown.may.giveAsWork, shown.may.callMeeting], [false, false], 'a meeting\'s words are offered as no work');
    refusedWith(await w.owner.on(room, review, 'work', { target: 'company', goal: 'Review couriers', goalId: w.fixture.goalId }),
      400, 'contract.violation', 'nor given as work');
  } finally {
    await w.close();
  }
});

test('a meeting reaches no run, makes no task and writes no event', async () => {
  const w = await workspace('meet-not-work', { relay: 'content' });
  try {
    const budi = await person(w, 'Budi', 'approver');
    const room = await companyRoomOf(w.owner);
    const before_ = await workCounted(w.fixture.companyId);

    const agenda = await said(budi.in, room, 'Plan the opening: the menu, the staff, the money.');
    const set = ok(await setMeeting(budi.in, room, {
      messageId: agenda, startsAt: inMinutes(5), minutes: 60, attendees: [budi.seat.principal, 'owner'],
    })).meeting as MeetingView;
    await said(w.owner, room, { body: 'Notes: the menu is settled.', threadOf: agenda });
    ok(await changeMeeting(w.owner, room, set.id, { minutes: 90 }));
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    assert.equal(remindedOf(w.relay!, budi.phone!).length, 1, 'the reminder went');
    ok(await changeMeeting(budi.in, room, set.id, { cancel: true }));

    assert.deepEqual(await workCounted(w.fixture.companyId), before_, 'no task, no event, no run and no inbox item');
    // An agent's transaction reads nothing of it and writes nothing to it, in its own company.
    const seen = await withTenant(w.fixture.companyId, async (tx) => (await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM room_meetings')).rows[0]!.n);
    assert.equal(seen, 0);
    await assert.rejects(withTenant(w.fixture.companyId, (tx) => tx.query(
      `INSERT INTO room_meetings (company_id, room_id, message_id, starts_at, minutes, attendees, set_by)
       VALUES ($1, $2, $3, now() + interval '1 day', 30, ARRAY['owner'], 'owner')`,
      [w.fixture.companyId, room, agenda])), /row-level security|permission denied/);
  } finally {
    await w.close();
  }
});

test('a call link is https and is never fetched', async () => {
  const w = await workspace('meet-link', { relay: 'content' });
  // A server that counts every connection made to it: the meeting's link points at it.
  const connections: number[] = [];
  const server: Server = createServer((socket) => {
    connections.push(Date.now());
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const budi = await person(w, 'Budi');
    const room = await companyRoomOf(w.owner);
    const agenda = await said(budi.in, room, 'Call with the roaster.');
    const base = { messageId: agenda, startsAt: inMinutes(6), minutes: 30, attendees: [budi.seat.principal, 'owner'] };
    for (const callUrl of [
      'http://meet.example/x', 'javascript:alert(1)', 'ftp://meet.example/x', 'meet.example/x', 'https://meet.example/a b',
      'https://', `https://meet.example/${'x'.repeat(2000)}`, 42,
      // Control characters, which nobody pastes in a link and some databases cannot even hold.
      'https://meet.example/\u0000x', 'https://meet.example/\u001fx', 'https://meet.example/\u001cx', 'https://meet.example/\u0085x',
      'https://meet.example/\u007fx',
    ]) {
      const answer = await setMeeting(budi.in, room, { ...base, callUrl });
      refusedWith(answer, 400, 'contract.violation', `a call link of ${String(callUrl).slice(0, 40)}`);
      assert.equal(answer.body.details?.field, 'callUrl');
    }
    const link = `https://127.0.0.1:${port}/room?pwd=s3cret`;
    const set = ok(await setMeeting(budi.in, room, { ...base, callUrl: link })).meeting as MeetingView;
    assert.equal(set.callUrl, link, 'kept as it was pasted');

    // Read, reminded and told: nothing reaches for it.
    await meetingOn(w.owner, room, agenda);
    ok(await w.owner.thread(room, agenda));
    await syncRoomCards(w.fixture.companyId);
    await tell(w.fixture.companyId, w.api.master);
    assert.equal(remindedOf(w.relay!, budi.phone!).length, 1);
    assert.ok(!JSON.stringify(w.relay!.received.map((one) => one.envelope)).includes(`127.0.0.1:${port}`),
      'a relay is never sent the link: it opens the meeting\'s thread in PALUGADA');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(connections, [], 'the server never fetched or unfurled the link');

    // The database holds a link to https as well.
    await assert.rejects(withPeople(w.fixture.companyId, { principal: budi.seat.principal, name: 'Budi' }, (tx) => tx.query(
      "UPDATE room_meetings SET call_url = 'http://meet.example/x' WHERE id = $1", [set.id])), /room_meetings_call_url_check/);
    for (const control of ['\u001f', '\u007f', '\u009b']) {
      await assert.rejects(withPeople(w.fixture.companyId, { principal: budi.seat.principal, name: 'Budi' }, (tx) => tx.query(
        'UPDATE room_meetings SET call_url = $2 WHERE id = $1', [set.id, `https://meet.example/${control}x`])), /room_meetings_call_url_check/,
      `the database refuses U+${control.codePointAt(0)!.toString(16).padStart(4, '0')} too`);
    }
  } finally {
    server.close();
    await w.close();
  }
});

test("a meeting travels with the company's export", async () => {
  const w = await workspace('meet-export');
  try {
    const budi = await person(w, 'Budi');
    const room = await companyRoomOf(w.owner);
    const agenda = await said(w.owner, room, 'Quarterly review with the team.');
    const startsAt = inMinutes(60 * 24 * 3);
    const set = ok(await setMeeting(w.owner, room, {
      messageId: agenda, startsAt, minutes: 90, attendees: ['owner', budi.seat.principal], callUrl: 'https://meet.example/q4',
    })).meeting as MeetingView;
    const dropped = await said(budi.in, room, 'Lunch?');
    ok(await setMeeting(budi.in, room, { messageId: dropped, startsAt: inMinutes(60), minutes: 30, attendees: ['owner'] })
      .then(async (answer) => {
        ok(answer);
        return changeMeeting(budi.in, room, String(answer.body.meeting.id), { cancel: true });
      }));

    const { sections } = await collectExport(w.fixture.companyId);
    const rows = sections.room_meetings ?? [];
    assert.equal(rows.length, 2);
    const kept = rows.find((row) => row.id === set.id)!;
    assert.deepEqual([kept.message_id, kept.room_id, kept.minutes, kept.attendees, kept.call_url, kept.set_by],
      [agenda, room, 90, ['owner', budi.seat.principal], 'https://meet.example/q4', 'owner']);
    assert.ok(rows.some((row) => row.message_id === dropped && row.cancelled_by === budi.seat.principal));

    const lines: ArchiveLine[] = [];
    await exportCompany(w.fixture.companyId, (line) => { lines.push(line); });
    const restored = await importCompany(lines, { slug: `${w.fixture.slug}-restored` });
    const back = await meetingRows(restored.companyId);
    assert.equal(back.length, 2);
    const owner = personIn(w.api, w.owner.token, restored.companyId);
    const restoredRoom = await companyRoomOf(owner);
    const page = ok(await owner.page(restoredRoom)).messages as Array<{ id: string; body: string | null; peopleMeeting: MeetingView | null }>;
    const message = page.find((one) => one.body === 'Quarterly review with the team.')!;
    assert.notEqual(message.id, agenda, 'the restored message is a row of its own');
    assert.deepEqual(
      [message.peopleMeeting?.startsAt, message.peopleMeeting?.minutes, message.peopleMeeting?.callUrl, message.peopleMeeting?.cancelled],
      [startsAt, 90, 'https://meet.example/q4', false], 'its meeting comes back on it');
    assert.equal(page.find((one) => one.body === 'Lunch?')!.peopleMeeting?.cancelled, true);
  } finally {
    await w.close();
  }
});

