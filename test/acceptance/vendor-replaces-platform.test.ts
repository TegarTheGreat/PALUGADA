/**
 * Saying so when a service takes a name the platform keeps (the audit of 6
 * October, O2).
 *
 * `invoice.issue` is bound by the platform to the company's books, as a
 * *fallback*: a service the owner connects may take the name. The shipped
 * example does -- a Midtrans QRIS charge, named `invoice.issue` -- and then the
 * company's invoices stop being written to its books, with nothing to say so.
 * It is allowed, because a company may want exactly that; it is said, at start.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('a service that takes invoice.issue from the books is said at start, with what it costs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const file = join(dir, 'vendors.json');
  // The shipped example, which names invoice.issue for a Midtrans charge.
  const example = JSON.parse((await import('node:fs')).readFileSync('config/vendors.example.json', 'utf8')) as { capabilities: Array<{ name: string }> };
  writeFileSync(file, JSON.stringify({ ...example, capabilities: example.capabilities.filter((one) => one.name === 'invoice.issue') }));
  const { start } = await import('../../src/main.ts');
  const deployment = await start({
    port: 0, vendorsFile: file, env: { PALUGADA_SECRET_MIDTRANS: 'x' }, worker: { idleMs: 25 }, log: () => undefined,
  });
  try {
    const said = deployment.notes.join('\n');
    assert.match(said, /invoice\.issue is bound to a service \(midtrans\), no longer to the platform's own \(the company's books\)/);
    assert.match(said, /not written to the books/);
    // And not said of a name nobody took.
    assert.doesNotMatch(said, /ledger\.record is bound to a service/);
  } finally {
    await deployment.stop();
  }
});

test('with no service in the way, nothing is said', async () => {
  const { start } = await import('../../src/main.ts');
  const deployment = await start({ port: 0, env: {}, worker: { idleMs: 25 }, log: () => undefined });
  try {
    assert.doesNotMatch(deployment.notes.join('\n'), /is bound to a service \(/);
    // The shipped lab analyst holds a tool nothing binds, and a fresh install says so.
    assert.match(deployment.notes.join('\n'), /code\.execute is unbound: no capability wraps the sandbox/);
  } finally {
    await deployment.stop();
  }
});
