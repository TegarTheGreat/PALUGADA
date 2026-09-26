/**
 * The deployment set from the console (0065).
 *
 * The model, and later the agent CLIs and the channels, were environment
 * variables an operator with a shell set and a restart took up. An owner with
 * only the console could not choose a model or paste a key. These hold the
 * console's side of that: secrets sealed under a key the database does not
 * hold, a model checked before it is saved and saved only with the owner's
 * device, the settings laid over the environment at the next start -- and a
 * setting that would stop the boot set aside, because the console is the only
 * place it could be undone.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerApi } from '../../src/owner/api.ts';
import { OwnerMfa, TOTP_STEP_SECONDS, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import {
  DeploymentSecretManager, masterKeyFrom, putSecret, readSettings, writeSetting, type MasterKey,
} from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  await closePools();
  await closeSetup();
});

const fixedKey = (): MasterKey => {
  const key = randomBytes(32);
  return { id: masterKeyFrom({ PALUGADA_MASTER_KEY: key.toString('hex') })!.id, key, source: 'test' };
};

/** A Chat Completions server that calls the tool it is offered, and remembers the key it was sent. */
async function modelServer(): Promise<{ url: string; keys: string[] }> {
  const keys: string[] = [];
  const server = createServer((req, res) => {
    keys.push(String(req.headers.authorization ?? ''));
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }, { id: 'bigger' }, { id: 'local-model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'served',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, keys };
}

test('a secret set in the console is sealed, and opens only with the key and the name it was sealed under', async () => {
  const master = fixedKey();
  await putSecret('model-key', 'sk-the-real-key-0123456789', master);
  const { rows } = await withControlPlane((tx) => tx.query<{ ciphertext: Buffer; nonce: Buffer }>(
    "SELECT ciphertext, nonce FROM deployment_secrets WHERE name = 'model-key'"));
  assert.ok(!rows[0]!.ciphertext.toString('latin1').includes('sk-the-real-key'), 'a dump of the database is not the key');

  const secrets = new DeploymentSecretManager(new InMemorySecretManager(), () => master);
  assert.equal(await secrets.resolve('db://model-key'), 'sk-the-real-key-0123456789');

  const another = new DeploymentSecretManager(new InMemorySecretManager(), () => fixedKey());
  await assert.rejects(another.resolve('db://model-key'), /sealed with the master key [0-9a-f]{16}, and this deployment has [0-9a-f]{16}/);
  // Copied under another name, it does not open: the name is sealed in.
  await withControlPlane((tx) => tx.query(
    "INSERT INTO deployment_secrets (name, nonce, ciphertext, tag, key_id) SELECT 'other', nonce, ciphertext, tag, key_id FROM deployment_secrets WHERE name = 'model-key'"));
  await assert.rejects(secrets.resolve('db://other'), /does not open with this deployment's key/);
  await assert.rejects(secrets.resolve('db://missing'), /nothing is stored under that name/);
});

test('the master key is the one named, or a file made once beside the deployment, readable by it alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'palugada-state-'));
  assert.equal(masterKeyFrom({ PALUGADA_STATE_DIR: dir }, false), null, 'not made until something needs sealing');
  const made = masterKeyFrom({ PALUGADA_STATE_DIR: dir })!;
  assert.equal(statSync(join(dir, 'master.key')).mode & 0o777, 0o600);
  assert.equal(masterKeyFrom({ PALUGADA_STATE_DIR: dir })!.id, made.id, 'the same key on the next start');
  assert.throws(() => masterKeyFrom({ PALUGADA_MASTER_KEY: 'too-short' }),
    (error: unknown) => isPalugadaError(error, 'config.invalid'));
});

test('the owner chooses a model in the console: checked before it is saved, saved with their device, taken up at the next start', async () => {
  const api = await consoleWithSettings();
  const model = await modelServer();
  try {
    const token = await api.signIn();
    const read = await api.call('GET', '/api/control/settings', token);
    assert.equal(read.body.model.source, null, 'nothing chosen, nothing in the environment');
    assert.ok(read.body.providers.some((entry: { id: string; url?: string }) => entry.id === 'openrouter' && entry.url),
      'the owner picks a provider by name, and its address comes with it');

    // The models it serves, listed with the key typed, so the owner picks rather than types.
    const listed = await api.call('POST', '/api/control/settings/model/models', token,
      { provider: 'openai', url: model.url, key: 'sk-typed-0123456789' });
    assert.deepEqual(listed.body, { models: ['bigger', 'local-model'], problem: null });
    assert.equal(model.keys.at(-1), 'Bearer sk-typed-0123456789');
    const refused = await api.call('POST', '/api/control/settings/model/models', token,
      { provider: 'openai', url: 'http://127.0.0.1:9/v1' });
    assert.match(String(refused.body.problem), /could not be reached/, 'a list that cannot be had says why');

    // The key typed is used for the check and nothing else.
    const tried = await api.call('POST', '/api/control/settings/model/test', token,
      { provider: 'openai', url: model.url, model: 'local-model', key: 'sk-typed-0123456789' });
    assert.deepEqual(tried.body, { problem: null, warning: null });
    assert.equal(model.keys.at(-1), 'Bearer sk-typed-0123456789');
    assert.equal((await readSettings()).model, undefined, 'a check saves nothing');

    // An endpoint whose tiers are not all named is refused with the reason.
    const half = await api.call('POST', '/api/control/settings/model', token,
      { provider: 'openai', url: model.url, key: 'k-0123456789', proof: { totp: api.code() } });
    assert.equal(half.status, 400);
    assert.match(String(half.body.error), /say which one each tier means/);

    const unproved = await api.call('POST', '/api/control/settings/model', token,
      { provider: 'openai', url: model.url, model: 'local-model', key: 'sk-typed-0123456789' });
    assert.equal(unproved.status, 403, 'the model every role runs on is changed with the owner\'s device');

    const unknown = await api.call('POST', '/api/control/settings/model', token,
      { preset: 'nobody', provider: 'openai', url: model.url, model: 'local-model', proof: { totp: api.code() } });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /preset is one of .*openrouter/);

    const saved = await api.call('POST', '/api/control/settings/model', token,
      { preset: 'custom', provider: 'openai', url: model.url, model: 'local-model', key: 'sk-typed-0123456789', proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.applies, 'now', 'this console can start itself again');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(api.restarts(), 1);
    const after = await api.call('GET', '/api/control/settings', token);
    assert.equal(after.body.pending, true, 'saved, and not yet what this process runs on');
    assert.equal(after.body.model.chosen.preset, 'custom');
    assert.deepEqual(after.body.secrets.map((one: { name: string }) => one.name), ['model-key'],
      'the console is told which secrets are set, never what they are');
    assert.ok(!JSON.stringify(after.body).includes('sk-typed'), 'the key never comes back');

    // The next start reads it: the environment and the sealed key, together.
    const settings = await readSettings();
    const env = withSettings({}, settings);
    assert.equal(env.PALUGADA_MODEL_PROVIDER, 'openai');
    assert.equal(env.PALUGADA_MODEL, 'local-model');
    // What the console set replaces the environment's model, not half of it:
    // an alias or a key left from .env would run a model the owner never saw.
    const over = withSettings({
      PALUGADA_MODEL_PROVIDER: 'anthropic', PALUGADA_MODEL_ALIASES: '{"deep":"claude-opus-5-5"}',
      PALUGADA_MODEL_URL: 'https://api.anthropic.com', PALUGADA_MODEL_KEY_REF: 'env://PALUGADA_SECRET_MODEL_KEY', PALUGADA_PORT: '9000',
    }, settings);
    assert.equal(over.PALUGADA_MODEL_ALIASES, undefined);
    assert.equal(over.PALUGADA_MODEL_URL, model.url);
    assert.equal(over.PALUGADA_MODEL_KEY_REF, 'db://model-key');
    assert.equal(over.PALUGADA_PORT, '9000', 'and nothing outside that area');
    assert.equal(await api.secrets.resolve(env.PALUGADA_MODEL_KEY_REF!), 'sk-typed-0123456789');

    // Saving a new tier keeps the key; clearing takes the model and the key back.
    const retiered = await api.call('POST', '/api/control/settings/model', token,
      { provider: 'openai', url: model.url, model: 'local-model', aliases: { deep: 'bigger' }, proof: { totp: api.code() } });
    assert.equal(retiered.status, 200, JSON.stringify(retiered.body));
    assert.equal(withSettings({}, await readSettings()).PALUGADA_MODEL_KEY_REF, 'db://model-key');
    const cleared = await api.call('POST', '/api/control/settings/model/clear', token, { proof: { totp: api.code() } });
    assert.equal(cleared.status, 200);
    assert.equal((await readSettings()).model, undefined);
    await assert.rejects(api.secrets.resolve('db://model-key'), /nothing is stored/);
  } finally {
    await api.close();
  }
});

test('a model set in the console that would stop the boot is set aside, so the console still comes up', async () => {
  await writeSetting('model', { provider: 'openai' });
  const { start } = await import('../../src/main.ts');
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 60_000 } });
  try {
    assert.ok(deployment.notes.some((note) => /the model set in the console was set aside: .*say which one each tier means/.test(note)),
      deployment.notes.join('\n'));
  } finally {
    await deployment.stop();
  }
});

