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
    'bundles',            // platform package catalogue: app has no grant at all
    // Who this installation accepts signatures from. Platform-level like the
    // catalogue it guards, and deliberately out of the application role's
    // reach entirely: an agent that could add a publisher could vouch for its
    // own payload, which is the attack the list exists to stop.
    'trusted_publishers',
    // What the owner set for the whole deployment from the console, and the
    // sealed secrets it names (0065). Read by the control plane when it
    // starts; an agent that could read them could read every provider key,
    // and one that could write them could choose the model it runs on.
    'deployment_settings',
    'deployment_secrets',
    // The owner's conversation with the assistant (0066): the owner's words and
    // the changes proposed to them, which no agent may read or add to.
    'assistant_messages',
    'assistant_proposals',
    // Which topic of the owner's Telegram chat each company's messages go to
    // (0077): the owner's, like the conversation, and no agent's business.
    'telegram_topics',
    // Which worker processes are alive (0079): the platform's, read by the
    // lease sweep on the control plane and by no agent.
    'worker_heartbeats',
    // The line an erased company leaves (0088): its name and how much went,
    // after the company and every row of it are gone. The platform's, read
    // by the owner on the control plane; the application role has no grant.
    'company_erasures',
    // A sign-in to an MCP server between the console and the callback (0080):
    // the platform's, like the deployment's settings it ends in.
    'mcp_authorizations',
    // A division's sign-in for a vendor key, the same way (0081). It names the
    // company and division the key is for and holds nothing of theirs.
    'credential_authorizations',
    // Which WhatsApp messages were taken in and what was sent (0085): the
    // owner's chat, like the Telegram topics, and no agent's business.
    'whatsapp_receipts',
    'whatsapp_sent',
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


/**
 * The boundary, table by table, for everything PRD v2 added.
 *
 * `every table holding tenant data is protected` asserts that a policy exists.
 * A policy existing is not the same as a policy being right — a predicate on
 * the wrong column, or `USING` without `WITH CHECK`, passes that test and
 * fails this one. So this drives the same path an agent would: ordinary
 * queries inside company B's scope, asking for company A's rows.
 *
 * Every table added by v2 is listed rather than a sample. A sample would mean
 * the next table is protected by whoever remembers to add it here.
 */
