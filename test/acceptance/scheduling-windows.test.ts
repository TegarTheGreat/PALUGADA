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
  setOwnerWindow,
} from '../../src/scheduler/windows.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { claimReadyWindowTasks, createRootTask, getTask } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { freezeCompany } from '../../src/engine/control.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
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
    input: {},
    createdBy: 'owner',
    reserveTokens: 10_000,
  });

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
