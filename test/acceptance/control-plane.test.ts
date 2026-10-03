/**
 * PRD v2 F1.6, F2.1, F2.9, F3.9, F3.11, F4.8, F5.10, F6.7, F7.7, F10.3,
 * F12.7–F12.10 -- the control-plane requirements that are each small on their
 * own and load-bearing together.
 *
 * They share a file because they share a subject: what the owner controls and
 * what an agent cannot change. A grant an agent could widen would make every
 * policy optional; a budget a division could raise would make the company
 * ceiling decorative; a device that could enrol itself would make pairing a
 * formality.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import * as budget from '../../src/engine/budget.ts';
import { createRootTask, createSubTask, getTask, transition } from '../../src/engine/tasks.ts';
import { claimTask } from '../../src/engine/checkout.ts';
import {
  CONTEXT_PACK_TOKEN_LIMIT,
  buildContext,
  estimateContextTokens,
} from '../../src/context/builder.ts';
import { remember } from '../../src/memory/store.ts';
import {
  applyGrantChange,
  escalationPolicyFor,
  proposeStructuralChange,
  setEscalationPolicy,
  DEFAULT_ESCALATION_MINUTES,
} from '../../src/governance/structure.ts';
import { history, recordVersion, restore } from '../../src/governance/config-versions.ts';
import { applyRoleChange } from '../../src/governance/structure.ts';
import { publishCharter, putPolicy } from '../../src/governance/store.ts';
import { exportToDisk, importFromDisk } from '../../src/governance/charter-files.ts';
import { CharterRepository } from '../../src/governance/charter-repository.ts';

const exec = promisify(execFile);
import {
  claimIdempotencyKey,
  connect,
  issueChallenge,
  pairDevice,
  registerDevice,
  revokeDevice,
  assertWithinQuarantine,
} from '../../src/gateway/gateway.ts';
import { chooseReviewerModel } from '../../src/review/review.ts';
import { containChildResult, estimateTokens, CHILD_OUTPUT_TOKEN_LIMIT, CHILD_SUMMARY_TOKEN_LIMIT } from '../../src/engine/containment.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, addRole, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;
async function newTask(
  fixture: Fixture,
  options: { priority?: number; accountId?: string } = {},
) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: options.accountId ?? fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { run: sequence },
    createdBy: 'owner',
    reserveTokens: 100,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  });
}

/* ------------------------------------------------------------------ F1.6 --- */

/**
 * A division's ceiling is its own *and* the company's.
 *
 * The failure this prevents: a division account with room to spare, drawing on
 * a company that has none. Without inheritance the division's limit would be
 * the only one that ever applied, and the company figure would be a number in
 * a settings page.
 */
test('spending against a division account also spends against the company (F1.6)', async () => {
  const fixture = await createCompany('budget-scope', { tokensMax: 1_000 });

  const divisionAccount = await withTenant(fixture.companyId, (tx) =>
    budget.createAccount(tx, {
      companyId: fixture.companyId,
      label: 'ops',
      tokensMax: 10_000,
      moneyMaxCents: 10_000,
      scope: {
        scopeType: 'division',
        scopeId: fixture.divisionId,
        parentAccountId: fixture.budgetAccountId,
      },
    }),
  );

  const chain = await withTenant(fixture.companyId, (tx) =>
    budget.chainFor(tx, divisionAccount),
  );
  assert.deepEqual(chain, [divisionAccount, fixture.budgetAccountId]);

  // The division could afford 5,000 on its own. The company cannot.
  const refused = await withTenant(fixture.companyId, (tx) =>
    budget.reserve(tx, divisionAccount, 5_000),
  );
  assert.equal(refused, false);

  const allowed = await withTenant(fixture.companyId, (tx) =>
    budget.reserve(tx, divisionAccount, 400),
  );
  assert.equal(allowed, true);

  // And it counted in both places, so the company's headroom really moved.
  const company = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  const division = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, divisionAccount),
  );
  assert.equal(company.tokensReserved, 400);
  assert.equal(division.tokensReserved, 400);
});

test('a task draws on the narrowest account that exists (F1.6)', async () => {
  const fixture = await createCompany('budget-narrowest');
  const divisionAccount = await withTenant(fixture.companyId, (tx) =>
    budget.createAccount(tx, {
      companyId: fixture.companyId,
      label: 'ops',
      tokensMax: 5_000,
      scope: {
        scopeType: 'division',
        scopeId: fixture.divisionId,
        parentAccountId: fixture.budgetAccountId,
      },
    }),
  );

  const chosen = await withTenant(fixture.companyId, (tx) =>
    budget.accountFor(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.equal(chosen, divisionAccount);

  // A division with no account of its own falls through to the company's.
  const other = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [fixture.companyId, 'lab', 'Lab'],
    );
    return budget.accountFor(tx, { companyId: fixture.companyId, divisionId: rows[0]!.id });
  });
  assert.equal(other, fixture.budgetAccountId);
});

/**
 * And a task actually lands on it.
 *
 * The two tests above check the machinery: the chain walks, and `accountFor`
 * picks the narrowest. Neither shows a task using it, and for a while nothing
 * did — `accountFor` was written, tested and called by nobody, so every task in
 * every company drew on the company account and a division ceiling was a row in
 * a table. This is the wiring, which is the part that was missing.
 */
test('a root task is funded by its division account, and a sub-task by its parent (F1.6, F5.4)', async () => {
  const fixture = await createCompany('budget-wired', { tokensMax: 100_000 });
  const divisionAccount = await withTenant(fixture.companyId, (tx) =>
    budget.createAccount(tx, {
      companyId: fixture.companyId,
      label: 'ops',
      tokensMax: 1_000,
      scope: {
        scopeType: 'division',
        scopeId: fixture.divisionId,
        parentAccountId: fixture.budgetAccountId,
      },
    }),
  );

  // No budgetAccountId given: the account is looked up, not assumed.
  const root = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    goalId: fixture.goalId,
    input: { run: 'wired' },
    createdBy: 'owner',
    reserveTokens: 100,
  });
  assert.equal(root.budgetAccountId, divisionAccount, 'not the company account');

  // F5.4 is unchanged by that: a sub-task shares its parent's counter, which
  // is what stops a delegation tree from finding a fresh allowance by moving.
  const child = await createSubTask(root.id, {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    input: { run: 'delegated' },
    reserveTokens: 100,
  });
  assert.equal(child.budgetAccountId, root.budgetAccountId);

  // The containment property, which is the reason for all of it: the division
  // runs out while the company still has almost all of its allowance.
  await assert.rejects(
    () =>
      createRootTask({
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        divisionId: fixture.divisionId,
        roleId: fixture.roleId,
        goalId: fixture.goalId,
        input: { run: 'over the division ceiling' },
        createdBy: 'owner',
        reserveTokens: 900,
      }),
    (error: unknown) => isPalugadaError(error, 'budget.reservation_refused'),
  );

  const company = await withTenant(fixture.companyId, (tx) =>
    budget.snapshot(tx, fixture.budgetAccountId),
  );
  assert.equal(company.tokensReserved, 200, 'the company barely noticed');
  assert.ok(company.tokensMax - company.tokensReserved > 900, 'and had room for the refused task');
});

/* ------------------------------------------------------------------ F5.10 --- */

