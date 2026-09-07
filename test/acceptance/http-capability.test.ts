/**
 * A vendor capability as configuration (PRD v2 F8, F12.1, F12.8).
 *
 * Twenty of the twenty-five names the standard template grants need somebody's
 * account, and this platform does not get to choose whose. That is not the
 * same as "every deployment writes the same four hundred lines": what those
 * twenty have in common is everything that is hard, and it is the same list
 * `CliAdapter` found for F13.3.
 *
 * These run against a fake vendor on loopback, because everything that can be
 * wrong here is on the wire -- where the credential ends up, whether a retry
 * would be a second real action, whether a write is read back, and what a
 * vendor's refusal looks like by the time an agent sees it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { httpCapability, fill } from '../../src/capabilities/http.ts';
import { safeFetch } from '../../src/capabilities/reachable.ts';
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

/** A vendor. Records what it was sent and answers what the test tells it to. */
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

/** `email.send` at a vendor that behaves. The shape an operator would write. */
function sendSpec(url: string) {
  return {
    name: 'email.send',
    adapter: 'fakemail',
    tier: 2 as const,
    method: 'POST',
    url: `${url}/v1/messages`,
    headers: {
      authorization: 'Bearer {credential}',
      'idempotency-key': '{idempotencyKey}',
    },
    credentialAlias: 'mail',
    requiredScopes: ['mail:send'],
    body: (input: Record<string, unknown>) => ({
      to: input.to,
      subject: input.subject,
      text: input.body,
    }),
    result: (answer: { body: unknown }) => answer.body,
    verify: {
      url: `${url}/v1/messages/{result.id}`,
      matches: (answer: { body: unknown }) =>
        (answer.body as { status?: string } | null)?.status === 'sent',
    },
    describe: (input: Record<string, unknown>) => {
      const to = String(input.to ?? '');
      const at = to.lastIndexOf('@');
      return { recipientDomain: at === -1 ? null : to.slice(at + 1).toLowerCase() };
    },
    reach: { allowPrivateHosts: ['127.0.0.1'] },
  };
}

/* ------------------------------------------------------------ the happy path --- */

test('a vendor capability is a spec, and it sends, verifies and reports (F8, F8.4)', async () => {
  const server = await vendor((call) =>
    call.method === 'POST'
      ? { status: 202, body: { id: 'msg_1' } }
      : { status: 200, body: { id: 'msg_1', status: 'sent' } },
  );
  try {
    const capability = httpCapability(sendSpec(server.url));
    const context = ctx();

    const result = await capability.execute(
      { to: 'ana@supplier.example', subject: 'Invoice', body: 'Attached.' },
      context,
    );
    assert.deepEqual(result, { id: 'msg_1' });

    const sent = server.calls[0]!;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/v1/messages');
    assert.deepEqual(JSON.parse(sent.body), {
      to: 'ana@supplier.example',
      subject: 'Invoice',
      text: 'Attached.',
    });

    // F8.4: the read-back, which is a second request rather than a return
    // code. A vendor that accepted the call and dropped it answers the first
    // and fails the second, and only the second is evidence.
    assert.equal(await capability.verify!({}, result, context), true);
    assert.equal(server.calls[1]!.method, 'GET');
    assert.equal(server.calls[1]!.path, '/v1/messages/msg_1');

    // F3.4: what a policy may match on.
    assert.equal(
      capability.describe!({ to: 'ana@supplier.example' }).recipientDomain,
      'supplier.example',
    );
  } finally {
    await server.close();
  }
});

/* --------------------------------------------------------------- F12.1 --- */

/**
 * The credential goes in a header and the capability never holds it.
 *
 * A URL travels in logs, in redirects and in the other end's access log. A
 * header does not. This platform's redactor would catch the value in its own
 * trace and can do nothing about the vendor's, which is why a spec that puts a
 * credential in a URL is refused rather than warned about.
 */
