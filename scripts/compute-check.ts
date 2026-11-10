/**
 * Proves, on the daemon this machine uses, that `code.compute` runs a role's
 * Python where it reaches nothing (the tools research, recommendation 6;
 * src/capabilities/compute.ts).
 *
 * The suite checks the container's flags as an argv, against a docker client
 * that plays the container with this machine's Python. This runs them: it
 * builds deploy/compute -- or takes PALUGADA_COMPUTE_IMAGE when it is set --
 * and does real work through `codeCompute`, the same command line every call
 * gets. The code sums a spreadsheet with pandas and draws a chart, and on the
 * way tries what code talked into anything would try: write its image,
 * resolve a name, reach the internet and the host's database, read the
 * orchestrator's environment. Then code that would run for ever, which must
 * be stopped at its time. And no container may be left behind.
 *
 *   npm run compute:check
 *
 * Exits 0 when every property holds, 1 naming each one that does not, and 78
 * when there is no daemon to check against. Run it on the machine that will
 * run the containers: podman, rootless Docker and a remote DOCKER_HOST each
 * decide some of these for themselves.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeCompute } from '../src/capabilities/compute.ts';
import { ContainerAdapter } from '../src/runtime/container.ts';

const CONTEXT = fileURLToPath(new URL('../deploy/compute', import.meta.url));
/** What the orchestrator holds and a role's code must never see. */
const SECRET = 'PALUGADA_COMPUTE_CHECK_SECRET';
const docker = process.env.PALUGADA_COMPUTE_DOCKER || process.env.PALUGADA_RUNTIME_DOCKER || 'docker';
const image = process.env.PALUGADA_COMPUTE_IMAGE || 'palugada/compute:local';

// The same question the runtime's backend asks: is there a daemon, not only a CLI.
const health = await new ContainerAdapter({ image, docker }).health();
if (!health.ok) {
  console.error(`no docker daemon to check against: ${health.detail}`);
  process.exit(78);
}
if (process.env.PALUGADA_COMPUTE_IMAGE) {
  console.log(`${health.detail}; checking ${image}`);
} else {
  console.log(`${health.detail}; building ${image} from ${CONTEXT}`);
  const built = spawnSync(docker, ['build', '--quiet', '--tag', image, CONTEXT], { encoding: 'utf8' });
  if (built.status !== 0) {
    console.error(`the image did not build:\n${built.stderr || built.stdout}`);
    process.exit(1);
  }
}

process.env[SECRET] = 'the orchestrator holds this; a role\'s code must not see it';
const root = await mkdtemp(join(tmpdir(), 'palugada-compute-check-'));
const companyId = randomUUID();
await mkdir(join(root, companyId), { recursive: true });
await writeFile(join(root, companyId, 'penjualan.csv'), 'produk,jumlah\nkopi susu,30000\nteh,12000\nkopi susu,30000\n');
const ctx = () => ({ companyId, taskId: randomUUID(), idempotencyKey: randomUUID(), signal: AbortSignal.timeout(300_000) }) as never;
const compute = codeCompute({ root, image, docker });

const PROBE = `
import json, os, socket

def attempt(action):
    try:
        action()
        return 'allowed'
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)[:120]

def field(name):
    for line in open('/proc/self/status'):
        if line.startswith(name + ':'):
            return line.split()[1]

def first(*paths):
    for path in paths:
        try:
            return open(path).read().strip()
        except OSError:
            pass

report = {
    'uid': os.getuid(), 'gid': os.getgid(),
    'writeImage': attempt(lambda: open('/usr/probe-was-here', 'w')),
    'dns': attempt(lambda: socket.getaddrinfo('example.com', 443)),
    'internet': attempt(lambda: socket.create_connection(('1.1.1.1', 443), timeout=3)),
    'host': attempt(lambda: socket.create_connection(('172.17.0.1', 5432), timeout=3)),
    'interfaces': sorted(os.listdir('/sys/class/net')),
    'capabilities': field('CapBnd'),
    'noNewPrivileges': field('NoNewPrivs'),
    'memoryMax': first('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    'pidsMax': first('/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max'),
    'environment': sorted(os.environ),
}

import pandas
import matplotlib.pyplot as plot
sales = pandas.read_csv('in/penjualan.csv')
per = sales.groupby('produk')['jumlah'].sum()
report['sums'] = {name: int(total) for name, total in per.items()}
per.plot.bar()
plot.savefig('out/grafik.png')
with open('out/ringkasan.json', 'w') as out:
    json.dump(report['sums'], out, sort_keys=True)
print(json.dumps(report))
`;

