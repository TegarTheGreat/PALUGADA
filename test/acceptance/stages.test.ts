/**
 * Stage gates (0057, src/domain/stage.ts).
 *
 * auto-company runs every idea through explore, validate -- a GO or NO-GO on
 * evidence -- build, launch and grow, and winds it down when it is not
 * working. These hold what that is here: a stage the owner sets and no run
 * can, a fact policies read so "no paid reach before launch" is a rule, a
 * sentence every run is told, and a proposal a run makes and the owner
 * answers -- with their device when the move loosens what the company may do.
 *
 * And the critic (company-os 1.4.0): auto-company asks for a premortem before
 * any GO and nothing makes one happen. Here a proposal to move the stage is
 * read by a role that holds nothing that acts before the owner is asked, and
 * what it said reaches the owner whichever way it went.
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
import { declarationFor } from '../../src/broker/catalogue.ts';
import { stageProposeCapability } from '../../src/broker/platform-capabilities.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { installBundle, publishBundle } from '../../src/bundles/bundle.ts';
import { pendingReviews, settleCompletedReviews } from '../../src/review/review.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
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

test('winding down, a reply to a customer goes to the owner, and nothing new is started', async () => {
  // The stage is for finishing what is owed to customers, and its rule
  // denied every tier 2 action outside finance -- Support's replies among
  // them -- with an effect the owner could not answer from the inbox.
  const fixture = await createCompany('stage-wind-down');
  const done: string[] = [];
  const counting = (name: string): Capability<Record<string, unknown>, { ok: boolean }> => ({
    name,
    adapter: `test:${name}`,
    defaultTier: 2,
    async execute() {
      done.push(name);
      return { ok: true };
    },
    async verify() {
      return true;
    },
  });
  const registry = new CapabilityRegistry();
  const names = ['email.send', 'ads.campaign.start', 'domain.purchase'];
  for (const name of names) registry.register(counting(name));
  await registry.sync();
  for (const name of names) await grantCapability(fixture, name);
  for (const rule of COMPANY_OS.body.policies.filter((policy) => policy.slug.startsWith('wind-down'))) {
    await putPolicy({ companyId: fixture.companyId, slug: rule.slug, effect: rule.effect, condition: rule.condition });
  }
  await setStage(fixture.companyId, 'wind_down');

  const broker = new CapabilityBroker(registry);
  const attempt = async (task: { id: string }, capability: string, input: Record<string, unknown>, key: string) =>
    broker.invoke({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, taskId: task.id, idempotencyKey: key,
    }, capability, input);
  const planned = async (capability: string, goal: string) => {
    const task = await running(fixture, goal);
    await recordPlan(fixture.companyId, task.id, [{ capability, intent: goal, expectedEffect: 'done' }]);
    return task;
  };

  // A reply to a customer who is owed an answer: the owner decides.
  const reply = await planned('email.send', 'answer Budi about his refund');
  const sending = { to: 'budi@example.com', body: 'Your refund was sent today.' };
  await assert.rejects(attempt(reply, 'email.send', sending, 'r1'), (error: unknown) => isPalugadaError(error, 'approval.required'));
  const [card] = (await inbox.listOpen(fixture.companyId)).filter((item) => item.taskId === reply.id);
  assert.equal(card!.capabilityName, 'email.send');
  assert.match(card!.rationale, /wind-down-asks-first requires your approval/);
  await inbox.decide(fixture.companyId, card!.id, 'approve', 'He is owed it.');
  await attempt(reply, 'email.send', sending, 'r2');
  assert.deepEqual(done, ['email.send'], 'approved, the reply goes');

  // New reach and new purchases are refused, whoever asks.
  const ads = await planned('ads.campaign.start', 'a closing-down sale campaign');
  await assert.rejects(attempt(ads, 'ads.campaign.start', { budget: 100 }, 'a1'),
    (error: unknown) => isPalugadaError(error, 'policy.denied'));
  const domain = await planned('domain.purchase', 'a domain for the next idea');
  await assert.rejects(attempt(domain, 'domain.purchase', { name: 'next.example' }, 'd1'),
    (error: unknown) => isPalugadaError(error, 'policy.denied'));
  assert.deepEqual(done, ['email.send']);
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 0, 'nothing refused was put to the owner');

  // Out of wind-down, neither rule reads anything.
  await setStage(fixture.companyId, 'grow');
  const later = await planned('email.send', 'answer Sari');
  await attempt(later, 'email.send', { to: 'sari@example.com', body: 'Thanks.' }, 'g1');
  assert.deepEqual(done, ['email.send', 'email.send']);
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
  assert.equal(item!.title, 'Move the company from Validate to Build?');
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

/* ------------------------------------------------ the critic (company-os) --- */

