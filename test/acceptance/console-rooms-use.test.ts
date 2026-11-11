/**
 * The rooms as people use them, in a real browser (F19.1, F19.2, F19.7,
 * F19.10, F19.11, F19.16; STATUS section 2.218).
 *
 * What a team moving from Slack meets in its first hour: a room opens where
 * the person left off and keeps the newest in view while pictures and the
 * composer load, and is read only as far as it was seen; a message found,
 * pinned or named in Activity opens the room around it; a handle typed in
 * full mentions as one picked does, in an edit too; the edit box, the
 * composer and the room keep to the keyboard; a phone keeps room to write;
 * a picture pasted or dropped is attached, and made small enough to be
 * drawn; search narrows to a room and a person; a message's link is copied
 * and everything is marked read at once; and a thread beside a room never
 * crushes it. Each skips without Chromium.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { closePools } from '../../src/db/pool.ts';
import { randomUUID } from 'node:crypto';
import { roomsOnControlPlane, withControlPlane } from '../../src/db/tenant.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage, type Page } from '../helpers/browser.ts';
import { fakeRelay } from '../helpers/fake-relay.ts';
import { pairThrough } from '../helpers/relay.ts';
import { companyRoomOf, ok, personIn, said, type Console, type PersonIn } from '../helpers/rooms.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();
const skip = browser ? false : 'no Chromium to draw the console in';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** Tablets held upright: wider than a phone, so the shell's navigation is drawn beside the rooms. */
const TABLET = { width: 800, height: 1180 };
const IPAD = { width: 834, height: 1194 };

/** Whether the page fits its window across: nothing pushed past the right edge, so nothing scrolls sideways. */
const NO_SIDEWAYS = `document.documentElement.scrollWidth <= window.innerWidth + 1`;

/** A company called Toko Kopi Senja, read in English, and the console that serves it. */
async function started(options: { files?: { root: string } } = {}): Promise<{ fixture: Fixture; api: Console; owner: string }> {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('rooms-use');
  await withControlPlane(async (tx) => {
    await tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]);
    await tx.query("UPDATE platform_control SET console_language = 'en', tour_finished_at = now()");
  });
  const api = await consoleWithSettings({ staticRoot: BUILT, ...options });
  return { fixture, api, owner: await api.signIn() };
}

async function drawn(api: Console, size: { width: number; height: number }): Promise<Page> {
  return openPage(browser as string, size).catch(async (error: unknown) => {
    await api.close();
    throw error;
  });
}

async function ownerSignsIn(page: Page, api: Console, at = ''): Promise<void> {
  await page.goto(`${api.url}/${at}`);
  await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
  await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
  await page.type(api.code());
  await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console');
}

function app(secret: string) {
  let step = 0;
  return () => {
    const now = stepFor(new Date());
    step = Math.max(step + 1, now - 1);
    return totpCode(decodeBase32(secret), Math.min(step, now + 1));
  };
}

/** A member of staff the owner seats, who joins choosing a handle. */
async function joined(api: Console, owner: string, fixture: Fixture, name: string, kind: string, handle: string) {
  const made = ok(await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } }), 'seating');
  const opened = ok(await api.call('POST', '/api/auth/join', '', { code: made.invite }), 'opening the invite');
  const code = app(String(opened.secret));
  const done = ok(await api.call('POST', '/api/auth/join/confirm', '', { code: made.invite, offer: opened.offer, totp: code(), handle }), 'joining');
  const token = String(done.token);
  return { id: String(made.seatId), principal: `seat:${made.seatId}`, token, code, handle, name, in: personIn(api, token, fixture.companyId) };
}

async function staffSignsIn(page: Page, api: Console, handle: string, code: () => string, at = ''): Promise<void> {
  await page.goto(`${api.url}/${at}`);
  await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
  await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === "I'm a member of staff").click()`);
  await page.waitFor(`document.querySelector('input[name="handle"]')`, 'the handle field');
  await page.evaluate(`document.querySelector('input[name="handle"]').focus()`);
  await page.type(handle);
  await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
  await page.type(code());
  await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console, as staff');
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How far the room's log is from its end, in pixels. */
const GAP = `(() => { const log = document.querySelector('[role="log"]'); return log ? Math.round(log.scrollHeight - log.scrollTop - log.clientHeight) : null; })()`;

/** Whether a message's row, found by its words, is wholly inside the room's log as drawn. */
const IN_VIEW = (text: string) => `(() => {
  const log = document.querySelector('[role="log"]')?.getBoundingClientRect();
  const row = [...document.querySelectorAll('[role="log"] [data-message]')].find((one) => one.innerText.includes(${JSON.stringify(text)}));
  if (!log || !row) return false;
  const box = row.getBoundingClientRect();
  return box.top >= log.top - 1 && box.bottom <= log.bottom + 1;
})()`;

/** A person's read mark in a room, as the server holds it. */
async function readPosition(person: PersonIn, roomId: string): Promise<number> {
  return Number(ok(await person.page(roomId, '?limit=1')).readPosition);
}

/** What waits for a person in a room, as the rail counts it. */
async function unreadIn(person: PersonIn, roomId: string): Promise<{ unread: number; mentions: number }> {
  const room = (ok(await person.rooms()).rooms as Array<{ id: string; unread: number; mentions: number }>).find((one) => one.id === roomId)!;
  return { unread: room.unread, mentions: room.mentions };
}

/** Waits until the server says the room is read for the person, or fails saying what it saw. */
async function readWithin(person: PersonIn, roomId: string, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  let seen = await unreadIn(person, roomId);
  while (Date.now() < until && (seen.unread > 0 || seen.mentions > 0)) {
    await pause(200);
    seen = await unreadIn(person, roomId);
  }
  assert.deepEqual(seen, { unread: 0, mentions: 0 }, `${what}: the room is not read`);
}

/** A PNG of this size, one colour, in base64: large to draw and small to send. */
function pngOf(width: number, height: number): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([200, 120, 60], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

async function filesRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'palugada-rooms-use-'));
}

/**
 * A backlog said at once, written on the control plane as an archive's
 * messages are: more than the thirty a minute a person may post, which is
 * what a room a team has used for a while holds.
 */
async function backlog(fixture: Fixture, roomId: string, bodies: string[], author: { principal: string; name: string | null } = { principal: 'owner', name: null }): Promise<void> {
  await withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, fixture.companyId);
    for (const body of bodies) {
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, author_name, body, position, created_at)
         VALUES ($1, $2, $3, 'text', $4, $5, $6, 0, clock_timestamp())`,
        [randomUUID(), fixture.companyId, roomId, author.principal, author.name, body]);
    }
  });
}

