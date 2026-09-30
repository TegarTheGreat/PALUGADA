/**
 * PRD F9.1 -- what a schedule does when its last run is still going, and when
 * it comes back from downtime too late for the occurrence to be worth running.
 *
 * Two gaps, both found in `runDueSchedules`. An occurrence fired whether or
 * not the task the previous one created was still live, so an hourly job that
 * took seventy minutes, or a daily one whose task waited two days for the
 * owner, got a second task beside the first: twice the spend, and two runs
 * doing the same work. And after downtime one catch-up run happened however
 * late it was, so a 07:00 briefing came back at 19:00.
 *
 * Every pass here is given its own clock rather than the wall's, so an
 * occurrence is exactly as late as the test says it is.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { runDueSchedules, upsertSchedule, type ScheduleInput } from '../../src/scheduler/scheduler.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { publishBundle, installBundle } from '../../src/bundles/bundle.ts';
import { COMPANY_OS } from '../../src/bundles/builtin.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const at = (iso: string) => new Date(iso);

async function schedule(
  fixture: Fixture,
  extra: Partial<ScheduleInput> = {},
  savedAt = at('2026-09-07T06:30:00Z'),
): Promise<string> {
  return upsertSchedule({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    slug: 'hourly-report',
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    input: { goal: 'Report the hour' },
    reserveTokens: 1_000,
    ...extra,
  }, savedAt);
}

async function tasksOf(fixture: Fixture, scheduleId: string) {
  return withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string; status: string }>(
    'SELECT id, status FROM tasks WHERE schedule_id = $1 ORDER BY created_at, id', [scheduleId],
  )).rows);
}

async function eventsOf(fixture: Fixture, type: string) {
  return withTenant(fixture.companyId, async (tx) => (await tx.query<{ task_id: string | null; payload: Record<string, any> }>(
    'SELECT task_id, payload FROM events WHERE type = $1 ORDER BY occurred_at, id', [type],
  )).rows);
}

async function rowOf(fixture: Fixture, scheduleId: string) {
  return withTenant(fixture.companyId, async (tx) => (await tx.query<{
    overlap: string; catch_up_minutes: number | null; next_run_at: Date; held_by_task_id: string | null;
    skipped_for: Date | null; skipped_because: string | null; skipped_count: number | null; skipped_task_id: string | null;
  }>(
    `SELECT overlap, catch_up_minutes, next_run_at, held_by_task_id,
            skipped_for, skipped_because, skipped_count, skipped_task_id
       FROM schedules WHERE id = $1`, [scheduleId],
  )).rows[0]!);
}

async function finish(fixture: Fixture, taskId: string) {
  await transition(fixture.companyId, taskId, 'running');
  await transition(fixture.companyId, taskId, 'completed', { output: { summary: 'done' } });
}

/* ------------------------------------------------------------ overlap --- */

test('a schedule whose last run is still going skips the occurrence, says so once, and runs again when it has finished (F9.1)', async () => {
  const fixture = await createCompany('overlap-skip');
  // No policy given: skip is the default, for a schedule saved before the
  // column existed as much as for a new one.
  const id = await schedule(fixture);
  assert.equal((await rowOf(fixture, id)).overlap, 'skip');

  const [first] = await runDueSchedules(at('2026-09-07T07:00:05Z'));
  assert.ok(first, 'the first occurrence fires');

  // Its task waits for the owner, as a task can for days.
  await transition(fixture.companyId, first.taskId, 'running');
  await transition(fixture.companyId, first.taskId, 'waiting_approval');

  // The pass runs every few seconds; the 08:00 occurrence is seen by every one.
  for (const when of ['08:00:05', '08:00:10', '08:00:15', '08:30:00', '08:59:59']) {
    assert.deepEqual(await runDueSchedules(at(`2026-09-07T${when}Z`)), [], `${when} fired beside a live run`);
  }
  assert.deepEqual((await tasksOf(fixture, id)).map((task) => task.id), [first.taskId], 'no second task');

  const skipped = await eventsOf(fixture, 'schedule.skipped');
  assert.equal(skipped.length, 1, 'five passes, one record');
  assert.equal(skipped[0]!.payload.occurrence, '2026-09-07T08:00:00.000Z');
  assert.equal(skipped[0]!.payload.runningTaskId, first.taskId, 'the record names the run still going');
  assert.equal(skipped[0]!.payload.runningStatus, 'waiting_approval');
  assert.equal(skipped[0]!.payload.nextRunAt, '2026-09-07T09:00:00.000Z');

  const row = await rowOf(fixture, id);
  assert.equal(row.next_run_at.toISOString(), '2026-09-07T09:00:00.000Z', 'the schedule moved on');
  assert.deepEqual(
    [row.skipped_for?.toISOString(), row.skipped_because, row.skipped_count, row.skipped_task_id],
    ['2026-09-07T08:00:00.000Z', 'overlap', 1, first.taskId],
    'and remembers why the occurrence did not run',
  );

  // Finished, the next occurrence fires as it would have.
  await transition(fixture.companyId, first.taskId, 'running');
  await transition(fixture.companyId, first.taskId, 'completed', { output: { summary: 'approved and done' } });
  const [second] = await runDueSchedules(at('2026-09-07T09:00:05Z'));
  assert.ok(second, 'the schedule runs again once its last run is over');
  assert.equal((await tasksOf(fixture, id)).length, 2);
  assert.equal((await eventsOf(fixture, 'schedule.skipped')).length, 1);
});

