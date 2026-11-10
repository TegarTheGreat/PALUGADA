/**
 * The people the owner seats, and what each of them sets for themselves
 * (F19.2, F19.8, F19.22; STATUS 2.209).
 *
 * The owner seats people a few at a time when a team moves in, as members
 * who ask for work as well as viewers and approvers, and changes what each
 * may do later: a change that lets someone do more takes the owner's code
 * now, one that lets them do less takes effect at once and closes what the
 * person had open, so nothing they held open goes on as what they were; their
 * console draws the new controls when it next loads. A member can hold
 * a role that is a person. And each person chooses their own handle,
 * picture, language and quiet hours; only the owner chooses whether people
 * reach them outside the inbox.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { assistantDispatch, withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { Engine } from '../../src/engine/engine.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { PersonAdapter } from '../../src/runtime/person.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { changeSettings } from '../../src/owner/profile.ts';
import { StaffSeats } from '../../src/owner/staff.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

function app(secret: string) {
  let step = 0;
  return () => {
    // The earliest step the window still takes, a step ahead of the last each time, up to the latest it takes.
    const now = stepFor(new Date());
    step = Math.max(step + 1, now - 1);
    return totpCode(decodeBase32(secret), Math.min(step, now + 1));
  };
}

/** A person joins from an invite, choosing what they chose. */
async function join(api: Console, invite: string, chosen: Record<string, unknown> = {}) {
  const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const code = app(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.body.offer, totp: code(), ...chosen });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const { name, kind } = opened.body.seat as { name: string; kind: string };
  return { token: String(joined.body.token), code, seat: { name, kind } };
}

async function seat(api: Console, owner: string, fixture: Fixture, name: string, kind: string, chosen: Record<string, unknown> = {}) {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return { seatId: String(made.body.seatId), ...await join(api, String(made.body.invite), chosen) };
}

/** A company's live stream, read until it ends. */
function listen(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const done = (async () => {
    for (;;) {
      const { done: finished } = await reader.read().catch(() => ({ done: true }));
      if (finished) return;
    }
  })();
  return { done, stop: () => reader.cancel() };
}

test('the owner seats up to thirty people with one proof, each with their own invite', async () => {
  const fixture = await createCompany('members-batch');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const people = [{ name: 'Rina', kind: 'viewer' }, { name: 'Budi', kind: 'member' }, { name: 'Sari', kind: 'approver' }];
    const unproved = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, { people });
    assert.deepEqual([unproved.status, unproved.body.code], [403, 'approval.channel_forbidden'], 'letting people in takes the owner\'s code, even in a session opened with a device');

    const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, { people, proof: { totp: api.code() } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const seats = made.body.seats as Array<{ seatId: string; name: string; kind: string; invite: string }>;
    assert.deepEqual(seats.map((one) => [one.name, one.kind]), people.map((one) => [one.name, one.kind]));
    assert.equal(new Set(seats.map((one) => one.invite)).size, 3, 'an invite each');
    for (const one of seats) {
      const joined = await join(api, one.invite);
      assert.deepEqual(joined.seat, { name: one.name, kind: one.kind }, `${one.name}'s link is ${one.name}'s seat`);
    }
    const listed = (await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner)).body.seats as Array<{ name: string; kind: string; joined: boolean }>;
    assert.deepEqual(listed.map((one) => [one.name, one.kind, one.joined]), [['Rina', 'viewer', true], ['Budi', 'member', true], ['Sari', 'approver', true]]);

    const thirtyOne = Array.from({ length: 31 }, (_, n) => ({ name: `Orang ${n + 1}`, kind: 'viewer' }));
    const tooMany = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, { people: thirtyOne, proof: { totp: api.code() } });
    assert.deepEqual([tooMany.status, tooMany.body.code], [400, 'contract.violation']);
    const thirty = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, { people: thirtyOne.slice(1), proof: { totp: api.code() } });
    assert.equal(thirty.status, 200, JSON.stringify(thirty.body));
    assert.equal(thirty.body.seats.length, 30);
    const empty = await api.call('POST', `/api/companies/${fixture.companyId}/staff-batch`, owner, { people: [], proof: { totp: api.code() } });
    assert.deepEqual([empty.status, empty.body.code], [400, 'contract.violation']);
  } finally {
    await api.close();
  }
});

