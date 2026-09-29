/**
 * Signing in to an MCP server that asks for OAuth (F13.4, F12.1; the MCP
 * authorization spec, revision 2026-07-28).
 *
 * Linear, Notion, Sentry, Atlassian and Stripe answer an MCP client with 401
 * and the address of an authorization server; a client signs its user in
 * there. PALUGADA could only send a token the owner pasted, so none of them
 * could be connected. These hold the sign-in to the spec's order and its
 * checks -- the resource's metadata and the authorization server's, each
 * checked for who it says it is; a client registered here and kept per
 * authorization server; PKCE, a single-use state, the issuer on the answer,
 * the server named as the token's `resource` -- and hold the tokens to what
 * every other key keeps: sealed, never shown, sent only to the server they
 * were issued for, and refreshed when it says they have run out.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { bindMcpServers, closeMcpSessions } from '../../src/capabilities/mcp.ts';
import { refreshMcpAccess } from '../../src/capabilities/mcp-oauth.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

const servers: Server[] = [];

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closeMcpSessions();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await closePools();
  await closeSetup();
});

test('an MCP server that asks for OAuth is signed in to from the console: discovered, a client registered, PKCE and the resource sent, and its tools listed with the token', async () => {
  const provider = await oauthProvider();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    // Looked at bare, it says it needs a sign-in, and where.
    const bare = await api.call('POST', '/api/control/mcp/inspect', token, { url: provider.mcpUrl });
    assert.equal(bare.status, 200, JSON.stringify(bare.body));
    assert.match(String(bare.body.problem), /asks you to sign in/);
    assert.equal(bare.body.signIn, provider.issuer);

    const started = await api.call('POST', '/api/control/mcp/oauth/start', token, { name: 'tracker', url: provider.mcpUrl });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.issuer, provider.issuer);
    const authorize = new URL(started.body.authorizeUrl as string);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${provider.issuer}/authorize`);

    // A client registered with the authorization server (RFC 7591), for this
    // console's callback, as a native client on a loopback address.
    assert.equal(provider.registrations.length, 1);
    const registered = provider.registrations[0]!;
    assert.deepEqual(registered.redirect_uris, [`${api.url}/api/oauth/callback`]);
    assert.equal(registered.application_type, 'native');
    assert.equal(registered.token_endpoint_auth_method, 'none');
    assert.deepEqual(registered.grant_types, ['authorization_code', 'refresh_token']);

    // The request: PKCE with S256, a state, the scope the server asked for,
    // and the server itself as the resource (RFC 8707).
    const query = authorize.searchParams;
    assert.equal(query.get('response_type'), 'code');
    assert.equal(query.get('client_id'), 'client-1');
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.match(query.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(query.get('resource'), provider.mcpUrl);
    assert.equal(query.get('scope'), 'read write');
    assert.match(query.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);

    // The owner signs in; the provider sends their browser back with a code.
    const landed = await followSignIn(started.body.authorizeUrl as string);
    assert.equal(landed.status, 200, landed.text);
    assert.match(landed.text, /Signed in to tracker/);
    assert.ok(!landed.text.includes('access-1') && !landed.text.includes('refresh-1'), 'the tokens never reach the browser');
    const exchange = provider.tokenRequests[0]!;
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.equal(exchange.get('resource'), provider.mcpUrl);
    assert.equal(createHash('sha256').update(exchange.get('code_verifier') ?? '').digest('base64url'), query.get('code_challenge'),
      'the verifier the challenge was made from');

    // The state is spent: the same answer again is refused.
    const again = await fetch(landed.callback);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /no sign-in is waiting for that answer/);

    // Listed, and its tools looked at with the token, which never comes back.
    const listed = await api.call('GET', '/api/control/mcp', token);
    assert.deepEqual(listed.body.signedIn, { tracker: { issuer: provider.issuer, url: provider.mcpUrl } });
    assert.ok(!JSON.stringify(listed.body).includes('access-1'));
    assert.equal(listed.body.callback, `${api.url}/api/oauth/callback`,
      'the return address, for a vendor that makes the owner register a client first');
    const looked = await api.call('POST', '/api/control/mcp/inspect', token, { name: 'tracker', url: provider.mcpUrl });
    assert.equal(looked.body.problem, null, JSON.stringify(looked.body));
    assert.deepEqual((looked.body.tools as Array<{ name: string }>).map((tool) => tool.name), ['lookup']);
    assert.equal(provider.bearers.at(-1), 'Bearer access-1');
    // A preset's own way of sending a pasted key (Sentry's scheme) is not how
    // a sign-in's token goes: an OAuth access token is a bearer token.
    const lookedAs = await api.call('POST', '/api/control/mcp/inspect', token, {
      name: 'tracker', url: provider.mcpUrl, tokenIn: { scheme: 'Sentry-Bearer' },
    });
    assert.equal(lookedAs.body.problem, null, JSON.stringify(lookedAs.body));
    assert.equal(provider.bearers.at(-1), 'Bearer access-1');

    // Saved with the device, it starts with the token, as a pasted one does.
    const saved = await api.call('POST', '/api/control/mcp/servers', token, {
      name: 'tracker', url: provider.mcpUrl, tokenIn: { scheme: 'Sentry-Bearer' }, tools: { lookup: { tier: 0 } }, proof: { totp: api.code() },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const env = withSettings({}, await readSettings());
    assert.equal(JSON.parse(env.PALUGADA_MCP_SETTINGS!).servers[0].tokenIn, undefined, 'saved to send its token as a bearer token');
    const next = new CapabilityRegistry();
    const bound = await bindMcpServers(next, JSON.parse(env.PALUGADA_MCP_SETTINGS!), 'the console', { resolve: (reference) => api.secrets.resolve(reference) });
    assert.deepEqual(bound.bound, ['mcp.tracker.lookup']);
  } finally {
    await api.close();
  }
});

test('a token that has run out is refreshed when the server says so, and the call goes through; one that cannot be says to sign in again', async () => {
  const provider = await oauthProvider();
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const started = await api.call('POST', '/api/control/mcp/oauth/start', token, { name: 'tracker', url: provider.mcpUrl });
    await followSignIn(started.body.authorizeUrl as string);
    assert.equal((await api.call('POST', '/api/control/mcp/servers', token, {
      name: 'tracker', url: provider.mcpUrl, tools: { lookup: { tier: 0 } }, proof: { totp: api.code() },
    })).status, 200);

    const env = withSettings({}, await readSettings());
    const registry = new CapabilityRegistry();
    const options = {
      resolve: (reference: string) => api.secrets.resolve(reference),
      refresh: (name: string, since: number) => refreshMcpAccess(name, since, { secrets: api.secrets, master: () => api.master }),
    };
    await bindMcpServers(registry, JSON.parse(env.PALUGADA_MCP_SETTINGS!), 'the console', options);
    const lookup = registry.get('mcp.tracker.lookup') as unknown as { execute(input: unknown, ctx: never): Promise<unknown> };

    // The provider ends the first token; the next call is refused with 401,
    // the token refreshed with the resource, and the call made again.
    provider.expire('access-1');
    const answer = await lookup.execute({ q: 'kopi' }, context());
    assert.deepEqual(answer, { found: 'kopi' });
    const refreshed = provider.tokenRequests.at(-1)!;
    assert.equal(refreshed.get('grant_type'), 'refresh_token');
    assert.equal(refreshed.get('refresh_token'), 'refresh-1');
    assert.equal(refreshed.get('resource'), provider.mcpUrl);
    assert.equal(provider.bearers.at(-1), 'Bearer access-2');
    // The new refresh token replaces the old, which the provider has spent.
    assert.equal(await api.secrets.resolve('db://mcp-tracker-refresh'), 'refresh-2');

    // A sign-in the provider has ended cannot be refreshed: said as such.
    provider.expire('access-2');
    provider.revoke('refresh-2');
    await assert.rejects(lookup.execute({ q: 'kopi' }, context()), /sign-in to tracker has ended.*sign in to it again/);
  } finally {
    await api.close();
  }
});

test('a sign-in is refused where the metadata does not say who it is: another resource, no PKCE, another issuer, a wrong issuer on the answer', async () => {
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const start = (url: string) => api.call('POST', '/api/control/mcp/oauth/start', token, { name: 'tracker', url });

    const elsewhere = await oauthProvider({ resource: 'https://other.example/mcp' });
    const refused = await start(elsewhere.mcpUrl);
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /says it is https:\/\/other\.example\/mcp/);

    const plain = await oauthProvider({ pkce: false });
    assert.match(String((await start(plain.mcpUrl)).body.error), /does not offer PKCE with S256/);

    const impostor = await oauthProvider({ issuer: 'https://impostor.example' });
    assert.match(String((await start(impostor.mcpUrl)).body.error), /calls itself https:\/\/impostor\.example/);

    const mixed = await oauthProvider({ answerIssuer: 'https://attacker.example' });
    const started = await start(mixed.mcpUrl);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const landed = await followSignIn(started.body.authorizeUrl as string);
    assert.equal(landed.status, 400);
    assert.match(landed.text, /came from https:\/\/attacker\.example/);
    assert.equal(mixed.tokenRequests.length, 0, 'the code was never redeemed');

    // One with no way to register a client asks for the one the owner made.
    const registered = await oauthProvider({ registration: false });
    const asked = await start(registered.mcpUrl);
    assert.equal(asked.status, 400);
    assert.match(String(asked.body.error), /registers no client itself: register PALUGADA with .* and give its client ID/);
    const given = await api.call('POST', '/api/control/mcp/oauth/start', token,
      { name: 'tracker', url: registered.mcpUrl, clientId: 'owner-app', clientSecret: 'owner-app-secret-0123456789' });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    await followSignIn(given.body.authorizeUrl as string);
    assert.equal(registered.tokenAuth.at(-1), `Basic ${Buffer.from('owner-app:owner-app-secret-0123456789').toString('base64')}`);
  } finally {
    await api.close();
  }
});

/* ------------------------------------------------------------ the fakes --- */

