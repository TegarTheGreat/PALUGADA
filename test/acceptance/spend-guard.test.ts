/**
 * PRD v2 F1.7, F1.8, F1.9 -- the monthly ceiling, the owner's override, and
 * the spending circuit breaker.
 *
 * F1.9 is the frame: the periodic ceiling and the per-task one are separate
 * instruments and both must hold. A single runaway task is caught by its
 * budget account; a hundred well-behaved tasks that together cost more than
 * the company can afford are caught only by the period. The breaker is a third
 * thing again, watching the rate rather than the total, so a role that starts
 * burning ten times its usual cost is stopped while there is still money left
 * to find out why.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import {
  clearSpendPause,
  evaluateCircuitBreakers,
  evaluateSpendLimit,
  isSpendPaused,
  limitFor,
  overrideSpendPause,
  periodSpend,
  setSpendLimit,
} from '../../src/governance/spend-guard.ts';
import { setThresholds } from '../../src/reporting/alerts.ts';
import { frozenRoles } from '../../src/governance/role-freeze.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup, runMigrationAgain } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const HOUR = 3_600_000;

let sequence = 0;
async function newTask(fixture: Fixture, roleId = fixture.roleId) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `spend-${sequence}` },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
}

/** A model call that cost something, at a chosen moment. */
async function seedTrace(
  fixture: Fixture,
  taskId: string | null,
  cents: number,
  at: Date,
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO llm_traces (id, company_id, task_id, model, prompt, response,
                               input_tokens, output_tokens, cost_cents, occurred_at)
       VALUES ($1, $2, $3, 'test-model', '{}'::jsonb, '{}'::jsonb, 10, 5, $4, $5)`,
      [randomUUID(), fixture.companyId, taskId, cents, at],
    );
  });
}

/** A capability call that cost something, as the broker records it. */
async function seedToolCost(
  fixture: Fixture,
  taskId: string | null,
  cents: number,
  at: Date,
): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO events (company_id, project_id, task_id, type, actor, payload, occurred_at)
       VALUES ($1, $2, $3, 'tool.cost', 'broker', $4::jsonb, $5)`,
      [
        fixture.companyId,
        fixture.projectId,
        taskId,
        JSON.stringify({ capability: 'email.send', estimatedCents: cents, actualCents: cents }),
        at,
      ],
    );
  });
}

test('the monthly ceiling counts model calls and capability calls together (F1.9)', async () => {
  // The owner does not care which of the two spent the money, so neither does
  // the ceiling. Counting only one would leave the other unbounded.
  const fixture = await createCompany('spend-sources');
  const task = await newTask(fixture);
  const now = new Date();

  await seedTrace(fixture, task.id, 1_200, now);
  await seedToolCost(fixture, task.id, 800, now);

  const spend = await periodSpend(fixture.companyId, now);
  assert.equal(spend.cents, 2_000);
  assert.equal(spend.limitCents, 20_000, 'USD 200 a month, section 14.3');
  assert.equal(spend.fraction, 0.1);
});

test('eighty percent warns once, not once per check (F1.7)', async () => {
  // A sweep every few minutes against a standing overspend would fill the
  // inbox, and an owner who has learned to scroll past the inbox is worse off
  // than one with no alerts.
  const fixture = await createCompany('spend-warn');
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 16_500, new Date());

  const first = await evaluateSpendLimit(fixture.companyId);
  assert.equal(first.state, 'warned');
  await evaluateSpendLimit(fixture.companyId);
  await evaluateSpendLimit(fixture.companyId);

  const alerts = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'budget_alert',
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.title, /80% spent/);
  assert.equal(await isSpendPaused(fixture.companyId), false, 'a warning is not a stop');
});

