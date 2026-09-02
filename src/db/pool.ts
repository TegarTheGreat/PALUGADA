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

function poolFor(role: RoleName): pg.Pool {
  let pool = pools.get(role);
  if (!pool) {
    pool = new pg.Pool({ connectionString: connectionString(role), max: 10 });
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