test('a P0 task is claimed before older P2 work (F5.10)', async () => {
  const fixture = await createCompany('priority');

  const routine = await newTask(fixture);
  const alsoRoutine = await newTask(fixture);
  const urgent = await newTask(fixture, { priority: 0 });

  assert.equal(routine.priority, 2, 'the default is P2, not P0');
  assert.equal(urgent.priority, 0);

  const first = await claimTask(fixture.companyId, { holder: 'w1' });
  assert.equal(first?.taskId, urgent.id);

  // Age is the tie-break rather than the whole order, so the P2 queue still
  // drains oldest-first behind it.
  const second = await claimTask(fixture.companyId, { holder: 'w2' });
  assert.equal(second?.taskId, routine.id);
  const third = await claimTask(fixture.companyId, { holder: 'w3' });
  assert.equal(third?.taskId, alsoRoutine.id);
});

/* ------------------------------------------------------------------ F6.7 --- */

test('a sub-agent hands back a bounded answer and summary, cut short and saying so where it is long (F6.7, N2)', () => {
  const contained = containChildResult('researcher', { finding: 'the zone is stale' }, {
    status: 'completed',
    steps: 3,
    costCents: 12,
    taskId: 'child-0',
  });
  assert.match(contained.summary, /^researcher completed in 3 steps, 12c\./);
  assert.match(contained.summary, /Returned finding\./);

  // An output over the ceiling is handed back cut short, and says so where it
  // was cut: refused, the work was lost to the parent and the owner never got
  // it (N2). A cut nobody can mistake for the whole is not half a document.
  const huge = { verdict: 'stale', transcript: 'x'.repeat(CHILD_OUTPUT_TOKEN_LIMIT * 4 + 10) };
  const cut = containChildResult('researcher', huge, { status: 'completed', steps: 1, costCents: 0, taskId: 'child-1' });
  assert.ok(estimateTokens(JSON.stringify(cut.output)) <= CHILD_OUTPUT_TOKEN_LIMIT, 'the ceiling still holds (F6.7)');
  assert.equal(cut.output.verdict, 'stale', 'a short field comes through whole');
  assert.match(String(cut.output.transcript), /^x+ … \[cut here: \d+ of 8010 characters\. The whole is kept on task child-1, where the owner reads it\.\]$/);
  assert.deepEqual(cut.abbreviated, { taskId: 'child-1', characters: JSON.stringify(huge).length });
  assert.match(cut.summary, /over the 2000 tokens a sub-agent may hand back \(F6\.7\), so it is cut short here; the whole is kept on task child-1/);
  assert.ok(estimateTokens(cut.summary) <= CHILD_SUMMARY_TOKEN_LIMIT);

  // So many small items that no string is long: the list is cut, and says so.
  const many = { rows: Array.from({ length: 3_000 }, (_, n) => `row ${n}`) };
  const fewer = containChildResult('researcher', many, { status: 'completed', steps: 1, costCents: 0, taskId: 'child-2' });
  assert.ok(estimateTokens(JSON.stringify(fewer.output)) <= CHILD_OUTPUT_TOKEN_LIMIT);
  const rows = fewer.output.rows as string[];
  assert.equal(rows[0], 'row 0');
  assert.match(rows.at(-1)!, /^\[cut here: \d+ of 3000 items\. The whole is kept on task child-2, where the owner reads it\.\]$/);
  assert.equal(containChildResult('researcher', { finding: 'x' }, { status: 'completed', steps: 1, costCents: 0, taskId: 'c' }).abbreviated, null,
    'nothing is marked cut that was not');
});

/* ------------------------------------------------------------------ F7.7 --- */

test('a reviewer answers on a different model from the proposer (F7.7)', async () => {
  const fixture = await createCompany('reviewer-model');
  const reviewerRoleId = await addRole(fixture, 'qa-reviewer');

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET model_primary = 'model-a' WHERE id = $1", [fixture.roleId]);
    await tx.query(
      `UPDATE roles SET model_primary = 'model-a', model_fallback = ARRAY['model-b']
        WHERE id = $1`,
      [reviewerRoleId],
    );
  });

  const chosen = await chooseReviewerModel(fixture.companyId, fixture.roleId, reviewerRoleId);
  assert.equal(chosen.model, 'model-b');
  assert.equal(chosen.sameAsProposer, false);
});

/**
 * With one model configured, the review still happens -- and says so.
 *
 * Refusing to review at all would be worse: a same-model reviewer catches a
 * great deal that no reviewer catches nothing of. What must not happen is for
 * the weakening to be invisible.
 */
test('a deployment with one model reviews anyway, and records that it did (F7.7)', async () => {
  const fixture = await createCompany('reviewer-one-model');
  const reviewerRoleId = await addRole(fixture, 'qa-reviewer');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query("UPDATE roles SET model_primary = 'only-model' WHERE id = ANY($1::uuid[])", [
      [fixture.roleId, reviewerRoleId],
    ]);
  });

  const chosen = await chooseReviewerModel(fixture.companyId, fixture.roleId, reviewerRoleId);
  assert.equal(chosen.model, 'only-model');
  assert.equal(chosen.sameAsProposer, true);

  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      "SELECT type FROM events WHERE type = 'review.same_model'",
    );
    return rows;
  });
  assert.equal(events.length, 1);
});

/* ------------------------------------------------------------------ F4.8 --- */

test('the context pack is capped, and says what it left out (F4.8)', async () => {
  const fixture = await createCompany('context-cap');
  await publishCharter({ companyId: fixture.companyId, body: 'Be careful.' });
  // The notice tells the run to search back what was dropped, and the pack
  // only writes that instruction for a division that may follow it. Granted
  // here rather than assumed, which is the arrangement F4.8 actually describes;
  // the catalogue comes first because a grant names a capability that exists.
  await registerStandardCatalogue();
  await grantCapability(fixture, 'memory.search');

  for (let index = 0; index < 12; index += 1) {
    await withTenant(fixture.companyId, (tx) =>
      remember(tx, {
        companyId: fixture.companyId,
        memoryType: 'semantic',
        scopeType: 'division',
        scopeId: fixture.divisionId,
        body: `fact ${index}: ${'detail '.repeat(60)}`,
        source: 'test',
      }),
    );
  }

  const uncapped = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.equal(uncapped.dropped, 0, 'the default 40k limit is not reached by twelve facts');

  const capped = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, {
      companyId: fixture.companyId,
      divisionId: fixture.divisionId,
      tokenLimit: 400,
    }),
  );
  assert.ok(capped.dropped > 0);
  assert.ok(estimateContextTokens(capped.sections) <= 400 + 200, 'the notice itself is small');

  // The charter is never what gets dropped: a run that lost it to make room for
  // a fact is a run operating outside its own rules.
  assert.ok(capped.sections.some((section) => section.kind === 'company_charter'));
  assert.match(capped.text, /memory\.search/);
  assert.match(capped.text, /did not fit/);
});

test('the default cap is section 9\'s figure', () => {
  assert.equal(CONTEXT_PACK_TOKEN_LIMIT, 40_000);
});

/**
 * The door back is a real door.
 *
 * The context pack tells a run to use `memory.search` for whatever did not
 * fit. That instruction is only honest if the capability is bound to
 * something — a catalogued name with no implementation would answer
 * `capability.unknown`, and the platform would have lied to the run it was
 * instructing. This test exists because for a while that was exactly the case:
 * the declaration was in the catalogue and nothing implemented it.
 */
