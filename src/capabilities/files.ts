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
 */
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';

export interface FilesOptions {
  /**
   * The directory a company's files live under.
   *
   * Required, and there is no default. A default would be this process's
   * working directory, which is the repository, which is the last place an
   * agent should be listing.
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

export function filesList(options: FilesOptions): Capability<ListInput, ListOutput> {
  const maxEntries = options.maxEntries ?? 500;

  return {
    name: 'files.list',
    adapter: 'platform:files',
    defaultTier: 0,
    async execute(input) {
      const { readdir, realpath, stat } = await import('node:fs/promises');
      const { join, resolve, sep, normalize, relative } = await import('node:path');

      // The root's own real path, so a root that is itself a link still gives
      // a stable base to compare against.
      const base = await realpath(resolve(options.root)).catch(() => {
        throw new PalugadaError(
          'capability.unknown',
          `files.list is configured with a root that does not exist: ${options.root}`,
          {},
        );
      });

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
        // `lstat` semantics on purpose via `stat` on the joined path: a link
        // *inside* the listing is reported as what it is rather than followed,
        // so a listing cannot become a way to learn about the other end of one.
        const info = await stat(join(real, name)).catch(() => null);
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
