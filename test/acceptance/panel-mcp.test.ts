/**
 * MCP servers from the console (F13.4, F8.4, F8.9).
 *
 * The allow-list of a server's tools was a file an operator wrote by hand,
 * with each tool's pin copied from a boot note. The owner asked to set
 * everything up from the panel, the way Hermes adds an MCP server. These hold
 * the console to the same rules the file keeps: the owner sees what each tool
 * does and what the server says of it before allowing any; the pin is taken
 * from what the server offers now rather than typed; a tool is allowed only as
 * far as the rules allow; the server's token is sealed; and a server the
 * console saved that no longer passes is left out at the next start, with a
 * note, rather than stopping it.
 */
import { test, before, beforeEach, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accessFor, assertPlainHttpIsLocal, bindMcpServers, closeMcpSessions, pinOf } from '../../src/capabilities/mcp.ts';
import { MCP_PRESETS } from '../../src/capabilities/mcp-presets.ts';
import { readSettings } from '../../src/settings/store.ts';
import { withSettings } from '../../src/settings/overlay.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { mcpServer, TOOLS } from '../helpers/mcp-server.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const TOKEN = 'mcp-token-0123456789abcdef';

/** A server with its own token is not sent a division's credential. */
const noDivisionCredential = async (): Promise<string> => {
  throw new Error('a division credential was asked for');
};

/** A write, allowed at tier 2 with the read-back its link can be checked by. */
const LINK = {
  tier: 2,
  verify: { tool: 'get_payment_link', arguments: { id: '{result.id}' }, matches: { path: 'body.amount', equalsPath: 'input.amount' } },
};

/**
 * A server's connection carries its token to that server and nowhere else.
 * A redirect was followed with it -- and a header of the server's own naming,
 * such as x-api-key, is not one fetch drops on the way to another host --
 * and plain http took it across the internet in the clear.
 */
test('a server that sends its caller elsewhere is not followed there, and one outside this network is reached over https (security)', async () => {
  const target = await mcpServer({ needsToken: TOKEN, tokenIn: { header: 'x-api-key' } });
  const seen: string[] = [];
  const bouncer = createServer((req, res) => {
    seen.push(String(req.headers['x-api-key'] ?? ''));
    res.writeHead(307, { location: target.url }).end();
  });
  await new Promise<void>((resolve) => bouncer.listen(0, '127.0.0.1', resolve));
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const bounced = await api.call('POST', '/api/control/mcp/inspect', token,
      { url: `http://127.0.0.1:${(bouncer.address() as AddressInfo).port}/mcp`, token: TOKEN, tokenIn: { header: 'x-api-key' } });
    assert.match(String(bounced.body.problem), /sent this request elsewhere .*save the address it points to instead/);
    assert.deepEqual(seen, [TOKEN], 'the token went to the address the owner gave');
    assert.deepEqual(target.state.authorizations, [], 'and not on to the one it was sent to');

    const plain = await api.call('POST', '/api/control/mcp/inspect', token, { url: 'http://mcp.example.com/mcp', token: TOKEN });
    assert.equal(plain.status, 400, JSON.stringify(plain.body));
    assert.match(String(plain.body.error), /mcp\.example\.com is reached over https/);
    for (const local of ['http://localhost:8931/mcp', 'http://playwright:8931/mcp', 'http://10.0.0.5/mcp', 'http://tools.internal/mcp']) {
      assert.doesNotThrow(() => assertPlainHttpIsLocal(local), local);
    }
  } finally {
    await new Promise<void>((resolve) => bouncer.close(() => resolve()));
    await target.close();
    await api.close();
  }
});

