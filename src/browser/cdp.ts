/**
 * Chromium, driven over its DevTools protocol on a pipe.
 *
 * A pipe rather than a port: `--remote-debugging-port` listens on loopback,
 * where every process on the machine -- an agent CLI among them -- could
 * connect and drive every company's signed-in browser past the broker.
 * `--remote-debugging-pipe` speaks on two file descriptors only the process
 * that started it holds. The protocol is JSON, one message after another,
 * each ended by a NUL; written here, like the platform's other transports,
 * rather than taken from a library for what is a few dozen lines.
 *
 * Chromium is told to keep to itself. Its own background calls -- updates,
 * suggestions, Google's services -- would go out through each company's
 * proxy as if the company made them, so they are switched off; it resolves
 * no name itself, so every name goes through the proxy's checks
 * (`egress.ts`); and WebRTC may not send what the proxy would not carry.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { PalugadaError } from '../errors.ts';

/** The switches every launch has, and why each, beside it. */
const QUIET = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  // Nothing of Chromium's own goes out: updates, sync, reports, suggestions.
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
  '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-breakpad',
  '--disable-client-side-phishing-detection', '--disable-domain-reliability', '--no-pings', '--metrics-recording-only',
  '--disable-field-trial-config', '--no-service-autorun', '--disable-search-engine-choice-screen',
  '--safebrowsing-disable-auto-update', '--dns-prefetch-disable',
  // Each was seen asking a Google service for something as a context opened
  // or a page loaded, until switched off; the last three are Chromium 141's
  // check of whether its AI search mode is offered, at every new profile.
  `--disable-features=${[
    'OptimizationHints', 'OptimizationHintsFetching', 'OptimizationGuideModelDownloading', 'MediaRouter', 'Translate',
    'AutofillServerCommunication', 'PreconnectToSearch', 'NavigationPredictor', 'Prerender2', 'LoadingPredictorUseLocalPredictions',
    'SpeculationRulesPrefetchProxy', 'PrefetchProxy', 'LoadingPredictorPrefetch', 'InterestFeedContentSuggestions',
    'CertificateTransparencyComponentUpdater', 'PrivacySandboxSettings4', 'SafeBrowsingRealTimeUrlLookup',
    'ZeroSuggestPrefetching', 'OmniboxZeroSuggestPrefetching', 'AiModeOmniboxEntryPoint', 'AimServerEligibilityEnabled',
    'AimServerRequestOnStartupEnabled', 'AimOmniboxEntrypointEnabled',
  ].join(',')}`,
  // No keyring is asked for: the cookies are kept by the platform, sealed.
  '--password-store=basic', '--use-mock-keychain',
  // Every name is resolved by the proxy and checked there; the proxy's own
  // address is the one Chromium connects to itself.
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  // A page may not open windows of its own; a link that asks for a new tab
  // is followed in the same one (`page.ts`).
  '--block-new-web-contents',
];

