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
import { redactor } from '../../src/secrets/manager.ts';
import { httpCapability, fill } from '../../src/capabilities/http.ts';
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
        // And a POST at tier 0 is one the file says only reads.
        readOnly: true,
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

test('a vendor capability says what it takes: the fields its templates use, or what the file declares (F13.4)', () => {
  // Offered as "any object", a model guessed a send's arguments, and a guess
  // of `recipient` for `to` sent a literal "{input.to}" to the vendor.
  const derived = build('https://mail.example');
  assert.deepEqual(derived.inputSchema, {
    type: 'object',
    required: ['body', 'subject', 'to'],
    properties: { body: {}, subject: {}, to: {} },
  }, 'every field a template reads is one the call must carry');

  const declared = httpCapability(parseVendors({
    capabilities: [{
      ...sendEntry('https://mail.example'),
      input: {
        type: 'object', required: ['to', 'subject', 'body'],
        properties: { to: { type: 'string', description: 'One address.' }, subject: { type: 'string' }, body: { type: 'string' } },
      },
    }],
  })[0]!);
  assert.equal((declared.inputSchema!.properties as Record<string, { description?: string }>).to!.description, 'One address.');

  assert.throws(
    () => parseVendors({ capabilities: [{ ...sendEntry('https://mail.example'), input: { type: 'object', required: 'to' } }] }, 'vendors.json'),
    (error: unknown) => isPalugadaError(error, 'config.invalid') && /email\.send.*input/.test((error as Error).message),
    'a schema the validator cannot read is refused at boot, not at the first send',
  );
});

test('a file cannot bind a write at tier 0 under a name the catalogue does not know (F8.3)', () => {
  // The catalogue holds what it names to its tier. A name it does not know
  // was held to nothing, so a payout bound at tier 0 would run at once with
  // nobody asked.
  assert.throws(
    () => parseVendors({
      capabilities: [{
        name: 'payout.send', adapter: 'x', tier: 0, method: 'POST', url: 'https://api.example/payouts',
        headers: { 'idempotency-key': '{idempotencyKey}' },
      }],
    }, 'vendors.json'),
    (error: unknown) => isPalugadaError(error, 'config.invalid')
      && /payout\.send is a POST, which changes something, and cannot be tier 0/.test((error as Error).message),
  );
  // A search that takes a POST, which the file says only reads, may.
  const [search] = parseVendors({
    capabilities: [{
      name: 'catalog.search', adapter: 'x', tier: 0, method: 'POST', url: 'https://api.example/search',
      headers: { 'idempotency-key': '{idempotencyKey}' }, readOnly: true,
    }],
  });
  assert.equal(httpCapability(search!).defaultTier, 0);
});

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

test('the example file in this repository builds, and its read-backs resolve (§10)', () => {
  // It is the thing an operator copies. A broken example is a broken first
  // hour, and this is the cheapest possible way to keep it honest.
  const document = JSON.parse(readFileSync('config/vendors.example.json', 'utf8')) as unknown;
  const specs = parseVendors(document, 'config/vendors.example.json');
  assert.deepEqual(
    specs.map((spec) => spec.name),
    ['email.send', 'dns.read', 'dns.update', 'invoice.issue', 'social.publish', 'metrics.read'],
  );

  // Building is not enough, and this is the mistake the example itself made:
  // a `result` of `body.id` makes the result a string, and a read-back URL of
  // `{result.id}` then reads `id` off a string, finds nothing, and is sent
  // with the placeholder still in it. The vendor 404s, and a write that
  // succeeded is reported as unverified -- wrong in the direction of doing it
  // twice. A URL that still holds a `{` after filling is that bug.
  for (const spec of specs) {
    if (!spec.verify) continue;
    const result = spec.result
      ? spec.result({ status: 200, body: { id: 'obj_1', result: { id: 'rec_1' } } })
      : null;
    const url = fill(spec.verify.url, {
      input: { zoneId: 'z1', recordId: 'rec_1', content: '203.0.113.9' },
      idempotencyKey: 'idem-1',
      credential: '',
      companyId: '11111111-1111-1111-1111-111111111111',
      divisionId: '22222222-2222-2222-2222-222222222222',
      taskId: '33333333-3333-3333-3333-333333333333',
      result: result as Record<string, unknown>,
    });
    // A `{` that survived filling is the bug: `fill` leaves an unfillable
    // placeholder as written -- deliberately, so a vendor 400s on it rather
    // than being sent the word "undefined" -- and the request goes out with
    // the brace percent-encoded into the path.
    assert.ok(!url.includes('{'), `${spec.name} read-back URL is unfilled: ${url}`);
  }

  // And every policy fact it claims to describe actually resolves.
  //
  // The example got this wrong too: `dns.update` mapped `urlHost` to a DNS
  // record's *value*, which `new URL()` throws on, so `url_host` was
  // permanently `null`. A fact that is always null is worse than an absent
  // one, because a policy written against it reads as protecting something
  // and matches nothing -- the `not_in` direction fires on everything and the
  // `in` direction fires on nothing.
  const samples: Record<string, Record<string, unknown>> = {
    'email.send': { to: ['ana@supplier.example'], subject: 'Hi', body: 'Text.' },
    'dns.read': { zoneId: 'z1' },
    'dns.update': { zoneId: 'z1', recordId: 'r1', type: 'A', name: 'a', content: '203.0.113.9', ttl: 60 },
    'invoice.issue': { amount: 150_000 },
  };
  // Rp 150.000 is fifteen million cents to a policy, not a hundred and fifty
  // thousand: Midtrans takes whole rupiah and every threshold is in cents.
  assert.deepEqual(specs.find((spec) => spec.name === 'invoice.issue')!.describe!(samples['invoice.issue']!), {
    moneyCents: 15_000_000,
  });
  for (const spec of specs) {
    if (!spec.describe) continue;
    const described = spec.describe(samples[spec.name] ?? {});
    const entries = Object.entries(described);
    assert.notEqual(entries.length, 0, `${spec.name} describes nothing`);
    for (const [field, value] of entries) {
      assert.notEqual(
        value, null,
        `${spec.name} describes ${field} as null for an ordinary input`,
      );
    }
  }
});

