/**
 * A company that keeps office hours (the owner's complaint of 6 October:
 * "susah dijalankan 24 jam atau 8 jam kerja").
 *
 * F9.6 stands: agents have no working hours, and nothing here stops them
 * thinking, reading, drafting or planning at any hour. What an owner who wants
 * a nine-to-five company needs is for the things that reach the outside world
 * -- an email sent, a customer answered, a post published -- to wait for the
 * morning. The broker already held an action to a window (F9.2), but the only
 * way to give one was a row typed into the database, one capability at a time.
 * Now the owner says it once for the company, in the console.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { clearOfficeHours, officeHours, setOfficeHours } from '../../src/scheduler/windows.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const today = new Date().getUTCDay();
/** Shut on every hour of today, in UTC, so the test does not depend on when it runs. */
const CLOSED_TODAY = { timezone: 'UTC', startHour: 8, endHour: 18, daysOfWeek: [(today + 2) % 7] };
/** Open on every hour of today. */
const OPEN_TODAY = { timezone: 'UTC', startHour: 0, endHour: 24, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };

const calls: string[] = [];
let runs = 0;
function double(name: string, tier: 0 | 1 | 2 | 3): Capability<Record<string, never>, { done: true }> {
  return {
    name,
    adapter: 'test:office',
    defaultTier: tier,
    async execute() {
      calls.push(name);
      return { done: true };
    },
    ...(tier > 0 ? { async verify() { return true; } } : {}),
  };
}

async function runOne(fixture: Fixture, name: string, tier: 0 | 1 | 2 | 3) {
  const registry = new CapabilityRegistry();
  registry.register(double(name, tier));
  await registry.sync();
  await grantCapability(fixture, name);
  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability(name, {});
      return {};
    }]]),
  });
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { run: ++runs }, createdBy: 'owner', reserveTokens: 10_000,
  });
  // Above tier 1 an action is held to the plan the task declared (F8.11).
  if (tier >= 2) await planTask(fixture.companyId, task.id, [{ capability: name }]);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  return { outcome, task };
}

beforeEach(() => { calls.length = 0; });

test('what reaches the outside waits for the office to open; what stays inside does not', async () => {
  const fixture = await createCompany('office-hours');
  await setOfficeHours({ companyId: fixture.companyId, ...CLOSED_TODAY });

  const outward = await runOne(fixture, 'email.send', 2);
  assert.equal(outward.outcome.status, 'waiting_window', 'an email is put off, not refused');
  assert.ok(outward.outcome.waitUntil instanceof Date, 'with the moment the office opens');
  assert.ok(outward.outcome.waitUntil!.getTime() > Date.now());
  assert.deepEqual(calls, [], 'and nothing was sent');
  const parked = await withTenant(fixture.companyId, (tx) => getTask(tx, outward.task.id));
  assert.equal(parked!.status, 'waiting_window');

  // F9.6: the agent is not idle. Reading and writing inside the company go on.
  assert.equal((await runOne(fixture, 'crm.read', 0)).outcome.status, 'completed');
  assert.equal((await runOne(fixture, 'doc.draft', 1)).outcome.status, 'completed');
  assert.deepEqual(calls, ['crm.read', 'doc.draft']);
});

test('inside the hours an outward action runs as it always did', async () => {
  const fixture = await createCompany('office-hours-open');
  await setOfficeHours({ companyId: fixture.companyId, ...OPEN_TODAY });
  const sent = await runOne(fixture, 'email.send', 2);
  assert.equal(sent.outcome.status, 'completed', sent.outcome.reason);
  assert.deepEqual(calls, ['email.send']);
});

test('a company that kept none, or cleared them, runs round the clock (F9.6)', async () => {
  const fixture = await createCompany('office-hours-none');
  assert.equal(await withTenant(fixture.companyId, (tx) => officeHours(tx, fixture.companyId)), null);
  assert.equal((await runOne(fixture, 'email.send', 2)).outcome.status, 'completed');

  await setOfficeHours({ companyId: fixture.companyId, ...CLOSED_TODAY });
  assert.equal((await runOne(fixture, 'social.publish', 2)).outcome.status, 'waiting_window');
  await clearOfficeHours(fixture.companyId);
  assert.equal(await withTenant(fixture.companyId, (tx) => officeHours(tx, fixture.companyId)), null);
  assert.equal((await runOne(fixture, 'chat.send', 2)).outcome.status, 'completed', 'cleared, it runs again');
});

