/**
 * PRD F11.6, F1.5 -- audit and company export.
 *
 * One archive serves both: F11.6 wants an export for legal and accounting,
 * F1.5 wants a company's full state, events and memory as an archive. The
 * tests care most about two things an export must never get wrong -- it must
 * not reach another tenant's rows, and it must not carry a secret.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  collectExport,
  exportCompany,
  EXPORT_SECTION_NAMES,
  type ArchiveLine,
} from '../../src/audit/export.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { remember } from '../../src/memory/store.ts';
import {
  importCompany,
  IMPORT_SECTION_NAMES,
  NOT_RESTORED,
} from '../../src/audit/import.ts';
import { putPolicy } from '../../src/governance/store.ts';
import { setSpendLimit } from '../../src/governance/spend-guard.ts';
import { setRetention } from '../../src/retention/retention.ts';
import { setBatchWindow, capabilityWindow } from '../../src/scheduler/windows.ts';
import { evaluate } from '../../src/policy/engine.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const SECRET_VALUE = 'super-secret-token-value-9999';

/** Gives a company enough history that an export has something to carry. */
async function seedCompany(fixture: Fixture, marker: string): Promise<string> {
  const capability: Capability<{ target: string }, { ok: boolean }> = {
    name: 'deploy.staging',
    adapter: 'test:deploy',
    defaultTier: 1,
    async execute() {
      return { ok: true };
    },
    async verify() {
      return true;
    },
  };
  const registry = new CapabilityRegistry();
  registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'deploy.staging');

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(() => `plan for ${marker}`),
    handlers: new Map([
      ['worker', async (ctx) => {
        const plan = await ctx.llm({
          system: 'You are a worker.',
          messages: [{ role: 'user', content: marker }],
        });
        await ctx.callCapability('deploy.staging', { target: marker });
        return { plan };
      }],
    ]),
  });

  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { marker },
    createdBy: 'owner',
    reserveTokens: 50_000,
  });
  await engine.runTask(fixture.companyId, task.id, 'worker');

  await withTenant(fixture.companyId, async (tx) => {
    await remember(tx, {
      companyId: fixture.companyId,
      memoryType: 'semantic',
      scopeType: 'division',
      scopeId: fixture.divisionId,
      body: `a fact belonging to ${marker}`,
    });
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', $3)`,
      [fixture.companyId, fixture.divisionId, `vault://${marker}/dns-token`],
    );
    await tx.query(
      `INSERT INTO llm_traces (id, company_id, model, prompt, response,
                               input_tokens, output_tokens, cost_cents)
       VALUES ($1, $2, 'test-model', $3::jsonb, '{}'::jsonb, 10, 5, 3)`,
      [`trace-${marker}`, fixture.companyId, JSON.stringify({ text: `prompt for ${marker}` })],
    );
  });

  return task.id;
}

test('an export carries the company\'s whole history (F1.5, F11.6)', async () => {
  const fixture = await createCompany('export-full');
  await seedCompany(fixture, 'alpha');

  const { summary, sections } = await collectExport(fixture.companyId);

  assert.equal(summary.companyId, fixture.companyId);
  assert.equal(summary.companySlug, fixture.slug);
  assert.ok(Date.parse(summary.exportedAt) > 0);

  // State, events and memory, which is what F1.5 names.
  assert.equal(sections.company!.length, 1);
  assert.equal(sections.projects!.length, 1);
  assert.equal(sections.divisions!.length, 1);
  assert.equal(sections.roles!.length, 1);
  assert.equal(sections.tasks!.length, 1);
  assert.ok(sections.task_steps!.length >= 2);
  assert.ok(sections.events!.length >= 3);
  assert.equal(sections.memories!.length, 1);
  assert.equal(sections.credentials!.length, 1);
  // Two: the one this fixture seeds by hand, and the one the engine wrote for
  // the model call the run actually made. F11.1 traces every call now that the
  // runtime reports its usage, so a run that thinks leaves a trace behind.
  assert.equal(sections.llm_traces!.length, 2);

  // The counts in the summary match what was actually written out, so a
  // truncated archive cannot report itself as complete.
  for (const [section, rows] of Object.entries(sections)) {
    assert.equal(summary.counts[section], rows.length, `count mismatch for ${section}`);
  }
});

test('an export never carries a secret value', async () => {
  const fixture = await createCompany('export-secrets');
  await seedCompany(fixture, 'beta');

  const lines: ArchiveLine[] = [];
  await exportCompany(
    fixture.companyId,
    (line) => {
      lines.push(line);
    },
    { includePrompts: true },
  );

  const serialised = JSON.stringify(lines);
  assert.equal(
    serialised.includes(SECRET_VALUE),
    false,
    'no secret value may appear in an archive',
  );

  // What it does carry is the reference, which is a path rather than a secret.
  const credentials = lines.filter((line) => line.section === 'credentials');
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]!.row.secret_ref, 'vault://beta/dns-token');
  assert.ok('version' in credentials[0]!.row, 'the rotation version travels with it');
});

