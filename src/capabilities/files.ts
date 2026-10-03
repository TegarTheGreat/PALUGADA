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
 * does: names, sizes and times. Reading a file is `files.read`, below: a
 * capability of its own, catalogued as a read of outside content, so a
 * division is granted it on purpose rather than with the listing.
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
import type { Browsers, DocumentKind } from '../browser/browsers.ts';
import { UNPACKED_MAX } from '../browser/documents.ts';

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

/**
 * Removes one company's directory and everything in it, when the company is
 * erased (0088, 0096). A root or a directory that is not there is nothing
 * to remove.
 *
 * The same directory `companyRoot` names, so what a role wrote and what an
 * erasure removes cannot drift apart. A link where the directory should be
 * is removed as a link: `rm` follows none, there or anywhere beneath it, so
 * a link somebody left cannot turn an erasure into the removal of whatever
 * it points at.
 */
export async function removeCompanyFiles(root: string, companyId: string): Promise<void> {
  const { lstat, realpath, rm } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new PalugadaError('contract.violation', 'that is not a company id', {});
  }
  const missing = (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  };
  const platform = await realpath(resolve(root)).catch(missing);
  if (platform === null) return;
  const mine = join(platform, companyId);
  if (await lstat(mine).catch(missing) === null) return;
  await rm(mine, { recursive: true, force: true });
}

export function filesList(options: FilesOptions): Capability<ListInput, ListOutput> {
  const maxEntries = options.maxEntries ?? 500;

  return {
    name: 'files.list',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'A folder under the company\'s files; omitted, the top.' } },
    },
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

export interface ReadInput {
  /** Relative to the company's files. */
  path: string;
  /** Where in the text to begin, for a file longer than one reading. */
  from?: number;
}

export interface ReadOutput {
  path: string;
  /** What the file was: text as it is, or a document read as text. */
  kind: 'text' | DocumentKind;
  bytes: number;
  text: string;
  from: number;
  /** Where the next reading begins, or null at the end. */
  next: number | null;
}

/**
 * A file under one company's files, read as `files.read` and
 * `image.describe` read one: the path resolved, and refused when it ends
 * outside the company's directory -- `..`, a link to another company's file
 * or to `/etc` -- as `files.list` refuses a folder; then opened without
 * following a link and checked as opened, so a link put where the file was
 * after the path was resolved is not read through. At most `maxBytes`, and
 * `limit` says so when it is more.
 */
