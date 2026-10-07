/**
 * What a model call costs, to the cent the provider bills (the owner's report
 * of 7 October: "the prices do not match the official ones, so it is all
 * wrong, and the budget runs out all of a sudden").
 *
 * Three things made the ledger higher than the bill, and each was chosen on
 * purpose, to err on the side of the ceiling:
 *
 * - every call was rounded **up to a whole cent, and never below one**, so a
 *   40-turn task on a cheap model cost forty cents when it cost two;
 * - a cached token (Anthropic's cache reads and writes, OpenAI's and
 *   DeepSeek's cached prompts) was priced at the full input rate, where the
 *   provider bills a tenth of it, or a fiftieth;
 * - a model nobody had priced was charged at $15/$75 a million tokens.
 *
 * The first two are the arithmetic and are put right here: a call is priced to
 * the fraction of a cent, its cached tokens at their own rates, and the
 * fractions are carried -- what a company owes below a cent is charged when it
 * adds up to one, so a thousand small calls cost what they add up to. The
 * third is the price list's, and is in model-prices.test.ts.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicClient } from '../../src/llm/anthropic.ts';
import { OpenAiCompatibleClient } from '../../src/llm/openai.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { costOf, parsePriceTable, CostCarry, carryFor, DEFAULT_PRICE_TABLE, CONSERVATIVE_FALLBACK } from '../../src/engine/pricing.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { answering } from '../helpers/done.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { ScriptedModel, say, use } from '../helpers/scripted-model.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

const sonnet = parsePriceTable({ models: { 'claude-sonnet-*': { input: 300, output: 1_500, cacheRead: 30, cacheWrite: 375 } } });
const cheap = parsePriceTable({ models: { 'deepseek-*': { input: 15, output: 60, cacheRead: 0.3 } } });

test('a call is priced to the fraction of a cent, and its cached tokens at their own rates', () => {
  // $3 in, $15 out, a cache read at a tenth of the input and a write at a quarter more.
  const cost = costOf(sonnet, 'claude-sonnet-4-5', { input: 1_000, output: 500, cacheRead: 8_000, cacheWrite: 2_000 });
  // 1000*300 + 8000*30 + 2000*375 + 500*1500, per million.
  near(cost.cents, 2.04);
  assert.equal(cost.basis, 'claude-sonnet-*');
  // The same call with all of it priced as fresh input is the old answer, and dearer.
  near(costOf(sonnet, 'claude-sonnet-4-5', { input: 11_000, output: 500 }).cents, 4.05);
});

test('a cached token the list has no rate for is priced as input: the high side, as before', () => {
  const plain = parsePriceTable({ models: { 'm-*': { input: 100, output: 200 } } });
  near(costOf(plain, 'm-1', { input: 1_000, output: 0, cacheRead: 9_000, cacheWrite: 1_000 }).cents, 11_000 * 100 / 1_000_000);
});

test('a small call on a cheap model is a small fraction, not a cent', () => {
  // $0.15 in, $0.60 out, cache reads at two thousandths of a dollar.
  const cost = costOf(cheap, 'deepseek-chat', { input: 2_000, output: 100 });
  near(cost.cents, 0.036);
  near(costOf(cheap, 'deepseek-chat', { input: 500, output: 100, cacheRead: 7_500 }).cents, (500 * 15 + 100 * 60 + 7_500 * 0.3) / 1_000_000);
  assert.equal(costOf(DEFAULT_PRICE_TABLE, 'x', { input: 0, output: 0 }).cents, 0, 'no tokens, no charge');
  // An unknown model is still not free: the fallback is the top of the market.
  const unknown = costOf(DEFAULT_PRICE_TABLE, 'some-new-model', { input: 1_000_000, output: 0 });
  assert.equal(unknown.basis, 'fallback');
  assert.equal(unknown.cents, CONSERVATIVE_FALLBACK.inputCentsPerMTok);
});

test('a price list may name cache rates, and refuses ones that are not numbers', () => {
  const refused = (raw: unknown) =>
    assert.throws(() => parsePriceTable(raw), (error: unknown) => isPalugadaError(error, 'config.invalid'));
  refused({ models: { 'x-*': { input: 1, output: 1, cacheRead: -1 } } });
  refused({ models: { 'x-*': { input: 1, output: 1, cacheWrite: '3' } } });
  refused({ models: { 'x-*': { input: 1, output: 1, cache: 1 } } });
  const table = parsePriceTable({ models: { 'x-*': { input: 100, output: 200, cacheRead: 10 } } });
  assert.equal(table.rates[0]!.rate.cacheReadCentsPerMTok, 10);
  assert.equal(table.rates[0]!.rate.cacheWriteCentsPerMTok, undefined);
});

test('a thousand small calls are charged what they add up to, and none is lost or charged twice', () => {
  const carry = new CostCarry();
  const charged: number[] = [];
  for (let i = 0; i < 1_000; i += 1) charged.push(carry.charge(0.036));
  assert.equal(charged.reduce((sum, one) => sum + one, 0), 36, 'a thousand calls of 0.036 cents are 36 cents, not 1,000');
  assert.ok(charged.every((one) => Number.isInteger(one) && one >= 0));
  assert.equal(charged.slice(0, 27).reduce((sum, one) => sum + one, 0), 0, 'a cent is charged when it has been owed, not before');
  near(carry.pending, 0);

  // What is owed below a cent is kept, and goes with the next call.
  const next = new CostCarry();
  assert.equal(next.charge(0.6), 0);
  assert.equal(next.charge(0.6), 1);
  near(next.pending, 0.2);
  assert.equal(next.charge(2.9), 3);
  assert.equal(next.charge(0), 0);
  assert.equal(next.charge(-5), 0, 'a negative figure erases nothing');
});

test('what is owed is kept for each company, and a company\'s is its own', () => {
  assert.equal(carryFor('company-a'), carryFor('company-a'));
  assert.notEqual(carryFor('company-a'), carryFor('company-b'));
  assert.equal(carryFor('company-a').charge(0.4), 0);
  assert.equal(carryFor('company-b').charge(0.7), 0, 'not added to the other\'s');
  assert.equal(carryFor('company-a').charge(0.7), 1);
});

/**
 * Through the engine: forty-odd turns of a role on a cheap model are charged
 * what they cost. The model reports 0.25 of a cent a turn, as a provider that
 * bills $0.15 a million would for a 1,000-token turn.
 */
