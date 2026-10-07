/**
 * Noticing that a run is going round in circles (the owner's challenge of 7
 * October: everything that is put in must be mature, not only look complete).
 *
 * The role loop gives a model forty turns and used to notice nothing about how
 * it spent them. A model that called one tool with one input thirty times, and
 * was given the same answer thirty times, was left to do it until its turns or
 * its money ran out, and the owner read "took 40 turns without finishing". The
 * patterns are OpenHands' stuck detector's, which names them from agents that
 * did this in the wild:
 *
 * - **the same call, the same answer**, four times running;
 * - **the same call, refused**, three times running -- whatever words the
 *   refusal used, because a refusal that carries the time of the try is still
 *   the same refusal;
 * - **two calls taking turns**, six in all: A, B, A, B, A, B.
 *
 * What is done about it is a ladder, and every rung is a function of the
 * conversation alone -- no clock, no counter kept beside it -- so a run rebuilt
 * from the journal after a crash is told exactly what an uninterrupted one
 * was, as `elideOldResults` and `withTurnNotice` already guarantee:
 *
 * 1. **A notice** after the pattern, on a copy of the last message: which call,
 *    how often, and what to do instead -- including that finishing and saying
 *    what is blocked is an acceptable way out. It is repeated while the pattern
 *    holds and gone as soon as the model does something else.
 * 2. **A wrap-up** when the model has gone on for three more after being told:
 *    its next turn is sent with no tools and told to reply with the task's
 *    output saying what is done and what is not. The engine's done report then
 *    does what it always does with a run that says a criterion is not met: the
 *    task is not done, and the retry is told why. The run is not left to spend
 *    thirty more turns, and it is not failed for a thing the model can still
 *    say honestly.
 *
 * What it does not do is judge progress: a model that changes its input every
 * time and learns nothing is not noticed, and nothing here pretends to. It
 * catches the loop that costs most for least reason.
 */
import { createHash } from 'node:crypto';
import type { LlmBlock } from '../llm/client.ts';

export type LoopMessage = { role: 'user' | 'assistant'; content: string | LlmBlock[] };

/** One call the model made and the answer it was given. */
export interface Exchange {
  tool: string;
  /** The step the platform numbered the call, when its answer says (a refusal does not). */
  step: number | null;
  /** The input with its keys in order, so an input an order apart is the same input. */
  input: string;
  /** What the tool said, without the platform's own line after it (which numbers the call, and differs on every one). */
  answer: string;
  failed: boolean;
}

/** The platform's own line after a call's answer: it names the step, and no two calls share one. */
const STEP_LINE = /\n?This call is step:(\d+) of your task; evidence may cite it as step:\d+\.\s*$/;

/** How often the same call is a pattern, and how many more it takes after being told to ask for the end. */
export const SAME_ANSWER_TIMES = 4;
export const SAME_REFUSAL_TIMES = 3;
export const TAKING_TURNS_CALLS = 6;
export const WRAP_UP_AFTER_MORE = 3;

export interface Stuck {
  pattern: 'same answer' | 'same error' | 'ping-pong';
  tool: string;
  /** How many calls the pattern runs to, at the end of the conversation. */
  times: number;
  /** The other call, for two taking turns. */
  other?: string;
}

export type LoopHealth =
  | { state: 'ok' }
  | { state: 'warn'; stuck: Stuck }
  | { state: 'wrap-up'; stuck: Stuck };

/** An input as one string whatever order its keys were written in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The calls of a conversation with the answers they were given, in order.
 *
 * An answer is paired with the call before it, not with the last one that used
 * its id: a server that sends no ids gives the first call of every reply the
 * same one (the loop's elision pairs them the same way). A call with no answer
 * yet is not an exchange.
 */
export function exchangesOf(messages: readonly LoopMessage[]): Exchange[] {
  const calls = new Map<string, { tool: string; input: string }>();
  const exchanges: Exchange[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.set(block.id, { tool: block.name, input: canonical(block.input ?? {}) });
      if (block.type !== 'tool_result') continue;
      const call = calls.get(block.toolUseId);
      if (!call) continue;
      const step = STEP_LINE.exec(block.content)?.[1];
      exchanges.push({
        ...call, failed: block.isError === true,
        step: step === undefined ? null : Number(step),
        answer: block.content.replace(STEP_LINE, ''),
      });
    }
  }
  return exchanges;
}

