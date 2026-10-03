/**
 * The owner's console (PRD v2 F10, F12.5).
 *
 * §5 principle 1 gives this platform one human interface: an inbox of
 * decisions. Everything before this built the decisions and the rules about
 * them and left the surface for later -- so a platform whose whole premise is
 * "one person runs many companies" had no way for that person to say yes.
 *
 * These run against the real server on loopback, over real HTTP, because
 * everything that can be wrong at this layer is on the wire: who may reach a
 * route, what a refusal looks like, whether a session is mistaken for a second
 * factor, and whether a path can be walked out of.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi, type OwnerApiOptions } from '../../src/owner/api.ts';
import { CharterRepository } from '../../src/governance/charter-repository.ts';
import { AdapterRegistry, type Adapter } from '../../src/runtime/protocol.ts';
import { rollBack } from '../../src/governance/rollback.ts';
import { withControlPlane, withTenant as withTenantTx } from '../../src/db/tenant.ts';
import {
  OwnerMfa,
  TOTP_STEP_SECONDS,
  decodeBase32,
  newTotpSecret,
  stepFor,
  totpCode,
} from '../../src/owner/mfa.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { clearStopAll, isStopAllRequested } from '../../src/engine/control.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { criteriaIn, reportOn } from '../helpers/done.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** The console, its verifier, and a way to mint a fresh code. */
async function console_(extra: Partial<OwnerApiOptions> = {}): Promise<{
  api: OwnerApi;
  url: string;
  code: () => string;
  /** Enrols a second device and returns its code source. */
  secondDevice: (label: string) => Promise<{ id: string; code: () => string }>;
  close: () => Promise<void>;
}> {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  // A clock the test moves, rather than codes that walk past the drift window.
  //
  // A TOTP code cannot be used twice -- `last_step` must strictly increase --
  // so a test needs a fresh step per call, and the first version got one by
  // adding to the step number. That works twice: `TOTP_DRIFT_STEPS` is one, so
  // step+2 is outside the window and the third code in a test is rejected as
  // invalid. Which is the platform being right and the helper being wrong: a
  // test that needs four codes needs four *minutes*, and the way to have those
  // without waiting is to move the clock the verifier reads.
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local', now: at });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  // A signing secret for triggers the sender signs (0056), where the
  // deployment's store would keep it.
  secrets.set('vault://hooks/signing', 'hook-signing-secret-for-tests');
  const api = new OwnerApi({ mfa, secrets, ...extra });
  const { url } = await api.listen();
  return {
    api,
    url,
    code: () => {
      steps += 1;
      return totpCode(decodeBase32(secret), stepFor(at()));
    },
    secondDevice: async (label) => {
      const other = newTotpSecret(label).secret;
      secrets.set(`vault://owner/${label}`, other);
      const id = await mfa.enrolTotp({ label, secretRef: `vault://owner/${label}` });
      return {
        id,
        code: () => {
          steps += 1;
          return totpCode(decodeBase32(other), stepFor(at()));
        },
      };
    },
    close: () => api.close(),
  };
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  url: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Answer> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    // A body only where one is allowed: `fetch` refuses to put one on a GET,
    // and a helper that tried would fail the test for its own reason.
    ...(options.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

async function signIn(url: string, code: string): Promise<string> {
  const answer = await call(url, 'POST', '/api/auth/sign-in', { body: { totp: code } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return String(answer.body.token);
}

async function tier3(fixture: Fixture, summary = 'Wire the payment'): Promise<string> {
  return inbox.requestApproval({
    companyId: fixture.companyId,
    capabilityName: 'payment.send',
    tier: 3,
    actionSummary: summary,
    rationale: 'The invoice is verified.',
    consequenceIfDenied: 'The supplier is not paid.',
  });
}

/* ------------------------------------------------------------ signing in --- */

/**
 * There are no accounts, so signing in is presenting a second factor.
 *
 * That is not a shortcut: PALUGADA has exactly one human, so an identity
 * system would be a table with one row in it and a password to lose. What
 * matters is whether the person holds an enrolled device, and `OwnerMfa`
 * already answers that against arithmetic rather than against a claim.
 */
test('signing in means presenting a second factor (F12.5)', async () => {
  const owner = await console_();
  try {
    const refused = await call(owner.url, 'POST', '/api/auth/sign-in', {
      body: { totp: '000000' },
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'mfa.code_invalid');

    const accepted = await call(owner.url, 'POST', '/api/auth/sign-in', {
      body: { totp: owner.code() },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.device, 'owner phone');
    assert.ok(String(accepted.body.token).length > 20);
  } finally {
    await owner.close();
  }
});

/**
 * The factor's own lockout is global, so on its own it let anyone who could
 * reach the console keep the owner out with ten wrong codes a quarter hour.
 * One address is stopped at five, before its guesses reach the factor.
 */
const signInFrom = (owner: Awaited<ReturnType<typeof console_>>, address: string, totp: string) =>
  fetch(`${owner.url}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.1, ${address}` },
    body: JSON.stringify({ totp }),
  }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }));

test('one address that keeps guessing is stopped before it can lock the owner out', async () => {
  const from = signInFrom;
  const proxied = await console_({ behindProxy: true });
  try {
    for (let guess = 0; guess < 5; guess += 1) {
      assert.equal((await from(proxied, '203.0.113.9', '000000')).body.code, 'mfa.code_invalid');
    }
    const stopped = await from(proxied, '203.0.113.9', proxied.code());
    assert.equal(stopped.status, 429);
    assert.equal(stopped.body.code, 'owner.throttled', 'even the right code, from there');
    const owner = await from(proxied, '198.51.100.7', proxied.code());
    assert.equal(owner.status, 200, 'and the owner, elsewhere, is not locked out: the factor counted five, not ten');
  } finally {
    await proxied.close();
  }
});

test('without a proxy in front, a forwarded address is the caller\'s own words and buys no fresh count', async () => {
  const from = signInFrom;
  const direct = await console_();
  try {
    for (let guess = 0; guess < 5; guess += 1) await from(direct, `192.0.2.${guess}`, '000000');
    assert.equal((await from(direct, '192.0.2.99', direct.code())).body.code, 'owner.throttled');
  } finally {
    await direct.close();
  }
});

/**
 * Every route that touches a company needs a session, and the test names them
 * one by one.
 *
 * A single "an unauthenticated request is refused" would pass with any one of
 * these left open, and the one left open would be the one somebody added last.
 */
test('no route reaches a company without a session (F12.5)', async () => {
  const fixture = await createCompany('api-auth');
  const owner = await console_();
  try {
    const guarded: Array<[string, string]> = [
      ['GET', '/api/companies'],
      ['GET', `/api/companies/${fixture.companyId}/inbox`],
      ['GET', `/api/companies/${fixture.companyId}/digest`],
      ['GET', `/api/companies/${fixture.companyId}/retro`],
      ['GET', '/api/control'],
      ['GET', '/api/mfa/authenticators'],
      ['GET', '/api/mfa/challenge'],
      ['POST', '/api/control/stop-all'],
      ['POST', `/api/control/company/${fixture.companyId}/freeze`],
      ['POST', '/api/control/capability/dns.read/kill'],
      ['POST', '/api/auth/sign-out'],
    ];

    for (const [method, path] of guarded) {
      const answer = await call(owner.url, method, path, { body: {} });
      assert.equal(answer.status, 401, `${method} ${path} is reachable without a session`);
      assert.equal(answer.body.code, 'owner.unauthenticated');
    }

    // A token that is not one, and one that has been signed out.
    const token = await signIn(owner.url, owner.code());
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token })).status, 200);
    assert.equal(
      (await call(owner.url, 'GET', '/api/companies', { token: 'not-a-token' })).status,
      401,
    );
    await call(owner.url, 'POST', '/api/auth/sign-out', { token, body: {} });
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token })).status, 401);
  } finally {
    await owner.close();
  }
});

/* ----------------------------------------------------------------- F10.1 --- */

test('the inbox is one queue, grouped per company (F10.1, F10.2)', async () => {
  const acme = await createCompany('api-acme');
  const other = await createCompany('api-other');
  const owner = await console_();
  try {
    await tier3(acme, 'Wire the payment');
    await inbox.raiseIncident({
      companyId: other.companyId,
      title: 'The gateway is down',
      detail: 'Three attempts.',
    });

    const token = await signIn(owner.url, owner.code());

    const list = await call(owner.url, 'GET', '/api/companies', { token });
    assert.equal((list.body.companies as unknown[]).length, 2);

    const acmeInbox = await call(
      owner.url, 'GET', `/api/companies/${acme.companyId}/inbox`, { token },
    );
    const items = acmeInbox.body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    // F10.2: what, why, tier, cost, and what happens if it is refused. An
    // approval the owner cannot judge from the card is one they will rubber
    // stamp.
    assert.equal(items[0]!.actionSummary, 'Wire the payment');
    assert.equal(items[0]!.rationale, 'The invoice is verified.');
    assert.equal(items[0]!.tier, 3);
    assert.equal(items[0]!.consequenceIfDenied, 'The supplier is not paid.');

    // And the other company's incident is not in it. Row-level security does
    // this, and asserting it here is asserting that the console did not route
    // around it.
    const otherInbox = await call(
      owner.url, 'GET', `/api/companies/${other.companyId}/inbox`, { token },
    );
    assert.equal((otherInbox.body.items as unknown[]).length, 1);
    assert.equal((otherInbox.body.items as Array<Record<string, unknown>>)[0]!.kind, 'incident');
  } finally {
    await owner.close();
  }
});

/* --------------------------------------------------------- F10.10, F12.5 --- */

/**
 * The distinction the whole console turns on.
 *
 * A session is possession of a browser tab. F10.10 asks a tier 3 approval to
 * be given "through the app **with MFA**", and a token minted this morning is
 * not that. So a signed-in owner still has to present a fresh factor for tier
 * 3, and the console does not get to decide otherwise -- the gate is in
 * `decide`, where every surface meets it.
 */
test('a session is not a second factor (F10.10, F12.5)', async () => {
  const fixture = await createCompany('api-tier3');
  const owner = await console_();
  try {
    const itemId = await tier3(fixture);
    const token = await signIn(owner.url, owner.code());

    // Signed in, and refused: the session says which pipe, not who.
    const withoutProof = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`,
      { token, body: { decision: 'approve', note: 'go' } },
    );
    assert.equal(withoutProof.status, 403);
    assert.equal(withoutProof.body.code, 'approval.channel_forbidden');

    // A wrong code is refused with the reason it failed, not flattened into
    // "forbidden" -- an owner who mistyped needs to know that is what happened.
    const wrongCode = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`,
      { token, body: { decision: 'approve', proof: { totp: '000000' } } },
    );
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.body.code, 'mfa.code_invalid');

    // With the factor: through.
    const approved = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`,
      { token, body: { decision: 'approve', note: 'go', proof: { totp: owner.code() } } },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await owner.close();
  }
});

/**
 * A tier 2 decision needs no second factor, and the console must not invent
 * one.
 *
 * F10.10 is about tier 3. A console that demanded a code for everything would
 * make the owner reach for their phone to answer a question, and an owner who
 * stops answering questions is an owner whose companies stall.
 */
test('a decision below tier 3 needs only the session (F10.2, F10.3)', async () => {
  const fixture = await createCompany('api-tier2');
  const owner = await console_();
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId,
      title: 'Which supplier did you mean?',
      detail: 'Two match the description.',
    });
    const token = await signIn(owner.url, owner.code());

    const answered = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`,
      { token, body: { decision: 'deny', note: 'neither' } },
    );
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await owner.close();
  }
});

test('a decision that is not one of the three is refused by name', async () => {
  const fixture = await createCompany('api-bad-decision');
  const owner = await console_();
  try {
    const itemId = await tier3(fixture);
    const token = await signIn(owner.url, owner.code());
    const answer = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`,
      { token, body: { decision: 'delete' } },
    );
    assert.equal(answer.status, 400);
    assert.match(String(answer.body.error), /approve, deny or ask/);
  } finally {
    await owner.close();
  }
});

/* ----------------------------------------------------------------- F11.2 --- */

/**
 * F11.2: the trace behind an inbox item, in at most two hops.
 *
 * The list gives an id; this gives what happened. A console that made the
 * owner search for the run behind a decision would be one where nobody looks,
 * and an approval nobody investigates is a rubber stamp with extra steps.
 */
test('the trace behind an item is one hop from the item (F11.2)', async () => {
  const fixture = await createCompany('api-trace');
  const owner = await console_();
  try {
    const itemId = await tier3(fixture);
    const token = await signIn(owner.url, owner.code());

    const trace = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/inbox/${itemId}/trace`, { token },
    );
    assert.equal(trace.status, 200);
    assert.equal(trace.body.itemId, itemId);
    assert.equal(trace.body.tier, 3);
    // This approval is not about a task, so the answer explains itself rather
    // than being an empty object the owner has to interpret.
    assert.ok(typeof trace.body.reason === 'string' || Array.isArray(trace.body.runs));

    const missing = await call(
      owner.url,
      'GET',
      `/api/companies/${fixture.companyId}/inbox/11111111-2222-3333-4444-555555555555/trace`,
      { token },
    );
    assert.equal(missing.status, 400);
  } finally {
    await owner.close();
  }
});

/* ------------------------------------------------------------ F10.6, F9.4 --- */

test('the digest and the retro are one call each (F10.6, F9.4)', async () => {
  const fixture = await createCompany('api-digest');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const digest = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/digest`, { token },
    );
    assert.equal(digest.status, 200);
    assert.equal(digest.body.companyId, fixture.companyId);
    // F10.6's one-screen limit is a property of the data, so the API cannot
    // hand back something a screen could not hold.
    assert.ok((digest.body.highlights as unknown[]).length <= 5);

    const retro = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/retro`, { token },
    );
    assert.equal(retro.status, 200);
  } finally {
    await owner.close();
  }
});

/* ----------------------------------------------------------------- F10.7 --- */

/**
 * The global buttons, and the half that is usually forgotten: undoing them.
 *
 * A stop the owner cannot lift without a database console is a stop they will
 * hesitate to press, and hesitating is exactly the failure F10.7 exists to
 * remove.
 */
test('stop-all is reachable and reversible from the console (F10.7)', async () => {
  const fixture = await createCompany('api-control');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const stopped = await call(owner.url, 'POST', '/api/control/stop-all', {
      token, body: { on: true },
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stopAll, true);
    assert.equal(await isStopAllRequested(), true);

    const state = await call(owner.url, 'GET', '/api/control', { token });
    assert.equal(state.body.stopAll, true);

    // Pressing it takes the session; lifting it takes the authenticator, so
    // whoever stole a session cannot undo the stop pressed because of them.
    const unproven = await call(owner.url, 'POST', '/api/control/stop-all', {
      token, body: { on: false },
    });
    assert.equal(unproven.status, 403, JSON.stringify(unproven.body));
    assert.equal(await isStopAllRequested(), true, 'still stopped');
    const lifted = await call(owner.url, 'POST', '/api/control/stop-all', {
      token, body: { on: false, proof: { totp: owner.code() } },
    });
    assert.equal(lifted.body.stopAll, false);
    assert.equal(await isStopAllRequested(), false);

    // And the narrower ones answer the same way: stopping on the session,
    // starting again on the factor.
    for (const path of [
      `/api/control/company/${fixture.companyId}/freeze`,
      '/api/control/capability/dns.read/kill',
    ]) {
      assert.equal(
        (await call(owner.url, 'POST', path, { token, body: { on: true } })).status,
        200,
        path,
      );
      assert.equal(
        (await call(owner.url, 'POST', path, { token, body: { on: false } })).status,
        403,
        `${path} is not undone by a session alone`,
      );
      assert.equal(
        (await call(owner.url, 'POST', path, {
          token, body: { on: false, proof: { totp: owner.code() } },
        })).status,
        200,
        path,
      );
    }
  } finally {
    await clearStopAll();
    await owner.close();
  }
});

/**
 * Every control that loosens asks for the authenticator; every one that
 * tightens does not.
 *
 * A session is a bearer token in a browser. The owner presses stop, freezes,
 * kills and lowers with one -- the moment something looks wrong is not the
 * moment to go looking for a phone -- but a session that could also lift the
 * stop, unfreeze, revive a capability, raise a ceiling, rewrite a policy or
 * activate a skill could undo every one of those, and would be the most
 * valuable thing on the machine to steal.
 */
