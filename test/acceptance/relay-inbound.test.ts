/**
 * What a relay may send back, and nothing more (F19.20; STATUS section 2.208).
 *
 * An envelope from a relay counts only with that relay's signature, fresh,
 * and once; nothing is written for one that is not, so the open route cannot
 * be made to fill a table. The only act that changes anything here is a press
 * of an offer made to that person for that item, once, at tier 2 or below,
 * recorded as a decision from a chat; presses are off until the owner turns
 * them on; a link made with a device key needs the device's signature on
 * every act, and the owner's link counts for nothing without one. A seat's
 * kind is read again when it presses. A relay cannot assign, instruct, call
 * a meeting or change a setting.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { relayPass } from '../../src/relay/loop.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { deviceSignature, fakeRelay, sha256Hex, type FakeRelay } from '../helpers/fake-relay.ts';
import { handToRelay, linkThrough, pairThrough, sendOutbox, type Console, type Linked } from '../helpers/relay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function approval(companyId: string, tier: 0 | 1 | 2 | 3, summary: string, instigators: string[] = []): Promise<string> {
  return inbox.requestApproval({
    companyId, capabilityName: 'email.send', tier, actionSummary: summary,
    rationale: 'ready', consequenceIfDenied: 'not sent', ...(instigators.length > 0 ? { instigators } : {}),
  });
}

/** The offers the relay was sent for one item, by act. */
function offersFor(relay: FakeRelay, itemLink: string): Record<string, string> {
  const one = relay.received.filter((received) => received.envelope?.type === 'inbox_item' && String(received.envelope.link).includes(itemLink)).at(-1);
  assert.ok(one, `the relay was told of ${itemLink}`);
  return Object.fromEntries(one.envelope.offers.map((offer: { act: string; token: string }) => [offer.act, offer.token]));
}

async function identityOf(api: Console): Promise<{ deployment: string }> {
  return (await fetch(`${api.url}/api/relay/v1/identity`)).json() as Promise<{ deployment: string }>;
}

/** A press as the relay sends it, signed by the device when the link has one. */
async function press(
  api: Console, relay: FakeRelay, relayId: string, linked: Linked, token: string,
  extra: { answer?: string; unsigned?: boolean } = {},
) {
  const at = new Date().toISOString();
  const { deployment } = await identityOf(api);
  const device = linked.device && !extra.unsigned
    ? {
      device_sig: deviceSignature(linked.device.privateKey, {
        deployment, relay: relayId, recipient: linked.recipient, type: 'press', token, at,
        ...(extra.answer !== undefined ? { sha256: sha256Hex(extra.answer) } : {}),
      }),
    }
    : {};
  return relay.push(api.url, relayId, relay.sign({
    v: 1, type: 'press', at, token, ...(extra.answer !== undefined ? { answer: extra.answer } : {}), ...device,
  }));
}

async function itemState(companyId: string, itemId: string) {
  const { rows: [row] } = await withTenant(companyId, (tx) => tx.query<{
    status: string; decision: string | null; decided_via: string | null; decided_by_seat: string | null; owner_note: string | null;
  }>('SELECT status, decision, decided_via, decided_by_seat, owner_note FROM inbox_items WHERE id = $1', [itemId]));
  return row!;
}

/** The owner's console, a relay paired for one company with presses on, and the owner's phone linked with a device key. */
async function ready(slug: string, options: { device?: boolean; mayPress?: boolean; share?: 'summary' | 'content' } = {}) {
  const fixture = await createCompany(slug);
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  const token = await api.signIn();
  const relayId = await pairThrough(api, token, relay, {
    companies: [fixture.companyId], share: options.share ?? 'summary', mayPress: options.mayPress ?? true,
  });
  const linked = await linkThrough(api, token, relay, relayId, { device: options.device ?? true });
  return {
    fixture, relay, api, token, relayId, linked,
    close: async () => {
      await api.close();
      await relay.close();
    },
  };
}

