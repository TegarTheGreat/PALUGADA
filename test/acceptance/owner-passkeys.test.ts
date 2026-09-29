/**
 * Passkeys, made in the console and used to sign in and to approve (PRD v2
 * F12.5, F10.10).
 *
 * The platform has verified a passkey *assertion* since F12.5 was built, and
 * nothing could make one: there was no registration ceremony, so the only
 * passkey a deployment ever held was one a test inserted. The audit of
 * 2026-09-28 found the console had no passkey at all (item 24). These are the
 * ceremony that was missing -- the browser's `navigator.credentials.create`
 * answer read and checked -- and the routes the console presses.
 *
 * The authenticator is software (`test/helpers/passkey.ts`) that writes the
 * same bytes a phone does; the CBOR it writes is written there, independently
 * of the reader under test.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import {
  ChallengeStore,
  OwnerMfa,
  TOTP_STEP_SECONDS,
  decodeBase32,
  newTotpSecret,
  stepFor,
  totpCode,
} from '../../src/owner/mfa.ts';
import { decodeCbor } from '../../src/owner/passkey.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { authenticator, cbor, type Encodable } from '../helpers/passkey.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const RP_ID = 'palugada.local';
const ORIGIN = 'https://palugada.local';

function mfaWith() {
  return new OwnerMfa({ secrets: new InMemorySecretManager(), challenges: new ChallengeStore(), rpId: RP_ID, origin: ORIGIN });
}

async function call(url: string, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

/** The console with the owner's authenticator app enrolled, as a fresh deployment has it. */
async function consoleWithCode() {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, rpId: RP_ID, origin: ORIGIN, now: at });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
  const api = new OwnerApi({ mfa, secrets });
  const { url } = await api.listen();
  return {
    url,
    mfa,
    code: () => {
      steps += 1;
      return totpCode(decodeBase32(secret), stepFor(at()));
    },
    close: () => api.close(),
  };
}

test('an owner adds a passkey with the factor they hold, then signs in and approves with it (F12.5)', async () => {
  const owner = await consoleWithCode();
  try {
    const signedIn = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code() } });
    const token = String(signedIn.body.token);

    // What the console hands `navigator.credentials.create`.
    const options = await call(owner.url, 'GET', '/api/mfa/passkeys/options', { token });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.deepEqual(options.body.rp, { id: RP_ID, name: 'PALUGADA' });
    assert.deepEqual(options.body.algorithms, [-7, -8, -257]);
    assert.deepEqual(options.body.exclude, []);
    assert.ok(Buffer.from(options.body.user.id, 'base64url').length >= 16, 'a user handle nobody can guess');
    assert.ok(options.body.timeoutMs > 0);

    const phone = authenticator({ rpId: RP_ID, origin: ORIGIN, signCount: 7 });
    const credential = phone.register({ challenge: options.body.challenge });

    // A signed-in browser is not enough: a session taken from the owner's
    // laptop would otherwise add its thief's key, and keep it after the
    // session was ended.
    const unproven = await call(owner.url, 'POST', '/api/mfa/passkeys', { token, body: { label: 'MacBook', credential } });
    assert.equal(unproven.status, 403);
    assert.equal(unproven.body.code, 'approval.channel_forbidden');

    const again = await call(owner.url, 'GET', '/api/mfa/passkeys/options', { token });
    const added = await call(owner.url, 'POST', '/api/mfa/passkeys', {
      token,
      body: { label: '  MacBook  ', credential: phone.register({ challenge: again.body.challenge }), proof: { totp: owner.code() } },
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.label, 'MacBook');

    const listed = await call(owner.url, 'GET', '/api/mfa/authenticators', { token });
    assert.deepEqual(
      listed.body.authenticators.map((one: { kind: string; label: string }) => [one.kind, one.label]),
      [['totp', 'owner phone'], ['webauthn', 'MacBook']],
    );
    assert.deepEqual(listed.body.passkeys, { rpId: RP_ID, origin: ORIGIN }, 'where the console can use one');

    // The same device is not offered a second passkey for this console.
    const excluded = await call(owner.url, 'GET', '/api/mfa/passkeys/options', { token });
    assert.deepEqual(excluded.body.exclude, [phone.id]);

    // Signing in: the challenge says where, for the browser to ask for.
    const challenge = await call(owner.url, 'GET', '/api/auth/challenge');
    assert.equal(challenge.body.rpId, RP_ID);
    assert.equal(challenge.body.origin, ORIGIN);
    const withKey = await call(owner.url, 'POST', '/api/auth/sign-in', {
      body: { webauthn: phone.assert({ challenge: challenge.body.challenge }) },
    });
    assert.equal(withKey.status, 200, JSON.stringify(withKey.body));
    assert.equal(withKey.body.factor, 'webauthn');
    assert.equal(withKey.body.device, 'MacBook');

    // And confirming: the passkey is the factor that retires the code.
    const fresh = await call(owner.url, 'GET', '/api/mfa/challenge', { token: String(withKey.body.token) });
    assert.equal(fresh.body.rpId, RP_ID);
    const totpId = listed.body.authenticators.find((one: { kind: string }) => one.kind === 'totp').id;
    const revoked = await call(owner.url, 'POST', `/api/mfa/authenticators/${totpId}/revoke`, {
      token: String(withKey.body.token),
      body: { proof: { webauthn: phone.assert({ challenge: fresh.body.challenge }) } },
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  } finally {
    await owner.close();
  }
});

