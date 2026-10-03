/**
 * PALUGADA in one command (the analysis of 3 October, §5.2 item 1 and §9 P2).
 *
 * Installing took git, Node, `npm install`, an interactive `npm run setup`
 * and Docker; Paperclip installs with one command and Buzz offers a hosted
 * one. `install.sh` needs Docker alone: it fetches PALUGADA, writes the
 * database's passwords once, starts it with Compose, waits for the console
 * and prints the link that makes its opener the owner. Run again it updates,
 * keeping the passwords and copying the database first.
 *
 * Docker and curl are stand-ins here that record what they were asked: what
 * is tested is the script's part, and the containers it starts are tested by
 * `npm run container:check` in CI's docker job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, rmSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHELL = existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';

/** A place to install into, a tarball of this checkout to install from, and stand-ins for docker and curl. */
function bench(options: { dockerAnswers?: boolean; version?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'palugada-install-'));
  const bin = join(home, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(home, 'calls.log');
  const tarball = join(home, 'palugada.tar.gz');
  execFileSync('git', ['archive', '--format=tar.gz', '--prefix=PALUGADA-main/', '-o', tarball, 'HEAD'], { cwd: ROOT });
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "docker $*" >> "${log}"
case "$*" in
  info) ${options.dockerAnswers === false ? 'exit 1' : 'exit 0'} ;;
  "compose version") exit 0 ;;
  "compose ps -q db") [ -f "${home}/db-running" ] && echo 4f2a9c ;;
  # As the real one may, it reads what it is given on standard input.
  "compose exec -T db pg_dump -U postgres -d palugada") cat > /dev/null; echo "-- PostgreSQL database dump" ;;
  "compose logs --no-color app") echo "app-1  | palugada: no owner yet: open http://localhost:8787/#/claim/k3y within a day to add your authenticator app" ;;
  "compose ps --status running --services") if [ -f "${home}/running" ]; then cat "${home}/running"; else printf 'db\napp\n'; fi ;;
  "compose exec -T app node scripts/browser-check.ts") echo "/usr/bin/chromium: the page rendered yes; 4 renderers, 4 in a user namespace of its own"; [ -f "${home}/browser-fails" ] && exit 1 ;;