test('a hundred percent pauses the company, and nothing new starts (F1.7)', async () => {
  const fixture = await createCompany('spend-pause');
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 20_000, new Date());

  const outcome = await evaluateSpendLimit(fixture.companyId);
  assert.equal(outcome.state, 'paused');
  assert.equal(await isSpendPaused(fixture.companyId), true);

  // Admission is barred as well as external action: a paused company that
  // could still start tasks would keep spending on model calls, which is most
  // of the bill the ceiling exists to cap.
  await assert.rejects(
    () => newTask(fixture),
    (error: unknown) => isPalugadaError(error, 'spend.paused'),
  );

  const alerts = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'budget_alert',
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.title, /paused/);
  assert.match(alerts[0]!.rationale, /raise the ceiling or allow spending past it for a while/);
});

test("the owner's override has a deadline it cannot outlive (F1.7)", async () => {
  // An override with no end would quietly become the new ceiling, which is the
  // failure mode a ceiling exists to prevent.
  const fixture = await createCompany('spend-override');
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 25_000, new Date());
  await evaluateSpendLimit(fixture.companyId);
  assert.equal(await isSpendPaused(fixture.companyId), true);

  const until = new Date(Date.now() + 2 * HOUR);
  await overrideSpendPause(fixture.companyId, until);

  assert.equal(await isSpendPaused(fixture.companyId), false);
  const resumed = await newTask(fixture);
  assert.ok(resumed.id, 'work runs again while the override stands');

  // And stops again on its own once the override has expired.
  const afterwards = new Date(until.getTime() + 60_000);
  assert.equal(await isSpendPaused(fixture.companyId, afterwards), true);
});

test('a raised ceiling ends the pause, and the pause does not return', async () => {
  const fixture = await createCompany('spend-raised');
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 20_000, new Date());
  await evaluateSpendLimit(fixture.companyId);
  assert.equal(await isSpendPaused(fixture.companyId), true);

  await setSpendLimit(fixture.companyId, 100_000);
  await clearSpendPause(fixture.companyId);

  assert.equal(await isSpendPaused(fixture.companyId), false);
  const outcome = await evaluateSpendLimit(fixture.companyId);
  assert.equal(outcome.state, 'under');
  assert.equal((await limitFor(fixture.companyId)).moneyMaxCents, 100_000);
});

/**
 * M6 (the audit of 30 September, open on 2 October). The pause is set when a
 * month's spending reaches the ceiling, and nothing took it off when the month
 * ended: the guard returned "under" for the new month and left `paused_at`
 * where it was, so a company that ran out in October was still paused in
 * November, every task it was given refused, until the owner found the page
 * and lifted it by hand. The ceiling is a month's, and so is its pause.
 */
test('a month\'s pause ends with its month, and the card that said so is withdrawn (F1.7, M6)', async () => {
  const fixture = await createCompany('spend-new-month');
  const task = await newTask(fixture);
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
  await seedTrace(fixture, task.id, 20_000, lastMonth);
  assert.equal((await evaluateSpendLimit(fixture.companyId, lastMonth)).state, 'paused');
  assert.equal(await isSpendPaused(fixture.companyId), true);
  const [card] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert');
  assert.ok(card);

  // The worker's next look, in the new month.
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'under');
  assert.equal(await isSpendPaused(fixture.companyId), false);
  assert.ok((await newTask(fixture)).id, 'work is taken again');
  const { rows: closed } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [card.id]));
  assert.deepEqual(closed[0], { status: 'withdrawn', closed_reason: 'period_started' });
  const { rows: said } = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string }>(
    "SELECT type FROM events WHERE type IN ('budget.period_resumed', 'inbox.withdrawn') ORDER BY occurred_at"));
  assert.deepEqual(said.map((row) => row.type).sort(), ['budget.period_resumed', 'inbox.withdrawn']);

  // A pause of this month is this month's: the next look leaves it.
  await seedTrace(fixture, task.id, 20_000, now);
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'paused');
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'paused');
  assert.equal(await isSpendPaused(fixture.companyId), true);

  // Lifted by the owner, its card goes too.
  await clearSpendPause(fixture.companyId);
  const { rows: open } = await withTenant(fixture.companyId, (tx) => tx.query<{ closed_reason: string | null }>(
    "SELECT closed_reason FROM inbox_items WHERE kind = 'budget_alert' ORDER BY created_at DESC LIMIT 1"));
  assert.equal(open[0]!.closed_reason, 'spend_resumed');
});

