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
  ipv6Bytes,
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
  const context = ctx();
  // Into *this company's* directory, which is the one the capability reads.
  // Writing into the platform root would be writing where no company can see.
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  const mine = await companyRoot(root, context.companyId);
  await writeFile(join(mine, 'report.md'), 'hello', 'utf8');
  await mkdir(join(mine, 'drafts'));
  await writeFile(join(mine, 'drafts', 'one.txt'), 'x', 'utf8');

  const capability = filesList({ root });

  const listing = await capability.execute({}, context);
  assert.equal(listing.path, '.');
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind]).sort(),
    [['drafts', 'directory'], ['report.md', 'file']],
  );
  assert.equal(listing.entries.find((entry) => entry.name === 'report.md')!.bytes, 5);

  const inner = await capability.execute({ path: 'drafts' }, context);
  assert.equal(inner.path, 'drafts');
  assert.equal(inner.entries.length, 1);

  // Dots, which `normalize` flattens harmlessly -- and then the case that
  // actually matters. `resolve` does not follow a symbolic link, so a link to
  // `/etc` passes every string comparison; only `realpath` sees it. This is
  // the same defect the owner console had, written down in both places so the
  // second implementation did not have to rediscover it.
  await assert.rejects(() => capability.execute({ path: '../../etc' }, context));

  await symlink('/etc', join(mine, 'escape')).catch(() => undefined);
  await assert.rejects(
    () => capability.execute({ path: 'escape' }, context),
    (error: unknown) => isPalugadaError(error, 'capability.unreachable'),
    'a symlink walked out of the company files',
  );
});

