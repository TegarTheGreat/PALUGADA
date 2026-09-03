/**
 * PRD F7 -- adversarial review and decision records.
 *
 * The property under test is that review is a gate, not a ceremony: nothing
 * external happens until a different role has judged the proposal against
 * explicit criteria, a rejection stops the work, and a deadlock reaches the
 * owner instead of looping.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { Engine, type TaskHandler } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { putPolicy } from '../../src/governance/store.ts';
import {
  MAX_REVISIONS,
  fingerprintAction,
  pendingReviews,
  settleCompletedReviews,
} from '../../src/review/review.ts';
import { recall } from '../../src/memory/store.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, addRole, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const REVIEWER_OUTPUT = {
  type: 'object',
  required: ['decision', 'reason'],
  properties: {
    decision: { enum: ['approve', 'revise', 'reject'] },
    reason: { type: 'string' },
  },
  additionalProperties: false,
} as const;

function emailCapability() {
  const calls = { executions: 0 };
  const capability: Capability<{ to: string; body: string }, { sent: boolean }> = {
    name: 'email.send',
    adapter: 'test:email',
    // Tier 2, matching the catalogue: PRD section 8.8 lists external email as a
    // tier 2 example, and a double that claimed tier 1 would be exercising
    // a gate the real capability never passes through.
    defaultTier: 2,
    async execute() {
      calls.executions += 1;
      return { sent: true };
    },
    async verify() {
      return true;
    },
    describe(input) {
      return { recipientDomain: input.to.split('@')[1] ?? null };
    },
  };
  return { capability, calls };
}

/** A company with a proposer, a reviewer, and a policy that requires review. */
async function reviewedCompany(slug: string) {
  const fixture = await createCompany(slug);
  const reviewerRoleId = await addRole(fixture, 'qa-reviewer', { output: REVIEWER_OUTPUT });

  const { capability, calls } = emailCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'email.send');

  await putPolicy({
    slug: 'no-client-email-without-review',
    effect: 'require_review',
    condition: { field: 'recipient_domain', op: 'not_in', value: ['internal.test'] },
    companyId: fixture.companyId,
    params: { reviewer_role: 'qa-reviewer', criteria: 'Is this message accurate and appropriate?' },
  });

  return { fixture, reviewerRoleId, registry, calls };
}

function engineFor(registry: CapabilityRegistry, handlers: Record<string, TaskHandler>) {
  return new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map(Object.entries(handlers)),
  });
}

async function proposerTask(fixture: Fixture) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    input: {},
    createdBy: 'owner',
    reserveTokens: 50_000,
  });
}

const PROPOSAL = { to: 'client@example.test', body: 'Hello' };

function handlers(verdict: { decision: string; reason: string }) {
  return {
    worker: async (ctx) => {
      await ctx.callCapability('email.send', PROPOSAL);
      return { sent: true };
    },
    'qa-reviewer': async () => verdict,
  } satisfies Record<string, TaskHandler>;
}

test('nothing external happens until a reviewer has judged it (F7.1)', async () => {
  const { fixture, registry, calls } = await reviewedCompany('review-gate');
  const engine = engineFor(registry, handlers({ decision: 'approve', reason: 'accurate' }));
  const task = await proposerTask(fixture);

  const first = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(first.status, 'waiting_review');
  assert.equal(calls.executions, 0, 'the email must not go out before the review');

  const pending = await pendingReviews(fixture.companyId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.reviewerRoleSlug, 'qa-reviewer');

  // The reviewer runs as an ordinary task with a typed output.
  const reviewOutcome = await engine.runTask(
    fixture.companyId,
    pending[0]!.reviewTaskId,
    'qa-reviewer',
  );
  assert.equal(reviewOutcome.status, 'completed');

  const settled = await settleCompletedReviews(fixture.companyId);
  assert.deepEqual(settled.map((s) => s.decision), ['approve']);

  // Approved, so the proposer resumes and the action now goes through.
  const resumed = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(resumed.status, 'completed');
  assert.equal(calls.executions, 1);
});

