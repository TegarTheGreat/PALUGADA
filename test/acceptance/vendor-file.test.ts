/**
 * The twenty as a file, and whether a deployment can actually hand one in
 * (PRD v2 §10, F8, F3.4, F8.4, F12.8).
 *
 * `httpCapability` made a vendor integration a spec. It did not make the spec
 * something a deployment could *supply*: the only way to bind `email.send` was
 * to fork this repository and edit the assembly, which is the defect this
 * codebase keeps finding in itself -- machinery that works, is tested alone,
 * and is assembled by nobody. The README had already claimed the fix one step
 * before it was true.
 *
 * So these tests are about the step: a JSON file, read at boot, refused when
 * it is wrong, and producing capabilities that behave exactly like the ones
 * written by hand. The four things a spec expresses as functions -- a body, a
 * result, a match and a policy description -- each have a declarative form,
 * and each is checked here against a vendor on loopback rather than by
 * inspecting the object that was built.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { httpCapability } from '../../src/capabilities/http.ts';
import { parseVendors, registerVendorCapabilities } from '../../src/capabilities/vendors.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

async function vendor(
  reply: (call: Seen, index: number) => { status: number; body?: unknown },
): Promise<{ url: string; calls: Seen[]; close: () => Promise<void> }> {
  const calls: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const call: Seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body: raw,
      };
      calls.push(call);
      const answer = reply(call, calls.length - 1);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function ctx(overrides: Partial<{ idempotencyKey: string }> = {}) {
  return {
    companyId: '11111111-1111-1111-1111-111111111111',
    divisionId: '22222222-2222-2222-2222-222222222222',
    taskId: '33333333-3333-3333-3333-333333333333',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    signal: new AbortController().signal,
    async credential(alias: string) {
      if (alias !== 'mail') throw new Error(`no such alias: ${alias}`);
      return 'sk_live/9aB+cD=eF';
    },
  };
}

/** The `email.send` an operator would actually write, as a document. */
function sendEntry(url: string) {
  return {
    name: 'email.send',
    adapter: 'fakemail',
    tier: 2,
    method: 'POST',
    url: `${url}/v1/messages`,
    headers: {
      authorization: 'Bearer {credential}',
      'idempotency-key': '{idempotencyKey}',
    },
    body: { to: '{input.to}', subject: '{input.subject}', text: '{input.body}' },
    result: 'body',
    credentialAlias: 'mail',
    requiredScopes: ['mail:send'],
    verify: {
      url: `${url}/v1/messages/{result.id}`,
      matches: { status: 200, path: 'body.status', equals: 'sent' },
    },
    describe: { recipientDomain: 'to' },
    allowPrivateHosts: ['127.0.0.1'],
  };
}

function build(url: string) {
  return httpCapability(parseVendors({ capabilities: [sendEntry(url)] })[0]!);
}

/* --------------------------------------------------------- the happy path --- */

test('a file binds a capability that sends, verifies and describes (F8, F8.4, F3.4)', async () => {
  const server = await vendor((call) =>
    call.method === 'POST'
      ? { status: 202, body: { id: 'msg_1' } }
      : { status: 200, body: { id: 'msg_1', status: 'sent' } },
  );
  try {
    const capability = build(server.url);
    const input = { to: 'ana@supplier.example', subject: 'Hello', body: 'Text.' };

    const result = await capability.execute(input, ctx());
    assert.deepEqual(result, { id: 'msg_1' });

    const sent = server.calls[0]!;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.headers.authorization, 'Bearer sk_live/9aB+cD=eF');
    assert.equal(sent.headers['idempotency-key'], 'idem-1');
    // The body was built by substituting values into a JSON template, so it is
    // a document rather than a string with holes: the subject arrives as a
    // string and nothing had to be escaped by hand.
    assert.deepEqual(JSON.parse(sent.body), {
      to: 'ana@supplier.example', subject: 'Hello', text: 'Text.',
    });

    assert.equal(await capability.verify!(input, result, ctx()), true);
    assert.equal(server.calls[1]!.path, '/v1/messages/msg_1');

    // F3.4's facts, from a path rather than a hand-written function.
    assert.deepEqual(capability.describe!(input), { recipientDomain: 'supplier.example' });
  } finally {
    await server.close();
  }
});

