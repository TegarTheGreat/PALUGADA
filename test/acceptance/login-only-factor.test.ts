/**
 * The authenticator is asked for when the owner signs in, and not again
 * (the owner's report of 7 October: "buat agar autentikator saat login saja").
 *
 * Every change to a company, every setting of the deployment and every tier 3
 * decision asked for a code of its own, so an owner building a company took
 * their phone out for each division and each role, and a CEO that could do
 * the work could do none of it without them. A session opened with a code or a
 * passkey is now the second factor for all of it. This deliberately relaxes
 * F10.10 and F12.5, which wanted a fresh proof for each tier 3 approval; the
 * cost is that a stolen session can do within its eight hours what the owner
 * can, and `docs/THREAT-MODEL.md` says so.
 *
 * What still takes a code at the moment it is done is what changes who the
 * owner is -- revoking an authenticator, making new recovery codes, adding a
 * passkey, vouching for a device -- and everything in a session that was
 * opened with a recovery code, which proves less than a device. A chat is
 * still no place to approve tier 3: it has no session at all.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { createCompany, planTask } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** A session signed in with a recovery code: a device would be needed for anything it does. */
async function recoverySession(api: Awaited<ReturnType<typeof consoleWithSettings>>, token: string): Promise<string> {
  const made = await api.call('POST', '/api/mfa/recovery-codes', token, { proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const response = await fetch(`${api.url}/api/auth/sign-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: made.body.codes[0] }),
  });
  return String(((await response.json()) as { token: string }).token);
}

test('a session opened with a device is the second factor: the owner builds, sets and loosens with no code', async () => {
  const fixture = await createCompany('login-only');
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const division = (slug: string, proof?: unknown) => api.call('POST', `/api/companies/${fixture.companyId}/divisions`, token,
      { slug, name: slug, ...(proof === undefined ? {} : { proof }) });

    assert.equal((await division('research')).status, 200, 'what builds the company');
    // What the ten-minute window never covered, and every one of these asked for a code.
    assert.equal((await api.call('POST', '/api/control/settings/model/clear', token, {})).status, 200, 'the model');
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/spend/resume`, token, {})).status, 200, 'letting spending resume');
    // A code sent anyway is not read, so a stale one from an older console refuses nothing.
    assert.equal((await division('support', { totp: '000000' })).status, 200);
  } finally {
    await api.close();
  }
});

test('what changes who the owner is still takes a code, at the moment it is done', async () => {
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const listed = await api.call('GET', '/api/mfa/authenticators', token);
    const authenticatorId: string = listed.body.authenticators[0].id;

    for (const [path, body] of [
      ['/api/mfa/recovery-codes', {}],
      [`/api/mfa/authenticators/${authenticatorId}/revoke`, {}],
      ['/api/mfa/passkeys', { label: 'laptop', credential: { id: 'x', clientDataJSON: 'x', attestationObject: 'x' } }],
    ] as const) {
      const refused = await api.call('POST', path, token, body);
      assert.equal(refused.status, 403, `${path} asks for a code even in a session opened with one`);
      assert.match(String(refused.body.error), /second factor/);
    }
    const made = await api.call('POST', '/api/mfa/recovery-codes', token, { proof: { totp: api.code() } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
  } finally {
    await api.close();
  }
});

test('a session opened with a recovery code proves less than a device: it asks until a device code is shown', async () => {
  const fixture = await createCompany('login-only-recovery');
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const recovered = await recoverySession(api, await api.signIn());
    const division = (slug: string, proof?: unknown) => api.call('POST', `/api/companies/${fixture.companyId}/divisions`, recovered,
      { slug, name: slug, ...(proof === undefined ? {} : { proof }) });
    assert.equal((await division('one')).status, 403, 'it asks');
    assert.equal((await division('two', { totp: api.code() })).status, 200, 'a device\'s code, shown for the action, does it');
    assert.equal((await division('three')).status, 200, 'and the device having been shown, the session is one opened with a device');
  } finally {
    await api.close();
  }
});

test('a tier 3 approval takes the signed-in session; a recovery session and a chat do not suffice', async () => {
  const fixture = await createCompany('login-only-tier3');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'wire the payment' },
    createdBy: 'owner', reserveTokens: 10_000,
  });
  await planTask(fixture.companyId, task.id, [{ capability: 'dns.nameservers' }]);
  await transition(fixture.companyId, task.id, 'running');
  const itemId = await inbox.requestApproval({
    companyId: fixture.companyId, taskId: task.id, capabilityName: 'payment.send', tier: 3,
    actionSummary: 'Send the payment', rationale: 'The invoice is verified.', consequenceIfDenied: 'The supplier is not paid.',
  });

  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const decide = (as: string) => api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`, as, { decision: 'approve' });

    // A chat has no session, and approving tier 3 over it is refused whatever it says.
    await assert.rejects(
      () => inbox.decide(fixture.companyId, itemId, 'approve', 'ok', { channel: 'chat', assurance: 'session' }),
      (error: unknown) => isPalugadaError(error, 'approval.channel_forbidden'));
    // A session opened with a recovery code approves nothing at tier 3 without a device's code.
    assert.equal((await decide(await recoverySession(api, token))).status, 403);
    assert.equal((await inbox.listOpen(fixture.companyId)).some((entry) => entry.id === itemId), true, 'and nothing changed');

    // The signed-in owner approves in the app, with no code, and the record says which device opened the session.
    const approved = await decide(token);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await inbox.listOpen(fixture.companyId)).some((entry) => entry.id === itemId), false);
    const decided = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ payload: { assurance: string; authenticatorId?: string; factor?: string } }>(
        "SELECT payload FROM events WHERE type = 'owner.decided'");
      return rows;
    });
    assert.equal(decided.length, 1);
    assert.equal(decided[0]!.payload.assurance, 'login', 'recorded as a decision made in a signed-in session');
    assert.equal(decided[0]!.payload.factor, 'totp');
    assert.ok(decided[0]!.payload.authenticatorId, 'with the device that signed in');
  } finally {
    await api.close();
  }
});

test('there is no window to set: a code shown for a minute is not a rule the owner can lengthen', async () => {
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    assert.equal((await api.call('GET', '/api/control/step-up', token)).status, 404);
    assert.equal((await api.call('POST', '/api/control/step-up', token, { minutes: 30, proof: { totp: api.code() } })).status, 404);
    const me = await api.call('GET', '/api/me', token);
    assert.equal(me.body.owner, true);
    assert.equal('stepUp' in me.body, false);
  } finally {
    await api.close();
  }
});
