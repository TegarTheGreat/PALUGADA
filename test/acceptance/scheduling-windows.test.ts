/**
 * PRD F9.1, F9.2, F9.3, F9.6 -- durable scheduling and time windows.
 *
 * F9.6 is the frame for all of it: agents have no working hours. What is
 * restricted is when an action may touch the outside world, and when the owner
 * may be disturbed. Those are separate windows with separate reasons.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
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
import { givePlaceBack, takePlace } from '../../src/broker/in-flight.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { claimTask, releaseTask } from '../../src/engine/checkout.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import * as budget from '../../src/engine/budget.ts';
import { freezeCompany } from '../../src/engine/control.ts';
import { isPalugadaError, PalugadaError } from '../../src/errors.ts';
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

  // Nothing is claimable yet, so a worker looking for work finds none.
  assert.equal(await claimTask(fixture.companyId, { holder: 'w1' }), null);

  // Once the wake-up time passes, the task is picked up again rather than
  // sitting there for ever. Asserted through the claim -- the thing a worker
  // actually does -- rather than through a query written for this test: the
  // reason the task sat there for ever was that nothing claimed it, and a read
  // that returned the row proved nothing about that.
  const ready = await claimTask(
    fixture.companyId, { holder: 'w1', now: new Date(Date.now() + 8 * 86_400_000) },
  );
  assert.equal(ready?.taskId, task.id);
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
// F9.1, F9.2 -- daylight saving changes
//
// Every instant below is fixed, so none of this depends on the day it runs.
// The changes used, all in 2026:
//
//   America/New_York     forward 03-08 07:00Z (02:00 EST -> 03:00 EDT)
//                        back    11-01 06:00Z (02:00 EDT -> 01:00 EST)
//   Europe/London        forward 03-29 01:00Z, back 10-25 01:00Z
//   Australia/Sydney     back    04-04 16:00Z (03:00 -> 02:00 on 04-05)
//                        forward 10-03 16:00Z (02:00 -> 03:00 on 10-04)
//   America/Santiago     back    04-05 03:00Z (00:00 -> 23:00 on 04-04)
//                        forward 09-06 04:00Z (00:00 -> 01:00 on 09-06)
//   Australia/Lord_Howe  back    04-04 15:00Z (02:00 -> 01:30 on 04-05)
//                        forward 10-03 15:30Z (02:00 -> 02:30 on 10-04)
//   Australia/Adelaide   forward 10-03 16:30Z (02:00 -> 03:00 on 10-04)
// ---------------------------------------------------------------------------

const NEW_YORK = 'America/New_York';
const LORD_HOWE = 'Australia/Lord_Howe';

/** A schedule's runs from `from`, each found from the one before, as the scheduler finds them. */
function runsFrom(cron: string, zone: string, from: string, count: number): string[] {
  const runs: string[] = [];
  let after = new Date(from);
  for (let index = 0; index < count; index += 1) {
    after = nextOccurrence(cron, zone, after);
    runs.push(after.toISOString());
  }
  return runs;
}

const iso = (instant: string) => new Date(instant).toISOString();

test('a daily time in the hour the clock repeats runs once, on its first pass (F9.1)', () => {
  // [cron, zone, the day before, the first pass, inside the second pass, the next day]
  const cases = [
    ['30 1 * * *', NEW_YORK, '2026-10-31T12:00Z', '2026-11-01T05:30Z', '2026-11-01T06:05Z', '2026-11-02T06:30Z'],
    ['30 1 * * *', 'Europe/London', '2026-10-24T12:00Z', '2026-10-25T00:30Z', '2026-10-25T01:05Z', '2026-10-26T01:30Z'],
    ['30 2 * * *', 'Australia/Sydney', '2026-04-04T00:00Z', '2026-04-04T15:30Z', '2026-04-04T16:05Z', '2026-04-05T16:30Z'],
    ['30 23 * * *', 'America/Santiago', '2026-04-04T12:00Z', '2026-04-05T02:30Z', '2026-04-05T03:05Z', '2026-04-06T03:30Z'],
    // Lord Howe goes back half an hour, so only 01:30 to 02:00 repeats.
    ['45 1 * * *', LORD_HOWE, '2026-04-04T00:00Z', '2026-04-04T14:45Z', '2026-04-04T15:05Z', '2026-04-05T15:15Z'],
  ] as const;
  for (const [cron, zone, dayBefore, firstPass, secondPass, nextDay] of cases) {
    assert.deepEqual(runsFrom(cron, zone, dayBefore, 2), [iso(firstPass), iso(nextDay)], zone);
    // Asked from inside the second pass -- a pass that fired the first one
    // late, a schedule saved then -- the answer is the next day. It was the
    // same wall-clock time again, and the job ran twice that night.
    assert.equal(nextOccurrence(cron, zone, new Date(secondPass)).toISOString(), iso(nextDay), zone);
  }
  for (const from of ['2026-11-01T05:30:00Z', '2026-11-01T06:00:00Z', '2026-11-01T06:29:59Z']) {
    assert.equal(nextOccurrence('30 1 * * *', NEW_YORK, new Date(from)).toISOString(), iso('2026-11-02T06:30Z'), from);
  }
});

