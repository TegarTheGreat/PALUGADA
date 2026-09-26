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
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

test('the owner installs an agent CLI and signs it in from the console; roles run on it once it is turned on', async () => {
  const state = mkdtempSync(join(tmpdir(), 'palugada-state-'));
  const bin = mkdtempSync(join(tmpdir(), 'palugada-bin-'));
  const record = join(bin, 'npm-was-given.json');
  // A stand-in for npm: records what it was asked and what it could see, and
  // installs a binary that answers --version the way the real one does.
  writeFileSync(join(bin, 'npm'), [
    `#!${process.execPath}`,
    "const fs = require('node:fs'); const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "const prefix = args[args.indexOf('--prefix') + 1];",
    'const spec = args[args.length - 1];',
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: Object.keys(process.env).sort(), home: process.env.HOME }));`,
    "const name = spec.replace(/^@[^/]+\\//, '').replace(/@.*$/, '');",
    "const version = spec.split('@').pop();",
    "const target = path.join(prefix, 'node_modules', '.bin');",
    'fs.mkdirSync(target, { recursive: true });',
    "fs.writeFileSync(path.join(target, name), `#!/bin/sh\\necho \"${name}-cli ${version}\"\\n`, { mode: 0o755 });",
    "console.log('added 1 package');",
  ].join('\n'), { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.PALUGADA_SECRET_SENTINEL = 'an install must not see this';
  const api = await consoleWithSettings({ PALUGADA_STATE_DIR: state, PALUGADA_AGENT_CLIS: 'gemini-cli' });
  try {
    const token = await api.signIn();
    const codexOf = async () => (await api.call('GET', '/api/control/agents', token)).body.agents
      .find((one: { name: string }) => one.name === 'codex');
    const listed = (await api.call('GET', '/api/control/agents', token)).body;
    assert.deepEqual(listed.agents.map((one: { name: string }) => one.name),
      ['claude-code', 'codex', 'gemini-cli', 'opencode', 'hermes', 'openclaw']);
    const codex = await codexOf();
    assert.equal(codex.installed, null);
    assert.equal(codex.tested, '0.157.1');
    assert.match(listed.agents.find((one: { name: string }) => one.name === 'hermes').cannotInstall, /install\.sh/);

    const early = await api.call('POST', '/api/control/agents/codex/settings', token, { enabled: true, proof: { totp: api.code() } });
    assert.equal(early.status, 400);
    assert.match(String(early.body.error), /not installed where PALUGADA runs: install it first/);

    const unproved = await api.call('POST', '/api/control/agents/codex/install', token, {});
    assert.equal(unproved.status, 403, 'installing runs code on this machine, so it takes the owner\'s device');
    const started = await api.call('POST', '/api/control/agents/codex/install', token, { proof: { totp: api.code() } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    let job = started.body.job;
    for (let waited = 0; job.state === 'running' && waited < 20_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await api.call('GET', '/api/control/agents/codex/job', token)).body.job;
    }
    assert.equal(job.state, 'succeeded', job.log);
    const given = JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; env: string[]; home: string };
    assert.deepEqual(given.args.slice(0, 3), ['install', '--prefix', join(state, 'tools', 'codex')]);
    assert.equal(given.args.at(-1), '@openai/codex@0.157.1', 'the version the specs were checked against');
    assert.ok(!given.env.some((name) => name.startsWith('PALUGADA_')), given.env.join(', '));
    assert.equal(given.home, join(state, 'tools', 'codex'));
    const installed = await codexOf();
    assert.deepEqual(installed.installed, {
      command: join(state, 'tools', 'codex', 'node_modules', '.bin', 'codex'), managed: true, version: 'codex-cli 0.157.1',
    });

    const wrongKind = await api.call('POST', '/api/control/agents/codex/credential', token,
      { kind: 'anthropic', value: 'sk-0123456789', proof: { totp: api.code() } });
    assert.equal(wrongKind.status, 400);
    assert.match(String(wrongKind.body.error), /Codex signs in with one of openai/);
    const signed = await api.call('POST', '/api/control/agents/codex/credential', token,
      { kind: 'openai', value: 'sk-proj-typed-0123456789', proof: { totp: api.code() } });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.applies, 'when_enabled', 'a CLI that is off is not restarted for');
    const after = (await api.call('GET', '/api/control/agents', token)).body;
    assert.deepEqual(after.agents.find((one: { name: string }) => one.name === 'codex').credential, { kind: 'openai', variable: 'CODEX_API_KEY' });
    assert.ok(!JSON.stringify(after).includes('sk-proj-typed'), 'the key never comes back');

    // Installed and signed in is not on: roles are offered it once the owner says so.
    assert.equal(withSettings({ PALUGADA_AGENT_CLIS: 'gemini-cli' }, await readSettings()).PALUGADA_AGENT_CLIS, 'gemini-cli');

    const restartsBefore = api.restarts();
    const on = await api.call('POST', '/api/control/agents/codex/settings', token,
      { enabled: true, models: { standard: 'gpt-5-codex' }, proof: { totp: api.code() } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(api.restarts(), restartsBefore + 1);

    // What the next start runs: the CLI the console installed, its tiers, and
    // its key by reference -- and the CLI the environment had on stays on.
    const stored = await readSettings();
    const env = withSettings({ PALUGADA_AGENT_CLIS: 'gemini-cli' }, stored);
    assert.deepEqual(env.PALUGADA_AGENT_CLIS!.split(',').sort(), ['codex', 'gemini-cli']);
    assert.deepEqual(JSON.parse(env.PALUGADA_AGENT_SETTINGS!).codex, {
      command: join(state, 'tools', 'codex', 'node_modules', '.bin', 'codex'),
      models: { standard: 'gpt-5-codex' },
      secretEnv: { CODEX_API_KEY: 'db://agent-codex' },
    });
    const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');
    const { adapters } = assembleRuntimes({ env, secrets: api.secrets });
    assert.ok(adapters.names().includes('codex'));
    const health = await adapters.get('codex')!.health!();
    assert.equal(health.detail, 'codex-cli 0.157.1', 'the binary the console installed, not one on PATH');
    const layout = (adapters.get('codex') as unknown as { layout: (values: Record<string, string>) => { env: Record<string, string> } })
      .layout({ model: 'm', maxTurns: '1', mcpConfig: '', mcpConfigFile: '', mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't', allowedTools: '', prompt: '', runDir: '/run/x' });
    assert.deepEqual(layout.env, { HOME: '/run/x', CODEX_HOME: '/run/x/.codex', PALUGADA_MCP_TOKEN: 't' },
      'the console\'s settings are laid over the known entry, not in place of it');
    // A key from this process's environment stays until the owner gives Claude Code its own.
    assert.equal(withSettings({ PALUGADA_CLAUDE_CODE_KEY_VAR: 'ANTHROPIC_API_KEY' }, { agents: { 'claude-code': { enabled: true } } })
      .PALUGADA_CLAUDE_CODE_KEY_VAR, 'ANTHROPIC_API_KEY');
    assert.equal(withSettings({ PALUGADA_CLAUDE_CODE_KEY_VAR: 'ANTHROPIC_API_KEY' }, {
      agents: { 'claude-code': { enabled: true, credential: { variable: 'CLAUDE_CODE_OAUTH_TOKEN', secret: 'agent-claude-code' } } },
    }).PALUGADA_CLAUDE_CODE_KEY_VAR, undefined, 'two credentials, and the CLI would choose which one paid');
    assert.equal(await api.secrets.resolve('db://agent-codex'), 'sk-proj-typed-0123456789');

    const out = await api.call('POST', '/api/control/agents/codex/credential/clear', token, { proof: { totp: api.code() } });
    assert.equal(out.status, 200);
    await assert.rejects(api.secrets.resolve('db://agent-codex'), /nothing is stored/);
    assert.equal(JSON.parse(withSettings({}, await readSettings()).PALUGADA_AGENT_SETTINGS!).codex.secretEnv, undefined);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PALUGADA_SECRET_SENTINEL;
    await api.close();
  }
});