async function seated(api: Console, fixture: Fixture, owner: string, kind: 'viewer' | 'member' | 'approver', name: string) {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = await api.call('POST', '/api/auth/join', '', { code: made.body.invite });
  const secret = decodeBase32(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', {
    code: made.body.invite, offer: opened.body.offer, totp: totpCode(secret, stepFor(new Date())),
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { id: String(made.body.seatId), name, token: String(joined.body.token) };
}

test('an envelope is taken only with the relay\'s signature, fresh, and once', async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-signed');
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const offers = offersFor(relay, itemId);
    const { deployment } = await identityOf(api);
    const at = new Date().toISOString();
    const body = {
      v: 1, type: 'press', at, token: offers.approve,
      device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'press', token: offers.approve, at }),
    };

    // Signed by somebody else: refused, and nothing is decided.
    const stranger = await fakeRelay();
    try {
      const forged = await relay.push(api.url, relayId, stranger.sign(body));
      assert.equal(forged.status, 401);
    } finally {
      await stranger.close();
    }
    // The body changed after signing.
    const signed = relay.sign(body);
    const altered = await relay.push(api.url, relayId, { ...signed, body: signed.body.replace('"press"', '"press" ') });
    assert.equal(altered.status, 401);
    // Signed six minutes ago.
    const stale = await relay.push(api.url, relayId, relay.sign(body, { at: new Date(Date.now() - 360_000) }));
    assert.equal(stale.status, 408);
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open');

    // Signed, fresh: taken, as a decision from a chat.
    const taken = await relay.push(api.url, relayId, signed);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.ok, true);
    const state = await itemState(fixture.companyId, itemId);
    assert.deepEqual([state.status, state.decision, state.decided_via], ['decided', 'approve', 'chat']);
    const { rows: [event] } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { via?: string; channel: string } }>(
      "SELECT payload FROM events WHERE type = 'owner.decided' AND payload->>'inboxItemId' = $1", [itemId]));
    assert.deepEqual([event!.payload.channel, event!.payload.via], ['chat', 'relay']);

    // Sent again under the same id: the same answer, and nothing done twice.
    const again = await relay.push(api.url, relayId, signed);
    assert.deepEqual([again.status, again.body], [taken.status, taken.body]);
    const { rows: decided } = await withTenant(fixture.companyId, (tx) => tx.query(
      "SELECT 1 FROM events WHERE type = 'owner.decided' AND payload->>'inboxItemId' = $1", [itemId]));
    assert.equal(decided.length, 1);
  } finally {
    await close();
  }
});