/* ------------------------------------------- what the fourth review found --- */

/**
 * A read-back clause that asserts nothing is refused.
 *
 * An empty `matches` was already refused, and this is the same failure in a
 * shape that got past it. A `path` with nothing to compare it to reads a field
 * and discards it. An `equals` with no `path` names a value and never looks
 * for it. Both leave a tier 1 write "verified" on any 2xx -- F8.4 satisfied in
 * form and not in substance, which is worse than an unverified write because
 * the platform reports it as checked.
 */
test('a read-back clause that asserts nothing is refused (F8.4)', () => {
  for (const matches of [
    { path: 'body.status' },
    { equals: 'sent' },
    { oneOf: ['sent'] },
    { equalsPath: 'input.content' },
  ]) {
    assert.throws(
      () => parseVendors({
        capabilities: [{
          name: 'ticket.create', adapter: 'x', tier: 1, method: 'POST',
          url: 'https://api.example/v1/tickets',
          headers: { 'idempotency-key': '{idempotencyKey}' },
          verify: { url: 'https://api.example/v1/tickets/{result}', matches },
        }],
      }, 'vendors.json'),
      (error: unknown) => isPalugadaError(error, 'config.invalid'),
      JSON.stringify(matches),
    );
  }

  // And the pair together is accepted, so the rule refuses the useless shape
  // rather than the feature.
  assert.doesNotThrow(() => parseVendors({
    capabilities: [{
      name: 'ticket.create', adapter: 'x', tier: 1, method: 'POST',
      url: 'https://api.example/v1/tickets',
      headers: { 'idempotency-key': '{idempotencyKey}' },
      verify: {
        url: 'https://api.example/v1/tickets/{result}',
        matches: { path: 'body.status', equals: 'open' },
      },
    }],
  }));
});

test('a body template reads a nested field (F8)', async () => {
  const server = await vendor(() => ({ status: 200, body: { ok: true } }));
  try {
    const capability = httpCapability(parseVendors({
      capabilities: [{
        name: 'crm.note', adapter: 'x', tier: 1, method: 'POST',
        url: `${server.url}/v1/notes`,
        headers: { 'idempotency-key': '{idempotencyKey}' },
        body: { email: '{input.customer.email}', note: 'for {input.customer.name}' },
        verify: {
          url: `${server.url}/v1/notes`,
          matches: { path: 'body.ok', equals: true },
        },
        allowPrivateHosts: ['127.0.0.1'],
      }],
    })[0]!);

    await capability.execute({ customer: { email: 'ana@acme.example', name: 'Ana' } }, ctx());

    // An input is a document, and naming a field in one is the ordinary case.
    // Reading only the first segment left the placeholder in the body as
    // literal text, which the vendor stores and sends to somebody.
    assert.deepEqual(JSON.parse(server.calls[0]!.body), {
      email: 'ana@acme.example',
      note: 'for Ana',
    });
  } finally {
    await server.close();
  }
});