test('a daily time in the hour the clock skips runs once, when the clock jumps (F9.1)', () => {
  // [cron, zone, the day before, the jump, the next day]
  const cases = [
    ['30 2 * * *', NEW_YORK, '2026-03-07T12:00Z', '2026-03-08T07:00Z', '2026-03-09T06:30Z'],
    ['30 1 * * *', 'Europe/London', '2026-03-28T12:00Z', '2026-03-29T01:00Z', '2026-03-30T00:30Z'],
    ['30 2 * * *', 'Australia/Sydney', '2026-10-03T00:00Z', '2026-10-03T16:00Z', '2026-10-04T15:30Z'],
    // Santiago skips the first hour of the day, which cron-parser dropped
    // even when asked days ahead.
    ['30 0 * * *', 'America/Santiago', '2026-09-05T12:00Z', '2026-09-06T04:00Z', '2026-09-07T03:30Z'],
    ['15 2 * * *', LORD_HOWE, '2026-10-03T00:00Z', '2026-10-03T15:30Z', '2026-10-04T15:15Z'],
  ] as const;
  for (const [cron, zone, dayBefore, jump, nextDay] of cases) {
    assert.deepEqual(runsFrom(cron, zone, dayBefore, 2), [iso(jump), iso(nextDay)], zone);
  }
  // Asked a minute before the jump it is still that day's run; asked at the
  // jump it has happened.
  assert.equal(nextOccurrence('30 2 * * *', NEW_YORK, new Date('2026-03-08T06:59:00Z')).toISOString(), iso('2026-03-08T07:00Z'));
  assert.equal(nextOccurrence('30 2 * * *', NEW_YORK, new Date('2026-03-08T07:00:00Z')).toISOString(), iso('2026-03-09T06:30Z'));

  // Every time the clock skips is one run at the jump, and the day's runs
  // keep their order: 02:15 and 02:45 run at 03:00, before 03:15.
  assert.deepEqual(runsFrom('0,30 2 * * *', NEW_YORK, '2026-03-08T06:30Z', 2), [iso('2026-03-08T07:00Z'), iso('2026-03-09T06:00Z')]);
  assert.deepEqual(
    runsFrom('15,45 2,3 * * *', NEW_YORK, '2026-03-08T06:30Z', 4),
    [iso('2026-03-08T07:00Z'), iso('2026-03-08T07:15Z'), iso('2026-03-08T07:45Z'), iso('2026-03-09T06:15Z')],
  );
});

test('a schedule that runs every hour keeps to real time through both changes (F9.1)', () => {
  // 01:00 is shown twice on the night New York goes back, an hour apart,
  // and an hourly job runs at both: every hour is every hour.
  const hourly = ['2026-11-01T05:00Z', '2026-11-01T06:00Z', '2026-11-01T07:00Z', '2026-11-01T08:00Z'].map(iso);
  assert.deepEqual(runsFrom('0 * * * *', NEW_YORK, '2026-11-01T04:30Z', 4), hourly);
  assert.deepEqual(runsFrom('0 0-23 * * *', NEW_YORK, '2026-11-01T04:30Z', 4), hourly, 'a range of all 24 hours is every hour');
  assert.deepEqual(runsFrom('0 */1 * * *', NEW_YORK, '2026-11-01T04:30Z', 4), hourly, 'so is a step of one');
  assert.equal(nextOccurrence('0 * * * *', NEW_YORK, new Date('2026-11-01T05:30Z')).toISOString(), iso('2026-11-01T06:00Z'));
  assert.deepEqual(
    runsFrom('*/20 * * * *', NEW_YORK, '2026-11-01T05:30Z', 5),
    ['2026-11-01T05:40Z', '2026-11-01T06:00Z', '2026-11-01T06:20Z', '2026-11-01T06:40Z', '2026-11-01T07:00Z'].map(iso),
  );
  // Going forward, 01:30 EST and 03:30 EDT are an hour apart.
  assert.deepEqual(runsFrom('30 * * * *', NEW_YORK, '2026-03-08T06:00Z', 2), [iso('2026-03-08T06:30Z'), iso('2026-03-08T07:30Z')]);
  // Lord Howe repeats half an hour: every quarter of an hour is still fifteen
  // minutes apart through it.
  assert.deepEqual(
    runsFrom('*/15 * * * *', LORD_HOWE, '2026-04-04T14:40Z', 4),
    ['2026-04-04T14:45Z', '2026-04-04T15:00Z', '2026-04-04T15:15Z', '2026-04-04T15:30Z'].map(iso),
  );
});

test('a zone without daylight saving is unaffected (F9.1)', () => {
  assert.deepEqual(
    runsFrom('30 1 * * *', JAKARTA, '2026-11-01T00:00Z', 3),
    ['2026-11-01T18:30Z', '2026-11-02T18:30Z', '2026-11-03T18:30Z'].map(iso),
  );
  assert.deepEqual(
    runsFrom('30 2 * * *', JAKARTA, '2026-03-07T12:00Z', 2),
    ['2026-03-07T19:30Z', '2026-03-08T19:30Z'].map(iso),
  );
});

/**
 * The defect in one sentence: the next run depended on where the search
 * began. cron-parser, asked from inside a repeated hour, found a time it had
 * already given; asked from just after a jump, lost the day. So for every
 * change above and a spread of schedules, the next run asked from anywhere
 * in the three hours either side of the change, and from a second either
 * side of every run, is the run the schedule's own sequence says; and a
 * schedule with fixed hours never runs twice at one wall-clock reading.
 */
test('where the search starts never changes the next run (F9.1)', () => {
  const changes: Array<[string, string]> = [
    [NEW_YORK, '2026-03-08T07:00Z'], [NEW_YORK, '2026-11-01T06:00Z'],
    ['Europe/London', '2026-03-29T01:00Z'], ['Europe/London', '2026-10-25T01:00Z'],
    ['Australia/Sydney', '2026-04-04T16:00Z'], ['Australia/Sydney', '2026-10-03T16:00Z'],
    ['America/Santiago', '2026-04-05T03:00Z'], ['America/Santiago', '2026-09-06T04:00Z'],
    [LORD_HOWE, '2026-04-04T15:00Z'], [LORD_HOWE, '2026-10-03T15:30Z'],
    [JAKARTA, '2026-11-01T00:00Z'],
  ];
  const crons = [
    '30 1 * * *', '30 2 * * *', '15 2 * * *', '45 1 * * *', '30 23 * * *', '30 0 * * *',
    '15,45 2,3 * * *', '0 * * * *',
  ];
  const wallClock = (zone: string) => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
  });
  for (const [zone, change] of changes) {
    const shown = wallClock(zone);
    const middle = new Date(change).getTime();
    for (const cron of crons) {
      const runs: number[] = [];
      for (let after = new Date(middle - 86_400_000); after.getTime() < middle + 86_400_000;) {
        after = nextOccurrence(cron, zone, after);
        runs.push(after.getTime());
      }
      if (!cron.split(' ')[1]!.includes('*')) {
        const readings = runs.map((run) => shown.format(run));
        assert.equal(new Set(readings).size, readings.length, `${cron} in ${zone} ran twice at one reading: ${readings.join(', ')}`);
      }
      // Every twenty minutes near the change, five past so that some fall
      // just inside a repeated stretch, and a second either side of the
      // change and of each run there.
      const near = (instant: number) => Math.abs(instant - middle) <= 3 * 3_600_000;
      const starts: number[] = [middle - 1000, middle, middle + 1000];
      for (let start = middle - 3 * 3_600_000 + 300_000; start <= middle + 3 * 3_600_000; start += 1_200_000) starts.push(start);
      for (const run of runs.filter(near)) starts.push(run - 1000, run, run + 1000);
      for (const start of starts) {
        const expected = runs.find((run) => run > start);
        if (expected === undefined) continue;
        assert.equal(
          nextOccurrence(cron, zone, new Date(start)).toISOString(),
          new Date(expected).toISOString(),
          `${cron} in ${zone} asked from ${new Date(start).toISOString()}`,
        );
      }
    }
  }
});