async function started(name: string) {
  const fixture = await createCompany(name);
  const registry = new CapabilityRegistry();
  registry.register<{ zone: string }, { records: string[] }>({
    name: 'dns.read', adapter: 'test:dns', defaultTier: 0, async execute() { return { records: ['192.0.2.7'] }; },
  });
  await registry.sync();
  await grantCapability(fixture, 'dns.read');
  await withTenant(fixture.companyId, (tx) => tx.query('UPDATE roles SET tools = $2 WHERE id = $1', [fixture.roleId, ['dns.read']]));
  return { fixture, registry };
}

let sequence = 0;
async function newTask(fixture: Fixture) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `find the address of example.test (${sequence})` }, createdBy: 'owner', reserveTokens: 50_000,
  });
}

const money = async (fixture: Fixture, taskId: string) => {
  const account = await withTenant(fixture.companyId, (tx) => tx.query<{ spent: string }>(
    'SELECT money_spent_cents AS spent FROM budget_accounts WHERE id = $1', [fixture.budgetAccountId]));
  const traced = await withTenant(fixture.companyId, (tx) => tx.query<{ cents: string; calls: string }>(
    'SELECT coalesce(sum(cost_cents), 0) AS cents, count(*) AS calls FROM llm_traces WHERE task_id = $1', [taskId]));
  return { account: Number(account.rows[0]!.spent), traced: Number(traced.rows[0]!.cents), calls: Number(traced.rows[0]!.calls) };
};

test('a run of small turns is charged what they cost, to the account and to the trace alike', async () => {
  const { fixture, registry } = await started('cost-small-turns');
  const script = [
    ...Array.from({ length: 11 }, (_, i) => use(`call-${i}`, 'dns__read', { zone: `z${i}.test` })),
    (request: { system: string }) => say(answering(request.system, { address: '192.0.2.7' })),
  ];
  // Twelve turns at a quarter of a cent: three cents in all.
  const model = new ScriptedModel(script, { costCents: 0.25 });
  const task = await newTask(fixture);
  const outcome = await new Engine({ broker: new CapabilityBroker(registry), workerId: 'cost-small', llm: model, handlers: new Map() })
    .runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed', outcome.reason);

  const spent = await money(fixture, task.id);
  assert.equal(spent.calls, 12);
  assert.equal(spent.account, 3, 'twelve turns of a quarter of a cent are three cents, not twelve');
  assert.equal(spent.traced, 3, 'and the traces, which every report adds up, say the same');
  // What was left below a cent goes with the next call, wherever it is made.
  near(carryFor(fixture.companyId).pending, 0);
});

