/**
 * What PALUGADA knows about itself is true (AGENTS.md).
 *
 * The owner asked for PALUGADA to be able to develop PALUGADA, and for anyone
 * improving it to know the flow without having to ask. Both depend on one
 * document -- `AGENTS.md`, which coding agents read by convention, which
 * `CLAUDE.md` points to, which `CONTRIBUTING.md` sends people to, and which the
 * `palugada-dev` bundle's skill tells the platform's own engineer to read
 * first. A guide like that is only worth following while it is right, and a
 * guide nobody checks goes wrong one renamed script at a time. So this reads
 * it for every command, path and file it names, and fails on the first that
 * does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_BUNDLES, PALUGADA_DEV } from '../../src/bundles/builtin.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function exists(path: string): Promise<boolean> {
  return access(join(ROOT, path)).then(() => true, () => false);
}

async function scripts(): Promise<Record<string, string>> {
  return (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
}

test('every command the guides name is a script this repository has', async () => {
  const known = await scripts();
  for (const guide of ['AGENTS.md', 'CONTRIBUTING.md']) {
    const text = await readFile(join(ROOT, guide), 'utf8');
    const named = [...text.matchAll(/npm run ([a-z:-]+)/g)].map((match) => match[1]!);
    assert.ok(named.length >= 4, `${guide} names only ${named.length} commands; the scan is broken`);
    for (const name of named) assert.ok(name in known, `${guide} tells you to run "npm run ${name}", which does not exist`);
  }
});

test('every path the guide names exists', async () => {
  const text = await readFile(join(ROOT, 'AGENTS.md'), 'utf8');
  const paths = [...text.matchAll(/`((?:src|test|console|db|docs|scripts|deploy|brand|\.github)\/[^`\s]*|\.env\.example|AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md)`/g)]
    .map((match) => match[1]!.replace(/\/$/, ''));
  assert.ok(paths.length >= 15, `only ${paths.length} paths were found; the scan is broken`);
  const missing: string[] = [];
  for (const path of new Set(paths)) if (!(await exists(path))) missing.push(path);
  assert.deepEqual(missing, [], 'AGENTS.md names paths that are not there');
});

test('every rule the suite enforces names the test that holds it', async () => {
  // The section opens "Each of these is a test". A rule with no test named
  // beside it is a rule nobody can check is still held, and the final review
  // of the people's workspace found five such (STATUS 2.219). A rule may name
  // a helper every test runs through (`test/helpers/setup.ts`), which holds
  // it in every file.
  const text = await readFile(join(ROOT, 'AGENTS.md'), 'utf8');
  const section = text.split('## Rules the suite enforces')[1]?.split('\n## ')[0] ?? '';
  const rules = section.split(/\n(?=- \*\*)/).filter((part) => part.startsWith('- **'));
  assert.ok(rules.length >= 20, `only ${rules.length} rules were found; the scan is broken`);
  const untested = rules
    .filter((rule) => !/`test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts`|`test\/helpers\/[\w.-]+\.ts`/.test(rule))
    .map((rule) => /^- \*\*([^*]+)\*\*/.exec(rule)?.[1] ?? rule.slice(0, 60));
  assert.deepEqual(untested, [], 'AGENTS.md states a rule the suite enforces without naming the test');
});

