/**
 * Reads the Markdown a model writes into blocks and inline spans a page can
 * draw -- and nothing else (the owner's complaint of 6 October: "hasil kerja
 * acak acakan format teksnya gajelas").
 *
 * An agent answers in Markdown: a heading, a list, `**bold**`, a table. The
 * console showed every asterisk and pound sign as typed. This is a reader for
 * what models actually write, small enough to be checked by eye, with no
 * dependency (the reason would have to be written next to it, and there is
 * none a few hundred lines do not answer).
 *
 * **What it will not do is the point.** It produces a tree, never HTML, so
 * there is no markup in it to run. There is no image: an image's address is a
 * way to tell a stranger that this page was opened, so `![x](url)` is its
 * words and nothing is fetched. A link is followed only if it is http, https
 * or mail (`safeAddress`); any other is its label and its address as text.
 * And it is bounded -- the input, the lines, the nesting, how far an emphasis
 * may reach -- so a hostile string of asterisks costs a moment, not a freeze.
 * What an agent writes is read; it is never given the page.
 *
 * Text that is not Markdown at all comes out as it went in: single line breaks
 * kept, underscores inside words, a lone asterisk and a pound sign in prose
 * left alone.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export interface Item {
  c: Inline[];
  sub: Block | null;
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'ul'; items: Item[] }
  | { t: 'ol'; start: number; items: Item[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'pre'; v: string }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

/** More than this is not a message but a file; the rest is not read. */
const MOST_CHARACTERS = 100_000;
const MOST_LINES = 3_000;
/** A line longer than this is one the reader does not look inside for emphasis. */
const MOST_LINE = 4_000;
/** How far an emphasis or a link may reach to find its end. */
const REACH = 2_000;
const MOST_DEPTH = 4;
const MOST_COLUMNS = 20;
const MOST_ROWS = 200;
const MOST_ITEMS = 500;

/** The only places a link goes. */
export function safeAddress(address: string): string | null {
  const trimmed = address.trim();
  return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(trimmed) ? trimmed : null;
}

/* -------------------------------------------------------------- inline --- */

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>~]/;

