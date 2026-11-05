/**
 * Core processes as owned skills (PRD v2 F18.14; docs/STATUS.md 2.201).
 *
 * A company had skills -- reviewed, checked, approved by the owner -- and no
 * way to say which few of them are the way the company works, who answers
 * for each, or whether anybody follows them. Section 2.189 adopts the
 * process part of the operating method after Wickman under a plain name:
 * a handful of core processes, each one active skill with one owning seat,
 * measured by how many of the seat's division's runs read it. These hold
 * the database to one seat of the company's own, the owner's route to its
 * refusals and its soft limit, the followed share to its window, the seat's
 * runs to being told, and the archive to carrying it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { structureOf } from '../../src/owner/views.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import {
  addEvalCase, approveSkillVersion, importExternalSkill, proposeSkillVersion, recordSkillReview, setSkillScope,
} from '../../src/skills/skills.ts';
import { coreProcessesOf } from '../../src/skills/core.ts';
import { skillReadCapability } from '../../src/broker/platform-capabilities.ts';
import { addRole, createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const skillText = (slug: string, steps = 3) => `---
name: ${slug}
description: How the company does ${slug}, step by step.
---

# ${slug}

${Array.from({ length: steps }, (_, at) => `${at + 1}. Step ${at + 1} of ${slug}.`).join('\n')}
`;

/** A skill that has passed both gates and is live, as every core process is. */
async function activeSkill(
  fixture: Fixture, slug: string,
  options: { scope?: 'division' | 'company'; divisionId?: string; steps?: number } = {},
): Promise<string> {
  const scope = options.scope ?? 'division';
  const proposed = await proposeSkillVersion({
    companyId: fixture.companyId, slug, scopeType: scope,
    ...(scope === 'division' ? { scopeId: options.divisionId ?? fixture.divisionId } : {}),
    source: skillText(slug, options.steps), author: 'owner', changelog: 'Written by the owner.',
  });
  await addEvalCase(fixture.companyId, proposed.skillId, { name: 'says the first step', input: {}, expectContains: ['Step 1'] });
  await recordSkillReview(fixture.companyId, proposed.versionId, { approved: true });
  await approveSkillVersion(fixture.companyId, proposed.versionId);
  return proposed.skillId;
}

async function otherDivision(fixture: Fixture, slug: string): Promise<{ divisionId: string; roleId: string }> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows: division } = await tx.query<{ id: string }>(
      'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id', [fixture.companyId, slug, slug]);
    const { rows: role } = await tx.query<{ id: string }>(
      `INSERT INTO roles (company_id, division_id, slug, system_prompt, model, output_schema, done_criteria)
       VALUES ($1, $2, $3, 'You do the work of the division.', 'test-model', '{"type":"object"}'::jsonb,
               ARRAY['the run returns an output matching its schema']) RETURNING id`,
      [fixture.companyId, division[0]!.id, `${slug}-lead`]);
    return { divisionId: division[0]!.id, roleId: role[0]!.id };
  });
}

let sequence = 0;
/** A task with one run of it, started `daysAgo` days ago and finished an hour later, or still running. */
async function ranTask(fixture: Fixture, roleId: string, divisionId: string, options: { daysAgo?: number; running?: boolean } = {}) {
  sequence += 1;
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId, roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `work the process, take ${sequence}` }, createdBy: 'owner', reserveTokens: 1_000,
  });
  const daysAgo = options.daysAgo ?? 0;
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO agent_runs (company_id, task_id, role_id, attempt, status, started_at, finished_at)
     VALUES ($1, $2, $3, 1, $4, now() - make_interval(days => $5) - interval '1 minute',
             CASE WHEN $6 THEN NULL ELSE now() - make_interval(days => $5) + interval '1 hour' END)`,
    [fixture.companyId, task.id, roleId, options.running ? 'running' : 'succeeded', daysAgo, options.running ?? false]));
  return task.id;
}

/** What `skill.read` does inside a run: the document, and the record that the run read it. */
async function readIn(fixture: Fixture, taskId: string, divisionId: string, slug: string) {
  return skillReadCapability().execute({ slug }, {
    companyId: fixture.companyId, divisionId, taskId, idempotencyKey: `read:${taskId}:${slug}`,
    signal: new AbortController().signal, credential: async () => { throw new Error('no credential is needed'); },
  });
}

/** The grant that lets a division's runs open a skill: the followed share counts nothing without it. */
async function grantRead(fixture: Fixture, divisionId: string) {
  await registerStandardCatalogue();
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO capability_grants (company_id, division_id, capability_name) VALUES ($1, $2, 'skill.read')
     ON CONFLICT (division_id, capability_name) DO NOTHING`,
    [fixture.companyId, divisionId]));
}

