/**
 * The deployment's charters, kept as files in a git repository (PRD v2
 * F3.11): "Charter disimpan sebagai `SOUL.md` per company dan `PLATFORM.md`
 * di repo git internal; UI mengedit file, bukan sebaliknya."
 *
 * `charter-files.ts` reads and writes the files. This keeps them: one
 * repository beside the deployment's state (`PALUGADA_CHARTERS_DIR`, or
 * `charters` in `PALUGADA_STATE_DIR`), brought level with the database at
 * boot, after every charter the owner changes in the console, and on the
 * worker's tick. Both ways:
 *
 *   - A file edited in the repository -- by hand, by a pull, by an editor --
 *     is taken in as the charter's next version. That is the direction the
 *     requirement names, and the file's history is git's.
 *   - A charter published anywhere else -- the console, a template, a
 *     restore -- is written to its file and committed, so the repository
 *     never falls behind what runs.
 *
 * Which of the two a difference is, is decided by what each file held when
 * PALUGADA last brought it level, kept beside them (`.palugada-written.json`,
 * ignored by git): a file that still holds that is the database's to change,
 * and one that holds anything else was changed by somebody. Without that, a
 * file left from an earlier database -- a restored backup, a reinstall --
 * would quietly overwrite the charter the owner has now.
 *
 * The directory is written to by whoever can push to it, so nothing in it is
 * trusted further than a charter the owner types (the review of 645c40e):
 *
 *   - A link is never followed, either way. Followed on read, a `SOUL.md`
 *     pointing at the master key would publish the key as a charter, into
 *     every run's context; followed on write, the next charter the owner
 *     saved would overwrite the key.
 *   - The repository is its own. A directory inside another repository --
 *     an operator's dotfiles, an infrastructure checkout -- is made a
 *     repository of its own, so a commit never takes in what lies beside it.
 *   - A merge, a rebase or a cherry-pick in progress holds everything, and a
 *     file with conflict markers is not a charter: taken, it would be the
 *     next version, and committed, it would conclude the merge with them.
 *   - A file is held to what the console holds a charter to, and a version
 *     taken from one is the repository's, not the owner's: the history says
 *     who wrote the words.
 *   - Each file is brought level on its own, and what was done is recorded
 *     as it is done. One file that cannot be read or written is reported and
 *     left; it does not stop the rest, and it cannot leave the record behind
 *     the files, which would make the next save look like an edit to undo.
 *
 * git is the deployment's history of its charters, not a condition of
 * having them. Without the binary the files are still written and read, and
 * the report says so; a commit that fails never fails a charter.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { withControlPlane } from '../db/tenant.ts';
import { CHARTER_LIMIT, publishCharter } from './store.ts';
import { COMPANY_CHARTER_FILE, PLATFORM_CHARTER_FILE } from './charter-files.ts';

const run = promisify(execFile);

/** What each file held when PALUGADA last brought it level, by its path inside the repository. */
const WRITTEN = '.palugada-written.json';

/** What git leaves in its directory while an operation waits on somebody, and what to call it. */
const MIDWAY: Array<[string, string]> = [
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
];

export interface CharterSync {
  /** Files written from the database: a charter published elsewhere. */
  written: string[];
  /** Files taken in as a charter's next version: edited in the repository. */
  taken: Array<{ path: string; version: number }>;
  /** Directories for companies this deployment does not have, left alone. */
  unknown: string[];
  /** Files that could not be brought level, and why. Each is tried again on the next sync. */
  refused: Array<{ path: string; reason: string }>;
  /**
   * Whether the changes were committed, and if not, why. `held` is a merge
   * or a rebase in the repository: nothing was read, written or committed.
   */
  git: 'committed' | 'nothing to commit' | 'not available' | `failed: ${string}` | `held: ${string}`;
}

/** A file that is not a charter, said in words the operator acts on. */
class Refusal extends Error {}

export class CharterRepository {
  readonly root: string;
  readonly #git: string | null;
  #syncing: Promise<CharterSync> | null = null;

  /** `git: null` keeps the files without a repository, as a machine with no git does. */
  constructor(options: { root: string; git?: string | null }) {
    this.root = options.root;
    this.#git = options.git === undefined ? 'git' : options.git;
  }

