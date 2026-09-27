/**
 * How the owner is reached, set up from the console (F10.5, F10.9).
 *
 * Telegram took a bot token, a chat id and a webhook secret typed into the
 * environment, and the chat id is a number nobody knows by heart. From the
 * console the owner pastes the token @BotFather gave them, presses Start in
 * the bot, and the chat is found; the secret Telegram must send back is made
 * here and the webhook set, and a test message proves the path. Push goes to
 * ntfy in ntfy's own shape, and Slack and Discord are told what the owner may
 * be shown. Every credential is sealed, and none comes back.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { OwnerMfa, TOTP_STEP_SECONDS, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { DeploymentSecretManager, masterKeyFrom, readSettings, type MasterKey } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import { channelsFrom } from '../../src/main.ts';
import { TelegramChannel } from '../../src/owner/telegram.ts';
import { WebhookPush } from '../../src/owner/push.ts';
import { WebhookChatChannel } from '../../src/owner/webhook-chat.ts';
import type { NotifiableItem } from '../../src/owner/notify.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  await closePools();
  await closeSetup();
});

const TOKEN = '123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq';

/** A Bot API that knows one bot, has a webhook left over from before, and one chat that pressed Start. */
async function botApi() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let webhook = true;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const [, bot, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '') ?? [];
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      calls.push({ method: method ?? '', body });
      const reply = (status: number, answer: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      if (bot !== TOKEN) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      switch (method) {
        case 'getMe': return reply(200, { ok: true, result: { id: 1, is_bot: true, first_name: 'Our company', username: 'our_company_bot' } });
        case 'getUpdates':
          if (webhook) return reply(409, { ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' });
          return reply(200, {
            ok: true,
            result: [
              { update_id: 1, message: { chat: { id: -100, type: 'group', title: 'A group' }, text: 'hi' } },
              { update_id: 2, message: { chat: { id: 42, type: 'private', first_name: 'Tegar', last_name: 'Owner', username: 'tegar' }, text: '/start' } },
            ],
          });
        case 'deleteWebhook': webhook = false; return reply(200, { ok: true, result: true });
        case 'setWebhook': webhook = true; return reply(200, { ok: true, result: true });
        case 'sendMessage': return reply(200, { ok: true, result: { message_id: 7 } });
        default: return reply(404, { ok: false, description: 'Not Found' });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

/** An ntfy server: what it was sent, and with which token. */
async function ntfy() {
  const received: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      // ntfy refuses a JSON publish with no topic, as the real one does.
      if (!body.topic) {
        res.writeHead(400).end('{"error":"topic missing"}');
        return;
      }
      received.push({ body, authorization: req.headers.authorization ?? null });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'n1' }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

const incident: NotifiableItem = {
  id: 'i1', companyId: 'c1', kind: 'incident', title: 'The site is down', actionSummary: 'uptime.check failed three times',
  consequenceIfDenied: null, tier: null, url: 'https://palugada.example/?item=i1', delivery: 'link_only', language: 'en',
} as unknown as NotifiableItem;

test('the owner connects Telegram from the console: the bot checked, their chat found, the webhook set, a message sent', async () => {
  const telegram = await botApi();
  const api = await consoleWithSettings({ PALUGADA_TELEGRAM_API: telegram.url, PALUGADA_APP_URL_PUBLIC: 'https://palugada.example' });
  try {
    const token = await api.signIn();
    assert.equal((await api.call('GET', '/api/control/channels', token)).body.telegram.source, null);

    const malformed = await api.call('POST', '/api/control/channels/telegram/bot', token, { token: 'not a token' });
    assert.equal(malformed.status, 400);
    assert.match(String(malformed.body.error), /copy the whole of it from @BotFather/);
    const unknown = await api.call('POST', '/api/control/channels/telegram/bot', token, { token: '999999999:AAzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
    assert.equal(unknown.status, 400, 'Telegram\'s refusal is the owner\'s to read, not an internal error');
    assert.match(String(unknown.body.error), /Telegram does not know that token/);
    const bot = await api.call('POST', '/api/control/channels/telegram/bot', token, { token: TOKEN });
    assert.deepEqual(bot.body.bot, { username: 'our_company_bot', name: 'Our company', link: 'https://t.me/our_company_bot' });

    // A webhook left by an earlier connection is taken off to read the chats;
    // only private chats are offered, since the owner's chat is one.
    const chats = await api.call('POST', '/api/control/channels/telegram/chats', token, { token: TOKEN });
    assert.deepEqual(chats.body.chats, [{ id: '42', name: 'Tegar Owner', username: 'tegar' }]);
    assert.ok(telegram.calls.some((call) => call.method === 'deleteWebhook'));

    assert.equal((await api.call('POST', '/api/control/channels/telegram', token, { token: TOKEN, chatId: '42' })).status, 403);
    const saved = await api.call('POST', '/api/control/channels/telegram', token, { token: TOKEN, chatId: '42', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.webhook, 'set');
    const setWebhook = telegram.calls.find((call) => call.method === 'setWebhook')!;
    assert.equal(setWebhook.body.url, 'https://palugada.example/api/channels/telegram');
    const webhookSecret = await api.secrets.resolve('db://channel-telegram-webhook');
    assert.equal(setWebhook.body.secret_token, webhookSecret, 'Telegram is told the secret it must send back');
    assert.match(webhookSecret, /^[0-9a-f]{48}$/);
    assert.equal(await api.secrets.resolve('db://channel-telegram'), TOKEN);

    // The saved token and chat are used when none is typed.
    const sent = await api.call('POST', '/api/control/channels/telegram/test', token, { text: 'Terhubung.' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(telegram.calls.at(-1), { method: 'sendMessage', body: { chat_id: '42', text: 'Terhubung.' } });

    const listed = (await api.call('GET', '/api/control/channels', token)).body;
    assert.deepEqual(listed.telegram, { source: 'console', chatId: '42', receives: true });
    assert.ok(!JSON.stringify(listed).includes(TOKEN.split(':')[1]!), 'the token never comes back');

    // The next start: a channel that can send and can hear.
    const env = withSettings({ PALUGADA_TELEGRAM_API: telegram.url, PALUGADA_TELEGRAM_TOKEN: '1:an-old-bot-token-from-the-environment' }, await readSettings());
    assert.equal(env.PALUGADA_TELEGRAM_TOKEN, undefined, 'the console\'s bot, not the one the environment named');
    const built = await channelsFrom(env, (reference) => api.secrets.resolve(reference));
    const channel = built.channels.find((one): one is TelegramChannel => one instanceof TelegramChannel);
    assert.ok(channel, built.notes.join('\n'));
    assert.ok(!built.notes.some((note) => /telegram|message channel/.test(note)), built.notes.join('\n'));

    const cleared = await api.call('POST', '/api/control/channels/telegram/clear', token, { proof: { totp: api.code() } });
    assert.equal(cleared.status, 200);
    await assert.rejects(api.secrets.resolve('db://channel-telegram'), /nothing is stored/);
    await assert.rejects(api.secrets.resolve('db://channel-telegram-webhook'), /nothing is stored/);
  } finally {
    await api.close();
  }
});

test('without a public address, Telegram is saved to send and says it cannot hear', async () => {
  const telegram = await botApi();
  const api = await consoleWithSettings({ PALUGADA_TELEGRAM_API: telegram.url });
  try {
    const token = await api.signIn();
    const saved = await api.call('POST', '/api/control/channels/telegram', token, { token: TOKEN, chatId: '42', proof: { totp: api.code() } });
    assert.equal(saved.body.webhook, 'no_public_address');
    assert.ok(!telegram.calls.some((call) => call.method === 'setWebhook'));
  } finally {
    await api.close();
  }
});

test('push goes to ntfy in ntfy\'s own shape: the topic, a priority that wakes for an incident, and a quiet digest', async () => {
  const server = await ntfy();
  const api = await consoleWithSettings({});
  try {
    const token = await api.signIn();
    const noTopic = await api.call('POST', '/api/control/channels/push/test', token, { format: 'ntfy', url: server.url });
    assert.equal(noTopic.status, 400);
    assert.match(String(noTopic.body.error), /the topic your phone subscribes to/);
    const tried = await api.call('POST', '/api/control/channels/push/test', token,
      { format: 'ntfy', url: server.url, topic: 'our-company-alerts', title: 'PALUGADA', text: 'Terhubung.' });
    assert.equal(tried.status, 200, JSON.stringify(tried.body));
    assert.deepEqual(server.received.at(-1)!.body, { topic: 'our-company-alerts', title: 'PALUGADA', message: 'Terhubung.', priority: 4, tags: ['bell'] });

    const saved = await api.call('POST', '/api/control/channels/push', token,
      { format: 'ntfy', url: server.url, topic: 'our-company-alerts', token: 'tk_secretaccesstoken', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const env = withSettings({ PALUGADA_PUSH_URL: 'https://old.example/push', PALUGADA_PUSH_TOKEN: 'the-old-token' }, await readSettings());
    assert.equal(env.PALUGADA_PUSH_URL, server.url, 'the console\'s push in place of the environment\'s');
    // A plain value wins over a reference where both are set, so the
    // environment's old token must go with the rest of its push.
    assert.equal(env.PALUGADA_PUSH_TOKEN, undefined);
    const built = await channelsFrom(env, (reference) => api.secrets.resolve(reference));
    const push = built.channels.find((one): one is WebhookPush => one instanceof WebhookPush)!;
    assert.equal(push.name, 'push:ntfy');
    await push.deliver(incident);
    assert.deepEqual(server.received.at(-1), {
      body: { topic: 'our-company-alerts', title: 'Incident: The site is down', message: 'uptime.check failed three times',
        priority: 5, tags: ['rotating_light'], click: 'https://palugada.example/?item=i1' },
      authorization: 'Bearer tk_secretaccesstoken',
    });
    await push.deliverDigest!({ companyId: 'c1', day: '2026-09-27', text: 'Three tasks done.' });
    assert.equal(server.received.at(-1)!.body.priority, 2, 'a digest is read when the owner chooses, not rung');
    assert.equal(server.received.at(-1)!.body.topic, 'our-company-alerts');
  } finally {
    await api.close();
  }
});

test('Slack and Discord are told what the owner may be shown, with a link to decide it in the console', async () => {
  const api = await consoleWithSettings({});
  try {
    const token = await api.signIn();
    const wrong = await api.call('POST', '/api/control/channels/chat/slack', token,
      { url: 'https://evil.example/collect', proof: { totp: api.code() } });
    assert.equal(wrong.status, 400);
    assert.match(String(wrong.body.error), /hooks\.slack\.com/);
    const saved = await api.call('POST', '/api/control/channels/chat/slack', token,
      { url: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const built = await channelsFrom(withSettings({}, await readSettings()), (reference) => api.secrets.resolve(reference));
    assert.ok(built.channels.some((one) => one.name === 'chat:slack'));
    assert.equal((await api.call('GET', '/api/control/channels', token)).body.slack.source, 'console');
  } finally {
    await api.close();
  }
  const sent: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  await new WebhookChatChannel({ kind: 'slack', url: 'https://hooks.slack.com/services/a', fetch }).deliver(incident);
  assert.deepEqual(sent.at(-1)!.body, {
    text: '*The site is down*\nuptime.check failed three times\n<https://palugada.example/?item=i1|Open in PALUGADA>',
  });
  await new WebhookChatChannel({ kind: 'discord', url: 'https://discord.com/api/webhooks/a', fetch }).deliver(incident);
  assert.deepEqual(sent.at(-1)!.body, {
    content: '**The site is down**\nuptime.check failed three times\nOpen in PALUGADA: https://palugada.example/?item=i1',
  });
});

test('a sealed channel credential that cannot be opened leaves that channel out and says why, and the rest still start', async () => {
  const built = await channelsFrom({
    PALUGADA_TELEGRAM_TOKEN_REF: 'db://channel-telegram', PALUGADA_TELEGRAM_CHAT: '42',
    PALUGADA_SLACK_WEBHOOK: 'https://hooks.slack.com/services/T/B/X',
  }, async () => { throw new Error('nothing is stored under that name'); });
  assert.deepEqual(built.channels.map((one) => one.name), ['chat:slack']);
  assert.ok(built.notes.some((note) => /PALUGADA_TELEGRAM_TOKEN_REF db:\/\/channel-telegram could not be opened: nothing is stored/.test(note)), built.notes.join('\n'));
});

/** The console, with the deployment's settings behind it and a clock the test moves. */
async function consoleWithSettings(baseEnv: NodeJS.ProcessEnv) {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local', now: at });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
  const key = randomBytes(32);
  const master: MasterKey = { id: masterKeyFrom({ PALUGADA_MASTER_KEY: key.toString('hex') })!.id, key, source: 'test' };
  const sealed = new DeploymentSecretManager(secrets, () => master);
  const api = new OwnerApi({
    mfa,
    secrets: sealed,
    deploymentSettings: { baseEnv, env: baseEnv, settings: {}, master: () => master, secrets: sealed, restart: () => undefined },
  });
  const { url } = await api.listen();
  const code = () => {
    steps += 1;
    return totpCode(decodeBase32(secret), stepFor(at()));
  };
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: await response.json() as any };
  };
  return {
    secrets: sealed,
    code,
    call,
    signIn: async () => {
      const response = await fetch(`${url}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totp: code() }),
      });
      return String(((await response.json()) as { token: string }).token);
    },
    close: () => api.close(),
  };
}
