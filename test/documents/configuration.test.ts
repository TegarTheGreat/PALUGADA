/**
 * Every setting the code reads is written down (docs/configuration.md).
 *
 * An operator learns what a deployment can be told from one page, and the
 * page is only worth reading while it is whole: a variable the code reads and
 * the page never names is a setting nobody finds without reading the source.
 * The final review of the people's workspace found one such variable
 * (`PALUGADA_CONSOLE_ORIGIN`, the origin the console answers cross-origin
 * requests from), and reading for the rest found some forty more, most of
 * them written on the page only as a suffix of another name (STATUS 2.219).
 * So this reads `src/` and `scripts/` for every variable taken from the
 * environment and fails on the first the page does not name in full.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Names the code takes from an environment that are not the operator's to
 * set, each with why. Anything else read from the environment is a setting.
 */
const NOT_SETTINGS: Record<string, string> = {
  PALUGADA_MCP_TOKEN: 'PALUGADA writes it into an agent CLI\'s own environment for one run, and the CLI reads it',
  SANDBOX_INPUT_JSON: 'PALUGADA writes it for the sandbox process it starts, which reads its input from it',
  PALUGADA_COMPUTE_CHECK_SECRET: 'planted by `npm run compute:check` to prove a role\'s code cannot read it',
  PALUGADA_CONTAINER_CHECK_SECRET: 'planted by the container check to prove a runtime cannot read it',
};

async function sources(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (/\.(?:ts|mts|sh)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every variable a file takes from the environment, by the forms the code reads them in. */
function readIn(text: string, shell: boolean): string[] {
  const names: string[] = [];
  // `process.env.NAME`, and `env.NAME` on the environment a function was handed.
  for (const match of text.matchAll(/(?:process\.env|\benv|\bbaseEnv)\??\.([A-Z][A-Z0-9_]*)\b/g)) names.push(match[1]!);
  for (const match of text.matchAll(/(?:process\.env|\benv|\bbaseEnv)\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) names.push(match[1]!);
  // A name handed as a string to a helper that reads it (`read('PALUGADA_…')`,
  // the console's settings laid over the environment, the docker client's list).
  for (const match of text.matchAll(/['"]((?:PALUGADA|OTEL|DOCKER)_[A-Z0-9_]*[A-Z0-9])['"]/g)) names.push(match[1]!);
  if (shell) for (const match of text.matchAll(/\b(PALUGADA_[A-Z0-9_]*[A-Z0-9])\b/g)) names.push(match[1]!);
  return names;
}

test('every variable the code reads from the environment is named in docs/configuration.md', async () => {
  const page = await readFile(join(ROOT, 'docs', 'configuration.md'), 'utf8');
  const read = new Map<string, string>();
  for (const file of [...await sources(join(ROOT, 'src')), ...await sources(join(ROOT, 'scripts'))]) {
    const text = await readFile(file, 'utf8');
    for (const name of readIn(text, file.endsWith('.sh'))) if (!read.has(name)) read.set(name, relative(ROOT, file));
  }
  assert.ok(read.size >= 100, `only ${read.size} variables were found; the scan is broken`);
  for (const name of Object.keys(NOT_SETTINGS)) assert.ok(read.has(name), `${name} is listed as not a setting and nothing reads it`);
  // In full: a row that says `PALUGADA_TELEGRAM_TOKEN`, `_CHAT` names one
  // variable for a reader who searches the page for the other.
  const missing = [...read]
    .filter(([name]) => !(name in NOT_SETTINGS) && !new RegExp(`\\b${name}\\b`).test(page))
    .map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, [], 'read from the environment and not named in docs/configuration.md');
});