  /**
   * Brings the files and the database level. One at a time: the console's
   * change and the worker's tick arriving together sync once, then again.
   */
  async sync(): Promise<CharterSync> {
    while (this.#syncing) await this.#syncing.catch(() => undefined);
    this.#syncing = this.#sync();
    try {
      return await this.#syncing;
    } finally {
      this.#syncing = null;
    }
  }

  /** A sync in progress, finished: what a process that is stopping waits for. */
  async settled(): Promise<void> {
    while (this.#syncing) await this.#syncing.catch(() => undefined);
  }

  async #sync(): Promise<CharterSync> {
    await mkdir(join(this.root, 'companies'), { recursive: true });
    const report: CharterSync = { written: [], taken: [], unknown: [], refused: [], git: 'nothing to commit' };
    // A repository that cannot be made or used leaves the files kept
    // without their history, as a machine with no git does, and says why.
    const git = await this.#ready();
    const midway = git === null ? await this.#midway() : null;
    if (midway) {
      return { ...report, git: `held: ${midway} is in progress in ${this.root}; finish it, and the next sync takes the result` };
    }

    const written = await this.#readWritten();
    const messages: string[] = [];
    const { companies, current } = await withControlPlane(async (tx) => {
      const { rows: companies } = await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM companies ORDER BY slug');
      const { rows: current } = await tx.query<{ company_id: string | null; version: number; body: string }>(
        `SELECT DISTINCT ON (company_id) company_id, version, body
           FROM charters ORDER BY company_id, version DESC`);
      return { companies, current };
    });
    const latest = new Map(current.map((row) => [row.company_id, row]));
    const scopes: Array<{ companyId: string | null; name: string; path: string }> = [
      { companyId: null, name: 'the platform', path: PLATFORM_CHARTER_FILE },
      ...companies.map((company) => ({
        companyId: company.id, name: company.slug, path: join('companies', company.slug, COMPANY_CHARTER_FILE),
      })),
    ];

    for (const scope of scopes) {
      try {
        const done = await this.#level(scope, latest.get(scope.companyId) ?? null, written);
        if (done === null) continue;
        if (done.kind === 'taken') {
          report.taken.push({ path: scope.path, version: done.version });
          messages.push(`Charter v${done.version} for ${scope.name}, from the file`);
        } else if (done.kind === 'written') {
          report.written.push(scope.path);
          messages.push(`Charter v${done.version} for ${scope.name}`);
        }
        // Recorded as each file is done: a later one that fails must not
        // leave this one looking edited on the next sync.
        await this.#saveWritten(written);
      } catch (error) {
        report.refused.push({ path: scope.path, reason: oneLine(error) });
      }
    }

    // A directory for a company this deployment does not have is not
    // authorisation to create one; it is said and left. What its file holds
    // is recorded as seen, so a company made later under that name starts
    // from its own charter rather than from words it never had.
    const known = new Set(companies.map((company) => company.slug));
    let seen = false;
    for (const slug of await directories(join(this.root, 'companies'))) {
      if (known.has(slug)) continue;
      report.unknown.push(slug);
      const path = join('companies', slug, COMPANY_CHARTER_FILE);
      try {
        const onFile = await this.#read(path);
        if (onFile !== null && written[path] !== digest(onFile)) {
          written[path] = digest(onFile);
          seen = true;
        }
      } catch (error) {
        report.refused.push({ path, reason: oneLine(error) });
      }
    }
    if (seen) await this.#saveWritten(written);

    report.git = git ?? await this.#commit(messages);
    return report;
  }

  /** One file brought level with its charter: what was done, or null for nothing. */
  async #level(
    scope: { companyId: string | null; path: string },
    inDatabase: { version: number; body: string } | null,
    written: Record<string, string>,
  ): Promise<{ kind: 'taken' | 'written' | 'seen'; version: number } | null> {
    const onFile = await this.#read(scope.path);
    const ours = onFile !== null && written[scope.path] === digest(onFile);

    if (onFile !== null && !ours) {
      // Changed in the repository: its words are the next version.
      // A file that is not a charter is refused and left as it is, and
      // what it held before stays recorded: it is looked at again on the
      // next sync, and taken once somebody has put it right.
      const body = onFile.trim();
      if (body && body !== inDatabase?.body.trim()) {
        const problem = notACharter(body);
        if (problem) throw new Refusal(problem);
      }
      written[scope.path] = digest(onFile);
      if (!body || body === inDatabase?.body.trim()) return { kind: 'seen', version: inDatabase?.version ?? 0 };
      const published = await publishCharter({
        ...(scope.companyId === null ? {} : { companyId: scope.companyId }),
        body,
      }, 'repository');
      return { kind: 'taken', version: published.version };
    }
    // Ours, or not there: the database's charter is what it should hold.
    if (!inDatabase) return null;
    const text = withNewline(inDatabase.body);
    if (onFile === text) return null;
    await this.#write(scope.path, text);
    written[scope.path] = digest(text);
    return { kind: 'written', version: inDatabase.version };
  }

