/**
 * `files.read` (the tools research, recommendation 3; src/capabilities/files.ts):
 * a role reads a file in the company's own files -- a draft another role
 * wrote, a list the owner left there -- where until now it could only see
 * that the file was there.
 *
 * Held to `files.list`'s rules, since it is the same risk pointed at what is
 * inside a file rather than its name: this company's directory and nothing
 * beside it, a link followed only as far as the directory goes, and what it
 * reads is from outside, because nothing records where a file came from.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { filesRead } from '../../src/capabilities/files.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../../src/templates/standard.ts';
import { Browsers } from '../../src/browser/browsers.ts';
import { sealedCookies } from '../../src/browser/cookies.ts';
import { chromium } from '../helpers/browser.ts';
import { docxOf, pdfOf, xlsxOf, zipOf } from '../helpers/documents.ts';

const opened: Browsers[] = [];
after(async () => {
  for (const one of opened) await one.close();
  await closePools();
});
const EXECUTABLE = chromium();
/** The PDF reader the console's build puts beside it (console/vite.config.ts). */
const READER = fileURLToPath(new URL('../../console/dist/reader', import.meta.url));

const refused = (code: string, said: RegExp) => (error: unknown) => isPalugadaError(error, code as never) && said.test((error as Error).message);

async function companyFiles() {
  const root = await mkdtemp(join(tmpdir(), 'palugada-files-'));
  const companyId = randomUUID();
  const mine = join(root, companyId);
  await mkdir(join(mine, 'drafts'), { recursive: true });
  return { root, companyId, mine, ctx: { companyId } as never };
}

test('a role reads a text file in the company\'s files, a page at a time, as it is written', async () => {
  const { root, mine, ctx } = await companyFiles();
  const read = filesRead({ root });
  const offer = '# Penawaran untuk kantor\n\nKopi susu gula aren, Rp 15.000 per gelas.\nAntar setiap Senin pukul 09.00.\n';
  await writeFile(join(mine, 'drafts', 'penawaran.md'), `\uFEFF${offer}`);
  await writeFile(join(mine, 'pesanan.csv'), 'tanggal,gelas\n2026-10-01,30\n2026-10-02,28\n');

  const draft = await read.execute({ path: 'drafts/penawaran.md' }, ctx);
  assert.deepEqual(draft, { path: 'drafts/penawaran.md', kind: 'text', bytes: Buffer.byteLength(`\uFEFF${offer}`), text: offer, from: 0, next: null });
  assert.equal((await read.execute({ path: './pesanan.csv' }, ctx)).text, 'tanggal,gelas\n2026-10-01,30\n2026-10-02,28\n');

  // A long file comes a page at a time, each saying where the next begins.
  const long = Array.from({ length: 3_000 }, (_x, n) => `Baris ${n + 1}: ${'kopi '.repeat(8)}`).join('\n');
  await writeFile(join(mine, 'panjang.txt'), long);
  const first = await read.execute({ path: 'panjang.txt' }, ctx);
  assert.equal(first.text, long.slice(0, 60_000));
  assert.equal(first.next, 60_000);
  const second = await read.execute({ path: 'panjang.txt', from: first.next! }, ctx);
  assert.equal(second.text, long.slice(60_000, 120_000));
  assert.equal(second.next, long.length > 120_000 ? 120_000 : null);
});

