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
 * A company that is erased (0088) takes its folder with it: `forget`
 * removes `companies/<slug>/` and commits the removal (0096). The commits
 * before it still hold what its charter said; the history is not rewritten,
 * and the guide says so.
 *
 * git is the deployment's history of its charters, not a condition of
 * having them. Without the binary the files are still written and read, and
 * the report says so; a commit that fails never fails a charter.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
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
  ['BISECT_START', 'a bisect'],
  ['sequencer', 'a sequence of cherry-picks or reverts'],
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

/** What removing erased companies' folders did (`forget`). */
export interface CharterForgetting {
  /** Folders removed, by their path inside the repository. */
  removed: string[];
  /** Folders that could not be removed, and why. */
  refused: Array<{ slug: string; path: string; reason: string }>;
  /** Whether the removal was committed, and if not, why; as `CharterSync.git`. */
  git: CharterSync['git'];
}

/** A file that is not a charter, said in words the operator acts on. */
class Refusal extends Error {}

/** What a company's slug may be (0001), checked again before one names a folder to remove. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class CharterRepository {
  readonly root: string;
  readonly #git: string | null;
  #busy: Promise<unknown> | null = null;

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
    return this.#alone(() => this.#sync());
  }

  /**
   * Removes the folders of companies that were erased (0088, 0096), and
   * commits the removal as PALUGADA, like every charter it writes. Given the
   * slugs of erased companies that no company here has now; a folder that is
   * already gone still has its removal committed, which is how a commit that
   * failed once is finished by the next.
   *
   * What it cannot do is rewrite the history: every charter a company had is
   * still in the commits before its removal, and stays there. Rewriting a
   * repository an operator may have cloned or pushed is not a thing a worker
   * does on its own; the guide says what is left, and how to take it out.
   */
  async forget(slugs: string[]): Promise<CharterForgetting> {
    return this.#alone(() => this.#forget(slugs));
  }

  /** A sync or a removal in progress, finished: what a process that is stopping waits for. */
  async settled(): Promise<void> {
    while (this.#busy) await this.#busy.catch(() => undefined);
  }

  /** One thing at a time in the repository: a sync and a removal together would commit each other's halves. */
  async #alone<T>(work: () => Promise<T>): Promise<T> {
    while (this.#busy) await this.#busy.catch(() => undefined);
    const running = work();
    this.#busy = running;
    try {
      return await running;
    } finally {
      this.#busy = null;
    }
  }

  async #forget(slugs: string[]): Promise<CharterForgetting> {
    const report: CharterForgetting = { removed: [], refused: [], git: 'nothing to commit' };
    // No repository here: nothing of anybody's was kept in it.
    if (!(await lstat(this.root).catch(() => null))?.isDirectory()) return report;
    const git = await this.#ready();
    const midway = git === null ? await this.#midway() : null;
    const gone: string[] = [];
    for (const slug of slugs) {
      const path = join('companies', slug);
      try {
        if (!SLUG.test(slug)) throw new Refusal('it is not a company\'s slug, so it names no folder here');
        // Before anything is removed: a `companies` or a company folder that
        // leads out of the repository is refused, never followed.
        await this.#inside(join(path, COMPANY_CHARTER_FILE));
        const stats = await lstat(join(this.root, path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (stats === null) {
          gone.push(path);
          continue;
        }
        if (stats.isSymbolicLink()) throw new Refusal('it is a link, and a link is never followed: remove it, or put the folder itself there');
        // A merge or a rebase may be about these very files; it is the
        // operator's to finish first, as it is for a sync.
        if (midway) throw new Refusal(`${midway}; finish it, and the next worker to start removes it`);
        await rm(join(this.root, path), { recursive: true, force: true });
        report.removed.push(path);
        gone.push(path);
      } catch (error) {
        report.refused.push({ slug, path, reason: oneLine(error) });
      }
    }

    // What PALUGADA last wrote there is forgotten with it. A record that
    // cannot be read is left alone: it holds the next sync, which says so.
    const written = await this.#readWritten();
    if (typeof written !== 'string') {
      const before = Object.keys(written).length;
      for (const key of Object.keys(written)) {
        if (gone.some((path) => key.startsWith(`${path}/`))) delete written[key];
      }
      if (Object.keys(written).length !== before) await this.#saveWritten(written);
    }

    if (git !== null) return { ...report, git };
    if (midway || gone.length === 0) return report;
    try {
      // Only these folders, whatever else is staged: the operator's own
      // changes are theirs to commit.
      await this.#run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...gone]);
      const { stdout } = await this.#run(['diff', '--cached', '--name-only', '--', ...gone]);
      const staged = stdout.split('\n').filter(Boolean);
      if (staged.length === 0) return report;
      const erased = [...new Set(staged.map((path) => path.split('/')[1]!))];
      const subject = erased.length === 1
        ? `Charter for ${erased[0]} removed: the company was erased`
        : `${erased.length} charters removed, their companies erased: ${erased.join(', ')}`;
      await this.#run(['-c', 'user.name=PALUGADA', '-c', 'user.email=palugada@localhost',
        'commit', '--quiet', '-m', subject.slice(0, 200), '--', ...staged]);
      return { ...report, git: 'committed' };
    } catch (error) {
      return { ...report, git: `failed: ${gitSaid(error)}` };
    }
  }

  async #sync(): Promise<CharterSync> {
    await mkdir(this.root, { recursive: true });
    // Not there as a directory -- a file, a dangling link -- the companies'
    // charters are each refused below, and the platform's is still kept.
    await mkdir(join(this.root, 'companies'), { recursive: true }).catch(() => undefined);
    const report: CharterSync = { written: [], taken: [], unknown: [], refused: [], git: 'nothing to commit' };
    // A repository that cannot be made or used leaves the files kept
    // without their history, as a machine with no git does, and says why.
    const git = await this.#ready();
    const midway = git === null ? await this.#midway() : null;
    if (midway) {
      return { ...report, git: `held: ${midway} in ${this.root}; finish it, and the next sync takes the result` };
    }

    const written = await this.#readWritten();
    if (typeof written === 'string') return { ...report, git: `held: ${written}` };
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

    // Every charter brought level, not only this sync's: one written while
    // git could not commit is committed on the next sync that can.
    const refused = new Set(report.refused.map((one) => one.path));
    const levelled: string[] = [];
    for (const scope of scopes) {
      if (!refused.has(scope.path) && await isFile(join(this.root, scope.path))) levelled.push(scope.path);
    }
    report.git = git ?? await this.#commit(messages, levelled);
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
      if (!body || body === inDatabase?.body.trim()) {
        written[scope.path] = digest(onFile);
        return { kind: 'seen', version: inDatabase?.version ?? 0 };
      }
      const problem = notACharter(body);
      if (problem) throw new Refusal(problem);
      const published = await publishCharter({
        ...(scope.companyId === null ? {} : { companyId: scope.companyId }),
        body,
      }, 'repository');
      // Recorded only once it is published: recorded first, a publish that
      // failed left the file looking like PALUGADA's, and the next sync
      // wrote the database's charter over the edit it never took.
      written[scope.path] = digest(onFile);
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
      if (error instanceof Refusal) return `failed: ${error.message}`;
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

  /**
   * The record of what PALUGADA wrote is the deployment's, not the
   * history's; an operator's own entries are kept. A `.gitignore` that is a
   * link is refused like a charter that is one: appended to through it, the
   * master key beside the repository took the line.
   */
  async #ignoreWritten(): Promise<void> {
    const path = join(this.root, '.gitignore');
    const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats && !stats.isFile()) throw new Refusal('.gitignore is not a file, and a link is never followed: put a file there');
    const now = stats ? await readNoFollow(path) : '';
    if (now.split('\n').some((line) => line.trim() === WRITTEN)) return;
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(`${now && !now.endsWith('\n') ? '\n' : ''}${WRITTEN}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /** What git is in the middle of, said as the operator would, or null. */
  async #midway(): Promise<string | null> {
    const { stdout } = await this.#run(['rev-parse', '--git-dir']);
    const gitDir = resolve(this.root, stdout.trim());
    for (const [name, what] of MIDWAY) {
      try {
        await access(join(gitDir, name));
        return `${what} is in progress`;
      } catch {
        // Not this one.
      }
    }
    // Conflicts with no operation to show for them: a `stash pop`, a
    // `merge --squash`, an `apply --3way`.
    const { stdout: unmerged } = await this.#run(['ls-files', '--unmerged']);
    if (unmerged.trim()) return 'a merge with unresolved conflicts is in the index';
    try {
      await this.#run(['symbolic-ref', '--quiet', 'HEAD']);
    } catch {
      return 'HEAD is detached (a bisect, or an older commit checked out)';
    }
    return null;
  }

  /**
   * Commits the charters PALUGADA brought level, and nothing else: a file
   * it refused, and whatever an operator left lying in the directory or
   * staged, is theirs to commit. `add --all` committed a refused file's
   * conflict markers, and concluded a conflicted `stash pop` with them.
   */
  async #commit(messages: string[], paths: string[]): Promise<CharterSync['git']> {
    try {
      const ours = [...paths, ...(await isFile(join(this.root, '.gitignore')) ? ['.gitignore'] : [])];
      if (ours.length === 0) return 'nothing to commit';
      await this.#run(['add', '--', ...ours]);
      const { stdout } = await this.#run(['diff', '--cached', '--name-only', '--', ...ours]);
      if (!stdout.trim()) return 'nothing to commit';
      const subject = messages.length === 1 ? messages[0]! : `${messages.length} charters: ${messages.join('; ')}`;
      // PALUGADA's own name, not the operator's: the commit says who wrote
      // the file, and a change taken from the file keeps the edit's own
      // commit when its author made one. The repository's own hooks run:
      // an operator who put one there, a secret scanner say, meant it.
      await this.#run(['-c', 'user.name=PALUGADA', '-c', 'user.email=palugada@localhost',
        'commit', '--quiet', '-m', (subject || 'Charters').slice(0, 200), '--', ...ours]);
      return 'committed';
    } catch (error) {
      return `failed: ${gitSaid(error)}`;
    }
  }

  #run(args: string[]): Promise<{ stdout: string }> {
    return run(this.#git!, ['-C', this.root, ...args], { timeout: 15_000, env: { PATH: process.env.PATH ?? '' } });
  }

  /**
   * The record, or why it cannot be read. It is refused like a charter:
   * as a link it was read and then written through, and the master key
   * beside the repository became JSON. A record that cannot be read holds
   * the sync, since without it every file would look like an edit.
   */
  async #readWritten(): Promise<Record<string, string> | string> {
    const path = join(this.root, WRITTEN);
    const remove = `until it is removed, nothing is read or written; removed, it is made again, and what each file holds then is taken as its charter`;
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      return `${WRITTEN} cannot be read (${oneLine(error)}); ${remove}`;
    }
    if (!stats.isFile()) return `${WRITTEN} is not a file, and a link is never followed; ${remove}`;
    try {
      const parsed = JSON.parse(await readNoFollow(path)) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
          || Object.values(parsed).some((value) => typeof value !== 'string')) {
        return `${WRITTEN} is not a record of files; ${remove}`;
      }
      return parsed as Record<string, string>;
    } catch (error) {
      return `${WRITTEN} cannot be read (${oneLine(error)}); ${remove}`;
    }
  }

  /** Written beside it and renamed over it: a link there is replaced, not written through. */
  async #saveWritten(written: Record<string, string>): Promise<void> {
    const path = join(this.root, WRITTEN);
    const next = `${path}.${process.pid}.next`;
    const handle = await open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(written, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(next, path);
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
  if ((error as { killed?: unknown }).killed) return 'git did not finish within 15 seconds, and was stopped';
  const said = String((error as { stderr?: unknown }).stderr ?? '').trim();
  return oneLine(said ? { message: said } : error);
}

async function isFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isFile() ?? false;
}

async function readNoFollow(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
