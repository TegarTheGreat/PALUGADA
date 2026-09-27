/**
 * Any model the owner chooses (F13.6, F13.1).
 *
 * The platform could run on Anthropic's API and no other. Most of what a
 * company would choose -- OpenAI, OpenRouter's catalogue, Groq, DeepSeek,
 * Gemini's compatible endpoint, a model on its own machine through Ollama or
 * vLLM -- speaks the OpenAI-compatible Chat Completions API, and these hold
 * the client for it, and a whole company running on it without a key.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { OpenAiCompatibleClient } from '../../src/llm/openai.ts';
import { modelSettingsFrom } from '../../src/llm/models.ts';
import { ProviderFailure } from '../../src/runtime/wire.ts';
import { parsePriceTable } from '../../src/engine/pricing.ts';
import { createRootTask, getTask } from '../../src/engine/tasks.ts';
import { createCompanyFromTemplate } from '../../src/templates/company.ts';
import { STANDARD_TEMPLATE_SLUG } from '../../src/templates/standard.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { answering } from '../helpers/done.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface Received { headers: IncomingMessage['headers']; body: Record<string, unknown> }

/** A Chat Completions server whose answers the test decides, from what it was sent. */
async function chatServer(answer: (body: Record<string, unknown>, index: number) => { status?: number; body: unknown }) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ headers: req.headers, body });
      const reply = answer(body, received.length - 1);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const completion = (message: Record<string, unknown>, finish = 'stop') => ({
  body: {
    model: 'served-model-1',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 1_200, completion_tokens: 80 },
  },
});

test('the client speaks Chat Completions: tools as functions, their answers as tool messages, a tier resolved', async () => {
  const api = await chatServer(() => completion({
    content: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'dns__read', arguments: '{"zone":"example.test"}' } },
      { id: 'call_2', type: 'function', function: { name: 'dns__read', arguments: '{not json' } },
    ],
  }, 'tool_calls'));
  try {
    const client = new OpenAiCompatibleClient({
      apiKey: 'sk-openai-compatible-0123',
      baseUrl: `${api.url}/`,
      aliases: { standard: 'gpt-something' },
      prices: parsePriceTable({ models: { 'served-model-*': { input: 100, output: 400 } } }),
    });
    const turn = await client.turn({
      model: 'standard',
      system: 'The charter.',
      messages: [
        { role: 'user', content: 'The task.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'call_0', name: 'dns__read', input: { zone: 'a.test' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_0', content: 'refused', isError: true }] },
      ],
      tools: [{ name: 'dns__read', description: 'Reads DNS.', inputSchema: { type: 'object' } }],
    });

    const [sent] = api.received;
    assert.equal(sent!.headers.authorization, 'Bearer sk-openai-compatible-0123');
    assert.equal(sent!.body.model, 'gpt-something');
    assert.equal(sent!.body.max_tokens, 8_192, 'the name every compatible server knows');
    assert.deepEqual(sent!.body.messages, [
      { role: 'system', content: 'The charter.' },
      { role: 'user', content: 'The task.' },
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'dns__read', arguments: '{"zone":"a.test"}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: 'Error: refused' },
    ]);
    assert.deepEqual(sent!.body.tools, [{ type: 'function', function: { name: 'dns__read', description: 'Reads DNS.', parameters: { type: 'object' } } }]);

    assert.equal(turn.stopReason, 'tool_use');
    assert.deepEqual(turn.content, [
      { type: 'tool_use', id: 'call_1', name: 'dns__read', input: { zone: 'example.test' } },
      { type: 'tool_use', id: 'call_2', name: 'dns__read', input: { unparsedArguments: '{not json' } },
    ], 'arguments that do not parse reach the broker as they came, and are refused there with a reason');
    assert.equal(turn.model, 'served-model-1');
    // 1,200 x 100 + 80 x 400 per million = 0.152 cents, rounded up.
    assert.equal(turn.costCents, 1);
  } finally {
    await api.close();
  }
});

