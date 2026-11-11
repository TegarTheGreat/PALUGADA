/**
 * Reading a ZIP, as a Slack export is one (F19.23; STATUS section 2.214).
 *
 * A minimal central-directory reader: stored and deflated entries, and the
 * ZIP64 end records a large export needs, since a workspace's export holds a
 * file per channel per day and passes 65,535 entries soon enough. Nothing
 * else of the format is read -- no encryption, no other method, no archive
 * split over disks -- and an entry that uses any of it is refused by name.
 * It uses `node:zlib` and no dependency, because what it reads is a
 * stranger's file and a smaller reader is a smaller thing to trust.
 *
 * An export is the owner's upload, and still bytes from outside: a ZIP can
 * say one size and unpack to another, or unpack a few kilobytes to
 * gigabytes. So every entry is unpacked with a cap on what it may become
 * (`maxOutputLength`), whatever its header says: 64 MB for one entry, 2 GB
 * for the whole export, and no more than 200 times what it was packed to.
 * Past any of them the entry is refused as `import.too_large`, and nothing
 * larger than the cap is ever held. What an entry unpacked to counts toward
 * the export's cap whether or not it then passes its check, so entries that
 * fail are no way round it. Each entry's CRC is checked, so a part cut short
 * or damaged on its way is found, rather than read as words. And no two
 * entries may share bytes: a directory that names one entry's bytes under
 * many names, or one entry inside another's, would have them unpacked again
 * and again from a file a fraction of the size, so it is no ZIP read here.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { PalugadaError } from '../errors.ts';

/** Bytes that can be read anywhere: the export's parts, laid end to end. */
export interface RandomAccess {
  readonly size: number;
  read(position: number, length: number): Promise<Buffer>;
}

/** One entry, as the central directory names it. */
export interface ZipEntry {
  /** Its place in the directory, from 0. */
  readonly index: number;
  readonly name: string;
  /** 0 stored, 8 deflated; anything else is refused when it is read. */
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  /** What it was packed to, and what it says it unpacks to. */
  readonly compressed: number;
  readonly size: number;
  /** Where its local header starts. */
  readonly offset: number;
}

/** What one reader allows: the caps an export is read under, smaller where a caller asks. */
export interface ZipLimits {
  /** What one entry may unpack to. */
  entryBytes?: number;
  /** What every entry together may unpack to. */
  totalBytes?: number;
  /** How many times its packed size an entry may unpack to. */
  ratio?: number;
}

const ENTRY_BYTES = 64 * 1024 * 1024;
const TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const RATIO = 200;
/** The central directory itself, read whole: a million entries at most, and what they take. */
const DIRECTORY_BYTES = 256 * 1024 * 1024;
const ENTRIES_MOST = 1_000_000;

const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The largest end record: its 22 bytes and the longest comment. */
const END_SEARCH = 22 + 0xffff;

/** The whole file is no ZIP this reader reads. */
function notAZip(why: string): PalugadaError {
  return new PalugadaError('import.zip', `that is not a ZIP PALUGADA reads: ${why}`, {});
}

/** One entry cannot be read; the rest of the file may be. */
function broken(entry: ZipEntry, why: string): PalugadaError {
  return new PalugadaError('import.zip', `${entry.name} cannot be read: ${why}`, { entry: entry.name });
}

function tooLarge(entry: ZipEntry, why: string): PalugadaError {
  return new PalugadaError('import.too_large', `${entry.name} unpacks to more than PALUGADA reads at once: ${why}`,
    { entry: entry.name });
}

/** A 64-bit field as a number: every size here is far below 2^53, and one that is not is refused. */
function big(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw notAZip('a size past what any export holds');
  return Number(value);
}

/**
 * Opens a ZIP: finds its end record (and the ZIP64 one when the short one
 * cannot say), and reads its central directory whole. Answers the entries in
 * the directory's order; nothing is unpacked yet.
 */
