/**
 * One code opens a short window (the owner's complaint of 6 October: "dikit
 * dikit autentikator ... bolak balik hp").
 *
 * Every change to the company's structure asked for a fresh code, which is
 * single use, so building a company -- a division, its roles, its goals --
 * meant the phone out for each one and a wait of up to thirty seconds for the
 * next. Now a code or passkey that was just shown opens a window, ten minutes
 * unless the owner says otherwise, in which what *builds the company* needs no
 * new one. What loosens money, reaches outside, changes the model or a key, or
 * touches the owner's own devices always asks, and so does every tier 3
 * decision: the window is for the work the owner is already doing, not for
 * what a stolen tab could do harm with.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const setWindow = (minutes: number) => withControlPlane((tx) => tx.query('UPDATE platform_control SET step_up_minutes = $1', [minutes]));
const sessionProvedAgo = (minutes: number) => withControlPlane((tx) => tx.query(
  "UPDATE owner_sessions SET proved_at = now() - make_interval(mins => $1::int) WHERE ended_at IS NULL", [minutes]));

test('a code just shown covers what builds the company, and nothing that loosens money, keys or the model', async () => {
  await setWindow(10);
  const fixture = await createCompany('step-up');
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const division = (slug: string, proof?: unknown) => api.call('POST', `/api/companies/${fixture.companyId}/divisions`, token,
      { slug, name: slug, ...(proof === undefined ? {} : { proof }) });

    // Signing in was the proof: the first change needs no new code.
    const first = await division('research');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await division('support');
    assert.equal(second.status, 200, 'and the next after it');

    // What is not building the company still asks, window or not.
    const model = await api.call('POST', '/api/control/settings/model/clear', token, {});
    assert.equal(model.status, 403, 'the model and its key always ask');
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/spend/resume`, token, {})).status, 403, 'so does letting spending resume');

    // The window ran out: asked again, and a code given reopens it.
    await sessionProvedAgo(11);
    assert.equal((await division('sales')).status, 403, 'ten minutes after the last code, it asks');
    const proved = await division('sales', { totp: api.code() });
    assert.equal(proved.status, 200, JSON.stringify(proved.body));
    assert.equal((await division('finance')).status, 200, 'and a code reopens the window');
  } finally {
    await api.close();
  }
});

test('the owner chooses how long, or none at all; the window is a setting only a fresh code raises', async () => {
  const fixture = await createCompany('step-up-setting');
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const division = (slug: string) => api.call('POST', `/api/companies/${fixture.companyId}/divisions`, token, { slug, name: slug });

    // None: every change asks, as it did.
    await setWindow(0);
    assert.equal((await division('a')).status, 403);

    // The default a deployment is born with: ten minutes.
    const { rows } = await withControlPlane((tx) => tx.query<{ column_default: string }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'platform_control' AND column_name = 'step_up_minutes'"));
    assert.equal(Number(rows[0]!.column_default), 10);

    const read = await api.call('GET', '/api/control/step-up', token);
    assert.deepEqual(read.body, { minutes: 0, choices: [0, 5, 10, 30, 60] });

    // Raising it is loosening: it takes a code. Lowering is the session's.
    assert.equal((await api.call('POST', '/api/control/step-up', token, { minutes: 30 })).status, 403);
    const raised = await api.call('POST', '/api/control/step-up', token, { minutes: 30, proof: { totp: api.code() } });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal((await division('b')).status, 200, 'the code that raised it opened it');
    assert.equal((await api.call('POST', '/api/control/step-up', token, { minutes: 5 })).status, 200);
    assert.equal((await api.call('POST', '/api/control/step-up', token, { minutes: 7, proof: { totp: api.code() } })).status, 400, 'only the choices offered');
    assert.equal((await api.call('GET', '/api/me', token)).body.stepUp.minutes, 5);
    assert.equal((await api.call('POST', '/api/control/step-up', token, { minutes: 0 })).status, 200);
    assert.equal((await division('c')).status, 403, 'turned off, it is off at once');
  } finally {
    await api.close();
  }
});

test('a session signed in with a recovery code opens no window: it proves less than a device', async () => {
  await setWindow(10);
  const fixture = await createCompany('step-up-recovery');
  const api = await consoleWithSettings({ baseEnv: {} });
  try {
    const token = await api.signIn();
    const made = await api.call('POST', '/api/mfa/recovery-codes', token, { proof: { totp: api.code() } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const code: string = made.body.codes[0];
    const response = await fetch(`${api.url}/api/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: code }),
    });
    const recovered = String(((await response.json()) as { token: string }).token);
    const division = (slug: string, proof?: unknown) => api.call('POST', `/api/companies/${fixture.companyId}/divisions`, recovered,
      { slug, name: slug, ...(proof === undefined ? {} : { proof }) });
    assert.equal((await division('one')).status, 403, 'signed in by a recovery code, it asks');
    assert.equal((await api.call('GET', '/api/me', recovered)).body.stepUp.until, null);
    // A device's code, shown for the action, opens it -- and a recovery code shown for one does not.
    assert.equal((await division('two', { totp: api.code() })).status, 200);
    assert.equal((await division('three')).status, 200);
  } finally {
    await api.close();
  }
});