function parseInline(source: string, depth = 0): Inline[] {
  const src = source.length > MOST_LINE ? source.slice(0, MOST_LINE) : source;
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) {
      out.push({ t: 'text', v: text });
      text = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run += 1;
      const mark = '`'.repeat(run);
      const end = src.indexOf(mark, i + run);
      if (end !== -1 && end - i <= REACH && src[end + run] !== '`') {
        flush();
        out.push({ t: 'code', v: src.slice(i + run, end).replace(/^ (.*) $/, '$1') });
        i = end + run;
        continue;
      }
      text += mark;
      i += run;
      continue;
    }
    if (depth < MOST_DEPTH && (src.startsWith('**', i) || src.startsWith('__', i))) {
      const mark = src.slice(i, i + 2);
      const end = closing(src, mark, i + 2);
      if (end !== -1 && bounded(mark, src, i, end)) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < MOST_DEPTH && (ch === '*' || ch === '_') && src[i + 1] !== ch) {
      const end = closing(src, ch, i + 1);
      if (end !== -1 && bounded(ch, src, i, end)) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const link = bracketed(src, i + 1);
      if (link) {
        // An image is its words. Nothing is fetched.
        text += link.label;
        i = link.next;
        continue;
      }
    }
    if (ch === '[') {
      const link = bracketed(src, i);
      if (link) {
        const href = safeAddress(link.address);
        if (href && depth < MOST_DEPTH) {
          flush();
          out.push({ t: 'link', href, c: parseInline(link.label, depth + 1) });
        } else {
          text += `${link.label} (${link.address.trim()})`;
        }
        i = link.next;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      let end = i;
      while (end < src.length && !/[\s<>"']/.test(src[end]!)) end += 1;
      let address = src.slice(i, end);
      const trailing = /[.,;:!?)\]]+$/.exec(address)?.[0] ?? '';
      address = address.slice(0, address.length - trailing.length);
      const href = safeAddress(address);
      if (href) {
        flush();
        out.push({ t: 'link', href, c: [{ t: 'text', v: address }] });
        i += address.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/** The next unescaped `mark` within reach, or -1. */
function closing(src: string, mark: string, from: number): number {
  let at = from;
  for (;;) {
    const found = src.indexOf(mark, at);
    if (found === -1 || found - from > REACH) return -1;
    // Not an escaped one, and a single mark is not the first of a doubled one.
    if (src[found - 1] !== '\\' && !(mark.length === 1 && src[found + 1] === mark)) return found;
    at = found + mark.length;
  }
}

/** Emphasis has words inside it, none of them edge spaces; an underscore is emphasis only at a word's edge. */
function bounded(mark: string, src: string, open: number, close: number): boolean {
  const inner = src.slice(open + mark.length, close);
  if (inner === '' || /^\s|\s$/.test(inner)) return false;
  if (mark[0] === '_') {
    const before = open === 0 ? ' ' : src[open - 1]!;
    const after = src[close + mark.length] ?? ' ';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) return false;
  }
  return true;
}

/** `[label](address)` starting at the bracket, or null. */
function bracketed(src: string, at: number): { label: string; address: string; next: number } | null {
  const close = src.indexOf(']', at + 1);
  if (close === -1 || close - at > REACH || src[close + 1] !== '(') return null;
  const end = src.indexOf(')', close + 2);
  if (end === -1 || end - close > REACH) return null;
  return { label: src.slice(at + 1, close), address: src.slice(close + 2, end), next: end + 1 };
}

/* --------------------------------------------------------------- blocks --- */

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const indentOf = (line: string): number => (/^[ \t]*/.exec(line)![0]).replace(/\t/g, '    ').length;

function startsTable(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && next.includes('-') && TABLE_RULE.test(next);
}

function startsBlock(line: string, next: string | undefined): boolean {
  return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || startsTable(line, next);
}

function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').slice(0, MOST_COLUMNS).map((cell) => cell.trim());
}

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.slice(0, MOST_CHARACTERS).replace(/\r\n?/g, '\n').split('\n').slice(0, MOST_LINES);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(heading[2]!) });
      i += 1;
      continue;
    }
    if (RULE.test(line) && !LIST_ITEM.test(line)) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (startsTable(line, lines[i + 1])) {
      const head = cells(line).map((cell) => parseInline(cell));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '' && rows.length < MOST_ROWS) {
        rows.push(cells(lines[i]!).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (QUOTE.test(line) && depth < MOST_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ t: 'quote', c: parseMarkdown(inner.join('\n'), depth + 1) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i, 0);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    // A paragraph: lines until a blank one or the start of another block.
    const spans: Inline[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && (spans.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) {
      if (spans.length > 0) spans.push({ t: 'br' });
      spans.push(...parseInline(lines[i]!.trim()));
      i += 1;
    }
    blocks.push({ t: 'p', c: spans });
  }
  return blocks;
}

function parseList(lines: string[], at: number, depth: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[at]!)!;
  const indent = indentOf(lines[at]!);
  const ordered = /\d/.test(first[2]!);
  const start = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const items: Item[] = [];
  let i = at;
  while (i < lines.length && items.length < MOST_ITEMS) {
    const line = lines[i]!;
    if (line.trim() === '') {
      // One more of this list's items after a blank line is the same list.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j += 1;
      const next = j < lines.length ? LIST_ITEM.exec(lines[j]!) : null;
      if (next && indentOf(lines[j]!) >= indent && /\d/.test(next[2]!) === ordered) {
        i = j;
        continue;
      }
      break;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const here = indentOf(line);
      if (here === indent) {
        if (/\d/.test(item[2]!) !== ordered) break;
        items.push({ c: parseInline(item[3]!), sub: null });
        i += 1;
        continue;
      }
      if (here > indent && items.length > 0 && depth < MOST_DEPTH) {
        const sub = parseList(lines, i, depth + 1);
        items[items.length - 1]!.sub = sub.block;
        i = sub.next;
        continue;
      }
      break;
    }
    // A line under an item, indented further than its marker, goes on with its text.
    if (indentOf(line) > indent && items.length > 0 && !startsBlock(line, lines[i + 1])) {
      items[items.length - 1]!.c.push({ t: 'text', v: ' ' }, ...parseInline(line.trim()));
      i += 1;
      continue;
    }
    break;
  }
  return { block: ordered ? { t: 'ol', start, items } : { t: 'ul', items }, next: i };
}
