/**
 * PRD F3.7 -- denials counted per role, and a role past the daily limit frozen
 * automatically.
 *
 * The property being tested is not "a counter increments". It is that the
 * platform stops the smallest thing that is actually going wrong: a role whose
 * prompt or grants are misconfigured will keep being denied for every task
 * that runs it, and stopping the role stops the repetition without stopping
 * the six divisions that are working.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { setThresholds } from '../../src/reporting/alerts.ts';
import { frozenRoles, unfreezeRole } from '../../src/governance/role-freeze.ts';
import { createRootTask, createSubTask } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { addRole, createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const THRESHOLD = 3;

function dnsCapability() {
  const calls = { executions: 0 };
  const capability: Capability<{ record: string }, { ok: boolean }> = {
    name: 'dns.update',
    adapter: 'test:dns',
    defaultTier: 1,
    async execute() {
      calls.executions += 1;
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  return { capability, calls };
}

async function brokerFor(): Promise<{ broker: CapabilityBroker; calls: { executions: number } }> {
  const { capability, calls } = dnsCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  return { broker: new CapabilityBroker(registry), calls };
}

/**
 * A fresh task each time.
 *
 * The goal is unique per call because an identical input under the same role
 * derives the same idempotency key, and the second attempt would adopt the
 * first task instead of being a second attempt -- which is correct behaviour
 * and would quietly make this file test nothing.
 */
let attempts = 0;
async function newTask(fixture: Fixture, roleId: string) {
  attempts += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { goal: `dns-${attempts}` },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
}

/** One denied attempt: the division has no grant, so the broker refuses. */
async function attempt(
  broker: CapabilityBroker,
  fixture: Fixture,
  roleId: string,
): Promise<unknown> {
  const task = await newTask(fixture, roleId);
  return broker.invoke(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      taskId: task.id,
      roleId,
      idempotencyKey: `key-${task.id}`,
    },
    'dns.update',
    { record: `www-${attempts}` },
  );
}

async function attemptAndSwallow(
  broker: CapabilityBroker,
  fixture: Fixture,
  roleId: string,
): Promise<string> {
  try {
    await attempt(broker, fixture, roleId);
    return 'allowed';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

test('a role is frozen on the denial that reaches the limit, not before (F3.7)', async () => {
  const fixture = await createCompany('freeze-threshold');
  await setThresholds(fixture.companyId, { roleFreezeDenialsPerDay: THRESHOLD });
  const { broker } = await brokerFor();

  for (let i = 1; i < THRESHOLD; i += 1) {
    assert.equal(await attemptAndSwallow(broker, fixture, fixture.roleId), 'capability.not_granted');
    assert.deepEqual(await frozenRoles(fixture.companyId), [], `not frozen after ${i} denials`);
  }

  // The third denial is counted before the decision, so the limit means "three
  // is too many" rather than "four is too many".
  assert.equal(await attemptAndSwallow(broker, fixture, fixture.roleId), 'capability.not_granted');

  const frozen = await frozenRoles(fixture.companyId);
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]!.roleId, fixture.roleId);
  assert.match(frozen[0]!.reason ?? '', /3 denied attempts today/);
  assert.match(frozen[0]!.reason ?? '', /dns\.update/, 'the reason names what it kept reaching for');
});

test('a frozen role cannot act, even on a capability it was granted', async () => {
  // The freeze is about the role, not about the capability that tripped it.
  // A role that could keep working through its other grants would still be
  // burning budget on a configuration nobody has looked at.
  const fixture = await createCompany('freeze-blocks');
  await setThresholds(fixture.companyId, { roleFreezeDenialsPerDay: 1 });
  const { broker, calls } = await brokerFor();

  await attemptAndSwallow(broker, fixture, fixture.roleId);
  assert.equal((await frozenRoles(fixture.companyId)).length, 1);

  // Now grant the capability. The role is still frozen.
  await grantCapability(fixture, 'dns.update');
  assert.equal(await attemptAndSwallow(broker, fixture, fixture.roleId), 'role.frozen');
  assert.equal(calls.executions, 0, 'the adapter is never reached');
});

test('a frozen role is given no further work, delegated or otherwise', async () => {
  // A freeze that only stopped capability calls would let the role keep
  // starting tasks that cannot finish their work.
  const fixture = await createCompany('freeze-admission');
  await setThresholds(fixture.companyId, { roleFreezeDenialsPerDay: 1 });
  const { broker } = await brokerFor();

  const parent = await newTask(fixture, fixture.roleId);
  await attemptAndSwallow(broker, fixture, fixture.roleId);

  await assert.rejects(
    () => newTask(fixture, fixture.roleId),
    (error: unknown) => isPalugadaError(error, 'role.frozen'),
  );

  // And it cannot be routed around by delegation.
  await assert.rejects(
    () =>
      createSubTask(parent.id, {
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        divisionId: fixture.divisionId,
        roleId: fixture.roleId,
        input: { goal: 'dns' },
        reserveTokens: 1_000,
      }),
    (error: unknown) => isPalugadaError(error, 'role.frozen'),
  );
});

