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
  EXPORT_SECTION_NAMES: 'helper: the section list, asserted directly',
  IMPORT_SECTION_NAMES: 'helper: the section list, asserted directly',
  NOT_RESTORED: 'helper: what an import deliberately drops, asserted directly',

  // F8: the catalogue and preflight.
  catalogueNames: 'helper: the catalogue as names, asserted directly',
  declarationFor: 'helper: one catalogue entry, asserted directly',

  // F16: bundles.
  forgetBundleHooks: 'helper: a cache reset a test needs between installs',

  // F2.7, F3.10: the goal ladder.

  // F1: budget.

  // F5, F11: the engine's own machinery.
  forgetCompiledSchemas: 'helper: a cache reset a test needs between schemas',
  countCommittedSteps: 'helper: a journal count, asserted directly',
  recordPlan: 'worker: F8.11 a plan is recorded by a runtime, and none here plans',

  // Predicates every caller writes inline.
  isPalugadaError: 'helper: production narrows on `instanceof` and `code` directly',
  isTenantContextMissing: 'helper: the RLS probe, asserted directly',

  // F17: role evals.
  assertApproved: 'console: F17.3 a role change cannot be approved',

  // F12.7-F12.10: the device gateway.
  assertWithinQuarantine: 'console: F12.10 quarantine is not surfaced',
  claimIdempotencyKey: 'console: no device speaks to this deployment yet',
  secretsMatch: 'helper: the constant-time compare, asserted directly',

  // F1.7-F1.9: the spend ceiling.

  // F3: policy and structure.
  proposeStructuralChange: 'console: F3.9 a change cannot be proposed',

  // F10: the owner surface itself.

  // F4: memory.

  // F3.4, F10.6, F11: reporting.
  strictness: 'helper: the effect ordering, asserted directly',

  // F1.5: retention.

  // F7: adversarial review.

  // F13, F12.9.
  knownClis: 'helper: the four starting-point specs, read by an operator '
    + 'writing PALUGADA_RUNTIME_SPECS rather than by this process',
  runSandboxed: 'worker: F12.9 nothing here executes untrusted code; '
    + '`code.execute` needs somebody\'s account',

  // F9: the scheduler.
  coalescedCount: 'helper: how many wakes merged, asserted directly',
  pendingNotifications: 'helper: the queue behind the owner window, asserted directly',

  // F12.3.

  // F15: skills.
  renderSkillDocument: 'helper: the document form, asserted directly',

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
