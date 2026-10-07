/**
 * A file a stranger sent, kept or refused by what it is (the audit of 6
 * October, P1.4 part 5; STATUS 2.171).
 *
 * A customer's purchase order or a supplier's price list arrives as an
 * attachment, and until now the platform said "which cannot be read here" and
 * threw it away. Keeping it means writing bytes a stranger chose into the
 * company's files, where roles read them, so this is built the other way
 * round from the owner's own uploads (`keepCompanyFile`):
 *
 *   - **The sender names nothing.** The path is made here, from the channel,
 *     the month and the message that carried it -- `received/mail/2026-10/
 *     0a1b2c3d-1.pdf` -- and the extension is the kind the bytes turned out to
 *     be, never the one the sender claimed. The name they gave is kept as a
 *     display name beside the file, plain and short, and is shown wrapped as
 *     the data it is.
 *   - **The bytes decide.** What is kept is a PDF, a Word or Excel document,
 *     a picture, a recording or text, told by how it begins. A program, a
 *     script, an archive, a macro-enabled or pre-2007 Office file, HTML that
 *     carries markup a browser would run (an SVG) and anything unrecognised is
 *     not kept, and the reason is said in words. Nothing here opens, runs or
 *     unpacks what it keeps: a document is read later, if at all, in the
 *     sandboxed browser, as every document is.
 *   - **It is written once.** The file is created and never replaced, and not
 *     through a link: a retry after a crash finds the file it already wrote
 *     (the same bytes under the same name is the same file), and anything else
 *     under that name is refused.
 */
import { PalugadaError } from '../errors.ts';
import { companyRoot, plainFileName } from '../capabilities/files.ts';
import { pictureKind } from '../capabilities/vision.ts';

/** One file, in bytes; a message's files together; and how many a message may carry. */
export const RECEIVED_FILE_MAX = 10 * 1024 * 1024;
export const RECEIVED_MESSAGE_MAX = 15 * 1024 * 1024;
export const RECEIVED_PER_MESSAGE = 5;
/** What a company keeps of what strangers sent, altogether and in one day, so that nobody can fill the disk. */
export const RECEIVED_COMPANY_MAX = 2 * 1024 * 1024 * 1024;
export const RECEIVED_DAY_MAX = 500 * 1024 * 1024;
/** The longest text kept as a file: a document converted from one is held to the same. */
const TEXT_FILE_MAX = 5_000_000;
/** The folder every received file is under. */
export const RECEIVED_FOLDER = 'received';

/** What a kept file is: the word the console and a role use for it. */
export type KeptKind = 'pdf' | 'word' | 'excel' | 'photo' | 'voice' | 'text';

/**
 * Why a file was not kept, as a word the console says in the owner's language:
 * too big, a kind that is never kept, no room left, a deployment that keeps no
 * files, or a failure to fetch or write it. `note` is the same in a sentence
 * for the run that is told.
 */
export type NotKeptWhy = 'too_big' | 'kind' | 'room' | 'no_files' | 'failed';

/** One file of a message as it is recorded (`chat_messages.files`): the path is null when it was not kept, and `note` says why. */
export interface ReceivedFile {
  kind: string;
  /** The name the sender gave it, made plain and short: theirs, so data. */
  name: string | null;
  path: string | null;
  bytes: number;
  note: string | null;
  why: NotKeptWhy | null;
}

const text = (bytes: Buffer, at: number, length: number) => bytes.subarray(at, at + length).toString('latin1');

