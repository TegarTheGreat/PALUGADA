#!/usr/bin/env node
/**
 * A `script` runtime, in about thirty lines.
 *
 * It exists to show that the bar for writing one is low: read a request, say
 * what you want, say what you produced. It reads its instructions out of the
 * task input so that one binary can play every part a test needs -- calling a
 * tool, reporting usage, failing, or dying without saying anything.
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let request = null;
const pending = new Map();

for await (const line of rl) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);

  if (request === null) {
    request = message;
    // Not awaited: `act` may block on a tool answer, and the answer arrives on
    // the line after this one. Awaiting here would mean the loop that reads it
    // is waiting for the thing that is waiting for it.
    void act(request);
    continue;
  }

  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
}

async function callTool(name, args) {
  const id = `call-${pending.size + 1}`;
  const answer = new Promise((resolve) => pending.set(id, resolve));
  say({ type: 'tool_call', id, name, args });
  return answer;
}

async function act(req) {
  const script = req.task.input.script ?? 'done';

  if (script === 'unreadable') {
    process.stdout.write('this is not json\n');
    return;
  }
  if (script === 'silent') {
    process.exit(0);
  }
  if (script === 'provider_down') {
    say({ type: 'error', message: 'the provider refused the connection', providerFailure: true });
    return;
  }
  if (script === 'usage') {
    say({
      type: 'usage',
      usage: { model: req.modelRouting.primary, inputTokens: 100, outputTokens: 50, costCents: 7 },
    });
    say({ type: 'done', output: { model: req.modelRouting.primary } });
    return;
  }
  if (script === 'call_tool') {
    say({ type: 'text', text: 'about to read a zone' });
    const answer = await callTool('dns.read', { zone: 'example.com' });
    say({ type: 'done', output: { answer } });
    return;
  }
  if (script === 'call_forbidden') {
    const answer = await callTool('dns.write', { zone: 'example.com' });
    say({ type: 'done', output: { answer } });
    return;
  }
  if (script === 'leak_env') {
    say({
      type: 'done',
      output: {
        sawAdminUrl: Boolean(process.env.PALUGADA_ADMIN_URL),
        sawSentinel: Boolean(process.env.PALUGADA_TEST_SENTINEL),
        keys: Object.keys(process.env).sort(),
      },
    });
    return;
  }
  if (script === 'echo_request') {
    say({ type: 'done', output: { request: req } });
    return;
  }

  say({ type: 'done', output: { ok: true } });
}
