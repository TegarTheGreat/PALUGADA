/**
 * Owner handoff rules, and the division a task works in (0058).
 *
 * Handoffs were rules in code a deployment had to compose, and the one a
 * deployment starts had none: no work followed on from other work unless an
 * agent delegated it. Paperclip chains issues by dependency; here the owner
 * says "when the researcher finishes, the writer takes over, with this
 * brief". And the handoff engine filed each successor under its
 * predecessor's division, which is the division whose grants the broker
 * reads -- so a reviewer handed work from content acted with content's
 * grants. A task's division is now its role's, by the database.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { processHandoffs } from '../../src/engine/handoff.ts';
import {
  createHandoffRule, handoffRulesOf, ownerHandoffRules, setHandoffRuleEnabled,
} from '../../src/engine/handoff-rules.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A role in a division of its own, as a reviewer is. */
async function elsewhere(fixture: Fixture, slug: string): Promise<{ roleId: string; divisionId: string }> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows: division } = await tx.query<{ id: string }>(
      `INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $2) RETURNING id`, [fixture.companyId, `${slug}-div`]);
    const { rows: role } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, output_schema, done_criteria)
       VALUES ($1, $2, $3, 'You check work.', 'test-model', '{"type":"object"}', ARRAY['a verdict is given'])
       RETURNING id`,
      [fixture.companyId, division[0]!.id, slug],
    );
    return { roleId: role[0]!.id, divisionId: division[0]!.id };
  });
}

async function finished(fixture: Fixture, output: Record<string, unknown>, goal = 'research the market') {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal }, createdBy: 'owner', reserveTokens: 5_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'completed', { output });
  return task;
}

test("a task works in its role's division, and a handoff files its successor there", async () => {
  const fixture = await createCompany('handoff-division');
  const reviewer = await elsewhere(fixture, 'checker');

  await assert.rejects(createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: reviewer.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'review' }, createdBy: 'owner', reserveTokens: 100,
  }), /tasks_role_in_its_division/);

  const done = await finished(fixture, { summary: 'three competitors, two cheaper' });
  const [handed] = await processHandoffs(fixture.companyId, [{
    fromRoleSlug: 'worker', toRoleSlug: 'checker', mapInput: (output) => ({ goal: 'check it', ...output }),
  }]);
  assert.ok(handed, 'the handoff happened');
  const successor = (await withTenant(fixture.companyId, (tx) => getTask(tx, handed.toTaskId)))!;
  assert.equal(successor.divisionId, reviewer.divisionId, 'the reviewer works under its own division\'s grants');
  assert.equal(successor.parentTaskId, done.id);
});

test('the owner chains roles, and the next one takes over with a brief and what it was handed', async () => {
  const fixture = await createCompany('handoff-owner');
  const other = await createCompany('handoff-owner-other');
  const writerId = await addRole(fixture, 'writer');

  await assert.rejects(createHandoffRule(fixture.companyId, {
    fromRoleId: fixture.roleId, toRoleId: fixture.roleId, brief: 'again',
  }), /hand work to itself/);
  await assert.rejects(createHandoffRule(fixture.companyId, {
    fromRoleId: fixture.roleId, toRoleId: other.roleId, brief: 'x',
  }), /no such role in this company/);
  await assert.rejects(createHandoffRule(fixture.companyId, {
    fromRoleId: fixture.roleId, toRoleId: writerId, brief: '   ',
  }), /say what the next role/);
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    'INSERT INTO handoff_rules (company_id, from_role_id, to_role_id, brief) VALUES ($1, $2, $3, $4)',
    [fixture.companyId, fixture.roleId, writerId, 'sneak'])), /permission denied/);

  const rule = await createHandoffRule(fixture.companyId, {
    fromRoleId: fixture.roleId, toRoleId: writerId, brief: 'Turn the findings into a one-page brief for the owner.',
  });
  const done = await finished(fixture, { summary: 'three competitors', findings: ['A is cheaper', 'B is slower'] });

  const [handed] = await processHandoffs(fixture.companyId, await ownerHandoffRules(fixture.companyId));
  assert.ok(handed);
  const successor = (await withTenant(fixture.companyId, (tx) => getTask(tx, handed.toTaskId)))!;
  assert.equal(successor.roleId, writerId);
  assert.equal(successor.parentTaskId, done.id);
  assert.equal(successor.input.goal, 'Turn the findings into a one-page brief for the owner.');
  assert.match(String(successor.input.context), /worker finished with/);
  assert.match(String(successor.input.context), /A is cheaper/);
  assert.deepEqual(await processHandoffs(fixture.companyId, await ownerHandoffRules(fixture.companyId)), [],
    'once per completion');

  // Switched off, it hands nothing on.
  await setHandoffRuleEnabled(fixture.companyId, rule, false);
  await finished(fixture, { summary: 'more' }, 'research again');
  assert.deepEqual(await ownerHandoffRules(fixture.companyId), []);
  const [listed] = await handoffRulesOf(fixture.companyId);
  assert.deepEqual([listed!.fromRoleSlug, listed!.toRoleSlug, listed!.enabled], ['worker', 'writer', false]);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string }>(
    "SELECT type FROM events WHERE type LIKE 'handoff_rule.%' ORDER BY occurred_at"));
  assert.deepEqual(rows.map((row) => row.type), ['handoff_rule.created', 'handoff_rule.closed']);
});

test('handoff rules travel with the company', async () => {
  const fixture = await createCompany('handoff-export');
  const writerId = await addRole(fixture, 'writer');
  await createHandoffRule(fixture.companyId, { fromRoleId: fixture.roleId, toRoleId: writerId, brief: 'Write it up.' });
  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'handoff-restored' });
  const [copy] = await handoffRulesOf(restored.companyId);
  assert.deepEqual([copy!.fromRoleSlug, copy!.toRoleSlug, copy!.brief], ['worker', 'writer', 'Write it up.']);
  const { rows } = await withControlPlane((tx) => tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM handoff_rules WHERE company_id = $1', [fixture.companyId]));
  assert.equal(rows[0]!.n, 1, 'the source keeps its own');
});