test('a window opens on its own zone\'s hour where that is not an hour of UTC (F9.2)', () => {
  // The next opening was looked for on the hours of UTC, which in a zone
  // half an hour or three quarters off UTC are never the hour a window opens:
  // a window from 09:00 in Kolkata opened at 09:30.
  const mondayMidnightUtc = new Date('2026-09-07T00:00:00Z');
  const kolkata = { timezone: 'Asia/Kolkata', startHour: 9, endHour: 17, daysOfWeek: [1, 2, 3, 4, 5] };
  assert.equal(nextOpening(kolkata, mondayMidnightUtc)?.toISOString(), iso('2026-09-07T03:30Z'));
  const kathmandu = { timezone: 'Asia/Kathmandu', startHour: 9, endHour: 17, daysOfWeek: [1, 2, 3, 4, 5] };
  assert.equal(nextOpening(kathmandu, mondayMidnightUtc)?.toISOString(), iso('2026-09-07T03:15Z'));
  // Lord Howe is half an hour off in winter only.
  const lordHowe = { timezone: LORD_HOWE, startHour: 2, endHour: 5, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(nextOpening(lordHowe, new Date('2026-07-01T12:00:00Z'))?.toISOString(), iso('2026-07-01T15:30Z'));
});

test('a window on the night the clock goes back is open while the clock shows its hours (F9.2)', () => {
  const small = { timezone: NEW_YORK, startHour: 1, endHour: 3, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(nextOpening(small, new Date('2026-11-01T04:10:00Z'))?.toISOString(), iso('2026-11-01T05:00Z'));
  // 01:30 EDT, 01:30 EST, 02:30 EST: the clock shows 01:00 to 03:00 for
  // three hours that night, and the window is open for all three.
  for (const open of ['2026-11-01T05:30Z', '2026-11-01T06:30Z', '2026-11-01T07:30Z', '2026-11-01T07:59Z']) {
    assert.equal(isWithin(small, new Date(open)), true, open);
  }
  assert.equal(isWithin(small, new Date('2026-11-01T08:00:00Z')), false, 'shut at 03:00 EST');
  assert.equal(nextOpening(small, new Date('2026-11-01T08:00:00Z'))?.toISOString(), iso('2026-11-02T06:00Z'));
});

test('a window whose start the clock skips opens when the clock jumps (F9.2)', () => {
  const early = { timezone: NEW_YORK, startHour: 2, endHour: 5, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(isWithin(early, new Date('2026-03-08T06:59:00Z')), false, '01:59 EST');
  assert.equal(nextOpening(early, new Date('2026-03-08T06:10:00Z'))?.toISOString(), iso('2026-03-08T07:00Z'));
  assert.equal(isWithin(early, new Date('2026-03-08T08:59:00Z')), true, '04:59 EDT');
  assert.equal(isWithin(early, new Date('2026-03-08T09:00:00Z')), false, '05:00 EDT');

  // Lord Howe jumps half an hour, from 02:00 to 02:30, which is when a
  // window from 02:00 opens; looking on the hours of UTC found 03:00.
  const lordHowe = { timezone: LORD_HOWE, startHour: 2, endHour: 5, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(nextOpening(lordHowe, new Date('2026-10-03T14:00:00Z'))?.toISOString(), iso('2026-10-03T15:30Z'));

  // A window made only of the hour the clock skips is not open that day:
  // the clock never shows one of its hours.
  const skipped = { timezone: NEW_YORK, startHour: 2, endHour: 3, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(nextOpening(skipped, new Date('2026-03-08T06:10:00Z'))?.toISOString(), iso('2026-03-09T06:00Z'));
});

test('a window that wraps midnight holds across a change (F9.2)', () => {
  // Saturday nights in London: the night the clock goes back is an hour
  // longer, the night it goes forward an hour shorter, and both belong to the
  // Saturday that opened them.
  const saturdayNights = { timezone: 'Europe/London', startHour: 22, endHour: 6, daysOfWeek: [6] };
  assert.equal(nextOpening(saturdayNights, new Date('2026-10-24T12:00:00Z'))?.toISOString(), iso('2026-10-24T21:00Z'));
  for (const open of ['2026-10-25T00:30Z', '2026-10-25T01:30Z', '2026-10-25T05:59Z']) {
    assert.equal(isWithin(saturdayNights, new Date(open)), true, open);
  }
  assert.equal(isWithin(saturdayNights, new Date('2026-10-25T06:00:00Z')), false, '06:00 GMT');
  assert.equal(isWithin(saturdayNights, new Date('2026-03-29T04:59:00Z')), true, '05:59 BST');
  assert.equal(isWithin(saturdayNights, new Date('2026-03-29T05:00:00Z')), false, '06:00 BST');

  // Adelaide is half an hour off UTC and goes forward in the small hours of
  // a Sunday: the window opens at 22:00 ACST, not half an hour later, and
  // stays open through the jump to 06:00 ACDT.
  const adelaide = { timezone: 'Australia/Adelaide', startHour: 22, endHour: 6, daysOfWeek: [6] };
  assert.equal(nextOpening(adelaide, new Date('2026-10-03T12:00:00Z'))?.toISOString(), iso('2026-10-03T12:30Z'));
  assert.equal(isWithin(adelaide, new Date('2026-10-03T16:30:00Z')), true, '03:00 ACDT');
  assert.equal(isWithin(adelaide, new Date('2026-10-03T19:29:00Z')), true, '05:59 ACDT');
  assert.equal(isWithin(adelaide, new Date('2026-10-03T19:30:00Z')), false, '06:00 ACDT');
});

async function dailySchedule(fixture: Fixture, slug: string, cronExpression: string, savedAt: string) {
  return upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug,
      cronExpression,
      timezone: NEW_YORK,
      input: { kind: slug },
      reserveTokens: 100,
    },
    new Date(savedAt),
  );
}

async function scheduleState(fixture: Fixture, scheduleId: string) {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows: [schedule] } = await tx.query<{ next_run_at: Date }>(
      'SELECT next_run_at FROM schedules WHERE id = $1', [scheduleId],
    );
    const { rows: [tasks] } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tasks WHERE schedule_id = $1', [scheduleId],
    );
    const { rows: fired } = await tx.query<{ payload: { occurrence: string; nextRunAt: string; skippedOccurrences: number } }>(
      `SELECT payload FROM events
        WHERE type = 'schedule.fired' AND payload->>'scheduleId' = $1
        ORDER BY occurred_at`,
      [scheduleId],
    );
    return {
      nextRunAt: schedule!.next_run_at.toISOString(),
      tasks: Number(tasks!.count),
      fired: fired.map((row) => row.payload),
    };
  });
}

