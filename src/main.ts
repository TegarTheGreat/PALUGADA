/**
 * The deployment (PRD v2 §10).
 *
 * Every module in this repository is assembled by somebody, and until now that
 * somebody was a test. That is the defect this codebase has found in itself
 * more often than any other -- machinery that works, is tested in isolation,
 * and is assembled by nobody -- so the assembly is a file, with the wiring in
 * one place where it can be read and got wrong once rather than in every
 * deployment separately.
 *
 * What it starts:
 *
 *   - the **worker**, which is the platform running (F5, F9);
 *   - the **owner's console**, which is the platform being run (F10);
 *   - whichever **notification channels** the environment configured (F10.5,
 *     F10.9), each of which needs a vendor account and none of which is
 *     invented here.
 *
 * **Configuration is environment, and the absence of it is a refusal rather
 * than a default.** A deployment with no MFA secret cannot approve a tier 3
 * action, and this file will not paper over that with a generated one: F12.5
 * is a P0, and the consequence of not meeting it should be that irreversible
 * actions wait. Every optional piece here is optional because it needs
 * something this process cannot conjure -- a bot token, a push URL, a sandbox
 * account -- and every one of them says so at boot rather than at 3am.
 */
import { CapabilityBroker } from './broker/broker.ts';
import { CapabilityRegistry } from './broker/registry.ts';
import { Engine } from './engine/engine.ts';
import { DEFAULT_PRICE_TABLE, loadPriceTable, withConsolePrices } from './engine/pricing.ts';
import { modelClientFrom, modelSettingsFrom } from './llm/models.ts';
import { bindMcpServers, closeMcpSessions, registerMcpServers } from './capabilities/mcp.ts';
import { refreshMcpAccess } from './capabilities/mcp-oauth.ts';
import { OAuthCredentials } from './capabilities/vendor-oauth.ts';
import { Worker, type WorkerOptions } from './worker.ts';
import { DivisionSecrets, deploymentReferences, type SecretManager } from './secrets/manager.ts';
import { OtlpExporter, otlpFrom } from './reporting/otlp.ts';
import { VERSION } from './version.ts';
import { EMAIL_PROVIDERS, EmailChannel, emailAddress, emailProvider } from './owner/email.ts';
import { OwnerMfa, decodeBase32 } from './owner/mfa.ts';
import { openOwnerClaim } from './owner/claim.ts';
import {
  DeploymentSecretManager, masterKeyFrom, previousMasterKeysFrom, readSettings, resealSecrets, settingsVersion, stateDirFrom, type MasterKey,
} from './settings/store.ts';
import { CharterRepository } from './governance/charter-repository.ts';
import { Guardian } from './broker/guardian.ts';
import { withSettings } from './settings/overlay.ts';
import { LocalSecretManager } from './secrets/local.ts';
import { PalugadaError } from './errors.ts';
import { OwnerApi } from './owner/api.ts';
import { WebhookPush, ntfyBody } from './owner/push.ts';
import { TelegramChannel } from './owner/telegram.ts';
import { WhatsAppChannel } from './owner/whatsapp.ts';
import { WebhookChatChannel } from './owner/webhook-chat.ts';
import type { OwnerChannel } from './owner/notify.ts';
import { AdapterRegistry } from './runtime/protocol.ts';
import { assembleRuntimes } from './runtime/assemble.ts';
import { useMeaning } from './knowledge/meaning.ts';
import type { TaskHandler } from './runtime/in-process.ts';
import { registerPlatformCapabilities } from './capabilities/platform.ts';
import { toolBindingsFrom } from './capabilities/tools.ts';
import { bindVendorSettings, registerVendorCapabilities } from './capabilities/vendors.ts';
import { STANDARD_CATALOGUE } from './broker/catalogue.ts';
import { seed } from './seed.ts';
import { registerPlatformCapabilities as registerPlatformTools, PLATFORM_CAPABILITIES }
  from './broker/platform-capabilities.ts';
import { CachedSecretManager } from './secrets/rotation.ts';
import { usesTools, type LlmClient } from './llm/client.ts';
import { adminPool, appPool, closePools } from './db/pool.ts';

/**
 * How long the worker's loop may go without finishing a tick before the
 * process reports itself unable to work. One tick can hold a run for its
 * whole lease, so this is two leases' worth rather than a few seconds.
 */
const WORKER_STALL_MS = 30 * 60_000;

/** How many tasks a process runs at once when nothing says otherwise (L3). */
const DEFAULT_WORKER_CONCURRENCY = 4;

/**
 * `PALUGADA_WORKER_CONCURRENCY`: how many tasks this process runs at once,
 * one of them kept for the owner's urgent work. Four by default: each run
 * holds a database connection only while it writes, and the pools keep ten.
 */
function workerConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WORKER_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new PalugadaError('config.invalid',
      `PALUGADA_WORKER_CONCURRENCY is ${raw}; it is a whole number from 1 to 16`, { variable: 'PALUGADA_WORKER_CONCURRENCY' });
  }
  return value;
}
/**
 * The token a metrics scraper sends, or null to serve no metrics. Refused at
 * boot when it is short enough to guess: it opens a view of every company.
 */
function metricsToken(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw.trim().length < 32) {
    throw new PalugadaError('config.invalid',
      `PALUGADA_METRICS_TOKEN is ${raw.trim().length} characters; it is a secret of at least 32, `
        + 'such as the output of `openssl rand -hex 32`', { variable: 'PALUGADA_METRICS_TOKEN' });
  }
  return raw.trim();
}
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { consoleLinkFor, consoleTaskLinkFor } from './owner/notify.ts';
import { metricsText } from './reporting/metrics.ts';

export interface DeploymentOptions {
  /**
   * Where the secrets actually live. Defaults to the process's environment
   * and mounted secret files (`LocalSecretManager`); a test passes an
   * in-memory one.
   */
  secrets?: SecretManager;
  /**
   * Adapters a deployment binds for itself, on top of what the environment
   * describes. Handed to `assembleRuntimes`, which adds to it rather than
   * replacing it -- a caller's own runtime and a configured one coexist,
   * because a role names which one it wants.
   */
  adapters?: AdapterRegistry;
  /**
   * The handlers the in-process runtime executes (F13.1).
   *
   * Together with `llm` this is the runtime that needs nothing external, and
   * without both of them a deployment has one only if the environment
   * describes a real one. A worker with no runtime at all halts every task it
   * checks out, which is a thing to learn at boot rather than at 3am.
   */
  handlers?: Map<string, TaskHandler>;
  registry?: CapabilityRegistry;
  /** The console's files. Omitted means the API without a page in front. */
  consoleRoot?: string;
  /**
   * The model the platform's own drafting capabilities use.
   *
   * Omitted means `doc.draft` and `email.draft` stay unbound, which is honest:
   * a capability bound to no model would fail at the first call, and a role
   * granted it would be told at the moment it tried to work.
   */
  llm?: LlmClient;
  /**
   * The directory `files.list` may read. There is deliberately no default --
   * the default would be this process's working directory, which is the
   * platform's own source.
   */
  filesRoot?: string;
  /**
   * The JSON file binding the capabilities that need somebody's account.
   *
   * The twenty this platform does not implement are a spec each, and this is
   * where a deployment hands them in. Omitted means they stay unbound, which
   * the boot check says out loud rather than leaving to an agent's first
   * refusal.
   */
  vendorsFile?: string;
  /** F13.7: a model price file. Otherwise `PALUGADA_MODEL_PRICES`. */
  pricesFile?: string;
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  worker?: Partial<WorkerOptions>;
  /**
   * How to start the deployment again with new settings: the process's own
   * loop gives one, and a deployment without it takes settings at its next
   * start.
   */
  restart?: () => void;
  /** Start on the environment alone, as when the settings refused to boot. */
  ignoreSettings?: boolean;
  /** How long `stop()` lets a run in flight finish before it hands its task back. */
  stopGraceMs?: number;
  /**
   * Where the deployment says what happens while it runs. JSON lines on
   * standard error unless a caller -- a test, an embedding -- takes them.
   */
  log?: (entry: Record<string, unknown>) => void;
}