test('the freeze raises an incident, and only one', async () => {
  // An incident rather than an escalation: work of this kind has already
  // stopped, so it does not wait for the owner's window. And a second incident
  // per subsequent denial would bury the first.
  const fixture = await createCompany('freeze-incident');
  await setThresholds(fixture.companyId, { roleFreezeDenialsPerDay: 1 });
  const { broker } = await brokerFor();

  await attemptAndSwallow(broker, fixture, fixture.roleId);
  await attemptAndSwallow(broker, fixture, fixture.roleId);
  await attemptAndSwallow(broker, fixture, fixture.roleId);

  const items = await inbox.listOpen(fixture.companyId);
  const incidents = items.filter((item) => item.kind === 'incident');
  assert.equal(incidents.length, 1, 'the freeze is reported once, not once per attempt');
  assert.match(incidents[0]!.title, /frozen after repeated denials/);
  assert.match(incidents[0]!.rationale ?? '', /No task will run as this role/);

  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'role.frozen'",
    );
    return Number(rows[0]!.count);
  });
  assert.equal(events, 1);
});

test('denials are counted per role, not per company', async () => {
  // Counting per company would freeze whichever role happened to go last, and
  // leave the misconfigured one running.
  const fixture = await createCompany('freeze-per-role');
  await setThresholds(fixture.companyId, { roleFreezeDenialsPerDay: 3 });
  const other = await addRole(fixture, 'second');
  const { broker } = await brokerFor();

  for (let i = 0; i < 2; i += 1) {
    await attemptAndSwallow(broker, fixture, fixture.roleId);
    await attemptAndSwallow(broker, fixture, other);
  }

  // Four denials in the company, two per role: nothing is frozen.
  assert.deepEqual(await frozenRoles(fixture.companyId), []);

  await attemptAndSwallow(broker, fixture, other);
  const frozen = await frozenRoles(fixture.companyId);
  assert.deepEqual(frozen.map((row) => row.roleId), [other], 'only the role that crossed the line');
});

test('a role in another company is not touched', async () => {
  const mine = await createCompany('freeze-mine');
  const theirs = await createCompany('freeze-theirs');
  await setThresholds(mine.companyId, { roleFreezeDenialsPerDay: 1 });
  const { broker } = await brokerFor();

  await attemptAndSwallow(broker, mine, mine.roleId);

  assert.equal((await frozenRoles(mine.companyId)).length, 1);
  assert.deepEqual(await frozenRoles(theirs.companyId), []);
});

test('only the owner thaws a role, and then it works again', async () => {
  // Nothing unfreezes on a timer. The condition that caused the freeze -- a
  // prompt, a missing grant, a policy the role does not account for -- does not
  // fix itself by waiting, and a role that thawed overnight would spend
  // tomorrow the same way.
  const fixture = await createCompany('freeze-thaw');
  await setThresholds(fixture.companyId, { roleFreezeDenialsPerDay: 1 });
  const { broker, calls } = await brokerFor();

  await attemptAndSwallow(broker, fixture, fixture.roleId);
  await grantCapability(fixture, 'dns.update');
  assert.equal(await attemptAndSwallow(broker, fixture, fixture.roleId), 'role.frozen');

  await unfreezeRole(fixture.companyId, fixture.roleId);
  assert.deepEqual(await frozenRoles(fixture.companyId), []);

  assert.equal(await attemptAndSwallow(broker, fixture, fixture.roleId), 'allowed');
  assert.equal(calls.executions, 1, 'the role does real work once the owner lets it');

  const unfrozen = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'role.unfrozen'",
    );
    return Number(rows[0]!.count);
  });
  assert.equal(unfrozen, 1, 'thawing is on the record too');
});

test('the per-role limit sits below the company-wide denial alert', async () => {
  // If they were equal the freeze and the alert would always arrive together,
  // and the freeze would stop being the earlier, smaller intervention it is
  // meant to be.
  const fixture = await createCompany('freeze-ordering');
  const { thresholdsFor } = await import('../../src/reporting/alerts.ts');
  const thresholds = await thresholdsFor(fixture.companyId);
  assert.ok(
    thresholds.roleFreezeDenialsPerDay < thresholds.policyDenialsPerDay,
    `role freeze at ${thresholds.roleFreezeDenialsPerDay} must be below the ` +
      `company alert at ${thresholds.policyDenialsPerDay}`,
  );
});
