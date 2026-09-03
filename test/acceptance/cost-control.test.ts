/**
 * PRD F8.5 and section 8.8's "cek budget" for tier 2.
 *
 * Two failures are being ruled out. The first is spending money nobody
 * authorised: until now the broker read a capability's declared cost, handed
 * it to the policy engine as a fact, and never charged it -- so a money
 * ceiling constrained model calls and nothing else. The second is an estimate
 * that is quietly wrong, which makes every budget check that depends on it
 * decorative while the totals still add up.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { DRIFT_THRESHOLD } from '../../src/broker/cost.ts';
import { Engine } from '../../src/engine/engine.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import * as budget from '../../src/engine/budget.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompanyFromTemplate } from '../../src/templates/company.ts';
import { limitFor } from '../../src/governance/spend-guard.ts';
import { STANDARD_TEMPLATE_SLUG, installStandardTemplate } from '../../src/templates/standard.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { createCompany, grantCapability, type Fixture, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface SendInput {
  to: string;
  quantity: number;
}

/**
 * A capability whose price is per-call and whose bill arrives afterwards.
 *
 * `estimatedCostCents` on the registry is a flat figure; `describe()` is where
 * a real capability says what *this* call will cost, and the difference
 * between that and `actualCostCents()` is what F8.5 watches.
 */
function meteredCapability(options: {
  centsPerUnit?: number;
  /** Explicit `undefined` means the capability measured nothing at all. */
  actual?: number | null | undefined;
  fail?: boolean;
} = {}) {
  const calls = { executions: 0 };
  const capability: Capability<SendInput, { sent: boolean }> = {
    name: 'email.send',
    adapter: 'test:mail',
    defaultTier: 2,
    estimatedCostCents: 0,
    describe(input) {
      return { moneyCents: (options.centsPerUnit ?? 10) * input.quantity };
    },
    async execute() {
      calls.executions += 1;
      if (options.fail) throw new Error('the provider refused the message');
      return { sent: true };
    },
    async verify() {
      return true;
    },
    async actualCostCents() {
      return options.actual === undefined ? null : options.actual;
    },
  };
  return { capability, calls };
}

async function invoke(
  fixture: Fixture,
  capability: Capability<SendInput, { sent: boolean }>,
  input: SendInput,
) {
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, capability.name);

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: { goal: 'send' },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
  // F8.11: email.send is tier 2, so the plan comes first. The batch size is
  // declared to match, since this file is about cost rather than the guard.
  await planTask(fixture.companyId, task.id, [{ capability: capability.name }]);

  const broker = new CapabilityBroker(registry);
  return broker.invoke<SendInput, { sent: boolean }>(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      taskId: task.id,
      roleId: fixture.roleId,
      idempotencyKey: `key-${task.id}`,
    },
    capability.name,
    input,
  );
}

async function moneySpent(fixture: Fixture): Promise<number> {
  return withTenant(fixture.companyId, async (tx) => {
    const snapshot = await budget.snapshot(tx, fixture.budgetAccountId);
    return snapshot.moneySpentCents;
  });
}

async function eventsOfType(companyId: string, type: string) {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM events WHERE type = $1 ORDER BY occurred_at',
      [type],
    );
    return rows.map((row) => row.payload);
  });
}

test('a declared cost is charged against the budget', async () => {
  const fixture = await createCompany('cost-charged', { moneyMaxCents: 1_000 });
  const { capability } = meteredCapability({ centsPerUnit: 10, actual: undefined });

  const result = await invoke(fixture, capability, { to: 'a@example.com', quantity: 3 });

  assert.equal(result.cost.estimatedCents, 30);
  assert.equal(await moneySpent(fixture), 30, 'the estimate is charged, not merely observed');
});

test('an action the budget cannot cover never reaches the adapter', async () => {
  // The same rule F2.4 states for grants: a refusal issued after the request
  // has left is not a refusal.
  const fixture = await createCompany('cost-refused', { moneyMaxCents: 25 });
  const { capability, calls } = meteredCapability({ centsPerUnit: 10 });

  await assert.rejects(
    () => invoke(fixture, capability, { to: 'a@example.com', quantity: 3 }),
    (error: unknown) => isPalugadaError(error, 'budget.exceeded'),
  );

  assert.equal(calls.executions, 0, 'nothing was sent');
  assert.equal(await moneySpent(fixture), 0, 'and nothing was charged');

  const refusals = await eventsOfType(fixture.companyId, 'budget.refused');
  assert.equal(refusals.length, 1, 'the refusal is recorded, not only thrown');
  assert.equal(refusals[0]!.estimatedCents, 30);
});

test('a call that fails leaves no charge behind', async () => {
  const fixture = await createCompany('cost-refund', { moneyMaxCents: 1_000 });
  const { capability } = meteredCapability({ centsPerUnit: 10, fail: true });

  await assert.rejects(
    () => invoke(fixture, capability, { to: 'a@example.com', quantity: 5 }),
    /the provider refused the message/,
  );

  assert.equal(await moneySpent(fixture), 0, 'the estimate is returned when the action did not happen');
});

