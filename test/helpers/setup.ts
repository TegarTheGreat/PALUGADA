/**
 * Shared test setup.
 *
 * Cleanup runs as the schema owner over a dedicated connection rather than
 * through the control-plane role. Two reasons: TRUNCATE is a table-owner
 * privilege that production code has no business holding, and the append-only
 * trigger on `events` blocks DELETE even through a cascade -- which is the
 * intended production behaviour (section 7.4 admits no deletion, only freeze
 * and export) and must not be relaxed to make tests convenient.
 */
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { migrate } from '../../scripts/migrate.ts';
import { clearStopAll } from '../../src/engine/control.ts';

let migrated = false;
let owner: pg.Pool | null = null;

function ownerPool(): pg.Pool {
  owner ??= new pg.Pool({ connectionString: connectionString('owner'), max: 4 });
  return owner;
}

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await migrate();
  migrated = true;
}

export async function resetData(): Promise<void> {
  await ensureSchema();
  await clearStopAll();
  // companies cascades to every tenant table; capabilities holds platform
  // registry rows that each test registers for itself.
  await ownerPool().query('TRUNCATE companies, capabilities CASCADE');
}

export async function closeSetup(): Promise<void> {
  await owner?.end();
  owner = null;
}
