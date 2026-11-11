/**
 * People are told (F19.13, F10.5; STATUS section 2.213).
 *
 * A person who linked a phone is told of a direct message, a mention, a reply
 * in a thread they follow, a run's question put to them, an approval they may
 * decide and work they asked for that ended -- and of nothing else. Never of
 * their own words; once a room in ten minutes; at most their daily number,
 * then only how many more; not in their quiet hours, and for the owner not
 * outside the owner's window; the owner only when they turned it on, and
 * never as an inbox item. What a notice says is who and where, and the words
 * only when the link's share is `content`. Who may see the room is asked when
 * a notice is planned and again, as the person, just before it is sent.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { Engine } from '../../src/engine/engine.ts';
import { createRootTask, createRootTaskWithin, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { TelegramChannel } from '../../src/owner/telegram.ts';
import { RelayChannel } from '../../src/relay/channel.ts';
import { setOwnerWindow } from '../../src/scheduler/windows.ts';
import { redactor } from '../../src/secrets/manager.ts';
import { Worker } from '../../src/worker.ts';
import { syncRoomCards } from '../../src/workspace/cards.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { fakeRelay, type FakeRelay } from '../helpers/fake-relay.ts';
import { linkThrough, pairThrough, sendOutbox, type Linked } from '../helpers/relay.ts';
import { noticesOf, tell, toldTo } from '../helpers/notices.ts';
import { companyRoomOf, ok, personIn, said, seated, type Console, type PersonIn, type Seat } from '../helpers/rooms.ts';
import { migrate } from '../../scripts/migrate.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface Workspace {
  fixture: Fixture;
  api: Console;
  relay: FakeRelay;
  relayId: string;
  ownerToken: string;
  owner: PersonIn;
  close: () => Promise<void>;
}

/** A company, the owner's console, and a relay paired for the company. */
async function workspace(
  slug: string,
  options: { share?: 'signal' | 'summary' | 'content'; mayPress?: boolean; telegram?: TelegramChannel } = {},
): Promise<Workspace> {
  const fixture = await createCompany(slug);
  const relay = await fakeRelay();
  const api = await consoleWithSettings(options.telegram ? { telegram: options.telegram } : {});
  const ownerToken = await api.signIn();
  const relayId = await pairThrough(api, ownerToken, relay, {
    companies: [fixture.companyId], share: options.share ?? 'summary', ...(options.mayPress ? { mayPress: true } : {}),
  });
  return {
    fixture, api, relay, relayId, ownerToken, owner: personIn(api, ownerToken, fixture.companyId),
    close: async () => {
      await api.close();
      await relay.close();
    },
  };
}

/** A member of staff, signed in, with a handle, and their phone linked through the relay with a key of its own. */
async function person(w: Workspace, name: string, kind: 'viewer' | 'member' | 'approver' = 'member', options: { phone?: boolean; share?: 'signal' | 'summary' | 'content' } = {}) {
  const seat = await seated(w.fixture, name, kind, { handle: name.toLowerCase() });
  const in_ = personIn(w.api, seat.token, w.fixture.companyId);
  await companyRoomOf(in_);
  const phone = options.phone === false
    ? null
    : await linkThrough(w.api, seat.token, w.relay, w.relayId, { device: true, owner: false, ...(options.share ? { share: options.share } : {}) });
  return { seat, in: in_, phone };
}

type Person = Awaited<ReturnType<typeof person>>;

const direct = async (from: PersonIn, to: Seat | 'owner') => String(ok(await from.direct([to === 'owner' ? 'owner' : to.principal])).room.id);
const mention = (who: Seat) => ({ body: `@${who.name.toLowerCase()} have a look`, mentions: [who.principal] });

/** Noon tomorrow in UTC: inside the owner's window, which the suite keeps at 8 to 22 UTC. */
function midday(days = 1): Date {
  const at = new Date(Date.now() + days * 24 * 3_600_000);
  at.setUTCHours(12, 0, 0, 0);
  return at;
}

/** The next time the UTC clock shows `hours` from now, on the hour, and a minute. */
function onTheHour(hours: number): Date {
  const at = new Date();
  at.setUTCMinutes(0, 0, 0);
  return new Date(at.getTime() + hours * 3_600_000 + 60_000);
}

/** The owner hears people, and the owner's phone is linked. */
async function ownerHears(w: Workspace, on: boolean): Promise<Linked> {
  ok(await w.api.call('POST', '/api/me/profile', w.ownerToken, { ownerHearsPeople: on }));
  return linkThrough(w.api, w.ownerToken, w.relay, w.relayId, { device: true });
}

