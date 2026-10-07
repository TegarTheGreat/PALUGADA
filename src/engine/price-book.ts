/**
 * What each model costs, in layers, and always current (the owner's report of
 * 7 October: the prices do not match the official ones).
 *
 * Four layers, the owner's word first:
 *
 * 1. what the owner typed in the console, and what setup wrote;
 * 2. the operator's price file;
 * 3. the catalogue the platform itself reads (models.dev, `price-sync.ts`),
 *    for the models the deployment runs on;
 * 4. the fallback, which is high on purpose, for a model nobody priced.
 *
 * Between layers the earlier wins whatever the pattern: an operator's
 * `claude-sonnet-*` is their word and the catalogue's exact id does not
 * outrank it. Within a layer the most specific pattern wins, as it always did.
 *
 * The book **is** a price list -- `rates` and `fallback`, read when a call is
 * priced -- and it is the one object the model client, the engine and the
 * console hold, so what a refresh learns is what the next call is priced by.
 * Prices used to be read once at boot, and a price the owner saved took effect
 * "from the next start". A source that fails to read leaves the layer as it
 * was: a database that blinks is not a reason to price at the fallback.
 */
import { withConsolePrices, type ModelRate, type PriceTable } from './pricing.ts';

/** What the catalogue says of one model, in cents per million tokens. */
export interface CatalogueEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Whose price it is, as the catalogue names the provider. */
  provider: string;
}

/** A price that moved: kept, so the owner can see what changed and when. */
export interface PriceChange {
  model: string;
  from: { input: number; output: number } | null;
  to: { input: number; output: number };
  at: string;
}

/** What the platform last learned from the catalogue, kept as a deployment setting. */
export interface Catalogue {
  source: string;
  /** When it was last read successfully; null when it never was. */
  syncedAt: string | null;
  /** When it was last tried, successfully or not. */
  triedAt?: string;
  /** Why the last try failed, or null. */
  problem: string | null;
  models: Record<string, CatalogueEntry>;
  /** The most recent changes, newest last. */
  changes: PriceChange[];
  /** Models the deployment runs on that the catalogue does not price, or prices at nothing: charged at the fallback. */
  unpriced: string[];
}

/** Where the platform keeps what it last learned from the catalogue: a deployment setting, written quietly. */
export const CATALOGUE_SETTING = 'model_price_catalogue';

export type PriceLayer = 'console' | 'file' | 'catalogue' | 'fallback';

export interface Described {
  rate: ModelRate;
  layer: PriceLayer;
  /** The row that priced it, or `fallback`. */
  pattern: string;
  provider?: string;
  syncedAt?: string;
}

export interface PriceSources {
  /** What the owner said and setup wrote, as JSON: `{ "models": { ... } }`. */
  owner?: () => Promise<string | undefined>;
  catalogue?: () => Promise<Catalogue | null>;
}

interface Row {
  pattern: string;
  rate: ModelRate;
  layer: PriceLayer;
  provider?: string;
}

function matches(pattern: string, model: string): boolean {
  return pattern.endsWith('*') ? model.startsWith(pattern.slice(0, -1)) : model === pattern;
}

export class PriceBook implements PriceTable {
  readonly #file: PriceTable;
  readonly #sources: PriceSources;
  #ownerRaw: string | undefined;
  #catalogue: Catalogue | null = null;
  #rows: Row[] = [];
  #fallback: ModelRate;
  #table: PriceTable['rates'] = [];

  constructor(file: PriceTable, sources: PriceSources = {}) {
    this.#file = file;
    this.#sources = sources;
    this.#fallback = file.fallback;
    this.#build();
  }

  get rates(): PriceTable['rates'] {
    return this.#table;
  }

  get fallback(): ModelRate {
    return this.#fallback;
  }

  /** What the catalogue last said, for the console. */
  get catalogue(): Catalogue | null {
    return this.#catalogue;
  }

  /**
   * Reads the layers again. A layer whose source cannot be read stays as it
   * was, and so does a layer whose contents are refused (a price file that is
   * wrong is refused whole at boot; one saved wrong is not taken up here).
   */
  async refresh(): Promise<void> {
    if (this.#sources.owner) {
      try {
        const raw = await this.#sources.owner();
        withConsolePrices(this.#file, raw);
        this.#ownerRaw = raw;
      } catch {
        // Kept as it was.
      }
    }
    if (this.#sources.catalogue) {
      try {
        this.#catalogue = await this.#sources.catalogue();
      } catch {
        // Kept as it was.
      }
    }
    this.#build();
  }

  /** Which layer prices a model, and at what. */
  describe(model: string): Described {
    const row = this.#rows.find((candidate) => matches(candidate.pattern, model));
    if (!row) return { rate: this.#fallback, layer: 'fallback', pattern: 'fallback' };
    return {
      rate: row.rate, layer: row.layer, pattern: row.pattern,
      ...(row.layer === 'catalogue' && row.provider !== undefined ? { provider: row.provider } : {}),
      ...(row.layer === 'catalogue' && this.#catalogue?.syncedAt ? { syncedAt: this.#catalogue.syncedAt } : {}),
    };
  }

  #build(): void {
    const merged = withConsolePrices(this.#file, this.#ownerRaw);
    const owner = new Set<string>();
    if (this.#ownerRaw) {
      for (const row of withConsolePrices({ rates: [], fallback: this.#file.fallback }, this.#ownerRaw).rates) owner.add(row.pattern);
    }
    const rows: Row[] = merged.rates.map((row) => ({
      pattern: row.pattern, rate: row.rate, layer: owner.has(row.pattern) ? 'console' : 'file',
    }));
    const catalogue = Object.entries(this.#catalogue?.models ?? {})
      .sort(([a], [b]) => b.length - a.length)
      .map(([model, entry]): Row => ({
        pattern: model,
        provider: entry.provider,
        layer: 'catalogue',
        rate: {
          inputCentsPerMTok: entry.input,
          outputCentsPerMTok: entry.output,
          ...(entry.cacheRead === undefined ? {} : { cacheReadCentsPerMTok: entry.cacheRead }),
          ...(entry.cacheWrite === undefined ? {} : { cacheWriteCentsPerMTok: entry.cacheWrite }),
        },
      }));
    this.#rows = [...rows, ...catalogue];
    this.#fallback = merged.fallback;
    this.#table = this.#rows.map((row) => ({ pattern: row.pattern, rate: row.rate }));
  }
}
