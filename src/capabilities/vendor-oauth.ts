/**
 * A division's key for a vendor, got by signing in rather than by pasting.
 *
 * Google Calendar and Gmail take no key a person can paste: an API key reads
 * public data only, and a token for someone's calendar comes from their
 * sign-in and runs out within the hour. Google's own MCP servers are a
 * developer preview. So a vendor entry may say how its key is signed in for
 * (`signIn`): the authorization server's two addresses, or a provider this
 * module knows by name, and the scopes its call needs. The owner then signs a
 * division in from its keys, in their own browser, with RFC 6749's
 * authorization code grant and PKCE (RFC 7636).
 *
 * What the sign-in leaves is the division's credential, as a pasted key is:
 * sealed as a deployment secret under a name only a division's credential
 * may use (`credential-oauth-...`), scoped to what its capabilities need,
 * and rotated by signing in again. The value sealed is the grant -- the
 * access token, the refresh token and when the first runs out -- and
 * `OAuthCredentials` turns it into the access token wherever a credential is
 * resolved, refreshing it first when it has five minutes or less to run. A
 * refresh is one at a time across every worker: some providers spend a
 * refresh token by its use, and two workers spending it would sign the
 * division out.
 *
 * The client -- the app the owner registers with the provider, once per
 * deployment -- is kept under `oauth_clients` by the provider's name, its
 * secret sealed. Few of these providers register a client on request, so
 * this asks for one rather than trying.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import { withControlPlane } from '../db/tenant.ts';
import { safeFetch } from './reachable.ts';
import { putSecret, readSettings, writeSetting, type MasterKey } from '../settings/store.ts';
import { redactor, type SecretManager } from '../secrets/manager.ts';

/** How long a sign-in may take between the console and the callback. */
const SIGN_IN_MINUTES = 10;

/** A token with this long or less to run is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** The sealed name a signed-in credential is kept under; a division's, by its prefix. */
export const OAUTH_CREDENTIALS = 'credential-oauth-';

/** How a vendor entry's key is signed in for, as the entry writes it. */
export interface SignInSpec {
  /** A provider named below, or the name of one the entry describes itself. */
  provider: string;
  scopes: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  /** More parameters for the authorization request, such as `access_type`. */
  params?: Record<string, string>;
  /** Where the owner registers the app, for the console to link to. */
  clientUrl?: string;
}

/** The same, with every address filled in and checked. */
export interface CredentialSignIn {
  provider: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  params: Record<string, string>;
  clientUrl: string | null;
}

/**
 * Providers known by name, so an entry says `"provider": "google"` and the
 * scopes it needs. Each as its own documentation gave it in September 2026.
 * Google gives a refresh token only when asked for offline access, and again
 * only when consent is asked for again; Microsoft only for `offline_access`.
 */
const PROVIDERS: Record<string, Omit<CredentialSignIn, 'scopes'> & { always?: string[] }> = {
  google: {
    provider: 'google',
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    params: { access_type: 'offline', prompt: 'consent' },
    clientUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    provider: 'microsoft',
    name: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    params: {},
    clientUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    always: ['offline_access'],
  },
};

/** An address a sign-in may use: https, or plain http on this machine, as a test's is. */
function signInAddress(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PalugadaError('config.invalid', `${what} is not an address`, { field: 'signIn' });
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PalugadaError('config.invalid', `${what} is ${url.origin}; a sign-in is reached over https`, { field: 'signIn' });
  }
  return url.toString();
}

/** A vendor entry's `signIn`, filled in from the provider it names and checked. */
export function signInFrom(spec: SignInSpec): CredentialSignIn {
  const known = PROVIDERS[spec.provider];
  const authorizeUrl = spec.authorizeUrl ?? known?.authorizeUrl;
  const tokenUrl = spec.tokenUrl ?? known?.tokenUrl;
  if (!authorizeUrl || !tokenUrl) {
    throw new PalugadaError('config.invalid',
      `${spec.provider} is not a provider PALUGADA knows (${Object.keys(PROVIDERS).join(', ')}); `
        + 'give its authorizeUrl and tokenUrl', { field: 'signIn' });
  }
  return {
    provider: spec.provider,
    name: known?.name ?? spec.provider,
    authorizeUrl: signInAddress(authorizeUrl, 'its authorizeUrl'),
    tokenUrl: signInAddress(tokenUrl, 'its tokenUrl'),
    scopes: [...new Set([...(known?.always ?? []), ...spec.scopes])],
    params: { ...(known?.params ?? {}), ...(spec.params ?? {}) },
    clientUrl: spec.clientUrl ?? known?.clientUrl ?? null,
  };
}