test('a session alone can tighten any control and loosen none (F12.5, F10.7)', async () => {
  const fixture = await createCompany('api-loosening');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const company = `/api/companies/${fixture.companyId}`;
    const loosening: Array<[string, Record<string, unknown>]> = [
      ['/api/control/stop-all', { on: false }],
      [`/api/control/company/${fixture.companyId}/freeze`, { on: false }],
      ['/api/control/capability/dns.read/kill', { on: false }],
      [`/api/control/company/${fixture.companyId}/role/${fixture.roleId}/resume`, {}],
      [`${company}/spend/limit`, { moneyMaxCents: 10_000_000 }],
      [`${company}/spend/resume`, {}],
      ['/api/policies', {
        slug: 'quiet', effect: 'deny', companyId: fixture.companyId, mode: 'log_only',
        condition: { field: 'tier', op: 'gte', value: 2 },
      }],
      [`${company}/skills/versions/${fixture.roleId}/approve`, {}],
      [`${company}/charter`, { body: 'Anything goes.' }],
      ['/api/control/charter', { body: 'Anything goes.' }],
    ];
    for (const [path, body] of loosening) {
      const answer = await call(owner.url, 'POST', path, { token, body });
      assert.equal(answer.status, 403, `${path}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.code, 'approval.channel_forbidden', path);
    }

    const tightening: Array<[string, Record<string, unknown>]> = [
      [`/api/control/company/${fixture.companyId}/freeze`, { on: true }],
      ['/api/control/capability/dns.read/kill', { on: true }],
      [`${company}/spend/limit`, { moneyMaxCents: 1 }],
    ];
    for (const [path, body] of tightening) {
      const answer = await call(owner.url, 'POST', path, { token, body });
      assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
    }
  } finally {
    await clearStopAll();
    await owner.close();
  }
});

/**
 * A lost phone is revoked from a phone the owner still has, and whatever the
 * lost one signed in to ends with it. The last device is not revocable: with
 * none, nothing could sign in or approve anything again.
 */
test('revoking a lost device ends its sessions, and the last device stays (F12.5)', async () => {
  const owner = await console_();
  try {
    const lostToken = await signIn(owner.url, owner.code());
    const spare = await owner.secondDevice('spare');
    const spareToken = await signIn(owner.url, spare.code());
    const devices = await call(owner.url, 'GET', '/api/mfa/authenticators', { token: spareToken });
    const lost = (devices.body.authenticators as Array<{ id: string; label: string }>)
      .find((one) => one.label === 'owner phone')!;

    const unproven = await call(owner.url, 'POST', `/api/mfa/authenticators/${lost.id}/revoke`, {
      token: spareToken, body: {},
    });
    assert.equal(unproven.status, 403, 'revoking takes a factor');
    const revoked = await call(owner.url, 'POST', `/api/mfa/authenticators/${lost.id}/revoke`, {
      token: spareToken, body: { proof: { totp: spare.code() } },
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.signedOut, 1);
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token: lostToken })).status, 401,
      'the lost phone\'s session ended with it');
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token: spareToken })).status, 200);

    const last = await call(owner.url, 'POST', `/api/mfa/authenticators/${spare.id}/revoke`, {
      token: spareToken, body: { proof: { totp: spare.code() } },
    });
    assert.equal(last.status, 400, JSON.stringify(last.body));
    assert.match(String(last.body.error), /only authenticator/);

    const everywhere = await call(owner.url, 'POST', '/api/auth/sign-out-everywhere', {
      token: spareToken, body: {},
    });
    assert.equal(everywhere.status, 200);
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token: spareToken })).status, 401);
  } finally {
    await owner.close();
  }
});

/**
 * Two consoles behind one address are one console to the owner.
 *
 * Sessions were held in each process's memory, so a second replica answered
 * "sign in first" to a token the first had just issued, and a device revoked
 * through one process stayed signed in on the other until its session ran
 * out. A session is a row now, stored as the token's hash, and a revocation
 * is checked on every request rather than remembered by whoever made it.
 */
test('a session is known to every console and ends on all of them at once (F12.5)', async () => {
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const { createHash } = await import('node:crypto');
  const owner = await console_();
  const replica = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager(), rpId: 'palugada.local' }),
  });
  const { url: other } = await replica.listen();
  try {
    const token = await signIn(owner.url, owner.code());
    assert.equal((await call(other, 'GET', '/api/companies', { token })).status, 200,
      'signed in on one console, known to the other');

    const stored = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ token_hash: string }>('SELECT token_hash FROM owner_sessions');
      return rows.map((row) => row.token_hash);
    });
    assert.deepEqual(stored, [createHash('sha256').update(token).digest('hex')],
      'the hash is stored, never the token');

    await call(other, 'POST', '/api/auth/sign-out', { token, body: {} });
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token })).status, 401,
      'signed out on the other console, signed out on this one');

    // A session whose time is up is over, and one over for more than a day is
    // swept by the next sign-in rather than kept for ever.
    const stale = await signIn(owner.url, owner.code());
    await withControlPlane((tx) => tx.query(
      `UPDATE owner_sessions
          SET issued_at = now() - interval '3 days', expires_at = now() - interval '2 days'
        WHERE token_hash = $1`,
      [createHash('sha256').update(stale).digest('hex')],
    ));
    assert.equal((await call(other, 'GET', '/api/companies', { token: stale })).status, 401);
    const again = await signIn(owner.url, owner.code());
    const left = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM owner_sessions WHERE token_hash = $1',
        [createHash('sha256').update(stale).digest('hex')],
      );
      return rows[0]!.n;
    });
    assert.equal(left, 0, 'swept');

    // Revoked by a path that tells no console anything -- another process,
    // or the database directly -- and still ended on both.
    await withControlPlane((tx) => tx.query(
      "UPDATE owner_authenticators SET revoked_at = now() WHERE label = 'owner phone'",
    ));
    assert.equal((await call(owner.url, 'GET', '/api/companies', { token: again })).status, 401);
    assert.equal((await call(other, 'GET', '/api/companies', { token: again })).status, 401);
  } finally {
    await replica.close();
    await owner.close();
  }
});

/* ------------------------------------------------- what the pages draw --- */

/**
 * The console picks from the company's own shape instead of asking for ids.
 *
 * Every form in the Structure tab asked for a "Division id" or a "Role id"
 * typed in by hand, because nothing listed them. These routes are what the
 * pages draw from: the structure, the work, what happened, the accounts, the
 * schedules and the devices -- each as the tenant, so another company's rows
 * are not merely filtered out by the page but never sent.
 */
test('the console reads a company\'s shape, work and recent history (F10.1, F10.2)', async () => {
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const { upsertSchedule } = await import('../../src/scheduler/scheduler.ts');
  const { registerDevice } = await import('../../src/gateway/gateway.ts');
  const { generateKeyPairSync } = await import('node:crypto');
  const mine = await createCompany('views-mine');
  const theirs = await createCompany('views-theirs');
  const task = (fixture: Fixture, input: Record<string, unknown>) => createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input, createdBy: 'owner', reserveTokens: 100,
  });

  const running = await task(mine, { goal: 'Reconcile the September ledger' });
  await transition(mine.companyId, running.id, 'running');
  const finished = await task(mine, { title: 'Answer the refund email' });
  await transition(mine.companyId, finished.id, 'running');
  await transition(mine.companyId, finished.id, 'completed', { output: { ok: true } });
  await task(theirs, { goal: 'Somebody else\'s work' });
  await upsertSchedule({
    companyId: mine.companyId, projectId: mine.projectId, divisionId: mine.divisionId,
    roleId: mine.roleId, budgetAccountId: mine.budgetAccountId, goalId: mine.goalId,
    slug: 'nightly-ledger', cronExpression: '0 2 * * *', timezone: 'Asia/Jakarta',
    input: { goal: 'nightly' }, reserveTokens: 100,
  });
  const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const device = await registerDevice({ companyId: mine.companyId, name: 'build box', runtime: 'script', publicKeyPem: pem });

  const owner = await console_();
  const replica = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager(), rpId: 'palugada.local' }),
    deploymentNotes: [
      'bound by the platform: memory.search, skill.read',
      'no push channel: set PALUGADA_PUSH_URL (F10.5)',
      'finished runs go to http://collector:4318/v1/traces as OpenTelemetry spans, without what was said in them',
    ],
  });
  const { url: noted } = await replica.listen();
  try {
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${mine.companyId}`;
    const get = async (path: string) => {
      const answer = await call(owner.url, 'GET', `${base}${path}`, { token });
      assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
      return answer.body as Record<string, any>;
    };

    const structure = await get('/structure');
    assert.deepEqual(structure.divisions.map((d: { id: string }) => d.id), [mine.divisionId]);
    assert.equal(structure.divisions[0].openTasks, 1, 'the running task is open; the finished one is not');
    assert.deepEqual(structure.roles.map((r: { id: string }) => r.id), [mine.roleId]);
    assert.equal(structure.roles[0].doneLastWeek, 1);
    assert.ok(structure.goals.some((g: { id: string }) => g.id === mine.goalId));

    const all = await get('/work');
    assert.deepEqual(all.items.map((t: { id: string }) => t.id).sort(), [running.id, finished.id].sort(),
      'another company\'s task is not sent at all');
    assert.deepEqual(all.counts, { active: 1, waiting: 0, done: 1, stopped: 0 });
    const active = await get('/work?group=active');
    assert.deepEqual(active.items.map((t: { summary: string }) => t.summary), ['Reconcile the September ledger']);
    const done = await get('/work?group=done');
    assert.deepEqual(done.items.map((t: { summary: string }) => t.summary), ['Answer the refund email']);
    const bad = await call(owner.url, 'GET', `${base}/work?group=everything`, { token });
    assert.equal(bad.status, 400);

    const activity = await get('/activity?limit=5');
    assert.ok(activity.items.length > 0 && activity.items.length <= 5);
    const times = activity.items.map((e: { occurredAt: string }) => Date.parse(e.occurredAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    // A dormant role waking to nothing is the platform's rhythm, not news.
    const { appendEvent } = await import('../../src/audit/event-log.ts');
    const { withTenant } = await import('../../src/db/tenant.ts');
    await withTenant(mine.companyId, (tx) => appendEvent(tx, {
      companyId: mine.companyId, type: 'wake.idle', actor: 'system', payload: {},
    }));
    const types = async (path: string) => (await get(path)).items.map((e: { type: string }) => e.type);
    assert.ok(!(await types('/activity')).includes('wake.idle'), 'an idle wake drowned the feed');
    assert.ok((await types('/activity?routine=include')).includes('wake.idle'), 'and is there when asked for');

    // The queue says why and who: the goal chain and the role behind an item.
    await inbox.requestApproval({
      companyId: mine.companyId, taskId: running.id, capabilityName: 'payment.send', tier: 3,
      actionSummary: 'Pay the roaster', rationale: 'Invoice verified.', consequenceIfDenied: 'Unpaid.',
    });
    const queue = await get('/inbox');
    const asked = queue.items.find((item: { taskId: string }) => item.taskId === running.id);
    assert.equal(asked.roleSlug, (structure.roles[0] as { slug: string }).slug);
    assert.ok(asked.goalChain.length >= 1, 'the item says which goal it serves');
    assert.ok(asked.createdAt);

    // How far the running task has got, from its own journal: two steps
    // committed, a third begun.
    const { withTenant: asTenant } = await import('../../src/db/tenant.ts');
    await asTenant(mine.companyId, async (tx) => {
      for (const [index, name, status] of [[0, 'read the ledger', 'committed'], [1, 'match invoices', 'committed'], [2, 'draft the summary', 'started']] as const) {
        await tx.query(
          `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash,
                                   idempotency_key, output, committed_at)
           VALUES ($1, $2, $3, $4, 'tool', $5, 'h', $6, $7, $8)`,
          [running.id, index, mine.companyId, name, status, `k-${index}`,
           status === 'committed' ? '{}' : null, status === 'committed' ? new Date() : null],
        );
      }
    });
    const progress = (await get('/work')).items.find((item: { id: string }) => item.id === running.id).progress;
    assert.equal(progress.stepsDone, 2);
    assert.equal(progress.currentStep, 'draft the summary');
    assert.equal(progress.currentStepStatus, 'started');

    // A goal's progress is its work's, rolled up the ladder: the objective's
    // two tasks, one finished, count for the mission above it too.
    const ladder = (await get('/structure')).goals as Array<{ id: string; parentId: string | null; tasksDone: number; tasksTotal: number }>;
    const objective = ladder.find((goal) => goal.id === mine.goalId)!;
    assert.deepEqual([objective.tasksDone, objective.tasksTotal], [1, 2]);
    const mission = ladder.find((goal) => goal.id === objective.parentId)!;
    assert.deepEqual([mission.tasksDone, mission.tasksTotal], [1, 2], 'the mission counts what is under it');
    assert.equal(typeof (structure.roles[0] as { charter: string }).charter, 'string', 'the role says who it is');

    // What the company knows, with how sure it is.
    const { remember } = await import('../../src/memory/store.ts');
    await asTenant(mine.companyId, async (tx) => {
      await remember(tx, { companyId: mine.companyId, memoryType: 'semantic', scopeType: 'company', body: 'Our roaster ships on Tuesdays', confidence: 0.4, source: 'test' });
      await remember(tx, { companyId: mine.companyId, memoryType: 'procedural', scopeType: 'company', body: 'Refunds over 500k need the owner', confidence: 1, source: 'test' });
    });
    const known = await get('/memories?kind=semantic');
    assert.deepEqual(known.items.map((m: { body: string }) => m.body), ['Our roaster ships on Tuesdays']);
    assert.equal(known.items[0].unverified, true, 'a fact under the confidence line is said to be unverified');
    assert.equal(known.counts.procedural, 1);
    assert.deepEqual((await get('/memories?q=refunds')).items.map((m: { kind: string }) => m.kind), ['procedural']);
    assert.equal((await call(owner.url, 'GET', `${base}/memories?kind=dreams`, { token })).status, 400);

    const accounts = await get('/budget-accounts');
    assert.ok(accounts.accounts.some((a: { id: string }) => a.id === mine.budgetAccountId));

    const schedules = await get('/schedules');
    assert.deepEqual(schedules.schedules.map((s: { slug: string }) => s.slug), ['nightly-ledger']);
    assert.equal(schedules.schedules[0].timezone, 'Asia/Jakarta');

    const devices = await get('/devices');
    assert.deepEqual(devices.devices.map((d: { id: string }) => d.id), [device.id]);
    assert.equal(devices.devices[0].keyFingerprint, device.keyFingerprint);

    // What the deployment is missing, where the owner will see it. The
    // session is the database's, so the other console takes the same token.
    const setup = await call(noted, 'GET', '/api/control/setup', { token });
    assert.equal((setup.body.notes as string[]).length, 3);
    assert.deepEqual(setup.body.todo, ['no push channel: set PALUGADA_PUSH_URL (F10.5)'],
      'what is set up is not on the list of what is not');
    assert.match(String(setup.body.version), /^\d+\.\d+\.\d+/, 'and which version this is, for the owner\'s menu');
  } finally {
    await replica.close();
    await owner.close();
  }
});

test('a task\'s input reads as one line, whatever its shape', async () => {
  const { summarise } = await import('../../src/owner/views.ts');
  assert.equal(summarise({ goal: 'Ship the landing page' }), 'Ship the landing page');
  assert.equal(summarise({ amount: 3, recipient: 'ops@example.test' }), 'ops@example.test');
  assert.equal(summarise({ count: 3 }), '{"count":3}');
  assert.equal(summarise({}), 'No description');
  assert.equal(summarise('x'.repeat(200)).length, 140);
});

/* ------------------------------------------------------------------ F12.5 --- */

/**
 * The console lists the owner's devices and nothing about them worth stealing.
 *
 * A label and a kind is what a screen needs to draw one. The secret reference
 * and the public key are what a compromised browser would want, and neither is
 * any use to the console.
 */
test('the device list carries a label and no key material (F12.5)', async () => {
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const answer = await call(owner.url, 'GET', '/api/mfa/authenticators', { token });
    const devices = answer.body.authenticators as Array<Record<string, unknown>>;

    assert.equal(devices.length, 1);
    assert.deepEqual(Object.keys(devices[0]!).sort(), ['id', 'kind', 'label']);
    assert.ok(!JSON.stringify(answer.body).includes('vault://'));
  } finally {
    await owner.close();
  }
});

/* ---------------------------------------------------------------- the wire --- */

/**
 * A router built from regular expressions is a router where a path segment
 * that is not an id reaches the thing behind it. This one matches segment by
 * segment, and these are the shapes that would slip through if it did not.
 */
test('a path is matched segment by segment, not by pattern', async () => {
  const fixture = await createCompany('api-routing');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    // `/api/../api/companies` is deliberately absent: `fetch` normalises a
    // path before the request leaves, so that case would be testing the
    // client. The raw-socket test below is the one that reaches the server
    // with the dots intact.
    for (const path of [
      '/api/companies/..%2F..%2Fetc%2Fpasswd',
      `/api/companies/${fixture.companyId}/inbox/extra/segments`,
      '/api/companies//inbox',
      '/api/companies/x/inbox/y/trace/z',
    ]) {
      const answer = await call(owner.url, 'GET', path, { token });
      assert.ok(
        answer.status === 404 || answer.status === 400 || answer.status === 401,
        `${path} answered ${answer.status}`,
      );
    }
  } finally {
    await owner.close();
  }
});

test('a body that is not a JSON object is refused rather than coerced', async () => {
  const owner = await console_();
  try {
    for (const raw of ['[]', '"hello"', '{not json']) {
      const response = await fetch(`${owner.url}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      assert.equal(response.status, 400, raw);
    }
  } finally {
    await owner.close();
  }
});

/** A GET sent with a `Host` of the test's choosing, which `fetch` will not send. */
async function getAs(url: string, path: string, host: string): Promise<Answer> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const sent = request(`${url}${path}`, { headers: { host } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // The console's own page, or nothing: the status is what is asked.
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    sent.on('error', reject);
    sent.end();
  });
}

/**
 * DNS rebinding. A page on a name the attacker owns, re-pointed at
 * 127.0.0.1, reaches a console bound to loopback as though it were
 * same-origin -- the browser checks the name, never the address. So the
 * console answers only to the names it was given, and on loopback with none
 * given, to the loopback names.
 */
test('the console answers only to its own names (DNS rebinding)', async () => {
  const owner = await console_();
  const port = new URL(owner.url).port;
  const named = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager(), rpId: 'palugada.local' }),
    allowedHosts: ['console.example.com'],
  });
  const { url: namedUrl, port: namedPort } = await named.listen();
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      assert.equal((await getAs(owner.url, '/api/auth/challenge', host)).status, 200, host);
    }
    for (const path of ['/api/auth/challenge', '/', '/api/companies']) {
      const rebound = await getAs(owner.url, path, `rebound.attacker.example:${port}`);
      assert.equal(rebound.status, 421, path);
      assert.equal(rebound.body.code, 'owner.wrong_host', path);
    }

    // Given names are the names: the one it is published under, and the
    // address it is bound to.
    for (const host of ['console.example.com', 'console.example.com:443', `127.0.0.1:${namedPort}`]) {
      assert.equal((await getAs(namedUrl, '/api/auth/challenge', host)).status, 200, host);
    }
    for (const host of ['rebound.attacker.example', 'console.example.com.attacker.example']) {
      assert.equal((await getAs(namedUrl, '/api/auth/challenge', host)).status, 421, host);
    }
  } finally {
    await named.close();
    await owner.close();
  }
});

/**
 * The deployment gives the console the names the owner reaches it by: the
 * ones listed outright, or the public URL's -- and refuses to start on a URL
 * that is not one, rather than guessing.
 */
test('the deployment answers to its public name and refuses a malformed one', async () => {
  const { start } = await import('../../src/main.ts');
  const deployment = await start({
    port: 0,
    env: { PALUGADA_APP_URL_PUBLIC: 'https://console.example.com/palugada' },
    worker: { idleMs: 60_000 },
  });
  try {
    const port = new URL(deployment.url).port;
    assert.equal((await getAs(deployment.url, '/api/auth/challenge', 'console.example.com')).status, 200);
    assert.equal((await getAs(deployment.url, '/api/auth/challenge', `localhost:${port}`)).status, 200,
      'the operator on the machine itself');
    assert.equal((await getAs(deployment.url, '/api/auth/challenge', 'rebound.attacker.example')).status, 421);
  } finally {
    await deployment.stop();
  }

  // A list named outright still answers loopback: the container image's own
  // health check asks 127.0.0.1, and was refused, so a healthy deployment was
  // restarted for ever.
  const listed = await start({ port: 0, env: { PALUGADA_ALLOWED_HOSTS: 'palugada.internal' }, worker: { idleMs: 60_000 } });
  try {
    const port = new URL(listed.url).port;
    assert.equal((await getAs(listed.url, '/api/health', `127.0.0.1:${port}`)).status, 200);
    assert.equal((await getAs(listed.url, '/api/auth/challenge', 'palugada.internal')).status, 200);
    assert.equal((await getAs(listed.url, '/api/auth/challenge', 'rebound.attacker.example')).status, 421);
  } finally {
    await listed.stop();
  }

  let started: Awaited<ReturnType<typeof start>> | null = null;
  let refusal: unknown = null;
  try {
    started = await start({ port: 0, env: { PALUGADA_APP_URL_PUBLIC: 'console dot example' }, worker: { idleMs: 50 } });
  } catch (failure) {
    refusal = failure;
  }
  if (started) await started.stop();
  assert.equal(started, null, 'a public URL that is not one started a deployment anyway');
  assert.equal((refusal as { code?: string }).code, 'config.invalid');
});

/**
 * An API with no origin policy is safer than one that echoes back whatever it
 * was sent, because the second looks like a policy.
 */
test('the API allows no cross-origin caller unless one was configured', async () => {
  const owner = await console_();
  try {
    const response = await fetch(`${owner.url}/api/companies`, {
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    await owner.close();
  }
});

/**
 * The console's own files, and the oldest hole there is.
 *
 * A static server that joins a request path onto a directory serves whatever
 * the path walks to. `fetch` normalises `..` away before a request leaves, so
 * this speaks HTTP over a raw socket to reach the server with the dots intact
 * -- which is exactly what an attacker does, and exactly what a test using a
 * well-behaved client can never check.
 */
test('the console cannot be walked out of', async () => {
  // Its own server, with its own static root. It does not use `console_()`:
  // this test never signs in, and starting a second console only to close it
  // was leftover from an earlier shape.
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local' });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-console-'));
  await writeFile(join(root, 'index.html'), '<h1>console</h1>', 'utf8');

  const api = new OwnerApi({ mfa, staticRoot: root });
  const { port } = await api.listen();

  try {
    // The console itself is served.
    assert.match(await rawGet(port, '/'), /^HTTP\/1\.1 200/);

    for (const path of [
      '/../../../../etc/passwd',
      '/..%2f..%2f..%2f..%2fetc%2fpasswd',
      '/./../../etc/hostname',
      '/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const answer = await rawGet(port, path);
      assert.doesNotMatch(answer, /root:/, `${path} served something outside the console`);
      assert.match(answer, /^HTTP\/1\.1 (403|404)/, path);
    }

    // A symbolic link inside the console, which is the case the textual
    // check exists for and the only one it actually catches. `normalize`
    // flattens a path full of dots before anything compares it, so the four
    // above land harmlessly inside the root and miss -- it is easy to believe
    // that is the defence working. `resolve` does not follow links, so a link
    // to `/etc` passes every string comparison and reads somebody else's
    // files. Only `realpath` sees it.
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc', join(root, 'escape')).catch(() => undefined);
    const throughLink = await rawGet(port, '/escape/hostname');
    assert.doesNotMatch(throughLink, /HTTP\/1\.1 200/, 'a symlink walked out of the console');
    assert.match(throughLink, /^HTTP\/1\.1 403/);

    // And the headers that stop the console being framed or extended.
    const served = await rawGet(port, '/');
    assert.match(served, /content-security-policy: .*frame-ancestors 'none'/i);
    assert.match(served, /x-content-type-options: nosniff/i);
  } finally {
    await api.close();
  }
});

/** One HTTP request over a raw socket, with the path exactly as written. */
async function rawGet(port: number, path: string): Promise<string> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { answer += chunk; });
    socket.on('end', () => resolve(answer));
    socket.on('error', reject);
  });
}

/* ------------------------------------------------------------ the console --- */

/**
 * The whole thing, started the way a deployment starts it.
 *
 * `src/main.ts` is the assembly, and an assembly nothing exercises is the
 * defect this repository keeps finding in itself: every part works, is tested
 * alone, and is wired together by nobody. So this boots it for real -- worker,
 * console, channels -- serves the actual page from `console/`, and signs in
 * over HTTP.
 */
test('the deployment boots, serves the console, and takes a decision', async () => {
  const fixture = await createCompany('deployment');
  const { start } = await import('../../src/main.ts');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');

  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);

  // The built console, as `npm start` serves it (`npm run console:build`).
  const consoleRoot = fileURLToPath(new URL('../../console/dist', import.meta.url));
  const deployment = await start({
    secrets,
    consoleRoot,
    port: 0,
    // No channels configured, which is the ordinary first boot.
    env: {},
    worker: { companyId: fixture.companyId, idleMs: 50 },
  });

  try {
    // F12.5 at boot: the deployment says out loud that nothing can be approved
    // yet, rather than leaving it to be discovered at the first tier 3.
    assert.ok(
      deployment.notes.some((note) => /no authenticator is enrolled/.test(note)),
      deployment.notes.join(' | '),
    );
    assert.ok(deployment.notes.some((note) => /no push channel/.test(note)));
    assert.ok(deployment.notes.some((note) => /no message channel/.test(note)));

    // The console itself, from the repository's build rather than a fixture:
    // the page, its script and its stylesheet, from this origin only.
    const page = await fetch(`${deployment.url}/`);
    assert.equal(page.status, 200);
    const policy = page.headers.get('content-security-policy') ?? '';
    assert.match(policy, /script-src 'self';/);
    // A tried picture or voice is shown from the answer itself; nothing else may come from data.
    assert.match(policy, /img-src 'self' data:; media-src 'self' data:/);
    assert.doesNotMatch(policy, /script-src[^;]*data:/);
    const html = await page.text();
    assert.match(html, /<title>PALUGADA<\/title>/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
    assert.ok(assets.some((asset) => asset.endsWith('.js')) && assets.some((asset) => asset.endsWith('.css')),
      `the page names no built script or stylesheet: ${assets.join(', ')}`);
    for (const asset of assets) {
      const served = await fetch(`${deployment.url}${asset}`);
      assert.equal(served.status, 200, asset);
      assert.match(served.headers.get('cache-control') ?? '', /immutable/, `${asset} is content-hashed and may be kept`);
    }
    assert.equal((await fetch(`${deployment.url}/illustrations/inbox-zero.webp`)).headers.get('content-type'), 'image/webp');
    // The icons the page names and its manifest, each with the type a browser
    // needs to use it: served as octet-stream under `nosniff`, a favicon or a
    // manifest is simply ignored.
    for (const [path, type] of [
      ['/favicon.ico', 'image/x-icon'], ['/favicon.svg', 'image/svg+xml'], ['/apple-touch-icon.png', 'image/png'],
      ['/manifest.webmanifest', 'application/manifest+json'], ['/avatars/owner.webp', 'image/webp'],
    ] as const) {
      const served = await fetch(`${deployment.url}${path}`);
      assert.equal(served.status, 200, path);
      assert.equal(served.headers.get('content-type'), type, path);
    }
    void join;

    // A notification's link opens the console on its item. It pointed at
    // `/i/<id>`, which nothing served; it is the console with the company and
    // the item in the query now, which the page reads.
    const { consoleLinkFor } = await import('../../src/owner/notify.ts');
    const link = new URL(consoleLinkFor(deployment.url, { id: 'item-1', companyId: fixture.companyId }));
    assert.equal(link.searchParams.get('company'), fixture.companyId);
    assert.equal(link.searchParams.get('item'), 'item-1');
    const opened = await fetch(link);
    assert.equal(opened.status, 200, 'the link lands on the console');
    assert.match(await opened.text(), /<title>PALUGADA<\/title>/);
    const entry = assets.find((asset) => /\/index-[^/]+\.js$/.test(asset))!;
    const script = await (await fetch(`${deployment.url}${entry}`)).text();
    assert.match(script, /get\(["'`]company["'`]\)/, 'the page reads the company from the link');
    assert.match(script, /get\(["'`]item["'`]\)/, 'and the item');

    // Now enrol, sign in, and take a real decision through the API the page
    // uses -- which is the whole chain the owner touches.
    await deployment.mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
    let drift = 0;
    const code = () => totpCode(decodeBase32(secret), stepFor(new Date()) + drift++);

    const token = await signIn(deployment.url, code());
    const itemId = await tier3(fixture);

    const approved = await call(
      deployment.url,
      'POST',
      `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`,
      { token, body: { decision: 'approve', note: 'boot check', proof: { totp: code() } } },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await deployment.stop();
  }
});

/**
 * A fresh deployment can start a company from its console.
 *
 * `npm start` on an empty database saved no template and published no bundle
 * -- `src/seed.ts` said it ran on every deploy, and only the smoke script
 * called it -- and the capabilities the standard template grants that wait for
 * a vendor were written nowhere, so granting one was refused. The owner's
 * first "Start a company" failed with "no company template named
 * standard-company". The boot seeds now, and a catalogued capability with no
 * vendor yet is known by name: it can be granted, and a call to it says what
 * is missing.
 */
test('a fresh deployment starts the standard company, and can let it run itself', async () => {
  const { start } = await import('../../src/main.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const { CapabilityBroker } = await import('../../src/broker/broker.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);

  const deployment = await start({ secrets, port: 0, env: {}, worker: { idleMs: 50 } });
  try {
    assert.ok(deployment.notes.some((note) => /seeded the standard company template and \d+ built-in bundles/.test(note)),
      deployment.notes.join(' | '));
    const token = await signInTo(deployment, secret);
    const code = totpCode(decodeBase32(secret), stepFor(new Date()) + 1);
    const start_ = (bundles: string[]) => call(deployment.url, 'POST', '/api/companies', {
      token,
      body: { templateSlug: 'standard-company', companySlug: 'first-co', name: 'First Co', bundles, proof: { totp: code } },
    });

    // Refused before the code is spent and before anything is written.
    const refused = await start_(['no-such-bundle']);
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /no bundle named no-such-bundle/);
    const none = await withControlPlane((tx) => tx.query('SELECT 1 FROM companies'));
    assert.equal(none.rows.length, 0);

    const created = await start_(['company-os']);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(created.body.bundles, ['company-os']);
    const companyId = String(created.body.companyId);
    const roles = await withControlPlane((tx) => tx.query<{ slug: string }>(
      'SELECT slug FROM roles WHERE company_id = $1 ORDER BY slug', [companyId]));
    const slugs = roles.rows.map((row) => row.slug);
    assert.ok(slugs.includes('coordinator') && slugs.includes('strategist'), slugs.join(', '));

    // A capability waiting for its vendor is granted, and says so when called.
    const unbound = await withControlPlane((tx) => tx.query<{ adapter: string; has_grant: boolean }>(
      `SELECT c.adapter, EXISTS (SELECT 1 FROM capability_grants g WHERE g.capability_name = c.name AND g.company_id = $1) AS has_grant
         FROM capabilities c WHERE c.name = 'email.send'`, [companyId]));
    assert.deepEqual(unbound.rows[0], { adapter: 'unbound', has_grant: true });
    const broker = new CapabilityBroker(new CapabilityRegistry());
    await assert.rejects(
      broker.invoke({ companyId, projectId: companyId, divisionId: companyId, roleId: companyId, taskId: companyId, idempotencyKey: 'x' }, 'email.send', {}),
      /email\.send needs a vendor: connect one on This deployment, Services, or bind it in the file PALUGADA_VENDORS names/,
    );
  } finally {
    await deployment.stop();
  }
});

/**
 * The boot seeds, and leaves alone what an operator already published.
 *
 * Publishing replaces a bundle's row, signature and all. An operator who
 * published a built-in signed -- which is what lets its grants be used --
 * would have it replaced by the unsigned copy on every start.
 */
test('the boot leaves a bundle that is already published as it is', async () => {
  const { start } = await import('../../src/main.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const { publishBundle } = await import('../../src/bundles/bundle.ts');
  const { COMPANY_OS } = await import('../../src/bundles/builtin.ts');
  await publishBundle(COMPANY_OS);
  await withControlPlane((tx) => tx.query(
    "UPDATE bundles SET description = 'kept by the operator' WHERE slug = $1 AND version = $2",
    [COMPANY_OS.slug, COMPANY_OS.version]));

  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 50 } });
  try {
    const { rows } = await withControlPlane((tx) => tx.query<{ description: string }>(
      'SELECT description FROM bundles WHERE slug = $1 AND version = $2', [COMPANY_OS.slug, COMPANY_OS.version]));
    assert.equal(rows[0]!.description, 'kept by the operator');
    const all = await withControlPlane((tx) => tx.query('SELECT slug FROM bundles'));
    assert.ok(all.rows.length >= 5, 'and the ones that were missing are published');
  } finally {
    await deployment.stop();
  }
});

/* ------------------------------------------- what the second review found --- */

/**
 * The assembly file had the defect assembly files exist to prevent.
 *
 * `memory.search` and `skill.read` are the two tools every context pack
 * *instructs* every run to call -- F4.8 for what did not fit in the pack, F15.7
 * for a skill's full text -- and `src/main.ts` never registered them. Under
 * `npm start` every role would have been told to use two tools that answer
 * `capability.unknown`. That is the third time this repository has found
 * machinery nobody assembled, and this time it was in the assembly.
 */
test('the deployment binds the tools every context pack tells a run to call (F4.8, F15.7)', async () => {
  const { start } = await import('../../src/main.ts');
  const { PLATFORM_CAPABILITIES } = await import('../../src/broker/platform-capabilities.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');

  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 50 } });
  try {
    const registered = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ name: string }>('SELECT name FROM capabilities');
      return new Set(rows.map((row) => row.name));
    });

    for (const name of PLATFORM_CAPABILITIES) {
      assert.ok(registered.has(name), `${name} is instructed and not bound`);
    }
    // And the ones the platform implements for itself, which the notes name.
    for (const name of ['web.fetch', 'uptime.check']) {
      assert.ok(registered.has(name), `${name} is not bound`);
    }
    assert.ok(
      deployment.notes.some((note) => note.startsWith('bound by the platform:')),
      deployment.notes.join(' | '),
    );
  } finally {
    await deployment.stop();
  }
});