/** The role charter a run of this seat is handed, for a task of the company's. */
async function charterOf(companyId: string, divisionId: string, taskId: string) {
  const context = await withTenant(companyId, (tx) => buildContext(tx, { companyId, divisionId, taskId }));
  return context.sections.find((section) => section.kind === 'role_charter')!.body;
}

async function setCore(fixture: Fixture, skillId: string, roleId: string | null) {
  await withControlPlane((tx) => tx.query(
    'UPDATE skills SET core = $3, owner_role_id = $4 WHERE id = $1 AND company_id = $2',
    [skillId, fixture.companyId, roleId !== null, roleId]));
}

test('a core process has one seat of its own company, and an agent cannot mark one', async () => {
  const fixture = await createCompany('core-db');
  const other = await createCompany('core-db-other');
  const skillId = await activeSkill(fixture, 'sales-process');

  await assert.rejects(withControlPlane((tx) => tx.query(
    'UPDATE skills SET core = true WHERE id = $1', [skillId])), /skills_core_has_one_seat/,
    'a core process with nobody answering for it is refused');
  await assert.rejects(withControlPlane((tx) => tx.query(
    'UPDATE skills SET owner_role_id = $2 WHERE id = $1', [skillId, fixture.roleId])), /skills_core_has_one_seat/,
    'a seat on a skill that is not core says something nobody decided');
  await assert.rejects(setCore(fixture, skillId, other.roleId), /skills_owner_role_fkey/,
    'another company\'s seat cannot own this company\'s process');
  await setCore(fixture, skillId, fixture.roleId);

  // Marking is the owner's, so the application role holds no grant to it,
  // and keeps the ones the skill loop writes with.
  const may = async (check: string) => withControlPlane(async (tx) =>
    (await tx.query<{ ok: boolean }>(`SELECT ${check} AS ok`)).rows[0]!.ok);
  for (const column of ['core', 'owner_role_id']) {
    assert.equal(await may(`has_column_privilege('palugada_app', 'skills', '${column}', 'UPDATE')`), false, `UPDATE ${column}`);
    assert.equal(await may(`has_column_privilege('palugada_app', 'skills', '${column}', 'INSERT')`), false, `INSERT ${column}`);
  }
  for (const column of ['summary', 'active_version', 'scope_type', 'scope_id', 'provenance', 'origin', 'quarantined']) {
    assert.equal(await may(`has_column_privilege('palugada_app', 'skills', '${column}', 'UPDATE')`), true, `UPDATE ${column}`);
  }
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE skills SET core = false, owner_role_id = NULL WHERE id = $1', [skillId])), /permission denied/);
});

