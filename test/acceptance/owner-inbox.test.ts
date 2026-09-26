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
import { claimTask } from '../../src/engine/checkout.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { freezeCompany, isStopAllRequested, clearStopAll } from '../../src/engine/control.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompany, grantCapability, type Fixture, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerMfa, decodeBase32, newTotpSecret, stepFor, totpCode } from '../../src/owner/mfa.ts';

/**
 * A real second factor, because F10.10 no longer accepts a claimed one.
 *
 * Enrolled per test rather than shared: `resetData` truncates the
 * authenticators along with everything else, and a fixture that outlived that
 * would be a fixture pointing at a row that is gone.
 */
async function enrolledOwner(): Promise<{ mfa: OwnerMfa; code: () => string }> {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/totp', secret);
  const mfa = new OwnerMfa({ secrets });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/totp' });
  // A fresh code per call: a TOTP code cannot be used twice, so a test that
  // approved two things would fail on the second for the wrong reason.
  let drift = 0;
  return {
    mfa,
    code: () => totpCode(decodeBase32(secret), stepFor(new Date()) + drift++),
  };
}

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
  // Tier 3, so F10.10 wants the app and a second factor -- a real one, checked
  // against an enrolled authenticator rather than asserted.
  const owner = await enrolledOwner();
  await inbox.decide(fixture.companyId, approvalId, 'approve', 'go ahead', {
    channel: 'app',
    proof: { totp: owner.code() },
    mfa: owner.mfa,
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
 * It was first fixed by asking the caller and writing the answer down, which
 * turned an accident into a lie an auditor could find but did not stop the
 * lie. It is now *verified*: `OwnerMfa` checks a TOTP code or a passkey
 * assertion against an enrolled authenticator, and `assurance: 'mfa'` is what
 * `decide` concludes rather than what a caller may say. `owner-mfa.test.ts`
 * covers the arithmetic; this covers the gate.
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

  // And a claimed second factor with nothing behind it, which is what this
  // test used to accept.
  await assert.rejects(
    () =>
      inbox.decide(fixture.companyId, itemId, 'approve', 'ok', {
        channel: 'app',
        assurance: 'mfa',
      }),
    (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'),
  );

  // Both halves together: the app, and a second factor that verifies.
  const owner = await enrolledOwner();
  await inbox.decide(fixture.companyId, itemId, 'approve', 'ok', {
    channel: 'app',
    proof: { totp: owner.code() },
    mfa: owner.mfa,
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
  // Same decision, older name: `proposeSop` still raises this one.
  assert.equal(inbox.channelDelivery({ kind: 'sop_candidate', tier: null }), 'actionable');
  assert.equal(inbox.channelDelivery({ kind: 'approval', tier: 2 }), 'actionable');

  // The exception F10.10 states: a tier 3 *approval* reaches the phone and
  // carries nothing to press.
  assert.equal(inbox.channelDelivery({ kind: 'approval', tier: 3 }), 'link_only');

  // And it is scoped to approvals, which the first version of this rule got
  // wrong. F10.10 restricts approving an irreversible action; an escalation is
  // a question. `proposeGoalChange` raises exactly this — an escalation
  // carrying tier 3 because the inbox sorts by it — and answering it must not
  // require opening an app that does not exist.
  assert.equal(inbox.channelDelivery({ kind: 'escalation', tier: 3 }), 'actionable');

  // An incident is push-worthy under F10.5 and is not one of the three F10.9
  // lists, so it notifies and offers no button. That is a reading rather than a
  // quotation and docs/STATUS.md says so.
  assert.equal(inbox.channelDelivery({ kind: 'incident', tier: null }), 'link_only');

  // Anything the requirement does not name is not a channel surface. The
  // default is "not this one", which is the direction to be wrong in.
  assert.equal(inbox.channelDelivery({ kind: 'budget_alert', tier: null }), 'none');
  // A fact is not a procedure and F10.9 does not name it, so it stays off the
  // channel until somebody decides it belongs there.
  assert.equal(inbox.channelDelivery({ kind: 'fact_candidate', tier: null }), 'none');
});

/* ----------------------------------------------- an item ends with its task --- */

async function openApprovalFor(fixture: Fixture, taskId: string): Promise<string> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inbox_items (company_id, task_id, kind, title, action_summary,
                                rationale, tier, capability_name)
       VALUES ($1, $2, 'approval', 'Point the domain elsewhere',
               'Point the domain elsewhere', 'migration', 1, 'dns.nameservers')
       RETURNING id`,
      [fixture.companyId, taskId],
    );
    return rows[0]!.id;
  });
}

async function budgetReserved(fixture: Fixture): Promise<number> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ reserved: string }>(
      'SELECT tokens_reserved::text AS reserved FROM budget_accounts WHERE id = $1',
      [fixture.budgetAccountId],
    );
    return Number(rows[0]!.reserved);
  });
}

/**
 * F10.7 says "every task", and the list it replaced named four statuses of the
 * six that are live. A claimed task and one parked on a window survived the
 * stop button -- held back by the flag and back to work the moment it was
 * cleared -- and every task it did cancel kept its reservation and its lease,
 * because the stop is a bulk UPDATE that never went through `transition()`.
 */
test('stop-all cancels claimed and parked tasks too, and gives back what they held (F10.7)', async () => {
  const fixture = await createCompany('stop-everything');
  const claimed = await newTask(fixture, 'claimed');
  const parked = await newTask(fixture, 'parked');
  const asking = await newTask(fixture, 'asking');
  assert.equal(await budgetReserved(fixture), 30_000, 'three tasks, ten thousand each');

  const claim = await claimTask(fixture.companyId, { holder: 'worker-1', taskId: claimed.id });
  assert.equal(claim?.taskId, claimed.id);
  await transition(fixture.companyId, parked.id, 'running');
  await transition(fixture.companyId, parked.id, 'waiting_window', {
    waitUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
  });
  await transition(fixture.companyId, asking.id, 'running');
  const approvalId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: asking.id, capabilityName: 'dns.nameservers',
    tier: 2, actionSummary: 'Point the domain elsewhere', rationale: 'migration',
    consequenceIfDenied: 'the old host stays',
  });

  try {
    assert.equal(await inbox.stopEverything(), 3);

    for (const task of [claimed, parked, asking]) {
      const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
      assert.equal(stored!.status, 'cancelled', `${task.id} was left ${stored!.status}`);
      assert.equal(stored!.tokensReserved, 0);
    }
    const lease = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ lease_holder: string | null }>(
        'SELECT lease_holder FROM tasks WHERE id = $1', [claimed.id],
      );
      return rows[0]!.lease_holder;
    });
    assert.equal(lease, null, 'a lease left on a cancelled task holds its lane');
    assert.equal(await budgetReserved(fixture), 0, 'the reservations went back to the account');

    // And the approval stopped asking, with the timeline saying why.
    const item = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ status: string; closed_reason: string | null }>(
        'SELECT status, closed_reason FROM inbox_items WHERE id = $1', [approvalId],
      );
      return rows[0]!;
    });
    assert.deepEqual(item, { status: 'withdrawn', closed_reason: 'task_cancelled' });
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await clearStopAll();
  }
});

/**
 * The rule is in the database so the bulk path cannot skip it, and it is
 * narrow on purpose: an escalation about a task is usually *why* it ended,
 * and withdrawing it then would hide the one item the owner needs.
 */
test('an approval is withdrawn when its task ends another way; an escalation is not', async () => {
  const fixture = await createCompany('withdrawn');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  const approvalId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'dns.nameservers',
    tier: 2, actionSummary: 'Point the domain elsewhere', rationale: 'migration',
    consequenceIfDenied: 'the old host stays',
  });
  const escalationId = await inbox.raiseEscalation({
    companyId: fixture.companyId, taskId: task.id,
    title: 'The registrar is refusing', detail: 'It wants a phone call.',
  });
  await transition(fixture.companyId, task.id, 'cancelled');

  const statuses = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM inbox_items WHERE task_id = $1', [task.id],
    );
    return new Map(rows.map((row) => [row.id, row.status]));
  });
  assert.equal(statuses.get(approvalId), 'withdrawn');
  assert.equal(statuses.get(escalationId), 'open');

  const withdrawn = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { inboxItemId: string; taskStatus: string } }>(
      "SELECT payload FROM events WHERE type = 'approval.withdrawn'",
    );
    return rows.map((row) => row.payload);
  });
  assert.deepEqual(withdrawn, [{ inboxItemId: approvalId, taskStatus: 'cancelled' }]);

  // Pressing approve on it now says what happened rather than "is not open".
  await assert.rejects(
    inbox.decide(fixture.companyId, approvalId, 'approve'),
    (error: unknown) =>
      isPalugadaError(error)
      && error.code === 'inbox.not_open'
      && error.details.status === 'withdrawn'
      && /withdrawn \(task_cancelled\)/.test(error.message),
  );
});

/**
 * The decision and the task's move are two transactions, and the owner has
 * more than one surface. A decision that lands a moment after the task ended
 * is still the owner's and stays recorded; what it must not produce is an
 * error saying the decision failed, when the truth is that the task was gone.
 */
test('a decision that lands after its task ended is recorded, not reported as a failure', async () => {
  const fixture = await createCompany('moot');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'completed');
  // Written straight in, because it is the state a race leaves behind and no
  // single call produces it any more: the item open, its task already over.
  const itemId = await openApprovalFor(fixture, task.id);

  await inbox.decide(fixture.companyId, itemId, 'approve');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'completed', 'a finished task is not restarted');
  const moot = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'owner.decision_moot'",
    );
    return rows.map((row) => row.payload);
  });
  assert.deepEqual(moot, [{ inboxItemId: itemId, taskStatus: 'completed', wanted: 'running' }]);
});

/**
 * The decision and the move are one transaction now, and this is the property
 * that says so: when the move is refused, the decision is not left behind.
 * As two transactions the item was already `decided` by the time the state
 * machine said no, so the owner saw an error, the inbox showed nothing to
 * answer, and the task sat where it was for ever.
 */
test('a decision the task cannot follow is not recorded half-way', async () => {
  const fixture = await createCompany('atomic-decision');
  const task = await newTask(fixture);
  // Still `running`: the state an approval was in for the moment between
  // being raised and its task being parked, when those were two transactions.
  // `running -> running` is not an edge, so the move is refused.
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await openApprovalFor(fixture, task.id);

  await assert.rejects(
    inbox.decide(fixture.companyId, itemId, 'approve'),
    (error: unknown) => isPalugadaError(error, 'task.invalid_transition'),
  );
  const item = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string; decision: string | null }>(
      'SELECT status, decision FROM inbox_items WHERE id = $1', [itemId],
    );
    return rows[0]!;
  });
  assert.deepEqual(item, { status: 'open', decision: null }, 'still the owner\'s to decide');
  const decided = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query("SELECT 1 FROM events WHERE type = 'owner.decided'");
    return rows.length;
  });
  assert.equal(decided, 0, 'no decision on the timeline that did not happen');
});

/**
 * An expiry is recorded even when there is nothing left to cancel. The sweep
 * is one transaction now, so a task that had already ended would otherwise
 * have thrown the whole sweep back -- every overdue item in the company kept
 * open because one of them pointed at a finished task.
 */
test('an overdue approval for a finished task still expires, and the others with it', async () => {
  const fixture = await createCompany('expire-finished');
  const finished = await newTask(fixture, 'finished');
  await transition(fixture.companyId, finished.id, 'running');
  await transition(fixture.companyId, finished.id, 'completed');
  const stale = await openApprovalFor(fixture, finished.id);
  const live = await newTask(fixture, 'live');
  await transition(fixture.companyId, live.id, 'running');
  await inbox.requestApproval({
    companyId: fixture.companyId, taskId: live.id, capabilityName: 'dns.nameservers',
    tier: 2, actionSummary: 'Point the domain elsewhere', rationale: 'migration',
    consequenceIfDenied: 'the old host stays', ttlHours: 0,
  });
  await withTenant(fixture.companyId, (tx) =>
    tx.query("UPDATE inbox_items SET expires_at = now() - interval '1 minute' WHERE id = $1", [stale]),
  );

  assert.equal(await inbox.expireOverdue(fixture.companyId), 2);
  const [a, b] = await withTenant(fixture.companyId, async (tx) =>
    Promise.all([getTask(tx, finished.id), getTask(tx, live.id)]));
  assert.equal(a!.status, 'completed', 'a finished task is left finished');
  assert.equal(b!.status, 'cancelled');
  assert.equal(b!.haltReason, 'approval_expired');
});

/**
 * A stop that lands between a transition's check and its write must win.
 *
 * `transition()` read the status, checked the edge, and wrote -- two
 * statements, no lock. A cancellation committed between them was simply
 * overwritten: the check had read `running`, so `completed` went over
 * `cancelled`, and a task the owner had stopped reported that it finished.
 * This holds the cancellation open, lets the transition start, and only then
 * commits, which is exactly that interleaving.
 */
test('a transition racing a cancellation is refused rather than overwriting it', async () => {
  const fixture = await createCompany('race');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const stopper = withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `UPDATE tasks SET status = 'cancelled', halt_reason = 'owner_stop', finished_at = now()
        WHERE id = $1`,
      [task.id],
    );
    held();
    await gate;
  });

  await holding;
  const mover = transition(fixture.companyId, task.id, 'completed').then(
    () => null,
    (error: unknown) => error,
  );
  // Long enough for the transition to have read and reached its write.
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await stopper;

  const refused = await mover;
  assert.ok(isPalugadaError(refused, 'task.invalid_transition'), `got ${String(refused)}`);
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'cancelled', 'the stop was not overwritten');
});
