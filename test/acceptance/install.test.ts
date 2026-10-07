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
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, rmSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHELL = existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';

/**
 * Every place a test installed into, with the tarball of the checkout it
 * installed from: tens of megabytes each, and left behind they filled the
 * disk the suite runs on, a run at a time.
 */
const benches: string[] = [];
after(() => {
  for (const home of benches) rmSync(home, { recursive: true, force: true });
});

/** A place to install into, a tarball of this checkout to install from, and stand-ins for docker and curl. */
function bench(options: { dockerAnswers?: boolean; version?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'palugada-install-'));
  benches.push(home);
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
  "compose up"*) if [ -f "${home}/up-fails" ]; then echo "dependency failed to start: container migrate exited (1)" >&2; exit 1; fi ;;
  "compose ps -q db") [ -f "${home}/db-running" ] && echo 4f2a9c ;;
  # As the real one may, it reads what it is given on standard input.
  "compose exec -T db pg_dump -U postgres -d palugada") cat > /dev/null; echo "-- PostgreSQL database dump" ;;
  # What the platform prints while it has no owner: the address it is published at, as it is told it.
  "compose logs --no-color app")
    [ -f "${home}/no-claim" ] && exit 0
    origin=$(sed -n 's/^PALUGADA_APP_URL_PUBLIC=//p' .env 2>/dev/null | tail -n 1)
    echo "app-1  | palugada: no owner yet: open \${origin:-http://localhost:8787}/#/claim/k3y within a day to add your authenticator app" ;;
  "compose logs --no-color --tail 1 app") [ -f "${home}/app-says" ] && echo "app-1  | $(cat "${home}/app-says")" ;;
  "compose logs --no-color --tail 40 app") echo "app-1  | the platform's last words" ;;
  "compose logs --no-color --tail 40 migrate app") echo "migrate-1  | the migration's last words"; echo "app-1  | the platform's last words" ;;
  "compose ps --status exited --services") [ -f "${home}/exited" ] && cat "${home}/exited" ;;
  "compose ps --status restarting --services") [ -f "${home}/restarting" ] && cat "${home}/restarting" ;;
  "compose ps --status running --services") if [ -f "${home}/running" ]; then cat "${home}/running"; else printf 'db\napp\n'; fi ;;
  "compose exec -T app node scripts/browser-check.ts") echo "/usr/bin/chromium: the page rendered yes; 4 renderers, 4 in a user namespace of its own"; [ -f "${home}/browser-fails" ] && exit 1 ;;