/**
 * Stripe, Twilio, Mailgun and a long tail of older APIs take a form, not JSON:
 * a JSON body is refused, or worse, read as empty. The shipped example bound
 * `invoice.issue` to Stripe with a JSON body, which Stripe would have refused
 * on the first call -- found by the audit of 2026-09-28, item 25.
 */
test('a body can be sent as a form, nested the way Stripe and Twilio read one (F8)', async () => {
  const server = await vendor(() => ({ status: 200, body: { id: 'in_1', status: 'paid' } }));
  try {
    const capability = httpCapability(parseVendors({
      capabilities: [{
        name: 'invoice.pay', adapter: 'stripe', tier: 2, method: 'POST',
        url: `${server.url}/v1/invoices/{input.invoiceId}/pay`,
        headers: { authorization: 'Bearer {credential}', 'idempotency-key': '{idempotencyKey}' },
        bodyEncoding: 'form',
        body: {
          paid_out_of_band: '{input.outOfBand}',
          metadata: { task: '{taskId}', note: '{input.note}' },
          expand: ['{input.expand}', 'charge'],
          amount: '{input.amount}',
          skipped: '{input.absent}',
          description: null,
        },
        result: 'body.id',
        credentialAlias: 'mail',
        verify: {
          url: `${server.url}/v1/invoices/{result}`,
          matches: { path: 'body.status', equals: 'paid' },
        },
        allowPrivateHosts: ['127.0.0.1'],
      }],
    })[0]!);

    await capability.execute(
      { invoiceId: 'in_1', outOfBand: false, note: 'a&b=c d', expand: 'customer', amount: 1250 },
      ctx(),
    );

    const sent = server.calls[0]!;
    assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
    // Read back the way the vendor reads it: each key once, nested by
    // brackets, a value with `&` and `=` in it one value rather than three.
    assert.deepEqual([...new URLSearchParams(sent.body)], [
      ['paid_out_of_band', 'false'],
      ['metadata[task]', '33333333-3333-3333-3333-333333333333'],
      ['metadata[note]', 'a&b=c d'],
      ['expand[0]', 'customer'],
      ['expand[1]', 'charge'],
      ['amount', '1250'],
      // Null is sent empty: how these APIs are told to clear a field.
      ['description', ''],
      // A field whose whole value is a placeholder nothing fills is left out,
      // as `JSON.stringify` leaves it out of a JSON body. (The input schema
      // built from the templates refuses such a call before it gets here.)
    ]);
  } finally {
    await server.close();
  }
});

/**
 * Xendit and Midtrans take the secret key as an HTTP Basic user name with no
 * password, and Twilio a SID and a token as the pair. Without this an
 * operator had to store the key already base64-encoded, which is a secret
 * nobody can recognise when it leaks -- and which the redactor, knowing only
 * the stored value, would still catch, while a platform-encoded one it would
 * not.
 */
test('a key sent as HTTP Basic is encoded by the platform, and redacted like the key (F12.1)', async () => {
  const server = await vendor(() => ({ status: 200, body: { id: 'inv_1', status: 'PENDING' } }));
  try {
    const entry = (url: string) => ({
      name: 'invoice.issue', adapter: 'xendit', tier: 2, method: 'POST',
      url: `${url}/v2/invoices`,
      headers: { authorization: 'Basic {credentialBasic}', 'idempotency-key': '{idempotencyKey}' },
      body: { external_id: '{taskId}', amount: '{input.amount}' },
      result: 'body.id',
      credentialAlias: 'billing',
      verify: { url: `${url}/v2/invoices/{result}`, matches: { path: 'body.status', oneOf: ['PENDING', 'PAID'] } },
      preflightUrl: `${url}/balance`,
      allowPrivateHosts: ['127.0.0.1'],
    });
    const capability = httpCapability(parseVendors({ capabilities: [entry(server.url)] })[0]!);
    const withKey = (key: string) => ({ ...ctx(), credential: async () => key });

    await capability.execute({ amount: 150000 }, withKey('xnd_development_9aB8cD7eF6gH'));
    const basic = Buffer.from('xnd_development_9aB8cD7eF6gH:').toString('base64');
    assert.equal(server.calls[0]!.headers.authorization, `Basic ${basic}`, 'a key alone is the user name, with no password');
    assert.equal(redactor.redact(`the vendor echoed ${basic}`), 'the vendor echoed [redacted]');

    await capability.execute({ amount: 150000 }, withKey('AC0123456789:token-abcdef'));
    assert.equal(
      server.calls[1]!.headers.authorization,
      `Basic ${Buffer.from('AC0123456789:token-abcdef').toString('base64')}`,
      'a pair is sent as the pair',
    );

    // The read-back carries it too: it is a header like the key's own.
    assert.equal(await capability.verify!({ amount: 150000 }, 'inv_1', withKey('xnd_development_9aB8cD7eF6gH')), true);
    assert.equal(server.calls[2]!.headers.authorization, `Basic ${basic}`);
    // And the preflight, which is where an expired key is meant to show.
    const checked = await capability.preflight!({
      companyId: '11111111-1111-1111-1111-111111111111',
      divisionId: '22222222-2222-2222-2222-222222222222',
      credential: async () => 'xnd_development_9aB8cD7eF6gH',
    });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(server.calls[3]!.path, '/balance');
    assert.equal(server.calls[3]!.headers.authorization, `Basic ${basic}`);

    // Never in a URL, for the reason the key is not.
    assert.throws(
      () => httpCapability(parseVendors({ capabilities: [{ ...entry(server.url), url: `${server.url}/v2/invoices?auth={credentialBasic}` }] })[0]!),
      (error: unknown) => isPalugadaError(error, 'contract.violation') || isPalugadaError(error, 'config.invalid'),
    );
  } finally {
    await server.close();
  }
});

