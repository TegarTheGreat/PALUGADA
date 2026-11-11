/**
 * A notice's link names nothing a relay could join on (F19.19; STATUS
 * section 2.216).
 *
 * A link opens PALUGADA where a notice is about: an item, a task, a room and
 * a thread. Written with those ids, it told every relay the company, the room
 * and who shares it, whatever the share, and let two relays join what each
 * knew. So a link carries a handle made for that one notice, and the console
 * resolves it after the person it was for signs in; to anyone else, the
 * owner included, it opens nothing.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { RelayChannel } from '../../src/relay/channel.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { fakeRelay } from '../helpers/fake-relay.ts';
import { handToRelay, linkThrough, opens, pairThrough, sendOutbox } from '../helpers/relay.ts';
import { tell, toldTo } from '../helpers/notices.ts';
import { companyRoomOf, personIn, said, seated } from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

test("no company, room, thread, item or task id reaches a relay, and a notice's link opens only for the person it was for", async () => {
  const fixture = await createCompany('relay-links-opaque');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const ownerToken = await api.signIn();
    const relayId = await pairThrough(api, ownerToken, relay, { companies: [fixture.companyId], share: 'content', mayPress: true });
    const ownerPhone = await linkThrough(api, ownerToken, relay, relayId, { device: true });
    const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const room = await companyRoomOf(budiIn);
    await companyRoomOf(sariIn);
    const sariPhone = await linkThrough(api, sari.token, relay, relayId, { device: true, owner: false });

    // A mention in a thread, an approval for the owner, and work done.
    const root = await said(budiIn, room, 'The van is here.');
    await said(budiIn, room, { body: '@sari can you sign for it?', mentions: [sari.principal], threadOf: root });
    await tell(fixture.companyId, api.master);
    const itemId = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, actionSummary: 'Send the newsletter',
      rationale: 'ready', consequenceIfDenied: 'not sent',
    });
    await handToRelay(fixture.companyId, relayId);
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'count the stock' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    const channel = new RelayChannel(relayId);
    await channel.prepare();
    await channel.deliverNotice!({
      companyId: fixture.companyId, taskId: task.id, text: 'Done: count the stock', language: 'en',
      url: `https://palugada.example/?company=${fixture.companyId}&task=${task.id}`,
    });
    await sendOutbox(api.master);

    // Nothing the relay was sent names a company, room, thread, item or task.
    const sent = relay.received.filter((one) => one.envelope?.type !== 'pair_request');
    const ids = new Set([fixture.companyId, room, root, itemId, task.id]);
    for (const one of sent) {
      const named = (one.body.match(UUID) ?? []).filter((id: string) => ids.has(id));
      assert.deepEqual(named, [], `${one.envelope.type} names ${named.join(', ')}`);
    }
    const mention = toldTo(relay, sariPhone).find((one) => one.type === 'room_activity')!;
    const approval = toldTo(relay, ownerPhone).find((one) => one.type === 'inbox_item')!;
    const done = toldTo(relay, ownerPhone).find((one) => one.type === 'work_done')!;
    for (const one of [mention, approval, done]) {
      assert.match(String(one.link), /^https:\/\/palugada\.example\/\?notice=[A-Za-z0-9_-]{32}$/, `${one.type}'s link is a handle`);
    }
    assert.notEqual(new URL(mention.link).searchParams.get('notice'), new URL(approval.link).searchParams.get('notice'), 'one handle a notice');

    // Each opens, after sign-in, for the person it was for.
    const forSari = await opens(api, sari.token, mention.link);
    assert.equal(forSari.status, 200, JSON.stringify(forSari.body));
    assert.deepEqual(forSari.body, { companyId: fixture.companyId, roomId: room, threadOf: root, itemId: null, taskId: null });
    const forOwner = await opens(api, ownerToken, approval.link);
    assert.deepEqual(forOwner.body, { companyId: fixture.companyId, roomId: null, threadOf: null, itemId, taskId: null });
    assert.deepEqual((await opens(api, ownerToken, done.link)).body.taskId, task.id);

    // And for nobody else: not another seat, not the owner, not a handle made up.
    for (const [token, link, who] of [[budi.token, mention.link, 'another seat'], [ownerToken, mention.link, 'the owner'],
      [sari.token, approval.link, 'a seat, for the owner\'s']] as const) {
      const refused = await opens(api, token, link);
      assert.deepEqual([refused.status, refused.body.code], [404, 'relay.notice_unknown'], who);
    }
    const madeUp = await api.call('GET', `/api/relays/notices/${'A'.repeat(32)}`, ownerToken);
    assert.deepEqual([madeUp.status, madeUp.body.code], [404, 'relay.notice_unknown']);
    const malformed = await api.call('GET', `/api/relays/notices/${randomUUID()}`, ownerToken);
    assert.equal(malformed.status, 404);
    const signedOut = await api.call('GET', `/api/relays/notices/${new URL(mention.link).searchParams.get('notice')}`, '');
    assert.equal(signedOut.status, 401);
  } finally {
    await api.close();
    await relay.close();
  }
});