/**
 * A broker built without a secret manager refuses every credential.
 *
 * `new CapabilityBroker(registry, undefined, undefined)` is what the first
 * assembly did, and it makes `ctx.credential()` throw `credential.unavailable`
 * for every capability that needs one -- in the only assembly a deployment
 * actually runs. The unit tests all pass one in, so nothing noticed.
 */
test('the deployment gives the broker its secrets (F12.1, F12.3)', async () => {
  const { start } = await import('../../src/main.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { grantCapability } = await import('../helpers/fixtures.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');

  const fixture = await createCompany('deployment-secrets');
  const secrets = new InMemorySecretManager();
  secrets.set('vault://acme/api', 'the-real-token-value');

  // A capability that asks for a credential and reports what it got.
  let seen: string | null = null;
  const registry = new CapabilityRegistry();
  registry.register({
    name: 'test.credentialed',
    adapter: 'test:secrets',
    defaultTier: 0,
    async execute(_input: unknown, ctx) {
      seen = await ctx.credential('api');
      return { ok: true };
    },
  });

  // A real task, because the broker writes the call onto its timeline and the
  // event log will not carry one for a task that does not exist.
  const { createRootTask } = await import('../../src/engine/tasks.ts');
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { why: 'to invoke a capability' },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });

  const deployment = await start({ secrets, registry, port: 0, env: {}, worker: { idleMs: 50 } });
  try {
    await withControlPlane(async (tx) => {
      await tx.query(
        `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
         VALUES ($1, $2, 'api', 'vault://acme/api')`,
        [fixture.companyId, fixture.divisionId],
      );
    });
    await grantCapability(fixture, 'test.credentialed');

    // Through the broker this deployment actually built, not one the test
    // made: the defect was in the assembly, so anything the test constructed
    // for itself would have passed while `npm start` failed.
    await deployment.broker.invoke(
      {
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        divisionId: fixture.divisionId,
        roleId: fixture.roleId,
        taskId: task.id,
        idempotencyKey: 'secrets-1',
      },
      'test.credentialed',
      {},
    );

    assert.equal(seen, 'the-real-token-value', 'the broker was built without its secrets');
  } finally {
    await deployment.stop();
  }
});

/* -------------------------------------------- what the fourth review found --- */

/**
 * The twenty were a spec nobody could hand in.
 *
 * `httpCapability` turned a vendor integration into configuration, and the
 * README said so -- but the configuration was a TypeScript object with four
 * functions in it, so the only way to bind `email.send` was to fork this
 * repository and edit this file. That is the same defect a fourth time:
 * machinery that works, is tested alone, and is assembled by nobody.
 *
 * This boots the assembly with a vendor file on disk and checks the three
 * things that make it real: the capability is registered, the deployment says
 * which file bound it, and what is still unbound is named rather than counted.
 */
test('the deployment binds the twenty from a file (§10, F8)', async () => {
  const { start } = await import('../../src/main.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'palugada-deploy-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, JSON.stringify({
    capabilities: [{
      name: 'email.send',
      adapter: 'resend',
      tier: 2,
      method: 'POST',
      url: 'https://api.example/v1/emails',
      headers: {
        authorization: 'Bearer {credential}',
        'idempotency-key': '{idempotencyKey}',
      },
      body: { to: '{input.to}', subject: '{input.subject}' },
      result: 'body.id',
      credentialAlias: 'email',
      verify: {
        url: 'https://api.example/v1/emails/{result.id}',
        matches: { status: 200, path: 'body.id', equalsPath: 'result' },
      },
      describe: { recipientDomain: 'to' },
    }],
  }));

  const deployment = await start({
    port: 0,
    env: {},
    vendorsFile: path,
    worker: { idleMs: 50 },
  });
  try {
    const registered = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ name: string; default_tier: number }>(
        "SELECT name, default_tier FROM capabilities WHERE name = 'email.send'",
      );
      return rows[0];
    });
    assert.equal(registered?.name, 'email.send', 'the file did not reach the registry');
    assert.equal(registered.default_tier, 2, 'and it kept the catalogued tier');

    assert.ok(
      deployment.notes.some((note) => note.startsWith(`bound by ${path}:`)),
      deployment.notes.join(' | '),
    );

    // What is left, by name. The count on its own has been wrong twice in this
    // repository's history, both times because something was registered and
    // nothing looked.
    const remaining = deployment.notes.find((note) => /catalogued capabilit/.test(note));
    assert.ok(remaining, deployment.notes.join(' | '));
    assert.ok(!/email\.send/.test(remaining), 'a bound capability is still listed as needing one');
    assert.match(remaining, /invoice\.pay/, 'one that genuinely needs a vendor is not listed');
  } finally {
    await deployment.stop();
  }
});

/**
 * And a file it cannot build from stops the boot.
 *
 * Every other missing piece leaves a capability unbound, which the broker
 * refuses loudly at the moment of use. A malformed vendor file is different:
 * the operator believes they configured it. Starting anyway produces exactly
 * the failure v2 section 2.3 records -- a deployment that looks healthy and
 * refuses every send.
 */
test('a vendor file that cannot be built from stops the boot (§10)', async () => {
  const { start } = await import('../../src/main.ts');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'palugada-deploy-bad-'));
  const path = join(directory, 'vendors.json');
  // A tier 2 write with no read-back: F8.4, which the broker would refuse at
  // the first invoice.
  await writeFile(path, JSON.stringify({
    capabilities: [{
      name: 'invoice.issue', adapter: 'x', tier: 2, method: 'POST',
      url: 'https://api.example/v1/invoices',
      headers: { 'idempotency-key': '{idempotencyKey}' },
    }],
  }));

  // Caught rather than `assert.rejects`, so that a regression *fails* instead
  // of hanging: a `start` that wrongly succeeds leaves a listening console and
  // a ticking worker behind, the test runner never exits, and CI burns its
  // whole timeout on what should be one red line. A test that hangs on the
  // defect it exists to catch is a test that does not report it.
  let started: Awaited<ReturnType<typeof start>> | null = null;
  let refusal: unknown = null;
  try {
    started = await start({ port: 0, env: {}, vendorsFile: path, worker: { idleMs: 50 } });
  } catch (failure) {
    refusal = failure;
  }
  if (started) await started.stop();

  assert.equal(started, null, 'a file that cannot be built from started a deployment anyway');
  assert.match((refusal as Error).message, /cannot bind invoice\.issue/);
});

/**
 * F13.7's estimate, through the deployment rather than a hand-built engine.
 *
 * The estimate was zero in the engine, and a price list the engine can use is
 * one more thing `src/main.ts` could fail to hand it -- the sixth piece of
 * machinery this repository would have had working, tested, and assembled by
 * nobody. So the worker the deployment started runs a task on a runtime that
 * reports tokens and no price, and the company's money has to move by what
 * the operator's file says that model costs.
 */
test('the deployment charges unpriced usage from its price file (F13.7, F1.7)', async () => {
  const { start } = await import('../../src/main.ts');
  const { AdapterRegistry } = await import('../../src/runtime/protocol.ts');
  const { createRootTask, getTask } = await import('../../src/engine/tasks.ts');
  const { withTenant } = await import('../../src/db/tenant.ts');

  const fixture = await createCompany('deployment-prices');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'metered-cli', backend = 'local' WHERE id = $1",
    [fixture.roleId],
  ));
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'metered-cli',
    backends: ['local'],
    async health() {
      return { ok: true, detail: 'test runtime' };
    },
    async run(request, services) {
      // `example-small-*` in config/prices.example.json: $1 per million in.
      await services.reportUsage({
        model: 'example-small-1', inputTokens: 500_000, outputTokens: 0, costCents: null,
      });
      // Its answer, with the report its contract asks for.
      const contract = request.contextPack.notes.find((note) => note.title === 'What you return')?.body ?? '';
      return { output: { ok: true, done: reportOn(criteriaIn(contract)) } };
    },
  });

  const deployment = await start({
    port: 0,
    env: {},
    adapters,
    pricesFile: 'config/prices.example.json',
    worker: { companyId: fixture.companyId, idleMs: 50 },
  });
  try {
    assert.ok(
      deployment.notes.some((note) => note.startsWith('model prices from config/prices.example.json: 3 ')),
      deployment.notes.join(' | '),
    );
    const task = await createRootTask({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      input: { goal: 'spend a little' },
      createdBy: 'owner',
      reserveTokens: 600_000,
    });

    const deadline = Date.now() + 10_000;
    let status = task.status;
    while (Date.now() < deadline) {
      status = await withTenant(fixture.companyId, async (tx) => (await getTask(tx, task.id))!.status);
      if (status === 'completed' || status === 'failed' || status === 'halted') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, 'completed', `the worker left the task ${status}`);

    const spent = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ spent: string }>(
        'SELECT money_spent_cents::text AS spent FROM budget_accounts WHERE id = $1',
        [fixture.budgetAccountId],
      );
      return Number(rows[0]!.spent);
    });
    // 500k tokens at 100 cents per million: 50 cents, from the file. The
    // fallback would have charged 750, and the old code nothing.
    assert.equal(spent, 50);
  } finally {
    await deployment.stop();
  }
});

/* --------------------------------------------- what the reachability scan found --- */

/**
 * The worker could not run anything.
 *
 * `src/main.ts` passed the engine neither an adapter registry nor an
 * `llm`/`handlers` pair, so `npm start` booted a worker whose
 * `AdapterRegistry` was empty. Every task it checked out halted immediately
 * with `runtime_unavailable`, naming the registered runtimes as "none". The
 * platform's whole purpose is to run work and the deployment could run none of
 * it.
 *
 * This is the fifth time this repository has found machinery that works, is
 * tested in isolation, and is assembled by nobody, and it is the largest.
 * Nothing caught it because every other test builds its own `Engine` with its
 * own handlers -- the assembly was the one caller nobody wrote. So this one
 * runs a real task through the engine the deployment built, which is the only
 * shape of test that could have failed.
 */
test('the deployment can actually run a task (F13.1, §10)', async () => {
  const { start } = await import('../../src/main.ts');
  const { RecordingLlmClient } = await import('../../src/llm/client.ts');
  const { createRootTask, getTask } = await import('../../src/engine/tasks.ts');
  const { withTenant } = await import('../../src/db/tenant.ts');

  const fixture = await createCompany('deployment-runtime');
  const ran: string[] = [];
  const deployment = await start({
    port: 0,
    env: {},
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      ran.push(ctx.task.id);
      return { done: true };
    }]]),
    worker: { companyId: fixture.companyId, idleMs: 50 },
  });

  try {
    assert.ok(
      deployment.engine.adapters.names().length > 0,
      `the worker has no runtime: ${deployment.notes.join(' | ')}`,
    );

    const task = await createRootTask({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      input: { goal: 'run through the deployment' },
      createdBy: 'owner',
      reserveTokens: 10_000,
    });

    // Left to the worker this deployment started, rather than run by hand.
    //
    // The first version called `engine.runTask` directly and raced the
    // deployment's own worker for the same row -- whoever claimed it first
    // won, and one run in ten the test lost and read `not_claimed`. Which was
    // F5.11 working exactly as written: `FOR UPDATE SKIP LOCKED` means two
    // claimants cannot both have it. The platform was right and the test was
    // wrong, and it was wrong about the interesting part too: "the deployment
    // can run a task" is a claim about the *worker*, so watching the worker do
    // it is both correct and stronger.
    const deadline = Date.now() + 10_000;
    let status = task.status;
    while (Date.now() < deadline) {
      status = await withTenant(
        fixture.companyId,
        async (tx) => (await getTask(tx, task.id))!.status,
      );
      if (status === 'completed' || status === 'failed' || status === 'halted') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Raced against a clock rather than waited on forever: a regression here
    // should be one red line, not a suite that hangs until CI times out.
    assert.equal(status, 'completed', `the worker left the task ${status}`);
    assert.deepEqual(ran, [task.id]);
    assert.ok(deployment.notes.some((note) => note.startsWith('runtimes:')));
  } finally {
    await deployment.stop();
  }
});

/**
 * And a deployment with no runtime at all says so, in those words.
 *
 * A worker that can run nothing looks, from outside, exactly like a worker
 * with nothing to do. The note is the only difference an operator can see
 * before a task halts.
 */
test('a deployment with no runtime says so at boot (F13.1)', async () => {
  const { start } = await import('../../src/main.ts');
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 50 } });
  try {
    assert.deepEqual(deployment.engine.adapters.names(), []);
    assert.ok(
      deployment.notes.some((note) => /every task will halt with runtime_unavailable/.test(note)),
      deployment.notes.join(' | '),
    );
  } finally {
    await deployment.stop();
  }
});

/**
 * The runtimes the environment describes are the runtimes it gets.
 *
 * Each of F13's adapters needs something this process cannot conjure -- a CLI
 * on PATH, an image, a URL, a sandbox account -- so each is conditional. What
 * must not be conditional is that naming one registers it: an operator who
 * sets the variable and gets nothing has no way to tell.
 */
test('the environment describes which runtimes exist (F13.1, F13.3, F12.9)', async () => {
  const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');

  const { adapters, notes } = assembleRuntimes({
    env: {
      PALUGADA_CLAUDE_CODE_COMMAND: 'claude',
      PALUGADA_RUNTIME_HTTP_URL: 'https://runtime.example',
      PALUGADA_RUNTIME_HTTP_NAME: 'partner',
      PALUGADA_RUNTIME_IMAGE: 'ghcr.io/example/runtime@sha256:' + 'a'.repeat(64),
      PALUGADA_SANDBOX_URL: 'https://sandbox.example',
      PALUGADA_SANDBOX_IMAGE: 'ghcr.io/example/sandbox:1',
      PALUGADA_SANDBOX_PROVIDER: 'daytona',
      PALUGADA_RUNTIME_SPECS: JSON.stringify([{
        name: 'hermes',
        command: 'hermes',
        args: ['--prompt', '{prompt}', '--mcp-config', '{mcpConfigFile}'],
      }]),
    },
  });

  const names = adapters.names();
  for (const expected of ['claude-code', 'partner', 'sandbox:daytona', 'hermes']) {
    assert.ok(names.includes(expected), `${expected} was not registered: ${names.join(', ')}`);
  }
  assert.ok(notes.some((note) => note.startsWith('runtimes:')));
});