test('the owner looks at a server\'s tools before allowing any: what each does, what the server says of it, and a tier to start from', async () => {
  const server = await mcpServer({ needsToken: TOKEN });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const refused = await api.call('POST', '/api/control/mcp/inspect', token, { url: server.url });
    assert.equal(refused.status, 200);
    assert.match(String(refused.body.problem), /answered 401/, 'a server that wants a token says so, in its own words');

    const looked = await api.call('POST', '/api/control/mcp/inspect', token, { url: server.url, token: TOKEN });
    assert.equal(looked.body.problem, null, JSON.stringify(looked.body));
    const byName = Object.fromEntries((looked.body.tools as Array<{ name: string; suggestedTier: number }>).map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(byName).sort(), TOOLS.map((tool) => tool.name).sort());
    assert.deepEqual(byName.get_transaction, {
      name: 'get_transaction', description: 'Reads a transaction by its order id.', arguments: ['orderId'],
      reads: true, destructive: false, suggestedTier: 0,
    });
    assert.equal(byName.create_payment_link!.suggestedTier, 2, 'a write starts where the owner decides');
    assert.equal(byName.refund_everything!.suggestedTier, 3, 'what the server calls destructive starts at tier 3');
    assert.ok(!JSON.stringify(looked.body).includes(TOKEN), 'the token is not echoed');
    assert.equal((await readSettings()).mcp, undefined, 'looking saves nothing');
    await assert.rejects(api.secrets.resolve('db://mcp-payments'), /nothing is stored/);
  } finally {
    await api.close();
    await server.close();
  }
});

/**
 * A server's name may hold `_`, and a sealed secret's may not: a server named
 * `pay_links` with a token could not be saved -- the token's secret was
 * refused as a name -- though the console offered the name.
 */
