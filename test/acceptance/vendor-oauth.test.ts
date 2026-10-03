/**
 * A division's key for a vendor, got by signing in (PRD F12.1-F12.3, F12.6).
 *
 * Google Calendar and Gmail take no key a person can paste, and their tokens
 * run out within the hour. A vendor entry says how its key is signed in for,
 * and the owner signs a division in from its keys: the app registered once
 * for the deployment, PKCE and a single-use state, the grant sealed as the
 * division's credential, and the access token refreshed -- once, across
 * workers -- before it runs out. These run against a provider and a vendor
 * of their own on this machine.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { parseVendors } from '../../src/capabilities/vendors.ts';
import { httpCapability, type HttpCapabilitySpec } from '../../src/capabilities/http.ts';
import { OAuthCredentials } from '../../src/capabilities/vendor-oauth.ts';
import { CachedSecretManager } from '../../src/secrets/rotation.ts';
import { DivisionSecrets, redactor } from '../../src/secrets/manager.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { settingsVersion } from '../../src/settings/store.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/**
 * An authorization server and the vendor it guards, on one port. The token
 * endpoint's first answer runs out in `firstExpiresIn` seconds, so a test
 * decides whether the first use refreshes.
 */
async function provider(options: { firstExpiresIn?: number; refuseRefresh?: boolean } = {}) {
  const codes = new Map<string, string>();
  const live = new Set<string>();
  const tokenRequests: URLSearchParams[] = [];
  const bearers: Array<string | null> = [];
  let issued = 0;
  let base = '';
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base);
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/authorize') {
        const code = `code-${codes.size + 1}`;
        codes.set(code, url.searchParams.get('code_challenge') ?? '');
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(raw);
        tokenRequests.push(form);
        if (form.get('client_id') !== 'app-1' || form.get('client_secret') !== 'app-secret-1') return json(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const challenge = codes.get(form.get('code') ?? '');
          if (!challenge || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) {
            return json(400, { error: 'invalid_grant' });
          }
          issued += 1;
          live.add(`access-${issued}`);
          return json(200, { access_token: `access-${issued}`, token_type: 'Bearer', expires_in: options.firstExpiresIn ?? 3600, refresh_token: 'refresh-token-1', scope: 'events.read' });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (options.refuseRefresh || form.get('refresh_token') !== 'refresh-token-1') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          issued += 1;
          live.add(`access-${issued}`);
          return json(200, { access_token: `access-${issued}`, token_type: 'Bearer', expires_in: 3600 });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/events') {
        bearers.push(req.headers.authorization ?? null);
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!bearer || !live.has(bearer)) return json(401, { error: 'unauthenticated' });
        return json(200, { items: [{ id: 'e1', summary: 'Standup' }] });
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, tokenRequests, bearers, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A calendar read whose key is signed in for, as a vendor file writes it. */
function calendarRead(base: string): HttpCapabilitySpec {
  const [spec] = parseVendors({
    capabilities: [{
      name: 'calendar.read', adapter: 'acme-calendar', tier: 0, method: 'GET', url: `${base}/events`,
      headers: { authorization: 'Bearer {credential}' }, result: 'body.items',
      credentialAlias: 'calendar',
      signIn: { provider: 'acme', authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, scopes: ['events.read'], params: { access_type: 'offline' } },
      allowPrivateHosts: ['127.0.0.1'],
    }],
  }, 'the test');
  return spec!;
}

/** Follows the owner's browser from the provider's page back to the console. */
async function followSignIn(authorizeUrl: string): Promise<{ status: number; text: string }> {
  const atProvider = await fetch(authorizeUrl, { redirect: 'manual' });
  const callback = atProvider.headers.get('location')!;
  const back = await fetch(callback);
  return { status: back.status, text: await back.text() };
}