test('an approval covers only the action that was reviewed', async () => {
  // Otherwise a reviewed "send this draft" would license "send that other
  // thing", which is the whole gate defeated by an argument change.
  const { fixture, registry, calls } = await reviewedCompany('review-fingerprint');

  let payload = { ...PROPOSAL };
  const engine = engineFor(registry, {
    worker: async (ctx) => {
      await ctx.callCapability('email.send', payload);
      return { sent: true };
    },
    'qa-reviewer': async () => ({ decision: 'approve', reason: 'fine' }),
  });

  const task = await proposerTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  const [pending] = await pendingReviews(fixture.companyId);
  await engine.runTask(fixture.companyId, pending!.reviewTaskId, 'qa-reviewer');
  await settleCompletedReviews(fixture.companyId);

  // Same task, different message: the approval does not carry over.
  payload = { to: 'client@example.test', body: 'A completely different message' };
  const second = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(second.status, 'waiting_review');
  assert.equal(calls.executions, 0, 'an unreviewed variant must not slip through');

  const fingerprints = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ action_fingerprint: string }>(
      'SELECT DISTINCT action_fingerprint FROM review_requests',
    );
    return rows.map((r) => r.action_fingerprint);
  });
  assert.equal(fingerprints.length, 2, 'two distinct actions, two reviews');
  assert.ok(fingerprints.includes(fingerprintAction('email.send', PROPOSAL)));
});

test('a rejection stops the work (F7.1)', async () => {
  const { fixture, registry, calls } = await reviewedCompany('review-reject');
  const engine = engineFor(registry, handlers({ decision: 'reject', reason: 'misleading claim' }));
  const task = await proposerTask(fixture);

  await engine.runTask(fixture.companyId, task.id, 'worker');
  const [pending] = await pendingReviews(fixture.companyId);
  await engine.runTask(fixture.companyId, pending!.reviewTaskId, 'qa-reviewer');
  await settleCompletedReviews(fixture.companyId);

  const proposer = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(proposer!.status, 'failed');
  assert.equal(calls.executions, 0);
});

test('a reviewer may not review its own proposal (F7.3)', async () => {
  const fixture = await createCompany('review-self');
  const { capability } = emailCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'email.send');

  // The policy names the proposing role as its own reviewer.
  await putPolicy({
    slug: 'self-review',
    effect: 'require_review',
    condition: { field: 'tool', op: 'matches', value: 'email.*' },
    companyId: fixture.companyId,
    params: { reviewer_role: 'worker' },
  });

  const engine = engineFor(registry, handlers({ decision: 'approve', reason: 'looks fine to me' }));
  const task = await proposerTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');

  assert.notEqual(outcome.status, 'completed');
  const reviews = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query('SELECT id FROM review_requests');
    return rows;
  });
  assert.equal(reviews.length, 0, 'no review may be opened where proposer and reviewer are one');
});

test('the reviewer does not see the proposer\'s working memory (F7.3)', async () => {
  const { fixture, registry } = await reviewedCompany('review-isolation');

  const engine = engineFor(registry, {
    worker: async (ctx) => {
      // A private deliberation the reviewer must not inherit.
      await ctx.step('private-reasoning', 'internal', { n: 1 }, async () => ({
        secretJustification: 'we are behind on quota',
      }));
      await ctx.callCapability('email.send', PROPOSAL);
      return { sent: true };
    },
    'qa-reviewer': async () => ({ decision: 'approve', reason: 'fine' }),
  });

  const task = await proposerTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  const [pending] = await pendingReviews(fixture.companyId);

  const reviewTask = await withTenant(fixture.companyId, (tx) => getTask(tx, pending!.reviewTaskId));
  assert.ok(reviewTask);

  // The review task's own journal is empty, and its input carries the proposal
  // and criteria -- not the proposer's steps.
  const reviewerSteps = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query('SELECT step_index FROM task_steps WHERE task_id = $1', [
      reviewTask!.id,
    ]);
    return rows;
  });
  assert.equal(reviewerSteps.length, 0);
  assert.ok(reviewTask!.input.proposal, 'the reviewer receives the proposal');
  assert.ok(reviewTask!.input.criteria, 'and the criteria to judge it against');
  assert.equal(
    JSON.stringify(reviewTask!.input).includes('secretJustification'),
    false,
    "the proposer's private reasoning must not travel with the proposal",
  );
});