test('a daily run in the hour the clock repeats fires once, even from a pass that runs late (F9.1)', async () => {
  const fixture = await createCompany('schedule-falls-back');
  const scheduleId = await dailySchedule(fixture, 'nightly-ledger', '30 1 * * *', '2026-10-31T12:00:00Z');
  assert.equal((await scheduleState(fixture, scheduleId)).nextRunAt, iso('2026-11-01T05:30Z'), '01:30 EDT');

  // The pass that fires 01:30 EDT runs at 01:05 EST, inside the hour the
  // clock repeats. It worked out the next run from there, found 01:30 EST,
  // and the passes at 01:30 EST fired the same night's work a second time.
  const fired = await runDueSchedules(new Date('2026-11-01T06:05:00Z'));
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.occurrence.toISOString(), iso('2026-11-01T05:30Z'));
  for (const pass of ['2026-11-01T06:30:00Z', '2026-11-01T06:31:00Z']) {
    assert.equal((await runDueSchedules(new Date(pass))).length, 0, pass);
  }
  const state = await scheduleState(fixture, scheduleId);
  assert.equal(state.tasks, 1, 'one task for the night');
  assert.equal(state.nextRunAt, iso('2026-11-02T06:30Z'));
  assert.deepEqual(state.fired, [{
    ...state.fired[0]!, occurrence: iso('2026-11-01T05:30Z'), nextRunAt: iso('2026-11-02T06:30Z'), skippedOccurrences: 0,
  }]);

  // Saved again inside the repeated hour, it does not owe 01:30 again either.
  await dailySchedule(fixture, 'nightly-ledger', '30 1 * * *', '2026-11-01T06:10:00Z');
  assert.equal((await scheduleState(fixture, scheduleId)).nextRunAt, iso('2026-11-02T06:30Z'));
});

test('a daily run in the hour the clock skips fires once, when the clock jumps (F9.1)', async () => {
  const fixture = await createCompany('schedule-springs-forward');
  const scheduleId = await dailySchedule(fixture, 'nightly-ledger', '30 2 * * *', '2026-03-07T12:00:00Z');
  assert.equal((await scheduleState(fixture, scheduleId)).nextRunAt, iso('2026-03-08T07:00Z'), '03:00 EDT, the jump');

  assert.equal((await runDueSchedules(new Date('2026-03-08T06:59:00Z'))).length, 0, '01:59 EST');
  assert.equal((await runDueSchedules(new Date('2026-03-08T07:00:00Z'))).length, 1, '03:00 EDT');
  for (const pass of ['2026-03-08T07:30:00Z', '2026-03-08T07:31:00Z']) {
    assert.equal((await runDueSchedules(new Date(pass))).length, 0, pass);
  }
  const state = await scheduleState(fixture, scheduleId);
  assert.equal(state.tasks, 1, 'one task for the day');
  assert.equal(state.nextRunAt, iso('2026-03-09T06:30Z'));
});