test('a queued schedule waits for its last run, says so once, and then runs once (F9.1)', async () => {
  const fixture = await createCompany('overlap-queue');
  const id = await schedule(fixture, { overlap: 'queue' });

  const [first] = await runDueSchedules(at('2026-09-07T07:00:05Z'));
  assert.ok(first);

  // Seventy minutes of work and more: the 08:00 and 09:00 occurrences both
  // fall due while it is live.
  for (const when of ['08:00:05', '08:00:10', '08:30:00', '09:00:05', '09:30:00']) {
    assert.deepEqual(await runDueSchedules(at(`2026-09-07T${when}Z`)), [], `${when} fired beside a live run`);
  }
  const held = await rowOf(fixture, id);
  assert.equal(held.next_run_at.toISOString(), '2026-09-07T08:00:00.000Z', 'the schedule does not advance');
  assert.equal(held.held_by_task_id, first.taskId, 'it knows what it waits for');
  const waiting = await eventsOf(fixture, 'schedule.held');
  assert.equal(waiting.length, 1, 'five passes, one record');
  assert.equal(waiting[0]!.payload.runningTaskId, first.taskId);
  assert.equal(waiting[0]!.payload.occurrence, '2026-09-07T08:00:00.000Z');

  await finish(fixture, first.taskId);
  const fired = await runDueSchedules(at('2026-09-07T09:40:00Z'));
  assert.equal(fired.length, 1, 'it runs once when the last one finishes');
  assert.equal(fired[0]!.occurrence.toISOString(), '2026-09-07T08:00:00.000Z');
  // The backlog behind it collapses, as any backlog does.
  const [, fireEvent] = await eventsOf(fixture, 'schedule.fired');
  assert.equal(fireEvent!.payload.skippedOccurrences, 1, 'the 09:00 occurrence is counted into it');
  const after = await rowOf(fixture, id);
  assert.equal(after.next_run_at.toISOString(), '2026-09-07T10:00:00.000Z');
  assert.equal(after.held_by_task_id, null, 'no longer waiting');

  assert.deepEqual(await runDueSchedules(at('2026-09-07T09:40:05Z')), [], 'and once only');
  assert.equal((await tasksOf(fixture, id)).length, 2);
  assert.equal((await eventsOf(fixture, 'schedule.held')).length, 1);
});

test('a schedule allowed to overlap runs beside its last run, as every schedule did before (F9.1)', async () => {
  const fixture = await createCompany('overlap-allow');
  const id = await schedule(fixture, { overlap: 'allow' });

  const [first] = await runDueSchedules(at('2026-09-07T07:00:05Z'));
  const [second] = await runDueSchedules(at('2026-09-07T08:00:05Z'));
  assert.ok(first && second, 'both occurrences fire');
  assert.deepEqual((await tasksOf(fixture, id)).map((task) => task.status), ['pending', 'pending']);
  assert.deepEqual(await eventsOf(fixture, 'schedule.skipped'), []);
  assert.deepEqual(await eventsOf(fixture, 'schedule.held'), []);
});

/**
 * A crash between creating an occurrence's task and advancing the schedule
 * leaves that task live and the occurrence still due. It is the occurrence's
 * own task, not an earlier run's: the next pass finishes firing it (the key
 * finds the same task) rather than skipping it on account of itself.
 */
