/**
 * `npm run setup`: what a first installation has to decide, asked once and
 * written to `.env`.
 *
 * The quickstart was eight commands, two of them `export` lines holding the
 * owner's second factor and a model key in a shell that forgot both when it
 * closed, and the first sign that a key or an address was wrong was a task
 * that halted. This asks the three things an installation needs -- where it
 * runs, the owner's authenticator, and which model does the work -- checks
 * each while the operator is still at the keyboard, and writes the answers
 * where `npm start` reads them (Node's own `--env-file-if-exists`, so no
 * dependency reads it).
 *
 * Run again, it keeps what is there, asks only what is missing, and offers to
 * change the model. The file is written readable by its owner alone: it
 * holds the second factor. The one request it sends anywhere is to the model
 * the operator named, to prove the key, the address and that the model calls
 * tools, since a model that cannot can only answer a role's work in words.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { decodeBase32, newTotpSecret, stepFor, totpCode, TOTP_DRIFT_STEPS } from '../src/owner/mfa.ts';
import { qrForTerminal, qrMatrix } from '../src/owner/qr.ts';
import { modelSettingsFrom } from '../src/llm/models.ts';
import { checkModel as checkModelAnswers } from '../src/llm/check.ts';
import { LocalSecretManager } from '../src/secrets/local.ts';
import { connectionString } from '../src/config.ts';
import pg from 'pg';

export interface SetupIo {
  /** One answer, trimmed; a secret is asked without echoing it. */
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
  say(text: string): void;
  /** Whether a QR code can be drawn: a terminal, not a pipe or a log. */
  terminal: boolean;
}

/** What the model said to a request that offered it one tool (src/llm/check.ts). */
export type ModelCheck = (env: NodeJS.ProcessEnv) => Promise<{ problem: string | null; warning: string | null }>;

export interface SetupOptions {
  envPath: string;
  checkModel?: ModelCheck;
  /** Whether a database already answers at this URL, as an installation from before `.env` has. */
  probeDatabase?: (url: string) => Promise<boolean>;
}

const DATABASE_URL_KEYS = { app: 'PALUGADA_APP_URL', admin: 'PALUGADA_ADMIN_URL', owner: 'PALUGADA_OWNER_URL' } as const;

/** A value is null to take its line out of the file. */
type Updates = Record<string, string | null>;

interface ModelChoice {
  label: string;
  provider: 'anthropic' | 'openai';
  url?: string;
  /** For a model on this machine, where Docker's containers find it instead. */
  dockerUrl?: string;
  key: 'required' | 'optional' | 'none';
  example?: string;
  askUrl?: boolean;
}

const MODEL_CHOICES: readonly ModelChoice[] = [
  { label: 'Anthropic (Claude)', provider: 'anthropic', key: 'required' },
  { label: 'OpenAI', provider: 'openai', key: 'required', example: 'gpt-5-mini' },
  {
    label: 'OpenRouter: models from every lab behind one key', provider: 'openai',
    url: 'https://openrouter.ai/api/v1', key: 'required', example: 'deepseek/deepseek-chat',
  },
  {
    label: 'Google Gemini', provider: 'openai',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required', example: 'gemini-2.5-flash',
  },
  {
    label: 'A model on this machine: Ollama, vLLM, LM Studio or llama.cpp', provider: 'openai',
    url: 'http://localhost:11434/v1', dockerUrl: 'http://host.docker.internal:11434/v1',
    key: 'none', example: 'qwen3:32b', askUrl: true,
  },
  { label: 'Another OpenAI-compatible API', provider: 'openai', key: 'optional', askUrl: true, example: 'the name the API lists' },
];

const MODEL_KEYS = [
  'PALUGADA_MODEL_PROVIDER', 'PALUGADA_MODEL_URL', 'PALUGADA_MODEL', 'PALUGADA_MODEL_ALIASES',
  'PALUGADA_MODEL_KEY_REF', 'PALUGADA_SECRET_MODEL_KEY',
];

