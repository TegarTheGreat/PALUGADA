/**
 * The owner's settings, laid over the deployment's environment.
 *
 * Each area the owner has set in the console replaces that whole area of the
 * environment -- a model chosen in the console does not inherit the
 * environment's aliases or key -- and an area the owner has not touched is
 * the environment's, as it always was. The result is an environment like any
 * other, so everything that already reads one (`modelSettingsFrom`,
 * `assembleRuntimes`, `channelsFrom`) reads the owner's choices without a
 * second way of being configured. It is an object in memory: nothing here
 * reaches `process.env`, and no child process is ever given it.
 */
import { MODEL_TIERS } from '../llm/models.ts';
import type { Settings } from './store.ts';

/** The model, as the console sets it. */
export interface ModelSetting {
  /** Which entry of the catalogue (`llm/providers.ts`) the owner picked, for the console to show. */
  preset?: string;
  provider: 'anthropic' | 'openai';
  url?: string;
  /** One model for every tier. */
  model?: string;
  /** Per tier, over `model`. */
  aliases?: Record<string, string>;
  /** The name of the sealed secret holding the key (`db://<name>`). */
  keySecret?: string;
}

/** One agent CLI, as the console sets it. */
export interface AgentSetting {
  /** Whether roles may run on it. Installing or signing in does not turn it on by itself. */
  enabled?: boolean;
  /** Where its binary is, when the console installed it; otherwise its usual name on PATH. */
  command?: string;
  /** Its own credential: the variable it reads, and the name of the sealed secret (`db://<secret>`). */
  credential?: { kind?: string; variable: string; secret: string };
  /** What each tier means to it. */
  models?: Record<string, string>;
  /** What else it reads to choose its provider, such as Hermes's HERMES_INFERENCE_PROVIDER. Never a secret. */
  env?: Record<string, string>;
}

/** The variables the agent CLIs were configured by, which a console choice replaces together. */
const AGENT_KEYS = [
  'PALUGADA_AGENT_CLIS', 'PALUGADA_AGENT_SETTINGS', 'PALUGADA_CLAUDE_CODE_COMMAND', 'PALUGADA_CLAUDE_CODE_KEY_VAR',
] as const;

const MODEL_KEYS = [
  'PALUGADA_MODEL_PROVIDER', 'PALUGADA_MODEL_URL', 'PALUGADA_MODEL', 'PALUGADA_MODEL_ALIASES', 'PALUGADA_MODEL_KEY_REF',
] as const;

export function withSettings(env: NodeJS.ProcessEnv, settings: Settings): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const model = settings.model as ModelSetting | undefined;
  if (model) {
    for (const key of MODEL_KEYS) delete out[key];
    out.PALUGADA_MODEL_PROVIDER = model.provider;
    if (model.url) out.PALUGADA_MODEL_URL = model.url;
    if (model.model) out.PALUGADA_MODEL = model.model;
    const aliases = Object.fromEntries(Object.entries(model.aliases ?? {})
      .filter(([tier, name]) => (MODEL_TIERS as readonly string[]).includes(tier) && name.trim() !== ''));
    if (Object.keys(aliases).length > 0) out.PALUGADA_MODEL_ALIASES = JSON.stringify(aliases);
    if (model.keySecret) out.PALUGADA_MODEL_KEY_REF = `db://${model.keySecret}`;
  }
  const agents = settings.agents as Record<string, AgentSetting> | undefined;
  if (agents) {
    for (const key of AGENT_KEYS) {
      // A key named from this process's environment stays, unless the owner
      // gave Claude Code one of its own: two credentials, and the CLI's own
      // precedence would decide which one paid.
      if (key === 'PALUGADA_CLAUDE_CODE_KEY_VAR' && !agents['claude-code']?.credential) continue;
      delete out[key];
    }
    const enabled = Object.entries(agents).filter(([, agent]) => agent.enabled);
    if (enabled.length > 0) {
      out.PALUGADA_AGENT_CLIS = enabled.map(([name]) => name).join(',');
      out.PALUGADA_AGENT_SETTINGS = JSON.stringify(Object.fromEntries(enabled.map(([name, agent]) => [name, {
        ...(agent.command ? { command: agent.command } : {}),
        ...(agent.models && Object.keys(agent.models).length > 0 ? { models: agent.models } : {}),
        ...(agent.credential ? { secretEnv: { [agent.credential.variable]: `db://${agent.credential.secret}` } } : {}),
        ...(agent.env && Object.keys(agent.env).length > 0 ? { env: agent.env } : {}),
      }])));
    }
  }
  return out;
}

/** Whether an area was set in the console, set by the environment, or not at all. */
export function modelSource(env: NodeJS.ProcessEnv, settings: Settings): 'console' | 'environment' | null {
  if (settings.model) return 'console';
  return env.PALUGADA_MODEL_PROVIDER || env.PALUGADA_MODEL_KEY_REF ? 'environment' : null;
}
