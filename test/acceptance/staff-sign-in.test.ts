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
 *
 * The lock is the handle's, held or not, and needs wrong codes from more
 * than one address, so a stranger who knows a colleague's handle cannot keep
 * them out from one machine, nor learn from the lock which handles are real.
 * And a seat whose phone is lost gets a new authenticator from the owner and
 * stays the same person (STATUS 2.217).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { StaffSeats } from '../../src/owner/staff.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { fakeRelay } from '../helpers/fake-relay.ts';
import { linkThrough, pairThrough } from '../helpers/relay.ts';
import { ok, personIn, refusedWith, said } from '../helpers/rooms.ts';
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
  let step = 0;
  return () => {
    // The earliest step the window still takes, a step ahead of the last each time, up to the latest it takes.
    const now = stepFor(new Date());
    step = Math.max(step + 1, now - 1);
    return totpCode(decodeBase32(secret), Math.min(step, now + 1));
  };
}

/** Codes no app of this secret shows now, or a step either side: wrong guesses, each different. */
function wrongCodesFor(secret: string, count: number): string[] {
  const now = stepFor(new Date());
  const right = new Set([-2, -1, 0, 1, 2].map((drift) => totpCode(decodeBase32(secret), now + drift)));
  const wrong: string[] = [];
  for (let guess = 0; wrong.length < count; guess += 1) {
    const code = String(guess * 7919 % 1_000_000).padStart(6, '0');
    if (!right.has(code)) wrong.push(code);
  }
  return wrong;
}

const wrongFor = (secret: string): string => wrongCodesFor(secret, 1)[0]!;

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

/** A handle's wrong codes counted toward its next lock, its locks, and the lock it is under: kept for the handle, held or not. */
const failuresOf = async (handle: string) => (await withControlPlane((tx) => tx.query<{ counted: number; locks: number; locked_until: Date | null }>(
  'SELECT counted, locks, locked_until FROM handle_sign_ins WHERE handle = $1', [handle]))).rows[0] ?? { counted: 0, locks: 0, locked_until: null };

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
    const code = rina.code();
    const typed = await api.call('POST', '/api/auth/sign-in', '', { handle: ' @Rina', totp: code });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.deepEqual(typed.body.staff, { name: 'Rina', kind: 'viewer', companyId: fixture.companyId });

    // A code once used opens nothing again, and is not counted as a guess.
    const again = await api.call('POST', '/api/auth/sign-in', '', { handle: 'rina', totp: code });
    assert.deepEqual([again.status, again.body.code], [401, 'mfa.replayed']);
    assert.equal((await failuresOf('rina')).counted, 0);
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
    assert.equal((await failuresOf('budi')).counted, 1, 'and it counts against the handle it was tried on');
    assert.equal((await failuresOf('rina')).counted, 0);
    const nobody = await api.call('POST', '/api/auth/sign-in', '', { handle: 'nobody', totp: rina.code() });
    assert.deepEqual([nobody.status, nobody.body], [crossed.status, crossed.body], 'a handle nobody has is refused in the same words');

    const his = await api.call('POST', '/api/auth/sign-in', '', { handle: 'budi', totp: budi.code() });
    assert.equal(his.status, 200, JSON.stringify(his.body));
    assert.equal(his.body.staff.name, 'Budi');
    assert.equal((await failuresOf('budi')).counted, 0, 'a right code clears the count');
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

