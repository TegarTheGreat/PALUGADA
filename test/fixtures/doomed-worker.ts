/**
 * A worker that is going to be killed with SIGKILL
 * (test/acceptance/orphan-processes.test.ts).
 *
 * A process of its own, because the thing under test is what a worker that
 * dies outright leaves behind, and the test process cannot die and then look.
 * It says it is alive the way `Worker.start` does, then runs one task the way
 * a worker runs one: through an `Engine`, on an agent CLI spawned by the CLI
 * adapter. The CLI is the stand-in, told to start a child of its own and then
 * never answer, so the run is still going when the test kills this process.
 *
 * Arguments: company id, task id, the stand-in CLI's path, and the files the
 * stand-in writes its child's pid and its own pid to.
 */
import { Engine } from '../../src/engine/engine.ts';
import { beat } from '../../src/engine/checkout.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { CliAdapter, runtimeSpecsFrom } from '../../src/runtime/cli.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';

const DOOMED_WORKER = 'worker-doomed';

const [companyId, taskId, cli, childFile, leaderFile] = process.argv.slice(2);
if (!companyId || !taskId || !cli || !childFile || !leaderFile) {
  throw new Error('usage: doomed-worker.ts <company> <task> <cli> <child pid file> <leader pid file>');
}

const [spec] = runtimeSpecsFrom([{
  name: 'codex',
  command: process.execPath,
  args: [cli, '--mcp-config', '{mcpConfig}', '--spawn-orphan', childFile, '--hang', leaderFile],
}]);
const adapters = new AdapterRegistry();
adapters.register(new CliAdapter(spec!));
const engine = new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), adapters, workerId: DOOMED_WORKER });

await beat(DOOMED_WORKER);
await engine.runTask(companyId, taskId, 'worker');
