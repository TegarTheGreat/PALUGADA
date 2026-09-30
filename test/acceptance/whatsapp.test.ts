/**
 * WhatsApp as the owner's channel (F10.9), through Meta's Cloud API.
 *
 * In Indonesia the owner's messenger is WhatsApp, not Telegram, and Meta's own
 * Business Agent answers a company's customers there. These hold what makes a
 * chat an action surface rather than a hole: only the owner's number is heard,
 * only a delivery Meta signed is read, the same delivery is never acted on
 * twice -- Meta retries for days -- and a tier 3 approval is a link, never a
 * button (F10.10).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { dispatch, type NotifiableItem } from '../../src/owner/notify.ts';
import { encodeAction, type ChatConversation } from '../../src/owner/telegram.ts';
import { WhatsAppChannel } from '../../src/owner/whatsapp.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const OWNER = '6281234567890';
const APP_SECRET = 'app-secret-for-the-whatsapp-tests';

interface Sent {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** Meta's Graph API, as far as sending a message goes. */
async function fakeGraph(
  reply: (sent: Sent, index: number) => { status: number; body: unknown } = (_sent, index) =>
    ({ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${index}` }] } }),
): Promise<{ url: string; sent: Sent[]; close: () => Promise<void> }> {
  const sent: Sent[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const one = { path: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(raw || '{}') as Record<string, unknown> };
      sent.push(one);
      const answer = reply(one, sent.length - 1);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    sent,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function whatsapp(url: string, extra: Partial<ConstructorParameters<typeof WhatsAppChannel>[0]> = {}) {
  return new WhatsAppChannel({
    phoneNumberId: '1111', token: 'wa-token-0123456789abcdef', appSecret: APP_SECRET,
    verifyToken: 'verify-token-0123456789', owner: OWNER, apiBase: url,
    appUrl: (item) => `https://app.palugada.test/i/${item.id}`,
    ...extra,
  });
}

/** A delivery as Meta posts it, with one message from `from`. */
function delivery(message: Record<string, unknown>, from = OWNER): Buffer {
  return Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '628000', phone_number_id: '1111' },
      contacts: [{ profile: { name: 'Owner' }, wa_id: from }],
      messages: [{ from, timestamp: '1790000000', ...message }],
    } }] }],
  }));
}

