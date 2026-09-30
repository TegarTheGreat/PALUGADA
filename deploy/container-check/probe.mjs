#!/usr/bin/env node
/**
 * A `script` runtime that tries what a compromised one would try, from inside
 * the container the `docker` backend starts, and reports what happened
 * (scripts/container-check.ts reads the report).
 *
 * It writes to its own image and to its scratch space, resolves a name,
 * connects to an address on the internet and to the host's database port,
 * reads its capabilities, its no-new-privileges flag and its memory limit,
 * lists its environment and its network interfaces, and then asks the engine
 * for a tool over stdio -- the one way out it is meant to have.
 */
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** 'allowed', or the error code that refused it. */
async function attempt(action) {
  try {
    await action();
    return 'allowed';
  } catch (error) {
    return error.code ?? error.message;
  }
}

function reach(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 3_000 });
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('timeout', () => { socket.destroy(); reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); });
    socket.on('error', reject);
  });
}

function status(field) {
  const found = readFileSync('/proc/self/status', 'utf8').match(new RegExp(`^${field}:\\s*(.*)$`, 'm'));
  return found ? found[1].trim() : null;
}

function memoryMax() {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      // The other cgroup version's file.
    }
  }
  return null;
}

let request = null;
let answer = null;
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (request === null) {
    request = message;
    void probe();
    continue;
  }
  answer?.(message);
}

async function probe() {
  const report = {
    uid: process.getuid(),
    gid: process.getgid(),
    writeImage: await attempt(() => writeFileSync('/probe-was-here', 'x')),
    writeScratch: await attempt(() => writeFileSync('/tmp/probe-was-here', 'x')),
    dns: await attempt(() => lookup('example.com')),
    internet: await attempt(() => reach('1.1.1.1', 443)),
    host: await attempt(() => reach(String(request.task.input.host ?? '172.17.0.1'), 5432)),
    capabilities: status('CapEff'),
    noNewPrivileges: status('NoNewPrivs'),
    memoryMax: memoryMax(),
    environment: Object.keys(process.env).sort(),
    interfaces: Object.keys(networkInterfaces()).sort(),
  };
  const replied = new Promise((resolve) => { answer = resolve; });
  say({ type: 'tool_call', id: 'probe-1', name: 'probe.echo', args: { from: 'inside' } });
  const reply = await replied;
  report.tool = reply.type === 'tool_result' ? reply.output : reply;
  say({ type: 'done', output: { report } });
  process.exit(0);
}
