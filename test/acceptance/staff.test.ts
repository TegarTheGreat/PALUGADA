/**
 * Staff seats beside the one owner (the analysis of 3 October, §9 P2 item
 * 18): a viewer, and an approver for tier 2 and below. Tier 3 stays the
 * owner's, as does every setting, key, device and loosening.
 *
 * PALUGADA had exactly one human, and a session could not tell people apart:
 * any enrolled authenticator passed the owner's second factor and the tier 3
 * gate. A seat is kept apart from the owner's factors altogether -- its own
 * authenticator, its own sessions -- so a staff member's code is never the
 * owner's, whichever route it reaches. Each seat is one company's, made by
 * the owner with their device and joined from a link that gives its opener
 * an authenticator of their own; a staff session is refused every route not
 * listed for its seat.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** A staff member's authenticator app: the code it shows, a step ahead each time so none is a replay. */
function app(secret: string) {
  let step = stepFor(new Date()) - 1;
  return () => {
    step += 1;
    return totpCode(decodeBase32(secret), Math.min(step, stepFor(new Date()) + 1));
  };
}

/** The owner seats someone; they open the link, add the secret to their app, and confirm. */
async function seat(api: Console, owner: string, fixture: Fixture, name: string, kind: 'viewer' | 'approver') {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const invite = String(made.body.invite);
  const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const code = app(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.body.offer, totp: code() });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { seatId: String(made.body.seatId), invite, token: String(joined.body.token), code, staff: joined.body.staff };
}

test('a viewer joins with their own authenticator, reads their company, and changes nothing', async () => {
  const fixture = await createCompany('staff-viewer');
  const other = await createCompany('staff-other');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', 'viewer');
    assert.deepEqual(rina.staff, { name: 'Rina', kind: 'viewer', companyId: fixture.companyId });
    const spent = await api.call('POST', '/api/auth/join', '', { code: rina.invite });
    assert.deepEqual([spent.status, spent.body.code], [401, 'mfa.claim_invalid'], 'an invite is spent by joining');

    const companies = await api.call('GET', '/api/companies', rina.token);
    assert.equal(companies.status, 200);
    assert.deepEqual(companies.body.companies.map((one: { id: string }) => one.id), [fixture.companyId], 'their company and no other');
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/work`, rina.token)).status, 200);
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, rina.token)).status, 200);
    assert.equal((await api.call('GET', `/api/companies/${other.companyId}/work`, rina.token)).status, 403, 'nor another company');

    const forbidden: Array<[string, string]> = [
      ['POST', `/api/companies/${fixture.companyId}/assign`],
      ['GET', `/api/companies/${fixture.companyId}/export`],
      ['GET', `/api/companies/${fixture.companyId}/conversation`],
      ['GET', '/api/control/settings'],
      ['GET', '/api/mfa/authenticators'],
      ['GET', '/api/search?q=x'],
      ['POST', '/api/control/stop-all'],
    ];
    for (const [method, path] of forbidden) {
      const answer = await api.call(method, path, rina.token, method === 'POST' ? {} : undefined);
      assert.equal(answer.status, 403, `${method} ${path} is the owner's`);
      assert.equal(answer.body.code, 'staff.forbidden');
    }

    const me = await api.call('GET', '/api/me', rina.token);
    assert.deepEqual(me.body, { owner: false, staff: { name: 'Rina', kind: 'viewer', companyId: fixture.companyId } });
    assert.deepEqual((await api.call('GET', '/api/me', owner)).body, { owner: true, staff: null });

    // Signing in again later with the code their app shows.
    const again = await api.call('POST', '/api/auth/sign-in', '', { totp: rina.code() });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.staff, { name: 'Rina', kind: 'viewer', companyId: fixture.companyId });
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/work`, String(again.body.token))).status, 200);
  } finally {
    await api.close();
  }
});

test('an approver decides tier 2 and below, never tier 3, and the record names them', async () => {
  const fixture = await createCompany('staff-approver');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi', 'approver');
    const viewer = await seat(api, owner, fixture, 'Rina', 'viewer');

    const ordinary = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, title: 'email.send: to ana@example.test',
      actionSummary: 'email.send: to ana@example.test', rationale: 'A reply.', consequenceIfDenied: 'No reply is sent.',
    });
    const decide = (token: string, itemId: string, body: Record<string, unknown> = { decision: 'approve' }) =>
      api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`, token, body);

    assert.equal((await decide(viewer.token, ordinary)).status, 403, 'a viewer decides nothing');
    const yes = await decide(budi.token, ordinary);
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    const { rows: [decided] } = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string; decided_by_seat: string | null }>(
      'SELECT decision, decided_by_seat FROM inbox_items WHERE id = $1', [ordinary]));
    assert.deepEqual(decided, { decision: 'approve', decided_by_seat: budi.seatId });
    const { rows: [event] } = await withControlPlane((tx) => tx.query<{ actor: string; payload: { staff?: { name: string } } }>(
      "SELECT actor, payload FROM events WHERE company_id = $1 AND type = 'owner.decided' ORDER BY occurred_at DESC LIMIT 1",
      [fixture.companyId]));
    assert.equal(event!.actor, 'staff');
    assert.equal(event!.payload.staff?.name, 'Budi');

    const irreversible = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'record.delete', tier: 3, title: 'record.delete: recordId cust-042',
      actionSummary: 'record.delete: recordId cust-042', rationale: 'A duplicate.', consequenceIfDenied: 'It stays.',
    });
    for (const decision of ['approve', 'deny']) {
      const refused = await decide(budi.token, irreversible, { decision, proof: { totp: budi.code() } });
      assert.equal(refused.status, 403, `${decision} on tier 3 is the owner's`);
      assert.match(String(refused.body.error), /tier 3/);
    }
    const another = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, title: 'email.send: to budi@example.test',
      actionSummary: 'email.send: to budi@example.test', rationale: 'A reply.', consequenceIfDenied: 'No reply is sent.',
    });
    assert.equal((await decide(budi.token, another, { decision: 'approve', allowForHours: 8 })).status, 403,
      'approving for a while loosens a control, which is the owner\'s');
  } finally {
    await api.close();
  }
});

