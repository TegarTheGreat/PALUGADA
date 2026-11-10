/**
 * The first owner, without a secret in the environment (F12.5).
 *
 * Signing in takes the owner's authenticator, and the first one came only
 * from `PALUGADA_OWNER_TOTP_REF`: `npm run setup` or `npm run totp:new`
 * made a base32 secret, the operator put it in the environment and added it
 * to a phone. A platform that runs the image -- Coolify, Dokploy -- has no
 * terminal to run those in, and generates passwords, not base32. So a
 * deployment with no owner prints a link when it starts, whoever holds the
 * log holds the machine already, and whoever opens the link first adds the
 * one authenticator and is signed in. The link is good once, for a day, and
 * for nothing once the deployment has an owner by any road.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { DeploymentSecretManager, masterKeyFrom, type MasterKey } from '../../src/settings/store.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { OwnerMfa, TOTP_STEP_SECONDS, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { openOwnerClaim, CLAIM_TTL_MS } from '../../src/owner/claim.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function call(url: string, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

/** A console on a deployment that seals what the owner saves, as a real one does, and has no owner yet. */
async function unownedConsole() {
  const key = randomBytes(32);
  const master: MasterKey = { id: masterKeyFrom({ PALUGADA_MASTER_KEY: key.toString('hex') })!.id, key, source: 'test' };
  const plain = new InMemorySecretManager();
  const secrets = new DeploymentSecretManager(plain, () => master);
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local', now: at });
  const api = new OwnerApi({
    mfa,
    secrets,
    deploymentSettings: { baseEnv: {}, env: {}, settings: {}, master: () => master, secrets },
  });
  const { url } = await api.listen();
  return {
    url, mfa, plain,
    /** The code an authenticator app shows for `secret`, a step later each time so none is a replay. */
    code: (secret: string) => {
      steps += 1;
      return totpCode(decodeBase32(secret), stepFor(at()));
    },
    close: () => api.close(),
  };
}

test('a deployment with no owner makes a link; whoever opens it adds the one authenticator and is signed in', async () => {
  const owner = await unownedConsole();
  try {
    // The sign-in page can say why nothing it offers will work yet.
    assert.equal((await call(owner.url, 'GET', '/api/auth/challenge')).body.claimable, true);

    const code = await openOwnerClaim();
    assert.ok(code && /^[A-Z2-7]{32}$/.test(code), `a code of 160 random bits: ${code}`);
    const { rows: kept } = await withControlPlane((tx) => tx.query<{ code_hash: string }>('SELECT code_hash FROM owner_claims'));
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0]!.code_hash, code, 'the code is kept only as its hash');

    // A guess is refused, and says nothing about whether a claim is open.
    const guessed = await call(owner.url, 'POST', '/api/auth/claim', { body: { code: 'A'.repeat(32) } });
    assert.equal(guessed.status, 401, JSON.stringify(guessed.body));

    // The link opened: a new secret, as a QR code and as text for a phone that cannot scan.
    const opened = await call(owner.url, 'POST', '/api/auth/claim', { body: { code } });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const secret = String(opened.body.secret);
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(String(opened.body.uri).startsWith('otpauth://totp/') && String(opened.body.uri).includes(`secret=${secret}`));
    const qr = opened.body.qr as string[];
    assert.ok(qr.length >= 21 && qr.every((row) => row.length === qr.length && /^[01]+$/.test(row)), 'a square of modules');
    // The secret is this opening's, and the page that showed it says which (B3).
    const offer = String(opened.body.offer);
    assert.match(offer, /^[A-Za-z0-9_-]{22}$/);
    // Nothing is kept until the owner proves the app has it.
    const sealedNow = async () => (await withControlPlane((tx) => tx.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM deployment_secrets'))).rows;
    assert.equal((await sealedNow()).length, 0);

    // A code from another secret proves nothing.
    const wrong = await call(owner.url, 'POST', '/api/auth/claim/confirm', { body: { code, offer, totp: owner.code(newTotpSecret('x').secret) } });
    assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
    assert.equal((await owner.mfa.enrolled()).length, 0, 'nothing is enrolled on a wrong code');

    // The code the phone shows: the authenticator is the owner's, and they are in.
    // The console names the authenticator in the owner's language; the
    // server's English default would show under "Owner" in every language.
    const confirmed = await call(owner.url, 'POST', '/api/auth/claim/confirm', { body: { code, offer, totp: owner.code(secret), label: ' Aplikasi autentikator ' } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.device, 'Aplikasi autentikator');
    const token = String(confirmed.body.token);
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token })).status, 200, 'a session like any other');
    const enrolled = await owner.mfa.enrolled();
    assert.deepEqual(enrolled.map((factor) => [factor.kind, factor.secretRef?.startsWith('db://'), factor.label]), [['totp', true, 'Aplikasi autentikator']]);
    // Sealed, as every secret the owner saves: nothing in the database reads as the secret.
    const sealed = await sealedNow();
    assert.equal(sealed.length, 1);
    assert.ok(!sealed[0]!.ciphertext.toString('latin1').includes(secret));

    // And it signs in again later, as the device it now is.
    const again = await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code(secret) } });
    assert.equal(again.status, 200, JSON.stringify(again.body));

    // The link is spent, and no new one is made: the deployment has an owner.
    assert.equal((await call(owner.url, 'POST', '/api/auth/claim', { body: { code } })).status, 401);
    assert.equal((await call(owner.url, 'POST', '/api/auth/claim/confirm', { body: { code, offer, totp: owner.code(secret) } })).status, 401);
    assert.equal(await openOwnerClaim(), null);
    assert.equal((await call(owner.url, 'GET', '/api/auth/challenge')).body.claimable, false);
  } finally {
    await owner.close();
  }
});

