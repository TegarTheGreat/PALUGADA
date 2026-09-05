/**
 * PRD F9.1, F9.2, F9.3, F9.6 -- durable scheduling and time windows.
 *
 * F9.6 is the frame for all of it: agents have no working hours. What is
 * restricted is when an action may touch the outside world, and when the owner
 * may be disturbed. Those are separate windows with separate reasons.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { nextOccurrence, runDueSchedules, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import {
  isWithin,
  localTimeIn,
  nextOpening,
  notifyAfterFor,
  pendingNotifications,
  setBatchWindow,
  setOwnerWindow,
} from '../../src/scheduler/windows.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { claimReadyWindowTasks, createRootTask, getTask } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import * as budget from '../../src/engine/budget.ts';
import { freezeCompany } from '../../src/engine/control.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createCompany, grantCapability, type Fixture, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const JAKARTA = 'Asia/Jakarta';

test('a window is evaluated in its own zone, not in UTC', () => {
  const window = { timezone: JAKARTA, startHour: 8, endHour: 18, daysOfWeek: [1, 2, 3, 4, 5] };

  // 02:00 UTC on a Wednesday is 09:00 in Jakarta: inside business hours.
  assert.equal(localTimeIn(JAKARTA, new Date('2026-09-02T02:00:00Z')).hour, 9);
  assert.equal(isWithin(window, new Date('2026-09-02T02:00:00Z')), true);

  // 14:00 UTC the same day is 21:00 in Jakarta: outside.
  assert.equal(isWithin(window, new Date('2026-09-02T14:00:00Z')), false);

  // Saturday is excluded by the day set even at a permitted hour.
  assert.equal(isWithin(window, new Date('2026-09-05T02:00:00Z')), false);
});

test('a window may wrap past midnight', () => {
  // 22:00-06:00 is one window, not two, and the small hours belong to the
  // evening that opened it.
  const nightly = { timezone: 'UTC', startHour: 22, endHour: 6, daysOfWeek: [1, 2, 3, 4, 5] };
  assert.equal(isWithin(nightly, new Date('2026-09-02T23:00:00Z')), true);
  assert.equal(isWithin(nightly, new Date('2026-09-03T03:00:00Z')), true);
  assert.equal(isWithin(nightly, new Date('2026-09-03T12:00:00Z')), false);

  // Saturday 03:00 still belongs to Friday night, which is a permitted day.
  assert.equal(isWithin(nightly, new Date('2026-09-05T03:00:00Z')), true);
  // Sunday 03:00 belongs to Saturday night, which is not.
  assert.equal(isWithin(nightly, new Date('2026-09-06T03:00:00Z')), false);
});

test('the next opening skips over closed days', () => {
  const weekdays = { timezone: 'UTC', startHour: 8, endHour: 18, daysOfWeek: [1, 2, 3, 4, 5] };
  const saturdayNoon = new Date('2026-09-05T12:00:00Z');
  const opening = nextOpening(weekdays, saturdayNoon);
  assert.ok(opening);
  assert.equal(opening!.toISOString(), '2026-09-07T08:00:00.000Z');

  const impossible = { timezone: 'UTC', startHour: 8, endHour: 18, daysOfWeek: [] };
  assert.equal(nextOpening(impossible, saturdayNoon), null, 'an empty day set never opens');
});

test('an action outside its window waits instead of failing (F9.2)', async () => {
  const fixture = await createCompany('window-defer');

  const calls = { executions: 0 };
  const emailCapability: Capability<{ to: string }, { sent: boolean }> = {
    name: 'email.send',
    adapter: 'test:email',
    // Tier 2, matching the catalogue: PRD section 8.8 lists external email as a
    // tier 2 example, and a double that claimed tier 1 would be exercising
    // a gate the real capability never passes through.
    defaultTier: 2,
    async execute() {
      calls.executions += 1;
      return { sent: true };
    },
    async verify() {
      return true;
    },
  };

  const registry = new CapabilityRegistry();
  registry.register(emailCapability);
  await registry.sync();
  await grantCapability(fixture, 'email.send');

  // A window that is closed at every hour of today, so the test does not
  // depend on when it happens to run.
  const today = new Date().getUTCDay();
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO capability_windows
         (company_id, capability_name, timezone, start_hour, end_hour, days_of_week)
       VALUES ($1, 'email.send', 'UTC', 8, 18, $2)`,
      [fixture.companyId, [(today + 2) % 7]],
    );
  });

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability('email.send', { to: 'client@example.test' });
      return {};
    }]]),
  });

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: {},
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'email.send' }]);

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'waiting_window', 'a closed window defers, it does not fail');
  assert.equal(calls.executions, 0);
  assert.ok(outcome.waitUntil instanceof Date, 'the task must know when to try again');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'waiting_window');

  // Nothing is ready yet, so a worker sweeping for reopened windows finds none.
  const readyNow = await claimReadyWindowTasks(fixture.companyId, new Date());
  assert.equal(readyNow.length, 0);

  // Once the wake-up time passes, the task is picked up again rather than
  // sitting there for ever.
  const ready = await claimReadyWindowTasks(fixture.companyId, new Date(Date.now() + 8 * 86_400_000));
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, task.id);
});

test('non-emergency escalations wait for the owner window; incidents do not (F9.3)', async () => {
  const fixture = await createCompany('owner-window');

  // A window that is closed right now, whatever the current hour.
  const currentHour = new Date().getUTCHours();
  await setOwnerWindow({
    timezone: 'UTC',
    startHour: (currentHour + 2) % 24,
    endHour: (currentHour + 4) % 24,
  });

  const now = new Date();
  const escalationAt = await notifyAfterFor('escalation', { now });
  const incidentAt = await notifyAfterFor('incident', { now });
  const tierThreeAt = await notifyAfterFor('approval', { tier: 3, now });
  const tierTwoAt = await notifyAfterFor('approval', { tier: 2, now });

  assert.ok(escalationAt > now, 'a routine escalation waits for waking hours');
  assert.equal(incidentAt.getTime(), now.getTime(), 'an incident is already going wrong');
  assert.equal(tierThreeAt.getTime(), now.getTime(), 'an irreversible action needs a human now');
  assert.ok(tierTwoAt > now, 'a tier 2 approval can wait until morning');

  await inbox.raiseIncident({
    companyId: fixture.companyId,
    title: 'Production deploy failed verification',
    detail: 'read-back mismatch',
  });
  await inbox.raiseEscalation({
    companyId: fixture.companyId,
    title: 'Which supplier should we use?',
    detail: 'two options, similar cost',
  });

  // Both items exist; only the incident may be shown right now.
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 2);
  const notifiable = await pendingNotifications(fixture.companyId);
  assert.equal(notifiable.length, 1);
  assert.equal(notifiable[0]!.kind, 'incident');

  // And it carries what a channel may do with it. Two rules answer different
  // questions — `notify_after` says when the owner may be shown this, F10.9
  // and F10.10 say what they may press — and a caller that had to ask the
  // second one separately is a caller that will eventually not.
  assert.equal(notifiable[0]!.delivery, 'link_only');
});

test('schedules survive a restart and fire exactly once (F9.1)', async () => {
  const fixture = await createCompany('schedule');
  const past = new Date(Date.now() - 3 * 3_600_000);

  await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug: 'hourly-digest',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      input: { kind: 'digest' },
      reserveTokens: 1000,
    },
    past,
  );

  // Nothing in memory holds this schedule: the next occurrence is a column, so
  // a process that never saw the schedule created still fires it.
  const fired = await runDueSchedules(new Date());
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.slug, 'hourly-digest');

  const task = await withTenant(fixture.companyId, (tx) => getTask(tx, fired[0]!.taskId));
  assert.ok(task);
  assert.deepEqual(task!.input, { kind: 'digest' });
  assert.equal(task!.status, 'pending');

  // A second sweep at the same instant must not fire the same occurrence again.
  const again = await runDueSchedules(new Date());
  assert.equal(again.length, 0, 'an occurrence fires exactly once');

  const taskCount = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tasks',
    );
    return Number(rows[0]!.count);
  });
  assert.equal(taskCount, 1, 'three hours of backlog collapse into one catch-up run');

  // The collapse is reported, not silent: an hourly schedule that was down for
  // three hours owes two occurrences it will never run, and the log says so.
  const fireEvent = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { skippedOccurrences: number; nextRunAt: string } }>(
      "SELECT payload FROM events WHERE type = 'schedule.fired'",
    );
    return rows[0]!.payload;
  });
  assert.ok(fireEvent.skippedOccurrences >= 1, 'the dropped occurrences are counted');
  assert.ok(new Date(fireEvent.nextRunAt) > new Date(), 'the schedule jumps to a future occurrence');
});

test('a frozen company fires no schedules (F1.4)', async () => {
  const fixture = await createCompany('schedule-frozen');
  await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug: 'nightly',
      cronExpression: '0 * * * *',
    },
    new Date(Date.now() - 3_600_000),
  );

  await freezeCompany(fixture.companyId);
  const fired = await runDueSchedules(new Date());
  assert.equal(fired.length, 0, 'a freeze must not manufacture cancelled tasks either');
});

test('cron expressions are evaluated in the schedule zone', () => {
  // 08:00 on a weekday in Jakarta is 01:00 UTC. Getting this wrong by
  // evaluating in UTC would send the morning digest in the middle of the night.
  const saturdayNoonUtc = new Date('2026-09-05T12:00:00Z');
  const next = nextOccurrence('0 8 * * 1-5', JAKARTA, saturdayNoonUtc);
  assert.equal(next.toISOString(), '2026-09-07T01:00:00.000Z');
  assert.equal(localTimeIn(JAKARTA, next).hour, 8);
});

// ---------------------------------------------------------------------------
// F9.5 -- non-urgent read-only work waits for cheap hours
// ---------------------------------------------------------------------------

/**
 * A window relative to the hour it is now, in UTC.
 *
 * Offset 0 produces a window that is open at this moment; any other offset
 * produces one that is shut. Built from the current hour rather than fixed
 * hours so the tests do not pass or fail depending on what time the suite runs.
 */
