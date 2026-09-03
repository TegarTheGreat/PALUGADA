/**
 * Sandbox for code-executing capabilities (PRD F8.10).
 *
 * WHAT THIS ENFORCES, and what it does not, stated plainly because a sandbox
 * that is trusted for more than it delivers is more dangerous than none:
 *
 *   Enforced: no filesystem access, no child processes, no worker threads, no
 *   native addons -- all by Node's permission model, which fails the call
 *   rather than relying on the code not to try. Plus a wall-clock timeout, a
 *   heap ceiling, an empty environment, and a separate process so a crash or
 *   an infinite loop cannot take the worker with it.
 *
 *   NOT enforced: network access. Node's permission model does not cover
 *   sockets, so code running here can still open a connection. Real network
 *   isolation needs a container, a namespace or a seccomp filter -- a layer
 *   below this process, not inside it.
 *
 *   NOT enforced: result integrity against deliberately hostile code. The
 *   harness and the snippet share a process, so a determined snippet can
 *   interfere with how its own result is reported. What is guaranteed is the
 *   failure mode: anything unparseable comes back as a failed run rather than
 *   as a value, so interference is visible instead of silent.
 *
 * The consequence for the broker is concrete rather than theoretical: a
 * capability that executes untrusted code must not also hold a credential or
 * reach a tier 2 action, because this boundary would not stop the code from
 * posting either one somewhere. That constraint belongs in the capability's
 * grant, and this comment exists so nobody has to rediscover why.
 *
 * `node:vm` is deliberately not used. It is not a security boundary -- escapes
 * are a known, documented property of it, not bugs -- and offering it as one
 * would be the worst outcome here: a guarantee people rely on that does not
 * hold.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface SandboxOptions {
  timeoutMs?: number;
  memoryMb?: number;
  /** Serialisable value exposed to the code as `input`. */
  input?: unknown;
}

export interface SandboxResult {
  ok: boolean;
  /** Whatever the code returned, provided it is JSON-serialisable. */
  value: unknown;
  stdout: string;
  stderr: string;
  error: string | null;
  timedOut: boolean;
  durationMs: number;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MEMORY_MB = 128;

/**
 * Builds the harness the child runs.
 *
 * The result is delimited by a marker generated fresh for each run and never
 * passed through the environment, so code cannot read it out and print a
 * convincing forgery. It could still find the marker by introspecting the
 * source it shares -- which is why the guarantee below is about the failure
 * mode rather than about integrity: unparseable output is reported as a failed
 * run, never as a value. Denying its own result is the most a hostile snippet
 * achieves here, and that is visible rather than silent.
 */
function buildHarness(code: string, marker: string): string {
  return `
const MARKER = ${JSON.stringify(marker)};
let input;
try { input = JSON.parse(process.env.SANDBOX_INPUT_JSON ?? 'null'); } catch { input = null; }
(async () => {
  try {
    const value = await (async () => { ${code} })();
    process.stdout.write(MARKER + JSON.stringify({ ok: true, value: value ?? null }) + MARKER);
  } catch (error) {
    process.stdout.write(
      MARKER + JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }) + MARKER,
    );
  }
})();
`;
}

/**
 * Reads the result from between the last two markers.
 *
 * Last two rather than first and last: anything the code printed earlier
 * cannot then wrap the genuine result, because the harness writes its marker
 * pair after the code has finished.
 */
function extractResult(
  stdout: string,
  marker: string,
): { ok: boolean; value?: unknown; error?: string } | null {
  const last = stdout.lastIndexOf(marker);
  if (last === -1) return null;
  const first = stdout.lastIndexOf(marker, last - 1);
  if (first === -1) return null;
  try {
    return JSON.parse(stdout.slice(first + marker.length, last));
  } catch {
    return null;
  }
}

/**
 * Runs a snippet in a constrained child process.
 *
 * The code is passed on stdin rather than as an argument, so it never appears
 * in the process table where anything on the host could read it.
 */
export async function runSandboxed(
  code: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;
  const startedAt = Date.now();

  // A fresh marker per run, kept out of the environment so the code cannot
  // simply read it.
  const marker = `__PALUGADA_${randomBytes(12).toString('hex')}__`;
  const program = buildHarness(code, marker);

  const child = spawn(
    process.execPath,
    [
      // Denies filesystem, child processes, worker threads and native addons.
      // Nothing is allow-listed: the code gets none of them.
      '--permission',
      `--max-old-space-size=${memoryMb}`,
      '--input-type=module',
      '--eval',
      program,
    ],
    {
      // An empty environment except the input. Inheriting the parent's would
      // hand the code every connection string and token the worker holds.
      env: { SANDBOX_INPUT_JSON: JSON.stringify(options.input ?? null) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL, not SIGTERM: code that ignores a polite signal is exactly the
    // code a timeout exists for.
    child.kill('SIGKILL');
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);

  const durationMs = Date.now() - startedAt;
  const parsed = extractResult(stdout, marker);
  const cleanStdout = stdout.split(marker)[0] ?? '';

  if (timedOut) {
    return {
      ok: false,
      value: null,
      stdout: cleanStdout,
      stderr,
      error: `sandboxed code exceeded its ${timeoutMs}ms limit and was killed`,
      timedOut: true,
      durationMs,
    };
  }

  if (!parsed) {
    return {
      ok: false,
      value: null,
      stdout: cleanStdout,
      stderr,
      error:
        exitCode === 0
          ? 'sandboxed code produced no result marker'
          : `sandboxed process exited with code ${exitCode}`,
      timedOut: false,
      durationMs,
    };
  }

  return {
    ok: parsed.ok,
    value: parsed.ok ? (parsed.value ?? null) : null,
    stdout: cleanStdout,
    stderr,
    error: parsed.ok ? null : (parsed.error ?? 'unknown error'),
    timedOut: false,
    durationMs,
  };
}

/**
 * What this sandbox actually guarantees.
 *
 * Exported as data so the capability registry can record it and a test can
 * assert it, rather than the guarantees living only in a comment that drifts
 * away from the flags.
 */
export const SANDBOX_GUARANTEES = {
  filesystem: 'denied',
  childProcess: 'denied',
  workerThreads: 'denied',
  nativeAddons: 'denied',
  environment: 'not inherited',
  wallClock: 'bounded',
  heap: 'bounded',
  /** The honest gaps. See the module comment. */
  network:
    'NOT isolated in-process -- requires a container or namespace below this ' +
    'process. src/runtime/container.ts is that container: it starts a runtime ' +
    'with --network none, which is the isolation this sandbox cannot provide.',
  resultIntegrity:
    'not guaranteed against deliberately hostile in-process code; a forged or ' +
    'broken result is reported as a failed run, never as a value',
} as const;
