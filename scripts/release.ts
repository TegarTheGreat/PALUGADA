/**
 * Releases (the analysis of 3 October, §9 P2 item 21: "tagged releases").
 *
 * A version is three things that must agree: package.json, which the
 * running platform reports (`src/version.ts`, `/api/health`); the CHANGELOG's
 * section, which says what it holds; and the tag it is built from. This moves
 * them together, and the release workflow checks them before it builds:
 *
 *   node scripts/release.ts prepare <version> [--date YYYY-MM-DD]
 *     Dates the CHANGELOG's unreleased section as <version>, sets package.json
 *     and package-lock.json to it, and commits "Release <version>" -- on a
 *     branch, to reach main through a pull request like any other change.
 *   node scripts/release.ts tag <version>
 *     Once that commit is on main: makes the annotated tag v<version> on the
 *     commit checked out, refusing unless it is clean and agrees. Pushing the
 *     tag is left to whoever runs it: `git push origin v<version>`.
 *   node scripts/release.ts check <tag>
 *     Fails unless the tag, package.json, the lockfile and a dated CHANGELOG
 *     section all name the same version.
 *   node scripts/release.ts notes <version>
 *     Prints that version's section, as the release's notes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Section {
  version: string;
  /** Null while it is not yet released. */
  date: string | null;
  /** Everything under the heading, up to the next version's. */
  body: string;
}

const HEADING = /^## (\d+\.\d+\.\d+) \((not yet released|\d{4}-\d{2}-\d{2})\)$/;

/** The CHANGELOG's versions, newest first. A `## ` heading that is not one is refused, by its text. */
export function changelogSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const match = HEADING.exec(line.trim());
      if (!match) throw new Error(`CHANGELOG.md: "${line.trim()}" is not "## <version> (<YYYY-MM-DD> or not yet released)"`);
      current = { version: match[1]!, date: match[2] === 'not yet released' ? null : match[2]!, body: '' };
      sections.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return sections;
}

function newer(a: string, b: string): boolean {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

function read(root: string): { changelog: string; pkg: { version: string }; lock: { version: string; packages: Record<string, { version?: string }> } } {
  return {
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string },
    lock: JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> },
  };
}

/** Sets a JSON file's `"version"` fields by text, so the rest of the file -- its order, its spacing -- is as it was. */
function setVersion(path: string, from: string, to: string, count: number): void {
  const text = readFileSync(path, 'utf8');
  let left = count;
  const changed = text.replace(new RegExp(`("version": )"${from.replace(/\./g, '\\.')}"`, 'g'), (whole, key: string) => {
    if (left === 0) return whole;
    left -= 1;
    return `${key}"${to}"`;
  });
  if (left !== 0) throw new Error(`${path}: expected ${count} "version": "${from}", found ${count - left}`);
  writeFileSync(path, changed);
}

export function prepareRelease(root: string, version: string, options: { date?: string; git?: boolean } = {}): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`a version is three numbers, as 0.2.0; got ${version}`);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`a date is YYYY-MM-DD; got ${date}`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  if (options.git !== false && git('status', '--porcelain').trim()) {
    throw new Error('the working tree has changes that are not committed; a release is cut from a commit');
  }
  const { changelog, pkg } = read(root);
  const sections = changelogSections(changelog);
  const top = sections[0];
  if (!top || top.date !== null) throw new Error('CHANGELOG.md has nothing unreleased: its newest section already has a date');
  const last = sections.find((one) => one.date !== null);
  if (last && !newer(version, last.version)) throw new Error(`${version} is not after ${last.version}, the last release`);
  writeFileSync(join(root, 'CHANGELOG.md'),
    changelog.replace(`## ${top.version} (not yet released)`, `## ${version} (${date})`));
  setVersion(join(root, 'package.json'), pkg.version, version, 1);
  // The lockfile names the project's version twice: at its top, and as its own package.
  setVersion(join(root, 'package-lock.json'), pkg.version, version, 2);
  if (options.git !== false) {
    git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
    git('commit', '-m', `Release ${version}`);
  }
}

/**
 * Tags the commit checked out as v<version>. Separate from preparing, because
 * the tag must be on the commit main holds: a pull request merged through a
 * queue lands as a new commit, and a tag made on the branch before it would
 * name one main never had -- which the release workflow refuses.
 */
export function tagRelease(root: string, version: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git('status', '--porcelain').trim()) {
    throw new Error('the working tree has changes that are not committed; a tag names a commit, not what is on disk');
  }
  checkRelease(root, `v${version}`);
  git('tag', '-a', `v${version}`, '-m', `PALUGADA ${version}`);
}

export function checkRelease(root: string, tag: string): void {
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version) throw new Error(`a release's tag is v and a version, as v0.2.0; got ${tag}`);
  const { changelog, pkg, lock } = read(root);
  if (pkg.version !== version) throw new Error(`the tag says ${version} and package.json ${pkg.version}`);
  if (lock.version !== version || lock.packages['']?.version !== version) throw new Error(`package-lock.json does not say ${version}`);
  const section = changelogSections(changelog).find((one) => one.version === version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`);
  if (section.date === null) throw new Error(`CHANGELOG.md has ${version} as not yet released: run node scripts/release.ts prepare ${version}`);
}

export function releaseNotes(root: string, version: string): string {
  const section = changelogSections(read(root).changelog).find((one) => one.version === version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return section.body.trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, value] = process.argv.slice(2);
  try {
    if (command === 'prepare' && value) {
      const at = process.argv.indexOf('--date');
      prepareRelease(root, value, at > 0 ? { date: process.argv[at + 1]! } : {});
      console.log(`Committed "Release ${value}". Merge it to main, then on main: node scripts/release.ts tag ${value}`);
    } else if (command === 'tag' && value) {
      tagRelease(root, value);
      console.log(`Tagged v${value}. Push the tag to release it: git push origin v${value}`);
    } else if (command === 'check' && value) {
      checkRelease(root, value);
      console.log(`${value} agrees with package.json, package-lock.json and CHANGELOG.md`);
    } else if (command === 'notes' && value) {
      console.log(releaseNotes(root, value));
    } else {
      console.error('usage: node scripts/release.ts prepare <version> [--date YYYY-MM-DD] | tag <version> | check <tag> | notes <version>');
      process.exitCode = 2;
    }
  } catch (failure) {
    console.error((failure as Error).message);
    process.exitCode = 1;
  }
}