test('a pass that runs late across a change counts the run it folded in (F9.1)', async () => {
  // Each schedule's last run was the day before a change, and the pass that
  // fires it runs a day late, after that day's run. The one catch-up task is
  // made and that day's run is counted as skipped. Across the jump, cron-
  // parser put that day's run half an hour after the late pass and then lost
  // it: neither run nor counted.
  const fixture = await createCompany('schedule-late-pass');
  const forward = await dailySchedule(fixture, 'before-forward', '30 2 * * *', '2026-03-06T12:00:00Z');
  const back = await dailySchedule(fixture, 'before-back', '30 1 * * *', '2026-10-30T12:00:00Z');

  assert.equal((await runDueSchedules(new Date('2026-03-08T07:10:00Z'))).length, 1);
  const forwardState = await scheduleState(fixture, forward);
  assert.equal(forwardState.tasks, 1);
  assert.equal(forwardState.fired[0]!.occurrence, iso('2026-03-07T07:30Z'));
  assert.equal(forwardState.fired[0]!.skippedOccurrences, 1, 'the run at the jump, 07:00Z, was folded in');
  assert.equal(forwardState.nextRunAt, iso('2026-03-09T06:30Z'));

  const late = await runDueSchedules(new Date('2026-11-01T06:05:00Z'));
  assert.equal(late.filter((one) => one.scheduleId === back).length, 1);
  const backState = await scheduleState(fixture, back);
  assert.equal(backState.tasks, 1);
  assert.equal(backState.fired[0]!.occurrence, iso('2026-10-31T05:30Z'));
  assert.equal(backState.fired[0]!.skippedOccurrences, 1, '01:30 EDT on 11-01 was folded in, and once');
  assert.equal(backState.nextRunAt, iso('2026-11-02T06:30Z'));
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

  assert.equal(
    await claimTask(fixture.companyId, { holder: 'w1' }), null,
    'the task was claimed before the window opened',
  );

  // Claimed as the engine's own worker, which is what happens in a tick: the
  // claim and the run are the same worker, so the lease it just took is its
  // own rather than somebody else's to refuse.
  const laterOn = new Date(Date.now() + 4 * 3_600_000);
  const ready = await claimTask(
    fixture.companyId, { holder: engine.workerId, now: laterOn },
  );
  assert.equal(ready?.taskId, task.id);

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

/**
 * A task parked for cheap hours is claimed when they arrive.
 *
 * This was the requirement's whole point and nothing did it. The engine parked
 * the task, `claimTask` looked only at `pending`, and there it stayed --
 * *forever*, for every batchable task, which is most non-urgent work. The
 * index built for the drain, `tasks_waiting_window_ready`, had never been used
 * by anything: `claimReadyWindowTasks` existed and no production code called
 * it.
 *
 * So the check is not "the query returns the row" -- that passed all along.
 * It is that a worker claims it and the handler runs.
 */
test('a task whose window has opened is claimed and run (F9.6)', async () => {
  const fixture = await createCompany('batch-drain');
  // A window that is closed now, so the task parks with a `wait_until`.
  await setBatchWindow({ companyId: fixture.companyId, ...windowAround(3) });

  const ran: string[] = [];
  const engine = batchEngine(ran);
  const task = await batchableTask(fixture, 'nightly summary');

  const parked = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(parked.status, 'waiting_window');
  assert.ok(parked.waitUntil instanceof Date, 'the task does not know when to come back');
  assert.deepEqual(ran, []);

  // Nothing claimable while the window is shut, which is the other half: a
  // claim that ignored `wait_until` would run the work at the expensive hour
  // the parking existed to avoid.
  assert.equal(
    await claimTask(fixture.companyId, { holder: 'w1' }), null,
    'the task was claimed before its window opened',
  );

  // The window opens. The claim is the ordinary one -- same lane rule, same
  // budget rule, same priority order -- because widening it was the fix rather
  // than adding a second, weaker path.
  const opensAt = new Date(parked.waitUntil.getTime() + 60_000);

  const claim = await claimTask(fixture.companyId, { holder: 'w1', now: opensAt });
  assert.ok(claim, 'the task was not claimable once its window opened');
  assert.equal(claim.taskId, task.id);

  // And it is checked out, which is the transition that had to be allowed for
  // any of this to work: a parked task resumes through the ordinary claim
  // rather than through a path of its own.
  const claimed = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(claimed!.status, 'checked_out');

  // Given back, so the row is left the way the test found it. What happens
  // *after* the claim -- the handler running once the hours are actually
  // cheap -- is what "cheap hours run the work immediately" above covers.
  assert.equal(await releaseTask(fixture.companyId, task.id, 'w1'), true);
  assert.deepEqual(ran, [], 'the claim itself must not run anything');
});

/**
 * A window that never opens parks the task, and does not spin.
 *
 * The engine parks with a null `wait_until` when the window it is waiting for
 * has no next opening -- a misconfiguration, but one the platform has to
 * survive. Widening the claim to `waiting_window` made that row claimable
 * immediately and repeatedly: claim, run, re-park, claim, up to the tick's
 * whole budget, paying for an agent run each time round, with `madeProgress`
 * suppressing the sleep because runs kept happening.
 *
 * A hot loop against the database and the model provider, produced by a fix
 * for something else. So a parked task with no wake-up time stays parked, and
 * a pending one with no `wait_until` -- the ordinary case -- stays claimable.
 */
test('a task parked with no wake-up time is not claimed in a loop (F9.6)', async () => {
  const fixture = await createCompany('batch-no-opening');
  const task = await batchableTask(fixture, 'never');

  // Parked the way the engine parks one whose window will not reopen.
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      "UPDATE tasks SET status = 'waiting_window', wait_until = NULL WHERE id = $1",
      [task.id],
    );
  });

  assert.equal(
    await claimTask(fixture.companyId, { holder: 'w1' }), null,
    'a task with no wake-up time was claimed, which is a loop',
  );
  assert.equal(
    await claimTask(fixture.companyId, { holder: 'w1', now: new Date(Date.now() + 86_400_000) }),
    null,
    'and it stays parked however long anyone waits',
  );

  // An ordinary pending task with no `wait_until` is still claimable, which is
  // most of them.
  const ordinary = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: 'ordinary' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
  const claim = await claimTask(fixture.companyId, { holder: 'w1' });
  assert.equal(claim?.taskId, ordinary.id);
});

/* ------------------------------------------------------- rate limits (F9.2) --- */

async function rateLimitedTask(fixture: Fixture) {
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { n: Math.random() },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'crm.read' }]);
  return task;
}

async function engineCalling(
  fixture: Fixture,
  capability: Capability<{ to: string }, { sent: boolean }>,
  options: { rateLimitPerHour?: number; maxInFlight?: number; inFlightWaitMs?: number } = {},
) {
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  const { inFlightWaitMs, ...grant } = options;
  await grantCapability(fixture, capability.name, grant);
  return new Engine({
    broker: new CapabilityBroker(registry, undefined, undefined, inFlightWaitMs === undefined ? {} : { inFlightWaitMs }),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability(capability.name, { to: 'client@example.test' });
      return {};
    }]]),
  });
}

function limitedVendor(waits: Array<number | null>) {
  const calls = { executions: 0 };
  const capability: Capability<{ to: string }, { sent: boolean }> = {
    name: 'crm.read',
    adapter: 'test:email',
    defaultTier: 0,
    async execute() {
      const wait = waits[calls.executions++];
      if (wait !== null && wait !== undefined) {
        throw new PalugadaError('capability.rate_limited', 'slow down', {
          capability: 'crm.read', status: 429, source: 'vendor',
          notBefore: new Date(Date.now() + wait).toISOString(),
        });
      }
      return { sent: true };
    },
    async verify() {
      return true;
    },
  };
  return { capability, calls };
}

async function attemptOf(fixture: Fixture, taskId: string): Promise<number> {
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, taskId));
  return stored!.attempt;
}

/**
 * `crm.read` stands in for any read a vendor meters -- Slack's history call
 * is the famous one.
 *
 * A 429 was a failure, so the engine retried on its next tick -- seconds
 * later, into a limit that had not lifted -- and three ticks spent the task.
 * Slack allows most apps one history call a minute; a platform that cannot
 * wait a minute cannot use it. Parked, the task spends nothing and resumes
 * when the vendor said it could.
 */
