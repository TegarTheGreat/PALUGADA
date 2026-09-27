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
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
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
import { frozenRoles, pauseRole, unfreezeRole } from '../governance/role-freeze.ts';
import { cancelTask, giveFeedback, instructTask, rerunTask, type Verdict } from '../engine/owner-control.ts';
import { transcriptOf } from '../engine/transcript.ts';
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
import type { SecretManager } from '../secrets/manager.ts';
import { assertStage, loosens, setStage, stageOf, type Stage } from '../domain/stage.ts';
import { createHandoffRule, handoffRulesOf, setHandoffRuleEnabled } from '../engine/handoff-rules.ts';
import { searchEverywhere } from './search.ts';
import { appendEvent, readTaskEvents } from '../audit/event-log.ts';
import { describeReplay, replayTask } from '../engine/replay.ts';
import { assignTask } from '../scheduler/wake.ts';
import { createCompanyFromTemplate, readTemplate } from '../templates/company.ts';
import { accountFor, chainFor, createAccount, snapshot } from '../engine/budget.ts';
import { remember, supersede } from '../memory/store.ts';
import { defineMetric, headlines, recordObservation, type Headline, type MetricUnit } from '../domain/metrics.ts';
import {
  LANGUAGES, deploymentLanguages, languageCode, languagesFor, setCompanyLanguages, setDeploymentLanguages,
} from '../domain/language.ts';
import { getTask } from '../engine/tasks.ts';
import type { TaskHandler } from '../runtime/in-process.ts';
import type { AdapterRegistry } from '../runtime/protocol.ts';
import { collectExport } from '../audit/export.ts';
import { archiveLines, importCompany, previewArchive } from '../audit/import.ts';
import {
  createTrigger, receiveHook, rotateTriggerToken, setTriggerEnabled, triggersOf, type TriggerScheme,
} from '../scheduler/triggers.ts';
import { applyGoalChange, createGoal, readGoal } from '../domain/goals.ts';
import {
  addDivision,
  addProject,
  addRole,
  applyGrantChange,
  applyRoleChange,
  setEscalationPolicy,
  type RoleFields,
  type StructuralChange,
} from '../governance/structure.ts';
import { putPolicy } from '../governance/store.ts';
import { history as configHistory, type ConfigKind } from '../governance/config-versions.ts';
import { rollBack } from '../governance/rollback.ts';
import { assertValidCondition, type Condition } from '../policy/condition.ts';
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
import { installBundle, latestBundleVersion, verifyInstall } from '../bundles/bundle.ts';
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
import { CapabilityRegistry } from '../broker/registry.ts';
import { accessFor, bindMcpServers, currentPins, offeredTools, type TokenIn } from '../capabilities/mcp.ts';
import { MCP_PRESETS } from '../capabilities/mcp-presets.ts';
import { LISTEN_PROVIDERS, listenProvider, transcribe, type Heard, type ListenBinding, type ListenProvider } from '../capabilities/listen.ts';
import {
  closeProposal, conversation, converse, forgetConversation, patternFor, proposalById, type AssistantReach,
} from './assistant.ts';
import { ASSISTANT_ACTIONS } from './assistant-actions.ts';
import type { ToolUsingLlmClient } from '../llm/client.ts';
import type { OwnerMfa, WebAuthnAssertion } from './mfa.ts';
import { telegramApi, telegramBot, telegramChats, type TelegramChannel, type TelegramUpdate } from './telegram.ts';
import { WebhookPush, ntfyBody } from './push.ts';
import { OwnerSessions, type OwnerSession } from './session.ts';
import { MODEL_TIERS, modelSettingsFrom } from '../llm/models.ts';
import { checkModel, listModels } from '../llm/check.ts';
import { MODEL_PROVIDERS, modelProvider } from '../llm/providers.ts';
import {
  deleteSecret, putSecret, readSettings, secretNames, stateDirFrom, writeSetting, type MasterKey, type Settings,
} from '../settings/store.ts';
import {
  modelSource, withSettings, type AgentSetting, type ChannelSettings, type McpServerSetting, type ModelSetting, type ToolSetting,
} from '../settings/overlay.ts';
import { WEBHOOK_HOSTS, WebhookChatChannel, type WebhookChatKind } from './webhook-chat.ts';
import {
  EXTRACT_PROVIDERS, SEARCH_PROVIDERS, extractProvider, searchProvider, webExtract, webSearch,
  type ExtractProvider, type SearchProvider, type ToolBinding,
} from '../capabilities/search.ts';
import {
  IMAGE_PROVIDERS, SPEECH_PROVIDERS, imageProvider, makeImage, makeSpeech, speechProvider,
  type ImageProvider, type MediaBinding, type SpeechProvider,
} from '../capabilities/media.ts';
import { TOOL_KINDS, type ToolKind } from '../capabilities/tools.ts';
import {
  AGENT_CATALOGUE, AgentJobs, agentEntry, cannotInstall, claudeSetupToken, findAgent, installAgent, type AgentEntry,
} from '../settings/agents.ts';
import {
  accountsOf,
  activityOf,
  devicesOf,
  isMemoryKind,
  isWorkGroup,
  memoriesOf,
  schedulesOf,
  structureOf,
  taskDetailOf,
  workOf,
} from './views.ts';

export interface OwnerApiOptions {
  mfa: OwnerMfa;
  sessions?: OwnerSessions;
  /**
   * The console is reached through a reverse proxy, so the caller's address
   * is the last one the proxy added to `X-Forwarded-For` rather than the
   * connection's, which is the proxy's own. Off by default: without a proxy
   * in front, that header is whatever the caller chose to write.
   */
  behindProxy?: boolean;
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
  /**
   * The names this console answers to, from the `Host` header.
   *
   * DNS rebinding points a name the attacker owns at 127.0.0.1, and a page
   * on that name can then reach a console bound to loopback as though it were
   * same-origin -- the browser checks the name, not the address. A console
   * that refuses every Host it was not given closes that. Omitted, a console
   * bound to loopback answers to the loopback names only, and one bound to
   * every interface answers to anything, which the deployment says at boot.
   */
  allowedHosts?: readonly string[];
  /**
   * What the deployment said about itself at boot: each capability left
   * unbound, each channel not configured, each runtime missing. Shown to the
   * owner as what is left to set up, because a note in a service log is one
   * nobody running the company from a phone will ever read.
   */
  deploymentNotes?: readonly string[];
  /**
   * The runtimes this deployment employs (F13.1), so the owner can see which
   * answer and move a role onto one. Absent means none can be chosen: a role
   * change naming a runtime is refused rather than written unchecked.
   */
  runtimes?: AdapterRegistry;
  /**
   * The deployment's own settings, set from the console (0065): what the
   * environment said before them, what they are, the key they are sealed
   * with, and how to take a change up. Omitted, the console cannot change
   * them, as with a deployment built by hand.
   */
  /**
   * The owner's assistant (src/owner/assistant.ts): the model it thinks with,
   * the deployment's own. Absent or null, the conversation says a model has to
   * be chosen first.
   */
  assistant?: {
    llm: ToolUsingLlmClient | null;
    /** What hears the owner speak, and what answers aloud: the providers chosen under Tools. */
    voice?: { listen?: ListenBinding; speak?: MediaBinding<SpeechProvider> };
  };
  deploymentSettings?: {
    baseEnv: NodeJS.ProcessEnv;
    env: NodeJS.ProcessEnv;
    settings: Settings;
    master: (create: boolean) => MasterKey | null;
    secrets: SecretManager;
    restart?: () => void;
  };
  /**
   * Whether this process can do its work: the database answers, the worker's
   * loop is going round. Read by `GET /api/health`, which a supervisor or a
   * load balancer asks without a session.
   */
  health?: () => Promise<{ ok: boolean } & Record<string, unknown>>;
  /**
   * The message channel whose button presses arrive at
   * `/api/channels/telegram` (F10.9). Absent means the route refuses.
   */
  telegram?: TelegramChannel;
  /** How that sweep resolves a division's credential. Comes from the broker. */
  credentialFor?: (
    companyId: string,
    divisionId: string,
  ) => (alias: string, capabilityName: string) => Promise<string>;
  /**
   * Where a signed trigger's secret is read from (0056): the deployment's
   * secret store. Absent means a signed trigger cannot be opened, and one that
   * exists answers its sender 503 -- never lets a delivery in unchecked.
   */
  secrets?: SecretManager;
}

interface Handler {
  (context: {
    request: IncomingMessage;
    session: OwnerSession | null;
    body: Record<string, unknown>;
    /** The body's bytes as they arrived, for a route that reads them itself. */
    raw: Buffer;
    params: Record<string, string>;
    query: URLSearchParams;
  }): Promise<unknown>;
}

/** A route's answer with a status other than 200: only the health check needs one. */
class WithStatus {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

interface Route {
  method: string;
  /** Path with `:name` segments. Matched segment by segment, never by regex. */
  pattern: string;
  /** Whether a session is required. Only sign-in and the challenge are not. */
  open?: boolean;
  /** The largest body this route reads. A megabyte unless the route says otherwise. */
  maxBodyBytes?: number;
  /**
   * The route reads the body's bytes itself, and they are not parsed as a JSON
   * object first. Only the inbound hook, whose senders sign bytes and send
   * forms and text as well as JSON.
   */
  raw?: boolean;
  handle: Handler;
}

export class OwnerApi {
  readonly #options: OwnerApiOptions;
  readonly #sessions: OwnerSessions;
  readonly #routes: Route[];
  readonly #signInThrottle = new SignInThrottle();
  readonly #agentJobs = new AgentJobs();
  #server: Server | null = null;
  #allowedHosts: ReadonlySet<string> | null = null;

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
    const given = this.#options.allowedHosts;
    this.#allowedHosts = given
      ? new Set([...given, host].map(normaliseHost))
      : LOOPBACK_HOSTS.has(normaliseHost(host)) ? LOOPBACK_HOSTS : null;
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
        // F10.9: where Telegram posts a button press. Open, because Telegram
        // has no session; what stands in for one is the webhook secret, which
        // the channel checks first, and then who pressed. Register it with
        // `setWebhook` and the same `secret_token` as
        // PALUGADA_TELEGRAM_WEBHOOK_SECRET.
        method: 'POST',
        pattern: '/api/channels/telegram',
        open: true,
        handle: async ({ request, body }) => {
          const channel = this.#options.telegram;
          if (!channel) {
            throw new PalugadaError('contract.violation', 'this deployment has no Telegram channel', {});
          }
          const secret = request.headers['x-telegram-bot-api-secret-token'];
          const outcome = await channel.onUpdate(body as TelegramUpdate, {
            ...(typeof secret === 'string' ? { secretHeader: secret } : {}),
          });
          if (outcome.reason === 'webhook_secret') {
            throw new PalugadaError('owner.unauthenticated', 'that request is not from Telegram', {});
          }
          // Anything else is an answer Telegram should not retry: a press
          // refused, a stale button, an item closed since.
          return outcome;
        },
      },