test('a server whose name holds _ keeps its token', async () => {
  const server = await mcpServer({ needsToken: TOKEN });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const saved = await api.call('POST', '/api/control/mcp/servers', token, {
      name: 'pay_links', url: server.url, token: TOKEN, tools: { get_transaction: { tier: 0 } }, proof: { totp: api.code() },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const looked = await api.call('POST', '/api/control/mcp/inspect', token, { name: 'pay_links' });
    assert.equal(looked.body.problem, null, JSON.stringify(looked.body));
  } finally {
    await server.close();
    await api.close();
  }
});

test('a server is saved only as far as the rules allow, its tools pinned to what they are now', async () => {
  const server = await mcpServer({ needsToken: TOKEN });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const save = (tools: Record<string, unknown>, extra: Record<string, unknown> = {}) => api.call('POST', '/api/control/mcp/servers', token,
      { name: 'payments', url: server.url, token: TOKEN, tools, ...extra });

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ create_payment_link: { tier: 0 } }, /tier 0, and the server does not say it only reads/],
      [{ refund_everything: { tier: 2, verify: { tool: 'get_transaction', matches: { present: 'body.status' } } } }, /says refund_everything is destructive; bind it at tier 3/],
      [{ create_payment_link: { tier: 2 } }, /names no read-back \(F8\.4\)/],
      [{ create_payment_link: { tier: 2, verify: { tool: 'no_such_reader', matches: { present: 'body.id' } } } }, /reads back with no_such_reader, which the server does not offer/],
      [{ no_such_tool: { tier: 0 } }, /does not offer a tool named no_such_tool/],
      [{}, /allows none of its tools/],
    ];
    for (const [tools, why] of cases) {
      const refused = await save(tools);
      assert.equal(refused.status, 400, JSON.stringify(tools));
      assert.match(String(refused.body.error), why);
    }
    const badName = await save({ get_transaction: { tier: 0 } }, { name: 'Payments Server' });
    assert.equal(badName.status, 400);
    assert.match(String(badName.body.error), /letters, digits/);
    assert.equal((await readSettings()).mcp, undefined, 'nothing refused was kept');

    const saved = await save({ get_transaction: { tier: 0 }, create_payment_link: LINK });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const stored = (await readSettings()).mcp as { servers: Array<{ name: string; tokenSecret?: string; tools: Record<string, { pin?: string; tier: number }> }> };
    assert.equal(stored.servers[0]!.tools.create_payment_link!.pin, pinOf(TOOLS[1]!), 'pinned to what the server offers now, not to anything typed');
    assert.equal(stored.servers[0]!.tools.get_transaction!.pin, pinOf(TOOLS[0]!), 'a read is pinned too: its description is what the model is told');
    assert.equal(await api.secrets.resolve('db://mcp-payments'), TOKEN, 'the token is sealed');
    assert.ok(!JSON.stringify(stored).includes(TOKEN));

    const listed = (await api.call('GET', '/api/control/mcp', token)).body;
    assert.equal(listed.servers.length, 1);
    assert.deepEqual({ ...listed.servers[0], tools: undefined }, { name: 'payments', url: server.url, tokenSet: true, inUse: false, tools: undefined });
    assert.deepEqual(Object.keys(listed.servers[0].tools), ['get_transaction', 'create_payment_link']);
    assert.ok(!JSON.stringify(listed).includes(TOKEN), 'the token never comes back');

    // The next start reads it, with the token as a reference.
    const env = withSettings({}, await readSettings());
    const inEnv = JSON.parse(env.PALUGADA_MCP_SETTINGS!) as { servers: Array<Record<string, unknown>> };
    assert.equal(inEnv.servers[0]!.tokenRef, 'db://mcp-payments');
    assert.equal(inEnv.servers[0]!.tokenSecret, undefined);

    // Saved again at the same address without the token, the token is kept.
    const again = await save({ get_transaction: { tier: 0 } }, { token: undefined });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(await api.secrets.resolve('db://mcp-payments'), TOKEN);
    // And the kept token is what the owner can look again with.
    const lookedAgain = await api.call('POST', '/api/control/mcp/inspect', token, { url: server.url, name: 'payments' });
    assert.equal(lookedAgain.body.problem, null, JSON.stringify(lookedAgain.body));
    // By its name alone, where it was saved: the one check the assistant may make.
    const byName = await api.call('POST', '/api/control/mcp/inspect', token, { name: 'payments' });
    assert.equal(byName.body.problem, null, JSON.stringify(byName.body));
    assert.ok((byName.body.tools as unknown[]).length > 0);
    const nameless = await api.call('POST', '/api/control/mcp/inspect', token, { name: 'nothing-saved' });
    assert.equal(nameless.status, 400, JSON.stringify(nameless.body));
    assert.match(String(nameless.body.error), /the name of one already saved/);

    // A new address does not inherit the token: that would hand it to another server.
    const other = await mcpServer();
    try {
      const lookedElsewhere = await api.call('POST', '/api/control/mcp/inspect', token, { url: other.url, name: 'payments' });
      assert.equal(lookedElsewhere.body.problem, null);
      const moved = await api.call('POST', '/api/control/mcp/servers', token,
        { name: 'payments', url: other.url, tools: { get_transaction: { tier: 0 } }, proof: { totp: api.code() } });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.ok(other.state.authorizations.length > 0);
      assert.ok(other.state.authorizations.every((one) => one === undefined), 'the old token was never sent to the new address');
      await assert.rejects(api.secrets.resolve('db://mcp-payments'), /nothing is stored/, 'and it is not kept for it');
      assert.equal((await api.call('GET', '/api/control/mcp', token)).body.servers[0].tokenSet, false);
    } finally {
      await other.close();
    }
    const back = await save({ get_transaction: { tier: 0 } });
    assert.equal(back.status, 200, 'back at its own address, with its token typed again');
    assert.equal(await api.secrets.resolve('db://mcp-payments'), TOKEN);

    const unprovedRemoval = await api.call('POST', '/api/control/mcp/servers/payments/remove', token, {});
    assert.equal(unprovedRemoval.status, 403);
    const removed = await api.call('POST', '/api/control/mcp/servers/payments/remove', token, { proof: { totp: api.code() } });
    assert.equal(removed.status, 200);
    assert.equal((await readSettings()).mcp, undefined);
    await assert.rejects(api.secrets.resolve('db://mcp-payments'), /nothing is stored/, 'removing a server forgets its token');
    const missing = await api.call('POST', '/api/control/mcp/servers/payments/remove', token, { proof: { totp: api.code() } });
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /no MCP server named payments was added in the console/);
  } finally {
    await api.close();
    await server.close();
  }
});