test('the owner signs Claude Code in with their Claude plan from the console: a page, a code, and a sealed token', async () => {
  const state = mkdtempSync(join(tmpdir(), 'palugada-state-'));
  const bin = mkdtempSync(join(tmpdir(), 'palugada-bin-'));
  // What `claude setup-token` was seen to do under a terminal: nothing
  // without one, a page to open, a prompt for its code, and then the token.
  writeFileSync(join(bin, 'claude'), [
    `#!${process.execPath}`,
    "if (process.argv[2] === '--version') { console.log('2.1.283 (Claude Code)'); process.exit(0); }",
    "if (process.argv[2] !== 'setup-token' || !process.stdin.isTTY) process.exit(2);",
    "process.stdout.write('\\x1b[1mBrowser didn\\'t open? Use the url below to sign in (c to copy)\\x1b[0m\\n'",
    "  + 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz\\n\\nPaste code here if prompted > ');",
    "process.stdin.setEncoding('utf8'); let got = '';",
    "process.stdin.on('data', (d) => { got += d; if (!/[\\r\\n]/.test(got)) return;",
    "  if (got.trim() === 'good-code#xyz') { process.stdout.write('\\nYour OAuth token (valid for 1 year):\\n\\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-the-real-token_0123\\n'); process.exit(0); }",
    "  process.stdout.write('\\nOAuth error: Invalid code. Please make sure the full code was copied\\nPress Enter to retry.\\n'); });",
  ].join('\n'), { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  const api = await consoleWithSettings({ PALUGADA_STATE_DIR: state });
  const until = async (token: string, done: (job: { state: string; url: string | null; waitingForCode: boolean }) => boolean) => {
    for (let waited = 0; waited < 20_000; waited += 100) {
      const { job } = (await api.call('GET', '/api/control/agents/claude-code/job', token)).body;
      if (job && done(job)) return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('the sign-in never got there');
  };
  try {
    const token = await api.signIn();
    const listed = (await api.call('GET', '/api/control/agents', token)).body.agents;
    assert.equal(listed.find((one: { name: string }) => one.name === 'claude-code').credentialKinds
      .find((one: { id: string }) => one.id === 'subscription').login, 'claude-setup-token');
    assert.equal((await api.call('POST', '/api/control/agents/codex/login', token, { proof: { totp: api.code() } })).status, 400,
      'a CLI with no sign-in the console can drive is signed in with a key');
    assert.equal((await api.call('POST', '/api/control/agents/claude-code/login', token, {})).status, 403);

    // A code that is not the one the page showed is refused, and says so.
    await api.call('POST', '/api/control/agents/claude-code/login', token, { proof: { totp: api.code() } });
    await until(token, (job) => job.waitingForCode);
    await api.call('POST', '/api/control/agents/claude-code/login/code', token, { code: 'wrong#xyz' });
    const refused = await until(token, (job) => job.state !== 'running');
    assert.equal(refused.state, 'failed');
    assert.match(String((refused as { error?: string }).error), /did not accept that code/);

    const started = await api.call('POST', '/api/control/agents/claude-code/login', token, { proof: { totp: api.code() } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const waiting = await until(token, (job) => job.waitingForCode && job.url !== null);
    assert.equal(waiting.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz');
    const answered = await api.call('POST', '/api/control/agents/claude-code/login/code', token, { code: 'good-code#xyz' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const finished = await until(token, (job) => job.state !== 'running') as { state: string; log: string };
    assert.equal(finished.state, 'succeeded', finished.log);
    assert.ok(!finished.log.includes('sk-ant-oat01') && !finished.log.includes('good-code'), finished.log);

    assert.equal(await api.secrets.resolve('db://agent-claude-code'), 'sk-ant-oat01-the-real-token_0123');
    const after = (await api.call('GET', '/api/control/agents', token)).body;
    assert.deepEqual(after.agents.find((one: { name: string }) => one.name === 'claude-code').credential,
      { kind: 'subscription', variable: 'CLAUDE_CODE_OAUTH_TOKEN' });
    assert.ok(!JSON.stringify(after).includes('sk-ant-oat01'));
    const late = await api.call('POST', '/api/control/agents/claude-code/login/code', token, { code: 'again#xyz' });
    assert.equal(late.status, 400, 'a code with no sign-in waiting for it goes nowhere');
    assert.deepEqual(readdirSync(join(state, 'agents')), [], 'the sign-in\'s own home is removed');
  } finally {
    process.env.PATH = originalPath;
    await api.close();
  }
});

test('the provider catalogue: one entry per id, an address or a template for each, and setup offers its featured ones', async () => {
  const { MODEL_PROVIDERS } = await import('../../src/llm/providers.ts');
  const ids = MODEL_PROVIDERS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(MODEL_PROVIDERS.length >= 80, `${MODEL_PROVIDERS.length} providers`);
  for (const entry of MODEL_PROVIDERS) {
    const address = entry.url ?? entry.urlExample;
    assert.ok(address && /^https?:\/\//.test(address), `${entry.id} has an address`);
    if (entry.url) assert.ok(!entry.url.includes('{'), `${entry.id}: a template is a urlExample, not a url`);
    if (entry.group !== 'local' && entry.url) assert.ok(entry.url.startsWith('https://'), `${entry.id} is reached over HTTPS`);
    if (entry.key === 'required' && entry.group !== 'custom') assert.ok(entry.keyUrl?.startsWith('https://'), `${entry.id} says where a key is made`);
  }
  assert.deepEqual(MODEL_PROVIDERS.filter((entry) => entry.featured).map((entry) => entry.id),
    ['anthropic', 'openai', 'openrouter', 'google-ai-studio', 'ollama', 'custom'], 'the setup wizard\'s six, in its order');
});

/** The console, with the deployment's settings behind it and a clock the test moves. */
async function consoleWithSettings(baseEnv: NodeJS.ProcessEnv = {}) {
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
      baseEnv, env: baseEnv, settings: {}, master: () => master, secrets: sealed,
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
