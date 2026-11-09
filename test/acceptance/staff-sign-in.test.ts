/**
 * A member of staff signs in with their handle and the code their app shows
 * (F19.22; STATUS 2.209).
 *
 * A seat signed in with its code alone, and the deployment found which seat
 * it was by trying every seat's secret in turn before the owner's: a cost
 * that grew with every person seated, and a door where one person's code was
 * compared with everyone's. A seat that has a handle now names it, and one
 * secret is resolved; the owner's door tries no seat that has one; a seat
 * seated before handles still signs in as it did, and is asked to choose
 * one. And a handle is locked after repeated wrong codes, wherever they come
 * from, so guessing one person's codes from many addresses gets nowhere.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { StaffSeats } from '../../src/owner/staff.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** A staff member's authenticator app: the code it shows, a step ahead each time so none is a replay. */
function app(secret: string) {
  let step = stepFor(new Date()) - 1;
  return () => {
    step += 1;
    return totpCode(decodeBase32(secret), Math.min(step, stepFor(new Date()) + 1));
  };
}

/** A code no app of this secret shows now, or a step either side: a wrong guess. */
function wrongFor(secret: string): string {
  const now = stepFor(new Date());
  const right = new Set([-2, -1, 0, 1, 2].map((drift) => totpCode(decodeBase32(secret), now + drift)));
  for (let guess = 0; ; guess += 1) {
    const code = String(guess * 7919 % 1_000_000).padStart(6, '0');
    if (!right.has(code)) return code;
  }
}

/** The owner seats someone; they open the link, choose what they chose, add the secret to their app, and confirm. */
async function seat(api: Console, owner: string, fixture: Fixture, name: string, chosen: Record<string, unknown> = {}) {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const invite = String(made.body.invite);
  const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const secret = String(opened.body.secret);
  const code = app(secret);
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.body.offer, totp: code(), ...chosen });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { seatId: String(made.body.seatId), token: String(joined.body.token), code, secret };
}

const failuresOf = async (seatId: string) => (await withControlPlane((tx) => tx.query<{ sign_in_failures: number; locked_until: Date | null }>(
  'SELECT sign_in_failures, locked_until FROM staff_seats WHERE id = $1', [seatId]))).rows[0]!;

