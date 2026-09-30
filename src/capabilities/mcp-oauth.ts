/**
 * Signing in to an MCP server that asks for OAuth.
 *
 * Most hosted MCP servers -- Linear, Notion, Sentry, Atlassian, Stripe -- take
 * no pasted key. They answer 401 and name an authorization server, and a
 * client is expected to sign its user in there. PALUGADA could only send a
 * token the owner pasted, so none of them could be connected. This is the
 * client side of the MCP authorization spec (revision 2026-07-28), in the
 * order it asks for:
 *
 * 1. **Discovery.** The server's protected resource metadata (RFC 9728), from
 *    the 401's `resource_metadata` or the well-known fallbacks, then its
 *    authorization server's (RFC 8414, OpenID discovery). Each is checked for
 *    the identity it claims, and the authorization server for PKCE with S256.
 * 2. **Registration.** A client the owner registered, or one registered here
 *    (RFC 7591), kept per authorization server and never used with another.
 * 3. **The owner's sign-in.** An authorization request with PKCE, a state, and
 *    the server as its `resource` (RFC 8707), opened in the owner's browser.
 *    The answer arrives at the callback, which checks the state and the issuer
 *    (RFC 9207) before the code is redeemed.
 * 4. **Tokens.** Sealed as deployment secrets. The access token is the
 *    server's token, as a pasted one would be, and it is refreshed when the
 *    server answers 401.
 *
 * Every request goes through `safeFetch`, and nothing is followed on a
 * redirect: a metadata document names addresses this process then fetches,
 * and a server's own 401 is where they come from. An authorization server is
 * reached over https; plain http only on the same host as an MCP server on
 * this network, which is how a company's own runs.
 *
 * Not built: Client ID Metadata Documents, which need an address the
 * authorization server can fetch, and re-authorizing for more scope on a 403.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import { withControlPlane } from '../db/tenant.ts';
import { safeFetch } from './reachable.ts';
import { assertPlainHttpIsLocal } from './mcp.ts';
import { deleteSecret, putSecret, readSettings, writeSetting, type MasterKey } from '../settings/store.ts';
import type { SecretManager } from '../secrets/manager.ts';

/** How long a sign-in may take between the console and the callback. */
const SIGN_IN_MINUTES = 10;

type AuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

/** What the owner's sign-in left, kept in the deployment's settings under `mcp_oauth`. */
export interface OAuthGrant {
  url: string;
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecretName?: string;
  authMethod: AuthMethod;
  scope?: string;
  expiresAt?: string;
  refreshedAt: string;
}

/** A client registered with an authorization server, under `mcp_clients`, keyed by its issuer. */
interface OAuthClient {
  redirectUri: string;
  clientId: string;
  clientSecretName?: string;
  authMethod: AuthMethod;
}

interface SignInPoint {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  authMethods: readonly string[];
  issRequired: boolean;
  scope: string | null;
}

/**
 * The sealed secret a server's token is kept under, and its refresh token.
 * A server's name may hold `_`, which a secret's may not; such a name is kept
 * under a hash of it instead, so a server named that way can have a token.
 */
export function mcpSecretName(server: string, part: 'token' | 'refresh' = 'token'): string {
  const base = /^[a-z0-9-]+$/.test(server) ? `mcp-${server}` : `mcp-h${createHash('sha256').update(server).digest('hex').slice(0, 16)}`;
  return part === 'refresh' ? `${base}-refresh` : base;
}

export function oauthGrantsIn(settings: Record<string, unknown>): Record<string, OAuthGrant> {
  return (settings.mcp_oauth as Record<string, OAuthGrant> | undefined) ?? {};
}

/* -------------------------------------------------------------- discovery --- */

/** Refuses an address a sign-in may not be sent to. */
function assertEndpoint(target: string, server: URL, what: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new PalugadaError('config.invalid', `${what} is not an address: ${target.slice(0, 200)}`, {});
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && url.hostname === server.hostname) {
    assertPlainHttpIsLocal(url.toString());
    return url;
  }
  throw new PalugadaError('config.invalid', `${what} is ${url.origin}; a sign-in is reached over https`, {});
}

async function request(
  target: URL,
  server: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; json: unknown }> {
  const answer = await safeFetch(target.toString(), {
    ...init,
    maxRedirects: 0,
    maxBytes: 256 * 1024,
    timeoutMs: 15_000,
    // The MCP server's own host is as trusted as the server; it may be on
    // this network, and its authorization server with it.
    allowPrivateHosts: [server.hostname],
  });
  let json: unknown = null;
  try {
    json = answer.body ? JSON.parse(answer.body) : null;
  } catch {
    json = null;
  }
  return { status: answer.status, headers: answer.headers, json };
}

