/**
 * People's notices through a relay, and what a person may send back from one
 * (F19.13, F19.20; STATUS section 2.213).
 *
 * A person is told through a relay only once they linked a phone and the
 * relay claimed its code, and only what is theirs: their direct messages,
 * their mentions, the questions put to them, the approvals they may decide.
 * With a notice about a room come tokens for that room alone: a reply, when
 * the owner allowed replies, which lands in the room and thread the notice
 * named as a plain message by that person and never as work; a read mark;
 * and a mute. A link made with a device key needs the device's signature on
 * every one of them. A message deleted is retracted where it went and never
 * sent where it had not; a revoked seat's link stops at once; a seat's press
 * is held to what the seat may do now and to four eyes; and a notice held
 * back by a relay that failed is sent once, under one id.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, createRootTaskWithin, transition } from '../../src/engine/tasks.ts';
import { instructTask } from '../../src/engine/owner-control.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { deviceSignature, fakeRelay, sha256Hex, type FakeRelay } from '../helpers/fake-relay.ts';
import { handToRelay, linkThrough, opens, pairThrough, sendOutbox, type Linked } from '../helpers/relay.ts';
import { noticesOf, tell, toldTo } from '../helpers/notices.ts';
import { companyRoomOf, ok, personIn, refusedWith, said, seated, type Console, type PersonIn, type Seat } from '../helpers/rooms.ts';
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

async function workspace(
  slug: string,
  options: {
    share?: 'signal' | 'summary' | 'content'; mayPress?: boolean; mayPost?: boolean; relay?: Parameters<typeof fakeRelay>[0];
    /** Where the companies' files are, for a test whose messages carry files (STATUS 2.212). */
    files?: { root: string };
  } = {},
): Promise<Workspace> {
  const fixture = await createCompany(slug);
  const relay = await fakeRelay(options.relay);
  const api = await consoleWithSettings(options.files ? { files: options.files } : {});
  const ownerToken = await api.signIn();
  const relayId = await pairThrough(api, ownerToken, relay, {
    companies: [fixture.companyId], share: options.share ?? 'summary',
    ...(options.mayPress ? { mayPress: true } : {}), ...(options.mayPost ? { mayPost: true } : {}),
  });
  return {
    fixture, api, relay, relayId, ownerToken, owner: personIn(api, ownerToken, fixture.companyId),
    close: async () => {
      await api.close();
      await relay.close();
    },
  };
}

async function person(w: Workspace, name: string, kind: 'viewer' | 'member' | 'approver' = 'member', options: { phone?: boolean; relay?: FakeRelay; relayId?: string } = {}) {
  const seat = await seated(w.fixture, name, kind, { handle: name.toLowerCase() });
  const in_ = personIn(w.api, seat.token, w.fixture.companyId);
  await companyRoomOf(in_);
  const phone = options.phone === false
    ? null
    : await linkThrough(w.api, seat.token, options.relay ?? w.relay, options.relayId ?? w.relayId, { device: true, owner: false });
  return { seat, in: in_, phone };
}

const direct = async (from: PersonIn, to: Seat | 'owner') => String(ok(await from.direct([to === 'owner' ? 'owner' : to.principal])).room.id);
const mention = (who: Seat, extra: Record<string, unknown> = {}) => ({ body: `@${who.name.toLowerCase()} have a look`, mentions: [who.principal], ...extra });

/** The tokens a notice was sent with, by what each does. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function offers(envelope: any): Record<string, string> {
  return Object.fromEntries((envelope.offers ?? []).map((offer: { act: string; token: string }) => [offer.act, offer.token]));
}

/**
 * Everything a relay was sent, as one text, to look for words that must never
 * reach it. Look for a phrase with its spaces, not for its number alone: a
 * relay is also sent envelope ids, timestamps, tokens and signatures, in hex,
 * digits and base64, where four digits in a row turn up by chance and a space
 * never does.
 */
function sentTo(relay: FakeRelay): string {
  return JSON.stringify(relay.received);
}

async function deploymentOf(api: Console): Promise<string> {
  return String(((await (await fetch(`${api.url}/api/relay/v1/identity`)).json()) as { deployment: string }).deployment);
}

/** An act as the relay sends it for a person: signed by their device unless the test steals the relay's key alone. */
async function act(
  w: Workspace, linked: Linked, type: 'press' | 'reply' | 'read' | 'mute', token: string,
  extra: { body?: string; clientId?: string; until?: string | null; answer?: string; roomId?: string; threadOf?: string } = {},
  options: { unsigned?: boolean; relay?: FakeRelay; relayId?: string } = {},
) {
  const at = new Date().toISOString();
  const deployment = await deploymentOf(w.api);
  const relayId = options.relayId ?? w.relayId;
  const fields: Record<string, unknown> = { deployment, relay: relayId, recipient: linked.recipient, type, token, at };
  if (type === 'reply') Object.assign(fields, { sha256: sha256Hex(extra.body ?? ''), clientId: extra.clientId });
  if (type === 'press' && extra.answer !== undefined) fields.sha256 = sha256Hex(extra.answer);
  if (type === 'mute') fields.until = extra.until ?? null;
  const signature = linked.device && !options.unsigned ? { device_sig: deviceSignature(linked.device.privateKey, fields) } : {};
  return (options.relay ?? w.relay).push(w.api.url, relayId, (options.relay ?? w.relay).sign({ v: 1, type, at, token, ...extra, ...signature }));
}

async function unread(w: Workspace, token: string) {
  return (ok(await w.api.call('GET', '/api/rooms/unread', token)).unread as Array<{ companyId: string; mentions: number; direct: number; rooms: number }>)
    .find((one) => one.companyId === w.fixture.companyId)!;
}

test('a person is told through a relay only after they confirmed its code', async () => {
  const w = await workspace('relay-people-confirm');
  try {
    const budi = await person(w, 'Budi', 'member', { phone: false });
    const sari = await person(w, 'Sari', 'member', { phone: false });
    // Sari asked for a code and has not entered it yet.
    const offered = ok(await w.api.call('POST', '/api/relays/links', sari.seat.token, { relayId: w.relayId }));
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Before your phone.');
    await tell(w.fixture.companyId, w.api.master);
    assert.deepEqual(await noticesOf(w.fixture.companyId, sari.seat.principal), [], 'nobody is told on a code nobody claimed');

    const claimed = await w.relay.push(w.api.url, w.relayId, w.relay.sign({
      v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.code, label: 'Sari phone',
    }));
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const recipient = String(claimed.body.result.recipient);
    await said(budi.in, dm, 'After your phone.');
    await tell(w.fixture.companyId, w.api.master);
    const told = w.relay.received.filter((one) => one.envelope?.to?.recipient === recipient && one.envelope.type === 'room_activity');
    assert.equal(told.length, 1, 'told of what came after, and not of what came before');
  } finally {
    await w.close();
  }
});

