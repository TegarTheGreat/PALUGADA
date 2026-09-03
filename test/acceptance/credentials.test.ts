/**
 * PRD F12.1, F12.2, F12.4, F8.7 -- credentials.
 *
 * The claim under test is narrow and absolute: a secret value never reaches a
 * durable record or a model prompt. Storing only references is half of it;
 * the other half is that anything on its way to an event, a trace or a prompt
 * passes through redaction, because a secret reaches a log the first time
 * somebody writes an error message containing a request body.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  InMemorySecretManager,
  Redactor,
  redactor,
} from '../../src/secrets/manager.ts';
import { CachedSecretManager, rotateCredential } from '../../src/secrets/rotation.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import {
  CapabilityRegistry,
  type Capability,
  type CapabilityContext,
} from '../../src/broker/registry.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const SECRET = 'dns-token-8f3a91c47b2e';

/**
 * A capability that asks the broker for its own division's credential.
 *
 * This is the path that matters. A resolver called directly from a test proves
 * the query is right; it does not prove a capability can ever get a secret,
 * and for a while none could -- `CapabilityContext` carried no credential and
 * neither resolver was called from `src/` at all. So these tests go through
 * `broker.invoke`, which is where a real adapter would be standing.
 */
function credentialCapability(
  alias = 'dns',
  options: { echo?: boolean } = {},
): {
  capability: Capability<{ zone: string }, { length: number; token?: string }>;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    capability: {
      name: 'dns.read',
      adapter: 'test:dns',
      defaultTier: 0,
      async execute(_input: { zone: string }, ctx: CapabilityContext) {
        const value = await ctx.credential(alias);
        seen.push(value);
        // Reports the length rather than the value: an adapter uses its
        // credential to make a call, it does not hand it back. `echo` is for
        // the one test that checks what happens when one does.
        return options.echo ? { length: value.length, token: value } : { length: value.length };
      },
    },
  };
}

// The derived idempotency key is (role, input hash, parent), so two tasks with
// the same empty input collide. Distinct input, not a distinct key: a test that
// worked around it with an explicit key would be testing a path the caller here
// does not take.
let sequence = 0;

async function runnableTask(fixture: Fixture, capability: string): Promise<string> {
  sequence += 1;
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    goalId: fixture.goalId,
    input: { run: sequence },
    createdBy: 'owner',
    reserveTokens: 100,
  });
  await planTask(fixture.companyId, task.id, [{ capability }]);
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

function invokeContext(fixture: Fixture, taskId: string) {
  return {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    taskId,
    roleId: fixture.roleId,
    idempotencyKey: `key-${taskId}`,
  };
}

async function brokerFor(
  capability: Capability<never, never>,
  secrets?: CachedSecretManager,
): Promise<CapabilityBroker> {
  const registry = new CapabilityRegistry();
  registry.register(capability as Capability<unknown, unknown>);
  await registry.sync();
  return new CapabilityBroker(registry, undefined, secrets);
}

test('the database stores a reference, never a secret (F12.1)', async () => {
  const fixture = await createCompany('creds-reference');

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  // A literal value in the reference column is refused, so "just paste the
  // token here for now" is not available as a shortcut. Deliberately in its own
  // transaction: a failed statement aborts the surrounding transaction, so
  // sharing one with the insert above would discard it.
  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        tx.query(
          `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
           VALUES ($1, $2, 'inline', $3)`,
          [fixture.companyId, fixture.divisionId, SECRET],
        ),
      ),
    /credentials_ref_is_not_inline_secret/,
  );

  // And the reference resolves to the secret through the path a capability
  // actually uses.
  const { capability, seen } = credentialCapability();
  const secrets = new CachedSecretManager(
    new InMemorySecretManager({ 'vault://acme/dns-token': SECRET }),
  );
  const broker = await brokerFor(capability as never, secrets);
  await grantCapability(fixture, 'dns.read');
  const taskId = await runnableTask(fixture, 'dns.read');

  await broker.invoke(invokeContext(fixture, taskId), 'dns.read', { zone: 'example.com' });
  assert.deepEqual(seen, [SECRET]);
});

