/**
 * What a model call cost, when the runtime did not say (PRD v2 F13.7, F1.7).
 *
 * F13.7 gives a runtime that cannot price a call an estimate, "marked as one".
 * The mark was there and the estimate was not: `usage.costCents ?? 0`. Every
 * agent CLI this platform employs -- `claude-code` and every `CliAdapter` --
 * reports tokens per message and no price, so in the one configuration that
 * matters in production a company's *money* ceiling never moved. F1.7's
 * warning at 80% and pause at 100% were enforced against a counter that stayed
 * at zero while the provider billed.
 *
 * The same defect is in both systems this platform was compared against:
 * Paperclip records a call with tokens and no price as `unpriced`, zero cents,
 * so an unpriced adapter never trips its hard stop; auto-company's usage
 * ledger names it outright -- unknown cost is "never counted as zero" -- and
 * pauses instead. This takes auto-company's side of that argument.
 *
 * **An unknown price is estimated high, not low.** A table the operator
 * maintains says what their models cost. A model the table does not know is
 * charged at `CONSERVATIVE_FALLBACK`, which is deliberately the top of the
 * market rather than an average: an estimate that is too high stops a company
 * a little early and says so, and an estimate that is too low lets it spend
 * money nobody agreed to. Only one of those is recoverable.
 *
 * **A call is priced to the fraction of a cent, and its cached tokens at
 * their own rates (the owner's report of 7 October: "the prices do not match
 * the official ones").** Every call used to be rounded up to a whole cent and
 * never below one, and every cached token priced as fresh input -- both
 * chosen to err towards the ceiling, and together they put a task on a cheap
 * model at several times what its provider billed. The price of a call is now
 * exact (`costOf`); what is owed below a cent is carried and charged when it
 * adds up to one (`CostCarry`), so a thousand small calls cost what they add
 * up to; a cached token is priced at the cache rate the list names, and at
 * the input rate -- the high side -- when it names none.
 *
 * **No built-in vendor price list.** Prices change several times a year and a
 * table compiled into a control plane is wrong by the next release, silently.
 * The operator's file, what setup wrote and what the owner saved in the
 * console are the sources, laid over each other in that order
 * (`withConsolePrices`); the console and setup offer models.dev's current
 * prices to save (`models-dev.ts`). The fallback is the floor under them.
 */
import { readFile } from 'node:fs/promises';
import { PalugadaError } from '../errors.ts';

/** Cents per million tokens, the unit every provider's price list uses. */
export interface ModelRate {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
  /**
   * What a prompt token read back from the provider's cache costs, where the
   * provider bills it below the input rate. Absent, it is priced as input:
   * a cache this list does not know is not assumed to be cheap.
   */
  cacheReadCentsPerMTok?: number;
  /** What a token written to the provider's cache costs; priced as input when absent. */
  cacheWriteCentsPerMTok?: number;
}

export interface PriceTable {
  /** Longest pattern first, so `claude-opus-4-5` beats `claude-opus-*`. */
  rates: ReadonlyArray<{ pattern: string; rate: ModelRate }>;
  fallback: ModelRate;
}

/**
 * $15 in and $75 out per million tokens: the most expensive frontier rate
 * published when this was written. Chosen as a ceiling, not a guess.
 */
export const CONSERVATIVE_FALLBACK: ModelRate = {
  inputCentsPerMTok: 1_500,
  outputCentsPerMTok: 7_500,
};

export const DEFAULT_PRICE_TABLE: PriceTable = { rates: [], fallback: CONSERVATIVE_FALLBACK };

/** What one call used, with the cached part of its prompt told apart. */
export interface Usage {
  /** Prompt tokens billed as fresh input: the prompt less what was cached. */
  input: number;
  output: number;
  /** Prompt tokens read back from the provider's cache. */
  cacheRead?: number;
  /** Prompt tokens written to the provider's cache. */
  cacheWrite?: number;
}

export interface Cost {
  /** Exact, a fraction of a cent: the charge for it goes through a `CostCarry`. */
  cents: number;
  /** Which row priced it: the pattern, or `fallback`. Recorded on the event. */
  basis: string;
}

