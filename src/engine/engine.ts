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
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError, isPalugadaError } from '../errors.ts';
import { createSubTask, getTask, transition, type TaskRow } from './tasks.ts';
import { validateContract } from './contracts.ts';
import { containChildResult, type ChildResult } from './containment.ts';
import { isTerminal } from '../domain/task.ts';
import { DEFAULT_PRICE_TABLE, estimateCents, type PriceTable } from './pricing.ts';
import { checkUsage } from '../runtime/wire.ts';
import { runStep, type StepKind } from './journal.ts';
import { LeaseKeeper } from './lease-keeper.ts';
import { setLongTimeout, sleep, type LongTimer } from '../timers.ts';
import { isCompanyFrozen, isStopAllRequested } from './control.ts';
import type { HookPipeline } from './hooks.ts';
import { batchWindow, isWithin, nextOpening } from '../scheduler/windows.ts';
import {
  AdapterRegistry,
  type Adapter,
  type AdapterResult,
  type ExecutionBackend,
  type RunRequest,
  type RunServices,
} from '../runtime/protocol.ts';
import { InProcessAdapter, type TaskHandler } from '../runtime/in-process.ts';
import { ProviderFailure } from '../runtime/wire.ts';
import { proposeNegativeCase } from '../eval/role-eval.ts';
import { buildContext } from '../context/builder.ts';
import { ancestryForTask } from '../domain/goals.ts';
import { preflightForRole } from '../broker/preflight.ts';
import {
  DEFAULT_LEASE_MS, adoptLease, claimTask, clearLease, recordRunHeartbeat, renewLease,
} from './checkout.ts';
import * as budget from './budget.ts';
import * as inbox from '../inbox/inbox.ts';
import type { CapabilityBroker } from '../broker/broker.ts';
import type { LlmClient } from '../llm/client.ts';

/**
 * The handler shape, re-exported from the runtime that defines it.
 *
 * NG6: a handler is a *runtime's* idea, not the engine's. It lives with the
 * in-process adapter now, and is re-exported here so existing callers keep
 * one import rather than being churned to make a point.
 */
export type { TaskContext, TaskHandler } from '../runtime/in-process.ts';

export interface EngineOptions {
  broker: CapabilityBroker;
  /**
   * The runtimes this engine may employ (F13.1).
   *
   * Optional only because `llm` and `handlers` below build the in-process one
   * for you. A deployment that employs a real runtime registers it here.
   */
  adapters?: AdapterRegistry;
  /**
   * Convenience: builds the in-process runtime from a model client and a
   * handler map.
   *
   * Kept because most callers want exactly that, and because the alternative
   * -- making every caller assemble an adapter -- would be churn in service of
   * a point the types already make. The engine itself never touches this
   * client; it is handed to the runtime, which is the only thing that calls a
   * model (NG6).
   */
  llm?: LlmClient;
  handlers?: Map<string, TaskHandler>;
  /**
   * F5.11: who this engine is, when it claims a task.
   *
   * Defaulted rather than required, and defaulted to something unique per
   * instance: two engines sharing an identity would be able to renew each
   * other's leases, which is the one thing a lease exists to prevent.
   */
  workerId?: string;
  /**
   * F13.7: what a model call costs when the runtime does not say.
   *
   * Defaulted to `DEFAULT_PRICE_TABLE`, whose fallback is deliberately the top
   * of the market: every agent CLI reports tokens and no price, and an
   * estimate of zero is what left F1.7's money ceiling unmoved while a
   * provider billed.
   */
  prices?: PriceTable;
  /**
   * F5.12: how long a lease lasts, and so how long a worker that died holding
   * a task keeps it from everyone else. Defaulted to `DEFAULT_LEASE_MS`; a
   * test that needs a lease to lapse sets it short.
   */
  leaseMs?: number;
}

/** How often a parent looks again at a child it cannot run itself. */
const CHILD_POLL_MS = 1_000;

/**
 * The longest a rate limit may park a task (F9.2).
 *
 * Six hours. A vendor's rate limit is counted in seconds, minutes, at most an
 * hour; a wait longer than a working day is a quota that has run out, which
 * is something the owner should hear about through the failure path rather
 * than discover as a task that quietly never ran.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * How many times one task may be parked by a rate limit before the next one
 * counts as a failure. A limit that lifts and immediately closes again five
 * times is not a limit being waited out, it is a loop.
 */
export const MAX_RATE_LIMIT_PARKS = 5;

export interface RunOutcome {
  status:
    /**
     * F5.11: another worker holds the task, or it is not currently claimable.
     *
     * An outcome of the attempt rather than a state of the task -- the task is
     * fine, this engine simply does not have it.
     */
    | 'not_claimed'
    /** F13.8: the role's runtime is not answering. The task went back. */
    | 'runtime_unavailable'
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

/**
 * The broker's refusals that mean "wait", not "no": the task parks on them
 * rather than failing, however the runtime reacted to being told.
 */
const PARKING_CODES: ReadonlySet<string> = new Set(['approval.required', 'owner.asked', 'review.required', 'window.closed']);

export class Engine {
  readonly #options: EngineOptions;
  readonly #workerId: string;

  readonly #adapters: AdapterRegistry;

  constructor(options: EngineOptions) {
    this.#options = options;
    this.#workerId = options.workerId ?? `worker-${randomUUID()}`;

    this.#adapters = options.adapters ?? new AdapterRegistry();
    if (options.handlers && options.llm && !this.#adapters.get('in-process')) {
      this.#adapters.register(
        new InProcessAdapter({ handlers: options.handlers, llm: options.llm }),
      );
    }
  }

  /** The runtimes this engine can employ. */
  get adapters(): AdapterRegistry {
    return this.#adapters;
  }

  /**
   * The hook pipeline (F14).
   *
   * The broker's, deliberately. One pipeline means a hook added for a company
   * applies at every point rather than only at the ones whose owner happened
   * to be handed it, and it removes the failure where two pipelines drift and
   * a rule is enforced on tools but not on runs.
   */
  get hooks(): HookPipeline {
    return this.#options.broker.hooks;
  }