test('a template keeps the type of a value it substitutes whole (F8)', async () => {
  const server = await vendor(() => ({ status: 200, body: { ok: true } }));
  try {
    const capability = httpCapability(parseVendors({
      capabilities: [{
        name: 'metrics.read',
        adapter: 'fakemetrics',
        tier: 0,
        method: 'POST',
        url: `${server.url}/v1/query`,
        // A query is a POST at plenty of vendors, and F12.8's guard is on the
        // method rather than on the operator's tier -- deliberately, because
        // the tier is a field the same file sets. A key on a read costs
        // nothing and the vendor ignores it.
        headers: { 'idempotency-key': '{idempotencyKey}' },
        body: {
          limit: '{input.limit}',
          tags: '{input.tags}',
          note: 'run {input.limit} for {taskId}',
        },
        allowPrivateHosts: ['127.0.0.1'],
      }],
    })[0]!);

    await capability.execute({ limit: 25, tags: ['a', 'b'] }, ctx());

    // A string that is exactly one placeholder becomes the value it names,
    // with its type. A vendor that declared an integer would reject "25", and
    // the operator has no other way to say which they meant. A string with
    // text around it is interpolated, and is a string.
    assert.deepEqual(JSON.parse(server.calls[0]!.body), {
      limit: 25,
      tags: ['a', 'b'],
      note: 'run 25 for 33333333-3333-3333-3333-333333333333',
    });
  } finally {
    await server.close();
  }
});

