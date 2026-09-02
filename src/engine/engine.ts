/**
 * Task runner (PRD F5).
 *
 * The engine is the only authority on task status (principle 5). A handler
 * describes what a role does; when to start, resume, retry, halt or stop is
 * decided here, so that the agent framework can be swapped without taking
 * durability with it.
 *
 * The guards run before every step rather than once at task start. A deadline
 * checked only at admission, or a stop button that waits for the current task
 * to end, is not a control -- it is a suggestion.
 */
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { createSubTask, getTask, transition, type TaskRow } from './tasks.ts';
import { validateContract } from './contracts.ts';
import { isTerminal } from '../domain/task.ts';
import { runStep, type StepKind } from './journal.ts';
import { isCompanyFrozen, isStopAllRequested } from './control.ts';
import * as budget from './budget.ts';
import * as inbox from '../inbox/inbox.ts';
import type { CapabilityBroker } from '../broker/broker.ts';
import type { LlmClient, LlmRequest } from '../llm/client.ts';

export interface TaskContext {
  readonly task: TaskRow;
  readonly signal: AbortSignal;
  /** Runs a journalled step, or replays its recorded output after a restart. */
  step<T>(name: string, kind: StepKind, input: unknown, fn: (key: string) => Promise<T>): Promise<T>;
  /** Calls an external capability through the broker. Never called directly. */
  callCapability<I, O>(name: string, input: I): Promise<O>;
  /** Calls the model, charging tokens against the inherited budget. */
  llm(request: Omit<LlmRequest, 'model'> & { model?: string }): Promise<string>;
  /**
   * Runs another role and waits for its typed output (PRD F6.4).
   *
   * The only synchronous path between roles, and it goes through the engine
   * rather than between agents. `timeoutMs` is required, not optional: a
   * blocking call with no deadline is how one stuck sub-task quietly holds a
   * parent's budget reservation open for ever.
   */
  awaitChild(
    roleSlug: string,
    input: Record<string, unknown>,
    options: { timeoutMs: number; reserveTokens?: number },
  ): Promise<Record<string, unknown>>;
}

export type TaskHandler = (ctx: TaskContext) => Promise<Record<string, unknown>>;

export interface EngineOptions {
  broker: CapabilityBroker;
  llm: LlmClient;
  handlers: Map<string, TaskHandler>;
}

export interface RunOutcome {
  status:
    | 'completed'
    | 'failed'
    | 'halted'
    | 'cancelled'
    | 'waiting_approval'
    | 'waiting_review'
    | 'waiting_window';
  output?: Record<string, unknown>;
  reason?: string;
  /** Set when the outcome is `waiting_window`: when to try again (F9.2). */
  waitUntil?: Date | null;
}

export class Engine {
  readonly #options: EngineOptions;

  constructor(options: EngineOptions) {
    this.#options = options;
  }

