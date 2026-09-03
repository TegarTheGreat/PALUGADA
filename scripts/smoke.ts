/**
 * Boots PALUGADA and watches a company do one piece of work.
 *
 * Every acceptance test drives a part. This drives the whole thing the way an
 * operator would: seed the installation, build a company from the standard
 * template, register a runtime, start the worker, put a task in front of it,
 * and wait. It is the difference between "the tick function returns the right
 * shape" and "the platform runs".
 *
 * It uses the in-process runtime and a handler that calls no model, because
 * what is under test here is the *orchestration* — claim, lease, run, contract,
 * transition, settle — and a real provider would add a network dependency to
 * a check whose whole purpose is to be runnable anywhere.
 *
 * Destructive: it creates a company with a timestamped slug and leaves it
 * behind, so run it against a development database. It exits non-zero if the
 * task does not reach `completed`, which makes it usable as a deploy check.
 */
import { randomUUID } from 'node:crypto';
import { CapabilityBroker } from '../src/broker/broker.ts';
import { Engine, type TaskContext } from '../src/engine/engine.ts';
import { RecordingLlmClient } from '../src/llm/client.ts';
import { Worker } from '../src/worker.ts';
import { baseRegistry, seed } from '../src/seed.ts';
import {
  createCompanyFromTemplate,
  saveTemplate,
  type CompanyTemplate,
} from '../src/templates/company.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../src/templates/standard.ts';
import { createRootTask, getTask } from '../src/engine/tasks.ts';
import { withTenant, withControlPlane } from '../src/db/tenant.ts';
import { closePools } from '../src/db/pool.ts';

const DEADLINE_MS = 30_000;

/**
 * The company this check builds, and why it is not the standard one.
 *
 * The standard template grants twenty-seven capabilities. Twenty-five of them
 * are catalogue *declarations* -- `src/broker/catalogue.ts` is a tier
 * calibration and deliberately does not write itself into the `capabilities`
 * table, because a row there means the broker can run the thing and F8.4 wants
 * a read-back for anything above tier 0. So a freshly seeded installation
 * cannot build a standard company until an operator binds real adapters, and
 * that is correct rather than a gap.
 *
 * Which makes it the wrong template for a boot check. This one grants only
 * what PALUGADA implements itself, so it runs on an installation that has just
 * been migrated and seeded and nothing else -- which is the situation the check
 * exists for. The first two times this script ran it used the standard
 * template and passed, on catalogue rows the test suite had left in the
 * database: it was testing the last thing that wrote one, exactly as one of the
 * regression tests it produced had been. What the standard template would still
 * need is reported below rather than hidden.
 */
const SMOKE_TEMPLATE: CompanyTemplate = {
  projects: [{ slug: 'main', name: 'Main' }],
  goals: [
    {
      slug: 'mission',
      kind: 'mission',
      statement: 'Answer what this company knows, and say so plainly.',
    },
  ],
  divisions: [{ slug: 'ops', name: 'Operations', maxConcurrency: 2 }],
  roles: [
    {
      slug: 'coordinator',
      division: 'ops',
      systemPrompt: 'You look things up in this company and report what you found.',
      model: 'standard',
      tools: ['memory.search', 'skill.read'],
      doneCriteria: ['the answer says what was looked for and what was found'],
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['summary'],
        properties: { summary: { type: 'string', minLength: 1 } },
      },
    },
  ],
  grants: [
    { division: 'ops', capability: 'memory.search' },
    { division: 'ops', capability: 'skill.read' },
  ],
  // A division ceiling under the company's, so the boot exercises F1.6's
  // lookup rather than the one account every company used to have.
  budget: {
    tokensMax: 200_000,
    moneyMaxCents: 20_000,
    divisions: [{ division: 'ops', tokensMax: 50_000, moneyMaxCents: 5_000 }],
  },
};

const SMOKE_TEMPLATE_SLUG = 'smoke-company';

/** What the standard template still needs before it can build a company here. */
async function unboundStandardGrants(): Promise<string[]> {
  const wanted = [...new Set(
    (STANDARD_COMPANY_TEMPLATE.grants ?? []).map((grant) => grant.capability),
  )];
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ name: string }>(
      'SELECT name FROM capabilities WHERE name = ANY($1::text[])',
      [wanted],
    );
    const bound = new Set(rows.map((row) => row.name));
    return wanted.filter((name) => !bound.has(name));
  });
}

function log(step: string, detail: string): void {
  process.stdout.write(`  ${step.padEnd(22)} ${detail}\n`);
}

