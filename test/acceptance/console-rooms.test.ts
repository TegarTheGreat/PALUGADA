/**
 * The rooms in the console, drawn in a real browser (F19.1, F19.5 to F19.8,
 * F19.10, F19.16, F19.21; STATUS 2.207).
 *
 * The rooms' server is held by its own tests (STATUS 2.206); these hold what
 * only a browser shows: that a room fills the screen and sits above a phone's
 * keyboard, that Enter sends what a person meant to send and nothing else,
 * that a mention offers people and never an agent, that a person is never
 * drawn as the owner, that a press makes work and the message shows it move,
 * that the badge is the server's and comes back after a reload, and that a
 * notice's link lands in the thread it names. Each skips without Chromium.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { syncRoomCards } from '../../src/workspace/cards.ts';
import { chromium, openPage, type Page } from '../helpers/browser.ts';
import { companyRoomOf, ok, personIn, said, seated, type Console } from '../helpers/rooms.ts';

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

/** A company called Toko Kopi Senja, read in English, and the console that serves it. */
async function started(): Promise<{ fixture: Fixture; api: Console; owner: string }> {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('rooms-console');
  await withControlPlane(async (tx) => {
    await tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]);
    await tx.query("UPDATE roles SET display_name = 'Sari' WHERE id = $1", [fixture.roleId]);
    await tx.query("UPDATE platform_control SET console_language = 'en', tour_finished_at = now()");
  });
  const api = await consoleWithSettings({ staticRoot: BUILT });
  return { fixture, api, owner: await api.signIn() };
}

/** A browser at this size; one that cannot be driven closes the console with it. */
async function drawn(api: Console, size: { width: number; height: number }): Promise<Page> {
  return openPage(browser as string, size).catch(async (error: unknown) => {
    await api.close();
    throw error;
  });
}

/** The owner signs in, from wherever `at` points. */
async function ownerSignsIn(page: Page, api: Console, at = ''): Promise<void> {
  await page.goto(`${api.url}/${at}`);
  await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
  await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
  await page.type(api.code());
  await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console');
}

/** An authenticator app's codes: a step later each time, inside the window the server takes. */
function app(secret: string) {
  let step = 0;
  return () => {
    const now = stepFor(new Date());
    step = Math.max(step + 1, now - 1);
    return totpCode(decodeBase32(secret), Math.min(step, now + 1));
  };
}

/** A member of staff the owner seats, who joins choosing a handle, as the join page would send it. */
async function joined(api: Console, owner: string, fixture: Fixture, name: string, kind: string, handle: string) {
  const made = ok(await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } }), 'seating');
  const opened = ok(await api.call('POST', '/api/auth/join', '', { code: made.invite }), 'opening the invite');
  const code = app(String(opened.secret));
  const done = ok(await api.call('POST', '/api/auth/join/confirm', '', { code: made.invite, offer: opened.offer, totp: code(), handle }), 'joining');
  return { id: String(made.seatId), principal: `seat:${made.seatId}`, token: String(done.token), code, handle, name };
}

/** A member of staff signs in with their handle and code. */
async function staffSignsIn(page: Page, api: Console, handle: string, code: () => string): Promise<void> {
  await page.goto(api.url);
  await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
  await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === "I'm a member of staff").click()`);
  await page.waitFor(`document.querySelector('input[name="handle"]')`, 'the handle field');
  await page.evaluate(`document.querySelector('input[name="handle"]').focus()`);
  await page.type(handle);
  await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
  await page.type(code());
  await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console, as staff');
}

/** A box's place on the screen. */
const BOX = `(selector) => { const box = document.querySelector(selector)?.getBoundingClientRect();
  return box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height } : null; }`;
type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number } | null;
const box = (page: Page, selector: string) => page.evaluate<Box>(`(${BOX})(${JSON.stringify(selector)})`);

/** The row of the message that says `text`. */
const ROW = (text: string) => `[...document.querySelectorAll('[data-message]')].find((row) => row.innerText.includes(${JSON.stringify(text)}))`;

/** The messages of a room, as the owner's API answers them. */
async function messagesOf(api: Console, token: string, companyId: string, roomId: string): Promise<Array<{ id: string; body: string | null; kind: string; mentions: Array<{ principal: string }> }>> {
  return ok(await personIn(api, token, companyId).page(roomId)).messages;
}

test('the rail, timeline and composer fill the screen on a desktop', { skip }, async () => {
  const { fixture, api } = await started();
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms`);
    await page.waitFor(`document.querySelector('[data-pane="rail"]') && document.querySelector('[role="log"]') && document.querySelector('[data-composer]')`,
      'the rail, a room and its composer');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rail = await box(page, '[data-pane="rail"]');
    const room = await box(page, '[data-pane="room"]');
    const log = await box(page, '[role="log"]');
    const composer = await box(page, '[data-composer]');
    const { height, width, scrolls } = await page.evaluate<{ height: number; width: number; scrolls: number }>(
      '({ height: window.innerHeight, width: window.innerWidth, scrolls: document.documentElement.scrollHeight })');
    assert.ok(rail && room && log && composer, 'every pane is drawn');
    assert.ok(scrolls <= height + 1, `the page scrolls (${scrolls} px for ${height}): the room is not held to the screen`);
    assert.ok(rail.top <= 1 && rail.bottom >= height - 1, `the rail runs from ${rail.top} to ${rail.bottom}, not the screen's height`);
    assert.ok(room.right >= width - 1 && room.left >= rail.right - 1, 'the room fills the rest of the width, beside the rail');
    assert.ok(composer.bottom <= height && composer.bottom >= height - 48, `the composer ends at ${composer.bottom}, not at the foot of ${height}`);
    assert.ok(log.height >= height / 2, `the timeline is ${log.height} px high`);
  } finally {
    await page.close();
    await api.close();
  }
});