test("widening a seat's kind or its daily number takes the owner's fresh code; narrowing does not, and ends its streams", async () => {
  const fixture = await createCompany('members-change');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', 'viewer');
    const change = (body: Record<string, unknown>) => api.call('POST', `/api/companies/${fixture.companyId}/staff/${rina.seatId}/change`, owner, body);
    const kindOf = async () => (await api.call('GET', '/api/me', rina.token)).body.staff.kind as string;

    const unproved = await change({ kind: 'member' });
    assert.deepEqual([unproved.status, unproved.body.code], [403, 'approval.channel_forbidden']);
    assert.equal(await kindOf(), 'viewer');
    const widened = await change({ kind: 'member', proof: { totp: api.code() } });
    assert.equal(widened.status, 200, JSON.stringify(widened.body));
    assert.equal(await kindOf(), 'member', 'her session reads her kind as it now is');
    const answer = `/api/companies/${fixture.companyId}/inbox/00000000-0000-4000-8000-000000000001/answer`;
    assert.notEqual((await api.call('POST', answer, rina.token, { answer: 'ya' })).status, 403, 'a member reaches the answer');

    assert.deepEqual([(await change({ asksPerDay: 50 })).status], [403], 'more asks a day take the code');
    assert.equal((await change({ asksPerDay: 50, proof: { totp: api.code() } })).status, 200);
    assert.equal((await change({ asksPerDay: 10 })).status, 200, 'fewer take the session');
    const out = await change({ asksPerDay: 201 });
    assert.deepEqual([out.status, out.body.code], [400, 'contract.violation']);
    const listed = (await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner)).body.seats as Array<{ asksPerDay: number }>;
    assert.equal(listed[0]!.asksPerDay, 10);

    // Narrowing takes effect now, and what she had open closes, so it goes on as nothing she no longer is.
    const response = await fetch(`${api.url}/api/companies/${fixture.companyId}/live`, { headers: { authorization: `Bearer ${rina.token}` } });
    assert.equal(response.status, 200);
    const stream = listen(response.body!);
    const narrowed = await change({ kind: 'viewer' });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    await Promise.race([stream.done, new Promise((_, reject) => setTimeout(() => reject(new Error('the stream outlived the change')), 3_000))]);
    assert.equal(await kindOf(), 'viewer');
    assert.equal((await api.call('POST', answer, rina.token, { answer: 'ya' })).status, 403, 'and a viewer answers nothing');
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/work`, rina.token)).status, 200, 'though she is still signed in');

    const nobody = await api.call('POST', `/api/companies/${fixture.companyId}/staff/00000000-0000-4000-8000-0000000000ff/change`, owner, { kind: 'viewer' });
    assert.deepEqual([nobody.status, nobody.body.code], [400, 'contract.violation']);
  } finally {
    await api.close();
  }
});

test('a person role can be held by a member', async () => {
  const fixture = await createCompany('members-person-role');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi', 'member');
    const hired = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, owner, {
      divisionId: fixture.divisionId, slug: 'gudang-budi', systemPrompt: 'Menghitung stok di gudang dan melapor.', doneCriteria: ['Jumlah stok dilaporkan'],
      person: 'Budi', proof: { totp: api.code() },
    });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    const roleId = String(hired.body.roleId);

    const adapters = new AdapterRegistry();
    adapters.register(new PersonAdapter());
    const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), adapters, workerId: 'member-worker' });
    const given = (goal: string) => createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
    });
    const task = await given('Hitung stok gula di gudang B');
    assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_approval');
    const [card] = (await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, budi.token)).body.items as Array<{ id: string; question: string | null }>;
    assert.equal(card?.question, 'Hitung stok gula di gudang B', 'the work is put to the member');
    const answered = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${card!.id}/answer`, budi.token, { answer: 'Stok gula 40 karung.' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');

    // Made a viewer, he can no longer do the role's work, and the halt says why.
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.seatId}/change`, owner, { kind: 'viewer' })).status, 200);
    const next = await given('Hitung stok susu');
    assert.equal((await engine.runTask(fixture.companyId, next.id, 'worker')).status, 'halted');
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { detail?: string } }>(
      "SELECT payload FROM events WHERE task_id = $1 AND type = 'task.halted'", [next.id]));
    assert.match(String(rows[0]?.payload.detail), /Budi can only read now/);
  } finally {
    await api.close();
  }
});

test('a person sets their handle, picture, language and quiet hours in Profile', async () => {
  const fixture = await createCompany('members-profile');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', 'viewer', {
      handle: 'rina', picture: 'person-04', language: 'id', quietStart: 22, quietEnd: 6,
    });
    const first = await api.call('GET', '/api/me/profile', rina.token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, {
      principal: `seat:${rina.seatId}`, name: 'Rina', kind: 'viewer', handle: 'rina', picture: 'person-04', language: 'id',
      timezone: null, quietStart: 22, quietEnd: 6, notifyInTab: true, noticesPerDay: 30,
    }, 'what she chose as she joined');

    const changed = await api.call('POST', '/api/me/profile', rina.token, {
      handle: 'rina.w', picture: 'person-11', language: 'ja', timezone: 'Asia/Jakarta', quietStart: 21, quietEnd: 7, notifyInTab: false, noticesPerDay: 12,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body, {
      principal: `seat:${rina.seatId}`, name: 'Rina', kind: 'viewer', handle: 'rina.w', picture: 'person-11', language: 'ja',
      timezone: 'Asia/Jakarta', quietStart: 21, quietEnd: 7, notifyInTab: false, noticesPerDay: 12,
    });
    // Quiet hours off, and back to the deployment's language.
    const cleared = await api.call('POST', '/api/me/profile', rina.token, { quietStart: null, quietEnd: null, language: null, picture: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual([cleared.body.quietStart, cleared.body.quietEnd, cleared.body.language, cleared.body.picture, cleared.body.handle],
      [null, null, null, null, 'rina.w']);

    for (const [body, field] of [
      [{ picture: 'person-13' }, 'picture'], [{ picture: '../owner' }, 'picture'], [{ language: 'xx' }, 'language'],
      [{ timezone: 'Mars/Olympus' }, 'timezone'], [{ quietStart: 22 }, 'quietEnd'], [{ quietStart: 24, quietEnd: 6 }, 'quietStart'],
      [{ noticesPerDay: 201 }, 'noticesPerDay'], [{ notifyInTab: 'yes' }, 'notifyInTab'],
    ] as const) {
      const refused = await api.call('POST', '/api/me/profile', rina.token, body);
      assert.deepEqual([refused.status, refused.body.code, refused.body.details?.field], [400, 'contract.violation', field], JSON.stringify(body));
    }

    // The owner sees each seat's handle and picture; and has neither of their own.
    const listed = (await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner)).body.seats as Array<{ handle: string; picture: string | null }>;
    assert.deepEqual(listed.map((one) => [one.handle, one.picture]), [['rina.w', null]]);
    // A handle is words a person chose, so the owner's assistant, reading the same list, is not shown it.
    const seats = new StaffSeats({ master: () => api.master, secrets: () => api.secrets });
    const theAssistants = await assistantDispatch.run(true, () => seats.list(fixture.companyId));
    assert.deepEqual(theAssistants.map((one) => [one.name, one.handle]), [['Rina', null]]);
    const own = await api.call('GET', '/api/me/profile', owner);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual([own.body.principal, own.body.name, own.body.handle, own.body.picture, own.body.noticesPerDay],
      ['owner', null, null, null, 10]);
    for (const body of [{ handle: 'boss' }, { picture: 'person-01' }, { name: 'Pak Bos' }]) {
      const refused = await api.call('POST', '/api/me/profile', owner, body);
      assert.deepEqual([refused.status, refused.body.code], [400, 'contract.violation'], JSON.stringify(body));
    }
    const owners = await api.call('POST', '/api/me/profile', owner, { quietStart: 23, quietEnd: 7, timezone: 'Asia/Makassar' });
    assert.equal(owners.status, 200, JSON.stringify(owners.body));
    assert.deepEqual([owners.body.quietStart, owners.body.quietEnd, owners.body.timezone, owners.body.noticesPerDay], [23, 7, 'Asia/Makassar', 10]);

    // A seat ended while a change of its settings was on its way keeps none:
    // the change is written only for a seat that is still seated.
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${rina.seatId}/revoke`, owner, {})).status, 200);
    await assert.rejects(changeSettings(`seat:${rina.seatId}`, fixture.companyId, { language: 'id' }),
      (error: { code?: string }) => error.code === 'owner.unauthenticated');
    const kept = await withControlPlane((tx) => tx.query('SELECT principal FROM principal_prefs WHERE principal = $1', [`seat:${rina.seatId}`]));
    assert.equal(kept.rowCount, 0, 'her settings went with her seat, and are not made again');
  } finally {
    await api.close();
  }
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

