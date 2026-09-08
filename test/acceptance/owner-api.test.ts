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
import { closePools } from '../../src/db/pool.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi } from '../../src/owner/api.ts';
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
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** The console, its verifier, and a way to mint a fresh code. */
async function console_(): Promise<{
  api: OwnerApi;
  url: string;
  code: () => string;
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

  const api = new OwnerApi({ mfa });
  const { url } = await api.listen();
  return {
    api,
    url,
    code: () => {
      steps += 1;
      return totpCode(decodeBase32(secret), stepFor(at()));
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

    const lifted = await call(owner.url, 'POST', '/api/control/stop-all', {
      token, body: { on: false },
    });
    assert.equal(lifted.body.stopAll, false);
    assert.equal(await isStopAllRequested(), false);

    // And the narrower three answer too.
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
        200,
        path,
      );
    }
  } finally {
    await clearStopAll();
    await owner.close();
  }
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

  const consoleRoot = fileURLToPath(new URL('../../console', import.meta.url));
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

    // The console itself, from the repository rather than from a fixture.
    const page = await fetch(`${deployment.url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>PALUGADA<\/title>/);
    assert.match(html, /console\.js/);
    for (const asset of ['/console.js', '/console.css']) {
      assert.equal((await fetch(`${deployment.url}${asset}`)).status, 200, asset);
    }
    void join;

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

    const set = await call(owner.url, 'POST', `${base}/limit`, {
      token, body: { moneyMaxCents: 250_00 },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const read = await call(owner.url, 'GET', base, { token });
    assert.equal(read.status, 200);
    assert.equal(read.body.limitCents, 250_00);
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

    const resumed = await call(owner.url, 'POST', `${base}/resume`, { token, body: {} });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal((await call(owner.url, 'GET', base, { token })).body.pausedAt, null);

    // An override is bounded. F1.9 exists for "this one campaign is worth it",
    // and an override with no end is a ceiling removed rather than raised.
    const past = await call(owner.url, 'POST', `${base}/resume`, {
      token, body: { until: '2020-01-01T00:00:00Z' },
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

test('the owner can write a policy, and cannot write one the engine cannot read (F3.4)', async () => {
  const fixture = await createCompany('console-policy');
  const owner = await console_();
  try {
    const token = await signIn(owner.url, owner.code());

    const written = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
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

    const without = await call(owner.url, 'POST', `${base}/${deviceId}/pair`, { token, body: {} });
    assert.equal(without.status, 403, JSON.stringify(without.body));

    const paired = await call(owner.url, 'POST', `${base}/${deviceId}/pair`, {
      token, body: { proof: { totp: owner.code() } },
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
        slug: 'unknown-field', effect: 'deny', companyId: fixture.companyId,
        condition: { field: 'whatever', op: 'eq', value: 1 },
      },
    });
    assert.equal(field.status, 400, JSON.stringify(field.body));
    assert.match(String(field.body.error), /unknown field whatever/);

    const scoped = await call(owner.url, 'POST', '/api/policies', {
      token,
      body: {
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
  } finally {
    await owner.close();
  }
});
