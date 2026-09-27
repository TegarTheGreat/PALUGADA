/**
 * What five agent CLIs actually print (F13.3).
 *
 * `hermes`, `openclaw` and `opencode` were each read at a fixed commit, and
 * `codex` and `gemini-cli` were run -- Codex 0.157.1 and Gemini CLI 0.61.0,
 * against a stand-in model and the tool bridge -- and what they printed is
 * what these read (the research is summarised in `src/runtime/known-clis.ts`).
 * None of them speaks the Claude Code stream the adapter already understood:
 *
 * - **Hermes** prints JSON lines that look like Claude Code's and are not.
 *   Its final `result` line has no `subtype`, carries the answer in `text`
 *   and the tokens in `tokens`, and no cost at all. Read as Claude Code's,
 *   every Hermes run ended as "unknown" -- a failure -- however well it went.
 * - **OpenClaw** (`agent exec --json`) prints one envelope when it exits:
 *   `status`, `final`, `usage`, and `costUsd` when its model has a price.
 * - **OpenCode** (`run --format json`) streams events and has no final result
 *   line: the answer is the last text part, and each `step_finish` carries
 *   that step's tokens and cost.
 * - **Codex** (`exec --json`) streams `item.*` events; the answer is the last
 *   `agent_message` item, the tokens are on `turn.completed`, and there is no
 *   price. An `error` item is a warning, not a failure.
 * - **Gemini CLI** (`--output-format stream-json`) streams the answer as
 *   assistant deltas, and its `result` carries the verdict and the tokens but
 *   neither the answer nor a price.
 *
 * Each is a function from what the process printed, and how it exited, to the
 * platform's `RunEvent`s -- separate from the process so that what is claimed
 * about a vendor's format is tested against that format directly, with no
 * binary installed.
 */
import type { ModelUsage, RunEvent } from './protocol.ts';
import { asOutput } from './claude-code.ts';

type Lines = AsyncIterable<string>;

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    // A banner, a warning, a progress line: not an event. Skipped, as in the
    // Claude Code dialect, because agent CLIs print such things to stdout.
    return null;
  }
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function failure(runtime: string, what: string, stderr: () => string): RunEvent {
  const detail = stderr().trim();
  // Not a provider failure: nothing here says the provider failed rather than
  // the process, and F13.6 would answer a provider failure with a second,
  // billed run on another model.
  return { type: 'error', message: `${runtime} ${what}` + (detail ? `: ${detail}` : ''), providerFailure: false };
}

/**
 * Hermes: `hermes chat --oneshot --format stream-json`.
 *
 * `text` lines are deltas of the answer, passed on as text. The terminal
 * `result` line is the whole run: its tokens become one usage report, and
 * its `exit_code` and `error` are the verdict. A process that ends without a
 * result line did not finish, whatever its exit code says.
 *
 * The result line carries no price. Hermes does price the session and keeps
 * it, so `costOf` -- given its session id, once the process has exited and
 * written its ledger -- reads that back; without one, or when Hermes does not
 * know the price either, the engine estimates (F13.7).
 */