/** Numbered lines: `prefix 1.`, `prefix 2.` and so on. */
const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => `${prefix} ${n + 1}.`);

/** Clicks the first element the selector finds, as a person would. */
const click = (page: Page, selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

test('a room whose newest message is a large picture opens on it, and is read within two seconds', { skip }, async () => {
  const { fixture, api, owner } = await started({ files: { root: await filesRoot() } });
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await backlog(fixture, roomId, numbered('Catatan stok gula aren, kopi, susu, nomor', 30));
  ok(await budi.in.read(roomId, { position: Number(ok(await budi.in.page(roomId)).messages.at(-1).position) }));
  ok(await me.say(roomId, { body: 'Foto rak baru.', files: [{ name: 'rak.png', data: pngOf(2000, 1333) }] }), 'posting the picture');
  for (const size of [DESKTOP, PHONE]) {
    if (size === PHONE) {
      ok(await me.say(roomId, { body: 'Foto rak kedua.', files: [{ name: 'rak-2.png', data: pngOf(2000, 1333) }] }));
    }
    const page = await drawn(api, size);
    try {
      await staffSignsIn(page, api, budi.handle, budi.code, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
      await page.waitFor(`document.querySelector('[role="log"] [data-files] img')`, 'the picture, drawn');
      await pause(1_200);
      const gap = await page.evaluate<number>(GAP);
      assert.ok(gap <= 4, `${size.width} px: the log stopped ${gap} px short of its newest message once the picture was drawn`);
      assert.ok(await page.evaluate<boolean>(IN_VIEW(size === PHONE ? 'Foto rak kedua.' : 'Foto rak baru.')), 'the newest message is in view');
      await readWithin(budi.in, roomId, 2_500, `${size.width} px`);
    } finally {
      await page.close();
    }
  }
  await api.close();
});

test('a long room with a few new messages is read once they are seen, though the composer is drawn after them', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await backlog(fixture, roomId, numbered('Pesan teks biasa nomor', 37));
  ok(await budi.in.read(roomId, { position: Number(ok(await budi.in.page(roomId)).messages.at(-1).position) }));
  for (let n = 1; n <= 3; n += 1) await said(me, roomId, `Percobaan ${n}, belum dibaca.`);
  const page = await drawn(api, DESKTOP);
  try {
    await staffSignsIn(page, api, budi.handle, budi.code, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]') && ${IN_VIEW('Percobaan 3, belum dibaca.')}`, 'the newest message, in view under the composer');
    await readWithin(budi.in, roomId, 3_000, 'three new messages');
    assert.ok(await page.evaluate<number>(GAP) <= 4, 'the log is at its end');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a busy room opens where the person left off, says how much is new, and is read only as far as it is seen', { skip }, async () => {
  const { fixture, api, owner } = await started({ files: { root: await filesRoot() } });
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await backlog(fixture, roomId, numbered('Kemarin nomor', 20));
  const mark = Number(ok(await budi.in.page(roomId)).messages.at(-1).position);
  ok(await budi.in.read(roomId, { position: mark }));
  await backlog(fixture, roomId, numbered('Hari ini nomor', 60));
  // The newest two are large pictures, drawn after the newest page is: the way down must still reach the end.
  ok(await me.say(roomId, { body: 'Foto rak lama.', files: [{ name: 'rak-lama.png', data: pngOf(2400, 1600) }] }), 'posting a picture');
  ok(await me.say(roomId, { body: 'Foto rak baru.', files: [{ name: 'rak-baru.png', data: pngOf(1800, 2400) }] }), 'posting another');
  const newest = Number(ok(await budi.in.page(roomId)).messages.at(-1).position);
  const page = await drawn(api, DESKTOP);
  try {
    await staffSignsIn(page, api, budi.handle, budi.code, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-new-line]')`, 'the line where the new messages start');
    assert.match(await page.evaluate<string>(`document.querySelector('[data-new-line]').innerText`), /62 new messages/, 'it says how many are new, more than the page drawn holds');
    await pause(400);
    assert.ok(await page.evaluate<boolean>(IN_VIEW('Hari ini nomor 1.')), 'the first new message is in view');
    assert.ok(await page.evaluate<boolean>(IN_VIEW('Kemarin nomor 20.')), 'with what came just before it');
    assert.equal(await page.evaluate<boolean>(IN_VIEW('Hari ini nomor 60.')), false, 'the newest is not what it opens on');
    await pause(1_500);
    const after = await readPosition(budi.in, roomId);
    assert.ok(after < newest, 'the room is not read past what was shown');
    // The person presses the way to the newest with the mouse, and lands at the end once its pictures are drawn. A
    // slower machine than this one draws React's work after the browser's next frame, so a scroll made before the
    // newest page is drawn is heard first; the page's message port, which React schedules its work through, is held
    // back a little here to make it so every time.
    await page.waitFor(`document.querySelector('[data-jump]')`, 'a way to the newest');
    await page.evaluate(`(() => {
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (...args) { setTimeout(() => post.apply(this, args), 40); };
    })()`);
    await page.click('[data-jump]');
    await page.waitFor(`[...document.querySelectorAll('[role="log"] [data-files] img')].length === 2
      && [...document.querySelectorAll('[role="log"] [data-files] img')].every((one) => one.complete)`, 'the two pictures, drawn');
    await pause(1_200);
    const gap = await page.evaluate<number>(GAP);
    assert.ok(gap <= 4, `the log stopped ${gap} px short of the newest message after "Jump to newest"`);
    assert.ok(await page.evaluate<boolean>(IN_VIEW('Foto rak baru.')), 'the newest message is in view');
    assert.equal(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-jump]'))`), false, 'and the way down to it is gone');
    await readWithin(budi.in, roomId, 3_000, 'after going to the newest');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a room the person has not joined opens at its newest, with no line of new messages, however long it is', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  await companyRoomOf(me);
  await companyRoomOf(budi.in);
  const topic = String(ok(await me.makeRoom({ name: 'gudang', private: false })).room.id);
  await backlog(fixture, topic, numbered('Gudang, catatan nomor', 150));
  const page = await drawn(api, DESKTOP);
  try {
    // Opened as a copied link, a search hit or Activity opens it: Budi is not in the room, so it keeps him no mark.
    await staffSignsIn(page, api, budi.handle, budi.code, `#/c/${fixture.companyId}/rooms?item=${topic}`);
    await page.waitFor(`[...document.querySelectorAll('[role="log"] [data-message]')].length > 0`, 'the room');
    await pause(800);
    assert.ok(await page.evaluate<boolean>(IN_VIEW('Gudang, catatan nomor 150.')), 'the newest message is in view');
    assert.ok(await page.evaluate<number>(GAP) <= 4, 'the log is at its end');
    assert.equal(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-new-line]'))`), false, 'no line says what is new: nothing is, to someone who keeps no mark');
    assert.equal(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-unread-bar]'))`), false, 'nor a bar to mark it read');
    assert.equal(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-jump]'))`), false, 'nor a way down: it is already there');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a message found, pinned or named in Activity opens its room around it, marked', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await backlog(fixture, roomId, numbered('Sebelumnya nomor', 10));
  const wanted = await said(me, roomId, { body: '@budi kopi gayo istimewa datang Senin.', mentions: [budi.principal] });
  ok(await me.on(roomId, wanted, 'pin', { on: true }));
  await backlog(fixture, roomId, numbered('Sesudahnya nomor', 80));
  ok(await budi.in.read(roomId, { position: Number(ok(await budi.in.page(roomId)).messages.at(-1).position) - 1 }));
  const page = await drawn(api, DESKTOP);
  const focused = `document.querySelector('[role="log"] [data-message="${wanted}"][data-focused]')`;
  try {
    await staffSignsIn(page, api, budi.handle, budi.code, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(IN_VIEW('Sesudahnya nomor 80.'), 'the room, at its newest');

    // Found by the rail's search: the room, around the message, not its thread.
    await page.evaluate(`document.querySelector('[data-pane="rail"] input[name="q"]').focus()`);
    await page.type('gayo');
    await page.press('Enter');
    await page.waitFor(`document.querySelector('[data-hit]')`, 'what was found');
    await click(page, '[data-hit]');
    await page.waitFor(`${focused} && ${IN_VIEW('kopi gayo istimewa')}`, 'the message found, marked, in the room');
    assert.equal(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-pane="thread"]'))`), false, 'no thread is opened for it');

    // Pinned, from the room's details.
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/rooms?item=${roomId}'`);
    await page.waitFor(`!${focused} && ${IN_VIEW('Sesudahnya nomor 80.')}`, 'the room again, at its newest');
    await page.evaluate(`document.querySelector('[aria-label="About this room"]').click()`);
    await page.waitFor(`document.querySelector('[data-pinned] .pinned-message')`, 'the pinned message');
    await click(page, '[data-pinned] .pinned-message');
    await page.waitFor(`${focused} && ${IN_VIEW('kopi gayo istimewa')}`, 'the pinned message, marked, in the room');

    // Named in Activity.
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/rooms?item=activity'`);
    await page.waitFor(`document.querySelector('.activity-row')`, 'the mention in Activity');
    await click(page, '.activity-row');
    await page.waitFor(`${focused} && ${IN_VIEW('kopi gayo istimewa')}`, 'the mention, marked, in the room');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a handle typed in full mentions its person as one picked does, and so does one written into an edit', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const sari = await joined(api, owner, fixture, 'Sari Wulandari', 'approver', 'sari');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await companyRoomOf(sari.in);
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('@budi tolong cek foto produk');
    await page.press('Enter');
    await page.waitFor(`[...document.querySelectorAll('[data-message]')].some((row) => row.innerText.includes('tolong cek foto produk') && row.querySelector('.mention-chip'))`,
      'the message, with Budi marked in it');
    const sent = ok(await me.page(roomId)).messages.at(-1);
    assert.deepEqual(sent.mentions.map((one: { principal: string }) => one.principal), [budi.principal], 'a typed handle mentions Budi');
    assert.deepEqual((ok(await budi.in.activity()).items as Array<{ messageId: string }>).map((one) => one.messageId), [sent.id], "Budi's Activity has it");

    // ↑ edits it: Sari is written in, Budi taken out, and Enter saves.
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.press('ArrowUp');
    await page.waitFor(`document.querySelector('[data-edit-box]')`, 'the edit box');
    await page.evaluate(`(() => { const box = document.querySelector('[data-edit-box]'); box.focus(); box.select(); })()`);
    await page.type('@sari tolong cek foto produk');
    await page.press('Enter');
    await page.waitFor(`!document.querySelector('[data-edit-box]')`, 'the edit saved and the box closed');
    const until = Date.now() + 5_000;
    let edited = ok(await me.page(roomId)).messages.at(-1);
    while (Date.now() < until && edited.body !== '@sari tolong cek foto produk') {
      await pause(200);
      edited = ok(await me.page(roomId)).messages.at(-1);
    }
    assert.equal(edited.body, '@sari tolong cek foto produk');
    assert.deepEqual(edited.mentions.map((one: { principal: string }) => one.principal), [sari.principal], 'the edit mentions Sari, and no longer Budi');
    assert.deepEqual((ok(await sari.in.activity()).items as Array<{ messageId: string }>).map((one) => one.messageId), [sent.id], "Sari's Activity has it");
    assert.deepEqual(ok(await budi.in.activity()).items, [], "Budi's has it no more");
  } finally {
    await page.close();
    await api.close();
  }
});

test('a handle with a dot names only its person, not the one whose handle begins it', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const setiawan = await joined(api, owner, fixture, 'Budi Setiawan', 'member', 'budi.setiawan');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await companyRoomOf(setiawan.in);
  const page = await drawn(api, DESKTOP);
  const sentWith = async (words: string) => {
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type(words);
    await page.press('Enter');
    const until = Date.now() + 5_000;
    let last = ok(await me.page(roomId)).messages.at(-1);
    while (Date.now() < until && last?.body !== words) {
      await pause(200);
      last = ok(await me.page(roomId)).messages.at(-1);
    }
    assert.equal(last?.body, words, `"${words}" is sent`);
    return (last.mentions as Array<{ principal: string }>).map((one) => one.principal);
  };
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    assert.deepEqual(await sentWith('@budi.setiawan tolong cek stok gayo'), [setiawan.principal], '@budi.setiawan names Budi Setiawan alone');
    assert.deepEqual(ok(await budi.in.activity()).items, [], 'Budi Santoso is told nothing');
    assert.deepEqual(await sentWith('Sudah dicek oleh @budi.'), [budi.principal], 'a handle that ends a sentence names its person');
    await pause(500);
    assert.equal(await page.evaluate<boolean>(`document.body.innerText.includes('you named was not told') || document.body.innerText.includes('you named were not told')`), false,
      'the console asked only for the people the words name, so nobody is said back as not told');
  } finally {
    await page.close();
    await api.close();
  }
});

test("@ ranks a handle's own letters above a later word of someone's name", { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const sari = await joined(api, owner, fixture, 'Sari Wulandari', 'approver', 'sari');
  const roomId = await companyRoomOf(me);
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('@sa');
    await page.waitFor(`document.querySelectorAll('[data-mention]').length >= 2`, 'both people offered');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-mention]').getAttribute('data-mention')`), sari.principal,
      'Sari, whose handle starts so, comes before Budi Santoso');
  } finally {
    await page.close();
    await api.close();
  }
});