test('nothing is written for an unknown relay or a bad signature, and the route is throttled per address before it reads the database', async () => {
  const { relay, api, relayId, close } = await ready('relay-in-quiet');
  try {
    const count = async () => (await withControlPlane((tx) => tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM relay_receipts) + (SELECT count(*) FROM relay_refusals) AS n`))).rows[0]!.n;
    const before = Number(await count());
    const stranger = await fakeRelay();
    try {
      const unknown = await stranger.push(api.url, randomUUID(), stranger.sign({ v: 1, type: 'ack', ids: [] }));
      assert.equal(unknown.status, 401);
      const notAnId = await stranger.push(api.url, 'not-a-relay', stranger.sign({ v: 1, type: 'ack', ids: [] }));
      assert.equal(notAnId.status, 401);
      const badlySigned = await stranger.push(api.url, relayId, stranger.sign({ v: 1, type: 'ack', ids: [] }));
      assert.equal(badlySigned.status, 401);
      const unsigned = await relay.push(api.url, relayId, { id: 'x', timestamp: String(Math.floor(Date.now() / 1000)), signature: '', body: '{}' });
      assert.equal(unsigned.status, 401);
      assert.equal(Number(await count()), before, 'an envelope nobody signed is counted, never kept');
      const metrics = await import('../../src/relay/outbox.ts');
      assert.ok((metrics.RELAY_COUNTS.refused.get('signature') ?? 0) >= 2, 'the refusals are counted');
      assert.ok((metrics.RELAY_COUNTS.refused.get('unknown_relay') ?? 0) >= 2);

      // Sixty from one address in a minute, then no more, whoever signed them:
      // pushes for relays that do not exist, which no relay's own minute ever
      // counts, fill the address's minute, and the 61st is refused before
      // anything is read.
      const answers: number[] = [];
      for (let index = 0; index < 61; index += 1) {
        answers.push((await stranger.push(api.url, randomUUID(), stranger.sign({ v: 1, type: 'ack', ids: [] }))).status);
      }
      assert.deepEqual([...new Set(answers)].sort(), [401, 429], answers.join(' '));
      assert.equal(answers.at(-1), 429);
      assert.ok(answers.indexOf(429) <= 56, `the address had used five of its sixty before; refused from ${answers.indexOf(429)}`);
      assert.ok(answers.slice(answers.indexOf(429)).every((status) => status === 429));
      // And so is the paired relay's own next push from that address, though its own minute has room.
      const throttled = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'ack', ids: [] }));
      assert.deepEqual([throttled.status, throttled.body.code], [429, 'relay.throttled']);
      assert.equal(Number(await count()), before, 'nothing refused for the address is kept');
    } finally {
      await stranger.close();
    }
    // And too large a body is refused unread.
    const large = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'ack', ids: [], padding: 'x'.repeat(70_000) }));
    assert.ok(large.status === 400 || large.status === 413 || large.status === 429, String(large.status));
  } finally {
    await close();
  }
});

test('a press redeems only an offer made to that person for that item, once', async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-once');
  try {
    const first = await approval(fixture.companyId, 2, 'Send the newsletter');
    const second = await approval(fixture.companyId, 2, 'Send the invoice');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const offers = offersFor(relay, first);

    const denied = await press(api, relay, relayId, linked, offers.deny!);
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal((await itemState(fixture.companyId, first)).decision, 'deny');
    assert.equal((await itemState(fixture.companyId, second)).status, 'open', 'an offer decides its own item and no other');

    // The other button of the same item is spent with it, and so is the one pressed.
    for (const spent of [offers.deny!, offers.approve!]) {
      const again = await press(api, relay, relayId, linked, spent);
      assert.equal(again.status, 422);
      assert.ok(['relay.press_spent'].includes(again.body.code), JSON.stringify(again.body));
    }
    // A token nobody was given.
    const made = await press(api, relay, relayId, linked, `pt_${randomBytes(32).toString('base64url')}`);
    assert.deepEqual([made.status, made.body.code], [422, 'relay.press_unknown']);

    // An offer made through one relay is not pressed through another.
    const other = await fakeRelay();
    try {
      const token = await api.signIn();
      const otherId = await pairThrough(api, token, other, { companies: [fixture.companyId], share: 'summary', mayPress: true });
      const theirs = offersFor(relay, second);
      const across = await other.push(api.url, otherId, other.sign({ v: 1, type: 'press', at: new Date().toISOString(), token: theirs.approve }));
      assert.deepEqual([across.status, across.body.code], [422, 'relay.press_unknown']);
      assert.equal((await itemState(fixture.companyId, second)).status, 'open');
    } finally {
      await other.close();
    }
    // An answer never echoes what the item said.
    assert.equal(JSON.stringify(denied.body).includes('newsletter'), false);
  } finally {
    await close();
  }
});

test('presses are off until the owner turns them on', async () => {
  const { relay, api, relayId, linked, fixture, token, close } = await ready('relay-in-off', { mayPress: false });
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const told = relay.received.find((one) => one.envelope?.type === 'inbox_item')!;
    assert.deepEqual(told.envelope.offers, [], 'nothing to press is offered while presses are off');
    // A token made by hand, as a stolen one would be, is still refused while presses are off.
    const forged = `pt_${randomBytes(32).toString('base64url')}`;
    await withControlPlane((tx) => tx.query(
      `INSERT INTO relay_offers (token_hash, relay_id, link_id, company_id, principal, act, inbox_item_id, expires_at)
       VALUES ($1, $2, $3, $4, 'owner', 'approve', $5, now() + interval '1 hour')`,
      [createHash('sha256').update(forged).digest('hex'), relayId, linked.linkId, fixture.companyId, itemId]));
    const off = await press(api, relay, relayId, linked, forged);
    assert.deepEqual([off.status, off.body.code], [422, 'relay.press_off']);
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open');

    const on = await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { mayPress: true, proof: { totp: api.code() } });
    assert.equal(on.status, 200);
    const later = await approval(fixture.companyId, 2, 'Send the offer');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const pressed = await press(api, relay, relayId, linked, offersFor(relay, later).approve!);
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  } finally {
    await close();
  }
});

test('a press for a tier 3 approval is refused even with a token', async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-tier3');
  try {
    const itemId = await approval(fixture.companyId, 3, 'Wire Rp 500 juta');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    // None is offered; one forged into the table is still refused.
    const forged = `pt_${randomBytes(32).toString('base64url')}`;
    await withControlPlane((tx) => tx.query(
      `INSERT INTO relay_offers (token_hash, relay_id, link_id, company_id, principal, act, inbox_item_id, expires_at)
       VALUES ($1, $2, $3, $4, 'owner', 'approve', $5, now() + interval '1 hour')`,
      [createHash('sha256').update(forged).digest('hex'), relayId, linked.linkId, fixture.companyId, itemId]));
    const refused = await press(api, relay, relayId, linked, forged);
    assert.deepEqual([refused.status, refused.body.code], [422, 'relay.press_tier3']);
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open');
    // A refusal that names a company is in that company's record.
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { reason: string } }>(
      "SELECT payload FROM events WHERE type = 'security.relay_refused'"));
    assert.deepEqual(rows.map((row) => row.payload.reason), ['relay.press_tier3']);
  } finally {
    await close();
  }
});

test("a press for a link with a device key needs the device's signature", async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-device');
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const offers = offersFor(relay, itemId);
    const unsigned = await press(api, relay, relayId, linked, offers.approve!, { unsigned: true });
    assert.deepEqual([unsigned.status, unsigned.body.code], [422, 'relay.device_sig']);
    // Signed by the device for another token: refused.
    const { deployment } = await identityOf(api);
    const at = new Date().toISOString();
    const wrong = await relay.push(api.url, relayId, relay.sign({
      v: 1, type: 'press', at, token: offers.approve,
      device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'press', token: offers.deny, at }),
    }));
    assert.deepEqual([wrong.status, wrong.body.code], [422, 'relay.device_sig']);
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open', 'a refused press spends nothing');
    // Signed by the device for this token: taken.
    const signed = await press(api, relay, relayId, linked, offers.approve!);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    // Ending the link is an act too: unsigned, it is refused; signed, it ends.
    const end = (body: Record<string, unknown>) => relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_end', at, recipient: linked.recipient, ...body }));
    assert.deepEqual([(await end({})).status], [422]);
    const ended = await end({ device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'link_end', at }) });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const gone = await end({ device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'link_end', at }) });
    assert.equal(gone.status, 410, 'an ended link answers that it is gone');
  } finally {
    await close();
  }
});

test("the owner's link without a device key is told, and nothing it sends counts", async () => {
  const { relay, api, relayId, linked, fixture, token, close } = await ready('relay-in-owner', { device: false });
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const told = relay.received.find((one) => one.envelope?.type === 'inbox_item')!;
    assert.ok(told, 'the owner is still told');
    assert.deepEqual(told.envelope.offers, [], 'but offered nothing to press');
    const forged = `pt_${randomBytes(32).toString('base64url')}`;
    await withControlPlane((tx) => tx.query(
      `INSERT INTO relay_offers (token_hash, relay_id, link_id, company_id, principal, act, inbox_item_id, expires_at)
       VALUES ($1, $2, $3, $4, 'owner', 'approve', $5, now() + interval '1 hour')`,
      [createHash('sha256').update(forged).digest('hex'), relayId, linked.linkId, fixture.companyId, itemId]));
    const refused = await press(api, relay, relayId, linked, forged);
    assert.deepEqual([refused.status, refused.body.code], [422, 'relay.owner_device']);
    for (const type of ['reply', 'read', 'mute']) {
      const act = await relay.push(api.url, relayId, relay.sign({ v: 1, type, at: new Date().toISOString(), token: forged, body: 'yes', clientId: 'c1', until: null }));
      assert.equal(act.status, 422, type);
    }
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open');
    // Ending its own link still counts: it takes away and gives nothing.
    const ended = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_end', at: new Date().toISOString(), recipient: linked.recipient }));
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const links = await api.call('GET', '/api/relays/links', token);
    assert.deepEqual(links.body.links.map((one: { status: string }) => one.status), []);
  } finally {
    await close();
  }
});

test('a link code claimed through another relay is refused', async () => {
  const { relay, api, relayId, fixture, token, close } = await ready('relay-in-claim');
  const other = await fakeRelay();
  try {
    const otherId = await pairThrough(api, token, other, { companies: [fixture.companyId] });
    const offered = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    assert.equal(offered.status, 200);
    const stolen = await other.push(api.url, otherId, other.sign({ v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'Not yours' }));
    assert.deepEqual([stolen.status, stolen.body.code], [422, 'relay.link_unknown']);
    const own = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'Mine' }));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    // And a code is good once.
    const twice = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'Again' }));
    assert.deepEqual([twice.status, twice.body.code], [422, 'relay.link_unknown']);
    // A refusal that names no company is kept for the deployment.
    const { rows } = await withControlPlane((tx) => tx.query<{ reason: string }>('SELECT reason FROM relay_refusals WHERE relay_id = $1', [otherId]));
    assert.deepEqual(rows.map((row) => row.reason), ['relay.link_unknown']);
    // The relay is told the link stands, in an envelope of its own.
    await sendOutbox(api.master);
    assert.ok(relay.received.some((one) => one.envelope?.type === 'link_confirmed' && one.envelope.to.recipient === own.body.result.recipient));
  } finally {
    await close();
    await other.close();
  }
});

test('a press for a closed item says why and changes nothing', async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-closed');
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const offers = offersFor(relay, itemId);
    await inbox.decide(fixture.companyId, itemId, 'deny', 'not now', { channel: 'app', assurance: 'session' });
    const late = await press(api, relay, relayId, linked, offers.approve!);
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(late.body.code, 'inbox.not_open');
    assert.equal(late.body.text, 'Denied. Nothing left to press here.');
    const state = await itemState(fixture.companyId, itemId);
    assert.deepEqual([state.decision, state.decided_via], ['deny', 'app']);
  } finally {
    await close();
  }
});

test("a seat's press is its kind now, and never on work it asked for", async () => {
  const { relay, api, relayId, fixture, token, close } = await ready('relay-in-seat');
  try {
    const approver = await seated(api, fixture, token, 'approver', 'Rina Approver');
    const other = await seated(api, fixture, token, 'approver', 'Budi Approver');
    // A seat links its own phone, with a device key, through the relay that covers its company.
    const linked = await linkThrough(api, approver.token, relay, relayId, { device: true, owner: false });
    const theirs = await linkThrough(api, other.token, relay, relayId, { device: true, owner: false });
    // Seats' notices are made by the people's notices; here the offers are made as they will make them.
    const { mintOffers } = await import('../../src/relay/offers.ts');
    const offer = async (itemId: string, link: Linked, seatId: string) => withControlPlane((tx) => mintOffers(tx, {
      relayId, linkId: link.linkId, companyId: fixture.companyId, principal: `seat:${seatId}`, item: { id: itemId, question: false, options: null },
      expiresAt: new Date(Date.now() + 3_600_000), language: 'en', share: 'summary',
    }));
    const plain = await approval(fixture.companyId, 2, 'Send the newsletter');
    const [approve] = (await offer(plain, linked, approver.id)).filter((one) => one.act === 'approve');
    const taken = await press(api, relay, relayId, linked, approve!.token);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    const state = await itemState(fixture.companyId, plain);
    assert.deepEqual([state.decision, state.decided_via, state.decided_by_seat], ['approve', 'chat', approver.id]);

    // Four eyes: a card from work this seat asked for is not this seat's to decide, through a relay either.
    const asked = await approval(fixture.companyId, 2, 'Send what Rina asked for', [approver.id]);
    const [mine] = (await offer(asked, linked, approver.id)).filter((one) => one.act === 'approve');
    const refused = await press(api, relay, relayId, linked, mine!.token);
    assert.deepEqual([refused.status, refused.body.code], [422, 'approval.own_instigation']);
    assert.equal((await itemState(fixture.companyId, asked)).status, 'open');

    // An approver made a viewer cannot use an offer made before.
    const later = await approval(fixture.companyId, 2, 'Send the invoice');
    const [before] = (await offer(later, theirs, other.id)).filter((one) => one.act === 'approve');
    await withControlPlane((tx) => tx.query("UPDATE staff_seats SET kind = 'viewer' WHERE id = $1", [other.id]));
    const demoted = await press(api, relay, relayId, theirs, before!.token);
    assert.deepEqual([demoted.status, demoted.body.code], [422, 'relay.seat_changed']);
    assert.equal((await itemState(fixture.companyId, later)).status, 'open');
    // And one revoked cannot use one either.
    const [again] = (await offer(later, linked, approver.id)).filter((one) => one.act === 'approve');
    const revoked = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${approver.id}/revoke`, token, {});
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const gone = await press(api, relay, relayId, linked, again!.token);
    assert.ok([410, 422].includes(gone.status), JSON.stringify(gone.body));
    assert.equal((await itemState(fixture.companyId, later)).status, 'open');
    const { rows } = await withControlPlane((tx) => tx.query<{ status: string }>("SELECT status FROM relay_links WHERE principal = $1", [`seat:${approver.id}`]));
    assert.deepEqual(rows.map((row) => row.status), ['ended'], 'revoking a seat ends its links');
  } finally {
    await close();
  }
});

