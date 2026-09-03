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
  RunEvent,
  RunRequest,
  RunServices,
} from './protocol.ts';

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
          // Narration. Not journalled: F11.1 asks for a trace of model calls
          // and tool calls, and a runtime's running commentary is neither.
          break;

        case 'done':
          return { output: event.output };

        case 'error':
          throw event.providerFailure
            ? new ProviderFailure(request.modelRouting.primary, event.message)
            : new Error(event.message);
      }
    }

    throw new Error(
      `runtime ended without producing an output for run ${request.runId}`,
    );
  } finally {
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
    const output = await services.callTool(event.name, event.args);
    await transport.send({ type: 'tool_result', id: event.id, output });
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
 */
export async function* readNdjson(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<unknown> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
      index = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest);
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
      return { type: 'usage', usage: (value as { usage: never }).usage };
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
