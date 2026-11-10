/**
 * A customer's photo, voice note or document on Telegram or WhatsApp is kept
 * where a mailed one is (P1.4 part 6).
 *
 * The mailboxes kept what customers attached from 2.16x on, and the two chat
 * channels did not: a photo of a receipt on WhatsApp reached the run as
 * "[sent a photo, which cannot be read here]". Now each file is fetched with
 * the channel's own credential once its message is claimed, kept through the
 * same path, with the same limits, and the run is told where it is. What the
 * transport says about a file decides nothing it does not have to: a file
 * Telegram says is too big is not fetched at all, and a download address Meta
 * gives that is not Meta's is never handed the token.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { chatCapabilities } from '../../src/capabilities/chat.ts';
import type { SecretManager } from '../../src/secrets/manager.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
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

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffd9', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The chat capabilities in the catalogue, which a channel grants the role that answers it. */
async function catalogued(secrets: SecretManager): Promise<void> {
  const registry = new CapabilityRegistry();
  for (const capability of chatCapabilities({ secrets })) registry.register(capability);
  await registry.sync();
}

interface FileRow { kind: string; path: string | null; bytes: number; note: string | null; why: string | null }
const filesOf = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{ external_id: string; files: FileRow[] }>(
  "SELECT external_id, files FROM chat_messages WHERE direction = 'in' ORDER BY created_at")).then((result) => result.rows);
const briefs = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<{ input: { conversation?: string; message?: string } }>(
  'SELECT input FROM tasks ORDER BY created_at')).then((result) => result.rows.map((row) => JSON.stringify(row.input)));

/* ------------------------------------------------------------- Telegram --- */

const BOT = '7012345678:AAcustomerBotTokenOfTokoKopiSenja';

/** A Bot API that knows one bot, hands over the files it holds, and remembers what was asked. */
async function botApi(held: Record<string, Buffer>) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const downloads: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url ?? '');
      if (file) {
        downloads.push(file[2]!);
        const bytes = file[1] === BOT ? held[file[2]!.replace(/^documents\//, '')] : undefined;
        if (!bytes) { res.statusCode = 404; res.end('not found'); return; }
        res.end(bytes);
        return;
      }
      const [, bot, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '') ?? [];
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      res.setHeader('content-type', 'application/json');
      if (bot !== BOT) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        return;
      }
      calls.push({ method: method!, body });
      const result = method === 'getMe'
        ? { id: 7012345678, is_bot: true, first_name: 'Toko Kopi Senja', username: 'tokosenja_bot' }
        : method === 'getFile'
          ? { file_id: body.file_id, file_unique_id: `u-${String(body.file_id)}`, file_path: `documents/${String(body.file_id)}` }
          : true;
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  return { url: await listening(server), calls, downloads };
}

const SARI = { id: 4242, first_name: 'Sari', last_name: 'Kusuma', username: 'sari_k', is_bot: false };
let update = 900;
function telegramMessage(fields: Record<string, unknown>) {
  update += 1;
  return {
    update_id: update,
    message: { message_id: update - 800, date: 1_760_000_000, chat: { id: SARI.id, type: 'private', first_name: 'Sari' }, from: SARI, ...fields },
  };
}