test('a handle is locked after wrong codes from several addresses, whichever they are', async () => {
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
    const lockedFor = async (handle: string) => {
      const { locked_until: until } = await failuresOf(handle);
      return until ? Math.round((until.getTime() - Date.now()) / 1000) : 0;
    };

    // Ten wrong codes, each from an address of its own, so no address's own count is reached.
    const wrong = wrongFor(rina.secret);
    for (let at = 1; at <= 10; at += 1) {
      const guessed = await from(`198.51.100.${at}`, { handle: 'rina', totp: wrong });
      assert.deepEqual([guessed.status, guessed.body.code], [401, 'mfa.code_invalid'], `guess ${at}`);
    }
    const locked = await from('198.51.100.20', { handle: 'rina', totp: rina.code() });
    assert.deepEqual([locked.status, locked.body.code], [429, 'auth.handle_locked'], 'her own right code waits for the lock');
    const seconds = await lockedFor('rina');
    assert.ok(seconds > 50 && seconds <= 60, `locked for a minute, not ${seconds} s`);
    // Nobody else's door is shut by it.
    assert.equal((await from('198.51.100.20', { totp: api.code() })).status, 200, 'the owner signs in');
    assert.equal((await from('198.51.100.20', { handle: 'budi', totp: budi.code() })).status, 200, 'and so does a colleague');

    // When the lock has passed, her code opens her seat, and the count starts again.
    await withControlPlane((tx) => tx.query("UPDATE handle_sign_ins SET locked_until = now() - interval '1 second' WHERE handle = 'rina'"));
    const after = await from('198.51.100.20', { handle: 'rina', totp: rina.code() });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(await failuresOf('rina'), { counted: 0, locks: 0, locked_until: null });

    // Each lock is twice the last, to an hour at most.
    for (const [locks, expected] of [[1, 120], [6, 3600], [200, 3600]] as const) {
      await withControlPlane((tx) => tx.query(
        `INSERT INTO handle_sign_ins (handle, counted, window_until, locks) VALUES ('rina', 9, now() + interval '10 minutes', $1)
         ON CONFLICT (handle) DO UPDATE SET counted = 9, addresses = '{}', window_until = now() + interval '10 minutes', locks = $1, locked_until = NULL`,
        [locks]));
      assert.equal((await from('203.0.113.7', { handle: 'rina', totp: wrong })).status, 401);
      const lasts = await lockedFor('rina');
      assert.ok(lasts > expected - 10 && lasts <= expected, `the lock after ${locks} lasts ${expected} s, not ${lasts} s`);
    }

    // Wrong codes are forgotten once their quarter hour has passed.
    await withControlPlane((tx) => tx.query(
      "UPDATE handle_sign_ins SET counted = 9, locked_until = NULL, window_until = now() - interval '1 second' WHERE handle = 'rina'"));
    assert.equal((await from('203.0.113.8', { handle: 'rina', totp: wrong })).status, 401);
    const forgotten = await failuresOf('rina');
    assert.deepEqual([forgotten.counted, forgotten.locked_until], [1, null], 'one wrong code in a new quarter hour locks nothing');
  } finally {
    await api.close();
  }
});

test('one address cannot lock a seat out, and a handle nobody holds answers as a held one does', async () => {
  const fixture = await createCompany('sign-in-one-address');
  const api = await consoleWithSettings({ behindProxy: true });
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const from = async (address: string, body: Record<string, unknown>) => {
      const response = await fetch(`${api.url}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    // Everything one address may send: five wrong codes, then its own
    // throttle. Rina, from her own address, is not locked out by it.
    const wrong = wrongCodesFor(rina.secret, 6);
    const answers: string[] = [];
    for (const totp of wrong) {
      const answer = await from('203.0.113.66', { handle: 'rina', totp });
      answers.push(`${answer.status} ${answer.body.code}`);
    }
    assert.deepEqual(answers, [...Array(5).fill('401 mfa.code_invalid'), '429 owner.throttled']);
    assert.equal((await failuresOf('rina')).counted, 3, 'an address counts at most three wrong codes toward a lock');
    const hers = await from('198.51.100.20', { handle: 'rina', totp: rina.code() });
    assert.equal(hers.status, 200, JSON.stringify(hers.body));

    // A handle nobody holds is counted and locked as hers was: the same
    // answers, in the same order, so the lock says nothing of who is seated.
    const nobody = wrongCodesFor(rina.secret, 1)[0]!;
    const asked = async (handle: string) => {
      const said: string[] = [];
      for (let at = 1; at <= 11; at += 1) {
        const answer = await from(`192.0.2.${at}`, { handle, totp: nobody });
        said.push(`${answer.status} ${answer.body.code} ${Object.keys(answer.body).sort().join(',')}`);
      }
      return said;
    };
    const held = await asked('rina');
    assert.deepEqual(held.slice(10), ['429 auth.handle_locked code,details,error'], 'ten wrong codes lock it');
    assert.deepEqual(await asked('nobody'), held, 'a handle nobody holds answers exactly as hers did');
    assert.ok((await failuresOf('nobody')).locked_until, 'and is locked as hers is');
  } finally {
    await api.close();
  }
});

test("an IPv6 network is one address, so one machine's many addresses cannot lock a colleague out", async () => {
  // One IPv6 host is usually given a /64, so wrong codes from four of its
  // addresses counted as four addresses and locked the handle; and each of
  // them had five wrong codes of its own a quarter hour (STATUS 2.217).
  const fixture = await createCompany('sign-in-ipv6');
  const api = await consoleWithSettings({ behindProxy: true });
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const from = async (address: string, body: Record<string, unknown>) => {
      const response = await fetch(`${api.url}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify(body),
      });
      return `${response.status} ${(await response.json() as { code?: string }).code ?? 'signed in'}`;
    };
    const wrong = wrongCodesFor(rina.secret, 12);
    const answers: string[] = [];
    for (let at = 0; at < 12; at += 1) {
      // Written in every way one network's addresses are: short, in full, in capitals.
      const address = ['2001:db8:1:2::1', '2001:0db8:0001:0002:0000:0000:0000:0002', '2001:DB8:1:2:ffff::3', '2001:db8:1:2:a:b:c:d'][at % 4]!;
      answers.push(await from(address, { handle: 'rina', totp: wrong[at] }));
    }
    assert.deepEqual(answers, [...Array(5).fill('401 mfa.code_invalid'), ...Array(7).fill('429 owner.throttled')],
      "one network is held to one address's five");
    assert.equal((await failuresOf('rina')).counted, 3, 'and counts three towards a lock, as one address does');
    // An IPv4 address written as IPv6 is the address it is.
    assert.equal(await from('::ffff:203.0.113.9', { handle: 'rina', totp: wrong[0] }), '401 mfa.code_invalid');
    for (let n = 1; n <= 4; n += 1) await from('203.0.113.9', { handle: 'rina', totp: wrong[n] });
    assert.equal(await from('::ffff:203.0.113.9', { handle: 'rina', totp: wrong[5] }), '429 owner.throttled');
    // Another network is another address, and Rina's own code still opens her seat.
    assert.equal(await from('2001:db8:1:3::1', { handle: 'rina', totp: rina.code() }), '200 signed in');
  } finally {
    await api.close();
  }
});