  /** A file's words, or null when there is none. A link, a directory or a device is refused, never followed. */
  async #read(path: string): Promise<string | null> {
    await this.#inside(path);
    const full = join(this.root, path);
    let stats;
    try {
      stats = await lstat(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Refusal('it is a link, and a link is never followed: put the charter itself there');
    if (!stats.isFile()) throw new Refusal('it is not a file: put the charter there as a file');
    // Measured before it is read: UTF-8 takes at most four bytes a character.
    if (stats.size > CHARTER_LIMIT * 4) {
      throw new Refusal(`it is ${stats.size} bytes, and a charter is at most ${CHARTER_LIMIT} characters`);
    }
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  async #write(path: string, text: string): Promise<void> {
    await this.#inside(path);
    await mkdir(dirname(join(this.root, path)), { recursive: true });
    await this.#inside(path);
    const handle = await open(join(this.root, path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Refuses a path whose directories lead out of the repository: a
   * `companies` or a company directory that is a link to somewhere else. The
   * nearest directory that exists is the one checked, so a link is found
   * before anything is made through it.
   */
  async #inside(path: string): Promise<void> {
    const root = await realpath(this.root);
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      let real: string;
      try {
        real = await realpath(join(this.root, directory));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory !== '.') continue;
        throw error;
      }
      if (real !== join(root, directory)) {
        throw new Refusal(`${directory} is a link out of the repository, and a link is never followed`);
      }
      return;
    }
  }

  /**
   * A repository of its own, made the first time: null when it is ready,
   * or what stands in the way. Only a directory that is its repository's
   * top level will do; inside another one, `git add --all` would take in
   * everything that repository holds.
   */
  async #ready(): Promise<CharterSync['git'] | null> {
    if (!this.#git) return 'not available';
    try {
      const { stdout } = await this.#run(['rev-parse', '--show-toplevel']);
      if (await realpath(stdout.trim()) === await realpath(this.root)) {
        await this.#ignoreWritten();
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not available';
    }
    try {
      await this.#run(['init', '--quiet']);
      const { stdout } = await this.#run(['rev-parse', '--show-toplevel']);
      if (await realpath(stdout.trim()) !== await realpath(this.root)) {
        return `failed: ${this.root} is not the top of its own repository after git init`;
      }
      await this.#ignoreWritten();
      return null;
    } catch (error) {
      return `failed: ${gitSaid(error)}`;
    }
  }

  /** The record of what PALUGADA wrote is the deployment's, not the history's; an operator's own entries are kept. */
  async #ignoreWritten(): Promise<void> {
    const path = join(this.root, '.gitignore');
    let now = '';
    try {
      now = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (now.split('\n').some((line) => line.trim() === WRITTEN)) return;
    await writeFile(path, `${now}${now && !now.endsWith('\n') ? '\n' : ''}${WRITTEN}\n`, 'utf8');
  }

  /** The operation git is in the middle of, or null. */
  async #midway(): Promise<string | null> {
    const { stdout } = await this.#run(['rev-parse', '--git-dir']);
    const gitDir = resolve(this.root, stdout.trim());
    for (const [name, what] of MIDWAY) {
      try {
        await access(join(gitDir, name));
        return what;
      } catch {
        // Not this one.
      }
    }
    return null;
  }

  async #commit(messages: string[]): Promise<CharterSync['git']> {
    try {
      await this.#run(['add', '--all']);
      const { stdout } = await this.#run(['status', '--porcelain']);
      if (!stdout.trim()) return 'nothing to commit';
      const subject = messages.length === 1 ? messages[0]! : `${messages.length} charters: ${messages.join('; ')}`;
      // PALUGADA's own name, not the operator's: the commit says who wrote
      // the file, and a change taken from the file keeps the edit's own
      // commit when its author made one. The repository's own hooks run:
      // an operator who put one there, a secret scanner say, meant it.
      await this.#run(['-c', 'user.name=PALUGADA', '-c', 'user.email=palugada@localhost',
        'commit', '--quiet', '-m', (subject || 'Charters').slice(0, 200)]);
      return 'committed';
    } catch (error) {
      return `failed: ${gitSaid(error)}`;
    }
  }

  #run(args: string[]): Promise<{ stdout: string }> {
    return run(this.#git!, ['-C', this.root, ...args], { timeout: 15_000, env: { PATH: process.env.PATH ?? '' } });
  }

  async #readWritten(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(join(this.root, WRITTEN), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async #saveWritten(written: Record<string, string>): Promise<void> {
    await writeFile(join(this.root, WRITTEN), `${JSON.stringify(written, null, 2)}\n`, 'utf8');
  }
}

/**
 * Why a file's words cannot be a charter, or null. The console's own
 * limits, and the one thing a file can hold that a form cannot: a merge
 * that was never finished.
 */
function notACharter(body: string): string | null {
  if (body.includes('\u0000')) return 'it holds a NUL character, which a charter cannot';
  if (body.length > CHARTER_LIMIT) {
    return `a charter is at most ${CHARTER_LIMIT} characters, and this one is ${body.length}; every run carries it whole`;
  }
  if (/^<{7}( |$)/m.test(body) && /^>{7}( |$)/m.test(body)) {
    return 'it holds conflict markers from a merge: resolve them, and the next sync takes it';
  }
  return null;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function withNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}

function oneLine(error: unknown): string {
  return String((error as Error).message ?? error).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** What git said, which is on stderr, not in the "Command failed" line above it. */
function gitSaid(error: unknown): string {
  const said = String((error as { stderr?: unknown }).stderr ?? '').trim();
  return oneLine(said ? { message: said } : error);
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