test('prompts are excluded by default and included on request', async () => {
  // An audit export usually has to show that a call happened and what it cost,
  // not what was said. The smaller archive is the safer one to hand over, so
  // it is the default rather than the option.
  const fixture = await createCompany('export-prompts');
  await seedCompany(fixture, 'gamma');

  const withoutPrompts = await collectExport(fixture.companyId);
  // Found by id: the engine's own trace for this run carries the same model
  // name, and picking by model would silently test the wrong row.
  const seeded = withoutPrompts.sections.llm_traces!.find((row) => row.id === 'trace-gamma')!;
  assert.equal('prompt' in seeded, false, 'prompts are not exported by default');
  assert.equal(seeded.cost_cents, 3, 'but the cost is, because an audit needs it');

  const withPrompts = await collectExport(fixture.companyId, { includePrompts: true });
  const full = withPrompts.sections.llm_traces!.find((row) => row.id === 'trace-gamma')!;
  assert.deepEqual(full.prompt, { text: 'prompt for gamma' });
});

test('an export cannot reach another tenant', async () => {
  // The export runs inside the company's own scope rather than on the control
  // plane, so row-level security constrains it like everything else. A
  // BYPASSRLS export would be simpler and would mean a mistake in one table
  // list could quietly include another tenant -- the one error an audit export
  // must not be able to make.
  const mine = await createCompany('export-mine');
  const theirs = await createCompany('export-theirs');
  await seedCompany(mine, 'mine');
  await seedCompany(theirs, 'theirs');

  const { sections } = await collectExport(mine.companyId, { includePrompts: true });
  const serialised = JSON.stringify(sections);

  assert.equal(serialised.includes('theirs'), false, "no trace of the other tenant's data");
  assert.equal(sections.tasks!.length, 1);
  assert.deepEqual(sections.company!.map((row) => row.slug), [mine.slug]);
  assert.equal(sections.memories!.length, 1);
  assert.match(String(sections.memories![0]!.body), /belonging to mine/);
});

test('the export streams rather than assembling everything first', async () => {
  // An export exists partly for the company with years of history, and an
  // exporter that has to hold all of it in memory fails exactly then.
  const fixture = await createCompany('export-streaming');
  await seedCompany(fixture, 'delta');

  let seenBeforeSummaryResolved = 0;
  let summaryResolved = false;

  const summary = await exportCompany(fixture.companyId, () => {
    if (!summaryResolved) seenBeforeSummaryResolved += 1;
  });
  summaryResolved = true;

  assert.ok(
    seenBeforeSummaryResolved > 0,
    'rows reach the writer while the export is still running',
  );
  const total = Object.values(summary.counts).reduce((sum, count) => sum + count, 0);
  assert.equal(seenBeforeSummaryResolved, total);
});

test('exporting a company that does not exist fails loudly', async () => {
  // The failure mode worth ruling out is a plausible empty archive: one that
  // reads as "that company had no history" when the truth is "that company was
  // never found". An auditor cannot tell those apart from the file.
  await assert.rejects(
    () => exportCompany('00000000-0000-0000-0000-000000000000', () => undefined),
    /not found, or not visible in this scope/,
  );
});

/**
 * An archive that restores a company without its rules is worse than none.
 *
 * F1.5 asks for a company's full state, events, memory, skills *and config*.
 * The archive carried `config_versions` — the history of every policy, charter
 * and role — and not the `policies` rows themselves, nor the spending ceiling,
 * the retention policy, the alert thresholds or the windows. A company restored
 * from it came up with a complete record of what its rules had been and nothing
 * requiring approval of anything.
 *
 * That is the worst shape a gap can take: silently permissive, on an archive
 * that reported itself complete. It was found by comparing the tables the
 * export reads against the tables the schema declares, which is a question
 * worth asking of any exporter.
 *
 * The test is deliberately not "the rows came across". It is that the restored
 * company *refuses what its policy refuses*, because that is the property an
 * owner is relying on and rows are only how it happens to be implemented.
 */
