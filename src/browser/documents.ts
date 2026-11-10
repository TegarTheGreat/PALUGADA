/**
 * A document's text, read inside the deployment's browser (`Browsers.convert`):
 * a PDF with pdf.js, a Word document and an Excel workbook from the XML in
 * their ZIP.
 *
 * Here rather than in this process because a document is an untrusted
 * binary, and parsing one is how a reader is broken into: the platform's
 * promise is that it parses none (console/src/pdf.ts reads PDFs in the
 * owner's browser for the same reason). This runs in a page of a context
 * made for the one document, offline, in a renderer Chromium keeps in its
 * sandbox (2.123) -- so a document that breaks pdf.js, the ZIP reading or
 * Chromium's XML parser has broken into a process with no files, no network
 * and nothing of the platform's.
 *
 * The ZIP is read with what the browser has: the central directory by hand,
 * each entry inflated with `DecompressionStream` and counted as it comes, so
 * a small file that unpacks to gigabytes is refused at the cap rather than
 * believed. Text is what a person reads: a Word document's paragraphs and
 * its tables row by row, a workbook's sheets one after another with their
 * cells by tabs and dates as dates, a PDF's lines as lines and its pages as
 * paragraphs. A failure is a word the caller says in a sentence.
 */

/** What a conversion can fail with. */
export type ConversionFailure = 'too-large' | 'unreadable' | 'encrypted' | 'no-text' | 'too-slow';

/** The most one entry of a ZIP may unpack to, and the most text a document may come to. */
export const UNPACKED_MAX = 32 * 1024 * 1024;
export const DOCUMENT_TEXT_MAX = 5_000_000;

/**
 * The function that runs in the page: `(kind, base64, libraries)`, answering
 * `{ text }` or `{ failure }`. Plain JavaScript, as a page takes it.
 */