/** What the bytes are, by how they begin; or why they are not kept. */
export function sniffReceived(bytes: Buffer, claimedName: string | null): { kind: KeptKind; ext: string } | { refused: string } {
  if (bytes.length === 0) return { refused: 'it is empty' };
  const head = bytes.subarray(0, 1024);
  if (head.includes('%PDF-')) return { kind: 'pdf', ext: 'pdf' };

  if (text(bytes, 0, 2) === 'MZ' || text(bytes, 1, 3) === 'ELF' || text(bytes, 0, 2) === '#!'
    || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(bytes.readUInt32BE(0))) {
    return { refused: 'it is a program or a script, which is never kept' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return { refused: 'it is an Office file from before 2007 (.doc, .xls), which can carry macros: ask for a .docx or .xlsx' };
  }
  if (text(bytes, 0, 2) === 'PK' && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const claimed = (claimedName ?? '').toLowerCase();
    if (/\.(docm|xlsm|pptm|dotm|xltm)$/.test(claimed)) return { refused: 'it is an Office file with macros, which is never kept' };
    if (/\.docx$/.test(claimed)) {
      return bytes.includes('word/document.xml') ? { kind: 'word', ext: 'docx' } : { refused: 'it says it is a Word document and is not one' };
    }
    if (/\.xlsx$/.test(claimed)) {
      return bytes.includes('xl/workbook.xml') ? { kind: 'excel', ext: 'xlsx' } : { refused: 'it says it is an Excel workbook and is not one' };
    }
    return { refused: 'it is an archive or a kind of Office file this platform does not read, and is not kept' };
  }
  if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || text(bytes, 0, 4) === 'Rar!' || bytes.subarray(0, 4).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf]))) {
    return { refused: 'it is an archive, which is never kept' };
  }

  const picture = pictureKind(bytes);
  if (picture) return { kind: 'photo', ext: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[picture]! };

  if (text(bytes, 0, 4) === 'OggS') return { kind: 'voice', ext: 'ogg' };
  if (text(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return { kind: 'voice', ext: 'mp3' };
  if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WAVE') return { kind: 'voice', ext: 'wav' };
  if (text(bytes, 4, 4) === 'ftyp') {
    return text(bytes, 8, 4) === 'M4A ' ? { kind: 'voice', ext: 'm4a' } : { refused: 'it is a video, which is not kept' };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { refused: 'it is a kind of file this platform does not keep' };
  }
  if (decoded.includes('\u0000')) return { refused: 'it is a kind of file this platform does not keep' };
  if (bytes.length > TEXT_FILE_MAX) return { refused: 'it is text over 5 MB' };
  if (/^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(decoded.slice(0, 2_000))) {
    return { refused: 'it is an SVG picture, which can carry scripts, and is never kept' };
  }
  // Markup is kept as the text it is and never named for what it claims to be: it is only ever downloaded as bytes.
  const claimed = /\.([a-z0-9]{1,8})$/i.exec(claimedName ?? '')?.[1]?.toLowerCase() ?? '';
  if (claimed === 'csv' || claimed === 'md') return { kind: 'text', ext: claimed };
  if (claimed === 'json') {
    try {
      JSON.parse(decoded);
      return { kind: 'text', ext: 'json' };
    } catch {
      return { kind: 'text', ext: 'txt' };
    }
  }
  return { kind: 'text', ext: 'txt' };
}

/** A name the sender gave, made plain and short for display; null when nothing readable is left of it. */
export function displayName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return [...plainFileName(raw.slice(0, 255))].slice(0, 100).join('');
  } catch {
    return null;
  }
}

/**
 * Writes one stranger's file where this platform decides, or says why it did
 * not. Never throws for what the sender chose: a refusal is a note.
 */
