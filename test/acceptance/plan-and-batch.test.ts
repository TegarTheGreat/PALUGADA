/**
 * PRD v2 F8.11 and F8.13 -- the plan a task records before it acts, and the
 * guard that holds a batch to it.
 *
 * v2 section 2.3 lists the failure these exist for: an outreach agent
 * contacted 23 leads when it should have contacted 3. Nothing in the system
 * knew what "3" was, so nothing could notice. The tests are written around
 * that number.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { recordPlan, readPlan } from '../../src/engine/plan.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface Outreach {
  recipients: string[];
  subject: string;
}

/** The capability from the story: an external send that takes a list. */
function outreachCapability() {
  const sent: string[][] = [];
  const capability: Capability<Outreach, { sent: number }> = {
    name: 'email.send',
    adapter: 'test:mail',
    defaultTier: 2,
    describe(input) {
      // F8.13: the capability reports its own batch size. The broker never
      // guesses which argument is the list.
      return { batchSize: input.recipients.length };
    },
    async execute(input) {
      sent.push(input.recipients);
      return { sent: input.recipients.length };
    },
    async verify() {
      return true;
    },
  };
  return { capability, sent };
}

/** A tier 0 read, to show the gate applies where the PRD says and not wider. */
function readCapability() {
  const calls = { executions: 0 };
  const capability: Capability<{ zone: string }, { records: string[] }> = {
    name: 'dns.read',
    adapter: 'test:dns',
    defaultTier: 0,
    async execute() {
      calls.executions += 1;
      return { records: [] };
    },
  };
  return { capability, calls };
}

async function brokerWith(
  fixture: Fixture,
  ...capabilities: Array<Capability<never, never>>
): Promise<CapabilityBroker> {
  const registry = new CapabilityRegistry();
  for (const capability of capabilities) {
    registry.register(capability as Capability<unknown, unknown>);
  }
  // Synced before the grants: capability_grants has a foreign key to the
  // registry table, so a grant for a capability nobody registered is refused
  // by the database -- which is the behaviour, not an ordering quirk.
  await registry.sync();
  for (const capability of capabilities) {
    await grantCapability(fixture, capability.name);
  }
  return new CapabilityBroker(registry);
}

let sequence = 0;
async function newTask(fixture: Fixture) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `outreach-${sequence}` },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
}

function invoke<I>(
  broker: CapabilityBroker,
  fixture: Fixture,
  taskId: string,
  name: string,
  input: I,
) {
  return broker.invoke(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      taskId,
      roleId: fixture.roleId,
      idempotencyKey: `key-${taskId}`,
    },
    name,
    input,
  );
}

test('a tier 2 action without a plan is refused, and no adapter is touched (F8.11)', async () => {
  const fixture = await createCompany('plan-missing');
  const { capability, sent } = outreachCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  const task = await newTask(fixture);

  await assert.rejects(
    () => invoke(broker, fixture, task.id, 'email.send', {
      recipients: ['a@example.test'],
      subject: 'hello',
    }),
    (error: unknown) => {
      assert.ok(isPalugadaError(error, 'plan.required'));
      assert.match(error.message, /F8\.11/);
      return true;
    },
  );

  assert.deepEqual(sent, [], 'a refusal that arrives after the send is not a refusal');
});

test('a read needs no plan', async () => {
  // The requirement is about tier 2 and above. Demanding a plan from every
  // read would make the plan a formality, and a formality protects nothing.
  const fixture = await createCompany('plan-read');
  const { capability, calls } = readCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  const task = await newTask(fixture);

  await invoke(broker, fixture, task.id, 'dns.read', { zone: 'example.test' });
  assert.equal(calls.executions, 1);
});

test('the plan says three and the call carries twenty-three (F8.13)', async () => {
  // The PRD's own acceptance criterion, and the story it comes from.
  const fixture = await createCompany('plan-batch-guard');
  const { capability, sent } = outreachCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  const task = await newTask(fixture);

  await recordPlan(fixture.companyId, task.id, [
    {
      capability: 'email.send',
      intent: 'introduce the service to the three leads from the shortlist',
      expectedEffect: 'three leads have received one message each',
      batchSize: 3,
    },
  ]);

  const twentyThree = Array.from({ length: 23 }, (_, i) => `lead-${i}@example.test`);
  await assert.rejects(
    () => invoke(broker, fixture, task.id, 'email.send', {
      recipients: twentyThree,
      subject: 'hello',
    }),
    (error: unknown) => {
      assert.ok(isPalugadaError(error, 'plan.batch_mismatch'));
      assert.match(error.message, /covers 3 items and this call covers 23/);
      return true;
    },
  );

  assert.deepEqual(sent, [], 'nothing left the building');

  // F8.13: an incident, not a statistic. This is the case the guard exists
  // for, and the owner should see it even though nothing happened.
  const open = await inbox.listOpen(fixture.companyId);
  const incidents = open.filter((item) => item.kind === 'incident');
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.title, /Batch guard stopped email\.send/);
  assert.match(incidents[0]!.rationale, /covers 3 items and this call covers 23/);
  assert.match(incidents[0]!.rationale, /no adapter was called/);
});

