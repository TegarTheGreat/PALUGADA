/**
 * Connection pools, one per role.
 *
 * Keeping them separate is what makes the isolation claim checkable: agent
 * code imports `appPool` and nothing else, so there is no code path from an
 * agent run to the BYPASSRLS role. A single shared pool with a switchable
 * role would put that boundary back into application logic, which is exactly
 * where the PRD says it must not live (section 7.2).
 */
import pg from 'pg';
import { connectionString, type RoleName } from '../config.ts';

const pools = new Map<RoleName, pg.Pool>();

/**
 * How long one statement may run, and how long a transaction may sit open
 * doing nothing, before Postgres ends it.
 *
 * Nothing here should take two minutes; something that does is stuck, and a
 * stuck statement holds its locks and its connection for as long as nobody
 * notices. A transaction left open -- a bug that awaited something slow
 * between two queries -- holds row locks every other worker queues behind.
 */
const STATEMENT_TIMEOUT_MS = 120_000;
const IDLE_IN_TRANSACTION_MS = 600_000;

function poolFor(role: RoleName): pg.Pool {
  let pool = pools.get(role);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString(role),
      max: 10,
      // A database that does not answer a connection in ten seconds is down,
      // and a worker waiting longer than that is a worker that looks alive.
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
    });
    // pg-pool emits `error` when a connection it is holding idle is closed
    // from the other end -- Postgres restarting, a failover, an operator
    // ending sessions. An emitter with no listener throws, so that took the
    // whole process down, past the worker's own sleep-and-retry. The pool
    // has already dropped the connection; the next query opens another.
    pool.on('error', (error) => {
      process.stderr.write(`${JSON.stringify({
        at: new Date().toISOString(), level: 'warn', event: 'db.connection_lost', role, message: error.message,
      })}\n`);
    });
    pools.set(role, pool);
  }
  return pool;
}

/** Application role. Subject to RLS. The only pool agent code may use. */
export const appPool = (): pg.Pool => poolFor('app');

/** Control plane. Holds BYPASSRLS; never reachable from an agent run. */
export const adminPool = (): pg.Pool => poolFor('admin');

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
