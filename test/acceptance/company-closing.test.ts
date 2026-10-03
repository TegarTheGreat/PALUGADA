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
 *
 * Each company is erased on its own, so one that fails holds back no other,
 * and what it kept on disk -- its files, its charter's folder -- goes after
 * its rows (0096; read in Buzz's source, 2026-09-30).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { remember } from '../../src/memory/store.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { closeCompany, closingOf, eraseDueCompanies, keepCompany } from '../../src/governance/closing.ts';
import { CharterRepository } from '../../src/governance/charter-repository.ts';
import { publishCharter } from '../../src/governance/store.ts';
import { companyRoot } from '../../src/capabilities/files.ts';
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

/** Where the keys of the customer channel `lived` gives a company are sealed (0111, 0112): its token, and its app secret. */
function chatSecretOf(secret: string, which: 'token' | 'app' = 'token'): string {
  return `chat-${createHash('sha256').update(`${which} ${secret}`).digest('hex').slice(0, 16)}`;
}

/**
 * Some of everything a company keeps: work, history, a memory, a key its
 * division holds, a sign-in under way, and a customer's conversation on a bot
 * whose token is sealed.
 */
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
    for (const name of [secret, chatSecretOf(secret), chatSecretOf(secret, 'app')]) {
      await tx.query(
        "INSERT INTO deployment_secrets (name, nonce, ciphertext, tag, key_id) VALUES ($1, decode(repeat('00', 12), 'hex'), '\\x00', decode(repeat('00', 16), 'hex'), 'test')",
        [name]);
    }
    const { rows: [channel] } = await tx.query<{ id: string }>(
      `INSERT INTO chat_channels (company_id, kind, account, account_id, project_id, division_id, role_id, goal_id,
                                  instruction, token_ref, secret_ref, webhook_hash)
       VALUES ($1, 'whatsapp', $2, '106540352242922', $3, $4, $5, $6, 'Answer Budi.', $7, $8, $9) RETURNING id`,
      [fixture.companyId, `62812${parseInt(createHash('sha256').update(secret).digest('hex').slice(0, 8), 16)}`, fixture.projectId,
        fixture.divisionId, fixture.roleId, fixture.goalId, `db://${chatSecretOf(secret)}`, `db://${chatSecretOf(secret, 'app')}`,
        createHash('sha256').update('hook').digest('hex')]);
    const { rows: [chat] } = await tx.query<{ id: string }>(
      "INSERT INTO chats (company_id, channel_id, external_id, customer_name) VALUES ($1, $2, '4242', 'Budi Santoso') RETURNING id",
      [fixture.companyId, channel!.id]);
    await tx.query(
      "INSERT INTO chat_messages (company_id, chat_id, direction, external_id, body, outcome) VALUES ($1, $2, 'in', '1', 'Invoice saya mana?', 'started')",
      [fixture.companyId, chat!.id]);
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

/** The grace period, over some days ago: what a clock would do in thirty days. */
async function graceOver(companyId: string, daysAgo = 1): Promise<void> {
  await withControlPlane((tx) => tx.query(
    "UPDATE companies SET closing_at = now() - interval '31 days', erase_after = now() - make_interval(days => $2) WHERE id = $1",
    [companyId, daysAgo]));
}

const exec = promisify(execFile);

/** Whether anything is at a path, a link included. */
async function there(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/**
 * Runs `work` while a trigger the schema's owner puts on `table` refuses the
 * rows `when` names, as a failure nobody planned would: a trigger somebody
 * added, a constraint, a statement that timed out. Taken off again whatever
 * happens, so no later test meets it.
 */
async function refusing<T>(table: string, operation: 'INSERT' | 'DELETE', when: string, work: () => Promise<T>): Promise<T> {
  const owner = new pg.Pool({ connectionString: connectionString('owner'), max: 1 });
  try {
    await owner.query(`CREATE FUNCTION public.test_refuses() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused by the test on %', TG_TABLE_NAME; END $$`);
    await owner.query(
      `CREATE TRIGGER test_refuses BEFORE ${operation} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.test_refuses()`);
    return await work();
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS test_refuses ON ${table}`);
    await owner.query('DROP FUNCTION IF EXISTS public.test_refuses()');
    await owner.end();
  }
}

/** A charter repository and a files root of the test's own, with each company's charter and a draft in them. */
async function onDisk(...fixtures: Fixture[]): Promise<{ filesRoot: string; charters: CharterRepository }> {
  const filesRoot = await mkdtemp(join(tmpdir(), 'palugada-files-'));
  const charters = new CharterRepository({ root: join(await mkdtemp(join(tmpdir(), 'palugada-erased-')), 'charters') });
  for (const fixture of fixtures) {
    await publishCharter({ companyId: fixture.companyId, body: `# ${fixture.slug}\n\nServe Budi Santoso first.` });
    const drafts = join(await companyRoot(filesRoot, fixture.companyId), 'drafts');
    await mkdir(drafts, { recursive: true });
    await writeFile(join(drafts, 'invoice.md'), 'Budi Santoso, 0812-555-0199\n', 'utf8');
  }
  assert.equal((await charters.sync()).git, 'committed');
  return { filesRoot, charters };
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
  assert.deepEqual((await eraseDueCompanies()).erased, [], 'not before the day');
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
  const { erased } = await eraseDueCompanies();
  assert.deepEqual(erased.map((one) => one.companyId), [closing.companyId]);
  assert.deepEqual(await rowsOf(closing.companyId), {}, 'not a row of it left');
  const companies = await withControlPlane((tx) => tx.query('SELECT id FROM companies WHERE id = $1', [closing.companyId]));
  assert.equal(companies.rows.length, 0);
  const secrets = await withControlPlane((tx) => tx.query<{ name: string }>(
    "SELECT name FROM deployment_secrets WHERE name LIKE 'credential-crm-%' ORDER BY name"));
  assert.deepEqual(secrets.rows.map((row) => row.name), ['credential-crm-staying'], 'its keys went with it, and only its');
  const bots = await withControlPlane((tx) => tx.query<{ name: string }>(
    "SELECT name FROM deployment_secrets WHERE name LIKE 'chat-%' ORDER BY name"));
  assert.deepEqual(bots.rows.map((row) => row.name),
    [chatSecretOf('credential-crm-staying'), chatSecretOf('credential-crm-staying', 'app')].sort(), 'and its channel\'s keys, and only its');

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
  assert.deepEqual(await eraseDueCompanies(), { erased: [], failed: [], leftBehind: [] }, 'erased once');
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
  assert.deepEqual((await eraseDueCompanies()).erased, []);
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

/**
 * One company that could not be erased stopped every company after it (read
 * in Buzz's source, 2026-09-30). The pass went through the due companies in
 * order with no catch of its own and the worker's stage swallowed what it
 * threw, so the oldest failure -- a trigger refusing, a statement timing out
 * on a large company -- was every later company's too, on every tick, and all
 * that showed was a count of stage failures. Each company is erased on its
 * own now: a failure is kept on the company and said on the tick, the next
 * company is erased in the same pass, and the one that failed waits longer
 * each time before it is tried again rather than failing every few seconds.
 */
test('a company that cannot be erased does not stop the next, is named with its reason, and waits before it is tried again', async () => {
  const stuck = await createCompany('erase-stuck');
  const next = await createCompany('erase-next');
  await lived(stuck, 'credential-crm-stuck');
  await lived(next, 'credential-crm-next');
  await closeCompany(stuck.companyId, 7);
  await closeCompany(next.companyId, 7);
  // The stuck one's day came first, so it is first in the pass.
  await graceOver(stuck.companyId, 2);
  await graceOver(next.companyId, 1);
  const stuckBefore = await rowsOf(stuck.companyId);
  const named = await withControlPlane((tx) => tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [stuck.companyId]));
  const { name } = named.rows[0]!;
  const refused = `OLD.id = '${stuck.companyId}'`;

  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-stuck' });
  const report = await refusing('companies', 'DELETE', refused, () => new Worker({ engine }).tick());
  assert.equal(report.erased, 1, 'the next company went in the same tick');
  assert.deepEqual(await rowsOf(next.companyId), {});
  const said = report.errors.filter((one) => one.stage === 'erasure');
  assert.equal(said.length, 1, JSON.stringify(report.errors));
  assert.ok(said[0]!.message.includes(name) && said[0]!.message.includes(stuck.companyId), said[0]!.message);
  assert.match(said[0]!.message, /refused by the test on companies/);
  assert.deepEqual(await rowsOf(stuck.companyId), stuckBefore, 'and nothing of the one that failed went');

  // Kept on the company, where the owner sees it beside what was erased.
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = await api.call('GET', '/api/erasures', token);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.erasures.map((one: { companyId: string }) => one.companyId), [next.companyId]);
    assert.equal(listed.body.failing.length, 1);
    const [failing] = listed.body.failing as Array<{ companyId: string; name: string; attempts: number; failure: string; retryAt: string }>;
    assert.equal(failing!.companyId, stuck.companyId);
    assert.equal(failing!.name, name);
    assert.equal(failing!.attempts, 1);
    assert.match(failing!.failure, /refused by the test on companies/);
    const wait = new Date(failing!.retryAt).getTime() - Date.now();
    assert.ok(wait > 30_000 && wait <= 60_000, `a minute before the next try, not the next tick: ${wait}`);
  } finally {
    await api.close();
  }
  assert.deepEqual(await eraseDueCompanies(), { erased: [], failed: [], leftBehind: [] }, 'it waits');

  // Its time comes, and it is refused again: it waits twice as long.
  await withControlPlane((tx) => tx.query('UPDATE companies SET erase_retry_at = now() WHERE id = $1', [stuck.companyId]));
  const again = await refusing('companies', 'DELETE', refused, () => eraseDueCompanies());
  assert.deepEqual(again.erased, []);
  assert.deepEqual(again.failed.map((one) => [one.companyId, one.attempts]), [[stuck.companyId, 2]]);
  assert.ok(again.failed[0]!.retryAt!.getTime() - Date.now() > 90_000, 'two minutes this time');

  // Kept, nothing of the failure stays on it; closed again and due, it goes.
  await keepCompany(stuck.companyId);
  const kept = await withControlPlane((tx) => tx.query<{ erase_attempts: number; erase_failure: string | null; erase_retry_at: Date | null }>(
    'SELECT erase_attempts, erase_failure, erase_retry_at FROM companies WHERE id = $1', [stuck.companyId]));
  assert.deepEqual(kept.rows[0], { erase_attempts: 0, erase_failure: null, erase_retry_at: null });
  await closeCompany(stuck.companyId, 7);
  await graceOver(stuck.companyId);
  const last = await eraseDueCompanies();
  assert.deepEqual(last.erased.map((one) => one.companyId), [stuck.companyId]);
  assert.deepEqual(await rowsOf(stuck.companyId), {});
});