/* ---------------------------------------------------------------- clients --- */

type AuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

interface ProviderClient {
  clientId: string;
  clientSecretName?: string;
  authMethod: AuthMethod;
  /**
   * The token endpoint the app was registered for. A refresh sends the app's
   * secret, and sends it here and nowhere a grant's own record might name.
   */
  tokenUrl: string;
}

function clientsIn(settings: Record<string, unknown>): Record<string, ProviderClient> {
  return (settings.oauth_clients as Record<string, ProviderClient> | undefined) ?? {};
}

/** Whether the owner has registered an app with this provider for this deployment. */
export async function hasClient(provider: string): Promise<boolean> {
  return Boolean(clientsIn(await readSettings())[provider]);
}

function clientSecretName(provider: string): string {
  return `oauth-client-${createHash('sha256').update(provider).digest('hex').slice(0, 16)}`;
}

/* ---------------------------------------------------------------- sign-in --- */

function hashOf(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/**
 * Begins a division's sign-in: the app the owner registered (given now, or
 * kept from before), and what the callback needs to redeem the answer.
 * Returns the page the owner's browser opens.
 */
export async function beginCredentialSignIn(input: {
  companyId: string;
  divisionId: string;
  alias: string;
  signIn: CredentialSignIn;
  redirectUri: string;
  client: { clientId: string; clientSecret?: string } | null;
  master: MasterKey;
}): Promise<{ authorizeUrl: string }> {
  const { signIn } = input;
  const clients = clientsIn(await readSettings());
  let client = clients[signIn.provider];
  if (input.client) {
    client = { clientId: input.client.clientId, authMethod: input.client.clientSecret ? 'client_secret_post' : 'none', tokenUrl: signIn.tokenUrl };
    if (input.client.clientSecret) {
      client.clientSecretName = clientSecretName(signIn.provider);
      await putSecret(client.clientSecretName, input.client.clientSecret, input.master);
    }
    await writeSetting('oauth_clients', { ...clients, [signIn.provider]: client });
  } else if (client && client.tokenUrl !== signIn.tokenUrl) {
    // The entry now names another endpoint for the same provider: the app
    // goes with it, as the entry is the owner's own.
    client = { ...client, tokenUrl: signIn.tokenUrl };
    await writeSetting('oauth_clients', { ...clients, [signIn.provider]: client });
  }
  if (!client) {
    throw new PalugadaError('config.invalid',
      `${signIn.name} lets PALUGADA in only through an app you register with it: register one, `
        + `with ${input.redirectUri} as the address to come back to, and give its client ID and secret`,
      { provider: signIn.provider, redirectUri: input.redirectUri, needsClient: true });
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await withControlPlane(async (tx) => {
    await tx.query('DELETE FROM credential_authorizations WHERE expires_at < now()');
    await tx.query(
      `INSERT INTO credential_authorizations
         (state_hash, company_id, division_id, alias, provider, token_url, client_id, client_secret_name,
          auth_method, code_verifier, redirect_uri, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + make_interval(mins => $13))`,
      [hashOf(state), input.companyId, input.divisionId, input.alias, signIn.provider, signIn.tokenUrl, client.clientId,
        client.clientSecretName ?? null, client.authMethod, verifier, input.redirectUri, signIn.scopes.join(' '), SIGN_IN_MINUTES],
    );
  });
  const authorize = new URL(signIn.authorizeUrl);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', client.clientId);
  authorize.searchParams.set('redirect_uri', input.redirectUri);
  authorize.searchParams.set('scope', signIn.scopes.join(' '));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  authorize.searchParams.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(signIn.params)) authorize.searchParams.set(name, value);
  return { authorizeUrl: authorize.toString() };
}

/** What a signed-in credential's secret holds. Never shown; resolved to its access token. */
interface Grant {
  oauth2: 1;
  provider: string;
  tokenUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string;
}

function describeError(json: unknown): string {
  const body = json as { error?: unknown; error_description?: unknown } | null;
  const text = [body?.error, body?.error_description].filter((part) => typeof part === 'string').join(': ');
  return (text || 'no reason given').slice(0, 300);
}

/** One request to a token endpoint, as the registered app. */
async function tokenRequest(
  tokenUrl: string,
  form: Record<string, string>,
  client: { clientId: string; secret: string | null; authMethod: AuthMethod },
): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string | null }> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.authMethod === 'client_secret_basic' && client.secret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.secret) body.set('client_secret', client.secret);
  }
  const target = new URL(tokenUrl);
  const answer = await safeFetch(tokenUrl, {
    method: 'POST', headers, body: body.toString(), maxRedirects: 0, maxBytes: 64 * 1024, timeoutMs: 15_000,
    // A provider on this machine is one a test runs; any other is public.
    ...(['127.0.0.1', 'localhost'].includes(target.hostname) ? { allowPrivateHosts: [target.hostname] } : {}),
  });
  let json: unknown = null;
  try {
    json = answer.body ? JSON.parse(answer.body) : null;
  } catch {
    json = null;
  }
  const tokens = json as { access_token?: unknown; token_type?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  if (answer.status !== 200 || typeof tokens?.access_token !== 'string' || !tokens.access_token) {
    throw new PalugadaError('credential.unavailable', `the token endpoint answered ${answer.status}: ${describeError(json)}`, {});
  }
  if (tokens.token_type !== undefined && !/^bearer$/i.test(String(tokens.token_type))) {
    throw new PalugadaError('credential.unavailable', `the token endpoint gave a ${String(tokens.token_type)} token; a bearer token is what a vendor call sends`, {});
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null,
    expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : null,
    scope: typeof tokens.scope === 'string' ? tokens.scope : null,
  };
}

