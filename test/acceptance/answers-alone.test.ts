/**
 * A customer's question answered without the owner, when the answer is the
 * company's own published words (STATUS 2.137; the owner's decision of
 * 3 October: "answers from approved knowledge").
 *
 * Every reply to a customer waited for the owner (2.117): the work began with
 * a stranger's words (F8.9). An owner with a busy shop answers the same
 * question about the price of a coffee forty times a day. Now the owner may
 * let a channel answer on its own -- with their device -- and a reply goes
 * without a card only when every one of these holds:
 *
 *   - it answers the customer who wrote, in the conversation the work began
 *     with, and no one else;
 *   - it names the passages it answers from, of documents the owner marked
 *     as theirs to tell customers -- read again here, from the company's own
 *     records, not taken from the run;
 *   - every figure, address, link and number in it is in those passages or
 *     in what the customer wrote;
 *   - the conversation has not had six such answers in the hour;
 *   - a model shown the customer's words as data, the reply and the passages
 *     finds every statement in the passages and nothing the owner must
 *     decide: a refund, a price or discount of its own, a serious complaint,
 *     the law, someone's personal data, a promise. A model that cannot
 *     answer is a no.
 *
 * Anything else is the owner's card, as before, saying why it was not sent.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { transition } from '../../src/engine/tasks.ts';
import { putPolicy } from '../../src/governance/store.ts';
import { chatCapabilities } from '../../src/capabilities/chat.ts';
import { RecordingLlmClient, type LlmRequest } from '../../src/llm/client.ts';
import type { SecretManager } from '../../src/secrets/manager.ts';
import { createCompany, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  await closePools();
  await closeSetup();
});

const TOKEN = '7012345678:AAcustomerBotTokenOfTokoKopiSenja';
const refused = (code: string) => (error: unknown) => isPalugadaError(error, code as never);

async function botApi() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let sent = 76;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const [, , method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '') ?? [];
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      calls.push({ method: method!, body });
      res.setHeader('content-type', 'application/json');
      const result = method === 'getMe'
        ? { id: 7012345678, is_bot: true, first_name: 'Toko Kopi Senja', username: 'tokosenja_bot' }
        : method === 'sendMessage'
          ? { message_id: (sent += 1), date: 1_760_000_000, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text }
          : true;
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

/** The model that checks an answer: says what each reply is asked about, and answers as told. */
function checker() {
  const asked: LlmRequest[] = [];
  const llm = new RecordingLlmClient((request) => {
    asked.push(request);
    const reply = request.messages[0]!.content;
    if (reply.includes('uang kembali')) return '{"send": false, "category": "refund", "reason": "The reply promises money back."}';
    if (reply.includes('GARBLED')) return 'I think it is fine.';
    return '{"send": true, "category": "supported", "reason": "Every statement is in the passages."}';
  });
  return { llm, asked };
}

async function registryFor(secrets: SecretManager, apiBase: string, llm: RecordingLlmClient | null) {
  const registry = new CapabilityRegistry();
  for (const capability of chatCapabilities({ secrets, telegram: { apiBase }, ...(llm ? { answers: { llm } } : {}) })) registry.register(capability);
  registerPlatformCapabilities(registry);
  await registry.sync();
  return registry;
}

let updates = 2000;
function message(customer: number, text: string) {
  updates += 1;
  return {
    update_id: updates,
    message: {
      message_id: updates - 1000, date: 1_760_000_000,
      chat: { id: customer, type: 'private', first_name: `Pelanggan ${customer}` },
      from: { id: customer, first_name: `Pelanggan ${customer}`, is_bot: false },
      text,
    },
  };
}

