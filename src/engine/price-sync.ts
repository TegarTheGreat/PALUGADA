/**
 * Reading the catalogue, so that nobody has to (the owner's report of 7
 * October: the prices do not match the official ones, and the owner should
 * not have to keep them so).
 *
 * The platform reads models.dev itself, for the models the deployment runs on
 * and no others, once a day, and keeps what it learned (`Catalogue`) as a
 * deployment setting that every process reads into its price book. What it
 * never does is raise a price it was not told to or price anything at nothing:
 * a model the catalogue does not list, or lists as free, stays unpriced and is
 * charged at the fallback, which the console says.
 *
 * A catalogue that cannot be read leaves the prices as they were. The failure
 * is kept beside them (when, and why), tried again an hour later, and shown;
 * it never stops a company, because the prices it already has are the ones it
 * was running on.
 */
import { lookupPrices, MODELS_DEV_URL } from './models-dev.ts';
import { CATALOGUE_SETTING, type Catalogue, type CatalogueEntry, type PriceChange } from './price-book.ts';
import { MODEL_TIERS, modelSettingsFrom } from '../llm/models.ts';
import { KNOWN_CLI_NAMES, knownCli } from '../runtime/known-clis.ts';
import { readSettings, writeSetting } from '../settings/store.ts';

/** How old a reading may be before it is made again. */
export const MAX_AGE_MS = 24 * 3_600_000;
/** How long after a failed try the next one waits. */
export const RETRY_AFTER_MS = 3_600_000;
/** How many changes are kept. */
const CHANGES_KEPT = 20;

export interface SyncOptions {
  /** The models the deployment runs on. */
  models: readonly string[];
  /** Where the deployment reaches its model, and whose API it speaks. */
  where: { url: string | null; provider: string | null };
  source?: string;
  read: () => Promise<Catalogue | null>;
  write: (catalogue: Catalogue) => Promise<void>;
  now?: Date;
}

/** Reads the catalogue now, and keeps what it said. Never throws for a catalogue that cannot be read. */
export async function syncPrices(options: SyncOptions): Promise<Catalogue> {
  const now = options.now ?? new Date();
  const source = options.source ?? MODELS_DEV_URL;
  const before = await options.read();
  const wanted = [...new Set(options.models.filter((model) => model.trim() !== ''))];

  let found: Awaited<ReturnType<typeof lookupPrices>>;
  try {
    found = await lookupPrices(wanted, options.where, source);
  } catch (failure) {
    const kept: Catalogue = {
      source,
      syncedAt: before?.syncedAt ?? null,
      triedAt: now.toISOString(),
      problem: `models.dev could not be read: ${(failure as Error).message}`.slice(0, 300),
      models: before?.models ?? {},
      changes: before?.changes ?? [],
      unpriced: before?.unpriced ?? [],
    };
    await options.write(kept);
    return kept;
  }

  const models: Record<string, CatalogueEntry> = {};
  const unpriced: string[] = [];
  const changes: PriceChange[] = [...(before?.changes ?? [])];
  for (const model of wanted) {
    const price = found.prices[model];
    // Free, or not there: not a price. A model priced at nothing by a catalogue
    // that has it wrong would be spent on without ever being counted.
    if (!price || (price.input === 0 && price.output === 0)) {
      const known = before?.models[model];
      if (known && !price) models[model] = known;
      else unpriced.push(model);
      continue;
    }
    const entry: CatalogueEntry = {
      input: price.input, output: price.output,
      ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }),
      ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
      provider: price.provider,
    };
    models[model] = entry;
    const was = before?.models[model];
    if (!was || was.input !== entry.input || was.output !== entry.output) {
      changes.push({
        model,
        from: was ? { input: was.input, output: was.output } : null,
        to: { input: entry.input, output: entry.output },
        at: now.toISOString(),
      });
    }
  }
  const next: Catalogue = {
    source,
    syncedAt: now.toISOString(),
    triedAt: now.toISOString(),
    problem: null,
    models,
    changes: changes.slice(-CHANGES_KEPT),
    unpriced: unpriced.sort(),
  };
  await options.write(next);
  return next;
}

/**
 * Reads the catalogue when it is due: a day after the last good reading, an
 * hour after a failed try, or at once when the deployment runs on a model the
 * last reading knew nothing of (the owner changed it). Otherwise nothing.
 */
export async function syncIfStale(options: SyncOptions & { force?: boolean }): Promise<{ ran: boolean; catalogue: Catalogue | null }> {
  const now = options.now ?? new Date();
  const kept = await options.read();
  if (!options.force && kept) {
    const wanted = options.models.filter((model) => model.trim() !== '');
    const known = new Set([...Object.keys(kept.models), ...kept.unpriced]);
    const unknown = wanted.some((model) => !known.has(model));
    if (!unknown) {
      const failed = kept.problem !== null;
      const tried = kept.triedAt ? Date.parse(kept.triedAt) : null;
      const synced = kept.syncedAt ? Date.parse(kept.syncedAt) : null;
      if (failed && tried !== null && now.getTime() - tried < RETRY_AFTER_MS) return { ran: false, catalogue: kept };
      if (!failed && synced !== null && now.getTime() - synced < MAX_AGE_MS) return { ran: false, catalogue: kept };
    }
  }
  return { ran: true, catalogue: await syncPrices(options) };
}

/**
 * The models this deployment runs on, which are the ones whose price matters:
 * what each tier names, and what the agent CLIs that are turned on map their
 * tiers to (the engine estimates their calls by it). Read from the
 * environment as it is now, so a model the owner has just chosen is in it.
 */
export function modelsInUse(env: NodeJS.ProcessEnv): string[] {
  const models = new Set<string>();
  const settings = modelSettingsFrom(env);
  if (settings) for (const tier of MODEL_TIERS) if (settings.aliases[tier]) models.add(settings.aliases[tier]!);
  const turnedOn = (env.PALUGADA_AGENT_CLIS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  let tuned: Record<string, { models?: Record<string, unknown> }> = {};
  try {
    tuned = JSON.parse(env.PALUGADA_AGENT_SETTINGS ?? '{}') as typeof tuned;
  } catch {
    tuned = {};
  }
  for (const name of turnedOn) {
    const own = tuned[name]?.models
      ?? ((KNOWN_CLI_NAMES as readonly string[]).includes(name) ? knownCli(name as (typeof KNOWN_CLI_NAMES)[number]).models : undefined);
    for (const model of Object.values(own ?? {})) if (typeof model === 'string' && model.trim() !== '') models.add(model);
  }
  return [...models];
}

/** What the platform kept of the catalogue, and the way to keep it: quietly, as the platform's own reading and not a setting the owner changed. */
export const keptInSettings = {
  read: async (): Promise<Catalogue | null> => ((await readSettings())[CATALOGUE_SETTING] as Catalogue | undefined) ?? null,
  write: async (catalogue: Catalogue): Promise<void> => writeSetting(CATALOGUE_SETTING, catalogue, { quiet: true }),
};
