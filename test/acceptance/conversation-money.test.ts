/**
 * The owner's conversations are paid for before they are made (F19.12,
 * STATUS 2.205).
 *
 * A company's CEO answering its owner was the one model call in the platform
 * that nothing reserved for: its turns were counted after they were made
 * (STATUS 2.78) and never refused, so a company stopped, frozen or out of
 * money still thought aloud at its owner's expense, and the whole of the
 * conversation's history was sent with every turn. These hold that each turn
 * is reserved from the CEO's own account first, in a row a crash cannot lose;
 * that a company that may not spend answers with a sentence of the
 * platform's and no model call, while the inbox goes on deciding; that the
 * history is bounded; and that PALUGADA's own assistant, which no company
 * pays for, stops at the deployment's monthly allowance.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createAccount, reserve } from '../../src/engine/budget.ts';
import { clearStopAll, freezeCompany, requestStopAll, unfreezeCompany } from '../../src/engine/control.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { converse, type AssistantReach } from '../../src/owner/assistant.ts';
import { releaseStaleHolds } from '../../src/owner/conversation-money.ts';
import { TelegramChannel } from '../../src/owner/telegram.ts';
import { RecordingLlmClient, type LlmTurn, type LlmTurnRequest, type ToolUsingLlmClient } from '../../src/llm/client.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

type Line = Pick<LlmTurn, 'content' | 'stopReason'> & Partial<Pick<LlmTurn, 'inputTokens' | 'outputTokens' | 'costCents'>>;
/** One turn of the model: what it answers, made from what it was asked, or a failure it throws. */
type Turn = (request: LlmTurnRequest, signal?: AbortSignal) => Promise<Line>;

/** A model the test writes the turns of; each costs a cent for 1,100 tokens unless the turn says otherwise. */
class Model implements ToolUsingLlmClient {
  readonly requests: LlmTurnRequest[] = [];
  readonly #script: Turn[];

  constructor(script: Turn[]) {
    this.#script = script;
  }

  async turn(request: LlmTurnRequest, signal?: AbortSignal): Promise<LlmTurn> {
    this.requests.push(structuredClone(request));
    const next = this.#script[this.requests.length - 1];
    if (!next) throw new Error(`the script has no turn ${this.requests.length}`);
    return { inputTokens: 1_000, outputTokens: 100, costCents: 1, model: 'scripted-1', ...await next(request, signal) };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

const says = (text: string, usage: Partial<Line> = {}): Turn => async () =>
  ({ content: [{ type: 'text', text }], stopReason: 'end_turn', ...usage });
let reading = 0;
const reads = (path: string, usage: Partial<Line> = {}, during?: (request: LlmTurnRequest) => Promise<void>): Turn => async (request) => {
  await during?.(request);
  reading += 1;
  return { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: `read-${reading}`, name: 'read', input: { path } }], stopReason: 'tool_use', ...usage };
};
const fails = (message: string): Turn => async () => {
  throw new Error(message);
};

/**
 * What a turn may cost before it is made, as the platform reckons it: a
 * quarter of every character it sends -- the instructions, the conversation
 * and the tools -- and all the room the answer is given.
 */
const estimateOf = (request: LlmTurnRequest) =>
  Math.ceil((request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length) / 4) + request.maxTokens!;

const NO_ROOM = "I stopped here: the CEO's budget has no room for the next step.";
const ALLOWANCE_SPENT = "PALUGADA's own conversation has spent this month's allowance. Raise it under This deployment, Model, or ask again next month.";

async function accountOf(companyId: string, accountId: string) {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ tokens_reserved: string; tokens_spent: string; money_spent_cents: string }>(
    'SELECT tokens_reserved, tokens_spent, money_spent_cents FROM budget_accounts WHERE id = $1', [accountId]));
  return { reserved: Number(rows[0]!.tokens_reserved), spent: Number(rows[0]!.tokens_spent), money: Number(rows[0]!.money_spent_cents) };
}

async function holdsOf(companyId: string) {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ budget_account_id: string; tokens: number }>(
    'SELECT budget_account_id, tokens FROM conversation_holds ORDER BY held_at'));
  return rows.map((row) => ({ account: row.budget_account_id, tokens: Number(row.tokens) }));
}