function context() {
  return {
    companyId: '00000000-0000-4000-8000-000000000001',
    divisionId: '00000000-0000-4000-8000-000000000002',
    taskId: '00000000-0000-4000-8000-000000000003',
    idempotencyKey: 'k',
  } as never;
}

/** The owner's browser: to the authorization page, and on to where it sends them back. */
async function followSignIn(authorizeUrl: string): Promise<{ status: number; text: string; callback: string }> {
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const callback = consent.headers.get('location');
  assert.ok(callback, `the provider sent the browser back (${consent.status})`);
  const landed = await fetch(callback);
  return { status: landed.status, text: await landed.text(), callback };
}

/**
 * An MCP server and the authorization server it names, on one port: the
 * shape Linear's and Sentry's take, with each part able to be wrong.
 */
async function oauthProvider(options: {
  resource?: string; pkce?: boolean; issuer?: string; answerIssuer?: string; registration?: boolean;
} = {}) {
  const registrations: Array<Record<string, unknown>> = [];
  const tokenRequests: URLSearchParams[] = [];
  const tokenAuth: Array<string | null> = [];
  const bearers: Array<string | null> = [];
  const challenges = new Map<string, { challenge: string; redirect: string; state: string }>();
  const live = new Set<string>();
  const refreshable = new Map<string, number>();
  let issued = 0;
  let base = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const issuer = `${base}/as`;
      if (url.pathname === '/mcp') {
        bearers.push(req.headers.authorization ?? null);
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!bearer || !live.has(bearer)) {
          return json(401, { error: 'invalid_token' }, {
            'www-authenticate': `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
          });
        }
        const message = JSON.parse(raw) as { id?: number; method: string; params?: { arguments?: { q?: string } } };
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tracker', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'lookup', description: 'Finds an issue.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }
            : { content: [{ type: 'text', text: JSON.stringify({ found: message.params?.arguments?.q }) }], structuredContent: { found: message.params?.arguments?.q } };
        return json(200, { jsonrpc: '2.0', id: message.id, result });
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return json(200, { resource: options.resource ?? `${base}/mcp`, authorization_servers: [issuer], scopes_supported: ['read', 'write'] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server/as') {
        return json(200, {
          issuer: options.issuer ?? issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(options.registration === false ? {} : { registration_endpoint: `${issuer}/register` }),
          ...(options.pkce === false ? {} : { code_challenge_methods_supported: ['S256'] }),
          ...(options.registration === false ? {} : { token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] }),
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === '/as/register' && req.method === 'POST') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        registrations.push(body);
        return json(201, { ...body, client_id: `client-${registrations.length}` });
      }
      if (url.pathname === '/as/authorize') {
        const code = `code-${challenges.size + 1}`;
        challenges.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')!, state: url.searchParams.get('state')! });
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state')!);
        back.searchParams.set('iss', options.answerIssuer ?? issuer);
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (url.pathname === '/as/token' && req.method === 'POST') {
        const form = new URLSearchParams(raw);
        tokenRequests.push(form);
        tokenAuth.push(req.headers.authorization ?? null);
        const grant = () => {
          issued += 1;
          live.add(`access-${issued}`);
          refreshable.set(`refresh-${issued}`, issued);
          return json(200, { access_token: `access-${issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${issued}` });
        };
        if (form.get('grant_type') === 'authorization_code') {
          const pending = challenges.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (!pending || createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
            return json(400, { error: 'invalid_grant' });
          }
          challenges.delete(form.get('code')!);
          return grant();
        }
        if (form.get('grant_type') === 'refresh_token') {
          const presented = form.get('refresh_token') ?? '';
          if (!refreshable.has(presented)) return json(400, { error: 'invalid_grant', error_description: 'the refresh token is not valid' });
          refreshable.delete(presented);
          return grant();
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      json(404, { error: 'not here' });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    mcpUrl: `${base}/mcp`,
    issuer: `${base}/as`,
    registrations,
    tokenRequests,
    tokenAuth,
    bearers,
    expire: (token: string) => live.delete(token),
    revoke: (token: string) => refreshable.delete(token),
  };
}
