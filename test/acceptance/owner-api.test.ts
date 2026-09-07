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
  decodeBase32,
  newTotpSecret,
  stepFor,
  totpCode,
} from '../../src/owner/mfa.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { clearStopAll, isStopAllRequested } from '../../src/engine/control.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
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
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local' });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });

  const api = new OwnerApi({ mfa });
  const { url } = await api.listen();
  // A fresh step per call: a TOTP code cannot be used twice, so a test that
  // signs in and then approves would fail on the second for the wrong reason.
  let drift = 0;
  return {
    api,
    url,
    code: () => totpCode(decodeBase32(secret), stepFor(new Date()) + drift++),
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
  const owner = await console_();
  await owner.close();

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
  const { createRootTask } = await import('../../src/engine/tasks.ts');

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
    worker: { idleMs: 50 },
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

    const outcome = await deployment.engine.runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, 'completed', outcome.reason ?? '');
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
