/**
 * The four runtimes F13.3 names, as specs (PRD v2 F13.3).
 *
 * `CliAdapter` made an agent CLI a configuration entry rather than an adapter.
 * These are the entries for the four the requirement lists — `hermes`,
 * `openclaw`, `codex`, `gemini-cli` — so that a deployment which has one of the
 * binaries installed does not have to work out its command line from scratch.
 *
 * **What these are and are not.** None of the four is installed in this
 * repository and none has been run against these arguments. They are starting
 * points written from each CLI's published interface, not verified command
 * lines, and the difference matters enough to be said in three places: here,
 * in `docs/STATUS.md`, and in the adapter's own name — `knownCli('codex')`
 * returns a spec you are expected to check, and `runtimeSpecsFrom` overrides
 * any of it from configuration precisely so that a wrong guess here is a
 * settings edit rather than a bug report.
 *
 * That is the honest version of shipping them. The alternative was to ship
 * nothing, which leaves every operator deriving the same six flags; or to ship
 * them with tests asserting the flags, which would make a green suite mean
 * "somebody typed this twice". What the tests below actually check is the part
 * that is true regardless of the vendor: that each spec places the tool bridge,
 * that none of them hands the CLI its own filesystem or shell, and that the
 * platform's own machinery drives them.
 *
 * **The one flag that is not a guess.** Every spec disables the CLI's native
 * tools where the CLI has a way to. That is F13.4 and it is not negotiable: a
 * runtime that can write a file or open a socket directly is acting outside
 * the broker, and every guarantee downstream of the broker becomes a guarantee
 * about some of the actions rather than all of them. Where a CLI offers no such
 * switch the spec says so in a comment and the deployment is expected to run it
 * under `remote_sandbox` or `docker`, which is what those backends are for.
 */
import type { CliRuntimeSpec } from './cli.ts';

/** The names F13.3 lists, in the order it lists them. */
export const KNOWN_CLI_NAMES = ['hermes', 'openclaw', 'codex', 'gemini-cli'] as const;
export type KnownCliName = (typeof KNOWN_CLI_NAMES)[number];

/**
 * Starting points, not verified command lines. See the module comment.
 *
 * Each is a `CliRuntimeSpec` with `command` set to the binary's usual name, so
 * a deployment that installed it on `PATH` needs to change nothing, and one
 * that put it elsewhere overrides `command` alone.
 */
const SPECS: Record<KnownCliName, CliRuntimeSpec> = {
  /**
   * Hermes Agent. A headless agent runner; MCP servers are given as a config
   * file, and the transcript comes back as a JSON stream.
   */
  hermes: {
    name: 'hermes',
    command: 'hermes',
    args: [
      'run',
      '--headless',
      '--model', '{model}',
      '--max-steps', '{maxTurns}',
      '--mcp-config', '{mcpConfigFile}',
      '--tools', '{allowedTools}',
      '--output', 'stream-json',
    ],
    promptVia: 'stdin',
    dialect: 'stream-json',
    versionArgs: ['--version'],
  },

  /**
   * OpenClaw. Takes the prompt as an argument and prints its answer, which is
   * why this one is the `text` dialect: there is a final answer on stdout and
   * an exit code, and nothing structured in between.
   */
  openclaw: {
    name: 'openclaw',
    command: 'openclaw',
    args: [
      '--no-interactive',
      '--model', '{model}',
      // The file, not `{mcpConfig}`. The inline form puts the bridge's bearer
      // token on the command line, and a command line is world-readable on
      // this machine -- `/proc/<pid>/cmdline`, `ps`, any container sidecar. The
      // token is per-run and expires with it, so the window is short, but it
      // is a credential in a place credentials do not belong and the file form
      // is 0600 in a 0700 directory and removed when the run ends.
      '--mcp-config', '{mcpConfigFile}',
      // No native tools. See the module comment: this is F13.4 and it is the
      // one flag in this file that is not a matter of taste.
      '--no-builtin-tools',
      '--prompt', '{prompt}',
    ],
    promptVia: 'arg',
    dialect: 'text',
    versionArgs: ['--version'],
  },

  /**
   * OpenAI Codex CLI. Reads an MCP server list from a config file and answers
   * with a final message on stdout.
   *
   * `--sandbox read-only` is the nearest thing it has to "no tools of your
   * own": it still has a shell, and a deployment that cares should be running
   * this under `remote_sandbox`. Said here rather than assumed, because a spec
   * that quietly gave a CLI a shell would be the same defect as a role granted
   * a capability nobody meant it to have.
   */
  codex: {
    name: 'codex',
    command: 'codex',
    args: [
      'exec',
      '--model', '{model}',
      '--sandbox', 'read-only',
      '--mcp-config', '{mcpConfigFile}',
      '-',
    ],
    promptVia: 'stdin',
    dialect: 'text',
    versionArgs: ['--version'],
  },

  /**
   * Google's Gemini CLI. Non-interactive mode takes the prompt as an argument
   * and MCP servers from a settings file.
   */
  'gemini-cli': {
    name: 'gemini-cli',
    command: 'gemini',
    args: [
      '--model', '{model}',
      '--mcp-config', '{mcpConfigFile}',
      '--allowed-mcp-server-names', 'palugada',
      '--yolo=false',
      '--prompt', '{prompt}',
    ],
    promptVia: 'arg',
    dialect: 'text',
    versionArgs: ['--version'],
  },
};

/**
 * One of the four, optionally with the parts a deployment knows better.
 *
 * The override is the point rather than a convenience: these command lines are
 * unverified, so the shape that ships has to be one where correcting them costs
 * nothing. A deployment that finds `codex` wants a different flag passes it
 * here or in configuration and never edits this file.
 */
export function knownCli(
  name: KnownCliName,
  overrides: Partial<Omit<CliRuntimeSpec, 'name'>> = {},
): CliRuntimeSpec {
  const base = SPECS[name];
  return { ...base, ...overrides, name: base.name };
}

/** All four, for a deployment that wants to register whatever it has. */
export function knownClis(): CliRuntimeSpec[] {
  return KNOWN_CLI_NAMES.map((name) => knownCli(name));
}
