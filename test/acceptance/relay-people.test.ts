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
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, createRootTaskWithin, transition } from '../../src/engine/tasks.ts';
import { instructTask } from '../../src/engine/owner-control.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { deviceSignature, fakeRelay, sha256Hex, type FakeRelay } from '../helpers/fake-relay.ts';
import { handToRelay, linkThrough, pairThrough, sendOutbox, type Linked } from '../helpers/relay.ts';
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
  options: { share?: 'signal' | 'summary' | 'content'; mayPress?: boolean; mayPost?: boolean; relay?: Parameters<typeof fakeRelay>[0] } = {},
): Promise<Workspace> {
  const fixture = await createCompany(slug);
  const relay = await fakeRelay(options.relay);
  const api = await consoleWithSettings();
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
    assert.match(String(toOwner[0].link), new RegExp(asked.inboxItemId));
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
    assert.match(String(notice.link), new RegExp(`thread=${root}`));

    const replied = await act(w, sari.phone!, 'reply', offers(notice).reply!, { body: 'On my way. Approve the payment.', clientId: 'phone-1' });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
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
    assert.doesNotMatch(JSON.stringify(w.relay.received), /9090/, 'never sent');
    const owed = await withControlPlane((tx) => tx.query('SELECT 1 FROM relay_outbox WHERE subjects @> ARRAY[$1]::text[]', [`message:${second}`]));
    assert.equal(owed.rows.length, 0);

    // Tried while the relay was failing, then deleted: the relay may have
    // read it before it failed, so it is told to drop it, and it is not tried again.
    down = true;
    await withControlPlane((tx) => tx.query(
      "UPDATE people_notices SET created_at = created_at - interval '11 minutes' WHERE company_id = $1", [w.fixture.companyId]));
    const tried = await said(budi.in, dm, 'The other code is 7171.');
    await tell(w.fixture.companyId, w.api.master);
    const attempt = w.relay.received.find((one) => one.envelope?.type === 'room_activity' && /7171/.test(one.body))!;
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
    const left = await withControlPlane((tx) => tx.query("SELECT 1 FROM relay_outbox WHERE link_id = $1 AND status IN ('pending', 'dead')", [sari.phone!.linkId]));
    assert.equal(left.rows.length, 0, 'what it was owed is dropped');
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
