/**
 * The agent CLIs an owner can install and sign in to from the console.
 *
 * Buzz does this from a desktop app, running as the user on their own
 * machine: it can open a browser on the same screen and a terminal window
 * beside it. PALUGADA's console is a page in front of a server, so what
 * reaches the CLI is what a server can hand it -- a binary installed where
 * the platform runs, and a credential sealed in the database and given to
 * each run under the one variable the CLI reads (`runtime/credentials.ts`).
 *
 * **Installing is running code on this machine.** Only the entries below can
 * be installed, each from its publisher's package at a version the platform's
 * specs were checked against (or, when the owner asks, the newest), into the
 * deployment's own state directory rather than anywhere on the system. The
 * console asks for the owner's device first, as it does for everything that
 * loosens a control. The install sees none of this process's environment
 * beyond `PATH`, a home of its own and the proxy settings a download needs.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { redactor } from '../secrets/manager.ts';
import type { KnownCliName } from '../runtime/known-clis.ts';

export type AgentName = 'claude-code' | KnownCliName;

/** One way to give a CLI its credential. */
export interface AgentCredentialKind {
  id: string;
  /** What the owner is asked for. */
  label: string;
  /** The variable the CLI reads it from. */
  variable: string;
  /** The page where one is made. */
  keyUrl?: string;
  /** How the owner gets one when it is not a plain API key. */
  howTo?: string;
  /** What else the CLI must be told to use it, such as which provider it belongs to. */
  env?: Record<string, string>;
  /** A sign-in the console can drive itself, in place of pasting. */
  login?: 'claude-setup-token';
}

export type AgentInstall =
  | { kind: 'npm'; package: string; tested: string; bin: string; node?: number }
  | { kind: 'none'; reason: string };

export interface AgentEntry {
  name: AgentName;
  title: string;
  about: string;
  /** Its usual name on PATH. */
  binary: string;
  install: AgentInstall;
  credentials: AgentCredentialKind[];
}

const ANTHROPIC_KEY: AgentCredentialKind = {
  id: 'anthropic', label: 'Anthropic API key', variable: 'ANTHROPIC_API_KEY',
  keyUrl: 'https://console.anthropic.com/settings/keys',
};
const OPENAI_KEY: AgentCredentialKind = {
  id: 'openai', label: 'OpenAI API key', variable: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys',
};
const OPENROUTER_KEY: AgentCredentialKind = {
  id: 'openrouter', label: 'OpenRouter API key', variable: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys',
};
const GEMINI_KEY: AgentCredentialKind = {
  id: 'gemini', label: 'Gemini API key', variable: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey',
};