test('it reads this company\'s files and nothing beside them, and says what it cannot read', async () => {
  const { root, mine, ctx } = await companyFiles();
  const read = filesRead({ root });
  await writeFile(join(mine, 'catatan.txt'), 'milik kami');
  const other = join(root, randomUUID());
  await mkdir(other);
  await writeFile(join(other, 'rahasia.txt'), 'milik perusahaan lain');
  await symlink(join(other, 'rahasia.txt'), join(mine, 'pintas.txt'));
  await symlink('/etc/hostname', join(mine, 'mesin.txt'));

  for (const path of [`../${other.split('/').at(-1)}/rahasia.txt`, 'pintas.txt', 'mesin.txt', 'drafts/../../x', '..']) {
    await assert.rejects(read.execute({ path }, ctx), refused('capability.unreachable', /outside the company's files/), path);
  }
  await assert.rejects(read.execute({ path: 'tidak-ada.txt' }, ctx), refused('contract.violation', /no file tidak-ada\.txt/));
  await assert.rejects(read.execute({ path: 'drafts' }, ctx), refused('contract.violation', /drafts is a folder: files\.list lists it/));
  // A picture, a recording: not text, and not a document it converts.
  await writeFile(join(mine, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
  await assert.rejects(read.execute({ path: 'logo.png' }, ctx), refused('contract.violation', /logo\.png is not text, nor a PDF, Word or Excel file/));
  // A document without a browser to read it in is said as that.
  await writeFile(join(mine, 'harga.pdf'), pdfOf([['Harga']]));
  await assert.rejects(read.execute({ path: 'harga.pdf' }, ctx), refused('capability.unreachable', /harga\.pdf is a PDF: this deployment reads them in its browser, and has none/));
  await assert.rejects(read.execute({ path: 'catatan.txt', from: 11 }, ctx), refused('contract.violation', /from is past the end/));
  assert.equal((await read.execute({ path: 'catatan.txt' }, ctx)).text, 'milik kami');
});

test('files.read is catalogued as a read of outside content, bound beside files.list, and granted where it is', () => {
  const declared = declarationFor('files.read');
  assert.ok(declared, 'in the catalogue');
  assert.deepEqual([declared.tier, declared.readsOutside], [0, true]);
  const bound = platformCapabilities({ files: { root: '/tmp' } }).map((one) => one.name);
  assert.ok(bound.includes('files.read') && bound.includes('files.list'));
  assert.ok(!platformCapabilities().map((one) => one.name).includes('files.read'), 'no root, no files to read');
  const grants = STANDARD_COMPANY_TEMPLATE.grants ?? [];
  const where = (name: string) => grants.filter((one) => one.capability === name).map((one) => one.division).sort();
  assert.deepEqual(where('files.read'), where('files.list'));
});

test('a PDF, a Word document and a spreadsheet are read as text, in the deployment\'s sandboxed browser', { skip: EXECUTABLE ? false : 'no Chromium' }, async () => {
  assert.ok(existsSync(join(READER, 'pdf.min.mjs')), 'the console is built first (npm run console:build), with its PDF reader');
  const { root, mine, ctx } = await companyFiles();
  const browser = new Browsers({ executable: EXECUTABLE!, sandbox: false, reader: READER, cookies: sealedCookies({ master: () => null }) });
  opened.push(browser);
  let conversions = 0;
  const convert = browser.convert.bind(browser);
  browser.convert = async (...args) => {
    conversions += 1;
    return convert(...args);
  };
  const read = filesRead({ root }, browser);

  await writeFile(join(mine, 'harga.pdf'), pdfOf([
    ['Daftar harga Toko Kopi Senja', 'Kopi susu gula aren: Rp 15.000', 'Caf\u00e9 latte: Rp 18.000'],
    ['Halaman dua', 'Antar gratis untuk 20 gelas'],
  ]));
  const pdf = await read.execute({ path: 'harga.pdf' }, ctx);
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.text, 'Daftar harga Toko Kopi Senja\nKopi susu gula aren: Rp 15.000\nCaf\u00e9 latte: Rp 18.000\n\nHalaman dua\nAntar gratis untuk 20 gelas');

  await writeFile(join(mine, 'penawaran.docx'), docxOf(
    ['Penawaran untuk kantor', 'Kopi\tdan teh, setiap Senin.'],
    [['Menu', 'Harga'], ['Kopi susu', '15.000']],
  ));
  const word = await read.execute({ path: 'penawaran.docx' }, ctx);
  assert.deepEqual([word.kind, word.text], ['word', 'Penawaran untuk kantor\nKopi\tdan teh, setiap Senin.\n\nMenu\tHarga\nKopi susu\t15.000']);

  await writeFile(join(mine, 'pesanan.xlsx'), xlsxOf([
    { name: 'Oktober', rows: [['Tanggal', 'Gelas', 'Catatan'], [new Date(Date.UTC(2026, 9, 1)), 30, 'kantor'], [new Date(Date.UTC(2026, 9, 2)), 28, null]] },
    { name: 'Pelanggan & alamat', rows: [['Budi', 'Jl. Merdeka 5']] },
  ]));
  const sheet = await read.execute({ path: 'pesanan.xlsx' }, ctx);
  assert.deepEqual([sheet.kind, sheet.text], ['excel', '# Oktober\nTanggal\tGelas\tCatatan\n2026-10-01\t30\tkantor\n2026-10-02\t28\n\n# Pelanggan & alamat\nBudi\tJl. Merdeka 5']);
  // A second reading of the same file is the first's, not another conversion.
  const before = conversions;
  assert.deepEqual(await read.execute({ path: 'pesanan.xlsx' }, ctx), sheet);
  assert.equal(conversions, before);

  // What a hostile file can try, refused with what it was.
  await writeFile(join(mine, 'bom.docx'), zipOf({ 'word/document.xml': Buffer.alloc(64 * 1024 * 1024, 0x20) }));
  await assert.rejects(read.execute({ path: 'bom.docx' }, ctx), refused('contract.violation', /bom\.docx is too large once unpacked/));
  await writeFile(join(mine, 'rusak.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2_000, 0x41)]));
  await assert.rejects(read.execute({ path: 'rusak.pdf' }, ctx), refused('contract.violation', /rusak\.pdf is not a PDF that can be read/));
  await writeFile(join(mine, 'pindaian.pdf'), pdfOf([[]]));
  await assert.rejects(read.execute({ path: 'pindaian.pdf' }, ctx), refused('contract.violation', /pindaian\.pdf has no text in it -- it may be a scan/));
  await writeFile(join(mine, 'bukan.xlsx'), zipOf({ 'readme.txt': 'not a workbook' }));
  await assert.rejects(read.execute({ path: 'bukan.xlsx' }, ctx), refused('contract.violation', /bukan\.xlsx is not an Excel workbook that can be read/));
});