function windowAround(offsetHours: number): {
  timezone: string;
  startHour: number;
  endHour: number;
} {
  const startHour = (new Date().getUTCHours() + offsetHours + 24) % 24;
  return { timezone: 'UTC', startHour, endHour: (startHour + 1) % 24 };
}

function batchEngine(ran: string[]) {
  return new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([
      ['worker', async (ctx) => {
        ran.push(ctx.task.id);
        return { done: true };
      }],
    ]),
  });
}

async function batchableTask(fixture: Fixture, goal: string) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal },
    createdBy: 'owner',
    reserveTokens: 5_000,
    batchable: true,
  });
}

test('non-urgent work waits for cheap hours instead of running now (F9.5)', async () => {
  const fixture = await createCompany('batch-defer');
  await setBatchWindow({ companyId: fixture.companyId, ...windowAround(3) });

  const ran: string[] = [];
  const task = await batchableTask(fixture, 'nightly summary');
  const outcome = await batchEngine(ran).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'waiting_window');
  assert.ok(outcome.waitUntil instanceof Date, 'the task knows when to come back');
  assert.ok(outcome.waitUntil.getTime() > Date.now());
  assert.deepEqual(ran, [], 'the handler is not run');

  const parked = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(parked!.status, 'waiting_window');
});

test('cheap hours run the work immediately', async () => {
  const fixture = await createCompany('batch-open');
  await setBatchWindow({ companyId: fixture.companyId, ...windowAround(0) });

  const ran: string[] = [];
  const task = await batchableTask(fixture, 'nightly summary');
  const outcome = await batchEngine(ran).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(ran, [task.id]);
});