test('the owner marks an active skill core with its seat; the soft limit warns and never refuses', async () => {
  const fixture = await createCompany('core-route');
  const sales = await addRole(fixture, 'sales');
  const elsewhere = await otherDivision(fixture, 'support');
  const skillId = await activeSkill(fixture, 'sales-process');
  const candidate = await proposeSkillVersion({
    companyId: fixture.companyId, slug: 'draft-process', scopeType: 'company',
    source: skillText('draft-process'), author: 'owner', changelog: 'A draft.',
  });
  const theirs = await activeSkill(fixture, 'support-process', { divisionId: elsewhere.divisionId });
  await grantRead(fixture, fixture.divisionId);
  await grantRead(fixture, elsewhere.divisionId);

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const core = (id: string) => `/api/companies/${fixture.companyId}/skills/${id}/core`;

    const noSeat = await api.call('POST', core(skillId), token, { core: true });
    assert.equal(noSeat.status, 400);
    assert.match(String(noSeat.body.error), /a core process has one owning seat: give roleId/);
    const notCore = await api.call('POST', core(skillId), token, { core: 'yes', roleId: sales });
    assert.equal(notCore.status, 400);
    assert.match(String(notCore.body.error), /core must be true or false/);
    const strange = await api.call('POST', core(skillId), token, { core: true, roleId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(strange.status, 400);
    assert.match(String(strange.body.error), /no role 00000000-0000-4000-8000-000000000000 in this company/);
    const inactive = await api.call('POST', core(candidate.skillId), token, { core: true, roleId: sales });
    assert.equal(inactive.status, 400);
    assert.match(String(inactive.body.error), /draft-process has no active version.*only a skill that is switched on/);
    const unseen = await api.call('POST', core(theirs), token, { core: true, roleId: sales });
    assert.equal(unseen.status, 400);
    assert.match(String(unseen.body.error),
      /support-process applies to one division, and sales works in another: .*its runs could not read it/);

    const marked = await api.call('POST', core(skillId), token, { core: true, roleId: sales });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    assert.deepEqual(marked.body.warnings, [{ kind: 'fewer_than_five', count: 1 }],
      'one core process is fewer than the five the sources start from: warned, and kept');
    const listed = (await api.call('GET', `/api/companies/${fixture.companyId}/skills`, token)).body.skills;
    const shown = listed.find((one: { id: string }) => one.id === skillId);
    assert.equal(shown.core, true);
    assert.equal(shown.ownerRoleId, sales);
    assert.equal(shown.ownerRole, 'sales');
    const { rows: events } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'skill.core_changed' ORDER BY occurred_at"));
    assert.deepEqual(events.map((event) => event.payload), [{ skillId, slug: 'sales-process', core: true, ownerRoleId: sales }]);

    // Twelve more makes thirteen: past the most the sources name, warned
    // on the answer and on the chart, and not refused.
    for (let at = 0; at < 12; at += 1) await setCore(fixture, await activeSkill(fixture, `process-${at}`), fixture.roleId);
    const another = await activeSkill(fixture, 'renewals', { scope: 'company' });
    const thirteenth = await api.call('POST', core(another), token, { core: true, roleId: elsewhere.roleId });
    assert.equal(thirteenth.status, 200, JSON.stringify(thirteenth.body));
    assert.deepEqual(thirteenth.body.warnings, [{ kind: 'more_than_twelve', count: 14 }]);
    const structure = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    assert.equal(structure.coreProcesses.processes.length, 14);
    assert.deepEqual(structure.coreProcesses.warnings, [{ kind: 'more_than_twelve', count: 14 }]);
    // The structure is a read of no one else's words (READS_OF_NO_ONE_ELSES_WORDS):
    // the assistant may act on it at once. A skill's summary is the words of
    // whoever wrote the skill, an agent or a bundle's publisher, so the chart
    // carries the process by its slug, seat and numbers, and the summary is
    // read from GET /skills, which leaves the assistant's action as a card.
    for (const process of structure.coreProcesses.processes) assert.equal('summary' in process, false, `${process.slug} carries its summary`);
    assert.doesNotMatch(JSON.stringify(structure), /How the company does/, 'no skill\'s text is in the structure');
    assert.match(JSON.stringify(listed), /How the company does sales-process, step by step\./, 'the skills list does carry it');

    // Its seat moves, and then it is core no more: both are the owner's.
    const moved = await api.call('POST', core(skillId), token, { core: true, roleId: fixture.roleId });
    assert.equal(moved.status, 200);
    const unmarked = await api.call('POST', core(skillId), token, { core: false });
    assert.equal(unmarked.status, 200);
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ core: boolean; owner_role_id: string | null }>(
      'SELECT core, owner_role_id FROM skills WHERE id = $1', [skillId]));
    assert.deepEqual(rows[0], { core: false, owner_role_id: null });
  } finally {
    await api.close();
  }
});

