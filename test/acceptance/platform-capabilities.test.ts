/**
 * The capabilities the platform implements itself (PRD v2 F8, F12.9).
 *
 * The standard template grants twenty-five names and nineteen of them need
 * somebody's account. Six do not, and they were unbound for the same reason as
 * the nineteen -- which was the wrong reason, and the same one this repository
 * already got wrong about MFA: *a vendor account cannot be conjured, and code
 * can be written.*
 *
 * Most of what is tested here is what these refuse. `web.fetch` is granted to
 * four divisions in the standard template and makes a request from inside the
 * platform's own network, so the interesting question is never "does it fetch
 * a page" -- it is whether an agent that names
 * `http://169.254.169.254/latest/meta-data/` gets the machine's credentials.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import {
  assertReachable,
  isPrivateAddress,
  safeFetch,
} from '../../src/capabilities/reachable.ts';
import { uptimeCheck, webFetch } from '../../src/capabilities/web.ts';
import { filesList } from '../../src/capabilities/files.ts';
import { docDraft, emailDraft, slug, splitEmail } from '../../src/capabilities/draft.ts';
import { platformCapabilities } from '../../src/capabilities/platform.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** Enough of a `CapabilityContext` for a capability that uses none of it. */
function ctx() {
  return {
    companyId: '11111111-1111-1111-1111-111111111111',
    divisionId: '22222222-2222-2222-2222-222222222222',
    taskId: '33333333-3333-3333-3333-333333333333',
    idempotencyKey: 'key-1',
    signal: new AbortController().signal,
    async credential() {
      throw new Error('these capabilities hold no credential');
    },
  };
}