test('a server\'s own token is sent with every call and with the boot\'s look at its tools', async () => {
  const server = await mcpServer({ needsToken: TOKEN });
  try {
    const registry = new CapabilityRegistry();
    const file = { servers: [{ name: 'payments', url: server.url, tokenRef: 'env://PALUGADA_SECRET_MCP', tools: { get_transaction: { tier: 0 } } }] };
    const resolved: string[] = [];
    const resolve = async (reference: string) => { resolved.push(reference); return TOKEN; };
    const { bound, notes } = await bindMcpServers(registry, file, 'mcp.json', { resolve });
    assert.deepEqual(bound, ['mcp.payments.get_transaction']);
    assert.deepEqual(notes.filter((note) => /could not list/.test(note)), [], 'the boot listed its tools with the token');
    const output = await registry.get('mcp.payments.get_transaction')!.execute({ orderId: 'C-3' } as never, {
      companyId: 'c', divisionId: 'd', taskId: 't', idempotencyKey: 'k', signal: new AbortController().signal, credential: noDivisionCredential,
    });
    assert.deepEqual(output, { orderId: 'C-3', status: 'settlement' });
    assert.equal(server.state.calls[0]!.authorization, `Bearer ${TOKEN}`);
    assert.ok(resolved.every((reference) => reference === 'env://PALUGADA_SECRET_MCP'));

    // Without a way to open the reference, the call is refused rather than sent bare.
    const bare = new CapabilityRegistry();
    const { notes: bareNotes } = await bindMcpServers(bare, { servers: [{ ...file.servers[0]!, tools: { get_transaction: { tier: 0, readOnly: true } } }] }, 'mcp.json');
    assert.match(bareNotes.join('\n'), /payments has a token, and nothing here can open env:\/\/PALUGADA_SECRET_MCP/);
    await assert.rejects(bare.get('mcp.payments.get_transaction')!.execute({ orderId: 'C-3' } as never, {
      companyId: 'c', divisionId: 'd', taskId: 't', idempotencyKey: 'k2', signal: new AbortController().signal, credential: noDivisionCredential,
    }), (error: unknown) => isPalugadaError(error, 'credential.unavailable'));
    assert.equal(server.state.calls.length, 1, 'nothing was sent without its token');

    // A server refused for one tool leaves none of its tools behind.
    const partly = new CapabilityRegistry();
    await assert.rejects(bindMcpServers(partly, {
      servers: [{ ...file.servers[0]!, tools: { get_transaction: { tier: 0 }, create_payment_link: { tier: 0 } } }],
    }, 'mcp.json', { resolve }), /create_payment_link is bound at tier 0/);
    assert.equal(partly.get('mcp.payments.get_transaction'), undefined, 'the tool that passed was not bound on its own');

    // A server's token and a division's credential are two answers to one question.
    await assert.rejects(bindMcpServers(new CapabilityRegistry(), {
      servers: [{ ...file.servers[0], credentialAlias: 'payments' }],
    }, 'mcp.json', { resolve }), (error: unknown) => isPalugadaError(error, 'config.invalid'));
  } finally {
    await server.close();
  }
});

test('the next start binds the console\'s servers, and one that no longer passes is a note, not a stopped start', async () => {
  const server = await mcpServer({ needsToken: TOKEN });
  const { start } = await import('../../src/main.ts');
  const settings = {
    servers: [
      { name: 'payments', url: server.url, tokenRef: 'env://PALUGADA_SECRET_MCP', tools: { get_transaction: { tier: 0, pin: pinOf(TOOLS[0]!) }, create_payment_link: { ...LINK, pin: pinOf(TOOLS[1]!) } } },
      // Pinned to a tool the server has since rewritten.
      { name: 'ledger', url: server.url, tokenRef: 'env://PALUGADA_SECRET_MCP', tools: { get_transaction: { tier: 0, pin: `sha256:${'0'.repeat(64)}` } } },
    ],
  };
  const deployment = await start({
    port: 0,
    env: { PALUGADA_MCP_SETTINGS: JSON.stringify(settings), PALUGADA_SECRET_MCP: TOKEN },
    worker: { idleMs: 60_000 },
  });
  try {
    assert.ok(deployment.notes.includes('bound from the console: mcp.payments.get_transaction, mcp.payments.create_payment_link'),
      deployment.notes.join('\n'));
    assert.ok(deployment.notes.some((note) => /^the MCP server ledger set in the console is left out: .*changed get_transaction since it was pinned/.test(note)),
      deployment.notes.join('\n'));
    assert.ok(!deployment.notes.some((note) => /mcp\.ledger\./.test(note) && note.startsWith('bound')));
  } finally {
    await deployment.stop();
    await server.close();
  }
});