async function tracesOf(companyId: string) {
  return (await withTenant(companyId, (tx) => tx.query<{ cost_cents: number }>('SELECT cost_cents FROM llm_traces'))).rows;
}

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** Says something to the company's CEO in the console, and answers what the CEO said back. */
async function ask(api: Console, token: string, companyId: string, text: string): Promise<string> {
  const said = await api.call('POST', `/api/companies/${companyId}/conversation/messages`, token, { text });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  const last = said.body.messages.at(-1) as { role: string; body: string };
  assert.equal(last.role, 'assistant');
  return last.body;
}

/** The same of PALUGADA's own assistant. */
async function askPalugada(api: Console, token: string, text: string): Promise<string> {
  const said = await api.call('POST', '/api/assistant/messages', token, { text });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  return (said.body.messages.at(-1) as { body: string }).body;
}

test("a CEO answer reserves from the CEO's account before every model turn, and releases what it did not spend", async () => {
  const fixture = await createCompany('talk-reserves');
  // The CEO's division has an account of its own, under the company's: the
  // narrowest account that covers the CEO is the one its turns draw on, and
  // the company's is charged with it.
  const division = await withTenant(fixture.companyId, (tx) => createAccount(tx, {
    companyId: fixture.companyId, label: 'ops', tokensMax: 500_000, moneyMaxCents: 50_000,
    scope: { scopeType: 'division', scopeId: fixture.divisionId, parentAccountId: fixture.budgetAccountId },
  }));
  const seen: Array<{ estimate: number; holds: Array<{ account: string; tokens: number }>; division: number; company: number }> = [];
  const look = async (request: LlmTurnRequest) => {
    seen.push({
      estimate: estimateOf(request),
      holds: await holdsOf(fixture.companyId),
      division: (await accountOf(fixture.companyId, division)).reserved,
      company: (await accountOf(fixture.companyId, fixture.budgetAccountId)).reserved,
    });
  };
  const model = new Model([
    reads(`/api/companies/${fixture.companyId}/structure`, {}, look),
    async (request) => {
      await look(request);
      return says('Semua berjalan baik.')(request);
    },
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    assert.equal(await ask(api, token, fixture.companyId, 'Bagaimana minggu ini?'), 'Semua berjalan baik.');

    assert.equal(model.requests.length, 2);
    assert.equal(seen.length, 2);
    for (const [turn, one] of seen.entries()) {
      assert.ok(one.estimate > 1_500, `turn ${turn + 1} is reserved for what it sends as well as for its answer`);
      // While the model thinks, its reservation is held in a row and in the
      // whole chain of accounts above the CEO's.
      assert.deepEqual(one.holds, [{ account: division, tokens: one.estimate }], `turn ${turn + 1}: one hold, for its estimate`);
      assert.equal(one.division, one.estimate, `turn ${turn + 1}: the division's account holds it`);
      assert.equal(one.company, one.estimate, `turn ${turn + 1}: and so does the company's above it`);
    }
    assert.ok(seen[1]!.estimate > seen[0]!.estimate, 'the second turn sends more, and is reserved for more');

    // Answered, each turn spent what it used -- 1,100 tokens and a cent -- and
    // the rest of its reservation went back.
    assert.deepEqual(await accountOf(fixture.companyId, division), { reserved: 0, spent: 2_200, money: 2 });
    assert.deepEqual(await accountOf(fixture.companyId, fixture.budgetAccountId), { reserved: 0, spent: 2_200, money: 2 });
    assert.deepEqual(await holdsOf(fixture.companyId), [], 'no hold outlives its turn');
    assert.equal((await tracesOf(fixture.companyId)).length, 2, 'each turn is still a trace of the company (STATUS 2.78)');
  } finally {
    await api.close();
  }
});

test('everything stopped, a frozen company and a paused company each answer with a line, not the model', async () => {
  const fixture = await createCompany('talk-refused');
  const name = fixture.slug;
  const model = new Model([says('Everything is set up.')]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();

    await requestStopAll();
    assert.equal(await ask(api, token, fixture.companyId, 'Halo'),
      'I cannot answer now: everything is stopped. Resume it from the console first.');
    // PALUGADA's own conversation is the deployment's, not a company's work:
    // it answers while the companies are stopped, about how to start them.
    assert.equal(await askPalugada(api, token, 'Why did everything stop?'), 'Everything is set up.');
    await clearStopAll();

    await freezeCompany(fixture.companyId);
    assert.equal(await ask(api, token, fixture.companyId, 'Halo'), `I cannot answer now: ${name} is frozen.`);
    await unfreezeCompany(fixture.companyId);

    await withControlPlane((tx) => tx.query(
      `INSERT INTO spend_limits (company_id, money_max_cents, paused_at, pause_reason) VALUES ($1, 100, now(), 'ceiling')
       ON CONFLICT (company_id) DO UPDATE SET paused_at = now(), pause_reason = 'ceiling'`, [fixture.companyId]));
    assert.equal(await ask(api, token, fixture.companyId, 'Halo'),
      `I cannot answer now: ${name}'s spending is paused at its ceiling. Open Money to raise it.`);

    assert.equal(model.requests.length, 1, 'only PALUGADA\'s own assistant was asked');
    assert.deepEqual(await tracesOf(fixture.companyId), [], 'nothing was spent');
    assert.deepEqual(await accountOf(fixture.companyId, fixture.budgetAccountId), { reserved: 0, spent: 0, money: 0 });
    // The owner's words are kept, each with the line that answered them.
    const kept = (await api.call('GET', `/api/companies/${fixture.companyId}/conversation`, token)).body.messages as Array<{ role: string }>;
    assert.deepEqual(kept.map((one) => one.role), ['owner', 'assistant', 'owner', 'assistant', 'owner', 'assistant']);
  } finally {
    await api.close();
  }
});

test('an account with no room refuses the turn with a line, and spends nothing', async () => {
  // Fewer tokens than any turn's instructions take.
  const small = await createCompany('talk-small', { tokensMax: 1_000 });
  // An account whose money is spent leaves no room, however many tokens it has.
  const spent = await createCompany('talk-spent', { moneyMaxCents: 500 });
  await withControlPlane((tx) => tx.query('UPDATE budget_accounts SET money_spent_cents = 500 WHERE id = $1', [spent.budgetAccountId]));
  const model = new Model([]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    assert.equal(await ask(api, token, small.companyId, 'Halo'), NO_ROOM);
    assert.equal(await ask(api, token, spent.companyId, 'Halo'), NO_ROOM);
    assert.equal(model.requests.length, 0, 'no model was called');
    assert.deepEqual(await accountOf(small.companyId, small.budgetAccountId), { reserved: 0, spent: 0, money: 0 });
    assert.deepEqual(await accountOf(spent.companyId, spent.budgetAccountId), { reserved: 0, spent: 0, money: 500 });
    assert.deepEqual([...await holdsOf(small.companyId), ...await holdsOf(spent.companyId)], []);
    assert.deepEqual([...await tracesOf(small.companyId), ...await tracesOf(spent.companyId)], []);
  } finally {
    await api.close();
  }
});

test('a turn that would pass the ceiling ends the answer where it is', async () => {
  // The first turn uses nearly all of the account's million tokens, so the
  // second has no room left to be reserved in.
  const tokens = await createCompany('talk-tokens');
  // The first turn costs five cents, and the account has three: its spend is
  // refused after the call, so the answer goes no further.
  const money = await createCompany('talk-money', { moneyMaxCents: 3 });
  const model = new Model([
    reads(`/api/companies/${tokens.companyId}/structure`, { inputTokens: 990_000 }),
    says('Not reached.'),
    reads(`/api/companies/${money.companyId}/structure`, { costCents: 5 }),
    says('Not reached either.'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    assert.equal(await ask(api, token, tokens.companyId, 'Bagaimana minggu ini?'), `Looking.\n\n${NO_ROOM}`);
    assert.equal(model.requests.length, 1, 'the second turn was never asked');
    assert.deepEqual(await accountOf(tokens.companyId, tokens.budgetAccountId), { reserved: 0, spent: 990_100, money: 1 });

    assert.equal(await ask(api, token, money.companyId, 'Dan uangnya?'), `Looking.\n\n${NO_ROOM}`);
    assert.equal(model.requests.length, 2, 'nor was the turn after a call the account could not pay for');
    // The call was made, so it is a trace the month's ceiling reads; the
    // account refused it, so nothing moved there, and nothing is held.
    assert.deepEqual((await tracesOf(money.companyId)).map((row) => row.cost_cents), [5]);
    assert.deepEqual(await accountOf(money.companyId, money.budgetAccountId), { reserved: 0, spent: 0, money: 0 });
    assert.deepEqual([...await holdsOf(tokens.companyId), ...await holdsOf(money.companyId)], []);
  } finally {
    await api.close();
  }
});

test('a failed model call releases its reservation', async () => {
  const fixture = await createCompany('talk-failed');
  const model = new Model([fails('the provider closed the connection')]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    assert.equal(await ask(api, token, fixture.companyId, 'Halo'), 'The model did not answer: the provider closed the connection');
  } finally {
    await api.close();
  }
  assert.deepEqual(await accountOf(fixture.companyId, fixture.budgetAccountId), { reserved: 0, spent: 0, money: 0 });
  assert.deepEqual(await holdsOf(fixture.companyId), []);

  // And an answer the owner stopped while the model was thinking -- the stop
  // button under a Telegram draft -- lets its turn's reservation go too.
  const stop = new AbortController();
  const stopped = new Model([async () => {
    stop.abort();
    throw new DOMException('The operation was aborted.', 'AbortError');
  }]);
  const nowhere: AssistantReach = { routeOf: () => null, get: async () => null, post: async () => null, readable: () => [] };
  const said = await converse({ llm: stopped, reach: nowhere, language: async () => 'en', companyId: fixture.companyId, signal: stop.signal },
    'Halo', 'telegram');
  assert.deepEqual([said.at(-1)!.role, said.at(-1)!.body], ['event', 'The owner stopped the answer.']);
  assert.equal(stopped.requests.length, 1);
  assert.deepEqual(await accountOf(fixture.companyId, fixture.budgetAccountId), { reserved: 0, spent: 0, money: 0 });
  assert.deepEqual(await holdsOf(fixture.companyId), []);
});

test('a turn whose process dies leaves a hold that the sweep releases', async () => {
  const { Worker } = await import('../../src/worker.ts');
  const { Engine } = await import('../../src/engine/engine.ts');
  const { CapabilityBroker } = await import('../../src/broker/broker.ts');
  const { CapabilityRegistry } = await import('../../src/broker/registry.ts');
  const fixture = await createCompany('talk-crash');
  // Another holder's reservation, which no release of the conversation's may take.
  await withTenant(fixture.companyId, (tx) => reserve(tx, fixture.budgetAccountId, 1_000));

  // The model never answers until the test says so: from the database's side,
  // that is a process killed in the middle of the call.
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const model = new Model([async () => {
    await answered;
    return { content: [{ type: 'text', text: 'Late.' }], stopReason: 'end_turn' };
  }]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const asking = api.call('POST', `/api/companies/${fixture.companyId}/conversation/messages`, token, { text: 'Halo' });
    while (model.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const [held] = await holdsOf(fixture.companyId);
    assert.ok(held, 'the turn is held in a row while the model thinks');
    assert.equal(held.tokens, estimateOf(model.requests[0]!));
    assert.equal((await accountOf(fixture.companyId, fixture.budgetAccountId)).reserved, 1_000 + held.tokens);

    // A hold younger than any live turn is left alone.
    assert.equal(await releaseStaleHolds(fixture.companyId, new Date()), 0);
    assert.equal((await holdsOf(fixture.companyId)).length, 1);

    // The worker's sweep, run as if the process had been gone for most of an
    // hour, lets it go: the account has back what the dead turn held.
    const worker = new Worker({
      engine: new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), llm: new RecordingLlmClient(), handlers: new Map() }),
      companyId: fixture.companyId,
    });
    const report = await worker.tick(new Date(Date.now() + 46 * 60_000), { runs: false });
    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.deepEqual(await holdsOf(fixture.companyId), []);
    assert.equal((await accountOf(fixture.companyId, fixture.budgetAccountId)).reserved, 1_000);

    // Should the turn come back after all, it spends what it used, and takes
    // nothing from the reservation the sweep already gave back.
    answer();
    const said = await asking;
    assert.equal(said.status, 200, JSON.stringify(said.body));
    assert.equal(said.body.messages.at(-1).body, 'Late.');
    assert.deepEqual(await accountOf(fixture.companyId, fixture.budgetAccountId), { reserved: 1_000, spent: 1_100, money: 1 });
  } finally {
    answer();
    await api.close();
  }
});

/** Writes a conversation that already happened, oldest first, a minute apart, ending a minute ago. */
async function happened(companyId: string, bodies: string[]): Promise<void> {
  await withControlPlane(async (tx) => {
    for (const [at, body] of bodies.entries()) {
      await tx.query(
        `INSERT INTO assistant_messages (role, channel, body, company_id, at)
         VALUES ($1, 'console', $2, $3, now() - make_interval(mins => $4))`,
        [at % 2 === 0 ? 'owner' : 'assistant', body, companyId, bodies.length - at]);
    }
  });
}

const marker = (n: number) => `[m${String(n).padStart(2, '0')}]`;

test("the history sent to the model is bounded by length, newest kept, the owner's line always in", async () => {
  const long = await createCompany('talk-long');
  const many = await createCompany('talk-many');
  const huge = await createCompany('talk-huge');
  // Twelve messages of 2,500 characters: with the owner's line of 4,000, the
  // newest eight fill the 24,000 characters a turn is given, and the oldest
  // four are left out.
  await happened(long.companyId, Array.from({ length: 12 }, (_, at) => `${marker(at + 1)} ${'a'.repeat(2_500 - 6)}`));
  // Forty short ones: only the newest thirty, as before.
  await happened(many.companyId, Array.from({ length: 40 }, (_, at) => `${marker(at + 1)} short`));
  // A long answer that no longer fits in the room the newer messages leave:
  // it is left out, and so is everything older, which would fit, since what
  // is sent is the end of the conversation and never a conversation with a
  // gap in it.
  await happened(huge.companyId, [`${marker(1)} short`, `${marker(2)} ${'h'.repeat(15_000 - 6)}`, `${marker(3)} ${'s'.repeat(6_000 - 6)}`]);
  const model = new Model([says('Baik.'), says('Baik.'), says('Baik.')]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const line = `[now] ${'o'.repeat(4_000 - 6)}`;
    const sent = (index: number) => {
      const request = model.requests[index]!;
      return { text: `${request.system}\n${JSON.stringify(request.messages)}`, last: request.messages.at(-1)!.content as string };
    };

    await ask(api, token, long.companyId, line);
    const first = sent(0);
    for (let n = 1; n <= 12; n += 1) {
      assert.equal(first.text.includes(marker(n)), n > 4, `${marker(n)} ${n > 4 ? 'is kept' : 'is left out'}`);
    }
    assert.equal(first.last, line, "the owner's line is the last thing sent");
    const replayed = model.requests[0]!.messages.reduce((sum, one) => sum + (typeof one.content === 'string' ? one.content.length : 0), 0);
    assert.equal(replayed, 24_000, 'eight messages of 2,500 and the line of 4,000');

    await ask(api, token, many.companyId, 'Halo');
    const second = sent(1);
    for (let n = 1; n <= 40; n += 1) assert.equal(second.text.includes(marker(n)), n > 10, marker(n));

    await ask(api, token, huge.companyId, line);
    const third = sent(2);
    assert.equal(third.text.includes(marker(2)), false, 'an answer too long for the room left is not sent');
    assert.equal(third.text.includes(marker(1)), false, 'nor is anything older than it');
    assert.deepEqual(model.requests[2]!.messages.map((one) => one.content), [`${marker(3)} ${'s'.repeat(6_000 - 6)}\n\n${line}`],
      "the owner's newest words and their line, sent together as one turn of theirs");
  } finally {
    await api.close();
  }
});

/** What PALUGADA's own conversation cost, as an answer of last month or of this one. */
async function palugadaSpent(cents: number, when: 'this month' | 'last month'): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `INSERT INTO assistant_messages (role, channel, body, company_id, cost_cents, at)
     VALUES ('assistant', 'console', 'An answer.', NULL, $1, CASE WHEN $2 THEN now() ELSE date_trunc('month', now()) - interval '1 day' END)`,
    [cents, when === 'this month']));
}