  async runTask(companyId: string, taskId: string, roleSlug: string): Promise<RunOutcome> {
    const handler = this.#options.handlers.get(roleSlug);
    if (!handler) throw new Error(`no handler registered for role ${roleSlug}`);

    const task = await withTenant(companyId, (tx) => getTask(tx, taskId));
    if (!task) throw new Error(`task ${taskId} not found`);

    const blocked = await this.#checkGuards(task);
    if (blocked) return blocked;

    // F6.2: the contract is checked before the run starts. A run that begins
    // on malformed input spends tokens discovering what a schema could have
    // said for free.
    const contract = await this.#loadContract(companyId, task.roleId);
    try {
      validateContract('input', task.roleId, roleSlug, contract.input, task.input);
    } catch (error) {
      // Halted rather than failed. A retry cannot help: the input is what it
      // is, so this is terminal work for the owner's inbox rather than another
      // attempt against the same malformed payload. An *output* violation is
      // the opposite case -- the model produced it, and a retry may well fix
      // it -- so that one stays on the ordinary retry path.
      await transition(companyId, taskId, 'halted', { haltReason: 'contract_violation' });
      return { status: 'halted', reason: (error as Error).message };
    }

    if (['pending', 'waiting_approval', 'waiting_review', 'waiting_window'].includes(task.status)) {
      await transition(companyId, taskId, 'running');
    }

    const controller = new AbortController();
    const agentRunId = await this.#startAgentRun(task);

    // Step indices restart at zero on every run and are assigned in call
    // order. Replay depends on that: a step's identity is its position in the
    // handler's sequence, so seeding the counter from the journal would shift
    // every index after a resume and replay the wrong outputs. The cost is a
    // constraint on handlers -- they must issue the same steps in the same
    // order given the same input -- which is the usual bargain for
    // deterministic replay and is why branching on wall-clock time or
    // randomness inside a handler is a defect.
    let stepIndex = 0;

    const ctx: TaskContext = {
      task,
      signal: controller.signal,

      step: async <T,>(name: string, kind: StepKind, input: unknown, fn: (key: string) => Promise<T>) => {
        const guard = await this.#checkGuards(task);
        if (guard) throw new PalugadaError('platform.stopped', guard.reason ?? 'halted', {});
        const index = stepIndex++;
        const { value } = await runStep(
          { companyId, taskId },
          {
            stepIndex: index,
            name,
            kind,
            input,
            // Re-checked after the side effect: a stop pressed mid-step must
            // not leave a committed step behind.
            beforeCommit: async () => {
              if (await isStopAllRequested()) {
                controller.abort();
                throw new PalugadaError('platform.stopped', 'stop requested during step', {});
              }
            },
          },
          fn,
        );
        return value;
      },

      callCapability: async <I, O,>(name: string, input: I): Promise<O> => {
        return ctx.step(`capability:${name}`, 'tool', { name, input }, async (key) => {
          const result = await this.#options.broker.invoke<I, O>(
            {
              companyId, projectId: task.projectId, divisionId: task.divisionId,
              taskId, idempotencyKey: key, signal: controller.signal,
            },
            name,
            input,
          );
          return result.output;
        });
      },

      awaitChild: async (childRoleSlug, childInput, childOptions) => {
        if (!Number.isFinite(childOptions.timeoutMs) || childOptions.timeoutMs <= 0) {
          throw new Error('awaitChild requires a positive timeoutMs (PRD F6.4)');
        }

        return ctx.step(
          `await:${childRoleSlug}`,
          'internal',
          { role: childRoleSlug, input: childInput },
          async () => {
            const childRoleId = await withTenant(companyId, async (tx) => {
              const { rows } = await tx.query<{ id: string }>(
                'SELECT id FROM roles WHERE slug = $1',
                [childRoleSlug],
              );
              return rows[0]?.id ?? null;
            });
            if (!childRoleId) throw new Error(`no role named ${childRoleSlug}`);

            // The deadline is written onto the child as well as raced here, so
            // a child that outlives this process is still bounded by its own
            // record rather than by a timer that died with the caller.
            const child = await createSubTask(taskId, {
              companyId,
              projectId: task.projectId,
              divisionId: task.divisionId,
              roleId: childRoleId,
              input: childInput,
              createdBy: 'agent_run',
              deadlineAt: new Date(Date.now() + childOptions.timeoutMs),
              ...(childOptions.reserveTokens === undefined
                ? {}
                : { reserveTokens: childOptions.reserveTokens }),
            });

            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new PalugadaError('deadline.exceeded', `child ${childRoleSlug} timed out`, {
                  childTaskId: child.id,
                  timeoutMs: childOptions.timeoutMs,
                })),
                childOptions.timeoutMs,
              );
            });

