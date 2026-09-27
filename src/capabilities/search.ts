/**
 * `web.search` and `web.extract`: finding pages and reading them, through a
 * provider the owner chooses in the console.
 *
 * `web.fetch` reads a page this process fetches itself. It cannot find one:
 * a role that had to research something had no way to learn which pages
 * exist, and every agent the owner compared PALUGADA with -- Hermes offers
 * fifteen search providers -- could. Searching needs somebody's index, so it
 * is a provider, like the model; which one is the owner's choice, and nothing
 * is sent to any of them until the owner makes it.
 *
 * Each entry below is the provider's documented HTTP API, checked against
 * its documentation in September 2026 and, where it answers without a key,
 * called to see the shape of the answer. A few answer without a key at a
 * rate-limited free tier; those say so, and the owner still chooses them.
 * DuckDuckGo is not here: it has no web-results API, and the package other
 * agents use scrapes it and others, "for educational purposes only".
 *
 * What comes back is written outside the company, so the catalogue marks
 * both capabilities `readsOutside` (F8.9): a page can say anything, and the
 * broker treats the work that read it accordingly.
 */
import { PalugadaError } from '../errors.ts';
import type { Capability } from '../broker/registry.ts';

export type ToolKeyUse = 'required' | 'optional' | 'none';

interface ProviderBase {
  id: string;
  name: string;
  /** A few words beside the name: what is special about it. */
  about?: string;
  key: ToolKeyUse;
  keyUrl?: string;
  /** The owner's own server: the address is theirs to type. */
  urlExample?: string;
  /** What one call is reserved at before it runs, from the provider's price list. */
  reserveCents: number;
  /** `unverified` when the request shape was not found in the provider's own reference. */
  checked?: 'unverified';
}

interface Call {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider extends ProviderBase {
  request(query: string, count: number, key: string | null, base: string | null): Call;
  results(answer: unknown): SearchResult[];
}

export interface ExtractedPage {
  url: string;
  title: string | null;
  text: string;
}

export interface ExtractProvider extends ProviderBase {
  request(url: string, key: string | null, base: string | null): Call;
  page(answer: unknown, url: string): ExtractedPage;
}

const json = { 'content-type': 'application/json', accept: 'application/json' };
const bearer = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});
/** Keenable's free tier asks which application is calling. */
const APP_NAME = 'PALUGADA';

/** A path such as `data.web` into an answer, as an array of records. */
function rows(answer: unknown, path: string): Array<Record<string, unknown>> {
  let value: unknown = answer;
  for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) ? value.filter((one) => typeof one === 'string').join(' … ') : '');

function mapped(answer: unknown, path: string, title: string, url: string, snippet: string): SearchResult[] {
  return rows(answer, path)
    .map((row) => ({ title: text(row[title]), url: text(row[url]), snippet: text(row[snippet]) }))
    .filter((row) => row.url !== '');
}

