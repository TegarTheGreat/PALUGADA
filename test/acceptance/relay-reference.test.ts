/**
 * The reference relay (`scripts/relay-reference.ts`), end to end against a
 * real deployment (F19.19, F19.20; STATUS section 2.208).
 *
 * It is written apart from `src/relay/`, with its own canonical JSON and its
 * own checks, so that it and the deployment can disagree: what passes here is
 * the protocol as the document states it, implemented twice. It pins the
 * deployment's key by the fingerprint its operator was given and trusts no
 * first use, and once paired it takes no other pairing.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { startReferenceRelay } from '../../scripts/relay-reference.ts';
import { jcs } from '../../src/relay/canonical.ts';
import { rawPublicKey } from '../../src/relay/signature.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { handToRelay, sendOutbox } from '../helpers/relay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** An ntfy server that keeps what it is sent. */
async function fakeNtfy(): Promise<{ url: string; posts: Array<{ path: string; headers: Record<string, string>; body: string }>; close: () => Promise<void> }> {
  const posts: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      posts.push({ path: req.url ?? '', headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, String(value)])), body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    posts,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('the reference relay pairs, receives, verifies and presses, end to end', async () => {
  const fixture = await createCompany('relay-reference');
  const api = await consoleWithSettings();
  const ntfy = await fakeNtfy();
  const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { fingerprint: string; deployment: string };
  const relay = await startReferenceRelay({ port: 0, deploymentFingerprint: identity.fingerprint, ntfy: { url: ntfy.url, token: 'tk_test' }, quiet: true });
  try {
    const token = await api.signIn();
    const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.relay.fingerprint, relay.fingerprint);
    const relayId = String(added.body.relay.id);
    const paired = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
      fingerprint: relay.fingerprint.slice(0, 16), companies: [fixture.companyId], proof: { totp: api.code() },
    });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const set = await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { share: 'summary', mayPress: true, proof: { totp: api.code() } });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    // The owner links a phone: the relay makes a device key and claims the code, and the deployment pulls the claim.
    const offered = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    await relay.link(String(offered.body.code), 'Owner phone');
    await sendOutbox(api.master);
    await sendOutbox(api.master);
    const { rows: [link] } = await withControlPlane((tx) => tx.query<{ status: string; device_key: Buffer | null }>(
      "SELECT status, device_key FROM relay_links WHERE relay_id = $1 AND principal = 'owner'", [relayId]));
    assert.equal(link!.status, 'active');
    assert.equal(link!.device_key?.length, 32, 'the reference relay links with a device key');
    assert.ok(relay.received().some((envelope) => envelope.type === 'link_confirmed'));

    // An item reaches it, verified against the pinned key, and goes on to ntfy.
    const itemId = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, actionSummary: 'Send the newsletter',
      rationale: 'ready', consequenceIfDenied: 'not sent',
    });
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'The till is down', detail: 'since noon' });
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const told = relay.received().filter((envelope) => envelope.type === 'inbox_item');
    assert.equal(told.length, 2);
    assert.equal(relay.refused(), 0, 'every envelope verified');
    // The phone is told it is linked, then the two notices, each under the person's own topic.
    const forwarded = ntfy.posts;
    assert.equal(forwarded.length, 3);
    assert.ok(forwarded.every((post) => post.headers.authorization === 'Bearer tk_test'));
    assert.equal(new Set(forwarded.map((post) => post.path)).size, 1, 'one topic for the one person');
    assert.equal(forwarded[0]!.body, 'This phone is linked to PALUGADA.');
    const priority = (text: string) => forwarded.find((post) => post.body.startsWith(text))?.headers.priority;
    assert.deepEqual([priority('Incident: The till is down'), priority('Approval needed: Send the newsletter')], ['5', '3'],
      'the incident rings, the approval only shows');
    assert.ok(forwarded.some((post) => post.headers.click?.startsWith('https://palugada.example/')));

    // The owner presses Approve on the phone; the relay signs it with the device's key; the deployment pulls it.
    const approval = told.find((envelope) => envelope.data.kind === 'approval')!;
    const approve = approval.offers.find((offer: { act: string }) => offer.act === 'approve');
    // Acts come from the machine the relay runs on, never through a proxy in front of it.
    for (const via of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }]) {
      const proxied = await fetch(`${relay.url}/local/press`, { method: 'POST', headers: via, body: JSON.stringify({ token: approve.token }) });
      assert.equal(proxied.status, 403, JSON.stringify(via));
    }
    await relay.press(approve.token);
    await sendOutbox(api.master);
    const { rows: [item] } = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string; decided_via: string }>(
      'SELECT decision, decided_via FROM inbox_items WHERE id = $1', [itemId]));
    assert.deepEqual([item!.decision, item!.decided_via], ['approve', 'chat']);
    // And the item it decided is retracted there.
    const { retractClosed } = await import('../../src/owner/notify.ts');
    const { RelayChannel } = await import('../../src/relay/channel.ts');
    const channel = new RelayChannel(relayId);
    await channel.prepare();
    await retractClosed(fixture.companyId, channel);
    await sendOutbox(api.master);
    assert.ok(relay.received().some((envelope) => envelope.type === 'inbox_closed' && envelope.data.ref === approval.id));
  } finally {
    await relay.close();
    await ntfy.close();
    await api.close();
  }
});

