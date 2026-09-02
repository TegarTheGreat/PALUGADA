/**
 * Tenant-scoped database access.
 *
 * Every agent-facing query runs through here. The scope is established with
 * set_config(..., is_local => true) inside an explicit transaction, so the
 * setting is discarded at COMMIT or ROLLBACK. That detail matters: with a
 * connection pool, a session-level SET would outlive the request and leak the
 * previous tenant's scope into whoever borrows the connection next -- a bug
 * that reads as random cross-tenant access and is very hard to reproduce.
 *
 * The company id is bound as a parameter rather than interpolated, so a value
 * reaching this function from a task payload cannot terminate the literal and
 * append SQL.
 */
import type pg from 'pg';
import { appPool, adminPool } from './pool.ts';

export interface TenantClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export async function withTenant<T>(
  companyId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  const client = await appPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.company_id', companyId]);
    const result = await fn({ query: (text, values) => client.query(text, values) });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Control-plane access, outside any tenant scope.
 *
 * Reserved for platform operations such as creating a company or reading a
 * cross-tenant digest. Passing agent-supplied input to this function defeats
 * the isolation boundary, so callers should be few and obvious.
 */
export async function withControlPlane<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  const client = await adminPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn({ query: (text, values) => client.query(text, values) });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