/**
 * The lockout counted every failed factor alike. Anybody who could reach the
 * sign-in page -- from a few addresses, past the throttle each one has --
 * could send ten wrong codes and lock the owner out of everything for a
 * quarter of an hour, and again after it. A passkey cannot be guessed: it
 * signs a challenge this console made a moment ago. So wrong codes lock the
 * code, and the owner who has a passkey still gets in with it.
 */
test('wrong codes lock the code and not the owner\'s passkey (F12.5, security)', async () => {
  const owner = await consoleWithCode();
  try {
    const signedIn = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code() } });
    const token = String(signedIn.body.token);
    const phone = authenticator({ rpId: RP_ID, origin: ORIGIN, signCount: 1 });
    const options = await call(owner.url, 'GET', '/api/mfa/passkeys/options', { token });
    const added = await call(owner.url, 'POST', '/api/mfa/passkeys', {
      token, body: { label: 'Phone', credential: phone.register({ challenge: options.body.challenge }), proof: { totp: owner.code() } },
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));

    // Somebody else, guessing codes.
    for (let guess = 0; guess < 10; guess += 1) {
      await assert.rejects(owner.mfa.verifyTotp(String(100000 + guess)), (error: unknown) => isPalugadaError(error, 'mfa.code_invalid'));
    }
    await assert.rejects(owner.mfa.verifyTotp(owner.code()), (error: unknown) => isPalugadaError(error, 'mfa.locked_out'),
      'the code is locked, as it should be');

    const challenge = await call(owner.url, 'GET', '/api/auth/challenge');
    const withKey = await call(owner.url, 'POST', '/api/auth/sign-in', {
      body: { webauthn: phone.assert({ challenge: challenge.body.challenge }) },
    });
    assert.equal(withKey.status, 200, JSON.stringify(withKey.body));
    assert.equal(withKey.body.factor, 'webauthn', 'and the owner still gets in');
  } finally {
    await owner.close();
  }
});

test('a passkey of each algorithm the console offers signs in (F12.5)', async () => {
  const mfa = mfaWith();
  for (const algorithm of ['ES256', 'EdDSA', 'RS256'] as const) {
    const device = authenticator({ rpId: RP_ID, origin: ORIGIN, algorithm });
    const added = await mfa.enrolPasskey({ label: algorithm, ...device.register({ challenge: mfa.challenge() }) });
    assert.equal(added.label, algorithm);
    const verified = await mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge() }));
    assert.equal(verified.label, algorithm, `${algorithm} signs in`);
  }
});

test("a passkey's counter starts where the authenticator's was (F12.5)", async () => {
  const mfa = mfaWith();
  const device = authenticator({ rpId: RP_ID, origin: ORIGIN, signCount: 41 });
  await mfa.enrolPasskey({ label: 'key', ...device.register({ challenge: mfa.challenge() }) });
  // A copy of the key made before it was enrolled reports a count the
  // original has already passed.
  await assert.rejects(
    mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), signCount: 41 })),
    (error: unknown) => isPalugadaError(error, 'mfa.counter_did_not_advance'),
  );
  assert.equal((await mfa.verifyWebAuthn(device.assert({ challenge: mfa.challenge(), signCount: 42 }))).label, 'key');
});