test("a run's question is answered from a phone with the person's words or one of its choices", async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-answer', { share: 'content' });
  try {
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'price the coffee' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Which price?', options: ['Rp 25.000', 'Rp 30.000'] });
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const told = relay.received.find((one) => one.envelope?.type === 'inbox_item')!;
    assert.equal(told.envelope.data.question, 'Which price?');
    const labels = told.envelope.offers.map((offer: { act: string; label: string }) => `${offer.act}:${offer.label}`);
    assert.deepEqual(labels, ['answer:Rp 25.000', 'answer:Rp 30.000', 'answer:Answer']);
    // The choice is the offer's, whatever the relay says beside it.
    const chosen = told.envelope.offers[1].token as string;
    const answered = await press(api, relay, relayId, linked, chosen, { answer: 'Rp 1' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const state = await itemState(fixture.companyId, asked.inboxItemId);
    assert.deepEqual([state.status, state.owner_note, state.decided_via], ['decided', 'Rp 30.000', 'chat']);
  } finally {
    await close();
  }
});

test("a reply needs the owner's consent, and a read mark or a mute a token a notice carried", async () => {
  // People's notices (STATUS section 2.213) offer these; a relay that makes
  // one up, or replies where the owner has not allowed replies, is refused.
  const { relay, api, relayId, linked, close } = await ready('relay-in-post');
  try {
    for (const type of ['reply', 'read', 'mute'] as const) {
      const at = new Date().toISOString();
      const { deployment } = await identityOf(api);
      const act = await relay.push(api.url, relayId, relay.sign({
        v: 1, type, at, token: `pt_${randomBytes(32).toString('base64url')}`, body: 'On my way', clientId: 'c1', until: null,
        device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type, at }),
      }));
      assert.deepEqual([act.status, act.body.code], [422, type === 'reply' ? 'relay.post_off' : 'relay.press_unknown'], type);
    }
  } finally {
    await close();
  }
});

