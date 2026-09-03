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
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant, withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import * as budget from '../../src/engine/budget.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
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
import { exportToDisk, importFromDisk } from '../../src/governance/charter-files.ts';
import { publishCharter } from '../../src/governance/store.ts';
import {
  claimIdempotencyKey,
  connect,
  issueChallenge,
  pairDevice,
  registerDevice,
  assertWithinQuarantine,
} from '../../src/gateway/gateway.ts';
import { chooseReviewerModel } from '../../src/review/review.ts';
import { containChildResult, CHILD_OUTPUT_TOKEN_LIMIT } from '../../src/engine/containment.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, addRole, type Fixture } from '../helpers/fixtures.ts';
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

test('a sub-agent returns an answer and a bounded summary, never a report (F6.7)', () => {
  const contained = containChildResult('researcher', { finding: 'the zone is stale' }, {
    status: 'completed',
    steps: 3,
    costCents: 12,
  });
  assert.match(contained.summary, /^researcher completed in 3 steps, 12c\./);
  assert.match(contained.summary, /Returned finding\./);

  // An output over the ceiling is a contract violation rather than something to
  // truncate: half a JSON document that still parses is the worst failure here.
  const huge = { transcript: 'x'.repeat(CHILD_OUTPUT_TOKEN_LIMIT * 4 + 10) };
  assert.throws(
    () => containChildResult('researcher', huge, { status: 'completed', steps: 1, costCents: 0 }),
    (error: unknown) => isPalugadaError(error, 'contract.violation'),
  );
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

/* ------------------------------------------------------------------ F10.3 --- */

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

  await inbox.answerOwnerQuestion(fixture.companyId, itemId, 'host-b, TTL 300.');
  const answered = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: { answers?: unknown[] } }>(
      'SELECT payload FROM inbox_items WHERE id = $1',
      [itemId],
    );
    return rows[0]!.payload;
  });
  assert.equal(answered.answers?.length, 1);
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

  await pairDevice(fixture.companyId, device.id);
  const second = await issueChallenge(fixture.companyId, device.id);
  const connection = await connect({
    companyId: fixture.companyId,
    deviceId: device.id,
    nonce: second,
    signatureBase64: signedNonce(privateKey, second),
  });
  assert.equal(connection.runtime, 'claude-code');
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
  await pairDevice(fixture.companyId, device.id);

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
  await pairDevice(fixture.companyId, device.id);

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
  await pairDevice(fixture.companyId, device.id);

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
  await pairDevice(fixture.companyId, device.id, { liftQuarantine: true });
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
