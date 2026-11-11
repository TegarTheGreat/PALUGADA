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
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { startReferenceRelay } from '../../scripts/relay-reference.ts';
import { jcs } from '../../src/relay/canonical.ts';
import { rawPublicKey } from '../../src/relay/signature.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { handToRelay, sendOutbox } from '../helpers/relay.ts';
import { tell } from '../helpers/notices.ts';
import { companyRoomOf, personIn, seated } from '../helpers/rooms.ts';
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
    // Acts come from the machine the relay runs on, on a loopback listener
    // of their own, never through the relay's public one, nor through a
    // proxy in front of it (STATUS section 2.216).
    const outside = await fetch(`${relay.url}/local/press`, { method: 'POST', body: JSON.stringify({ token: approve.token }) });
    assert.equal(outside.status, 404, 'the public listener takes no act');
    for (const via of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }]) {
      const proxied = await fetch(`${relay.localUrl}/local/press`, { method: 'POST', headers: via, body: JSON.stringify({ token: approve.token }) });
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

test("the reference relay tells a person of a room, and replies, marks read and mutes from the phone", async () => {
  // People's notices (STATUS section 2.213), through the relay written from the document alone.
  const fixture = await createCompany('relay-reference-people');
  const api = await consoleWithSettings();
  const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { fingerprint: string };
  const relay = await startReferenceRelay({ port: 0, deploymentFingerprint: identity.fingerprint, quiet: true });
  try {
    const token = await api.signIn();
    const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
    const relayId = String(added.body.relay.id);
    assert.equal((await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
      fingerprint: relay.fingerprint.slice(0, 16), companies: [fixture.companyId], proof: { totp: api.code() },
    })).status, 200);
    assert.equal((await api.call('POST', `/api/control/relays/${relayId}/settings`, token, {
      share: 'content', mayPost: true, proof: { totp: api.code() },
    })).status, 200);
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const sariIn = personIn(api, sari.token, fixture.companyId);
    const budiIn = personIn(api, budi.token, fixture.companyId);
    const offered = await api.call('POST', '/api/relays/links', sari.token, { relayId });
    await relay.link(String(offered.body.code), 'Sari phone');
    await sendOutbox(api.master);
    await sendOutbox(api.master);

    const dm = String((await budiIn.direct([sari.principal])).body.room.id);
    const first = String((await budiIn.say(dm, 'Can you open the shop?')).body.message.id);
    await tell(fixture.companyId, api.master);
    const notice = relay.received().find((envelope) => envelope.type === 'room_activity')!;
    assert.ok(notice, 'told');
    assert.match(notice.text, /Budi \(@budi\) wrote to you\.\nCan you open the shop\?/);
    const tokens = Object.fromEntries(notice.offers.map((offer: { act: string; token: string }) => [offer.act, offer.token]));

    // Each act is signed by the phone's own key, and the deployment pulls it.
    await relay.reply(tokens.reply, 'Yes, at eight.');
    await relay.read(tokens.read);
    await relay.mute(tokens.mute, new Date(Date.now() + 3_600_000).toISOString());
    await sendOutbox(api.master);
    assert.equal(relay.refused(), 0);
    const page = (await sariIn.page(dm)).body.messages as Array<{ body: string | null; via: string; author: { principal: string } }>;
    assert.ok(page.some((one) => one.body === 'Yes, at eight.' && one.via === 'relay' && one.author.principal === sari.principal));
    const settings = (await sariIn.settings(dm, {})).body as { mutedUntil: string | null };
    assert.ok(settings.mutedUntil !== null, 'muted from the phone');

    // Deleted: the relay drops what it held of it.
    assert.equal((await budiIn.on(dm, first, 'delete')).status, 200);
    await sendOutbox(api.master);
    assert.ok(relay.received().some((envelope) => envelope.type === 'room_activity_retracted' && envelope.data.refs.includes(notice.id)));
    assert.equal(notice.text, undefined, 'what a retraction names is dropped');
  } finally {
    await relay.close();
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

/** The reference relay's command line, run as a person runs it, against a port nothing listens on. */
function relayCommand(...args: string[]): Promise<{ code: number; stderr: string }> {
  const script = fileURLToPath(new URL('../../scripts/relay-reference.ts', import.meta.url));
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args, '--port', '1'], { timeout: 30_000 }, (error, _stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr: String(stderr) });
    });
  });
}

