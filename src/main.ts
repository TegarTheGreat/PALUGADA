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
import { Worker, type WorkerOptions } from './worker.ts';
import { InMemorySecretManager, type SecretManager } from './secrets/manager.ts';
import { OwnerMfa } from './owner/mfa.ts';
import { OwnerApi } from './owner/api.ts';
import { WebhookPush } from './owner/push.ts';
import { TelegramChannel } from './owner/telegram.ts';
import type { OwnerChannel } from './owner/notify.ts';
import { AdapterRegistry } from './runtime/protocol.ts';
import { registerPlatformCapabilities } from './capabilities/platform.ts';
import { registerPlatformCapabilities as registerPlatformTools, PLATFORM_CAPABILITIES }
  from './broker/platform-capabilities.ts';
import { CachedSecretManager } from './secrets/rotation.ts';
import type { LlmClient } from './llm/client.ts';

export interface DeploymentOptions {
  /** Where the secrets actually live. The in-memory one is for a test. */
  secrets?: SecretManager;
  /** Extra adapters and capabilities a deployment binds for itself. */
  adapters?: AdapterRegistry;
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
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  worker?: Partial<WorkerOptions>;
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
  url: string;
  /** What was left unconfigured, in the words an operator can act on. */
  notes: string[];
  stop(): Promise<void>;
}

/**
 * Builds the notification channels the environment asked for.
 *
 * Empty is a legitimate answer and is reported rather than hidden: a platform
 * that silently has no way to reach its owner looks identical to one whose
 * owner is not being told anything, and only one of those is fine.
 */
export function channelsFrom(env: NodeJS.ProcessEnv): {
  channels: OwnerChannel[];
  notes: string[];
} {
  const channels: OwnerChannel[] = [];
  const notes: string[] = [];

  if (env.PALUGADA_PUSH_URL) {
    channels.push(new WebhookPush({
      url: env.PALUGADA_PUSH_URL,
      ...(env.PALUGADA_PUSH_TOKEN ? { token: env.PALUGADA_PUSH_TOKEN } : {}),
    }));
  } else {
    notes.push('no push channel: set PALUGADA_PUSH_URL (F10.5)');
  }

  if (env.PALUGADA_TELEGRAM_TOKEN && env.PALUGADA_TELEGRAM_CHAT) {
    channels.push(new TelegramChannel({
      token: env.PALUGADA_TELEGRAM_TOKEN,
      chatId: env.PALUGADA_TELEGRAM_CHAT,
      // Without the webhook secret the channel can send but cannot safely be
      // sent to, and `onCallback` refuses every press. Said here so the
      // half-configured case is visible at boot rather than as buttons that
      // do nothing.
      ...(env.PALUGADA_TELEGRAM_WEBHOOK_SECRET
        ? { webhookSecret: env.PALUGADA_TELEGRAM_WEBHOOK_SECRET }
        : {}),
    }));
    if (!env.PALUGADA_TELEGRAM_WEBHOOK_SECRET) {
      notes.push(
        'telegram can send but not receive: set PALUGADA_TELEGRAM_WEBHOOK_SECRET, '
        + 'or every button press will be refused (F10.9)',
      );
    }
  } else {
    notes.push(
      'no message channel: set PALUGADA_TELEGRAM_TOKEN and PALUGADA_TELEGRAM_CHAT (F10.9)',
    );
  }

  return { channels, notes };
}

export async function start(options: DeploymentOptions = {}): Promise<Deployment> {
  const env = options.env ?? process.env;
  const notes: string[] = [];

  const secrets = options.secrets ?? new InMemorySecretManager();
  const mfa = new OwnerMfa({
    secrets,
    ...(env.PALUGADA_RP_ID ? { rpId: env.PALUGADA_RP_ID } : {}),
    ...(env.PALUGADA_ORIGIN ? { origin: env.PALUGADA_ORIGIN } : {}),
  });

  // F12.5 as a boot check rather than a discovery. A deployment with no
  // enrolled factor cannot approve anything irreversible, and the moment to
  // learn that is now.
  if ((await mfa.enrolled()).length === 0) {
    notes.push(
      'no authenticator is enrolled: no tier 3 action can be approved until one is (F12.5)',
    );
  }

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
    ...(options.llm ? { llm: options.llm } : {}),
    ...(env.PALUGADA_DRAFT_MODEL ? { draftModel: env.PALUGADA_DRAFT_MODEL } : {}),
  });
  if (!filesRoot) {
    notes.push('files.list is unbound: set PALUGADA_FILES_ROOT to the company\'s files (F8)');
  }
  if (!options.llm) {
    notes.push('doc.draft and email.draft are unbound: no model client was given (F8)');
  } else if (!filesRoot) {
    // §8.8 puts a draft at tier 1 because it is a write. A drafting capability
    // with nowhere to write is not the capability the catalogue calibrated.
    notes.push('doc.draft and email.draft are unbound: they need PALUGADA_FILES_ROOT too (F8)');
  }
  notes.push(`bound by the platform: ${[...PLATFORM_CAPABILITIES, ...bound].join(', ')}`);

  const broker = new CapabilityBroker(
    registry,
    undefined,
    // The secret manager, cached. Passing `undefined` here -- which the first
    // version did -- makes `ctx.credential()` throw `credential.unavailable`
    // for every capability that needs one, in the only assembly a deployment
    // actually runs. Cached because F12.3 reads the version on every call, and
    // the cache is what stops that becoming a round trip per tool call while
    // still picking up a rotation within its short life.
    new CachedSecretManager(secrets),
  );

  const engine = new Engine({
    broker,
    ...(options.adapters ? { adapters: options.adapters } : {}),
    workerId: env.PALUGADA_WORKER_ID ?? `worker-${process.pid}`,
  });

  const { channels, notes: channelNotes } = channelsFrom(env);
  notes.push(...channelNotes);

  // The worker stops by an abort signal rather than a method, which is what
  // lets one `stop()` here reach both halves.
  const shutdown = new AbortController();
  const worker = new Worker({
    engine,
    signal: shutdown.signal,
    ownerChannels: channels,
    ...(env.PALUGADA_APP_URL_PUBLIC
      ? { ownerLinkFor: (item) => `${env.PALUGADA_APP_URL_PUBLIC}/i/${item.id}` }
      : {}),
    ...options.worker,
  });

  const api = new OwnerApi({
    mfa,
    ...(options.consoleRoot ? { staticRoot: options.consoleRoot } : {}),
    ...(env.PALUGADA_CONSOLE_ORIGIN ? { origin: env.PALUGADA_CONSOLE_ORIGIN } : {}),
  });
  const { url } = await api.listen(
    options.port ?? Number(env.PALUGADA_PORT ?? 8787),
    options.host ?? env.PALUGADA_HOST ?? '127.0.0.1',
  );

  // Started last, so a console that failed to bind does not leave a worker
  // running with nobody able to stop it.
  const running = worker.start();

  return {
    worker,
    api,
    mfa,
    broker,
    url,
    notes,
    async stop() {
      // The console first: a worker still ticking while the owner can no
      // longer reach it is the one order that has a bad minute in it.
      await api.close();
      shutdown.abort();
      await running;
    },
  };
}
