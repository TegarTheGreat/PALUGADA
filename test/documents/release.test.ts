/**
 * Releases (scripts/release.ts, .github/workflows/release.yml; the analysis
 * of 3 October, §9 P2 item 21: "tagged releases and a merge queue").
 *
 * A version is three things that must agree: package.json, which the running
 * platform reports (src/version.ts); the CHANGELOG's section, which says
 * what it holds; and the tag a release is cut from. These hold them to each
 * other, the script that moves them together, and the workflows that build
 * a release and let a merge queue test what main is about to become.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, changelogSections, prepareRelease, releaseNotes, tagRelease } from '../../scripts/release.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'palugada-release-'));
  for (const file of ['CHANGELOG.md', 'package.json', 'package-lock.json']) cpSync(join(ROOT, file), join(dir, file));
  return dir;
}

test('package.json\'s version is the CHANGELOG\'s newest section, and every section is a version in order', () => {
  const sections = changelogSections(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
  assert.ok(sections.length > 0, 'CHANGELOG.md has a section for each version');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.equal(sections[0]!.version, pkg.version, 'what is running says the version the CHANGELOG describes');
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
  assert.deepEqual([lock.version, lock.packages['']?.version], [pkg.version, pkg.version], 'and the lockfile agrees');
  // Only the newest may be unreleased, and a released one has a date.
  assert.ok(sections.slice(1).every((one) => one.date !== null), 'only the newest section may be unreleased');
  for (let i = 1; i < sections.length; i += 1) {
    const [newer, older] = [sections[i - 1]!, sections[i]!];
    assert.ok(newer.version.localeCompare(older.version, undefined, { numeric: true }) > 0, `${newer.version} comes after ${older.version}`);
  }
});

test('preparing a release dates its section and moves both versions; checking a tag holds all three together', () => {
  const dir = copy();
  const unreleased = changelogSections(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'))[0]!;
  // What is in CHANGELOG.md now is unreleased; a check of its tag says why it is not a release yet.
  if (unreleased.date === null) {
    assert.throws(() => checkRelease(dir, `v${unreleased.version}`), /not yet released/);
  }
  assert.throws(() => prepareRelease(dir, '1.0', { date: '2026-10-03', git: false }), /a version is three numbers/);

  prepareRelease(dir, '0.2.0', { date: '2026-10-03', git: false });
  const [released] = changelogSections(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'));
  assert.deepEqual([released!.version, released!.date], ['0.2.0', '2026-10-03']);
  assert.equal((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version, '0.2.0');
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
  assert.deepEqual([lock.version, lock.packages['']?.version], ['0.2.0', '0.2.0']);
  assert.doesNotThrow(() => checkRelease(dir, 'v0.2.0'));
  assert.throws(() => checkRelease(dir, 'v0.2.1'), /the tag says 0\.2\.1 and package\.json 0\.2\.0/);
  assert.throws(() => prepareRelease(dir, '0.2.1', { date: '2026-10-04', git: false }), /nothing unreleased/);

  // The notes are the section's own words, without its heading.
  const notes = releaseNotes(dir, '0.2.0');
  assert.ok(notes.length > 100 && !notes.startsWith('## '), notes.slice(0, 80));
  assert.equal(notes, released!.body.trim());

  // A version older than the last release is refused.
  const later = join(dir, 'CHANGELOG.md');
  writeFileSync(later, readFileSync(later, 'utf8').replace('## 0.2.0 (2026-10-03)', '## 0.1.9 (not yet released)\n\n- Something.\n\n## 0.2.0 (2026-10-03)'));
  assert.throws(() => prepareRelease(dir, '0.1.9', { date: '2026-10-05', git: false }), /0\.1\.9 is not after 0\.2\.0/);
});

test('a release is a commit that reaches main like any other, and the tag is made on main afterwards', () => {
  const dir = copy();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  // Whatever this machine's git is set to sign with, this repository signs nothing.
  for (const [key, value] of [['user.name', 'Release Test'], ['user.email', 'release@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
    git('config', key!, value!);
  }
  git('add', '.');
  git('commit', '-q', '-m', 'Before the release');

  writeFileSync(join(dir, 'notes.txt'), 'not committed');
  assert.throws(() => prepareRelease(dir, '0.2.0', { date: '2026-10-03' }), /not committed/);
  git('add', 'notes.txt');
  git('commit', '-q', '-m', 'Notes');

  prepareRelease(dir, '0.2.0', { date: '2026-10-03' });
  assert.equal(git('log', '-1', '--format=%s'), 'Release 0.2.0');
  assert.equal(git('status', '--porcelain'), '', 'everything it changed is in the commit');
  // No tag yet: through a merge queue the commit main holds is another one.
  assert.equal(git('tag', '--list'), '');

  writeFileSync(join(dir, 'notes.txt'), 'changed again');
  assert.throws(() => tagRelease(dir, '0.2.0'), /not committed/);
  git('checkout', '-q', '--', 'notes.txt');
  assert.throws(() => tagRelease(dir, '0.2.1'), /the tag says 0\.2\.1 and package\.json 0\.2\.0/);
  assert.equal(git('tag', '--list'), '', 'a refused tag leaves none behind');

  tagRelease(dir, '0.2.0');
  assert.equal(git('tag', '--list'), 'v0.2.0');
  assert.equal(git('cat-file', '-t', 'v0.2.0'), 'tag', 'annotated, so it carries who made it and when');
  assert.equal(git('rev-parse', 'v0.2.0^{commit}'), git('rev-parse', 'HEAD'));
});

test('a tag is built into a release from what CI passed, and a merge queue runs CI on what main would become', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^ {2}merge_group:/m, 'CI runs for a merge queue\'s candidate');
  assert.match(ci, /^ {2}workflow_call:/m, 'and can be called by the release');
  // The queue's own branches are tested as merge_group; as pushes too, every candidate would run twice.
  assert.match(ci, /branches: \['\*\*', '!gh-readonly-queue\/\*\*'\]/);
  const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /tags: \['v\*'\]/, 'a release starts from a tag');
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/, 'and passes the whole of CI first');
  assert.match(release, /node scripts\/release\.ts check "\$GITHUB_REF_NAME"/, 'its tag, package.json and CHANGELOG agree');
  assert.match(release, /merge-base --is-ancestor HEAD origin\/main/, 'and it was cut from main');
  assert.match(release, /gh release create/);
  assert.match(release, /ghcr\.io/, 'with the image published beside it');
  // Every action pinned to a commit, as in CI.
  for (const file of [ci, release]) {
    for (const match of file.matchAll(/^\s*-?\s*uses: ([^\s#]+)/gm)) {
      if (match[1]!.startsWith('./')) continue;
      assert.match(match[1]!, /@[0-9a-f]{40}$/, `${match[1]} is pinned to a commit`);
    }
  }
});