test('no comment cites the design the people\'s workspace was built from', async () => {
  // The workspace was designed in a document kept outside the repository, in
  // parts built by separate sets of changes. Comments that cite that document,
  // its numbered rules or its sets send a reader to something they cannot
  // open; a comment states the rule itself, with its PRD id (F19.x) or the
  // STATUS section that records it (STATUS 2.202 says what the document was).
  const cited = [
    /workspace plan/i,
    /\binvariants? I\d{1,2}\b/,
    /[(;,] ?I\d{1,2}\)/,
    /\b(?:a|the|each) (?:later )?set (?:that|adds|makes|builds|first|strikes)\b/,
    /\ba later set\b|\bthe sets that\b|\bfor each set named\b/,
  ];
  const self = fileURLToPath(import.meta.url);
  const found: string[] = [];
  async function read(directory: string): Promise<void> {
    for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') await read(path); continue; }
      if (!/\.(?:ts|tsx|mts|sql|sh)$/.test(entry.name) || join(ROOT, path) === self) continue;
      (await readFile(join(ROOT, path), 'utf8')).split('\n').forEach((line, index) => {
        if (cited.some((phrase) => phrase.test(line))) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  for (const directory of ['src', 'console/src', 'test', 'scripts', 'db']) await read(directory);
  assert.deepEqual(found, [], 'cites a document the repository does not hold');
});

test('"npm run check" is the whole definition of done', async () => {
  // The guide says one command decides whether a change is finished. That is
  // only true if the command runs everything CI does before the tests.
  const check = (await scripts()).check ?? '';
  for (const step of ['npm run typecheck', 'npm run console:build', 'npm test']) {
    assert.ok(check.includes(step), `npm run check does not run ${step}`);
  }
  const ci = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const step of ['npm run typecheck', 'npm run console:build']) {
    assert.ok(ci.includes(`run: ${step}`), `CI does not run ${step}, so "check" and CI disagree`);
  }
  // CI runs the suite with coverage: the same files, one at a time, or the
  // two would be passing different suites.
  const all = await scripts();
  assert.ok(ci.includes('run: npm test') || ci.includes('run: npm run test:coverage'), 'CI does not run the suite');
  if (ci.includes('run: npm run test:coverage')) {
    const suite = (command: string) => [/--test-concurrency=1/.test(command), /"test\/\*\*\/\*\.test\.ts"/.test(command)];
    assert.deepEqual(suite(all['test:coverage'] ?? ''), suite(all.test ?? ''), 'test:coverage runs another suite than npm test');
    assert.deepEqual(suite(all.test ?? ''), [true, true]);
  }
});

test('every coding agent is sent to the same guide', async () => {
  // Claude Code reads CLAUDE.md, most others read AGENTS.md; a second copy
  // would be a second document to keep true, so CLAUDE.md only points.
  const claude = await readFile(join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /@AGENTS\.md/);
  assert.ok(claude.split('\n').length < 20, 'CLAUDE.md should point to AGENTS.md, not repeat it');
  const contributing = await readFile(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /AGENTS\.md/);
});

test('migrations are numbered once each, with no gaps', async () => {
  // "Append-only" is a rule about history the suite cannot see; what it can
  // see is that nobody renumbered, reused or skipped one.
  const files = (await readdir(join(ROOT, 'db', 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
  files.forEach((name, index) => {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/, `${name} is not named NNNN_what_it_does.sql`);
    assert.equal(Number(name.slice(0, 4)), index + 1, `${name} is out of sequence`);
  });
});

test('PALUGADA can develop PALUGADA, and only by pull request', () => {
  assert.ok(BUILT_IN_BUNDLES.includes(PALUGADA_DEV), 'the self-development bundle is not shipped');
  const { body } = PALUGADA_DEV;

  // The engineer is sent to the guide this file keeps true.
  const engineer = body.roles.find((role) => role.slug === 'platform-engineer')!;
  assert.match(engineer.systemPrompt, /AGENTS\.md/);
  assert.match(engineer.systemPrompt, /npm run check/);
  const skill = body.skills.find((one) => one.division === 'platform')!;
  assert.match(skill.source, /AGENTS\.md/);

  // It can read and push a branch. Nothing it holds merges or deploys: the
  // main branch is the owner's, on the pull request.
  const granted = body.grants.filter((grant) => grant.division === 'platform').map((grant) => grant.capability).sort();
  assert.deepEqual(granted, ['memory.search', 'repo.branch', 'repo.read', 'skill.read']);

  // Every push waits for a reviewer that exists in the bundle and holds
  // nothing that writes.
  const policy = body.policies.find((one) => JSON.stringify(one.condition).includes('repo.branch'))!;
  assert.equal(policy.effect, 'require_review');
  const reviewer = body.roles.find((role) => role.slug === (policy.params as { reviewer_role: string }).reviewer_role)!;
  assert.ok(reviewer, 'the review policy names a reviewer the bundle does not have');
  assert.ok(body.grants.filter((grant) => grant.division === reviewer.division).every((grant) => grant.capability !== 'repo.branch'));
  assert.ok(body.hooks.some((hook) => hook.division === reviewer.division && hook.refuseAtOrAboveTier === 1));
});

/**
 * Which version is running is said on the health page, in the metrics and
 * in the console, and a version is only worth saying if what it holds is
 * written down: the one package.json names has its section in CHANGELOG.md.
 */
test('the version package.json names has its section in CHANGELOG.md', async () => {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, new RegExp(`^## ${version.replace(/\./g, '\\.')}( |$)`, 'm'));
});