/**
 * The HTTP runtime's and the remote sandbox's tokens came from the
 * environment straight into a header, and the redactor was never told them:
 * an error that echoed a request, or a runtime that printed its own headers
 * into a transcript, kept them in the clear.
 */
test('the runtimes\' own tokens are redacted wherever they would be written (F12.1)', async () => {
  const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');
  const { redactor } = await import('../../src/secrets/manager.ts');
  const runtimeToken = 'rt-http-token-6f1c2a9d8e7b';
  const sandboxToken = 'sbx-token-0d9e8f7a6b5c';
  assembleRuntimes({
    env: {
      PALUGADA_RUNTIME_HTTP_URL: 'https://runtime.example',
      PALUGADA_RUNTIME_HTTP_TOKEN: runtimeToken,
      PALUGADA_SANDBOX_URL: 'https://sandbox.example',
      PALUGADA_SANDBOX_IMAGE: 'ghcr.io/example/sandbox:1',
      PALUGADA_SANDBOX_TOKEN: sandboxToken,
    },
  });
  const said = redactor.redact(`authorization: Bearer ${runtimeToken}; sandbox ${sandboxToken}`);
  assert.ok(!said.includes(runtimeToken) && !said.includes(sandboxToken), said);
});

test('an agent CLI this platform knows is turned on by its name, and corrected in part (F13.3)', async () => {
  const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');
  const { knownCli } = await import('../../src/runtime/known-clis.ts');
  const { adapters } = assembleRuntimes({
    env: {
      PALUGADA_AGENT_CLIS: 'claude-code, codex,gemini-cli',
      // Only the path of one of them, not its whole command line.
      PALUGADA_RUNTIME_SPECS: JSON.stringify([{ name: 'codex', command: '/opt/codex/bin/codex' }]),
    },
  });
  assert.deepEqual(adapters.names().filter((name) => name !== 'in-process').sort(), ['claude-code', 'codex', 'gemini-cli']);
  const codex = adapters.get('codex') as unknown as { layout: (values: Record<string, string>) => { argv: string[] } };
  const values = { model: 'gpt-x', maxTurns: '40', wallClockSeconds: '900', mcpConfig: '', mcpConfigFile: '', mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't', allowedTools: '', prompt: '', runDir: '/run/x' };
  assert.deepEqual(codex.layout(values).argv, knownCli('codex').args.map((arg) => arg.replace('{runDir}', '/run/x').replace('{model}', 'gpt-x')),
    'the rest of the known command line is kept');
  const health = await adapters.get('codex')!.health!();
  assert.match(health.detail ?? '', /\/opt\/codex\/bin\/codex is not runnable/, 'and the binary is the one named');

  assert.throws(() => assembleRuntimes({ env: { PALUGADA_AGENT_CLIS: 'codex,aider' } }),
    /PALUGADA_AGENT_CLIS names aider; the ones known here are claude-code, hermes, openclaw, codex, gemini-cli, opencode/);
});

test('a half-configured sandbox is a note, not a silent absence (F12.9)', async () => {
  // A URL and no image is a sandbox that does not exist, and the role routed
  // to it halts. Said at boot instead.
  const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');
  const { notes } = assembleRuntimes({ env: { PALUGADA_SANDBOX_URL: 'https://sandbox.example' } });
  assert.ok(
    notes.some((note) => /needs both PALUGADA_SANDBOX_URL and PALUGADA_SANDBOX_IMAGE/.test(note)),
    notes.join(' | '),
  );
});

test('a runtime spec that would run without tools is refused at boot (F13.3)', async () => {
  // A CLI spawned without the tool bridge runs, talks to a model, has no
  // tools, and produces a confident answer about work it could not do.
  // Nothing errors, which is why it is refused where the settings can still be
  // fixed.
  const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');
  assert.throws(
    () => assembleRuntimes({
      env: {
        PALUGADA_RUNTIME_SPECS: JSON.stringify([{
          name: 'toolless', command: 'toolless', args: ['--prompt', '{prompt}'],
        }]),
      },
    }),
    /PALUGADA_RUNTIME_SPECS could not be read/,
  );
});

/* ------------------------------------- the operations the owner could not reach --- */

/**
 * The spend ceiling, the pause, and lifting it.
 *
 * F1.7 lets an owner cap what a company may spend and F1.9 lets them lift the
 * pause when the cap was wrong. Both were implemented, tested and enforced by
 * the database, and neither had a route -- so the one human here could set a
 * ceiling only with a `psql` prompt, and the guard that stopped a company
 * could only be lifted the same way. A safety mechanism nobody can release is
 * one they hesitate to arm.
 */
test('the owner can set the ceiling and lift the pause (F1.7, F1.9)', async () => {
  const fixture = await createCompany('console-spend');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/spend`;

    // Raising the ceiling loosens a control, so a session alone is not
    // enough: a stolen one could otherwise undo every limit the owner set.
    const unproven = await call(owner.url, 'POST', `${base}/limit`, {
      token, body: { moneyMaxCents: 250_00 },
    });
    assert.equal(unproven.status, 403, JSON.stringify(unproven.body));
    assert.equal(unproven.body.code, 'approval.channel_forbidden');
    const set = await call(owner.url, 'POST', `${base}/limit`, {
      token, body: { moneyMaxCents: 250_00, proof: { totp: owner.code() } },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const read = await call(owner.url, 'GET', base, { token });
    assert.equal(read.status, 200);
    assert.equal(read.body.limitCents, 250_00);

    // Lowering it tightens, and the session is enough: the moment something
    // looks wrong is not the moment to go looking for a phone.
    const lowered = await call(owner.url, 'POST', `${base}/limit`, {
      token, body: { moneyMaxCents: 200_00 },
    });
    assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
    await call(owner.url, 'POST', `${base}/limit`, {
      token, body: { moneyMaxCents: 250_00, proof: { totp: owner.code() } },
    });
    assert.equal(typeof read.body.spentCents, 'number');

    // A ceiling of zero set by a typo stops every company; `NaN` is a
    // constraint violation the owner reads as a bug. Both are refused with the
    // field named.
    const bad = await call(owner.url, 'POST', `${base}/limit`, {
      token, body: { moneyMaxCents: 'lots' },
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(String(bad.body.error), /moneyMaxCents/);

    // Paused the way the guard pauses it -- by spending past the ceiling --
    // rather than by writing the row, so the state being lifted is the state
    // the platform actually produces.
    const { evaluateSpendLimit } = await import('../../src/governance/spend-guard.ts');
    const { withTenant: tenant } = await import('../../src/db/tenant.ts');
    const { randomUUID } = await import('node:crypto');
    await tenant(fixture.companyId, async (tx) => {
      await tx.query(
        `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response,
                                 input_tokens, output_tokens, cost_cents, occurred_at)
         VALUES ($1, $2, NULL, 'test-model', '{}'::jsonb, '{}'::jsonb, 10, 5, $3, now())`,
        [randomUUID(), fixture.companyId, 400_00],
      );
    });
    await evaluateSpendLimit(fixture.companyId);
    assert.notEqual(
      (await call(owner.url, 'GET', base, { token })).body.pausedAt, null,
      'the guard did not pause, so there is nothing to lift',
    );

    const refused = await call(owner.url, 'POST', `${base}/resume`, { token, body: {} });
    assert.equal(refused.status, 403, 'lifting a pause takes the second factor');
    const resumed = await call(owner.url, 'POST', `${base}/resume`, {
      token, body: { proof: { totp: owner.code() } },
    });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal((await call(owner.url, 'GET', base, { token })).body.pausedAt, null);

    // An override is bounded. F1.9 exists for "this one campaign is worth it",
    // and an override with no end is a ceiling removed rather than raised.
    const past = await call(owner.url, 'POST', `${base}/resume`, {
      token, body: { until: '2020-01-01T00:00:00Z', proof: { totp: owner.code() } },
    });
    assert.equal(past.status, 400, JSON.stringify(past.body));
  } finally {
    await owner.close();
  }
});

test('the owner can set retention and read what it purged (F1.5)', async () => {
  const fixture = await createCompany('console-retention');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/retention`;

    // Partial on purpose: changing how long prompts are kept should not make
    // the owner restate the other two, which is how one gets changed by
    // accident.
    const before = await call(owner.url, 'GET', path, { token });
    const events = (before.body.policy as { eventDays: number }).eventDays;

    const set = await call(owner.url, 'POST', path, { token, body: { promptDays: 120 } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const policy = set.body.policy as { eventDays: number; promptDays: number };
    assert.equal(policy.promptDays, 120);
    assert.equal(policy.eventDays, events, 'a field nobody named was changed');

    const empty = await call(owner.url, 'POST', path, { token, body: {} });
    assert.equal(empty.status, 400, JSON.stringify(empty.body));

    // The schema keeps prompts for ninety days and says so in words. That
    // sentence is the answer the owner should get -- an opaque 500 tells them
    // their console is broken when the platform just told them why it would
    // not do the thing.
    const tooShort = await call(owner.url, 'POST', path, { token, body: { promptDays: 7 } });
    assert.equal(tooShort.status, 400, JSON.stringify(tooShort.body));
    assert.match(String(tooShort.body.error), /ninety_days|ninety days/);

    assert.ok(Array.isArray((await call(owner.url, 'GET', path, { token })).body.log));
  } finally {
    await owner.close();
  }
});