export const AGENT_CATALOGUE: readonly AgentEntry[] = [
  {
    name: 'claude-code', title: 'Claude Code', about: 'Anthropic\'s agent, on an API key or a Claude subscription',
    binary: 'claude',
    install: { kind: 'npm', package: '@anthropic-ai/claude-code', tested: '2.1.283', bin: 'claude' },
    credentials: [
      ANTHROPIC_KEY,
      {
        id: 'subscription', label: 'Claude subscription token', variable: 'CLAUDE_CODE_OAUTH_TOKEN', login: 'claude-setup-token',
        // A token for model requests only, made once on any machine with a
        // browser; Anthropic's documentation for headless use.
        howTo: 'Run `claude setup-token` on a computer with a browser, sign in with your Claude plan, and paste the token it prints (it starts with sk-ant-oat).',
      },
    ],
  },
  {
    name: 'codex', title: 'Codex', about: 'OpenAI\'s agent',
    binary: 'codex',
    install: { kind: 'npm', package: '@openai/codex', tested: '0.157.1', bin: 'codex' },
    // An OpenAI key, which `codex exec` reads from CODEX_API_KEY only.
    credentials: [{ ...OPENAI_KEY, variable: 'CODEX_API_KEY' }],
  },
  {
    name: 'gemini-cli', title: 'Gemini CLI', about: 'Google\'s agent',
    binary: 'gemini',
    install: { kind: 'npm', package: '@google/gemini-cli', tested: '0.61.0', bin: 'gemini' },
    credentials: [GEMINI_KEY],
  },
  {
    name: 'opencode', title: 'OpenCode', about: 'An open-source agent for any provider',
    binary: 'opencode',
    install: { kind: 'npm', package: 'opencode-ai', tested: '1.18.32', bin: 'opencode' },
    credentials: [ANTHROPIC_KEY, OPENAI_KEY, OPENROUTER_KEY],
  },
  {
    name: 'hermes', title: 'Hermes Agent', about: 'Nous Research\'s agent, for some thirty providers',
    binary: 'hermes',
    install: {
      kind: 'none',
      reason: 'Hermes installs from its own script with its own Python; install it where PALUGADA runs '
        + '(curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive) and it is found on PATH',
    },
    // Hermes picks its provider from the environment when it is not told
    // (`--provider`, or config); left to guess, it has sent an OpenAI key to
    // OpenRouter. So each credential names its provider as well.
    credentials: [
      { ...OPENROUTER_KEY, env: { HERMES_INFERENCE_PROVIDER: 'openrouter' } },
      { ...ANTHROPIC_KEY, env: { HERMES_INFERENCE_PROVIDER: 'anthropic' } },
      { ...OPENAI_KEY, env: { HERMES_INFERENCE_PROVIDER: 'openai-api' } },
      { ...GEMINI_KEY, env: { HERMES_INFERENCE_PROVIDER: 'gemini' } },
    ],
  },
  {
    name: 'openclaw', title: 'OpenClaw', about: 'An open-source agent gateway',
    binary: 'openclaw',
    install: { kind: 'npm', package: 'openclaw', tested: '2026.9.6', bin: 'openclaw', node: 24 },
    credentials: [ANTHROPIC_KEY, OPENAI_KEY, OPENROUTER_KEY],
  },
];

export function agentEntry(name: string): AgentEntry | undefined {
  return AGENT_CATALOGUE.find((entry) => entry.name === name);
}

/** Where the console installs one CLI: its own directory in the state directory. */
export function agentToolDir(stateDir: string, name: AgentName): string {
  return join(stateDir, 'tools', name);
}

/** Why this machine cannot install it, or null when it can. */
export function cannotInstall(entry: AgentEntry): string | null {
  if (entry.install.kind === 'none') return entry.install.reason;
  const major = Number(process.versions.node.split('.')[0]);
  if (entry.install.node && major < entry.install.node) {
    return `${entry.title} needs Node ${entry.install.node} or later, and this deployment runs Node ${process.versions.node}`;
  }
  return null;
}

export interface FoundAgent {
  command: string;
  /** Installed by the console, in the state directory. */
  managed: boolean;
  version: string | null;
}

/**
 * Where the CLI is: the console's own install first, then PATH. Asked with
 * `--version` and a short timeout, since a binary that is present and does
 * not run is not an installed CLI.
 */