test('the followed share is the runs of the seat\'s division that read the process, over a stated window', async () => {
  const fixture = await createCompany('core-followed');
  const sales = await addRole(fixture, 'sales');
  const elsewhere = await otherDivision(fixture, 'support');
  const skillId = await activeSkill(fixture, 'sales-process', { scope: 'company' });
  await activeSkill(fixture, 'refunds', { scope: 'company' });
  await setCore(fixture, skillId, sales);
  await grantRead(fixture, fixture.divisionId);
  await grantRead(fixture, elsewhere.divisionId);

  // In the seat's division, in the last thirty days: four runs, by any of its
  // roles. Two read the process, one read another skill, one read nothing.
  const first = await ranTask(fixture, sales, fixture.divisionId);
  assert.match(String((await readIn(fixture, first, fixture.divisionId, 'sales-process')).source), /Step 1 of sales-process/);
  const second = await ranTask(fixture, fixture.roleId, fixture.divisionId, { running: true });
  await readIn(fixture, second, fixture.divisionId, 'sales-process');
  await readIn(fixture, second, fixture.divisionId, 'sales-process');
  const third = await ranTask(fixture, sales, fixture.divisionId);
  await readIn(fixture, third, fixture.divisionId, 'refunds');
  await ranTask(fixture, sales, fixture.divisionId);
  // A skill that is not there is an answer, and no read.
  assert.equal((await readIn(fixture, third, fixture.divisionId, 'no-such-skill')).source, null);
  // Another division's run reads it too, and is not the seat's to count.
  const theirs = await ranTask(fixture, elsewhere.roleId, elsewhere.divisionId);
  await readIn(fixture, theirs, elsewhere.divisionId, 'sales-process');
  // And forty days ago, a run that read it: outside the window.
  const old = await ranTask(fixture, sales, fixture.divisionId, { daysAgo: 40 });
  await withControlPlane((tx) => tx.query(
    `INSERT INTO events (company_id, task_id, type, actor, payload, occurred_at)
     VALUES ($1, $2, 'skill.read', 'agent_run', $3, now() - interval '40 days')`,
    [fixture.companyId, old, JSON.stringify({ slug: 'sales-process', version: 1 })]));

  const { rows: reads } = await withTenant(fixture.companyId, (tx) => tx.query<{ task_id: string; payload: Record<string, unknown> }>(
    "SELECT task_id, payload FROM events WHERE type = 'skill.read' AND task_id = $1", [first]));
  assert.deepEqual(reads, [{ task_id: first, payload: { slug: 'sales-process', version: 1 } }]);

  const report = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId));
  assert.equal(report.windowDays, 30);
  const process = report.processes[0]!;
  assert.deepEqual(
    { slug: process.slug, ownerRoleId: process.ownerRoleId, ownerRole: process.ownerRole, divisionId: process.divisionId,
      runs: process.runs, followedRuns: process.followedRuns, followedShare: process.followedShare, ageDays: process.ageDays, stale: process.stale },
    { slug: 'sales-process', ownerRoleId: sales, ownerRole: 'sales', divisionId: fixture.divisionId,
      runs: 4, followedRuns: 2, followedShare: 0.5, ageDays: 0, stale: false });

  // A window of sixty days takes in the old run.
  const wider = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId, { windowDays: 60 }));
  assert.equal(wider.windowDays, 60);
  assert.deepEqual([wider.processes[0]!.runs, wider.processes[0]!.followedRuns], [5, 3]);

  // Not changed in a hundred days: its age says so, and the chart marks it.
  await withControlPlane((tx) => tx.query(
    "UPDATE skill_versions SET activated_at = now() - interval '100 days' WHERE skill_id = $1 AND state = 'active'", [skillId]));
  const structure = await structureOf(fixture.companyId);
  const charted = structure.coreProcesses.processes[0]!;
  assert.equal(charted.ageDays, 100);
  assert.equal(charted.stale, true);
  assert.equal(charted.followedShare, 0.5);

  // Its seat moved to the other division: that division's run is the one counted.
  await setCore(fixture, skillId, elsewhere.roleId);
  const moved = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId));
  assert.deepEqual([moved.processes[0]!.runs, moved.processes[0]!.followedShare], [1, 1]);
  // A seat whose division ran nothing has no share, rather than a share of none.
  const lab = await otherDivision(fixture, 'lab');
  await grantRead(fixture, lab.divisionId);
  await setCore(fixture, skillId, lab.roleId);
  const idle = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId));
  assert.deepEqual([idle.processes[0]!.runs, idle.processes[0]!.followedShare], [0, null]);

  await assert.rejects(withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId, { windowDays: 0 })),
    /a window is 1 to 366 whole days; 0 was asked for/);
});