test('a ceiling raised past what is spent lifts the pause by itself, and the card that said it was paused goes (the owner\'s report of 7 October)', async () => {
  const fixture = await createCompany('spend-raised');
  const now = new Date();
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 20_000, now);
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'paused');
  assert.equal(await isSpendPaused(fixture.companyId), true);
  const [card] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert');
  assert.ok(card);

  // Raised, but not past what is spent: still paused.
  await setSpendLimit(fixture.companyId, 20_000);
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'paused');
  assert.equal(await isSpendPaused(fixture.companyId), true);

  // Raised past it: the one decision the owner had to make. The next look lifts the pause.
  await setSpendLimit(fixture.companyId, 50_000);
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'under');
  assert.equal(await isSpendPaused(fixture.companyId), false);
  assert.ok((await newTask(fixture)).id, 'work is taken again');
  const { rows: closed } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [card.id]));
  assert.deepEqual(closed[0], { status: 'withdrawn', closed_reason: 'spend_resumed' });
  const { rows: said } = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { reason: string } }>(
    "SELECT actor, payload FROM events WHERE type = 'budget.pause_lifted'"));
  assert.deepEqual(said.map((row) => [row.actor, row.payload.reason]), [['system', 'ceiling_raised']]);
});

/**
 * The 80% card was raised with nothing to say what it was about, so nothing
 * could ever close it: a company warned in October and never paused kept
 * "80% spent" in front of the owner for good, and one that went on to 100%
 * had the warning beside the card that said it was paused.
 */
test("last month's 80% warning closes itself in the new month, paused or not (F1.7)", async () => {
  const fixture = await createCompany('spend-warning-month');
  const task = await newTask(fixture);
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
  await seedTrace(fixture, task.id, 16_500, lastMonth);
  assert.equal((await evaluateSpendLimit(fixture.companyId, lastMonth)).state, 'warned');
  const [warning] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert');
  assert.ok(warning);

  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'under');
  const { rows: closed } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [warning.id]));
  assert.deepEqual(closed[0], { status: 'withdrawn', closed_reason: 'period_started' });
  const { rows: said } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { inboxItemId: string } }>(
    "SELECT payload FROM events WHERE type = 'inbox.withdrawn'"));
  assert.deepEqual(said.map((row) => row.payload.inboxItemId), [warning.id]);
});

/**
 * An 80% warning raised before the warning said its month (0135) left nothing
 * for the month's end to close it by: a deployment upgraded with one open kept
 * it for good. What it is about is when it was raised.
 */
test("an 80% warning raised before the warnings said their month closes with its month after the upgrade (F1.7, 0135)", async () => {
  const fixture = await createCompany('spend-warning-0135');
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
  const raised = async (title: string, at: Date) => {
    const itemId = await inbox.raiseBudgetAlert({ companyId: fixture.companyId, title, detail: '$165.00 of $200.00 spent.' });
    await withControlPlane((tx) => tx.query('UPDATE inbox_items SET created_at = $2 WHERE id = $1', [itemId, at]));
    return itemId;
  };
  const earlier = await raised('Monthly budget is 80% spent', lastMonth);
  const current = await raised('Monthly budget is 80% spent', now);
  // The pause card raised before it said its month: matched by its title where it closes, and not a warning.
  const pause = await raised('Monthly budget reached; the company is paused', lastMonth);
  const card = async (itemId: string) => (await withTenant(fixture.companyId, (tx) => tx.query<{
    status: string; closed_reason: string | null; payload: Record<string, unknown>;
  }>('SELECT status, closed_reason, payload FROM inbox_items WHERE id = $1', [itemId]))).rows[0]!;

  await runMigrationAgain('0135_old_cards_name_their_period.sql');

  const monthOf = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
  assert.deepEqual((await card(earlier)).payload, { spendWarning: { periodStart: monthOf(lastMonth) } });
  assert.deepEqual((await card(current)).payload, { spendWarning: { periodStart: monthOf(now) } });
  assert.deepEqual((await card(pause)).payload, {});

  // The next look closes last month's, as it closes one raised today, and leaves this month's.
  assert.equal((await evaluateSpendLimit(fixture.companyId, now)).state, 'under');
  assert.deepEqual([(await card(earlier)).status, (await card(earlier)).closed_reason], ['withdrawn', 'period_started']);
  assert.equal((await card(current)).status, 'open');
});

