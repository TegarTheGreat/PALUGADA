/**
 * The in-process runtime (PRD v2 F13.1, NG6).
 *
 * A runtime that happens to run inside the orchestrator's own process. It is
 * the platform's development runtime and the one the acceptance suite employs,
 * and it is a genuine adapter rather than a bypass: the engine talks to it
 * through the same protocol it uses for `claude-code`, `http` and `script`,
 * knows nothing about what it does inside a run, and never calls a model
 * itself.
 *
 * What it gets that an out-of-process runtime does not, and why:
 *
 * **It journals its model calls.** Being in-process, it can use the engine's
 * `step`, so a crash resumes at the next step rather than re-issuing the model
 * calls that already succeeded. A black-box runtime cannot offer that -- F5.1
 * journals the adapter round-trip, and what the runtime did inside one is
 * invisible. Session continuity (F4.7) is what makes the weaker case bearable,
 * not something that makes the two equivalent. The difference is stated here
 * because it is the reason to keep this runtime rather than a footnote about
 * it.
 *
 * **It still holds no credentials.** Its capability calls go through
 * `services.callTool`, which is the broker, which is where the secrets are. It
 * has that in common with every other runtime, and it is the property that
 * makes "the runtime is compromised" a survivable sentence.
 *
 * The model client lives here rather than in the engine. That is NG6 in one
 * line: the thing that decides what to say to a model is the runtime, and the
 * thing that decides whether the company can afford it is the platform.
 *
 * **A role with no handler is run by the model** (`agent-loop.ts`), when the
 * client can let a model use tools. Handlers are how the platform's own tests
 * and a deployment's bespoke roles work; a company started from a template
 * has none, and until the loop every one of its roles was a name with nothing
 * behind it.
 */
import { usesTools, type LlmClient, type LlmRequest } from '../llm/client.ts';
import { runAgentLoop } from './agent-loop.ts';
import { dutyFor } from '../duties/duties.ts';
import type { StepKind } from '../engine/journal.ts';
import type { TaskRow } from '../engine/tasks.ts';
import type { ChildResult } from '../engine/containment.ts';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  ExecutionBackend,
  RunRequest,
  RunServices,
} from './protocol.ts';

/** What a handler is given. Unchanged from the shape handlers already use. */
export interface TaskContext {
  readonly task: TaskRow;
  readonly signal: AbortSignal;
  step<T>(name: string, kind: StepKind, input: unknown, fn: (key: string) => Promise<T>): Promise<T>;
  callCapability<I, O>(name: string, input: I): Promise<O>;
  llm(request: Omit<LlmRequest, 'model'> & { model?: string }): Promise<string>;
  awaitChild(
    roleSlug: string,
    input: Record<string, unknown>,
    options: { timeoutMs: number; reserveTokens?: number },
  ): Promise<ChildResult>;
}

export type TaskHandler = (ctx: TaskContext) => Promise<Record<string, unknown>>;

export class InProcessAdapter implements Adapter {
  readonly name = 'in-process';
  /** It launches nothing, so `local` is the only backend that describes it. */
  readonly backends: readonly ExecutionBackend[] = ['local'];

  readonly #handlers: Map<string, TaskHandler>;
  readonly #llm: LlmClient;

  constructor(options: { handlers: Map<string, TaskHandler>; llm: LlmClient }) {
    this.#handlers = options.handlers;
    this.#llm = options.llm;
  }

  /**
   * Always healthy, and that is not a stub.
   *
   * F13.8 asks whether a runtime is reachable. This one is the process asking,
   * so the honest answer is yes: if it were not, nothing would be running to
   * return an answer at all.
   */
  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: 'in-process' };
  }

  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    // A task the platform made to do a duty (src/duties) runs that duty, with no
    // model; every other task is the role's handler's, or the model's.
    const handler = dutyFor(request.task) ?? this.#handlers.get(request.roleSlug);
    if (!handler) {
      if (usesTools(this.#llm)) return { output: await runAgentLoop(request, services, this.#llm) };
      throw new Error(
        `no handler registered for role ${request.roleSlug}, and the model client cannot use tools to run it`,
      );
    }

    const ctx: TaskContext = {
      task: request.task,
      signal: services.signal,
      step: services.step,
      callCapability: (name, input) => services.callTool(name, input),
      awaitChild: (roleSlug, input, options) => services.awaitChild(roleSlug, input, options),

      llm: async (llmRequest) =>
        services.step('llm', 'llm', llmRequest, async () => {
          const response = await this.#llm.complete(
            {
              // The role's routing, unless the handler asked for something
              // specific. F13.6 puts the choice on the role; a handler
              // overriding it is doing so knowingly.
              model: llmRequest.model ?? request.modelRouting.primary,
              system: llmRequest.system,
              messages: llmRequest.messages,
            },
            services.signal,
          );

          // The engine does the accounting and throws when the budget will not
          // cover it. That throw is how a runtime learns it has run out, and
          // there is deliberately no other channel.
          await services.reportUsage({
            model: response.model ?? llmRequest.model ?? request.modelRouting.primary,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costCents: response.costCents,
            // This runtime is the platform's own, so it shares what it said.
            // A third-party runtime may not, and F11.1 is satisfied either way
            // -- what it requires is the trace, not the transcript.
            prompt: { system: llmRequest.system, messages: llmRequest.messages },
            response: { content: response.content },
          });

          return response.content;
        }),
    };

    return { output: await handler(ctx), writtenBy: 'code' };
  }
}
