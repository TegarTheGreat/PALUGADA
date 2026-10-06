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
import { outputFrom } from '../llm/json.ts';
import { wrapUntrusted } from '../context/builder.ts';
import { citeStep } from '../engine/done.ts';
import { renderSystem, renderTask, toWireRequest } from './wire.ts';
import { toolsForModel } from './tool-names.ts';
import type { LlmBlock, ToolUsingLlmClient } from '../llm/client.ts';
import type { RunRequest, RunServices } from './protocol.ts';

/** Enough for real work; a run that needs more is going round in circles. */
export const MAX_TURNS = 40;
/** How much of one tool result the model is shown. */
export const TOOL_RESULT_LIMIT = 20_000;
/** The newest answers of read-only calls a model is always sent whole. */
export const RESULTS_SHOWN_WHOLE = 8;
/** What is left out moves in steps of this many answers, so most of what is sent is the same from turn to turn. */
const ELISION_STEP = 4;
/** An answer this short costs less to keep than the line that would replace it. */
const STUB_FLOOR = 600;
/** The model is told which turn it is on in its last this many. */
const LATE_TURNS = 5;

/**
 * How much one turn may write, and how far that grows.
 *
 * A reasoning model counts its thinking against this allowance. DeepSeek, in
 * the live run of 2026-09-28, spent all 8,192 tokens of a turn thinking and
 * said nothing at all (defect L4). A turn cut off like that is asked again
 * with twice the room, up to the ceiling -- or the role's own allowance for a
 * whole run, if that is smaller.
 */
const TURN_ALLOWANCE = 8_192;

/**
 * The least room a turn is given to write in. A turn the budget could fund
 * only with less is not asked: it could not say anything useful, and the
 * conversation it sends would be paid for regardless.
 */
const LEAST_ROOM = 512;
const TURN_ALLOWANCE_CEILING = 32_768;

/**
 * The broker's answers that end the run rather than inform it.
 *
 * Everything else a tool call throws is shown to the model as a failed call.
 */
const ENDS_THE_RUN: ReadonlySet<string> = new Set([
  'approval.required', 'owner.asked', 'review.required', 'window.closed', 'task.waiting_child',
  'capability.rate_limited', 'capability.busy', 'budget.exceeded', 'budget.reservation_refused', 'spend.paused',
  'platform.stopped', 'company.frozen', 'role.frozen', 'deadline.exceeded', 'task.lease_lost',
  'task.invalid_transition', 'journal.divergence', 'tenant.context_missing', 'model.unavailable',
  // F8.4: a write that did not read back is an incident, not something for
  // the model to try again (engine.ts HALTING_CODES).
  'capability.verify_failed', 'run.limit',
]);

function bounded(text: string): string {
  if (text.length <= TOOL_RESULT_LIMIT) return text;
  return `${text.slice(0, TOOL_RESULT_LIMIT)}\n... [cut short: the result was ${text.length} characters]`;
}

export { outputFrom } from '../llm/json.ts';

type Message = { role: 'user' | 'assistant'; content: string | LlmBlock[] };

/** The platform's own line after a call's answer, which names the step: no page can say it, because it follows the fence. */
const STEP_LINE = /This call is step:(\d+) of your task; evidence may cite it as step:\1\.\s*$/;

/**
 * The conversation as a model is sent it: the answers of old read-only calls
 * are a line each.
 *
 * Every turn used to be sent the whole conversation, so a run that read a
 * page on each of thirty turns paid for every page thirty times. The oldest
 * answers (all but the newest eight to eleven) of calls that only read, and
 * that ran to more than a few hundred characters, become a line that says
 * which step they were and how long, so a done-report that cites the step
 * still verifies against the journal, and that the call can be made again.
 * What a model wrote, what a write answered, a refusal and a short answer are
 * never touched, and every call keeps an answer.
 *
 * The result depends on the conversation alone -- no clock, no counts of
 * tokens -- and the conversation is rebuilt from the journal on every resume,
 * so a run that was stopped and went on is sent what it would have been. What
 * is left out moves in steps, so a provider that caches a prompt's start
 * finds most of it unchanged from one turn to the next.
 */
