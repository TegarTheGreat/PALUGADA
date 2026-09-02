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
    await commitOrFail(client);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Commits, and refuses to pretend a discarded transaction succeeded.
 *
 * In PostgreSQL any error aborts the surrounding transaction, and a COMMIT
 * issued afterwards does not fail -- it quietly performs a ROLLBACK and
 * reports the tag `ROLLBACK`. So a caller that catches an error inside its
 * callback and carries on gets a clean return value and loses every write it
 * made, with nothing anywhere saying so. That is silent data loss, which is
 * the one outcome G1 rules out, so it is turned into a loud failure here.
 */
async function commitOrFail(client: pg.PoolClient): Promise<void> {
  const result = await client.query('COMMIT');
  if (result.command === 'ROLLBACK') {
    throw new Error(
      'transaction was aborted before COMMIT and has been rolled back; ' +
        'an error was raised inside the transaction and swallowed, so no write survived',
    );
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
    await commitOrFail(client);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
