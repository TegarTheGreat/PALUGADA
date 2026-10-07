/**
 * A person is an actor (the audit of 6 October, §8.2, P1.1; STATUS 2.173):
 * the fourth step, a role that is a person.
 *
 * A company run by agents still needs people for what an agent cannot do: a
 * warehouse count, a signature, a phone call, a photo of a delivery. The
 * platform could ask the owner and, since the first step, a named person, but
 * the work itself could only be given to an agent. A role can now be a person
 * -- a contractor the company employs through a staff seat. The work given to
 * it is put to that person as a question; the task waits as it waits for any
 * answer; and what the person answers, files included, is what the role
 * produced.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { Engine } from '../../src/engine/engine.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { PersonAdapter } from '../../src/runtime/person.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

function app(secret: string) {
  let step = stepFor(new Date()) - 1;
  return () => {
    step += 1;
    return totpCode(decodeBase32(secret), Math.min(step, stepFor(new Date()) + 1));
  };
}

async function seat(api: Console, owner: string, fixture: Fixture, name: string, kind: 'viewer' | 'approver' = 'approver') {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const invite = String(made.body.invite);
  const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
  const code = app(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.body.offer, totp: code() });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { seatId: String(made.body.seatId), token: String(joined.body.token) };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

const engineFor = () => {
  const adapters = new AdapterRegistry();
  adapters.register(new PersonAdapter());
  return new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), adapters, workerId: 'person-worker' });
};

const bind = (fixture: Fixture, seatId: string | null, name: string) => withTenant(fixture.companyId, (tx) => tx.query(
  "UPDATE roles SET runtime = 'person', backend = 'local', person_seat = $2, person_name = $3 WHERE id = $1", [fixture.roleId, seatId, name]));

const givenTo = (fixture: Fixture, input: Record<string, unknown>) => createRootTask({
  companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
  budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input, createdBy: 'owner', reserveTokens: 1_000,
});

test('work given to a role that is a person is put to them, and what they answer is what the role produced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palugada-person-'));
  const fixture = await createCompany('person-adapter');
  const api = await consoleWithSettings({ files: { root } });
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi');
    const siti = await seat(api, owner, fixture, 'Siti');
    await bind(fixture, budi.seatId, 'Budi');
    const task = await givenTo(fixture, { goal: 'Hitung stok gula di gudang B dan kirim fotonya', context: 'Gudang B, rak kiri.' });
    const engine = engineFor();

    // The task waits for the person, as it waits for any answer.
    const first = await engine.runTask(fixture.companyId, task.id, 'worker');
    assert.equal(first.status, 'waiting_approval', first.reason);
    type Card = { id: string; question: string | null; rationale: string; addressee?: { name: string } };
    const cards = async (token: string) => (await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, token)).body.items as Card[];
    const [mine] = await cards(budi.token);
    assert.equal(mine?.question, 'Hitung stok gula di gudang B dan kirim fotonya', 'the brief is the question, in the words it was given');
    assert.match(mine!.rationale, /Gudang B, rak kiri\./, 'and what it depends on is the context');
    assert.equal(mine!.addressee?.name, 'Budi');
    assert.deepEqual(await cards(siti.token), [], 'no one else is asked');
    // Asked again, as a resumed task would, it is the same question and not a second one.
    assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'waiting_approval');
    assert.equal((await cards(budi.token)).length, 1);

    // Budi answers, with the photo.
    const sent = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${mine!.id}/answer`, budi.token, {
      answer: 'Stok gula 40 karung.', files: [{ name: 'gudang-b.pdf', data: PDF.toString('base64') }],
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const second = await engine.runTask(fixture.companyId, task.id, 'worker');
    assert.equal(second.status, 'completed', second.reason);
    const done = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
    const output = done!.output as { summary: string; answeredBy: string; files: Array<{ path: string; kind: string }> };
    assert.equal(output.summary, 'Stok gula 40 karung.');
    assert.equal(output.answeredBy, 'Budi');
    assert.equal(output.files.length, 1);
    assert.match(output.files[0]!.path, /^received\/answers\/\d{4}-\d{2}\/[0-9a-f]{8}-1\.pdf$/);
    assert.equal(output.files[0]!.kind, 'pdf');
  } finally {
    await api.close();
  }
});

test('a person who is no longer seated is not replaced by a model: the work is refused, saying whom to seat', async () => {
  const fixture = await createCompany('person-gone');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi');
    await bind(fixture, budi.seatId, 'Budi');
    await api.call('POST', `/api/companies/${fixture.companyId}/staff/${budi.seatId}/revoke`, owner, {});
    const said = (taskId: string) => withTenant(fixture.companyId, (tx) => tx.query<{ payload: { detail?: string } }>(
      "SELECT payload FROM events WHERE task_id = $1 AND type = 'task.halted'", [taskId])).then((result) => result.rows.map((row) => row.payload.detail));

    // Halted, not retried and not given to a model, and the halt says why.
    const task = await givenTo(fixture, { goal: 'Hitung stok gula' });
    const outcome = await engineFor().runTask(fixture.companyId, task.id, 'worker');
    assert.equal(outcome.status, 'halted');
    assert.match(String((await said(task.id))[0]), /Budi is no longer seated, so there is no one to do this/);
    assert.deepEqual((await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, owner)).body.items.filter((item: { question: string | null }) => item.question), [],
      'nothing was asked of anyone');

    // A restored company has the name and no seat: the same refusal.
    await bind(fixture, null, 'Budi');
    const again = await givenTo(fixture, { goal: 'Hitung stok susu' });
    assert.equal((await engineFor().runTask(fixture.companyId, again.id, 'worker')).status, 'halted');
    assert.match(String((await said(again.id))[0]), /Budi is no longer seated/);
  } finally {
    await api.close();
  }
});

test('a coordinator is told which of the roles it can hand work to are people, because they answer slowly', async () => {
  const fixture = await createCompany('person-team');
  const { addRole } = await import('../../src/governance/structure.ts');
  const { buildContext } = await import('../../src/context/builder.ts');
  await addRole(fixture.companyId, {
    divisionId: fixture.divisionId, slug: 'gudang-budi', systemPrompt: 'Menghitung stok di gudang dan melapor.', doneCriteria: ['Jumlah stok dilaporkan'],
    person: { seatId: '0f6c0b2e-6a54-4f0e-9a43-8d5f1b7d2c11', name: 'Budi' },
  }, { ownerApproved: true });
  await addRole(fixture.companyId, {
    divisionId: fixture.divisionId, slug: 'analis', systemPrompt: 'Menganalisis angka.', doneCriteria: ['Ada angka'],
  }, { ownerApproved: true });
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET tools = ARRAY['task.delegate'] WHERE id = $1", [fixture.roleId]));
  const task = await givenTo(fixture, { goal: 'Siapkan laporan stok' });
  const context = await withTenant(fixture.companyId, (tx) => buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
  const team = context.sections.find((section) => section.kind === 'team');
  assert.ok(team, 'the coordinator is given its team');
  const lines = team.body.split('\n').filter((line) => line.startsWith('- '));
  assert.match(lines.find((line) => line.startsWith('- gudang-budi:'))!, /A person, Budi, not an agent/);
  assert.doesNotMatch(lines.find((line) => line.startsWith('- analis:'))!, /A person/);
});

test('every deployment can employ a person, and a deployment with nothing else still says it has no runtime', async () => {
  const { assembleRuntimes } = await import('../../src/runtime/assemble.ts');
  const bare = assembleRuntimes({ env: {} });
  assert.deepEqual(bare.adapters.names(), ['person']);
  assert.ok(bare.notes.some((note) => /no runtime is registered/.test(note)), 'a person does no work of its own: the deployment still has no runtime');
  const withAgents = assembleRuntimes({ env: { PALUGADA_CLAUDE_CODE_COMMAND: 'claude' } });
  assert.deepEqual(withAgents.adapters.names().sort(), ['claude-code', 'person']);
  assert.ok(withAgents.notes.some((note) => note.startsWith('runtimes:')));
  assert.equal(withAgents.notes.some((note) => /no runtime is registered/.test(note)), false);
});

test('hiring a person: a role bound to a seat by name, an approver who is seated, and no tools', async () => {
  const fixture = await createCompany('person-hire');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi');
    await seat(api, owner, fixture, 'Rina', 'viewer');
    const hire = (extra: Record<string, unknown>) => api.call('POST', `/api/companies/${fixture.companyId}/roles`, owner, {
      divisionId: fixture.divisionId, slug: 'gudang-budi', systemPrompt: 'Menghitung stok di gudang dan melapor.', doneCriteria: ['Jumlah stok dilaporkan'],
      proof: { totp: api.code() }, ...extra,
    });

    const unknown = await hire({ person: 'Joko' });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.match(String(unknown.body.error), /no one called Joko .*Budi/);
    const viewer = await hire({ person: 'Rina' });
    assert.equal(viewer.status, 400);
    assert.match(String(viewer.body.error), /Rina can only read/);
    const withTools = await hire({ person: 'Budi', tools: ['doc.draft'] });
    assert.equal(withTools.status, 400);
    assert.match(String(withTools.body.error), /a person has no tools/);

    const made = await hire({ person: 'budi' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ runtime: string; backend: string; person_seat: string; person_name: string; tools: string[] }>(
      'SELECT runtime, backend, person_seat, person_name, tools FROM roles WHERE id = $1', [made.body.roleId]));
    assert.deepEqual(rows[0], { runtime: 'person', backend: 'local', person_seat: budi.seatId, person_name: 'Budi', tools: [] });

    // The next hire that is not a person is not given a runtime that needs one, though persons are most of the company.
    assert.equal((await hire({ person: 'Budi', slug: 'gudang-lain' })).status, 200);
    const next = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, owner, {
      divisionId: fixture.divisionId, slug: 'analis', systemPrompt: 'Menganalisis angka.', doneCriteria: ['Ada angka'], proof: { totp: api.code() },
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const { rows: [analyst] } = await withTenant(fixture.companyId, (tx) => tx.query<{ runtime: string; person_name: string | null }>(
      'SELECT runtime, person_name FROM roles WHERE id = $1', [next.body.roleId]));
    assert.deepEqual(analyst, { runtime: 'in-process', person_name: null });

    // A company restored from its archive has the person's name and no seat, and is still a person's role.
    const { exportCompany } = await import('../../src/audit/export.ts');
    const { importCompany } = await import('../../src/audit/import.ts');
    const archive: Array<{ section: string; row: Record<string, unknown> }> = [];
    await exportCompany(fixture.companyId, (line) => { archive.push(line); });
    const restored = await importCompany(archive, { slug: 'person-hire-restored' });
    const { rows: copies } = await withTenant(restored.companyId, (tx) => tx.query<{ slug: string; runtime: string; person_seat: string | null; person_name: string | null }>(
      "SELECT slug, runtime, person_seat, person_name FROM roles WHERE slug = 'gudang-budi'"));
    assert.deepEqual(copies, [{ slug: 'gudang-budi', runtime: 'person', person_seat: null, person_name: 'Budi' }]);
  } finally {
    await api.close();
  }
});