function base(url: string | null, id: string): string {
  if (!url) throw new PalugadaError('config.invalid', `${id} is your own server: give its address`, { provider: id });
  return url.replace(/\/+$/, '');
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  {
    id: 'brave', name: 'Brave Search', about: 'An independent index', key: 'required',
    keyUrl: 'https://brave.com/search/api/', reserveCents: 1,
    request: (query, count, key) => ({
      method: 'GET',
      url: `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`,
      headers: { accept: 'application/json', 'x-subscription-token': key ?? '' },
    }),
    results: (answer) => mapped(answer, 'web.results', 'title', 'url', 'description'),
  },
  {
    id: 'tavily', name: 'Tavily', about: 'Built for agents; a free tier without a key', key: 'optional',
    keyUrl: 'https://app.tavily.com/home', reserveCents: 1,
    request: (query, count, key) => ({
      method: 'POST', url: 'https://api.tavily.com/search',
      headers: { ...json, ...(key ? bearer(key) : { 'x-tavily-access-mode': 'keyless' }) },
      body: { query, max_results: count, search_depth: 'basic', include_raw_content: false, include_images: false },
    }),
    results: (answer) => mapped(answer, 'results', 'title', 'url', 'content'),
  },
  {
    id: 'exa', name: 'Exa', about: 'Semantic search, with highlights from each page', key: 'required',
    keyUrl: 'https://dashboard.exa.ai/api-keys', reserveCents: 2,
    request: (query, count, key) => ({
      method: 'POST', url: 'https://api.exa.ai/search',
      headers: { ...json, 'x-api-key': key ?? '' },
      body: { query, numResults: count, type: 'auto', contents: { highlights: true } },
    }),
    results: (answer) => mapped(answer, 'results', 'title', 'url', 'highlights'),
  },
  {
    id: 'firecrawl', name: 'Firecrawl', about: 'A free tier without a key', key: 'optional',
    keyUrl: 'https://www.firecrawl.dev/app/api-keys', reserveCents: 1,
    request: (query, count, key) => ({
      method: 'POST', url: 'https://api.firecrawl.dev/v2/search', headers: { ...json, ...bearer(key) }, body: { query, limit: count },
    }),
    results: (answer) => mapped(answer, 'data.web', 'title', 'url', 'description'),
  },
  {
    id: 'perplexity', name: 'Perplexity Search', about: 'Ranked results with dated snippets', key: 'required',
    keyUrl: 'https://www.perplexity.ai/account/api', reserveCents: 1,
    request: (query, count, key) => ({
      method: 'POST', url: 'https://api.perplexity.ai/search', headers: { ...json, ...bearer(key) },
      body: { query, max_results: count, search_context_size: 'low' },
    }),
    results: (answer) => mapped(answer, 'results', 'title', 'url', 'snippet'),
  },
  {
    id: 'parallel', name: 'Parallel', about: 'Search with excerpts chosen for the question', key: 'required',
    keyUrl: 'https://platform.parallel.ai', reserveCents: 1,
    request: (query, count, key) => ({
      method: 'POST', url: 'https://api.parallel.ai/v1/search', headers: { ...json, 'x-api-key': key ?? '' },
      body: { objective: query, search_queries: [query], mode: 'fast', advanced_settings: { max_results: count } },
    }),
    results: (answer) => mapped(answer, 'results', 'title', 'url', 'excerpts'),
  },
  {
    id: 'keenable', name: 'Keenable', about: 'An independent index; a free tier without a key, shared by IP', key: 'optional',
    keyUrl: 'https://app.keenable.ai/console', reserveCents: 1,
    request: (query, count, key) => ({
      method: 'POST',
      url: key ? 'https://api.keenable.ai/v1/search' : 'https://api.keenable.ai/v1/search/public',
      headers: { ...json, ...(key ? { 'x-api-key': key } : { 'x-keenable-title': APP_NAME }) },
      body: { query, max_results: count, mode: 'realtime' },
    }),
    results: (answer) => mapped(answer, 'results', 'title', 'url', 'snippet'),
  },
  {
    id: 'jina', name: 'Jina Search', key: 'required', keyUrl: 'https://jina.ai/reader/', reserveCents: 1,
    request: (query, _count, key) => ({
      method: 'GET', url: `https://s.jina.ai/?${new URLSearchParams({ q: query })}`,
      headers: { accept: 'application/json', 'x-respond-with': 'no-content', ...bearer(key) },
    }),
    results: (answer) => mapped(answer, 'data', 'title', 'url', 'description'),
  },
  {
    id: 'serpapi', name: 'SerpApi', about: 'Google\'s results', key: 'required', keyUrl: 'https://serpapi.com/manage-api-key', reserveCents: 3,
    request: (query, count, key) => ({
      method: 'GET',
      // SerpApi takes its key in the address; `redactor` keeps it out of logs.
      url: `https://serpapi.com/search?${new URLSearchParams({ engine: 'google', q: query, num: String(count), api_key: key ?? '' })}`,
      headers: { accept: 'application/json' },
    }),
    results: (answer) => mapped(answer, 'organic_results', 'title', 'link', 'snippet'),
  },
  {
    id: 'serper', name: 'Serper', about: 'Google\'s results, cheaply', key: 'required', keyUrl: 'https://serper.dev/api-key',
    reserveCents: 1, checked: 'unverified',
    request: (query, count, key) => ({
      method: 'POST', url: 'https://google.serper.dev/search', headers: { ...json, 'x-api-key': key ?? '' }, body: { q: query, num: count },
    }),
    results: (answer) => mapped(answer, 'organic', 'title', 'link', 'snippet'),
  },
  {
    id: 'searxng', name: 'SearXNG', about: 'Your own metasearch server', key: 'none', urlExample: 'http://localhost:8888', reserveCents: 0,
    request: (query, _count, _key, url) => ({
      method: 'GET', url: `${base(url, 'searxng')}/search?${new URLSearchParams({ q: query, format: 'json' })}`,
      headers: { accept: 'application/json' },
    }),
    results: (answer) => mapped(answer, 'results', 'title', 'url', 'content'),
  },
  {
    id: 'firecrawl-self-hosted', name: 'Firecrawl, your own', about: 'A Firecrawl you run', key: 'optional',
    urlExample: 'http://localhost:3002', reserveCents: 0,
    request: (query, count, key, url) => ({
      method: 'POST', url: `${base(url, 'firecrawl-self-hosted')}/v2/search`, headers: { ...json, ...bearer(key) }, body: { query, limit: count },
    }),
    results: (answer) => mapped(answer, 'data.web', 'title', 'url', 'description'),
  },
];

