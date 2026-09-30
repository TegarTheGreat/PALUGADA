/**
 * Brings a PostgreSQL server up to what PALUGADA needs, and drops nothing.
 *
 * `db:setup` (setup-database.sh) is for a developer's machine: it starts
 * again from nothing, and needs bash, psql and the repository's files. A
 * platform that runs PALUGADA from its image -- Coolify, Dokploy, any
 * compose file with a stock postgres beside it -- has none of those, and runs
 * its setup step on every deploy. This is that step: given a superuser, it
 * makes what is missing and corrects what is wrong, and a second run changes
 * nothing.
 *
 *   - The three roles (see setup-database.sh for why there are three), each
 *     with the password in the URL the platform will connect with, and the
 *     attributes the boundary depends on: only palugada_admin bypasses row
 *     level security, and none is a superuser or may create databases.
 *   - The database, owned by palugada_owner, named by the owner URL's path.
 *   - pgcrypto and pgvector, which only a superuser may install, and pg_trgm,
 *     which the search's indexes are made with (0098).
 *
 * Passwords are quoted by the driver, so a generated one may hold any
 * character; the URLs they come from must percent-encode what a URL cannot
 * hold. The superuser URL is read from PALUGADA_SUPERUSER_URL and used for
 * nothing else: the platform is never given it.
 *
 *   PALUGADA_SUPERUSER_URL=... node scripts/provision-database.ts
 */
import pg from 'pg';
import { connectionString } from '../src/config.ts';

/** The roles, the URL each connects with, and whether it bypasses row level security. */
const ROLES = [
  { name: 'palugada_owner', url: 'owner', bypassRls: false },
  { name: 'palugada_app', url: 'app', bypassRls: false },
  { name: 'palugada_admin', url: 'admin', bypassRls: true },
] as const;

export interface Provisioned {
  database: string;
  /** What was made or corrected; empty when the server already had everything. */
  changed: string[];
}

/** A URL's user, password and database, or a refusal that names the setting. */
function partsOf(url: string, setting: string): { user: string; password: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${setting} is not a URL; it is postgres://user:password@host:port/database`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database };
}

export async function provisionDatabase(options: {
  superuserUrl: string;
  urls?: { owner: string; app: string; admin: string };
}): Promise<Provisioned> {
  const urls = options.urls ?? {
    owner: connectionString('owner'), app: connectionString('app'), admin: connectionString('admin'),
  };
  const settings = { owner: 'PALUGADA_OWNER_URL', app: 'PALUGADA_APP_URL', admin: 'PALUGADA_ADMIN_URL' } as const;
  const parts = Object.fromEntries(ROLES.map((role) => {
    const found = partsOf(urls[role.url], settings[role.url]);
    if (found.user !== role.name) {
      throw new Error(`${settings[role.url]} connects as ${found.user || 'nobody'}; it is ${role.name}'s URL`);
    }
    if (!found.password) throw new Error(`${settings[role.url]} names no password for ${role.name}`);
    return [role.url, found];
  })) as Record<'owner' | 'app' | 'admin', { user: string; password: string; database: string }>;
  const database = parts.owner.database || 'palugada';
  for (const role of ROLES) {
    if (parts[role.url].database !== database) {
      throw new Error(`${settings[role.url]} names database ${parts[role.url].database}; the owner's URL names ${database}`);
    }
  }
  partsOf(options.superuserUrl, 'PALUGADA_SUPERUSER_URL');

  const changed: string[] = [];
  const server = new pg.Client({ connectionString: options.superuserUrl });
  await server.connect();
  try {
    const { rows: me } = await server.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!me[0]?.rolsuper) {
      throw new Error('PALUGADA_SUPERUSER_URL does not connect as a superuser, which installing pgvector needs');
    }
    for (const role of ROLES) {
      const identifier = server.escapeIdentifier(role.name);
      const password = server.escapeLiteral(parts[role.url].password);
      const attributes = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${role.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`;
      const { rows } = await server.query<{ rolbypassrls: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
        'SELECT rolbypassrls, rolsuper, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = $1', [role.name]);
      const found = rows[0];
      if (!found) {
        await server.query(`CREATE ROLE ${identifier} ${attributes} PASSWORD ${password}`);
        changed.push(`made role ${role.name}`);
        continue;
      }
      if (found.rolbypassrls !== role.bypassRls || found.rolsuper || found.rolcreatedb || !found.rolcanlogin) {
        changed.push(`corrected ${role.name}'s attributes`);
      }
      // Always set: a password cannot be read back to compare, and setting
      // the same one again changes nothing a client can see.
      await server.query(`ALTER ROLE ${identifier} ${attributes} PASSWORD ${password}`);
    }

    const { rows: databases } = await server.query<{ owner: string }>(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [database]);
    if (!databases[0]) {
      await server.query(`CREATE DATABASE ${server.escapeIdentifier(database)} OWNER palugada_owner`);
      changed.push(`made database ${database}`);
    } else if (databases[0].owner !== 'palugada_owner') {
      await server.query(`ALTER DATABASE ${server.escapeIdentifier(database)} OWNER TO palugada_owner`);
      changed.push(`gave database ${database} to palugada_owner`);
    }
  } finally {
    await server.end();
  }

  // Extensions belong to a database, so they are installed from inside it.
  const inside = new URL(options.superuserUrl);
  inside.pathname = `/${encodeURIComponent(database)}`;
  const target = new pg.Client({ connectionString: inside.toString() });
  await target.connect();
  try {
    for (const extension of ['pgcrypto', 'vector', 'pg_trgm']) {
      const { rows } = await target.query('SELECT 1 FROM pg_extension WHERE extname = $1', [extension]);
      if (rows.length > 0) continue;
      await target.query(`CREATE EXTENSION IF NOT EXISTS ${target.escapeIdentifier(extension)}`);
      changed.push(`installed ${extension}`);
    }
  } catch (error) {
    throw new Error(`installing extensions in ${database} failed: ${(error as Error).message}; `
      + 'pgvector comes with the pgvector/pgvector:pg16 image, and not with the stock postgres one', { cause: error });
  } finally {
    await target.end();
  }
  return { database, changed };
}

if (import.meta.filename === process.argv[1]) {
  const superuserUrl = process.env.PALUGADA_SUPERUSER_URL;
  if (!superuserUrl) {
    console.error('provision-database: set PALUGADA_SUPERUSER_URL to a superuser of the server to provision');
    process.exit(78);
  }
  try {
    const done = await provisionDatabase({ superuserUrl });
    console.log(done.changed.length > 0
      ? `database ${done.database}: ${done.changed.join('; ')}`
      : `database ${done.database}: already as PALUGADA needs it`);
  } catch (error) {
    console.error(`provision-database: ${(error as Error).message}`);
    process.exit(1);
  }
}
