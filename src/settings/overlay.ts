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
  return out;
}

/** Whether an area was set in the console, set by the environment, or not at all. */
export function modelSource(env: NodeJS.ProcessEnv, settings: Settings): 'console' | 'environment' | null {
  if (settings.model) return 'console';
  return env.PALUGADA_MODEL_PROVIDER || env.PALUGADA_MODEL_KEY_REF ? 'environment' : null;
}
