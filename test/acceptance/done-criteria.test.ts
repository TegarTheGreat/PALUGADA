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
 *
 * And that evidence can be more than the run's word (after Auto-Company's
 * check runner): an entry that cites a step, `step:<n>`, is held to the
 * journal -- verified when this task made that tool call and it succeeded,
 * refused when the step failed or is not this task's -- and the owner reads
 * which criteria were verified and which only claimed.
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
import type { JournalEntry } from '../../src/engine/journal.ts';
import { taskDetailOf } from '../../src/owner/views.ts';
import type { LlmBlock, LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
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
  ] }, []));
  // Out of order, each still answers its own: the unmet one is named, not the one in its place.
  assert.throws(() => checkDone(CRITERIA, { done: [
    { criterion: 'ITS SOURCE IS NAMED', met: false, evidence: 'no registrar answered' },
    { criterion: 'The Address Is Found', met: true, evidence },
  ] }, []), /"its source is named" is not met -- no registrar answered/);
  assert.throws(() => checkDone(CRITERIA, { done: [{ criterion: 'the address is found', met: true, evidence }] }, []),
    /nothing in "done" answers "its source is named"/);
  assert.throws(() => checkDone(CRITERIA, { done: [
    { criterion: 'the address is found', met: 'yes', evidence }, { criterion: 'its source is named', met: true, evidence },
  ] }, []), /"the address is found" is not met/, 'met is true, not a word that sounds like it');
});

/* ------------------------------------------- evidence the platform can check --- */