test('a staff member reads the console in their own language', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('members-language');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 1280, height: 900 }, 'en').catch(async (error: unknown) => {
    await api.close();
    throw error;
  });
  try {
    const owner = await api.signIn();
    assert.equal((await api.call('POST', '/api/control/languages', owner, { console: 'en' })).status, 200, 'the owner reads English');
    const budi = await seat(api, owner, fixture, 'Budi', 'member', { handle: 'budi', language: 'id' });
    assert.equal((await api.call('GET', '/api/me/profile', budi.token)).body.language, 'id');

    // Budi signs in at the door as staff do, with his handle and his code.
    await page.goto(api.url);
    await page.waitFor(`document.body.innerText.includes("I'm a member of staff")`, 'the sign-in page');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === "I'm a member of staff").click()`);
    await page.waitFor(`document.querySelector('input[name="handle"]') !== null`, 'the handle field');
    await page.evaluate(`document.querySelector('input[name="handle"]').focus()`);
    await page.type('budi');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(budi.code());
    await page.waitFor(`document.body.innerText.includes('Toko Kopi Senja') && document.body.innerText.includes('Anggota')`, 'the console, in Indonesian');
    const text = String(await page.evaluate('document.body.innerText'));
    assert.ok(text.includes('Beranda'), 'drawn in his language');
    assert.ok(!text.includes('Sign out'), 'and not in the owner\'s');

    // His choice is his: the deployment's stays the owner's.
    assert.equal((await api.call('GET', '/api/control/languages', owner)).body.console, 'en');

    // In another tab he reads Japanese now. Saving his quiet hours in this
    // one, which still shows Indonesian, sends what he changed and nothing
    // it had read before, so his language is not written back.
    const other = await api.call('POST', '/api/auth/sign-in', '', { handle: 'budi', totp: budi.code() });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal((await api.call('POST', '/api/me/profile', String(other.body.token), { language: 'ja' })).status, 200);
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.includes('Budi') && one.innerText.includes('Anggota')).click()`);
    await page.waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some((one) => one.innerText.trim() === 'Profil Anda')`, 'the menu');
    await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((one) => one.innerText.trim() === 'Profil Anda').click()`);
    // A switch's label holds its description too.
    await page.waitFor(`[...document.querySelectorAll('label')].some((one) => one.innerText.startsWith('Jam tenang'))`, 'the profile');
    await page.evaluate(`[...document.querySelectorAll('label')].find((one) => one.innerText.startsWith('Jam tenang')).click()`);
    await page.waitFor(`[...document.querySelectorAll('label')].some((one) => one.innerText.trim() === 'Mulai')`, 'quiet hours on');
    await page.evaluate(`[...document.querySelectorAll('.mantine-Drawer-content button')].find((one) => one.innerText.trim() === 'Simpan').click()`);
    const saved = async () => (await api.call('GET', '/api/me/profile', budi.token)).body as { language: string | null; quietStart: number | null };
    for (let waited = 0; (await saved()).quietStart === null && waited < 50; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await saved();
    assert.deepEqual([result.quietStart, result.language], [22, 'ja'], 'his quiet hours are saved, and his language is the one he chose last');
  } finally {
    await page.close();
    await api.close();
  }
});

test('the owner alone can choose to hear people', async () => {
  const fixture = await createCompany('members-hear');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const sari = await seat(api, owner, fixture, 'Sari', 'approver');
    const refused = await api.call('POST', '/api/me/profile', sari.token, { ownerHearsPeople: true });
    assert.deepEqual([refused.status, refused.body.code], [403, 'staff.forbidden']);
    assert.equal('ownerHearsPeople' in (await api.call('GET', '/api/me/profile', sari.token)).body, false, 'a seat is not shown it');

    assert.equal((await api.call('GET', '/api/me/profile', owner)).body.ownerHearsPeople, false, 'off until the owner turns it on');
    const on = await api.call('POST', '/api/me/profile', owner, { ownerHearsPeople: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.ownerHearsPeople, true);
    const { rows } = await withControlPlane((tx) => tx.query<{ principal: string; owner_hears_people: boolean }>(
      'SELECT principal, owner_hears_people FROM principal_prefs ORDER BY principal'));
    assert.deepEqual(rows, [{ principal: 'owner', owner_hears_people: true }], 'kept for the owner, and nobody else has a setting');
  } finally {
    await api.close();
  }
});