test('on a phone a room opens full screen above the keyboard, without the tab bar', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  const page = await drawn(api, PHONE);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms`);
    // The Rooms tab shows the rail, the whole screen of it, with the tabs below.
    await page.waitFor(`document.querySelector('[data-room="${roomId}"]')`, 'the rail');
    const tab = await page.evaluate<string>(`document.querySelector('.bottom-tab[data-active]')?.innerText.trim() ?? ''`);
    assert.equal(tab, 'Rooms', 'the Rooms tab is the one shown');
    await page.evaluate(`document.querySelector('[data-room="${roomId}"]').click()`);
    await page.waitFor(`document.querySelector('[data-composer]') && document.querySelector('[data-immersive]')`, 'the room, full screen');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const chrome = await page.evaluate<{ header: number; footer: number }>(`({
      header: document.querySelector('.mantine-AppShell-header')?.getBoundingClientRect().height ?? 0,
      footer: document.querySelector('.mantine-AppShell-footer')?.getBoundingClientRect().height ?? 0,
    })`);
    assert.deepEqual(chrome, { header: 0, footer: 0 }, 'the shell\'s header or tab bar is still drawn over an open room');
    const room = await box(page, '[data-pane="room"]');
    assert.ok(room && room.top <= 1 && room.bottom >= PHONE.height - 1, `the room runs from ${room?.top} to ${room?.bottom}`);
    const composer = await box(page, '[data-composer]');
    assert.ok(composer && composer.bottom >= PHONE.height - 48, `the composer ends at ${composer?.bottom}, not at the foot`);

    // A keyboard of 300 pixels: the visible viewport shrinks, and the composer rises above it.
    await page.evaluate(`(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => ${PHONE.height - 300} });
      window.visualViewport.dispatchEvent(new Event('resize'));
    })()`);
    await page.waitFor(`document.querySelector('[data-composer]').getBoundingClientRect().bottom <= ${PHONE.height - 300 + 1}`, 'the composer above the keyboard');
    const scrolls = await page.evaluate<number>('document.documentElement.scrollWidth');
    assert.ok(scrolls <= PHONE.width + 1, 'the room scrolls sideways');

    // Back: the rail again, and the tabs with it.
    await page.evaluate(`document.querySelector('[data-back]').click()`);
    await page.waitFor(`!document.querySelector('[data-immersive]') && document.querySelector('.mantine-AppShell-footer')`, 'the rail and its tabs');
  } finally {
    await page.close();
    await api.close();
  }
});

/** A finger held on the row of the message that says `text`, for `ms`, then lifted. */
const HOLD = (text: string, ms: number) => `(async () => {
  const row = ${ROW(text)};
  const box = row.getBoundingClientRect();
  const touch = (type) => {
    const point = new Touch({ identifier: 1, target: row, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    row.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [point], changedTouches: [point] }));
  };
  touch('touchstart');
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  touch('touchend');
})()`;

test('on a phone a long press opens what may be done with a message, and only what the reader may do', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const rina = await seated(fixture, 'Rina', 'member', { handle: 'rina' });
  await said(personIn(api, rina.token, fixture.companyId), roomId, 'Kasir kedua sudah datang.');
  await said(me, roomId, 'Tolong cek kas pagi ini.');
  const page = await drawn(api, PHONE);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`${ROW('Tolong cek kas pagi ini.')} && ${ROW('Kasir kedua sudah datang.')}`, 'both messages');
    // On a phone a message has one button beside it, for what the long press also opens: a row of them would crowd a
    // narrow line, and none would leave a screen reader, or a window with no touch, no way in.
    const buttons = await page.evaluate<string[]>(`[...${ROW('Tolong cek kas pagi ini.')}.querySelectorAll('.message-actions button')]
      .filter((one) => one.getBoundingClientRect().width > 0).map((one) => one.getAttribute('aria-label'))`);
    assert.deepEqual(buttons, ['More actions'], 'a message on a phone has its buttons beside it');

    // A tap is not a press: nothing opens.
    await page.evaluate(HOLD('Tolong cek kas pagi ini.', 80));
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('.mantine-Drawer-content [data-action]').length`), 0, 'a tap opened the actions');

    const sheet = () => page.evaluate<string[]>(`[...document.querySelectorAll('.mantine-Drawer-content [data-action]')].map((one) => one.getAttribute('data-action'))`);
    await page.evaluate(HOLD('Tolong cek kas pagi ini.', 700));
    await page.waitFor(`document.querySelectorAll('.mantine-Drawer-content [data-action]').length > 0`, 'the sheet of the owner\'s own message');
    const mine = await sheet();
    // The sheet is as tall as what it offers, and leaves the message it acts on in sight above it.
    const drawer = await box(page, '.mantine-Drawer-content');
    assert.ok(drawer && drawer.top >= PHONE.height / 4, `the sheet starts ${drawer?.top} px from the top of a ${PHONE.height} px screen`);
    for (const action of ['reply', 'copy', 'edit', 'pin', 'work', 'issue', 'delete']) {
      assert.ok(mine.includes(action), `the owner's own message offers no ${action}: ${mine.join(', ')}`);
    }
    await page.press('Escape');
    await page.waitFor(`document.querySelectorAll('.mantine-Drawer-content [data-action]').length === 0`, 'the sheet closed');

    // A seat's words: the owner may reply, give them as work, pin or remove them, but neither edit them nor
    // file them as the owner's own issue.
    await page.evaluate(HOLD('Kasir kedua sudah datang.', 700));
    await page.waitFor(`document.querySelectorAll('.mantine-Drawer-content [data-action]').length > 0`, 'the sheet of a seat\'s message');
    const hers = await sheet();
    assert.ok(hers.includes('reply') && hers.includes('work') && hers.includes('delete'), `a seat's message offers ${hers.join(', ')}`);
    assert.ok(!hers.includes('edit') && !hers.includes('issue'), `a seat's message offers the owner ${hers.join(', ')}`);

    // Reply in thread, pressed from the sheet: the thread, as a sheet over the room.
    await page.evaluate(`document.querySelector('.mantine-Drawer-content [data-action="reply"]').click()`);
    await page.waitFor(`(() => { const box = document.querySelector('[data-pane="thread"]')?.getBoundingClientRect();
      return box && box.left <= 1 && box.width >= ${PHONE.width - 1}; })()`, 'the thread over the room');
  } finally {
    await page.close();
    await api.close();
  }
});

