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
import { DEFAULT_PRICE_TABLE, loadPriceTable } from './engine/pricing.ts';
import { modelAliasesFrom, modelClientFrom } from './llm/anthropic.ts';
import { Worker, type WorkerOptions } from './worker.ts';
import type { SecretManager } from './secrets/manager.ts';
import { OwnerMfa, decodeBase32 } from './owner/mfa.ts';
import { LocalSecretManager } from './secrets/local.ts';
import { PalugadaError } from './errors.ts';
import { OwnerApi } from './owner/api.ts';
import { WebhookPush } from './owner/push.ts';
import { TelegramChannel } from './owner/telegram.ts';
import type { OwnerChannel } from './owner/notify.ts';
import { AdapterRegistry } from './runtime/protocol.ts';
import { assembleRuntimes } from './runtime/assemble.ts';
import type { TaskHandler } from './runtime/in-process.ts';
import { registerPlatformCapabilities } from './capabilities/platform.ts';
import { registerVendorCapabilities } from './capabilities/vendors.ts';
import { STANDARD_CATALOGUE } from './broker/catalogue.ts';
import { seed } from './seed.ts';
import { registerPlatformCapabilities as registerPlatformTools, PLATFORM_CAPABILITIES }
  from './broker/platform-capabilities.ts';
import { CachedSecretManager } from './secrets/rotation.ts';
import type { LlmClient } from './llm/client.ts';
import { closePools } from './db/pool.ts';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { consoleLinkFor, consoleTaskLinkFor } from './owner/notify.ts';

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

/**
 * The Host names the console should answer to, or null to leave it to the
 * bind address. PALUGADA_ALLOWED_HOSTS names them outright; otherwise the
 * public URL, the console origin and the passkey origin, where given, are the
 * names the owner's browser uses -- plus loopback, for the operator on the
 * machine itself.
 */
