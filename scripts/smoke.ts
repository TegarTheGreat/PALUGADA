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
import type { CapabilityRegistry } from '../src/broker/registry.ts';
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
import { raiseIncident, requestApproval, decide, listOpen } from '../src/inbox/inbox.ts';
import { registerPlatformCapabilities } from '../src/capabilities/platform.ts';
import { InMemorySecretManager } from '../src/secrets/manager.ts';
import {
  OwnerMfa,
  decodeBase32,
  newTotpSecret,
  stepFor,
  totpCode,
} from '../src/owner/mfa.ts';
import type { OwnerChannel } from '../src/owner/notify.ts';

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
/**
 * What the standard template grants and this process cannot actually do.
 *
 * Read from the registry rather than from the `capabilities` table, because
 * they answer different questions and only one of them is the one that
 * matters. A row in the table means the name exists and may be granted; an
 * entry in the registry means an adapter will answer when a role calls it. A
 * name with a row and no adapter is grantable and unusable, which is the
 * failure this check exists to find rather than a state it should count as
 * bound.
 */
function unboundStandardGrants(registry: CapabilityRegistry): string[] {
  const wanted = [...new Set(
    (STANDARD_COMPANY_TEMPLATE.grants ?? []).map((grant) => grant.capability),
  )];
  return wanted.filter((name) => registry.get(name) === undefined);
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

  // The five the platform implements itself, bound before the count so the
  // count means what it says. `files.list` gets a temporary root and the
  // drafting pair the same recording client the run already uses: this is a
  // boot check, and what it is checking is that the wiring exists.
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const filesRoot = await mkdtemp(`${tmpdir()}/palugada-smoke-files-`);
  const bound = await registerPlatformCapabilities(registry, {
    files: { root: filesRoot },
    llm: new RecordingLlmClient(),
  });
  log('platform capabilities', bound.join(', '));

  // And the example vendor file, which is what an operator copies. A broken
  // example is a broken first hour, and this is the boot check -- so it is
  // read here rather than trusted, and the names it binds come off the count
  // below like any other binding.
  //
  // Deliberately *not* synced to the `capabilities` table. A row there is what
  // authorises a grant, and this is a boot check on a database somebody else
  // will use next: writing `email.send` into it would leave a later deployment
  // -- one started without a vendor file -- able to grant a capability nothing
  // answers, which is the exact "grantable and unusable" state the count below
  // exists to report.
  const { registerVendorCapabilities } = await import('../src/capabilities/vendors.ts');
  const fromFile = await registerVendorCapabilities(registry, 'config/vendors.example.json');
  log('vendor file', `config/vendors.example.json binds ${fromFile.join(', ')}`);

  const unbound = unboundStandardGrants(registry);
  log(
    'standard template',
    unbound.length === 0
      ? 'every capability it grants is bound here'
      : `${unbound.length} still need a vendor: ${unbound.join(', ')}`,
  );
  // The five are not among them, which is the assertion: a capability the
  // platform implements and forgets to register is one a role is refused for
  // at the moment it tries to work.
  for (const name of [...bound, ...fromFile]) {
    if (unbound.includes(name)) {
      log('RESULT', `${name} is implemented and not registered`);
      return 1;
    }
  }

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

  // F10.5, F10.9. A channel that records rather than one that posts: no push
  // service and no bot exist here, and what this boot check is for is the
  // wiring -- whether a tick reaches a channel at all. That is the failure
  // this repository has found in itself more often than any other, and it is
  // invisible to a unit test of the channel.
  const notified: string[] = [];
  const recordingChannel: OwnerChannel = {
    name: 'smoke:recorder',
    carries: () => true,
    async deliver(item) {
      notified.push(`${item.kind}:${item.delivery}`);
      return {};
    },
  };

  const shutdown = new AbortController();
  const worker = new Worker({
    engine,
    companyId: company.companyId,
    idleMs: 250,
    signal: shutdown.signal,
    ownerChannels: [recordingChannel],
    ownerLinkFor: (item) => `https://app.palugada.local/i/${item.id}`,
    onTickError: (error) => log('tick failed', error.message),
  });

  const running = worker.start();
  log('worker started', `id ${engine.workerId}, role ${roleSlug}`);

  // No budgetAccountId: F1.6 says the narrowest account that covers this task,
  // which for a task in ops is the ops account rather than the company's. Left
  // to the lookup here on purpose -- it is the wiring that was missing, so a
  // boot check that named the account by hand would step over it.
  // Something for the owner to be told about, raised before the task so the
  // first tick has both to do.
  await raiseIncident({
    companyId: company.companyId,
    title: 'A smoke incident, so the notifier has something to carry',
    detail: 'Raised by the boot check.',
  });

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

  // Waits for *both* things this check is about, not just the faster one.
  //
  // The first version stopped the worker as soon as the task was terminal --
  // and the task usually finishes on the first tick, while the notification is
  // a later stage of that same tick. So `shutdown.abort()` cut the tick before
  // the channel was reached, and the boot check failed with "the tick never
  // reached the owner channel" perhaps one run in three. A check that fails
  // for its own reasons is a check people learn to re-run rather than read.
  const startedAt = Date.now();
  let final: Awaited<ReturnType<typeof getTask>> = null;
  while (Date.now() - startedAt < DEADLINE_MS) {
    final = await withTenant(company.companyId, (tx) => getTask(tx, task.id));
    const done = final && ['completed', 'failed', 'halted', 'cancelled'].includes(final.status);
    if (done && notified.length > 0) break;
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

  // F10.10 and F12.5, end to end. The same reason the notifier is checked
  // here: `OwnerMfa` is constructed by whoever assembles a deployment, and a
  // verifier nobody builds is a tier 3 gate that refuses everything -- which
  // looks exactly like the gate working until the day the owner needs to
  // approve something.
  //
  // The reference is unique per run and the row is revoked at the end.
  //
  // The first version used `vault://smoke/totp` every time and left the row
  // behind, and `owner_authenticators` is control-plane data that survives --
  // so the second run enrolled a *second* row against the same reference,
  // which resolves to whichever secret the current process holds. Both rows
  // matched the code, the older one was tried first, and its step was already
  // claimed: the boot check failed with "that code has already been used".
  //
  // Which was the check earning its keep. The fix is in two places, because
  // there were two faults: this one polluted a shared database, and the
  // platform let two authenticators share a secret at all -- see `enrolTotp`.
  const secretRef = `vault://smoke/${randomUUID()}`;
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('smoke owner');
  secrets.set(secretRef, secret);
  const mfa = new OwnerMfa({ secrets, rpId: 'palugada.local' });
  const authenticatorId = await mfa.enrolTotp({ label: 'smoke owner', secretRef });

  const approvalId = await requestApproval({
    companyId: company.companyId,
    capabilityName: 'smoke.irreversible',
    tier: 3,
    actionSummary: 'Something that cannot be undone',
    rationale: 'The boot check asked for it.',
    consequenceIfDenied: 'Nothing happens.',
  });

  // Refused without a factor, which is the half that matters: a deployment
  // that has not set MFA up should find that irreversible actions wait.
  let refused = false;
  await decide(company.companyId, approvalId, 'approve', '', { channel: 'app' })
    .catch(() => { refused = true; });

  await decide(company.companyId, approvalId, 'approve', 'boot check', {
    channel: 'app',
    proof: { totp: totpCode(decodeBase32(secret), stepFor(new Date())) },
    mfa,
  });
  const stillOpen = (await listOpen(company.companyId)).some((item) => item.id === approvalId);

  // Revoked whatever the verdict below is, so a failing boot check does not
  // also leave a row that breaks the next one.
  await mfa.revoke(authenticatorId);

  log('tier 3 approval', refused && !stillOpen
    ? 'refused without a factor, accepted with one'
    : 'WRONG');
  if (!refused || stillOpen) {
    log('RESULT', 'the tier 3 gate did not behave');
    return 1;
  }

  // The wiring check. A notifier that is configured and never reached is the
  // shape of defect this file exists to catch, so it is a failure rather than
  // a note.
  log('owner notified', notified.length > 0 ? notified.join(', ') : 'NOTHING');
  if (notified.length === 0) {
    log('RESULT', 'the tick never reached the owner channel');
    return 1;
  }

  return final.status === 'completed' ? 0 : 1;
}

const code = await main().catch((error: unknown) => {
  process.stderr.write(`\nsmoke run failed: ${(error as Error).stack ?? error}\n`);
  return 1;
});
await closePools();
process.stdout.write(code === 0 ? '\nOK\n\n' : '\nFAILED\n\n');
process.exit(code);