test('Enter sends and Shift+Enter breaks the line on a desktop; Enter never sends while composing', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('first line');
    await page.press('Enter', { shift: true });
    await page.type('second');
    // An input method still composing a word: its Enter chooses the word, and sends nothing.
    await page.evaluate(`document.querySelector('[data-composer]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual((await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text'), [], 'something was sent before Enter');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-composer]').value`), 'first line\nsecond');

    await page.press('Enter');
    await page.waitFor(`document.querySelector('[data-composer]').value === ''`, 'the composer emptied');
    await page.waitFor(`${ROW('second')}`, 'the message in the room');
    const sent = (await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text');
    assert.deepEqual(sent.map((one) => one.body), ['first line\nsecond'], 'Enter sends exactly what was typed, once');
  } finally {
    await page.close();
    await api.close();
  }
});

test('typing @ offers people, never roles', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const rina = await joined(api, owner, fixture, 'Rina', 'member', 'rina');
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('@');
    await page.waitFor(`document.querySelectorAll('[data-mention]').length >= 2`, 'the people offered');
    const offered = await page.evaluate<Array<{ principal: string; text: string }>>(
      `[...document.querySelectorAll('[data-mention]')].map((one) => ({ principal: one.getAttribute('data-mention'), text: one.innerText }))`);
    assert.deepEqual(offered.map((one) => one.principal).sort(), ['owner', rina.principal].sort(), 'only the company\'s people are offered');
    const words = offered.map((one) => one.text).join(' | ');
    assert.match(words, /Owner/);
    assert.match(words, /Rina/);
    assert.match(words, /@rina/, 'a person is offered with their handle beside their name');
    assert.doesNotMatch(words, /Sari|worker|CEO/, 'a role is offered as someone to mention');
    const hint = await page.evaluate<string>(`document.querySelector('[data-mention-hint]')?.innerText ?? ''`);
    assert.match(hint, /To ask an agent, use Ask the team\./);
    // A screen reader is told that a list opened, and which person the arrows are on: the composer is the list's combobox.
    const TOLD = `(() => {
      const box = document.querySelector('[data-composer]');
      const list = document.getElementById(box.getAttribute('aria-controls') || '-');
      const option = document.getElementById(box.getAttribute('aria-activedescendant') || '-');
      return { role: box.getAttribute('role'), expanded: box.getAttribute('aria-expanded'), list: list?.getAttribute('role') ?? null,
               option: option?.getAttribute('role') ?? null, selected: option?.getAttribute('aria-selected') ?? null, id: option?.id ?? null };
    })()`;
    const first = await page.evaluate<Record<string, string | null>>(TOLD);
    assert.deepEqual({ ...first, id: null }, { role: 'combobox', expanded: 'true', list: 'listbox', option: 'option', selected: 'true', id: null },
      'the list of people is not told to a screen reader');
    await page.press('ArrowDown');
    const next = await page.evaluate<Record<string, string | null>>(TOLD);
    assert.notEqual(next.id, first.id, 'the arrow moved, and the screen reader was not told where to');
    assert.equal(next.selected, 'true');

    // Typing narrows by the handle and by each word of the name; Enter chooses.
    await page.type('ri');
    await page.waitFor(`document.querySelectorAll('[data-mention]').length === 1 && document.querySelector('[data-mention]').getAttribute('data-mention') === ${JSON.stringify(rina.principal)}`, 'Rina alone');
    await page.press('Enter');
    await page.waitFor(`document.querySelector('[data-composer]').value === '@rina '`, 'the handle written in');
    assert.equal(await page.evaluate<string | null>(`document.querySelector('[data-composer]').getAttribute('aria-expanded')`), 'false',
      'the list is closed, and a screen reader is told so');
    await page.type('cek stok ya');
    await page.press('Enter');
    await page.waitFor(`${ROW('cek stok ya')}`, 'the message in the room');
    const [sent] = (await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text');
    assert.deepEqual(sent?.mentions.map((one) => one.principal), [rina.principal], 'the person chosen is the one mentioned');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a thread opens beside the room on a desktop and over it on a phone', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const rootId = await said(me, roomId, 'Siapa yang buka toko besok?');
  await said(me, roomId, { body: 'Saya, jam tujuh.', threadOf: rootId });
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-replies="${rootId}"]')`, 'the thread\'s summary under its message');
    await page.evaluate(`document.querySelector('[data-replies="${rootId}"]').click()`);
    await page.waitFor(`document.querySelector('[data-pane="thread"]')?.innerText.includes('Saya, jam tujuh.')`, 'the thread');
    const hash = await page.evaluate<string>('location.hash');
    assert.equal(hash, `#/c/${fixture.companyId}/rooms?item=${roomId}~${rootId}`, 'the thread is in the address');
    const room = await box(page, '[data-pane="room"]');
    const thread = await box(page, '[data-pane="thread"]');
    assert.ok(room && thread, 'both are drawn');
    assert.ok(thread.left >= room.right - 1, 'the thread sits beside the room');
    assert.ok(room.width >= 300 && thread.width >= 360 && thread.width <= 420, `the room is ${room.width} px and the thread ${thread.width} px`);

    await page.viewport(PHONE);
    await page.waitFor(`(() => { const box = document.querySelector('[data-pane="thread"]')?.getBoundingClientRect();
      return box && box.left <= 1 && box.width >= ${PHONE.width - 1}; })()`, 'the thread across the phone');
    const over = await page.evaluate<boolean>(`document.querySelector('[data-pane="thread"]').contains(document.elementFromPoint(${PHONE.width / 2}, ${PHONE.height / 2}))`);
    assert.ok(over, 'the thread is a sheet over the room');
  } finally {
    await page.close();
    await api.close();
  }
});