test('the owner can set their own hours, and a company\'s batch window (F9.5, F9.6)', async () => {
  const fixture = await createCompany('console-windows');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const set = await call(owner.url, 'POST', '/api/control/owner-window', {
      token, body: { timezone: 'Asia/Jakarta', startHour: 8, endHour: 21 },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const read = await call(owner.url, 'GET', '/api/control/owner-window', { token });
    assert.deepEqual(
      { tz: read.body.timezone, start: read.body.startHour, end: read.body.endHour },
      { tz: 'Asia/Jakarta', start: 8, end: 21 },
    );

    // An hour is 0 to 23. `Number('')` is zero and would silently set midnight.
    const bad = await call(owner.url, 'POST', '/api/control/owner-window', {
      token, body: { timezone: 'UTC', startHour: 8, endHour: 25 },
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(String(bad.body.error), /endHour/);

    const batch = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/batch-window`,
      { token, body: { timezone: 'UTC', startHour: 2, endHour: 5, daysOfWeek: [1, 2, 3, 4, 5] } },
    );
    assert.equal(batch.status, 200, JSON.stringify(batch.body));

    // A zone `Intl` does not know was stored, and from then on every
    // notification and every cheap-hours check threw on it. Refused on the
    // way in, by name, and what was there before still stands.
    for (const path of ['/api/control/owner-window', `/api/companies/${fixture.companyId}/batch-window`]) {
      const nowhere = await call(owner.url, 'POST', path, {
        token, body: { timezone: 'Jakarta', startHour: 8, endHour: 21 },
      });
      assert.equal(nowhere.status, 400, `${path}: ${JSON.stringify(nowhere.body)}`);
      assert.match(String(nowhere.body.error), /not a time zone.*Asia\/Jakarta/);
    }
    assert.equal((await call(owner.url, 'GET', '/api/control/owner-window', { token })).body.timezone,
      'Asia/Jakarta');
    const { assertValidCron } = await import('../../src/scheduler/scheduler.ts');
    assert.throws(() => assertValidCron('0 9 * * *', 'Jakarta'), /not a time zone/);
  } finally {
    await owner.close();
  }
});

/**
 * A rotation takes the owner's device, not their tab.
 *
 * Rotating is the answer to "that token leaked", which makes it as
 * irreversible as anything F10.10 gates -- and a session minted eight hours
 * ago is possession of a browser tab. The gate lives on this surface rather
 * than inside `rotateCredential` because rotation is also what a scheduled job
 * does, and a job has no phone.
 */
test('rotating a credential needs a second factor (F12.3, F10.10)', async () => {
  const fixture = await createCompany('console-rotate');
  const { withTenant } = await import('../../src/db/tenant.ts');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path =
      `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials/dns/rotate`;

    const without = await call(owner.url, 'POST', path, { token, body: {} });
    assert.equal(without.status, 403, JSON.stringify(without.body));
    assert.equal(without.body.code, 'approval.channel_forbidden');

    const withFactor = await call(owner.url, 'POST', path, {
      token,
      body: { proof: { totp: owner.code() }, newSecretRef: 'vault://acme/dns-token-v2' },
    });
    assert.equal(withFactor.status, 200, JSON.stringify(withFactor.body));
    assert.equal(withFactor.body.version, 2);
    // The reference travels, the value never does: it is a path, and what it
    // points at is not seen by this process.
    assert.equal(withFactor.body.secretRef, 'vault://acme/dns-token-v2');
  } finally {
    await owner.close();
  }
});

test('the owner can answer an agent\'s question (F10.3)', async () => {
  const fixture = await createCompany('console-answer');
  // A question is what an owner leaves on an item they are not ready to
  // decide, so that is how one is made here: the real path rather than a row.
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId,
    capabilityName: 'email.send',
    tier: 2,
    actionSummary: 'Send the quote',
    rationale: 'The supplier asked for it.',
    consequenceIfDenied: 'They do not get a quote.',
  });
  await inbox.decide(
    fixture.companyId, itemId, 'ask', 'Which supplier should this go to?',
    { channel: 'app', assurance: 'session' },
  );

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/inbox/${itemId}/answer`;

    const empty = await call(owner.url, 'POST', path, { token, body: { answer: '   ' } });
    assert.equal(empty.status, 400, JSON.stringify(empty.body));

    const answered = await call(owner.url, 'POST', path, {
      token, body: { answer: 'The one in Surabaya.' },
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
  } finally {
    await owner.close();
  }
});

test('the owner can see capability health, cost and the governance log (F8.12, F11.5, F3.11)', async () => {
  const fixture = await createCompany('console-observability');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const health = await call(
      owner.url, 'GET',
      `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/health`,
      { token },
    );
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.ok(Array.isArray(health.body.health));

    // Thirty days by default. Making the owner name two dates before they can
    // ask "what has this been costing me" is a question they stop asking.
    const cost = await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/cost`, { token });
    assert.equal(cost.status, 200, JSON.stringify(cost.body));
    assert.ok(Array.isArray(cost.body.timeline));

    const platform = await call(owner.url, 'GET', '/api/control/cost', { token });
    assert.equal(platform.status, 200);
    assert.ok(Array.isArray(platform.body.companies));

    const backwards = await call(
      owner.url, 'GET',
      `/api/companies/${fixture.companyId}/cost?from=2026-02-01&to=2026-01-01`,
      { token },
    );
    assert.equal(backwards.status, 400, JSON.stringify(backwards.body));

    const governance = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/governance`, { token },
    );
    assert.equal(governance.status, 200);
    assert.ok(Array.isArray(governance.body.log));
  } finally {
    await owner.close();
  }
});

test('every new route needs a session (F10, F12.5)', async () => {
  // The one property that must hold for all of them at once. A route added
  // without a session check is a route that reaches a company's data
  // unauthenticated, and it would be the easiest possible thing to miss in a
  // block of twenty.
  const fixture = await createCompany('console-unauthenticated');
  const owner = await console_();
  try {
    const paths: Array<[string, string]> = [
      ['GET', `/api/companies/${fixture.companyId}/spend`],
      ['POST', `/api/companies/${fixture.companyId}/spend/limit`],
      ['POST', `/api/companies/${fixture.companyId}/spend/resume`],
      ['GET', `/api/companies/${fixture.companyId}/retention`],
      ['POST', `/api/companies/${fixture.companyId}/retention`],
      ['GET', '/api/control/owner-window'],
      ['POST', '/api/control/owner-window'],
      ['POST', `/api/companies/${fixture.companyId}/batch-window`],
      ['GET', `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/health`],
      ['GET', `/api/companies/${fixture.companyId}/cost`],
      ['GET', '/api/control/cost'],
      ['GET', `/api/companies/${fixture.companyId}/governance`],
      ['GET', `/api/companies/${fixture.companyId}/tasks/${fixture.companyId}/events`],
      ['POST',
        `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials/x/rotate`],
      ['POST', `/api/companies/${fixture.companyId}/inbox/${fixture.companyId}/answer`],
    ];
    for (const [method, path] of paths) {
      const answer = await call(owner.url, method, path, { body: {} });
      assert.equal(answer.status, 401, `${method} ${path} answered ${answer.status}`);
    }
  } finally {
    await owner.close();
  }
});

/* ------------------------------ the half that changes how a company is built --- */

/**
 * The goal ladder, edited by the owner.
 *
 * F2.7 makes every task hang from a goal, and F3.10 makes the ladder the
 * owner's. `createGoal` and `applyGoalChange` were both implemented and
 * neither had a route, so the direction of the company could be set only from
 * a `psql` prompt. Editing one redirects work already in flight, which is why
 * it takes the owner's device rather than their tab.
 */
test('the owner can build and redirect the goal ladder (F2.7, F3.10)', async () => {
  const fixture = await createCompany('console-goals');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/goals`;

    // The ladder is a ladder: an objective hangs from the level above it, and
    // the database says so rather than this route. A key result parented to a
    // mission is refused, which is the answer the owner should see.
    const skippedRung = await call(owner.url, 'POST', base, {
      token,
      body: {
        kind: 'key_result',
        slug: 'straight-to-the-top',
        statement: 'Skip a rung.',
        parentGoalId: (await call(owner.url, 'GET', `${base}/${fixture.goalId}`, { token }))
          .body.parentGoalId,
      },
    });
    assert.equal(skippedRung.status, 400, JSON.stringify(skippedRung.body));

    const objective = await call(owner.url, 'POST', base, {
      token,
      body: {
        kind: 'objective',
        slug: 'ship-the-thing',
        statement: 'Ship it this quarter.',
        parentGoalId: (await call(owner.url, 'GET', `${base}/${fixture.goalId}`, { token }))
          .body.parentGoalId,
      },
    });
    assert.equal(objective.status, 200, JSON.stringify(objective.body));

    // A kind the ladder does not have is refused by name rather than reaching
    // the database as a value nobody checked.
    const nonsense = await call(owner.url, 'POST', base, {
      token, body: { kind: 'vibe', slug: 'x', statement: 'y' },
    });
    assert.equal(nonsense.status, 400);
    assert.match(String(nonsense.body.error), /kind must be one of/);

    const goalId = String(objective.body.id);
    const without = await call(owner.url, 'POST', `${base}/${goalId}`, {
      token, body: { status: 'met' },
    });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    const withFactor = await call(owner.url, 'POST', `${base}/${goalId}`, {
      token, body: { status: 'met', proof: { totp: owner.code() } },
    });
    assert.equal(withFactor.status, 200, JSON.stringify(withFactor.body));
    assert.equal(
      (await call(owner.url, 'GET', `${base}/${goalId}`, { token })).body.status,
      'met',
    );
  } finally {
    await owner.close();
  }
});

/**
 * F2.9's structural changes, which are the owner's by definition.
 *
 * `applyGrantChange` and `applyRoleChange` both refuse without
 * `ownerApproved`, and this surface is the only caller that may pass `true` --
 * which makes the second factor the whole of the check. A route that passed
 * `true` off a session would have made the flag decorative.
 */
test('the owner can change a grant and a role, with their device (F2.9, F3.9)', async () => {
  const fixture = await createCompany('console-structure');
  // A grant is a foreign key into `capabilities`, so the capability has to be
  // registered before there is anything to change.
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { registerPlatformCapabilities: registerTools } =
    await import('../../src/broker/platform-capabilities.ts');
  const structureRegistry = new CapabilityRegistry();
  registerTools(structureRegistry);
  // Catalogued at tier 1, so there is something for a tightening to tighten
  // *from* and something a loosening would loosen below.
  structureRegistry.register({
    name: 'dns.update',
    adapter: 'test:dns',
    defaultTier: 1,
    async execute() { return {}; },
    async verify() { return true; },
  } as never);
  await structureRegistry.sync();
  await grantCapability(fixture, 'dns.update');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const grantPath = `/api/companies/${fixture.companyId}/structure/grant`;
    const without = await call(owner.url, 'POST', grantPath, {
      token,
      body: { divisionId: fixture.divisionId, capabilityName: 'dns.update', tierOverride: 2 },
    });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    const tightened = await call(owner.url, 'POST', grantPath, {
      token,
      body: {
        divisionId: fixture.divisionId,
        capabilityName: 'dns.update',
        tierOverride: 2,
        proof: { totp: owner.code() },
      },
    });
    assert.equal(tightened.status, 200, JSON.stringify(tightened.body));

    // F5.7: how many calls to it the division may have in flight at once.
    // Left out, it stays as it is; 0 takes the limit away.
    const grantOf = async () => ((await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/structure`, { token }))
      .body.divisions as Array<{ id: string; grants: Array<{ capability: string; tier: number | null; maxInFlight: number | null }> }>)
      .find((division) => division.id === fixture.divisionId)!.grants.find((grant) => grant.capability === 'dns.update');
    const limited = await call(owner.url, 'POST', grantPath, {
      token,
      body: { divisionId: fixture.divisionId, capabilityName: 'dns.update', tierOverride: 2, maxInFlight: 2, proof: { totp: owner.code() } },
    });
    assert.equal(limited.status, 200, JSON.stringify(limited.body));
    assert.deepEqual(await grantOf(), { capability: 'dns.update', tier: 2, maxInFlight: 2 });
    const kept = await call(owner.url, 'POST', grantPath, {
      token,
      body: { divisionId: fixture.divisionId, capabilityName: 'dns.update', tierOverride: 2, proof: { totp: owner.code() } },
    });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal((await grantOf())!.maxInFlight, 2, 'a change that does not name it leaves the limit alone');
    const nonsense = await call(owner.url, 'POST', grantPath, {
      token,
      body: { divisionId: fixture.divisionId, capabilityName: 'dns.update', tierOverride: 2, maxInFlight: 1.5, proof: { totp: owner.code() } },
    });
    assert.equal(nonsense.status, 400, JSON.stringify(nonsense.body));
    // A place is a row made the first time it is wanted: a limit in the millions was a million rows.
    const huge = await call(owner.url, 'POST', grantPath, {
      token,
      body: { divisionId: fixture.divisionId, capabilityName: 'dns.update', tierOverride: 2, maxInFlight: 2_000_000, proof: { totp: owner.code() } },
    });
    assert.equal(huge.status, 400, JSON.stringify(huge.body));
    assert.match(JSON.stringify(huge.body), /at most 100 calls at once/);
    const lifted = await call(owner.url, 'POST', grantPath, {
      token,
      body: { divisionId: fixture.divisionId, capabilityName: 'dns.update', tierOverride: 2, maxInFlight: 0, proof: { totp: owner.code() } },
    });
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
    assert.equal((await grantOf())!.maxInFlight, null);

    // F8.3 still holds through this surface: a grant may tighten and never
    // loosen, and the database is what says so.
    const loosened = await call(owner.url, 'POST', grantPath, {
      token,
      body: {
        divisionId: fixture.divisionId,
        capabilityName: 'dns.update',
        tierOverride: 0,
        proof: { totp: owner.code() },
      },
    });
    assert.equal(loosened.status, 400, JSON.stringify(loosened.body));

    const rolePath = `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`;
    const empty = await call(owner.url, 'POST', rolePath, {
      token, body: { proof: { totp: owner.code() } },
    });
    assert.equal(empty.status, 400, JSON.stringify(empty.body));

    const changed = await call(owner.url, 'POST', rolePath, {
      token,
      body: {
        systemPrompt: 'You coordinate, and you say what you are doing.',
        summary: 'clearer charter',
        proof: { totp: owner.code() },
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(typeof changed.body.version, 'number');
  } finally {
    await owner.close();
  }
});

test('the owner moves a role to another runtime, and only to one this deployment runs (F13.1)', async () => {
  // Every role a template creates names the in-process runtime, and nothing
  // the owner could reach changed it: a company whose owner had configured
  // Claude Code could not put a single role on it without writing SQL.
  const fixture = await createCompany('console-runtime');
  const runtime = (name: string, health: () => Promise<{ ok: boolean; detail?: string }>): Adapter => ({
    name, backends: ['local'], health, async run() { return { output: {} }; },
  });
  const adapters = new AdapterRegistry();
  adapters.register(runtime('claude-code', async () => ({ ok: true, detail: 'claude 2.1' })));
  adapters.register(runtime('in-process', async () => { throw new Error('no model answers'); }));
  const owner = await console_({ runtimes: adapters });
  try {
    const token = await signIn(owner.url, owner.code());
    const listed = await call(owner.url, 'GET', '/api/runtimes', { token });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.runtimes, [
      { name: 'claude-code', backends: ['local'], ok: true, detail: 'claude 2.1' },
      { name: 'in-process', backends: ['local'], ok: false, detail: 'no model answers' },
    ], 'a health check that throws has failed, and says why');

    const rolePath = `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`;
    const unknown = await call(owner.url, 'POST', rolePath, {
      token, body: { runtime: 'codex', proof: { totp: owner.code() } },
    });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /no runtime named codex runs here; this deployment runs claude-code, in-process/);

    const moved = await call(owner.url, 'POST', rolePath, {
      token, body: { runtime: 'claude-code', proof: { totp: owner.code() } },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const runtimeNow = async () => (await withTenantTx(fixture.companyId, (tx) => tx.query<{ runtime: string }>(
      'SELECT runtime FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!.runtime;
    assert.equal(await runtimeNow(), 'claude-code');

    // A change of runtime is a change like any other: versioned, and undone
    // by putting the version back (F3.9).
    await rollBack(fixture.companyId, 'role', fixture.roleId, Number(moved.body.version));
    assert.equal(await runtimeNow(), 'in-process');
  } finally {
    await owner.close();
  }
});

test('the owner can write a policy, and cannot write one the engine cannot read (F3.4)', async () => {
  const fixture = await createCompany('console-policy');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const written = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
        proof: { totp: owner.code() },
        slug: 'external-mail-is-the-owners',
        effect: 'require_approval',
        companyId: fixture.companyId,
        condition: { field: 'recipient_domain', op: 'not_in', value: ['acme.example'] },
      },
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));

    // An effect the engine does not know would be stored happily and enforce
    // nothing: a policy row that reads as a rule and is not one.
    const unknown = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
        proof: { totp: owner.code() },
        slug: 'nonsense', effect: 'shrug', companyId: fixture.companyId,
        condition: { field: 'tier', op: 'gte', value: 2 },
      },
    });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.match(String(unknown.body.error), /effect must be one of/);

    // And a condition the grammar refuses is refused here rather than stored.
    const bad = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
        proof: { totp: owner.code() },
        slug: 'bad-condition', effect: 'deny', companyId: fixture.companyId,
        condition: { field: 'whatever', op: 'eq', value: 1 },
      },
    });
    assert.equal(bad.status >= 400, true, JSON.stringify(bad.body));

    const log = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/governance`, { token },
    );
    assert.ok((log.body.log as unknown[]).length > 0, 'the change was not recorded');
  } finally {
    await owner.close();
  }
});

/**
 * F3.6 makes the charters the owner's to write, and nothing let the owner
 * write one: the only writer was a file import the boot never ran. Both are
 * read on one page, because a company charter is read under the platform's,
 * and either is changed with the owner's device -- every run is told them
 * first, so a session alone could otherwise rewrite what every agent obeys.
 */
/**
 * The guardian (row 7 of the competitive analysis of 2026-09-30): on with the
 * session, since it only ever asks the owner more, and off only with their
 * device, since that loosens.
 */
test('the owner turns the guardian on with a session, and off only with a factor (row 7)', async () => {
  const fixture = await createCompany('console-guardian');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/guardian`;
    const guarded = async () => ((await call(owner.url, 'GET', '/api/companies', { token })).body.companies as Array<{ id: string; guardian: boolean }>)
      .find((company) => company.id === fixture.companyId)!.guardian;
    assert.equal(await guarded(), false, 'off as every company starts');

    const on = await call(owner.url, 'POST', path, { token, body: { on: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(await guarded(), true);

    const unproven = await call(owner.url, 'POST', path, { token, body: { on: false } });
    assert.equal(unproven.status, 403, JSON.stringify(unproven.body));
    assert.equal(await guarded(), true);
    const vague = await call(owner.url, 'POST', path, { token, body: { on: 'no' } });
    assert.equal(vague.status, 400, JSON.stringify(vague.body));

    const off = await call(owner.url, 'POST', path, { token, body: { on: false, proof: { totp: owner.code() } } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(await guarded(), false);
  } finally {
    await owner.close();
  }
});

test('the owner reads both charters and rewrites either with a factor (F3.1, F3.6)', async () => {
  const fixture = await createCompany('console-charter');
  // F3.11: the deployment's repository of charters, which a save writes at once.
  const tree = join(await mkdtemp(join(tmpdir(), 'palugada-console-tree-')), 'charters');
  const owner = await console_({ charters: new CharterRepository({ root: tree }) });
  try {
    const token = await signIn(owner.url, owner.code());
    const company = `/api/companies/${fixture.companyId}/charter`;

    const none = await call(owner.url, 'GET', company, { token });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual(none.body, { company: null, platform: null });

    const unproven = await call(owner.url, 'POST', company, { token, body: { body: 'Answer within a day.' } });
    assert.equal(unproven.status, 403, JSON.stringify(unproven.body));
    // Checked before the factor, so a blank or runaway charter costs a
    // correction rather than a code.
    const blank = await call(owner.url, 'POST', company, { token, body: { body: '  \n ' } });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));
    const long = await call(owner.url, 'POST', company, { token, body: { body: 'x'.repeat(20_001) } });
    assert.equal(long.status, 400, JSON.stringify(long.body));
    assert.match(String(long.body.error), /20000 characters/);
    const nobody = await call(owner.url, 'POST', '/api/companies/00000000-0000-4000-8000-000000000000/charter', {
      token, body: { body: 'Answer within a day.' },
    });
    assert.equal(nobody.status, 400, JSON.stringify(nobody.body));
    assert.match(String(nobody.body.error), /no company with that id/);

    const written = await call(owner.url, 'POST', company, {
      token, body: { body: '  Answer within a day.\n', proof: { totp: owner.code() } },
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.deepEqual(written.body, { version: 1, unchanged: false, file: null });
    assert.equal(await readFile(join(tree, 'companies', fixture.slug, 'SOUL.md'), 'utf8'), 'Answer within a day.\n');

    // The same words again are not a new version, and ask for nothing.
    const same = await call(owner.url, 'POST', company, { token, body: { body: 'Answer within a day.' } });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual(same.body, { version: 1, unchanged: true });

    const platform = await call(owner.url, 'POST', '/api/control/charter', {
      token, body: { body: 'Never deceive anyone.', proof: { totp: owner.code() } },
    });
    assert.equal(platform.status, 200, JSON.stringify(platform.body));
    assert.deepEqual(platform.body, { version: 1, unchanged: false, file: null });
    assert.equal(await readFile(join(tree, 'PLATFORM.md'), 'utf8'), 'Never deceive anyone.\n');

    const both = await call(owner.url, 'GET', company, { token });
    const read = both.body as { company: { version: number; body: string; createdAt: string }; platform: { version: number; body: string } };
    assert.equal(read.company.version, 1);
    assert.equal(read.company.body, 'Answer within a day.');
    assert.ok(!Number.isNaN(Date.parse(read.company.createdAt)));
    assert.equal(read.platform.version, 1);
    assert.equal(read.platform.body, 'Never deceive anyone.');

    // And another company's page shows the platform's, never this one's.
    const other = await createCompany('console-charter-other');
    const theirs = await call(owner.url, 'GET', `/api/companies/${other.companyId}/charter`, { token });
    assert.equal((theirs.body as { company: unknown }).company, null);
    assert.equal((theirs.body as { platform: { body: string } }).platform.body, 'Never deceive anyone.');

    // A file that cannot be kept does not undo the save, and the owner is
    // told so then, not only at the next boot.
    const soul = join(tree, 'companies', fixture.slug, 'SOUL.md');
    await rm(soul);
    await symlink(join(tree, '..', 'elsewhere.txt'), soul);
    const unkept = await call(owner.url, 'POST', company, {
      token, body: { body: 'Answer within the hour.', proof: { totp: owner.code() } },
    });
    assert.equal(unkept.status, 200, JSON.stringify(unkept.body));
    assert.equal(unkept.body.version, 2, 'the charter is saved, and runs are told it');
    assert.match(String(unkept.body.file), /^Not written to its file: it is a link, and a link is never followed/);
  } finally {
    await owner.close();
  }
});

test('the owner can see and scope a skill, and lifting quarantine takes a factor (F15)', async () => {
  const fixture = await createCompany('console-skills');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/skills`;

    const list = await call(owner.url, 'GET', base, { token });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(Array.isArray(list.body.skills));

    // A skill from outside, unsigned, which is what quarantine is for.
    const imported = await call(owner.url, 'POST', `${base}/import`, {
      token,
      body: {
        slug: 'cold-outreach',
        origin: 'https://hub.example/cold-outreach',
        divisionId: fixture.divisionId,
        source: [
          '---', 'name: cold-outreach',
          'description: How to open a cold conversation.',
          'triggers: [outreach]', '---', '', 'Say who you are first.', '',
        ].join('\n'),
      },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const skillId = String(imported.body.skillId ?? imported.body.id);

    const without = await call(owner.url, 'POST', `${base}/${skillId}/quarantine/lift`, {
      token, body: {},
    });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    const lifted = await call(owner.url, 'POST', `${base}/${skillId}/quarantine/lift`, {
      token, body: { proof: { totp: owner.code() } },
    });
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));

    // A scope target is built, not cast: `setSkillScope` reads `scopeType`,
    // and a division target without an id is refused here rather than
    // silently widening the skill.
    const missing = await call(owner.url, 'POST', `${base}/${skillId}/scope`, {
      token, body: { scopeType: 'division', proof: { totp: owner.code() } },
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.match(String(missing.body.error), /scopeId is required/);
  } finally {
    await owner.close();
  }
});

test('the owner can trust and revoke a bundle publisher (F16.2)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const without = await call(owner.url, 'POST', '/api/publishers', {
      token, body: { publicKeyPem: pem, label: 'a partner' },
    });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    const trusted = await call(owner.url, 'POST', '/api/publishers', {
      token, body: { publicKeyPem: pem, label: 'a partner', proof: { totp: owner.code() } },
    });
    assert.equal(trusted.status, 200, JSON.stringify(trusted.body));
    const fingerprint = String(trusted.body.fingerprint);

    const listed = await call(owner.url, 'GET', '/api/publishers', { token });
    assert.ok(
      (listed.body.publishers as Array<{ fingerprint: string }>)
        .some((publisher) => publisher.fingerprint === fingerprint),
    );

    // Revoking needs no factor. It only ever narrows what this installation
    // accepts, and a revocation somebody hesitates over happens too late.
    const revoked = await call(
      owner.url, 'POST', `/api/publishers/${fingerprint}/revoke`, { token, body: {} },
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.notEqual(
      (await call(owner.url, 'GET', '/api/publishers', { token })
      ).body.publishers &&
        ((await call(owner.url, 'GET', '/api/publishers', { token })).body.publishers as
          Array<{ fingerprint: string; revokedAt: string | null }>)
          .find((publisher) => publisher.fingerprint === fingerprint)?.revokedAt,
      null,
    );
  } finally {
    await owner.close();
  }
});

test('the owner can register, pair and revoke a device (F12.7, F12.10)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const fixture = await createCompany('console-devices');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/devices`;

    const registered = await call(owner.url, 'POST', base, {
      token, body: { name: 'the laptop', runtime: 'claude-code', publicKeyPem: pem },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const deviceId = String(registered.body.id);

    const fingerprint = String(registered.body.keyFingerprint);
    const without = await call(owner.url, 'POST', `${base}/${deviceId}/pair`, {
      token, body: { keyFingerprint: fingerprint },
    });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    // A pairing names the key it trusts, and one that does not is refused
    // before the code is spent: the same code still works afterwards.
    const code = owner.code();
    const unnamed = await call(owner.url, 'POST', `${base}/${deviceId}/pair`, {
      token, body: { proof: { totp: code } },
    });
    assert.equal(unnamed.status, 400, JSON.stringify(unnamed.body));
    const wrongKey = await call(owner.url, 'POST', `${base}/${deviceId}/pair`, {
      token, body: { keyFingerprint: '0000000000000000', proof: { totp: code } },
    });
    assert.equal(wrongKey.body.code, 'gateway.key_mismatch', JSON.stringify(wrongKey.body));

    const paired = await call(owner.url, 'POST', `${base}/${deviceId}/pair`, {
      token,
      body: { keyFingerprint: fingerprint, proof: { totp: owner.code() } },
    });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));

    const challenge = await call(
      owner.url, 'POST', `${base}/${deviceId}/challenge`, { token, body: {} },
    );
    assert.equal(challenge.status, 200);
    assert.equal(typeof challenge.body.nonce, 'string');

    const revoked = await call(
      owner.url, 'POST', `${base}/${deviceId}/revoke`, { token, body: {} },
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  } finally {
    await owner.close();
  }
});

test('the owner can read a role\'s eval set and its last score (F17.1, F17.3)', async () => {
  const fixture = await createCompany('console-evals');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const answer = await call(
      owner.url, 'GET',
      `/api/companies/${fixture.companyId}/roles/${fixture.roleId}/evals`, { token },
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.ok(Array.isArray(answer.body.cases));

    // A change the eval set does not know is refused by name: `charter`,
    // `skills` and `model_routing` are what F17.2 scores.
    const nonsense = await call(
      owner.url, 'POST',
      `/api/companies/${fixture.companyId}/roles/${fixture.roleId}/change-request`,
      { token, body: { change: 'vibes', tools: [], summary: 'x' } },
    );
    assert.equal(nonsense.status, 400, JSON.stringify(nonsense.body));
    assert.match(String(nonsense.body.error), /change must be one of/);
  } finally {
    await owner.close();
  }
});

test('the owner can read reviews, set thresholds and export the company (F7.5, F11.6, F16.4)', async () => {
  const fixture = await createCompany('console-rest');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const reviews = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/reviews`, { token },
    );
    assert.equal(reviews.status, 200);
    assert.ok(Array.isArray(reviews.body.reviews));

    const thresholds = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/alert-thresholds`,
      { token, body: { dailyCostCents: 5_000 } },
    );
    assert.equal(thresholds.status, 200, JSON.stringify(thresholds.body));

    const none = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/alert-thresholds`,
      { token, body: {} },
    );
    assert.equal(none.status, 400, JSON.stringify(none.body));

    const exported = await call(
      owner.url, 'GET', `/api/companies/${fixture.companyId}/export`, { token },
    );
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.ok(exported.body.sections, 'the export carried no sections');
    // Prompts are opt-in: an audit export usually needs to show that a call
    // happened, not what was said, and the smaller archive is the safer one to
    // hand over.
    assert.equal(typeof exported.body.summary, 'object');
  } finally {
    await owner.close();
  }
});

test('every route in the second block needs a session too (F10, F12.5)', async () => {
  const fixture = await createCompany('console-unauthenticated-2');
  const owner = await console_();
  try {
    const paths: Array<[string, string]> = [
      ['GET', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`],
      ['POST', `/api/companies/${fixture.companyId}/goals`],
      ['POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`],
      ['POST', `/api/companies/${fixture.companyId}/structure/grant`],
      ['POST', `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`],
      ['POST', `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/escalation`],
      ['POST', '/api/policies'],
      ['GET', `/api/companies/${fixture.companyId}/charter`],
      ['POST', `/api/companies/${fixture.companyId}/charter`],
      ['POST', '/api/control/charter'],
      ['GET', `/api/companies/${fixture.companyId}/skills`],
      ['POST', `/api/companies/${fixture.companyId}/skills/import`],
      ['POST', `/api/companies/${fixture.companyId}/skills/x/scope`],
      ['POST', `/api/companies/${fixture.companyId}/skills/x/quarantine/lift`],
      ['POST', `/api/companies/${fixture.companyId}/skills/versions/x/approve`],
      ['POST', `/api/companies/${fixture.companyId}/skills/versions/x/review`],
      ['GET', '/api/publishers'],
      ['POST', '/api/publishers'],
      ['POST', '/api/publishers/x/revoke'],
      ['POST', `/api/companies/${fixture.companyId}/bundles`],
      ['GET', `/api/companies/${fixture.companyId}/bundles/x/verify`],
      ['POST', `/api/companies/${fixture.companyId}/devices`],
      ['POST', `/api/companies/${fixture.companyId}/devices/x/pair`],
      ['POST', `/api/companies/${fixture.companyId}/devices/x/revoke`],
      ['POST', `/api/companies/${fixture.companyId}/devices/x/challenge`],
      ['GET', `/api/companies/${fixture.companyId}/roles/${fixture.roleId}/evals`],
      ['POST', `/api/companies/${fixture.companyId}/evals/x/accept`],
      ['POST', `/api/companies/${fixture.companyId}/roles/${fixture.roleId}/change-request`],
      ['GET', `/api/companies/${fixture.companyId}/reviews`],
      ['POST', `/api/companies/${fixture.companyId}/schedules`],
      ['POST', `/api/companies/${fixture.companyId}/alert-thresholds`],
      ['GET', `/api/companies/${fixture.companyId}/export`],
      ['POST', '/api/control/cancel-everything'],
    ];
    for (const [method, path] of paths) {
      const answer = await call(owner.url, method, path, { body: {} });
      assert.equal(answer.status, 401, `${method} ${path} answered ${answer.status}`);
    }
  } finally {
    await owner.close();
  }
});

/* --------------------------------------------- what the fifth review found --- */

/**
 * `revoke` means revoke, whatever else the body carries.
 *
 * The first version read the flag only when no `tierOverride` was sent, so
 * `{ revoke: true, tierOverride: null }` became a *change* to an unlimited
 * grant. Nothing downstream would have caught it either: the database's
 * loosening trigger returns early on NULL, so a request to take a capability
 * away would have handed it over without a ceiling.
 */