export async function openZip(source: RandomAccess, limits: ZipLimits = {}): Promise<ZipReader> {
  if (source.size < 22) throw notAZip('it is shorter than any ZIP');
  const tailLength = Math.min(source.size, END_SEARCH);
  const tail = await source.read(source.size - tailLength, tailLength);
  // The last end record whose comment reaches exactly to the end of the file.
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) === END && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw notAZip('no end of a central directory');
  const endAt = source.size - tailLength + end;
  let disk = tail.readUInt16LE(end + 4);
  let directoryDisk = tail.readUInt16LE(end + 6);
  let count = tail.readUInt16LE(end + 10);
  let directorySize = tail.readUInt32LE(end + 12);
  let directoryAt = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
    // ZIP64: the locator sits just before the short end record, and names the long one.
    if (endAt < 20) throw notAZip('a ZIP64 export without its locator');
    const locator = await source.read(endAt - 20, 20);
    if (locator.readUInt32LE(0) !== LOCATOR64) throw notAZip('a ZIP64 export without its locator');
    const end64At = big(locator, 8);
    if (end64At + 56 > endAt) throw notAZip('a ZIP64 end record outside the file');
    const end64 = await source.read(end64At, 56);
    if (end64.readUInt32LE(0) !== END64) throw notAZip('a ZIP64 locator that names no ZIP64 end record');
    disk = end64.readUInt32LE(16);
    directoryDisk = end64.readUInt32LE(20);
    count = big(end64, 32);
    directorySize = big(end64, 40);
    directoryAt = big(end64, 48);
  }
  if (disk !== 0 || directoryDisk !== 0) throw notAZip('an archive split over several disks');
  if (count > ENTRIES_MOST) throw notAZip(`more than ${ENTRIES_MOST} entries`);
  if (directorySize > DIRECTORY_BYTES || directoryAt + directorySize > endAt) throw notAZip('a central directory outside the file');
  const directory = await source.read(directoryAt, directorySize);

  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw notAZip(`entry ${index + 1} of the directory is cut short`);
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16);
    let compressed = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    let entryDisk = directory.readUInt16LE(at + 34);
    let offset = directory.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) throw notAZip(`entry ${index + 1} of the directory is cut short`);
    const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
    // The ZIP64 extra field holds, in this order, each field the record could not.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        const fieldEnd = Math.min(field + length, extraEnd);
        const take = (): number => {
          if (field + 8 > fieldEnd) throw notAZip(`entry ${name} has a ZIP64 field cut short`);
          const value = big(directory, field);
          field += 8;
          return value;
        };
        if (size === 0xffffffff) size = take();
        if (compressed === 0xffffffff) compressed = take();
        if (offset === 0xffffffff) offset = take();
        if (entryDisk === 0xffff && field + 4 <= fieldEnd) entryDisk = directory.readUInt32LE(field);
      }
      extra += 4 + length;
    }
    if (entryDisk !== 0) throw notAZip('an archive split over several disks');
    entries.push({ index, name, method, flags, crc, compressed, size, offset });
    at = next;
  }
  return new ZipReader(source, entries, endsOf(entries, directoryAt), {
    entryBytes: limits.entryBytes ?? ENTRY_BYTES,
    totalBytes: limits.totalBytes ?? TOTAL_BYTES,
    ratio: limits.ratio ?? RATIO,
  });
}

/**
 * Where each entry's bytes must end: at the next entry's local header in the
 * file, or at the central directory after the last. Refuses a directory whose
 * entries share a local header, or where one entry starts before the bytes
 * the one before it says it packed have ended. Answers, by entry index, the
 * offset its data may not run past.
 */
