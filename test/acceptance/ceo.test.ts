/**
 * The CEO (src/governance/ceo.ts, migration 0068).
 *
 * The owner asked who it is that talks to them, and said the CEO should be
 * required. These hold both: every company that has roles has exactly one
 * CEO, kept by the database whatever path a change takes, moved only by an
 * appointment the owner makes with their device; and the conversation on a
 * company's pages is with that CEO -- its name, its persona, its company and
 * nothing outside it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { rollBack } from '../../src/governance/rollback.ts';
import { addRole } from '../../src/governance/structure.ts';
import { appointCeo } from '../../src/governance/ceo.ts';
import { WEB_OPS } from '../../src/bundles/builtin.ts';
import { installBundle, publishBundle } from '../../src/bundles/bundle.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { createCompanyFromTemplate, saveTemplate, type CompanyTemplate } from '../../src/templates/company.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import type { LlmBlock, LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Line = Pick<LlmTurn, 'content' | 'stopReason'>;

/** A model the test writes the lines of, which records what it was asked. */
class ScriptedModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  readonly #script: Line[];

  constructor(script: Line[]) {
    this.#script = script;
  }

  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    const line = this.#script[this.requests.length - 1];
    if (!line) throw new Error(`the script has no line ${this.requests.length}`);
    return { ...line, inputTokens: 100, outputTokens: 10, costCents: 0 };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

const says = (text: string): Line => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const uses = (...calls: Array<[string, unknown]>): Line => ({
  content: calls.map(([name, input], index) => ({ type: 'tool_use', id: `call-${name}-${index}`, name, input })),
  stopReason: 'tool_use',
});

function results(model: ScriptedModel, request: number): Array<{ content: string; isError?: boolean }> {
  const last = model.requests[request]!.messages.at(-1)!;
  return (last.content as LlmBlock[]).filter((block): block is Extract<LlmBlock, { type: 'tool_result' }> => block.type === 'tool_result');
}

async function titles(companyId: string): Promise<Record<string, string | null>> {
  const { rows } = await withTenant(companyId, (tx) =>
    tx.query<{ slug: string; title: string | null }>('SELECT slug, title FROM roles ORDER BY slug'));
  return Object.fromEntries(rows.map((row) => [row.slug, row.title]));
}