/** Answers whatever a test tells it to, on loopback. */
async function origin(
  reply: (path: string, index: number) => { status: number; headers?: Record<string, string>; body?: string },
): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const answer = reply(req.url ?? '', hits.length - 1);
    res.writeHead(answer.status, { 'content-type': 'text/plain', ...(answer.headers ?? {}) });
    res.end(answer.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/* ---------------------------------------------------------------- F12.9 --- */

/**
 * Every private range, one at a time.
 *
 * A single "a private address is refused" would pass with any one of these
 * left out, and the one left out would be the one that matters -- 169.254 is
 * not obviously private to anyone who has not been bitten by it, and it is the
 * one that hands over the machine's own credentials.
 */
test('every address inside this network is refused by name (F12.9)', () => {
  const inside = [
    '127.0.0.1', '127.1.2.3',                 // loopback
    '10.0.0.1', '10.255.255.254',             // private
    '172.16.0.1', '172.31.255.1',             // private
    '192.168.1.1',                            // private
    '169.254.169.254',                        // the cloud metadata service
    '0.0.0.0',                                // "this network"
    '100.64.0.1',                             // carrier-grade NAT
    '192.0.2.5', '198.18.0.1',                // documentation, benchmarking
    '224.0.0.1', '255.255.255.255',           // multicast, broadcast
    '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:169.254.169.254',                 // IPv4 wearing an IPv6 hat
    '::ffff:127.0.0.1',
    'not-an-address',
  ];
  for (const address of inside) {
    assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
  }

  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be allowed`);
  }

  // 172.15 and 172.32 are outside the private block, and a check written with
  // the wrong comparison would catch them.
  assert.equal(isPrivateAddress('172.15.0.1'), false);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
});

/**
 * The check is on what a name resolves to, not on how it looks.
 *
 * `localhost` is easy to spot. `metadata.google.internal` is a public name
 * with an A record pointing at 169.254.169.254, and an attacker's own domain
 * resolving to 127.0.0.1 costs nothing to set up. A blocklist of names is a
 * blocklist somebody registers around in an afternoon.
 */
test('a public name that resolves inside the network is refused (F12.9)', async () => {
  const resolve = async (hostname: string) => {
    if (hostname === 'evil.example') return ['203.0.113.9', '127.0.0.1'];
    if (hostname === 'metadata.example') return ['169.254.169.254'];
    if (hostname === 'good.example') return ['93.184.216.34'];
    return [];
  };

  await assert.rejects(
    () => assertReachable('https://metadata.example/token', { resolve }),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
  );

  // Two records, one public and one loopback. Which one the socket uses is not
  // this code's choice, so *any* private answer is a refusal -- a checker that
  // stopped at the first record is a documented way past this.
  await assert.rejects(
    () => assertReachable('https://evil.example/', { resolve }),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
  );

  const fine = await assertReachable('https://good.example/page', { resolve });
  assert.equal(fine.hostname, 'good.example');

  // A name that resolves to nothing is refused rather than attempted.
  await assert.rejects(
    () => assertReachable('https://nowhere.example/', { resolve }),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
  );
});

test('only http and https are fetched (F12.9)', async () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/',
    'data:text/plain,hello',
    'not a url at all',
  ]) {
    await assert.rejects(
      () => assertReachable(url),
      (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
      url,
    );
  }
});

/**
 * The same attack with one extra hop.
 *
 * A permitted host answering `302 Location: http://169.254.169.254/` reaches
 * the metadata service just as directly, and `redirect: 'follow'` would take
 * it without asking anybody. So redirects are followed by hand with the check
 * applied to each one.
 */
test('a redirect into the network is refused at the hop (F12.9)', async () => {
  const server = await origin((path) =>
    path === '/away'
      ? { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
      : { status: 200, body: 'ok' },
  );
  try {
    // The server is on loopback, so it is only reachable at all because the
    // test says so -- which is exactly how a deployment names an internal
    // wiki, and it means the redirect is the only thing under test.
    const allow = { allowPrivateHosts: ['127.0.0.1'] };

    const fine = await safeFetch(`${server.url}/here`, allow);
    assert.equal(fine.status, 200);

    await assert.rejects(
      () => safeFetch(`${server.url}/away`, allow),
      (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
      'a redirect must be checked like any other destination',
    );
  } finally {
    await server.close();
  }
});

test('a redirect loop ends rather than spinning (F12.9)', async () => {
  const server = await origin(() => ({ status: 302, headers: { location: '/again' } }));
  try {
    await assert.rejects(
      () => safeFetch(`${server.url}/start`, {
        allowPrivateHosts: ['127.0.0.1'],
        maxRedirects: 2,
      }),
      /redirected more than 2 times/,
    );
    assert.equal(server.hits.length, 3, 'the original and two hops, then it stops');
  } finally {
    await server.close();
  }
});

/**
 * A capability that read an unbounded response into memory is one an agent can
 * use to exhaust the orchestrator by naming a large file.
 */
test('a large page is truncated rather than swallowed whole (F12.9)', async () => {
  const server = await origin(() => ({ status: 200, body: 'x'.repeat(200_000) }));
  try {
    const answer = await safeFetch(`${server.url}/big`, {
      allowPrivateHosts: ['127.0.0.1'],
      maxBytes: 1_000,
    });
    assert.equal(answer.truncated, true);
    assert.ok(answer.body.length <= 1_000, `${answer.body.length} bytes came back`);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------- web.fetch --- */

test('web.fetch reads a page and reports where it was sent (F8, F3.4)', async () => {
  const server = await origin(() => ({ status: 200, body: '<h1>hello</h1>' }));
  try {
    const capability = webFetch({ allowPrivateHosts: ['127.0.0.1'] });
    const answer = await capability.execute({ url: `${server.url}/page` }, ctx());

    assert.equal(answer.status, 200);
    assert.equal(answer.body, '<h1>hello</h1>');
    assert.equal(answer.truncated, false);

    // F3.4: a policy can say "not that host" only if the capability says which
    // host. A guess would break silently the day an argument was renamed.
    assert.equal(capability.describe!({ url: 'https://example.com/a' }).urlHost, 'example.com');
    assert.equal(capability.describe!({ url: 'nonsense' }).urlHost, null);

    // Tier 0, because it changes nothing -- and that is exactly why it needed
    // the reachability rules: it is the capability most likely to be granted
    // without much thought.
    assert.equal(capability.defaultTier, 0);
  } finally {
    await server.close();
  }
});

test('web.fetch cannot reach the metadata service (F12.9)', async () => {
  const capability = webFetch({ resolve: async () => ['169.254.169.254'] });
  await assert.rejects(
    () => capability.execute({ url: 'http://metadata.example/latest/meta-data/' }, ctx()),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
  );
});

/* ---------------------------------------------------------- uptime.check --- */

/**
 * A host being down is the answer to the question, not an error in asking it.
 *
 * A capability that threw would make "the site is down" indistinguishable from
 * "the capability is broken" in every trace that recorded it, and only one of
 * those is worth an incident.
 */
test('uptime.check reports down rather than failing (F8)', async () => {
  const capability = uptimeCheck({ allowPrivateHosts: ['127.0.0.1'], timeoutMs: 300 });

  const up = await origin(() => ({ status: 200, body: 'ok' }));
  try {
    const answer = await capability.execute({ url: `${up.url}/health` }, ctx());
    assert.equal(answer.up, true);
    assert.equal(answer.status, 200);
    assert.ok(answer.latencyMs >= 0);
  } finally {
    await up.close();
  }

  // Nothing listening: down, with a measurement rather than a throw.
  const down = await capability.execute({ url: 'http://127.0.0.1:1/health' }, ctx());
  assert.equal(down.up, false);
  assert.equal(down.status, 0);

  // A 500 is up-but-unhealthy, and the caller may say which statuses count.
  const failing = await origin(() => ({ status: 503, body: 'nope' }));
  try {
    const answer = await capability.execute({ url: `${failing.url}/health` }, ctx());
    assert.equal(answer.up, false);
    assert.equal(answer.status, 503);

    const permissive = await capability.execute(
      { url: `${failing.url}/health`, expectStatus: [503] }, ctx(),
    );
    assert.equal(permissive.up, true);
  } finally {
    await failing.close();
  }
});

/**
 * Being told a URL is inside the network is not a measurement.
 *
 * Reporting it as "down" would hide a misconfiguration behind a plausible
 * answer, and the role would escalate about a host that was never probed.
 */
test('uptime.check refuses an internal target rather than calling it down (F12.9)', async () => {
  const capability = uptimeCheck({ resolve: async () => ['10.0.0.5'] });
  await assert.rejects(
    () => capability.execute({ url: 'http://internal.example/health' }, ctx()),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
  );
});

/* ------------------------------------------------------------ files.list --- */

test('files.list lists a directory and nothing above it (F12.9)', async () => {
  const { mkdtemp, writeFile, mkdir, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'palugada-files-'));
  await writeFile(join(root, 'report.md'), 'hello', 'utf8');
  await mkdir(join(root, 'drafts'));
  await writeFile(join(root, 'drafts', 'one.txt'), 'x', 'utf8');

  const capability = filesList({ root });

  const listing = await capability.execute({}, ctx());
  assert.equal(listing.path, '.');
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind]).sort(),
    [['drafts', 'directory'], ['report.md', 'file']],
  );
  assert.equal(listing.entries.find((entry) => entry.name === 'report.md')!.bytes, 5);

  const inner = await capability.execute({ path: 'drafts' }, ctx());
  assert.equal(inner.path, 'drafts');
  assert.equal(inner.entries.length, 1);

  // Dots, which `normalize` flattens harmlessly -- and then the case that
  // actually matters. `resolve` does not follow a symbolic link, so a link to
  // `/etc` passes every string comparison; only `realpath` sees it. This is
  // the same defect the owner console had, written down in both places so the
  // second implementation did not have to rediscover it.
  await assert.rejects(() => capability.execute({ path: '../../etc' }, ctx()));

  await symlink('/etc', join(root, 'escape')).catch(() => undefined);
  await assert.rejects(
    () => capability.execute({ path: 'escape' }, ctx()),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
    'a symlink walked out of the company files',
  );
});

test('files.list caps how much one call returns', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'palugada-many-'));
  for (let i = 0; i < 12; i += 1) await writeFile(join(root, `f${i}.txt`), 'x', 'utf8');

  const listing = await filesList({ root, maxEntries: 5 }).execute({}, ctx());
  assert.equal(listing.entries.length, 5);
  assert.equal(listing.truncated, true);
});

/* ------------------------------------------------- doc.draft, email.draft --- */

/**
 * A draft is a write, and the catalogue is what said so.
 *
 * The first version of these capabilities returned text and stored nothing, at
 * tier 0, because that felt safer. `assertCalibrated` refused to register it,
 * correctly: §8.8 puts a draft at tier 1 because it is a **write that can be
 * undone by rewriting**, and a capability that stores nothing is not that
 * capability -- it also has nothing to `verify()`, and a required read-back
 * with nothing to read back is a rule being worked around rather than met.
 *
 * Recorded here rather than quietly fixed, because the calibration check
 * catching a design mistake is the check doing exactly what it is for.
 */
test('a draft is written where the owner can find it, and read back (F8.2, F8.4)', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-drafts-'));

  const llm = new RecordingLlmClient(() => 'Subject: Your invoice\n\nHello, the invoice is attached.');
  const doc = docDraft({ llm, root });
  const email = emailDraft({ llm, root });

  // Tier 1, not 0. The gap to `email.send` is the point of the split, and the
  // gap to tier 0 is the point of the calibration.
  assert.equal(doc.defaultTier, 1);
  assert.equal(email.defaultTier, 1);

  const written = await doc.execute({ brief: 'a memo about the outage' }, ctx());
  assert.match(written.path, /^drafts\/a-memo-about-the-outage-/);
  assert.equal(await readFile(join(root, written.path), 'utf8'), written.text);
  assert.equal(written.words, written.text.trim().split(/\s+/).length);

  // F8.4: the read-back. Not a formality -- a write that reported success and
  // left nothing on disk is what it catches and a return code does not.
  assert.equal(await doc.verify!({ brief: '' }, written, ctx()), true);
  assert.equal(
    await doc.verify!({ brief: '' }, { ...written, text: 'something else' }, ctx()),
    false,
  );

  const drafted = await email.execute(
    { to: 'ana@supplier.example', brief: 'chase the invoice' }, ctx(),
  );
  assert.equal(drafted.subject, 'Your invoice');
  assert.equal(drafted.body, 'Hello, the invoice is attached.');
  // Stored as a message, so what the owner opens is the thing that would be
  // sent rather than a description of it.
  const stored = await readFile(join(root, drafted.path), 'utf8');
  assert.match(stored, /^To: ana@supplier\.example\nSubject: Your invoice\n\n/);
  assert.equal(await email.verify!({ to: '', brief: '' }, drafted, ctx()), true);

  // F3.4: a policy saying "no drafts addressed outside our domain" needs the
  // domain from the capability, which makes the *draft* governable rather than
  // only the send.
  assert.equal(
    email.describe!({ to: 'ana@supplier.example', brief: '' }).recipientDomain,
    'supplier.example',
  );
  assert.equal(email.describe!({ to: 'nonsense', brief: '' }).recipientDomain, null);

  // F8.5: what it cost, measured rather than estimated.
  assert.equal(typeof (await doc.actualCostCents!({ brief: '' }, written, ctx())), 'number');
});