test('the owner posts, gives work, and sees the work\'s state change on the message', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('Tulis newsletter Oktober');
    await page.press('Enter');
    await page.waitFor(`${ROW('Tulis newsletter Oktober')}?.getAttribute('data-message')?.length === 36`, 'the message, as the server keeps it');
    // Nothing is work until it is pressed (F19.6).
    assert.equal((await withTenant(fixture.companyId, (tx) => tx.query('SELECT 1 FROM tasks'))).rowCount, 0, 'words became work without a press');

    await page.evaluate(`${ROW('Tulis newsletter Oktober')}.querySelector('[data-actions]').click()`);
    await page.waitFor(`document.querySelector('[data-action="work"]')`, 'the message\'s actions');
    await page.evaluate(`document.querySelector('[data-action="work"]').click()`);
    await page.waitFor(`document.querySelector('[data-askwork] textarea')`, 'the drawer that asks the team, with its fields');
    const goal = await page.evaluate<string>(`document.querySelector('[data-askwork] textarea').value`);
    assert.equal(goal, 'Tulis newsletter Oktober', 'what the message said is what is asked');
    const money = await page.evaluate<string>(`document.querySelector('[data-askwork]').innerText`);
    assert.match(money, /Reserves money from Sari's budget before it starts/, 'the drawer says whose money is held');
    await page.evaluate(`document.querySelector('[data-ask]').click()`);
    await page.waitFor(`${ROW('Tulis newsletter Oktober')}?.querySelector('[data-work-state]')`, 'the work under the message');

    const messageId = await page.evaluate<string>(`${ROW('Tulis newsletter Oktober')}.getAttribute('data-message')`);
    const { rows: [task] } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string; created_by: string; status: string }>(
      'SELECT id, created_by, status FROM tasks WHERE idempotency_key = $1', [`room:${messageId}`]));
    assert.ok(task, 'the press made the work, keyed by its message');
    assert.equal(task.created_by, 'owner', 'the owner\'s own words, pressed by the owner, are the owner\'s work');

    await transition(fixture.companyId, task.id, 'running');
    await page.waitFor(`${ROW('Tulis newsletter Oktober')}.querySelector('[data-work-state]').getAttribute('data-work-state') === 'running'`, 'the work running', 20_000);
    await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'Newsletter siap dikirim **Jumat**.' } });
    await page.waitFor(`${ROW('Tulis newsletter Oktober')}.querySelector('[data-work-state]').getAttribute('data-work-state') === 'completed'`, 'the work done', 20_000);
    const result = await page.evaluate<string>(`${ROW('Tulis newsletter Oktober')}.innerText`);
    assert.match(result, /Newsletter siap dikirim Jumat\./, 'what the agent wrote is shown, as text');
    assert.match(result, /written by Sari/, 'and said to be the role\'s');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a staff seat posts, mentions the owner with @owner, and the owner\'s badge counts it', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const rina = await joined(api, owner, fixture, 'Rina', 'member', 'rina');
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  // The console is closed whatever happens, or it keeps the file running after its tests end.
  try {
    const seat = await drawn(api, DESKTOP);
    try {
      // A member of staff lands on the rooms, in the company room.
      await staffSignsIn(seat, api, rina.handle, rina.code);
      await seat.waitFor(`location.hash.startsWith('#/c/${fixture.companyId}/rooms') && document.querySelector('[data-composer]')`, 'the rooms, as Rina');
      await seat.evaluate(`document.querySelector('[data-composer]').focus()`);
      await seat.type('@own');
      await seat.waitFor(`document.querySelector('[data-mention="owner"]')`, 'the owner offered');
      await seat.press('Enter');
      await seat.waitFor(`document.querySelector('[data-composer]').value === '@owner '`, '@owner written in');
      await seat.type('stok kopi tinggal sedikit');
      await seat.press('Enter');
      await seat.waitFor(`${ROW('stok kopi tinggal sedikit')}?.getAttribute('data-message')?.length === 36`, 'the message, as the server keeps it');
    } finally {
      await seat.close();
    }
    const [sent] = (await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text');
    assert.deepEqual(sent?.mentions.map((one) => one.principal), ['owner'], 'the owner is mentioned');

    const page = await drawn(api, DESKTOP);
    try {
      await ownerSignsIn(page, api, `#/c/${fixture.companyId}/overview`);
      await page.waitFor(`document.querySelector('[data-badge="rooms"]')?.innerText.trim() === '1'`, 'the Rooms badge counting the mention');
      const title = await page.evaluate<string>('document.title');
      assert.match(title, /^\(1\) PALUGADA/, 'the tab says it too');
    } finally {
      await page.close();
    }
  } finally {
    await api.close();
  }
});