test("the reference relay's commands say how they are used when the hours to mute are not a number of hours", async () => {
  for (const hours of ['soon', '-2', '721']) {
    const muted = await relayCommand('mute', 'pt_token', hours);
    assert.equal(muted.code, 1);
    assert.match(muted.stderr, /^relay: usage: .*mute <token> \[hours\]/, `mute for ${hours}`);
  }
  // A reply's words are not hours: it reaches the relay's port, which here nobody answers.
  const replied = await relayCommand('reply', 'pt_token', 'see', 'you');
  assert.equal(replied.code, 1);
  assert.doesNotMatch(replied.stderr, /Invalid time value|usage/);
});

/** A port nothing listens on now, for a relay that must come back on the same one. */
async function freePort(): Promise<number> {
  const { createServer: createNet } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createNet();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/** A paired reference relay, its state in a file of its own, on a port it can come back on. */
async function pairedReference(api: Awaited<ReturnType<typeof consoleWithSettings>>, token: string, companyId: string, extra: Partial<Parameters<typeof startReferenceRelay>[0]> = {}) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { fingerprint: string; deployment: string };
  const stateFile = join(mkdtempSync(join(tmpdir(), 'palugada-reference-')), 'state.json');
  const port = await freePort();
  const relay = await startReferenceRelay({ port, deploymentFingerprint: identity.fingerprint, stateFile, quiet: true, ...extra });
  const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const relayId = String(added.body.relay.id);
  const paired = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
    fingerprint: relay.fingerprint.slice(0, 16), companies: [companyId], proof: { totp: api.code() },
  });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  return { relay, relayId, stateFile, port, identity };
}

test('the reference relay keeps its inbox, its cursor and the tokens it was sent across a restart', async () => {
  // STATUS section 2.216 (F45).
  const fixture = await createCompany('relay-reference-restart');
  const api = await consoleWithSettings();
  const token = await api.signIn();
  let { relay, relayId, stateFile, port, identity } = await pairedReference(api, token, fixture.companyId);
  try {
    assert.equal((await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { share: 'summary', mayPress: true, proof: { totp: api.code() } })).status, 200);
    const offered = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    await relay.link(String(offered.body.code), 'Owner phone');
    await sendOutbox(api.master);
    await sendOutbox(api.master);
    const itemId = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, actionSummary: 'Send the newsletter', rationale: 'ready', consequenceIfDenied: 'not sent',
    });
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const approve = relay.received().find((envelope) => envelope.type === 'inbox_item')!.offers.find((offer: { act: string }) => offer.act === 'approve');

    // A deploy, a reboot: the relay comes back with its state file, on its port.
    await relay.close();
    relay = await startReferenceRelay({ port, deploymentFingerprint: identity.fingerprint, stateFile, quiet: true });
    // A button printed before the restart still presses, and the deployment pulls it from where it left off.
    await relay.press(approve.token);
    await sendOutbox(api.master);
    const { rows: [item] } = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string | null }>('SELECT decision FROM inbox_items WHERE id = $1', [itemId]));
    assert.equal(item!.decision, 'approve', 'the press after the restart is taken');
    // And a phone linked after the restart is linked.
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const code = await api.call('POST', '/api/relays/links', sari.token, { relayId });
    await relay.link(String(code.body.code), 'Sari phone');
    await sendOutbox(api.master);
    const { rows } = await withControlPlane((tx) => tx.query<{ status: string }>(
      'SELECT status FROM relay_links WHERE relay_id = $1 AND principal = $2', [relayId, sari.principal]));
    assert.deepEqual(rows.map((row) => row.status), ['active']);
    assert.equal(relay.refused(), 0);
  } finally {
    await relay.close();
    await api.close();
  }
});