test('a seat signs in with its handle and code', async () => {
  const fixture = await createCompany('sign-in-handle');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    assert.equal((await api.call('GET', '/api/me/profile', rina.token)).body.handle, 'rina', 'chosen when she joined');

    const signed = await api.call('POST', '/api/auth/sign-in', '', { handle: 'rina', totp: rina.code() });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.deepEqual(signed.body.staff, { name: 'Rina', kind: 'viewer', companyId: fixture.companyId });
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/work`, String(signed.body.token))).status, 200);

    // Typed as people type a handle: with its @, in capitals.
    const typed = await api.call('POST', '/api/auth/sign-in', '', { handle: ' @Rina', totp: rina.code() });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.deepEqual(typed.body.staff, { name: 'Rina', kind: 'viewer', companyId: fixture.companyId });
  } finally {
    await api.close();
  }
});

test('a code for one handle does not open another seat', async () => {
  const fixture = await createCompany('sign-in-crossed');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const budi = await seat(api, owner, fixture, 'Budi', { handle: 'budi' });

    const crossed = await api.call('POST', '/api/auth/sign-in', '', { handle: 'budi', totp: rina.code() });
    assert.deepEqual([crossed.status, crossed.body.code], [401, 'mfa.code_invalid'], 'Rina\'s code is not Budi\'s');
    assert.equal((await failuresOf(budi.seatId)).sign_in_failures, 1, 'and it counts against the handle it was tried on');
    assert.equal((await failuresOf(rina.seatId)).sign_in_failures, 0);
    const nobody = await api.call('POST', '/api/auth/sign-in', '', { handle: 'nobody', totp: rina.code() });
    assert.deepEqual([nobody.status, nobody.body], [crossed.status, crossed.body], 'a handle nobody has is refused in the same words');

    const his = await api.call('POST', '/api/auth/sign-in', '', { handle: 'budi', totp: budi.code() });
    assert.equal(his.status, 200, JSON.stringify(his.body));
    assert.equal(his.body.staff.name, 'Budi');
    assert.equal((await failuresOf(budi.seatId)).sign_in_failures, 0, 'a right code clears the count');
  } finally {
    await api.close();
  }
});

test("the owner's sign-in tries no seat that has a handle", async () => {
  const fixture = await createCompany('sign-in-owner');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const sari = await seat(api, owner, fixture, 'Sari');
    const refs = new Map((await withControlPlane((tx) => tx.query<{ id: string; secret_ref: string }>(
      'SELECT id, secret_ref FROM staff_seats WHERE company_id = $1', [fixture.companyId]))).rows.map((row) => [row.id, row.secret_ref]));

    // Every secret the sign-in resolves, as the seats' secrets are read.
    const resolved: string[] = [];
    const resolve = api.secrets.resolve.bind(api.secrets);
    api.secrets.resolve = async (reference: string) => {
      resolved.push(reference);
      return resolve(reference);
    };

    const signed = await api.call('POST', '/api/auth/sign-in', '', { totp: api.code() });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.staff, null, 'the owner');
    assert.ok(!resolved.includes(refs.get(rina.seatId)!), 'Rina names her handle when she signs in, so her secret is not read for anyone else\'s code');
    assert.ok(resolved.includes(refs.get(sari.seatId)!),
      'a seat seated before handles is tried first, so its code never spends the owner\'s lockout');

    const without = await api.call('POST', '/api/auth/sign-in', '', { totp: rina.code() });
    assert.equal(without.status, 401, 'and Rina\'s code without her handle opens nothing');
    assert.equal(without.body.staff, undefined);
  } finally {
    await api.close();
  }
});

test('a seat without a handle still signs in with its code, and is asked to choose one', async () => {
  const fixture = await createCompany('sign-in-legacy');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const sari = await seat(api, owner, fixture, 'Sari');
    const signed = await api.call('POST', '/api/auth/sign-in', '', { totp: sari.code() });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.deepEqual(signed.body.staff, { name: 'Sari', kind: 'viewer', companyId: fixture.companyId });
    const token = String(signed.body.token);
    const profile = await api.call('GET', '/api/me/profile', token);
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal(profile.body.handle, null, 'the console asks her to choose one');

    const chosen = await api.call('POST', '/api/me/profile', token, { handle: 'sari' });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.handle, 'sari');
    // From now on she names it: her code alone is no longer tried as hers.
    assert.equal((await api.call('POST', '/api/auth/sign-in', '', { totp: sari.code() })).status, 401);
    const named = await api.call('POST', '/api/auth/sign-in', '', { handle: 'sari', totp: sari.code() });
    assert.equal(named.status, 200, JSON.stringify(named.body));
  } finally {
    await api.close();
  }
});

test('a handle is one live seat\'s across the deployment, and a taken handle is refused without saying where', async () => {
  const toko = await createCompany('handle-toko');
  const kopi = await createCompany('handle-kopi');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, toko, 'Budi', { handle: 'budi' });

    // Another company's person asks for it as they join: refused before the invite is spent.
    const made = await api.call('POST', `/api/companies/${kopi.companyId}/staff`, owner, { name: 'Bono', kind: 'viewer', proof: { totp: api.code() } });
    const opened = await api.call('POST', '/api/auth/join', '', { code: made.body.invite });
    const code = app(String(opened.body.secret));
    const taken = await api.call('POST', '/api/auth/join/confirm', '', { code: made.body.invite, offer: opened.body.offer, totp: code(), handle: 'budi' });
    assert.deepEqual([taken.status, taken.body.code], [409, 'handle.unusable']);
    const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: made.body.invite, offer: opened.body.offer, totp: code(), handle: 'bono' });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bono = String(joined.body.token);

    // Taken, taken in look-alike letters, reserved, or a role's name here: one answer, which says none of it.
    const answers = [];
    for (const handle of ['budi', 'bud1', 'owner', 'palugada', 'w0rker']) {
      const refused = await api.call('POST', '/api/me/profile', bono, { handle });
      assert.deepEqual([refused.status, refused.body.code], [409, 'handle.unusable'], handle);
      answers.push(refused.body);
    }
    for (const answer of answers) assert.deepEqual(answer, answers[0], 'every refusal is the same refusal');
    assert.doesNotMatch(JSON.stringify(answers[0]), /Budi|budi|toko|owner|palugada|worker/i);
    const shapeless = await api.call('POST', '/api/me/profile', bono, { handle: 'b' });
    assert.deepEqual([shapeless.status, shapeless.body.code], [400, 'contract.violation'], 'a handle too short is a mistake, and said so');

    // Free again once its seat is ended.
    assert.equal((await api.call('POST', `/api/companies/${toko.companyId}/staff/${budi.seatId}/revoke`, owner, {})).status, 200);
    const free = await api.call('POST', '/api/me/profile', bono, { handle: 'budi' });
    assert.equal(free.status, 200, JSON.stringify(free.body));
    assert.equal(free.body.handle, 'budi');
  } finally {
    await api.close();
  }
});

test('a handle is locked after repeated wrong codes, whichever address they come from', async () => {
  const fixture = await createCompany('sign-in-locked');
  const api = await consoleWithSettings({ behindProxy: true });
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const budi = await seat(api, owner, fixture, 'Budi', { handle: 'budi' });
    const from = async (address: string, body: Record<string, unknown>) => {
      const response = await fetch(`${api.url}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const lockedFor = async () => {
      const { locked_until: until } = await failuresOf(rina.seatId);
      return until ? Math.round((until.getTime() - Date.now()) / 1000) : 0;
    };

    // Five wrong codes, each from an address of its own, so no address's own count is reached.
    const wrong = wrongFor(rina.secret);
    for (let at = 1; at <= 5; at += 1) {
      const guessed = await from(`198.51.100.${at}`, { handle: 'rina', totp: wrong });
      assert.deepEqual([guessed.status, guessed.body.code], [401, 'mfa.code_invalid'], `guess ${at}`);
    }
    const locked = await from('198.51.100.9', { handle: 'rina', totp: rina.code() });
    assert.deepEqual([locked.status, locked.body.code], [429, 'auth.handle_locked'], 'her own right code waits for the lock');
    const seconds = await lockedFor();
    assert.ok(seconds > 50 && seconds <= 60, `locked for a minute, not ${seconds} s`);
    // Nobody else's door is shut by it.
    assert.equal((await from('198.51.100.9', { totp: api.code() })).status, 200, 'the owner signs in');
    assert.equal((await from('198.51.100.9', { handle: 'budi', totp: budi.code() })).status, 200, 'and so does a colleague');

    // When the lock has passed, her code opens her seat, and the count starts again.
    await withControlPlane((tx) => tx.query("UPDATE staff_seats SET locked_until = now() - interval '1 second' WHERE id = $1", [rina.seatId]));
    const after = await from('198.51.100.9', { handle: 'rina', totp: rina.code() });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(await failuresOf(rina.seatId), { sign_in_failures: 0, locked_until: null });

    // Each lock is twice the last, to an hour at most.
    for (const [before, expected] of [[9, 120], [34, 3600], [999, 3600]] as const) {
      await withControlPlane((tx) => tx.query('UPDATE staff_seats SET sign_in_failures = $2, locked_until = NULL WHERE id = $1', [rina.seatId, before]));
      assert.equal((await from('203.0.113.7', { handle: 'rina', totp: wrong })).status, 401);
      const lasts = await lockedFor();
      assert.ok(lasts > expected - 10 && lasts <= expected, `after ${before + 1} wrong codes the lock lasts ${expected} s, not ${lasts} s`);
    }
  } finally {
    await api.close();
  }
});

test('many sessions are verified at once, and an ended one is not among them', async () => {
  const fixture = await createCompany('sign-in-many');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const budi = await seat(api, owner, fixture, 'Budi', { handle: 'budi' });
    const sari = await seat(api, owner, fixture, 'Sari', { handle: 'sari' });
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${sari.seatId}/revoke`, owner, {})).status, 200);
    const seats = new StaffSeats({ master: () => api.master, secrets: () => api.secrets });
    const verified = await seats.verifyMany([rina.token, budi.token, sari.token, 'not a token', rina.token]);
    assert.deepEqual([...verified.keys()].sort(), [rina.token, budi.token].sort());
    assert.equal(verified.get(rina.token)!.seat.name, 'Rina');
    assert.equal(verified.get(budi.token)!.seat.id, budi.seatId);
    assert.equal((await seats.verifyMany([])).size, 0);
  } finally {
    await api.close();
  }
});
