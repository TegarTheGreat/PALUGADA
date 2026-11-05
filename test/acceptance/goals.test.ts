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
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import {
  ancestryFor,
  ancestryForTask,
  applyGoalChange,
  createGoal,
  goalsIn,
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
import { OwnerMfa, TOTP_STEP_SECONDS, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { changeMetric, defineMetric, recordObservation } from '../../src/domain/metrics.ts';
import { proposeGoalPlan } from '../../src/domain/goal-plans.ts';
import { CHANNELS } from '../../src/domain/channels.ts';
import { structureOf } from '../../src/owner/views.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { addRole, createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
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

/**
 * A goal is not met on an agent's say-so (the audit of 3 October, P0-6). The
 * owner's card for "met" carried only the agent's prose, and nothing compared
 * it to the goal's own measure: an agent could have a goal closed that its
 * checked number said was short. A measure read back from its source, or typed
 * by the owner, that is short of its target now stops the proposal where it is
 * made, and every proposal to close or give up a goal carries where the
 * measures stand, as the platform reads them.
 */
test('a goal cannot be proposed as met while its checked measure is short of target; the card says where the measures stand', async () => {
  const fixture = await createCompany('goal-met-evidence');
  const task = await newTask(fixture);
  const metricId = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'weekly-orders', name: 'Orders a week', unit: 'count', baseline: 0, target: 100,
  });
  await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: metricId, value: 40, recordedBy: 'owner', note: 'from the shop',
  }));

  await assert.rejects(
    proposeGoalChange({
      companyId: fixture.companyId, taskId: task.id, goal: fixture.goalId, proposedStatus: 'met',
      rationale: 'The orders are where we wanted them.',
    }),
    (error: unknown) => isPalugadaError(error, 'contract.violation')
      && /"Orders a week" reads 40, checked at its source, short of its target 100/.test(error.message),
  );
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 0, 'and nothing reaches the owner');

  // Not met by a number nobody checked either: shown to the owner as what it is.
  await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: metricId, value: 120, recordedBy: 'agent', taskId: task.id,
  }));
  const proposed = await proposeGoalChange({
    companyId: fixture.companyId, taskId: task.id, goal: fixture.goalId, proposedStatus: 'met',
    rationale: 'Orders passed the target this week.',
  });
  assert.equal(proposed.proposed, true);
  const card = (await inbox.listOpen(fixture.companyId)).find((item) => item.id === proposed.inboxItemId)!;
  assert.match(card.rationale, /Where its measures stand, as the platform reads them:/);
  assert.match(card.rationale, /Orders a week: 120 against a target of 100, reported and not checked\./);

  // Giving up shows the same evidence, and is not refused for it.
  const second = await createCompany('goal-abandon-evidence');
  const secondTask = await newTask(second);
  await defineMetric(second.companyId, { goalId: second.goalId, slug: 'signups', name: 'Sign-ups', unit: 'count', baseline: 0, target: 50 });
  const abandoned = await proposeGoalChange({
    companyId: second.companyId, taskId: secondTask.id, goal: second.goalId, proposedStatus: 'abandoned', rationale: 'Nobody wants it.',
  });
  const abandonCard = (await inbox.listOpen(second.companyId)).find((item) => item.id === abandoned.inboxItemId)!;
  assert.match(abandonCard.rationale, /Sign-ups: no value recorded yet, against a target of 50\./);

  // A goal with no measure is as it was: the owner's judgement, with the reason given.
  const bare = await createCompany('goal-met-bare');
  const bareTask = await newTask(bare);
  const bareProposal = await proposeGoalChange({
    companyId: bare.companyId, taskId: bareTask.id, goal: bare.goalId, proposedStatus: 'met', rationale: 'Done.',
  });
  assert.equal(bareProposal.proposed, true);
  const bareCard = (await inbox.listOpen(bare.companyId)).find((item) => item.id === bareProposal.inboxItemId)!;
  assert.doesNotMatch(bareCard.rationale, /Where its measures stand/);
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

/* ------------------------------------------- F18.1, F18.11: periods and seats --- */

/** A quarterly priority under `parent`: a key result with a quarter's period, one seat and a finish line. */
function priority(fixture: Fixture, slug: string, options: { parentGoalId?: string; ownerRoleId?: string } = {}) {
  return createGoal({
    companyId: fixture.companyId,
    kind: 'key_result',
    slug,
    statement: `Priority ${slug}.`,
    parentGoalId: options.parentGoalId ?? fixture.goalId,
    startsOn: '2026-10-01',
    dueOn: '2026-12-31',
    ownerRoleId: options.ownerRoleId ?? fixture.roleId,
    commitment: 'committed',
    doneWhen: `${slug} is live.`,
  });
}