test('the reference relay prints no words or links above signal unless asked, and drops what it was told a fortnight on', async () => {
  // STATUS section 2.216 (F59, F43).
  const fixture = await createCompany('relay-reference-quiet');
  const api = await consoleWithSettings();
  const token = await api.signIn();
  const lines: string[] = [];
  let offset = 0;
  const ntfy = await fakeNtfy();
  const { relay, relayId } = await pairedReference(api, token, fixture.companyId, {
    quiet: false, log: (line) => lines.push(line), now: () => Date.now() + offset, ntfy: { url: ntfy.url, token: 'tk_test' },
  });
  try {
    assert.equal((await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { share: 'content', proof: { totp: api.code() } })).status, 200);
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
    const budiIn = personIn(api, budi.token, fixture.companyId);
    await companyRoomOf(personIn(api, sari.token, fixture.companyId));
    const offered = await api.call('POST', '/api/relays/links', sari.token, { relayId });
    await relay.link(String(offered.body.code), 'Sari phone');
    await sendOutbox(api.master);
    await sendOutbox(api.master);
    const dm = String((await budiIn.direct([sari.principal])).body.room.id);
    await budiIn.say(dm, 'The safe code is 4242.');
    await tell(fixture.companyId, api.master);
    const notice = relay.received().find((envelope) => envelope.type === 'room_activity')!;
    assert.match(notice.text, /4242/, 'the relay was told the words');
    const printed = lines.join('\n');
    assert.match(printed, /room_activity for /, 'what came, and for whom');
    assert.doesNotMatch(printed, /4242|notice=/, 'but not what it said, nor where it opens');

    // A fortnight on, what it was told is dropped, by the hourly sweep.
    offset = 15 * 86_400_000;
    relay.sweep();
    assert.deepEqual(Object.keys(notice).sort(), ['at', 'deployment', 'id', 'relay', 'to', 'type', 'v']);
    // And an envelope that arrives older than that is neither shown nor forwarded.
    offset = 0;
    const { rows: [identityRow] } = await withControlPlane((tx) => tx.query<{ secret_ref: string }>('SELECT secret_ref FROM relay_identity'));
    const key = await sealedKey(api, identityRow!.secret_ref);
    const { rows: [link] } = await withControlPlane((tx) => tx.query<{ recipient_id: string }>(
      "SELECT recipient_id FROM relay_links WHERE relay_id = $1 AND status = 'active'", [relayId]));
    const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { deployment: string };
    const old = { v: 1, id: randomUUID(), type: 'work_done', at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      deployment: identity.deployment, relay: relayId, to: { recipient: link!.recipient_id }, share: 'content', urgency: 'quiet', lang: 'en',
      text: 'An old account: the vault code is 9191.', link: null, data: {} };
    const text = jcs(old);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const posted = await fetch(`${relay.url}/v1/envelopes`, { method: 'POST', headers: {
      'content-type': 'application/json', 'webhook-id': old.id, 'webhook-timestamp': timestamp,
      'webhook-signature': `v1a,${sign(null, Buffer.from(`${old.id}.${timestamp}.${text}`, 'utf8'), key).toString('base64')}`,
    }, body: text });
    assert.equal(posted.status, 200);
    assert.equal(relay.received().at(-1)!.text, undefined, 'its content is not kept');
    assert.equal(ntfy.posts.some((post) => post.body.includes('9191')), false, 'nor forwarded');
  } finally {
    await relay.close();
    await ntfy.close();
    await api.close();
  }
});

