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
import { versionIn } from '../runtime/checked-versions.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { catalogueNames } from '../broker/catalogue.ts';
import * as inbox from '../inbox/inbox.ts';
import { briefingOf, traceFromInboxItem, traceOfTask } from '../reporting/trace.ts';
import { addDocument, archiveDocument, listDocuments, readDocument, setForCustomers } from '../knowledge/documents.ts';
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
import { cancelTask, continueAllHalted, continueHalted, giveFeedback, instructTask, rerunTask, type Verdict } from '../engine/owner-control.ts';
import { assertClosingDays, closeCompany, closingOf, erasures, failingErasures, keepCompany } from '../governance/closing.ts';
import { EMAIL_PROVIDERS, EmailChannel, emailAddress, emailProvider, type EmailProviderId } from './email.ts';
import { VERSION } from '../version.ts';
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
import {
  assertOfficeHours, clearOfficeHours, officeHours, ownerWindow, setBatchWindow, setOfficeHours, setOwnerWindow,
} from '../scheduler/windows.ts';
import { healthFor, preflightGrants } from '../broker/preflight.ts';
import { assistantCost, costTimeline, platformCost } from '../reporting/cost.ts';
import { rotateCredential } from '../secrets/rotation.ts';
import { CREDENTIAL_SECRETS, redactor, type SecretManager } from '../secrets/manager.ts';
import { checkVendorEntry, vendorPresets, type VendorSpec } from '../capabilities/vendors.ts';
import { assertStage, loosens, setStage, stageOf, type Stage } from '../domain/stage.ts';
import { createHandoffRule, handoffRulesOf, setHandoffRuleEnabled } from '../engine/handoff-rules.ts';
import { searchEverywhere } from './search.ts';
import { appendEvent, readTaskEvents } from '../audit/event-log.ts';
import { describeReplay, replayTask } from '../engine/replay.ts';
import { assignTask } from '../scheduler/wake.ts';
import { TICKET_STATUSES, listTickets, openTicket, readTicket, setTicketStatus, startTicket } from '../engine/tickets.ts';
import { createCompanyFromTemplate, readTemplate } from '../templates/company.ts';
import { ACCOUNT_NAME, accountFor, chainFor, createAccount, setCeilings, snapshot } from '../engine/budget.ts';
import { remember, retract, supersede } from '../memory/store.ts';
import { changeMetric, defineMetric, headlines, recordObservation, type Headline, type MetricChange, type MetricUnit } from '../domain/metrics.ts';
import {
  LANGUAGES, deploymentLanguages, isLanguageCode, languageCode, languagesFor, setCompanyLanguages, setDeploymentLanguages,
} from '../domain/language.ts';
import { moneyDisplay, setMoneyDisplay } from '../domain/money-display.ts';
import { getTask } from '../engine/tasks.ts';
import type { TaskHandler } from '../runtime/in-process.ts';
import type { AdapterRegistry } from '../runtime/protocol.ts';
import { collectExport } from '../audit/export.ts';
import { archiveLines, importCompany, previewArchive } from '../audit/import.ts';
import {
  createTrigger, receiveHook, rotateTriggerToken, setTriggerEnabled, triggersOf, type TriggerScheme,
} from '../scheduler/triggers.ts';
import {
  assertAccountFree, channelsOf, chatWith, chatsOf, checkChannel, closeChannel, hashSecret, openChannel, setAnswersAlone,
} from '../chats/chats.ts';
import { addAccount, balancesOf, entriesOf, entryInput, postEntry, profitOf, reverseEntry } from '../records/books.ts';
import { INVOICE_FILTERS, invoiceWith, issueInvoice, listInvoices, payInvoice, voidInvoice, type InvoiceFilter } from '../records/invoices.ts';
import {
  addContact, archiveContact, changeContact, contactFields, contactWith, dealInput, listContacts, noteContact, recordDeal,
} from '../records/contacts.ts';
import { receiveChatHook, verifyChatHook } from '../chats/hook.ts';
import { checkMailbox, mailSettings, type MailOptions } from '../chats/mail.ts';
import { GOAL_STATUSES, applyGoalChange, createGoal, readGoal } from '../domain/goals.ts';
import {
  addDivision,
  addProject,
  changeProject,
  addRole,
  applyGrantChange,
  applyRoleChange,
  grantRoleTools,
  setEscalationPolicy,
  type RoleFields,
  type StructuralChange,
} from '../governance/structure.ts';
import { CHARTER_LIMIT, publishCharter, putPolicy } from '../governance/store.ts';
import { MAX_IN_FLIGHT } from '../broker/in-flight.ts';
import { history as configHistory, type ConfigKind } from '../governance/config-versions.ts';
import { rollBack } from '../governance/rollback.ts';
import type { CharterRepository } from '../governance/charter-repository.ts';
import { COMPANY_CHARTER_FILE, PLATFORM_CHARTER_FILE } from '../governance/charter-files.ts';
import { assertValidCondition, type Condition } from '../policy/condition.ts';
import { POLICY_EFFECTS, type PolicyEffect } from '../policy/engine.ts';
import { setThresholds } from '../reporting/alerts.ts';
import { pendingReviews } from '../review/review.ts';
import { OVERLAP_POLICIES, removeSchedule, runScheduleNow, setScheduleEnabled, upsertSchedule } from '../scheduler/scheduler.ts';
import {
  addEvalCase,
  approveSkillVersion,
  importExternalSkill,
  liftSkillQuarantine,
  proposeSkillVersion,
  rejectSkillVersion,
  setSkillScope,
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
import { keysAskedFor } from '../broker/keys.ts';
import { McpUnauthorized, accessFor, assertPlainHttpIsLocal, bindMcpServers, currentPins, offeredTools, type TokenIn } from '../capabilities/mcp.ts';
import { beginSignIn, discoverSignIn, finishSignIn, forgetSignIn, mcpSecretName, oauthGrantsIn } from '../capabilities/mcp-oauth.ts';
import { MCP_PRESETS } from '../capabilities/mcp-presets.ts';
import { DEFAULT_PRICE_TABLE, parsePriceTable, rateFor, withConsolePrices, type PriceTable } from '../engine/pricing.ts';
import { MODELS_DEV_URL, lookupPrices } from '../engine/models-dev.ts';
import { beginCredentialSignIn, finishCredentialSignIn, hasClient, OAUTH_CREDENTIALS, type CredentialSignIn } from '../capabilities/vendor-oauth.ts';
import { LISTEN_PROVIDERS, listenProvider, transcribe, type Heard, type ListenBinding, type ListenProvider } from '../capabilities/listen.ts';
import { DEFAULT_QUESTION, describePicture, pictureKind, VISION_PROVIDERS, visionProvider, type Picture, type VisionProvider } from '../capabilities/vision.ts';
import { EMBED_PROVIDERS, embed, embedProvider, type EmbedBinding, type EmbedProvider } from '../capabilities/embed.ts';
import {
  ceoOpensConversation, chatMayApply, chatPartners, chatScope, closeProposal, conversation, converse, forgetConversation, moveChat, patternFor, proposalById,
  speakerOf, type AssistantChannel, type AssistantProposal, type AssistantReach,
} from './assistant.ts';
import { ceoBriefsOwner } from './ceo-briefing.ts';
import { closeFirstHour, firstHourOf } from './first-hour.ts';
import { seatRequest, StaffSeats, type StaffSession } from './staff.ts';
import { staffMay } from './staff-policy.ts';
import { ASSISTANT_ACTIONS } from './assistant-actions.ts';
import { PERSONAS, TITLES, personaFrom, titleFrom, type RolePersona } from '../domain/personas.ts';
import { appointCeo } from '../governance/ceo.ts';
import type { ToolUsingLlmClient } from '../llm/client.ts';
import type { OwnerMfa, WebAuthnAssertion } from './mfa.ts';
import { telegramApi, telegramBot, telegramChats, telegramCommands, telegramProfilePhoto, type ChatConversation, type TelegramChannel, type TelegramUpdate } from './telegram.ts';
import { whatsappNumber, type WhatsAppChannel } from './whatsapp.ts';
import { WebhookPush, ntfyBody } from './push.ts';
import { OwnerSessions, type OwnerSession } from './session.ts';
import { checkedStepUp, setStepUpMinutes, STEP_UP_CHOICES, stepUpMinutes, withinWindow } from './step-up.ts';
import { OwnerClaims } from './claim.ts';
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
import { say } from './say.ts';
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
  skillOf,
  skillsOf,
  structureOf,
  taskDetailOf,
  workOf,
  galleryOf,
  eventsAfter,
  databaseNow,
  summarise,
} from './views.ts';
import type { Browsers, OwnerInput } from '../browser/browsers.ts';
import { giveBack, holdOf, takeOver, touchHold } from '../browser/holds.ts';

export interface OwnerApiOptions {
  mfa: OwnerMfa;
  sessions?: OwnerSessions;
  /** F3.11: the repository of charter files, written as the owner saves a charter. */
  charters?: CharterRepository;
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
   * The companies' browsers (`src/browser/`), which the owner watches and
   * takes over. Absent, the console says this deployment has none.
   */
  browsers?: Browsers;
  /**
   * The operator's price list, which what the owner says a model costs is
   * laid over (L12). Absent, the conservative fallback alone.
   */
  prices?: PriceTable;
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
   * loop is going round. Read by `GET /api/health`, which a supervisor asks
   * without a session, and by `GET /api/ready`, which a load balancer asks,
   * and which also says no once the process has begun to stop.
   */
  health?: () => Promise<{ ok: boolean } & Record<string, unknown>>;
  /**
   * What `GET /api/metrics` answers a scraper that holds `token`, in the
   * Prometheus text format. Absent means the route refuses: the numbers are
   * about every company, so nothing serves them until the operator has chosen
   * who may read them.
   */
  metrics?: { token: string; text: () => Promise<string> };
  /**
   * The message channel whose button presses arrive at
   * `/api/channels/telegram` (F10.9). Absent means the route refuses.
   */
  telegram?: TelegramChannel;
  /**
   * WhatsApp, whose deliveries arrive at `/api/channels/whatsapp` (F10.9).
   * Absent means the route refuses.
   */
  whatsapp?: WhatsAppChannel;
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
    /** The owner's session; null for an open route, or a staff seat's request. */
    session: OwnerSession | null;
    /** A staff seat's session (0110), already held to what its seat may reach (staff-policy.ts). */
    staff: StaffSession | null;
    body: Record<string, unknown>;
    /** The body's bytes as they arrived, for a route that reads them itself. */
    raw: Buffer;
    params: Record<string, string>;
    query: URLSearchParams;
  }): Promise<unknown>;
}

/** A route's answer with a status other than 200: only the health and readiness checks need one. */
class WithStatus {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

/** Plain text rather than JSON: only for the metrics scraper, which reads its own format. */
class PlainText {
  readonly contentType: string;
  readonly text: string;

  constructor(contentType: string, text: string) {
    this.contentType = contentType;
    this.text = text;
  }
}

/** A page rather than JSON: only for a browser sent here by somebody else, which has no console open in it. */
class HtmlPage {
  readonly status: number;
  readonly title: string;
  readonly text: string;
  /** The language the page is written in, for the browser's reader and its fonts. */
  readonly language: string;

  constructor(status: number, title: string, text: string, language: string | null = null) {
    this.status = status;
    this.title = title;
    this.text = text;
    this.language = language ?? 'en';
  }
}

/**
 * An answer that goes on: server-sent events, written as they come, until
 * the owner goes or the API closes. `run` writes each one with `send` and
 * returns when `signal` aborts.
 */
class EventStream {
  readonly run: (send: (data: unknown, id?: string) => void, signal: AbortSignal) => Promise<void>;

  constructor(run: EventStream['run']) {
    this.run = run;
  }
}

/** How often a live stream looks for new events. */
const LIVE_POLL_MS = 1_000;
/** How far back each look reads again, for a transaction that committed late. */
const LIVE_LOOKBACK_MS = 30_000;

/** How long a quiet stream waits before saying it is still there, inside any proxy's idle limit. */
const STREAM_HEARTBEAT_MS = 15_000;

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
  /**
   * The owner's session behind the request being handled, for the window a
   * recent code opens (0120): `#requireFactor` is called from seventy places
   * that were each written without a session in hand.
   */
  readonly #acting = new AsyncLocalStorage<OwnerSession | null>();
  readonly #claims: OwnerClaims;
  readonly #staff: StaffSeats;
  readonly #routes: Route[];
  readonly #signInThrottle = new SignInThrottle();
  readonly #agentJobs = new AgentJobs();
  #server: Server | null = null;
  /** The live streams open now (`EventStream`), ended when the API closes rather than waited for. */
  readonly #streams = new Set<AbortController>();
  #allowedHosts: ReadonlySet<string> | null = null;
  /** The answers being written, so that a closing listener finishes them rather than cutting them off. */
  readonly #answering = new Set<ServerResponse>();
  /** Set by `drain()`: readiness says 503, and every answer lets its connection go. */
  #draining = false;
  /** Whether anything has asked `/api/ready`: only then is there a balancer to wait for. */
  #readinessAsked = false;