test("a mention and a direct message reach that person's relay, and nobody else's", async () => {
  const w = await workspace('relay-people-whose');
  const other = await fakeRelay();
  try {
    const otherId = await pairThrough(w.api, w.ownerToken, other, { companies: [w.fixture.companyId], share: 'summary' });
    const sari = await person(w, 'Sari');
    const budi = await person(w, 'Budi', 'member', { relay: other, relayId: otherId });
    const ayu = await person(w, 'Ayu', 'member', { relay: other, relayId: otherId });
    const room = await companyRoomOf(w.owner);
    await said(w.owner, await direct(w.owner, sari.seat), 'A word, Sari.');
    await said(w.owner, room, mention(sari.seat));
    await tell(w.fixture.companyId, w.api.master);

    const toSari = toldTo(w.relay, sari.phone!);
    assert.equal(toSari.length, 2);
    assert.ok(toSari.every((one) => one.to.recipient === sari.phone!.recipient));
    // The owner allowed no replies through this relay: a read mark and a mute, and nothing to write with.
    assert.deepEqual(toSari.map((one) => Object.keys(offers(one)).sort()), [['mute', 'read'], ['mute', 'read']]);
    // The other relay, which Budi and Ayu linked through, hears nothing of it.
    assert.deepEqual(other.received.filter((one) => ['room_activity', 'inbox_item'].includes(one.envelope?.type)), []);
    assert.deepEqual([toldTo(other, budi.phone!), toldTo(other, ayu.phone!)], [[], []]);
    // And nothing at all reaches a relay that names who else is in the room or what it holds.
    assert.doesNotMatch(JSON.stringify(toSari), /members|history|rooms/);
  } finally {
    await other.close();
    await w.close();
  }
});

test("a question for a seat reaches that seat's relay, and the owner's only once it escalates", async () => {
  const w = await workspace('relay-people-question');
  try {
    const ownerPhone = await linkThrough(w.api, w.ownerToken, w.relay, w.relayId, { device: true });
    const budi = await person(w, 'Budi');
    const { companyId } = w.fixture;
    const task = await createRootTask({
      companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
      goalId: w.fixture.goalId, input: { goal: 'Choose a supplier' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(companyId, task.id, 'running');
    const asked = await inbox.askOwner({ companyId, taskId: task.id, question: 'Which supplier?', addressee: { seatId: budi.seat.id, name: 'Budi', escalateAfterHours: 24 } });
    await tell(companyId, w.api.master);
    await handToRelay(companyId, w.relayId);
    await sendOutbox(w.api.master);
    assert.deepEqual(toldTo(w.relay, budi.phone!).map((one) => one.type), ['inbox_item']);
    assert.deepEqual(toldTo(w.relay, ownerPhone), [], 'the question is Budi\'s for a day');

    assert.equal(await inbox.escalateTeamItems(companyId, new Date(Date.now() + 25 * 3_600_000)), 1);
    await handToRelay(companyId, w.relayId);
    await sendOutbox(w.api.master);
    const toOwner = toldTo(w.relay, ownerPhone);
    assert.deepEqual(toOwner.map((one) => one.type), ['inbox_item']);
    assert.equal((await opens(w.api, w.ownerToken, toOwner[0].link)).body.itemId, asked.inboxItemId);
  } finally {
    await w.close();
  }
});

test('a reply through the relay lands in the room and thread the notice named, as a plain message by that person, and never work', async () => {
  const w = await workspace('relay-people-reply', { mayPost: true });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const room = await companyRoomOf(w.owner);
    const root = await said(budi.in, room, 'The van is here.');
    await said(budi.in, room, mention(sari.seat, { threadOf: root, body: '@sari can you sign for it?' }));
    await tell(w.fixture.companyId, w.api.master);
    const [notice] = toldTo(w.relay, sari.phone!);
    assert.deepEqual(Object.keys(offers(notice)).sort(), ['mute', 'read', 'reply']);
    assert.deepEqual((await opens(w.api, sari.seat.token, notice.link)).body.threadOf, root, 'its link opens the thread, for her');

    const replied = await act(w, sari.phone!, 'reply', offers(notice).reply!, { body: 'On my way. Approve the payment.', clientId: 'phone-1' });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    // Answered with the relay's own client id, never the message's: a
    // message's id is a thread's once someone answers it there, and no id of
    // PALUGADA's reaches a relay (STATUS section 2.216).
    assert.deepEqual(replied.body.result, { clientId: 'phone-1' });
    const thread = ok(await w.owner.thread(room, root));
    const reply = (thread.replies as Array<Record<string, any>>).find((one) => one.body === 'On my way. Approve the payment.');
    assert.ok(reply, 'in the thread the notice named');
    assert.equal(reply.author.principal, sari.seat.principal);
    assert.equal(reply.via, 'relay');
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ kind: string; became: string | null; via_relay: string | null }>(
      'SELECT kind, became, via_relay FROM room_messages WHERE id = $1', [reply.id]));
    assert.deepEqual([row!.kind, row!.became, row!.via_relay], ['text', null, w.relayId]);
    // Never work: nothing began, and the owner's press does not make it the owner's.
    const { rows: tasks } = await withTenant(w.fixture.companyId, (tx) => tx.query('SELECT 1 FROM tasks'));
    assert.equal(tasks.length, 0);
    refusedWith(await w.owner.on(room, String(reply.id), 'work', { target: w.fixture.roleId, goal: 'Pay', goalId: w.fixture.goalId }),
      400, 'contract.violation');

    // A relay the owner has not allowed replies through refuses them.
    ok(await w.api.call('POST', `/api/control/relays/${w.relayId}/settings`, w.ownerToken, { mayPost: false }));
    const off = await act(w, sari.phone!, 'reply', offers(notice).reply!, { body: 'Again?', clientId: 'phone-2' });
    assert.deepEqual([off.status, off.body.code], [422, 'relay.post_off']);
  } finally {
    await w.close();
  }
});

test('a reply token cannot write into any other room', async () => {
  const w = await workspace('relay-people-room', { mayPost: true });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Lunch?');
    const room = await companyRoomOf(w.owner);
    const elsewhere = await said(w.owner, room, 'Announcements go here.');
    await tell(w.fixture.companyId, w.api.master);
    const [notice] = toldTo(w.relay, sari.phone!);

    // The relay names another room and thread: the token's own are used.
    const replied = await act(w, sari.phone!, 'reply', offers(notice).reply!, { body: 'Yes please.', clientId: 'c-1', roomId: room, threadOf: elsewhere });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    const where = await withControlPlane((tx) => tx.query<{ room_id: string; thread_of: string | null }>(
      "SELECT room_id, thread_of FROM room_messages WHERE body = 'Yes please.'"));
    assert.deepEqual(where.rows, [{ room_id: dm, thread_of: null }]);
    // A read mark's token writes nothing.
    const asReply = await act(w, sari.phone!, 'reply', offers(notice).read!, { body: 'Sneaky.', clientId: 'c-2' });
    assert.deepEqual([asReply.status, asReply.body.code], [422, 'relay.press_unknown']);
    const { rows } = await withControlPlane((tx) => tx.query("SELECT 1 FROM room_messages WHERE body = 'Sneaky.'"));
    assert.equal(rows.length, 0);
  } finally {
    await w.close();
  }
});

