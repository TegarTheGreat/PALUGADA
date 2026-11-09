/**
 * What PALUGADA tells a relay, and how it gets there (F19.19; STATUS section
 * 2.208).
 *
 * Every envelope is RFC 8785 canonical JSON signed with the deployment's key
 * in the Standard Webhooks `v1a` form, so a relay that parses and forwards it
 * can still prove where it came from. What it carries is the owner's share
 * level and no more: a `signal` relay hears that something happened. Only an
 * incident and a tier 3 approval may ring the phone, and neither ever carries
 * a button. The outbox sends each envelope once under a fixed id, retries
 * with backoff, and gives up into a list the owner sees; it runs in a loop of
 * its own, so a slow relay holds up nothing the worker does, and it runs while
 * everything is stopped.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, verify } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { clearStopAll, requestStopAll } from '../../src/engine/control.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { jcs } from '../../src/relay/canonical.ts';
import { RelayChannel } from '../../src/relay/channel.ts';
import { relayBookkeeping } from '../../src/relay/loop.ts';
import { publicKeyFrom } from '../../src/relay/signature.ts';
import { Worker } from '../../src/worker.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { fakeRelay, type Received } from '../helpers/fake-relay.ts';
import { handToRelay, linkThrough, pairThrough, sendOutbox, tomorrow } from '../helpers/relay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await clearStopAll();
  await closePools();
  await closeSetup();
});

function verifies(key: Buffer, one: Received, body = one.body): boolean {
  const content = Buffer.from(`${one.id}.${one.timestamp}.${body}`, 'utf8');
  return one.signature.split(' ').some((part) => part.startsWith('v1a,')
    && verify(null, content, publicKeyFrom(key), Buffer.from(part.slice(4), 'base64')));
}

const items = (received: Received[]) => received.filter((one) => one.envelope?.type === 'inbox_item');

async function approval(companyId: string, tier: 0 | 1 | 2 | 3, summary: string): Promise<string> {
  return inbox.requestApproval({
    companyId, capabilityName: 'payment.send', tier, actionSummary: summary,
    rationale: 'The invoice is verified.', consequenceIfDenied: 'The supplier is not paid.',
  });
}

test("an envelope is canonical JSON signed with the deployment's key, and still verifies after the relay parses and re-serialises it", async () => {
  const fixture = await createCompany('relay-signed');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share: 'summary' });
    await linkThrough(api, token, relay, relayId);
    await approval(fixture.companyId, 2, 'Pay invoice 42');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);

    const identity = await (await fetch(`${api.url}/api/relay/v1/identity`)).json() as { key: string; kid: string; deployment: string };
    const [one] = items(relay.received);
    assert.ok(one, 'the item reached the relay');
    assert.equal(one.contentType, 'application/json');
    assert.equal(one.version, '1');
    assert.equal(one.key, identity.kid);
    assert.equal(one.id, one.envelope.id, 'the envelope id is the webhook id');
    assert.match(one.timestamp, /^\d{10}$/);
    assert.equal(one.body, jcs(one.envelope), 'the body is the canonical form of itself');
    assert.ok(verifies(Buffer.from(identity.key, 'base64url'), one));
    // Parsed, its keys shuffled and written out again with spaces, then made canonical: the same bytes, the same proof.
    const shuffled = JSON.stringify(Object.fromEntries(Object.entries(one.envelope).reverse()), null, 2);
    assert.ok(verifies(Buffer.from(identity.key, 'base64url'), one, jcs(JSON.parse(shuffled))));
    assert.ok(!verifies(Buffer.from(identity.key, 'base64url'), one, shuffled), 'a different text is a different message');
    assert.deepEqual(
      [one.envelope.v, one.envelope.type, one.envelope.deployment, one.envelope.relay],
      [1, 'inbox_item', identity.deployment, relayId],
    );
    assert.match(one.envelope.to.recipient, /^[A-Z2-7]{26}$/);
    assert.match(one.envelope.company.ref, /^co_[A-Z2-7]{16}$/);
    assert.equal(one.envelope.company.name, (await withControlPlane((tx) => tx.query<{ name: string }>(
      'SELECT name FROM companies WHERE id = $1', [fixture.companyId]))).rows[0]!.name);
    assert.equal(JSON.stringify(one.envelope).includes(fixture.companyId), false, 'a company is named to a relay by its reference, never its id');
  } finally {
    await api.close();
    await relay.close();
  }
});

test('the canonical form matches the RFC 8785 test vectors', () => {
  // RFC 8785 section 3.2.3: values, escapes and numbers.
  assert.equal(
    jcs({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27], string: '€$\u000f\nA\'B"\\\\"/', literals: [null, true, false] }),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
  // Section 3.2.3's sorting example: keys in order of their UTF-16 code units.
  assert.equal(
    jcs({ '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One',
      '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis' }),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
  // Appendix B: the numbers, from their IEEE 754 bits.
  for (const [bits, expected] of [
    ['0000000000000000', '0'], ['8000000000000000', '0'], ['0000000000000001', '5e-324'], ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'], ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'], ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'], ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'], ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'], ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'], ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'], ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'], ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'], ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'], ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ] as const) {
    assert.equal(jcs(Buffer.from(bits, 'hex').readDoubleBE(0)), expected, bits);
  }
  // What has no canonical form is refused rather than written some way.
  for (const bits of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000']) {
    assert.throws(() => jcs({ n: Buffer.from(bits, 'hex').readDoubleBE(0) }), /finite/);
  }
  assert.throws(() => jcs({ s: 'half \ud83d of a pair' }), /UTF-16/);
  assert.throws(() => jcs({ s: '\ude00 alone' }), /UTF-16/);
  assert.throws(() => jcs([undefined]), /JSON/);
  assert.throws(() => jcs({ when: new Date(0) }), /JSON/);
  assert.equal(jcs({ a: undefined, b: 1 }), '{"b":1}', 'a field that is not there is not written');
});

test('a signal relay is told that something happened and nothing else', async () => {
  const fixture = await createCompany('relay-signal');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    // Presses are on, and the owner's phone has a key: still nothing to press at signal.
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], mayPress: true });
    await linkThrough(api, token, relay, relayId, { device: true });
    await approval(fixture.companyId, 2, 'Pay PT Sumber Rejeki for invoice 42');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const [one] = items(relay.received);
    assert.ok(one);
    const { rows: [company] } = await withControlPlane((tx) => tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [fixture.companyId]));
    for (const secret of ['Sumber', 'invoice 42', company!.name, 'payment.send', 'not paid']) {
      assert.equal(one.body.includes(secret), false, `a signal relay is not told "${secret}"`);
    }
    assert.equal(one.envelope.share, 'signal');
    assert.deepEqual(one.envelope.data, { kind: 'approval', tier: 2 });
    assert.deepEqual(Object.keys(one.envelope.company), ['ref']);
    assert.deepEqual(one.envelope.offers, []);
    assert.match(one.envelope.link, /^https:\/\/palugada\.example\//);
    assert.equal(typeof one.envelope.text, 'string');
    assert.ok(one.envelope.text.length > 0, 'a relay that renders nothing has a sentence to show');

    // And a person's own lower ceiling holds even where the relay's is higher.
    const set = await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { share: 'content', proof: { totp: api.code() } });
    assert.equal(set.status, 200);
    const other = await createCompany('relay-signal-two');
    await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { companies: [fixture.companyId, other.companyId], proof: { totp: api.code() } });
    await linkThrough(api, token, relay, relayId, { device: true, share: 'signal' });
    await approval(other.companyId, 2, 'Pay PT Maju for invoice 77');
    await handToRelay(other.companyId, relayId);
    await sendOutbox(api.master);
    const latest = items(relay.received).at(-1)!;
    assert.equal(latest.envelope.share, 'signal');
    assert.equal(latest.body.includes('Maju'), false);
  } finally {
    await api.close();
    await relay.close();
  }
});

test('tier 3 approvals and incidents go out as a link, without offers, at every share level', async () => {
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    for (const share of ['signal', 'summary', 'content'] as const) {
      const fixture = await createCompany(`relay-tier3-${share}`);
      const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share, mayPress: true });
      await linkThrough(api, token, relay, relayId, { device: true });
      const before = items(relay.received).length;
      await approval(fixture.companyId, 3, 'Wire Rp 500 juta');
      await inbox.raiseIncident({ companyId: fixture.companyId, title: 'The gateway is down', detail: 'since noon' });
      await approval(fixture.companyId, 2, 'Send the newsletter');
      await handToRelay(fixture.companyId, relayId);
      await sendOutbox(api.master);
      const sent = items(relay.received).slice(before);
      assert.equal(sent.length, 3, share);
      for (const one of sent) {
        const grave = one.envelope.data.kind === 'incident' || one.envelope.data.tier === 3;
        assert.match(one.envelope.link, /^https:\/\//, `${share}: every item carries its link`);
        if (grave) assert.deepEqual(one.envelope.offers, [], `${share}: ${one.envelope.data.kind} carries nothing to press`);
        else if (share === 'signal') assert.deepEqual(one.envelope.offers, []);
        else assert.deepEqual(one.envelope.offers.map((offer: { act: string }) => offer.act).sort(), ['approve', 'deny']);
      }
      const { rows } = await withControlPlane((tx) => tx.query<{ tier: number | null; kind: string }>(
        `SELECT i.tier, i.kind FROM relay_offers o JOIN inbox_items i ON i.id = o.inbox_item_id WHERE o.relay_id = $1`, [relayId]));
      assert.deepEqual(rows.filter((row) => row.kind !== 'approval' || (row.tier ?? 0) >= 3), [], 'no offer is ever made at tier 3 or for an incident');
      // One relay at a time, so the next level's is the only one with the owner's phone.
      await api.call('POST', `/api/control/relays/${relayId}/revoke`, token, {});
    }
  } finally {
    await api.close();
    await relay.close();
  }
});

test('only an incident and a tier 3 approval ask the phone to ring', async () => {
  const fixture = await createCompany('relay-urgency');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share: 'summary' });
    await linkThrough(api, token, relay, relayId);
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Disk full', detail: 'ninety-nine per cent' });
    await approval(fixture.companyId, 3, 'Delete the old backups');
    await approval(fixture.companyId, 2, 'Send the newsletter');
    await inbox.raiseEscalation({ companyId: fixture.companyId, title: 'Which supplier?', detail: 'Two match.' });
    await inbox.raiseBudgetAlert({ companyId: fixture.companyId, title: 'Spent 80% of the month', detail: 'Rp 4 juta of 5' });
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const urgency = Object.fromEntries(items(relay.received).map((one) => [
      `${one.envelope.data.kind}${one.envelope.data.tier === null || one.envelope.data.tier === undefined ? '' : `:${one.envelope.data.tier}`}`,
      one.envelope.urgency,
    ]));
    assert.deepEqual(urgency, {
      incident: 'interrupt',
      'approval:3': 'interrupt',
      'approval:2': 'normal',
      escalation: 'normal',
      budget_alert: 'quiet',
    });
  } finally {
    await api.close();
    await relay.close();
  }
});

test('the outbox sends each envelope once, retries with backoff under the same id, and gives up into a list the owner sees', async () => {
  const fixture = await createCompany('relay-retry');
  let failing = true;
  const relay = await fakeRelay({ answer: (one) => (one.envelope?.type === 'inbox_item' && failing ? { status: 500 } : undefined) });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId] });
    await linkThrough(api, token, relay, relayId);
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Down', detail: 'since noon' });
    await handToRelay(fixture.companyId, relayId);
    // Handed twice: still one envelope.
    await handToRelay(fixture.companyId, relayId);
    const { rows: queued } = await withControlPlane((tx) => tx.query<{ id: string }>(
      "SELECT id FROM relay_outbox WHERE relay_id = $1 AND type = 'inbox_item'", [relayId]));
    assert.equal(queued.length, 1);

    let at = new Date();
    await sendOutbox(api.master, at);
    assert.equal(items(relay.received).length, 1);
    // Not due again until thirty seconds have passed, then a minute, then two.
    await sendOutbox(api.master, new Date(at.getTime() + 20_000));
    assert.equal(items(relay.received).length, 1, 'a failure is not tried again at once');
    const waits: number[] = [];
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      const { rows: [row] } = await withControlPlane((tx) => tx.query<{ next_at: Date; attempts: number; status: string }>(
        'SELECT next_at, attempts, status FROM relay_outbox WHERE id = $1', [queued[0]!.id]));
      assert.equal(row!.status, 'pending');
      waits.push(Math.round((row!.next_at.getTime() - at.getTime()) / 1000));
      at = new Date(row!.next_at.getTime() + 1000);
      await sendOutbox(api.master, at);
    }
    assert.deepEqual(waits, [30, 60, 120, 240, 480, 960, 1920]);
    const sent = items(relay.received);
    assert.equal(sent.length, 8, 'eight attempts in all');
    assert.deepEqual([...new Set(sent.map((one) => one.id))], [queued[0]!.id], 'every attempt under the same id');

    const { rows: [dead] } = await withControlPlane((tx) => tx.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM relay_outbox WHERE id = $1', [queued[0]!.id]));
    assert.equal(dead!.status, 'dead');
    assert.match(dead!.last_error, /500/);
    const page = await api.call('GET', '/api/control/relays', token);
    const shown = page.body.relays.find((one: { id: string }) => one.id === relayId);
    assert.deepEqual(shown.dead.map((one: { id: string; type: string }) => [one.id, one.type]), [[queued[0]!.id, 'inbox_item']]);
    assert.equal(shown.outbox.dead, 1);

    // Retry puts it back, and a relay that answers takes it.
    failing = false;
    const retried = await api.call('POST', `/api/control/relays/${relayId}/retry`, token, {});
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    await sendOutbox(api.master, new Date(at.getTime() + 1000));
    assert.equal(items(relay.received).length, 9);
    const { rows: [delivered] } = await withControlPlane((tx) => tx.query<{ status: string }>('SELECT status FROM relay_outbox WHERE id = $1', [queued[0]!.id]));
    assert.equal(delivered!.status, 'delivered');
    await sendOutbox(api.master, new Date(at.getTime() + 60_000));
    assert.equal(items(relay.received).length, 9, 'delivered is delivered');
  } finally {
    await api.close();
    await relay.close();
  }
});

test('an envelope whose send was cut off is sent again once, under the same id', async () => {
  const fixture = await createCompany('relay-cut');
  const relay = await fakeRelay({ answer: (one, index) => (index > 0 && relayDuplicate(one) ? { status: 409 } : undefined) });
  const seen = new Set<string>();
  function relayDuplicate(one: Received): boolean {
    const again = seen.has(one.id);
    seen.add(one.id);
    return again;
  }
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId] });
    await linkThrough(api, token, relay, relayId);
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Down', detail: 'since noon' });
    await handToRelay(fixture.companyId, relayId);
    // A process took the envelope and died before it learned how the send went.
    const { rows: [row] } = await withControlPlane((tx) => tx.query<{ id: string }>(
      `UPDATE relay_outbox SET status = 'sending', claimed_at = now() - interval '11 minutes'
        WHERE relay_id = $1 AND type = 'inbox_item' RETURNING id`, [relayId]));
    await sendOutbox(api.master);
    assert.deepEqual(items(relay.received).map((one) => one.id), [row!.id], 'sent again, under the same id');
    // One taken a moment ago is another process's, still sending.
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Still down', detail: 'an hour on' });
    await handToRelay(fixture.companyId, relayId);
    await withControlPlane((tx) => tx.query(
      `UPDATE relay_outbox SET status = 'sending', claimed_at = now() WHERE relay_id = $1 AND status = 'pending'`, [relayId]));
    await sendOutbox(api.master);
    assert.equal(items(relay.received).length, 1, 'a send in flight elsewhere is left to it');
    // A relay that already had it answers 409, which is as good as taken.
    await withControlPlane((tx) => tx.query(
      `UPDATE relay_outbox SET status = 'pending', next_at = now() WHERE id = $1`, [row!.id]));
    await sendOutbox(api.master);
    const { rows: [after] } = await withControlPlane((tx) => tx.query<{ status: string }>('SELECT status FROM relay_outbox WHERE id = $1', [row!.id]));
    assert.equal(after!.status, 'delivered');
  } finally {
    await api.close();
    await relay.close();
  }
});

test('a closed item is retracted at the relay, and its offers voided', async () => {
  const fixture = await createCompany('relay-retract');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share: 'summary', mayPress: true });
    await linkThrough(api, token, relay, relayId, { device: true });
    const itemId = await approval(fixture.companyId, 2, 'Send the newsletter');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const [sent] = items(relay.received);
    assert.equal(sent!.envelope.offers.length, 2);

    // Decided in the app, then the worker's notify stage comes round.
    await inbox.decide(fixture.companyId, itemId, 'deny', 'not this week', { channel: 'app', assurance: 'session' });
    const channel = new RelayChannel(relayId);
    await channel.prepare();
    const { retractClosed } = await import('../../src/owner/notify.ts');
    const retracted = await retractClosed(fixture.companyId, channel);
    assert.equal(retracted.retracted, 1);
    await sendOutbox(api.master);
    const closed = relay.received.find((one) => one.envelope?.type === 'inbox_closed')!;
    assert.ok(closed, 'the relay is told the item closed');
    assert.equal(closed.envelope.data.ref, sent!.id, 'by the envelope it was told about it in');
    assert.equal(closed.envelope.text, 'Denied. Nothing left to press here.');
    const { rows } = await withControlPlane((tx) => tx.query(
      'SELECT 1 FROM relay_offers WHERE inbox_item_id = $1 AND voided_at IS NULL', [itemId]));
    assert.equal(rows.length, 0);
  } finally {
    await api.close();
    await relay.close();
  }
});

test('a company the relay does not cover sends it nothing', async () => {
  const covered = await createCompany('relay-covered');
  const other = await createCompany('relay-uncovered');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [covered.companyId] });
    const linked = await linkThrough(api, token, relay, relayId);
    assert.equal(linked.companies.length, 1, 'the link is told of the companies it covers, by reference');
    await inbox.raiseIncident({ companyId: covered.companyId, title: 'Covered', detail: 'x' });
    await inbox.raiseIncident({ companyId: other.companyId, title: 'Uncovered', detail: 'x' });
    await handToRelay(covered.companyId, relayId);
    await handToRelay(other.companyId, relayId);
    await sendOutbox(api.master);
    assert.deepEqual(items(relay.received).map((one) => one.envelope.company.ref), linked.companies);
    const { rows } = await withControlPlane((tx) => tx.query('SELECT 1 FROM relay_outbox WHERE company_id = $1', [other.companyId]));
    assert.equal(rows.length, 0, 'not queued, not sent');
  } finally {
    await api.close();
    await relay.close();
  }
});

test("a slow relay does not hold up the worker's tick", async () => {
  const fixture = await createCompany('relay-slow');
  const relay = await fakeRelay({ answer: () => ({ status: 200, delayMs: 4_000 }) });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId] });
    await linkThrough(api, token, relay, relayId);
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Down', detail: 'since noon' });
    const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-relay' });
    const worker = new Worker({ engine, companyId: fixture.companyId, ownerChannels: [new RelayChannel(relayId)] });
    const started = Date.now();
    const report = await worker.tick(tomorrow(), { runs: false });
    assert.ok(Date.now() - started < 3_000, `the tick took ${Date.now() - started} ms`);
    assert.equal(report.notified, 1);
    assert.equal(relay.received.filter((one) => one.envelope?.type === 'inbox_item').length, 0, 'the tick only queued it');
    const { rows } = await withControlPlane((tx) => tx.query("SELECT 1 FROM relay_outbox WHERE relay_id = $1 AND type = 'inbox_item' AND status = 'pending'", [relayId]));
    assert.equal(rows.length, 1);
  } finally {
    await api.close();
    await relay.close();
  }
});

test('the relay loop delivers while everything is stopped', async () => {
  const fixture = await createCompany('relay-stopped');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId] });
    await linkThrough(api, token, relay, relayId);
    await inbox.raiseIncident({ companyId: fixture.companyId, title: 'Something is wrong', detail: 'the owner pressed stop' });
    await requestStopAll();
    const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-stopped' });
    const worker = new Worker({ engine, companyId: fixture.companyId, ownerChannels: [new RelayChannel(relayId)] });
    const report = await worker.tick(tomorrow());
    assert.equal(report.stopped, true);
    await sendOutbox(api.master);
    assert.equal(items(relay.received).length, 1, 'what the owner is owed reaches them while everything is stopped');
  } finally {
    await clearStopAll();
    await api.close();
    await relay.close();
  }
});

test('spent offers, old receipts, old dead letters and old refusals are purged', async () => {
  const fixture = await createCompany('relay-purge');
  const relay = await fakeRelay();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const relayId = await pairThrough(api, token, relay, { companies: [fixture.companyId], share: 'summary', mayPress: true });
    await linkThrough(api, token, relay, relayId, { device: true });
    const itemId = await approval(fixture.companyId, 2, 'Send it');
    await handToRelay(fixture.companyId, relayId);
    await sendOutbox(api.master);
    const old = new Date(Date.now() - 15 * 86_400_000);
    await withControlPlane(async (tx) => {
      // Two offers: one spent a fortnight ago, one still live.
      const { rows: offers } = await tx.query<{ token_hash: string }>('SELECT token_hash FROM relay_offers WHERE inbox_item_id = $1 ORDER BY act', [itemId]);
      await tx.query('UPDATE relay_offers SET uses = max_uses, created_at = $2, expires_at = $2 WHERE token_hash = $1', [offers[0]!.token_hash, old]);
      await tx.query("INSERT INTO relay_receipts (relay_id, envelope_id, received_at, result) VALUES ($1, 'old', $2, '{}'), ($1, 'new', now(), '{}')", [relayId, old]);
      await tx.query("INSERT INTO relay_refusals (relay_id, reason, at) VALUES ($1, 'relay.press_unknown', $2), ($1, 'relay.press_unknown', now())", [relayId, old]);
      await tx.query(
        `INSERT INTO relay_outbox (id, relay_id, type, body, status, created_at) VALUES
           ($2, $1, 'ping', '{}', 'dead', $4), ($3, $1, 'ping', '{}', 'dead', now())`,
        [relayId, randomUUID(), randomUUID(), old]);
      await tx.query("UPDATE relay_outbox SET created_at = $2, delivered_at = $2 WHERE relay_id = $1 AND status = 'delivered'", [relayId, old]);
    });
    const purged = await relayBookkeeping(new Date());
    assert.ok(purged.offers >= 1 && purged.receipts === 1 && purged.refusals === 1 && purged.outbox >= 2, JSON.stringify(purged));
    const count = async (sql: string) => (await withControlPlane((tx) => tx.query(sql, [relayId]))).rows.length;
    assert.equal(await count('SELECT 1 FROM relay_offers WHERE relay_id = $1'), 1, 'the live offer stays');
    assert.equal(await count('SELECT 1 FROM relay_receipts WHERE relay_id = $1'), 1);
    assert.equal(await count('SELECT 1 FROM relay_refusals WHERE relay_id = $1'), 1);
    assert.equal(await count("SELECT 1 FROM relay_outbox WHERE relay_id = $1 AND status = 'dead'"), 1, 'the new dead letter stays for the owner to see');
    assert.equal(await count("SELECT 1 FROM relay_outbox WHERE relay_id = $1 AND status = 'delivered'"), 0);
  } finally {
    await api.close();
    await relay.close();
  }
});
