/**
 * Lifecycle hooks (PRD v2 F14, F3.12).
 *
 * Principle 12: enforcement lives in hooks, knowledge lives in skills, and a
 * rule that must be obeyed may not live only in a prompt. A hook is
 * deterministic code the engine runs at a fixed point; a runtime cannot skip
 * one because a runtime never gets the chance to -- the hook runs on this side
 * of the adapter boundary, where the runtime has no reach (F14.1).
 *
 * Three properties, and the third is the one that makes the other two worth
 * having.
 *
 * **Built-in hooks cannot be removed (F14.2).** They are constructed with the
 * pipeline and there is no method that takes one away. A company or a division
 * may add hooks; the only thing an added hook can do is refuse.
 *
 * **An added hook may only tighten.** It is asked after the built-ins and its
 * `allow` is not a vote -- it is the absence of an objection. Nothing in the
 * pipeline can turn a denial into permission, so "add a hook" is never a way
 * to widen anything, which is the same rule F3.5 states for policy scopes.
 *
 * **A denial is recorded with its reason (F14.3).** Every refusal appends an
 * event naming the hook and why. Allows are summarised on the event the gate
 * already writes rather than each producing one of their own: section 9 budgets
 * a million events a month, and an event per hook per tool call would spend
 * most of it saying that nothing happened. The deviation is deliberate and is
 * recorded in docs/STATUS.md rather than left for someone to notice.
 *
 * Two of the six points are observations rather than gates. `pre_compact` runs
 * while working memory is being summarised and `on_halt` runs after a task has
 * already ended; there is nothing left for a refusal to prevent, so the caller
 * runs them for their effect and ignores the verdict. A refusal there is still
 * recorded, because a hook that objected and was overruled is exactly the thing
 * an audit log should be able to show.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withTenant } from '../db/tenant.ts';
import type { ErrorCode } from '../errors.ts';
import { isCompanyFrozen, isStopAllRequested } from './control.ts';
import { isSpendPaused } from '../governance/spend-guard.ts';
import { redactor } from '../secrets/manager.ts';

export type HookName =
  | 'pre_run'
  | 'pre_tool'
  | 'post_tool'
  | 'post_run'
  | 'pre_compact'
  | 'on_halt';

export interface HookContext {
  companyId: string;
  projectId?: string | undefined;
  taskId?: string | undefined;
  roleId?: string | undefined;
  divisionId?: string | undefined;
  /** Set at the tool hooks. */
  capability?: string | undefined;
  tier?: number | undefined;
  input?: unknown;
  output?: unknown;
}

export type HookVerdict =
  | { allow: true }
  /**
   * `code` lets a hook keep the failure code the caller's error contract
   * already promises -- F2.4's `capability.not_granted`, F1.7's `spend.paused`.
   * A hook with nothing better to say falls back to `hook.denied`.
   */
  | { allow: false; reason: string; code?: ErrorCode };

export interface Hook {
  readonly name: string;
  readonly on: HookName;
  run(ctx: HookContext): Promise<HookVerdict>;
}

export interface HookOutcome {
  allowed: boolean;
  /** Which hooks were consulted, in order. */
  consulted: string[];
  /** The hook that refused, if one did. */
  refusedBy?: string;
  reason?: string;
  code?: ErrorCode;
}

/**
 * The hooks that run at each point, built-in first.
 *
 * `builtIn` is set once at construction. There is deliberately no `remove`:
 * F14.2 says a company cannot disable a built-in hook, and the cheapest way to
 * guarantee that is not to write the method.
 */
export class HookPipeline {
  readonly #builtIn = new Map<HookName, Hook[]>();
  readonly #added = new Map<HookName, Hook[]>();

  constructor(builtIn: Hook[] = builtInHooks()) {
    for (const hook of builtIn) {
      const list = this.#builtIn.get(hook.on) ?? [];
      list.push(hook);
      this.#builtIn.set(hook.on, list);
    }
  }

  /** Adds a hook that may refuse and may not permit. */
  add(hook: Hook): void {
    const list = this.#added.get(hook.on) ?? [];
    list.push(hook);
    this.#added.set(hook.on, list);
  }

