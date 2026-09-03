/**
 * PRD F10 and F1.4 -- the owner's controls.
 *
 * The inbox is the only human interface, so the properties worth testing are
 * the ones that protect the owner's attention and make silence safe:
 * expiry cancels rather than executes (F10.4), stop-all is immediate (F5.8),
 * and a frozen company takes no external action (F1.4).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { freezeCompany, isStopAllRequested, clearStopAll } from '../../src/engine/control.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompany, grantCapability, type Fixture, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function newTask(fixture: Fixture, goal = 'work') {
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal },
    createdBy: 'owner',
    reserveTokens: 10_000,
  });
  // F8.11: a tier 2 action needs a plan on the record first. Written here so
  // every task this file creates has one, since the gate is not what these
  // tests are about.
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.nameservers' }]);
  return task;
}

function tier3Capability() {
  const calls = { executions: 0 };
  const capability: Capability<{ zone: string }, { ok: boolean }> = {
    name: 'dns.nameservers',
    adapter: 'test:dns',
    defaultTier: 3,
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

test('an unanswered approval expires into a cancellation, never an execution', async () => {
  const fixture = await createCompany('expiry');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');

  await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'dns.nameservers',
    tier: 3,
    actionSummary: 'Point the nameservers at the new host',
    rationale: 'Migration task asked for it.',
    consequenceIfDenied: 'The migration halts and the old host keeps serving.',
    ttlHours: 0, // already overdue
  });

  const waiting = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(waiting!.status, 'waiting_approval');

  const expired = await inbox.expireOverdue(fixture.companyId);
  assert.equal(expired, 1);

  const after = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(after!.status, 'cancelled',
    'silence must cancel the work, because an owner who never looked has not consented');
  assert.equal(after!.haltReason, 'approval_expired');
});

test('approving resumes the task and denying cancels it', async () => {
  const fixture = await createCompany('decisions');

  const approved = await newTask(fixture, 'approve-me');
  await transition(fixture.companyId, approved.id, 'running');
  const approvalId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: approved.id, capabilityName: 'dns.nameservers',
    tier: 3, actionSummary: 'Do the thing', rationale: 'because',
    consequenceIfDenied: 'nothing happens',
  });
  // Tier 3, so F10.10 wants the app and a second factor. Stated rather than
  // worked around: a test that reached a tier 3 approval without one would be
  // exercising a path the platform does not have.
  await inbox.decide(fixture.companyId, approvalId, 'approve', 'go ahead', {
    channel: 'app',
    assurance: 'mfa',
  });
  const resumed = await withTenant(fixture.companyId, (tx) => getTask(tx, approved.id));
  assert.equal(resumed!.status, 'running');

  const denied = await newTask(fixture, 'deny-me');
  await transition(fixture.companyId, denied.id, 'running');
  const denialId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: denied.id, capabilityName: 'dns.nameservers',
    tier: 3, actionSummary: 'Do the other thing', rationale: 'because',
    consequenceIfDenied: 'nothing happens',
  });
  await inbox.decide(fixture.companyId, denialId, 'deny', 'no');
  const stopped = await withTenant(fixture.companyId, (tx) => getTask(tx, denied.id));
  assert.equal(stopped!.status, 'cancelled');

  // Every decision is recorded as an event (F10.8).
  const decisions = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { decision: string } }>(
      "SELECT payload FROM events WHERE type = 'owner.decided' ORDER BY occurred_at",
    );
    return rows.map((r) => r.payload.decision);
  });
  assert.deepEqual(decisions, ['approve', 'deny']);
});

test('asking for clarification leaves the item open without a new task', async () => {
  const fixture = await createCompany('ask');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'dns.nameservers',
    tier: 3, actionSummary: 'Do the thing', rationale: 'because',
    consequenceIfDenied: 'nothing happens',
  });

  await inbox.decide(fixture.companyId, itemId, 'ask', 'why this host?');

  const open = await inbox.listOpen(fixture.companyId);
  assert.equal(open.length, 1, 'F10.3: the question is answered inside the same item');

  const taskCount = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM tasks');
    return Number(rows[0]!.count);
  });
  assert.equal(taskCount, 1, 'asking must not spawn a second task');
});

test('stop-all cancels every running task across companies', async () => {
  const a = await createCompany('stop-a');
  const b = await createCompany('stop-b');
  const taskA = await newTask(a);
  const taskB = await newTask(b);
  await transition(a.companyId, taskA.id, 'running');

  const started = Date.now();
  const cancelled = await inbox.stopEverything();
  const elapsed = Date.now() - started;

  assert.equal(cancelled, 2);
  assert.ok(elapsed < 5_000, `stop-all must complete within 5s, took ${elapsed}ms`);
  assert.equal(await isStopAllRequested(), true);

  for (const [fixture, task] of [[a, taskA], [b, taskB]] as const) {
    const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
    assert.equal(stored!.status, 'cancelled');
    assert.equal(stored!.haltReason, 'owner_stop');
  }
});

test('no external action runs while the platform is stopped', async () => {
  const fixture = await createCompany('stopped');
  const { capability, calls } = tier3Capability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, capability.name);

  const task = await newTask(fixture);
  await inbox.stopEverything();

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability(capability.name, { zone: 'example.com' });
      return {};
    }]]),
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(calls.executions, 0);
  await clearStopAll();
});

test('a frozen company takes no external action', async () => {
  const fixture = await createCompany('frozen');
  const { capability, calls } = tier3Capability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, capability.name);

  const task = await newTask(fixture);
  await freezeCompany(fixture.companyId);

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([['worker', async (ctx) => {
      await ctx.callCapability(capability.name, { zone: 'example.com' });
      return {};
    }]]),
  });

  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(calls.executions, 0);
});

test('an approval item carries everything needed to decide', async () => {
  // F10.2. If answering requires opening a log, the inbox has failed at the
  // one job it has.
  const fixture = await createCompany('decidable');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'dns.nameservers',
    tier: 3,
    actionSummary: 'Repoint nameservers for example.com to ns1.newhost.net',
    rationale: 'Task "migrate hosting" reached its cutover step.',
    consequenceIfDenied: 'The migration halts; the current host keeps serving traffic.',
    estimatedCostCents: 0,
  });

  const [item] = await inbox.listOpen(fixture.companyId);
  assert.ok(item);
  assert.equal(item.kind, 'approval');
  assert.equal(item.tier, 3);
  assert.match(item.actionSummary, /nameservers/);
  assert.match(item.rationale, /migrate hosting/);
  assert.match(item.consequenceIfDenied, /keeps serving/);
  assert.ok(item.expiresAt instanceof Date, 'an approval must have an expiry');
  assert.equal(item.taskId, task.id, 'the item links back to the task chain');
});


/**
 * PRD v2 F10.10: a tier 3 approval never happens over a message channel.
 *
 * The rule is enforced before any chat channel exists. A rule written at the
 * same time as the surface it constrains is a rule somebody has to remember;
 * this one is already true, so the integration that arrives later cannot be
 * the thing that forgets it.
 */