/** A company running the shipped operating kit, in the validate stage. */
async function withTheKit(slug: string) {
  const fixture = await createCompany(slug);
  const registry = await registerStandardCatalogue();
  await publishBundle(COMPANY_OS);
  await installBundle({ companyId: fixture.companyId, slug: COMPANY_OS.slug, version: COMPANY_OS.version });
  await setStage(fixture.companyId, 'validate');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ slug: string; id: string; division_id: string }>(
    "SELECT slug, id, division_id FROM roles WHERE slug IN ('strategist', 'critic')"));
  const role = (name: string) => rows.find((row) => row.slug === name)!;
  return { fixture, registry, strategist: role('strategist'), critic: role('critic') };
}

type Kit = Awaited<ReturnType<typeof withTheKit>>;

/** The GO the strategist proposes in these tests. */
const GO = {
  to: 'build',
  evidence: 'Twelve pre-orders at $29, paid (ledger, week 38). Five interviews named the cost of the problem.',
  why: 'The premortem found no fatal risk.',
};

/**
 * The strategist proposes the GO, and carries on with the rest of its work
 * when the proposal is refused, as a run does with any refused call.
 */
function kitEngine(kit: Kit, verdict: { decision: string; reason: string }) {
  const strategist: TaskHandler = async (ctx) => {
    try {
      await ctx.callCapability('stage.propose', GO);
      return { summary: 'Proposed moving to build.' };
    } catch (error) {
      if (!isPalugadaError(error, 'policy.denied')) throw error;
      return { summary: `No move proposed. ${(error as Error).message}` };
    }
  };
  return new Engine({
    broker: new CapabilityBroker(kit.registry),
    llm: new RecordingLlmClient(),
    handlers: new Map<string, TaskHandler>([['strategist', strategist], ['critic', async () => verdict]]),
  });
}

async function strategistAtWork(kit: Kit) {
  return createRootTask({
    companyId: kit.fixture.companyId, projectId: kit.fixture.projectId, divisionId: kit.strategist.division_id,
    roleId: kit.strategist.id, budgetAccountId: kit.fixture.budgetAccountId, goalId: kit.fixture.goalId,
    input: { goal: 'Weekly business review' }, createdBy: 'owner', reserveTokens: 20_000,
  });
}

/** Every stage proposal the owner has been put, open or not. */
const stageProposals = async (companyId: string) => (await withTenant(companyId, (tx) => tx.query<{
  id: string; title: string; rationale: string; payload: { review?: Record<string, unknown> };
}>("SELECT id, title, rationale, payload FROM inbox_items WHERE payload ? 'stageChange'"))).rows;

/** Proposes, has the critic answer, and records its verdict; the proposal is looked for at each step. */
async function throughTheCritic(kit: Kit, engine: Engine) {
  const { companyId } = kit.fixture;
  const strategist = await strategistAtWork(kit);
  assert.equal((await engine.runTask(companyId, strategist.id, 'strategist')).status, 'waiting_review');
  assert.deepEqual(await stageProposals(companyId), [], 'the owner is not asked before the critic has read it');

  const [review] = await pendingReviews(companyId);
  assert.equal(review!.reviewerRoleSlug, 'critic');
  // In the critic's own division, so under its grants and its hook rather
  // than the strategist's, and told what to judge and against what.
  const reviewTask = (await withTenant(companyId, (tx) => getTask(tx, review!.reviewTaskId)))!;
  assert.equal(reviewTask.divisionId, kit.critic.division_id);
  assert.deepEqual((reviewTask.input.proposal as { input: unknown }).input, GO);
  assert.match(String(reviewTask.input.criteria), /willingness to pay shown by money or a signed commitment/i);

  assert.equal((await engine.runTask(companyId, review!.reviewTaskId, 'critic')).status, 'completed');
  assert.deepEqual(await stageProposals(companyId), [], 'nor before its verdict is recorded');
  const settled = await settleCompletedReviews(companyId);
  return { strategist, review: review!, settled };
}

test('a stage move reaches the owner only after the critic, and carries what the critic said', async () => {
  const kit = await withTheKit('stage-critic-support');
  const verdict = {
    decision: 'approve',
    reason: 'Support. Twelve paid pre-orders are money, not interest. It dies if the $29 was a launch '
      + 'discount nobody renews; watch the second month\'s renewals.',
  };
  const engine = kitEngine(kit, verdict);
  const { strategist, review, settled } = await throughTheCritic(kit, engine);
  assert.deepEqual(settled.map((one) => one.decision), ['approve']);

  assert.equal((await engine.runTask(kit.fixture.companyId, strategist.id, 'strategist')).status, 'completed');
  const [proposal, ...more] = await stageProposals(kit.fixture.companyId);
  assert.equal(more.length, 0);
  assert.equal(proposal!.title, 'Move the company from Validate to Build?');
  assert.match(proposal!.rationale, /Twelve pre-orders at \$29/, 'the evidence, as before');
  assert.ok(proposal!.rationale.includes(verdict.reason), 'and the critic\'s verdict, on the card the owner answers');
  assert.deepEqual(proposal!.payload.review, {
    reviewer: 'critic', decision: 'approve', reason: verdict.reason, reviewRequestId: review.reviewRequestId,
  });
  assert.equal(await stageOf(kit.fixture.companyId), 'validate', 'the move is still the owner\'s');
});

