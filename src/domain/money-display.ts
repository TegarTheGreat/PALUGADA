/**
 * The currency the owner reads money in, and the rate they read it at (0106;
 * the analysis of 3 October, §2.3 item 3 and §9 P1 item 13).
 *
 * PALUGADA counts in US dollars: providers price their models in them, and
 * every amount the platform keeps is in US cents. This is only how the owner
 * reads those amounts -- in the console and in the chats -- and what they type
 * is turned back into cents at the same rate. The rate is the owner's: the
 * platform fetches none, so nothing about money depends on a service it does
 * not run.
 */
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

export interface MoneyDisplay {
  /** An ISO 4217 code, never USD. */
  currency: string;
  /** How many of it one US dollar buys. */
  rate: number;
}

/** The most a rate may be: a currency worth a billionth of a dollar is not one anybody prices in. */
const MOST_RATE = 1_000_000_000;

export async function moneyDisplay(): Promise<MoneyDisplay | null> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ display_currency: string | null; display_rate: string | null }>(
      'SELECT display_currency, display_rate FROM platform_control');
    const row = rows[0];
    return row?.display_currency && row.display_rate !== null
      ? { currency: row.display_currency, rate: Number(row.display_rate) }
      : null;
  });
}

/** Null goes back to US dollars. */
export async function setMoneyDisplay(choice: { currency: unknown; rate?: unknown } | null): Promise<MoneyDisplay | null> {
  const display = choice === null || choice.currency === null ? null : checked(choice.currency, choice.rate);
  await withControlPlane((tx) => tx.query(
    'UPDATE platform_control SET display_currency = $1, display_rate = $2, updated_at = now()',
    [display?.currency ?? null, display?.rate ?? null]));
  return moneyDisplay();
}

function checked(currency: unknown, rate: unknown): MoneyDisplay {
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (code === 'USD') {
    throw new PalugadaError('contract.violation',
      'PALUGADA already counts in US dollars; to read amounts in them, choose no other currency', { field: 'currency' });
  }
  if (!/^[A-Z]{3}$/.test(code) || !Intl.supportedValuesOf('currency').includes(code)) {
    throw new PalugadaError('contract.violation',
      `${typeof currency === 'string' && currency.trim() ? currency.trim() : 'that'} is not a currency; give its three-letter code, such as IDR or MYR`,
      { field: 'currency' });
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > MOST_RATE) {
    throw new PalugadaError('contract.violation',
      `the rate is how many ${code} one US dollar buys: a number above 0 and at most ${MOST_RATE}`, { field: 'rate' });
  }
  return { currency: code, rate };
}