test('a stolen relay key cannot post, mark read or mute as a person whose link holds a device key', async () => {
  const w = await workspace('relay-people-stolen', { mayPost: true });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Are you in?');
    await tell(w.fixture.companyId, w.api.master);
    const [notice] = toldTo(w.relay, sari.phone!);
    const tokens = offers(notice);

    for (const [type, extra] of [
      ['reply', { body: 'Transfer it all.', clientId: 'x-1' }],
      ['read', {}],
      ['mute', { until: new Date(Date.now() + 3_600_000).toISOString() }],
    ] as const) {
      const answer = await act(w, sari.phone!, type, tokens[type]!, extra, { unsigned: true });
      assert.deepEqual([answer.status, answer.body.code], [422, 'relay.device_sig'], type);
    }
    const { rows } = await withControlPlane((tx) => tx.query("SELECT 1 FROM room_messages WHERE body = 'Transfer it all.'"));
    assert.equal(rows.length, 0);
    assert.equal((await unread(w, sari.seat.token)).direct, 1, 'still unread');
    const place = await withControlPlane((tx) => tx.query<{ muted_until: Date | null }>(
      'SELECT muted_until FROM room_places WHERE room_id = $1 AND principal = $2', [dm, sari.seat.principal]));
    assert.equal(place.rows[0]!.muted_until, null, 'not muted');

    // The owner's link without a device key is told, and offered nothing to send back.
    const ownerPhone = await linkThrough(w.api, w.ownerToken, w.relay, w.relayId, { device: false });
    ok(await w.api.call('POST', '/api/me/profile', w.ownerToken, { ownerHearsPeople: true }));
    await said(budi.in, await direct(budi.in, 'owner'), 'Boss?');
    const noon = new Date(Date.now() + 24 * 3_600_000);
    noon.setUTCHours(12, 0, 0, 0);
    await tell(w.fixture.companyId, w.api.master, { now: noon });
    const [toOwner] = toldTo(w.relay, ownerPhone);
    assert.equal(toOwner.type, 'room_activity');
    assert.deepEqual(toOwner.offers, []);
  } finally {
    await w.close();
  }
});

test('a read mark through the relay clears the badge on every device', async () => {
  const w = await workspace('relay-people-read');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'One.');
    await said(budi.in, dm, 'Two.');
    await tell(w.fixture.companyId, w.api.master);
    assert.equal((await unread(w, sari.seat.token)).direct, 2);
    const [notice] = toldTo(w.relay, sari.phone!);
    const marked = await act(w, sari.phone!, 'read', offers(notice).read!);
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    // What every one of her devices reads the badge from.
    assert.equal((await unread(w, sari.seat.token)).direct, 0);
    // And what the room stream tells her other devices: a read mark of hers alone, with no words.
    const { rows } = await withControlPlane((tx) => tx.query<{ principal: string }>(
      "SELECT principal FROM room_feed WHERE kind = 'read' AND room_id = $1", [dm]));
    assert.ok(rows.some((row) => row.principal === sari.seat.principal));
  } finally {
    await w.close();
  }
});

test('a muted room is not relayed, except a mention', async () => {
  const w = await workspace('relay-people-mute');
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'First.');
    await tell(w.fixture.companyId, w.api.master);
    const [notice] = toldTo(w.relay, sari.phone!);
    // Muted from the phone, for an hour.
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const muted = await act(w, sari.phone!, 'mute', offers(notice).mute!, { until });
    assert.equal(muted.status, 200, JSON.stringify(muted.body));
    const settings = ok(await sari.in.settings(dm, {}));
    assert.equal(settings.mutedUntil, until);

    await withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [w.fixture.companyId]));
    await said(budi.in, dm, 'Second, while muted.');
    await tell(w.fixture.companyId, w.api.master);
    assert.equal(toldTo(w.relay, sari.phone!).length, 1, 'a muted room is not relayed');
    await said(budi.in, dm, { body: '@sari this one matters', mentions: [sari.seat.principal] });
    await tell(w.fixture.companyId, w.api.master);
    const told = toldTo(w.relay, sari.phone!);
    assert.equal(told.length, 2, 'except a mention');
    assert.deepEqual(told[1].data.reasons, ['mention']);
  } finally {
    await w.close();
  }
});

test("a deleted message's excerpt is retracted at the relay, and an unsent one never goes", async () => {
  let down = false;
  const w = await workspace('relay-people-retract', {
    share: 'content', mayPost: true,
    relay: { answer: (one) => (down && one.envelope?.type === 'room_activity' ? { status: 503 } : undefined) },
  });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    const first = await said(budi.in, dm, 'The safe code is 4242.');
    await tell(w.fixture.companyId, w.api.master);
    const [notice] = toldTo(w.relay, sari.phone!);
    assert.match(notice.data.excerpt, /safe code/);

    ok(await budi.in.on(dm, first, 'delete'));
    await sendOutbox(w.api.master);
    const retracted = toldTo(w.relay, sari.phone!).filter((one) => one.type === 'room_activity_retracted');
    assert.equal(retracted.length, 1);
    assert.deepEqual(retracted[0].data.refs, [notice.id]);
    // Its tokens are void: a reply on it is spent.
    const late = await act(w, sari.phone!, 'reply', offers(notice).reply!, { body: 'Too late?', clientId: 'late' });
    assert.deepEqual([late.status, late.body.code], [422, 'relay.press_spent']);

    // Owed and not yet sent when it is deleted: it never goes, and nothing is retracted.
    await withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [w.fixture.companyId]));
    const second = await said(budi.in, dm, 'The new code is 9090.');
    await tell(w.fixture.companyId, w.api.master, { send: false });
    ok(await budi.in.on(dm, second, 'delete'));
    await sendOutbox(w.api.master);
    assert.doesNotMatch(sentTo(w.relay), /new code is 9090/, 'never sent');
    const owed = await withControlPlane((tx) => tx.query('SELECT 1 FROM relay_outbox WHERE subjects @> ARRAY[$1]::text[]', [`message:${second}`]));
    assert.equal(owed.rows.length, 0);

    // Tried while the relay was failing, then deleted: the relay may have
    // read it before it failed, so it is told to drop it, and it is not tried again.
    down = true;
    await withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [w.fixture.companyId]));
    const tried = await said(budi.in, dm, 'The other code is 7171.');
    await tell(w.fixture.companyId, w.api.master);
    const attempt = w.relay.received.find((one) => one.envelope?.type === 'room_activity' && /other code is 7171/.test(one.body))!;
    ok(await budi.in.on(dm, tried, 'delete'));
    down = false;
    await sendOutbox(w.api.master, new Date(Date.now() + 5 * 60_000));
    const after = toldTo(w.relay, sari.phone!);
    assert.deepEqual(after.filter((one) => one.type === 'room_activity_retracted').at(-1).data.refs, [attempt.id]);
    assert.equal(w.relay.received.filter((one) => one.id === attempt.id).length, 1, 'tried once, never again');

    // Planned and not yet sent when it is deleted: settled, and nothing goes.
    await withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [w.fixture.companyId]));
    const third = await said(budi.in, dm, 'Ignore that.');
    const { planNotices, dispatchPeopleNotices } = await import('../../src/owner/member-notify.ts');
    await planNotices(w.fixture.companyId);
    ok(await budi.in.on(dm, third, 'delete'));
    await dispatchPeopleNotices(w.fixture.companyId);
    const rows = await noticesOf(w.fixture.companyId, sari.seat.principal);
    assert.equal(rows.at(-1)!.settled_as, 'gone');
  } finally {
    await w.close();
  }
});

