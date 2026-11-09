/**
 * A relay is paired by the owner, deliberately, and only with the relay it
 * was meant to be (F19.19; STATUS section 2.208).
 *
 * The deployment has one Ed25519 identity, sealed like every other secret,
 * and shows only its public half. The owner pairs a relay by typing at least
 * sixteen characters of the fingerprint its operator shows, proving a factor
 * given now, and naming the companies it may hear about; the relay's accept
 * must name this pairing and this deployment. Widening what a relay is told
 * or may do takes the owner's device again; narrowing never does, and voids
 * what it no longer allows. A revoked relay is refused at once.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { base32, publicKeyFrom } from '../../src/relay/signature.ts';
import { settingsVersion } from '../../src/settings/store.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { deviceKey, fakeRelay, type FakeRelay } from '../helpers/fake-relay.ts';
import { handToRelay, linkThrough, pairThrough, sendOutbox, tomorrow, type Console } from '../helpers/relay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** The signature PALUGADA put on an envelope, checked against a key it published. */
function signedBy(key: Buffer, one: { id: string; timestamp: string; body: string; signature: string }): boolean {
  const content = Buffer.from(`${one.id}.${one.timestamp}.${one.body}`, 'utf8');
  return one.signature.split(' ').some((part) => part.startsWith('v1a,')
    && verify(null, content, publicKeyFrom(key), Buffer.from(part.slice(4), 'base64')));
}

async function seated(api: Console, fixture: Fixture, owner: string, kind: 'viewer' | 'member' | 'approver') {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name: `Siti ${kind}`, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = await api.call('POST', '/api/auth/join', '', { code: made.body.invite });
  const secret = decodeBase32(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', {
    code: made.body.invite, offer: opened.body.offer, totp: totpCode(secret, stepFor(new Date())),
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { id: String(made.body.seatId), token: String(joined.body.token) };
}

test('the deployment has one identity key, sealed, and shows only its public half', async () => {
  const api = await consoleWithSettings();
  try {
    const before = await settingsVersion();
    const first = await fetch(`${api.url}/api/relay/v1/identity`);
    assert.equal(first.status, 200);
    const identity = await first.json() as Record<string, unknown>;
    const { rows: [control] } = await withControlPlane((tx) => tx.query<{ deployment_id: string }>('SELECT deployment_id FROM platform_control'));
    assert.equal(identity.v, 1);
    assert.deepEqual(identity.versions, [1]);
    assert.equal(identity.deployment, control!.deployment_id);
    const key = Buffer.from(String(identity.key), 'base64url');
    assert.equal(key.length, 32, 'the public key is the raw 32 bytes of an Ed25519 key');
    assert.equal(identity.kid, createHash('sha256').update(key).digest('hex').slice(0, 16));
    assert.equal(identity.fingerprint, base32(createHash('sha256').update(key).digest()).slice(0, 24));
    assert.equal(identity.previous ?? null, null);

    // One identity: asked again, and by the owner's page, it is the same key.
    const again = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as Record<string, unknown>;
    assert.equal(again.key, identity.key);
    const owner = await api.signIn();
    const page = await api.call('GET', '/api/control/relays', owner);
    assert.equal(page.status, 200);
    assert.equal(page.body.deployment.fingerprint, identity.fingerprint);

    // Sealed under the master key, and named by its id; the public half is all that is kept in the clear.
    const { rows } = await withControlPlane((tx) => tx.query<{ secret_ref: string; public_key: Buffer; kid: string }>('SELECT * FROM relay_identity'));
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).filter((column) => /private|seed|secret_key/.test(column)), []);
    assert.deepEqual(rows[0]!.public_key, key);
    const name = rows[0]!.secret_ref.replace(/^db:\/\//, '');
    const { rows: sealed } = await withControlPlane((tx) => tx.query<{ key_id: string; ciphertext: Buffer }>(
      'SELECT key_id, ciphertext FROM deployment_secrets WHERE name = $1', [name]));
    assert.equal(sealed.length, 1);
    assert.equal(sealed[0]!.key_id, api.master.id);
    const seed = Buffer.from(await api.secrets.resolve(rows[0]!.secret_ref), 'base64');
    assert.equal(seed.length, 32);
    // The seed is what makes the published key, and no answer carries it.
    for (const answer of [identity, again, page.body]) {
      assert.doesNotMatch(JSON.stringify(answer), new RegExp(seed.toString('base64url').slice(0, 20)));
      assert.doesNotMatch(JSON.stringify(answer), new RegExp(seed.toString('base64').slice(0, 20).replace(/[+/]/g, '.')));
    }
    // A key the platform made for itself is not the owner changing a setting: no replica restarts for it.
    assert.equal(await settingsVersion(), before);
  } finally {
    await api.close();
  }
});