/**
 * One refusal per thing that makes a registration not one, each differing from
 * a good ceremony in that thing alone -- a test that only checked "a bad one is
 * refused" would pass with most of the checks deleted.
 */
test('a new passkey is refused for each thing that makes it not one (F12.5)', async () => {
  const mfa = mfaWith();
  const device = authenticator({ rpId: RP_ID, origin: ORIGIN });
  const refused = async (why: string, code: string, make: (challenge: string) => Parameters<typeof device.register>[0]) => {
    const registration = device.register(make(mfa.challenge()));
    await assert.rejects(
      mfa.enrolPasskey({ label: 'key', ...registration }),
      (error: unknown) => isPalugadaError(error, code as never) || assert.fail(`${why}: ${String(error)}`),
      why,
    );
  };

  // An assertion's client data, from a signature the owner made to approve
  // something, is not a registration.
  await refused('the wrong ceremony', 'mfa.wrong_ceremony', (challenge) => ({ challenge, type: 'webauthn.get' }));
  await refused('a challenge nobody issued', 'mfa.challenge_unknown', () => ({ challenge: 'made-up' }));
  await refused('another site', 'mfa.wrong_origin', (challenge) => ({ challenge, origin: 'https://palugada.local.attacker.example' }));
  await refused('another relying party', 'mfa.wrong_relying_party', (challenge) => ({ challenge, rpId: 'attacker.example' }));
  await refused('nobody verified', 'mfa.not_user_verified', (challenge) => ({ challenge, userVerified: false }));
  await refused('nobody present', 'mfa.not_user_verified', (challenge) => ({ challenge, userPresent: false }));
  await refused('no credential in it', 'mfa.attestation_malformed', (challenge) => ({ challenge, noCredential: true }));
  await refused('a credential not flagged as one', 'mfa.attestation_malformed', (challenge) => ({ challenge, unflagged: true }));
  await refused('bytes after the key', 'mfa.attestation_malformed', (challenge) => ({ challenge, trailing: Buffer.from([0]) }));
  await refused('bytes after the attestation', 'mfa.attestation_malformed', (challenge) => ({ challenge, afterAttestation: Buffer.from([0]) }));
  await refused('a different id reported', 'mfa.attestation_malformed', (challenge) => ({ challenge, reportedId: 'c29tZXRoaW5nIGVsc2U' }));
  await refused('not CBOR at all', 'mfa.attestation_malformed', (challenge) => ({ challenge, attestationObject: Buffer.from('{"fmt":"none"}') }));
  await refused('a map without authData', 'mfa.attestation_malformed', (challenge) => ({
    challenge, attestationObject: cbor(new Map<string, Encodable>([['fmt', 'none'], ['attStmt', new Map()]])),
  }));

  // Keys: an algorithm not offered, a key that is not what its algorithm
  // says, a point that is not on the curve, an RSA key anyone can factor.
  const es256 = device.cose();
  await refused('ES384', 'mfa.algorithm_unsupported', (challenge) => ({ challenge, cose: new Map([...es256, [3, -35]]) }));
  await refused('an ES256 key on another curve', 'mfa.attestation_malformed', (challenge) => ({ challenge, cose: new Map([...es256, [-1, 2]]) }));
  const offCurve = Buffer.from(es256.get(-3) as Buffer);
  offCurve[31] = offCurve[31]! ^ 0x01;
  await refused('a point off the curve', 'mfa.attestation_malformed', (challenge) => ({ challenge, cose: new Map([...es256, [-3, offCurve]]) }));
  const weak = authenticator({ rpId: RP_ID, origin: ORIGIN, algorithm: 'RS256', rsaBits: 1024 });
  await assert.rejects(
    mfa.enrolPasskey({ label: 'weak', ...weak.register({ challenge: mfa.challenge() }) }),
    (error: unknown) => isPalugadaError(error, 'mfa.algorithm_unsupported'),
  );

  // A challenge answers one registration: the same bytes sent twice -- from a
  // proxy's log, after the owner revoked the key -- do not put it back.
  const once = device.register({ challenge: mfa.challenge() });
  await mfa.enrolPasskey({ label: 'key', ...once });
  await assert.rejects(
    mfa.enrolPasskey({ label: 'key again', ...once }),
    (error: unknown) => isPalugadaError(error, 'mfa.challenge_unknown'),
  );
  await assert.rejects(
    mfa.enrolPasskey({ label: 'key again', ...device.register({ challenge: mfa.challenge() }) }),
    (error: unknown) => isPalugadaError(error, 'mfa.already_enrolled'),
  );
  await assert.rejects(
    mfa.enrolPasskey({ label: '   ', ...authenticator({ rpId: RP_ID, origin: ORIGIN }).register({ challenge: mfa.challenge() }) }),
    (error: unknown) => isPalugadaError(error, 'contract.violation'),
  );

  const passkeys = (await mfa.enrolled()).filter((one) => one.kind === 'webauthn');
  assert.deepEqual(passkeys.map((one) => one.label), ['key'], 'only the good ceremony enrolled anything');
});