export async function setup(io: SetupIo, options: SetupOptions): Promise<void> {
  const original = existsSync(options.envPath) ? readFileSync(options.envPath, 'utf8') : '';
  const existing = parseEnv(original) as Record<string, string>;
  const updates: Updates = {};
  const current = (): Record<string, string> => {
    const env: Record<string, string> = { ...existing };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    return env;
  };

  io.say(original
    ? `PALUGADA setup. ${options.envPath} is kept; only what it lacks is asked.`
    : `PALUGADA setup. The answers go to ${options.envPath}; Enter takes the one in brackets.`);

  // Where it runs decides where the database is, and how a container reaches
  // a model on this machine. Compose reads the passwords from the same file.
  let docker = existing.PALUGADA_DB_APP_PASSWORD !== undefined;
  let databaseFound = false;
  if (!docker && existing.PALUGADA_APP_URL === undefined) {
    const where = await choose(io, 'Where will PALUGADA run?', [
      'On this machine, with PostgreSQL installed here',
      'With Docker Compose: PostgreSQL comes with it',
    ]);
    docker = where === 1;
    if (docker) {
      for (const role of ['SUPERUSER', 'OWNER', 'APP', 'ADMIN']) {
        updates[`PALUGADA_DB_${role}_PASSWORD`] = randomBytes(18).toString('hex');
      }
    } else if (await (options.probeDatabase ?? probeDatabase)(connectionString('app'))) {
      // An installation from before this file: its database already has
      // passwords, and new ones here would lock the platform out of it.
      io.say('PALUGADA\'s database is already on this machine; its connection settings are kept.');
      databaseFound = true;
      for (const role of ['app', 'admin', 'owner'] as const) updates[DATABASE_URL_KEYS[role]] = connectionString(role);
    } else {
      // A password of its own for each role, rather than the development
      // ones `db:setup` falls back to; it reads them from here.
      for (const role of ['app', 'admin', 'owner'] as const) {
        updates[DATABASE_URL_KEYS[role]] =
          `postgres://palugada_${role}:${randomBytes(18).toString('hex')}@127.0.0.1:5432/palugada`;
      }
    }
  }

  if (!existing.PALUGADA_OWNER_TOTP_REF) await enrolOwner(io, updates);

  let configured: string | null = null;
  try {
    configured = settingsOf(existing);
  } catch (failure) {
    io.say(`\nThe model settings in ${options.envPath} would stop the boot: ${(failure as Error).message}`);
  }
  const changeModel = configured === null
    || (await ask(io, `The model is ${configured}. Change it? [y/N] `)).toLowerCase().startsWith('y');
  if (changeModel) {
    for (;;) {
      const chosen = await chooseModel(io, updates, docker);
      if (!chosen) break;
      const env = current();
      let settings: string | null;
      try {
        settings = settingsOf(env);
      } catch (failure) {
        io.say(`That will not start: ${(failure as Error).message}`);
        continue;
      }
      io.say(`Asking ${settings} whether it answers and calls tools...`);
      const check = await (options.checkModel ?? checkModel)(forThisMachine(env));
      if (check.problem === null) {
        io.say(check.warning ?? 'It answered, and called the tool it was offered.');
        if (check.warning === null) break;
      } else {
        io.say(`It did not answer: ${check.problem}`);
      }
      if ((await ask(io, 'Keep these settings anyway? [y/N] ')).toLowerCase().startsWith('y')) break;
    }
  }

  writeEnvFile(options.envPath, original, updates);
  io.say(`\nWritten to ${options.envPath}, readable by you alone.`);
  io.say(docker
    ? [
      'Next:',
      '  docker compose up -d --build',
      'then open http://127.0.0.1:8787 and sign in with the code from your authenticator.',
    ].join('\n')
    : [
      'Next, once:',
      ...(databaseFound ? [] : ['  npm run db:setup        # the database and its three roles; needs a PostgreSQL superuser']),
      '  npm run db:migrate',
      '  npm run console:build',
      'and then:',
      '  npm start',
      'and open http://127.0.0.1:8787 and sign in with the code from your authenticator.',
    ].join('\n'));
}