test('an occurrence a crash left half-fired is finished, not skipped for its own task (F9.1)', async () => {
  const fixture = await createCompany('overlap-crash');
  const id = await schedule(fixture);
  const halfFired = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Report the hour' }, createdBy: 'scheduler', reserveTokens: 1_000,
    idempotencyKey: `schedule:${id}:2026-09-07T07:00:00.000Z`, scheduleId: id,
  });

  const [fired] = await runDueSchedules(at('2026-09-07T07:00:05Z'));
  assert.equal(fired?.taskId, halfFired.id, 'the same task, fired');
  assert.deepEqual(await eventsOf(fixture, 'schedule.skipped'), []);
  assert.equal((await rowOf(fixture, id)).next_run_at.toISOString(), '2026-09-07T08:00:00.000Z');
});

/* ----------------------------------------------------------- catch-up --- */

test('an occurrence later than the catch-up window is not run, and is recorded once with the count dropped (F9.1)', async () => {
  const fixture = await createCompany('catch-up-window');
  const id = await schedule(fixture, {
    slug: 'morning-briefing', cronExpression: '0 7 * * *', catchUpMinutes: 60,
  }, at('2026-09-06T12:00:00Z'));

  // Back at 19:00: the 07:00 briefing is twelve hours late.
  for (const when of ['19:00:00', '19:00:05', '19:30:00']) {
    assert.deepEqual(await runDueSchedules(at(`2026-09-07T${when}Z`)), [], `${when} ran a briefing twelve hours late`);
  }
  assert.deepEqual(await tasksOf(fixture, id), []);
  const missed = await eventsOf(fixture, 'schedule.missed');
  assert.equal(missed.length, 1, 'three passes, one record');
  assert.equal(missed[0]!.payload.occurrence, '2026-09-07T07:00:00.000Z');
  assert.equal(missed[0]!.payload.droppedOccurrences, 1);
  assert.equal(missed[0]!.payload.catchUpMinutes, 60);
  assert.equal(missed[0]!.payload.nextRunAt, '2026-09-08T07:00:00.000Z');
  let row = await rowOf(fixture, id);
  assert.equal(row.next_run_at.toISOString(), '2026-09-08T07:00:00.000Z', 'the schedule moved on');
  assert.deepEqual([row.skipped_because, row.skipped_count], ['late', 1]);

  // Three days down: all three are dropped, and counted.
  await runDueSchedules(at('2026-09-10T19:00:00Z'));
  const [, longer] = await eventsOf(fixture, 'schedule.missed');
  assert.equal(longer!.payload.droppedOccurrences, 3);
  row = await rowOf(fixture, id);
  assert.deepEqual([row.skipped_for?.toISOString(), row.skipped_count], ['2026-09-08T07:00:00.000Z', 3]);

  // Twenty minutes late is inside the hour: it runs.
  const [onTime] = await runDueSchedules(at('2026-09-11T07:20:00Z'));
  assert.ok(onTime, 'an occurrence inside the window runs');
  assert.equal((await tasksOf(fixture, id)).length, 1);
});

/**
 * Late is measured from the most recent occurrence that fell due, not the
 * oldest. An hourly job with a thirty-minute window, back from three hours
 * down at ten past, has an occurrence ten minutes old: that one is worth
 * running, and the two before it are the backlog that collapses into it.
 */
test('the window is measured from the latest occurrence due, so a short outage still runs the one that matters (F9.1)', async () => {
  const fixture = await createCompany('catch-up-latest');
  const id = await schedule(fixture, { catchUpMinutes: 30 }, at('2026-09-07T06:30:00Z'));

  const fired = await runDueSchedules(at('2026-09-07T09:10:00Z'));
  assert.equal(fired.length, 1, 'the 09:00 occurrence is ten minutes late, inside the window');
  const [fireEvent] = await eventsOf(fixture, 'schedule.fired');
  assert.equal(fireEvent!.payload.skippedOccurrences, 2, 'the 08:00 and 09:00 collapse into the catch-up');
  assert.deepEqual(await eventsOf(fixture, 'schedule.missed'), []);
  assert.equal((await rowOf(fixture, id)).next_run_at.toISOString(), '2026-09-07T10:00:00.000Z');
});

