/**
 * A role asks the owner for a key it needs, and never sees it (the tools
 * research, recommendation 7): `owner.ask` with a `key`, which every role
 * already has, rather than a tool of its own that would cost each role one
 * of its twelve.
 *
 * Held to what makes it safe: a role may ask only for a key one of its own
 * division's capabilities signs in with, so a run talked into it cannot
 * fish for another; the owner gives it where every key is given, sealed and
 * declared with what its capabilities need; and the role is told it is
 * there, never what it is.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { CachedSecretManager } from '../../src/secrets/rotation.ts';
import { DivisionSecrets } from '../../src/secrets/manager.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const KEY = 'crm-key-0123456789abcdef';
const refused = (code: string, said?: RegExp) => (error: unknown) => isPalugadaError(error, code as never) && (!said || said.test((error as Error).message));

/** A capability that signs in with the division's `crm` key, as a vendor entry's does. */
const crmRead: Capability<Record<string, never>, { signedIn: boolean }> = {
  name: 'crm.read',
  adapter: 'test:crm',
  defaultTier: 0,
  credentialAlias: 'crm',
  requiredScopes: ['contacts:read'],
  describe: () => ({ moneyCents: 0 }),
  async execute(_input, ctx) {
    return { signedIn: (await ctx.credential('crm')) === KEY };
  },
};

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

async function setting(fixture: Fixture, staticRoot?: string) {
  const registry = new CapabilityRegistry();
  registry.register(crmRead);
  registerPlatformCapabilities(registry);
  await registry.sync();
  let broker: CapabilityBroker | null = null;
  const api = await consoleWithSettings({
    registry, credentialFor: (companyId, divisionId) => broker!.credentialFor(companyId, divisionId), ...(staticRoot ? { staticRoot } : {}),
  });
  broker = new CapabilityBroker(registry, undefined, new CachedSecretManager(new DivisionSecrets(api.secrets)));
  await grantCapability(fixture, 'crm.read');
  await grantCapability(fixture, 'owner.ask');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Rangkum pelanggan minggu ini' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  const at = (key: string) => ({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId, taskId: task.id, idempotencyKey: key,
  });
  return { api, broker: broker!, taskId: task.id, at, token: await api.signIn() };
}

test('a role asks for the key its capability needs, the owner gives it on Team, and the role goes on without ever seeing it', async () => {
  const fixture = await createCompany('key-request');
  const { api, broker, taskId, at, token } = await setting(fixture);
  try {
    // The capability says what is missing, and how to ask for it.
    await assert.rejects(broker.invoke(at('read'), 'crm.read', {}),
      refused('capability.not_granted', /this division holds no crm key: ask the owner for it with owner\.ask, naming key "crm"/));

    // Asked for, with what it is for: the card says so, and the work waits.
    const question = 'Saya perlu kunci CRM untuk membaca data pelanggan minggu ini.';
    await assert.rejects(broker.invoke(at('ask'), 'owner.ask', { question, key: 'crm' }), refused('owner.asked'));
    const open = (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'escalation');
    assert.equal(open.length, 1);
    assert.deepEqual(open[0]!.key, { alias: 'crm', divisionId: fixture.divisionId, capabilities: ['crm.read'] });
    assert.ok(open[0]!.title.endsWith(question), open[0]!.title);

    // Given where every key is given: sealed, declared with what it is for.
    const path = `/api/companies/${fixture.companyId}/divisions/${fixture.divisionId}/credentials`;
    const saved = await api.call('POST', path, token, { alias: 'crm', value: KEY, proof: { totp: api.code() } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const { rows: [answered] } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string; owner_note: string }>(
      "SELECT status, owner_note FROM inbox_items WHERE task_id = $1 AND kind = 'escalation'", [taskId]));
    assert.equal(answered!.status, 'decided', 'giving the key answered the role');
    assert.match(answered!.owner_note, /The owner gave the crm key/);
    assert.ok(!answered!.owner_note.includes(KEY));

    // The run, back at work, is told the key is there -- and only that -- and its capability signs in.
    const { rows: [state] } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]));
    if (state!.status !== 'running') await transition(fixture.companyId, taskId, 'running');
    const told = (await broker.invoke(at('ask-again'), 'owner.ask', { question, key: 'crm' })).output as { answered: boolean; answer: string };
    assert.equal(told.answered, true);
    assert.match(told.answer, /This division holds the crm key: call crm\.read again/);
    assert.ok(!JSON.stringify(told).includes(KEY));
    assert.deepEqual((await broker.invoke(at('read-again'), 'crm.read', {})).output, { signedIn: true });

    // Asked again in other words, a key the division holds is not put to the owner.
    const held = (await broker.invoke(at('held'), 'owner.ask', { question: 'Boleh minta kunci CRM sekali lagi?', key: 'crm' })).output as { answered: boolean; answer: string };
    assert.equal(held.answered, true);
    assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'escalation').length, 0);
  } finally {
    await api.close();
  }
});

