/**
 * Every model call is counted (N8, the live run of 2 October).
 *
 * Three conversations with a company's CEO, one of them thirty-nine seconds
 * of several turns, left no row in `llm_traces`, and neither did a night of
 * memory distillation: the engine traced the calls of tasks, and these are
 * not tasks. Every figure the owner relies on -- the month's ceiling, the
 * daily cost alert, the digest, the Money page -- sums `llm_traces`, so all
 * of them were short by whatever the owner's own conversations and the
 * company's learning cost.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { RecordingLlmClient, type LlmTurn, type LlmTurnRequest, type ToolUsingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { distillEpisodicToSemantic, distillSemanticToProcedural } from '../../src/memory/distillation.ts';
import { periodBounds, spendBetween } from '../../src/governance/spend-guard.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Line = Pick<LlmTurn, 'content' | 'stopReason'> | Error;

/** A model the test writes the lines of; each turn costs 2.5 cents. */
class PricedModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  readonly #script: Line[];

  constructor(script: Line[]) {
    this.#script = script;
  }

  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    const line = this.#script[this.requests.length - 1];
    if (!line) throw new Error(`the script has no line ${this.requests.length}`);
    if (line instanceof Error) throw line;
    return { ...line, inputTokens: 1_000, outputTokens: 200, costCents: 2.5, model: 'priced-1' };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

const says = (text: string): Line => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const reads = (path: string): Line => ({ content: [{ type: 'tool_use', id: `read-${path}`, name: 'read', input: { path } }], stopReason: 'tool_use' });

async function traces(companyId: string) {
  return (await withTenant(companyId, (tx) => tx.query<{
    task_id: string | null; kind: string; model: string; input_tokens: number; output_tokens: number; cost_cents: number;
  }>('SELECT task_id, kind, model, input_tokens, output_tokens, cost_cents FROM llm_traces ORDER BY occurred_at'))).rows;
}

