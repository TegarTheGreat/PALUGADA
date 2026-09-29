/**
 * Services from the console (F8, F12.1, F12.2, F12.3).
 *
 * A vendor was bound by a JSON file an operator wrote and pointed
 * `PALUGADA_VENDORS` at, and a division's key for it was a row inserted with
 * SQL beside an environment variable and a restart: nothing an owner could do
 * from the panel, which is where they were told everything is set up. These
 * hold the console to the rules the file keeps -- an entry is checked as the
 * file's are, a name the deployment already binds is refused, every change
 * takes the owner's device -- and hold a pasted key to the rules a credential
 * keeps: sealed, never shown again, the division's own, and what that
 * division's calls sign in with.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { bindVendorSettings, type VendorSpec } from '../../src/capabilities/vendors.ts';
import { DivisionSecrets } from '../../src/secrets/manager.ts';
import { CachedSecretManager } from '../../src/secrets/rotation.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

const servers: Server[] = [];

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await closePools();
  await closeSetup();
});

test('the owner connects a service from a preset: checked as the file is, saved with the device, bound at the next start, removed the same way', async () => {
  // What the deployment binds already, as the platform binds it.
  const registry = new CapabilityRegistry();
  registry.register({ name: 'memory.search', adapter: 'platform', defaultTier: 0, async execute() { return []; } });
  const api = await consoleWithSettings({ registry });
  try {
    const token = await api.signIn();
    const listed = await api.call('GET', '/api/control/vendors', token);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const presets = listed.body.presets as VendorSpec[];
    const resend = presets.find((one) => one.adapter === 'resend')!;
    assert.equal(resend.name, 'email.send');
    assert.ok(presets.some((one) => one.name === 'dns.read'), 'every example the repository ships is a preset');
    assert.deepEqual(listed.body.saved, []);

    // Checked before the device is asked for: a correction costs no code.
    const loose = await api.call('POST', '/api/control/vendors', token, { entry: { ...resend, tier: 0 } });
    assert.equal(loose.status, 400, JSON.stringify(loose.body));
    assert.match(String(loose.body.error), /email\.send is a POST, which changes something, and cannot be tier 0/);
    const taken = await api.call('POST', '/api/control/vendors', token, { entry: { ...resend, name: 'memory.search' } });
    assert.equal(taken.status, 400, JSON.stringify(taken.body));
    assert.match(String(taken.body.error), /memory\.search is bound already, by platform/);

    assert.equal((await api.call('POST', '/api/control/vendors', token, { entry: resend })).status, 403, 'a new service takes the device');
    const saved = await api.call('POST', '/api/control/vendors', token, { entry: resend, proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = (await api.call('GET', '/api/control/vendors', token)).body;
    assert.deepEqual((after.saved as VendorSpec[]).map((one) => [one.name, one.adapter]), [['email.send', 'resend']]);

    // The next start binds it, as it binds the file.
    const env = withSettings({}, await readSettings());
    const next = new CapabilityRegistry();
    const notes: string[] = [];
    assert.deepEqual(bindVendorSettings(next, env.PALUGADA_VENDOR_SETTINGS, notes), ['email.send']);
    assert.equal(next.get('email.send')?.adapter, 'resend');
    assert.deepEqual(notes, []);

    // One a start cannot bind is left out with a note, and the rest start: the
    // console is the only place the owner can put it right.
    const dnsRead = presets.find((one) => one.name === 'dns.read')!;
    const partly = new CapabilityRegistry();
    const said: string[] = [];
    const bound = bindVendorSettings(partly, JSON.stringify({ capabilities: [{ ...resend, tier: 0 }, dnsRead] }), said);
    assert.deepEqual(bound, ['dns.read']);
    assert.match(said.join('\n'), /the service email\.send set in the console is left out: .*cannot be tier 0/);

    // Removed with the device.
    assert.equal((await api.call('POST', '/api/control/vendors/email.send/remove', token, {})).status, 403);
    const removed = await api.call('POST', '/api/control/vendors/email.send/remove', token, { proof: { totp: api.code() } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual((await api.call('GET', '/api/control/vendors', token)).body.saved, []);
    assert.equal(withSettings({}, await readSettings()).PALUGADA_VENDOR_SETTINGS, undefined);
  } finally {
    await api.close();
  }
});

const KEY_ONE = 'crm-key-first-0123456789abcdef';
const KEY_TWO = 'crm-key-second-fedcba9876543210';

test('a division\'s key for a service is pasted in the console, sealed, and is what its calls sign in with; replaced and removed the same way, and never shown again', async () => {
  const fixture = await createCompany('service-key');
  const other = await createCompany('service-key-other');
  const vendor = await crmServer();
  const registry = new CapabilityRegistry();
  let broker: CapabilityBroker | null = null;
  const api = await consoleWithSettings({
    registry,
    credentialFor: (companyId, divisionId) => broker!.credentialFor(companyId, divisionId),
  });
  broker = new CapabilityBroker(registry, undefined, new CachedSecretManager(new DivisionSecrets(api.secrets)));
  try {
    const token = await api.signIn();
    const saved = await api.call('POST', '/api/control/vendors', token, { entry: crmEntry(vendor.url), proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // The restart, as main.ts makes it.
    assert.deepEqual(bindVendorSettings(registry, withSettings({}, await readSettings()).PALUGADA_VENDOR_SETTINGS, []), ['crm.note']);
    await registry.sync();
    await grantCapability(fixture, 'crm.note');

    // The division is told what it is missing, by the capability that needs it,
    // and what the key must carry (F12.6).
    const path = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`;
    const before = await api.call('GET', path, token);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(before.body, { credentials: [], needs: [{ alias: 'crm', capabilities: ['crm.note'], scopes: ['notes:write'] }] });

    // Checked before the device: a blank key, a name that is not an alias, a
    // division of another company.
    const blank = await api.call('POST', path, token, { alias: 'crm', value: '   ' });
    assert.equal(blank.status, 400);
    assert.match(String(blank.body.error), /paste the whole key/);
    const named = await api.call('POST', path, token, { alias: 'CRM key!', value: KEY_ONE });
    assert.equal(named.status, 400);
    assert.match(String(named.body.error), /an alias is lower-case letters, digits, - and _/);
    const elsewhere = await api.call('POST', `/api/companies/${other.companyId}/divisions/${fixture.divisionId}/credentials`, token,
      { alias: 'crm', value: KEY_ONE });
    assert.equal(elsewhere.status, 400);
    assert.match(String(elsewhere.body.error), /no division .* in that company/);

    assert.equal((await api.call('POST', path, token, { alias: 'crm', value: KEY_ONE })).status, 403, 'a key takes the device');
    const pasted = await api.call('POST', path, token, { alias: 'crm', value: ` ${KEY_ONE}\n`, proof: { totp: api.code() } });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.body));
    assert.equal(pasted.body.version, 1);
    const listed = await api.call('GET', path, token);
    assert.deepEqual(listed.body.needs, []);
    assert.deepEqual((listed.body.credentials as Array<{ alias: string; version: number; stored: string; scopes: string[] }>)
      .map((one) => [one.alias, one.version, one.stored, one.scopes]), [['crm', 1, 'console', ['notes:write']]],
    'declared with what its capabilities need, and no more: the broker refuses a key that does not declare it');
    assert.ok(!JSON.stringify(listed.body).includes(KEY_ONE), 'the key never comes back');
    const first = await secretRef(fixture);
    assert.match(first, /^db:\/\/credential-[0-9a-f]{16}$/, 'sealed in the deployment\'s store, under the name divisions may use');

    // The division's call signs in with it, trimmed as it was pasted.
    await note(broker, fixture);
    assert.equal(vendor.keys.at(-1), `Bearer ${KEY_ONE}`);

    // Pasted again: a rotation. The next call signs in with the new key, and
    // the old one is kept nowhere.
    const replaced = await api.call('POST', path, token, { alias: 'crm', value: KEY_TWO, proof: { totp: api.code() } });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.version, 2);
    await note(broker, fixture);
    assert.equal(vendor.keys.at(-1), `Bearer ${KEY_TWO}`);
    await assert.rejects(api.secrets.resolve(first), /nothing is stored/);

    // Removed with the device: the row, and the sealed key behind it.
    const second = await secretRef(fixture);
    assert.equal((await api.call('POST', `${path}/crm/remove`, token, {})).status, 403);
    const removed = await api.call('POST', `${path}/crm/remove`, token, { proof: { totp: api.code() } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual((await api.call('GET', path, token)).body, { credentials: [], needs: [{ alias: 'crm', capabilities: ['crm.note'], scopes: ['notes:write'] }] });
    await assert.rejects(api.secrets.resolve(second), /nothing is stored/);
  } finally {
    await api.close();
  }
});

/** A CRM that keeps notes and says who signed each request in. */
async function crmServer() {
  const keys: Array<string | null> = [];
  const notes = new Map<string, unknown>();
  const server = createServer((req, res) => {
    keys.push(req.headers.authorization ?? null);
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && req.url === '/notes') {
        const id = `note-${notes.size + 1}`;
        notes.set(id, JSON.parse(raw));
        return reply(200, { id });
      }
      const id = /^\/notes\/(.+)$/.exec(req.url ?? '')?.[1];
      if (req.method === 'GET' && id && notes.has(id)) return reply(200, { id });
      return reply(404, { error: 'no such note' });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, keys };
}