test('a relay is paired only with the owner\'s fresh code and at least sixteen characters of the fingerprint', async () => {
  const fixture = await createCompany('relay-pair');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.relay.status, 'pending');
    assert.equal(added.body.relay.fingerprint, relay.fingerprint, 'the fingerprint shown is the relay\'s own key\'s');
    const relayId = String(added.body.relay.id);
    const pair = (body: Record<string, unknown>) => api.call('POST', `/api/control/relays/${relayId}/pair`, token, body);

    const short = await pair({ fingerprint: relay.fingerprint.slice(0, 15), companies: [fixture.companyId], proof: { totp: api.code() } });
    assert.deepEqual([short.status, short.body.code], [400, 'relay.fingerprint_short']);
    const wrong = await pair({ fingerprint: `${relay.fingerprint.slice(0, 15)}${relay.fingerprint[15] === 'A' ? 'B' : 'A'}`, companies: [fixture.companyId], proof: { totp: api.code() } });
    assert.deepEqual([wrong.status, wrong.body.code], [400, 'relay.fingerprint']);
    // The session was signed in with a device, and still a code is asked for now.
    const unproved = await pair({ fingerprint: relay.fingerprint.slice(0, 16), companies: [fixture.companyId] });
    assert.equal(unproved.status, 403);
    assert.equal(unproved.body.code, 'approval.channel_forbidden');
    assert.equal(relay.received.length, 0, 'nothing was sent to the relay before the owner proved it');

    // Typed as the operator reads it out: in groups, in small letters.
    const typed = relay.fingerprint.slice(0, 20).toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    const paired = await pair({ fingerprint: typed, companies: [fixture.companyId], proof: { totp: api.code() } });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    assert.equal(paired.body.relay.status, 'paired');

    // The relay was sent a pairing request signed by the key the deployment publishes.
    const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { key: string; kid: string; deployment: string };
    const request = relay.received.find((one) => one.envelope?.type === 'pair_request')!;
    assert.ok(request, 'a pairing request reached the relay');
    assert.ok(signedBy(Buffer.from(identity.key, 'base64url'), request));
    assert.equal(request.key, identity.kid);
    assert.equal(request.envelope.deployment, identity.deployment);
    assert.equal(request.envelope.key, identity.key);
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ pair_request_id: string; paired_at: Date | null }>(
      'SELECT pair_request_id, paired_at FROM relays WHERE id = $1', [relayId]));
    assert.equal(row!.pair_request_id, request.envelope.id, 'the accept is bound to this request');
    assert.ok(row!.paired_at);
  } finally {
    await api.close();
    await relay.close();
  }
});

test('a relay paired with no company is refused; every company, later ones too, is a choice of its own', async () => {
  const fixture = await createCompany('relay-scope');
  const relay = await fakeRelay();
  const other = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    const relayId = String(added.body.relay.id);
    for (const companies of [[], undefined, [randomUUID()], 'some']) {
      const refused = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
        fingerprint: relay.fingerprint, ...(companies === undefined ? {} : { companies }), proof: { totp: api.code() },
      });
      assert.deepEqual([refused.status, refused.body.code], [400, 'relay.companies'], JSON.stringify(companies));
    }
    const named = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
      fingerprint: relay.fingerprint, companies: [fixture.companyId], proof: { totp: api.code() },
    });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.deepEqual([named.body.relay.companies, named.body.relay.allCompanies], [[fixture.companyId], false]);

    const otherId = await pairThrough(api, token, other, { companies: 'all' });
    const page = await api.call('GET', '/api/control/relays', token);
    const shown = page.body.relays.find((one: { id: string }) => one.id === otherId);
    assert.deepEqual([shown.allCompanies, shown.companies], [true, []]);

    // A company made later is heard about only by the relay that chose every company.
    const later = await createCompany('relay-later');
    await inbox.raiseIncident({ companyId: later.companyId, title: 'The till is down', detail: 'since noon' });
    await linkThrough(api, token, relay, relayId);
    await linkThrough(api, token, other, otherId);
    await handToRelay(later.companyId, relayId);
    await handToRelay(later.companyId, otherId);
    await sendOutbox(api.master);
    assert.equal(relay.received.filter((one) => one.envelope?.type === 'inbox_item').length, 0);
    assert.equal(other.received.filter((one) => one.envelope?.type === 'inbox_item').length, 1);
  } finally {
    await api.close();
    await relay.close();
    await other.close();
  }
});