test('no v2 table leaks a row across companies (F1.2, F1.3)', async () => {
  const victim = await createCompany('isolation-victim');
  const attacker = await createCompany('isolation-attacker');

  // Seed one row in the victim's scope for each table, through the ordinary
  // tenant path so the rows are exactly what a real company would have.
  const seeded = await withTenant(victim.companyId, async (tx) => {
    const { rows: skill } = await tx.query<{ id: string }>(
      `INSERT INTO skills (company_id, slug, scope_type, scope_id, summary)
       VALUES ($1, 'secret-procedure', 'division', $2, 'How the victim works')
       RETURNING id`,
      [victim.companyId, victim.divisionId],
    );
    await tx.query(
      `INSERT INTO skill_versions (company_id, skill_id, version, body, author, changelog)
       VALUES ($1, $2, 1, '---\nname: x\ndescription: y\n---\n\nbody', 'owner', 'first')`,
      [victim.companyId, skill[0]!.id],
    );
    await tx.query(
      `INSERT INTO skill_evals (company_id, skill_id, name, input)
       VALUES ($1, $2, 'case', '{}'::jsonb)`,
      [victim.companyId, skill[0]!.id],
    );
    await tx.query(
      `INSERT INTO role_eval_cases (company_id, role_id, name, trajectory)
       VALUES ($1, $2, 'reference', '{}'::jsonb)`,
      [victim.companyId, victim.roleId],
    );
    await tx.query(
      `INSERT INTO role_eval_runs (company_id, role_id, triggered_by) VALUES ($1, $2, 'charter')`,
      [victim.companyId, victim.roleId],
    );
    const { rows: device } = await tx.query<{ id: string }>(
      `INSERT INTO gateway_devices (company_id, name, runtime, public_key)
       VALUES ($1, 'victim-laptop', 'script', 'PUBLIC KEY') RETURNING id`,
      [victim.companyId],
    );
    await tx.query(
      `INSERT INTO gateway_challenges (nonce, company_id, device_id, expires_at)
       VALUES ('victim-nonce', $1, $2, now() + interval '1 hour')`,
      [victim.companyId, device[0]!.id],
    );
    await tx.query(
      `INSERT INTO gateway_dedupe (company_id, device_id, idempotency_key, method)
       VALUES ($1, $2, 'victim-key', 'tool.call')`,
      [victim.companyId, device[0]!.id],
    );
    return { skillId: skill[0]!.id, deviceId: device[0]!.id };
  });

  // The config version goes in through the control plane, which is the only
  // thing that may write a company's history.
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO config_versions (company_id, kind, subject_id, version, snapshot, summary)
       VALUES ($1, 'role', $2, 1, '{"secret":true}'::jsonb, 'victim role')`,
      [victim.companyId, victim.roleId],
    );
  });

  const tables = [
    'skills', 'skill_versions', 'skill_evals',
    'role_eval_cases', 'role_eval_runs',
    'gateway_devices', 'gateway_challenges', 'gateway_dedupe',
    'config_versions',
  ];

  await withTenant(attacker.companyId, async (tx) => {
    for (const table of tables) {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      assert.equal(
        Number(rows[0]!.count),
        0,
        `${table} showed the attacker a row it does not own`,
      );
    }

    // Not even by naming the row directly, which is the shape an injected
    // prompt would actually take: it has an id from somewhere and asks for it.
    const { rows: named } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM skills WHERE id = $1',
      [seeded.skillId],
    );
    assert.equal(Number(named[0]!.count), 0);

    const { rows: device } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gateway_devices WHERE id = $1',
      [seeded.deviceId],
    );
    assert.equal(Number(device[0]!.count), 0);
  });
});

/**
 * A config version is a record of what an owner decided.
 *
 * The application role may append one — the paths that apply an approved grant
 * or role change run in tenant scope and the version has to commit with the
 * change — and may do nothing else. An agent that could rewrite or remove one
 * could manufacture a version to roll back to, which is the whole attack this
 * grant shape exists to prevent.
 */
test('an agent may append a config version and never rewrite one (F3.9)', async () => {
  const fixture = await createCompany('config-append-only');

  const versionId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO config_versions (company_id, kind, subject_id, version, snapshot, summary)
       VALUES ($1, 'role', $2, 1, '{"model":"a"}'::jsonb, 'before') RETURNING id`,
      [fixture.companyId, fixture.roleId],
    );
    return rows[0]!.id;
  });

  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query("UPDATE config_versions SET snapshot = '{\"model\":\"b\"}'::jsonb WHERE id = $1", [
          versionId,
        ]),
      ),
    /permission denied/,
    'history an agent can edit is a document, not a record',
  );

  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query('DELETE FROM config_versions WHERE id = $1', [versionId]),
      ),
    /permission denied/,
  );

  // And it cannot forge a platform-scoped version, which would outrank its own
  // company's configuration.
  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query(
          `INSERT INTO config_versions (company_id, kind, version, snapshot, summary)
           VALUES (NULL, 'charter', 99, '{}'::jsonb, 'forged platform charter')`,
        ),
      ),
    /row-level security/,
  );
});

/**
 * A device belongs to the company that registered it.
 *
 * F12.7 makes a runtime a device with an identity; an attacker who could pair
 * another company's pending device would have turned that identity into a way
 * in.
 */
