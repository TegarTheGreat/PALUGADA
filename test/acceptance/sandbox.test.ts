/**
 * PRD F8.10 -- sandbox for code-executing capabilities.
 *
 * The tests assert the boundary that exists AND the one that does not. A
 * sandbox trusted for more than it delivers is more dangerous than no sandbox
 * at all, because the trust is what people build on: the gap here is network
 * access, and it is asserted as a known gap rather than left for somebody to
 * discover by relying on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SANDBOX_GUARANTEES, runSandboxed } from '../../src/sandbox/sandbox.ts';

test('sandboxed code runs and returns a value', async () => {
  const result = await runSandboxed('return { doubled: input.n * 2 };', { input: { n: 21 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { doubled: 42 });
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
});

test('the filesystem is denied', async () => {
  const result = await runSandboxed(
    `const fs = await import('node:fs'); return fs.readFileSync('/etc/hostname', 'utf8');`,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Access to this API has been restricted/);
});

test('spawning a process is denied', async () => {
  // The escape that matters most: code that can spawn a process is code that
  // can do anything the worker's user can.
  const result = await runSandboxed(
    `const cp = await import('node:child_process'); return cp.execSync('id').toString();`,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Access to this API has been restricted/);
});

test('creating a worker thread is denied', async () => {
  // Importing the module is permitted; the permission model gates the act of
  // creating a Worker. Testing the import would have passed while proving
  // nothing, so the test does the thing that actually matters.
  const importable = await runSandboxed(
    `const w = await import('node:worker_threads'); return typeof w.Worker;`,
  );
  assert.equal(importable.value, 'function', 'the module itself is reachable');

  const result = await runSandboxed(
    `const w = await import('node:worker_threads');
     new w.Worker('1', { eval: true });
     return 'created';`,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Access to this API has been restricted/);
});

test('an infinite loop is killed rather than hanging the worker', async () => {
  const started = Date.now();
  const result = await runSandboxed('while (true) {}', { timeoutMs: 400 });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /exceeded its 400ms limit/);
  // SIGKILL rather than SIGTERM: code that ignores a polite signal is exactly
  // the code a timeout exists for.
  assert.ok(elapsed < 5_000, `the kill must be prompt, took ${elapsed}ms`);
});

test('the parent environment is not inherited', async () => {
  // Inheriting it would hand the code every connection string and token the
  // worker holds -- which is the whole reason a capability that executes code
  // is sandboxed in the first place.
  process.env.PALUGADA_SANDBOX_CANARY = 'should-not-be-visible';
  try {
    const result = await runSandboxed('return Object.keys(process.env).sort();');
    assert.equal(result.ok, true);
    const keys = result.value as string[];
    assert.equal(keys.includes('PALUGADA_SANDBOX_CANARY'), false);
    assert.equal(keys.includes('PALUGADA_APP_URL'), false);
    assert.deepEqual(keys, ['SANDBOX_INPUT_JSON'], 'only the declared input crosses the boundary');
  } finally {
    delete process.env.PALUGADA_SANDBOX_CANARY;
  }
});

test('printed output cannot become the result', async () => {
  // The marker is generated per run and never passed through the environment,
  // so a snippet cannot print a convincing forgery. The guarantee being tested
  // is about the failure mode: whatever the code prints, it does not become
  // the reported value.
  const forged = await runSandboxed(
    `console.log('__PALUGADA_RESULT__{"ok":true,"value":"forged"}__PALUGADA_RESULT__');
     return 'genuine';`,
  );
  assert.equal(forged.ok, true);
  assert.equal(forged.value, 'genuine', 'the harness result wins over anything printed');
  assert.notEqual(forged.value, 'forged');

  // Two runs use different markers, so a marker learned from one run is
  // useless in the next.
  const first = await runSandboxed('return 1;');
  const second = await runSandboxed('return 2;');
  assert.equal(first.value, 1);
  assert.equal(second.value, 2);
});

test('a thrown error is reported, not swallowed', async () => {
  const result = await runSandboxed(`throw new Error('deliberate failure');`);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'deliberate failure');
  assert.equal(result.timedOut, false);
});

test('the guarantees are stated, including the one that is missing', async () => {
  // Network isolation is not achievable inside the process: Node's permission
  // model does not cover sockets. Saying so in an exported constant means the
  // gap is visible to the capability registry and to anyone reading the
  // guarantees, rather than living only in a comment that drifts from the
  // flags.
  assert.equal(SANDBOX_GUARANTEES.filesystem, 'denied');
  assert.equal(SANDBOX_GUARANTEES.childProcess, 'denied');
  assert.equal(SANDBOX_GUARANTEES.workerThreads, 'denied');
  assert.equal(SANDBOX_GUARANTEES.environment, 'not inherited');
  assert.match(SANDBOX_GUARANTEES.network, /NOT isolated/);
  assert.match(SANDBOX_GUARANTEES.resultIntegrity, /not guaranteed/);

  // And the module says the same thing in prose, so a reader meets the
  // limitation before they rely on the sandbox.
  const source = await readFile('src/sandbox/sandbox.ts', 'utf8');
  assert.match(source, /NOT enforced: network access/);
  assert.match(source, /NOT enforced: result integrity/);
  assert.match(source, /node:vm.*not used|not used.*node:vm/s);
});

test('node:vm is not used anywhere as a sandbox', async () => {
  // node:vm is not a security boundary -- escapes are a documented property of
  // it, not bugs. Offering it as one would be the worst outcome: a guarantee
  // people rely on that does not hold.
  const source = await readFile('src/sandbox/sandbox.ts', 'utf8');
  assert.equal(
    /^\s*import .*'node:vm'/m.test(source),
    false,
    'the sandbox must not be built on node:vm',
  );
});