test('an actual cost more than half above the estimate raises cost.drift (F8.5)', async () => {
  const fixture = await createCompany('cost-drift-up', { moneyMaxCents: 10_000 });
  // Estimated 100, billed 300: two hundred percent out.
  const { capability } = meteredCapability({ centsPerUnit: 100, actual: 300 });

  const result = await invoke(fixture, capability, { to: 'a@example.com', quantity: 1 });

  assert.equal(result.cost.estimatedCents, 100);
  assert.equal(result.cost.actualCents, 300);
  assert.equal(result.cost.drifted, true);
  assert.equal(await moneySpent(fixture), 300, 'the account settles to what was actually billed');

  const drifts = await eventsOfType(fixture.companyId, 'cost.drift');
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]!.estimatedCents, 100);
  assert.equal(drifts[0]!.actualCents, 300);
  assert.equal(drifts[0]!.ratio, 2);
  assert.equal(drifts[0]!.reason, 'estimate_off_by_more_than_half');
});

test('an actual cost below the estimate drifts too, and refunds the difference', async () => {
  // An estimate that is too high is also a broken budget check: it refuses
  // actions the company could afford. Only reporting overruns would leave that
  // half invisible.
  const fixture = await createCompany('cost-drift-down', { moneyMaxCents: 10_000 });
  const { capability } = meteredCapability({ centsPerUnit: 100, actual: 10 });

  const result = await invoke(fixture, capability, { to: 'a@example.com', quantity: 1 });

  assert.equal(result.cost.drifted, true);
  assert.equal(await moneySpent(fixture), 10);
  const drifts = await eventsOfType(fixture.companyId, 'cost.drift');
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]!.ratio, 0.9);
});

test('an estimate that lands within half raises nothing', async () => {
  const fixture = await createCompany('cost-no-drift', { moneyMaxCents: 10_000 });
  // 140 against an estimate of 100 is a ratio of 0.4, under the threshold.
  const { capability } = meteredCapability({ centsPerUnit: 100, actual: 140 });

  const result = await invoke(fixture, capability, { to: 'a@example.com', quantity: 1 });

  assert.equal(result.cost.drifted, false);
  assert.ok(0.4 < DRIFT_THRESHOLD, 'the case is inside the threshold on purpose');
  assert.equal(await moneySpent(fixture), 140, 'settled anyway; only the event is conditional');
  assert.deepEqual(await eventsOfType(fixture.companyId, 'cost.drift'), []);
});

test('a cost nobody estimated is drift of its own kind', async () => {
  // The worst case, and the one a ratio cannot express: the budget was never
  // consulted because the capability said the call was free.
  const fixture = await createCompany('cost-unestimated', { moneyMaxCents: 10_000 });
  const { capability } = meteredCapability({ centsPerUnit: 0, actual: 250 });

  const result = await invoke(fixture, capability, { to: 'a@example.com', quantity: 1 });

  assert.equal(result.cost.estimatedCents, 0);
  assert.equal(result.cost.drifted, true);
  assert.equal(await moneySpent(fixture), 250);

  const drifts = await eventsOfType(fixture.companyId, 'cost.drift');
  assert.equal(drifts[0]!.ratio, null, 'there is no ratio to report, and none is invented');
  assert.equal(drifts[0]!.reason, 'unestimated');
});

test('a capability that measures nothing is not reported as free', async () => {
  // "This call cost nothing" and "nobody measured this call" are different
  // facts. Reading the second as the first would raise a 100% drift on every
  // unmeasured capability and bury the real ones.
  const fixture = await createCompany('cost-unmeasured', { moneyMaxCents: 10_000 });
  const { capability } = meteredCapability({ centsPerUnit: 100, actual: undefined });

  const result = await invoke(fixture, capability, { to: 'a@example.com', quantity: 1 });

  assert.equal(result.cost.actualCents, null);
  assert.equal(result.cost.drifted, false);
  assert.deepEqual(await eventsOfType(fixture.companyId, 'cost.drift'), []);
  assert.equal(await moneySpent(fixture), 100, 'the estimate stands as the only figure there is');
});

test('a company from the standard template works, and its ceilings are the two the PRD asks for', async () => {
  // Section 14.3 is answered: USD 200 a company a month. That figure lives in
  // spend_limits and is enforced per calendar month; the budget account is the
  // other ceiling F1.9 names, the lifetime allowance a delegation tree shares.
  // Both must hold, and neither substitutes for the other.
  await registerStandardCatalogue();
  await installStandardTemplate();
  const created = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: 'standard-budget',
    name: 'Standard Budget',
  });

  const limit = await limitFor(created.companyId);
  assert.equal(limit.moneyMaxCents, 20_000, 'USD 200 a month, from the platform default');

  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    handlers: new Map([
      ['coordinator', async (ctx) => {
        const plan = await ctx.llm({
          system: 'You run operations.',
          messages: [{ role: 'user', content: 'check the service' }],
        });
        return { summary: plan };
      }],
    ]),
  });

  const task = await createRootTask({
    companyId: created.companyId,
    projectId: created.projectIds.main!,
    divisionId: created.divisionIds.ops!,
    roleId: created.roleIds.coordinator!,
    budgetAccountId: created.budgetAccountId,
    input: { goal: 'check the service' },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });

  // The company is operable on arrival now that the ceiling is set, which is
  // what an answered open question is supposed to change.
  const ran = await engine.runTask(created.companyId, task.id, 'coordinator');
  assert.equal(ran.status, 'completed');
});