async function setting(name: string, options: { model?: boolean } = {}) {
  const fixture = await createCompany(name);
  const telegram = await botApi();
  const api = await consoleWithSettings({ baseEnv: { PALUGADA_TELEGRAM_API: telegram.url, PALUGADA_APP_URL_PUBLIC: 'https://palugada.example/' } });
  const check = checker();
  const registry = await registryFor(api.secrets, telegram.url, options.model === false ? null : check.llm);
  const owner = await api.signIn();
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels`, owner, {
    kind: 'telegram', token: TOKEN, roleId: fixture.roleId, goalId: fixture.goalId,
    instruction: 'Jawab pertanyaan pelanggan tentang menu, harga dan pesanan Toko Kopi Senja.', proof: { totp: api.code() },
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const channelId = String(made.body.channel.id);
  const hook = telegram.calls.filter((call) => call.method === 'setWebhook').at(-1)!;
  const publicId = /chat-hooks\/([0-9a-f]{32})$/.exec(String(hook.body.url))![1]!;
  const secret = String(hook.body.secret_token);

  const document = async (title: string, body: string) => {
    const added = await api.call('POST', `/api/companies/${fixture.companyId}/documents`, owner, { title, text: body });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    return String(added.body.documentId);
  };
  const menu = await document('Menu dan harga', '# Minuman\n\nKopi susu gula aren: Rp 18.000. Es teh manis: Rp 8.000.\n\n# Pengantaran\n\nPengantaran gratis ke Jakarta Pusat, buka setiap hari pukul 08.00 sampai 21.00.');
  const internal = await document('Margin dan pemasok', 'Harga beli biji kopi dari pemasok: Rp 95.000 per kilogram. Margin kopi susu 60 persen.');

  const write = async (customer: number, text: string) => {
    const response = await fetch(`${api.url}/api/chat-hooks/${publicId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify(message(customer, text)),
    });
    const body = await response.json() as { taskId: string };
    await transition(fixture.companyId, body.taskId, 'running');
    await planTask(fixture.companyId, body.taskId, [{ capability: 'chat.send' }]);
    return body.taskId;
  };
  const broker = new CapabilityBroker(registry);
  let key = 0;
  const at = (taskId: string) => ({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId, idempotencyKey: `call-${key += 1}`,
  });
  const reply = (taskId: string, input: Record<string, unknown>) => broker.invoke(at(taskId), 'chat.send', input);
  const cardOf = async (taskId: string) => (await withTenant(fixture.companyId, (tx) => tx.query<{ rationale: string; payload: Record<string, unknown> }>(
    "SELECT rationale, payload FROM inbox_items WHERE task_id = $1 AND kind = 'approval' AND status = 'open'", [taskId]))).rows[0];
  const sends = () => telegram.calls.filter((call) => call.method === 'sendMessage');
  return { fixture, api, owner, channelId, menu, internal, write, broker, at, reply, cardOf, sends, check };
}