test('an accept that names another pairing request or another deployment is refused', async () => {
  const fixture = await createCompany('relay-accept');
  const forgeries: Array<(request: { id: string; deployment: string; relay: string }) => Record<string, unknown>> = [
    (request) => ({ pair_accept: { request: randomUUID(), deployment: request.deployment, relay: request.relay, at: new Date().toISOString() } }),
    (request) => ({ pair_accept: { request: request.id, deployment: randomUUID(), relay: request.relay, at: new Date().toISOString() } }),
    (request) => ({ pair_accept: { request: request.id, deployment: request.deployment, relay: randomUUID(), at: new Date().toISOString() } }),
    () => ({ ok: true }),
  ];
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    for (const forge of forgeries) {
      const relay = await fakeRelay({ accept: (received) => forge(received.envelope) });
      try {
        const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
        const relayId = String(added.body.relay.id);
        const refused = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
          fingerprint: relay.fingerprint, companies: [fixture.companyId], proof: { totp: api.code() },
        });
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.equal(refused.body.code, 'relay.accept');
        const { rows: [row] } = await withControlPlane((tx) => tx.query<{ status: string }>('SELECT status FROM relays WHERE id = $1', [relayId]));
        assert.equal(row!.status, 'pending');
      } finally {
        await relay.close();
      }
    }
    // An honest accept signed by another key than the one the owner compared is refused too.
    const relay = await fakeRelay({ acceptKey: deviceKey().privateKey });
    try {
      const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
      const refused = await api.call('POST', `/api/control/relays/${added.body.relay.id}/pair`, token, {
        fingerprint: relay.fingerprint, companies: [fixture.companyId], proof: { totp: api.code() },
      });
      assert.deepEqual([refused.status, refused.body.code], [400, 'relay.accept']);
    } finally {
      await relay.close();
    }
  } finally {
    await api.close();
  }
});

test('a relay whose envelopes live on another host is refused', async () => {
  const relay = await fakeRelay({ otherHost: true });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const refused = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    assert.deepEqual([refused.status, refused.body.code], [400, 'relay.other_host']);
    const { rows } = await withControlPlane((tx) => tx.query('SELECT 1 FROM relays'));
    assert.equal(rows.length, 0, 'nothing is kept of a relay that was refused');
    // And an address that is neither https nor this machine is refused before it is fetched.
    const plain = await api.call('POST', '/api/control/relays', token, { url: 'http://relay.example/' });
    assert.equal(plain.status, 400);
    // One that does not answer says so.
    const gone = await api.call('POST', '/api/control/relays', token, { url: 'http://127.0.0.1:9/' });
    assert.deepEqual([gone.status, gone.body.code], [502, 'relay.unreachable']);
  } finally {
    await api.close();
    await relay.close();
  }
});

test('a seat can neither see nor pair a relay', async () => {
  const fixture = await createCompany('relay-seat');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const relayId = await pairThrough(api, owner, relay, { companies: [fixture.companyId] });
    const approver = await seated(api, fixture, owner, 'approver');
    for (const [method, path] of [
      ['GET', '/api/control/relays'],
      ['POST', '/api/control/relays'],
      ['POST', `/api/control/relays/${relayId}/pair`],
      ['POST', `/api/control/relays/${relayId}/settings`],
      ['POST', `/api/control/relays/${relayId}/test`],
      ['POST', `/api/control/relays/${relayId}/retry`],
      ['POST', `/api/control/relays/${relayId}/revoke`],
      ['POST', '/api/control/relay-identity/rotate'],
    ] as const) {
      const refused = await api.call(method, path, approver.token, method === 'POST' ? { url: relay.url } : undefined);
      assert.deepEqual([refused.status, refused.body.code], [403, 'staff.forbidden'], `${method} ${path}`);
    }
    // A seat sees the relays it may link a phone through, by name, and nothing else of them.
    const links = await api.call('GET', '/api/relays/links', approver.token);
    assert.equal(links.status, 200, JSON.stringify(links.body));
    assert.deepEqual(links.body.relays, [{ id: relayId, name: 'Test relay' }]);
    assert.deepEqual(links.body.links, []);
    // A relay that does not cover its company is not offered to it.
    const elsewhere = await createCompany('relay-seat-elsewhere');
    const other = await fakeRelay();
    try {
      await pairThrough(api, owner, other, { companies: [elsewhere.companyId] });
      const still = await api.call('GET', '/api/relays/links', approver.token);
      assert.deepEqual(still.body.relays.map((one: { id: string }) => one.id), [relayId]);
    } finally {
      await other.close();
    }
  } finally {
    await api.close();
    await relay.close();
  }
});