test('a process longer than sixty lines is warned of, and kept', async () => {
  const fixture = await createCompany('core-long');
  const skillId = await activeSkill(fixture, 'onboarding', { steps: 61 });
  await setCore(fixture, skillId, fixture.roleId);
  await grantRead(fixture, fixture.divisionId);
  const report = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId));
  assert.equal(report.processes[0]!.lines, 63, 'the heading, its blank line and sixty-one steps');
  assert.deepEqual(report.warnings, [
    { kind: 'fewer_than_five', count: 1 },
    { kind: 'longer_than_sixty_lines', slug: 'onboarding', lines: 63 },
  ]);
});

test('every run of the owning seat is told the core processes it owns, and other seats are not', async () => {
  const fixture = await createCompany('core-context');
  const sales = await addRole(fixture, 'sales');
  const skillId = await activeSkill(fixture, 'sales-process', { scope: 'company' });
  await activeSkill(fixture, 'refunds', { scope: 'company' });
  await setCore(fixture, skillId, sales);

  const pack = async (roleId: string) => {
    const taskId = await ranTask(fixture, roleId, fixture.divisionId);
    const context = await withTenant(fixture.companyId, (tx) =>
      buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId }));
    return context.sections.find((section) => section.kind === 'role_charter')!.body;
  };
  const unread = await pack(sales);
  assert.match(unread, /- sales-process \(v1\)/);
  assert.match(unread, /Your division cannot open them with skill\.read, so work from these summaries/,
    'a run is not told to call what its division was not granted');
  assert.doesNotMatch(unread, /Read it with skill\.read/);

  await registerStandardCatalogue();
  await grantCapability(fixture, 'skill.read');
  const owner = await pack(sales);
  assert.match(owner, /Your seat owns these core processes/);
  assert.match(owner, /- sales-process \(v1\): How the company does sales-process, step by step\./);
  assert.match(owner, /Read it with skill\.read before you do that work/);
  assert.doesNotMatch(owner, /refunds/, 'a skill that is not core is in the skills list, not the seat\'s');
  assert.doesNotMatch(await pack(fixture.roleId), /core process/, 'a seat that owns none is told nothing of them');
});

test('a core process stays where its seat can read it', async () => {
  const fixture = await createCompany('core-scope');
  const elsewhere = await otherDivision(fixture, 'support');
  const skillId = await activeSkill(fixture, 'sales-process', { scope: 'company' });
  await setCore(fixture, skillId, fixture.roleId);

  await assert.rejects(
    setSkillScope(fixture.companyId, skillId, { scopeType: 'division', scopeId: elsewhere.divisionId }, { ownerApproved: true }),
    /sales-process is a core process owned by worker, whose division could no longer read it/);
  await setSkillScope(fixture.companyId, skillId, { scopeType: 'division', scopeId: fixture.divisionId }, { ownerApproved: true });
});

test('an exported and imported company keeps its core processes and their seats', async () => {
  const fixture = await createCompany('core-archive');
  const sales = await addRole(fixture, 'sales');
  const skillId = await activeSkill(fixture, 'sales-process');
  await setCore(fixture, skillId, sales);
  await activeSkill(fixture, 'refunds');

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => {
    lines.push(line);
  });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const report = await withTenant(restored.companyId, (tx) => coreProcessesOf(tx, restored.companyId));
  assert.deepEqual(report.processes.map((one) => [one.slug, one.ownerRole]), [['sales-process', 'sales']]);
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ id: string }>(
    "SELECT id FROM roles WHERE slug = 'sales'"));
  assert.equal(report.processes[0]!.ownerRoleId, rows[0]!.id, 'the seat is the restored company\'s own');
});