test('a division cannot resolve another division\'s credential (F12.2)', async () => {
  const fixture = await createCompany('creds-scope');

  const otherDivisionId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO divisions (company_id, slug, name) VALUES ($1, 'finance', 'Finance') RETURNING id`,
      [fixture.companyId],
    );
    return rows[0]!.id;
  });

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'bank', 'vault://acme/bank-token')`,
      [fixture.companyId, otherDivisionId],
    );
  });

  const secrets = new CachedSecretManager(
    new InMemorySecretManager({ 'vault://acme/bank-token': 'bank-secret-value' }),
  );

  // The division is part of the lookup rather than a check applied afterwards,
  // so naming someone else's alias finds nothing rather than finding it and
  // then deciding. Asked for the way a capability asks: the alias comes from
  // the adapter, and the division comes from the broker's own context, which
  // is what stops an adapter naming a division as well as an alias.
  const { capability, seen } = credentialCapability('bank');
  const broker = await brokerFor(capability as never, secrets);
  await grantCapability(fixture, 'dns.read');
  const taskId = await runnableTask(fixture, 'dns.read');

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, taskId), 'dns.read', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'capability.not_granted'),
  );
  assert.deepEqual(seen, [], 'the adapter never held the other division\'s secret');
});

test('another company can never see a credential reference', async () => {
  const mine = await createCompany('creds-mine');
  const theirs = await createCompany('creds-theirs');

  await withTenant(theirs.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://theirs/dns-token')`,
      [theirs.companyId, theirs.divisionId],
    );
  });

  const visible = await withTenant(mine.companyId, async (tx) => {
    const { rows } = await tx.query('SELECT secret_ref FROM credentials');
    return rows;
  });
  assert.equal(visible.length, 0);
});

test('a resolved secret is redacted everywhere it could leak (F12.4)', async () => {
  const local = new Redactor();
  local.register(SECRET);

  assert.equal(
    local.redact(`Authorization: Bearer ${SECRET}`),
    'Authorization: Bearer [redacted]',
  );

  // Nested structures matter most: a secret usually leaks inside a request
  // body attached to an error, not as a bare string somebody logged.
  const payload = {
    request: { headers: { authorization: `Bearer ${SECRET}` } },
    retries: [{ error: `failed with token ${SECRET}` }],
    unrelated: 42,
  };
  const cleaned = local.redactDeep(payload);
  assert.equal(JSON.stringify(cleaned).includes(SECRET), false);
  assert.equal(cleaned.unrelated, 42, 'redaction must not mangle unrelated values');
  assert.equal(cleaned.retries[0]!.error, 'failed with token [redacted]');
});

test('short values are not registered as secrets', () => {
  // Redacting a short common string would corrupt every message containing it.
  const local = new Redactor();
  local.register('abc');
  assert.equal(local.size, 0);
  assert.equal(local.redact('abc def'), 'abc def');

  local.register('long-enough-secret');
  assert.equal(local.size, 1);
});

test('resolving a secret registers it for redaction automatically', async () => {
  // The guarantee cannot rest on every future caller remembering to register
  // what they resolved, so resolution does it.
  const secrets = new InMemorySecretManager({ 'vault://auto/token': 'auto-registered-secret-value' });
  await secrets.resolve('vault://auto/token');
  assert.equal(
    redactor.redact('sending auto-registered-secret-value upstream'),
    'sending [redacted] upstream',
  );
});

test('no source file reads a secret out of an environment variable directly', async () => {
  // F12.1 says the application holds references only. A stray process.env read
  // for a credential would satisfy every behavioural test above while quietly
  // reintroducing scattered secrets, so the source is checked directly.
  const suspicious = /process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/;
  const offenders: string[] = [];

  for await (const file of glob('src/**/*.ts')) {
    const source = await readFile(file, 'utf8');
    if (suspicious.test(source)) offenders.push(file);
  }

  assert.deepEqual(offenders, [], 'credentials come from the secret manager, not from the environment');
});

/**
 * F12.3: a rotation takes effect on the next call, not when a cache expires.
 *
 * The version is part of the cache key and is read on every resolution, so
 * rotating advances the version and the old entry is simply never asked for
 * again. That is a stronger guarantee than invalidation, because there is no
 * step anybody can forget to perform.
 */
