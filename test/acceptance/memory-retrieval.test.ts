/**
 * Finding what the company knows (F4.1, F4.5, F4.6, F4.8).
 *
 * The memory audit found retrieval by age alone. `memory.search` read the
 * eighty newest facts and kept those containing the whole query as written,
 * so a fact older than eighty others could not be found by any words, and
 * "refund approval" found nothing in "Refunds need the owner's approval". The
 * pack took the ten newest procedures, so the owner's own word on delivered
 * work aged out of every run behind ten distilled ones. These hold the
 * retrieval to what the task is about and to whose word it was.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { remember } from '../../src/memory/store.ts';
import { buildContext } from '../../src/context/builder.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function fact(fixture: Fixture, body: string, options: { daysAgo: number; type?: 'semantic' | 'procedural'; source?: string }) {
  await withTenant(fixture.companyId, (tx) => remember(tx, {
    companyId: fixture.companyId,
    memoryType: options.type ?? 'semantic',
    scopeType: 'division',
    scopeId: fixture.divisionId,
    body,
    source: options.source ?? 'distillation',
    validFrom: new Date(Date.now() - options.daysAgo * 86_400_000),
  }));
}

async function task(fixture: Fixture, goal: string) {
  const created = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal }, createdBy: 'owner', reserveTokens: 5_000,
  });
  await transition(fixture.companyId, created.id, 'running');
  return created;
}

test('memory.search finds a fact by its words however old it is, the closest match first', async () => {
  const fixture = await createCompany('memory-search');
  await fact(fixture, 'Refunds over Rp 500.000 need the owner\'s approval before they are paid.', { daysAgo: 400 });
  await fact(fixture, 'A refund is paid back to the card it came from.', { daysAgo: 300 });
  for (let n = 0; n < 100; n += 1) {
    await fact(fixture, `The weekly newsletter went out on schedule (issue ${n}).`, { daysAgo: 100 - n / 10 });
  }
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'memory.search');
  const running = await task(fixture, 'handle a refund request');
  const search = async (query: string) => (await new CapabilityBroker(registry).invoke<unknown, { facts: Array<{ body: string }> }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: running.id, idempotencyKey: `search-${query}`,
  }, 'memory.search', { query, limit: 3 })).output.facts.map((found) => found.body);

  const found = await search('refund approval');
  assert.match(found[0] ?? '', /need the owner's approval/, 'both words, first; behind a hundred newer facts');
  assert.ok(found.some((body) => /paid back to the card/.test(body)), 'one word is still a match, ranked after');
  assert.ok(!found.some((body) => /newsletter/.test(body)), 'and nothing that shares no word');
  assert.deepEqual(await search('REFUNDS'), await search('refunds'), 'case is not a different fact');
  assert.ok(!(await search('the refunds')).some((body) => /newsletter/.test(body)),
    'a word that says nothing about a fact does not make it a match');
  assert.deepEqual(await search('the and for'), [], 'nor does a query of nothing but such words');
});

test('a run is told the owner\'s word first, and the facts nearest its task', async () => {
  const fixture = await createCompany('memory-pack');
  // The owner's word on delivered work, then a dozen distilled procedures.
  await fact(fixture, 'Always copy the finance lead on anything over budget.', { daysAgo: 30, type: 'procedural', source: 'owner' });
  for (let n = 0; n < 12; n += 1) {
    await fact(fixture, `Distilled procedure ${n}: tag the ticket before closing it.`, { daysAgo: 20 - n, type: 'procedural' });
  }
  // One fact about the task, older than a dozen that are not.
  await fact(fixture, 'The Bandung warehouse ships coffee orders on Tuesdays and Fridays.', { daysAgo: 90 });
  for (let n = 0; n < 12; n += 1) {
    await fact(fixture, `The office plant was watered (${n}).`, { daysAgo: 10 - n / 2 });
  }
  const running = await task(fixture, 'Tell the customer when the Bandung warehouse ships their coffee');

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: running.id }));
  const sops = context.sections.filter((section) => section.kind === 'sop').map((section) => section.body);
  assert.equal(sops[0], 'Always copy the finance lead on anything over budget.', 'the owner\'s word leads, and is not crowded out');
  const facts = context.semanticMemories.map((memory) => memory.body);
  assert.equal(facts[0], 'The Bandung warehouse ships coffee orders on Tuesdays and Fridays.',
    'the fact about the task comes first, behind a dozen newer ones about nothing');
  assert.equal(facts.length, 10, 'and the rest of the room is filled as before');
});
