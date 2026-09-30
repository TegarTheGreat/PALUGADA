/**
 * Recovery codes: the way back in when the owner's phone is gone (F12.5).
 *
 * PALUGADA has one human, and their authenticator is the only way in. Losing
 * the phone meant an operator at the server's shell making a new secret --
 * and an owner travelling with only a laptop has no shell. GitHub, Google and
 * every bank answer this the same way: codes written down on the day the
 * factor was set up, each good once.
 *
 * What these hold is how little a code can do. It signs in, adds a device,
 * takes the lost one off, and makes new codes. It approves nothing and
 * loosens nothing: a sheet of paper in a drawer is weaker than a phone behind
 * a fingerprint, and a tier 3 action still waits for a device (F10.10).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { OwnerMfa, TOTP_STEP_SECONDS, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { isPalugadaError } from '../../src/errors.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { authenticator } from '../helpers/passkey.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const RP_ID = 'palugada.local';
const ORIGIN = 'https://palugada.local';

async function call(url: string, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

async function codesFor(owner: Awaited<ReturnType<typeof consoleWithCode>>): Promise<{ token: string; codes: string[] }> {
  const token = String((await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code() } })).body.token);
  const made = await call(owner.url, 'POST', '/api/mfa/recovery-codes', { token, body: { proof: { totp: owner.code() } } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return { token, codes: made.body.codes as string[] };
}

test('the owner makes ten recovery codes with their factor; they are shown once and kept only as hashes', async () => {
  const owner = await consoleWithCode();
  try {
    const token = String((await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code() } })).body.token);
    const unproven = await call(owner.url, 'POST', '/api/mfa/recovery-codes', { token, body: {} });
    assert.equal(unproven.status, 403, 'a browser left signed in cannot make itself a way back in');

    const { codes } = await codesFor(owner);
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) assert.match(code, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/, 'eighty bits, readable');

    const listed = await call(owner.url, 'GET', '/api/mfa/authenticators', { token });
    const recovery = listed.body.authenticators.find((one: { kind: string }) => one.kind === 'recovery');
    assert.deepEqual({ label: recovery.label, left: recovery.left }, { label: 'Recovery codes', left: 10 });
    assert.ok(!JSON.stringify(listed.body).includes(codes[0]!), 'never shown again');

    const stored = await withControlPlane((tx) => tx.query<{ code_hash: string }>('SELECT code_hash FROM owner_recovery_codes'));
    assert.equal(stored.rows.length, 10);
    assert.ok(stored.rows.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash)));
    assert.ok(!stored.rows.some((row) => codes.some((code) => row.code_hash.includes(code.replace(/-/g, '')))));

    // New codes replace the old ones: a sheet the owner threw away stops working.
    const again = await call(owner.url, 'POST', '/api/mfa/recovery-codes', { token, body: { proof: { totp: owner.code() } } });
    assert.equal(again.status, 200);
    const old = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { recovery: codes[0] } });
    assert.equal(old.status, 401);
    const fresh = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { recovery: (again.body.codes as string[])[0] } });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  } finally {
    await owner.close();
  }
});

test('with the phone gone, a code signs in once, adds a passkey, and takes the lost phone off', async () => {
  const owner = await consoleWithCode();
  try {
    const { codes } = await codesFor(owner);

    // Typed from paper: upper case, spaces for dashes, a space at the end.
    const typed = `${codes[0]!.toUpperCase().replace(/-/g, ' ')} `;
    const signedIn = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { recovery: typed } });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.factor, 'recovery', 'the console knows to ask for a new device');
    const token = String(signedIn.body.token);
    const reused = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { recovery: codes[0] } });
    assert.equal(reused.status, 401);
    assert.equal(reused.body.code, 'mfa.replayed', 'each code works once');

    // A new passkey on the laptop, proved with another code.
    const laptop = authenticator({ rpId: RP_ID, origin: ORIGIN });
    const options = await call(owner.url, 'GET', '/api/mfa/passkeys/options', { token });
    const added = await call(owner.url, 'POST', '/api/mfa/passkeys', {
      token, body: { label: 'Laptop', credential: laptop.register({ challenge: options.body.challenge }), proof: { recovery: codes[1] } },
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));

    // And the lost phone off, with a third.
    const listed = await call(owner.url, 'GET', '/api/mfa/authenticators', { token });
    const phoneId = listed.body.authenticators.find((one: { kind: string }) => one.kind === 'totp').id;
    const revoked = await call(owner.url, 'POST', `/api/mfa/authenticators/${phoneId}/revoke`, { token, body: { proof: { recovery: codes[2] } } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const left = (await call(owner.url, 'GET', '/api/mfa/authenticators', { token })).body.authenticators;
    assert.deepEqual(left.map((one: { kind: string }) => one.kind), ['recovery', 'webauthn']);
    assert.equal(left.find((one: { kind: string }) => one.kind === 'recovery').left, 7);

    // Every attempt is on the record an auditor reads.
    const record = await withControlPlane((tx) => tx.query<{ kind: string; succeeded: boolean; purpose: string }>(
      "SELECT kind, succeeded, purpose FROM owner_authentications WHERE kind = 'recovery' ORDER BY occurred_at"));
    assert.deepEqual(record.rows.map((row) => [row.purpose, row.succeeded]), [
      ['owner.sign_in', true], ['owner.sign_in', false], ['console.add a passkey', true], ['console.revoke an authenticator', true],
    ]);
  } finally {
    await owner.close();
  }
});

test('a code never approves, never loosens a rule, and never leaves codes as the only way in (F10.10)', async () => {
  const owner = await consoleWithCode();
  try {
    const { token, codes } = await codesFor(owner);
    const fixture = await createCompany('recovery-approves-nothing');
    const itemId = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'payment.send', tier: 3,
      actionSummary: 'Pay the supplier', rationale: 'Invoice verified', consequenceIfDenied: 'Unpaid',
    });
    const approved = await call(owner.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`, {
      token, body: { decision: 'approve', note: '', proof: { recovery: codes[0] } },
    });
    assert.equal(approved.status, 403, JSON.stringify(approved.body));
    assert.match(String(approved.body.error), /a recovery code signs you in and adds a device; it does not approve/);
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'still the owner\'s to decide, with a device');

    await assert.rejects(
      owner.mfa.verifyRecoveryCode(codes[1]!, { purpose: 'console.stop every company' }),
      (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
    );

    // The phone is the only device: taking it off would leave codes that can approve nothing.
    const listed = await call(owner.url, 'GET', '/api/mfa/authenticators', { token });
    const phoneId = listed.body.authenticators.find((one: { kind: string }) => one.kind === 'totp').id;
    const refused = await call(owner.url, 'POST', `/api/mfa/authenticators/${phoneId}/revoke`, { token, body: { proof: { recovery: codes[2] } } });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /only authenticator/);

    // The codes themselves can be taken off, with the phone.
    const recoveryId = listed.body.authenticators.find((one: { kind: string }) => one.kind === 'recovery').id;
    const off = await call(owner.url, 'POST', `/api/mfa/authenticators/${recoveryId}/revoke`, { token, body: { proof: { totp: owner.code() } } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await call(owner.url, 'POST', '/api/auth/sign-in', { body: { recovery: codes[3] } })).status, 401);
  } finally {
    await owner.close();
  }
});