test('a vendor rate limit parks the task until it lifts, spending no attempt (F9.2)', async () => {
  const fixture = await createCompany('rate-limit-park');
  const { capability, calls } = limitedVendor([30_000, null]);
  const engine = await engineCalling(fixture, capability);
  const task = await rateLimitedTask(fixture);

  const before = Date.now();
  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.status, 'waiting_window', first.reason);
  assert.equal(first.reason, 'capability.rate_limited');
  const wait = first.waitUntil!.getTime() - before;
  assert.ok(wait >= 29_000 && wait <= 31_000, `parked for ${wait}ms, not the 30s the vendor asked`);
  assert.equal(await attemptOf(fixture, task.id), 0, 'waiting is not failing');

  // Not before the vendor's time, and then it is claimed and finishes.
  assert.equal(await claimTask(fixture.companyId, { holder: 'w1' }), null);
  // Claimed as the engine's own worker, which is what a tick does.
  const claim = await claimTask(fixture.companyId, {
    holder: engine.workerId, now: new Date(Date.now() + 31_000),
  });
  assert.equal(claim?.taskId, task.id);
  const second = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(second.status, 'completed', second.reason);
  assert.equal(calls.executions, 2);
});

/**
 * The vendor is the one naming the wait, so it is bounded twice: a wait
 * beyond a working day is a quota that has run out, and a limit that closes
 * again every time it lifts is a loop. Past either, the ordinary failure path
 * takes over and the owner hears about it the ordinary way.
 */
test('a rate limit that never lifts becomes a failure rather than a task parked for ever', async () => {
  const fixture = await createCompany('rate-limit-bound');
  const week = 7 * 24 * 60 * 60 * 1000;
  const { capability } = limitedVendor([week]);
  const engine = await engineCalling(fixture, capability);
  const task = await rateLimitedTask(fixture);

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.notEqual(outcome.status, 'waiting_window', 'a week is not a rate limit');
  assert.equal(await attemptOf(fixture, task.id), 1);

  // And a limit that keeps closing: parked five times, then counted.
  const looping = await createCompany('rate-limit-loop');
  const again = limitedVendor(Array.from({ length: 10 }, () => 10));
  const loopEngine = await engineCalling(looping, again.capability);
  const loopTask = await rateLimitedTask(looping);
  const statuses: string[] = [];
  for (let run = 0; run < 6; run += 1) {
    const result = await loopEngine.runTask(looping.companyId, loopTask.id, 'worker');
    statuses.push(result.status);
  }
  assert.deepEqual(statuses.slice(0, 5), Array(5).fill('waiting_window'));
  assert.notEqual(statuses[5], 'waiting_window');
  assert.equal(await attemptOf(looping, loopTask.id), 1);
});

/**
 * The division's own hourly allowance is the same case from the inside. It
 * refused with no time attached, so it too was retried into a full window
 * until the task failed; now it names the moment the oldest call in the hour
 * ages out, and the task waits for exactly that.
 */