export function elideOldResults(messages: readonly Message[], readers: ReadonlySet<string>): Message[] {
  const called = new Map<string, string>();
  let answers = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') called.set(block.id, block.name);
      else if (block.type === 'tool_result') answers += 1;
    }
  }
  const hidden = answers <= RESULTS_SHOWN_WHOLE ? 0 : Math.floor((answers - RESULTS_SHOWN_WHOLE) / ELISION_STEP) * ELISION_STEP;
  if (hidden === 0) return [...messages];

  let ordinal = 0;
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block): LlmBlock => {
      if (block.type !== 'tool_result') return block;
      const mine = ordinal;
      ordinal += 1;
      const tool = called.get(block.toolUseId);
      if (mine >= hidden || block.isError || tool === undefined || !readers.has(tool) || block.content.length <= STUB_FLOOR) return block;
      changed = true;
      const step = STEP_LINE.exec(block.content)?.[1];
      return {
        ...block,
        content: `[The result of ${step ? `step:${step}` : 'an earlier call'} (${tool}) ran to ${block.content.length} characters and is left out to save room. `
          + `${step ? `The journal keeps it, and step:${step} still cites it. ` : ''}Call ${tool} again if you need it.]`,
      };
    });
    return changed ? { ...message, content } : message;
  });
}

/**
 * In its last few turns the model is told which turn it is on.
 *
 * A run that has not returned its output by the last turn fails, and used to
 * fail without the model having been told there was a last turn. Told only at
 * the end, so a run that finishes early is sent nothing it did not need and
 * the message before the new one stays as it was.
 */
export function withTurnNotice(messages: readonly Message[], turn: number, max = MAX_TURNS): readonly Message[] {
  const left = max - turn - 1;
  const last = messages.at(-1);
  if (left >= LATE_TURNS || !last || last.role !== 'user') return messages;
  const note = left > 0
    ? `This is turn ${turn + 1} of ${max}. ${left} ${left === 1 ? 'turn remains' : 'turns remain'} after it. If the work is not finished, `
      + `plan to reply by turn ${max} with the task's output as a single JSON object, saying plainly what is done and what is not.`
    : `This is turn ${max} of ${max}, your last. Reply now with the task's output as a single JSON object, `
      + 'saying plainly what is done and what is not. A tool call now ends the task unfinished.';
  const content = typeof last.content === 'string'
    ? `${last.content}\n\n${note}`
    : [...last.content, { type: 'text' as const, text: note }];
  return [...messages.slice(0, -1), { role: 'user', content }];
}

