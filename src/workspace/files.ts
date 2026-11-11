/**
 * The files people say in a room (F19.4, F19.16; STATUS section 2.212).
 *
 * A message carries up to five, 24 MB together, and each is kept beside the
 * company's files, never under them: in the company's people folder
 * (`peopleFilesFolder`), under `rooms/<roomId>/<fileId>.<ext>`. Every agent
 * capability that reads a file, and the owner's Files page, reads a
 * company's own folder (`companyRoot`), so none of them can list, read,
 * describe, compute on or mail a room file, by any path.
 *
 * Nothing about a kept file comes from the name it was sent with but the
 * name it is shown under. Its place is its own id, its extension and its kind
 * are what its bytes show, and nothing is ever served as a page: the console
 * is answered with the bytes in base64 inside JSON, draws a picture only when
 * it is a small one of a kind no browser runs (`drawnInline`), and saves
 * everything else as an octet stream. So a colleague's SVG or HTML is kept
 * and passed on, as a stranger's would not be (src/chats/attachments.ts),
 * and never opens as a document in the console's origin.
 *
 * Bytes follow their rows. A post writes them before its transaction, under
 * `incoming/`, since the transaction holds the company's room clock from its
 * first write (0150) and every room of the company would wait on the disk;
 * inside it they are linked into their room as their rows are written, so a
 * post that fails keeps none it could name, and the staged names go after.
 * A delete or a purge takes the path from the row as it commits and removes
 * the bytes after. What a crash leaves -- a staged file, a post that linked
 * and did not commit, a delete that committed and did not remove -- no row
 * names, and the sweep in the retention stage removes it (`sweepRoomFiles`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { base64Bytes, displayName, sniffReceived } from '../chats/attachments.ts';
import { withControlPlane, withPeople, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { peopleFilesFolder } from '../owner/route.ts';
import { visibleRoom } from './rooms.ts';
import { drawnInline, type Viewer } from './views.ts';

/** How many files one message carries. */
export const FILES_PER_MESSAGE = 5;
/** Their bytes together, as the table holds one file at most (0150). */
export const FILES_MAX_BYTES = 24 * 1024 * 1024;
/** How long a file no row names is left before the sweep takes it: a post still writing may not have committed. */
const SWEEP_GRACE_MS = 60 * 60 * 1000;

/** The kind each extension the bytes were found to be is served as. */
const KIND_OF: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  txt: 'text/plain',
  zip: 'application/zip',
  gz: 'application/gzip',
  bin: 'application/octet-stream',
};

/**
 * What a file is, by its bytes. A stranger's file is judged by what may be
 * kept for agents to read (`sniffReceived`); a colleague's is kept whatever
 * it is, since no agent reads it, and what the platform would refuse from a
 * stranger -- a program, an archive, an SVG -- is named for the kind it is
 * and only ever saved. The name it was sent with decides nothing but which
 * of two Office files a zip is, as it does for a stranger's.
 */
export function roomFileKind(bytes: Buffer, name: string): { mime: string; ext: string } {
  const sniffed = sniffReceived(bytes, name);
  if ('ext' in sniffed && KIND_OF[sniffed.ext]) return { mime: KIND_OF[sniffed.ext]!, ext: sniffed.ext };
  const head = bytes.subarray(0, 2048).toString('latin1');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/i.test(head)) return { mime: KIND_OF.svg!, ext: 'svg' };
  if (head.startsWith('PK\u0003\u0004')) {
    if (/\.pptx$/i.test(name) && bytes.includes('ppt/presentation.xml')) return { mime: KIND_OF.pptx!, ext: 'pptx' };
    return { mime: KIND_OF.zip!, ext: 'zip' };
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return { mime: KIND_OF.gz!, ext: 'gz' };
  if (head.slice(4, 8) === 'ftyp') return { mime: KIND_OF.mp4!, ext: 'mp4' };
  if (looksLikeText(bytes)) return { mime: KIND_OF.txt!, ext: 'txt' };
  return { mime: KIND_OF.bin!, ext: 'bin' };
}