test('a credential reaches the vendor in a header and nowhere else (F12.1)', async () => {
  const server = await vendor((call) =>
    call.method === 'POST'
      ? { status: 202, body: { id: 'msg_1' } }
      : { status: 200, body: { status: 'sent' } },
  );
  try {
    await httpCapability(sendSpec(server.url)).execute({ to: 'a@b.example' }, ctx());

    const sent = server.calls[0]!;
    // A token with the characters real base64 has. The tame one this test
    // used first -- letters and underscores -- percent-encodes to itself, so
    // it could not tell an encoded header from an unencoded one.
    assert.equal(sent.headers.authorization, 'Bearer sk_live/9aB+cD=eF');
    // Not percent-encoded: a token that arrives mangled is one the vendor
    // rejects while looking, in every log, exactly like the right one.
    assert.ok(!sent.headers.authorization!.includes('%'));
    assert.ok(!sent.path.includes('sk_live'), 'the credential must not be in the path');
    assert.ok(!sent.body.includes('sk_live'), 'nor in the body');
  } finally {
    await server.close();
  }
});

test('a spec that puts its credential in the URL is refused (F12.1)', () => {
  assert.throws(
    () => httpCapability({
      name: 'bad.send', adapter: 'x', tier: 0, method: 'GET',
      url: 'https://api.example/v1?key={credential}',
    }),
    (error: unknown) => isPalugadaError(error, 'contract.violation'),
  );
});

/* --------------------------------------------------------------- F12.8 --- */

/**
 * A retry without an idempotency key is a second real action.
 *
 * A runtime whose request timed out does not know whether the email went. The
 * vendor is the only party who can answer that, and it can only answer it if
 * the platform told it which call this is. Refused when the spec is built,
 * because discovering it at the moment of a duplicate is discovering it after
 * the duplicate.
 */
test('a side-effecting spec must carry an idempotency key (F12.8)', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => httpCapability({
        name: 'bad.write', adapter: 'x', tier: 0, method,
        url: 'https://api.example/v1/things',
      }),
      (error: unknown) => isPalugadaError(error, 'contract.violation'),
      method,
    );
  }

  // In the URL is as good as in a header: some vendors take it either way.
  assert.doesNotThrow(() => httpCapability({
    name: 'ok.write', adapter: 'x', tier: 0, method: 'POST',
    url: 'https://api.example/v1/things?key={idempotencyKey}',
  }));

  // And a read needs none: there is nothing to do twice.
  assert.doesNotThrow(() => httpCapability({
    name: 'ok.read', adapter: 'x', tier: 0, method: 'GET',
    url: 'https://api.example/v1/things',
  }));
});

test('the idempotency key on the wire is the one the engine minted (F12.8)', async () => {
  const server = await vendor(() => ({ status: 202, body: { id: 'msg_1' } }));
  try {
    const { verify: _verify, ...readOnly } = sendSpec(server.url);
    const capability = httpCapability({ ...readOnly, tier: 0 as const });
    await capability.execute({ to: 'a@b.example' }, ctx({ idempotencyKey: 'run-7-step-2' }));
    assert.equal(server.calls[0]!.headers['idempotency-key'], 'run-7-step-2');
  } finally {
    await server.close();
  }
});

/* ---------------------------------------------------------------- F8.4 --- */

/**
 * A tier 1 capability with no read-back is refused at construction.
 *
 * The broker refuses the call anyway. The difference is whether an operator
 * finds out when they configure it or an agent finds out halfway through
 * sending an invoice.
 */
test('a spec that writes and does not read back is refused (F8.4)', () => {
  for (const tier of [1, 2, 3] as const) {
    assert.throws(
      () => httpCapability({
        name: 'bad.write', adapter: 'x', tier, method: 'POST',
        url: 'https://api.example/v1?k={idempotencyKey}',
      }),
      (error: unknown) => isPalugadaError(error, 'capability.verify_missing'),
      `tier ${tier}`,
    );
  }
  assert.doesNotThrow(() => httpCapability({
    name: 'ok.read', adapter: 'x', tier: 0, method: 'GET', url: 'https://api.example/v1',
  }));
});

/**
 * A read-back that could not be made is not a read-back that passed.
 *
 * The vendor being unreachable for the second call is exactly the state where
 * the platform does not know whether the first one worked, and reporting that
 * as verified would be reporting a guess.
 */