export const CONVERT_SCRIPT = `async (kind, data, libraries) => {
  const UNPACKED_MAX = ${UNPACKED_MAX};
  const TEXT_MAX = ${DOCUMENT_TEXT_MAX};
  class Failure extends Error {}
  const fail = (word) => { throw new Failure(word); };
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const utf8 = new TextDecoder();

  const zip = () => {
    const view = new DataView(bytes.buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) fail('unreadable');
    const count = view.getUint16(end + 10, true);
    if (count > 10000) fail('too-large');
    let at = view.getUint32(end + 16, true);
    const entries = new Map();
    for (let n = 0; n < count; n += 1) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) fail('unreadable');
      const nameLength = view.getUint16(at + 28, true);
      entries.set(utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength)), {
        flags: view.getUint16(at + 8, true), method: view.getUint16(at + 10, true),
        packed: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true), local: view.getUint32(at + 42, true),
      });
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    const inflate = async (packed) => {
      const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > UNPACKED_MAX) { await reader.cancel().catch(() => {}); fail('too-large'); }
        parts.push(value);
      }
      const out = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { out.set(part, offset); offset += part.length; }
      return out;
    };
    return async (name) => {
      const found = entries.get(name);
      if (!found) return null;
      if (found.flags & 1) fail('encrypted');
      if (found.size > UNPACKED_MAX) fail('too-large');
      const local = found.local;
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) fail('unreadable');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const packed = bytes.subarray(start, start + found.packed);
      if (found.method === 0) return utf8.decode(packed);
      if (found.method === 8) {
        try {
          return utf8.decode(await inflate(packed));
        } catch (error) {
          if (error instanceof Failure) throw error;
          fail('unreadable');
        }
      }
      return fail('unreadable');
    };
  };
  const parse = (text) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) fail('unreadable');
    return doc;
  };
  const all = (node, name) => [...node.getElementsByTagNameNS('*', name)];
  const children = (node, name) => [...node.children].filter((child) => child.localName === name);
  const capped = (text) => { if (text.length > TEXT_MAX) fail('too-large'); return text; };

  const word = async () => {
    const entry = zip();
    const xml = await entry('word/document.xml');
    if (xml === null) fail('unreadable');
    const body = all(parse(xml), 'body')[0];
    if (!body) fail('unreadable');
    // What a run says: its text, a tab, a break; not what was deleted, nor a field's code.
    const said = (node) => {
      let text = '';
      for (const child of node.children) {
        const name = child.localName;
        if (name === 't') text += child.textContent;
        else if (name === 'tab') text += '\\t';
        else if (name === 'br' || name === 'cr') text += '\\n';
        else if (name === 'del' || name === 'delText' || name === 'instrText' || name === 'rPr' || name === 'pPr') continue;
        else text += said(child);
      }
      return text;
    };
    const lines = [];
    let size = 0;
    const block = (node) => {
      for (const child of node.children) {
        const name = child.localName;
        if (name === 'p') lines.push(said(child));
        else if (name === 'tbl') {
          if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
          for (const row of children(child, 'tr')) {
            lines.push(children(row, 'tc').map((cell) => all(cell, 'p').map(said).join(' ').replace(/\\s+/g, ' ').trim()).join('\\t'));
          }
          lines.push('');
        } else if (name === 'sdt') {
          for (const content of children(child, 'sdtContent')) block(content);
        } else if (name !== 'sectPr') {
          block(child);
        }
        size += (lines[lines.length - 1] ?? '').length;
        if (size > TEXT_MAX) fail('too-large');
      }
    };
    block(body);
    return lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  };

  const excel = async () => {
    const entry = zip();
    const books = await entry('xl/workbook.xml');
    if (books === null) fail('unreadable');
    const book = parse(books);
    const date1904 = all(book, 'workbookPr').some((one) => ['1', 'true'].includes(one.getAttribute('date1904') ?? ''));
    const relations = await entry('xl/_rels/workbook.xml.rels');
    const targets = new Map(relations === null ? [] : all(parse(relations), 'Relationship').map((one) => [one.getAttribute('Id'), one.getAttribute('Target') ?? '']));
    const sharedXml = await entry('xl/sharedStrings.xml');
    const shared = sharedXml === null ? [] : all(parse(sharedXml), 'si')
      .map((item) => all(item, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent).join(''));
    // Which styles show a number as a date: Excel's own date formats, and
    // any of the workbook's whose code has a day, month, year or hour in it.
    const dated = new Set();
    const stylesXml = await entry('xl/styles.xml');
    if (stylesXml !== null) {
      const styles = parse(stylesXml);
      const formats = new Map(all(styles, 'numFmt').map((one) => [Number(one.getAttribute('numFmtId')), one.getAttribute('formatCode') ?? '']));
      const isDate = (id) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47)
        || /[dmyh]/i.test((formats.get(id) ?? '').replace(/"[^"]*"|\\[[^\\]]*\\]|\\\\./g, ''));
      const xfs = all(styles, 'cellXfs')[0];
      if (xfs) children(xfs, 'xf').forEach((xf, index) => { if (isDate(Number(xf.getAttribute('numFmtId') ?? 0))) dated.add(index); });
    }
    const epoch = date1904 ? 24107 : 25569;
    const dateOf = (serial) => {
      const at = new Date(Math.round((serial - epoch) * 86400000));
      if (Number.isNaN(at.getTime())) return String(serial);
      const day = at.toISOString().slice(0, 10);
      const time = at.toISOString().slice(11, 16);
      if (serial < 1) return time;
      return Number.isInteger(serial) ? day : day + ' ' + time;
    };
    const column = (ref) => {
      const letters = /^([A-Z]+)/.exec(ref ?? '')?.[1];
      if (!letters) return null;
      let n = 0;
      for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
      return n - 1;
    };
    const valueOf = (cell) => {
      const type = cell.getAttribute('t');
      const value = children(cell, 'v')[0]?.textContent ?? '';
      if (type === 's') return shared[Number(value)] ?? '';
      if (type === 'inlineStr') return all(cell, 't').map((t) => t.textContent).join('');
      if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
      if (type === 'str' || type === 'e' || type === 'd') return value;
      if (value !== '' && dated.has(Number(cell.getAttribute('s') ?? 0))) return dateOf(Number(value));
      return value;
    };
    const sheets = [];
    let cellsRead = 0;
    let size = 0;
    for (const sheet of all(book, 'sheet')) {
      const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const target = targets.get(id);
      if (!target) continue;
      const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\\.\\//, '');
      const xml = await entry(path);
      if (xml === null) continue;
      const rows = [];
      for (const row of all(parse(xml), 'row')) {
        const cells = [];
        for (const cell of children(row, 'c')) {
          const at = column(cell.getAttribute('r')) ?? cells.length;
          if (at > 16384) fail('too-large');
          while (cells.length < at) cells.push('');
          cells[at] = valueOf(cell).replace(/[\\t\\r\\n]+/g, ' ');
        }
        while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
        cellsRead += cells.length;
        if (cellsRead > 1000000) fail('too-large');
        if (cells.length > 0) {
          const line = cells.join('\\t');
          size += line.length + 1;
          if (size > TEXT_MAX) fail('too-large');
          rows.push(line);
        }
      }
      sheets.push('# ' + (sheet.getAttribute('name') ?? '') + (rows.length > 0 ? '\\n' + rows.join('\\n') : ''));
    }
    if (sheets.length === 0) fail('unreadable');
    return sheets.join('\\n\\n');
  };

  const pdf = async () => {
    // pdf.js and its worker, as modules from what was handed in: nothing is
    // fetched. With the worker's handler on globalThis, pdf.js runs it on
    // this page's own thread rather than starting a worker.
    globalThis.pdfjsWorker = await import('data:text/javascript;base64,' + libraries.worker);
    const pdfjs = await import('data:text/javascript;base64,' + libraries.lib);
    const loading = pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, useSystemFonts: false });
    let doc;
    try {
      doc = await loading.promise;
    } catch (error) {
      await loading.destroy().catch(() => {});
      fail(error && error.name === 'PasswordException' ? 'encrypted' : 'unreadable');
    }
    const pages = [];
    let size = 0;
    try {
      for (let number = 1; number <= Math.min(doc.numPages, 2000); number += 1) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        let text = '';
        let previous = null;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const y = item.transform[5];
          const height = item.height || Math.abs(item.transform[3]) || 10;
          if (previous && previous.y - y > previous.height * 1.8 && !text.endsWith('\\n\\n')) text = text.replace(/\\n$/, '') + '\\n\\n';
          text += item.str;
          if (item.hasEOL) text += '\\n';
          if (item.str.trim()) previous = { y, height };
        }
        const cleaned = text.replace(/[ \\t]+\\n/g, '\\n').trim();
        size += cleaned.length;
        if (size > TEXT_MAX) fail('too-large');
        pages.push(cleaned);
        page.cleanup();
      }
    } finally {
      await loading.destroy().catch(() => {});
    }
    return pages.filter(Boolean).join('\\n\\n');
  };

  try {
    const text = capped(kind === 'pdf' ? await pdf() : kind === 'word' ? await word() : await excel());
    if (!text.trim()) fail('no-text');
    return { text };
  } catch (error) {
    if (error instanceof Failure) return { failure: error.message };
    return { failure: 'unreadable' };
  }
}`;