  constructor(options: OwnerApiOptions) {
    this.#options = options;
    this.#sessions = options.sessions ?? new OwnerSessions({ mfa: options.mfa });
    // The first owner's claim seals their secret with the deployment's master
    // key; built without console settings, there is none, and a claim says so.
    this.#claims = new OwnerClaims({
      mfa: options.mfa,
      sessions: this.#sessions,
      master: () => options.deploymentSettings?.master(true) ?? null,
    });
    // Staff seats (0110): sealed like the claim, and read by the same store.
    this.#staff = new StaffSeats({
      master: () => options.deploymentSettings?.master(true) ?? null,
      secrets: () => options.deploymentSettings?.secrets ?? null,
    });
    this.#routes = this.#buildRoutes();
  }

  get sessions(): OwnerSessions {
    return this.#sessions;
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ url: string; port: number }> {
    const server = createServer((req, res) => {
      this.#answering.add(res);
      res.once('close', () => this.#answering.delete(res));
      if (this.#draining) res.setHeader('connection', 'close');
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
    // A listener opened again after a close is ready again.
    this.#draining = false;
    this.#readinessAsked = false;
    const given = this.#options.allowedHosts;
    this.#allowedHosts = given
      ? new Set([...given, host].map(normaliseHost))
      : LOOPBACK_HOSTS.has(normaliseHost(host)) ? LOOPBACK_HOSTS : null;
    return { url: `http://${host}:${address.port}`, port: address.port };
  }

  /**
   * Says "not ready" from now on, and waits `ms` while still answering.
   *
   * `/api/ready` answers 503 at once, and every answer from here closes its
   * connection, so a client holding one open makes its next elsewhere. The
   * wait is for a load balancer that asks readiness every few seconds to
   * notice before the listener closes; when nothing has asked, there is no
   * balancer to tell, and it returns at once.
   */
  async drain(ms: number): Promise<void> {
    this.#letConnectionsGo();
    if (!this.#readinessAsked || ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Closes the listener. No connection is taken from here; an answer already
   * being written is given `finishMs` to finish before its connection is cut,
   * and with none given, every connection is cut at once.
   */
  async close(finishMs = 0): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    this.#letConnectionsGo();
    // A stream never finishes by itself: it is told to end, not given time.
    for (const stream of this.#streams) stream.abort();
    // Before anything is awaited, so no connection is accepted after this line.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    if (finishMs <= 0) {
      server.closeAllConnections();
      await closed;
      return;
    }
    const cut = setTimeout(() => server.closeAllConnections(), finishMs);
    try {
      await closed;
    } finally {
      clearTimeout(cut);
    }
  }

  /** From here, readiness says no, and each answer not yet begun closes its connection when it is sent. */
  #letConnectionsGo(): void {
    this.#draining = true;
    for (const res of this.#answering) {
      if (!res.headersSent) res.setHeader('connection', 'close');
    }
  }

  #buildRoutes(): Route[] {
    return [
      /* ------------------------------------------------------- signing in --- */

      {
        method: 'GET',
        pattern: '/api/auth/challenge',
        open: true,
        // With where a passkey is used, which the browser needs to be asked
        // for one. Neither is a secret: both are this console's own address.
        // And whether the deployment has an owner yet, so a sign-in page that
        // nothing on it can open says where the way in is (F12.5, 0094).
        handle: async () => ({
          challenge: this.#sessions.challenge(),
          ...this.#options.mfa.relyingParty,
          claimable: await this.#claims.claimable(),
        }),
      },

      {
        // F12.5: the link a deployment with no owner printed as it started
        // (src/owner/claim.ts). Open, like signing in, and throttled like it:
        // the code in the link is the credential, and a wrong one is a guess.
        // Answers with the secret to add to an authenticator app.
        method: 'POST',
        pattern: '/api/auth/claim',
        open: true,
        handle: async ({ body, request }) => {
          const address = addressOf(request, this.#options.behindProxy === true);
          this.#signInThrottle.check(address);
          try {
            return await this.#claims.open(String(body.code ?? ''), `owner@${hostLabel(request)}`);
          } catch (failure) {
            this.#signInThrottle.failed(address, failure);
            throw failure;
          }
        },
      },

      {
        // The code the app then shows: the authenticator becomes the owner's,
        // and they are signed in, as `/api/auth/sign-in` answers.
        method: 'POST',
        pattern: '/api/auth/claim/confirm',
        open: true,
        handle: async ({ body, request }) => {
          const address = addressOf(request, this.#options.behindProxy === true);
          this.#signInThrottle.check(address);
          let session: OwnerSession;
          try {
            const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : undefined;
            session = await this.#claims.confirm(String(body.code ?? ''), String(body.offer ?? ''), String(body.totp ?? ''), label);
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
            conversation: this.#chatConversation(request),
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
        // F10.9 on WhatsApp: Meta's check when the webhook is subscribed. It
        // is answered with the challenge, as plain text, only for the verify
        // token this deployment chose (PALUGADA_WHATSAPP_VERIFY_TOKEN).
        method: 'GET',
        pattern: '/api/channels/whatsapp',
        open: true,
        handle: async ({ query }) => {
          const challenge = this.#options.whatsapp?.verifySubscription(query) ?? null;
          if (challenge === null) throw new PalugadaError('owner.unauthenticated', 'that is not this deployment\'s verify token', {});
          return new PlainText('text/plain; charset=utf-8', challenge);
        },
      },

      {
        // Where Meta posts what the owner sends on WhatsApp. Open, like
        // Telegram's; what stands in for a session is Meta's signature over
        // the bytes, so the body is read as those bytes, not parsed first.
        method: 'POST',
        pattern: '/api/channels/whatsapp',
        open: true,
        raw: true,
        maxBodyBytes: 256 * 1024,
        handle: async ({ request, raw }) => {
          const channel = this.#options.whatsapp;
          if (!channel) throw new PalugadaError('contract.violation', 'this deployment has no WhatsApp channel', {});
          const signature = request.headers['x-hub-signature-256'];
          const outcome = await channel.onDelivery(raw, typeof signature === 'string' ? signature : undefined, {
            conversation: this.#chatConversation(request, 'whatsapp'),
          });
          if (outcome.reason === 'signature') throw new PalugadaError('owner.unauthenticated', 'that delivery is not signed by Meta', {});
          // Anything else is answered as received, so Meta does not send it
          // again: a press refused, a stranger, a delivery seen before.
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
            // A staff seat's code first (0110): a seat's sign-in must not be
            // counted against the owner's factor, whose lockout is global.
            // A code no seat's app shows goes on to the owner's.
            const proof = proofFrom(body);
            const seated = 'totp' in proof ? await this.#staff.signIn(proof.totp) : null;
            if (seated) {
              this.#signInThrottle.succeeded(address);
              return { token: seated.token, expiresAt: seated.expiresAt.toISOString(), staff: staffOf(seated) };
            }
            session = await this.#sessions.signIn(proof);
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
            staff: null,
          };
        },
      },

      {
        method: 'POST',
        pattern: '/api/auth/sign-out',
        handle: async ({ session, staff }) => {
          if (staff) await this.#staff.signOut(staff.token);
          else await this.#sessions.signOut(session!.token);
          return { ok: true };
        },
      },

      {
        // Who is signed in: the owner, or a staff seat and what it may do (0110).
        method: 'GET',
        pattern: '/api/me',
        handle: async ({ staff, session }) => {
          if (staff) return { owner: false, staff: staffOf(staff) };
          const minutes = await stepUpMinutes();
          const until = session?.provedAt && minutes > 0 ? new Date(session.provedAt.getTime() + minutes * 60_000) : null;
          return {
            owner: true, staff: null,
            // Until when a code just shown covers what builds the company (0120); null when none does. A seat has none.
            stepUp: { minutes, until: until && until.getTime() > Date.now() ? until.toISOString() : null },
          };
        },
      },

      {
        // An invite to a staff seat, opened (staff.ts): open and throttled
        // like the owner's claim, since the code in the link is the
        // credential. Answers with a secret for the person's app.
        method: 'POST',
        pattern: '/api/auth/join',
        open: true,
        handle: async ({ body, request }) => {
          const address = addressOf(request, this.#options.behindProxy === true);
          this.#signInThrottle.check(address);
          try {
            return await this.#staff.open(String(body.code ?? ''), `staff@${hostLabel(request)}`);
          } catch (failure) {
            this.#signInThrottle.failed(address, failure);
            throw failure;
          }
        },
      },

      {
        // The code the person's app then shows: the seat is theirs, and they
        // are signed in to it.
        method: 'POST',
        pattern: '/api/auth/join/confirm',
        open: true,
        handle: async ({ body, request }) => {
          const address = addressOf(request, this.#options.behindProxy === true);
          this.#signInThrottle.check(address);
          let seated: StaffSession;
          try {
            seated = await this.#staff.confirm(String(body.code ?? ''), String(body.offer ?? ''), String(body.totp ?? ''));
          } catch (failure) {
            this.#signInThrottle.failed(address, failure);
            throw failure;
          }
          this.#signInThrottle.succeeded(address);
          return {
            token: seated.token, expiresAt: seated.expiresAt.toISOString(), device: seated.seat.name, factor: 'totp', staff: staffOf(seated),
          };
        },
      },

      /* ----------------------------------------------------------- F10.1 --- */

      {
        method: 'GET',
        pattern: '/api/companies',
        // A staff seat sees its own company and no other (0110).
        handle: async ({ staff }) => ({
          companies: (await companies()).filter((company) => !staff || company.id === staff.seat.companyId),
        }),
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
          // The languages it works and talks in, checked before the factor
          // is spent like the bundles. Unsaid, both are the language the
          // owner reads the panel in: on a live run (N7) a company started
          // from an Indonesian console worked in English, because creation
          // left them unset and the deployment's agent language was English.
          const workLanguage = body.workLanguage === undefined ? undefined : languageCode(body.workLanguage, 'workLanguage');
          const talkLanguage = body.talkLanguage === undefined ? undefined : languageCode(body.talkLanguage, 'talkLanguage');
          await this.#requireFactor(body.proof, 'start a company', null, WITHIN_THE_WINDOW);
          const templateSlug = requireText(body.templateSlug, 'templateSlug');
          // Checked here so the refusal names the template rather than
          // arriving as a plain `Error` the caller reads as a broken console.
          if (!(await readTemplate(templateSlug))) {
            throw new PalugadaError(
              'contract.violation', `no company template named ${templateSlug}`, { templateSlug },
            );
          }
          const panel = (await deploymentLanguages()).console;
          const owners = panel && isLanguageCode(panel) ? panel : null;
          const work = workLanguage ?? owners;
          const talk = talkLanguage ?? owners;
          const created = await createCompanyFromTemplate({
            templateSlug,
            companySlug: requireText(body.companySlug, 'companySlug'),
            name: requireText(body.name, 'name'),
            ...(body.timezone === undefined
              ? {}
              : { timezone: requireText(body.timezone, 'timezone') }),
            // Its mission and objectives are what the owner reads first, so
            // they are said in the language the company talks in.
            words: (statement) => say(talk, statement),
          });
          if (work || talk) await setCompanyLanguages(created.companyId, { work, talk });
          // One factor covers the company and what it starts with: installing
          // a bundle is the same structural change F2.9 already approved here.
          for (const bundle of bundles) {
            await installBundle({ companyId: created.companyId, slug: bundle.slug, version: bundle.version });
          }
          // Its first hour (first-hour.ts): the CEO asks what it needs to
          // know before the owner has said anything.
          await ceoOpensConversation(created.companyId);
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
          const id = (name: string) => {
            const value = query.get(name);
            if (value === null || value === '') return {};
            if (!/^[0-9a-f-]{36}$/.test(value)) {
              throw new PalugadaError('contract.violation', `${name} is the id of one, as the structure lists it`, { field: name });
            }
            return { [`${name}Id`]: value };
          };
          return workOf(params.companyId!, {
            ...(group ? { group } : {}),
            ...(query.get('limit') === null ? {} : { limit: wholeNumber(query.get('limit'), 'limit') }),
            ...id('project'), ...id('role'), ...id('goal'),
            // The `next` of the page before: read, not trusted (inbox.ts readCursor).
            ...(query.get('before') ? { before: query.get('before')! } : {}),
          });
        },
      },



      {
        // The company's events as they are written (the analysis of 3 October,
        // §9 P1 item 11): the console reloads what each touches, rather than
        // asking again every few seconds. From the moment the owner looks;
        // what came before is read the ordinary way.
        method: 'GET',
        pattern: '/api/companies/:companyId/live',
        handle: async ({ params }) => {
          const companyId = params.companyId!;
          return new EventStream(async (send, signal) => {
            const looked = await databaseNow(companyId);
            let newest = looked;
            // Sent, by when it happened. Read again a while back on every
            // look: a transaction that began earlier can commit its events
            // after later ones, stamped with its own start.
            const sent = new Map<string, number>();
            while (!signal.aborted) {
              try {
                const from = new Date(Math.max(looked.getTime(), newest.getTime() - LIVE_LOOKBACK_MS));
                for (const event of await eventsAfter(companyId, from)) {
                  if (sent.has(event.id)) continue;
                  sent.set(event.id, event.at.getTime());
                  if (event.at > newest) newest = event.at;
                  send({ id: event.id, type: event.type, taskId: event.taskId, actor: event.actor, at: event.at }, event.id);
                }
                for (const [id, at] of sent) if (at < newest.getTime() - 2 * LIVE_LOOKBACK_MS) sent.delete(id);
              } catch {
                // The database's moment: the next look tries again, and the
                // console still has its own reloads to fall back on.
              }
              await new Promise<void>((resolve) => {
                const wake = setTimeout(resolve, LIVE_POLL_MS);
                signal.addEventListener('abort', () => { clearTimeout(wake); resolve(); }, { once: true });
              });
            }
          });
        },
      },

      {
        // Who is seated in this company beside the owner (0110).
        method: 'GET',
        pattern: '/api/companies/:companyId/staff',
        handle: async ({ params }) => ({ seats: await this.#staff.list(params.companyId!) }),
      },

      {
        // A seat, made with the owner's device: letting another person in is
        // the loosening of all loosenings. Answers with the invite for them.
        method: 'POST',
        pattern: '/api/companies/:companyId/staff',
        handle: async ({ params, body }) => {
          const request = seatRequest(body);
          await this.#requireFactor(body.proof, `seat ${request.name}`, params.companyId!);
          return this.#staff.create(params.companyId!, request);
        },
      },

      {
        // Ended at once, with its sessions: a tightening, so the session's.
        method: 'POST',
        pattern: '/api/companies/:companyId/staff/:seatId/revoke',
        handle: async ({ params }) => {
          await this.#staff.revoke(params.companyId!, params.seatId!);
          return { ok: true };
        },
      },

      {
        // The owner's first hour with a new company (first-hour.ts): four
        // steps, each done when the owner has done it.
        method: 'GET',
        pattern: '/api/companies/:companyId/first-hour',
        handle: async ({ params }) => firstHourOf(params.companyId!),
      },

      {
        // Closed by the owner: the Overview stops listing it and the CEO
        // stops interviewing. Nothing the owner has not done is ticked off.
        method: 'POST',
        pattern: '/api/companies/:companyId/first-hour/close',
        handle: async ({ params }) => {
          await closeFirstHour(params.companyId!);
          return firstHourOf(params.companyId!);
        },
      },

      {
        // Everything the company produced for a person to read, newest first
        // (the analysis of 3 October, §9 P1 item 12): each task's
        // deliverables, across every task.
        method: 'GET',
        pattern: '/api/companies/:companyId/gallery',
        handle: async ({ params, query }) => galleryOf(params.companyId!, {
          ...(query.get('limit') === null ? {} : { limit: wholeNumber(query.get('limit'), 'limit') }),
          // The `next` of the page before: read, not trusted (views.ts galleryCursor).
          ...(query.get('before') ? { before: query.get('before')! } : {}),
        }),
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
          const division = query.get('division');
          return memoriesOf(params.companyId!, {
            ...(kind ? { kind } : {}),
            ...(query.get('q') ? { query: query.get('q')! } : {}),
            ...(division && /^[0-9a-f-]{36}$/.test(division) ? { divisionId: division } : {}),
            // The `next` of the page before: read, not trusted (inbox.ts readCursor).
            ...(query.get('before') ? { before: query.get('before')! } : {}),
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
        // Whether a load balancer should send this process requests: what
        // `/api/health` says, and no from the moment the process begins to
        // stop, while it still answers everything else (Buzz's readiness).
        // `/api/health` keeps saying whether the process works, which is what
        // a supervisor that restarts it needs; a stopping process still works.
        // Open for the same reason, and says as little.
        method: 'GET',
        pattern: '/api/ready',
        open: true,
        handle: async () => {
          this.#readinessAsked = true;
          const stopping = new WithStatus(503, { ok: false, stopping: true, version: VERSION });
          if (this.#draining) return stopping;
          const health = this.#options.health ? await this.#options.health() : { ok: true };
          // The stop may have begun while the database was being asked.
          if (this.#draining) return stopping;
          return new WithStatus(health.ok ? 200 : 503, { ...health, stopping: false });
        },
      },

      {
        // Section 12: what this deployment is doing, for a metrics scraper.
        // Not the owner's session, which a scraper does not hold, but a token
        // of its own: what it answers is about every company -- how much work
        // each has waiting and what each has spent -- so it is served to
        // nobody until the operator has chosen who may read it.
        method: 'GET',
        pattern: '/api/metrics',
        open: true,
        handle: async ({ request }) => {
          const metrics = this.#options.metrics;
          if (!metrics) {
            throw new PalugadaError(
              'metrics.off',
              'metrics are off: set PALUGADA_METRICS_TOKEN to a secret of at least 32 characters, '
                + 'and give the scraper the same token as its bearer token',
              {},
            );
          }
          if (!sameSecret(bearer(request) ?? '', metrics.token)) {
            throw new PalugadaError('metrics.refused', 'send the metrics token as a bearer token', {});
          }
          return new PlainText('text/plain; version=0.0.4; charset=utf-8', await metrics.text());
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
            todo: notes.filter((note) => !/^(enrolled |bound by |bound from |model: |model prices from |runtimes: |seeded |finished runs go to |charters kept in )/.test(note)),
            // The one note that stops every role from working, said apart from
            // the optional rest: a company can be started without a model and
            // then runs none of its work.
            modelMissing: notes.some((note) => note.startsWith('no model:')),
            version: VERSION,
          };
        },
      },

      /* ---------------------------------------------------- F10.2, F10.3 --- */

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/inbox/:itemId/decide',
        handle: async ({ params, body, session, staff }) => {
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
          const presented = body.proof === undefined ? undefined : proofFrom(body.proof);
          if (presented && 'recovery' in presented) {
            // Refused by the check that knows what a code may do, and not spent.
            await this.#options.mfa.verifyRecoveryCode(presented.recovery, { purpose: 'inbox.decide', subjectId: params.itemId! });
          }
          const proof = presented && !('recovery' in presented) ? presented : undefined;

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
              // 0083: `decide` checks it, and asks for the factor it needs.
              ...(body.allowForHours === undefined || body.allowForHours === null
                ? {} : { allowForHours: Number(body.allowForHours) }),
              // 0116: every time the card's schedule does exactly this.
              ...(body.forSchedule === true ? { forSchedule: true } : {}),
              // A staff seat's decision: `decide` holds it to tier 2 and below.
              seat: staff ? { id: staff.seat.id, name: staff.seat.name } : null,
            },
          );
          void session;
          return { ok: true };
        },
      },

      {
        // 0083: the yeses the owner gave for a while, still in force; and
        // 0116's, given to a schedule for one exact action.
        method: 'GET',
        pattern: '/api/companies/:companyId/standing-approvals',
        handle: async ({ params }) => ({
          standing: await inbox.standingApprovals(params.companyId!),
          schedules: await inbox.scheduleApprovals(params.companyId!),
        }),
      },

      {
        // Taking one back is a tightening, so the session is enough.
        method: 'POST',
        pattern: '/api/companies/:companyId/schedule-approvals/:approvalId/revoke',
        handle: async ({ params }) => {
          await inbox.revokeScheduleApproval(params.companyId!, params.approvalId!);
          return { ok: true };
        },
      },

      {
        // Taking one back is a tightening, so the session is enough.
        method: 'POST',
        pattern: '/api/companies/:companyId/standing-approvals/:standingId/revoke',
        handle: async ({ params }) => {
          await inbox.revokeStanding(params.companyId!, params.standingId!);
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
        handle: async ({ params, body, staff }) => inbox.decideMany(
          params.companyId!, body.itemIds as string[], body.decision as 'approve' | 'deny', String(body.note ?? ''),
          { channel: 'app', assurance: 'session', seat: staff ? { id: staff.seat.id, name: staff.seat.name } : null },
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

      {
        // F11.2 from the Work page: every step of a task, what each was asked
        // and what it returned, what the model calls cost, and where content
        // from outside came in. Redacted like the task itself.
        method: 'GET',
        pattern: '/api/companies/:companyId/tasks/:taskId/trace',
        handle: async ({ params, query }) => {
          const trace = await traceOfTask(params.companyId!, params.taskId!, {
            includePrompts: query.get('prompts') === '1',
          });
          if (!trace) throw new PalugadaError('contract.violation', 'no such task in this company', {});
          return redactor.redactDeep(trace);
        },
      },

      {
        // What one run was told (0076): the request its runtime received,
        // whatever the runtime. Kept redacted; redacted again on the way out,
        // for a secret registered since.
        method: 'GET',
        pattern: '/api/companies/:companyId/tasks/:taskId/runs/:runId/briefing',
        handle: async ({ params }) => {
          const found = await briefingOf(params.companyId!, params.taskId!, params.runId!);
          if (!found) throw new PalugadaError('contract.violation', 'no such run of this task', {});
          return redactor.redactDeep(found);
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
        // Closing a company (0088): frozen now, erased on a day 7 to 90 days
        // away, every row of it. Nothing erased comes back, so it takes the
        // owner's device and the company's name typed out -- the one
        // confirmation a slip on the wrong company's page does not pass. Both
        // are checked before the code is spent.
        method: 'POST',
        pattern: '/api/companies/:companyId/close',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          const name = await withControlPlane(async (tx) => {
            const { rows } = await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]);
            return rows[0]?.name ?? null;
          });
          if (name === null) throw new PalugadaError('contract.violation', `no company ${companyId}`, { companyId });
          if (typeof body.name !== 'string' || body.name.trim() !== name) {
            throw new PalugadaError('contract.violation',
              "type the company's name exactly as it is shown, to close it", { field: 'name' });
          }
          const days = Number(body.days);
          assertClosingDays(days);
          await this.#requireFactor(body.proof, `close ${name}`, companyId);
          const { eraseAfter } = await closeCompany(companyId, days);
          return { eraseAfter: eraseAfter.toISOString() };
        },
      },

      {
        // Keeping it is the safe direction, so the session is enough. The
        // company stays frozen: unfreezing is the owner's other decision.
        method: 'POST',
        pattern: '/api/companies/:companyId/close/keep',
        handle: async ({ params }) => {
          await keepCompany(params.companyId!);
          return { ok: true };
        },
      },

      {
        // What was erased here, and when: the one line each erased company
        // leaves. And the companies whose day has come and whose erasure
        // failed (0096), with why and when it is tried again: an erasure the
        // owner is owed and has not had is theirs to know about.
        method: 'GET',
        pattern: '/api/erasures',
        handle: async () => ({ erasures: await erasures(), failing: await failingErasures() }),
      },

      {
        method: 'POST',
        pattern: '/api/control/company/:companyId/freeze',
        handle: async ({ params, body }) => {
          if (body.on === false) {
            // A closing company is kept first, and unfrozen after: thawing
            // one that is still to be erased would set it working on a
            // business the owner has decided to end.
            if (await closingOf(params.companyId!)) {
              throw new PalugadaError('contract.violation',
                'this company is closing; keep it first, then unfreeze it', { companyId: params.companyId });
            }
            await this.#requireFactor(body.proof, 'unfreeze a company', params.companyId!);
            await unfreezeCompany(params.companyId!);
          } else {
            await freezeCompany(params.companyId!);
          }
          return { ok: true };
        },
      },

      {
        // The guardian (row 7 of the competitive analysis of 2026-09-30,
        // 0092): a model that may send a low-tier call to the owner after the
        // work read content from outside. Turning it on only tightens;
        // turning it off loosens, so it takes the owner's device.
        method: 'POST',
        pattern: '/api/companies/:companyId/guardian',
        handle: async ({ params, body }) => {
          if (typeof body.on !== 'boolean') {
            throw new PalugadaError('contract.violation', 'on must be true or false', { field: 'on' });
          }
          if (!body.on) await this.#requireFactor(body.proof, 'turn the guardian off', params.companyId!);
          const { rowCount } = await withControlPlane((tx) => tx.query(
            'UPDATE companies SET guardian = $2 WHERE id = $1', [params.companyId, body.on]));
          if (rowCount === 0) {
            throw new PalugadaError('contract.violation', 'there is no company with that id', { companyId: params.companyId });
          }
          return { on: body.on };
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
        // How long a code just shown covers what builds the company (0120).
        method: 'GET',
        pattern: '/api/control/step-up',
        handle: async () => ({ minutes: await stepUpMinutes(), choices: [...STEP_UP_CHOICES] }),
      },

      {
        // Raising it loosens, so it takes a code -- which opens the window it
        // chose; lowering, or turning it off, is the session's to do.
        method: 'POST',
        pattern: '/api/control/step-up',
        handle: async ({ body }) => {
          const minutes = checkedStepUp(body.minutes);
          if (minutes > await stepUpMinutes()) await this.#requireFactor(body.proof, 'keep a code valid for longer');
          await setStepUpMinutes(minutes);
          return { minutes };
        },
      },

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

      /* --------------------------------------------------- money display --- */

      {
        // The currency the owner reads money in, and the rate (0106). Kept
        // here rather than in the browser, like the panel's language, so it
        // follows the owner to every device. PALUGADA counts in US dollars.
        method: 'GET',
        pattern: '/api/control/money-display',
        handle: async () => (await moneyDisplay()) ?? { currency: null, rate: null },
      },

      {
        // How amounts are read, not what anything costs: no factor, since
        // nothing is loosened. `currency: null` goes back to US dollars.
        method: 'POST',
        pattern: '/api/control/money-display',
        handle: async ({ body }) => (await setMoneyDisplay(
          body.currency === null ? null : { currency: body.currency, rate: body.rate },
        )) ?? { currency: null, rate: null },
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
            // What each model the tiers name costs, and who said so (L12): the
            // owner here, the operator's file, or nobody -- the fallback,
            // high on purpose, which the console says in as many words.
            prices: this.#pricesFor(effective ? MODEL_TIERS.map((tier) => effective.aliases[tier]) : [], stored),
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
        // What models.dev says each model the tiers name costs, for the owner
        // to look at and save (L12). Saves nothing, and sends nothing of the
        // deployment's: the catalogue is read whole and searched here.
        method: 'POST',
        pattern: '/api/control/settings/model/prices/lookup',
        handle: async () => {
          const deployment = this.#deploymentSettings();
          const effective = modelSettingsFrom(deployment.env);
          const models = effective
            ? [...new Set(MODEL_TIERS.map((tier) => effective.aliases[tier]).filter((model): model is string => Boolean(model)))]
            : [];
          if (models.length === 0) return { prices: {}, missing: [], problem: 'no model is set yet' };
          try {
            const found = await lookupPrices(models, { url: effective?.url ?? null, provider: effective?.provider ?? null },
              deployment.baseEnv.PALUGADA_MODELS_DEV_URL ?? MODELS_DEV_URL);
            return { ...found, problem: null };
          } catch (failure) {
            return { prices: {}, missing: models, problem: `models.dev could not be read: ${(failure as Error).message}` };
          }
        },
      },

      {
        // What each model costs, in cents per million tokens, or null to take
        // a price back. A lower price loosens every company's money ceiling,
        // so it takes the owner's device, like the model itself (L12).
        method: 'POST',
        pattern: '/api/control/settings/model/prices',
        handle: async ({ body }) => {
          this.#deploymentSettings();
          const given = body.prices && typeof body.prices === 'object' && !Array.isArray(body.prices)
            ? body.prices as Record<string, unknown> : null;
          if (!given || Object.keys(given).length === 0) {
            throw new PalugadaError('contract.violation', 'say which model costs what: { model: { input, output } }', { field: 'prices' });
          }
          const stored = await readSettings();
          const models = { ...((stored.model_prices as { models?: Record<string, unknown> } | undefined)?.models ?? {}) };
          for (const [model, rate] of Object.entries(given)) {
            if (!model.trim() || model.length > 200 || model.includes('*')) {
              throw new PalugadaError('contract.violation', `"${model.slice(0, 60)}" is not a model's name`, { field: 'prices' });
            }
            if (rate === null) delete models[model];
            else models[model] = rate;
          }
          // Held to the price file's rules before the device is asked for.
          parsePriceTable({ models }, 'these prices');
          await this.#requireFactor(body.proof, 'change what a model costs');
          await writeSetting('model_prices', Object.keys(models).length > 0 ? { models } : null);
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
            whatsapp: {
              source: stored?.whatsapp ? 'console' : env.PALUGADA_WHATSAPP_PHONE_ID ? 'environment' : null,
              phoneNumberId: stored?.whatsapp?.phoneNumberId ?? env.PALUGADA_WHATSAPP_PHONE_ID ?? null,
              owner: stored?.whatsapp?.owner ?? env.PALUGADA_WHATSAPP_OWNER ?? null,
              template: stored?.whatsapp?.template ?? env.PALUGADA_WHATSAPP_TEMPLATE ?? null,
              // What Meta's webhook settings ask for. The verify token only
              // answers Meta's subscription check, and the owner pastes it
              // there, so it is shown to them rather than sealed away.
              callbackUrl: env.PALUGADA_APP_URL_PUBLIC ? `${env.PALUGADA_APP_URL_PUBLIC.replace(/\/+$/, '')}/api/channels/whatsapp` : null,
              verifyToken: stored?.whatsapp
                ? await deployment.secrets.resolve(`db://${stored.whatsapp.verifySecret}`).catch(() => null)
                : null,
            },
            slack: { source: stored?.slack ? 'console' : env.PALUGADA_SLACK_WEBHOOK || env.PALUGADA_SLACK_WEBHOOK_REF ? 'environment' : null },
            email: {
              source: stored?.email ? 'console' : env.PALUGADA_EMAIL_PROVIDER ? 'environment' : null,
              provider: stored?.email?.provider ?? env.PALUGADA_EMAIL_PROVIDER ?? null,
              from: stored?.email?.from ?? env.PALUGADA_EMAIL_FROM ?? null,
              to: stored?.email?.to ?? env.PALUGADA_EMAIL_TO ?? null,
              providers: EMAIL_PROVIDERS.map(({ id, name, keyUrl }) => ({ id, name, keyUrl })),
            },
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
        // The bot's picture: PALUGADA's, the one the console shows beside the
        // button, instead of the blank circle a new bot has. Only a picture,
        // which the owner can change again in @BotFather, so no device.
        method: 'POST',
        pattern: '/api/control/channels/telegram/photo',
        handle: async ({ body }) => {
          const token = await this.#telegramToken(body);
          await outside(telegramProfilePhoto(token, await this.#consolePicture('brand/palugada-profile.jpg'), this.#botApi()));
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
                // The stop button under a draft (TelegramChannel's "Thinking...")
                // arrives as its own kind of update, and only if asked for.
                allowed_updates: ['message', 'callback_query', 'stopped_message_generation'],
              }, this.#botApi());
              webhook = 'set';
            } catch (failure) {
              webhook = (failure as Error).message;
            }
          }
          // The menu under the chat's "/" button, only once the bot can hear
          // what is chosen from it. A convenience: Telegram refusing it leaves
          // a bot that works, so the save stands.
          if (webhook === 'set') {
            await telegramCommands(token, chatId, (await deploymentLanguages()).console ?? 'en', this.#botApi()).catch(() => undefined);
          }
          return { ...this.#applySettings(), webhook };
        },
      },

      {
        // WhatsApp through Meta's Cloud API: the business number's id, a
        // system user's token and the app's secret, checked with Meta before
        // they are sealed. The verify token is made here, for the owner to
        // paste into the app's webhook settings with the callback address.
        method: 'POST',
        pattern: '/api/control/channels/whatsapp',
        handle: async ({ body }) => {
          const deployment = this.#deploymentSettings();
          const stored = ((await readSettings()).channels as ChannelSettings | undefined)?.whatsapp;
          const phoneNumberId = typeof body.phoneNumberId === 'string' ? body.phoneNumberId.trim() : '';
          if (!/^\d{5,20}$/.test(phoneNumberId)) {
            throw new PalugadaError('contract.violation', 'the phone number ID is the number Meta shows under API Setup, digits only; it is not the phone number', { field: 'phoneNumberId' });
          }
          const owner = (typeof body.owner === 'string' ? body.owner : '').replace(/[\s+()-]/g, '');
          if (!/^\d{8,15}$/.test(owner)) {
            throw new PalugadaError('contract.violation', 'your number is written with its country code, as 62812…', { field: 'owner' });
          }
          const template = typeof body.template === 'string' ? body.template.trim() : '';
          if (template && !/^[a-z0-9_]{1,512}:[A-Za-z_]{2,8}$/.test(template)) {
            throw new PalugadaError('contract.violation', 'a template is written as its name and language, as palugada_notice:id', { field: 'template' });
          }
          const typed = (name: string) => (typeof body[name] === 'string' && (body[name] as string).trim() ? (body[name] as string).trim() : null);
          const saved = async (secret: string | undefined) => (secret ? deployment.secrets.resolve(`db://${secret}`).catch(() => null) : null);
          const token = typed('token') ?? await saved(stored?.tokenSecret);
          const appSecret = typed('appSecret') ?? await saved(stored?.appSecretSecret);
          if (!token) throw new PalugadaError('contract.violation', 'paste the access token of a system user that may send for this number', { field: 'token' });
          if (!appSecret || /\s/.test(appSecret)) {
            throw new PalugadaError('contract.violation', 'paste the app secret, from the app\'s Basic settings: it is how a delivery is known to be from Meta', { field: 'appSecret' });
          }
          const number = await outside(whatsappNumber(token, phoneNumberId, this.#whatsappApi()));
          await this.#requireFactor(body.proof, 'connect WhatsApp');
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          const verifyToken = (await saved(stored?.verifySecret)) ?? randomBytes(24).toString('hex');
          await putSecret('channel-whatsapp', token, master);
          await putSecret('channel-whatsapp-app-secret', appSecret, master);
          await putSecret('channel-whatsapp-verify', verifyToken, master);
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          channels.whatsapp = {
            phoneNumberId, owner, ...(template ? { template } : {}),
            tokenSecret: 'channel-whatsapp', appSecretSecret: 'channel-whatsapp-app-secret', verifySecret: 'channel-whatsapp-verify',
          };
          await writeSetting('channels', channels);
          return { ...this.#applySettings(), number };
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
        // One email through the service, with the key typed or the one saved:
        // a message the owner can see arrive before anything is kept.
        method: 'POST',
        pattern: '/api/control/channels/email/test',
        handle: async ({ body }) => {
          const candidate = await this.#emailCandidate(body);
          const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 500) : 'PALUGADA';
          await outside(new EmailChannel({ ...candidate, ...this.#emailApi() }).send('PALUGADA', text));
          return { ok: true };
        },
      },

      {
        // Email to the owner through Resend, Postmark or SendGrid: what needs
        // them, with a link to decide it here. The key is sealed.
        method: 'POST',
        pattern: '/api/control/channels/email',
        handle: async ({ body }) => {
          const deployment = this.#deploymentSettings();
          const candidate = await this.#emailCandidate(body);
          await this.#requireFactor(body.proof, 'connect email');
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          await putSecret('channel-email', candidate.key, master);
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          channels.email = { provider: candidate.provider, from: candidate.from, to: candidate.to, keySecret: 'channel-email' };
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
          if (!['telegram', 'whatsapp', 'push', 'slack', 'discord', 'email'].includes(name)) {
            throw new PalugadaError('contract.violation', `a channel is telegram, whatsapp, push, slack, discord or email; got ${name}`, { name });
          }
          await this.#requireFactor(body.proof, `disconnect ${name}`);
          const channels = { ...((await readSettings()).channels as ChannelSettings | undefined) };
          // Telegram is told too. A webhook left behind kept sending the chat's
          // messages to an address that now refuses them, and Telegram retries
          // a refused update for a day, holding every later one behind it. Best
          // effort: a bot already revoked has no webhook to take off.
          if (name === 'telegram' && channels.telegram) {
            const token = await this.#deploymentSettings().secrets.resolve('db://channel-telegram').catch(() => null);
            if (token) await telegramApi(token, 'deleteWebhook', { drop_pending_updates: true }, this.#botApi()).catch(() => undefined);
          }
          delete channels[name as keyof ChannelSettings];
          await writeSetting('channels', Object.keys(channels).length > 0 ? channels : null);
          const sealed = name === 'telegram' ? ['channel-telegram', 'channel-telegram-webhook']
            : name === 'whatsapp' ? ['channel-whatsapp', 'channel-whatsapp-app-secret', 'channel-whatsapp-verify']
              : [`channel-${name}`];
          for (const secret of sealed) {
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
              embed: EMBED_PROVIDERS, vision: VISION_PROVIDERS,
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
        // A recording to try Listening with, or a picture to try Seeing
        // with, is larger than a search.
        maxBodyBytes: 16 * 1024 * 1024,
        handle: async ({ params, body }) => {
          const { kind, binding } = await this.#toolCandidate(params.kind!, body);
          try {
            const signal = AbortSignal.timeout(kind === 'image' || kind === 'speech' || kind === 'listen' || kind === 'vision' ? 120_000 : 30_000);
            if (kind === 'embed') {
              // One sentence, to show the provider answers and how long its vectors are.
              const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
              const [vector] = await embed({ ...binding as EmbedBinding, model }, [typeof body.text === 'string' && body.text.trim() ? body.text.slice(0, 500) : 'PALUGADA'], signal);
              return { problem: null, dimensions: vector!.length };
            }
            if (kind === 'listen') {
              // A clip the owner recorded on the page, heard once and kept nowhere.
              const text = await transcribe({ ...binding as ToolBinding<ListenProvider>, model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null },
                audioFrom(body), typeof body.language === 'string' ? body.language : null, signal);
              return { problem: null, text };
            }
            if (kind === 'vision') {
              // A picture the owner chose on the page, looked at once and kept nowhere.
              const text = await describePicture({ ...binding as ToolBinding<VisionProvider>, model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null },
                pictureFrom(body), typeof body.question === 'string' && body.question.trim() ? body.question.trim().slice(0, 1_000) : DEFAULT_QUESTION, signal);
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
          // A model and a voice for the kinds that have one, as TOOL_KINDS says.
          const model = 'model' in TOOL_KINDS[kind] ? text('model') : null;
          const voice = 'voice' in TOOL_KINDS[kind] ? text('voice') : null;
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
        handle: async ({ request }) => {
          const deployment = this.#deploymentSettings();
          const running = mcpNamesIn(deployment.env.PALUGADA_MCP_SETTINGS);
          // Where a sign-in comes back, for the vendors that make the owner
          // register a client with it first; null where this console's
          // address is one no sign-in may come back to, and the start says why.
          let callback: string | null = null;
          try {
            callback = this.#callbackAddress(request);
          } catch {
            callback = null;
          }
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
            // The servers signed in to with OAuth, by name: never a token.
            signedIn: Object.fromEntries(Object.entries(oauthGrantsIn(await readSettings()))
              .map(([name, grant]) => [name, { issuer: grant.issuer, url: grant.url }])),
            callback,
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
          // A saved server by its name alone looks at it where it was saved,
          // with its token: what the assistant may ask, and never another address.
          const saved = body.url === undefined && typeof body.name === 'string'
            ? mcpServersIn(await readSettings()).find((one) => one.name === body.name) : undefined;
          if (body.url === undefined && !saved) {
            throw new PalugadaError('config.invalid', 'give the server\'s address, or the name of one already saved', { field: 'url' });
          }
          const url = saved ? saved.url : mcpUrl(body.url);
          const { token, signedIn } = await this.#mcpToken(body, url);
          const tokenIn = signedIn ? undefined : saved ? saved.tokenIn : mcpTokenIn(body.tokenIn);
          try {
            return { problem: null, tools: await offeredTools(accessFor({ url, ...(tokenIn ? { tokenIn } : {}) }, token)) };
          } catch (failure) {
            // A server that wants a sign-in says where, and the owner is
            // offered it rather than a 401 to make sense of.
            if (failure instanceof McpUnauthorized && !token) {
              const point = await discoverSignIn(url).catch(() => null);
              if (point) {
                return { problem: `${new URL(url).host} asks you to sign in, with ${point.issuer}`, signIn: point.issuer };
              }
            }
            return { problem: (failure as Error).message };
          }
        },
      },

      {
        // Begins a sign-in to a server that asks for OAuth, and answers with
        // the page the owner's browser opens to sign in.
        //
        // With the owner's device, as a division's sign-in is (B4). The
        // tokens it leaves are kept under the server's name when the browser
        // comes back, and a saved server of that name signs in with them from
        // then on: without the device, anyone holding the owner's session
        // could sign a saved server in as an account of their own. Asked after
        // the server is found and a client is registered, so one that cannot
        // be signed in to is refused without spending a code; the sign-in
        // that began is then unusable, its state never handed over, and
        // expires in minutes.
        method: 'POST',
        pattern: '/api/control/mcp/oauth/start',
        handle: async ({ body, request }) => {
          const deployment = this.#deploymentSettings();
          const name = mcpServerNamed(body.name);
          const url = mcpUrl(body.url);
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
          const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
          const { authorizeUrl, issuer } = await beginSignIn({
            name, url, master,
            redirectUri: this.#callbackAddress(request),
            client: clientId ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : null,
          });
          await this.#requireFactor(body.proof, `sign in to the MCP server ${name}`);
          return { authorizeUrl, issuer };
        },
      },

      {
        // Where the authorization server sends the owner's browser back. Open,
        // because that browser has no session: the state stands in for one,
        // made by the owner's own console, spent here, and good for minutes.
        method: 'GET',
        pattern: '/api/oauth/callback',
        open: true,
        handle: async ({ query }) => {
          const deployment = this.#deploymentSettings();
          const master = deployment.master(false);
          const language = (await deploymentLanguages()).console;
          try {
            if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
            // A division's sign-in for a vendor key, when the state is one of those.
            const signedIn = await finishCredentialSignIn(query, { secrets: deployment.secrets });
            if (signedIn) {
              await this.#keepDivisionKey({ ...signedIn, value: signedIn.grant, prefix: OAUTH_CREDENTIALS });
              const provider = this.#signInFor(signedIn.alias, null)?.name ?? signedIn.provider;
              return new HtmlPage(200,
                say(language, 'Signed in to {provider} for the {alias} key', { provider, alias: signedIn.alias }),
                say(language, 'Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.'),
                language);
            }
            const { name } = await finishSignIn(query, { secrets: deployment.secrets, master });
            return new HtmlPage(200,
              say(language, 'Signed in to {name}', { name }),
              say(language, 'Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.'),
              language);
          } catch (failure) {
            return new HtmlPage(400, say(language, 'Not signed in'), (failure as Error).message, language);
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
          const { token, typed, keep, signedIn } = await this.#mcpToken(body, url);
          // A sign-in's token is a bearer token (RFC 6750), however a preset
          // says a pasted key is sent.
          const tokenIn = signedIn ? undefined : mcpTokenIn(body.tokenIn);
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
          const secret = mcpSecretName(name);
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
          await deleteSecret(mcpSecretName(name));
          await forgetSignIn(name);
          return this.#applySettings();
        },
      },

      /* ---------------------------------------------------- services --- */

      {
        // The services capabilities call: the presets this repository ships,
        // the ones the owner connected here, and which preset names the
        // deployment binds some other way. A division's key is the
        // division's, below, never here.
        method: 'GET',
        pattern: '/api/control/vendors',
        handle: async () => {
          this.#deploymentSettings();
          const saved = vendorsIn(await readSettings());
          const presets = await vendorPresets();
          const taken: Record<string, string> = {};
          for (const preset of presets) {
            // A binding that gives way to a service is not one that takes its name.
            const bound = this.#options.registry?.get(preset.name);
            if (bound && !bound.fallback && !saved.some((one) => one.name === preset.name)) taken[preset.name] = bound.adapter;
          }
          return { presets, saved, taken };
        },
      },

      {
        // A service connected from the console: the file's entry, checked as
        // the file is, before the device is asked for.
        method: 'POST',
        pattern: '/api/control/vendors',
        handle: async ({ body }) => {
          this.#deploymentSettings();
          const saved = vendorsIn(await readSettings());
          const entry = checkVendorEntry(body.entry, this.#options.registry, saved.map((one) => one.name));
          await this.#requireFactor(body.proof, `connect ${entry.name}`);
          await writeSetting('vendors', { capabilities: [...saved.filter((one) => one.name !== entry.name), entry] });
          return { ...this.#applySettings(), name: entry.name };
        },
      },

      {
        method: 'POST',
        pattern: '/api/control/vendors/:name/remove',
        handle: async ({ params, body }) => {
          this.#deploymentSettings();
          const name = params.name!;
          const saved = vendorsIn(await readSettings());
          if (!saved.some((one) => one.name === name)) {
            throw new PalugadaError('contract.violation', `${name} is not a service connected in the console`, { name });
          }
          await this.#requireFactor(body.proof, `disconnect ${name}`);
          const rest = saved.filter((one) => one.name !== name);
          await writeSetting('vendors', rest.length > 0 ? { capabilities: rest } : null);
          return this.#applySettings();
        },
      },

      {
        // The ways of working a role can take after, by title: what the
        // owner picks from, and what the assistant proposes from.
        method: 'GET',
        pattern: '/api/personas',
        handle: async () => ({ titles: TITLES, personas: PERSONAS }),
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
          return { ok: true, result: await this.#applyProposal(proposal, { ...typed, ...(body.proof === undefined ? {} : { proof: body.proof }) }, request, session, 'console') };
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

      /* ----------------------------------------- a company's CEO (0068) --- */

      {
        // The owner's conversation with a company is with its CEO: the same
        // reads and cards as the assistant's, held to that company, in the
        // CEO's name and persona (owner/assistant.ts).
        method: 'GET',
        pattern: '/api/companies/:companyId/conversation',
        handle: async ({ params }) => ({
          available: Boolean(this.#options.assistant?.llm),
          voice: { listen: Boolean(this.#options.assistant?.voice?.listen), speak: Boolean(this.#options.assistant?.voice?.speak) },
          ceo: await speakerOf(params.companyId!),
          messages: await conversation(60, params.companyId!),
        }),
      },

      {
        // The CEO speaks first when the owner comes back and something has
        // happened since the last word (owner/ceo-briefing.ts). The console
        // asks as it opens the conversation; most times there is nothing to say.
        method: 'POST',
        pattern: '/api/companies/:companyId/conversation/briefing',
        handle: async ({ params }) => {
          await speakerOf(params.companyId!);
          return { spoke: await ceoBriefsOwner(params.companyId!) };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/conversation/messages',
        handle: async ({ request, session, params, body }) => ({
          messages: await converse({
            llm: this.#options.assistant?.llm ?? null,
            reach: this.#reach(request, session),
            language: async () => (await deploymentLanguages()).console ?? 'en',
            companyId: params.companyId!,
          }, requireText(body.text, 'text'), 'console'),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/conversation/clear',
        handle: async ({ params }) => {
          await speakerOf(params.companyId!);
          await forgetConversation(params.companyId!);
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
              accepted: setting?.acceptVersion ?? null,
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
            // The latest was chosen with the owner's device, knowing it is not
            // the version checked, so it is accepted; the checked one needs no
            // acceptance, and a stale one would outlive the install.
            const { acceptVersion: _stale, ...kept } = current;
            const installed = found.version ? versionIn(found.version) : null;
            agents[entry.name] = {
              ...kept, command: found.command,
              ...(version === 'latest' && installed ? { acceptVersion: installed } : {}),
            };
            await writeSetting('agents', agents);
            if (current.enabled) this.#applySettings();
          });
          return { job };
        },
      },

      {
        // A version other than the one whose containment was checked
        // (`checked-versions.ts`), accepted as it is installed now. It lets a
        // CLI run whose flags nobody read at that version, so it takes the
        // owner's device, like installing the latest does.
        method: 'POST',
        pattern: '/api/control/agents/:name/accept',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const entry = agentNamed(params.name!);
          const stored = await readSettings();
          const agents = agentsFrom(stored, deployment.baseEnv);
          // The same one the page shows as installed.
          const found = await findAgent(entry, stateDirFrom(deployment.baseEnv));
          if (!found?.version) {
            throw new PalugadaError('contract.violation',
              `${entry.title} is not installed here, or did not say its version; install it first`, { agent: entry.name });
          }
          const version = versionIn(found.version);
          await this.#requireFactor(body.proof, `run ${entry.title} ${version}, a version PALUGADA did not check`);
          const current = agents[entry.name] ?? { enabled: false };
          agents[entry.name] = { ...current, acceptVersion: version };
          await writeSetting('agents', agents);
          if (current.enabled) this.#applySettings();
          return { accepted: version };
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
          const change: { console?: string | null; agents?: string | null } = {};
          if (body.console !== undefined) {
            change.console = body.console === null ? null : languageCode(body.console, 'console');
          }
          // Null is an answer: the agents follow the panel's language.
          if (body.agents !== undefined) change.agents = body.agents === null ? null : languageCode(body.agents, 'agents');
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

      {
        // The hours the company keeps for what reaches the outside world
        // (STATUS 2.150). It only ever defers an action, so it takes the
        // session and not a second factor.
        method: 'GET',
        pattern: '/api/companies/:companyId/office-hours',
        handle: async ({ params }) => ({
          hours: await withTenant(params.companyId!, (tx) => officeHours(tx, params.companyId!)),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/office-hours',
        handle: async ({ params, body }) => {
          const daysOfWeek = Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map((day) => Number(day)) : [1, 2, 3, 4, 5];
          const except = Array.isArray(body.except) ? body.except.map(String) : [];
          const hours = {
            timezone: String(body.timezone ?? 'UTC'),
            startHour: Number(body.startHour), endHour: Number(body.endHour), daysOfWeek,
          };
          assertOfficeHours(hours);
          // A name that is no capability would keep nothing open and look as if
          // it did.
          const known = new Set(catalogueNames());
          for (const row of (await withControlPlane((tx) => tx.query<{ name: string }>(
            'SELECT name FROM capabilities WHERE name = ANY($1)', [except]))).rows) known.add(row.name);
          const unknown = except.find((name) => !known.has(name));
          if (unknown !== undefined) {
            throw new PalugadaError('contract.violation',
              `except names ${JSON.stringify(unknown)}, which is not a capability; use a name such as chat.send`, { field: 'except' });
          }
          await setOfficeHours({ companyId: params.companyId!, ...hours, except });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/office-hours/clear',
        handle: async ({ params }) => {
          await clearOfficeHours(params.companyId!);
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
        // PALUGADA's own assistant beside the companies: it is no company's (N8).
        handle: async ({ query }) => ({
          companies: await platformCost(windowFrom(query)),
          assistant: await assistantCost(windowFrom(query)),
        }),
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
        //
        // And the task as Work lists it (`item`), for a link to work that is
        // not on the page the owner has open: a ticket's work, a decision's
        // task, a search result (0074).
        method: 'GET',
        pattern: '/api/companies/:companyId/tasks/:taskId',
        handle: async ({ params }) => {
          const task = await taskDetailOf(params.companyId!, params.taskId!);
          if (!task) {
            throw new PalugadaError('contract.violation', 'no such task in this company', { taskId: params.taskId });
          }
          const item = (await workOf(params.companyId!, { taskId: params.taskId!, limit: 1 })).items[0] ?? null;
          // Whether a replay can run here: only for a role this deployment
          // runs as an in-process handler. The console offered it on every
          // task, and on a deployment started by `npm start` -- which runs
          // none -- every press was refused (F11.4).
          const replayable = Boolean(item && this.#options.replayHandlers?.has(item.roleSlug));
          return { task, item, replayable };
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
        // A task its budget stopped, going on from where it stopped: the same
        // task and journal, after the owner raised the ceiling. Never done by
        // the platform on its own (section 6.3). Spends from a ceiling the
        // owner raised with a factor, and loosens nothing itself: the session.
        method: 'POST',
        pattern: '/api/companies/:companyId/tasks/:taskId/continue',
        handle: async ({ params }) => {
          await continueHalted(params.companyId!, params.taskId!);
          return { continued: true };
        },
      },

      {
        // The same work again, as a new task, with the owner's note in front
        // of the run. The way on from a halt that is not about the budget.
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
        handle: async ({ params, request, raw, query }) => {
          // A sender that can set nothing but the address carries the token
          // there (0097); only a door made for that takes it.
          const token = query.get('token');
          return receiveHook(params.publicId!, { raw, headers: request.headers, ...(token ? { token } : {}) }, this.#options.secrets);
        },
      },

      {
        // A customer channel (0111, 0112): where Telegram or Meta posts what
        // a customer writes to the company. Open, like a trigger's address;
        // Telegram's secret header or Meta's signature over the bytes stands
        // in for a session, checked before the body is read for anything
        // (src/chats/hook.ts).
        method: 'POST',
        pattern: '/api/chat-hooks/:publicId',
        open: true,
        raw: true,
        maxBodyBytes: 256 * 1024,
        handle: async ({ params, request, raw }) =>
          receiveChatHook(params.publicId!, { raw, headers: request.headers }, this.#options.secrets),
      },

      {
        // Meta's check when the owner saves a customer number's webhook in
        // the app: the challenge, as plain text, for the channel's verify
        // token only.
        method: 'GET',
        pattern: '/api/chat-hooks/:publicId',
        open: true,
        handle: async ({ params, query }) =>
          new PlainText('text/plain; charset=utf-8', await verifyChatHook(params.publicId!, query)),
      },

      {
        // The company's customer channels: never a token, nor where it is sealed.
        method: 'GET',
        pattern: '/api/companies/:companyId/chat-channels',
        handle: async ({ params }) => ({ channels: await channelsOf(params.companyId!) }),
      },

      {
        // A bot or a WhatsApp number of the company's own, answered by the
        // role the owner names. With the device: it seals keys, lets
        // strangers start work, and gives the role two capabilities it may
        // not have had (F2.9). The keys are checked with Telegram or Meta
        // before anything is kept.
        method: 'POST',
        pattern: '/api/companies/:companyId/chat-channels',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          if (body.kind === 'whatsapp') return this.#connectWhatsApp(companyId, body);
          if (body.kind === 'email') return this.#connectMailbox(companyId, body);
          if (body.kind !== 'telegram') {
            throw new PalugadaError('contract.violation', `a customer channel is telegram, whatsapp or email; got ${String(body.kind)}`, { field: 'kind' });
          }
          // Telegram's webhook is set here when this deployment has a public
          // address; without one the channel is kept and cannot hear, and
          // the owner is told.
          const token = typeof body.token === 'string' ? body.token.trim() : '';
          if (!/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(token)) {
            throw new PalugadaError('contract.violation',
              'paste the token @BotFather gave the bot: digits, a colon, then letters and digits', { field: 'token' });
          }
          const where = await checkChannel(companyId, {
            roleId: body.roleId, goalId: body.goalId, instruction: body.instruction, maxPerHour: body.maxPerHour,
          });
          const bot = await outside(telegramBot(token, this.#botApi()));
          if (!bot.username) throw new PalugadaError('contract.violation', 'that token is not a bot\'s', { field: 'token' });
          await assertAccountFree(companyId, 'telegram', bot.username);
          await this.#requireFactor(body.proof, 'let customers write to the company', companyId);
          const deployment = this.#deploymentSettings();
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          const sealed = `chat-${randomBytes(8).toString('hex')}`;
          const webhookSecret = randomBytes(24).toString('hex');
          await putSecret(sealed, token, master);
          let opened: Awaited<ReturnType<typeof openChannel>>;
          try {
            opened = await openChannel(companyId, {
              kind: 'telegram', account: bot.username, ...where, tokenRef: `db://${sealed}`, webhookHash: hashSecret(webhookSecret),
            });
          } catch (failure) {
            await deleteSecret(sealed).catch(() => undefined);
            throw failure;
          }
          for (const ref of opened.replacedRefs) await deleteSecret(ref.slice('db://'.length));
          await this.#answerCustomers(companyId, where.divisionId, where.roleId, `@${bot.username}`);
          let webhook = 'no_public_address';
          const publicUrl = deployment.baseEnv.PALUGADA_APP_URL_PUBLIC;
          if (publicUrl) {
            try {
              await telegramApi(token, 'setWebhook', {
                url: `${publicUrl.replace(/\/+$/, '')}/api/chat-hooks/${opened.publicId}`,
                secret_token: webhookSecret,
                allowed_updates: ['message'],
              }, this.#botApi());
              webhook = 'set';
            } catch (failure) {
              webhook = (failure as Error).message;
            }
          }
          return { channel: (await channelsOf(companyId)).find((one) => one.id === opened.id), webhook };
        },
      },

      {
        // Closing lets the account go: a bot's webhook taken off, its keys
        // deleted and its address answering nothing. It loosens nothing, so
        // the session; what was said stays, and connecting the same account
        // again opens the same channel at a new address. A WhatsApp number's
        // webhook is the Meta app's, which the owner changes there.
        method: 'POST',
        pattern: '/api/companies/:companyId/chat-channels/:channelId/close',
        handle: async ({ params }) => {
          const companyId = params.companyId!;
          const held = await withControlPlane(async (tx) => (await tx.query<{ token_ref: string | null }>(
            'SELECT token_ref FROM chat_channels WHERE id::text = $1 AND company_id = $2', [params.channelId!, companyId])).rows[0]);
          // Read before it is deleted: taking the webhook off needs the token.
          const token = held?.token_ref
            ? await this.#deploymentSettings().secrets.resolve(held.token_ref).catch(() => null)
            : null;
          const closed = await closeChannel(companyId, params.channelId!);
          if (token && closed.kind === 'telegram') {
            await telegramApi(token, 'deleteWebhook', { drop_pending_updates: true }, this.#botApi()).catch(() => undefined);
          }
          for (const ref of closed.sealedRefs) await deleteSecret(ref.slice('db://'.length));
          return { closed: true };
        },
      },

      {
        // A channel answering on its own (0117): a reply grounded in the
        // documents the owner marked for customers goes without a card when
        // chat.send's check finds it so. Turning it on loosens a control, so
        // the device; turning it off tightens one, so the session. On, the
        // role that answers is given memory.search first, without which it
        // could find no passage to answer from.
        method: 'POST',
        pattern: '/api/companies/:companyId/chat-channels/:channelId/answers-alone',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          if (typeof body.on !== 'boolean') throw new PalugadaError('contract.violation', 'on is true or false', { field: 'on' });
          if (body.on) {
            const channel = (await channelsOf(companyId)).find((one) => one.id === params.channelId);
            if (!channel) throw new PalugadaError('contract.violation', 'no such channel in this company', { channelId: params.channelId });
            await this.#requireFactor(body.proof, 'let a channel answer customers on its own', companyId);
            const divisionId = await withTenant(companyId, async (tx) => (await tx.query<{ division_id: string }>(
              'SELECT division_id FROM roles WHERE id = $1', [channel.roleId])).rows[0]!.division_id);
            await this.#answerCustomers(companyId, divisionId, channel.roleId, channel.account, ['chat.read', 'chat.send', 'memory.search']);
          }
          await setAnswersAlone(companyId, params.channelId!, body.on);
          return { answersAlone: body.on };
        },
      },

      /* ------------------------------------------------------- 0119 --- */

      {
        // The books (0119): every account with what it holds, and the latest
        // entries. Opened the first time they are looked at.
        method: 'GET',
        pattern: '/api/companies/:companyId/books',
        handle: async ({ params }) => withTenant(params.companyId!, async (tx) => {
          // This month so far, in the deployment's calendar.
          const to = new Date().toISOString().slice(0, 10);
          const from = `${to.slice(0, 7)}-01`;
          return {
            accounts: await balancesOf(tx, params.companyId!),
            entries: (await entriesOf(tx, params.companyId!, { limit: 200 })).entries,
            month: { from, to, profit: await profitOf(tx, params.companyId!, from, to) },
          };
        }),
      },

      {
        // The owner's own accounts and entries, with the session: they move
        // no money, and a wrong entry is undone by a reversing one.
        method: 'POST',
        pattern: '/api/companies/:companyId/books/accounts',
        handle: async ({ params, body }) => ({
          accountId: await withTenant(params.companyId!, (tx) => addAccount(tx, params.companyId!, body)),
        }),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/books/entries',
        handle: async ({ params, body }) => {
          const entry = entryInput(body);
          return { entryId: await withTenant(params.companyId!, (tx) => postEntry(tx, params.companyId!, entry, 'owner')) };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/books/entries/:entryId/reverse',
        handle: async ({ params }) => ({
          entryId: await withTenant(params.companyId!, (tx) => reverseEntry(tx, params.companyId!, params.entryId!, 'owner')),
        }),
      },

      /* ------------------------------------------------------- 0122 --- */

      {
        // The company's invoices (0122): the latest first, what is owed on
        // them all, and with `?status=` only those open, overdue, paid or void.
        method: 'GET',
        pattern: '/api/companies/:companyId/invoices',
        handle: async ({ params, query }) => {
          const status = query.get('status');
          if (status !== null && !(INVOICE_FILTERS as readonly string[]).includes(status)) {
            throw new PalugadaError('contract.violation', `status is ${INVOICE_FILTERS.join(', ')}; got ${JSON.stringify(status)}`, { field: 'status' });
          }
          const { invoices, outstanding } = await withTenant(params.companyId!, (tx) => listInvoices(tx, params.companyId!, {
            ...(status ? { status: status as InvoiceFilter } : {}),
          }));
          return { invoices, outstanding };
        },
      },

      {
        // One invoice, by its id or its number, with its lines and payments.
        method: 'GET',
        pattern: '/api/companies/:companyId/invoices/:invoiceId',
        handle: async ({ params }) => {
          const found = await withTenant(params.companyId!, (tx) => invoiceWith(tx, params.companyId!, params.invoiceId!));
          if (!found) throw new PalugadaError('contract.violation', `no invoice ${params.invoiceId} in these books`, { field: 'invoice' });
          return found;
        },
      },

      {
        // The owner issues an invoice with the session: it is written in the
        // books and sent nowhere, and it is voided, not edited.
        method: 'POST',
        pattern: '/api/companies/:companyId/invoices',
        handle: async ({ params, body }) => withTenant(params.companyId!, (tx) => issueInvoice(tx, params.companyId!, body, 'owner')),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/invoices/:invoiceId/payments',
        handle: async ({ params, body }) => withTenant(params.companyId!, (tx) => payInvoice(tx, params.companyId!, params.invoiceId!, body, 'owner')),
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/invoices/:invoiceId/void',
        handle: async ({ params }) => withTenant(params.companyId!, (tx) => voidInvoice(tx, params.companyId!, params.invoiceId!, 'owner')),
      },

      /* ------------------------------------------------------- 0118 --- */

      {
        // The people the company deals with (0118): the latest touched first,
        // the archived last; with `?q=`, those whose name, organisation,
        // address or number has the words.
        method: 'GET',
        pattern: '/api/companies/:companyId/contacts',
        handle: async ({ params, query }) => ({
          contacts: await listContacts(params.companyId!, (query.get('q') ?? '').slice(0, 200)),
        }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/contacts/:contactId',
        handle: async ({ params }) => {
          const found = await withTenant(params.companyId!, (tx) => contactWith(tx, params.contactId!));
          if (!found) throw new PalugadaError('contract.violation', 'no such contact in this company', { contactId: params.contactId });
          return found;
        },
      },

      {
        // The owner's own records: kept, changed and archived with the
        // session, as a document is. They grant and spend nothing.
        method: 'POST',
        pattern: '/api/companies/:companyId/contacts',
        handle: async ({ params, body }) => {
          const fields = contactFields({ name: body.name, ...pick(body, ['organisation', 'email', 'phone']) });
          return { contactId: await withTenant(params.companyId!, (tx) => addContact(tx, params.companyId!, fields, 'owner')) };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/contacts/:contactId',
        handle: async ({ params, body }) => {
          const fields = contactFields(pick(body, ['name', 'organisation', 'email', 'phone']));
          if (body.archived !== undefined && typeof body.archived !== 'boolean') {
            throw new PalugadaError('contract.violation', 'archived is true or false', { field: 'archived' });
          }
          await withTenant(params.companyId!, async (tx) => {
            await changeContact(tx, params.companyId!, params.contactId!, fields, 'owner');
            if (typeof body.archived === 'boolean') await archiveContact(tx, params.companyId!, params.contactId!, body.archived);
          });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/contacts/:contactId/notes',
        handle: async ({ params, body }) => ({
          noteId: await withTenant(params.companyId!, (tx) =>
            noteContact(tx, params.companyId!, params.contactId!, requireText(body.body, 'body'), 'owner')),
        }),
      },

      {
        // A deal opened with a contact, or one of theirs moved on.
        method: 'POST',
        pattern: '/api/companies/:companyId/contacts/:contactId/deals',
        handle: async ({ params, body }) => {
          const deal = dealInput(pick(body, ['id', 'title', 'stage', 'value', 'expectedOn']));
          return { dealId: await withTenant(params.companyId!, (tx) => recordDeal(tx, params.companyId!, params.contactId!, deal, 'owner')) };
        },
      },

      {
        // The company's conversations with customers, the latest first; with
        // `?task=`, the one a piece of work answers, which a card asking for
        // a reply shows beside the reply.
        method: 'GET',
        pattern: '/api/companies/:companyId/chats',
        handle: async ({ params, query }) => {
          const task = query.get('task');
          return { chats: await chatsOf(params.companyId!, task ? { taskId: task } : {}) };
        },
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/chats/:chatId',
        handle: async ({ params }) => {
          const found = await withTenant(params.companyId!, (tx) => chatWith(tx, params.chatId!));
          if (!found) throw new PalugadaError('contract.violation', 'no such conversation in this company', { chatId: params.chatId });
          return found;
        },
      },

      {
        // The company's browser as the owner sees it: whether this
        // deployment has one, whether they hold it, and each tab -- whose
        // work it is and where it is. The tabs of this process: with more
        // than one replica, of the one this request reached.
        method: 'GET',
        pattern: '/api/companies/:companyId/browser',
        handle: async ({ params }) => {
          const companyId = params.companyId!;
          const held = await holdOf(companyId);
          const browsers = this.#options.browsers;
          if (!browsers) return { available: false, held, tabs: [] };
          const tabs = await browsers.tabs(companyId);
          const ids = tabs.map((tab) => tab.taskId).filter((id): id is string => id !== null);
          const work = new Map(ids.length === 0 ? [] : (await withTenant(companyId, (tx) => tx.query<{ id: string; input: unknown }>(
            'SELECT id, input FROM tasks WHERE id = ANY($1::uuid[])', [ids]))).rows.map((row) => [row.id, summarise(row.input)]));
          return { available: true, held, tabs: tabs.map((tab) => ({ ...tab, work: tab.taskId ? work.get(tab.taskId) ?? null : null })) };
        },
      },

      {
        // A tab's picture as it is now, which the console asks for again
        // every second or so while the owner looks.
        method: 'GET',
        pattern: '/api/companies/:companyId/browser/tabs/:tabId',
        handle: async ({ params }) => {
          const screen = await this.#browsers().screen(params.companyId!, params.tabId!);
          return { ...screen, image: `data:image/jpeg;base64,${screen.image}` };
        },
      },

      {
        // With the device: a signed-in browser is the company's accounts,
        // and while the owner holds it the company's work waits.
        method: 'POST',
        pattern: '/api/companies/:companyId/browser/take-over',
        handle: async ({ params, body }) => {
          this.#browsers();
          await this.#requireFactor(body.proof, 'take the company\'s browser over', params.companyId!);
          return { held: await takeOver(params.companyId!) };
        },
      },

      {
        // A page opened by the owner, in a work's tab or their own, under
        // the rules any page is held to. Only while they hold the browser.
        method: 'POST',
        pattern: '/api/companies/:companyId/browser/open',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          const browsers = this.#browsers();
          await touchHold(companyId);
          const tabId = typeof body.tabId === 'string' && body.tabId ? body.tabId : undefined;
          return browsers.open(companyId, requireText(body.url, 'url'), tabId);
        },
      },

      {
        // Where the owner pressed, scrolled or typed on the tab's picture.
        // What they type goes to the page and nowhere else: not an event,
        // not a log.
        method: 'POST',
        pattern: '/api/companies/:companyId/browser/tabs/:tabId/input',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          const browsers = this.#browsers();
          await touchHold(companyId);
          await browsers.input(companyId, params.tabId!, body as unknown as OwnerInput);
          return { done: true };
        },
      },

      {
        // Given back: what the owner signed in to is sealed for the
        // company's work, and every role that asked for it goes on.
        method: 'POST',
        pattern: '/api/companies/:companyId/browser/give-back',
        handle: async ({ params }) => {
          const companyId = params.companyId!;
          await this.#options.browsers?.ownerDone(companyId);
          await giveBack(companyId);
          const { rows: asked } = await withTenant(companyId, (tx) => tx.query<{ id: string }>(
            `SELECT id FROM inbox_items
              WHERE kind = 'escalation' AND status = 'open' AND payload->>'askedBy' = 'agent' AND payload->>'browser' = 'true'
              ORDER BY created_at`));
          for (const item of asked) {
            await inbox.answerEscalation(companyId, item.id,
              'The owner gave the browser back. Read the page again: it is where they left it.', { channel: 'app' });
          }
          return { answered: asked.length };
        },
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
          await this.#requireFactor(body.proof, 'let one role start work for another', params.companyId!, WITHIN_THE_WINDOW);
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

      /* ---------------------------------------------------- tickets (0070) --- */

      {
        // The company's backlog: open and in-progress first, then the
        // recently finished, with who filed each and what is working it.
        method: 'GET',
        pattern: '/api/companies/:companyId/tickets',
        handle: async ({ params, query }) => {
          const wanted = query.get('status') ?? 'active';
          const status = wanted === 'all' || wanted === 'active' || (TICKET_STATUSES as readonly string[]).includes(wanted)
            ? wanted as 'active' : 'active';
          return { tickets: await withTenant(params.companyId!, (tx) => listTickets(tx, { status, limit: 200 })) };
        },
      },

      {
        // The owner files something that needs doing. No device: a ticket
        // starts nothing until somebody is given it.
        method: 'POST',
        pattern: '/api/companies/:companyId/tickets',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => {
          const project = typeof body.projectId === 'string' && body.projectId
            ? body.projectId
            : (await tx.query<{ id: string }>('SELECT id FROM projects ORDER BY created_at LIMIT 1')).rows[0]?.id;
          if (!project) throw new PalugadaError('contract.violation', 'the company has no project to file it in', { field: 'projectId' });
          const opened = await openTicket(tx, {
            companyId: params.companyId!,
            projectId: project,
            divisionId: typeof body.divisionId === 'string' && body.divisionId ? body.divisionId : null,
            title: requireText(body.title, 'title'),
            body: typeof body.body === 'string' ? body.body : '',
            ...(body.priority === undefined ? {} : { priority: Number(body.priority) }),
            openedBy: 'owner',
          });
          return { ticketId: opened.ticket.id, existing: opened.existing };
        }),
      },

      {
        // Closing a ticket nobody should do, or opening one again.
        method: 'POST',
        pattern: '/api/companies/:companyId/tickets/:ticketId',
        handle: async ({ params, body }) => withTenant(params.companyId!, async (tx) => ({
          ticket: await setTicketStatus(tx, params.companyId!, params.ticketId!, {
            status: oneOf(body.status, ['open', 'closed'] as const, 'status'),
            reason: typeof body.reason === 'string' ? body.reason : null,
            ...(body.priority === undefined ? {} : { priority: Number(body.priority) }),
          }),
        })),
      },

      {
        // Giving a ticket to a role: it becomes that role's task, and the
        // ticket closes when the task finishes. Checked open before the task
        // is made, so a ticket already taken starts nothing.
        method: 'POST',
        pattern: '/api/companies/:companyId/tickets/:ticketId/assign',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          const ticket = await withTenant(companyId, (tx) => readTicket(tx, params.ticketId!));
          if (!ticket) throw new PalugadaError('contract.violation', 'no such ticket in this company', { field: 'ticketId' });
          if (ticket.status !== 'open') {
            throw new PalugadaError('contract.violation', `ticket "${ticket.title}" is ${ticket.status.replace('_', ' ')}`, { field: 'ticketId' });
          }
          const roleId = requireText(body.roleId, 'roleId');
          const role = await withTenant(companyId, (tx) =>
            tx.query<{ division_id: string }>('SELECT division_id FROM roles WHERE id = $1', [roleId]));
          if (!role.rows[0]) throw new PalugadaError('contract.violation', 'no such role in this company', { field: 'roleId' });
          const assigned = await assignTask({
            companyId,
            projectId: ticket.projectId,
            divisionId: role.rows[0].division_id,
            roleId,
            goalId: requireText(body.goalId, 'goalId'),
            input: { goal: ticket.title, ...(ticket.body ? { context: ticket.body } : {}), ticketId: ticket.id },
            createdBy: 'owner',
            idempotencyKey: `ticket:${ticket.id}:${ticket.updatedAt.toISOString()}`,
            // A ticket a run filed may hold a customer's words, which is why
            // `ticket.list` reads as outside content (F8.9); handed out by the
            // owner, they are still not the owner's words.
            ...(ticket.openedBy === 'agent'
              ? { carriesOutside: { capability: 'the ticket it was given', ticketId: ticket.id } }
              : {}),
            detail: `the owner gave it ticket ${ticket.id}`,
          });
          await withTenant(companyId, (tx) => startTicket(tx, companyId, ticket.id, assigned.task.id));
          return { taskId: assigned.task.id };
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
          const chain = await chainFor(tx, accountId);
          // The chain by name, for the owner, in the same order (§2.3 item 7):
          // it was shown as each account's id cut to eight characters.
          const { rows: named } = await tx.query<{ id: string; name: string | null }>(
            `SELECT a.id, ${ACCOUNT_NAME} AS name FROM budget_accounts a WHERE a.id = ANY($1::uuid[])`, [chain]);
          const names = new Map(named.map((row) => [row.id, row.name]));
          return {
            accountId,
            chain,
            chainNames: chain.map((id) => names.get(id) ?? null),
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

      {
        // An account's ceilings, changed. Raising either loosens a control
        // and takes the owner's factor, as the spend ceiling does; lowering is
        // the session's. The factor is asked for only once the account is
        // known to be this company's, so a wrong id does not spend a code.
        method: 'POST',
        pattern: '/api/companies/:companyId/budget-accounts/:accountId/limit',
        handle: async ({ params, body }) => {
          const tokensMax = wholeNumber(body.tokensMax, 'tokensMax');
          const moneyMaxCents = body.moneyMaxCents === undefined ? undefined : wholeNumber(body.moneyMaxCents, 'moneyMaxCents');
          await setCeilings(
            params.companyId!, params.accountId!,
            { tokensMax, ...(moneyMaxCents === undefined ? {} : { moneyMaxCents }) },
            async (before) => {
              if (tokensMax > before.tokensMax || (moneyMaxCents ?? 0) > before.moneyMaxCents) {
                await this.#requireFactor(body.proof, 'raise a budget account\'s ceiling', params.companyId!);
              }
            },
          );
          return { ok: true };
        },
      },

      {
        // Goes on with everything an account's budget stopped, oldest first, for
        // as many as it can fund (STATUS 2.155). With `tokensMax` it raises the
        // account's ceiling first -- which asks for the owner's code, as raising
        // one always does -- and without it the account must already have room.
        method: 'POST',
        pattern: '/api/companies/:companyId/budget-accounts/:accountId/continue',
        handle: async ({ params, body }) => {
          if (body.tokensMax !== undefined && body.tokensMax !== null) {
            const tokensMax = wholeNumber(body.tokensMax, 'tokensMax');
            await setCeilings(params.companyId!, params.accountId!, { tokensMax }, async (before) => {
              if (tokensMax > before.tokensMax) {
                await this.#requireFactor(body.proof, 'raise a budget account\'s ceiling', params.companyId!);
              }
            });
          }
          const done = await continueAllHalted(params.companyId!, params.accountId!);
          const { rows } = await withControlPlane((tx) => tx.query<{ tokens_max: string }>(
            'SELECT tokens_max FROM budget_accounts WHERE id = $1', [params.accountId]));
          return { ...done, tokensMax: Number(rows[0]!.tokens_max) };
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
        // Putting a measure right, or retiring it (0069). A target is what
        // every run on the goal aims at, so moving it -- either way -- takes
        // the owner's device, like changing the goal it measures.
        method: 'POST',
        pattern: '/api/companies/:companyId/metrics/:metricId',
        handle: async ({ params, body }) => {
          const change: MetricChange = {};
          if (body.name !== undefined) change.name = requireText(body.name, 'name');
          if (body.unit !== undefined) change.unit = requireText(body.unit, 'unit') as MetricUnit;
          if (body.direction !== undefined) change.direction = oneOf(body.direction, ['up', 'down'] as const, 'direction');
          if (body.baseline !== undefined) change.baseline = Number(body.baseline);
          if (body.target !== undefined) change.target = Number(body.target);
          if (body.dueOn !== undefined) change.dueOn = typeof body.dueOn === 'string' && body.dueOn ? body.dueOn : null;
          if (body.sourceCapability !== undefined) {
            change.sourceCapability = typeof body.sourceCapability === 'string' && body.sourceCapability ? body.sourceCapability : null;
          }
          if (body.retired !== undefined) change.retired = body.retired === true;
          if (Object.keys(change).length === 0) throw new PalugadaError('contract.violation', 'no measure field was given', {});
          await this.#requireFactor(body.proof, 'change a measure', params.companyId!, WITHIN_THE_WINDOW);
          await changeMetric(params.companyId!, params.metricId!, change);
          return { ok: true };
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
        // Taking back something the company should not believe at all
        // (0071): it leaves every run's context and stays in the record,
        // rejected. A fact that is wrong in its detail is corrected instead.
        method: 'POST',
        pattern: '/api/companies/:companyId/memories/:memoryId/retract',
        handle: async ({ params }) => withTenant(params.companyId!, async (tx) => {
          if (!await retract(tx, params.memoryId!)) {
            throw new PalugadaError('contract.violation', 'no such memory in use: it was already taken back, replaced, or never active', {});
          }
          await appendEvent(tx, {
            companyId: params.companyId!, type: 'memory.retracted', actor: 'owner', payload: { memoryId: params.memoryId },
          });
          return { ok: true };
        }),
      },

      {
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
        // A division's keys for services: which it holds, where each lives,
        // and which its granted capabilities ask for that it does not hold.
        // Never a value -- a key pasted here is not shown again.
        method: 'GET',
        pattern: '/api/companies/:companyId/divisions/:divisionId/credentials',
        handle: async ({ params, request }) => {
          const companyId = params.companyId!;
          const divisionId = params.divisionId!;
          const { held, granted } = await withControlPlane(async (tx) => {
            await assertDivisionOf(tx, companyId, divisionId);
            const held = await tx.query<{ alias: string; version: number; secret_ref: string; scopes: string[]; rotated_at: Date | null; created_at: Date }>(
              `SELECT alias, version, secret_ref, scopes, rotated_at, created_at FROM credentials
                WHERE company_id = $1 AND division_id = $2 ORDER BY alias`,
              [companyId, divisionId],
            );
            const granted = await tx.query<{ capability_name: string }>(
              `SELECT capability_name FROM capability_grants
                WHERE company_id = $1 AND division_id = $2 ORDER BY capability_name`,
              [companyId, divisionId],
            );
            return { held: held.rows, granted: granted.rows };
          });
          const have = new Set(held.map((row) => row.alias));
          const asked = keysAskedFor(this.#options.registry, granted.map((row) => row.capability_name));
          // How a key is signed in for, when it is: the provider, where its app
          // is registered, and whether this deployment has registered one.
          const signIns = new Map<string, { provider: string; name: string; clientUrl: string | null; client: boolean }>();
          for (const [alias, need] of asked) {
            if (need.signIn) {
              signIns.set(alias, {
                provider: need.signIn.provider, name: need.signIn.name, clientUrl: need.signIn.clientUrl,
                client: await hasClient(need.signIn.provider),
              });
            }
          }
          let callback: string | null = null;
          try {
            callback = this.#callbackAddress(request);
          } catch {
            callback = null;
          }
          return {
            credentials: held.map((row) => ({
              alias: row.alias,
              version: row.version,
              stored: storedAt(row.secret_ref),
              signedIn: row.secret_ref.startsWith(`db://${OAUTH_CREDENTIALS}`),
              scopes: row.scopes,
              createdAt: row.created_at.toISOString(),
              rotatedAt: row.rotated_at?.toISOString() ?? null,
              ...(signIns.has(row.alias) ? { signIn: signIns.get(row.alias) } : {}),
              ...(asked.get(row.alias)?.form ? { form: asked.get(row.alias)!.form!.kind } : {}),
            })),
            needs: [...asked].filter(([alias]) => !have.has(alias)).map(([alias, need]) => ({
              alias, capabilities: need.capabilities, scopes: need.scopes,
              ...(signIns.has(alias) ? { signIn: signIns.get(alias) } : {}),
              ...(need.form ? { form: need.form.kind } : {}),
            })),
            callback,
          };
        },
      },

      {
        // A key pasted for a division, sealed in the deployment's store under
        // a name only a division's credential may use (`DivisionSecrets`).
        // Pasted again for the same alias it is a rotation (F12.3): the next
        // call signs in with it, and the key it replaced is deleted.
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions/:divisionId/credentials',
        handle: async ({ params, body }) => {
          const deployment = this.#deploymentSettings();
          const companyId = params.companyId!;
          const divisionId = params.divisionId!;
          const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
          if (!/^[a-z][a-z0-9_-]{0,39}$/.test(alias)) {
            throw new PalugadaError('contract.violation',
              'an alias is lower-case letters, digits, - and _, starting with a letter: the name the service asks for, such as email or crm',
              { field: 'alias' });
          }
          let value = typeof body.value === 'string' ? body.value.trim() : '';
          if (value.length < 8 || value.length > 8_192) {
            throw new PalugadaError('contract.violation', 'paste the whole key the service gave you', { field: 'value' });
          }
          // A sign-in's record, pasted, would choose where its refresh -- and
          // the registered app's secret -- is sent.
          if (value.startsWith('{"oauth2"')) {
            throw new PalugadaError('contract.violation', 'a key that is signed in for is made by signing in, not pasted', { field: 'value' });
          }
          const granted = await withControlPlane(async (tx) => {
            await assertDivisionOf(tx, companyId, divisionId);
            const { rows } = await tx.query<{ capability_name: string }>(
              'SELECT capability_name FROM capability_grants WHERE company_id = $1 AND division_id = $2', [companyId, divisionId]);
            return rows.map((row) => row.capability_name);
          });
          // A key asked for in a form -- a mailbox -- is held to its shape
          // before the device, and taken by its service before it is sealed.
          const form = keysAskedFor(this.#options.registry, granted).get(alias)?.form;
          if (form) value = form.parse(value);
          await this.#requireFactor(body.proof, `save the ${alias} key`, companyId);
          if (!deployment.master(true)) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          if (form) await form.check(value);
          return this.#keepDivisionKey({ companyId, divisionId, alias, value, prefix: CREDENTIAL_SECRETS });
        },
      },

      {
        // A division's key signed in for rather than pasted: the vendor entry
        // says with whom, the owner's device says yes here, and the page this
        // answers with is opened in the owner's browser. The key is kept when
        // the provider sends the browser back (`/api/oauth/callback`).
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions/:divisionId/credentials/:alias/oauth/start',
        handle: async ({ params, body, request }) => {
          const deployment = this.#deploymentSettings();
          const companyId = params.companyId!;
          const divisionId = params.divisionId!;
          const alias = params.alias!;
          await withControlPlane((tx) => assertDivisionOf(tx, companyId, divisionId));
          const signIn = this.#signInFor(alias, await this.#grantedTo(companyId, divisionId));
          if (!signIn) {
            throw new PalugadaError('contract.violation',
              `nothing this division may use signs in for the ${alias} key; paste the key instead`, { alias });
          }
          const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
          const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
          const redirectUri = this.#callbackAddress(request);
          // Asked before the device, so an owner with no app registered is told
          // what to register rather than asked for a code first.
          if (!clientId && !(await hasClient(signIn.provider))) {
            throw new PalugadaError('config.invalid',
              `${signIn.name} lets PALUGADA in only through an app you register with it: register one, `
                + `with ${redirectUri} as the address to come back to, and give its client ID and secret`,
              { provider: signIn.provider, redirectUri });
          }
          await this.#requireFactor(body.proof, `sign in to ${signIn.name} for the ${alias} key`, companyId);
          const master = deployment.master(true);
          if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
          return beginCredentialSignIn({
            companyId, divisionId, alias, signIn, redirectUri, master,
            client: clientId ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : null,
          });
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions/:divisionId/credentials/:alias/remove',
        handle: async ({ params, body }) => {
          const companyId = params.companyId!;
          const divisionId = params.divisionId!;
          const alias = params.alias!;
          const reference = await withControlPlane(async (tx) => {
            await assertDivisionOf(tx, companyId, divisionId);
            const { rows } = await tx.query<{ secret_ref: string }>(
              'SELECT secret_ref FROM credentials WHERE company_id = $1 AND division_id = $2 AND alias = $3',
              [companyId, divisionId, alias],
            );
            return rows[0]?.secret_ref ?? null;
          });
          if (!reference) {
            throw new PalugadaError('contract.violation', `this division holds no key named ${alias}`, { alias });
          }
          await this.#requireFactor(body.proof, `remove the ${alias} key`, companyId);
          await withControlPlane((tx) => tx.query(
            'DELETE FROM credentials WHERE company_id = $1 AND division_id = $2 AND alias = $3',
            [companyId, divisionId, alias],
          ));
          if (reference.startsWith(`db://${CREDENTIAL_SECRETS}`)) await deleteSecret(reference.slice('db://'.length));
          await withTenant(companyId, (tx) => appendEvent(tx, {
            companyId, type: 'credential.removed', actor: 'owner', payload: { alias, divisionId, secretRef: reference },
          }));
          return { ok: true };
        },
      },

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
        // The owner's answer to an escalation, without deciding it: told to
        // the task, which goes back to work if it was waiting on the owner.
        // A run's own question is decided by its answer (B6).
        method: 'POST',
        pattern: '/api/companies/:companyId/inbox/:itemId/answer',
        handle: async ({ params, body, staff }) => {
          await inbox.answerEscalation(params.companyId!, params.itemId!, String(body.answer ?? ''),
            { channel: 'app', seat: staff ? { id: staff.seat.id, name: staff.seat.name } : null });
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
        // device. `goal.propose` is the agent's path (`proposeGoalChange`) --
        // it files an item, and the owner's yes to it, with the same device,
        // is the change; this is the owner acting directly, which is why there
        // is nothing to wait for and why the factor is the whole check.
        method: 'POST',
        pattern: '/api/companies/:companyId/goals/:goalId',
        handle: async ({ params, body }) => {
          // Before the factor. A TOTP code is one-shot, so an empty edit would
          // spend the owner's code, write a `goal.changed` event, and change
          // nothing -- and the next real attempt would need a new code.
          if (body.statement === undefined && body.status === undefined) {
            throw new PalugadaError('contract.violation', 'no goal field was given', {});
          }
          await this.#requireFactor(body.proof, 'change a goal', params.companyId!, WITHIN_THE_WINDOW);
          const changed = await applyGoalChange({
            companyId: params.companyId!,
            goalId: params.goalId!,
            ...(body.statement === undefined ? {} : { statement: String(body.statement) }),
            ...(body.status === undefined
              ? {}
              : { status: oneOf(body.status, GOAL_STATUSES, 'status') }),
          });
          return { ok: true, paused: changed.paused };
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
          await this.#requireFactor(body.proof, 'change a grant', params.companyId!, WITHIN_THE_WINDOW);
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
              // F5.7: calls in flight at once. Left out keeps it; 0 or null lifts it.
              ...(body.maxInFlight === undefined ? {} : {
                maxInFlight: body.maxInFlight === null || body.maxInFlight === 0
                  ? null
                  : inFlightLimit(body.maxInFlight),
              }),
            }) as Extract<StructuralChange, { kind: 'change_grant' | 'revoke_grant' }>;
          await applyGrantChange(params.companyId!, change, { ownerApproved: true });
          return { ok: true };
        },
      },

      {
        // Hiring (F2.9: adding a role is tier 3, so it takes the owner's
        // device). The role is complete enough to be given work at once, and
        // the answer names any tool its division cannot use yet. With
        // `grantTools` the hire also grants the division the tools it lacks,
        // except what cannot be undone (tier 3): `granted` says which.
        method: 'POST',
        pattern: '/api/companies/:companyId/roles',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'hire a role', params.companyId!, WITHIN_THE_WINDOW);
          return addRole(params.companyId!, {
            divisionId: requireText(body.divisionId, 'divisionId'),
            slug: requireText(body.slug, 'slug'),
            systemPrompt: requireText(body.systemPrompt, 'systemPrompt'),
            tools: body.tools === undefined ? [] : textList(body.tools, 'tools'),
            doneCriteria: body.doneCriteria === undefined ? [] : textList(body.doneCriteria, 'doneCriteria'),
            ...(body.model === undefined ? {} : { model: requireText(body.model, 'model') }),
            ...whoFrom(body),
          }, { ownerApproved: true, grantTools: body.grantTools === true });
        },
      },

      {
        // A new division is tier 3 as well (F2.9).
        method: 'POST',
        pattern: '/api/companies/:companyId/divisions',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'open a division', params.companyId!, WITHIN_THE_WINDOW);
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
        // Its work language (0100) is optional: left out or null, the
        // company's.
        method: 'POST',
        pattern: '/api/companies/:companyId/projects',
        handle: async ({ params, body }) => ({
          projectId: await addProject(params.companyId!, {
            slug: requireText(body.slug, 'slug'), name: requireText(body.name, 'name'),
            workLanguage: projectWorkLanguage(body.workLanguage) ?? null,
          }),
        }),
      },

      /* ------------------------------------------------------- 0075 --- */

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/documents',
        handle: async ({ params }) => ({ documents: await listDocuments(params.companyId!) }),
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/documents/:documentId',
        handle: async ({ params }) => {
          const found = await readDocument(params.companyId!, params.documentId!);
          if (!found) throw new PalugadaError('contract.violation', 'no such document in this company', {});
          return found;
        },
      },

      {
        // The owner gives the company a document, as text: the console reads
        // a text or Markdown file in the browser and sends what it says. It
        // grants and spends nothing, so the session is enough.
        method: 'POST',
        pattern: '/api/companies/:companyId/documents',
        handle: async ({ params, body }) => addDocument(params.companyId!, {
          title: requireText(body.title, 'title'),
          body: requireText(body.text, 'text'),
          ...(body.divisionId ? { divisionId: requireText(body.divisionId, 'divisionId') } : {}),
          ...(typeof body.fileName === 'string' ? { fileName: body.fileName } : {}),
        }),
      },

      {
        // Which documents customers may be told (0117): a channel that
        // answers on its own answers only from these. The session is enough:
        // what a marked document lets go alone, the session could already
        // approve card by card, and the channel's switch is the device's.
        method: 'POST',
        pattern: '/api/companies/:companyId/documents/:documentId/for-customers',
        handle: async ({ params, body }) => {
          if (typeof body.on !== 'boolean') throw new PalugadaError('contract.violation', 'on is true or false', { field: 'on' });
          await setForCustomers(params.companyId!, params.documentId!, body.on);
          return { forCustomers: body.on };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/documents/:documentId/archive',
        handle: async ({ params, body }) => {
          if (typeof body.archived !== 'boolean') {
            throw new PalugadaError('contract.violation', 'archived is true or false', { field: 'archived' });
          }
          await archiveDocument(params.companyId!, params.documentId!, body.archived);
          return { ok: true };
        },
      },

      {
        // Renaming, describing or closing a project (0074), or giving it a
        // work language of its own (0100). It grants nothing and spends
        // nothing, so the session is enough -- like starting one, and like
        // the company's own languages.
        method: 'POST',
        pattern: '/api/companies/:companyId/projects/:projectId',
        handle: async ({ params, body }) => {
          if (body.archived !== undefined && typeof body.archived !== 'boolean') {
            throw new PalugadaError('contract.violation', 'archived is true or false', { field: 'archived' });
          }
          const workLanguage = projectWorkLanguage(body.workLanguage);
          await changeProject(params.companyId!, params.projectId!, {
            ...(body.name === undefined ? {} : { name: String(body.name) }),
            ...(body.description === undefined ? {} : { description: body.description === null ? null : String(body.description) }),
            ...(body.archived === undefined ? {} : { archived: body.archived as boolean }),
            ...(workLanguage === undefined ? {} : { workLanguage }),
          });
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/roles/:roleId',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'change a role', params.companyId!, WITHIN_THE_WINDOW);
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
          if (body.doneCriteria !== undefined) {
            // A list, one criterion each; blank lines are dropped and the
            // rest bounded where the change is made (governance/structure.ts).
            if (!Array.isArray(body.doneCriteria)) {
              throw new PalugadaError('contract.violation', 'doneCriteria must be an array: one criterion each', { field: 'doneCriteria' });
            }
            // Checked for text rather than cast: `String(null)` is a criterion
            // reading "null" that no run could ever meet.
            fields.doneCriteria = body.doneCriteria.map((line, index) => {
              if (typeof line !== 'string') {
                throw new PalugadaError('contract.violation', `doneCriteria[${index}] must be text`, { field: 'doneCriteria' });
              }
              return line;
            });
          }
          if (body.maxRunMinutes !== undefined) {
            // 0084. In minutes from the console; none, or 0, is no limit
            // beyond the task's own deadline.
            const minutes = body.maxRunMinutes === null ? 0 : Number(body.maxRunMinutes);
            if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1_440) {
              throw new PalugadaError('contract.violation',
                `maxRunMinutes is ${String(body.maxRunMinutes)}; it is a whole number of minutes from 1 to 1440, or 0 for no limit`,
                { field: 'maxRunMinutes' });
            }
            fields.maxRunSeconds = minutes === 0 ? null : minutes * 60;
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
          Object.assign(fields, whoFrom(body));
          if (Object.keys(fields).length === 0) {
            throw new PalugadaError('contract.violation', 'no role field was given', {});
          }
          const version = await applyRoleChange(params.companyId!, params.roleId!, fields, {
            ownerApproved: true,
            ...(body.summary === undefined ? {} : { summary: String(body.summary) }),
          });
          // With `grantTools`, a change to the role's tools also grants its
          // division the ones it lacks -- except what cannot be undone.
          const granting = body.grantTools === true && fields.tools !== undefined
            ? await grantRoleTools(params.companyId!, params.roleId!, { ownerApproved: true })
            : null;
          return { version, ...(granting ?? {}) };
        },
      },

      {
        // The CEO is who the owner talks to, so moving it is the owner's
        // decision with their device, and it moves in one transaction: the
        // database holds a company to exactly one (governance/ceo.ts).
        method: 'POST',
        pattern: '/api/companies/:companyId/ceo',
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'appoint a CEO', params.companyId!, WITHIN_THE_WINDOW);
          return appointCeo(params.companyId!, requireText(body.roleId, 'roleId'), {
            ownerApproved: true,
            ...(body.summary === undefined ? {} : { summary: String(body.summary) }),
          });
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

      /* ----------------------------------------------------------- F3.1 --- */

      {
        // The charters every run of the company is told first: its own, and
        // the platform's above it (F3.1, F3.2). Read together, because the
        // company's is read under the platform's and the owner changing one
        // should see the other.
        method: 'GET',
        pattern: '/api/companies/:companyId/charter',
        handle: async ({ params }) => withTenant(params.companyId!, async (tx) => {
          const { rows } = await tx.query<{ company_id: string | null; version: number; body: string; created_at: Date }>(
            `SELECT DISTINCT ON (company_id) company_id, version, body, created_at
               FROM charters
              WHERE company_id IS NULL OR company_id = $1
              ORDER BY company_id NULLS FIRST, version DESC`,
            [params.companyId],
          );
          const shaped = (row: (typeof rows)[number] | undefined) =>
            row ? { version: row.version, body: row.body, createdAt: row.created_at.toISOString() } : null;
          return {
            company: shaped(rows.find((row) => row.company_id !== null)),
            platform: shaped(rows.find((row) => row.company_id === null)),
          };
        }),
      },

      {
        // F3.6: the owner's to write. Behind the factor, because it is the
        // first thing every run of the company obeys, and a session alone
        // could otherwise rewrite what every agent is told to do.
        method: 'POST',
        pattern: '/api/companies/:companyId/charter',
        handle: async ({ params, body }) => this.#writeCharter(params.companyId!, body),
      },

      {
        // The platform's, which every company's runs are told above their
        // own (F3.1). The same write, for the whole deployment.
        method: 'POST',
        pattern: '/api/control/charter',
        handle: async ({ body }) => this.#writeCharter(null, body),
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
          const restored = await rollBack(
            params.companyId!, kind, typeof body.subjectId === 'string' ? body.subjectId : null, version,
          );
          if (kind === 'charter') await this.#options.charters?.sync().catch(() => undefined);
          return restored;
        },
      },

      /* ------------------------------------------------------------ F15 --- */

      {
        // Every skill at every stage, for the owner; a run's pack still
        // carries only what is active and visible to its division.
        method: 'GET',
        pattern: '/api/companies/:companyId/skills',
        handle: async ({ params, query }) => {
          const division = query.get('division');
          return {
            skills: await skillsOf(params.companyId!, division && /^[0-9a-f-]{36}$/.test(division) ? { divisionId: division } : {}),
          };
        },
      },

      {
        method: 'GET',
        pattern: '/api/companies/:companyId/skills/:skillId',
        handle: async ({ params }) => {
          const found = await skillOf(params.companyId!, params.skillId!);
          if (!found) throw new PalugadaError('skill.unknown', `no skill ${params.skillId} in this company`, {});
          return found;
        },
      },

      {
        // The owner writes a skill, or a new version of one: a candidate like
        // any other, screened against its checks and read by a reviewer
        // before it comes back to the owner to switch on (F15.3). The checks
        // it is to be held to can come with it, since without one it can
        // never be activated (F15.4).
        method: 'POST',
        pattern: '/api/companies/:companyId/skills',
        handle: async ({ params, body }) => {
          const slug = requireText(body.slug, 'slug').trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
            throw new PalugadaError('contract.violation',
              'a skill\'s short name is 2 to 63 lowercase letters, digits and dashes, such as refund-policy', { field: 'slug' });
          }
          const scopeType = oneOf(body.scopeType ?? 'division', SKILL_SCOPES, 'scopeType');
          const source = requireText(body.source, 'source');
          if (source.length > 20_000) {
            throw new PalugadaError('contract.violation', 'a skill is at most 20000 characters', { field: 'source' });
          }
          const checks = Array.isArray(body.checks) ? body.checks.map(checkFrom) : [];
          const proposed = await proposeSkillVersion({
            companyId: params.companyId!,
            slug,
            scopeType,
            ...(scopeType === 'division' ? { scopeId: requireText(body.divisionId, 'divisionId') } : {}),
            source,
            author: 'owner',
            changelog: typeof body.changelog === 'string' && body.changelog.trim() ? body.changelog.trim() : 'Written by the owner.',
          });
          for (const check of checks) await addEvalCase(params.companyId!, proposed.skillId, check);
          return proposed;
        },
      },

      {
        // F15.4: what the skill must still say, checked against every version.
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/:skillId/checks',
        handle: async ({ params, body }) => {
          const found = await skillOf(params.companyId!, params.skillId!);
          if (!found) throw new PalugadaError('skill.unknown', `no skill ${params.skillId} in this company`, {});
          return { checkId: await addEvalCase(params.companyId!, params.skillId!, checkFrom(body)) };
        },
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
          // The owner may turn a candidate down at any stage. Approving as the
          // reviewer is not theirs: F15.3's first gate is another role's
          // reading, and an owner who marks it read is the review F7 exists
          // to avoid. Their yes is the second gate, which comes after.
          if (body.approved) {
            throw new PalugadaError('review.required',
              'a skill is reviewed by one of the company\'s roles, not by the owner; approve it once the reviewer has, from the inbox or the Skills page',
              { versionId: params.versionId });
          }
          await rejectSkillVersion(params.companyId!, params.versionId!,
            typeof body.reason === 'string' ? body.reason : '');
          return { ok: true };
        },
      },

      {
        method: 'POST',
        pattern: '/api/companies/:companyId/skills/versions/:versionId/approve',
        // Activating a skill puts its text in front of every agent it reaches,
        // which is the one thing a skill's review exists to control.
        handle: async ({ params, body }) => {
          await this.#requireFactor(body.proof, 'activate a skill', params.companyId!, WITHIN_THE_WINDOW);
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
          await this.#requireFactor(body.proof, 'change a skill\'s scope', params.companyId!, WITHIN_THE_WINDOW);
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
          await this.#requireFactor(body.proof, 'install a bundle', params.companyId!, WITHIN_THE_WINDOW);
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
            // "New schedule", not an edit: a name in use is refused (N11).
            ...(body.create === true ? { create: true } : {}),
            ...(body.priority === undefined ? {} : { priority: wholeNumber(body.priority, 'priority') }),
            // F9.1. Checked here for its shape; the range, and why it has a
            // floor, is the scheduler's to say (`assertScheduleTiming`). Null
            // is a choice -- always run a missed occurrence once -- rather
            // than an absence, so it is passed on as one.
            ...(body.overlap === undefined ? {} : { overlap: oneOf(body.overlap, OVERLAP_POLICIES, 'overlap') }),
            ...(body.catchUpMinutes === undefined ? {} : {
              catchUpMinutes: body.catchUpMinutes === null ? null : wholeNumber(body.catchUpMinutes, 'catchUpMinutes'),
            }),
          }),
        }),
      },

      {
        // F9.1: one run of a schedule, now, so the owner can see what it does
        // without waiting a week for its next occurrence. The task an
        // occurrence would make, made by the owner; the schedule's next run
        // does not move. A schedule that is off may be run, to try it before
        // turning it on, and stays off. Refused with 409 while a task the
        // schedule made is still live, naming it, and for a frozen company or
        // a closed goal as any new work is. The session suffices, as it does
        // for giving work: the task draws on the schedule's own budget
        // account under the grants its role already has.
        method: 'POST',
        pattern: '/api/companies/:companyId/schedules/:scheduleId/run',
        handle: async ({ params }) => ({ task: await runScheduleNow(params.companyId!, params.scheduleId!) }),
      },

      {
        // N11: off and on again. The session suffices, as saving one does: on,
        // it draws on its own account under its role's grants, and its next
        // run is its next time, not the ones it was off for.
        method: 'POST',
        pattern: '/api/companies/:companyId/schedules/:scheduleId/enabled',
        handle: async ({ params, body }) => {
          if (typeof body.enabled !== 'boolean') {
            throw new PalugadaError('contract.violation', 'enabled must be true or false', { field: 'enabled' });
          }
          await setScheduleEnabled(params.companyId!, params.scheduleId!, body.enabled);
          return { ok: true };
        },
      },

      {
        // N11: a schedule removed. The work it made stays.
        method: 'POST',
        pattern: '/api/companies/:companyId/schedules/:scheduleId/remove',
        handle: async ({ params }) => {
          await removeSchedule(params.companyId!, params.scheduleId!);
          return { ok: true };
        },
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
          authenticators: await Promise.all((await this.#options.mfa.enrolled()).map(async (factor) => ({
            id: factor.id,
            kind: factor.kind,
            label: factor.label,
            // How many recovery codes are left; never the codes.
            ...(factor.kind === 'recovery' ? { left: await this.#options.mfa.recoveryCodesLeft() ?? 0 } : {}),
          }))),
          passkeys: this.#options.mfa.relyingParty,
        }),
      },

      {
        // Ten codes to write down, for the day the phone is gone. Shown once;
        // the old set stops working. With a device, or with a code, since
        // an owner who used some should be able to make a fresh set.
        method: 'POST',
        pattern: '/api/mfa/recovery-codes',
        handle: async ({ body }) => {
          await this.#requireFactor(body.proof, 'make new recovery codes');
          return { codes: await this.#options.mfa.issueRecoveryCodes() };
        },
      },

      {
        method: 'GET',
        pattern: '/api/mfa/challenge',
        handle: async () => ({ challenge: this.#options.mfa.challenge(), ...this.#options.mfa.relyingParty }),
      },

      {
        method: 'GET',
        pattern: '/api/mfa/passkeys/options',
        handle: async () => this.#options.mfa.passkeyOptions(),
      },

      {
        // A passkey made on this device, added to the owner's factors. The
        // body is checked before the factor is, so a malformed request does
        // not spend the owner's code on nothing.
        method: 'POST',
        pattern: '/api/mfa/passkeys',
        handle: async ({ body }) => {
          const credential = (body.credential ?? {}) as Record<string, unknown>;
          const made = {
            label: requireText(body.label, 'label'),
            id: requireText(credential.id, 'credential.id'),
            clientDataJSON: requireText(credential.clientDataJSON, 'credential.clientDataJSON'),
            attestationObject: requireText(credential.attestationObject, 'credential.attestationObject'),
          };
          await this.#requireFactor(body.proof, 'add a passkey');
          return this.#options.mfa.enrolPasskey(made);
        },
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
    // Naming nothing checks what is saved, as it is: how the assistant asks.
    const saved = stored.model as ModelSetting | undefined;
    const candidate = body.provider === undefined && saved ? saved : modelSettingFrom(body, saved);
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
  /** Where Meta's Graph API is reached: its own address unless a test or a proxy names another. */
  #whatsappApi(): { apiBase?: string } {
    const base = this.#deploymentSettings().baseEnv.PALUGADA_WHATSAPP_API;
    return base ? { apiBase: base } : {};
  }

  /**
   * Lets the role that answers a channel read a chat and answer it: the two
   * grants on its division and the two tools on the role, each recorded as a
   * structural change the owner made (F2.9, F3.9) -- with the device the
   * channel was connected with. What it has already is left as it is.
   */
  async #answerCustomers(
    companyId: string, divisionId: string, roleId: string, channel: string, wanted: readonly string[] = ['chat.read', 'chat.send'],
  ): Promise<void> {
    const { granted, tools } = await withTenant(companyId, async (tx) => ({
      granted: (await tx.query<{ capability_name: string }>(
        'SELECT capability_name FROM capability_grants WHERE division_id = $1 AND capability_name = ANY($2::text[])',
        [divisionId, [...wanted]])).rows.map((row) => row.capability_name),
      tools: (await tx.query<{ tools: string[] }>('SELECT tools FROM roles WHERE id = $1', [roleId])).rows[0]?.tools ?? [],
    }));
    for (const capabilityName of wanted.filter((name) => !granted.includes(name))) {
      await applyGrantChange(companyId, { kind: 'change_grant', divisionId, capabilityName, tierOverride: null }, { ownerApproved: true });
    }
    const missing = wanted.filter((name) => !tools.includes(name));
    if (missing.length > 0) {
      await applyRoleChange(companyId, roleId, { tools: [...tools, ...missing] }, {
        ownerApproved: true, summary: `Before it answered customers on ${channel}`,
      });
    }
  }

  /**
   * A WhatsApp Business number of the company's own (0112). Meta's webhook
   * is set in the Meta app by the owner, not by an API call, so the answer
   * is the callback address and a verify token -- shown once, kept only as
   * its hash -- to paste there. Refused without a public address, before
   * anything is kept: Meta has nowhere to deliver to.
   */
  async #connectWhatsApp(companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deployment = this.#deploymentSettings();
    const publicUrl = deployment.baseEnv.PALUGADA_APP_URL_PUBLIC;
    if (!publicUrl) {
      throw new PalugadaError('contract.violation',
        'WhatsApp delivers to this deployment\'s public address, and it has none: set PALUGADA_APP_URL_PUBLIC to the HTTPS address the console is reached at, then connect the number', {});
    }
    const accountId = typeof body.phoneNumberId === 'string' ? body.phoneNumberId.trim() : '';
    if (!/^\d{5,20}$/.test(accountId)) {
      throw new PalugadaError('contract.violation', 'the phone number ID is the number Meta shows under API Setup, digits only; it is not the phone number', { field: 'phoneNumberId' });
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (token.length < 20 || /\s/.test(token)) {
      throw new PalugadaError('contract.violation', 'paste the access token of a system user that may send for this number', { field: 'token' });
    }
    const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
    if (!appSecret || /\s/.test(appSecret)) {
      throw new PalugadaError('contract.violation', 'paste the app secret, from the app\'s Basic settings: it is how a delivery is known to be from Meta', { field: 'appSecret' });
    }
    const where = await checkChannel(companyId, {
      roleId: body.roleId, goalId: body.goalId, instruction: body.instruction, maxPerHour: body.maxPerHour,
    });
    const number = await outside(whatsappNumber(token, accountId, this.#whatsappApi()));
    const account = number.number.replace(/\D/g, '');
    await assertAccountFree(companyId, 'whatsapp', account);
    await this.#requireFactor(body.proof, 'let customers write to the company', companyId);
    const master = deployment.master(true);
    if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
    const sealedToken = `chat-${randomBytes(8).toString('hex')}`;
    const sealedSecret = `chat-${randomBytes(8).toString('hex')}`;
    const verifyToken = randomBytes(24).toString('hex');
    await putSecret(sealedToken, token, master);
    await putSecret(sealedSecret, appSecret, master);
    let opened: Awaited<ReturnType<typeof openChannel>>;
    try {
      opened = await openChannel(companyId, {
        kind: 'whatsapp', account, ...where, tokenRef: `db://${sealedToken}`, webhookHash: hashSecret(verifyToken),
        accountId, secretRef: `db://${sealedSecret}`,
      });
    } catch (failure) {
      await deleteSecret(sealedToken).catch(() => undefined);
      await deleteSecret(sealedSecret).catch(() => undefined);
      throw failure;
    }
    for (const ref of opened.replacedRefs) await deleteSecret(ref.slice('db://'.length));
    await this.#answerCustomers(companyId, where.divisionId, where.roleId, `+${account}`);
    return {
      channel: (await channelsOf(companyId)).find((one) => one.id === opened.id),
      webhook: 'manual',
      callbackUrl: `${publicUrl.replace(/\/+$/, '')}/api/chat-hooks/${opened.publicId}`,
      verifyToken,
    };
  }

  /**
   * A company's own mailbox (0113): read by the workers over IMAP from now
   * on, answered over SMTP. Both servers are signed in to before anything is
   * kept, so a wrong password is said while the owner is looking at the
   * form; and the reading starts after the inbox's last message, so its
   * history is never taken for work.
   */
  async #connectMailbox(companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deployment = this.#deploymentSettings();
    const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
    if (!emailAddress(address)) {
      throw new PalugadaError('contract.violation', 'the address is the mailbox customers write to, such as halo@tokokopi.id', { field: 'address' });
    }
    const settings = mailSettings(body, address);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || /[\r\n]/.test(password)) {
      throw new PalugadaError('contract.violation', 'paste the mailbox\'s password, or an app password where the provider asks for one (Gmail does)', { field: 'password' });
    }
    const where = await checkChannel(companyId, {
      roleId: body.roleId, goalId: body.goalId, instruction: body.instruction, maxPerHour: body.maxPerHour,
    });
    await assertAccountFree(companyId, 'email', address);
    const pollState = await checkMailbox(settings, password, await this.#mailOptions());
    await this.#requireFactor(body.proof, 'let customers write to the company', companyId);
    const master = deployment.master(true);
    if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
    const sealed = `chat-${randomBytes(8).toString('hex')}`;
    await putSecret(sealed, password, master);
    let opened: Awaited<ReturnType<typeof openChannel>>;
    try {
      opened = await openChannel(companyId, {
        kind: 'email', account: address, ...where, tokenRef: `db://${sealed}`, webhookHash: '',
        mail: { ...settings }, pollState,
      });
    } catch (failure) {
      await deleteSecret(sealed).catch(() => undefined);
      throw failure;
    }
    for (const ref of opened.replacedRefs) await deleteSecret(ref.slice('db://'.length));
    await this.#answerCustomers(companyId, where.divisionId, where.roleId, address);
    return { channel: (await channelsOf(companyId)).find((one) => one.id === opened.id), webhook: 'polled' };
  }

  /** A certificate authority to trust for a mail server with a private one (`PALUGADA_MAIL_CA`, a PEM file). */
  async #mailOptions(): Promise<MailOptions> {
    const path = this.#deploymentSettings().baseEnv.PALUGADA_MAIL_CA;
    if (!path) return {};
    const { readFile } = await import('node:fs/promises');
    return { ca: await readFile(path, 'utf8') };
  }

  #botApi(): { apiBase?: string } {
    const base = this.#deploymentSettings().baseEnv.PALUGADA_TELEGRAM_API;
    return base ? { apiBase: base } : {};
  }

  /** The token the owner pasted, or the one saved. */
  /**
   * A picture the console ships: from the console as built, which is what a
   * deployment has, else from its source, which is what a checkout has.
   */
  async #consolePicture(path: string): Promise<Buffer> {
    const { readFile } = await import('node:fs/promises');
    for (const root of [this.#options.staticRoot, fileURLToPath(new URL('../../console/public', import.meta.url))]) {
      if (!root) continue;
      try {
        return await readFile(join(root, path));
      } catch {
        // The next place.
      }
    }
    throw new PalugadaError('contract.violation', `the console's ${path} is not there: build the console with npm run console:build`, {});
  }

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

  /**
   * A card applied: its route, called as the page would call it, with what
   * the owner added -- a key typed on the card, their device's proof. A
   * refusal for want of the device leaves the card open for them to try
   * again with it; any other refusal closes it.
   */
  async #applyProposal(
    proposal: AssistantProposal, added: Record<string, unknown>, request: IncomingMessage, session: OwnerSession | null, channel: AssistantChannel,
  ): Promise<unknown> {
    try {
      const result = await this.#dispatch('POST', proposal.path, { ...proposal.body, ...added }, request, session);
      await closeProposal(proposal.id, 'applied', outcomeOf(result), channel);
      return result;
    } catch (failure) {
      const code = failure instanceof PalugadaError ? failure.code : '';
      if (code !== 'approval.channel_forbidden' && !code.startsWith('mfa.')) {
        await closeProposal(proposal.id, 'failed', (failure as Error).message, channel);
      }
      throw failure;
    }
  }

  /**
   * The owner's conversation as a chat reaches it: the same conversations
   * as the console's, with the same model and reads, the owner's authority
   * and no session -- a chat has none, and no route a card from a chat may
   * reach needs one (`chatMayApply`).
   */
  #chatConversation(request: IncomingMessage, channel: 'telegram' | 'whatsapp' = 'telegram'): ChatConversation {
    const voice = this.#options.assistant?.voice;
    const language = async () => (await deploymentLanguages()).console ?? 'en';
    return {
      hears: Boolean(voice?.listen),
      speaks: Boolean(voice?.speak),
      partners: async () => chatPartners(await language()),
      current: () => chatScope(channel),
      moveTo: (companyId) => moveChat(companyId, channel),
      talk: async (companyId, text, signal) => {
        const said = (await converse({
          llm: this.#options.assistant?.llm ?? null,
          reach: this.#reach(request, null),
          language,
          ...(companyId ? { companyId } : {}),
          ...(signal ? { signal } : {}),
        }, text, channel)).at(-1)!;
        // Stopped, the conversation ends on what happened rather than on an answer.
        if (said.role === 'event') return { answer: '', cards: [], stopped: true };
        return {
          answer: said.body,
          cards: said.proposals.filter((one) => one.status === 'open').map((one) => ({ id: one.id, summary: one.summary, here: chatMayApply(one) })),
        };
      },
      // What the console's microphone gets: heard once, kept nowhere, in the console's language.
      hear: async (audio) => transcribe(voice!.listen!, audio, (await deploymentLanguages()).console ?? null, AbortSignal.timeout(60_000)),
      speak: async (text) => makeSpeech(voice!.speak!, { text: text.slice(0, 2_000) }, AbortSignal.timeout(60_000)),
      apply: async (cardId) => {
        const proposal = await proposalById(cardId);
        if (!proposal) return { outcome: 'unknown' };
        if (proposal.status !== 'open') return { outcome: 'closed', status: proposal.status };
        if (!chatMayApply(proposal)) return { outcome: 'app' };
        await this.#applyProposal(proposal, {}, request, null, channel);
        return { outcome: 'applied', summary: proposal.summary };
      },
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
    const answer = await this.#acting.run(session, () => match.route.handle({ request, session, staff: null, body, raw: Buffer.alloc(0), params: match.params, query: url.searchParams }));
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
  async #mcpToken(body: Record<string, unknown>, url: string): Promise<{
    token: string | null; typed: string | null; keep: boolean; signedIn: boolean;
  }> {
    const typed = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
    if (typed) return { token: typed, typed, keep: false, signedIn: false };
    const settings = await readSettings();
    // Signed in to with OAuth: the token the sign-in left, for the address it
    // was issued for and no other. Saved or not, it is kept under the same
    // name as a pasted one, and this says which it is.
    const grant = typeof body.name === 'string' ? oauthGrantsIn(settings)[body.name] : undefined;
    const signedIn = Boolean(grant && grant.url === url);
    const saved = typeof body.name === 'string' ? mcpServersIn(settings).find((one) => one.name === body.name) : undefined;
    if (saved?.tokenSecret && new URL(saved.url).origin === new URL(url).origin) {
      return { token: await this.#deploymentSettings().secrets.resolve(`db://${saved.tokenSecret}`), typed: null, keep: true, signedIn };
    }
    if (signedIn) {
      return { token: await this.#deploymentSettings().secrets.resolve(`db://${mcpSecretName(body.name as string)}`), typed: null, keep: true, signedIn };
    }
    return { token: null, typed: null, keep: false, signedIn: false };
  }

  /**
   * Seals a division's key and makes it the credential for its alias: a key
   * pasted, or a sign-in's grant. Kept again for the same alias it is a
   * rotation (F12.3): the next call uses it, and the key it replaced is
   * deleted. F12.6: it is declared as carrying what the division's
   * capabilities ask of it and nothing more -- the broker refuses a key that
   * does not declare a scope its capability needs, and the database one that
   * declares a scope nothing here needs.
   */
  async #keepDivisionKey(input: {
    companyId: string; divisionId: string; alias: string; value: string; prefix: string;
  }): Promise<{ alias: string; version: number }> {
    const { companyId, divisionId, alias } = input;
    const master = this.#deploymentSettings().master(true);
    if (!master) throw new PalugadaError('credential.unavailable', 'this deployment cannot seal a secret', {});
    const { previous, scopes } = await withControlPlane(async (tx) => {
      await assertDivisionOf(tx, companyId, divisionId);
      const { rows } = await tx.query<{ secret_ref: string }>(
        'SELECT secret_ref FROM credentials WHERE company_id = $1 AND division_id = $2 AND alias = $3',
        [companyId, divisionId, alias],
      );
      const granted = await tx.query<{ capability_name: string }>(
        'SELECT capability_name FROM capability_grants WHERE company_id = $1 AND division_id = $2',
        [companyId, divisionId],
      );
      const asked = keysAskedFor(this.#options.registry, granted.rows.map((row) => row.capability_name)).get(alias);
      return { previous: rows[0]?.secret_ref ?? null, scopes: asked?.scopes ?? [] };
    });
    const secret = `${input.prefix}${randomBytes(8).toString('hex')}`;
    await putSecret(secret, input.value, master);
    const reference = `db://${secret}`;
    const sweep = {
      ...(this.#options.registry ? { registry: this.#options.registry } : {}),
      ...(this.#options.credentialFor ? { credential: this.#options.credentialFor } : {}),
    };
    let version = 1;
    try {
      if (previous) {
        // Declared before the rotation's sweep, which checks the key
        // against what its capabilities need.
        await withControlPlane((tx) => tx.query(
          'UPDATE credentials SET scopes = $4 WHERE company_id = $1 AND division_id = $2 AND alias = $3',
          [companyId, divisionId, alias, scopes],
        ));
        version = (await rotateCredential({ companyId, divisionId, alias, newSecretRef: reference, ...sweep })).version;
      } else {
        await withControlPlane((tx) => tx.query(
          'INSERT INTO credentials (company_id, division_id, alias, secret_ref, scopes) VALUES ($1, $2, $3, $4, $5)',
          [companyId, divisionId, alias, reference, scopes],
        ));
        await withTenant(companyId, (tx) => appendEvent(tx, {
          companyId, type: 'credential.added', actor: 'owner', payload: { alias, divisionId, secretRef: reference },
        }));
        // The same sweep a rotation takes, so a capability that was
        // unhealthy for want of this key is checked again now.
        if (sweep.registry) {
          await preflightGrants(sweep.registry, { companyId, divisionId, ...(sweep.credential ? { credential: sweep.credential } : {}) });
        }
      }
    } catch (failure) {
      await deleteSecret(secret).catch(() => undefined);
      throw failure;
    }
    if (previous?.startsWith(`db://${CREDENTIAL_SECRETS}`)) await deleteSecret(previous.slice('db://'.length));
    // Every role that asked for this key (`owner.ask` with `key`) is told it
    // is there -- that it is, never what it is -- and its work goes on.
    const { rows: asked } = await withTenant(companyId, (tx) => tx.query<{ id: string }>(
      `SELECT id FROM inbox_items
        WHERE kind = 'escalation' AND status = 'open' AND payload->>'askedBy' = 'agent'
          AND payload->'key'->>'alias' = $1 AND payload->'key'->>'divisionId' = $2
        ORDER BY created_at`, [alias, divisionId]));
    for (const item of asked) {
      await inbox.answerEscalation(companyId, item.id,
        `The owner gave the ${alias} key. Call the capability that needed it again: it signs in with it now.`, { channel: 'app' });
    }
    return { alias, version };
  }

  /** The capabilities a division may use, by name. */
  async #grantedTo(companyId: string, divisionId: string): Promise<string[]> {
    return withControlPlane(async (tx) => (await tx.query<{ capability_name: string }>(
      'SELECT capability_name FROM capability_grants WHERE company_id = $1 AND division_id = $2',
      [companyId, divisionId],
    )).rows.map((row) => row.capability_name));
  }

  /**
   * How a key is signed in for: from the capabilities that use it -- those
   * granted, when the division is known -- with every scope they ask for.
   */
  #signInFor(alias: string, granted: readonly string[] | null): CredentialSignIn | null {
    const registry = this.#options.registry;
    if (!registry) return null;
    const names = granted ?? registry.names();
    return keysAskedFor(registry, names).get(alias)?.signIn ?? null;
  }

  /**
   * What each model costs as the next start will price it: the operator's
   * list with the owner's laid over it, from what is stored now, so a price
   * just saved shows before the restart that takes it up.
   */
  #pricesFor(models: ReadonlyArray<string | undefined>, stored: Record<string, unknown>) {
    const own = (stored.model_prices as { models?: Record<string, unknown> } | undefined)?.models ?? {};
    // The file's, then setup's (PALUGADA_MODEL_PRICE_SETTINGS in the
    // environment), then the owner's: the order the start lays them in.
    const configured = withConsolePrices(this.#options.prices ?? DEFAULT_PRICE_TABLE,
      this.#deploymentSettings().baseEnv.PALUGADA_MODEL_PRICE_SETTINGS);
    const table = withConsolePrices(configured, Object.keys(own).length > 0 ? JSON.stringify({ models: own }) : undefined);
    return [...new Set(models.filter((model): model is string => Boolean(model)))].map((model) => {
      const { rate, basis } = rateFor(table, model);
      return {
        model,
        input: rate.inputCentsPerMTok,
        output: rate.outputCentsPerMTok,
        source: model in own ? 'console' : basis === 'fallback' ? 'fallback' : 'file',
      };
    });
  }

  /**
   * Where an authorization server sends the owner back: this deployment's
   * public address, or the address the owner reached this console at, which
   * must be https or this machine's own -- the only kinds OAuth sends a code to.
   */
  #callbackAddress(request: IncomingMessage): string {
    const configured = this.#deploymentSettings().baseEnv.PALUGADA_APP_URL_PUBLIC;
    const base = configured
      ? configured.replace(/\/+$/, '')
      : `${this.#options.behindProxy && request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${request.headers.host ?? ''}`;
    let url: URL;
    try {
      url = new URL(`${base}/api/oauth/callback`);
    } catch {
      throw new PalugadaError('config.invalid', 'this console cannot tell its own address; set PALUGADA_APP_URL_PUBLIC', {});
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) {
      throw new PalugadaError('config.invalid',
        `a sign-in comes back only to an https address or to this machine, and this console is at ${url.origin}: `
          + 'set PALUGADA_APP_URL_PUBLIC to its https address, or open the console on this machine at localhost', { origin: url.origin });
    }
    return url.toString();
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
  /** The sending service the console asks about: checked, with the key typed or the one saved for that same service. */
  async #emailCandidate(body: Record<string, unknown>): Promise<{ provider: EmailProviderId; key: string; from: string; to: string }> {
    const provider = emailProvider(typeof body.provider === 'string' ? body.provider : '');
    if (!provider) {
      throw new PalugadaError('contract.violation', `a sending service is ${EMAIL_PROVIDERS.map((one) => one.id).join(', ')}`, { field: 'provider' });
    }
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!emailAddress(from)) {
      throw new PalugadaError('contract.violation', `from is an address ${provider.name} lets this account send from, as alerts@yourdomain.com`, { field: 'from' });
    }
    if (!emailAddress(to)) throw new PalugadaError('contract.violation', 'to is your own address', { field: 'to' });
    const typed = typeof body.key === 'string' ? body.key.trim() : '';
    const stored = ((await readSettings()).channels as ChannelSettings | undefined)?.email;
    const key = typed || (stored?.provider === provider.id
      ? await this.#deploymentSettings().secrets.resolve(`db://${stored.keySecret}`).catch(() => '')
      : '');
    if (!key || /\s/.test(key)) throw new PalugadaError('contract.violation', `paste an API key from ${provider.name}`, { field: 'key' });
    return { provider: provider.id, key, from, to };
  }

  /** Another origin for the sending service's API, when a test or a proxy names one. */
  #emailApi(): { apiBase?: string } {
    const base = this.#deploymentSettings().baseEnv.PALUGADA_EMAIL_API;
    return base ? { apiBase: base } : {};
  }

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
      embed: EMBED_PROVIDERS, vision: VISION_PROVIDERS,
    } as const;
    const provider = kind === 'search' ? searchProvider(id) : kind === 'extract' ? extractProvider(id)
      : kind === 'image' ? imageProvider(id) : kind === 'speech' ? speechProvider(id)
        : kind === 'embed' ? embedProvider(id) : kind === 'vision' ? visionProvider(id) : listenProvider(id);
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
    // The saved key stays with the address it was saved for, as the model's
    // does: a provider you run yourself, tried at another address -- a try
    // needs no second factor -- would otherwise be sent the saved key there.
    const keep = !typed && body.clearKey !== true && saved?.provider === provider.id && Boolean(saved.keySecret)
      && sameOrigin(saved.url ?? undefined, url ?? undefined);
    if (provider.key === 'required' && !typed && !keep) {
      throw new PalugadaError('contract.violation', `${provider.name} needs a key`, { field: 'key' });
    }
    const binding: ToolBinding<SearchProvider | ExtractProvider | ImageProvider | SpeechProvider | ListenProvider | EmbedProvider | VisionProvider> = {
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

  /**
   * A new version of a charter: the platform's when `companyId` is null.
   *
   * Everything that can be checked without the factor is checked first, so
   * a blank or runaway charter costs a correction rather than a code. The
   * same words again are not a change: no version, and no factor asked for
   * nothing -- saving an unchanged page would otherwise put a version in the
   * history that nobody can tell from the one before it.
   */
  async #writeCharter(
    companyId: string | null,
    body: Record<string, unknown>,
  ): Promise<{ version: number; unchanged: boolean; file?: string | null }> {
    const text = charterText(body.body);
    const { current, slug } = await withControlPlane(async (tx) => {
      let slug: string | null = null;
      if (companyId !== null) {
        const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [companyId]);
        if (rows.length === 0) {
          throw new PalugadaError('contract.violation', 'there is no company with that id', { companyId });
        }
        slug = rows[0]!.slug;
      }
      const { rows } = await tx.query<{ version: number; body: string }>(
        `SELECT version, body FROM charters WHERE company_id IS NOT DISTINCT FROM $1
          ORDER BY version DESC LIMIT 1`,
        [companyId],
      );
      return { current: rows[0], slug };
    });
    if (current?.body === text) return { version: current.version, unchanged: true };
    await this.#requireFactor(
      body.proof, companyId === null ? 'change the platform charter' : 'change the company charter', companyId);
    const published = await publishCharter(companyId === null ? { body: text } : { companyId, body: text });
    // F3.11: into its file and committed now, rather than on the next tick.
    // A repository that cannot be written does not undo a charter the owner
    // saved; the next sync tries again. But the owner is told now: a file
    // that stays behind is the one a later edit, or a pull, is made from.
    if (!this.#options.charters) return { version: published.version, unchanged: false };
    const synced = await this.#options.charters.sync().catch(() => null);
    const path = slug === null ? PLATFORM_CHARTER_FILE : join('companies', slug, COMPANY_CHARTER_FILE);
    const refused = synced?.refused.find((one) => one.path === path);
    const file = !synced ? 'Not written to its file: the charter repository could not be reached; the next sync tries again.'
      : synced.git.startsWith('held: ') ? `Not written to its file: ${synced.git.slice('held: '.length)}`
        : refused ? `Not written to its file: ${refused.reason}`
          : null;
    return { version: published.version, unchanged: false, file };
  }

  /** The deployment's browsers, or why there are none. */
  #browsers(): Browsers {
    if (!this.#options.browsers) {
      throw new PalugadaError('contract.violation',
        'this deployment has no browser: install Chromium on its machine, or set PALUGADA_CHROMIUM to one', {});
    }
    return this.#options.browsers;
  }

  async #requireFactor(
    proof: unknown,
    purpose: string,
    companyId: string | null = null,
    covered: typeof WITHIN_THE_WINDOW | null = null,
  ): Promise<void> {
    if (proof === undefined || proof === null) {
      // What builds the company is covered by a code shown a few minutes ago;
      // what loosens money, reaches outside or changes a key never is.
      if (covered === WITHIN_THE_WINDOW && await this.#withinStepUp()) return;
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
    // Taken only for what a code may do (RECOVERY_PURPOSES), and refused for the rest.
    else if ('recovery' in presented) await this.#options.mfa.verifyRecoveryCode(presented.recovery, asking);
    else await this.#options.mfa.verifyWebAuthn(presented.webauthn, asking);
    // A code or a passkey just shown opens the window; a recovery code proves less and opens none.
    if (!('recovery' in presented)) {
      const session = this.#acting.getStore();
      if (session) await this.#sessions.prove(session.token);
    }
  }

  /** Whether the owner's session showed a code recently enough to cover an action in the window. */
  async #withinStepUp(): Promise<boolean> {
    const session = this.#acting.getStore();
    if (!session) return false;
    // Read again, not from the request's own copy: a code shown a moment ago, in another tab, counts.
    const live = await this.#sessions.verify(session.token);
    return withinWindow(live?.provedAt ?? null, await stepUpMinutes(), new Date());
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
    let staff: StaffSession | null = null;
    if (!match.route.open) {
      session = await this.#sessions.verify(bearer(req));
      // Not the owner's: a staff seat's (0110), held to its list before its
      // request is read at all.
      if (!session) staff = await this.#staff.verify(bearer(req));
      if (!session && !staff) {
        // 401 rather than 404: the owner whose session expired should be told
        // to sign in, not told the console has moved.
        send(res, 401, { error: 'sign in first', code: 'owner.unauthenticated' });
        return;
      }
      if (staff && !staffMay(staff.seat, req.method ?? 'GET', match.route.pattern, match.params)) {
        send(res, 403, { error: 'that is the owner\'s, not a staff seat\'s', code: 'staff.forbidden' });
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
      const answer = await this.#acting.run(session, () => match.route.handle({
        request: req,
        session,
        staff,
        body,
        raw,
        params: match.params,
        query: url.searchParams,
      }));
      if (answer instanceof WithStatus) send(res, answer.status, answer.body);
      else if (answer instanceof EventStream) await this.#stream(req, res, answer);
      else if (answer instanceof HtmlPage) sendPage(res, answer);
      else if (answer instanceof PlainText) {
        res.writeHead(200, { 'content-type': answer.contentType, 'cache-control': 'no-store' });
        res.end(answer.text);
      }
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
   * Writes an event stream until the owner goes or the API closes. A comment
   * line now and then keeps a quiet stream from being cut by a proxy that
   * closes what it thinks is idle; `X-Accel-Buffering` asks one that buffers
   * answers not to hold these back.
   */
  async #stream(req: IncomingMessage, res: ServerResponse, stream: EventStream): Promise<void> {
    const stop = new AbortController();
    this.#streams.add(stop);
    req.once('close', () => stop.abort());
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': listening\n\n');
    const beat = setInterval(() => res.write(': still here\n\n'), STREAM_HEARTBEAT_MS);
    try {
      await stream.run((data, id) => {
        res.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      }, stop.signal);
    } finally {
      clearInterval(beat);
      this.#streams.delete(stop);
      res.end();
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
  // pdf.js's worker is a module named .mjs (console/src/pdf.ts); served as
  // anything else, nosniff stops it and no PDF can be read.
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** What the console is told about a staff seat signed in: who, and what it may do. */
function staffOf(session: StaffSession): { name: string; kind: string; companyId: string } {
  return { name: session.seat.name, kind: session.seat.kind, companyId: session.seat.companyId };
}

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
  if (code === 'owner.claimed') return 409;
  if (code === 'schedule.still_running') return 409;
  if (code === 'schedule.slug_taken') return 409;
  if (code === 'task.not_continuable') return 409;
  if (code === 'company.slug_taken') return 409;
  if (code === 'browser.not_held') return 409;
  if (code === 'mfa.locked_out') return 429;
  if (code.startsWith('mfa.')) return 401;
  if (code === 'approval.channel_forbidden' || code === 'policy.denied' || code === 'staff.forbidden') return 403;
  if (code === 'capability.rate_limited' || code === 'capability.busy' || code === 'hook.rate_limited') return 429;
  if (code === 'hook.unknown') return 404;
  if (code === 'hook.refused') return 401;
  if (code === 'hook.unsupported') return 415;
  if (code === 'hook.unavailable') return 503;
  if (code === 'metrics.off') return 404;
  if (code === 'metrics.refused') return 401;
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

/**
 * The console's name as the request gave it, for the label an authenticator
 * app shows beside the code: an owner of two deployments tells them apart.
 */
function hostLabel(request: IncomingMessage): string {
  const host = /^[a-z0-9.-]+/i.exec(String(request.headers.host ?? ''))?.[0];
  return host || 'palugada';
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

/**
 * Who a role is, from a request: its name, its title and its persona, each
 * only when present, and each cleared by an explicit null or empty string.
 */
function whoFrom(body: Record<string, unknown>): { displayName?: string | null; title?: string | null; persona?: RolePersona | null } {
  const who: { displayName?: string | null; title?: string | null; persona?: RolePersona | null } = {};
  for (const [field, key] of [['displayName', 'displayName'], ['title', 'title']] as const) {
    if (body[field] === undefined) continue;
    const text = body[field] === null ? '' : String(body[field]).trim();
    if (text.length > 60) throw new PalugadaError('contract.violation', `${field} is at most 60 characters`, { field });
    who[key] = text === '' ? null : key === 'title' ? titleFrom(text) : text;
  }
  if (body.persona !== undefined) {
    try {
      who.persona = personaFrom(body.persona);
    } catch (failure) {
      throw new PalugadaError('contract.violation', (failure as Error).message, { field: 'persona' });
    }
  }
  return who;
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

/** A picture the owner chose to try Seeing with: a `data:` address, held to being one of the kinds a provider takes. */
function pictureFrom(body: Record<string, unknown>): Picture {
  const image = typeof body.image === 'string' ? body.image.replace(/^data:[^;]*;base64,/, '') : '';
  if (!image) throw new PalugadaError('contract.violation', 'choose a picture to try it with', { field: 'image' });
  const bytes = Buffer.from(image, 'base64');
  const mime = pictureKind(bytes);
  if (!mime) throw new PalugadaError('contract.violation', 'that is not a picture: a PNG, JPEG, WebP or GIF is', { field: 'image' });
  return { bytes, mime };
}

/** What a route answered, in a sentence the conversation keeps: short, and never a secret, which no route returns. */
/**
 * Marks a call to `#requireFactor` as one a recent code covers (0120): the
 * actions that build the company -- a division, a role, a grant, a goal, a
 * measure, a skill, a bundle -- which the owner is already doing, one after
 * another, when they set it up. Left off, as every other is, it asks for a
 * code each time: money, keys, the model, channels, devices, what lets
 * outsiders in, and every tier 3 decision.
 */
const WITHIN_THE_WINDOW = Symbol('within the window');

function outcomeOf(result: unknown): string {
  const text = JSON.stringify(result) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** The console's MCP servers, as saved. */
/** The services the owner connected in the console. */
function vendorsIn(settings: Record<string, unknown>): VendorSpec[] {
  return ((settings.vendors as { capabilities?: VendorSpec[] } | undefined)?.capabilities) ?? [];
}

/** Where a credential's value lives, said without saying the value. */
function storedAt(reference: string): 'console' | 'environment' | 'file' | 'elsewhere' {
  if (reference.startsWith(`db://${CREDENTIAL_SECRETS}`)) return 'console';
  if (reference.startsWith('env://')) return 'environment';
  if (reference.startsWith('file://')) return 'file';
  return 'elsewhere';
}

/** Refused unless the division is the company's: a path can name any pair of ids. */
async function assertDivisionOf(tx: TenantClient, companyId: string, divisionId: string): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const { rows } = uuid.test(companyId) && uuid.test(divisionId)
    ? await tx.query('SELECT 1 FROM divisions WHERE id = $1 AND company_id = $2', [divisionId, companyId])
    : { rows: [] };
  if (rows.length === 0) {
    throw new PalugadaError('contract.violation', `there is no division ${divisionId} in that company`, { divisionId });
  }
}

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
  assertPlainHttpIsLocal(url);
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
/** Whether two model addresses are one server; no address is the provider's own. */
function sameOrigin(saved: string | undefined, asked: string | undefined): boolean {
  if (saved === undefined || asked === undefined) return saved === asked;
  try {
    return new URL(saved).origin === new URL(asked).origin;
  } catch {
    return false;
  }
}

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
  // The saved key goes only where it was saved for: the same provider at the
  // same origin. A check, a test or a save naming another address gets no
  // key, or it would be handed to whoever answers there -- and the assistant
  // runs the checks itself, so a page it read could name that address.
  const keep = previous && previous.provider === provider && sameOrigin(previous.url, url) ? previous.keySecret : undefined;
  return {
    ...(preset ? { preset } : {}),
    provider,
    ...(url ? { url } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(body.clearKey === true || !keep ? {} : { keySecret: keep }),
  };
}

function proofFrom(value: unknown): { totp: string } | { webauthn: WebAuthnAssertion } | { recovery: string } {
  const body = (value ?? {}) as Record<string, unknown>;
  if (typeof body.totp === 'string') return { totp: body.totp };
  if (body.webauthn && typeof body.webauthn === 'object') {
    return { webauthn: body.webauthn as WebAuthnAssertion };
  }
  if (typeof body.recovery === 'string' && body.recovery.length <= 64) return { recovery: body.recovery };
  throw new PalugadaError(
    'contract.violation',
    'a second factor is a totp code, a webauthn assertion or a recovery code',
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

/** Calls in flight at once, as a grant may allow them: a whole number from 1 to `MAX_IN_FLIGHT`. */
function inFlightLimit(value: unknown): number {
  const limit = wholeNumber(value, 'maxInFlight');
  if (limit > MAX_IN_FLIGHT) {
    throw new PalugadaError('contract.violation',
      `maxInFlight is ${limit}; a grant allows at most ${MAX_IN_FLIGHT} calls at once, or 0 for no limit`,
      { field: 'maxInFlight' });
  }
  return limit;
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

/**
 * A project's work language from a request (0100): undefined when it was
 * left out, which leaves it as it is; null for the company's; otherwise a
 * code agents can be told, or the refusal naming every code accepted.
 */
function projectWorkLanguage(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return languageCode(value, 'workLanguage');
}

/** The fields of a body that were given, and none other: a record changes only what the owner sent. */
function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
}

/** A string that has to be there. `String(undefined)` is "undefined", and it fits. */
function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new PalugadaError('contract.violation', `${field} is required`, { field });
  }
  return text;
}

/**
 * A charter's text, trimmed at its ends. Bounded because every run of the
 * company carries it whole and it is never dropped to make room (F3.2): a
 * charter of a book's length would be paid for on every call a model makes,
 * and would crowd out the task it is meant to govern.
 */
function charterText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PalugadaError('contract.violation', 'write the charter: it is empty', { field: 'body' });
  if (text.length > CHARTER_LIMIT) {
    throw new PalugadaError(
      'contract.violation',
      `a charter is at most ${CHARTER_LIMIT} characters, and this one is ${text.length}; every run carries it whole`,
      { field: 'body' },
    );
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
const SKILL_SCOPES = ['company', 'platform', 'division'] as const;

/** A skill's check (F15.4), as the owner writes one: a name and what the skill must say. */
function checkFrom(raw: unknown): { name: string; input: Record<string, unknown>; expectContains: string[] } {
  const check = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const name = requireText(check.name, 'name').trim().slice(0, 120);
  const expectContains = Array.isArray(check.expectContains)
    ? check.expectContains.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map((one) => one.trim())
    : [];
  if (expectContains.length === 0 || expectContains.length > 20) {
    throw new PalugadaError('contract.violation',
      'a check names 1 to 20 phrases every version of the skill must contain', { field: 'expectContains' });
  }
  return { name, input: {}, expectContains };
}
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

/**
 * Whether two secrets are the same, in time that does not depend on where they
 * first differ. Compared as digests, so their lengths do not show either.
 */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** A page with no script and nothing loaded from anywhere: what it says, and nothing it could be made to do. */
function sendPage(res: ServerResponse, page: HtmlPage): void {
  res.writeHead(page.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
  });
  res.end(`<!doctype html><html lang="${escapeHtml(page.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(page.title)}</title></head>`
    + `<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">`
    + `<h1 style="font-size: 1.4rem">${escapeHtml(page.title)}</h1><p>${escapeHtml(page.text)}</p></body></html>`);
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
  id: string; slug: string; name: string; frozen: boolean; eraseAfter: Date | null; workLanguage: string | null; talkLanguage: string | null;
  guardian: boolean;
  stage: Stage | null; headline: Headline | null; ceo: { roleId: string; slug: string; displayName: string | null } | null;
}>> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; slug: string; name: string; frozen: boolean; eraseAfter: Date | null; workLanguage: string | null; talkLanguage: string | null;
      guardian: boolean;
      stage: Stage | null; ceo: { roleId: string; slug: string; displayName: string | null } | null;
    }>(
      // Who the owner talks to in each (0068), for the pages that offer the conversation.
      `SELECT company.id, company.slug, company.name, company.frozen_at IS NOT NULL AS frozen, company.erase_after AS "eraseAfter",
              company.work_language AS "workLanguage", company.talk_language AS "talkLanguage", company.stage, company.guardian,
              CASE WHEN ceo.id IS NULL THEN NULL
                   ELSE jsonb_build_object('roleId', ceo.id, 'slug', ceo.slug, 'displayName', ceo.display_name) END AS ceo
         FROM companies company LEFT JOIN roles ceo ON ceo.company_id = company.id AND ceo.title = 'CEO'
        ORDER BY company.created_at`,
    );
    const measured = await headlines(tx);
    return rows.map((row) => ({ ...row, headline: measured.get(row.id) ?? null }));
  });
}
