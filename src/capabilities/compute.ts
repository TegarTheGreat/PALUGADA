/**
 * Working out figures: Python a role supplies, run on the company files it
 * names, in a container that reaches no network -- `code.compute`, the tools
 * research's sixth recommendation.
 *
 * A month's sales from a spreadsheet, a cash-flow forecast, a chart for the
 * owner: arithmetic a model gets wrong in its head and a few lines of pandas
 * get right. The files a role names are copied into the container under
 * `in/`; what its code writes to `out/` is kept in the company's files under
 * a folder of its own (`computed/<date>-<id>/`), each file read back by its
 * digest; what it prints comes back to the role.
 *
 * **The boundary is the container's flags**, the same ones a role's runtime
 * gets in `src/runtime/container.ts` and for the same reason: `--network
 * none`, so the code can reach nothing -- not a provider, not the database,
 * not the host; `--read-only` with a small scratch; no capabilities, no new
 * privileges, nobody's user; its memory, CPU and processes capped; nothing
 * mounted, so it sees only what it was handed over stdin; no credential, so
 * it holds nothing worth posting. That is why F8.10, which keeps the
 * sandbox's code away from any credential and tier 2 grant, lets this one sit
 * beside both (0115). `npm run compute:check` proves the flags on a real
 * daemon; the suite checks them as an argv.
 *
 * **Its own time, then a grace, then removal.** The code runs for the
 * seconds it asked for, at most five minutes, inside the container, which
 * stops it and still answers. A container that does not answer by its
 * grace -- a daemon that never started it, a runner that hung -- is removed
 * by name, since ending the docker client does not end its container.
 *
 * **Nothing half-kept.** Code that fails or runs past its time keeps none of
 * what it wrote; a file that is a link, a name that is not a plain one, or
 * more than the limits keep none either, and say which, so the role can fix
 * its code rather than wonder what went missing.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';
import { dockerClientEnv } from '../runtime/container.ts';
import { companyRoot, readCompanyFile } from './files.ts';

/** The program the container runs, handed over with each call (compute-runner.py says why). */
const RUNNER = readFileSync(new URL('./compute-runner.py', import.meta.url), 'utf8');

const CODE_MAX = 100_000;
const FILES_IN_MAX = 20;
const FILE_IN_MAX_BYTES = 25 * 1024 * 1024;
const FILES_IN_TOTAL_BYTES = 32 * 1024 * 1024;
const FILES_OUT_MAX = 20;
const FILES_OUT_MAX_BYTES = 16 * 1024 * 1024;
/** What comes back of what the code printed, each of stdout and stderr. */
const PRINT_MAX = 20_000;
const SECONDS_DEFAULT = 60;
const SECONDS_MAX = 300;
const GRACE_MS = 30_000;
/** Runs at once in this process; more wait their turn, as the browser's conversions do. */
const COMPUTES_AT_ONCE = 2;
/**
 * The most a container may hand back: the files out in base64, what was
 * printed escaped at worst six bytes a character, and the JSON around them.
 */
const ANSWER_MAX_BYTES = Math.ceil((FILES_OUT_MAX_BYTES * 4) / 3) + 2 * PRINT_MAX * 6 + 64 * 1024;
/** The scratch the inputs, the outputs and what was printed share. */
const SCRATCH = '256m';
const MEMORY = '1g';
const OUT_OF_MEMORY = ', which is how running out of its 1 GB of memory ends';

export interface ComputeOptions {
  /** The company files' root, `PALUGADA_FILES_ROOT`. */
  root: string;
  /** Python with the libraries, built from deploy/compute; pinned by digest in a deployment worth trusting. */
  image: string;
  /** The docker client, or podman; `docker` on the PATH when not given. */
  docker?: string;
  /** How long past the code's own time a container is given to start and answer; 30 seconds. */
  graceMs?: number;
}

export interface ComputeInput {
  code: string;
  files?: string[];
  seconds?: number;
}