test('a company with no cheap hours does not wait for a discount that does not exist', async () => {
  // The absence of a window means "there are no cheap hours here", not "any
  // hour will do". Reading it the other way would park every batchable task
  // for ever in the ordinary case of a company that never configured one.
  const fixture = await createCompany('batch-no-window');

  const ran: string[] = [];
  const task = await batchableTask(fixture, 'nightly summary');
  const outcome = await batchEngine(ran).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(ran, [task.id]);
});

test('urgent work ignores the window entirely', async () => {
  const fixture = await createCompany('batch-urgent');
  await setBatchWindow({ companyId: fixture.companyId, ...windowAround(3) });

  const ran: string[] = [];
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: 'a customer is waiting' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
  const outcome = await batchEngine(ran).runTask(fixture.companyId, task.id, 'worker');

  assert.equal(outcome.status, 'completed', 'deferral is opt-in, not the default');
  assert.deepEqual(ran, [task.id]);
});

test('work that can write is never deferred (F9.5 restricts batching to tier 0)', async () => {
  // The tier is read from the registry rather than taken from the request. A
  // caller that could declare its own work read-only could park a production
  // deploy until 02:00, by which time the world it was going to write to has
  // moved.
  const fixture = await createCompany('batch-tier');
  const registry = new CapabilityRegistry();
  const capability: Capability<{ record: string }, { ok: boolean }> = {
    name: 'dns.update',
    adapter: 'test:dns',
    defaultTier: 1,
    execute: async () => ({ ok: true }),
    verify: async () => true,
  };
  registry.register(capability);
  await registry.sync();

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query('UPDATE roles SET tools = $2 WHERE id = $1', [
      fixture.roleId,
      ['dns.update'],
    ]);
  });

  await assert.rejects(
    () => batchableTask(fixture, 'nightly deploy'),
    (error: unknown) => {
      assert.ok(isPalugadaError(error, 'batch.not_eligible'));
      assert.match(error.message, /dns\.update/, 'the message names what disqualified it');
      return true;
    },
  );
});