test('on a phone the composer keeps most of the width for words, with every button its person has on the screen beneath them', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  for (const language of ['en', 'ja', 'ru']) {
    await withControlPlane((tx) => tx.query('UPDATE platform_control SET console_language = $1', [language]));
    const page = await drawn(api, PHONE);
    try {
      await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
      await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
      await pause(300);
      const width = await page.evaluate<number>(`document.querySelector('[data-composer]').getBoundingClientRect().width`);
      assert.ok(width >= PHONE.width * 0.6, `${language}: the words have ${width} px of ${PHONE.width}`);
      // The owner's buttons -- attach, the camera, emoji, the meetings, ask the team, send -- each on the screen.
      const buttons = await page.evaluate<Array<{ left: number; right: number }>>(`[...document.querySelectorAll('.composer button')]
        .map((one) => one.getBoundingClientRect()).filter((box) => box.width > 0).map((box) => ({ left: box.left, right: box.right }))`);
      assert.ok(buttons.length >= 6, `${language}: ${buttons.length} buttons are drawn`);
      assert.ok(buttons.every((box) => box.left >= 0 && box.right <= PHONE.width), `${language}: a button is off the screen`);
    } finally {
      await page.close();
    }
  }
  await api.close();
});

test('the edit box saves on Enter and gives up on Esc, and the room keeps to the keyboard from the composer', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  const next = String(ok(await me.makeRoom({ name: 'promo', private: false })).room.id);
  const mine = await said(me, roomId, 'Rapat jam tiga.');
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]') && document.querySelector('[data-message="${mine}"]')`, 'the room');
    // Esc in the edit box gives the edit up, and keeps the words as they were.
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.press('ArrowUp');
    await page.waitFor(`document.activeElement?.matches('[data-edit-box]')`, 'the edit box, with the focus');
    await page.type(' Tidak jadi.');
    await page.press('Escape');
    await page.waitFor(`!document.querySelector('[data-edit-box]')`, 'the edit given up');
    assert.equal(ok(await me.page(roomId)).messages.at(-1).body, 'Rapat jam tiga.');
    // Enter saves; Shift+Enter breaks the line first.
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.press('ArrowUp');
    await page.waitFor(`document.activeElement?.matches('[data-edit-box]')`, 'the edit box again');
    await page.evaluate(`(() => { const box = document.activeElement; box.setSelectionRange(box.value.length, box.value.length); })()`);
    await page.press('Enter', { shift: true });
    await page.type('Ruang dua.');
    await page.press('Enter');
    await page.waitFor(`!document.querySelector('[data-edit-box]')`, 'the edit saved');
    const until = Date.now() + 5_000;
    while (Date.now() < until && ok(await me.page(roomId)).messages.at(-1).body !== 'Rapat jam tiga.\nRuang dua.') await pause(200);
    assert.equal(ok(await me.page(roomId)).messages.at(-1).body, 'Rapat jam tiga.\nRuang dua.');

    // Ctrl+K from the composer opens the search of everything.
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.press('k', { ctrl: true });
    await page.waitFor(`document.querySelector('.mantine-Spotlight-content')`, 'Spotlight, from the composer');
    await page.press('Escape');
    await page.waitFor(`!document.querySelector('.mantine-Spotlight-content')`, 'Spotlight closed');

    // Alt+↓ from the composer: the next room, with its composer holding the focus, so what is typed lands there.
    const below = await page.evaluate<string>(`(() => { const rows = [...document.querySelectorAll('[data-room]')].map((one) => one.getAttribute('data-room'));
      return rows[rows.indexOf(${JSON.stringify(roomId)}) + 1]; })()`);
    assert.equal(below, next);
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.press('ArrowDown', { alt: true });
    await page.waitFor(`location.hash.endsWith('item=${next}') && document.activeElement?.matches('[data-composer]')`, 'the next room, its composer focused');
    await page.type('halo');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-composer]').value`), 'halo', 'what is typed lands in the new room');
    await page.evaluate(`document.querySelector('[data-composer]').value = ''`);

    // Esc in the composer: a thread closes; with none open, the room is read.
    const rootId = await said(personIn(api, budi.token, fixture.companyId), roomId, 'Siapa yang buka toko besok?');
    await said(personIn(api, budi.token, fixture.companyId), roomId, { body: 'Saya bisa.', threadOf: rootId });
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/rooms?item=${roomId}~${rootId}'`);
    await page.waitFor(`document.querySelector('[data-pane="thread"] [data-composer]')`, 'the thread and its composer');
    await page.evaluate(`document.querySelector('[data-pane="thread"] [data-composer]').focus()`);
    await page.press('Escape');
    await page.waitFor(`!document.querySelector('[data-pane="thread"]')`, 'the thread closed by Esc from its composer');
    await backlog(fixture, roomId, numbered('Pesan Budi nomor', 30), { principal: budi.principal, name: budi.name });
    await page.waitFor(`[...document.querySelectorAll('[data-message]')].some((row) => row.innerText.includes('Pesan Budi nomor 30.'))`, 'his messages');
    // Scrolled up, the room is not read by being seen; Esc reads it.
    await page.evaluate(`document.querySelector('[role="log"]').scrollTop = 0`);
    await pause(300);
    await page.evaluate(`document.querySelector('[data-pane="room"] [data-composer]').focus()`);
    await page.press('Escape');
    await readWithin(me, roomId, 3_000, 'Esc in the composer');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a thread beside the room never crushes it: the room keeps room to read, or the thread is drawn alone with a way back', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const rootId = await said(me, roomId, 'Promo Ramadan mulai kapan? Kita perlu menyiapkan banner, menu dan harga baru.');
  await said(me, roomId, { body: 'Minggu depan, Senin.', threadOf: rootId });
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}~${rootId}`);
    for (const size of [{ width: 1440, height: 900 }, DESKTOP, { width: 1100, height: 800 }, { width: 1024, height: 768 }, { width: 992, height: 768 }, TABLET, IPAD]) {
      await page.viewport(size);
      await page.waitFor(`document.querySelector('[data-pane="thread"]')`, `${size.width} px: the thread`);
      await pause(400);
      assert.ok(await page.evaluate<boolean>(NO_SIDEWAYS), `${size.width} px: the page scrolls sideways beside the thread`);
      const room = await page.evaluate<{ width: number } | null>(`(() => { const box = document.querySelector('[data-pane="room"]')?.getBoundingClientRect(); return box ? { width: box.width } : null; })()`);
      if (room) {
        assert.ok(room.width >= 420, `${size.width} px: the room beside the thread is ${room.width} px wide`);
        const composer = await page.evaluate<number>(`document.querySelector('[data-pane="room"] [data-composer]').getBoundingClientRect().width`);
        assert.ok(composer >= 200, `${size.width} px: the room's composer is ${composer} px wide`);
      } else {
        assert.ok(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-pane="thread"] [aria-label="Back to the room"]'))`),
          `${size.width} px: the thread alone has a way back to the room`);
      }
    }
    // A tablet held upright, with no thread open: the room is never pushed past the screen's edge by the rail beside
    // it. Where the two do not fit, the room is drawn alone, with a way back to the rail.
    await page.goto(`${api.url}/#/c/${fixture.companyId}/rooms?item=${roomId}`);
    for (const size of [TABLET, IPAD, { width: 900, height: 1200 }]) {
      await page.viewport(size);
      await page.waitFor(`document.querySelector('[data-pane="room"] [data-composer]')`, `${size.width} px: the room`);
      await pause(400);
      assert.ok(await page.evaluate<boolean>(NO_SIDEWAYS), `${size.width} px: the page scrolls sideways with a room open`);
      const send = await page.evaluate<{ right: number } | null>(`(() => { const box = document.querySelector('[data-pane="room"] [data-send]')?.getBoundingClientRect(); return box ? { right: box.right } : null; })()`);
      assert.ok(send && send.right <= size.width, `${size.width} px: the send button is on the screen (${JSON.stringify(send)})`);
      const rail = await page.evaluate<boolean>(`Boolean(document.querySelector('.rooms-rail'))`);
      if (!rail) {
        assert.ok(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-pane="room"] [data-back]'))`), `${size.width} px: the room alone has a way back to the rail`);
      }
    }
    await page.viewport(TABLET);
    await page.waitFor(`document.querySelector('[data-pane="room"] [data-back]')`, 'the way back to the rail, at 800 px');
    await page.click('[data-pane="room"] [data-back]');
    await page.waitFor(`document.querySelector('.rooms-rail') && !document.querySelector('[data-pane="room"]')`, 'the rail, once back');
    await pause(600);
    assert.equal(await page.evaluate<boolean>(`Boolean(document.querySelector('[data-pane="room"]'))`), false, 'and it stays on the rail rather than opening a room again');
  } finally {
    await page.close();
    await api.close();
  }
});