test('a direct message and a mention are told; other messages are not', async () => {
  const w = await workspace('notify-reasons');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Lunch at noon?');
    await said(budi.in, room, mention(sari.seat));
    const topic = String(ok(await budi.in.makeRoom({ name: 'Suppliers' })).room.id);
    ok(await sari.in.join(topic));
    await said(budi.in, topic, 'The van is late again.');
    await said(budi.in, room, 'Plain words for everyone.');
    await tell(w.fixture.companyId, w.api.master);

    const told = toldTo(w.relay, sari.phone!);
    assert.deepEqual(told.map((one) => [one.type, one.data.reasons]).sort(),
      [['room_activity', ['direct']], ['room_activity', ['mention']]]);
    assert.ok(told.every((one) => one.urgency === 'normal'), 'a notice addressed to a person shows, and never rings');
    const rows = await noticesOf(w.fixture.companyId, sari.seat.principal);
    assert.deepEqual(rows.map((row) => row.reason).sort(), ['direct', 'mention']);
    assert.ok(rows.every((row) => row.settled_as === 'sent'));
    // Budi was told of nothing: he wrote all of it.
    assert.deepEqual(toldTo(w.relay, budi.phone!), []);
  } finally {
    await w.close();
  }
});

test('the author is never told of their own message', async () => {
  const w = await workspace('notify-author');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Note to self, and to Sari.');
    // A mention of himself, and a reply in the thread he began.
    const root = await said(budi.in, room, mention(budi.seat));
    await said(sari.in, room, { body: 'Seen it.', threadOf: root });
    await said(budi.in, room, { body: 'Thanks.', threadOf: root });
    await tell(w.fixture.companyId, w.api.master);

    assert.deepEqual(toldTo(w.relay, budi.phone!).map((one) => one.data.reasons), [['reply']],
      "Budi is told of Sari's reply in his thread, and of nothing he wrote");
    assert.deepEqual((await noticesOf(w.fixture.companyId, budi.seat.principal)).map((row) => row.reason), ['reply']);
    assert.deepEqual(toldTo(w.relay, sari.phone!).map((one) => one.data.reasons).flat().sort(), ['direct', 'reply']);
  } finally {
    await w.close();
  }
});

test('a burst in one room is told once in ten minutes', async () => {
  const w = await workspace('notify-burst');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    for (const words of ['Are you there?', 'The supplier called.', 'They want an answer today.']) await said(budi.in, dm, words);
    await tell(w.fixture.companyId, w.api.master);
    let told = toldTo(w.relay, sari.phone!);
    assert.equal(told.length, 1, 'three messages, one notice');
    assert.equal(told[0].data.count, 3);

    // Two more in the same ten minutes are counted, not sent.
    await said(budi.in, dm, 'Hello?');
    await said(budi.in, dm, 'Call me.');
    await tell(w.fixture.companyId, w.api.master);
    assert.equal(toldTo(w.relay, sari.phone!).length, 1);
    const [row] = await noticesOf(w.fixture.companyId, sari.seat.principal);
    assert.equal(row!.count, 5);

    // Ten minutes on, the room is told again.
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, w.fixture.companyId);
      await tx.query("UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [w.fixture.companyId]);
    });
    await said(budi.in, dm, 'Never mind, sorted.');
    await tell(w.fixture.companyId, w.api.master);
    told = toldTo(w.relay, sari.phone!);
    assert.equal(told.length, 2);
    assert.notEqual(told[0].id, told[1].id);
  } finally {
    await w.close();
  }
});

test('a seat is told at most its daily number, then only the count', async () => {
  const w = await workspace('notify-cap');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    ok(await w.api.call('POST', '/api/me/profile', sari.seat.token, { noticesPerDay: 2, timezone: 'UTC' }));
    // Four rooms, so four notices nothing coalesces.
    await said(budi.in, await direct(budi.in, sari.seat), 'One.');
    for (const name of ['Kitchen', 'Deliveries', 'Payroll']) {
      const room = String(ok(await budi.in.makeRoom({ name })).room.id);
      await said(budi.in, room, mention(sari.seat));
    }
    await tell(w.fixture.companyId, w.api.master);
    assert.equal(toldTo(w.relay, sari.phone!).length, 2, 'two, her daily number');
    const rows = await noticesOf(w.fixture.companyId, sari.seat.principal);
    assert.deepEqual(rows.map((row) => row.settled_as).sort(), ['capped', 'capped', 'sent', 'sent']);

    // The next day's first notice says how many more there were.
    const tomorrow = new Date(Date.now() + 24 * 3_600_000);
    await said(budi.in, await direct(budi.in, sari.seat), 'Morning.');
    await tell(w.fixture.companyId, w.api.master, { now: tomorrow });
    const told = toldTo(w.relay, sari.phone!);
    assert.equal(told.length, 3);
    assert.match(told[2].text, /And more yesterday: 2\./);
  } finally {
    await w.close();
  }
});