/**
 * Midtrans and Xendit take an amount in whole rupiah; a policy reads money in
 * cents. An entry that described a Rp 10.000.000 charge by its rupiah figure
 * would show every threshold the owner set a hundredth of the money -- a
 * charge that should wait for the owner would not.
 */
test('an amount in whole units is described in cents, and a file cannot say both (F3.4)', () => {
  const entry = (describe: Record<string, string>) => ({
    name: 'invoice.issue', adapter: 'midtrans', tier: 2, method: 'POST',
    url: 'https://api.sandbox.midtrans.com/v2/charge',
    headers: { authorization: 'Basic {credentialBasic}' },
    body: { transaction_details: { order_id: '{idempotencyKey}', gross_amount: '{input.amount}' } },
    verify: { url: 'https://api.sandbox.midtrans.com/v2/{idempotencyKey}/status', matches: { path: 'body.transaction_status', oneOf: ['pending', 'settlement'] } },
    describe,
  });
  const capability = httpCapability(parseVendors({ capabilities: [entry({ moneyUnits: 'amount' })] })[0]!);
  assert.deepEqual(capability.describe!({ amount: 10_000_000 }), { moneyCents: 1_000_000_000 });
  assert.deepEqual(capability.describe!({ amount: 19.99 }), { moneyCents: 1_999 }, 'rounded to a whole cent, not 1998.9999999999998');
  assert.deepEqual(capability.describe!({ amount: 'ten' }), {}, 'a figure that is not a number describes no money');

  assert.throws(
    () => parseVendors({ capabilities: [entry({ moneyCents: 'amount', moneyUnits: 'amount' })] }),
    (error: unknown) => isPalugadaError(error, 'config.invalid') && /moneyCents|moneyUnits/.test((error as Error).message),
    'one amount, stated one way',
  );
});

/**
 * A delete is read back by the record being gone. The live run of
 * 2026-09-28 (defect L10) deleted a customer record through a tier 3
 * approval, the read-back answered 404, and the task halted as
 * verification_failed -- the owner got two incidents for an action that had
 * worked -- because any answer of 400 or more failed before the entry's own
 * rule was read. The rule names what counts: here, that the record is gone.
 */
test('a delete is verified by the record being gone, when the rule says so (F8.4)', async () => {
  let present = true;
  const server = await vendor((call) => {
    if (call.method === 'DELETE') {
      present = false;
      return { status: 200, body: { id: 'cust-042' } };
    }
    return present ? { status: 200, body: { id: 'cust-042' } } : { status: 404, body: { error: 'not found' } };
  });
  try {
    const entry = (matches: Record<string, unknown>) => ({
      name: 'record.delete', adapter: 'crm', tier: 3, method: 'DELETE',
      url: `${server.url}/records/{input.recordId}`,
      headers: { 'idempotency-key': '{idempotencyKey}' },
      verify: { url: `${server.url}/records/{input.recordId}`, matches },
      allowPrivateHosts: ['127.0.0.1'],
    });
    const gone = httpCapability(parseVendors({ capabilities: [entry({ status: [404, 410] })] })[0]!);
    const input = { recordId: 'cust-042' };

    assert.equal(await gone.verify!(input, null, ctx()), false, 'still there: not deleted');
    const result = await gone.execute(input, ctx());
    assert.equal(await gone.verify!(input, result, ctx()), true, 'gone: deleted');

    // A rule that did not name 404 still fails on one: a record that should
    // exist and does not is the failure a read-back is for.
    const created = httpCapability(parseVendors({
      capabilities: [{ ...entry({ path: 'body.id', equals: 'cust-042' }), name: 'crm.note', tier: 1 }],
    })[0]!);
    assert.equal(await created.verify!(input, result, ctx()), false);
  } finally {
    await server.close();
  }
});