test('the deployment pulls from a relay it cannot be reached by', async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-pull');
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const offers = offersFor(relay, itemId);
    const { deployment } = await identityOf(api);
    const at = new Date().toISOString();
    // The press waits at the relay, which cannot reach the deployment.
    relay.inbox.push(relay.sign({
      v: 1, type: 'press', at, token: offers.approve,
      device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'press', token: offers.approve, at }),
    }));
    relay.inbox.push({ id: 'unsigned', timestamp: String(Math.floor(Date.now() / 1000)), signature: '', body: '{"type":"ack"}' });
    const report = await sendOutbox(api.master);
    assert.ok(report.pulled >= 2, JSON.stringify(report));
    assert.deepEqual([(await itemState(fixture.companyId, itemId)).decision], ['approve'], 'taken as if it were pushed');
    // The pull is signed by the deployment, over what it asks for.
    const pull = relay.pulls.at(-1)!;
    assert.match(pull.path, /^\/v1\/inbox\?after=&wait=0$|^\/v1\/inbox\?after=0&wait=0$|^\/v1\/inbox\?wait=0$/);
    const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { key: string };
    const { verify } = await import('node:crypto');
    const { publicKeyFrom } = await import('../../src/relay/signature.ts');
    assert.ok(verify(null, Buffer.from(`${pull.id}.${pull.timestamp}.GET ${pull.path}`), publicKeyFrom(Buffer.from(identity.key, 'base64url')),
      Buffer.from(pull.signature.split(' ')[0]!.slice(4), 'base64')));
    // And it picks up where it left off.
    await sendOutbox(api.master);
    assert.match(relay.pulls.at(-1)!.path, /after=2/);
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ inbound_cursor: string }>('SELECT inbound_cursor FROM relays WHERE id = $1', [relayId]));
    assert.equal(row!.inbound_cursor, '2');
  } finally {
    await close();
  }
});