test('the owner lets a locked seat sign in again without ending anything the seat holds', async () => {
  // A colleague who knows a handle can still lock it from several networks;
  // the owner's only remedy was a new authenticator, which also signs the
  // person out everywhere and unlinks their phone (STATUS 2.217).
  const fixture = await createCompany('sign-in-unlock');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const at = `/api/companies/${fixture.companyId}`;
    await withControlPlane((tx) => tx.query(
      "INSERT INTO handle_sign_ins (handle, counted, locks, locked_until) VALUES ('rina', 4, 3, now() + interval '1 hour')"));
    const listed = async () => (ok(await api.call('GET', `${at}/staff`, owner)).seats as Array<{ id: string; lockedUntil: string | null }>)
      .find((one) => one.id === rina.seatId)!;
    assert.ok((await listed()).lockedUntil, 'People shows that her handle is locked');
    refusedWith(await api.call('POST', '/api/auth/sign-in', '', { handle: 'rina', totp: rina.code() }), 429, 'auth.handle_locked');

    // The owner's code, given now: the lock is what keeps guesses out.
    refusedWith(await api.call('POST', `${at}/staff/${rina.seatId}/unlock`, owner, {}), 403, 'approval.channel_forbidden');
    ok(await api.call('POST', `${at}/staff/${rina.seatId}/unlock`, owner, { proof: { totp: api.code() } }));
    assert.deepEqual(await failuresOf('rina'), { counted: 0, locks: 0, locked_until: null });
    assert.equal((await listed()).lockedUntil, null);
    // Her session goes on as it was, and her code opens her seat again.
    ok(await api.call('GET', '/api/me', rina.token), 'her session was not ended');
    const signed = await api.call('POST', '/api/auth/sign-in', '', { handle: 'rina', totp: rina.code() });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    // A seat that is not this company's is refused by name.
    refusedWith(await api.call('POST', `${at}/staff/00000000-0000-4000-8000-000000000000/unlock`, owner, { proof: { totp: api.code() } }),
      400, 'contract.violation', 'no such seat');
  } finally {
    await api.close();
  }
});

test('wrong codes sent at once are judged one at a time, so no more are compared than the lock allows', async () => {
  const fixture = await createCompany('sign-in-at-once');
  const api = await consoleWithSettings({ behindProxy: true });
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });

    // Guesses are not sent one after another. Thirty different wrong codes,
    // all at once and each from an address of its own, must still meet a lock
    // that lets ten through: had each read the count before any had added to
    // it, all thirty would have been compared.
    const answers = await Promise.all(wrongCodesFor(rina.secret, 30).map(async (totp, at) => {
      const response = await fetch(`${api.url}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${at + 1}` },
        body: JSON.stringify({ handle: 'rina', totp }),
      });
      return `${response.status} ${((await response.json()) as { code?: string }).code}`;
    }));
    const counted: Record<string, number> = {};
    for (const answer of answers) counted[answer] = (counted[answer] ?? 0) + 1;
    assert.deepEqual(counted, { '401 mfa.code_invalid': 10, '429 auth.handle_locked': 20 }, 'ten compared, the rest refused by the lock');
    const after = await failuresOf('rina');
    assert.equal(after.locks, 1, 'and one lock made of them');
    assert.ok(after.locked_until && after.locked_until.getTime() > Date.now(), 'and the handle is locked');
  } finally {
    await api.close();
  }
});

