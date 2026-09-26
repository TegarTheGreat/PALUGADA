/**
 * A role run by a model, with nothing but the platform around it (F13.1).
 *
 * The in-process runtime ran handlers, and a deployment had none: every role
 * in the standard company names `in-process`, and nothing in the repository
 * could do the work one of them was given. This is the handler every role has
 * when it has no other -- the model reads the pack, calls the role's tools
 * through the broker, and finishes with the task's output.
 *
 * **Every model turn is a journalled step.** A worker that crashes on the
 * ninth turn resumes at the ninth: the eight before it replay from the
 * journal, the tools they called replay with them, and the conversation is
 * rebuilt exactly as it was. What the model is told (the system prompt) is
 * rebuilt from the latest pack on every run, so an owner's note written while
 * the task waited is read by the turns still to come. A turn's step input is
 * its position and nothing else, for the same reason the in-process handlers'
 * steps leave the model out of theirs: a fallback model (F13.6) continues the
 * primary's conversation rather than diverging from it.
 *
 * **A refusal is an answer, a wait is not.** A tool the broker refuses --
 * not granted, a schema it does not meet, a policy, the owner's no -- comes
 * back to the model as an error it can work around, which is what a person
 * told "you cannot do that" does. Anything that means the task now waits or
 * must stop -- an approval, a question to the owner, the budget, a freeze --
 * ends the run, and the engine parks or halts the task as it would for any
 * runtime.
 */
import { PalugadaError } from '../errors.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { renderSystem, renderTask, toWireRequest } from './wire.ts';
import { toolsForModel } from './tool-names.ts';
import type { LlmBlock, ToolUsingLlmClient } from '../llm/client.ts';
import type { RunRequest, RunServices } from './protocol.ts';

/** Enough for real work; a run that needs more is going round in circles. */
export const MAX_TURNS = 40;
/** How much of one tool result the model is shown. */
export const TOOL_RESULT_LIMIT = 20_000;

/**
 * The broker's answers that end the run rather than inform it.
 *
 * Everything else a tool call throws is shown to the model as a failed call.
 */
const ENDS_THE_RUN: ReadonlySet<string> = new Set([
  'approval.required', 'owner.asked', 'review.required', 'window.closed', 'task.waiting_child',
  'capability.rate_limited', 'budget.exceeded', 'budget.reservation_refused', 'spend.paused',
  'platform.stopped', 'company.frozen', 'role.frozen', 'deadline.exceeded', 'task.lease_lost',
  'task.invalid_transition', 'journal.divergence', 'tenant.context_missing', 'model.unavailable',
]);

function bounded(text: string): string {
  if (text.length <= TOOL_RESULT_LIMIT) return text;
  return `${text.slice(0, TOOL_RESULT_LIMIT)}\n... [cut short: the result was ${text.length} characters]`;
}

/**
 * The output in the model's last word: a JSON object, perhaps in a fence.
 *
 * Null when there is none, so the loop can ask once more rather than fail a
 * task over a model that wrote a sentence before its answer.
 */
export function outputFrom(text: string): Record<string, unknown> | null {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1]!.trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // The next candidate.
    }
  }
  return null;
}

interface RecordedTurn {
  content: LlmBlock[];
  stopReason: string;
}

export async function runAgentLoop(
  request: RunRequest,
  services: RunServices,
  client: ToolUsingLlmClient,
): Promise<Record<string, unknown>> {
  const wire = toWireRequest(request);
  const system = renderSystem(wire);
  const { tools, platformName } = toolsForModel(request.allowedTools);
  const messages: Array<{ role: 'user' | 'assistant'; content: string | LlmBlock[] }> = [
    { role: 'user', content: renderTask(wire) },
  ];
  const model = request.modelRouting.primary;
  let askedForOutput = false;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (services.signal.aborted) throw services.signal.reason ?? new Error('the run was stopped');
    const recorded = await services.step<RecordedTurn>(`model:turn ${turn + 1}`, 'llm', { turn }, async () => {
      const started = Date.now();
      const reply = await client.turn(
        { model, system, messages, tools, maxTokens: Math.min(8_192, Math.max(1_024, request.limits.tokens)) },
        services.signal,
      );
      // Charged before the turn is kept: the engine throws when the budget
      // will not cover it, and a turn the budget refused is not one the run
      // may build on.
      await services.reportUsage({
        model: reply.model ?? model,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        costCents: reply.costCents,
        latencyMs: Date.now() - started,
        prompt: { system, messages },
        response: { content: reply.content },
      });
      return { content: reply.content, stopReason: reply.stopReason };
    });

    messages.push({ role: 'assistant', content: recorded.content });
    const said = recorded.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
    if (said && services.narrate) await services.narrate(said).catch(() => undefined);

    const calls = recorded.content.filter((block): block is Extract<LlmBlock, { type: 'tool_use' }> =>
      block.type === 'tool_use');
    if (calls.length > 0) {
      const results: LlmBlock[] = [];
      for (const call of calls) {
        results.push(await answer(call, platformName, services));
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (recorded.stopReason === 'refusal') {
      throw new Error(`the model declined the task: ${said.slice(0, 500)}`);
    }
    const output = outputFrom(said);
    if (output) return output;
    if (askedForOutput) {
      throw new Error(`the model finished without the task's output as a JSON object: ${said.slice(0, 500)}`);
    }
    askedForOutput = true;
    messages.push({
      role: 'user',
      content: 'Reply now with the task\'s output as a single JSON object, and nothing else.',
    });
  }
  throw new Error(`the model took ${MAX_TURNS} turns without finishing the task`);
}

async function answer(
  call: Extract<LlmBlock, { type: 'tool_use' }>,
  platformName: Map<string, string>,
  services: RunServices,
): Promise<LlmBlock> {
  const name = platformName.get(call.name);
  if (!name) {
    return {
      type: 'tool_result', toolUseId: call.id, isError: true,
      content: `There is no tool named ${call.name}. Your tools are: ${[...platformName.keys()].join(', ') || 'none'}.`,
    };
  }
  try {
    const output = await services.callTool<unknown, unknown>(name, call.input ?? {});
    // What a tool returns is data from wherever the tool reached -- a web
    // page, an inbox, another company's API -- and it is shown to the model
    // as data, never as instructions (F8.9).
    return {
      type: 'tool_result', toolUseId: call.id,
      content: bounded(wrapUntrusted(`tool ${name}`, JSON.stringify(output ?? null))),
    };
  } catch (error) {
    if (services.signal.aborted) throw error;
    if (error instanceof PalugadaError && ENDS_THE_RUN.has(error.code)) throw error;
    const code = error instanceof PalugadaError ? `${error.code}: ` : '';
    return {
      type: 'tool_result', toolUseId: call.id, isError: true,
      content: `${name} was refused -- ${code}${(error as Error).message}`.slice(0, 2_000),
    };
  }
}