test('a parked task is picked up once the window opens, and finishes', async () => {
  // Parking is only useful if something wakes it. F9.2 already has the sweep;
  // this checks that batched work joins the same queue rather than needing a
  // second mechanism nobody runs.
  const fixture = await createCompany('batch-wake');
  await setBatchWindow({ companyId: fixture.companyId, ...windowAround(3) });

  const ran: string[] = [];
  const engine = batchEngine(ran);
  const task = await batchableTask(fixture, 'nightly summary');
  await engine.runTask(fixture.companyId, task.id, 'worker');

  const notYet = await claimReadyWindowTasks(fixture.companyId, new Date());
  assert.deepEqual(notYet, [], 'nothing is claimed before the window opens');

  const laterOn = new Date(Date.now() + 4 * 3_600_000);
  const ready = await claimReadyWindowTasks(fixture.companyId, laterOn);
  assert.deepEqual(ready.map((row) => row.id), [task.id]);

  // Once the hours are cheap the same task runs to completion.
  await setBatchWindow({ companyId: fixture.companyId, ...windowAround(0) });
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(ran, [task.id]);
});

test('a schedule can mark the work it creates as non-urgent', async () => {
  // A recurring job is where most non-urgent work comes from: a nightly digest
  // has no reason to run at the most expensive minute of the day.
  const fixture = await createCompany('batch-schedule');
  await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug: 'nightly-digest',
      cronExpression: '0 * * * *',
      batchable: true,
    },
    new Date(Date.now() - 3_600_000),
  );

  const fired = await runDueSchedules(new Date());
  assert.equal(fired.length, 1);
  const created = await withTenant(fixture.companyId, (tx) => getTask(tx, fired[0]!.taskId));
  assert.equal(created!.batchable, true, 'the flag travels from the schedule to the task');
});

/**
 * A schedule created without an account gets the division's, not the company's.
 *
 * `schedules.budget_account_id` is NOT NULL, so the account is chosen once when
 * the schedule is written and then held. That is deliberate -- resolving it at
 * every firing would silently move a schedule to a different ceiling the day
 * somebody adds one -- but it means the choice made here is the one that lasts,
 * and defaulting it to the company account would put every recurring job in the
 * company outside its division's ceiling. Recurring work is most of what a
 * company does, so that is most of F1.6.
 */
test('a schedule draws on its division\'s account when it names none (F1.6, F9.1)', async () => {
  const fixture = await createCompany('schedule-budget', { tokensMax: 100_000 });
  const divisionAccount = await withTenant(fixture.companyId, (tx) =>
    budget.createAccount(tx, {
      companyId: fixture.companyId,
      label: 'ops',
      tokensMax: 20_000,
      scope: {
        scopeType: 'division',
        scopeId: fixture.divisionId,
        parentAccountId: fixture.budgetAccountId,
      },
    }),
  );

  // No budgetAccountId given.
  await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      goalId: fixture.goalId,
      slug: 'division-funded',
      cronExpression: '0 * * * *',
    },
    new Date(Date.now() - 3_600_000),
  );

  const stored = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ budget_account_id: string }>(
      "SELECT budget_account_id FROM schedules WHERE slug = 'division-funded'",
    );
    return rows[0]!.budget_account_id;
  });
  assert.equal(stored, divisionAccount, 'not the company account');

  // And the task it fires draws on it, which is the part that spends money.
  const fired = await runDueSchedules(new Date());
  assert.equal(fired.length, 1);
  const created = await withTenant(fixture.companyId, (tx) => getTask(tx, fired[0]!.taskId));
  assert.equal(created!.budgetAccountId, divisionAccount);
});
