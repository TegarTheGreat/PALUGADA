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
import { withTenant } from '../../src/db/tenant.ts';
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
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

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
  assert.match(alerts[0]!.rationale, /raise the ceiling or grant a temporary override/);
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

  const incidents = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'incident',
  );
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /paused for spending too fast/);
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
    (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'incident').length,
    1,
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