test("a revoked seat's link stops at once", async () => {
  const w = await workspace('relay-people-revoked', { mayPost: true, relay: { answer: (one) => (one.envelope?.type === 'room_activity' ? { status: 503 } : undefined) } });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Still there?');
    await tell(w.fixture.companyId, w.api.master);
    const owed = await withControlPlane((tx) => tx.query<{ body: string }>(
      "SELECT body FROM relay_outbox WHERE link_id = $1 AND type = 'room_activity'", [sari.phone!.linkId]));
    assert.equal(owed.rows.length, 1, 'owed, the relay being down');
    const tokens = offers(JSON.parse(owed.rows[0]!.body));

    const revoked = await w.api.call('POST', `/api/companies/${w.fixture.companyId}/staff/${sari.seat.id}/revoke`, w.ownerToken, {});
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const left = await withControlPlane((tx) => tx.query<{ type: string }>(
      "SELECT type FROM relay_outbox WHERE link_id = $1 AND status IN ('pending', 'dead')", [sari.phone!.linkId]));
    assert.deepEqual(left.rows.map((row) => row.type), ['link_ended'], 'what it was owed is dropped, and the relay is told the link ended (STATUS section 2.216)');
    const reply = await act(w, sari.phone!, 'reply', tokens.reply!, { body: 'I am still here.', clientId: 'r-1' });
    assert.deepEqual([reply.status, reply.body.code], [410, 'relay.link_ended']);
    // And nothing more is planned for her.
    await said(budi.in, await direct(budi.in, 'owner'), 'Sari left.');
    await tell(w.fixture.companyId, w.api.master);
    assert.ok((await noticesOf(w.fixture.companyId, sari.seat.principal)).every((row) => row.settled_as !== null), 'nothing waits for her');
  } finally {
    await w.close();
  }
});

/** Work a member asked for, running, with a tier 2 card from it: the team's. */
async function teamCard(w: Workspace, asker: Seat): Promise<{ taskId: string; itemId: string }> {
  const { companyId } = w.fixture;
  const taskId = await withTenant(companyId, async (tx) => (await createRootTaskWithin(tx, {
    companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
    goalId: w.fixture.goalId, input: { goal: 'Email the customers' }, createdBy: 'staff', requestedBySeat: asker.id, reserveTokens: 100,
  })).id);
  await transition(companyId, taskId, 'running');
  const itemId = await inbox.requestApproval({
    companyId, taskId, capabilityName: 'email.send', tier: 2, actionSummary: 'Email 40 customers',
    rationale: 'ready', consequenceIfDenied: 'not sent', instigators: [asker.id],
  });
  return { taskId, itemId };
}