test('a tier 3 approval cannot be given over a chat channel (F10.10)', async () => {
  const fixture = await createCompany('tier3-channel');
  const task = await newTask(fixture, 'transfer the domain');
  await transition(fixture.companyId, task.id, 'running');

  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'domain.transfer',
    tier: 3,
    actionSummary: 'Transfer the domain',
    rationale: 'The registrar migration is finished.',
    consequenceIfDenied: 'The domain stays where it is.',
  });

  await assert.rejects(
    () => inbox.decide(fixture.companyId, itemId, 'approve', 'ok', { channel: 'chat' }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
  );

  // Refused *and* unchanged: the item is still open and the task still parked.
  const open = await inbox.listOpen(fixture.companyId);
  assert.ok(open.some((entry) => entry.id === itemId));

  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      "SELECT type FROM events WHERE type = 'security.tier3_channel_refused'",
    );
    return rows;
  });
  assert.equal(events.length, 1);

  // A denial over chat is fine: F10.10 bars approving, and refusing an action
  // is the safe direction. So is a tier 2 approval.
  await inbox.decide(fixture.companyId, itemId, 'deny', 'not yet', { channel: 'chat' });
});

/**
 * The other half of F10.10, which was not enforced.
 *
 * The requirement reads "approval tier 3 only through the app **with MFA**",
 * and only the channel half of that sentence was checked: `channel: 'app'` was
 * enough, so an integration that named the wrong channel — by mistake or by
 * laziness — got a tier 3 approval with no second factor at all. The channel
 * says which pipe the request came down. The assurance says how the person at
 * the other end was authenticated, which is what the requirement is about.
 *
 * PALUGADA cannot verify the assertion, exactly as it cannot verify `channel`,
 * and the code says so rather than dressing it up. What it buys is that
 * approving a tier 3 action without a second factor now requires the caller to
 * state something false, and the statement lands on the security event. Same
 * trade as F12.6's scopes: an accident becomes a lie, and the lie is recorded.
 */