test('a server that reads its token from another header, another scheme or its address is sent it there, and only there', async () => {
  const cases = [
    { name: 'exa', tokenIn: { header: 'x-api-key' } },
    { name: 'sentry', tokenIn: { scheme: 'Sentry-Bearer' } },
    { name: 'browserbase', tokenIn: { query: 'browserbaseApiKey' } },
  ];
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    for (const { name, tokenIn } of cases) {
      const server = await mcpServer({ needsToken: TOKEN, tokenIn });
      try {
        const bare = await api.call('POST', '/api/control/mcp/inspect', token, { url: server.url, token: TOKEN });
        assert.match(String(bare.body.problem), /401/, `${name}: a bearer token is not where this server looks`);
        const since = server.state.authorizations.length;
        const looked = await api.call('POST', '/api/control/mcp/inspect', token, { url: server.url, token: TOKEN, tokenIn });
        assert.equal(looked.body.problem, null, name);
        const saved = await api.call('POST', '/api/control/mcp/servers', token,
          { name, url: server.url, token: TOKEN, tokenIn, tools: { get_transaction: { tier: 0 } }, proof: { totp: api.code() } });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        const settings = JSON.parse(withSettings({}, await readSettings()).PALUGADA_MCP_SETTINGS!) as { servers: Array<{ name: string }> };
        const bound = new CapabilityRegistry();
        const { notes } = await bindMcpServers(bound, { servers: settings.servers.filter((one) => one.name === name) }, 'the console',
          { resolve: (reference) => api.secrets.resolve(reference) });
        assert.deepEqual(notes, [], `${name}: the next start lists its tools with the token where it reads it`);
        await bound.get(`mcp.${name}.get_transaction`)!.execute({ orderId: 'E-5' } as never, {
          companyId: 'c', divisionId: 'd', taskId: `t-${name}`, idempotencyKey: 'k', signal: new AbortController().signal, credential: noDivisionCredential,
        });
        assert.equal(server.state.calls.length, 1, name);
        if (tokenIn.query) assert.ok(server.state.authorizations.slice(since).every((one) => one === undefined), 'not also as a bearer token');
      } finally {
        await closeMcpSessions();
        await server.close();
      }
    }
  } finally {
    await api.close();
  }
  const bad = await consoleWithSettingsRefusing({ header: 'x-api-key', query: 'key' });
  assert.match(bad, /a header or in the address, not both/);
  assert.deepEqual(accessFor({ url: 'https://mcp.example/mcp?x=1', tokenIn: { query: 'key' } }, 'k 1'),
    { url: 'https://mcp.example/mcp?x=1&key=k+1', headers: {} });
  assert.deepEqual(accessFor({ url: 'https://mcp.example/mcp' }, null), { url: 'https://mcp.example/mcp', headers: {} });
});

/** What the console says of a token placement it will not accept. */
async function consoleWithSettingsRefusing(tokenIn: Record<string, string>): Promise<string> {
  await resetData();
  const api = await consoleWithSettings();
  try {
    const refused = await api.call('POST', '/api/control/mcp/inspect', await api.signIn(), { url: 'https://mcp.example/mcp', token: 'k', tokenIn });
    assert.equal(refused.status, 400);
    return String(refused.body.error);
  } finally {
    await api.close();
  }
}