test("PALUGADA's own conversation stops before a turn that would pass the deployment's monthly allowance, which is twenty dollars until the owner changes it", async () => {
  const model = new Model([
    says('Last month is not this one.'),
    says('Raised, so I can answer.'),
    reads('/api/control/setup', { costCents: 2_999 }),
    says('Not reached.'),
  ]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    const allowance = async () => (await api.call('GET', '/api/control/assistant-allowance', token)).body;
    assert.deepEqual(await allowance(), { monthCents: 2_000, spentThisMonthCents: 0 }, 'twenty dollars, until the owner says otherwise');

    // Last month's spend is last month's.
    await palugadaSpent(1_999, 'last month');
    assert.equal(await askPalugada(api, token, 'Is anything missing?'), 'Last month is not this one.');
    assert.deepEqual(await allowance(), { monthCents: 2_000, spentThisMonthCents: 1 });

    // With the allowance spent, no turn fits.
    await palugadaSpent(1_999, 'this month');
    assert.equal(await askPalugada(api, token, 'And now?'), ALLOWANCE_SPENT);
    assert.equal(model.requests.length, 1, 'no model was asked');

    // The owner raises it, with their device, and it answers again.
    const raised = await api.call('POST', '/api/control/assistant-allowance', token, { monthCents: 5_000, proof: { totp: api.code() } });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.deepEqual(await allowance(), { monthCents: 5_000, spentThisMonthCents: 2_000 });
    assert.equal(await askPalugada(api, token, 'And now?'), 'Raised, so I can answer.');

    // Checked before every turn, the answer's own turns counted: a turn that
    // spent all that was left is the last one.
    assert.equal(await askPalugada(api, token, 'Look at the setup.'), `Looking.\n\n${ALLOWANCE_SPENT}`);
    assert.equal(model.requests.length, 3);

    // Nothing is a bad allowance; nothing switches the conversation off.
    for (const bad of [-1, 1.5, 'lots', null, 3_000_000_000]) {
      const refused = await api.call('POST', '/api/control/assistant-allowance', token, { monthCents: bad });
      assert.equal(refused.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(refused.body)}`);
    }
    const off = await api.call('POST', '/api/control/assistant-allowance', token, { monthCents: 0 });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await allowance()).monthCents, 0);
    assert.equal(await askPalugada(api, token, 'Hello?'), ALLOWANCE_SPENT);
    assert.equal(model.requests.length, 3);
  } finally {
    await api.close();
  }
});

/** The Bot API, as the channel reaches it: every call kept and answered. */
function fakeBot() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let next = 100;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = String(input).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'our_bot' } });
    return Response.json({ ok: true, result: { message_id: next++ } });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    answers: () => calls.filter((call) => call.method === 'sendRichMessage')
      .map((call) => (call.body as { rich_message: { markdown: string } }).rich_message.markdown),
  };
}

test('an answer asked from Telegram is held to the same money', async () => {
  const fixture: Fixture = await createCompany('talk-telegram', { tokensMax: 1_000 });
  const model = new Model([]);
  const bot = fakeBot();
  const channel = new TelegramChannel({
    token: 'bot-token-1234567890', chatId: '55555', webhookSecret: 'webhook-secret', apiBase: 'https://bot.test', fetch: bot.fetch,
    consoleUrl: 'https://app.palugada.test/',
  });
  const api = await consoleWithSettings({ assistant: { llm: model }, telegram: channel });
  let update = 0;
  const write = async (text: string) => {
    update += 1;
    const response = await fetch(`${api.url}/api/channels/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'webhook-secret' },
      body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 55555 }, chat: { id: 55555, type: 'private' }, text } }),
    });
    assert.equal(response.status, 200);
    await channel.settled();
    return bot.answers().at(-1) ?? '';
  };
  try {
    assert.ok((await write('Halo')).includes(NO_ROOM), bot.answers().join('\n'));
    await freezeCompany(fixture.companyId);
    assert.ok((await write('Halo lagi')).includes(`I cannot answer now: ${fixture.slug} is frozen.`), bot.answers().join('\n'));
    assert.equal(model.requests.length, 0, 'no model was called from the chat either');
    assert.deepEqual(await holdsOf(fixture.companyId), []);
  } finally {
    await api.close();
  }
});

