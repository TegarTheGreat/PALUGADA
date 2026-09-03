/**
 * The `docker` execution backend (PRD v2 F13.5, F12.9).
 *
 * The same wire as `script` — one JSON request in, newline-delimited events
 * out — with the process running inside a container instead of beside the
 * orchestrator. The transport is deliberately unchanged: stdio works across a
 * container boundary, which is what makes the next paragraph possible.
 *
 * **`--network none`.** This is the reason the backend exists. `sandbox.ts`
 * records that Node's permission model covers the filesystem, child processes,
 * workers and native addons and *not* sockets, and that real network isolation
 * needs a container or a namespace below the process. This is that container.
 * A runtime started here can reach the engine over its stdio pipe and nothing
 * else — not the database, not a provider, not the tool bridge, not another
 * tenant's anything. F12.9 asks for exactly that, and it is the one guarantee
 * the in-process sandbox has never been able to make.
 *
 * It follows that a containerised runtime does *not* get the MCP tool bridge:
 * the bridge is an HTTP server on loopback, and loopback is precisely what
 * `--network none` removes. Tool calls travel as `tool_call` events on stdout,
 * which is how the `script` runtime already does it. That is a feature rather
 * than a limitation — a runtime with no socket is a runtime that cannot
 * exfiltrate what it was given.
 *
 * The rest of the flags are the ordinary ones and each is load-bearing:
 * `--read-only` with a `tmpfs` for scratch, so a compromised runtime cannot
 * leave anything behind; `--memory` and `--cpus`, so one run cannot starve the
 * host; `--user`, so nothing inside runs as root; `--rm`, so a crashed run
 * does not accumulate containers until the disk fills.
 *
 * **Unverified end to end.** There is a docker CLI in this environment and no
 * daemon, so what the suite covers is the argv and the health check's refusal.
 * Running a real container against a real image is not something this
 * repository can do, and docs/STATUS.md says so rather than letting a green
 * suite imply otherwise.
 */
import { spawn } from 'node:child_process';
import type {
  Adapter,
  AdapterHealth,
  AdapterResult,
  ExecutionBackend,
  RunRequest,
  RunServices,
} from './protocol.ts';
import { ScriptAdapter } from './script.ts';

export interface ContainerAdapterOptions {
  name?: string;
  /** The image the runtime lives in. Pinned by digest in a deployment worth trusting. */
  image: string;
  /** The command inside the image. Defaults to the image's own entrypoint. */
  command?: string[];
  /** The docker CLI. Overridable for podman, which takes the same flags. */
  docker?: string;
  memory?: string;
  cpus?: string;
  /** Numeric uid:gid. A name would have to exist inside the image. */
  user?: string;
  /** Passed into the container. Never the orchestrator's environment. */
  env?: Record<string, string>;
}

export class ContainerAdapter implements Adapter {
  readonly name: string;
  /** Only `docker`. Claiming `local` would make the isolation optional. */
  readonly backends: readonly ExecutionBackend[] = ['docker'];
  readonly #options: ContainerAdapterOptions;

  constructor(options: ContainerAdapterOptions) {
    this.name = options.name ?? 'docker';
    this.#options = options;
  }

  get docker(): string {
    return this.#options.docker ?? 'docker';
  }

  /**
   * The full command line, so it can be asserted without a daemon.
   *
   * Separated for the same reason the Claude Code adapter separates its argv:
   * the flags *are* the security property, and a test that could only check
   * them by running a container could not check them here at all.
   */
  argv(): string[] {
    const options = this.#options;
    return [
      'run', '--rm', '--interactive',
      // The whole point. See the module comment.
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--memory', options.memory ?? '512m',
      '--cpus', options.cpus ?? '1',
      '--user', options.user ?? '65534:65534',
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      options.image,
      ...(options.command ?? []),
    ];
  }

  /**
   * F13.8: is there a daemon to run a container on?
   *
   * `docker version` rather than `docker --version`: the second answers from
   * the CLI alone and would report healthy on a machine with no daemon, which
   * is the failure this check exists to catch.
   */
  async health(): Promise<AdapterHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.docker, ['version', '--format', '{{.Server.Version}}'], {
        env: { PATH: process.env.PATH ?? '', ...dockerClientEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out = (out + chunk.toString('utf8')).slice(0, 256);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err = (err + chunk.toString('utf8')).slice(0, 512);
      });
      child.on('error', (error) =>
        resolve({ ok: false, detail: `${this.docker} is not runnable: ${error.message}` }),
      );
      child.on('close', (code) =>
        resolve(
          code === 0 && out.trim() !== ''
            ? { ok: true, detail: `docker server ${out.trim()}` }
            : { ok: false, detail: err.trim() || `${this.docker} version exited ${code}` },
        ),
      );
    });
  }

  /**
   * Runs the container.
   *
   * Delegated to `ScriptAdapter` rather than reimplemented: the transport is
   * identical, and the two rules that matter there — the child inherits no
   * environment, and a stream that ends without `done` is a failure — should
   * not exist twice and drift.
   */
  async run(request: RunRequest, services: RunServices): Promise<AdapterResult> {
    const inner = new ScriptAdapter({
      name: this.name,
      command: this.docker,
      args: this.argv(),
      backends: this.backends,
      // The docker *client's* own configuration, and only that. A deployment
      // whose daemon is not on this machine sets DOCKER_HOST, and without it
      // the CLI would look for a socket that is not there. Named explicitly
      // rather than inherited, which is the same rule the script adapter
      // applies to the runtime itself.
      env: dockerClientEnv(),
      // Health is this adapter's answer, already given. Asking again here would
      // check whether the *docker binary* is executable, which is not the
      // question.
      health: () => this.health(),
    });
    return inner.run(request, services);
  }
}


/**
 * The docker client's own settings, passed through when they are set.
 *
 * Not the runtime's environment — that goes into the container through
 * `--env`, bounded by what the adapter was configured with. This is the handful
 * of variables the CLI needs to find and authenticate to its daemon, and it is
 * a fixed list rather than a prefix match so that a variable named
 * `DOCKER_SOMETHING_SECRET` cannot join it by accident.
 */
function dockerClientEnv(): Record<string, string> {
  const passthrough = [
    'DOCKER_HOST',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
  ];
  const env: Record<string, string> = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}
