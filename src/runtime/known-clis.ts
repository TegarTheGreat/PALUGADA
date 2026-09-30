/**
 * The runtimes F13.3 names, and OpenCode, as specs (PRD v2 F13.3).
 *
 * `CliAdapter` made an agent CLI a configuration entry rather than an adapter.
 * These are the entries for the four the requirement lists -- `hermes`,
 * `openclaw`, `codex`, `gemini-cli` -- and for `opencode`, so that a deployment
 * which has one of the binaries installed does not have to work out its
 * command line from scratch.
 *
 * **How far each is known.** `codex` (0.157.1), `gemini-cli` (0.61.0) and
 * `opencode` (1.18.32) were installed and run with exactly these entries,
 * against a stand-in model and the tool bridge: each found the bridge, sent
 * the run's token, was offered the bridge's tools and none of its own, called
 * one, and printed what its dialect reads. `hermes` (from v2026.9.24, installed
 * from its repository: the PyPI release lacks these flags) and `openclaw`
 * (2026.9.6, which needs Node 24) were read from their source instead. The
 * first `codex` and `gemini-cli` entries were written from descriptions and
 * failed at once when run -- neither CLI has an `--mcp-config` flag -- and
 * the first `hermes` and `openclaw` ones had every flag wrong.
 * `runtimeSpecsFrom` overrides any of it from configuration, so a detail a
 * newer release changes is a settings edit.
 *
 * **What every entry holds to, whatever the vendor:**
 *
 * - **The bridge, and only the bridge.** F13.4: no native file, shell or web
 *   tools -- Hermes's toolsets, OpenClaw's tool profile, OpenCode's permission
 *   rules, Codex's feature switches, Gemini's core tool list. Each was checked
 *   by what the model was offered, not by what the flags promise. A runtime
 *   that can write a file directly is acting outside the broker.
 * - **The token in the environment.** Each CLI reads its MCP servers from its
 *   own configuration format, written into the run's private directory; the
 *   file names the token through the CLI's own substitution
 *   (`${PALUGADA_MCP_TOKEN}`, `{env:PALUGADA_MCP_TOKEN}`) and the token itself
 *   is only in the child's environment. Never on a command line.
 * - **A home of its own.** `HOME` (and `XDG_*`, `HERMES_HOME`, `CODEX_HOME`) is the run's
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
import { CHECKED_VERSIONS } from './checked-versions.ts';

/** The names F13.3 lists, in the order it lists them, and OpenCode. */
export const KNOWN_CLI_NAMES = ['hermes', 'openclaw', 'codex', 'gemini-cli', 'opencode'] as const;
export type KnownCliName = (typeof KNOWN_CLI_NAMES)[number];