test('the owner lets a channel answer on its own, and a reply from a document for customers goes without a card', async () => {
  const { fixture, api, owner, channelId, menu, write, broker, at, reply, cardOf, sends, check } = await setting('answers-alone');
  try {
    // Turning it on loosens a control: the owner's device.
    const path = `/api/companies/${fixture.companyId}/chat-channels/${channelId}/answers-alone`;
    assert.equal((await api.call('POST', path, owner, { on: true })).status, 403);
    assert.equal((await api.call('POST', path, owner, { on: true, proof: { totp: api.code() } })).status, 200);
    // The role that answers can now find what to answer from.
    const { rows: [answering] } = await withTenant(fixture.companyId, (tx) => tx.query<{ tools: string[] }>('SELECT tools FROM roles WHERE id = $1', [fixture.roleId]));
    assert.ok(answering!.tools.includes('memory.search'));
    const marked = await api.call('POST', `/api/companies/${fixture.companyId}/documents/${menu}/for-customers`, owner, { on: true });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    const channels = await api.call('GET', `/api/companies/${fixture.companyId}/chat-channels`, owner);
    assert.equal(channels.body.channels[0].answersAlone, true);
    const documents = await api.call('GET', `/api/companies/${fixture.companyId}/documents`, owner);
    assert.deepEqual(documents.body.documents.map((one: { title: string; forCustomers: boolean }) => [one.title, one.forCustomers]).sort(),
      [['Margin dan pemasok', false], ['Menu dan harga', true]]);

    // The run is told how an answer goes on its own, and finds the passage with what to cite.
    const asked = await write(4242, 'Kak, kopi susu gula aren berapa harganya?');
    const { rows: [task] } = await withTenant(fixture.companyId, (tx) => tx.query<{ input: { reply: string } }>('SELECT input FROM tasks WHERE id = $1', [asked]));
    assert.match(task!.input.reply, /documents marked for customers/);
    const found = (await broker.invoke(at(asked), 'memory.search', { query: 'kopi susu gula aren harga' })).output as {
      documents: Array<{ document: string; place: number; forCustomers: boolean; title: string }>;
    };
    const passage = found.documents.find((one) => one.title === 'Menu dan harga')!;
    assert.deepEqual([passage.document, passage.forCustomers], [menu, true]);

    const answer = { text: 'Kopi susu gula aren Rp 18.000, Kak. Kami buka setiap hari pukul 08.00 sampai 21.00.', sources: [{ document: menu, place: passage.place }, { document: menu, place: 2 }] };
    const sent = await reply(asked, answer);
    assert.equal((sent.output as { sent: boolean }).sent, true);
    assert.deepEqual(sends().map((call) => call.body.text), [answer.text], 'sent without the owner');
    assert.equal(await cardOf(asked), undefined, 'and without a card');

    // The check was shown the passage as the company keeps it, the customer's words as data, and the reply.
    const shown = check.asked.at(-1)!.messages[0]!.content;
    assert.match(shown, /Kopi susu gula aren: Rp 18\.000/);
    assert.match(shown, /UNTRUSTED_CONTENT[\s\S]*berapa harganya/);
    assert.ok(!shown.includes('95.000'), 'nothing of a document the owner keeps to themselves');
    const { rows: recorded } = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM events WHERE task_id = $1 AND type IN ('chat.answer_checked', 'approval.cleared_by_check') ORDER BY occurred_at", [asked]));
    assert.deepEqual(recorded.map((row) => row.type), ['chat.answer_checked', 'approval.cleared_by_check']);

    // The owner sees it went on its own, and from what.
    const chats = await api.call('GET', `/api/companies/${fixture.companyId}/chats`, owner);
    const thread = await api.call('GET', `/api/companies/${fixture.companyId}/chats/${chats.body.chats[0].id}`, owner);
    const out = thread.body.messages.find((one: { direction: string }) => one.direction === 'out');
    assert.deepEqual(out.answeredAlone, { from: ['Menu dan harga'] });

    // Off again with the session alone: a tightening.
    assert.equal((await api.call('POST', path, owner, { on: false })).status, 200);
    const later = await write(4343, 'Es teh manis berapa?');
    await assert.rejects(reply(later, { text: 'Es teh manis Rp 8.000, Kak.', sources: [{ document: menu, place: passage.place }] }), refused('approval.required'));
    assert.doesNotMatch((await cardOf(later))!.rationale, /Not sent on its own/, 'an ordinary card: the channel does not answer alone');
  } finally {
    await api.close();
  }
});