/**
 * The filename is the platform's, never the caller's.
 *
 * A capability that let a role choose the filename is one that lets a role
 * choose `../../etc/cron.d/anything`. The slug is an allow-list rather than a
 * deny-list, because the input is prose written by an agent and "which
 * characters are dangerous in a filename" has a different answer on every
 * filesystem, while "which are safe" has the same short one everywhere.
 */
test('a brief cannot become a path (F12.9)', async () => {
  assert.equal(slug('../../etc/passwd'), 'etc-passwd');
  assert.equal(slug('/absolute/thing'), 'absolute-thing');
  assert.equal(slug('..'), 'draft');
  assert.equal(slug(''), 'draft');
  assert.equal(slug('   '), 'draft');
  assert.equal(slug('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(slug('Quarterly Report — Q3'), 'quarterly-report-q3');
  assert.ok(slug('x'.repeat(200)).length <= 48);

  // And the whole path, end to end: a brief full of traversal lands in
  // `drafts/` like every other draft.
  const { mkdtemp, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-slug-'));

  const written = await docDraft({ llm: new RecordingLlmClient(), root })
    .execute({ brief: '../../../../etc/cron.d/evil' }, ctx());
  assert.match(written.path, /^drafts\//);
  assert.deepEqual(await readdir(root), ['drafts']);
});

/**
 * A model that ignored the format still produced something a person can send.
 *
 * Refusing it would turn a formatting slip into a failed task, which is the
 * wrong trade -- but silence is different from a slip, and an empty body comes
 * back empty rather than as the subject repeated.
 */
test('an email draft survives a model that ignored the format (F8.2)', () => {
  assert.deepEqual(
    splitEmail('Subject: Hello\n\nThe body.', 'fallback'),
    { subject: 'Hello', body: 'The body.' },
  );
  assert.deepEqual(
    splitEmail('Just the body, no subject line.', 'fallback'),
    { subject: 'fallback', body: 'Just the body, no subject line.' },
  );
  assert.deepEqual(splitEmail('Subject: Only a subject', 'fallback'), {
    subject: 'Only a subject',
    body: '',
  });
  assert.deepEqual(splitEmail('   ', 'fallback'), { subject: 'fallback', body: '' });
});

/* ------------------------------------------------------------- assembly --- */

/**
 * What a deployment gets, and what it does not get by default.
 *
 * `files.list` needs to be told which directory is the company's, and there is
 * no safe default: the default would be this process's working directory,
 * which is the repository. A capability that guessed would be one an agent
 * could use to list the platform's own source.
 */
test('the platform binds what it can and leaves the rest unbound (F8)', () => {
  assert.deepEqual(
    platformCapabilities().map((capability) => capability.name).sort(),
    ['uptime.check', 'web.fetch'],
  );

  // A model with nowhere to write is not enough: §8.8 makes a draft a tier 1
  // write, and a tier 1 capability with nothing to read back is a rule being
  // worked around.
  assert.deepEqual(
    platformCapabilities({ llm: new RecordingLlmClient() })
      .map((capability) => capability.name).sort(),
    ['uptime.check', 'web.fetch'],
  );

  const full = platformCapabilities({
    files: { root: '/tmp' },
    llm: new RecordingLlmClient(),
  });
  assert.deepEqual(
    full.map((capability) => capability.name).sort(),
    ['doc.draft', 'email.draft', 'files.list', 'uptime.check', 'web.fetch'],
  );

  // Every one of them declares the adapter it belongs to, which is what the
  // catalogue groups by and what an operator reads when asking "who
  // implements this".
  for (const capability of full) {
    assert.match(capability.adapter, /^platform:/, capability.name);
  }
});
