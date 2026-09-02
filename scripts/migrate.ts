/**
 * Applies pending SQL migrations in filename order.
 *
 * Each file runs inside one transaction together with the insert that records
 * it, so a migration is either fully applied and recorded or not applied at
 * all. A half-applied migration recorded as complete is the failure mode this
 * avoids.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionString } from '../src/config.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export async function migrate(): Promise<string[]> {
  const client = new pg.Client({ connectionString: connectionString('owner') });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file],
      );
      if (rows.length > 0) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }

  return applied;
}

if (import.meta.filename === process.argv[1]) {
  const applied = await migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
}