/** A tool step written into a task's journal directly, as a run would have left it. */
async function journal(fixture: Fixture, taskId: string, index: number, name: string, output: unknown) {
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
     VALUES ($1, $2, $3, $4, 'tool', 'committed', 'h', $5, $6, now())`,
    [taskId, index, fixture.companyId, name, `k-${taskId}-${index}`, JSON.stringify(output)],
  ));
}

test('evidence that cites a tool call this task made and that succeeded is verified, the rest is claimed, and the owner reads which', async () => {
  const fixture = await createCompany('done-verified');
  await criteria(fixture);
  const registry = dns([]);
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET tools = ARRAY['dns.read'] WHERE id = $1", [fixture.roleId]));
  const report = [
    { criterion: 'the address is found', met: true, evidence: 'dns.read returned 192.0.2.7 for example.test (step:1)' },
    { criterion: 'its source is named', met: true, evidence: 'the A record of example.test' },
  ];
  const model = new ScriptedModel([
    uses('call-1', 'dns__read', { zone: 'example.test' }),
    answers({ summary: 'example.test is at 192.0.2.7', done: report }),
  ]);
  const engine = new Engine({ broker: new CapabilityBroker(registry), workerId: 'done-worker', llm: model, handlers: new Map() });
  const task = await newTask(fixture);

  // The run is told it may cite a step, and that the platform checks it.
  const pack = await withTenant(fixture.companyId, (tx) => buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
  const contract = pack.sections.find((section) => section.kind === 'contract')!.body;
  assert.match(contract, /step:<n>/);
  assert.match(contract, /the platform checks/);

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);
  // And each call's result says which step it is, where the run reads it:
  // in the platform's words, after the fence around what the tool returned.
  const results = model.requests[1]!.messages[2]!.content as LlmBlock[];
  const shown = results[0]!.type === 'tool_result' ? results[0]!.content : '';
  assert.match(shown, /<<<UNTRUSTED_CONTENT>>>\n[^<]*\bstep:1\b/);

  const detail = (await taskDetailOf(fixture.companyId, task.id))!;
  assert.deepEqual(detail.done, [
    { ...report[0]!, check: 'verified', steps: [{ step: 1, capability: 'dns.read' }] },
    { ...report[1]!, check: 'claimed', steps: [] },
  ]);
});

test('a citation of a step that failed, that only another task has, or that no task has is not verified: the criterion is not met, and the retry is told why', async () => {
  const fixture = await createCompany('done-refuted');
  await criteria(fixture);
  const registry = new CapabilityRegistry();
  registry.register<{ zone: string }, { records: string[] }>({
    name: 'dns.read', adapter: 'test:dns', defaultTier: 0,
    async execute(input) {
      if (input.zone === 'broken.test') throw new Error('the resolver timed out');
      return { records: ['192.0.2.7'] };
    },
  });
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await withTenant(fixture.companyId, (tx) => tx.query("UPDATE roles SET tools = ARRAY['dns.read'] WHERE id = $1", [fixture.roleId]));
  // Another task of the same company, whose journal holds a dns.read that
  // succeeded at the step this one's fails at, and at one this one never reaches.
  const other = await newTask(fixture);
  await journal(fixture, other.id, 1, 'capability:dns.read', { records: ['192.0.2.7'] });
  await journal(fixture, other.id, 7, 'capability:dns.read', { records: ['192.0.2.7'] });

  const citing = (evidence: string): Line => answers({
    summary: 'example.test is at 192.0.2.7',
    done: [{ criterion: 'the address is found', met: true, evidence }, met[1]],
  });
  const model = new ScriptedModel([
    uses('call-1', 'dns__read', { zone: 'broken.test' }),
    citing('dns.read answered (step:1)'),
    citing('dns.read answered (step:7)'),
    citing('dns.read answered (step:12)'),
  ]);
  const engine = new Engine({ broker: new CapabilityBroker(registry), workerId: 'done-worker', llm: model, handlers: new Map() });
  const task = await newTask(fixture, 3);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await engine.runTask(fixture.companyId, task.id, 'worker')).status, 'failed');
  }
  assert.equal(model.requests.length, 4, 'each answer was asked for again, not replayed');
  // A failed call is shown to the run as refused, and given no step to cite.
  const refused = (model.requests[1]!.messages[2]!.content as LlmBlock[])[0]!;
  assert.ok(refused.type === 'tool_result' && refused.isError);
  assert.doesNotMatch(refused.type === 'tool_result' ? refused.content : '', /step:/);

  const [failed, elsewhere, nowhere] = await failures(fixture, task.id);
  assert.match(failed!, /"the address is found" cites step:1, which failed: the resolver timed out/);
  assert.match(elsewhere!, /"the address is found" cites step:7, which this task's journal does not have/);
  assert.match(nowhere!, /"the address is found" cites step:12, which this task's journal does not have/);
  assert.match(model.requests[2]!.system, /Earlier attempts at this task failed[\s\S]*cites step:1, which failed/, 'and the retry is told why');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'failed');
});

test('what the journal bears out: a tool call of this task that committed; the model\'s own turn is its word, and a call that never finished shows nothing', () => {
  const steps: JournalEntry[] = [
    { index: 0, name: 'model:turn 1', kind: 'llm', status: 'committed', error: null },
    { index: 1, name: 'capability:dns.read', kind: 'tool', status: 'committed', error: null },
    { index: 2, name: 'capability:crm.note', kind: 'tool', status: 'failed', error: 'the CRM refused the note' },
    { index: 3, name: 'capability:dns.read', kind: 'tool', status: 'started', error: null },
  ];
  const report = (first: string) => ({ done: [
    { criterion: 'the address is found', met: true, evidence: first },
    { criterion: 'its source is named', met: true, evidence: 'the A record, read through dns.read' },
  ] });
  assert.deepEqual(checkDone(CRITERIA, report('dns.read returned 192.0.2.7 (step:1)'), steps), [
    { criterion: 'the address is found', check: 'verified' },
    { criterion: 'its source is named', check: 'claimed' },
  ]);
  // In any case, with a space, and beside a citation of the model's own turn.
  assert.equal(checkDone(CRITERIA, report('as I said at step:0, and as STEP: 1 shows'), steps)[0]!.check, 'verified');
  // The model's turn alone is the run's word about itself.
  assert.equal(checkDone(CRITERIA, report('as I said at step:0'), steps)[0]!.check, 'claimed');
  assert.throws(() => checkDone(CRITERIA, report('the note is in the CRM (step:2)'), steps),
    /"the address is found" cites step:2, which failed: the CRM refused the note/);
  assert.throws(() => checkDone(CRITERIA, report('read again at step:3'), steps),
    /"the address is found" cites step:3, which never finished/);
  assert.throws(() => checkDone(CRITERIA, report('step:1, and step:9 besides'), steps),
    /"the address is found" cites step:9, which this task's journal does not have/,
    'one citation that holds does not carry one that does not');
});

