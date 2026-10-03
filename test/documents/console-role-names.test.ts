/**
 * A role is shown by its name and title, never by its code (the analysis of
 * 3 October, §2.3 items 7 and 10).
 *
 * The owner met "coordinator", "strategist" and "critic" -- the platform's
 * short names for roles -- on the work list, the task, the schedules, the
 * triggers, the frozen roles, the standing approvals and the trace, and chose
 * roles from pickers that listed "strategist" beside "Arka · CEO". Every
 * view a role appears in carries its name (acceptance/role-names.test.ts);
 * this reads the console for a role code put on the screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE = fileURLToPath(new URL('../../console/src', import.meta.url));

/** What puts a role's code on the screen, each with what it looks like. */
const SHOWN_AS_CODE: Array<[RegExp, string]> = [
  [/\{[\w?.]+\.(\w+R|r)oleSlug\}/, 'a role code as text'],
  [/\brole: [\w?.]+\.(\w+R|r)oleSlug\b/, 'a role code in a sentence'],
  [/\{(role|ceo)\??\.slug\}/, 'a role code as text'],
  [/\brole: role\??\.slug\b/, 'a role code in a sentence'],
  [/\blabel: [^\n]*\b(role|one)\.slug\b/, 'a role code in a picker'],
];

test('the console shows no role by its code', async () => {
  const offenders: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'locales') await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const [pattern, what] of SHOWN_AS_CODE) {
          if (pattern.test(line)) offenders.push(`${path.slice(CONSOLE.length + 1)}:${index + 1} ${what}: ${line.trim()}`);
        }
      });
    }
  };
  await walk(CONSOLE);
  assert.deepEqual(offenders, [], `roles shown by their code:\n${offenders.join('\n')}`);
});

test('a company is listed by its name, not its code', async () => {
  const money = await readFile(join(CONSOLE, 'pages', 'Money.tsx'), 'utf8');
  assert.doesNotMatch(money, /(?<!key=)\{row\.slug\}/, 'every company on the money page by its short name');
});
