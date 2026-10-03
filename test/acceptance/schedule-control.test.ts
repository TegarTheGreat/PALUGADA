/**
 * A schedule is the owner's to turn off, turn on and remove (F9.1, N11).
 *
 * Only two routes touched a schedule: save and run now. The console showed
 * "Off" on a schedule with nothing to turn it on, and a schedule turned off
 * -- by denying the escalation that asks whether a repetitive one is still
 * worth running, or by closing its goal -- could be revived only by typing it
 * again under the same short name, which overwrote its brief, kept its old
 * role, and turned it on: saving said `enabled ?? true`. Nothing removed one.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { runDueSchedules, upsertSchedule } from '../../src/scheduler/scheduler.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

function daily(fixture: Fixture, extra: Partial<Parameters<typeof upsertSchedule>[0]> = {}) {
  return upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    slug: 'morning-briefing', cronExpression: '0 7 * * *', timezone: 'Asia/Jakarta',
    input: { goal: 'Write the morning briefing.' },
    ...extra,
  });
}

async function row(fixture: Fixture, scheduleId: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ enabled: boolean; next_run_at: Date; input: { goal: string } }>(
    'SELECT enabled, next_run_at, input FROM schedules WHERE id = $1', [scheduleId]));
  return rows[0];
}

async function events(fixture: Fixture, type: string) {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM events WHERE type = $1 ORDER BY occurred_at', [type]));
  return rows.map((one) => one.payload);
}

test('the owner turns a schedule off and on; on again, it runs at its next time, not the ones it missed (N11)', async () => {
  const fixture = await createCompany('schedule-toggle');
  const scheduleId = await daily(fixture);
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const set = (enabled: unknown) => api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/enabled`, token, { enabled });

    const off = await set(false);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await row(fixture, scheduleId))!.enabled, false);
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/schedules`, token)).body.schedules[0].enabled, false);

    // A week passes with it off: nothing runs.
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE schedules SET next_run_at = now() - interval '7 days' WHERE id = $1", [scheduleId]));
    assert.deepEqual(await runDueSchedules(), []);

    // On again: the next time is ahead, and the week it was off is not caught up.
    const on = await set(true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const after = (await row(fixture, scheduleId))!;
    assert.equal(after.enabled, true);
    assert.ok(after.next_run_at.getTime() > Date.now(), 'its next run is its next time');
    assert.deepEqual(await runDueSchedules(), []);
    assert.deepEqual((await events(fixture, 'schedule.turned')).map((payload) => payload.enabled), [false, true]);

    assert.equal((await set('yes')).status, 400, 'on or off, said as true or false');
  } finally {
    await api.close();
  }
});

test('saving a schedule again leaves it off when it was off; a new one cannot take a name that is taken (N11)', async () => {
  const fixture = await createCompany('schedule-save');
  const scheduleId = await daily(fixture);
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/enabled`, token, { enabled: false });

    // Edited without saying on or off: it stays off.
    await daily(fixture, { input: { goal: 'Write a shorter morning briefing.' } });
    assert.deepEqual([(await row(fixture, scheduleId))!.enabled, (await row(fixture, scheduleId))!.input.goal], [false, 'Write a shorter morning briefing.']);

    // "New schedule" under a name in use is refused, and the one there is untouched.
    const taken = await api.call('POST', `/api/companies/${fixture.companyId}/schedules`, token, {
      create: true, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, goalId: fixture.goalId,
      slug: 'morning-briefing', cronExpression: '0 9 * * *', input: { goal: 'Something else entirely.' },
    });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
    assert.equal(taken.body.code, 'schedule.slug_taken');
    assert.match(String(taken.body.error), /morning-briefing/);
    assert.equal((await row(fixture, scheduleId))!.input.goal, 'Write a shorter morning briefing.');
  } finally {
    await api.close();
  }
});

test('the owner removes a schedule; the work it made stays, without it (N11)', async () => {
  const fixture = await createCompany('schedule-remove');
  const scheduleId = await daily(fixture);
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const ran = await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/run`, token, {});
    assert.equal(ran.status, 200, JSON.stringify(ran.body));

    const removed = await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/remove`, token, {});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(await row(fixture, scheduleId), undefined);
    assert.deepEqual((await api.call('GET', `/api/companies/${fixture.companyId}/schedules`, token)).body.schedules, []);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ schedule_id: string | null }>(
      'SELECT schedule_id FROM tasks WHERE id = $1', [ran.body.task.id]));
    assert.deepEqual(rows, [{ schedule_id: null }], 'its run is still there, as work the owner can open');
    assert.deepEqual((await events(fixture, 'schedule.removed')).map((payload) => payload.slug), ['morning-briefing']);

    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/schedules/${scheduleId}/remove`, token, {})).status, 400,
      'what is gone is said to be gone');
  } finally {
    await api.close();
  }
});
