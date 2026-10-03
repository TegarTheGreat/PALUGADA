/**
 * What the process does with a failure nothing handled (L2, the audit of
 * 30 September, open on 2 October).
 *
 * Nothing in `src/` or `scripts/` listened for `unhandledRejection` or
 * `uncaughtException`, so Node's default applied to both: the process died
 * where it stood. One promise nobody awaited -- a notice to a chat, a sweep
 * that lost the database for a moment -- took the console and the worker
 * down with it, every run cut off rather than handed back, each to come back
 * only when its lease ran out, and counted as a lost worker.
 *
 * Run in a process of its own, because the failures are the process's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../src/process-guard.ts', import.meta.url));
const SECRETS = fileURLToPath(new URL('../../src/secrets/manager.ts', import.meta.url));

function run(script: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

test('a promise nothing awaited is said and the process goes on; an exception nothing caught stops it the way a signal does (L2)', async () => {
  const { code, out } = await run(`
    import { guardProcess } from ${JSON.stringify(GUARD)};
    import { redactor } from ${JSON.stringify(SECRETS)};
    redactor.register('sk-live-0123456789abcdef0123');
    guardProcess({
      write: (line) => process.stdout.write(line),
      stop: async () => { process.stdout.write('handed back\\n'); },
      exit: (code) => { process.stdout.write('exit ' + code + '\\n'); process.exit(code); },
    });
    Promise.reject(new Error('a notice nobody awaited, with token sk-live-0123456789abcdef0123'));
    setTimeout(() => {
      process.stdout.write('still running\\n');
      setTimeout(() => { throw new Error('a bug in a timer'); }, 10);
    }, 100);
  `);
  assert.equal(code, 1, out);
  assert.match(out, /palugada: a failure nothing handled, and the process goes on: Error: a notice nobody awaited/);
  assert.match(out, /still running/, 'the rejection did not end it');
  assert.ok(!out.includes('sk-live-0123456789abcdef0123') && out.includes('[redacted]'), 'a secret in it is not written out');
  assert.match(out, /palugada: an exception nothing caught, so the process stops: Error: a bug in a timer/);
  assert.ok(out.indexOf('handed back') > out.indexOf('a bug in a timer'), 'it stops the way a signal stops it');
  assert.match(out, /exit 1\n/, 'and exits 1, for the supervisor to start a clean one');
});

test('a stop that never finishes does not keep a broken process alive (L2)', async () => {
  const started = Date.now();
  const { code, out } = await run(`
    import { guardProcess } from ${JSON.stringify(GUARD)};
    guardProcess({
      write: (line) => process.stdout.write(line),
      stop: () => new Promise(() => {}),
      exit: (code) => { process.stdout.write('exit ' + code + '\\n'); process.exit(code); },
      stopWithinMs: 200,
    });
    setInterval(() => {}, 1000);
    setTimeout(() => { throw new Error('a bug in a timer'); }, 10);
  `);
  assert.equal(code, 1, out);
  assert.match(out, /exit 1/);
  assert.ok(Date.now() - started < 5_000, 'it did not wait for ever');
});
