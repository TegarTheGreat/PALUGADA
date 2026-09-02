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
import { getTask, transition, type TaskRow } from './tasks.ts';
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
}

export type TaskHandler = (ctx: TaskContext) => Promise<Record<string, unknown>>;

export interface EngineOptions {
  broker: CapabilityBroker;
  llm: LlmClient;
  handlers: Map<string, TaskHandler>;
}

export interface RunOutcome {
  status: 'completed' | 'failed' | 'halted' | 'cancelled' | 'waiting_approval';
  output?: Record<string, unknown>;
  reason?: string;
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

    if (task.status === 'pending' || task.status === 'waiting_approval') {
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

    if (code === 'platform.stopped' || code === 'company.frozen') {
      const current = await withTenant(companyId, (tx) => getTask(tx, taskId));
      if (current && current.status !== 'cancelled') {
        await transition(companyId, taskId, 'cancelled', { haltReason: 'owner_stop' });
      }
      return { status: 'cancelled', reason: code };
    }

    const haltCodes: Record<string, 'budget_exhausted' | 'hop_limit' | 'deadline_passed' | 'verification_failed' | 'cycle_detected'> = {
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