test('anything outside those bounds is the owner\'s card, saying why it was not sent on its own', async () => {
  const { fixture, api, owner, channelId, menu, internal, write, reply, cardOf, sends } = await setting('answers-bounds');
  try {
    await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels/${channelId}/answers-alone`, owner, { on: true, proof: { totp: api.code() } });
    await api.call('POST', `/api/companies/${fixture.companyId}/documents/${menu}/for-customers`, owner, { on: true });
    const from = [{ document: menu, place: 1 }];
    let customer = 5000;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ text: 'Kopi susu gula aren Rp 18.000, Kak.' }, /it named no passage of a document for customers/],
      [{ text: 'Harga beli kami Rp 95.000.', sources: [{ document: internal, place: 1 }] }, /it answers from a document not marked for customers/],
      [{ text: 'Kopi susu gula aren sekarang Rp 15.000, Kak.', sources: from }, /it says a figure the documents and the customer did not: 15\.000/],
      [{ text: 'Kopi susu gula aren Rp 18.000, tanya lagi ke promo@tokosenja.example ya.', sources: from }, /it gives an address or link the documents and the customer did not: promo@tokosenja\.example/],
      [{ text: 'Kopi susu gula aren Rp 18.000, pesan lewat bit.ly/kopisenja ya.', sources: from }, /it gives an address or link the documents and the customer did not: bit\.ly\/kopisenja/],
      [{ text: 'Maaf Kak, uang kembali kami proses besok.', sources: from }, /the check found it is about a refund/],
      [{ text: 'GARBLED Kopi susu gula aren Rp 18.000.', sources: from }, /the check could not judge it/],
    ];
    for (const [answer, said] of cases) {
      const taskId = await write(customer += 1, 'Kopi susu gula aren berapa?');
      await assert.rejects(reply(taskId, answer), refused('approval.required'), String(answer.text));
      assert.match((await cardOf(taskId))!.rationale, said, String(answer.text));
    }

    // Another customer's conversation is never answered on its own.
    const first = await write(customer += 1, 'Halo');
    const second = await write(customer += 1, 'Kopi susu gula aren berapa?');
    const { rows: [otherChat] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
      "SELECT chat_id AS id FROM chat_messages WHERE task_id = $1 AND direction = 'in'", [first]));
    await assert.rejects(reply(second, { text: 'Kopi susu gula aren Rp 18.000.', sources: from, chatId: otherChat!.id }), refused('approval.required'));
    assert.match((await cardOf(second))!.rationale, /it answers a conversation other than the one this work began with/);

    // Six in an hour in one conversation, and the seventh waits.
    let last = '';
    for (let n = 0; n < 7; n += 1) {
      last = await write(9999, `Pertanyaan ${n}: kopi susu gula aren berapa?`);
      if (n < 6) await reply(last, { text: 'Kopi susu gula aren Rp 18.000, Kak.', sources: from });
    }
    await assert.rejects(reply(last, { text: 'Kopi susu gula aren Rp 18.000, Kak.', sources: from }), refused('approval.required'));
    assert.match((await cardOf(last))!.rationale, /six answers on its own in this conversation in the last hour/);

    // A policy asking the owner is still asked, however well grounded.
    await putPolicy({ slug: 'every-reply', effect: 'require_approval', companyId: fixture.companyId, condition: { field: 'tool', op: 'eq', value: 'chat.send' } });
    const policed = await write(customer += 1, 'Kopi susu gula aren berapa?');
    await assert.rejects(reply(policed, { text: 'Kopi susu gula aren Rp 18.000, Kak.', sources: from }), refused('approval.required'));
    assert.match((await cardOf(policed))!.rationale, /policy every-reply requires your approval/);
    assert.equal(sends().length, 6, 'only the six went');
  } finally {
    await api.close();
  }
});

test('with no model to check with, nothing is answered on its own', async () => {
  const { fixture, api, owner, channelId, menu, write, reply, cardOf, sends } = await setting('answers-no-model', { model: false });
  try {
    await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels/${channelId}/answers-alone`, owner, { on: true, proof: { totp: api.code() } });
    await api.call('POST', `/api/companies/${fixture.companyId}/documents/${menu}/for-customers`, owner, { on: true });
    const taskId = await write(7777, 'Kopi susu gula aren berapa?');
    await assert.rejects(reply(taskId, { text: 'Kopi susu gula aren Rp 18.000, Kak.', sources: [{ document: menu, place: 1 }] }), refused('approval.required'));
    assert.match((await cardOf(taskId))!.rationale, /the check could not judge it/);
    assert.equal(sends().length, 0);
  } finally {
    await api.close();
  }
});
