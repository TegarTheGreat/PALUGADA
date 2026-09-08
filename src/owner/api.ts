/**
 * The owner's console, as an HTTP API (PRD v2 F10, F12.5).
 *
 * Section 5 principle 1 gives this platform one human interface: an inbox of
 * decisions. Everything up to now built the decisions and the rules about
 * them, and left the surface for later -- which meant a platform whose entire
 * point is "one person runs many companies" had no way for that person to say
 * yes. This is that way.
 *
 * No framework, no build step, and the same `node:http` the tool bridge
 * already uses. It stayed at nine routes for a while and that was not
 * restraint, it was a gap: a reachability scan found around fifty owner
 * operations this platform implements, tests, and enforces in the database,
 * with no way for the one human here to invoke any of them. The spend ceiling
 * could not be set. A credential could not be rotated. An agent's question
 * could not be answered.
 *
 * So it is larger now, and the discipline that kept it small still holds:
 * every route is a place where a request could reach a company's data or take
 * an irreversible action, so each one is a parse, a call and a serialisation
 * with no rule of its own.
 *
 * **What it does not do.** No business logic lives here. `decide` decides,
 * `OwnerMfa` verifies, `traceFromInboxItem` traces; this module parses a
 * request, finds the session behind it, calls one of them, and serialises the
 * answer. A rule implemented in a handler would be a rule a second surface --
 * the chat channel, an operator's script -- does not get, and F10.10's tier 3
 * gate is the standing example of why that matters: it lives in `decide`,
 * where every caller meets it, and this module is just another caller.
 *
 * **Authentication is the second factor, and only that.** There are no
 * accounts. Signing in means presenting a TOTP code or a passkey assertion,
 * and what comes back is a session token. A session is *not* MFA: F10.10 wants
 * a tier 3 approval given "with MFA", and a token minted eight hours ago is
 * possession of a browser tab. So a tier 3 approval through this API carries a
 * fresh proof alongside the session, and `decide` checks it. See
 * `session.ts` for the argument in full.
 *
 * **Cross-origin and cross-site.** The API is JSON-only and requires the
 * session in an `Authorization` header rather than a cookie, which is what
 * makes it immune to CSRF by construction: a form posted from another site
 * cannot set that header, and a browser will not attach it on its own. The
 * cost is that the console has to hold the token itself, which it does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PalugadaError } from '../errors.ts';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import * as inbox from '../inbox/inbox.ts';
import { traceFromInboxItem } from '../reporting/trace.ts';
import { buildDailyDigest, buildWeeklyRetro } from '../reporting/digest.ts';
import {
  clearStopAll,
  freezeCompany,
  isStopAllRequested,
  killCapability,
  requestStopAll,
  reviveCapability,
  unfreezeCompany,
} from '../engine/control.ts';
import { frozenRoles, unfreezeRole } from '../governance/role-freeze.ts';
import {
  clearSpendPause,
  limitFor,
  overrideSpendPause,
  periodSpend,
  setSpendLimit,
} from '../governance/spend-guard.ts';
import { readGovernanceLog } from '../governance/store.ts';
import { readRetentionLog, retentionFor, setRetention } from '../retention/retention.ts';
import { ownerWindow, setBatchWindow, setOwnerWindow } from '../scheduler/windows.ts';
import { healthFor } from '../broker/preflight.ts';
import { costTimeline, platformCost } from '../reporting/cost.ts';
import { rotateCredential } from '../secrets/rotation.ts';
import { readTaskEvents } from '../audit/event-log.ts';
import { describeReplay, replayTask } from '../engine/replay.ts';
import { assignTask } from '../scheduler/wake.ts';
import { accountFor, chainFor, createAccount, snapshot } from '../engine/budget.ts';
import { supersede } from '../memory/store.ts';
import { getTask } from '../engine/tasks.ts';
import type { TaskHandler } from '../runtime/in-process.ts';
import { collectExport } from '../audit/export.ts';
import { applyGoalChange, createGoal, readGoal } from '../domain/goals.ts';
import {
  applyGrantChange,
  applyRoleChange,
  setEscalationPolicy,
  type RoleFields,
  type StructuralChange,
} from '../governance/structure.ts';
import { putPolicy } from '../governance/store.ts';
import { POLICY_EFFECTS, type PolicyEffect } from '../policy/engine.ts';
import { setThresholds } from '../reporting/alerts.ts';
import { pendingReviews } from '../review/review.ts';
import { upsertSchedule } from '../scheduler/scheduler.ts';
import {
  approveSkillVersion,
  importExternalSkill,
  liftSkillQuarantine,
  recordSkillReview,
  setSkillScope,
  skillSummariesFor,
  type SkillScopeTarget,
} from '../skills/skills.ts';
import { installBundle, verifyInstall } from '../bundles/bundle.ts';
import {
  listTrustedPublishers,
  revokePublisher,
  trustPublisher,
} from '../bundles/publishers.ts';
import { issueChallenge, pairDevice, registerDevice, revokeDevice } from '../gateway/gateway.ts';
import {
  acceptEvalCase,
  evalCasesFor,
  latestScore,
  requestRoleChange,
  type RoleChange,
} from '../eval/role-eval.ts';
import type { CapabilityRegistry } from '../broker/registry.ts';
import type { OwnerMfa, WebAuthnAssertion } from './mfa.ts';
import { OwnerSessions, type OwnerSession } from './session.ts';

export interface OwnerApiOptions {
  mfa: OwnerMfa;
  sessions?: OwnerSessions;
  /** Serves the console's own files. Omitted means API only. */
  staticRoot?: string;
  /**
   * Where the console is served from, for the `Access-Control-Allow-Origin`
   * answer. Omitted means same-origin only, which is the safe default: an API
   * that echoes back whatever `Origin` it was sent has no origin policy at
   * all.
   */
  origin?: string;
  /**
   * The registry a rotation sweeps afterwards (F12.3, F8.12).
   *
   * Optional, and its absence is honest rather than degraded: a sweep with no
   * way to resolve the rotated credential reports every credentialed
   * capability unhealthy, raises an incident and halts the next task that
   * needs one -- so a *successful* rotation would look exactly like a broken
   * one. Better to rotate without the check than to file a false alarm.
   */
  registry?: CapabilityRegistry;
  /**
   * The handlers F11.4's replay re-runs (F5.9).
   *
   * The deployment's own, not a copy: a replay of a handler nobody runs is a
   * replay of nothing. Absent means the route refuses rather than pretending,
   * because a deployment whose runtime is a container or a CLI has no handler
   * this process could call.
   */
  replayHandlers?: Map<string, TaskHandler>;
  /** How that sweep resolves a division's credential. Comes from the broker. */
  credentialFor?: (
    companyId: string,
    divisionId: string,
  ) => (alias: string, capabilityName: string) => Promise<string>;
}

