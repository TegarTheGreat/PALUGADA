/**
 * A company starts with its CEO and nothing else (the owner's feedback of 7
 * October: "why is there a built-in team template when the CEO can arrange
 * everything").
 *
 * It used to start from a standard template: seven divisions and a role in
 * each, which the owner read before the company had sold anything and which
 * the CEO could not have bettered for any particular business. A company now
 * begins with one division, the CEO, and what the owner says it is for; the
 * team is built as the work asks for it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { firstHourOpener } from '../../src/owner/first-hour.ts';
import { installFoundingTemplate } from '../../src/templates/founding.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(async () => {
  await resetData();
  await registerStandardCatalogue();
  await installFoundingTemplate();
});
after(async () => {
  await closePools();
  await closeSetup();
});

type Structure = {
  divisions: Array<{ slug: string; name: string }>;
  roles: Array<{ slug: string; title: string | null; displayName: string | null; tools: string[]; division: string }>;
  goals: Array<{ kind: string; slug: string; statement: string }>;
};

async function started(body: Record<string, unknown> = {}) {
  const api = await consoleWithSettings();
  const owner = await api.signIn();
  const made = await api.call('POST', '/api/companies', owner, { companySlug: 'toko-kopi', name: 'Toko Kopi', proof: { totp: api.code() }, ...body });
  if (made.status !== 200) await api.close();
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const structure = (await api.call('GET', `/api/companies/${made.body.companyId}/structure`, owner)).body as Structure;
  return { api, owner, made: made.body as { companyId: string; divisions: string[]; roles: string[] }, structure };
}

test('a company that names no template starts with one division, its CEO and one goal', async () => {
  const { api, structure, made } = await started();
  try {
    assert.deepEqual(made.divisions, ['management']);
    assert.deepEqual(made.roles, ['coordinator']);
    assert.deepEqual(structure.divisions.map((one) => one.slug), ['management']);
    assert.deepEqual(structure.roles.map((one) => [one.slug, one.title, one.displayName]), [['coordinator', 'CEO', 'Arka']]);
    assert.deepEqual(structure.goals.map((one) => one.kind), ['mission']);
    // The CEO can hand work on and look again later, and holds the most tools a role may.
    const ceo = structure.roles[0]!;
    for (const tool of ['task.delegate', 'task.await', 'ticket.create', 'ticket.list', 'task.follow_up', 'schedule.propose', 'owner.ask']) {
      assert.ok(ceo.tools.includes(tool), `the CEO holds ${tool}`);
    }
    assert.ok(ceo.tools.length <= 12);
  } finally {
    await api.close();
  }
});

test('what the owner says the company is for becomes its mission, in their words', async () => {
  const words = 'Menjual kopi Gayo ke kafe dan kantor di Bandung, diantar dalam sehari.';
  const { api, structure, made } = await started({ mission: words });
  try {
    assert.equal(structure.goals.find((goal) => goal.kind === 'mission')!.statement, words);
    // And the company's charter, which the CEO's first run is told first, says it too.
    const { rows } = await withControlPlane((tx) => tx.query<{ body: string }>(
      'SELECT body FROM charters WHERE company_id = $1 ORDER BY version DESC LIMIT 1', [made.companyId]));
    assert.ok((rows[0]?.body ?? '').includes(words), 'the charter carries the owner\'s sentence');
  } finally {
    await api.close();
  }
});

test('a mission is a sentence or two: a blank one is no mission, and a runaway one is refused', async () => {
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const make = (mission: unknown) => api.call('POST', '/api/companies', owner,
      { companySlug: 'toko-kopi', name: 'Toko Kopi', mission, proof: { totp: api.code() } });
    const runaway = await make('x'.repeat(2_001));
    assert.equal(runaway.status, 400, JSON.stringify(runaway.body));
    assert.match(String(runaway.body.error), /mission is at most 2000 characters/);
    const wrong = await make(42);
    assert.equal(wrong.status, 400);
    // Spaces alone say nothing, so the company starts with the default.
    const blank = await make('   ');
    assert.equal(blank.status, 200, JSON.stringify(blank.body));
    const goals = (await api.call('GET', `/api/companies/${blank.body.companyId}/structure`, owner)).body.goals as Structure['goals'];
    assert.ok(goals[0]!.statement.length > 0);
  } finally {
    await api.close();
  }
});

test('a template that does not exist is still refused by name', async () => {
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const refused = await api.call('POST', '/api/companies', owner,
      { templateSlug: 'no-such-template', companySlug: 'toko-kopi', name: 'Toko Kopi', proof: { totp: api.code() } });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /no company template named no-such-template/);
  } finally {
    await api.close();
  }
});

test('a CEO that has been told what the company is for does not ask what it sells, and offers to build the team', async () => {
  const words = 'Menjual kopi Gayo ke kafe dan kantor di Bandung, diantar dalam sehari.';
  const { api, owner, made } = await started({ mission: words, talkLanguage: 'id', workLanguage: 'id' });
  try {
    const talk = await api.call('GET', `/api/companies/${made.companyId}/conversation`, owner);
    const [opener] = talk.body.messages as Array<{ role: string; body: string }>;
    assert.equal(opener!.role, 'assistant');
    assert.equal(opener!.body, firstHourOpener('id', { ceo: 'Arka', company: 'Toko Kopi', mission: words }));
    assert.ok(opener!.body.includes(words), 'it repeats the owner\'s sentence, so the owner sees it was heard');
    assert.doesNotMatch(opener!.body, /apa yang dijual/, 'and does not ask what the company sells');
    // Said in the owner's language, not the English it is written in.
    assert.notEqual(opener!.body, firstHourOpener(null, { ceo: 'Arka', company: 'Toko Kopi', mission: words }));
  } finally {
    await api.close();
  }
});

test('a company started without a mission is opened with the three questions, as before', async () => {
  const { api, owner, made } = await started({ talkLanguage: 'id', workLanguage: 'id' });
  try {
    const talk = await api.call('GET', `/api/companies/${made.companyId}/conversation`, owner);
    assert.equal(talk.body.messages[0].body, firstHourOpener('id', { ceo: 'Arka', company: 'Toko Kopi' }));
    assert.match(talk.body.messages[0].body, /apa yang dijual/);
  } finally {
    await api.close();
  }
});