  /** The identity this engine claims tasks under (F5.11). */
  get workerId(): string {
    return this.#workerId;
  }

  /**
   * What a role says about how it is executed (F2.3, F13.5, F13.6).
   *
   * Read per run rather than cached: a role's runtime is configuration the
   * owner may change, and a cache would mean the change takes effect whenever
   * the process happens to restart.
   */
  async #loadRuntimeConfig(companyId: string, roleId: string): Promise<{
    runtime: string;
    backend: ExecutionBackend;
    modelPrimary: string;
    modelFallback: string[];
    tools: string[];
    maxTokensPerRun: number;
  }> {
    return withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{
        runtime: string;
        backend: ExecutionBackend;
        model: string;
        model_primary: string | null;
        model_fallback: string[];
        tools: string[];
        max_tokens_per_run: number;
      }>(
        `SELECT runtime, backend, model, model_primary, model_fallback, tools,
                max_tokens_per_run
           FROM roles WHERE id = $1`,
        [roleId],
      );
      const row = rows[0];
      if (!row) throw new Error(`role ${roleId} not found`);
      return {
        runtime: row.runtime,
        backend: row.backend,
        // `model` predates `model_primary` and is still what most roles carry.
        // Preferring the newer column and falling back keeps both readable
        // without a migration that rewrites every role's model by guesswork.
        modelPrimary: row.model_primary ?? row.model,
        modelFallback: row.model_fallback,
        tools: row.tools,
        maxTokensPerRun: row.max_tokens_per_run,
      };
    });
  }

  /**
   * Assembles what the runtime is given (§7.5).
   *
   * Everything it needs and nothing it must not have: the tools arrive as
   * names, schemas and tiers, never as endpoints or credentials, and the
   * working memory is what this task already committed so a resumed run
   * continues rather than starting again (F4.7).
   */
  async #buildRunRequest(input: {
    companyId: string;
    task: TaskRow;
    roleSlug: string;
    runtime: {
      backend: ExecutionBackend;
      modelPrimary: string;
      modelFallback: string[];
      tools: string[];
      maxTokensPerRun: number;
    };
    agentRunId: string;
  }): Promise<RunRequest> {
    const { companyId, task, runtime } = input;

    const request = await withTenant(companyId, async (tx) => {
      const context = await buildContext(tx, {
        companyId,
        divisionId: task.divisionId,
        taskId: task.id,
      });
      const goalAncestry = await ancestryForTask(tx, task.id);

      const { rows: toolRows } = await tx.query<{
        name: string;
        input_schema: Record<string, unknown>;
        default_tier: number;
      }>(
        `SELECT name, input_schema, default_tier FROM capabilities
          WHERE name = ANY($1::text[]) ORDER BY name`,
        [runtime.tools],
      );

      const { rows: steps } = await tx.query<{ name: string; output: unknown }>(
        `SELECT name, output FROM task_steps
          WHERE task_id = $1 AND status = 'committed' ORDER BY step_index`,
        [task.id],
      );

      return {
        runId: input.agentRunId,
        task,
        roleSlug: input.roleSlug,
        contextPack: {
          charter: context.sections
            .filter((s) => s.kind === 'platform_charter' || s.kind === 'company_charter')
            .map((s) => s.body)
            .join('\n\n'),
          skills: context.sections.filter((s) => s.kind === 'sop').map((s) => s.body),
          memories: context.sections
            .filter((s) => s.kind === 'semantic_memory' || s.kind === 'confidence_warning')
            .map((s) => `${s.title}\n${s.body}`),
          goalAncestry,
          workingMemory: steps.map((row) => ({ name: row.name, output: row.output })),
        },
        allowedTools: toolRows.map((row) => ({
          name: row.name,
          inputSchema: row.input_schema,
          tier: row.default_tier,
        })),
        modelRouting: { primary: runtime.modelPrimary, fallback: runtime.modelFallback },
        backend: runtime.backend,
        limits: {
          tokens: runtime.maxTokensPerRun,
          // F6.4's deadline where the task has one; otherwise the lease, which
          // is the longest a worker may hold anything without saying so.
          wallClockMs: task.deadlineAt
            ? Math.max(0, task.deadlineAt.getTime() - Date.now())
            : DEFAULT_LEASE_MS,
        },
        dropped: context.dropped,
      };
    });

    // F14's `pre_compact`, at the moment F4.8 makes it necessary: the pack did
    // not fit and something was left out. An observation rather than a gate --
    // the trimming has happened and a refusal cannot un-happen it -- so this
    // is the hook's chance to write what mattered somewhere durable before the
    // run proceeds without it.
    if (request.dropped > 0) {
      await this.hooks.run('pre_compact', {
        companyId,
        projectId: task.projectId,
        taskId: task.id,
        roleId: task.roleId,
        divisionId: task.divisionId,
        output: { dropped: request.dropped },
      });
    }

    const { dropped: _dropped, ...runRequest } = request;
    return runRequest;
  }

  async runTask(companyId: string, taskId: string, roleSlug: string): Promise<RunOutcome> {
    const task = await withTenant(companyId, (tx) => getTask(tx, taskId));
    if (!task) throw new Error(`task ${taskId} not found`);

    // An ended task is reported, not run. A wake can hand over a task that
    // was claimed and then cancelled before its turn came, and running it
    // anyway spends a whole agent run -- side effects included -- on work the
    // owner stopped.
    if (isTerminal(task.status)) {
      return { status: task.status as RunOutcome['status'], reason: task.haltReason ?? 'already settled' };
    }

    const blocked = await this.#checkGuards(task);
    if (blocked) return blocked;

    // F5.11: claim it before running it. A pending task is claimed by the one
    // statement that also checks it can still be funded and its lane is free.
    // Anything further along -- claimed by this worker, or resumed after an
    // approval, a review or a window -- is adopted: the lease is taken only
    // if it is free, already ours, or expired, in one conditional write. The
    // old check read the lease and compared it here, so two workers resuming
    // one task could both find it free, and a task another worker had just
    // claimed ran twice.
    const leaseMs = this.#options.leaseMs ?? DEFAULT_LEASE_MS;
    if (task.status === 'pending') {
      const claim = await claimTask(companyId, { holder: this.#workerId, taskId, leaseMs });
      if (!claim) {
        return {
          status: 'not_claimed',
          reason:
            'another worker holds this task, its lane is busy, or its budget can no longer ' +
            'fund it',
        };
      }
    } else if (!(await adoptLease(companyId, taskId, this.#workerId, { leaseMs }))) {
      return {
        status: 'not_claimed',
        reason: task.leaseExpiresAt
          ? `another worker holds this task until ${task.leaseExpiresAt.toISOString()}`
          : 'another worker holds this task',
      };
    }

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

    if (
      ['checked_out', 'waiting_approval', 'waiting_review', 'waiting_window'].includes(task.status)
      || task.status === 'pending'
    ) {
      await transition(companyId, taskId, 'running');
    }

    // F9.5: non-urgent, read-only work waits for the company's cheap hours.
    //
    // Checked here rather than at admission for the same reason the kill
    // switch is re-read before every step: the window that was open when the
    // task was created may have closed by the time a worker picked it up, and
    // the decision that matters is the one taken at the moment the work would
    // actually run.
    if (task.batchable) {
      const now = new Date();
      const opensAt = await withTenant(companyId, async (tx) => {
        const window = await batchWindow(tx, companyId);
        // No window means this company has no cheap hours, so there is no
        // discount to wait for and the work runs immediately.
        if (!window || isWithin(window, now)) return null;
        return nextOpening(window, now);
      });

      // A window that never opens is a misconfiguration, and parking work
      // for ever is a worse answer to it than running the work now.
      if (opensAt) {
        await withTenant(companyId, async (tx) => {
          await appendEvent(tx, {
            companyId,
            projectId: task.projectId,
            taskId,
            type: 'task.batched',
            actor: 'engine',
            payload: { opensAt: opensAt.toISOString() },
          });
        });
        await transition(companyId, taskId, 'waiting_window', { waitUntil: opensAt });
        return { status: 'waiting_window', reason: 'waiting for cheap hours', waitUntil: opensAt };
      }
    }

    // F8.12: everything the role declares has to be usable before the task
    // starts. Checked after the cheap-hours check, because a task that is
    // about to park should not be probing external services, and before the
    // agent run, because starting one would spend tokens assembling context
    // for work that cannot succeed and leave a half-finished task behind.
    const readiness = await preflightForRole(
      this.#options.broker.registry,
      {
        companyId,
        divisionId: task.divisionId,
        // F8.12 is for the failure no retry fixes, and for most of the
        // catalogue that failure is the credential -- expired, revoked,
        // rotated to something the vendor no longer accepts. A preflight with
        // no way to resolve one could only check that a host answers, which is
        // the part that was never in doubt.
        credential: this.#options.broker.credentialFor(companyId, task.divisionId),
      },
      task.roleId,
    );
    if (!readiness.ready) {
      const named = readiness.failures.map((failure) => failure.capability).join(', ');
      await transition(companyId, taskId, 'halted', { haltReason: 'capability_unhealthy' });
      return {
        status: 'halted',
        // Halted rather than failed: a broken credential or an exhausted quota
        // does not get better by being asked again, and F8.12 is explicit that
        // this is an incident rather than a retry.
        reason: `capability preflight failed for ${named}`,
      };
    }

    // F13.1: which runtime executes this role, on what, with which models.
    const runtime = await this.#loadRuntimeConfig(companyId, task.roleId);
    const adapter = this.#adapters.get(runtime.runtime);
    if (!adapter) {
      // Loud rather than falling back to whatever is registered: running a
      // role on a runtime nobody chose for it is how a role calibrated for one
      // model quietly ends up on another.
      await transition(companyId, taskId, 'halted', { haltReason: 'runtime_unavailable' });
      return {
        status: 'halted',
        reason:
          `role ${roleSlug} names runtime ${runtime.runtime}, which is not registered ` +
          `(registered: ${this.#adapters.names().join(', ') || 'none'})`,
      };
    }

    // F13.8: a runtime that fails its health check receives no work. The task
    // goes back on the queue rather than halting -- an unreachable runtime is
    // usually a moment rather than a defect, and halting would turn a restart
    // into an inbox item.
    const health = await adapter.health();
    if (!health.ok) {
      await transition(companyId, taskId, 'pending');
      // The lease goes with it, as on the retryable path. A task on the queue
      // that still names a holder is the confusion leases exist to remove.
      await clearLease(companyId, taskId, this.#workerId);
      return {
        status: 'runtime_unavailable',
        reason: `runtime ${adapter.name} is not healthy: ${health.detail ?? 'no detail'}`,
      };
    }

    // F14: the pre_run point, immediately before the runtime is employed.
    // After the health check because an unhealthy runtime is not a refusal,
    // and before the agent run because a run that starts and is then refused
    // has already cost the tokens the refusal exists to save.
    const preRun = await this.hooks.run('pre_run', {
      companyId,
      projectId: task.projectId,
      taskId,
      roleId: task.roleId,
      divisionId: task.divisionId,
      input: task.input,
    });
    if (!preRun.allowed) {
      return this.#classifyFailure(
        companyId,
        taskId,
        new PalugadaError(preRun.code ?? 'hook.denied', preRun.reason!, { hook: preRun.refusedBy }),
      );
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

    // F5.12: the lease is kept while the run is in flight, not only when a
    // step commits. One step can be long -- a child task awaited, an agent CLI
    // thinking with no tool call to show for it -- and a lease renewed only at
    // commits lapsed in the middle of one, so another replica reclaimed the
    // task and ran it alongside this one.
    //
    // Bounded by the work's own limits rather than by the process being alive:
    // the lease is kept up to one lease past the last sign of progress, or up
    // to a deadline the run is waiting on. A handler stuck on a promise that
    // never settles stops being covered, its lease lapses, and the task goes
    // back to the queue -- which is what a lease is for.
    const lease = new LeaseKeeper({
      renew: () => this.#holdLease(companyId, taskId, agentRunId, leaseMs),
      onLost: () => controller.abort(),
      leaseMs,
      coverUntil: task.deadlineAt?.getTime() ?? Date.now() + leaseMs,
    });

    const step = async <T,>(name: string, kind: StepKind, input: unknown, fn: (key: string) => Promise<T>) => {
        const guard = await this.#checkGuards(task);
        if (guard) throw new PalugadaError('platform.stopped', guard.reason ?? 'halted', {});
        // Before the side effect, not only after it: a worker that has lost
        // the task must not send the email and then find out.
        await lease.confirm();
        const index = stepIndex++;
        const { value } = await runStep(
          { companyId, taskId },
          {
            stepIndex: index,
            name,
            kind,
            input,
            // Re-checked after the side effect and before the journal write.
            // Two things can have changed while the step was in flight, and
            // both must stop it being committed:
            //
            //   - The owner pressed stop (F5.8), so an in-flight external
            //     action must not become a committed step the task builds on.
            //   - The task itself is no longer running. Something ended it
            //     out from under this worker: a parent's awaitChild timeout,
            //     a freeze, a cancellation, another worker. Without this
            //     check the abandoned execution keeps going and keeps
            //     committing steps against a task the system considers
            //     finished -- spending budget, and potentially touching the
            //     outside world, on work nobody is waiting for any more.
            beforeCommit: async () => {
              if (await isStopAllRequested()) {
                controller.abort();
                throw new PalugadaError('platform.stopped', 'stop requested during step', {});
              }
              const current = await withTenant(companyId, (tx) => getTask(tx, taskId));
              if (!current || isTerminal(current.status)) {
                controller.abort();
                throw new PalugadaError(
                  'task.invalid_transition',
                  `task ended as ${current?.status ?? 'missing'} while a step was in flight`,
                  { taskId, status: current?.status ?? null },
                );
              }

              // F5.12, F5.14: a committed step is proof this worker is alive
              // and the work is moving, so it pushes the lease out and extends
              // how long the keeper may go on renewing it. A renewal that
              // finds the lease gone means another worker has the task, and
              // this step's result is not committed against it.
              await lease.confirm();
              lease.progressed();
            },
          },
          fn,
        );
        return value;
    };

    // The broker's answer when the task now waits on somebody: the owner for
    // an approval, a reviewer, or the clock for a window. An in-process
    // handler meets it as a throw that ends the run. A runtime in another
    // process is told it as a refused tool call and carries on -- and then
    // says `done`, and the engine used to try to complete a task that was
    // waiting for the owner, fail on the illegal move, and throw out of
    // `runTask` with the approval still open. So the first such answer is
    // kept, the run is withdrawn, and the task parks as it would have had
    // the throw ended it.
    let parked: PalugadaError | null = null;
    const callTool = async <I, O,>(name: string, input: I): Promise<O> => {
      try {
        return await step(`capability:${name}`, 'tool', { name, input }, async (key) => {
            const result = await this.#options.broker.invoke<I, O>(
              {
                companyId, projectId: task.projectId, divisionId: task.divisionId,
                taskId, roleId: task.roleId, idempotencyKey: key, signal: controller.signal,
              },
              name,
              input,
            );
          return result.output;
        });
      } catch (error) {
        if (!parked && error instanceof PalugadaError && PARKING_CODES.has(error.code)) {
          parked = error;
          controller.abort();
        }
        throw error;
      }
    };

    const awaitChild = async (
      childRoleSlug: string,
      childInput: Record<string, unknown>,
      childOptions: { timeoutMs: number; reserveTokens?: number },
    ): Promise<ChildResult> => {
        if (!Number.isFinite(childOptions.timeoutMs) || childOptions.timeoutMs <= 0) {
          throw new Error('awaitChild requires a positive timeoutMs (PRD F6.4)');
        }

      return step(
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
            // `createSubTask` returns the child this parent already started
            // for this role and input, so a parent retried or resumed picks
            // its child back up rather than starting a second one.
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

            // The child's own deadline, as written when it was first created: a
            // parent resumed an hour later does not restart the child's clock.
            // The parent does nothing while it waits and is alive for all of
            // it, so its lease is covered until then.
            const deadline = child.deadlineAt?.getTime() ?? Date.now() + childOptions.timeoutMs;
            lease.cover(deadline);

            let timer: LongTimer | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
              timer = setLongTimeout(
                () => reject(new PalugadaError('deadline.exceeded', `child ${childRoleSlug} timed out`, {
                  childTaskId: child.id,
                  timeoutMs: childOptions.timeoutMs,
                })),
                deadline - Date.now(),
              );
            });

            try {
              const outcome = await Promise.race([
                this.#driveChild(companyId, child.id, childRoleSlug, controller.signal),
                timeout,
              ]);
              if (outcome.status !== 'completed') {
                throw new PalugadaError(
                  'task.invalid_transition',
                  `child ${childRoleSlug} ended as ${outcome.status}`,
                  { childTaskId: child.id, status: outcome.status, reason: outcome.reason },
                );
              }
              // F6.7: the parent receives an answer and a summary, and not the
              // child's transcript. The child's own record is where its
              // reasoning stays.
              const steps = await withTenant(companyId, async (tx) => {
                const { rows } = await tx.query<{ count: string }>(
                  'SELECT count(*)::text AS count FROM task_steps WHERE task_id = $1',
                  [child.id],
                );
                return Number(rows[0]!.count);
              });
              return containChildResult(childRoleSlug, outcome.output ?? {}, {
                status: outcome.status,
                steps,
                costCents: 0,
              });
            } catch (error) {
              // Only the deadline this parent enforces halts the child, and
              // says so. A child that ended on its own terms already has its
              // outcome; one this parent stopped waiting for because the
              // parent itself was stopped carries on under its own lease.
              if (isPalugadaError(error, 'deadline.exceeded')) {
                const current = await withTenant(companyId, (tx) => getTask(tx, child.id));
                if (current && !isTerminal(current.status)) {
                  await transition(companyId, child.id, 'halted', { haltReason: 'deadline_passed' });
                }
              }
              throw error;
            } finally {
              timer?.clear();
            }
          },
      );
    };

    // What this run has put on the company's account so far, estimates and
    // measurements alike, so a runtime's final total can replace it.
    let chargedCents = 0;

    const reportUsage: RunServices['reportUsage'] = async (reported) => {
      // Checked again here whatever the source: this is the accounting
      // authority, and a negative figure from anywhere is a way to erase
      // spend rather than report it.
      const usage = checkUsage(reported);
      // A model call is progress, and for an agent CLI it is often the only
      // sign of it between tool calls.
      lease.progressed();

      // The provider's own bill for the run. It replaces what the estimates
      // charged rather than adding to it, and settles in either direction --
      // through the same chain-wide settlement a capability's actual cost
      // uses (0037), because an adjustment that reached only the leaf account
      // is how a company's ledger stops agreeing with its divisions'.
      //
      // And as a trace of its own (0043), so the figures that read traces --
      // the monthly pause, the daily alert, the circuit breaker, the reports
      // -- see the bill rather than the estimate it replaced.
      if (usage.runTotal) {
        const actual = Math.ceil(usage.costCents!);
        const delta = actual - chargedCents;
        await withTenant(companyId, async (tx) => {
          if (delta !== 0) {
            await tx.query('SELECT app.budget_settle($1, $2)', [task.budgetAccountId, delta]);
            await tx.query(
              `INSERT INTO llm_traces (id, company_id, task_id, agent_run_id, model, kind,
                                       input_tokens, output_tokens, cost_cents)
               VALUES ($1, $2, $3, $4, $5, 'settlement', 0, 0, $6)`,
              [randomUUID(), companyId, taskId, agentRunId, usage.model, delta],
            );
          }
          await appendEvent(tx, {
            companyId,
            projectId: task.projectId,
            taskId,
            type: 'cost.settled',
            actor: 'engine',
            payload: { model: usage.model, chargedCents, actualCents: actual, deltaCents: delta },
          });
        });
        chargedCents = actual;
        return;
      }

      // F13.7: a runtime that cannot say what a call cost gets an estimate,
      // and the estimate is marked as one. Reporting a guess as a measurement
      // is how a cost dashboard stops being worth reading.
      const estimate = usage.costCents === null
        ? estimateCents(
            this.#options.prices ?? DEFAULT_PRICE_TABLE,
            usage.model, usage.inputTokens, usage.outputTokens,
          )
        : null;
      const estimated = estimate !== null;
      // Whole cents, rounded up. A runtime may price a call at a fraction of
      // one, and the ledger, the budget functions and the trace all count in
      // cents: a fraction reached `budget_spend` as "0.4" and the run failed
      // on a bigint cast. Up rather than to nearest, because the error is a
      // cent at most per call and a ceiling should be the side that is
      // reached early, not late.
      const costCents = usage.costCents === null ? estimate!.cents : Math.ceil(usage.costCents);

      // Drawn from this task's own reservation, by what is left of it, in the
      // same transaction as the charge. Every call used to hand in the whole
      // reservation as it stood at the start of the run: each one took up to
      // that much off the chain's reserved total, the task row never went
      // down, and the terminal release took it off again -- so a task that
      // made three calls erased its siblings' reservations and admission
      // control let in work the budget could not fund.
      //
      // The trace is written in the same transaction as the charge, and
      // whether or not the charge was allowed: the call has happened and the
      // provider will bill for it, so a refusal stops the next call, not the
      // record of this one. Two transactions left a crash between them with
      // money charged and no trace saying what for.
      const tokens = usage.inputTokens + usage.outputTokens;
      const funded = await withTenant(companyId, async (tx) => {
        const { rows } = await tx.query<{ reserved: string }>(
          'SELECT tokens_reserved AS reserved FROM tasks WHERE id = $1 FOR NO KEY UPDATE',
          [taskId],
        );
        const drawn = Math.min(Number(rows[0]?.reserved ?? 0), tokens);
        const ok = await budget.spend(tx, task.budgetAccountId, {
          tokens,
          moneyCents: costCents,
          fromReservation: drawn,
        });
        if (ok && drawn > 0) {
          await tx.query('UPDATE tasks SET tokens_reserved = tokens_reserved - $2 WHERE id = $1', [
            taskId,
            drawn,
          ]);
        }

        // F11.1: every model call is traced through the adapter. The engine
        // never made the call, so this is the only record there will be of it.
        await tx.query(
          `INSERT INTO llm_traces (id, company_id, task_id, agent_run_id, model,
                                   prompt, response, input_tokens, output_tokens,
                                   cost_cents, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
          [
            randomUUID(),
            companyId,
            taskId,
            agentRunId,
            usage.model,
            usage.prompt === undefined ? null : JSON.stringify(usage.prompt),
            usage.response === undefined ? null : JSON.stringify(usage.response),
            usage.inputTokens,
            usage.outputTokens,
            costCents,
            usage.latencyMs ?? null,
          ],
        );
        if (estimated) {
          await appendEvent(tx, {
            companyId,
            projectId: task.projectId,
            taskId,
            type: 'cost.estimated',
            actor: 'engine',
            payload: {
              model: usage.model,
              tokens,
              cents: costCents,
              // Which row of the price table priced it, or `fallback`: an owner
              // reading an estimate needs to know whether it came from their
              // own price list or from the deliberately high default.
              basis: estimate!.basis,
            },
          });
        }
        return ok;
      });
      if (!funded) {
        throw new PalugadaError('budget.exceeded', 'shared budget exhausted', {
          budgetAccountId: task.budgetAccountId,
        });
      }
      chargedCents += costCents;
    };


    const services: RunServices = {
      step,
      callTool,
      awaitChild,
      reportUsage,
      signal: controller.signal,
    };

    lease.start();
    try {
      const { output } = await this.#runWithFallback(
        adapter,
        {
          companyId, task, roleSlug, runtime, agentRunId,
          startAttempt: () => {
            stepIndex = 0;
            chargedCents = 0;
          },
        },
        services,
      );
      // Whatever the runtime produced after being told to wait is not the
      // task's output: the action it was waiting for has not happened.
      if (parked) throw parked;
      // F6.2, F6.3: validated before the task is marked complete, because a
      // downstream task triggered by `task.completed` has no other guarantee
      // about what it is about to read.
      validateContract('output', task.roleId, roleSlug, contract.output, output);

      // F14: the post_run point. After the schema, because a hook asked to
      // judge an output should be given one that is at least the right shape,
      // and before the task is marked complete, because completion is what
      // wakes everything downstream.
      const postRun = await this.hooks.run('post_run', {
        companyId,
        projectId: task.projectId,
        taskId,
        roleId: task.roleId,
        divisionId: task.divisionId,
        input: task.input,
        output,
      });
      if (!postRun.allowed) {
        throw new PalugadaError(postRun.code ?? 'hook.denied', postRun.reason!, {
          hook: postRun.refusedBy,
        });
      }

      await this.#finishAgentRun(companyId, agentRunId, 'succeeded');

      // An abandoned run can still arrive here: its caller gave up, something
      // ended the task, and the handler finished anyway. The task's recorded
      // outcome wins -- overwriting it would let a run nobody is waiting for
      // resurrect itself as completed.
      const settled = await withTenant(companyId, (tx) => getTask(tx, taskId));
      if (settled && isTerminal(settled.status)) {
        return { status: settled.status as RunOutcome['status'], reason: settled.haltReason ?? 'already settled' };
      }

      await transition(companyId, taskId, 'completed', { output });
      return { status: 'completed', output };
    } catch (error) {
      await this.#finishAgentRun(companyId, agentRunId, 'failed');
      // A worker that lost the task does not get to say how it went: the
      // attempt, the status and the lease are the new holder's now.
      if (lease.lost) {
        return { status: 'not_claimed', reason: 'the lease was lost while the run was in flight' };
      }
      // The run may have ended on something else by the time it stopped --
      // the runtime reacting to the withdrawal, or failing on its own -- but
      // the reason it stopped is the wait.
      return this.#classifyFailure(companyId, taskId, parked ?? error, agentRunId);
    } finally {
      lease.stop();
    }
  }

  /**
   * Runs a child task to its end, or waits for whoever is running it.
   *
   * A child is an ordinary task. A retryable failure puts it back on the
   * queue, an approval parks it, another replica's claim loop may pick it up
   * first -- and none of those is the child's end. The parent used to treat
   * the first outcome that was not `completed` as final and halt the child
   * with the reason "deadline passed", so one transient failure in a child
   * cost the parent its whole delegation. What bounds the wait is the
   * parent's deadline, raced against this by the caller.
   *
   * A child parked for the owner is only watched: running it would resume it
   * past the decision it is waiting for.
   */
  async #driveChild(
    companyId: string,
    childId: string,
    roleSlug: string,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    for (;;) {
      if (signal.aborted) {
        throw new PalugadaError('platform.stopped', 'the parent stopped waiting for its child', {
          childTaskId: childId,
        });
      }
      const child = await withTenant(companyId, (tx) => getTask(tx, childId));
      if (!child) return { status: 'cancelled', reason: 'the child task no longer exists' };
      if (isTerminal(child.status)) {
        return {
          status: child.status as RunOutcome['status'],
          reason: child.haltReason ?? child.status,
          ...(child.output ? { output: child.output } : {}),
        };
      }
      if (child.status === 'waiting_approval' || child.status === 'waiting_review') {
        await sleep(CHILD_POLL_MS, signal);
        continue;
      }

      const outcome = await this.runTask(companyId, childId, roleSlug);
      if (outcome.status === 'completed' || outcome.status === 'halted'
        || outcome.status === 'cancelled') {
        return outcome;
      }
      if (outcome.status === 'failed' && outcome.reason !== 'retryable') return outcome;
      // Retried at once when it failed and may try again; otherwise it is
      // held elsewhere, parked, or its runtime is down, and is looked at again
      // shortly.
      if (outcome.status !== 'failed') await sleep(CHILD_POLL_MS, signal);
    }
  }

  /**
   * Renews this worker's lease and marks the run as breathing, or throws
   * `task.lease_lost` when the lease is no longer this worker's.
   */
  async #holdLease(companyId: string, taskId: string, agentRunId: string, leaseMs: number): Promise<void> {
    const renewed = await renewLease(companyId, taskId, this.#workerId, { leaseMs });
    if (!renewed) {
      throw new PalugadaError(
        'task.lease_lost',
        `worker ${this.#workerId} no longer holds task ${taskId}`,
        { taskId, workerId: this.#workerId },
      );
    }
    await withTenant(companyId, (tx) => recordRunHeartbeat(tx, agentRunId));
  }

  /**
   * Parks a rate-limited task until its limit lifts, or says it will not.
   *
   * Null when the wait is unusable -- no time, a time beyond
   * `MAX_RATE_LIMIT_WAIT_MS`, or a task that has already been parked
   * `MAX_RATE_LIMIT_PARKS` times -- and the caller falls through to the
   * ordinary failure path.
   */
  async #parkForRateLimit(
    companyId: string,
    taskId: string,
    error: PalugadaError,
  ): Promise<RunOutcome | null> {
    const raw = error.details.notBefore;
    const notBefore = typeof raw === 'string' ? new Date(raw) : null;
    const now = Date.now();
    if (!notBefore || !Number.isFinite(notBefore.getTime())) return null;
    if (notBefore.getTime() - now > MAX_RATE_LIMIT_WAIT_MS) return null;

    const parks = await withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM events WHERE task_id = $1 AND type = 'task.rate_limited'",
        [taskId],
      );
      return Number(rows[0]!.count);
    });
    if (parks >= MAX_RATE_LIMIT_PARKS) return null;

    const waitUntil = new Date(Math.max(notBefore.getTime(), now + 1_000));
    await withTenant(companyId, async (tx) => {
      await appendEvent(tx, {
        companyId,
        taskId,
        type: 'task.rate_limited',
        actor: 'engine',
        payload: {
          capability: error.details.capability ?? error.details.name ?? null,
          source: error.details.source ?? 'grant',
          waitUntil: waitUntil.toISOString(),
          park: parks + 1,
        },
      });
    });
    await transition(companyId, taskId, 'waiting_window', { waitUntil });
    return { status: 'waiting_window', reason: 'capability.rate_limited', waitUntil };
  }

  /**
   * Maps a thrown failure onto the state machine.
   *
   * The distinction that matters is `failed` versus `halted`: a failure may be
   * retried, while a halt is terminal and becomes an owner inbox item. Budget,
   * hop, deadline and a failed read-back all halt, because retrying any of
   * them would either overspend or repeat an unverified write.
   */
  async #classifyFailure(
    companyId: string,
    taskId: string,
    error: unknown,
    agentRunId?: string,
  ): Promise<RunOutcome> {
    const code = error instanceof PalugadaError ? error.code : null;

    // Nothing to classify if the task already has an outcome, or has gone
    // entirely. Both are the abandoned-run path: a caller gave up, the task
    // was settled or removed, and the handler carried on to its own end. The
    // recorded outcome wins, and a run whose task no longer exists writes
    // nothing at all -- an event referring to a task that is not there is not
    // an audit record, it is noise that trains people to ignore the log.
    const settled = await withTenant(companyId, (tx) => getTask(tx, taskId));
    if (!settled) {
      return { status: 'cancelled', reason: 'task no longer exists' };
    }
    if (isTerminal(settled.status)) {
      return {
        status: settled.status as RunOutcome['status'],
        reason: settled.haltReason ?? (error as Error).message,
      };
    }

    // Both leave the task in `waiting_approval` with an item open: the broker
    // parked it for the owner's yes, `owner.ask` for their answer.
    if (code === 'approval.required' || code === 'owner.asked') {
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

    // "Not now" from a vendor, or from the division's own hourly allowance, is
    // F9.2's case exactly: the action is permitted, just not at this moment.
    // Retried as a failure it spent the task's attempts on the next few ticks,
    // against a limit that had not lifted, and the task failed for having
    // been patient in the wrong way. Parked, it waits for the time the limit
    // gave and resumes from its journal.
    //
    // Bounded, because the vendor is the one saying when: one that answers
    // 429 for ever, or names a wait of a week, would otherwise hold the task
    // indefinitely with nothing failing to say so. Past the bound it is an
    // ordinary failure and goes through attempts to the owner like one.
    if (code === 'capability.rate_limited') {
      const parked = await this.#parkForRateLimit(companyId, taskId, error as PalugadaError);
      if (parked) return parked;
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
        | 'verification_failed' | 'cycle_detected' | 'runtime_unavailable'
        | 'journal_divergence'
    > = {
      // F13.6: every model the role names has failed, or the role may act
      // irreversibly and the engine refused to substitute one. Either way the
      // incident is already raised and another attempt would reach the same
      // provider.
      'model.unavailable': 'runtime_unavailable',
      // A denial is terminal rather than retryable: the same call would be
      // refused again, and retrying it only burns the attempt budget.
      'policy.denied': 'policy_denied',
      // A hook that refused is a rule that will refuse again. Retrying it
      // spends attempts to reach the same answer.
      'hook.denied': 'policy_denied',
      // F1.7: the month's ceiling is not reached again by trying harder.
      'spend.paused': 'budget_exhausted',
      'budget.exceeded': 'budget_exhausted',
      'budget.reservation_refused': 'budget_exhausted',
      'hop.exceeded': 'hop_limit',
      'deadline.exceeded': 'deadline_passed',
      'capability.verify_failed': 'verification_failed',
      'cycle.detected': 'cycle_detected',
      // The journal holds a different step where this one should be. A retry
      // replays the same journal and meets the same mismatch.
      'journal.divergence': 'journal_divergence',
    };

    const haltReason = code ? haltCodes[code] : undefined;
    if (haltReason) {
      await transition(companyId, taskId, 'halted', { haltReason });
      await this.#onHalt(companyId, settled, haltReason, error, agentRunId);
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
      await this.#onHalt(companyId, settled, 'attempts_exhausted', error, agentRunId);
      return { status: 'failed', reason: (error as Error).message };
    }
    // Back on the queue, and the lease released with it.
    //
    // Without this the task stays `running` holding a lease nobody is working,
    // and `claimTask` only claims `pending` -- so the retry does not happen
    // when the next worker comes round, it happens when the lease expires,
    // half an hour later. `attempt_max` of three would mean three attempts
    // spread over an hour and a half, which is not what anybody reading
    // `attempt_max` expects. The first real boot of this platform found it.
    await transition(companyId, taskId, 'pending');
    await clearLease(companyId, taskId, this.#workerId);
    return { status: 'failed', reason: 'retryable' };
  }

  /**
   * F13.6: model routing, and the one case where falling back is not allowed.
   *
   * A provider that is down is a fact about the world rather than about the
   * work, so for a role whose tools are all tier 0 or 1 the engine retries on
   * the next model in the role's list. The run starts again from the top --
   * the model changed, so nothing it said before is worth resuming from -- and
   * the substitution is recorded, because "which model did this" has to remain
   * answerable afterwards.
   *
   * A role that can take a tier 2 action does not get that. Tier 2 is the
   * threshold at which an action changes something outside the company and
   * cannot be undone, and the PRD's word for the alternative is *silently*:
   * quietly running an irreversible action on a model the owner did not choose
   * and did not calibrate the role for. So the run halts and the owner is told,
   * which is slower and is the point.
   *
   * The same rule applies once a task has actually taken a tier 2 action, even
   * for a role whose remaining tools are harmless: half of an irreversible
   * sequence performed by one model and half by another is a worse outcome than
   * a halt, and much harder to reason about afterwards.
   */
  async #runWithFallback(
    adapter: Adapter,
    input: {
      companyId: string;
      task: TaskRow;
      roleSlug: string;
      runtime: {
        backend: ExecutionBackend;
        modelPrimary: string;
        modelFallback: string[];
        tools: string[];
        maxTokensPerRun: number;
      };
      agentRunId: string;
      /**
       * Starts the next model's run from zero, in both of the things counted
       * per run.
       *
       * Steps: the run starts the handler from the top, so its steps are the
       * same steps -- identical ones replay what the first model already did,
       * and the rest run. The count used to carry on from wherever the failed
       * run stopped, so the fallback's first step was journalled at the index
       * of the failed run's last, and the next retry handed each step the
       * output recorded for a different one.
       *
       * Charges: a runtime's final total is the bill for its own run. Counted
       * across attempts, the fallback's total replaced what the failed run's
       * estimates had charged as well as its own, and the failed run's calls
       * -- which the provider billed -- came off the ledger.
       */
      startAttempt: () => void;
    },
    services: RunServices,
  ): Promise<AdapterResult> {
    const { companyId, task, runtime } = input;
    const models = [runtime.modelPrimary, ...runtime.modelFallback];

    for (const [index, model] of models.entries()) {
      if (index > 0) input.startAttempt();
      const request = await this.#buildRunRequest({
        ...input,
        runtime: { ...runtime, modelPrimary: model },
      });

      try {
        return await adapter.run(request, services);
      } catch (error) {
        if (!(error instanceof ProviderFailure)) throw error;

        const irreversible = await this.#mayActIrreversibly(companyId, task, request);
        const last = index === models.length - 1;

        if (irreversible || last) {
          await withTenant(companyId, async (tx) => {
            await appendEvent(tx, {
              companyId,
              projectId: task.projectId,
              taskId: task.id,
              type: 'model.fallback_refused',
              actor: 'engine',
              payload: {
                model,
                reason: irreversible ? 'tier_2_or_above' : 'no_fallback_left',
                remaining: models.slice(index + 1),
              },
            });
          });
          await inbox.raiseIncident({
            companyId,
            taskId: task.id,
            title: `Model ${model} failed and the run was not moved`,
            detail: irreversible
              ? `${error.message} This role can take actions that cannot be undone, so the ` +
                'run was not silently retried on a different model.'
              : `${error.message} No fallback model is left for this role.`,
          });
          throw new PalugadaError('model.unavailable', error.message, {
            model,
            fellBack: false,
            reason: irreversible ? 'tier_2_or_above' : 'no_fallback_left',
          });
        }

        const next = models[index + 1]!;
        await withTenant(companyId, async (tx) => {
          await appendEvent(tx, {
            companyId,
            projectId: task.projectId,
            taskId: task.id,
            type: 'model.fell_back',
            actor: 'engine',
            payload: { from: model, to: next, reason: error.message },
          });
        });
      }
    }

    // Unreachable: the last iteration either returns or throws above. Present
    // because a loop that can fall out of its end should say what that means
    // rather than returning undefined.
    throw new PalugadaError('model.unavailable', 'no model produced a run', {
      models,
    });
  }

  /**
   * Whether this run could still do something that cannot be undone.
   *
   * Two questions, and either one is enough: can the role reach a tier 2 tool
   * at all, and has this task already taken such an action. The first is read
   * from the request the runtime was about to be given, so it reflects what
   * was actually permitted rather than what a role row said at some other
   * moment.
   */
  async #mayActIrreversibly(
    companyId: string,
    task: TaskRow,
    request: RunRequest,
  ): Promise<boolean> {
    if (request.allowedTools.some((tool) => tool.tier >= 2)) return true;

    return withTenant(companyId, async (tx) => {
      const { rows } = await tx.query<{ taken: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM events
            WHERE task_id = $1
              AND type = 'tool.called'
              AND (payload->>'tier')::int >= 2
         ) AS taken`,
        [task.id],
      );
      return rows[0]?.taken ?? false;
    });
  }

  /**
   * F14's `on_halt` point.
   *
   * An observation rather than a gate: the task has already ended, so there is
   * nothing left for a refusal to prevent and the verdict is ignored. It exists
   * so that raising an inbox item or an incident on a halt is something a
   * company can add without editing the engine -- which is the whole argument
   * for hooks, applied to the one point where the argument is easiest to
   * forget.
   */
  async #onHalt(
    companyId: string,
    task: TaskRow,
    reason: string,
    error: unknown,
    agentRunId?: string,
  ): Promise<void> {
    await this.hooks.run('on_halt', {
      companyId,
      projectId: task.projectId,
      taskId: task.id,
      roleId: task.roleId,
      divisionId: task.divisionId,
      input: task.input,
      output: { reason, error: (error as Error).message },
    });

    // F17.4: a run that ended badly becomes a negative eval candidate. It is a
    // candidate rather than a case -- whether the role is judged against it is
    // still somebody's decision -- but it is written down without being asked,
    // because the failures worth remembering are exactly the ones nobody feels
    // like recording afterwards.
    if (agentRunId) {
      try {
        await proposeNegativeCase(companyId, agentRunId, reason);
      } catch {
        // The halt is already recorded and returned. Failing to keep a
        // regression case must not turn a classified failure into an
        // unclassified one.
      }
    }
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
         -- The same attempt resumed -- after an approval, a review, a window
         -- -- is a run starting now. Keeping the first start's timestamps made
         -- a run that had waited half an hour look orphaned before its first
         -- step, and the sweep took its task back.
         ON CONFLICT (task_id, attempt) DO UPDATE
           SET status = 'running', started_at = now(), last_heartbeat_at = now(),
               finished_at = NULL
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