test('a batch that matches the plan goes through', async () => {
  const fixture = await createCompany('plan-batch-match');
  const { capability, sent } = outreachCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  const task = await newTask(fixture);
  await planTask(fixture.companyId, task.id, [{ capability: 'email.send', batchSize: 3 }]);

  const result = await invoke(broker, fixture, task.id, 'email.send', {
    recipients: ['a@example.test', 'b@example.test', 'c@example.test'],
    subject: 'hello',
  });

  assert.deepEqual((result.output as { sent: number }).sent, 3);
  assert.equal(sent.length, 1);
});

test('a batch the plan never mentioned has nothing to be checked against', async () => {
  // A plan that names other steps is not a licence for this one. Letting it
  // through would mean any plan at all unlocked every batch.
  const fixture = await createCompany('plan-batch-unnamed');
  const { capability, sent } = outreachCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  const task = await newTask(fixture);
  await planTask(fixture.companyId, task.id, [{ capability: 'deploy.production' }]);

  await assert.rejects(
    () => invoke(broker, fixture, task.id, 'email.send', {
      recipients: ['a@example.test'],
      subject: 'hello',
    }),
    /no step for email\.send/,
  );
  assert.deepEqual(sent, []);
});

test('a plan step that declared no count does not authorise a batch', async () => {
  const fixture = await createCompany('plan-batch-uncounted');
  const { capability, sent } = outreachCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  const task = await newTask(fixture);
  await planTask(fixture.companyId, task.id, [{ capability: 'email.send' }]);

  await assert.rejects(
    () => invoke(broker, fixture, task.id, 'email.send', {
      recipients: ['a@example.test', 'b@example.test'],
      subject: 'hello',
    }),
    /declared\s+no count/,
  );
  assert.deepEqual(sent, []);
});

test('a plan cannot be rewritten once it is recorded', async () => {
  // The failure this rules out: an agent that finds itself with 23 recipients
  // deciding that was the plan all along.
  const fixture = await createCompany('plan-immutable');
  const task = await newTask(fixture);

  await recordPlan(fixture.companyId, task.id, [
    {
      capability: 'email.send',
      intent: 'contact three leads',
      expectedEffect: 'three leads contacted',
      batchSize: 3,
    },
  ]);

  await assert.rejects(
    () =>
      recordPlan(fixture.companyId, task.id, [
        {
          capability: 'email.send',
          intent: 'contact twenty-three leads',
          expectedEffect: 'twenty-three leads contacted',
          batchSize: 23,
        },
      ]),
    (error: unknown) => isPalugadaError(error, 'plan.already_recorded'),
  );

  const stored = await withTenant(fixture.companyId, (tx) => readPlan(tx, task.id));
  assert.equal(stored!.steps[0]!.batchSize, 3, 'the first plan stands');
});

test('a plan has to say something', async () => {
  const fixture = await createCompany('plan-empty');
  const task = await newTask(fixture);

  await assert.rejects(
    () => recordPlan(fixture.companyId, task.id, []),
    /a plan with no steps is not a plan/,
  );

  await assert.rejects(
    () =>
      recordPlan(fixture.companyId, task.id, [
        { capability: 'email.send', intent: '', expectedEffect: 'something happens' },
      ]),
    /must name a capability, an intent and the effect it expects/,
  );

  await assert.rejects(
    () =>
      recordPlan(fixture.companyId, task.id, [
        {
          capability: 'email.send',
          intent: 'send',
          expectedEffect: 'sent',
          batchSize: -1,
        },
      ]),
    /batch size that is not a count/,
  );
});

test('the plan reaches the owner with the approval (F10.2)', async () => {
  // F10.2 asks an approval item to say why. The plan is most of the answer,
  // so an owner deciding on a phone does not have to go looking for it.
  const fixture = await createCompany('plan-approval');
  const { capability, sent } = outreachCapability();
  const broker = await brokerWith(fixture, capability as Capability<never, never>);
  await grantCapability(fixture, 'email.send', { tierOverride: 3 });
  const task = await newTask(fixture);
  // The broker is called directly here rather than through the engine, so the
  // task has to be running before it can park on an approval.
  await transition(fixture.companyId, task.id, 'running');

  await recordPlan(fixture.companyId, task.id, [
    {
      capability: 'email.send',
      intent: 'introduce the service to the shortlist',
      expectedEffect: 'three leads have received one message each',
      batchSize: 3,
    },
  ]);

  await assert.rejects(
    () => invoke(broker, fixture, task.id, 'email.send', {
      recipients: ['a@example.test', 'b@example.test', 'c@example.test'],
      subject: 'hello',
    }),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );
  assert.deepEqual(sent, []);

  const stored = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { plan: { steps: Array<{ intent: string }> } } }>(
      "SELECT payload FROM inbox_items WHERE kind = 'approval'",
    );
    return rows[0]!.payload;
  });
  assert.equal(stored.plan.steps.length, 1);
  assert.match(stored.plan.steps[0]!.intent, /introduce the service/);
});

test('a plan belongs to one task and is not visible to another company', async () => {
  const mine = await createCompany('plan-mine');
  const theirs = await createCompany('plan-theirs');
  const task = await newTask(mine);
  await planTask(mine.companyId, task.id, [{ capability: 'email.send', batchSize: 3 }]);

  const seenByThem = await withTenant(theirs.companyId, (tx) => readPlan(tx, task.id));
  assert.equal(seenByThem, null, "another company's plan is not readable");
});