export interface Deployment {
  worker: Worker;
  api: OwnerApi;
  mfa: OwnerMfa;
  /**
   * The broker this deployment built.
   *
   * Handed back rather than kept private, because an assembly that cannot be
   * inspected is an assembly nothing can check -- and the two defects found in
   * this file were both invisible from outside it: platform tools that were
   * never registered, and a broker built without its secret manager.
   */
  broker: CapabilityBroker;
  /**
   * The engine this deployment built, and through it the runtimes.
   *
   * Exposed for the same reason as `broker`: the defects found in this file
   * were all invisible from outside it, and an assembly nothing can inspect is
   * an assembly nothing can check. `deployment.engine.adapters.names()` is the
   * question "can this worker run anything", asked directly.
   */
  engine: Engine;
  url: string;
  /** What was left unconfigured, in the words an operator can act on. */
  notes: string[];
  /**
   * Where the first owner claims this deployment (F12.5, 0094), while it has
   * no owner: printed as it starts, and kept out of `notes`, which the
   * console shows.
   */
  claimUrl: string | null;
  stop(): Promise<void>;
}

/**
 * Builds the notification channels the environment asked for.
 *
 * Empty is a legitimate answer and is reported rather than hidden: a platform
 * that silently has no way to reach its owner looks identical to one whose
 * owner is not being told anything, and only one of those is fine.
 *
 * Each credential can be the value itself, as an operator writes it, or a
 * reference to a secret -- `db://` for one the owner saved in the console --
 * resolved here, once, before the channel exists. One that cannot be opened
 * leaves its channel out and says why, rather than stopping the boot: the
 * console, which is where it is fixed, must come up.
 */
/** The console's MCP servers, as the overlay wrote them; anything unreadable is a note and no servers. */
function mcpSettingsFrom(text: string, notes: string[]): unknown[] {
  try {
    const parsed = JSON.parse(text) as { servers?: unknown };
    if (Array.isArray(parsed.servers)) return parsed.servers;
  } catch {
    // Said below, the same as a document without servers.
  }
  notes.push('PALUGADA_MCP_SETTINGS is not a list of MCP servers; none from the console are bound');
  return [];
}

export async function channelsFrom(
  env: NodeJS.ProcessEnv,
  resolve: (reference: string) => Promise<string> = async (reference) => {
    throw new Error(`${reference} cannot be resolved here`);
  },
): Promise<{ channels: OwnerChannel[]; notes: string[] }> {
  const channels: OwnerChannel[] = [];
  const notes: string[] = [];
  const read = async (plain: string, reference: string): Promise<string | null | undefined> => {
    if (env[plain]) return env[plain];
    const ref = env[reference];
    if (!ref) return null;
    try {
      return await resolve(ref);
    } catch (failure) {
      notes.push(`${reference} ${ref} could not be opened: ${(failure as Error).message}`);
      return undefined;
    }
  };

  const pushToken = await read('PALUGADA_PUSH_TOKEN', 'PALUGADA_PUSH_TOKEN_REF');
  if (env.PALUGADA_PUSH_URL && pushToken !== undefined) {
    const ntfy = env.PALUGADA_PUSH_FORMAT === 'ntfy';
    if (ntfy && !env.PALUGADA_PUSH_TOPIC) {
      notes.push('no push channel: ntfy needs PALUGADA_PUSH_TOPIC, the topic the phone subscribes to (F10.5)');
    } else {
      channels.push(new WebhookPush({
        url: env.PALUGADA_PUSH_URL,
        // ntfy takes an access token as a bearer; a webhook of the owner's
        // own is sent the value as it was given.
        ...(pushToken ? { token: ntfy ? `Bearer ${pushToken}` : pushToken } : {}),
        ...(ntfy ? { body: ntfyBody(env.PALUGADA_PUSH_TOPIC!), name: 'push:ntfy' } : {}),
      }));
    }
  } else if (!env.PALUGADA_PUSH_URL) {
    notes.push('no push channel: set PALUGADA_PUSH_URL (F10.5)');
  }

  const telegramToken = await read('PALUGADA_TELEGRAM_TOKEN', 'PALUGADA_TELEGRAM_TOKEN_REF');
  const webhookSecret = await read('PALUGADA_TELEGRAM_WEBHOOK_SECRET', 'PALUGADA_TELEGRAM_WEBHOOK_SECRET_REF');
  if (telegramToken && env.PALUGADA_TELEGRAM_CHAT) {
    channels.push(new TelegramChannel({
      token: telegramToken,
      chatId: env.PALUGADA_TELEGRAM_CHAT,
      // A card the chat may not apply opens the conversation in the console.
      ...(env.PALUGADA_APP_URL_PUBLIC ? { consoleUrl: env.PALUGADA_APP_URL_PUBLIC } : {}),
      ...(env.PALUGADA_TELEGRAM_API ? { apiBase: env.PALUGADA_TELEGRAM_API } : {}),
      // Without the webhook secret the channel can send but cannot safely be
      // sent to, and `onCallback` refuses every press. Said here so the
      // half-configured case is visible at boot rather than as buttons that
      // do nothing.
      ...(webhookSecret ? { webhookSecret } : {}),
    }));
    if (!webhookSecret) {
      notes.push(
        'telegram can send but not receive: set PALUGADA_TELEGRAM_WEBHOOK_SECRET, '
        + 'or every button press will be refused (F10.9)',
      );
    }
  } else if (telegramToken !== undefined) {
    notes.push(
      'no message channel: set PALUGADA_TELEGRAM_TOKEN and PALUGADA_TELEGRAM_CHAT (F10.9)',
    );
  }

  // WhatsApp through Meta's Cloud API: the business number's id, a system
  // user's token, the app secret that signs deliveries, the verify token the
  // webhook is subscribed with, and the owner's number. Without the secret
  // the channel could not tell Meta from anyone, so it is not made at all.
  const whatsappToken = await read('PALUGADA_WHATSAPP_TOKEN', 'PALUGADA_WHATSAPP_TOKEN_REF');
  const whatsappSecret = await read('PALUGADA_WHATSAPP_APP_SECRET', 'PALUGADA_WHATSAPP_APP_SECRET_REF');
  const whatsappVerify = await read('PALUGADA_WHATSAPP_VERIFY_TOKEN', 'PALUGADA_WHATSAPP_VERIFY_TOKEN_REF');
  if (env.PALUGADA_WHATSAPP_PHONE_ID || whatsappToken) {
    const owner = (env.PALUGADA_WHATSAPP_OWNER ?? '').replace(/[\s+()-]/g, '');
    const template = /^([a-z0-9_]{1,512}):([A-Za-z_]{2,8})$/.exec(env.PALUGADA_WHATSAPP_TEMPLATE ?? '');
    const missing = [
      ...(env.PALUGADA_WHATSAPP_PHONE_ID ? [] : ['PALUGADA_WHATSAPP_PHONE_ID']),
      ...(whatsappToken ? [] : ['PALUGADA_WHATSAPP_TOKEN']),
      ...(whatsappSecret ? [] : ['PALUGADA_WHATSAPP_APP_SECRET']),
      ...(whatsappVerify ? [] : ['PALUGADA_WHATSAPP_VERIFY_TOKEN']),
      ...(/^\d{8,15}$/.test(owner) ? [] : ['PALUGADA_WHATSAPP_OWNER (the owner\'s number with its country code, digits only)']),
    ];
    if (missing.length > 0) {
      notes.push(`no WhatsApp channel: set ${missing.join(', ')} (F10.9)`);
    } else {
      if (env.PALUGADA_WHATSAPP_TEMPLATE && !template) {
        notes.push('PALUGADA_WHATSAPP_TEMPLATE is not name:language (palugada_notice:id); WhatsApp can only answer the owner within a day of their last message');
      }
      channels.push(new WhatsAppChannel({
        phoneNumberId: env.PALUGADA_WHATSAPP_PHONE_ID!,
        token: whatsappToken!,
        appSecret: whatsappSecret!,
        verifyToken: whatsappVerify!,
        owner,
        ...(template ? { template: { name: template[1]!, language: template[2]! } } : {}),
        ...(env.PALUGADA_WHATSAPP_API ? { apiBase: env.PALUGADA_WHATSAPP_API } : {}),
      }));
    }
  }

  for (const kind of ['slack', 'discord'] as const) {
    const upper = kind.toUpperCase();
    const url = await read(`PALUGADA_${upper}_WEBHOOK`, `PALUGADA_${upper}_WEBHOOK_REF`);
    if (url) channels.push(new WebhookChatChannel({ kind, url }));
  }

  // Email, through a sending service: told, never asked (src/owner/email.ts).
  if (env.PALUGADA_EMAIL_PROVIDER || env.PALUGADA_EMAIL_TO) {
    const provider = emailProvider(env.PALUGADA_EMAIL_PROVIDER ?? '');
    const key = await read('PALUGADA_EMAIL_KEY', 'PALUGADA_EMAIL_KEY_REF');
    if (!provider) {
      notes.push(`no email channel: PALUGADA_EMAIL_PROVIDER is ${env.PALUGADA_EMAIL_PROVIDER ?? 'not set'}; it is ${EMAIL_PROVIDERS.map((one) => one.id).join(', ')}`);
    } else if (key === undefined) {
      // Said already, by `read`: the key could not be opened.
    } else if (!key || !emailAddress(env.PALUGADA_EMAIL_FROM ?? '') || !emailAddress(env.PALUGADA_EMAIL_TO ?? '')) {
      notes.push('no email channel: set PALUGADA_EMAIL_KEY (or _REF), and PALUGADA_EMAIL_FROM and PALUGADA_EMAIL_TO as addresses');
    } else {
      channels.push(new EmailChannel({
        provider: provider.id, key, from: env.PALUGADA_EMAIL_FROM!, to: env.PALUGADA_EMAIL_TO!,
        ...(env.PALUGADA_EMAIL_API ? { apiBase: env.PALUGADA_EMAIL_API } : {}),
      }));
    }
  }

  return { channels, notes };
}