test('unread badges come from the server and survive a reload', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const rina = await seated(fixture, 'Rina', 'member', { handle: 'rina' });
  const her = personIn(api, rina.token, fixture.companyId);
  const roomId = await companyRoomOf(her);
  const direct = ok(await her.direct(['owner']), 'opening a conversation with the owner').room.id as string;
  await said(her, direct, 'Pak, boleh saya libur Jumat?');
  await said(her, direct, 'Ada acara keluarga.');
  await said(her, roomId, { body: '@owner rapat jam berapa?', mentions: ['owner'] });
  const page = await drawn(api, DESKTOP);
  try {
    for (const time of ['first', 'after a reload']) {
      // A reload signs the owner out, since the session lives in the tab's memory: the badge comes back from the server.
      // The reloaded page is waited for before signing in, or going to the address it is already at cancels the reload.
      if (time !== 'first') {
        await page.evaluate('location.reload()');
        await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in, after the reload');
      }
      await ownerSignsIn(page, api, `#/c/${fixture.companyId}/overview`);
      await page.waitFor(`document.querySelector('[data-badge="rooms"]')?.innerText.trim() === '3'`, `two direct messages and a mention, ${time}`);
    }
    // Read, and the badge follows the server down.
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/rooms?item=${direct}'`);
    await page.waitFor(`${ROW('Ada acara keluarga.')}`, 'the conversation');
    await page.waitFor(`document.querySelector('[data-badge="rooms"]')?.innerText.trim() === '1'`, 'the badge once the conversation is read', 20_000);
    const unread = ok(await api.call('GET', '/api/rooms/unread', owner)).unread.find((one: { companyId: string }) => one.companyId === fixture.companyId);
    assert.deepEqual([unread.direct, unread.mentions], [0, 1], 'the server says what the badge says');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a notification link opens the room and the thread it names', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const rootId = await said(me, roomId, 'Promo Ramadan mulai kapan?');
  await said(me, roomId, { body: 'Minggu depan, Senin.', threadOf: rootId });
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `?company=${fixture.companyId}&room=${roomId}&thread=${rootId}`);
    await page.waitFor(`document.querySelector('[data-pane="thread"]')?.innerText.includes('Minggu depan, Senin.')`, 'the thread the link names');
    assert.equal(await page.evaluate<string>('location.hash'), `#/c/${fixture.companyId}/rooms?item=${roomId}~${rootId}`);
    assert.equal(await page.evaluate<string>('location.search'), '', 'the link\'s query is dropped once read');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a seat\'s message never shows the owner\'s chip, and always shows the seat\'s handle', { skip }, async () => {
  const { fixture, api, owner } = await started();
  // A seat named before names were checked, as "Owner" (F19.21): its words are still a seat's.
  const named = await seated(fixture, 'Owner', 'member', { handle: 'budi' });
  const him = personIn(api, named.token, fixture.companyId);
  const roomId = await companyRoomOf(him);
  await said(him, roomId, 'Saya yang pegang kas hari ini.');
  await said(personIn(api, owner, fixture.companyId), roomId, 'Baik, terima kasih.');
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`${ROW('Baik, terima kasih.')} && ${ROW('Saya yang pegang kas hari ini.')}`, 'both messages');
    const drawnAs = (text: string) => page.evaluate<{ chips: string[]; text: string; picture: string | null }>(`(() => {
      const row = ${ROW(text)};
      return { chips: [...row.querySelectorAll('[data-chip]')].map((one) => one.getAttribute('data-chip')), text: row.innerText,
               picture: row.querySelector('img')?.getAttribute('src') ?? null };
    })()`);
    const seat = await drawnAs('Saya yang pegang kas hari ini.');
    assert.deepEqual(seat.chips, ['staff'], 'a seat\'s message carries the staff chip, and only it');
    assert.match(seat.text, /@budi/, 'the seat\'s handle is beside its name');
    assert.notEqual(seat.picture, '/avatars/owner.webp', 'a seat is never drawn as the owner');
    const mine = await drawnAs('Baik, terima kasih.');
    assert.deepEqual(mine.chips, ['owner']);
    assert.equal(mine.picture, '/avatars/owner.webp');
  } finally {
    await page.close();
    await api.close();
  }
});