const signed = (raw: Buffer, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

const press = (id: string, title: string, messageId: string) =>
  ({ id: messageId, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });

async function approval(fixture: Fixture, tier: 0 | 1 | 2 | 3): Promise<string> {
  return inbox.requestApproval({
    companyId: fixture.companyId, capabilityName: 'payment.send', tier,
    actionSummary: 'Pay the roaster Rp 4.500.000', rationale: 'The invoice is verified.',
    consequenceIfDenied: 'The roaster is not paid.',
  });
}

const item = (over: Partial<NotifiableItem> = {}): NotifiableItem => ({
  id: '11111111-2222-3333-4444-555555555555', companyId: '66666666-7777-8888-9999-000000000000',
  kind: 'approval', tier: 2, title: 'Pay the roaster', actionSummary: 'Rp 4.500.000 to the roaster',
  consequenceIfDenied: 'The roaster is not paid.', delivery: 'actionable', url: null, ...over,
});

test('an approval reaches WhatsApp with Approve, Deny and Ask; a tier 3 one only as a link; a run\'s choices as a list', async () => {
  const channel = whatsapp('http://127.0.0.1:9');
  const buttons = channel.render(item()) as {
    type: string; interactive: { type: string; body: { text: string }; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
  };
  assert.equal(buttons.type, 'interactive');
  assert.equal(buttons.interactive.type, 'button');
  assert.match(buttons.interactive.body.text, /Pay the roaster/);
  assert.deepEqual(buttons.interactive.action.buttons.map((one) => one.reply.title), ['Approve', 'Deny', 'Ask']);
  assert.equal(buttons.interactive.action.buttons[0]!.reply.id, encodeAction({ itemId: item().id, decision: 'approve' }));
  assert.ok(buttons.interactive.action.buttons.every((one) => one.reply.title.length <= 20), 'WhatsApp refuses a title over 20');

  const link = channel.render(item({ tier: 3, delivery: 'link_only', url: 'https://app.palugada.test/i/x' })) as {
    type: string; text: { body: string };
  };
  assert.equal(link.type, 'text', 'F10.10: nothing to press');
  assert.match(link.text.body, /decided in the app/);
  assert.match(link.text.body, /https:\/\/app\.palugada\.test\/i\/x/);

  const chosen = channel.render(item({ kind: 'escalation', question: 'Which roast for the office blend?', options: ['Light', 'Medium, as last month', 'Dark'] })) as {
    interactive: { type: string; action: { sections: Array<{ rows: Array<{ id: string; title: string }> }> } };
  };
  assert.equal(chosen.interactive.type, 'list');
  const rows = chosen.interactive.action.sections[0]!.rows;
  assert.deepEqual(rows.map((row) => row.id).slice(0, 3), [0, 1, 2].map((choice) => encodeAction({ itemId: item().id, decision: 'approve', choice })));
  assert.ok(rows.every((row) => row.title.length <= 24), 'WhatsApp refuses a row title over 24');
});

test('delivery goes to the owner\'s number; outside WhatsApp\'s 24-hour window it goes as the approved template, and says so without one', async () => {
  const fixture = await createCompany('wa-deliver');
  const graph = await fakeGraph((_sent, index) => index === 0
    ? { status: 400, body: { error: { message: '(#131047) Re-engagement message', type: 'OAuthException', code: 131047 } } }
    : { status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.template-1' }] } });
  try {
    await approval(fixture, 2);
    const channel = whatsapp(graph.url, { template: { name: 'palugada_notice', language: 'id' } });
    // A day on, so the owner's waking hours have certainly come round (F10.5).
    await dispatch(fixture.companyId, channel, { now: new Date(Date.now() + 86_400_000) });
    assert.equal(graph.sent[0]!.path, '/1111/messages');
    assert.equal(graph.sent[0]!.authorization, 'Bearer wa-token-0123456789abcdef');
    assert.equal(graph.sent[0]!.body.to, OWNER);
    assert.equal(graph.sent[0]!.body.type, 'interactive');
    // The owner has not written in a day: only a template may open the conversation.
    const template = graph.sent[1]!.body as { type: string; template: { name: string; language: { code: string }; components: Array<{ parameters: Array<{ text: string }> }> } };
    assert.equal(template.type, 'template');
    assert.equal(template.template.name, 'palugada_notice');
    assert.equal(template.template.language.code, 'id');
    assert.match(template.template.components[0]!.parameters[0]!.text, /Rp 4\.500\.000|payment\.send/);

    // Without a template the owner is told how to get one, not left to guess.
    const bare = whatsapp(graph.url);
    graph.sent.length = 0;
    const refusal = await fakeGraph(() => ({ status: 400, body: { error: { message: '(#131047) Re-engagement message', code: 131047 } } }));
    try {
      await assert.rejects(whatsapp(refusal.url).deliver(item()),
        /the owner has not written to this number in the last 24 hours.*PALUGADA_WHATSAPP_TEMPLATE/);
    } finally {
      await refusal.close();
    }
    void bare;
  } finally {
    await graph.close();
  }
});

test('Meta\'s subscription check is answered only with the verify token', () => {
  const channel = whatsapp('http://127.0.0.1:9');
  const ask = (token: string) => channel.verifySubscription(new URLSearchParams({
    'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444',
  }));
  assert.equal(ask('verify-token-0123456789'), '1158201444');
  assert.equal(ask('a-guess'), null);
});

test('a press from the owner decides; unsigned, from another number, or the same delivery again, nothing is decided', async () => {
  const fixture = await createCompany('wa-press');
  const graph = await fakeGraph();
  try {
    const itemId = await approval(fixture, 2);
    const channel = whatsapp(graph.url);
    const deny = delivery(press(encodeAction({ itemId, decision: 'deny' }), 'Deny', 'wamid.in-1'));

    assert.equal((await channel.onDelivery(deny, undefined)).reason, 'signature', 'Meta signs every delivery');
    assert.equal((await channel.onDelivery(deny, signed(deny, 'somebody-else'))).reason, 'signature');

    const stranger = delivery(press(encodeAction({ itemId, decision: 'approve' }), 'Approve', 'wamid.in-2'), '6289999999999');
    const refused = await channel.onDelivery(stranger, signed(stranger));
    assert.equal(refused.results[0]!.reason, 'not_the_owner');
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'a stranger decides nothing');
    const events = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'security.chat_stranger_refused'"));
    assert.equal(events.rows[0]?.payload.channel, 'whatsapp');

    const decided = await channel.onDelivery(deny, signed(deny));
    assert.equal(decided.results[0]!.handled, true);
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
    assert.match(String((graph.sent.at(-1)!.body.text as { body: string }).body), /Recorded: deny/);

    // Meta retries a delivery it did not see answered, for days, and after a
    // restart too: the same message is recognised and left alone.
    const again = await channel.onDelivery(deny, signed(deny));
    assert.equal(again.results[0]!.reason, 'duplicate');
    const fresh = whatsapp(graph.url);
    assert.equal((await fresh.onDelivery(deny, signed(deny))).results[0]!.reason, 'duplicate', 'kept in the database, not in memory');
  } finally {
    await graph.close();
  }
});

test('a forged tier 3 press from the owner\'s own number approves nothing (F10.10)', async () => {
  const fixture = await createCompany('wa-tier3');
  const graph = await fakeGraph();
  try {
    const itemId = await approval(fixture, 3);
    const forged = delivery(press(encodeAction({ itemId, decision: 'approve' }), 'Approve', 'wamid.in-3'));
    const outcome = await whatsapp(graph.url).onDelivery(forged, signed(forged));
    assert.equal(outcome.results[0]!.reason, 'approval.channel_forbidden');
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);
    assert.match(String((graph.sent.at(-1)!.body.text as { body: string }).body), /has to be approved in the app/);
  } finally {
    await graph.close();
  }
});

test('Ask asks for the question, and the owner\'s reply to that message is what the task reads (F10.3)', async () => {
  const fixture = await createCompany('wa-ask');
  const graph = await fakeGraph();
  try {
    const itemId = await approval(fixture, 2);
    const channel = whatsapp(graph.url);
    const ask = delivery(press(encodeAction({ itemId, decision: 'ask' }), 'Ask', 'wamid.in-4'));
    await channel.onDelivery(ask, signed(ask));
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'a press is not a question yet');
    const prompt = graph.sent.at(-1)!;
    assert.match(String((prompt.body.text as { body: string }).body), /Reply to this message with your question/);

    const reply = delivery({ id: 'wamid.in-5', type: 'text', text: { body: 'Is this the March invoice?' }, context: { from: '628000', id: 'wamid.out-0' } });
    const answered = await channel.onDelivery(reply, signed(reply));
    assert.equal(answered.results[0]!.handled, true);
    const asked = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string; owner_note: string }>(
      'SELECT decision, owner_note FROM inbox_items WHERE id = $1', [itemId]));
    assert.deepEqual(asked.rows[0], { decision: 'ask', owner_note: 'Is this the March invoice?' });
  } finally {
    await graph.close();
  }
});

