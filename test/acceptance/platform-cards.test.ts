/**
 * The platform's own inbox cards are said in the owner's language (the
 * analysis of 3 October, §2.3 item 7).
 *
 * The incidents, escalations and alerts the platform raised itself were
 * English whatever the owner read, and carried its codes: "Role
 * ops-coordinator is paused", "spent 3120 of 20000 cents in the period
 * beginning 2026-10-01", "Task 9f3c... has been waiting_approval since
 * 2026-10-02T03:14:00.000Z". Each is now composed when it is raised, in the
 * language the console is drawn in: roles by the name the owner gave them, a
 * task by what it was asked, money in the owner's currency and a moment on
 * the owner's clock. What a vendor or another agent wrote stays as written.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../../src/db/tenant.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { closePools } from '../../src/db/pool.ts';
import { evaluateCircuitBreakers, evaluateSpendLimit } from '../../src/governance/spend-guard.ts';
import { askAboutStranded } from '../../src/engine/liveness.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { proposeGoalChange } from '../../src/domain/goals.ts';
import { setDeploymentLanguages } from '../../src/domain/language.ts';
import { setMoneyDisplay } from '../../src/domain/money-display.ts';
import { setOwnerWindow } from '../../src/scheduler/windows.ts';
import { say } from '../../src/owner/say.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const HOUR = 3_600_000;

/** An owner who reads Indonesian, in rupiah, on Jakarta's clock. */
async function readsIndonesian(fixture: Fixture): Promise<void> {
  await setDeploymentLanguages({ console: 'id' });
  await setMoneyDisplay({ currency: 'IDR', rate: 16_500 });
  await setOwnerWindow({ timezone: 'Asia/Jakarta', startHour: 8, endHour: 22 });
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET display_name = 'Sari' WHERE id = $1", [fixture.roleId]));
}

/** Said in Indonesian, and not left in English: the dictionary has it. */
function indonesian(english: string, values: Record<string, string> = {}): string {
  const said = say('id', english, values);
  assert.notEqual(said, say(null, english, values), `"${english}" has no Indonesian`);
  return said;
}

async function newTask(fixture: Fixture, goal: string) {
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 5_000,
  });
}

