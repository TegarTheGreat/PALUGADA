/**
 * Who a role is: a name, a title, and a persona (src/domain/personas.ts).
 *
 * The owner asked for agents with personas of their own -- a CEO, a CTO,
 * each taking after someone well known -- chosen from a list, and named by
 * the assistant. These hold the list to what makes it usable, every run to
 * being told who it is, and every persona to being a way of thinking and
 * never an identity the agent may claim.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { rollBack } from '../../src/governance/rollback.ts';
import { PERSONAS, TITLES, personaById, renderPersona } from '../../src/domain/personas.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../helpers/standard-team.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('every persona is complete, and every title has one to choose', () => {
  const ids = new Set<string>();
  for (const persona of PERSONAS) {
    assert.ok(!ids.has(persona.id), `${persona.id} once`);
    ids.add(persona.id);
    assert.match(persona.id, /^[a-z0-9-]+$/);
    assert.ok((TITLES as readonly string[]).includes(persona.title), `${persona.id}: a title from the list`);
    assert.ok(persona.principles.length >= 3, `${persona.id}: principles to work by`);
    assert.ok(persona.manner.length > 20 && persona.decides.length > 20, `${persona.id}: how it comes across, and how it decides`);
    assert.ok(persona.inspiredBy && persona.label, persona.id);
  }
  for (const title of TITLES) assert.ok(PERSONAS.some((one) => one.title === title), `${title} has a persona to choose`);
  assert.ok(PERSONAS.filter((one) => one.title === 'CEO').length >= 3, 'a choice of temperament, not only of job');
});

test('a persona is a way of thinking, never an identity: the run is told so, and signs as itself', () => {
  const told = renderPersona({ slug: 'coordinator', displayName: 'Arka', title: 'CEO', persona: { preset: 'ceo-customer', notes: 'Hemat, dan selalu tanya data.' } }, 'Kopi Nusantara');
  assert.match(told!, /^You are Arka, the CEO of Kopi Nusantara\./);
  assert.match(told!, /in the manner of Jeff Bezos's published way of leading/);
  assert.match(told!, /- Start with the customer and work backwards/);
  assert.match(told!, /From the owner: Hemat, dan selalu tanya data\./);
  assert.match(told!, /You are not Jeff Bezos: never claim or imply to be them, never speak as them, and never use their name to persuade anyone\./);
  assert.match(told!, /signed as Arka of Kopi Nusantara/);
  assert.equal(renderPersona({ slug: 'writer', displayName: null, title: null, persona: null }, 'X'), null, 'nothing to say without a name or a persona');
  assert.equal(renderPersona({ slug: 'writer', displayName: 'Dewi', title: null, persona: null }, 'X'), 'You are Dewi at X.');
});

test('the standard company is a team of named people with titles, and no persona until the owner chooses one', () => {
  for (const role of STANDARD_COMPANY_TEMPLATE.roles) {
    assert.ok(role.displayName, `${role.slug} has a name`);
    assert.ok((TITLES as readonly string[]).includes(role.title ?? ''), `${role.slug} has a title from the list`);
    assert.equal(role.persona, undefined, `${role.slug} works as its charter says until a persona is chosen`);
  }
  const titles = STANDARD_COMPANY_TEMPLATE.roles.map((role) => role.title);
  assert.equal(new Set(titles).size, titles.length, 'one of each');
  assert.ok(titles.includes('CEO') && titles.includes('CTO') && titles.includes('CFO'));
});

test('the owner hires a CEO with a name and a persona; every run of it is told who it is; a change is kept and can be undone', async () => {
  const fixture = await createCompany('personas');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const listed = (await api.call('GET', '/api/personas', token)).body;
    assert.ok(listed.titles.includes('CTO'));
    assert.equal(listed.personas.find((one: { id: string }) => one.id === 'cto-ownership').inspiredBy, 'Werner Vogels');

    const refused = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'chief', systemPrompt: 'Run the company.', persona: { preset: 'ceo-nobody' }, proof: { totp: api.code() },
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /no persona named ceo-nobody; the personas are ceo-focus/);
    const long = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'chief', systemPrompt: 'Run the company.', displayName: 'x'.repeat(61), proof: { totp: api.code() },
    });
    assert.match(String(long.body.error), /displayName is at most 60 characters/);

    const hired = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'chief', systemPrompt: 'Run the company and hand work to the right role.',
      doneCriteria: ['every piece of work has an owner'],
      displayName: 'Arka', title: 'COO', persona: { preset: 'ceo-customer', notes: 'Hemat.' }, proof: { totp: api.code() },
    });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    const roleId = hired.body.roleId as string;
    // The company has a CEO already, and a title does not replace one: the owner appoints (ceo.test.ts).
    const appointed = await api.call('POST', `/api/companies/${fixture.companyId}/ceo`, token, { roleId, proof: { totp: api.code() } });
    assert.equal(appointed.status, 200, JSON.stringify(appointed.body));
    const structure = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    const role = structure.roles.find((one: { id: string }) => one.id === roleId);
    assert.deepEqual({ displayName: role.displayName, title: role.title, persona: role.persona },
      { displayName: 'Arka', title: 'CEO', persona: { preset: 'ceo-customer', notes: 'Hemat.' } });

    let asked = 0;
    const told = async () => {
      asked += 1;
      const task = await createRootTask({
        companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
        roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
        input: { goal: `plan the quarter, take ${asked}` }, createdBy: 'owner', reserveTokens: 1_000,
      });
      const context = await withTenant(fixture.companyId, (tx) =>
        buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
      return context.sections.find((section) => section.kind === 'role_charter')!;
    };
    const first = await told();
    assert.equal(first.title, 'Your role: Arka, CEO');
    assert.match(first.body, /^You are Arka, the CEO of /);
    assert.match(first.body, /Jeff Bezos[\s\S]*You are not Jeff Bezos[\s\S]*Run the company and hand work to the right role\./,
      'who it is comes before what it does, and the charter still follows');

    // Another persona: the change is a version.
    const changed = await api.call('POST', `/api/companies/${fixture.companyId}/roles/${roleId}`, token,
      { persona: { preset: 'ceo-focus' }, displayName: 'Arka Wijaya', summary: 'A product-first CEO' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const second = await told();
    assert.match(second.body, /^You are Arka Wijaya, the CEO/);
    assert.match(second.body, /Steve Jobs/);
    assert.doesNotMatch(second.body, /Bezos/);

    // Undone: the version before the change comes back whole.
    await rollBack(fixture.companyId, 'role', roleId, changed.body.version);
    const third = await told();
    assert.match(third.body, /^You are Arka, the CEO[\s\S]*Jeff Bezos/);

    // And taken away: null leaves the charter as it was, and the CEO still the CEO.
    const cleared = await api.call('POST', `/api/companies/${fixture.companyId}/roles/${roleId}`, token,
      { persona: null, displayName: '', proof: { totp: api.code() } });
    assert.equal(cleared.status, 200);
    const fourth = await told();
    assert.equal(fourth.title, 'Your role: chief, CEO');
    assert.match(fourth.body, /^You are the chief, the CEO of [^\n]+\.\n\nRun the company/);
    assert.doesNotMatch(fourth.body, /Steve Jobs|Bezos/);
    assert.ok(personaById('ceo-focus'));
  } finally {
    await api.close();
  }
});
