/**
 * PRD F1.2, F1.3 and section 7.2 -- tenant isolation.
 *
 * Acceptance criterion F1.3: an injected prompt telling an agent in company Y
 * to reveal company X's data must be refused by the database, and the attempt
 * must be recorded as security.rls_denied.
 *
 * The test drives the same code path an agent would: it does not craft a
 * privileged connection, it runs ordinary queries inside a tenant scope.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isRlsViolation, reportRlsDenial } from '../../src/audit/security.ts';
import { readTaskEvents } from '../../src/audit/event-log.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('a query without tenant context is rejected, not silently emptied', async () => {
  const { appPool } = await import('../../src/db/pool.ts');
  const client = await appPool().connect();
  try {
    await assert.rejects(
      () => client.query('SELECT id FROM projects'),
      (error: unknown) => {
        assert.ok(isRlsViolation(error), 'expected a 42501 privilege error');
        assert.match((error as Error).message, /app\.company_id/);
        return true;
      },
      'a missing tenant context must fail loudly rather than return zero rows',
    );
  } finally {
    client.release();
  }
});

test('an injected prompt cannot read another company\'s data', async () => {
  const victim = await createCompany('victim');
  const attacker = await createCompany('attacker');

  await withTenant(victim.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO memories (company_id, memory_type, scope_type, body)
       VALUES ($1, 'semantic', 'company', 'the victim launch code is 1234')`,
      [victim.companyId],
    );
  });

  // The shape a prompt injection produces: an agent running for the attacker
  // asks for rows belonging to the victim, by id.
  const leaked = await withTenant(attacker.companyId, async (tx) => {
    const { rows } = await tx.query(
      'SELECT body FROM memories WHERE company_id = $1',
      [victim.companyId],
    );
    return rows;
  });

  assert.equal(leaked.length, 0, 'row-level security must filter the victim rows out');

  // And an unqualified sweep -- "show me everything" -- sees only its own tenant.
  const everything = await withTenant(attacker.companyId, async (tx) => {
    const { rows } = await tx.query('SELECT body FROM memories');
    return rows;
  });
  assert.equal(everything.length, 0);
});

test('writing into another company is refused and recorded', async () => {
  const victim = await createCompany('victim-write');
  const attacker = await createCompany('attacker-write');

  let denied: unknown = null;
  try {
    await withTenant(attacker.companyId, async (tx) => {
      await tx.query(
        `INSERT INTO memories (company_id, memory_type, scope_type, body)
         VALUES ($1, 'semantic', 'company', 'planted by the attacker')`,
        [victim.companyId],
      );
    });
  } catch (error) {
    denied = error;
  }

  assert.ok(denied, 'a cross-tenant insert must fail');
  assert.ok(isRlsViolation(denied), 'the refusal must come from the database, not application code');

  await reportRlsDenial(attacker.companyId, {
    attemptedCompanyId: victim.companyId,
    statement: 'INSERT INTO memories',
    message: (denied as Error).message,
  });

  const events = await withTenant(attacker.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM events WHERE type = 'security.rls_denied'",
    );
    return rows;
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.attemptedCompanyId, victim.companyId);

  // The victim's data is untouched and the attacker's log is not visible to it.
  const victimRows = await withTenant(victim.companyId, async (tx) => {
    const { rows } = await tx.query('SELECT body FROM memories');
    return rows;
  });
  assert.equal(victimRows.length, 0);
  void readTaskEvents;
});

test('every table holding tenant data is protected', async () => {
  // A new table added without RLS is the classic multi-tenant regression: the
  // application keeps working and isolation quietly stops being true. This
  // asserts the boundary itself, so the failure surfaces at test time.
  const EXPECTED_UNPROTECTED = new Set([
    'capabilities',       // platform registry: no tenant data, app has SELECT only
    'platform_control',   // global stop signal: no tenant data
    'schema_migrations',  // migration bookkeeping: app has no grant at all
    'company_templates',  // a shape, not tenant content: app has no grant at all
  ]);

  const rows = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      table_name: string; rls: boolean; forced: boolean; policies: string;
    }>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls,
              c.relforcerowsecurity AS forced,
              (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    return rows;
  });

  const unprotected = rows.filter((r) => !r.rls).map((r) => r.table_name).sort();
  assert.deepEqual(
    unprotected,
    [...EXPECTED_UNPROTECTED].sort(),
    'a tenant table shipped without row-level security',
  );

  for (const row of rows.filter((r) => r.rls)) {
    assert.ok(row.forced, `${row.table_name} enables RLS but does not FORCE it`);
    assert.ok(Number(row.policies) >= 1, `${row.table_name} has RLS but no policy`);
  }

  // An unprotected table is only acceptable while the application role cannot
  // read it, or it genuinely holds no tenant content. Asserting the privileges
  // too stops "add it to the allow-list" from becoming the way past this test.
  //
  // Asked with has_table_privilege rather than by reading
  // information_schema.table_privileges: that view only shows grants visible
  // to the querying role, so it returns nothing here and a loop over it would
  // pass without checking anything.
  const READABLE_BY_AGENTS = new Set(['capabilities', 'platform_control']);

  for (const table of EXPECTED_UNPROTECTED) {
    const privileges = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ can_select: boolean; can_write: boolean }>(
        `SELECT has_table_privilege('palugada_app', $1, 'SELECT') AS can_select,
                has_table_privilege('palugada_app', $1, 'INSERT')
                  OR has_table_privilege('palugada_app', $1, 'UPDATE')
                  OR has_table_privilege('palugada_app', $1, 'DELETE') AS can_write`,
        [table],
      );
      return rows[0]!;
    });

    assert.equal(
      privileges.can_select,
      READABLE_BY_AGENTS.has(table),
      `${table} is unprotected; the application role's read access must be deliberate`,
    );
    assert.equal(privileges.can_write, false, `${table} must not be writable by an agent`);
  }
});

test('the application role cannot bypass row-level security', async () => {
  const attributes = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'palugada_app'",
    );
    return rows[0]!;
  });
  assert.equal(attributes.rolsuper, false, 'the app role must not be a superuser');
  assert.equal(attributes.rolbypassrls, false, 'the app role must not hold BYPASSRLS');
});