test("the reference relay signs an act when it is pulled, not when it was made, and is told the deployment's answer", async () => {
  // STATUS section 2.216 (F46).
  const fixture = await createCompany('relay-reference-late');
  const api = await consoleWithSettings();
  const token = await api.signIn();
  let offset = 0;
  const { relay, relayId } = await pairedReference(api, token, fixture.companyId, { now: () => Date.now() + offset });
  try {
    const sari = await seated(fixture, 'Sari', 'member', { handle: 'sari' });
    const offered = await api.call('POST', '/api/relays/links', sari.token, { relayId });
    // The code is entered while the deployment cannot reach the relay: six minutes pass before it pulls.
    offset = -6 * 60_000;
    await relay.link(String(offered.body.code), 'Sari phone');
    offset = 0;
    await sendOutbox(api.master);
    await sendOutbox(api.master);
    const { rows } = await withControlPlane((tx) => tx.query<{ status: string }>(
      'SELECT status FROM relay_links WHERE relay_id = $1 AND principal = $2', [relayId, sari.principal]));
    assert.deepEqual(rows.map((row) => row.status), ['active'], 'the claim is taken though it waited');
    const answered = Object.values(relay.results());
    assert.ok(answered.some((one) => one.status === 200 && (one.answer as { result?: { recipient?: string } }).result?.recipient), JSON.stringify(answered));
  } finally {
    await relay.close();
    await api.close();
  }
});

test("a reference relay that missed the deployment's rotation is paired again in place, and one that rotates its own key is taken", async () => {
  // STATUS section 2.216 (F48, F58).
  const { forgetPreviousKey } = await import('../../src/relay/identity.ts');
  const fixture = await createCompany('relay-reference-repin');
  const api = await consoleWithSettings();
  const token = await api.signIn();
  let { relay, relayId, stateFile, port } = await pairedReference(api, token, fixture.companyId);
  try {
    const offered = await api.call('POST', '/api/relays/links', token, { relayId, proof: { totp: api.code() } });
    await relay.link(String(offered.body.code), 'Owner phone');
    await sendOutbox(api.master);
    await sendOutbox(api.master);
    // The deployment rotates while the relay is gone for good, and the old key is forgotten.
    assert.equal((await api.call('POST', '/api/control/relay-identity/rotate', token, { proof: { totp: api.code() } })).status, 200);
    await withControlPlane((tx) => tx.query("DELETE FROM relay_outbox WHERE relay_id = $1 AND type = 'keys_rotated'", [relayId]));
    await forgetPreviousKey(new Date(Date.now() + 8 * 86_400_000));
    // The operator is given the new fingerprint and restarts the relay with it; the owner pairs it again.
    const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { fingerprint: string };
    await relay.close();
    relay = await startReferenceRelay({ port, deploymentFingerprint: identity.fingerprint, stateFile, quiet: true });
    const again = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
      fingerprint: relay.fingerprint.slice(0, 16), companies: [fixture.companyId], proof: { totp: api.code() },
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const refusedBefore = relay.refused();
    assert.equal((await api.call('POST', `/api/control/relays/${relayId}/test`, token, {})).status, 200);
    await sendOutbox(api.master);
    assert.equal(relay.refused(), refusedBefore, 'it verifies the deployment again');
    const { rows: [link] } = await withControlPlane((tx) => tx.query<{ status: string }>(
      "SELECT status FROM relay_links WHERE relay_id = $1 AND principal = 'owner'", [relayId]));
    assert.equal(link!.status, 'active', "the owner's phone is still linked");

    // The relay rotates its own key; the deployment takes it from the relay's inbox.
    const fingerprint = await relay.rotateKey();
    await sendOutbox(api.master);
    await sendOutbox(api.master);
    const page = await api.call('GET', '/api/control/relays', token);
    assert.equal(page.body.relays.find((one: { id: string }) => one.id === relayId).fingerprint, fingerprint);
    const results = Object.values(relay.results());
    assert.ok(results.some((one) => one.status === 200 && (one.answer as { result?: { fingerprint?: string } }).result?.fingerprint === fingerprint));
  } finally {
    await relay.close();
    await api.close();
  }
});