test('a verify that cannot reach the vendor is a failure, not a pass (F8.4)', async () => {
  const server = await vendor((call) =>
    call.method === 'POST'
      ? { status: 202, body: { id: 'msg_1' } }
      : { status: 502, body: { status: 'sent' } },
  );
  try {
    // A lenient matcher, which is the ordinary operator mistake: it reads the
    // field it cares about and does not think about the status. The platform
    // refuses the read-back anyway, because a 502 whose body happens to say
    // the right thing -- an error page, a cached answer, a proxy's own
    // response -- is not evidence that anything worked.
    const spec = sendSpec(server.url);
    const capability = httpCapability({
      ...spec,
      verify: {
        ...spec.verify,
        matches: (answer: { body: unknown }) =>
          (answer.body as { status?: string } | null)?.status !== 'bounced',
      },
    });
    const context = ctx();
    const result = await capability.execute({ to: 'a@b.example' }, context);
    assert.equal(
      await capability.verify!({}, result, context),
      false,
      'a read-back the vendor could not serve is not a read-back that passed',
    );
  } finally {
    await server.close();
  }
});

test('a verify whose answer does not match is a failure (F8.4)', async () => {
  const server = await vendor((call) =>
    call.method === 'POST'
      ? { status: 202, body: { id: 'msg_1' } }
      : { status: 200, body: { id: 'msg_1', status: 'bounced' } },
  );
  try {
    const capability = httpCapability(sendSpec(server.url));
    const context = ctx();
    const result = await capability.execute({ to: 'a@b.example' }, context);
    assert.equal(await capability.verify!({}, result, context), false);
  } finally {
    await server.close();
  }
});

/* --------------------------------------------------------------- refusals --- */

/**
 * A vendor's refusal is a fact about the action, not a fault in the call.
 *
 * An agent can act on it only if it survives as one, and "402" and "402: card
 * declined" are different amounts of help.
 */
test("a vendor's refusal reaches the agent with what it said (F8)", async () => {
  const server = await vendor(() => ({ status: 402, body: { error: 'card declined' } }));
  try {
    const { verify: _verify, ...readOnly } = sendSpec(server.url);
    const capability = httpCapability({ ...readOnly, tier: 0 as const });
    await assert.rejects(
      () => capability.execute({ to: 'a@b.example' }, ctx()),
      (error: unknown) =>
        isPalugadaError(error, 'contract.violation')
        && /402/.test((error as Error).message)
        && /card declined/.test((error as Error).message),
    );
  } finally {
    await server.close();
  }
});

/**
 * A vendor URL is configuration, and configuration is a thing an operator can
 * get wrong. Pointing one at the metadata service should be refused rather
 * than obeyed because it arrived in a settings file instead of from an agent.
 */
test('a vendor URL inside this network is refused like any other (F12.9)', async () => {
  const capability = httpCapability({
    name: 'bad.vendor', adapter: 'x', tier: 0, method: 'GET',
    url: 'http://metadata.example/latest/meta-data/',
    reach: { resolve: async () => ['169.254.169.254'] },
  });
  await assert.rejects(
    () => capability.execute({}, ctx()),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
  );
});

/* ----------------------------------------------------------------- F8.12 --- */

