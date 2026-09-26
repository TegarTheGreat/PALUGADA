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
 *   --dialect <name>             how to answer: stream-json (default), text,
 *                                hermes-stream-json, openclaw-json, opencode-json
 *   --mcp-config <json>          inline configuration
 *   --mcp-config-file <path>     the same, as a file
 *   --mcp-config-from <path>     a CLI's own configuration file (YAML or JSON),
 *                                naming the bridge's URL and the environment
 *                                variable that holds its token
 *   --mcp-config-env <var>       the same, from an environment variable
 *   --call <capability>          call this capability before answering
 *   --exit <code>                exit with this code instead of answering
 *   --dump-env                   answer with the environment it was given
 *   --prompt <text>              take the prompt here instead of on stdin
 *   --spawn-orphan <pidfile>     start a child that outlives this process, and
 *                                write its pid -- a CLI that leaves a dev
 *                                server or a watcher running behind it
 *   --hang <pidfile>             write this pid, ignore SIGTERM, never answer
 *   --total-cost <usd>           put the provider's total on the result line,
 *                                as Claude Code's total_cost_usd
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
  answer.home = process.env.HOME ?? null;
}

if (toCall !== null) {
  // Like a real CLI: told which tools it may use, it uses no other. The list
  // names the tools as the bridge shows them, `mcp__palugada__` first.
  const allowed = flag('--allowed');
  answer.tool = allowed !== null && !allowed.split(',').includes(`mcp__palugada__${toCall}`)
    ? { isError: true, text: `this CLI was not allowed ${toCall}; it was allowed ${allowed}` }
    : await callTool(config, toCall, { zone: 'example.com' });
}

if (dialect === 'text') {
  process.stdout.write(`${JSON.stringify(answer)}\n`);
} else if (dialect === 'hermes-stream-json') {
  // Hermes's own: no subtype on the result, the answer in `text`, tokens in
  // `tokens`, no cost.
  say({ type: 'system', subtype: 'init', model, session_id: 's1', timestamp: 1 });
  say({ type: 'text', text: 'working', timestamp: 2 });
  say({ type: 'result', session_id: 's1', exit_code: 0, text: JSON.stringify(answer),
    tokens: { input: 120, output: 34, total: 154 }, duration_ms: 5, timestamp: 3 });
} else if (dialect === 'openclaw-json') {
  process.stderr.write('diagnostics go to stderr\n');
  say({ ok: true, status: 'ok', final: JSON.stringify(answer), payloads: [],
    usage: { input: 120, output: 34, total: 154 }, costUsd: 0.0123, model, provider: 'p', sessionId: 's1' });
} else if (dialect === 'opencode-json') {
  say({ type: 'step_start', timestamp: 1, sessionID: 's1', part: {} });
  say({ type: 'text', timestamp: 2, sessionID: 's1', part: { text: JSON.stringify(answer) } });
  say({ type: 'step_finish', timestamp: 3, sessionID: 's1', part: {
    reason: 'stop', cost: 0.0042, tokens: { input: 100, output: 30, reasoning: 4, cache: { read: 20, write: 0 } } } });
} else {
  say({
    type: 'assistant',
    message: {
      model,
      usage: { input_tokens: 120, output_tokens: 34 },
      content: [{ type: 'text', text: 'working' }],
    },
  });
  const total = flag('--total-cost');
  say({
    type: 'result', subtype: 'success', is_error: false, result: answer,
    ...(total === null ? {} : { total_cost_usd: Number(total), model }),
  });
}

function say(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function readMcpConfig() {
  // A CLI's own format: find the URL in it, and the token where the file
  // says the token is -- an environment variable, never the file itself.
  const own = flag('--mcp-config-from');
  const ownEnv = flag('--mcp-config-env');
  if (own || ownEnv) {
    const text = own ? readFileSync(own, 'utf8') : (process.env[ownEnv] ?? '');
    // The server's `url` key, not the first address in the file: OpenCode's
    // configuration opens with the URL of its own schema.
    const url = text.match(/"?url"?\s*:\s*"(https?:\/\/[^"]+)"/)?.[1];
    const variable = text.match(/\$\{(?:env:)?([A-Z_]+)\}|\{env:([A-Z_]+)\}/);
    if (!url || !variable) throw new Error('the configuration names no bridge');
    const token = process.env[variable[1] ?? variable[2]];
    if (!token) throw new Error('the token the configuration names is not in the environment');
    return { url, headers: { Authorization: `Bearer ${token}` } };
  }
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
