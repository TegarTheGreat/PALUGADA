/**
 * The text of a PDF, read in the owner's browser.
 *
 * A dependency, for a reason: a PDF's text is compressed streams of glyphs in
 * each font's own encoding, and reading it right is a project of its own.
 * pdf.js is Mozilla's reader, the one Firefox shows PDFs with. It is loaded
 * only when a PDF is chosen, so the console's page does not carry it, and it
 * runs here rather than on the server, which is sent the text: an untrusted
 * binary is never parsed there. Nothing in the file is run as code: pdf.js 6
 * compiles nothing from a font, and the console's content policy allows no
 * eval to begin with.
 *
 * Lines are kept as lines, a gap between lines wider than a line becomes a
 * paragraph break -- which is where the server cuts passages -- and pages
 * are paragraphs of their own. A scan has no text to read, and says so.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { t } from './i18n.ts';

GlobalWorkerOptions.workerSrc = worker;

export async function textOfPdf(bytes: Uint8Array): Promise<string> {
  // Only the text is wanted, so no font is loaded into the page.
  const loading = getDocument({ data: bytes, disableFontFace: true });
  let pdf;
  try {
    pdf = await loading.promise;
  } catch {
    await loading.destroy();
    throw new Error(t('That file is not a PDF the console can read.'));
  }
  const pages: string[] = [];
  try {
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      let previous: { y: number; height: number } | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        const height = item.height || Math.abs(item.transform[3] as number) || 10;
        if (previous && previous.y - y > previous.height * 1.8 && !text.endsWith('\n\n')) text = `${text.replace(/\n$/, '')}\n\n`;
        text += item.str;
        if (item.hasEOL) text += '\n';
        if (item.str.trim()) previous = { y, height };
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
  const text = pages.filter(Boolean).join('\n\n');
  if (!text) throw new Error(t('That PDF has no text in it -- it may be a scan. Paste its text instead.'));
  return text;
}
