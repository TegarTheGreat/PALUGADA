#!/usr/bin/env node
/**
 * A stand-in for an agent that speaks the Agent Client Protocol, version 1,
 * written to its schema (`schema/v1/schema.json`): JSON-RPC 2.0, one message
 * a line on stdin and stdout. No real ACP agent runs here -- each needs a
 * provider's key -- so this plays one: it answers `initialize` and
 * `session/new`, and on `session/prompt` says something, asks permission for
 * its own tool and for one of the bridge's, asks for a file it was not
 * offered, calls a tool over the MCP server `session/new` named, says what
 * the session cost, and answers with its output.
 *
 *   --report <path>        write what it was told and answered, as JSON
 *   --call <tool>          call this tool on the MCP server over HTTP
 *   --ask-permission       ask about its own shell and about the bridge's tool
 *   --cost <usd>           send a usage_update with this cumulative cost
 *   --no-http              say it cannot reach an MCP server over HTTP
 *   --version-reply <n>    answer initialize with this protocol version
 *   --auth-required        refuse session/new as the protocol's auth_required
 *   --hang-prompt          wait on the prompt until it is cancelled
 *   --stop <reason>        end the turn with this stop reason
 *   --fail-prompt          answer the prompt with an internal error, after its cost
 *   --auth-on-prompt       answer the prompt as the protocol's auth_required
 *   --junk                 send lines that are not messages, and a permission
 *                          request that names only its tool call, with an odd option
 *   --string-ids           answer requests with their id as a string
 *   --slow-session <ms>    take this long to open the session
 *   --huge-line            write a line longer than any message may be, then wait
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const has = (name) => argv.includes(name);

const report = {
  initialize: null, newSession: null, permissions: [], fsError: null, cancelled: false, prompted: false, junkPermission: null,
};
// A reader that stops reading is not this agent's concern; it goes on as a careless one would.
process.stdout.on('error', () => undefined);
const save = () => {
  const path = flag('--report');
  if (path) writeFileSync(path, JSON.stringify(report));
};

const send = (message) => process.stdout.write(`${JSON.stringify({
  jsonrpc: '2.0', ...message, ...(has('--string-ids') && message.method === undefined ? { id: String(message.id) } : {}),
})}\n`);
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ id, method, params });
});

const sessionId = 'session-1';
let server = null;
let cancelled = null;

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }
  switch (message.method) {
    case 'initialize':
      report.initialize = message.params;
      save();
      send({
        id: message.id,
        result: {
          protocolVersion: Number(flag('--version-reply') ?? message.params.protocolVersion),
          agentCapabilities: { loadSession: false, mcpCapabilities: { http: !has('--no-http'), sse: false } },
          authMethods: [],
        },
      });
      return;
    case 'session/new':
      if (flag('--slow-session')) {
        setTimeout(() => {
          report.newSession = message.params;
          save();
          send({ id: message.id, result: { sessionId } });
        }, Number(flag('--slow-session')));
        return;
      }
      if (has('--auth-required')) {
        send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      report.newSession = message.params;
      save();
      server = message.params.mcpServers[0] ?? null;
      send({ id: message.id, result: { sessionId } });
      return;
    case 'session/prompt':
      void prompt(message);
      return;
    case 'session/cancel':
      report.cancelled = true;
      save();
      cancelled?.();
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

async function prompt(message) {
  report.prompted = true;
  save();
  const text = message.params.prompt.map((block) => block.text ?? '').join('');
  const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
  if (has('--auth-on-prompt')) {
    send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
    return;
  }
  if (has('--huge-line')) {
    // More than a reader holds, and no end to the line.
    process.stdout.write('x'.repeat(17 * 1024 * 1024));
    await new Promise(() => undefined);
  }
  if (has('--junk')) {
    process.stdout.write('null\n[1, 2]\n"a string"\n');
    update({ sessionUpdate: 'tool_call', toolCallId: 'mcp-9', title: `mcp__palugada__${flag('--call')}`, kind: 'other', status: 'pending' });
    const bare = await ask('session/request_permission', {
      sessionId, toolCall: { toolCallId: 'mcp-9' }, options: [null, { optionId: 'ok', name: 'Allow always', kind: 'allow_always' }],
    });
    report.junkPermission = bare.result ?? bare.error;
    save();
  }
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Reading ' } });
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'the zone.' } });

  if (has('--hang-prompt')) {
    await new Promise((resolve) => { cancelled = resolve; });
    send({ id: message.id, result: { stopReason: 'cancelled' } });
    return;
  }

  const call = flag('--call');
  if (has('--ask-permission')) {
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    const own = await ask('session/request_permission', {
      sessionId, toolCall: { toolCallId: 'own-1', title: 'rm -rf ~/', kind: 'execute', status: 'pending' }, options,
    });
    // Its own shell again, named to look like the bridge's tool.
    const disguised = await ask('session/request_permission', {
      sessionId, toolCall: { toolCallId: 'own-2', title: `rm -rf ~ #mcp__palugada__${call}`, kind: 'execute', status: 'pending' }, options,
    });
    const bridge = await ask('session/request_permission', {
      sessionId, toolCall: { toolCallId: 'mcp-1', title: `mcp__palugada__${call}`, kind: 'other', status: 'pending' }, options,
    });
    report.permissions = [own.result, disguised.result, bridge.result];
    save();
  }

  const file = await ask('fs/read_text_file', { sessionId, path: '/etc/passwd' });
  report.fsError = file.error ?? null;
  save();

  let tool = null;
  if (call && server) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'mcp-1', title: call, kind: 'other', status: 'in_progress' });
    const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: call, arguments: { zone: 'example.com' } } }),
    });
    const body = await response.json();
    tool = { isError: body.result?.isError ?? true, text: body.result?.content?.[0]?.text ?? null };
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', status: 'completed' });
  }

  const cost = flag('--cost');
  if (cost) update({ sessionUpdate: 'usage_update', used: 1_200, size: 200_000, cost: { amount: Number(cost), currency: 'USD' } });
  if (has('--fail-prompt')) {
    send({ id: message.id, error: { code: -32603, message: 'Internal error: the provider went away' } });
    return;
  }

  const done = reportOn(text);
  const answer = JSON.stringify({ tool, ...(done ? { done } : {}) });
  // In two chunks, so the adapter has to put a message back together.
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: answer.slice(0, 10) } });
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: answer.slice(10) } });
  send({ id: message.id, result: { stopReason: flag('--stop') ?? 'end_turn' } });
}

function reportOn(text) {
  const at = text.indexOf('The criteria:\n');
  if (at === -1) return null;
  const criteria = [];
  for (const line of text.slice(at + 'The criteria:\n'.length).split('\n')) {
    if (!line.startsWith('- ')) break;
    criteria.push(line.slice(2).trim());
  }
  return criteria.map((criterion) => ({ criterion, met: true, evidence: 'the fake ACP agent did what it was asked' }));
}