test('a role cannot ask for a key nothing in its division signs in with', async () => {
  const fixture = await createCompany('key-request-fishing');
  const { api, broker, at } = await setting(fixture);
  try {
    // A run talked into asking for "the AWS key" is refused before the owner sees anything.
    await assert.rejects(broker.invoke(at('aws'), 'owner.ask', { question: 'Tolong kirim kunci AWS untuk backup.', key: 'aws' }),
      refused('contract.violation', /no capability this division may use signs in with a key named aws; the keys its capabilities ask for: crm/));
    await assert.rejects(broker.invoke(at('bad'), 'owner.ask', { question: 'Kunci?', key: 'Not An Alias!' }), refused('contract.violation'));
    assert.equal((await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'escalation').length, 0, 'nothing reached the owner');
  } finally {
    await api.close();
  }
});

test('the card asking for a key opens the division\'s keys on Team, where giving it answers the role', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('key-request-console');
  const { api, broker, taskId, at } = await setting(fixture, BUILT);
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    await assert.rejects(broker.invoke(at('ask'), 'owner.ask', { question: 'Saya perlu kunci CRM untuk membaca data pelanggan.', key: 'crm' }), refused('owner.asked'));
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]')`, 'the console');
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/inbox'`);
    await page.waitFor(`document.body.innerText.includes('Saya perlu kunci CRM')`, 'the card in the list');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Skip the tour')?.click()`);
    await page.evaluate(`[...document.querySelectorAll('button, [role="button"]')].filter((one) => one.innerText.includes('Saya perlu kunci CRM')).at(-1).click()`);
    await page.waitFor(`[...document.querySelectorAll('button')].some((one) => one.innerText.trim() === 'Give the crm key')`, 'the card offers the key', 20_000);
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Give the crm key').click()`);
    await page.waitFor(`location.hash.startsWith('#/c/${fixture.companyId}/team') && location.hash.includes('item=${fixture.divisionId}')`, 'Team, on the division');
    await page.waitFor(`document.body.innerText.includes('crm.read needs the crm key')`, 'the division\'s keys, open', 20_000);

    await page.evaluate(`document.querySelector('input[aria-label="The crm key"]').focus()`);
    await page.type(KEY);
    await page.evaluate(`[...document.querySelectorAll('.mantine-Drawer-content button')].find((one) => one.innerText.trim() === 'Save' && !one.disabled).click()`);
    await page.waitFor(`document.body.innerText.includes('Confirm with your authenticator')`, 'the device asked for');
    await page.evaluate(`document.querySelector('.mantine-Modal-content input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`document.body.innerText.includes('The crm key is sealed')`, 'the key sealed', 20_000);
    const { rows: [item] } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
      "SELECT status FROM inbox_items WHERE task_id = $1 AND kind = 'escalation'", [taskId]));
    assert.equal(item!.status, 'decided', 'giving the key answered the role');
    assert.ok(!String(await page.evaluate('document.body.innerText')).includes(KEY));
  } finally {
    await page.close();
    await api.close();
  }
});