test('a customer\'s photo and document on Telegram are kept where a mailed one is, and the run is told where', async () => {
  const fixture = await createCompany('chat-media-telegram');
  const root = await mkdtemp(join(tmpdir(), 'palugada-chat-media-'));
  const telegram = await botApi({ large: JPEG, order: PDF });
  const api = await consoleWithSettings({ files: { root }, baseEnv: { PALUGADA_TELEGRAM_API: telegram.url, PALUGADA_APP_URL_PUBLIC: 'https://palugada.example' } });
  try {
    await catalogued(api.secrets);
    const owner = await api.signIn();
    const made = await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels`, owner, {
      kind: 'telegram', token: BOT, roleId: fixture.roleId, goalId: fixture.goalId,
      instruction: 'Jawab pelanggan Toko Kopi Senja.', proof: { totp: api.code() },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const set = telegram.calls.filter((call) => call.method === 'setWebhook').at(-1)!;
    const [, publicId] = /chat-hooks\/([0-9a-f]{32})$/.exec(String(set.body.url))!;
    const deliver = async (body: unknown) => {
      const response = await fetch(`${api.url}/api/chat-hooks/${publicId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': String(set.body.secret_token) },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: response.status, body: await response.json() as any };
    };

    // A photo comes in several sizes: the largest is the one kept.
    const photo = await deliver(telegramMessage({
      caption: 'Ini struk kemarin',
      photo: [{ file_id: 'small', file_unique_id: 'us', file_size: 90, width: 90, height: 90 }, { file_id: 'large', file_unique_id: 'ul', file_size: JPEG.length, width: 1280, height: 960 }],
    }));
    assert.equal(photo.status, 200, JSON.stringify(photo.body));
    assert.equal(photo.body.outcome, 'started');
    assert.deepEqual(telegram.calls.filter((call) => call.method === 'getFile').map((call) => call.body.file_id), ['large']);

    // A document, with the name the customer gave it -- which is theirs, so data.
    await deliver(telegramMessage({ document: { file_id: 'order', file_unique_id: 'uo', file_name: 'pesanan.pdf', mime_type: 'application/pdf', file_size: PDF.length } }));
    // One Telegram says is too big is not fetched at all; one whose download fails is said so.
    await deliver(telegramMessage({ document: { file_id: 'huge', file_unique_id: 'uh', file_name: 'video.mp4', mime_type: 'video/mp4', file_size: 11 * 1024 * 1024 } }));
    await deliver(telegramMessage({ voice: { file_id: 'gone', file_unique_id: 'ug', mime_type: 'audio/ogg', file_size: 2_000, duration: 3 } }));
    assert.deepEqual(telegram.calls.filter((call) => call.method === 'getFile').map((call) => call.body.file_id), ['large', 'order', 'gone']);

    const rows = await filesOf(fixture);
    assert.equal(rows.length, 4);
    const [first, second, third, fourth] = rows.map((row) => row.files[0]!);
    assert.match(first!.path ?? '', /^received\/telegram\//);
    assert.deepEqual(await readFile(join(root, fixture.companyId, first!.path!)), JPEG, 'the largest size, whole');
    assert.match(second!.path ?? '', /^received\/telegram\/.*\.pdf$/);
    assert.deepEqual(await readFile(join(root, fixture.companyId, second!.path!)), PDF);
    assert.deepEqual([third!.path, third!.why], [null, 'too_big']);
    assert.match(third!.note ?? '', /over 10 MB/);
    assert.deepEqual([fourth!.path, fourth!.why], [null, 'failed']);
    assert.match(fourth!.note ?? '', /could not be fetched/);

    // The run is told where each one is, and why the others are not there.
    const said = (await briefs(fixture)).join('\n');
    assert.match(said, /kept as received\/telegram\//);
    assert.doesNotMatch(said, /which cannot be read here/);
    // And the token never reached what was kept or said.
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(BOT.split(':')[1]!));
  } finally {
    await api.close();
  }
});

/* ------------------------------------------------------------- WhatsApp --- */

const TOKEN = 'EAAGcustomerChannelSystemUserTokenForTokoKopiSenja';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const NUMBER_ID = '106540352242922';

/** The Graph API for one number, which also hands over the media it holds, and a stranger's server beside it. */
async function graphApi(held: Record<string, { bytes: Buffer; mime: string }>) {
  const asked: Array<{ path: string; authorization: string | undefined }> = [];
  const stranger: Array<string | undefined> = [];
  const elsewhere = createServer((req, res) => { stranger.push(req.headers.authorization); res.end('stolen'); });
  const other = await listening(elsewhere);
  let base = '';
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      asked.push({ path, authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }));
        return;
      }
      if (path === `/${NUMBER_ID}`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ display_phone_number: '+62 812-3456-7890', verified_name: 'Toko Kopi Senja', id: NUMBER_ID }));
        return;
      }
      const download = /^\/download\/(\w+)$/.exec(path);
      if (download && held[download[1]!]) { res.end(held[download[1]!]!.bytes); return; }
      const media = /^\/(\w+)$/.exec(path);
      if (media) {
        res.setHeader('content-type', 'application/json');
        // A media id Meta was asked about, and where to fetch it: on Meta's
        // own host, but for "LURE", somewhere that is not Meta's.
        const url = media[1] === 'LURE' ? `${other}/media` : `${base}/download/${media[1]}`;
        const one = held[media[1]!];
        res.end(JSON.stringify({ messaging_product: 'whatsapp', url, mime_type: one?.mime ?? 'application/pdf', file_size: one?.bytes.length ?? 10, id: media[1] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  base = await listening(server);
  return { url: base, asked, stranger };
}

function whatsappDelivery(messages: Array<Record<string, unknown>>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102290129340398',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '6281234567890', phone_number_id: NUMBER_ID },
          contacts: [{ profile: { name: 'Sari Kusuma' }, wa_id: '6285700001111' }],
          messages: messages.map((message) => ({ from: '6285700001111', timestamp: '1760000000', ...message })),
        },
      }],
    }],
  };
}

