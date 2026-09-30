/**
 * The wire between the engine and an out-of-process runtime (PRD v2 §7.5,
 * F13.2, F13.3, F13.4).
 *
 * Every runtime that is not this process -- a spawned script, a webhook, a
 * headless CLI -- speaks the same vocabulary: it receives one JSON request and
 * emits a stream of `RunEvent`s; the engine answers `tool_call` and nothing
 * else. Concentrating that here means an adapter for a runtime nobody has
 * written yet is a matter of transport rather than of protocol, and it means
 * the rules below are enforced once instead of once per adapter.
 *
 * What the runtime never receives, and why it is enforced here rather than
 * trusted to each adapter:
 *
 *   - **No credentials, no endpoints (F13.4, F8.7).** Tools travel as a name,
 *     a schema and a tier. A `tool_call` comes back, the broker resolves it,
 *     and only the result goes out.
 *   - **No internal bookkeeping.** The task's budget account, lease holder and
 *     idempotency key are the platform's, not the runtime's. A runtime that
 *     could read the lease holder could impersonate a worker; one that could
 *     read the budget account has been told something it can only misuse.
 *   - **Nothing the redactor knows about.** Everything on its way out passes
 *     through it, because the cheapest way for a secret to reach a third-party
 *     process is inside a field nobody thought about.
 *
 * The engine is still the only authority on the task (principle 5). A runtime
 * that says `done` has said what it produced, not that the task is finished.
 */
import { randomUUID } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import { redactor } from '../secrets/manager.ts';
import type {
  AdapterResult,
  EngineMessage,
  ModelUsage,
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { setLongTimeout } from '../timers.ts';

/**
 * What actually goes over the wire.
 *
 * A deliberately smaller shape than `RunRequest`. Writing it out field by field
 * rather than deleting keys from the request means a field added to `TaskRow`
 * tomorrow does not silently start travelling to third-party processes.
 */
export interface WireRequest {
  runId: string;
  roleSlug: string;
  task: {
    id: string;
    input: Record<string, unknown>;
    hopDepth: number;
    hopMax: number;
    deadlineAt: string | null;
    attempt: number;
    attemptMax: number;
  };
  contextPack: {
    charter: string;
    skills: string[];
    memories: string[];
    goalAncestry: Array<{ kind: string; statement: string }>;
    notes: Array<{ title: string; body: string }>;
    workingMemory: Array<{ name: string; output: unknown }>;
  };
  allowedTools: Array<{ name: string; inputSchema: Record<string, unknown>; tier: number }>;
  modelRouting: { primary: string; fallback: string[] };
  backend: string;
  limits: { tokens: number; wallClockMs: number };
}

export function toWireRequest(request: RunRequest): WireRequest {
  return redactor.redactDeep({
    runId: request.runId,
    roleSlug: request.roleSlug,
    task: {
      id: request.task.id,
      input: request.task.input,
      hopDepth: request.task.hopDepth,
      hopMax: request.task.hopMax,
      deadlineAt: request.task.deadlineAt?.toISOString() ?? null,
      attempt: request.task.attempt,
      attemptMax: request.task.attemptMax,
    },
    contextPack: {
      charter: request.contextPack.charter,
      skills: request.contextPack.skills,
      memories: request.contextPack.memories,
      goalAncestry: request.contextPack.goalAncestry.map((goal) => ({
        kind: goal.kind,
        statement: goal.statement,
      })),
      notes: request.contextPack.notes,
      workingMemory: request.contextPack.workingMemory,
    },
    allowedTools: request.allowedTools.map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      tier: tool.tier,
    })),
    modelRouting: request.modelRouting,
    backend: request.backend,
    limits: request.limits,
  });
}

/**
 * The prompt an agent CLI is given, whichever CLI it is.
 *
 * The charter first, because F3.2 says the platform charter outranks the
 * company's and a prompt that buries it has already lost that argument. Then
 * the notes -- the languages, the stage, how the goal is measured, and what
 * the owner said to this task -- as prose, because they are instructions to
 * be read before the work rather than data to be parsed with it: an owner's
 * "lead with the price" placed under the task is read after the task has
 * already been understood. The rest travels as JSON: a runtime is a program,
 * and asking it to parse prose it was handed would add a failure mode for
 * nothing.
 *
 * One function for every CLI, deliberately. A role moved from one runtime to
 * another should be doing the same job, and a prompt that changed with the
 * adapter would make the runtime a variable in the work rather than in who
 * does it.
 */