/**
 * Both of a month's cards close when it ends, and only one of them still says
 * something true: what the month spent is still what it spent, and "the
 * company is paused" is not. The chat keeps the warning's figure above why it
 * closed, as it does a day's card, and says of each why it went rather than a
 * bare "withdrawn".
 */
test('in the chat, last month\'s warning keeps its figure and its pause card does not, each saying why it closed (F1.7, F10.9)', async () => {
  const { dispatch, retractClosed, closureText } = await import('../../src/owner/notify.ts');
  type Closed = Parameters<typeof closureText>[0] & { said?: string | null };
  const warned = await createCompany('spend-chat-warned');
  const paused = await createCompany('spend-chat-paused');
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
  await seedTrace(warned, (await newTask(warned)).id, 16_500, lastMonth);
  await seedTrace(paused, (await newTask(paused)).id, 20_000, lastMonth);
  assert.equal((await evaluateSpendLimit(warned.companyId, lastMonth)).state, 'warned');
  assert.equal((await evaluateSpendLimit(paused.companyId, lastMonth)).state, 'paused');

  const rewritten: Closed[] = [];
  const chat = {
    name: 'chat:telegram',
    carries: () => true,
    deliver: async () => ({ ref: '7' }),
    retract: async (closed: Closed) => { rewritten.push(closed); return 'retracted' as const; },
  };
  for (const fixture of [warned, paused]) {
    assert.equal((await dispatch(fixture.companyId, chat, { now: new Date(Date.now() + 86_400_000) })).delivered, 1);
    await evaluateSpendLimit(fixture.companyId, now);
    assert.deepEqual(await retractClosed(fixture.companyId, chat), { retracted: 1, failed: 0 });
  }
  const [warning, pause] = rewritten;
  assert.equal(warning!.closedReason, 'period_started');
  assert.match(warning!.said ?? '', /^\$165\.00 of \$200\.00 spent since /, 'what the month spent is still what it spent');
  assert.equal(closureText(warning!), 'Withdrawn: the month it was about has ended.');
  assert.equal(pause!.closedReason, 'period_started');
  assert.equal(pause!.said, null, 'the company is not paused any more, so that is not said again');
  assert.equal(closureText(pause!), 'Withdrawn: the month it was about has ended.');
});

test('the 80% warning gives way to the pause card when the ceiling is reached (F1.7)', async () => {
  const fixture = await createCompany('spend-warning-paused');
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 16_500, new Date());
  assert.equal((await evaluateSpendLimit(fixture.companyId)).state, 'warned');
  const [warning] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert');
  assert.ok(warning);

  // Still this month's: a second look keeps it.
  assert.equal((await evaluateSpendLimit(fixture.companyId)).state, 'warned');
  assert.deepEqual((await inbox.listOpen(fixture.companyId)).map((item) => item.id), [warning.id]);

  await seedTrace(fixture, task.id, 4_000, new Date());
  assert.equal((await evaluateSpendLimit(fixture.companyId)).state, 'paused');
  const open = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'budget_alert');
  assert.equal(open.length, 1, 'one card says where the month stands');
  assert.match(open[0]!.title, /paused/);
  const { rows: closed } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [warning.id]));
  assert.deepEqual(closed[0], { status: 'withdrawn', closed_reason: 'spend_paused' });
});