esac
exit 0
`);
  // A download is the checkout's tarball, wherever it is asked for; the
  // health of the platform, read without -o, is what the test wrote.
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "curl $*" >> "${log}"
case "$*" in
  *-o*) ;;
  *api/health*) [ -f "${home}/health.json" ] || exit 7; cat "${home}/health.json"; exit 0 ;;
esac
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && cp "${tarball}" "$2"; shift; done
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const dir = join(home, 'palugada');
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, PALUGADA_DIR: dir,
    ...(options.version === undefined ? { PALUGADA_SOURCE: tarball } : { PALUGADA_VERSION: options.version }),
    PALUGADA_PORT: '8788', PALUGADA_WAIT_SECONDS: '10',
  };
  const run = (...args: string[]) => spawnSync(SHELL, [join(ROOT, 'install.sh'), ...args], { encoding: 'utf8', env });
  /**
   * Piped, as `curl ... | sh` runs it, and arriving a little at a time as a
   * download does: the shell runs what it has read while the rest is still
   * coming, and a command reading standard input reads the rest of the script.
   */
  const piped = async (): Promise<{ status: number | null; stdout: string; stderr: string }> => {
    const child = spawn(SHELL, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.on('error', () => undefined);
    const script = readFileSync(join(ROOT, 'install.sh'), 'utf8');
    for (let at = 0; at < script.length; at += 256) {
      child.stdin.write(script.slice(at, at + 256));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.stdin.end();
    return { status: await closed, stdout, stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { home, dir, run, piped, calls };
}

test('one command installs PALUGADA with Docker alone and prints the link that makes its opener the owner', () => {
  const place = bench();
  const first = place.run();
  assert.equal(first.status, 0, first.stderr);

  assert.ok(existsSync(join(place.dir, 'docker-compose.yml')), 'the code is there');
  const env = readFileSync(join(place.dir, '.env'), 'utf8');
  for (const role of ['SUPERUSER', 'OWNER', 'APP', 'ADMIN']) {
    assert.match(env, new RegExp(`^PALUGADA_DB_${role}_PASSWORD=[0-9a-f]{36}$`, 'm'), `a password for ${role}`);
  }
  assert.match(env, /^PALUGADA_PUBLISH=127\.0\.0\.1:8788$/m, 'on the port asked for');
  assert.equal(statSync(join(place.dir, '.env')).mode & 0o777, 0o600, 'readable by its owner alone');

  assert.match(place.calls(), /^docker compose up -d --build$/m);
  assert.match(place.calls(), /^curl -fsSL http:\/\/127\.0\.0\.1:8788\/api\/health/m, 'it waits for the console');
  assert.doesNotMatch(place.calls(), /pg_dump/, 'nothing to copy on a first install');
  assert.match(first.stdout, /http:\/\/localhost:8788\/#\/claim\/k3y/, 'the claim link, on the port published here');
});

test('run again, it updates: the same passwords, and the database copied first', () => {
  const place = bench();
  assert.equal(place.run().status, 0);
  const env = readFileSync(join(place.dir, '.env'), 'utf8');
  writeFileSync(join(place.home, 'db-running'), '');

  const second = place.run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(place.dir, '.env'), 'utf8'), env, 'a new password would lock the platform out of its own database');
  assert.match(place.calls(), /^docker compose exec -T db pg_dump -U postgres -d palugada$/m);
  const copies = readdirSync(join(place.dir, 'backups')).filter((name) => name.endsWith('.sql.gz'));
  assert.equal(copies.length, 1);
  assert.match(copies[0]!, /^palugada-\d{8}T\d{6}Z\.sql\.gz$/);
  assert.match(execFileSync('gzip', ['-dc', join(place.dir, 'backups', copies[0]!)], { encoding: 'utf8' }), /PostgreSQL database dump/);
  // The copy is taken before the code changes: the dump comes before the build in the calls.
  const calls = place.calls().trim().split('\n');
  const dumped = calls.findIndex((line) => line.includes('pg_dump'));
  const built = calls.findLastIndex((line) => line.includes('compose up'));
  assert.ok(dumped >= 0 && dumped < built);
});

test('piped into sh, as curl ... | sh runs it, it reads all of itself before a command can read the rest', async () => {
  const place = bench();
  assert.equal((await place.piped()).status, 0);
  writeFileSync(join(place.home, 'db-running'), '');
  const update = await place.piped();
  assert.equal(update.status, 0, update.stderr);
  // Had the copy read the script from standard input, nothing after it would have run.
  assert.match(update.stdout, /claim\/k3y/);
  assert.equal(place.calls().match(/compose up -d --build/g)?.length, 2);
});

test('without a Docker that answers, it says what to do and changes nothing', () => {
  const place = bench({ dockerAnswers: false });
  const refused = place.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Docker is installed but not answering: start Docker/);
  assert.equal(existsSync(place.dir), false, 'nothing was written');
});

test('PALUGADA_VERSION installs that release instead of the main branch, and a version that is not a tag is refused', () => {
  const place = bench({ version: 'v0.2.0' });
  const pinned = place.run();
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(place.calls(), /^curl -fsSL https:\/\/codeload\.github\.com\/TegarTheGreat\/PALUGADA\/tar\.gz\/refs\/tags\/v0\.2\.0 -o /m);
  assert.ok(existsSync(join(place.dir, 'docker-compose.yml')));

  const odd = bench({ version: 'main; touch pwned' });
  const refusedRun = odd.run();
  assert.notEqual(refusedRun.status, 0);
  assert.match(refusedRun.stderr, /PALUGADA_VERSION is a release's tag, as v0\.2\.0/);
  assert.doesNotMatch(odd.calls(), /^curl/m, 'nothing is downloaded');
});

test('an update keeps the code it replaced, and rollback brings it back without touching the data', () => {
  const place = bench();
  assert.equal(place.run().status, 0);
  writeFileSync(join(place.dir, 'marker.txt'), 'the version before');
  writeFileSync(join(place.home, 'db-running'), '');
  const update = place.run();
  assert.equal(update.status, 0, update.stderr);
  const kept = readdirSync(join(place.dir, 'backups')).sort();
  assert.equal(kept.length, 2, kept.join(', '));
  const stamp = /^palugada-(\d{8}T\d{6}Z)\.code\.tar\.gz$/.exec(kept[0]!)?.[1];
  assert.ok(stamp, kept[0]);
  assert.equal(kept[1], `palugada-${stamp}.sql.gz`, 'the code and the database, from the same moment');
  const entries = execFileSync('tar', ['-tzf', join(place.dir, 'backups', kept[0]!)], { encoding: 'utf8' }).split('\n');
  assert.ok(entries.includes('./marker.txt') && entries.includes('./docker-compose.yml'), 'the code as it was');
  assert.ok(!entries.some((entry) => entry === './.env' || entry.startsWith('./backups')), 'without the passwords or the copies');

  writeFileSync(join(place.dir, 'marker.txt'), 'the version after');
  const env = readFileSync(join(place.dir, '.env'), 'utf8');
  const builds = place.calls().match(/compose up -d --build/g)!.length;
  const dumps = place.calls().match(/pg_dump/g)!.length;
  const back = place.run('rollback');
  assert.equal(back.status, 0, back.stderr);
  assert.equal(readFileSync(join(place.dir, 'marker.txt'), 'utf8'), 'the version before');
  assert.equal(readFileSync(join(place.dir, '.env'), 'utf8'), env);
  assert.equal(place.calls().match(/compose up -d --build/g)!.length, builds + 1, 'built and started again');
  assert.equal(place.calls().match(/pg_dump/g)!.length, dumps + 1, 'with a copy of the database taken first');
  assert.doesNotMatch(place.calls(), /psql/, 'the data is left as it is: migrations only add');
  // How to take the data back too, if that is what is wanted.
  assert.ok(back.stdout.includes(`gzip -dc backups/palugada-${stamp}.sql.gz`), back.stdout);
});

test('rollback with nothing to go back to says so and changes nothing', () => {
  const place = bench();
  assert.equal(place.run().status, 0);
  const before = place.calls();
  const refused = place.run('rollback');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /no earlier version to go back to/);
  assert.equal(place.calls().replace(before, '').match(/compose up/g), null);
  const odd = place.run('repair');
  assert.notEqual(odd.status, 0);
  assert.match(odd.stderr, /install, doctor or rollback/);
});

test('doctor says what is well, mends what is safe to mend, and names what is not', () => {
  const place = bench();
  assert.equal(place.run().status, 0);
  writeFileSync(join(place.home, 'health.json'),
    '{"ok":true,"database":"ok","version":"0.1.0","worker":{"lastTickAt":"2026-10-03T08:15:02.114Z"}}');
  // Someone loosened .env, and the app is not running.
  chmodSync(join(place.dir, '.env'), 0o644);
  writeFileSync(join(place.home, 'running'), 'db\n');
  const checked = place.run('doctor');
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(statSync(join(place.dir, '.env')).mode & 0o777, 0o600, '.env is the owner\'s alone again');
  assert.match(place.calls(), /^docker compose up -d$/m, 'what was stopped is started, not rebuilt');
  assert.match(checked.stdout, /mended: \.env/);
  assert.match(checked.stdout, /mended: started app/);
  assert.match(checked.stdout, /ok: the console answers, version 0\.1\.0/);
  assert.match(checked.stdout, /ok: the browser runs sandboxed/);

  // A platform that does not answer, and a browser that cannot sandbox, are named, with what to do.
  rmSync(join(place.home, 'health.json'));
  writeFileSync(join(place.home, 'browser-fails'), '');
  const sick = place.run('doctor');
  assert.notEqual(sick.status, 0);
  assert.match(sick.stdout, /problem: the console does not answer .*docker compose logs --tail 40 app/);
  assert.match(sick.stdout, /problem: the browser/);
});