/**
 * An erasure deleted rows and nothing else (read in Buzz's source,
 * 2026-09-30). What a company's roles wrote -- drafts, pictures, recordings
 * -- is kept in its own directory under the files root, and its charter in
 * the charter repository's `companies/<slug>/`, and both outlived it. They go
 * after its rows, from the roots the deployment knows, and the charter's
 * removal is committed like every other change there. The repository's
 * history is not rewritten, and still holds what the charter said: the guide
 * says so.
 */
test('erasing a company removes its files and its charter, commits the removal, and leaves another company\'s as they were', async () => {
  const closing = await createCompany('erase-files');
  const staying = await createCompany('keep-files');
  const disk = await onDisk(closing, staying);
  const soul = (fixture: Fixture) => join(disk.charters.root, 'companies', fixture.slug, 'SOUL.md');
  const draft = (fixture: Fixture) => join(disk.filesRoot, fixture.companyId, 'drafts', 'invoice.md');
  assert.ok(await there(soul(closing)) && await there(draft(closing)));

  await closeCompany(closing.companyId, 7);
  await graceOver(closing.companyId);
  const pass = await eraseDueCompanies(disk);
  assert.deepEqual(pass.erased.map((one) => one.companyId), [closing.companyId]);
  assert.deepEqual(pass.leftBehind, []);
  assert.equal(await there(join(disk.filesRoot, closing.companyId)), false, 'its files went');
  assert.equal(await there(join(disk.charters.root, 'companies', closing.slug)), false, 'and its charter');
  assert.equal(await readFile(draft(staying), 'utf8'), 'Budi Santoso, 0812-555-0199\n', 'another company\'s files stay');
  assert.match(await readFile(soul(staying), 'utf8'), /Serve Budi Santoso first/);

  const git = async (...args: string[]) => (await exec('git', ['-C', disk.charters.root, ...args])).stdout.trim();
  assert.deepEqual((await git('ls-files', 'companies')).split('\n'), [`companies/${staying.slug}/SOUL.md`], 'the removal is committed');
  assert.equal(await git('status', '--porcelain'), '', 'and nothing is left uncommitted');
  assert.match(await git('log', '-1', '--format=%an|%s'), new RegExp(`^PALUGADA\\|.*${closing.slug}`));
  // What an erasure does not reach: the history still holds what it said.
  assert.match(await git('log', '--format=%s', '--', `companies/${closing.slug}/SOUL.md`), /Charter v1/);

  // The next sync neither writes it back nor calls it somebody else's.
  const synced = await disk.charters.sync();
  assert.deepEqual([synced.written, synced.unknown, synced.refused], [[], [], []]);
});