esac
exit 0
`);
  // A download is the checkout's tarball, wherever it is asked for; the
  // health of the platform, read without -o, is what the test wrote.
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "curl $*" >> "${log}"
# Where this machine looks itself up: an answer, or none.
case "$*" in
  *ipify*|*ifconfig.me*|*icanhazip*) [ -f "${home}/public-ip" ] || exit 6; cat "${home}/public-ip"; exit 0 ;;
esac
case "$*" in
  # The console not yet answering, as many times as the test says.
  *api/health*-o*)
    if [ -f "${home}/misses" ] && [ "$(cat "${home}/misses")" -gt 0 ]; then echo $(( $(cat "${home}/misses") - 1 )) > "${home}/misses"; exit 7; fi
    exit 0 ;;
  *-o*) ;;
  *api/health*) [ -f "${home}/health.json" ] || exit 7; cat "${home}/health.json"; exit 0 ;;
esac
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && cp "${tarball}" "$2"; shift; done
exit 0
`);
  // What a name resolves to, as the test says.
  writeFileSync(join(bin, 'getent'), `#!/bin/sh
echo "getent $*" >> "${log}"
# One or more addresses, a line each, as the real one gives them.
if [ "$1" = ahostsv4 ] && [ -f "${home}/dns-ip" ]; then for ip in $(cat "${home}/dns-ip"); do echo "$ip      STREAM $2"; done; exit 0; fi
exit 2
`);
  // What mode a file has at the moment it is made private: .env.new holds the database's passwords.
  writeFileSync(join(bin, 'chmod'), `#!/bin/sh
for last in "$@"; do :; done
echo "$(stat -c %a "$last" 2>/dev/null) $last" >> "${home}/chmod.log"
exec /bin/chmod "$@"
`);
  chmodSync(join(bin, 'chmod'), 0o755);
  chmodSync(join(bin, 'getent'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const dir = join(home, 'palugada');
  const env: Record<string, string> = {
    // A machine somebody sits at, with a screen; a server is the same without it, or with SSH_CONNECTION.
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, PALUGADA_DIR: dir, DISPLAY: ':0',
    ...(options.version === undefined ? { PALUGADA_SOURCE: tarball } : { PALUGADA_VERSION: options.version }),
    PALUGADA_PORT: '8788', PALUGADA_WAIT_SECONDS: '10', PALUGADA_POLL_SECONDS: '1',
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
  return { home, dir, env, run, piped, calls };
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

/* ------------------------------------------- what the installer says, and where --- */

const lines = (text: string) => text.split('\n');

test('the wait shows it is going on: the steps, the seconds, what is running and what the platform last said', () => {
  const place = bench();
  writeFileSync(join(place.home, 'misses'), '3');
  writeFileSync(join(place.home, 'app-says'), 'palugada: applying migration 0124');
  const started = place.run();
  assert.equal(started.status, 0, started.stderr);
  for (const step of [/\[1\/4\] fetching PALUGADA/, /\[2\/4\] preparing the settings/, /\[3\/4\] building and starting/, /\[4\/4\] waiting for the console/]) {
    assert.match(started.stdout, step);
  }
  assert.match(started.stdout, /the first time it builds the image, which takes a few minutes/);
  // Three misses, one second each, a word every second poll: said once, and what it said it knows.
  assert.match(started.stdout, /still starting, 2s in \(running: db app\); the platform says: palugada: applying migration 0124/);
  assert.match(started.stdout, /the console answers, after 3s/);
  assert.equal(lines(started.stdout).filter((line) => line.includes('still starting')).length, 1);
});

test('a platform that stops while starting is said at once with its last lines, and one that cannot be started shows why', () => {
  const place = bench();
  writeFileSync(join(place.home, 'misses'), '1000');
  writeFileSync(join(place.home, 'exited'), 'migrate\napp\n');
  const began = Date.now();
  const stopped = place.run();
  assert.notEqual(stopped.status, 0);
  assert.ok(Date.now() - began < 8_000, 'not after the ten seconds it would have waited');
  assert.match(stopped.stderr, /the platform stopped while starting; the lines above are its last/);
  assert.match(stopped.stderr, /the platform's last words/);
  assert.match(stopped.stderr, /docker compose logs --tail 100 app/);

  // One that keeps starting and stopping is a platform that stopped, too.
  const looping = bench();
  writeFileSync(join(looping.home, 'misses'), '1000');
  writeFileSync(join(looping.home, 'restarting'), 'app\n');
  const again = looping.run();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /the platform stopped while starting/);

  const broken = bench();
  writeFileSync(join(broken.home, 'up-fails'), '');
  const failed = broken.run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /dependency failed to start/);
  assert.match(failed.stderr, /the migration's last words/);
  assert.match(failed.stderr, /PALUGADA did not start; the lines above are the last of the migration and of the platform/);
});

test('on a server reached over SSH it says the address to use, not localhost alone, and a way in that needs no setting up', () => {
  const place = bench();
  place.env.SSH_CONNECTION = '198.51.100.4 51234 10.0.0.5 22';
  writeFileSync(join(place.home, 'public-ip'), '203.0.113.7\n');
  const started = place.run();
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /for now only this server itself can open it/);
  assert.match(started.stdout, /ssh -N -L 8788:127\.0\.0\.1:8788 \S+@203\.0\.113\.7$/m, 'the tunnel, with this server\'s own address');
  assert.match(started.stdout, /^palugada:\s+http:\/\/localhost:8788\/#\/claim\/k3y$/m, 'the link, as the tunnel makes it open');
  assert.match(started.stdout, /PALUGADA_PUBLIC_HOST=console\.example\.com sh /);
  assert.match(started.stdout, /PALUGADA_PUBLIC_HOST=203\.0\.113\.7 sh .*without encryption/);

  // Another port for ssh itself is carried into the command.
  const other = bench();
  other.env.SSH_CONNECTION = '198.51.100.4 51234 10.0.0.5 2222';
  writeFileSync(join(other.home, 'public-ip'), '203.0.113.7');
  assert.match(other.run().stdout, /ssh -N -L 8788:127\.0\.0\.1:8788 -p 2222 \S+@203\.0\.113\.7/);

  // An answer that is a private address (a proxy's, a network's own) is not this server's public one.
  const inside = bench();
  inside.env.SSH_CONNECTION = '198.51.100.4 51234 10.0.0.5 22';
  writeFileSync(join(inside.home, 'public-ip'), '10.1.2.3');
  const hidden = inside.run().stdout;
  assert.doesNotMatch(hidden, /10\.1\.2\.3|@10\.0\.0\.5/);
  assert.match(hidden, /ssh -N -L 8788:127\.0\.0\.1:8788 \S+@<this server's address>/);
  // The address the client connected to is used when it is one the world can reach.
  const direct = bench();
  direct.env.SSH_CONNECTION = '198.51.100.4 51234 203.0.113.9 22';
  assert.match(direct.run().stdout, /ssh -N -L 8788:127\.0\.0\.1:8788 \S+@203\.0\.113\.9/);

  // A server that cannot look itself up says what to put, not an address it made up.
  const lost = bench();
  lost.env.SSH_CONNECTION = '198.51.100.4 51234 10.0.0.5 22';
  assert.match(lost.run().stdout, /ssh -N -L 8788:127\.0\.0\.1:8788 \S+@<this server's address>/);

  // At a machine's own keyboard nothing is looked up, and nothing is said about another computer.
  const here = bench();
  writeFileSync(join(here.home, 'public-ip'), '203.0.113.7');
  const local = here.run();
  assert.doesNotMatch(here.calls(), /ipify|ifconfig|icanhazip/, 'no service is asked where this machine is');
  assert.doesNotMatch(local.stdout, /ssh -N/);
  assert.match(local.stdout, /http:\/\/localhost:8788\/#\/claim\/k3y/);
});

test('PALUGADA_PUBLIC_HOST as an address opens the console on it, over plain HTTP, and says so', () => {
  const place = bench();
  place.env.PALUGADA_PUBLIC_HOST = '203.0.113.7';
  const started = place.run();
  assert.equal(started.status, 0, started.stderr);
  const env = readFileSync(join(place.dir, '.env'), 'utf8');
  assert.match(env, /^PALUGADA_PUBLISH=0\.0\.0\.0:8788$/m);
  assert.match(env, /^PALUGADA_ALLOWED_HOSTS=203\.0\.113\.7,localhost$/m);
  assert.match(env, /^PALUGADA_APP_URL_PUBLIC=http:\/\/203\.0\.113\.7:8788$/m);
  assert.doesNotMatch(env, /COMPOSE_PROFILES|PALUGADA_BEHIND_PROXY|PALUGADA_DOMAIN/);
  assert.equal(statSync(join(place.dir, '.env')).mode & 0o777, 0o600);
  assert.match(started.stdout, /^palugada:\s+http:\/\/203\.0\.113\.7:8788\/#\/claim\/k3y$/m);
  assert.match(started.stdout, /warning: a bare address has no HTTPS/);
  assert.match(started.stdout, /allow port 8788 in this server's firewall/);
  assert.doesNotMatch(started.stdout, /ssh -N/, 'it is open to the world already: no tunnel to describe');
  assert.doesNotMatch(place.calls(), /ipify|ifconfig|icanhazip/, 'an address given is not looked up');
});

test('PALUGADA_PUBLIC_HOST as a domain name puts HTTPS in front, and says whether the name points here', () => {
  const place = bench();
  place.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  writeFileSync(join(place.home, 'public-ip'), '203.0.113.7');
  writeFileSync(join(place.home, 'dns-ip'), '198.51.100.9');
  const started = place.run();
  assert.equal(started.status, 0, started.stderr);
  const env = readFileSync(join(place.dir, '.env'), 'utf8');
  assert.match(env, /^COMPOSE_PROFILES=https$/m);
  assert.match(env, /^PALUGADA_DOMAIN=console\.example\.com$/m);
  assert.match(env, /^PALUGADA_ALLOWED_HOSTS=console\.example\.com,localhost$/m);
  assert.match(env, /^PALUGADA_APP_URL_PUBLIC=https:\/\/console\.example\.com$/m);
  assert.match(env, /^PALUGADA_BEHIND_PROXY=1$/m);
  assert.match(env, /^PALUGADA_PUBLISH=127\.0\.0\.1:8788$/m, 'the platform itself stays on the loopback: only the proxy is reached');
  assert.match(started.stdout, /^palugada:\s+https:\/\/console\.example\.com\/#\/claim\/k3y$/m);
  assert.match(started.stdout, /warning: console\.example\.com points to 198\.51\.100\.9, and this server's address looks like 203\.0\.113\.7/);
  assert.match(started.stdout, /Caddy makes the HTTPS certificate when it starts/);
  assert.match(started.stdout, /ports 80 and 443/);
  // A name with several addresses, one of them this server's, is not wrong for having more.
  const several = bench();
  several.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  writeFileSync(join(several.home, 'public-ip'), '203.0.113.7');
  writeFileSync(join(several.home, 'dns-ip'), '198.51.100.9 203.0.113.7');
  assert.match(several.run().stdout, /console\.example\.com points to this server \(203\.0\.113\.7\)/);

  // Pointed here, nothing is warned of; not found at all, it is said so.
  const right = bench();
  right.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  writeFileSync(join(right.home, 'public-ip'), '203.0.113.7');
  writeFileSync(join(right.home, 'dns-ip'), '203.0.113.7');
  const fine = right.run();
  assert.doesNotMatch(fine.stdout, /warning: console\.example\.com points to/);
  assert.match(fine.stdout, /console\.example\.com points to this server/);
  const unknown = bench();
  unknown.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  writeFileSync(join(unknown.home, 'public-ip'), '203.0.113.7');
  assert.match(unknown.run().stdout, /warning: console\.example\.com has no IPv4 address yet/);
});

test('a public host that is not a domain name or an address is refused before anything is written', () => {
  for (const odd of ['a b', 'console.example.com;rm -rf /', 'https://console.example.com', 'console.example.com/x', '-x.example.com', 'console', 'localhost', '127.0.0.1', '0.0.0.0', '256.1.1.1', '1.2.3', 'ex ample.com', 'a..b.com', '$(id).com', '[::1]', 'console.example.com:8080']) {
    const place = bench();
    place.env.PALUGADA_PUBLIC_HOST = odd;
    const refused = place.run();
    assert.notEqual(refused.status, 0, odd);
    assert.match(refused.stderr, /PALUGADA_PUBLIC_HOST is a domain name such as console\.example\.com, or an IPv4 address that others can reach, or private/, odd);
    assert.equal(existsSync(place.dir), false, `${odd}: nothing was written`);
    assert.doesNotMatch(place.calls(), /compose up/, odd);
  }
});

test('what was chosen stays through an update; another choice replaces it, and private takes it back', () => {
  const place = bench();
  place.env.PALUGADA_PUBLIC_HOST = '203.0.113.7';
  assert.equal(place.run().status, 0);
  delete place.env.PALUGADA_PUBLIC_HOST;
  writeFileSync(join(place.home, 'db-running'), '');
  assert.equal(place.run().status, 0);
  const kept = readFileSync(join(place.dir, '.env'), 'utf8');
  assert.match(kept, /^PALUGADA_APP_URL_PUBLIC=http:\/\/203\.0\.113\.7:8788$/m, 'an update does not close what the owner opened');
  const passwords = kept.split('\n').filter((line) => line.startsWith('PALUGADA_DB_'));
  assert.equal(passwords.length, 4);

  place.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  assert.equal(place.run().status, 0);
  const domain = readFileSync(join(place.dir, '.env'), 'utf8');
  assert.match(domain, /^PALUGADA_PUBLISH=127\.0\.0\.1:8788$/m, 'plain HTTP on the address is closed when HTTPS takes over');
  assert.doesNotMatch(domain, /0\.0\.0\.0/);
  for (const key of ['PALUGADA_PUBLISH', 'PALUGADA_ALLOWED_HOSTS', 'PALUGADA_APP_URL_PUBLIC']) {
    assert.equal(lines(domain).filter((line) => line.startsWith(`${key}=`)).length, 1, `${key} once`);
  }
  assert.deepEqual(domain.split('\n').filter((line) => line.startsWith('PALUGADA_DB_')), passwords, 'the passwords are the ones there were');

  place.env.PALUGADA_PUBLIC_HOST = '203.0.113.7';
  assert.equal(place.run().status, 0);
  const back = readFileSync(join(place.dir, '.env'), 'utf8');
  assert.doesNotMatch(back, /COMPOSE_PROFILES|PALUGADA_DOMAIN|PALUGADA_BEHIND_PROXY/, 'the proxy is not left on for an address');

  place.env.PALUGADA_PUBLIC_HOST = 'private';
  const closed = place.run();
  assert.equal(closed.status, 0, closed.stderr);
  const alone = readFileSync(join(place.dir, '.env'), 'utf8');
  assert.doesNotMatch(alone, /COMPOSE_PROFILES|PALUGADA_DOMAIN|PALUGADA_BEHIND_PROXY|PALUGADA_ALLOWED_HOSTS|PALUGADA_APP_URL_PUBLIC|0\.0\.0\.0/);
  assert.match(alone, /^PALUGADA_PUBLISH=127\.0\.0\.1:8788$/m, 'on this machine alone again');
  assert.deepEqual(alone.split('\n').filter((line) => line.startsWith('PALUGADA_DB_')), passwords);
});

test('Compose has the HTTPS proxy under a profile of its own, and publishes nothing else to the world', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const service = (name: string) => compose.split(/^  (?=[a-z][a-z-]*:\n)/m).find((block) => block.startsWith(`${name}:`)) ?? '';
  const caddy = service('caddy');
  assert.match(caddy, /image: caddy:2\b/);
  assert.match(caddy, /profiles: \["https"\]/, 'it starts only when HTTPS was asked for');
  assert.match(caddy, /PALUGADA_DOMAIN: \$\{PALUGADA_DOMAIN:-\}/, 'not a required value: Compose reads every service, started or not');
  assert.deepEqual([...caddy.matchAll(/^      - "(\d+:\d+(?:\/udp)?)"$/gm)].map((match) => match[1]), ['80:80', '443:443', '443:443/udp']);
  assert.match(service('app'), /"\$\{PALUGADA_PUBLISH:-127\.0\.0\.1:8787\}:8787"/, 'the platform is still on the loopback unless told');
  assert.doesNotMatch(service('db'), /ports:/);
  const caddyfile = readFileSync(join(ROOT, 'deploy/docker/Caddyfile'), 'utf8');
  assert.match(caddyfile, /^\{\$PALUGADA_DOMAIN\} \{$/m);
  assert.match(caddyfile, /^\treverse_proxy app:8787$/m);
  assert.doesNotMatch(caddyfile, /header_up\s+Host/i, 'the name the owner opened is passed on: the console answers only to the names it was given');
});

test('doctor knows about the proxy and says where the console is meant to be opened', () => {
  const place = bench();
  place.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  assert.equal(place.run().status, 0);
  writeFileSync(join(place.home, 'health.json'), '{"ok":true,"database":"ok","version":"0.1.0","worker":{}}');
  const checked = place.run('doctor');
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /mended: started caddy, which had stopped/);
  assert.match(checked.stdout, /ok: the console is meant to be opened at https:\/\/console\.example\.com/);

  const plain = bench();
  assert.equal(plain.run().status, 0);
  writeFileSync(join(plain.home, 'health.json'), '{"ok":true,"database":"ok","version":"0.1.0","worker":{}}');
  const alone = plain.run('doctor');
  assert.equal(alone.status, 0, alone.stdout + alone.stderr);
  assert.doesNotMatch(alone.stdout, /caddy/);
  assert.match(alone.stdout, /ok: the console is open on this machine alone/);
});

test('a server is a server without SSH too: under sudo, in a provider\'s console, in cloud-init -- the original "localhost on a VPS" does not come back', () => {
  // No SSH_CONNECTION, as sudo's env_reset leaves it, and no screen.
  const sudo = bench();
  delete sudo.env.DISPLAY;
  sudo.env.SUDO_USER = 'deploy';
  writeFileSync(join(sudo.home, 'public-ip'), '203.0.113.7');
  const out = sudo.run().stdout;
  assert.match(out, /for now only this server itself can open it/);
  assert.match(out, /ssh -N -L 8788:127\.0\.0\.1:8788 deploy@203\.0\.113\.7/, 'the account that signs in, not the one sudo runs as');
  assert.match(out, /PALUGADA_PUBLIC_HOST=console\.example\.com/);

  // The older variable alone is enough too.
  const client = bench();
  delete client.env.DISPLAY;
  client.env.SSH_CLIENT = '198.51.100.4 51234 22';
  assert.match(client.run().stdout, /for now only this server itself can open it/);

  // At a desktop, with a screen, nothing is said of another computer and nothing is looked up.
  const desktop = bench();
  writeFileSync(join(desktop.home, 'public-ip'), '203.0.113.7');
  const here = desktop.run();
  assert.doesNotMatch(here.stdout, /ssh -N|only this server itself/);
  assert.doesNotMatch(desktop.calls(), /ipify|ifconfig|icanhazip/);

  // With no link to open (the owner exists already), the tunnel says what to open instead of "the link above".
  const update = bench();
  delete update.env.DISPLAY;
  update.env.SSH_CONNECTION = '198.51.100.4 51234 203.0.113.7 22';
  assert.equal(update.run().status, 0);
  writeFileSync(join(update.home, 'db-running'), '');
  // The stand-in docker prints a link only while this file is absent: the platform has an owner now.
  writeFileSync(join(update.home, 'no-claim'), '');
  const again = update.run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /leave it running, and open http:\/\/localhost:8788 on that computer/);
  assert.doesNotMatch(again.stdout, /the link above/);
});

test('leaving HTTPS stops the proxy by name, since Compose leaves a container whose profile is off running', () => {
  const place = bench();
  place.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  assert.equal(place.run().status, 0);
  assert.doesNotMatch(place.calls(), /rm -s -f caddy/, 'not stopped on the way in');
  writeFileSync(join(place.home, 'db-running'), '');

  delete place.env.PALUGADA_PUBLIC_HOST;
  assert.equal(place.run().status, 0);
  assert.doesNotMatch(place.calls(), /rm -s -f caddy/, 'an update that chose nothing leaves it as it was');

  place.env.PALUGADA_PUBLIC_HOST = 'private';
  const closed = place.run();
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(place.calls(), /docker compose --profile https rm -s -f caddy/, 'private takes it down');
  assert.ok(place.calls().indexOf('rm -s -f caddy') < place.calls().lastIndexOf('compose up'), 'before the platform is started again');

  const second = bench();
  second.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  assert.equal(second.run().status, 0);
  writeFileSync(join(second.home, 'db-running'), '');
  second.env.PALUGADA_PUBLIC_HOST = '203.0.113.7';
  assert.equal(second.run().status, 0);
  assert.match(second.calls(), /rm -s -f caddy/, 'and so does an address');
  // The command it prints to stop everything reaches the proxy as well.
  assert.match(closed.stdout, /docker compose --profile https down/);
});

test('an https address of the owner\'s own proxy is not told about Caddy, and a name with a port is not looked up whole', () => {
  const place = bench();
  assert.equal(place.run().status, 0);
  writeFileSync(join(place.dir, '.env'), `${readFileSync(join(place.dir, '.env'), 'utf8')}PALUGADA_APP_URL_PUBLIC=https://palugada.example.com:8443\n`);
  writeFileSync(join(place.home, 'db-running'), '');
  writeFileSync(join(place.home, 'public-ip'), '203.0.113.7');
  writeFileSync(join(place.home, 'dns-ip'), '198.51.100.9');
  const update = place.run();
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /PALUGADA is running at https:\/\/palugada\.example\.com:8443/);
  assert.doesNotMatch(update.stdout, /Caddy|warning:/);
  assert.doesNotMatch(place.calls(), /getent ahostsv4 palugada/, 'nothing is checked that is not this installer\'s to check');

  // Its own proxy and port, and a name that does carry one: the port and path are not part of the name.
  const mine = bench();
  mine.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  writeFileSync(join(mine.home, 'dns-ip'), '203.0.113.7');
  assert.equal(mine.run().status, 0);
  assert.match(mine.calls(), /getent ahostsv4 console\.example\.com\b/);
});

test('numbers are checked before anything is written or waited on: a poll of 0 would never end, a port goes into .env', () => {
  for (const [name, value, said] of [
    ['PALUGADA_POLL_SECONDS', '0', /PALUGADA_POLL_SECONDS is a whole number of seconds, 1 or more; got 0/],
    ['PALUGADA_POLL_SECONDS', '0.5', /PALUGADA_POLL_SECONDS is a whole number/],
    ['PALUGADA_POLL_SECONDS', '2s', /PALUGADA_POLL_SECONDS is a whole number/],
    ['PALUGADA_WAIT_SECONDS', '-3', /PALUGADA_WAIT_SECONDS is a whole number/],
    ['PALUGADA_PORT', '80 80', /PALUGADA_PORT is a port, 1 to 65535; got 80 80/],
    ['PALUGADA_PORT', '70000', /PALUGADA_PORT is a port/],
    ['PALUGADA_PORT', '0', /PALUGADA_PORT is a port/],
  ] as const) {
    const place = bench();
    place.env[name] = value;
    const refused = place.run();
    assert.notEqual(refused.status, 0, `${name}=${value}`);
    assert.match(refused.stderr, said, `${name}=${value}`);
    assert.equal(existsSync(join(place.dir, '.env')), false, `${name}=${value} wrote nothing`);
    assert.doesNotMatch(place.calls(), /compose up/, `${name}=${value} started nothing`);
  }
});

test('the file that holds the passwords is private from the moment it is made, and a console that never answers ends the wait', () => {
  const place = bench();
  assert.equal(place.run().status, 0);
  place.env.PALUGADA_PUBLIC_HOST = 'console.example.com';
  writeFileSync(join(place.home, 'db-running'), '');
  assert.equal(place.run().status, 0);
  const modes = readFileSync(join(place.home, 'chmod.log'), 'utf8').split('\n').filter((line) => line.endsWith('.env.new'));
  assert.ok(modes.length >= 5, 'every setting made a new file');
  assert.ok(modes.every((line) => line.startsWith('600 ')), `private as it was made, not after: ${modes.join(' | ')}`);

  // A console that does not answer within the time given ends the wait, saying so, with the platform's last lines.
  const slow = bench();
  writeFileSync(join(slow.home, 'misses'), '1000');
  slow.env.PALUGADA_WAIT_SECONDS = '2';
  const timed = slow.run();
  assert.notEqual(timed.status, 0);
  assert.match(timed.stderr, /the console did not answer within 2 seconds; the lines above are the platform's last/);
});

test('a service that exited by design is not a platform that stopped', () => {
  // `migrate` runs once and exits: it is in the list of exited services on every healthy start.
  const place = bench();
  writeFileSync(join(place.home, 'exited'), 'migrate\n');
  writeFileSync(join(place.home, 'misses'), '3');
  const started = place.run();
  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(started.stderr, /stopped while starting/);
});