test('Activity names who wrote and says a few of their words', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const sari = await joined(api, owner, fixture, 'Sari Wulandari', 'approver', 'sari');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(sari.in);
  await said(sari.in, roomId, { body: '@owner kopi jahe sudah siap dicoba, harga Rp28.000?', mentions: ['owner'] });
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=activity`);
    await page.waitFor(`document.querySelector('.activity-row')`, 'Activity');
    const said_ = await page.evaluate<string>(`document.querySelector('.activity-row').innerText`);
    assert.match(said_, /Sari Wulandari mentioned you in Toko Kopi Senja/, 'who, and where');
    assert.match(said_, /kopi jahe sudah siap dicoba, harga Rp28\.000\?/, 'and what they said');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a picture pasted or a file dropped is attached, and a large picture is made small enough to be drawn', { skip }, async () => {
  const { fixture, api, owner } = await started({ files: { root: await filesRoot() } });
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    // A screenshot pasted: a picture far over what a room draws (2,400 by 1,600 of noise, many megabytes as a PNG).
    const pasted = await page.evaluate<number>(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2400; canvas.height = 1600;
      const context = canvas.getContext('2d');
      const image = context.createImageData(2400, 1600);
      for (let at = 0; at < image.data.length; at += 4) {
        image.data[at] = Math.random() * 255; image.data[at + 1] = Math.random() * 255; image.data[at + 2] = Math.random() * 255; image.data[at + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      const box = document.querySelector('[data-composer]');
      box.focus();
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return blob.size;
    })()`);
    assert.ok(pasted > 2 * 1024 * 1024, `the picture pasted is ${pasted} bytes`);
    await page.waitFor(`document.querySelector('[data-attached]')`, 'the pasted picture, attached', 20_000);
    // And a file dropped on the composer.
    await page.evaluate(`(() => {
      const data = new DataTransfer();
      data.items.add(new File(['%PDF-1.4 surat'], 'surat.pdf', { type: 'application/pdf' }));
      const box = document.querySelector('[data-composer]');
      box.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      box.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`document.querySelectorAll('[data-attached] .attached-file').length === 2`, 'the dropped file, attached too');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('Tangkapan layar dan suratnya.');
    await page.press('Enter');
    await page.waitFor(`document.querySelector('[role="log"] [data-files] img')`, 'the picture, drawn in the room', 20_000);
    const message = ok(await me.page(roomId)).messages.at(-1);
    const files = message.files as Array<{ name: string; mime: string; bytes: number; inline: boolean }>;
    assert.equal(files.length, 2);
    const picture = files.find((one) => one.mime.startsWith('image/'))!;
    assert.ok(picture.inline && picture.bytes <= 2 * 1024 * 1024, `the picture is sent at ${picture.bytes} bytes, drawn: ${picture.inline}`);
    assert.ok(files.some((one) => one.name === 'surat.pdf'), 'the dropped file is sent as it was');
  } finally {
    await page.close();
    await api.close();
  }
});

test('search looks in the open room first, and narrows to a person, by the picker or by from: and in: typed', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  const promo = String(ok(await me.makeRoom({ name: 'promo', private: false })).room.id);
  ok(await budi.in.join(promo));
  await said(me, roomId, 'Stok kopi gayo di toko.');
  await said(budi.in, roomId, 'Stok kopi gayo di gudang.');
  await said(me, promo, 'Promo kopi gayo minggu depan.');
  const page = await drawn(api, DESKTOP);
  const hits = `[...document.querySelectorAll('[data-hit]')].map((one) => one.innerText)`;
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${promo}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the promo room');
    await page.evaluate(`document.querySelector('[data-pane="rail"] input[name="q"]').focus()`);
    await page.type('gayo');
    await page.press('Enter');
    await page.waitFor(`${hits}.length === 1`, 'one hit, in the room that was open');
    assert.match((await page.evaluate<string[]>(hits))[0]!, /Promo kopi gayo/);
    // Every room, then only what Budi said.
    await page.evaluate(`document.querySelector('[data-search-room]').click()`);
    await page.waitFor(`[...document.querySelectorAll('[role="option"]')].some((one) => one.innerText.includes('Every room'))`, 'the room choice');
    await page.evaluate(`[...document.querySelectorAll('[role="option"]')].find((one) => one.innerText.includes('Every room')).click()`);
    await page.waitFor(`${hits}.length === 3`, 'three hits in every room');
    await page.evaluate(`document.querySelector('[data-search-from]').click()`);
    await page.waitFor(`[...document.querySelectorAll('[role="option"]')].some((one) => one.innerText.includes('Budi Santoso'))`, 'the people');
    await page.evaluate(`[...document.querySelectorAll('[role="option"]')].find((one) => one.innerText.includes('Budi Santoso')).click()`);
    await page.waitFor(`${hits}.length === 1 && ${hits}[0].includes('gudang')`, 'only what Budi said');
    // Typed: from: and in: in the words, as Slack's are.
    await page.evaluate(`(() => { const box = document.querySelector('.search-panel input[aria-label="Search messages"]'); box.focus(); box.select(); })()`);
    await page.type('gayo from:@owner in:#promo');
    await page.press('Enter');
    await page.waitFor(`${hits}.length === 1 && ${hits}[0].includes('Promo kopi gayo')`, 'what the owner said in promo');
    // A person named alone, with no words, is everything they said, as Slack's from: is.
    await page.evaluate(`(() => { const box = document.querySelector('.search-panel input[aria-label="Search messages"]'); box.focus(); box.select(); })()`);
    await page.type('from:@budi');
    await page.press('Enter');
    await page.waitFor(`${hits}.length === 1 && ${hits}[0].includes('Stok kopi gayo di gudang.')`, 'everything Budi said, with no words typed');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a search begun in a room the person has not joined says that is where it looks', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  await companyRoomOf(me);
  await companyRoomOf(budi.in);
  const gudang = String(ok(await me.makeRoom({ name: 'gudang', private: false })).room.id);
  await said(me, gudang, 'Kunci gudang di laci kasir.');
  const page = await drawn(api, DESKTOP);
  const hits = `[...document.querySelectorAll('[data-hit]')].map((one) => one.innerText)`;
  try {
    await staffSignsIn(page, api, budi.handle, budi.code, `#/c/${fixture.companyId}/rooms?item=${gudang}`);
    await page.waitFor(`[...document.querySelectorAll('[role="log"] [data-message]')].length > 0`, 'the gudang room, not joined');
    await page.evaluate(`document.querySelector('[data-pane="rail"] input[name="q"]').focus()`);
    await page.type('kunci');
    await page.press('Enter');
    await page.waitFor(`${hits}.length === 1`, 'the hit in gudang');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-search-room]').value`), 'gudang', 'the choice of where to look names the room');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a file copied in a file manager is attached when pasted, though its name comes with it; words pasted stay words', { skip }, async () => {
  const { fixture, api, owner } = await started({ files: { root: await filesRoot() } });
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const page = await drawn(api, DESKTOP);
  const pasteOf = (name: string, words: string) => `(() => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-1.4 laporan'], ${JSON.stringify(name)}, { type: 'application/pdf' }));
    data.setData('text/plain', ${JSON.stringify(words)});
    const box = document.querySelector('[data-composer]');
    box.focus();
    return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`;
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    // Finder and Explorer put the file and its name on the clipboard together; Linux's file managers, its path.
    assert.equal(await page.evaluate<boolean>(pasteOf('laporan.pdf', 'laporan.pdf')), true, 'the paste is the file, not its name');
    await page.waitFor(`document.querySelectorAll('[data-attached] .attached-file').length === 1`, 'the file, attached');
    assert.equal(await page.evaluate<boolean>(pasteOf('nota.pdf', '/home/sari/Dokumen/nota.pdf')), true, 'a path is a name too');
    await page.waitFor(`document.querySelectorAll('[data-attached] .attached-file').length === 2`, 'the second file, attached');
    // Words copied with something attached to them are the words the person meant.
    assert.equal(await page.evaluate<boolean>(pasteOf('salinan.pdf', 'Harga naik minggu depan.')), false, 'words pasted are left to be pasted');
    await pause(500);
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('[data-attached] .attached-file').length`), 2, 'and nothing more is attached');
  } finally {
    await page.close();
    await api.close();
  }
});

test("a message's link is copied and opens the room around it, and everything is marked read at once", { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const budi = await joined(api, owner, fixture, 'Budi Santoso', 'member', 'budi');
  const roomId = await companyRoomOf(me);
  await companyRoomOf(budi.in);
  await backlog(fixture, roomId, numbered('Sebelum nomor', 40));
  const wanted = await said(me, roomId, 'Harga baru berlaku mulai Senin.');
  await backlog(fixture, roomId, numbered('Sesudah nomor', 40));
  const direct = String(ok(await me.direct([budi.principal])).room.id);
  await said(me, direct, 'Pak Budi, bisa datang pagi?');
  const page = await drawn(api, DESKTOP);
  try {
    await page.beforeLoad(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copied.push(text); } } });`);
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-message="${wanted}"] [data-actions]')`, 'the message and its actions');
    await page.evaluate(`document.querySelector('[data-message="${wanted}"] [data-actions]').click()`);
    await page.waitFor(`document.querySelector('[data-action="link"]')`, 'Copy link');
    await click(page, '[data-action="link"]');
    await page.waitFor(`window.__copied.length === 1`, 'the link copied');
    const link = await page.evaluate<string>('window.__copied[0]');
    assert.ok(link.startsWith(api.url), `a link to this console: ${link}`);
    await page.close();

    // Budi opens it, and lands on the message.
    const his = await drawn(api, DESKTOP);
    try {
      await staffSignsIn(his, api, budi.handle, budi.code, link.slice(api.url.length + 1));
      await his.waitFor(`document.querySelector('[role="log"] [data-message="${wanted}"][data-focused]') && ${IN_VIEW('Harga baru berlaku mulai Senin.')}`, 'the message linked, marked');
      // Everything read, from the rail.
      await his.waitFor(`document.querySelector('[data-read-all]')`, 'Mark all read');
      await click(his, '[data-read-all]');
      await his.waitFor(`!document.querySelector('[data-badge="rooms"]')`, 'the badge gone', 10_000);
      const unread = ok(await api.call('GET', '/api/rooms/unread', budi.token)).unread[0];
      assert.deepEqual([unread.mentions, unread.direct, unread.rooms], [0, 0, 0]);
    } finally {
      await his.close();
    }
  } finally {
    await api.close();
  }
});