export async function readCompanyFile(
  root: string, companyId: string, path: unknown, maxBytes: number, limit: string,
): Promise<{ path: string; real: string; bytes: Buffer; size: number; mtimeMs: number }> {
  const { open, realpath } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { join, resolve, sep, normalize, relative } = await import('node:path');
  const base = await companyRoot(root, companyId);
  const wanted = normalize(String(path ?? '')).replace(/^(\.\/)+/, '');
  if (!wanted || wanted === '.') throw new PalugadaError('contract.violation', 'path is a file under the company\'s files, as files.list names it', { field: 'path' });
  const target = resolve(join(base, wanted));
  let real: string | null = null;
  try {
    real = await realpath(target);
  } catch {
    // Not there -- unless the path leads outside, which is said as that.
  }
  const inside = (where: string) => where === base || where.startsWith(base + sep);
  if (!inside(target) || (real !== null && !inside(real))) {
    throw new PalugadaError('capability.unreachable', `${wanted} is outside the company's files`, { path: wanted });
  }
  if (real === null) throw new PalugadaError('contract.violation', `there is no file ${wanted}: files.list says what there is`, { path: wanted });
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new PalugadaError('capability.unreachable', `${wanted} is outside the company's files`, { path: wanted });
  });
  try {
    const info = await handle.stat();
    if (info.isDirectory()) throw new PalugadaError('contract.violation', `${wanted} is a folder: files.list lists it`, { path: wanted });
    if (!info.isFile()) throw new PalugadaError('contract.violation', `${wanted} is not a file`, { path: wanted });
    if (info.size > maxBytes) {
      throw new PalugadaError('contract.violation', `${wanted} is ${Math.round(info.size / 1_048_576)} MB; ${limit}`, { path: wanted });
    }
    return { path: relative(base, real), real, bytes: await handle.readFile(), size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** The most text one reading returns, as with a page read from the web. */
const READ_CHARS = 60_000;
/** The largest file read at all: a reading pages through it, but reads it whole each time. */
const READ_MAX_BYTES = 10 * 1024 * 1024;

/** A document read in the browser is kept a while, so its next page is not another reading. */
const CONVERTED_KEPT = 16;
const CONVERTED_MS = 10 * 60_000;

const DOCUMENT_SAID: Record<DocumentKind, string> = { pdf: 'a PDF', word: 'a Word document', excel: 'an Excel workbook' };

/**
 * A document by what its bytes say, before anything reads them as text: a
 * PDF may be ASCII from end to end. Word and Excel are ZIP files, told apart
 * by the name they are saved under.
 */
function documentKind(bytes: Buffer, name: string): DocumentKind | null {
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    if (/\.(docx|docm)$/i.test(name)) return 'word';
    if (/\.(xlsx|xlsm)$/i.test(name)) return 'excel';
  }
  return null;
}

/**
 * `files.read` -- a file in the company's files, as text (the tools research,
 * recommendation 3).
 *
 * The same containment as `files.list`, for the same reason: the path is
 * resolved with `realpath`, so a link is followed only to see where it goes,
 * and anything that ends outside this company's directory is refused, as a
 * file of another company is. Text is UTF-8, read strictly: a file that is
 * not -- a picture, a recording -- is said to be not text rather than
 * returned as noise. A long one is read a page at a time.
 *
 * A PDF, a Word document and an Excel workbook are read as text in the
 * deployment's browser (`Browsers.convert`), never in this process: they are
 * untrusted binaries, and the browser reads each in a sandboxed page with no
 * network. Without a browser they are said to need one.
 */
export function filesRead(options: FilesOptions, browser?: Browsers): Capability<ReadInput, ReadOutput> {
  const converted = new Map<string, { kind: DocumentKind; text: string; at: number }>();
  return {
    name: 'files.read',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_000, description: 'The file, under the company\'s files, as files.list names it: drafts/offer.md.' },
        from: { type: 'integer', minimum: 0, description: 'Where to begin, for the next page of a long file: the next a reading gave.' },
      },
      additionalProperties: false,
    },
    adapter: 'platform:files',
    defaultTier: 0,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const opened = await readCompanyFile(options.root, ctx.companyId, input.path, READ_MAX_BYTES, 'files.read reads files up to 10 MB');
      const { path: wanted, real, bytes } = opened;
      async function convertedText(document: DocumentKind): Promise<string> {
        const said = DOCUMENT_SAID[document];
        if (!browser) {
          throw new PalugadaError('capability.unreachable',
            `${wanted} is ${said}: this deployment reads them in its browser, and has none (install Chromium, or set PALUGADA_CHROMIUM)`, { path: wanted });
        }
        const key = `${real}:${opened.size}:${opened.mtimeMs}`;
        const kept = converted.get(key);
        if (kept && Date.now() - kept.at < CONVERTED_MS) return kept.text;
        const answer = await browser.convert(document, bytes, ctx.signal);
        if ('failure' in answer) {
          const why = {
            'no-reader': `${wanted} is a PDF, and this deployment's console was built without its PDF reader: build it again (npm run console:build)`,
            'too-large': `${wanted} is too large once unpacked: files.read unpacks up to ${UNPACKED_MAX / 1_048_576} MB of a document, and reads up to 5 million characters`,
            unreadable: `${wanted} is not ${said} that can be read`,
            encrypted: `${wanted} is locked with a password`,
            'no-text': `${wanted} has no text in it -- it may be a scan`,
            'too-slow': `${wanted} took over a minute to read, and was left`,
          }[answer.failure];
          throw new PalugadaError(answer.failure === 'no-reader' ? 'capability.unreachable' : 'contract.violation', why, { path: wanted });
        }
        for (const [old, entry] of converted) if (Date.now() - entry.at >= CONVERTED_MS) converted.delete(old);
        while (converted.size >= CONVERTED_KEPT) converted.delete(converted.keys().next().value!);
        converted.set(key, { kind: document, text: answer.text, at: Date.now() });
        return answer.text;
      }

      let whole: string;
      let kind: ReadOutput['kind'] = 'text';
      const document = documentKind(bytes, wanted);
      if (document) {
        kind = document;
        whole = await convertedText(document);
      } else {
        try {
          whole = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
          if (whole.includes('\u0000')) throw new Error('a NUL');
        } catch {
          throw new PalugadaError('contract.violation', `${wanted} is not text, nor a PDF, Word or Excel file: files.read reads those`, { path: wanted });
        }
      }
      const from = Math.floor(Number(input.from ?? 0));
      if (!Number.isFinite(from) || from < 0 || (from > 0 && from >= whole.length)) {
        throw new PalugadaError('contract.violation', `from is past the end: ${wanted} is ${whole.length} characters`, { field: 'from' });
      }
      const end = Math.min(whole.length, from + READ_CHARS);

      return {
        path: wanted,
        kind,
        bytes: opened.size,
        text: whole.slice(from, end),
        from,
        next: end < whole.length ? end : null,
      };
    },
  };
}
