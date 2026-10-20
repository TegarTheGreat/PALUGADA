/**
 * What a model costs, as models.dev says (L12).
 *
 * `pricing.ts` keeps no price list of its own, because prices change several
 * times a year and a list compiled into a release is wrong by the next one,
 * silently. The owner was therefore left to type prices from a provider's
 * page, and in practice typed none: every call was charged at the high
 * fallback, and a company on DeepSeek paid for its ceiling in estimates about
 * 58 times what DeepSeek billed. models.dev is an open catalogue of models
 * and their prices, kept up by the people who use it, and read live here --
 * so the prices are current rather than compiled in.
 *
 * What it says is the layer under the owner's own prices (price-book.ts):
 * read by the platform itself, daily, for the models the deployment runs on
 * (price-sync.ts), and applied beneath what the owner typed and what the
 * operator's file says, which win. It was offered to the owner to look at and
 * save with their device, on the reasoning that a third party's number
 * lowering every company's money ceiling on its own is the kind of change
 * this platform asks the owner for -- and in practice nobody saved it, so
 * every call was charged at the high fallback and the ledger did not match
 * the bill (the owner's report of 7 October). The fallback is still high, and
 * a model the catalogue prices at nothing, or does not list, is still charged
 * as if unpriced.
 *
 * Two providers may list the same model at different prices -- the maker and
 * a reseller. The one this deployment reaches the model at is the one that
 * bills it, so it wins; then the provider the deployment names; then the one
 * whose name the model's begins with. A model still ambiguous after that is
 * left unpriced rather than guessed.
 */
import { PalugadaError } from '../errors.ts';
import { safeFetch } from '../capabilities/reachable.ts';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** How long one reading of the catalogue is used. It is five megabytes. */
const CACHE_MS = 60 * 60_000;

interface CatalogueModel {
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
}

interface CatalogueProvider {
  id?: string;
  name?: string;
  api?: string;
  models?: Record<string, CatalogueModel>;
}

type Catalogue = Record<string, CatalogueProvider>;

export interface FoundPrice {
  /** Cents per million tokens, as the price list and the console keep them. */
  input: number;
  output: number;
  /** What a cached prompt token costs to read and to write, where the catalogue says. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Whose price it is, as models.dev names the provider. */
  provider: string;
}

let cached: { source: string; at: number; catalogue: Catalogue } | null = null;

/** Forgets the reading in hand, so the next one is the catalogue as it is now: "refresh now", and a test of a catalogue that changes. */
export function clearCatalogueCache(): void {
  cached = null;
}

async function catalogue(source: string): Promise<Catalogue> {
  if (cached && cached.source === source && Date.now() - cached.at < CACHE_MS) return cached.catalogue;
  const host = new URL(source).hostname;
  const answer = await safeFetch(source, {
    maxRedirects: 2,
    maxBytes: 32 * 1024 * 1024,
    timeoutMs: 30_000,
    // A mirror on this machine, which is what an operator without the
    // internet -- or a test -- points PALUGADA_MODELS_DEV_URL at.
    ...(['127.0.0.1', 'localhost'].includes(host) ? { allowPrivateHosts: [host] } : {}),
  });
  if (answer.status !== 200) {
    throw new PalugadaError('capability.unreachable', `${source} answered ${answer.status}`, { source });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new PalugadaError('capability.unreachable', `${source} did not answer with JSON`, { source });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PalugadaError('capability.unreachable', `${source} is not a catalogue of providers`, { source });
  }
  cached = { source, at: Date.now(), catalogue: parsed as Catalogue };
  return cached.catalogue;
}

/** Dollars per million tokens, as models.dev gives them, in cents, to a thousandth of one. */
function cents(dollars: number): number {
  return Math.round(dollars * 100 * 1000) / 1000;
}

function priceIn(provider: CatalogueProvider, model: string): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  const cost = provider.models?.[model]?.cost;
  const input = cost?.input;
  const output = cost?.output;
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isFinite(input) || !Number.isFinite(output)
    || input < 0 || output < 0) {
    return null;
  }
  const rate = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? cents(value) : undefined;
  const cacheRead = rate(cost?.cache_read);
  const cacheWrite = rate(cost?.cache_write);
  return {
    input: cents(input), output: cents(output),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function hostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return new URL(address).hostname;
  } catch {
    return null;
  }
}

/**
 * The prices models.dev gives for these models, and the ones it could not
 * price with confidence. `where` is where this deployment reaches its model
 * (its address) and whose API it speaks (`anthropic`, `openai`).
 */
export async function lookupPrices(
  models: readonly string[],
  where: { url: string | null; provider: string | null },
  source = MODELS_DEV_URL,
): Promise<{ prices: Record<string, FoundPrice>; missing: string[] }> {
  const providers = Object.entries(await catalogue(source));
  const reached = hostOf(where.url);
  const prices: Record<string, FoundPrice> = {};
  const missing: string[] = [];
  for (const model of models) {
    const offers = providers.flatMap(([key, provider]) => {
      const price = priceIn(provider, model);
      return price ? [{ key, provider, price }] : [];
    });
    const pick =
      offers.find((offer) => reached !== null && hostOf(offer.provider.api) === reached)
      ?? offers.find((offer) => where.provider !== null && offer.key === where.provider)
      ?? offers.find((offer) => model.toLowerCase().startsWith(offer.key.toLowerCase()))
      ?? (offers.length > 0 && offers.every((offer) =>
        offer.price.input === offers[0]!.price.input && offer.price.output === offers[0]!.price.output
        && offer.price.cacheRead === offers[0]!.price.cacheRead && offer.price.cacheWrite === offers[0]!.price.cacheWrite)
        ? offers[0] : undefined);
    if (!pick) {
      missing.push(model);
      continue;
    }
    prices[model] = { ...pick.price, provider: pick.provider.name ?? pick.key };
  }
  return { prices, missing };
}
