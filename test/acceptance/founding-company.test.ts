/**
 * A company starts with its CEO and nothing else (the owner's feedback of 7
 * October: "why is there a built-in team template when the CEO can arrange
 * everything").
 *
 * It used to start from a standard template: seven divisions and a role in
 * each, which the owner read before the company had sold anything and which
 * the CEO could not have bettered for any particular business. A company now
 * begins with one division, the CEO, and what the owner says it is for; the
 * team is built as the work asks for it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { firstHourOpener } from '../../src/owner/first-hour.ts';
import { installFoundingTemplate } from '../../src/templates/founding.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup, runMigrationAgain } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(async () => {
  await resetData();
  await registerStandardCatalogue();
  await installFoundingTemplate();
});
after(async () => {
  await closePools();
  await closeSetup();
});

type Structure = {
  divisions: Array<{ slug: string; name: string; escalationRole: string | null; escalateAfterMinutes: number | null }>;
  roles: Array<{ slug: string; title: string | null; displayName: string | null; tools: string[]; division: string }>;
  goals: Array<{ kind: string; slug: string; statement: string }>;
};

async function started(body: Record<string, unknown> = {}) {
  const api = await consoleWithSettings();
  const owner = await api.signIn();
  const made = await api.call('POST', '/api/companies', owner, { companySlug: 'toko-kopi', name: 'Toko Kopi', proof: { totp: api.code() }, ...body });
  if (made.status !== 200) await api.close();
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const structure = (await api.call('GET', `/api/companies/${made.body.companyId}/structure`, owner)).body as Structure;
  return { api, owner, made: made.body as { companyId: string; divisions: string[]; roles: string[] }, structure };
}

test('a company that names no template starts with one division, its CEO and one goal', async () => {
  const { api, structure, made } = await started();
  try {
    assert.deepEqual(made.divisions, ['management']);
    assert.deepEqual(made.roles, ['coordinator']);
    assert.deepEqual(structure.divisions.map((one) => one.slug), ['management']);
    assert.deepEqual(structure.roles.map((one) => [one.slug, one.title, one.displayName]), [['coordinator', 'CEO', 'Arka']]);
    assert.deepEqual(structure.goals.map((one) => one.kind), ['mission']);
    // Who hears first about the division's trouble, as the Organization page
    // says it: the CEO, for an hour, then the owner -- though nobody set it.
    assert.deepEqual(structure.divisions.map((one) => [one.escalationRole, one.escalateAfterMinutes]), [['coordinator', 60]]);
    // The CEO can hand work on and look again later, and holds the most tools a role may.
    const ceo = structure.roles[0]!;
    for (const tool of ['task.delegate', 'task.await', 'ticket.create', 'ticket.list', 'task.follow_up', 'schedule.propose', 'owner.ask', 'goal.propose']) {
      assert.ok(ceo.tools.includes(tool), `the CEO holds ${tool}`);
    }
    // F18.7: it proposes the plan of new goals, and gave up drafting for it,
    // so it stays at the twelve a role may hold (F2.6). Its division keeps
    // the draft's grant, so the owner can trade it back on Team.
    assert.equal(ceo.tools.length, 12);
    assert.equal(ceo.tools.includes('doc.draft'), false);
    const { rows: grants } = await withControlPlane((tx) => tx.query<{ capability_name: string }>(
      'SELECT capability_name FROM capability_grants WHERE company_id = $1', [made.companyId]));
    const granted = grants.map((grant) => grant.capability_name);
    assert.ok(granted.includes('goal.propose') && granted.includes('doc.draft'), granted.join(', '));
  } finally {
    await api.close();
  }
});

test('what the owner says the company is for becomes its mission, in their words', async () => {
  const words = 'Menjual kopi Gayo ke kafe dan kantor di Bandung, diantar dalam sehari.';
  const { api, structure, made } = await started({ mission: words });
  try {
    assert.equal(structure.goals.find((goal) => goal.kind === 'mission')!.statement, words);
    // And the company's charter, which the CEO's first run is told first, says it too.
    const { rows } = await withControlPlane((tx) => tx.query<{ body: string }>(
      'SELECT body FROM charters WHERE company_id = $1 ORDER BY version DESC LIMIT 1', [made.companyId]));
    assert.ok((rows[0]?.body ?? '').includes(words), 'the charter carries the owner\'s sentence');
  } finally {
    await api.close();
  }
});

test('a mission is a sentence or two: a blank one is no mission, and a runaway one is refused', async () => {
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const make = (mission: unknown) => api.call('POST', '/api/companies', owner,
      { companySlug: 'toko-kopi', name: 'Toko Kopi', mission, proof: { totp: api.code() } });
    const runaway = await make('x'.repeat(2_001));
    assert.equal(runaway.status, 400, JSON.stringify(runaway.body));
    assert.match(String(runaway.body.error), /mission is at most 2000 characters/);
    const wrong = await make(42);
    assert.equal(wrong.status, 400);
    // Spaces alone say nothing, so the company starts with the default.
    const blank = await make('   ');
    assert.equal(blank.status, 200, JSON.stringify(blank.body));
    const goals = (await api.call('GET', `/api/companies/${blank.body.companyId}/structure`, owner)).body.goals as Structure['goals'];
    assert.ok(goals[0]!.statement.length > 0);
  } finally {
    await api.close();
  }
});

test('a template that does not exist is still refused by name', async () => {
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const refused = await api.call('POST', '/api/companies', owner,
      { templateSlug: 'no-such-template', companySlug: 'toko-kopi', name: 'Toko Kopi', proof: { totp: api.code() } });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /no company template named no-such-template/);
  } finally {
    await api.close();
  }
});

test('a CEO that has been told what the company is for does not ask what it sells, and offers to build the team', async () => {
  const words = 'Menjual kopi Gayo ke kafe dan kantor di Bandung, diantar dalam sehari.';
  const { api, owner, made } = await started({ mission: words, talkLanguage: 'id', workLanguage: 'id' });
  try {
    const talk = await api.call('GET', `/api/companies/${made.companyId}/conversation`, owner);
    const [opener] = talk.body.messages as Array<{ role: string; body: string }>;
    assert.equal(opener!.role, 'assistant');
    assert.equal(opener!.body, firstHourOpener('id', { ceo: 'Arka', company: 'Toko Kopi', mission: words }));
    assert.ok(opener!.body.includes(words), 'it repeats the owner\'s sentence, so the owner sees it was heard');
    assert.doesNotMatch(opener!.body, /apa yang dijual/, 'and does not ask what the company sells');
    // Said in the owner's language, not the English it is written in.
    assert.notEqual(opener!.body, firstHourOpener(null, { ceo: 'Arka', company: 'Toko Kopi', mission: words }));
  } finally {
    await api.close();
  }
});

test('a company started without a mission is opened with the three questions, as before', async () => {
  const { api, owner, made } = await started({ talkLanguage: 'id', workLanguage: 'id' });
  try {
    const talk = await api.call('GET', `/api/companies/${made.companyId}/conversation`, owner);
    assert.equal(talk.body.messages[0].body, firstHourOpener('id', { ceo: 'Arka', company: 'Toko Kopi' }));
    assert.match(talk.body.messages[0].body, /apa yang dijual/);
  } finally {
    await api.close();
  }
});

/**
 * A CEO started before it held goal.propose has the founding tools of then:
 * doc.draft where goal.propose now is. 0141 trades the one for the other where
 * the owner left the tools as they were founded, with a version to roll back
 * to, and leaves a CEO the owner has changed as the owner left it.
 */