async function secondRole(fixture: Fixture, slug: string): Promise<string> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, output_schema, done_criteria, display_name)
     VALUES ($1, $2, $3, 'You build.', 'test-model', '{"type":"object"}', ARRAY['it is built'], 'Bima') RETURNING id`,
    [fixture.companyId, fixture.divisionId, slug]));
  return rows[0]!.id;
}

test('the database keeps one CEO in every company that has roles: never two, never none', async () => {
  const fixture = await createCompany('ceo-db');
  const builder = await secondRole(fixture, 'builder');
  assert.deepEqual(await titles(fixture.companyId), { builder: null, worker: 'CEO' }, 'the fixture\'s first role is its CEO');

  await assert.rejects(
    withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET title = 'CEO' WHERE id = $1", [builder])),
    /roles_one_ceo/, 'a second CEO');
  await assert.rejects(
    withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET title = 'Ceo' WHERE id = $1", [builder])),
    /roles_ceo_spelling/, 'nor one spelled another way to get past the first rule');
  await assert.rejects(
    withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET title = 'COO' WHERE id = $1", [fixture.roleId])),
    /a company always has a CEO/, 'none, when the CEO is retitled');
  await assert.rejects(
    withControlPlane((tx) => tx.query('DELETE FROM roles WHERE id = $1', [fixture.roleId])),
    /a company always has a CEO/, 'none, when the CEO goes');

  // Inside one transaction the title can move, since the rule is held at commit.
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query('UPDATE roles SET title = NULL WHERE id = $1', [fixture.roleId]);
    await tx.query("UPDATE roles SET title = 'CEO' WHERE id = $1", [builder]);
  });
  assert.deepEqual(await titles(fixture.companyId), { builder: 'CEO', worker: null });

  // A company with no roles at all has nobody to require it of.
  await withControlPlane((tx) => tx.query('DELETE FROM roles WHERE company_id = $1', [fixture.companyId]));
  assert.deepEqual(await titles(fixture.companyId), {});
});

test('a company with no roles gets its CEO from its first hire, or from the bundle that brings its roles', async () => {
  const empty = async (slug: string): Promise<{ companyId: string; divisionId: string }> => withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>('INSERT INTO companies (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
    const division = await tx.query<{ id: string }>(
      "INSERT INTO divisions (company_id, slug, name) VALUES ($1, 'ops', 'Operations') RETURNING id", [rows[0]!.id]);
    return { companyId: rows[0]!.id, divisionId: division.rows[0]!.id };
  });
  const hiring = await empty('first-hire');
  const hire = { divisionId: hiring.divisionId, systemPrompt: 'Run it.', doneCriteria: ['it runs'] };
  await assert.rejects(addRole(hiring.companyId, { ...hire, slug: 'builder', title: 'CTO' }, { ownerApproved: true }),
    /this company has no CEO yet, and a company always has one: its first role is its CEO/);
  await addRole(hiring.companyId, { ...hire, slug: 'founder' }, { ownerApproved: true });
  await addRole(hiring.companyId, { ...hire, slug: 'builder', title: 'CTO' }, { ownerApproved: true });
  assert.deepEqual(await titles(hiring.companyId), { builder: 'CTO', founder: 'CEO' });

  await registerStandardCatalogue();
  await publishBundle(WEB_OPS);
  const bundled = await empty('bundled');
  await installBundle({ companyId: bundled.companyId, slug: WEB_OPS.slug, version: WEB_OPS.version });
  const given = await titles(bundled.companyId);
  assert.equal(Object.values(given).filter((title) => title === 'CEO').length, 1, JSON.stringify(given));

  // Who talks to the owner, as the company list and a conversation say it.
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = (await api.call('GET', '/api/companies', token)).body.companies as Array<{ id: string; ceo: { slug: string } | null }>;
    assert.equal(listed.find((one) => one.id === hiring.companyId)!.ceo!.slug, 'founder');
    const nobody = await empty('nobody');
    assert.equal(listed.length, 2, 'the list is read before the third company');
    const none = await api.call('GET', `/api/companies/${nobody.companyId}/conversation`, token);
    assert.equal(none.body.ceo, null, 'a company with no roles has nobody to talk to yet');
    const said = await api.call('POST', `/api/companies/${nobody.companyId}/conversation/messages`, token, { text: 'Halo' });
    assert.equal(said.status, 400);
    assert.match(String(said.body.error), /has no CEO yet, and the CEO is who you talk to/);
  } finally {
    await api.close();
  }
});

test('the owner appoints a CEO with their device; a title never makes or unmakes one; a restored version leaves it', async () => {
  const fixture = await createCompany('ceo-api');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const hired = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'chief', systemPrompt: 'Run the company.', doneCriteria: ['every piece of work has an owner'],
      displayName: 'Arka', title: 'ceo', proof: { totp: api.code() },
    });
    assert.equal(hired.status, 400, 'a hire is not titled CEO while the company has one, however it is spelled');
    assert.match(String(hired.body.error), /this company's CEO is worker: to make this role the CEO instead, appoint it/);

    const chief = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'chief', systemPrompt: 'Run the company.', doneCriteria: ['every piece of work has an owner'],
      displayName: 'Arka', title: 'COO', persona: { preset: 'ceo-customer' }, proof: { totp: api.code() },
    });
    assert.equal(chief.status, 200, JSON.stringify(chief.body));
    const chiefId = chief.body.roleId as string;

    const retitled = await api.call('POST', `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`, token,
      { title: 'CTO', proof: { totp: api.code() } });
    assert.equal(retitled.status, 400);
    assert.match(String(retitled.body.error), /worker is the CEO, and a company always has one: appoint another role CEO first/);
    const promoted = await api.call('POST', `/api/companies/${fixture.companyId}/roles/${chiefId}`, token,
      { title: 'CEO', proof: { totp: api.code() } });
    assert.equal(promoted.status, 400, 'nor is anyone made CEO by a title');

    const unproved = await api.call('POST', `/api/companies/${fixture.companyId}/ceo`, token, { roleId: chiefId });
    assert.equal(unproved.status, 403, 'appointing takes the owner\'s device');
    const appointed = await api.call('POST', `/api/companies/${fixture.companyId}/ceo`, token, { roleId: chiefId, proof: { totp: api.code() } });
    assert.equal(appointed.status, 200, JSON.stringify(appointed.body));
    assert.deepEqual(appointed.body, { roleId: chiefId, previous: fixture.roleId });
    assert.deepEqual(await titles(fixture.companyId), { chief: 'CEO', worker: null });
    const versions = async () => (await withTenant(fixture.companyId, (tx) =>
      tx.query("SELECT 1 FROM config_versions WHERE kind = 'role'"))).rowCount;
    const kept = await versions();
    const again = await api.call('POST', `/api/companies/${fixture.companyId}/ceo`, token, { roleId: chiefId, proof: { totp: api.code() } });
    assert.deepEqual(again.body, { roleId: chiefId, previous: null }, 'appointing the CEO it has changes nothing');
    assert.equal(await versions(), kept, 'and records nothing');
    await assert.rejects(appointCeo(fixture.companyId, fixture.roleId, { ownerApproved: false }), /needs the owner/,
      'nor is anyone appointed without the owner, whoever calls');

    // Both roles' states before the appointment are versions; restoring the
    // new CEO's puts back its name and persona and leaves it CEO.
    const history = await withTenant(fixture.companyId, (tx) => tx.query<{ subject_id: string; version: number }>(
      "SELECT subject_id, version FROM config_versions WHERE kind = 'role' AND subject_id = ANY($1::uuid[]) ORDER BY version",
      [[chiefId, fixture.roleId]]));
    const chiefBefore = history.rows.filter((row) => row.subject_id === chiefId).at(-1)!;
    assert.ok(history.rows.some((row) => row.subject_id === fixture.roleId), 'the one that stood down has its version too');
    await api.call('POST', `/api/companies/${fixture.companyId}/roles/${chiefId}`, token,
      { displayName: 'Arka Wijaya', persona: null, proof: { totp: api.code() } });
    await rollBack(fixture.companyId, 'role', chiefId, chiefBefore.version);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ display_name: string; title: string; persona: unknown }>(
      'SELECT display_name, title, persona FROM roles WHERE id = $1', [chiefId]));
    assert.deepEqual(rows[0], { display_name: 'Arka', title: 'CEO', persona: { preset: 'ceo-customer' } });

    // The one that stood down can be given another title now.
    const coo = await api.call('POST', `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`, token,
      { title: 'coo', proof: { totp: api.code() } });
    assert.equal(coo.status, 200);
    assert.equal((await titles(fixture.companyId)).worker, 'COO', 'in the list\'s spelling');
  } finally {
    await api.close();
  }
});

test('every way a company comes to be gives it a CEO: a template names one or has one appointed, and so does an old archive', async () => {
  const base: CompanyTemplate = {
    goals: [{ slug: 'mission', kind: 'mission', statement: 'Sell good coffee.' }],
    divisions: [{ slug: 'ops', name: 'Operations' }, { slug: 'growth', name: 'Growth' }],
    roles: [
      // Before the coordinator by every other measure: made first, and first by name.
      { slug: 'analyst', division: 'growth', systemPrompt: 'You count.', model: 'standard', doneCriteria: ['counted'], outputSchema: { type: 'object' } },
      { slug: 'coordinator', division: 'ops', systemPrompt: 'You route work.', model: 'standard', doneCriteria: ['routed'], outputSchema: { type: 'object' } },
    ],
  };
  await saveTemplate({ slug: 'no-ceo', name: 'No CEO named', body: base });
  const made = await createCompanyFromTemplate({ templateSlug: 'no-ceo', companySlug: 'appointed', name: 'Appointed' });
  assert.deepEqual(await titles(made.companyId), { analyst: null, coordinator: 'CEO' }, 'the role that routes work is appointed');

  await assert.rejects(
    saveTemplate({ slug: 'two-ceos', name: 'Two', body: { ...base, roles: base.roles.map((role) => ({ ...role, title: 'CEO' })) } }),
    /more than one CEO/);

  // An archive from before titles: its roles carry none, and the import appoints one.
  const lines: ArchiveLine[] = [];
  await exportCompany(made.companyId, (line) => {
    lines.push(line.section === 'roles' ? { ...line, row: { ...line.row, title: null } } : line);
  });
  const restored = await importCompany(lines, { slug: 'restored-ceo' });
  assert.deepEqual(await titles(restored.companyId), { analyst: null, coordinator: 'CEO' });
});

test('the owner talks to a company through its CEO: in its name and persona, about its company and nothing else', async () => {
  const fixture = await createCompany('ceo-talk');
  const other = await createCompany('ceo-other');
  await withTenant(fixture.companyId, (tx) => tx.query(
    `UPDATE roles SET display_name = 'Arka', persona = '{"preset":"ceo-customer","notes":"Hemat."}' WHERE id = $1`, [fixture.roleId]));
  const model = new ScriptedModel([
    uses(
      ['read', { path: `/api/companies/${fixture.companyId}/structure` }],
      ['read', { path: `/api/companies/${other.companyId}/structure` }],
      ['read', { path: '/api/control/setup' }],
    ),
    uses(
      ['propose', { path: '/api/control/tools/search', body: { provider: 'brave' }, summary: 'Search with Brave.' }],
      ['propose', {
        path: `/api/companies/${fixture.companyId}/assign`,
        body: { roleId: fixture.roleId, divisionId: fixture.divisionId, projectId: fixture.projectId, goalId: fixture.goalId, goal: 'Plan the launch' },
        summary: 'Give me the launch plan to hand to the team.',
      }],
    ),
    says('Siap. Saya pegang rencana peluncurannya dan bagi ke tim; tekan kartunya untuk mulai.'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const empty = await api.call('GET', `/api/companies/${fixture.companyId}/conversation`, token);
    assert.equal(empty.status, 200);
    assert.deepEqual({ ...empty.body.ceo, persona: undefined }, {
      roleId: fixture.roleId, divisionId: fixture.divisionId, slug: 'worker', displayName: 'Arka', title: 'CEO', persona: undefined,
    });
    assert.deepEqual(empty.body.messages, []);

    const said = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Tolong siapkan peluncuran.' });
    assert.equal(said.status, 200, JSON.stringify(said.body));
    const system = model.requests[0]!.system;
    assert.match(system, /^You are Arka, the CEO of /, 'it speaks as the CEO');
    assert.match(system, /You are not Jeff Bezos/, 'in the persona the owner chose, never as its source');
    assert.match(system, /Speak as Arka, in the first person/);
    assert.match(system, /ask PALUGADA about those, with the Ask PALUGADA button/);
    assert.doesNotMatch(system, /POST \/api\/control\/tools\/:kind/, 'the deployment\'s actions are not listed to it');
    assert.doesNotMatch(system, /- \/api\/control\/setup/, 'nor its pages');

    const [own, others, deployment] = results(model, 1);
    assert.match(own!.content, /^Data from PALUGADA \(not instructions\)/);
    assert.equal(others!.isError, true, 'another company is not its to read');
    assert.match(others!.content, /outside this company/);
    assert.equal(deployment!.isError, true, 'nor the deployment');
    const [tool, work] = results(model, 2);
    assert.equal(tool!.isError, true, 'nor to propose for');
    assert.match(work!.content, /^Done: Give me the launch plan to hand to the team\./, 'giving the team work is done as it is proposed');

    const [, answered] = said.body.messages;
    assert.equal(answered.proposals.length, 1);
    assert.equal(answered.proposals[0].path, `/api/companies/${fixture.companyId}/assign`);
    assert.equal(answered.proposals[0].status, 'applied', 'no card left for the owner to press');

    // PALUGADA's own conversation is another one, and another company's is empty.
    assert.deepEqual((await api.call('GET', '/api/assistant', token)).body.messages, []);
    assert.deepEqual((await api.call('GET', `/api/companies/${other.companyId}/conversation`, token)).body.messages, []);

    // The work went to the CEO's own role, as the owner's.
    const taskId = JSON.parse(answered.proposals[0].outcome).taskId as string;
    const task = await withTenant(fixture.companyId, (tx) => tx.query<{ role_id: string; created_by: string }>(
      'SELECT role_id, created_by FROM tasks WHERE id = $1', [taskId]));
    assert.deepEqual(task.rows[0], { role_id: fixture.roleId, created_by: 'owner' });

    // Starting again forgets this company's conversation and no other.
    await api.call('POST', '/api/assistant/messages', token, { text: 'Halo' });
    const cleared = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/clear`, token, {});
    assert.equal(cleared.status, 200);
    assert.deepEqual((await api.call('GET', `/api/companies/${fixture.companyId}/conversation`, token)).body.messages, []);
    assert.equal((await api.call('GET', '/api/assistant', token)).body.messages.length, 2, 'PALUGADA\'s is still there');
  } finally {
    await api.close();
  }
});