export async function findAgent(entry: AgentEntry, stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<FoundAgent | null> {
  const candidates: Array<{ command: string; managed: boolean }> = [];
  if (entry.install.kind === 'npm') {
    candidates.push({ command: join(agentToolDir(stateDir, entry.name), 'node_modules', '.bin', entry.install.bin), managed: true });
  }
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push({ command: join(directory, entry.binary), managed: false });
  }
  for (const candidate of candidates) {
    if (!(await executable(candidate.command))) continue;
    return { ...candidate, version: await versionOf(candidate.command) };
  }
  return null;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function versionOf(command: string): Promise<string | null> {
  const { code, output } = await run(command, ['--version'], { PATH: process.env.PATH ?? '' }, 10_000);
  return code === 0 ? (output.trim().split('\n')[0] ?? '').slice(0, 120) || null : null;
}

/** The only variables of this process an install is given: where to find programs, and how to reach the registry. */
const INSTALL_PASSTHROUGH = /^(PATH|NODE_EXTRA_CA_CERTS|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|npm_config_(registry|https?_proxy|noproxy|cafile|strict_ssl))$/;

/**
 * Installs one CLI into its directory in the state directory: `npm install
 * --prefix`, so nothing outside that directory changes and removing it is
 * removing the directory. Resolves with what `findAgent` then finds.
 */
export async function installAgent(
  entry: AgentEntry,
  stateDir: string,
  version: 'tested' | 'latest',
  log: (text: string) => void,
): Promise<FoundAgent> {
  const refused = cannotInstall(entry);
  if (refused || entry.install.kind !== 'npm') throw new Error(refused ?? `${entry.title} is not installed from npm`);
  const directory = agentToolDir(stateDir, entry.name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const spec = `${entry.install.package}@${version === 'tested' ? entry.install.tested : 'latest'}`;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => INSTALL_PASSTHROUGH.test(pair[0]) && pair[1] !== undefined),
  );
  // Its own home and cache: nothing of the operator's npm configuration, and
  // nothing left in their home directory.
  Object.assign(env, { HOME: directory, npm_config_cache: join(stateDir, 'tools', '.npm-cache'), npm_config_update_notifier: 'false' });
  log(`npm install ${spec}\n`);
  const { code, output } = await run('npm', [
    'install', '--prefix', directory, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', spec,
  ], env, 15 * 60_000, log);
  if (code !== 0) throw new Error(`npm install ${spec} exited ${code}: ${output.trim().split('\n').slice(-3).join(' ')}`);
  const found = await findAgent(entry, stateDir, { PATH: '' });
  if (!found) throw new Error(`${spec} installed, but ${entry.install.bin} does not run`);
  log(`${entry.title}: ${found.version ?? 'installed'}\n`);
  return found;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  log?: (text: string) => void,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (chunk: Buffer) => {
      const text = redactor.redact(chunk.toString('utf8'));
      output = (output + text).slice(-16_384);
      log?.(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** What the console shows while an install or a sign-in runs, and after. */
export interface AgentJob {
  agent: AgentName;
  kind: 'install' | 'login';
  state: 'running' | 'succeeded' | 'failed';
  log: string;
  /** A sign-in's page for the owner to open, once the CLI has printed it. */
  url: string | null;
  /** A sign-in waiting for the code that page shows the owner. */
  waitingForCode: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** What a job's work is given: where to write, and, for a sign-in, how to show a page and wait for its code. */
export interface JobControls {
  log: (text: string) => void;
  showUrl: (url: string) => void;
  code: () => Promise<string>;
  /** Aborted when the owner cancels, or a new job replaces this one. */
  signal: AbortSignal;
}

/**
 * One job per CLI at a time, kept in this process: an install belongs to the
 * machine it ran on, and a sign-in to the process holding its terminal, so
 * the console asks the process that is running it.
 */
export class AgentJobs {
  readonly #jobs = new Map<AgentName, AgentJob>();
  readonly #pending = new Map<AgentName, { code: (value: string) => void; abort: AbortController }>();

  get(agent: AgentName): AgentJob | null {
    return this.#jobs.get(agent) ?? null;
  }

  start(agent: AgentName, kind: AgentJob['kind'], work: (controls: JobControls) => Promise<void>): AgentJob {
    const current = this.#jobs.get(agent);
    if (current?.state === 'running') {
      // An install is not interrupted; a sign-in the owner walked away from is.
      if (current.kind === 'install' || kind === 'install') return current;
      this.cancel(agent);
    }
    const job: AgentJob = {
      agent, kind, state: 'running', log: '', url: null, waitingForCode: false,
      startedAt: new Date().toISOString(), finishedAt: null, error: null,
    };
    this.#jobs.set(agent, job);
    const abort = new AbortController();
    let deliver: (value: string) => void = () => undefined;
    const entry = { code: (value: string) => deliver(value), abort };
    this.#pending.set(agent, entry);
    const controls: JobControls = {
      log: (text) => { job.log = (job.log + text).slice(-16_384); },
      showUrl: (url) => { job.url = url; },
      code: () => new Promise<string>((resolve, reject) => {
        job.waitingForCode = true;
        deliver = (value) => { job.waitingForCode = false; resolve(value); };
        abort.signal.addEventListener('abort', () => reject(new Error('the sign-in was cancelled')), { once: true });
      }),
      signal: abort.signal,
    };
    void work(controls).then(
      () => { job.state = 'succeeded'; },
      (failure: unknown) => {
        job.state = 'failed';
        job.error = (failure as Error).message;
        controls.log(`${job.error}\n`);
      },
    ).finally(() => {
      job.waitingForCode = false;
      job.finishedAt = new Date().toISOString();
      if (this.#pending.get(agent) === entry) this.#pending.delete(agent);
    });
    return job;
  }

  /** The code the owner copied from the sign-in page, for the job waiting on it. */
  answer(agent: AgentName, code: string): AgentJob | null {
    const job = this.#jobs.get(agent);
    if (!job || job.state !== 'running' || !job.waitingForCode) return null;
    this.#pending.get(agent)?.code(code);
    return job;
  }

  cancel(agent: AgentName): void {
    this.#pending.get(agent)?.abort.abort();
  }
}

/* ------------------------------------------------------------- sign-in --- */

/** Everything a terminal draws that is not text: colours, cursor moves, titles. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[()][A-Z0-9]|\r/g;

const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

/**
 * Claude Code's `setup-token`: a year-long token for model requests, made by
 * signing in with a Claude plan. It prints a page for the owner to open and
 * waits for the code that page shows, and draws all of it only on a terminal,
 * so it runs under one: util-linux `script`, which the platform's image and
 * every mainstream Linux carry, rather than a native pty module.
 *
 * Nothing it prints after the code is sent reaches the log: the terminal
 * echoes the code, and the next thing it prints is the token. The token is
 * taken from that output, handed to `keep`, and forgotten.
 */
export async function claudeSetupToken(command: string, stateDir: string, controls: JobControls, keep: (token: string) => Promise<void>): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(stateDir, 'sign-in-'));
  const quoted = `'${command.replace(/'/g, "'\\''")}'`;
  const child = spawn('script', ['-qfec', `stty cols 500 rows 50 2>/dev/null; exec ${quoted} setup-token`, '/dev/null'], {
    env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let before = '';
  let after = '';
  let sent = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', resolve);
    child.on('error', () => resolve(null));
  });
  const stop = () => child.kill('SIGKILL');
  controls.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, SIGN_IN_TIMEOUT_MS);
  const read = (chunk: Buffer) => {
    const text = chunk.toString('utf8').replace(ANSI, '');
    if (sent) {
      after += text;
      return;
    }
    before += text;
    const url = /https:\/\/\S*oauth\S*/.exec(before)?.[0];
    if (url && !controls.signal.aborted) controls.showUrl(url);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  try {
    controls.log(`${command} setup-token\n`);
    const code = await controls.code();
    sent = true;
    controls.log('checking the code with Anthropic\n');
    child.stdin.write(`${code.trim()}\r`);
    for (let waited = 0; waited < 60_000; waited += 200) {
      const token = /sk-ant-oat[0-9]+-[A-Za-z0-9_-]+/.exec(after)?.[0];
      if (token) {
        redactor.register(token);
        await keep(token);
        controls.log('signed in: the token is sealed, and was not shown\n');
        return;
      }
      if (/invalid code|oauth error/i.test(after)) {
        throw new Error('Anthropic did not accept that code: copy the whole code the page shows, and sign in again');
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Claude Code ended without printing a token');
  } finally {
    clearTimeout(timer);
    stop();
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}