test('giving work in a direct room says the words become company work', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const rina = await seated(fixture, 'Rina', 'member', { handle: 'rina' });
  const me = personIn(api, owner, fixture.companyId);
  const direct = ok(await me.direct([rina.principal]), 'opening a conversation with Rina').room.id as string;
  await said(me, direct, 'Tolong siapkan laporan stok minggu ini.');
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${direct}`);
    await page.waitFor(`${ROW('Tolong siapkan laporan stok minggu ini.')}`, 'the conversation');
    const header = await page.evaluate<string>(`document.querySelector('[data-pane="room"]').innerText`);
    assert.match(header, /Direct messages are part of the company's records/, 'the conversation says who can read it');
    await page.evaluate(`${ROW('Tolong siapkan laporan stok minggu ini.')}.querySelector('[data-actions]').click()`);
    await page.waitFor(`document.querySelector('[data-action="work"]')`, 'the message\'s actions');
    await page.evaluate(`document.querySelector('[data-action="work"]').click()`);
    await page.waitFor(`document.querySelector('[data-askwork] textarea')`, 'the drawer that asks the team, with its fields');
    const said_ = await page.evaluate<string>(`document.querySelector('[data-askwork]').innerText`);
    assert.match(said_, /This becomes company work: its words are visible to everyone in Toko Kopi Senja and to its agents\./);
  } finally {
    await page.close();
    await api.close();
  }
});

test('a reply pressed in Activity opens the thread it is in, where it is seen, and the badge falls', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const rina = await seated(fixture, 'Rina', 'member', { handle: 'rina' });
  const her = personIn(api, rina.token, fixture.companyId);
  await companyRoomOf(her);
  // The owner began the thread, and so follows it: Rina's reply is the owner's news, counted on the badge.
  const rootId = await said(me, roomId, 'Siapa yang buka toko besok?');
  const replyId = await said(her, roomId, { body: 'Saya, jam tujuh.', threadOf: rootId });
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=activity`);
    await page.waitFor(`document.querySelector('[data-badge="rooms"]')?.innerText.trim() === '1'`, 'the reply counted on the badge');
    await page.waitFor(`document.querySelector('.activity-row[data-unseen]')`, 'the reply in Activity, not yet seen');
    await page.evaluate(`document.querySelector('.activity-row[data-unseen]').click()`);
    await page.waitFor(`document.querySelector('[data-pane="thread"]')?.innerText.includes('Saya, jam tujuh.')`, 'the thread the reply is in');
    assert.equal(await page.evaluate<string>('location.hash'), `#/c/${fixture.companyId}/rooms?item=${roomId}~${rootId}`);
    await page.waitFor(`!document.querySelector('[data-badge="rooms"]')`, 'the badge gone once the thread is read', 20_000);
    const items = ok(await me.activity()).items as Array<{ messageId?: string; seen?: boolean }>;
    assert.equal(items.find((item) => item.messageId === replyId)?.seen, true, 'the reply is seen');
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/rooms?item=activity'`);
    await page.waitFor(`document.querySelector('.activity-row') && !document.querySelector('.activity-row[data-unseen]')`, 'Activity with nothing unseen');
  } finally {
    await page.close();
    await api.close();
  }
});

/** What is cut short with an ellipsis inside the cards of a pane, by what it says. */
const CLIPPED = (pane: string) => `[...document.querySelectorAll('[data-pane="${pane}"] .mantine-Paper-root *')]
  .filter((one) => getComputedStyle(one).textOverflow === 'ellipsis' && one.scrollWidth > one.clientWidth + 1)
  .map((one) => one.textContent.trim())`;