test('a rotated credential reaches the next call, not the one after the cache expires (F12.3)', async () => {
  const fixture = await createCompany('creds-rotate');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const store = new InMemorySecretManager({ 'vault://acme/dns-token': SECRET });
  // A cache lifetime long enough that expiry cannot be what makes this pass.
  const secrets = new CachedSecretManager(store, { ttlMs: 60 * 60 * 1000 });

  const { capability, seen } = credentialCapability();
  const broker = await brokerFor(capability as never, secrets);
  await grantCapability(fixture, 'dns.read');

  const first = await runnableTask(fixture, 'dns.read');
  await broker.invoke(invokeContext(fixture, first), 'dns.read', { zone: 'example.com' });

  const rotated = 'dns-token-rotated-6b1d0e';
  store.set('vault://acme/dns-token', rotated);
  await rotateCredential({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    alias: 'dns',
  });

  const second = await runnableTask(fixture, 'dns.read');
  await broker.invoke(invokeContext(fixture, second), 'dns.read', { zone: 'example.com' });

  assert.deepEqual(seen, [SECRET, rotated], 'the second call got the new value');
});

/**
 * And an adapter that hands its own credential back is refused.
 *
 * Two wirings meeting: the broker registers every credential it resolves with
 * the redactor, and F14's `post_tool` hook refuses an output containing a
 * registered secret verbatim. Neither is much use alone — a redactor with
 * nothing registered redacts nothing, and a leak check over a secret nobody
 * declared cannot see it. This is the test that they compose.
 */
test('an adapter that returns its own credential is refused (F12.4, F14)', async () => {
  const fixture = await createCompany('creds-echo');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const secrets = new CachedSecretManager(
    new InMemorySecretManager({ 'vault://acme/dns-token': SECRET }),
  );
  const { capability, seen } = credentialCapability('dns', { echo: true });
  const broker = await brokerFor(capability as never, secrets);
  await grantCapability(fixture, 'dns.read');
  const taskId = await runnableTask(fixture, 'dns.read');

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, taskId), 'dns.read', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'hook.denied'),
  );
  assert.equal(seen.length, 1, 'the adapter ran; it is its output that was stopped');

  // The refusal is on the record, and the record does not contain the secret.
  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM events WHERE task_id = $1 ORDER BY occurred_at',
      [taskId],
    );
    return rows;
  });
  const refusal = events.find((row) => row.type === 'hook.post_tool');
  assert.ok(refusal, 'the denial is recorded with its reason (F14.3)');
  assert.equal(
    JSON.stringify(events).includes(SECRET),
    false,
    'and no event carries the secret it was refusing to let out',
  );
});

/**
 * A deployment with no secret manager says so, rather than failing at the
 * provider with a blank token.
 */
test('a broker built without a secret manager refuses clearly', async () => {
  const fixture = await createCompany('creds-none');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/dns-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const { capability } = credentialCapability();
  const broker = await brokerFor(capability as never);
  await grantCapability(fixture, 'dns.read');
  const taskId = await runnableTask(fixture, 'dns.read');

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, taskId), 'dns.read', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'credential.unavailable'),
  );
});

/**
 * The redaction guarantee does not depend on the secret manager cooperating.
 *
 * `SecretManager` is one method wide so a deployment can implement it against
 * its own vault, and such an implementation has no reason to know this
 * codebase has a redactor. The registration that has to hold is the one on the
 * path every credential takes to an adapter, which is the broker's. This test
 * uses a manager that registers nothing, so it fails if that line is removed —
 * which it did not, the first time it was written, because the in-memory
 * manager registers on the way past and hid the difference.
 */
test('a secret from an uncooperative manager is still redacted (F12.4)', async () => {
  const fixture = await createCompany('creds-bare-manager');
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO credentials (company_id, division_id, alias, secret_ref)
       VALUES ($1, $2, 'dns', 'vault://acme/bare-token')`,
      [fixture.companyId, fixture.divisionId],
    );
  });

  const bareSecret = 'bare-manager-token-4c7e12';
  // Deliberately not InMemorySecretManager: this one is what a deployment
  // writes against its own vault, and it knows nothing about redaction.
  const bare = { async resolve() { return bareSecret; } };
  const secrets = new CachedSecretManager(bare, { ttlMs: 0 });

  const { capability } = credentialCapability('dns', { echo: true });
  const broker = await brokerFor(capability as never, secrets);
  await grantCapability(fixture, 'dns.read');
  const taskId = await runnableTask(fixture, 'dns.read');

  await assert.rejects(
    () => broker.invoke(invokeContext(fixture, taskId), 'dns.read', { zone: 'example.com' }),
    (error: unknown) => isPalugadaError(error, 'hook.denied'),
    'the leak check can only see a secret somebody registered',
  );
});