interface Handler {
  (context: {
    request: IncomingMessage;
    session: OwnerSession | null;
    body: Record<string, unknown>;
    params: Record<string, string>;
    query: URLSearchParams;
  }): Promise<unknown>;
}

interface Route {
  method: string;
  /** Path with `:name` segments. Matched segment by segment, never by regex. */
  pattern: string;
  /** Whether a session is required. Only sign-in and the challenge are not. */
  open?: boolean;
  handle: Handler;
}

export class OwnerApi {
  readonly #options: OwnerApiOptions;
  readonly #sessions: OwnerSessions;
  readonly #routes: Route[];
  #server: Server | null = null;

  constructor(options: OwnerApiOptions) {
    this.#options = options;
    this.#sessions = options.sessions ?? new OwnerSessions({ mfa: options.mfa });
    this.#routes = this.#buildRoutes();
  }

  get sessions(): OwnerSessions {
    return this.#sessions;
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ url: string; port: number }> {
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the owner API did not bind to a port');
    }
    this.#server = server;
    return { url: `http://${host}:${address.port}`, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #buildRoutes(): Route[] {
    return [
      /* ------------------------------------------------------- signing in --- */

      {
        method: 'GET',
        pattern: '/api/auth/challenge',
        open: true,
        handle: async () => ({ challenge: this.#sessions.challenge() }),
      },

      {
        method: 'POST',
        pattern: '/api/auth/sign-in',
        open: true,
        handle: async ({ body }) => {
          const session = await this.#sessions.signIn(proofFrom(body));
          return {
            token: session.token,
            expiresAt: session.expiresAt.toISOString(),
            device: session.factor.label,
            factor: session.factor.kind,
          };
        },
      },

      {
        method: 'POST',
        pattern: '/api/auth/sign-out',
        handle: async ({ session }) => {
          this.#sessions.signOut(session!.token);
          return { ok: true };
        },
      },

      /* ----------------------------------------------------------- F10.1 --- */

      {
        method: 'GET',
        pattern: '/api/companies',
        handle: async () => ({ companies: await companies() }),
      },

      {
        // The queue, grouped per company, which is F10.1's own shape.
        method: 'GET',
        pattern: '/api/companies/:companyId/inbox',
        handle: async ({ params }) => ({
          items: await inbox.listOpen(params.companyId!),
        }),
      },

      /* ---------------------------------------------------- F10.2, F10.3 --- */

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/inbox/:itemId/decide',
        handle: async ({ params, body, session }) => {
          const decision = String(body.decision ?? '');
          if (decision !== 'approve' && decision !== 'deny' && decision !== 'ask') {
            throw new PalugadaError(
              'contract.violation',
              `decision must be approve, deny or ask; got ${decision || 'nothing'}`,
              {},
            );
          }

          // The proof, when one was sent. `decide` decides whether it was
          // needed -- this module does not read the tier and does not
          // second-guess the gate, because a second implementation of F10.10
          // is a second thing that can be wrong.
          const proof = body.proof === undefined ? undefined : proofFrom(body.proof);

          await inbox.decide(
            params.companyId!,
            params.itemId!,
            decision,
            String(body.note ?? ''),
            {
              channel: 'app',
              // The session is possession of a tab, not of the owner's phone.
              // Sent for the record; it is never what unlocks tier 3.
              assurance: 'session',
              ...(proof ? { proof } : {}),
              mfa: this.#options.mfa,
            },
          );
          void session;
          return { ok: true };
        },
      },

      /* ----------------------------------------------------------- F11.2 --- */

      {
        // Two hops from the item, which is what the requirement asks for: the
        // list gives an id, this gives the trace behind it.
        method: 'GET',
        pattern: '/api/companies/:companyId/inbox/:itemId/trace',
        handle: async ({ params, query }) => {
          const trace = await traceFromInboxItem(params.companyId!, params.itemId!, {
            includePrompts: query.get('prompts') === '1',
          });
          if (!trace) {
            throw new PalugadaError('contract.violation', 'no such inbox item', {});
          }
          return trace;
        },
      },

      /* ----------------------------------------------------- F10.6, F9.4 --- */

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/digest',
        handle: async ({ params, query }) => {
          const day = query.get('day');
          return buildDailyDigest(params.companyId!, day ? new Date(day) : new Date());
        },
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/retro',
        handle: async ({ params }) => buildWeeklyRetro(params.companyId!),
      },

      /* ----------------------------------------------------------- F10.7 --- */

      {
        // The four global buttons, in one place because they are one control:
        // "make it stop", at four widths.
        method: 'GET',
        pattern: '/api/control',
        handle: async ({ query }) => {
          const companyId = query.get('companyId');
          return {
            stopAll: await isStopAllRequested(),
            frozenRoles: companyId ? await frozenRoles(companyId) : [],
          };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/stop-all',
        handle: async ({ body }) => {
          // Reversible on purpose, and both directions are one route: a stop
          // the owner cannot lift without a database console is a stop they
          // will hesitate to use, and hesitating is the failure mode F10.7
          // exists to remove.
          if (body.on === false) await clearStopAll();
          else await requestStopAll();
          return { stopAll: await isStopAllRequested() };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/company/:companyId/freeze',
        handle: async ({ params, body }) => {
          if (body.on === false) await unfreezeCompany(params.companyId!);
          else await freezeCompany(params.companyId!);
          return { ok: true };
        },
      },

      {
        // The harder half of F10.7, and a separate button on purpose.
        //
        // `stop-all` raises the flag: the engine reads it at every step, so
        // in-flight work stops cleanly at its next one and resumes when the
        // flag clears. That is the button for "something looks wrong". This is
        // the button for "stop, and do not resume": it cancels every task
        // outright, which loses the journal state that would have let them
        // continue. Irreversible, so it takes the owner's device rather than
        // their tab.
        method: 'POST',
        pattern: '/api/control/cancel-everything',
        handle: async ({ body }) => {
          await this.#requireFactor(body.proof, 'cancel everything');
          return { cancelled: await inbox.stopEverything() };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/capability/:name/kill',
        handle: async ({ params, body }) => {
          if (body.on === false) await reviveCapability(params.name!);
          else await killCapability(params.name!);
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/company/:companyId/role/:roleId/resume',
        handle: async ({ params }) => {
          await unfreezeRole(params.companyId!, params.roleId!);
          return { ok: true };
        },
      },

      /* ------------------------------------------------ F1.5, F1.7-F1.9 --- */

      {
        // What the company is allowed to spend, what it has spent, and
        // whether the guard has stopped it. One route, because an owner
        // deciding whether to lift a pause needs all three at once and the
        // console should not have to compose them.
        method: 'GET',
        pattern: '/api/companies/:companyId/spend',
        handle: async ({ params }) => {
          const [limit, period] = await Promise.all([
            limitFor(params.companyId!),
            periodSpend(params.companyId!),
          ]);
          return {
            limitCents: limit.moneyMaxCents,
            pausedAt: limit.pausedAt?.toISOString() ?? null,
            pauseReason: limit.pauseReason ?? null,
            overrideUntil: limit.overrideUntil?.toISOString() ?? null,
            periodStart: period.periodStart.toISOString(),
            periodEnd: period.periodEnd.toISOString(),
            spentCents: period.cents,
          };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/spend/limit',
        handle: async ({ params, body }) => {
          await setSpendLimit(params.companyId!, wholeNumber(body.moneyMaxCents, 'moneyMaxCents'));
          return { ok: true };
        },
      },

      {
        // Lifting the pause and overriding it are one route with two shapes,
        // because they are the same decision: `until` means "let it run past
        // the ceiling until then", and its absence means "the ceiling was
        // wrong, here is a new one" -- which is `clearSpendPause`.
        method: 'POST',
        pattern: '/api/companies/:companyId/spend/resume',
        handle: async ({ params, body }) => {
          if (body.until === undefined || body.until === null) {
            await clearSpendPause(params.companyId!);
            return { ok: true, override: null };
          }
          const until = new Date(String(body.until));
          if (Number.isNaN(until.getTime())) {
            throw new PalugadaError('contract.violation', 'until is not a date', {});
          }
          // Deliberately not open-ended. F1.9's override exists for "this one
          // campaign is worth it", and an override with no end is a ceiling
          // that was removed rather than raised.
          if (until.getTime() <= Date.now()) {
            throw new PalugadaError('contract.violation', 'until is in the past', {});
          }
          await overrideSpendPause(params.companyId!, until);
          return { ok: true, override: until.toISOString() };
        },
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/retention',
        handle: async ({ params }) => ({
          policy: await retentionFor(params.companyId!),
          log: await readRetentionLog(params.companyId!),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/retention',
        handle: async ({ params, body }) => {
          // Partial on purpose: an owner changing how long prompts are kept
          // should not have to restate the other two, and restating them is
          // how one gets changed by accident.
          const policy: Record<string, number> = {};
          for (const field of ['eventDays', 'traceDays', 'promptDays'] as const) {
            if (body[field] !== undefined) policy[field] = wholeNumber(body[field], field);
          }
          if (Object.keys(policy).length === 0) {
            throw new PalugadaError('contract.violation', 'no retention field was given', {});
          }
          await setRetention(params.companyId!, policy);
          return { policy: await retentionFor(params.companyId!) };
        },
      },

      /* ----------------------------------------------------- F9.5, F9.6 --- */

      {
        method: 'GET',
        pattern: '/api/control/owner-window',
        handle: async () => {
          const window = await ownerWindow();
          return {
            timezone: window.timezone,
            startHour: window.startHour,
            endHour: window.endHour,
          };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/owner-window',
        handle: async ({ body }) => {
          await setOwnerWindow({
            timezone: String(body.timezone ?? 'UTC'),
            startHour: hour(body.startHour, 'startHour'),
            endHour: hour(body.endHour, 'endHour'),
          });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/batch-window',
        handle: async ({ params, body }) => {
          await setBatchWindow({
            companyId: params.companyId!,
            timezone: String(body.timezone ?? 'UTC'),
            startHour: hour(body.startHour, 'startHour'),
            endHour: hour(body.endHour, 'endHour'),
            ...(Array.isArray(body.daysOfWeek)
              ? { daysOfWeek: body.daysOfWeek.map((day) => wholeNumber(day, 'daysOfWeek')) }
              : {}),
          });
          return { ok: true };
        },
      },

      /* --------------------------------------------- F8.12, F11.5, F3.11 --- */

      {
        // What a division's capabilities said last time anyone asked. The
        // failure F8.12 exists for -- a credential that expired -- is
        // invisible until a task halts, and this is where an owner sees it
        // before that.
        method: 'GET',
        pattern: '/api/companies/:companyId/divisions/:divisionId/health',
        handle: async ({ params }) => ({
          health: await healthFor(params.companyId!, params.divisionId!),
        }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/cost',
        handle: async ({ params, query }) => {
          const granularity = query.get('by') === 'month' ? 'month' as const : 'day' as const;
          return {
            timeline: await costTimeline(params.companyId!, granularity, windowFrom(query)),
          };
        },
      },

      {
        method: 'GET',
        pattern: '/api/control/cost',
        handle: async ({ query }) => ({ companies: await platformCost(windowFrom(query)) }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/governance',
        handle: async ({ params }) => ({ log: await readGovernanceLog(params.companyId!) }),
      },

      {
        // F11.2's other half. The trace route answers "why is this in front of
        // me"; this answers "what did that task actually do", which is the
        // question an owner asks about work that already finished.
        method: 'GET',
        pattern: '/api/companies/:companyId/tasks/:taskId/events',
        handle: async ({ params }) => ({
          events: await withTenant(
            params.companyId!,
            (tx) => readTaskEvents(tx, params.taskId!),
          ),
        }),
      },

      /* --------------------------------------------------- F10.11, F9.9 --- */

      {
        // The owner giving a role something to do.
        //
        // Until this existed the owner could approve, configure and inspect --
        // and could not ask a company for anything. Every task in the platform
        // came from a schedule, an event or another agent. That is not one
        // human running many companies; it is one human watching them.
        //
        // Not just a task: `assignTask` also clears the role's dormancy and
        // queues an assignment wake, which is exempt from coalescing. The
        // owner asking for something now and the system answering in four
        // hours is what F9.8 exists to rule out.
        method: 'POST',
        pattern: '/api/companies/:companyId/assign',
        handle: async ({ params, body }) => {
          const assigned = await assignTask({
            companyId: params.companyId!,
            projectId: requireText(body.projectId, 'projectId'),
            divisionId: requireText(body.divisionId, 'divisionId'),
            roleId: requireText(body.roleId, 'roleId'),
            input: (body.input as Record<string, unknown> | undefined)
              ?? { goal: requireText(body.goal, 'goal') },
            createdBy: 'owner',
            // F2.7: required, not defaulted. Every task hangs from a goal, and
            // a route that picked one -- the company's mission, the first row
            // -- would be attaching the owner's work to whatever happened to
            // be there rather than to what they meant.
            goalId: requireText(body.goalId, 'goalId'),
            ...(body.detail === undefined ? {} : { detail: String(body.detail) }),
            ...(body.reserveTokens === undefined
              ? {}
              : { reserveTokens: wholeNumber(body.reserveTokens, 'reserveTokens') }),
          });
          return { taskId: assigned.task.id, wakeId: assigned.wakeId };
        },
      },

      /* ----------------------------------------------------- F1.2, F1.6 --- */

      {
        // What funds a role's work, and the chain above it.
        //
        // F1.6 makes a budget a tree: a task draws on the narrowest account
        // that covers it, and a spend counts against every account above.
        // Which one funds a given role is a question with a real answer and no
        // way to ask it until now.
        method: 'GET',
        pattern: '/api/companies/:companyId/divisions/:divisionId/roles/:roleId/budget',
        handle: async ({ params }) => withTenant(params.companyId!, async (tx) => {
          const accountId = await accountFor(tx, {
            companyId: params.companyId!,
            divisionId: params.divisionId!,
            roleId: params.roleId!,
          });
          if (!accountId) {
            throw new PalugadaError(
              'contract.violation', 'no account covers that role', {},
            );
          }
          return {
            accountId,
            chain: await chainFor(tx, accountId),
            snapshot: await snapshot(tx, accountId),
          };
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/budget-accounts',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => ({
          id: await createAccount(tx, {
            companyId: params.companyId!,
            label: requireText(body.label, 'label'),
            tokensMax: wholeNumber(body.tokensMax, 'tokensMax'),
            ...(body.moneyMaxCents === undefined
              ? {}
              : { moneyMaxCents: wholeNumber(body.moneyMaxCents, 'moneyMaxCents') }),
            // A scope below the company needs the account above it named:
            // F1.6's chain is what makes a spend count at every level, and an
            // account with no parent would be a ceiling nothing rolls up to.
            ...(body.scopeType === undefined
              ? {}
              : {
                scope: {
                  scopeType: oneOf(body.scopeType, BUDGET_SCOPES, 'scopeType'),
                  scopeId: requireText(body.scopeId, 'scopeId'),
                  parentAccountId: requireText(body.parentAccountId, 'parentAccountId'),
                },
              }),
          }),
        })),
      },

      /* ------------------------------------------------------------ F4.6 --- */

      {
        // Replacing a fact rather than deleting it.
        //
        // A memory that turned out to be wrong is not removed: it is
        // superseded, and the old row keeps pointing at what replaced it. An
        // agent that read the old fact yesterday and a person asking why it
        // did are both better served by a chain than by a hole.
        method: 'POST',
        pattern: '/api/companies/:companyId/memories/:memoryId/supersede',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => ({
          id: await supersede(tx, params.memoryId!, {
            companyId: params.companyId!,
            memoryType: 'semantic',
            scopeType: 'company',
            body: requireText(body.body, 'body'),
            ...(body.confidence === undefined
              ? {}
              : { confidence: Number(body.confidence) }),
          }),
        })),
      },

      /* ----------------------------------------------------------- F11.4 --- */

      {
        // Re-runs the task's handler against its journal, and reaches nothing.
        //
        // `replayTask` has no broker, no model client and no adapter wired in
        // at all -- not "disabled under a flag", none imported -- so a replay
        // of a task that bought a domain cannot buy the domain again. What it
        // reports is where the code no longer does what it did when the
        // journal was written, which is the most useful thing a replay can
        // say.
        method: 'POST',
        pattern: '/api/companies/:companyId/tasks/:taskId/replay',
        handle: async ({ params }) => {
          const handlers = this.#options.replayHandlers;
          if (!handlers || handlers.size === 0) {
            throw new PalugadaError(
              'contract.violation',
              'this deployment runs no in-process handlers, so there is nothing to replay '
                + 'here; a task run by a container or a CLI is replayed where that runtime '
                + 'lives (PRD F5.9, F13)',
              {},
            );
          }

          const roleSlug = await withTenant(params.companyId!, async (tx) => {
            const task = await getTask(tx, params.taskId!);
            if (!task) return null;
            const { rows } = await tx.query<{ slug: string }>(
              'SELECT slug FROM roles WHERE id = $1',
              [task.roleId],
            );
            return rows[0]?.slug ?? null;
          });
          if (!roleSlug) {
            throw new PalugadaError('contract.violation', 'no such task', {});
          }

          const handler = handlers.get(roleSlug);
          if (!handler) {
            // Named, because "nothing happened" and "this deployment does not
            // have that role's handler" are different problems with different
            // fixes.
            throw new PalugadaError(
              'contract.violation',
              `this deployment has no handler for role ${roleSlug}, so its work cannot be `
                + 'replayed here',
              { roleSlug },
            );
          }

          const report = await replayTask(params.companyId!, params.taskId!, handler);
          return { summary: describeReplay(report), report };
        },
      },

      /* ----------------------------------------------------------- F12.3 --- */

      {
        // Rotating is the answer to "that token leaked", so it is a tier 3
        // shaped action: it takes a fresh factor, not a session eight hours
        // old. The gate is here rather than in `rotateCredential` because
        // rotation is also what a scheduled job does, and a job has no phone.
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions/:divisionId/credentials/:alias/rotate',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, `rotate ${params.alias}`, params.companyId!);
          const rotated = await rotateCredential({
            companyId: params.companyId!,
            divisionId: params.divisionId!,
            alias: params.alias!,
            ...(body.newSecretRef === undefined
              ? {}
              : { newSecretRef: String(body.newSecretRef) }),
            // The sweep afterwards is the point of F12.3, and it needs both a
            // registry to sweep and a way to resolve the new value. A
            // deployment that gave this API neither rotates without it, which
            // is honest: the alternative is a sweep that reports every
            // credentialed capability unhealthy and halts the next task.
            ...(this.#options.registry ? { registry: this.#options.registry } : {}),
            ...(this.#options.credentialFor ? { credential: this.#options.credentialFor } : {}),
          });
          return {
            alias: rotated.alias,
            version: rotated.version,
            previousVersion: rotated.previousVersion,
            // The reference, never the value. It is a path; what it points at
            // is never seen by this process.
            secretRef: rotated.secretRef,
          };
        },
      },

      /* ----------------------------------------------------------- F10.3 --- */

      {
        // An agent asked the owner something. This is the answer going back,
        // which puts the task back on the queue rather than deciding it.
        method: 'POST',
        pattern: '/api/companies/:companyId/inbox/:itemId/answer',
        handle: async ({ params, body }) => {
          const answer = String(body.answer ?? '').trim();
          if (!answer) {
            throw new PalugadaError('contract.violation', 'an answer cannot be empty', {});
          }
          await inbox.answerOwnerQuestion(params.companyId!, params.itemId!, answer);
          return { ok: true };
        },
      },

      /* ----------------------------------------------------- F2.7, F3.10 --- */

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/goals/:goalId',
        handle: async ({ params }) => {
          const goal = await withTenant(
            params.companyId!, (tx) => readGoal(tx, params.goalId!),
          );
          if (!goal) throw new PalugadaError('contract.violation', 'no such goal', {});
          return goal;
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/goals',
        handle: async ({ params, body }) => createGoal({
          companyId: params.companyId!,
          kind: oneOf(body.kind, GOAL_KINDS, 'kind'),
          slug: requireText(body.slug, 'slug'),
          statement: requireText(body.statement, 'statement'),
          ...(body.parentGoalId === undefined
            ? {}
            : { parentGoalId: body.parentGoalId === null ? null : String(body.parentGoalId) }),
        }),
      },

      {
        // Editing the ladder redirects the company, so it takes the owner's
        // device. `proposeGoalChange` is the agent's path -- it files an item
        // and waits; this is the owner acting directly, which is why there is
        // nothing to wait for and why the factor is the whole check.
        method: 'POST',
        pattern: '/api/companies/:companyId/goals/:goalId',
        handle: async ({ params, body }) => {
          // Before the factor. A TOTP code is one-shot, so an empty edit would
          // spend the owner's code, write a `goal.changed` event, and change
          // nothing -- and the next real attempt would need a new code.
          if (body.statement === undefined && body.status === undefined) {
            throw new PalugadaError('contract.violation', 'no goal field was given', {});
          }
          await this.#requireFactor(body.proof, 'change a goal', params.companyId!);
          await applyGoalChange({
            companyId: params.companyId!,
            goalId: params.goalId!,
            ...(body.statement === undefined ? {} : { statement: String(body.statement) }),
            ...(body.status === undefined
              ? {}
              : { status: oneOf(body.status, GOAL_STATUSES, 'status') }),
          });
          return { ok: true };
        },
      },

      /* ----------------------------------------------------- F2.9, F3.9 --- */

      {
        // F2.9 says a structural change is tier 3 and the owner's. Every one
        // of these takes `ownerApproved`, and this surface is the only place
        // that may pass `true` -- with a factor, because a session is a tab.
        method: 'POST',
        pattern: '/api/companies/:companyId/structure/grant',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'change a grant', params.companyId!);
          // `revoke` decides, on its own. The first version read it only when
          // no `tierOverride` was sent, so `{ revoke: true, tierOverride: null }`
          // became a *change* to an unlimited grant -- and the database's
          // loosening trigger returns early on NULL, so nothing downstream
          // would have caught a revocation that granted instead.
          const kind = body.revoke === true ? 'revoke_grant' as const : 'change_grant' as const;
          const change = (kind === 'revoke_grant'
            ? {
              kind,
              divisionId: requireText(body.divisionId, 'divisionId'),
              capabilityName: requireText(body.capabilityName, 'capabilityName'),
            }
            : {
              kind,
              divisionId: requireText(body.divisionId, 'divisionId'),
              capabilityName: requireText(body.capabilityName, 'capabilityName'),
              tierOverride: body.tierOverride === null
                ? null
                : wholeNumber(body.tierOverride, 'tierOverride'),
            }) as Extract<StructuralChange, { kind: 'change_grant' | 'revoke_grant' }>;
          await applyGrantChange(params.companyId!, change, { ownerApproved: true });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/roles/:roleId',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'change a role', params.companyId!);
          // `String(null)` is the four letters "null", and a role whose
          // `model_primary` is the string "null" fails every later run. Each
          // field that is present must be a real value, and a field that is
          // absent is left alone.
          const fields: RoleFields = {};
          if (body.systemPrompt !== undefined) {
            fields.systemPrompt = requireText(body.systemPrompt, 'systemPrompt');
          }
          if (body.tools !== undefined) {
            fields.tools = textList(body.tools, 'tools');
          }
          if (body.modelPrimary !== undefined) {
            fields.modelPrimary = requireText(body.modelPrimary, 'modelPrimary');
          }
          if (body.modelFallback !== undefined) {
            fields.modelFallback = textList(body.modelFallback, 'modelFallback');
          }
          if (Object.keys(fields).length === 0) {
            throw new PalugadaError('contract.violation', 'no role field was given', {});
          }
          const version = await applyRoleChange(params.companyId!, params.roleId!, fields, {
            ownerApproved: true,
            ...(body.summary === undefined ? {} : { summary: String(body.summary) }),
          });
          return { version };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions/:divisionId/escalation',
        handle: async ({ params, body }) => {
          const policy: { roleSlug?: string | null; afterMinutes?: number } = {};
          if (body.roleSlug !== undefined) {
            policy.roleSlug = body.roleSlug === null ? null : String(body.roleSlug);
          }
          if (body.afterMinutes !== undefined) {
            policy.afterMinutes = wholeNumber(body.afterMinutes, 'afterMinutes');
          }
          if (Object.keys(policy).length === 0) {
            throw new PalugadaError('contract.violation', 'no escalation field was given', {});
          }
          await setEscalationPolicy(params.companyId!, params.divisionId!, policy);
          return { ok: true };
        },
      },

      /* ----------------------------------------------------------- F3.4 --- */

      {
        // The condition is validated by `putPolicy` itself, which is where the
        // grammar lives. A policy the console accepted and the engine could
        // not read would be a rule that looks enforced and is not.
        method: 'POST',
        pattern: '/api/policies',
        handle: async ({ body }) => ({
          id: await putPolicy({
            slug: requireText(body.slug, 'slug'),
            // Checked against the list rather than cast: an effect the engine
            // does not know is a policy that reads as a rule and enforces
            // nothing, and `putPolicy` would store it happily.
            effect: policyEffect(body.effect),
            condition: body.condition as never,
            ...(body.companyId === undefined ? {} : { companyId: String(body.companyId) }),
            ...(body.divisionId === undefined ? {} : { divisionId: String(body.divisionId) }),
            ...(body.mode === undefined
              ? {}
              : { mode: String(body.mode) as 'enforce' | 'log_only' }),
            ...(body.params === undefined
              ? {}
              : { params: body.params as Record<string, unknown> }),
          }),
        }),
      },

      /* ------------------------------------------------------------ F15 --- */

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/skills',
        handle: async ({ params, query }) => ({
          skills: await withTenant(params.companyId!, (tx) => skillSummariesFor(tx, {
            companyId: params.companyId!,
            divisionId: query.get('division'),
          })),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/versions/:versionId/review',
        handle: async ({ params, body }) => {
          // Said explicitly. `body.approved === true` made rejection the
          // default, so a POST that forgot the field would reject the version
          // *permanently* -- `approveSkillVersion` refuses a rejected one
          // forever afterwards.
          if (typeof body.approved !== 'boolean') {
            throw new PalugadaError(
              'contract.violation', 'approved must be true or false', { field: 'approved' },
            );
          }
          await recordSkillReview(params.companyId!, params.versionId!, {
            approved: body.approved,
            ...(body.reason === undefined ? {} : { reason: String(body.reason) }),
            ...(body.reviewRequestId === undefined
              ? {}
              : { reviewRequestId: String(body.reviewRequestId) }),
          });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/versions/:versionId/approve',
        handle: async ({ params }) =>
          approveSkillVersion(params.companyId!, params.versionId!),
      },

      {
        // F15.5. Widening a skill's scope is vouching for it somewhere it has
        // not been used, so it carries `ownerApproved` and this surface is the
        // only caller that may say true.
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/:skillId/scope',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'change a skill\'s scope', params.companyId!);
          // Built rather than cast. The first version passed
          // `{ scope, scopeId } as never`, which type-checked and was the
          // wrong shape entirely -- `setSkillScope` reads `scopeType`, so
          // every call would have widened the skill to `undefined` scope. A
          // cast is how a shape mismatch survives a typecheck.
          const scopeType = oneOf(body.scopeType, SKILL_SCOPES, 'scopeType');
          const target: SkillScopeTarget = scopeType === 'division'
            ? { scopeType, scopeId: requireText(body.scopeId, 'scopeId') }
            : { scopeType };
          await setSkillScope(params.companyId!, params.skillId!, target, {
            ownerApproved: true,
          });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/:skillId/quarantine/lift',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'lift a quarantine', params.companyId!);
          await liftSkillQuarantine(params.companyId!, params.skillId!, { ownerApproved: true });
          return { ok: true };
        },
      },

      {
        // F15.8. Unsigned means quarantined, which the function decides -- this
        // route hands over what arrived and does not vouch for it.
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/import',
        handle: async ({ params, body }) => importExternalSkill({
          companyId: params.companyId!,
          slug: requireText(body.slug, 'slug'),
          source: requireText(body.source, 'source'),
          origin: requireText(body.origin, 'origin'),
          divisionId: requireText(body.divisionId, 'divisionId'),
          ...(body.signature === undefined ? {} : { signature: String(body.signature) }),
          ...(body.publisherKey === undefined
            ? {}
            : { publisherKey: String(body.publisherKey) }),
        }),
      },

      /* ------------------------------------------------------------ F16 --- */

      {
        method: 'GET',
        pattern: '/api/publishers',
        handle: async () => ({ publishers: await listTrustedPublishers() }),
      },

      {
        // Trusting a publisher is vouching for everything it will ever sign,
        // which is why the function refuses without `ownerApproved` and why
        // this route asks for the device rather than the tab.
        method: 'POST',
        pattern: '/api/publishers',
        handle: async ({ body }) => {
          await this.#requireFactor(body.proof, 'trust a publisher');
          return {
            fingerprint: await trustPublisher({
              publicKeyPem: requireText(body.publicKeyPem, 'publicKeyPem'),
              label: requireText(body.label, 'label'),
              ownerApproved: true,
              addedBy: 'owner',
            }),
          };
        },
      },

      {
        // Revoking needs no factor: it only ever narrows what this
        // installation will accept, and a revocation somebody hesitates over
        // is one that happens too late.
        method: 'POST',
        pattern: '/api/publishers/:fingerprint/revoke',
        handle: async ({ params }) => {
          await revokePublisher(params.fingerprint!);
          return { ok: true };
        },
      },

      {
        // An install writes divisions, roles and capability grants -- including
        // tier 3 ones -- so it is a structural change by every measure F2.9
        // uses, and it takes the owner's device for the same reason
        // `structure/grant` does. The first version of this route asked only
        // for a session, which would have made the gate next to it decorative.
        method: 'POST',
        pattern: '/api/companies/:companyId/bundles',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'install a bundle', params.companyId!);
          return installBundle({
            companyId: params.companyId!,
            slug: requireText(body.slug, 'slug'),
            version: requireText(body.version, 'version'),
          });
        },
      },

      {
        // F16.5. "Is what is installed still what was signed" is a question
        // with a yes-or-no answer, and one nobody can ask is one nobody asks.
        method: 'GET',
        pattern: '/api/companies/:companyId/bundles/:slug/verify',
        handle: async ({ params }) => {
          const answer = await verifyInstall(params.companyId!, params.slug!);
          if (!answer) throw new PalugadaError('contract.violation', 'no such install', {});
          return answer;
        },
      },

      /* --------------------------------------------------- F12.7, F12.10 --- */

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/devices',
        handle: async ({ params, body }) => registerDevice({
          companyId: params.companyId!,
          name: requireText(body.name, 'name'),
          runtime: requireText(body.runtime, 'runtime'),
          publicKeyPem: requireText(body.publicKeyPem, 'publicKeyPem'),
        }),
      },

      {
        // Pairing is what makes a device's signature count, so it is the
        // owner's device that authorises another one. Lifting the quarantine
        // at the same time is a separate flag, because "I know this machine"
        // and "I vouch for what it has already done" are different claims.
        method: 'POST',
        pattern: '/api/companies/:companyId/devices/:deviceId/pair',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'pair a device', params.companyId!);
          await pairDevice(params.companyId!, params.deviceId!, {
            liftQuarantine: body.liftQuarantine === true,
          });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/devices/:deviceId/revoke',
        handle: async ({ params }) => {
          await revokeDevice(params.companyId!, params.deviceId!);
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/devices/:deviceId/challenge',
        handle: async ({ params }) => ({
          nonce: await issueChallenge(params.companyId!, params.deviceId!),
        }),
      },

      /* ------------------------------------------------------------ F17 --- */

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/roles/:roleId/evals',
        handle: async ({ params }) => ({
          cases: await evalCasesFor(params.companyId!, params.roleId!),
          latest: await latestScore(params.companyId!, params.roleId!),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/evals/:caseId/accept',
        handle: async ({ params }) => {
          await acceptEvalCase(params.companyId!, params.caseId!);
          return { ok: true };
        },
      },

      {
        // F17.2 and F17.3 together: scoring the change and putting the score
        // in front of the owner *before* they decide, rather than an hour
        // afterwards. This files the item; the decision goes through `decide`
        // like every other one, which is how the tier 3 gate stays in one
        // place.
        method: 'POST',
        pattern: '/api/companies/:companyId/roles/:roleId/change-request',
        handle: async ({ params, body }) => requestRoleChange({
          companyId: params.companyId!,
          roleId: params.roleId!,
          change: roleChange(body.change),
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          summary: requireText(body.summary, 'summary'),
        }),
      },

      /* ------------------------------------ F7.5, F9.1, F11.6, F16.4 --- */

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/reviews',
        handle: async ({ params }) => ({ reviews: await pendingReviews(params.companyId!) }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/schedules',
        handle: async ({ params, body }) => ({
          id: await upsertSchedule({
            companyId: params.companyId!,
            projectId: requireText(body.projectId, 'projectId'),
            divisionId: requireText(body.divisionId, 'divisionId'),
            roleId: requireText(body.roleId, 'roleId'),
            slug: requireText(body.slug, 'slug'),
            cronExpression: requireText(body.cronExpression, 'cronExpression'),
            ...(body.timezone === undefined ? {} : { timezone: String(body.timezone) }),
            ...(body.goalId === undefined ? {} : { goalId: String(body.goalId) }),
            ...(body.input === undefined
              ? {}
              : { input: body.input as Record<string, unknown> }),
            ...(body.reserveTokens === undefined
              ? {}
              : { reserveTokens: wholeNumber(body.reserveTokens, 'reserveTokens') }),
            ...(body.batchable === undefined ? {} : { batchable: body.batchable === true }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled !== false }),
          }),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/alert-thresholds',
        handle: async ({ params, body }) => {
          const thresholds: Record<string, number> = {};
          for (const field of [
            'dailyCostCents', 'taskFailureRate', 'policyDenialsPerDay',
            'verificationFailuresPerDay', 'roleFreezeDenialsPerDay',
            'spendRateMultiple', 'spendRateFloorCents',
          ] as const) {
            if (body[field] === undefined) continue;
            // `Number(null)`, `Number('')` and `Number([])` are all zero, and a
            // daily cost ceiling of zero makes the alert fire every day. A
            // number has to arrive as one.
            const value = body[field];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
              throw new PalugadaError(
                'contract.violation', `${field} must be a number of at least zero`, { field },
              );
            }
            thresholds[field] = value;
          }
          if (Object.keys(thresholds).length === 0) {
            throw new PalugadaError('contract.violation', 'no threshold was given', {});
          }
          await setThresholds(params.companyId!, thresholds);
          return { ok: true };
        },
      },

      {
        // F16.4. The whole company, as JSON, in one answer. Deliberately not
        // streamed: an owner exporting a company is doing it once, and a
        // download they can read is worth more than one they have to
        // reassemble.
        method: 'GET',
        pattern: '/api/companies/:companyId/export',
        handle: async ({ params, query }) => collectExport(params.companyId!, {
          ...(query.get('prompts') === '1' ? { includePrompts: true } : {}),
        }),
      },

      /* ----------------------------------------------------------- F12.5 --- */

      {
        method: 'GET',
        pattern: '/api/mfa/authenticators',
        handle: async () => ({
          // Never the secret reference and never the public key: this is a
          // list of devices, and the console needs a label and a kind to draw
          // one. Anything more is a detail an owner console has no use for and
          // a compromised browser would.
          authenticators: (await this.#options.mfa.enrolled()).map((factor) => ({
            id: factor.id,
            kind: factor.kind,
            label: factor.label,
          })),
        }),
      },

      {
        method: 'GET',
        pattern: '/api/mfa/challenge',
        handle: async () => ({ challenge: this.#options.mfa.challenge() }),
      },
    ];
  }

  /* --------------------------------------------------------------- plumbing --- */

  /**
   * Refuses an action that needs the owner's device rather than their tab.
   *
   * `decide` owns F10.10's gate for inbox items and this module never
   * second-guesses it. This is the same *rule* applied to the handful of
   * console actions that are not inbox items and are just as irreversible: a
   * rotation is the answer to "that token leaked", and a session minted eight
   * hours ago is possession of a browser tab.
   *
   * Kept here rather than pushed down into `rotateCredential` because rotation
   * is also what a scheduled job does, and a job has no phone. The surface
   * that has a human in front of it is the surface that can ask for one.
   */
  async #requireFactor(
    proof: unknown,
    purpose: string,
    companyId: string | null = null,
  ): Promise<void> {
    if (proof === undefined || proof === null) {
      throw new PalugadaError(
        'approval.channel_forbidden',
        `${purpose} needs a second factor; none was presented (PRD F10.10, F12.5)`,
        { purpose },
      );
    }
    const presented = proofFrom(proof);
    // No `subjectId`: it is a task or an inbox item elsewhere, and there is no
    // row this action is about. The company travels, though, so a factor
    // enrolled against one company cannot rotate another's credential --
    // the same isolation every table in this schema enforces, and the owner's
    // own platform-scoped device still answers for all of them.
    const asking = { purpose: `console.${purpose}`, subjectId: null, companyId };
    if ('totp' in presented) await this.#options.mfa.verifyTotp(presented.totp, asking);
    else await this.#options.mfa.verifyWebAuthn(presented.webauthn, asking);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Only the configured origin, and only when one is configured. An API that
    // reflects whatever `Origin` it was sent has no origin policy at all,
    // which is worse than none because it looks like one.
    if (this.#options.origin) {
      res.setHeader('access-control-allow-origin', this.#options.origin);
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const match = this.#match(req.method ?? 'GET', url.pathname);
    if (!match) {
      await this.#serveConsole(url.pathname, res);
      return;
    }

    let session: OwnerSession | null = null;
    if (!match.route.open) {
      session = this.#sessions.verify(bearer(req));
      if (!session) {
        // 401 rather than 404: the owner whose session expired should be told
        // to sign in, not told the console has moved.
        send(res, 401, { error: 'sign in first', code: 'owner.unauthenticated' });
        return;
      }
    }

    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        body = await readJson(req);
      } catch (error) {
        send(res, 400, { error: (error as Error).message });
        return;
      }
    }

    try {
      const answer = await match.route.handle({
        request: req,
        session,
        body,
        params: match.params,
        query: url.searchParams,
      });
      send(res, 200, answer ?? { ok: true });
    } catch (error) {
      // A refusal is an answer. `decide` refusing a tier 3 approval without a
      // factor, the broker refusing a capability, MFA refusing a code -- all
      // of them are the platform working, and the console has to be able to
      // tell the owner which one and why. An opaque 500 would turn every one
      // of those into "something went wrong".
      if (error instanceof PalugadaError) {
        send(res, statusFor(error.code), {
          error: error.message,
          code: error.code,
          details: error.details,
        });
        return;
      }
      // A constraint the schema states in words is a refusal too.
      //
      // "prompts must be kept at least ninety days" and "a mission is the top
      // of the ladder and has no parent" are messages somebody wrote for a
      // person to read, and the database is where several of this platform's
      // rules actually live. Flattening them into `internal error` tells the
      // owner their console is broken when in fact the platform just told
      // them why it would not do the thing.
      //
      // Only the codes that mean "what you sent is not allowed". Everything
      // else stays opaque, because an error nobody wrote for a reader is one
      // that leaks a schema rather than explaining a rule.
      const refusal = refusalFrom(error);
      if (refusal) {
        send(res, 400, { error: refusal, code: 'contract.violation' });
        return;
      }
      send(res, 500, { error: 'internal error' });
    }
  }

  /**
   * Matches a path segment by segment.
   *
   * Not a regex, deliberately. A router built from patterns compiled into
   * regular expressions is a router where `/api/companies/:id/inbox` can be
   * reached by something that is not an id, and the thing on the other side is
   * a company's decisions.
   */
  #match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const expected = route.pattern.split('/').filter(Boolean);
      if (expected.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (const [index, segment] of expected.entries()) {
        const actual = parts[index]!;
        if (segment.startsWith(':')) {
          if (actual === '') { ok = false; break; }
          params[segment.slice(1)] = decodeURIComponent(actual);
          continue;
        }
        if (segment !== actual) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /**
   * Serves the console itself, when a deployment asked for it.
   *
   * The path is resolved and then checked to be inside the root, which is the
   * whole of the defence: `..%2f..%2fetc%2fpasswd` decodes to a traversal, and
   * a static server that joins a request path onto a directory without that
   * check is the oldest hole there is.
   */
  async #serveConsole(pathname: string, res: ServerResponse): Promise<void> {
    const root = this.#options.staticRoot;
    if (!root) {
      send(res, 404, { error: 'no such route' });
      return;
    }

    const { readFile, realpath } = await import('node:fs/promises');
    const { join, normalize, resolve, extname, sep } = await import('node:path');

    const wanted = pathname === '/' ? '/index.html' : pathname;
    const base = await realpath(resolve(root)).catch(() => resolve(root));
    const target = resolve(join(base, normalize(decodeURIComponent(wanted))));

    // Checked against the *real* path, not the resolved one.
    //
    // `normalize` already flattens `..`, so a request full of dots lands
    // harmlessly inside the root and 404s -- which makes it easy to believe
    // the textual check is what stops traversal. It is not. `resolve` does not
    // follow symbolic links, so a link inside the console directory pointing
    // at `/etc` is a path that passes every string comparison and reads
    // somebody else's files. `realpath` is what closes that, and it is the
    // only reason this check earns its place.
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      // Nothing there. Not an escape, just a miss.
      send(res, 404, { error: 'no such route' });
      return;
    }
    if (real !== base && !real.startsWith(base + sep)) {
      send(res, 403, { error: 'outside the console' });
      return;
    }

    try {
      const file = await readFile(real);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
        // The console is one page and its own script; nothing else may run in
        // it, and nothing may frame it. Written here rather than in the HTML
        // because a header cannot be edited away by whatever the page later
        // renders.
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(file);
    } catch {
      send(res, 404, { error: 'no such route' });
    }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The status a refusal deserves.
 *
 * Mapped rather than defaulted to 400, because the console draws a different
 * thing for each: "sign in" is not "you may not", and neither is "that code is
 * wrong". An owner who cannot tell them apart cannot act on any of them.
 */
function statusFor(code: string): number {
  if (code === 'owner.unauthenticated') return 401;
  if (code === 'mfa.locked_out') return 429;
  if (code.startsWith('mfa.')) return 401;
  if (code === 'approval.channel_forbidden' || code === 'policy.denied') return 403;
  if (code === 'capability.rate_limited') return 429;
  return 400;
}

function proofFrom(value: unknown): { totp: string } | { webauthn: WebAuthnAssertion } {
  const body = (value ?? {}) as Record<string, unknown>;
  if (typeof body.totp === 'string') return { totp: body.totp };
  if (body.webauthn && typeof body.webauthn === 'object') {
    return { webauthn: body.webauthn as WebAuthnAssertion };
  }
  throw new PalugadaError(
    'contract.violation',
    'a second factor is a totp code or a webauthn assertion',
    {},
  );
}

/**
 * A whole number, or a refusal that names the field.
 *
 * `Number(undefined)` is `NaN` and `Number('')` is `0`, and both would reach
 * the database as a spend ceiling. A ceiling of zero set by a typo stops every
 * company, which is a bad afternoon; one set to `NaN` is a constraint
 * violation the owner reads as a bug.
 */
function wholeNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PalugadaError(
      'contract.violation',
      `${field} must be a whole number of at least zero`,
      { field },
    );
  }
  return parsed;
}

function hour(value: unknown, field: string): number {
  const parsed = wholeNumber(value, field);
  if (parsed > 23) {
    throw new PalugadaError('contract.violation', `${field} must be an hour, 0 to 23`, { field });
  }
  return parsed;
}

/**
 * The window a cost question covers, defaulting to the last thirty days.
 *
 * A default rather than a required pair, because the question an owner asks is
 * "what has this been costing me" and making them name two dates first is a
 * question they stop asking.
 */
function windowFrom(query: URLSearchParams): { from: Date; to: Date } {
  const to = query.get('to') ? new Date(query.get('to')!) : new Date();
  const from = query.get('from')
    ? new Date(query.get('from')!)
    : new Date(to.getTime() - 30 * 24 * 60 * 60_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new PalugadaError('contract.violation', 'from and to must be dates', {});
  }
  if (from >= to) {
    throw new PalugadaError('contract.violation', 'from must be before to', {});
  }
  return { from, to };
}

/**
 * The database's own words, when it refused something the owner sent.
 *
 * Deliberately a short list. A check constraint, a trigger's `raise`, a
 * uniqueness clash and a malformed value are all "what you sent is not
 * allowed", and in this schema each carries a sentence written for a human --
 * several of this platform's rules live there and nowhere else. A permission
 * or RLS denial is *not* in the list: that one means this process asked for
 * something it may not have, which is a bug here rather than a message for the
 * owner.
 */
const REFUSAL_CODES = new Set([
  '23514', // check constraint
  '23505', // unique violation
  '23503', // foreign key
  '23502', // not null
  '22P02', // invalid text representation
  'P0001', // a trigger's own raise
]);

function refusalFrom(error: unknown): string | null {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code !== 'string' || !REFUSAL_CODES.has(code)) return null;
  const message = (error as Error).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/**
 * One of a fixed set, or a refusal naming what is allowed.
 *
 * A cast would let an effect the engine does not know reach the database, and
 * `putPolicy` would store it happily -- producing a policy row that reads as a
 * rule and enforces nothing. The same argument as the tier: a value the
 * platform believes is a value somebody has to have checked once.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const text = String(value ?? '');
  if (!(allowed as readonly string[]).includes(text)) {
    throw new PalugadaError(
      'contract.violation',
      `${field} must be one of ${allowed.join(', ')}; got ${text || 'nothing'}`,
      { field },
    );
  }
  return text as T;
}

/** A string that has to be there. `String(undefined)` is "undefined", and it fits. */
function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new PalugadaError('contract.violation', `${field} is required`, { field });
  }
  return text;
}

/** A list of non-empty strings, which `Array.map(String)` is not. */
function textList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new PalugadaError('contract.violation', `${field} must be an array`, { field });
  }
  return value.map((entry, index) => requireText(entry, `${field}[${index}]`));
}

function policyEffect(value: unknown): PolicyEffect {
  return oneOf(value, POLICY_EFFECTS, 'effect');
}

const ROLE_CHANGES = ['charter', 'skills', 'model_routing'] as const;
function roleChange(value: unknown): RoleChange {
  return oneOf(value, ROLE_CHANGES, 'change');
}

const GOAL_KINDS = ['mission', 'objective', 'key_result'] as const;
const GOAL_STATUSES = ['active', 'met', 'abandoned'] as const;
const SKILL_SCOPES = ['company', 'platform', 'division'] as const;
const BUDGET_SCOPES = ['project', 'division', 'role'] as const;

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A decision is a few hundred bytes. A megabyte is far more than one needs
    // and far less than enough to exhaust the console.
    if (size > 1_048_576) throw new Error('request body is too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Every company the owner has, newest last, which is how they were made. */
async function companies(): Promise<Array<{ id: string; slug: string; name: string; frozen: boolean }>> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; slug: string; name: string; frozen: boolean;
    }>(
      `SELECT id, slug, name, frozen_at IS NOT NULL AS frozen
         FROM companies ORDER BY created_at`,
    );
    return rows;
  });
}
