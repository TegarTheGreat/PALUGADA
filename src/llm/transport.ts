/**
 * One POST to a model API, with the retries every provider needs (F13.6).
 *
 * Shared by the clients so that "what counts as the provider being down" is
 * decided once: a connection refused or reset, a rate limit, the provider's
 * own overload and its 5xx are tried again and then handed to the engine as a
 * `ProviderFailure`, which is what a fallback model -- and then waiting -- is
 * for; a call that never answered in ten minutes is handed over at once; a
 * refused key is said plainly and not retried, because every task would fail
 * the same way until an operator changes it; anything else is the request's
 * own fault.
 */
import { PalugadaError } from '../errors.ts';
import { ProviderFailure } from '../runtime/wire.ts';
import { sleep } from '../timers.ts';

/** A single call that has not answered in ten minutes is not going to. */
const CALL_TIMEOUT_MS = 10 * 60_000;
/** Overloaded and rate-limited answers are retried this many times, then the engine falls back. */
const RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30_000;

export type RetryDelay = (attempt: number, retryAfterSeconds: number | null) => number;

export const defaultRetryDelay: RetryDelay = (attempt, retryAfter) =>
  Math.min(MAX_RETRY_WAIT_MS, retryAfter !== null ? retryAfter * 1_000 : 1_000 * 4 ** attempt);

export interface ModelPost {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** The model asked for, for the failure the engine falls back on. */
  model: string;
  /** Which setting holds the key, for the message when it is refused. */
  keySetting: string;
  signal?: AbortSignal | undefined;
  fetch: typeof fetch;
  retryDelayMs: RetryDelay;
}

export async function postModel(post: ModelPost): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await post.fetch(post.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...post.headers },
        body: post.body,
        signal: post.signal ? AbortSignal.any([post.signal, timeout]) : timeout,
      });
    } catch (failure) {
      if (post.signal?.aborted) throw failure;
      // A connection refused or reset is the provider's moment as much as a
      // 503 is: tried again the same way. A call that ran out its ten minutes
      // is not -- two more would hold the run for half an hour.
      const cause = (failure as { cause?: { code?: string } }).cause?.code;
      const why = cause ? `${(failure as Error).message} (${cause})` : (failure as Error).message;
      if (timeout.aborted) {
        throw new ProviderFailure(post.model, `the model API did not answer in ${CALL_TIMEOUT_MS / 60_000} minutes`);
      }
      if (attempt < RETRIES) {
        await sleep(post.retryDelayMs(attempt, null), post.signal);
        if (post.signal?.aborted) throw post.signal.reason;
        continue;
      }
      throw new ProviderFailure(post.model, `the model API could not be reached ${attempt + 1} times: ${why}`);
    }

    if (response.ok) return response.json();

    const detail = (await response.text().catch(() => '')).slice(0, 500);
    // 429 is the account's rate limit, 529 the provider's own load, 5xx its
    // failure: all of them pass, and a fallback model may not share them.
    const transient = response.status === 429 || response.status === 529 || response.status >= 500;
    if (transient && attempt < RETRIES) {
      const header = Number(response.headers.get('retry-after'));
      await sleep(post.retryDelayMs(attempt, Number.isFinite(header) && header > 0 ? header : null), post.signal);
      if (post.signal?.aborted) throw post.signal.reason;
      continue;
    }
    if (transient) {
      throw new ProviderFailure(post.model, `the model API answered ${response.status} ${attempt + 1} times: ${detail}`);
    }
    if (response.status === 401 || response.status === 403) {
      // Said as facts, not as a sentence about a variable: the key may have
      // been typed in the console, where no variable was ever set. What the
      // owner reads is composed from these (src/owner/platform-cards.ts);
      // the setting's name stays here for an operator reading the record.
      const host = new URL(post.url).host;
      const providerSaid = whatTheProviderSaid(detail);
      throw new PalugadaError('model.unavailable',
        `the model API at ${host} refused the key (${response.status})${providerSaid ? `: ${providerSaid}` : ''}`,
        { model: post.model, keyRefused: true, status: response.status, host, providerSaid, keySetting: post.keySetting });
    }
    // A conversation longer than the model reads. Every retry replays the same
    // journal and asks the same turn, so it fails the same way until the
    // attempts run out; said as what it is, it fails once with its reason.
    // Anthropic says "prompt is too long", OpenAI and DeepSeek "maximum context
    // length" and `context_length_exceeded`, a local server one of the rest.
    if ((response.status === 400 || response.status === 413) && TOO_LONG.test(detail)) {
      const providerSaid = whatTheProviderSaid(detail);
      throw new PalugadaError('model.context_too_long',
        `the conversation is longer than ${post.model} reads (${providerSaid}); a retry would send the same one`,
        { model: post.model, status: response.status, providerSaid });
    }
    throw new Error(`the model API refused the request (${response.status}): ${whatTheProviderSaid(detail)}`);
  }
}

/** What providers say of a request whose conversation is too long. Not "exceeds the limit": that is said of other things. */
const TOO_LONG = /prompt is too long|maximum context length|context[ _]length|context window|input is too long|too many tokens|reduce the length/i;

/**
 * The words of a provider's error, out of the JSON they usually come in:
 * `{"error":{"message":"User not found.","code":401}}` is OpenRouter's, and
 * OpenAI's and Anthropic's carry `error.message` too. A body that is not that
 * shape is kept short, as it came.
 */
function whatTheProviderSaid(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const said = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof said === 'string' && said.trim() !== '') return said.trim().slice(0, 300);
  } catch {
    // Not JSON: a proxy's page, or plain text.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}
