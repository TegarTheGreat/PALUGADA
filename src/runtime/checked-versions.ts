/**
 * The version of each agent CLI whose containment was checked (F13.4).
 *
 * What keeps an agent CLI to the tool bridge is its own flags and settings:
 * Claude Code's empty `--tools`, Codex's `shell_tool = false`, Gemini's core
 * tool list, OpenCode's permission rules. Each was checked by running that
 * version and reading what the model was offered, and a later version may
 * read the same flags differently. One did: the Claude Code release that grew
 * seventeen tools the old deny list did not name is why that list became
 * `--tools ''`. So a CLI at another version gets no work until the owner
 * installs the version below or accepts the one they have, which the console
 * records (`acceptVersion`); OtoDock pins and freezes the CLIs it runs for
 * the same reason.
 *
 * Hermes is not here: it installs from its own script, with no version the
 * console can install, and its entry was read from its source rather than
 * run.
 */
export const CHECKED_VERSIONS = {
  'claude-code': '2.1.283',
  codex: '0.157.1',
  'gemini-cli': '0.61.0',
  opencode: '1.18.32',
  openclaw: '2026.9.6',
} as const;

/**
 * The version in what `--version` printed: its first `x.y.z`, which is how
 * every one of them prints it (`codex-cli 0.157.1`, `2.1.283 (Claude Code)`),
 * or the first line whole when there is none -- so that even an output with
 * no version in it can be accepted as it is.
 */
export function versionIn(output: string): string {
  return /\d+\.\d+\.\d+/.exec(output)?.[0] ?? output.trim().split('\n')[0]!.trim();
}

/** Why a CLI at the version found gets no work, or null when it may have some. */
export function uncheckedVersion(
  name: string,
  found: string,
  checked: string | undefined,
  accepted: string | undefined,
): string | null {
  if (!checked || found === checked || found === accepted) return null;
  return `${name} ${found} is not ${checked}, the version whose containment PALUGADA checked; `
    + `install ${checked} from Agent CLIs, or accept ${found} there`;
}