function endsOf(entries: readonly ZipEntry[], directoryAt: number): Float64Array {
  const ends = new Float64Array(entries.length);
  const inFile = [...entries].sort((a, b) => a.offset - b.offset);
  for (let at = 0; at < inFile.length; at += 1) {
    const entry = inFile[at]!;
    const next = inFile[at + 1]?.offset ?? directoryAt;
    // A local header is thirty bytes before its name, and its packed bytes come after.
    if (entry.offset + 30 + entry.compressed > next) {
      throw notAZip(next === directoryAt ? `${entry.name} runs into the central directory` : `${entry.name} shares its bytes with another entry`);
    }
    ends[entry.index] = next;
  }
  return ends;
}

/** An opened ZIP: its entries, and each one's bytes on request, within the reader's caps. */
export class ZipReader {
  readonly entries: readonly ZipEntry[];
  readonly #source: RandomAccess;
  readonly #limits: Required<ZipLimits>;
  /** Where each entry's bytes must end, by its index. */
  readonly #ends: Float64Array;
  /** What every entry read so far unpacked to, each counted once however often it is read, and whether it passed its check or not. */
  #total = 0;
  readonly #counted = new Set<number>();

  constructor(source: RandomAccess, entries: readonly ZipEntry[], ends: Float64Array, limits: Required<ZipLimits>) {
    this.#source = source;
    this.entries = entries;
    this.#ends = ends;
    this.#limits = limits;
  }

  /** Counts what an entry unpacked to, or might have before it was stopped, the first time it is read. */
  #count(entry: ZipEntry, bytes: number): void {
    if (this.#counted.has(entry.index)) return;
    this.#counted.add(entry.index);
    this.#total += bytes;
  }

  /**
   * One entry's bytes, unpacked and checked against its CRC. Refused as
   * `import.too_large` past a cap, and as `import.zip` naming the entry when
   * it is encrypted, packed some other way, or damaged.
   */
  async read(entry: ZipEntry): Promise<Buffer> {
    const { entryBytes, totalBytes, ratio } = this.#limits;
    if (entry.flags & 0x0001) throw broken(entry, 'it is encrypted');
    if (entry.method !== 0 && entry.method !== 8) throw broken(entry, `it is packed with method ${entry.method}`);
    const left = this.#counted.has(entry.index) ? totalBytes : totalBytes - this.#total;
    // What it says it is, first: the cheap refusal, before anything is read.
    if (entry.size > entryBytes) throw tooLarge(entry, `it says ${entry.size} bytes, and one entry may be ${entryBytes}`);
    if (entry.size > left) throw tooLarge(entry, `the export would unpack past ${totalBytes} bytes`);
    if (entry.method === 8 && entry.size > ratio * Math.max(entry.compressed, 1)) {
      throw tooLarge(entry, `it says it unpacks to more than ${ratio} times what it was packed to`);
    }
    if (entry.compressed > entryBytes + 1024 * 1024) throw tooLarge(entry, `it is packed to ${entry.compressed} bytes`);
    const header = await this.#source.read(entry.offset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw broken(entry, 'its local header is not where the directory says');
    const dataAt = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (dataAt + entry.compressed > this.#source.size) throw broken(entry, 'it runs past the end of the file');
    if (dataAt + entry.compressed > this.#ends[entry.index]!) throw broken(entry, 'it runs into the entry after it');
    const packed = await this.#source.read(dataAt, entry.compressed);
    let bytes: Buffer;
    if (entry.method === 0) {
      bytes = packed;
    } else {
      // And what it becomes, whatever it said: never more than the smallest cap.
      const cap = Math.max(1, Math.min(entryBytes, left, ratio * Math.max(entry.compressed, 1)));
      try {
        bytes = inflateRawSync(packed, { maxOutputLength: cap });
      } catch (error) {
        // Stopped at the cap, or damaged part way: it may have unpacked as far as the cap first.
        this.#count(entry, cap);
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
          throw tooLarge(entry, `it unpacks past ${cap} bytes`);
        }
        throw broken(entry, 'its packed bytes are damaged');
      }
    }
    this.#count(entry, bytes.length);
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw broken(entry, 'its bytes are not the ones it was packed from');
    return bytes;
  }
}
