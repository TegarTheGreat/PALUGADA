/**
 * A company's files exist by default (the audit of 6 October, W1).
 *
 * `PALUGADA_FILES_ROOT` was set in no compose file, Dockerfile, installer or
 * example, so on a stock install `doc.draft`, `email.draft`, `files.read`,
 * pictures, speech, vision and `code.compute` were all unbound and a company
 * produced nothing it could keep: its work lived in `tasks.output.summary`
 * alone. The Compose deployment now sets one on its persistent volume, and a
 * root that is set but not there yet is made when the deployment starts -- it
 * was an error on the first draft -- or said, at start, when it cannot be.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
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

const boot = async (env: Record<string, string>) => {
  const { start } = await import('../../src/main.ts');
  return start({ port: 0, env, worker: { idleMs: 25 }, log: () => undefined });
};

test('a files root that is set and not there yet is made at start, and the capabilities that need it are bound', async () => {
  const root = join(tmpdir(), `palugada-files-${randomUUID()}`, 'files');
  const deployment = await boot({ PALUGADA_FILES_ROOT: root });
  try {
    assert.ok((await stat(root)).isDirectory(), 'made, with the directory above it');
    const said = deployment.notes.join('\n');
    assert.doesNotMatch(said, /files\.list is unbound/);
    assert.doesNotMatch(said, /doc\.draft and email\.draft are unbound: they need PALUGADA_FILES_ROOT/);
  } finally {
    await deployment.stop();
  }
});

test('a files root that cannot be made is said at start, and the files tools are unbound rather than broken', async () => {
  // Under a file, which no directory can be made in.
  const deployment = await boot({ PALUGADA_FILES_ROOT: join(import.meta.filename, 'files') });
  try {
    const said = deployment.notes.join('\n');
    assert.match(said, /PALUGADA_FILES_ROOT .* could not be made/);
    assert.match(said, /files\.list is unbound/);
  } finally {
    await deployment.stop();
  }
});

test('the Compose deployment keeps its files on its persistent volume', () => {
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const app = compose.slice(compose.indexOf('  app:'), compose.indexOf('\nvolumes:'));
  assert.match(app, /PALUGADA_FILES_ROOT: \$\{PALUGADA_FILES_ROOT:-\/home\/node\/files\}/, 'set, unless the operator chose another');
  assert.match(app, /- home:\/home\/node/, 'under the volume that survives an upgrade');
});