test('a tier 3 approval needs a second factor, not just the right channel (F10.10, F12.5)', async () => {
  const fixture = await createCompany('tier3-mfa');
  const task = await newTask(fixture, 'wire the payment');
  await transition(fixture.companyId, task.id, 'running');

  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'payment.send',
    tier: 3,
    actionSummary: 'Send the payment',
    rationale: 'The invoice is verified.',
    consequenceIfDenied: 'The supplier is not paid this week.',
  });

  // The right channel and nothing said about authentication: refused, and the
  // message names the missing factor rather than blaming the channel.
  await assert.rejects(
    () => inbox.decide(fixture.companyId, itemId, 'approve', 'ok', { channel: 'app' }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
  );

  const refusals = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { assurance?: string; channel?: string } }>(
      "SELECT payload FROM events WHERE type = 'security.tier3_channel_refused'",
    );
    return rows;
  });
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.payload.assurance, 'none', 'what the caller claimed is on the record');
  assert.equal(refusals[0]!.payload.channel, 'app');

  // A session without a second factor is not enough either: F12.5 asks for
  // MFA, and "already logged in" is the thing MFA exists to be more than.
  await assert.rejects(
    () =>
      inbox.decide(fixture.companyId, itemId, 'approve', 'ok', {
        channel: 'app',
        assurance: 'session',
      }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
  );

  // Both halves together: the app, and a second factor.
  await inbox.decide(fixture.companyId, itemId, 'approve', 'ok', {
    channel: 'app',
    assurance: 'mfa',
  });
  const open = await inbox.listOpen(fixture.companyId);
  assert.equal(open.some((entry) => entry.id === itemId), false, 'the approval went through');
});

/**
 * What a message channel may carry, written before the channel exists.
 *
 * F10.9 names three things a chat channel is an *action* surface for — an
 * escalation, a skill candidate, and a review at tier 2 or below — and F10.10
 * carves out tier 3 as a link and nothing more. No channel exists here and none
 * can without a messaging account, so what is testable is the rule that would
 * govern one. Written now for the reason F10.10's prohibition was: a rule that
 * arrives with the integration is a rule the integration's author gets to
 * decide.
 */
test('the message channel rule is settled before the channel exists (F10.9, F10.10)', () => {
  assert.equal(inbox.channelDelivery({ kind: 'escalation', tier: null }), 'actionable');
  assert.equal(inbox.channelDelivery({ kind: 'skill_candidate', tier: null }), 'actionable');
  assert.equal(inbox.channelDelivery({ kind: 'approval', tier: 2 }), 'actionable');

  // The exception F10.10 states, and it wins over the kind: a tier 3 approval
  // reaches the phone and carries nothing to press.
  assert.equal(inbox.channelDelivery({ kind: 'approval', tier: 3 }), 'link_only');

  // An incident is push-worthy under F10.5 and is not one of the three F10.9
  // lists, so it notifies and offers no button. That is a reading rather than a
  // quotation and docs/STATUS.md says so.
  assert.equal(inbox.channelDelivery({ kind: 'incident', tier: null }), 'link_only');

  // Anything the requirement does not name is not a channel surface. The
  // default is "not this one", which is the direction to be wrong in.
  assert.equal(inbox.channelDelivery({ kind: 'budget_alert', tier: null }), 'none');
  assert.equal(inbox.channelDelivery({ kind: 'fact_candidate', tier: null }), 'none');
});