test('a revoke with a tier in the body still revokes (F3.9)', async () => {
  const fixture = await createCompany('console-revoke');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { registerPlatformCapabilities: registerTools } =
    await import('../../src/broker/platform-capabilities.ts');
  const registry = new CapabilityRegistry();
  registerTools(registry);
  await registry.sync();
  await grantCapability(fixture, 'memory.search');

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const revoked = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/structure/grant`,
      {
        token,
        body: {
          divisionId: fixture.divisionId,
          capabilityName: 'memory.search',
          revoke: true,
          tierOverride: null,
          proof: { totp: owner.code() },
        },
      },
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

    const { withTenant: tenant } = await import('../../src/db/tenant.ts');
    const left = await tenant(fixture.companyId, async (tx) => {
      const { rowCount } = await tx.query(
        'SELECT 1 FROM capability_grants WHERE division_id = $1 AND capability_name = $2',
        [fixture.divisionId, 'memory.search'],
      );
      return rowCount ?? 0;
    });
    assert.equal(left, 0, 'the revocation granted instead');
  } finally {
    await owner.close();
  }
});

/**
 * A refusal from a validator is a refusal, not a crash.
 *
 * `assertValidCondition`, `assertValidCron` and `putPolicy`'s division check
 * all threw a plain `Error`, which reaches the owner as `500 internal error` --
 * so a typo in a cron expression or a policy field looked like a broken
 * console. They are `PalugadaError` now, at the source rather than in this
 * surface, so the chat channel and an operator's script get the same sentence.
 */
test('a bad condition and a bad cron are refused by name, not as a crash (F3.4, F9.1)', async () => {
  const fixture = await createCompany('console-refusals');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const field = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
        proof: { totp: owner.code() },
        slug: 'unknown-field', effect: 'deny', companyId: fixture.companyId,
        condition: { field: 'whatever', op: 'eq', value: 1 },
      },
    });
    assert.equal(field.status, 400, JSON.stringify(field.body));
    assert.match(String(field.body.error), /unknown field whatever/);

    const scoped = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
        proof: { totp: owner.code() },
        slug: 'division-without-company', effect: 'deny', divisionId: fixture.divisionId,
        condition: { field: 'tier', op: 'gte', value: 2 },
      },
    });
    assert.equal(scoped.status, 400, JSON.stringify(scoped.body));
    assert.match(String(scoped.body.error), /must also name its company/);

    const cron = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/schedules`,
      {
        token,
        body: {
          projectId: fixture.projectId,
          divisionId: fixture.divisionId,
          roleId: fixture.roleId,
          slug: 'nightly',
          cronExpression: 'not a cron expression',
        },
      },
    );
    assert.equal(cron.status, 400, JSON.stringify(cron.body));
    assert.match(String(cron.body.error), /invalid cron expression/);
  } finally {
    await owner.close();
  }
});

/**
 * An escalation that goes straight to the owner can actually be set.
 *
 * `coalesce($2, escalation_role_slug)` cannot say "set this to null", and null
 * is a real setting here -- it means the division does not hold the item at
 * all. The API answered `{ ok: true }`, recorded an event, and left the
 * division escalating to whatever it escalated to before.
 */
test('an escalation policy can be set to nobody (F2.6)', async () => {
  const fixture = await createCompany('console-escalation');
  const { withTenant: tenant } = await import('../../src/db/tenant.ts');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/escalation`;

    await call(owner.url, 'POST', path, {
      token, body: { roleSlug: 'coordinator', afterMinutes: 30 },
    });
    const set = await tenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ slug: string | null; minutes: number }>(
        `SELECT escalation_role_slug AS slug, escalate_after_minutes AS minutes
           FROM divisions WHERE id = $1`,
        [fixture.divisionId],
      );
      return rows[0]!;
    });
    assert.equal(set.slug, 'coordinator');

    const cleared = await call(owner.url, 'POST', path, { token, body: { roleSlug: null } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    const after = await tenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ slug: string | null; minutes: number }>(
        `SELECT escalation_role_slug AS slug, escalate_after_minutes AS minutes
           FROM divisions WHERE id = $1`,
        [fixture.divisionId],
      );
      return rows[0]!;
    });
    assert.equal(after.slug, null, 'the division still escalates to a role');
    assert.equal(after.minutes, 30, 'a field nobody named was changed');

    const nothing = await call(owner.url, 'POST', path, { token, body: {} });
    assert.equal(nothing.status, 400, JSON.stringify(nothing.body));
  } finally {
    await owner.close();
  }
});

test('a role field cannot be set to the word "null" (F3.9)', async () => {
  const fixture = await createCompany('console-role-null');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`;

    // `String(null)` is the four letters "null", and a role whose
    // `model_primary` is that string fails every later run.
    const nulled = await call(owner.url, 'POST', path, {
      token, body: { modelPrimary: null, proof: { totp: owner.code() } },
    });
    assert.equal(nulled.status, 400, JSON.stringify(nulled.body));
    assert.match(String(nulled.body.error), /modelPrimary is required/);

    const listOfNulls = await call(owner.url, 'POST', path, {
      token, body: { tools: ['web.fetch', null], proof: { totp: owner.code() } },
    });
    assert.equal(listOfNulls.status, 400, JSON.stringify(listOfNulls.body));
    assert.match(String(listOfNulls.body.error), /tools\[1\] is required/);
  } finally {
    await owner.close();
  }
});

/**
 * What done means is the owner's to change from the console (L5): a role
 * held to a criterion its deployment cannot meet otherwise fails every task,
 * and hiring it again was the only way out.
 */
test('the owner changes what done means for a role, with the device (F2.8)', async () => {
  const fixture = await createCompany('console-role-done');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`;
    const criteria = ['the output names every draft it made', 'nothing was sent that was not drafted first'];

    const unproven = await call(owner.url, 'POST', path, { token, body: { doneCriteria: criteria } });
    assert.equal(unproven.status, 403, JSON.stringify(unproven.body));
    const one = await call(owner.url, 'POST', path, {
      token, body: { doneCriteria: 'the output names every draft it made', proof: { totp: owner.code() } },
    });
    assert.equal(one.status, 400, 'a list, one criterion each');
    assert.match(String(one.body.error), /doneCriteria must be an array/);
    const nulled = await call(owner.url, 'POST', path, {
      token, body: { doneCriteria: ['the output names every draft it made', null], proof: { totp: owner.code() } },
    });
    assert.equal(nulled.status, 400, JSON.stringify(nulled.body));
    assert.match(String(nulled.body.error), /doneCriteria\[1\] must be text/);

    const changed = await call(owner.url, 'POST', path, { token, body: { doneCriteria: criteria, proof: { totp: owner.code() } } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const role = (await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/structure`, { token })).body as {
      roles: Array<{ id: string; doneCriteria: string[] }>;
    };
    assert.deepEqual(role.roles.find((one) => one.id === fixture.roleId)!.doneCriteria, criteria);
  } finally {
    await owner.close();
  }
});

test('installing a bundle takes a factor, like every other structural change (F16, F2.9)', async () => {
  // An install writes divisions, roles and capability grants, including tier 3
  // ones. A session is a browser tab.
  const fixture = await createCompany('console-bundle-factor');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const answer = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/bundles`,
      { token, body: { slug: 'content-ops', version: '1.0.0' } },
    );
    assert.equal(answer.status, 403, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'approval.channel_forbidden');
  } finally {
    await owner.close();
  }
});

test('a skill review with no verdict does not silently reject (F15.4)', async () => {
  // `body.approved === true` made rejection the default, and
  // `approveSkillVersion` refuses a rejected version forever afterwards -- so
  // a POST that forgot the field would have destroyed the skill.
  const fixture = await createCompany('console-review-default');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const answer = await call(
      owner.url, 'POST',
      `/api/companies/${fixture.companyId}/skills/versions/`
        + '11111111-1111-1111-1111-111111111111/review',
      { token, body: {} },
    );
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.match(String(answer.body.error), /approved must be true or false/);
  } finally {
    await owner.close();
  }
});

test('a threshold of null is not a threshold of zero (F11.6)', async () => {
  // `Number(null)`, `Number('')` and `Number([])` are all zero, and a daily
  // cost ceiling of zero makes the alert fire every day.
  const fixture = await createCompany('console-threshold-null');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    for (const value of [null, '', []] as unknown[]) {
      const answer = await call(
        owner.url, 'POST', `/api/companies/${fixture.companyId}/alert-thresholds`,
        { token, body: { dailyCostCents: value } },
      );
      assert.equal(answer.status, 400, `${JSON.stringify(value)}: ${JSON.stringify(answer.body)}`);
    }
  } finally {
    await owner.close();
  }
});

test('an empty goal edit does not spend the owner\'s code (F2.7)', async () => {
  // A TOTP code is one-shot. An empty edit that reached the factor would spend
  // it, write a `goal.changed` event, change nothing, and leave the owner
  // needing a fresh code for the real attempt.
  const fixture = await createCompany('console-goal-empty');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const code = owner.code();
    const empty = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`,
      { token, body: { proof: { totp: code } } },
    );
    assert.equal(empty.status, 400, JSON.stringify(empty.body));

    // The same code still works, which is the proof it was not spent.
    const real = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}`,
      { token, body: { statement: 'Be useful, on purpose.', proof: { totp: code } } },
    );
    assert.equal(real.status, 200, JSON.stringify(real.body));
  } finally {
    await owner.close();
  }
});

/**
 * Signs in to a deployment the test started.
 *
 * A fresh deployment has no authenticator enrolled -- and says so at boot,
 * which is F12.5 working -- so a test that wants a session has to enrol one
 * first. The clock moves rather than the step number, for the same reason
 * `console_()` does: `TOTP_DRIFT_STEPS` is one, so a test needing several
 * codes needs several minutes.
 */
async function signInTo(
  deployment: { url: string; mfa: OwnerMfa },
  secret: string,
): Promise<string> {
  await deployment.mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
  return signIn(deployment.url, totpCode(decodeBase32(secret), stepFor(new Date())));
}

/* ------------------------------------------------------------------ F11.4 --- */

/**
 * The owner can replay a task, and nothing is done twice.
 *
 * `ReplayContext` used to be a narrower interface than `TaskContext`, which
 * made this module unusable from anywhere real: a `TaskHandler` -- the thing a
 * deployment writes and the engine runs -- did not fit it, so the only thing
 * that could be replayed was a handler written for the replayer. F11.4 is
 * about replaying *the platform's own* work, and a replay that can only replay
 * a test fixture is not that.
 */
test('the owner can replay a task the deployment ran (F11.4, F5.9)', async () => {
  const { start } = await import('../../src/main.ts');
  const { RecordingLlmClient } = await import('../../src/llm/client.ts');
  const { createRootTask, getTask } = await import('../../src/engine/tasks.ts');
  const { withTenant } = await import('../../src/db/tenant.ts');

  const fixture = await createCompany('deployment-replay');
  // Renamed to the fixture's own role, because the replay looks the handler up
  // by the role the task actually ran as.
  const roleSlug = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string }>(
      'SELECT slug FROM roles WHERE id = $1', [fixture.roleId],
    );
    return rows[0]!.slug;
  });

  let ran = 0;
  const handler = async (ctx: { step: <T>(
    name: string, kind: 'internal', input: unknown, fn: (key: string) => Promise<T>,
  ) => Promise<T> }) => {
    ran += 1;
    const decided = await ctx.step('decide', 'internal', { on: 'the thing' },
      async () => ({ answer: 'yes' }));
    return { decided };
  };

  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);

  const deployment = await start({
    port: 0,
    env: {},
    secrets,
    llm: new RecordingLlmClient(),
    handlers: new Map([[roleSlug, handler as never]]),
    worker: { companyId: fixture.companyId, idleMs: 50 },
  });

  try {
    const task = await createRootTask({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      input: { goal: 'something to replay' },
      createdBy: 'owner',
      reserveTokens: 10_000,
    });

    const deadline = Date.now() + 10_000;
    let status = task.status;
    while (Date.now() < deadline) {
      status = await withTenant(
        fixture.companyId, async (tx) => (await getTask(tx, task.id))!.status,
      );
      if (status === 'completed' || status === 'failed' || status === 'halted') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, 'completed', `the worker left the task ${status}`);
    const afterRun = ran;

    const token = await signInTo(deployment, secret);
    const replayed = await call(
      deployment.url, 'POST', `/api/companies/${fixture.companyId}/tasks/${task.id}/replay`,
      { token, body: {} },
    );
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.match(String(replayed.body.summary), /no divergence/);

    // The handler ran again -- that is what a replay is -- but its step came
    // from the journal rather than from doing the work. Nothing external is
    // reachable from `replayTask` at all: no broker, no model client, no
    // adapter is imported into that module.
    assert.equal(ran, afterRun + 1, 'the handler was not replayed');
    const report = replayed.body.report as { steps: unknown[]; divergences: unknown[] };
    assert.equal(report.divergences.length, 0);
    assert.ok(report.steps.length >= 1, 'no step was served from the journal');
    // And the console is told it can be: the button is offered for this task.
    const detail = await call(deployment.url, 'GET', `/api/companies/${fixture.companyId}/tasks/${task.id}`, { token });
    assert.equal(detail.body.replayable, true);
  } finally {
    await deployment.stop();
  }
});

test('a replay of a role this deployment does not run says so (F11.4)', async () => {
  const { start } = await import('../../src/main.ts');
  const { RecordingLlmClient } = await import('../../src/llm/client.ts');
  const { createRootTask } = await import('../../src/engine/tasks.ts');

  const fixture = await createCompany('deployment-replay-missing');
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);

  const deployment = await start({
    port: 0,
    env: {},
    secrets,
    llm: new RecordingLlmClient(),
    handlers: new Map([['somebody-else', async () => ({ done: true })]]),
    worker: { idleMs: 50 },
  });

  try {
    const task = await createRootTask({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      input: { goal: 'never run here' },
      createdBy: 'owner',
      reserveTokens: 10_000,
    });

    const token = await signInTo(deployment, secret);
    const answer = await call(
      deployment.url, 'POST', `/api/companies/${fixture.companyId}/tasks/${task.id}/replay`,
      { token, body: {} },
    );
    // Named, because "nothing happened" and "this deployment does not have
    // that role's handler" are different problems with different fixes.
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.match(String(answer.body.error), /no handler for role/);
    // A button that can only be refused is not offered: the replay of a role
    // run by a model, a CLI or a container is not this deployment's to do,
    // and on a deployment started by `npm start` that is every role.
    const detail = await call(deployment.url, 'GET', `/api/companies/${fixture.companyId}/tasks/${task.id}`, { token });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.replayable, false);
  } finally {
    await deployment.stop();
  }
});

/* ---------------------------------- what the owner still could not ask for --- */

/**
 * The owner can give a company something to do.
 *
 * Until this route existed they could approve, configure and inspect -- and
 * could not ask a company for anything. Every task in the platform came from a
 * schedule, an event or another agent. That is not one human running many
 * companies; it is one human watching them.
 *
 * F10.11 is not just "create a task" either: the role's dormancy is cleared
 * and the wake is queued as an assignment, which is exempt from coalescing.
 * The owner asking for something now and the system answering in four hours is
 * what F9.8 exists to rule out.
 */
test('the owner can assign work to a role (F10.11, F9.9)', async () => {
  const fixture = await createCompany('console-assign');
  const { withTenant: tenant } = await import('../../src/db/tenant.ts');

  // Dormant, which is the state an assignment has to cut through.
  await tenant(fixture.companyId, async (tx) => {
    await tx.query(
      "UPDATE roles SET dormant_until = now() + interval '4 hours' WHERE id = $1",
      [fixture.roleId],
    );
  });

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const assigned = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/assign`,
      {
        token,
        body: {
          projectId: fixture.projectId,
          divisionId: fixture.divisionId,
          roleId: fixture.roleId,
          goalId: fixture.goalId,
          goal: 'Write this month\'s summary.',
        },
      },
    );
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(typeof assigned.body.taskId, 'string');
    assert.equal(typeof assigned.body.wakeId, 'string');

    const state = await tenant(fixture.companyId, async (tx) => {
      const { rows: roles } = await tx.query<{ dormant_until: Date | null }>(
        'SELECT dormant_until FROM roles WHERE id = $1', [fixture.roleId],
      );
      const { rows: tasks } = await tx.query<{ status: string; input: Record<string, unknown> }>(
        'SELECT status, input FROM tasks WHERE id = $1', [assigned.body.taskId],
      );
      const { rows: wakes } = await tx.query<{ reason: string }>(
        'SELECT reason FROM wake_queue WHERE id = $1', [assigned.body.wakeId],
      );
      return { role: roles[0]!, task: tasks[0]!, wake: wakes[0]! };
    });

    assert.equal(state.role.dormant_until, null, 'the role is still asleep');
    assert.equal(state.task.status, 'pending');
    assert.deepEqual(state.task.input, { goal: 'Write this month\'s summary.' });
    assert.equal(state.wake.reason, 'assignment');

    // F2.7. A task that names no goal is refused by name rather than attached
    // to whichever goal happened to be first.
    const noGoal = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/assign`,
      {
        token,
        body: {
          projectId: fixture.projectId,
          divisionId: fixture.divisionId,
          roleId: fixture.roleId,
          goal: 'Something.',
        },
      },
    );
    assert.equal(noGoal.status, 400, JSON.stringify(noGoal.body));
    assert.match(String(noGoal.body.error), /goalId is required/);

    // And one with no instruction is a task nobody can judge the output of.
    const empty = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/assign`,
      {
        token,
        body: {
          projectId: fixture.projectId,
          divisionId: fixture.divisionId,
          roleId: fixture.roleId,
          goalId: fixture.goalId,
        },
      },
    );
    assert.equal(empty.status, 400, JSON.stringify(empty.body));
    assert.match(String(empty.body.error), /goal is required/);
  } finally {
    await owner.close();
  }
});