      {
        method: 'POST',
        pattern: '/api/auth/sign-in',
        open: true,
        handle: async ({ body, request }) => {
          const address = addressOf(request, this.#options.behindProxy === true);
          this.#signInThrottle.check(address);
          let session: Awaited<ReturnType<OwnerSessions['signIn']>>;
          try {
            session = await this.#sessions.signIn(proofFrom(body));
          } catch (failure) {
            this.#signInThrottle.failed(address, failure);
            throw failure;
          }
          this.#signInThrottle.succeeded(address);
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
          await this.#sessions.signOut(session!.token);
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
        // Starting a company, which is the thing this platform is for.
        //
        // "One human runs many companies" and the console could not make one:
        // a company arrived through the seed script or the boot check, so the
        // owner's second company needed a terminal. `createCompanyFromTemplate`
        // was called only by those two.
        //
        // A structural change if anything is -- it writes divisions, roles,
        // grants and a budget tree in one transaction -- so it takes the
        // owner's device, like every other one.
        method: 'POST',
        pattern: '/api/companies',
        handle: async ({ body }) => {
          // The bundles to start with -- "company-os" makes the company run
          // itself -- resolved before the factor is spent and before anything
          // is written, so a wrong name costs the owner neither a code nor a
          // half-made company.
          const wanted = body.bundles === undefined ? [] : body.bundles;
          if (!Array.isArray(wanted) || wanted.length > 5 || !wanted.every((slug) => typeof slug === 'string' && slug)) {
            throw new PalugadaError('contract.violation', 'bundles is a list of at most five bundle names', { field: 'bundles' });
          }
          const bundles: Array<{ slug: string; version: string }> = [];
          for (const slug of new Set(wanted as string[])) {
            const version = await latestBundleVersion(slug);
            if (!version) throw new PalugadaError('contract.violation', `no bundle named ${slug} is published here`, { slug });
            bundles.push({ slug, version });
          }
          await this.#requireFactor(body.proof, 'start a company');
          const templateSlug = requireText(body.templateSlug, 'templateSlug');
          // Checked here so the refusal names the template rather than
          // arriving as a plain `Error` the caller reads as a broken console.
          if (!(await readTemplate(templateSlug))) {
            throw new PalugadaError(
              'contract.violation', `no company template named ${templateSlug}`, { templateSlug },
            );
          }
          const created = await createCompanyFromTemplate({
            templateSlug,
            companySlug: requireText(body.companySlug, 'companySlug'),
            name: requireText(body.name, 'name'),
            ...(body.timezone === undefined
              ? {}
              : { timezone: requireText(body.timezone, 'timezone') }),
          });
          // One factor covers the company and what it starts with: installing
          // a bundle is the same structural change F2.9 already approved here.
          for (const bundle of bundles) {
            await installBundle({ companyId: created.companyId, slug: bundle.slug, version: bundle.version });
          }
          return {
            companyId: created.companyId,
            divisions: Object.keys(created.divisionIds),
            roles: Object.keys(created.roleIds),
            bundles: bundles.map((bundle) => bundle.slug),
          };
        },
      },

      {
        // The queue, grouped per company, which is F10.1's own shape.
        method: 'GET',
        pattern: '/api/companies/:companyId/inbox',
        // `?snoozed=1` lists the items the owner put off instead (0060).
        handle: async ({ params, query }) => ({
          items: await inbox.listOpen(params.companyId!, { snoozed: query.get('snoozed') === '1' }),
        }),
      },

      {
        // One search across every company: the work, what it produced, the
        // decisions and what the companies know (src/owner/search.ts).
        method: 'GET',
        pattern: '/api/search',
        handle: async ({ query }) => ({ hits: await searchEverywhere(query.get('q') ?? '') }),
      },

      {
        // F10.8: what was decided, searchable. The queue above is what is
        // waiting; this is what the owner said, and what closed without them.
        method: 'GET',
        pattern: '/api/companies/:companyId/decisions',
        handle: async ({ params, query }) => inbox.history(params.companyId!, {
          query: query.get('q'),
          before: query.get('before'),
          limit: query.get('limit') === null ? 25 : wholeNumber(query.get('limit'), 'limit'),
        }),
      },

      /* -------------------------------------------- what the pages draw --- */

      // The company's shape, work, recent events, accounts, schedules and
      // devices, so the console can offer a choice instead of asking for an
      // id (src/owner/views.ts).
      {
        method: 'GET',
        pattern: '/api/companies/:companyId/structure',
        handle: async ({ params }) => structureOf(params.companyId!),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/work',
        handle: async ({ params, query }) => {
          const group = query.get('group');
          if (group !== null && group !== '' && !isWorkGroup(group)) {
            throw new PalugadaError(
              'contract.violation',
              `group must be active, waiting, done or stopped; got ${group}`,
              { field: 'group' },
            );
          }
          return workOf(params.companyId!, {
            ...(group ? { group } : {}),
            ...(query.get('limit') === null ? {} : { limit: wholeNumber(query.get('limit'), 'limit') }),
          });
        },
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/activity',
        handle: async ({ params, query }) => ({
          items: await activityOf(
            params.companyId!,
            query.get('limit') === null ? 30 : wholeNumber(query.get('limit'), 'limit'),
            { routine: query.get('routine') === 'include' },
          ),
        }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/budget-accounts',
        handle: async ({ params }) => ({ accounts: await accountsOf(params.companyId!) }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/schedules',
        handle: async ({ params }) => ({ schedules: await schedulesOf(params.companyId!) }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/devices',
        handle: async ({ params }) => ({ devices: await devicesOf(params.companyId!) }),
      },

      {
        // F4: what the company knows, filtered by kind or words, current
        // facts only unless the replaced ones are asked for.
        method: 'GET',
        pattern: '/api/companies/:companyId/memories',
        handle: async ({ params, query }) => {
          const kind = query.get('kind');
          if (kind !== null && kind !== '' && !isMemoryKind(kind)) {
            throw new PalugadaError(
              'contract.violation',
              `kind must be working, episodic, semantic or procedural; got ${kind}`,
              { field: 'kind' },
            );
          }
          return memoriesOf(params.companyId!, {
            ...(kind ? { kind } : {}),
            ...(query.get('q') ? { query: query.get('q')! } : {}),
            superseded: query.get('superseded') === 'include',
            ...(query.get('limit') === null ? {} : { limit: wholeNumber(query.get('limit'), 'limit') }),
          });
        },
      },

      {
        // Open, because what asks is a supervisor rather than the owner, and
        // what it says is only whether this process is working: nothing
        // about any company.
        method: 'GET',
        pattern: '/api/health',
        open: true,
        handle: async () => {
          const health = this.#options.health ? await this.#options.health() : { ok: true };
          return new WithStatus(health.ok ? 200 : 503, health);
        },
      },

      {
        // F13.1, F13.8: what can do a role's work here, and whether it answers.
        // Asked of every runtime at once, each given two seconds: a runtime
        // that does not answer in that time is not one to move a role onto.
        method: 'GET',
        pattern: '/api/runtimes',
        handle: async () => {
          const registry = this.#options.runtimes;
          const names = registry?.names() ?? [];
          const runtimes = await Promise.all(names.map(async (name) => {
            const adapter = registry!.get(name)!;
            let timer: NodeJS.Timeout | undefined;
            const health = await Promise.race([
              adapter.health().catch((failure: unknown) => ({ ok: false, detail: (failure as Error).message })),
              new Promise<{ ok: boolean; detail?: string }>((resolve) => {
                timer = setTimeout(() => resolve({ ok: false, detail: 'did not answer within two seconds' }), 2_000);
              }),
            ]).finally(() => clearTimeout(timer));
            return {
              name,
              backends: [...adapter.backends],
              ok: health.ok,
              ...(health.detail === undefined ? {} : { detail: health.detail }),
            };
          }));
          return { runtimes };
        },
      },

      {
        method: 'GET',
        pattern: '/api/control/setup',
        handle: async () => {
          const notes = [...(this.#options.deploymentNotes ?? [])];
          // Two of the boot notes say what *is* set up; the rest are each
          // something switched off until the operator sets it.
          return {
            notes,
            todo: notes.filter((note) => !/^(enrolled |bound by |bound from |model: |model prices from |runtimes: |seeded )/.test(note)),
          };
        },
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

      {
        // Putting an item off until later, or bringing it back with null
        // (0060). Decides nothing, so the session is enough.
        method: 'POST',
        pattern: '/api/companies/:companyId/inbox/:itemId/snooze',
        handle: async ({ params, body }) => {
          const until = body.until === null || body.until === undefined ? null : new Date(String(body.until));
          await inbox.snooze(params.companyId!, params.itemId!, until);
          return { ok: true };
        },
      },

      {
        // Several items at once: the drafts the owner has read and wants to
        // send, or a morning's worth of "not now". Each is decided exactly as
        // it would be alone; what must be decided alone -- tier 3, a run's
        // question, an incident -- comes back unapproved with the reason. No
        // proof is taken, because nothing a batch approves needs one.
        method: 'POST',
        pattern: '/api/companies/:companyId/inbox/batch',
        // `decideMany` checks the decision and the list; checking them here too
        // would be a second rule to keep in step with the first.
        handle: async ({ params, body }) => inbox.decideMany(
          params.companyId!, body.itemIds as string[], body.decision as 'approve' | 'deny', String(body.note ?? ''),
          { channel: 'app', assurance: 'session' },
        ),
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
          // exists to remove. Pressing it takes the session. Lifting it takes
          // the second factor, like every control here that loosens: whoever
          // stole a session must not be able to undo the stop the owner
          // pressed because of them.
          if (body.on === false) {
            await this.#requireFactor(body.proof, 'resume everything');
            await clearStopAll();
          } else {
            await requestStopAll();
          }
          return { stopAll: await isStopAllRequested() };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/company/:companyId/freeze',
        handle: async ({ params, body }) => {
          if (body.on === false) {
            await this.#requireFactor(body.proof, 'unfreeze a company', params.companyId!);
            await unfreezeCompany(params.companyId!);
          } else {
            await freezeCompany(params.companyId!);
          }
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
        // Stopping is a session's to do; starting again is not. The rule for
        // every control on this surface: whatever tightens -- a kill, a lower
        // ceiling, a deny -- takes the owner's session, because the moment
        // something looks wrong is not the moment to go looking for a phone.
        // Whatever loosens takes the second factor, because a stolen session
        // that could turn a capability back on, lift a spend pause or unfreeze
        // a role could undo every stop the owner made with it.
        method: 'POST',
        pattern: '/api/control/capability/:name/kill',
        handle: async ({ params, body }) => {
          if (body.on === false) {
            await this.#requireFactor(body.proof, `allow ${params.name!} again`);
            await reviveCapability(params.name!);
          } else {
            await killCapability(params.name!);
          }
          return { ok: true };
        },
      },

      {
        // Pausing one role: the smallest stop there is short of one task.
        // Resuming it is the route below and keeps its second factor.
        method: 'POST',
        pattern: '/api/control/company/:companyId/role/:roleId/pause',
        handle: async ({ params, body }) => {
          await pauseRole(params.companyId!, params.roleId!, typeof body.reason === 'string' ? body.reason : null);
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/company/:companyId/role/:roleId/resume',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'resume a frozen role', params.companyId!);
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
          const ceiling = wholeNumber(body.moneyMaxCents, 'moneyMaxCents');
          // Lowering is a session's; raising is the factor's (see the kill
          // switch above).
          const current = await limitFor(params.companyId!);
          if (ceiling > current.moneyMaxCents) {
            await this.#requireFactor(body.proof, 'raise the spend ceiling', params.companyId!);
          }
          await setSpendLimit(params.companyId!, ceiling);
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
          await this.#requireFactor(body.proof, 'let spending resume', params.companyId!);
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

      /* ------------------------------------------------------- languages --- */

      {
        // The panel's language, the agents' default, and what is offered.
        // The panel's is kept here rather than in the browser, which the
        // console never writes to, so it follows the owner to every device.
        method: 'GET',
        pattern: '/api/control/languages',
        handle: async () => ({
          ...(await deploymentLanguages()),
          supported: LANGUAGES.map((language) => ({ ...language })),
        }),
      },

      /* ------------------------------------------- the deployment's settings --- */

      {
        // What the deployment runs on, and where each choice came from. Secrets
        // are said to be set or not; their values never leave the server.
        method: 'GET',
        pattern: '/api/control/settings',
        handle: async () => {
          const deployment = this.#deploymentSettings();
          const effective = modelSettingsFrom(deployment.env);
          // What is stored now, which a save changes before the restart that takes it up.
          const stored = await readSettings();
          const chosen = stored.model as ModelSetting | undefined;
          return {
            model: {
              source: modelSource(deployment.baseEnv, deployment.settings),
              provider: effective?.provider ?? null,
              url: effective?.url ?? null,
              tiers: effective ? Object.fromEntries(MODEL_TIERS.map((tier) => [tier, effective.aliases[tier] ?? null])) : null,
              keySet: Boolean(deployment.env.PALUGADA_MODEL_KEY_REF),
              chosen: chosen
                ? {
                  preset: chosen.preset ?? null, provider: chosen.provider, url: chosen.url ?? null,
                  model: chosen.model ?? null, aliases: chosen.aliases ?? {},
                }
                : null,
            },
            providers: MODEL_PROVIDERS,
            secrets: await secretNames(),
            masterKey: deployment.master(false)?.source ?? null,
            applies: deployment.restart ? 'now' : 'next_start',
            // Saved, and not yet what this process runs on.
            pending: JSON.stringify(stored) !== JSON.stringify(deployment.settings),
          };
        },
      },

      {
        // Asks the model the owner is about to save one question that offers it
        // one tool. Nothing is saved; the key typed is used for this call only.
        method: 'POST',
        pattern: '/api/control/settings/model/test',
        handle: async ({ body }) => {
          const { env, secrets } = await this.#modelCandidate(body);
          try {
            modelSettingsFrom(env);
          } catch (failure) {
            return { problem: (failure as Error).message, warning: null };
          }
          return checkModel(env, secrets);
        },
      },

      {
        // The models the chosen API serves, so the owner picks one from a list
        // rather than typing a name from the provider's documentation.
        method: 'POST',
        pattern: '/api/control/settings/model/models',
        handle: async ({ body }) => {
          const { env, secrets } = await this.#modelCandidate(body);
          return listModels(env, secrets);
        },
      },

      {
        // Changes what every role runs on and what it costs, so it takes the
        // owner's device, like every other change of that weight.
        method: 'POST',
        pattern: '/api/control/settings/model',
        handle: async ({ body }) => {
          const deployment = this.#deploymentSettings();
          await this.#requireFactor(body.proof, 'change the model');
          // The stored model, not the one this process booted on: two saves
          // before a restart are two edits of the same setting.
          const stored = await readSettings();
          const candidate = modelSettingFrom(body, stored.model as ModelSetting | undefined);
          const typed = typeof body.key === 'string' && body.key.trim() !== '' ? body.key.trim() : null;
          if (typed) candidate.keySecret = 'model-key';
          // Refused here, with the reason, rather than at the next boot.
          modelSettingsFrom(withSettings(deployment.baseEnv, { ...stored, model: candidate }));
          if (candidate.provider === 'anthropic' && !candidate.keySecret) {
            throw new PalugadaError('contract.violation', 'Anthropic\'s API needs a key', { field: 'key' });
          }
          if (typed) {
            const master = deployment.master(true);
            if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
            await putSecret('model-key', typed, master);
          }
          await writeSetting('model', candidate);
          return this.#applySettings();
        },
      },

      {
        // Back to what the environment says, and the stored key with it.
        method: 'POST',
        pattern: '/api/control/settings/model/clear',
        handle: async ({ body }) => {
          this.#deploymentSettings();
          await this.#requireFactor(body.proof, 'change the model');
          await writeSetting('model', null);
          await deleteSecret('model-key');
          return this.#applySettings();
        },
      },

      /* ------------------------------------------ how the owner is reached --- */

      {
        // Each channel: whether it is set, from where, and whether it can hear
        // back. No credential leaves; a chat's id is not one.
        method: 'GET',
        pattern: '/api/control/channels',
        handle: async () => {
          const deployment = this.#deploymentSettings();
          const stored = (await readSettings()).channels as ChannelSettings | undefined;
          const env = deployment.baseEnv;
          const telegram = stored?.telegram;
          const push = stored?.push;
          return {
            publicUrl: env.PALUGADA_APP_URL_PUBLIC ?? null,
            applies: deployment.restart ? 'now' : 'next_start',
            telegram: {
              source: telegram ? 'console' : env.PALUGADA_TELEGRAM_CHAT ? 'environment' : null,
              chatId: telegram?.chatId ?? env.PALUGADA_TELEGRAM_CHAT ?? null,
              receives: telegram ? Boolean(telegram.webhookSecret) : Boolean(env.PALUGADA_TELEGRAM_WEBHOOK_SECRET || env.PALUGADA_TELEGRAM_WEBHOOK_SECRET_REF),
            },
            push: {
              source: push ? 'console' : env.PALUGADA_PUSH_URL ? 'environment' : null,
              format: push?.format ?? (env.PALUGADA_PUSH_FORMAT === 'ntfy' ? 'ntfy' : env.PALUGADA_PUSH_URL ? 'webhook' : null),
              url: push?.url ?? env.PALUGADA_PUSH_URL ?? null,
              topic: push?.topic ?? env.PALUGADA_PUSH_TOPIC ?? null,
              tokenSet: push ? Boolean(push.tokenSecret) : Boolean(env.PALUGADA_PUSH_TOKEN || env.PALUGADA_PUSH_TOKEN_REF),
            },
            slack: { source: stored?.slack ? 'console' : env.PALUGADA_SLACK_WEBHOOK || env.PALUGADA_SLACK_WEBHOOK_REF ? 'environment' : null },
            discord: { source: stored?.discord ? 'console' : env.PALUGADA_DISCORD_WEBHOOK || env.PALUGADA_DISCORD_WEBHOOK_REF ? 'environment' : null },
          };
        },
      },

      {
        // The bot a token belongs to, so the owner sees they pasted the right
        // one, and the link that opens their chat with it.
        method: 'POST',
        pattern: '/api/control/channels/telegram/bot',
        handle: async ({ body }) => ({ bot: await outside(telegramBot(await this.#telegramToken(body), this.#botApi())) }),
      },

      {
        // The chats that pressed Start: the owner's is found, not typed.
        method: 'POST',
        pattern: '/api/control/channels/telegram/chats',
        handle: async ({ body }) => ({ chats: await outside(telegramChats(await this.#telegramToken(body), this.#botApi())) }),
      },

      {
        // A message to the chat, with the words the console chose, before or
        // after saving: the one check that the whole path works.
        method: 'POST',
        pattern: '/api/control/channels/telegram/test',
        handle: async ({ body }) => {
          const token = await this.#telegramToken(body);
          const chatId = typeof body.chatId === 'string' && body.chatId ? body.chatId
            : (((await readSettings()).channels as ChannelSettings | undefined)?.telegram?.chatId ?? null);
          if (!chatId) throw new PalugadaError('contract.violation', 'find your chat first: press Start in the bot, then look for it', { field: 'chatId' });
          const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 500) : 'PALUGADA';
          await outside(telegramApi(token, 'sendMessage', { chat_id: chatId, text }, this.#botApi()));
          return { ok: true };
        },
      },

      {
        // The bot and the owner's chat with it, for everything the owner may be
        // shown and the buttons that decide. Its token and the secret Telegram
        // must send back are sealed; the webhook is set when this deployment
        // has a public address, and without one it sends and cannot hear.
        method: 'POST',
        pattern: '/api/control/channels/telegram',
        handle: async ({ body }) => {
          const deployment = this.#deploymentSettings();
          const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
          if (!/^-?\d{1,20}$/.test(chatId)) {
            throw new PalugadaError('contract.violation', 'find your chat first: press Start in the bot, then look for it', { field: 'chatId' });
          }
          const token = await this.#telegramToken(body);
          await outside(telegramBot(token, this.#botApi()));
          await this.#requireFactor(body.proof, 'connect Telegram');
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          const webhookSecret = randomBytes(24).toString('hex');
          await putSecret('channel-telegram', token, master);
          await putSecret('channel-telegram-webhook', webhookSecret, master);
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          channels.telegram = { chatId, tokenSecret: 'channel-telegram', webhookSecret: 'channel-telegram-webhook' };
          await writeSetting('channels', channels);
          let webhook: string = 'no_public_address';
          const publicUrl = deployment.baseEnv.PALUGADA_APP_URL_PUBLIC;
          if (publicUrl) {
            try {
              await telegramApi(token, 'setWebhook', {
                url: `${publicUrl.replace(/\/+$/, '')}/api/channels/telegram`,
                secret_token: webhookSecret,
                allowed_updates: ['message', 'callback_query'],
              }, this.#botApi());
              webhook = 'set';
            } catch (failure) {
              webhook = (failure as Error).message;
            }
          }
          return { ...this.#applySettings(), webhook };
        },
      },

      {
        // A push to the owner's phone, in the chosen format, before or after
        // saving: an alert the owner can see arrive.
        method: 'POST',
        pattern: '/api/control/channels/push/test',
        handle: async ({ body }) => {
          const { channel } = await this.#pushCandidate(body);
          await outside(channel.send({
            title: typeof body.title === 'string' && body.title ? body.title.slice(0, 120) : 'PALUGADA',
            body: typeof body.text === 'string' && body.text ? body.text.slice(0, 500) : 'PALUGADA',
            url: this.#deploymentSettings().baseEnv.PALUGADA_APP_URL_PUBLIC ?? null,
            urgent: false,
            tag: 'palugada-test',
          }));
          return { ok: true };
        },
      },

      {
        // F10.5's channel: an incident and a tier 3 approval, outside the
        // owner's hours too. It can wake them, so it takes their device.
        method: 'POST',
        pattern: '/api/control/channels/push',
        handle: async ({ body }) => {
          const deployment = this.#deploymentSettings();
          const { format, url, topic, typed, keep } = await this.#pushCandidate(body);
          await this.#requireFactor(body.proof, 'set up push notifications');
          if (typed) {
            const master = deployment.master(true);
            if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
            await putSecret('channel-push', typed, master);
          } else if (!keep) {
            await deleteSecret('channel-push');
          }
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          channels.push = { format, url, ...(topic ? { topic } : {}), ...(typed || keep ? { tokenSecret: 'channel-push' } : {}) };
          await writeSetting('channels', channels);
          return this.#applySettings();
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/channels/chat/:kind/test',
        handle: async ({ params, body }) => {
          const kind = chatKindNamed(params.kind!);
          const url = await this.#chatWebhook(kind, body);
          const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 500) : 'PALUGADA';
          await outside(new WebhookChatChannel({ kind, url }).send(text));
          return { ok: true };
        },
      },

      {
        // Slack or Discord, told what the owner may be shown, with a link to
        // decide it here: an incoming webhook cannot carry buttons.
        method: 'POST',
        pattern: '/api/control/channels/chat/:kind',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const kind = chatKindNamed(params.kind!);
          const url = await this.#chatWebhook(kind, body);
          await this.#requireFactor(body.proof, `connect ${kind === 'slack' ? 'Slack' : 'Discord'}`);
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          await putSecret(`channel-${kind}`, url, master);
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          channels[kind] = { urlSecret: `channel-${kind}` };
          await writeSetting('channels', channels);
          return this.#applySettings();
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/channels/:name/clear',
        handle: async ({ params, body }) => {
          this.#deploymentSettings();
          const name = params.name!;
          if (!['telegram', 'push', 'slack', 'discord'].includes(name)) {
            throw new PalugadaError('contract.violation', `a channel is telegram, push, slack or discord; got ${name}`, { name });
          }
          await this.#requireFactor(body.proof, `disconnect ${name}`);
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          delete channels[name as keyof ChannelSettings];
          await writeSetting('channels', Object.keys(channels).length > 0 ? channels : null);
          for (const secret of name === 'telegram' ? ['channel-telegram', 'channel-telegram-webhook'] : [`channel-${name}`]) {
            await deleteSecret(secret);
          }
          return this.#applySettings();
        },
      },

      /* ------------------------------------------ searching and reading --- */

      {
        // Which provider each tool goes to, where that choice came from, and
        // the providers there are. A key is said to be set, never shown.
        method: 'GET',
        pattern: '/api/control/tools',
        handle: async () => {
          const deployment = this.#deploymentSettings();
          const stored = (await readSettings()).tools as Partial<Record<ToolKind, ToolSetting>> | undefined;
          const kinds = Object.fromEntries((Object.keys(TOOL_KINDS) as ToolKind[]).map((kind) => {
            const names = TOOL_KINDS[kind];
            const chosen = stored?.[kind];
            const provider = chosen?.provider ?? deployment.baseEnv[names.provider] ?? null;
            const model = 'model' in names ? names.model : null;
            const voice = 'voice' in names ? names.voice : null;
            return [kind, {
              capability: names.capability,
              source: chosen ? 'console' : deployment.baseEnv[names.provider] ? 'environment' : null,
              provider,
              url: chosen ? chosen.url ?? null : deployment.baseEnv[names.url] ?? null,
              // Only the tools that have a model or a voice say which.
              ...(model ? { model: chosen ? chosen.model ?? null : deployment.baseEnv[model] ?? null } : {}),
              ...(voice ? { voice: chosen ? chosen.voice ?? null : deployment.baseEnv[voice] ?? null } : {}),
              keySet: chosen ? Boolean(chosen.keySecret) : Boolean(deployment.baseEnv[names.key]),
              inUse: Boolean(deployment.env[names.provider]),
            }];
          }));
          return {
            kinds,
            providers: {
              search: SEARCH_PROVIDERS, extract: EXTRACT_PROVIDERS, image: IMAGE_PROVIDERS, speech: SPEECH_PROVIDERS, listen: LISTEN_PROVIDERS,
            },
            filesRoot: Boolean(deployment.baseEnv.PALUGADA_FILES_ROOT),
            applies: deployment.restart ? 'now' : 'next_start',
          };
        },
      },

      {
        // One search, or one page read, with what the owner typed: the key is
        // used for this call and saved nowhere.
        method: 'POST',
        pattern: '/api/control/tools/:kind/test',
        // A recording to try Listening with is larger than a search.
        maxBodyBytes: 16 * 1024 * 1024,
        handle: async ({ params, body }) => {
          const { kind, binding } = await this.#toolCandidate(params.kind!, body);
          try {
            const signal = AbortSignal.timeout(kind === 'image' || kind === 'speech' || kind === 'listen' ? 120_000 : 30_000);
            if (kind === 'listen') {
              // A clip the owner recorded on the page, heard once and kept nowhere.
              const text = await transcribe({ ...binding as ToolBinding<ListenProvider>, model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null },
                audioFrom(body), typeof body.language === 'string' ? body.language : null, signal);
              return { problem: null, text };
            }
            if (kind === 'image' || kind === 'speech') {
              // Made and shown, not kept: the test is the owner's, not a company's.
              const media = { ...binding, root: '', model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
                voice: typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : null };
              const made = kind === 'image'
                ? await makeImage(media as MediaBinding<ImageProvider>, { prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'A lighthouse at dawn, flat illustration' }, signal)
                : await makeSpeech(media as MediaBinding<SpeechProvider>, { text: typeof body.text === 'string' && body.text.trim() ? body.text : 'PALUGADA' }, signal);
              return { problem: null, media: { mime: made.mime, bytes: made.bytes.length, dataUrl: `data:${made.mime};base64,${made.bytes.toString('base64')}` } };
            }
            if (kind === 'search') {
              const answer = await webSearch(binding as ToolBinding<SearchProvider>)
                .execute({ query: typeof body.query === 'string' && body.query.trim() ? body.query : 'PALUGADA', count: 3 }, { signal } as never);
              return { problem: null, results: answer.results };
            }
            const page = await webExtract(binding as ToolBinding<ExtractProvider>)
              .execute({ url: typeof body.url === 'string' && body.url ? body.url : 'https://example.com/' }, { signal } as never);
            return { problem: null, page: { url: page.url, title: page.title, excerpt: page.text.slice(0, 400) } };
          } catch (failure) {
            return { problem: (failure as Error).message };
          }
        },
      },

      {
        // Where every role's searches go, and what they cost, so it takes the
        // owner's device, like the model.
        method: 'POST',
        pattern: '/api/control/tools/:kind',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const { kind, provider, url, typed, keep } = await this.#toolCandidate(params.kind!, body);
          await this.#requireFactor(body.proof, `choose where ${TOOL_KINDS[kind].capability} goes`);
          const secret = `tool-${kind}`;
          if (typed) {
            const master = deployment.master(true);
            if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
            await putSecret(secret, typed, master);
          } else if (!keep) {
            await deleteSecret(secret);
          }
          const tools = { ...((await readSettings()).tools as Partial<Record<ToolKind, ToolSetting>> | undefined) };
          const text = (field: string) => (typeof body[field] === 'string' && (body[field] as string).trim() ? (body[field] as string).trim().slice(0, 120) : null);
          const model = kind === 'image' || kind === 'speech' || kind === 'listen' ? text('model') : null;
          const voice = kind === 'speech' ? text('voice') : null;
          tools[kind] = {
            provider: provider.id, ...(url ? { url } : {}), ...(typed || keep ? { keySecret: secret } : {}),
            ...(model ? { model } : {}), ...(voice ? { voice } : {}),
          };
          await writeSetting('tools', tools);
          return this.#applySettings();
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/tools/:kind/clear',
        handle: async ({ params, body }) => {
          this.#deploymentSettings();
          const kind = toolKindNamed(params.kind!);
          await this.#requireFactor(body.proof, `choose where ${TOOL_KINDS[kind].capability} goes`);
          const tools = { ...((await readSettings()).tools as Partial<Record<ToolKind, ToolSetting>> | undefined) };
          delete tools[kind];
          await writeSetting('tools', Object.keys(tools).length > 0 ? tools : null);
          await deleteSecret(`tool-${kind}`);
          return this.#applySettings();
        },
      },

      /* -------------------------------------------------- MCP servers --- */

      {
        // The servers the owner added, and how far each tool is trusted. A
        // token is said to be set, never shown; the operator's own file is
        // named, since its servers are bound next to these.
        method: 'GET',
        pattern: '/api/control/mcp',
        handle: async () => {
          const deployment = this.#deploymentSettings();
          const running = mcpNamesIn(deployment.env.PALUGADA_MCP_SETTINGS);
          return {
            servers: mcpServersIn(await readSettings()).map((server) => ({
              name: server.name,
              url: server.url,
              tokenSet: Boolean(server.tokenSecret),
              inUse: running.includes(server.name),
              ...(server.tokenIn ? { tokenIn: server.tokenIn } : {}),
              tools: server.tools,
            })),
            presets: MCP_PRESETS,
            file: deployment.baseEnv.PALUGADA_MCP_SERVERS ?? null,
            applies: deployment.restart ? 'now' : 'next_start',
          };
        },
      },

      {
        // What a server offers, before the owner allows any of it: each tool,
        // what it does, and what the server says of it. A token typed here is
        // used for this look and kept nowhere.
        method: 'POST',
        pattern: '/api/control/mcp/inspect',
        handle: async ({ body }) => {
          this.#deploymentSettings();
          const url = mcpUrl(body.url);
          const tokenIn = mcpTokenIn(body.tokenIn);
          const { token } = await this.#mcpToken(body, url);
          try {
            return { problem: null, tools: await offeredTools(accessFor({ url, ...(tokenIn ? { tokenIn } : {}) }, token)) };
          } catch (failure) {
            return { problem: (failure as Error).message };
          }
        },
      },

      {
        // A server and the tools roles may use from it, each at a tier. The
        // pins are taken from what the server offers now, and the whole of it
        // is held to the rules the operator's file is held to, before the
        // owner's device is asked for.
        method: 'POST',
        pattern: '/api/control/mcp/servers',
        handle: async ({ body }) => {
          const deployment = this.#deploymentSettings();
          const name = mcpServerNamed(body.name);
          const url = mcpUrl(body.url);
          const chosen = body.tools && typeof body.tools === 'object' && !Array.isArray(body.tools)
            ? body.tools as Record<string, Record<string, unknown>> : {};
          if (Object.keys(chosen).length === 0) {
            throw new PalugadaError('config.invalid', `${name} allows none of its tools: allow at least one, or remove the server`, { name });
          }
          const tokenIn = mcpTokenIn(body.tokenIn);
          const { token, typed, keep } = await this.#mcpToken(body, url);
          let pins: Map<string, string>;
          try {
            pins = await currentPins(accessFor({ url, ...(tokenIn ? { tokenIn } : {}) }, token));
          } catch (failure) {
            throw new PalugadaError('capability.unreachable', `${name} could not be asked what it offers: ${(failure as Error).message}`, { name });
          }
          const tools: McpServerSetting['tools'] = {};
          for (const [tool, raw] of Object.entries(chosen)) {
            const tier = raw?.tier;
            if (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 0 || tier > 3) {
              throw new PalugadaError('config.invalid', `${tool} needs a tier from 0 to 3`, { tool });
            }
            tools[tool] = {
              tier,
              ...(pins.has(tool) ? { pin: pins.get(tool)! } : {}),
              ...(raw.verify && typeof raw.verify === 'object' ? { verify: raw.verify as Record<string, unknown> } : {}),
            };
          }
          // The same check the next start makes, against a registry of its
          // own, so what the console saves is what the start will bind.
          try {
            await bindMcpServers(new CapabilityRegistry(),
              { servers: [{ name, url, tools, ...(tokenIn ? { tokenIn } : {}), ...(token ? { tokenRef: 'console://token' } : {}) }] }, name,
              { resolve: async () => token! });
          } catch (failure) {
            if (failure instanceof PalugadaError && failure.code === 'config.invalid') {
              throw new PalugadaError('config.invalid', failure.message.replace(`${name}: `, ''), { name });
            }
            throw failure;
          }
          await this.#requireFactor(body.proof, `let roles use the tools of ${name}`);
          const secret = `mcp-${name}`;
          if (typed) {
            const master = deployment.master(true);
            if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
            await putSecret(secret, typed, master);
          } else if (!keep) {
            await deleteSecret(secret);
          }
          const saved: McpServerSetting = { name, url, ...(tokenIn ? { tokenIn } : {}), ...(typed || keep ? { tokenSecret: secret } : {}), tools };
          const servers = mcpServersIn(await readSettings());
          const at = servers.findIndex((one) => one.name === name);
          if (at >= 0) servers[at] = saved;
          else servers.push(saved);
          await writeSetting('mcp', { servers });
          return this.#applySettings();
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/mcp/servers/:name/remove',
        handle: async ({ params, body }) => {
          this.#deploymentSettings();
          const name = params.name!;
          const servers = mcpServersIn(await readSettings());
          if (!servers.some((one) => one.name === name)) {
            throw new PalugadaError('contract.violation', `no MCP server named ${name} was added in the console`, { name });
          }
          await this.#requireFactor(body.proof, `stop roles using the tools of ${name}`);
          const rest = servers.filter((one) => one.name !== name);
          await writeSetting('mcp', rest.length > 0 ? { servers: rest } : null);
          await deleteSecret(`mcp-${name}`);
          return this.#applySettings();
        },
      },

      /* ------------------------------------------------- the assistant --- */

      {
        // The conversation, oldest first, with the cards still open.
        method: 'GET',
        pattern: '/api/assistant',
        handle: async () => ({
          available: Boolean(this.#options.assistant?.llm),
          voice: { listen: Boolean(this.#options.assistant?.voice?.listen), speak: Boolean(this.#options.assistant?.voice?.speak) },
          messages: await conversation(),
        }),
      },

      {
        // The owner says something; the assistant reads, checks and proposes,
        // in this process and with the owner's authority, and answers.
        method: 'POST',
        pattern: '/api/assistant/messages',
        handle: async ({ request, session, body }) => ({
          messages: await converse({
            llm: this.#options.assistant?.llm ?? null,
            reach: this.#reach(request, session),
            language: async () => (await deploymentLanguages()).console ?? 'en',
          }, requireText(body.text, 'text'), 'console'),
        }),
      },

      {
        // A card, applied by the owner: its route, called as the page would
        // call it, with the key they typed on the card and their device where
        // the route takes one. A refusal for want of the device leaves the card
        // open for them to try again with it; any other refusal closes it.
        method: 'POST',
        pattern: '/api/assistant/proposals/:proposalId/apply',
        handle: async ({ request, session, params, body }) => {
          const proposal = await proposalById(params.proposalId!);
          if (!proposal) throw new PalugadaError('contract.violation', 'no such proposal', { proposalId: params.proposalId });
          if (proposal.status !== 'open') throw new PalugadaError('contract.violation', `that card was already ${proposal.status}`, {});
          if (!patternFor(proposal.path, ASSISTANT_ACTIONS.map((action) => action.pattern))) {
            throw new PalugadaError('contract.violation', `${proposal.path} is not something the assistant may propose`, {});
          }
          const typed: Record<string, string> = {};
          const given = body.secrets && typeof body.secrets === 'object' ? body.secrets as Record<string, unknown> : {};
          for (const [field, value] of Object.entries(given)) {
            if (!(field in proposal.secrets)) throw new PalugadaError('contract.violation', `this card has no field ${field}`, { field });
            if (typeof value === 'string' && value.trim()) typed[field] = value.trim();
          }
          try {
            const result = await this.#dispatch('POST', proposal.path, {
              ...proposal.body, ...typed, ...(body.proof === undefined ? {} : { proof: body.proof }),
            }, request, session);
            await closeProposal(proposal.id, 'applied', outcomeOf(result));
            return { ok: true, result };
          } catch (failure) {
            const code = failure instanceof PalugadaError ? failure.code : '';
            if (code !== 'approval.channel_forbidden' && !code.startsWith('mfa.')) {
              await closeProposal(proposal.id, 'failed', (failure as Error).message);
            }
            throw failure;
          }
        },
      },

      {
        // What the owner said aloud, written down by the provider chosen
        // under Tools, Listening, in the console's language. The recording is
        // heard once and kept nowhere; the words go into the conversation as
        // if typed, and so past the same check for a key.
        method: 'POST',
        pattern: '/api/assistant/listen',
        maxBodyBytes: 16 * 1024 * 1024,
        handle: async ({ body }) => {
          const listen = this.#options.assistant?.voice?.listen;
          if (!listen) {
            throw new PalugadaError('capability.unknown', 'nothing hears speech yet: choose a provider under This deployment, Tools, Listening', {});
          }
          const language = (await deploymentLanguages()).console ?? null;
          return { text: await transcribe(listen, audioFrom(body), language, AbortSignal.timeout(60_000)) };
        },
      },

      {
        // An answer, said aloud by the speech provider chosen under Tools. Not
        // kept: the owner hears it and it is gone.
        method: 'POST',
        pattern: '/api/assistant/speak',
        handle: async ({ body }) => {
          const speak = this.#options.assistant?.voice?.speak;
          if (!speak) {
            throw new PalugadaError('capability.unknown', 'nothing speaks yet: choose a provider under This deployment, Tools, Speaking', {});
          }
          // A long answer is read to its first two thousand characters; the rest is on the page.
          const made = await makeSpeech(speak, { text: requireText(body.text, 'text').slice(0, 2_000) }, AbortSignal.timeout(60_000));
          return { mime: made.mime, dataUrl: `data:${made.mime};base64,${made.bytes.toString('base64')}` };
        },
      },

      {
        method: 'POST',
        pattern: '/api/assistant/proposals/:proposalId/dismiss',
        handle: async ({ params }) => {
          if (!await closeProposal(params.proposalId!, 'dismissed', '')) {
            throw new PalugadaError('contract.violation', 'that card is not open', {});
          }
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/assistant/clear',
        handle: async () => {
          await forgetConversation();
          return { ok: true };
        },
      },

      /* ------------------------------------------------ the agent CLIs --- */

      {
        // Each agent CLI this platform knows: whether it is installed and
        // where, whether it is signed in (never with what), and whether roles
        // may run on it -- saved, and in use now, which differ until a restart.
        method: 'GET',
        pattern: '/api/control/agents',
        handle: async () => {
          const deployment = this.#deploymentSettings();
          const stored = await readSettings();
          const agents = agentsFrom(stored, deployment.baseEnv);
          const stateDir = stateDirFrom(deployment.baseEnv);
          const inUse = (deployment.env.PALUGADA_AGENT_CLIS ?? '').split(',').map((name) => name.trim());
          const rows = [];
          for (const entry of AGENT_CATALOGUE) {
            const setting = agents[entry.name];
            rows.push({
              name: entry.name,
              title: entry.title,
              about: entry.about,
              installed: await findAgent(entry, stateDir),
              cannotInstall: cannotInstall(entry),
              tested: entry.install.kind === 'npm' ? entry.install.tested : null,
              enabled: setting?.enabled ?? false,
              inUse: inUse.includes(entry.name),
              credential: setting?.credential
                ? { kind: setting.credential.kind ?? null, variable: setting.credential.variable }
                : null,
              credentialKinds: entry.credentials,
              models: setting?.models ?? {},
              job: this.#agentJobs.get(entry.name),
            });
          }
          return { agents: rows, source: stored.agents ? 'console' : 'environment', applies: deployment.restart ? 'now' : 'next_start' };
        },
      },

      {
        // Runs the publisher's package installer on this machine, so it takes
        // the owner's device. The install runs on after this answers; the
        // console follows it on the route below.
        method: 'POST',
        pattern: '/api/control/agents/:name/install',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          const refused = cannotInstall(entry);
          if (refused) throw new PalugadaError('contract.violation', refused, { agent: entry.name });
          const version = body.version === 'latest' ? 'latest' : 'tested';
          await this.#requireFactor(body.proof, `install ${entry.title} on this server`);
          const stateDir = stateDirFrom(deployment.baseEnv);
          const job = this.#agentJobs.start(entry.name, 'install', async ({ log }) => {
            const found = await installAgent(entry, stateDir, version, log);
            // Read again now, not when the install began: the owner may have
            // changed another CLI in the minutes it took.
            const agents = agentsFrom(await readSettings(), deployment.baseEnv);
            const current = agents[entry.name] ?? { enabled: false };
            agents[entry.name] = { ...current, command: found.command };
            await writeSetting('agents', agents);
            if (current.enabled) this.#applySettings();
          });
          return { job };
        },
      },

      {
        method: 'GET',
        pattern: '/api/control/agents/:name/job',
        handle: async ({ params }) => {
          this.#deploymentSettings();
          return { job: this.#agentJobs.get(agentNamed(params.name!).name) };
        },
      },

      {
        // Signs the CLI in with the owner's subscription, driven from here: the
        // CLI prints a page, the owner opens it in their own browser, and the
        // code that page shows comes back through the route below. The token
        // it ends with is sealed like any other credential.
        method: 'POST',
        pattern: '/api/control/agents/:name/login',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          const kind = entry.credentials.find((one) => one.login);
          if (!kind) {
            throw new PalugadaError('contract.violation',
              `${entry.title} cannot be signed in from the console; paste its key instead`, { agent: entry.name });
          }
          const stateDir = stateDirFrom(deployment.baseEnv);
          const found = await findAgent(entry, stateDir);
          if (!found) {
            throw new PalugadaError('contract.violation', `${entry.title} is not installed where PALUGADA runs: install it first`, { agent: entry.name });
          }
          await this.#requireFactor(body.proof, `sign ${entry.title} in with your subscription`);
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          const job = this.#agentJobs.start(entry.name, 'login', (controls) => claudeSetupToken(found.command, join(stateDir, 'agents'), controls, async (token) => {
            const secret = `agent-${entry.name}`;
            await putSecret(secret, token, master);
            const agents = agentsFrom(await readSettings(), deployment.baseEnv);
            const current = agents[entry.name] ?? { enabled: false };
            agents[entry.name] = { ...current, credential: { kind: kind.id, variable: kind.variable, secret }, env: { ...(kind.env ?? {}) } };
            await writeSetting('agents', agents);
            if (current.enabled) this.#applySettings();
          }));
          return { job };
        },
      },

      {
        // The code the sign-in page showed the owner. The sign-in was started
        // with their device; the code is proof of the account, not of them.
        method: 'POST',
        pattern: '/api/control/agents/:name/login/code',
        handle: async ({ params, body }) => {
          this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          const code = typeof body.code === 'string' ? body.code.trim() : '';
          if (code === '') throw new PalugadaError('contract.violation', 'paste the code the sign-in page shows', { field: 'code' });
          const job = this.#agentJobs.answer(entry.name, code);
          if (!job) {
            throw new PalugadaError('contract.violation', `no sign-in of ${entry.title} is waiting for a code: start it again`, { agent: entry.name });
          }
          return { job };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/agents/:name/login/cancel',
        handle: async ({ params }) => {
          this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          this.#agentJobs.cancel(entry.name);
          return { job: this.#agentJobs.get(entry.name) };
        },
      },

      {
        // The CLI's own credential: an API key, or a subscription's token. It
        // is sealed like the model's key and handed to each run under the one
        // variable the CLI reads; the value is never shown again.
        method: 'POST',
        pattern: '/api/control/agents/:name/credential',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          const kind = entry.credentials.find((one) => one.id === body.kind);
          if (!kind) {
            throw new PalugadaError('contract.violation',
              `${entry.title} signs in with one of ${entry.credentials.map((one) => one.id).join(', ')}; got ${String(body.kind)}`,
              { field: 'kind' });
          }
          const value = typeof body.value === 'string' ? body.value.trim() : '';
          if (value.length < 8 || /\s/.test(value)) {
            throw new PalugadaError('contract.violation', `paste the whole ${kind.label}, with no spaces in it`, { field: 'value' });
          }
          await this.#requireFactor(body.proof, `sign ${entry.title} in`);
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          const secret = `agent-${entry.name}`;
          await putSecret(secret, value, master);
          const agents = agentsFrom(await readSettings(), deployment.baseEnv);
          const current = agents[entry.name] ?? { enabled: false };
          agents[entry.name] = { ...current, credential: { kind: kind.id, variable: kind.variable, secret }, env: { ...(kind.env ?? {}) } };
          await writeSetting('agents', agents);
          return current.enabled ? this.#applySettings() : { applies: 'when_enabled' };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/agents/:name/credential/clear',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          await this.#requireFactor(body.proof, `sign ${entry.title} out`);
          const agents = agentsFrom(await readSettings(), deployment.baseEnv);
          const current = agents[entry.name] ?? { enabled: false };
          const { credential: _credential, env: _env, ...rest } = current;
          agents[entry.name] = rest;
          await writeSetting('agents', agents);
          await deleteSecret(`agent-${entry.name}`);
          return current.enabled ? this.#applySettings() : { applies: 'when_enabled' };
        },
      },

      {
        // Whether roles may run on it, and what each tier means to it. A role
        // already naming it keeps doing so; one that names a CLI that is off
        // halts with the reason, which is why turning one off asks too.
        method: 'POST',
        pattern: '/api/control/agents/:name/settings',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          if (typeof body.enabled !== 'boolean') {
            throw new PalugadaError('contract.violation', 'enabled is true or false', { field: 'enabled' });
          }
          const models: Record<string, string> = {};
          if (body.models !== undefined && body.models !== null) {
            if (typeof body.models !== 'object' || Array.isArray(body.models)) {
              throw new PalugadaError('contract.violation', 'models maps fast, standard and deep to a model', { field: 'models' });
            }
            for (const [tier, name] of Object.entries(body.models as Record<string, unknown>)) {
              if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
                throw new PalugadaError('contract.violation', `a tier is fast, standard or deep; got ${tier}`, { field: 'models' });
              }
              if (typeof name === 'string' && name.trim() !== '') models[tier] = name.trim();
            }
          }
          if (body.enabled && !(await findAgent(entry, stateDirFrom(deployment.baseEnv)))) {
            throw new PalugadaError('contract.violation',
              `${entry.title} is not installed where PALUGADA runs: install it first`, { agent: entry.name });
          }
          await this.#requireFactor(body.proof, `change whether roles run on ${entry.title}`);
          const agents = agentsFrom(await readSettings(), deployment.baseEnv);
          agents[entry.name] = { ...(agents[entry.name] ?? {}), enabled: body.enabled, models };
          await writeSetting('agents', agents);
          return this.#applySettings();
        },
      },

      {
        // Whether the console should walk the owner through itself. Kept here
        // rather than in the browser, like every preference (0064).
        method: 'GET',
        pattern: '/api/control/tour',
        handle: async () => withControlPlane(async (tx) => {
          const { rows } = await tx.query<{ tour_finished_at: Date | null }>(
            'SELECT tour_finished_at FROM platform_control',
          );
          return { finishedAt: rows[0]?.tour_finished_at?.toISOString() ?? null };
        }),
      },

      {
        // Finished or skipped; `false` to see it again.
        method: 'POST',
        pattern: '/api/control/tour',
        handle: async ({ body }) => {
          if (typeof body.finished !== 'boolean') {
            throw new PalugadaError('contract.violation', 'finished is true or false', { field: 'finished' });
          }
          return withControlPlane(async (tx) => {
            const { rows } = await tx.query<{ tour_finished_at: Date | null }>(
              `UPDATE platform_control SET tour_finished_at = CASE WHEN $1::boolean THEN now() END
               RETURNING tour_finished_at`,
              [body.finished],
            );
            return { finishedAt: rows[0]?.tour_finished_at?.toISOString() ?? null };
          });
        },
      },

      {
        // Not a loosening of anything, so no factor: a language changes what
        // is written, never what is allowed.
        method: 'POST',
        pattern: '/api/control/languages',
        handle: async ({ body }) => {
          const change: { console?: string | null; agents?: string } = {};
          if (body.console !== undefined) {
            change.console = body.console === null ? null : languageCode(body.console, 'console');
          }
          if (body.agents !== undefined) change.agents = languageCode(body.agents, 'agents');
          if (Object.keys(change).length === 0) {
            throw new PalugadaError('contract.violation', 'give console, agents, or both', {});
          }
          return setDeploymentLanguages(change);
        },
      },

      {
        // What the company produces in, and what its agents say to the owner
        // and each other in. Both are required, and null is an answer: the
        // deployment's default. Every run from here on is told the new rule
        // first (src/context/builder.ts).
        method: 'POST',
        pattern: '/api/companies/:companyId/languages',
        handle: async ({ params, body }) => {
          if (body.work === undefined || body.talk === undefined) {
            throw new PalugadaError('contract.violation', 'give work and talk; null means the default', {});
          }
          const work = body.work === null ? null : languageCode(body.work, 'work');
          const talk = body.talk === null ? null : languageCode(body.talk, 'talk');
          await setCompanyLanguages(params.companyId!, { work, talk });
          return withTenant(params.companyId!, (tx) => languagesFor(tx, params.companyId!));
        },
      },

      {
        // Where the company is in its life (0057). Moving it to a later stage
        // loosens whatever policies read the stage -- paid reach opens at
        // launch -- so that takes the owner's device; moving back or to
        // winding down only closes things, and the session is enough.
        method: 'POST',
        pattern: '/api/companies/:companyId/stage',
        handle: async ({ params, body }) => {
          const to = assertStage(body.stage);
          const current = await withTenant(params.companyId!, (tx) => stageOf(tx, params.companyId!));
          if (loosens(current, to)) {
            await this.#requireFactor(body.proof, `move the company to the ${to} stage`, params.companyId!);
          }
          return setStage(params.companyId!, to, typeof body.note === 'string' ? body.note : undefined);
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

      {
        // What the task produced: its output and every draft it committed.
        // The events above say what it did; this is the thing it was for,
        // which the owner could not see anywhere -- a blog post approved and
        // never read.
        method: 'GET',
        pattern: '/api/companies/:companyId/tasks/:taskId',
        handle: async ({ params }) => {
          const task = await taskDetailOf(params.companyId!, params.taskId!);
          if (!task) {
            throw new PalugadaError('contract.violation', 'no such task in this company', { taskId: params.taskId });
          }
          return { task };
        },
      },

      {
        // What the task's runs said as they worked, oldest first (0055). The
        // console polls it while the task is live, which is as close to
        // watching an agent think as the owner needs to get.
        method: 'GET',
        pattern: '/api/companies/:companyId/tasks/:taskId/transcript',
        handle: async ({ params, query }) => ({
          notes: await transcriptOf(params.companyId!, params.taskId!, Number(query.get('limit') ?? 200) || 200),
        }),
      },

      {
        // One task stopped, with whatever it started, and nothing else. The
        // brakes above are for everything at once; this is the one for "that
        // task is going the wrong way". Tightening, so the session suffices.
        method: 'POST',
        pattern: '/api/companies/:companyId/tasks/:taskId/cancel',
        handle: async ({ params, body }) => ({
          cancelled: await cancelTask(
            params.companyId!, params.taskId!, typeof body.reason === 'string' ? body.reason : null,
          ),
        }),
      },

      {
        // The same work again, as a new task, with the owner's note in front
        // of the run. The only way on from a halted task, which is never
        // resumed (section 6.3).
        method: 'POST',
        pattern: '/api/companies/:companyId/tasks/:taskId/rerun',
        handle: async ({ params, body }) => ({
          taskId: await rerunTask(params.companyId!, params.taskId!, typeof body.note === 'string' ? body.note : null),
        }),
      },

      {
        // The owner's word on finished work, which its division reads next
        // time as a way to work. Informs, loosens nothing: the session.
        method: 'POST',
        pattern: '/api/companies/:companyId/tasks/:taskId/feedback',
        handle: async ({ params, body }) => {
          await giveFeedback(params.companyId!, params.taskId!, {
            verdict: body.verdict as Verdict,
            note: typeof body.note === 'string' ? body.note : null,
          });
          return { ok: true };
        },
      },

      {
        // Telling a task something it reads on its next run.
        method: 'POST',
        pattern: '/api/companies/:companyId/tasks/:taskId/instruct',
        handle: async ({ params, body }) => {
          await instructTask(params.companyId!, params.taskId!, requireText(body.text, 'text'));
          return { ok: true };
        },
      },

      {
        // An inbound trigger (0054, 0056): the one route a service outside
        // the company calls. No session, because the caller is not the owner;
        // the trigger's token or its sender's signature stands in for one,
        // checked before anything else is read. The body goes on as the bytes
        // that arrived, because a signature is over those bytes -- a body
        // parsed and written out again is a different body -- and because a
        // sender may post a form or text rather than JSON.
        method: 'POST',
        pattern: '/api/hooks/:publicId',
        open: true,
        raw: true,
        maxBodyBytes: 256 * 1024,
        handle: async ({ params, request, raw }) =>
          receiveHook(params.publicId!, { raw, headers: request.headers }, this.#options.secrets),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/handoffs',
        handle: async ({ params }) => ({ handoffs: await handoffRulesOf(params.companyId!) }),
      },

      {
        // A chain starts work without anyone asking each time, so making one
        // takes the device, as a schedule's is the owner's to set (0058).
        method: 'POST',
        pattern: '/api/companies/:companyId/handoffs',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'let one role start work for another', params.companyId!);
          return {
            ruleId: await createHandoffRule(params.companyId!, {
              fromRoleId: requireText(body.fromRoleId, 'fromRoleId'),
              toRoleId: requireText(body.toRoleId, 'toRoleId'),
              brief: requireText(body.brief, 'brief'),
            }),
          };
        },
      },

      {
        // Switching one off is the session's; on again is the device's.
        method: 'POST',
        pattern: '/api/companies/:companyId/handoffs/:ruleId',
        handle: async ({ params, body }) => {
          const enabled = body.enabled === true;
          if (enabled) await this.#requireFactor(body.proof, 'switch a handoff back on', params.companyId!);
          await setHandoffRuleEnabled(params.companyId!, params.ruleId!, enabled);
          return { ok: true };
        },
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/triggers',
        handle: async ({ params }) => ({ triggers: await triggersOf(params.companyId!) }),
      },

      {
        // Opening a door for outside events loosens what can start work in the
        // company, so it takes the owner's device. The token is in this answer
        // and nowhere else, ever.
        method: 'POST',
        pattern: '/api/companies/:companyId/triggers',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'let outside events start work', params.companyId!);
          return createTrigger(params.companyId!, {
            slug: requireText(body.slug, 'slug'),
            roleId: requireText(body.roleId, 'roleId'),
            goalId: requireText(body.goalId, 'goalId'),
            instruction: requireText(body.instruction, 'instruction'),
            ...(body.maxPerHour === undefined ? {} : { maxPerHour: wholeNumber(body.maxPerHour, 'maxPerHour') }),
            ...(body.scheme === undefined ? {} : { scheme: body.scheme as TriggerScheme }),
            ...(typeof body.secretRef === 'string' ? { secretRef: body.secretRef } : {}),
          }, this.#options.secrets);
        },
      },

      {
        // A new token, the old one dead at once: tightening, so the session.
        // For a signed trigger, where its secret is now kept.
        method: 'POST',
        pattern: '/api/companies/:companyId/triggers/:triggerId/rotate',
        handle: async ({ params, body }) => rotateTriggerToken(params.companyId!, params.triggerId!, {
          ...(typeof body.secretRef === 'string' ? { secretRef: body.secretRef } : {}),
          ...(this.#options.secrets ? { secrets: this.#options.secrets } : {}),
        }),
      },

      {
        // Closing is the session's; opening again is the device's.
        method: 'POST',
        pattern: '/api/companies/:companyId/triggers/:triggerId',
        handle: async ({ params, body }) => {
          const enabled = body.enabled === true;
          if (enabled) await this.#requireFactor(body.proof, 'open a trigger again', params.companyId!);
          await setTriggerEnabled(params.companyId!, params.triggerId!, enabled);
          return { ok: true };
        },
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
        handle: async ({ params, query }) => withTenant(params.companyId!, async (tx) => {
          // The project too, because `createRootTask` passes it: without it
          // this reported the company account while a project-scoped one was
          // what the work is actually charged to, which is the one thing an
          // owner reads this route to find out.
          const accountId = await accountFor(tx, {
            companyId: params.companyId!,
            divisionId: params.divisionId!,
            roleId: params.roleId!,
            projectId: query.get('project'),
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
        // Opening an account sets a ceiling, which is money -- the same
        // decision as `spend/limit`, and F2.9's reasoning applies for the same
        // reason it applies to a grant. A session is a browser tab.
        method: 'POST',
        pattern: '/api/companies/:companyId/budget-accounts',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'open a budget account', params.companyId!);
          return withTenant(params.companyId!, async (tx) => ({
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
          }));
        },
      },

      /* ---------------------------------------------------- measured goals --- */

      {
        // What a goal is measured by (0053). The owner's, like the goal: an
        // agent that could set its own target could meet any target. No
        // factor, because adding a measure loosens nothing.
        method: 'POST',
        pattern: '/api/companies/:companyId/goals/:goalId/metrics',
        handle: async ({ params, body }) => {
          const target = Number(body.target);
          const baseline = body.baseline === undefined ? 0 : Number(body.baseline);
          const id = await defineMetric(params.companyId!, {
            goalId: params.goalId!,
            slug: requireText(body.slug, 'slug'),
            name: requireText(body.name, 'name'),
            unit: requireText(body.unit, 'unit') as MetricUnit,
            direction: body.direction === 'down' ? 'down' : 'up',
            baseline,
            target,
            dueOn: typeof body.dueOn === 'string' && body.dueOn ? body.dueOn : null,
            sourceCapability: typeof body.sourceCapability === 'string' && body.sourceCapability ? body.sourceCapability : null,
          });
          return { id };
        },
      },

      {
        // The owner's own reading of a number -- from a bank statement, a
        // dashboard the platform cannot reach. Verified by being the owner's.
        method: 'POST',
        pattern: '/api/companies/:companyId/metrics/:metricId/observations',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => {
          const recorded = await recordObservation(tx, {
            companyId: params.companyId!,
            metric: params.metricId!,
            value: Number(body.value),
            recordedBy: 'owner',
            note: typeof body.note === 'string' ? body.note : null,
          });
          return { id: recorded.id, verified: recorded.verified };
        }),
      },

      /* ------------------------------------------------------------ F4.6 --- */

      {
        // The owner telling the company something: a fact to know, or a way
        // to work, for the whole company or one division. Said by the owner,
        // so it is written at full confidence and is active at once -- the
        // review a learned fact waits for exists to get the owner's word,
        // and this is the owner's word.
        method: 'POST',
        pattern: '/api/companies/:companyId/memories',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => {
          if (body.kind !== 'semantic' && body.kind !== 'procedural') {
            throw new PalugadaError(
              'contract.violation', 'kind must be semantic (a fact) or procedural (a way to work)', { field: 'kind' },
            );
          }
          const divisionId = body.divisionId === undefined || body.divisionId === null
            ? null : requireText(body.divisionId, 'divisionId');
          if (divisionId) {
            const { rows } = await tx.query('SELECT 1 FROM divisions WHERE id = $1', [divisionId]);
            if (rows.length === 0) {
              throw new PalugadaError('contract.violation', 'no such division in this company', { field: 'divisionId' });
            }
          }
          const id = await remember(tx, {
            companyId: params.companyId!,
            memoryType: body.kind,
            scopeType: divisionId ? 'division' : 'company',
            ...(divisionId ? { scopeId: divisionId } : {}),
            body: requireText(body.body, 'body'),
            confidence: 1,
            source: 'owner',
          });
          await appendEvent(tx, {
            companyId: params.companyId!,
            type: 'memory.told',
            actor: 'owner',
            payload: { memoryId: id, kind: body.kind, divisionId },
          });
          return { id };
        }),
      },

      {
        // Replacing a fact rather than deleting it.
        //
        // A memory that turned out to be wrong is not removed: it is
        // superseded, and the old row keeps pointing at what replaced it. An
        // agent that read the old fact yesterday and a person asking why it
        // did are both better served by a chain than by a hole.
        method: 'POST',
        pattern: '/api/companies/:companyId/memories/:memoryId/supersede',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => {
          // The replacement takes the original's type and scope.
          //
          // Hardcoding `semantic`/`company` -- which the first version did --
          // meant correcting a division's procedure wrote a company-wide fact:
          // the old procedure was superseded and the new one was not a
          // procedure, so `recall` found neither and the SOP vanished from
          // every agent's context. A correction that deletes the thing it
          // corrects is the worst possible shape for this.
          const { rows } = await tx.query<{
            memory_type: string;
            scope_type: string;
            scope_id: string | null;
          }>(
            'SELECT memory_type, scope_type, scope_id FROM memories WHERE id = $1',
            [params.memoryId!],
          );
          const original = rows[0];
          if (!original) {
            throw new PalugadaError('contract.violation', 'no such memory', {});
          }

          return {
            id: await supersede(tx, params.memoryId!, {
              companyId: params.companyId!,
              memoryType: original.memory_type as 'semantic',
              scopeType: original.scope_type as 'company',
              ...(original.scope_id === null ? {} : { scopeId: original.scope_id }),
              body: requireText(body.body, 'body'),
              // A correction is the owner's word, and says so: the page shows
              // where a fact came from, and "not recorded" for the owner's own
              // correction was a fact about this route rather than the fact.
              source: 'owner',
              ...(body.confidence === undefined
                ? {}
                : { confidence: Number(body.confidence) }),
            }),
          };
        }),
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
        // Hiring (F2.9: adding a role is tier 3, so it takes the owner's
        // device). The role is complete enough to be given work at once, and
        // the answer names any tool its division cannot use yet.
        method: 'POST',
        pattern: '/api/companies/:companyId/roles',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'hire a role', params.companyId!);
          return addRole(params.companyId!, {
            divisionId: requireText(body.divisionId, 'divisionId'),
            slug: requireText(body.slug, 'slug'),
            systemPrompt: requireText(body.systemPrompt, 'systemPrompt'),
            tools: body.tools === undefined ? [] : textList(body.tools, 'tools'),
            doneCriteria: body.doneCriteria === undefined ? [] : textList(body.doneCriteria, 'doneCriteria'),
            ...(body.model === undefined ? {} : { model: requireText(body.model, 'model') }),
          }, { ownerApproved: true });
        },
      },

      {
        // A new division is tier 3 as well (F2.9).
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'open a division', params.companyId!);
          return {
            divisionId: await addDivision(params.companyId!, {
              slug: requireText(body.slug, 'slug'),
              name: requireText(body.name, 'name'),
              ...(typeof body.parentDivisionId === 'string' && body.parentDivisionId
                ? { parentDivisionId: body.parentDivisionId } : {}),
              ...(body.maxConcurrency === undefined ? {} : { maxConcurrency: wholeNumber(body.maxConcurrency, 'maxConcurrency') }),
            }, { ownerApproved: true }),
          };
        },
      },

      {
        // A project groups work and grants nothing, so the session is enough.
        method: 'POST',
        pattern: '/api/companies/:companyId/projects',
        handle: async ({ params, body }) => ({
          projectId: await addProject(params.companyId!, {
            slug: requireText(body.slug, 'slug'), name: requireText(body.name, 'name'),
          }),
        }),
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
          if (body.runtime !== undefined) {
            // Only one this deployment runs. A role moved onto a runtime
            // nothing here employs halts on its next task, and the owner
            // would learn of the typo from an incident.
            const runtime = requireText(body.runtime, 'runtime');
            const here = this.#options.runtimes?.names() ?? [];
            if (!here.includes(runtime)) {
              throw new PalugadaError('contract.violation',
                `no runtime named ${runtime} runs here; this deployment runs ${here.join(', ') || 'none'}`,
                { runtime });
            }
            fields.runtime = runtime;
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
        //
        // Behind the factor, all of it. A policy is the rule the engine
        // enforces on every agent, and a new or changed one is as likely to
        // loosen as to tighten -- a condition narrowed, a mode set to
        // log_only -- so a session alone could have switched enforcement off.
        method: 'POST',
        pattern: '/api/policies',
        handle: async ({ body }) => {
          // Everything that can be checked without the factor is checked
          // first, so a typo in a condition costs the owner a correction
          // rather than a code.
          const policy = {
            slug: requireText(body.slug, 'slug'),
            // Checked against the list rather than cast: an effect the engine
            // does not know is a policy that reads as a rule and enforces
            // nothing, and `putPolicy` would store it happily.
            effect: policyEffect(body.effect),
            condition: body.condition as Condition,
            ...(body.companyId === undefined ? {} : { companyId: String(body.companyId) }),
            ...(body.divisionId === undefined ? {} : { divisionId: String(body.divisionId) }),
            ...(body.mode === undefined
              ? {}
              : { mode: String(body.mode) as 'enforce' | 'log_only' }),
            ...(body.params === undefined
              ? {}
              : { params: body.params as Record<string, unknown> }),
          };
          assertValidCondition(policy.condition);
          await this.#requireFactor(body.proof, 'write a policy', policy.companyId ?? null);
          return { id: await putPolicy(policy) };
        },
      },

      {
        // What the company's policies are. The console could write one and
        // not show any: an owner deciding whether to add a rule could not see
        // the rules already there. The platform's own are listed too, because
        // they outrank every company's and a company rule may only tighten
        // them (F3.5).
        method: 'GET',
        pattern: '/api/companies/:companyId/policies',
        handle: async ({ params }) => withTenant(params.companyId!, async (tx) => {
          const { rows } = await tx.query<{
            id: string; slug: string; effect: string; condition: unknown; mode: string;
            scope: string; division: string | null; created_at: Date;
          }>(
            `SELECT p.id, p.slug, p.effect, p.condition, p.mode, p.created_at,
                    CASE WHEN p.company_id IS NULL THEN 'platform'
                         WHEN p.division_id IS NULL THEN 'company' ELSE 'division' END AS scope,
                    d.name AS division
               FROM policies p LEFT JOIN divisions d ON d.id = p.division_id
              ORDER BY (p.company_id IS NULL) DESC, p.division_id NULLS FIRST, p.slug`,
          );
          return {
            policies: rows.map((row) => ({
              id: row.id, slug: row.slug, effect: row.effect, condition: row.condition, mode: row.mode,
              scope: row.scope, division: row.division, createdAt: row.created_at,
            })),
          };
        }),
      },

      {
        // F3.9: every recorded version of one piece of configuration, newest
        // first, with what it held.
        method: 'GET',
        pattern: '/api/companies/:companyId/config/:kind/history',
        handle: async ({ params, query }) => ({
          versions: await configHistory(
            params.companyId!, configKind(params.kind), query.get('subject') || null,
          ),
        }),
      },

      {
        // F3.9's one click. A version put back can widen what a role may do
        // or loosen a rule, so it takes the owner's device.
        method: 'POST',
        pattern: '/api/companies/:companyId/config/:kind/rollback',
        handle: async ({ params, body }) => {
          const kind = configKind(params.kind);
          const version = wholeNumber(body.version, 'version');
          await this.#requireFactor(body.proof, `put back version ${version} of a ${kind}`, params.companyId!);
          return rollBack(
            params.companyId!, kind, typeof body.subjectId === 'string' ? body.subjectId : null, version,
          );
        },
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
        // Activating a skill puts its text in front of every agent it reaches,
        // which is the one thing a skill's review exists to control.
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'activate a skill', params.companyId!);
          return approveSkillVersion(params.companyId!, params.versionId!);
        },
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
          // Read before the factor is spent, so a pairing missing its key
          // does not cost the owner a code.
          const keyFingerprint = requireText(body.keyFingerprint, 'keyFingerprint');
          await this.#requireFactor(body.proof, 'pair a device', params.companyId!);
          await pairDevice(params.companyId!, params.deviceId!, {
            keyFingerprint,
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
            ...(body.priority === undefined ? {} : { priority: wholeNumber(body.priority, 'priority') }),
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

      {
        // The other half of the export above (F16.4). `importCompany` existed
        // and only tests reached it, so the README's "exported and restored
        // on another instance" was an export and no restore for an owner
        // without a terminal.
        //
        // `preview` answers what would come back and writes nothing. The
        // restore itself creates a company -- divisions, roles, grants, a
        // budget tree -- so, like starting one, it takes the owner's device.
        // The archive is the only large thing the console sends, so this
        // route alone reads more than a megabyte.
        method: 'POST',
        pattern: '/api/companies/import',
        maxBodyBytes: 64 * 1_048_576,
        handle: async ({ body }) => {
          const lines = archiveLines(body.archive);
          if (body.preview === true) return { preview: previewArchive(lines) };
          await this.#requireFactor(body.proof, 'restore a company');
          return importCompany(lines, {
            slug: requireText(body.slug, 'slug'),
            ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
          });
        },
      },

      /* ----------------------------------------------------------- F12.5 --- */

      {
        // The answer to "I lost my phone". The factor is presented from a
        // device the owner still has, the lost one stops answering, and every
        // session it signed in is ended with it.
        method: 'POST',
        pattern: '/api/mfa/authenticators/:authenticatorId/revoke',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'revoke an authenticator');
          await this.#options.mfa.revokeOwnDevice(params.authenticatorId!);
          return { signedOut: await this.#sessions.signOutFactor(params.authenticatorId!) };
        },
      },

      {
        // Every session on every browser, this one included. Ending sessions
        // only takes power away, so the session is enough to ask.
        method: 'POST',
        pattern: '/api/auth/sign-out-everywhere',
        handle: async () => ({ signedOut: await this.#sessions.signOutAll() }),
      },

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
  #deploymentSettings(): NonNullable<OwnerApiOptions['deploymentSettings']> {
    const deployment = this.#options.deploymentSettings;
    if (!deployment) {
      throw new PalugadaError('contract.violation',
        'this deployment was built without console settings; its environment is its configuration', {});
    }
    return deployment;
  }

  /**
   * The model the console is asking about, as the environment it would be,
   * with the key the owner typed -- used for this one request, never saved --
   * or else the one already stored.
   */
  async #modelCandidate(body: Record<string, unknown>): Promise<{ env: NodeJS.ProcessEnv; secrets: SecretManager }> {
    const deployment = this.#deploymentSettings();
    const stored = await readSettings();
    const candidate = modelSettingFrom(body, stored.model as ModelSetting | undefined);
    const env = withSettings(deployment.baseEnv, { ...stored, model: candidate });
    const typed = typeof body.key === 'string' && body.key.trim() !== '' ? body.key.trim() : null;
    if (!typed) return { env, secrets: deployment.secrets };
    env.PALUGADA_MODEL_KEY_REF = 'typed://model-key';
    return {
      env,
      secrets: { resolve: async (reference) => (reference === 'typed://model-key' ? typed : deployment.secrets.resolve(reference)) },
    };
  }

  /** A local Bot API server, when the deployment names one; Telegram's own otherwise. */
  #botApi(): { apiBase?: string } {
    const base = this.#deploymentSettings().baseEnv.PALUGADA_TELEGRAM_API;
    return base ? { apiBase: base } : {};
  }

  /** The token the owner pasted, or the one saved. */
  async #telegramToken(body: Record<string, unknown>): Promise<string> {
    const deployment = this.#deploymentSettings();
    const typed = typeof body.token === 'string' ? body.token.trim() : '';
    if (typed) {
      if (!/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(typed)) {
        throw new PalugadaError('contract.violation', 'a bot token looks like 123456789:AA… -- copy the whole of it from @BotFather', { field: 'token' });
      }
      return typed;
    }
    if (((await readSettings()).channels as ChannelSettings | undefined)?.telegram) return deployment.secrets.resolve('db://channel-telegram');
    throw new PalugadaError('contract.violation', 'paste the bot token @BotFather gave you', { field: 'token' });
  }

  /**
   * How the assistant reaches this API: the routes themselves, called in this
   * process with the owner's own session, so it can do nothing the page could
   * not and every rule a route keeps holds for it too.
   */
  #reach(request: IncomingMessage, session: OwnerSession | null): AssistantReach {
    return {
      routeOf: (method, path) => this.#match(method, new URL(path, 'http://localhost').pathname)?.route.pattern ?? null,
      get: (path) => this.#dispatch('GET', path, {}, request, session),
      post: (path, body) => this.#dispatch('POST', path, body, request, session),
      readable: () => this.#routes.filter((route) => route.method === 'GET' && !route.open).map((route) => route.pattern),
    };
  }

  /** One route, called in this process as a request would call it. */
  async #dispatch(
    method: 'GET' | 'POST', path: string, body: Record<string, unknown>, request: IncomingMessage, session: OwnerSession | null,
  ): Promise<unknown> {
    const url = new URL(path, 'http://localhost');
    const match = this.#match(method, url.pathname);
    if (!match || match.route.open || match.route.raw) {
      throw new PalugadaError('contract.violation', `${method} ${url.pathname} is not a route of this console`, {});
    }
    const answer = await match.route.handle({ request, session, body, raw: Buffer.alloc(0), params: match.params, query: url.searchParams });
    if (answer instanceof WithStatus) {
      if (answer.status >= 400) {
        throw new PalugadaError('contract.violation', String((answer.body as { error?: unknown } | null)?.error ?? `answered ${answer.status}`), {});
      }
      return answer.body;
    }
    return answer ?? { ok: true };
  }

  /**
   * The token a look at an MCP server, or a save, is made with: the one
   * typed, or the one saved for that server -- but only while the address is
   * on the host it was saved for, or it would be handed to another server.
   */
  async #mcpToken(body: Record<string, unknown>, url: string): Promise<{ token: string | null; typed: string | null; keep: boolean }> {
    const typed = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
    if (typed) return { token: typed, typed, keep: false };
    const saved = typeof body.name === 'string' ? mcpServersIn(await readSettings()).find((one) => one.name === body.name) : undefined;
    if (!saved?.tokenSecret || new URL(saved.url).origin !== new URL(url).origin) return { token: null, typed: null, keep: false };
    return { token: await this.#deploymentSettings().secrets.resolve(`db://${saved.tokenSecret}`), typed: null, keep: true };
  }

  /** The push channel the console is asking about: checked, with the token typed or the one saved. */
  async #pushCandidate(body: Record<string, unknown>) {
    const deployment = this.#deploymentSettings();
    const format = body.format === 'ntfy' ? 'ntfy' : body.format === 'webhook' ? 'webhook' : null;
    if (!format) throw new PalugadaError('contract.violation', 'format is ntfy or webhook', { field: 'format' });
    const url = typeof body.url === 'string' ? body.url.trim().replace(/\/+$/, '') : '';
    if (!/^https?:\/\//.test(url)) throw new PalugadaError('contract.violation', 'give the address pushes are sent to, http or https', { field: 'url' });
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    if (format === 'ntfy' && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
      throw new PalugadaError('contract.violation', 'ntfy needs the topic your phone subscribes to: letters, digits, - and _', { field: 'topic' });
    }
    const typed = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
    const saved = ((await readSettings()).channels as ChannelSettings | undefined)?.push;
    const keep = !typed && body.clearToken !== true && Boolean(saved?.tokenSecret) && saved?.url === url;
    const token = typed ?? (keep ? await deployment.secrets.resolve('db://channel-push') : null);
    const channel = new WebhookPush({
      url,
      ...(token ? { token: format === 'ntfy' ? `Bearer ${token}` : token } : {}),
      ...(format === 'ntfy' ? { body: ntfyBody(topic) } : {}),
    });
    return { format, url, topic: format === 'ntfy' ? topic : null, typed, keep, channel } as const;
  }

  /** A Slack or Discord incoming webhook: the one pasted, checked for where it points, or the one saved. */
  async #chatWebhook(kind: WebhookChatKind, body: Record<string, unknown>): Promise<string> {
    const typed = typeof body.url === 'string' ? body.url.trim() : '';
    if (typed) {
      if (!WEBHOOK_HOSTS[kind].test(typed)) {
        throw new PalugadaError('contract.violation',
          kind === 'slack' ? 'a Slack incoming webhook starts https://hooks.slack.com/services/' : 'a Discord webhook starts https://discord.com/api/webhooks/',
          { field: 'url' });
      }
      return typed;
    }
    if (((await readSettings()).channels as ChannelSettings | undefined)?.[kind]) {
      return this.#deploymentSettings().secrets.resolve(`db://channel-${kind}`);
    }
    throw new PalugadaError('contract.violation', 'paste the incoming webhook\'s address', { field: 'url' });
  }

  /**
   * The provider the console is asking about for one kind of tool: checked,
   * with the key the owner typed, or the one saved for that same provider.
   */
  async #toolCandidate(kindName: string, body: Record<string, unknown>) {
    const deployment = this.#deploymentSettings();
    const kind = toolKindNamed(kindName);
    const id = typeof body.provider === 'string' ? body.provider : '';
    const lists = {
      search: SEARCH_PROVIDERS, extract: EXTRACT_PROVIDERS, image: IMAGE_PROVIDERS, speech: SPEECH_PROVIDERS, listen: LISTEN_PROVIDERS,
    } as const;
    const provider = kind === 'search' ? searchProvider(id) : kind === 'extract' ? extractProvider(id)
      : kind === 'image' ? imageProvider(id) : kind === 'speech' ? speechProvider(id) : listenProvider(id);
    if (!provider) {
      const known = lists[kind].map((one) => one.id);
      throw new PalugadaError('contract.violation', `provider is one of ${known.join(', ')}; got ${id || 'nothing'}`, { field: 'provider' });
    }
    const url = typeof body.url === 'string' && body.url.trim() !== '' && provider.urlExample ? body.url.trim().replace(/\/+$/, '') : null;
    if (provider.urlExample) {
      if (!url || !/^https?:\/\//.test(url)) {
        throw new PalugadaError('contract.violation', `${provider.name} is your own server: give its address, such as ${provider.urlExample}`, { field: 'url' });
      }
    }
    const typed = typeof body.key === 'string' && body.key.trim() !== '' && provider.key !== 'none' ? body.key.trim() : null;
    const saved = ((await readSettings()).tools as Partial<Record<ToolKind, ToolSetting>> | undefined)?.[kind];
    const keep = !typed && body.clearKey !== true && saved?.provider === provider.id && Boolean(saved.keySecret);
    if (provider.key === 'required' && !typed && !keep) {
      throw new PalugadaError('contract.violation', `${provider.name} needs a key`, { field: 'key' });
    }
    const binding: ToolBinding<SearchProvider | ExtractProvider | ImageProvider | SpeechProvider | ListenProvider> = {
      provider,
      url,
      key: async () => (typed ?? (keep ? deployment.secrets.resolve(`db://tool-${kind}`) : null)),
    };
    return { kind, provider, url, typed, keep, binding };
  }

  /**
   * A saved setting counts from the deployment's next start. Where the
   * process can start itself again, it does, just after this answer is sent:
   * work in flight is handed back and resumed, and the console reconnects.
   */
  #applySettings(): { applies: 'now' | 'next_start' } {
    const restart = this.#options.deploymentSettings?.restart;
    if (!restart) return { applies: 'next_start' };
    setTimeout(restart, 250).unref();
    return { applies: 'now' };
  }

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

    // Before anything else, the console's own page included: a page served
    // to a rebound name is the page that would then make the requests.
    const asked = hostOf(req.headers.host);
    if (this.#allowedHosts && (!asked || !this.#allowedHosts.has(asked))) {
      send(res, 421, {
        error: `this console does not answer to ${asked ?? 'a request without a Host'}; `
          + 'add the name to PALUGADA_ALLOWED_HOSTS if it is meant to',
        code: 'owner.wrong_host',
      });
      return;
    }

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
      session = await this.#sessions.verify(bearer(req));
      if (!session) {
        // 401 rather than 404: the owner whose session expired should be told
        // to sign in, not told the console has moved.
        send(res, 401, { error: 'sign in first', code: 'owner.unauthenticated' });
        return;
      }
    }

    let body: Record<string, unknown> = {};
    let raw: Buffer = Buffer.alloc(0);
    if (req.method === 'POST') {
      try {
        raw = await readBody(req, match.route.maxBodyBytes);
        if (!match.route.raw) body = jsonObject(raw);
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
        raw,
        params: match.params,
        query: url.searchParams,
      });
      if (answer instanceof WithStatus) send(res, answer.status, answer.body);
      else send(res, 200, answer ?? { ok: true });
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
        // renders. A picture or a voice the owner tries in Tools is shown from
        // the answer, as a data address; an image or a sound cannot run.
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data:; media-src 'self' data:; "
          + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // The build names every asset by its content hash, so an asset never
        // changes under its name and may be kept; the page that names them
        // must be asked for again, or a release would never reach the owner.
        'cache-control': wanted.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
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
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
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
  if (code === 'owner.throttled') return 429;
  if (code === 'mfa.locked_out') return 429;
  if (code.startsWith('mfa.')) return 401;
  if (code === 'approval.channel_forbidden' || code === 'policy.denied') return 403;
  if (code === 'capability.rate_limited' || code === 'hook.rate_limited') return 429;
  if (code === 'hook.unknown') return 404;
  if (code === 'hook.refused') return 401;
  if (code === 'hook.unsupported') return 415;
  if (code === 'hook.unavailable') return 503;
  return 400;
}

/**
 * Wrong codes from one address, counted before the second factor's own
 * lockout counts them.
 *
 * The factor's lockout is global: ten wrong codes from anywhere and nobody
 * signs in for fifteen minutes. That is the defence against guessing, and on
 * its own it was also a way for anyone who could reach the console to keep
 * the owner out -- ten requests every quarter of an hour. An address that has
 * been wrong five times is refused before its next guess reaches the factor,
 * so one caller cannot spend the owner's ten. Many callers still can, which
 * is the lockout doing its job.
 *
 * In memory, per process: a replica counts its own, and a restart forgives,
 * which costs an attacker a restart they do not control.
 */
class SignInThrottle {
  static readonly LIMIT = 5;
  static readonly WINDOW_MS = 15 * 60_000;
  /** Bounded, so a caller rotating addresses cannot grow it without end. */
  static readonly TRACKED = 10_000;
  readonly #failures = new Map<string, { count: number; until: number }>();

  check(address: string): void {
    const entry = this.#failures.get(address);
    if (!entry) return;
    if (entry.until <= Date.now()) {
      this.#failures.delete(address);
      return;
    }
    if (entry.count >= SignInThrottle.LIMIT) {
      throw new PalugadaError('owner.throttled',
        `too many wrong codes from this address; try again after ${new Date(entry.until).toISOString()}`, {});
    }
  }

  /** Counted only when the code was compared and was wrong: a locked factor or a malformed body is not a guess. */
  failed(address: string, failure: unknown): void {
    const guessed = failure instanceof PalugadaError && failure.code.startsWith('mfa.')
      && failure.code !== 'mfa.locked_out' && failure.code !== 'mfa.not_enrolled';
    if (!guessed) return;
    const now = Date.now();
    const entry = this.#failures.get(address);
    const count = entry && entry.until > now ? entry.count + 1 : 1;
    this.#failures.delete(address);
    this.#failures.set(address, { count, until: now + SignInThrottle.WINDOW_MS });
    if (this.#failures.size > SignInThrottle.TRACKED) {
      this.#failures.delete(this.#failures.keys().next().value!);
    }
  }

  succeeded(address: string): void {
    this.#failures.delete(address);
  }
}

/** Who is asking: the connection's address, or behind a proxy the one it vouches for. */
function addressOf(request: IncomingMessage, behindProxy: boolean): string {
  if (behindProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').at(-1)?.trim();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** A configuration kind from a path, or a refusal that lists the ones there are. */
function configKind(value: unknown): ConfigKind {
  const kinds: readonly ConfigKind[] = ['charter', 'policy', 'role', 'grant', 'bundle', 'skill'];
  if (typeof value === 'string' && (kinds as readonly string[]).includes(value)) return value as ConfigKind;
  throw new PalugadaError('contract.violation', `a configuration kind is one of ${kinds.join(', ')}`, { kind: value });
}

/**
 * A call to a service outside, whose refusal the owner should read -- "that
 * token is not a bot's", "ntfy said 401" -- rather than an internal error.
 */
async function outside<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (failure) {
    if (failure instanceof PalugadaError) throw failure;
    throw new PalugadaError('capability.unreachable', (failure as Error).message, {});
  }
}

function chatKindNamed(name: string): WebhookChatKind {
  if (name !== 'slack' && name !== 'discord') {
    throw new PalugadaError('contract.violation', `a chat is slack or discord; got ${name}`, { kind: name });
  }
  return name;
}

/** A recording sent from the page: base64 in `audio`, its type in `mime`. */
function audioFrom(body: Record<string, unknown>): Heard {
  const mime = typeof body.mime === 'string' ? body.mime.split(';')[0]!.trim() : '';
  if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) {
    throw new PalugadaError('contract.violation', 'say what kind of audio this is, such as audio/webm', { field: 'mime' });
  }
  const audio = typeof body.audio === 'string' ? body.audio.replace(/^data:[^;]+;base64,/, '') : '';
  if (!audio) throw new PalugadaError('contract.violation', 'send the recording, as base64', { field: 'audio' });
  return { bytes: Buffer.from(audio, 'base64'), mime };
}

/** What a route answered, in a sentence the conversation keeps: short, and never a secret, which no route returns. */
function outcomeOf(result: unknown): string {
  const text = JSON.stringify(result) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** The console's MCP servers, as saved. */
function mcpServersIn(settings: Record<string, unknown>): McpServerSetting[] {
  return [...((settings.mcp as { servers?: McpServerSetting[] } | undefined)?.servers ?? [])];
}

/** The names of the console's servers a start was given, to say which are in use. */
function mcpNamesIn(text: string | undefined): string[] {
  try {
    return ((JSON.parse(text ?? '') as { servers?: Array<{ name?: string }> }).servers ?? []).map((one) => String(one.name));
  } catch {
    return [];
  }
}

function mcpServerNamed(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) {
    throw new PalugadaError('config.invalid',
      'a server\'s name is lowercase letters, digits, - and _, at most 31, such as payments: it becomes part of each tool\'s name', { field: 'name' });
  }
  return name;
}

/** Where the token goes, when the console says: a header, a scheme or a query parameter, each a plain name. */
function mcpTokenIn(value: unknown): TokenIn | null {
  if (value === undefined || value === null) return null;
  const given = value as Record<string, unknown>;
  const out: TokenIn = {};
  for (const [field, pattern] of [['header', /^[A-Za-z][A-Za-z0-9-]{0,63}$/], ['scheme', /^[A-Za-z0-9-]{0,32}$/], ['query', /^[A-Za-z][A-Za-z0-9_]{0,63}$/]] as const) {
    const one = given[field];
    if (one === undefined) continue;
    if (typeof one !== 'string' || !pattern.test(one)) {
      throw new PalugadaError('config.invalid', `the token's ${field} is a plain name; got ${String(one)}`, { field: 'tokenIn' });
    }
    out[field] = one;
  }
  if (out.header && out.query) throw new PalugadaError('config.invalid', 'a token goes in a header or in the address, not both', { field: 'tokenIn' });
  return Object.keys(out).length > 0 ? out : null;
}

function mcpUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PalugadaError('config.invalid', 'give the server\'s address, such as https://mcp.example.com/mcp', { field: 'url' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PalugadaError('config.invalid', `an MCP server is reached over HTTP; ${parsed.protocol} is not`, { field: 'url' });
  }
  return url;
}

function toolKindNamed(name: string): ToolKind {
  if (!(name in TOOL_KINDS)) {
    throw new PalugadaError('contract.violation', `a tool is ${Object.keys(TOOL_KINDS).join(' or ')}; got ${name}`, { kind: name });
  }
  return name as ToolKind;
}

/** An agent CLI the console can manage, by the name in the address. */
function agentNamed(name: string): AgentEntry {
  const entry = agentEntry(name);
  if (!entry) {
    throw new PalugadaError('contract.violation',
      `the agent CLIs are ${AGENT_CATALOGUE.map((one) => one.name).join(', ')}; got ${name}`, { agent: name });
  }
  return entry;
}

/**
 * The agent CLIs as the console last saved them -- or, before it ever has,
 * as the environment turns them on, so that the first change made here does
 * not switch off a CLI the operator had running.
 */
function agentsFrom(stored: Settings, env: NodeJS.ProcessEnv): Record<string, AgentSetting> {
  if (stored.agents) return { ...(stored.agents as Record<string, AgentSetting>) };
  const named = (env.PALUGADA_AGENT_CLIS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const seeded: Record<string, AgentSetting> = Object.fromEntries(named.map((name) => [name, { enabled: true }]));
  if (env.PALUGADA_CLAUDE_CODE_COMMAND) {
    seeded['claude-code'] = { ...(seeded['claude-code'] ?? {}), enabled: true, command: env.PALUGADA_CLAUDE_CODE_COMMAND };
  }
  return seeded;
}

/**
 * The model the console sent, checked for shape; what it leaves out is kept
 * from the model already chosen, so saving a new tier does not forget the key.
 */
function modelSettingFrom(body: Record<string, unknown>, previous: ModelSetting | undefined): ModelSetting {
  const provider = body.provider;
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new PalugadaError('contract.violation', 'provider is anthropic or openai', { field: 'provider' });
  }
  const text = (field: string): string | undefined => {
    const value = body[field];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new PalugadaError('contract.violation', `${field} is text`, { field });
    return value.trim();
  };
  const aliases: Record<string, string> = {};
  if (body.aliases !== undefined && body.aliases !== null) {
    if (typeof body.aliases !== 'object' || Array.isArray(body.aliases)) {
      throw new PalugadaError('contract.violation', 'aliases maps fast, standard and deep to a model', { field: 'aliases' });
    }
    for (const [tier, model] of Object.entries(body.aliases as Record<string, unknown>)) {
      if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
        throw new PalugadaError('contract.violation', `a tier is fast, standard or deep; got ${tier}`, { field: 'aliases' });
      }
      if (typeof model === 'string' && model.trim() !== '') aliases[tier] = model.trim();
    }
  }
  const url = text('url');
  const model = text('model');
  const preset = text('preset');
  if (preset !== undefined && !modelProvider(preset)) {
    throw new PalugadaError('contract.violation',
      `preset is one of ${MODEL_PROVIDERS.map((entry) => entry.id).join(', ')}; got ${preset}`, { field: 'preset' });
  }
  const keep = previous && previous.provider === provider ? previous.keySecret : undefined;
  return {
    ...(preset ? { preset } : {}),
    provider,
    ...(url ? { url } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(body.clearKey === true || !keep ? {} : { keySecret: keep }),
  };
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

/** The names a console bound to loopback answers to when it is told none. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A host name as compared: lower case, no port, IPv6 in brackets. */
function normaliseHost(name: string): string {
  const bare = name.trim().toLowerCase();
  return bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare;
}

/** The name a request asked for, from its `Host` header, without the port. */
function hostOf(header: string | undefined): string | null {
  if (!header) return null;
  try {
    return normaliseHost(new URL(`http://${header}`).hostname);
  } catch {
    return null;
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

async function readBody(req: IncomingMessage, limit = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A decision is a few hundred bytes. A megabyte is far more than one needs
    // and far less than enough to exhaust the console.
    if (size > limit) throw new Error('request body is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function jsonObject(bytes: Buffer): Record<string, unknown> {
  const raw = bytes.toString('utf8').trim();
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
async function companies(): Promise<Array<{
  id: string; slug: string; name: string; frozen: boolean; workLanguage: string | null; talkLanguage: string | null;
  stage: Stage | null; headline: Headline | null;
}>> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; slug: string; name: string; frozen: boolean; workLanguage: string | null; talkLanguage: string | null;
      stage: Stage | null;
    }>(
      `SELECT id, slug, name, frozen_at IS NOT NULL AS frozen,
              work_language AS "workLanguage", talk_language AS "talkLanguage", stage
         FROM companies ORDER BY created_at`,
    );
    const measured = await headlines(tx);
    return rows.map((row) => ({ ...row, headline: measured.get(row.id) ?? null }));
  });
}