test('a card says which agent does it, and where it is, uncut beside an open thread and on a phone', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const goal = 'Tulis newsletter Oktober untuk pelanggan';
  const messageId = await said(me, roomId, goal);
  const taskId = String(ok(await me.on(roomId, messageId, 'work', { target: fixture.roleId, goal, goalId: fixture.goalId }), 'giving work').taskId);
  await transition(fixture.companyId, taskId, 'running');
  await inbox.askOwner({ companyId: fixture.companyId, taskId, question: 'Diskon 20% terlalu besar?', options: ['Ya', 'Tidak'] });
  await syncRoomCards(fixture.companyId);
  const page = await drawn(api, DESKTOP);
  try {
    // A desktop's own size, with the console's sidebar, the rail and the thread beside the room: the room is narrow.
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}~${messageId}`);
    await page.waitFor(`document.querySelector('[data-pane="room"] .work-card')
      && document.querySelector('[data-pane="thread"]')?.innerText.includes('Diskon 20% terlalu besar?')`, 'the work under its message, and its question in the thread');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const card = await page.evaluate<string>(`document.querySelector('[data-pane="room"] .work-card').innerText`);
    assert.match(card, /Sari/);
    assert.match(card, /agent/i);
    assert.deepEqual(await page.evaluate<string[]>(CLIPPED('room')), [], 'what a card in the room says is cut short');
    assert.deepEqual(await page.evaluate<string[]>(CLIPPED('thread')), [], 'what a card in the thread says is cut short');

    await page.viewport(PHONE);
    await page.waitFor(`(() => { const box = document.querySelector('[data-pane="thread"]')?.getBoundingClientRect();
      return box && box.left <= 1 && box.width >= ${PHONE.width - 1}; })()`, 'the thread across the phone');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await page.evaluate<string[]>(CLIPPED('thread')), [], 'what a card in the thread says is cut short on a phone');
  } finally {
    await page.close();
    await api.close();
  }
});

test('a viewer\'s /task asks for nothing and sends nothing, and says who may ask', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const vina = await joined(api, owner, fixture, 'Vina', 'viewer', 'vina');
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  const page = await drawn(api, DESKTOP);
  try {
    await staffSignsIn(page, api, vina.handle, vina.code);
    await page.waitFor(`location.hash.startsWith('#/c/${fixture.companyId}/rooms') && document.querySelector('[data-composer]')`, 'the rooms, as Vina');
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('[aria-label="Ask the team"]').length`), 0, 'a viewer is offered Ask the team');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('/task Cek stok susu');
    await page.press('Enter');
    await page.waitFor(`document.body.innerText.includes('Asking the team for work is for members and approvers.')`, 'the reason nothing was asked');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('[data-askwork]').length`), 0, 'the drawer that asks for work opened');
    assert.deepEqual((await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text'), [], 'the command was sent as words');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-composer]').value`), '/task Cek stok susu', 'what was typed is gone');
  } finally {
    await page.close();
    await api.close();
  }
});

test('/task with no words opens Ask the team, which posts what is asked and gives it as work', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const roomId = await companyRoomOf(personIn(api, owner, fixture.companyId));
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the composer');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.type('/tugas');
    await page.press('Enter');
    await page.waitFor(`document.querySelector('[data-askwork] textarea')`, 'the drawer that asks the team, with its fields');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-askwork] textarea').value`), '', 'it starts with nothing asked');
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-composer]').value`), '', 'the command is left in the composer');
    assert.deepEqual((await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text'), [], 'the command was sent');

    await page.evaluate(`document.querySelector('[data-askwork] textarea').focus()`);
    await page.type('Hitung stok susu');
    await page.waitFor(`!document.querySelector('[data-ask]').disabled`, 'Ask, once something is asked');
    await page.evaluate(`document.querySelector('[data-ask]').click()`);
    await page.waitFor(`${ROW('Hitung stok susu')}?.querySelector('[data-work-state]')`, 'the words in the room, with the work under them');
    const sent = (await messagesOf(api, owner, fixture.companyId, roomId)).filter((one) => one.kind === 'text');
    assert.deepEqual(sent.map((one) => one.body), ['Hitung stok susu'], 'what was asked is posted once, as the owner\'s words');
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ created_by: string }>(
      'SELECT created_by FROM tasks WHERE idempotency_key = $1', [`room:${sent[0]!.id}`]));
    assert.deepEqual(rows, [{ created_by: 'owner' }], 'the work is the owner\'s, asked by those words');
  } finally {
    await page.close();
    await api.close();
  }
});

test('in a window too narrow for a message\'s buttons, with no touch, one button opens what may be done with it', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  await said(me, roomId, 'Tolong cek kas pagi ini.');
  // A desktop at 200% zoom: 640 CSS pixels, a mouse and a keyboard, and no finger to hold on a message.
  const page = await drawn(api, { width: 640, height: 800 });
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`${ROW('Tolong cek kas pagi ini.')}`, 'the message');
    const more = await page.evaluate<{ width: number; focusable: boolean } | null>(`(() => {
      const button = ${ROW('Tolong cek kas pagi ini.')}.querySelector('[data-actions]');
      if (!button) return null;
      button.focus();
      return { width: button.getBoundingClientRect().width, focusable: document.activeElement === button };
    })()`);
    assert.ok(more && more.width > 0 && more.focusable, `the message's one button is ${JSON.stringify(more)}`);
    await page.press('Enter');
    await page.waitFor(`[...document.querySelectorAll('[data-action="edit"]')].some((one) => one.getBoundingClientRect().width > 0)`, 'what may be done, from the keyboard');
  } finally {
    await page.close();
    await api.close();
  }
});

