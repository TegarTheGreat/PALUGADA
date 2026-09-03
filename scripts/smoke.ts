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
import { createCompanyFromTemplate } from '../src/templates/company.ts';
import { STANDARD_TEMPLATE_SLUG } from '../src/templates/standard.ts';
import { createRootTask, getTask } from '../src/engine/tasks.ts';
import { withTenant } from '../src/db/tenant.ts';
import { closePools } from '../src/db/pool.ts';

const DEADLINE_MS = 30_000;

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

  const slug = `smoke-${Date.now().toString(36)}`;
  const company = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG,
    companySlug: slug,
    name: 'Smoke Run',
  });
  log('company built', `${slug} — ${Object.keys(company.divisionIds).length} divisions, ` +
    `${Object.keys(company.roleIds).length} roles`);

  // The registry a deployment starts from: what the platform implements
  // itself. Nothing external is bound, which is why the handler below acts
  // through `memory.search` rather than through anything that leaves the
  // machine.
  const registry = baseRegistry();
  await registry.sync();

  // Named rather than taken as whichever key came first. Two divisions hold no
  // platform grant on purpose — the lab, which runs supplied code, and
  // assurance, whose reviewer holds none at all by F7.3 — so a boot check that
  // depended on object key order could land on one of them and report a
  // correct refusal as a broken platform.
  const roleSlug = 'coordinator';
  const divisionSlug = 'ops';
  const roleId = company.roleIds[roleSlug];
  const divisionId = company.divisionIds[divisionSlug];
  if (!roleId || !divisionId) {
    throw new Error(
      `the standard template no longer has ${divisionSlug}/${roleSlug}; this check needs updating`,
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

  const task = await createRootTask({
    companyId: company.companyId,
    projectId: Object.values(company.projectIds)[0]!,
    divisionId,
    roleId,
    budgetAccountId: company.budgetAccountId,
    goalId: Object.values(company.goalIds)[0]!,
    input: { goal: 'Say what this company knows.' },
    createdBy: 'owner',
    reserveTokens: 5_000,
  });
  log('task created', task.id);

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