test('the reference relay refuses a deployment whose fingerprint it was not given, and a second pairing', async () => {
  const fixture = await createCompany('relay-reference-refuses');
  const api = await consoleWithSettings();
  const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { fingerprint: string };
  const wrong = await startReferenceRelay({ port: 0, deploymentFingerprint: 'A'.repeat(24), quiet: true });
  const right = await startReferenceRelay({ port: 0, deploymentFingerprint: identity.fingerprint, quiet: true });
  try {
    const token = await api.signIn();
    const pair = async (url: string, fingerprint: string) => {
      const added = await api.call('POST', '/api/control/relays', token, { url });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const relayId = String(added.body.relay.id);
      return { relayId, answer: await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
        fingerprint, companies: [fixture.companyId], proof: { totp: api.code() },
      }) };
    };
    const refused = await pair(wrong.url, wrong.fingerprint);
    assert.deepEqual([refused.answer.status, refused.answer.body.code], [400, 'relay.accept']);

    const first = await pair(right.url, right.fingerprint);
    assert.equal(first.answer.status, 200, JSON.stringify(first.answer.body));
    // Revoked here and added again: the relay takes no second pairing until its operator deletes its state.
    const revoked = await api.call('POST', `/api/control/relays/${first.relayId}/revoke`, token, {});
    assert.equal(revoked.status, 200);
    const second = await pair(right.url, right.fingerprint);
    assert.deepEqual([second.answer.status, second.answer.body.code], [400, 'relay.accept']);
  } finally {
    await wrong.close();
    await right.close();
    await api.close();
  }
});

/** The deployment's signing key, opened from the seed it sealed, as only someone holding that seed could. */
async function sealedKey(api: Awaited<ReturnType<typeof consoleWithSettings>>, ref: string): Promise<KeyObject> {
  const seed = Buffer.from(await api.secrets.resolve(ref), 'base64');
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

test('the reference relay takes a new key only from a rotation that the key it pinned and the new key both sign', async () => {
  const fixture = await createCompany('relay-reference-rotation');
  const api = await consoleWithSettings();
  const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { fingerprint: string; deployment: string };
  const relay = await startReferenceRelay({ port: 0, deploymentFingerprint: identity.fingerprint, quiet: true });
  try {
    const token = await api.signIn();
    const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    const relayId = String(added.body.relay.id);
    const paired = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
      fingerprint: relay.fingerprint, companies: [fixture.companyId], proof: { totp: api.code() },
    });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const { rows: [first] } = await withControlPlane((tx) => tx.query<{ secret_ref: string }>('SELECT secret_ref FROM relay_identity'));
    const old = await sealedKey(api, first!.secret_ref);

    // The owner rotates: the relay is told in an envelope both keys sign, and takes the new key.
    const rotated = await api.call('POST', '/api/control/relay-identity/rotate', token, { proof: { totp: api.code() } });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    await sendOutbox(api.master);
    assert.ok(relay.received().some((envelope) => envelope.type === 'keys_rotated'), 'the rotation is taken');
    assert.equal(relay.refused(), 0);

    // Whoever kept the old key -- the reason a key is rotated -- announces a key of their own, in the old key's week.
    const theirs = generateKeyPairSync('ed25519');
    const post = async (body: Record<string, unknown>, keys: KeyObject[]) => {
      const text = jcs(body);
      const id = String(body.id);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = keys.map((key) => `v1a,${sign(null, Buffer.from(`${id}.${timestamp}.${text}`, 'utf8'), key).toString('base64')}`).join(' ');
      return (await fetch(`${relay.url}/v1/envelopes`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, body: text,
      })).status;
    };
    const announce = () => ({
      v: 1, id: randomUUID(), type: 'keys_rotated', at: new Date().toISOString(), deployment: identity.deployment, relay: relayId,
      key: rawPublicKey(theirs.publicKey).toString('base64url'), kid: '0123456789abcdef', fingerprint: 'X'.repeat(24),
      previous: { key: rawPublicKey(old).toString('base64url'), kid: 'fedcba9876543210', until: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    });
    const refusedBefore = relay.refused();
    assert.notEqual(await post(announce(), [old]), 200, 'signed by the old key alone');
    assert.notEqual(await post(announce(), [old, theirs.privateKey]), 200, 'signed by the old key and the key it names, but not the key the relay pinned');
    const notice = { v: 1, id: randomUUID(), type: 'ping', at: new Date().toISOString(), deployment: identity.deployment, relay: relayId, lang: 'en', text: 'Approve now at https://elsewhere.example' };
    assert.notEqual(await post(notice, [theirs.privateKey]), 200, 'and nothing signed by their key alone is taken');
    assert.equal(relay.refused(), refusedBefore + 3);
    assert.equal(relay.received().filter((envelope) => envelope.type === 'keys_rotated').length, 1);

    // The deployment is still heard, under its new key.
    const tested = await api.call('POST', `/api/control/relays/${relayId}/test`, token, {});
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    await sendOutbox(api.master);
    assert.equal(relay.received().at(-1)!.type, 'ping');
    assert.equal(relay.refused(), refusedBefore + 3);
  } finally {
    await relay.close();
    await api.close();
  }
});