test("a pull is held to the relay's minute as a push is, and loses nothing it could not take", async () => {
  const { relay, api, relayId, close } = await ready('relay-in-pull-pace');
  try {
    // Seventy acts wait at the relay: more than the sixty a minute a relay may send.
    const waiting = Array.from({ length: 70 }, () => relay.sign({ v: 1, type: 'ack', at: new Date().toISOString(), ids: [] }));
    relay.inbox.push(...waiting);
    const taken = async () => (await withControlPlane((tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM relay_receipts WHERE relay_id = $1 AND envelope_id = ANY($2)',
      [relayId, waiting.map((one) => one.id)]))).rows[0]!.n;
    const cursor = async () => (await withControlPlane((tx) => tx.query<{ inbound_cursor: string | null }>(
      'SELECT inbound_cursor FROM relays WHERE id = $1', [relayId]))).rows[0]!.inbound_cursor;

    const now = new Date();
    const first = await sendOutbox(api.master, now);
    const inTheMinute = await taken();
    assert.ok(inTheMinute > 0 && inTheMinute <= 60, `a pull takes at most the relay's sixty a minute, took ${inTheMinute}`);
    assert.equal(first.pulled, inTheMinute);
    // The cursor stays before what was not taken, so the relay keeps it.
    assert.equal(await cursor(), null);
    // While the minute is full the relay is not asked again.
    const pulls = relay.pulls.length;
    await sendOutbox(api.master, new Date(now.getTime() + 1000));
    assert.equal(relay.pulls.length, pulls);
    assert.equal(await taken(), inTheMinute);

    // A minute on, the same cursor is named again: what was taken is answered
    // as before and counts for nothing, and the rest is taken.
    const later = await sendOutbox(api.master, new Date(now.getTime() + 61_000));
    assert.equal(relay.pulls.length, pulls + 1);
    assert.doesNotMatch(relay.pulls.at(-1)!.path, /after=/);
    assert.equal(await taken(), 70, 'nothing that waited at the relay was lost');
    assert.equal(later.pulled, 70, 'the deployment is done with all seventy');
    assert.equal(await cursor(), '70');
  } finally {
    await close();
  }
});

test('an inbox that answers more than a hundred envelopes at once is taken from not at all, and said', async () => {
  const { relay, api, relayId, close } = await ready('relay-in-pull-many');
  try {
    relay.inbox.push(...Array.from({ length: 101 }, () => relay.sign({ v: 1, type: 'ack', at: new Date().toISOString(), ids: [] })));
    const said: Array<Record<string, unknown>> = [];
    const report = await relayPass({ master: () => api.master, pullWaitSeconds: 0, awaitPulls: true, log: (entry) => said.push(entry) });
    assert.equal(report.pulled, 0);
    assert.ok(said.some((entry) => entry.event === 'relay.pull_failed' && /more than 100/.test(String(entry.message))), JSON.stringify(said));
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ n: number; cursor: string | null }>(
      `SELECT (SELECT count(*)::int FROM relay_receipts WHERE relay_id = $1 AND envelope_id LIKE 'in\\_%') AS n,
              (SELECT inbound_cursor FROM relays WHERE id = $1) AS cursor`, [relayId]));
    // Only the link's own claim was taken; nothing of the hundred and one, and the cursor did not move past them.
    assert.deepEqual([row!.n, row!.cursor], [1, null]);
  } finally {
    await close();
  }
});

