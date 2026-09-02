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
  resolveForDivision,
} from '../../src/secrets/manager.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const SECRET = 'dns-token-8f3a91c47b2e';

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

  const secrets = new InMemorySecretManager({ 'vault://acme/dns-token': SECRET });
  const value = await withTenant(fixture.companyId, (tx) =>
    resolveForDivision(tx, secrets, fixture.divisionId, 'dns'),
  );
  assert.equal(value, SECRET);
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

  const secrets = new InMemorySecretManager({ 'vault://acme/bank-token': 'bank-secret-value' });

  // The division is part of the lookup rather than a check applied afterwards,
  // so naming someone else's alias finds nothing rather than finding it and
  // then deciding.
  await assert.rejects(
    () =>
      withTenant(fixture.companyId, (tx) =>
        resolveForDivision(tx, secrets, fixture.divisionId, 'bank'),
      ),
    (error: unknown) => isPalugadaError(error, 'capability.not_granted'),
  );
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
