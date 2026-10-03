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
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHELL = existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';

/** A place to install into, a tarball of this checkout to install from, and stand-ins for docker and curl. */
function bench(options: { dockerAnswers?: boolean } = {}) {
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
esac
exit 0
`);
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho "curl $*" >> "${log}"\nexit 0\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const dir = join(home, 'palugada');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, PALUGADA_DIR: dir, PALUGADA_SOURCE: tarball,
    PALUGADA_PORT: '8788', PALUGADA_WAIT_SECONDS: '10',
  };
  const run = () => spawnSync(SHELL, [join(ROOT, 'install.sh')], { encoding: 'utf8', env });
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
  const copies = readdirSync(join(place.dir, 'backups'));
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