test('memory.search answers through the broker, scoped like the pack (F4.8)', async () => {
  const fixture = await createCompany('memory-search');
  const registry = await registerStandardCatalogue();
  await grantCapability(fixture, 'memory.search');
  const broker = new CapabilityBroker(registry);

  await withTenant(fixture.companyId, (tx) =>
    remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: 'The registrar bills in euros, not dollars.',
      source: 'test',
    }),
  );
  await withTenant(fixture.companyId, (tx) =>
    remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: 'Unrelated fact about coffee.',
      source: 'test',
      confidence: 0.4,
    }),
  );

  const task = await newTask(fixture);
  const found = await broker.invoke<{ query: string }, {
    facts: Array<{ body: string; unverified: boolean }>;
    truncated: boolean;
  }>(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      taskId: task.id,
      roleId: fixture.roleId,
      idempotencyKey: `search-${task.id}`,
    },
    'memory.search',
    { query: 'registrar' },
  );

  assert.equal(found.output.facts.length, 1);
  assert.match(found.output.facts[0]!.body, /bills in euros/);
  assert.equal(found.tier, 0, 'a read of the company\'s own store is tier 0');

  // A fact fetched through the tool must not arrive more certain than the same
  // fact would have been in the pack (F4.5).
  const unsure = await broker.invoke<{ query: string }, {
    facts: Array<{ body: string; unverified: boolean }>;
  }>(
    {
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      divisionId: fixture.divisionId,
      taskId: task.id,
      roleId: fixture.roleId,
      idempotencyKey: `search-coffee-${task.id}`,
    },
    'memory.search',
    { query: 'coffee' },
  );
  assert.equal(unsure.output.facts[0]!.unverified, true);
});

/* ------------------------------------------------------------------ F10.3 --- */

/**
 * L7: a run asked the owner "which CRM vendor should I bind?" -- a question
 * the owner cannot answer from the inbox, about a tool nothing in this
 * deployment was bound to. The owner connects a service on This deployment,
 * Services, and an answer typed into an item connects nothing. Such a
 * question is answered by the platform, at once, and the owner is asked only
 * what they can answer.
 */
test('a question about connecting a tool nobody bound is answered by the platform, not put to the owner (L7)', async () => {
  const fixture = await createCompany('owner-ask-config');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  await withTenant(fixture.companyId, (tx) =>
    tx.query("UPDATE roles SET tools = ARRAY['owner.ask', 'crm.note', 'memory.search'] WHERE id = $1", [fixture.roleId]));
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  const ask = registry.get('owner.ask')! as unknown as {
    execute(input: unknown, ctx: unknown): Promise<{ answered: boolean; answer?: string }>;
  };
  const ctx = {
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id,
    idempotencyKey: 'ask-1', signal: new AbortController().signal, credential: async () => '',
  };

  const answered = await ask.execute({ question: 'Which CRM vendor should I bind so I can add the note?' }, ctx);
  assert.equal(answered.answered, true);
  assert.match(answered.answer ?? '', /crm\.note is not connected[\s\S]*This deployment, Services[\s\S]*say in your output what is left/);
  assert.deepEqual((await inbox.listOpen(fixture.companyId)).map((item) => item.kind), [], 'nothing was put to the owner');
  const events = await withTenant(fixture.companyId, (tx) => tx.query<{ type: string }>(
    "SELECT type FROM events WHERE task_id = $1 AND type = 'task.question_answered_by_platform'", [task.id]));
  assert.equal(events.rows.length, 1, 'and it is on the record');

  // A question about the work itself still goes to the owner, even one that
  // names the tool.
  await assert.rejects(ask.execute({ question: 'Which customers should the CRM note be about?' }, ctx),
    (error: unknown) => isPalugadaError(error) && error.code === 'owner.asked');
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);
});

test('the owner can ask a question inside the same task (F10.3)', async () => {
  const fixture = await createCompany('owner-ask');
  const task = await newTask(fixture);
  // The broker reaches an approval from inside a run, so the task is running.
  await transition(fixture.companyId, task.id, 'running');

  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'dns.update',
    tier: 3,
    actionSummary: 'Point the apex at the new host',
    rationale: 'The migration is finished.',
    consequenceIfDenied: 'The site keeps resolving to the old host.',
  });

  // The same request again is the same item: the broker reaches this point
  // every time the task runs, and two items would let the owner answer the
  // same question twice, differently.
  const again = await inbox.requestApproval({
    companyId: fixture.companyId,
    taskId: task.id,
    capabilityName: 'dns.update',
    tier: 3,
    actionSummary: 'Point the apex at the new host',
    rationale: 'The migration is finished.',
    consequenceIfDenied: 'The site keeps resolving to the old host.',
  });
  assert.equal(again, itemId);

  await inbox.decide(fixture.companyId, itemId, 'ask', 'Which host, and what is the TTL?');

  // The item stays open -- asking is not deciding -- and the task goes back to
  // work rather than a second task being created to answer.
  const open = await inbox.listOpen(fixture.companyId);
  assert.ok(open.some((entry) => entry.id === itemId));
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'running');

  // And the run that picks it up reads the question.
  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, {
      companyId: fixture.companyId,
      divisionId: fixture.divisionId,
      taskId: task.id,
    }),
  );
  assert.match(context.text, /Which host, and what is the TTL\?/);

  await inbox.answerEscalation(fixture.companyId, itemId, 'host-b, TTL 300.');
  const answered = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { answers?: unknown[] } }>(
      'SELECT payload FROM inbox_items WHERE id = $1',
      [itemId],
    );
    return rows[0]!.payload;
  });
  assert.equal(answered.answers?.length, 1);
});

/**
 * The owner's answer to an escalation reached nobody (the competitive
 * analysis of 2026-09-28, L18). The console says "Sends your answer and puts
 * the task back on the queue, without deciding the item"; the route wrote
 * the words into the item under the owner's own earlier note, recorded them
 * as an agent's, and left the task where it was. The answer is now the
 * owner's word to the task -- read by its next run like any instruction --
 * and a task waiting on the owner goes back to work.
 */
test('the owner answers an escalation without deciding it, and the task carries on with the answer (F10.3)', async () => {
  const fixture = await createCompany('owner-answers');
  const task = await newTask(fixture);
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'waiting_review');
  const itemId = await inbox.raiseEscalation({
    companyId: fixture.companyId,
    taskId: task.id,
    title: 'Review deadlocked after 2 revisions: email.send',
    detail: 'Proposer and reviewer did not converge.',
  });

  await inbox.answerEscalation(fixture.companyId, itemId, 'Keep the price, drop the discount.');

  const open = await inbox.listOpen(fixture.companyId);
  assert.ok(open.some((entry) => entry.id === itemId), 'answering is not deciding: the item stays open');
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'running', 'the task is back at work');

  const context = await withTenant(fixture.companyId, (tx) => buildContext(tx, {
    companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id,
  }));
  const said = context.sections.find((section) => section.kind === 'owner_note');
  assert.ok(said, 'the next run is told');
  assert.match(said.body, /Keep the price, drop the discount\./);

  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { inboxItemId: string } }>(
    "SELECT actor, payload FROM events WHERE type = 'owner.answered'"));
  assert.deepEqual(rows.map((row) => [row.actor, row.payload.inboxItemId]), [['owner', itemId]], 'the owner\'s words, as the owner\'s');

  // A task that is not waiting is told and left running; one that has ended
  // cannot be answered, and an item already closed says why.
  await inbox.answerEscalation(fixture.companyId, itemId, 'And lead with Monday.');
  assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'running');
  await inbox.decide(fixture.companyId, itemId, 'deny');
  await assert.rejects(inbox.answerEscalation(fixture.companyId, itemId, 'Too late.'), /is closed: it was already decided/);
  await assert.rejects(inbox.answerEscalation(fixture.companyId, itemId, '   '), /an answer cannot be empty/);
});

