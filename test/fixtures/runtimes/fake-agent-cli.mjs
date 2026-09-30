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
 *                                hermes-stream-json, openclaw-json, opencode-json,
 *                                codex-jsonl, gemini-stream-json
 *   --mcp-config <json>          inline configuration
 *   --mcp-config-file <path>     the same, as a file
 *   --mcp-config-from <path>     a CLI's own configuration file (YAML, JSON or TOML),
 *                                naming the bridge's URL and the environment
 *                                variable that holds its token
 *   --mcp-config-env <var>       the same, from an environment variable
 *   --call <capability>          call this capability before answering
 *   --exit <code>                exit with this code instead of answering
 *   --dump-env                   answer with the environment it was given
 *   --dump-argv                  answer with the arguments it was given
 *   sessions export - --session-id <id> --session-row <json>
 *                                Hermes's ledger: print session s1's row
 *   --env-sha <var>              answer with the SHA-256 of that variable's
 *                                value: proves which credential arrived
 *                                without writing it into the task's output
 *   --prompt <text>              take the prompt here instead of on stdin
 *   --spawn-orphan <pidfile>     start a child that outlives this process, and
 *                                write its pid -- a CLI that leaves a dev
 *                                server or a watcher running behind it; with
 *                                --hang, a CLI still working beside one
 *   --hang <pidfile>             write this pid, ignore SIGTERM, never answer
 *   --flood <pidfile>            write this pid, then write for ever without
 *                                a line break
 *   --total-cost <usd>           put the provider's total on the result line,
 *                                as Claude Code's total_cost_usd
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

// Hermes's own ledger, as `hermes sessions export - --session-id <id>` prints
// it: one line per session, its cost among the columns. Only for the session
// the run's result line named, so a test sees that id travel.
if (argv[0] === 'sessions' && argv[1] === 'export') {
  const id = flag('--session-id');
  const row = JSON.parse(flag('--session-row') ?? '{}');
  if (id === 's1') process.stdout.write(`${JSON.stringify({ id, source: 'tool', ...row, messages: [{ role: 'user', content: 'x' }] })}\n`);
  process.exit(0);
}

const dialect = flag('--dialect') ?? 'stream-json';
const exitWith = flag('--exit');
const toCall = flag('--call');
const model = flag('--model') ?? 'unknown';

// stdin is drained whether or not the prompt came from there: a CLI that left
// it unread would make the adapter's write succeed for the wrong reason.
const fromStdin = await readAll(process.stdin);
const prompt = flag('--prompt') ?? fromStdin;

const orphan = flag('--spawn-orphan');
if (orphan !== null) {
  // Not detached: it stays in this process's group, which is exactly what an
  // agent CLI's own children do. Before `--hang`, so a CLI that never
  // answers can have one too: an agent working, with a server it started.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  writeFileSync(orphan, String(child.pid));
}

const hang = flag('--hang');
if (hang !== null) {
  writeFileSync(hang, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const flood = flag('--flood');
if (flood !== null) {
  writeFileSync(flood, String(process.pid));
  const block = 'x'.repeat(65_536);
  for (;;) {
    if (!process.stdout.write(block)) await new Promise((resolve) => process.stdout.once('drain', resolve));
  }
}

if (exitWith !== null) {
  process.stderr.write('the fake CLI was told to fail\n');
  process.exit(Number(exitWith));
}

const config = readMcpConfig();
const answer = { sawCharter: prompt.split('\n')[0] ?? '', promptLength: prompt.length, model };
// Like an agent that read its contract: it says how it met each done criterion.
const done = reportOn(prompt);
if (done) answer.done = done;

if (argv.includes('--dump-argv')) answer.argv = argv;
if (argv.includes('--dump-env')) {
  answer.env = Object.keys(process.env).sort();
  answer.home = process.env.HOME ?? null;
}
const shaOf = flag('--env-sha');
if (shaOf !== null) {
  const value = process.env[shaOf];
  answer.envSha = value === undefined ? null : createHash('sha256').update(value).digest('hex');
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
} else if (dialect === 'codex-jsonl') {
  // As Codex 0.157.1 printed it: a warning item first, which is not a failure.
  say({ type: 'thread.started', thread_id: 't1' });
  say({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: `Model metadata for \`${model}\` not found.` } });
  say({ type: 'turn.started' });
  say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'working' } });
  say({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: JSON.stringify(answer) } });
  say({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 34, reasoning_output_tokens: 4 } });
} else if (dialect === 'gemini-stream-json') {
  // As Gemini CLI 0.61.0 printed it: what it said before a tool is not the answer.
  say({ type: 'init', session_id: 's1', model });
  say({ type: 'message', role: 'user', content: prompt.slice(0, 20) });
  say({ type: 'message', role: 'assistant', content: 'let me look', delta: true });
  say({ type: 'tool_use', tool_name: 'mcp_palugada_dns__read', tool_id: 't1', parameters: {} });
  say({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'ok' });
  const text = JSON.stringify(answer);
  say({ type: 'message', role: 'assistant', content: text.slice(0, 10), delta: true });
  say({ type: 'message', role: 'assistant', content: text.slice(10), delta: true });
  say({ type: 'result', status: 'success', stats: { total_tokens: 154, input_tokens: 120, output_tokens: 34, models: { [model]: {} } } });
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

/** One entry for each criterion the contract lists under "The criteria:", as met. */
function reportOn(text) {
  const at = text.indexOf('The criteria:\n');
  if (at === -1) return null;
  const criteria = [];
  for (const line of text.slice(at + 'The criteria:\n'.length).split('\n')) {
    if (!line.startsWith('- ')) break;
    criteria.push(line.slice(2).trim());
  }
  return criteria.map((criterion) => ({ criterion, met: true, evidence: 'the fake agent did what it was asked' }));
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
    const url = text.match(/"?url"?\s*[:=]\s*"(https?:\/\/[^"]+)"/)?.[1];
    // Codex's TOML names the variable outright; the others substitute it.
    const variable = text.match(/\$\{(?:env:)?([A-Z_]+)\}|\{env:([A-Z_]+)\}|bearer_token_env_var\s*=\s*"([A-Z_]+)"/);
    if (!url || !variable) throw new Error('the configuration names no bridge');
    const token = process.env[variable[1] ?? variable[2] ?? variable[3]];
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