export const EXTRACT_PROVIDERS: readonly ExtractProvider[] = [
  {
    id: 'jina', name: 'Jina Reader', about: 'Any page as clean text; 20 a minute without a key', key: 'optional',
    keyUrl: 'https://jina.ai/reader/', reserveCents: 1,
    request: (url, key) => ({ method: 'GET', url: `https://r.jina.ai/${url}`, headers: { accept: 'application/json', ...bearer(key) } }),
    page: (answer, url) => {
      const data = (answer as { data?: Record<string, unknown> }).data ?? {};
      return { url: text(data.url) || url, title: text(data.title) || null, text: text(data.content) };
    },
  },
  {
    id: 'firecrawl', name: 'Firecrawl', about: 'A free tier without a key', key: 'optional',
    keyUrl: 'https://www.firecrawl.dev/app/api-keys', reserveCents: 1,
    request: (url, key) => ({
      method: 'POST', url: 'https://api.firecrawl.dev/v2/scrape', headers: { ...json, ...bearer(key) },
      body: { url, formats: ['markdown'], onlyMainContent: true },
    }),
    page: (answer, url) => {
      const data = (answer as { data?: { markdown?: unknown; metadata?: Record<string, unknown> } }).data ?? {};
      return { url: text(data.metadata?.sourceURL) || url, title: text(data.metadata?.title) || null, text: text(data.markdown) };
    },
  },
  {
    id: 'tavily', name: 'Tavily Extract', about: 'A free tier without a key', key: 'optional',
    keyUrl: 'https://app.tavily.com/home', reserveCents: 1,
    request: (url, key) => ({
      method: 'POST', url: 'https://api.tavily.com/extract',
      headers: { ...json, ...(key ? bearer(key) : { 'x-tavily-access-mode': 'keyless' }) },
      body: { urls: [url], extract_depth: 'basic', format: 'markdown', include_images: false },
    }),
    page: (answer, url) => {
      const first = rows(answer, 'results')[0] ?? {};
      return { url: text(first.url) || url, title: null, text: text(first.raw_content) };
    },
  },
  {
    id: 'exa', name: 'Exa Contents', key: 'required', keyUrl: 'https://dashboard.exa.ai/api-keys', reserveCents: 1,
    request: (url, key) => ({
      method: 'POST', url: 'https://api.exa.ai/contents', headers: { ...json, 'x-api-key': key ?? '' }, body: { urls: [url], text: true },
    }),
    page: (answer, url) => {
      const first = rows(answer, 'results')[0] ?? {};
      return { url: text(first.url) || url, title: text(first.title) || null, text: text(first.text) };
    },
  },
  {
    id: 'parallel', name: 'Parallel Extract', key: 'required', keyUrl: 'https://platform.parallel.ai', reserveCents: 1,
    request: (url, key) => ({
      method: 'POST', url: 'https://api.parallel.ai/v1/extract', headers: { ...json, 'x-api-key': key ?? '' },
      body: { urls: [url], objective: 'Full page content', advanced_settings: { full_content: true } },
    }),
    page: (answer, url) => {
      const first = rows(answer, 'results')[0] ?? {};
      return { url: text(first.url) || url, title: text(first.title) || null, text: text(first.full_content) || text(first.excerpts) };
    },
  },
  {
    id: 'keenable', name: 'Keenable Fetch', about: 'A free tier without a key, shared by IP', key: 'optional',
    keyUrl: 'https://app.keenable.ai/console', reserveCents: 1,
    request: (url, key) => ({
      method: 'GET',
      url: `https://api.keenable.ai/v1/${key ? 'fetch' : 'fetch/public'}?${new URLSearchParams({ url, max_chars: '50000' })}`,
      headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : { 'x-keenable-title': APP_NAME }) },
    }),
    page: (answer, url) => {
      const data = answer as Record<string, unknown>;
      return { url: text(data.url) || url, title: text(data.title) || null, text: text(data.content) };
    },
  },
];