            try {
              const outcome = await Promise.race([
                this.runTask(companyId, child.id, childRoleSlug),
                timeout,
              ]);
              if (outcome.status !== 'completed') {
                throw new PalugadaError(
                  'task.invalid_transition',
                  `child ${childRoleSlug} ended as ${outcome.status}`,
                  { childTaskId: child.id, status: outcome.status, reason: outcome.reason },
                );
              }
              return outcome.output ?? {};
            } catch (error) {
              const current = await withTenant(companyId, (tx) => getTask(tx, child.id));
              if (current && !isTerminal(current.status)) {
                await transition(companyId, child.id, 'halted', { haltReason: 'deadline_passed' });
              }
              throw error;
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
        );
      },

      llm: async (request) => {
        return ctx.step('llm', 'llm', request, async () => {
          const response = await this.#options.llm.complete(
            { model: request.model ?? 'unset', system: request.system, messages: request.messages },
            controller.signal,
          );
          const funded = await withTenant(companyId, (tx) =>
            budget.spend(tx, task.budgetAccountId, {
              tokens: response.inputTokens + response.outputTokens,
              moneyCents: response.costCents,
              fromReservation: task.tokensReserved,
            }),
          );
          if (!funded) {
            throw new PalugadaError('budget.exceeded', 'shared budget exhausted', {
              budgetAccountId: task.budgetAccountId,
            });
          }
          return response.content;
        });
      },
    };

    try {
      const output = await handler(ctx);
      // F6.2, F6.3: validated before the task is marked complete, because a
      // downstream task triggered by `task.completed` has no other guarantee
      // about what it is about to read.
      validateContract('output', task.roleId, roleSlug, contract.output, output);
      await this.#finishAgentRun(companyId, agentRunId, 'succeeded');
      await transition(companyId, taskId, 'completed', { output });
      return { status: 'completed', output };
    } catch (error) {
      await this.#finishAgentRun(companyId, agentRunId, 'failed');
      return this.#classifyFailure(companyId, taskId, error);
    }
  }

  /**
   * Maps a thrown failure onto the state machine.
   *
   * The distinction that matters is `failed` versus `halted`: a failure may be
   * retried, while a halt is terminal and becomes an owner inbox item. Budget,
   * hop, deadline and a failed read-back all halt, because retrying any of
   * them would either overspend or repeat an unverified write.
   */
  async #classifyFailure(companyId: string, taskId: string, error: unknown): Promise<RunOutcome> {
    const code = error instanceof PalugadaError ? error.code : null;

    if (code === 'approval.required') {
      return { status: 'waiting_approval', reason: code };
    }

    // F9.2: a closed window is not a failure. The action is permitted, just not
    // at this hour, so the task parks with a wake-up time instead of burning an
    // attempt or escalating to the owner.
    if (code === 'window.closed') {
      const reopensAt = (error as PalugadaError).details.reopensAt;
      const waitUntil = typeof reopensAt === 'string' ? new Date(reopensAt) : null;
      await transition(companyId, taskId, 'waiting_window', { waitUntil });
      return { status: 'waiting_window', reason: code, waitUntil };
    }

    if (code === 'review.required') {
      await transition(companyId, taskId, 'waiting_review');
      return { status: 'waiting_review', reason: code };
    }

    if (code === 'platform.stopped' || code === 'company.frozen') {
      const current = await withTenant(companyId, (tx) => getTask(tx, taskId));
      if (current && current.status !== 'cancelled') {
        await transition(companyId, taskId, 'cancelled', { haltReason: 'owner_stop' });
      }
      return { status: 'cancelled', reason: code };
    }

    const haltCodes: Record<
      string,
      'policy_denied' | 'budget_exhausted' | 'hop_limit' | 'deadline_passed'
        | 'verification_failed' | 'cycle_detected'
    > = {
      // A denial is terminal rather than retryable: the same call would be
      // refused again, and retrying it only burns the attempt budget.
      'policy.denied': 'policy_denied',
      'budget.exceeded': 'budget_exhausted',
      'budget.reservation_refused': 'budget_exhausted',
      'hop.exceeded': 'hop_limit',
      'deadline.exceeded': 'deadline_passed',
      'capability.verify_failed': 'verification_failed',
      'cycle.detected': 'cycle_detected',
    };

    const haltReason = code ? haltCodes[code] : undefined;
    if (haltReason) {
      await transition(companyId, taskId, 'halted', { haltReason });
      if (haltReason === 'verification_failed') {
        // F8.4: a write that reports success but reads back differently is an
        // incident, not a retry.
        await inbox.raiseIncident({
          companyId, taskId,
          title: 'External write failed verification',
          detail: (error as Error).message,
        });
      }
      return { status: 'halted', reason: haltReason };
    }

    const task = await withTenant(companyId, (tx) => getTask(tx, taskId));
    const exhausted = !task || task.attempt + 1 >= task.attemptMax;
    await withTenant(companyId, async (tx) => {
      await tx.query('UPDATE tasks SET attempt = attempt + 1 WHERE id = $1', [taskId]);
      await appendEvent(tx, {
        companyId, taskId, type: 'task.attempt_failed', actor: 'system',
        payload: { error: (error as Error).message },
      });
    });

    if (exhausted) {
      await transition(companyId, taskId, 'failed');
      return { status: 'failed', reason: (error as Error).message };
    }
    return { status: 'failed', reason: 'retryable' };
  }

  /** Deadline, platform stop and company freeze, checked together. */
  async #checkGuards(task: TaskRow): Promise<RunOutcome | null> {
    if (await isStopAllRequested()) {
      return { status: 'cancelled', reason: 'platform.stopped' };
    }
    if (await isCompanyFrozen(task.companyId)) {
      return { status: 'cancelled', reason: 'company.frozen' };
    }
    if (task.deadlineAt && task.deadlineAt.getTime() <= Date.now()) {
      const current = await withTenant(task.companyId, (tx) => getTask(tx, task.id));
      if (current && !['halted', 'cancelled', 'completed', 'failed'].includes(current.status)) {
        await transition(task.companyId, task.id, 'halted', { haltReason: 'deadline_passed' });
      }
      return { status: 'halted', reason: 'deadline.exceeded' };
    }
    return null;
  }

  async #loadContract(
    companyId: string,
    roleId: string,
  ): Promise<{ input: Record<string, unknown>; output: Record<string, unknown> }> {
    return withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{
        input_schema: Record<string, unknown>;
        output_schema: Record<string, unknown>;
      }>('SELECT input_schema, output_schema FROM roles WHERE id = $1', [roleId]);
      const row = rows[0];
      return { input: row?.input_schema ?? {}, output: row?.output_schema ?? {} };
    });
  }

  async #startAgentRun(task: TaskRow): Promise<string> {
    return withTenant(task.companyId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO agent_runs (company_id, task_id, role_id, attempt)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (task_id, attempt) DO UPDATE SET status = 'running'
         RETURNING id`,
        [task.companyId, task.id, task.roleId, task.attempt],
      );
      return rows[0]!.id;
    });
  }

  async #finishAgentRun(
    companyId: string,
    agentRunId: string,
    status: 'succeeded' | 'failed' | 'aborted',
  ): Promise<void> {
    await withTenant(companyId, async (tx) => {
      await tx.query(
        'UPDATE agent_runs SET status = $2, finished_at = now() WHERE id = $1',
        [agentRunId, status],
      );
    });
  }
}
