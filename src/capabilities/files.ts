/**
 * `files.list` -- reading a directory the company owns (PRD v2 F8, F12.9).
 *
 * Granted to three divisions in the standard template, and the same shape of
 * risk as `web.fetch` pointed at a different resource: a role that can name a
 * path and have this process read it is a role that can name `/`, or
 * `../../root/.ssh`, or a symbolic link somebody left in a working directory.
 *
 * The defence is the same one the owner console needed and for the same
 * reason: `resolve` flattens `..` but does not follow links, so a link inside
 * the root pointing at `/etc` passes every string comparison. `realpath` is
 * what sees it. That was found by mutation testing on the console -- removing
 * the containment check there left the suite green because `normalize` had
 * already neutralised the dots -- and it is written down here so the second
 * implementation does not have to rediscover it.
 *
 * **No reading of contents.** The name is `files.list`, and listing is what it
 * does: names, sizes and times. A capability that also returned file contents
 * would be a different capability with a different tier, and the template
 * grants this one to divisions that were never assessed for that.
 *
 * **One directory per company, and the platform picks it.** The configured
 * root is the root for *every* company, so the company's own directory is a
 * subdirectory of it named by id -- chosen here from `ctx.companyId`, never
 * from an argument. Sharing one directory was the first version of this file
 * and it was a tenancy hole with no database in it: F1.1 is enforced by
 * row-level security everywhere else, and a capability reading a filesystem
 * has no row-level security to inherit. It has to do the same job by hand or
 * it undoes it.
 */
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';

export interface FilesOptions {
  /**
   * The directory *every* company's files live under.
   *
   * Required, and there is no default: the default would be this process's
   * working directory, which is the repository, which is the last place an
   * agent should be listing. Each company gets a subdirectory of it named by
   * id, so this is the platform's root rather than any one company's.
   */
  root: string;
  /** How many entries one call may return. */
  maxEntries?: number;
}

export interface ListInput {
  /** Relative to the root. Absent means the root itself. */
  path?: string;
}

export interface ListEntry {
  name: string;
  kind: 'file' | 'directory' | 'other';
  bytes: number;
  modifiedAt: string;
}

export interface ListOutput {
  path: string;
  entries: ListEntry[];
  truncated: boolean;
}

/**
 * The directory belonging to one company, created if it is not there yet.
 *
 * Named by id rather than by slug: a slug can be changed by the owner and an
 * id cannot, and a company whose files moved because somebody renamed it is a
 * company that lost them.
 */
export async function companyRoot(root: string, companyId: string): Promise<string> {
  const { mkdir, realpath } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');

  const platform = await realpath(resolve(root)).catch(() => {
    throw new PalugadaError(
      'capability.unknown',
      `files are configured with a root that does not exist: ${root}`,
      {},
    );
  });
  // The id is a uuid from the broker, but it is joined onto a path, so it is
  // checked rather than trusted: a component that is not a uuid has no
  // business becoming a directory name.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new PalugadaError('capability.unknown', 'that is not a company id', {});
  }
  const mine = join(platform, companyId);
  await mkdir(mine, { recursive: true });
  return realpath(mine);
}

export function filesList(options: FilesOptions): Capability<ListInput, ListOutput> {
  const maxEntries = options.maxEntries ?? 500;

  return {
    name: 'files.list',
    adapter: 'platform:files',
    defaultTier: 0,
    async execute(input, ctx) {
      const { readdir, realpath, lstat } = await import('node:fs/promises');
      const { join, resolve, sep, normalize, relative } = await import('node:path');

      // This company's directory, and only this company's. The id comes from
      // the broker rather than from the input, so there is no argument that
      // reaches another tenant's files.
      const base = await companyRoot(options.root, ctx.companyId);

      const wanted = normalize(String(input.path ?? '.'));
      const target = resolve(join(base, wanted));

      let real: string;
      try {
        real = await realpath(target);
      } catch {
        throw new PalugadaError(
          'capability.unknown',
          `no such directory: ${wanted}`,
          { path: wanted },
        );
      }

      // See the module comment. This is the check that catches a symlink, and
      // it is the only one that does.
      if (real !== base && !real.startsWith(base + sep)) {
        throw new PalugadaError(
          'capability.unreachable',
          `${wanted} is outside the company's files`,
          { path: wanted },
        );
      }

      const names = await readdir(real);
      const entries: ListEntry[] = [];
      for (const name of names.slice(0, maxEntries)) {
        // `lstat`, not `stat`. A link inside the listing must be reported as a
        // link rather than followed -- `stat` would report the *target's* kind,
        // size and modification time, so a link to `/etc/shadow` would tell an
        // agent how big it is and when it last changed. That is not reading it,
        // and it is not nothing either.
        const info = await lstat(join(real, name)).catch(() => null);
        entries.push({
          name,
          kind: info === null
            ? 'other'
            : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          bytes: info?.isFile() ? info.size : 0,
          modifiedAt: (info?.mtime ?? new Date(0)).toISOString(),
        });
      }

      return {
        // Relative to the root, never absolute: an agent has no use for where
        // the platform keeps things, and a trace carrying host paths is one
        // more thing to redact.
        path: relative(base, real) || '.',
        entries,
        truncated: names.length > maxEntries,
      };
    },
  };
}