test('in a right-to-left console a person\'s words keep their own direction, and a handle reads as it is typed', { skip }, async () => {
  const { fixture, api, owner } = await started();
  await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'ar'"));
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const rina = await seated(fixture, 'Rina', 'member', { handle: 'rina' });
  await said(personIn(api, rina.token, fixture.companyId), roomId, { body: '@owner rapat jam berapa?', mentions: ['owner'] });
  await said(me, roomId, 'مرحبا بالجميع');
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`${ROW('rapat jam berapa?')} && ${ROW('مرحبا بالجميع')}`, 'both messages');
    assert.equal(await page.evaluate<string>('document.documentElement.dir'), 'rtl', 'the console is not drawn right to left');
    const drawnAs = await page.evaluate<{ latin: string; arabic: string; handle: string; bar: string }>(`(() => {
      const latin = ${ROW('rapat jam berapa?')};
      return {
        latin: getComputedStyle(latin.querySelector('.message-body')).direction,
        arabic: getComputedStyle(${ROW('مرحبا بالجميع')}.querySelector('.message-body')).direction,
        handle: getComputedStyle(latin.querySelector('[data-handle]')).direction,
        // The line beside words for the reader is at the start of the line, which in Arabic is the right.
        bar: getComputedStyle(latin).borderRightStyle === 'solid' && getComputedStyle(latin).borderRightColor !== 'rgba(0, 0, 0, 0)' ? 'right' : 'left',
      };
    })()`);
    assert.deepEqual(drawnAs, { latin: 'ltr', arabic: 'rtl', handle: 'ltr', bar: 'right' },
      'words in Latin letters turned round, a handle drawn backwards, or the line that marks words for the reader on the wrong side');
  } finally {
    await page.close();
    await api.close();
  }
});

test('archiving a room is asked about first, since nobody can write in it again', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = String(ok(await me.makeRoom({ name: 'promo', private: false })).room.id);
  const archived = async () => (await withControlPlane((tx) => tx.query<{ archived: boolean }>(
    'SELECT archived_at IS NOT NULL AS archived FROM rooms WHERE id = $1', [roomId]))).rows[0]!.archived;
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[aria-label="About this room"]')`, 'the room');
    await page.evaluate(`document.querySelector('[aria-label="About this room"]').click()`);
    const PRESS = (label: string) => `[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === ${JSON.stringify(label)})`;
    await page.waitFor(PRESS('Archive this room'), 'the room\'s details');
    await page.evaluate(`${PRESS('Archive this room')}.click()`);
    await page.waitFor(`document.querySelector('.mantine-Modal-content')?.innerText.includes('Nobody can write in it again')`, 'the question');
    assert.equal(await archived(), false, 'the room was archived at the first press');
    await page.evaluate(`${PRESS('Keep it')}.click()`);
    await page.waitFor(`!document.querySelector('.mantine-Modal-content')`, 'the question gone');
    assert.equal(await archived(), false, 'the room was archived though the owner kept it');
    await page.evaluate(`${PRESS('Archive this room')}.click()`);
    await page.waitFor(PRESS('Archive it'), 'the question again');
    await page.evaluate(`${PRESS('Archive it')}.click()`);
    await page.waitFor(`document.body.innerText.includes('This room is archived')`, 'the room archived');
    assert.equal(await archived(), true);
  } finally {
    await page.close();
    await api.close();
  }
});

test('leaving a private room is asked about first, since only its people can add you back', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const rina = await joined(api, owner, fixture, 'Rina', 'member', 'rina');
  const me = personIn(api, owner, fixture.companyId);
  const roomId = String(ok(await me.makeRoom({ name: 'rahasia', private: true, members: [rina.principal] })).room.id);
  const inRoom = async () => (await withControlPlane((tx) => tx.query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND principal = $2 AND left_at IS NULL', [roomId, rina.principal]))).rowCount;
  const page = await drawn(api, DESKTOP);
  try {
    await staffSignsIn(page, api, rina.handle, rina.code);
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/rooms?item=${roomId}'`);
    await page.waitFor(`document.querySelector('[aria-label="About this room"]') && document.querySelector('[data-composer]')`, 'the private room');
    await page.evaluate(`document.querySelector('[aria-label="About this room"]').click()`);
    const PRESS = (label: string) => `[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === ${JSON.stringify(label)})`;
    await page.waitFor(PRESS('Leave this room'), 'the room\'s details');
    await page.evaluate(`${PRESS('Leave this room')}.click()`);
    await page.waitFor(`document.querySelector('.mantine-Modal-content')?.innerText.includes('add you again')`, 'the question');
    assert.equal(await inRoom(), 1, 'Rina left at the first press');
    await page.evaluate(`${PRESS('Leave it')}.click()`);
    await page.waitFor(`!location.hash.includes(${JSON.stringify(roomId)})`, 'out of the room');
    assert.equal(await inRoom(), 0);
  } finally {
    await page.close();
    await api.close();
  }
});

test('Alt+↓ goes to the next room from the composer, where the cursor usually is', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const me = personIn(api, owner, fixture.companyId);
  const roomId = await companyRoomOf(me);
  const next = String(ok(await me.makeRoom({ name: 'promo', private: false })).room.id);
  const page = await drawn(api, DESKTOP);
  try {
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms?item=${roomId}`);
    await page.waitFor(`document.querySelector('[data-room="${next}"]') && document.querySelector('[data-composer]')`, 'the rail and the composer');
    // The next room is the one below it in the rail, as the person sees them.
    const below = await page.evaluate<string>(`(() => { const rows = [...document.querySelectorAll('[data-room]')].map((one) => one.getAttribute('data-room'));
      return rows[rows.indexOf(${JSON.stringify(roomId)}) + 1]; })()`);
    assert.ok(below, 'no room is below the company room in the rail');
    await page.evaluate(`document.querySelector('[data-composer]').focus()`);
    await page.press('ArrowDown', { alt: true });
    await page.waitFor(`location.hash.endsWith(${JSON.stringify('item=')} + ${JSON.stringify(below)})`, 'the next room');
  } finally {
    await page.close();
    await api.close();
  }
});