export function searchProvider(id: string): SearchProvider | undefined {
  return SEARCH_PROVIDERS.find((one) => one.id === id);
}

export function extractProvider(id: string): ExtractProvider | undefined {
  return EXTRACT_PROVIDERS.find((one) => one.id === id);
}

/** A provider bound for this deployment: the key is looked up per call, so a rotated one counts at once. */
export interface ToolBinding<P> {
  provider: P;
  url: string | null;
  key: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const MAX_RESULTS = 10;
/** A page is for reading, not for filling a context window. */
const MAX_PAGE_CHARS = 60_000;

async function send(call: Call, binding: ToolBinding<ProviderBase>, signal: AbortSignal | undefined): Promise<unknown> {
  const timeout = AbortSignal.timeout(binding.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await (binding.fetch ?? fetch)(call.url, {
      method: call.method,
      headers: { 'user-agent': 'PALUGADA/1.0 (+orchestrator)', ...call.headers },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (failure) {
    throw new PalugadaError('capability.unreachable',
      `${binding.provider.name} could not be reached: ${(failure as Error).message}`, { provider: binding.provider.id });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    const refused = response.status === 401 || response.status === 403;
    throw new PalugadaError(refused ? 'credential.unavailable' : 'capability.unreachable',
      refused
        ? `${binding.provider.name} refused the key (${response.status}): set it again in the console, under This deployment, Tools`
        : `${binding.provider.name} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      { provider: binding.provider.id, status: response.status });
  }
  return response.json();
}

export interface SearchInput {
  query: string;
  count?: number;
}

export interface SearchOutput {
  provider: string;
  results: SearchResult[];
}

/** `web.search` -- the pages a provider's index has for a query: titles, addresses and a snippet of each. */
export function webSearch(binding: ToolBinding<SearchProvider>): Capability<SearchInput, SearchOutput> {
  return {
    name: 'web.search',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 400, description: 'What to search the web for.' },
        count: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'How many results, at most 10. Default 5.' },
      },
    },
    adapter: `search:${binding.provider.id}`,
    defaultTier: 0,
    estimatedCostCents: binding.provider.reserveCents,
    async execute(input, ctx) {
      const query = String(input.query ?? '').trim();
      if (query === '') throw new PalugadaError('contract.violation', 'web.search needs a query', { field: 'query' });
      const count = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number(input.count ?? 5)) || 5));
      const key = await binding.key();
      const answer = await send(binding.provider.request(query, count, key, binding.url), binding, ctx.signal);
      return {
        provider: binding.provider.name,
        results: binding.provider.results(answer).slice(0, count).map((row) => ({ ...row, snippet: row.snippet.slice(0, 600) })),
      };
    },
  };
}

export interface ExtractInput {
  url: string;
}

export interface ExtractOutput {
  provider: string;
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

/**
 * `web.extract` -- one page as readable text, fetched by the provider. Unlike
 * `web.fetch`, the page is fetched from the provider's network, so it reaches
 * only what is public anyway, and comes back without markup.
 */
export function webExtract(binding: ToolBinding<ExtractProvider>): Capability<ExtractInput, ExtractOutput> {
  return {
    name: 'web.extract',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', pattern: '^https?://', description: 'The page to read, http or https.' } },
    },
    adapter: `extract:${binding.provider.id}`,
    defaultTier: 0,
    estimatedCostCents: binding.provider.reserveCents,
    async execute(input, ctx) {
      const url = String(input.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new PalugadaError('contract.violation', 'web.extract reads an http or https page', { field: 'url' });
      const key = await binding.key();
      const page = binding.provider.page(await send(binding.provider.request(url, key, binding.url), binding, ctx.signal), url);
      if (page.text === '') {
        throw new PalugadaError('capability.unreachable', `${binding.provider.name} returned nothing readable for ${url}`, { provider: binding.provider.id });
      }
      return {
        provider: binding.provider.name,
        url: page.url,
        title: page.title,
        text: page.text.slice(0, MAX_PAGE_CHARS),
        truncated: page.text.length > MAX_PAGE_CHARS,
      };
    },
    describe(input) {
      try {
        return { urlHost: new URL(String(input.url ?? '')).hostname };
      } catch {
        return { urlHost: null };
      }
    },
  };
}

/** The two kinds of tool the console chooses a provider for, and the variables each is configured by. */
export const TOOL_KINDS = {
  search: { capability: 'web.search', provider: 'PALUGADA_SEARCH_PROVIDER', url: 'PALUGADA_SEARCH_URL', key: 'PALUGADA_SEARCH_KEY_REF' },
  extract: { capability: 'web.extract', provider: 'PALUGADA_EXTRACT_PROVIDER', url: 'PALUGADA_EXTRACT_URL', key: 'PALUGADA_EXTRACT_KEY_REF' },
} as const;
export type ToolKind = keyof typeof TOOL_KINDS;

/**
 * The providers the environment names, bound; and a note for each kind that
 * is not, or cannot be. A setting that names no provider this platform knows
 * is a note rather than a refusal to start: the console is where it is fixed.
 */
export function toolBindingsFrom(
  env: NodeJS.ProcessEnv,
  resolve: (reference: string) => Promise<string>,
): { search?: ToolBinding<SearchProvider>; extract?: ToolBinding<ExtractProvider>; notes: string[] } {
  const notes: string[] = [];
  const bind = <P extends ProviderBase>(kind: ToolKind, find: (id: string) => P | undefined): ToolBinding<P> | undefined => {
    const names = TOOL_KINDS[kind];
    const id = env[names.provider]?.trim();
    if (!id) {
      notes.push(`${names.capability} is unbound: choose a provider in the console, under This deployment, Tools`);
      return undefined;
    }
    const provider = find(id);
    if (!provider) {
      notes.push(`${names.capability} is unbound: ${names.provider} names ${id}, which is not a provider known here`);
      return undefined;
    }
    const url = env[names.url]?.trim() || null;
    if (provider.urlExample && !url) {
      notes.push(`${names.capability} is unbound: ${provider.name} is your own server, and ${names.url} gives no address`);
      return undefined;
    }
    const reference = env[names.key]?.trim() || null;
    if (provider.key === 'required' && !reference) {
      notes.push(`${names.capability} is unbound: ${provider.name} needs a key, and ${names.key} names none`);
      return undefined;
    }
    return { provider, url, key: async () => (reference ? resolve(reference) : null) };
  };
  const search = bind('search', searchProvider);
  const extract = bind('extract', extractProvider);
  return { ...(search ? { search } : {}), ...(extract ? { extract } : {}), notes };
}