test('the owner\'s conversation with a CEO is counted in its company\'s money, each turn as it is made (N8)', async () => {
  const fixture = await createCompany('metered-ceo');
  const other = await createCompany('metered-other');
  const model = new PricedModel([
    reads(`/api/companies/${fixture.companyId}/structure`),
    says('Semua berjalan baik.'),
    // The second question: one turn answered, and the next never comes.
    reads(`/api/companies/${fixture.companyId}/structure`),
    new Error('the provider closed the connection'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const asked = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Bagaimana minggu ini?' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));

    // Two turns, each a call of its own: outside any task, at what the model
    // charged -- 2.5 cents each, so two cents and then three: the half is
    // carried to the next call rather than rounded up twice.
    const two = await traces(fixture.companyId);
    assert.deepEqual(two.map((row) => [row.task_id, row.kind, row.model, row.input_tokens, row.output_tokens, row.cost_cents]), [
      [null, 'call', 'priced-1', 1_000, 200, 2],
      [null, 'call', 'priced-1', 1_000, 200, 3],
    ]);
    assert.deepEqual(await traces(other.companyId), [], 'another company pays for nothing');

    // An answer that failed half way still spent what it spent.
    const failed = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Dan bulan depan?' });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal((await traces(fixture.companyId)).length, 3);

    // The month's ceiling reads it: what the guard sums is what was spent.
    const { start, end } = periodBounds(new Date());
    // Seven cents of the seven and a half spent: the half is owed, and goes with the next call.
    assert.equal(await withTenant(fixture.companyId, (tx) => spendBetween(tx, start, end)), 7);
    const timeline = await api.call('GET', `/api/companies/${fixture.companyId}/cost?by=month`, token);
    assert.equal(timeline.body.timeline.reduce((sum: number, period: { costCents: number }) => sum + period.costCents, 0), 7);
  } finally {
    await api.close();
  }
});

test('PALUGADA\'s own assistant belongs to no company, and what it costs is shown beside the companies\' (N8)', async () => {
  const fixture = await createCompany('metered-deployment');
  const model = new PricedModel([reads('/api/control/setup'), says('Everything is set up.'), says('Baik.')]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    assert.equal((await api.call('POST', '/api/assistant/messages', token, { text: 'Is anything missing?' })).status, 200);
    assert.deepEqual(await traces(fixture.companyId), [], 'no company is charged for it');

    const cost = await api.call('GET', '/api/control/cost', token);
    assert.equal(cost.status, 200, JSON.stringify(cost.body));
    // Two turns of 2.5 cents: five, not six.
    assert.deepEqual(cost.body.assistant, { costCents: 5, tokens: 2_400 });

    // A CEO's conversation is its company's, not the deployment's.
    await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Halo' });
    const after = await api.call('GET', '/api/control/cost', token);
    assert.deepEqual(after.body.assistant, { costCents: 5, tokens: 2_400 });
    const companies = after.body.companies as Array<{ companyId: string; costCents: number }>;
    assert.equal(companies.find((row) => row.companyId === fixture.companyId)?.costCents, 2, 'one turn of 2.5: two now, and the half owed');
  } finally {
    await api.close();
  }
});

async function history(fixture: Fixture, notes: string[]) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'work that happened' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await withTenant(fixture.companyId, async (tx) => {
    for (const note of notes) {
      await appendEvent(tx, {
        companyId: fixture.companyId, projectId: fixture.projectId, taskId: task.id,
        type: 'task.completed', actor: 'agent_run', payload: { note },
      });
      await appendEvent(tx, {
        companyId: fixture.companyId, projectId: fixture.projectId, taskId: task.id,
        type: 'tool.called', actor: 'agent_run', payload: { capability: 'crm.note' },
      });
    }
  });
}

test('what a company\'s memory costs to distil is counted in its money (N8)', async () => {
  const fixture = await createCompany('metered-memory');
  await history(fixture, ['the roaster ships on Tuesdays']);
  const facts = new RecordingLlmClient(() => JSON.stringify({ facts: [{ body: 'The roaster ships on Tuesdays.', confidence: 0.9 }] }));
  const distilled = await distillEpisodicToSemantic({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, llm: facts, model: 'test-model',
  });
  assert.equal(distilled.factsCreated, 1);
  assert.deepEqual((await traces(fixture.companyId)).map((row) => [row.task_id, row.kind, row.model, row.input_tokens, row.output_tokens, row.cost_cents]),
    [[null, 'call', 'test-model', 100, 50, 1]], 'at the model it asked for, when the client does not say which answered');

  // The procedure written from it is a call too, when one is written.
  const sop = new RecordingLlmClient(() => 'Noting a customer\n1. Read the record.\n2. Write the note.');
  const written = await distillSemanticToProcedural({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, llm: sop, model: 'test-model', minOccurrences: 1,
  });
  assert.equal(sop.callCount, written.length);
  assert.equal((await traces(fixture.companyId)).length, 1 + sop.callCount);
});

test('a company whose month\'s money is spent does not go on spending it on learning (N8)', async () => {
  const { Worker } = await import('../../src/worker.ts');
  const { Engine } = await import('../../src/engine/engine.ts');
  const { CapabilityBroker } = await import('../../src/broker/broker.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const fixture = await createCompany('metered-paused');
  await history(fixture, ['the roaster ships on Tuesdays']);
  await withControlPlane((tx) => tx.query(
    `INSERT INTO spend_limits (company_id, money_max_cents, paused_at, pause_reason) VALUES ($1, 100, now(), 'ceiling')
     ON CONFLICT (company_id) DO UPDATE SET paused_at = now(), pause_reason = 'ceiling'`, [fixture.companyId]));
  const llm = new RecordingLlmClient(() => JSON.stringify({ facts: [{ body: 'A fact.', confidence: 0.9 }] }));
  const worker = new Worker({
    engine: new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), llm: new RecordingLlmClient(), handlers: new Map() }),
    companyId: fixture.companyId,
    learning: { llm, model: 'test-model', intervalMs: 0 },
  });
  const report = await worker.tick();
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.equal(llm.callCount, 0, 'paused, it reads nothing');
  assert.deepEqual(await traces(fixture.companyId), []);

  // Resumed, it learns again.
  await withControlPlane((tx) => tx.query('UPDATE spend_limits SET paused_at = NULL, pause_reason = NULL WHERE company_id = $1', [fixture.companyId]));
  await worker.tick();
  assert.ok(llm.callCount > 0);
});