test('a restored company still refuses what its policy refused (F1.5, F3.3)', async () => {
  const fixture = await createCompany('export-config');
  await seedCompany(fixture, 'delta');

  await putPolicy({
    companyId: fixture.companyId,
    slug: 'production-needs-a-human',
    effect: 'require_approval',
    // A glob, not a regex: `matches` escapes every character but `*`, which
    // is what stops a configuration row causing catastrophic backtracking.
    condition: { op: 'matches', field: 'tool', value: 'deploy.*' },
  });
  await setSpendLimit(fixture.companyId, 44_400);
  await setRetention(fixture.companyId, { eventDays: 420 });
  await setBatchWindow({
    companyId: fixture.companyId,
    timezone: 'Asia/Jakarta',
    startHour: 1,
    endHour: 5,
  });
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO capability_windows (company_id, division_id, capability_name, timezone,
                                       start_hour, end_hour)
       VALUES ($1, $2, 'deploy.staging', 'Asia/Jakarta', 9, 17)`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => {
    lines.push(line);
  });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  assert.notEqual(restored.companyId, fixture.companyId);

  // The policy is in force, not merely present: asked the way the broker asks.
  const decision = await withTenant(restored.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM divisions LIMIT 1");
    return evaluate(tx, restored.companyId, rows[0]!.id, {
      tool: 'deploy.production',
      tier: 2,
      division: 'ops',
      money_cents: 0,
      recipient_domain: null,
      url_host: null,
      hour_local: 12,
      calls_in_window: 0,
    });
  });
  assert.equal(decision.effect, 'require_approval', 'a restored company that deploys freely');
  assert.ok(
    decision.matched.some((match) => match.slug === 'production-needs-a-human'),
    'and it is the owner\'s own rule that said so',
  );

  // The ceilings and the windows came with it. Each of these is a number the
  // owner chose and would otherwise have to choose again, silently reverting
  // to a platform default in the meantime.
  const config = await withTenant(restored.companyId, async (tx) => {
    const limit = await tx.query<{ money_max_cents: string }>(
      'SELECT money_max_cents FROM spend_limits WHERE company_id = $1',
      [restored.companyId],
    );
    const retention = await tx.query<{ event_days: number }>(
      'SELECT event_days FROM retention_policies WHERE company_id = $1',
      [restored.companyId],
    );
    const batch = await tx.query<{ timezone: string; start_hour: number }>(
      'SELECT timezone, start_hour FROM batch_windows WHERE company_id = $1',
      [restored.companyId],
    );
    const { rows: divisions } = await tx.query<{ id: string }>('SELECT id FROM divisions LIMIT 1');
    const window = await capabilityWindow(tx, divisions[0]!.id, 'deploy.staging');
    return {
      limit: limit.rows[0]?.money_max_cents,
      eventDays: retention.rows[0]?.event_days,
      batch: batch.rows[0],
      window,
    };
  });

  assert.equal(config.limit, '44400', 'the monthly ceiling the owner set');
  assert.equal(config.eventDays, 420);
  assert.deepEqual(config.batch, { timezone: 'Asia/Jakarta', start_hour: 1 });
  assert.equal(config.window?.startHour, 9, 'and the hours a deploy may happen in');

  // What deliberately does not travel: whether the source instance had this
  // company paused. A ceiling is the owner's decision and moves with them; a
  // pause is a fact about spending that has not happened here.
  const paused = await withTenant(restored.companyId, async (tx) => {
    const { rows } = await tx.query<{ paused_at: Date | null }>(
      'SELECT paused_at FROM spend_limits WHERE company_id = $1',
      [restored.companyId],
    );
    return rows[0]?.paused_at ?? null;
  });
  assert.equal(paused, null);
});

/**
 * The two lists differ by exactly what somebody decided to leave behind.
 *
 * This is the test that would have caught the whole problem. The export wrote
 * thirty-one sections and the import read twenty-four, and the seven-section
 * difference was not a decision — four of them were simply missing:
 * credentials, review requests, decision records and the governance log. The
 * review-request one was worse than an omission, because `skill_versions`
 * remapped a `review_request_id` against a section that was never imported, so
 * a restored skill version pointed at no review at all.
 *
 * Comparing the lists is a cheap, total check where reading two files and
 * hoping is not. The three that remain are named in `NOT_RESTORED` with their
 * reasons on the import's own SECTIONS, so adding a section without deciding
 * which side it belongs on now fails here.
 */
test('every exported section is restored, or is named as deliberately not (F1.5, F16.4)', () => {
  const exported = new Set(EXPORT_SECTION_NAMES);
  const imported = new Set(IMPORT_SECTION_NAMES);

  const missing = [...exported].filter(
    (name) => !imported.has(name) && !NOT_RESTORED.includes(name),
  );
  assert.deepEqual(missing, [], 'exported and silently not restored');

  const unexpected = [...imported].filter((name) => !exported.has(name));
  assert.deepEqual(unexpected, [], 'restored from a section nothing exports');

  // And the deliberate list is not a place to hide a section that should
  // travel: every name in it has to actually be exported.
  assert.deepEqual(
    NOT_RESTORED.filter((name) => !exported.has(name)),
    [],
    'named as not-restored but not exported either',
  );
});