/**
 * Seeds a role with a steady hourly spend across the baseline window.
 *
 * One task carrying many traces rather than many tasks: the breaker attributes
 * spend through the task to the role, so what matters is the timing of the
 * traces and not how many tasks they are spread across.
 */
async function seedBaseline(
  fixture: Fixture,
  roleId: string,
  centsPerHour: number,
  now: Date,
): Promise<string> {
  const task = await newTask(fixture, roleId);
  for (let hoursAgo = 2; hoursAgo <= 167; hoursAgo += 1) {
    await seedTrace(fixture, task.id, centsPerHour, new Date(now.getTime() - hoursAgo * HOUR));
  }
  return task.id;
}

test('a role burning ten times its usual rate is paused, with the month still intact (F1.8)', async () => {
  // The PRD's own acceptance criterion: a role that suddenly spends ten times
  // normal is stopped without the company reaching 100% of its budget.
  const fixture = await createCompany('spend-breaker');
  const now = new Date();
  const task = await seedBaseline(fixture, fixture.roleId, 10, now);

  // The spike: ten times the hourly rate, inside the last hour.
  await seedTrace(fixture, task, 100, new Date(now.getTime() - 10 * 60_000));

  const tripped = await evaluateCircuitBreakers(fixture.companyId, now);
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0]!.roleId, fixture.roleId);
  assert.equal(tripped[0]!.lastHourCents, 100);
  assert.ok(tripped[0]!.multiple! > 3, `multiple was ${tripped[0]!.multiple}`);

  const frozen = await frozenRoles(fixture.companyId);
  assert.equal(frozen.length, 1);
  assert.match(frozen[0]!.reason ?? '', /times its usual rate/);

  // Stopped with money to spare, which is the whole point of watching the rate
  // rather than only the total.
  const spend = await periodSpend(fixture.companyId, now);
  assert.ok(spend.fraction < 1, `period was ${(spend.fraction * 100).toFixed(1)}% spent`);
  assert.equal(await isSpendPaused(fixture.companyId), false);

  // The first stop in a day is the platform's to hold and let go: there is a
  // journalled event and the role says why, and nothing is put to the owner
  // (self-heal-roles.test.ts proves the third is).
  assert.deepEqual(
    (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident'),
    [],
  );
  const { rows: [opened] } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { trips: number; held: boolean } }>(
    "SELECT payload FROM events WHERE type = 'budget.circuit_open'"));
  assert.deepEqual([opened!.payload.trips, opened!.payload.held], [1, false]);
});

test('the spike does not get to raise its own baseline', async () => {
  // The last hour sits inside the seven-day window, so leaving it in would let
  // a large enough spike lift the average it is being compared against and
  // hide itself.
  const fixture = await createCompany('spend-baseline');
  const now = new Date();
  const task = await seedBaseline(fixture, fixture.roleId, 10, now);
  await seedTrace(fixture, task, 5_000, new Date(now.getTime() - 5 * 60_000));

  const tripped = await evaluateCircuitBreakers(fixture.companyId, now);
  assert.equal(tripped.length, 1);
  assert.ok(
    tripped[0]!.baselineHourlyCents < 11,
    `the baseline stayed near the real rate: ${tripped[0]!.baselineHourlyCents}`,
  );
});