test('the owner can see what funds a role, and open an account (F1.2, F1.6)', async () => {
  const fixture = await createCompany('console-budget');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const budget = await call(
      owner.url, 'GET',
      `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}`
        + `/roles/${fixture.roleId}/budget`,
      { token },
    );
    assert.equal(budget.status, 200, JSON.stringify(budget.body));
    // F1.6's chain: the account that funds the work, and every one above it
    // that the spend also counts against.
    assert.ok(Array.isArray(budget.body.chain));
    assert.ok((budget.body.chain as string[]).includes(String(budget.body.accountId)));
    assert.equal(typeof (budget.body.snapshot as { tokensMax: number }).tokensMax, 'number');

    // An account below the company needs the one above it named: a ceiling
    // nothing rolls up to is not part of a tree.
    const orphan = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/budget-accounts`,
      { token, body: { label: 'ads', tokensMax: 1_000, scopeType: 'division',
        scopeId: fixture.divisionId, proof: { totp: owner.code() } } },
    );
    assert.equal(orphan.status, 400, JSON.stringify(orphan.body));
    assert.match(String(orphan.body.error), /parentAccountId is required/);

    // Opening an account sets a ceiling, which is money -- the same decision
    // as the spend limit, and a session is a browser tab.
    const noFactor = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/budget-accounts`,
      { token, body: { label: 'ads', tokensMax: 1_000 } },
    );
    assert.equal(noFactor.status, 403, JSON.stringify(noFactor.body));

    const opened = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/budget-accounts`,
      {
        token,
        body: {
          label: 'ads', tokensMax: 1_000, scopeType: 'division',
          scopeId: fixture.divisionId,
          parentAccountId: budget.body.chain![1] ?? budget.body.accountId,
          proof: { totp: owner.code() },
        },
      },
    );
    assert.equal(opened.status >= 200 && opened.status < 500, true, JSON.stringify(opened.body));
  } finally {
    await owner.close();
  }
});

/**
 * A company that has spent its token ceiling is revived from the console.
 * In the live run of 2026-09-28 (defect L11) the ceilings were for the
 * company's whole life: nothing but SQL raised one, and opening a new account
 * did not help, because a task draws on the chain it belongs to. A company
 * that spent its two million tokens stopped for good.
 */
test('an exhausted account is raised from the console with a factor, and work is funded again (F1.5, F1.6)', async () => {
  const { createRootTask } = await import('../../src/engine/tasks.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const fixture = await createCompany('console-exhausted', { tokensMax: 10_000 });
  const other = await createCompany('console-exhausted-other');
  const owner = await console_();
  const fund = () => createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Plan the October promotion' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  try {
    const token = await signIn(owner.url, owner.code());
    await withControlPlane((tx) => tx.query(
      'UPDATE budget_accounts SET tokens_spent = tokens_max WHERE id = $1', [fixture.budgetAccountId]));
    await assert.rejects(fund(), (error: unknown) =>
      (error as { code?: string }).code === 'budget.reservation_refused'
      && /Raise its ceiling under Money/.test((error as Error).message),
    'the refusal says where the way out is');

    const limit = `/api/companies/${fixture.companyId}/budget-accounts/${fixture.budgetAccountId}/limit`;
    const raised = { tokensMax: 20_000 };
    const withoutFactor = await call(owner.url, 'POST', limit, { token, body: raised });
    assert.equal(withoutFactor.status, 403, 'raising a ceiling loosens a control');

    const withFactor = await call(owner.url, 'POST', limit, { token, body: { ...raised, proof: { totp: owner.code() } } });
    assert.equal(withFactor.status, 200, JSON.stringify(withFactor.body));
    await fund();

    const listed = await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/budget-accounts`, { token });
    const account = (listed.body.accounts as Array<{ id: string; tokensMax: number }>)
      .find((one) => one.id === fixture.budgetAccountId)!;
    assert.equal(account.tokensMax, 20_000);

    // Lowering takes only the session, as the spend ceiling does.
    const lowered = await call(owner.url, 'POST', limit, { token, body: { tokensMax: 15_000 } });
    assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
    const moreMoney = await call(owner.url, 'POST', limit, { token, body: { tokensMax: 15_000, moneyMaxCents: 999_999_99 } });
    assert.equal(moreMoney.status, 403, 'more money is a raise too');

    // An account is the company's own: another's cannot be raised through it.
    const theirs = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/budget-accounts/${other.budgetAccountId}/limit`,
      { token, body: { tokensMax: 1, proof: { totp: owner.code() } } },
    );
    assert.equal(theirs.status, 400, JSON.stringify(theirs.body));
    const untouched = await withControlPlane((tx) => tx.query<{ tokens_max: string }>(
      'SELECT tokens_max FROM budget_accounts WHERE id = $1', [other.budgetAccountId]));
    assert.notEqual(Number(untouched.rows[0]!.tokens_max), 1);
  } finally {
    await owner.close();
  }
});

test('a fact is superseded rather than deleted (F4.6)', async () => {
  const { remember } = await import('../../src/memory/store.ts');
  const fixture = await createCompany('console-supersede');
  const { withTenant: tenant } = await import('../../src/db/tenant.ts');

  const original = await tenant(fixture.companyId, (tx) => remember(tx, {
    companyId: fixture.companyId,
    memoryType: 'semantic',
    scopeType: 'company',
    body: 'The hosting provider is Alpha.',
  }));

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const replaced = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/memories/${original}/supersede`,
      { token, body: { body: 'The hosting provider is Beta since September.' } },
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));

    // The old row stays and points at what replaced it. An agent that read it
    // yesterday, and a person asking why it did, are both better served by a
    // chain than by a hole.
    const chain = await tenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ id: string; superseded_by: string | null }>(
        'SELECT id, superseded_by FROM memories WHERE id = $1', [original],
      );
      return rows[0]!;
    });
    assert.equal(chain.superseded_by, replaced.body.id);

    // A correction that corrected nothing is a fault, not a no-op. Without
    // this a wrong id left the replacement in place as a second, unlinked
    // fact while the stale one stayed active -- so the platform believed both,
    // and the caller was told it had been fixed.
    const twice = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/memories/${original}/supersede`,
      { token, body: { body: 'A third opinion.' } },
    );
    assert.equal(twice.status, 400, JSON.stringify(twice.body));
    assert.match(String(twice.body.error), /already was|does not exist/);

    // The replacement takes the original's type and scope. Hardcoding
    // semantic/company meant correcting a division's procedure superseded the
    // old one and wrote something that was not a procedure -- so `recall`
    // found neither and the SOP vanished from every agent's context.
    const procedure = await tenant(fixture.companyId, (tx) => remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'procedural',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: 'Always quote before invoicing.',
    }));
    const corrected = await call(
      owner.url, 'POST', `/api/companies/${fixture.companyId}/memories/${procedure}/supersede`,
      { token, body: { body: 'Always quote before invoicing, and cc the owner.' } },
    );
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));

    const kept = await tenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{
        memory_type: string; scope_type: string; scope_id: string | null;
      }>(
        'SELECT memory_type, scope_type, scope_id FROM memories WHERE id = $1',
        [corrected.body.id],
      );
      return rows[0]!;
    });
    assert.equal(kept.memory_type, 'procedural', 'the procedure stopped being one');
    assert.equal(kept.scope_type, 'division');
    assert.equal(kept.scope_id, fixture.divisionId);

    // A correction says whose it is. The page shows where a fact came from,
    // and the owner's own correction read "not recorded".
    const told = await tenant(fixture.companyId, async (tx) => (await tx.query<{ source: string }>(
      'SELECT source FROM memories WHERE id = $1', [corrected.body.id],
    )).rows[0]!.source);
    assert.equal(told, 'owner');
  } finally {
    await owner.close();
  }
});

/**
 * The owner telling the company something, without waiting for it to learn:
 * a fact, or a way to work, for the company or one division. The owner's
 * word, so it is known at once -- full confidence, active, sourced to them --
 * and the next run of that division is told.
 */
test('the owner can tell the company a fact or a way to work', async () => {
  const fixture = await createCompany('console-tell');
  const other = await createCompany('console-tell-other');
  const { withTenant: tenant } = await import('../../src/db/tenant.ts');
  const { buildContext } = await import('../../src/context/builder.ts');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/memories`;

    const fact = await call(owner.url, 'POST', base, { token, body: { kind: 'semantic', body: 'Our prices include VAT.' } });
    assert.equal(fact.status, 200, JSON.stringify(fact.body));
    const procedure = await call(owner.url, 'POST', base, {
      token, body: { kind: 'procedural', body: 'Always quote in rupiah.', divisionId: fixture.divisionId },
    });
    assert.equal(procedure.status, 200, JSON.stringify(procedure.body));

    const rows = await tenant(fixture.companyId, async (tx) => (await tx.query<{
      id: string; memory_type: string; scope_type: string; confidence: number; source: string; approval_state: string;
    }>(
      'SELECT id, memory_type, scope_type, confidence, source, approval_state FROM memories ORDER BY created_at',
    )).rows);
    assert.deepEqual(rows.map((row) => [row.memory_type, row.scope_type, row.confidence, row.source, row.approval_state]), [
      ['semantic', 'company', 1, 'owner', 'active'],
      ['procedural', 'division', 1, 'owner', 'active'],
    ]);

    // The next run of that division is told both, the procedure as a
    // procedure and the fact as a known fact.
    const context = await tenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }));
    assert.ok(context.sections.some((section) => section.kind === 'sop' && section.body === 'Always quote in rupiah.'));
    assert.ok(context.sections.some((section) => /^Known fact/.test(section.title) && section.body === 'Our prices include VAT.'));

    // Not a kind the owner writes directly, and not another company's division.
    assert.equal((await call(owner.url, 'POST', base, { token, body: { kind: 'working', body: 'x' } })).status, 400);
    assert.equal((await call(owner.url, 'POST', base, {
      token, body: { kind: 'procedural', body: 'x', divisionId: other.divisionId },
    })).status, 400);
    assert.equal((await call(owner.url, 'POST', base, { token, body: { kind: 'semantic', body: '  ' } })).status, 400);
    // And a session is required, like everything else here.
    assert.equal((await call(owner.url, 'POST', base, { body: { kind: 'semantic', body: 'x' } })).status, 401);
  } finally {
    await owner.close();
  }
});

/**
 * The console's tour of itself opens until the owner finishes or skips it,
 * and the deployment remembers which, since the console stores nothing in
 * the browser: a tour that came back on every new phone would be one the
 * owner learns to dismiss unread.
 */
test('the tour is shown until the owner finishes it, on every device, and can be asked for again', async () => {
  const owner = await console_();
  try {
    assert.equal((await call(owner.url, 'GET', '/api/control/tour')).status, 401, 'the owner\'s, like everything else');
    const token = await signIn(owner.url, owner.code());
    assert.deepEqual((await call(owner.url, 'GET', '/api/control/tour', { token })).body, { finishedAt: null });

    const finished = await call(owner.url, 'POST', '/api/control/tour', { token, body: { finished: true } });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.ok(Date.now() - Date.parse(String(finished.body.finishedAt)) < 60_000);
    const elsewhere = await signIn(owner.url, owner.code());
    assert.equal((await call(owner.url, 'GET', '/api/control/tour', { token: elsewhere })).body.finishedAt, finished.body.finishedAt,
      'a second device does not see it again');

    assert.deepEqual((await call(owner.url, 'POST', '/api/control/tour', { token, body: { finished: false } })).body, { finishedAt: null });
    assert.equal((await call(owner.url, 'POST', '/api/control/tour', { token, body: { finished: 'yes' } })).status, 400);
  } finally {
    await owner.close();
  }
});

/**
 * Languages: the panel's, the agents' default, and each company's two
 * (src/domain/language.ts). Kept by the deployment, so the panel opens in
 * the owner's language on every device, and changed without a factor: a
 * language changes what is written, never what is allowed.
 */
test('the panel and the agents speak the languages the owner chose', async () => {
  const fixture = await createCompany('console-languages');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const initial = await call(owner.url, 'GET', '/api/control/languages', { token });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.console, null, 'the panel follows the browser until the owner chooses');
    assert.equal(initial.body.agents, 'en');
    const supported = initial.body.supported as Array<{ code: string; name: string; native: string }>;
    assert.ok(supported.some((one) => one.code === 'id' && one.native === 'Bahasa Indonesia'));

    const chosen = await call(owner.url, 'POST', '/api/control/languages', { token, body: { console: 'id', agents: 'id' } });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.deepEqual(chosen.body, { console: 'id', agents: 'id' });
    // Partial: naming one leaves the other.
    assert.deepEqual((await call(owner.url, 'POST', '/api/control/languages', { token, body: { console: null } })).body,
      { console: null, agents: 'id' });
    assert.equal((await call(owner.url, 'POST', '/api/control/languages', { token, body: { agents: 'klingon' } })).status, 400);
    assert.equal((await call(owner.url, 'POST', '/api/control/languages', { token, body: {} })).status, 400);

    const company = `/api/companies/${fixture.companyId}/languages`;
    const set = await call(owner.url, 'POST', company, { token, body: { work: 'en', talk: null } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body, { work: 'en', talk: 'id', workIsDefault: false, talkIsDefault: true });
    // Both are required: leaving one out is not the same as the default.
    const half = await call(owner.url, 'POST', company, { token, body: { work: 'en' } });
    assert.equal(half.status, 400);
    assert.match(String(half.body.error), /null means the default/);
    assert.equal((await call(owner.url, 'POST', company, { token, body: { work: 'xx', talk: null } })).status, 400);

    const listed = (await call(owner.url, 'GET', '/api/companies', { token })).body.companies as Array<Record<string, unknown>>;
    const mine = listed.find((one) => one.id === fixture.companyId)!;
    assert.equal(mine.workLanguage, 'en');
    assert.equal(mine.talkLanguage, null);

    // The change is in the company's own history.
    const { withTenant: tenant } = await import('../../src/db/tenant.ts');
    const events = await tenant(fixture.companyId, async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'company.languages_changed'",
    )).rows);
    assert.deepEqual(events.map((event) => event.payload), [{ work: 'en', talk: null }]);

    assert.equal((await call(owner.url, 'GET', '/api/control/languages')).status, 401);
  } finally {
    await owner.close();
  }
});

/**
 * The owner can start a company.
 *
 * "One human runs many companies" is what this platform is for, and the
 * console could not make one: a company arrived through the seed script or the
 * boot check, so the owner's second company needed a terminal.
 * `createCompanyFromTemplate` was called by those two and nothing else.
 *
 * A structural change if anything is -- divisions, roles, grants and a budget
 * tree in one transaction -- so it takes the owner's device.
 */
test('the owner can start a company from a template (section 5, F2)', async () => {
  const { installStandardTemplate } = await import('../../src/templates/standard.ts');
  const { saveTemplate } = await import('../../src/templates/company.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { registerPlatformCapabilities: registerTools } =
    await import('../../src/broker/platform-capabilities.ts');
  await installStandardTemplate();

  // What a first boot has: the capabilities the platform implements itself.
  const registry = new CapabilityRegistry();
  registerTools(registry);
  await registry.sync();

  // A template that grants only those. The standard one grants twenty-five,
  // and `createCompanyFromTemplate` refuses to grant a capability the broker
  // cannot run -- a company whose agents are refused the moment they try to
  // work is worse than no company.
  await saveTemplate({
    slug: 'starter',
    name: 'Starter',
    description: 'One division, using only what the platform implements itself.',
    body: {
      goals: [{ slug: 'mission', kind: 'mission', statement: 'Be useful.' }],
      divisions: [{ slug: 'ops', name: 'Operations' }],
      roles: [{
        slug: 'coordinator',
        division: 'ops',
        systemPrompt: 'You coordinate.',
        model: 'test-model',
        tools: ['memory.search'],
        outputSchema: { type: 'object' },
        doneCriteria: ['the run returns an output matching its schema'],
      }],
      grants: [{ division: 'ops', capability: 'memory.search' }],
      budget: { tokensMax: 100_000 },
    },
  });

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const without = await call(owner.url, 'POST', '/api/companies', {
      token,
      body: { templateSlug: 'starter', companySlug: 'acme', name: 'Acme' },
    });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    // A template that does not exist is named rather than arriving as a plain
    // error the owner reads as a broken console.
    const missing = await call(owner.url, 'POST', '/api/companies', {
      token,
      body: {
        templateSlug: 'no-such-template', companySlug: 'acme', name: 'Acme',
        proof: { totp: owner.code() },
      },
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.match(String(missing.body.error), /no company template named no-such-template/);

    // A template granting more than this deployment binds is refused with the
    // list, which is what an operator acts on -- not "internal error", which
    // tells them their console is broken when the platform has just told them
    // what to bind.
    const unbound = await call(owner.url, 'POST', '/api/companies', {
      token,
      body: {
        templateSlug: 'standard-company', companySlug: 'too-big', name: 'Too Big',
        proof: { totp: owner.code() },
      },
    });
    assert.equal(unbound.status, 400, JSON.stringify(unbound.body));
    assert.match(String(unbound.body.error), /capabilities that are not registered.*email\.send/);

    const created = await call(owner.url, 'POST', '/api/companies', {
      token,
      body: {
        templateSlug: 'starter', companySlug: 'acme', name: 'Acme',
        proof: { totp: owner.code() },
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok((created.body.divisions as string[]).length > 0, 'it has no divisions');
    assert.ok((created.body.roles as string[]).length > 0, 'it has no roles');

    // And it is in the list the console draws its tabs from.
    const listed = await call(owner.url, 'GET', '/api/companies', { token });
    assert.ok(
      (listed.body.companies as Array<{ id: string }>)
        .some((company) => company.id === created.body.companyId),
    );

    // A short name already taken is refused by name, as a conflict the owner
    // can fix, not as the database's "duplicate key value violates unique
    // constraint", which the console showed word for word.
    const again = await call(owner.url, 'POST', '/api/companies', {
      token,
      body: {
        templateSlug: 'starter', companySlug: 'acme', name: 'Acme Two',
        proof: { totp: owner.code() },
      },
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.code, 'company.slug_taken');
    assert.match(String(again.body.error), /a company already has the short name acme/);
    assert.doesNotMatch(String(again.body.error), /duplicate key|constraint/);
  } finally {
    await owner.close();
  }
});

/**
 * N7, the live run of 2 October: the owner read the console in Indonesian and
 * started a company, and its CEO and every agent wrote English -- creation
 * left the company's languages unset, the deployment's agent language was
 * English, and nothing asked. A company now starts in the languages the owner
 * chose for it, and in the owner's own language when they said nothing.
 */
test('a company starts in the languages its owner chose, and in the owner\'s own when they chose none (N7)', async () => {
  const { saveTemplate } = await import('../../src/templates/company.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { registerPlatformCapabilities: registerTools } = await import('../../src/broker/platform-capabilities.ts');
  const registry = new CapabilityRegistry();
  registerTools(registry);
  await registry.sync();
  await saveTemplate({
    slug: 'starter', name: 'Starter', description: 'One division.',
    body: {
      goals: [{ slug: 'mission', kind: 'mission', statement: 'Be useful.' }],
      divisions: [{ slug: 'ops', name: 'Operations' }],
      roles: [{
        slug: 'coordinator', division: 'ops', systemPrompt: 'You coordinate.', model: 'test-model',
        tools: ['memory.search'], outputSchema: { type: 'object' },
        doneCriteria: ['the run returns an output matching its schema'],
      }],
      grants: [{ division: 'ops', capability: 'memory.search' }],
      budget: { tokensMax: 100_000 },
    },
  });
  const languagesOf = async (companyId: string) => (await withControlPlane((tx) => tx.query<{ work: string | null; talk: string | null }>(
    'SELECT work_language AS work, talk_language AS talk FROM companies WHERE id = $1', [companyId]))).rows[0];

  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const start = (slug: string, more: Record<string, unknown> = {}) => call(owner.url, 'POST', '/api/companies', {
      token, body: { templateSlug: 'starter', companySlug: slug, name: slug, proof: { totp: owner.code() }, ...more },
    });

    // The owner reads the panel in Indonesian and says nothing more.
    await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id'"));
    const quiet = await start('kopi-senja');
    assert.equal(quiet.status, 200, JSON.stringify(quiet.body));
    assert.deepEqual(await languagesOf(quiet.body.companyId as string), { work: 'id', talk: 'id' });

    // Chosen: a company that sells in English and talks to its owner in Indonesian.
    const chosen = await start('export-desk', { workLanguage: 'en', talkLanguage: 'id' });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.deepEqual(await languagesOf(chosen.body.companyId as string), { work: 'en', talk: 'id' });

    // A language the console does not offer is named as such, before anything is made.
    const wrong = await start('nowhere', { workLanguage: 'klingon' });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    assert.match(String(wrong.body.error), /workLanguage must be one of/);
    assert.equal((await withControlPlane((tx) => tx.query("SELECT 1 FROM companies WHERE slug = 'nowhere'"))).rows.length, 0);

    // A panel that follows the browser has no language to give: the
    // deployment's default stands, as before.
    await withControlPlane((tx) => tx.query('UPDATE platform_control SET console_language = NULL'));
    const unset = await start('no-panel-language');
    assert.deepEqual(await languagesOf(unset.body.companyId as string), { work: null, talk: null });
  } finally {
    await owner.close();
  }
});

/* ------------------------------------------------------------ F10.8 history --- */

/**
 * The inbox is a queue, so a decided item left the only screen the owner has
 * -- Slack's thread that scrolled away, rebuilt. The history is searchable by
 * the owner's own note, because that is where the reason was written.
 */
test('what the owner decided can be found again, by what they wrote (F10.8)', async () => {
  const fixture = await createCompany('history');
  const console = await console_();
  try {
    const token = await signIn(console.url, console.code());
    const renewal = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Renew the Acme contract?', detail: 'It lapses Friday.',
    });
    const refund = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Refund order 1182?', detail: 'Damaged in transit.',
    });
    await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Still open', detail: 'Nobody has answered this.',
    });
    await call(console.url, 'POST', `/api/companies/${fixture.companyId}/inbox/${renewal}/decide`, {
      token, body: { decision: 'approve', note: 'yes, but only at the 50% discount they offered' },
    });
    await inbox.decide(fixture.companyId, refund, 'deny', 'photos show it arrived fine', { channel: 'chat' });

    const all = await call(console.url, 'GET', `/api/companies/${fixture.companyId}/decisions`, { token });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const items = all.body.items as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((item) => [item.title, item.decision, item.via]),
      [['Refund order 1182?', 'deny', 'chat'], ['Renew the Acme contract?', 'approve', 'app']],
      'closed items only, newest first, with the surface each answer came from',
    );

    // By the note, case-insensitively, and literally: "50%" is not a wildcard.
    const byNote = await call(
      console.url, 'GET', `/api/companies/${fixture.companyId}/decisions?q=${encodeURIComponent('50% DISCOUNT')}`, { token },
    );
    assert.deepEqual((byNote.body.items as Array<{ title: string }>).map((item) => item.title),
      ['Renew the Acme contract?']);
    const wildcard = await call(
      console.url, 'GET', `/api/companies/${fixture.companyId}/decisions?q=_`, { token },
    );
    assert.deepEqual(wildcard.body.items, [], 'an underscore matches an underscore, not every character');

    // A page at a time, with a marker that holds still.
    const first = await call(console.url, 'GET', `/api/companies/${fixture.companyId}/decisions?limit=1`, { token });
    assert.equal((first.body.items as unknown[]).length, 1);
    assert.equal(typeof first.body.next, 'string');
    const second = await call(
      console.url, 'GET',
      `/api/companies/${fixture.companyId}/decisions?limit=1&before=${first.body.next}`, { token },
    );
    assert.deepEqual((second.body.items as Array<{ title: string }>).map((item) => item.title),
      ['Renew the Acme contract?']);
    assert.equal(second.body.next, null);

    const forged = await call(
      console.url, 'GET', `/api/companies/${fixture.companyId}/decisions?before=not-a-marker`, { token },
    );
    assert.equal(forged.status, 400);

    const anonymous = await call(console.url, 'GET', `/api/companies/${fixture.companyId}/decisions`);
    assert.equal(anonymous.status, 401);
  } finally {
    await console.close();
  }
});

/**
 * Two replicas are two workers.
 *
 * The deployment named its worker `worker-${pid}`, and every replica of a
 * container image is usually PID 1 -- so two replicas were one identity, and
 * each could renew and run the other's claim, which is the one thing F5.11's
 * lease exists to prevent. Two deployments in one process share a PID too,
 * which makes that exact collision reproducible here.
 */
test('two deployments on one PID are two workers, and one cannot run the other\'s claim (F5.11)', async () => {
  const { start } = await import('../../src/main.ts');
  const { createRootTask } = await import('../../src/engine/tasks.ts');
  const { claimTask } = await import('../../src/engine/checkout.ts');

  const fixture = await createCompany('replicas');
  const elsewhere = await createCompany('replicas-idle');
  const quiet = { companyId: elsewhere.companyId, idleMs: 60_000 };
  const first = await start({ port: 0, env: {}, worker: quiet });
  const second = await start({ port: 0, env: {}, worker: quiet });
  try {
    assert.notEqual(first.engine.workerId, second.engine.workerId);
    assert.match(first.engine.workerId, new RegExp(`-${process.pid}-[0-9a-f]{8}$`));

    const task = await createRootTask({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      input: { goal: 'held by the first replica' },
      createdBy: 'owner',
      reserveTokens: 10_000,
    });
    const claim = await claimTask(fixture.companyId, { holder: first.engine.workerId, taskId: task.id });
    assert.equal(claim?.taskId, task.id);

    const outcome = await second.engine.runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, 'not_claimed', outcome.reason);
  } finally {
    await first.stop();
    await second.stop();
  }
});

/**
 * F16.4 from the console: a company comes back from the file the console
 * downloaded.
 *
 * `importCompany` existed and only tests called it, while the README said a
 * company "can be exported and restored on another instance". An owner with
 * the archive and no terminal had an export and no restore. The route takes
 * the archive as the console downloads it, shows what would come back before
 * anything is written, and restores only with the owner's device, because it
 * creates a company. An archive is larger than any other body the console
 * sends, so this one route takes more than a megabyte and no other does.
 */