/** How long one command may take before it is given up. */
const COMMAND_MS = 30_000;

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export class Cdp {
  readonly #process: ChildProcess;
  readonly #write: Writable;
  readonly #profile: string;
  #buffer: Buffer = Buffer.alloc(0);
  #sent = 0;
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #closed: Error | null = null;
  #said = '';

  private constructor(process_: ChildProcess, profile: string) {
    this.#process = process_;
    this.#profile = profile;
    this.#write = process_.stdio[3] as Writable;
    const read = process_.stdio[4] as Readable;
    read.on('data', (chunk: Buffer) => this.#receive(chunk));
    this.#write.on('error', () => undefined);
    // What it says on the way out is kept for the reason it gives.
    (process_.stderr as Readable).on('data', (chunk: Buffer) => { this.#said = `${this.#said}${chunk.toString('utf8')}`.slice(-4_000); });
    process_.once('exit', (code, signal) => {
      this.#closed ??= new PalugadaError('capability.unreachable',
        `the browser stopped (${signal ?? `exit ${code}`})${this.#lastWords() ? `: ${this.#lastWords()}` : ''}`, {});
      for (const waiting of this.#waiting.values()) waiting.reject(this.#closed);
      this.#waiting.clear();
      this.#emit('closed', {}, undefined);
      void rm(this.#profile, { recursive: true, force: true }).catch(() => undefined);
    });
  }

  /** The last thing Chromium wrote that reads as a reason, without its log prefixes. */
  #lastWords(): string {
    const lines = this.#said.split('\n').map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean);
    return (lines.find((line) => /sandbox|error|cannot|failed/i.test(line)) ?? lines.at(-1) ?? '').slice(0, 300);
  }

  /** Starts Chromium and waits until it answers; refuses, with its reason, one that does not. */
  static async launch(executable: string, options: { sandbox: boolean }): Promise<Cdp> {
    const profile = await mkdtemp(join(tmpdir(), 'palugada-browser-'));
    const args = [...QUIET, `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'];
    // Chromium's sandbox keeps a page that broke out of its renderer inside
    // it. Off only where it cannot start -- as root, or in a container
    // without user namespaces -- and only because the deployment said so.
    if (!options.sandbox) args.unshift('--no-sandbox');
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const started = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (error) => resolve(error));
    });
    if (started) {
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      throw new PalugadaError('capability.unreachable', `the browser at ${executable} could not be started: ${started.message}`, { executable });
    }
    const cdp = new Cdp(child, profile);
    try {
      await cdp.send('Browser.getVersion', {}, undefined, 15_000);
    } catch (failure) {
      await cdp.close();
      // Chromium's own first sentence, and what to do about it here.
      const said = cdp.#lastWords().split(/(?<=[.!])\s/)[0] ?? '';
      const remedy = /as root/i.test(said)
        ? 'Chromium will not sandbox itself as root: run the platform as another user, or set PALUGADA_BROWSER_SANDBOX=off where that is understood'
        : /sandbox/i.test(said)
          ? 'Its sandbox needs user namespaces: in a container, give it deploy/docker/seccomp-chromium.json as its seccomp profile '
            + '(docker-compose.yml does), or set PALUGADA_BROWSER_SANDBOX=off where that is understood'
          : '';
      throw new PalugadaError('capability.unreachable',
        `the browser at ${executable} did not start${said ? `: ${said}` : ''}${remedy ? ` ${remedy}` : ''}`,
        { executable, cause: (failure as Error).message });
    }
    return cdp;
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (let at = this.#buffer.indexOf(0); at >= 0; at = this.#buffer.indexOf(0)) {
      const text = this.#buffer.subarray(0, at).toString('utf8');
      this.#buffer = this.#buffer.subarray(at + 1);
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; sessionId?: string };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const waiting = this.#waiting.get(message.id);
        this.#waiting.delete(message.id);
        if (!waiting) continue;
        if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
        else waiting.resolve(message.result ?? {});
      } else if (message.method) {
        this.#emit(message.method, message.params ?? {}, message.sessionId);
      }
    }
  }

  #emit(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    for (const listener of this.#listeners.get(method) ?? []) {
      try {
        listener(params, sessionId);
      } catch {
        // A listener's own failure is its own; the others still hear.
      }
    }
  }

  /** One command; in a target's session when one is named. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_MS): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    this.#sent += 1;
    const id = this.#sent;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new PalugadaError('capability.unreachable', `the browser did not answer ${method} in ${Math.round(timeoutMs / 1000)} seconds`, { method }));
      }, timeoutMs);
      timer.unref();
      this.#waiting.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#write.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Hears an event; answers the function that stops hearing it. */
  on(method: string, listener: Listener): () => void {
    const set = this.#listeners.get(method) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(method, set);
    return () => set.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#process.exitCode !== null || this.#process.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.#process.once('exit', () => resolve()));
    await this.send('Browser.close', {}, undefined, 5_000).catch(() => undefined);
    const killer = setTimeout(() => this.#process.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(killer);
  }
}