  /** The names consulted at a point, built-in first. */
  hooksFor(on: HookName): string[] {
    return [
      ...(this.#builtIn.get(on) ?? []).map((hook) => hook.name),
      ...(this.#added.get(on) ?? []).map((hook) => hook.name),
    ];
  }

  /** True when the named hook is one a company cannot take away. */
  isBuiltIn(on: HookName, name: string): boolean {
    return (this.#builtIn.get(on) ?? []).some((hook) => hook.name === name);
  }

  /**
   * Runs the point and returns the first refusal, or permission.
   *
   * Short-circuits on the first denial. Running the rest would gather more
   * reasons for a decision that has already been made, and the caller only
   * ever reports one.
   */
  async run(on: HookName, ctx: HookContext): Promise<HookOutcome> {
    const consulted: string[] = [];

    for (const hook of [...(this.#builtIn.get(on) ?? []), ...(this.#added.get(on) ?? [])]) {
      consulted.push(hook.name);

      let verdict: HookVerdict;
      try {
        verdict = await hook.run(ctx);
      } catch (error) {
        // A hook that throws has refused. Reading a thrown error as permission
        // would mean the easiest way past a gate is to break it.
        verdict = { allow: false, reason: `hook threw: ${(error as Error).message}` };
      }

      if (!verdict.allow) {
        await this.#recordRefusal(on, hook.name, ctx, verdict.reason);
        return {
          allowed: false,
          consulted,
          refusedBy: hook.name,
          reason: verdict.reason,
          ...(verdict.code ? { code: verdict.code } : {}),
        };
      }
    }

    return { allowed: true, consulted };
  }

  async #recordRefusal(
    on: HookName,
    hookName: string,
    ctx: HookContext,
    reason: string,
  ): Promise<void> {
    try {
      await withTenant(ctx.companyId, async (tx) => {
        await appendEvent(tx, {
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          type: `hook.${on}`,
          actor: 'engine',
          payload: {
            hook: hookName,
            decision: 'deny',
            reason: redactor.redact(reason),
            ...(ctx.capability ? { capability: ctx.capability } : {}),
            ...(ctx.tier === undefined ? {} : { tier: ctx.tier }),
          },
        });
      });
    } catch {
      // The refusal itself is the answer to the caller's question and it is
      // about to be returned. Failing to write the note must not turn a denial
      // into an exception the caller never expected -- that would be a hook
      // failure quietly reopening the gate it exists to close.
    }
  }
}

/**
 * The hooks the platform installs and a company cannot remove (F14.2).
 *
 * These are the conditions under which nothing at all should run: the owner
 * has stopped the platform, has frozen this company, or the company has spent
 * its month. Each of them used to sit inline in the broker; they are hooks now
 * so that there is one list to read when asking what always applies, and so
 * that the guarantee is structural rather than a matter of remembering to copy
 * the check into the next caller.
 *
 * The broker's own gate chain -- kill switch, grant, rate limit, tier, policy,
 * plan, batch guard -- stays inline. It is one ordered read inside a single
 * transaction where each gate consumes what the one before it computed, and
 * splitting it into independent hooks would buy names at the price of the
 * atomic read. It is no less built-in for that: it is engine code on this side
 * of the adapter boundary, which is what F14.1 asks for. docs/STATUS.md records
 * the choice.
 */
export function builtInHooks(): Hook[] {
  return [
    ...crossPoint('pre_run', ['pre_tool']),
    {
      name: 'secret.leak',
      on: 'post_tool',
      async run(ctx) {
        return redactor.leaks(ctx.output)
          ? {
              allow: false,
              reason:
                `output of ${ctx.capability ?? 'the capability'} contains a credential verbatim`,
            }
          : { allow: true };
      },
    },
    {
      name: 'secret.leak',
      on: 'post_run',
      async run(ctx) {
        return redactor.leaks(ctx.output)
          ? { allow: false, reason: 'run output contains a credential verbatim' }
          : { allow: true };
      },
    },
  ];
}

/** The three global stops, installed at every point that can still be stopped. */
function crossPoint(first: HookName, rest: HookName[]): Hook[] {
  const hooks: Hook[] = [];
  for (const on of [first, ...rest]) {
    hooks.push(
      {
        name: 'platform.stop',
        on,
        async run() {
          return (await isStopAllRequested())
            ? { allow: false, reason: 'platform stop is in effect', code: 'platform.stopped' }
            : { allow: true };
        },
      },
      {
        name: 'company.freeze',
        on,
        async run(ctx) {
          return (await isCompanyFrozen(ctx.companyId))
            ? { allow: false, reason: 'company is frozen', code: 'company.frozen' }
            : { allow: true };
        },
      },
      {
        // F1.7. Beside the freeze rather than folded into it, because "you
        // stopped this" and "it ran out of money" need different answers and
        // different remedies.
        name: 'spend.guard',
        on,
        async run(ctx) {
          return (await isSpendPaused(ctx.companyId))
            ? {
                allow: false,
                reason: 'company has reached its monthly spending ceiling',
                code: 'spend.paused',
              }
            : { allow: true };
        },
      },
    );
  }
  return hooks;
}