test('widening what a relay is shared, or turning presses on, takes the device; narrowing does not, and voids what it no longer allows', async () => {
  const fixture = await createCompany('relay-widen');
  const second = await createCompany('relay-widen-two');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId] });
    const settings = (body: Record<string, unknown>) => api.call('POST', `/api/control/relays/${relayId}/settings`, token, body);

    for (const widening of [{ share: 'summary' }, { share: 'content' }, { mayPress: true }, { mayPost: true },
      { companies: [fixture.companyId, second.companyId] }, { allCompanies: true }]) {
      const refused = await settings(widening);
      assert.deepEqual([refused.status, refused.body.code], [403, 'approval.channel_forbidden'], JSON.stringify(widening));
    }
    const { rows: [unchanged] } = await withControlPlane((tx) => tx.query<{ share: string; may_press: boolean }>(
      'SELECT share, may_press FROM relays WHERE id = $1', [relayId]));
    assert.deepEqual([unchanged!.share, unchanged!.may_press], ['signal', false]);

    const widened = await settings({ share: 'summary', mayPress: true, companies: [fixture.companyId, second.companyId], proof: { totp: api.code() } });
    assert.equal(widened.status, 200, JSON.stringify(widened.body));
    assert.deepEqual([widened.body.relay.share, widened.body.relay.mayPress], ['summary', true]);

    // An offer to press, made to the owner's phone in each company.
    await linkThrough(api, token, relay, relayId, { device: true });
    for (const company of [fixture, second]) {
      await inbox.requestApproval({
        companyId: company.companyId, capabilityName: 'email.send', tier: 2, actionSummary: 'Send the newsletter',
        rationale: 'ready', consequenceIfDenied: 'not sent',
      });
      await handToRelay(company.companyId, relayId);
    }
    const live = async (companyId: string) => (await withControlPlane((tx) => tx.query(
      'SELECT 1 FROM relay_offers WHERE company_id = $1 AND voided_at IS NULL', [companyId]))).rows.length;
    assert.equal(await live(fixture.companyId), 2);
    assert.equal(await live(second.companyId), 2);

    // Narrowing takes the session alone, and voids what it no longer allows.
    const fewer = await settings({ companies: [fixture.companyId] });
    assert.equal(fewer.status, 200, JSON.stringify(fewer.body));
    assert.equal(await live(second.companyId), 0, 'a company the relay no longer hears about keeps no offer there');
    assert.equal(await live(fixture.companyId), 2);
    const off = await settings({ mayPress: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(await live(fixture.companyId), 0, 'presses turned off void every offer to press');
    const quieter = await settings({ share: 'signal' });
    assert.equal(quieter.status, 200, JSON.stringify(quieter.body));
    assert.equal(quieter.body.relay.share, 'signal');
    // And a narrowing that names nothing new is not a widening in disguise.
    const same = await settings({ share: 'signal', mayPress: false });
    assert.equal(same.status, 200, JSON.stringify(same.body));
  } finally {
    await api.close();
    await relay.close();
  }
});