/** Said once in the system prompt, where it does not change from turn to turn and so does not break a cached start. */
function turnBudgetNote(max: number): string {
  return `## Your turns\n\nYou have at most ${max} turns on this task, counting those of earlier runs of it. A turn is one reply `
    + `of yours, whether or not it calls tools; the tools' answers come back with the next turn. A task that has not returned `
    + `its output by turn ${max} fails. As the conversation grows, the answers of older read-only tools are replaced by a line `
    + 'that names their step and size: say in your own words, as you go, what you will need of them, and call the tool again '
    + 'if you need the text itself.';
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
  const system = `${renderSystem(wire)}\n\n${turnBudgetNote(MAX_TURNS)}`;
  const { tools, platformName } = toolsForModel(request.allowedTools);
  // The tools that only read: the ones whose old answers may be left out, because asking again is safe.
  const tierOf = new Map(request.allowedTools.map((tool) => [tool.name, tool.tier]));
  const readers = new Set([...platformName].filter(([, platform]) => tierOf.get(platform) === 0).map(([model]) => model));
  const messages: Message[] = [
    { role: 'user', content: renderTask(wire) },
  ];
  const model = request.modelRouting.primary;
  let askedForOutput = false;
  let allowance = Math.min(TURN_ALLOWANCE, Math.max(1_024, request.limits.tokens));
  const ceiling = Math.max(allowance, Math.min(TURN_ALLOWANCE_CEILING, request.limits.tokens));

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (services.signal.aborted) throw services.signal.reason ?? new Error('the run was stopped');
    // Whether the model wrote this turn now, or the journal replayed it.
    let fresh = false;
    const recorded = await services.step<RecordedTurn>(`model:turn ${turn + 1}`, 'llm', { turn }, async () => {
      fresh = true;
      // Asked here, inside the step, so a turn replayed from the journal --
      // which calls nothing -- is never refused for want of money: a task the
      // owner continued after raising its ceiling replays its turns for free.
      let room = allowance;
      // What this turn is sent: the conversation with its oldest reads left
      // out, and the turn's number when few remain. The conversation itself,
      // the journal and the step a turn is kept under are not changed.
      const sent = withTurnNotice(elideOldResults(messages, readers), turn);
      if (services.tokensLeft) {
        const left = await services.tokensLeft();
        const sending = Math.ceil(JSON.stringify({ system, messages: sent, tools }).length / 4);
        if (left - sending < LEAST_ROOM) {
          throw new PalugadaError('budget.exceeded',
            `the budget has ${left} tokens left, and this turn would send about ${sending} before the model wrote ` +
              `anything: raise the account's ceiling to go on`,
            { tokensLeft: left, sending });
        }
        room = Math.min(allowance, left - sending);
      }
      const started = Date.now();
      const reply = await client.turn(
        { model, system, messages: [...sent], tools, maxTokens: room },
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
        prompt: { system, messages: sent },
        response: { content: reply.content },
      });
      // Thrown inside the step, so the step is not committed: the next
      // attempt asks the model again. Returned, it would be journalled, and
      // every retry would replay the same silence without asking anyone.
      if (saidNothing(reply.content) && reply.stopReason === 'max_tokens' && room >= ceiling) {
        throw new Error(
          `the model said nothing in ${room} tokens, the largest output allowance a turn gets here: `
            + 'a reasoning model spent it thinking. Lower its reasoning effort, or give the role a model '
            + 'that answers within it',
        );
      }
      return { content: reply.content, stopReason: reply.stopReason };
    });

    // A turn that said nothing and called nothing is not one to build on: a
    // provider refuses a conversation holding an empty assistant turn, and
    // that refusal replayed from the journal is what spent three attempts in
    // a second. Cut off, it is asked again with more room.
    if (recorded.stopReason === 'max_tokens') allowance = Math.min(ceiling, allowance * 2);
    if (saidNothing(recorded.content)) {
      if (recorded.stopReason === 'max_tokens') continue;
      if (askedForOutput) {
        throw new Error('the model finished without the task\'s output as a JSON object: it said nothing');
      }
      askedForOutput = true;
      messages.push({
        role: 'user',
        content: 'You replied with nothing. Reply now with the task\'s output as a single JSON object, or call one of your tools.',
      });
      continue;
    }

    messages.push({ role: 'assistant', content: recorded.content });
    const said = recorded.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
    // Said once, when it was said (N13). A turn replayed from the journal was
    // narrated again, with a new time, at every resume: the transcript showed
    // the same lines over and over, until a CEO wrote that it had "repeated
    // its orientation eight times".
    if (said && fresh && services.narrate) await services.narrate(said).catch(() => undefined);

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

/** No words and no tool call: nothing a conversation can hold. */
function saidNothing(content: readonly LlmBlock[]): boolean {
  return !content.some((block) => block.type === 'tool_use' || (block.type === 'text' && block.text.trim() !== ''));
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
    const placed: { step?: number } = {};
    const output = await services.callTool<unknown, unknown>(name, call.input ?? {}, (step) => { placed.step = step; });
    // What a tool returns is data from wherever the tool reached -- a web
    // page, an inbox, another company's API -- and it is shown to the model
    // as data, never as instructions (F8.9). Which step it is, is the
    // platform's word, so it goes after the fence.
    const shown = bounded(wrapUntrusted(`tool ${name}`, JSON.stringify(output ?? null)));
    return {
      type: 'tool_result', toolUseId: call.id,
      content: placed.step === undefined ? shown : `${shown}\n${citeStep(placed.step)}`,
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
