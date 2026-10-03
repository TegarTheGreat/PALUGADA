/**
 * `code.compute` (the tools research, recommendation 6;
 * src/capabilities/compute.ts): a role works out figures in Python -- a
 * month's sales from a spreadsheet, a chart for the owner -- on the
 * company's files it names, in a container with no network, and what the
 * code wrote is kept in the company's files.
 *
 * The container is played here by a docker client that logs what it was
 * asked and runs the same runner with this machine's Python: the protocol,
 * the files in and out, the read-back and every refusal are the suite's to
 * check, and the argv is the boundary, so it is checked as an argv. What the
 * flags do on a real daemon -- no network, no root, a read-only image, the
 * memory and the processes capped -- is `npm run compute:check`'s, in CI's
 * docker job, as `container:check` is for a role's runtime.
 *
 * And F8.10, which kept code supplied at call time away from any credential
 * and any tier 2 grant because the sandbox could not stop it posting either
 * one somewhere: code that can reach no network can post nothing, so this
 * one may sit beside both, while `code.execute` still may not.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { codeCompute, computeFrom } from '../../src/capabilities/compute.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../../src/templates/standard.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const refused = (code: string, said: RegExp) => (error: unknown) => isPalugadaError(error, code as never) && said.test((error as Error).message);
const IMAGE = 'palugada/compute:test';
const python = spawnSync('python3', ['--version']).status === 0;
const needsPython = { skip: python ? false : 'no python3 on this machine to play the container with' };

/**
 * A docker client that logs each call and its environment, and plays `run`
 * with this machine's Python: whatever follows the image is Python's
 * arguments, as `--entrypoint python3` makes them in a container. `rm`
 * ends a run that is still going, as removing its container does.
 */
async function fakeDocker(behaviour: 'python' | 'hang' | 'no-image' | { answer: unknown } = 'python') {
  const dir = await mkdtemp(join(tmpdir(), 'palugada-compute-docker-'));
  const log = join(dir, 'docker.log');
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!${process.execPath}
const { appendFileSync, writeFileSync, readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: Object.keys(process.env) }) + '\\n');
const pids = (name) => ${JSON.stringify(dir)} + '/' + name + '.pid';
if (args[0] === 'rm') {
  try { process.kill(-Number(readFileSync(pids(args.at(-1)), 'utf8')), 'SIGKILL'); } catch {}
  process.exit(0);
}
if (args[0] !== 'run') process.exit(0);
const name = args[args.indexOf('--name') + 1];
const forged = ${JSON.stringify(typeof behaviour === 'object' ? behaviour.answer : null)};
if (forged) {
  process.stdout.write(JSON.stringify(forged));
  process.exit(0);
}
if (${JSON.stringify(behaviour)} === 'no-image') {
  process.stderr.write("Unable to find image '${IMAGE}' locally\\nError response from daemon: No such image: ${IMAGE}\\n");
  process.exit(125);
}
const child = ${JSON.stringify(behaviour)} === 'hang'
  ? spawn('sleep', ['600'], { stdio: 'inherit', detached: true })
  : spawn('python3', args.slice(args.indexOf(${JSON.stringify(IMAGE)}) + 1), { stdio: 'inherit', detached: true });
writeFileSync(pids(name), String(child.pid));
child.on('exit', (code, signal) => process.exit(code ?? 137));
`, { mode: 0o755 });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; env: string[] });
  return { docker, calls };
}

async function companyFiles() {
  const root = await mkdtemp(join(tmpdir(), 'palugada-compute-files-'));
  const companyId = randomUUID();
  const mine = join(root, companyId);
  await mkdir(join(mine, 'penjualan'), { recursive: true });
  await writeFile(join(mine, 'penjualan', 'september.csv'), 'tanggal,produk,jumlah\n2026-09-01,kopi susu,30000\n2026-09-02,teh,12000\n2026-09-02,kopi susu,30000\n');
  const ctx = (signal: AbortSignal = AbortSignal.timeout(30_000)) => ({ companyId, taskId: randomUUID(), idempotencyKey: randomUUID(), signal }) as never;
  return { root, mine, ctx };
}

const SUMS = `
import csv, json, os
with open('in/penjualan/september.csv', newline='') as f:
    rows = list(csv.DictReader(f))