test('the servers offered by name are each a server the rules accept, and the console lists them', async () => {
  const names = new Set<string>();
  for (const preset of MCP_PRESETS) {
    assert.ok(!names.has(preset.id), `${preset.id} once`);
    names.add(preset.id);
    const registry = new CapabilityRegistry();
    // The shape a saved preset takes, bound against a server that does not answer: refused only if the shape is wrong.
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const { notes } = await bindMcpServers(registry, {
      servers: [{ name: preset.id, url: preset.url, ...(preset.tokenIn ? { tokenIn: preset.tokenIn } : {}),
        ...(preset.key === 'required' ? { tokenRef: 'env://PALUGADA_SECRET_X' } : {}), tools: { anything: { tier: 0, readOnly: true } } }],
    }, preset.id, { resolve: async () => 'k', fetch: offline });
    assert.match(notes.join('\n'), /could not list its tools at boot/, preset.id);
    if (preset.key === 'none' && !preset.signIn) assert.ok(preset.run, `${preset.id} says how to run it`);
    else assert.ok(preset.url.startsWith('https://'), `${preset.id} is reached over HTTPS`);
    if (preset.signIn === 'client') assert.ok(preset.clientUrl?.startsWith('https://'), `${preset.id} says where to register a client`);
    else assert.equal(preset.clientUrl, undefined, `${preset.id} registers PALUGADA itself, or takes no sign-in`);
    // A command the owner copies runs the version that was checked, not whatever is newest that day.
    if (preset.run) assert.match(preset.run, /@\d+\.\d+\.\d+ /, `${preset.id} runs one version`);
    if (preset.runHint) assert.ok(preset.run, `${preset.id} says where to run a server it does not run`);
  }
  assert.ok(names.has('github') && names.has('playwright'));
  // Servers that are signed in to rather than given a key are offered too.
  assert.equal(MCP_PRESETS.find((one) => one.id === 'notion')?.signIn, 'registers');
  assert.equal(MCP_PRESETS.find((one) => one.id === 'hubspot')?.signIn, 'client');
  // The console carries each one's words so that they are translated; they must be the same words.
  const console = readFileSync(new URL('../../console/src/pages/Deployment.tsx', import.meta.url), 'utf8');
  for (const preset of MCP_PRESETS) {
    assert.ok(console.includes(`${preset.id}: N('${preset.about.replace(/'/g, "\\'")}')`), `the console says what ${preset.id} is, in the same words`);
    if (preset.keyHint) assert.ok(console.includes(preset.keyHint.replace(/'/g, "\\'")), `the console gives ${preset.id}'s key hint in the same words`);
    if (preset.runHint) assert.ok(console.includes(preset.runHint.replace(/'/g, "\\'")), `the console says where to run ${preset.id} in the same words`);
  }
  const api = await consoleWithSettings();
  try {
    const listed = (await api.call('GET', '/api/control/mcp', await api.signIn())).body;
    assert.deepEqual(listed.presets.map((one: { id: string }) => one.id), MCP_PRESETS.map((one) => one.id));
  } finally {
    await api.close();
  }
});

/**
 * Coolify and Dokploy run what a company deploys, on the owner's own
 * machines, so neither lives at an address PALUGADA could know. Coolify
 * serves MCP itself, at /mcp on the owner's instance, and reads a bearer
 * token: the host is the part the owner completes. Dokploy's server is a
 * package the owner runs, which asks nothing of whoever reaches it, so the
 * console says so beside the command that starts it.
 */
test('Coolify is its owner\'s own address with a token, and Dokploy is run by the owner and said to let in whoever reaches it', () => {
  const coolify = MCP_PRESETS.find((one) => one.id === 'coolify');
  assert.ok(coolify, 'Coolify is offered');
  assert.match(coolify.url, /^https:\/\/\{[a-z-]+\}\/mcp$/, 'at /mcp, on a host the owner puts in place of the braces');
  assert.equal(coolify.key, 'required');
  assert.equal(coolify.signIn, undefined, 'it publishes no sign-in, only tokens');
  assert.deepEqual(accessFor({ ...coolify, url: coolify.url.replace(/\{[^}]*\}/, 'coolify.example.com') }, 'k').headers,
    { authorization: 'Bearer k' }, 'the token goes where Coolify reads it');
  assert.match(coolify.keyHint ?? '', /\bread\b.*\bdeploy\b/, 'it says which permissions the token needs, and no others');

  const dokploy = MCP_PRESETS.find((one) => one.id === 'dokploy');
  assert.ok(dokploy, 'Dokploy is offered');
  assert.equal(dokploy.key, 'none', 'it asks PALUGADA for nothing');
  assert.match(dokploy.run ?? '', /\bnpx @dokploy\/mcp@\d+\.\d+\.\d+ --http$/, 'the official package, over streamable HTTP rather than stdio');
  assert.match(dokploy.run ?? '', /DOKPLOY_TOOL_PRESET=/, 'with fewer than its hundreds of tools');
  const address = new URL(dokploy.url);
  assert.deepEqual([address.protocol, address.port, address.pathname], ['http:', '3000', '/mcp'], 'the port and path its code fixes');
  assert.doesNotThrow(() => assertPlainHttpIsLocal(dokploy.url));
  assert.match(dokploy.runHint ?? '', /whoever reaches it/);
  assert.match(dokploy.runHint ?? '', /only this deployment can reach/);
});