test('a browser that will not show a notification from the page is said to be unable to, and the switch is not offered as working', { skip }, async () => {
  const { fixture, api } = await started();
  const page = await drawn(api, PHONE);
  try {
    // Chrome on Android: Notification exists, says it is granted, and refuses to be made from a page.
    await page.beforeLoad(`(() => {
      function Refused() { throw new TypeError("Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead."); }
      Refused.permission = 'default';
      Refused.requestPermission = async () => { Refused.permission = 'granted'; return 'granted'; };
      window.Notification = Refused;
    })()`);
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms`);
    await page.waitFor(`document.querySelector('.rail-foot')`, 'the rail');
    await click(page, '.rail-foot');
    await page.waitFor(`document.body.innerText.includes('Notify me in this browser')`, 'the profile');
    // Asked from the profile, on a press: the browser has the constructor and refuses a page, which the profile says.
    await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Allow in this browser')`, 'the way to allow it');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Allow in this browser').click()`);
    await page.waitFor(`document.body.innerText.includes('This browser cannot show notifications.')`, 'the profile says this browser cannot show one');
    assert.equal(await page.evaluate<boolean>(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Allow in this browser')`), false,
      'it is not offered as something that would work once allowed');
  } finally {
    await page.close();
    await api.close();
  }
});