/**
 * What cannot be removed is said, not skipped, and does not bring the rows
 * back: the rows are most of what the right to erasure is about, and they are
 * not held hostage to a directory. What an erasure left on disk -- one that
 * ran before files were removed, a process that stopped between the rows and
 * the files, a removal that failed -- is removed on a worker's first tick.
 */
test('what an erasure cannot remove from disk is reported and the rows stay erased, and a worker removes what earlier erasures left', async () => {
  const linked = await createCompany('erase-linked');
  const earlier = await createCompany('erase-earlier');
  const disk = await onDisk(linked, earlier);

  // A charter folder that leads out of the repository is never followed,
  // so it is not removed: said, with where and why.
  const outside = await mkdtemp(join(tmpdir(), 'palugada-outside-'));
  await writeFile(join(outside, 'SOUL.md'), 'Not the repository\'s.\n', 'utf8');
  const folder = join(disk.charters.root, 'companies', linked.slug);
  await rm(folder, { recursive: true });
  await symlink(outside, folder);
  await closeCompany(linked.companyId, 7);
  await graceOver(linked.companyId);
  const pass = await eraseDueCompanies(disk);
  assert.deepEqual(pass.erased.map((one) => one.companyId), [linked.companyId]);
  assert.deepEqual(await rowsOf(linked.companyId), {}, 'the rows stay erased');
  assert.equal(await there(join(disk.filesRoot, linked.companyId)), false, 'and what could be removed was');
  assert.deepEqual(pass.leftBehind.map((one) => [one.companyId, one.path]), [[linked.companyId, folder]]);
  assert.match(pass.leftBehind[0]!.reason, /link/);
  assert.equal(await readFile(join(outside, 'SOUL.md'), 'utf8'), 'Not the repository\'s.\n', 'and nothing through the link');

  // The operator takes the link away. Then an erasure of rows alone: one
  // from before files were removed, or one cut off before it reached them.
  await rm(folder);
  await closeCompany(earlier.companyId, 7);
  await graceOver(earlier.companyId);
  assert.deepEqual((await eraseDueCompanies()).erased.map((one) => one.companyId), [earlier.companyId]);
  assert.ok(await there(join(disk.filesRoot, earlier.companyId)), 'left behind');

  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'worker-leftovers' });
  const report = await new Worker({ engine, erasure: disk }).tick();
  assert.deepEqual(report.errors.filter((one) => one.stage === 'erasure'), []);
  assert.equal(await there(join(disk.filesRoot, earlier.companyId)), false, 'its files went on the first tick');
  assert.equal(await there(join(disk.charters.root, 'companies', earlier.slug)), false, 'and its charter');
  const status = (await exec('git', ['-C', disk.charters.root, 'status', '--porcelain'])).stdout.trim();
  assert.equal(status, '', 'both removals committed, the linked one\'s too');
});