test('the inbox decides while the conversation is refused', async () => {
  const fixture = await createCompany('talk-inbox');
  const model = new Model([]);
  const api = await consoleWithSettings({ assistant: { llm: model } });
  try {
    const token = await api.signIn();
    await withControlPlane((tx) => tx.query(
      `INSERT INTO spend_limits (company_id, money_max_cents, paused_at, pause_reason) VALUES ($1, 100, now(), 'ceiling')
       ON CONFLICT (company_id) DO UPDATE SET paused_at = now(), pause_reason = 'ceiling'`, [fixture.companyId]));
    await requestStopAll();
    assert.match(await ask(api, token, fixture.companyId, 'Halo'), /^I cannot answer now: everything is stopped/);

    // Stopped and paused, the owner's decisions are still theirs to make.
    const first = await inbox.raiseEscalation({ companyId: fixture.companyId, title: 'Which supplier did you mean?', detail: 'Two match.' });
    const decided = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${first}/decide`, token, { decision: 'deny', note: 'neither' });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    await clearStopAll();
    assert.match(await ask(api, token, fixture.companyId, 'Halo'), /spending is paused at its ceiling/);
    const second = await inbox.raiseEscalation({ companyId: fixture.companyId, title: 'Which courier?', detail: 'Two quote the same.' });
    const again = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${second}/decide`, token, { decision: 'deny', note: 'neither' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await inbox.listOpen(fixture.companyId), []);
    assert.equal(model.requests.length, 0);
  } finally {
    await clearStopAll();
    await api.close();
  }
});