test("a phone linked from the profile is said to be linked as soon as the relay's app claims the code", { skip }, async () => {
  const { fixture, api, owner } = await started();
  const relay = await fakeRelay();
  try {
    const relayId = await pairThrough(api, owner, relay, { companies: [fixture.companyId] });
    const sari = await joined(api, owner, fixture, 'Sari Wulandari', 'approver', 'sari');
    const page = await drawn(api, PHONE);
    try {
      await staffSignsIn(page, api, sari.handle, sari.code, `#/c/${fixture.companyId}/rooms`);
      await page.waitFor(`document.querySelector('.rail-foot')`, 'the rail');
      await click(page, '.rail-foot');
      await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Link a phone')`, 'Link a phone');
      await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Link a phone').click()`);
      await page.waitFor(`document.querySelector('[data-link-code]')`, 'the code');
      const code = await page.evaluate<string>(`document.querySelector('[data-link-code]').innerText.trim()`);
      const claimed = await relay.push(api.url, relayId, relay.sign({ v: 1, type: 'link_claim', at: new Date().toISOString(), code, label: 'Pixel 8' }));
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      await page.waitFor(`!document.querySelector('[data-link-code]') && document.body.innerText.includes('Linked: Pixel 8')`, 'the profile says the phone is linked', 10_000);
    } finally {
      await page.close();
    }
  } finally {
    await relay.close();
    await api.close();
  }
});

