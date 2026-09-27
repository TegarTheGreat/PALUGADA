/**
 * The text of a Word document (.docx), read in the owner's browser.
 *
 * A .docx is a zip holding `word/document.xml`. The zip's central directory
 * says where each entry is, and an entry is deflated, which the platform's
 * own DecompressionStream inflates: no library, and nothing binary ever
 * reaches the server, which is sent the text the owner sees in the form.
 *
 * Paragraphs become paragraphs, a heading becomes a Markdown heading -- so
 * the passages the server cuts stay under the headings they sit beneath --
 * a list item becomes "- ", and a table row becomes one line with its cells
 * between " | ". A heading is known by its style's outline level or its
 * style's name ("heading 1"), both of which Word writes in English whatever
 * the language of the Word that saved it; the style's id ("Judul1") is not.
 */

/**
 * Why a file could not be read, for the form to say in the owner's language:
 * this module touches nothing of the page, so the suite can run it.
 */
export class DocxUnreadable extends Error {
  readonly reason: 'not_a_docx' | 'packing';

  constructor(reason: 'not_a_docx' | 'packing') {
    super(reason);
    this.reason = reason;
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of a zip by name, as their compressed bytes and how they were compressed. */
function entriesOf(bytes: Uint8Array): Map<string, { method: number; data: Uint8Array }> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last 22 bytes, unless a comment follows it.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at -= 1) {
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const entries = new Map<string, { method: number; data: Uint8Array }>();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) return null;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL) return null;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.set(name, { method, data: bytes.subarray(start, start + size) });
    at += 46 + skip;
  }
  return entries;
}

async function inflate(entry: { method: number; data: Uint8Array }): Promise<string> {
  if (entry.method === 0) return new TextDecoder().decode(entry.data);
  if (entry.method !== 8) throw new DocxUnreadable('packing');
  const stream = new Blob([entry.data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A heading level for each paragraph style that is one, from styles.xml. */
function headingStyles(styles: string): Map<string, number> {
  const levels = new Map<string, number>();
  for (const [, id, body] of styles.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(body!)?.[1];
    const name = /<w:name w:val="([^"]+)"/.exec(body!)?.[1] ?? '';
    const named = /^heading (\d)$/i.exec(name)?.[1] ?? (/^title$/i.test(name) ? '1' : undefined);
    const level = outline !== undefined ? Number(outline) + 1 : named !== undefined ? Number(named) : null;
    if (level !== null && level >= 1 && level <= 6) levels.set(id!, level);
  }
  return levels;
}

/** The words of a run of XML, in order: text, tabs and breaks. */
function wordsOf(xml: string): string {
  let words = '';
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
    if (match[1] !== undefined) words += decode(match[1]);
    else words += match[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return words;
}

/** The text of a .docx, as paragraphs with Markdown headings. */
export async function textOfDocx(bytes: Uint8Array): Promise<string> {
  const entries = entriesOf(bytes);
  const document = entries?.get('word/document.xml');
  if (!entries || !document) throw new DocxUnreadable('not_a_docx');
  const styles = entries.get('word/styles.xml');
  const headings = styles ? headingStyles(await inflate(styles)) : new Map<string, number>();
  const xml = await inflate(document);

  // A table row, as one paragraph of its cells.
  const flat = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) => wordsOf(cell[0]).trim());
    return `<w:p><w:r><w:t>${cells.join(' | ').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
  });
  const paragraphs: string[] = [];
  for (const [whole] of flat.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const words = wordsOf(whole).trim();
    if (!words) continue;
    const properties = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(whole)?.[1] ?? '';
    const style = /<w:pStyle w:val="([^"]+)"/.exec(properties)?.[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(properties)?.[1];
    const level = outline !== undefined ? Number(outline) + 1 : style ? headings.get(style) : undefined;
    if (level) paragraphs.push(`${'#'.repeat(Math.min(level, 6))} ${words.replace(/\s+/g, ' ')}`);
    else if (/<w:numPr>/.test(properties)) paragraphs.push(`- ${words}`);
    else paragraphs.push(words);
  }
  return paragraphs.join('\n\n');
}