test('two revisions and then the owner decides (F7.2)', async () => {
  const { fixture, registry, calls } = await reviewedCompany('review-deadlock');
  const engine = engineFor(registry, handlers({ decision: 'revise', reason: 'still not right' }));
  const task = await proposerTask(fixture);

  let rounds = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
    if (outcome.status !== 'waiting_review') break;

    const pending = await pendingReviews(fixture.companyId);
    if (pending.length === 0) break;
    rounds += 1;
    await engine.runTask(fixture.companyId, pending[0]!.reviewTaskId, 'qa-reviewer');
    await settleCompletedReviews(fixture.companyId);
  }

  assert.equal(rounds, MAX_REVISIONS + 1, 'the first review plus two revisions, and no more');
  assert.equal(calls.executions, 0);

  const escalations = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'escalation',
  );
  assert.equal(escalations.length, 1, 'the deadlock reaches the owner');
  assert.match(escalations[0]!.title, /deadlock/i);
});

test('every verdict becomes a decision record and a remembered decision (F7.4, F7.5)', async () => {
  const { fixture, registry } = await reviewedCompany('review-records');
  const engine = engineFor(registry, handlers({ decision: 'reject', reason: 'unsupported claim' }));
  const task = await proposerTask(fixture);

  await engine.runTask(fixture.companyId, task.id, 'worker');
  const [pending] = await pendingReviews(fixture.companyId);
  await engine.runTask(fixture.companyId, pending!.reviewTaskId, 'qa-reviewer');
  await settleCompletedReviews(fixture.companyId);

  const record = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      decision: string;
      criteria: string;
      critique: { reason: string };
      proposer_role_id: string;
      reviewer_role_id: string;
      source_event_id: string | null;
    }>(
      `SELECT decision, criteria, critique, proposer_role_id, reviewer_role_id, source_event_id
         FROM decision_records`,
    );
    return rows[0]!;
  });

  assert.equal(record.decision, 'reject');
  assert.match(record.criteria, /accurate and appropriate/);
  assert.equal(record.critique.reason, 'unsupported claim');
  assert.notEqual(record.proposer_role_id, record.reviewer_role_id);
  assert.ok(record.source_event_id, 'the record links back to the event that carried it');

  // F7.5: and it is recallable as a decision, distinct from an observation.
  const decisions = await withTenant(fixture.companyId, (tx) =>
    recall(tx, fixture.companyId, {
      memoryType: 'semantic',
      divisionId: fixture.divisionId,
      factKind: 'decision',
    }),
  );
  assert.equal(decisions.length, 1);
  assert.match(decisions[0]!.body, /reject/);
  assert.equal(decisions[0]!.source, 'adversarial_review');
});

test('an unreadable verdict escalates rather than being read as approval', async () => {
  const { fixture, registry, calls } = await reviewedCompany('review-unreadable');
  const engine = engineFor(registry, {
    worker: async (ctx) => {
      await ctx.callCapability('email.send', PROPOSAL);
      return { sent: true };
    },
    // The reviewer fails outright. Treating that as consent would make the
    // gate decorative in exactly the situation it exists for.
    'qa-reviewer': async () => {
      throw new Error('reviewer crashed');
    },
  });

  const task = await proposerTask(fixture);
  await engine.runTask(fixture.companyId, task.id, 'worker');
  const [pending] = await pendingReviews(fixture.companyId);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await engine.runTask(fixture.companyId, pending!.reviewTaskId, 'qa-reviewer');
  }

  const settled = await settleCompletedReviews(fixture.companyId);
  assert.deepEqual(settled.map((s) => s.decision), ['unreadable']);
  assert.equal(calls.executions, 0);

  const escalations = (await inbox.listOpen(fixture.companyId)).filter(
    (item) => item.kind === 'escalation',
  );
  assert.equal(escalations.length, 1);
});

test('no scheduled review exists (F7.6)', async () => {
  // F7.6 says reviews are triggered by policy or by the owner, never by a
  // recurring meeting. Asserted against the schedule table because the
  // temptation this rules out is a cron entry, not a code path.
  const { fixture } = await reviewedCompany('review-no-meetings');

  const schedules = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query('SELECT slug FROM schedules');
    return rows;
  });
  assert.equal(schedules.length, 0, 'setting up review must not create a recurring job');
});