per = {}
for row in rows:
    per[row['produk']] = per.get(row['produk'], 0) + int(row['jumlah'])
print('Total September:', sum(per.values()))
os.makedirs('out/rinci', exist_ok=True)
with open('out/ringkasan.json', 'w') as f:
    json.dump(per, f, sort_keys=True)
with open('out/rinci/baris.txt', 'w') as f:
    f.write(str(len(rows)))
`;

test('code.compute runs a role\'s Python on the files it names, in a container that reaches nothing, and keeps what it wrote', needsPython, async () => {
  const { docker, calls } = await fakeDocker();
  const { root, mine, ctx } = await companyFiles();
  process.env.PALUGADA_COMPUTE_TEST_SECRET = 'the orchestrator holds this; the container must not see it';
  try {
    const compute = codeCompute({ root, image: IMAGE, docker });
    const at = ctx();
    const result = await compute.execute({ code: SUMS, files: ['penjualan/september.csv'] }, at);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /Total September: 72000/);
    assert.deepEqual(result.files.map((file) => file.path.split('/').slice(2).join('/')), ['rinci/baris.txt', 'ringkasan.json']);

    // Kept in the company's files, under a folder of its own, each read back by its digest.
    const folder = result.files[0]!.path.split('/').slice(0, 2).join('/');
    assert.match(folder, /^computed\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    const kept = await readFile(join(mine, folder, 'ringkasan.json'), 'utf8');
    assert.deepEqual(JSON.parse(kept), { 'kopi susu': 60000, teh: 12000 });
    for (const file of result.files) {
      const bytes = await readFile(join(mine, file.path));
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(file.bytes, bytes.length);
      assert.equal((await stat(join(mine, file.path))).mode & 0o777, 0o600);
    }
    assert.equal(await compute.verify!({ code: SUMS }, result, at), true);
    await writeFile(join(mine, folder, 'ringkasan.json'), '{}');
    assert.equal(await compute.verify!({ code: SUMS }, result, at), false, 'a file that is not what was written fails the read-back');

    // The boundary is the argv: no network, no root, nothing to keep, nothing mounted.
    const run = (await calls()).find((call) => call.args[0] === 'run')!;
    const argv = run.args;
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    for (const required of ['--rm', '--interactive', '--init', '--read-only']) assert.ok(argv.includes(required), required);
    assert.equal(flag('--network'), 'none');
    assert.equal(flag('--pull'), 'never');
    assert.equal(flag('--cap-drop'), 'ALL');
    assert.equal(flag('--security-opt'), 'no-new-privileges');
    assert.equal(flag('--user'), '65534:65534');
    assert.equal(flag('--memory'), '1g');
    assert.equal(flag('--cpus'), '1');
    assert.equal(flag('--pids-limit'), '128');
    assert.match(flag('--tmpfs')!, /^\/tmp:rw,noexec,nosuid,nodev,size=\d+m$/);
    assert.equal(flag('--entrypoint'), 'python3');
    assert.match(flag('--name')!, /^palugada-compute-[0-9a-f-]{36}$/);
    assert.ok(!argv.some((arg) => ['-v', '--volume', '--mount', '--env', '-e', '--env-file', '--privileged', '--network=host'].includes(arg)), argv.join(' '));
    assert.equal(argv.slice(argv.indexOf(IMAGE) + 1, argv.indexOf(IMAGE) + 3).join(' '), '-I -c', 'Python in isolated mode, given the runner');
    // The docker client is handed its own settings and nothing of the orchestrator's.
    assert.ok(!run.env.includes('PALUGADA_COMPUTE_TEST_SECRET'));
    assert.ok(!run.env.includes('DATABASE_URL'));
    // A run that ended by itself leaves no container: removed by its name either way.
    assert.deepEqual((await calls()).at(-1)!.args, ['rm', '--force', flag('--name')]);
  } finally {
    delete process.env.PALUGADA_COMPUTE_TEST_SECRET;
  }
});

test('code that fails, or runs past its time, says why and keeps nothing', needsPython, async () => {
  const { docker } = await fakeDocker();
  const { root, mine, ctx } = await companyFiles();
  const compute = codeCompute({ root, image: IMAGE, docker });

  const failed = await compute.execute({ code: "open('out/setengah.txt', 'w').write('x')\nprint('mulai')\n1 / 0\n" }, ctx());
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stdout, /mulai/);
  assert.match(failed.stderr, /ZeroDivisionError/);
  assert.match(failed.said!, /exited 1: what it printed to stderr says why; nothing it wrote was kept/);
  assert.deepEqual(failed.files, []);

  const started = Date.now();
  const slow = await compute.execute({ code: 'while True:\n    pass\n', seconds: 1 }, ctx());
  assert.ok(Date.now() - started < 15_000, 'stopped at its time, not at the container\'s');
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
  assert.match(slow.said!, /ran past its 1 second and was stopped; nothing it wrote was kept/);
  assert.equal(existsSync(join(mine, 'computed')), false, 'nothing was kept from either');
});

test('what the code wrote is kept only when every file is a plain file with a plain name, within the limits', needsPython, async () => {
  const { docker } = await fakeDocker();
  const { root, mine, ctx } = await companyFiles();
  const compute = codeCompute({ root, image: IMAGE, docker });
  const cases: Array<[string, RegExp]> = [
    // A link would hand back whatever it pointed at in the container.
    ["import os\nos.symlink('/etc/passwd', 'out/sandi')\n", /out\/sandi is a link, not a file: write the file itself/],
    ["open('out/baris\\nbaru.txt', 'w').write('x')\n", /is not a name a file can be kept under/],
    ["open('out/.tersembunyi', 'w').write('x')\n", /out\/\.tersembunyi is not a name a file can be kept under/],
    ["for n in range(21):\n    open(f'out/{n}.txt', 'w').write('x')\n", /out\/ holds more than 20 files: write fewer, or put them in one/],
    ["open('out/besar.bin', 'wb').write(b'x' * (17 * 1024 * 1024))\n", /out\/ holds more than 16 MB: write less/],
  ];
  for (const [code, said] of cases) {
    const result = await compute.execute({ code }, ctx());
    assert.equal(result.ok, false, code);
    assert.match(result.said ?? '', said, code);
    assert.deepEqual(result.files, [], code);
  }
  assert.equal(existsSync(join(mine, 'computed')), false, 'nothing was kept from any of them');

  // What comes back is checked again here: code running as the runner's
  // user could have answered in its place.
  const answer = (files: Array<{ path: string; data: string }>) => ({ exit: 0, timedOut: false, stdout: '', stdoutMore: 0, stderr: '', stderrMore: 0, files });
  const x = Buffer.from('x').toString('base64');
  const forged: Array<[Array<{ path: string; data: string }>, RegExp]> = [
    [[{ path: '../../luar.txt', data: x }], /out\/\.\.\/\.\.\/luar\.txt is not a name a file can be kept under/],
    [[{ path: '/etc/cron.d/x', data: x }], /is not a name a file can be kept under/],
    [[{ path: 'a', data: x }, { path: 'a/b', data: x }], /out\/a was handed back as two things at once; nothing was kept/],
    [[{ path: 'sama.txt', data: x }, { path: 'sama.txt', data: x }], /out\/sama\.txt was handed back as two things at once/],
    [Array.from({ length: 21 }, (_none, n) => ({ path: `${n}.txt`, data: x })), /out\/ holds more than 20 files/],
  ];
  for (const [files, said] of forged) {
    const fake = await fakeDocker({ answer: answer(files) });
    const result = await codeCompute({ root, image: IMAGE, docker: fake.docker }).execute({ code: 'print(1)' }, ctx());
    assert.equal(result.ok, false, JSON.stringify(files).slice(0, 80));
    assert.match(result.said ?? '', said);
  }
  assert.equal(existsSync(join(mine, 'computed')), false, 'nothing was kept from a forged answer either');
});

test('code.compute is handed only this company\'s files, and says so before anything runs', needsPython, async () => {
  const { docker, calls } = await fakeDocker();
  const { root, mine, ctx } = await companyFiles();
  const compute = codeCompute({ root, image: IMAGE, docker });
  const other = join(root, randomUUID());
  await mkdir(other);
  await writeFile(join(other, 'rahasia.csv'), 'gaji\n1\n');
  await symlink(join(other, 'rahasia.csv'), join(mine, 'pintas.csv'));
  for (const path of ['pintas.csv', `../${other.split('/').at(-1)}/rahasia.csv`, 'penjualan/../../x.csv']) {
    await assert.rejects(compute.execute({ code: 'print(1)', files: [path] }, ctx()), refused('capability.unreachable', /outside the company's files/), path);
  }
  await assert.rejects(compute.execute({ code: 'print(1)', files: ['tidak/ada.csv'] }, ctx()), refused('contract.violation', /there is no file tidak\/ada\.csv/));
  await assert.rejects(compute.execute({ code: 'print(1)', files: Array.from({ length: 21 }, (_none, n) => `f${n}.csv`) }, ctx()),
    refused('contract.violation', /at most 20 files are handed to one run/));
  assert.deepEqual(await calls(), [], 'no container was started for any of them');
});

test('a container that does not finish is removed, and a missing image or docker is said plainly', needsPython, async () => {
  const { root, ctx } = await companyFiles();

  const hanging = await fakeDocker('hang');
  const stuck = codeCompute({ root, image: IMAGE, docker: hanging.docker, graceMs: 500 });
  await assert.rejects(stuck.execute({ code: 'print(1)', seconds: 1 }, ctx()),
    refused('capability.unreachable', /the container did not hand back a result within 1 second and its grace; it was removed/));
  const started = (await hanging.calls()).find((call) => call.args[0] === 'run')!.args;
  const removed = (await hanging.calls()).filter((call) => call.args[0] === 'rm').map((call) => call.args.at(-1));
  assert.ok(removed.includes(started[started.indexOf('--name') + 1]), 'removed by its name');

  // Stopped by the run that asked: removed the same way.
  const again = await fakeDocker('hang');
  const stopping = new AbortController();
  setTimeout(() => stopping.abort(), 300);
  await assert.rejects(codeCompute({ root, image: IMAGE, docker: again.docker }).execute({ code: 'print(1)' }, ctx(stopping.signal)),
    refused('capability.unreachable', /was stopped/));
  assert.ok((await again.calls()).some((call) => call.args[0] === 'rm'));

  const missing = await fakeDocker('no-image');
  await assert.rejects(codeCompute({ root, image: IMAGE, docker: missing.docker }).execute({ code: 'print(1)' }, ctx()),
    refused('capability.unreachable', /the compute image palugada\/compute:test is not on this machine's docker: build it from deploy\/compute/));
  await assert.rejects(codeCompute({ root, image: IMAGE, docker: '/nonexistent/docker' }).execute({ code: 'print(1)' }, ctx()),
    refused('capability.unreachable', /\/nonexistent\/docker could not be started/));
});

test('code.compute is catalogued as tier 1 code that reaches no network, and bound only with an image and the company\'s files', () => {
  const declared = declarationFor('code.compute');
  assert.ok(declared);
  assert.deepEqual([declared.tier, declared.executesUntrustedCode, declared.networkIsolated, declared.readsOutside], [1, true, true, true]);
  assert.equal(declarationFor('code.execute')!.networkIsolated ?? false, false, 'the sandbox still reaches the network');

  // Only the platform's container may claim it: a binding that does not say it reaches no network is refused.
  const registry = new CapabilityRegistry();
  assert.throws(() => registry.register({
    name: 'code.compute', adapter: 'vendor:somewhere', defaultTier: 1, executesUntrustedCode: true,
    execute: async () => ({}), verify: async () => true,
  }), (error: unknown) => isPalugadaError(error, 'capability.miscalibrated') && /networkIsolated = true/.test((error as Error).message));

  assert.match(computeFrom({}, '/srv/files').note ?? '', /code\.compute is unbound: set PALUGADA_COMPUTE_IMAGE to an image built from deploy\/compute/);
  assert.match(computeFrom({ PALUGADA_COMPUTE_IMAGE: 'palugada/compute:1' }, null).note ?? '',
    /code\.compute is unbound: it reads and writes the company's files, and PALUGADA_FILES_ROOT is not set/);
  const bound = computeFrom({ PALUGADA_COMPUTE_IMAGE: 'palugada/compute:1', PALUGADA_RUNTIME_DOCKER: '/usr/bin/podman' }, '/srv/files');
  assert.deepEqual(bound, { options: { root: '/srv/files', image: 'palugada/compute:1', docker: '/usr/bin/podman' } });
  assert.equal(computeFrom({ PALUGADA_COMPUTE_IMAGE: 'palugada/compute:1', PALUGADA_COMPUTE_DOCKER: '/opt/docker', PALUGADA_RUNTIME_DOCKER: '/usr/bin/podman' }, '/srv/files').options?.docker, '/opt/docker');
});

async function division(fixture: Fixture, slug: string): Promise<string> {
  return withTenant(fixture.companyId, async (tx) => (await tx.query<{ id: string }>(
    'INSERT INTO divisions (company_id, slug, name) VALUES ($1, $2, $2) RETURNING id', [fixture.companyId, slug])).rows[0]!.id);
}
async function grant(fixture: Fixture, divisionId: string, capability: string): Promise<void> {
  await withTenant(fixture.companyId, (tx) => tx.query(
    'INSERT INTO capability_grants (company_id, division_id, capability_name) VALUES ($1, $2, $3)', [fixture.companyId, divisionId, capability]));
}
async function credential(fixture: Fixture, divisionId: string): Promise<void> {
  await withTenant(fixture.companyId, (tx) => tx.query(
    "INSERT INTO credentials (company_id, division_id, alias, secret_ref) VALUES ($1, $2, 'api', 'vault://acme/api-token')", [fixture.companyId, divisionId]));
}

test('code that reaches no network may share a division with a credential and a tier 2 grant; the sandbox\'s code still may not (F8.10)', async () => {
  const fixture = await createCompany('compute-boundary');
  await registerStandardCatalogue();

  // Finance as the template makes it: a key for invoicing, invoices sent, and figures worked out.
  const finance = await division(fixture, 'keuangan');
  await credential(fixture, finance);
  await grant(fixture, finance, 'invoice.issue');
  await grant(fixture, finance, 'code.compute');
  const other = await division(fixture, 'keuangan-2');
  await grant(fixture, other, 'code.compute');
  await credential(fixture, other);
  await grant(fixture, other, 'email.send');

  // Unchanged for code that can reach the network, in both orders.
  const lab = await division(fixture, 'lab');
  await grant(fixture, lab, 'code.execute');
  await assert.rejects(() => credential(fixture, lab), /executes untrusted code.*credential cannot be scoped to it/s);
  await assert.rejects(() => grant(fixture, lab, 'email.send'), /executes untrusted code.*cannot also be granted email\.send/s);
  await assert.rejects(() => grant(fixture, finance, 'code.execute'), /holds a credential.*executes untrusted code/s);

  // Isolated is a claim about code, and only code that runs at call time makes it.
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  await assert.rejects(withControlPlane((tx) => tx.query("UPDATE capabilities SET executes_untrusted_code = false WHERE name = 'code.compute'")),
    /capabilities_isolation_is_of_code/);
});

test('the standard template gives Finance code.compute, and its bookkeeper the two tools Finance holds for figures and receipts', () => {
  const all = STANDARD_COMPANY_TEMPLATE.grants ?? [];
  assert.deepEqual(all.filter((one) => one.capability === 'code.compute').map((one) => one.division), ['finance']);
  const tools = STANDARD_COMPANY_TEMPLATE.roles.find((role) => role.slug === 'bookkeeper')!.tools ?? [];
  assert.ok(tools.includes('code.compute'));
  assert.ok(tools.includes('image.describe'));
  assert.ok(tools.length <= 12);
  // Never in the lab, whose code reaches the network: what this one reads, that one could post.
  assert.ok(!all.some((one) => one.division === 'lab' && one.capability === 'code.compute'));
});
