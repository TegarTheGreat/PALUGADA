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
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { closePools } from '../../src/db/pool.ts';
import { connectionString } from '../../src/config.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { LocalSecretManager } from '../../src/secrets/local.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { migrate } from '../../scripts/migrate.ts';
import { provisionDatabase } from '../../scripts/provision-database.ts';

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
 * F12.5 on a platform that runs the image: no terminal to make a TOTP secret
 * in, and nothing in the environment to enrol. The start prints a link; the
 * first to open it adds the owner's authenticator and is in, and the next
 * start, which has an owner, prints none.
 */
test('npm start with no owner prints a link that makes whoever opens it the owner', async () => {
  const post = async (url: string, path: string, body: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const first = run({ PALUGADA_OWNER_TOTP_REF: '' });
  try {
    const url = await within(first.url, 20_000, `boot (${first.output()})`);
    const link = await within((async () => {
      for (;;) {
        const found = /no owner yet: open (\S+)/.exec(first.output());
        if (found) return found[1]!;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(), 5_000, `the claim link (${first.output()})`);
    assert.ok(link.startsWith(`${url}/#/claim/`), link);
    const code = link.slice(link.lastIndexOf('/') + 1);

    const offered = await post(url, '/api/auth/claim', { code });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    const secret = String(offered.body.secret);
    const confirmed = await post(url, '/api/auth/claim/confirm', { code, totp: totpCode(decodeBase32(secret), stepFor(new Date())) });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const control = await fetch(`${url}/api/control`, { headers: { authorization: `Bearer ${String(confirmed.body.token)}` } });
    assert.equal(control.status, 200);
  } finally {
    first.signal('SIGTERM');
  }
  assert.equal(await within(first.exited, 20_000, 'a clean stop'), 0, first.output());

  const second = run({ PALUGADA_OWNER_TOTP_REF: '' });
  try {
    await within(second.url, 20_000, `second boot (${second.output()})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.doesNotMatch(second.output(), /no owner yet/, 'an owned deployment prints no link');
  } finally {
    second.signal('SIGTERM');
  }
  assert.equal(await within(second.exited, 20_000, 'second stop'), 0, second.output());
});

/**
 * A stop asked for while the deployment starts is a stop, not a kill.
 *
 * The listeners were installed after "console at" was printed, so a SIGTERM
 * sent the moment the process said it was ready -- which is what a test, and
 * a supervisor restarting it, does -- could arrive with nothing listening,
 * and the default action killed it: exit code null, no "stopping", and a
 * worker already claiming tasks that handed nothing back. Sent before it has
 * even finished starting, it still ends in a clean stop.
 */
test('a SIGTERM while the deployment is still starting stops it cleanly once it has', async () => {
  const deployment = run({});
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const poll = setInterval(() => { if (/palugada: starting/.test(deployment.output())) started(); }, 5);
  try {
    await within(starting, 20_000, `start (${deployment.output()})`);
  } finally {
    clearInterval(poll);
  }
  deployment.signal('SIGTERM');
  assert.equal(await within(deployment.exited, 30_000, 'a clean stop'), 0, deployment.output());
  assert.match(deployment.output(), /console at http:\/\/[\s\S]*SIGTERM, stopping/, 'it finished starting, then stopped');
});

/**
 * A revoked factor stays revoked across a restart.
 *
 * The boot enrolled the configured secret whenever `enrolled()` did not list
 * it, and `enrolled()` lists live factors only -- so the owner revokes the
 * phone they lost, the process restarts for any reason at all, and the lost
 * phone is an authenticator again.
 */
test('a restart does not bring back an authenticator the owner revoked (F12.5)', async () => {
  const { secret } = newTotpSecret('owner');
  const env = {
    PALUGADA_SECRET_OWNER_TOTP: secret,
    PALUGADA_OWNER_TOTP_REF: 'env://PALUGADA_SECRET_OWNER_TOTP',
  };
  const first = run(env);
  await within(first.url, 20_000, `first boot (${first.output()})`);
  first.signal('SIGTERM');
  assert.equal(await within(first.exited, 20_000, 'first stop'), 0, first.output());

  await withControlPlane((tx) =>
    tx.query("UPDATE owner_authenticators SET revoked_at = now() WHERE secret_ref = 'env://PALUGADA_SECRET_OWNER_TOTP'"));

  const second = run(env);
  try {
    await within(second.url, 20_000, `second boot (${second.output()})`);
    assert.match(second.output(), /backs an authenticator the owner revoked; it is not enrolled again/);
    const live = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM owner_authenticators WHERE revoked_at IS NULL',
      );
      return rows[0]!.n;
    });
    assert.equal(live, 0, 'the lost phone is still not a factor');
  } finally {
    second.signal('SIGTERM');
  }
  assert.equal(await within(second.exited, 20_000, 'second stop'), 0, second.output());
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

/**
 * An upgrade whose migrations were not run: the code names columns the
 * database has not got, and used to find out in a task, hours later, as a SQL
 * error. The boot refuses, names the command, and a supervisor does not
 * restart it into the same refusal.
 *
 * 0063 is the one taken back because applying it again is harmless (a
 * grant): if this test dies before it restores the row, the next file's
 * migrate simply runs it again.
 */
test('code ahead of its database refuses to start and names the migration', async () => {
  const pool = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  try {
    await pool.query(`DELETE FROM schema_migrations WHERE version = '0063_schema_version_readable.sql'`);
    const deployment = run({});
    const code = await within(deployment.exited, 20_000, 'exit with a migration pending');
    assert.equal(code, 78, deployment.output());
    assert.match(deployment.output(), /the database is 1 migration behind this code \(0063_schema_version_readable\.sql\): run `npm run db:migrate`/);
  } finally {
    await pool.query(`INSERT INTO schema_migrations (version) VALUES ('0063_schema_version_readable.sql') ON CONFLICT DO NOTHING`);
    await pool.end();
  }
});

/**
 * A migration is never edited once it has run, because a deployed database
 * has run the old text. `migrate` recorded names alone, so an edited one was
 * skipped wherever it had run and applied as edited wherever it had not, and
 * the two databases differed with nothing to say so. What each ran as is
 * kept now, and a file that no longer says that is refused by name, before
 * anything after it runs.
 */
test('a migration changed after it ran is refused by name, and nothing after it runs', async () => {
  const source = new URL('../../db/migrations/', import.meta.url).pathname;
  const directory = await mkdtemp(join(tmpdir(), 'palugada-migrations-'));
  const pool = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort();
  const edited = files[3]!;
  try {
    for (const file of files) await copyFile(join(source, file), join(directory, file));
    assert.deepEqual(await migrate(directory), [], 'the same files: nothing to do');

    const original = await readFile(join(source, edited), 'utf8');
    await writeFile(join(directory, edited), `${original}\n-- and one thing more\n`);
    await writeFile(join(directory, '9999_after_the_edit.sql'), 'CREATE TABLE after_the_edit (id int);');
    await assert.rejects(migrate(directory), new RegExp(`${edited.replace(/\./g, '\\.')} is not the migration this database ran`));
    const made = await pool.query<{ found: string | null }>("SELECT to_regclass('after_the_edit')::text AS found");
    assert.equal(made.rows[0]!.found, null, 'nothing after it ran');

    // Line endings are the editor's, not the migration's.
    await writeFile(join(directory, edited), original.replace(/\n/g, '\r\n'));
    await rm(join(directory, '9999_after_the_edit.sql'));
    assert.deepEqual(await migrate(directory), []);

    // One that ran before checksums were kept is taken as it is now.
    await pool.query('UPDATE schema_migrations SET checksum = NULL WHERE version = $1', [files[0]]);
    assert.deepEqual(await migrate(directory), []);
    const kept = await pool.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE version = $1', [files[0]]);
    assert.match(kept.rows[0]!.checksum ?? '', /^[0-9a-f]{64}$/);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A migration that alters a table waits for every transaction that has read
 * it to finish, and every query on that table after it waits behind the
 * migration: one long transaction and the platform stood still, for as long
 * as it took, with nothing said. The lock that lets one replica migrate while
 * the others wait still waits as long as it needs; the migrations' own locks
 * do not.
 */
test('a migration that cannot get its lock gives up by name within seconds, and applies nothing', async () => {
  const source = new URL('../../db/migrations/', import.meta.url).pathname;
  const directory = await mkdtemp(join(tmpdir(), 'palugada-migrations-'));
  const holder = new pg.Client({ connectionString: connectionString('owner') });
  const pool = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  await holder.connect();
  let migrating: Promise<string[]> | null = null;
  try {
    for (const file of (await readdir(source)).filter((name) => name.endsWith('.sql'))) {
      await copyFile(join(source, file), join(directory, file));
    }
    await writeFile(join(directory, '9999_waits_for_a_lock.sql'), 'ALTER TABLE companies ADD COLUMN waited_for_a_lock int;');
    // A transaction that has read the table and not finished: a long report,
    // an operator's open psql.
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE companies IN ACCESS SHARE MODE');

    const started = Date.now();
    migrating = migrate(directory);
    await assert.rejects(within(migrating, 30_000, 'the migration giving up on its lock'),
      /migration 9999_waits_for_a_lock\.sql was not applied: it waited 10 seconds for a lock another session holds.*Run the migrations again once that session is done/);
    const waited = Date.now() - started;
    assert.ok(waited >= 9_000 && waited < 20_000, `it waited ${waited}ms`);

    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE version = '9999_waits_for_a_lock.sql'");
    assert.equal(recorded.rowCount, 0, 'not recorded');
    const column = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'waited_for_a_lock'");
    assert.equal(column.rowCount, 0, 'not applied');
  } finally {
    // A migration that still waits is cancelled while the lock is held, so it
    // is not applied the moment the lock is let go and left for later files.
    await pool.query(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND query LIKE '%waited_for_a_lock%'`);
    await migrating?.catch(() => undefined);
    await holder.query('ROLLBACK');
    await holder.end();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
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

/**
 * A platform that runs PALUGADA from its image -- Coolify, Dokploy, a compose
 * file with a stock postgres beside it -- has a superuser and none of
 * setup-database.sh's bash, psql or repository files, and runs its setup
 * step on every deploy. `provision-database.ts` makes what is missing,
 * corrects what is wrong, and drops nothing.
 */
test('a database is provisioned from a superuser, a second time changes nothing, and nothing is dropped', async () => {
  const superuserUrl = process.env.PALUGADA_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const name = `palugada_provision_${process.pid}`;
  const inside = (url: string) => {
    const at = new URL(url);
    at.pathname = `/${name}`;
    return at.toString();
  };
  const urls = { owner: inside(connectionString('owner')), app: inside(connectionString('app')), admin: inside(connectionString('admin')) };
  const superuser = new pg.Client({ connectionString: superuserUrl });
  await superuser.connect();
  try {
    await superuser.query(`DROP DATABASE IF EXISTS ${name}`);
    const first = await provisionDatabase({ superuserUrl, urls });
    assert.equal(first.database, name);
    assert.ok(first.changed.includes(`made database ${name}`), first.changed.join('; '));
    assert.ok(first.changed.includes('installed vector'), first.changed.join('; '));

    const { rows: owned } = await superuser.query<{ owner: string }>(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [name]);
    assert.equal(owned[0]?.owner, 'palugada_owner');
    const { rows: roles } = await superuser.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname LIKE 'palugada%' ORDER BY rolname");
    assert.deepEqual(roles.map((role) => [role.rolname, role.rolbypassrls, role.rolsuper]), [
      ['palugada_admin', true, false], ['palugada_app', false, false], ['palugada_owner', false, false],
    ], 'only the control plane bypasses row level security, and nobody is a superuser');

    // The roles can use what was made: the owner migrates it, and the app connects.
    const owner = new pg.Client({ connectionString: urls.owner });
    await owner.connect();
    await owner.query('CREATE TABLE kept (note text)');
    await owner.query("INSERT INTO kept VALUES ('still here')");
    await owner.end();

    // Every deploy runs it again: nothing is made, nothing is dropped.
    const again = await provisionDatabase({ superuserUrl, urls });
    assert.deepEqual(again.changed, []);
    const check = new pg.Client({ connectionString: urls.owner });
    await check.connect();
    assert.deepEqual((await check.query('SELECT note FROM kept')).rows, [{ note: 'still here' }]);
    const { rows: extensions } = await check.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname");
    assert.deepEqual(extensions.map((row) => row.extname), ['pgcrypto', 'vector']);
    await check.end();

    // A role someone loosened by hand is put back: the boundary is its attributes.
    await superuser.query('ALTER ROLE palugada_app BYPASSRLS');
    const corrected = await provisionDatabase({ superuserUrl, urls });
    assert.deepEqual(corrected.changed, ["corrected palugada_app's attributes"]);
    const { rows: app } = await superuser.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'palugada_app'");
    assert.equal(app[0]?.rolbypassrls, false);

    // A URL for the wrong role, or with no password, is refused by the setting's name before anything runs.
    await assert.rejects(provisionDatabase({ superuserUrl, urls: { ...urls, app: urls.admin } }),
      /PALUGADA_APP_URL connects as palugada_admin; it is palugada_app's URL/);
    await assert.rejects(provisionDatabase({ superuserUrl, urls: { ...urls, admin: inside('postgres://palugada_admin@localhost:5432/x') } }),
      /PALUGADA_ADMIN_URL names no password/);
    await assert.rejects(provisionDatabase({ superuserUrl: urls.admin, urls }),
      /does not connect as a superuser/);
  } finally {
    await superuser.query('ALTER ROLE palugada_app NOBYPASSRLS');
    await superuser.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await superuser.end();
  }
});

/**
 * The container starts in deploy/docker/entrypoint.sh: it provisions the
 * database when given a superuser, migrates when given the schema owner, and
 * starts the platform without either -- nor any password a platform like
 * Coolify or Compose's own .env handed every container. The platform runs
 * agent CLIs as its own user, and those can read /proc/1/environ: whatever
 * PID 1 was started with was theirs to read, so the entrypoint unsets first
 * and execs the init after.
 */
test('the container entrypoint sets the database up, then starts the platform without the keys it used', async () => {
  const superuserUrl = process.env.PALUGADA_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const entry = new URL('../../deploy/docker/entrypoint.sh', import.meta.url).pathname;
  const child = spawn('sh', [entry, process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'], {
    env: {
      PATH: process.env.PATH ?? '',
      // What stands in for tini here: `env -- command` runs the command.
      PALUGADA_INIT: '/usr/bin/env',
      PALUGADA_SUPERUSER_URL: superuserUrl,
      PALUGADA_OWNER_URL: connectionString('owner'),
      PALUGADA_APP_URL: connectionString('app'),
      PALUGADA_ADMIN_URL: connectionString('admin'),
      // Compose's .env, and the variables Coolify generates for every container.
      PALUGADA_DB_SUPERUSER_PASSWORD: 'super', PALUGADA_DB_OWNER_PASSWORD: 'owner',
      PALUGADA_DB_APP_PASSWORD: 'app', PALUGADA_DB_ADMIN_PASSWORD: 'admin', POSTGRES_PASSWORD: 'super',
      SERVICE_PASSWORD_POSTGRES: 'super', SERVICE_PASSWORD_OWNER: 'owner', SERVICE_URL_APP_8787: 'https://p.example',
      ANTHROPIC_API_KEY: 'kept: the platform uses it',
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  const lines = out.trim().split('\n');
  assert.match(out, /database palugada: already as PALUGADA needs it/, 'provisioned, and nothing to change');
  assert.match(out, /already up to date/, 'migrated');
  const seen = JSON.parse(lines.at(-1)!) as string[];
  for (const gone of [
    'PALUGADA_SUPERUSER_URL', 'PALUGADA_OWNER_URL', 'PALUGADA_DB_SUPERUSER_PASSWORD', 'PALUGADA_DB_OWNER_PASSWORD',
    'PALUGADA_DB_APP_PASSWORD', 'PALUGADA_DB_ADMIN_PASSWORD', 'POSTGRES_PASSWORD', 'SERVICE_PASSWORD_POSTGRES',
    'SERVICE_PASSWORD_OWNER', 'SERVICE_URL_APP_8787', 'PALUGADA_INIT',
  ]) {
    assert.ok(!seen.includes(gone), `${gone} reached the platform`);
  }
  for (const kept of ['PALUGADA_APP_URL', 'PALUGADA_ADMIN_URL', 'ANTHROPIC_API_KEY', 'PATH']) {
    assert.ok(seen.includes(kept), `${kept} did not reach the platform`);
  }
});
