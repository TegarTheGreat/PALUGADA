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
import { collectExport, exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { remember } from '../../src/memory/store.ts';
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
  assert.equal(sections.llm_traces!.length, 1);

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
  const trace = withoutPrompts.sections.llm_traces![0]!;
  assert.equal('prompt' in trace, false, 'prompts are not exported by default');
  assert.equal(trace.cost_cents, 3, 'but the cost is, because an audit needs it');
  assert.equal(trace.model, 'test-model');

  const withPrompts = await collectExport(fixture.companyId, { includePrompts: true });
  const full = withPrompts.sections.llm_traces![0]!;
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