test('a relay cannot assign, instruct, call a meeting or change a setting', async () => {
  const { relay, api, relayId, fixture, close } = await ready('relay-in-never');
  try {
    const before = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM tasks')).rows[0]!.n);
    for (const type of ['assign', 'instruct', 'meeting', 'settings', 'seat', 'pair', 'export', 'standing_approval', 'schedule', 'room', 'member']) {
      const sent = await relay.push(api.url, relayId, relay.sign({
        v: 1, type, at: new Date().toISOString(), companyId: fixture.companyId, goal: 'transfer Rp 5 juta', share: 'content', mayPress: true,
      }));
      assert.deepEqual([sent.status, sent.body.code], [422, 'relay.unknown_type'], type);
    }
    const after = await withTenant(fixture.companyId, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM tasks')).rows[0]!.n);
    assert.equal(after, before);
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ share: string; may_post: boolean }>('SELECT share, may_post FROM relays WHERE id = $1', [relayId]));
    assert.deepEqual([row!.share, row!.may_post], ['summary', false]);
    // Each was a signed refusal, kept for the deployment rather than any company's record.
    const { rows } = await withControlPlane((tx) => tx.query('SELECT 1 FROM relay_refusals WHERE relay_id = $1 AND reason = $2', [relayId, 'relay.unknown_type']));
    assert.equal(rows.length, 11);
  } finally {
    await close();
  }
});

/**
 * Runs `work` while a trigger the schema's owner puts on `inbox_items` refuses
 * to change one item, as a failure nobody planned would: a statement that
 * timed out, a constraint somebody added. Taken off again whatever happens.
 */
async function refusingDecisions<T>(itemId: string, work: () => Promise<T>): Promise<T> {
  const owner = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  try {
    await owner.query(`CREATE FUNCTION public.test_refuses() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused by the test on %', TG_TABLE_NAME; END $$`);
    await owner.query(
      `CREATE TRIGGER test_refuses BEFORE UPDATE ON inbox_items FOR EACH ROW WHEN (OLD.id = '${itemId}'::uuid) EXECUTE FUNCTION public.test_refuses()`);
    return await work();
  } finally {
    await owner.query('DROP TRIGGER IF EXISTS test_refuses ON inbox_items');
    await owner.query('DROP FUNCTION IF EXISTS public.test_refuses()');
    await owner.end();
  }
}

const offerRow = async (token: string) => (await withControlPlane((tx) => tx.query<{ uses: number; voided_at: Date | null }>(
  'SELECT uses, voided_at FROM relay_offers WHERE token_hash = $1', [createHash('sha256').update(token).digest('hex')]))).rows[0]!;

test('text the database cannot keep is refused as such, and an envelope that failed for another reason is taken when it comes again', async () => {
  const { relay, api, relayId, linked, fixture, token, close } = await ready('relay-in-unkept');
  try {
    // An answer with a character no text column keeps: refused for what it
    // is, before anything is spent, and the question is still there to answer.
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'price the coffee' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Which price?' });
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const answerOffer = offersFor(relay, asked.inboxItemId).answer!;
    const unkept = await press(api, relay, relayId, linked, answerOffer, { answer: 'Rp \u0000 30.000' });
    assert.deepEqual([unkept.status, unkept.body.code], [422, 'relay.malformed']);
    assert.equal((await offerRow(answerOffer)).uses, 0, 'nothing was spent');
    assert.equal((await itemState(fixture.companyId, asked.inboxItemId)).status, 'open');
    const answered = await press(api, relay, relayId, linked, answerOffer, { answer: 'Rp 30.000' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));

    // A press whose decision fails for a reason that is no refusal -- the
    // database refused the write -- spends nothing and keeps no answer, so the
    // relay sending the same envelope again is taken, not told it is in hand.
    const offers = offersFor(relay, itemId);
    const { deployment } = await identityOf(api);
    const at = new Date().toISOString();
    const signed = relay.sign({
      v: 1, type: 'press', at, token: offers.approve,
      device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'press', token: offers.approve, at }),
    });
    const failed = await refusingDecisions(itemId, () => relay.push(api.url, relayId, signed));
    assert.ok(failed.status >= 400 && failed.body.ok === undefined, `not an answer to the press, but a failure: ${failed.status} ${JSON.stringify(failed.body)}`);
    assert.equal((await offerRow(offers.approve!)).uses, 0, 'the token is given back');
    assert.equal((await offerRow(offers.deny!)).voided_at, null, 'and so is the other button');
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open');
    const again = await relay.push(api.url, relayId, signed);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([(await itemState(fixture.companyId, itemId)).decision], ['approve']);

    // A device's name no text column keeps: the code is refused, and still there to claim.
    const offered = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    const named = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'a\u0000b' }));
    assert.deepEqual([named.status, named.body.code], [422, 'relay.malformed']);
    const claimed = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'Phone' }));
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  } finally {
    await close();
  }
});