/**
 * The entries as they ship. See the module comment for how each was checked.
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
    // Its stream has tokens and no price, and `--usage-file` is `-z`'s, which
    // approves everything. Hermes keeps each session's cost in its ledger;
    // this reads it back after the run (`hermes sessions export`).
    costArgs: ['sessions', 'export', '-', '--session-id', '{sessionId}'],
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
      // Seconds; the run's own wall clock rather than OpenClaw's default of
      // ten minutes, which ended a task given two hours at ten. At the
      // limit it exits 2 and still prints its envelope, usage included.
      '--timeout', '{wallClockSeconds}',
    ],
    promptVia: 'stdin',
    dialect: 'openclaw-json',
    env: { HOME: '{runDir}', PALUGADA_MCP_TOKEN: '{mcpToken}' },
    // Every credential OpenClaw reads is under $HOME, which is the run's --
    // except these two (its source, read 2026-09-28): Bedrock takes AWS's
    // default chain, the instance's own role on a cloud server, and
    // `claude-cli/` asks the claude binary, which on a Mac reads the login
    // keychain whatever $HOME is. `--auth-env-only` would close both, and
    // OpenClaw refuses it beside `--config`, which carries the bridge.
    hostSignInModels: ['amazon-bedrock/', 'claude-cli/'],
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
    checkedVersion: CHECKED_VERSIONS.openclaw,
  },

  /**
   * OpenAI Codex CLI. `exec --json` answers one prompt and streams its events.
   * It takes MCP servers only from `$CODEX_HOME/config.toml`, where the token
   * is named by `bearer_token_env_var` rather than written; `required` makes
   * a bridge it cannot reach end the run instead of being skipped, and
   * `default_tools_approval_mode` lets it call the bridge's tools at all,
   * since exec mode asks nobody. The features that give it a shell, images,
   * sub-agents, goals and web search are off, which leaves the model the
   * bridge and Codex's own MCP resource readers. `--sandbox read-only` stays
   * as the floor under that. Outside a git repository it refuses to start
   * without `--skip-git-repo-check`, and `--ephemeral` keeps the run out of
   * its session history.
   */
  codex: {
    name: 'codex',
    command: 'codex',
    args: [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--strict-config',
      '-C', '{runDir}',
      '--model', '{model}',
      '--sandbox', 'read-only',
      '-',
    ],
    promptVia: 'stdin',
    dialect: 'codex-jsonl',
    env: { HOME: '{runDir}', CODEX_HOME: '{runDir}/.codex', PALUGADA_MCP_TOKEN: '{mcpToken}' },
    // `codex exec` reads its key from CODEX_API_KEY and ignores
    // OPENAI_API_KEY in the environment (checked against 0.157.1 with `env -i`
    // and a server that logged the header): the first entry named the other,
    // and a run was given no key at all.
    apiKeyEnvVar: 'CODEX_API_KEY',
    files: {
      '.codex/config.toml': [
        'web_search = "disabled"',
        // Not replaced under a run by a version nobody checked; accepted by
        // 0.157.1 under --strict-config, which refuses a key it does not know.
        'check_for_update_on_startup = false',
        '',
        '[features]',
        'shell_tool = false',
        'unified_exec = false',
        'view_image = false',
        'multi_agent = false',
        'goals = false',
        '',
        '[mcp_servers.palugada]',
        'url = "{mcpUrl}"',
        'bearer_token_env_var = "PALUGADA_MCP_TOKEN"',
        'default_tools_approval_mode = "approve"',
        'required = true',
        '',
      ].join('\n'),
    },
    versionArgs: ['--version'],
    checkedVersion: CHECKED_VERSIONS.codex,
  },

  /**
   * Google's Gemini CLI. Headless when the prompt arrives on stdin. MCP
   * servers come only from its settings file, which expands
   * `${PALUGADA_MCP_TOKEN}` itself; `tools.core` limited to the bridge's
   * tools removes its own file, shell and web tools from what the model is
   * offered, and `--allowed-mcp-server-names` is what lets headless mode use
   * an MCP tool at all. It runs in the run's directory, the only place its
   * workspace settings could come from, and `--skip-trust` because that
   * directory is new every time. `model.maxSessionTurns` is its turn limit.
   */
  'gemini-cli': {
    name: 'gemini-cli',
    command: 'gemini',
    args: [
      '--model', '{model}',
      '--skip-trust',
      '--allowed-mcp-server-names', 'palugada',
      '--approval-mode', 'default',
      '--output-format', 'stream-json',
    ],
    promptVia: 'stdin',
    dialect: 'gemini-stream-json',
    // Gemini CLI's own default is the pro model; flash is its fast one.
    models: { fast: 'gemini-2.5-flash', standard: 'gemini-2.5-pro', deep: 'gemini-2.5-pro' },
    cwd: '{runDir}',
    env: { HOME: '{runDir}', PALUGADA_MCP_TOKEN: '{mcpToken}' },
    apiKeyEnvVar: 'GEMINI_API_KEY',
    files: {
      '.gemini/settings.json': JSON.stringify({
        mcpServers: {
          palugada: { type: 'http', url: '{mcpUrl}', headers: { Authorization: 'Bearer ${PALUGADA_MCP_TOKEN}' } },
        },
        tools: { core: ['mcp_palugada_*'] },
        model: { maxSessionTurns: '{maxTurns}' },
        security: { auth: { selectedType: 'gemini-api-key' } },
        // Its own updater off, under the names 0.61.0's settings schema gives it.
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
      // A number in Gemini's schema, so the placeholder loses its quotes.
      }, null, 2).replace('"{maxTurns}"', '{maxTurns}'),
    },
    versionArgs: ['--version'],
    checkedVersion: CHECKED_VERSIONS['gemini-cli'],
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
    checkedVersion: CHECKED_VERSIONS.opencode,
  },
};

/**
 * One of the five, optionally with the parts a deployment knows better.
 *
 * The override is the point rather than a convenience: these CLIs change their
 * flags between releases, so the shape that ships has to be one where
 * correcting them costs nothing. A deployment that finds `codex` wants a
 * different flag passes it here or in configuration and never edits this file.
 */
export function knownCli(
  name: KnownCliName,
  overrides: Partial<Omit<CliRuntimeSpec, 'name'>> = {},
): CliRuntimeSpec {
  const base = SPECS[name];
  return { ...base, ...overrides, name: base.name };
}

/** All five, for a deployment that wants to register whatever it has. */
export function knownClis(): CliRuntimeSpec[] {
  return KNOWN_CLI_NAMES.map((name) => knownCli(name));
}