/**
 * The two kinds of provider this platform speaks to, answering with what
 * their own usage figures say. What matters here is the price of what the
 * answer reports, not the conversation.
 */
interface Received { headers: IncomingMessage['headers']; body: Record<string, unknown> }

async function provider(bodies: unknown[]) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(data) as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(bodies[Math.min(received.length - 1, bodies.length - 1)]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const asked = { model: 'standard', system: 'The charter.', messages: [{ role: 'user' as const, content: 'The task.' }], tools: [] };

test('the Messages API client prices what the provider bills: cache reads and writes at their own rates', async () => {
  const api = await provider([{
    model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }],
    usage: { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 2_000 },
  }]);
  try {
    const client = new AnthropicClient({ apiKey: 'sk-test-key-0123456789', baseUrl: api.url, prices: sonnet, aliases: { standard: 'claude-sonnet-4-5' } });
    const turn = await client.turn(asked);
    assert.equal(turn.inputTokens, 11_000, 'every prompt token is counted against the token ceiling, cached or not');
    near(turn.costCents, 2.04);
  } finally {
    await api.close();
  }
});

test('the OpenAI-compatible client prices a cached prompt at the cache rate, whoever words it: OpenAI, OpenRouter, DeepSeek', async () => {
  const completion = (usage: Record<string, unknown>) => ({ model: 'deepseek-chat', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage });
  const api = await provider([
    completion({ prompt_tokens: 10_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 9_000 } }),
    completion({ prompt_tokens: 10_000, completion_tokens: 100, prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000 }),
    completion({ prompt_tokens: 10_000, completion_tokens: 100 }),
    completion({ prompt_tokens: 1_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 5_000 } }),
  ]);
  try {
    const client = new OpenAiCompatibleClient({ apiKey: null, baseUrl: api.url, aliases: { standard: 'deepseek-chat' }, prices: cheap });
    const cachedTokens = (1_000 * 15 + 100 * 60 + 9_000 * 0.3) / 1_000_000;
    near((await client.turn(asked)).costCents, cachedTokens);
    near((await client.turn(asked)).costCents, cachedTokens);
    const plain = await client.turn(asked);
    near(plain.costCents, (10_000 * 15 + 100 * 60) / 1_000_000);
    assert.equal(plain.inputTokens, 10_000);
    // A provider that says more was cached than was sent is not believed.
    near((await client.turn(asked)).costCents, (0 + 100 * 60 + 1_000 * 0.3) / 1_000_000);
  } finally {
    await api.close();
  }
});

test('the Messages API client marks the end of the conversation for the provider\'s cache, so a long run is not billed for its start again on every turn', async () => {
  const api = await provider([{ model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }]);
  try {
    const client = new AnthropicClient({ apiKey: 'sk-test-key-0123456789', baseUrl: api.url, aliases: { standard: 'claude-sonnet-4-5' } });
    await client.turn({
      ...asked,
      messages: [
        { role: 'user', content: 'The task.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_0', name: 'dns__read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_0', content: 'a page' }] },
      ],
    });
    const wire = api.received[0]!.body.messages as Array<{ content: Array<Record<string, unknown>> | string }>;
    const marked = (message: (typeof wire)[number]) => (Array.isArray(message.content) ? message.content : []).filter((block) => block.cache_control !== undefined);
    assert.equal(marked(wire[0]!).length + marked(wire[1]!).length, 0, 'what came before the newest message is not marked: the last turn\'s mark is what is read');
    assert.deepEqual(marked(wire[2]!), [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'a page', cache_control: { type: 'ephemeral' } }]);
    assert.ok((api.received[0]!.body.system as Array<{ cache_control?: unknown }>)[0]!.cache_control, 'and the system prompt still is');

    // A conversation of one message, written as a string, is marked all the same.
    await client.turn(asked);
    const only = api.received[1]!.body.messages as Array<{ content: unknown }>;
    assert.deepEqual(only[0]!.content, [{ type: 'text', text: 'The task.', cache_control: { type: 'ephemeral' } }]);
  } finally {
    await api.close();
  }
});