/** Text, read from its start: UTF-8 with no NUL, a character cut at the end of what is read forgiven. */
function looksLikeText(bytes: Buffer): boolean {
  const start = bytes.subarray(0, 64 * 1024);
  if (start.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(start, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** A file a post carries, looked at and not yet written. */
export interface Attaching {
  name: string;
  mime: string;
  ext: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * The files a post carries, as `{ name, data }` with the bytes in base64,
 * each looked at before any is written: a message with one refused file is
 * refused whole, and keeps nothing.
 */
export function filesToAttach(value: unknown): Attaching[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PalugadaError('contract.violation', 'files is a list of { name, data }, each file in base64', { field: 'files' });
  }
  if (value.length > FILES_PER_MESSAGE) {
    throw new PalugadaError('message.files', `a message carries up to ${FILES_PER_MESSAGE} files; this one has ${value.length}`,
      { most: FILES_PER_MESSAGE, given: value.length });
  }
  let total = 0;
  const looked = value.map((one: unknown): Attaching => {
    const given = (one ?? {}) as { name?: unknown; data?: unknown };
    const name = typeof given.name === 'string' && given.name.trim() ? displayName(given.name) : null;
    if (!name) throw new PalugadaError('contract.violation', 'each file is { name, data }: it has no name', { field: 'files' });
    const bytes = base64Bytes(given.data);
    if (bytes.length === 0) throw new PalugadaError('contract.violation', `${name} is empty, and an empty file is not kept`, { field: 'files' });
    total += bytes.length;
    const { mime, ext } = roomFileKind(bytes, name);
    return { name, mime, ext, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  if (total > FILES_MAX_BYTES) {
    throw new PalugadaError('message.files', `a message's files come to at most ${FILES_MAX_BYTES / 1_048_576} MB together`,
      { most: FILES_MAX_BYTES, given: total });
  }
  return looked;
}

/**
 * A folder of the people folder, made if it is not there, one level at a
 * time: a link put where a folder goes is found before anything is written
 * through it, and refused, so nobody points a room's files into a company's
 * own folder, which agents read.
 */
async function folderAt(folder: string, parts: readonly string[], make: boolean): Promise<string | null> {
  let here = folder;
  for (const part of ['', ...parts]) {
    here = part ? join(here, part) : here;
    let found = await lstat(here).catch(() => null);
    if (found === null) {
      if (!make) return null;
      try {
        await mkdir(here, { recursive: part === '', mode: 0o700 });
        continue;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
        found = await lstat(here).catch(() => null);
      }
    }
    if (!found?.isDirectory()) {
      throw new PalugadaError('file.not_kept', 'the room files have something other than a folder where a folder goes, so nothing is written or read through it', {});
    }
  }
  return here;
}

/** A post's file, written under `incoming/` by the id its row will have, before the post's transaction. */
export interface Staged {
  id: string;
  file: Attaching;
}

/**
 * Writes a post's files under the people folder's `incoming/`, before the
 * post's transaction begins, each created and never replaced (`O_EXCL`,
 * `O_NOFOLLOW`). A write that fails removes what was written. The caller
 * removes the staged names once the post is done (`unstage`), whatever
 * became of it.
 */
export async function stageFiles(folder: string | null, files: readonly Attaching[]): Promise<Staged[]> {
  if (files.length === 0) return [];
  if (folder === null) {
    throw new PalugadaError('contract.violation', 'this deployment keeps no files: PALUGADA_FILES_ROOT is not set', { field: 'files' });
  }
  const staged: Staged[] = [];
  try {
    const incoming = (await folderAt(folder, ['incoming'], true))!;
    for (const file of files) {
      const one = { id: randomUUID(), file };
      const handle = await open(join(incoming, `${one.id}.${file.ext}`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      staged.push(one);
      try {
        await handle.writeFile(file.bytes);
      } finally {
        await handle.close();
      }
    }
  } catch (failure) {
    await unstage(folder, staged);
    throw failure;
  }
  return staged;
}

/** Removes a post's staged names; what was linked into its room stays under its room's name. */
export async function unstage(folder: string | null, staged: readonly Staged[]): Promise<void> {
  if (folder === null) return;
  for (const one of staged) await unlink(join(folder, 'incoming', `${one.id}.${one.file.ext}`)).catch(() => undefined);
}

/**
 * Keeps a post's staged files with its message: their rows, then each file's
 * bytes linked into its room under its own id, inside the post's
 * transaction, which a person's insert is held to their own message by
 * (0150). A link is never made over a file already there. One that fails
 * removes what was linked, and the transaction fails with it.
 */
export async function attachFiles(
  tx: TenantClient, companyId: string, roomId: string, messageId: string, staged: readonly Staged[], folder: string | null,
): Promise<void> {
  if (staged.length === 0) return;
  if (folder === null) {
    throw new PalugadaError('contract.violation', 'this deployment keeps no files: PALUGADA_FILES_ROOT is not set', { field: 'files' });
  }
  const linked: string[] = [];
  try {
    const incoming = (await folderAt(folder, ['incoming'], true))!;
    const here = (await folderAt(folder, ['rooms', roomId], true))!;
    for (const { id, file } of staged) {
      const path = `rooms/${roomId}/${id}.${file.ext}`;
      await tx.query(
        `INSERT INTO room_files (id, company_id, message_id, name, mime, bytes, sha256, path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, companyId, messageId, file.name, file.mime, file.bytes.length, file.sha256, path]);
      await link(join(incoming, `${id}.${file.ext}`), join(here, `${id}.${file.ext}`));
      linked.push(path);
    }
  } catch (failure) {
    await removeRoomFiles(folder, linked);
    throw failure;
  }
}

/** One file as the console reads it: its name, its kind, whether it may be drawn, and its bytes in base64. */
export interface RoomFile {
  name: string;
  mime: string;
  bytes: number;
  inline: boolean;
  data: string;
}

/**
 * A file of a room, read as the person: only someone who may see the room
 * reaches its row (0150), and only the row says where its bytes are. Bytes
 * that are not what the row recorded are not handed out.
 */
export async function readRoomFile(viewer: Viewer, roomId: string, fileId: string, folder: string | null): Promise<RoomFile> {
  const row = await withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const { rows } = await tx.query<{ name: string; mime: string; bytes: string; sha256: string | null; path: string | null }>(
      `SELECT f.name, f.mime, f.bytes, f.sha256, f.path
         FROM room_files f JOIN room_messages m ON m.company_id = f.company_id AND m.id = f.message_id
        WHERE f.id = $1 AND m.room_id = $2`, [fileId, roomId]);
    if (!rows[0]) throw new PalugadaError('contract.violation', 'that is not a file of this room', { fileId });
    return rows[0];
  });
  const gone = () => new PalugadaError('file.not_kept', 'that file is no longer kept', { fileId });
  if (row.path === null || folder === null) throw gone();
  const parts = row.path.split('/');
  const here = await folderAt(folder, parts.slice(0, -1), false).catch(() => null);
  if (here === null) throw gone();
  const handle = await open(join(here, parts.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) throw gone();
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > FILES_MAX_BYTES) throw gone();
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw gone();
  return { name: row.name, mime: row.mime, bytes: bytes.length, inline: drawnInline(row.mime, bytes.length), data: bytes.toString('base64') };
}

/**
 * Removes the bytes of files whose rows no longer name them, after the
 * transaction that let them go has committed. A path that is not a room
 * file's shape is never removed, whatever handed it here.
 */
export async function removeRoomFiles(folder: string | null, paths: readonly string[]): Promise<void> {
  if (folder === null) return;
  for (const path of paths) {
    if (!/^rooms\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,10}$/.test(path)) continue;
    await unlink(join(folder, path)).catch(() => undefined);
  }
}

/** The paths a set of messages' files are kept at, read before the rows let them go. */
export async function keptPaths(tx: TenantClient, messageIds: readonly string[]): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const { rows } = await tx.query<{ path: string }>(
    'SELECT path FROM room_files WHERE message_id = ANY($1::uuid[]) AND path IS NOT NULL', [messageIds]);
  return rows.map((row) => row.path);
}

/** A deployment's roots: its files root, and the room files' own when it sets one. */
export interface PeopleRoots {
  filesRoot?: string | null | undefined;
  peopleRoot?: string | null | undefined;
}

/** Where a deployment's roots keep one company's room files; null where no files are kept. */
export function peopleFolderOf(roots: PeopleRoots, companyId: string): string | null {
  if (!roots.filesRoot) return null;
  return peopleFilesFolder({ root: roots.filesRoot, ...(roots.peopleRoot ? { peopleRoot: roots.peopleRoot } : {}) }, companyId);
}

/**
 * Removes every file under a company's room files that no row names, once
 * it is older than the grace a post in flight is given: what a delete cut
 * off before its bytes went, or a post that wrote and never committed,
 * leaves. Answers how many went.
 */
export async function sweepRoomFiles(companyId: string, folder: string | null, now = new Date()): Promise<number> {
  if (folder === null) return 0;
  let removed = 0;
  const stale = async (at: string) => {
    const found = await lstat(at).catch(() => null);
    return found !== null && !found.isDirectory() && now.getTime() - found.mtimeMs >= SWEEP_GRACE_MS;
  };
  // A staged file is never a kept one: once its post is done it is a name too many.
  const incoming = await folderAt(folder, ['incoming'], false).catch(() => null);
  if (incoming !== null) {
    for (const file of await readdir(incoming)) {
      if (!(await stale(join(incoming, file)))) continue;
      await unlink(join(incoming, file)).catch(() => undefined);
      removed += 1;
    }
  }
  const rooms = await folderAt(folder, ['rooms'], false).catch(() => null);
  if (rooms === null) return removed;
  const named = new Set(await withControlPlane(async (tx) => (await tx.query<{ path: string }>(
    'SELECT path FROM room_files WHERE company_id = $1 AND path IS NOT NULL', [companyId])).rows.map((row) => row.path)));
  for (const room of await readdir(rooms, { withFileTypes: true })) {
    if (!room.isDirectory()) continue;
    for (const file of await readdir(join(rooms, room.name), { withFileTypes: true })) {
      const path = `rooms/${room.name}/${file.name}`;
      if (named.has(path) || !(await stale(join(rooms, room.name, file.name)))) continue;
      await unlink(join(rooms, room.name, file.name)).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Removes a company's room files when the company is erased: its whole
 * people folder, beside the folder `removeCompanyFiles` removes. A link
 * where the folder should be is removed as a link, never followed.
 */
export async function erasePeopleFiles(roots: PeopleRoots, companyId: string): Promise<string | null> {
  const folder = peopleFolderOf(roots, companyId);
  if (folder === null) return null;
  if (await lstat(folder).catch(() => null) === null) return folder;
  await rm(folder, { recursive: true, force: true });
  return folder;
}