test("quiet hours hold a person's notices, and the owner window holds the owner's", async () => {
  const w = await workspace('notify-quiet');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const hour = new Date().getUTCHours();
    ok(await w.api.call('POST', '/api/me/profile', sari.seat.token, { timezone: 'UTC', quietStart: hour, quietEnd: (hour + 2) % 24 }));
    const ownerPhone = await ownerHears(w, true);
    // The owner's window opens three hours from now and closes an hour later.
    await setOwnerWindow({ timezone: 'UTC', startHour: (hour + 3) % 24, endHour: (hour + 4) % 24 });

    await said(budi.in, await direct(budi.in, sari.seat), 'Are you up?');
    await said(budi.in, await direct(budi.in, 'owner'), 'Are you up, boss?');
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(toldTo(w.relay, sari.phone!), [], 'quiet hours hold it');
    assert.deepEqual(toldTo(w.relay, ownerPhone), [], "the owner's window holds the owner's");
    const [held] = await noticesOf(w.fixture.companyId, sari.seat.principal);
    assert.ok(held!.notify_after > new Date(), 'held until the quiet hours end');

    // Her quiet hours end: she is told; the owner's window has not opened.
    await tell(w.fixture.companyId, w.api.master, { now: onTheHour(2) });
    assert.equal(toldTo(w.relay, sari.phone!).length, 1);
    assert.deepEqual(toldTo(w.relay, ownerPhone), []);
    // The owner's window opens.
    await tell(w.fixture.companyId, w.api.master, { now: onTheHour(3) });
    assert.equal(toldTo(w.relay, ownerPhone).length, 1);
  } finally {
    await w.close();
  }
});

test('the owner hears nothing from people unless they turned it on, and it is never an inbox item', async () => {
  const w = await workspace('notify-owner');
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new TelegramChannel({
    token: 'test-bot-token-0000', chatId: '42',
    fetch: async (url, init) => {
      const method = String(url).split('/').at(-1)!;
      sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { has_topics_enabled: false } : { message_id: sent.length } }));
    },
  });
  try {
    const budi = await person(w, 'Budi');
    const ownerPhone = await ownerHears(w, false);
    const room = await companyRoomOf(w.owner);
    await said(budi.in, await direct(budi.in, 'owner'), 'A word, boss.');
    await said(budi.in, room, { body: '@owner can you sign this?', mentions: ['owner'] });
    await tell(w.fixture.companyId, w.api.master, { now: midday(), chats: [telegram] });
    assert.deepEqual(toldTo(w.relay, ownerPhone), [], 'off until the owner turns it on');
    assert.deepEqual(await noticesOf(w.fixture.companyId, 'owner'), []);
    assert.equal(sent.filter((one) => one.method === 'sendMessage').length, 0);

    ok(await w.api.call('POST', '/api/me/profile', w.ownerToken, { ownerHearsPeople: true }));
    await said(budi.in, await direct(budi.in, 'owner'), 'Now you hear me.');
    await tell(w.fixture.companyId, w.api.master, { now: midday(), chats: [telegram] });
    assert.equal(toldTo(w.relay, ownerPhone).length, 1, 'the owner is told through the relay');
    const chats = sent.filter((one) => one.method === 'sendMessage');
    assert.equal(chats.length, 1, 'and in their chat');
    assert.match(String(chats[0]!.body.text), /Budi \(@budi\) wrote to you\./);
    assert.match(String(chats[0]!.body.text), /https:\/\/palugada\.example\/\?company=/);
    assert.equal(chats[0]!.body.reply_markup, undefined, 'plain text and a link, nothing to press');
    assert.doesNotMatch(JSON.stringify(chats), /Now you hear me/, 'who and where, never the words');

    // Never an inbox item, and never one of the owner's notifications.
    const seen = await inbox.ownerInbox(w.fixture.companyId);
    assert.equal(seen.items.length + seen.team.length, 0);
    const { rows } = await withTenant(w.fixture.companyId, (tx) => tx.query('SELECT 1 FROM owner_notifications'));
    assert.equal(rows.length, 0);
  } finally {
    await w.close();
  }
});

