/**
 * A QR code, drawn in a terminal, for the owner's first authenticator.
 *
 * `npm run setup` makes the owner's second factor, and the owner has to get
 * it into a phone. Typing thirty-two letters of base32 into an authenticator
 * is where a first installation goes wrong; pointing the camera at the
 * terminal is not. The console cannot show it, because signing in to the
 * console is what the factor is for.
 *
 * Written here rather than taken as a dependency: it is one encoding (bytes),
 * one error-correction level (M, which survives a smudged screen), and the
 * whole of it is the standard's arithmetic, laid out as ISO/IEC 18004 and
 * Project Nayuki's reference implementation describe it. A package would
 * bring the other three encodings, image output and its own dependencies to
 * draw one square once per installation.
 */

/** Level M: about 15% of the code can be lost and it still reads. */
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
/** Level M's two bits in the format information. */
const FORMAT_BITS_M = 0;

/** Every module a symbol has that is not a finder, timing or alignment pattern, or format or version information. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version]! * BLOCKS_M[version]!;
}

/* ---------------------------------------------------- Reed-Solomon, GF(256) --- */

function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j]!, root) ^ (j + 1 < result.length ? result[j + 1]! : 0);
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], by: readonly number[]): number[] {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    by.forEach((coefficient, i) => { result[i] = result[i]! ^ multiply(coefficient, factor); });
  }
  return result;
}

/* ------------------------------------------------------------------ the symbol --- */

/**
 * The modules of the smallest QR code that holds `text` as UTF-8 bytes at
 * level M: `true` is dark. Refused past version 40, which no URI this
 * platform makes comes near.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')];
  let version = 1;
  for (; ; version += 1) {
    if (version > 40) throw new RangeError(`${bytes.length} bytes do not fit in a QR code at level M`);
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }

  // Byte mode, the count, the bytes; then the terminator, padding to a byte,
  // and the two pad bytes the standard alternates until the capacity is full.
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const codewords = withErrorCorrection(version, data);
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };
  drawFunctionPatterns(version, size, set);
  drawCodewords(codewords, size, modules, reserved);

  // The mask that leaves the fewest patterns a reader could mistake for
  // structure, with its format information drawn, as the standard chooses.
  let best: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => [...row]);
    applyMask(mask, size, candidate, reserved);
    drawFormat(mask, size, (x, y, dark) => { candidate[y]![x] = dark; });
    const score = penalty(candidate, size);
    if (score < bestPenalty) {
      best = candidate;
      bestPenalty = score;
    }
  }
  return best!;
}

function withErrorCorrection(version: number, data: readonly number[]): number[] {
  const blocks = BLOCKS_M[version]!;
  const eccLength = ECC_PER_BLOCK_M[version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const by = divisor(eccLength);
  const split: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    const ecc = remainder(block, by);
    // Short blocks carry a gap where the long ones have one more data byte,
    // so the interleave below reads the same column from each.
    if (i < shortBlocks) block.push(-1);
    split.push([...block, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < split[0]!.length; i += 1) {
    split.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

function drawFunctionPatterns(version: number, size: number, set: (x: number, y: number, dark: boolean) => void): void {
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  positions.forEach((cx, i) => positions.forEach((cy, j) => {
    const onFinder = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
    if (onFinder) return;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));
  // Reserved now and drawn for each mask; the dark module is fixed.
  drawFormat(0, size, set);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

function drawFormat(mask: number, size: number, set: (x: number, y: number, dark: boolean) => void): void {
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawCodewords(codewords: readonly number[], size: number, modules: boolean[][], reserved: boolean[][]): void {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i += 1;
        }
      }
    }
  }
}

function applyMask(mask: number, size: number, modules: boolean[][], reserved: boolean[][]): void {
  const flips: Array<(x: number, y: number) => boolean> = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const flip = flips[mask]!;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!reserved[y]![x] && flip(x, y)) modules[y]![x] = !modules[y]![x];
    }
  }
}

/** The standard's four penalties: runs, blocks, finder look-alikes, and imbalance. */
function penalty(modules: boolean[][], size: number): number {
  let result = 0;
  const lines = (horizontal: boolean) => Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_unused, j) => (horizontal ? modules[i]![j]! : modules[j]![i]!)));
  for (const line of [...lines(true), ...lines(false)]) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) result += 3 + (run - 5);
        run = 1;
      }
    }
    // 1:1:3:1:1 with four light modules on either side, the light border
    // outside the symbol counting as light.
    const padded = [false, false, false, false, ...line, false, false, false, false];
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= padded.length; i += 1) {
      if (!pattern.every((dark, k) => padded[i + k] === dark)) continue;
      const before = i >= 4 && [0, 1, 2, 3].every((k) => !padded[i - 1 - k]);
      const after = i + 11 <= padded.length && [0, 1, 2, 3].every((k) => !padded[i + 7 + k]);
      if (before) result += 40;
      if (after) result += 40;
    }
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const dark = modules[y]![x];
      if (dark === modules[y]![x + 1] && dark === modules[y + 1]![x] && dark === modules[y + 1]![x + 1]) result += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  result += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return result;
}

/**
 * The code as terminal text: two modules to a character, dark on light
 * whatever the terminal's own colours, with the quiet zone a reader needs.
 */
export function qrForTerminal(modules: boolean[][]): string {
  const quiet = 2;
  const size = modules.length + quiet * 2;
  const at = (x: number, y: number) =>
    modules[y - quiet]?.[x - quiet] ?? false;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x += 1) {
      // The upper half block in the upper module's colour, on the lower one's.
      line += `\x1b[${at(x, y) ? 30 : 97};${y + 1 < size && at(x, y + 1) ? 40 : 107}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}