export function renderPrompt(wire: WireRequest): string {
  return [renderSystem(wire), renderTask(wire)].join('\n');
}

/**
 * What governs the run: the charter, then the notes, then how to finish.
 *
 * The system prompt of a model the platform runs itself (the agent loop), and
 * the first half of an agent CLI's prompt.
 */
export function renderSystem(wire: WireRequest): string {
  const notes = wire.contextPack.notes.flatMap((note) => [`## ${note.title}`, '', note.body, '']);
  return [
    wire.contextPack.charter,
    '',
    ...(notes.length > 0 ? ['# Before you start', '', ...notes] : []),
    '# How you work',
    '',
    'Act only through the tools you have been given. When you are finished,',
    'reply with a single JSON object and nothing else: that object is the',
    "task's output and is validated against the role's output schema.",
    '',
  ].join('\n');
}

/** The task itself, and what the run has to work from, as JSON. */
export function renderTask(wire: WireRequest): string {
  return [
    '# Your task',
    JSON.stringify(
      {
        task: wire.task,
        goalAncestry: wire.contextPack.goalAncestry,
        skills: wire.contextPack.skills,
        memories: wire.contextPack.memories,
        workingMemory: wire.contextPack.workingMemory,
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * A runtime reached over something.
 *
 * `events` is what it says; `send` is how it is answered; `close` releases
 * whatever the transport holds and is called on every path out of `driveRun`,
 * including the ones nobody enjoys.
 */
export interface Transport {
  events: AsyncIterable<RunEvent>;
  send(message: EngineMessage): Promise<void>;
  close(): Promise<void>;
  /**
   * Ends the runtime now, for a transport that has something to end.
   *
   * A spawned runtime implements it by ending its process tree, which also
   * ends `events`. Optional because a remote runtime has nothing local to
   * stop: its request is aborted instead, and the loop ends with it.
   */
  terminate?(): Promise<void>;
}

/**
 * A failure the engine is allowed to retry on a different model (F13.6).
 *
 * Separate from an ordinary error because the distinction decides whether the
 * platform may quietly change which model did the work, and that is a decision
 * that should be visible in the type system rather than inferred from a
 * message.
 */
export class ProviderFailure extends Error {
  readonly model: string;

  constructor(model: string, message: string) {
    super(message);
    this.name = 'ProviderFailure';
    this.model = model;
  }
}

/**
 * Runs the loop until the runtime says `done`, says `error`, or stops talking.
 *
 * A stream that ends without `done` is a failure rather than an empty success.
 * A runtime that dies mid-thought has produced nothing, and reading silence as
 * completion would mark a task complete on the strength of a crash.
 */
export async function driveRun(
  request: RunRequest,
  services: RunServices,
  transport: Transport,
): Promise<AdapterResult> {
  const abort = () => {
    void transport.send({ type: 'cancel', reason: 'the engine withdrew the run' }).catch(() => {});
  };
  services.signal.addEventListener('abort', abort, { once: true });

  // F5.6 and F6.4, for a runtime that has gone quiet. The engine checks the
  // deadline before every step, which is enough for a runtime that keeps
  // taking steps and no use at all against one that has hung: no step, no
  // check, and `limits.wallClockMs` was sent to every runtime and enforced by
  // none. So the deadline is a timer here. The runtime is told first, and
  // then ended -- a runtime past its deadline has had its chance to stop.
  const deadlineAt = request.task.deadlineAt;
  let overran = false;
  // A long timer, because a deadline can be further off than `setTimeout`
  // can wait, and past that it fires at once.
  const deadline = deadlineAt
    ? setLongTimeout(() => {
        overran = true;
        void transport
          .send({ type: 'cancel', reason: 'the task deadline has passed' })
          .catch(() => {})
          .then(() => transport.terminate?.());
      }, deadlineAt.getTime() - Date.now())
    : null;
  deadline?.unref();
  const overranError = () =>
    new PalugadaError(
      'deadline.exceeded',
      `run ${request.runId} was still going at its task deadline `
        + `${deadlineAt!.toISOString()} and was ended (PRD F5.6, F6.4)`,
      { runId: request.runId, deadlineAt: deadlineAt!.toISOString() },
    );

  try {
    for await (const event of transport.events) {
      switch (event.type) {
        case 'tool_call': {
          await handleToolCall(event, services, transport);
          break;
        }

        case 'usage': {
          // F13.7 and F1.x in one line: the runtime accounts for the call, the
          // engine decides whether the company can afford the next one. A
          // throw here is the budget refusing, and it ends the run -- there is
          // deliberately no channel by which a runtime can be told "you are
          // nearly out" and choose to ignore it.
          await services.reportUsage(event.usage);
          break;
        }

        case 'text':
          // Narration. Not journalled -- F11.1 asks for a trace of model calls
          // and tool calls, and a runtime's running commentary is neither --
          // but kept for the owner to read, where it used to be thrown away.
          // A line that cannot be kept is lost, never the run.
          await services.narrate?.(event.text).catch(() => undefined);
          break;

        case 'done':
          return { output: event.output };

        case 'error':
          throw event.providerFailure
            ? new ProviderFailure(request.modelRouting.primary, event.message)
            : new Error(event.message);
      }
    }

    if (overran) throw overranError();
    throw new Error(
      `runtime ended without producing an output for run ${request.runId}`,
    );
  } catch (error) {
    // Ending the tree usually surfaces as whatever the runtime said as it
    // died -- a broken pipe, an unreadable half-line. The deadline is the
    // reason, and it is the one the engine needs: it halts the task rather
    // than spending an attempt on a retry that would overrun the same way.
    if (overran && !(error instanceof PalugadaError)) throw overranError();
    throw error;
  } finally {
    deadline?.clear();
    services.signal.removeEventListener('abort', abort);
    await transport.close();
  }
}

/**
 * Answers one `tool_call`.
 *
 * A refusal is an answer, not a crash. The broker denying a capability is the
 * system working, and the runtime is told so in terms it can act on -- it may
 * try something else, or explain why it cannot. What it must never do is
 * receive the denial as a dead connection and guess.
 */
async function handleToolCall(
  event: Extract<RunEvent, { type: 'tool_call' }>,
  services: RunServices,
  transport: Transport,
): Promise<void> {
  try {
    const placed: { step?: number } = {};
    const output = await services.callTool(event.name, event.args, (step) => { placed.step = step; });
    await transport.send({ type: 'tool_result', id: event.id, output, ...placed });
  } catch (error) {
    if (error instanceof PalugadaError) {
      await transport.send({
        type: 'tool_error',
        id: event.id,
        code: error.code,
        message: error.message,
      });
      return;
    }
    // An unrecognised failure is the engine's problem rather than the
    // runtime's, so it ends the run instead of being handed over as advice.
    throw error;
  }
}

/**
 * Splits a byte stream into JSON values, one per line.
 *
 * Newline-delimited JSON rather than a framed protocol because every language
 * a community adapter might be written in can produce it with one print
 * statement, and because a half-written line at the end of a stream is
 * recognisably incomplete rather than silently truncating a value.
 *
 * Decoded with a streaming `TextDecoder` rather than per chunk. Chunk
 * boundaries fall wherever the transport puts them, and a multi-byte character
 * split across two of them decodes to two replacement characters if each half
 * is converted on its own -- which for a remote runtime, where the boundaries
 * are TCP segments rather than pipe writes, is not a rare case. `{ stream:
 * true }` holds the partial sequence back until the rest arrives.
 *
 * Accepts a plain `Uint8Array` as well as a `Buffer`: a `fetch` response body
 * yields the former, and a remote sandbox's output is a `fetch` response body.
 */
export async function* readNdjson(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<unknown> {
  for await (const line of readLines(stream, 'it')) yield JSON.parse(line);
}

/**
 * The longest unfinished line a runtime may leave in the reader, in
 * characters.
 *
 * A line is held until it ends, and one that never ended was held whole: a
 * CLI stuck redrawing a progress bar, a model pouring a file into a single
 * string, a process gone wrong. The worker's memory grew with it until the
 * run's deadline, or until the string passed what V8 allows and the append
 * threw somewhere nobody was listening. Sixteen mebibytes is several times the
 * largest event a runtime has a reason to write -- a whole answer in one
 * `result` line -- and a worker running several runs at once survives every
 * one of them reaching it.
 */
export const LINE_LIMIT = 16 * 1024 * 1024;

/**
 * A stream a line at a time: trimmed, blank lines dropped, each one bounded
 * by `LINE_LIMIT`.
 *
 * Past the bound it throws, which ends the run and, through the transport's
 * `close`, the process that wrote it. `who` begins the message the owner
 * reads. The search for a line break starts where the last chunk ended rather
 * than at the start of the line, so a long line costs its length once, not
 * its length for every chunk it arrived in.
 */
export async function* readLines(
  stream: AsyncIterable<Uint8Array | string>,
  who: string,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    const searched = buffer.length;
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0;
    let index = buffer.indexOf('\n', searched);
    while (index !== -1) {
      const line = buffer.slice(start, index).trim();
      start = index + 1;
      if (line) yield line;
      index = buffer.indexOf('\n', start);
    }
    buffer = buffer.slice(start);
    if (buffer.length > LINE_LIMIT) {
      throw new Error(
        `${who} wrote more than ${LINE_LIMIT / 1024 / 1024} MiB without a line break, `
          + 'and was stopped rather than held in memory',
      );
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) yield rest;
}

/**
 * Reads a usage report, or refuses it.
 *
 * It was cast. A usage report is the one message a runtime sends that moves
 * money, and `budget_spend` adds what it is given: a report of `-100000`
 * cents from a runtime -- buggy, or told by a prompt it read to do so --
 * would have erased its company's spend down to zero, and negative tokens
 * would have done the same to the token ceiling. A string would have reached
 * the database as a type error in the middle of the accounting. So the shape
 * is checked here, where every runtime that is not this process arrives, and
 * again by the engine, which is the accounting authority whatever the source.
 */
export function checkUsage(raw: unknown): ModelUsage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('usage without a usage object');
  }
  const usage = raw as Record<string, unknown>;
  const count = (name: string): number => {
    const value = usage[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`usage.${name} must be a non-negative whole number, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  if (typeof usage.model !== 'string' || usage.model.length === 0 || usage.model.length > 200) {
    throw new Error('usage.model must be a model name');
  }
  // Absent is unknown, the same as null: a runtime that does not know what a
  // call cost says nothing, and the engine estimates it and marks it as an
  // estimate. Refusing the report would lose the tokens along with the price.
  const cost = usage.costCents === undefined ? null : usage.costCents;
  if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
    throw new Error(`usage.costCents must be null or a non-negative number, got ${JSON.stringify(cost)}`);
  }
  const latency = usage.latencyMs;
  if (latency !== undefined && (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0)) {
    throw new Error('usage.latencyMs must be a non-negative number');
  }
  if (usage.runTotal !== undefined && typeof usage.runTotal !== 'boolean') {
    throw new Error('usage.runTotal must be a boolean');
  }
  if (usage.runTotal === true && cost === null) {
    throw new Error('usage.runTotal carries the run\'s cost, so costCents cannot be null');
  }
  return {
    model: usage.model,
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    costCents: cost as number | null,
    ...(latency === undefined ? {} : { latencyMs: latency as number }),
    ...('prompt' in usage ? { prompt: usage.prompt } : {}),
    ...('response' in usage ? { response: usage.response } : {}),
    ...(usage.runTotal === true ? { runTotal: true } : {}),
  };
}

/**
 * Reads an untrusted value as a `RunEvent`.
 *
 * A runtime is a third party. Its output is parsed rather than cast: an
 * unrecognised event type ends the run with a message naming what arrived,
 * which is a better failure than a `done` with an undefined output quietly
 * completing a task.
 */
export function parseRunEvent(value: unknown): RunEvent {
  const event = value as Partial<RunEvent> & { type?: string };
  switch (event.type) {
    case 'tool_call': {
      const call = value as Extract<RunEvent, { type: 'tool_call' }>;
      if (typeof call.name !== 'string') throw new Error('tool_call without a name');
      return {
        type: 'tool_call',
        id: typeof call.id === 'string' ? call.id : randomUUID(),
        name: call.name,
        args: call.args ?? {},
        ...(call.idemKey ? { idemKey: call.idemKey } : {}),
      };
    }
    case 'text':
      return { type: 'text', text: String((value as { text?: unknown }).text ?? '') };
    case 'usage':
      return { type: 'usage', usage: checkUsage((value as { usage?: unknown }).usage) };
    case 'done': {
      const output = (value as { output?: unknown }).output;
      if (output === null || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('done without an object output');
      }
      return { type: 'done', output: output as Record<string, unknown> };
    }
    case 'error': {
      const error = value as Extract<RunEvent, { type: 'error' }>;
      return {
        type: 'error',
        message: String(error.message ?? 'the runtime reported an error'),
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
        ...(error.providerFailure === undefined
          ? {}
          : { providerFailure: error.providerFailure }),
      };
    }
    default:
      throw new Error(`unrecognised run event: ${JSON.stringify(event.type ?? value)}`);
  }
}
