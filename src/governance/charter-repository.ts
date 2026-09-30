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
 * Which of the two a difference is, is decided by what PALUGADA itself last
 * wrote to each file, kept beside them (`.palugada-written.json`, ignored by
 * git): a file that still holds what PALUGADA wrote is the database's to
 * change, and one that holds anything else was changed by somebody. Without
 * that, a file left from an earlier database -- a restored backup, a
 * reinstall -- would quietly overwrite the charter the owner has now.
 *
 * git is the deployment's history of its charters, not a condition of
 * having them. Without the binary the files are still written and read, and
 * the report says so; a commit that fails never fails a charter.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withControlPlane } from '../db/tenant.ts';
import { publishCharter } from './store.ts';
import { COMPANY_CHARTER_FILE, PLATFORM_CHARTER_FILE } from './charter-files.ts';

const run = promisify(execFile);

/** What PALUGADA last wrote to each file, by its path inside the repository. */
const WRITTEN = '.palugada-written.json';

export interface CharterSync {
  /** Files written from the database: a charter published elsewhere. */
  written: string[];
  /** Files taken in as a charter's next version: edited in the repository. */
  taken: Array<{ path: string; version: number }>;
  /** Directories for companies this deployment does not have, left alone. */
  unknown: string[];
  /** Whether the changes were committed, and if not, why. */
  git: 'committed' | 'nothing to commit' | 'not available' | `failed: ${string}`;
}

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

  async #sync(): Promise<CharterSync> {
    await mkdir(join(this.root, 'companies'), { recursive: true });
    const git = await this.#ready();
    const written = await this.#readWritten();
    const report: CharterSync = { written: [], taken: [], unknown: [], git: 'nothing to commit' };
    const messages: string[] = [];

    const { companies, current } = await withControlPlane(async (tx) => {
      const { rows: companies } = await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM companies');
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
      const onFile = await readIfPresent(join(this.root, scope.path));
      const inDatabase = latest.get(scope.companyId) ?? null;
      const ours = onFile !== null && written[scope.path] === digest(onFile);

      if (onFile !== null && !ours) {
        // Changed in the repository: its words are the next version.
        if (onFile.trim() && onFile.trim() !== inDatabase?.body.trim()) {
          const published = await publishCharter({
            ...(scope.companyId === null ? {} : { companyId: scope.companyId }),
            body: onFile.trim(),
          });
          report.taken.push({ path: scope.path, version: published.version });
          messages.push(`Charter v${published.version} for ${scope.name}, from the file`);
        }
        written[scope.path] = digest(onFile);
        continue;
      }
      // Ours, or not there: the database's charter is what it should hold.
      if (!inDatabase) continue;
      const text = withNewline(inDatabase.body);
      if (onFile === text) continue;
      await mkdir(join(this.root, scope.path, '..'), { recursive: true });
      await writeFile(join(this.root, scope.path), text, 'utf8');
      written[scope.path] = digest(text);
      report.written.push(scope.path);
      messages.push(`Charter v${inDatabase.version} for ${scope.name}`);
    }

    // A directory for a company this deployment does not have is not
    // authorisation to create one; it is said and left.
    const known = new Set(companies.map((company) => company.slug));
    for (const slug of await directories(join(this.root, 'companies'))) {
      if (!known.has(slug)) report.unknown.push(slug);
    }

    await writeFile(join(this.root, WRITTEN), `${JSON.stringify(written, null, 2)}\n`, 'utf8');
    report.git = git ? await this.#commit(messages) : 'not available';
    return report;
  }

  /** A repository, made the first time: false when there is no git to make one with. */
  async #ready(): Promise<boolean> {
    if (!this.#git) return false;
    try {
      await this.#run(['rev-parse', '--git-dir']);
      return true;
    } catch {
      try {
        await this.#run(['init', '--quiet']);
        await writeFile(join(this.root, '.gitignore'), `${WRITTEN}\n`, 'utf8');
        return true;
      } catch {
        return false;
      }
    }
  }

  async #commit(messages: string[]): Promise<CharterSync['git']> {
    try {
      await this.#run(['add', '--all']);
      const { stdout } = await this.#run(['status', '--porcelain']);
      if (!stdout.trim()) return 'nothing to commit';
      const subject = messages.length === 1 ? messages[0]! : `${messages.length} charters: ${messages.join('; ')}`;
      // PALUGADA's own name, not the operator's: the commit says who wrote
      // the file, and a change taken from the file keeps the edit's own
      // commit when its author made one.
      await this.#run(['-c', 'user.name=PALUGADA', '-c', 'user.email=palugada@localhost',
        'commit', '--quiet', '--no-verify', '-m', subject.slice(0, 200)]);
      return 'committed';
    } catch (error) {
      return `failed: ${String((error as Error).message).split('\n')[0]!.slice(0, 200)}`;
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
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function withNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