test('a division signs in for a vendor key from the console: the app once, PKCE, the grant sealed and never shown, and refreshed once before it runs out', async () => {
  const acme = await provider({ firstExpiresIn: 60 });
  const registry = new CapabilityRegistry();
  registry.register(httpCapability(calendarRead(acme.base)));
  await registry.sync();
  const fixture = await createCompany('vendor-oauth');
  await grantCapability(fixture, 'calendar.read');
  let brokerOf: CapabilityBroker | null = null;
  const api = await consoleWithSettings({
    registry,
    credentialFor: (companyId, divisionId) => brokerOf!.credentialFor(companyId, divisionId),
  });
  const secrets = new CachedSecretManager(new OAuthCredentials(new DivisionSecrets(api.secrets), { deployment: api.secrets, master: () => api.master }));
  brokerOf = new CapabilityBroker(registry, undefined, secrets);
  const keys = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`;
  try {
    const token = await api.signIn();

    // The key it lacks says it is signed in for, with whom, and that no app is registered yet.
    const before = await api.call('GET', keys, token);
    assert.deepEqual(before.body.needs, [{ alias: 'calendar', capabilities: ['calendar.read'], scopes: [], signIn: { provider: 'acme', name: 'acme', clientUrl: null, client: false } }]);
    assert.equal(before.body.callback, `${api.url}/api/oauth/callback`);

    // Without an app, the start says to register one and where to come back to.
    const noApp = await api.call('POST', `${keys}/calendar/oauth/start`, token, { proof: { totp: api.code() } });
    assert.equal(noApp.status, 400, JSON.stringify(noApp.body));
    assert.match(String(noApp.body.error), /register one, with .*\/api\/oauth\/callback as the address to come back to/);

    // With it: the owner's device, and then the provider's page.
    const refused = await api.call('POST', `${keys}/calendar/oauth/start`, token, { clientId: 'app-1', clientSecret: 'app-secret-1' });
    assert.notEqual(refused.status, 200, 'a sign-in that makes a key asks for the owner\'s device');
    const started = await api.call('POST', `${keys}/calendar/oauth/start`, token, { clientId: 'app-1', clientSecret: 'app-secret-1', proof: { totp: api.code() } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const authorize = new URL(started.body.authorizeUrl as string);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${acme.base}/authorize`);
    assert.equal(authorize.searchParams.get('client_id'), 'app-1');
    assert.equal(authorize.searchParams.get('scope'), 'events.read');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('access_type'), 'offline');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${api.url}/api/oauth/callback`);

    const landed = await followSignIn(started.body.authorizeUrl as string);
    assert.equal(landed.status, 200, landed.text);
    assert.match(landed.text, /Signed in to acme for the calendar key/);
    assert.ok(!landed.text.includes('access-1') && !landed.text.includes('refresh-token-1'), 'the tokens never reach the browser');

    // Held now, as signed in, and nothing of it is shown.
    const after = await api.call('GET', keys, token);
    assert.deepEqual(after.body.needs, []);
    assert.equal(after.body.credentials[0].alias, 'calendar');
    assert.equal(after.body.credentials[0].signedIn, true);
    assert.ok(!JSON.stringify(after.body).includes('access-1') && !JSON.stringify(after.body).includes('refresh-token-1'));

    // It ran out within five minutes, so the first use refreshes it -- once,
    // though two calls ask at the same moment -- and the call goes through
    // with the new token.
    const version = await settingsVersion();
    const credential = brokerOf.credentialFor(fixture.companyId, fixture.divisionId);
    const [one, two] = await Promise.all([credential('calendar', 'calendar.read'), credential('calendar', 'calendar.read')]);
    assert.equal(one, 'access-2');
    assert.equal(two, 'access-2');
    assert.equal(acme.tokenRequests.filter((form) => form.get('grant_type') === 'refresh_token').length, 1, 'refreshed once');
    // N4: a refresh is not the owner changing a setting. Every replica polls
    // the settings version and restarts when it moves, so a refresh that
    // moved it restarted the deployment about once an hour per sign-in.
    assert.equal(await settingsVersion(), version, 'the refresh restarts nothing');
    const read = await registry.get('calendar.read')!.execute({} as never, {
      companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: '00000000-0000-0000-0000-000000000001',
      idempotencyKey: 'k1', signal: new AbortController().signal, credential: (alias: string) => credential(alias, 'calendar.read'),
    } as never);
    assert.deepEqual(read, [{ id: 'e1', summary: 'Standup' }]);
    assert.equal(acme.bearers.at(-1), 'Bearer access-2');
    // A token is a secret, as a pasted key is.
    assert.equal(redactor.redact('sent access-2 and refresh-token-1'), 'sent [redacted] and [redacted]');

    // A sign-in's record cannot be pasted in as a key: it would choose where
    // the app's secret is sent on the next refresh.
    const forged = await api.call('POST', keys, token, {
      alias: 'calendar', value: JSON.stringify({ oauth2: 1, provider: 'acme', tokenUrl: 'https://elsewhere.example/token', accessToken: 'x', refreshToken: 'y', expiresAt: null, scope: '' }),
      proof: { totp: api.code() },
    });
    assert.equal(forged.status, 400);
    assert.match(String(forged.body.error), /made by signing in, not pasted/);

    // The next start reuses the app registered, with no secret asked again.
    const again = await api.call('POST', `${keys}/calendar/oauth/start`, token, { proof: { totp: api.code() } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  } finally {
    await api.close();
    await acme.close();
  }
});

test('a sign-in the provider no longer refreshes says to sign in again, and where', async () => {
  const acme = await provider({ firstExpiresIn: 60, refuseRefresh: true });
  const registry = new CapabilityRegistry();
  registry.register(httpCapability(calendarRead(acme.base)));
  await registry.sync();
  const fixture = await createCompany('vendor-oauth-ended');
  await grantCapability(fixture, 'calendar.read');
  let brokerOf: CapabilityBroker | null = null;
  const api = await consoleWithSettings({ registry, credentialFor: (c, d) => brokerOf!.credentialFor(c, d) });
  brokerOf = new CapabilityBroker(registry, undefined,
    new CachedSecretManager(new OAuthCredentials(new DivisionSecrets(api.secrets), { deployment: api.secrets, master: () => api.master })));
  try {
    const token = await api.signIn();
    const keys = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`;
    const started = await api.call('POST', `${keys}/calendar/oauth/start`, token, { clientId: 'app-1', clientSecret: 'app-secret-1', proof: { totp: api.code() } });
    await followSignIn(started.body.authorizeUrl as string);
    await assert.rejects(brokerOf.credentialFor(fixture.companyId, fixture.divisionId)('calendar', 'calendar.read'),
      /the acme sign-in behind this key has ended \(the token endpoint answered 400: invalid_grant: Token has been expired or revoked\.\): sign in again from the division's keys, on Organization/);
  } finally {
    await api.close();
    await acme.close();
  }
});