test('a revoked relay is refused at once, and its offers and outbox end', async () => {
  const fixture = await createCompany('relay-revoke');
  const relay = await fakeRelay({ answer: () => ({ status: 503 }) });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share: 'summary', mayPress: true });
    const linked = await linkThrough(api, token, relay, relayId, { device: true });
    await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, actionSummary: 'Send the offer',
      rationale: 'ready', consequenceIfDenied: 'not sent',
    });
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const count = async (sql: string) => (await withControlPlane((tx) => tx.query(sql, [relayId]))).rows.length;
    assert.ok(await count("SELECT 1 FROM relay_outbox WHERE relay_id = $1 AND status = 'pending'") > 0, 'the relay is failing, so its envelopes wait');
    assert.equal(await count('SELECT 1 FROM relay_offers WHERE relay_id = $1 AND voided_at IS NULL'), 2);

    // Revoking takes the session alone: it only takes away.
    const revoked = await api.call('POST', `/api/control/relays/${relayId}/revoke`, token, {});
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(await count('SELECT 1 FROM relay_offers WHERE relay_id = $1 AND voided_at IS NULL'), 0);
    assert.equal(await count("SELECT 1 FROM relay_outbox WHERE relay_id = $1 AND status IN ('pending', 'sending', 'dead')"), 0);
    assert.equal(await count("SELECT 1 FROM relay_links WHERE relay_id = $1 AND status <> 'ended'"), 0);

    // Whatever it signs is refused, before anything is read of it.
    const pressed = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_end', at: new Date().toISOString(), recipient: linked.recipient }));
    assert.equal(pressed.status, 401);
    const before = relay.received.length;
    await sendOutbox(api.master);
    assert.equal(relay.received.length, before, 'nothing more is sent to it');
  } finally {
    await api.close();
    await relay.close();
  }
});

test('rotating the key signs with both for a week', async () => {
  const fixture = await createCompany('relay-rotate');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId] });
    const old = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { key: string; kid: string };

    const unproved = await api.call('POST', '/api/control/relay-identity/rotate', token, {});
    assert.deepEqual([unproved.status, unproved.body.code], [403, 'approval.channel_forbidden']);
    const rotated = await api.call('POST', '/api/control/relay-identity/rotate', token, { proof: { totp: api.code() } });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    const now = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as {
      key: string; kid: string; previous: { key: string; kid: string; until: string } | null;
    };
    assert.notEqual(now.kid, old.kid);
    assert.deepEqual([now.previous!.key, now.previous!.kid], [old.key, old.kid]);
    const week = new Date(now.previous!.until).getTime() - Date.now();
    assert.ok(week > 6.9 * 86_400_000 && week <= 7 * 86_400_000, `the old key stays a week, not ${week} ms`);

    // The relay is told, in an envelope signed with both keys, and so is every envelope that week.
    await api.call('POST', `/api/control/relays/${relayId}/test`, token, {});
    await sendOutbox(api.master);
    const told = relay.received.find((one) => one.envelope?.type === 'keys_rotated')!;
    assert.ok(told, 'the relay is told the key changed');
    assert.equal(told.envelope.key, now.key);
    const ping = relay.received.find((one) => one.envelope?.type === 'ping')!;
    for (const one of [told, ping]) {
      assert.equal(one.signature.split(' ').length, 2, 'two signatures while the old key stands');
      assert.ok(signedBy(Buffer.from(old.key, 'base64url'), one), 'the key the relay pinned still verifies it');
      assert.ok(signedBy(Buffer.from(now.key, 'base64url'), one), 'and the new one does');
    }

    // After the week, the new key alone.
    await api.call('POST', `/api/control/relays/${relayId}/test`, token, {});
    const later = new Date(Date.now() + 8 * 86_400_000);
    await sendOutbox(api.master, later);
    const last = relay.received.at(-1)!;
    assert.equal(last.envelope.type, 'ping');
    assert.equal(last.signature.split(' ').length, 1);
    assert.ok(signedBy(Buffer.from(now.key, 'base64url'), last));
    // A key is only published as itself: the relay pins it raw, never as a PEM it could misread.
    assert.equal(createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: now.key }, format: 'jwk' }).asymmetricKeyType, 'ed25519');
  } finally {
    await api.close();
    await relay.close();
  }
});

// The owner's items reach a relay only after it is paired; one added and never paired hears nothing.
test('a relay added and never paired is told nothing', async () => {
  const fixture = await createCompany('relay-pending');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    const relayId = String(added.body.relay.id);
    const link = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    assert.equal(link.status, 400, 'no phone is linked through a relay that is not paired');
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Down', detail: 'since noon' });
    await handToRelay(fixture.companyId, relayId, { now: tomorrow() });
    await sendOutbox(api.master);
    assert.equal(relay.received.length, 0);
  } finally {
    await api.close();
    await relay.close();
  }
});
