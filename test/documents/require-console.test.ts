/**
 * `npm test` alone, without the console built.
 *
 * Three tests serve the built console, and without `console/dist` they
 * failed one by one with a 404, a boot that could not find its page and a
 * path the guide names -- three puzzles for one missing step. `pretest`
 * (scripts/require-console.ts) now stops before the suite with the step to
 * take. Run here against a copy of the script in a directory of its own, so
 * the real build is not moved to test it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('npm test stops before the suite when the console is not built, and says how to build it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palugada-pretest-'));
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts', 'require-console.ts');
  await copyFile(new URL('../../scripts/require-console.ts', import.meta.url), script);

  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /the console is not built.*npm run console:build/);

  await mkdir(join(root, 'console', 'dist'), { recursive: true });
  await writeFile(join(root, 'console', 'dist', 'index.html'), '<html></html>');
  const built = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);

  const scripts = (JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts.pretest, 'node scripts/require-console.ts', 'npm runs it before every `npm test`');
});