test('the owner\'s own words go to the conversation, and its answer comes back on WhatsApp', async () => {
  const graph = await fakeGraph();
  try {
    const heard: Array<{ companyId: string | null; text: string }> = [];
    const conversation = {
      hears: false, speaks: false,
      partners: async () => [], current: async () => null, moveTo: async () => undefined,
      talk: async (companyId: string | null, text: string) => {
        heard.push({ companyId, text });
        return { answer: 'Sales are up 12% this week.', cards: [{ id: 'card-1', summary: 'Raise the ad budget', here: false }] };
      },
      hear: async () => '', speak: async () => { throw new Error('no voice'); },
      apply: async () => ({ outcome: 'unknown' as const }),
    } as unknown as ChatConversation;
    const words = delivery({ id: 'wamid.in-6', type: 'text', text: { body: 'How are sales?' } });
    const channel = whatsapp(graph.url);
    const outcome = await channel.onDelivery(words, signed(words), { conversation });
    assert.equal(outcome.results[0]!.handled, true);
    // Answered after the delivery was, since a model can take longer than Meta waits.
    await channel.settled();
    assert.deepEqual(heard, [{ companyId: null, text: 'How are sales?' }]);
    const answer = String((graph.sent.at(-1)!.body.text as { body: string }).body);
    assert.match(answer, /Sales are up 12% this week\./);
    assert.match(answer, /Raise the ad budget/, 'a proposal is named, to be applied in the app');
  } finally {
    await graph.close();
  }
});

/** A status delivery: WhatsApp reporting what became of a message it accepted. */
function failed(messageId: string, code: number): Buffer {
  return Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '628000', phone_number_id: '1111' },
      statuses: [{ id: messageId, status: 'failed', recipient_id: OWNER, timestamp: '1790000001', errors: [{ code, title: 'Re-engagement message' }] }],
    } }] }],
  }));
}

