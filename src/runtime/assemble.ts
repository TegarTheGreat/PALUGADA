/**
 * Which runtimes a deployment actually employs (PRD v2 F13, §10).
 *
 * F13's adapters are all here -- `claude-code`, a CLI spec, an HTTP runtime, a
 * container and a remote sandbox -- and until now `src/main.ts` registered
 * none of them, and passed the engine no in-process runtime either. So `npm
 * start` booted a worker with an empty `AdapterRegistry`: every task it
 * checked out halted immediately with `runtime_unavailable`, naming the
 * registered runtimes as "none".
 *
 * That is the fifth time this repository has found machinery that works, is
 * tested in isolation, and is assembled by nobody, and it is the largest: the
 * platform's whole purpose is to run work, and the deployment could not run
 * any. Nothing caught it because every test builds its own `Engine` with its
 * own handlers -- the assembly was the one caller nobody wrote.
 *
 * **Every runtime here is conditional, and the absence of one is a note rather
 * than a default.** Each needs something this process cannot conjure: a CLI on
 * PATH, an image, a URL, a sandbox account. A deployment that configured none
 * of them gets the in-process runtime and is told so, because a worker that
 * can only run its own handlers is a fact an operator should learn at boot
 * rather than from a halted task at 3am.
 */
import { AdapterRegistry } from './protocol.ts';
import { InProcessAdapter, type TaskHandler } from './in-process.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';
import { CliAdapter, runtimeSpecsFrom } from './cli.ts';
import { HttpAdapter } from './http.ts';
import { ContainerAdapter } from './container.ts';
import { HttpSandboxProvider, RemoteSandboxAdapter } from './sandbox-adapter.ts';
import type { LlmClient } from '../llm/client.ts';

export interface RuntimeAssemblyOptions {
  env: NodeJS.ProcessEnv;
  /** The in-process runtime's model client and handlers, when there are any. */
  llm?: LlmClient;
  handlers?: Map<string, TaskHandler>;
  /** A registry a caller already built, so a deployment can add its own. */
  registry?: AdapterRegistry;
}

export interface RuntimeAssembly {
  adapters: AdapterRegistry;
  notes: string[];
}

/**
 * Reads the environment and registers what it describes.
 *
 * Returns the notes rather than logging them, so the deployment prints
 * everything it could not configure in one place and in one order.
 */
export function assembleRuntimes(options: RuntimeAssemblyOptions): RuntimeAssembly {
  const { env } = options;
  const adapters = options.registry ?? new AdapterRegistry();
  const notes: string[] = [];

  // The in-process runtime, first and by default.
  //
  // It is the only one that needs nothing, and a worker with no runtime at all
  // is a worker that halts every task it touches. A deployment that configures
  // a real runtime keeps this one too: a role names its runtime, so having
  // both registered is not ambiguity, it is coverage.
  if (options.llm && options.handlers) {
    adapters.register(new InProcessAdapter({ handlers: options.handlers, llm: options.llm }));
  } else {
    notes.push(
      'no in-process runtime: a deployment supplies a model client and handlers for it (F13.1)',
    );
  }

  if (env.PALUGADA_CLAUDE_CODE_COMMAND) {
    adapters.register(new ClaudeCodeAdapter({
      command: env.PALUGADA_CLAUDE_CODE_COMMAND,
      ...(env.PALUGADA_CLAUDE_CODE_CWD ? { cwd: env.PALUGADA_CLAUDE_CODE_CWD } : {}),
      // Named rather than passed: the child is given exactly one variable from
      // this process's environment, and which one is written down here.
      ...(env.PALUGADA_CLAUDE_CODE_KEY_VAR
        ? { apiKeyEnvVar: env.PALUGADA_CLAUDE_CODE_KEY_VAR }
        : {}),
    }));
  }

  if (env.PALUGADA_RUNTIME_HTTP_URL) {
    adapters.register(new HttpAdapter({
      ...(env.PALUGADA_RUNTIME_HTTP_NAME ? { name: env.PALUGADA_RUNTIME_HTTP_NAME } : {}),
      url: env.PALUGADA_RUNTIME_HTTP_URL,
      ...(env.PALUGADA_RUNTIME_HTTP_TOKEN
        ? { headers: { authorization: `Bearer ${env.PALUGADA_RUNTIME_HTTP_TOKEN}` } }
        : {}),
    }));
  }

  if (env.PALUGADA_RUNTIME_IMAGE) {
    // F12.9's `docker` backend, which is the only one that isolates the
    // network. Registered whenever an image is named, because an operator who
    // named one is asking for it.
    adapters.register(new ContainerAdapter({
      ...(env.PALUGADA_RUNTIME_CONTAINER_NAME
        ? { name: env.PALUGADA_RUNTIME_CONTAINER_NAME }
        : {}),
      image: env.PALUGADA_RUNTIME_IMAGE,
      ...(env.PALUGADA_RUNTIME_DOCKER ? { docker: env.PALUGADA_RUNTIME_DOCKER } : {}),
    }));
  }

  if (env.PALUGADA_SANDBOX_URL && env.PALUGADA_SANDBOX_IMAGE) {
    adapters.register(new RemoteSandboxAdapter({
      provider: new HttpSandboxProvider({
        baseUrl: env.PALUGADA_SANDBOX_URL,
        ...(env.PALUGADA_SANDBOX_TOKEN ? { token: env.PALUGADA_SANDBOX_TOKEN } : {}),
        ...(env.PALUGADA_SANDBOX_PROVIDER ? { name: env.PALUGADA_SANDBOX_PROVIDER } : {}),
      }),
      image: env.PALUGADA_SANDBOX_IMAGE,
    }));
  } else if (env.PALUGADA_SANDBOX_URL || env.PALUGADA_SANDBOX_IMAGE) {
    // Half-configured is said out loud. A sandbox with a URL and no image
    // silently does not exist, and the role routed to it halts.
    notes.push(
      'the remote sandbox needs both PALUGADA_SANDBOX_URL and PALUGADA_SANDBOX_IMAGE (F12.9)',
    );
  }

  // F13.3's "so that community adapters can be used", as configuration.
  //
  // A spec that never places the tool bridge is refused by `CliAdapter` at
  // construction -- an agent CLI spawned without one runs, talks to a model,
  // has no tools, and produces a confident answer about work it could not do.
  // Refusing here rather than at the first run means the deployment stops with
  // a message about the settings file.
  if (env.PALUGADA_RUNTIME_SPECS) {
    // Parsing and construction are both inside, because `CliAdapter` is where
    // the tool-bridge refusal lives and its message says nothing about where
    // the spec came from. An operator reading "runtime hermes places no tool
    // bridge" needs to be told which setting to open.
    try {
      for (const spec of runtimeSpecsFrom(JSON.parse(env.PALUGADA_RUNTIME_SPECS))) {
        adapters.register(new CliAdapter(spec));
      }
    } catch (failure) {
      throw new Error(
        `PALUGADA_RUNTIME_SPECS could not be read: ${(failure as Error).message}`,
      );
    }
  }

  const names = adapters.names();
  if (names.length === 0) {
    notes.push(
      'no runtime is registered: every task will halt with runtime_unavailable (F13.1)',
    );
  } else {
    notes.push(`runtimes: ${names.join(', ')}`);
  }

  return { adapters, notes };
}