/**
 * The Host names the console should answer to, or null to leave it to the
 * bind address. PALUGADA_ALLOWED_HOSTS names them outright; otherwise the
 * public URL, the console origin and the passkey origin, where given, are the
 * names the owner's browser uses. Loopback is always among them: it is the
 * operator on the machine itself and a container's own health check, and no
 * page on another site can make a browser send it -- which is what the list
 * is for. A list without it refused the image's health check, so a healthy
 * deployment was restarted for ever.
 */
function allowedHostsFrom(env: NodeJS.ProcessEnv): string[] | null {
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (env.PALUGADA_ALLOWED_HOSTS) {
    return [...env.PALUGADA_ALLOWED_HOSTS.split(',').map((name) => name.trim()).filter(Boolean), ...loopback];
  }
  const named: string[] = [];
  for (const source of ['PALUGADA_APP_URL_PUBLIC', 'PALUGADA_CONSOLE_ORIGIN', 'PALUGADA_ORIGIN'] as const) {
    const value = env[source];
    if (!value) continue;
    try {
      named.push(new URL(value).hostname);
    } catch {
      throw new PalugadaError('config.invalid', `${source} ${value} is not a URL`, { source });
    }
  }
  return named.length > 0 ? [...named, ...loopback] : null;
}

/**
 * The migrations this code was written against that the database has not
 * run. Code ahead of its schema fails at the first query naming a column the
 * database lacks -- in a task, hours after an upgrade, as a SQL error -- so
 * the boot refuses instead and names the command. A database that is ahead
 * (code rolled back) is let through: the migrations only add.
 */
/**
 * Whether the database answers, as `/api/health` says it to anyone who asks.
 * The driver's own words -- a host, a port, a role's name, why its password
 * was refused -- go to the log, where the operator reads them; the page says
 * only that it could not be reached.
 */
export async function databaseHealth(
  probe: () => Promise<unknown>,
  log: (entry: Record<string, unknown>) => void,
): Promise<'ok' | 'unreachable'> {
  try {
    await probe();
    return 'ok';
  } catch (failure) {
    log({ stage: 'health', message: (failure as Error).message });
    return 'unreachable';
  }
}

/**
 * Whether the worker's loop has gone round lately, as `/api/health` says it.
 *
 * Measured from the later of when the worker started and when it last
 * finished a tick. From the last tick alone, a worker that had never finished
 * one -- a first tick that hung, or failed every time while the database
 * answered `SELECT 1` -- had nothing to measure from and was reported able to
 * work for as long as the process lived.
 */
export function workerHealth(
  worker: { startedAt: Date | null; lastTickAt: Date | null },
  now: number = Date.now(),
): { ok: boolean; lastTickAt: string | null; problem?: string } {
  const { startedAt, lastTickAt } = worker;
  const said = lastTickAt?.toISOString() ?? null;
  const ticked = lastTickAt !== null && (startedAt === null || lastTickAt >= startedAt);
  const since = ticked ? lastTickAt : startedAt;
  if (since === null || now - since.getTime() <= WORKER_STALL_MS) return { ok: true, lastTickAt: said };
  return {
    ok: false,
    lastTickAt: said,
    problem: ticked
      ? `no tick has finished since ${since.toISOString()}`
      : `no tick has finished since the worker started at ${since.toISOString()}`,
  };
}

