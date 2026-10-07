/**
 * An invoice as a page to print: the document a customer is sent.
 *
 * A pure function of the invoice as it was issued, the company's name and a
 * language, so the same invoice always draws the same page. It is drawn by
 * the deployment's own browser (`Browsers.print`), which is why it is HTML
 * and why it takes care with what goes into it: the customer's name, the
 * lines and the note were typed by someone, often a person outside the
 * company, so every value is escaped, nothing in the page runs (no script, a
 * policy that allows nothing to load), and the characters that reorder or
 * hide text are dropped.
 *
 * It prints the invoice as issued, with no "paid" mark: the page is kept once
 * under the invoice's number and what a customer is sent is the demand, not
 * the state of the books at the moment it was drawn. A voided invoice is not
 * drawn at all (the route refuses it).
 *
 * The company is its name alone. Its address, tax number and bank details are
 * not kept anywhere yet, so this is a usable invoice and not a Faktur Pajak.
 */
import type { InvoiceDetail } from './invoices.ts';

interface Words {
  title: string;
  billTo: string;
  issued: string;
  due: string;
  description: string;
  quantity: string;
  unit: string;
  amount: string;
  subtotal: string;
  tax: string;
  total: string;
  note: string;
}

/** The languages the page is written in: Indonesian, and English for every other. */
const WORDS: Record<'en' | 'id', Words> = {
  en: {
    title: 'Invoice', billTo: 'Bill to', issued: 'Issued', due: 'Due', description: 'Description', quantity: 'Qty',
    unit: 'Unit price', amount: 'Amount', subtotal: 'Subtotal', tax: 'Tax', total: 'Total', note: 'Note',
  },
  id: {
    title: 'Invoice', billTo: 'Ditagihkan kepada', issued: 'Tanggal terbit', due: 'Jatuh tempo', description: 'Deskripsi', quantity: 'Jml',
    unit: 'Harga satuan', amount: 'Jumlah', subtotal: 'Subtotal', tax: 'Pajak', total: 'Total', note: 'Catatan',
  },
};

/** Control characters, and the ones that reorder, isolate or hide text: none belongs in a name on an invoice. */
const UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

function text(value: string): string {
  return value
    .replace(UNPRINTABLE, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The languages of the page, by the company's work language. */
export function invoiceLanguage(workLanguage: string): 'en' | 'id' {
  return workLanguage === 'id' ? 'id' : 'en';
}

/**
 * How a figure and a day are written for the customer who reads them: the
 * invoice's page and the reminder letters say them the same way.
 */
export function invoiceFormats(workLanguage: string, currency: string): {
  language: 'en' | 'id'; locale: string; money: (cents: number) => string; day: (iso: string) => string;
} {
  const language = invoiceLanguage(workLanguage);
  const locale = language === 'id' ? 'id-ID' : 'en-US';
  const money = (cents: number): string => {
    try {
      return (cents / 100).toLocaleString(locale, { style: 'currency', currency, maximumFractionDigits: 2 });
    } catch {
      // A code the runtime does not know is written as it is, beside the figure.
      return `${(cents / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
    }
  };
  const day = (iso: string): string => {
    const at = Date.parse(`${iso}T00:00:00Z`);
    return Number.isNaN(at) ? iso : new Date(at).toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' });
  };
  return { language, locale, money, day };
}

export function invoiceHtml(invoice: InvoiceDetail, company: string, workLanguage: string): string {
  const { language, locale, money, day } = invoiceFormats(workLanguage, invoice.currency);
  const words = WORDS[language];
  const quantity = (value: number): string => value.toLocaleString(locale, { maximumFractionDigits: 3 });

  const lines = invoice.lines.map((line) => `
        <tr>
          <td class="what">${text(line.description)}</td>
          <td class="figure">${text(quantity(line.quantity))}</td>
          <td class="figure">${text(money(line.unitCents))}</td>
          <td class="figure">${text(money(line.amountCents))}</td>
        </tr>`).join('');
  const taxRow = invoice.taxCents > 0 ? `
        <tr><td colspan="3" class="sum">${text(words.tax)} ${text((invoice.taxRateBps / 100).toLocaleString(locale, { maximumFractionDigits: 2 }))}%</td><td class="figure">${text(money(invoice.taxCents))}</td></tr>` : '';
  const subtotalRow = invoice.taxCents > 0 ? `
        <tr><td colspan="3" class="sum">${text(words.subtotal)}</td><td class="figure">${text(money(invoice.subtotalCents))}</td></tr>` : '';

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${text(words.title)} ${text(invoice.number)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1b1b1f; font: 10.5pt/1.45 "Liberation Sans", Arial, Helvetica, sans-serif; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16mm; margin-bottom: 12mm; }
  .company { font-size: 15pt; font-weight: 700; overflow-wrap: anywhere; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 22pt; letter-spacing: 0.02em; }
  .title .number { font-size: 12pt; }
  .meta { display: flex; justify-content: space-between; gap: 16mm; margin-bottom: 10mm; }
  .meta div { min-width: 0; overflow-wrap: anywhere; }
  .label { color: #5d5d66; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; }
  .customer { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #5d5d66; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1.5pt solid #1b1b1f; padding: 2mm 1.5mm; }
  th.figure { text-align: right; }
  td { padding: 2mm 1.5mm; border-bottom: 0.5pt solid #d0d0d6; vertical-align: top; }
  td.what { overflow-wrap: anywhere; }
  td.figure { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.sum { text-align: right; color: #5d5d66; }
  tr.total td { border-bottom: 0; border-top: 1.5pt solid #1b1b1f; font-weight: 700; font-size: 12pt; padding-top: 3mm; }
  tr.total td.sum { color: #1b1b1f; }
  .note { margin-top: 10mm; white-space: pre-wrap; overflow-wrap: anywhere; }
  tr { break-inside: avoid; }
</style>
</head>
<body>
  <header>
    <div class="company">${text(company)}</div>
    <div class="title"><h1>${text(words.title)}</h1><div class="number">${text(invoice.number)}</div></div>
  </header>
  <section class="meta">
    <div><div class="label">${text(words.billTo)}</div><div class="customer">${text(invoice.customerName)}</div>${invoice.customerEmail ? `<div>${text(invoice.customerEmail)}</div>` : ''}</div>
    <div><div class="label">${text(words.issued)}</div><div>${text(day(invoice.issueDate))}</div></div>
    <div><div class="label">${text(words.due)}</div><div>${text(day(invoice.dueDate))}</div></div>
  </section>
  <table>
    <thead><tr><th>${text(words.description)}</th><th class="figure">${text(words.quantity)}</th><th class="figure">${text(words.unit)}</th><th class="figure">${text(words.amount)}</th></tr></thead>
    <tbody>${lines}${subtotalRow}${taxRow}
        <tr class="total"><td colspan="3" class="sum">${text(words.total)}</td><td class="figure">${text(money(invoice.totalCents))}</td></tr>
    </tbody>
  </table>${invoice.note ? `
  <section class="note"><div class="label">${text(words.note)}</div>${text(invoice.note)}</section>` : ''}
</body>
</html>
`;
}