test('a division over its hourly allowance waits for the next slot (F9.2)', async () => {
  const fixture = await createCompany('grant-rate-limit');
  const { capability, calls } = limitedVendor([null, null]);
  const engine = await engineCalling(fixture, capability, { rateLimitPerHour: 2 });

  const first = await rateLimitedTask(fixture);
  assert.equal((await engine.runTask(fixture.companyId, first.id, 'worker')).status, 'completed');
  // And one made fifty minutes ago, so the window is full and its two calls
  // age out at different times: the slot is the older one's, ten minutes off,
  // not the newer one's hour.
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO events (company_id, project_id, task_id, type, actor, payload, occurred_at)
     VALUES ($1, $2, $3, 'tool.called', 'broker', '{"capability":"crm.read"}'::jsonb,
             now() - interval '50 minutes')`,
    [fixture.companyId, fixture.projectId, first.id],
  ));

  const second = await rateLimitedTask(fixture);
  const before = Date.now();
  const outcome = await engine.runTask(fixture.companyId, second.id, 'worker');
  assert.equal(outcome.status, 'waiting_window', outcome.reason);
  const wait = outcome.waitUntil!.getTime() - before;
  assert.ok(wait > 9 * 60_000 && wait <= 10 * 60_000, `waits for the oldest call to age out, got ${wait}ms`);
  assert.equal(calls.executions, 1, 'the second call was never made');
  assert.equal(await attemptOf(fixture, second.id), 0);
});

/**
 * A vendor that takes one call at a time: each call is held until the test
 * lets it finish, and the most ever running at once is counted.
 */
function heldVendor() {
  const waiting: Array<() => void> = [];
  const state = { running: 0, most: 0, calls: 0 };
  const capability: Capability<{ to: string }, { sent: boolean }> = {
    name: 'crm.read',
    adapter: 'test:held',
    defaultTier: 0,
    async execute() {
      state.calls += 1;
      state.running += 1;
      state.most = Math.max(state.most, state.running);
      await new Promise<void>((resolve) => waiting.push(resolve));
      state.running -= 1;
      return { sent: true };
    },
    async verify() {
      return true;
    },
  };
  return {
    capability,
    state,
    async started(calls: number) {
      const until = Date.now() + 5_000;
      while (state.calls < calls) {
        if (Date.now() > until) throw new Error(`only ${state.calls} of ${calls} calls started`);
        await sleep(20);
      }
    },
    finish() {
      waiting.shift()?.();
    },
    finishAll() {
      while (waiting.length > 0) waiting.shift()!();
    },
  };
}

function callFor(fixture: Fixture, taskId: string, idempotencyKey: string) {
  return {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    taskId, roleId: fixture.roleId, idempotencyKey,
  };
}

/**
 * F5.7's other half. A division's grant may say how many calls to one
 * capability it has in flight at once, and every worker counts the same
 * calls. It is for a vendor that takes so many at a time -- an image model
 * on one GPU, an API that refuses a second request while the first runs --
 * which an hourly allowance says nothing about.
 */
test('a division has no more calls to one capability in flight than its grant allows, across workers (F5.7)', async () => {
  const fixture = await createCompany('in-flight-limit');
  const vendor = heldVendor();
  const registry = new CapabilityRegistry();
  registry.register(vendor.capability);
  await registry.sync();
  await grantCapability(fixture, 'crm.read', { maxInFlight: 1 });
  // Two brokers, as two replicas have: nothing shared but the database.
  const first = new CapabilityBroker(registry, undefined, undefined, { inFlightWaitMs: 5_000 });
  const second = new CapabilityBroker(registry, undefined, undefined, { inFlightWaitMs: 300 });
  const a = await rateLimitedTask(fixture);
  const b = await rateLimitedTask(fixture);
  assert.ok(await claimTask(fixture.companyId, { holder: 'worker-a', taskId: a.id }));
  assert.ok(await claimTask(fixture.companyId, { holder: 'worker-b', taskId: b.id }));

  const held = first.invoke(callFor(fixture, a.id, 'a-1'), 'crm.read', { to: 'a' });
  await vendor.started(1);

  // The other worker waits a while for the place, then is told why.
  const refused = await second.invoke(callFor(fixture, b.id, 'b-1'), 'crm.read', { to: 'b' })
    .then(() => null, (error: unknown) => error);
  assert.ok(isPalugadaError(refused, 'capability.busy'), String(refused));
  assert.match(refused.message, /crm\.read already has 1 call in flight for this division, as many as its grant allows/);
  assert.equal(typeof refused.details.notBefore, 'string');
  assert.equal(vendor.state.calls, 1, 'the refused call never reached the vendor');

  // Waiting, it has the place the moment the first call ends.
  const queued = first.invoke(callFor(fixture, b.id, 'b-2'), 'crm.read', { to: 'b' });
  await sleep(300);
  assert.equal(vendor.state.calls, 1, 'still waiting for the place');
  vendor.finish();
  await held;
  await vendor.started(2);
  vendor.finish();
  await queued;
  assert.equal(vendor.state.most, 1, 'never two at once');

  // A worker that died holding the place gives it back when its lease lapses.
  const stranded = first.invoke(callFor(fixture, a.id, 'a-2'), 'crm.read', { to: 'a' });
  await vendor.started(3);
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [a.id]));
  const after = second.invoke(callFor(fixture, b.id, 'b-3'), 'crm.read', { to: 'b' });
  await vendor.started(4);
  vendor.finishAll();
  await Promise.all([stranded, after]);

  // And a grant with no limit of its own is not held to one.
  await grantCapability(fixture, 'crm.read');
  const free = [
    first.invoke(callFor(fixture, a.id, 'a-3'), 'crm.read', { to: 'a' }),
    second.invoke(callFor(fixture, b.id, 'b-4'), 'crm.read', { to: 'b' }),
  ];
  await vendor.started(6);
  vendor.finishAll();
  await Promise.all(free);
});

/**
 * Places taken at the same moment, and a limit lowered while calls run (the
 * review of d1b8142). Many takers at once each get a place or none, and never
 * more between them than the limit; a call running in a place above a
 * lowered limit still counts, so the lower limit holds from the moment it is
 * set.
 */
test('takers at once get only the places there are, and a lowered limit holds at once (F5.7)', async () => {
  const fixture = await createCompany('in-flight-race');
  const tasks = await Promise.all(Array.from({ length: 12 }, () => rateLimitedTask(fixture)));
  const holder = (taskId: string, key: string) => ({
    companyId: fixture.companyId, divisionId: fixture.divisionId, capability: 'crm.read', taskId, holderKey: key,
  });
  for (let round = 0; round < 5; round += 1) {
    const taken = await Promise.all(tasks.map((task) => takePlace(holder(task.id, `race-${round}-${task.id}`), 2)));
    assert.equal(taken.filter(Boolean).length, 2, `round ${round}: two places, two calls`);
    await Promise.all(tasks.map((task) => givePlaceBack(holder(task.id, `race-${round}-${task.id}`))));
  }

  const [a, b, c] = tasks as [typeof tasks[0], typeof tasks[0], typeof tasks[0]];
  assert.equal(await takePlace(holder(a.id, 'a'), 2), true);
  assert.equal(await takePlace(holder(b.id, 'b'), 2), true, 'b holds place 2');
  await givePlaceBack(holder(a.id, 'a'));
  assert.equal(await takePlace(holder(c.id, 'c'), 1), false, 'lowered to one while b runs: b is that one');
  await givePlaceBack(holder(b.id, 'b'));
  assert.equal(await takePlace(holder(c.id, 'c'), 1), true);
  assert.equal(await takePlace(holder(c.id, 'c'), 1), true, 'the same call again has its own place back');
});

/**
 * Waiting in a queue behind calls that are running is not a vendor's limit
 * closing again and again, so it is not counted against the five parks a
 * vendor gets: the calls ahead end, or their leases lapse.
 */
test('a task that finds every place taken waits for one, spending no attempt (F5.7)', async () => {
  const fixture = await createCompany('in-flight-park');
  const vendor = heldVendor();
  const engine = await engineCalling(fixture, vendor.capability, { maxInFlight: 1, inFlightWaitMs: 100 });
  const registry = new CapabilityRegistry();
  registry.register(vendor.capability);
  const elsewhere = new CapabilityBroker(registry);
  const holder = await rateLimitedTask(fixture);
  assert.ok(await claimTask(fixture.companyId, { holder: 'elsewhere', taskId: holder.id }));
  const held = elsewhere.invoke(callFor(fixture, holder.id, 'held'), 'crm.read', { to: 'x' });
  await vendor.started(1);

  const task = await rateLimitedTask(fixture);
  const outcomes: Array<[string, string | undefined]> = [];
  for (let run = 0; run < 6; run += 1) {
    const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
    outcomes.push([outcome.status, outcome.reason]);
  }
  assert.deepEqual(outcomes, Array(6).fill(['waiting_window', 'capability.busy']));
  assert.equal(await attemptOf(fixture, task.id), 0, 'waiting is not failing');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string }>(
    "SELECT type FROM events WHERE task_id = $1 AND type IN ('task.waiting_slot', 'task.rate_limited')", [task.id]));
  assert.deepEqual([...new Set(rows.map((row) => row.type))], ['task.waiting_slot']);

  vendor.finish();
  await held;
  const finishing = engine.runTask(fixture.companyId, task.id, 'worker');
  await vendor.started(2);
  vendor.finish();
  assert.equal((await finishing).status, 'completed');
});

/**
 * A schedule its company cannot fund is left where it is and retried every
 * pass, which is right -- the owner raising the budget should fire it at
 * once. It also recorded the failure every pass: every few seconds, into an
 * append-only log kept for a year. Once per occurrence and reason now, and a
 * success clears the record so the next failure is news again.
 */
test('a schedule that cannot fire says so once, not every pass (F9.1)', async () => {
  const fixture = await createCompany('schedule-unfunded', { tokensMax: 1_000 });
  await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug: 'too-big',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      input: { kind: 'report' },
      reserveTokens: 5_000,
    },
    new Date(Date.now() - 3_600_000),
  );

  const failures = async () => withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'schedule.fire_failed'",
    );
    return Number(rows[0]!.count);
  });

  for (let pass = 0; pass < 5; pass += 1) {
    assert.equal((await runDueSchedules(new Date())).length, 0);
  }
  assert.equal(await failures(), 1, 'five passes, one record');

  // Funded, it fires on the next pass, and the record is cleared.
  await withControlPlane((tx) => tx.query(
    'UPDATE budget_accounts SET tokens_max = 100000 WHERE id = $1', [fixture.budgetAccountId],
  ));
  assert.equal((await runDueSchedules(new Date())).length, 1);
  const row = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ fire_failed_for: Date | null; fire_failure: string | null }>(
      "SELECT fire_failed_for, fire_failure FROM schedules WHERE slug = 'too-big'",
    );
    return rows[0]!;
  });
  assert.deepEqual(row, { fire_failed_for: null, fire_failure: null });
});

/* ------------------------------------------------- a schedule repeating itself --- */

async function scheduleWithHistory(fixture: Fixture, outputs: Array<Record<string, unknown>>) {
  const schedule = await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug: 'morning-report',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      input: { kind: 'report' },
      reserveTokens: 1000,
    },
    // Ninety minutes back, so an hourly occurrence has fallen due whatever
    // the minute is now. Thirty was due only in the first half of the hour.
    new Date(Date.now() - 90 * 60_000),
  );
  const scheduleId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM schedules WHERE slug = 'morning-report'",
    );
    return rows[0]!.id;
  });
  void schedule;
  for (const [index, output] of outputs.entries()) {
    const task = await createRootTask({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      input: { kind: 'report' },
      createdBy: 'scheduler',
      reserveTokens: 100,
      idempotencyKey: `schedule:${scheduleId}:2026-09-0${index + 1}T08:00:00.000Z`,
      scheduleId,
    });
    await transition(fixture.companyId, task.id, 'running');
    await transition(fixture.companyId, task.id, 'completed', { output });
  }
  return scheduleId;
}

async function scheduleEscalations(fixture: Fixture) {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string }>(
      "SELECT id, status FROM inbox_items WHERE kind = 'escalation' AND payload ? 'scheduleId'",
    );
    return rows;
  });
}

/**
 * auto-company calls it stalling, Paperclip throttles it: work that repeats
 * itself exactly has usually stopped being useful, and a schedule does not
 * notice that about itself. Five identical results are put to the owner once,
 * and the answer acts on the schedule.
 */
test('a schedule that keeps producing the same result is put to the owner, and deny turns it off (F9.1)', async () => {
  const fixture = await createCompany('schedule-repeats');
  const same = { summary: 'Nothing new since yesterday.' };
  const scheduleId = await scheduleWithHistory(fixture, [same, same, same, same, same]);

  const fired = await runDueSchedules(new Date());
  assert.equal(fired.length, 1, 'the occurrence still fires');
  const [asked] = await scheduleEscalations(fixture);
  assert.ok(asked, 'the owner is asked');

  // Once per result, not once per fire: the sixth run says the same thing
  // again, the next occurrence fires, and nobody is asked twice.
  await transition(fixture.companyId, fired[0]!.taskId, 'running');
  await transition(fixture.companyId, fired[0]!.taskId, 'completed', { output: same });
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [scheduleId],
  ));
  assert.equal((await runDueSchedules(new Date())).length, 1);
  assert.equal((await scheduleEscalations(fixture)).length, 1);

  await inbox.decide(fixture.companyId, asked!.id, 'deny', 'it has nothing to say');
  const enabled = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ enabled: boolean }>('SELECT enabled FROM schedules WHERE id = $1', [scheduleId]);
    return rows[0]!.enabled;
  });
  assert.equal(enabled, false, 'deny is the action, not a note to go and take it');
});

test('a schedule whose results differ is left alone', async () => {
  const fixture = await createCompany('schedule-varies');
  await scheduleWithHistory(fixture, [
    { summary: 'a' }, { summary: 'b' }, { summary: 'a' }, { summary: 'a' }, { summary: 'a' },
  ]);
  await runDueSchedules(new Date());
  assert.deepEqual(await scheduleEscalations(fixture), []);
});

/**
 * A schedule's place in the queue reaches the work it makes.
 *
 * `schedules.priority` was added with task priorities (0023) and nothing ever
 * wrote or read it: every scheduled task ran at the default, so a P0 check
 * scheduled every five minutes queued behind a backlog of P2 reports. And a
 * task knows its schedule by id (0049), rather than by the text of its key.
 */
test('a scheduled task carries its schedule and the schedule\'s priority (F5.10, F9.1)', async () => {
  const fixture = await createCompany('schedule-priority');
  const scheduleId = await upsertSchedule(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId,
      goalId: fixture.goalId,
      slug: 'uptime-check',
      cronExpression: '*/5 * * * *',
      timezone: 'UTC',
      input: { check: 'uptime' },
      reserveTokens: 100,
      priority: 0,
    },
    new Date(Date.now() - 10 * 60_000),
  );
  const [fired] = await runDueSchedules(new Date());
  assert.ok(fired, 'the occurrence fired');
  const task = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ priority: number; schedule_id: string }>(
      'SELECT priority, schedule_id FROM tasks WHERE id = $1', [fired.taskId],
    );
    return rows[0]!;
  });
  assert.deepEqual(task, { priority: 0, schedule_id: scheduleId });
});