async function pendingMigrations(): Promise<string[]> {
  const files = (await readdir(fileURLToPath(new URL('../db/migrations', import.meta.url))))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  let applied: Set<string>;
  try {
    const { rows } = await adminPool().query<{ version: string }>('SELECT version FROM schema_migrations');
    applied = new Set(rows.map((row) => row.version));
  } catch (failure) {
    // Never migrated (no table), or migrated before the control plane could
    // read the list (0063): either way, behind.
    const code = (failure as { code?: string }).code;
    if (code !== '42P01' && code !== '42501') throw failure;
    applied = new Set();
  }
  return files.filter((file) => !applied.has(file));
}

export async function start(options: DeploymentOptions = {}): Promise<Deployment> {
  const baseEnv = options.env ?? process.env;
  const notes: string[] = [];

  const pending = await pendingMigrations();
  if (pending.length > 0) {
    throw new PalugadaError('config.invalid',
      `the database is ${pending.length} migration${pending.length === 1 ? '' : 's'} behind this code `
        + `(${pending.length > 3 ? `${pending.slice(0, 3).join(', ')} and ${pending.length - 3} more` : pending.join(', ')}): `
        + 'run `npm run db:migrate`, then start again', { source: 'schema_migrations' });
  }

  // What the owner set in the console, laid over the environment (0065). A
  // setting that would stop the boot is set aside rather than obeyed: the
  // console is where it was made and the only place it can be fixed, so the
  // console has to come up.
  const settingsVersionAtBoot = await settingsVersion();
  let settings = options.ignoreSettings ? {} : await readSettings();
  try {
    modelSettingsFrom(withSettings(baseEnv, settings));
  } catch (failure) {
    notes.push(`the model set in the console was set aside: ${(failure as Error).message}`);
    settings = { ...settings };
    delete settings.model;
  }
  const env = withSettings(baseEnv, settings);
  // What failed, in lines a log collector reads: the worker's stages, and
  // why the health page said the database could not be reached.
  const log = options.log ?? ((entry: Record<string, unknown>) => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  });
  // Traces to the operator's OpenTelemetry collector, when they named one
  // with the standard variables. A protocol this does not speak stops the
  // boot, like any other setting that says something it cannot mean.
  const otlp = otlpFrom(env);
  if (otlp) notes.push(`finished runs go to ${otlp.endpoint} as OpenTelemetry spans, without what was said in them`);

  // The names the console answers to (see `OwnerApiOptions.allowedHosts`).
  // Read first, so a malformed URL is refused before anything is built.
  const allowedHosts = allowedHostsFrom(env);

  // Read when a sealed secret is first needed, and made only when one is
  // first written: a deployment that never uses the console's secrets never
  // has a key file.
  let masterKey: MasterKey | null | undefined;
  const master = (create = false): MasterKey | null => {
    if (masterKey) return masterKey;
    masterKey = masterKeyFrom(env, create);
    return masterKey;
  };

  // The stores every deployment already has: its environment and its mounted
  // secret files -- and the owner's own, sealed in the database, as db://.
  // The in-memory manager this fell back to was empty and forgot everything
  // on restart, so a deployment started from the README had nowhere for a
  // vendor credential or the owner's own factor to live.
  //
  // A key being rotated out is named beside the new one: what it sealed still
  // opens, and is resealed under the new key here, once, as the deployment
  // starts. Nothing the owner typed has to be typed again.
  const previousKeys = previousMasterKeysFrom(env);
  if (previousKeys.length > 0) {
    const current = master(true)!;
    const { resealed, unopened } = await resealSecrets(current, previousKeys);
    notes.push(`resealed ${resealed} secret${resealed === 1 ? '' : 's'} under the master key ${current.id}; `
      + 'remove PALUGADA_MASTER_KEY_PREVIOUS once every process of this deployment has the new key');
    for (const one of unopened) {
      notes.push(`secret db://${one.name} is sealed with the master key ${one.keyId}, which is neither PALUGADA_MASTER_KEY `
        + 'nor one in PALUGADA_MASTER_KEY_PREVIOUS: set it again in the console');
    }
  }
  const secrets = options.secrets ?? new DeploymentSecretManager(new LocalSecretManager({
    env,
    ...(env.PALUGADA_SECRET_DIRS
      ? { directories: env.PALUGADA_SECRET_DIRS.split(':').filter(Boolean) }
      : {}),
  }), () => master(), () => previousKeys);
  // A passkey belongs to the site the owner opens the console at, and the
  // public URL is that site: each of the two defaults to it, and the setting
  // that names one outright wins. Without the public URL, `OwnerMfa`'s own
  // defaults hold, which a real passkey does not match -- closed, not open.
  const published = env.PALUGADA_APP_URL_PUBLIC ? new URL(env.PALUGADA_APP_URL_PUBLIC) : null;
  const rpId = env.PALUGADA_RP_ID || published?.hostname;
  const origin = env.PALUGADA_ORIGIN || published?.origin;
  const mfa = new OwnerMfa({
    secrets,
    ...(rpId ? { rpId } : {}),
    ...(origin ? { origin } : {}),
  });

  // The owner's first factor, from configuration. Signing in to the console
  // takes a code, and enrolling an authenticator took a signed-in console --
  // so a fresh deployment had no way in at all. The operator generates a
  // secret (`npm run totp:new`), puts it where the reference points, and adds
  // it to their authenticator app; boot enrols it once. Whoever sets this
  // process's environment already holds the machine, so this grants nothing
  // they did not have.
  const ownerTotp = env.PALUGADA_OWNER_TOTP_REF;
  if (ownerTotp) {
    try {
      decodeBase32(await secrets.resolve(ownerTotp));
    } catch (failure) {
      throw new PalugadaError(
        'config.invalid',
        `PALUGADA_OWNER_TOTP_REF ${ownerTotp} is not a usable TOTP secret: `
          + (failure as Error).message,
        { source: 'PALUGADA_OWNER_TOTP_REF' },
      );
    }
    // Enrolled once, and never again after the owner revoked it. The
    // reference usually stays in the unit file long after the factor is
    // retired, and a boot that re-enrolled every secret it was pointed at
    // would restore a factor the owner revoked because it leaked.
    const state = await mfa.secretRefState(ownerTotp);
    if (state === 'revoked') {
      notes.push(
        `PALUGADA_OWNER_TOTP_REF ${ownerTotp} backs an authenticator the owner revoked; it is `
          + 'not enrolled again -- generate a new secret with npm run totp:new',
      );
    } else if (state === 'unused') {
      try {
        await mfa.enrolTotp({ label: 'owner (PALUGADA_OWNER_TOTP_REF)', secretRef: ownerTotp });
        notes.push(`enrolled the owner's authenticator from ${ownerTotp}`);
      } catch (failure) {
        // Another replica enrolled it at the same boot, which is the outcome
        // wanted: one live factor for this secret.
        if (!(failure instanceof PalugadaError) || failure.code !== 'mfa.already_enrolled') throw failure;
      }
    }
  }

  // F12.5 as a boot check rather than a discovery. A deployment with no
  // enrolled factor cannot approve anything irreversible, and the moment to
  // learn that is now.
  if ((await mfa.enrolled()).length === 0) {
    notes.push(
      'no authenticator is enrolled: no tier 3 action can be approved until one is (F12.5)',
    );
  }

  // F13.7: the price list, before anything that prices a call. The model
  // client prices each of its calls with it, and the engine estimates the
  // agent CLIs' with it. Read at boot and refused whole when it is wrong, like
  // the vendor file. Without one the fallback applies to every model, and it
  // is set high on purpose -- so the note says so, because an owner reading
  // an estimate should know whether it came from their own list.
  const pricesFile = options.pricesFile ?? env.PALUGADA_MODEL_PRICES ?? null;
  const filePrices = pricesFile ? await loadPriceTable(pricesFile) : DEFAULT_PRICE_TABLE;
  // And what the owner said a model costs in the console (L12), over the file.
  const prices = withConsolePrices(filePrices, env.PALUGADA_MODEL_PRICE_SETTINGS);
  if (env.PALUGADA_MODEL_PRICE_SETTINGS) {
    notes.push(`model prices set in the console: ${Object.keys((JSON.parse(env.PALUGADA_MODEL_PRICE_SETTINGS) as { models: object }).models).join(', ')}`);
  }
  notes.push(
    pricesFile
      ? `model prices from ${pricesFile}: ${prices.rates.length} model pattern(s), `
        + `fallback ${prices.fallback.inputCentsPerMTok}/${prices.fallback.outputCentsPerMTok} cents per MTok`
      : 'no model price list: unpriced usage is estimated at the conservative fallback -- '
        + 'set PALUGADA_MODEL_PRICES (F13.7)',
  );

  // The model the platform runs on: the in-process runtime's, so a role with
  // no handler of its own is run by it, and the drafting, distillation and
  // screening that need one. Every role the standard template creates names
  // the in-process runtime, so a deployment with no model can start a company
  // and run none of its work -- which the note says in so many words.
  const llm = options.llm ?? await modelClientFrom(env, secrets, prices);
  if (!options.llm) {
    const settings = modelSettingsFrom(env);
    notes.push(
      llm && settings
        ? `model: ${settings.provider} at ${settings.url}, roles name a tier and run on `
          + Object.entries(settings.aliases).map(([tier, model]) => `${tier} = ${model}`).join(', ')
        : 'no model: run `npm run setup`, or set PALUGADA_MODEL_KEY_REF (Anthropic), or PALUGADA_MODEL_PROVIDER=openai with '
          + 'PALUGADA_MODEL_URL for any OpenAI-compatible API -- until then no role on the in-process '
          + 'runtime can work, and every role a template creates is on it (F13.1)',
    );
  }
  const draftModel = env.PALUGADA_DRAFT_MODEL ?? 'standard';

  const registry = options.registry ?? new CapabilityRegistry();

  // `memory.search` and `skill.read`, first and unconditionally.
  //
  // Every role's context pack *instructs* the run to call these -- F4.8 for
  // what did not fit in the pack, F15.7 for a skill's full text -- and the
  // standard template grants them to every division that is allowed them. A
  // deployment that did not register them would tell every run to call two
  // tools that answer `capability.unknown`, which is the same defect this
  // repository found once before and is exactly what an assembly file exists
  // to stop happening twice.
  registerPlatformTools(registry);

  const filesRoot = options.filesRoot ?? env.PALUGADA_FILES_ROOT ?? null;
  // Searching and reading pages, through the providers the owner chose.
  const toolBindings = toolBindingsFrom(env, (reference) => secrets.resolve(reference), filesRoot);

  // The five capabilities the platform implements itself. The other twenty
  // the standard template grants need somebody's account, and a control plane
  // does not get to choose which mail provider every company that ever uses it
  // will have.
  const bound = await registerPlatformCapabilities(registry, {
    web: {
      ...(env.PALUGADA_ALLOW_PRIVATE_HOSTS
        ? { allowPrivateHosts: env.PALUGADA_ALLOW_PRIVATE_HOSTS.split(',').map((h) => h.trim()) }
        : {}),
    },
    // Parenthesised: `??` binds tighter than `?:` here only by accident of
    // reading, and a root that silently did not reach the capability would
    // leave `files.list` unbound while the note said otherwise.
    ...(filesRoot ? { files: { root: filesRoot } } : {}),
    ...(llm ? { llm, draftModel } : {}),
    ...(toolBindings.search ? { search: toolBindings.search } : {}),
    ...(toolBindings.extract ? { extract: toolBindings.extract } : {}),
    ...(toolBindings.image ? { image: toolBindings.image } : {}),
    ...(toolBindings.speech ? { speech: toolBindings.speech } : {}),
    ...(toolBindings.listen ? { listen: toolBindings.listen } : {}),
  });
  notes.push(...toolBindings.notes);
  // A search for a role's documents reaches the provider through this: the
  // binding is the deployment's, and the search runs inside a capability.
  useMeaning(toolBindings.embed ?? null);
  if (!filesRoot) {
    notes.push('files.list is unbound: set PALUGADA_FILES_ROOT to the company\'s files (F8)');
  }
  if (!llm) {
    notes.push('doc.draft and email.draft are unbound: no model client was given (F8)');
    // Two more things that need one, and are silent rather than broken
    // without it -- which is the worse failure of the two.
    notes.push(
      'memory is not distilled and skill candidates are not screened: '
      + 'no model client was given (F4.5, F15.3)',
    );
  } else if (!filesRoot) {
    // §8.8 puts a draft at tier 1 because it is a write. A drafting capability
    // with nowhere to write is not the capability the catalogue calibrated.
    notes.push('doc.draft and email.draft are unbound: they need PALUGADA_FILES_ROOT too (F8)');
  }
  notes.push(`bound by the platform: ${[...PLATFORM_CAPABILITIES, ...bound].join(', ')}`);

  // The twenty, from the operator's file.
  //
  // A failure here stops the boot rather than being collected as a note. Every
  // other missing piece leaves a capability unbound, which the catalogue check
  // and the broker both refuse loudly at the moment of use; a *malformed*
  // vendor file is different, because the operator believes they configured
  // it. Starting anyway would produce the exact failure v2 section 2.3
  // records -- a deployment that looks healthy and refuses every send.
  const vendorsFile = options.vendorsFile ?? env.PALUGADA_VENDORS ?? null;
  const vendorNames = vendorsFile
    ? await registerVendorCapabilities(registry, vendorsFile)
    : [];
  if (vendorNames.length > 0) {
    notes.push(`bound by ${vendorsFile}: ${vendorNames.join(', ')}`);
  }
  // The services the owner connected in the console, after the file, so the
  // file keeps a name both bind; one that no longer passes is a note.
  const consoleVendors = bindVendorSettings(registry, env.PALUGADA_VENDOR_SETTINGS, notes);
  if (consoleVendors.length > 0) notes.push(`services connected in the console: ${consoleVendors.join(', ')}`);

  // Tools from MCP servers, only those the file names, each at the tier it
  // states (`src/capabilities/mcp.ts`). Refused at boot like the vendor file
  // when it is wrong; a server that does not answer is a note, and its tools
  // are checked again at every call.
  const mcpFile = env.PALUGADA_MCP_SERVERS ?? null;
  const mcpOptions = {
    resolve: (reference: string) => secrets.resolve(reference),
    // A server signed in to with OAuth whose token has run out: refreshed,
    // and the call made again (`mcp-oauth.ts`).
    refresh: (name: string, since: number) => refreshMcpAccess(name, since, { secrets, master: () => master(false) }),
  };
  if (mcpFile) {
    const mcp = await registerMcpServers(registry, mcpFile, mcpOptions);
    notes.push(`bound from ${mcpFile}: ${mcp.bound.join(', ')}`, ...mcp.notes);
  }
  // The servers the owner added in the console, one at a time: a server that
  // no longer passes -- it rewrote a pinned tool, or its token will not open
  // -- is left out with a note, and the rest start, because the console is
  // the only place the owner can put it right.
  const consoleMcp = env.PALUGADA_MCP_SETTINGS ? mcpSettingsFrom(env.PALUGADA_MCP_SETTINGS, notes) : [];
  const fromConsole: string[] = [];
  for (const server of consoleMcp) {
    const name = String((server as { name?: unknown }).name ?? '?');
    try {
      const mcp = await bindMcpServers(registry, { servers: [server] }, `the MCP server ${name} set in the console`, mcpOptions);
      fromConsole.push(...mcp.bound);
      notes.push(...mcp.notes);
    } catch (failure) {
      notes.push(`the MCP server ${name} set in the console is left out: ${(failure as Error).message.replace(/^the MCP server \S+ set in the console: /, '')}`);
    }
  }
  if (fromConsole.length > 0) notes.push(`bound from the console: ${fromConsole.join(', ')}`);

  // Once, after everything is registered.
  //
  // `registerPlatformCapabilities` syncs at the end of its own work, and the
  // first version of this file relied on that -- so a capability registered
  // afterwards lived in memory and never reached the `capabilities` table.
  // The broker reads that table for the kill switch and the tier, and every
  // grant is a foreign key into it, so a vendor capability that skipped it
  // could not be granted at all: the file would load, the boot note would name
  // it, and nothing would work. Syncing here rather than there means the last
  // registration is the one that decides when to write.
  await registry.sync();

  // What is still unbound, by name. The count on its own has been wrong twice
  // in this repository's history -- both times because something was
  // registered and nothing looked -- so this reads the registry rather than
  // subtracting numbers.
  const unbound = await registry.recordUnbound(STANDARD_CATALOGUE);
  if (unbound.length > 0) {
    notes.push(
      `${unbound.length} catalogued ${unbound.length === 1 ? 'capability needs' : 'capabilities need'} `
      + `a vendor: ${unbound.join(', ')}`
      + ' -- connect them on This deployment, Services'
      + (vendorsFile ? '' : ', or set PALUGADA_VENDORS to a file that binds them'),
    );
  }

  // What a fresh database needs before the owner can start a company: the
  // standard template and the built-in bundles. `src/seed.ts` said it ran on
  // every deploy and only the smoke script called it, so on a fresh install
  // the console's "Start a company" answered "no company template named
  // standard-company". Idempotent, and it leaves a bundle an operator already
  // published -- perhaps signed -- as it is.
  const seeded = await seed({ keepPublished: true });
  notes.push(
    `seeded the standard company template and ${seeded.bundles.length} built-in bundles`
    + (seeded.bundles.length === 0 ? ' (all were already published)' : ''),
  );
  // Said once, on the boot that did it: the operator should know the
  // deployment wrote a charter, and the owner where to change it.
  const charters = seeded.charters.filter((one) => one.version !== null);
  if (charters.length > 0) {
    notes.push(
      `published charters where there were none: ${charters.map((one) => `${one.scope} v${one.version}`).join(', ')}`
      + ' (the owner changes them on Team, Charter)',
    );
  }

  // F3.11: the charters as files, in a git repository beside the state. A
  // file edited there is the next version; anything published is written
  // and committed. Brought level now, on every save in the console, and
  // every minute for what a template or a bundle published.
  const charterRepository = new CharterRepository({
    root: env.PALUGADA_CHARTERS_DIR ?? join(stateDirFrom(env), 'charters'),
  });
  try {
    const synced = await charterRepository.sync();
    notes.push(
      `charters kept in ${charterRepository.root}`
      + (synced.taken.length > 0 ? `; taken from their files: ${synced.taken.map((one) => `${one.path} v${one.version}`).join(', ')}` : '')
      + (synced.unknown.length > 0 ? `; left alone, no such company: ${synced.unknown.join(', ')}` : '')
      + (synced.refused.length > 0 ? `; refused: ${synced.refused.map((one) => `${one.path} (${one.reason})`).join(', ')}` : '')
      + (synced.git === 'not available' ? ' (no git on this machine: the files are kept, without their history)'
        : synced.git.startsWith('failed') || synced.git.startsWith('held') ? ` (git ${synced.git})` : ''),
    );
  } catch (error) {
    notes.push(`charters are not kept as files: ${(error as Error).message} -- set PALUGADA_CHARTERS_DIR to a directory this process may write`);
  }

  const broker = new CapabilityBroker(
    registry,
    undefined,
    // The secret manager, cached. Passing `undefined` here -- which the first
    // version did -- makes `ctx.credential()` throw `credential.unavailable`
    // for every capability that needs one, in the only assembly a deployment
    // actually runs. Cached because F12.3 reads the version on every call, and
    // the cache is what stops that becoming a round trip per tool call while
    // still picking up a rotation within its short life.
    // Less the deployment's own keys -- the sealed ones, and every one its
    // configuration names -- which no division's credential may name.
    // A key signed in for rather than pasted resolves to its access token,
    // renewed before it runs out (`vendor-oauth.ts`).
    new CachedSecretManager(new OAuthCredentials(new DivisionSecrets(secrets, deploymentReferences(env)), {
      deployment: secrets, master: () => master(false),
    })),
    // Row 7: the guardian a company may turn on. With no model it cannot
    // judge, and a guardian that cannot judge sends the call to the owner.
    {
      guardian: new Guardian(llm ?? {
        async complete() { throw new Error('this deployment has no model to judge with'); },
      }),
    },
  );

  // The runtimes, which is the whole of what a worker does.
  //
  // The first version of this file passed the engine neither an adapter
  // registry nor an `llm`/`handlers` pair, so `npm start` booted a worker with
  // an empty registry: every task it checked out halted immediately with
  // `runtime_unavailable`, naming the registered runtimes as "none". The
  // platform's purpose is to run work and the deployment could not run any.
  // Every test builds its own `Engine` with its own handlers, so the assembly
  // was the one caller nobody wrote.
  // Unique per boot, not per PID. Every replica of a container image is
  // usually PID 1, so `worker-${pid}` gave two replicas one identity -- and
  // a shared identity is the one thing a lease cannot survive: each renews
  // the other's claim and both run the task. The engine's own default was
  // already a random id; this line replaced it with a worse one. Host and
  // PID stay in it for a person reading `lease_holder`, and the boot id is
  // what makes it unique (Paperclip keys run ownership on a boot id for the
  // same reason). An operator who sets PALUGADA_WORKER_ID owns its
  // uniqueness. Known before the runtimes, which label what they start with it.
  const workerId = env.PALUGADA_WORKER_ID ?? defaultWorkerId();
  const runtimes = assembleRuntimes({
    env,
    secrets,
    workerId,
    ...(options.adapters ? { registry: options.adapters } : {}),
    ...(llm ? { llm } : {}),
    ...(options.handlers ? { handlers: options.handlers } : {}),
  });
  notes.push(...runtimes.notes);

  // Aborted when `stop()` has waited long enough for a run in flight: the run
  // gives its task back rather than being killed by the supervisor with it.
  const stopping = new AbortController();
  const engine = new Engine({
    broker,
    adapters: runtimes.adapters,
    workerId,
    prices,
    stopping: stopping.signal,
  });

  const { channels, notes: channelNotes } = await channelsFrom(env, (reference) => secrets.resolve(reference));
  notes.push(...channelNotes);

  // The worker stops by an abort signal rather than a method, which is what
  // lets one `stop()` here reach both halves.
  const shutdown = new AbortController();
  const scrapeToken = metricsToken(env.PALUGADA_METRICS_TOKEN);
  const worker = new Worker({
    engine,
    signal: shutdown.signal,
    concurrency: workerConcurrency(env.PALUGADA_WORKER_CONCURRENCY),
    ownerChannels: channels,
    // F4.5 and F15.3 need a model. The same one the drafting capabilities use,
    // because a deployment that configured one meant it for the platform's own
    // work; without it the worker never distils and never screens, which the
    // note below says out loud.
    ...(llm ? { learning: { llm, model: draftModel } } : {}),
    // The documents' meaning, from the provider chosen under Tools.
    ...(toolBindings.embed ? { meaning: toolBindings.embed } : {}),
    // What failed, in lines a log collector reads. A worker whose stage
    // failures went only into a report nobody read looked, from outside,
    // exactly like one with nothing to do.
    log,
    // What a company keeps outside its rows, so an erasure removes that
    // too (0096): its directory in the files root, its charter's folder.
    erasure: { filesRoot, charters: charterRepository },
    ...(otlp ? { telemetry: new OtlpExporter({ ...otlp, holder: workerId }) } : {}),
    ...(env.PALUGADA_APP_URL_PUBLIC
      ? {
        ownerLinkFor: (item) => consoleLinkFor(env.PALUGADA_APP_URL_PUBLIC!, item),
        ownerTaskLinkFor: (task) => consoleTaskLinkFor(env.PALUGADA_APP_URL_PUBLIC!, task),
      }
      : {}),
    ...options.worker,
  });

  // F10.9's inbound half. The channel sent buttons and nothing received the
  // presses: no route called it, so every button in every message did
  // nothing at all.
  const telegram = channels.find((channel): channel is TelegramChannel =>
    channel instanceof TelegramChannel);
  const whatsapp = channels.find((channel): channel is WhatsAppChannel =>
    channel instanceof WhatsAppChannel);

  const bindHost = options.host ?? env.PALUGADA_HOST ?? '127.0.0.1';
  // The console is a built page. A deployment started from a fresh checkout
  // serves the API and a 404 where the page should be, and says why here
  // rather than leaving the owner to guess from a blank tab.
  if (options.consoleRoot && !existsSync(join(options.consoleRoot, 'index.html'))) {
    notes.push(`the console is not built: run \`npm run console:build\` (looked in ${options.consoleRoot})`);
  }
  if (!allowedHosts && ['0.0.0.0', '::', '[::]'].includes(bindHost)) {
    notes.push(
      'the console listens on every interface and answers to any Host: set '
        + 'PALUGADA_ALLOWED_HOSTS or PALUGADA_APP_URL_PUBLIC to the names it is reached by',
    );
  }

  const api = new OwnerApi({
    mfa,
    charters: charterRepository,
    // The registry and the resolver, so F12.3's rotation can sweep the
    // division afterwards. Without both, a rotation through the console still
    // works and simply does not re-check -- which is better than a sweep that
    // cannot resolve the new value, reports every credentialed capability
    // unhealthy, and halts the next task that needs one.
    registry,
    credentialFor: (companyId, divisionId) => broker.credentialFor(companyId, divisionId),
    // The file's prices, which the console's are laid over as the owner saves them.
    prices: filePrices,
    // The same store, for the signing secrets of triggers the sender signs.
    secrets,
    // The same handlers the in-process runtime executes, so F11.4 replays the
    // work this deployment actually did rather than a fixture.
    ...(options.handlers ? { replayHandlers: options.handlers } : {}),
    ...(options.consoleRoot ? { staticRoot: options.consoleRoot } : {}),
    ...(env.PALUGADA_CONSOLE_ORIGIN ? { origin: env.PALUGADA_CONSOLE_ORIGIN } : {}),
    ...(telegram ? { telegram } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(env.PALUGADA_BEHIND_PROXY === '1' || env.PALUGADA_BEHIND_PROXY === 'true' ? { behindProxy: true } : {}),
    // The same list the process prints, held by reference: notes added
    // after this point are still the deployment's, and still the owner's to see.
    deploymentNotes: notes,
    runtimes: runtimes.adapters,
    // The owner's assistant thinks with the deployment's own model; with none
    // chosen yet, it says so and points at where to choose one.
    assistant: { llm: llm && usesTools(llm) ? llm : null, voice: toolBindings.voice },
    deploymentSettings: {
      baseEnv,
      env,
      settings,
      master,
      secrets,
      ...(options.restart ? { restart: options.restart } : {}),
    },
    // Whether this process can work: the database answers, and the worker's
    // loop has gone round lately. A process that is up and whose loop has
    // stopped is the failure a supervisor cannot see from outside.
    health: async () => {
      const database = await databaseHealth(() => appPool().query('SELECT 1'), log);
      const { ok, ...said } = workerHealth(worker);
      return { ok: database === 'ok' && ok, database, version: VERSION, worker: said };
    },
    ...(scrapeToken ? { metrics: { token: scrapeToken, text: () => metricsText({ worker }) } } : {}),
  });
  const { url } = await api.listen(options.port ?? Number(env.PALUGADA_PORT ?? 8787), bindHost);

  // No owner yet, and no secret in the environment to enrol: a link that
  // makes whoever opens it first the owner (src/owner/claim.ts). Its reader
  // holds this machine's log, and so the machine already.
  const claimCode = await openOwnerClaim();
  const claimBase = published?.origin ?? url.replace(/\/\/(0\.0\.0\.0|\[::\]|::)(?=:)/, '//localhost');
  const claimUrl = claimCode ? `${claimBase}/#/claim/${claimCode}` : null;

  // Started last, so a console that failed to bind does not leave a worker
  // running with nobody able to stop it.
  const running = worker.start();

  // Settings changed on another replica: this one is running on the old ones
  // until it starts again, so it does. Checked every half minute, which is as
  // stale as a replica's settings can get.
  const watching = options.restart
    ? setInterval(() => {
      void settingsVersion().then((now) => {
        if (now !== settingsVersionAtBoot) options.restart!();
      }, () => undefined);
    }, SETTINGS_POLL_MS)
    : null;
  watching?.unref();
  const keepingCharters = setInterval(() => void charterRepository.sync().catch(() => undefined), CHARTER_SYNC_MS);
  keepingCharters.unref();

  return {
    worker,
    api,
    mfa,
    broker,
    engine,
    url,
    notes,
    claimUrl,
    async stop() {
      if (watching) clearInterval(watching);
      clearInterval(keepingCharters);
      // The console first: a worker still ticking while the owner can no
      // longer reach it is the one order that has a bad minute in it.
      await api.close();
      shutdown.abort();
      // A run in flight gets a moment to finish, and then gives its task back
      // -- well inside the minute a supervisor waits before it kills (the
      // systemd unit's TimeoutStopSec, compose's stop_grace_period). Killed
      // instead, its lease lapsed and the reclaim counted towards `crash_loop`,
      // so three upgrades during one long task halted it.
      const graceMs = options.stopGraceMs ?? STOP_GRACE_MS;
      const grace = setTimeout(() => stopping.abort(), graceMs);
      // An answer the owner is waiting for in a chat gets the same moment:
      // their message is already in the conversation, and stopped halfway
      // they would have asked and heard nothing.
      let answered: NodeJS.Timeout | undefined;
      const graceOver = new Promise<void>((resolve) => { answered = setTimeout(resolve, graceMs); });
      try {
        await Promise.all([
          running,
          ...[telegram, whatsapp].map((chat) => (chat ? Promise.race([chat.settled(), graceOver]) : undefined)),
          // A charter sync halfway through its files would leave the record
          // of what it wrote behind them.
          Promise.race([charterRepository.settled(), graceOver]),
        ]);
      } finally {
        clearTimeout(grace);
        clearTimeout(answered);
      }
      // Last, once no run can open another: a server holding a session for
      // a task -- a browser, say -- is told it is over.
      await closeMcpSessions();
    },
  };
}

