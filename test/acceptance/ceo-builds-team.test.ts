/**
 * The CEO builds the team (the owner's report of 7 October: "this CEO is
 * still an ornament, it cannot do anything").
 *
 * A company starts with its CEO alone, and the CEO is the one the owner talks
 * to. But opening a division, hiring a role and letting a division use a
 * capability were cards the owner pressed, each asking for their phone, so the
 * CEO could only describe a team it then waited for the owner to build. The
 * owner's sign-in is now the second factor, so the CEO builds the team as it
 * is told, in the owner's conversation with it, and says what it did. It
 * still does not when it has read what agents or customers wrote, in a chat
 * (which has no session), or in a session that was signed in with a recovery
 * code: those are cards, as they always were.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import type { LlmBlock, LlmTurn, LlmTurnRequest, ToolUsingLlmClient } from '../../src/llm/client.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Line = Pick<LlmTurn, 'content' | 'stopReason'>;

class ScriptedModel implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  readonly #script: Line[];

  constructor(script: Line[]) {
    this.#script = script;
  }

  async turn(request: LlmTurnRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    const line = this.#script[this.requests.length - 1];
    if (!line) throw new Error(`the script has no line ${this.requests.length}`);
    return { ...line, inputTokens: 100, outputTokens: 10, costCents: 0 };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

const says = (text: string): Line => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const uses = (...calls: Array<[string, unknown]>): Line => ({
  content: calls.map(([name, input], index) => ({ type: 'tool_use', id: `call-${name}-${index}`, name, input })),
  stopReason: 'tool_use',
});

function results(model: ScriptedModel, request: number): Array<{ content: string; isError?: boolean }> {
  const last = model.requests[request]!.messages.at(-1)!;
  return (last.content as LlmBlock[]).filter((block): block is Extract<LlmBlock, { type: 'tool_result' }> => block.type === 'tool_result');
}

type Structure = { divisions: Array<{ slug: string }>; roles: Array<{ slug: string; title: string | null }>; goals: Array<{ slug: string }> };

async function structureOf(api: Awaited<ReturnType<typeof consoleWithSettings>>, token: string, companyId: string): Promise<Structure> {
  return (await api.call('GET', `/api/companies/${companyId}/structure`, token)).body as Structure;
}

const hire = (fixture: { companyId: string; divisionId: string }) => ['propose', {
  path: `/api/companies/${fixture.companyId}/roles`,
  body: {
    divisionId: fixture.divisionId, slug: 'marketer', systemPrompt: 'You sell the roastery to cafes.', displayName: 'Sari',
    title: 'Head of Marketing', tools: [], doneCriteria: ['every message names the product'],
  },
  summary: 'Hire Sari, who sells to cafes.',
}] as [string, unknown];

test('the CEO opens a division and hires a role as it is told, with no card and no code, and says what it did', async () => {
  const fixture = await createCompany('ceo-builds');
  const model = new ScriptedModel([
    uses(['read', { path: `/api/companies/${fixture.companyId}/structure` }], ['read', { path: '/api/personas' }]),
    uses(
      ['propose', {
        path: `/api/companies/${fixture.companyId}/divisions`, body: { slug: 'sales', name: 'Sales' },
        summary: 'Open a Sales division.',
      }],
      hire(fixture),
      ['propose', {
        path: `/api/companies/${fixture.companyId}/goals`,
        body: { kind: 'key_result', slug: 'first-order', statement: 'Sell to ten cafes' },
        summary: 'Aim at ten cafes.',
      }],
    ),
    says('Saya buka divisi Sales dan angkat Sari untuk menjual ke kafe.'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const said = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Bangun tim penjualan.' });
    assert.equal(said.status, 200, JSON.stringify(said.body));

    const [division, role] = results(model, 2);
    assert.match(division!.content, /^Done: Open a Sales division\./);
    assert.match(role!.content, /^Done: Hire Sari, who sells to cafes\./);
    const cards = said.body.messages[1].proposals as Array<{ status: string; path: string }>;
    assert.deepEqual(cards.filter((card) => card.path.endsWith('/divisions') || card.path.endsWith('/roles')).map((card) => card.status), ['applied', 'applied']);

    const structure = await structureOf(api, token, fixture.companyId);
    assert.ok(structure.divisions.some((one) => one.slug === 'sales'), 'the division exists');
    assert.ok(structure.roles.some((one) => one.slug === 'marketer' && one.title === 'Head of Marketing'), 'and so does the role');
  } finally {
    await api.close();
  }
});

test('after reading what agents wrote, the same hire is a card for the owner, not done', async () => {
  const fixture = await createCompany('ceo-builds-tainted');
  const model = new ScriptedModel([
    uses(['read', { path: `/api/companies/${fixture.companyId}/work` }]),
    uses(hire(fixture)),
    says('Kartunya ada di atas.'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const said = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Angkat orang untuk pemasaran.' });
    assert.match(results(model, 2)[0]!.content, /^Proposed as a card, not done/);
    const [card] = said.body.messages[1].proposals as Array<{ id: string; status: string }>;
    assert.equal(card!.status, 'open');
    assert.ok(!(await structureOf(api, token, fixture.companyId)).roles.some((one) => one.slug === 'marketer'), 'nothing was hired');
    // The owner presses it, and with their sign-in that is all it takes.
    const applied = await api.call('POST', `/api/assistant/proposals/${card!.id}/apply`, token, {});
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.ok((await structureOf(api, token, fixture.companyId)).roles.some((one) => one.slug === 'marketer'));
  } finally {
    await api.close();
  }
});

test('in a session signed in with a recovery code the hire stays a card that asks for the device', async () => {
  const fixture = await createCompany('ceo-builds-recovery');
  const model = new ScriptedModel([
    uses(hire(fixture)),
    says('Perlu perangkat Anda.'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const first = await api.signIn();
    const made = await api.call('POST', '/api/mfa/recovery-codes', first, { proof: { totp: api.code() } });
    const response = await fetch(`${api.url}/api/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: made.body.codes[0] }),
    });
    const recovered = String(((await response.json()) as { token: string }).token);

    const said = await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, recovered, { text: 'Angkat orang untuk pemasaran.' });
    assert.equal(said.status, 200, JSON.stringify(said.body));
    assert.match(results(model, 1)[0]!.content, /needs the owner's device/);
    const [card] = said.body.messages[1].proposals as Array<{ id: string; status: string }>;
    assert.equal(card!.status, 'open', 'a card for the owner, not a failure');
    assert.ok(!(await structureOf(api, first, fixture.companyId)).roles.some((one) => one.slug === 'marketer'));

    // With a device's code it is done, as it would be from the page.
    const applied = await api.call('POST', `/api/assistant/proposals/${card!.id}/apply`, recovered, { proof: { totp: api.code() } });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.ok((await structureOf(api, first, fixture.companyId)).roles.some((one) => one.slug === 'marketer'));
  } finally {
    await api.close();
  }
});

test('the CEO is told it builds the team, and no longer that a card takes the owner\'s device', async () => {
  const fixture = await createCompany('ceo-builds-brief');
  const model = new ScriptedModel([says('Siap.')]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    await api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Halo' });
    const system = model.requests[0]!.system;
    assert.match(system, /Opening a division, hiring or changing a role/);
    assert.doesNotMatch(system, /Takes the owner's device\./, 'a signed-in owner is the device');
  } finally {
    await api.close();
  }
});