export interface ComputeOutput {
  /** It exited 0 within its time, and everything it wrote was kept. */
  ok: boolean;
  /** Null when it was ended by a signal. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** What it wrote, as kept in the company's files. */
  files: Array<{ path: string; bytes: number; sha256: string }>;
  /** Why it is not ok, and what to do. */
  said?: string;
}

/** What the runner answers; not trusted, so every field is checked. */
interface Answer {
  exit: number | null;
  timedOut: boolean;
  stdout: string;
  stdoutMore: number;
  stderr: string;
  stderrMore: number;
  files: Array<{ path: string; data: string }>;
  refused?: { why: string; path?: string };
}

/**
 * Binds `code.compute` from the environment: an image, and the company's
 * files it reads and writes. Otherwise a note saying which is missing.
 */
export function computeFrom(env: Record<string, string | undefined>, filesRoot: string | null): { options?: ComputeOptions; note?: string } {
  const image = env.PALUGADA_COMPUTE_IMAGE?.trim();
  if (!image) {
    return {
      note: 'code.compute is unbound: set PALUGADA_COMPUTE_IMAGE to an image built from deploy/compute, '
        + 'on a machine whose docker or podman this process can reach (F8.10)',
    };
  }
  if (!filesRoot) return { note: 'code.compute is unbound: it reads and writes the company\'s files, and PALUGADA_FILES_ROOT is not set' };
  const docker = env.PALUGADA_COMPUTE_DOCKER?.trim() || env.PALUGADA_RUNTIME_DOCKER?.trim();
  return { options: { root: filesRoot, image, ...(docker ? { docker } : {}) } };
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
const unreachable = (said: string) => new PalugadaError('capability.unreachable', said, {});
const violation = (said: string, field?: string) => new PalugadaError('contract.violation', said, field ? { field } : {});

/** A name as it can be shown: as it is, or quoted when it holds what would not print. */
function shown(name: string): string {
  return /[\u0000-\u001f\u007f]/.test(name) ? JSON.stringify(name) : name;
}

/** Whether a path under `out/` can be kept under that name: plain parts, none hidden, four deep at most. */
function plainName(path: string): boolean {
  const parts = path.split('/');
  return parts.length <= 4 && parts.every((part) => part.length > 0 && part.length <= 120 && !part.startsWith('.')
    && part.trim() === part && !/[\u0000-\u001f\u007f\\]/.test(part));
}

function refusalSaid(refused: { why: string; path?: string }): string {
  if (refused.why === 'link' && refused.path === '.') return 'out/ is a link, not a folder: write the files into it';
  if (refused.why === 'link') return `out/${shown(refused.path ?? '')} is a link, not a file: write the file itself`;
  if (refused.why === 'not-file') return `out/${shown(refused.path ?? '')} is not a file: only files are kept`;
  if (refused.why === 'too-many') return `out/ holds more than ${FILES_OUT_MAX} files: write fewer, or put them in one`;
  return `out/ holds more than ${FILES_OUT_MAX_BYTES / 1024 / 1024} MB: write less`;
}

function answerFrom(text: string): Answer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const answer = parsed as Partial<Answer> | null;
  if (!answer || typeof answer !== 'object') return null;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  if (!(answer.exit === null || Number.isInteger(answer.exit)) || typeof answer.timedOut !== 'boolean') return null;
  if (typeof answer.stdout !== 'string' || typeof answer.stderr !== 'string' || !Array.isArray(answer.files)) return null;
  if (!answer.files.every((file) => file && typeof file.path === 'string' && typeof file.data === 'string')) return null;
  const refused = answer.refused && typeof answer.refused === 'object' && typeof answer.refused.why === 'string'
    ? { why: answer.refused.why, ...(typeof answer.refused.path === 'string' ? { path: answer.refused.path } : {}) }
    : undefined;
  return {
    exit: answer.exit ?? null, timedOut: answer.timedOut, stdout: answer.stdout, stdoutMore: count(answer.stdoutMore),
    stderr: answer.stderr, stderrMore: count(answer.stderrMore), files: answer.files, ...(refused ? { refused } : {}),
  };
}