test('a form body must be an object of fields (F8)', () => {
  for (const [body, why] of [['{input.all}', 'a single placeholder'], [['a', 'b'], 'a list'], [undefined, 'no body at all']] as const) {
    assert.throws(
      () => parseVendors({
        capabilities: [{
          name: 'invoice.pay', adapter: 'stripe', tier: 2, method: 'POST', url: 'https://api.stripe.com/v1/invoices/{input.id}/pay',
          headers: { 'idempotency-key': '{idempotencyKey}' },
          bodyEncoding: 'form',
          ...(body === undefined ? {} : { body }),
          verify: { url: 'https://api.stripe.com/v1/invoices/{input.id}', matches: { path: 'body.status', equals: 'paid' } },
        }],
      }),
      (error: unknown) => isPalugadaError(error, 'config.invalid') && /form/.test((error as Error).message),
      why,
    );
  }
  assert.throws(
    () => parseVendors({
      capabilities: [{
        name: 'dns.read', adapter: 'x', tier: 0, method: 'GET', url: 'https://example.com/zones', bodyEncoding: 'xml',
      }],
    }),
    (error: unknown) => isPalugadaError(error, 'config.invalid'),
    'an encoding this platform does not write',
  );
});

test('a file cannot take a name this deployment already binds (F4.8, F15.7)', async () => {
  // `register` is a `Map.set`. A file naming `memory.search` would replace the
  // platform's own binding with a vendor's URL while the boot note still said
  // the platform bound it -- and every role's context pack instructs a run to
  // call that tool, so the whole platform would quietly be talking to somebody
  // else's server.
  const { registerPlatformCapabilities: registerTools } =
    await import('../../src/broker/platform-capabilities.ts');
  const registry = new CapabilityRegistry();
  registerTools(registry);

  const directory = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, JSON.stringify({
    capabilities: [{
      name: 'memory.search', adapter: 'somebody-else', tier: 0, method: 'GET',
      url: 'https://api.example/v1/search',
    }],
  }));

  await assert.rejects(
    () => registerVendorCapabilities(registry, path),
    (error: unknown) =>
      isPalugadaError(error, 'config.invalid')
      && /already binds/.test((error as Error).message),
  );
  assert.equal(registry.get('memory.search')?.adapter, 'platform', 'it was replaced anyway');
});

test('a refusal from the catalogue names the file that caused it (§10)', async () => {
  // The operator has to know which of their files said `email.send` is tier 0.
  // A boot refusal that names only the capability leaves them to guess.
  const directory = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, JSON.stringify({
    capabilities: [{
      name: 'email.send', adapter: 'x', tier: 0, method: 'GET',
      url: 'https://api.example/v1/messages',
    }],
  }));

  await assert.rejects(
    () => registerVendorCapabilities(new CapabilityRegistry(), path),
    (error: unknown) =>
      isPalugadaError(error, 'capability.miscalibrated')
      && (error as Error).message.startsWith(`${path} cannot bind email.send:`),
  );
});

test('loading a file does not make its capabilities grantable on its own (§10)', async () => {
  // A row in the `capabilities` table is what authorises a grant, and it is
  // written by `sync()`. Loading a file must not write one by itself: a boot
  // check, or any process that reads a vendor file and then exits, would
  // otherwise leave a shared database in which a later deployment -- started
  // without that file -- can grant a capability nothing answers.
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const directory = await mkdtemp(join(tmpdir(), 'palugada-vendors-'));
  const path = join(directory, 'vendors.json');
  await writeFile(path, JSON.stringify({ capabilities: [sendEntry('https://api.example')] }));

  const registry = new CapabilityRegistry();
  await registerVendorCapabilities(registry, path);

  const rows = await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      "SELECT 1 FROM capabilities WHERE name = 'email.send'",
    );
    return rowCount ?? 0;
  });
  assert.equal(rows, 0, 'loading a file wrote a grantable row for an unusable capability');
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