test('a process its seat\'s division cannot open has no share, and the owner is told why', async () => {
  const fixture = await createCompany('core-unreadable');
  const skillId = await activeSkill(fixture, 'sales-process', { scope: 'company' });
  await ranTask(fixture, fixture.roleId, fixture.divisionId);
  await ranTask(fixture, fixture.roleId, fixture.divisionId);

  // Marked for a seat whose division holds no skill.read, as the lab and
  // assurance are left: marked, and warned of on the answer, since no run
  // there can ever open it and a share of none would blame the runs.
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const marked = await api.call('POST', `/api/companies/${fixture.companyId}/skills/${skillId}/core`, token,
      { core: true, roleId: fixture.roleId });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    assert.deepEqual(marked.body.warnings, [
      { kind: 'fewer_than_five', count: 1 },
      { kind: 'division_cannot_read', slug: 'sales-process', roleId: fixture.roleId },
    ]);
  } finally {
    await api.close();
  }
  const unreadable = (await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId))).processes[0]!;
  assert.deepEqual(
    [unreadable.divisionCanRead, unreadable.runs, unreadable.followedRuns, unreadable.followedShare],
    [false, 2, 0, null], 'two runs, none of which could read it: no share, rather than none of two');

  // Granted, the same two runs are a share of nothing, and nothing is warned.
  await grantRead(fixture, fixture.divisionId);
  const report = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId));
  assert.deepEqual([report.processes[0]!.divisionCanRead, report.processes[0]!.followedShare], [true, 0]);
  assert.deepEqual(report.warnings, [{ kind: 'fewer_than_five', count: 1 }]);
});

test('a core process brought back under quarantine is not put to its seat, and the chart says so', async () => {
  const fixture = await createCompany('core-quarantined');
  const sales = await addRole(fixture, 'sales');
  const skillId = await activeSkill(fixture, 'sales-process');
  await grantRead(fixture, fixture.divisionId);
  await setCore(fixture, skillId, sales);
  const taskId = await ranTask(fixture, sales, fixture.divisionId);
  assert.match(await charterOf(fixture.companyId, fixture.divisionId, taskId), /- sales-process \(v1\)/);

  // An unsigned document arrives under the same name: the skill is now
  // external and quarantined, and still marked core, since marking was the
  // owner's and an import is not.
  const imported = await importExternalSkill({
    companyId: fixture.companyId, slug: 'sales-process', divisionId: fixture.divisionId,
    source: skillText('sales-process', 4), origin: 'https://hub.example/sales-process',
  });
  assert.equal(imported.quarantined, true);
  const charter = await charterOf(fixture.companyId, fixture.divisionId, taskId);
  assert.doesNotMatch(charter, /core process/,
    'a procedure nobody here vouched for is not put in the charter with the instruction to follow it');

  const report = await withTenant(fixture.companyId, (tx) => coreProcessesOf(tx, fixture.companyId));
  const process = report.processes[0]!;
  assert.deepEqual([process.slug, process.quarantined, process.inForce, process.followedShare], ['sales-process', true, false, null]);
  assert.deepEqual(report.warnings, [
    { kind: 'fewer_than_five', count: 1 },
    { kind: 'not_in_force', slug: 'sales-process', reason: 'quarantined' },
  ]);
});

test('an outside process restored from an archive waits for its gates before its seat is told to follow it', async () => {
  const fixture = await createCompany('core-regated');
  const sales = await addRole(fixture, 'sales');
  const skillId = await activeSkill(fixture, 'sales-process', { scope: 'company' });
  // As one signed by a publisher this installation trusts arrives: from
  // outside, and not quarantined.
  await withControlPlane((tx) => tx.query(
    "UPDATE skills SET provenance = 'external', origin = 'https://hub.example/sales-process' WHERE id = $1", [skillId]));
  await grantRead(fixture, fixture.divisionId);
  await setCore(fixture, skillId, sales);
  await ranTask(fixture, sales, fixture.divisionId);

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => {
    lines.push(line);
  });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { rows } = await withTenant(restored.companyId, (tx) => tx.query<{ id: string; division_id: string }>(
    "SELECT t.id, t.division_id FROM tasks t JOIN roles r ON r.id = t.role_id WHERE r.slug = 'sales'"));
  const task = rows[0]!;

  // Its versions came back as candidates (F15.8), and the mark with them.
  const charter = await charterOf(restored.companyId, task.division_id, task.id);
  assert.doesNotMatch(charter, /core process/);
  const report = await withTenant(restored.companyId, (tx) => coreProcessesOf(tx, restored.companyId));
  assert.deepEqual([report.processes[0]!.inForce, report.processes[0]!.followedShare], [false, null]);
  assert.deepEqual(report.warnings, [
    { kind: 'fewer_than_five', count: 1 },
    { kind: 'not_in_force', slug: 'sales-process', reason: 'not_active' },
  ]);
});