function crmEntry(url: string) {
  return {
    name: 'crm.note',
    adapter: 'test-crm',
    tier: 1,
    method: 'POST',
    url: `${url}/notes`,
    headers: { authorization: 'Bearer {credential}', 'idempotency-key': '{idempotencyKey}' },
    body: { customerId: '{input.customerId}', note: '{input.note}' },
    input: {
      type: 'object',
      required: ['customerId', 'note'],
      properties: { customerId: { type: 'string' }, note: { type: 'string', minLength: 1 } },
    },
    result: 'body.id',
    credentialAlias: 'crm',
    requiredScopes: ['notes:write'],
    allowPrivateHosts: ['127.0.0.1'],
    verify: {
      url: `${url}/notes/{result}`,
      headers: { authorization: 'Bearer {credential}' },
      matches: { status: 200, path: 'body.id', equalsPath: 'result' },
    },
  };
}

let notes = 0;
async function note(broker: CapabilityBroker, fixture: Fixture): Promise<void> {
  notes += 1;
  const task = await createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `follow up ${notes}` },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });
  await broker.invoke({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    taskId: task.id,
    roleId: fixture.roleId,
    idempotencyKey: `key-${task.id}`,
  }, 'crm.note', { customerId: 'c-1', note: 'Followed up.' });
}

async function secretRef(fixture: Fixture): Promise<string> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ secret_ref: string }>(
    "SELECT secret_ref FROM credentials WHERE division_id = $1 AND alias = 'crm'", [fixture.divisionId]));
  return rows[0]!.secret_ref;
}