test('agent work tells a person only of a question for them, an approval they may decide and work they asked for', async () => {
  const w = await workspace('notify-agents');
  try {
    const mira = await person(w, 'Mira');
    const budi = await person(w, 'Budi');
    const rina = await person(w, 'Rina', 'approver');
    const { companyId } = w.fixture;
    const work = (goal: string) => ({
      companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
      goalId: w.fixture.goalId, input: { goal }, reserveTokens: 100,
    });
    const askedByMira = async (goal: string) => withTenant(companyId, async (tx) => {
      const made = await createRootTaskWithin(tx, { ...work(goal), createdBy: 'staff', requestedBySeat: mira.seat.id });
      return made.id;
    });

    // A run's question put to Budi.
    const owners = await createRootTask({ ...work('Choose a supplier'), createdBy: 'owner' });
    await transition(companyId, owners.id, 'running');
    await inbox.askOwner({ companyId, taskId: owners.id, question: 'Which supplier?', addressee: { seatId: budi.seat.id, name: 'Budi', escalateAfterHours: 24 } });
    // An approval in work Mira asked for: the team's, so Rina's to decide.
    const asked = await askedByMira('Email the customers');
    await transition(companyId, asked, 'running');
    await inbox.requestApproval({
      companyId, taskId: asked, capabilityName: 'email.send', tier: 2, actionSummary: 'Email 40 customers',
      rationale: 'ready', consequenceIfDenied: 'not sent', instigators: [mira.seat.id],
    });
    // Work Mira asked for, finished.
    const finished = await askedByMira('Count the stock');
    await transition(companyId, finished, 'running');
    await transition(companyId, finished, 'completed', { output: { summary: '41 bags' } });
    // And everything else an agent does: an incident, the owner's own work
    // finished, cards drawn in the rooms.
    await inbox.raiseIncident({ companyId, title: 'The till is down', detail: 'since noon' });
    const ownWork = await createRootTask({ ...work('Tidy the shelves'), createdBy: 'owner' });
    await transition(companyId, ownWork.id, 'running');
    await transition(companyId, ownWork.id, 'completed', { output: { summary: 'tidied' } });
    await syncRoomCards(companyId);
    await tell(companyId, w.api.master);
    // The worker comes round again: each is told once.
    assert.equal((await tell(companyId, w.api.master)).planned, 0);

    const kinds = (who: Person) => toldTo(w.relay, who.phone!).map((one) => `${one.type}:${one.data.kind ?? ''}`);
    assert.deepEqual(kinds(budi), ['inbox_item:escalation'], 'Budi: the question put to him');
    assert.deepEqual(kinds(rina), ['inbox_item:approval'], 'Rina: the approval she may decide');
    assert.deepEqual(kinds(mira), ['work_done:'], 'Mira: the work she asked for, and not the approval her own work raised');
    assert.match(toldTo(w.relay, budi.phone!)[0].text, /A question for you from /);
    assert.match(toldTo(w.relay, mira.phone!)[0].text, /The work you asked for is done: Count the stock\./);
    assert.deepEqual((await noticesOf(companyId, rina.seat.principal)).map((row) => row.reason), ['approval']);
  } finally {
    await w.close();
  }
});

test('a notice already read is not sent', async () => {
  const w = await workspace('notify-read');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    const id = await said(budi.in, dm, 'Seen this?');
    const position = Number((ok(await sari.in.page(dm)).messages as Array<{ id: string; position: number }>).find((one) => one.id === id)!.position);
    ok(await sari.in.read(dm, { position }));
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(toldTo(w.relay, sari.phone!), []);
    assert.deepEqual((await noticesOf(w.fixture.companyId, sari.seat.principal)).map((row) => row.settled_as), ['read']);
  } finally {
    await w.close();
  }
});

test("a notice says who and where, never the words, unless the link's share is content", async () => {
  const w = await workspace('notify-share', { share: 'content' });
  try {
    redactor.register('kopi-secret-4242');
    const budi = await person(w, 'Budi');
    // Sari keeps her own phone at summary; Ayu takes what the relay is told.
    const sari = await person(w, 'Sari', 'member', { share: 'summary' });
    const ayu = await person(w, 'Ayu');
    const signal = await fakeRelay();
    const room = await companyRoomOf(w.owner);
    const words = '@sari @ayu the safe code is kopi-secret-4242 and the van is at the back';
    await said(budi.in, room, { body: words, mentions: [sari.seat.principal, ayu.seat.principal] });
    await tell(w.fixture.companyId, w.api.master);

    const [toSari] = toldTo(w.relay, sari.phone!);
    assert.equal(toSari.share, 'summary');
    assert.match(toSari.text, /^Budi \(@budi\) mentioned you in /);
    assert.deepEqual(toSari.data.authors, [{ name: 'Budi', handle: 'budi' }]);
    assert.equal(toSari.data.excerpt, undefined);
    assert.doesNotMatch(JSON.stringify(toSari), /safe code|van is at the back/, 'at summary, who and where only');

    const [toAyu] = toldTo(w.relay, ayu.phone!);
    assert.equal(toAyu.share, 'content');
    assert.match(toAyu.data.excerpt, /the safe code is \[redacted\]/);
    assert.ok(toAyu.data.excerpt.length <= 140);
    assert.doesNotMatch(JSON.stringify(toAyu), /kopi-secret-4242/, 'redacted, as every word leaving is');

    // At signal, only that something happened.
    const p2 = await pairThrough(w.api, w.ownerToken, signal, { companies: [w.fixture.companyId] });
    const ayuSignal = await linkThrough(w.api, ayu.seat.token, signal, p2, { device: true, owner: false });
    await said(budi.in, room, { body: '@ayu again', mentions: [ayu.seat.principal] });
    await tell(w.fixture.companyId, w.api.master);
    const [quiet] = toldTo(signal, ayuSignal);
    assert.equal(quiet.text, 'Something new in PALUGADA.');
    assert.equal(quiet.company.name, undefined);
    assert.deepEqual(Object.keys(quiet.data).sort(), ['count', 'reasons']);
    await signal.close();
  } finally {
    await w.close();
  }
});

