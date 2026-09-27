/**
 * Done criteria, checked (PRD F2.8, F14 `post_run`; src/engine/done.ts).
 *
 * Read against what an owner would expect of "done means": every role must
 * have criteria before it may work, and runs were shown them -- and then a
 * run that ended with any JSON at all counted as done. These hold that a run
 * a model wrote says, criterion by criterion, whether it met each and what
 * shows it; that one which leaves them out, or says it did not meet one, or
 * claims one without showing how, is not done; and that the retry is asked
 * again, told why, rather than handed its own rejected answer back from the
 * journal -- while nothing it did in the world is done twice.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { buildContext } from '../../src/context/builder.ts';
import { checkDone } from '../../src/engine/done.ts';
import type { LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Line = Pick<LlmTurn, 'content' | 'stopReason'>;

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
    return { ...line, inputTokens: 1_000, outputTokens: 100, costCents: 1, model: 'scripted-1' };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

const answers = (output: unknown): Line => ({ content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\`` }], stopReason: 'end_turn' });
const uses = (id: string, name: string, input: unknown): Line =>
  ({ content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' });

const CRITERIA = ['the address is found', 'its source is named'];

/** The role's criteria and output schema, as an owner would set them. */
async function criteria(fixture: Fixture, output: Record<string, unknown> = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } }) {
  await withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE roles SET done_criteria = $2, output_schema = $3 WHERE id = $1', [fixture.roleId, CRITERIA, JSON.stringify(output)]));
}

let sequence = 0;
async function newTask(fixture: Fixture, attemptMax = 3) {
  sequence += 1;
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `find the address of example.test (${sequence})` }, createdBy: 'owner', reserveTokens: 50_000,
  });
  await withTenant(fixture.companyId, (tx) => tx.query('UPDATE tasks SET attempt_max = $2 WHERE id = $1', [task.id, attemptMax]));
  return task;
}

function dns(seen: string[]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register<{ zone: string }, { records: string[] }>({
    name: 'dns.read', adapter: 'test:dns', defaultTier: 0,
    async execute(input) {
      seen.push(input.zone);
      return { records: ['192.0.2.7'] };
    },
  });
  return registry;
}

async function failures(fixture: Fixture, taskId: string): Promise<string[]> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ error: string }>(
    "SELECT payload->>'error' AS error FROM events WHERE task_id = $1 AND type = 'task.attempt_failed' ORDER BY occurred_at", [taskId]));
  return rows.map((row) => row.error);
}

const met = [
  { criterion: 'the address is found', met: true, evidence: 'dns.read returned 192.0.2.7 for example.test' },
  { criterion: 'its source is named', met: true, evidence: 'the A record of example.test, read through dns.read' },
];

test('a run says how it met each done criterion, or it is asked again -- told why, not handed its rejected answer back, and nothing it did is done twice', async () => {
  const fixture = await createCompany('done-reported');
  await criteria(fixture);
  const seen: string[] = [];
  const registry = dns(seen);
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET tools = ARRAY['dns.read'] WHERE id = $1", [fixture.roleId]));
  const model = new ScriptedModel([
    uses('call-1', 'dns__read', { zone: 'example.test' }),
    answers({ summary: 'example.test is at 192.0.2.7' }),
    answers({ summary: 'example.test is at 192.0.2.7', done: met }),
  ]);
  const engine = new Engine({ broker: new CapabilityBroker(registry), workerId: 'done-worker', llm: model, handlers: new Map() });
  const task = await newTask(fixture);

  // What the run is told to return, in its own words.
  const pack = await withTenant(fixture.companyId, (tx) => buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
  const contract = pack.sections.find((section) => section.kind === 'contract')!.body;
  assert.match(contract, /"done"/);
  assert.match(contract, /"met": false/, 'and that saying so is allowed');

  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.status, 'failed');
  const [why] = await failures(fixture, task.id);
  assert.match(why!, /did not say how it met its done criteria/);
  assert.match(why!, /the address is found/);

  const second = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(second.status, 'completed', second.reason);
  assert.equal(model.requests.length, 3, 'the answer was asked for again, not replayed from the journal');
  assert.deepEqual(seen, ['example.test'], 'the tool ran once: what was done in the world is kept');
  assert.match(model.requests[2]!.system, /Earlier attempts at this task failed[\s\S]*did not say how it met its done criteria/, 'and told why');
  assert.equal(model.requests[2]!.messages.length, 3, 'the turns before the tool replayed, so the model sees what it did');
  const kept = await withTenant(fixture.companyId, (tx) => tx.query<{ name: string }>(
    "SELECT name FROM task_steps WHERE task_id = $1 AND status = 'committed' ORDER BY step_index", [task.id]));
  assert.deepEqual(kept.rows.map((row) => row.name), ['model:turn 1', 'capability:dns.read', 'model:turn 2']);
  const done = (await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!;
  assert.deepEqual((done.output as { done: unknown }).done, met, 'the report is kept with the work, for the owner to read');
});

test('a run that says a criterion is not met is not done, nor one that claims it without showing how; when attempts run out, the task fails with why', async () => {
  const fixture = await createCompany('done-unmet');
  await criteria(fixture);
  const model = new ScriptedModel([
    answers({ summary: 'no address yet', done: [met[0], { criterion: 'its source is named', met: false, evidence: 'the registrar did not answer' }] }),
    answers({ summary: 'example.test is at 192.0.2.7', done: [met[0], { criterion: 'its source is named', met: true, evidence: ' ' }] }),
  ]);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'done-worker', llm: model, handlers: new Map() });
  const task = await newTask(fixture, 2);

  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'failed');
  const last = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(last.status, 'failed');
  assert.equal(model.requests.length, 2);
  const [unmet, unshown] = await failures(fixture, task.id);
  assert.match(unmet!, /not done: "its source is named" is not met -- the registrar did not answer/);
  assert.match(unshown!, /says "its source is named" is met without showing how/);
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'failed');
});