async function seedTrace(fixture: Fixture, taskId: string, cents: number, at: Date): Promise<void> {
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response, input_tokens, output_tokens, cost_cents, occurred_at)
     VALUES ($1, $2, $3, 'test-model', '{}'::jsonb, '{}'::jsonb, 10, 5, $4, $5)`,
    [randomUUID(), fixture.companyId, taskId, cents, at]));
}

const open = async (fixture: Fixture) => inbox.listOpen(fixture.companyId);

test('the month\'s pause is said in the owner\'s language and currency, with no cents and no codes', async () => {
  const fixture = await createCompany('cards-pause');
  await readsIndonesian(fixture);
  const task = await newTask(fixture, 'Tulis newsletter Oktober');
  await seedTrace(fixture, task.id, 20_000, new Date());

  assert.equal((await evaluateSpendLimit(fixture.companyId)).state, 'paused');
  const [card] = (await open(fixture)).filter((item) => item.kind === 'budget_alert');
  assert.equal(card!.title, indonesian('Monthly budget reached; the company is paused'));
  // US$200 at 16,500 rupiah: the owner's currency first, the dollars it was charged in after.
  assert.match(card!.rationale, /Rp\s?3\.300\.000 \(US\$200,00\)/);
  assert.doesNotMatch(card!.rationale, /cents|\d{4}-\d{2}-\d{2}/, 'no cents and no ISO date');
});

test('a role spending too fast is named as the owner named it, with what it spent in their currency', async () => {
  const fixture = await createCompany('cards-rate');
  await readsIndonesian(fixture);
  const now = new Date();
  const task = await newTask(fixture, 'Balas ulasan pelanggan');
  for (let hoursAgo = 2; hoursAgo <= 167; hoursAgo += 1) await seedTrace(fixture, task.id, 10, new Date(now.getTime() - hoursAgo * HOUR));
  await seedTrace(fixture, task.id, 100, new Date(now.getTime() - 10 * 60_000));
  // The owner is asked only when the breaker holds the role: the third stop in a day.
  await withTenant(fixture.companyId, async (tx) => {
    for (let trip = 1; trip <= 2; trip += 1) {
      await appendEvent(tx, { companyId: fixture.companyId, type: 'budget.circuit_open', actor: 'system', payload: { roleId: fixture.roleId, trips: trip } });
    }
  });

  assert.equal((await evaluateCircuitBreakers(fixture.companyId, now)).length, 1);
  const [card] = (await open(fixture)).filter((item) => item.kind === 'incident');
  assert.equal(card!.title, indonesian('Role {role} is paused for spending too fast', { role: 'Sari' }));
  assert.ok(card!.rationale.includes(indonesian('This is the third time in a day, so it does not go on by itself.')), 'and says why it is the owner\'s now');
  assert.match(card!.rationale, /Rp\s?16\.500 \(US\$1,00\)/, 'a dollar an hour, in rupiah');
  const { rows: [role] } = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [fixture.roleId]));
  assert.ok(!card!.title.includes(role!.slug) && !card!.rationale.includes(role!.slug), 'the role by its name, not its code');
});

test('a task waiting on nothing is named by what it was asked, at a moment on the owner\'s clock', async () => {
  const fixture = await createCompany('cards-stranded');
  await readsIndonesian(fixture);
  const task = await newTask(fixture, 'Periksa stok biji kopi Gayo');
  await transition(fixture.companyId, task.id, 'running');
  const since = new Date('2026-10-02T03:14:00.000Z');

  assert.equal(await askAboutStranded(fixture.companyId, {
    taskId: task.id, projectId: fixture.projectId, status: 'waiting_approval', shape: 'approval_missing', since,
  }), true);
  const [card] = (await open(fixture)).filter((item) => item.kind === 'escalation');
  assert.equal(card!.title, indonesian('A task is waiting on nothing'));
  assert.ok(card!.rationale.includes('Periksa stok biji kopi Gayo'), 'the task by what it was asked');
  assert.ok(card!.rationale.includes('10.14'), `03:14 UTC is 10.14 in Jakarta: ${card!.rationale}`);
  assert.ok(card!.rationale.includes(indonesian('It is waiting for an approval, and none is open, so nothing you can answer will move it.')));
  assert.ok(!card!.rationale.includes(task.id) && !card!.rationale.includes('waiting_approval'), 'no id and no status code');
});

test('a run\'s question and a proposed goal change are headed in the owner\'s language', async () => {
  const fixture = await createCompany('cards-asked');
  await readsIndonesian(fixture);
  const task = await newTask(fixture, 'Kejar tagihan yang belum dibayar');
  await transition(fixture.companyId, task.id, 'running');

  await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Tagihan mana yang boleh saya kejar hari ini?' });
  const [asked] = (await open(fixture)).filter((item) => item.taskId === task.id);
  assert.equal(asked!.title, indonesian('{role} asks: {question}', { role: 'Sari', question: 'Tagihan mana yang boleh saya kejar hari ini?' }));
  assert.equal(asked!.consequenceIfDenied, indonesian('The task is stopped, and nothing it was going to do happens.'));

  const { rows: [goal] } = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>(
    'SELECT slug FROM goals WHERE id = $1', [fixture.goalId]));
  const proposed = await proposeGoalChange({
    companyId: fixture.companyId, goal: goal!.slug, proposedStatement: 'Seratus pelanggan tetap sebelum Desember',
    rationale: 'Pesanan ulang naik dua kali lipat.',
  });
  assert.equal(proposed.proposed, true);
  const [change] = (await open(fixture)).filter((item) => item.id === proposed.inboxItemId);
  assert.ok(change!.rationale.includes(indonesian('Proposed: {statement}', { statement: 'Seratus pelanggan tetap sebelum Desember' })));
  assert.ok(change!.rationale.includes(indonesian('Reason given: {reason}', { reason: 'Pesanan ulang naik dua kali lipat.' })));
  assert.equal(change!.consequenceIfDenied, indonesian('The goal stays as it is.'));
});