test('one company cannot pair or reach another company\'s device (F12.7)', async () => {
  const victim = await createCompany('device-victim');
  const attacker = await createCompany('device-attacker');

  const deviceId = await withTenant(victim.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO gateway_devices (company_id, name, runtime, public_key)
       VALUES ($1, 'laptop', 'script', 'KEY') RETURNING id`,
      [victim.companyId],
    );
    return rows[0]!.id;
  });

  const updated = await withTenant(attacker.companyId, async (tx) => {
    const { rowCount } = await tx.query(
      "UPDATE gateway_devices SET status = 'paired', paired_at = now() WHERE id = $1",
      [deviceId],
    );
    return rowCount;
  });
  assert.equal(updated, 0, 'the row is invisible, so the update matches nothing');

  const stillPending = await withTenant(victim.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      'SELECT status FROM gateway_devices WHERE id = $1',
      [deviceId],
    );
    return rows[0]!.status;
  });
  assert.equal(stillPending, 'pending');
});

/**
 * A capability that reaches past its own company leaves a record.
 *
 * F1.3's point: a denial that leaves no trace is indistinguishable from an
 * attack that never happened. The database already refused it -- that has been
 * true and tested for a long time -- but `reportRlsDenial` existed and nothing
 * called it, so the refusal was a failed tool call and nothing more. Repeated
 * probing looked exactly like a flaky adapter.
 *
 * Recorded in the broker rather than swept later, because that is the only
 * place that knows which capability, task and division tried it. The error
 * still propagates: the agent is told its call failed, exactly as before.
 */
test('a capability denied by row-level security is recorded as a security event (F1.3, F1.4)', async () => {
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const { CapabilityBroker } = await import('../../src/broker/broker.ts');
  const { createRootTask } = await import('../../src/engine/tasks.ts');
  const { grantCapability } = await import('../helpers/fixtures.ts');

  const victim = await createCompany('rls-victim');
  const prober = await createCompany('rls-prober');

  const registry = new CapabilityRegistry();
  registry.register({
    name: 'memory.search',
    adapter: 'test:probe',
    defaultTier: 0,
    // Reaches for another company's rows under this company's tenant context,
    // which is exactly what the policies exist to stop.
    async execute() {
      return withTenant(prober.companyId, async (tx) => {
        await tx.query('INSERT INTO memories (company_id, memory_type, scope_type, body) '
          + "VALUES ($1, 'semantic', 'company', 'planted')", [victim.companyId]);
        return {};
      });
    },
  } as never);
  await registry.sync();
  await grantCapability(prober, 'memory.search');

  const task = await createRootTask({
    companyId: prober.companyId,
    projectId: prober.projectId,
    divisionId: prober.divisionId,
    roleId: prober.roleId,
    budgetAccountId: prober.budgetAccountId,
    goalId: prober.goalId,
    input: { goal: 'probe' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });

  const broker = new CapabilityBroker(registry);
  await assert.rejects(
    () => broker.invoke(
      {
        companyId: prober.companyId,
        projectId: prober.projectId,
        divisionId: prober.divisionId,
        roleId: prober.roleId,
        taskId: task.id,
        idempotencyKey: 'probe-1',
      },
      'memory.search',
      {},
    ),
    'the database allowed a cross-tenant write',
  );

  const events = await withTenant(prober.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM events WHERE type = 'security.rls_denied'",
    );
    return rows;
  });
  assert.equal(events.length, 1, 'the denial left no trace');
  assert.equal(events[0]!.payload.statement, 'capability memory.search');
});

/**
 * Inside its own company the application role could do anything to anything
 * -- clear the company's freeze, raise its own budget ceilings, rewrite the
 * traces its monthly spend is summed from, delete history -- none of which
 * the code does. The grants are what the code writes now (0047), asked of
 * the database rather than assumed.
 */
test('the application role may write what the platform writes, and no more (F12, 0047)', async () => {
  const may = async (check: string) => withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ ok: boolean }>(`SELECT ${check} AS ok`);
    return rows[0]!.ok;
  });
  const app = "'palugada_app'";

  // What it needs.
  assert.equal(await may(`has_column_privilege(${app}, 'budget_accounts', 'tokens_spent', 'UPDATE')`), true);
  assert.equal(await may(`has_column_privilege(${app}, 'budget_accounts', 'tokens_reserved', 'UPDATE')`), true);
  assert.equal(await may(`has_column_privilege(${app}, 'budget_accounts', 'money_spent_cents', 'UPDATE')`), true);
  assert.equal(await may(`has_table_privilege(${app}, 'capability_grants', 'DELETE')`), true,
    'revoking a grant is a delete');
  assert.equal(await may(`has_table_privilege(${app}, 'tasks', 'UPDATE')`), true);

  // What it does not.
  for (const [check, why] of [
    [`has_table_privilege(${app}, 'companies', 'UPDATE')`, 'a company unfreezing itself'],
    [`has_table_privilege(${app}, 'companies', 'INSERT')`, 'a company created outside the control plane'],
    [`has_column_privilege(${app}, 'budget_accounts', 'tokens_max', 'UPDATE')`, 'raising its own ceiling'],
    [`has_column_privilege(${app}, 'budget_accounts', 'money_max_cents', 'UPDATE')`, 'or its money ceiling'],
    [`has_table_privilege(${app}, 'llm_traces', 'UPDATE')`, 'rewriting what a call cost'],
    [`has_table_privilege(${app}, 'llm_traces', 'DELETE')`, 'erasing it'],
    [`has_table_privilege(${app}, 'decision_records', 'UPDATE')`, 'rewriting what a reviewer said'],
    [`has_table_privilege(${app}, 'tasks', 'DELETE')`, 'deleting work'],
    [`has_table_privilege(${app}, 'task_steps', 'DELETE')`, 'or its journal'],
    [`has_table_privilege(${app}, 'inbox_items', 'DELETE')`, 'or the owner\'s questions'],
  ] as const) {
    assert.equal(await may(check), false, why);
  }

  // And a table added later does not inherit a delete nobody decided on.
  const inherits = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname = 'enable_tenant_rls'",
    );
    return rows[0]!.body;
  });
  assert.doesNotMatch(inherits, /UPDATE, DELETE ON %s TO palugada_app/);
});

/**
 * Row security keeps a company from reading another's rows; it never kept a
 * row from pointing at one. A foreign key is checked past row security, so a
 * task could name another company's role or be charged to another company's
 * budget -- the worker could then never run it, and the other company's
 * account would have paid. Every reference between tenant tables is on
 * (company_id, id) now (0048), so the database refuses it whatever the code
 * sent.
 */
test('a row cannot point into another company (F1.1, 0048)', async () => {
  const mine = await createCompany('fk-mine');
  const theirs = await createCompany('fk-theirs');
  const { createRootTask } = await import('../../src/engine/tasks.ts');

  // Refused by the foreign key, or earlier by code that cannot see the other
  // company's row -- a budget it cannot see is one it cannot reserve from.
  const refused = async (what: string, attempt: () => Promise<unknown>) => {
    await assert.rejects(attempt, (error: unknown) =>
      ['23503', 'budget.reservation_refused'].includes(String((error as { code?: string }).code)),
    what);
  };

  await refused('a task run by their role', () => createRootTask({
    companyId: mine.companyId, projectId: mine.projectId, divisionId: mine.divisionId,
    roleId: theirs.roleId, budgetAccountId: mine.budgetAccountId, goalId: mine.goalId,
    input: {}, createdBy: 'owner', reserveTokens: 10,
  }));
  await refused('a task charged to their budget', () => createRootTask({
    companyId: mine.companyId, projectId: mine.projectId, divisionId: mine.divisionId,
    roleId: mine.roleId, budgetAccountId: theirs.budgetAccountId, goalId: mine.goalId,
    input: {}, createdBy: 'owner', reserveTokens: 10,
  }));
  await refused('a grant to their division', () => withTenant(mine.companyId, (tx) => tx.query(
    `INSERT INTO capability_grants (company_id, division_id, capability_name)
     VALUES ($1, $2, 'dns.read')`,
    [mine.companyId, theirs.divisionId],
  )));

  // And a reference inside the company is exactly as it was.
  const ours = await createRootTask({
    companyId: mine.companyId, projectId: mine.projectId, divisionId: mine.divisionId,
    roleId: mine.roleId, budgetAccountId: mine.budgetAccountId, goalId: mine.goalId,
    input: {}, createdBy: 'owner', reserveTokens: 10,
  });
  assert.ok(ours.id);
});