test('approve and deny pressed at once for one item: one is taken, the other is spent, and neither fails', async () => {
  const { relay, api, relayId, linked, fixture, close } = await ready('relay-in-together');
  try {
    const items: string[] = [];
    for (let index = 0; index < 4; index += 1) items.push(await approval(fixture.companyId, 2, `Send letter ${index}`));
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    for (const itemId of items) {
      const offers = offersFor(relay, itemId);
      const answers = await Promise.all([
        press(api, relay, relayId, linked, offers.approve!),
        press(api, relay, relayId, linked, offers.deny!),
      ]);
      const outcomes = answers.map((answer) => (answer.status === 200 ? 'taken' : `${answer.status} ${answer.body.code}`)).sort();
      assert.deepEqual(outcomes, ['422 relay.press_spent', 'taken'], JSON.stringify(answers));
      assert.equal((await itemState(fixture.companyId, itemId)).status, 'decided');
    }
  } finally {
    await close();
  }
});

test("a device's signature holds for its own moment and its own link", async () => {
  const { relay, api, relayId, linked, fixture, token, close } = await ready('relay-in-moment');
  try {
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const offers = offersFor(relay, itemId);
    const { deployment } = await identityOf(api);
    // A press the device signed long ago, sent now by the relay: refused.
    const long = '2000-01-01T00:00:00.000Z';
    const old = await relay.push(api.url, relayId, relay.sign({
      v: 1, type: 'press', at: long, token: offers.approve,
      device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'press', token: offers.approve, at: long }),
    }));
    assert.deepEqual([old.status, old.body.code], [422, 'relay.device_sig']);
    assert.equal((await itemState(fixture.companyId, itemId)).status, 'open');

    // The device ends its link, and links again with the same key.
    const at = new Date().toISOString();
    const end = {
      v: 1, type: 'link_end', at, recipient: linked.recipient,
      device_sig: deviceSignature(linked.device!.privateKey, { deployment, relay: relayId, recipient: linked.recipient, type: 'link_end', at }),
    };
    const ended = await relay.push(api.url, relayId, relay.sign(end));
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const offered = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    const relinked = await relay.push(api.url, relayId, relay.sign({
      v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'Same phone',
      device_key: linked.device!.publicKey.toString('base64url'),
    }));
    assert.equal(relinked.status, 200, JSON.stringify(relinked.body));
    assert.equal(relinked.body.result.recipient, linked.recipient, 'the same person on the same relay');
    // The relay sends the old end again, under an id of its own: the device
    // signed the end of the link it had then, not of the one it has now.
    const replayed = await relay.push(api.url, relayId, relay.sign(end));
    assert.deepEqual([replayed.status, replayed.body.code], [422, 'relay.device_sig']);
    const links = await api.call('GET', '/api/relays/links', token);
    assert.deepEqual(links.body.links.map((one: { status: string; label: string }) => [one.label, one.status]), [['Same phone', 'active']]);
  } finally {
    await close();
  }
});

test("an inbox's answer larger than a relay may send is not read past its bound, and nothing of it is taken", async () => {
  const fixture = await createCompany('relay-in-pull-large');
  // Nine megabytes, more than a hundred envelopes of 64 KiB could ever be.
  const relay = await fakeRelay({ inboxPadding: 9 * 1024 * 1024 });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], mode: 'pull' });
    relay.inbox.push(relay.sign({ v: 1, type: 'ack', at: new Date().toISOString(), ids: [] }));
    const said: Array<Record<string, unknown>> = [];
    const report = await relayPass({ master: () => api.master, pullWaitSeconds: 0, awaitPulls: true, log: (entry) => said.push(entry) });
    assert.equal(report.pulled, 0);
    assert.ok(said.some((entry) => entry.event === 'relay.pull_failed' && /larger than/.test(String(entry.message))), JSON.stringify(said));
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ n: number; cursor: string | null }>(
      `SELECT (SELECT count(*)::int FROM relay_receipts WHERE relay_id = $1) AS n,
              (SELECT inbound_cursor FROM relays WHERE id = $1) AS cursor`, [relayId]));
    assert.deepEqual([row!.n, row!.cursor], [0, null]);
  } finally {
    await api.close();
    await relay.close();
  }
});