test('0141 gives an existing CEO goal.propose in place of doc.draft, only where its tools are still the founding ones (F18.7)', async () => {
  const { api, owner, made } = await started();
  try {
    const other = await api.call('POST', '/api/companies', owner, { companySlug: 'toko-teh', name: 'Toko Teh', proof: { totp: api.code() } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    const second = { made: other.body as { companyId: string } };
    const OLD = ['memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask', 'task.delegate', 'task.await',
      'schedule.propose', 'ticket.create', 'ticket.list', 'task.follow_up', 'doc.draft'];
    const ceoOf = async (companyId: string) => (await withControlPlane((tx) => tx.query<{ id: string; tools: string[]; system_prompt: string }>(
      "SELECT id, tools, system_prompt FROM roles WHERE company_id = $1 AND title = 'CEO'", [companyId]))).rows[0]!;
    // As 0141 finds them: the first as it was founded, the second changed by its owner.
    await withControlPlane(async (tx) => {
      await tx.query("UPDATE roles SET tools = $2::text[] WHERE company_id = $1 AND title = 'CEO'", [made.companyId, OLD]);
      await tx.query("UPDATE roles SET tools = $2::text[] WHERE company_id = $1 AND title = 'CEO'", [second.made.companyId, [...OLD.slice(0, 11), 'web.search']]);
      await tx.query("DELETE FROM capability_grants WHERE company_id = ANY($1::uuid[]) AND capability_name = 'goal.propose'", [[made.companyId, second.made.companyId]]);
    });
    const versionsOf = async (companyId: string, kind: string) => (await withControlPlane((tx) => tx.query<{ snapshot: Record<string, unknown>; summary: string; changed_by: string }>(
      'SELECT snapshot, summary, changed_by FROM config_versions WHERE company_id = $1 AND kind = $2 ORDER BY version', [companyId, kind]))).rows;
    const roleVersions = (await versionsOf(made.companyId, 'role')).length;

    await runMigrationAgain('0141_the_ceo_proposes_goals.sql');

    const ceo = await ceoOf(made.companyId);
    assert.deepEqual(ceo.tools, [...OLD.slice(0, 11), 'goal.propose']);
    const versions = await versionsOf(made.companyId, 'role');
    assert.equal(versions.length, roleVersions + 1, 'the CEO as it was is a version to roll back to');
    assert.deepEqual(versions.at(-1)!.snapshot.tools, OLD);
    assert.equal(versions.at(-1)!.changed_by, 'platform');
    assert.match(versions.at(-1)!.summary, /before it was given goal\.propose in place of doc\.draft \(0141\)/);
    const grants = await versionsOf(made.companyId, 'grant');
    assert.deepEqual(grants.at(-1)!.snapshot, { capability: 'goal.propose', before: null, after: { tierOverride: null, maxInFlight: null } });
    const { rows } = await withControlPlane((tx) => tx.query<{ company_id: string; capability_name: string }>(
      "SELECT company_id, capability_name FROM capability_grants WHERE capability_name IN ('goal.propose', 'doc.draft') AND company_id = ANY($1::uuid[]) ORDER BY capability_name",
      [[made.companyId, second.made.companyId]]));
    assert.deepEqual(rows.filter((row) => row.company_id === made.companyId).map((row) => row.capability_name), ['doc.draft', 'goal.propose'],
      'the division keeps the draft\'s grant');
    assert.equal(rows.some((row) => row.company_id === second.made.companyId && row.capability_name === 'goal.propose'), false);
    assert.deepEqual((await ceoOf(second.made.companyId)).tools, [...OLD.slice(0, 11), 'web.search'], 'an owner\'s change is the owner\'s');

    // Run twice, it does nothing twice.
    await runMigrationAgain('0141_the_ceo_proposes_goals.sql');
    assert.equal((await versionsOf(made.companyId, 'role')).length, roleVersions + 1);
  } finally {
    await api.close();
  }
});
