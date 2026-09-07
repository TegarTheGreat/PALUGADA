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