/** What was printed, at most `PRINT_MAX` characters, saying how much more there was. */
function printedSaid(text: string, more: number): string {
  const kept = text.slice(0, PRINT_MAX);
  const dropped = more + Buffer.byteLength(text.slice(PRINT_MAX));
  return dropped > 0 ? `${kept}\n[${dropped} more bytes were printed and are not shown]` : kept;
}

/**
 * `code.compute` -- Python on the company's files, in a container that
 * reaches no network. Tier 1: all it changes is new files in the company's
 * own, which deleting their folder undoes.
 */
export function codeCompute(options: ComputeOptions): Capability<ComputeInput, ComputeOutput> {
  const docker = options.docker ?? 'docker';
  const graceMs = options.graceMs ?? GRACE_MS;
  let running = 0;
  const waiting: Array<() => void> = [];

  /** A turn to run, waited for in order; given back by what it returns. */
  async function turn(signal: AbortSignal): Promise<() => void> {
    if (running >= COMPUTES_AT_ONCE) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        const stop = () => {
          const at = waiting.indexOf(go);
          if (at >= 0) waiting.splice(at, 1);
          reject(unreachable('code.compute was stopped before it started'));
        };
        waiting.push(go);
        signal.addEventListener('abort', stop, { once: true });
      });
    } else {
      running += 1;
    }
    return () => {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    };
  }

  /**
   * The command line: the boundary, kept in one place so the suite can read
   * it from what the docker client was asked.
   */
  function argv(name: string): string[] {
    return [
      'run', '--rm', '--interactive', '--init',
      // An image the operator built or pulled; never fetched in the middle of a role's run.
      '--pull', 'never',
      '--name', name,
      // The whole point. See the module comment.
      '--network', 'none',
      '--read-only',
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${SCRATCH}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '128',
      '--memory', MEMORY,
      '--cpus', '1',
      '--user', '65534:65534',
      // What the code computed is the company's, and is not copied into the daemon's logs.
      '--log-driver', 'none',
      '--entrypoint', 'python3',
      options.image,
      '-I', '-c', RUNNER,
    ];
  }

  /** Removes a container by its name, bounded: a daemon that does not answer is not waited on for ever. */
  function remove(name: string): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(docker, ['rm', '--force', name], { env: { PATH: process.env.PATH ?? '', ...dockerClientEnv() }, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** One container: the request in, the runner's answer out. */
  function contain(request: unknown, seconds: number, signal: AbortSignal): Promise<Answer> {
    const name = `palugada-compute-${randomUUID()}`;
    return new Promise<Answer>((resolve, reject) => {
      const child = spawn(docker, argv(name), { env: { PATH: process.env.PATH ?? '', ...dockerClientEnv() }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let errors = '';
      let ended: PalugadaError | null = null;
      let settled = false;
      const finish = () => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      };
      // Removed by name at once, and answered once it is gone, without
      // waiting for the client's pipes to close: whatever the client left
      // running may hold them open.
      const end = (why: PalugadaError) => {
        if (ended || settled) return;
        ended = why;
        child.kill('SIGKILL');
        void remove(name).then(() => {
          finish();
          reject(why);
        });
      };
      const timer = setTimeout(() => end(unreachable(
        `the container did not hand back a result within ${plural(seconds, 'second')} and its grace; it was removed`)), seconds * 1000 + graceMs);
      const stop = () => end(unreachable('code.compute was stopped before it finished, and its container removed'));
      signal.addEventListener('abort', stop, { once: true });
      // Stopped while it waited for its turn: a listener added now would never hear it.
      if (signal.aborted) stop();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > ANSWER_MAX_BYTES) end(unreachable(`the container handed back more than ${Math.round(ANSWER_MAX_BYTES / 1024 / 1024)} MB; it was removed`));
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString('utf8')).slice(0, 4_000);
      });
      // A client that ended before reading its input is said by how it ended, not by a broken pipe.
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
      // No client, so no container: nothing to remove.
      child.on('error', (error) => {
        if (settled || child.pid !== undefined) return;
        finish();
        reject(unreachable(`${docker} could not be started: ${error.message}`));
      });
      child.on('close', (code) => {
        if (settled || ended) return;
        finish();
        void remove(name).then(() => {
          const answer = answerFrom(Buffer.concat(chunks).toString('utf8'));
          if (answer) return resolve(answer);
          if (code === 125 && /no such image|unable to find image/i.test(errors)) {
            return reject(unreachable(`the compute image ${options.image} is not on this machine's docker: build it from deploy/compute `
              + `(docker build --tag ${options.image} deploy/compute)`));
          }
          const detail = errors.trim().split('\n').at(-1) ?? '';
          reject(unreachable(`the container ended without a result (exit ${code})${code === 137 ? OUT_OF_MEMORY : ''}${detail ? `: ${detail}` : ''}`));
        });
      });
    });
  }

  /** What the code wrote, kept in the company's files under a folder of its own; or why none of it was. */
  async function keep(answer: Answer, companyId: string): Promise<{ files: ComputeOutput['files'] } | { said: string }> {
    if (answer.refused) return { said: refusalSaid(answer.refused) };
    if (answer.files.length > FILES_OUT_MAX) return { said: refusalSaid({ why: 'too-many' }) };
    const decoded = answer.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.data, 'base64') }));
    const strange = decoded.find((file) => !plainName(file.path));
    if (strange) return { said: `out/${shown(strange.path)} is not a name a file can be kept under: plain names, none beginning with a dot, four folders deep at most` };
    // A walk names each file once and never a file as a folder; an answer that does was not the runner's.
    const paths = decoded.map((file) => file.path);
    const twice = paths.find((path, at) => paths.indexOf(path) !== at || paths.some((other) => other.startsWith(`${path}/`)));
    if (twice !== undefined) return { said: `out/${shown(twice)} was handed back as two things at once; nothing was kept` };
    if (decoded.reduce((sum, file) => sum + file.bytes.length, 0) > FILES_OUT_MAX_BYTES) return { said: refusalSaid({ why: 'too-large' }) };
    if (decoded.length === 0) return { files: [] };

    const { mkdir, realpath, unlink, writeFile } = await import('node:fs/promises');
    const { dirname, join, sep } = await import('node:path');
    const base = await companyRoot(options.root, companyId);
    const folder = join('computed', `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
    const kept: ComputeOutput['files'] = [];
    const written: string[] = [];
    try {
      for (const file of decoded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const relative = join(folder, file.path);
        const directory = join(base, dirname(relative));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // A link left where `computed` was would carry the write outside the company.
        const real = await realpath(directory);
        if (real !== base && !real.startsWith(base + sep)) throw new Error(`${dirname(relative)} leads outside the company's files`);
        const target = join(real, file.path.split('/').at(-1)!);
        await writeFile(target, file.bytes, { mode: 0o600, flag: 'wx' });
        written.push(target);
        kept.push({ path: relative, bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') });
      }
    } catch (error) {
      // Nothing half-kept: what was written before the failure goes too.
      for (const target of written) await unlink(target).catch(() => {});
      return { said: `what the code wrote could not be kept (${(error as Error).message}); none of it was` };
    }
    return { files: kept };
  }

  return {
    name: 'code.compute',
    inputSchema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: {
          type: 'string', minLength: 1, maxLength: CODE_MAX,
          description: 'Python 3 to run, with no network. The files named in `files` are at in/<their path>; write what should be '
            + `kept to out/ (at most ${FILES_OUT_MAX} files, ${FILES_OUT_MAX_BYTES / 1024 / 1024} MB), and print the figures you need: `
            + 'what it prints comes back. The deployment\'s image has pandas, numpy, openpyxl and matplotlib.',
        },
        files: {
          type: 'array', maxItems: FILES_IN_MAX, items: { type: 'string', minLength: 1, maxLength: 1_000 },
          description: 'Files in the company\'s files to hand to the code, as files.list names them.',
        },
        seconds: { type: 'integer', minimum: 1, maximum: SECONDS_MAX, description: `How long it may run; ${SECONDS_DEFAULT} when not given.` },
      },
      additionalProperties: false,
    },
    adapter: 'container:compute',
    defaultTier: 1,
    executesUntrustedCode: true,
    networkIsolated: true,
    readsOutside: true,
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const code = typeof input.code === 'string' ? input.code : '';
      if (!code.trim()) throw violation('code is the Python to run', 'code');
      if (code.length > CODE_MAX) throw violation(`code is ${code.length} characters; at most ${CODE_MAX}`, 'code');
      const seconds = input.seconds ?? SECONDS_DEFAULT;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > SECONDS_MAX) throw violation(`seconds is a whole number from 1 to ${SECONDS_MAX}`, 'seconds');
      const named = [...new Set(Array.isArray(input.files) ? input.files : [])];
      if (named.length > FILES_IN_MAX) throw violation(`at most ${FILES_IN_MAX} files are handed to one run`, 'files');

      // Read before anything starts, with files.read's containment: a path
      // outside the company is refused here, and no container is started.
      const files: Array<{ path: string; data: string }> = [];
      let total = 0;
      for (const path of named) {
        const file = await readCompanyFile(options.root, ctx.companyId, path, FILE_IN_MAX_BYTES, `code.compute hands a run files up to ${FILE_IN_MAX_BYTES / 1024 / 1024} MB`);
        total += file.size;
        if (total > FILES_IN_TOTAL_BYTES) throw violation(`the files named come to more than ${FILES_IN_TOTAL_BYTES / 1024 / 1024} MB, which is the most handed to one run`, 'files');
        files.push({ path: file.path, data: file.bytes.toString('base64') });
      }
      if (ctx.signal.aborted) throw unreachable('code.compute was stopped before it started');

      const done = await turn(ctx.signal);
      let answer: Answer;
      try {
        answer = await contain({ code, files, seconds, printMax: PRINT_MAX, maxFiles: FILES_OUT_MAX, maxBytes: FILES_OUT_MAX_BYTES }, seconds, ctx.signal);
      } finally {
        done();
      }

      const result: ComputeOutput = {
        ok: false,
        exitCode: answer.exit !== null && answer.exit >= 0 ? answer.exit : null,
        timedOut: answer.timedOut,
        stdout: printedSaid(answer.stdout, answer.stdoutMore),
        stderr: printedSaid(answer.stderr, answer.stderrMore),
        files: [],
      };
      if (answer.timedOut) return { ...result, said: `the code ran past its ${plural(seconds, 'second')} and was stopped; nothing it wrote was kept` };
      if (answer.exit !== null && answer.exit < 0) {
        const signalled = -answer.exit;
        return { ...result, said: `the code was ended by signal ${signalled}${signalled === 9 ? OUT_OF_MEMORY : ''}; nothing it wrote was kept` };
      }
      if (answer.exit !== 0) return { ...result, said: `the code exited ${answer.exit}: what it printed to stderr says why; nothing it wrote was kept` };
      const kept = await keep(answer, ctx.companyId);
      if ('said' in kept) return { ...result, said: kept.said };
      return { ...result, ok: true, files: kept.files };
    },
    async verify(_input, result, ctx) {
      if (result.files.length === 0) return true;
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const base = await companyRoot(options.root, ctx.companyId);
      for (const file of result.files) {
        const stored = await readFile(join(base, file.path)).catch(() => null);
        if (stored === null || createHash('sha256').update(stored).digest('hex') !== file.sha256) return false;
      }
      return true;
    },
  };
}
