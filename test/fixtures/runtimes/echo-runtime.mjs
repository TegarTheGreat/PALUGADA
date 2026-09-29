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
// Like an agent that read its contract: a finished run says how it met each
// done criterion it was given, under "The criteria:" in its contract.
const say = (event) => process.stdout.write(`${JSON.stringify(event.type === 'done' && request ? { ...event, output: { ...event.output, ...reportOn(request) } } : event)}\n`);

function reportOn(req) {
  const contract = (req.contextPack?.notes ?? []).find((note) => note.title === 'What you return')?.body ?? '';
  const at = contract.indexOf('The criteria:\n');
  if (at === -1) return {};
  const criteria = [];
  for (const line of contract.slice(at + 'The criteria:\n'.length).split('\n')) {
    if (!line.startsWith('- ')) break;
    criteria.push(line.slice(2).trim());
  }
  return { done: criteria.map((criterion) => ({ criterion, met: true, evidence: 'the echo runtime did what it was asked' })) };
}

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
  if (script === 'narrate') {
    // Says each line it was given, as an agent CLI narrates, then finishes.
    // A line given as parts is joined here, so the runtime can say something
    // the request it was sent never contained whole -- the way a model can
    // assemble a secret it was never shown in one piece.
    for (const line of req.task.input.lines ?? []) {
      say({ type: 'text', text: Array.isArray(line) ? line.join('') : line });
    }
    say({ type: 'done', output: { said: (req.task.input.lines ?? []).length } });
    return;
  }
  if (script === 'delegate') {
    // Hands a piece of the work to another role and waits for it: the way a
    // runtime in another process splits a job (task.delegate, task.await).
    const started = await callTool('task.delegate', { role: req.task.input.to, brief: 'Check the zone for stale records.' });
    if (started.type !== 'tool_result') {
      say({ type: 'done', output: { refused: started } });
      return;
    }
    const answer = await callTool('task.await', { childId: started.output.childId });
    say({ type: 'done', output: { child: started.output.childId, answer } });
    return;
  }
  if (script === 'ask_owner') {
    // Asks, and reports whatever came back: the answer on a resumed run, the
    // refusal on a first one (which the engine withdraws anyway).
    const answer = await callTool('owner.ask', { question: 'Which supplier did you mean?', why: 'Two match the brief.' });
    say({ type: 'done', output: { answer } });
    return;
  }
  if (script === 'plan_then_write') {
    // A tier 2 write the way a well-behaved runtime makes one: plan first,
    // then the call, then whatever it says when the call is refused.
    await callTool('plan.record', {
      steps: [{ capability: 'dns.write', intent: 'point the apex at the new host', expectedEffect: 'the zone has the new record' }],
    });
    const answer = await callTool('dns.write', { zone: 'example.com' });
    // A write that was refused is named, as the contract asks of every run
    // that reports done over a write that failed.
    say({ type: 'done', output: { answer, failed: [{ capability: 'dns.write', why: 'It was refused, and the work did not need it.' }] } });
    return;
  }
  if (script === 'call_forbidden') {
    const answer = await callTool('dns.write', { zone: 'example.com' });
    // A write that was refused is named, as the contract asks of every run
    // that reports done over a write that failed.
    say({ type: 'done', output: { answer, failed: [{ capability: 'dns.write', why: 'It was refused, and the work did not need it.' }] } });
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
