/**
 * The rooms, live, in a real browser (F19.11; STATUS section 2.210).
 *
 * The room stream's server is held by `room-stream.test.ts`; these hold what
 * only a browser shows: that words written in one console are on another's
 * screen within two seconds, that a browser with three tabs of one company
 * still has connections left for its pages, since each tab holds one stream
 * and not two, that a hidden tab tells its person of a direct message with
 * words it fetched as that person, and that a member of staff's console
 * draws what their new kind may do when the owner changes it. Each skips
 * without Chromium.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { metricsText } from '../../src/reporting/metrics.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
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

/** A company called Toko Kopi Senja, read in English, and the console that serves it. */
async function started(): Promise<{ fixture: Fixture; api: Console; owner: string }> {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('rooms-live');
  await withControlPlane(async (tx) => {
    await tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]);
    await tx.query("UPDATE platform_control SET console_language = 'en', tour_finished_at = now()");
  });
  const api = await consoleWithSettings({ staticRoot: BUILT });
  return { fixture, api, owner: await api.signIn() };
}

/** A browser at a desktop's size; one that cannot be driven closes the console with it. */
async function drawn(api: Console): Promise<Page> {
  return openPage(browser as string, DESKTOP).catch(async (error: unknown) => {
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

/** Whether a message that says `text` is drawn in the room, sent rather than on its way. */
const SHOWN = (text: string) => `[...document.querySelectorAll('[data-message]')].some((row) => !row.hasAttribute('data-pending') && row.innerText.includes(${JSON.stringify(text)}))`;

/** Types `text` into the composer and sends it with Enter. */
async function send(page: Page, text: string): Promise<void> {
  await page.evaluate(`document.querySelector('[data-composer]').focus()`);
  await page.type(text);
  await page.press('Enter');
}

/** A metric of this process, as a scrape reads it; 0 when it has no sample yet. */
async function metric(name: string): Promise<number> {
  const text = await metricsText({ worker: {
    counts: { places: 0, busy: 0, runs: new Map(), stageFailures: new Map(), loopFailures: { tick: 0, place: 0 } }, lastTickAt: null,
  } });
  const line = text.split('\n').find((one) => one.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}

test('a message sent from one console appears in another within two seconds', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const budi = await joined(api, owner, fixture, 'Budi', 'member', 'budi');
  const ownerPage = await drawn(api);
  const budiPage = await openPage(browser as string, DESKTOP).catch(async (error: unknown) => {
    await ownerPage.close();
    await api.close();
    throw error;
  });
  try {
    await ownerSignsIn(ownerPage, api, `#/c/${fixture.companyId}/rooms`);
    await staffSignsIn(budiPage, api, budi.handle, budi.code);
    for (const page of [ownerPage, budiPage]) await page.waitFor(`document.querySelector('[data-composer]')`, 'the company room');

    for (const [from, to, text] of [
      [budiPage, ownerPage, 'Stok biji kopi tinggal dua karung.'],
      [ownerPage, budiPage, 'Pesan lima karung lagi, ya.'],
      [budiPage, ownerPage, 'Siap, saya pesan sekarang.'],
    ] as const) {
      await send(from, text);
      await from.waitFor(SHOWN(text), `"${text}" kept by the server`);
      const kept = Date.now();
      await to.waitFor(SHOWN(text), `"${text}" on the other console`, 2_000);
      assert.ok(Date.now() - kept <= 2_000, `"${text}" took ${Date.now() - kept} ms to arrive`);
    }
  } finally {
    await budiPage.close();
    await ownerPage.close();
    await api.close();
  }
});

test('three tabs on one company each still load pages and send messages', { skip }, async () => {
  const { fixture, api } = await started();
  const first = await drawn(api);
  try {
    const tabs = [first, await first.tab(), await first.tab()];
    // Each tab is its own sign-in: the session lives in a tab's memory, never in the browser's storage.
    for (const tab of tabs) {
      await ownerSignsIn(tab, api, `#/c/${fixture.companyId}/rooms`);
      await tab.waitFor(`document.querySelector('[data-composer]')`, 'the company room');
    }
    // One stream per tab: the rooms and the work on one connection, so three tabs hold three of the browser's six.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await metric('palugada_room_streams'), 3, 'each tab holds the room stream, once');

    for (const [index, tab] of tabs.entries()) {
      await send(tab, `Tab ${index + 1} is here.`);
      await tab.waitFor(SHOWN(`Tab ${index + 1} is here.`), `tab ${index + 1}'s message, sent`, 5_000);
    }
    for (const [index, tab] of tabs.entries()) {
      for (const one of [1, 2, 3]) await tab.waitFor(SHOWN(`Tab ${one} is here.`), `tab ${one}'s message in tab ${index + 1}`, 5_000);
    }
    // Every page still loads beside the streams: the work, the inbox, the rooms again.
    for (const [index, tab] of tabs.entries()) {
      await tab.goto(`${api.url}/#/c/${fixture.companyId}/work`);
      await tab.waitFor(`document.body.innerText.includes('Give work')`, `the work page in tab ${index + 1}`, 10_000);
      await tab.goto(`${api.url}/#/c/${fixture.companyId}/rooms`);
      await tab.waitFor(SHOWN(`Tab ${index + 1} is here.`), `the rooms again in tab ${index + 1}`, 10_000);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await metric('palugada_room_streams'), 3, 'still one stream per tab');
  } finally {
    await first.close();
    await api.close();
  }
});

/** Stands in for the browser's notifications, and notes every request the page makes, before the console loads. */
const RECORDING = `(() => {
  window.__notified = [];
  window.__asked = 0;
  class Recorded {
    static permission = 'default';
    static requestPermission() {
      window.__asked += 1;
      Recorded.permission = 'granted';
      return Promise.resolve('granted');
    }
    constructor(title, options) {
      this.title = title;
      this.options = options ?? {};
      this.onclick = null;
      window.__notified.push(this);
    }
    close() {}
  }
  window.Notification = Recorded;
  window.__fetched = [];
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    window.__fetched.push(typeof input === 'string' ? input : input.url);
    return real(input, init);
  };
})()`;

test('a hidden tab shows a notification for a direct message, with the words fetched as the person', { skip }, async () => {
  const { fixture, api, owner } = await started();
  const budi = await seated(fixture, 'Budi', 'member', { handle: 'budi' });
  const budiIn = personIn(api, budi.token, fixture.companyId);
  await companyRoomOf(budiIn);
  const page = await drawn(api);
  try {
    await page.beforeLoad(RECORDING);
    await ownerSignsIn(page, api, `#/c/${fixture.companyId}/rooms`);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the company room');
    assert.equal(await page.evaluate<number>('window.__asked'), 0, 'the browser was asked before anyone pressed anything');

    // Asked from the profile, on a press, and only then.
    await page.evaluate(`document.querySelector('.rail-foot').click()`);
    await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Allow in this browser')`, 'the way to allow it');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Allow in this browser').click()`);
    await page.waitFor('window.__asked === 1', 'the browser asked');
    await page.press('Escape');

    // While the tab is seen, a message is on the screen: nothing more is shown.
    const direct = String(ok(await budiIn.direct([budi.principal, 'owner']), 'opening a direct room').room.id);
    await said(budiIn, direct, 'Selamat pagi, Bu.');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await page.evaluate<number>('window.__notified.length'), 0, 'a notification while the tab was seen');

    // Hidden: the person is told, in words the console fetched as them.
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await page.evaluate('window.__fetched = []');
    await said(budiIn, direct, 'Bisa cek stok kopi sore ini? Gudang belakang kosong.');
    await page.waitFor('window.__notified.length === 1', 'a notification', 5_000);
    const shown = await page.evaluate<{ title: string; body: string; tag: string }>(
      '({ title: window.__notified[0].title, body: window.__notified[0].options.body, tag: window.__notified[0].options.tag })');
    assert.match(shown.title, /Budi/, 'it says who wrote');
    assert.match(shown.body, /Bisa cek stok kopi sore ini\?/, 'and what they wrote');
    assert.ok(shown.body.length <= 140, 'in at most 140 characters');
    assert.equal(shown.tag, direct, 'one notification per room, the newest replacing the last');
    const fetched = await page.evaluate<string[]>('window.__fetched');
    assert.ok(fetched.some((url) => url.includes(`/api/companies/${fixture.companyId}/rooms/${direct}/messages?around=`)),
      `the words were not fetched as the person: ${JSON.stringify(fetched)}`);

    // A mention in a room is told too; the person's own words are not.
    const company = await companyRoomOf(budiIn);
    await said(budiIn, company, { body: 'Tolong @owner lihat laporan kas.', mentions: ['owner'] });
    await page.waitFor('window.__notified.length === 2', 'a notification for a mention', 5_000);
    await said(personIn(api, owner, fixture.companyId), direct, 'Nanti saya cek.');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await page.evaluate<number>('window.__notified.length'), 2, 'the owner was told of their own words');

    // Pressed, it opens the room it is about.
    await page.evaluate('window.__notified[0].onclick?.()');
    await page.waitFor(`location.hash.includes(${JSON.stringify(direct)})`, 'the direct room, opened');
  } finally {
    await page.close();
    await api.close();
  }
});

test("a member of staff's console draws what their new kind may do when the owner changes it", { skip }, async () => {
  const { fixture, api, owner } = await started();
  const budi = await joined(api, owner, fixture, 'Budi', 'viewer', 'budi');
  const page = await drawn(api);
  try {
    await staffSignsIn(page, api, budi.handle, budi.code);
    await page.waitFor(`document.querySelector('[data-composer]')`, 'the company room');
    const asks = `Boolean(document.querySelector('[aria-label="Ask the team"]'))`;
    assert.equal(await page.evaluate<boolean>(asks), false, 'a viewer is offered no asking');
    ok(await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.id}/change`, owner, { kind: 'member', proof: { totp: api.code() } }),
      'making Budi a member');
    // Drawn again without a reload: the stream the change ended tells the console to read who it is.
    await page.waitFor(asks, 'Ask the team, for a member', 8_000);
  } finally {
    await page.close();
    await api.close();
  }
});