test('a link lasts a day, and is worth nothing once the deployment has an owner by another road', async () => {
  const owner = await unownedConsole();
  try {
    // Made a day and a minute ago: expired.
    const stale = await openOwnerClaim(new Date(Date.now() - CLAIM_TTL_MS - 60_000));
    assert.ok(stale);
    assert.equal((await call(owner.url, 'POST', '/api/auth/claim', { body: { code: stale } })).status, 401);

    // Two starts, two links, both good until one is used: replicas start together.
    const first = await openOwnerClaim();
    const second = await openOwnerClaim();
    assert.ok(first && second && first !== second);
    const opened = await call(owner.url, 'POST', '/api/auth/claim', { body: { code: first } });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    // The operator enrols the owner's phone from the environment after all.
    const { secret } = newTotpSecret('owner phone');
    owner.plain.set('vault://owner/totp', secret);
    await owner.mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

    // Neither link can add a second owner now, even the one already opened.
    const late = await call(owner.url, 'POST', '/api/auth/claim/confirm', {
      body: { code: first, offer: opened.body.offer, totp: owner.code(String(opened.body.secret)) },
    });
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.match(String(late.body.error), /already has an owner/);
    assert.equal((await call(owner.url, 'POST', '/api/auth/claim', { body: { code: second } })).status, 409);
    assert.deepEqual((await owner.mfa.enrolled()).map((factor) => factor.label), ['owner phone']);
  } finally {
    await owner.close();
  }
});

/**
 * B3 (the audit of 30 September, open on 2 October). The secret a claim link
 * offered was derived from the claim alone, so everyone who opened the link
 * was shown the same one -- by design, so that a laptop and then a phone
 * would agree. Whoever saw the link before the owner, in a log or over a
 * shoulder, kept a copy of what became the owner's one authenticator, and
 * could sign in and approve as the owner for as long as it stood, with
 * nothing to show that anyone had.
 */
test('every opening of a claim link is shown its own secret, and only the page that showed one can make it the owner\'s (B3)', async () => {
  const owner = await unownedConsole();
  try {
    const code = (await openOwnerClaim())!;
    // Someone reads the link in the log and opens it first.
    const theirs = (await call(owner.url, 'POST', '/api/auth/claim', { body: { code } })).body;
    // Then the owner.
    const mine = (await call(owner.url, 'POST', '/api/auth/claim', { body: { code } })).body;
    assert.notEqual(mine.secret, theirs.secret, 'a secret of its own');
    assert.notEqual(mine.offer, theirs.offer);

    // A code from one opening does not confirm another's.
    const crossed = await call(owner.url, 'POST', '/api/auth/claim/confirm', { body: { code, offer: mine.offer, totp: owner.code(String(theirs.secret)) } });
    assert.equal(crossed.status, 401, JSON.stringify(crossed.body));
    // Nor does a page that names no opening, or one made up.
    for (const offer of [undefined, 'not-an-offer', 'A'.repeat(22)]) {
      const refused = await call(owner.url, 'POST', '/api/auth/claim/confirm', { body: { code, offer, totp: owner.code(String(mine.secret)) } });
      assert.equal(refused.status, 401, `${offer}: ${JSON.stringify(refused.body)}`);
    }
    assert.equal((await owner.mfa.enrolled()).length, 0);

    // The owner's own: confirmed, and what the earlier opener holds signs nobody in.
    const confirmed = await call(owner.url, 'POST', '/api/auth/claim/confirm', { body: { code, offer: mine.offer, totp: owner.code(String(mine.secret)) } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal((await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code(String(theirs.secret)) } })).status, 401);
    assert.equal((await call(owner.url, 'POST', '/api/auth/sign-in', { body: { totp: owner.code(String(mine.secret)) } })).status, 200);
  } finally {
    await owner.close();
  }
});