async function main(): Promise<number> {
  process.stdout.write('\nPALUGADA smoke run\n\n');

  const seeded = await seed();
  log('seeded', `${seeded.bundles.length} bundles, template ${seeded.template}`);
  for (const bundle of seeded.bundles) {
    log('', `  ${bundle.slug}@${bundle.version} ${bundle.trusted ? 'trusted' : 'untrusted'}`);
  }

  // The registry a deployment starts from: what the platform implements
  // itself. Nothing external is bound, which is why the handler below acts
  // through `memory.search` rather than through anything that leaves the
  // machine. Synced before the company is built, because
  // `createCompanyFromTemplate` refuses to grant a capability the broker
  // cannot run.
  const registry = baseRegistry();
  await registry.sync();

  await saveTemplate({
    slug: SMOKE_TEMPLATE_SLUG,
    name: 'Smoke company',
    description: 'One division that uses only what the platform implements itself.',
    body: SMOKE_TEMPLATE,
  });

  const slug = `smoke-${Date.now().toString(36)}`;
  const company = await createCompanyFromTemplate({
    templateSlug: SMOKE_TEMPLATE_SLUG,
    companySlug: slug,
    name: 'Smoke Run',
  });
  log('company built', `${slug} — ${Object.keys(company.divisionIds).length} division, ` +
    `${Object.keys(company.roleIds).length} role`);

  const unbound = await unboundStandardGrants();
  log(
    'standard template',
    unbound.length === 0
      ? 'every capability it grants is bound here'
      : `${unbound.length} capabilities still need an adapter: ${unbound.join(', ')}`,
  );

  // Named rather than taken as whichever key came first, so a change to the
  // template above fails loudly here instead of quietly running something else.
  const roleSlug = 'coordinator';
  const divisionSlug = 'ops';
  const roleId = company.roleIds[roleSlug];
  const divisionId = company.divisionIds[divisionSlug];
  if (!roleId || !divisionId) {
    throw new Error(
      `SMOKE_TEMPLATE no longer has ${divisionSlug}/${roleSlug}; this check needs updating`,
    );
  }

  const handler = async (ctx: TaskContext) => {
    const found = await ctx.callCapability<{ query: string }, { facts: unknown[] }>(
      'memory.search',
      { query: 'anything' },
    );
    return {
      summary: `Looked for what this company knows and found ${found.facts.length} facts.`,
    };
  };

  const engine = new Engine({
    broker: new CapabilityBroker(registry),
    llm: new RecordingLlmClient(),
    handlers: new Map([[roleSlug, handler]]),
    workerId: `smoke-${randomUUID().slice(0, 8)}`,
  });

  const shutdown = new AbortController();
  const worker = new Worker({
    engine,
    companyId: company.companyId,
    idleMs: 250,
    signal: shutdown.signal,
    onTickError: (error) => log('tick failed', error.message),
  });

  const running = worker.start();
  log('worker started', `id ${engine.workerId}, role ${roleSlug}`);

  // No budgetAccountId: F1.6 says the narrowest account that covers this task,
  // which for a task in ops is the ops account rather than the company's. Left
  // to the lookup here on purpose -- it is the wiring that was missing, so a
  // boot check that named the account by hand would step over it.
  const task = await createRootTask({
    companyId: company.companyId,
    projectId: Object.values(company.projectIds)[0]!,
    divisionId,
    roleId,
    goalId: Object.values(company.goalIds)[0]!,
    input: { goal: 'Say what this company knows.' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
  const fundedBy = task.budgetAccountId === company.budgetAccountId
    ? 'the company account'
    : `the ${divisionSlug} account`;
  log('task created', `${task.id} — funded by ${fundedBy}`);

  const startedAt = Date.now();
  let final: Awaited<ReturnType<typeof getTask>> = null;
  while (Date.now() - startedAt < DEADLINE_MS) {
    final = await withTenant(company.companyId, (tx) => getTask(tx, task.id));
    if (final && ['completed', 'failed', 'halted', 'cancelled'].includes(final.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  shutdown.abort();
  await running;
  log('worker stopped', `after ${Math.round((Date.now() - startedAt) / 100) / 10}s`);

  if (!final) {
    log('RESULT', 'the task vanished');
    return 1;
  }

  log('task status', final.status + (final.haltReason ? ` (${final.haltReason})` : ''));
  if (final.output) log('task output', JSON.stringify(final.output));

  // What the run left behind, which is the part an operator actually reads.
  const trail = await withTenant(company.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string; count: string }>(
      `SELECT type, count(*)::text AS count FROM events WHERE task_id = $1
        GROUP BY type ORDER BY min(occurred_at)`,
      [task.id],
    );
    return rows;
  });
  log('audit trail', trail.map((row) => `${row.type}×${row.count}`).join(', '));

  return final.status === 'completed' ? 0 : 1;
}

const code = await main().catch((error: unknown) => {
  process.stderr.write(`\nsmoke run failed: ${(error as Error).stack ?? error}\n`);
  return 1;
});
await closePools();
process.stdout.write(code === 0 ? '\nOK\n\n' : '\nFAILED\n\n');
process.exit(code);