test('a staff member never approves tier 3, whatever code they hold, and the owner who signed in does', async () => {
  const fixture = await createCompany('staff-factor');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi', 'approver');
    const tier3 = await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'record.delete', tier: 3, title: 'record.delete: recordId cust-042',
      actionSummary: 'record.delete: recordId cust-042', rationale: 'A duplicate.', consequenceIfDenied: 'It stays.',
    });
    const statusOf = async () => (await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
      'SELECT status FROM inbox_items WHERE id = $1', [tier3]))).rows[0]!.status;
    // The seat's own session, with its own code: the factor is the owner's, and a seat has none to lend.
    const byBudi = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${tier3}/decide`, budi.token,
      { decision: 'approve', proof: { totp: budi.code() } });
    assert.deepEqual([byBudi.status, byBudi.body.code], [403, 'staff.forbidden']);
    assert.equal(await statusOf(), 'open');
    // A seat's code offered inside the owner's session is not read, and what approves is the owner's sign-in.
    const approved = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${tier3}/decide`, owner,
      { decision: 'approve', proof: { totp: budi.code() } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(await statusOf(), 'decided');
  } finally {
    await api.close();
  }
});

test('revoking a seat ends its sessions at once, and the owner sees who is seated', async () => {
  const fixture = await createCompany('staff-revoke');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const rina = await seat(api, owner, fixture, 'Rina', 'viewer');
    const pending = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner,
      { name: 'Sari', kind: 'approver', proof: { totp: api.code() } });

    const listed = await api.call('GET', `/api/companies/${fixture.companyId}/staff`, owner);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.seats.map((one: { name: string; kind: string; joined: boolean }) => [one.name, one.kind, one.joined]),
      [['Rina', 'viewer', true], ['Sari', 'approver', false]]);
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/staff`, rina.token)).status, 403, 'the list is the owner\'s');

    const revoked = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${rina.seatId}/revoke`, owner, {});
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/work`, rina.token)).status, 401, 'signed out at once');
    assert.equal((await api.call('POST', '/api/auth/sign-in', '', { totp: rina.code() })).status, 401, 'and cannot sign in again');

    // An invite not yet used is withdrawn with its seat.
    await api.call('POST', `/api/companies/${fixture.companyId}/staff/${pending.body.seatId}/revoke`, owner, {});
    assert.equal((await api.call('POST', '/api/auth/join', '', { code: pending.body.invite })).status, 401);
  } finally {
    await api.close();
  }
});