/**
 * The callback, for a division's sign-in: null when the state is not one of
 * these, so the caller may try an MCP server's. The state is spent whatever
 * happens next. Returns the grant to seal as the division's credential.
 */
export async function finishCredentialSignIn(
  query: URLSearchParams,
  deps: { secrets: SecretManager },
): Promise<{ companyId: string; divisionId: string; alias: string; provider: string; grant: string } | null> {
  const state = query.get('state') ?? '';
  if (!state) return null;
  const pending = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      company_id: string; division_id: string; alias: string; provider: string; token_url: string; client_id: string;
      client_secret_name: string | null; auth_method: AuthMethod; code_verifier: string; redirect_uri: string; scope: string;
    }>(
      `DELETE FROM credential_authorizations WHERE state_hash = $1 AND expires_at > now()
       RETURNING company_id, division_id, alias, provider, token_url, client_id, client_secret_name, auth_method,
                 code_verifier, redirect_uri, scope`,
      [hashOf(state)],
    );
    return rows[0] ?? null;
  });
  if (!pending) return null;
  const error = query.get('error');
  if (error) {
    const said = query.get('error_description');
    throw new PalugadaError('contract.violation', `${pending.provider} did not sign you in: ${(said ?? error).slice(0, 300)}`, {});
  }
  const code = query.get('code');
  if (!code) throw new PalugadaError('contract.violation', `${pending.provider} sent no code back`, {});
  const secret = pending.client_secret_name ? await deps.secrets.resolve(`db://${pending.client_secret_name}`) : null;
  const tokens = await tokenRequest(pending.token_url, {
    grant_type: 'authorization_code',
    code,
    code_verifier: pending.code_verifier,
    redirect_uri: pending.redirect_uri,
  }, { clientId: pending.client_id, secret, authMethod: pending.auth_method });
  const grant: Grant = {
    oauth2: 1,
    provider: pending.provider,
    tokenUrl: pending.token_url,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null,
    scope: tokens.scope ?? pending.scope,
  };
  return { companyId: pending.company_id, divisionId: pending.division_id, alias: pending.alias, provider: pending.provider, grant: JSON.stringify(grant) };
}

