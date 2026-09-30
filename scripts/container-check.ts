/**
 * Proves, on the daemon this machine uses, that a role run in the `docker`
 * backend is contained (PRD v2 F12.9, src/runtime/container.ts).
 *
 * The suite checks the container's flags as an argv, because whether a daemon
 * is there is a fact about a machine. This runs them. It builds a small image
 * (deploy/container-check) whose runtime tries what a compromised one would
 * try, runs one run through `ContainerAdapter` -- the same command line every
 * run on the backend gets -- and checks the runtime's own report of what it
 * could and could not do, and that the container is gone afterwards.
 *
 *   npm run container:check
 *
 * Exits 0 when every property holds, 1 naming each one that does not, and 78
 * when there is no daemon to check against. Run it on the machine that will
 * run the containers: podman, rootless Docker and a remote DOCKER_HOST each
 * decide some of these for themselves.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ContainerAdapter } from '../src/runtime/container.ts';
import type { RunRequest, RunServices } from '../src/runtime/protocol.ts';

const IMAGE = 'palugada/container-check:local';
const CONTEXT = fileURLToPath(new URL('../deploy/container-check', import.meta.url));
/** What the orchestrator holds and a runtime must never see. */
const SECRET = 'PALUGADA_CONTAINER_CHECK_SECRET';

interface Report {
  uid: number;
  gid: number;
  writeImage: string;
  writeScratch: string;
  dns: string;
  internet: string;
  host: string;
  capabilities: string | null;
  noNewPrivileges: string | null;
  memoryMax: string | null;
  environment: string[];
  interfaces: string[];
  tool: { from?: string } | null;
}

const adapter = new ContainerAdapter({ image: IMAGE });
const health = await adapter.health();
if (!health.ok) {
  console.error(`no docker daemon to check against: ${health.detail}`);
  process.exit(78);
}
console.log(`${health.detail}; building ${IMAGE} from ${CONTEXT}`);
const built = spawnSync(adapter.docker, ['build', '--quiet', '--tag', IMAGE, CONTEXT], { encoding: 'utf8' });
if (built.status !== 0) {
  console.error(`the image did not build:\n${built.stderr || built.stdout}`);
  process.exit(1);
}

process.env[SECRET] = 'the orchestrator holds this; a runtime must not see it';
const runId = randomUUID();
const calls: Array<{ name: string; input: unknown }> = [];
const services: RunServices = {
  async callTool<I, O>(name: string, input: I): Promise<O> {
    calls.push({ name, input });
    return { from: 'outside', echoed: input } as O;
  },
  async step(_name, _kind, _input, fn) {
    return fn(`${runId}:step`);
  },
  async awaitChild() {
    throw new Error('the probe asks for no sub-task');
  },
  async reportUsage() {},
  signal: new AbortController().signal,
};
// The fields the wire carries (toWireRequest); nothing here reaches a database.
const request = {
  runId,
  roleSlug: 'probe',
  task: { id: randomUUID(), input: {}, hopDepth: 0, hopMax: 3, deadlineAt: null, attempt: 0, attemptMax: 1 },
  contextPack: { charter: '', skills: [], memories: [], goalAncestry: [], notes: [], workingMemory: [] },
  allowedTools: [{ name: 'probe.echo', inputSchema: { type: 'object' }, tier: 0 }],
  modelRouting: { primary: 'none', fallback: [] },
  backend: 'docker',
  limits: { tokens: 1_000, wallClockMs: 120_000 },
} as unknown as RunRequest;

const result = await adapter.run(request, services);
const report = (result.output as { report?: Report }).report;
if (!report) {
  console.error(`the runtime did not report: ${JSON.stringify(result.output)}`);
  process.exit(1);
}
const left = spawnSync(adapter.docker, ['ps', '--all', '--quiet', '--filter', `name=palugada-run-${runId}`], { encoding: 'utf8' });

const refused = (outcome: string) => outcome !== 'allowed';
const checks: Array<[string, boolean, string]> = [
  ['runs as nobody, not root', report.uid === 65534 && report.gid === 65534, `${report.uid}:${report.gid}`],
  ['cannot write to its image', report.writeImage === 'EROFS', report.writeImage],
  ['can write its own scratch space', report.writeScratch === 'allowed', report.writeScratch],
  ['resolves no name', refused(report.dns), report.dns],
  ['reaches no address on the internet', refused(report.internet), report.internet],
  ['reaches nothing on the host, the database included', refused(report.host), report.host],
  ['has no network interface but loopback', report.interfaces.every((name) => name === 'lo'), report.interfaces.join(', ')],
  ['holds no capability', /^0+$/.test(report.capabilities ?? ''), report.capabilities ?? 'unknown'],
  ['cannot gain privileges', report.noNewPrivileges === '1', report.noNewPrivileges ?? 'unknown'],
  ['is held to 512 MiB', report.memoryMax === '536870912', report.memoryMax ?? 'unknown'],
  ['sees none of the orchestrator\'s environment', !report.environment.includes(SECRET) && !report.environment.includes('DATABASE_URL'),
    report.environment.join(', ')],
  ['reaches its tools through the engine, over stdio', calls.length === 1 && calls[0]!.name === 'probe.echo' && report.tool?.from === 'outside',
    `${calls.length} call(s)`],
  ['leaves no container behind', left.stdout.trim() === '', left.stdout.trim() || 'none'],
];

let failed = 0;
for (const [property, holds, seen] of checks) {
  if (!holds) failed += 1;
  console.log(`${holds ? 'ok  ' : 'FAIL'} ${property} (${seen})`);
}
console.log(failed === 0 ? 'every property holds' : `${failed} propert${failed === 1 ? 'y does' : 'ies do'} not hold`);
process.exit(failed === 0 ? 0 : 1);