test('with no catch-up window, one catch-up runs however late, as before (F9.1)', async () => {
  const fixture = await createCompany('catch-up-unset');
  const id = await schedule(fixture, { slug: 'morning-briefing', cronExpression: '0 7 * * *' }, at('2026-09-06T12:00:00Z'));
  assert.equal((await rowOf(fixture, id)).catch_up_minutes, null);

  const fired = await runDueSchedules(at('2026-09-07T19:00:00Z'));
  assert.equal(fired.length, 1, 'twelve hours late, and run');
  assert.deepEqual(await eventsOf(fixture, 'schedule.missed'), []);
});

test('a queued run that waits past the catch-up window is dropped, not run late (F9.1)', async () => {
  const fixture = await createCompany('catch-up-queued');
  const id = await schedule(fixture, { overlap: 'queue', catchUpMinutes: 30 });
  const [first] = await runDueSchedules(at('2026-09-07T07:00:05Z'));
  assert.ok(first);

  assert.deepEqual(await runDueSchedules(at('2026-09-07T08:00:05Z')), []);
  assert.equal((await rowOf(fixture, id)).held_by_task_id, first.taskId);
  // Forty minutes on, the 08:00 occurrence is past its window: dropped, and
  // the schedule waits at 09:00 instead.
  assert.deepEqual(await runDueSchedules(at('2026-09-07T08:40:00Z')), []);
  const row = await rowOf(fixture, id);
  assert.equal(row.next_run_at.toISOString(), '2026-09-07T09:00:00.000Z');
  assert.equal(row.skipped_because, 'late');
  assert.equal((await eventsOf(fixture, 'schedule.missed')).length, 1);
  assert.equal((await tasksOf(fixture, id)).length, 1);
});

/* --------------------------------------------------------- validation --- */

test('an overlap policy and a catch-up window are refused by name when they are not ones the scheduler knows (F9.1)', async () => {
  const fixture = await createCompany('overlap-validation');
  await assert.rejects(schedule(fixture, { overlap: 'sometimes' as never }), (error: unknown) => {
    assert.ok(isPalugadaError(error, 'contract.violation'));
    assert.match(error.message, /overlap is sometimes; it is one of skip, queue, allow/);
    return true;
  });
  await assert.rejects(schedule(fixture, { catchUpMinutes: 5 }), (error: unknown) => {
    assert.ok(isPalugadaError(error, 'contract.violation'));
    assert.match(error.message, /catchUpMinutes is 5; a catch-up window is at least 15 minutes/);
    return true;
  });
  await assert.rejects(schedule(fixture, { catchUpMinutes: 2.5 }), /a whole number of minutes/);
  await assert.rejects(schedule(fixture, { catchUpMinutes: 600_000 }), /at most 525600/);

  // And the database says the same thing to anything that goes round the code.
  const id = await schedule(fixture, { overlap: 'queue', catchUpMinutes: 15 });
  assert.deepEqual(
    [(await rowOf(fixture, id)).overlap, (await rowOf(fixture, id)).catch_up_minutes], ['queue', 15],
  );
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE schedules SET overlap = 'sometimes' WHERE id = $1", [id])), /schedules_overlap_known/);
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE schedules SET catch_up_minutes = 1 WHERE id = $1', [id])), /schedules_catch_up_range/);

  // Saved again without them, a schedule goes back to the defaults, as every
  // other field of an upsert does.
  await schedule(fixture);
  assert.deepEqual(
    [(await rowOf(fixture, id)).overlap, (await rowOf(fixture, id)).catch_up_minutes], ['skip', null],
  );
});