test("a seat's press is held to the seat's limits and four eyes", async () => {
  const w = await workspace('relay-people-press', { mayPress: true });
  try {
    const mira = await person(w, 'Mira');
    const rina = await person(w, 'Rina', 'approver');
    const joko = await person(w, 'Joko', 'approver');
    const { companyId } = w.fixture;
    const { taskId, itemId } = await teamCard(w, mira.seat);
    // A question put to Mira, a member: hers to answer, nothing to approve.
    const owners = await createRootTask({
      companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
      goalId: w.fixture.goalId, input: { goal: 'Pick a date' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(companyId, owners.id, 'running');
    const asked = await inbox.askOwner({ companyId, taskId: owners.id, question: 'Which day?', addressee: { seatId: mira.seat.id, name: 'Mira', escalateAfterHours: 24 } });
    await tell(companyId, w.api.master);

    const [toMira] = toldTo(w.relay, mira.phone!).filter((one) => one.type === 'inbox_item');
    assert.deepEqual(Object.keys(offers(toMira)), ['answer'], 'a member answers what is put to it, and approves nothing');
    const answered = await act(w, mira.phone!, 'press', offers(toMira).answer!, { answer: 'Tuesday' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const { rows: [question] } = await withTenant(companyId, (tx) => tx.query<{ status: string; decided_by_seat: string | null }>(
      'SELECT status, decided_by_seat FROM inbox_items WHERE id = $1', [asked.inboxItemId]));
    assert.deepEqual([question!.status, question!.decided_by_seat], ['decided', mira.seat.id]);

    // Rina was offered the team's card; then her own words went into the work.
    const [toRina] = toldTo(w.relay, rina.phone!);
    assert.deepEqual(Object.keys(offers(toRina)).sort(), ['approve', 'deny']);
    await instructTask(companyId, taskId, 'Use the spring template.', { kind: 'seat', seatId: rina.seat.id, name: 'Rina' });
    const refused = await act(w, rina.phone!, 'press', offers(toRina).approve!);
    assert.deepEqual([refused.status, refused.body.code], [422, 'approval.own_instigation'], 'four eyes, through a relay as in the app');
    // Joko, whose words are not in it, decides it.
    const [toJoko] = toldTo(w.relay, joko.phone!);
    const decided = await act(w, joko.phone!, 'press', offers(toJoko).approve!);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.match(String(decided.body.text), /Decided through /);
    const { rows: [item] } = await withTenant(companyId, (tx) => tx.query<{ decision: string; decided_by_seat: string }>(
      'SELECT decision, decided_by_seat FROM inbox_items WHERE id = $1', [itemId]));
    assert.deepEqual([item!.decision, item!.decided_by_seat], ['approve', joko.seat.id]);
    assert.equal(toldTo(w.relay, mira.phone!).filter((one) => one.data?.kind === 'approval').length, 0, 'the seat who asked is not offered its own card');
  } finally {
    await w.close();
  }
});

test('an offer made to an approver who is then made a viewer cannot be pressed', async () => {
  const w = await workspace('relay-people-demoted', { mayPress: true });
  try {
    const mira = await person(w, 'Mira');
    const rina = await person(w, 'Rina', 'approver');
    const { itemId } = await teamCard(w, mira.seat);
    await tell(w.fixture.companyId, w.api.master);
    const [toRina] = toldTo(w.relay, rina.phone!);
    const changed = await w.api.call('POST', `/api/companies/${w.fixture.companyId}/staff/${rina.seat.id}/change`, w.ownerToken, { kind: 'viewer' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const pressed = await act(w, rina.phone!, 'press', offers(toRina).approve!);
    assert.equal(pressed.status, 422);
    assert.ok(['relay.press_spent', 'relay.seat_changed'].includes(String(pressed.body.code)), JSON.stringify(pressed.body));
    const { rows } = await withControlPlane((tx) => tx.query<{ voided: boolean }>(
      "SELECT voided_at IS NOT NULL AS voided FROM relay_offers WHERE principal = $1 AND act IN ('approve', 'deny')", [rina.seat.principal]));
    assert.ok(rows.length > 0 && rows.every((row) => row.voided), 'a kind changed voids the seat\'s offers at once');
    const { rows: [item] } = await withTenant(w.fixture.companyId, (tx) => tx.query<{ status: string }>('SELECT status FROM inbox_items WHERE id = $1', [itemId]));
    assert.equal(item!.status, 'open');
  } finally {
    await w.close();
  }
});

test('a notice held back by a failed relay is sent once, under the same id', async () => {
  let failing = true;
  const w = await workspace('relay-people-held', { relay: { answer: (one) => (failing && one.envelope?.type === 'room_activity' ? { status: 503 } : undefined) } });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    await said(budi.in, await direct(budi.in, sari.seat), 'Can you cover Saturday?');
    await tell(w.fixture.companyId, w.api.master);
    // The worker comes round again while the relay is still down: nothing is made twice.
    await tell(w.fixture.companyId, w.api.master);
    failing = false;
    await sendOutbox(w.api.master, new Date(Date.now() + 5 * 60_000));
    await tell(w.fixture.companyId, w.api.master, { now: new Date(Date.now() + 6 * 60_000) });

    const attempts = w.relay.received.filter((one) => one.envelope?.type === 'room_activity');
    assert.ok(attempts.length >= 2, 'tried, then sent');
    assert.equal(new Set(attempts.map((one) => one.id)).size, 1, 'under one id');
    const { rows } = await withControlPlane((tx) => tx.query<{ status: string }>(
      "SELECT status FROM relay_outbox WHERE type = 'room_activity' AND link_id = $1", [sari.phone!.linkId]));
    assert.deepEqual(rows.map((row) => row.status), ['delivered']);
    assert.equal((await noticesOf(w.fixture.companyId, sari.seat.principal)).length, 1);
  } finally {
    await w.close();
  }
});

test('a notice still owed when the owner narrows the relay is sent at the new share, its reply withdrawn', async () => {
  let down = true;
  const w = await workspace('relay-people-narrow', {
    share: 'content', mayPost: true, relay: { answer: (one) => (down && one.envelope?.type === 'room_activity' ? { status: 503 } : undefined) },
  });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    await said(budi.in, await direct(budi.in, sari.seat), 'The till code is 5150.');
    await tell(w.fixture.companyId, w.api.master);
    const [tried] = toldTo(w.relay, sari.phone!);
    assert.match(tried.data.excerpt, /5150/);
    // Narrowed to signal while the notice is still owed.
    ok(await w.api.call('POST', `/api/control/relays/${w.relayId}/settings`, w.ownerToken, { share: 'signal' }));
    down = false;
    await sendOutbox(w.api.master, new Date(Date.now() + 5 * 60_000));
    const sent = toldTo(w.relay, sari.phone!).at(-1);
    assert.equal(sent.id, tried.id, 'the same envelope, made again');
    assert.equal(sent.share, 'signal');
    assert.equal(sent.text, 'Something new in PALUGADA.');
    assert.deepEqual(Object.keys(sent.data).sort(), ['count', 'reasons']);
    assert.deepEqual(sent.offers.map((offer: { act: string }) => offer.act).sort(), ['mute', 'read'], 'a read mark and a mute stand; the reply goes');
    const reply = offers(tried).reply!;
    const refused = await act(w, sari.phone!, 'reply', reply, { body: 'Late reply.', clientId: 'late-1' });
    assert.equal(refused.status, 422);
  } finally {
    await w.close();
  }
});

test('a message retention takes, or whose delete was cut short, is retracted by the next pass, and what was not sent never goes', async () => {
  const w = await workspace('relay-people-purged', { share: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    const later = () => withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [companyId]));
    // Sent: the relay holds its words.
    const taken = await said(budi.in, dm, 'The vault code is 1111.');
    await tell(companyId, w.api.master);
    const [sent] = toldTo(w.relay, sari.phone!);
    assert.match(sent.data.excerpt, /1111/);
    // Owed, and not yet sent.
    await later();
    const cut = await said(budi.in, dm, 'The vault code is 2222.');
    await tell(companyId, w.api.master, { send: false });

    // Retention takes the first outright and leaves the second a tombstone,
    // or a delete commits and its process stops before it says so: nothing
    // is told of either.
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, companyId);
      await tx.query('DELETE FROM room_messages WHERE company_id = $1 AND id = $2', [companyId, taken]);
      await tx.query('UPDATE room_messages SET deleted_at = now() WHERE company_id = $1 AND id = $2', [companyId, cut]);
    });
    // The relay loop comes round first: what was owed of a removed message is not sent.
    await sendOutbox(w.api.master);
    assert.doesNotMatch(sentTo(w.relay), /vault code is 2222/, 'a removed message is never sent');

    // The notify stage's next pass tells the relay to drop what it holds, and drops what it was owed.
    await tell(companyId, w.api.master);
    const retracted = toldTo(w.relay, sari.phone!).filter((one) => one.type === 'room_activity_retracted');
    assert.equal(retracted.length, 1);
    assert.deepEqual(retracted[0].data.refs, [sent.id]);
    const owed = await withControlPlane((tx) => tx.query(
      "SELECT 1 FROM relay_outbox WHERE type = 'room_activity' AND subjects && $1::text[]", [[`message:${cut}`]]));
    assert.equal(owed.rows.length, 0, 'what was owed of it is dropped');
    const read = await act(w, sari.phone!, 'read', offers(sent).read!);
    assert.deepEqual([read.status, read.body.code], [422, 'relay.press_spent'], 'and its tokens are void');

    // The pass after says nothing more.
    await tell(companyId, w.api.master);
    assert.equal(toldTo(w.relay, sari.phone!).filter((one) => one.type === 'room_activity_retracted').length, 1);
    assert.doesNotMatch(sentTo(w.relay), /vault code is 2222/);
  } finally {
    await w.close();
  }
});

test('a notice on its way when its message is deleted is never sent again, and the relay is told to drop it', async () => {
  const w = await workspace('relay-people-in-flight', { share: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    const message = await said(budi.in, dm, 'The alarm code is 6060.');
    await tell(companyId, w.api.master, { send: false });
    // A process took it to send, and stopped before it learned how the send went.
    const { rows: [owed] } = await withControlPlane((tx) => tx.query<{ id: string }>(
      `UPDATE relay_outbox SET status = 'sending', claimed_at = now() - interval '11 minutes'
        WHERE link_id = $1 AND type = 'room_activity' RETURNING id`, [sari.phone!.linkId]));
    assert.ok(owed);
    ok(await budi.in.on(dm, message, 'delete'));

    // The loop takes it back and does not send it: the relay may have it, so it is told to drop it.
    await sendOutbox(w.api.master);
    assert.doesNotMatch(sentTo(w.relay), /alarm code is 6060/, 'never sent again');
    const told = toldTo(w.relay, sari.phone!);
    assert.deepEqual(told.map((one) => one.type), ['room_activity_retracted']);
    assert.deepEqual(told[0].data.refs, [owed.id]);
    await tell(companyId, w.api.master);
    const left = await withControlPlane((tx) => tx.query('SELECT 1 FROM relay_outbox WHERE id = $1', [owed.id]));
    assert.equal(left.rows.length, 0, 'and it is dropped');
  } finally {
    await w.close();
  }
});

test('a window whose first message is deleted still tells the rest, without the words', async () => {
  const w = await workspace('relay-people-window', { share: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    const first = await said(budi.in, dm, 'The pin is 1234.');
    await said(budi.in, dm, 'And call me when you can.');
    const { planNotices } = await import('../../src/owner/member-notify.ts');
    assert.equal((await planNotices(companyId)).planned, 1, 'two messages, one window');
    ok(await budi.in.on(dm, first, 'delete'));
    await tell(companyId, w.api.master);

    const told = toldTo(w.relay, sari.phone!);
    assert.deepEqual(told.map((one) => one.type), ['room_activity'], 'the second is told');
    assert.equal(told[0].data.count, 2);
    assert.equal(told[0].data.excerpt, undefined, 'with no words: the first is gone, and the second was never its excerpt');
    assert.doesNotMatch(JSON.stringify(told), /pin is 1234|call me/);
    assert.deepEqual((await noticesOf(companyId, sari.seat.principal)).map((row) => row.settled_as), ['sent']);
  } finally {
    await w.close();
  }
});

/**
 * Retention (STATUS 2.212) and the relay (2.213) together, as the worker runs
 * them: the message window passes, the retention stage takes the messages,
 * and the next notify stage tells each relay that holds their words to drop
 * them. A root that keeps its thread because a reply is still alive keeps no
 * words, so what a relay holds of it is retracted as well. Nothing calls the
 * relay from inside the purge, which would take a relay's row after the
 * clock and the messages' rows, the reverse of every other order.
 */
test('what retention takes was dropped at the relay at its fortnight, a root left without its words too, with its files, and what was owed never goes', async () => {
  const { mkdtemp, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setRetention, runRetention } = await import('../../src/retention/retention.ts');
  const root = await mkdtemp(join(tmpdir(), 'palugada-relay-retention-'));
  const w = await workspace('relay-people-retention', { share: 'content', mayPost: true, files: { root } });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    const later = () => withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [companyId]));

    // Sent, with a file: the relay holds its words, and the deployment its bytes.
    const filed = String(ok(await budi.in.say(dm, {
      body: 'The vault code is 1111.', files: [{ name: 'vault.pdf', data: Buffer.from('%PDF-1.4 vault').toString('base64') }],
    }), 'posting with a file').message.id);
    await tell(companyId, w.api.master);
    const [sentFiled] = toldTo(w.relay, sari.phone!);
    assert.match(sentFiled.data.excerpt, /1111/);
    const { rows: [kept] } = await withControlPlane((tx) => tx.query<{ path: string }>(
      'SELECT path FROM room_files WHERE company_id = $1 AND message_id = $2', [companyId, filed]));
    const bytes = join(root, `${companyId}.people`, kept!.path);
    await stat(bytes);
    // Sent, and later replied to: its thread outlives it.
    await later();
    const rooted = await said(budi.in, dm, 'The safe is behind the 3333 painting.');
    await tell(companyId, w.api.master);
    const sentRoot = toldTo(w.relay, sari.phone!).find((one) => one.type === 'room_activity' && /3333/.test(one.data.excerpt ?? ''));
    assert.ok(sentRoot, 'the root was told');
    // Owed, and not yet sent.
    await later();
    const owed = await said(budi.in, dm, 'The vault code is 2222.');
    await tell(companyId, w.api.master, { send: false });
    // A reply that is still young when the window passes the rest.
    const reply = await said(sari.in, dm, { body: 'Noted, thank you.', threadOf: rooted });
    await tell(companyId, w.api.master, { send: false });

    // The window passes between the last of the three and the reply.
    const { rows: ages } = await withControlPlane((tx) => tx.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM room_messages WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, [owed, reply]]));
    const ageOf = (id: string) => ages.find((row) => row.id === id)!.created_at.getTime();
    const at = new Date((ageOf(owed) + ageOf(reply)) / 2 + 30 * 86_400_000);
    await setRetention(companyId, { messageDays: 30 });
    const outcome = await runRetention(companyId, at, { filesRoot: root });
    assert.equal(outcome.messagesPurged, 3, 'two taken outright, and the root left without its words');
    const left = await withControlPlane((tx) => tx.query<{ id: string; body: string | null; deleted: boolean }>(
      'SELECT id, body, deleted_at IS NOT NULL AS deleted FROM room_messages WHERE company_id = $1 ORDER BY position', [companyId]));
    assert.deepEqual(left.rows, [
      { id: rooted, body: null, deleted: true },
      { id: reply, body: 'Noted, thank you.', deleted: false },
    ]);
    await assert.rejects(stat(bytes), /ENOENT/, 'the file went with its message');
    const files = await withControlPlane((tx) => tx.query('SELECT 1 FROM room_files WHERE company_id = $1', [companyId]));
    assert.equal(files.rows.length, 0, 'and its row');

    // Retention keeps a message thirty days at least, and the deployment its
    // relays' envelopes a fortnight (STATUS section 2.216): by the time
    // retention takes a message, what told of it is gone from the outbox, as
    // the protocol requires a relay to have dropped it (docs/relay-protocol.md,
    // section 10). The relay loop's daily bookkeeping runs at that moment too.
    const { relayBookkeeping } = await import('../../src/relay/loop.ts');
    await relayBookkeeping(at);
    // The relay loop comes round first: what was owed of a message retention took is not sent.
    await sendOutbox(w.api.master);
    assert.doesNotMatch(sentTo(w.relay), /vault code is 2222/, 'what retention took before it went never goes');
    // The notify stage's next pass drops what it was owed; there is nothing
    // left at the deployment for a retraction to name.
    await tell(companyId, w.api.master);
    const retracted = toldTo(w.relay, sari.phone!).filter((one) => one.type === 'room_activity_retracted');
    assert.deepEqual(retracted, [], 'the relay was bound to drop it a fortnight after it was sent');
    const still = await withControlPlane((tx) => tx.query(
      "SELECT 1 FROM relay_outbox WHERE type = 'room_activity' AND subjects && $1::text[]", [[`message:${owed}`, `message:${filed}`, `message:${rooted}`]]));
    assert.equal(still.rows.length, 0, 'nothing of what it took is left in the outbox');
    for (const [notice, what] of [[sentFiled, 'the message taken'], [sentRoot, 'the root left without words']] as const) {
      const late = await act(w, sari.phone!, 'reply', offers(notice).reply!, { body: 'Still there?', clientId: `late-${what}` });
      assert.deepEqual([late.status, late.body.code], [422, 'relay.press_unknown'], `a reply on ${what} finds no token`);
    }
    // No token Sari was sent, or was to be sent, about what retention took is left to press.
    const usable = await withControlPlane((tx) => tx.query<{ act: string }>(
      'SELECT act FROM relay_offers WHERE link_id = $1 AND voided_at IS NULL AND uses < max_uses', [sari.phone!.linkId]));
    assert.deepEqual(usable.rows, [], 'no offer is left pointing at a message retention took');
    // The reply lives on: Budi is told of it, and nothing of his is retracted.
    const budiHeard = toldTo(w.relay, budi.phone!);
    assert.ok(budiHeard.some((one) => one.type === 'room_activity' && /Noted/.test(one.data.excerpt ?? '')), 'the live reply is told');
    assert.deepEqual(budiHeard.filter((one) => one.type === 'room_activity_retracted'), []);

    // The pass after says nothing more.
    await tell(companyId, w.api.master);
    assert.equal(toldTo(w.relay, sari.phone!).filter((one) => one.type === 'room_activity_retracted').length, 0);
  } finally {
    await w.close();
  }
});

