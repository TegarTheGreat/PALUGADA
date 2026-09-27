/**
 * What the suite reaches, from the lcov file `npm run test:coverage` writes.
 *
 * Reported rather than held to a number: lines are near complete because V8
 * counts a comment as covered and this code is mostly comment, so the
 * figures that say something are functions and branches, and the list of the
 * files with the most never called. One thing does fail: a file under `src/`
 * that no test so much as loads -- code nothing exercises at all, which is
 * how a module ends up shipped and never run. In CI the report is also the
 * job's summary.
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lcov = process.argv[2] ?? join(root, 'coverage', 'lcov.info');

interface Counts { lines: [number, number]; functions: [number, number]; branches: [number, number]; uncalled: string[] }
const files = new Map<string, Counts>();
let current: Counts | null = null;
for (const line of readFileSync(lcov, 'utf8').split('\n')) {
  const [key, value = ''] = line.split(/:(.*)/s);
  if (key === 'SF') {
    current = { lines: [0, 0], functions: [0, 0], branches: [0, 0], uncalled: [] };
    files.set(relative(root, join(root, value)), current);
  } else if (current) {
    if (key === 'LF') current.lines[1] = Number(value);
    if (key === 'LH') current.lines[0] = Number(value);
    if (key === 'FNF') current.functions[1] = Number(value);
    if (key === 'FNH') current.functions[0] = Number(value);
    if (key === 'BRF') current.branches[1] = Number(value);
    if (key === 'BRH') current.branches[0] = Number(value);
    // FNDA:<calls>,<name>
    if (key === 'FNDA' && value.startsWith('0,')) current.uncalled.push(value.slice(2));
  }
}

const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sources(join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [relative(root, join(directory, entry.name))] : []);
const unloaded = sources(join(root, 'src')).filter((file) => !files.has(file)).sort();

const total = (pick: (counts: Counts) => [number, number]) => {
  let hit = 0;
  let found = 0;
  for (const counts of files.values()) {
    hit += pick(counts)[0];
    found += pick(counts)[1];
  }
  return `${found === 0 ? '100.0' : (100 * hit / found).toFixed(1)}% (${hit} of ${found})`;
};
const worst = [...files.entries()]
  .filter(([file, counts]) => file.startsWith('src/') && counts.uncalled.length > 0)
  .sort((a, b) => b[1].uncalled.length - a[1].uncalled.length || a[0].localeCompare(b[0]))
  .slice(0, 15);

const report = [
  '## Coverage',
  '',
  `${files.size} files loaded. Functions ${total((counts) => counts.functions)}, branches ${total((counts) => counts.branches)}, lines ${total((counts) => counts.lines)} (lines count comments).`,
  '',
  unloaded.length === 0 ? 'Every file under `src/` is loaded by some test.'
    : `**Never loaded by any test:** ${unloaded.map((file) => `\`${file}\``).join(', ')}`,
  '',
  'Most functions never called:',
  '',
  '| File | Never called |',
  '|---|---|',
  ...worst.map(([file, counts]) => `| \`${file}\` | ${counts.uncalled.length}: ${counts.uncalled.slice(0, 6).map((name) => `\`${name}\``).join(', ')}${counts.uncalled.length > 6 ? ', …' : ''} |`),
  '',
].join('\n');

process.stdout.write(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
if (unloaded.length > 0) process.exit(1);
