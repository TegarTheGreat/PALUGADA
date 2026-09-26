/**
 * Stage gates (0057, src/domain/stage.ts).
 *
 * auto-company runs every idea through explore, validate -- a GO or NO-GO on
 * evidence -- build, launch and grow, and winds it down when it is not
 * working. These hold what that is here: a stage the owner sets and no run
 * can, a fact policies read so "no paid reach before launch" is a rule, a
 * sentence every run is told, and a proposal a run makes and the owner
 * answers -- with their device when the move loosens what the company may do.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { recordPlan } from '../../src/engine/plan.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { stageProposeCapability } from '../../src/broker/platform-capabilities.ts';
import { buildContext } from '../../src/context/builder.ts';
import { putPolicy } from '../../src/governance/store.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { setStage } from '../../src/domain/stage.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerMfa, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { COMPANY_OS } from '../../src/bundles/builtin.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const stageOf = async (companyId: string) => (await withControlPlane((tx) => tx.query<{ stage: string | null }>(
  'SELECT stage FROM companies WHERE id = $1', [companyId]))).rows[0]!.stage;

async function running(fixture: Fixture, goal = 'decide what is next') {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task;
}

async function enrolledOwner(): Promise<{ mfa: OwnerMfa; code: () => string }> {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/stage-totp', secret);
  const mfa = new OwnerMfa({ secrets });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/stage-totp' });
  let drift = 0;
  return { mfa, code: () => totpCode(decodeBase32(secret), stepFor(new Date()) + drift++) };
}

test('a policy reads the stage: no paid reach until the company has launched', async () => {
  const fixture = await createCompany('stage-policy');
  let spent = 0;
  const boost: Capability<{ budget: number }, { ok: boolean }> = {
    name: 'ads.boost',
    adapter: 'test:ads',
    defaultTier: 2,
    async execute() {
      spent += 1;
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  const registry = new CapabilityRegistry();
  registry.register(boost);
  await registry.sync();
  await grantCapability(fixture, 'ads.boost');
  const rule = COMPANY_OS.body.policies.find((policy) => policy.slug === 'no-paid-reach-before-launch')!;
  await putPolicy({ companyId: fixture.companyId, slug: rule.slug, effect: rule.effect, condition: rule.condition });

  const broker = new CapabilityBroker(registry);
  const attempt = async (key: string) => {
    const task = await running(fixture, `run the launch ads (${key})`);
    await recordPlan(fixture.companyId, task.id, [
      { capability: 'ads.boost', intent: 'reach new customers', expectedEffect: 'ads run' },
    ]);
    return broker.invoke(
      { companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
        roleId: fixture.roleId, taskId: task.id, idempotencyKey: key },
      'ads.boost', { budget: 100 },
    );
  };

  // No stage is not a launched company.
  await assert.rejects(attempt('k1'), (error: unknown) => isPalugadaError(error, 'policy.denied'));
  await setStage(fixture.companyId, 'build');
  await assert.rejects(attempt('k2'), (error: unknown) => isPalugadaError(error, 'policy.denied'));
  await setStage(fixture.companyId, 'launch', 'checkout works; ten paying customers');
  await attempt('k3');
  assert.equal(spent, 1);

  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { from: string | null; to: string; note?: string } }>(
    "SELECT payload FROM events WHERE type = 'company.stage_changed' ORDER BY occurred_at"));
  assert.deepEqual(rows.map((row) => [row.payload.from, row.payload.to]), [[null, 'build'], ['build', 'launch']]);
  assert.equal(rows[1]!.payload.note, 'checkout works; ten paying customers');
});

test('every run is told the stage and what it is for, and no run can change it', async () => {
  const fixture = await createCompany('stage-context');
  const told = async () => (await withTenant(fixture.companyId, (tx) => buildContext(tx, {
    companyId: fixture.companyId, divisionId: fixture.divisionId,
  }))).sections.find((section) => section.kind === 'stage');
  assert.equal(await told(), undefined, 'nothing is said while the owner has not set one');

  await setStage(fixture.companyId, 'validate');
  const section = await told();
  assert.match(section!.body, /in the validate stage/);
  assert.match(section!.body, /whether people will pay before anything is built/);
  assert.match(section!.body, /stage\.propose/);

  await assert.rejects(
    withTenant(fixture.companyId, (tx) => tx.query("UPDATE companies SET stage = 'grow'")),
    /permission denied/,
  );
  await assert.rejects(setStage(fixture.companyId, 'scale' as never), /violates check constraint/);
});

test('a run proposes a move; the owner decides it, with their device when it loosens', async () => {
  const fixture = await createCompany('stage-propose');
  await setStage(fixture.companyId, 'validate');
  const strategist = await running(fixture);
  const propose = stageProposeCapability();
  const ctx = {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: strategist.id, idempotencyKey: 'p1',
  } as never;

  await assert.rejects(propose.execute({ to: 'build', evidence: '  ' }, ctx), /needs its evidence/);
  await assert.rejects(propose.execute({ to: 'validate', evidence: 'x' }, ctx), /already in the validate stage/);
  await assert.rejects(propose.execute({ to: 'scale', evidence: 'x' }, ctx), /a stage is one of/);
  const go = await propose.execute({
    to: 'build', evidence: 'Twelve pre-orders at $29, paid (ledger).', why: 'The premortem found no fatal risk.',
  }, ctx);
  assert.equal(go.proposed, true);
  const again = await propose.execute({ to: 'launch', evidence: 'x' }, ctx);
  assert.deepEqual(again, {
    proposed: false, inboxItemId: go.inboxItemId, note: 'A move to build is already waiting for the owner; nothing more was proposed.',
  });

  const [item] = (await inbox.listOpen(fixture.companyId)).filter((open) => open.id === go.inboxItemId);
  assert.equal(item!.title, 'Move the company from validate to build?');
  assert.equal(item!.tier, 3, 'forward loosens, so it takes the device');
  assert.match(item!.rationale, /Twelve pre-orders/);
  assert.equal(item!.taskId, null, 'a no to the proposal is not a stop to the work that made it');

  // Not over a session, and not in a batch.
  await assert.rejects(inbox.decide(fixture.companyId, go.inboxItemId, 'approve', '', { channel: 'app', assurance: 'session' }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'));
  const batch = await inbox.decideMany(fixture.companyId, [go.inboxItemId], 'approve', '', { channel: 'app' });
  assert.deepEqual(batch.decided, []);
  assert.equal(await stageOf(fixture.companyId), 'validate');

  const owner = await enrolledOwner();
  await inbox.decide(fixture.companyId, go.inboxItemId, 'approve', 'GO', {
    channel: 'app', proof: { totp: owner.code() }, mfa: owner.mfa,
  });
  assert.equal(await stageOf(fixture.companyId), 'build');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: { to: string; inboxItemId: string; note: string } }>(
    "SELECT payload FROM events WHERE type = 'company.stage_changed' ORDER BY occurred_at DESC LIMIT 1"));
  assert.deepEqual([rows[0]!.payload.to, rows[0]!.payload.inboxItemId, rows[0]!.payload.note], ['build', go.inboxItemId, 'GO']);

  // Back a stage is a tightening: tier 2, and a no leaves the work running.
  const back = await propose.execute({ to: 'validate', evidence: 'Nine of twelve asked for refunds.' }, ctx);
  const [backItem] = (await inbox.listOpen(fixture.companyId)).filter((open) => open.id === back.inboxItemId);
  assert.equal(backItem!.tier, 2);
  await inbox.decide(fixture.companyId, back.inboxItemId, 'deny', 'not yet');
  assert.equal(await stageOf(fixture.companyId), 'build');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, strategist.id)))!.status, 'running');
});

test('a proposal from a stage the company has left cannot be approved, and is closed', async () => {
  const fixture = await createCompany('stage-stale');
  await setStage(fixture.companyId, 'build');
  const strategist = await running(fixture);
  const propose = stageProposeCapability();
  const ctx = {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: strategist.id, idempotencyKey: 'p1',
  } as never;
  const down = await propose.execute({ to: 'wind_down', evidence: 'Flat for ten weeks.' }, ctx);
  const up = { inboxItemId: down.inboxItemId };

  // The owner moves the company themselves; the proposal is from where it was.
  await setStage(fixture.companyId, 'validate');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; closed_reason: string }>(
    'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [up.inboxItemId]));
  assert.deepEqual(rows[0], { status: 'withdrawn', closed_reason: 'stage_changed' });

  // And one approved after the stage moved under it is refused, changing nothing.
  const next = await propose.execute({ to: 'explore', evidence: 'Nobody would pay.' }, ctx);
  await withControlPlane((tx) => tx.query("UPDATE companies SET stage = 'grow' WHERE id = $1", [fixture.companyId]));
  await assert.rejects(inbox.decide(fixture.companyId, next.inboxItemId, 'approve', ''), /no longer in the validate stage/);
  assert.equal(await stageOf(fixture.companyId), 'grow');
  const open = await inbox.listOpen(fixture.companyId);
  assert.ok(open.some((item) => item.id === next.inboxItemId), 'still there for the owner to deny');
});

test('the stage travels with the company', async () => {
  const fixture = await createCompany('stage-export');
  await setStage(fixture.companyId, 'launch');
  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'stage-restored' });
  assert.equal(await stageOf(restored.companyId), 'launch');
});
