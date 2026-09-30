/**
 * Closing a company, and erasing it (UU PDP; the competitive analysis of
 * 2026-09-30, item 11).
 *
 * An owner could freeze a company and export it, and could not make it go
 * away. Every table cascades from the company except its history, which
 * refuses deletion, so the one delete that would have erased it failed on its
 * first event. The people in a company's records have the right to have them
 * erased (UU 27/2022), and an owner ending a business has to be able to.
 *
 * Closing freezes the company at once and names a day between 7 and 90 days
 * away; until that day the owner can keep it. Then the worker erases every
 * row of it -- the append-only history included, which the database allows
 * only for a company that was closed and whose grace is over -- with the keys
 * its divisions held, and keeps one line saying so and how much it removed.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { remember } from '../../src/memory/store.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { closeCompany, eraseDueCompanies, keepCompany } from '../../src/governance/closing.ts';
import { isCompanyFrozen } from '../../src/engine/control.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { Engine } from '../../src/engine/engine.ts';
import { Worker } from '../../src/worker.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** Some of everything a company keeps: work, history, a memory, a key its division holds, a sign-in under way. */
async function lived(fixture: Fixture, secret: string): Promise<void> {
  await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'invoice Budi Santoso' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  await withTenant(fixture.companyId, async (tx) => {
    await appendEvent(tx, {
      companyId: fixture.companyId, type: 'owner.note', actor: 'owner', payload: { said: 'Budi Santoso, 0812-555-0199' },
    });
    await remember(tx, {
      companyId: fixture.companyId, memoryType: 'semantic', scopeType: 'division', scopeId: fixture.divisionId,
      body: 'Budi Santoso wants his invoices by email.', source: 'owner',
    });
    await tx.query(
      "INSERT INTO credentials (company_id, division_id, alias, secret_ref) VALUES ($1, $2, 'crm', $3)",
      [fixture.companyId, fixture.divisionId, `db://${secret}`]);
  });
  await withControlPlane(async (tx) => {
    await tx.query(
      "INSERT INTO deployment_secrets (name, nonce, ciphertext, tag, key_id) VALUES ($1, decode(repeat('00', 12), 'hex'), '\\x00', decode(repeat('00', 16), 'hex'), 'test')",
      [secret]);
    await tx.query(
      `INSERT INTO governance_log (subject, subject_id, company_id, action, before, after, actor)
       VALUES ('charter', gen_random_uuid(), $1, 'created', '{}', '{"body":"Serve Budi first."}', 'owner')`,
      [fixture.companyId]);
    await tx.query(
      `INSERT INTO credential_authorizations
         (state_hash, company_id, division_id, alias, provider, token_url, client_id, auth_method, code_verifier,
          redirect_uri, scope, expires_at)
       VALUES ($1, $2, $3, 'crm', 'hubspot', 'https://api.hubapi.com/oauth/v1/token', 'client', 'client_secret_post', 'verifier',
               'http://127.0.0.1/api/oauth/callback', 'crm.objects.contacts.read', now() + interval '10 minutes')`,
      [`state-${secret}`, fixture.companyId, fixture.divisionId]);
  });
}