test('a person taken out of a private room after their notice was written is not sent it, then or from the dead letters', async () => {
  // STATUS section 2.216: the relay loop asks again, as it sends,
  // whether the person may still see the room a notice is about.
  let down = true;
  const w = await workspace('relay-people-removed-late', { share: 'content', relay: { answer: (one) => (down && one.envelope?.type === 'room_activity' ? { status: 503 } : undefined) } });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const room = String(ok(await budi.in.makeRoom({ name: 'HR', private: true, members: [sari.seat.principal] })).room.id);
    await said(budi.in, room, { body: '@sari the restructuring list is final, keep it quiet', mentions: [sari.seat.principal] });
    // Written into the outbox, then tried and failed until it is a dead letter.
    await tell(companyId, w.api.master, { send: false });
    for (let attempt = 0; attempt < 8; attempt += 1) await sendOutbox(w.api.master, new Date(Date.now() + attempt * 3_600_000));
    const { rows: dead } = await withControlPlane((tx) => tx.query<{ status: string }>(
      "SELECT status FROM relay_outbox WHERE relay_id = $1 AND type = 'room_activity'", [w.relayId]));
    assert.deepEqual(dead.map((row) => row.status), ['dead']);
    // Sari is taken out of the room; the relay comes back; the owner retries the dead letters.
    ok(await budi.in.members(room, { remove: [sari.seat.principal] }), 'Sari removed');
    const before = w.relay.received.length;
    down = false;
    ok(await w.api.call('POST', `/api/control/relays/${w.relayId}/retry`, w.ownerToken, {}));
    await sendOutbox(w.api.master, new Date(Date.now() + 9 * 3_600_000));
    assert.deepEqual(w.relay.received.slice(before).map((one) => one.envelope?.type).filter((type) => type === 'room_activity'), [],
      'nothing of the room reaches her relay after she left it');
    const { rows: left } = await withControlPlane((tx) => tx.query(
      "SELECT 1 FROM relay_outbox WHERE relay_id = $1 AND type = 'room_activity'", [w.relayId]));
    assert.equal(left.length, 0, 'the envelope is dropped, not kept waiting');
    const { rows: usable } = await withControlPlane((tx) => tx.query(
      'SELECT 1 FROM relay_offers WHERE link_id = $1 AND voided_at IS NULL', [sari.phone!.linkId]));
    assert.equal(usable.length, 0, 'and its tokens are void');
  } finally {
    await w.close();
  }
});

