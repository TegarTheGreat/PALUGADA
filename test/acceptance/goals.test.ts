/**
 * PRD v2 F2.7, F2.8 and F3.10 -- why a task exists, what finished looks like,
 * and who is allowed to change the answer to the first.
 *
 * F2.7's value shows up in F10.2: an approval item has to say why, and an
 * owner deciding on a phone at 07:00 will not follow a link to find out. So
 * the chain travels with the decision rather than being reachable from it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import {
  ancestryForTask,
  applyGoalChange,
  createGoal,
  proposeGoalChange,
  renderAncestry,
} from '../../src/domain/goals.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
import { assertTemplateIsCoherent } from '../../src/templates/company.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { COMPANY_OS } from '../../src/bundles/builtin.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerMfa, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;
/** `null` means "deliberately without a goal", which is not the same as "omitted". */
async function newTask(fixture: Fixture, goalId: string | null = fixture.goalId) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    ...(goalId === null ? {} : { goalId }),
    input: { goal: `goals-${sequence}` },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
}

test('a root task must say what it is for (F2.7)', async () => {
  const fixture = await createCompany('goal-required');

  await assert.rejects(
    () => newTask(fixture, null),
    (error: unknown) => {
      assert.ok(isPalugadaError(error, 'goal.required'));
      assert.match(error.message, /F2\.7/);
      return true;
    },
  );
});

test('a sub-task inherits the answer rather than being asked again', async () => {
  // Asking again would invite a different answer, and a delegation tree whose
  // branches serve different goals is a tree nobody can explain afterwards.
  const fixture = await createCompany('goal-inherited');
  const parent = await newTask(fixture);

  const child = await createSubTask(parent.id, {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    input: { step: 'child' },
    reserveTokens: 2_000,
  });

  assert.equal(child.goalId, fixture.goalId);
});

test('the chain reads from the mission down (F2.7)', async () => {
  const fixture = await createCompany('goal-chain');
  const keyResult = await createGoal({
    companyId: fixture.companyId,
    kind: 'key_result',
    slug: 'kr-uptime',
    statement: 'Uptime stays above 99.5% for a full month.',
    parentGoalId: fixture.goalId,
  });

  const task = await newTask(fixture, keyResult.id);
  const chain = await withTenant(fixture.companyId, (tx) => ancestryForTask(tx, task.id));

  assert.deepEqual(chain.map((goal) => goal.kind), ['mission', 'objective', 'key_result']);
  assert.match(renderAncestry(chain), /^mission: .*→ objective: .*→ key result: Uptime stays/);
});

test('the run is told what the work is for, above what it has already done', async () => {
  // Section 6.2 puts the chain after the memory that informs the work and
  // before the working memory of the task itself.
  const fixture = await createCompany('goal-context');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, {
      companyId: fixture.companyId,
      divisionId: fixture.divisionId,
      taskId: task.id,
    }),
  );

  const ancestryAt = context.sections.findIndex((s) => s.kind === 'goal_ancestry');
  assert.ok(ancestryAt >= 0, 'the chain is in the context');
  assert.match(context.sections[ancestryAt]!.body, /Keep the work moving/);

  const workingAt = context.sections.findIndex((s) => s.kind === 'working_memory');
  if (workingAt >= 0) assert.ok(ancestryAt < workingAt);
});