/* ------------------------------------------------------------- F2.1, F2.9 --- */

test('a division has an escalation policy, and a default when it has not set one (F2.1)', async () => {
  const fixture = await createCompany('escalation');

  const initial = await withTenant(fixture.companyId, (tx) =>
    escalationPolicyFor(tx, fixture.divisionId),
  );
  assert.deepEqual(initial, { roleSlug: null, afterMinutes: DEFAULT_ESCALATION_MINUTES });

  await setEscalationPolicy(fixture.companyId, fixture.divisionId, {
    roleSlug: 'ops-lead',
    afterMinutes: 30,
  });
  const set = await withTenant(fixture.companyId, (tx) =>
    escalationPolicyFor(tx, fixture.divisionId),
  );
  assert.deepEqual(set, { roleSlug: 'ops-lead', afterMinutes: 30 });
});

/**
 * F2.9: a grant is not something an agent can widen.
 *
 * A policy denies an action; a grant decides whether the action was ever
 * reachable. An agent that could change one could route around every policy by
 * making it irrelevant.
 */
test('changing a grant needs the owner and is tier 3 (F2.9)', async () => {
  const fixture = await createCompany('structure');

  const change = {
    kind: 'change_grant' as const,
    divisionId: fixture.divisionId,
    capabilityName: 'dns.read',
    tierOverride: 0,
  };

  await assert.rejects(
    () => applyGrantChange(fixture.companyId, change, { ownerApproved: false }),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );

  const itemId = await proposeStructuralChange({
    companyId: fixture.companyId,
    change,
    rationale: 'The division needs to read the zone before it can plan a migration.',
  });
  const open = await inbox.listOpen(fixture.companyId);
  const item = open.find((entry) => entry.id === itemId)!;
  assert.equal(item.tier, 3);
  assert.match(item.rationale, /What this would change/);
});

/* ------------------------------------------------------------------ F3.9 --- */

test('any config version can be restored, and the restore is itself a version (F3.9)', async () => {
  const fixture = await createCompany('config-rollback');

  await withTenant(fixture.companyId, (tx) =>
    recordVersion(tx, {
      companyId: fixture.companyId,
      kind: 'role',
      subjectId: fixture.roleId,
      snapshot: { model: 'model-a' },
      summary: 'Initial',
    }),
  );
  await withTenant(fixture.companyId, (tx) =>
    recordVersion(tx, {
      companyId: fixture.companyId,
      kind: 'role',
      subjectId: fixture.roleId,
      snapshot: { model: 'model-b' },
      summary: 'Try model-b',
    }),
  );

  const restored = await restore(fixture.companyId, 'role', fixture.roleId, 1);
  assert.deepEqual(restored.snapshot, { model: 'model-a' });
  assert.equal(restored.newVersion, 3, 'history moves forward; it is never rewound');

  const all = await history(fixture.companyId, 'role', fixture.roleId);
  assert.deepEqual(all.map((entry) => entry.version), [3, 2, 1]);
  assert.match(all[0]!.summary, /Restored version 1/);

  await assert.rejects(
    () => restore(fixture.companyId, 'role', fixture.roleId, 99),
    (error: unknown) => isPalugadaError(error, 'config.unknown_version'),
  );
});

/**
 * F3.9 covers the things the requirement names, not just the one that was
 * convenient.
 *
 * "Semua config (charter, policy, role, grant, bundle) berversi" — a rollback
 * surface that only knew about grants would be a rollback surface for grants,
 * and this test exists because for a while that is exactly what it was.
 */
test('a charter, a policy and a role each produce a config version (F3.9)', async () => {
  const fixture = await createCompany('config-coverage');

  await publishCharter({ companyId: fixture.companyId, body: 'Be careful.' });
  await publishCharter({ companyId: fixture.companyId, body: 'Be careful, and be quick.' });

  const charterHistory = await history(fixture.companyId, 'charter', null);
  assert.deepEqual(charterHistory.map((entry) => entry.version), [2, 1]);
  assert.deepEqual(charterHistory[0]!.snapshot, { body: 'Be careful, and be quick.' });

  const policyId = await putPolicy({
    companyId: fixture.companyId,
    slug: 'no-weekend-sends',
    effect: 'deny',
    condition: { field: 'tool', op: 'eq', value: 'email.send' },
  });
  const policyHistory = await history(fixture.companyId, 'policy', policyId);
  assert.equal(policyHistory.length, 1);
  assert.equal(policyHistory[0]!.snapshot.slug, 'no-weekend-sends');

  // A role change versions the state it is leaving, because a rollback needs
  // somewhere to go back *to* — versioning the new state would mean the first
  // restorable version is the one that broke something.
  await applyRoleChange(
    fixture.companyId,
    fixture.roleId,
    { modelPrimary: 'model-b' },
    { ownerApproved: true },
  );
  const roleHistory = await history(fixture.companyId, 'role', fixture.roleId);
  assert.equal(roleHistory.length, 1);
  assert.equal(roleHistory[0]!.snapshot.modelPrimary, 'test-model');

  const restored = await restore(fixture.companyId, 'role', fixture.roleId, 1);
  assert.equal(restored.snapshot.modelPrimary, 'test-model');
});

test('a role change without the owner is refused (F2.9, F17.3)', async () => {
  const fixture = await createCompany('role-change-refused');
  await assert.rejects(
    () =>
      applyRoleChange(
        fixture.companyId,
        fixture.roleId,
        { systemPrompt: 'do whatever' },
        { ownerApproved: false },
      ),
    (error: unknown) => isPalugadaError(error, 'approval.required'),
  );
});

/** F3.9 reaches the platform charter too, which outranks every company. */
test('the platform charter is versioned and restorable (F3.9, F3.1)', async () => {
  await publishCharter({ body: 'Do no harm.' });
  await publishCharter({ body: 'Do no harm, and say what you did.' });

  const platform = await history(null, 'charter', null);
  assert.ok(platform.length >= 2);
  assert.equal(platform[0]!.snapshot.body, 'Do no harm, and say what you did.');

  const restored = await restore(null, 'charter', null, platform[platform.length - 1]!.version);
  assert.equal(restored.snapshot.body, 'Do no harm.');
});

/* ------------------------------------------------------------------ F2.1 --- */

/**
 * A division's escalation policy has to *do* something.
 *
 * It decides who was asked first and how long they had, and the owner is told
 * both. A policy that was stored and never read would be a settings page.
 */
test('a division\'s escalation policy shapes the escalation it raises (F2.1)', async () => {
  const fixture = await createCompany('escalation-applied');
  await setEscalationPolicy(fixture.companyId, fixture.divisionId, {
    roleSlug: 'ops-lead',
    afterMinutes: 45,
  });

  const itemId = await inbox.raiseEscalation({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    title: 'The registrar will not answer',
    detail: 'Three attempts, all timed out.',
  });

  const item = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      rationale: string; notify_after: Date; payload: Record<string, unknown>;
    }>('SELECT rationale, notify_after, payload FROM inbox_items WHERE id = $1', [itemId]);
    return rows[0]!;
  });

  assert.match(item.rationale, /ops-lead was asked first and has had 45 minutes/);
  assert.equal(item.payload.escalationRole, 'ops-lead');
  assert.ok(
    item.notify_after.getTime() > Date.now() + 40 * 60_000,
    "the division's grace period delays telling the owner",
  );

  // Without a division there is nothing to wait for beyond the owner's own
  // window. Compared against the other item rather than against a clock: the
  // owner window is configuration, so an absolute assertion would be testing
  // the fixture's timezone rather than the policy.
  const direct = await inbox.raiseEscalation({
    companyId: fixture.companyId,
    title: 'No division owns this',
    detail: 'Straight to you.',
  });
  const immediate = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ notify_after: Date }>(
      'SELECT notify_after FROM inbox_items WHERE id = $1',
      [direct],
    );
    return rows[0]!.notify_after;
  });
  assert.ok(
    immediate.getTime() <= item.notify_after.getTime(),
    "a division's grace period can delay the owner and never brings them forward",
  );
});