export async function* hermesEvents(
  lines: Lines, exit: () => Promise<number>, stderr: () => string, runtime: string, model: string,
  costOf?: (sessionId: string) => Promise<number | null>,
): AsyncGenerator<RunEvent> {
  let reported = model;
  for await (const raw of lines) {
    const line = parse(raw);
    if (!line) continue;
    if (line.type === 'system' && line.subtype === 'init' && typeof line.model === 'string') {
      reported = line.model;
      continue;
    }
    if (line.type === 'text' && typeof line.text === 'string' && line.text) {
      yield { type: 'text', text: line.text };
      continue;
    }
    if (line.type === 'result') {
      const tokens = (line.tokens ?? {}) as Record<string, unknown>;
      let costCents: number | null = null;
      if (costOf && typeof line.session_id === 'string') {
        // The ledger is written as the process ends; a few seconds at most.
        await Promise.race([exit(), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
        costCents = await costOf(line.session_id).catch(() => null);
      }
      const usage: ModelUsage = {
        model: reported,
        inputTokens: number(tokens.input),
        outputTokens: number(tokens.output),
        costCents,
      };
      yield { type: 'usage', usage };
      if (line.exit_code === 0 && !line.error) {
        yield { type: 'done', output: asOutput(line.text) };
      } else {
        yield failure(runtime, `ended with exit code ${String(line.exit_code)}` +
          (typeof line.error === 'string' ? ` (${line.error})` : ''), stderr);
      }
      return;
    }
  }
  yield failure(runtime, `exited ${await exit()} without a result`, stderr);
}

/**
 * What Hermes recorded a session as costing, in cents, from its ledger's row
 * (`hermes sessions export`): the provider's own figure where it has one,
 * Hermes' estimate where that is all there is, nothing for a route a
 * subscription covers, and null -- not nought -- for a price it does not
 * know, so the engine prices it rather than calling it free.
 */
export function hermesSessionCents(row: Record<string, unknown>): number | null {
  const usd = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const actual = usd(row.actual_cost_usd);
  const estimated = usd(row.estimated_cost_usd);
  const figure = row.cost_status === 'included' ? 0
    : row.cost_status === 'actual' || row.cost_status === 'estimated' ? actual ?? estimated
      : actual;
  return figure === null ? null : figure * 100;
}

/**
 * OpenClaw: `openclaw agent exec --json`, one envelope at exit.
 *
 * The usage is the run's, priced when OpenClaw knows the price, and reported
 * before the verdict so a failed run is still charged what it cost. Exit code
 * 2 is OpenClaw's timeout, and says so.
 */
export async function* openClawEvents(
  stdout: Promise<string>, exit: () => Promise<number>, stderr: () => string, runtime: string, model: string,
): AsyncGenerator<RunEvent> {
  const text = (await stdout).trim();
  const code = await exit();
  // The envelope is the last JSON object printed; anything before it is not.
  const envelope = parse(text) ?? parse(text.slice(text.lastIndexOf('\n{') + 1));
  if (!envelope) {
    yield failure(runtime, code === 2 ? 'timed out' : `exited ${code} without its JSON result`, stderr);
    return;
  }
  const usage = (envelope.usage ?? null) as Record<string, unknown> | null;
  if (usage) {
    const cost = typeof envelope.costUsd === 'number' && Number.isFinite(envelope.costUsd) && envelope.costUsd >= 0
      ? envelope.costUsd * 100 : null;
    yield {
      type: 'usage',
      usage: {
        model: typeof envelope.model === 'string' ? envelope.model : model,
        inputTokens: number(usage.input),
        outputTokens: number(usage.output),
        costCents: cost,
      },
    };
  }
  if (envelope.status === 'ok' && code === 0) {
    yield { type: 'done', output: asOutput(envelope.final) };
    return;
  }
  const error = (envelope.error ?? {}) as Record<string, unknown>;
  yield failure(
    runtime,
    envelope.status === 'timeout' || code === 2
      ? 'timed out'
      : `ended as ${String(envelope.status ?? 'unknown')}` + (typeof error.message === 'string' ? ` (${error.message})` : ''),
    stderr,
  );
}

/**
 * OpenCode: `opencode run --format json`.
 *
 * Every `step_finish` is one model step, reported as it happens so the
 * budget sees the run while it is running. A cost of zero with tokens spent
 * means the model has no price in OpenCode's table, not that it was free,
 * and is reported as unknown for the engine to estimate (F13.7). The answer
 * is the last text part; an `error` event, or a non-zero exit, is the verdict
 * instead.
 */
export async function* openCodeEvents(
  lines: Lines, exit: () => Promise<number>, stderr: () => string, runtime: string, model: string,
): AsyncGenerator<RunEvent> {
  let last: string | null = null;
  let failed: string | null = null;
  let provider = false;
  for await (const raw of lines) {
    const line = parse(raw);
    if (!line) continue;
    const part = (line.part ?? {}) as Record<string, unknown>;
    if (line.type === 'text' && typeof part.text === 'string') {
      last = part.text;
      yield { type: 'text', text: part.text };
    } else if (line.type === 'step_finish') {
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      const inputTokens = number(tokens.input) + number(cache.read) + number(cache.write);
      const outputTokens = number(tokens.output) + number(tokens.reasoning);
      const cost = number(part.cost);
      yield {
        type: 'usage',
        usage: {
          model,
          inputTokens,
          outputTokens,
          costCents: cost === 0 && inputTokens + outputTokens > 0 ? null : cost * 100,
        },
      };
    } else if (line.type === 'error') {
      const error = (line.error ?? {}) as Record<string, unknown>;
      const data = (error.data ?? {}) as Record<string, unknown>;
      failed = typeof data.message === 'string' ? data.message : String(error.name ?? 'an error');
      provider = error.name === 'APIError';
    }
  }
  const code = await exit();
  if (failed !== null) {
    yield { ...failure(runtime, `reported ${failed}`, stderr), providerFailure: provider } as RunEvent;
    return;
  }
  if (code !== 0) {
    yield failure(runtime, `exited ${code}`, stderr);
    return;
  }
  if (last === null) {
    yield failure(runtime, 'finished without an answer', stderr);
    return;
  }
  yield { type: 'done', output: asOutput(last) };
}

/**
 * Codex: `codex exec --json`.
 *
 * Its answer is the last `agent_message` item, and everything before one is
 * working. `turn.completed` carries the turn's tokens and no price, so the
 * engine estimates (F13.7). An `error` item or a top-level `error` is Codex
 * saying something went wrong that it is working around -- "Reconnecting...
 * 2/5", a model it has no metadata for -- and the run is judged only by
 * `turn.failed` and the exit code, or it would fail runs that succeeded.
 */
export async function* codexEvents(
  lines: Lines, exit: () => Promise<number>, stderr: () => string, runtime: string, model: string,
): AsyncGenerator<RunEvent> {
  let last: string | null = null;
  let failed: string | null = null;
  for await (const raw of lines) {
    const line = parse(raw);
    if (!line) continue;
    const item = (line.item ?? {}) as Record<string, unknown>;
    if (line.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      last = item.text;
      yield { type: 'text', text: item.text };
    } else if (line.type === 'turn.completed') {
      const usage = (line.usage ?? {}) as Record<string, unknown>;
      // Input counts its cached part already, and output its reasoning: the
      // breakdowns are not added again.
      yield {
        type: 'usage',
        usage: { model, inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), costCents: null },
      };
    } else if (line.type === 'turn.failed') {
      const error = (line.error ?? {}) as Record<string, unknown>;
      failed = typeof error.message === 'string' ? error.message : 'the turn failed';
    }
  }
  const code = await exit();
  if (failed !== null) {
    yield failure(runtime, `reported ${failed}`, stderr);
    return;
  }
  if (code !== 0) {
    yield failure(runtime, `exited ${code}`, stderr);
    return;
  }
  if (last === null) {
    yield failure(runtime, 'finished without an answer', stderr);
    return;
  }
  yield { type: 'done', output: asOutput(last) };
}

/**
 * Gemini CLI: `gemini --output-format stream-json`.
 *
 * The answer arrives as assistant deltas, and only the ones after the last
 * tool result are the answer: what it said before calling a tool was working.
 * `result` is the verdict and the whole run's tokens, with no price and no
 * answer of its own. Its exit codes are its own too: 53 is its turn limit and
 * 55 a folder it does not trust, both said by `result` or stderr.
 */
export async function* geminiEvents(
  lines: Lines, exit: () => Promise<number>, stderr: () => string, runtime: string, model: string,
): AsyncGenerator<RunEvent> {
  let answer = '';
  let reported = model;
  let result: Record<string, unknown> | null = null;
  for await (const raw of lines) {
    const line = parse(raw);
    if (!line) continue;
    if (line.type === 'init' && typeof line.model === 'string') {
      reported = line.model;
    } else if (line.type === 'message' && line.role === 'assistant' && typeof line.content === 'string') {
      answer = line.delta === true ? answer + line.content : line.content;
      yield { type: 'text', text: line.content };
    } else if (line.type === 'tool_result') {
      answer = '';
    } else if (line.type === 'result') {
      result = line;
    }
  }
  const code = await exit();
  if (!result) {
    yield failure(runtime, `exited ${code} without a result`, stderr);
    return;
  }
  const stats = (result.stats ?? {}) as Record<string, unknown>;
  const models = Object.keys((stats.models ?? {}) as Record<string, unknown>);
  yield {
    type: 'usage',
    usage: {
      // The model that answered, when it says; the one asked for otherwise.
      model: models.length === 1 ? models[0]! : reported,
      inputTokens: number(stats.input_tokens),
      outputTokens: number(stats.output_tokens),
      costCents: null,
    },
  };
  if (result.status === 'success' && code === 0) {
    yield { type: 'done', output: asOutput(answer) };
    return;
  }
  const error = (result.error ?? {}) as Record<string, unknown>;
  yield failure(runtime,
    `ended as ${String(result.status ?? 'unknown')}` + (typeof error.message === 'string' ? ` (${error.message})` : ''),
    stderr);
}
