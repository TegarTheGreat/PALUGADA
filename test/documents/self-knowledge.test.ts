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
  const paths = [...text.matchAll(/`((?:src|test|console|db|docs|scripts|deploy|\.github)\/[^`\s]*|\.env\.example|AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md)`/g)]
    .map((match) => match[1]!.replace(/\/$/, ''));
  assert.ok(paths.length >= 15, `only ${paths.length} paths were found; the scan is broken`);
  const missing: string[] = [];
  for (const path of new Set(paths)) if (!(await exists(path))) missing.push(path);
  assert.deepEqual(missing, [], 'AGENTS.md names paths that are not there');
});

test('"npm run check" is the whole definition of done', async () => {
  // The guide says one command decides whether a change is finished. That is
  // only true if the command runs everything CI does before the tests.
  const check = (await scripts()).check ?? '';
  for (const step of ['npm run typecheck', 'npm run console:build', 'npm test']) {
    assert.ok(check.includes(step), `npm run check does not run ${step}`);
  }
  const ci = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const step of ['npm run typecheck', 'npm run console:build', 'npm test']) {
    assert.ok(ci.includes(`run: ${step}`), `CI does not run ${step}, so "check" and CI disagree`);
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