test('the owner sets the policy and the window, is refused a bad one, and sees why an occurrence did not run (F9.1, F10.1)', async () => {
  const fixture = await createCompany('overlap-api');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/schedules`;
    const body = {
      projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, slug: 'morning-briefing', cronExpression: '0 7 * * *',
      input: { goal: 'Brief the owner' },
    };

    const unknown = await api.call('POST', path, token, { ...body, overlap: 'both' });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.match(String(unknown.body.error), /overlap must be one of skip, queue, allow; got both/);
    const short = await api.call('POST', path, token, { ...body, catchUpMinutes: 2 });
    assert.equal(short.status, 400, JSON.stringify(short.body));
    assert.match(String(short.body.error), /catchUpMinutes is 2; a catch-up window is at least 15 minutes/);
    const text = await api.call('POST', path, token, { ...body, catchUpMinutes: 'an hour' });
    assert.equal(text.status, 400, JSON.stringify(text.body));
    assert.match(String(text.body.error), /catchUpMinutes must be a whole number/);

    const saved = await api.call('POST', path, token, { ...body, overlap: 'queue', catchUpMinutes: 120 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const listed = await api.call('GET', path, token);
    assert.equal(listed.status, 200);
    const [one] = listed.body.schedules;
    assert.deepEqual([one.overlap, one.catchUpMinutes, one.waitingFor, one.lastSkipped], ['queue', 120, null, null]);

    // Null is "always run a missed occurrence once", said out loud.
    const cleared = await api.call('POST', path, token, { ...body, overlap: 'queue', catchUpMinutes: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((await api.call('GET', path, token)).body.schedules[0].catchUpMinutes, null);

    // Missed, and the list says so: when, why, how many. The occurrence is
    // put at a known instant and the pass given its own clock, so how late it
    // is does not depend on when the suite runs.
    await api.call('POST', path, token, { ...body, overlap: 'queue', catchUpMinutes: 60 });
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE schedules SET next_run_at = '2026-09-07T07:00:00Z' WHERE slug = 'morning-briefing'"));
    assert.deepEqual(await runDueSchedules(at('2026-09-07T19:00:00Z')), []);
    const [missed] = (await api.call('GET', path, token)).body.schedules;
    assert.deepEqual(missed.lastSkipped, {
      occurrence: '2026-09-07T07:00:00.000Z', because: 'late', occurrences: 1, taskId: null,
    });

    // Waiting behind a live run, and the list names it.
    await withTenant(fixture.companyId, (tx) => tx.query(
      'UPDATE schedules SET catch_up_minutes = NULL WHERE slug = \'morning-briefing\''));
    const [run] = await runDueSchedules(at('2026-09-08T07:00:05Z'));
    assert.ok(run, 'the occurrence fired');
    assert.deepEqual(await runDueSchedules(at('2026-09-09T07:00:05Z')), []);
    const [held] = (await api.call('GET', path, token)).body.schedules;
    assert.equal(held.waitingFor, run.taskId);
    assert.equal(held.lastSkipped.because, 'late', 'waiting is not a skip; the last skip still shows');

    // Saved again, the schedule moves to its next occurrence: nothing is held.
    await api.call('POST', path, token, { ...body, overlap: 'allow' });
    const [resaved] = (await api.call('GET', path, token)).body.schedules;
    assert.deepEqual([resaved.overlap, resaved.waitingFor], ['allow', null]);
  } finally {
    await api.close();
  }
});

/* ------------------------------------------------ bundles and archives --- */

test('a bundle\'s cadence brings its policy and window, and a bad one is refused when it is published (F9.1, F16.1)', async () => {
  const fixture = await createCompany('overlap-bundle');
  await registerStandardCatalogue();
  const cadence = COMPANY_OS.body.cadences![0]!;
  const withTiming = {
    ...COMPANY_OS,
    slug: 'company-os-timed',
    body: { ...COMPANY_OS.body, cadences: [{ ...cadence, overlap: 'queue' as const, catchUpMinutes: 720 }] },
  };
  await publishBundle(withTiming);
  await installBundle({ companyId: fixture.companyId, slug: withTiming.slug, version: withTiming.version });
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ overlap: string; catch_up_minutes: number | null }>(
    'SELECT overlap, catch_up_minutes FROM schedules WHERE slug = $1', [cadence.slug]));
  assert.deepEqual(rows, [{ overlap: 'queue', catch_up_minutes: 720 }]);

  const refused = (slug: string, change: Record<string, unknown>) => publishBundle({
    ...COMPANY_OS, slug, body: { ...COMPANY_OS.body, cadences: [{ ...cadence, ...change } as never] },
  });
  await assert.rejects(refused('company-os-overlap', { overlap: 'twice' }),
    /cadence weekly-business-review: overlap is twice; it is one of skip, queue, allow/);
  await assert.rejects(refused('company-os-window', { catchUpMinutes: 1 }),
    /cadence weekly-business-review: catchUpMinutes is 1; a catch-up window is at least 15 minutes/);
});

test('an archive carries a schedule\'s overlap policy and catch-up window (F9.1, F16.4)', async () => {
  const fixture = await createCompany('overlap-export');
  await schedule(fixture, { overlap: 'queue', catchUpMinutes: 90 });
  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => {
    lines.push(line);
  });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ overlap: string; catch_up_minutes: number | null }>(
    "SELECT overlap, catch_up_minutes FROM schedules WHERE slug = 'hourly-report'"));
  assert.deepEqual(rows, [{ overlap: 'queue', catch_up_minutes: 90 }]);
});