test('a move the critic opposes never reaches the owner as a proposal, and its reasons do', async () => {
  const kit = await withTheKit('stage-critic-oppose');
  const { companyId } = kit.fixture;
  const verdict = {
    decision: 'reject',
    reason: 'Oppose. The twelve "pre-orders" are a waitlist: willingness to pay is interest, not money. '
      + 'Nothing stops a competitor copying this in two weeks.',
  };
  const engine = kitEngine(kit, verdict);
  const { strategist, settled } = await throughTheCritic(kit, engine);
  assert.deepEqual(settled.map((one) => one.decision), ['reject']);
  assert.deepEqual(await stageProposals(companyId), [], 'nothing the owner could approve into a move');

  // The owner is told what was proposed and why it was stopped.
  const told = (await inbox.listOpen(companyId)).filter((item) => item.rationale.includes(verdict.reason));
  assert.equal(told.length, 1, 'the critic\'s reasons are on an item in the owner\'s inbox');
  // By the name the kit gives the critic, not its code (§2.3 item 10).
  assert.equal(told[0]!.title, 'Citra stopped a proposal to move the company from Validate to Build');
  assert.match(told[0]!.rationale, /Twelve pre-orders at \$29/, 'with the evidence it was stopped on');
  assert.match(told[0]!.consequenceIfDenied, /stays in the Validate stage/);

  // A no to a stage move is not a stop to the work that proposed it, from
  // the critic as from the owner: the strategist is told why and finishes.
  assert.equal((await engine.runTask(companyId, strategist.id, 'strategist')).status, 'completed');
  const finished = (await withTenant(companyId, (tx) => getTask(tx, strategist.id)))!;
  assert.ok(String(finished.output!.summary).includes(verdict.reason), String(finished.output!.summary));

  // Answering the item moves nothing, and leaves room for the next proposal.
  await inbox.decide(companyId, told[0]!.id, 'approve', 'seen');
  assert.equal(await stageOf(companyId), 'validate');
  const next = await stageProposeCapability().execute({ to: 'build', evidence: 'Paid, this time.' }, {
    companyId, projectId: kit.fixture.projectId, divisionId: kit.strategist.division_id,
    roleId: kit.strategist.id, taskId: strategist.id, idempotencyKey: 'again',
  } as never);
  assert.equal(next.proposed, true);
});

test('the critic holds nothing that acts, and is refused anything at tier 1 or above', async () => {
  // What the bundle grants it: reads, every one catalogued at tier 0.
  const critic = COMPANY_OS.body.roles.find((role) => role.slug === 'critic')!;
  const held = COMPANY_OS.body.grants.filter((grant) => grant.division === critic.division);
  assert.ok(held.length > 0);
  for (const grant of held) assert.equal(declarationFor(grant.capability)?.tier, 0, grant.capability);
  assert.ok(!held.some((grant) => grant.capability === 'stage.propose'), 'nor may it propose the move itself');

  // And a grant somebody adds later does not change that: the kit's hook
  // refuses the critic's division anything at tier 1 or above.
  const kit = await withTheKit('stage-critic-read-only');
  const { companyId } = kit.fixture;
  await withTenant(companyId, (tx) => tx.query(
    `INSERT INTO capability_grants (company_id, division_id, capability_name) VALUES ($1, $2, 'doc.draft')`,
    [companyId, kit.critic.division_id]));
  const task = await createRootTask({
    companyId, projectId: kit.fixture.projectId, divisionId: kit.critic.division_id, roleId: kit.critic.id,
    budgetAccountId: kit.fixture.budgetAccountId, goalId: kit.fixture.goalId,
    input: { goal: 'read the evidence' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(companyId, task.id, 'running');
  const broker = new CapabilityBroker(kit.registry);
  const ctx = (key: string) => ({
    companyId, projectId: kit.fixture.projectId, divisionId: kit.critic.division_id,
    roleId: kit.critic.id, taskId: task.id, idempotencyKey: key,
  });

  await broker.invoke(ctx('read'), 'memory.search', { query: 'pre-orders' });
  await assert.rejects(broker.invoke(ctx('write'), 'doc.draft', { title: 'my own plan' }), (error: unknown) =>
    isPalugadaError(error, 'hook.denied')
      && (error as { details: { hook?: string } }).details.hook === 'strategy-review.read-only');
});