function allowedHostsFrom(env: NodeJS.ProcessEnv): string[] | null {
  if (env.PALUGADA_ALLOWED_HOSTS) {
    return env.PALUGADA_ALLOWED_HOSTS.split(',').map((name) => name.trim()).filter(Boolean);
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
  return named.length > 0 ? [...named, '127.0.0.1', 'localhost', '[::1]'] : null;
}

export async function start(options: DeploymentOptions = {}): Promise<Deployment> {
  const env = options.env ?? process.env;
  const notes: string[] = [];

  // The names the console answers to (see `OwnerApiOptions.allowedHosts`).
  // Read first, so a malformed URL is refused before anything is built.
  const allowedHosts = allowedHostsFrom(env);

  // The stores every deployment already has: its environment and its mounted
  // secret files. The in-memory manager this fell back to was empty and
  // forgot everything on restart, so a deployment started from the README had
  // nowhere for a vendor credential or the owner's own factor to live.
  const secrets = options.secrets ?? new LocalSecretManager({
    env,
    ...(env.PALUGADA_SECRET_DIRS
      ? { directories: env.PALUGADA_SECRET_DIRS.split(':').filter(Boolean) }
      : {}),
  });
  const mfa = new OwnerMfa({
    secrets,
    ...(env.PALUGADA_RP_ID ? { rpId: env.PALUGADA_RP_ID } : {}),
    ...(env.PALUGADA_ORIGIN ? { origin: env.PALUGADA_ORIGIN } : {}),
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
  const prices = pricesFile ? await loadPriceTable(pricesFile) : DEFAULT_PRICE_TABLE;
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
    notes.push(
      llm
        ? `model: ${env.PALUGADA_MODEL_URL ?? 'https://api.anthropic.com'}, roles name a tier and run on `
          + Object.entries(modelAliasesFrom(env.PALUGADA_MODEL_ALIASES)).map(([tier, model]) => `${tier} = ${model}`).join(', ')
        : 'no model: set PALUGADA_MODEL_KEY_REF to a model API key -- until then no role on the in-process '
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
  });
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
      + (vendorsFile ? '' : ' -- set PALUGADA_VENDORS to a file that binds them'),
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

  // The runtimes, which is the whole of what a worker does.
  //
  // The first version of this file passed the engine neither an adapter
  // registry nor an `llm`/`handlers` pair, so `npm start` booted a worker with
  // an empty registry: every task it checked out halted immediately with
  // `runtime_unavailable`, naming the registered runtimes as "none". The
  // platform's purpose is to run work and the deployment could not run any.
  // Every test builds its own `Engine` with its own handlers, so the assembly
  // was the one caller nobody wrote.
  const runtimes = assembleRuntimes({
    env,
    ...(options.adapters ? { registry: options.adapters } : {}),
    ...(llm ? { llm } : {}),
    ...(options.handlers ? { handlers: options.handlers } : {}),
  });
  notes.push(...runtimes.notes);

  const engine = new Engine({
    broker,
    adapters: runtimes.adapters,
    // Unique per boot, not per PID. Every replica of a container image is
    // usually PID 1, so `worker-${pid}` gave two replicas one identity -- and
    // a shared identity is the one thing a lease cannot survive: each renews
    // the other's claim and both run the task. The engine's own default was
    // already a random id; this line replaced it with a worse one. Host and
    // PID stay in it for a person reading `lease_holder`, and the boot id is
    // what makes it unique (Paperclip keys run ownership on a boot id for the
    // same reason). An operator who sets PALUGADA_WORKER_ID owns its
    // uniqueness.
    workerId: env.PALUGADA_WORKER_ID ?? defaultWorkerId(),
    prices,
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
    // F4.5 and F15.3 need a model. The same one the drafting capabilities use,
    // because a deployment that configured one meant it for the platform's own
    // work; without it the worker never distils and never screens, which the
    // note below says out loud.
    ...(llm ? { learning: { llm, model: draftModel } } : {}),
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
    // The registry and the resolver, so F12.3's rotation can sweep the
    // division afterwards. Without both, a rotation through the console still
    // works and simply does not re-check -- which is better than a sweep that
    // cannot resolve the new value, reports every credentialed capability
    // unhealthy, and halts the next task that needs one.
    registry,
    credentialFor: (companyId, divisionId) => broker.credentialFor(companyId, divisionId),
    // The same store, for the signing secrets of triggers the sender signs.
    secrets,
    // The same handlers the in-process runtime executes, so F11.4 replays the
    // work this deployment actually did rather than a fixture.
    ...(options.handlers ? { replayHandlers: options.handlers } : {}),
    ...(options.consoleRoot ? { staticRoot: options.consoleRoot } : {}),
    ...(env.PALUGADA_CONSOLE_ORIGIN ? { origin: env.PALUGADA_CONSOLE_ORIGIN } : {}),
    ...(telegram ? { telegram } : {}),
    ...(allowedHosts ? { allowedHosts } : {}),
    // The same list the process prints, held by reference: notes added
    // after this point are still the deployment's, and still the owner's to see.
    deploymentNotes: notes,
    runtimes: runtimes.adapters,
  });
  const { url } = await api.listen(options.port ?? Number(env.PALUGADA_PORT ?? 8787), bindHost);

  // Started last, so a console that failed to bind does not leave a worker
  // running with nobody able to stop it.
  const running = worker.start();

  return {
    worker,
    api,
    mfa,
    broker,
    engine,
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
  try {
    deployment = await start({
      env,
      consoleRoot: fileURLToPath(new URL('../console/dist', import.meta.url)),
    });
  } catch (failure) {
    const configuration = failure instanceof PalugadaError && failure.code === 'config.invalid';
    process.stderr.write(
      `palugada: ${configuration ? 'configuration refused' : 'failed to start'}: `
        + `${(failure as Error).message}\n`,
    );
    return configuration ? EXIT_CONFIG : 1;
  }

  for (const note of deployment.notes) process.stdout.write(`palugada: ${note}\n`);
  process.stdout.write(`palugada: console at ${deployment.url}\n`);

  return new Promise<number>((resolveExit) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`palugada: ${signal}, stopping\n`);
      deployment.stop().then(
        () => resolveExit(0),
        (failure: unknown) => {
          process.stderr.write(`palugada: stop failed: ${(failure as Error).message}\n`);
          resolveExit(1);
        },
      );
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

// Run only when this file is the program, not when a test imports `start`.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFromCommandLine().then(async (code) => {
    await closePools().catch(() => undefined);
    process.exit(code);
  });
}