test('the CBOR reader refuses what an authenticator never writes (F12.5)', () => {
  const refuses = (bytes: number[], why: string) =>
    assert.throws(() => decodeCbor(Buffer.from(bytes)), (error: unknown) => isPalugadaError(error, 'mfa.attestation_malformed'), why);
  refuses([0x9f, 0x01, 0xff], 'an indefinite-length array');
  refuses([0xc0, 0x01], 'a tag');
  refuses([0xf9, 0x3c, 0x00], 'a float');
  refuses([0x62, 0xc3, 0x28], 'text that is not UTF-8');
  refuses([0xa2, 0x01, 0x01, 0x01, 0x02], 'a repeated map key');
  refuses([0xa1, 0x40, 0x01], 'a map key that is bytes');
  refuses([0x5a, 0xff, 0xff, 0xff, 0xff], 'bytes longer than what is left');
  refuses([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 'a number past what a double holds');
  refuses(Array.from({ length: 12 }, () => 0x81).concat([0x01]), 'nesting deeper than a passkey');

  assert.deepEqual(decodeCbor(Buffer.from([0x83, 0x01, 0x20, 0x61, 0x61])), { value: [1, -1, 'a'], end: 5 });
  assert.deepEqual(decodeCbor(cbor(new Map<number, Encodable>([[1, 2], [-2, Buffer.from([7])]]))).value, new Map<number | string, unknown>([[1, 2], [-2, Buffer.from([7])]]));
});

/**
 * A passkey belongs to a site, and the site is where the owner opens the
 * console. The deployment already knows that address -- notifications link to
 * it -- so passkeys follow it, and the two settings that name the relying
 * party outright still win. Before, an unset PALUGADA_RP_ID meant `localhost`
 * on every deployment, and a passkey could not be made anywhere else.
 */
test('passkeys are made for the address the console is published at, unless named outright (F12.5)', async () => {
  const { start } = await import('../../src/main.ts');
  const relyingParty = async (env: NodeJS.ProcessEnv) => {
    const deployment = await start({ port: 0, env, worker: { idleMs: 60_000 } });
    try {
      const answer = (await (await fetch(`${deployment.url}/api/auth/challenge`)).json()) as Record<string, string>;
      return { rpId: answer.rpId, origin: answer.origin };
    } finally {
      await deployment.stop();
    }
  };

  assert.deepEqual(
    await relyingParty({ PALUGADA_APP_URL_PUBLIC: 'https://console.example.com:8443/palugada' }),
    { rpId: 'console.example.com', origin: 'https://console.example.com:8443' },
  );
  assert.deepEqual(
    await relyingParty({ PALUGADA_APP_URL_PUBLIC: 'https://console.example.com', PALUGADA_RP_ID: 'example.com' }),
    { rpId: 'example.com', origin: 'https://console.example.com' },
    'a passkey for the whole domain, used from the console',
  );
  assert.deepEqual(
    await relyingParty({ PALUGADA_RP_ID: 'palugada.internal' }),
    { rpId: 'palugada.internal', origin: 'https://palugada.internal' },
  );
  assert.deepEqual(
    await relyingParty({ PALUGADA_APP_URL_PUBLIC: 'https://console.example.com', PALUGADA_ORIGIN: 'https://console.example.com:9000' }),
    { rpId: 'console.example.com', origin: 'https://console.example.com:9000' },
  );
});