test('the approval item carries the chain, not a link to it (F10.2)', async () => {
  const fixture = await createCompany('goal-approval');
  const capability: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.nameservers',
    adapter: 'test:dns',
    defaultTier: 3,
    execute: async () => ({ ok: true }),
    verify: async () => true,
  };
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'dns.nameservers');

  const task = await newTask(fixture);
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.nameservers' }]);
  await transition(fixture.companyId, task.id, 'running');

  const broker = new CapabilityBroker(registry);
  await assert.rejects(
    () =>
      broker.invoke(
        {
          companyId: fixture.companyId,
          projectId: fixture.projectId,
          divisionId: fixture.divisionId,
          taskId: task.id,
          roleId: fixture.roleId,
          idempotencyKey: `key-${task.id}`,
        },
        'dns.nameservers',
        { zone: 'example.test' },
      ),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );

  const open = await inbox.listOpen(fixture.companyId);
  const approval = open.find((item) => item.kind === 'approval')!;
  assert.match(approval.rationale, /What this is for — mission:/);

  const payload = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { goalAncestry: Array<{ kind: string }> } }>(
      "SELECT payload FROM inbox_items WHERE kind = 'approval'",
    );
    return rows[0]!.payload;
  });
  assert.deepEqual(payload.goalAncestry.map((goal) => goal.kind), ['mission', 'objective']);
});

test('the ladder only goes one way', async () => {
  // A mission that hangs from something, or a key result hung straight off a
  // mission, would make "walk up to the mission" mean different things in
  // different companies.
  const fixture = await createCompany('goal-ladder');

  await assert.rejects(
    () =>
      createGoal({
        companyId: fixture.companyId,
        kind: 'mission',
        slug: 'second-mission',
        statement: 'Something else.',
        parentGoalId: fixture.goalId,
      }),
    /a mission is the top of the ladder/,
  );

  await assert.rejects(
    () =>
      createGoal({
        companyId: fixture.companyId,
        kind: 'objective',
        slug: 'orphan',
        statement: 'Floating.',
      }),
    /a goal of kind objective must hang from the level above it/,
  );

  const mission = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM goals WHERE kind = 'mission'",
    );
    return rows[0]!.id;
  });

  await assert.rejects(
    () =>
      createGoal({
        companyId: fixture.companyId,
        kind: 'key_result',
        slug: 'skipped',
        statement: 'Straight off the mission.',
        parentGoalId: mission,
      }),
    /a key_result cannot hang from a mission/,
  );
});

test("a goal cannot hang from another company's goal", async () => {
  // Row-level security cannot see this one: the control plane holds both
  // scopes, so the tenancy hole would be invisible to the policy.
  const mine = await createCompany('goal-mine');
  const theirs = await createCompany('goal-theirs');

  await assert.rejects(
    () =>
      createGoal({
        companyId: mine.companyId,
        kind: 'key_result',
        slug: 'borrowed',
        statement: 'Hanging off the neighbours.',
        parentGoalId: theirs.goalId,
      }),
    /cannot hang from another company's goal/,
  );
});

test('an agent reads the strategy and cannot change it (F3.10)', async () => {
  // Enforced by the grant rather than by a rule an agent is asked to follow.
  const fixture = await createCompany('goal-readonly');

  const readable = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM goals');
    return Number(rows[0]!.count);
  });
  assert.equal(readable, 2, 'the agent can see what it is working towards');

  await assert.rejects(
    () =>
      withTenant(fixture.companyId, async (tx) => {
        await tx.query("UPDATE goals SET statement = 'whatever I like' WHERE id = $1", [
          fixture.goalId,
        ]);
      }),
    /permission denied for table goals/,
  );
});