test('a message WhatsApp accepted and then reported outside the window goes as the template, and its buttons come when the owner writes', async () => {
  const fixture = await createCompany('wa-window');
  const graph = await fakeGraph();
  try {
    const itemId = await approval(fixture, 2);
    const channel = whatsapp(graph.url, { template: { name: 'palugada_notice', language: 'id' } });
    await dispatch(fixture.companyId, channel, { now: new Date(Date.now() + 86_400_000) });
    assert.equal(graph.sent.length, 1);
    assert.equal(graph.sent[0]!.body.type, 'interactive', 'accepted by the send call');

    // A minute later Meta says it could not be delivered.
    const report = failed('wamid.out-0', 131047);
    await channel.onDelivery(report, signed(report));
    await channel.settled();
    assert.equal(graph.sent.length, 2);
    assert.equal(graph.sent[1]!.body.type, 'template');
    // The same report again, as Meta sends one it did not see answered: no second template.
    await channel.onDelivery(report, signed(report));
    await channel.settled();
    assert.equal(graph.sent.length, 2);

    // The owner answers the template: the window is open, and the buttons go now.
    const hello = delivery({ id: 'wamid.in-7', type: 'button', button: { payload: 'show', text: 'Show me' } });
    await channel.onDelivery(hello, signed(hello));
    const again = graph.sent.at(-1)!.body as { type: string; interactive: { action: { buttons: Array<{ reply: { id: string } }> } } };
    assert.equal(again.type, 'interactive');
    assert.equal(again.interactive.action.buttons[0]!.reply.id, encodeAction({ itemId, decision: 'approve' }));
    // Only once: a second message from the owner sends nothing more of it.
    const count = graph.sent.length;
    const more = delivery({ id: 'wamid.in-8', type: 'button', button: { payload: 'show', text: 'Show me' } });
    await channel.onDelivery(more, signed(more));
    assert.equal(graph.sent.length, count);
  } finally {
    await graph.close();
  }
});

test('without a template, a message WhatsApp could not deliver is written in the company\'s record', async () => {
  const fixture = await createCompany('wa-undelivered');
  const graph = await fakeGraph();
  try {
    const itemId = await approval(fixture, 2);
    const channel = whatsapp(graph.url);
    await dispatch(fixture.companyId, channel, { now: new Date(Date.now() + 86_400_000) });
    const report = failed('wamid.out-0', 131047);
    await channel.onDelivery(report, signed(report));
    await channel.settled();
    assert.equal(graph.sent.length, 1, 'nothing else to send it as');
    const events = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'owner.notification_failed'"));
    assert.equal(events.rows[0]?.payload.inboxItemId, itemId);
    assert.match(String(events.rows[0]?.payload.reason), /PALUGADA_WHATSAPP_TEMPLATE/);
  } finally {
    await graph.close();
  }
});

test('the owner chooses whom to talk to with /ceo, and a card the chat may apply is applied with its button', async () => {
  const graph = await fakeGraph();
  try {
    const moves: Array<string | null> = [];
    const applied: string[] = [];
    const conversation = {
      hears: false, speaks: false,
      partners: async () => [{ companyId: null, name: 'PALUGADA' }, { companyId: '0e6a9b8c-1d2e-4f3a-8b4c-5d6e7f8a9b0c', name: 'Sari, CEO of Kopi Nusantara' }],
      current: async () => null,
      moveTo: async (companyId: string | null) => { moves.push(companyId); },
      talk: async () => ({ answer: 'Raise it?', cards: [{ id: '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d', summary: 'Raise the ad budget to Rp 2.000.000', here: true }] }),
      hear: async () => '', speak: async () => { throw new Error('no voice'); },
      apply: async (cardId: string) => { applied.push(cardId); return { outcome: 'applied' as const, summary: 'Raise the ad budget to Rp 2.000.000' }; },
    } as unknown as ChatConversation;
    const channel = whatsapp(graph.url);

    const ceo = delivery({ id: 'wamid.in-9', type: 'text', text: { body: '/ceo' } });
    await channel.onDelivery(ceo, signed(ceo), { conversation });
    await channel.settled();
    const choices = graph.sent.at(-1)!.body as { interactive: { type: string; action: { sections: Array<{ rows: Array<{ id: string; title: string }> }> } } };
    assert.equal(choices.interactive.type, 'list');
    const rows = choices.interactive.action.sections[0]!.rows;
    assert.deepEqual(rows.map((row) => row.id), ['talk:palugada', 'talk:0e6a9b8c-1d2e-4f3a-8b4c-5d6e7f8a9b0c']);
    assert.ok(rows.every((row) => row.title.length <= 24));

    const pick = delivery({ id: 'wamid.in-10', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: rows[1]!.id, title: rows[1]!.title } } });
    await channel.onDelivery(pick, signed(pick), { conversation });
    await channel.settled();
    assert.deepEqual(moves, ['0e6a9b8c-1d2e-4f3a-8b4c-5d6e7f8a9b0c']);
    assert.match(String((graph.sent.at(-1)!.body.text as { body: string }).body), /Now talking to Sari, CEO of Kopi Nusantara/);

    const words = delivery({ id: 'wamid.in-11', type: 'text', text: { body: 'Should we spend more on ads?' } });
    await channel.onDelivery(words, signed(words), { conversation });
    await channel.settled();
    const offer = graph.sent.at(-1)!.body as { interactive: { action: { buttons: Array<{ reply: { id: string; title: string } }> } } };
    assert.equal(offer.interactive.action.buttons[0]!.reply.id, 'card:1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d');

    const apply = delivery(press(offer.interactive.action.buttons[0]!.reply.id, 'Apply 1', 'wamid.in-12'));
    await channel.onDelivery(apply, signed(apply), { conversation });
    await channel.settled();
    assert.deepEqual(applied, ['1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d']);
    assert.match(String((graph.sent.at(-1)!.body.text as { body: string }).body), /Done: Raise the ad budget/);
  } finally {
    await graph.close();
  }
});