test('preflight says whether the credential still works (F8.12)', async () => {
  let healthy = true;
  const server = await vendor(() => (healthy ? { status: 200, body: {} } : { status: 401, body: {} }));
  try {
    const capability = httpCapability({
      name: 'mail.ping', adapter: 'fakemail', tier: 0, method: 'GET',
      url: `${server.url}/v1/messages`,
      headers: { authorization: 'Bearer {credential}' },
      credentialAlias: 'mail',
      preflightUrl: `${server.url}/v1/me`,
      reach: { allowPrivateHosts: ['127.0.0.1'] },
    });

    const where = {
      companyId: ctx().companyId,
      divisionId: ctx().divisionId,
      credential: async (alias: string) => ctx().credential(alias),
    };

    assert.equal((await capability.preflight!(where)).ok, true);

    healthy = false;
    const failed = await capability.preflight!(where);
    assert.equal(failed.ok, false);
    assert.match(failed.detail ?? '', /401/);

    // And a caller with no way to resolve a credential is told so rather than
    // given a pass: F8.12 is for the failure no retry fixes, and for a
    // credentialed capability that failure *is* the credential.
    const blind = await capability.preflight!({
      companyId: ctx().companyId, divisionId: ctx().divisionId,
    });
    assert.equal(blind.ok, false);
    assert.match(blind.detail ?? '', /no way to resolve one/);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------ substitution --- */

/**
 * A value in a path must be encoded and a value in a header must not.
 *
 * An email address in a path segment breaks the URL unencoded; a bearer token
 * percent-encoded is a credential the vendor rejects while looking, in every
 * log, exactly like the right one.
 */
test('a placeholder is encoded for a URL and left alone in a header (F12.1)', () => {
  const values = {
    input: { to: 'ana+tag@supplier.example', note: 'a/b c' },
    idempotencyKey: 'run 7',
    credential: 'Bearer sk_live/abc+def',
    companyId: 'c', divisionId: 'd', taskId: 't',
  };

  assert.equal(
    fill('https://api.example/v1/{input.to}?k={idempotencyKey}', values),
    'https://api.example/v1/ana%2Btag%40supplier.example?k=run%207',
  );
  assert.equal(fill('Bearer {credential}', values, false), 'Bearer Bearer sk_live/abc+def');

  // A placeholder nothing fills is left as written rather than becoming
  // "undefined": a URL with a literal `{input.missing}` in it fails loudly at
  // the vendor, and one with `undefined` fetches the wrong thing quietly.
  assert.equal(fill('https://api.example/{input.missing}', values),
    'https://api.example/{input.missing}');
});

/* ------------------------------------------- what the third review found --- */

/**
 * A credential does not follow a redirect off the host it was issued for.
 *
 * The reachability check stops a redirect reaching *inside* this network. It
 * says nothing about a redirect to another perfectly ordinary public host --
 * and this platform's HTTP capabilities send a bearer token, so a vendor
 * answering `302 Location: https://attacker.example/` would have handed over a
 * live credential. The module's own comment claimed a header does not travel
 * in a redirect. It did.
 *
 * Two servers on loopback are two origins -- different ports -- so the drop
 * must happen between them exactly as it would between two domains.
 */
test('safeFetch drops a credential when the origin changes (F12.1)', async () => {
  const second = await vendor(() => ({ status: 200, body: { ok: true } }));
  try {
    const redirector = await vendorRedirectingTo(`${second.url}/landed`);
    try {
      const answer = await safeFetch(`${redirector.url}/start`, {
        allowPrivateHosts: ['127.0.0.1'],
        headers: {
          authorization: 'Bearer sk_live_secret',
          'X-Api-Key': 'sk_live_secret',
          accept: 'application/json',
        },
      });
      assert.equal(answer.status, 200);

      const landed = second.calls[0]!;
      assert.equal(landed.path, '/landed', 'the redirect was followed');
      assert.equal(landed.headers.authorization, undefined, 'the bearer token followed it');
      assert.equal(landed.headers['x-api-key'], undefined, 'so did the api key');
      // An ordinary header still travels: dropping everything would break
      // content negotiation for no security gain.
      assert.equal(landed.headers.accept, 'application/json');
    } finally {
      await redirector.close();
    }
  } finally {
    await second.close();
  }
});

/**
 * A side effect is not repeated at an address the caller never named.
 *
 * `307` and `308` mean "repeat exactly". Repeating a POST at a redirected host
 * is a second real action against a stranger, and the vendor's idempotency key
 * -- which is what makes a retry safe -- means nothing to a party that never
 * issued it.
 */
test('a side effect is not replayed at a redirected address (F12.8)', async () => {
  const redirector = await vendorRedirectingTo('https://example.com/elsewhere', 307);
  try {
    await assert.rejects(
      () => safeFetch(`${redirector.url}/send`, {
        allowPrivateHosts: ['127.0.0.1'],
        method: 'POST',
        body: '{"to":"a@b.example"}',
      }),
      (error: unknown) =>
        isPalugadaError(error, 'capability.unreachable')
        && /will not repeat a side effect/.test((error as Error).message),
    );
  } finally {
    await redirector.close();
  }
});

/**
 * Every URL a spec can name, not only the main one.
 *
 * `verify.url` and `preflightUrl` are filled from the same placeholders, so a
 * check that read one of the three left two doors open -- and worse than open:
 * `fill` percent-encodes into a URL, which defeats the redactor's verbatim
 * substring match, so the secret survives into this platform's own error
 * details and audit events as well as the vendor's access log.
 */
test('a credential is refused in every URL a spec can name (F12.1, F12.4)', () => {
  const base = {
    name: 'bad', adapter: 'x', tier: 0 as const, method: 'GET' as const,
    url: 'https://api.example/v1',
  };
  assert.throws(
    () => httpCapability({ ...base, preflightUrl: 'https://api.example/me?k={credential}' }),
    /preflightUrl/,
  );
  assert.throws(
    () => httpCapability({
      ...base, tier: 1 as const,
      verify: { url: 'https://api.example/v1/{result.id}?k={credential}', matches: () => true },
    }),
    /verify\.url/,
  );
});

/**
 * A truncated answer is not an answer.
 *
 * Half of a JSON document fails to parse, comes back as a string, and is
 * returned as the capability's result. `verify` then reads `{result.id}` off a
 * string, leaves the placeholder literal, and reports a successful write as
 * unverified -- which is the worst of the three possible outcomes, because it
 * is wrong in the direction of doing the thing twice.
 */
test('an answer larger than the cap is a failure, not a fragment (F8)', async () => {
  const server = await vendor(() => ({
    status: 200,
    body: { id: 'msg_1', padding: 'x'.repeat(4_000) },
  }));
  try {
    const capability = httpCapability({
      name: 'chatty.read', adapter: 'fakevendor', tier: 0, method: 'GET',
      url: `${server.url}/v1/thing`,
      reach: { allowPrivateHosts: ['127.0.0.1'] },
      // Deliberately smaller than the answer.
      maxBytes: 512,
    });
    await assert.rejects(
      () => capability.execute({}, ctx()),
      (error: unknown) =>
        isPalugadaError(error, 'contract.violation')
        && /more than it may read/.test((error as Error).message),
    );
  } finally {
    await server.close();
  }
});

/**
 * A read is not the write it is checking on.
 *
 * Sending the write's idempotency key on the read-back tells a vendor that
 * deduplicates by it that this *is* the write, and some answer with the
 * original response rather than the current state -- a read-back that reads
 * back the request. And a preflight has no input, so a header templated on
 * `{input.x}` would go out with the placeholder still in it; a vendor that
 * 400s on that marks a healthy credential unhealthy and halts every task that
 * needs it, which is the opposite of what F8.12 is for.
 */
test('a read-back and a preflight carry no idempotency key and no placeholders (F8.4, F8.12)', async () => {
  const server = await vendor((call) =>
    call.method === 'POST'
      ? { status: 202, body: { id: 'msg_1' } }
      : { status: 200, body: { id: 'msg_1', status: 'sent' } },
  );
  try {
    const spec = sendSpec(server.url);
    const capability = httpCapability({
      ...spec,
      headers: { ...spec.headers, 'x-thread': '{input.to}' },
      preflightUrl: `${server.url}/v1/me`,
    });
    const context = ctx();

    const result = await capability.execute({ to: 'a@b.example' }, context);
    assert.equal(server.calls[0]!.headers['idempotency-key'], 'idem-1');
    assert.equal(server.calls[0]!.headers['x-thread'], 'a@b.example');

    await capability.verify!({}, result, context);
    const readBack = server.calls[1]!;
    assert.equal(readBack.headers['idempotency-key'], undefined, 'a read is not the write');
    assert.equal(readBack.headers.authorization, 'Bearer sk_live/9aB+cD=eF');

    await capability.preflight!({
      companyId: context.companyId,
      divisionId: context.divisionId,
      credential: async (alias: string) => context.credential(alias),
    });
    const probe = server.calls[2]!;
    assert.equal(probe.headers['idempotency-key'], undefined);
    // The header templated on input is dropped rather than sent with the
    // placeholder still in it.
    assert.equal(probe.headers['x-thread'], undefined);
    assert.equal(probe.headers.authorization, 'Bearer sk_live/9aB+cD=eF');
  } finally {
    await server.close();
  }
});

/** A server whose only job is to redirect somewhere named. */
async function vendorRedirectingTo(
  location: string,
  status = 302,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { location, 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
