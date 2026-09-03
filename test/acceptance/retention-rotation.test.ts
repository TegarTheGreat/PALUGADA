/**
 * PRD F11.5, F12.3 -- retention and secret rotation.
 *
 * Retention is the only code in the system that deletes anything durable, so
 * the tests spend most of their attention on what it must refuse: deleting
 * anything recent, deleting outside an explicit purge, and deleting without
 * leaving a record that it did.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  purgeExpiredEvents,
  readRetentionLog,
  retentionFor,
  runRetention,
  scrubExpiredPrompts,
  setRetention,
} from '../../src/retention/retention.ts';
import {
  CachedSecretManager,
  resolveCurrent,
  rotateCredential,
} from '../../src/secrets/rotation.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function seedHistory(fixture: Fixture, daysAgo: number, label: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO events (company_id, project_id, type, actor, payload, occurred_at)
       VALUES ($1, $2, 'task.completed', 'agent_run', $3::jsonb,
               now() - make_interval(days => $4))`,
      [fixture.companyId, fixture.projectId, JSON.stringify({ label }), daysAgo],
    );
    await tx.query(
      `INSERT INTO llm_traces (id, company_id, model, prompt, response,
                               input_tokens, output_tokens, cost_cents, occurred_at)
       VALUES ($1, $2, 'test-model', $3::jsonb, $4::jsonb, 10, 5, 1,
               now() - make_interval(days => $5))`,
      [
        `trace-${fixture.slug}-${label}`,
        fixture.companyId,
        JSON.stringify({ text: `a customer message from ${label}` }),
        JSON.stringify({ text: 'a reply' }),
        daysAgo,
      ],
    );
  });
}

test('the retention floors from F11.5 cannot be configured away', async () => {
  const fixture = await createCompany('retention-floors');

  const defaults = await retentionFor(fixture.companyId);
  assert.ok(defaults.eventDays >= 365, 'events are kept at least twelve months');
  assert.ok(defaults.promptDays >= 90, 'prompts are kept at least ninety days');

  await assert.rejects(
    () => setRetention(fixture.companyId, { eventDays: 30 }),
    /retention_events_at_least_twelve_months/,
    'a window below the stated floor is a misconfiguration, not a preference',
  );
  await assert.rejects(
    () => setRetention(fixture.companyId, { promptDays: 7 }),
    /retention_prompts_at_least_ninety_days/,
  );
  // Scrubbing a prompt after its trace is gone would be a no-op.
  await assert.rejects(
    () => setRetention(fixture.companyId, { promptDays: 400, traceDays: 365 }),
    /retention_prompts_expire_first/,
  );
});

test('prompts are scrubbed while the trace survives', async () => {
  // The two windows exist because the rows carry different risk: the trace
  // says a call happened and what it cost, the prompt may hold a customer's
  // message.
  const fixture = await createCompany('retention-prompts');
  await seedHistory(fixture, 120, 'old');
  await seedHistory(fixture, 10, 'recent');

  const scrubbed = await scrubExpiredPrompts(fixture.companyId);
  assert.equal(scrubbed, 1, 'only the prompt past the ninety-day window');

  const traces = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; prompt: Record<string, unknown>; cost_cents: number }>(
      'SELECT id, prompt, cost_cents FROM llm_traces ORDER BY occurred_at',
    );
    return rows;
  });

  assert.equal(traces.length, 2, 'no trace row was removed');
  assert.deepEqual(traces[0]!.prompt, { redacted: 'retention' });
  assert.equal(traces[0]!.cost_cents, 1, 'the cost history survives the scrub');
  assert.equal((traces[1]!.prompt as { text?: string }).text, 'a customer message from recent');
});

test('an event inside the window cannot be purged, even deliberately', async () => {
  const fixture = await createCompany('retention-window');
  await seedHistory(fixture, 5, 'yesterday');

  const purged = await purgeExpiredEvents(fixture.companyId);
  assert.equal(purged, 0);

  // Even with the purge flag set by hand, the database re-checks the row.
  await assert.rejects(
    () =>
      withControlPlane(async (tx) => {
        await tx.query('SELECT set_config($1, $2, true)', ['app.retention_purge', 'on']);
        await tx.query('DELETE FROM events WHERE company_id = $1', [fixture.companyId]);
      }),
    /inside the .* day retention window/,
  );
});

test('an event cannot be deleted outside a purge at all', async () => {
  const fixture = await createCompany('retention-append-only');
  await seedHistory(fixture, 500, 'ancient');

  await assert.rejects(
    () =>
      withControlPlane((tx) =>
        tx.query('DELETE FROM events WHERE company_id = $1', [fixture.companyId]),
      ),
    /deletion is only possible during a retention purge/,
    'the append-only rule still holds for everything that is not retention',
  );

  // And the application role has no DELETE grant whatsoever, so an agent
  // cannot even attempt it. Asked with has_table_privilege rather than by
  // reading information_schema: that view only shows grants visible to the
  // current role, so a query from another role comes back empty and any loop
  // over it passes without checking anything.
  const privileges = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      can_select: boolean;
      can_insert: boolean;
      can_delete: boolean;
      can_update: boolean;
    }>(
      `SELECT has_table_privilege('palugada_app', 'events', 'SELECT') AS can_select,
              has_table_privilege('palugada_app', 'events', 'INSERT') AS can_insert,
              has_table_privilege('palugada_app', 'events', 'DELETE') AS can_delete,
              has_table_privilege('palugada_app', 'events', 'UPDATE') AS can_update`,
    );
    return rows[0]!;
  });
  assert.equal(privileges.can_select, true);
  assert.equal(privileges.can_insert, true);
  assert.equal(privileges.can_delete, false, 'an agent cannot delete history');
  assert.equal(privileges.can_update, false, 'nor rewrite it');
});

test('a purge past the window succeeds and records itself', async () => {
  // Deleting history is the one operation that can make the log lie by
  // omission, so "there are no events from March" and "March was quiet" have
  // to stay distinguishable.
  const fixture = await createCompany('retention-purge');
  await seedHistory(fixture, 500, 'ancient');
  await seedHistory(fixture, 5, 'recent');

  const outcome = await runRetention(fixture.companyId);
  assert.equal(outcome.eventsPurged, 1);
  assert.equal(outcome.tracesPurged, 1);
  assert.equal(outcome.promptsScrubbed, 1, 'only the trace past the ninety-day window');

  const remaining = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ label: string }>(
      "SELECT payload->>'label' AS label FROM events WHERE type = 'task.completed'",
    );
    return rows.map((row) => row.label);
  });
  assert.deepEqual(remaining, ['recent']);

  const log = await readRetentionLog(fixture.companyId);
  const actions = log.map((entry) => entry.action).sort();
  assert.deepEqual(actions, ['events_purged', 'prompts_scrubbed', 'traces_purged']);
  assert.ok(log.every((entry) => entry.rowsAffected >= 1));

  // The record of a deletion cannot itself be deleted. Nobody holds the
  // privilege, and the trigger would refuse even if somebody did -- two
  // independent barriers, and the test names both rather than assuming the
  // first one it hits is the only one.
  await assert.rejects(
    () => withControlPlane((tx) => tx.query('DELETE FROM retention_log')),
    /permission denied/,
  );

  const canDelete = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ app: boolean; admin: boolean }>(
      `SELECT has_table_privilege('palugada_app', 'retention_log', 'DELETE') AS app,
              has_table_privilege('palugada_admin', 'retention_log', 'DELETE') AS admin`,
    );
    return rows[0]!;
  });
  assert.equal(canDelete.app, false);
  assert.equal(canDelete.admin, false);

  const triggers = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'retention_log'::regclass AND NOT tgisinternal`,
    );
    return rows.map((row) => row.tgname);
  });
  assert.deepEqual(triggers, ['retention_log_append_only']);
});

test('one company\'s retention never touches another\'s history', async () => {
  const mine = await createCompany('retention-mine');
  const theirs = await createCompany('retention-theirs');
  await seedHistory(mine, 500, 'mine-ancient');
  await seedHistory(theirs, 500, 'theirs-ancient');

  await runRetention(mine.companyId);

  const survived = await withTenant(theirs.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'task.completed'",
    );
    return Number(rows[0]!.count);
  });
  assert.equal(survived, 1, "purging one tenant must not reach into another's history");
});

/* ------------------------------------------------------------------------ */
/* Secret rotation (F12.3)                                                   */
/* ------------------------------------------------------------------------ */