test('a read-back can check the record says what was set (F8.4)', async () => {
  const server = await vendor((call) =>
    call.method === 'PUT'
      ? { status: 200, body: { result: { id: 'rec_1' } } }
      : { status: 200, body: { result: { id: 'rec_1', content: '203.0.113.9' } } },
  );
  try {
    const entry = {
      name: 'dns.update',
      adapter: 'fakedns',
      tier: 1,
      method: 'PUT',
      url: `${server.url}/zones/{input.zoneId}/records/{input.recordId}`,
      headers: { 'x-idempotency-key': '{idempotencyKey}' },
      body: { content: '{input.content}' },
      result: 'body.result',
      verify: {
        url: `${server.url}/zones/{input.zoneId}/records/{input.recordId}`,
        matches: { status: 200, path: 'body.result.content', equalsPath: 'input.content' },
      },
      allowPrivateHosts: ['127.0.0.1'],
    };
    const capability = httpCapability(parseVendors({ capabilities: [entry] })[0]!);
    const input = { zoneId: 'z1', recordId: 'rec_1', content: '203.0.113.9' };
    const result = await capability.execute(input, ctx());

    assert.equal(await capability.verify!(input, result, ctx()), true, 'it says what was set');

    // And the same read-back against a record that says something else fails,
    // which is the whole point: "a field came back" is not a read-back.
    assert.equal(
      await capability.verify!({ ...input, content: '198.51.100.4' }, result, ctx()),
      false,
      'a record holding a different value is not verified',
    );
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------- refusals --- */

test('a file naming a field this platform does not have is refused (F8)', () => {
  // `additionalProperties: false` throughout, and this is why: an operator who
  // writes `credential_alias` would otherwise get a capability that sends no
  // token and fails its first real call with somebody else's 401.
  assert.throws(
    () => parseVendors({
      capabilities: [{
        name: 'dns.read', adapter: 'x', tier: 0, method: 'GET', url: 'https://api.example/',
        credential_alias: 'dns',
      }],
    }, 'vendors.json'),
    (error: unknown) =>
      isPalugadaError(error, 'config.invalid')
      && /vendors\.json is not a valid vendor file/.test((error as Error).message),
  );
});

test('a file that would bind a write with no read-back is refused at boot (F8.4)', () => {
  // The broker refuses the call anyway. The difference is whether the operator
  // finds out when they save the file or an agent finds out halfway through
  // sending an invoice.
  assert.throws(
    () => parseVendors({
      capabilities: [{
        name: 'invoice.issue', adapter: 'x', tier: 2, method: 'POST',
        url: 'https://api.example/v1/invoices',
        headers: { 'idempotency-key': '{idempotencyKey}' },
      }],
    }, 'vendors.json'),
    (error: unknown) =>
      isPalugadaError(error, 'config.invalid')
      && /cannot bind invoice\.issue/.test((error as Error).message),
  );
});

test('a file that puts a credential in a URL is refused at boot (F12.1)', () => {
  assert.throws(
    () => parseVendors({
      capabilities: [{
        name: 'dns.read', adapter: 'x', tier: 0, method: 'GET',
        url: 'https://api.example/v1/zones?token={credential}',
      }],
    }, 'vendors.json'),
    (error: unknown) =>
      isPalugadaError(error, 'config.invalid')
      && /cannot bind dns\.read/.test((error as Error).message),
  );
});

test('a file naming the same capability twice is refused (F8)', () => {
  // One would silently win, and which one depends on the order somebody
  // happened to write them in.
  assert.throws(
    () => parseVendors({
      capabilities: [
        { name: 'dns.read', adapter: 'a', tier: 0, method: 'GET', url: 'https://a.example/' },
        { name: 'dns.read', adapter: 'b', tier: 0, method: 'GET', url: 'https://b.example/' },
      ],
    }, 'vendors.json'),
    (error: unknown) =>
      isPalugadaError(error, 'config.invalid')
      && /names dns\.read twice/.test((error as Error).message),
  );
});

test('a read-back that matches on nothing is refused (F8.4)', () => {
  // An empty `matches` accepts every answer, which is a read-back that reads
  // nothing back -- and it would satisfy the tier 1 requirement while
  // providing none of what the requirement is for.
  assert.throws(
    () => parseVendors({
      capabilities: [{
        name: 'ticket.create', adapter: 'x', tier: 1, method: 'POST',
        url: 'https://api.example/v1/tickets',
        headers: { 'idempotency-key': '{idempotencyKey}' },
        verify: { url: 'https://api.example/v1/tickets/{result.id}', matches: {} },
      }],
    }, 'vendors.json'),
    (error: unknown) => isPalugadaError(error, 'config.invalid'),
  );
});

test('a file cannot loosen the catalogue (F8.3)', async () => {
  // `email.send` is catalogued at tier 2 because it is irreversible and leaves
  // this company's name on somebody else's screen. A configuration file is the
  // last place that should be able to say otherwise.
  const registry = new CapabilityRegistry();
  const directory = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, JSON.stringify({
    capabilities: [{
      name: 'email.send', adapter: 'x', tier: 0, method: 'GET',
      url: 'https://api.example/v1/messages',
    }],
  }));

  await assert.rejects(
    () => registerVendorCapabilities(registry, path),
    (error: unknown) => isPalugadaError(error, 'capability.miscalibrated'),
  );
});

/* ---------------------------------------------------------------- on disk --- */

test('the file is read, registered and reported by name (§10)', async () => {
  const server = await vendor(() => ({ status: 200, body: { id: 'msg_1' } }));
  const directory = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, JSON.stringify({ capabilities: [sendEntry(server.url)] }));
  try {
    const registry = new CapabilityRegistry();
    const names = await registerVendorCapabilities(registry, path);

    assert.deepEqual(names, ['email.send']);
    assert.notEqual(registry.get('email.send'), undefined, 'it is in the registry');
  } finally {
    await server.close();
  }
});

test('a file that is not JSON says so, naming the file (§10)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, '{ "capabilities": [ ');

  await assert.rejects(
    () => registerVendorCapabilities(new CapabilityRegistry(), path),
    (error: unknown) =>
      isPalugadaError(error, 'config.invalid')
      && (error as Error).message.includes(path),
  );
});

test('a file that is not there says so rather than starting without it (§10)', async () => {
  await assert.rejects(
    () => registerVendorCapabilities(new CapabilityRegistry(), '/nonexistent/vendors.json'),
    (error: unknown) => isPalugadaError(error, 'config.invalid'),
  );
});

/* ------------------------------------------------------- the shipped example --- */

test('the example file in this repository builds (§10)', () => {
  // It is the thing an operator copies. A broken example is a broken first
  // hour, and this is the cheapest possible way to keep it honest.
  const document = JSON.parse(readFileSync('config/vendors.example.json', 'utf8')) as unknown;
  const specs = parseVendors(document, 'config/vendors.example.json');
  assert.deepEqual(
    specs.map((spec) => spec.name),
    ['email.send', 'dns.read', 'dns.update', 'invoice.issue'],
  );
});

/* ------------------------------------------------ what a policy matches on --- */

test('a batch to two domains describes no single domain (F3.4)', () => {
  const capability = httpCapability(parseVendors({
    capabilities: [{
      ...sendEntry('https://api.example'),
      allowPrivateHosts: [],
    }],
  })[0]!);

  assert.deepEqual(
    capability.describe!({ to: ['ana@acme.example', 'bo@acme.example'] }),
    { recipientDomain: 'acme.example' },
    'a batch that shares a domain has one',
  );
  // Null rather than the first one. A rule reading `recipient_domain not_in
  // [ours]` fires on null and an allow rule reading `in [ours]` does not match
  // it, so a mixed batch is never waved through on its first recipient.
  assert.deepEqual(
    capability.describe!({ to: ['ana@acme.example', 'evil@attacker.example'] }),
    { recipientDomain: null },
    'a batch that does not share one has none',
  );
});

/**
 * A path reads the answer, not the object graph behind it.
 *
 * Every path in a vendor file is a string an operator wrote, and every value
 * in JavaScript carries a prototype full of properties nobody put there. A
 * read-back asking whether `body.constructor` is present would pass against
 * *any* object -- including the `{}` a vendor answers when it did nothing --
 * so F8.4's whole guarantee would come down to a path that reads as harmless.
 * Own properties only, so a path that names nothing reads nothing.
 */
test('a path cannot reach through a prototype (F8.4, F12.4)', async () => {
  const server = await vendor(() => ({ status: 200, body: {} }));
  try {
    const capability = httpCapability(parseVendors({
      capabilities: [{
        name: 'ticket.create', adapter: 'x', tier: 1, method: 'POST',
        url: `${server.url}/v1/tickets`,
        headers: { 'idempotency-key': '{idempotencyKey}' },
        verify: {
          url: `${server.url}/v1/tickets/1`,
          matches: { present: 'body.constructor' },
        },
        allowPrivateHosts: ['127.0.0.1'],
      }],
    })[0]!);

    const result = await capability.execute({}, ctx());
    assert.equal(
      await capability.verify!({}, result, ctx()),
      false,
      'an empty answer does not verify a write because every object has a constructor',
    );

    // The same rule on the describing side: a policy fact read off a
    // prototype is a fact about JavaScript, not about the action.
    const describing = httpCapability(parseVendors({
      capabilities: [{
        name: 'metrics.read', adapter: 'x', tier: 0, method: 'GET',
        url: 'https://api.example/v1/metrics',
        describe: { moneyCents: 'constructor.length' },
      }],
    })[0]!);
    assert.deepEqual(describing.describe!({}), {});
  } finally {
    await server.close();
  }
});
