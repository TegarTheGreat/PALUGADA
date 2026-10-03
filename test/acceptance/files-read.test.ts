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
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { filesRead } from '../../src/capabilities/files.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../../src/templates/standard.ts';

after(closePools);

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
  await writeFile(join(mine, 'drafts', 'penawaran.md'), `﻿${offer}`);
  await writeFile(join(mine, 'pesanan.csv'), 'tanggal,gelas\n2026-10-01,30\n2026-10-02,28\n');

  const draft = await read.execute({ path: 'drafts/penawaran.md' }, ctx);
  assert.deepEqual(draft, { path: 'drafts/penawaran.md', bytes: Buffer.byteLength(`﻿${offer}`), text: offer, from: 0, next: null });
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
  await assert.rejects(read.execute({ path: 'logo.png' }, ctx), refused('contract.violation', /logo\.png is not text/));
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
