/**
 * The owner's first hour with a new company (the analysis of 3 October, §9
 * P1 item 10).
 *
 * A company started from the console opened on an Overview of zeros: no
 * conversation, no first task, nothing that said what to do next, and a CEO
 * that could not speak until spoken to. Paperclip walks a new owner from an
 * interview to a plan to a first task. Now the CEO opens the conversation in
 * the company's language with the three things it needs -- what the company
 * sells and to whom, what it may spend in a month, and its first piece of
 * work -- and, while the first hour lasts, interviews before it proposes.
 * The Overview lists four steps, ticked off by what the owner actually does,
 * until they are done or the owner closes the list.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { transition } from '../../src/engine/tasks.ts';
import { setDeploymentLanguages } from '../../src/domain/language.ts';
import { installStandardTemplate, STANDARD_TEMPLATE_SLUG } from '../../src/templates/standard.ts';
import { firstHourOpener } from '../../src/owner/first-hour.ts';
import type { LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(async () => {
  await resetData();
  await registerStandardCatalogue();
  await installStandardTemplate();
  // The owner reads the console in Indonesian, which is the language the
  // CEO speaks to them in.
  await setDeploymentLanguages({ console: 'id' });
});
after(async () => {
  await closePools();
  await closeSetup();
});

/** A model that answers every turn with one line, and records what it was asked. */
class OneLineModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    return { content: [{ type: 'text', text: 'Baik. Siapa pelanggan utamanya?' }], stopReason: 'end_turn', inputTokens: 100, outputTokens: 10, costCents: 0 };
  }
  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

async function start(api: Console, token: string, slug = 'toko-kopi', name = 'Toko Kopi Senja'): Promise<string> {
  const created = await api.call('POST', '/api/companies', token, {
    templateSlug: STANDARD_TEMPLATE_SLUG, companySlug: slug, name, workLanguage: 'id', talkLanguage: 'id', proof: { totp: api.code() },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return String(created.body.companyId);
}

const steps = (body: { steps: Array<{ step: string; done: boolean }> }) =>
  Object.fromEntries(body.steps.map((one) => [one.step, one.done]));

test('a new company opens with its CEO asking, in the owner\'s language, the three things it needs', async () => {
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const companyId = await start(api, token);

    const talk = await api.call('GET', `/api/companies/${companyId}/conversation`, token);
    assert.equal(talk.status, 200);
    assert.equal(talk.body.messages.length, 1, 'the CEO has spoken first');
    const [opener] = talk.body.messages;
    assert.equal(opener.role, 'assistant');
    assert.equal(opener.body, firstHourOpener('id', { ceo: 'Arka', company: 'Toko Kopi Senja' }));
    assert.notEqual(opener.body, firstHourOpener(null, { ceo: 'Arka', company: 'Toko Kopi Senja' }), 'in Indonesian');

    const first = await api.call('GET', `/api/companies/${companyId}/first-hour`, token);
    assert.equal(first.status, 200);
    assert.equal(first.body.open, true);
    assert.deepEqual(first.body.steps.map((one: { step: string }) => one.step), ['talk', 'budget', 'work', 'result']);
    assert.ok(first.body.steps.every((one: { done: boolean }) => !one.done));
  } finally {
    await api.close();
  }
});

test('each step is ticked off by what the owner does, and the list goes when it is done or closed', async () => {
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const companyId = await start(api, token);
    const read = async () => (await api.call('GET', `/api/companies/${companyId}/first-hour`, token)).body;

    await api.call('POST', `/api/companies/${companyId}/conversation/messages`, token, { text: 'Kami jual kopi susu di Bandung.' });
    assert.deepEqual(steps(await read()), { talk: true, budget: false, work: false, result: false });

    const limited = await api.call('POST', `/api/companies/${companyId}/spend/limit`, token, { moneyMaxCents: 15_000 });
    assert.equal(limited.status, 200, JSON.stringify(limited.body));
    assert.deepEqual(steps(await read()), { talk: true, budget: true, work: false, result: false });

    const { rows: [place] } = await withTenant(companyId, (tx) => tx.query<{ role: string; division: string; project: string; goal: string }>(
      `SELECT r.id AS role, r.division_id AS division, (SELECT id FROM projects LIMIT 1) AS project,
              (SELECT id FROM goals WHERE kind = 'mission') AS goal
         FROM roles r WHERE r.title = 'CEO'`));
    const assigned = await api.call('POST', `/api/companies/${companyId}/assign`, token, {
      roleId: place!.role, divisionId: place!.division, projectId: place!.project, goalId: place!.goal,
      goal: 'Tulis sepuluh pertanyaan untuk pelanggan pertama kami',
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.deepEqual(steps(await read()), { talk: true, budget: true, work: true, result: false });

    const taskId = String(assigned.body.taskId);
    await transition(companyId, taskId, 'running');
    await transition(companyId, taskId, 'completed', { output: { summary: 'Sepuluh pertanyaan, masing-masing dengan alasannya.' } });
    const done = await read();
    assert.deepEqual(steps(done), { talk: true, budget: true, work: true, result: true });
    assert.equal(done.open, false, 'every step done, the list has done its job');

    // Closed by the owner before it is done.
    const other = await start(api, token, 'toko-roti', 'Toko Roti Pagi');
    const closed = await api.call('POST', `/api/companies/${other}/first-hour/close`, token, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const after_ = (await api.call('GET', `/api/companies/${other}/first-hour`, token)).body;
    assert.equal(after_.open, false);
    assert.ok(after_.steps.every((one: { done: boolean }) => !one.done), 'closing ticks nothing off');
  } finally {
    await api.close();
  }
});

test('the CEO knows it opened the conversation, and interviews while the first hour lasts', async () => {
  const model = new OneLineModel();
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const companyId = await start(api, token);
    const opener = firstHourOpener('id', { ceo: 'Arka', company: 'Toko Kopi Senja' });

    await api.call('POST', `/api/companies/${companyId}/conversation/messages`, token, { text: 'Kami jual kopi susu di Bandung.' });
    const [first] = model.requests;
    assert.equal(first!.messages[0]!.role, 'user', 'the model is still spoken to first by the owner');
    assert.ok(first!.system.includes(opener), 'and told what it asked before the owner answered');
    assert.match(first!.system, /first hour/);
    assert.match(first!.system, /never more than three/);

    await api.call('POST', `/api/companies/${companyId}/first-hour/close`, token, {});
    await api.call('POST', `/api/companies/${companyId}/conversation/messages`, token, { text: 'Lanjut.' });
    assert.doesNotMatch(model.requests.at(-1)!.system, /first hour/, 'and stops interviewing once it is over');
  } finally {
    await api.close();
  }
});
