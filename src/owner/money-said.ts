/**
 * An amount as the owner reads it outside the console: in US dollars, the
 * way their language writes them, and first in the currency they read money
 * in when they chose one (0106) -- with the dollars after it, since the rate
 * is only theirs. The console's `money` does the same on the page.
 */
import type { MoneyDisplay } from '../domain/money-display.ts';

export function moneySaid(language: string | null | undefined, cents: number, display: MoneyDisplay | null): string {
  const dollars = (cents / 100).toLocaleString(language ?? 'en', { style: 'currency', currency: 'USD' });
  if (!display) return dollars;
  const value = (cents / 100) * display.rate;
  const converted = value.toLocaleString(language ?? 'en', {
    style: 'currency', currency: display.currency, minimumFractionDigits: 0, maximumFractionDigits: value >= 100 ? 0 : 2,
  });
  return `${converted} (${dollars})`;
}
