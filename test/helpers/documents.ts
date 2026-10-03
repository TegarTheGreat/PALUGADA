/**
 * Documents to test a reader with, written byte by byte: a PDF with its
 * offsets counted, and the ZIP files Word and Excel save -- a central
 * directory, each entry stored or deflated -- with the XML each keeps its
 * text in.
 *
 * Written rather than made by a library, like the mail servers beside this:
 * a document a library made is one the same library reads back.
 */
import { deflateRawSync } from 'node:zlib';

/** A PDF of pages, each a list of lines, in Helvetica as Windows writes Latin text. */
export function pdfOf(pages: string[][]): Buffer {
  const escape = (line: string) => [...line].map((char) => {
    const code = char.charCodeAt(0);
    if (char === '(' || char === ')' || char === '\\') return `\\${char}`;
    return code > 126 ? `\\${code.toString(8).padStart(3, '0')}` : char;
  }).join('');
  const objects: string[] = [];
  const font = 3 + pages.length * 2;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pages.map((_page, n) => `${3 + n * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((lines, n) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + n * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    const stream = `BT /F1 12 Tf 50 780 Td ${lines.map((line, i) => `${i === 0 ? '' : '0 -16 Td '}(${escape(line)}) Tj`).join(' ')} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A ZIP of named entries: deflated, as Office saves them, unless `stored`. */
export function zipOf(entries: Record<string, string | Buffer>, options: { stored?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = options.stored ? data : deflateRawSync(data);
    const method = options.stored ? 0 : 8;
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    locals.push(local, fileName, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Word document: paragraphs, then a table of rows. */
export function docxOf(paragraphs: string[], table: string[][] = []): Buffer {
  const runs = (text: string) => text.split('\t').map((piece, i) => `${i > 0 ? '<w:r><w:tab/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xml(piece)}</w:t></w:r>`).join('');
  const body = paragraphs.map((text) => `<w:p>${runs(text)}</w:p>`).join('')
    + (table.length > 0 ? `<w:tbl>${table.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p>${runs(cell)}</w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '');
  return zipOf({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  });
}

/** A spreadsheet: sheets of rows, a cell a string or a number; a Date is kept as Excel keeps one, a day number shown as a date. */
export function xlsxOf(sheets: Array<{ name: string; rows: Array<Array<string | number | Date | null>> }>): Buffer {
  const strings: string[] = [];
  const shared = (text: string) => {
    const at = strings.indexOf(text);
    if (at >= 0) return at;
    strings.push(text);
    return strings.length - 1;
  };
  const column = (n: number) => {
    let name = '';
    for (let rest = n + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
    return name;
  };
  const files: Record<string, string> = {};
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
      const ref = `${column(c)}${r + 1}`;
      if (cell === null) return '';
      if (cell instanceof Date) return `<c r="${ref}" s="1"><v>${cell.getTime() / 86_400_000 + 25_569}</v></c>`;
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      return `<c r="${ref}" t="s"><v>${shared(cell)}</v></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${S}"><sheetData>${rows}</sheetData></worksheet>`;
  });
  return zipOf({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_sheet, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${S}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ...files,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${S}" count="${strings.length}">${strings.map((text) => `<si><t xml:space="preserve">${xml(text)}</t></si>`).join('')}</sst>`,
  });
}