/**
 * What one call cost, from the list.
 *
 * Exact: not rounded, and not raised to a cent. What is owed below a cent is
 * the carry's, so that the sum is right; a call that rounded itself up was
 * right to the cent and wrong in the total, which is what the owner pays.
 */
export function costOf(table: PriceTable, model: string, usage: Usage): Cost {
  const { rate, basis } = rateFor(table, model);
  const tokens = (count: number | undefined) => Math.max(0, count ?? 0);
  const exact = (
    tokens(usage.input) * rate.inputCentsPerMTok
    + tokens(usage.output) * rate.outputCentsPerMTok
    + tokens(usage.cacheRead) * (rate.cacheReadCentsPerMTok ?? rate.inputCentsPerMTok)
    + tokens(usage.cacheWrite) * (rate.cacheWriteCentsPerMTok ?? rate.inputCentsPerMTok)
  ) / 1_000_000;
  return { cents: exact, basis };
}

/**
 * What a company owes below a cent, carried from one call to the next.
 *
 * The ledger, the budget functions and the traces count in whole cents, and a
 * call on a cheap model costs a few hundredths of one. Rounding each up
 * charged forty cents for a task that cost two; rounding each down would
 * charge nothing for ever. This keeps what is owed, in millionths of a cent so
 * that no float drifts, and hands back whole cents as they fall due: a
 * thousand calls of 0.036 cents are 36 cents, the first of them charged on the
 * twenty-eighth call. Held in the process: what a crash loses is under a cent,
 * and the ceiling is reached under a cent late, never early.
 */
export class CostCarry {
  #owed = 0;

  /** Adds a call's exact cost and returns the whole cents now due. */
  charge(cents: number): number {
    this.#owed += Math.round(Math.max(0, Number.isFinite(cents) ? cents : 0) * 1e6);
    const due = Math.floor(this.#owed / 1e6);
    this.#owed -= due * 1e6;
    return due;
  }

  /**
   * Takes back what was owed on estimates a provider's own bill has replaced:
   * left, it would be charged again with the next call. Never below nothing.
   */
  forgive(cents: number): void {
    this.#owed = Math.max(0, this.#owed - Math.round(Math.max(0, Number.isFinite(cents) ? cents : 0) * 1e6));
  }

  /** What is owed and not yet charged, in cents: under one. */
  get pending(): number {
    return this.#owed / 1e6;
  }
}

const carries = new Map<string, CostCarry>();

/** A company's carry: one for the process, so every call it makes, wherever it is made, is counted into the same cent. */
export function carryFor(companyId: string): CostCarry {
  let carry = carries.get(companyId);
  if (!carry) {
    carry = new CostCarry();
    carries.set(companyId, carry);
  }
  return carry;
}

function matches(pattern: string, model: string): boolean {
  return pattern.endsWith('*') ? model.startsWith(pattern.slice(0, -1)) : model === pattern;
}

/**
 * Reads an operator's price file.
 *
 * ```json
 * {
 *   "$comment": "cents per million tokens; check your provider's current list",
 *   "fallback": { "input": 1500, "output": 7500 },
 *   "models": { "claude-sonnet-*": { "input": 300, "output": 1500 } }
 * }
 * ```
 *
 * Refused whole rather than read in part, like the vendor file: a price that
 * failed to parse and was skipped would put that model on the fallback, which
 * is safe, but a *fallback* that failed to parse and was skipped would put
 * every unknown model on nothing at all.
 */
export function parsePriceTable(raw: unknown, source = 'price file'): PriceTable {
  const refuse = (why: string): never => {
    throw new PalugadaError('config.invalid', `${source}: ${why}`, { source });
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('must be a JSON object');
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['$comment', 'fallback', 'models'].includes(key)) refuse(`unknown key "${key}"`);
  }