test('a person removed from a private room before a notice is sent is not told', async () => {
  const w = await workspace('notify-removed');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = String(ok(await w.owner.makeRoom({ name: 'Board', private: true, members: [budi.seat.principal, sari.seat.principal] })).room.id);
    await said(budi.in, room, mention(sari.seat));
    // Planned, not yet sent.
    const { planNotices } = await import('../../src/owner/member-notify.ts');
    assert.equal((await planNotices(w.fixture.companyId)).planned, 1);
    ok(await w.owner.members(room, { remove: [sari.seat.principal] }));
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(toldTo(w.relay, sari.phone!), []);
    assert.deepEqual((await noticesOf(w.fixture.companyId, sari.seat.principal)).map((row) => row.settled_as), ['gone']);
  } finally {
    await w.close();
  }
});

test('an approver who cannot see the room is told of the approval without its room', async () => {
  const w = await workspace('notify-approver-room');
  try {
    const mira = await person(w, 'Mira');
    const rina = await person(w, 'Rina', 'approver');
    const joko = await person(w, 'Joko', 'approver');
    const { companyId } = w.fixture;
    // Mira asks for work in a private room Joko is in and Rina is not.
    const room = String(ok(await mira.in.makeRoom({ name: 'Launch plans', private: true, members: [joko.seat.principal] })).room.id);
    const message = await said(mira.in, room, 'Email the launch to our customers.');
    const given = ok(await mira.in.on(room, message, 'work', { target: w.fixture.roleId, goal: 'Email the launch', goalId: w.fixture.goalId }));
    await transition(companyId, String(given.taskId), 'running');
    await inbox.requestApproval({
      companyId, taskId: String(given.taskId), capabilityName: 'email.send', tier: 2, actionSummary: 'Email 40 customers',
      rationale: 'ready', consequenceIfDenied: 'not sent', instigators: [mira.seat.id],
    });
    await syncRoomCards(companyId);
    await tell(companyId, w.api.master);

    const [toRina] = toldTo(w.relay, rina.phone!);
    const [toJoko] = toldTo(w.relay, joko.phone!);
    assert.equal(toRina.text, 'An approval waits for you.');
    assert.doesNotMatch(String(toRina.link), /room=/, 'nor does its link name the room');
    assert.doesNotMatch(JSON.stringify(toRina), /Launch plans/);
    assert.equal(toJoko.text, 'An approval waits for you in Launch plans.');
    assert.match(String(toJoko.link), new RegExp(`room=${room}`));
  } finally {
    await w.close();
  }
});

test("the owner's day stays at or under ten items with five busy seats and people's notices on", async () => {
  const w = await workspace('notify-g3');
  try {
    const ownerPhone = await ownerHears(w, true);
    const room = await companyRoomOf(w.owner);
    const seats: Person[] = [];
    for (const name of ['Ayu', 'Bayu', 'Citra', 'Dewi', 'Eko']) seats.push(await person(w, name, 'member', { phone: false }));
    // Each seat is busy with work too: three pieces each, every one waiting
    // on a card the team decides, and no approver seated but the owner.
    const { companyId } = w.fixture;
    for (const one of seats) {
      for (const goal of ['Email the list', 'Post the photo', 'Pay the printer']) {
        const taskId = await withTenant(companyId, async (tx) => (await createRootTaskWithin(tx, {
          companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
          goalId: w.fixture.goalId, input: { goal: `${one.seat.name}: ${goal}` }, createdBy: 'staff', requestedBySeat: one.seat.id, reserveTokens: 100,
        })).id);
        await transition(companyId, taskId, 'running');
        await inbox.requestApproval({
          companyId, taskId, capabilityName: 'email.send', tier: 2, actionSummary: `${one.seat.name}: ${goal}`, rationale: 'ready',
          consequenceIfDenied: 'not done', instigators: [one.seat.id],
        });
      }
    }
    for (const one of seats) {
      const dm = await direct(one.in, 'owner');
      const topic = String(ok(await one.in.makeRoom({ name: `${one.seat.name}'s corner` })).room.id);
      for (let n = 0; n < 12; n += 1) {
        await said(one.in, dm, `Message ${n + 1} for the owner`);
        if (n % 3 === 0) await said(one.in, room, { body: `@owner number ${n}`, mentions: ['owner'] });
        if (n % 4 === 0) await said(one.in, topic, { body: `@owner over here ${n}`, mentions: ['owner'] });
      }
    }
    // The worker's notify stage, as a deployment runs it, past the owner's window.
    const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-g3' });
    const worker = new Worker({ engine, companyId: w.fixture.companyId, ownerChannels: [new RelayChannel(w.relayId)] });
    const noon = midday(2);
    await worker.tick(noon, { runs: false });
    await sendOutbox(w.api.master, noon);

    // The owner's own channel carries the owner's items and digest beside these, as ever.
    const told = toldTo(w.relay, ownerPhone).filter((one) => one.type === 'room_activity');
    assert.ok(told.length > 0 && told.length <= 10, `the owner was told ${told.length} times`);
    const rows = await noticesOf(w.fixture.companyId, 'owner');
    assert.ok(rows.filter((row) => row.settled_as === 'sent').length <= 10);
    assert.ok(rows.some((row) => row.settled_as === 'capped'), 'past the day\'s ten, counted rather than sent');
    const seen = await inbox.ownerInbox(w.fixture.companyId);
    const teamDays = seen.team.filter((entry) => entry.day !== null);
    assert.ok(teamDays.length >= 1, "the team's fifteen cards reach the owner");
    assert.ok(seen.items.length + teamDays.length <= 10, `the owner's day is ${seen.items.length + teamDays.length} items`);
    assert.equal(seen.items.length, 0, 'and none of the notices is an inbox item');
  } finally {
    await w.close();
  }
});