test('the owner gives a seat a new authenticator: the same person, signed out, in the same rooms', async () => {
  // A lost or replaced phone had no way back but ending the seat, which took
  // the person out of every room and lost their direct conversations
  // (STATUS 2.217).
  const fixture = await createCompany('sign-in-new-app');
  const api = await consoleWithSettings();
  const relay = await fakeRelay();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', { handle: 'rina' });
    const at = `/api/companies/${fixture.companyId}`;
    const hers = personIn(api, rina.token, fixture.companyId);
    const dm = String(ok(await hers.direct(['owner'])).room.id);
    await said(hers, dm, 'My phone is in the river.');
    const room = String(ok(await hers.makeRoom({ name: 'Payroll', private: true })).room.id);
    const relayId = await pairThrough(api, owner, relay, { companies: [fixture.companyId] });
    await linkThrough(api, rina.token, relay, relayId, { device: true, owner: false });
    const [before] = (ok(await api.call('GET', `${at}/staff`, owner)).seats as Array<{ id: string; joinedAt: string }>);
    // Locked out by someone guessing, too.
    await withControlPlane((tx) => tx.query(
      "INSERT INTO handle_sign_ins (handle, locks, locked_until) VALUES ('rina', 3, now() + interval '1 hour')"));

    // The owner's code, given now: whoever opens the link is let in as her.
    refusedWith(await api.call('POST', `${at}/staff/${rina.seatId}/authenticator`, owner, {}), 403, 'approval.channel_forbidden');
    const made = ok(await api.call('POST', `${at}/staff/${rina.seatId}/authenticator`, owner, { proof: { totp: api.code() } }));
    assert.equal(made.seatId, rina.seatId);
    const invite = String(made.invite);

    // Her sessions, her old app and her phone's links end now, and the lock with them.
    assert.deepEqual(await failuresOf('rina'), { counted: 0, locks: 0, locked_until: null });
    refusedWith(await api.call('GET', '/api/me', rina.token), 401, 'owner.unauthenticated', 'her old session');
    refusedWith(await api.call('POST', '/api/auth/sign-in', '', { handle: 'rina', totp: rina.code() }), 401, 'mfa.code_invalid', 'her old app');
    const links = await withControlPlane((tx) => tx.query<{ status: string }>(
      'SELECT status FROM relay_links WHERE principal = $1', [`seat:${rina.seatId}`]));
    assert.ok(links.rows.length > 0 && links.rows.every((one) => one.status === 'ended'), 'her phone is told nothing more');

    // The link opens as hers: her name and handle, nothing to choose again.
    const opened = ok(await api.call('POST', '/api/auth/join', '', { code: invite }));
    assert.deepEqual([opened.seat.id, opened.seat.name, opened.seat.handle, opened.seat.again], [rina.seatId, 'Rina', 'rina', true]);
    const code = app(String(opened.secret));
    const joined = ok(await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.offer, totp: code() }));
    const again = personIn(api, String(joined.token), fixture.companyId);
    assert.equal(ok(await api.call('GET', '/api/me/profile', String(joined.token))).handle, 'rina');
    const rooms = (ok(await again.rooms()).rooms as Array<{ id: string }>).map((one) => one.id);
    assert.ok(rooms.includes(dm) && rooms.includes(room), 'her direct conversation and her private room are still hers');
    assert.ok((ok(await again.page(dm)).messages as Array<{ body: string }>).some((one) => one.body === 'My phone is in the river.'));
    const signed = await api.call('POST', '/api/auth/sign-in', '', { handle: 'rina', totp: code() });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const [after] = (ok(await api.call('GET', `${at}/staff`, owner)).seats as Array<{ id: string; joinedAt: string }>);
    assert.equal(after!.joinedAt, before!.joinedAt, 'joined when she first joined');

    // The link works once, and a seat ended or of another company has none.
    refusedWith(await api.call('POST', '/api/auth/join', '', { code: invite }), 401, 'mfa.claim_invalid', 'the spent link');
    refusedWith(await api.call('POST', `${at}/staff/00000000-0000-4000-8000-000000000000/authenticator`, owner, { proof: { totp: api.code() } }),
      400, 'contract.violation', 'no such seat');
  } finally {
    await relay.close();
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
