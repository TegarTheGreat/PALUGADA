/**
 * What a running deployment cannot do (PRD v2 §10).
 *
 * This repository has found the same defect five times: **machinery that
 * works, is tested in isolation, and is assembled by nobody.** F1.6's budget
 * inheritance, the platform tools every context pack instructs a run to call,
 * the broker built without its secret manager, `httpCapability` with no way to
 * hand a spec in, and finally an `Engine` with no runtime -- a worker that
 * halted every task it checked out. Each was real, tested, correct code, and
 * each was proved correct against a test that constructed its own caller. The
 * caller nobody wrote was the assembly.
 *
 * A review found each of them one at a time. This test finds them all at once,
 * and it is deliberately blunt: it reads every exported value in `src/`, counts
 * how many times its name appears anywhere in `src/` or `scripts/`, and lists
 * the ones that appear exactly once -- their own definition. Something no
 * production code mentions is something only a test calls.
 *
 * **The list below is not an exemption, it is an inventory.** Every entry is a
 * capability this platform implements and a running deployment has no way to
 * reach, and the reason is written next to it. The test fails when the set
 * changes in either direction: a new orphan has to be justified here before it
 * can be committed, and one that gets wired up has to be struck off. That
 * makes the sixth instance of the defect a red test rather than a review
 * finding.
 *
 * The scan is textual rather than a type-aware graph, on purpose. A name
 * mentioned in a comment counts as reachable, which makes this *under*-report
 * -- and an under-reporting guard that runs in two seconds and needs no
 * toolchain is worth more than an exact one nobody keeps working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Why each of these is unreachable, and what it would take to change that.
 *
 * Four reasons, and only the first is a gap in the platform rather than a
 * property of the code:
 *
 * - `console` -- an owner operation with no route on the owner's console. The
 *   owner is the only human here, so an operation they cannot invoke is an
 *   operation the platform does not really have. This is by far the largest
 *   group and it is the honest shape of "what is left".
 * - `worker` -- a platform operation nothing on the tick performs yet.
 * - `entry` -- an alternative entry point, called by a deployment rather than
 *   by this repository.
 * - `helper` -- a predicate, constant or renderer whose callers inline the
 *   same thing, kept exported because a test asserts on it directly.
 */
const UNREACHABLE: Record<string, string> = {
  // F11: the audit trail an owner can read.
  readTaskEvents: 'console: F11.2 has no route that returns a task\'s events',
  collectExport: 'console: F16.4 export is not offered anywhere',
  EXPORT_SECTION_NAMES: 'helper: the section list, asserted directly',
  IMPORT_SECTION_NAMES: 'helper: the section list, asserted directly',
  NOT_RESTORED: 'helper: what an import deliberately drops, asserted directly',
  isRlsViolation: 'worker: F1.4 denials are not swept into incidents on the tick',
  reportRlsDenial: 'worker: F1.4 denials are not swept into incidents on the tick',

  // F8: the catalogue and preflight.
  catalogueNames: 'helper: the catalogue as names, asserted directly',
  declarationFor: 'helper: one catalogue entry, asserted directly',
  healthFor: 'console: F8.12 health is not shown to the owner',

  // F16: bundles.
  forgetBundleHooks: 'helper: a cache reset a test needs between installs',
  verifyInstall: 'console: F16.5 install verification is not offered',
  listTrustedPublishers: 'console: F16.2 publishers cannot be seen',
  revokePublisher: 'console: F16.2 publishers cannot be revoked',

  // F2.7, F3.10: the goal ladder.
  applyGoalChange: 'console: F2.7 the ladder cannot be edited',
  createGoal: 'console: F2.7 the ladder cannot be edited',

  // F1: budget.
  chainFor: 'console: F1.6 the account chain is not shown',
  createAccount: 'console: F1.2 an account cannot be opened',

  // F5, F11: the engine's own machinery.
  forgetCompiledSchemas: 'helper: a cache reset a test needs between schemas',
  countCommittedSteps: 'helper: a journal count, asserted directly',
  recordPlan: 'worker: F8.11 a plan is recorded by a runtime, and none here plans',
  describeReplay: 'console: F11.4 replay is not offered',
  replayTask: 'console: F11.4 replay is not offered',
  claimReadyWindowTasks: 'worker: F9.6 batch windows are not drained on the tick',

  // Predicates every caller writes inline.
  isPalugadaError: 'helper: production narrows on `instanceof` and `code` directly',
  isTenantContextMissing: 'helper: the RLS probe, asserted directly',

  // F17: role evals.
  acceptEvalCase: 'console: F17.1 an eval case cannot be accepted',
  assertApproved: 'console: F17.3 a role change cannot be approved',
  latestScore: 'console: F17.3 a score is not shown',
  requestRoleChange: 'console: F17.2 a role change cannot be requested',

  // F12.7-F12.10: the device gateway.
  assertWithinQuarantine: 'console: F12.10 quarantine is not surfaced',
  claimIdempotencyKey: 'console: no device speaks to this deployment yet',
  issueChallenge: 'console: F12.7 pairing is not offered',
  pairDevice: 'console: F12.7 pairing is not offered',
  registerDevice: 'console: F12.7 pairing is not offered',
  revokeDevice: 'console: F12.7 a device cannot be revoked',
  secretsMatch: 'helper: the constant-time compare, asserted directly',

  // F1.7-F1.9: the spend ceiling.
  clearSpendPause: 'console: F1.9 a spend pause cannot be lifted',
  overrideSpendPause: 'console: F1.9 a spend pause cannot be overridden',
  setSpendLimit: 'console: F1.7 the ceiling cannot be set',

  // F3: policy and structure.
  putPolicy: 'console: F3.4 a policy cannot be written',
  readGovernanceLog: 'console: F3.11 the governance log is not shown',
  applyGrantChange: 'console: F3.9 a grant cannot be changed',
  applyRoleChange: 'console: F3.9 a role cannot be changed',
  proposeStructuralChange: 'console: F3.9 a change cannot be proposed',
  setEscalationPolicy: 'console: F2.6 escalation cannot be configured',

  // F10: the owner surface itself.
  answerOwnerQuestion: 'console: F10.3 an agent\'s question cannot be answered',
  stopEverything: 'console: the route calls `requestStopAll`, which is the '
    + 'control-plane half; this is the inbox half that files the item',

  // F4: memory.
  distillEpisodicToSemantic: 'worker: F4.5 distillation is not run on the tick',
  distillSemanticToProcedural: 'worker: F4.5 distillation is not run on the tick',
  supersede: 'console: F4.6 a fact cannot be superseded by hand',

  // F3.4, F10.6, F11: reporting.
  strictness: 'helper: the effect ordering, asserted directly',
  setThresholds: 'console: F11.6 alert thresholds cannot be set',
  costTimeline: 'console: F11.5 the cost timeline is not shown',
  platformCost: 'console: F11.5 platform cost is not shown',
  renderDailyDigest: 'worker: F10.6 the digest is drawn by the console; no '
    + 'channel sends the rendered text',

  // F1.5: retention.
  readRetentionLog: 'console: F1.5 the retention log is not shown',
  setRetention: 'console: F1.5 retention cannot be configured',

  // F7: adversarial review.
  pendingReviews: 'console: F7.5 pending reviews are not shown',

  // F13, F12.9.
  knownClis: 'helper: the four starting-point specs, read by an operator '
    + 'writing PALUGADA_RUNTIME_SPECS rather than by this process',
  runSandboxed: 'worker: F12.9 nothing here executes untrusted code; '
    + '`code.execute` needs somebody\'s account',

  // F9: the scheduler.
  upsertSchedule: 'console: F9.1 a schedule cannot be created',
  assignTask: 'worker: F9.9 a wake is consumed by the tick, not assigned by hand',
  coalescedCount: 'helper: how many wakes merged, asserted directly',
  pendingNotifications: 'helper: the queue behind the owner window, asserted directly',
  setBatchWindow: 'console: F9.6 the batch window cannot be set',
  setOwnerWindow: 'console: F9.5 the owner\'s hours cannot be set',

  // F12.3.
  rotateCredential: 'console: F12.3 a credential cannot be rotated',

  // F15: skills.
  approveSkillVersion: 'console: F15.4 a skill cannot be approved',
  importExternalSkill: 'console: F15.8 a skill cannot be imported',
  liftSkillQuarantine: 'console: F15.6 quarantine cannot be lifted',
  recordSkillReview: 'console: F15.4 a review cannot be recorded',
  renderSkillDocument: 'helper: the document form, asserted directly',
  screenCandidate: 'worker: F15.3 candidates are not screened on the tick',
  setSkillScope: 'console: F15.5 scope cannot be changed',

  // Entry points and templates.
  installStandardTemplate: 'entry: a deployment builds its first company with it',
  runWorker: 'entry: the worker as a process, for a deployment that wants one',
};