export async function keepReceivedFile(input: {
  root: string;
  companyId: string;
  /** The channel's kind: `email`'s files are under `mail`. */
  channel: string;
  at: Date;
  /** The message's id: the first eight characters name the file. */
  messageId: string;
  position: number;
  bytes: Buffer;
  claimedName: string | null;
}): Promise<{ kept: { kind: KeptKind; path: string; bytes: number; sha256: string } } | { note: string; why: NotKeptWhy }> {
  const { lstat, mkdir, open } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');

  if (input.bytes.length > RECEIVED_FILE_MAX) return { note: `it is over ${RECEIVED_FILE_MAX / 1_048_576} MB`, why: 'too_big' };
  const sniffed = sniffReceived(input.bytes, input.claimedName);
  if ('refused' in sniffed) return { note: sniffed.refused, why: sniffed.refused === 'it is text over 5 MB' ? 'too_big' : 'kind' };

  const channel = input.channel === 'email' ? 'mail' : input.channel;
  const stem = /^[0-9a-f]{8}/.exec(input.messageId)?.[0];
  if (!stem || !/^[a-z]{2,16}$/.test(channel) || !Number.isInteger(input.position) || input.position < 1 || input.position > 9) {
    throw new PalugadaError('contract.violation', 'a received file is named by its channel, its message and its place in it', {});
  }
  const month = input.at.toISOString().slice(0, 7);
  const name = `${stem}-${input.position}.${sniffed.ext}`;

  // Folder by folder, so that a link put where one goes is found before anything is made beyond it.
  let here = await companyRoot(input.root, input.companyId);
  try {
    for (const part of [RECEIVED_FOLDER, channel, month]) {
      here = join(here, part);
      const found = await lstat(here).catch(() => null);
      if (found === null) await mkdir(here);
      else if (!found.isDirectory()) return { note: 'the company\'s files have a link where received files go, so nothing was written', why: 'failed' };
    }
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'EEXIST') return { note: 'the folder for received files changed while it was being made', why: 'failed' };
    throw failure;
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const path = `${RECEIVED_FOLDER}/${channel}/${month}/${name}`;
  let handle;
  try {
    handle = await open(join(here, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
    // A retry after a crash finds what it wrote: the same bytes under the same name is the same file.
    const there = await open(join(here, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    const bytes = there ? await there.readFile().finally(() => there.close()) : null;
    if (bytes && createHash('sha256').update(bytes).digest('hex') === sha256) {
      return { kept: { kind: sniffed.kind, path, bytes: input.bytes.length, sha256 } };
    }
    return { note: 'a different file is already kept under the name this one would have', why: 'failed' };
  }
  try {
    await handle.writeFile(input.bytes);
  } catch (failure) {
    await handle.close().catch(() => undefined);
    const { unlink } = await import('node:fs/promises');
    await unlink(join(here, name)).catch(() => undefined);
    throw failure;
  }
  await handle.close();
  return { kept: { kind: sniffed.kind, path, bytes: input.bytes.length, sha256 } };
}

/**
 * The bytes of a file the console sent: base64, or a `data:` URL as a page
 * reads one. Checked before it is decoded, because `Buffer.from` takes what it
 * can read of a base64 string and drops the rest without saying so.
 */
export function base64Bytes(value: unknown): Buffer {
  const text = typeof value === 'string' ? value.replace(/^data:[^,]*;base64,/, '') : '';
  if (typeof value !== 'string' || (value.startsWith('data:') && text === value)) {
    throw new PalugadaError('contract.violation', 'data is the file, in base64', { field: 'data' });
  }
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new PalugadaError('contract.violation', 'data is the file, in base64', { field: 'data' });
  }
  return Buffer.from(text, 'base64');
}

/** One file an answer carried, as the item records it and the run that asked is told. */
export interface AnswerFile {
  kind: string;
  /** What the person called it, made plain and short: theirs, so data. */
  name: string | null;
  path: string;
  bytes: number;
}

/** The folder a person's answers are kept under, beside what customers sent. */
export const ANSWER_CHANNEL = 'answers';

/**
 * The files an answer carries, kept where the run that asked can read them.
 *
 * A person is not a stranger, but what they attach is read later like any
 * outside content, so it is kept the way a customer's attachment is: named
 * here and not by them, its kind told by its bytes, and a program or an
 * archive not kept at all. All of them are looked at before any is written,
 * so a file that is refused refuses the answer and leaves nothing behind: the
 * person is told which one and why, and answers again.
 */
export async function keepAnswerFiles(root: string, companyId: string, itemId: string, files: unknown): Promise<AnswerFile[]> {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) {
    throw new PalugadaError('contract.violation', 'files is a list of { name, data }, the file in base64', { field: 'files' });
  }
  if (files.length > RECEIVED_PER_MESSAGE) {
    throw new PalugadaError('contract.violation', `an answer carries at most ${RECEIVED_PER_MESSAGE} files; this one has ${files.length}`, { field: 'files' });
  }
  const looked = files.map((one: unknown) => {
    const given = one as { name?: unknown; data?: unknown } | null;
    const claimed = typeof given?.name === 'string' && given.name.trim() ? given.name : null;
    if (!claimed) throw new PalugadaError('contract.violation', 'each file needs a name, as { name, data }', { field: 'files' });
    const shown = displayName(claimed) ?? 'a file';
    const bytes = base64Bytes(given?.data);
    if (bytes.length === 0) throw new PalugadaError('contract.violation', `${shown} is empty`, { field: 'files' });
    if (bytes.length > RECEIVED_FILE_MAX) {
      throw new PalugadaError('contract.violation', `${shown} is over ${RECEIVED_FILE_MAX / 1_048_576} MB, which is as much as one file may be`, { field: 'files' });
    }
    const sniffed = sniffReceived(bytes, claimed);
    if ('refused' in sniffed) throw new PalugadaError('contract.violation', `${shown} was not kept: ${sniffed.refused}`, { field: 'files' });
    return { claimed, shown, bytes };
  });
  if (looked.reduce((sum, one) => sum + one.bytes.length, 0) > RECEIVED_MESSAGE_MAX) {
    throw new PalugadaError('contract.violation', `the files of an answer are at most ${RECEIVED_MESSAGE_MAX / 1_048_576} MB together`, { field: 'files' });
  }
  const at = new Date();
  const kept: AnswerFile[] = [];
  for (const [index, one] of looked.entries()) {
    const result = await keepReceivedFile({
      root, companyId, channel: ANSWER_CHANNEL, at, messageId: itemId, position: index + 1, bytes: one.bytes, claimedName: one.claimed,
    });
    if ('note' in result) throw new PalugadaError('contract.violation', `${one.shown} was not kept: ${result.note}`, { field: 'files' });
    kept.push({ kind: result.kept.kind, name: displayName(one.claimed), path: result.kept.path, bytes: result.kept.bytes });
  }
  return kept;
}