test('a capability the owner keeps open round the clock is not held, and a window of its own beats the office', async () => {
  const fixture = await createCompany('office-hours-except');
  await setOfficeHours({ companyId: fixture.companyId, ...CLOSED_TODAY, except: ['chat.send'] });
  assert.equal((await runOne(fixture, 'chat.send', 2)).outcome.status, 'completed', 'a customer is answered at any hour');
  assert.equal((await runOne(fixture, 'email.send', 2)).outcome.status, 'waiting_window', 'the rest keep the hours');

  // A window set for one capability on its own is the more specific rule (F9.2).
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO capability_windows (company_id, capability_name, timezone, start_hour, end_hour)
     VALUES ($1, 'email.send', 'UTC', 0, 24)`, [fixture.companyId]));
  assert.equal((await runOne(fixture, 'email.send', 2)).outcome.status, 'completed');
});

test("the owner sets them in the console, in words, and the agents cannot", async () => {
  const fixture = await createCompany('office-hours-api');
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/office-hours`;
    assert.deepEqual((await api.call('GET', path, token)).body, { hours: null }, 'none until the owner says');

    const set = await api.call('POST', path, token, { timezone: 'Asia/Jakarta', startHour: 9, endHour: 17, daysOfWeek: [1, 2, 3, 4, 5], except: ['chat.send'] });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual((await api.call('GET', path, token)).body, {
      hours: { timezone: 'Asia/Jakarta', startHour: 9, endHour: 17, daysOfWeek: [1, 2, 3, 4, 5], except: ['chat.send'] },
    });

    // The end of the day may be midnight; the rest is refused by name.
    assert.equal((await api.call('POST', path, token, { timezone: 'UTC', startHour: 8, endHour: 24, daysOfWeek: [1] })).status, 200);
    for (const [body, what] of [
      [{ timezone: 'Jakarta', startHour: 9, endHour: 17 }, /not a time zone.*Asia\/Jakarta/],
      [{ timezone: 'UTC', startHour: 9, endHour: 25 }, /endHour/],
      [{ timezone: 'UTC', startHour: 24, endHour: 17 }, /startHour/],
      [{ timezone: 'UTC', startHour: 9, endHour: 9 }, /differ|round the clock/],
      [{ timezone: 'UTC', startHour: 9, endHour: 17, daysOfWeek: [] }, /daysOfWeek/],
      [{ timezone: 'UTC', startHour: 9, endHour: 17, daysOfWeek: [7] }, /daysOfWeek/],
      [{ timezone: 'UTC', startHour: 9, endHour: 17, except: ['email.sned'] }, /email\.sned/],
    ] as const) {
      const refused = await api.call('POST', path, token, body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.match(String(refused.body.error), what);
    }
    assert.equal((await api.call('GET', path, token)).body.hours.endHour, 24, 'a refusal leaves what stood');

    assert.equal((await api.call('POST', `${path}/clear`, token, {})).status, 200);
    assert.deepEqual((await api.call('GET', path, token)).body, { hours: null });

    // An agent's own connection can read the hours its actions are held to
    // and has no way to change them.
    await setOfficeHours({ companyId: fixture.companyId, ...CLOSED_TODAY });
    await assert.rejects(
      withTenant(fixture.companyId, (tx) => tx.query(
        'UPDATE office_hours SET start_hour = 0, end_hour = 24 WHERE company_id = $1', [fixture.companyId])),
      /permission denied/);
    await assert.rejects(
      withTenant(fixture.companyId, (tx) => tx.query('DELETE FROM office_hours WHERE company_id = $1', [fixture.companyId])),
      /permission denied/);
    assert.equal((await withControlPlane((tx) => tx.query('SELECT 1 FROM office_hours'))).rows.length, 1);
  } finally {
    await api.close();
  }
});