test("the owner's digest counts the team's cards as the badge does: one entry a day", async () => {
  // How the owner is told of the team's cards (STATUS section 2.204): the
  // digest's open items are what the inbox's badge counts, not every card.
  const w = await workspace('notify-digest');
  try {
    const mira = await person(w, 'Mira', 'member', { phone: false });
    const { companyId } = w.fixture;
    for (const summary of ['Email the list', 'Post the photo', 'Pay the printer']) {
      const taskId = await withTenant(companyId, async (tx) => (await createRootTaskWithin(tx, {
        companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
        goalId: w.fixture.goalId, input: { goal: summary }, createdBy: 'staff', requestedBySeat: mira.seat.id, reserveTokens: 100,
      })).id);
      await transition(companyId, taskId, 'running');
      await inbox.requestApproval({
        companyId, taskId, capabilityName: 'email.send', tier: 2, actionSummary: summary, rationale: 'ready',
        consequenceIfDenied: 'not done', instigators: [mira.seat.id],
      });
    }
    await inbox.requestApproval({ companyId, capabilityName: 'email.send', tier: 2, actionSummary: "The owner's own", rationale: 'ready', consequenceIfDenied: 'not sent' });
    const { buildDailyDigest } = await import('../../src/reporting/digest.ts');
    const digest = await buildDailyDigest(companyId, new Date());
    const badge = (ok(await w.api.call('GET', '/api/rooms/unread', w.ownerToken)).unread as Array<{ companyId: string; openCount: number }>)
      .find((one) => one.companyId === companyId)!.openCount;
    assert.equal(badge, 2, "the owner's own card, and the team's day");
    assert.equal(digest.openInboxItems, badge);
  } finally {
    await w.close();
  }
});

test("what was sent to whom is delivery's bookkeeping: no person reads it, and no agent", async () => {
  const w = await workspace('notify-bookkeeping');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    await said(budi.in, await direct(budi.in, sari.seat), 'Hi.');
    await tell(w.fixture.companyId, w.api.master);
    assert.equal((await noticesOf(w.fixture.companyId, sari.seat.principal)).length, 1);
    const { withPeople } = await import('../../src/db/tenant.ts');
    for (const who of [{ principal: sari.seat.principal, name: 'Sari' }, { principal: 'owner', name: null }]) {
      const { rows } = await withPeople(w.fixture.companyId, who, (tx) => tx.query('SELECT 1 FROM people_notices'));
      assert.equal(rows.length, 0, `${who.principal} reads no notice, their own included`);
    }
    const { rows } = await withTenant(w.fixture.companyId, (tx) => tx.query('SELECT 1 FROM people_notices'));
    assert.equal(rows.length, 0, "an agent's transaction reads none");
    await assert.rejects(withTenant(w.fixture.companyId, (tx) => tx.query(
      `INSERT INTO people_notices (company_id, principal, reason, subject, window_key, day, channel)
       VALUES ($1, 'owner', 'question', 'item:00000000-0000-4000-8000-000000000000', 'x', current_date, 'chat:telegram')`,
      [w.fixture.companyId])), /row-level security/);
  } finally {
    await w.close();
  }
});

test("a notice's link opens its room and thread at the deployment's own address, and there is none without one", async () => {
  const { noticeLinks } = await import('../../src/owner/member-notify.ts');
  assert.equal(noticeLinks(undefined), undefined, 'no public address, no link');
  const make = noticeLinks((task) => `https://palugada.example/app/?company=${task.companyId}&task=${task.taskId}`)!;
  const room = new URL(make({ companyId: 'c1', roomId: 'r1', threadOf: 'm1' })!);
  assert.equal(room.pathname, '/app/');
  assert.deepEqual([...room.searchParams.entries()], [['company', 'c1'], ['room', 'r1'], ['thread', 'm1']]);
  assert.deepEqual([...new URL(make({ companyId: 'c1', itemId: 'i1' })!).searchParams.entries()], [['company', 'c1'], ['item', 'i1']]);
  assert.equal(noticeLinks(() => null)!({ companyId: 'c1', taskId: 't1' }), null);
});