test('shortening how long messages are kept asks first and says how many go; a number out of range is said, never changed, here and for a meeting', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  await companyRoomOf(me);
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/settings/company`);
    await page.waitFor(`document.querySelector('[data-message-days]')`, 'the message window');
    await page.evaluate(`document.querySelector('[data-message-days]').focus()`);
    await page.type('10');
    await page.evaluate(`document.querySelector('[data-message-days]').blur()`);
    await pause(200);
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-message-days]').value`), '10', 'what was typed is not changed');
    await page.waitFor(`document.body.innerText.includes('From 30 to 3,650 days, or empty to keep them for good.')`, 'the bounds, said');
    assert.equal(await page.evaluate<boolean>(`document.querySelector('[data-save-message-days]').disabled`), true, 'and not saved');
    await page.evaluate(`(() => { const box = document.querySelector('[data-message-days]'); box.focus(); box.select(); })()`);
    await page.type('90');
    await click(page, '[data-save-message-days]');
    await page.waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes('removed for good')`, 'the question first');
    assert.equal(ok(await me.get('/retention')).policy.messageDays, null, 'nothing is set before the owner says so');
    await page.evaluate(`document.querySelector('[data-confirm-message-days]').click()`);
    await page.waitFor(`!document.querySelector('[role="dialog"]')`, 'the question answered');
    const until = Date.now() + 5_000;
    while (Date.now() < until && ok(await me.get('/retention')).policy.messageDays !== 90) await pause(200);
    assert.equal(ok(await me.get('/retention')).policy.messageDays, 90);

    // The minutes a meeting's question waits are bounded where they are typed, in the owner's words, not the API's.
    const minutes = `document.getElementById([...document.querySelectorAll('label')].find((one) => one.innerText.includes('Minutes each question waits for you')).htmlFor)`;
    await page.evaluate(`(() => { const box = ${minutes}; box.focus(); box.select(); })()`);
    await page.type('500');
    await page.waitFor(`document.body.innerText.includes('From 5 to 120.')`, 'the bounds of the minutes, said');
    assert.equal(await page.evaluate<string>(`${minutes}.value`), '500', 'what was typed is not changed');
    assert.equal(await page.evaluate<boolean>(`document.body.innerText.includes('joinMinutes')`), false, "the API's field name never reaches the owner");
  } finally {
    await page.close();
    await api.close();
  }
});

test('small things a team meets on its first day: handles checked as typed, no empty heading, buttons that say whose message, a week that reads one way', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const dewi = await joined(api, owner, fixture, 'Dewi Lestari', 'viewer', 'dewi');
  await companyRoomOf(dewi.in);
  await said(me, roomId, 'Selamat pagi semua.');
  const page = await drawn(api, DESKTOP);
  try {
    await staffSignsIn(page, api, dewi.handle, dewi.code, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-message] [data-actions]')`, 'the room');
    // No conversation yet: the heading has a way to start one under it, never nothing.
    const heading = await page.evaluate<string>(`(() => { const label = [...document.querySelectorAll('.rail-label')].find((one) => one.innerText.trim().toUpperCase() === 'DIRECT MESSAGES');
      return label ? label.nextElementSibling?.innerText ?? '' : 'none'; })()`);
    assert.ok(heading === 'none' || /New message/i.test(heading), `under "Direct messages": ${heading}`);
    // A message's buttons say whose message they act on.
    const labels = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-message] [data-actions]')].map((one) => one.getAttribute('aria-label'))`);
    assert.ok(labels.every((label) => label.includes('Owner')), `the actions' names: ${labels.join(', ')}`);
    // The profile checks a handle's shape in the person's language, and forgets the complaint once it is changed.
    await click(page, '.rail-foot');
    await page.waitFor(`document.querySelector('[role="dialog"] input[name="handle"]')`, 'the handle field');
    await page.evaluate(`(() => { const box = document.querySelector('[role="dialog"] input[name="handle"]'); box.focus(); box.select(); })()`);
    await page.type('Dewi Lestari!');
    await page.waitFor(`document.body.innerText.includes('3 to 32 letters, digits, dots, dashes or underscores, starting with a letter')`, 'the shape, said as it is typed');
    assert.equal(await page.evaluate<boolean>(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Save').disabled`), true, 'Save waits for a handle that can be one');
  } finally {
    await page.close();
    await api.close();
  }
  // The installed app speaks to everyone who installs it, not to the owner alone.
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../../console/public/manifest.webmanifest', import.meta.url)), 'utf8')) as { description: string };
  assert.doesNotMatch(manifest.description, /owner/i);
});