/**
 * The owner's second factor: made here, shown as a QR code and a key, and
 * checked against a code from the app, so a mis-scanned secret is found now
 * rather than at a locked sign-in page.
 */
async function enrolOwner(io: SetupIo, updates: Updates): Promise<void> {
  const { secret, uri } = newTotpSecret('owner');
  updates.PALUGADA_SECRET_OWNER_TOTP = secret;
  updates.PALUGADA_OWNER_TOTP_REF = 'env://PALUGADA_SECRET_OWNER_TOTP';
  io.say('\nYou sign in, and approve what cannot be undone, with a code from an authenticator app '
    + '(Google Authenticator, Microsoft Authenticator, 1Password, Authy, Bitwarden).');
  if (io.terminal) io.say(`Scan this with it:\n\n${qrForTerminal(qrMatrix(uri))}\n`);
  io.say(`${io.terminal ? 'Or type' : 'Type'} this key into it: ${secret.match(/.{1,4}/g)!.join(' ')}`);
  for (;;) {
    const code = (await ask(io, 'The six-digit code it shows now (Enter to skip the check): ')).replace(/\s/g, '');
    if (code === '') return;
    if (codeFits(secret, code)) {
      io.say('That is the right code.');
      return;
    }
    io.say('That code does not match this key. Check the app shows PALUGADA, and try the next code.');
  }
}

function codeFits(secret: string, code: string): boolean {
  const key = decodeBase32(secret);
  const now = stepFor();
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    if (totpCode(key, now + drift) === code) return true;
  }
  return false;
}

/** Fills `updates` with the model the operator chose; false when they chose to decide later. */
async function chooseModel(io: SetupIo, updates: Updates, docker: boolean): Promise<boolean> {
  const index = await choose(io, 'Which model does the work?', [
    ...MODEL_CHOICES.map((choice) => choice.label),
    'Decide later: the console starts, and no role can work until a model is set',
  ]);
  const choice = MODEL_CHOICES[index];
  for (const key of MODEL_KEYS) updates[key] = null;
  if (!choice) return false;

  if (choice.provider === 'openai') updates.PALUGADA_MODEL_PROVIDER = 'openai';
  const defaultUrl = docker && choice.dockerUrl ? choice.dockerUrl : choice.url;
  const url = choice.askUrl
    ? await askUntil(io, `Its address, up to /v1${defaultUrl ? ` [${defaultUrl}]` : ''}: `, defaultUrl)
    : defaultUrl;
  if (url) updates.PALUGADA_MODEL_URL = url;

  if (choice.key !== 'none') {
    const key = choice.key === 'required'
      ? await askUntil(io, 'Its API key (not shown as you type): ', undefined, true)
      : await ask(io, 'Its API key, if it takes one (not shown as you type): ', true);
    if (key) {
      updates.PALUGADA_SECRET_MODEL_KEY = key;
      updates.PALUGADA_MODEL_KEY_REF = 'env://PALUGADA_SECRET_MODEL_KEY';
    }
  }

  const model = choice.provider === 'anthropic'
    ? await ask(io, 'One model for every role, or Enter for Claude\'s own by tier (Haiku, Sonnet, Opus): ')
    : await askUntil(io, `The model every role runs on (for example ${choice.example}): `);
  if (model) updates.PALUGADA_MODEL = model;
  return true;
}

/**
 * What the check can reach from here: a container finds this machine's model
 * at `host.docker.internal`, and the operator's shell finds it at localhost.
 */
function forThisMachine(env: Record<string, string>): NodeJS.ProcessEnv {
  const url = env.PALUGADA_MODEL_URL;
  return url?.includes('host.docker.internal')
    ? { ...env, PALUGADA_MODEL_URL: url.replace('host.docker.internal', 'localhost') }
    : env;
}