test('a proposed strategy change is the owner\'s decision (F3.10)', async () => {
  const fixture = await createCompany('goal-proposal');
  const task = await newTask(fixture);

  const { inboxItemId: itemId } = await proposeGoalChange({
    companyId: fixture.companyId,
    taskId: task.id,
    goal: fixture.goalId,
    proposedStatement: 'Grow revenue by shipping faster.',
    rationale: 'The current objective does not mention revenue at all.',
  });
  assert.ok(itemId);

  const open = await inbox.listOpen(fixture.companyId);
  const item = open.find((entry) => entry.id === itemId)!;
  assert.equal(item.kind, 'escalation', 'a strategy question gates nothing, so it parks nothing');
  assert.equal(item.tier, 3, 'changing what the company is for is structural');
  assert.match(item.rationale, /Currently: Keep the work moving/);
  assert.match(item.rationale, /Proposed: Grow revenue/);

  // The task that proposed it is untouched: an agent's opinion about strategy
  // must not cost the company the work it was doing.
  const proposer = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
      task.id,
    ]);
    return rows[0]!.status;
  });
  assert.equal(proposer, 'pending');

  // Nothing changed by proposing it.
  const before = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ statement: string }>(
      'SELECT statement FROM goals WHERE id = $1',
      [fixture.goalId],
    );
    return rows[0]!.statement;
  });
  assert.match(before, /Keep the work moving/);

  await applyGoalChange({
    companyId: fixture.companyId,
    goalId: fixture.goalId,
    statement: 'Grow revenue by shipping faster.',
  });
  const after = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ statement: string }>(
      'SELECT statement FROM goals WHERE id = $1',
      [fixture.goalId],
    );
    return rows[0]!.statement;
  });
  assert.equal(after, 'Grow revenue by shipping faster.');
});

test('a run proposes a goal change with goal.propose, and the owner\'s yes is the change (F3.10)', async () => {
  // `proposeGoalChange` was "the agent's path" and no agent could reach it:
  // the strategist was told to write goal changes as proposals and had no
  // tool to write one with. And approving the item changed nothing -- the
  // owner then had to make the same edit again by hand.
  const fixture = await createCompany('goal-propose-tool');
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'goal.propose');
  const strategist = await newTask(fixture);
  await transition(fixture.companyId, strategist.id, 'running');
  const broker = new CapabilityBroker(registry);
  let key = 0;
  const propose = (input: Record<string, unknown>) => broker.invoke<unknown, { proposed: boolean; inboxItemId: string; note?: string }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: strategist.id, idempotencyKey: `propose-${key += 1}`,
  }, 'goal.propose', input);
  const goalNow = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ statement: string; status: string }>(
    'SELECT statement, status FROM goals WHERE id = $1', [fixture.goalId]))).rows[0]!;

  await assert.rejects(propose({ goal: 'nowhere', statement: 'x', why: 'y' }),
    /no goal nowhere in this company; name one by its slug: mission, objective/);
  await assert.rejects(propose({ goal: 'objective', why: 'y' }), /a new statement, a new status, or both/);

  const first = (await propose({
    goal: 'objective', statement: 'Ten paying cafes in Bandung by December.',
    why: 'Revenue is flat for six weeks; the objective names no customer.',
  })).output;
  assert.equal(first.proposed, true);
  const [item] = (await inbox.listOpen(fixture.companyId)).filter((open) => open.id === first.inboxItemId);
  assert.equal(item!.kind, 'escalation');
  assert.equal(item!.tier, 3, 'what the company is for takes the owner\'s device');
  assert.equal(item!.taskId, null, 'a no to the proposal is not a stop to the work that made it');
  assert.match(item!.rationale, /Currently: Keep the work moving/);
  assert.match(item!.rationale, /Proposed: Ten paying cafes/);
  assert.match(item!.rationale, /Revenue is flat/);
  assert.equal((await goalNow()).statement, 'Keep the work moving without surprising the owner.', 'proposing changes nothing');
  const again = (await propose({ goal: fixture.goalId, statement: 'Something else.', why: 'z' })).output;
  assert.deepEqual([again.proposed, again.inboxItemId], [false, first.inboxItemId], 'one proposal about a goal at a time');

  // The owner's yes, with their device, is the change.
  await assert.rejects(inbox.decide(fixture.companyId, first.inboxItemId, 'approve', ''),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'));
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/goal-totp', secret);
  const mfa = new OwnerMfa({ secrets });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/goal-totp' });
  let drift = 0;
  const code = () => totpCode(decodeBase32(secret), stepFor(new Date()) + drift++);
  await inbox.decide(fixture.companyId, first.inboxItemId, 'approve', 'Yes.', { channel: 'app', proof: { totp: code() }, mfa });
  assert.equal((await goalNow()).statement, 'Ten paying cafes in Bandung by December.');
  const { rows: changed } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE type = 'goal.changed' ORDER BY occurred_at DESC LIMIT 1"));
  assert.equal(changed[0]!.payload.inboxItemId, first.inboxItemId);

  // A proposal about a goal the owner has changed since is refused, not applied over them.
  const stale = (await propose({ goal: 'objective', status: 'abandoned', why: 'Nobody will pay.' })).output;
  await applyGoalChange({ companyId: fixture.companyId, goalId: fixture.goalId, statement: 'The owner\'s own words.' });
  await assert.rejects(
    inbox.decide(fixture.companyId, stale.inboxItemId, 'approve', '', { channel: 'app', proof: { totp: code() }, mfa }),
    /the goal has changed since this was proposed/);
  await inbox.decide(fixture.companyId, stale.inboxItemId, 'deny', 'Not yet.');
  assert.deepEqual(await goalNow(), { statement: 'The owner\'s own words.', status: 'active' });
  const { rows: still } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
    'SELECT status FROM tasks WHERE id = $1', [strategist.id]));
  assert.equal(still[0]!.status, 'running', 'the strategist carries on under the goals as they are');

  // The kit's strategist holds it, within the tools a role may have.
  const tools = COMPANY_OS.body.roles.find((role) => role.slug === 'strategist')!.tools ?? [];
  assert.ok(tools.includes('goal.propose'));
  assert.ok(tools.length <= 12);
  assert.ok(COMPANY_OS.body.grants.some((grant) => grant.division === 'strategy' && grant.capability === 'goal.propose'));
});

