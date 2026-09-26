/**
 * `npm start`, as a process (PRD v2 §10).
 *
 * `package.json` ran `node src/main.ts` and the module exported `start()` and
 * called nothing, so the command the README gives for running the platform
 * loaded it and exited 0. Every other test calls `start()` itself, which is
 * exactly why none of them could notice. These run the file the way an
 * operator does -- a child process, its own environment, a signal to stop it
 * -- and one of them signs in, because a deployment the owner cannot get into
 * has not started in any sense that matters.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { LocalSecretManager } from '../../src/secrets/local.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const MAIN = new URL('../../src/main.ts', import.meta.url).pathname;

interface Running {
  output: () => string;
  url: Promise<string>;
  exited: Promise<number | null>;
  signal: (name: NodeJS.Signals) => void;
}

function run(env: Record<string, string>): Running {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, PALUGADA_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  let found: (url: string) => void;
  const url = new Promise<string>((resolve) => { found = resolve; });
  const read = (chunk: Buffer) => {
    text += chunk.toString('utf8');
    const match = /console at (http:\/\/\S+)/.exec(text);
    if (match) found(match[1]!);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { output: () => text, url, exited, signal: (name) => child.kill(name) };
}

/** Races a promise against a clock, so a regression is a red line and not a hang. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

test('npm start serves the console, lets the owner in, and stops on SIGTERM', async () => {
  const { secret } = newTotpSecret('owner');
  const deployment = run({
    PALUGADA_SECRET_OWNER_TOTP: secret,
    PALUGADA_OWNER_TOTP_REF: 'env://PALUGADA_SECRET_OWNER_TOTP',
  });
  try {
    const url = await within(deployment.url, 20_000, `boot (${deployment.output()})`);
    assert.match(deployment.output(), /enrolled the owner's authenticator from env:\/\/PALUGADA_SECRET_OWNER_TOTP/);

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200, 'the console is served');
    assert.match(await page.text(), /<html/i);

    // The one thing a fresh deployment could not do before: be entered.
    const signIn = await fetch(`${url}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totp: totpCode(decodeBase32(secret), stepFor(new Date())) }),
    });
    assert.equal(signIn.status, 200, await signIn.clone().text());
    const { token } = (await signIn.json()) as { token: string };
    const control = await fetch(`${url}/api/control`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(control.status, 200);
  } finally {
    deployment.signal('SIGTERM');
  }
  assert.equal(await within(deployment.exited, 20_000, 'a clean stop'), 0, deployment.output());
  assert.match(deployment.output(), /SIGTERM, stopping/);
});

/**
 * EX_CONFIG, so a supervisor told `RestartPreventExitStatus=78` stops
 * restarting a process into the same refusal every ten seconds.
 */
test('a configuration the deployment cannot use exits 78, and says which', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'palugada-config-'));
  const brokenVendors = join(dir, 'vendors.json');
  await writeFile(brokenVendors, '{ "capabilities": [ { "name": "email.send" } ] }');

  for (const [env, says] of [
    [{ PALUGADA_VENDORS: brokenVendors }, /configuration refused/],
    [{ PALUGADA_MODEL_PRICES: join(dir, 'missing.json') }, /price file .* could not be read/],
    [{ PALUGADA_RUNTIME_SPECS: 'not json' }, /PALUGADA_RUNTIME_SPECS could not be read/],
    [{ PALUGADA_OWNER_TOTP_REF: 'env://PALUGADA_SECRET_NOT_SET' }, /PALUGADA_OWNER_TOTP_REF .* is not a usable TOTP secret/],
    [{ PALUGADA_OWNER_TOTP_REF: 'env://PALUGADA_SECRET_BAD', PALUGADA_SECRET_BAD: 'not base32!' }, /not a usable TOTP secret/],
  ] as const) {
    const deployment = run(env as Record<string, string>);
    const code = await within(deployment.exited, 20_000, `exit for ${JSON.stringify(env)}`);
    assert.equal(code, 78, `${JSON.stringify(env)}: ${deployment.output()}`);
    assert.match(deployment.output(), says);
  }
});

/* ------------------------------------------------------ the secret store --- */

test('an env:// secret is only one the operator named as a secret', async () => {
  const store = new LocalSecretManager({
    env: { PALUGADA_SECRET_MAIL: 'sk_live_mail_token', DATABASE_URL: 'postgres://owner:hunter2@db/palugada' },
  });
  assert.equal(await store.resolve('env://PALUGADA_SECRET_MAIL'), 'sk_live_mail_token');

  const refused = async (reference: string, why: RegExp) =>
    assert.rejects(store.resolve(reference), (error: unknown) =>
      isPalugadaError(error, 'credential.unavailable') && why.test((error as Error).message));
  await refused('env://DATABASE_URL', /only variables named PALUGADA_SECRET_\*/);
  await refused('env://PALUGADA_SECRET_UNSET', /is not set/);
  await refused('env://palugada_secret_mail', /names one variable in capitals/);
  await refused('vault://kv/mail', /no vault:\/\/ store/);
});

test('a file:// secret is read only from inside the secret directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palugada-secrets-'));
  const outside = await mkdtemp(join(tmpdir(), 'palugada-outside-'));
  await writeFile(join(root, 'mail'), 'sk_file_token\n');
  await writeFile(join(outside, 'shadow'), 'root:x:0:0');
  await symlink(join(outside, 'shadow'), join(root, 'escape'));
  const store = new LocalSecretManager({ directories: [root] });

  assert.equal(await store.resolve(`file://${root}/mail`), 'sk_file_token', 'one trailing newline dropped');
  const refused = async (reference: string, why: RegExp) =>
    assert.rejects(store.resolve(reference), (error: unknown) =>
      isPalugadaError(error, 'credential.unavailable') && why.test((error as Error).message));
  await refused(`file://${outside}/shadow`, /secrets are read only from/);
  await refused(`file://${root}/../${outside.split('/').pop()}/shadow`, /secrets are read only from/);
  await refused(`file://${root}/escape`, /secrets are read only from/);
  await refused(`file://${root}/nothing`, /no such file/);
  await refused('file://relative/path', /absolute path/);
});