async function walk(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const EXPORTED = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

test('every exported value is reachable from a running deployment, or says why not', async () => {
  const files = [
    ...await walk(join(ROOT, 'src')),
    ...await walk(join(ROOT, 'scripts')),
  ];
  const sources = new Map<string, string>();
  for (const file of files) sources.set(relative(ROOT, file), await readFile(file, 'utf8'));

  const found = new Map<string, string>();
  for (const [file, body] of sources) {
    if (!file.startsWith('src/')) continue;
    for (const match of body.matchAll(EXPORTED)) {
      const name = match[1]!;
      let mentions = 0;
      const word = new RegExp(`\\b${name}\\b`, 'g');
      for (const other of sources.values()) mentions += (other.match(word) ?? []).length;
      // One mention is the export line itself. Anything more is a caller, a
      // re-export, or at worst a comment -- all of which mean somebody has
      // looked at it from outside.
      if (mentions <= 1) found.set(name, file);
    }
  }

  const orphans = [...found.keys()].sort();
  const recorded = Object.keys(UNREACHABLE).sort();

  const undeclared = orphans.filter((name) => !(name in UNREACHABLE));
  assert.deepEqual(
    undeclared, [],
    'exported and unreachable from any deployment, and not recorded in this file. '
      + 'This is the defect this repository has found five times: machinery that works, '
      + 'is tested alone, and is assembled by nobody. Wire it up, or record here why a '
      + 'running deployment cannot reach it:\n'
      + undeclared.map((name) => `  ${name} (${found.get(name)})`).join('\n'),
  );

  const stale = recorded.filter((name) => !found.has(name));
  assert.deepEqual(
    stale, [],
    'recorded as unreachable and now reachable. Strike these off the list, '
      + 'so it keeps meaning what it says:\n' + stale.map((name) => `  ${name}`).join('\n'),
  );
});

test('the inventory says which surface each unreachable operation is missing from', () => {
  // The reasons are the point. A list of names with no reasons decays into a
  // suppression file, and a suppression file is how a guard stops guarding.
  for (const [name, reason] of Object.entries(UNREACHABLE)) {
    assert.match(
      reason, /^(console|worker|entry|helper): ./,
      `${name} has no category; it must say which surface would reach it`,
    );
  }
});