test('an answer that does not match the schema is asked for again too, rather than replayed until the attempts run out', async () => {
  const fixture = await createCompany('done-schema');
  await criteria(fixture);
  const model = new ScriptedModel([
    answers({ address: '192.0.2.7', done: met }),
    answers({ summary: 'example.test is at 192.0.2.7', done: met }),
  ]);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'done-worker', llm: model, handlers: new Map() });
  const task = await newTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'failed');
  assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'completed');
  assert.equal(model.requests.length, 2);
  const failed = await withTenant(fixture.companyId, (tx) => tx.query<{ name: string; status: string; error: string | null }>(
    'SELECT name, status, error FROM task_steps WHERE task_id = $1 ORDER BY step_index', [task.id]));
  assert.deepEqual(failed.rows.map((row) => [row.name, row.status]), [['model:turn 1', 'committed']], 'the turn is kept, as the answer that was taken');
});

test('code is checked by its own tests, not by its say-so; and a schema with no room for the report is neither asked nor checked', async () => {
  const fixture = await createCompany('done-code');
  await criteria(fixture);
  const handlers = new Map([['worker', async () => ({ summary: 'example.test is at 192.0.2.7' })]]);
  const byCode = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'done-worker', llm: new ScriptedModel([]), handlers });
  assert.equal((await byCode.runTask(fixture.companyId, (await newTask(fixture)).id, 'worker')).status, 'completed');

  await criteria(fixture, { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } });
  const strict = await newTask(fixture);
  const pack = await withTenant(fixture.companyId, (tx) => buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: strict.id }));
  assert.doesNotMatch(pack.sections.find((section) => section.kind === 'contract')!.body, /"done"/);
  const model = new ScriptedModel([answers({ summary: 'example.test is at 192.0.2.7' })]);
  const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'done-worker', llm: model, handlers: new Map() });
  assert.equal((await engine.runTask(fixture.companyId, strict.id, 'worker')).status, 'completed');
});

test('a criterion is found by its words, in any case and spacing, or by its place when the run put it in its own', () => {
  const evidence = 'the A record, read through dns.read';
  assert.doesNotThrow(() => checkDone(CRITERIA, { done: [
    { criterion: 'The address is  FOUND', met: true, evidence },
    { criterion: 'Named where it came from', met: true, evidence },
  ] }));
  // Out of order, each still answers its own: the unmet one is named, not the one in its place.
  assert.throws(() => checkDone(CRITERIA, { done: [
    { criterion: 'ITS SOURCE IS NAMED', met: false, evidence: 'no registrar answered' },
    { criterion: 'The Address Is Found', met: true, evidence },
  ] }), /"its source is named" is not met -- no registrar answered/);
  assert.throws(() => checkDone(CRITERIA, { done: [{ criterion: 'the address is found', met: true, evidence }] }),
    /nothing in "done" answers "its source is named"/);
  assert.throws(() => checkDone(CRITERIA, { done: [
    { criterion: 'the address is found', met: 'yes', evidence }, { criterion: 'its source is named', met: true, evidence },
  ] }), /"the address is found" is not met/, 'met is true, not a word that sounds like it');
});