/** A `WWW-Authenticate` challenge's parameters (RFC 9110 11.6.1), by lower-case name. */
function challengeParams(header: string | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of (header ?? '').matchAll(/([A-Za-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g)) {
    params[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return params;
}

/** Whether metadata's `resource` names this server (RFC 9728 3.3): its origin, and its path or a parent of it. */
function namesServer(resource: string, server: URL): boolean {
  let named: URL;
  try {
    named = new URL(resource);
  } catch {
    return false;
  }
  if (named.origin !== server.origin) return false;
  const path = named.pathname.replace(/\/+$/, '');
  const at = server.pathname.replace(/\/+$/, '');
  return path === '' || at === path || at.startsWith(`${path}/`);
}

/**
 * Whether a server asks for a sign-in, and where: null when it answers
 * without one. An `initialize` is sent bare; a 401 names the metadata, or
 * the well-known addresses are tried in the spec's order.
 */
export async function discoverSignIn(url: string): Promise<SignInPoint | null> {
  const server = new URL(url);
  const probe = await request(server, server, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'palugada', version: '1' } },
    }),
  });
  if (probe.status !== 401) return null;
  const challenge = challengeParams(probe.headers['www-authenticate']);

  // The protected resource's metadata: where the challenge says, or the
  // path-aware well-known address and then the root one.
  const path = server.pathname.replace(/\/+$/, '');
  const candidates = challenge.resource_metadata
    ? [challenge.resource_metadata]
    : [...(path ? [`${server.origin}/.well-known/oauth-protected-resource${path}`] : []), `${server.origin}/.well-known/oauth-protected-resource`];
  type ResourceMetadata = { resource?: unknown; authorization_servers?: unknown; scopes_supported?: unknown };
  let metadata: ResourceMetadata | null = null;
  for (const candidate of candidates) {
    const answer = await request(assertEndpoint(candidate, server, 'the server\'s metadata'), server);
    if (answer.status === 200 && answer.json && typeof answer.json === 'object') {
      metadata = answer.json as ResourceMetadata;
      break;
    }
  }
  if (!metadata) {
    throw new PalugadaError('config.invalid', `${server.origin} asks for a sign-in and publishes no metadata saying where`, { url });
  }
  const resource = typeof metadata.resource === 'string' ? metadata.resource : '';
  if (!namesServer(resource, server)) {
    throw new PalugadaError('config.invalid',
      `${url} says it is ${resource || 'nothing'}: a server's metadata must name the server it came from`, { url, resource });
  }
  const issuers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers.filter((one): one is string => typeof one === 'string') : [];
  if (issuers.length === 0) {
    throw new PalugadaError('config.invalid', `${url} names no authorization server to sign in with`, { url });
  }
  const issuer = issuers[0]!;

  // Its authorization server's metadata, in the spec's order, and only if it
  // calls itself what it was looked up as (RFC 8414 3.3).
  const issuerUrl = assertEndpoint(issuer, server, 'the authorization server');
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, '');
  const wellKnown = issuerPath
    ? [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
      `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
    ]
    : [`${issuerUrl.origin}/.well-known/oauth-authorization-server`, `${issuerUrl.origin}/.well-known/openid-configuration`];
  let authority: Record<string, unknown> | null = null;
  for (const candidate of wellKnown) {
    const answer = await request(new URL(candidate), server);
    if (answer.status === 200 && answer.json && typeof answer.json === 'object') {
      authority = answer.json as Record<string, unknown>;
      break;
    }
  }
  if (!authority) {
    throw new PalugadaError('config.invalid', `${issuer} publishes no metadata to sign in with`, { issuer });
  }
  if (authority.issuer !== issuer) {
    throw new PalugadaError('config.invalid',
      `the authorization server at ${issuer} calls itself ${String(authority.issuer)}; a sign-in is not sent to a server that is not what it says`,
      { issuer });
  }
  const methods = Array.isArray(authority.code_challenge_methods_supported) ? authority.code_challenge_methods_supported : [];
  if (!methods.includes('S256')) {
    throw new PalugadaError('config.invalid', `${issuer} does not offer PKCE with S256, which the sign-in needs`, { issuer });
  }
  const authorizationEndpoint = assertEndpoint(String(authority.authorization_endpoint ?? ''), server, 'the sign-in page').toString();
  const tokenEndpoint = assertEndpoint(String(authority.token_endpoint ?? ''), server, 'the token endpoint').toString();
  const registrationEndpoint = typeof authority.registration_endpoint === 'string'
    ? assertEndpoint(authority.registration_endpoint, server, 'the registration endpoint').toString() : null;

  // What to ask for: the challenge's scope, which is authoritative for this
  // request, else every scope the resource lists, else none; and
  // offline_access, where it is offered, so the sign-in can be refreshed.
  const listed = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter((one): one is string => typeof one === 'string') : [];
  const scopes = (challenge.scope ? challenge.scope.split(/\s+/) : listed).filter(Boolean);
  const offered = Array.isArray(authority.scopes_supported) ? authority.scopes_supported : [];
  if (scopes.length > 0 && offered.includes('offline_access') && !scopes.includes('offline_access')) scopes.push('offline_access');

  return {
    resource,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    // RFC 8414: an absent list means client_secret_basic alone.
    authMethods: Array.isArray(authority.token_endpoint_auth_methods_supported)
      ? authority.token_endpoint_auth_methods_supported.filter((one): one is string => typeof one === 'string')
      : ['client_secret_basic'],
    issRequired: authority.authorization_response_iss_parameter_supported === true,
    scope: scopes.length > 0 ? scopes.join(' ') : null,
  };
}

/* ----------------------------------------------------------- registration --- */

function clientSecretName(issuer: string): string {
  return `mcp-client-${createHash('sha256').update(issuer).digest('hex').slice(0, 16)}`;
}

/**
 * The client this deployment signs in as, with this authorization server: the
 * one the owner registered and gave, the one registered here before for the
 * same callback, or one registered now. Kept by issuer, and never offered to
 * another authorization server.
 */
async function clientFor(
  point: SignInPoint,
  redirectUri: string,
  given: { clientId: string; clientSecret?: string } | null,
  master: MasterKey,
  server: URL,
): Promise<OAuthClient> {
  const clients = ((await readSettings()).mcp_clients as Record<string, OAuthClient> | undefined) ?? {};
  let client: OAuthClient;
  if (given) {
    const secret = given.clientSecret ?? null;
    client = {
      redirectUri,
      clientId: given.clientId,
      authMethod: !secret ? 'none'
        : point.authMethods.includes('client_secret_basic') || !point.authMethods.includes('client_secret_post') ? 'client_secret_basic'
          : 'client_secret_post',
    };
    if (secret) {
      client.clientSecretName = clientSecretName(point.issuer);
      await putSecret(client.clientSecretName, secret, master);
    }
  } else if (clients[point.issuer]?.redirectUri === redirectUri) {
    return clients[point.issuer]!;
  } else {
    if (!point.registrationEndpoint) {
      throw new PalugadaError('config.invalid',
        `${point.issuer} registers no client itself: register PALUGADA with it, with ${redirectUri} as the address to come back to, `
          + 'and give its client ID (and its secret, if it has one)',
        { issuer: point.issuer, redirectUri });
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(redirectUri).hostname);
    const method: AuthMethod = point.authMethods.includes('none') ? 'none'
      : point.authMethods.includes('client_secret_basic') ? 'client_secret_basic' : 'client_secret_post';
    const answer = await request(new URL(point.registrationEndpoint), server, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'PALUGADA',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: method,
        application_type: loopback ? 'native' : 'web',
      }),
    });
    const registered = answer.json as { client_id?: unknown; client_secret?: unknown; token_endpoint_auth_method?: unknown } | null;
    if ((answer.status !== 200 && answer.status !== 201) || typeof registered?.client_id !== 'string') {
      throw new PalugadaError('capability.unreachable',
        `${point.issuer} would not register PALUGADA (${answer.status}): ${describeError(answer.json)}`, { issuer: point.issuer });
    }
    const kept = registered.token_endpoint_auth_method;
    client = {
      redirectUri,
      clientId: registered.client_id,
      authMethod: kept === 'client_secret_basic' || kept === 'client_secret_post' || kept === 'none' ? kept : method,
    };
    if (typeof registered.client_secret === 'string' && registered.client_secret) {
      client.clientSecretName = clientSecretName(point.issuer);
      await putSecret(client.clientSecretName, registered.client_secret, master);
    }
  }
  await writeSetting('mcp_clients', { ...clients, [point.issuer]: client });
  return client;
}

function describeError(json: unknown): string {
  const body = json as { error?: unknown; error_description?: unknown } | null;
  const text = [body?.error, body?.error_description].filter((part) => typeof part === 'string').join(': ');
  return (text || 'no reason given').slice(0, 300);
}

/* ---------------------------------------------------------------- sign-in --- */

function hashOf(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/**
 * Begins a sign-in: discovers where, registers or finds the client, and keeps
 * what the callback needs. Returns the address the owner's browser opens.
 */
export async function beginSignIn(input: {
  name: string;
  url: string;
  redirectUri: string;
  client: { clientId: string; clientSecret?: string } | null;
  master: MasterKey;
}): Promise<{ authorizeUrl: string; issuer: string }> {
  const server = new URL(input.url);
  const point = await discoverSignIn(input.url);
  if (!point) {
    throw new PalugadaError('config.invalid', `${input.url} answers without a sign-in; it needs none`, { url: input.url });
  }
  const client = await clientFor(point, input.redirectUri, input.client, input.master, server);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await withControlPlane(async (tx) => {
    await tx.query('DELETE FROM mcp_authorizations WHERE expires_at < now()');
    await tx.query(
      `INSERT INTO mcp_authorizations
         (state_hash, server_name, server_url, resource, issuer, token_endpoint, client_id, client_secret_name,
          auth_method, code_verifier, redirect_uri, scope, iss_required, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(mins => $14))`,
      [hashOf(state), input.name, input.url, point.resource, point.issuer, point.tokenEndpoint, client.clientId,
        client.clientSecretName ?? null, client.authMethod, verifier, input.redirectUri, point.scope, point.issRequired, SIGN_IN_MINUTES],
    );
  });
  const authorize = new URL(point.authorizationEndpoint);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', client.clientId);
  authorize.searchParams.set('redirect_uri', input.redirectUri);
  authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('resource', point.resource);
  if (point.scope) authorize.searchParams.set('scope', point.scope);
  return { authorizeUrl: authorize.toString(), issuer: point.issuer };
}

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
}

/** One request to the token endpoint, with the client's own way of saying who it is. */
async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  client: { clientId: string; secret: string | null; authMethod: AuthMethod },
  server: URL,
): Promise<Tokens> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.authMethod === 'client_secret_basic' && client.secret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.authMethod === 'client_secret_post' && client.secret) body.set('client_secret', client.secret);
  }
  const answer = await request(new URL(endpoint), server, { method: 'POST', headers, body: body.toString() });
  const tokens = answer.json as { access_token?: unknown; token_type?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  if (answer.status !== 200 || typeof tokens?.access_token !== 'string' || !tokens.access_token) {
    throw new PalugadaError('credential.unavailable', `the token endpoint answered ${answer.status}: ${describeError(answer.json)}`, {});
  }
  if (tokens.token_type !== undefined && !/^bearer$/i.test(String(tokens.token_type))) {
    throw new PalugadaError('credential.unavailable', `the token endpoint gave a ${String(tokens.token_type)} token; a bearer token is what an MCP server takes`, {});
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null,
    expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : null,
    scope: typeof tokens.scope === 'string' ? tokens.scope : null,
  };
}

async function keepTokens(name: string, tokens: Tokens, grant: Omit<OAuthGrant, 'refreshedAt' | 'expiresAt'>, master: MasterKey): Promise<void> {
  await putSecret(mcpSecretName(name), tokens.accessToken, master);
  if (tokens.refreshToken) await putSecret(mcpSecretName(name, 'refresh'), tokens.refreshToken, master);
  const settings = await readSettings();
  const kept: OAuthGrant = {
    ...grant,
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(tokens.expiresIn ? { expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString() } : {}),
    refreshedAt: new Date().toISOString(),
  };
  await writeSetting('mcp_oauth', { ...oauthGrantsIn(settings), [name]: kept });
}

/**
 * The callback: the owner's browser, back from the authorization server. The
 * state is spent whatever happens next; the issuer is checked before the code
 * is redeemed, and nothing the answer says is shown when it is not.
 */
export async function finishSignIn(
  query: URLSearchParams,
  deps: { secrets: SecretManager; master: MasterKey },
): Promise<{ name: string }> {
  const state = query.get('state') ?? '';
  const pending = state ? await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      server_name: string; server_url: string; resource: string; issuer: string; token_endpoint: string; client_id: string;
      client_secret_name: string | null; auth_method: AuthMethod; code_verifier: string; redirect_uri: string; scope: string | null;
      iss_required: boolean;
    }>(
      `DELETE FROM mcp_authorizations WHERE state_hash = $1 AND expires_at > now()
       RETURNING server_name, server_url, resource, issuer, token_endpoint, client_id, client_secret_name, auth_method,
                 code_verifier, redirect_uri, scope, iss_required`,
      [hashOf(state)],
    );
    return rows[0] ?? null;
  }) : null;
  if (!pending) {
    throw new PalugadaError('contract.violation', 'no sign-in is waiting for that answer: it was used, it took over ten minutes, or it was never begun; begin it again from the console', {});
  }
  const iss = query.get('iss');
  if (iss !== null && iss !== pending.issuer) {
    throw new PalugadaError('contract.violation', `this answer came from ${iss}, not from ${pending.issuer}; nothing was kept`, {});
  }
  if (iss === null && pending.iss_required) {
    throw new PalugadaError('contract.violation', `${pending.issuer} says who it is on every answer, and this one did not; nothing was kept`, {});
  }
  const error = query.get('error');
  if (error) {
    const said = query.get('error_description');
    throw new PalugadaError('contract.violation', `${pending.issuer} did not sign you in: ${(said ?? error).slice(0, 300)}`, {});
  }
  const code = query.get('code');
  if (!code) throw new PalugadaError('contract.violation', `${pending.issuer} sent no code back`, {});

  const secret = pending.client_secret_name ? await deps.secrets.resolve(`db://${pending.client_secret_name}`) : null;
  const tokens = await tokenRequest(pending.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    code_verifier: pending.code_verifier,
    redirect_uri: pending.redirect_uri,
    resource: pending.resource,
  }, { clientId: pending.client_id, secret, authMethod: pending.auth_method }, new URL(pending.server_url));
  if (!tokens.refreshToken) await deleteSecret(mcpSecretName(pending.server_name, 'refresh'));
  await keepTokens(pending.server_name, tokens, {
    url: pending.server_url,
    resource: pending.resource,
    issuer: pending.issuer,
    tokenEndpoint: pending.token_endpoint,
    clientId: pending.client_id,
    ...(pending.client_secret_name ? { clientSecretName: pending.client_secret_name } : {}),
    authMethod: pending.auth_method,
    ...(pending.scope ? { scope: pending.scope } : {}),
  }, deps.master);
  return { name: pending.server_name };
}