test('a company is restored from the archive the console downloads (F16.4)', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('restore-source');
    const token = await signIn(owner.url, owner.code());
    const archive = (await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/export`, { token })).body;
    // Something only an archive this size would carry, and a section this
    // instance does not know.
    (archive.sections as Record<string, unknown[]>).padding = [{ text: 'x'.repeat(1_200_000) }];
    const companies = async () =>
      ((await call(owner.url, 'GET', '/api/companies', { token })).body.companies as Array<{ slug: string }>)
        .map((company) => company.slug);
    const before = await companies();

    const preview = await call(owner.url, 'POST', '/api/companies/import', { token, body: { archive, preview: true } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 300));
    const seen = preview.body.preview as {
      company: { slug: string; name: string }; sections: Record<string, number>; skipped: string[];
    };
    assert.equal(seen.company.slug, fixture.slug);
    assert.equal(seen.sections.roles, (archive.sections as Record<string, unknown[]>).roles!.length);
    assert.ok(seen.skipped.includes('padding'), 'an unknown section is named, not silently dropped');
    assert.deepEqual(await companies(), before, 'a preview writes nothing');

    const unproven = await call(owner.url, 'POST', '/api/companies/import', {
      token, body: { archive, slug: 'restored' },
    });
    assert.notEqual(unproven.status, 200);
    assert.deepEqual(await companies(), before, 'nothing is restored without the owner\'s device');

    const restored = await call(owner.url, 'POST', '/api/companies/import', {
      token, body: { archive, slug: 'restored', name: 'Restored Co', proof: { totp: owner.code() } },
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body).slice(0, 300));
    assert.equal(restored.body.slug, 'restored');
    assert.ok((await companies()).includes('restored'));

    const broken = await call(owner.url, 'POST', '/api/companies/import', {
      token, body: { archive: { sections: { roles: [] } }, preview: true },
    });
    assert.equal(broken.status, 400);
    assert.match(String(broken.body.error), /no company section/);

    // And every other route keeps its megabyte.
    const large = await call(owner.url, 'POST', `/api/companies/${fixture.companyId}/tasks/${fixture.goalId}/instruct`, {
      token, body: { text: 'x'.repeat(1_200_000) },
    });
    assert.equal(large.status, 400);
    assert.match(String(large.body.error), /too large/);
  } finally {
    await owner.close();
  }
});

/**
 * Batch verdicts over HTTP: the owner approves what they have read in one
 * press, with their session, and a tier 3 item in the selection stays for
 * their device.
 */
test('the owner approves several items in one press, and tier 3 waits for the device', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('batch-http');
    const token = await signIn(owner.url, owner.code());
    const draft = (summary: string) => inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'social.publish', tier: 2,
      actionSummary: summary, rationale: 'The draft is ready.', consequenceIfDenied: 'Not posted.',
    });
    const drafts = [await draft('Post A'), await draft('Post B')];
    const payment = await tier3(fixture);
    const base = `/api/companies/${fixture.companyId}/inbox`;

    const wrong = await call(owner.url, 'POST', `${base}/batch`, { token, body: { itemIds: drafts, decision: 'ask' } });
    assert.equal(wrong.status, 400);
    const pressed = await call(owner.url, 'POST', `${base}/batch`, {
      token, body: { itemIds: [...drafts, payment], decision: 'approve', note: 'read them' },
    });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.deepEqual((pressed.body.decided as string[]).sort(), [...drafts].sort());
    assert.deepEqual((pressed.body.skipped as Array<{ itemId: string }>).map((skip) => skip.itemId), [payment]);
    const open = await call(owner.url, 'GET', base, { token });
    assert.deepEqual((open.body.items as Array<{ id: string }>).map((item) => item.id), [payment]);
  } finally {
    await owner.close();
  }
});

/**
 * The stage over HTTP (0057): forward with the device, back with the session,
 * and the company list says where each company is.
 */
test('the owner moves a company forward with the device and back with the session (0057)', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('stage-http');
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/stage`;

    const unproven = await call(owner.url, 'POST', path, { token, body: { stage: 'launch' } });
    assert.notEqual(unproven.status, 200, 'forward loosens, so it takes the device');
    const wrong = await call(owner.url, 'POST', path, { token, body: { stage: 'scale' } });
    assert.equal(wrong.status, 400);
    const moved = await call(owner.url, 'POST', path, {
      token, body: { stage: 'launch', note: 'ready', proof: { totp: owner.code() } },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body, { from: null, to: 'launch' });
    const back = await call(owner.url, 'POST', path, { token, body: { stage: 'build' } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const down = await call(owner.url, 'POST', path, { token, body: { stage: 'wind_down' } });
    assert.equal(down.status, 200, 'winding down only closes things');

    const listed = await call(owner.url, 'GET', '/api/companies', { token });
    const mine = (listed.body.companies as Array<{ id: string; stage: string | null }>).find((one) => one.id === fixture.companyId);
    assert.equal(mine!.stage, 'wind_down');
  } finally {
    await owner.close();
  }
});

/**
 * Growing the company from the console (F2.9): hiring a role and opening a
 * division take the device; starting a project takes the session.
 */
test('the owner hires a role and opens a division with the device, and starts a project with the session', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('grow-http');
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}`;
    const hire = {
      divisionId: fixture.divisionId, slug: 'copywriter', systemPrompt: 'You write product pages.',
      tools: [], doneCriteria: ['every claim is on the product page'],
    };
    const unproven = await call(owner.url, 'POST', `${base}/roles`, { token, body: hire });
    assert.notEqual(unproven.status, 200, 'hiring takes the device');
    const hired = await call(owner.url, 'POST', `${base}/roles`, { token, body: { ...hire, proof: { totp: owner.code() } } });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    assert.deepEqual(hired.body.ungranted, []);

    assert.notEqual((await call(owner.url, 'POST', `${base}/divisions`, { token, body: { slug: 'sales', name: 'Sales' } })).status, 200);
    const opened = await call(owner.url, 'POST', `${base}/divisions`, {
      token, body: { slug: 'sales', name: 'Sales', proof: { totp: owner.code() } },
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const started = await call(owner.url, 'POST', `${base}/projects`, { token, body: { slug: 'wholesale', name: 'Wholesale' } });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const structure = await call(owner.url, 'GET', `${base}/structure`, { token });
    const body = structure.body as { roles: Array<{ slug: string }>; divisions: Array<{ slug: string }>; projects: Array<{ name: string }> };
    assert.ok(body.roles.some((role) => role.slug === 'copywriter'));
    assert.ok(body.divisions.some((division) => division.slug === 'sales'));
    assert.ok(body.projects.some((project) => project.name === 'Wholesale'));
  } finally {
    await owner.close();
  }
});

/** Putting an item off over HTTP (0060), and finding it among the put-off ones. */
test('the owner puts an item off and brings it back', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('snooze-http');
    const token = await signIn(owner.url, owner.code());
    const item = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, ttlHours: 72,
      actionSummary: 'Send the Monday note', rationale: 'r', consequenceIfDenied: 'c',
    });
    const base = `/api/companies/${fixture.companyId}/inbox`;
    const until = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    assert.equal((await call(owner.url, 'POST', `${base}/${item}/snooze`, { token, body: { until: 'soon' } })).status, 400);
    assert.equal((await call(owner.url, 'POST', `${base}/${item}/snooze`, { token, body: { until } })).status, 200);
    assert.deepEqual((await call(owner.url, 'GET', base, { token })).body.items, []);
    const later = (await call(owner.url, 'GET', `${base}?snoozed=1`, { token })).body.items as Array<{ id: string }>;
    assert.deepEqual(later.map((one) => one.id), [item]);
    assert.equal((await call(owner.url, 'POST', `${base}/${item}/snooze`, { token, body: { until: null } })).status, 200);
    assert.equal(((await call(owner.url, 'GET', base, { token })).body.items as unknown[]).length, 1);
  } finally {
    await owner.close();
  }
});

/** Search over HTTP: every company, and a query too short is refused, not run. */
test('the owner searches every company from one box', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('search-http');
    const token = await signIn(owner.url, owner.code());
    await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2,
      actionSummary: 'Send the roastery tour invitation', rationale: 'r', consequenceIfDenied: 'c',
    });
    const found = await call(owner.url, 'GET', `/api/search?q=${encodeURIComponent('roastery tour')}`, { token });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual((found.body.hits as Array<{ kind: string; companyId: string }>).map((hit) => [hit.kind, hit.companyId]),
      [['decision', fixture.companyId]]);
    assert.equal((await call(owner.url, 'GET', '/api/search?q=r', { token })).status, 400);
    assert.equal((await call(owner.url, 'GET', '/api/search?q=roastery')).status, 401, 'a session, like every read');
  } finally {
    await owner.close();
  }
});

/** The owner's word on finished work, over HTTP, and read back on the task. */
test('the owner says what finished work needed, and the task shows it', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('feedback-http');
    const token = await signIn(owner.url, owner.code());
    const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
      input: { goal: 'Draft the price page' }, createdBy: 'owner', reserveTokens: 1_000,
    });
    await transition(fixture.companyId, task.id, 'running');
    await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'drafted' } });
    const path = `/api/companies/${fixture.companyId}/tasks/${task.id}`;
    assert.equal((await call(owner.url, 'POST', `${path}/feedback`, { token, body: { verdict: 'needs_work' } })).status, 400);
    const said = await call(owner.url, 'POST', `${path}/feedback`, {
      token, body: { verdict: 'needs_work', note: 'Show the yearly price first.' },
    });
    assert.equal(said.status, 200, JSON.stringify(said.body));
    const read = await call(owner.url, 'GET', path, { token });
    const feedback = (read.body.task as { feedback: { verdict: string; note: string } }).feedback;
    assert.deepEqual([feedback.verdict, feedback.note], ['needs_work', 'Show the yearly price first.']);
  } finally {
    await owner.close();
  }
});

/** Handoffs over HTTP (0058): made and switched on with the device, off with the session. */
test('the owner chains two roles with the device and switches the chain off with the session (0058)', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('handoff-http');
    const token = await signIn(owner.url, owner.code());
    const { addRole } = await import('../helpers/fixtures.ts');
    const writerId = await addRole(fixture, 'writer');
    const base = `/api/companies/${fixture.companyId}/handoffs`;
    const rule = { fromRoleId: fixture.roleId, toRoleId: writerId, brief: 'Write it up.' };
    assert.notEqual((await call(owner.url, 'POST', base, { token, body: rule })).status, 200);
    const made = await call(owner.url, 'POST', base, { token, body: { ...rule, proof: { totp: owner.code() } } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const path = `${base}/${String(made.body.ruleId)}`;
    assert.equal((await call(owner.url, 'POST', path, { token, body: { enabled: false } })).status, 200);
    assert.notEqual((await call(owner.url, 'POST', path, { token, body: { enabled: true } })).status, 200);
    const listed = await call(owner.url, 'GET', base, { token });
    assert.deepEqual((listed.body.handoffs as Array<{ toRoleSlug: string; enabled: boolean }>)
      .map((one) => [one.toRoleSlug, one.enabled]), [['writer', false]]);
  } finally {
    await owner.close();
  }
});

/**
 * Inbound triggers over HTTP (0054): the owner opens one with their device,
 * another service posts to its URL with its token, and a wrong token, an
 * unknown URL or a closed door answer as HTTP says they should.
 */
test('an outside service starts work through a trigger the owner opened (0054)', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('hook-http');
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/triggers`;
    const definition = {
      slug: 'orders', roleId: fixture.roleId, goalId: fixture.goalId, instruction: 'Confirm the order.', maxPerHour: 5,
    };

    const unproven = await call(owner.url, 'POST', base, { token, body: definition });
    assert.notEqual(unproven.status, 200, 'opening a door takes the owner\'s device');
    const opened = await call(owner.url, 'POST', base, { token, body: { ...definition, proof: { totp: owner.code() } } });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const { id, publicId, token: secret } = opened.body as { id: string; publicId: string; token: string };

    const post = async (path: string, bearer: string | null, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${owner.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
    };
    assert.equal((await post(`/api/hooks/${publicId}`, null, { order: 1 })).status, 401);
    assert.equal((await post(`/api/hooks/${publicId}`, 'wrong', { order: 1 })).status, 401);
    assert.equal((await post(`/api/hooks/${'f'.repeat(32)}`, secret, { order: 1 })).status, 404);
    const started = await post(`/api/hooks/${publicId}`, secret, { order: 1 }, { 'x-delivery-id': 'evt-1' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.duplicate, false);
    const retried = await post(`/api/hooks/${publicId}`, secret, { order: 1, retried: true }, { 'x-delivery-id': 'evt-1' });
    assert.deepEqual(retried.body, { taskId: started.body.taskId, duplicate: true }, 'the sender\'s delivery id decides');

    const listed = await call(owner.url, 'GET', base, { token });
    const triggers = listed.body.triggers as Array<{ slug: string; deliveriesLastHour: number }>;
    assert.deepEqual(triggers.map((one) => [one.slug, one.deliveriesLastHour]), [['orders', 1]]);

    const rotated = await call(owner.url, 'POST', `${base}/${id}/rotate`, { token, body: {} });
    assert.equal((await post(`/api/hooks/${publicId}`, secret, { order: 2 })).status, 401);
    assert.equal((await post(`/api/hooks/${publicId}`, String(rotated.body.token), { order: 2 })).status, 200);

    assert.equal((await call(owner.url, 'POST', `${base}/${id}`, { token, body: { enabled: false } })).status, 200);
    assert.equal((await post(`/api/hooks/${publicId}`, String(rotated.body.token), { order: 3 })).status, 404);
    const reopen = await call(owner.url, 'POST', `${base}/${id}`, { token, body: { enabled: true } });
    assert.notEqual(reopen.status, 200, 'opening it again takes the device too');
  } finally {
    await owner.close();
  }
});

/**
 * A signed trigger over HTTP (0056). The route hands the receiver the bytes
 * that arrived, because a signature is over those bytes: a body parsed and
 * written out again is a different body, and every signature would fail. And
 * a sender may post a form or text, which the JSON-only reader refused.
 */
test('a signed delivery, a form and a handshake reach a trigger as they were sent (0056)', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('hook-signed-http');
    const token = await signIn(owner.url, owner.code());
    const base = `/api/companies/${fixture.companyId}/triggers`;
    const open = (slug: string, scheme: string, secretRef?: string) => call(owner.url, 'POST', base, {
      token,
      body: {
        slug, roleId: fixture.roleId, goalId: fixture.goalId, instruction: 'Act on it.', scheme,
        ...(secretRef ? { secretRef } : {}), proof: { totp: owner.code() },
      },
    });
    const refusedOpen = await open('slack', 'slack', 'vault://hooks/unset');
    assert.equal(refusedOpen.status, 400);
    assert.match(String(refusedOpen.body.error), /could not be read/);
    const slack = await open('slack', 'slack', 'vault://hooks/signing');
    assert.equal(slack.status, 200, JSON.stringify(slack.body));
    assert.equal(slack.body.token, null);
    const plain = await open('plain', 'bearer');

    const post = (publicId: unknown, body: string, headers: Record<string, string>) =>
      fetch(`${owner.url}/api/hooks/${String(publicId)}`, { method: 'POST', headers, body });
    const slackHeaders = (body: string, type: string) => {
      const at = String(Math.floor(Date.now() / 1000));
      const mac = createHmac('sha256', 'hook-signing-secret-for-tests').update(`v0:${at}:${body}`).digest('hex');
      return { 'content-type': type, 'x-slack-request-timestamp': at, 'x-slack-signature': `v0=${mac}` };
    };

    const challenge = '{ "type": "url_verification",  "challenge": "c-42" }';
    const shook = await post(slack.body.publicId, challenge, slackHeaders(challenge, 'application/json'));
    assert.equal(shook.status, 200);
    assert.deepEqual(await shook.json(), { challenge: 'c-42' });
    const command = 'command=%2Forder&text=A-1';
    const ran = await post(slack.body.publicId, command, slackHeaders(command, 'application/x-www-form-urlencoded'));
    assert.equal(ran.status, 200, await ran.clone().text());
    assert.equal(((await ran.json()) as { duplicate: boolean }).duplicate, false);
    const forged = await post(slack.body.publicId, command, {
      ...slackHeaders(command, 'application/x-www-form-urlencoded'), 'x-slack-signature': 'v0=00',
    });
    assert.equal(forged.status, 401);

    const text = await post(plain.body.publicId, 'Paid: A-7', {
      authorization: `Bearer ${String(plain.body.token)}`, 'content-type': 'text/plain',
    });
    assert.equal(text.status, 200, await text.clone().text());
    const image = await post(plain.body.publicId, 'GIF89a', {
      authorization: `Bearer ${String(plain.body.token)}`, 'content-type': 'image/gif',
    });
    assert.equal(image.status, 415);
  } finally {
    await owner.close();
  }
});

/**
 * F3.9 from the console: the owner sees the company's policies, reads a
 * role's versions, and puts one back with their device.
 */
test('the owner reads the policies and a role\'s history, and puts a version back (F3.5, F3.9)', async () => {
  const owner = await console_();
  try {
    const fixture = await createCompany('rollback-http');
    const token = await signIn(owner.url, owner.code());
    const { applyRoleChange } = await import('../../src/governance/structure.ts');
    const { putPolicy } = await import('../../src/governance/store.ts');
    const { withTenant } = await import('../../src/db/tenant.ts');
    await putPolicy({
      companyId: fixture.companyId, slug: 'no-ads', effect: 'deny',
      condition: { op: 'matches', field: 'tool', value: 'ads.*' },
    });
    await applyRoleChange(fixture.companyId, fixture.roleId, { systemPrompt: 'Be terse.' }, { ownerApproved: true });

    const policies = await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/policies`, { token });
    const listed = policies.body.policies as Array<{ slug: string; scope: string }>;
    assert.ok(listed.some((policy) => policy.slug === 'no-ads' && policy.scope === 'company'));

    const base = `/api/companies/${fixture.companyId}/config/role`;
    const history = await call(owner.url, 'GET', `${base}/history?subject=${fixture.roleId}`, { token });
    assert.equal((history.body.versions as unknown[]).length, 1);
    assert.equal((await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/config/nonsense/history`, { token })).status, 400);

    const unproven = await call(owner.url, 'POST', `${base}/rollback`, { token, body: { subjectId: fixture.roleId, version: 1 } });
    assert.notEqual(unproven.status, 200, 'putting a version back takes the owner\'s device');
    const done = await call(owner.url, 'POST', `${base}/rollback`, {
      token, body: { subjectId: fixture.roleId, version: 1, proof: { totp: owner.code() } },
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ system_prompt: string }>(
      'SELECT system_prompt FROM roles WHERE id = $1', [fixture.roleId]));
    assert.notEqual(rows[0]!.system_prompt, 'Be terse.');
  } finally {
    await owner.close();
  }
});

/**
 * 0083 through the console: a yes for a while is asked for with the decision,
 * refused without the owner's device, listed once given, and taken back with
 * the session alone, since taking it back tightens.
 */
test('the console approves for a while with a factor, lists it, and takes it back', async () => {
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const fixture = await createCompany('console-standing');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'follow up' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'email.send', tier: 2,
    actionSummary: 'Send the follow-up', rationale: 'A policy asks', consequenceIfDenied: 'Not sent',
    payload: { reason: 'policy' },
  });
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const company = `/api/companies/${fixture.companyId}`;
    const listed = await call(owner.url, 'GET', `${company}/inbox`, { token });
    assert.equal((listed.body.items as Array<{ allowFor: boolean }>)[0]!.allowFor, true);

    const bare = await call(owner.url, 'POST', `${company}/inbox/${itemId}/decide`, {
      token, body: { decision: 'approve', allowForHours: 8 },
    });
    assert.equal(bare.status, 403, JSON.stringify(bare.body));
    assert.equal(bare.body.code, 'approval.channel_forbidden');

    const given = await call(owner.url, 'POST', `${company}/inbox/${itemId}/decide`, {
      token, body: { decision: 'approve', allowForHours: 8, proof: { totp: owner.code() } },
    });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    const standing = await call(owner.url, 'GET', `${company}/standing-approvals`, { token });
    const [entry] = standing.body.standing as Array<{ id: string; capabilityName: string; roleSlug: string; uses: number }>;
    assert.equal(entry?.capabilityName, 'email.send');
    assert.equal(entry?.uses, 0);

    const revoked = await call(owner.url, 'POST', `${company}/standing-approvals/${entry!.id}/revoke`, { token });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.deepEqual((await call(owner.url, 'GET', `${company}/standing-approvals`, { token })).body.standing, []);
    const again = await call(owner.url, 'POST', `${company}/standing-approvals/${entry!.id}/revoke`, { token });
    assert.equal(again.status, 400, 'a yes already taken back is not taken back twice');
  } finally {
    await owner.close();
  }
});

/** #102 through the console: the owner sets how long one of a role's runs may take, in minutes. */
test('the console sets and clears how long a role\'s runs may take', async () => {
  const fixture = await createCompany('console-run-length');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());
    const path = `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`;
    const lengthOf = async () => ((await call(owner.url, 'GET', `/api/companies/${fixture.companyId}/structure`, { token }))
      .body.roles as Array<{ id: string; maxRunSeconds: number | null }>).find((role) => role.id === fixture.roleId)!.maxRunSeconds;
    assert.equal(await lengthOf(), null, 'no limit until the owner sets one');

    const tooLong = await call(owner.url, 'POST', path, { token, body: { maxRunMinutes: 2000, proof: { totp: owner.code() } } });
    assert.equal(tooLong.status, 400);
    assert.match(String(tooLong.body.error), /maxRunMinutes is 2000; it is a whole number of minutes from 1 to 1440, or 0 for no limit/);

    const set = await call(owner.url, 'POST', path, { token, body: { maxRunMinutes: 30, proof: { totp: owner.code() } } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(await lengthOf(), 1800);
    const cleared = await call(owner.url, 'POST', path, { token, body: { maxRunMinutes: 0, proof: { totp: owner.code() } } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(await lengthOf(), null);
  } finally {
    await owner.close();
  }
});
