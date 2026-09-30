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
import { TOOL_KINDS, type ToolKind } from '../capabilities/tools.ts';

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

/** A tool's provider, as the console sets it: web search, or reading pages. */
export interface ToolSetting {
  provider: string;
  /** The owner's own server, for a provider that is one. */
  url?: string;
  /** The sealed key's name (`db://<name>`), for a provider that takes one. */
  keySecret?: string;
  /** For pictures and speech: the model, and the voice, when not the provider's default. */
  model?: string;
  voice?: string;
}

/** How the owner is reached, as the console sets it. Every credential is a sealed secret's name. */
export interface ChannelSettings {
  telegram?: { chatId: string; tokenSecret: string; webhookSecret?: string };
  push?: { format: 'webhook' | 'ntfy'; url: string; topic?: string; tokenSecret?: string };
  slack?: { urlSecret: string };
  discord?: { urlSecret: string };
}

/**
 * An MCP server the owner added in the console: the file's shape
 * (`src/capabilities/mcp.ts`), with the server's token as a sealed secret's
 * name rather than a reference.
 */
export interface McpServerSetting {
  name: string;
  url: string;
  tokenSecret?: string;
  /** Where the server reads the token, when not `Authorization: Bearer`. */
  tokenIn?: { header?: string; scheme?: string; query?: string };
  tools: Record<string, { tier: number; pin?: string; readOnly?: boolean; verify?: Record<string, unknown> }>;
}

/** The variables each channel was configured by, which a console choice for that channel replaces together. */
const CHANNEL_KEYS: Readonly<Record<keyof ChannelSettings, readonly string[]>> = {
  telegram: ['PALUGADA_TELEGRAM_TOKEN', 'PALUGADA_TELEGRAM_TOKEN_REF', 'PALUGADA_TELEGRAM_CHAT',
    'PALUGADA_TELEGRAM_WEBHOOK_SECRET', 'PALUGADA_TELEGRAM_WEBHOOK_SECRET_REF'],
  push: ['PALUGADA_PUSH_URL', 'PALUGADA_PUSH_TOKEN', 'PALUGADA_PUSH_TOKEN_REF', 'PALUGADA_PUSH_FORMAT', 'PALUGADA_PUSH_TOPIC'],
  slack: ['PALUGADA_SLACK_WEBHOOK', 'PALUGADA_SLACK_WEBHOOK_REF'],
  discord: ['PALUGADA_DISCORD_WEBHOOK', 'PALUGADA_DISCORD_WEBHOOK_REF'],
};

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
  const tools = settings.tools as Partial<Record<ToolKind, ToolSetting>> | undefined;
  if (tools) {
    for (const [kind, names] of Object.entries(TOOL_KINDS) as Array<[ToolKind, (typeof TOOL_KINDS)[ToolKind]]>) {
      const tool = tools[kind];
      // Each kind is its own area: choosing a search provider leaves the
      // environment's page reader as it was.
      if (!tool) continue;
      const model = 'model' in names ? names.model : null;
      const voice = 'voice' in names ? names.voice : null;
      for (const key of [names.provider, names.url, names.key, model, voice]) if (key) delete out[key];
      out[names.provider] = tool.provider;
      if (tool.url) out[names.url] = tool.url;
      if (tool.keySecret) out[names.key] = `db://${tool.keySecret}`;
      if (model && tool.model) out[model] = tool.model;
      if (voice && tool.voice) out[voice] = tool.voice;
    }
  }
  const channels = settings.channels as ChannelSettings | undefined;
  for (const name of Object.keys(CHANNEL_KEYS) as Array<keyof ChannelSettings>) {
    const channel = channels?.[name];
    if (!channel) continue;
    for (const key of CHANNEL_KEYS[name]) delete out[key];
    if (name === 'telegram' && channels.telegram) {
      out.PALUGADA_TELEGRAM_TOKEN_REF = `db://${channels.telegram.tokenSecret}`;
      out.PALUGADA_TELEGRAM_CHAT = channels.telegram.chatId;
      if (channels.telegram.webhookSecret) out.PALUGADA_TELEGRAM_WEBHOOK_SECRET_REF = `db://${channels.telegram.webhookSecret}`;
    } else if (name === 'push' && channels.push) {
      out.PALUGADA_PUSH_URL = channels.push.url;
      out.PALUGADA_PUSH_FORMAT = channels.push.format;
      if (channels.push.topic) out.PALUGADA_PUSH_TOPIC = channels.push.topic;
      if (channels.push.tokenSecret) out.PALUGADA_PUSH_TOKEN_REF = `db://${channels.push.tokenSecret}`;
    } else if ((name === 'slack' || name === 'discord') && channels[name]) {
      out[`PALUGADA_${name.toUpperCase()}_WEBHOOK_REF`] = `db://${channels[name]!.urlSecret}`;
    }
  }
  // The console's MCP servers are the owner's, next to the operator's file
  // rather than in place of it: PALUGADA_MCP_SERVERS is untouched.
  const mcp = settings.mcp as { servers?: McpServerSetting[] } | undefined;
  if (mcp) {
    delete out.PALUGADA_MCP_SETTINGS;
    if (mcp.servers && mcp.servers.length > 0) {
      out.PALUGADA_MCP_SETTINGS = JSON.stringify({
        servers: mcp.servers.map(({ tokenSecret, ...server }) => ({ ...server, ...(tokenSecret ? { tokenRef: `db://${tokenSecret}` } : {}) })),
      });
    }
  }
  // And its services, likewise beside PALUGADA_VENDORS rather than in place of
  // it. An entry holds no secret: a division's key is a credential of its own.
  const vendors = settings.vendors as { capabilities?: unknown[] } | undefined;
  if (vendors) {
    delete out.PALUGADA_VENDOR_SETTINGS;
    if (vendors.capabilities && vendors.capabilities.length > 0) {
      out.PALUGADA_VENDOR_SETTINGS = JSON.stringify({ capabilities: vendors.capabilities });
    }
  }
  // What the owner said each model costs (L12), over the operator's price file.
  // Laid over the ones setup wrote, not in place of them: a price the owner
  // saves for one model leaves the others where setup put them.
  const prices = settings.model_prices as { models?: Record<string, unknown> } | undefined;
  if (prices?.models && Object.keys(prices.models).length > 0) {
    let written: Record<string, unknown> = {};
    try {
      written = (JSON.parse(out.PALUGADA_MODEL_PRICE_SETTINGS ?? '{}') as { models?: Record<string, unknown> }).models ?? {};
    } catch {
      written = {};
    }
    out.PALUGADA_MODEL_PRICE_SETTINGS = JSON.stringify({ models: { ...written, ...prices.models } });
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