/**
 * A grace period is only a grace period if somebody has it.
 *
 * `escalationPolicyFor` defaults `afterMinutes` to four hours and `roleSlug` to
 * nothing, so a division that never set a policy reads back as "four hours" for
 * nobody. Holding the owner's notification on that would mean four hours in
 * which no role has been asked, nobody is working on the problem, and the item
 * just sits -- the delay bought silence, not handling. Without a named role the
 * escalation has no home inside the division, which is exactly the case F2.1
 * sends straight to the owner.
 */
test('a division that names no escalation role does not delay the owner (F2.1)', async () => {
  const fixture = await createCompany('escalation-unowned');

  // Deliberately not calling setEscalationPolicy: this is the state every
  // division is created in.
  const unowned = await inbox.raiseEscalation({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    title: 'Nobody was named for this',
    detail: 'The division has no escalation role.',
  });
  const direct = await inbox.raiseEscalation({
    companyId: fixture.companyId,
    title: 'No division at all',
    detail: 'Straight to you.',
  });

  const rows = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; notify_after: Date; rationale: string; payload: Record<string, unknown>;
    }>(
      'SELECT id, notify_after, rationale, payload FROM inbox_items WHERE id = ANY($1)',
      [[unowned, direct]],
    );
    return new Map(rows.map((row) => [row.id, row]));
  });

  // The same moment as an escalation with no division at all: the owner's own
  // window and nothing added to it.
  //
  // Compared as a difference rather than for equality. When the owner's window
  // is open, `notifyAfterFor` returns `now` -- so the two items get the two
  // different milliseconds at which they were raised, and an equality
  // assertion passes or fails by the hour of the day the suite runs. It passed
  // here for a week and failed on a 14:32 CI run, which is the window being
  // open rather than anything about the code. The property is that the
  // division adds *nothing*, and the bug it guards against added four hours.
  const gap = Math.abs(
    rows.get(unowned)!.notify_after.getTime() - rows.get(direct)!.notify_after.getTime(),
  );
  assert.ok(gap < 1_000, `the division added ${gap}ms to the owner's notification`);
  // And it does not claim somebody was asked first.
  assert.doesNotMatch(rows.get(unowned)!.rationale, /was asked first/);
  assert.equal(rows.get(unowned)!.payload.escalationRole, null);
  assert.equal(rows.get(unowned)!.payload.afterMinutes, undefined);
  // The division is still recorded -- whose problem it was is worth keeping
  // even when it named nobody to handle it.
  assert.equal(rows.get(unowned)!.payload.divisionId, fixture.divisionId);
});

/* ----------------------------------------------------------------- F3.11 --- */

test('charters live as files, and the files are the source (F3.11)', async () => {
  const fixture = await createCompany('charter-files');
  const root = await mkdtemp(join(tmpdir(), 'palugada-charters-'));

  await writeFile(join(root, 'PLATFORM.md'), '# Platform\n\nDo no harm.\n', 'utf8');
  await mkdir(join(root, 'companies', fixture.slug), { recursive: true });
  await writeFile(
    join(root, 'companies', fixture.slug, 'SOUL.md'),
    '# Acme\n\nAnswer within a day.\n',
    'utf8',
  );

  const imported = await importFromDisk({ root });
  assert.ok(imported.some((entry) => entry.scope === 'platform' && entry.version === 1));
  assert.ok(imported.some((entry) => entry.scope === fixture.slug && entry.version === 1));

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }),
  );
  assert.match(context.text, /Answer within a day/);

  // Idempotent by content: importing again publishes nothing, so "which
  // charter was this run subject to" does not become a question about deploys.
  const second = await importFromDisk({ root });
  assert.deepEqual(second, imported);

  const written = await exportToDisk({ root: await mkdtemp(join(tmpdir(), 'palugada-out-')) });
  const soul = written.find((path) => path.endsWith('SOUL.md'))!;
  assert.match(await readFile(soul, 'utf8'), /Answer within a day/);
});

/**
 * F3.11 as a deployment keeps it: one repository of charters beside its
 * state. A charter published anywhere is written to its file and committed;
 * a file edited in the repository is taken in as the next version; and a
 * file only PALUGADA wrote never overrides the database it came from, which
 * is what keeps a tree left from an earlier database from rewriting today's
 * charter.
 */
test('the deployment keeps its charters in a git repository, both ways (F3.11)', async () => {
  const fixture = await createCompany('charter-repo');
  const root = join(await mkdtemp(join(tmpdir(), 'palugada-tree-')), 'charters');
  const repository = new CharterRepository({ root });
  const soul = join(root, 'companies', fixture.slug, 'SOUL.md');
  const log = async () => (await exec('git', ['-C', root, 'log', '--format=%an|%s'])).stdout.trim().split('\n');
  const latest = async () => withControlPlane(async (tx) => (await tx.query<{ version: number; body: string }>(
    'SELECT version, body FROM charters WHERE company_id = $1 ORDER BY version DESC LIMIT 1', [fixture.companyId])).rows[0]);

  // Published in the console: written, and committed as PALUGADA.
  await publishCharter({ companyId: fixture.companyId, body: '# Acme\n\nAnswer within a day.' });
  const first = await repository.sync();
  assert.deepEqual(first.written, [join('companies', fixture.slug, 'SOUL.md')]);
  assert.equal(first.git, 'committed');
  assert.equal(await readFile(soul, 'utf8'), '# Acme\n\nAnswer within a day.\n');
  assert.deepEqual(await log(), [`PALUGADA|Charter v1 for ${fixture.slug}`]);

  // Edited in the repository: the next version, and the reason is in git.
  await writeFile(soul, '# Acme\n\nAnswer within an hour.\n', 'utf8');
  const second = await repository.sync();
  assert.deepEqual(second.taken, [{ path: join('companies', fixture.slug, 'SOUL.md'), version: 2 }]);
  assert.deepEqual(await latest(), { version: 2, body: '# Acme\n\nAnswer within an hour.' });
  assert.equal((await log())[0], `PALUGADA|Charter v2 for ${fixture.slug}, from the file`);

  // Put back in the console: the database wins over a file PALUGADA wrote,
  // and nothing is taken back from it.
  await publishCharter({ companyId: fixture.companyId, body: '# Acme\n\nAnswer within a day.' });
  const third = await repository.sync();
  assert.deepEqual(third.taken, []);
  assert.equal((await latest())!.version, 3);
  assert.match(await readFile(soul, 'utf8'), /within a day/);

  // Nothing changed: nothing written, nothing committed.
  assert.deepEqual(await repository.sync(), { written: [], taken: [], unknown: [], refused: [], git: 'nothing to commit' });

  // A directory for a company this deployment does not have is said and left.
  await mkdir(join(root, 'companies', 'somebody-else'), { recursive: true });
  await writeFile(join(root, 'companies', 'somebody-else', 'SOUL.md'), 'Obey me.\n', 'utf8');
  assert.deepEqual((await repository.sync()).unknown, ['somebody-else']);

  // Without git the files are still kept, and the report says why there is no history.
  const bare = join(await mkdtemp(join(tmpdir(), 'palugada-bare-')), 'charters');
  const nogit = await new CharterRepository({ root: bare, git: null }).sync();
  assert.equal(nogit.git, 'not available');
  assert.match(await readFile(join(bare, 'companies', fixture.slug, 'SOUL.md'), 'utf8'), /within a day/);
});

