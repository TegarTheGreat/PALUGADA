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
import { wellFormed } from '../../src/text.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { criteriaIn, reportOn } from '../helpers/done.ts';
import { AdapterRegistry, type Adapter, type RunRequest } from '../../src/runtime/protocol.ts';
import { redactor } from '../../src/secrets/manager.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { scrubExpiredPrompts } from '../../src/retention/retention.ts';

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

test('a large input cut in the middle of an emoji is kept whole, not refused by the journal', async () => {
  // The cut is at a number of UTF-16 units; one that falls between the two halves of a character leaves half of it,
  // which a jsonb column refuses -- and the step, and with it the task, failed for the way its input was spelled.
  const fixture = await createCompany('trace-emoji-cut');
  const registry = new CapabilityRegistry();
  registry.register(notes as unknown as Capability<never, never>);
  await registry.sync();
  await grantCapability(fixture, 'notes.keep');
  const emoji = '\u{1F600}';
  const call = (pad: number) => JSON.stringify({ name: 'notes.keep', input: { text: 'x'.repeat(pad) + emoji.repeat(10) } });
  let pad = STEP_INPUT_LIMIT - 60;
  while (!/[\ud800-\udbff]/.test(call(pad)[STEP_INPUT_LIMIT - 1]!)) pad += 1;
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability('notes.keep', { text: 'x'.repeat(pad) + emoji.repeat(10) });
      return { summary: 'kept a note' };
    }]]),
  });
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'keep a note' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  const kept = await withTenant(fixture.companyId, (tx) => tx.query<{ input: { cut?: boolean; start?: string } }>(
    "SELECT input FROM task_steps WHERE task_id = $1 AND name = 'capability:notes.keep'", [task.id]));
  assert.equal(kept.rows[0]!.input.cut, true);
  assert.equal(wellFormed(kept.rows[0]!.input.start!), kept.rows[0]!.input.start);
});

test('what a run was told is kept for every runtime, redacted, and goes with the prompts when their time is up', async () => {
  const fixture = await createCompany('trace-briefing');
  // A key that reached a role's charter: the kind of thing that must never be kept in the clear.
  const key = ['briefing', 'key', String(Date.now())].join('-');
  redactor.register(key);
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET runtime = 'script', system_prompt = $2 WHERE id = $1",
    [fixture.roleId, `You answer wholesale enquiries. The supplier portal key is ${key}.`]));
  // A runtime out of this process, which keeps nothing of what it was handed.
  let handed: RunRequest | null = null;
  const script: Adapter = {
    name: 'script', backends: ['local'],
    async health() { return { ok: true }; },
    async run(request) {
      handed = request;
      const contract = request.contextPack.notes.find((note) => note.title === 'What you return')?.body ?? '';
      return { output: { summary: 'Answered Seduh Pagi.', done: reportOn(criteriaIn(contract)) } };
    },
  };
  const adapters = new AdapterRegistry();
  adapters.register(script);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'briefing-worker', adapters });
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'answer the wholesale enquiry' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.ok(handed);

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const base = `/api/companies/${fixture.companyId}/tasks/${task.id}`;
    const [run] = (await api.call('GET', `${base}/trace`, token)).body.runs;
    const told = await api.call('GET', `${base}/runs/${run.agentRunId}/briefing`, token);
    assert.equal(told.status, 200, JSON.stringify(told.body));
    const briefing = told.body.briefing;
    assert.match(briefing.contextPack.charter, /You answer wholesale enquiries/, 'its charter, as the runtime got it');
    assert.doesNotMatch(JSON.stringify(briefing), new RegExp(key), 'and never a key in the clear');
    const stored = await withTenant(fixture.companyId, (tx) => tx.query<{ briefing: string }>(
      'SELECT briefing::text AS briefing FROM agent_runs WHERE id = $1', [run.agentRunId]));
    assert.doesNotMatch(stored.rows[0]!.briefing, new RegExp(key), 'not even where it is stored');
    assert.ok(briefing.contextPack.notes.some((note: { title: string }) => note.title === 'What you return'), 'the notes it was handed');
    assert.deepEqual(briefing.modelRouting, { primary: 'test-model', fallback: [] });
    assert.deepEqual(briefing.task.input, { goal: 'answer the wholesale enquiry' });

    const stranger = await api.call('GET', `${base}/runs/00000000-0000-4000-8000-000000000000/briefing`, token);
    assert.equal(stranger.status, 400);
    const other = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'something else' }, createdBy: 'owner', reserveTokens: 1_000,
    });
    const elsewhere = await api.call('GET', `/api/companies/${fixture.companyId}/tasks/${other.id}/runs/${run.agentRunId}/briefing`, token);
    assert.equal(elsewhere.status, 400, 'a run is read under its own task only');

    // Past the prompt window it goes with the prompts; that it existed is still said.
    await scrubExpiredPrompts(fixture.companyId, new Date(Date.now() + 400 * 86_400_000));
    const gone = await api.call('GET', `${base}/runs/${run.agentRunId}/briefing`, token);
    assert.deepEqual([gone.body.briefing, gone.body.removed], [null, 'retention']);
  } finally {
    await api.close();
  }
});