test('an entry that signs in is held to where a sign-in may go and what it needs', () => {
  const entry = (signIn: Record<string, unknown>, extra: Record<string, unknown> = { credentialAlias: 'calendar' }) => ({
    capabilities: [{ name: 'calendar.read', adapter: 'x', tier: 0, method: 'GET', url: 'https://api.example.com/e', headers: { authorization: 'Bearer {credential}' }, ...extra, signIn }],
  });
  // A provider known by name fills in its addresses.
  const [google] = parseVendors(entry({ provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }), 'f');
  assert.equal(google!.signIn!.tokenUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(google!.signIn!.params.access_type, 'offline', 'Google gives a refresh token only for offline access');
  const [microsoft] = parseVendors(entry({ provider: 'microsoft', scopes: ['Calendars.Read'] }), 'f');
  assert.deepEqual(microsoft!.signIn!.scopes, ['offline_access', 'Calendars.Read']);
  // One it does not know must say where; a sign-in goes over https; the key it signs in for is named.
  assert.throws(() => parseVendors(entry({ provider: 'acme', scopes: ['a'] }), 'f'), /acme is not a provider PALUGADA knows .*give its authorizeUrl and tokenUrl/);
  assert.throws(() => parseVendors(entry({ provider: 'acme', scopes: ['a'], authorizeUrl: 'http://auth.example.com/a', tokenUrl: 'https://auth.example.com/t' }), 'f'), /reached over https/);
  assert.throws(() => parseVendors(entry({ provider: 'google', scopes: ['a'] }, {}), 'f'), /signs in for a key, and names none: give its credentialAlias/);
  assert.throws(() => parseVendors(entry({ provider: 'google', scopes: [] }), 'f'), /scopes/);
});