/** The same check the console makes before it saves a model (src/llm/check.ts). */
const checkModel: ModelCheck = (env) => checkModelAnswers(env, new LocalSecretManager({ env }));

async function probeDatabase(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A one-line description of the model settings, or null when there are none; throws what the boot would. */
function settingsOf(env: NodeJS.ProcessEnv): string | null {
  const settings = modelSettingsFrom(env);
  return settings
    ? `${settings.provider} at ${settings.url}, standard = ${settings.aliases.standard}`
    : null;
}

async function ask(io: SetupIo, question: string, secret = false): Promise<string> {
  return (await io.ask(question, { secret })).trim();
}

async function askUntil(io: SetupIo, question: string, fallback?: string, secret = false): Promise<string> {
  for (;;) {
    const answer = await ask(io, question, secret);
    if (answer) return answer;
    if (fallback) return fallback;
    io.say('This one is needed.');
  }
}

/** A numbered choice; the first is the default. Returns the index chosen. */
async function choose(io: SetupIo, question: string, choices: readonly string[]): Promise<number> {
  io.say(`\n${question}`);
  choices.forEach((choice, i) => io.say(`  ${i + 1}) ${choice}`));
  for (;;) {
    const answer = await ask(io, `Choose 1-${choices.length} [1]: `);
    const picked = answer === '' ? 1 : Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) return picked - 1;
    io.say(`Choose a number from 1 to ${choices.length}.`);
  }
}

/**
 * Writes `.env` with each changed line in place and new ones at the end, so a
 * file the operator arranged and commented keeps its arrangement.
 */
export function writeEnvFile(path: string, original: string, updates: Updates): void {
  const pending = new Map(Object.entries(updates));
  const lines = original === '' ? [] : original.replace(/\n$/, '').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) {
      kept.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value !== null && value !== undefined) kept.push(`${key}=${quoted(value)}`);
  }
  const added = [...pending].filter((entry): entry is [string, string] => entry[1] !== null);
  if (added.length > 0) {
    if (kept.length > 0) kept.push('');
    kept.push(`# Written by npm run setup on ${new Date().toISOString().slice(0, 10)}.`);
    for (const [key, value] of added) kept.push(`${key}=${quoted(value)}`);
  }
  writeFileSync(path, `${kept.join('\n')}\n`, { mode: 0o600 });
  // The mode above applies only to a file this call created.
  chmodSync(path, 0o600);
}

/** Bare when it can be; otherwise in single quotes, which Node and Docker Compose both read literally. */
function quoted(value: string): string {
  if (/^[A-Za-z0-9_./:@+,-]*$/.test(value)) return value;
  if (value.includes("'") || value.includes('\n')) {
    throw new Error(`a value with a quote or a line break cannot be written to .env: ${value.slice(0, 20)}...`);
  }
  return `'${value}'`;
}

/* ------------------------------------------------------------ the program --- */

if (import.meta.filename === process.argv[1]) {
  // Echo goes through this, so a secret's keystrokes can be kept off the
  // screen with the terminal's own line editing left intact.
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const reader = createInterface({ input: process.stdin, output, terminal });
  // Lines are read from an iterator rather than `question`, which drops the
  // lines of a piped answer file that arrive before it is asked.
  const lines = reader[Symbol.asyncIterator]();
  const io: SetupIo = {
    terminal,
    say: (text) => process.stdout.write(`${text}\n`),
    async ask(question, options) {
      process.stdout.write(question);
      muted = Boolean(options?.secret) && terminal;
      const next = await lines.next();
      if (muted) process.stdout.write('\n');
      muted = false;
      if (next.done) throw new Error('setup: the answers ended before the questions did');
      return next.value;
    },
  };
  const envPath = process.argv[2] ?? '.env';
  try {
    await setup(io, { envPath });
    reader.close();
  } catch (failure) {
    reader.close();
    process.stderr.write(`setup: ${(failure as Error).message}\n`);
    process.exitCode = 1;
  }
}