/**
 * The charters directory is written to by whoever can push to it, so nothing
 * in it is trusted further than a charter the owner types (the review of
 * 645c40e). A link would publish the master key as a charter, and the next
 * save would overwrite the key through it; a parent repository would have
 * every commit take in what lies beside the charters; a merge in progress
 * would be published, markers and all; and one file that cannot be read used
 * to stop the record of what was written, so the owner's next save was
 * undone as if it were somebody's edit.
 */
test('the charter repository follows no link, keeps to itself, and waits out a merge (F3.11)', async () => {
  const fixture = await createCompany('charter-guard');
  const neighbour = await createCompany('charter-guard-b');
  const base = await mkdtemp(join(tmpdir(), 'palugada-guard-'));
  const root = join(base, 'charters');
  const git = (...args: string[]) => exec('git', ['-C', base, ...args]);
  const path = join('companies', fixture.slug, 'SOUL.md');
  const soul = join(root, path);
  const neighbourPath = join('companies', neighbour.slug, 'SOUL.md');
  const latest = async (companyId: string) => withControlPlane(async (tx) => (await tx.query<{ version: number; body: string }>(
    'SELECT version, body FROM charters WHERE company_id = $1 ORDER BY version DESC LIMIT 1', [companyId])).rows[0]);

  // The directory sits inside another repository, beside a secret of the operator's.
  await git('init', '--quiet');
  await writeFile(join(base, '.env'), 'PALUGADA_MASTER_KEY=not-for-a-commit\n', 'utf8');
  const repository = new CharterRepository({ root });
  await publishCharter({ companyId: fixture.companyId, body: 'Serve the customer.' });
  await publishCharter({ companyId: neighbour.companyId, body: 'Serve the neighbour.' });
  assert.equal((await repository.sync()).git, 'committed');
  assert.equal(await realpath((await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'])).stdout.trim()), await realpath(root),
    'the charters are a repository of their own');
  assert.deepEqual((await exec('git', ['-C', root, 'ls-files'])).stdout.trim().split('\n').sort(),
    ['.gitignore', neighbourPath, path].sort(), 'and a commit holds charters, nothing beside them');
  await assert.rejects(git('log'), 'the repository around it is not committed to');

  // A link is not read: the key it points at is not a charter.
  const key = join(base, 'master.key');
  await writeFile(key, 'the key itself\n', 'utf8');
  await rm(soul);
  await symlink(key, soul);
  const linked = await repository.sync();
  assert.deepEqual(linked.refused.map((one) => one.path), [path]);
  assert.match(linked.refused[0]!.reason, /a link is never followed/);
  assert.equal((await latest(fixture.companyId))!.body, 'Serve the customer.');
  // Nor written through: the owner's next save leaves the key as it was.
  await publishCharter({ companyId: fixture.companyId, body: 'Serve the customer well.' });
  await repository.sync();
  assert.equal(await readFile(key, 'utf8'), 'the key itself\n');
  // A company directory that is a link out of the repository is refused the same way.
  await rm(join(root, 'companies', fixture.slug), { recursive: true });
  await mkdir(join(base, 'elsewhere'));
  await symlink(join(base, 'elsewhere'), join(root, 'companies', fixture.slug));
  const outward = await repository.sync();
  assert.match(outward.refused.find((one) => one.path === path)!.reason, /link out of the repository/);
  assert.deepEqual(await readdir(join(base, 'elsewhere')), [], 'nothing was written through it');
  await rm(join(root, 'companies', fixture.slug));

  // One file that is not a charter is refused on its own. The rest are kept,
  // and the owner's saves stay saved: none is undone as if it were an edit.
  await writeFile(join(root, neighbourPath), 'A charter with a \u0000 in it.\n', 'utf8');
  for (const body of ['Serve the customer, saved again.', 'Serve the customer, saved last.']) {
    await publishCharter({ companyId: fixture.companyId, body });
    const synced = await repository.sync();
    assert.deepEqual(synced.refused.map((one) => one.path), [neighbourPath]);
    assert.match(synced.refused[0]!.reason, /NUL/);
    assert.equal(await readFile(soul, 'utf8'), `${body}\n`);
    assert.equal((await latest(fixture.companyId))!.body, body);
  }
  await writeFile(join(root, neighbourPath), 'x'.repeat(20_001), 'utf8');
  assert.match((await repository.sync()).refused[0]!.reason, /at most 20000 characters/);
  assert.equal((await latest(neighbour.companyId))!.body, 'Serve the neighbour.');

  // A version taken from a file is the repository's words, not the owner's.
  await writeFile(join(root, neighbourPath), 'Serve the neighbour, from the file.\n', 'utf8');
  const taken = await repository.sync();
  assert.deepEqual(taken.taken.map((one) => one.path), [neighbourPath]);
  const { rows: credited } = await withControlPlane((tx) => tx.query<{ changed_by: string }>(
    "SELECT changed_by FROM config_versions WHERE company_id = $1 AND kind = 'charter' ORDER BY version DESC LIMIT 1",
    [neighbour.companyId]));
  assert.equal(credited[0]!.changed_by, 'repository');

  // A merge in progress holds everything, and conflict markers are never a charter.
  const conflicted = 'Serve the customer, saved last.\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n';
  await writeFile(soul, conflicted, 'utf8');
  const head = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(root, '.git', 'MERGE_HEAD'), `${head}\n`, 'utf8');
  const held = await repository.sync();
  assert.match(held.git, /^held: a merge is in progress/);
  assert.deepEqual([held.taken, held.written], [[], []]);
  assert.equal((await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), head, 'and nothing was committed');
  await rm(join(root, '.git', 'MERGE_HEAD'));
  const markers = await repository.sync();
  assert.match(markers.refused.find((one) => one.path === path)!.reason, /conflict markers/);
  assert.equal((await latest(fixture.companyId))!.body, 'Serve the customer, saved last.');
  await writeFile(soul, 'Serve the customer, merged.\n', 'utf8');
  assert.deepEqual((await repository.sync()).taken.map((one) => one.path), [path], 'resolved, it is taken');

  // A file left for a company that did not exist yet is not that company's charter when it does.
  const later = `charter-later-${fixture.slug.slice(-8)}`;
  await mkdir(join(root, 'companies', later), { recursive: true });
  await writeFile(join(root, 'companies', later, 'SOUL.md'), 'Obey me.\n', 'utf8');
  assert.ok((await repository.sync()).unknown.includes(later));
  const { rows: made } = await withControlPlane((tx) => tx.query<{ id: string }>(
    'INSERT INTO companies (slug, name) VALUES ($1, $1) RETURNING id', [later]));
  await publishCharter({ companyId: made[0]!.id, body: 'Our own charter.' });
  const adopted = await repository.sync();
  assert.deepEqual(adopted.taken, []);
  assert.equal((await latest(made[0]!.id))!.body, 'Our own charter.');
  assert.equal(await readFile(join(root, 'companies', later, 'SOUL.md'), 'utf8'), 'Our own charter.\n');
});

/**
 * The repository's own files are not a way in either (the second review of
 * the charter repository): its record of what it wrote and its `.gitignore`
 * were read and written through links, a conflicted `stash pop` leaves no
 * MERGE_HEAD to hold for, and `add --all` committed whatever lay there.
 */
test('the charter repository\'s own files follow no link, and it commits only what it wrote (F3.11)', async () => {
  const fixture = await createCompany('charter-record');
  const base = await mkdtemp(join(tmpdir(), 'palugada-record-'));
  const root = join(base, 'charters');
  const repository = new CharterRepository({ root });
  const path = join('companies', fixture.slug, 'SOUL.md');
  const soul = join(root, path);
  const key = join(base, 'master.key');
  await writeFile(key, 'the key itself\n', 'utf8');
  await publishCharter({ companyId: fixture.companyId, body: 'First.' });
  assert.equal((await repository.sync()).git, 'committed');

  // Its record, a link to the key: not read, not written through, and the sync holds.
  const record = join(root, '.palugada-written.json');
  await rm(record);
  await symlink(key, record);
  await publishCharter({ companyId: fixture.companyId, body: 'Second.' });
  assert.match((await repository.sync()).git, /^held: \.palugada-written\.json is not a file/);
  assert.equal(await readFile(key, 'utf8'), 'the key itself\n');
  // Removed, it is made again, and with no record of what PALUGADA wrote the
  // files are the source, as F3.11 has them: the file's words are taken.
  await rm(record);
  assert.deepEqual((await repository.sync()).taken.map((one) => one.path), [path]);
  assert.equal(await readFile(record, 'utf8').then((text) => typeof JSON.parse(text)), 'object');

  // Its .gitignore, a link to the key: git is not used, the key is untouched, the charters are kept.
  await rm(join(root, '.gitignore'));
  await symlink(key, join(root, '.gitignore'));
  await publishCharter({ companyId: fixture.companyId, body: 'Third.' });
  const ignored = await repository.sync();
  assert.match(ignored.git, /^failed: \.gitignore is not a file/);
  assert.equal(await readFile(key, 'utf8'), 'the key itself\n');
  assert.equal(await readFile(soul, 'utf8'), 'Third.\n');
  await rm(join(root, '.gitignore'));
  await exec('git', ['-C', root, 'checkout', '--', '.gitignore']);
  assert.equal((await repository.sync()).git, 'committed');

  // A refused file is left out of the commit: it is not PALUGADA's to record.
  await writeFile(soul, 'Fourth, with a \u0000.\n', 'utf8');
  await writeFile(join(root, 'notes.txt'), 'the operator\'s own file\n', 'utf8');
  await publishCharter({ companyId: fixture.companyId, body: 'Fifth.' });
  await repository.sync();
  const loose = (await exec('git', ['-C', root, 'status', '--porcelain'])).stdout;
  assert.match(loose, /SOUL\.md/, 'the refused file is not committed');
  assert.match(loose, /notes\.txt/, 'nor is the operator\'s');
  await writeFile(soul, 'Fifth.\n', 'utf8');

  // Conflicts in the index with no merge to show for them -- a stash pop -- hold the sync.
  const blob = (await exec('git', ['-C', root, 'hash-object', '-w', soul])).stdout.trim();
  await exec('git', ['-C', root, 'update-index', '--force-remove', path]);
  const unmerged = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\t${path}`).join('\n');
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', ['-C', root, 'update-index', '--index-info'], (error) => (error ? reject(error) : resolve()));
    child.stdin!.end(`${unmerged}\n`);
  });
  assert.match((await repository.sync()).git, /^held: a merge with unresolved conflicts is in the index/);
  await exec('git', ['-C', root, 'add', path]);

  // A file where the companies directory should be refuses the companies, not the sync.
  await rm(join(root, 'companies'), { recursive: true });
  await writeFile(join(root, 'companies'), 'not a directory\n', 'utf8');
  const flat = await repository.sync();
  assert.deepEqual(flat.refused.map((one) => one.path), [path], JSON.stringify(flat));
});

/* ------------------------------------------------------- F12.7 – F12.10 --- */

/** Ed25519 signs the message itself and refuses to be handed a digest name. */
function signedNonce(privateKey: string, nonce: string): string {
  return sign(null, Buffer.from(nonce), privateKey).toString('base64');
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

test('a new device can do nothing until the owner pairs it (F12.7)', async () => {
  const fixture = await createCompany('gateway-pairing');
  const { publicKey, privateKey } = keypair();

  const device = await registerDevice({
    companyId: fixture.companyId,
    name: 'laptop',
    runtime: 'claude-code',
    publicKeyPem: publicKey,
  });
  assert.equal(device.status, 'pending');

  const nonce = await issueChallenge(fixture.companyId, device.id);
  await assert.rejects(
    () =>
      connect({
        companyId: fixture.companyId,
        deviceId: device.id,
        nonce,
        signatureBase64: signedNonce(privateKey, nonce),
      }),
    (error: unknown) => isPalugadaError(error, 'gateway.unpaired'),
  );

  await pairDevice(fixture.companyId, device.id, { keyFingerprint: device.keyFingerprint });
  const second = await issueChallenge(fixture.companyId, device.id);
  const connection = await connect({
    companyId: fixture.companyId,
    deviceId: device.id,
    nonce: second,
    signatureBase64: signedNonce(privateKey, second),
  });
  assert.equal(connection.runtime, 'claude-code');
});

/**
 * Pairing trusts a key, so it names one.
 *
 * A re-registration under the same name keeps the device's id and swaps its
 * key, so a pairing by id alone trusted whichever key had registered last --
 * between the owner reading the fingerprint and pressing the button. And a
 * revoked key was one pairing away from trusted again.
 */
test('pairing names the key it trusts, and does not undo a revocation (F12.7)', async () => {
  const fixture = await createCompany('gateway-fingerprint');
  const register = (publicKeyPem: string, name = 'laptop') => registerDevice({
    companyId: fixture.companyId, name, runtime: 'script', publicKeyPem,
  });
  const status = () => withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string }>('SELECT status FROM gateway_devices');
    return rows.map((row) => row.status);
  });

  const seen = await register(keypair().publicKey);
  const swappedKey = keypair().publicKey;
  const swapped = await register(swappedKey);
  assert.equal(swapped.id, seen.id, 'the same device, wearing another key');
  assert.notEqual(swapped.keyFingerprint, seen.keyFingerprint);

  await assert.rejects(
    () => pairDevice(fixture.companyId, seen.id, { keyFingerprint: seen.keyFingerprint }),
    (error: unknown) => isPalugadaError(error, 'gateway.key_mismatch'),
  );
  assert.deepEqual(await status(), ['pending']);

  // What the machine prints, the way OpenSSL prints it...
  const { createHash, createPublicKey } = await import('node:crypto');
  assert.equal(swapped.keyFingerprint, createHash('sha256')
    .update(createPublicKey(swappedKey).export({ type: 'spki', format: 'der' }))
    .digest('hex'));
  // ...and typed off its screen, in pairs and capitals.
  await pairDevice(fixture.companyId, swapped.id, {
    keyFingerprint: ` ${swapped.keyFingerprint.toUpperCase().match(/../g)!.join(':')} `,
  });
  assert.deepEqual(await status(), ['paired']);

  await revokeDevice(fixture.companyId, swapped.id);
  await assert.rejects(
    () => pairDevice(fixture.companyId, swapped.id, { keyFingerprint: swapped.keyFingerprint }),
    (error: unknown) => isPalugadaError(error, 'gateway.not_pairable'),
  );
  assert.deepEqual(await status(), ['revoked']);

  // The machine comes back with a new key, which is new, and pending.
  const back = await register(keypair().publicKey);
  assert.equal(back.status, 'pending');
  await pairDevice(fixture.companyId, back.id, { keyFingerprint: back.keyFingerprint });
  assert.deepEqual(await status(), ['paired']);

  await assert.rejects(
    () => register('-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----', 'typo'),
    (error: unknown) => isPalugadaError(error, 'contract.violation'),
  );
  await assert.rejects(
    () => pairDevice(fixture.companyId, '00000000-0000-4000-8000-000000000000', { keyFingerprint: 'x' }),
    (error: unknown) => isPalugadaError(error, 'gateway.not_pairable'),
  );

  // One stored before keys were checked at registration is refused, not a crash.
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE gateway_devices SET public_key = 'not a key', status = 'pending', paired_at = NULL",
  ));
  await assert.rejects(
    () => pairDevice(fixture.companyId, back.id, { keyFingerprint: back.keyFingerprint }),
    (error: unknown) => isPalugadaError(error, 'gateway.not_pairable'),
  );
});

test('a stolen device id without the key is not a device (F12.7)', async () => {
  const fixture = await createCompany('gateway-signature');
  const { publicKey } = keypair();
  const impostor = keypair();

  const device = await registerDevice({
    companyId: fixture.companyId,
    name: 'laptop',
    runtime: 'script',
    publicKeyPem: publicKey,
  });
  await pairDevice(fixture.companyId, device.id, { keyFingerprint: device.keyFingerprint });

  const nonce = await issueChallenge(fixture.companyId, device.id);
  await assert.rejects(
    () =>
      connect({
        companyId: fixture.companyId,
        deviceId: device.id,
        nonce,
        signatureBase64: signedNonce(impostor.privateKey, nonce),
      }),
    (error: unknown) => isPalugadaError(error, 'gateway.bad_signature'),
  );

  const security = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      "SELECT type FROM events WHERE type = 'security.gateway_bad_signature'",
    );
    return rows;
  });
  assert.equal(security.length, 1);
});

test('a captured signature cannot be presented twice (F12.7)', async () => {
  const fixture = await createCompany('gateway-replay');
  const { publicKey, privateKey } = keypair();
  const device = await registerDevice({
    companyId: fixture.companyId,
    name: 'laptop',
    runtime: 'script',
    publicKeyPem: publicKey,
  });
  await pairDevice(fixture.companyId, device.id, { keyFingerprint: device.keyFingerprint });

  const nonce = await issueChallenge(fixture.companyId, device.id);
  const signature = signedNonce(privateKey, nonce);

  await connect({ companyId: fixture.companyId, deviceId: device.id, nonce, signatureBase64: signature });
  await assert.rejects(
    () =>
      connect({
        companyId: fixture.companyId,
        deviceId: device.id,
        nonce,
        signatureBase64: signature,
      }),
    (error: unknown) => isPalugadaError(error, 'gateway.replayed'),
  );
});

test('a quarantined device may read and may not change anything (F12.10)', async () => {
  const fixture = await createCompany('gateway-quarantine');
  const { publicKey, privateKey } = keypair();
  const device = await registerDevice({
    companyId: fixture.companyId,
    name: 'unvouched',
    runtime: 'http',
    publicKeyPem: publicKey,
  });
  await pairDevice(fixture.companyId, device.id, { keyFingerprint: device.keyFingerprint });

  const nonce = await issueChallenge(fixture.companyId, device.id);
  const quarantined = await connect({
    companyId: fixture.companyId,
    deviceId: device.id,
    nonce,
    signatureBase64: signedNonce(privateKey, nonce),
  });
  assert.equal(quarantined.maxTier, 0);
  assert.doesNotThrow(() => assertWithinQuarantine(quarantined, 0));
  assert.throws(
    () => assertWithinQuarantine(quarantined, 1),
    (error: unknown) => isPalugadaError(error, 'gateway.quarantined'),
  );

  // Lifting quarantine is the owner vouching for the device, and it is the only
  // thing that widens what the device may reach.
  await pairDevice(fixture.companyId, device.id, {
    keyFingerprint: device.keyFingerprint,
    liftQuarantine: true,
  });
  const fresh = await issueChallenge(fixture.companyId, device.id);
  const lifted = await connect({
    companyId: fixture.companyId,
    deviceId: device.id,
    nonce: fresh,
    signatureBase64: signedNonce(privateKey, fresh),
  });
  assert.equal(lifted.maxTier, 3);
  assert.doesNotThrow(() => assertWithinQuarantine(lifted, 3));
});

test('a retried side effect gets the first answer, not a second effect (F12.8)', async () => {
  const fixture = await createCompany('gateway-dedupe');
  const { publicKey } = keypair();
  const device = await registerDevice({
    companyId: fixture.companyId,
    name: 'laptop',
    runtime: 'script',
    publicKeyPem: publicKey,
  });

  const first = await claimIdempotencyKey<{ sent: number }>(
    fixture.companyId,
    device.id,
    'idem-1',
    'tool.call',
  );
  assert.equal(first.replayed, false);
  if (first.replayed === false) await first.commit({ sent: 3 });

  const retry = await claimIdempotencyKey<{ sent: number }>(
    fixture.companyId,
    device.id,
    'idem-1',
    'tool.call',
  );
  assert.equal(retry.replayed, true);
  if (retry.replayed) assert.deepEqual(retry.response, { sent: 3 });

  // A claim left in flight -- the process died mid-effect -- replays with a
  // null response. That is the honest answer: only the caller knows whether
  // repeating its effect is safe.
  const inFlight = await claimIdempotencyKey(fixture.companyId, device.id, 'idem-2', 'tool.call');
  assert.equal(inFlight.replayed, false);
  const afterCrash = await claimIdempotencyKey(
    fixture.companyId,
    device.id,
    'idem-2',
    'tool.call',
  );
  assert.equal(afterCrash.replayed, true);
  if (afterCrash.replayed) assert.equal(afterCrash.response, null);
});

/**
 * Updating a company-wide policy updates it.
 *
 * The upsert's unique key counted NULLs as distinct, and a company-wide
 * policy has a NULL division: every "update" inserted a second row. The log
 * said the owner had relaxed the deny, and the old deny went on being
 * enforced beside the new rule.
 */
test('a policy written twice at company or platform scope is one policy (F3.4)', async () => {
  const fixture = await createCompany('policy-upsert');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const rows = (slug: string) => withControlPlane(async (tx) => {
    const { rows: found } = await tx.query<{ id: string; mode: string }>(
      'SELECT id, mode FROM policies WHERE slug = $1', [slug],
    );
    return found;
  });

  const condition = { field: 'tool', op: 'eq', value: 'email.send' } as const;
  const first = await putPolicy({ companyId: fixture.companyId, slug: 'company-wide', effect: 'deny', condition });
  const second = await putPolicy({
    companyId: fixture.companyId, slug: 'company-wide', effect: 'deny', condition, mode: 'log_only',
  });
  assert.equal(second, first, 'the same policy, changed');
  assert.deepEqual((await rows('company-wide')).map((row) => row.mode), ['log_only']);

  const platform = await putPolicy({ slug: 'platform-wide', effect: 'deny', condition });
  await putPolicy({ slug: 'platform-wide', effect: 'deny', condition, mode: 'log_only' });
  assert.deepEqual((await rows('platform-wide')).map((row) => [row.id, row.mode]), [[platform, 'log_only']]);
});