test('a model on the company\'s own machine needs no key, and a refused key is said plainly', async () => {
  const local = await chatServer(() => completion({ content: 'hello' }));
  try {
    const client = new OpenAiCompatibleClient({ apiKey: null, baseUrl: local.url, aliases: { fast: 'llama3.2' } });
    const answer = await client.complete({ model: 'fast', system: 's', messages: [{ role: 'user', content: 'u' }] });
    assert.equal(answer.content, 'hello');
    assert.equal(local.received[0]!.headers.authorization, undefined);
    assert.equal(local.received[0]!.body.model, 'llama3.2');
  } finally {
    await local.close();
  }

  const busy = await chatServer(() => ({ status: 503, body: { error: 'overloaded' } }));
  try {
    const client = new OpenAiCompatibleClient({ apiKey: 'k-0123456789', baseUrl: busy.url, aliases: {}, retryDelayMs: () => 0 });
    await assert.rejects(client.complete({ model: 'm', system: 's', messages: [{ role: 'user', content: 'u' }] }),
      (error: unknown) => error instanceof ProviderFailure);
    assert.equal(busy.received.length, 3, 'tried three times, then left to the fallback model');
  } finally {
    await busy.close();
  }

  const refused = await chatServer(() => ({ status: 401, body: { error: 'bad key' } }));
  try {
    const client = new OpenAiCompatibleClient({ apiKey: 'wrong-key-0123', baseUrl: refused.url, aliases: {} });
    await assert.rejects(client.complete({ model: 'm', system: 's', messages: [{ role: 'user', content: 'u' }] }),
      (error: unknown) => isPalugadaError(error, 'model.unavailable') && /PALUGADA_MODEL_KEY_REF/.test((error as Error).message));
  } finally {
    await refused.close();
  }
});

test('what servers differ in is met: calls with no id, an answer cut off, OpenAI\'s own name for the limit', async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fake = (answer: unknown): typeof fetch => async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // A small server that numbers nothing: each answer must still be matched to its call.
  const unnumbered = new OpenAiCompatibleClient({
    apiKey: null, baseUrl: 'http://localhost:8000/v1', aliases: {},
    fetch: fake({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { type: 'function', function: { name: 'a', arguments: '{}' } },
      { type: 'function', function: { name: 'b', arguments: '' } },
    ] } }] }),
  });
  const calls = await unnumbered.turn({ model: 'm', system: 's', messages: [{ role: 'user', content: 'u' }], tools: [] });
  assert.deepEqual(calls.content.map((block) => (block.type === 'tool_use' ? block.id : null)), ['call_0', 'call_1']);

  // OpenAI's own API refuses `max_tokens` for its reasoning models.
  const openai = new OpenAiCompatibleClient({
    apiKey: 'sk-0123456789', aliases: {},
    fetch: fake({ choices: [{ finish_reason: 'length', message: { content: 'and then the' } }] }),
  });
  const cut = await openai.turn({ model: 'm', system: 's', messages: [{ role: 'user', content: 'u' }], tools: [], maxTokens: 64 });
  assert.equal(sent[1]!.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent[1]!.body.max_completion_tokens, 64);
  assert.equal(sent[1]!.body.max_tokens, undefined);
  assert.equal(cut.stopReason, 'max_tokens', 'an answer cut off at the limit is not a finished one');
});

test('the environment names the provider and the models, and a half-named one stops the boot', () => {
  assert.equal(modelSettingsFrom({}), null, 'no model named, none configured');
  assert.equal(modelSettingsFrom({ PALUGADA_MODEL_KEY_REF: 'env://PALUGADA_SECRET_K' })!.provider, 'anthropic');

  const local = modelSettingsFrom({ PALUGADA_MODEL_PROVIDER: 'openai', PALUGADA_MODEL_URL: 'http://localhost:11434/v1', PALUGADA_MODEL: 'qwen3:8b' })!;
  assert.deepEqual(local.aliases, { fast: 'qwen3:8b', standard: 'qwen3:8b', deep: 'qwen3:8b' });
  const mixed = modelSettingsFrom({
    PALUGADA_MODEL_PROVIDER: 'openai', PALUGADA_MODEL: 'small', PALUGADA_MODEL_ALIASES: '{"deep":"large"}',
  })!;
  assert.deepEqual([mixed.aliases.fast, mixed.aliases.deep, mixed.url], ['small', 'large', 'https://api.openai.com/v1']);

  assert.throws(() => modelSettingsFrom({ PALUGADA_MODEL_PROVIDER: 'openai', PALUGADA_MODEL_ALIASES: '{"fast":"a"}' }),
    (error: unknown) => isPalugadaError(error, 'config.invalid') && /name standard, deep in PALUGADA_MODEL_ALIASES/.test((error as Error).message));
  assert.throws(() => modelSettingsFrom({ PALUGADA_MODEL_PROVIDER: 'cohere' }), /not one this platform speaks/);
  assert.throws(() => modelSettingsFrom({ PALUGADA_MODEL_PROVIDER: 'openai', PALUGADA_MODEL_URL: 'file:///etc/passwd', PALUGADA_MODEL: 'm' }),
    /is not an http\(s\) URL/);
  assert.throws(() => modelSettingsFrom({ PALUGADA_MODEL_PROVIDER: 'anthropic' }), /needs PALUGADA_MODEL_KEY_REF/);
});