test('a person taken out of a private room before a notice is planned is owed none', async () => {
  const w = await workspace('notify-removed-early');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = String(ok(await w.owner.makeRoom({ name: 'Board', private: true, members: [budi.seat.principal, sari.seat.principal] })).room.id);
    const id = await said(budi.in, room, mention(sari.seat));
    // She saw the mention, so it is no longer hers to clear when she leaves,
    // and then she was taken out of the room.
    const position = Number((ok(await sari.in.page(room)).messages as Array<{ id: string; position: number }>).find((one) => one.id === id)!.position);
    ok(await sari.in.read(room, { position }));
    ok(await w.owner.members(room, { remove: [sari.seat.principal] }));
    // Asked as the notices are planned, before anything is sent: she can no longer see the room.
    const { planNotices } = await import('../../src/owner/member-notify.ts');
    assert.equal((await planNotices(w.fixture.companyId)).planned, 0);
    assert.deepEqual(await noticesOf(w.fixture.companyId, sari.seat.principal), []);
  } finally {
    await w.close();
  }
});

test('a mention in a room whose notice already went is told as a mention', async () => {
  const w = await workspace('notify-heavier');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Morning.');
    await said(budi.in, dm, 'About the stock count.');
    await tell(w.fixture.companyId, w.api.master);
    // In the same ten minutes, and after she muted the room.
    ok(await sari.in.settings(dm, { mutedUntil: new Date(Date.now() + 3_600_000).toISOString() }));
    await said(budi.in, dm, 'Still here.');
    await said(budi.in, dm, { body: '@sari the till is short, now', mentions: [sari.seat.principal] });
    await said(budi.in, dm, { body: '@sari and the safe', mentions: [sari.seat.principal] });
    await tell(w.fixture.companyId, w.api.master);
    const told = toldTo(w.relay, sari.phone!);
    assert.deepEqual(told.map((one) => [one.data.reasons, one.data.count]), [[['direct'], 2], [['mention'], 2]],
      'the words before it are counted on the first; the mention opens a notice of its own, and the next mention counts on it');
  } finally {
    await w.close();
  }
});

/** Who the mention picker marks as told outside PALUGADA, by name, as a seat's console reads the people list. */
async function marks(w: Workspace, asker: Seat, names: Record<string, string>): Promise<Record<string, boolean>> {
  const people = ok(await w.api.call('GET', `/api/companies/${w.fixture.companyId}/people`, asker.token)).people as Array<{ principal: string; linked: boolean }>;
  return Object.fromEntries(people.map((one) => [names[one.principal] ?? one.principal, one.linked]));
}

test('the mention picker marks who is told outside PALUGADA: a seat with a phone, and the owner only when they hear people', async () => {
  const w = await workspace('notify-linked');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari', 'member', { phone: false });
    const names = { owner: 'owner', [budi.seat.principal]: 'budi', [sari.seat.principal]: 'sari' };
    const ownerPhone = await ownerHears(w, false);
    assert.deepEqual(await marks(w, budi.seat, names), { owner: false, budi: true, sari: false }, 'a phone, and the owner does not hear people');
    ok(await w.api.call('POST', '/api/me/profile', w.ownerToken, { ownerHearsPeople: true }));
    assert.deepEqual(await marks(w, budi.seat, names), { owner: true, budi: true, sari: false });
    ok(await w.api.call('POST', `/api/relays/links/${ownerPhone.linkId}/end`, w.ownerToken, {}));
    assert.deepEqual(await marks(w, budi.seat, names), { owner: false, budi: true, sari: false }, 'no phone, and no chat that takes them');
  } finally {
    await w.close();
  }
});

test("the owner who hears people in their chat alone is marked as told", async () => {
  const telegram = new TelegramChannel({
    token: 'test-bot-token-0000', chatId: '42',
    fetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
  });
  const w = await workspace('notify-linked-chat', { telegram });
  try {
    const budi = await person(w, 'Budi');
    const names = { owner: 'owner', [budi.seat.principal]: 'budi' };
    assert.deepEqual(await marks(w, budi.seat, names), { owner: false, budi: true }, 'a chat, and the owner does not hear people');
    ok(await w.api.call('POST', '/api/me/profile', w.ownerToken, { ownerHearsPeople: true }));
    assert.deepEqual(await marks(w, budi.seat, names), { owner: true, budi: true }, "the owner's chat takes people's notices");
  } finally {
    await w.close();
  }
});

/**
 * A deployment that had rooms before people's notices: the planner starts
 * from the present, not from the first word ever written, or its first pass
 * would tell everyone of everything the rooms had said, to chats and to
 * phones linked before. Run on a database of its own, migrated to just
 * before people's notices, given a company whose rooms have talked, and
 * migrated again.
 */
