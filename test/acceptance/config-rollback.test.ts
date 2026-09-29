/**
 * F3.9's other half: "rollback satu klik ke versi mana pun".
 *
 * Every change to a charter, a policy or a role was recorded as a version,
 * and nothing could put one back: `history` and `restore` had no caller, and
 * `restore` returned a snapshot and left applying it to a caller that did not
 * exist. Paperclip rolls an agent's configuration back from its UI. These hold
 * that a version comes back as the live configuration, through the same write
 * path a change takes -- so the rollback is itself a version and an event --
 * and only in its own company.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { history } from '../../src/governance/config-versions.ts';
import { rollBack } from '../../src/governance/rollback.ts';
import { publishCharter, putPolicy } from '../../src/governance/store.ts';
import { applyRoleChange } from '../../src/governance/structure.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test("a role goes back to how it was before a change, and the rollback is on the record", async () => {
  const fixture = await createCompany('rollback-role');
  const prompt = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ system_prompt: string; tools: string[] }>(
    'SELECT system_prompt, tools FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!;
  const original = await prompt();

  await applyRoleChange(fixture.companyId, fixture.roleId, { systemPrompt: 'Be terse.' }, { ownerApproved: true });
  await applyRoleChange(fixture.companyId, fixture.roleId, { systemPrompt: 'Be verbose.' }, { ownerApproved: true });
  assert.equal((await prompt()).system_prompt, 'Be verbose.');

  // Version 1 is the role as it was before the first change.
  await rollBack(fixture.companyId, 'role', fixture.roleId, 1);
  assert.deepEqual(await prompt(), original);

  const versions = await history(fixture.companyId, 'role', fixture.roleId);
  assert.equal(versions.length, 3, 'going back is a change like any other');
  assert.match(versions[0]!.summary, /Restored version 1/);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { restoredFrom: number } }>(
    "SELECT payload FROM events WHERE type = 'config.restored'"));
  assert.deepEqual(rows.map((row) => row.payload.restoredFrom), [1]);
});

/**
 * What done means was fixed when a role was hired, and a company whose
 * marketer could never meet its criteria on a deployment without a CRM (the
 * competitive analysis of 2026-09-28, L5) had no way to say otherwise short
 * of hiring the role again. It changes like the rest of a role: with the
 * owner's approval, recorded, and put back with the version.
 */
test('what done means for a role changes with the owner\'s approval and comes back with its version (L5, F2.8)', async () => {
  const fixture = await createCompany('rollback-done');
  const criteria = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ done_criteria: string[] }>(
    'SELECT done_criteria FROM roles WHERE id = $1', [fixture.roleId]))).rows[0]!.done_criteria;
  const original = await criteria();

  await applyRoleChange(fixture.companyId, fixture.roleId,
    { doneCriteria: ['  the output names every draft it made ', '', 'nothing was sent without a draft'] }, { ownerApproved: true });
  assert.deepEqual(await criteria(), ['the output names every draft it made', 'nothing was sent without a draft'],
    'trimmed, and blank lines are not criteria');

  await rollBack(fixture.companyId, 'role', fixture.roleId, 1);
  assert.deepEqual(await criteria(), original);

  await assert.rejects(
    applyRoleChange(fixture.companyId, fixture.roleId, { doneCriteria: ['anything counts'] }, { ownerApproved: false }),
    (error: unknown) => isPalugadaError(error) && error.code === 'approval.required'
      // What done means is judged like the charter it belongs to (F17.2).
      && /role's charter/.test(error.message));
  await assert.rejects(
    applyRoleChange(fixture.companyId, fixture.roleId, { doneCriteria: [' ', ''] }, { ownerApproved: true }),
    /at least one done criterion/);
  await assert.rejects(
    applyRoleChange(fixture.companyId, fixture.roleId, { doneCriteria: Array.from({ length: 13 }, (_, i) => `criterion ${i}`) }, { ownerApproved: true }),
    /at most 12 done criteria/);
  await assert.rejects(
    applyRoleChange(fixture.companyId, fixture.roleId, { doneCriteria: ['x'.repeat(501)] }, { ownerApproved: true }),
    /at most 500 characters/);
  assert.deepEqual(await criteria(), original, 'a refused change changes nothing');
});

test('a charter and a policy come back as the version the owner picked', async () => {
  const fixture = await createCompany('rollback-charter');
  await publishCharter({ companyId: fixture.companyId, body: 'We answer within a day.' });
  await publishCharter({ companyId: fixture.companyId, body: 'We answer within a week.' });
  await rollBack(fixture.companyId, 'charter', null, 1);
  const { rows: charter } = await withControlPlane((tx) => tx.query<{ body: string }>(
    'SELECT body FROM charters WHERE company_id = $1 ORDER BY version DESC LIMIT 1', [fixture.companyId]));
  assert.equal(charter[0]!.body, 'We answer within a day.');

  const policyId = await putPolicy({
    companyId: fixture.companyId, slug: 'no-ads', effect: 'deny',
    condition: { op: 'matches', field: 'tool', value: 'ads.*' },
  });
  await putPolicy({
    companyId: fixture.companyId, slug: 'no-ads', effect: 'deny',
    condition: { op: 'matches', field: 'tool', value: 'ads.campaign.*' },
  });
  await rollBack(fixture.companyId, 'policy', policyId, 1);
  const { rows: policy } = await withControlPlane((tx) => tx.query<{ condition: { value: string }; effect: string }>(
    'SELECT condition, effect FROM policies WHERE id = $1', [policyId]));
  assert.equal(policy[0]!.effect, 'deny');
  assert.equal(policy[0]!.condition.value, 'ads.*');
});

test('a version that is not there, another company\'s, or a kind with no one-step restore is refused', async () => {
  const fixture = await createCompany('rollback-refused');
  const other = await createCompany('rollback-other');
  await applyRoleChange(fixture.companyId, fixture.roleId, { systemPrompt: 'Be terse.' }, { ownerApproved: true });

  await assert.rejects(rollBack(fixture.companyId, 'role', fixture.roleId, 9),
    (error: unknown) => isPalugadaError(error, 'config.unknown_version'));
  await assert.rejects(rollBack(other.companyId, 'role', fixture.roleId, 1),
    (error: unknown) => isPalugadaError(error, 'config.unknown_version'));
  await assert.rejects(rollBack(fixture.companyId, 'grant', fixture.divisionId, 1),
    /changing it again/);
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ system_prompt: string }>(
    'SELECT system_prompt FROM roles WHERE id = $1', [fixture.roleId]));
  assert.equal(rows[0]!.system_prompt, 'Be terse.', 'nothing moved');
});