/**
 * A fresh access token for a server signed in to with OAuth, when the one in
 * the store was refused. One refresh at a time across every worker, and none
 * when another has refreshed since the refused call began: a refresh token is
 * spent by its use, and two workers spending it would sign the server out.
 * Returns whether a token worth trying again is in the store.
 */
export async function refreshMcpAccess(
  name: string,
  since: number,
  deps: { secrets: SecretManager; master: () => MasterKey | null },
): Promise<boolean> {
  if (!oauthGrantsIn(await readSettings())[name]) return false;
  return withControlPlane(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mcp-oauth:${name}`]);
    const grant = oauthGrantsIn(await readSettings())[name];
    if (!grant) return false;
    if (Date.parse(grant.refreshedAt) > since) return true;
    const ended = (why: string) => new PalugadaError('credential.unavailable',
      `the sign-in to ${name} has ended (${why}): sign in to it again on This deployment, MCP servers`, { server: name });
    const master = deps.master();
    if (!master) throw ended('this deployment cannot seal the new token');
    const refresh = await deps.secrets.resolve(`db://${mcpSecretName(name, 'refresh')}`).catch(() => null);
    if (!refresh) throw ended('it gave no way to refresh it');
    const secret = grant.clientSecretName ? await deps.secrets.resolve(`db://${grant.clientSecretName}`) : null;
    let tokens: Tokens;
    try {
      tokens = await tokenRequest(grant.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        resource: grant.resource,
      }, { clientId: grant.clientId, secret, authMethod: grant.authMethod }, new URL(grant.url));
    } catch (failure) {
      throw ended((failure as Error).message);
    }
    const { refreshedAt: _refreshedAt, expiresAt: _expiresAt, ...kept } = grant;
    await keepTokens(name, tokens, kept, master);
    return true;
  });
}

/** Forgets a server's sign-in: its tokens and what it was, as the server is removed. */
export async function forgetSignIn(name: string): Promise<void> {
  await deleteSecret(mcpSecretName(name, 'refresh'));
  const grants = oauthGrantsIn(await readSettings());
  if (!grants[name]) return;
  const { [name]: _gone, ...rest } = grants;
  await writeSetting('mcp_oauth', Object.keys(rest).length > 0 ? rest : null);
}
