/**
 * The coverage report CI prints (scripts/coverage-report.ts).
 *
 * Read against a made-up lcov file rather than a real run: what has to hold
 * is that the totals are summed, the files with functions never called are
 * named, and a file under `src/` that no test loads fails the job by name --
 * the one thing the report is allowed to fail for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'coverage-report.ts');

async function sources(): Promise<string[]> {
  const all = await readdir(join(ROOT, 'src'), { recursive: true });
  return all.filter((name) => name.endsWith('.ts')).map((name) => relative(ROOT, join(ROOT, 'src', name))).sort();
}

function record(file: string, uncalled: string[] = []): string {
  return [
    'TN:', `SF:${file}`,
    'FN:1,called', ...uncalled.map((name, index) => `FN:${index + 2},${name}`),
    'FNDA:3,called', ...uncalled.map((name) => `FNDA:0,${name}`),
    `FNF:${1 + uncalled.length}`, 'FNH:1',
    'BRF:4', 'BRH:3', 'LF:10', 'LH:9', 'end_of_record',
  ].join('\n');
}

test('the coverage report sums what was reached, names the functions never called, and fails for a file no test loads', async () => {
  const files = await sources();
  const dir = await mkdtemp(join(tmpdir(), 'palugada-coverage-'));
  const lcov = join(dir, 'lcov.info');

  await writeFile(lcov, files.map((file, index) => record(file, index === 0 ? ['neverCalled', 'alsoNever'] : [])).join('\n'));
  const whole = spawnSync(process.execPath, [SCRIPT, lcov], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(whole.status, 0, whole.stderr);
  const functions = files.length + 2;
  assert.match(whole.stdout, new RegExp(`Functions [0-9.]+% \\(${files.length} of ${functions}\\)`));
  assert.match(whole.stdout, new RegExp(`branches 75\\.0% \\(${3 * files.length} of ${4 * files.length}\\)`));
  assert.match(whole.stdout, /Every file under `src\/` is loaded by some test\./);
  assert.match(whole.stdout, new RegExp(`\\| \`${files[0]!.replace(/[.]/g, '\\.')}\` \\| 2: \`neverCalled\`, \`alsoNever\` \\|`));

  const [left, ...rest] = files;
  await writeFile(lcov, rest.map((file) => record(file)).join('\n'));
  const missing = spawnSync(process.execPath, [SCRIPT, lcov], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(missing.status, 1, 'a file nothing loads fails the job');
  assert.match(missing.stdout, new RegExp(`Never loaded by any test:\\*\\* \`${left!.replace(/[.]/g, '\\.')}\``));
});