test('the webhook route answers Meta\'s check with the challenge, refuses an unsigned delivery, and decides a signed press', async () => {
  const fixture = await createCompany('wa-route');
  const graph = await fakeGraph();
  const { OwnerApi } = await import('../../src/owner/api.ts');
  const { OwnerMfa } = await import('../../src/owner/mfa.ts');
  const { InMemorySecretManager } = await import('../../src/secrets/manager.ts');
  const api = new OwnerApi({ mfa: new OwnerMfa({ secrets: new InMemorySecretManager() }), whatsapp: whatsapp(graph.url) });
  const { url } = await api.listen();
  try {
    const check = await fetch(`${url}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-0123456789&hub.challenge=4242`);
    assert.equal(check.status, 200);
    assert.equal(await check.text(), '4242', 'the challenge alone, as Meta reads it');
    assert.equal((await fetch(`${url}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=4242`)).status, 401);

    const itemId = await approval(fixture, 2);
    const raw = delivery(press(encodeAction({ itemId, decision: 'deny' }), 'Deny', 'wamid.in-13'));
    const post = (signature?: string) => fetch(`${url}/api/channels/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
      body: raw,
    });
    assert.equal((await post()).status, 401);
    assert.equal((await post(signed(raw, 'not-the-secret'))).status, 401);
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'nothing decided');
    const pressed = await post(signed(raw));
    assert.equal(pressed.status, 200);
    assert.deepEqual(await pressed.json(), { ok: true, results: [{ id: 'wamid.in-13', handled: true }] });
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await api.close();
    await graph.close();
  }
});

test('a deployment names what WhatsApp still needs, and makes the channel once it has it all', async () => {
  const { channelsFrom } = await import('../../src/main.ts');
  const half = await channelsFrom({ PALUGADA_WHATSAPP_PHONE_ID: '1111', PALUGADA_WHATSAPP_TOKEN: 'wa-token-0123456789abcdef' });
  assert.equal(half.channels.length, 0);
  assert.match(half.notes.join('\n'), /no WhatsApp channel: set PALUGADA_WHATSAPP_APP_SECRET, PALUGADA_WHATSAPP_VERIFY_TOKEN, PALUGADA_WHATSAPP_OWNER/);

  const whole = await channelsFrom({
    PALUGADA_WHATSAPP_PHONE_ID: '1111', PALUGADA_WHATSAPP_TOKEN: 'wa-token-0123456789abcdef',
    PALUGADA_WHATSAPP_APP_SECRET: APP_SECRET, PALUGADA_WHATSAPP_VERIFY_TOKEN: 'verify-token-0123456789',
    PALUGADA_WHATSAPP_OWNER: '+62 812-3456-7890', PALUGADA_WHATSAPP_TEMPLATE: 'palugada_notice:id',
  });
  assert.deepEqual(whole.channels.map((channel) => channel.name), ['chat:whatsapp']);
  assert.ok(whole.channels[0] instanceof WhatsAppChannel);
});