test('a customer\'s photo and document on WhatsApp are kept, and the token goes to Meta and nowhere else', async () => {
  const fixture = await createCompany('chat-media-whatsapp');
  const root = await mkdtemp(join(tmpdir(), 'palugada-chat-media-'));
  const graph = await graphApi({ PHOTO1: { bytes: JPEG, mime: 'image/jpeg' }, DOC1: { bytes: PDF, mime: 'application/pdf' } });
  const api = await consoleWithSettings({ files: { root }, baseEnv: { PALUGADA_WHATSAPP_API: graph.url, PALUGADA_APP_URL_PUBLIC: 'https://palugada.example' } });
  try {
    await catalogued(api.secrets);
    const owner = await api.signIn();
    const made = await api.call('POST', `/api/companies/${fixture.companyId}/chat-channels`, owner, {
      kind: 'whatsapp', phoneNumberId: NUMBER_ID, token: TOKEN, appSecret: APP_SECRET, roleId: fixture.roleId, goalId: fixture.goalId,
      instruction: 'Jawab pelanggan Toko Kopi Senja di WhatsApp.', proof: { totp: api.code() },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const [, publicId] = /\/api\/chat-hooks\/([0-9a-f]{32})$/.exec(String(made.body.callbackUrl)) ?? [];
    assert.ok(publicId, String(made.body.callbackUrl));
    const post = async (body: unknown) => {
      const raw = JSON.stringify(body);
      const response = await fetch(`${api.url}/api/chat-hooks/${publicId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` },
        body: raw,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: response.status, body: await response.json() as any };
    };

    const sent = await post(whatsappDelivery([
      { id: 'wamid.photo', type: 'image', image: { id: 'PHOTO1', mime_type: 'image/jpeg', sha256: 'x', caption: 'Struk kemarin' } },
      { id: 'wamid.doc', type: 'document', document: { id: 'DOC1', mime_type: 'application/pdf', sha256: 'y', filename: 'pesanan.pdf' } },
      { id: 'wamid.lure', type: 'document', document: { id: 'LURE', mime_type: 'application/pdf', sha256: 'z', filename: 'invoice.pdf' } },
    ]));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const rows = await filesOf(fixture);
    const byId = Object.fromEntries(rows.map((row) => [row.external_id, row.files[0]!]));
    assert.match(byId['wamid.photo']!.path ?? '', /^received\/whatsapp\//);
    assert.deepEqual(await readFile(join(root, fixture.companyId, byId['wamid.photo']!.path!)), JPEG);
    assert.match(byId['wamid.doc']!.path ?? '', /^received\/whatsapp\/.*\.pdf$/);
    assert.deepEqual([byId['wamid.lure']!.path, byId['wamid.lure']!.why], [null, 'failed']);
    assert.match(byId['wamid.lure']!.note ?? '', /not Meta's/);
    // The token went with every request to the Graph API, and never to the stranger.
    assert.ok(graph.asked.every((one) => one.authorization === `Bearer ${TOKEN}`));
    assert.deepEqual(graph.stranger, [], 'the address that is not Meta\'s was never asked');
    assert.match((await briefs(fixture)).join('\n'), /kept as received\/whatsapp\//);
  } finally {
    await api.close();
  }
});