test('three times almost nothing is still almost nothing', async () => {
  // Without a floor a company spending a cent an hour would trip on four
  // cents, and a breaker that fires on noise teaches the owner to ignore it.
  const fixture = await createCompany('spend-floor');
  const now = new Date();
  const task = await seedBaseline(fixture, fixture.roleId, 1, now);
  await seedTrace(fixture, task, 40, new Date(now.getTime() - 5 * 60_000));

  const tripped = await evaluateCircuitBreakers(fixture.companyId, now);
  assert.deepEqual(tripped, [], '40 cents is under the 100 cent floor');
  assert.deepEqual(await frozenRoles(fixture.companyId), []);
});

test('a role with no history cannot be three times anything', async () => {
  // There is nothing to be a multiple of. That gap is covered by the period
  // ceiling rather than by inventing a baseline for a role nobody has watched.
  const fixture = await createCompany('spend-no-history');
  const now = new Date();
  const task = await newTask(fixture);
  await seedTrace(fixture, task.id, 5_000, new Date(now.getTime() - 5 * 60_000));

  const tripped = await evaluateCircuitBreakers(fixture.companyId, now);
  assert.deepEqual(tripped, []);
  assert.deepEqual(await frozenRoles(fixture.companyId), []);
});

test('the multiple is configurable, and a quieter company can ask for a tighter one', async () => {
  const fixture = await createCompany('spend-threshold');
  await setThresholds(fixture.companyId, { spendRateMultiple: 1.5 });
  const now = new Date();
  const task = await seedBaseline(fixture, fixture.roleId, 60, now);
  // Twice the baseline: under the default three, over the configured 1.5.
  await seedTrace(fixture, task, 120, new Date(now.getTime() - 5 * 60_000));

  const tripped = await evaluateCircuitBreakers(fixture.companyId, now);
  assert.equal(tripped.length, 1);
  assert.ok(tripped[0]!.multiple! > 1.5 && tripped[0]!.multiple! < 3);
});

test('a role already stopped is not reported again', async () => {
  const fixture = await createCompany('spend-already');
  const now = new Date();
  const task = await seedBaseline(fixture, fixture.roleId, 10, now);
  await seedTrace(fixture, task, 500, new Date(now.getTime() - 5 * 60_000));

  assert.equal((await evaluateCircuitBreakers(fixture.companyId, now)).length, 1);
  assert.deepEqual(
    await evaluateCircuitBreakers(fixture.companyId, now),
    [],
    'a frozen role cannot spend, so re-reporting it says nothing new',
  );
  assert.equal(
    (await withTenant(fixture.companyId, (tx) => tx.query("SELECT 1 FROM events WHERE type = 'budget.circuit_open'"))).rowCount,
    1,
    'and it is not counted as a second stop',
  );
});

test('the breaker stops the role that spent, not the company', async () => {
  // The smallest cut that holds. Stopping the company would stop the divisions
  // that are working.
  const fixture = await createCompany('spend-narrow');
  const quiet = await addRole(fixture, 'quiet');
  const now = new Date();
  const noisyTask = await seedBaseline(fixture, fixture.roleId, 10, now);
  await seedTrace(fixture, noisyTask, 400, new Date(now.getTime() - 5 * 60_000));
  await seedBaseline(fixture, quiet, 10, now);

  await evaluateCircuitBreakers(fixture.companyId, now);

  const frozen = await frozenRoles(fixture.companyId);
  assert.deepEqual(frozen.map((row) => row.roleId), [fixture.roleId]);
  assert.equal(await isSpendPaused(fixture.companyId), false);
});

test("one company's spending says nothing about another's", async () => {
  const mine = await createCompany('spend-mine');
  const theirs = await createCompany('spend-theirs');
  const task = await newTask(mine);
  await seedTrace(mine, task.id, 25_000, new Date());

  await evaluateSpendLimit(mine.companyId);
  await evaluateSpendLimit(theirs.companyId);

  assert.equal(await isSpendPaused(mine.companyId), true);
  assert.equal(await isSpendPaused(theirs.companyId), false);
  assert.equal((await periodSpend(theirs.companyId)).cents, 0);
});