test("a deleted message's words leave the deployment's outbox at once, from the envelope already delivered too", async () => {
  // STATUS section 2.216: F19.4's removal takes the words at once.
  const w = await workspace('relay-people-delete-blanks', { share: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    const message = await said(budi.in, dm, 'The safe code is 4242.');
    await tell(companyId, w.api.master);
    const [sent] = toldTo(w.relay, sari.phone!);
    assert.match(sent.data.excerpt, /4242/);
    ok(await budi.in.on(dm, message, 'delete'));
    await tell(companyId, w.api.master);
    const { rows } = await withControlPlane((tx) => tx.query<{ type: string; status: string; body: string }>(
      'SELECT type, status, body FROM relay_outbox WHERE relay_id = $1 ORDER BY created_at', [w.relayId]));
    assert.ok(rows.some((row) => row.type === 'room_activity_retracted'), 'the relay is told to drop it');
    assert.deepEqual(rows.filter((row) => row.body.includes('4242')).map((row) => `${row.type}:${row.status}`), [],
      'no row the deployment keeps still holds the deleted words');
    const kept = rows.find((row) => row.type === 'room_activity')!;
    assert.deepEqual(Object.keys(JSON.parse(kept.body)).sort(), ['at', 'deployment', 'id', 'relay', 'to', 'type', 'v'],
      'what is left of the delivered envelope only addresses it');
  } finally {
    await w.close();
  }
});

test("a run's choices reach a seat's phone redacted, as its question does", async () => {
  // STATUS section 2.216.
  const { redactor } = await import('../../src/secrets/manager.ts');
  const secret = 'sk-live-SEATCHOICESECRET0216';
  redactor.register(secret);
  const w = await workspace('relay-people-choices-redacted', { share: 'content', mayPress: true });
  try {
    const budi = await person(w, 'Budi');
    const { companyId } = w.fixture;
    const task = await createRootTask({
      companyId, projectId: w.fixture.projectId, divisionId: w.fixture.divisionId, roleId: w.fixture.roleId,
      goalId: w.fixture.goalId, input: { goal: 'Pick a key' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(companyId, task.id, 'running');
    await inbox.askOwner({
      companyId, taskId: task.id, question: `Use ${secret} or the test key?`, options: [secret, 'the test key'],
      addressee: { seatId: budi.seat.id, name: 'Budi', escalateAfterHours: 24 },
    });
    await tell(companyId, w.api.master);
    const question = toldTo(w.relay, budi.phone!).find((one) => one.type === 'inbox_item')!;
    assert.ok(question, 'the question is told');
    assert.equal(JSON.stringify(question).includes(secret), false);
    assert.deepEqual(question.data.options, ['[redacted]', 'the test key']);
    assert.deepEqual(question.offers.map((offer: { label: string }) => offer.label), ['[redacted]', 'the test key', 'Answer']);
  } finally {
    await w.close();
  }
});

test('a company erased is forgotten at every relay that may hold anything of it', async () => {
  // STATUS section 2.216: the erasure's cascade takes every envelope of
  // the company and every link of its seats, so the relays are told first.
  const { eraseDueCompanies } = await import('../../src/governance/closing.ts');
  const { companyRef } = await import('../../src/relay/envelope.ts');
  const w = await workspace('relay-people-erased', { share: 'content' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'My home address is Jalan Mawar 12.');
    await tell(companyId, w.api.master);
    assert.ok(toldTo(w.relay, sari.phone!).some((one) => /Jalan Mawar/.test(one.data?.excerpt ?? '')), 'the relay holds it');
    await withControlPlane((tx) => tx.query(
      "UPDATE companies SET closing_at = now() - interval '31 days', erase_after = now() - interval '1 minute' WHERE id = $1", [companyId]));
    const before = w.relay.received.length;
    const pass = await eraseDueCompanies({});
    assert.equal(pass.erased.length, 1, JSON.stringify(pass.failed));
    await sendOutbox(w.api.master);
    const after = w.relay.received.slice(before).map((one) => one.envelope);
    const forgotten = after.filter((one) => one?.type === 'company_forgotten');
    assert.equal(forgotten.length, 1, 'the relay is told to forget the company');
    const { rows: [relay] } = await withControlPlane((tx) => tx.query<{ salt: Buffer }>('SELECT salt FROM relays WHERE id = $1', [w.relayId]));
    assert.deepEqual(forgotten[0].company, { ref: companyRef(relay!.salt, companyId) }, 'by the reference that relay knows it by, and nothing else');
    assert.equal(JSON.stringify(forgotten[0]).includes(companyId), false);
    // Erased twice over -- a pass that failed after telling and is tried again -- it is told once.
    const { forgetCompanyAtRelays } = await import('../../src/relay/relays.ts');
    assert.equal(await forgetCompanyAtRelays(companyId), 0);
  } finally {
    await w.close();
  }
});

test("a device's signed act is taken once: sent again under another id it is refused, so an old mute cannot quiet a room heard again", async () => {
  // STATUS section 2.216.
  const w = await workspace('relay-people-device-replay', { share: 'summary' });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Lunch?');
    await tell(companyId, w.api.master);
    const [notice] = toldTo(w.relay, sari.phone!);
    const deployment = await deploymentOf(w.api);
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const token = offers(notice).mute!;
    const fields = { deployment, relay: w.relayId, recipient: sari.phone!.recipient, type: 'mute', token, at, until };
    const body = { v: 1, type: 'mute', at, token, until, device_sig: deviceSignature(sari.phone!.device!.privateKey, fields) };
    const muted = await w.relay.push(w.api.url, w.relayId, w.relay.sign(body));
    assert.equal(muted.status, 200, JSON.stringify(muted.body));
    const heard = await act(w, sari.phone!, 'mute', token, { until: null });
    assert.equal(heard.status, 200, JSON.stringify(heard.body));
    const replayed = await w.relay.push(w.api.url, w.relayId, w.relay.sign(body));
    assert.deepEqual([replayed.status, replayed.body.code], [422, 'relay.device_replayed']);
  } finally {
    await w.close();
  }
});

test('a reply whose client id the person used before, elsewhere or for other words, is refused rather than answered with the old message', async () => {
  // STATUS section 2.216: a client id is the person's, unique for all time.
  const w = await workspace('relay-people-client-id', { share: 'summary', mayPost: true });
  try {
    const budi = await person(w, 'Budi');
    const sari = await person(w, 'Sari');
    const { companyId } = w.fixture;
    const dm = await direct(budi.in, sari.seat);
    await said(budi.in, dm, 'Lunch?');
    await tell(companyId, w.api.master);
    const first = toldTo(w.relay, sari.phone!).find((one) => one.type === 'room_activity');
    const clientId = 'c1a2b3c4-0000-4000-8000-000000000216';
    const answered = await act(w, sari.phone!, 'reply', offers(first).reply!, { body: 'Yes, at one.', clientId });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const retried = await act(w, sari.phone!, 'reply', offers(first).reply!, { body: 'Yes, at one.', clientId });
    assert.deepEqual([retried.status, retried.body.result], [200, answered.body.result]);
    const { rows: posted } = await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, companyId);
      return tx.query('SELECT 1 FROM room_messages WHERE company_id = $1 AND client_id = $2', [companyId, clientId]);
    });
    assert.equal(posted.length, 1, 'the same reply sent twice is one message');
    const reworded = await act(w, sari.phone!, 'reply', offers(first).reply!, { body: 'Yes, at two.', clientId });
    assert.deepEqual([reworded.status, reworded.body.code], [422, 'relay.client_id_used']);

    await withControlPlane((tx) => tx.query("UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [companyId]));
    const room = await companyRoomOf(budi.in);
    await said(budi.in, room, mention(sari.seat, { body: '@sari the delivery is short by two boxes' }));
    await tell(companyId, w.api.master);
    const second = toldTo(w.relay, sari.phone!).filter((one) => one.type === 'room_activity').at(-1);
    const elsewhere = await act(w, sari.phone!, 'reply', offers(second).reply!, { body: 'Yes, at one.', clientId });
    assert.deepEqual([elsewhere.status, elsewhere.body.code], [422, 'relay.client_id_used'], 'the same id in another room is no retry');
  } finally {
    await w.close();
  }
});

test('a link that ends in PALUGADA is told to its relay, naming the claim that made it and why', async () => {
  // STATUS section 2.216.
  const w = await workspace('relay-people-link-ended');
  try {
    const budi = await person(w, 'Budi');
    const ended = () => w.relay.received.map((one) => one.envelope).filter((one) => one?.type === 'link_ended');
    // A second phone linked through the same relay replaces the first.
    const claimOf = async (linkId: string) => (await withControlPlane((tx) => tx.query<{ claim_id: string | null }>(
      'SELECT claim_id FROM relay_links WHERE id = $1', [linkId]))).rows[0]!.claim_id;
    const firstClaim = await claimOf(budi.phone!.linkId);
    assert.ok(firstClaim, 'the claim that made a link is kept');
    // Budi reads PALUGADA in Indonesian, though the deployment speaks English:
    // what his relay is told of his own links is said in his language.
    ok(await w.api.call('POST', '/api/me/profile', budi.seat.token, { language: 'id' }));
    const second = await linkThrough(w.api, budi.seat.token, w.relay, w.relayId, { device: true, owner: false });
    await sendOutbox(w.api.master);
    assert.deepEqual(ended().map((one) => [one.to.recipient, one.data.claim, one.data.reason]), [[budi.phone!.recipient, firstClaim, 'replaced']]);
    assert.deepEqual([ended()[0].lang, ended()[0].text], ['id', 'Ponsel ini tidak lagi ditautkan ke PALUGADA.']);
    const confirmed = w.relay.received.map((one) => one.envelope).filter((one) => one?.type === 'link_confirmed').at(-1);
    assert.equal(confirmed.lang, 'id', 'and that his new link stands');
    // Budi unlinks in PALUGADA.
    ok(await w.api.call('POST', `/api/relays/links/${second.linkId}/end`, budi.seat.token, {}));
    await sendOutbox(w.api.master);
    assert.deepEqual(ended().at(-1).data, { claim: await claimOf(second.linkId), reason: 'unlinked' });
    // A seat revoked: its link ends with it.
    const sari = await person(w, 'Sari');
    ok(await w.api.call('POST', `/api/companies/${w.fixture.companyId}/staff/${sari.seat.id}/revoke`, w.ownerToken, { proof: { totp: w.api.code() } }));
    await sendOutbox(w.api.master);
    assert.deepEqual(ended().at(-1).data.reason, 'seat_ended');
    assert.equal(ended().at(-1).to.recipient, sari.phone!.recipient);
  } finally {
    await w.close();
  }
});