/** How many rows of a company every table the control plane may read still holds. */
async function rowsOf(companyId: string): Promise<Record<string, number>> {
  return withControlPlane(async (tx) => {
    const { rows: tables } = await tx.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'company_id' AND NOT a.attisdropped
          AND c.relname <> 'company_erasures' AND has_table_privilege(c.oid, 'SELECT')
        ORDER BY 1`);
    assert.ok(tables.length > 50, `only ${tables.length} tables were read; the sweep is broken`);
    const counts: Record<string, number> = {};
    for (const { table_name: table } of tables) {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId]);
      if (rows[0]!.n > 0) counts[table] = rows[0]!.n;
    }
    return counts;
  });
}

/** The grace period, over: what a clock would do in thirty days. */
async function graceOver(companyId: string): Promise<void> {
  await withControlPlane((tx) => tx.query(
    "UPDATE companies SET closing_at = now() - interval '31 days', erase_after = now() - interval '1 day' WHERE id = $1",
    [companyId]));
}

test('a closed company is frozen at once, and every row of it is erased when its grace is over, and nothing of another', async () => {
  const closing = await createCompany('closing');
  const staying = await createCompany('staying');
  await lived(closing, 'credential-crm-closing');
  await lived(staying, 'credential-crm-staying');
  const before = await rowsOf(closing.companyId);
  const stayingBefore = await rowsOf(staying.companyId);
  const named = await withControlPlane((tx) => tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [closing.companyId]));
  assert.ok(before.events && before.memories && before.tasks && before.governance_log && before.credential_authorizations,
    JSON.stringify(before));

  const { eraseAfter } = await closeCompany(closing.companyId, 30);
  assert.ok(Math.abs(eraseAfter.getTime() - (Date.now() + 30 * 86_400_000)) < 60_000, 'thirty days from now');
  assert.equal(await isCompanyFrozen(closing.companyId), true, 'frozen at once: nothing of theirs starts');
  assert.deepEqual(await eraseDueCompanies(), [], 'not before the day');
  assert.deepEqual(await rowsOf(closing.companyId), { ...before, events: before.events! + 1 }, 'only the closing recorded');

  // The database holds the day too, whatever asks it to erase early.
  await assert.rejects(withControlPlane(async (tx) => {
    await tx.query("SELECT set_config('app.erase_company', $1, true)", [closing.companyId]);
    await tx.query('DELETE FROM events WHERE company_id = $1', [closing.companyId]);
  }), /append-only/);
  await assert.rejects(withControlPlane((tx) => tx.query(
    "INSERT INTO company_erasures (company_id, slug, name, closed_at, counts) VALUES ($1, 'x', 'x', now(), '{}')",
    [closing.companyId])), /grace period is not over/);

  await graceOver(closing.companyId);
  const erased = await eraseDueCompanies();
  assert.deepEqual(erased.map((one) => one.companyId), [closing.companyId]);
  assert.deepEqual(await rowsOf(closing.companyId), {}, 'not a row of it left');
  const companies = await withControlPlane((tx) => tx.query('SELECT id FROM companies WHERE id = $1', [closing.companyId]));
  assert.equal(companies.rows.length, 0);
  const secrets = await withControlPlane((tx) => tx.query<{ name: string }>(
    "SELECT name FROM deployment_secrets WHERE name LIKE 'credential-crm-%' ORDER BY name"));
  assert.deepEqual(secrets.rows.map((row) => row.name), ['credential-crm-staying'], 'its keys went with it, and only its');

  // What is kept: that it was, when it closed and went, and how much went.
  const kept = await withControlPlane((tx) => tx.query<{ name: string; counts: Record<string, number> }>(
    'SELECT name, counts FROM company_erasures WHERE company_id = $1', [closing.companyId]));
  assert.equal(kept.rows[0]!.name, named.rows[0]!.name);
  assert.equal(kept.rows[0]!.counts.tasks, 1);
  assert.equal(kept.rows[0]!.counts.memories, 1);
  assert.ok(kept.rows[0]!.counts.events! >= 2);
  await assert.rejects(withControlPlane((tx) => tx.query(
    "UPDATE company_erasures SET name = 'something else' WHERE company_id = $1", [closing.companyId])), /permission denied/,
  'the control plane may not change the line at all');
  const owner = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  try {
    await assert.rejects(owner.query("DELETE FROM company_erasures WHERE company_id = $1", [closing.companyId]), /append-only/,
      'nor may the schema\'s owner');
  } finally {
    await owner.end();
  }

  assert.deepEqual(await rowsOf(staying.companyId), stayingBefore, 'and the other company is as it was');
  assert.deepEqual(await eraseDueCompanies(), [], 'erased once');
});

test('the worker erases a company whose day has come, and a worker kept to one company does not', async () => {
  const fixture = await createCompany('worker-erases');
  await lived(fixture, 'credential-crm-worker');
  await closeCompany(fixture.companyId, 7);
  await graceOver(fixture.companyId);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-erasing' });
  assert.equal((await new Worker({ engine, companyId: fixture.companyId }).tick()).erased, 0);
  const report = await new Worker({ engine }).tick();
  assert.equal(report.erased, 1, JSON.stringify(report.errors));
  assert.deepEqual(await rowsOf(fixture.companyId), {});
});

test('a closing can be kept until its day, and the company stays frozen until the owner unfreezes it', async () => {
  const fixture = await createCompany('kept');
  await closeCompany(fixture.companyId, 7);
  await assert.rejects(closeCompany(fixture.companyId, 30),
    (error: unknown) => isPalugadaError(error, 'contract.violation') && /already closing/.test((error as Error).message));
  await keepCompany(fixture.companyId);
  assert.deepEqual(await eraseDueCompanies(), []);
  assert.equal(await isCompanyFrozen(fixture.companyId), true, 'kept, not restarted: unfreezing is its own decision');
  const row = await withControlPlane((tx) => tx.query<{ closing_at: Date | null }>(
    'SELECT closing_at FROM companies WHERE id = $1', [fixture.companyId]));
  assert.equal(row.rows[0]!.closing_at, null);
});

test('the grace is seven to ninety days, and the database will not be given less', async () => {
  const fixture = await createCompany('grace');
  for (const days of [0, 6, 91, 1.5]) {
    await assert.rejects(closeCompany(fixture.companyId, days),
      (error: unknown) => isPalugadaError(error, 'contract.violation') && /7 to 90 days/.test((error as Error).message), String(days));
  }
  await assert.rejects(withControlPlane((tx) => tx.query(
    "UPDATE companies SET closing_at = now(), erase_after = now() + interval '1 day' WHERE id = $1", [fixture.companyId])),
  /companies_closing_grace/);
});

test('the owner closes a company from the console with a factor and its name, sees the day, keeps it, and sees what was erased', async () => {
  const fixture = await createCompany('closing-console');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = async () => (await api.call('GET', '/api/companies', token)).body.companies
      .find((one: { id: string }) => one.id === fixture.companyId) as { name: string; frozen: boolean; eraseAfter: string | null } | undefined;
    const { name } = (await listed())!;
    const path = `/api/companies/${fixture.companyId}/close`;

    assert.equal((await api.call('POST', path, token, { days: 30, name })).status, 403, 'a factor, like every irreversible act');
    const misnamed = await api.call('POST', path, token, { days: 30, name: 'another company', proof: { totp: api.code() } });
    assert.equal(misnamed.status, 400);
    assert.match(misnamed.body.error, /type the company's name/);

    const closed = await api.call('POST', path, token, { days: 30, name, proof: { totp: api.code() } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const shown = (await listed())!;
    assert.equal(shown.frozen, true);
    assert.ok(shown.eraseAfter && new Date(shown.eraseAfter).getTime() > Date.now() + 29 * 86_400_000);

    const thaw = await api.call('POST', `/api/control/company/${fixture.companyId}/freeze`, token, { on: false, proof: { totp: api.code() } });
    assert.equal(thaw.status, 400, 'a closing company is not unfrozen: it is kept first');
    assert.match(thaw.body.error, /closing/);

    const kept = await api.call('POST', `${path}/keep`, token, {});
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal((await listed())!.eraseAfter, null);

    await api.call('POST', path, token, { days: 7, name, proof: { totp: api.code() } });
    await graceOver(fixture.companyId);
    await eraseDueCompanies();
    assert.equal(await listed(), undefined);
    const erasures = await api.call('GET', '/api/erasures', token);
    assert.equal(erasures.status, 200);
    assert.deepEqual(erasures.body.erasures.map((one: { name: string }) => one.name), [name]);
  } finally {
    await api.close();
  }
});