test('a role that cannot say what done looks like is given no work (F2.8)', async () => {
  // v2 section 2.3 traces a surprise bill to exactly this: vague instructions
  // and nothing able to tell whether the work was finished, so it was asked
  // again and again.
  const fixture = await createCompany('goal-done-criteria');

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET done_criteria = '{}' WHERE id = $1", [fixture.roleId]);
  });
  await assert.rejects(
    () => newTask(fixture),
    (error: unknown) => {
      assert.ok(isPalugadaError(error, 'role.incomplete'));
      assert.match(error.message, /at least one done_criteria/);
      return true;
    },
  );

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `UPDATE roles SET done_criteria = ARRAY['the zone resolves'],
                        output_schema = '{}'::jsonb WHERE id = $1`,
      [fixture.roleId],
    );
  });
  await assert.rejects(
    () => newTask(fixture),
    (error: unknown) => {
      assert.ok(isPalugadaError(error, 'role.incomplete'));
      assert.match(error.message, /an output schema/);
      return true;
    },
  );
});

test('a template role without either is refused when the template is saved (F2.8)', () => {
  // The template is where the defect can still be fixed cheaply, rather than
  // at the first task that tries to run.
  assert.throws(
    () =>
      assertTemplateIsCoherent({
        divisions: [{ slug: 'ops', name: 'Ops' }],
        roles: [
          { slug: 'operator', division: 'ops', systemPrompt: 'p', model: 'm',
            outputSchema: { type: 'object' } },
        ],
      }),
    /declares no done_criteria/,
  );

  assert.throws(
    () =>
      assertTemplateIsCoherent({
        divisions: [{ slug: 'ops', name: 'Ops' }],
        roles: [
          { slug: 'operator', division: 'ops', systemPrompt: 'p', model: 'm',
            doneCriteria: ['it is done'] },
        ],
      }),
    /declares no output schema/,
  );
});

test("one company's goals are invisible to another", async () => {
  const mine = await createCompany('goals-mine');
  const theirs = await createCompany('goals-theirs');

  const seen = await withTenant(mine.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM goals');
    return rows.map((row) => row.id);
  });
  assert.equal(seen.length, 2);
  assert.equal(seen.includes(theirs.goalId), false);
});