/** How often a replica looks for settings changed elsewhere. */
const SETTINGS_POLL_MS = 30_000;

/** How often the charter repository is brought level with the database (F3.11). */
const CHARTER_SYNC_MS = 60_000;

/** Twenty seconds: most steps finish in that, and it leaves forty before a supervisor's kill. */
const STOP_GRACE_MS = 20_000;

/** `host-pid-bootid`: readable, and unique across replicas and restarts. */
export function defaultWorkerId(): string {
  return `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/* ------------------------------------------------------------ the process --- */

/**
 * What `npm start` runs.
 *
 * `package.json` has said `node src/main.ts` since the deployment file was
 * written, the README says it serves the worker and the console on :8787 --
 * and this module exported `start()` and called nothing. Every test calls
 * `start()` itself and the smoke check builds its own assembly, so the one
 * caller nobody wrote was the process: `npm start` loaded the module and
 * exited 0. The sixth time this repository has found machinery that works,
 * is tested, and is assembled by nobody -- and the first time the nobody was
 * the entry point.
 *
 * **A configuration error exits 78** (`EX_CONFIG`, sysexits.h), everything
 * else 1. A supervisor restarting a process whose vendor file is malformed
 * restarts it into the same refusal for ever; auto-company's daemon units
 * stop that with `RestartPreventExitStatus=78`, and
 * `deploy/palugada.service` does the same. SIGTERM and SIGINT stop the
 * deployment the way `stop()` does -- the console first, then the worker --
 * so a restart does not abandon a run half-journalled.
 */
export const EXIT_CONFIG = 78;

export async function runFromCommandLine(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let deployment: Deployment;
  let stopping = false;
  // The signals are listened for before anything starts. They were listened
  // for after "console at" was printed, and a supervisor -- or a test --
  // that stops the process as soon as it says it is ready could land its
  // SIGTERM between the two lines: nothing was listening, so the default
  // killed the process with the worker running and nothing handed back. One
  // that arrives while it starts is kept, and stops it once it has.
  let signalled: NodeJS.Signals | null = null;
  let onSignal = (signal: NodeJS.Signals) => { signalled ??= signal; };
  const listener = (signal: NodeJS.Signals) => onSignal(signal);
  process.once('SIGTERM', listener);
  process.once('SIGINT', listener);
  process.stdout.write('palugada: starting\n');
  // One restart at a time, and none once the process is stopping: a restart
  // is a stop and a start, and two interleaved would start two deployments.
  let restarting: Promise<void> | null = null;
  const boot = (): Promise<Deployment> => start({
    env,
    consoleRoot: fileURLToPath(new URL('../console/dist', import.meta.url)),
    restart: () => { void restart(); },
  });
  const announce = (started: Deployment) => {
    for (const note of started.notes) process.stdout.write(`palugada: ${note}\n`);
    process.stdout.write(`palugada: console at ${started.url}\n`);
    if (started.claimUrl) {
      process.stdout.write(`palugada: no owner yet: open ${started.claimUrl} within a day to add your `
        + 'authenticator app and become the owner; a new link is printed at each start until then\n');
    }
  };
  const restart = async (): Promise<void> => {
    if (stopping || restarting) return restarting ?? undefined;
    restarting = (async () => {
      process.stdout.write('palugada: settings changed, starting again\n');
      await deployment.stop();
      deployment = await boot();
      announce(deployment);
    })().catch((failure: unknown) => {
      // The console must come back, or nothing can undo what stopped it.
      process.stderr.write(`palugada: could not start again: ${(failure as Error).message}\n`);
      process.exit(1);
    }).finally(() => { restarting = null; });
    return restarting;
  };

  try {
    deployment = await boot();
  } catch (failure) {
    process.off('SIGTERM', listener);
    process.off('SIGINT', listener);
    const configuration = failure instanceof PalugadaError && failure.code === 'config.invalid';
    process.stderr.write(
      `palugada: ${configuration ? 'configuration refused' : 'failed to start'}: `
        + `${(failure as Error).message}\n`,
    );
    return configuration ? EXIT_CONFIG : 1;
  }
  announce(deployment);

  return new Promise<number>((resolveExit) => {
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`palugada: ${signal}, stopping\n`);
      Promise.resolve(restarting).then(() => deployment.stop()).then(
        () => resolveExit(0),
        (failure: unknown) => {
          process.stderr.write(`palugada: stop failed: ${(failure as Error).message}\n`);
          resolveExit(1);
        },
      );
    };
    onSignal = stop;
    if (signalled) stop(signalled);
  });
}

// Run only when this file is the program, not when a test imports `start`.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The schema owner's URL is for `npm run db:migrate`. `npm start` reads the
  // same `.env`, which setup writes with all three URLs, so the running
  // platform held the one role that can alter its tables and empty them.
  // Nothing here uses it, and nothing here should be able to; the image and
  // the systemd unit leave it out of the environment already.
  delete process.env.PALUGADA_OWNER_URL;
  runFromCommandLine().then(async (code) => {
    await closePools().catch(() => undefined);
    process.exit(code);
  });
}