/**
 * An erasure is one delete of the company, and the cascade from `companies`
 * is what reaches every other table. A table added with a `company_id` and
 * no cascade would either stop every erasure (a reference that refuses) or
 * be left behind by it (no reference at all) -- found here, from the
 * catalogue, rather than by the first owner whose company would not go.
 */
test('every table with a company_id goes with its company by a cascade, or is named here with how it goes', async () => {
  const NOT_BY_CASCADE: Record<string, string> = {
    company_erasures: 'the line an erasure leaves, which outlives the company on purpose',
    credential_authorizations: 'a vendor sign-in under way, keyed by its state; eraseCompany deletes it by the company before the company',
  };
  const { rows } = await withControlPlane((tx) => tx.query<{ table_name: string; cascades: boolean }>(
    `SELECT c.relname AS table_name,
            EXISTS (SELECT 1 FROM pg_constraint k
                     WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid = 'companies'::regclass
                       AND k.confdeltype = 'c' AND a.attnum = ANY (k.conkey)) AS cascades
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'company_id' AND NOT a.attisdropped
      ORDER BY 1`));
  assert.ok(rows.length > 50, `only ${rows.length} tables were read; the sweep is broken`);
  const uncascaded = rows.filter((row) => !row.cascades).map((row) => row.table_name);
  assert.deepEqual(uncascaded, Object.keys(NOT_BY_CASCADE).sort(),
    'a table with a company_id that no cascade from companies reaches: give it one, or say here how an erasure reaches it');
});

/**
 * Closing and keeping each wrote the company's row, committed it, and then
 * wrote the event that records it in a second transaction: a process that
 * stopped between the two closed or kept a company with nothing in its
 * history to say so. One transaction now, so neither happens without its
 * record.
 */
test('a closing and a keeping are written with their record, or not at all', async () => {
  const fixture = await createCompany('closing-atomic');
  await assert.rejects(refusing('events', 'INSERT', "NEW.type = 'company.closing'", () => closeCompany(fixture.companyId, 7)),
    /refused by the test on events/);
  assert.equal(await closingOf(fixture.companyId), null, 'not closing without its record');
  assert.equal(await isCompanyFrozen(fixture.companyId), false, 'nor frozen');

  await closeCompany(fixture.companyId, 7);
  await assert.rejects(refusing('events', 'INSERT', "NEW.type = 'company.kept'", () => keepCompany(fixture.companyId)),
    /refused by the test on events/);
  assert.ok(await closingOf(fixture.companyId), 'still closing without the record of keeping it');
  const events = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string }>(
    "SELECT type FROM events WHERE company_id = $1 AND type LIKE 'company.%' ORDER BY occurred_at", [fixture.companyId]));
  assert.deepEqual(events.rows.map((row) => row.type), ['company.closing']);
});
