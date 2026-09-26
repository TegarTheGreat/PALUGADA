#!/usr/bin/env node
/**
 * A stand-in for a headless agent CLI.
 *
 * `CliAdapter` exists so that employing `hermes`, `openclaw`, `codex` or
 * `gemini-cli` is a configuration entry rather than a new adapter. None of
 * those is installed here, so this plays their part: it takes a prompt on
 * stdin, finds the MCP server it was pointed at exactly the way one of them
 * would, calls a tool over it, and writes back in whichever of the two output
 * dialects it was told to speak.
 *
 * It deliberately reads its MCP configuration from argv rather than being
 * handed a URL, because "did the adapter actually place the tool bridge on the
 * command line" is the thing an argv assertion cannot prove and this can.
 *
 * Behaviour is driven by flags so one binary covers every case a test needs:
 *
 *   --dialect stream-json|text   how to answer (default stream-json)
 *   --mcp-config <json>          inline configuration
 *   --mcp-config-file <path>     the same, as a file
 *   --call <capability>          call this capability before answering
 *   --exit <code>                exit with this code instead of answering
 *   --dump-env                   answer with the environment it was given
 *   --prompt <text>              take the prompt here instead of on stdin
 *   --spawn-orphan <pidfile>     start a child that outlives this process, and
 *                                write its pid -- a CLI that leaves a dev
 *                                server or a watcher running behind it
 *   --hang <pidfile>             write this pid, ignore SIGTERM, never answer
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

const dialect = flag('--dialect') ?? 'stream-json';
const exitWith = flag('--exit');
const toCall = flag('--call');
const model = flag('--model') ?? 'unknown';

// stdin is drained whether or not the prompt came from there: a CLI that left
// it unread would make the adapter's write succeed for the wrong reason.
const fromStdin = await readAll(process.stdin);
const prompt = flag('--prompt') ?? fromStdin;

const hang = flag('--hang');
if (hang !== null) {
  writeFileSync(hang, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const orphan = flag('--spawn-orphan');
if (orphan !== null) {
  // Not detached: it stays in this process's group, which is exactly what an
  // agent CLI's own children do.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  writeFileSync(orphan, String(child.pid));
}

if (exitWith !== null) {
  process.stderr.write('the fake CLI was told to fail\n');
  process.exit(Number(exitWith));
}

const config = readMcpConfig();
const answer = { sawCharter: prompt.split('\n')[0] ?? '', promptLength: prompt.length, model };

if (argv.includes('--dump-env')) {
  answer.env = Object.keys(process.env).sort();
}

if (toCall !== null) {
  answer.tool = await callTool(config, toCall, { zone: 'example.com' });
}

if (dialect === 'text') {
  process.stdout.write(`${JSON.stringify(answer)}\n`);
} else {
  say({
    type: 'assistant',
    message: {
      model,
      usage: { input_tokens: 120, output_tokens: 34 },
      content: [{ type: 'text', text: 'working' }],
    },
  });
  say({ type: 'result', subtype: 'success', is_error: false, result: answer });
}

function say(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function readMcpConfig() {
  const file = flag('--mcp-config-file');
  const inline = flag('--mcp-config');
  const raw = file ? readFileSync(file, 'utf8') : inline;
  if (!raw) throw new Error('the adapter gave this runtime no MCP server');
  const parsed = JSON.parse(raw);
  return parsed.mcpServers.palugada;
}

async function callTool(server, name, args) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...server.headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  return {
    isError: body.result?.isError ?? true,
    text: body.result?.content?.[0]?.text ?? null,
  };
}

async function readAll(stream) {
  let out = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) out += chunk;
  return out;
}
