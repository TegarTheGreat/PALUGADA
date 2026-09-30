/**
 * Applies pending SQL migrations in filename order.
 *
 * Each file runs inside one transaction together with the insert that records
 * it, so a migration is either fully applied and recorded or not applied at
 * all. A half-applied migration recorded as complete is the failure mode this
 * avoids.
 *
 * Each is recorded with its checksum, and one whose file no longer matches
 * what ran is refused by name before anything runs. A deployed database has
 * run the old text: recorded by name alone, an edited migration was skipped
 * wherever it had run and applied as edited wherever it had not, and the two
 * databases differed with nothing to say so.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionString } from '../src/config.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/** A migration's text, less the line endings an editor or a checkout chose. */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function migrate(directory: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: connectionString('owner') });
  await client.connect();
  const applied: string[] = [];

  try {
    // Two processes starting together -- replicas of one image, each of which
    // migrates before it serves -- would both find a migration pending and
    // both apply it. One waits for the other here, then finds nothing to do.
    // Released when the connection ends.
    await client.query(`SELECT pg_advisory_lock(hashtext('palugada.migrate'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');

    const files = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
    const texts = new Map<string, string>();
    for (const file of files) texts.set(file, await readFile(join(directory, file), 'utf8'));
    const { rows: ran } = await client.query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const recorded = new Map(ran.map((row) => [row.version, row.checksum]));

    // Every one that ran is checked before any is applied: a later migration
    // may build on what the edited one was meant to do.
    const changed = files.filter((file) => {
      const checksum = recorded.get(file);
      return checksum != null && checksum !== checksumOf(texts.get(file)!);
    });
    if (changed.length > 0) {
      throw new Error(
        `${changed.join(', ')} ${changed.length === 1 ? 'is not the migration' : 'are not the migrations'} this database ran: `
          + 'a migration is never edited once it has run somewhere. Put it back as it was, and make the change in the next number',
      );
    }
    // One that ran before checksums were kept is taken as it is now.
    for (const file of files) {
      if (recorded.has(file) && recorded.get(file) == null) {
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [file, checksumOf(texts.get(file)!)]);
      }
    }

    for (const file of files) {
      if (recorded.has(file)) continue;

      const sql = texts.get(file)!;
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksumOf(sql)]);
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