test('the running platform starts itself again on a model saved in the console, and the owner stays signed in', async () => {
  const model = await modelServer();
  const port = await freePort();
  const { secret } = newTotpSecret('owner phone');
  const state = mkdtempSync(join(tmpdir(), 'palugada-state-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/main.ts', import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: state, PALUGADA_STATE_DIR: state, PALUGADA_PORT: String(port),
      PALUGADA_SECRET_OWNER_TOTP: secret, PALUGADA_OWNER_TOTP_REF: 'env://PALUGADA_SECRET_OWNER_TOTP',
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^PALUGADA_(APP|ADMIN|OWNER)_URL$/.test(name))),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const until = async (pattern: RegExp, count = 1) => {
    for (let waited = 0; (output.match(new RegExp(pattern.source, 'g'))?.length ?? 0) < count; waited += 100) {
      if (waited > 60_000) assert.fail(`never saw ${pattern} in:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  try {
    await until(/console at http/);
    assert.doesNotMatch(output, /palugada: model: /, 'no model before the owner chooses one');
    let steps = 0;
    const code = () => totpCode(decodeBase32(secret), stepFor(new Date(Date.now() + (steps++) * TOTP_STEP_SECONDS * 1000)));
    const base = `http://127.0.0.1:${port}`;
    const signIn = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totp: code() }),
    });
    const { token } = await signIn.json() as { token: string };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    const saved = await post('/api/control/settings/model',
      { preset: 'custom', provider: 'openai', url: model.url, model: 'local-model', key: 'sk-typed-0123456789', proof: { totp: code() } });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await saved.json(), { applies: 'now' });

    await until(/settings changed, starting again/);
    await until(/console at http/, 2);
    assert.match(output, new RegExp(`palugada: model: openai at ${model.url.replace(/[.]/g, '\\.')}`), output);
    assert.ok(!output.includes('sk-typed'), 'the key is never printed');

    const read = await fetch(`${base}/api/control/settings`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(read.status, 200, 'the session outlives the restart');
    const settings = await read.json() as { model: { source: string; keySet: boolean }; pending: boolean };
    assert.equal(settings.model.source, 'console');
    assert.equal(settings.model.keySet, true);
    assert.equal(settings.pending, false, 'what was saved is what it now runs on');
  } finally {
    child.kill('SIGTERM');
    assert.equal(await exited, 0, output);
  }
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** The console, with the deployment's settings behind it and a clock the test moves. */
async function consoleWithSettings() {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local', now: at });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
  const master = fixedKey();
  const sealed = new DeploymentSecretManager(secrets, () => master);
  let restarts = 0;
  const api = new OwnerApi({
    mfa,
    secrets: sealed,
    deploymentSettings: {
      baseEnv: {}, env: {}, settings: {}, master: () => master, secrets: sealed,
      restart: () => { restarts += 1; },
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
    secrets: sealed,
    code,
    call,
    restarts: () => restarts,
    signIn: async () => {
      const response = await fetch(`${url}/api/auth/sign-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totp: code() }),
      });
      return String(((await response.json()) as { token: string }).token);
    },
    close: () => api.close(),
  };
}