/* ------------------------------------------------------------- resolution --- */

function grantOf(value: string): Grant | null {
  if (!value.startsWith('{"oauth2":1')) return null;
  try {
    return JSON.parse(value) as Grant;
  } catch {
    return null;
  }
}

function fresh(grant: Grant, now: number): boolean {
  return grant.expiresAt === null || Date.parse(grant.expiresAt) - now > REFRESH_MARGIN_MS;
}

/**
 * Resolves a division's credential to what a vendor call sends: a pasted key
 * as it is, and a sign-in as its access token, refreshed first when it is
 * about to run out.
 */
export class OAuthCredentials implements SecretManager {
  readonly #inner: SecretManager;
  readonly #deployment: SecretManager;
  readonly #master: () => MasterKey | null;
  readonly #now: () => number;

  /**
   * `inner` resolves the division's reference, as it would without this;
   * `deployment` the app's own secret, which no division's reference may name.
   */
  constructor(inner: SecretManager, deps: { deployment: SecretManager; master: () => MasterKey | null; now?: () => number }) {
    this.#inner = inner;
    this.#deployment = deps.deployment;
    this.#master = deps.master;
    this.#now = deps.now ?? Date.now;
  }

  async resolve(reference: string): Promise<string> {
    const value = await this.#inner.resolve(reference);
    const grant = grantOf(value);
    if (!grant) return value;
    // The tokens are secrets as the key was, and redacted as it is.
    if (grant.refreshToken) redactor.register(grant.refreshToken);
    if (fresh(grant, this.#now())) {
      redactor.register(grant.accessToken);
      return grant.accessToken;
    }
    const token = await this.#refresh(reference);
    redactor.register(token);
    return token;
  }

  async #refresh(reference: string): Promise<string> {
    const name = reference.slice('db://'.length);
    return withControlPlane(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-credential:${name}`]);
      // Read again under the lock: another worker may have refreshed it.
      const grant = grantOf(await this.#inner.resolve(reference));
      if (!grant) throw new PalugadaError('credential.unavailable', 'the sign-in behind this key is no longer readable', {});
      if (fresh(grant, this.#now())) return grant.accessToken;
      const ended = (why: string) => new PalugadaError('credential.unavailable',
        `the ${grant.provider} sign-in behind this key has ended (${why}): sign in again from the division's keys, on Organization`,
        { provider: grant.provider });
      if (!grant.refreshToken) throw ended('it gave no way to refresh it');
      const master = this.#master();
      if (!master) throw ended('this deployment cannot seal the new token');
      const client = clientsIn(await readSettings())[grant.provider];
      if (!client) throw ended(`the app registered with ${grant.provider} was removed`);
      if (client.tokenUrl !== grant.tokenUrl) throw ended(`the app registered with ${grant.provider} answers at another address now`);
      const secret = client.clientSecretName ? await this.#deployment.resolve(`db://${client.clientSecretName}`) : null;
      let tokens;
      try {
        tokens = await tokenRequest(grant.tokenUrl, { grant_type: 'refresh_token', refresh_token: grant.refreshToken },
          { clientId: client.clientId, secret, authMethod: client.authMethod });
      } catch (failure) {
        throw ended((failure as Error).message);
      }
      const renewed: Grant = {
        ...grant,
        accessToken: tokens.accessToken,
        // A provider that rotates refresh tokens sends a new one; one that
        // does not leaves the old one good.
        refreshToken: tokens.refreshToken ?? grant.refreshToken,
        expiresAt: tokens.expiresIn ? new Date(this.#now() + tokens.expiresIn * 1000).toISOString() : null,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      };
      await putSecret(name, JSON.stringify(renewed), master);
      return renewed.accessToken;
    });
  }
}
