/**
 * Search across every company (Buzz's search, Paperclip's).
 *
 * The owner could search a company's decisions and its memory, one company
 * at a time, and nothing else: "where did we decide the price?" or "which
 * task wrote the wholesale email?" meant opening each company and scrolling.
 * These hold one search over the work, what it produced, the decisions and
 * what the companies know -- across every company, because the owner is one
 * person with many -- with the query taken literally and the answers capped.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { remember } from '../../src/memory/store.ts';
import { searchEverywhere } from '../../src/owner/search.ts';
import { memoriesOf } from '../../src/owner/views.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function finished(fixture: Fixture, goal: string, summary: string) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'completed', { output: { summary } });
  return task;
}

test('one search finds the work, its results, the decisions and what is known, in every company', async () => {
  const kopi = await createCompany('search-kopi');
  const lumen = await createCompany('search-lumen');
  const email = await finished(kopi, 'Email the wholesale buyers', 'Sent to 12 buyers about the 1 kg bags.');
  await finished(lumen, 'Price the studio hours', 'Settled on the wholesale rate for agencies.');
  await finished(kopi, 'Count the beans', 'Nothing about it.');
  const decision = await inbox.requestApproval({
    companyId: lumen.companyId, capabilityName: 'email.send', tier: 2,
    actionSummary: 'Send the wholesale price list', rationale: 'Asked by two agencies.', consequenceIfDenied: 'Not sent.',
  });
  const fact = await withTenant(kopi.companyId, (tx) => remember(tx, {
    companyId: kopi.companyId, memoryType: 'semantic', scopeType: 'company',
    body: 'Wholesale buyers pay within 30 days.', source: 'owner',
  }));

  const found = await searchEverywhere('wholesale');
  const byKind = (kind: string) => found.filter((hit) => hit.kind === kind);
  assert.deepEqual(byKind('task').map((hit) => hit.title).sort(), ['Email the wholesale buyers', 'Price the studio hours']);
  assert.equal(byKind('task').find((hit) => hit.id === email.id)!.company, kopi.slug);
  assert.deepEqual(byKind('decision').map((hit) => hit.id), [decision]);
  assert.deepEqual(byKind('memory').map((hit) => hit.id), [fact]);
  assert.ok(found.every((hit) => hit.companyId && hit.at), 'each says where it is and when');

  // Case does not matter; wildcards are taken literally; nonsense finds nothing.
  assert.equal((await searchEverywhere('WHOLESALE')).length, found.length);
  await finished(kopi, 'Discount 50% for the launch', 'Applied.');
  assert.deepEqual((await searchEverywhere('50%')).map((hit) => hit.title), ['Discount 50% for the launch']);
  assert.deepEqual(await searchEverywhere('__'), [], 'underscores are underscores');
  assert.deepEqual(await searchEverywhere('zzzz-nothing'), []);
  await assert.rejects(searchEverywhere('a'), /at least 2 characters/);
});

test('each kind is capped, newest first, and a replaced fact is not found', async () => {
  const fixture = await createCompany('search-cap');
  for (let n = 1; n <= 12; n += 1) await finished(fixture, `Invoice run ${n}`, 'done');
  const found = await searchEverywhere('invoice run');
  assert.equal(found.filter((hit) => hit.kind === 'task').length, 8);
  assert.equal(found[0]!.title, 'Invoice run 12');

  await withTenant(fixture.companyId, async (tx) => {
    const old = await remember(tx, { companyId: fixture.companyId, memoryType: 'semantic', scopeType: 'company', body: 'The roaster is in Bandung.' });
    const { supersede } = await import('../../src/memory/store.ts');
    await supersede(tx, old, { companyId: fixture.companyId, memoryType: 'semantic', scopeType: 'company', body: 'The roaster moved to Garut.' });
  });
  assert.deepEqual((await searchEverywhere('roaster')).map((hit) => hit.title), ['The roaster moved to Garut.']);
});

test("a company's memory page takes a search literally too", async () => {
  const fixture = await createCompany('search-memory-page');
  await withTenant(fixture.companyId, async (tx) => {
    await remember(tx, { companyId: fixture.companyId, memoryType: 'semantic', scopeType: 'company', body: 'Margins are 40% on retail.' });
    await remember(tx, { companyId: fixture.companyId, memoryType: 'semantic', scopeType: 'company', body: 'Delivery takes 4 days.' });
  });
  const page = await memoriesOf(fixture.companyId, { query: '40%' });
  assert.deepEqual(page.items.map((item) => item.body), ['Margins are 40% on retail.']);
  const sign = await memoriesOf(fixture.companyId, { query: '%' });
  assert.deepEqual(sign.items.map((item) => item.body), ['Margins are 40% on retail.'],
    'a lone % finds the facts with a per cent sign in them, not every fact');
});