async function withCredential(fixture: Fixture, alias: string, ref: string): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, $3, $4)`,
      [fixture.companyId, fixture.divisionId, alias, ref],
    );
  });
}

test('a rotated secret takes effect without a restart (F12.3)', async () => {
  const fixture = await createCompany('rotation');
  await withCredential(fixture, 'dns', 'vault://acme/dns-token');

  const store = new InMemorySecretManager({ 'vault://acme/dns-token': 'old-token-value-1111' });
  // The same process throughout: nothing is recreated between the calls.
  const secrets = new CachedSecretManager(store, { ttlMs: 60_000 });

  const before = await withTenant(fixture.companyId, (tx) =>
    resolveCurrent(tx, secrets, fixture.divisionId, 'dns'),
  );
  assert.equal(before, 'old-token-value-1111');

  // Cached, so a second resolution does not hit the store.
  await withTenant(fixture.companyId, (tx) =>
    resolveCurrent(tx, secrets, fixture.divisionId, 'dns'),
  );
  assert.equal(secrets.size, 1);

  // The operator rotates the value in the secret manager and bumps the version.
  store.set('vault://acme/dns-token', 'new-token-value-2222');
  const rotation = await rotateCredential({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    alias: 'dns',
  });
  assert.equal(rotation.previousVersion, 1);
  assert.equal(rotation.version, 2);

  const after = await withTenant(fixture.companyId, (tx) =>
    resolveCurrent(tx, secrets, fixture.divisionId, 'dns'),
  );
  assert.equal(after, 'new-token-value-2222', 'the same process picked up the new value');
});

test('a rotation may repoint the reference as well as the value', async () => {
  const fixture = await createCompany('rotation-repoint');
  await withCredential(fixture, 'dns', 'vault://acme/dns-token-v1');

  const store = new InMemorySecretManager({
    'vault://acme/dns-token-v1': 'first-token-value-1111',
    'vault://acme/dns-token-v2': 'second-token-value-2222',
  });
  const secrets = new CachedSecretManager(store);

  await withTenant(fixture.companyId, (tx) => resolveCurrent(tx, secrets, fixture.divisionId, 'dns'));

  const rotation = await rotateCredential({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    alias: 'dns',
    newSecretRef: 'vault://acme/dns-token-v2',
  });
  assert.equal(rotation.secretRef, 'vault://acme/dns-token-v2');

  const after = await withTenant(fixture.companyId, (tx) =>
    resolveCurrent(tx, secrets, fixture.divisionId, 'dns'),
  );
  assert.equal(after, 'second-token-value-2222');
});

test('a rotation is recorded, and records no secret', async () => {
  const fixture = await createCompany('rotation-audit');
  await withCredential(fixture, 'dns', 'vault://acme/dns-token');

  await rotateCredential({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    alias: 'dns',
  });

  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'credential.rotated'",
    );
    return rows;
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.version, 2);
  // The reference is a path, not a secret; the value never passes through the
  // rotation code at all.
  assert.equal(events[0]!.payload.secretRef, 'vault://acme/dns-token');
  assert.equal(
    JSON.stringify(events[0]!.payload).includes('token-value'),
    false,
    'no secret value may appear in the audit trail',
  );
});

test('rotating a credential a division does not hold is refused', async () => {
  const fixture = await createCompany('rotation-scope');
  await assert.rejects(
    () =>
      rotateCredential({
        companyId: fixture.companyId,
        divisionId: fixture.divisionId,
        alias: 'nonexistent',
      }),
    /no credential aliased nonexistent/,
  );
});