test('files.list caps how much one call returns', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'palugada-many-'));
  const context = ctx();
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  const mine = await companyRoot(root, context.companyId);
  for (let i = 0; i < 12; i += 1) await writeFile(join(mine, `f${i}.txt`), 'x', 'utf8');

  const listing = await filesList({ root, maxEntries: 5 }).execute({}, context);
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

  const context = ctx();
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  const mine = await companyRoot(root, context.companyId);

  const llm = new RecordingLlmClient(() => 'Subject: Your invoice\n\nHello, the invoice is attached.');
  const doc = docDraft({ llm, root });
  const email = emailDraft({ llm, root });

  // Tier 1, not 0. The gap to `email.send` is the point of the split, and the
  // gap to tier 0 is the point of the calibration.
  assert.equal(doc.defaultTier, 1);
  assert.equal(email.defaultTier, 1);

  const written = await doc.execute({ brief: 'a memo about the outage' }, context);
  assert.match(written.path, /^drafts\/a-memo-about-the-outage-/);
  assert.equal(await readFile(join(mine, written.path), 'utf8'), written.text);
  assert.equal(written.words, written.text.trim().split(/\s+/).length);

  // F8.4: the read-back. Not a formality -- a write that reported success and
  // left nothing on disk is what it catches and a return code does not.
  assert.equal(await doc.verify!({ brief: '' }, written, context), true);
  assert.equal(
    await doc.verify!({ brief: '' }, { ...written, text: 'something else' }, context),
    false,
  );

  const drafted = await email.execute(
    { to: 'ana@supplier.example', brief: 'chase the invoice' }, context,
  );
  assert.equal(drafted.subject, 'Your invoice');
  assert.equal(drafted.body, 'Hello, the invoice is attached.');
  // Stored as a message, so what the owner opens is the thing that would be
  // sent rather than a description of it.
  const stored = await readFile(join(mine, drafted.path), 'utf8');
  assert.match(stored, /^To: ana@supplier\.example\nSubject: Your invoice\n\n/);
  assert.equal(await email.verify!({ to: '', brief: '' }, drafted, context), true);

  // F3.4: a policy saying "no drafts addressed outside our domain" needs the
  // domain from the capability, which makes the *draft* governable rather than
  // only the send.
  assert.equal(
    email.describe!({ to: 'ana@supplier.example', brief: '' }).recipientDomain,
    'supplier.example',
  );
  assert.equal(email.describe!({ to: 'nonsense', brief: '' }).recipientDomain, null);

  // F8.5: what it cost, measured rather than estimated.
  assert.equal(typeof (await doc.actualCostCents!({ brief: '' }, written, context)), 'number');
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
  const context = ctx();

  const written = await docDraft({ llm: new RecordingLlmClient(), root })
    .execute({ brief: '../../../../etc/cron.d/evil' }, context);
  assert.match(written.path, /^drafts\//);
  // Inside this company's directory, and the platform root holds nothing but
  // company directories.
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  assert.deepEqual(await readdir(await companyRoot(root, context.companyId)), ['drafts']);
  assert.deepEqual(await readdir(root), [context.companyId]);
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

/* --------------------------------------------- what the second review found --- */

/**
 * An IPv6 address has many spellings of the same value.
 *
 * The first version of `isPrivateV6` matched text: `fe80` as a prefix, and the
 * dotted `::ffff:1.2.3.4` form. Both are real spellings and both have twins.
 * `fe90::1` is link-local (the range is fe80::/10, not the four characters
 * `fe80`) and `::ffff:7f00:1` is loopback written in hex. Either one reaches
 * inside this network past a check that only reads the string.
 */
test('every spelling of an address inside the network is refused (F12.9)', () => {
  const inside = [
    '::ffff:7f00:1',        // 127.0.0.1, in hex rather than dotted
    '::ffff:a9fe:a9fe',     // 169.254.169.254, the metadata service, in hex
    '::FFFF:169.254.169.254',
    'fe90::1', 'fea0::1', 'feb0::1', 'febf:ffff::1',   // all fe80::/10
    'fc00::1', 'fdff::1',                              // all fc00::/7
    '0:0:0:0:0:0:0:1',      // loopback, written out
    '0000:0000:0000:0000:0000:0000:0000:0000',
    '64:ff9b::7f00:1',      // NAT64 wrapping loopback
    'fe80::1%eth0',         // with a zone index
  ];
  for (const address of inside) {
    assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
  }

  // And the ones just outside the ranges, which a check written with the wrong
  // mask would swallow.
  for (const address of ['fec0::1', 'fe7f::1', 'fb00::1', 'fe00::1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be allowed`);
  }
});

test('an IPv6 address parses to the same bytes however it is written', () => {
  assert.deepEqual([...ipv6Bytes('::1')!].slice(-2), [0, 1]);
  assert.deepEqual(ipv6Bytes('::ffff:127.0.0.1'), ipv6Bytes('::ffff:7f00:1'));
  assert.deepEqual(ipv6Bytes('fe80:0:0:0:0:0:0:1'), ipv6Bytes('fe80::1'));
  // Not addresses at all.
  for (const bad of ['::1::2', 'gggg::1', '1:2:3:4:5:6:7', 'hello']) {
    assert.equal(ipv6Bytes(bad), null, bad);
  }
});

/**
 * A deadline that only covers the handshake is not a deadline.
 *
 * A server that sends headers immediately and then trickles the body forever
 * is the classic way to hold a fetching process open -- and it is cheaper to
 * mount than a slow handshake, because the connection already looks healthy.
 * The first version cleared the timer as soon as the headers arrived.
 */
test('a stalled body hits the timeout rather than hanging (F12.9)', async () => {
  const open: Array<() => void> = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('the beginning');
    // And then nothing, for ever.
    open.push(() => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');

  try {
    // Raced against a clock rather than simply awaited. Without the race, a
    // regression here does not fail the test -- it hangs it, and a hung test
    // is a test whose result nobody reads. The mutation that put the
    // `clearTimeout` back must produce a red line, not a stuck run.
    const outcome = await Promise.race([
      safeFetch(`http://127.0.0.1:${address.port}/slow`, {
        allowPrivateHosts: ['127.0.0.1'],
        timeoutMs: 400,
      }).then(() => 'returned' as const, () => 'timed out' as const),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    assert.equal(outcome, 'timed out', 'a body that never ends must not be waited on for ever');
  } finally {
    for (const end of open) end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * The engine withdrawing a run is not the site being down.
 *
 * A stop-all, a lost lease or a deadline would otherwise come back as
 * `up: false`, and the role would escalate about a host that was never
 * actually probed. "We did not finish asking" and "it did not answer" are
 * different facts and only one is worth waking somebody for.
 */
test('a cancelled probe is not a site that is down (F5.8, F8)', async () => {
  const open: Array<() => void> = [];
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write('x');
    open.push(() => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');

  const withdrawn = new AbortController();
  const context = { ...ctx(), signal: withdrawn.signal };
  setTimeout(() => withdrawn.abort(), 100);

  try {
    // Raced for the same reason, and with a longer capability timeout than the
    // race so that what ends the call is the abort rather than the deadline.
    const outcome = await Promise.race([
      uptimeCheck({ allowPrivateHosts: ['127.0.0.1'], timeoutMs: 10_000 })
        .execute({ url: `http://127.0.0.1:${address.port}/health` }, context)
        .then((answer) => `reported up=${answer.up}` as const, () => 'threw' as const),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    assert.equal(outcome, 'threw', 'a withdrawn run must not be reported as a measurement');
  } finally {
    for (const end of open) end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * One filesystem, many companies, and no row-level security to inherit.
 *
 * F1.1 is enforced by the database everywhere else. A capability reading and
 * writing a filesystem has to do the same job by hand or it undoes it, and the
 * first version of these gave every company the same directory.
 */
test('one company cannot see another\'s files or drafts (F1.1, F12.9)', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-tenancy-'));

  const acme = { ...ctx(), companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const other = { ...ctx(), companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

  const list = filesList({ root });
  const doc = docDraft({ llm: new RecordingLlmClient(() => 'acme secrets'), root });

  // Acme writes a draft and puts a file beside it.
  const written = await doc.execute({ brief: 'the acme plan' }, acme);
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  await writeFile(join(await companyRoot(root, acme.companyId), 'private.txt'), 'x', 'utf8');

  const acmeSees = await list.execute({}, acme);
  assert.deepEqual(
    acmeSees.entries.map((entry) => entry.name).sort(),
    ['drafts', 'private.txt'],
  );

  // The other company sees an empty directory of its own, not Acme's.
  const otherSees = await list.execute({}, other);
  assert.deepEqual(otherSees.entries, []);

  // And cannot reach Acme's by naming it: the id comes from the broker, and
  // there is no argument that gets past the containment check.
  await assert.rejects(() => list.execute({ path: `../${acme.companyId}` }, other));

  // Nor can it read Acme's draft back as its own.
  assert.equal(await doc.verify!({ brief: '' }, written, acme), true);
  assert.equal(await doc.verify!({ brief: '' }, written, other), false);
});

/**
 * A link in a listing is reported as a link, not as its target.
 *
 * `stat` follows one, so a link to `/etc/shadow` would tell an agent how big
 * it is and when it last changed. That is not reading it, and it is not
 * nothing either.
 */
test('a symlink is listed as what it is, not as what it points at (F12.9)', async () => {
  const { mkdtemp, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-lstat-'));
  const context = ctx();
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  const mine = await companyRoot(root, context.companyId);
  await symlink('/etc/hostname', join(mine, 'peek'));

  const listing = await filesList({ root }).execute({}, context);
  const entry = listing.entries.find((candidate) => candidate.name === 'peek')!;
  assert.equal(entry.kind, 'other', 'a link is not a file');
  assert.equal(entry.bytes, 0, "and it does not report its target's size");
});

/**
 * A read-back that passes on an empty draft has stopped checking.
 *
 * `splitEmail` legitimately produces an empty body -- a model that wrote only
 * a subject line -- and `includes('')` is true of every string.
 */
test('an empty draft does not pass its own read-back (F8.4)', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-empty-'));
  const context = ctx();

  const email = emailDraft({
    llm: new RecordingLlmClient(() => 'Subject: Only a subject'),
    root,
  });
  const drafted = await email.execute({ to: 'a@b.example', brief: 'x' }, context);
  assert.equal(drafted.body, '');
  assert.equal(await email.verify!({ to: '', brief: '' }, drafted, context), true);

  // Now break the file behind it. The read-back must notice, which
  // `includes(result.body)` could not when the body is empty.
  const { companyRoot } = await import('../../src/capabilities/files.ts');
  await writeFile(join(await companyRoot(root, context.companyId), drafted.path), '', 'utf8');
  assert.equal(await email.verify!({ to: '', brief: '' }, drafted, context), false);
});

/**
 * A capability object is registered once and called by every division that
 * holds it. One `let` for the cost means two concurrent runs report each
 * other's, and F8.5's whole point is that a cost belongs to the call that
 * incurred it.
 */
test('two concurrent drafts do not report each other\'s cost (F8.5)', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-cost-'));

  let call = 0;
  const llm = {
    async complete() {
      const mine = (call += 1);
      // The second call finishes first, which is what makes a shared variable
      // report the wrong number rather than merely a stale one.
      await new Promise((resolve) => setTimeout(resolve, mine === 1 ? 60 : 5));
      return { content: `draft ${mine}`, inputTokens: 1, outputTokens: 1, costCents: mine * 100 };
    },
  };

  const doc = docDraft({ llm, root });
  const first = { ...ctx(), idempotencyKey: 'call-one' };
  const second = { ...ctx(), idempotencyKey: 'call-two' };

  const [a, b] = await Promise.all([
    doc.execute({ brief: 'one' }, first),
    doc.execute({ brief: 'two' }, second),
  ]);

  assert.equal(await doc.actualCostCents!({ brief: '' }, a!, first), 100);
  assert.equal(await doc.actualCostCents!({ brief: '' }, b!, second), 200);
});