test('a quarter key result without a seat is refused by the database (F18.1)', async () => {
  // Refused by the trigger, not by createGoal: the ladder is the owner's,
  // written on the control plane, and a rule in the code would be one a
  // migration, an import or psql could step round.
  const fixture = await createCompany('goal-seat');
  const insert = (columns: Record<string, unknown>) => withControlPlane(async (tx) => {
    const names = ['company_id', 'parent_goal_id', 'kind', 'slug', 'statement', ...Object.keys(columns)];
    const values = [fixture.companyId, fixture.goalId, 'key_result', `kr-${Object.keys(columns).join('-')}-${sequence += 1}`, 'A priority.',
      ...Object.values(columns)];
    await tx.query(
      `INSERT INTO goals (${names.join(', ')}) VALUES (${names.map((_name, index) => `$${index + 1}`).join(', ')})`,
      values);
  });

  await assert.rejects(insert({ starts_on: '2026-10-01', due_on: '2026-12-31', done_when: 'It ships.' }),
    /a key result of a quarter or less is a quarterly priority, and has one owning seat/);
  await assert.rejects(insert({ starts_on: '2026-10-01', due_on: '2026-12-31', owner_role_id: fixture.roleId }),
    /the quarterly priority "kr-.*" says when it is done: write what is true once it is done, or measure it by a number/);
  await assert.rejects(insert({ starts_on: '2026-10-01' }), /a period has a start and a due date, or neither/);
  await assert.rejects(insert({ starts_on: '2026-12-31', due_on: '2026-10-01' }), /a goal is due after it starts/);
  await assert.rejects(insert({ commitment: 'committed' }), /a committed goal has a period/);
  await assert.rejects(insert({ commitment: 'certain', starts_on: '2026-01-01', due_on: '2026-12-31' }), /goals_commitment_known/);
  await assert.rejects(insert({ channel: 'billboards' }), /goals_channel_known/);
  await assert.rejects(insert({ done_when: 'x'.repeat(501) }), /goals_done_when_short/);
  await assert.rejects(withControlPlane((tx) => tx.query(
    `UPDATE goals SET starts_on = '2026-01-01', due_on = '2026-12-31'
      WHERE company_id = $1 AND kind = 'mission'`, [fixture.companyId])),
  /a mission is the company's direction and has no period, seat, commitment, definition of done or channel/);

  // The seat is a role of the same company, whatever id is sent.
  const other = await createCompany('goal-seat-other');
  await assert.rejects(insert({ starts_on: '2026-10-01', due_on: '2026-12-31', done_when: 'It ships.', owner_role_id: other.roleId }),
    /goals_owner_role_fkey/);

  // A measure is a finish line too, and it can only be written after its
  // goal: the two in one transaction are checked together, at commit.
  await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO goals (company_id, parent_goal_id, kind, slug, statement, starts_on, due_on, owner_role_id)
       VALUES ($1, $2, 'key_result', 'measured', 'Revenue grows.', '2026-10-01', '2026-12-31', $3) RETURNING id`,
      [fixture.companyId, fixture.goalId, fixture.roleId]);
    await tx.query(
      `INSERT INTO goal_metrics (company_id, goal_id, slug, name, unit, target) VALUES ($1, $2, 'revenue', 'Revenue', 'currency', 100)`,
      [fixture.companyId, rows[0]!.id]);
  });
  // A year's key result is not a quarterly priority, and needs neither.
  await insert({ starts_on: '2026-01-01', due_on: '2026-12-31' });
  // And a goal with neither period nor seat is what it always was.
  await insert({});

  // createGoal says the same, and checks what the owner typed before the database does.
  await assert.rejects(createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'no-seat', statement: 'x', parentGoalId: fixture.goalId,
    startsOn: '2026-10-01', dueOn: '2026-12-31', doneWhen: 'Done.',
  }), /has one owning seat/);
  await assert.rejects(createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'bad-day', statement: 'x', parentGoalId: fixture.goalId,
    startsOn: '1 October', dueOn: '2026-12-31',
  }), /startsOn is a day written YYYY-MM-DD, such as 2026-10-01; got 1 October/);
  await assert.rejects(createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'bad-channel', statement: 'x', parentGoalId: fixture.goalId,
    channel: 'billboards',
  }), /channel is one of targeting_blogs, publicity, .*community_building; got billboards/);
  await assert.rejects(createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'their-seat', statement: 'x', parentGoalId: fixture.goalId,
    ownerRoleId: other.roleId,
  }), /no role .* in this company: the owning seat is one of this company's roles/);
});

test('more than 7 priorities in a quarter warns and does not refuse (F18.1)', async () => {
  // Soft limits: the sources disagree on the number, and a company that
  // holds eight priorities has made a choice the owner may want to make. So
  // the platform says so, on the answer and on the card, and stores the goal.
  const fixture = await createCompany('goal-limits');
  const second = await addRole(fixture, 'second-seat');
  const otherObjective = await createGoal({
    companyId: fixture.companyId, kind: 'objective', slug: 'second-objective', statement: 'A second objective.',
    parentGoalId: (await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
      "SELECT id FROM goals WHERE kind = 'mission'"))).rows[0]!.id,
  });
  // Four under each objective and four for each seat: only the quarter is full.
  const made = [];
  for (let index = 1; index <= 8; index += 1) {
    made.push(await priority(fixture, `p${index}`, {
      parentGoalId: index % 2 ? fixture.goalId : otherObjective.id,
      ownerRoleId: index <= 4 ? fixture.roleId : second,
    }));
  }
  assert.deepEqual(made[6]!.warnings, [], 'seven is within the limit');
  assert.deepEqual(made[7]!.warnings, [{ kind: 'quarter_priorities', count: 8, limit: 7 }]);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM goals WHERE kind = 'key_result'"));
  assert.equal(rows[0]!.count, 8, 'and every one of them is kept');

  // A sixth for one seat, and a sixth under one objective, say so as well.
  const ninth = await priority(fixture, 'p9');
  assert.deepEqual(ninth.warnings, [{ kind: 'quarter_priorities', count: 9, limit: 7 }], 'five for a seat and under an objective is within');
  const tenth = await priority(fixture, 'p10');
  assert.deepEqual(tenth.warnings, [
    { kind: 'objective_key_results', count: 6, limit: 5, goalId: fixture.goalId },
    { kind: 'quarter_priorities', count: 10, limit: 7 },
    { kind: 'seat_priorities', count: 6, limit: 5, roleId: fixture.roleId },
  ]);

  // This year's goals: more than five objectives with a year's period.
  for (let index = 1; index <= 6; index += 1) {
    const year = await createGoal({
      companyId: fixture.companyId, kind: 'objective', slug: `year-${index}`, statement: `Year goal ${index}.`,
      parentGoalId: otherObjective.parentGoalId, startsOn: '2026-01-01', dueOn: '2026-12-31', commitment: 'aspirational',
    });
    assert.deepEqual(year.warnings, index <= 5 ? [] : [{ kind: 'year_goals', count: 6, limit: 5 }]);
  }

  // The owner's card is drawn from the structure, which carries the same warnings.
  const structure = await structureOf(fixture.companyId);
  const card = structure.goals.find((goal) => goal.slug === 'p10')!;
  assert.deepEqual(card.warnings.map((warning) => warning.kind), ['quarter_priorities', 'seat_priorities']);
  assert.deepEqual(structure.goals.find((goal) => goal.slug === 'objective')!.warnings,
    [{ kind: 'objective_key_results', count: 6, limit: 5, goalId: fixture.goalId }], 'the crowded objective says so on its own card');
  assert.deepEqual(
    { ...card, warnings: undefined, metrics: undefined, tasksDone: undefined, tasksTotal: undefined, id: undefined, parentId: undefined },
    {
      id: undefined, parentId: undefined, ownerRole: 'worker', kind: 'key_result', slug: 'p10', statement: 'Priority p10.', status: 'active',
      startsOn: '2026-10-01', dueOn: '2026-12-31', ownerRoleId: fixture.roleId, commitment: 'committed', doneWhen: 'p10 is live.',
      channel: null, period: 'quarter', warnings: undefined, metrics: undefined, tasksDone: undefined, tasksTotal: undefined,
    });
});

test('the run context shows the period, commitment and seat (F18.1)', async () => {
  const fixture = await createCompany('goal-period-context');
  const keyResult = await createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'ten-cafes', statement: 'Ten cafes pay for the service.',
    parentGoalId: fixture.goalId, startsOn: '2026-10-01', dueOn: '2026-12-31', ownerRoleId: fixture.roleId,
    commitment: 'learning', doneWhen: 'Ten cafes have paid an invoice.', channel: 'sales',
  });
  const task = await newTask(fixture, keyResult.id);
  await transition(fixture.companyId, task.id, 'running');
  const context = await withTenant(fixture.companyId, (tx) => buildContext(tx, {
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id,
  }));
  const ancestry = context.sections.find((section) => section.kind === 'goal_ancestry')!.body;
  assert.match(ancestry,
    /→ key result \(quarterly priority; 2026-10-01 to 2026-12-31; learning; owned by worker; done when: Ten cafes have paid an invoice\.; tests the channel Sales: finding, talking to and closing customers one by one\): Ten cafes pay/);
  // The objective above it has none of these, and reads as it did.
  assert.match(ancestry, /→ objective: Keep the work moving/);
});

test('the export round-trips the columns (F18.1, F16.4)', async () => {
  const fixture = await createCompany('goal-period-export');
  const keyResult = await createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'first-sale', statement: 'The first sale.',
    parentGoalId: fixture.goalId, startsOn: '2026-10-01', dueOn: '2026-12-31', ownerRoleId: fixture.roleId,
    commitment: 'aspirational', doneWhen: 'A customer has paid.', channel: 'targeting_blogs',
  });
  // And one measured rather than worded, whose measure is restored after it.
  const measured = await createGoal({
    companyId: fixture.companyId, kind: 'key_result', slug: 'measured', statement: 'Revenue grows.',
    parentGoalId: fixture.goalId, startsOn: '2026-10-01', dueOn: '2026-12-31', ownerRoleId: fixture.roleId,
    commitment: 'committed', doneWhen: 'Revenue is 100.',
  });
  await defineMetric(fixture.companyId, { goalId: measured.id, slug: 'revenue', name: 'Revenue', unit: 'currency', target: 100 });
  await applyGoalChange({ companyId: fixture.companyId, goalId: measured.id, doneWhen: null });

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const row = lines.find((line) => line.section === 'goals' && line.row.id === keyResult.id)!.row;
  assert.deepEqual(
    [row.starts_on, row.due_on, row.owner_role_id, row.commitment, row.done_when, row.channel],
    ['2026-10-01', '2026-12-31', fixture.roleId, 'aspirational', 'A customer has paid.', 'targeting_blogs']);

  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{
    slug: string; starts_on: string; due_on: string; commitment: string; done_when: string | null; channel: string | null; seat: string;
  }>(
    `SELECT g.slug, g.starts_on::text, g.due_on::text, g.commitment, g.done_when, g.channel, r.slug AS seat
       FROM goals g JOIN roles r ON r.id = g.owner_role_id ORDER BY g.slug`));
  assert.deepEqual(rows, [
    { slug: 'first-sale', starts_on: '2026-10-01', due_on: '2026-12-31', commitment: 'aspirational',
      done_when: 'A customer has paid.', channel: 'targeting_blogs', seat: 'worker' },
    { slug: 'measured', starts_on: '2026-10-01', due_on: '2026-12-31', commitment: 'committed',
      done_when: null, channel: null, seat: 'worker' },
  ]);
});

test('a quarterly priority cannot lose its last finish line by retiring its measure (F18.1)', async () => {
  // Words cleared because a measure says when it is done, then the measure
  // retired, was a priority no route could make again: the archive's import
  // replays it and the commit refused it, so the company could not be
  // restored from its own archive (F16.4). The retire is where it is refused.
  const fixture = await createCompany('goal-retire-last');
  const measured = await priority(fixture, 'measured');
  const revenue = await defineMetric(fixture.companyId, { goalId: measured.id, slug: 'revenue', name: 'Revenue', unit: 'currency', target: 100 });
  const orders = await defineMetric(fixture.companyId, { goalId: measured.id, slug: 'orders', name: 'Orders', unit: 'count', target: 10 });
  await applyGoalChange({ companyId: fixture.companyId, goalId: measured.id, doneWhen: null });

  // One of two may go: the other still says when it is done.
  await changeMetric(fixture.companyId, orders, { retired: true });
  await assert.rejects(changeMetric(fixture.companyId, revenue, { retired: true }),
    /the measure "revenue" is the last one the quarterly priority "measured" is measured by, and the priority does not say in words when it is done: write what is true once it is done, or define another measure, before retiring this one/);
  const live = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>(
    'SELECT slug FROM goal_metrics WHERE retired_at IS NULL ORDER BY slug'));
  assert.deepEqual(live.rows.map((row) => row.slug), ['revenue']);

  // With the words back, the last measure may be retired.
  await applyGoalChange({ companyId: fixture.companyId, goalId: measured.id, doneWhen: 'Revenue is 100.' });
  await changeMetric(fixture.companyId, revenue, { retired: true });
});

test('a closed priority is not held to a finish line, and round-trips through the archive (F18.1, F16.4)', async () => {
  // The rule is about work still to do. A priority abandoned with only a
  // measure, whose measure was retired afterwards, is history: it can be
  // reworded, exported and restored, and only reopening it asks for words.
  const fixture = await createCompany('goal-closed-finish');
  const closed = await priority(fixture, 'closed');
  const revenue = await defineMetric(fixture.companyId, { goalId: closed.id, slug: 'revenue', name: 'Revenue', unit: 'currency', target: 100 });
  await applyGoalChange({ companyId: fixture.companyId, goalId: closed.id, doneWhen: null });
  await applyGoalChange({ companyId: fixture.companyId, goalId: closed.id, status: 'abandoned' });
  await changeMetric(fixture.companyId, revenue, { retired: true });
  await applyGoalChange({ companyId: fixture.companyId, goalId: closed.id, statement: 'Closed: the market was not there.' });

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ status: string; done_when: string | null; retired: boolean }>(
    `SELECT g.status, g.done_when, m.retired_at IS NOT NULL AS retired
       FROM goals g JOIN goal_metrics m ON m.goal_id = g.id WHERE g.slug = 'closed'`));
  assert.deepEqual(rows, [{ status: 'abandoned', done_when: null, retired: true }]);

  // Reopened, it is work again, and says when it is done.
  await assert.rejects(applyGoalChange({ companyId: fixture.companyId, goalId: closed.id, status: 'active' }),
    /the quarterly priority "closed" says when it is done: write what is true once it is done, or measure it by a number/);
  await applyGoalChange({ companyId: fixture.companyId, goalId: closed.id, status: 'active', doneWhen: 'Ten cafes pay.' });
});

test('the owner sets and changes a goal\'s period, seat, commitment, finish line and channel (F18.1)', async () => {
  const fixture = await createCompany('goal-period-api');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const base = `/api/companies/${fixture.companyId}/goals`;
    const made = await api.call('POST', base, token, {
      kind: 'key_result', slug: 'launch', statement: 'Launch the shop.', parentGoalId: fixture.goalId,
      startsOn: '2026-10-01', dueOn: '2026-12-31', ownerRoleId: fixture.roleId, commitment: 'committed',
      doneWhen: 'The shop takes an order.', channel: 'existing_platforms',
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual(made.body.warnings, []);
    assert.equal(made.body.period, 'quarter');

    const refused = await api.call('POST', base, token, {
      kind: 'key_result', slug: 'nobody', statement: 'Nobody owns it.', parentGoalId: fixture.goalId,
      startsOn: '2026-10-01', dueOn: '2026-12-31', doneWhen: 'Done.',
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /has one owning seat/);

    // Nothing sent is nothing changed, and the owner's code is not spent on it.
    const empty = await api.call('POST', `${base}/${made.body.id}`, token, {});
    assert.equal(empty.status, 400);
    const changed = await api.call('POST', `${base}/${made.body.id}`, token, {
      dueOn: '2026-11-30', commitment: 'aspirational', channel: null, proof: { totp: api.code() },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const now = await api.call('GET', `${base}/${made.body.id}`, token);
    assert.deepEqual(
      [now.body.startsOn, now.body.dueOn, now.body.ownerRoleId, now.body.ownerRole, now.body.commitment, now.body.doneWhen, now.body.channel],
      ['2026-10-01', '2026-11-30', fixture.roleId, 'worker', 'aspirational', 'The shop takes an order.', null]);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'goal.changed' ORDER BY occurred_at DESC LIMIT 1"));
    assert.deepEqual(rows[0]!.payload.changed, ['dueOn', 'commitment', 'channel']);
  } finally {
    await api.close();
  }
});

test('goal.propose still proposes a change to a goal with a period and a seat (F3.10, F18.1)', async () => {
  const fixture = await createCompany('goal-period-propose');
  const keyResult = await priority(fixture, 'kept');
  const proposal = await proposeGoalChange({
    companyId: fixture.companyId, goal: 'kept', proposedStatement: 'Kept, and sooner.', rationale: 'The first two shipped early.',
  });
  assert.equal(proposal.proposed, true);
  await withTenant(fixture.companyId, async (tx) => {
    const goal = (await ancestryFor(tx, keyResult.id)).at(-1)!;
    assert.equal(goal.ownerRole, 'worker');
    assert.equal(goal.dueOn, '2026-12-31');
  });
});

test('the console offers the nineteen channels the platform knows, in its order (F18.11)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../console/src/channels.ts', import.meta.url), 'utf8');
  const offered = [...source.matchAll(/value: '([a-z_]+)'/g)].map((match) => match[1]);
  assert.equal(CHANNELS.length, 19);
  assert.deepEqual(offered, CHANNELS.map((channel) => channel.slug));
});

/* ------------------------------------------------- a plan of new goals --- */

/** The owner's device for a test that decides tier 3 more than twice: a clock it moves, so each code is fresh. */
async function ownerDevice() {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/plan-totp', secret);
  let steps = 0;
  const at = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, now: at });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/plan-totp' });
  return {
    mfa,
    approve: (companyId: string, itemId: string, lines?: number[]) => {
      steps += 1;
      return inbox.decide(companyId, itemId, 'approve', 'Yes to these.', {
        channel: 'app', proof: { totp: totpCode(decodeBase32(secret), stepFor(at())) }, mfa, ...(lines ? { lines } : {}),
      });
    },
  };
}

/** A broker that lets the fixture's CEO call goal.propose from a running task. */
async function proposer(fixture: Fixture) {
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'goal.propose');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const broker = new CapabilityBroker(registry);
  let key = 0;
  return (input: Record<string, unknown>) => broker.invoke<unknown, {
    proposed: boolean; inboxItemId: string; note?: string; warnings?: Array<{ line: number; kind: string }>;
  }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: task.id, idempotencyKey: `plan-${key += 1}`,
  }, 'goal.propose', input);
}

const goalSlugs = async (fixture: Fixture) => (await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string }>(
  'SELECT slug FROM goals ORDER BY created_at, slug'))).rows.map((row) => row.slug);

/** Four new goals: this year's goal, a priority under it, a learning priority paired with it, and one to refuse. */
const QUARTER_PLAN = [
  {
    slug: 'year-cafes', kind: 'objective', parent: 'mission', statement: 'Become the coffee supplier Bandung cafes ask for by name.',
    startsOn: '2027-01-01', dueOn: '2027-12-31', commitment: 'committed', seat: 'worker', doneWhen: 'Forty cafes order every month.',
  },
  {
    slug: 'q1-cafes', kind: 'key_result', parent: 'year-cafes', statement: 'Ten paying cafes by the end of March.',
    startsOn: '2027-01-01', dueOn: '2027-03-31', commitment: 'committed', seat: 'worker',
    measure: { name: 'Paying cafes', unit: 'count', baseline: 2, target: 10 },
  },
  {
    slug: 'q1-ads-test', kind: 'key_result', parent: 'objective', statement: 'Learn whether ads to cafe owners bring sign-ups.',
    startsOn: '2027-01-01', dueOn: '2027-03-31', commitment: 'learning', seat: 'worker', channel: 'social_and_display_ads',
    measure: { slug: 'ad-signups', name: 'Sign-ups from ads', unit: 'count', target: 40, pair: 'q1-cafes' },
  },
  {
    slug: 'q1-newsletter', kind: 'key_result', parent: 'objective', statement: 'Start a monthly newsletter.',
    startsOn: '2027-01-01', dueOn: '2027-03-31', commitment: 'aspirational', seat: 'worker', doneWhen: 'Three issues have gone out.',
  },
];

test('a plan of new goals is one card, and the owner\'s yes makes only the lines approved (F18.7)', async () => {
  const fixture = await createCompany('goal-plan');
  const propose = await proposer(fixture);
  const before = await goalSlugs(fixture);

  // What a plan line must say is checked when it is proposed, by its line.
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[2], measure: undefined }], why: 'y' }),
    /line 1 \(q1-ads-test\): a learning goal is a test, and carries a measure whose target is the prediction, set now/);
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[0], parent: 'nowhere' }], why: 'y' }),
    /line 1 \(year-cafes\): no goal nowhere to hang from; name an active goal by its slug \(mission, objective\), or an earlier line of this plan/);
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[1], parent: 'mission' }], why: 'y' }),
    /line 1 \(q1-cafes\): a key result hangs from an objective, and mission is a mission/);
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[3], seat: undefined }], why: 'y' }),
    /line 1 \(q1-newsletter\): a key result of a quarter or less is a quarterly priority, and has one owning seat/);
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[3], doneWhen: undefined }], why: 'y' }),
    /line 1 \(q1-newsletter\): a quarterly priority says when it is done: give it doneWhen, or a measure/);
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[3], seat: 'nobody' }], why: 'y' }),
    /line 1 \(q1-newsletter\): no role nobody in this company to own it; name a seat by its slug: worker/);
  await assert.rejects(propose({ plan: [QUARTER_PLAN[3], QUARTER_PLAN[3]], why: 'y' }),
    /line 2 \(q1-newsletter\): the slug q1-newsletter is already line 1's/);
  await assert.rejects(propose({ plan: [{ ...QUARTER_PLAN[3], slug: 'objective' }], why: 'y' }),
    /line 1 \(objective\): a goal named objective already exists; give the new one a slug of its own/);
  await assert.rejects(propose({ goal: 'objective', plan: QUARTER_PLAN, why: 'y' }),
    /goal.propose takes a change to one goal \(goal\) or a plan of new goals \(plan\), not both/);
  await assert.rejects(propose({ plan: [], why: 'y' }), /a plan has 1 to 20 new goals; this one has 0/);

  const first = (await propose({ plan: QUARTER_PLAN, why: 'The quarter review: cafes reorder, offices do not.' })).output;
  assert.equal(first.proposed, true);
  assert.deepEqual(await goalSlugs(fixture), before, 'proposing makes nothing');
  const cards = await inbox.listOpen(fixture.companyId);
  assert.equal(cards.length, 1, 'one card for the whole plan');
  const card = cards[0]!;
  assert.equal(card.id, first.inboxItemId);
  assert.deepEqual([card.kind, card.tier, card.taskId], ['escalation', 3, null]);
  assert.match(card.title, /New goals proposed, to approve line by line/);
  assert.match(card.rationale, /Reason given: The quarter review/);
  assert.match(card.rationale, /Line 1: the objective "Become the coffee supplier Bandung cafes ask for by name\."/);
  assert.match(card.rationale, /Line 2: the key result "Ten paying cafes by the end of March\."\nUnder line 1: Become the coffee supplier/);
  assert.match(card.rationale, /Measured by Paying cafes: from 2 to 10\./);
  assert.match(card.rationale, /Owned by: CEO/, 'the seat by the name the owner reads it by');
  assert.match(card.rationale, /Line 3: the key result "Learn whether ads to cafe owners bring sign-ups\."/);
  assert.match(card.rationale, /The prediction, written before the work: Sign-ups from ads reaches 40, from 0\./);
  assert.match(card.rationale, /Watched with: Paying cafes/);
  assert.deepEqual(card.plan!.map((line) => [line.line, line.kind, line.slug, line.channel]), [
    [1, 'objective', 'year-cafes', null], [2, 'key_result', 'q1-cafes', null],
    [3, 'key_result', 'q1-ads-test', 'social_and_display_ads'], [4, 'key_result', 'q1-newsletter', null],
  ]);
  const again = (await propose({ plan: [QUARTER_PLAN[3]], why: 'z' })).output;
  assert.deepEqual([again.proposed, again.inboxItemId], [false, first.inboxItemId], 'one plan waits for the owner at a time');

  // A line whose parent or pair is a line refused cannot be approved without it.
  const device = await ownerDevice();
  await assert.rejects(device.approve(fixture.companyId, first.inboxItemId, [2]),
    /line 2 hangs from line 1, which is not approved: approve line 1 too, or refuse line 2/);
  await assert.rejects(device.approve(fixture.companyId, first.inboxItemId, [1, 3]),
    /line 3's measure is watched with line 2's, which is not approved: approve line 2 too, or refuse line 3/);
  await assert.rejects(device.approve(fixture.companyId, first.inboxItemId, [1, 9]),
    /lines are the numbers of this plan's lines, 1 to 4; got 9/);
  await assert.rejects(inbox.decide(fixture.companyId, first.inboxItemId, 'deny', '', { lines: [1] }),
    /lines are chosen with a yes: a no refuses the whole plan/);
  assert.deepEqual(await goalSlugs(fixture), before);

  await device.approve(fixture.companyId, first.inboxItemId, [1, 2, 3]);
  assert.deepEqual((await goalSlugs(fixture)).sort(), [...before, 'year-cafes', 'q1-cafes', 'q1-ads-test'].sort(), 'line 4 was refused');
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  await withTenant(fixture.companyId, async (tx) => {
    const goals = await goalsIn(tx, fixture.companyId);
    const year = goals.find((goal) => goal.slug === 'year-cafes')!;
    const cafes = goals.find((goal) => goal.slug === 'q1-cafes')!;
    const ads = goals.find((goal) => goal.slug === 'q1-ads-test')!;
    assert.equal(cafes.parentGoalId, year.id, 'a line under a line hangs from the goal it made');
    assert.equal(ads.parentGoalId, fixture.goalId);
    assert.deepEqual([year.period, year.commitment, year.ownerRole, year.doneWhen], ['year', 'committed', 'worker', 'Forty cafes order every month.']);
    assert.deepEqual([ads.period, ads.commitment, ads.channel], ['quarter', 'learning', 'social_and_display_ads']);
    const { rows: measures } = await tx.query<{ slug: string; goal_id: string; target: string; baseline: string; owner_role_id: string; due_on: string; partner: string | null }>(
      `SELECT m.slug, m.goal_id, m.target::text, m.baseline::text, m.owner_role_id, to_char(m.due_on, 'YYYY-MM-DD') AS due_on, p.slug AS partner
         FROM goal_metrics m LEFT JOIN goal_metrics p ON p.id = m.paired_metric_id ORDER BY m.slug`);
    assert.deepEqual(measures.map((row) => [row.slug, row.goal_id, row.baseline, row.target, row.owner_role_id, row.due_on, row.partner]), [
      ['ad-signups', ads.id, '0', '40', fixture.roleId, '2027-03-31', 'q1-cafes'],
      ['q1-cafes', cafes.id, '2', '10', fixture.roleId, '2027-03-31', 'ad-signups'],
    ], 'each measure is the line\'s, owned by its seat, due with it, and the pair is written both ways');
    const { rows: events } = await tx.query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM events WHERE type IN ('goal.created', 'metric.defined', 'owner.decided') ORDER BY occurred_at, id");
    const made = (type: string) => events.filter((event) => event.type === type && event.payload.inboxItemId === first.inboxItemId)
      .map((event) => String(event.payload.slug)).sort();
    assert.deepEqual(made('goal.created'), ['q1-ads-test', 'q1-cafes', 'year-cafes'], 'each is recorded as made by the owner\'s yes on this card');
    assert.deepEqual(made('metric.defined'), ['ad-signups', 'q1-cafes']);
    assert.deepEqual(events.find((event) => event.type === 'owner.decided')!.payload.lines, { approved: [1, 2, 3], refused: [4] });
  });
});

test('a plan is refused once a goal it hangs from has changed, and a plan of every line needs no list (F18.7)', async () => {
  const fixture = await createCompany('goal-plan-stale');
  const propose = await proposer(fixture);
  const device = await ownerDevice();
  const stale = (await propose({ plan: [QUARTER_PLAN[3]], why: 'A newsletter keeps the cafes ordering.' })).output;
  await applyGoalChange({ companyId: fixture.companyId, goalId: fixture.goalId, statement: 'The owner\'s own words.' });
  await assert.rejects(device.approve(fixture.companyId, stale.inboxItemId),
    /line 1 hangs from the objective "objective", which has changed since this was proposed; deny it, and ask for a new proposal/);
  assert.equal((await goalSlugs(fixture)).includes('q1-newsletter'), false);
  await inbox.decide(fixture.companyId, stale.inboxItemId, 'deny', 'Not this quarter.');
  assert.equal((await goalSlugs(fixture)).includes('q1-newsletter'), false, 'a no makes nothing');

  // Anything the owner sets on a goal from the console counts as a change:
  // a plan for 2027 is not approved under an objective that now covers 2028.
  const moved = (await propose({ plan: [QUARTER_PLAN[3]], why: 'A newsletter keeps the cafes ordering.' })).output;
  await applyGoalChange({ companyId: fixture.companyId, goalId: fixture.goalId, startsOn: '2028-01-01', dueOn: '2028-12-31' });
  await assert.rejects(device.approve(fixture.companyId, moved.inboxItemId),
    /line 1 hangs from the objective "objective", which has changed since this was proposed; deny it, and ask for a new proposal/);
  await inbox.decide(fixture.companyId, moved.inboxItemId, 'deny', 'The year moved.');
  const reseated = (await propose({ plan: [QUARTER_PLAN[3]], why: 'A newsletter keeps the cafes ordering.' })).output;
  await applyGoalChange({ companyId: fixture.companyId, goalId: fixture.goalId, commitment: 'aspirational' });
  await assert.rejects(device.approve(fixture.companyId, reseated.inboxItemId),
    /line 1 hangs from the objective "objective", which has changed since this was proposed/);
  await inbox.decide(fixture.companyId, reseated.inboxItemId, 'deny', 'Its commitment changed.');

  // A yes with no lines named is a yes to every line.
  const fresh = (await propose({ plan: [QUARTER_PLAN[3]], why: 'Asked again, under the objective as it is now.' })).output;
  assert.equal(fresh.proposed, true);
  await device.approve(fixture.companyId, fresh.inboxItemId);
  assert.equal((await goalSlugs(fixture)).includes('q1-newsletter'), true);
});

test('a plan\'s measure is never paired with one already paired, nor named as a retired one (F18.7)', async () => {
  const fixture = await createCompany('goal-plan-pairs');
  const propose = await proposer(fixture);
  await defineMetric(fixture.companyId, { goalId: fixture.goalId, slug: 'revenue', name: 'Revenue', unit: 'currency', target: 100 });
  const newsletter = (slug: string, measure: Record<string, unknown>) => ({
    ...QUARTER_PLAN[3], slug, statement: `The ${slug} priority.`, doneWhen: undefined,
    measure: { name: `Measure of ${slug}`, unit: 'count', target: 10, ...measure },
  });

  // Line 1 takes revenue's only partner place; line 2 cannot take line 1's,
  // since the yes would pair line 1's measure twice and roll back on the device.
  await assert.rejects(propose({ plan: [
    newsletter('q1-cafes', { slug: 'cafes', pair: 'revenue' }),
    newsletter('q1-ads', { slug: 'ads', pair: 'cafes' }),
  ], why: 'y' }), /line 2 \(q1-ads\): the measure cafes is already paired with revenue; a new measure is paired only with one that has no pair/);
  await assert.rejects(propose({ plan: [
    newsletter('q1-cafes', { slug: 'cafes' }),
    newsletter('q1-ads', { slug: 'ads', pair: 'cafes' }),
    newsletter('q1-press', { slug: 'press', pair: 'ads' }),
  ], why: 'y' }), /line 3 \(q1-press\): the measure ads is already paired with cafes; a new measure is paired only with one that has no pair/);

  // A retired measure keeps its slug (0053), so a line cannot take it.
  const signups = await defineMetric(fixture.companyId, { goalId: fixture.goalId, slug: 'q1-signups', name: 'Sign-ups', unit: 'count', target: 50 });
  await changeMetric(fixture.companyId, signups, { retired: true });
  await assert.rejects(propose({ plan: [newsletter('q1-signups', {})], why: 'y' }),
    /line 1 \(q1-signups\): a measure named q1-signups was retired, and keeps its slug; give this one a slug of its own/);

  // Paired the right way round, the yes makes both pairs.
  const fine = (await propose({ plan: [
    newsletter('q1-cafes', { slug: 'cafes', pair: 'revenue' }),
    newsletter('q1-ads', { slug: 'ads' }),
    newsletter('q1-press', { slug: 'press', pair: 'ads' }),
  ], why: 'Each measure watched with one other.' })).output;
  await (await ownerDevice()).approve(fixture.companyId, fine.inboxItemId);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string; partner: string | null }>(
    `SELECT m.slug, p.slug AS partner FROM goal_metrics m LEFT JOIN goal_metrics p ON p.id = m.paired_metric_id
      WHERE m.retired_at IS NULL ORDER BY m.slug`));
  assert.deepEqual(rows.map((row) => [row.slug, row.partner]),
    [['ads', 'press'], ['cafes', 'revenue'], ['press', 'ads'], ['revenue', 'cafes']]);
});

test('two plans proposed at once file one card (F18.7)', async () => {
  const fixture = await createCompany('goal-plan-race');
  // Two runs, each in its own transaction, as two CEO tasks would be: the
  // broker is left out so nothing of its own orders them.
  const both = await Promise.all([
    proposeGoalPlan({ companyId: fixture.companyId, plan: [QUARTER_PLAN[3]], rationale: 'The first run.' }),
    proposeGoalPlan({ companyId: fixture.companyId, plan: [{ ...QUARTER_PLAN[3], slug: 'q1-podcast' }], rationale: 'The second run.' }),
  ]);
  assert.deepEqual(both.map((one) => one.proposed).sort(), [false, true]);
  assert.equal(both[0]!.inboxItemId, both[1]!.inboxItemId);
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);
});

test('a plan\'s card shows the soft limits each line would pass, and refuses nothing for them (F18.7, F18.1)', async () => {
  const fixture = await createCompany('goal-plan-limits');
  const propose = await proposer(fixture);
  const six = Array.from({ length: 6 }, (_, index) => ({
    ...QUARTER_PLAN[3], slug: `priority-${index + 1}`, statement: `Priority ${index + 1}.`,
  }));
  const proposed = (await propose({ plan: six, why: 'Everything matters this quarter.' })).output;
  assert.equal(proposed.proposed, true);
  assert.deepEqual([...new Set(proposed.warnings!.map((warning) => warning.kind))].sort(), ['objective_key_results', 'seat_priorities']);
  const card = (await inbox.listOpen(fixture.companyId))[0]!;
  assert.match(card.rationale, /Key results under this objective: 6, more than the 5 one objective keeps in view\./);
  assert.match(card.rationale, /Quarterly priorities for CEO at once: 6, more than the 5 one seat keeps in view\./);
  assert.deepEqual(card.plan!.map((line) => line.warned), [true, true, true, true, true, true]);
});

test('an agent still cannot write a goal or a measure: the plan is the owner\'s to make (F3.10, F18.7)', async () => {
  const fixture = await createCompany('goal-plan-readonly');
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO goals (company_id, parent_goal_id, kind, slug, statement) VALUES ($1, $2, 'key_result', 'mine', 'My own goal.')`,
    [fixture.companyId, fixture.goalId])), /permission denied for table goals/);
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO goal_metrics (company_id, goal_id, slug, name, unit, target) VALUES ($1, $2, 'mine', 'Mine', 'count', 1)`,
    [fixture.companyId, fixture.goalId])), /permission denied for table goal_metrics/);
});