test('migrating a deployment whose rooms have talked starts its notices at the present', async () => {
  const superuserUrl = process.env.PALUGADA_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const name = `palugada_notices_cursor_${process.pid}`;
  const inside = (url: string) => {
    const at = new URL(url);
    at.pathname = `/${name}`;
    return at.toString();
  };
  const source = new URL('../../db/migrations/', import.meta.url).pathname;
  const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
  const told = files.find((file) => /^\d{4}_people_are_told\.sql$/.test(file));
  assert.ok(told, "the people's notices migration is there");
  const before = await mkdtemp(join(tmpdir(), 'palugada-before-notices-'));
  const all = await mkdtemp(join(tmpdir(), 'palugada-all-'));
  for (const file of files) {
    await copyFile(join(source, file), join(all, file));
    if (file < told) await copyFile(join(source, file), join(before, file));
  }
  const superuser = new pg.Client({ connectionString: superuserUrl });
  await superuser.connect();
  const ownerUrl = process.env.PALUGADA_OWNER_URL;
  try {
    await superuser.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await superuser.query(`CREATE DATABASE ${name} OWNER palugada_owner`);
    const setup = new pg.Client({ connectionString: inside(superuserUrl) });
    await setup.connect();
    try {
      for (const extension of ['pgcrypto', 'vector', 'pg_trgm']) await setup.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
      process.env.PALUGADA_OWNER_URL = inside(connectionString('owner'));
      await migrate(before);
      // A company whose rooms have said 42 things, and one whose rooms never spoke.
      const { rows: [talked] } = await setup.query<{ id: string }>("INSERT INTO companies (slug, name) VALUES ('warung', 'Warung') RETURNING id");
      const { rows: [quiet] } = await setup.query<{ id: string }>("INSERT INTO companies (slug, name) VALUES ('studio', 'Studio') RETURNING id");
      await setup.query('INSERT INTO room_clock (company_id, position) VALUES ($1, 42), ($2, 0)', [talked!.id, quiet!.id]);

      assert.deepEqual(await migrate(all), files.filter((file) => file >= told));
      const { rows } = await setup.query<{ company_id: string; position: string; through: string }>(
        'SELECT company_id, position, notices_through AS through FROM room_clock ORDER BY position DESC');
      assert.deepEqual(rows.map((row) => [row.company_id, Number(row.position), Number(row.through)]),
        [[talked!.id, 42, 42], [quiet!.id, 0, 0]]);
      const { rows: forced } = await setup.query<{ forced: boolean }>("SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'room_clock'");
      assert.equal(forced[0]!.forced, true, 'and its row security is forced again');
    } finally {
      await setup.end();
    }
  } finally {
    if (ownerUrl === undefined) delete process.env.PALUGADA_OWNER_URL;
    else process.env.PALUGADA_OWNER_URL = ownerUrl;
    await superuser.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await superuser.end();
    await rm(before, { recursive: true, force: true });
    await rm(all, { recursive: true, force: true });
  }
});

/**
 * What each person was told is bookkeeping, kept a month and no longer
 * (STATUS 2.213), and the rooms' feed two weeks (STATUS 2.212). Retention
 * removes both, so a month holds on a worker whose notify stage never runs:
 * one started with no owner's channel and no relay paired plans nothing. The
 * planner removes old notices hourly as well. A notice younger than the
 * month stays, so a window and a day's count are still read from it.
 */
test("a person's notices are kept thirty days, and the rooms' feed two weeks", async () => {
  const { runRetention } = await import('../../src/retention/retention.ts');
  const { planNotices } = await import('../../src/owner/member-notify.ts');
  const w = await workspace('notify-kept');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    await said(budi.in, await direct(budi.in, sari.seat), 'Lunch at noon?');
    await said(budi.in, room, mention(sari.seat));
    await tell(w.fixture.companyId, w.api.master);
    const told = await noticesOf(w.fixture.companyId, sari.seat.principal);
    assert.equal(told.length, 2);
    const [old, young] = told.map((row) => row.id);
    await withControlPlane(async (tx) => {
      await tx.query("UPDATE people_notices SET created_at = now() - interval '31 days' WHERE id = $1", [old]);
      await tx.query("UPDATE people_notices SET created_at = now() - interval '29 days' WHERE id = $1", [young]);
      await tx.query("UPDATE room_feed SET created_at = now() - interval '15 days' WHERE company_id = $1", [w.fixture.companyId]);
    });
    const { rows: [counted] } = await withControlPlane((tx) => tx.query<{ changes: number }>(
      'SELECT count(*)::int AS changes FROM room_feed WHERE company_id = $1', [w.fixture.companyId]));
    const changes = counted!.changes;
    assert.ok(changes > 0);

    // The retention stage alone, with no planner's pass between.
    const outcome = await runRetention(w.fixture.companyId);
    assert.deepEqual((await noticesOf(w.fixture.companyId, sari.seat.principal)).map((row) => row.id), [young],
      'a notice is kept a month');
    assert.equal(outcome.bookkeepingPurged, changes + 1, "the notice and the rooms' feed are counted with the bookkeeping");
    const feed = await withControlPlane((tx) => tx.query('SELECT 1 FROM room_feed WHERE company_id = $1', [w.fixture.companyId]));
    assert.equal(feed.rows.length, 0, 'what changed in the rooms is kept two weeks');

    // And the planner's next hourly pass, when the other comes of age.
    await withControlPlane((tx) => tx.query("UPDATE people_notices SET created_at = now() - interval '31 days' WHERE id = $1", [young]));
    await planNotices(w.fixture.companyId, { now: new Date(Date.now() + 2 * 3_600_000) });
    assert.deepEqual(await noticesOf(w.fixture.companyId, sari.seat.principal), []);
  } finally {
    await w.close();
  }
});