interface Report {
  uid: number;
  gid: number;
  writeImage: string;
  dns: string;
  internet: string;
  host: string;
  interfaces: string[];
  capabilities: string | null;
  noNewPrivileges: string | null;
  memoryMax: string | null;
  pidsMax: string | null;
  environment: string[];
  sums: Record<string, number>;
}

const work = await compute.execute({ code: PROBE, files: ['penjualan.csv'] }, ctx());
let report: Report | null = null;
try {
  report = JSON.parse(work.stdout) as Report;
} catch {
  console.error(`the code did not report:\n${work.said ?? ''}\n${work.stdout}\n${work.stderr}`);
  process.exit(1);
}
const chart = work.files.find((file) => file.path.endsWith('/grafik.png'));
const chartBytes = chart ? await readFile(join(root, companyId, chart.path)) : null;
const summary = work.files.find((file) => file.path.endsWith('/ringkasan.json'));
const verified = await compute.verify!({ code: PROBE }, work, ctx());

const started = Date.now();
const endless = await compute.execute({ code: 'while True:\n    pass\n', seconds: 2 }, ctx());
const stoppedIn = Date.now() - started;
const left = spawnSync(docker, ['ps', '--all', '--quiet', '--filter', 'name=palugada-compute-'], { encoding: 'utf8' });

const refused = (outcome: string) => outcome !== 'allowed';
const checks: Array<[string, boolean, string]> = [
  ['runs as nobody, not root', report.uid === 65534 && report.gid === 65534, `${report.uid}:${report.gid}`],
  ['cannot write to its image', /Read-only file system/.test(report.writeImage), report.writeImage],
  ['resolves no name', refused(report.dns), report.dns],
  ['reaches no address on the internet', refused(report.internet), report.internet],
  ['reaches nothing on the host, the database included', refused(report.host), report.host],
  ['has no network interface but loopback', report.interfaces.every((name) => name === 'lo'), report.interfaces.join(', ')],
  ['holds no capability, and can gain none', /^0+$/.test(report.capabilities ?? ''), report.capabilities ?? 'unknown'],
  ['cannot gain privileges', report.noNewPrivileges === '1', report.noNewPrivileges ?? 'unknown'],
  ['is held to 1 GiB', report.memoryMax === '1073741824', report.memoryMax ?? 'unknown'],
  ['is held to 128 processes', report.pidsMax === '128', report.pidsMax ?? 'unknown'],
  ['sees none of the orchestrator\'s environment', !report.environment.includes(SECRET) && !report.environment.includes('DATABASE_URL'),
    report.environment.join(', ')],
  ['sums a spreadsheet with pandas', report.sums['kopi susu'] === 60000 && report.sums.teh === 12000, JSON.stringify(report.sums)],
  ['draws a chart that is kept in the company\'s files', chartBytes !== null && chartBytes.subarray(1, 4).toString('latin1') === 'PNG',
    chart?.path ?? 'none'],
  ['keeps what it wrote, read back by its digest', work.ok && summary !== undefined && verified
    && createHash('sha256').update(await readFile(join(root, companyId, summary.path))).digest('hex') === summary.sha256,
  work.files.map((file) => file.path).join(', ')],
  ['is stopped at its time', endless.timedOut && !endless.ok && stoppedIn < 30_000, `${endless.said ?? 'not stopped'} after ${stoppedIn} ms`],
  ['leaves no container behind', left.stdout.trim() === '', left.stdout.trim() || 'none'],
];

let failed = 0;
for (const [property, holds, seen] of checks) {
  if (!holds) failed += 1;
  console.log(`${holds ? 'ok  ' : 'FAIL'} ${property} (${seen})`);
}
console.log(failed === 0 ? 'every property holds' : `${failed} propert${failed === 1 ? 'y does' : 'ies do'} not hold`);
process.exit(failed === 0 ? 0 : 1);
