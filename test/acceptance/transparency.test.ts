/**
 * What the owner can see of how a piece of work was done (F11.2, 0073).
 *
 * Read against what an owner would expect of "show me what it did": the
 * Work page reached a task's events and its narration, and not the steps
 * behind them; the journal kept a step's output and only a hash of what it
 * was asked, so a trace showed that a message was sent and not to whom; and
 * where content from outside came into the work was in the log and in no
 * trace. These hold the other side of each.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { Engine } from '../../src/engine/engine.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { STEP_INPUT_LIMIT } from '../../src/engine/journal.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const inbox: Capability<{ folder: string }, { messages: string[] }> = {
  name: 'mailbox.read',
  adapter: 'test:mail',
  defaultTier: 0,
  estimatedCostCents: 0,
  readsOutside: true,
  async execute() {
    return { messages: ['Hi, can we get your wholesale price list? -- Seduh Pagi'] };
  },
};

const notes: Capability<{ text: string }, { kept: number }> = {
  name: 'notes.keep',
  adapter: 'test:notes',
  defaultTier: 0,
  estimatedCostCents: 0,
  async execute(input) {
    return { kept: input.text.length };
  },
};

test('a task\'s trace shows each step with what it was asked, what it returned, and where outside content came in', async () => {
  const fixture = await createCompany('trace-task');
  const registry = new CapabilityRegistry();
  registry.register(inbox as unknown as Capability<never, never>);
  registry.register(notes as unknown as Capability<never, never>);
  await registry.sync();
  await grantCapability(fixture, 'mailbox.read');
  await grantCapability(fixture, 'notes.keep');
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability('mailbox.read', { folder: 'wholesale' });
      await ctx.callCapability('notes.keep', { text: 'x'.repeat(STEP_INPUT_LIMIT + 500) });
      return { summary: 'read the wholesale mail' };
    }]]),
  });
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'answer the wholesale mail' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const answer = await api.call('GET', `/api/companies/${fixture.companyId}/tasks/${task.id}/trace`, token);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const trace = answer.body;
    assert.deepEqual(trace.outside, ['mailbox.read'], 'where content from outside came into the work');
    const steps = trace.runs[0].steps as Array<{ kind: string; name: string; detail: Record<string, unknown> }>;
    const read = steps.find((step) => step.name === 'capability:mailbox.read')!;
    assert.deepEqual(read.detail.input, { name: 'mailbox.read', input: { folder: 'wholesale' } }, 'what it was asked');
    assert.deepEqual((read.detail.output as { messages: string[] }).messages.length, 1, 'and what it returned');
    const called = steps.find((step) => step.kind === 'tool_call' && step.detail.capability === 'mailbox.read');
    assert.ok(called, 'the call itself, by capability, with its tier');
    assert.equal(called!.detail.tier, 0);
    assert.ok(steps.some((step) => step.name === 'content.read_outside'));
    const kept = steps.find((step) => step.name === 'capability:notes.keep')!;
    assert.equal((kept.detail.input as { cut: boolean }).cut, true, 'a large input is kept bounded, and says so');

    const missing = await api.call('GET', `/api/companies/${fixture.companyId}/tasks/11111111-1111-1111-1111-111111111111/trace`, token);
    assert.equal(missing.status, 400);
  } finally {
    await api.close();
  }
});
