/**
 * The company's documents (0075; src/knowledge/documents.ts).
 *
 * Read against what an owner would expect of "the company knows our price
 * list": memory held facts of a sentence or two, so a price list, a contract
 * or a brand guide had nowhere to go, and no run could look anything up in
 * one. These hold that a document is kept whole, found by passage through
 * the search every role already has, scoped like memory, shown to runs as
 * data, and taken back without being lost.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { addDocument, passagesOf } from '../../src/knowledge/documents.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const TERMS = `# Wholesale terms

These terms apply to every cafe that buys beans by the kilo.

## Payment

Invoices are paid within 14 days. A cafe that pays within 7 days gets 2 percent off.

## Delivery

Orders of 10 kg or more are delivered free in Bandung and Jakarta. Smaller orders pay Rp 25.000 per delivery.

RETURNS

Unopened bags come back within 30 days for a full refund.`;

let searches = 0;
async function search(fixture: Fixture, registry: CapabilityRegistry, query: string, divisionId = fixture.divisionId, roleId = fixture.roleId) {
  searches += 1;
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId, roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: `look up ${query} (${searches})` },
    createdBy: 'owner', reserveTokens: 500,
  });
  await transition(fixture.companyId, task.id, 'running');
  return (await new CapabilityBroker(registry).invoke<unknown, {
    documents: Array<{ title: string; heading: string | null; passage: string }>;
  }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId, roleId,
    taskId: task.id, idempotencyKey: `search-${searches}`,
  }, 'memory.search', { query })).output.documents;
}

test('a document is split into passages under the headings they sit beneath', () => {
  const passages = passagesOf(TERMS);
  assert.deepEqual(passages.map((one) => one.heading), ['Wholesale terms', 'Payment', 'Delivery', 'RETURNS']);
  assert.match(passages[1]!.body, /paid within 14 days/);
  const long = passagesOf(`# Notes\n\n${'A sentence that goes on. '.repeat(400)}`);
  assert.ok(long.length > 1 && long.every((one) => one.body.length <= 3_500 && one.heading === 'Notes'), 'a long paragraph is cut at sentence ends');
});

test('the owner gives the company a document, and a run finds the passage it needs with the search it already has', async () => {
  const fixture = await createCompany('documents-flow');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'memory.search');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const base = `/api/companies/${fixture.companyId}/documents`;
    const added = await api.call('POST', base, token, { title: 'Wholesale terms', text: TERMS, fileName: 'terms.md' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.passages, 4);
    const listed = (await api.call('GET', base, token)).body.documents;
    assert.deepEqual([listed[0].title, listed[0].fileName, listed[0].passages], ['Wholesale terms', 'terms.md', 4]);
    assert.match((await api.call('GET', `${base}/${added.body.documentId}`, token)).body.body, /Unopened bags/);

    const found = await search(fixture, registry, 'how many days to pay an invoice');
    assert.equal(found[0]!.heading, 'Payment', 'the passage the words point at, first');
    assert.match(found[0]!.passage, /^<<<UNTRUSTED_CONTENT>>> source="document:Wholesale terms"/, 'as data, never instructions');
    assert.match(found[0]!.passage, /paid within 14 days/);
    assert.equal((await search(fixture, registry, 'free delivery Bandung'))[0]!.heading, 'Delivery');

    // A run is told the document exists.
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'quote a cafe' }, createdBy: 'owner', reserveTokens: 500,
    });
    const pack = await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
    assert.match(pack.sections.find((section) => section.kind === 'documents')!.body, /"Wholesale terms"/);

    // Archived, it leaves every search and stays readable to the owner.
    assert.equal((await api.call('POST', `${base}/${added.body.documentId}/archive`, token, { archived: true })).status, 200);
    assert.deepEqual(await search(fixture, registry, 'invoice paid days'), []);
    assert.equal((await api.call('GET', `${base}/${added.body.documentId}`, token)).status, 200);
    assert.equal((await api.call('POST', `${base}/${added.body.documentId}/archive`, token, { archived: false })).status, 200);

    const empty = await api.call('POST', base, token, { title: 'Nothing', text: '   ' });
    assert.equal(empty.status, 400);
    await assert.rejects(() => addDocument(fixture.companyId, { title: 'Nothing', body: ' \n\n ' }), /needs its text/,
      'whoever calls it, a document without text is refused by name');
  } finally {
    await api.close();
  }
});

test('a division\'s document is its own; the company\'s are everyone\'s; a restored company keeps them', async () => {
  const fixture = await createCompany('documents-scope');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'memory.search');
  const other = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO divisions (company_id, slug, name) VALUES ($1, 'finance', 'Finance') RETURNING id", [fixture.companyId]);
    await tx.query("INSERT INTO capability_grants (company_id, division_id, capability_name) VALUES ($1, $2, 'memory.search')",
      [fixture.companyId, rows[0]!.id]);
    const { rows: role } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, input_schema, output_schema, done_criteria)
       VALUES ($1, $2, 'bookkeeper', 'You keep the books.', 'test-model', '{}', '{"type":"object"}', ARRAY['the books balance'])
       RETURNING id`, [fixture.companyId, rows[0]!.id]);
    return { id: rows[0]!.id, role: role[0]!.id };
  });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const base = `/api/companies/${fixture.companyId}/documents`;
    await api.call('POST', base, token, { title: 'Bank details', text: 'Salaries are paid from account 123 at the cooperative bank.', divisionId: other.id });
    await api.call('POST', base, token, { title: 'Wholesale terms', text: TERMS });
  } finally {
    await api.close();
  }
  assert.deepEqual(await search(fixture, registry, 'salaries account bank'), [], 'another division\'s document is not this one\'s');
  assert.equal((await search(fixture, registry, 'salaries account bank', other.id, other.role))[0]!.title, 'Bank details');
  assert.equal((await search(fixture, registry, 'unopened bags refund', other.id, other.role))[0]!.title, 'Wholesale terms', 'the company\'s are everyone\'s');

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ title: string; passages: number; matched: boolean }>(
    `SELECT d.title, (SELECT count(*)::int FROM document_passages p WHERE p.document_id = d.id) AS passages,
            EXISTS (SELECT 1 FROM document_passages p WHERE p.document_id = d.id AND p.words @@ to_tsquery('simple', 'invoices')) AS matched
       FROM documents d ORDER BY d.title`));
  assert.deepEqual(rows, [
    { title: 'Bank details', passages: 1, matched: false },
    { title: 'Wholesale terms', passages: 4, matched: true },
  ], 'whole, in passages, and searchable again');
});