test('a standard company runs itself on any compatible model: the coordinator hands the work on and reports what came back', async () => {
  // A model that plays each role by what its system prompt says it is, as a
  // real one would: the coordinator routes to the marketer and waits; the
  // marketer does the work; the coordinator reports the result.
  const api = await chatServer((body) => {
    const messages = body.messages as Array<{ role: string; content: string | null }>;
    const system = String(messages[0]!.content);
    const told = messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
    if (/where work arrives when the owner did not say who should do it/.test(system)) {
      if (told.length === 0) {
        return completion({ content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'task__delegate', arguments: JSON.stringify({ role: 'marketer', brief: 'Draft the note telling customers the 1 kg bags are back.' }) } }] }, 'tool_calls');
      }
      const childId = /"childId":"([^"]+)"/.exec(told[0]!)?.[1];
      const awaited = told.find((text) => /"summary"/.test(text) && /"status":"completed"/.test(text));
      if (!awaited) {
        return completion({ content: null, tool_calls: [{ id: `a${told.length}`, type: 'function', function: { name: 'task__await', arguments: JSON.stringify({ childId }) } }] }, 'tool_calls');
      }
      return completion({ content: answering(system, { summary: 'Growth drafted the restock note; it is ready for you to read.' }) });
    }
    return completion({ content: answering(system, { summary: 'Drafted the restock note for the 1 kg bags.', artefacts: ['restock-note'] }) });
  });

  const { start } = await import('../../src/main.ts');
  const deployment = await start({
    port: 0,
    env: { PALUGADA_MODEL_PROVIDER: 'openai', PALUGADA_MODEL_URL: api.url, PALUGADA_MODEL: 'local-model' },
    worker: { idleMs: 25 },
    log: () => undefined,
  });
  try {
    assert.ok(deployment.notes.some((note) => /model: openai at .* standard = local-model/.test(note)), deployment.notes.join('\n'));
    const company = await createCompanyFromTemplate({
      templateSlug: STANDARD_TEMPLATE_SLUG, companySlug: 'runs-on-anything', name: 'Runs On Anything', timezone: 'Asia/Jakarta',
    });
    const task = await createRootTask({
      companyId: company.companyId, projectId: company.projectIds.main!, divisionId: company.divisionIds.ops!,
      roleId: company.roleIds.coordinator!, goalId: company.goalIds.deliver!,
      input: { goal: 'Tell our customers the 1 kg bags are back' }, createdBy: 'owner', reserveTokens: 20_000,
    });

    let finished = null as Awaited<ReturnType<typeof getTask>>;
    for (let waited = 0; waited < 30_000; waited += 100) {
      finished = await withTenant(company.companyId, (tx) => getTask(tx, task.id));
      if (finished && ['completed', 'failed', 'halted', 'cancelled'].includes(finished.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(finished!.status, 'completed', JSON.stringify(finished));
    assert.match(String(finished!.output?.summary), /Growth drafted the restock note/);
    const children = await withTenant(company.companyId, (tx) => tx.query<{ status: string; role: string; output: { summary: string } }>(
      `SELECT t.status, r.slug AS role, t.output FROM tasks t JOIN roles r ON r.id = t.role_id WHERE t.parent_task_id = $1`, [task.id]));
    assert.deepEqual(children.rows.map((row) => [row.role, row.status]), [['marketer', 'completed']]);
    assert.ok(api.received.every((request) => request.headers.authorization === undefined), 'no key was needed or sent');
  } finally {
    await deployment.stop();
    await api.close();
  }
});