/**
 * Whether two exchanges are the same: the same call and, for one that
 * succeeded, the same answer; for one that was refused, the refusal's words
 * do not count.
 */
function alike(a: Exchange, b: Exchange): boolean {
  if (a.tool !== b.tool || a.input !== b.input || a.failed !== b.failed) return false;
  return a.failed || a.answer === b.answer;
}

/** A short stand-in for an exchange, to compare two taking turns without holding their text twice. */
const fingerprint = (one: Exchange) =>
  createHash('sha256').update(`${one.tool}\n${one.input}\n${one.failed ? '(refused)' : one.answer}`).digest('hex');

/** How many exchanges at the end are the same as the last one. */
function sameRun(exchanges: readonly Exchange[]): number {
  const last = exchanges.at(-1);
  if (!last) return 0;
  let n = 1;
  while (n < exchanges.length && alike(exchanges[exchanges.length - 1 - n]!, last)) n += 1;
  return n;
}

/** How many exchanges at the end alternate between two that differ. */
function takingTurns(exchanges: readonly Exchange[]): number {
  if (exchanges.length < 2) return 0;
  const prints = exchanges.slice(-24).map(fingerprint);
  const last = prints.length - 1;
  if (prints[last] === prints[last - 1]) return 0;
  let n = 2;
  while (n < prints.length && prints[last - n] === prints[last - (n % 2)]) n += 1;
  return n;
}

/** Where the conversation stands: fine, a run to be told, or a run that was told and went on. */
export function loopHealth(messages: readonly LoopMessage[]): LoopHealth {
  const exchanges = exchangesOf(messages);
  const last = exchanges.at(-1);
  if (!last) return { state: 'ok' };

  const same = sameRun(exchanges);
  const warnAt = last.failed ? SAME_REFUSAL_TIMES : SAME_ANSWER_TIMES;
  if (same >= warnAt) {
    const stuck: Stuck = { pattern: last.failed ? 'same error' : 'same answer', tool: last.tool, times: same };
    return same >= warnAt + WRAP_UP_AFTER_MORE ? { state: 'wrap-up', stuck } : { state: 'warn', stuck };
  }

  const turns = takingTurns(exchanges);
  if (turns >= TAKING_TURNS_CALLS) {
    const stuck: Stuck = { pattern: 'ping-pong', tool: last.tool, times: turns, other: exchanges.at(-2)!.tool };
    return turns >= TAKING_TURNS_CALLS + WRAP_UP_AFTER_MORE ? { state: 'wrap-up', stuck } : { state: 'warn', stuck };
  }
  return { state: 'ok' };
}

function noticeFor(health: Exclude<LoopHealth, { state: 'ok' }>): string {
  const { stuck } = health;
  if (health.state === 'wrap-up') {
    return 'Platform notice: you were told you were going round in circles and have gone on. You have no tools now. '
      + 'Reply with the task\'s output as a single JSON object, saying plainly what is done and what is not; if you could '
      + 'not do what was asked, put what stopped you under "notDone". A reply that is not that object ends the task unfinished.';
  }
  const subject = stuck.pattern === 'ping-pong'
    ? `you have gone back and forth between ${stuck.tool} and ${stuck.other ?? 'another call'} for ${stuck.times} calls, with nothing changing`
    : `you have called ${stuck.tool} with the same input ${stuck.times} times and ${stuck.pattern === 'same error' ? 'been refused' : 'got the same answer'} each time`;
  return `Platform notice: ${subject}. Calling it again will not change that. Do something different -- another tool, other input, `
    + 'or another way to the goal -- or, if you cannot go on, finish now with the task\'s output saying plainly what is done '
    + 'and what is blocked. If you go on as you are, your next turns will be taken from you.';
}

/**
 * The conversation as a model is sent it when the run is going round in
 * circles: the last message, copied, with the platform's notice after it. Said
 * while the pattern holds, so a run that does something else is sent nothing
 * more and the message before the new one stays as it was.
 */
export function withHealthNotice(messages: readonly LoopMessage[], health: LoopHealth): readonly LoopMessage[] {
  const last = messages.at(-1);
  if (health.state === 'ok' || !last || last.role !== 'user') return messages;
  const note = noticeFor(health);
  const content = typeof last.content === 'string'
    ? `${last.content}\n\n${note}`
    : [...last.content, { type: 'text' as const, text: note }];
  return [...messages.slice(0, -1), { role: 'user', content }];
}
