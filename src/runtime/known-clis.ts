/**
 * The runtimes F13.3 names, and OpenCode, as specs (PRD v2 F13.3).
 *
 * `CliAdapter` made an agent CLI a configuration entry rather than an adapter.
 * These are the entries for the four the requirement lists -- `hermes`,
 * `openclaw`, `codex`, `gemini-cli` -- and for `opencode`, so that a deployment
 * which has one of the binaries installed does not have to work out its
 * command line from scratch.
 *
 * **How far each is known.** `hermes`, `openclaw` and `opencode` were read from
 * their own source (Hermes Agent at d0288be, OpenClaw 2026.9.6 at 6209f31,
 * OpenCode 1.18.32 at 696f41b): the subcommand, every flag, where each takes
 * its MCP servers from, and what each prints are the ones in that code. The
 * first versions of the `hermes` and `openclaw` entries were written from
 * their descriptions instead, and every flag in both was wrong -- Hermes has
 * no `run` subcommand, OpenClaw no `--mcp-config` -- and Hermes's output would
 * have failed every run even with the right flags. None of the three has been
 * run here, because none is installed; `codex` and `gemini-cli` are still
 * written from their descriptions. `runtimeSpecsFrom` overrides any of it
 * from configuration, so a wrong detail is a settings edit.
 *
 * **What every entry holds to, whatever the vendor:**
 *
 * - **The bridge, and only the bridge.** F13.4: no native file, shell or web
 *   tools where the CLI has a way to turn them off -- Hermes's toolsets,
 *   OpenClaw's tool profile, OpenCode's permission rules. A runtime that can
 *   write a file directly is acting outside the broker. Where a CLI offers no
 *   such switch (`codex` keeps a shell) the entry says so and the deployment
 *   runs it under `remote_sandbox` or `docker`.
 * - **The token in the environment.** Each CLI reads its MCP servers from its
 *   own configuration format, written into the run's private directory; the
 *   file names the token through the CLI's own substitution
 *   (`${PALUGADA_MCP_TOKEN}`, `{env:PALUGADA_MCP_TOKEN}`) and the token itself
 *   is only in the child's environment. Never on a command line.
 * - **A home of its own.** `HOME` (and `XDG_*`, `HERMES_HOME`) is the run's
 *   directory. The child sees only `PATH` otherwise, and a CLI with no `HOME`
 *   falls back to the operator's -- their stored credentials, their plugins,
 *   their memory of other runs.
 * - **Nothing that skips approvals.** Hermes's `-z` and `--yolo`, OpenCode's
 *   `--auto`, and every `--dangerously-skip-permissions` are absent, and a
 *   test says so.
 * - **The runtime's own learning off.** Hermes writes memory and skills after
 *   a turn by default; that is learning outside the platform's governed loop
 *   (F4, F15), so its config turns memory, background review and the curator
 *   off.
 */
import type { CliRuntimeSpec } from './cli.ts';

/** The names F13.3 lists, in the order it lists them, and OpenCode. */
export const KNOWN_CLI_NAMES = ['hermes', 'openclaw', 'codex', 'gemini-cli', 'opencode'] as const;
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
   * Hermes Agent (Nous Research). `chat --oneshot` answers one prompt and
   * exits; `--query-file -` takes it on stdin; `--toolsets mcp-palugada`
   * leaves it the bridge's tools and none of its own. MCP servers come only
   * from `$HERMES_HOME/config.yaml`.
   */
  hermes: {
    name: 'hermes',
    command: 'hermes',
    args: [
      'chat', '--oneshot', '--query-file', '-',
      '--format', 'stream-json',
      '-m', '{model}',
      '--toolsets', 'mcp-palugada',
      '--max-turns', '{maxTurns}',
      // Kept out of the operator's own session list.
      '--source', 'tool',
    ],
    promptVia: 'stdin',
    dialect: 'hermes-stream-json',
    env: { HOME: '{runDir}', HERMES_HOME: '{runDir}/hermes', PALUGADA_MCP_TOKEN: '{mcpToken}' },
    files: {
      'hermes/config.yaml': [
        'mcp_servers:',
        '  palugada:',
        '    url: "{mcpUrl}"',
        '    headers:',
        '      Authorization: "Bearer ${PALUGADA_MCP_TOKEN}"',
        'memory:',
        '  memory_enabled: false',
        '  user_profile_enabled: false',
        'auxiliary:',
        '  background_review:',
        '    enabled: false',
        'curator:',
        '  enabled: false',
        'approvals:',
        '  single_query_mode: deny',
        '',
      ].join('\n'),
    },
    versionArgs: ['--version'],
  },

  /**
   * OpenClaw. `agent exec` is its headless one-shot: embedded, no gateway,
   * temporary state. By default it turns on the `coding` tool profile and a
   * shell, so the pinned config narrows it to the MCP bundle and denies the
   * rest. `--json` prints one envelope at exit, with usage and cost.
   */
  openclaw: {
    name: 'openclaw',
    command: 'openclaw',
    args: [
      'agent', 'exec', '--message-file', '-', '--json',
      '--config', '{runDir}/openclaw.json',
      '--cwd', '{runDir}',
      '--model', '{model}',
      '--code-mode', 'direct',
      '--timeout', '600',
    ],
    promptVia: 'stdin',
    dialect: 'openclaw-json',
    env: { HOME: '{runDir}', PALUGADA_MCP_TOKEN: '{mcpToken}' },
    files: {
      'openclaw.json': JSON.stringify({
        mcp: {
          servers: {
            palugada: {
              url: '{mcpUrl}',
              transport: 'streamable-http',
              headers: { Authorization: 'Bearer ${PALUGADA_MCP_TOKEN}' },
            },
          },
        },
        tools: {
          profile: 'minimal',
          alsoAllow: ['bundle-mcp'],
          deny: ['session_status', 'gateway', 'group:runtime', 'group:fs', 'group:web'],
        },
      }, null, 2),
    },
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

  /**
   * OpenCode. `run --format json` streams its events; piped stdin becomes
   * the message. Its whole configuration arrives in `OPENCODE_CONFIG_CONTENT`:
   * the bridge as a remote MCP server, and a permission rule that denies every
   * tool but the bridge's -- a `*` deny removes a tool from the model's list
   * altogether. `--dir` is the run's directory, so no project `opencode.json`
   * or `.opencode/` plugin is loaded; a hostile one could reorder those rules
   * or run code of its own.
   */
  opencode: {
    name: 'opencode',
    command: 'opencode',
    args: ['run', '--format', 'json', '--agent', 'palugada', '--model', '{model}', '--dir', '{runDir}'],
    promptVia: 'stdin',
    dialect: 'opencode-json',
    env: {
      HOME: '{runDir}',
      XDG_CONFIG_HOME: '{runDir}/.config',
      XDG_DATA_HOME: '{runDir}/.data',
      XDG_CACHE_HOME: '{runDir}/.cache',
      XDG_STATE_HOME: '{runDir}/.state',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      PALUGADA_MCP_TOKEN: '{mcpToken}',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        share: 'disabled',
        autoupdate: false,
        mcp: {
          palugada: {
            type: 'remote',
            url: '{mcpUrl}',
            enabled: true,
            headers: { Authorization: 'Bearer {env:PALUGADA_MCP_TOKEN}' },
          },
        },
        permission: { '*': 'deny', 'palugada_*': 'allow' },
        agent: {
          palugada: { mode: 'primary', steps: '{maxTurns}', description: 'A PALUGADA role' },
        },
      // A number in OpenCode's schema, so the placeholder loses its quotes.
      }).replace('"{maxTurns}"', '{maxTurns}'),
    },
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