  const rateFrom = (value: unknown, where: string): ModelRate => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return refuse(`${where} must be { "input": number, "output": number }, with "cacheRead" and "cacheWrite" when the provider bills a cache`);
    }
    const { input, output, cacheRead, cacheWrite, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length > 0) refuse(`${where} has unknown keys: ${Object.keys(rest).join(', ')}`);
    for (const [name, number] of [['input', input], ['output', output]] as const) {
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
        refuse(`${where}.${name} must be a non-negative number of cents per million tokens`);
      }
    }
    for (const [name, number] of [['cacheRead', cacheRead], ['cacheWrite', cacheWrite]] as const) {
      if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < 0)) {
        refuse(`${where}.${name} must be a non-negative number of cents per million tokens, or left out`);
      }
    }
    return {
      inputCentsPerMTok: input as number,
      outputCentsPerMTok: output as number,
      ...(cacheRead === undefined ? {} : { cacheReadCentsPerMTok: cacheRead as number }),
      ...(cacheWrite === undefined ? {} : { cacheWriteCentsPerMTok: cacheWrite as number }),
    };
  };

  // A fallback of zero is refused: it is the one value that restores the
  // defect, and an operator who wants it has to say so model by model.
  const fallback = body.fallback === undefined
    ? CONSERVATIVE_FALLBACK
    : rateFrom(body.fallback, 'fallback');
  if (fallback.inputCentsPerMTok === 0 && fallback.outputCentsPerMTok === 0) {
    refuse('fallback may not be free; an unknown model is exactly the one to estimate high');
  }

  const models = body.models ?? {};
  if (typeof models !== 'object' || Array.isArray(models) || models === null) {
    refuse('models must be an object of pattern -> rate');
  }
  const rates = Object.entries(models as Record<string, unknown>).map(([pattern, value]) => {
    if (!pattern || (pattern.includes('*') && !/^[^*]+\*$/.test(pattern))) {
      refuse(`model pattern "${pattern}" may only end in a single *`);
    }
    return { pattern, rate: rateFrom(value, `models["${pattern}"]`) };
  });
  // Longest first: the most specific row is the one the operator meant.
  rates.sort((a, b) => b.pattern.length - a.pattern.length);
  return { rates, fallback };
}

/**
 * The price list with what the owner said in the console laid over it (L12).
 *
 * The console's entries are the owner's word on what they pay, so a model
 * named in both is priced by the console. The fallback is the file's, or the
 * conservative one: the console names models, never what an unknown one
 * costs.
 */
export function withConsolePrices(table: PriceTable, raw: string | undefined): PriceTable {
  if (!raw) return table;
  const consoleTable = parsePriceTable(JSON.parse(raw) as unknown, 'the prices set in the console');
  const named = new Set(consoleTable.rates.map((row) => row.pattern));
  const rates = [...consoleTable.rates, ...table.rates.filter((row) => !named.has(row.pattern))];
  rates.sort((a, b) => b.pattern.length - a.pattern.length);
  return { rates, fallback: table.fallback };
}

/** Which row prices a model, and at what rate: its pattern, or `fallback`. */
export function rateFor(table: PriceTable, model: string): { rate: ModelRate; basis: string } {
  const row = table.rates.find((candidate) => matches(candidate.pattern, model));
  return row ? { rate: row.rate, basis: row.pattern } : { rate: table.fallback, basis: 'fallback' };
}

export async function loadPriceTable(path: string): Promise<PriceTable> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new PalugadaError('config.invalid', `price file ${path} could not be read: ${(error as Error).message}`, {
      source: path,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PalugadaError('config.invalid', `price file ${path} is not JSON: ${(error as Error).message}`, {
      source: path,
    });
  }
  return parsePriceTable(parsed, path);
}

/**
 * Cents, rounded up to a whole one. Runtimes report dollars, and dollars
 * times a hundred are not exact in floating point: $0.07 is
 * 7.000000000000001 cents, which rounded straight up was charged as eight
 * (the review of 9d4e2d8 found 573 of 10,000 whole-cent amounts overcharged
 * so). What lies below a millionth of a cent is that error, not a charge.
 * What a provider reports for a whole run, and what is stored on a trace,
 * rounds through here; what a call costs is `costOf`, and its fractions are
 * the carry's.
 */
export function wholeCents(cents: number): number {
  return Math.ceil(Math.round(cents * 1e6) / 1e6);
}
