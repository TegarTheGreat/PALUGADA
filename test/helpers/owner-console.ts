/**
 * The owner's console for the tests of what is set for the whole deployment:
 * the owner API with an enrolled authenticator, a clock the test moves so each
 * code is fresh, and the deployment's settings and sealed secrets behind it.
 */
import { randomBytes } from 'node:crypto';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { OwnerMfa, TOTP_STEP_SECONDS, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { DeploymentSecretManager, masterKeyFrom, type MasterKey } from '../../src/settings/store.ts';

export async function consoleWithSettings(options: {
  baseEnv?: NodeJS.ProcessEnv; env?: NodeJS.ProcessEnv; assistant?: ConstructorParameters<typeof OwnerApi>[0]['assistant'];
  telegram?: ConstructorParameters<typeof OwnerApi>[0]['telegram'];
  registry?: ConstructorParameters<typeof OwnerApi>[0]['registry'];
  credentialFor?: ConstructorParameters<typeof OwnerApi>[0]['credentialFor'];
  /** The built console to serve beside the API, for a test that opens it in a browser. */
  staticRoot?: string;
  browsers?: ConstructorParameters<typeof OwnerApi>[0]['browsers'];
  /** What the deployment reported when it started, for the setup checklist. */
  deploymentNotes?: string[];
  /** Where the companies' files are, for the owner's Files page. */
  files?: ConstructorParameters<typeof OwnerApi>[0]['files'];
} = {}) {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local', now: at });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
  const key = randomBytes(32);
  const master: MasterKey = { id: masterKeyFrom({ PALUGADA_MASTER_KEY: key.toString('hex') })!.id, key, source: 'test' };
  const sealed = new DeploymentSecretManager(secrets, () => master);
  const api = new OwnerApi({
    mfa,
    secrets: sealed,
    ...(options.assistant ? { assistant: options.assistant } : {}),
    ...(options.telegram ? { telegram: options.telegram } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.credentialFor ? { credentialFor: options.credentialFor } : {}),
    ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}),
    ...(options.browsers ? { browsers: options.browsers } : {}),
    ...(options.deploymentNotes ? { deploymentNotes: options.deploymentNotes } : {}),
    ...(options.files ? { files: options.files } : {}),
    deploymentSettings: {
      baseEnv: options.baseEnv ?? {}, env: options.env ?? options.baseEnv ?? {}, settings: {},
      master: () => master, secrets: sealed, restart: () => undefined,
    },
  });
  const { url } = await api.listen();
  const code = () => {
    steps += 1;
    return totpCode(decodeBase32(secret), stepFor(at()));
  };
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: await response.json() as any };
  };
  return {
    url,
    secrets: sealed,
    master,
    code,
    call,
    signIn: async () => {
      const response = await fetch(`${url}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totp: code() }),
      });
      return String(((await response.json()) as { token: string }).token);
    },
    close: (finishMs?: number) => api.close(finishMs),
  };
}
